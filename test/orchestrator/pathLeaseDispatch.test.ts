import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator, type ControlPort } from '../../src/orchestrator/orchestrator.js';
import { AgentRegistry } from '../../src/orchestrator/agentRegistry.js';
import { FakeAdapter } from '../../src/orchestrator/fakeAdapter.js';
import type { AgentAdapter } from '../../src/orchestrator/adapter.js';
import { makeConfig } from '../../src/config.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import type { Task, TaskState } from '../../src/domain/task.js';
import type { ReposConfig } from '../../src/domain/repos.js';
import { NoopWorkspaces } from '../../src/isolation/worktree.js';
import { TaskPathLeaseStore } from '../../src/isolation/taskPathLeaseStore.js';

const BASE = 'a'.repeat(40);
const STALE = 'b'.repeat(40);

function repos(over: {
  maxConcurrent?: number;
  guardian?: boolean;
} = {}): ReposConfig {
  return {
    repos: {
      app: {
        key: 'app',
        url: 'x',
        defaultBranch: 'main',
        workflow: 'WORKFLOW.md',
        maxConcurrent: over.maxConcurrent ?? 2,
        adapter: null,
        readiness: 'ready',
        ...(over.guardian
          ? { executionPolicy: { profile: 'guardian' as const } }
          : {}),
      },
    },
  };
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
    lastEventAt: null,
    createdAt: null,
    startedAt: null,
    endedAt: null,
    prUrl: null,
    prStatus: null,
    planPending: false,
    body: 'body',
    ...over,
  };
}

class FakePort implements ControlPort {
  commitError: Error | null = null;
  constructor(
    readonly tasks: Map<string, Task>,
    private readonly reposCfg: ReposConfig,
  ) {}
  async sync(): Promise<void> {}
  async read(): Promise<ControlSnapshot> {
    return {
      repos: this.reposCfg,
      tasks: [...this.tasks.values()],
      problems: [],
    };
  }
  async writeTask(t: Task): Promise<void> {
    this.tasks.set(t.id, t);
  }
  async deleteTask(id: string): Promise<void> {
    this.tasks.delete(id);
  }
  async commit(): Promise<{ committed: boolean }> {
    if (this.commitError) {
      const error = this.commitError;
      this.commitError = null;
      throw error;
    }
    return { committed: true };
  }
  async writeRepos(): Promise<void> {}
}

function processReportingAdapter(
  fake: FakeAdapter,
  pid: number | readonly number[],
  beforeReturn?: () => void,
): AgentAdapter {
  let starts = 0;
  return {
    name: 'codex',
    start(input, now) {
      const run = fake.start(input, now);
      const processPid = typeof pid === 'number' ? pid : pid[Math.min(starts, pid.length - 1)]!;
      starts += 1;
      beforeReturn?.();
      return {
        sessionId: run.sessionId,
        poll: (at) => ({ ...run.poll(at), processPid, processAlive: true }),
        activityLog: () => run.activityLog(),
        finalMessage: () => run.finalMessage(),
        stop: (opts) => run.stop(opts),
      };
    },
  };
}

function workspacesWithTip(tip: string): NoopWorkspaces {
  const base = new NoopWorkspaces('/tmp/noop-ws');
  base.setDefaultBranchTip(tip);
  base.setTrustedWorkflow('---\nprotected_paths: []\n---\n');
  return base;
}

async function makeStore(): Promise<TaskPathLeaseStore> {
  const root = await mkdtemp(join(tmpdir(), 'orch-path-lease-'));
  return new TaskPathLeaseStore(root, {
    readProcessIdentity: (pid) => ({
      pid,
      startTimeTicks: String(pid),
      bootId: '12345678-1234-1234-1234-123456789abc',
    }),
    processGroupIdentityAlive: () => false,
    unboundOwnerAlive: () => false,
  });
}

describe('path lease dispatch (server-side)', () => {
  it('fails closed before adapter start when a required authoritative store is absent', async () => {
    for (const guardian of [true, false]) {
      const adapter = new FakeAdapter({ durationMs: 50 });
      const declared = task(`NO-STORE-${guardian ? 'G' : 'C'}`, {
        plannedBaseRevision: BASE,
        affectedPaths: ['src/a.ts'],
        protectedPathsSnapshot: [],
      });
      const port = new FakePort(new Map([[declared.id, declared]]), repos({ guardian }));
      const orch = new Orchestrator({
        config: makeConfig('/ctrl'),
        control: port,
        agents: AgentRegistry.of(adapter),
        workspaces: workspacesWithTip(BASE),
        clock: () => 0,
      });

      const report = await orch.tick();
      expect(report.dispatched).toEqual([]);
      expect(adapter.started).toHaveLength(0);
      expect(port.tasks.get(declared.id)!.state).toBe('review');
      expect(port.tasks.get(declared.id)!.body).toMatch(/path-lease store unavailable/);
    }
  });

  it('parks Guardian legacy tasks before any agent run', async () => {
    const store = await makeStore();
    const adapter = new FakeAdapter({ durationMs: 50 });
    const port = new FakePort(new Map([['A', task('A')]]), repos({ guardian: true }));
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      agents: AgentRegistry.of(adapter),
      workspaces: workspacesWithTip(BASE),
      pathLeaseStore: store,
      clock: () => 0,
    });
    const report = await orch.tick();
    expect(report.dispatched).toEqual([]);
    expect(port.tasks.get('A')!.state).toBe('review');
    expect(port.tasks.get('A')!.body).toMatch(/Path lease blocked/);
    expect(adapter.started).toHaveLength(0);
  });

  it('parks stale base and soft-skips path overlap before adapter spawn', async () => {
    const store = await makeStore();
    const adapter = new FakeAdapter({ durationMs: 10_000 });
    const port = new FakePort(
      new Map([
        [
          'STALE',
          task('STALE', {
            plannedBaseRevision: STALE,
            affectedPaths: ['docs/stale.md'],
            protectedPathsSnapshot: [],
            priority: 1,
          }),
        ],
        [
          'A',
          task('A', {
            plannedBaseRevision: BASE,
            affectedPaths: ['src/'],
            protectedPathsSnapshot: [],
            priority: 10,
          }),
        ],
        [
          'B',
          task('B', {
            plannedBaseRevision: BASE,
            affectedPaths: ['src/b.ts'],
            protectedPathsSnapshot: [],
            priority: 20,
          }),
        ],
      ]),
      repos({ maxConcurrent: 4 }),
    );
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      agents: AgentRegistry.of(adapter),
      workspaces: workspacesWithTip(BASE),
      pathLeaseStore: store,
      clock: () => 0,
    });
    const report = await orch.tick();
    // Stale base is a permanent park (review). Overlap soft-skips B (still todo).
    expect(port.tasks.get('STALE')!.state).toBe('review');
    expect(port.tasks.get('STALE')!.body).toMatch(/Stale base|Path lease/);
    expect(report.dispatched).toContain('A');
    expect(port.tasks.get('B')!.state).toBe('todo');
    expect(adapter.started.map((s) => s.taskId)).toEqual(['A']);
  });

  it('allows disjoint scopes under maxConcurrent', async () => {
    const store = await makeStore();
    const adapter = new FakeAdapter({ durationMs: 10_000 });
    const port = new FakePort(
      new Map([
        [
          'A',
          task('A', {
            plannedBaseRevision: BASE,
            affectedPaths: ['src/a.ts'],
            protectedPathsSnapshot: [],
          }),
        ],
        [
          'B',
          task('B', {
            plannedBaseRevision: BASE,
            affectedPaths: ['docs/b.md'],
            protectedPathsSnapshot: [],
            priority: 200,
          }),
        ],
      ]),
      repos({ maxConcurrent: 2 }),
    );
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      agents: AgentRegistry.of(adapter),
      workspaces: workspacesWithTip(BASE),
      pathLeaseStore: store,
      clock: () => 0,
    });
    const report = await orch.tick();
    expect(report.dispatched.sort()).toEqual(['A', 'B']);
    expect(await store.list('app')).toHaveLength(2);
    expect(adapter.started).toHaveLength(2);
  });

  it('Guardian enforces single writer even when maxConcurrent allows more', async () => {
    const store = await makeStore();
    const adapter = new FakeAdapter({ durationMs: 10_000 });
    const port = new FakePort(
      new Map([
        [
          'A',
          task('A', {
            plannedBaseRevision: BASE,
            affectedPaths: ['src/a.ts'],
            protectedPathsSnapshot: [],
          }),
        ],
        [
          'B',
          task('B', {
            plannedBaseRevision: BASE,
            affectedPaths: ['docs/b.md'],
            protectedPathsSnapshot: [],
            priority: 200,
          }),
        ],
      ]),
      repos({ maxConcurrent: 4, guardian: true }),
    );
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      agents: AgentRegistry.of(adapter),
      workspaces: workspacesWithTip(BASE),
      pathLeaseStore: store,
      clock: () => 0,
    });
    const report = await orch.tick();
    // selectEligible admits both under maxConcurrent=4, but path lease
    // writer cap=1 soft-skips the second (stays todo) before agent start.
    expect(report.dispatched).toHaveLength(1);
    expect(await store.list('app')).toHaveLength(1);
    const stillQueued = [...port.tasks.values()].filter((t) => t.state === 'todo');
    expect(stillQueued).toHaveLength(1);
    expect(adapter.started).toHaveLength(1);
  });

  it('reclaims stale owners on tick without stealing live tokens', async () => {
    const store = await makeStore();
    await store.acquire('app', {
      taskId: 'GHOST',
      runToken: 'dead-token',
      declaredBaseRevision: BASE,
      declaredPaths: ['src/ghost.ts'],
      declaredProtectedSnapshot: [],
      trustedBaseRevision: BASE,
      currentProtectedPaths: [],
      maxWriters: 2,
      requireDeclarations: true,
      acquiredAtMs: 1,
    });
    await store.bindOwnerProcess('app', 'GHOST', 'dead-token', 999);
    const adapter = new FakeAdapter({ durationMs: 50 });
    const port = new FakePort(
      new Map([
        [
          'A',
          task('A', {
            plannedBaseRevision: BASE,
            affectedPaths: ['src/a.ts'],
            protectedPathsSnapshot: [],
          }),
        ],
      ]),
      repos({ maxConcurrent: 2 }),
    );
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      agents: AgentRegistry.of(adapter),
      workspaces: workspacesWithTip(BASE),
      pathLeaseStore: store,
      clock: () => 0,
    });
    const report = await orch.tick();
    expect(report.dispatched).toEqual(['A']);
    const held = await store.list('app');
    expect(held.every((e) => e.taskId !== 'GHOST')).toBe(true);
    expect(held.some((e) => e.taskId === 'A')).toBe(true);
  });

  it('keeps retrying while its prior live run owns the lease, then dispatches after reclaim', async () => {
    let priorGroupAlive = true;
    const root = await mkdtemp(join(tmpdir(), 'orch-path-lease-prior-'));
    const store = new TaskPathLeaseStore(root, {
      readProcessIdentity: (pid) => ({
        pid,
        startTimeTicks: String(pid),
        bootId: '12345678-1234-1234-1234-123456789abc',
      }),
      processGroupIdentityAlive: () => priorGroupAlive,
      unboundOwnerAlive: () => false,
    });
    await store.acquire('app', {
      taskId: 'A', runToken: 'prior-token', declaredBaseRevision: BASE,
      declaredPaths: ['src/a.ts'], declaredProtectedSnapshot: [], trustedBaseRevision: BASE,
      currentProtectedPaths: [], maxWriters: 2, requireDeclarations: true, acquiredAtMs: 1,
    });
    await store.bindOwnerProcess('app', 'A', 'prior-token', 999);
    const adapter = new FakeAdapter({ durationMs: 10_000 });
    const queued = task('A', {
      state: 'retrying',
      plannedBaseRevision: BASE,
      affectedPaths: ['src/a.ts'],
      protectedPathsSnapshot: [],
    });
    const port = new FakePort(new Map([['A', queued]]), repos());
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'), control: port, agents: AgentRegistry.of(adapter),
      workspaces: workspacesWithTip(BASE), pathLeaseStore: store, clock: () => 0,
    });

    const held = await orch.tick();
    expect(held.dispatched).toEqual([]);
    expect(adapter.started).toHaveLength(0);
    expect(port.tasks.get('A')!.state).toBe('retrying');
    expect((await store.list('app')).map((entry) => entry.runToken)).toEqual(['prior-token']);

    priorGroupAlive = false;
    const resumed = await orch.tick();
    expect(resumed.dispatched).toEqual(['A']);
    expect(adapter.started).toHaveLength(1);
    expect(port.tasks.get('A')!.state).toBe('in_progress');
  });

  it('retains a stopping writer lease through grace and releases only after exit', async () => {
    const store = await makeStore();
    const adapter = new FakeAdapter({ durationMs: 10_000, stopGraceMs: 1_000 });
    const port = new FakePort(
      new Map([['A', task('A', {
        plannedBaseRevision: BASE,
        affectedPaths: ['src/a.ts'],
        protectedPathsSnapshot: [],
      })]]),
      repos({ maxConcurrent: 2 }),
    );
    let now = 0;
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'), control: port, agents: AgentRegistry.of(adapter),
      workspaces: workspacesWithTip(BASE), pathLeaseStore: store, clock: () => now,
    });
    await orch.tick();
    expect(await store.list('app')).toHaveLength(1);
    const running = port.tasks.get('A')!;
    port.tasks.set('A', { ...running, state: 'cancelled', endedAt: new Date(now).toISOString() });
    now = 10;
    await orch.tick();
    expect(orch.getState().stopping).toContain('A');
    expect(await store.list('app')).toHaveLength(1);
    now = 2_000;
    await orch.tick();
    expect(await store.list('app')).toEqual([]);
  });

  it('dispatches first-time one-file WORKFLOW bootstrap when trusted tip has no workflow', async () => {
    const store = await makeStore();
    const adapter = new FakeAdapter({ durationMs: 10_000 });
    const port = new FakePort(
      new Map([
        [
          'BOOT',
          task('BOOT', {
            plannedBaseRevision: BASE,
            affectedPaths: ['WORKFLOW.md'],
            protectedPathsSnapshot: [],
            labels: ['onboarding', 'readiness'],
          }),
        ],
      ]),
      {
        repos: {
          app: {
            key: 'app',
            url: 'x',
            defaultBranch: 'main',
            workflow: 'WORKFLOW.md',
            maxConcurrent: 1,
            adapter: null,
            readiness: 'incomplete',
            executionPolicy: { profile: 'guardian' as const },
          },
        },
      },
    );
    const ws = workspacesWithTip(BASE);
    ws.setTrustedWorkflow(null);
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      agents: AgentRegistry.of(adapter),
      workspaces: ws,
      pathLeaseStore: store,
      clock: () => 0,
    });
    const report = await orch.tick();
    expect(report.dispatched).toEqual(['BOOT']);
    expect(adapter.started).toHaveLength(1);
    expect(await store.list('app')).toHaveLength(1);
  });

  it('parks non-bootstrap tasks when trusted WORKFLOW is missing', async () => {
    const store = await makeStore();
    const adapter = new FakeAdapter({ durationMs: 50 });
    const port = new FakePort(
      new Map([
        [
          'NOPE',
          task('NOPE', {
            plannedBaseRevision: BASE,
            affectedPaths: ['src/a.ts'],
            protectedPathsSnapshot: [],
            labels: ['onboarding'],
          }),
        ],
      ]),
      {
        repos: {
          app: {
            key: 'app',
            url: 'x',
            defaultBranch: 'main',
            workflow: 'WORKFLOW.md',
            maxConcurrent: 1,
            adapter: null,
            readiness: 'incomplete',
            executionPolicy: { profile: 'guardian' as const },
          },
        },
      },
    );
    const ws = workspacesWithTip(BASE);
    ws.setTrustedWorkflow(null);
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      agents: AgentRegistry.of(adapter),
      workspaces: ws,
      pathLeaseStore: store,
      clock: () => 0,
    });
    const report = await orch.tick();
    expect(report.dispatched).toEqual([]);
    expect(port.tasks.get('NOPE')!.state).toBe('review');
    expect(port.tasks.get('NOPE')!.body).toMatch(/WORKFLOW is unavailable|path-lease snapshot/);
    expect(adapter.started).toHaveLength(0);
  });

  it('does not starve an unrelated eligible task when one is lease-blocked', async () => {
    let priorAlive = true;
    const root = await mkdtemp(join(tmpdir(), 'orch-path-lease-starve-'));
    const store = new TaskPathLeaseStore(root, {
      readProcessIdentity: (pid) => ({
        pid,
        startTimeTicks: String(pid),
        bootId: '12345678-1234-1234-1234-123456789abc',
      }),
      processGroupIdentityAlive: () => priorAlive,
      unboundOwnerAlive: () => false,
    });
    // Prior writer holds the only Guardian writer slot for repo app.
    await store.acquire('app', {
      taskId: 'BLOCKED',
      runToken: 'prior-token',
      declaredBaseRevision: BASE,
      declaredPaths: ['src/blocked.ts'],
      declaredProtectedSnapshot: [],
      trustedBaseRevision: BASE,
      currentProtectedPaths: [],
      maxWriters: 1,
      requireDeclarations: true,
      acquiredAtMs: 1,
    });
    await store.bindOwnerProcess('app', 'BLOCKED', 'prior-token', 777);

    const adapter = new FakeAdapter({ durationMs: 10_000 });
    const reposCfg: ReposConfig = {
      repos: {
        app: {
          key: 'app',
          url: 'x',
          defaultBranch: 'main',
          workflow: 'WORKFLOW.md',
          maxConcurrent: 2,
          adapter: null,
          readiness: 'ready',
          executionPolicy: { profile: 'guardian' as const },
        },
        other: {
          key: 'other',
          url: 'y',
          defaultBranch: 'main',
          workflow: 'WORKFLOW.md',
          maxConcurrent: 1,
          adapter: null,
          readiness: 'ready',
        },
      },
    };
    const port = new FakePort(
      new Map([
        [
          'BLOCKED',
          task('BLOCKED', {
            plannedBaseRevision: BASE,
            affectedPaths: ['src/blocked.ts'],
            protectedPathsSnapshot: [],
            priority: 1, // higher priority — selected first
            state: 'retrying',
          }),
        ],
        [
          'OTHER',
          task('OTHER', {
            repo: 'other',
            plannedBaseRevision: BASE,
            affectedPaths: ['docs/other.md'],
            protectedPathsSnapshot: [],
            priority: 50,
          }),
        ],
      ]),
      reposCfg,
    );
    // other repo needs its own tip/workflow in noop workspaces — same tip works.
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { globalCap: 1 }),
      control: port,
      agents: AgentRegistry.of(adapter),
      workspaces: workspacesWithTip(BASE),
      pathLeaseStore: store,
      clock: () => 0,
    });
    const report = await orch.tick();
    // BLOCKED soft-skips (prior_run_held); OTHER must still dispatch under remaining capacity.
    expect(report.dispatched).toEqual(['OTHER']);
    expect(adapter.started.map((s) => s.taskId)).toEqual(['OTHER']);
    expect(port.tasks.get('BLOCKED')!.state).toBe('retrying');
    priorAlive = false;
  });

  it('reselects past more than eight lease-blocked tasks in one tick', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-path-lease-many-blocks-'));
    const store = new TaskPathLeaseStore(root, {
      readProcessIdentity: (pid) => ({
        pid,
        startTimeTicks: String(pid),
        bootId: '12345678-1234-1234-1234-123456789abc',
      }),
      processGroupIdentityAlive: () => true,
      unboundOwnerAlive: () => false,
    });
    const tasks = new Map<string, Task>();
    for (let index = 0; index < 9; index += 1) {
      const id = `BLOCK-${index}`;
      const path = `src/blocked-${index}.ts`;
      const token = `prior-token-${index}`;
      const acquired = await store.acquire('app', {
        taskId: id,
        runToken: token,
        declaredBaseRevision: BASE,
        declaredPaths: [path],
        declaredProtectedSnapshot: [],
        trustedBaseRevision: BASE,
        currentProtectedPaths: [],
        maxWriters: 20,
        requireDeclarations: true,
        acquiredAtMs: index,
      });
      expect(acquired.ok).toBe(true);
      await store.bindOwnerProcess('app', id, token, 800 + index);
      tasks.set(
        id,
        task(id, {
          state: 'retrying',
          priority: index,
          plannedBaseRevision: BASE,
          affectedPaths: [path],
          protectedPathsSnapshot: [],
        }),
      );
    }
    tasks.set(
      'RUNNABLE',
      task('RUNNABLE', {
        priority: 50,
        plannedBaseRevision: BASE,
        affectedPaths: ['docs/run.md'],
        protectedPathsSnapshot: [],
      }),
    );
    const adapter = new FakeAdapter({ durationMs: 10_000 });
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { globalCap: 1 }),
      control: new FakePort(tasks, repos({ maxConcurrent: 20 })),
      agents: AgentRegistry.of(adapter),
      workspaces: workspacesWithTip(BASE),
      pathLeaseStore: store,
      clock: () => 0,
    });

    const report = await orch.tick();
    expect(report.dispatched).toEqual(['RUNNABLE']);
    expect(adapter.started.map((start) => start.taskId)).toEqual(['RUNNABLE']);
  });

  it('rate-limits identical path-lease soft-block diagnostics across ticks', async () => {
    // Keep prior owner alive so reclaim does not clear the blocker each tick.
    let priorAlive = true;
    const root = await mkdtemp(join(tmpdir(), 'orch-path-lease-ratelimit-'));
    const store = new TaskPathLeaseStore(root, {
      readProcessIdentity: (pid) => ({
        pid,
        startTimeTicks: String(pid),
        bootId: '12345678-1234-1234-1234-123456789abc',
      }),
      processGroupIdentityAlive: () => priorAlive,
      unboundOwnerAlive: () => false,
    });
    await store.acquire('app', {
      taskId: 'HELD',
      runToken: 'held-token',
      declaredBaseRevision: BASE,
      declaredPaths: ['src/a.ts'],
      declaredProtectedSnapshot: [],
      trustedBaseRevision: BASE,
      currentProtectedPaths: [],
      maxWriters: 1,
      requireDeclarations: true,
      acquiredAtMs: 1,
    });
    await store.bindOwnerProcess('app', 'HELD', 'held-token', 1);
    const adapter = new FakeAdapter({ durationMs: 50 });
    const port = new FakePort(
      new Map([
        [
          'HELD',
          task('HELD', {
            state: 'retrying',
            plannedBaseRevision: BASE,
            affectedPaths: ['src/a.ts'],
            protectedPathsSnapshot: [],
          }),
        ],
      ]),
      repos({ guardian: true }),
    );
    let now = 0;
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      agents: AgentRegistry.of(adapter),
      workspaces: workspacesWithTip(BASE),
      pathLeaseStore: store,
      clock: () => now,
    });
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
    try {
      await orch.tick();
      now = 1_000;
      await orch.tick();
      now = 2_000;
      await orch.tick();
      // After 60s window, same fingerprint may re-emit.
      now = 61_000;
      await orch.tick();
    } finally {
      console.error = orig;
      priorAlive = false;
    }
    const blocks = errors.filter((e) => e.includes('path lease blocked') && e.includes('HELD'));
    // First emit + re-emit after window; intermediate ticks deduped.
    expect(blocks.length).toBeLessThanOrEqual(2);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
  });

  it('releases the lease when adapter start throws', async () => {
    const store = await makeStore();
    const adapter: AgentAdapter = {
      name: 'fake',
      start: () => {
        throw new Error('spawn failed');
      },
    };
    const port = new FakePort(new Map([['A', task('A', {
      plannedBaseRevision: BASE,
      affectedPaths: ['src/a.ts'],
      protectedPathsSnapshot: [],
    })]]), repos());
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'), control: port, agents: AgentRegistry.of(adapter),
      workspaces: workspacesWithTip(BASE), pathLeaseStore: store, clock: () => 0,
    });
    const report = await orch.tick();
    expect(report.dispatched).toEqual([]);
    expect(port.tasks.get('A')!.state).toBe('review');
    expect(await store.list('app')).toEqual([]);
  });

  it('stops an untracked writer and retains its lease when owner bind throws', async () => {
    let markedWriterAlive: boolean | null = true;
    const root = await mkdtemp(join(tmpdir(), 'orch-path-lease-bind-window-'));
    const store = new TaskPathLeaseStore(root, {
      readProcessIdentity: (pid) => ({
        pid,
        startTimeTicks: String(pid),
        bootId: '12345678-1234-1234-1234-123456789abc',
      }),
      processGroupIdentityAlive: () => false,
      unboundOwnerAlive: () => markedWriterAlive,
    });
    const originalBind = store.bindOwnerProcess.bind(store);
    store.bindOwnerProcess = async () => {
      throw new Error('injected fsync failure');
    };
    const fake = new FakeAdapter({ durationMs: 10_000 });
    const adapter = processReportingAdapter(fake, 901);
    const port = new FakePort(new Map([['A', task('A', {
      plannedBaseRevision: BASE,
      affectedPaths: ['src/a.ts'],
      protectedPathsSnapshot: [],
    })]]), repos());
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'), control: port, agents: AgentRegistry.of(adapter),
      workspaces: workspacesWithTip(BASE), pathLeaseStore: store, clock: () => 0,
    });

    const report = await orch.tick();
    expect(report.dispatched).toEqual([]);
    expect(orch.running).toEqual([]);
    expect(fake.stopped).toContainEqual({ id: 'A', force: true });
    expect(await store.list('app')).toHaveLength(1);

    store.bindOwnerProcess = originalBind;
    await expect(store.reclaimStale('app', new Set())).resolves.toMatchObject({
      reclaimed: [],
    });
    expect(await store.list('app')).toHaveLength(1);
    markedWriterAlive = false;
    await expect(store.reclaimStale('app', new Set())).resolves.toMatchObject({
      reclaimed: [{ taskId: 'A' }],
    });
  });

  it('stops a bound writer and retains its lease when in-progress commit fails', async () => {
    const store = await makeStore();
    const fake = new FakeAdapter({ durationMs: 10_000 });
    const port = new FakePort(new Map([['A', task('A', {
      plannedBaseRevision: BASE,
      affectedPaths: ['src/a.ts'],
      protectedPathsSnapshot: [],
    })]]), repos());
    const adapter = processReportingAdapter(fake, 902, () => {
      port.commitError = new Error('injected control commit failure');
    });
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'), control: port, agents: AgentRegistry.of(adapter),
      workspaces: workspacesWithTip(BASE), pathLeaseStore: store, clock: () => 0,
    });

    const report = await orch.tick();
    expect(report.dispatched).toEqual([]);
    expect(orch.running).toEqual([]);
    expect(fake.stopped).toContainEqual({ id: 'A', force: true });
    expect(await store.list('app')).toHaveLength(1);
    await expect(store.reclaimStale('app', new Set())).resolves.toMatchObject({
      reclaimed: [{ taskId: 'A' }],
    });
  });

  it('rebinds a missing-session replacement from the dead prior PID to the fresh PID', async () => {
    const store = await makeStore();
    const fake = new FakeAdapter({
      durationMs: 10,
      failFirstStarts: 1,
      stderrTail: 'restore session returned 404 not found',
    });
    const adapter = processReportingAdapter(fake, [911, 912]);
    const port = new FakePort(new Map([['A', task('A', {
      adapter: 'codex',
      pendingSteer: 'continue',
      agentSession: 'missing-session',
      agentSessionAdapter: 'codex',
      plannedBaseRevision: BASE,
      affectedPaths: ['src/a.ts'],
      protectedPathsSnapshot: [],
    })]]), repos());
    let now = 0;
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'), control: port, agents: AgentRegistry.of(adapter),
      workspaces: workspacesWithTip(BASE), pathLeaseStore: store, clock: () => now,
    });

    await orch.tick();
    expect((await store.list('app'))[0]?.ownerProcess?.pid).toBe(911);
    now = 10;
    await orch.tick();
    expect(fake.started).toHaveLength(2);
    expect((await store.list('app'))[0]?.ownerProcess?.pid).toBe(912);
    expect(port.tasks.get('A')!.state).toBe('in_progress');
  });

  it('rebinds a same-round transient replacement to its fresh process identity', async () => {
    const store = await makeStore();
    const fake = new FakeAdapter({
      durationMs: 10,
      failFirstStarts: 1,
      activity: ['status 502 mid-stream'],
      stderrTail: 'status 502 Bad Gateway',
    });
    const adapter = processReportingAdapter(fake, [921, 922]);
    const port = new FakePort(new Map([['A', task('A', {
      adapter: 'codex',
      plannedBaseRevision: BASE,
      affectedPaths: ['src/a.ts'],
      protectedPathsSnapshot: [],
    })]]), repos());
    let now = 0;
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'), control: port, agents: AgentRegistry.of(adapter),
      workspaces: workspacesWithTip(BASE), pathLeaseStore: store, clock: () => now,
    });

    await orch.tick();
    expect((await store.list('app'))[0]?.ownerProcess?.pid).toBe(921);
    now = 10;
    await orch.tick();
    expect(fake.started).toHaveLength(2);
    expect((await store.list('app'))[0]?.ownerProcess?.pid).toBe(922);
    expect(port.tasks.get('A')!.state).toBe('in_progress');
  });

  it('does not recover a missing session while the prior owner group is alive', async () => {
    let priorGroupAlive: boolean | null = false;
    const root = await mkdtemp(join(tmpdir(), 'orch-path-lease-live-recovery-'));
    const store = new TaskPathLeaseStore(root, {
      readProcessIdentity: (pid) => ({
        pid,
        startTimeTicks: String(pid),
        bootId: '12345678-1234-1234-1234-123456789abc',
      }),
      processGroupIdentityAlive: () => priorGroupAlive,
      unboundOwnerAlive: () => false,
    });
    const fake = new FakeAdapter({
      durationMs: 10,
      failFirstStarts: 1,
      stderrTail: 'restore session returned 404 not found',
    });
    const adapter = processReportingAdapter(fake, [925, 926]);
    const port = new FakePort(new Map([['A', task('A', {
      adapter: 'codex', pendingSteer: 'continue', agentSession: 'missing-session',
      agentSessionAdapter: 'codex', plannedBaseRevision: BASE,
      affectedPaths: ['src/a.ts'], protectedPathsSnapshot: [],
    })]]), repos());
    let now = 0;
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'), control: port, agents: AgentRegistry.of(adapter),
      workspaces: workspacesWithTip(BASE), pathLeaseStore: store, clock: () => now,
    });

    await orch.tick();
    priorGroupAlive = true;
    now = 10;
    await orch.tick();
    expect(fake.started).toHaveLength(1);
    expect((await store.list('app'))[0]?.ownerProcess?.pid).toBe(925);
    expect(port.tasks.get('A')!.state).toBe('retrying');
  });

  it('does not transient-retry while prior owner liveness is unknown', async () => {
    let exactOwnerAlive: boolean | null = false;
    const root = await mkdtemp(join(tmpdir(), 'orch-path-lease-unknown-retry-'));
    const store = new TaskPathLeaseStore(root, {
      readProcessIdentity: (pid) => ({
        pid,
        startTimeTicks: String(pid),
        bootId: '12345678-1234-1234-1234-123456789abc',
      }),
      processGroupIdentityAlive: () => exactOwnerAlive,
      unboundOwnerAlive: () => false,
    });
    const fake = new FakeAdapter({
      durationMs: 10,
      failFirstStarts: 1,
      stderrTail: 'status 502 Bad Gateway',
    });
    const adapter = processReportingAdapter(fake, [927, 928]);
    const port = new FakePort(new Map([['A', task('A', {
      adapter: 'codex', plannedBaseRevision: BASE,
      affectedPaths: ['src/a.ts'], protectedPathsSnapshot: [],
    })]]), repos());
    let now = 0;
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'), control: port, agents: AgentRegistry.of(adapter),
      workspaces: workspacesWithTip(BASE), pathLeaseStore: store, clock: () => now,
    });

    await orch.tick();
    exactOwnerAlive = null;
    now = 10;
    await orch.tick();
    expect(fake.started).toHaveLength(1);
    expect((await store.list('app'))[0]?.ownerProcess?.pid).toBe(927);
    expect(port.tasks.get('A')!.state).toBe('retrying');
  });

  it('does not start a transient replacement when durable owner unbind fails', async () => {
    const store = await makeStore();
    store.prepareReplacement = async () => {
      throw new Error('injected owner unbind failure');
    };
    const fake = new FakeAdapter({
      durationMs: 10,
      failFirstStarts: 1,
      stderrTail: 'status 502 Bad Gateway',
    });
    const adapter = processReportingAdapter(fake, [931, 932]);
    const port = new FakePort(new Map([['A', task('A', {
      adapter: 'codex', plannedBaseRevision: BASE,
      affectedPaths: ['src/a.ts'], protectedPathsSnapshot: [],
    })]]), repos());
    let now = 0;
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'), control: port, agents: AgentRegistry.of(adapter),
      workspaces: workspacesWithTip(BASE), pathLeaseStore: store, clock: () => now,
    });

    await orch.tick();
    now = 10;
    await orch.tick();
    expect(fake.started).toHaveLength(1);
    expect(orch.running).toEqual([]);
    expect(port.tasks.get('A')!.state).toBe('retrying');
  });

  it('force-stops a transient replacement when its exact owner bind fails', async () => {
    const store = await makeStore();
    const originalBind = store.bindOwnerProcess.bind(store);
    let binds = 0;
    store.bindOwnerProcess = async (...args) => {
      binds += 1;
      if (binds === 2) throw new Error('injected replacement bind failure');
      return originalBind(...args);
    };
    const fake = new FakeAdapter({
      durationMs: 10,
      failFirstStarts: 1,
      stderrTail: 'status 502 Bad Gateway',
    });
    const adapter = processReportingAdapter(fake, [941, 942]);
    const port = new FakePort(new Map([['A', task('A', {
      adapter: 'codex', plannedBaseRevision: BASE,
      affectedPaths: ['src/a.ts'], protectedPathsSnapshot: [],
    })]]), repos());
    let now = 0;
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'), control: port, agents: AgentRegistry.of(adapter),
      workspaces: workspacesWithTip(BASE), pathLeaseStore: store, clock: () => now,
    });

    await orch.tick();
    now = 10;
    await orch.tick();
    expect(fake.started).toHaveLength(2);
    expect(fake.stopped).toContainEqual({ id: 'A', force: true });
    expect(orch.running).toEqual([]);
    expect(port.tasks.get('A')!.state).toBe('retrying');
  });

  it('stops a started writer when the task disappears before durable tracking', async () => {
    const store = await makeStore();
    const fake = new FakeAdapter({ durationMs: 10_000 });
    const port = new FakePort(new Map([['A', task('A', {
      plannedBaseRevision: BASE,
      affectedPaths: ['src/a.ts'],
      protectedPathsSnapshot: [],
    })]]), repos());
    const adapter = processReportingAdapter(fake, 904, () => {
      port.tasks.delete('A');
    });
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'), control: port, agents: AgentRegistry.of(adapter),
      workspaces: workspacesWithTip(BASE), pathLeaseStore: store, clock: () => 0,
    });

    const report = await orch.tick();
    expect(report.dispatched).toEqual([]);
    expect(orch.running).toEqual([]);
    expect(fake.stopped).toContainEqual({ id: 'A', force: true });
    expect(await store.list('app')).toHaveLength(1);
    await expect(store.reclaimStale('app', new Set())).resolves.toMatchObject({
      reclaimed: [{ taskId: 'A' }],
    });
  });

  it('keeps an out-of-band terminal writer lease until its process group is dead', async () => {
    let groupAlive = true;
    const root = await mkdtemp(join(tmpdir(), 'orch-path-lease-group-'));
    const store = new TaskPathLeaseStore(root, {
      readProcessIdentity: (pid) => ({
        pid,
        startTimeTicks: String(pid),
        bootId: '12345678-1234-1234-1234-123456789abc',
      }),
      processGroupIdentityAlive: () => groupAlive,
      unboundOwnerAlive: () => groupAlive,
    });
    const fake = new FakeAdapter({ durationMs: 10_000, stopGraceMs: 1_000 });
    const adapter = processReportingAdapter(fake, 903);
    const port = new FakePort(new Map([['A', task('A', {
      plannedBaseRevision: BASE,
      affectedPaths: ['src/a.ts'],
      protectedPathsSnapshot: [],
    })]]), repos());
    let now = 0;
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'), control: port, agents: AgentRegistry.of(adapter),
      workspaces: workspacesWithTip(BASE), pathLeaseStore: store, clock: () => now,
    });
    await orch.tick();
    expect(orch.running).toEqual(['A']);
    port.tasks.set('A', { ...port.tasks.get('A')!, state: 'failed' });

    now = 10;
    await orch.tick();
    expect(orch.running).toEqual([]);
    expect(await store.list('app')).toHaveLength(1);

    groupAlive = false;
    now = 20;
    await orch.tick();
    expect(await store.list('app')).toEqual([]);
  });

  it('keeps a legacy exact branch lease separate from path-lease declarations', async () => {
    const store = await makeStore();
    const adapter = new FakeAdapter({ durationMs: 10_000 });
    const port = new FakePort(new Map([['LEGACY', task('LEGACY', {
      expectedBaseRevision: BASE,
      expectedRemoteTip: null,
    })]]), repos());
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'), control: port, agents: AgentRegistry.of(adapter),
      workspaces: workspacesWithTip(BASE), pathLeaseStore: store, clock: () => 0,
    });
    const report = await orch.tick();
    expect(report.dispatched).toEqual(['LEGACY']);
    expect(await store.list('app')).toEqual([]);
  });
});
