import { describe, it, expect, vi } from 'vitest';
import { Orchestrator, withReviewPacket, type ControlPort } from '../../src/orchestrator/orchestrator.js';
import { ActionService } from '../../src/orchestrator/actions.js';
import { AgentRegistry } from '../../src/orchestrator/agentRegistry.js';
import { FakeAdapter } from '../../src/orchestrator/fakeAdapter.js';
import { makeConfig } from '../../src/config.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import type { Task, TaskState } from '../../src/domain/task.js';
import type { ReposConfig, RepoConfig } from '../../src/domain/repos.js';
import type { RepoProbe } from '../../src/orchestrator/repoProbe.js';
import {
  NoopWorkspaces,
  type CreateOptions,
  type PreserveResult,
  type Workspaces,
  type WorkspaceImpact,
  type DefaultBranchAncestryProof,
} from '../../src/isolation/worktree.js';
import type { Workspace } from '../../src/domain/allocation.js';
import { TaskPathLeaseStore } from '../../src/isolation/taskPathLeaseStore.js';
// Workspaces used by TempDirWorkspaces / SpyWorkspaces below.

function reposWithCaps(caps: Record<string, number>): ReposConfig {
  const entries = Object.entries(caps).map(([key, maxConcurrent]) => [
    key,
    { key, url: 'x', defaultBranch: 'main', workflow: 'WORKFLOW.md', maxConcurrent, adapter: null },
  ]);
  return { repos: Object.fromEntries(entries) };
}

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    repo: 'app',
    state: 'todo' as TaskState,
    priority: 100,
    blockedBy: [],
    labels: [],
    adapter: null,
    agentSession: null,
    pendingSteer: null,
    attempts: 0,
    lastEventAt: null, createdAt: null, startedAt: null, endedAt: null,
    prUrl: null,
    prStatus: null,
    planPending: false,
    body: 'body',
    ...over,
  };
}

/** New packet fields required by ReviewPacket (evidence UX + rework path). */
const PACKET_EXTRA = {
  runKind: 'implementer' as const,
  reviewerSkipReason: null,
  diffUrl: null,
  evidenceMatrix: [] as const,
  verifiedSha: 'cafe1234cafe1234cafe1234cafe1234cafe1234',
  reworkPath: null as 'steer' | 'full' | null,
  reworkPathReason: null as string | null,
};

class FakePort implements ControlPort {
  readonly commits: string[] = [];
  commitFault: ((message: string) => Error | null) | null = null;
  syncs = 0;
  reads = 0;
  /** Snapshots returned by each control.read() call (identity-preserving). */
  readonly readResults: ControlSnapshot[] = [];
  constructor(
    readonly tasks: Map<string, Task>,
    private repos: ReposConfig,
  ) {}
  async sync(): Promise<void> {
    this.syncs += 1;
  }
  async read(): Promise<ControlSnapshot> {
    this.reads += 1;
    const snap: ControlSnapshot = {
      repos: this.repos,
      tasks: [...this.tasks.values()],
      problems: [],
    };
    this.readResults.push(snap);
    return snap;
  }
  async writeTask(t: Task): Promise<void> {
    this.tasks.set(t.id, t);
  }
  async compareAndSetTaskCommitted(
    id: string,
    expected: {
      readonly state: Task['state'];
      readonly expectedBaseRevision: Task['expectedBaseRevision'] | undefined;
      readonly expectedRemoteTip: Task['expectedRemoteTip'] | undefined;
    },
    to: Task['state'],
    fields: Partial<Task>,
    message: string,
  ): Promise<{ matched: boolean; committed: boolean }> {
    const current = this.tasks.get(id);
    if (
      !current ||
      current.state !== expected.state ||
      current.expectedBaseRevision !== expected.expectedBaseRevision ||
      current.expectedRemoteTip !== expected.expectedRemoteTip
    ) {
      return { matched: false, committed: false };
    }
    this.tasks.set(id, { ...current, ...fields, state: to });
    this.commits.push(message);
    return { matched: true, committed: true };
  }
  async deleteTask(id: string): Promise<void> {
    this.tasks.delete(id);
  }
  async commit(message: string): Promise<{ committed: boolean }> {
    const fault = this.commitFault?.(message) ?? null;
    if (fault) throw fault;
    this.commits.push(message);
    return { committed: true };
  }
  async writeRepos(config: ReposConfig): Promise<void> {
    this.repos = config;
  }
}

function setup(
  tasks: Task[],
  opts: {
    caps?: Record<string, number>;
    repos?: ReposConfig;
    adapter?: FakeAdapter;
    agents?: AgentRegistry;
    config?: Parameters<typeof makeConfig>[1];
    memReader?: () => number | null | Promise<number | null>;
    onEffectiveCaps?: (caps: { globalCap: number; heavyValidationPermits: number }) => void;
    cargoTargetEnv?: string | null;
    cargoCacheRetainDays?: number;
    pruneCargoCaches?: (
      dirs: readonly string[],
      o: {
        readonly trigger: string;
        readonly retainDays: number;
        readonly pressureEscalation?: boolean;
        readonly force?: boolean;
      },
    ) => Promise<{
      readonly freedBytes: number;
      readonly results: readonly never[];
    }>;
    verifier?: {
      verify: (...args: unknown[]) => Promise<unknown>;
    };
    workspaces?: Workspaces;
    autoRebase?: boolean;
    pathLeaseStore?: TaskPathLeaseStore;
    guardianReadinessCheck?: import('../../src/orchestrator/orchestrator.js').OrchestratorDeps['guardianReadinessCheck'];
    reviewerHealthCheck?: import('../../src/orchestrator/orchestrator.js').OrchestratorDeps['reviewerHealthCheck'];
  } = {},
): { orch: Orchestrator; port: FakePort; adapter: FakeAdapter; clock: { now: number } } {
  const port = new FakePort(
    new Map(tasks.map((t) => [t.id, t])),
    opts.repos ?? reposWithCaps(opts.caps ?? { app: 1 }),
  );
  const adapter = opts.adapter ?? new FakeAdapter({ durationMs: 100 });
  const clock = { now: 0 };
  const orch = new Orchestrator({
    config: makeConfig('/ctrl', opts.config),
    control: port,
    agents: opts.agents ?? AgentRegistry.of(adapter),
    clock: () => clock.now,
    ...(opts.memReader ? { memReader: opts.memReader } : {}),
    ...(opts.onEffectiveCaps ? { onEffectiveCaps: opts.onEffectiveCaps } : {}),
    ...(opts.cargoTargetEnv !== undefined ? { cargoTargetEnv: opts.cargoTargetEnv } : {}),
    ...(opts.cargoCacheRetainDays !== undefined
      ? { cargoCacheRetainDays: opts.cargoCacheRetainDays }
      : {}),
    ...(opts.pruneCargoCaches ? { pruneCargoCaches: opts.pruneCargoCaches } : {}),
    ...(opts.verifier
      ? { verifier: opts.verifier as import('../../src/orchestrator/verifier.js').Verifier }
      : {}),
    ...(opts.workspaces ? { workspaces: opts.workspaces } : {}),
    ...(opts.autoRebase !== undefined ? { autoRebase: opts.autoRebase } : {}),
    ...(opts.pathLeaseStore ? { pathLeaseStore: opts.pathLeaseStore } : {}),
    ...(opts.guardianReadinessCheck
      ? { guardianReadinessCheck: opts.guardianReadinessCheck }
      : {}),
    ...(opts.reviewerHealthCheck ? { reviewerHealthCheck: opts.reviewerHealthCheck } : {}),
  });
  return { orch, port, adapter, clock };
}

describe('withReviewPacket (SPEC §9.6) — replace, never stack', () => {
  it('replaces a prior packet instead of appending a second one', () => {
    const once = withReviewPacket('the task body', '### packet ONE');
    const twice = withReviewPacket(once, '### packet TWO');
    expect(twice.match(/## Review packet/g)).toHaveLength(1);
    expect(twice).toContain('### packet TWO');
    expect(twice).not.toContain('### packet ONE');
    expect(twice).toContain('the task body'); // preamble preserved
  });

  it('replaces even when the packet sits at the very start of the body (no leading newline)', () => {
    // After a prior strip the body can begin with the marker; the old \n-anchored
    // split missed it and stacked packets.
    const body = '## Review packet\n\n### packet ONE';
    const out = withReviewPacket(body, '### packet TWO');
    expect(out.match(/## Review packet/g)).toHaveLength(1);
    expect(out).not.toContain('### packet ONE');
  });

  it("strips the old packet even when the agent's report embedded the marker text", () => {
    // A task that documents Hercules makes the agent write "## Review packet" in
    // its report; the wrapper is still the FIRST occurrence, so the strip is clean.
    const first = withReviewPacket('body', 'agent report mentions ## Review packet here\n### packet ONE');
    const second = withReviewPacket(first, '### packet TWO');
    expect(second).not.toContain('### packet ONE');
    expect(second).toContain('### packet TWO');
  });

  it('preserves Human steer trail after the packet across replaces', () => {
    // Comment-to-steer appends after the packet; the next complete() must not
    // wipe that audit history (regression from task-3 multi-steer reviews).
    const once = withReviewPacket('## Task\nSummarize state', '### packet ONE\nreport A');
    const withSteer =
      once.trimEnd() +
      '\n\n## Human steer (2026-07-12T07:10:50.034Z)\n\n第58次循环写了什么？\n';
    const twice = withReviewPacket(withSteer, '### packet TWO\nreport B');
    expect(twice.match(/## Review packet/g)).toHaveLength(1);
    expect(twice).toContain('### packet TWO');
    expect(twice).not.toContain('### packet ONE');
    expect(twice).toContain('## Task\nSummarize state');
    expect(twice).toContain('## Human steer (2026-07-12T07:10:50.034Z)');
    expect(twice).toContain('第58次循环写了什么？');
    // Order: preamble → packet → steers
    expect(twice.indexOf('## Review packet')).toBeLessThan(twice.indexOf('## Human steer'));
    expect(twice.indexOf('### packet TWO')).toBeLessThan(twice.indexOf('## Human steer'));
  });

  it('preserves multiple steers and a Teardown section', () => {
    const body = [
      'task body',
      '',
      '## Review packet',
      '',
      '### old',
      '',
      '## Human steer (t1)',
      '',
      'first question',
      '',
      '## Human steer (t2)',
      '',
      'second question',
      '',
      '## Teardown',
      '',
      '**Method:** graceful',
    ].join('\n');
    const out = withReviewPacket(body, '### new packet');
    expect(out).toContain('### new packet');
    expect(out).not.toContain('### old');
    expect(out).toContain('## Human steer (t1)');
    expect(out).toContain('first question');
    expect(out).toContain('## Human steer (t2)');
    expect(out).toContain('second question');
    expect(out).toContain('## Teardown');
    expect(out).toContain('**Method:** graceful');
  });
});

describe('Orchestrator.tick — dispatch', () => {
  it('restart fail-closes a persisted ready Guardian repo before scheduling', async () => {
    const repos: ReposConfig = {
      repos: {
        app: {
          key: 'app', url: 'x', defaultBranch: 'main', workflow: 'WORKFLOW.md',
          maxConcurrent: 1, adapter: 'grok', readiness: 'ready',
          executionPolicy: { profile: 'guardian' },
        },
      },
    };
    const { orch, port, adapter } = setup([task('A')], {
      repos,
      guardianReadinessCheck: async () => ({
        version: 1, applicable: true, ok: false, profile: 'guardian', controls: [],
        failedCodes: ['cli_evidence_stale'], summary: 'stale',
        grantsOnly: 'harness_readiness',
        provenance: { defaultRevision: null, workflowSha256: null, policySha256: 'x' },
      }),
    });

    const report = await orch.tick();

    expect(report.dispatched).toEqual([]);
    expect(adapter.started).toHaveLength(0);
    expect((await port.read()).repos.repos['app']!.readiness).toBe('incomplete');
    expect(port.commits).toContain('hercules: guardian readiness fail-closed app');
  });

  it('is read-only when dispatch is disabled for a staging observer', async () => {
    const { orch, port, adapter } = setup([task('A')], {
      config: { dispatchEnabled: false },
    });
    const report = await orch.tick();

    expect(report.dispatched).toEqual([]);
    expect(report.recovered).toEqual([]);
    expect(adapter.started).toHaveLength(0);
    expect(port.tasks.get('A')!.state).toBe('todo');
    expect(port.commits).toEqual([]);
    expect(orch.getState().dispatchHold).toEqual({
      reason: 'configured',
      detail: '此实例已禁用任务调度（HERCULES_DISPATCH_ENABLED=0）',
    });
  });

  it('fails closed before adapter.start when the repo policy cannot be enforced', async () => {
    const repos: ReposConfig = {
      repos: {
        app: {
          key: 'app',
          url: 'x',
          defaultBranch: 'main',
          workflow: 'WORKFLOW.md',
          maxConcurrent: 1,
          adapter: null,
          readiness: 'ready',
          // Programmatically relaxed guardian posture — resolve must block it
          // with a typed reason and never start an agent.
          executionPolicy: { profile: 'guardian', workspaceWrite: false },
        },
      },
    };
    const { orch, port, adapter } = setup([task('A')], {
      repos,
      guardianReadinessCheck: async () => ({
        version: 1, applicable: true, ok: true, profile: 'guardian', controls: [],
        failedCodes: [], summary: 'green', grantsOnly: 'harness_readiness',
        provenance: {
          defaultRevision: 'a'.repeat(40), workflowSha256: 'b'.repeat(64),
          policySha256: 'c'.repeat(64),
        },
      }),
    });
    const report = await orch.tick();

    expect(report.dispatched).toEqual([]);
    // Pre-dispatch park (same as protected-path fail-fast): human decides.
    expect(report.completed).toContain('A');
    // Spawn spy: no agent process was started for the blocked task.
    expect(adapter.started).toHaveLength(0);
    const t = port.tasks.get('A')!;
    expect(t.state).toBe('review');
    expect(t.body).toContain('## Execution policy blocked (pre-dispatch)');
    expect(t.body).toContain('guardian_relaxed');
    expect(t.body).toContain('No agent was started');
  });

  it('dispatches an eligible todo task and moves it to in_progress', async () => {
    const { orch, port, adapter } = setup([task('A')]);
    const report = await orch.tick();

    expect(report.dispatched).toEqual(['A']);
    expect(port.tasks.get('A')!.state).toBe('in_progress');
    expect(port.tasks.get('A')!.agentSession).toMatch(/^fake-A-/);
    expect(port.commits.some((m) => m.includes('A'))).toBe(true);
    expect(adapter.stopped).toEqual([]);
  });

  it('dispatches host_operation without a Grok adapter (deterministic executor)', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'hercules-host-ws-'));
    try {
      const ws = new TempDirWorkspaces(root);
      // Registry with only fake — proves host path does not need Grok.
      const adapter = new FakeAdapter({ durationMs: 10 });
      const { orch, port } = setup(
        [
          task('HOST', {
            executionClass: 'host_operation',
            adapter: 'grok',
            hostCommandScope: ['true'],
            hostApprovedAt: '2026-07-31T06:00:00.000Z',
          }),
        ],
        { adapter, agents: AgentRegistry.of(adapter), workspaces: ws },
      );
      const report = await orch.tick();
      expect(report.dispatched).toEqual(['HOST']);
      expect(adapter.started).toHaveLength(0);
      expect(port.tasks.get('HOST')!.state).toBe('in_progress');
      expect(port.tasks.get('HOST')!.body).toContain('Host execution started');
      expect(port.tasks.get('HOST')!.hostExecutionStartedAt).toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps a multi-command host lease unbound while the second marked command is live', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { hasManagedProcessForTask } = await import('../../src/adapters/processTree.js');
    const root = await mkdtemp(join(tmpdir(), 'hercules-host-lease-'));
    try {
      const ws = new TempDirWorkspaces(root);
      let markerGone = false;
      const store = new TaskPathLeaseStore(root, {
        unboundOwnerAlive: (repoKey, entry) =>
          markerGone
            ? false
            : hasManagedProcessForTask(
                join(root, repoKey, entry.taskId),
                entry.taskId,
              ),
      });
      const adapter = new FakeAdapter({ durationMs: 10 });
      const { orch, port, clock } = setup(
        [task('HOST', {
          executionClass: 'host_operation',
          hostCommandScope: ['true', 'sleep 60'],
          hostApprovedAt: '2026-07-31T06:00:00.000Z',
          plannedBaseRevision: '0'.repeat(40),
          affectedPaths: ['host-output/'],
          protectedPathsSnapshot: [],
          expectedBaseRevision: '0'.repeat(40),
          expectedRemoteTip: null,
        })],
        { adapter, agents: AgentRegistry.of(adapter), workspaces: ws, pathLeaseStore: store },
      );

      expect((await orch.tick()).dispatched).toEqual(['HOST']);
      for (let i = 0; i < 100; i += 1) {
        const live = orch.getState().liveRuns['HOST'];
        if (live?.hostCommandIndex === 2 && live.processAlive) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const live = orch.getState().liveRuns['HOST'];
      expect(live?.hostCommandIndex).toBe(2);
      expect(live?.processAlive).toBe(true);

      const [lease] = await store.list('app');
      expect(lease).toBeDefined();
      expect(lease).not.toHaveProperty('ownerProcess');
      await expect(
        store.releaseIfOwnerDead('app', 'HOST', lease!.runToken),
      ).resolves.toMatchObject({ ok: true, released: false, ownerState: 'alive' });
      expect((await store.reclaimStale('app', new Set())).reclaimed).toEqual([]);

      port.tasks.set('HOST', { ...port.tasks.get('HOST')!, state: 'cancelled' });
      orch.requestCancel('HOST');
      orch.forceAbort('HOST');
      for (let i = 0; i < 100 && orch.stopping.includes('HOST'); i += 1) {
        clock.now += 50;
        await orch.tick();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(orch.stopping).not.toContain('HOST');
      markerGone = true;
      await store.reclaimStale('app', new Set());
      expect(await store.list('app')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not begin a host command when the durable start marker loses the task race', async () => {
    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'hercules-host-gone-'));
    try {
      const ws = new TempDirWorkspaces(root);
      const store = new TaskPathLeaseStore(root, { unboundOwnerAlive: () => false });
      const adapter = new FakeAdapter({ durationMs: 10 });
      const { orch, port } = setup(
        [task('HOST-GONE', {
          executionClass: 'host_operation',
          hostCommandScope: ['touch host-ran'],
          hostApprovedAt: '2026-07-31T06:00:00.000Z',
          plannedBaseRevision: '0'.repeat(40),
          affectedPaths: ['host-ran'],
          protectedPathsSnapshot: [],
          expectedBaseRevision: '0'.repeat(40),
          expectedRemoteTip: null,
        })],
        { adapter, agents: AgentRegistry.of(adapter), workspaces: ws, pathLeaseStore: store },
      );
      const create = ws.create.bind(ws);
      ws.create = async (repoCfg, taskId) => {
        const workspace = await create(repoCfg, taskId);
        port.tasks.delete(taskId);
        return workspace;
      };

      const report = await orch.tick();
      expect(report.dispatched).toEqual([]);
      expect(orch.running).toEqual([]);
      await expect(readFile(join(root, 'app', 'HOST-GONE', 'host-ran'))).rejects.toThrow();
      expect(await store.list('app')).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not begin host execution when a real pre-commit hook rejects the marker CAS', async () => {
    const { chmod, mkdtemp, mkdir, readFile, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { simpleGit } = await import('simple-git');
    const { GitControlPort } = await import('../../src/orchestrator/gitControlPort.js');
    const { writeTaskFile } = await import('../../src/control/store.js');
    const root = await mkdtemp(join(tmpdir(), 'hercules-host-hook-'));
    const controlDir = join(root, 'control');
    const workDir = join(root, 'work');
    try {
      await mkdir(join(controlDir, 'tasks'), { recursive: true });
      await writeFile(join(controlDir, 'repos.yaml'), [
        'repos:',
        '  app:',
        '    url: x',
        '    default_branch: main',
        '',
      ].join('\n'));
      const hostTask = task('HOST-HOOK', {
        executionClass: 'host_operation',
        hostCommandScope: ['touch host-ran'],
        hostApprovedAt: '2026-08-03T00:00:00.000Z',
        plannedBaseRevision: '0'.repeat(40),
        affectedPaths: ['host-ran'],
        protectedPathsSnapshot: [],
        expectedBaseRevision: '0'.repeat(40),
        expectedRemoteTip: null,
      });
      await writeTaskFile(controlDir, hostTask);
      const git = simpleGit({
        baseDir: controlDir,
        unsafe: { allowUnsafeHooksPath: true },
      });
      await git.init(['-b', 'main']);
      await git.addConfig('core.hooksPath', join(controlDir, '.git', 'no-hooks'));
      await git.addConfig('user.email', 'host@hercules.local');
      await git.addConfig('user.name', 'Host Hook Test');
      await git.add('.');
      await git.commit('seed host task');
      const beforeHead = (await git.revparse(['HEAD'])).trim();
      const hookDir = join(controlDir, '.git', 'failing-hooks');
      await mkdir(hookDir, { recursive: true });
      const hook = join(hookDir, 'pre-commit');
      await writeFile(hook, '#!/bin/sh\nexit 1\n');
      await chmod(hook, 0o755);
      await git.addConfig('core.hooksPath', hookDir);

      const control = new GitControlPort(controlDir);
      const workspaces = new TempDirWorkspaces(workDir);
      const pathLeaseStore = new TaskPathLeaseStore(root, { unboundOwnerAlive: () => false });
      const orch = new Orchestrator({
        config: makeConfig(controlDir),
        control,
        adapter: new FakeAdapter({ durationMs: 10 }),
        workspaces,
        pathLeaseStore,
        clock: () => 0,
      });

      const report = await orch.tick();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(report.dispatched).toEqual([]);
      expect(orch.running).toEqual([]);
      await expect(readFile(join(workDir, 'app', 'HOST-HOOK', 'host-ran'))).rejects.toThrow();
      expect((await control.read()).tasks.find((candidate) => candidate.id === 'HOST-HOOK')).toMatchObject({
        state: 'todo',
        startedAt: null,
      });
      expect((await control.read()).tasks.find(
        (candidate) => candidate.id === 'HOST-HOOK',
      )!.hostExecutionStartedAt ?? null).toBeNull();
      expect((await git.revparse(['HEAD'])).trim()).toBe(beforeHead);
      expect((await git.status()).isClean()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resumes a prior session when pendingSteer is set (comment-to-steer)', async () => {
    const { orch, port, adapter } = setup([
      task('A', {
        state: 'todo',
        agentSession: 'sess-prior',
        agentSessionAdapter: 'fake',
        pendingSteer: 'What did loop 58 write?',
        body: 'long original task body that must not re-enter the prompt',
      }),
    ]);
    const report = await orch.tick();
    expect(report.dispatched).toEqual(['A']);
    expect(adapter.started).toHaveLength(1);
    expect(adapter.started[0]!.resumeSessionId).toBe('sess-prior');
    expect(adapter.started[0]!.prompt).toContain('What did loop 58 write?');
    expect(adapter.started[0]!.prompt).not.toContain('long original task body');
    // pendingSteer consumed; session id kept/reused by fake resume
    expect(port.tasks.get('A')!.pendingSteer).toBeNull();
    expect(port.tasks.get('A')!.agentSession).toBe('sess-prior');
  });

  it('fails closed instead of passing a legacy or foreign provider session id', async () => {
    const grok = new FakeAdapter({ durationMs: 100 });
    const codex = new FakeAdapter({ durationMs: 100 });
    const agents = new AgentRegistry(new Map([
      ['grok', grok],
      ['codex', codex],
    ]), 'grok');
    const { orch, port } = setup([task('A', {
      adapter: 'codex',
      pendingSteer: 'continue safely',
      agentSession: 'grok-owned-session',
      agentSessionAdapter: 'grok',
    })], { agents });

    await orch.tick();

    expect(codex.started).toHaveLength(1);
    expect(codex.started[0]!.resumeSessionId).toBeUndefined();
    expect(codex.started[0]!.prompt).toContain('continue safely');
    expect(port.tasks.get('A')!.agentSession).not.toBe('grok-owned-session');
    expect(port.tasks.get('A')!.agentSessionAdapter).toBe('codex');
  });

  it.each([
    ['codex', 'grok'],
    ['grok', 'claude'],
  ] as const)('never passes a %s session to the %s compatibility adapter', async (owner, selected) => {
    const grok = new FakeAdapter({ durationMs: 100 });
    const codex = new FakeAdapter({ durationMs: 100 });
    const claude = new FakeAdapter({ durationMs: 100 });
    const byKind = { grok, codex, claude };
    const agents = new AgentRegistry(new Map([
      ['grok', grok], ['codex', codex], ['claude', claude],
    ]), 'grok');
    const { orch } = setup([task('A', {
      adapter: selected,
      pendingSteer: 'foreign owner check',
      agentSession: `${owner}-session`,
      agentSessionAdapter: owner,
    })], { agents });

    await orch.tick();
    expect(byKind[selected].started[0]!.resumeSessionId).toBeUndefined();
    expect(byKind[selected].started[0]!.prompt).toContain('foreign owner check');
  });

  it('does not resume when there is a session but no pendingSteer (e.g. after reject)', async () => {
    const { orch, adapter } = setup([
      task('A', { state: 'todo', agentSession: 'sess-old', body: 'fresh rework body' }),
    ]);
    await orch.tick();
    expect(adapter.started[0]!.resumeSessionId).toBeUndefined();
    expect(adapter.started[0]!.prompt).toContain('fresh rework body');
  });

  it('recovers a missing provider session once with full context and no attempt burn', async () => {
    const adapter = new FakeAdapter({
      durationMs: 100,
      failFirstStarts: 1,
      stderrTail: 'restore session returned 404 not found',
    });
    const { orch, port, clock } = setup([task('A', {
      body: 'full task contract',
      pendingSteer: 'apply operator correction once',
      agentSession: 'missing-session',
      agentSessionAdapter: 'fake',
    })], { adapter });

    await orch.tick();
    expect(adapter.started[0]!.resumeSessionId).toBe('missing-session');
    clock.now = 100;
    await orch.tick();

    expect(adapter.started).toHaveLength(2);
    expect(adapter.started[1]!.resumeSessionId).toBeUndefined();
    expect(adapter.started[1]!.prompt).toContain('full task contract');
    expect(adapter.started[1]!.prompt).toContain('apply operator correction once');
    expect(adapter.started[1]!.prompt.match(/apply operator correction once/g)).toHaveLength(1);
    expect(port.tasks.get('A')!.state).toBe('in_progress');
    expect(port.tasks.get('A')!.attempts).toBe(0);
    expect(port.tasks.get('A')!.body).toContain('Provider session recovery');

    clock.now = 200;
    await orch.tick();
    expect(port.tasks.get('A')!.state).toBe('review');
    expect(adapter.started).toHaveLength(2);
  });

  it('bounds missing-session recovery to one fresh start and then uses normal accounting', async () => {
    const adapter = new FakeAdapter({
      durationMs: 100,
      fail: true,
      stderrTail:
        'resume session raw-prior-session-id / fake-A-1 returned 404 not found',
      activity: ['restore raw-prior-session-id failed', 'replacement fake-A-1 failed'],
      finalMessage: 'could not resume raw-prior-session-id or fake-A-1',
    });
    const steer = 'bounded recovery operator steer';
    const { orch, port, clock } = setup([task('A', {
      body: `task body\n\n## Human steer (2026-08-02T00:00:00.000Z)\n\n${steer}\n`,
      pendingSteer: steer,
      agentSession: 'raw-prior-session-id',
      agentSessionAdapter: 'fake',
    })], { adapter, config: { backoffBaseMs: 10_000 } });

    await orch.tick();
    clock.now = 100;
    await orch.tick();
    expect(adapter.started).toHaveLength(2);
    expect(adapter.started[1]!.resumeSessionId).toBeUndefined();
    expect(port.tasks.get('A')!.attempts).toBe(0);

    clock.now = 200;
    await orch.tick();
    expect(adapter.started).toHaveLength(2);
    expect(port.tasks.get('A')!.state).toBe('retrying');
    expect(port.tasks.get('A')!.attempts).toBe(1);
    expect(port.tasks.get('A')!.body.match(new RegExp(steer, 'g'))).toHaveLength(1);
    expect(adapter.started[1]!.prompt.match(new RegExp(steer, 'g'))).toHaveLength(1);
    const recovery = port.tasks.get('A')!.body.split('## Provider session recovery')[1] ?? '';
    expect(recovery).not.toContain('raw-prior-session-id');
    expect(port.tasks.get('A')!.body).not.toContain('raw-prior-session-id');
    expect(port.tasks.get('A')!.body).not.toContain('fake-A-1');
    expect(port.tasks.get('A')!.body).toContain('[provider-session-redacted]');
  });

  it('consumes missing-session recovery before a synchronous fresh-start throw', async () => {
    class ThrowFreshAdapter extends FakeAdapter {
      freshStartCalls = 0;
      override start(
        input: import('../../src/orchestrator/adapter.js').AgentStartInput,
        now: number,
      ): import('../../src/orchestrator/adapter.js').AgentRun {
        if (input.resumeSessionId === undefined) {
          this.freshStartCalls += 1;
          throw new Error('spawn setup rejected raw-sync-prior-session');
        }
        return super.start(input, now);
      }
    }
    const adapter = new ThrowFreshAdapter({
      durationMs: 100,
      fail: true,
      stderrTail: 'resume session raw-sync-prior-session returned 404 not found',
    });
    const { orch, port, clock } = setup([task('A', {
      pendingSteer: 'continue after missing session',
      agentSession: 'raw-sync-prior-session',
      agentSessionAdapter: 'fake',
    })], { adapter, config: { backoffBaseMs: 10_000 } });

    await orch.tick();
    clock.now = 100;
    const failedRecovery = await orch.tick();

    const after = port.tasks.get('A')!;
    expect(adapter.freshStartCalls).toBe(1);
    expect(failedRecovery.retried).toContain('A');
    expect(after.state).toBe('retrying');
    expect(after.attempts).toBe(1);
    expect(after.agentSession).toBeNull();
    expect(after.agentSessionAdapter).toBeNull();
    expect(after.body).toContain('fresh start failed');
    expect(after.body).toContain('[provider-session-redacted]');
    expect(after.body).not.toContain('raw-sync-prior-session');
    expect(orch.running).not.toContain('A');

    clock.now = 101;
    await orch.tick();
    expect(adapter.freshStartCalls).toBe(1);
    expect(port.tasks.get('A')!.attempts).toBe(1);
  });

  it('owns a provider session learned only from the terminal run event', async () => {
    class LateSessionAdapter extends FakeAdapter {
      override start(
        input: import('../../src/orchestrator/adapter.js').AgentStartInput,
        now: number,
      ): import('../../src/orchestrator/adapter.js').AgentRun {
        const base = super.start(input, now);
        return {
          get sessionId() { return ''; },
          poll: (at) => {
            const snap = base.poll(at);
            return { ...snap, sessionId: snap.status === 'done' ? 'late-provider-session' : '' };
          },
          activityLog: () => base.activityLog(),
          finalMessage: () => base.finalMessage(),
          stop: (opts) => base.stop(opts),
        };
      }
    }
    const adapter = new LateSessionAdapter({ durationMs: 100 });
    const { orch, port, clock } = setup([task('A')], { adapter });

    await orch.tick();
    expect(port.tasks.get('A')!.agentSession).toBeNull();
    expect(port.tasks.get('A')!.agentSessionAdapter).toBeNull();
    clock.now = 100;
    await orch.tick();

    const reviewed = port.tasks.get('A')!;
    expect(reviewed.state).toBe('review');
    expect(reviewed.agentSession).toBe('late-provider-session');
    expect(reviewed.agentSessionAdapter).toBe('fake');

    port.tasks.set('A', {
      ...reviewed,
      state: 'todo',
      pendingSteer: 'resume the late provider session',
    });
    clock.now = 200;
    await orch.tick();
    expect(adapter.started.at(-1)!.resumeSessionId).toBe('late-provider-session');
  });

  it('syncs the control repo every tick', async () => {
    const { orch, port } = setup([task('A')]);
    await orch.tick();
    await orch.tick();
    expect(port.syncs).toBe(2);
  });

  it('lowers the global cap when dynamic caps see low MemAvailable', async () => {
    const seen: Array<{ globalCap: number; heavyValidationPermits: number }> = [];
    const { orch } = setup(
      [task('A', { repo: 'app' }), task('B', { repo: 'svc' }), task('C', { repo: 'app' })],
      {
        caps: { app: 5, svc: 5 },
        config: {
          globalCap: 2,
          dynamicCaps: {
            enabled: true,
            tiers: [
              {
                maxMemAvailableBytes: 3 * 1024 ** 3,
                globalCap: 1,
                heavyValidationPermits: 1,
              },
            ],
          },
        },
        // 1 GiB free → low tier → global 1
        memReader: () => 1 * 1024 ** 3,
        onEffectiveCaps: (c) => seen.push(c),
      },
    );
    const report = await orch.tick();
    expect(report.dispatched).toHaveLength(1);
    expect(seen[0]).toEqual({ globalCap: 1, heavyValidationPermits: 1 });
  });

  it('keeps base global cap when dynamic caps are disabled despite low mem', async () => {
    const { orch } = setup(
      [task('A', { repo: 'app' }), task('B', { repo: 'svc' })],
      {
        caps: { app: 5, svc: 5 },
        config: { globalCap: 2, dynamicCaps: { enabled: false, tiers: [] } },
        memReader: () => 100, // would be critical if enabled
      },
    );
    const report = await orch.tick();
    expect(report.dispatched).toHaveLength(2);
  });

  it('respects the global cap across repos', async () => {
    const { orch, port } = setup(
      [task('A', { repo: 'app' }), task('B', { repo: 'svc' }), task('C', { repo: 'svc' })],
      { caps: { app: 5, svc: 5 }, config: { globalCap: 2 } },
    );
    const report = await orch.tick();
    expect(report.dispatched).toHaveLength(2);
    const inProgress = [...port.tasks.values()].filter((t) => t.state === 'in_progress');
    expect(inProgress).toHaveLength(2);
  });

  it('does not re-dispatch a task it is already running', async () => {
    const { orch } = setup([task('A')]);
    const first = await orch.tick();
    const second = await orch.tick();
    expect(first.dispatched).toEqual(['A']);
    expect(second.dispatched).toEqual([]);
    expect(second.running).toEqual(['A']);
  });
});

describe('Orchestrator.tick — completion', () => {
  it('moves a finished run to review', async () => {
    const { orch, port, clock } = setup([task('A')], {
      adapter: new FakeAdapter({ durationMs: 100 }),
    });
    await orch.tick(); // dispatch at t=0
    clock.now = 100; // run completes
    const report = await orch.tick();

    expect(report.completed).toEqual(['A']);
    expect(port.tasks.get('A')!.state).toBe('review');
    expect(report.running).toEqual([]);
  });
});

describe('Orchestrator.tick — timestamps', () => {
  it('sets startedAt on dispatch and endedAt on completion', async () => {
    const { orch, port, clock } = setup([task('A')], { adapter: new FakeAdapter({ durationMs: 100 }) });
    clock.now = 1000;
    await orch.tick(); // dispatch
    const dispatched = port.tasks.get('A')!;
    expect(dispatched.startedAt).toBe(new Date(1000).toISOString());
    expect(dispatched.endedAt).toBeNull();
    clock.now = 5000;
    await orch.tick(); // complete → review
    const done = port.tasks.get('A')!;
    expect(done.startedAt).toBe(new Date(1000).toISOString()); // unchanged
    expect(done.endedAt).toBe(new Date(5000).toISOString());
  });

  it('resets startedAt and clears endedAt on each (re-)dispatch — measures the latest run', async () => {
    const adapter = new FakeAdapter({ durationMs: 10, fail: true });
    const { orch, port, clock } = setup([task('A')], { adapter, config: { backoffBaseMs: 1 } });
    clock.now = 1000;
    await orch.tick(); // dispatch (startedAt = 1000)
    clock.now = 1010;
    await orch.tick(); // fails → retrying (endedAt = 1010)
    clock.now = 2000;
    await orch.tick(); // re-dispatch → in_progress again
    const t = port.tasks.get('A')!;
    expect(t.startedAt).toBe(new Date(2000).toISOString()); // this run's start, not the first
    expect(t.endedAt).toBeNull(); // prior end cleared — it's running again
  });

  it('a re-run of a completed task times the new run, not the gap since the old one', async () => {
    // Reproduces the "Agent ran: 24h" bug: a task reviewed, then rejected back to
    // todo and re-run later, must not pair the new endedAt with the old startedAt.
    const { orch, port, clock } = setup([task('A')], { adapter: new FakeAdapter({ durationMs: 100 }) });
    clock.now = 1000;
    await orch.tick(); // dispatch run 1 (startedAt = 1000)
    clock.now = 1100;
    await orch.tick(); // run 1 done → review (startedAt 1000, endedAt 1100)
    // Human rejects it back to todo a "day" later, then it re-dispatches.
    port.tasks.set('A', { ...port.tasks.get('A')!, state: 'todo' });
    clock.now = 90_000_000; // ~25h later
    await orch.tick(); // dispatch run 2
    clock.now = 90_000_100;
    await orch.tick(); // run 2 done → review
    const t = port.tasks.get('A')!;
    expect(t.startedAt).toBe(new Date(90_000_000).toISOString()); // run 2's start
    expect(t.endedAt).toBe(new Date(90_000_100).toISOString()); // run 2's end
  });
});

describe('Orchestrator.tick — retry and failure (SPEC §7.6)', () => {
  it('moves a failed run to retrying and bumps attempts', async () => {
    const adapter = new FakeAdapter({ durationMs: 100, fail: true });
    const { orch, port, clock } = setup([task('A')], { adapter });
    await orch.tick();
    clock.now = 100;
    const report = await orch.tick();

    expect(report.retried).toEqual(['A']);
    const a = port.tasks.get('A')!;
    expect(a.state).toBe('retrying');
    expect(a.attempts).toBe(1);
    expect(a.lastEventAt).not.toBeNull();
  });

  it('parks a task in failed once attempts reach maxAttempts', async () => {
    const adapter = new FakeAdapter({ durationMs: 10, fail: true });
    const { orch, port, clock } = setup([task('A')], {
      adapter,
      config: { maxAttempts: 2, backoffBaseMs: 1 },
    });

    // attempt 1
    await orch.tick();
    clock.now = 10;
    await orch.tick(); // → retrying (attempts 1)
    // wait out backoff, attempt 2
    clock.now = 1000;
    await orch.tick(); // re-dispatch
    clock.now = 1010;
    const report = await orch.tick(); // fails again → failed (attempts 2 >= max 2)

    expect(report.failed).toEqual(['A']);
    expect(port.tasks.get('A')!.state).toBe('failed');
    expect(port.tasks.get('A')!.attempts).toBe(2);
  });

  it('steered failed (attempts exhausted) redispatches on next tick with steer prompt', async () => {
    // C3.36: POST steer on failed recorded pendingSteer + todo, but thrash /
    // poisoned session made the continuation look like it never started.
    // Deliberate human continuation resets attempts to 0 (not bump past cap).
    const adapter = new FakeAdapter({ durationMs: 10, fail: true });
    const { orch, port, clock } = setup([task('A')], {
      adapter,
      config: { maxAttempts: 2, backoffBaseMs: 1 },
    });

    await orch.tick();
    clock.now = 10;
    await orch.tick();
    clock.now = 1000;
    await orch.tick();
    clock.now = 1010;
    await orch.tick();
    const failed = port.tasks.get('A')!;
    expect(failed.state).toBe('failed');
    expect(failed.attempts).toBe(2);

    const probe: RepoProbe = { probe: async () => ({ branches: ['main'] }) };
    const actions = new ActionService(port, probe);
    const steered = await actions.steer('A', 'try a different approach');
    expect(steered.state).toBe('todo');
    expect(steered.attempts).toBe(0);
    expect(steered.pendingSteer).toBe('try a different approach');
    expect(steered.lastEventAt).toBeNull();
    expect(steered.endedAt).toBeNull();

    const beforeStarts = adapter.started.length;
    clock.now = 2000;
    const report = await orch.tick();
    expect(report.dispatched).toContain('A');
    expect(adapter.started.length).toBeGreaterThan(beforeStarts);
    const started = adapter.started[adapter.started.length - 1]!;
    expect(started.prompt).toMatch(/try a different approach/);
    expect(port.tasks.get('A')!.state).toBe('in_progress');
    expect(port.tasks.get('A')!.pendingSteer).toBeNull();
  });

  it('writes a failure mini-packet with exit code and adapter on agent_exit', async () => {
    const adapter = new FakeAdapter({ durationMs: 10, fail: true, activity: ['boom'] });
    const { orch, port, clock } = setup([task('A')], { adapter });
    await orch.tick();
    clock.now = 10;
    await orch.tick();
    const body = port.tasks.get('A')!.body;
    expect(body).toMatch(/## Run failure/);
    expect(body).toMatch(/agent_exit/);
    expect(body).toMatch(/Exit code:\*\* 1/);
    expect(body).toMatch(/Adapter:\*\* `fake`/);
    expect(body).toMatch(/### Next actions/);
    // Phone-visible run timeline with structured kinds (ops-run-timeline).
    expect(body).toMatch(/## Run timeline/);
    expect(body).toMatch(/\*\*dispatch\*\*/);
    expect(body).toMatch(/\*\*agent_exit\*\*/);
  });

  it('records precise death cause + stderr on agent_exit (not bare exit unknown)', async () => {
    const adapter = new FakeAdapter({
      durationMs: 10,
      fail: true,
      activity: ['error: mid-stream'],
      stderrTail: 'Error: status 502 Bad Gateway while streaming response',
      exitSignal: null,
    });
    const { orch, port, clock } = setup([task('A')], { adapter });
    await orch.tick();
    clock.now = 10;
    // First death is transient (502) → same-round soft retry; force second death.
    // failFirstStarts not set + fail:true → first death soft-retries then second
    // start also fails (fail:true). Wait: fail:true means every start fails, and
    // second fail is not soft-retried → packet with death cause.
    await orch.tick(); // soft retry (still in_progress)
    expect(port.tasks.get('A')!.state).toBe('in_progress');
    expect(adapter.started.length).toBe(2);
    clock.now = 30;
    await orch.tick(); // second death → fail path
    const body = port.tasks.get('A')!.body;
    expect(body).toMatch(/Death cause:\*\*.*502/i);
    expect(body).toMatch(/### Stderr tail/);
    expect(body).toMatch(/status 502/);
    expect(body).toMatch(/## Run timeline/);
    expect(body).toMatch(/\*\*agent_exit\*\*.*502|502.*agent_exit/i);
  });

  it('same-round transient retry does not burn attempts and recovers on second start', async () => {
    const adapter = new FakeAdapter({
      durationMs: 10,
      failFirstStarts: 1,
      activity: ['error: status 502 mid-stream'],
      stderrTail: 'status 502 Bad Gateway',
    });
    const { orch, port, clock } = setup([task('A')], {
      adapter,
      config: { maxAttempts: 3, backoffBaseMs: 1 },
    });
    await orch.tick(); // dispatch
    expect(port.tasks.get('A')!.state).toBe('in_progress');
    expect(port.tasks.get('A')!.attempts).toBe(0);
    clock.now = 10;
    await orch.tick(); // first death → soft retry, still in_progress, attempts 0
    expect(port.tasks.get('A')!.state).toBe('in_progress');
    expect(port.tasks.get('A')!.attempts).toBe(0);
    expect(adapter.started.length).toBe(2);
    clock.now = 30;
    await orch.tick(); // second start succeeds → review (no verifier)
    expect(port.tasks.get('A')!.state).toBe('review');
    expect(port.tasks.get('A')!.attempts).toBe(0);
    // No Run failure mini-packet on the success path.
    expect(port.tasks.get('A')!.body).not.toMatch(/## Run failure/);
  });

  it('host_operation uses deterministic executor — never starts an LLM adapter', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'hercules-host-ws-'));
    try {
      const adapter = new FakeAdapter({
        durationMs: 10,
        fail: true,
        activity: ['should not run'],
      });
      const agents = new AgentRegistry({ grok: adapter }, 'grok');
      const { orch, port, clock } = setup(
        [
          task('HOST', {
            adapter: 'grok',
            executionClass: 'host_operation',
            // Distinct entries — validateHostCommandScope rejects duplicates.
            hostCommandScope: ['true', 'echo ok'],
            hostApprovedAt: '2026-07-31T06:00:00.000Z',
          }),
        ],
        { adapter, agents, workspaces: new TempDirWorkspaces(root) },
      );

      await orch.tick(); // dispatch host-executor
      expect(adapter.started).toHaveLength(0);
      expect(port.tasks.get('HOST')!.state).toBe('in_progress');
      expect(port.tasks.get('HOST')!.hostExecutionStartedAt).toBeTruthy();
      expect(port.tasks.get('HOST')!.body).toContain('Host execution started');
      // Live meta while running (or just after).
      const liveDuring = orch.getState().liveRuns['HOST'];
      if (liveDuring) {
        expect(liveDuring.hostCommandTotal).toBe(2);
        expect(liveDuring).not.toHaveProperty('stdout');
      }
      await new Promise((r) => setTimeout(r, 300));
      clock.now = 500;
      const report = await orch.tick();
      expect(adapter.started).toHaveLength(0);
      expect(report.completed).toEqual(['HOST']);
      expect(port.tasks.get('HOST')!.state).toBe('review');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('successful host_operation review packet persists exactly one receipt (host-executor e2e)', async () => {
    // Regression: packet render used to emit the structured receipt AND leave
    // the same receipt inside Agent report → two ## Host operation receipt headings.
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { assembleReviewPacket } = await import('../../src/verification/packet.js');
    const { splitFinalReport } = await import('../../src/domain/verification.js');
    const { HOST_EXECUTOR_SESSION_PREFIX } = await import('../../src/domain/hostExecutor.js');
    const root = await mkdtemp(join(tmpdir(), 'hercules-host-receipt-e2e-'));
    try {
      const adapter = new FakeAdapter({
        durationMs: 10,
        fail: true,
        activity: ['coding agent must not run'],
      });
      const agents = new AgentRegistry({ grok: adapter }, 'grok');
      const scope = ['true'];
      let verifyCalls = 0;
      // setup() types verify as (...args: unknown[]) — keep that shape so tsc
      // accepts the bag; cast args inside (same pattern as other verify stubs).
      const verifier = {
        verify: async (
          ...args: unknown[]
        ): Promise<import('../../src/domain/verification.js').ReviewPacket> => {
          verifyCalls += 1;
          const t = args[0] as Task;
          const activityLogOrOpts = args[3];
          const finalReportArg = args[5] as string | undefined;
          let finalReport = '';
          if (activityLogOrOpts !== undefined && Array.isArray(activityLogOrOpts)) {
            finalReport = finalReportArg ?? '';
          } else if (activityLogOrOpts !== undefined && typeof activityLogOrOpts === 'object') {
            finalReport =
              (activityLogOrOpts as { finalReport?: string }).finalReport ?? '';
          }
          const { report, selfAssessment } = splitFinalReport(finalReport);
          return assembleReviewPacket({
            taskId: t.id,
            branch: `hercules/${t.id}`,
            filesTouched: [],
            diffSummary: '0 files changed',
            gates: [],
            cheatFindings: [],
            reviewerVerdict: null,
            reviewerRan: false,
            reviewerSkipReason: 'no file changes (read-only / Q&A)',
            selfAssessment: selfAssessment || '(agent provided none)',
            finalReport: report,
            ...(t.executionClass !== undefined ? { executionClass: t.executionClass } : {}),
            ...(t.hostCommandScope !== undefined
              ? { hostCommandScope: t.hostCommandScope }
              : {}),
          });
        },
      };
      const { orch, port, clock } = setup(
        [
          task('HOST', {
            adapter: 'grok',
            executionClass: 'host_operation',
            hostCommandScope: [...scope],
            hostApprovedAt: '2026-07-31T06:00:00.000Z',
          }),
        ],
        {
          adapter,
          agents,
          workspaces: new TempDirWorkspaces(root),
          verifier,
        },
      );

      await orch.tick(); // dispatch host-executor
      expect(adapter.started).toHaveLength(0);
      expect(port.tasks.get('HOST')!.state).toBe('in_progress');
      // Wait for deterministic command + settle.
      for (let i = 0; i < 40; i += 1) {
        clock.now += 100;
        const report = await orch.tick();
        if (report.completed.includes('HOST') || port.tasks.get('HOST')!.state === 'review') {
          break;
        }
        await new Promise((r) => setTimeout(r, 40));
      }

      expect(adapter.started).toHaveLength(0);
      expect(verifyCalls).toBe(1);
      const host = port.tasks.get('HOST')!;
      expect(host.state).toBe('review');
      expect(host.agentSession?.startsWith(HOST_EXECUTOR_SESSION_PREFIX)).toBe(true);
      // Exactly one receipt heading in the persisted body (packet + trail).
      expect(host.body.match(/## Host operation receipt/g)).toHaveLength(1);
      expect(host.body).toContain('## Review packet');
      expect(host.body).toContain('Deterministic host executor');
      expect(host.body).toContain('`true`');
      expect(host.body).toMatch(/\*\*Outcome:\*\*\s*success/);
      // Single approved command executed once (evidence index 1/1).
      expect(host.body).toContain('[1/1]');
      expect(host.body).not.toMatch(/\[2\//);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('host_operation restart orphan with start marker is replay-blocked, not retrying', async () => {
    const adapter = new FakeAdapter({ durationMs: 1000, hang: true });
    const agents = new AgentRegistry({ grok: adapter }, 'grok');
    const { orch, port } = setup(
      [
        task('HOST', {
          adapter: 'grok',
          state: 'in_progress',
          executionClass: 'host_operation',
          hostCommandScope: ['true'],
          hostApprovedAt: '2026-07-31T06:00:00.000Z',
          hostExecutionStartedAt: '2026-07-31T06:01:00.000Z',
          startedAt: '2026-07-31T06:01:00.000Z',
          body:
            'body\n\n## Host execution started\n\n' +
            '2026-07-31T06:01:00.000Z: deterministic host executor began approved scope (1 command).\n',
        }),
      ],
      { adapter, agents },
    );

    // No tracked run → orphan recovery on first tick.
    const report = await orch.tick();
    expect(adapter.started).toHaveLength(0);
    expect(report.recovered).toContain('HOST');
    expect(port.tasks.get('HOST')!.state).toBe('failed');
    expect(port.tasks.get('HOST')!.body).toContain('Host operation replay blocked');
    expect(port.tasks.get('HOST')!.state).not.toBe('retrying');
  });

  it('host_operation/deploy orphan without start marker is also replay-blocked (never retrying)', async () => {
    // Legacy / pre-marker in_progress host tasks must not recover to retrying.
    const adapter = new FakeAdapter({ durationMs: 1000, hang: true });
    const agents = new AgentRegistry({ grok: adapter }, 'grok');
    const { orch, port } = setup(
      [
        task('HOST-LEGACY', {
          adapter: 'grok',
          state: 'in_progress',
          executionClass: 'host_operation',
          hostCommandScope: ['true'],
          hostApprovedAt: '2026-07-31T06:00:00.000Z',
          hostExecutionStartedAt: null,
          startedAt: '2026-07-31T06:01:00.000Z',
          body: 'legacy host body without marker\n',
        }),
        task('DEPLOY-LEGACY', {
          adapter: 'grok',
          state: 'in_progress',
          executionClass: 'deploy',
          hostCommandScope: ['true'],
          hostApprovedAt: '2026-07-31T06:00:00.000Z',
          hostExecutionStartedAt: null,
          startedAt: '2026-07-31T06:01:00.000Z',
          body: 'legacy deploy body\n',
        }),
      ],
      { adapter, agents },
    );

    const report = await orch.tick();
    expect(adapter.started).toHaveLength(0);
    for (const id of ['HOST-LEGACY', 'DEPLOY-LEGACY']) {
      expect(report.recovered).toContain(id);
      expect(port.tasks.get(id)!.state).toBe('failed');
      expect(port.tasks.get(id)!.state).not.toBe('retrying');
      expect(port.tasks.get(id)!.body).toContain('Host operation replay blocked');
    }
  });

  it('never same-round retries a host operation after command failure', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'hercules-host-ws-'));
    try {
      const adapter = new FakeAdapter({
        durationMs: 10,
        fail: true,
        activity: ['should not run'],
      });
      const agents = new AgentRegistry({ grok: adapter }, 'grok');
      const { orch, port, clock } = setup(
        [
          task('HOST', {
            adapter: 'grok',
            executionClass: 'host_operation',
            hostCommandScope: ['false'],
            hostApprovedAt: '2026-07-31T06:00:00.000Z',
          }),
        ],
        { adapter, agents, workspaces: new TempDirWorkspaces(root) },
      );

      await orch.tick();
      expect(adapter.started).toHaveLength(0);
      await new Promise((r) => setTimeout(r, 300));
      clock.now = 500;
      const report = await orch.tick();

      expect(adapter.started).toHaveLength(0);
      expect(report.failed).toEqual(['HOST']);
      expect(port.tasks.get('HOST')!.state).toBe('failed');
      expect(port.tasks.get('HOST')!.body).toContain('Host operation replay blocked');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('second consecutive transient death burns via normal fail path', async () => {
    const adapter = new FakeAdapter({
      durationMs: 10,
      fail: true,
      activity: ['error: ECONNRESET'],
      stderrTail: 'ECONNRESET',
    });
    const { orch, port, clock } = setup([task('A')], {
      adapter,
      config: { maxAttempts: 5, backoffBaseMs: 1 },
    });
    await orch.tick();
    clock.now = 10;
    await orch.tick(); // soft retry
    expect(port.tasks.get('A')!.attempts).toBe(0);
    clock.now = 30;
    await orch.tick(); // second death → agent_exit burn
    const t = port.tasks.get('A')!;
    expect(t.state).toBe('retrying');
    expect(t.attempts).toBe(1);
    expect(t.body).toMatch(/agent_exit/);
    expect(t.body).toMatch(/Death cause:/);
  });

  it('parks early on thrash (same kind × thrash limit) before maxAttempts', async () => {
    const adapter = new FakeAdapter({ durationMs: 10, fail: true });
    const { orch, port, clock } = setup([task('A')], {
      adapter,
      config: { maxAttempts: 5, backoffBaseMs: 1 },
    });
    // fail 1 → retrying
    await orch.tick();
    clock.now = 10;
    await orch.tick();
    expect(port.tasks.get('A')!.state).toBe('retrying');
    // fail 2 → thrash park (limit 2), not attempt 5
    clock.now = 1000;
    await orch.tick();
    clock.now = 1010;
    const report = await orch.tick();
    expect(report.failed).toEqual(['A']);
    const t = port.tasks.get('A')!;
    expect(t.state).toBe('failed');
    expect(t.attempts).toBe(2);
    expect(t.body).toMatch(/Thrash:/);
    expect(t.body).toMatch(/Salvage brief/);
  });
});

describe('Orchestrator.tick — stall detection (SPEC §7.3)', () => {
  it('kills a stalled run and routes it to retrying', async () => {
    const adapter = new FakeAdapter({ durationMs: 100, hang: true });
    const { orch, port, clock } = setup([task('A')], {
      adapter,
      config: { stallTimeoutMs: 1000 },
    });
    await orch.tick(); // dispatch at t=0, lastEventAt frozen at 0
    clock.now = 1500; // exceeds stall timeout
    const report = await orch.tick();

    expect(report.stalled).toEqual(['A']);
    expect(port.tasks.get('A')!.state).toBe('retrying');
    expect(adapter.stopped).toContainEqual({ id: 'A', force: false });
  });

  it('stall soft-retry does not burn attempts (kind-aware policy)', async () => {
    const adapter = new FakeAdapter({ durationMs: 100, hang: true });
    const { orch, port, clock } = setup([task('A')], {
      adapter,
      config: { stallTimeoutMs: 1000, maxAttempts: 3 },
    });
    await orch.tick();
    clock.now = 1500;
    await orch.tick();
    const a = port.tasks.get('A')!;
    expect(a.state).toBe('retrying');
    // First stall is soft — attempts stay 0, body records accounting + next eligible.
    expect(a.attempts).toBe(0);
    expect(a.body).toMatch(/Kind:\*\* `stall`/);
    expect(a.body).toMatch(/Attempt accounting:.*soft|no burn/i);
    expect(a.body).toMatch(/Next eligible:/);
  });

  it('does not idle-stall when processAlive (long tool run)', async () => {
    // Real adapters set processAlive while the child runs; stream silence is normal.
    const adapter = new FakeAdapter({ durationMs: 100_000, hang: true, processAlive: true });
    const { orch, port, clock } = setup([task('A')], {
      adapter,
      config: { stallTimeoutMs: 1000, maxRunMs: 60_000 },
    });
    await orch.tick();
    clock.now = 5000; // past stallTimeout but under maxRun
    const report = await orch.tick();
    expect(report.stalled).toEqual([]);
    expect(port.tasks.get('A')!.state).toBe('in_progress');
  });

  it('hard-kills when maxRunMs exceeded even if processAlive', async () => {
    const adapter = new FakeAdapter({ durationMs: 100_000, hang: true, processAlive: true });
    const { orch, port, clock } = setup([task('A')], {
      adapter,
      config: { stallTimeoutMs: 1000, maxRunMs: 2000 },
    });
    await orch.tick();
    clock.now = 2500;
    const report = await orch.tick();
    expect(report.stalled).toEqual(['A']);
    expect(port.tasks.get('A')!.body).toMatch(/hard max run/i);
    expect(adapter.stopped.some((s) => s.id === 'A' && s.force === true)).toBe(true);
  });
});

describe('Orchestrator.tick — reconcile external changes', () => {
  it('tears down a run whose task was cancelled out of band', async () => {
    const { orch, port, adapter } = setup([task('A')]);
    await orch.tick();
    // a human cancels the task on disk
    port.tasks.set('A', { ...port.tasks.get('A')!, state: 'cancelled' });

    const report = await orch.tick();
    // Graceful path (Plan 2a): SIGTERM first; with the default zero-grace fake
    // adapter the run exits the same tick, so wind-down begins AND finalizes here.
    expect(report.tornDown).toContain('A');
    expect(report.running).toEqual([]);
    expect(orch.stopping).not.toContain('A'); // finalized
    expect(adapter.stopped).toContainEqual({ id: 'A', force: false });
  });
});

describe('Orchestrator runtime view (SPEC §2, §14)', () => {
  it('exposes the latest snapshot, running set, and last report after a tick', async () => {
    const { orch } = setup([task('A')]);
    expect(orch.getState().snapshot).toBeNull();
    await orch.tick();
    const state = orch.getState();
    expect(state.snapshot!.tasks.map((t) => t.id)).toEqual(['A']);
    expect(state.running).toEqual(['A']);
    expect(state.lastReport!.dispatched).toEqual(['A']);
  });

  it('surfaces quiet-progress when processAlive and stream is silent', async () => {
    // Case study: cargo with no stream — phone must not look blank/stuck.
    const adapter = new FakeAdapter({
      durationMs: 100_000,
      hang: true,
      processAlive: true,
      aliveHint: 'cargo',
    });
    const { orch, clock } = setup([task('A')], {
      adapter,
      config: { stallTimeoutMs: 60_000, maxRunMs: 2 * 60 * 60_000 },
    });
    await orch.tick();
    clock.now = 45_000; // past QUIET_PROGRESS_THRESHOLD (30s), under stall/max
    const state = orch.getState();
    const live = state.liveRuns['A'];
    expect(live).toBeDefined();
    expect(live!.processAlive).toBe(true);
    expect(live!.silenceMs).toBeGreaterThanOrEqual(45_000);
    expect(live!.aliveHint).toBe('cargo');
    expect(live!.maxRunMs).toBe(2 * 60 * 60_000);
    const lines = state.activity['A'] ?? [];
    expect(lines.some((l) => /Quiet/.test(l) && /cargo/.test(l) && /hard kill/.test(l))).toBe(
      true,
    );
  });

  it('notifies subscribers on each tick and stops after unsubscribe', async () => {
    const { orch } = setup([task('A')]);
    let calls = 0;
    const unsubscribe = orch.subscribe(() => {
      calls += 1;
    });
    await orch.tick();
    await orch.tick();
    expect(calls).toBe(2);
    unsubscribe();
    await orch.tick();
    expect(calls).toBe(2);
  });
});

/** Real on-disk workspace dirs so host-executor spawn has a valid cwd. */
class TempDirWorkspaces implements Workspaces {
  constructor(private readonly root: string) {}
  async create(repo: RepoConfig, taskId: string): Promise<Workspace> {
    const { mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = join(this.root, repo.key, taskId);
    await mkdir(dir, { recursive: true });
    return {
      taskId,
      repo: repo.key,
      dir,
      branch: `hercules/${taskId}`,
      allocation: { slug: taskId, port: 4000, scratchDir: join(dir, '.scratch') },
      branchLease: { expectedBaseRevision: '0'.repeat(40), expectedRemoteTip: null },
    };
  }
  async remove(_taskId: string): Promise<void> {}
  async preserve(): Promise<import('../../src/isolation/worktree.js').PreserveResult> {
    return { notPropagated: false, events: [] };
  }
  async inspect(_taskId?: string): Promise<WorkspaceImpact | null> {
    return null;
  }
  async reclaimOrphans(): Promise<string[]> {
    return [];
  }
  async readWorkflow(): Promise<string | null> {
    return null;
  }
  async readTrustedDefaultRevisionSnapshot() {
    return {
      revision: '0'.repeat(40),
      workflowContent: '---\nprotected_paths: []\n---\n',
    };
  }
}

class SpyWorkspaces implements Workspaces {
  readonly created: string[] = [];
  readonly createOpts: Array<{
    taskId: string;
    hadPriorWork: boolean | undefined;
    expectedBaseRevision: string | undefined;
    expectedRemoteTip: string | null | undefined;
  }> = [];
  readonly removed: string[] = [];
  readonly preserved: string[] = [];
  readonly inspected: string[] = [];
  readonly reclaimCalls: Array<ReadonlySet<string>> = [];
  reclaimReturn: string[] = [];
  acquiredLease: NonNullable<PreserveResult['branchLease']> = {
    expectedBaseRevision: '0'.repeat(40),
    expectedRemoteTip: null,
  };
  preserveLease: PreserveResult['branchLease'];
  checkedOutTip: string | null = null;
  /** Remote tip returned by live ownership observe (null = absent). */
  remoteTaskRefTip: string | null | undefined = undefined;
  onCreate: (() => void) | null = null;
  onWorkspaceHead: (() => void) | null = null;
  failRemove = false;
  /** WORKFLOW.md content the trusted mirror would return (null = none). */
  workflow: string | null = null;
  async create(
    repo: RepoConfig,
    taskId: string,
    opts?: CreateOptions,
  ): Promise<Workspace> {
    this.created.push(taskId);
    this.createOpts.push({
      taskId,
      hadPriorWork: opts?.hadPriorWork,
      expectedBaseRevision: opts?.expectedBaseRevision,
      expectedRemoteTip: opts?.expectedRemoteTip,
    });
    this.onCreate?.();
    return {
      taskId,
      repo: repo.key,
      dir: `/ws/${repo.key}/${taskId}`,
      branch: `hercules/${taskId}`,
      allocation: { slug: taskId, port: 4000, scratchDir: `/ws/${repo.key}/${taskId}/.scratch` },
      branchLease: {
        expectedBaseRevision:
          opts?.expectedBaseRevision ?? this.acquiredLease.expectedBaseRevision,
        expectedRemoteTip:
          opts && Object.prototype.hasOwnProperty.call(opts, 'expectedRemoteTip')
            ? (opts.expectedRemoteTip ?? null)
            : this.acquiredLease.expectedRemoteTip,
      },
    };
  }
  async remove(taskId: string): Promise<void> {
    if (this.failRemove) throw new Error('injected provisional cleanup failure');
    this.removed.push(taskId);
  }
  async workspaceHead(workspace: Workspace): Promise<string | null> {
    this.onWorkspaceHead?.();
    return this.checkedOutTip ?? workspace.branchLease.expectedRemoteTip;
  }
  async readRemoteTaskRefTip(_repo: RepoConfig, _taskId: string): Promise<string | null> {
    if (this.remoteTaskRefTip === undefined) {
      return this.acquiredLease.expectedRemoteTip;
    }
    return this.remoteTaskRefTip;
  }
  async preserve(taskId: string): Promise<import('../../src/isolation/worktree.js').PreserveResult> {
    this.preserved.push(taskId);
    return {
      notPropagated: false,
      events: [],
      ...(this.preserveLease ? { branchLease: this.preserveLease } : {}),
    };
  }
  async inspect(taskId: string): Promise<WorkspaceImpact> {
    this.inspected.push(taskId);
    return { changedFiles: 2, localCommits: 1, pushedRemote: false };
  }
  async reclaimOrphans(keep: ReadonlySet<string>): Promise<string[]> {
    this.reclaimCalls.push(keep);
    return this.reclaimReturn;
  }
  async readWorkflow(): Promise<string | null> {
    return this.workflow;
  }
}

describe('Orchestrator verify-only tasks (C3.50)', () => {
  it('a red verdict on a verify-class task is terminal (failed) — no implementer re-dispatch on the seeded tip', async () => {
    const spy = new SpyWorkspaces();
    const verifier = {
      verify: async (): Promise<import('../../src/domain/verification.js').ReviewPacket> => ({
        taskId: 'VER',
        branch: 'hercules/VER',
        filesTouched: ['test/attach.test.ts'],
        diffSummary: '1 file changed',
        diff: '-it("attach item is enabled when not uploading")',
        gates: [{ name: 'anti-cheat', command: 'hercules:anti-cheat', passed: false, output: 'removed test case' }],
        cheatFindings: [{ kind: 'test-integrity', file: 'test/attach.test.ts', detail: 'removed or renamed test case "attach item is enabled when not uploading"' }],
        screenshots: [],
        reviewerVerdict: null,
        selfAssessment: '',
        finalReport: '',
        green: false,
        noChanges: false,
        autoRework: true,
        reportPolluted: false,
        dod: { mechanical: 'fail', reviewer: 'pending', human: 'pending', criteria: [], warnings: [] },
        activityLog: [],
        ...PACKET_EXTRA,
        verifiedSha: 'b'.repeat(40),
        reworkPath: 'full',
        reworkPathReason: 'l1',
      }),
    };
    const { orch, port, clock } = setup(
      [task('VER', { executionClass: 'verify', seedFromSha: 'c'.repeat(40) })],
      { workspaces: spy, verifier },
    );
    await orch.tick();
    clock.now = 100;
    const report = await orch.tick();
    expect(report.failed).toContain('VER');
    expect(report.retried).not.toContain('VER');
    const after = port.tasks.get('VER')!;
    expect(after.state).toBe('failed');
    expect(after.body).toContain('## Verify-only verdict');
    expect(after.body).toContain('did not queue a rework run');
    clock.now = 10_000_000;
    const third = await orch.tick();
    expect(third.dispatched).toEqual([]);
  });
});

describe('Orchestrator orphan recovery (SPEC §7, restart safety)', () => {
  it('keeps scope-blocked implementer bytes local without preserve or publication', async () => {
    const spy = new SpyWorkspaces();
    const verifier = {
      verify: async (): Promise<import('../../src/domain/verification.js').ReviewPacket> => ({
        taskId: 'SCOPE',
        branch: 'hercules/SCOPE',
        filesTouched: ['src/owned.ts', 'hook-stray.txt'],
        diffSummary: '2 files changed',
        diff: '+foreign',
        gates: [{
          name: 'path-lease-scope',
          command: 'hercules:path-lease-scope',
          passed: false,
          output: 'actual diff escaped affected_paths: hook-stray.txt',
        }],
        cheatFindings: [],
        screenshots: [],
        reviewerVerdict: null,
        selfAssessment: '',
        finalReport: '',
        green: false,
        noChanges: false,
        autoRework: true,
        reportPolluted: false,
        dod: { mechanical: 'fail', reviewer: 'pending', human: 'pending', criteria: [], warnings: [] },
        activityLog: [],
        ...PACKET_EXTRA,
        verifiedSha: 'a'.repeat(40),
        reworkPath: 'full',
        reworkPathReason: 'scope',
      }),
    };
    const { orch, port, clock } = setup([task('SCOPE')], { workspaces: spy, verifier });

    await orch.tick();
    clock.now = 100;
    const report = await orch.tick();

    expect(spy.preserved).toEqual([]);
    expect(spy.removed).toEqual([]);
    expect(orch.running).toEqual([]);
    expect(report.failed).toContain('SCOPE');
    expect(port.tasks.get('SCOPE')).toMatchObject({ state: 'failed', attempts: 0 });
    expect(port.tasks.get('SCOPE')!.body).toContain('## Path-lease scope blocked');

    const restartedSpy = new SpyWorkspaces();
    const restarted = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      workspaces: restartedSpy,
      clock: () => 200,
    });
    await restarted.tick();
    expect(restartedSpy.reclaimCalls[0]).toContain('SCOPE');
  });

  it('re-queues an in_progress task that the daemon is not tracking (e.g. after a restart)', async () => {
    // A task left in_progress on disk by a previous (crashed) daemon instance.
    const { orch, port } = setup([task('A', { state: 'in_progress', agentSession: 'dead' })]);
    const report = await orch.tick();

    expect(report.recovered).toEqual(['A']);
    // recovered → retrying → immediately eligible → re-dispatched the same tick
    expect(report.dispatched).toEqual(['A']);
    expect(orch.running).toEqual(['A']);
    expect(port.tasks.get('A')!.state).toBe('in_progress');
    // It was re-dispatched this same tick, so it is running again — and a running
    // task has no endedAt (the dispatch clears it; the invariant is in_progress ⟹
    // endedAt === null). The fresh run's startedAt is stamped at dispatch.
    expect(port.tasks.get('A')!.endedAt).toBeNull();
    expect(port.tasks.get('A')!.startedAt).not.toBeNull();
  });

  it('recovers an orphan before durably folding its queued chat exactly once', async () => {
    const adapter = new FakeAdapter({ durationMs: 100 });
    const { orch, port } = setup([
      task('A', { state: 'in_progress', agentSession: 'dead-session' }),
    ], { adapter });
    expect(orch.queueTaskChat('A', 'survive daemon orphan recovery', {
      clientMessageId: 'orphan-chat-1',
    }).mode).toBe('queued');

    const report = await orch.tick();

    expect(report.recovered).toEqual(['A']);
    expect(report.retried.filter((id) => id === 'A')).toHaveLength(1);
    expect(report.dispatched.filter((id) => id === 'A')).toHaveLength(1);
    expect(adapter.started).toHaveLength(1);
    expect(adapter.started[0]!.prompt.match(/survive daemon orphan recovery/g)).toHaveLength(1);
    expect(orch.getTaskChatQueue('A')).toEqual([]);
    const live = port.tasks.get('A')!;
    expect(live.state).toBe('in_progress');
    expect(live.body.match(/survive daemon orphan recovery/g)).toHaveLength(1);
    expect(live.body).toContain('client-message-id: orphan-chat-1');
  });

  it('does not touch in_progress tasks it is actively tracking', async () => {
    const { orch } = setup([task('A')]);
    await orch.tick(); // dispatch A → tracked + in_progress
    const second = await orch.tick();
    expect(second.recovered).toEqual([]);
  });
});

describe('Orchestrator workspace isolation (SPEC §8)', () => {

  it('parks foreign remote tip movement without burning implement attempts or adopting tip', async () => {
    const base = 'd'.repeat(40);
    const owned = 'e'.repeat(40);
    const foreign = 'f'.repeat(40);
    const spy = new SpyWorkspaces();
    spy.acquiredLease = { expectedBaseRevision: base, expectedRemoteTip: owned };
    spy.checkedOutTip = owned;
    spy.remoteTaskRefTip = owned;
    const adapter = new FakeAdapter({ durationMs: 10_000 });
    const port = new FakePort(
      new Map([
        [
          'FOREIGN-TIP',
          task('FOREIGN-TIP', {
            state: 'todo',
            attempts: 2,
            expectedBaseRevision: base,
            expectedRemoteTip: owned,
          }),
        ],
      ]),
      reposWithCaps({ app: 1 }),
    );
    let now = 0;
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter,
      workspaces: spy,
      clock: () => now,
    });

    await orch.tick();
    expect(port.tasks.get('FOREIGN-TIP')!.state).toBe('in_progress');
    expect(adapter.started).toHaveLength(1);

    spy.remoteTaskRefTip = foreign;
    now = 1_000;
    const report = await orch.tick();

    const after = port.tasks.get('FOREIGN-TIP')!;
    expect(after.state).toBe('review');
    expect(after.attempts).toBe(2);
    expect(after.expectedRemoteTip).toBe(owned);
    expect(after.body).toContain('## Task-ref ownership');
    expect(after.body).toMatch(/Task-ref ownership|soft \(no burn\)|Adopt remote tip/i);
    expect(report.completed).toContain('FOREIGN-TIP');
    expect(spy.removed).not.toContain('FOREIGN-TIP');
    expect(spy.preserved).not.toContain('FOREIGN-TIP');
  });


  it('commits exact branch ownership before adapter.start', async () => {
    const spy = new SpyWorkspaces();
    spy.acquiredLease = {
      expectedBaseRevision: '1'.repeat(40),
      expectedRemoteTip: null,
    };
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    class LeaseOrderAdapter extends FakeAdapter {
      override start(
        input: Parameters<FakeAdapter['start']>[0],
        now: Parameters<FakeAdapter['start']>[1],
      ): ReturnType<FakeAdapter['start']> {
        const durable = port.tasks.get(input.taskId)!;
        expect(durable.expectedBaseRevision).toBe('1'.repeat(40));
        expect(durable.expectedRemoteTip).toBeNull();
        expect(port.commits.at(-1)).toContain('acquire exact task-branch lease');
        return super.start(input, now);
      }
    }
    const adapter = new LeaseOrderAdapter({ durationMs: 100 });
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter,
      workspaces: spy,
      clock: () => 0,
    });

    await orch.tick();

    expect(adapter.started).toHaveLength(1);
    expect(port.tasks.get('A')!.state).toBe('in_progress');
  });

  it('does not start an agent when durable branch ownership cannot be committed', async () => {
    const spy = new SpyWorkspaces();
    spy.acquiredLease = {
      expectedBaseRevision: '3'.repeat(40),
      expectedRemoteTip: null,
    };
    class FailingLeasePort extends FakePort {
      override async commit(message: string): Promise<{ committed: boolean }> {
        if (message.includes('acquire exact task-branch lease')) {
          throw new Error('injected lease commit failure');
        }
        return super.commit(message);
      }
    }
    const port = new FailingLeasePort(
      new Map([['A', task('A')]]),
      reposWithCaps({ app: 1 }),
    );
    const adapter = new FakeAdapter({ durationMs: 100 });
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter,
      workspaces: spy,
      clock: () => 0,
    });

    const report = await orch.tick();

    expect(report.dispatched).toEqual([]);
    expect(adapter.started).toHaveLength(0);
    expect(port.tasks.get('A')!.state).toBe('todo');
    expect(port.tasks.get('A')!.expectedBaseRevision).toBeUndefined();
    expect(port.tasks.get('A')!.expectedRemoteTip).toBeUndefined();

    await orch.tick();
    expect(adapter.started).toHaveLength(0);
    expect(port.tasks.get('A')!.expectedBaseRevision).toBeUndefined();
  });

  it('provisions a workspace on dispatch and tears it down on completion', async () => {
    const spy = new SpyWorkspaces();
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      workspaces: spy,
      clock: () => clock.now,
    });

    await orch.tick();
    expect(spy.created).toEqual(['A']);
    expect(spy.removed).toEqual([]);

    clock.now = 100;
    await orch.tick();
    expect(spy.preserved).toEqual(['A']); // done → preserve the branch for review
    expect(spy.removed).toEqual([]);
    // The done path is NOT a cancel teardown: no residue report is written.
    expect(port.tasks.get('A')!.body).not.toMatch(/## Teardown/);
    expect(port.commits.some((m) => m.endsWith('teardown report'))).toBe(false);
  });

  it('advances the durable remote lease after successful branch preservation', async () => {
    const spy = new SpyWorkspaces();
    const base = '4'.repeat(40);
    const published = '5'.repeat(40);
    spy.acquiredLease = { expectedBaseRevision: base, expectedRemoteTip: null };
    spy.preserveLease = { expectedBaseRevision: base, expectedRemoteTip: published };
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      workspaces: spy,
      clock: () => clock.now,
    });

    await orch.tick();
    clock.now = 100;
    await orch.tick();

    const durable = port.tasks.get('A')!;
    expect(durable.expectedBaseRevision).toBe(base);
    expect(durable.expectedRemoteTip).toBe(published);
    expect(port.commits.at(-1)).toContain('advance exact task-branch lease');
  });

  it('rolls back an undurable remote-lease advance after preservation', async () => {
    class RejectAdvancePort extends FakePort {
      override async commit(message: string): Promise<{ committed: boolean }> {
        if (message.includes('advance exact task-branch lease')) {
          return { committed: false };
        }
        return super.commit(message);
      }
    }
    const spy = new SpyWorkspaces();
    const base = '4'.repeat(40);
    spy.acquiredLease = { expectedBaseRevision: base, expectedRemoteTip: null };
    spy.preserveLease = {
      expectedBaseRevision: base,
      expectedRemoteTip: '5'.repeat(40),
    };
    const port = new RejectAdvancePort(
      new Map([['A', task('A')]]),
      reposWithCaps({ app: 1 }),
    );
    const clock = { now: 0 };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      workspaces: spy,
      clock: () => clock.now,
    });

    await orch.tick();
    clock.now = 100;
    await orch.tick();

    const durable = port.tasks.get('A')!;
    expect(durable.expectedBaseRevision).toBe(base);
    expect(durable.expectedRemoteTip).toBeNull();
  });

  it('tells provisioning whether the task ever ran (fresh tasks must not recover foreign tips)', async () => {
    const spy = new SpyWorkspaces();
    const port = new FakePort(
      new Map([
        ['FRESH', task('FRESH')],
        ['PROVISION-ONLY', task('PROVISION-ONLY', { state: 'retrying', attempts: 1 })],
        ['RERUN', task('RERUN', { state: 'retrying', attempts: 1, startedAt: '2026-07-15T00:00:00Z' })],
      ]),
      reposWithCaps({ app: 3 }),
    );
    const orch = new Orchestrator({
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      workspaces: spy,
      config: { ...makeConfig('/ctrl'), globalCap: 3 },
      clock: () => 0,
    });
    await orch.tick();
    const byId = new Map(spy.createOpts.map((c) => [c.taskId, c.hadPriorWork]));
    expect(byId.get('FRESH')).toBe(false);
    expect(byId.get('PROVISION-ONLY')).toBe(false);
    expect(byId.get('RERUN')).toBe(true);
  });

  it('never adopts a pre-existing remote tip for an unpinned fresh task', async () => {
    const base = '6'.repeat(40);
    const candidate = '7'.repeat(40);
    const spy = new SpyWorkspaces();
    spy.acquiredLease = { expectedBaseRevision: base, expectedRemoteTip: candidate };
    spy.checkedOutTip = base;
    const adapter = new FakeAdapter({ durationMs: 100 });
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'), control: port, adapter, workspaces: spy, clock: () => 0,
    });

    await orch.tick();
    expect(adapter.started).toHaveLength(0);
    expect(spy.removed).toEqual(['A']);
    expect(port.tasks.get('A')).toMatchObject({
      state: 'todo', attempts: 0, startedAt: null,
    });
    expect(port.tasks.get('A')!.expectedBaseRevision).toBeUndefined();
    expect(port.tasks.get('A')!.expectedRemoteTip).toBeUndefined();
  });

  it('annotates the task body after two consecutive untrusted-remote-tip discards', async () => {
    const base = '6'.repeat(40);
    const candidate = '7'.repeat(40);
    const spy = new SpyWorkspaces();
    spy.acquiredLease = { expectedBaseRevision: base, expectedRemoteTip: candidate };
    spy.checkedOutTip = base;
    const adapter = new FakeAdapter({ durationMs: 100 });
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'), control: port, adapter, workspaces: spy, clock: () => 0,
    });

    const r1 = await orch.tick();
    expect(r1.provisionDiscarded).toEqual(['A']);
    expect(port.tasks.get('A')!.body).not.toContain('**provision**');
    expect(adapter.started).toHaveLength(0);

    const r2 = await orch.tick();
    expect(r2.provisionDiscarded).toEqual(['A']);
    const body2 = port.tasks.get('A')!.body;
    expect(body2.match(/\*\*provision\*\*/g)).toHaveLength(1);
    expect(body2).toContain('hercules/A');
    expect(body2).toContain('delete or rename that branch');
    expect(port.tasks.get('A')).toMatchObject({
      state: 'todo', attempts: 0, startedAt: null,
    });
    expect(adapter.started).toHaveLength(0);

    const r3 = await orch.tick();
    expect(r3.provisionDiscarded).toEqual(['A']);
    expect(port.tasks.get('A')!.body).toBe(body2);
    expect(adapter.started).toHaveLength(0);
  });

  it('resets the discard counter once the task dispatches', async () => {
    const base = '6'.repeat(40);
    const candidate = '7'.repeat(40);
    const spy = new SpyWorkspaces();
    spy.acquiredLease = { expectedBaseRevision: base, expectedRemoteTip: candidate };
    spy.checkedOutTip = base;
    const adapter = new FakeAdapter({ durationMs: 100 });
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'), control: port, adapter, workspaces: spy, clock: () => 0,
    });

    await orch.tick();
    expect(adapter.started).toHaveLength(0);
    expect(port.tasks.get('A')!.body).not.toContain('**provision**');

    spy.acquiredLease = { expectedBaseRevision: base, expectedRemoteTip: null };
    spy.checkedOutTip = base;
    await orch.tick();
    expect(adapter.started).toHaveLength(1);
    expect(port.tasks.get('A')!.body).not.toContain('**provision**');
  });

  it('restarts next tick when a concurrent create pins the stale selected task to the same candidate', async () => {
    const base = '8'.repeat(40);
    const candidate = '9'.repeat(40);
    const spy = new SpyWorkspaces();
    spy.acquiredLease = { expectedBaseRevision: base, expectedRemoteTip: candidate };
    spy.checkedOutTip = base;
    const adapter = new FakeAdapter({ durationMs: 100 });
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    let pinned = false;
    spy.onCreate = () => {
      if (pinned) return;
      pinned = true;
      port.tasks.set('A', task('A', {
        expectedBaseRevision: base,
        expectedRemoteTip: candidate,
      }));
    };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'), control: port, adapter, workspaces: spy, clock: () => 0,
    });

    await orch.tick();
    expect(adapter.started).toHaveLength(0);
    expect(spy.removed).toEqual(['A']);
    expect(port.tasks.get('A')).toMatchObject({
      expectedRemoteTip: candidate, attempts: 0, startedAt: null,
    });

    spy.checkedOutTip = candidate;
    await orch.tick();
    expect(adapter.started).toHaveLength(1);
  });

  it('does not overwrite or start when the durable exact lease advances during provision', async () => {
    const base = 'a'.repeat(40);
    const selected = 'b'.repeat(40);
    const advanced = 'c'.repeat(40);
    const spy = new SpyWorkspaces();
    spy.acquiredLease = { expectedBaseRevision: base, expectedRemoteTip: selected };
    spy.checkedOutTip = selected;
    const adapter = new FakeAdapter({ durationMs: 100 });
    const port = new FakePort(new Map([['A', task('A', {
      expectedBaseRevision: base,
      expectedRemoteTip: selected,
    })]]), reposWithCaps({ app: 1 }));
    spy.onCreate = () => {
      port.tasks.set('A', task('A', {
        expectedBaseRevision: base,
        expectedRemoteTip: advanced,
      }));
    };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'), control: port, adapter, workspaces: spy, clock: () => 0,
    });

    await orch.tick();
    expect(adapter.started).toHaveLength(0);
    expect(spy.removed).toEqual(['A']);
    expect(port.tasks.get('A')).toMatchObject({
      expectedRemoteTip: advanced, attempts: 0, startedAt: null,
    });
  });

  it('cleans the provisional workspace when the lease changes after the post-provision read', async () => {
    const acquiredBase = '4'.repeat(40);
    const advancedBase = '5'.repeat(40);
    let provisioned = false;
    let returnedPostProvision = false;
    class LateLeasePort extends FakePort {
      override async read(): Promise<ControlSnapshot> {
        const snapshot = await super.read();
        if (provisioned && !returnedPostProvision) {
          returnedPostProvision = true;
          this.tasks.set('A', task('A', {
            expectedBaseRevision: advancedBase,
            expectedRemoteTip: null,
          }));
        }
        return snapshot;
      }
    }
    const spy = new SpyWorkspaces();
    spy.acquiredLease = { expectedBaseRevision: acquiredBase, expectedRemoteTip: null };
    spy.onCreate = () => { provisioned = true; };
    const adapter = new FakeAdapter({ durationMs: 100 });
    const port = new LateLeasePort(new Map([['A', task('A', {
      expectedRemoteTip: null,
    })]]), reposWithCaps({ app: 1 }));
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'), control: port, adapter, workspaces: spy, clock: () => 0,
    });

    await orch.tick();
    expect(adapter.started).toHaveLength(0);
    expect(spy.removed).toEqual(['A']);
    expect(port.tasks.get('A')).toMatchObject({
      expectedBaseRevision: advancedBase, expectedRemoteTip: null,
      attempts: 0, startedAt: null,
    });
  });

  it('fails closed before adapter start when a never-started exact workspace HEAD is wrong', async () => {
    const base = 'd'.repeat(40);
    const candidate = 'e'.repeat(40);
    const spy = new SpyWorkspaces();
    spy.acquiredLease = { expectedBaseRevision: base, expectedRemoteTip: candidate };
    spy.checkedOutTip = base;
    const adapter = new FakeAdapter({ durationMs: 100 });
    const port = new FakePort(new Map([['A', task('A', {
      expectedBaseRevision: base,
      expectedRemoteTip: candidate,
    })]]), reposWithCaps({ app: 1 }));
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'), control: port, adapter, workspaces: spy, clock: () => 0,
    });

    await orch.tick();
    expect(adapter.started).toHaveLength(0);
    expect(spy.removed).toEqual(['A']);
    expect(port.tasks.get('A')).toMatchObject({ state: 'todo', attempts: 0, startedAt: null });
  });

  it('keeps the adapter stopped when provisional workspace cleanup fails', async () => {
    const base = '1'.repeat(40);
    const candidate = '2'.repeat(40);
    const spy = new SpyWorkspaces();
    spy.acquiredLease = { expectedBaseRevision: base, expectedRemoteTip: candidate };
    spy.checkedOutTip = base;
    spy.failRemove = true;
    const adapter = new FakeAdapter({ durationMs: 100 });
    const port = new FakePort(new Map([['A', task('A', {
      expectedBaseRevision: base,
      expectedRemoteTip: candidate,
    })]]), reposWithCaps({ app: 1 }));
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'), control: port, adapter, workspaces: spy, clock: () => 0,
    });

    await orch.tick();
    expect(adapter.started).toHaveLength(0);
    expect(port.tasks.get('A')).toMatchObject({ state: 'todo', attempts: 0, startedAt: null });
  });

  it('rechecks a selected exact lease after HEAD await before LLM adapter start', async () => {
    const base = '6'.repeat(40);
    const selected = '7'.repeat(40);
    const advanced = '8'.repeat(40);
    const spy = new SpyWorkspaces();
    spy.acquiredLease = { expectedBaseRevision: base, expectedRemoteTip: selected };
    spy.checkedOutTip = selected;
    const adapter = new FakeAdapter({ durationMs: 100 });
    const original = task('A', { expectedBaseRevision: base, expectedRemoteTip: selected });
    const port = new FakePort(new Map([['A', original]]), reposWithCaps({ app: 1 }));
    spy.onWorkspaceHead = () => {
      spy.onWorkspaceHead = null;
      port.tasks.set('A', { ...original, expectedRemoteTip: advanced });
    };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'), control: port, adapter, workspaces: spy, clock: () => 0,
    });

    await orch.tick();
    expect(adapter.started).toHaveLength(0);
    expect(spy.removed).toEqual(['A']);
    expect(port.tasks.get('A')).toMatchObject({
      state: 'todo', expectedRemoteTip: advanced, startedAt: null, attempts: 0,
    });
  });

  it('rechecks a selected exact lease after HEAD await before host transition or begin', async () => {
    const base = '9'.repeat(40);
    const selected = 'a'.repeat(40);
    const advanced = 'b'.repeat(40);
    const spy = new SpyWorkspaces();
    spy.acquiredLease = { expectedBaseRevision: base, expectedRemoteTip: selected };
    spy.checkedOutTip = selected;
    const adapter = new FakeAdapter({ durationMs: 100 });
    const original = task('HOST', {
      executionClass: 'host_operation',
      hostApprovedAt: '2026-08-03T00:00:00.000Z',
      hostCommandScope: ['true'],
      expectedBaseRevision: base,
      expectedRemoteTip: selected,
    });
    const port = new FakePort(new Map([['HOST', original]]), reposWithCaps({ app: 1 }));
    spy.onWorkspaceHead = () => {
      spy.onWorkspaceHead = null;
      port.tasks.set('HOST', { ...original, expectedRemoteTip: advanced });
    };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'), control: port, adapter, workspaces: spy, clock: () => 0,
    });

    await orch.tick();
    expect(adapter.started).toHaveLength(0);
    expect(spy.removed).toEqual(['HOST']);
    expect(port.tasks.get('HOST')).toMatchObject({
      state: 'todo', expectedRemoteTip: advanced,
      startedAt: null,
    });
    expect(port.tasks.get('HOST')!.hostExecutionStartedAt ?? null).toBeNull();
  });

  it('CAS-blocks host begin when the exact lease changes inside marker transition', async () => {
    const base = 'c'.repeat(40);
    const selected = 'd'.repeat(40);
    const advanced = 'e'.repeat(40);
    const spy = new SpyWorkspaces();
    spy.acquiredLease = { expectedBaseRevision: base, expectedRemoteTip: selected };
    spy.checkedOutTip = selected;
    const original = task('HOST-CAS', {
      executionClass: 'host_operation',
      hostApprovedAt: '2026-08-03T00:00:00.000Z',
      hostCommandScope: ['true'],
      expectedBaseRevision: base,
      expectedRemoteTip: selected,
    });
    class TransitionRacePort extends FakePort {
      mutateAfterFinalValidation = false;
      override async read(): Promise<ControlSnapshot> {
        const snapshot = await super.read();
        if (this.mutateAfterFinalValidation) {
          this.mutateAfterFinalValidation = false;
          this.tasks.set('HOST-CAS', { ...original, expectedRemoteTip: advanced });
        }
        return snapshot;
      }
    }
    const port = new TransitionRacePort(
      new Map([['HOST-CAS', original]]),
      reposWithCaps({ app: 1 }),
    );
    spy.onWorkspaceHead = () => {
      spy.onWorkspaceHead = null;
      // The next read is final validation. Return A from that read, then make
      // the marker transition's own fresh read observe durable lease B.
      port.mutateAfterFinalValidation = true;
    };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      workspaces: spy,
      clock: () => 0,
    });

    await orch.tick();
    expect(spy.removed).toEqual(['HOST-CAS']);
    expect(port.tasks.get('HOST-CAS')).toMatchObject({
      state: 'todo', expectedRemoteTip: advanced, startedAt: null,
    });
    expect(port.tasks.get('HOST-CAS')!.hostExecutionStartedAt ?? null).toBeNull();
    expect(port.commits.some((message) => message.includes('todo → in_progress'))).toBe(false);
  });

  it('passes the persisted exact lease back into workspace creation after restart', async () => {
    const spy = new SpyWorkspaces();
    const expectedBaseRevision = '6'.repeat(40);
    const expectedRemoteTip = '7'.repeat(40);
    const port = new FakePort(
      new Map([
        [
          'RERUN',
          task('RERUN', {
            state: 'retrying',
            attempts: 1,
            startedAt: '2026-08-02T00:00:00.000Z',
            expectedBaseRevision,
            expectedRemoteTip,
          }),
        ],
      ]),
      reposWithCaps({ app: 1 }),
    );
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      workspaces: spy,
      clock: () => 0,
    });

    await orch.tick();

    expect(spy.createOpts).toContainEqual({
      taskId: 'RERUN',
      hadPriorWork: true,
      expectedBaseRevision,
      expectedRemoteTip,
    });
  });

  it('frames the agent prompt with the repo WORKFLOW.md body from the trusted mirror', async () => {
    const spy = new SpyWorkspaces();
    spy.workflow = [
      '---',
      'gates:',
      '  test: pnpm test',
      'protected_paths:',
      '  - src/security/**',
      '---',
      'GOLDEN RULE: never touch the security chokepoint.',
    ].join('\n');
    const adapter = new FakeAdapter({ durationMs: 100 });
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter,
      workspaces: spy,
      clock: () => 0,
    });

    await orch.tick();

    // The agent must be handed the WORKFLOW body (parsed, front matter stripped),
    // not an empty string — it frames everything the agent does.
    expect(adapter.started).toHaveLength(1);
    expect(adapter.started[0]!.prompt).toContain('GOLDEN RULE: never touch the security chokepoint.');
    // Machine-only front matter is not dumped into the prompt.
    expect(adapter.started[0]!.prompt).not.toContain('protected_paths:');
  });

  it('parks to review (no agent) when body names a protected path without force', async () => {
    const spy = new SpyWorkspaces();
    spy.workflow = [
      '---',
      'gates:',
      '  test: pnpm test',
      'protected_paths:',
      '  - core/tests/structural_guards.rs',
      '---',
      'principles',
    ].join('\n');
    const adapter = new FakeAdapter({ durationMs: 100 });
    const port = new FakePort(
      new Map([
        [
          'GUARD',
          task('GUARD', {
            body:
              '## Task\nUpdate `core/tests/structural_guards.rs`.\n\n' +
              '## Acceptance criteria\n- [ ] (mechanical) constant fixed\n',
          }),
        ],
      ]),
      reposWithCaps({ app: 1 }),
    );
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter,
      workspaces: spy,
      clock: () => 1_000,
    });

    const report = await orch.tick();

    expect(report.dispatched).toEqual([]);
    expect(adapter.started).toHaveLength(0);
    expect(spy.created).toHaveLength(0);
    const parked = port.tasks.get('GUARD')!;
    expect(parked.state).toBe('review');
    expect(parked.body).toMatch(/保护路径|Protected path \(pre-dispatch\)/);
    expect(parked.body).toContain('structural_guards');
  });

  it('dispatches when force-protected-path label is present despite mention', async () => {
    const spy = new SpyWorkspaces();
    spy.workflow = [
      '---',
      'gates:',
      '  test: pnpm test',
      'protected_paths:',
      '  - core/tests/structural_guards.rs',
      '---',
      'principles',
    ].join('\n');
    const adapter = new FakeAdapter({ durationMs: 100 });
    const port = new FakePort(
      new Map([
        [
          'FORCE',
          task('FORCE', {
            labels: ['force-protected-path'],
            body: 'Must edit `core/tests/structural_guards.rs`.\n',
          }),
        ],
      ]),
      reposWithCaps({ app: 1 }),
    );
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter,
      workspaces: spy,
      clock: () => 0,
    });

    const report = await orch.tick();
    expect(report.dispatched).toEqual(['FORCE']);
    expect(adapter.started).toHaveLength(1);
  });

  it('degrades to an unframed prompt (no crash) when WORKFLOW.md is malformed', async () => {
    const spy = new SpyWorkspaces();
    spy.workflow = 'no front matter here — invalid WORKFLOW.md';
    const adapter = new FakeAdapter({ durationMs: 100 });
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter,
      workspaces: spy,
      clock: () => 0,
    });

    const report = await orch.tick();

    // The tick survives and the task still dispatches; the prompt just lacks the
    // WORKFLOW framing. (The verify path re-parses and reports the error later.)
    expect(report.dispatched).toEqual(['A']);
    expect(adapter.started).toHaveLength(1);
    expect(adapter.started[0]!.prompt).toContain('# Task A:');
    expect(adapter.started[0]!.prompt).not.toContain('no front matter here');
  });

  it('tears down the workspace when a running task is cancelled out of band', async () => {
    const spy = new SpyWorkspaces();
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      workspaces: spy,
      clock: () => 0,
    });

    await orch.tick();
    port.tasks.set('A', { ...port.tasks.get('A')!, state: 'cancelled' });
    await orch.tick();
    expect(spy.removed).toEqual(['A']);
  });
});

describe('Orchestrator graceful cancel teardown (Plan 2a)', () => {
  function gracefulSetup(stopGraceMs: number, gracePeriodMs = 1000): {
    orch: Orchestrator;
    port: FakePort;
    adapter: FakeAdapter;
    spy: SpyWorkspaces;
    clock: { now: number };
  } {
    const spy = new SpyWorkspaces();
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const adapter = new FakeAdapter({ durationMs: 100, hang: true, stopGraceMs });
    const clock = { now: 0 };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { gracePeriodMs }),
      control: port,
      adapter,
      workspaces: spy,
      clock: () => clock.now,
    });
    return { orch, port, adapter, spy, clock };
  }

  it('cancel begins graceful teardown: SIGTERM, task enters stopping, workspace kept until exit', async () => {
    const { orch, port, adapter, spy } = gracefulSetup(50);
    await orch.tick(); // dispatch A, tracked + in_progress
    port.tasks.set('A', { ...port.tasks.get('A')!, state: 'cancelled' });

    const report = await orch.tick();
    expect(orch.stopping).toContain('A');
    expect(orch.running).not.toContain('A');
    expect(adapter.stopped).toContainEqual({ id: 'A', force: false });
    expect(spy.removed).toEqual([]); // workspace not removed yet
    expect(report.tornDown).toEqual(['A']);
  });

  it('finalizes once the agent exits within the grace window', async () => {
    const { orch, port, spy, clock } = gracefulSetup(50);
    await orch.tick(); // dispatch at t=0
    port.tasks.set('A', { ...port.tasks.get('A')!, state: 'cancelled' });
    await orch.tick(); // begin stopping (stop anchored at now=0)

    clock.now = 60; // past stopGraceMs(50) but before deadline(1000)
    const report = await orch.tick(); // sweep sees exited → finalize
    expect(orch.stopping).not.toContain('A');
    expect(spy.removed).toEqual(['A']);
    expect(report.tornDown).toEqual(['A']);
  });

  it('force-kills a hung agent at the deadline', async () => {
    const { orch, port, adapter, spy, clock } = gracefulSetup(1_000_000);
    await orch.tick(); // dispatch at t=0
    port.tasks.set('A', { ...port.tasks.get('A')!, state: 'cancelled' });
    await orch.tick(); // begin stopping, deadline = 0 + 1000

    clock.now = 1000; // at deadline, still running (huge stopGraceMs)
    const report = await orch.tick();
    expect(adapter.stopped).toContainEqual({ id: 'A', force: true });
    expect(orch.stopping).not.toContain('A');
    expect(spy.removed).toEqual(['A']);
    expect(report.tornDown).toEqual(['A']);
  });

  it('forceAbort escalates immediately', async () => {
    const { orch, port, adapter, spy } = gracefulSetup(1_000_000);
    await orch.tick(); // dispatch at t=0
    port.tasks.set('A', { ...port.tasks.get('A')!, state: 'cancelled' });
    await orch.tick(); // begin stopping (within grace)

    orch.forceAbort('A');
    expect(adapter.stopped).toContainEqual({ id: 'A', force: true });

    await orch.tick(); // next sweep sees the run exited → finalize
    expect(orch.stopping).not.toContain('A');
    expect(spy.removed).toEqual(['A']);
  });

  it('exposes stopping in the runtime view', async () => {
    const { orch, port } = gracefulSetup(50);
    await orch.tick();
    port.tasks.set('A', { ...port.tasks.get('A')!, state: 'cancelled' });
    await orch.tick();
    expect(orch.getState().stopping).toContain('A');
  });

  it('switch-now (retrying while live) stops agent but preserves worktree', async () => {
    const { orch, port, adapter, spy, clock } = gracefulSetup(50);
    await orch.tick(); // dispatch A
    // Simulate setTaskAdapter(..., { switchNow: true })
    port.tasks.set('A', {
      ...port.tasks.get('A')!,
      state: 'retrying',
      adapter: 'codex',
      agentSession: null,
    });
    const report = await orch.tick();
    expect(orch.stopping).toContain('A');
    expect(adapter.stopped).toContainEqual({ id: 'A', force: false });
    expect(spy.removed).toEqual([]);
    expect(report.tornDown).toEqual(['A']);

    clock.now = 60;
    await orch.tick(); // finalize stop without discard
    expect(orch.stopping).not.toContain('A');
    expect(spy.removed).toEqual([]); // worktree kept for re-dispatch
    expect(port.tasks.get('A')!.body).toMatch(/Switch stop|switch/i);
  });

  it('writes a graceful teardown report when the agent exits within grace', async () => {
    const { orch, port, spy, clock } = gracefulSetup(50);
    await orch.tick(); // dispatch at t=0
    port.tasks.set('A', { ...port.tasks.get('A')!, state: 'cancelled' });
    await orch.tick(); // begin stopping

    clock.now = 60; // past stopGraceMs(50), before deadline(1000)
    await orch.tick(); // sweep sees exited → finalize + report

    // inspect is called BEFORE remove (so the impact reflects the live worktree).
    expect(spy.inspected).toEqual(['A']);
    const a = port.tasks.get('A')!;
    expect(a.body).toMatch(/## Teardown/);
    expect(a.body).toMatch(/SIGTERM/);
    expect(a.body).not.toMatch(/SIGKILL/);
    expect(port.commits.some((m) => m === 'hercules: A teardown report')).toBe(true);
  });

  it('writes a forced teardown report when force-aborted', async () => {
    const { orch, port } = gracefulSetup(1_000_000);
    await orch.tick(); // dispatch at t=0
    port.tasks.set('A', { ...port.tasks.get('A')!, state: 'cancelled' });
    await orch.tick(); // begin stopping (within grace)

    orch.forceAbort('A');
    await orch.tick(); // sweep sees the run exited → finalize + report

    const a = port.tasks.get('A')!;
    expect(a.body).toMatch(/## Teardown/);
    expect(a.body).toMatch(/SIGKILL/);
  });

  it('writes a forced teardown report when the deadline force-kills a hung agent', async () => {
    const { orch, port, clock } = gracefulSetup(1_000_000);
    await orch.tick(); // dispatch at t=0
    port.tasks.set('A', { ...port.tasks.get('A')!, state: 'cancelled' });
    await orch.tick(); // begin stopping, deadline = 1000

    clock.now = 1000; // at deadline, still running → SIGKILL
    await orch.tick();

    const a = port.tasks.get('A')!;
    expect(a.body).toMatch(/## Teardown/);
    expect(a.body).toMatch(/SIGKILL/);
  });
});

describe('Orchestrator host cancel — receipt + settlement before teardown', () => {
  /**
   * Workspaces that record remove/inspect order relative to body receipt writes.
   * Host cancel must settle the executor (receipt ready) before remove.
   */
  class OrderedHostWorkspaces extends TempDirWorkspaces {
    readonly order: string[] = [];
    constructor(root: string) {
      super(root);
    }
    override async inspect(taskId: string): Promise<WorkspaceImpact | null> {
      this.order.push(`inspect:${taskId}`);
      return { changedFiles: 0, localCommits: 0, pushedRemote: false };
    }
    override async remove(taskId: string): Promise<void> {
      this.order.push(`remove:${taskId}`);
    }
  }

  async function hostCancelSetup(opts: {
    readonly gracePeriodMs?: number;
    readonly scope?: readonly string[];
    /** When true, write a SIGTERM-ignoring hang script so deadline force is real. */
    readonly ignoreSigterm?: boolean;
  }): Promise<{
    orch: Orchestrator;
    port: FakePort;
    clock: { now: number };
    ws: OrderedHostWorkspaces;
    root: string;
  }> {
    const { mkdtemp, writeFile, chmod } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'hercules-host-cancel-'));
    const ws = new OrderedHostWorkspaces(root);
    let scope = opts.scope ?? ['sleep 60'];
    if (opts.ignoreSigterm === true) {
      // Hang that ignores SIGTERM so only SIGKILL (deadline/force) ends it.
      const hang = join(root, 'hang-ignore-term');
      await writeFile(
        hang,
        '#!/usr/bin/env node\n' +
          "process.on('SIGTERM', () => {});\n" +
          'setInterval(() => {}, 1000);\n',
      );
      await chmod(hang, 0o755);
      scope = [hang];
    }
    const port = new FakePort(
      new Map([
        [
          'HOST',
          task('HOST', {
            executionClass: 'host_operation',
            adapter: 'grok',
            hostCommandScope: [...scope],
            hostApprovedAt: '2026-07-31T06:00:00.000Z',
          }),
        ],
      ]),
      reposWithCaps({ app: 1 }),
    );
    const adapter = new FakeAdapter({ durationMs: 10, hang: true });
    const clock = { now: 0 };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { gracePeriodMs: opts.gracePeriodMs ?? 5_000 }),
      control: port,
      agents: new AgentRegistry({ grok: adapter }, 'grok'),
      workspaces: ws,
      clock: () => clock.now,
    });
    return { orch, port, clock, ws, root };
  }

  async function waitHostStoppingSettled(
    orch: Orchestrator,
    port: FakePort,
    clock: { now: number },
    opts?: { readonly forceAt?: 'abort' | 'deadline' },
  ): Promise<void> {
    // Cancel on disk + begin stopping.
    port.tasks.set('HOST', { ...port.tasks.get('HOST')!, state: 'cancelled' });
    await orch.tick();
    // Same-tick settle is rare but allowed (SIGTERM can finish before sweep returns).
    const alreadyDone = !orch.stopping.includes('HOST');

    if (!alreadyDone && opts?.forceAt === 'abort') {
      orch.forceAbort('HOST');
    } else if (!alreadyDone && opts?.forceAt === 'deadline') {
      clock.now = 10_000; // past gracePeriodMs
    }

    // Poll until stopping clears (settlement + teardown).
    for (let i = 0; i < 80; i += 1) {
      if (!orch.stopping.includes('HOST')) break;
      // Advance clock a little so deadline path can fire if needed.
      if (opts?.forceAt === 'deadline') clock.now += 100;
      else clock.now += 50;
      await orch.tick();
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  it('graceful cancel persists exactly one full receipt and teardowns after settlement', async () => {
    const { rm } = await import('node:fs/promises');
    const { orch, port, clock, ws, root } = await hostCancelSetup({});
    try {
      await orch.tick(); // dispatch host-executor sleep
      expect(port.tasks.get('HOST')!.state).toBe('in_progress');
      // Let sleep spawn.
      await new Promise((r) => setTimeout(r, 80));

      await waitHostStoppingSettled(orch, port, clock);

      expect(orch.stopping).not.toContain('HOST');
      expect(ws.order).toContain('inspect:HOST');
      expect(ws.order).toContain('remove:HOST');
      // inspect before remove
      expect(ws.order.indexOf('inspect:HOST')).toBeLessThan(ws.order.indexOf('remove:HOST'));

      const body = port.tasks.get('HOST')!.body;
      expect(body.match(/## Host operation receipt/g)).toHaveLength(1);
      const receipt = (await import('../../src/domain/executionClass.js')).parseHostOperationReceipt(
        body,
      );
      expect(receipt).not.toBeNull();
      expect(receipt!.commandScope).toEqual(['sleep 60']);
      expect(receipt!.outcome).not.toBe('success');
      // Full receipt not truncated to a short generic line.
      expect(body).toContain('**Command scope:**');
      expect(body).toContain('**Outcome:**');
      expect(body).toContain('**Post-check evidence:**');
      expect(body).toMatch(/## Teardown/);
      // Receipt appears before teardown audit.
      expect(body.indexOf('## Host operation receipt')).toBeLessThan(body.indexOf('## Teardown'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('deadline-force cancel persists exactly one full receipt after settlement', async () => {
    const { rm } = await import('node:fs/promises');
    // SIGTERM-ignoring hang + short grace → deadline SIGKILL path is real.
    const { orch, port, clock, ws, root } = await hostCancelSetup({
      gracePeriodMs: 50,
      ignoreSigterm: true,
    });
    try {
      await orch.tick();
      await new Promise((r) => setTimeout(r, 80));
      await waitHostStoppingSettled(orch, port, clock, { forceAt: 'deadline' });

      expect(orch.stopping).not.toContain('HOST');
      expect(ws.order).toContain('remove:HOST');
      const body = port.tasks.get('HOST')!.body;
      expect(body.match(/## Host operation receipt/g)).toHaveLength(1);
      expect(body).toMatch(/## Teardown/);
      expect(body).toMatch(/SIGKILL|forced/i);
      const receipt = (await import('../../src/domain/executionClass.js')).parseHostOperationReceipt(
        body,
      );
      expect(receipt).not.toBeNull();
      expect(receipt!.commandScope).toHaveLength(1);
      expect(receipt!.outcome).not.toBe('success');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('force-abort cancel persists exactly one full receipt after settlement', async () => {
    const { rm } = await import('node:fs/promises');
    const { orch, port, clock, ws, root } = await hostCancelSetup({
      gracePeriodMs: 60_000,
      ignoreSigterm: true,
    });
    try {
      await orch.tick();
      await new Promise((r) => setTimeout(r, 80));
      await waitHostStoppingSettled(orch, port, clock, { forceAt: 'abort' });

      expect(orch.stopping).not.toContain('HOST');
      expect(ws.order).toContain('remove:HOST');
      const body = port.tasks.get('HOST')!.body;
      expect(body.match(/## Host operation receipt/g)).toHaveLength(1);
      expect(body).toMatch(/## Teardown/);
      const receipt = (await import('../../src/domain/executionClass.js')).parseHostOperationReceipt(
        body,
      );
      expect(receipt).not.toBeNull();
      expect(receipt!.commandScope).toHaveLength(1);
      expect(receipt!.outcome).not.toBe('success');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('max allowed command scope failure persists one untruncated receipt with all scope items', async () => {
    const { rm } = await import('node:fs/promises');
    const { MAX_HOST_COMMAND_SCOPE } = await import('../../src/domain/executionClass.js');
    const { parseHostOperationReceipt } = await import('../../src/domain/executionClass.js');
    // Distinct literals up to max; fail in the middle so later commands do not run.
    const failAt = 3;
    const scope = Array.from({ length: MAX_HOST_COMMAND_SCOPE }, (_, i) =>
      i === failAt ? 'false' : `echo cmd${i}`,
    );
    const { orch, port, clock, root } = await hostCancelSetup({ scope });
    try {
      await orch.tick(); // dispatch
      // Wait for host chain to fail on `false`.
      for (let i = 0; i < 40; i += 1) {
        clock.now += 100;
        const report = await orch.tick();
        if (report.failed.includes('HOST') || port.tasks.get('HOST')!.state === 'failed') break;
        await new Promise((r) => setTimeout(r, 40));
      }
      const body = port.tasks.get('HOST')!.body;
      expect(body.match(/## Host operation receipt/g)).toHaveLength(1);
      const receipt = parseHostOperationReceipt(body);
      expect(receipt).not.toBeNull();
      // Every approved scope item is listed even though later commands did not run.
      expect(receipt!.commandScope).toEqual(scope);
      expect(receipt!.commandScope).toHaveLength(MAX_HOST_COMMAND_SCOPE);
      for (const cmd of scope) {
        expect(body).toContain(cmd);
      }
      expect(receipt!.outcome).not.toBe('success');
      // Evidence mentions the failed command; later echo commands should not have run.
      expect(receipt!.postCheckEvidence.toLowerCase()).toMatch(/fail|stopped|exit/);
      // Activity: starts only up through the failure (failAt is 0-based → failAt+1 starts).
      // Body receipt is authoritative for scope completeness.
      expect(port.tasks.get('HOST')!.state).toBe('failed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Orchestrator verification on done (SPEC §9)', () => {
  it('runs the verifier and attaches the review packet to the task body', async () => {
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    let gotActivity: readonly string[] | undefined;
    let gotReport: string | undefined;
    const verifier = {
      verify: async (
        _t: Task,
        _r: RepoConfig,
        _w: Workspace,
        activityLogOrOpts?:
          | readonly string[]
          | {
              activityLog?: readonly string[];
              finalReport?: string;
              runKind?: string;
            },
        _usage?: import('../../src/domain/verification.js').PacketUsage,
        finalReportArg?: string,
      ): Promise<import('../../src/domain/verification.js').ReviewPacket> => {
        let activityLog: readonly string[] | undefined;
        let finalReport: string | undefined;
        if (activityLogOrOpts !== undefined && Array.isArray(activityLogOrOpts)) {
          activityLog = activityLogOrOpts;
          finalReport = finalReportArg;
        } else if (activityLogOrOpts !== undefined && typeof activityLogOrOpts === 'object') {
          const bag = activityLogOrOpts as {
            activityLog?: readonly string[];
            finalReport?: string;
          };
          activityLog = bag.activityLog;
          finalReport = bag.finalReport;
        }
        gotActivity = activityLog;
        gotReport = finalReport;
        return {
          taskId: 'A', branch: 'hercules/A', filesTouched: ['src/x.ts'], diffSummary: '1 file', diff: '+x',
          gates: [{ name: 'test', command: 'pnpm test', passed: true, output: '' }],
          cheatFindings: [], screenshots: [], reviewerVerdict: { approved: true, summary: 'ok', comments: [] },
          selfAssessment: 'done', finalReport: '', green: true, noChanges: false, autoRework: false,
          reportPolluted: false,
          dod: {
            mechanical: 'pass', reviewer: 'pass', human: 'pending', criteria: [], warnings: [],
          },
          activityLog: activityLog ?? [],
          ...PACKET_EXTRA,
        };
      },
    };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      // The agent reveals one activity line per second; at done it has a tail.
      adapter: new FakeAdapter({
        durationMs: 100,
        activity: ['Edit src/x.ts', 'Bash: pnpm test'],
        finalMessage: '# Result\n\nThe agent did the thing.',
      }),
      verifier,
      clock: () => clock.now,
    });

    await orch.tick();
    clock.now = 100;
    await orch.tick();

    const a = port.tasks.get('A')!;
    expect(a.state).toBe('review');
    expect(a.body).toContain('## Review packet');
    expect(a.body).toContain('hercules/A');
    // End-to-end: the agent's FULL activity transcript reached the verifier/packet
    // (both lines — activityLog(), not the time-revealed live tail).
    expect(gotActivity).toEqual(['Edit src/x.ts', 'Bash: pnpm test']);
    // End-to-end: the agent's final report (finalMessage()) reached the verifier.
    expect(gotReport).toBe('# Result\n\nThe agent did the thing.');
    // The verified worktree HEAD is persisted so approve can hold the tip to it.
    expect(a.verifiedSha).toBe('cafe1234cafe1234cafe1234cafe1234cafe1234');
    // C3.28: packetNonce matches the body's header fence.
    expect(a.packetNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(a.body).toContain(`<!-- hercules:packet v1 nonce=${a.packetNonce} -->`);
  });

  it('queued chat merges into next auto-rework once and does not survive a later green run', async () => {
    // Live regression (1): one snapshot fold into the immediate finalize outcome;
    // queue must be empty afterward so a subsequent green run cannot re-apply it.
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    let phase: 'l3' | 'green' = 'l3';
    const verifier = {
      verify: async (): Promise<import('../../src/domain/verification.js').ReviewPacket> => {
        if (phase === 'l3') {
          return {
            taskId: 'A',
            branch: 'hercules/A',
            filesTouched: ['src/x.ts'],
            diffSummary: '1 file',
            diff: '+x',
            gates: [
              {
                name: 'test',
                command: 'pnpm test',
                passed: false,
                output:
                  'FAIL test/domain/chatDelivery.test.ts\n' +
                  '  × decideChatIdempotency\n' +
                  'AssertionError: expected duplicate\n' +
                  'full L1 gate output must stay in the review packet',
              },
            ],
            cheatFindings: [],
            screenshots: [],
            reviewerVerdict: {
              approved: false,
              summary: 'L1 failed',
              comments: ['fix the failing unit test'],
            },
            selfAssessment: 'pass',
            finalReport: 'did stuff',
            green: false,
            noChanges: false,
            autoRework: true,
            reportPolluted: false,
            dod: {
              mechanical: 'fail',
              reviewer: 'fail',
              human: 'pending',
              criteria: [],
              warnings: [],
            },
            activityLog: [],
            ...PACKET_EXTRA,
            reworkPath: 'full',
            reworkPathReason: 'L1 gate failure — full re-dispatch',
          };
        }
        return {
          taskId: 'A',
          branch: 'hercules/A',
          filesTouched: ['src/x.ts'],
          diffSummary: '1 file',
          diff: '+x',
          gates: [{ name: 'test', command: 'pnpm test', passed: true, output: 'ok' }],
          cheatFindings: [],
          screenshots: [],
          reviewerVerdict: { approved: true, summary: 'ok', comments: [] },
          selfAssessment: 'done',
          finalReport: 'fixed',
          green: true,
          noChanges: false,
          autoRework: false,
          reportPolluted: false,
          dod: {
            mechanical: 'pass',
            reviewer: 'pass',
            human: 'pending',
            criteria: [],
            warnings: [],
          },
          activityLog: [],
          ...PACKET_EXTRA,
        };
      },
    };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { maxAttempts: 5, backoffBaseMs: 1 }),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      verifier,
      clock: () => clock.now,
    });

    await orch.tick();
    orch.queueTaskChat('A', 'operator note once', { clientMessageId: 'once-1' });
    clock.now = 100;
    const rework = await orch.tick();
    expect(rework.retried).toContain('A');
    const afterRework = port.tasks.get('A')!;
    expect(afterRework.state).toBe('retrying');
    expect(afterRework.body).toContain('operator note once');
    expect(afterRework.body).toContain('client-message-id: once-1');
    expect(orch.getTaskChatQueue('A')).toEqual([]);

    // Second run goes green with no new queue — message must not reappear as a second fold.
    phase = 'green';
    clock.now = 200;
    await orch.tick(); // dispatch retrying
    clock.now = 300;
    const green = await orch.tick(); // complete green
    expect(green.completed).toContain('A');
    expect(orch.getTaskChatQueue('A')).toEqual([]);
    const finalBody = port.tasks.get('A')!.body;
    expect(finalBody.match(/operator note once/g)?.length ?? 0).toBe(1);
  });

  function greenVerifier(): {
    verify: () => Promise<import('../../src/domain/verification.js').ReviewPacket>;
  } {
    return {
      verify: async () => ({
        taskId: 'A',
        branch: 'hercules/A',
        filesTouched: ['src/x.ts'],
        diffSummary: '1 file',
        diff: '+x',
        gates: [{ name: 'test', command: 'pnpm test', passed: true, output: '' }],
        cheatFindings: [],
        screenshots: [],
        reviewerVerdict: { approved: true, summary: 'ok', comments: [] },
        selfAssessment: 'done',
        finalReport: '',
        green: true,
        noChanges: false,
        autoRework: false,
        reportPolluted: false,
        dod: {
          mechanical: 'pass',
          reviewer: 'pass',
          human: 'pending',
          criteria: [],
          warnings: [],
        },
        activityLog: [],
        ...PACKET_EXTRA,
      }),
    };
  }

  it('commit throw keeps queue; recovery folds exactly once', async () => {
    class ThrowCommitPort extends FakePort {
      failCommit = false;
      override async commit(message: string): Promise<{ committed: boolean }> {
        if (this.failCommit) throw new Error('injected commit throw');
        return super.commit(message);
      }
    }
    const port = new ThrowCommitPort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { backoffBaseMs: 1 }),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100, finalMessage: 'done' }),
      verifier: greenVerifier(),
      clock: () => clock.now,
    });

    await orch.tick();
    expect(orch.queueTaskChat('A', 'must survive commit fail', { clientMessageId: 'surv-1' }).mode).toBe(
      'queued',
    );
    port.failCommit = true;
    clock.now = 100;
    await orch.tick();
    // Unconditional: queue retained, not acked as delivered.
    expect(orch.getTaskChatQueue('A')).toEqual(['must survive commit fail']);
    expect(orch.getState().pendingChat['A']).toEqual(['must survive commit fail']);

    // Recovery: allow commits; re-dispatch if untracked and complete successfully.
    port.failCommit = false;
    const disk = port.tasks.get('A')!;
    if (disk.state === 'in_progress' || disk.state === 'failed') {
      await port.writeTask({
        ...disk,
        state: 'retrying',
        pendingSteer: null,
        lastEventAt: null,
        endedAt: new Date(clock.now).toISOString(),
      });
    }
    clock.now = 200;
    await orch.tick(); // dispatch
    // The post-failure sweep durably folds before re-dispatch.
    expect(orch.getTaskChatQueue('A')).toEqual([]);
    clock.now = 300;
    await orch.tick(); // complete → fold once
    expect(orch.getTaskChatQueue('A')).toEqual([]);
    const body = port.tasks.get('A')!.body;
    expect(body).toContain('must survive commit fail');
    expect(body).toContain('client-message-id: surv-1');
    expect(body.match(/must survive commit fail/g)?.length ?? 0).toBe(1);
  });

  it('complete() throw park durably folds mid-run queued chat onto task body', async () => {
    // L3 regression: complete() outer catch parked failed with timestamps only —
    // mid-run notes stayed in memory. Park path must fold before clearing the run.
    class ThrowWritePort extends FakePort {
      /** Fail the next N writeTask calls (simulate complete fold blow-up). */
      failNextWrites = 0;
      override async writeTask(t: Task): Promise<void> {
        if (this.failNextWrites > 0) {
          this.failNextWrites -= 1;
          throw new Error('injected writeTask throw during complete');
        }
        return super.writeTask(t);
      }
    }
    const port = new ThrowWritePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { backoffBaseMs: 1 }),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100, finalMessage: 'done' }),
      verifier: greenVerifier(),
      clock: () => clock.now,
    });

    await orch.tick();
    expect(
      orch.queueTaskChat('A', 'complete-throw operator note', {
        clientMessageId: 'complete-throw-1',
      }).mode,
    ).toBe('queued');
    // Blow up the complete() durable write once; outer park must still fold.
    port.failNextWrites = 1;
    clock.now = 100;
    const report = await orch.tick(); // complete throws → outer park
    expect(report.failed).toContain('A');
    // Park must have folded durably (and acked) so restart cannot lose the note.
    expect(orch.getTaskChatQueue('A')).toEqual([]);
    const after = port.tasks.get('A')!;
    expect(after.state).toBe('failed');
    expect(after.body).toContain('complete-throw operator note');
    expect(after.body).toContain('client-message-id: complete-throw-1');
  });

  it('legacy no-id commit throw recovery does not double-append queue text', async () => {
    // Partial writeTask + commit throw leaves Human steer on body; recovery must
    // be exactly-once for callers without clientMessageId (delivery-instance id).
    class ThrowCommitPort extends FakePort {
      failCommit = false;
      override async commit(message: string): Promise<{ committed: boolean }> {
        if (this.failCommit) throw new Error('injected commit throw');
        return super.commit(message);
      }
    }
    const port = new ThrowCommitPort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { backoffBaseMs: 1 }),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100, finalMessage: 'done' }),
      verifier: greenVerifier(),
      clock: () => clock.now,
    });

    await orch.tick();
    // No clientMessageId — legacy path.
    expect(orch.queueTaskChat('A', 'legacy must appear once').mode).toBe('queued');
    port.failCommit = true;
    clock.now = 100;
    await orch.tick();
    expect(orch.getTaskChatQueue('A')).toEqual(['legacy must appear once']);
    // Partial write may already have the section on disk/body.
    const afterFail = port.tasks.get('A')!;
    const partialCount = afterFail.body.match(/legacy must appear once/g)?.length ?? 0;
    expect(partialCount).toBeLessThanOrEqual(1);

    port.failCommit = false;
    const disk = port.tasks.get('A')!;
    if (disk.state === 'in_progress' || disk.state === 'failed') {
      await port.writeTask({
        ...disk,
        state: 'retrying',
        pendingSteer: null,
        lastEventAt: null,
        endedAt: new Date(clock.now).toISOString(),
      });
    }
    clock.now = 200;
    await orch.tick();
    expect(orch.getTaskChatQueue('A')).toEqual([]);
    clock.now = 300;
    await orch.tick();
    expect(orch.getTaskChatQueue('A')).toEqual([]);
    const body = port.tasks.get('A')!.body;
    expect(body).toContain('legacy must appear once');
    expect(body).toContain('chat-delivery-id:');
    expect(body.match(/legacy must appear once/g)?.length ?? 0).toBe(1);
    expect(body.match(/## Human steer/g)?.length ?? 0).toBe(1);
  });

  it('commit committed:false keeps queue; recovery folds exactly once', async () => {
    class FalseCommitPort extends FakePort {
      returnFalse = false;
      override async commit(message: string): Promise<{ committed: boolean }> {
        if (this.returnFalse) return { committed: false };
        return super.commit(message);
      }
    }
    const port = new FalseCommitPort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { backoffBaseMs: 1 }),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100, finalMessage: 'done' }),
      verifier: greenVerifier(),
      clock: () => clock.now,
    });

    await orch.tick();
    orch.queueTaskChat('A', 'false-commit note', { clientMessageId: 'fc-1' });
    port.returnFalse = true;
    clock.now = 100;
    await orch.tick();
    expect(orch.getTaskChatQueue('A')).toEqual(['false-commit note']);

    port.returnFalse = false;
    const disk = port.tasks.get('A')!;
    if (disk.state === 'in_progress' || disk.state === 'failed') {
      await port.writeTask({
        ...disk,
        state: 'retrying',
        pendingSteer: null,
        lastEventAt: null,
        endedAt: new Date(clock.now).toISOString(),
      });
    }
    clock.now = 200;
    await orch.tick();
    expect(orch.getTaskChatQueue('A')).toEqual([]);
    clock.now = 300;
    await orch.tick();
    expect(orch.getTaskChatQueue('A')).toEqual([]);
    const body = port.tasks.get('A')!.body;
    expect(body).toContain('false-commit note');
    expect(body.match(/false-commit note/g)?.length ?? 0).toBe(1);
  });

  it('legacy no-id committed:false recovery does not double-append queue text', async () => {
    class FalseCommitPort extends FakePort {
      returnFalse = false;
      override async commit(message: string): Promise<{ committed: boolean }> {
        if (this.returnFalse) return { committed: false };
        return super.commit(message);
      }
    }
    const port = new FalseCommitPort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { backoffBaseMs: 1 }),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100, finalMessage: 'done' }),
      verifier: greenVerifier(),
      clock: () => clock.now,
    });

    await orch.tick();
    orch.queueTaskChat('A', 'legacy false-commit once');
    port.returnFalse = true;
    clock.now = 100;
    await orch.tick();
    expect(orch.getTaskChatQueue('A')).toEqual(['legacy false-commit once']);

    port.returnFalse = false;
    const disk = port.tasks.get('A')!;
    if (disk.state === 'in_progress' || disk.state === 'failed') {
      await port.writeTask({
        ...disk,
        state: 'retrying',
        pendingSteer: null,
        lastEventAt: null,
        endedAt: new Date(clock.now).toISOString(),
      });
    }
    clock.now = 200;
    await orch.tick();
    clock.now = 300;
    await orch.tick();
    expect(orch.getTaskChatQueue('A')).toEqual([]);
    const body = port.tasks.get('A')!.body;
    expect(body).toContain('legacy false-commit once');
    expect(body).toContain('chat-delivery-id:');
    expect(body.match(/legacy false-commit once/g)?.length ?? 0).toBe(1);
  });

  it('transition missing-task does not ack queued chat', async () => {
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100, finalMessage: 'done' }),
      verifier: greenVerifier(),
      clock: () => clock.now,
    });
    await orch.tick();
    orch.queueTaskChat('A', 'orphan note', { clientMessageId: 'or-1' });
    // Delete task from control mid-run so finalize transition is a no-op.
    port.tasks.delete('A');
    clock.now = 100;
    await orch.tick();
    // Queue must not be acked when transition skips (task gone).
    expect(orch.getTaskChatQueue('A')).toEqual(['orphan note']);
  });

  it('agent-exit rework folds mid-run queue into retrying body + pendingSteer', async () => {
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { maxAttempts: 5, backoffBaseMs: 1 }),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100, fail: true }),
      clock: () => clock.now,
    });
    await orch.tick();
    orch.queueTaskChat('A', 'note before agent death', { clientMessageId: 'death-1' });
    clock.now = 100;
    const report = await orch.tick();
    expect(report.failed.length + report.retried.length).toBeGreaterThan(0);
    expect(orch.getTaskChatQueue('A')).toEqual([]);
    const a = port.tasks.get('A')!;
    expect(a.body).toContain('note before agent death');
    if (a.state === 'retrying') {
      expect(a.pendingSteer).toContain('note before agent death');
    }
  });

  it('concurrent enqueue during finalize is preserved after snapshot ack', async () => {
    class ConcurrentPort extends FakePort {
      onBeforeCommit: (() => void) | null = null;
      override async commit(message: string): Promise<{ committed: boolean }> {
        this.onBeforeCommit?.();
        return super.commit(message);
      }
    }
    const port = new ConcurrentPort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    const verifier = {
      verify: async (): Promise<import('../../src/domain/verification.js').ReviewPacket> => ({
        taskId: 'A',
        branch: 'hercules/A',
        filesTouched: ['src/x.ts'],
        diffSummary: '1 file',
        diff: '+x',
        gates: [{ name: 'test', command: 'pnpm test', passed: true, output: '' }],
        cheatFindings: [],
        screenshots: [],
        reviewerVerdict: { approved: true, summary: 'ok', comments: [] },
        selfAssessment: 'done',
        finalReport: '',
        green: true,
        noChanges: false,
        autoRework: false,
        reportPolluted: false,
        dod: {
          mechanical: 'pass',
          reviewer: 'pass',
          human: 'pending',
          criteria: [],
          warnings: [],
        },
        activityLog: [],
        ...PACKET_EXTRA,
      }),
    };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100, finalMessage: 'done' }),
      verifier,
      clock: () => clock.now,
    });

    await orch.tick();
    orch.queueTaskChat('A', 'snapshotted first', { clientMessageId: 'snap-1' });
    // During the finalize commit, a concurrent mid-run chat arrives.
    port.onBeforeCommit = () => {
      orch.queueTaskChat('A', 'concurrent later', { clientMessageId: 'snap-2' });
      port.onBeforeCommit = null;
    };
    clock.now = 100;
    await orch.tick();

    const a = port.tasks.get('A')!;
    // First message folded into the rework/review outcome.
    expect(a.body).toContain('snapshotted first');
    // The later entry was not acked with the first snapshot; the unowned-queue
    // sweep then persisted and acknowledged it as the next continuation.
    expect(orch.getTaskChatQueue('A')).toEqual([]);
    expect(a.body).toContain('concurrent later');
    expect(a.pendingSteer).toContain('concurrent later');
  });

  it('durably delivers chat enqueued during an empty green-finalize commit', async () => {
    class ConcurrentGreenPort extends FakePort {
      onBeforeCommit: (() => void) | null = null;
      override async commit(message: string): Promise<{ committed: boolean }> {
        this.onBeforeCommit?.();
        return super.commit(message);
      }
    }
    const port = new ConcurrentGreenPort(
      new Map([['A', task('A')]]),
      reposWithCaps({ app: 1 }),
    );
    const clock = { now: 0 };
    const adapter = new FakeAdapter({ durationMs: 100 });
    let verifyCalls = 0;
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter,
      verifier: {
        verify: async () => {
          verifyCalls += 1;
          return await greenVerifier().verify();
        },
      },
      clock: () => clock.now,
    });

    await orch.tick();
    port.onBeforeCommit = () => {
      port.onBeforeCommit = null;
      orch.queueTaskChat('A', 'arrived inside green commit', {
        clientMessageId: 'green-commit-late-1',
      });
    };
    clock.now = 100;
    const report = await orch.tick();

    expect(verifyCalls).toBe(1);
    expect(report.retried).toContain('A');
    expect(report.completed).not.toContain('A');
    expect(report.retried.filter((id) => id === 'A')).toHaveLength(1);
    expect(adapter.started).toHaveLength(2);
    expect(adapter.started[1]!.prompt.match(/arrived inside green commit/g)).toHaveLength(1);
    expect(orch.getTaskChatQueue('A')).toEqual([]);
    const continued = port.tasks.get('A')!;
    expect(continued.state).toBe('in_progress');
    expect(continued.pendingSteer).toBeNull();
    expect(continued.verifiedSha).toBeNull();
    // C3.28: packetNonce cleared when a new run starts without a fresh packet.
    expect(continued.packetNonce ?? null).toBeNull();
    expect(continued.body.match(/arrived inside green commit/g)).toHaveLength(1);
    expect(continued.body).toContain('client-message-id: green-commit-late-1');
  });

  it('L3 auto-rework keeps short queued phrase when auto-steer merely contains it', async () => {
    // Substring suppression regression: auto-steer text may mention a short
    // operator phrase without being the same whole message — pendingSteer for
    // the next prompt must still carry the Remote Control section.
    const port = new FakePort(
      new Map([['A', { ...task('A'), agentSession: 'sess-live' }]]),
      reposWithCaps({ app: 1 }),
    );
    const clock = { now: 0 };
    const verifier = {
      verify: async (): Promise<import('../../src/domain/verification.js').ReviewPacket> => ({
        taskId: 'A',
        branch: 'hercules/A',
        filesTouched: ['src/x.ts'],
        diffSummary: '1 file',
        diff: '+x',
        gates: [{ name: 'test', command: 'pnpm test', passed: true, output: '' }],
        cheatFindings: [],
        screenshots: [],
        reviewerVerdict: {
          approved: false,
          summary: 'changes requested',
          comments: ['Fix the flaky assert about the race in chatDelivery'],
        },
        selfAssessment: 'pass',
        finalReport: 'did stuff',
        green: false,
        noChanges: false,
        autoRework: true,
        reportPolluted: false,
        dod: {
          mechanical: 'pass',
          reviewer: 'fail',
          human: 'pending',
          criteria: [],
          warnings: [],
        },
        activityLog: [],
        ...PACKET_EXTRA,
        reworkPath: 'steer',
        reworkPathReason: 'comment/polish L3 on small diff',
      }),
    };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { maxAttempts: 3, backoffBaseMs: 1 }),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      verifier,
      clock: () => clock.now,
    });

    await orch.tick();
    // Short phrase that will also appear inside the L3 auto-steer text.
    expect(
      orch.queueTaskChat('A', 'flaky assert', { clientMessageId: 'sub-1' }).mode,
    ).toBe('queued');
    clock.now = 100;
    await orch.tick();

    const a = port.tasks.get('A')!;
    expect(a.state).toBe('retrying');
    expect(a.body).toContain('flaky assert');
    expect(a.pendingSteer).toBeTruthy();
    // The human continuation runs before L3; no stale verifier feedback is mixed in.
    expect(a.pendingSteer).toBe('flaky assert');
  });

  it('L3 auto-rework drains mid-run queued chat into body + merged pendingSteer (live repro)', async () => {
    // Live repro 2026-07-31: in_progress chat returned mode=queued; run ended with
    // L3 changes-requested → retrying, but the queued message was absent from
    // pendingSteer and the task body. Queue must drain on every finalize path.
    const port = new FakePort(
      new Map([['A', { ...task('A'), agentSession: 'sess-live' }]]),
      reposWithCaps({ app: 1 }),
    );
    const clock = { now: 0 };
    const spy = new SpyWorkspaces();
    const verifier = {
      verify: async (): Promise<import('../../src/domain/verification.js').ReviewPacket> => ({
        taskId: 'A',
        branch: 'hercules/A',
        filesTouched: ['src/x.ts'],
        diffSummary: '1 file',
        diff: '+x',
        gates: [{ name: 'test', command: 'pnpm test', passed: true, output: '' }],
        cheatFindings: [],
        screenshots: [],
        reviewerVerdict: {
          approved: false,
          summary: 'changes requested',
          comments: ['Fix the flaky assert'],
        },
        selfAssessment: 'pass',
        finalReport: 'did stuff',
        green: false,
        noChanges: false,
        autoRework: true,
        reportPolluted: false,
        dod: {
          mechanical: 'pass',
          reviewer: 'fail',
          human: 'pending',
          criteria: [],
          warnings: [],
        },
        activityLog: [],
        ...PACKET_EXTRA,
        reworkPath: 'steer',
        reworkPathReason: 'comment/polish L3 on small diff',
      }),
    };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { maxAttempts: 3, backoffBaseMs: 1 }),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      workspaces: spy,
      verifier,
      clock: () => clock.now,
    });

    await orch.tick(); // dispatch
    expect(port.tasks.get('A')!.state).toBe('in_progress');
    const q = orch.queueTaskChat('A', 'operator mid-run note about the assert', {
      clientMessageId: 'live-repro-1',
    });
    expect(q.mode).toBe('queued');
    expect(orch.getState().pendingChat['A']).toEqual([
      'operator mid-run note about the assert',
    ]);

    clock.now = 100;
    const report = await orch.tick(); // complete → pre-L1 continuation

    expect(report.retried).toContain('A');
    expect(orch.getState().pendingChat['A']).toBeUndefined();
    expect(orch.getTaskChatQueue('A')).toEqual([]);

    const a = port.tasks.get('A')!;
    expect(a.state).toBe('retrying');
    // Durable: body must carry the human note (audit + next prompt).
    expect(a.body).toContain('operator mid-run note about the assert');
    expect(a.body).toContain('## Human steer');
    expect(a.body).toContain('client-message-id: live-repro-1');
    // The continuation contains the operator request only; L3 never saw the stale tip.
    expect(a.pendingSteer).toBeTruthy();
    expect(a.pendingSteer).toContain('operator mid-run note about the assert');
    // Same id retry after drain must not re-queue.
    const dup = orch.queueTaskChat('A', 'operator mid-run note about the assert', {
      clientMessageId: 'live-repro-1',
    });
    // Task is retrying (not in_progress) — queueTaskChat still dedupes by body id.
    expect(dup.mode).toBe('duplicate');
  });

  it('L3 auto-rework keeps operator text in pendingSteer when id markers already on body (partial write)', async () => {
    // L3 regression: partial write left client-message-id on body while queue still
    // held the entry. foldDrainedChat must not empty queueText for pendingSteer —
    // body exactly-once via id/fp, full drained human text still merges into steer.
    const port = new FakePort(
      new Map([['A', { ...task('A'), agentSession: 'sess-live' }]]),
      reposWithCaps({ app: 1 }),
    );
    const clock = { now: 0 };
    const verifier = {
      verify: async (): Promise<import('../../src/domain/verification.js').ReviewPacket> => ({
        taskId: 'A',
        branch: 'hercules/A',
        filesTouched: ['src/x.ts'],
        diffSummary: '1 file',
        diff: '+x',
        gates: [{ name: 'test', command: 'pnpm test', passed: true, output: '' }],
        cheatFindings: [],
        screenshots: [],
        reviewerVerdict: {
          approved: false,
          summary: 'changes requested',
          comments: ['Fix the flaky assert'],
        },
        selfAssessment: 'pass',
        finalReport: 'did stuff',
        green: false,
        noChanges: false,
        autoRework: true,
        reportPolluted: false,
        dod: {
          mechanical: 'pass',
          reviewer: 'fail',
          human: 'pending',
          criteria: [],
          warnings: [],
        },
        activityLog: [],
        ...PACKET_EXTRA,
        reworkPath: 'steer',
        reworkPathReason: 'comment/polish L3 on small diff',
      }),
    };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { maxAttempts: 3, backoffBaseMs: 1 }),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      verifier,
      clock: () => clock.now,
    });

    await orch.tick(); // dispatch
    const operatorNote = 'operator note after partial write';
    // Simulate partial durable write: id marker + text already on body, commit never acked.
    const disk = port.tasks.get('A')!;
    await port.writeTask({
      ...disk,
      body:
        `${disk.body.trimEnd()}\n\n` +
        `## Human steer (2026-07-31T16:00:00.000Z)\n\n` +
        `<!-- client-message-id: partial-1 -->\n\n` +
        `${operatorNote}\n`,
    });
    expect(
      orch.queueTaskChat('A', operatorNote, { clientMessageId: 'partial-1' }).mode,
    ).toBe('queued');
    expect(orch.getTaskChatQueue('A')).toEqual([operatorNote]);

    clock.now = 100;
    const report = await orch.tick(); // pre-L1 checkpoint
    expect(report.retried).toContain('A');
    expect(orch.getTaskChatQueue('A')).toEqual([]);

    const a = port.tasks.get('A')!;
    expect(a.state).toBe('retrying');
    // Body exactly-once (no second Human steer for the same note).
    expect(a.body.match(/operator note after partial write/g)?.length ?? 0).toBe(1);
    // Critical: pendingSteer must still carry the operator text for the next prompt.
    expect(a.pendingSteer).toBeTruthy();
    expect(a.pendingSteer).toContain(operatorNote);
  });

  it('queued chat folded on L3 does not requeue after a later green (stale-run repro)', async () => {
    // Live repro: mid-run queue survived L3 auto-rework + green and resurfaced
    // after packet_finalize green as a redundant fourth run. Fold exactly once
    // into the next rework/terminal, then clear memory — never across later runs.
    let phase: 'l3' | 'green' = 'l3';
    let verifyCalls = 0;
    const port = new FakePort(
      new Map([['A', { ...task('A'), agentSession: 'sess-live' }]]),
      reposWithCaps({ app: 1 }),
    );
    const clock = { now: 0 };
    const verifier = {
      verify: async (): Promise<import('../../src/domain/verification.js').ReviewPacket> => {
        verifyCalls += 1;
        if (phase === 'l3') {
          return {
            taskId: 'A',
            branch: 'hercules/A',
            filesTouched: ['src/x.ts'],
            diffSummary: '1 file',
            diff: '+x',
            gates: [{ name: 'test', command: 'pnpm test', passed: true, output: '' }],
            cheatFindings: [],
            screenshots: [],
            reviewerVerdict: {
              approved: false,
              summary: 'changes requested',
              comments: ['Fix the flaky assert'],
            },
            selfAssessment: 'pass',
            finalReport: 'did stuff',
            green: false,
            noChanges: false,
            autoRework: true,
            reportPolluted: false,
            dod: {
              mechanical: 'pass',
              reviewer: 'fail',
              human: 'pending',
              criteria: [],
              warnings: [],
            },
            activityLog: [],
            ...PACKET_EXTRA,
            reworkPath: 'steer',
            reworkPathReason: 'comment/polish L3 on small diff',
          };
        }
        return {
          taskId: 'A',
          branch: 'hercules/A',
          filesTouched: ['src/x.ts'],
          diffSummary: '1 file',
          diff: '+x',
          gates: [{ name: 'test', command: 'pnpm test', passed: true, output: '' }],
          cheatFindings: [],
          screenshots: [],
          reviewerVerdict: { approved: true, summary: 'ok', comments: [] },
          selfAssessment: 'done',
          finalReport: 'fixed',
          green: true,
          noChanges: false,
          autoRework: false,
          reportPolluted: false,
          dod: {
            mechanical: 'pass',
            reviewer: 'pass',
            human: 'pending',
            criteria: [],
            warnings: [],
          },
          activityLog: [],
          ...PACKET_EXTRA,
        };
      },
    };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { maxAttempts: 5, backoffBaseMs: 1 }),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      verifier,
      clock: () => clock.now,
    });

    await orch.tick(); // run 1 dispatch
    expect(
      orch.queueTaskChat('A', 'stale must not resurface', { clientMessageId: 'stale-1' }).mode,
    ).toBe('queued');
    clock.now = 100;
    const l3 = await orch.tick(); // pre-L1 checkpoint — fold once
    expect(l3.retried).toContain('A');
    expect(orch.getTaskChatQueue('A')).toEqual([]);
    expect(port.tasks.get('A')!.body).toContain('stale must not resurface');
    expect(port.tasks.get('A')!.body).toContain('chat-delivery-id:');

    phase = 'green';
    clock.now = 200;
    await orch.tick(); // run 2 dispatch (rework)
    expect(orch.getTaskChatQueue('A')).toEqual([]);
    clock.now = 300;
    const green = await orch.tick(); // green complete — must land review, not requeue
    expect(green.completed).toContain('A');
    expect(green.retried).not.toContain('A');
    expect(port.tasks.get('A')!.state).toBe('review');
    expect(orch.getTaskChatQueue('A')).toEqual([]);
    // Note appears once; no redundant fourth-run requeue.
    expect(port.tasks.get('A')!.body.match(/stale must not resurface/g)?.length ?? 0).toBe(1);
    expect(verifyCalls).toBe(1);
  });

  it('persist-before-clear: commit fail keeps queue; concurrent later enqueue survives', async () => {
    // Snapshot → fold/write → ack only on durable commit. Concurrent messages
    // enqueued after the snapshot must remain after a successful recovery.
    class ThrowCommitPort extends FakePort {
      failCommit = false;
      onBeforeCommit: (() => void) | null = null;
      override async commit(message: string): Promise<{ committed: boolean }> {
        this.onBeforeCommit?.();
        if (this.failCommit) throw new Error('injected commit throw');
        return super.commit(message);
      }
    }
    const port = new ThrowCommitPort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { backoffBaseMs: 1 }),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100, finalMessage: 'done' }),
      verifier: greenVerifier(),
      clock: () => clock.now,
    });

    await orch.tick();
    expect(
      orch.queueTaskChat('A', 'snapshotted first', { clientMessageId: 'pb-1' }).mode,
    ).toBe('queued');
    port.failCommit = true;
    port.onBeforeCommit = () => {
      // Concurrent enqueue while finalize is committing the snapshot (once).
      port.onBeforeCommit = null;
      orch.queueTaskChat('A', 'concurrent later', { clientMessageId: 'pb-2' });
    };
    clock.now = 100;
    await orch.tick();
    // Commit failed — neither message is acked as delivered; both remain.
    // Persist-before-clear: must not have dropped snapshotted first.
    expect(orch.getTaskChatQueue('A')).toEqual(
      expect.arrayContaining(['snapshotted first', 'concurrent later']),
    );
    // Must NOT have remembered ids as delivered before durable write.
    const dupAfterFail = orch.queueTaskChat('A', 'snapshotted first', {
      clientMessageId: 'pb-1',
    });
    expect(dupAfterFail.mode).toBe('duplicate');
    expect(dupAfterFail.priorMode).toBe('queued');

    port.failCommit = false;
    port.onBeforeCommit = null;
    const disk = port.tasks.get('A')!;
    if (disk.state === 'in_progress' || disk.state === 'failed') {
      await port.writeTask({
        ...disk,
        state: 'retrying',
        pendingSteer: null,
        lastEventAt: null,
        endedAt: new Date(clock.now).toISOString(),
      });
    }
    clock.now = 200;
    await orch.tick(); // dispatch
    clock.now = 300;
    await orch.tick(); // complete durable fold
    expect(orch.getTaskChatQueue('A')).toEqual([]);
    const body = port.tasks.get('A')!.body;
    expect(body).toContain('snapshotted first');
    expect(body).toContain('concurrent later');
    expect(body).toContain('chat-delivery-id:');
  });

  it('two successive same-text mid-run chats with distinct client ids each land once', async () => {
    // Text-only chat-queue-fp must not alias a deliberate later identical message.
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { backoffBaseMs: 1 }),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100, finalMessage: 'done' }),
      verifier: greenVerifier(),
      clock: () => clock.now,
    });

    await orch.tick();
    expect(
      orch.queueTaskChat('A', 'same words twice', { clientMessageId: 'q1' }).mode,
    ).toBe('queued');
    clock.now = 100;
    await orch.tick(); // fold q1 → retrying
    expect(orch.getTaskChatQueue('A')).toEqual([]);
    expect(port.tasks.get('A')!.body).toContain('client-message-id: q1');
    expect(port.tasks.get('A')!.body).toContain('chat-delivery-id:');

    clock.now = 200;
    await orch.tick(); // dispatch rework
    expect(
      orch.queueTaskChat('A', 'same words twice', { clientMessageId: 'q2' }).mode,
    ).toBe('queued');
    clock.now = 300;
    await orch.tick(); // fold q2
    expect(orch.getTaskChatQueue('A')).toEqual([]);
    const body = port.tasks.get('A')!.body;
    expect(body).toContain('client-message-id: q1');
    expect(body).toContain('client-message-id: q2');
    expect(body.match(/same words twice/g)?.length ?? 0).toBe(2);
    // Distinct delivery instances.
    const deliveryMarkers = body.match(/chat-delivery-id: [A-Za-z0-9._:-]+/g) ?? [];
    expect(deliveryMarkers.length).toBeGreaterThanOrEqual(2);
    expect(new Set(deliveryMarkers).size).toBe(deliveryMarkers.length);
  });

  it('deliberate later legacy same text is accepted and folded separately', async () => {
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { backoffBaseMs: 1 }),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100, finalMessage: 'done' }),
      verifier: greenVerifier(),
      clock: () => clock.now,
    });

    await orch.tick();
    expect(orch.queueTaskChat('A', 'legacy same later').mode).toBe('queued');
    clock.now = 100;
    await orch.tick(); // fold → retrying
    expect(port.tasks.get('A')!.body.match(/legacy same later/g)?.length ?? 0).toBe(1);

    clock.now = 200;
    await orch.tick(); // rework dispatch (consumes pendingSteer)
    clock.now = 300;
    await orch.tick(); // green → review
    expect(port.tasks.get('A')!.state).toBe('review');

    // Human re-opens a fresh run; deliberate later identical legacy text must land.
    const reviewed = port.tasks.get('A')!;
    await port.writeTask({
      ...reviewed,
      state: 'todo',
      pendingSteer: null,
      agentSession: null,
      endedAt: null,
      lastEventAt: null,
    });
    clock.now = 400;
    await orch.tick(); // new dispatch
    expect(orch.queueTaskChat('A', 'legacy same later').mode).toBe('queued');
    clock.now = 500;
    await orch.tick();
    expect(port.tasks.get('A')!.body.match(/legacy same later/g)?.length ?? 0).toBe(2);
    expect(port.tasks.get('A')!.body).toContain('chat-delivery-id:');
  });

  it('same-id chat is idempotent across pending → dispatch → in_progress race', async () => {
    const port = new FakePort(
      new Map([
        [
          'A',
          {
            ...task('A'),
            state: 'todo' as TaskState,
            pendingSteer: 'please fix the race',
            agentSession: 'sess-1',
            body:
              'body\n\n## Human steer (2026-07-31T15:00:00.000Z)\n\n' +
              '<!-- client-message-id: race-msg-1 -->\n\nplease fix the race\n',
          },
        ],
      ]),
      reposWithCaps({ app: 1 }),
    );
    const clock = { now: 0 };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter: new FakeAdapter({ durationMs: 10_000 }),
      clock: () => clock.now,
    });

    await orch.tick(); // dispatch consumes pendingSteer
    expect(port.tasks.get('A')!.state).toBe('in_progress');
    expect(port.tasks.get('A')!.pendingSteer).toBeNull();

    // Retried identical POST while in_progress — must NOT queue for a second run.
    const result = orch.queueTaskChat('A', 'please fix the race', {
      clientMessageId: 'race-msg-1',
    });
    expect(result.mode).toBe('duplicate');
    expect(result.queued).toEqual([]);
    expect(orch.getState().pendingChat['A']).toBeUndefined();
  });

  it('dedupes exact repeated live-queue entries; distinct messages preserve order', async () => {
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter: new FakeAdapter({ durationMs: 10_000 }),
      clock: () => clock.now,
    });
    await orch.tick();
    expect(orch.queueTaskChat('A', 'first').mode).toBe('queued');
    expect(orch.queueTaskChat('A', 'first').mode).toBe('duplicate'); // exact text
    expect(orch.queueTaskChat('A', 'second', { clientMessageId: 'b' }).mode).toBe('queued');
    expect(orch.queueTaskChat('A', 'second', { clientMessageId: 'b' }).mode).toBe('duplicate');
    expect(orch.queueTaskChat('A', 'third', { clientMessageId: 'c' }).mode).toBe('queued');
    expect(orch.getTaskChatQueue('A')).toEqual(['first', 'second', 'third']);
  });

  it('cancel audits and acknowledges a queued delivery id exactly once', async () => {
    const { orch, port, clock } = setup([task('A')], {
      adapter: new FakeAdapter({ durationMs: 10_000, stopGraceMs: 0 }),
    });
    await orch.tick();
    orch.queueTaskChat('A', 'cancelled operator note', { clientMessageId: 'cancel-msg-1' });
    await port.writeTask({ ...port.tasks.get('A')!, state: 'cancelled' });

    await orch.tick();
    clock.now = 1;
    await orch.tick();

    expect(orch.getTaskChatQueue('A')).toEqual([]);
    const body = port.tasks.get('A')!.body;
    expect(body.match(/client-message-id: cancel-msg-1/g)).toHaveLength(1);
    expect(body.match(/cancelled operator note/g)).toHaveLength(1);
  });

  it('drains all mid-run chat into one steer — three messages → one requeue + one verify', async () => {
    // Regression: complete() used to shift only the head of pendingChat, so each
    // Remote Control message forced its own full verification cycle.
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    let verifyCalls = 0;
    const verifier = {
      verify: async (): Promise<import('../../src/domain/verification.js').ReviewPacket> => {
        verifyCalls += 1;
        return {
          taskId: 'A',
          branch: 'hercules/A',
          filesTouched: ['src/x.ts'],
          diffSummary: '1 file',
          diff: '+x',
          gates: [{ name: 'test', command: 'pnpm test', passed: true, output: '' }],
          cheatFindings: [],
          screenshots: [],
          reviewerVerdict: { approved: true, summary: 'ok', comments: [] },
          selfAssessment: 'done',
          finalReport: '',
          green: true,
          noChanges: false,
          autoRework: false,
          reportPolluted: false,
          dod: {
            mechanical: 'pass',
            reviewer: 'pass',
            human: 'pending',
            criteria: [],
            warnings: [],
          },
          activityLog: [],
          ...PACKET_EXTRA,
        };
      },
    };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100, finalMessage: 'done' }),
      verifier,
      clock: () => clock.now,
    });

    await orch.tick(); // dispatch
    expect(port.tasks.get('A')!.state).toBe('in_progress');
    orch.queueTaskChat('A', 'first feedback');
    orch.queueTaskChat('A', 'second feedback');
    orch.queueTaskChat('A', 'third feedback');
    expect(orch.getState().pendingChat['A']).toHaveLength(3);

    clock.now = 100;
    const report = await orch.tick(); // complete once

    expect(verifyCalls).toBe(0);
    expect(report.retried).toContain('A');
    expect(report.completed).not.toContain('A');
    expect(orch.getState().pendingChat['A']).toBeUndefined();
    expect(orch.getTaskChatQueue('A')).toEqual([]);

    const a = port.tasks.get('A')!;
    expect(a.state).toBe('retrying');
    expect(a.pendingSteer).toContain('first feedback');
    expect(a.pendingSteer).toContain('second feedback');
    expect(a.pendingSteer).toContain('third feedback');
    expect(a.pendingSteer!.indexOf('first feedback')).toBeLessThan(
      a.pendingSteer!.indexOf('second feedback'),
    );
    expect(a.pendingSteer!.indexOf('second feedback')).toBeLessThan(
      a.pendingSteer!.indexOf('third feedback'),
    );
    expect(a.body).toContain('3 messages drained');
    // One agent start so far; the combined steer requeues for the *next* tick.
    expect(report.dispatched.filter((id) => id === 'A')).toHaveLength(0);
  });

  it('pending-chat drain preserves messages when session delivery is unavailable', async () => {
    // No session id on complete() must not drop the queue — requeue still
    // carries combined pendingSteer + body audit (one requeue, one verify).
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    let verifyCalls = 0;
    const verifier = {
      verify: async (): Promise<import('../../src/domain/verification.js').ReviewPacket> => {
        verifyCalls += 1;
        return {
          taskId: 'A',
          branch: 'hercules/A',
          filesTouched: ['src/x.ts'],
          diffSummary: '1 file',
          diff: '+x',
          gates: [{ name: 'test', command: 'pnpm test', passed: true, output: '' }],
          cheatFindings: [],
          screenshots: [],
          reviewerVerdict: { approved: true, summary: 'ok', comments: [] },
          selfAssessment: 'done',
          finalReport: '',
          green: true,
          noChanges: false,
          autoRework: false,
          reportPolluted: false,
          dod: {
            mechanical: 'pass',
            reviewer: 'pass',
            human: 'pending',
            criteria: [],
            warnings: [],
          },
          activityLog: [],
          ...PACKET_EXTRA,
        };
      },
    };
    // FakeAdapter that reports done with an empty session id.
    class NoSessionAdapter extends FakeAdapter {
      override start(
        input: import('../../src/orchestrator/adapter.js').AgentStartInput,
        now: number,
      ): import('../../src/orchestrator/adapter.js').AgentRun {
        const run = super.start(input, now);
        // Force empty session for the no-delivery path.
        Object.defineProperty(run, 'sessionId', { get: () => '' });
        const origPoll = run.poll.bind(run);
        run.poll = (t: number) => {
          const snap = origPoll(t);
          return { ...snap, sessionId: '' };
        };
        return run;
      }
    }
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter: new NoSessionAdapter({ durationMs: 100, finalMessage: 'done' }),
      verifier,
      clock: () => clock.now,
    });

    await orch.tick();
    orch.queueTaskChat('A', 'alpha');
    orch.queueTaskChat('A', 'beta');
    orch.queueTaskChat('A', 'gamma');
    expect(orch.getState().pendingChat['A']).toHaveLength(3);

    clock.now = 100;
    const report = await orch.tick();

    expect(verifyCalls).toBe(0);
    expect(report.retried).toContain('A');
    expect(report.completed).not.toContain('A');
    expect(orch.getState().pendingChat['A']).toBeUndefined();

    const a = port.tasks.get('A')!;
    expect(a.state).toBe('retrying');
    expect(a.pendingSteer).toContain('alpha');
    expect(a.pendingSteer).toContain('beta');
    expect(a.pendingSteer).toContain('gamma');
    expect(a.pendingSteer!.indexOf('alpha')).toBeLessThan(a.pendingSteer!.indexOf('beta'));
    expect(a.pendingSteer!.indexOf('beta')).toBeLessThan(a.pendingSteer!.indexOf('gamma'));
    expect(a.body).toContain('3 messages drained');
    expect(a.body).toContain('alpha');
  });

  it('closes the empty-check to verification-registration race before L1 starts', async () => {
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    let verifyCalls = 0;
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      verifier: {
        verify: async () => {
          verifyCalls += 1;
          return (await greenVerifier().verify());
        },
      },
      clock: () => clock.now,
    });
    let queued = false;
    const unsubscribe = orch.subscribe((view) => {
      if (!queued && view.verificationRuns?.['A']) {
        queued = true;
        orch.queueTaskChat('A', 'arrived at verification startup', {
          clientMessageId: 'startup-race-1',
        });
      }
    });

    await orch.tick();
    clock.now = 100;
    const report = await orch.tick();
    unsubscribe();

    expect(queued).toBe(true);
    expect(verifyCalls).toBe(0);
    expect(report.retried).toContain('A');
    expect(port.tasks.get('A')!.pendingSteer).toContain('arrived at verification startup');
    expect(port.tasks.get('A')!.body).toContain('client-message-id: startup-race-1');
  });

  it('does not resurrect session ownership or a stale green SHA after switch-now during verification', async () => {
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    let verifierCalls = 0;
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      verifier: {
        verify: async () => {
          verifierCalls += 1;
          const live = port.tasks.get('A')!;
          expect(live.agentSession).toBeTruthy();
          port.tasks.set('A', {
            ...live,
            state: 'retrying',
            adapter: 'codex',
            agentSession: null,
            agentSessionAdapter: null,
            verifiedSha: null,
            body:
              `${live.body.trim()}\n\n## Agent switch (2026-08-02T00:00:00.000Z)\n\n` +
              'Human switched agent mid-run → `codex`. Live process stopped; re-queued.\n',
          });
          return await greenVerifier().verify();
        },
      },
      clock: () => clock.now,
    });

    await orch.tick();
    clock.now = 100;
    const report = await orch.tick();

    const switched = port.tasks.get('A')!;
    expect(verifierCalls).toBe(1);
    expect(report.completed).not.toContain('A');
    expect(switched.state).toBe('retrying');
    expect(switched.adapter).toBe('codex');
    expect(switched.agentSession).toBeNull();
    expect(switched.agentSessionAdapter).toBeNull();
    expect(switched.verifiedSha).toBeNull();
    expect(switched.body).toContain('## Review packet');
    expect(switched.body).toContain('Finalize skipped state write');
  });

  it('still preserves the branch on empty-diff review (do not delete hercules/<id>)', async () => {
    // Case study logout: empty-diff + review used to call remove(deleteBranch) and
    // orphan Settings commits. Always preserve so rework/steer can resume.
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    const spy = new SpyWorkspaces();
    const verifier = {
      verify: async (): Promise<import('../../src/domain/verification.js').ReviewPacket> => ({
        taskId: 'A', branch: 'hercules/A', filesTouched: [], diffSummary: 'no changes', diff: '',
        gates: [{ name: 'test', command: 'pnpm test', passed: true, output: '' }],
        cheatFindings: [], screenshots: [], reviewerVerdict: null,
        selfAssessment: '(none)', finalReport: '', green: false, noChanges: true, autoRework: false,
        reportPolluted: false,
        dod: {
          mechanical: 'n/a', reviewer: 'n/a', human: 'pending', criteria: [], warnings: [],
        },
        activityLog: [],
        ...PACKET_EXTRA,
      }),
    };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      workspaces: spy,
      verifier,
      clock: () => clock.now,
    });

    await orch.tick();
    clock.now = 100;
    await orch.tick();

    const a = port.tasks.get('A')!;
    expect(a.state).toBe('review'); // still reviewable (flagged), not auto-failed
    expect(spy.preserved).toContain('A'); // branch kept even when this turn was empty
    expect(spy.removed).not.toContain('A');
  });

  it('auto-reworks to retrying when the packet requests rework (L3 fail)', async () => {
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    const spy = new SpyWorkspaces();
    const verifier = {
      verify: async (): Promise<import('../../src/domain/verification.js').ReviewPacket> => ({
        taskId: 'A',
        branch: 'hercules/A',
        filesTouched: ['src/x.ts'],
        diffSummary: '1 file',
        diff: '+x',
        gates: [{ name: 'test', command: 'pnpm test', passed: true, output: '' }],
        cheatFindings: [],
        screenshots: [],
        reviewerVerdict: { approved: false, summary: 'draft', comments: ['expand'] },
        selfAssessment: 'pass',
        finalReport: 'did stuff',
        green: false,
        noChanges: false,
        autoRework: true,
        reportPolluted: false,
        dod: {
          mechanical: 'pass',
          reviewer: 'fail',
          human: 'pending',
          criteria: [],
          warnings: [],
        },
        activityLog: [],
        ...PACKET_EXTRA,
        reworkPath: 'full',
        reworkPathReason: 'large design issues',
      }),
    };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { maxAttempts: 3 }),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      workspaces: spy,
      verifier,
      clock: () => clock.now,
    });

    await orch.tick();
    clock.now = 100;
    const report = await orch.tick();

    const a = port.tasks.get('A')!;
    expect(a.state).toBe('retrying');
    expect(a.attempts).toBe(1);
    expect(a.body).toContain('## Review packet');
    expect(a.body).toContain('## Auto-rework');
    expect(a.body).toMatch(/Path: full/i);
    expect(a.pendingSteer).toBeNull(); // full path: no session resume
    expect(report.retried).toContain('A');
    expect(report.completed).not.toContain('A');
    expect(spy.preserved).toContain('A'); // branch kept for next implementer turn
  });

  it('auto-reworks via cheap steer when packet reworkPath is steer', async () => {
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    const spy = new SpyWorkspaces();
    let verifyCalls = 0;
    const verifier = {
      verify: async (): Promise<import('../../src/domain/verification.js').ReviewPacket> => {
        verifyCalls += 1;
        return ({
        taskId: 'A',
        branch: 'hercules/A',
        filesTouched: ['src/x.ts'],
        diffSummary: '1 file changed, 5 insertions(+)',
        diff: '+x',
        gates: [{ name: 'test', command: 'pnpm test', passed: true, output: '' }],
        cheatFindings: [],
        screenshots: [],
        reviewerVerdict: {
          approved: false,
          summary: 'Polish nits',
          comments: ['Fix typo in comment'],
        },
        selfAssessment: 'pass',
        finalReport: 'did stuff',
        green: false,
        noChanges: false,
        autoRework: true,
        reportPolluted: false,
        dod: {
          mechanical: 'pass',
          reviewer: 'fail',
          human: 'pending',
          criteria: [],
          warnings: [],
        },
        activityLog: [],
        ...PACKET_EXTRA,
        reworkPath: 'steer',
        reworkPathReason: 'comment/polish L3 on small diff',
        });
      },
    };
    const adapter = new FakeAdapter({ durationMs: 100 });
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { maxAttempts: 3, backoffBaseMs: 1 }),
      control: port,
      adapter,
      workspaces: spy,
      verifier,
      clock: () => clock.now,
    });

    await orch.tick();
    clock.now = 100;
    await orch.tick();

    const a = port.tasks.get('A')!;
    expect(verifyCalls).toBe(1);
    expect(a.state).toBe('retrying');
    expect(a.pendingSteer).toMatch(/L3 requested changes/i);
    expect(a.pendingSteer).toContain('Fix typo in comment');
    expect(a.body).toMatch(/Path: steer/i);
    expect(a.agentSession).toBeTruthy();
    const sessionBefore = a.agentSession;

    // Next dispatch (after minimal backoff) resumes with short steer prompt.
    clock.now = 200;
    await orch.tick();
    expect(adapter.started.length).toBeGreaterThanOrEqual(2);
    const resume = adapter.started[adapter.started.length - 1]!;
    expect(resume.resumeSessionId).toBe(sessionBefore);
    expect(resume.prompt).toContain('Fix typo in comment');
    expect(resume.prompt).toMatch(/follow-up|Human follow-up/i);
  });

  it('preserves branch and honest packet on max-attempts failed (logout tip loss)', async () => {
    // Case study: maxAttempts failed used remove(deleteBranch) and said "will re-queue".
    const port = new FakePort(
      new Map([['A', { ...task('A'), attempts: 2 }]]),
      reposWithCaps({ app: 1 }),
    );
    // attempts start at 2; one more autoRework completion → attempts 3 >= max 3 → failed
    const clock = { now: 0 };
    const spy = new SpyWorkspaces();
    const verifier = {
      verify: async (): Promise<import('../../src/domain/verification.js').ReviewPacket> => ({
        taskId: 'A',
        branch: 'hercules/A',
        filesTouched: ['src/web/SettingsPanel.tsx'],
        diffSummary: '1 file',
        diff: '+hooks',
        gates: [{ name: 'test', command: 'pnpm test', passed: true, output: '' }],
        cheatFindings: [],
        screenshots: [],
        reviewerVerdict: { approved: false, summary: 'missing hooks', comments: [] },
        selfAssessment: 'fixed',
        finalReport: 'hooks present',
        green: false,
        noChanges: false,
        autoRework: true,
        reportPolluted: false,
        dod: {
          mechanical: 'pass',
          reviewer: 'fail',
          human: 'pending',
          criteria: [],
          warnings: [],
        },
        activityLog: [],
        ...PACKET_EXTRA,
      }),
    };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { maxAttempts: 3 }),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      workspaces: spy,
      verifier,
      clock: () => clock.now,
    });

    await orch.tick(); // dispatch
    clock.now = 100;
    const report = await orch.tick(); // complete → failed

    const a = port.tasks.get('A')!;
    expect(a.state).toBe('failed');
    expect(a.attempts).toBe(3);
    expect(report.failed).toContain('A');
    expect(spy.preserved).toContain('A');
    expect(spy.removed).not.toContain('A');
    expect(a.body).toMatch(/attempts exhausted/i);
    expect(a.body).toContain('## Attempts exhausted');
    expect(a.body).not.toMatch(/will be re-queued/i);
  });

  it('parks in review (not rework) when only soft hygiene is dirty and L3 approved', async () => {
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    const spy = new SpyWorkspaces();
    const verifier = {
      verify: async (): Promise<import('../../src/domain/verification.js').ReviewPacket> => ({
        taskId: 'A',
        branch: 'hercules/A',
        filesTouched: ['src/x.ts'],
        diffSummary: '1 file',
        diff: '+x',
        gates: [
          { name: 'test', command: 't', passed: true, output: '' },
          {
            name: 'report-hygiene',
            command: 'hercules:report-hygiene',
            passed: true,
            output: 'WARN soft',
          },
        ],
        cheatFindings: [],
        screenshots: [],
        reviewerVerdict: { approved: true, summary: 'ok', comments: [] },
        selfAssessment: 'pending human',
        finalReport: 'cleaned narrative',
        green: true,
        noChanges: false,
        autoRework: false,
        reportPolluted: true,
        dod: {
          mechanical: 'pass',
          reviewer: 'pass',
          human: 'pending',
          criteria: [],
          warnings: [],
        },
        activityLog: [],
        ...PACKET_EXTRA,
      }),
    };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { maxAttempts: 3 }),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      workspaces: spy,
      verifier,
      clock: () => clock.now,
    });
    await orch.tick();
    clock.now = 100;
    const report = await orch.tick();
    const a = port.tasks.get('A')!;
    expect(a.state).toBe('review');
    expect(a.attempts).toBe(0);
    expect(report.completed).toContain('A');
    expect(report.retried).not.toContain('A');
    expect(a.body).toContain('## Review packet');
    expect(a.body).not.toContain('## Auto-rework');
  });
});

describe('Orchestrator.reclaimOrphans one-shot (Task 4)', () => {
  function spySetup(tasks: Task[]): {
    orch: Orchestrator;
    port: FakePort;
    spy: SpyWorkspaces;
    clock: { now: number };
  } {
    const spy = new SpyWorkspaces();
    const port = new FakePort(new Map(tasks.map((t) => [t.id, t])), reposWithCaps({ app: 5 }));
    const clock = { now: 0 };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      workspaces: spy,
      clock: () => clock.now,
    });
    return { orch, port, spy, clock };
  }

  it('calls reclaimOrphans exactly once on the first tick', async () => {
    const { orch, spy } = spySetup([task('A')]);
    await orch.tick();
    await orch.tick();
    await orch.tick();
    expect(spy.reclaimCalls).toHaveLength(1);
  });

  it('passes tracked and stopping ids to reclaimOrphans on first tick', async () => {
    // Start with an in_progress task so it gets dispatched and ends up tracked.
    const { orch, port, spy } = spySetup([task('A')]);
    await orch.tick(); // dispatches A → tracked
    // On the first tick, tracked is empty at the point reclaimOrphans runs
    // (reclaimOrphans runs before dispatch), so keep = {} for first tick.
    expect(spy.reclaimCalls[0]).toBeDefined();
    const keep = spy.reclaimCalls[0]!;
    // A wasn't tracked before the first tick (this IS the first tick), so keep is empty.
    expect(keep.size).toBe(0);
    // Second tick: reclaimOrphans is NOT called again.
    port.tasks.set('A', { ...port.tasks.get('A')!, state: 'cancelled' });
    await orch.tick();
    expect(spy.reclaimCalls).toHaveLength(1);
  });

  it('keeps on-disk worktrees for in_progress/retrying tasks on first reclaim', async () => {
    // Case study settings-build: restart with empty keep wiped the agent worktree
    // while the control file still said in_progress → preserve "worktree missing".
    const { orch, spy } = spySetup([
      task('RUN-1', { state: 'in_progress' }),
      task('RETRY-1', { state: 'retrying' }),
      task('REV-1', { state: 'review' }),
    ]);
    await orch.tick();
    expect(spy.reclaimCalls).toHaveLength(1);
    const keep = spy.reclaimCalls[0]!;
    expect(keep.has('RUN-1')).toBe(true);
    expect(keep.has('RETRY-1')).toBe(true);
    // review is not a live agent claim — may be reclaimed if present on disk.
    expect(keep.has('REV-1')).toBe(false);
  });

  it('adds reclaimed ids to tornDown in the report', async () => {
    const { orch, spy } = spySetup([]);
    spy.reclaimReturn = ['OLD-1', 'OLD-2'];
    const report = await orch.tick();
    expect(report.tornDown).toEqual(expect.arrayContaining(['OLD-1', 'OLD-2']));
  });
});

describe('Orchestrator.refreshSnapshotFromControl', () => {
  it('re-reads control and notifies subscribers (Approve plan SSE path)', async () => {
    const port = new FakePort(
      new Map([task('P', { planPending: true })].map((t) => [t.id, t])),
      reposWithCaps({ app: 5 }),
    );
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      workspaces: new SpyWorkspaces(),
      clock: () => 0,
    });
    await orch.tick(); // seed lastSnapshot
    expect(orch.getState().snapshot?.tasks.find((t) => t.id === 'P')?.planPending).toBe(true);

    // Out-of-band mutation (ActionService style) — disk changed without a tick.
    port.tasks.set('P', { ...port.tasks.get('P')!, planPending: false });

    let emits = 0;
    orch.subscribe(() => {
      emits += 1;
    });
    await orch.refreshSnapshotFromControl();
    expect(emits).toBeGreaterThanOrEqual(1);
    expect(orch.getState().snapshot?.tasks.find((t) => t.id === 'P')?.planPending).toBe(false);
  });
});

describe('Orchestrator.tick — blocked_by / gate-merge barrier', () => {
  const gateMeta = {
    mergedSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    mergedVia: 'gate' as const,
    verifiedSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  };
  const GATE_TIP = 'cccccccccccccccccccccccccccccccccccccccc';

  function gateWorkspaces(opts?: {
    reachable?: boolean;
    tip?: string;
    tipAfterProof?: string;
    absorbOnRefresh?: boolean;
  }): Workspaces & {
    readonly createCalls: number;
    readonly proofs: number;
    readonly refreshes: number;
    readonly proofBatches: readonly (readonly string[])[];
  } {
    const tip = opts?.tip ?? GATE_TIP;
    let currentTip = tip;
    let reachable = opts?.reachable !== false;
    const createCalls = { n: 0 };
    const proofs = { n: 0 };
    const refreshes = { n: 0 };
    const proofBatches: string[][] = [];
    return {
      get createCalls() {
        return createCalls.n;
      },
      get proofs() {
        return proofs.n;
      },
      get refreshes() {
        return refreshes.n;
      },
      get proofBatches() {
        return proofBatches;
      },
      async create(repoCfg, taskId, createOpts) {
        createCalls.n += 1;
        const expected = createOpts?.expectedBaseTip?.trim();
        if (expected && expected.toLowerCase() !== currentTip.toLowerCase()) {
          throw new Error(
            `default branch tip moved during dependency gate ` +
              `(expected ${expected}, got ${currentTip})`,
          );
        }
        return {
          taskId,
          repo: repoCfg.key,
          dir: `/tmp/fake/${taskId}`,
          branch: `hercules/${taskId}`,
          allocation: {
            slug: taskId,
            port: 4100,
            scratchDir: `/tmp/fake/${taskId}-scratch`,
          },
          branchLease: {
            expectedBaseRevision: currentTip,
            expectedRemoteTip: createOpts?.expectedRemoteTip ?? null,
          },
        };
      },
      async remove() {},
      async preserve() {
        return { notPropagated: false, events: [] };
      },
      async inspect() {
        return null;
      },
      async reclaimOrphans() {
        return [];
      },
      async readWorkflow() {
        return null;
      },
      async defaultBranchHead() {
        return currentTip;
      },
      async refreshTrustedDefault() {
        refreshes.n += 1;
        if (opts?.absorbOnRefresh) reachable = true;
        return true;
      },
      async proveDefaultBranchAncestry(
        _repo: RepoConfig,
        shas: readonly string[],
      ): Promise<DefaultBranchAncestryProof> {
        proofs.n += 1;
        proofBatches.push([...shas]);
        const proofTip = currentTip;
        // Simulate main moving after the atomic proof (TOCTOU).
        if (opts?.tipAfterProof) {
          currentTip = opts.tipAfterProof;
        }
        const map = new Map<string, boolean | null>();
        for (const s of shas) {
          map.set(s, reachable ? true : false);
        }
        return { tip: proofTip, reachable: map };
      },
      async containsOnDefaultBranch() {
        return reachable ? true : false;
      },
    };
  }

  // L5 title preserved: blocked until dep is done AND gate-merge + ancestry.
  it('dispatches a blocked task only after its dependency is done', async () => {
    const dep = task('DEP', { state: 'in_progress' });
    const blocked = task('A', { blockedBy: ['DEP'] });
    const ws = gateWorkspaces();
    const { orch, port, adapter } = setup([dep, blocked], {
      caps: { app: 5 },
      workspaces: ws,
    });

    const first = await orch.tick();
    expect(first.dispatched).not.toContain('A');

    // Approve alone (done, no merge stamp) must not unlock.
    port.tasks.set('DEP', { ...port.tasks.get('DEP')!, state: 'done' });
    const second = await orch.tick();
    expect(second.dispatched).not.toContain('A');
    expect(adapter.started.map((s) => s.taskId)).not.toContain('A');

    // Gate merge + injected ancestry unlocks exactly once.
    port.tasks.set('DEP', {
      ...port.tasks.get('DEP')!,
      state: 'done',
      ...gateMeta,
    });
    const third = await orch.tick();
    expect(third.dispatched).toContain('A');
    expect(adapter.started.map((s) => s.taskId)).toContain('A');
    expect(ws.proofs).toBeGreaterThan(0);
  });

  it('does not dispatch same-repo implement after Approve-only done', async () => {
    const dep = task('DEP', { state: 'in_progress' });
    const blocked = task('A', { blockedBy: ['DEP'] });
    const { orch, port, adapter } = setup([dep, blocked], { caps: { app: 5 } });

    const first = await orch.tick();
    expect(first.dispatched).not.toContain('A');

    // Human approved upstream — still no Merge Selected stamp.
    port.tasks.set('DEP', { ...port.tasks.get('DEP')!, state: 'done' });
    const second = await orch.tick();
    expect(second.dispatched).not.toContain('A');
    expect(adapter.started.map((s) => s.taskId)).not.toContain('A');
  });

  it('dispatches once after gate merge with explicit ancestry facts', async () => {
    const dep = task('DEP', { state: 'done', ...gateMeta });
    const blocked = task('A', { blockedBy: ['DEP'] });
    const ws = gateWorkspaces();
    const { orch, adapter } = setup([dep, blocked], { caps: { app: 5 }, workspaces: ws });

    const report = await orch.tick();
    expect(report.dispatched).toContain('A');
    expect(adapter.started.map((s) => s.taskId)).toContain('A');
  });

  it('proves all same-repo gate edges in one exact-tip batch', async () => {
    const depA = task('DEP-A', { state: 'done', ...gateMeta });
    const depB = task('DEP-B', {
      state: 'done',
      mergedSha: 'dddddddddddddddddddddddddddddddddddddddd',
      mergedVia: 'gate',
      verifiedSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    });
    const blocked = task('A', { blockedBy: ['DEP-A', 'DEP-B'] });
    const workspaces = gateWorkspaces();
    const { orch, adapter } = setup([depA, depB, blocked], {
      caps: { app: 5 },
      workspaces,
    });

    const report = await orch.tick();

    expect(report.dispatched).toContain('A');
    expect(adapter.started.map((s) => s.taskId)).toContain('A');
    expect(workspaces.proofs).toBe(1);
    expect(new Set(workspaces.proofBatches[0])).toEqual(
      new Set([
        gateMeta.mergedSha,
        gateMeta.verifiedSha,
        depB.mergedSha,
        depB.verifiedSha,
      ]),
    );
  });

  it('blocks when the atomic proof API is absent and never uses the legacy probe', async () => {
    const dep = task('DEP', { state: 'done', ...gateMeta });
    const blocked = task('A', { blockedBy: ['DEP'] });
    let legacyCalls = 0;
    const base = gateWorkspaces();
    const { proveDefaultBranchAncestry: _atomic, ...withoutAtomic } = base;
    const workspaces: Workspaces = {
      ...withoutAtomic,
      async containsOnDefaultBranch() {
        legacyCalls += 1;
        return true;
      },
    };
    const { orch, adapter } = setup([dep, blocked], {
      caps: { app: 5 },
      workspaces,
    });

    const report = await orch.tick();

    expect(report.dispatched).not.toContain('A');
    expect(adapter.started.map((s) => s.taskId)).not.toContain('A');
    expect(legacyCalls).toBe(0);
  });

  it('NoopWorkspaces fails closed without allowAncestry (no adapter start)', async () => {
    const dep = task('DEP', { state: 'done', ...gateMeta });
    const blocked = task('A', { blockedBy: ['DEP'] });
    // Default Noop: every SHA unknown → dep_stale_mirror at recheck.
    const { orch, adapter } = setup([dep, blocked], {
      caps: { app: 5 },
      workspaces: new NoopWorkspaces('/tmp/noop-gate'),
    });
    const report = await orch.tick();
    expect(report.dispatched).not.toContain('A');
    expect(adapter.started.map((s) => s.taskId)).not.toContain('A');
  });

  it('NoopWorkspaces unlocks only when allowAncestry injects gate SHAs', async () => {
    const dep = task('DEP', { state: 'done', ...gateMeta });
    const blocked = task('A', { blockedBy: ['DEP'] });
    const ws = new NoopWorkspaces('/tmp/noop-gate-ok').allowAncestry(
      gateMeta.mergedSha,
      gateMeta.verifiedSha,
    );
    const { orch, adapter } = setup([dep, blocked], { caps: { app: 5 }, workspaces: ws });
    const report = await orch.tick();
    expect(report.dispatched).toContain('A');
    expect(adapter.started.map((s) => s.taskId)).toContain('A');
  });

  it('completion_only explore dependent dispatches on done without merge stamps', async () => {
    const dep = task('DEP', { state: 'done' });
    const blocked = task('A', {
      blockedBy: ['DEP'],
      dependencyMode: 'completion_only',
      executionClass: 'explore',
    });
    const { orch } = setup([dep, blocked], { caps: { app: 5 } });
    const report = await orch.tick();
    expect(report.dispatched).toContain('A');
  });

  it('same-repo implement cannot bypass gate via completion_only override', async () => {
    const dep = task('DEP', { state: 'done' });
    const blocked = task('A', {
      blockedBy: ['DEP'],
      dependencyMode: 'completion_only',
      executionClass: 'implement',
    });
    const { orch, adapter } = setup([dep, blocked], { caps: { app: 5 } });
    const report = await orch.tick();
    expect(report.dispatched).not.toContain('A');
    expect(adapter.started.map((s) => s.taskId)).not.toContain('A');
  });

  it('operator merge stamp does not unlock same-repo implement', async () => {
    const dep = task('DEP', {
      state: 'done',
      mergedSha: gateMeta.mergedSha,
      mergedVia: 'operator',
      verifiedSha: gateMeta.verifiedSha,
    });
    const blocked = task('A', { blockedBy: ['DEP'] });
    const { orch, adapter } = setup([dep, blocked], { caps: { app: 5 } });
    const report = await orch.tick();
    expect(report.dispatched).not.toContain('A');
    expect(adapter.started.map((s) => s.taskId)).not.toContain('A');
  });

  it('dispatches same-repo implement after observed factory merge SHA is on default', async () => {
    const dep = task('DEP', {
      state: 'done',
      adapter: 'cursor',
      prStatus: 'merged',
      prUrl: 'https://github.com/example-org/acme/pull/41',
      mergedSha: gateMeta.mergedSha,
      mergedVia: 'operator',
      verifiedSha: null,
    });
    const blocked = task('A', { blockedBy: ['DEP'] });
    const ws = gateWorkspaces();
    const { orch, adapter } = setup([dep, blocked], { caps: { app: 5 }, workspaces: ws });
    const report = await orch.tick();
    expect(report.dispatched).toContain('A');
    expect(adapter.started.map((s) => s.taskId)).toContain('A');
    expect(ws.proofs).toBeGreaterThan(0);
    expect(ws.proofBatches[0]).toEqual([gateMeta.mergedSha]);
  });

  it('refreshes origin before proving a factory merge SHA that the mirror lacked', async () => {
    const dep = task('DEP', {
      state: 'done',
      adapter: 'cursor',
      prStatus: 'merged',
      mergedSha: gateMeta.mergedSha,
      mergedVia: 'operator',
      verifiedSha: null,
    });
    const blocked = task('A', { blockedBy: ['DEP'] });
    const workspaces = gateWorkspaces({ reachable: false, absorbOnRefresh: true });
    const { orch, adapter } = setup([dep, blocked], { caps: { app: 5 }, workspaces });
    const report = await orch.tick();
    expect(report.dispatched).toContain('A');
    expect(adapter.started.map((s) => s.taskId)).toContain('A');
    expect(workspaces.refreshes).toBeGreaterThan(0);
    expect(workspaces.proofs).toBeGreaterThan(0);
    expect(workspaces.proofBatches[0]).toEqual([gateMeta.mergedSha]);
  });

  it('does not dispatch a factory-dependent when the merge SHA is not on default', async () => {
    const dep = task('DEP', {
      state: 'done',
      adapter: 'cursor',
      prStatus: 'merged',
      mergedSha: gateMeta.mergedSha,
      mergedVia: 'operator',
      verifiedSha: null,
    });
    const blocked = task('A', { blockedBy: ['DEP'] });
    const workspaces = gateWorkspaces({ reachable: false });
    const { orch, adapter } = setup([dep, blocked], { caps: { app: 5 }, workspaces });
    const report = await orch.tick();
    expect(report.dispatched).not.toContain('A');
    expect(adapter.started.map((s) => s.taskId)).not.toContain('A');
    expect(workspaces.createCalls).toBe(0);
  });

  it('pre-provision ancestry recheck blocks when SHAs are not on default branch', async () => {
    const dep = task('DEP', { state: 'done', ...gateMeta });
    const blocked = task('A', { blockedBy: ['DEP'] });
    const workspaces = gateWorkspaces({ reachable: false });
    const { orch, adapter } = setup([dep, blocked], { caps: { app: 5 }, workspaces });
    const report = await orch.tick();
    // selectEligible admits (metadata OK) but dispatch recheck refuses — no process.
    expect(report.dispatched).not.toContain('A');
    expect(adapter.started.map((s) => s.taskId)).not.toContain('A');
    expect(workspaces.createCalls).toBe(0);
  });

  it('refills cap one after a higher-priority candidate is rejected before start', async () => {
    const dep = task('DEP', { state: 'done', ...gateMeta });
    const stale = task('STALE', { blockedBy: ['DEP'], priority: 0 });
    const next = task('NEXT', { priority: 100 });
    const movedTip = 'dddddddddddddddddddddddddddddddddddddddd';
    const workspaces = gateWorkspaces({ tipAfterProof: movedTip });
    const { orch, adapter } = setup([dep, stale, next], {
      caps: { app: 1 },
      workspaces,
    });

    const report = await orch.tick();

    expect(report.dispatched).toEqual(['NEXT']);
    expect(adapter.started.map((s) => s.taskId)).toEqual(['NEXT']);
    expect(workspaces.createCalls).toBe(2);
  });

  it('recovers a stale exact candidate, durably advances its lease, and re-proves before one start', async () => {
    const oldBase = '1'.repeat(40);
    const candidate = '2'.repeat(40);
    const rebased = '3'.repeat(40);
    const dep = task('DEP', { state: 'done', ...gateMeta });
    const stale = task('STALE', {
      blockedBy: ['DEP'],
      startedAt: '2026-08-03T00:00:00.000Z',
      expectedBaseRevision: oldBase,
      expectedRemoteTip: candidate,
    });
    const base = gateWorkspaces();
    let recoveryCalls = 0;
    const workspaces: Workspaces = {
      ...base,
      async recoverStaleTaskBranch(_repo, taskId, trustedTip, lease) {
        recoveryCalls += 1;
        expect(taskId).toBe('STALE');
        expect(trustedTip).toBe(GATE_TIP);
        expect(lease).toEqual({ expectedBaseRevision: oldBase, expectedRemoteTip: candidate });
        return {
          kind: 'recovered',
          lease: { expectedBaseRevision: GATE_TIP, expectedRemoteTip: rebased },
          detail: 'rebased',
        };
      },
    };
    const { orch, port, adapter } = setup([dep, stale], {
      caps: { app: 1 },
      workspaces,
      autoRebase: true,
    });

    const report = await orch.tick();

    expect(report.dispatched).toEqual(['STALE']);
    expect(adapter.started.map((entry) => entry.taskId)).toEqual(['STALE']);
    expect(recoveryCalls).toBe(1);
    expect(base.proofs).toBe(2);
    expect(port.tasks.get('STALE')).toMatchObject({
      state: 'in_progress',
      expectedBaseRevision: GATE_TIP,
      expectedRemoteTip: rebased,
      attempts: 0,
    });
    expect(port.commits.some((message) => message.includes('recover stale dependency-gated exact lease'))).toBe(true);
  });

  it('recovers an amended candidate whose durable base is current but exact tip still has the old base', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const leaseRoot = await mkdtemp(join(tmpdir(), 'hercules-amended-lease-'));
    const candidate = '2'.repeat(40);
    const rebased = '3'.repeat(40);
    const dep = task('DEP', { state: 'done', ...gateMeta });
    const amended = task('AMENDED', {
      blockedBy: ['DEP'],
      startedAt: '2026-08-03T00:00:00.000Z',
      plannedBaseRevision: GATE_TIP,
      expectedBaseRevision: GATE_TIP,
      expectedRemoteTip: candidate,
      affectedPaths: ['src/'],
      protectedPathsSnapshot: [],
    });
    const base = gateWorkspaces();
    let containmentProofs = 0;
    let recoveryCalls = 0;
    const workspaces: Workspaces = {
      ...base,
      async readTrustedDefaultRevisionSnapshot() {
        return {
          revision: GATE_TIP,
          workflowContent: '---\nprotected_paths: []\n---\n',
        };
      },
      async exactCandidateContainsBase(_repo, taskId, expectedTip, baseRevision) {
        containmentProofs += 1;
        expect({ taskId, expectedTip, baseRevision }).toEqual({
          taskId: 'AMENDED', expectedTip: candidate, baseRevision: GATE_TIP,
        });
        return false;
      },
      async recoverStaleTaskBranch(_repo, taskId, trustedTip, lease) {
        recoveryCalls += 1;
        expect({ taskId, trustedTip, lease }).toEqual({
          taskId: 'AMENDED',
          trustedTip: GATE_TIP,
          lease: { expectedBaseRevision: GATE_TIP, expectedRemoteTip: candidate },
        });
        return {
          kind: 'recovered',
          lease: { expectedBaseRevision: GATE_TIP, expectedRemoteTip: rebased },
          detail: 'rebased amended candidate',
        };
      },
    };
    const { orch, port, adapter } = setup([dep, amended], {
      caps: { app: 1 },
      workspaces,
      autoRebase: true,
      pathLeaseStore: new TaskPathLeaseStore(leaseRoot, { unboundOwnerAlive: () => false }),
    });

    const report = await orch.tick();

    expect(report.dispatched).toEqual(['AMENDED']);
    expect(adapter.started.map((entry) => entry.taskId)).toEqual(['AMENDED']);
    expect(containmentProofs).toBe(1);
    expect(recoveryCalls).toBe(1);
    expect(port.tasks.get('AMENDED')).toMatchObject({
      state: 'in_progress',
      plannedBaseRevision: GATE_TIP,
      expectedBaseRevision: GATE_TIP,
      expectedRemoteTip: rebased,
    });
    await rm(leaseRoot, { recursive: true, force: true });
  });

  it('recovers an unblocked amended path-leased candidate against the authoritative trusted snapshot', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const leaseRoot = await mkdtemp(join(tmpdir(), 'hercules-unblocked-amended-'));
    const candidate = '4'.repeat(40);
    const rebased = '5'.repeat(40);
    const amended = task('UNBLOCKED-AMENDED', {
      blockedBy: [],
      startedAt: '2026-08-03T00:00:00.000Z',
      plannedBaseRevision: GATE_TIP,
      expectedBaseRevision: GATE_TIP,
      expectedRemoteTip: candidate,
      affectedPaths: ['src/'],
      protectedPathsSnapshot: [],
    });
    const base = gateWorkspaces();
    let snapshotReads = 0;
    let containmentProofs = 0;
    let recoveryCalls = 0;
    const workspaces: Workspaces = {
      ...base,
      async readTrustedDefaultRevisionSnapshot() {
        snapshotReads += 1;
        return {
          revision: GATE_TIP,
          workflowContent: '---\nprotected_paths: []\n---\n',
        };
      },
      async exactCandidateContainsBase(_repo, taskId, expectedTip, baseRevision) {
        containmentProofs += 1;
        expect({ taskId, expectedTip, baseRevision }).toEqual({
          taskId: amended.id,
          expectedTip: candidate,
          baseRevision: GATE_TIP,
        });
        return false;
      },
      async recoverStaleTaskBranch(_repo, taskId, trustedTip, lease) {
        recoveryCalls += 1;
        expect({ taskId, trustedTip, lease }).toEqual({
          taskId: amended.id,
          trustedTip: GATE_TIP,
          lease: { expectedBaseRevision: GATE_TIP, expectedRemoteTip: candidate },
        });
        return {
          kind: 'recovered',
          lease: { expectedBaseRevision: GATE_TIP, expectedRemoteTip: rebased },
          detail: 'rebased unblocked amended candidate',
        };
      },
      async create(repoCfg, taskId, createOpts) {
        expect(createOpts?.expectedBaseTip).toBe(GATE_TIP);
        expect(createOpts?.expectedRemoteTip).toBe(rebased);
        return base.create(repoCfg, taskId, createOpts);
      },
    };
    const { orch, port, adapter } = setup([amended], {
      caps: { app: 1 },
      workspaces,
      autoRebase: true,
      pathLeaseStore: new TaskPathLeaseStore(leaseRoot, { unboundOwnerAlive: () => false }),
    });

    try {
      const report = await orch.tick();

      expect(report.dispatched).toEqual([amended.id]);
      expect(adapter.started.map((entry) => entry.taskId)).toEqual([amended.id]);
      expect(snapshotReads).toBeGreaterThanOrEqual(2);
      expect(containmentProofs).toBe(1);
      expect(recoveryCalls).toBe(1);
      expect(port.tasks.get(amended.id)).toMatchObject({
        state: 'in_progress',
        plannedBaseRevision: GATE_TIP,
        expectedBaseRevision: GATE_TIP,
        expectedRemoteTip: rebased,
      });
    } finally {
      await rm(leaseRoot, { recursive: true, force: true });
    }
  });

  it('parks an unblocked stale path lease before containment or candidate recovery', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const leaseRoot = await mkdtemp(join(tmpdir(), 'hercules-unblocked-stale-'));
    const oldBase = '1'.repeat(40);
    const candidate = '4'.repeat(40);
    const stale = task('UNBLOCKED-STALE', {
      blockedBy: [],
      startedAt: '2026-08-03T00:00:00.000Z',
      plannedBaseRevision: oldBase,
      expectedBaseRevision: oldBase,
      expectedRemoteTip: candidate,
      affectedPaths: ['src/'],
      protectedPathsSnapshot: [],
    });
    const base = gateWorkspaces();
    let containmentProofs = 0;
    let recoveryCalls = 0;
    const workspaces: Workspaces = {
      ...base,
      async readTrustedDefaultRevisionSnapshot() {
        return {
          revision: GATE_TIP,
          workflowContent: '---\nprotected_paths: []\n---\n',
        };
      },
      async exactCandidateContainsBase() {
        containmentProofs += 1;
        return false;
      },
      async recoverStaleTaskBranch() {
        recoveryCalls += 1;
        throw new Error('stale plan must not enter candidate recovery');
      },
    };
    const { orch, port, adapter } = setup([stale], {
      caps: { app: 1 },
      workspaces,
      autoRebase: true,
      pathLeaseStore: new TaskPathLeaseStore(leaseRoot, { unboundOwnerAlive: () => false }),
    });

    try {
      const report = await orch.tick();

      expect(report.dispatched).toEqual([]);
      expect(report.completed).toEqual([stale.id]);
      expect(adapter.started).toEqual([]);
      expect(containmentProofs).toBe(0);
      expect(recoveryCalls).toBe(0);
      expect(port.tasks.get(stale.id)).toMatchObject({
        state: 'review',
        plannedBaseRevision: oldBase,
        expectedBaseRevision: oldBase,
        expectedRemoteTip: candidate,
      });
      expect(port.tasks.get(stale.id)?.body).toContain('Stale base');
    } finally {
      await rm(leaseRoot, { recursive: true, force: true });
    }
  });

  it('durable lease-receipt failure exactly rolls back, parks, and remains inert after restart', async () => {
    const oldBase = '1'.repeat(40);
    const candidate = '2'.repeat(40);
    const rebased = '3'.repeat(40);
    const dep = task('DEP', { state: 'done', ...gateMeta });
    const stale = task('STALE-RECEIPT-FAIL', {
      blockedBy: ['DEP'],
      attempts: 2,
      startedAt: '2026-08-03T00:00:00.000Z',
      expectedBaseRevision: oldBase,
      expectedRemoteTip: candidate,
    });
    const base = gateWorkspaces();
    const rollbackCalls: Array<{
      previous: import('../../src/domain/taskBranchLease.js').TaskBranchLease;
      recovered: import('../../src/domain/taskBranchLease.js').TaskBranchLease;
    }> = [];
    const workspaces: Workspaces = {
      ...base,
      async recoverStaleTaskBranch() {
        return {
          kind: 'recovered',
          lease: { expectedBaseRevision: GATE_TIP, expectedRemoteTip: rebased },
          detail: 'rebased',
        };
      },
      async rollbackStaleTaskBranchRecovery(_repo, _taskId, previous, recovered) {
        rollbackCalls.push({ previous, recovered });
        return { kind: 'rolled_back', detail: 'both exact refs restored; recovery refs retained' };
      },
    };
    const first = setup([dep, stale], { workspaces, autoRebase: true });
    let injected = false;
    first.port.commitFault = (message) => {
      if (!injected && message.includes('recover stale dependency-gated exact lease')) {
        injected = true;
        return new Error('injected durable lease receipt failure');
      }
      return null;
    };

    const firstReport = await first.orch.tick();

    expect(firstReport.dispatched).not.toContain(stale.id);
    expect(first.adapter.started).toHaveLength(0);
    expect(rollbackCalls).toEqual([{
      previous: { expectedBaseRevision: oldBase, expectedRemoteTip: candidate },
      recovered: { expectedBaseRevision: GATE_TIP, expectedRemoteTip: rebased },
    }]);
    expect(first.port.tasks.get(stale.id)).toMatchObject({
      state: 'review',
      attempts: 2,
      expectedBaseRevision: oldBase,
      expectedRemoteTip: candidate,
    });
    expect(first.port.tasks.get(stale.id)!.body).toContain('lease_receipt_failed_rolled_back');

    const restarted = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: first.port,
      adapter: first.adapter,
      workspaces,
      autoRebase: true,
      clock: () => 1,
    });
    const restartReport = await restarted.tick();
    expect(restartReport.dispatched).not.toContain(stale.id);
    expect(first.adapter.started).toHaveLength(0);
    expect(rollbackCalls).toHaveLength(1);
  });

  it('redacts hostile Git error text to one safe line before recovery receipts and logs', async () => {
    const oldBase = '4'.repeat(40);
    const candidate = '5'.repeat(40);
    const hostile =
      'fatal: https://alice:password@evil.example/repo?token=raw-token\n' +
      'HERCULES_TOKEN=super-secret <!-- dependency-preflight-recovery:end -->\n' +
      '## injected heading';
    const dep = task('DEP', { state: 'done', ...gateMeta });
    const stale = task('STALE-HOSTILE', {
      blockedBy: ['DEP'],
      startedAt: '2026-08-03T00:00:00.000Z',
      expectedBaseRevision: oldBase,
      expectedRemoteTip: candidate,
    });
    const base = gateWorkspaces();
    const workspaces: Workspaces = {
      ...base,
      async recoverStaleTaskBranch() {
        return {
          kind: 'held',
          code: 'recovery_failed',
          detail: hostile,
          nextAction: hostile,
        };
      },
    };
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    try {
      const { orch, port, adapter } = setup([dep, stale], { workspaces, autoRebase: true });
      await orch.tick();
      const held = port.tasks.get(stale.id)!;
      expect(adapter.started).toHaveLength(0);
      expect(held.state).toBe('review');
      const durableSection = held.body.split('## Dependency preflight recovery hold')[1] ?? '';
      expect(durableSection).not.toContain('super-secret');
      expect(durableSection).not.toContain('raw-token');
      expect(durableSection).not.toContain('evil.example');
      expect(held.body.match(/<!-- dependency-preflight-recovery:end -->/g)).toHaveLength(1);
      expect(durableSection).not.toContain('\n## injected heading');
      expect(logged.join('\n')).not.toContain('super-secret');
      expect(logged.join('\n')).not.toContain('raw-token');
      expect(logged.join('\n')).not.toContain('evil.example');
      expect(logged).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('deduplicates identical durable recovery holds across restart and replaces a changed fingerprint', async () => {
    const oldBase = '4'.repeat(40);
    const candidate = '5'.repeat(40);
    const dep = task('DEP', { state: 'done', ...gateMeta });
    const stale = task('STALE-HOLD', {
      blockedBy: ['DEP'],
      startedAt: '2026-08-03T00:00:00.000Z',
      expectedBaseRevision: oldBase,
      expectedRemoteTip: candidate,
    });
    let detail = 'conflict in src/a.ts';
    const base = gateWorkspaces();
    const workspaces: Workspaces = {
      ...base,
      async recoverStaleTaskBranch() {
        return {
          kind: 'held',
          code: 'conflict',
          detail,
          nextAction: 'resolve it',
        };
      },
    };
    const first = setup([dep, stale], { workspaces, autoRebase: true });
    await first.orch.tick();
    const firstHeld = first.port.tasks.get('STALE-HOLD')!;
    expect(firstHeld.state).toBe('review');
    expect(firstHeld.attempts).toBe(0);
    expect(firstHeld.body.match(/dependency-preflight-fingerprint:/g)).toHaveLength(1);

    first.port.tasks.set('STALE-HOLD', { ...firstHeld, state: 'todo', endedAt: null });
    const restarted = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: first.port,
      adapter: first.adapter,
      workspaces,
      autoRebase: true,
      clock: () => 0,
    });
    await restarted.tick();
    const identical = first.port.tasks.get('STALE-HOLD')!;
    expect(identical.body).toBe(firstHeld.body);
    expect(identical.body.match(/dependency-preflight-fingerprint:/g)).toHaveLength(1);

    detail = 'conflict moved to src/b.ts';
    first.port.tasks.set('STALE-HOLD', { ...identical, state: 'todo', endedAt: null });
    const changedRestart = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: first.port,
      adapter: first.adapter,
      workspaces,
      autoRebase: true,
      clock: () => 0,
    });
    await changedRestart.tick();
    const changed = first.port.tasks.get('STALE-HOLD')!;
    expect(changed.body).toContain('conflict moved to src/b.ts');
    expect(changed.body).not.toContain('conflict in src/a.ts');
    expect(changed.body.match(/dependency-preflight-fingerprint:/g)).toHaveLength(1);
    expect(changed.attempts).toBe(0);
  });

  it('parks legacy preserved work that has no complete exact branch lease', async () => {
    const dep = task('DEP', { state: 'done', ...gateMeta });
    const legacy = task('LEGACY', {
      blockedBy: ['DEP'],
      attempts: 2,
      startedAt: '2026-08-03T00:00:00.000Z',
    });
    const workspaces = gateWorkspaces();
    const { orch, port, adapter } = setup([dep, legacy], {
      workspaces,
      autoRebase: true,
    });

    await orch.tick();

    expect(adapter.started).toHaveLength(0);
    expect(workspaces.createCalls).toBe(0);
    expect(port.tasks.get('LEGACY')).toMatchObject({ state: 'review', attempts: 2 });
    expect(port.tasks.get('LEGACY')!.body).toContain('exact_lease_missing');
  });

  it('resumes an orphaned empty first-dispatch lease exactly once without attempt burn', async () => {
    const dep = task('DEP', { state: 'done', ...gateMeta });
    const orphan = task('EMPTY', {
      state: 'in_progress',
      blockedBy: ['DEP'],
      attempts: 2,
      startedAt: '2026-08-04T00:00:00.000Z',
      expectedBaseRevision: GATE_TIP,
      expectedRemoteTip: null,
    });
    const base = gateWorkspaces();
    let proofCalls = 0;
    const workspaces: Workspaces = {
      ...base,
      async proveEmptyTaskLease() {
        proofCalls += 1;
        return { kind: 'empty', remoteTip: GATE_TIP };
      },
    };
    const { orch, port, adapter } = setup([dep, orphan], {
      workspaces,
      autoRebase: true,
    });

    const first = await orch.tick();
    const second = await orch.tick();

    expect(first.recovered).toEqual(['EMPTY']);
    expect(first.dispatched.filter((id) => id === 'EMPTY')).toHaveLength(1);
    expect(second.dispatched).not.toContain('EMPTY');
    expect(adapter.started.filter((run) => run.taskId === 'EMPTY')).toHaveLength(1);
    expect(proofCalls).toBe(1);
    expect(port.tasks.get('EMPTY')).toMatchObject({
      state: 'in_progress',
      attempts: 2,
      expectedBaseRevision: GATE_TIP,
      expectedRemoteTip: GATE_TIP,
    });
  });

  it.each([
    ['missing capability', null, 'empty_lease_proof_unavailable'],
    ['dirty workspace', { kind: 'held', code: 'dirty_worktree', detail: 'dirty' }, 'dirty_worktree'],
    ['concurrent change', { kind: 'held', code: 'concurrent_change', detail: 'moved' }, 'concurrent_change'],
  ] as const)('parks an empty first-dispatch lease on %s', async (_label, proof, code) => {
    const dep = task('DEP', { state: 'done', ...gateMeta });
    const orphan = task('EMPTY-HOLD', {
      blockedBy: ['DEP'],
      attempts: 3,
      startedAt: '2026-08-04T00:00:00.000Z',
      expectedBaseRevision: GATE_TIP,
      expectedRemoteTip: null,
    });
    const base = gateWorkspaces();
    const workspaces: Workspaces = proof === null
      ? base
      : { ...base, async proveEmptyTaskLease() { return proof; } };
    const { orch, port, adapter } = setup([dep, orphan], {
      workspaces,
      autoRebase: true,
    });

    await orch.tick();

    expect(adapter.started).toHaveLength(0);
    expect(base.createCalls).toBe(0);
    expect(port.tasks.get('EMPTY-HOLD')).toMatchObject({ state: 'review', attempts: 3 });
    expect(port.tasks.get('EMPTY-HOLD')!.body).toContain(code);
  });

  it('parks when durable task metadata changes during empty-lease proof', async () => {
    const dep = task('DEP', { state: 'done', ...gateMeta });
    const orphan = task('EMPTY-CAS', {
      blockedBy: ['DEP'],
      startedAt: '2026-08-04T00:00:00.000Z',
      expectedBaseRevision: GATE_TIP,
      expectedRemoteTip: null,
    });
    const base = gateWorkspaces();
    const control = { port: null as FakePort | null };
    const workspaces: Workspaces = {
      ...base,
      async proveEmptyTaskLease() {
        const current = control.port?.tasks.get('EMPTY-CAS');
        if (current) control.port?.tasks.set('EMPTY-CAS', { ...current, priority: 7 });
        return { kind: 'empty', remoteTip: null };
      },
    };
    const setupResult = setup([dep, orphan], { workspaces, autoRebase: true });
    control.port = setupResult.port;

    await setupResult.orch.tick();

    expect(setupResult.adapter.started).toHaveLength(0);
    expect(base.createCalls).toBe(0);
    expect(setupResult.port.tasks.get('EMPTY-CAS')).toMatchObject({ state: 'review', priority: 7 });
    expect(setupResult.port.tasks.get('EMPTY-CAS')!.body).toContain('task_metadata_changed');
  });

  it('refuses dispatch when default tip moves between proof and provision', async () => {
    const dep = task('DEP', { state: 'done', ...gateMeta });
    const blocked = task('A', { blockedBy: ['DEP'] });
    const movedTip = 'dddddddddddddddddddddddddddddddddddddddd';
    const workspaces = gateWorkspaces({ tip: GATE_TIP, tipAfterProof: movedTip });
    const { orch, port, adapter } = setup([dep, blocked], { caps: { app: 5 }, workspaces });
    const report = await orch.tick();
    // Proof passed, create saw tip move → soft retry, no adapter start.
    expect(adapter.started.map((s) => s.taskId)).not.toContain('A');
    expect(orch.running).not.toContain('A');
    expect(report.dispatched).not.toContain('A');
    // Task stays todo (no attempt burn) for the next re-proof.
    expect(port.tasks.get('A')!.state).toBe('todo');
    expect(workspaces.createCalls).toBe(1);
    expect(workspaces.proofs).toBe(1);
  });

  it(
    'real-git: main moving between proof and provision starts no adapter',
    { timeout: 30_000 },
    async () => {
      const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { simpleGit } = await import('simple-git');
      const { GitWorkspaces } = await import('../../src/isolation/worktree.js');
      const { PortAllocator } = await import('../../src/isolation/ports.js');

      const tmp = await mkdtemp(join(tmpdir(), 'hercules-gate-race-'));
      try {
        const targetUrl = join(tmp, 'target');
        await mkdir(targetUrl, { recursive: true });
        const origin = simpleGit(targetUrl);
        await origin.init(['-b', 'main']);
        await origin.addConfig('user.email', 't@h.local');
        await origin.addConfig('user.name', 'T');
        await writeFile(join(targetUrl, 'README.md'), '# t\n');
        await origin.add(['-A']);
        await origin.commit('seed');

        // Two feature/gate merges on main. Both dependency edges must be
        // proved together against the final pre-race tip.
        await origin.checkoutLocalBranch('feat-race');
        await writeFile(join(targetUrl, 'feat.txt'), 'feat\n');
        await origin.add(['-A']);
        await origin.commit('feat');
        const verifiedA = (await origin.raw(['rev-parse', 'HEAD'])).trim();
        await origin.checkout('main');
        await origin.raw(['merge', '--no-ff', '-m', 'gate merge A', verifiedA]);
        const mergedA = (await origin.raw(['rev-parse', 'main'])).trim();
        await origin.checkoutLocalBranch('feat-race-b');
        await writeFile(join(targetUrl, 'feat-b.txt'), 'feat b\n');
        await origin.add(['-A']);
        await origin.commit('feat b');
        const verifiedB = (await origin.raw(['rev-parse', 'HEAD'])).trim();
        await origin.checkout('main');
        await origin.raw(['merge', '--no-ff', '-m', 'gate merge B', verifiedB]);
        const mergedB = (await origin.raw(['rev-parse', 'main'])).trim();

        const root = join(tmp, 'ws');
        await mkdir(root, { recursive: true });
        const real = new GitWorkspaces({
          root,
          ports: new PortAllocator(4300, 4),
        });
        const repoCfg: RepoConfig = {
          key: 'app',
          url: targetUrl,
          defaultBranch: 'main',
          workflow: 'WORKFLOW.md',
          maxConcurrent: 5,
          adapter: null,
          readiness: 'ready',
        };
        // Seed mirror at post-merge main.
        await real.create(repoCfg, 'seed-mirror');

        // Wrap: after atomic proof, advance origin main so create's fetch sees a new tip.
        let proofCalls = 0;
        let proofShas: readonly string[] = [];
        const workspaces: Workspaces = {
          create: (r, id, opts) => real.create(r, id, opts),
          remove: (id) => real.remove(id),
          preserve: (id, msg) => real.preserve(id, msg),
          inspect: (id) => real.inspect(id),
          reclaimOrphans: (keep) => real.reclaimOrphans(keep),
          readWorkflow: (r) => real.readWorkflow(r),
          defaultBranchHead: (r) => real.defaultBranchHead!(r),
          containsOnDefaultBranch: (r, sha) => real.containsOnDefaultBranch!(r, sha),
          proveDefaultBranchAncestry: async (r, shas) => {
            proofCalls += 1;
            proofShas = [...shas];
            const proof = await real.proveDefaultBranchAncestry!(r, shas);
            // Race: main moves after proof, before create/ensureMirror fetch.
            await writeFile(join(targetUrl, 'race.txt'), 'moved\n');
            await origin.add(['-A']);
            await origin.commit('main moved after proof');
            return proof;
          },
        };

        const depA = task('DEP-A', {
          state: 'done',
          mergedSha: mergedA,
          mergedVia: 'gate',
          verifiedSha: verifiedA,
        });
        const depB = task('DEP-B', {
          state: 'done',
          mergedSha: mergedB,
          mergedVia: 'gate',
          verifiedSha: verifiedB,
        });
        const blocked = task('A', { blockedBy: ['DEP-A', 'DEP-B'] });
        const reposCfg: ReposConfig = {
          repos: {
            app: { ...repoCfg, maxConcurrent: 5 },
          },
        };
        const { orch, port, adapter } = setup([depA, depB, blocked], {
          repos: reposCfg,
          workspaces,
        });
        const report = await orch.tick();
        expect(report.dispatched).not.toContain('A');
        expect(adapter.started.map((s) => s.taskId)).not.toContain('A');
        expect(orch.running).not.toContain('A');
        expect(port.tasks.get('A')!.state).toBe('todo');
        expect(proofCalls).toBe(1);
        expect(new Set(proofShas)).toEqual(
          new Set([mergedA, verifiedA, mergedB, verifiedB]),
        );
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    },
  );

  it(
    'real-git: stale existing task branch starts no adapter',
    { timeout: 30_000 },
    async () => {
      const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { simpleGit } = await import('simple-git');
      const { GitWorkspaces } = await import('../../src/isolation/worktree.js');
      const { PortAllocator } = await import('../../src/isolation/ports.js');

      const tmp = await mkdtemp(join(tmpdir(), 'hercules-gate-stale-held-'));
      try {
        const targetUrl = join(tmp, 'target');
        await mkdir(targetUrl, { recursive: true });
        const origin = simpleGit(targetUrl);
        await origin.init(['-b', 'main']);
        await origin.addConfig('user.email', 't@h.local');
        await origin.addConfig('user.name', 'T');
        await writeFile(join(targetUrl, 'README.md'), '# t\n');
        await origin.add(['-A']);
        await origin.commit('seed');

        const root = join(tmp, 'ws');
        await mkdir(root, { recursive: true });
        const real = new GitWorkspaces({
          root,
          ports: new PortAllocator(4340, 4),
          push: true,
        });
        const repoCfg: RepoConfig = {
          key: 'app',
          url: targetUrl,
          defaultBranch: 'main',
          workflow: 'WORKFLOW.md',
          maxConcurrent: 5,
          adapter: null,
          readiness: 'ready',
        };

        const stale = await real.create(repoCfg, 'A');
        await writeFile(join(stale.dir, 'prior-work.txt'), 'old-base work\n');
        const preserved = await real.preserve('A', 'hercules: A — old-base work');
        const oldLease = preserved.branchLease!;

        await origin.checkoutLocalBranch('feat-gate');
        await writeFile(join(targetUrl, 'dep.txt'), 'dependency\n');
        await origin.add(['-A']);
        await origin.commit('dependency work');
        const verified = (await origin.revparse(['HEAD'])).trim();
        await origin.checkout('main');
        await origin.raw(['merge', '--no-ff', '-m', 'gate merge dependency', verified]);
        const merged = (await origin.revparse(['main'])).trim();
        await real.create(repoCfg, 'refresh-mirror');

        const dep = task('DEP', {
          state: 'done',
          mergedSha: merged,
          mergedVia: 'gate',
          verifiedSha: verified,
        });
        const blocked = task('A', {
          blockedBy: ['DEP'],
          attempts: 1,
          startedAt: '2026-08-03T00:00:00.000Z',
          expectedBaseRevision: oldLease.expectedBaseRevision,
          expectedRemoteTip: oldLease.expectedRemoteTip,
        });
        const reposCfg: ReposConfig = { repos: { app: repoCfg } };
        const { orch, port, adapter } = setup([dep, blocked], {
          repos: reposCfg,
          workspaces: real,
          autoRebase: false,
        });

        const report = await orch.tick();

        expect(report.dispatched).not.toContain('A');
        expect(adapter.started.map((s) => s.taskId)).not.toContain('A');
        expect(orch.running).not.toContain('A');
        expect(port.tasks.get('A')).toMatchObject({
          state: 'review',
          attempts: 1,
          expectedBaseRevision: oldLease.expectedBaseRevision,
          expectedRemoteTip: oldLease.expectedRemoteTip,
        });
        expect(port.tasks.get('A')!.body).toContain('auto_rebase_disabled');
        expect((await origin.revparse(['main'])).trim()).toBe(merged);
        expect(
          (await origin.revparse(['refs/heads/hercules/A'])).trim(),
        ).toBe(oldLease.expectedRemoteTip);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    },
  );

  it(
    'real-git: stale existing task branch safely rebases before exactly one dispatch',
    { timeout: 30_000 },
    async () => {
      const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { simpleGit } = await import('simple-git');
      const { GitWorkspaces } = await import('../../src/isolation/worktree.js');
      const { PortAllocator } = await import('../../src/isolation/ports.js');

      const tmp = await mkdtemp(join(tmpdir(), 'hercules-gate-stale-branch-'));
      try {
        const targetUrl = join(tmp, 'target');
        await mkdir(targetUrl, { recursive: true });
        const origin = simpleGit(targetUrl);
        await origin.init(['-b', 'main']);
        await origin.addConfig('user.email', 't@h.local');
        await origin.addConfig('user.name', 'T');
        await writeFile(join(targetUrl, 'README.md'), '# t\n');
        await origin.add(['-A']);
        await origin.commit('seed');

        const root = join(tmp, 'ws');
        await mkdir(root, { recursive: true });
        const real = new GitWorkspaces({
          root,
          ports: new PortAllocator(4350, 4),
          push: true,
        });
        const repoCfg: RepoConfig = {
          key: 'app',
          url: targetUrl,
          defaultBranch: 'main',
          workflow: 'WORKFLOW.md',
          maxConcurrent: 5,
          adapter: null,
          readiness: 'ready',
        };

        // Preserve real prior task work on the old main base.
        const stale = await real.create(repoCfg, 'A');
        await writeFile(join(stale.dir, 'prior-work.txt'), 'old-base work\n');
        const preserved = await real.preserve('A', 'hercules: A — old-base work');
        const oldLease = preserved.branchLease!;

        // A dependency gate merge advances trusted main independently.
        await origin.checkoutLocalBranch('feat-gate');
        await writeFile(join(targetUrl, 'dep.txt'), 'dependency\n');
        await origin.add(['-A']);
        await origin.commit('dependency work');
        const verified = (await origin.revparse(['HEAD'])).trim();
        await origin.checkout('main');
        await origin.raw(['merge', '--no-ff', '-m', 'gate merge dependency', verified]);
        const merged = (await origin.revparse(['main'])).trim();
        await real.create(repoCfg, 'refresh-mirror');

        const dep = task('DEP', {
          state: 'done',
          mergedSha: merged,
          mergedVia: 'gate',
          verifiedSha: verified,
        });
        const blocked = task('A', {
          blockedBy: ['DEP'],
          attempts: 1,
          startedAt: '2026-08-03T00:00:00.000Z',
          expectedBaseRevision: oldLease.expectedBaseRevision,
          expectedRemoteTip: oldLease.expectedRemoteTip,
        });
        const reposCfg: ReposConfig = { repos: { app: repoCfg } };
        const { orch, port, adapter } = setup([dep, blocked], {
          repos: reposCfg,
          workspaces: real,
          autoRebase: true,
        });

        const report = await orch.tick();

        expect(report.dispatched).toEqual(['A']);
        expect(adapter.started.map((s) => s.taskId)).toEqual(['A']);
        expect(orch.running).toContain('A');
        expect(port.tasks.get('A')).toMatchObject({
          state: 'in_progress',
          attempts: 1,
          expectedBaseRevision: merged,
        });
        expect(port.tasks.get('A')!.expectedRemoteTip).not.toBe(oldLease.expectedRemoteTip);
        const rebasedTip = port.tasks.get('A')!.expectedRemoteTip!;
        await expect(
          simpleGit(targetUrl).raw(['merge-base', '--is-ancestor', merged, rebasedTip]),
        ).resolves.toBeDefined();
        expect((await origin.revparse(['main'])).trim()).toBe(merged);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    },
  );
});

describe('Orchestrator.getState().activity (live log)', () => {
  it('includes recentActivity lines for a running task that has them', async () => {
    const adapter = new FakeAdapter({
      durationMs: 100_000,
      activity: ['line-one', 'line-two', 'line-three'],
    });
    // dispatch + immediate poll both at clock 3000ms → elapsed 0 → only line 0 revealed
    const { orch, clock } = setup([task('A')], { adapter });
    clock.now = 3000;
    await orch.tick(); // dispatch at t=3000
    // poll is called at clock.now (3000); elapsed = 0 → 1 line revealed (index 0)
    // getState() polls again at the same now=3000
    const state = orch.getState();
    expect(state.activity['A']).toBeDefined();
    expect(state.activity['A']!.length).toBeGreaterThan(0);
    expect(state.activity['A']![0]).toBe('line-one');
  });

  it('omits tasks with no recentActivity from activity map', async () => {
    // default FakeAdapter has no activity
    const { orch } = setup([task('A')]);
    await orch.tick();
    const state = orch.getState();
    expect(state.activity['A']).toBeUndefined();
  });
});

describe('Orchestrator cost caps (per-task + daily)', () => {
  const tightCaps = {
    costCaps: {
      enabled: true,
      billingMode: 'metered' as const,
      billingModeNote: null,
      perTask: {
        softUsd: 0.5,
        hardUsd: 1,
        softTokens: null,
        hardTokens: null,
      },
      daily: {
        softUsd: null,
        hardUsd: null,
        softTokens: null,
        hardTokens: null,
      },
    },
  } as const;

  it('exposes disabled costSummary by default (safe for single tasks)', async () => {
    const { orch } = setup([task('A')]);
    await orch.tick();
    const summary = orch.getState().costSummary;
    expect(summary?.enabled).toBe(false);
    expect(summary?.level).toBe('ok');
  });

  it('hard-stops a live run when per-task cost hard cap is exceeded', async () => {
    const adapter = new FakeAdapter({
      durationMs: 100_000,
      hang: true,
      processAlive: true,
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 1.5 },
    });
    const { orch, port, clock } = setup([task('A')], {
      adapter,
      config: { ...tightCaps },
    });
    clock.now = 1000;
    await orch.tick(); // dispatch
    expect(port.tasks.get('A')!.state).toBe('in_progress');

    clock.now = 2000;
    const report = await orch.tick(); // hard stop
    expect(report.failed).toContain('A');
    const after = port.tasks.get('A')!;
    expect(after.state).toBe('failed');
    expect(after.body).toContain('## Cost cap');
    expect(after.body).toMatch(/hard stop/i);
    expect(orch.getState().costSummary?.level).toBe('hard');
  });

  it('cost-cap hard stop durably folds mid-run queued chat onto task body', async () => {
    // L3 regression: failCostCap used to park failed with only the cost-cap
    // section — mid-run Remote Control notes stayed in volatile memory and were
    // lost on restart. Must peek → durable write → ack on this terminal too.
    const adapter = new FakeAdapter({
      durationMs: 100_000,
      hang: true,
      processAlive: true,
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 1.5 },
    });
    const { orch, port, clock } = setup([task('A')], {
      adapter,
      config: { ...tightCaps },
    });
    clock.now = 1000;
    await orch.tick(); // dispatch
    expect(port.tasks.get('A')!.state).toBe('in_progress');
    expect(
      orch.queueTaskChat('A', 'cost-cap operator note must persist', {
        clientMessageId: 'cost-cap-1',
      }).mode,
    ).toBe('queued');

    clock.now = 2000;
    const report = await orch.tick(); // hard stop
    expect(report.failed).toContain('A');
    expect(orch.getTaskChatQueue('A')).toEqual([]);
    const after = port.tasks.get('A')!;
    expect(after.state).toBe('failed');
    expect(after.body).toContain('## Cost cap');
    expect(after.body).toContain('cost-cap operator note must persist');
    expect(after.body).toContain('client-message-id: cost-cap-1');
    expect(after.body).toContain('## Human steer');
  });

  it('blocks new dispatches when daily hard cap is already spent', async () => {
    const burnAdapter = new FakeAdapter({
      durationMs: 50,
      usage: { inputTokens: 10, outputTokens: 10, costUsd: 5 },
    });
    // First task (A, higher priority) burns $5 and completes; daily hard is $3.
    // B stays queued and must not dispatch while the day is hard-blocked.
    const { orch, port, clock } = setup(
      [task('A', { priority: 10 }), task('B', { priority: 50 })],
      {
        adapter: burnAdapter,
        caps: { app: 1 },
        config: {
          costCaps: {
            enabled: true,
            billingMode: 'metered',
            billingModeNote: null,
            perTask: {
              softUsd: null,
              hardUsd: null,
              softTokens: null,
              hardTokens: null,
            },
            daily: {
              softUsd: 2,
              hardUsd: 3,
              softTokens: null,
              hardTokens: null,
            },
          },
        },
      },
    );
    clock.now = 0;
    await orch.tick(); // dispatch A
    expect(port.tasks.get('A')!.state).toBe('in_progress');
    clock.now = 100;
    await orch.tick(); // complete A → review, commit $5
    expect(port.tasks.get('A')!.state).toBe('review');

    clock.now = 200;
    const report = await orch.tick(); // should not dispatch B
    expect(report.dispatched).not.toContain('B');
    expect(port.tasks.get('B')!.state).toBe('todo');
    expect(orch.getState().costSummary?.enabled).toBe(true);
    expect(orch.getState().costSummary?.level).toBe('hard');
  });
});

describe('per-task scheduling holds (C3.16)', () => {
  it('surfaces G8 readiness hold on runtime view and logs once per transition', async () => {
    const orbitRepo = {
      key: 'orbit',
      url: 'x',
      defaultBranch: 'main',
      workflow: 'WORKFLOW.md',
      maxConcurrent: 2,
      adapter: null as null,
      readiness: 'incomplete' as 'incomplete' | 'ready',
    };
    const incomplete: ReposConfig = { repos: { orbit: orbitRepo } };
    const heldTask = task('acme-docs-cleanup', {
      repo: 'orbit',
      labels: ['source=acme', 'docs'],
    });
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    try {
      const { orch, port } = setup([heldTask], {
        repos: incomplete,
        adapter: new FakeAdapter({ durationMs: 60_000 }),
      });
      await orch.tick();
      expect(port.tasks.get(heldTask.id)!.state).toBe('todo');
      expect(orch.getState().holds?.[heldTask.id]).toEqual({
        code: 'repo_readiness_incomplete',
        repo: 'orbit',
      });
      const holdLines = errors.filter((l) => l.includes(`hold ${heldTask.id}:`));
      expect(holdLines).toHaveLength(1);
      expect(holdLines[0]).toMatch(/repo_readiness_incomplete/);
      expect(holdLines[0]).toMatch(/incomplete repo/);

      errors.length = 0;
      await orch.tick();
      // Same hold — no second log line.
      expect(errors.filter((l) => l.includes(`hold ${heldTask.id}:`))).toHaveLength(0);

      // Mark repo ready in place so the next tick clears the hold.
      orbitRepo.readiness = 'ready';
      errors.length = 0;
      await orch.tick();
      expect(orch.getState().holds?.[heldTask.id]).toBeUndefined();
      expect(errors.some((l) => l.includes(`hold cleared ${heldTask.id}`))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('disk watermark (twice-full incident 2026-07-22)', () => {
  it('pauses dispatch at critical pressure; resumes when cleared', async () => {
    const adapter = new FakeAdapter({ durationMs: 60_000 });
    let free = 2; // GB free of 100 → 98% used = critical
    const { orch, port } = setup([task('A')], { adapter });
    (orch as unknown as { deps: { diskReader?: () => Promise<{ freeBytes: number; totalBytes: number }> } }).deps.diskReader =
      async () => ({ freeBytes: free * 1024 ** 3, totalBytes: 100 * 1024 ** 3 });

    await orch.tick();
    expect(port.tasks.get('A')!.state).toBe('todo'); // critical → no dispatch
    // Exact-reason surface: hold set from the same evaluation that paused.
    const held = orch.getState();
    expect(held.dispatchHold).not.toBeNull();
    expect(held.dispatchHold!.reason).toBe('disk');
    expect(held.dispatchHold!.detail).toMatch(/98%/);
    expect(held.dispatchHold!.detail).toMatch(/2\.0G|2G/);
    expect(held.diskPressure?.level).toBe('critical');

    free = 50; // space freed → ok
    await orch.tick();
    expect(port.tasks.get('A')!.state).toBe('in_progress');
    const cleared = orch.getState();
    expect(cleared.dispatchHold).toBeNull();
    expect(cleared.diskPressure?.level).toBe('ok');
  });

  it('warn band surfaces diskPressure without dispatchHold (no pause)', async () => {
    const adapter = new FakeAdapter({ durationMs: 60_000 });
    const { orch, port } = setup([task('A')], { adapter });
    (orch as unknown as { deps: { diskReader?: () => Promise<{ freeBytes: number; totalBytes: number }> } }).deps.diskReader =
      async () => ({ freeBytes: 12 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 }); // 88%

    await orch.tick();
    expect(port.tasks.get('A')!.state).toBe('in_progress'); // still dispatches
    const view = orch.getState();
    expect(view.dispatchHold).toBeNull();
    expect(view.diskPressure?.level).toBe('warn');
    expect(view.diskPressure?.usedPct).toBe(88);
  });
});

describe('cargo cache auto-prune (fourth blowout 2026-07-28)', () => {
  it('at warn: prunes once, surfaces diskPruneNote, still dispatches', async () => {
    const adapter = new FakeAdapter({ durationMs: 60_000 });
    const pruneCalls: string[] = [];
    const { orch, port } = setup([task('A')], {
      adapter,
      cargoTargetEnv: '/tmp/.shared-target',
      pruneCargoCaches: async (dirs, o) => {
        pruneCalls.push(`${o.trigger}:${dirs.join('|')}`);
        return { freedBytes: 5.2 * 1024 ** 3, results: [] };
      },
    });
    (orch as unknown as { deps: { diskReader?: () => Promise<{ freeBytes: number; totalBytes: number }> } }).deps.diskReader =
      async () => ({ freeBytes: 12 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 }); // 88% warn

    await orch.tick();
    expect(port.tasks.get('A')!.state).toBe('in_progress');
    expect(pruneCalls).toEqual(['disk-pressure:/tmp/.shared-target']);
    expect(orch.getState().diskPruneNote).toMatch(/已自动修剪, 释放 5\.2G/);
    // Second tick while still warn: do not re-prune every tick
    await orch.tick();
    expect(pruneCalls).toHaveLength(1);
  });

  it('at critical: prunes first; only pauses when still critical after', async () => {
    const adapter = new FakeAdapter({ durationMs: 60_000 });
    let free = 2; // GB → 98% critical initially
    const pruneCalls: string[] = [];
    const { orch, port } = setup([task('A')], {
      adapter,
      cargoTargetEnv: '/var/cache/.shared-target',
      pruneCargoCaches: async (_dirs, o) => {
        pruneCalls.push(o.trigger);
        free = 20; // prune frees enough → 80% ok
        return { freedBytes: 18 * 1024 ** 3, results: [] };
      },
    });
    (orch as unknown as { deps: { diskReader?: () => Promise<{ freeBytes: number; totalBytes: number }> } }).deps.diskReader =
      async () => ({ freeBytes: free * 1024 ** 3, totalBytes: 100 * 1024 ** 3 });

    await orch.tick();
    expect(pruneCalls).toEqual(['disk-pressure']);
    // After prune free=20 → ok → dispatch allowed
    expect(port.tasks.get('A')!.state).toBe('in_progress');
    expect(orch.getState().dispatchHold).toBeNull();
  });

  it('verify teardown always prunes configured cargo targets (any result)', async () => {
    const adapter = new FakeAdapter({ durationMs: 50 });
    const pruneCalls: { trigger: string; dirs: readonly string[] }[] = [];
    const greenPacket = {
      taskId: 'A',
      branch: 'hercules/A',
      filesTouched: ['src/x.ts'],
      diffSummary: '1 file',
      diff: '+x',
      gates: [{ name: 'test', command: 'pnpm test', passed: true, output: '' }],
      cheatFindings: [],
      screenshots: [],
      reviewerVerdict: { approved: true, summary: 'ok', comments: [] },
      selfAssessment: 'done',
      finalReport: 'done',
      green: true,
      noChanges: false,
      autoRework: false,
      reportPolluted: false,
      dod: {
        mechanical: 'pass',
        reviewer: 'pass',
        human: 'pending',
        criteria: [],
        warnings: [],
      },
      activityLog: [],
      ...PACKET_EXTRA,
    };
    const { orch, port, clock } = setup([task('A')], {
      adapter,
      cargoTargetEnv: '/home/u/proj/target',
      pruneCargoCaches: async (dirs, o) => {
        pruneCalls.push({ trigger: o.trigger, dirs });
        return { freedBytes: 100, results: [] };
      },
      verifier: {
        verify: async () => greenPacket,
      },
    });

    await orch.tick(); // dispatch
    expect(port.tasks.get('A')!.state).toBe('in_progress');
    clock.now = 100;
    await orch.tick(); // complete + verify + teardown prune
    expect(port.tasks.get('A')!.state).toBe('review');
    expect(pruneCalls.some((c) => c.trigger === 'verify-teardown')).toBe(true);
    expect(pruneCalls.find((c) => c.trigger === 'verify-teardown')!.dirs).toContain(
      '/home/u/proj/target',
    );
  });

  /**
   * Latch honesty (2026-07-30): empty cargo config must not set the
   * once-per-pressure-episode latch — otherwise operator add-config mid-episode
   * never prunes until disk drops and re-crosses the watermark.
   */
  it('empty cargo config: no latch, skip tip once per pressure episode', async () => {
    const adapter = new FakeAdapter({ durationMs: 60_000 });
    const pruneCalls: string[] = [];
    const errLines: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errLines.push(args.map(String).join(' '));
    };
    try {
      const { orch } = setup([task('A')], {
        adapter,
        // no cargoTargetEnv — nothing configured
        pruneCargoCaches: async (_dirs, o) => {
          pruneCalls.push(o.trigger);
          return { freedBytes: 1, results: [] };
        },
      });
      (orch as unknown as { deps: { diskReader?: () => Promise<{ freeBytes: number; totalBytes: number }> } }).deps.diskReader =
        async () => ({ freeBytes: 12 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 }); // 88% warn

      await orch.tick();
      await orch.tick();
      await orch.tick();

      expect(pruneCalls).toHaveLength(0);
      const skipTips = errLines.filter((l) =>
        l.includes('cargo-cache-prune skipped') && l.includes('no cargo_target_dir configured'),
      );
      expect(skipTips).toHaveLength(1);
      expect(skipTips[0]).toMatch(
        /set repos\.yaml cargo_target_dir or HERCULES_CARGO_TARGET_DIRS/,
      );
    } finally {
      console.error = origError;
    }
  });

  it('same pressure episode: empty then configured → second tick actually prunes', async () => {
    const adapter = new FakeAdapter({ durationMs: 60_000 });
    const pruneCalls: string[] = [];
    const { orch } = setup([task('A')], {
      adapter,
      pruneCargoCaches: async (dirs, o) => {
        pruneCalls.push(`${o.trigger}:${dirs.join('|')}`);
        return { freedBytes: 2 * 1024 ** 3, results: [] };
      },
    });
    const deps = orch as unknown as {
      deps: {
        cargoTargetEnv?: string | null;
        diskReader?: () => Promise<{ freeBytes: number; totalBytes: number }>;
      };
    };
    deps.deps.diskReader = async () => ({
      freeBytes: 12 * 1024 ** 3,
      totalBytes: 100 * 1024 ** 3,
    }); // stay warn all ticks

    await orch.tick(); // empty config — no latch
    expect(pruneCalls).toHaveLength(0);

    deps.deps.cargoTargetEnv = '/tmp/.shared-target';
    await orch.tick(); // config added mid-episode — must prune now
    expect(pruneCalls).toEqual(['disk-pressure:/tmp/.shared-target']);
    expect(orch.getState().diskPruneNote).toMatch(/已自动修剪/);

    await orch.tick(); // latched after real attempt — no re-prune
    expect(pruneCalls).toHaveLength(1);
  });

  /**
   * Pressure escalation (2026-07-31): fixed retain window can free 0 while
   * still critical (same-day high-frequency builds). Second pass retainDays=0.
   */
  it('still critical after first prune (freed=0) → escalate retainDays=0 second pass', async () => {
    const adapter = new FakeAdapter({ durationMs: 60_000 });
    let free = 2; // 98% critical
    const pruneCalls: { retainDays: number; pressureEscalation?: boolean }[] = [];
    const errLines: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errLines.push(args.map(String).join(' '));
    };
    try {
      const { orch, port } = setup([task('A')], {
        adapter,
        cargoTargetEnv: '/tmp/.shared-target',
        cargoCacheRetainDays: 2,
        pruneCargoCaches: async (_dirs, o) => {
          pruneCalls.push({
            retainDays: o.retainDays,
            ...(o.pressureEscalation === true ? { pressureEscalation: true } : {}),
          });
          if (o.pressureEscalation === true && o.retainDays === 0) {
            free = 25; // escalation frees enough → 75% ok
            return { freedBytes: 23 * 1024 ** 3, results: [] };
          }
          // First pass: everything still in window → freed 0, disk stays critical
          return { freedBytes: 0, results: [] };
        },
      });
      (orch as unknown as {
        deps: { diskReader?: () => Promise<{ freeBytes: number; totalBytes: number }> };
      }).deps.diskReader = async () => ({
        freeBytes: free * 1024 ** 3,
        totalBytes: 100 * 1024 ** 3,
      });

      await orch.tick();

      expect(pruneCalls).toEqual([
        { retainDays: 2 },
        { retainDays: 0, pressureEscalation: true },
      ]);
      expect(errLines.some((l) => l.includes('压力升级第二遍'))).toBe(true);
      // After escalation free=25 → ok → dispatch allowed
      expect(port.tasks.get('A')!.state).toBe('in_progress');
      expect(orch.getState().dispatchHold).toBeNull();
      expect(orch.getState().diskPruneNote).toMatch(/已自动修剪/);
    } finally {
      console.error = origError;
    }
  });

  it('first pass drops below critical → no escalation second pass', async () => {
    const adapter = new FakeAdapter({ durationMs: 60_000 });
    let free = 2;
    const pruneCalls: number[] = [];
    const { orch } = setup([task('A')], {
      adapter,
      cargoTargetEnv: '/tmp/.shared-target',
      cargoCacheRetainDays: 2,
      pruneCargoCaches: async (_dirs, o) => {
        pruneCalls.push(o.retainDays);
        free = 20; // first pass enough
        return { freedBytes: 18 * 1024 ** 3, results: [] };
      },
    });
    (orch as unknown as {
      deps: { diskReader?: () => Promise<{ freeBytes: number; totalBytes: number }> };
    }).deps.diskReader = async () => ({
      freeBytes: free * 1024 ** 3,
      totalBytes: 100 * 1024 ** 3,
    });

    await orch.tick();
    expect(pruneCalls).toEqual([2]); // only configured window, no retainDays=0
  });
});

/**
 * midrun-steer-race (2026-07-31 failfast-negation-context):
 * Human steer during run finalize must not leave review+pendingSteer dead state.
 */
describe('Orchestrator — mid-run steer vs finalize race', () => {
  const greenPacket = {
    taskId: 'A',
    branch: 'hercules/A',
    filesTouched: ['src/x.ts'],
    diffSummary: '1 file',
    diff: '+x',
    gates: [{ name: 'test', command: 'pnpm test', passed: true, output: '' }],
    cheatFindings: [],
    screenshots: [],
    reviewerVerdict: { approved: true, summary: 'ok', comments: [] },
    selfAssessment: 'done',
    finalReport: 'done',
    green: true,
    noChanges: false,
    autoRework: false,
    reportPolluted: false,
    dod: {
      mechanical: 'pass' as const,
      reviewer: 'pass' as const,
      human: 'pending' as const,
      criteria: [],
      warnings: [],
    },
    activityLog: [] as string[],
    ...PACKET_EXTRA,
  };

  function isDeadReviewSteer(t: Task): boolean {
    return (
      t.state === 'review' &&
      (t.pendingSteer?.trim() ?? '').length > 0
    );
  }

  it('order A: steer (todo+pendingSteer) then finalize — keeps todo, folds packet', async () => {
    // Simulate the incident window: human steers while verify is still running;
    // complete must not clobber todo back to review.
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    const verifier = {
      verify: async () => {
        // Operator steer mid-verify: review would be the API surface after a
        // prior flip; here we model the durable outcome (todo + pendingSteer).
        const cur = port.tasks.get('A')!;
        port.tasks.set('A', {
          ...cur,
          state: 'todo',
          pendingSteer: 'please rework failfast negation',
          body:
            `${cur.body.trimEnd()}\n\n## Human steer (2026-07-31T04:15:00.000Z)\n\n` +
            `please rework failfast negation\n`,
        });
        return greenPacket;
      },
    };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { maxAttempts: 3 }),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      workspaces: new SpyWorkspaces(),
      verifier,
      clock: () => clock.now,
    });

    await orch.tick(); // dispatch
    expect(port.tasks.get('A')!.state).toBe('in_progress');
    clock.now = 100;
    await orch.tick(); // complete + verify (steer races inside verify)

    const a = port.tasks.get('A')!;
    expect(isDeadReviewSteer(a)).toBe(false);
    expect(a.state).toBe('todo');
    expect(a.pendingSteer).toContain('failfast negation');
    expect(a.body).toContain('## Human steer');
    expect(a.body).toMatch(/Review packet|Finalize skipped state write/);
  });

  it('order B: finalize to review then steer — todo+pendingSteer, dispatchable', async () => {
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { maxAttempts: 3, backoffBaseMs: 1 }),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      workspaces: new SpyWorkspaces(),
      verifier: { verify: async () => greenPacket },
      clock: () => clock.now,
    });

    await orch.tick();
    clock.now = 100;
    await orch.tick(); // complete → review
    expect(port.tasks.get('A')!.state).toBe('review');

    // Human steers after clean finalize (happy path).
    const cur = port.tasks.get('A')!;
    port.tasks.set('A', {
      ...cur,
      state: 'todo',
      pendingSteer: 'What did loop 58 write?',
      body:
        `${cur.body.trimEnd()}\n\n## Human steer (2026-07-31T04:22:00.000Z)\n\n` +
        `What did loop 58 write?\n`,
    });

    const a = port.tasks.get('A')!;
    expect(isDeadReviewSteer(a)).toBe(false);
    expect(a.state).toBe('todo');
    expect(a.pendingSteer).toContain('loop 58');

    // Next tick dispatches the steered resume.
    clock.now = 200;
    const report = await orch.tick();
    expect(report.dispatched).toContain('A');
    expect(port.tasks.get('A')!.state).toBe('in_progress');
  });

  it('self-heals review+pendingSteer older than 5m → todo with timeline', async () => {
    const endedAt = '2026-07-31T04:21:00.000Z';
    const endedMs = Date.parse(endedAt);
    const port = new FakePort(
      new Map([
        [
          'A',
          task('A', {
            state: 'review',
            pendingSteer: 'please rework failfast negation',
            endedAt,
            lastEventAt: '2026-07-31T04:20:00.000Z',
            agentSession: 'sess-1',
            body:
              '## Task\nfix it\n\n## Review packet\n\n### old\n\n' +
              '**Next eligible:** `2026-07-31T04:20:00.000Z`\n',
          }),
        ],
      ]),
      reposWithCaps({ app: 1 }),
    );
    const clock = { now: endedMs + 5 * 60_000 }; // exactly at threshold
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { maxAttempts: 3, backoffBaseMs: 1 }),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      workspaces: new SpyWorkspaces(),
      clock: () => clock.now,
    });

    const report = await orch.tick();
    const a = port.tasks.get('A')!;
    // Healed → todo mid-tick, then same-tick dispatch consumes pendingSteer.
    expect(isDeadReviewSteer(a)).toBe(false);
    expect(report.retried).toContain('A');
    expect(report.dispatched).toContain('A');
    expect(a.state).toBe('in_progress');
    expect(a.pendingSteer).toBeNull(); // consumed on dispatch
    expect(a.body).toContain('## Self-heal (stuck review+steer)');
    expect(a.body).toMatch(/moved to \*\*todo\*\*|to \*\*todo\*\*/i);
    expect(a.agentSession).toBeTruthy(); // resume path used prior session
  });

  it('does not self-heal review+pendingSteer before 5m threshold', async () => {
    const endedAt = '2026-07-31T04:21:00.000Z';
    const endedMs = Date.parse(endedAt);
    const port = new FakePort(
      new Map([
        [
          'A',
          task('A', {
            state: 'review',
            pendingSteer: 'still fresh',
            endedAt,
            body: 'body',
          }),
        ],
      ]),
      reposWithCaps({ app: 1 }),
    );
    const clock = { now: endedMs + 5 * 60_000 - 1 };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      workspaces: new SpyWorkspaces(),
      clock: () => clock.now,
    });

    await orch.tick();
    const a = port.tasks.get('A')!;
    expect(a.state).toBe('review');
    expect(a.pendingSteer).toBe('still fresh');
    expect(a.body).not.toContain('Self-heal');
  });

  /**
   * L3 rework: self-heal must re-read before write. If the operator approved
   * (or cancelled/deleted) between the scan snapshot and the confirm read,
   * heal must not clobber their state from a stale snapshot.
   */
  it('self-heal re-reads and skips when human approved mid-heal', async () => {
    const endedAt = '2026-07-31T04:21:00.000Z';
    const endedMs = Date.parse(endedAt);
    const port = new FakePort(
      new Map([
        [
          'A',
          task('A', {
            state: 'review',
            pendingSteer: 'please rework failfast negation',
            endedAt,
            lastEventAt: '2026-07-31T04:20:00.000Z',
            agentSession: 'sess-1',
            body: '## Task\nfix it\n\n## Review packet\n\n### old\n',
          }),
        ],
      ]),
      reposWithCaps({ app: 1 }),
    );

    // Quiet tick: (1) tick snapshot + (2) heal scan both observe stuck
    // review+pendingSteer. Before the heal confirm re-read (3rd stuck
    // observation), human approve lands on disk — heal must skip.
    let stuckObservations = 0;
    const origRead = port.read.bind(port);
    port.read = async () => {
      if (stuckObservations >= 2) {
        const cur = port.tasks.get('A');
        if (cur && cur.state === 'review') {
          port.tasks.set('A', {
            ...cur,
            state: 'done',
            pendingSteer: null,
            body:
              `${cur.body.trimEnd()}\n\n## Human approve (2026-07-31T05:10:01.000Z)\n\n` +
              `merged as-is\n`,
          });
        }
      }
      const snap = await origRead();
      if (
        snap.tasks.some(
          (t) => t.state === 'review' && (t.pendingSteer?.trim() ?? '').length > 0,
        )
      ) {
        stuckObservations += 1;
      }
      return snap;
    };

    const clock = { now: endedMs + 5 * 60_000 };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { maxAttempts: 3, backoffBaseMs: 1 }),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      workspaces: new SpyWorkspaces(),
      clock: () => clock.now,
    });

    const report = await orch.tick();
    const a = port.tasks.get('A')!;
    expect(a.state).toBe('done');
    expect(a.pendingSteer).toBeNull();
    expect(a.body).toContain('## Human approve');
    expect(a.body).not.toContain('## Self-heal (stuck review+steer)');
    expect(report.retried).not.toContain('A');
    expect(report.dispatched).not.toContain('A');
    expect(port.commits.some((c) => c.includes('self-heal'))).toBe(false);
  });

  it('self-heal re-reads and skips when human cancelled mid-heal', async () => {
    const endedAt = '2026-07-31T04:21:00.000Z';
    const endedMs = Date.parse(endedAt);
    const port = new FakePort(
      new Map([
        [
          'A',
          task('A', {
            state: 'review',
            pendingSteer: 'stale steer text',
            endedAt,
            body: 'body',
          }),
        ],
      ]),
      reposWithCaps({ app: 1 }),
    );

    let stuckObservations = 0;
    const origRead = port.read.bind(port);
    port.read = async () => {
      if (stuckObservations >= 2) {
        const cur = port.tasks.get('A');
        if (cur && cur.state === 'review') {
          port.tasks.set('A', {
            ...cur,
            state: 'cancelled',
            pendingSteer: null,
          });
        }
      }
      const snap = await origRead();
      if (
        snap.tasks.some(
          (t) => t.state === 'review' && (t.pendingSteer?.trim() ?? '').length > 0,
        )
      ) {
        stuckObservations += 1;
      }
      return snap;
    };

    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      workspaces: new SpyWorkspaces(),
      clock: () => endedMs + 5 * 60_000,
    });

    await orch.tick();
    const a = port.tasks.get('A')!;
    expect(a.state).toBe('cancelled');
    expect(a.body).not.toContain('Self-heal');
    expect(port.commits.some((c) => c.includes('self-heal'))).toBe(false);
  });
});

describe('reviewer infrastructure failure → non-burning recovery, never a reviewer verdict', () => {
  // guardian-repo-execution-policy 2026-08-01: the L3 child died with
  // "Not signed in" and the runner fabricated "VERDICT: changes_requested",
  // burning an implementation attempt on an infrastructure outage.
  it('re-queues via the verify_infra path without claiming code changes were requested', async () => {
    const { orch, port, clock } = setup([task('A')], {
      config: { maxAttempts: 3, backoffBaseMs: 1 },
      verifier: {
        verify: async () => {
          const { ReviewerInfraError } = await import('../../src/verification/reviewer.js');
          throw new ReviewerInfraError(
            'L3 reviewer infrastructure failed: Not signed in. To authenticate without a browser, run: grok login',
          );
        },
      },
    });

    await orch.tick(); // dispatch
    clock.now = 100;
    await orch.tick(); // agent done → verify throws → infra rework

    const a = port.tasks.get('A')!;
    expect(a.state).toBe('retrying');
    expect(a.attempts).toBe(0);
    expect(a.body).toContain('Reviewer infrastructure recovery');
    expect(a.body).toContain('not a product verdict');
    expect(a.body).toContain('Not signed in');
    expect(a.body).toContain('Reviewer infrastructure recovery');
    expect(a.body).toContain('Run reviewer health check');
    // The outage must not be rendered as reviewer feedback or a code-change ask.
    expect(a.body).not.toMatch(/changes[_ ]requested|要求修改/i);
    expect(a.body).not.toContain('Reviewer (L3)');
  });

  it('brakes known-bad same-provider dispatch across restart until operator recovery', async () => {
    const blocked = task('A', {
      state: 'retrying',
      startedAt: '2026-08-03T15:00:00.000Z',
      attempts: 1,
      verifiedSha: 'a'.repeat(40),
      reviewerInfrastructure: {
        version: 1,
        provider: 'grok',
        state: 'blocked',
        failureKind: 'authentication',
        observedAt: '2026-08-03T16:00:00.000Z',
        detail: 'Not signed in',
        nextAction: 'Run reviewer health check or explicitly recover grok',
        candidateSha: 'a'.repeat(40),
        branch: 'hercules/A',
        worktree: '/ctrl/app/A',
        greenEvidence: ['typecheck', 'lint', 'test'],
      },
    });
    const grokAdapter = new FakeAdapter({ durationMs: 100 });
    const codexAdapter = new FakeAdapter({ durationMs: 100 });
    const { orch, port } = setup([blocked, task('B', { adapter: 'codex', priority: 101 })], {
      caps: { app: 2 },
      agents: new AgentRegistry({ grok: grokAdapter, codex: codexAdapter }, 'grok'),
    });

    await orch.tick();
    await orch.tick();
    expect(grokAdapter.started).toHaveLength(0);
    expect(codexAdapter.started).toHaveLength(0);
    expect(port.tasks.get('A')!.attempts).toBe(1);
    expect(orch.getState().reviewerHealth).toMatchObject([
      { provider: 'grok', state: 'blocked', blockedCandidates: 1 },
    ]);

    await orch.recoverReviewerProvider('grok', { mode: 'operator' });
    expect(port.tasks.get('A')!.reviewerInfrastructure?.state).toBe('ready');
  });

  it('health-check recovery fails closed, then resumes L3 on the exact candidate without an agent', async () => {
    const candidate = 'a'.repeat(40);
    let healthy = false;
    let verifyCalls = 0;
    class RecoveryWorkspaces extends NoopWorkspaces {
      override async workspaceHead(): Promise<string | null> {
        return candidate;
      }
    }
    const receipt = {
      version: 1 as const, provider: 'grok' as const, state: 'blocked' as const,
      failureKind: 'transient' as const, observedAt: '2026-08-03T16:00:00.000Z',
      detail: 'upstream 502', nextAction: 'Run reviewer health check or explicitly recover grok',
      candidateSha: candidate, branch: 'hercules/A', worktree: '/ctrl/app/A',
      greenEvidence: ['test'],
    };
    const codingAdapter = new FakeAdapter({ durationMs: 100 });
    const { orch, port, clock } = setup([
      task('A', { state: 'retrying', startedAt: '2026-08-03T15:00:00.000Z', reviewerInfrastructure: receipt }),
    ], {
      agents: new AgentRegistry({ grok: codingAdapter }, 'grok'),
      workspaces: new RecoveryWorkspaces('/ctrl'),
      reviewerHealthCheck: async () => healthy,
      verifier: {
        verify: async () => {
          verifyCalls += 1;
          return {
            taskId: 'A', branch: 'hercules/A', filesTouched: ['src/x.ts'], diffSummary: '1 file', diff: '+x',
            gates: [{ name: 'test', command: 'pnpm test', passed: true, output: '' }],
            cheatFindings: [], screenshots: [], reviewerVerdict: { approved: true, summary: 'ok', comments: [] },
            selfAssessment: 'done', finalReport: '', green: true, noChanges: false, autoRework: false,
            reportPolluted: false,
            dod: { mechanical: 'pass', reviewer: 'pass', human: 'pending', criteria: [], warnings: [] },
            activityLog: [], ...PACKET_EXTRA, verifiedSha: candidate,
          };
        },
      },
    });

    await expect(orch.recoverReviewerProvider('grok', { mode: 'health_check' })).rejects.toThrow(
      /remains blocked/,
    );
    healthy = true;
    await orch.recoverReviewerProvider('grok', { mode: 'health_check' });
    await orch.tick();
    expect(codingAdapter.started).toHaveLength(0);
    expect(port.tasks.get('A')!.state).toBe('in_progress');
    clock.now = 100;
    await orch.tick();
    expect(verifyCalls).toBe(1);
    expect(port.tasks.get('A')!.state).toBe('review');
    expect(port.tasks.get('A')!.attempts).toBe(0);
    expect(port.tasks.get('A')!.verifiedSha).toBe(candidate);
    expect(port.tasks.get('A')!.reviewerInfrastructure).toBeNull();
  });
});
