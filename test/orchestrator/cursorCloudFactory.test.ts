/**
 * Factory rings 2–12 — multi-task dispatch, refill after reap, observed merge
 * close-out, dependent unblock, CONFLICTING rework on the Cloud Agent head,
 * dispatch-time trusted-default refresh so a factory merge SHA is
 * reachable without a local worktree, CI-failure rework on that same head,
 * BEHIND rebase so parallel slices stay mergeable after a sibling lands,
 * draft → ready so a finished Cloud Agent PR can be merged, rework
 * launches that pin Cursor to the existing PR (`autoBranch: false`, no
 * second autoCreatePr) so the tracked handle is not orphaned, CLEAN
 * + green squash-merge via identity-bound `gh` so ring 4 close-out does
 * not wait for a human click, a failed Cloud Agent that already
 * opened a PR so retry pins that handle instead of orphaning a second PR,
 * fail-retry that has no stored head observes the Cloud Agent branch
 * from injected GitHub so the next launch does not start from default,
 * BEHIND siblings rebase via identity-bound `gh pr rebase` so a
 * parallel merge does not consume a Cloud Agent slot, a coordinator
 * restart reattaches the persisted Cloud Agent instead of launching a
 * second one, and open-PR rework POSTs v0 `source.prUrl` so
 * `autoBranch: false` actually applies (repository+ref ignores it).
 * Injected client only; no live Cursor or GitHub.
 *
 * Local CLI worktree / port / path-lease ownership must not gate throughput.
 */
import { describe, expect, it } from 'vitest';
import { Orchestrator, type ControlPort } from '../../src/orchestrator/orchestrator.js';
import { ActionService } from '../../src/orchestrator/actions.js';
import type { RepoProbe } from '../../src/orchestrator/repoProbe.js';
import { staticMergeBlockReason } from '../../src/domain/release.js';
import { AgentRegistry } from '../../src/orchestrator/agentRegistry.js';
import { CursorCloudAdapter } from '../../src/adapters/cursorCloud.js';
import {
  createCursorCloudHttpClient,
  type CursorCloudFetch,
} from '../../src/adapters/cursorCloudClient.js';
import { FakeAdapter } from '../../src/orchestrator/fakeAdapter.js';
import type { AgentAdapter, AgentStartInput } from '../../src/orchestrator/adapter.js';
import type { Verifier } from '../../src/orchestrator/verifier.js';
import { makeConfig } from '../../src/config.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import type { Task, TaskState } from '../../src/domain/task.js';
import type { RepoConfig, ReposConfig } from '../../src/domain/repos.js';
import type {
  CursorCloudClient,
  CursorCloudLaunchRequest,
  CursorCloudSnapshot,
} from '../../src/domain/cursorCloud.js';
import { NoopWorkspaces } from '../../src/isolation/worktree.js';
import type { Workspace } from '../../src/domain/allocation.js';
import type { TaskPathLeaseStore } from '../../src/isolation/taskPathLeaseStore.js';
import type { GhRunner } from '../../src/orchestrator/openPr.js';

function repos(over: Partial<RepoConfig> = {}): ReposConfig {
  return {
    repos: {
      app: {
        key: 'app',
        url: 'https://github.com/example-org/acme',
        defaultBranch: 'main',
        workflow: 'WORKFLOW.md',
        maxConcurrent: 1,
        adapter: 'cursor',
        readiness: 'ready',
        ...over,
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
    adapter: 'cursor',
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
    body: `Factory work for ${id}.`,
    ...over,
  };
}

class FakePort implements ControlPort {
  constructor(
    readonly tasks: Map<string, Task>,
    private readonly reposCfg: ReposConfig,
  ) {}
  async sync(): Promise<void> {}
  async read(): Promise<ControlSnapshot> {
    return { repos: this.reposCfg, tasks: [...this.tasks.values()], problems: [] };
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
    _message: string,
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
    return { matched: true, committed: true };
  }
  async deleteTask(id: string): Promise<void> {
    this.tasks.delete(id);
  }
  async commit(): Promise<{ committed: boolean }> {
    return { committed: true };
  }
  async writeRepos(): Promise<void> {}
}

class ScriptedClient implements CursorCloudClient {
  readonly launches: CursorCloudLaunchRequest[] = [];
  readonly byId = new Map<string, CursorCloudSnapshot>();

  async launch(request: CursorCloudLaunchRequest): Promise<CursorCloudSnapshot> {
    this.launches.push(request);
    const n = this.launches.length;
    const snap: CursorCloudSnapshot = {
      id: `bc_${n}`,
      status: 'finished',
      pr: {
        prUrl: `https://github.com/example-org/acme/pull/${40 + n}`,
        prNumber: 40 + n,
      },
      summary: `Opened factory PR ${40 + n}.`,
    };
    this.byId.set(snap.id, snap);
    return snap;
  }

  async get(id: string): Promise<CursorCloudSnapshot> {
    return this.byId.get(id) ?? { id, status: 'running' };
  }

  async stop(): Promise<void> {}
}

/** Local isolation must not run for cursor factory tasks. */
class RefusingWorkspaces extends NoopWorkspaces {
  createCalls = 0;
  override async create(): Promise<Workspace> {
    this.createCalls += 1;
    throw new Error('local worktree must not be allocated for cursor factory');
  }
}

/**
 * Factory-only mirror: ancestry stays unknown until dispatch refreshes origin.
 * Models a bare mirror that has not fetched the GitHub-observed merge SHA.
 */
class StaleUntilRefreshWorkspaces extends RefusingWorkspaces {
  refreshCalls = 0;
  private readonly pendingAbsorb = new Set<string>();

  absorbOnRefresh(...shas: string[]): this {
    for (const raw of shas) {
      const want = raw.trim().toLowerCase();
      if (/^[0-9a-f]{40}$/.test(want)) this.pendingAbsorb.add(want);
    }
    return this;
  }

  async refreshTrustedDefault(): Promise<boolean> {
    this.refreshCalls += 1;
    this.allowAncestry(...this.pendingAbsorb);
    this.pendingAbsorb.clear();
    return true;
  }
}

const throwingPathLeaseStore = {
  acquire: async () => {
    throw new Error('path lease must not gate cursor factory');
  },
  reclaimStale: async () => ({ reclaimed: [], uncertain: [] }),
} as unknown as TaskPathLeaseStore;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
};

function factoryHeadGh(headRefName = 'cursor/cloud-T-factory-abc'): GhRunner {
  return async (args) => {
    if (args[0] === 'pr' && args[1] === 'view') {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          url: 'https://github.com/example-org/acme/pull/41',
          baseRefName: 'main',
          headRefName,
        }),
        stderr: '',
      };
    }
    return { exitCode: 1, stdout: '', stderr: 'nope' };
  };
}

function factoryOrchestrator(input: {
  readonly tasks: Map<string, Task>;
  readonly client: CursorCloudClient;
  readonly workspaces: RefusingWorkspaces;
  readonly globalCap?: number;
  readonly backoffBaseMs?: number;
  readonly clock?: () => number;
  readonly gh?: GhRunner;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}): { orch: Orchestrator; starts: AgentStartInput[]; verifyCalls: { n: number } } {
  const starts: AgentStartInput[] = [];
  const clock = input.clock ?? (() => 1_000);
  const inner = new CursorCloudAdapter({
    client: input.client,
    clock,
    pollIntervalMs: input.pollIntervalMs ?? 0,
    sleep: input.sleep ?? (async () => undefined),
  });
  const adapter: AgentAdapter = {
    name: 'cursor',
    start(startInput, now) {
      starts.push(startInput);
      return inner.start(startInput, now);
    },
  };
  const verifyCalls = { n: 0 };
  const orch = new Orchestrator({
    config: makeConfig('/ctrl', {
      globalCap: input.globalCap ?? 2,
      ...(input.backoffBaseMs !== undefined ? { backoffBaseMs: input.backoffBaseMs } : {}),
    }),
    control: new FakePort(input.tasks, repos()),
    agents: new AgentRegistry({ cursor: adapter, fake: inner }, 'cursor'),
    clock,
    workspaces: input.workspaces,
    pathLeaseStore: throwingPathLeaseStore,
    verifier: {
      verify: async () => {
        verifyCalls.n += 1;
        throw new Error('local verify must not run for cursor factory');
      },
    } satisfies Verifier,
    ...(input.gh ? { gh: input.gh } : {}),
  });
  return { orch, starts, verifyCalls };
}

describe('Cursor Cloud factory dispatch', () => {
  it('dispatches a task and records the injected PR on review', async () => {
    const client = new ScriptedClient();
    const workspaces = new RefusingWorkspaces('/tmp/hercules-cursor-factory');
    const tasks = new Map([['T-factory', task('T-factory', { body: 'Add the factory first ring.' })]]);
    const { orch, starts, verifyCalls } = factoryOrchestrator({ tasks, client, workspaces });

    const first = await orch.tick();
    expect(first.dispatched).toEqual(['T-factory']);
    expect(workspaces.createCalls).toBe(0);
    expect(starts[0]?.repository).toBe('https://github.com/example-org/acme');
    expect(starts[0]?.ref).toBe('main');
    expect(starts[0]?.prompt).toContain('Add the factory first ring.');
    expect(starts[0]?.prompt).toContain('## Factory PR (done artifact)');
    expect(starts[0]?.prompt).toMatch(/ready for review/);
    expect(starts[0]?.allocation.port).toBe(0);
    expect(client.launches).toHaveLength(1);
    expect(client.launches[0]?.repository).toBe('https://github.com/example-org/acme');
    expect(client.launches[0]?.existingPr).toBeUndefined();

    await flush();
    const second = await orch.tick();
    expect(second.completed).toEqual(['T-factory']);
    expect(verifyCalls.n).toBe(0);
    const done = tasks.get('T-factory');
    expect(done?.state).toBe('review');
    expect(done?.prUrl).toBe('https://github.com/example-org/acme/pull/41');
    expect(done?.prStatus).toBe('open');
    expect(done?.body).toContain('https://github.com/example-org/acme/pull/41');
    expect(done?.body).toContain('PR number: 41');
  });

  it('dispatches two cursor tasks in one cycle, each with its own PR', async () => {
    const client = new ScriptedClient();
    const workspaces = new RefusingWorkspaces('/tmp/hercules-cursor-factory-ring2');
    const tasks = new Map([
      ['T-a', task('T-a')],
      ['T-b', task('T-b')],
    ]);
    const { orch, starts, verifyCalls } = factoryOrchestrator({ tasks, client, workspaces });

    const first = await orch.tick();
    expect(first.dispatched).toEqual(['T-a', 'T-b']);
    expect(workspaces.createCalls).toBe(0);
    expect(starts).toHaveLength(2);
    expect(new Set(starts.map((s) => s.taskId))).toEqual(new Set(['T-a', 'T-b']));
    expect(starts.every((s) => s.allocation.port === 0)).toBe(true);
    expect(starts.every((s) => s.repository === 'https://github.com/example-org/acme')).toBe(true);
    expect(client.launches).toHaveLength(2);
    expect(client.launches.some((l) => l.prompt.includes('Factory work for T-a.'))).toBe(true);
    expect(client.launches.some((l) => l.prompt.includes('Factory work for T-b.'))).toBe(true);

    await flush();
    const second = await orch.tick();
    expect(new Set(second.completed)).toEqual(new Set(['T-a', 'T-b']));
    expect(verifyCalls.n).toBe(0);

    const a = tasks.get('T-a');
    const b = tasks.get('T-b');
    expect(a?.state).toBe('review');
    expect(b?.state).toBe('review');
    expect(a?.prUrl).not.toBe(b?.prUrl);
    expect(a?.prUrl).toMatch(/^https:\/\/github.com\/example-org\/acme\/pull\/4[12]$/);
    expect(b?.prUrl).toMatch(/^https:\/\/github.com\/example-org\/acme\/pull\/4[12]$/);
    expect(a?.prStatus).toBe('open');
    expect(b?.prStatus).toBe('open');
    expect(a?.body).toContain(a?.prUrl ?? '');
    expect(b?.body).toContain(b?.prUrl ?? '');
  });

  it('persists a PR from a failed Cloud Agent and pins retry so a second PR is not opened', async () => {
    const client = new ScriptedClient();
    let launches = 0;
    client.launch = async (request) => {
      client.launches.push(request);
      launches += 1;
      if (launches === 1) {
        const snap: CursorCloudSnapshot = {
          id: 'bc_fail',
          status: 'failed',
          pr: {
            prUrl: 'https://github.com/example-org/acme/pull/41',
            prNumber: 41,
          },
          summary: 'Opened the PR then died.',
        };
        client.byId.set(snap.id, snap);
        return snap;
      }
      const snap: CursorCloudSnapshot = {
        id: 'bc_retry',
        status: 'finished',
        summary: 'Pushed the existing head.',
      };
      client.byId.set(snap.id, snap);
      return snap;
    };
    let now = 1_000;
    const workspaces = new RefusingWorkspaces('/tmp/hercules-cursor-factory-ring13');
    const tasks = new Map([
      ['T-factory', task('T-factory', { body: 'Land the factory cut that died mid-PR.' })],
    ]);
    const { orch, starts, verifyCalls } = factoryOrchestrator({
      tasks,
      client,
      workspaces,
      backoffBaseMs: 1,
      clock: () => now,
      gh: factoryHeadGh(),
    });

    expect((await orch.tick()).dispatched).toEqual(['T-factory']);
    expect(client.launches).toHaveLength(1);
    expect(client.launches[0]?.existingPr).toBeUndefined();
    expect(starts[0]?.existingFactoryPr).toBeUndefined();

    await flush();
    const reaped = await orch.tick();
    expect(reaped.completed).toEqual([]);
    expect(reaped.retried).toContain('T-factory');
    const afterFail = tasks.get('T-factory');
    expect(afterFail?.state).toBe('retrying');
    expect(afterFail?.prUrl).toBe('https://github.com/example-org/acme/pull/41');
    expect(afterFail?.prStatus).toBe('open');
    expect(afterFail?.verifiedSha ?? null).toBeNull();

    now += 2_000;
    const relaunch = await orch.tick();
    expect(relaunch.dispatched).toEqual(['T-factory']);
    expect(workspaces.createCalls).toBe(0);
    expect(client.launches).toHaveLength(2);
    expect(client.launches[1]?.existingPr).toEqual({
      prUrl: 'https://github.com/example-org/acme/pull/41',
      prNumber: 41,
    });
    expect(starts[1]?.existingFactoryPr).toEqual({
      prUrl: 'https://github.com/example-org/acme/pull/41',
      prNumber: 41,
    });
    expect(starts[1]?.prompt).toContain('https://github.com/example-org/acme/pull/41');
    expect(starts[1]?.prompt).toMatch(/do not open a second PR/i);
    expect(starts[1]?.resumeSessionId).toBeUndefined();

    await flush();
    expect((await orch.tick()).completed).toEqual(['T-factory']);
    const reviewed = tasks.get('T-factory');
    expect(reviewed?.state).toBe('review');
    expect(reviewed?.prUrl).toBe('https://github.com/example-org/acme/pull/41');
    expect(reviewed?.prStatus).toBe('open');
    expect(reviewed?.verifiedSha ?? null).toBeNull();
    expect(verifyCalls.n).toBe(0);
    expect(workspaces.createCalls).toBe(0);
  });

  it('still fails closed when a factory run finishes without a PR', async () => {
    const client = new ScriptedClient();
    client.launch = async (request) => {
      client.launches.push(request);
      const snap: CursorCloudSnapshot = { id: 'bc_bare', status: 'finished' };
      client.byId.set(snap.id, snap);
      return snap;
    };
    const workspaces = new RefusingWorkspaces('/tmp/hercules-cursor-factory-nopr');
    const tasks = new Map([['T-bare', task('T-bare')]]);
    const { orch } = factoryOrchestrator({ tasks, client, workspaces });

    expect((await orch.tick()).dispatched).toEqual(['T-bare']);
    await flush();
    const second = await orch.tick();
    expect(second.completed).toEqual([]);
    expect(second.retried).toContain('T-bare');
    const after = tasks.get('T-bare');
    expect(after?.state).toBe('retrying');
    expect(after?.prUrl).toBeNull();
  });

  it('relaunch after a failed Cloud Agent with a PR starts on the observed head, not default', async () => {
    const client = new ScriptedClient();
    let launches = 0;
    client.launch = async (request) => {
      client.launches.push(request);
      launches += 1;
      if (launches === 1) {
        const snap: CursorCloudSnapshot = {
          id: 'bc_fail',
          status: 'failed',
          pr: {
            prUrl: 'https://github.com/example-org/acme/pull/41',
            prNumber: 41,
          },
          summary: 'Opened the PR then died.',
        };
        client.byId.set(snap.id, snap);
        return snap;
      }
      const snap: CursorCloudSnapshot = {
        id: 'bc_retry',
        status: 'finished',
        summary: 'Continued on the existing Cloud Agent head.',
      };
      client.byId.set(snap.id, snap);
      return snap;
    };
    let now = 1_000;
    const workspaces = new RefusingWorkspaces('/tmp/hercules-cursor-factory-ring14');
    const tasks = new Map([
      ['T-factory', task('T-factory', { body: 'Land the factory cut that died mid-PR.' })],
    ]);
    const { orch, starts, verifyCalls } = factoryOrchestrator({
      tasks,
      client,
      workspaces,
      backoffBaseMs: 1,
      clock: () => now,
      gh: factoryHeadGh('cursor/cloud-T-factory-abc'),
    });

    expect((await orch.tick()).dispatched).toEqual(['T-factory']);
    expect(client.launches[0]?.ref).toBe('main');
    expect(client.launches[0]?.existingPr).toBeUndefined();

    await flush();
    expect((await orch.tick()).retried).toContain('T-factory');
    expect(tasks.get('T-factory')?.prUrl).toBe('https://github.com/example-org/acme/pull/41');
    expect(tasks.get('T-factory')?.body).not.toMatch(/existing Cloud Agent branch `/);

    now += 2_000;
    const relaunch = await orch.tick();
    expect(relaunch.dispatched).toEqual(['T-factory']);
    expect(workspaces.createCalls).toBe(0);
    expect(client.launches).toHaveLength(2);
    expect(client.launches[1]?.ref).toBe('cursor/cloud-T-factory-abc');
    expect(client.launches[1]?.existingPr).toEqual({
      prUrl: 'https://github.com/example-org/acme/pull/41',
      prNumber: 41,
    });
    expect(starts[1]?.ref).toBe('cursor/cloud-T-factory-abc');
    expect(starts[1]?.prompt).toContain('cursor/cloud-T-factory-abc');
    expect(starts[1]?.prompt).toMatch(/do not open a second PR/i);
    expect(starts[1]?.resumeSessionId).toBeUndefined();
    expect(tasks.get('T-factory')?.body).toContain('cursor/cloud-T-factory-abc');
    expect(tasks.get('T-factory')?.body).toMatch(/existing Cloud Agent branch `cursor\/cloud-T-factory-abc`/);

    await flush();
    expect((await orch.tick()).completed).toEqual(['T-factory']);
    const reviewed = tasks.get('T-factory');
    expect(reviewed?.state).toBe('review');
    expect(reviewed?.prUrl).toBe('https://github.com/example-org/acme/pull/41');
    expect(reviewed?.verifiedSha ?? null).toBeNull();
    expect(verifyCalls.n).toBe(0);
    expect(workspaces.createCalls).toBe(0);
  });

  it('does not launch a fail-retry from default when the factory head probe fails', async () => {
    const client = new ScriptedClient();
    let launches = 0;
    client.launch = async (request) => {
      client.launches.push(request);
      launches += 1;
      if (launches === 1) {
        const snap: CursorCloudSnapshot = {
          id: 'bc_fail',
          status: 'failed',
          pr: {
            prUrl: 'https://github.com/example-org/acme/pull/41',
            prNumber: 41,
          },
        };
        client.byId.set(snap.id, snap);
        return snap;
      }
      const snap: CursorCloudSnapshot = { id: 'bc_retry', status: 'finished' };
      client.byId.set(snap.id, snap);
      return snap;
    };
    let now = 1_000;
    const workspaces = new RefusingWorkspaces('/tmp/hercules-cursor-factory-ring14-skip');
    const tasks = new Map([['T-factory', task('T-factory')]]);
    const { orch } = factoryOrchestrator({
      tasks,
      client,
      workspaces,
      backoffBaseMs: 1,
      clock: () => now,
      gh: async () => ({ exitCode: 1, stdout: '', stderr: 'gh unavailable' }),
    });

    expect((await orch.tick()).dispatched).toEqual(['T-factory']);
    await flush();
    expect((await orch.tick()).retried).toContain('T-factory');
    now += 2_000;
    const skipped = await orch.tick();
    expect(skipped.dispatched).toEqual([]);
    expect(client.launches).toHaveLength(1);
    expect(client.launches[0]?.ref).toBe('main');
    expect(tasks.get('T-factory')?.state).toBe('retrying');
    expect(tasks.get('T-factory')?.prUrl).toBe('https://github.com/example-org/acme/pull/41');
  });

  it('does not treat the repo default as an observed factory head', async () => {
    const client = new ScriptedClient();
    let launches = 0;
    client.launch = async (request) => {
      client.launches.push(request);
      launches += 1;
      if (launches === 1) {
        const snap: CursorCloudSnapshot = {
          id: 'bc_fail',
          status: 'failed',
          pr: {
            prUrl: 'https://github.com/example-org/acme/pull/41',
            prNumber: 41,
          },
        };
        client.byId.set(snap.id, snap);
        return snap;
      }
      const snap: CursorCloudSnapshot = { id: 'bc_retry', status: 'finished' };
      client.byId.set(snap.id, snap);
      return snap;
    };
    let now = 1_000;
    const workspaces = new RefusingWorkspaces('/tmp/hercules-cursor-factory-ring14-default');
    const tasks = new Map([['T-factory', task('T-factory')]]);
    const { orch } = factoryOrchestrator({
      tasks,
      client,
      workspaces,
      backoffBaseMs: 1,
      clock: () => now,
      gh: factoryHeadGh('main'),
    });

    expect((await orch.tick()).dispatched).toEqual(['T-factory']);
    await flush();
    expect((await orch.tick()).retried).toContain('T-factory');
    now += 2_000;
    expect((await orch.tick()).dispatched).toEqual([]);
    expect(client.launches).toHaveLength(1);
    expect(tasks.get('T-factory')?.state).toBe('retrying');
  });

  it('still provisions a local workspace for fake/CLI adapters', async () => {
    const workspaces = new RefusingWorkspaces('/tmp/hercules-cursor-factory-fake');
    const tasks = new Map([['T-fake', task('T-fake', { adapter: 'fake' })]]);
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: new FakePort(tasks, repos({ adapter: 'fake' })),
      agents: new AgentRegistry({ fake: new FakeAdapter({ durationMs: 1_000 }) }, 'fake'),
      clock: () => 1_000,
      workspaces,
    });
    const report = await orch.tick();
    expect(workspaces.createCalls).toBe(1);
    expect(report.dispatched).toEqual([]);
    // C3.49: a never-started task whose provisioning failed is HELD with
    // backoff (visible as a provision_failed hold on the next tick), not
    // "retried" — fail() could not move a human-owned todo record and used to
    // fold a stamped note + control commit every tick instead.
    expect(report.retried).not.toContain('T-fake');
    expect(report.failed).not.toContain('T-fake');
    const second = await orch.tick();
    expect(workspaces.createCalls).toBe(1);
    expect(second.dispatched).toEqual([]);
    const hold = orch.getState().holds?.['T-fake'];
    expect(hold?.code).toBe('provision_failed');
    expect(hold !== undefined && 'detail' in hold ? hold.detail : '').toMatch(/./);
  });

  it('reaps finished runs and refills remaining cursor backlog across cycles', async () => {
    const client = new ScriptedClient();
    const workspaces = new RefusingWorkspaces('/tmp/hercules-cursor-factory-ring3');
    const tasks = new Map([
      ['T-a', task('T-a')],
      ['T-b', task('T-b')],
      ['T-c', task('T-c')],
      ['T-d', task('T-d')],
    ]);
    const { orch, verifyCalls } = factoryOrchestrator({
      tasks,
      client,
      workspaces,
      globalCap: 2,
    });

    const first = await orch.tick();
    expect(first.dispatched).toEqual(['T-a', 'T-b']);
    expect(first.completed).toEqual([]);
    expect(workspaces.createCalls).toBe(0);
    expect(client.launches).toHaveLength(2);

    await flush();
    const second = await orch.tick();
    expect(new Set(second.completed)).toEqual(new Set(['T-a', 'T-b']));
    expect(second.dispatched).toEqual(['T-c', 'T-d']);
    expect(client.launches).toHaveLength(4);
    expect(verifyCalls.n).toBe(0);

    await flush();
    const third = await orch.tick();
    expect(new Set(third.completed)).toEqual(new Set(['T-c', 'T-d']));
    expect(third.dispatched).toEqual([]);

    const urls = ['T-a', 'T-b', 'T-c', 'T-d'].map((id) => tasks.get(id)?.prUrl);
    expect(urls.every((url) => typeof url === 'string')).toBe(true);
    expect(new Set(urls).size).toBe(4);
    const numbers = ['T-a', 'T-b', 'T-c', 'T-d'].map((id) => {
      const match = tasks.get(id)?.prUrl?.match(/\/pull\/(\d+)$/);
      return match?.[1];
    });
    expect(new Set(numbers).size).toBe(4);
    for (const id of ['T-a', 'T-b', 'T-c', 'T-d']) {
      const done = tasks.get(id);
      expect(done?.state).toBe('review');
      expect(done?.prStatus).toBe('open');
      expect(done?.prUrl).toMatch(/^https:\/\/github.com\/example-org\/acme\/pull\/\d+$/);
      expect(done?.body).toContain(done?.prUrl ?? '');
      expect(done?.body).toMatch(/PR number: \d+/);
    }
    expect(workspaces.createCalls).toBe(0);
    expect(verifyCalls.n).toBe(0);
    expect(client.launches).toHaveLength(4);
  });

  it('closes factory review when the injected GitHub lifecycle reports the PR merged', async () => {
    const MERGE_SHA = 'f'.repeat(40);
    const client = new ScriptedClient();
    const workspaces = new RefusingWorkspaces('/tmp/hercules-cursor-factory-ring4');
    const tasks = new Map([['T-factory', task('T-factory', { body: 'Add ring 4 close-out.' })]]);
    const { orch, verifyCalls } = factoryOrchestrator({ tasks, client, workspaces });

    expect((await orch.tick()).dispatched).toEqual(['T-factory']);
    await flush();
    expect((await orch.tick()).completed).toEqual(['T-factory']);
    const reviewed = tasks.get('T-factory');
    expect(reviewed?.state).toBe('review');
    expect(reviewed?.prUrl).toBe('https://github.com/example-org/acme/pull/41');
    expect(reviewed?.prStatus).toBe('open');
    expect(reviewed?.verifiedSha ?? null).toBeNull();
    expect(verifyCalls.n).toBe(0);
    expect(workspaces.createCalls).toBe(0);

    const probe: RepoProbe = {
      async probe() {
        return { branches: ['main'] };
      },
    };
    const gh = async (args: readonly string[]) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            url: 'https://github.com/example-org/acme/pull/41',
            baseRefName: 'main',
            headRefName: 'cursor/cloud-T-factory-abc',
            state: 'MERGED',
            mergeCommit: { oid: MERGE_SHA },
          }),
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'nope' };
    };
    const actions = new ActionService(
      new FakePort(tasks, repos()),
      probe,
      gh,
    );
    const synced = await actions.syncOpenPrStatuses();
    expect(synced.updated).toEqual(['T-factory']);

    const closed = tasks.get('T-factory');
    expect(closed?.state).toBe('done');
    expect(closed?.prStatus).toBe('merged');
    expect(closed?.prUrl).toBe('https://github.com/example-org/acme/pull/41');
    expect(closed?.mergedSha).toBe(MERGE_SHA);
    expect(closed?.mergedVia).toBe('operator');
    expect(closed?.verifiedSha ?? null).toBeNull();
    expect(staticMergeBlockReason(closed!, 'app')).toMatch(
      /already merged externally|missing verified_sha/,
    );
    expect(verifyCalls.n).toBe(0);
    expect(workspaces.createCalls).toBe(0);
  });

  it('dispatches the next same-repo implement after the factory PR merge is observed', async () => {
    const MERGE_SHA = 'c'.repeat(40);
    const client = new ScriptedClient();
    const workspaces = new RefusingWorkspaces('/tmp/hercules-cursor-factory-ring5');
    workspaces.allowAncestry(MERGE_SHA);
    const tasks = new Map([
      ['T-factory', task('T-factory', { body: 'Land the factory cut.', priority: 10 })],
      [
        'T-next',
        task('T-next', {
          body: 'Implement the follow-on change.',
          blockedBy: ['T-factory'],
          priority: 20,
        }),
      ],
      ['T-free', task('T-free', { body: 'Independent factory todo.', priority: 30 })],
    ]);
    const { orch, verifyCalls } = factoryOrchestrator({
      tasks,
      client,
      workspaces,
      globalCap: 2,
    });

    const first = await orch.tick();
    expect(first.dispatched).toEqual(['T-factory', 'T-free']);
    expect(first.dispatched).not.toContain('T-next');
    expect(workspaces.createCalls).toBe(0);
    expect(client.launches).toHaveLength(2);

    await flush();
    const second = await orch.tick();
    expect(new Set(second.completed)).toEqual(new Set(['T-factory', 'T-free']));
    expect(second.dispatched).toEqual([]);
    expect(tasks.get('T-factory')?.state).toBe('review');
    expect(tasks.get('T-next')?.state).toBe('todo');
    expect(verifyCalls.n).toBe(0);

    const gh = async (args: readonly string[]) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            url: 'https://github.com/example-org/acme/pull/41',
            baseRefName: 'main',
            headRefName: 'cursor/cloud-T-factory-abc',
            state: 'MERGED',
            mergeCommit: { oid: MERGE_SHA },
          }),
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'nope' };
    };
    const actions = new ActionService(new FakePort(tasks, repos()), {
      async probe() {
        return { branches: ['main'] };
      },
    }, gh);
    expect((await actions.syncOpenPrStatuses()).updated).toEqual(['T-factory']);
    const closed = tasks.get('T-factory');
    expect(closed?.state).toBe('done');
    expect(closed?.mergedVia).toBe('operator');
    expect(closed?.mergedSha).toBe(MERGE_SHA);
    expect(closed?.verifiedSha ?? null).toBeNull();
    expect(staticMergeBlockReason(closed!, 'app')).toMatch(
      /already merged externally|missing verified_sha/,
    );

    const third = await orch.tick();
    expect(third.dispatched).toEqual(['T-next']);
    expect(workspaces.createCalls).toBe(0);
    expect(client.launches).toHaveLength(3);
    expect(client.launches[2]?.prompt).toContain('Implement the follow-on change.');
    expect(verifyCalls.n).toBe(0);
  });

  it('requeues a CONFLICTING factory PR and relaunches on the Cloud Agent head', async () => {
    const client = new ScriptedClient();
    const workspaces = new RefusingWorkspaces('/tmp/hercules-cursor-factory-ring6');
    const tasks = new Map([
      ['T-factory', task('T-factory', { body: 'Land the colliding factory cut.' })],
    ]);
    const { orch, starts, verifyCalls } = factoryOrchestrator({ tasks, client, workspaces });

    expect((await orch.tick()).dispatched).toEqual(['T-factory']);
    expect(client.launches[0]?.ref).toBe('main');
    await flush();
    expect((await orch.tick()).completed).toEqual(['T-factory']);
    expect(tasks.get('T-factory')?.state).toBe('review');
    expect(tasks.get('T-factory')?.prUrl).toBe('https://github.com/example-org/acme/pull/41');
    expect(verifyCalls.n).toBe(0);
    expect(workspaces.createCalls).toBe(0);

    const gh = async (args: readonly string[]) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            url: 'https://github.com/example-org/acme/pull/41',
            baseRefName: 'main',
            headRefName: 'cursor/cloud-T-factory-abc',
            state: 'OPEN',
            mergeable: 'CONFLICTING',
          }),
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'nope' };
    };
    const actions = new ActionService(
      new FakePort(tasks, repos()),
      {
        async probe() {
          return { branches: ['main'] };
        },
      },
      gh,
    );
    expect((await actions.syncOpenPrStatuses()).updated).toEqual(['T-factory']);
    const requeued = tasks.get('T-factory');
    expect(requeued?.state).toBe('todo');
    expect(requeued?.prStatus).toBe('open');
    expect(requeued?.pendingSteer).toContain('cursor/cloud-T-factory-abc');
    expect(requeued?.pendingSteer).not.toMatch(/work \*\*only\*\* on branch `hercules\/T-factory`/i);
    expect(requeued?.agentSession).toBeNull();

    const relaunch = await orch.tick();
    expect(relaunch.dispatched).toEqual(['T-factory']);
    expect(workspaces.createCalls).toBe(0);
    expect(client.launches).toHaveLength(2);
    expect(client.launches[0]?.existingPr).toBeUndefined();
    expect(client.launches[1]?.ref).toBe('cursor/cloud-T-factory-abc');
    expect(client.launches[1]?.existingPr).toEqual({
      prUrl: 'https://github.com/example-org/acme/pull/41',
      prNumber: 41,
    });
    expect(client.launches[1]?.prompt).toContain('https://github.com/example-org/acme/pull/41');
    expect(client.launches[1]?.prompt).toContain('cursor/cloud-T-factory-abc');
    expect(client.launches[1]?.prompt).toMatch(/Do \*\*not\*\* create `hercules\/T-factory`/);
    expect(starts[1]?.ref).toBe('cursor/cloud-T-factory-abc');
    expect(starts[1]?.existingFactoryPr).toEqual({
      prUrl: 'https://github.com/example-org/acme/pull/41',
      prNumber: 41,
    });
    expect(starts[1]?.resumeSessionId).toBeUndefined();

    await flush();
    expect((await orch.tick()).completed).toEqual(['T-factory']);
    const reviewed = tasks.get('T-factory');
    expect(reviewed?.state).toBe('review');
    expect(reviewed?.prUrl).toBe('https://github.com/example-org/acme/pull/41');
    expect(reviewed?.prStatus).toBe('open');
    expect(reviewed?.verifiedSha ?? null).toBeNull();
    expect(verifyCalls.n).toBe(0);
    expect(workspaces.createCalls).toBe(0);
  });

  it('POSTs CONFLICTING rework with source.prUrl so autoBranch:false applies', async () => {
    const posts: Array<{
      source?: { repository?: string; ref?: string; prUrl?: string };
      target?: { autoCreatePr?: boolean; autoBranch?: boolean };
    }> = [];
    let launchN = 0;
    const fetchFn: CursorCloudFetch = async (_url, init) => {
      if (init.method === 'POST' && init.body !== undefined) {
        launchN += 1;
        posts.push(JSON.parse(init.body) as (typeof posts)[number]);
        const n = launchN;
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              id: `bc_${n}`,
              status: 'FINISHED',
              ...(n === 1
                ? { target: { prUrl: 'https://github.com/example-org/acme/pull/41' } }
                : {}),
              summary: n === 1 ? 'Opened factory PR 41.' : 'Resolved conflicts on the PR.',
            }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'bc_1', status: 'FINISHED' }),
      };
    };
    const client = createCursorCloudHttpClient({
      apiKey: 'injected-factory-key',
      fetch: fetchFn,
    });
    const workspaces = new RefusingWorkspaces('/tmp/hercules-cursor-factory-ring17');
    const tasks = new Map([
      ['T-factory', task('T-factory', { body: 'Land the colliding factory cut.' })],
    ]);
    const { orch, starts, verifyCalls } = factoryOrchestrator({ tasks, client, workspaces });

    expect((await orch.tick()).dispatched).toEqual(['T-factory']);
    await flush();
    expect((await orch.tick()).completed).toEqual(['T-factory']);
    expect(tasks.get('T-factory')?.prUrl).toBe(
      'https://github.com/example-org/acme/pull/41',
    );
    expect(posts[0]?.source).toEqual({
      repository: 'https://github.com/example-org/acme',
      ref: 'main',
    });
    expect(posts[0]?.target).toEqual({ autoCreatePr: true });

    const gh = async (args: readonly string[]) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            url: 'https://github.com/example-org/acme/pull/41',
            baseRefName: 'main',
            headRefName: 'cursor/cloud-T-factory-abc',
            state: 'OPEN',
            mergeable: 'CONFLICTING',
          }),
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'nope' };
    };
    const actions = new ActionService(
      new FakePort(tasks, repos()),
      {
        async probe() {
          return { branches: ['main'] };
        },
      },
      gh,
    );
    expect((await actions.syncOpenPrStatuses()).updated).toEqual(['T-factory']);

    expect((await orch.tick()).dispatched).toEqual(['T-factory']);
    await flush();
    expect(posts).toHaveLength(2);
    expect(posts[1]?.source).toEqual({
      prUrl: 'https://github.com/example-org/acme/pull/41',
    });
    expect(posts[1]?.source).not.toHaveProperty('repository');
    expect(posts[1]?.source).not.toHaveProperty('ref');
    expect(posts[1]?.target).toEqual({ autoCreatePr: false, autoBranch: false });
    expect(starts[1]?.existingFactoryPr).toEqual({
      prUrl: 'https://github.com/example-org/acme/pull/41',
      prNumber: 41,
    });
    expect(workspaces.createCalls).toBe(0);
    expect(verifyCalls.n).toBe(0);
    expect(JSON.stringify(posts)).not.toContain('injected-factory-key');
  });

  it('refreshes the trusted default so a factory-dependent can launch after merge', async () => {
    const MERGE_SHA = 'a'.repeat(40);
    const client = new ScriptedClient();
    const workspaces = new StaleUntilRefreshWorkspaces(
      '/tmp/hercules-cursor-factory-ring7',
    ).absorbOnRefresh(MERGE_SHA);
    const tasks = new Map([
      ['T-factory', task('T-factory', { body: 'Land the factory cut.', priority: 10 })],
      [
        'T-next',
        task('T-next', {
          body: 'Implement the follow-on change.',
          blockedBy: ['T-factory'],
          priority: 20,
        }),
      ],
    ]);
    const { orch, verifyCalls } = factoryOrchestrator({
      tasks,
      client,
      workspaces,
      globalCap: 2,
    });

    expect((await orch.tick()).dispatched).toEqual(['T-factory']);
    await flush();
    expect((await orch.tick()).completed).toEqual(['T-factory']);
    expect(tasks.get('T-factory')?.state).toBe('review');
    expect(workspaces.refreshCalls).toBe(0);

    const gh = async (args: readonly string[]) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            url: 'https://github.com/example-org/acme/pull/41',
            baseRefName: 'main',
            headRefName: 'cursor/cloud-T-factory-abc',
            state: 'MERGED',
            mergeCommit: { oid: MERGE_SHA },
          }),
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'nope' };
    };
    const actions = new ActionService(
      new FakePort(tasks, repos()),
      {
        async probe() {
          return { branches: ['main'] };
        },
      },
      gh,
    );
    expect((await actions.syncOpenPrStatuses()).updated).toEqual(['T-factory']);
    expect(tasks.get('T-factory')?.mergedSha).toBe(MERGE_SHA);
    expect(tasks.get('T-factory')?.verifiedSha ?? null).toBeNull();

    const third = await orch.tick();
    expect(third.dispatched).toEqual(['T-next']);
    expect(workspaces.refreshCalls).toBeGreaterThan(0);
    expect(workspaces.createCalls).toBe(0);
    expect(client.launches).toHaveLength(2);
    expect(client.launches[1]?.prompt).toContain('Implement the follow-on change.');
    expect(verifyCalls.n).toBe(0);
    expect(tasks.get('T-next')?.verifiedSha ?? null).toBeNull();
  });

  it('keeps the factory-dependent held when refresh does not absorb the merge SHA', async () => {
    const MERGE_SHA = 'b'.repeat(40);
    const client = new ScriptedClient();
    const workspaces = new StaleUntilRefreshWorkspaces(
      '/tmp/hercules-cursor-factory-ring7-stale',
    );
    const tasks = new Map([
      [
        'T-factory',
        task('T-factory', {
          state: 'done',
          adapter: 'cursor',
          prStatus: 'merged',
          prUrl: 'https://github.com/example-org/acme/pull/41',
          mergedSha: MERGE_SHA,
          mergedVia: 'operator',
          verifiedSha: null,
        }),
      ],
      [
        'T-next',
        task('T-next', {
          body: 'Implement the follow-on change.',
          blockedBy: ['T-factory'],
        }),
      ],
    ]);
    const { orch, verifyCalls } = factoryOrchestrator({ tasks, client, workspaces });

    const report = await orch.tick();
    expect(report.dispatched).not.toContain('T-next');
    expect(workspaces.refreshCalls).toBeGreaterThan(0);
    expect(workspaces.createCalls).toBe(0);
    expect(client.launches).toHaveLength(0);
    expect(verifyCalls.n).toBe(0);
    expect(tasks.get('T-next')?.state).toBe('todo');
  });

  it('requeues a factory PR when injected GitHub checks are red and relaunches on the head', async () => {
    const client = new ScriptedClient();
    const workspaces = new RefusingWorkspaces('/tmp/hercules-cursor-factory-ring8');
    const tasks = new Map([
      ['T-factory', task('T-factory', { body: 'Land the factory cut that fails gates.' })],
    ]);
    const { orch, starts, verifyCalls } = factoryOrchestrator({ tasks, client, workspaces });

    expect((await orch.tick()).dispatched).toEqual(['T-factory']);
    expect(client.launches[0]?.ref).toBe('main');
    await flush();
    expect((await orch.tick()).completed).toEqual(['T-factory']);
    expect(tasks.get('T-factory')?.state).toBe('review');
    expect(tasks.get('T-factory')?.prUrl).toBe('https://github.com/example-org/acme/pull/41');
    expect(verifyCalls.n).toBe(0);
    expect(workspaces.createCalls).toBe(0);

    const gh = async (args: readonly string[]) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            url: 'https://github.com/example-org/acme/pull/41',
            baseRefName: 'main',
            headRefName: 'cursor/cloud-T-factory-abc',
            state: 'OPEN',
            mergeable: 'MERGEABLE',
            statusCheckRollup: [
              {
                name: 'CI / gates',
                conclusion: 'FAILURE',
                status: 'COMPLETED',
              },
            ],
          }),
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'nope' };
    };
    const actions = new ActionService(
      new FakePort(tasks, repos()),
      {
        async probe() {
          return { branches: ['main'] };
        },
      },
      gh,
    );
    expect((await actions.syncOpenPrStatuses()).updated).toEqual(['T-factory']);
    const requeued = tasks.get('T-factory');
    expect(requeued?.state).toBe('todo');
    expect(requeued?.prStatus).toBe('open');
    expect(requeued?.pendingSteer).toMatch(/GitHub CI is failing/i);
    expect(requeued?.pendingSteer).toContain('CI / gates');
    expect(requeued?.pendingSteer).toContain('cursor/cloud-T-factory-abc');
    expect(requeued?.pendingSteer).not.toMatch(/work \*\*only\*\* on branch `hercules\/T-factory`/i);
    expect(requeued?.agentSession).toBeNull();
    expect(requeued?.verifiedSha ?? null).toBeNull();

    const relaunch = await orch.tick();
    expect(relaunch.dispatched).toEqual(['T-factory']);
    expect(workspaces.createCalls).toBe(0);
    expect(client.launches).toHaveLength(2);
    expect(client.launches[0]?.existingPr).toBeUndefined();
    expect(client.launches[1]?.ref).toBe('cursor/cloud-T-factory-abc');
    expect(client.launches[1]?.existingPr).toEqual({
      prUrl: 'https://github.com/example-org/acme/pull/41',
      prNumber: 41,
    });
    expect(client.launches[1]?.prompt).toContain('https://github.com/example-org/acme/pull/41');
    expect(client.launches[1]?.prompt).toContain('cursor/cloud-T-factory-abc');
    expect(client.launches[1]?.prompt).toMatch(/Do \*\*not\*\* create `hercules\/T-factory`/);
    expect(starts[1]?.ref).toBe('cursor/cloud-T-factory-abc');
    expect(starts[1]?.existingFactoryPr).toEqual({
      prUrl: 'https://github.com/example-org/acme/pull/41',
      prNumber: 41,
    });
    expect(starts[1]?.resumeSessionId).toBeUndefined();

    await flush();
    expect((await orch.tick()).completed).toEqual(['T-factory']);
    const reviewed = tasks.get('T-factory');
    expect(reviewed?.state).toBe('review');
    expect(reviewed?.prUrl).toBe('https://github.com/example-org/acme/pull/41');
    expect(reviewed?.prStatus).toBe('open');
    expect(reviewed?.verifiedSha ?? null).toBeNull();
    expect(verifyCalls.n).toBe(0);
    expect(workspaces.createCalls).toBe(0);
  });

  it('rebases a BEHIND factory PR via gh so a sibling merge does not relaunch', async () => {
    const client = new ScriptedClient();
    const workspaces = new RefusingWorkspaces('/tmp/hercules-cursor-factory-ring15');
    const tasks = new Map([
      ['T-factory', task('T-factory', { body: 'Land the parallel factory slice.' })],
    ]);
    const { orch, verifyCalls } = factoryOrchestrator({ tasks, client, workspaces });

    expect((await orch.tick()).dispatched).toEqual(['T-factory']);
    expect(client.launches[0]?.ref).toBe('main');
    await flush();
    expect((await orch.tick()).completed).toEqual(['T-factory']);
    expect(tasks.get('T-factory')?.state).toBe('review');
    expect(tasks.get('T-factory')?.prUrl).toBe('https://github.com/example-org/acme/pull/41');
    expect(verifyCalls.n).toBe(0);
    expect(workspaces.createCalls).toBe(0);

    const calls: string[][] = [];
    const gh = async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'rebase') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            url: 'https://github.com/example-org/acme/pull/41',
            baseRefName: 'main',
            headRefName: 'cursor/cloud-T-factory-abc',
            state: 'OPEN',
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'BEHIND',
            statusCheckRollup: [
              {
                name: 'CI / gates',
                conclusion: 'SUCCESS',
                status: 'COMPLETED',
              },
            ],
          }),
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'nope' };
    };
    const actions = new ActionService(
      new FakePort(tasks, repos()),
      {
        async probe() {
          return { branches: ['main'] };
        },
      },
      gh,
    );
    expect((await actions.syncOpenPrStatuses()).updated).toEqual(['T-factory']);
    const rebased = tasks.get('T-factory');
    expect(rebased?.state).toBe('review');
    expect(rebased?.prStatus).toBe('open');
    expect(rebased?.pendingSteer).toBeNull();
    expect(rebased?.body).toMatch(/Factory PR rebased via GitHub/);
    expect(rebased?.body).toContain('https://github.com/example-org/acme/pull/41');
    expect(rebased?.verifiedSha ?? null).toBeNull();
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'rebase')).toBe(true);
    expect(client.launches).toHaveLength(1);

    expect((await orch.tick()).dispatched).toEqual([]);
    expect(client.launches).toHaveLength(1);
    expect(workspaces.createCalls).toBe(0);
    expect(verifyCalls.n).toBe(0);
  });

  it('requeues a BEHIND factory PR and relaunches on the Cloud Agent head', async () => {
    const client = new ScriptedClient();
    const workspaces = new RefusingWorkspaces('/tmp/hercules-cursor-factory-ring9');
    const tasks = new Map([
      ['T-factory', task('T-factory', { body: 'Land the parallel factory slice.' })],
    ]);
    const { orch, starts, verifyCalls } = factoryOrchestrator({ tasks, client, workspaces });

    expect((await orch.tick()).dispatched).toEqual(['T-factory']);
    expect(client.launches[0]?.ref).toBe('main');
    await flush();
    expect((await orch.tick()).completed).toEqual(['T-factory']);
    expect(tasks.get('T-factory')?.state).toBe('review');
    expect(tasks.get('T-factory')?.prUrl).toBe('https://github.com/example-org/acme/pull/41');
    expect(verifyCalls.n).toBe(0);
    expect(workspaces.createCalls).toBe(0);

    const gh = async (args: readonly string[]) => {
      if (args[0] === 'pr' && args[1] === 'rebase') {
        return { exitCode: 1, stdout: '', stderr: 'cannot rebase: merge conflict' };
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            url: 'https://github.com/example-org/acme/pull/41',
            baseRefName: 'main',
            headRefName: 'cursor/cloud-T-factory-abc',
            state: 'OPEN',
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'BEHIND',
            statusCheckRollup: [
              {
                name: 'CI / gates',
                conclusion: 'SUCCESS',
                status: 'COMPLETED',
              },
            ],
          }),
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'nope' };
    };
    const actions = new ActionService(
      new FakePort(tasks, repos()),
      {
        async probe() {
          return { branches: ['main'] };
        },
      },
      gh,
    );
    expect((await actions.syncOpenPrStatuses()).updated).toEqual(['T-factory']);
    const requeued = tasks.get('T-factory');
    expect(requeued?.state).toBe('todo');
    expect(requeued?.prStatus).toBe('open');
    expect(requeued?.pendingSteer).toMatch(/BEHIND/i);
    expect(requeued?.pendingSteer).toContain('cursor/cloud-T-factory-abc');
    expect(requeued?.pendingSteer).not.toMatch(/work \*\*only\*\* on branch `hercules\/T-factory`/i);
    expect(requeued?.agentSession).toBeNull();
    expect(requeued?.verifiedSha ?? null).toBeNull();

    const relaunch = await orch.tick();
    expect(relaunch.dispatched).toEqual(['T-factory']);
    expect(workspaces.createCalls).toBe(0);
    expect(client.launches).toHaveLength(2);
    expect(client.launches[0]?.existingPr).toBeUndefined();
    expect(client.launches[1]?.ref).toBe('cursor/cloud-T-factory-abc');
    expect(client.launches[1]?.existingPr).toEqual({
      prUrl: 'https://github.com/example-org/acme/pull/41',
      prNumber: 41,
    });
    expect(client.launches[1]?.prompt).toContain('https://github.com/example-org/acme/pull/41');
    expect(client.launches[1]?.prompt).toContain('cursor/cloud-T-factory-abc');
    expect(client.launches[1]?.prompt).toMatch(/Do \*\*not\*\* create `hercules\/T-factory`/);
    expect(starts[1]?.ref).toBe('cursor/cloud-T-factory-abc');
    expect(starts[1]?.existingFactoryPr).toEqual({
      prUrl: 'https://github.com/example-org/acme/pull/41',
      prNumber: 41,
    });
    expect(starts[1]?.resumeSessionId).toBeUndefined();

    await flush();
    expect((await orch.tick()).completed).toEqual(['T-factory']);
    const reviewed = tasks.get('T-factory');
    expect(reviewed?.state).toBe('review');
    expect(reviewed?.prUrl).toBe('https://github.com/example-org/acme/pull/41');
    expect(reviewed?.prStatus).toBe('open');
    expect(reviewed?.verifiedSha ?? null).toBeNull();
    expect(verifyCalls.n).toBe(0);
    expect(workspaces.createCalls).toBe(0);
  });

  it('marks a finished factory draft ready so the human can merge', async () => {
    const MERGE_SHA = 'd'.repeat(40);
    const client = new ScriptedClient();
    const workspaces = new RefusingWorkspaces('/tmp/hercules-cursor-factory-ring10');
    const tasks = new Map([
      ['T-factory', task('T-factory', { body: 'Land the factory cut that opens a draft.' })],
    ]);
    const { orch, verifyCalls } = factoryOrchestrator({ tasks, client, workspaces });

    expect((await orch.tick()).dispatched).toEqual(['T-factory']);
    expect(client.launches[0]?.prompt).toContain('## Factory PR (done artifact)');
    await flush();
    expect((await orch.tick()).completed).toEqual(['T-factory']);
    expect(tasks.get('T-factory')?.state).toBe('review');
    expect(tasks.get('T-factory')?.prUrl).toBe('https://github.com/example-org/acme/pull/41');
    expect(verifyCalls.n).toBe(0);
    expect(workspaces.createCalls).toBe(0);

    const calls: string[][] = [];
    let draft = true;
    const gh = async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'ready') {
        draft = false;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            url: 'https://github.com/example-org/acme/pull/41',
            baseRefName: 'main',
            headRefName: 'cursor/cloud-T-factory-abc',
            state: 'OPEN',
            mergeable: 'MERGEABLE',
            mergeStateStatus: draft ? 'DRAFT' : 'CLEAN',
            isDraft: draft,
            statusCheckRollup: [
              {
                name: 'CI / gates',
                conclusion: 'SUCCESS',
                status: 'COMPLETED',
              },
            ],
          }),
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'nope' };
    };
    const actions = new ActionService(
      new FakePort(tasks, repos()),
      {
        async probe() {
          return { branches: ['main'] };
        },
      },
      gh,
    );
    expect((await actions.syncOpenPrStatuses()).updated).toEqual(['T-factory']);
    const ready = tasks.get('T-factory');
    expect(ready?.state).toBe('review');
    expect(ready?.prStatus).toBe('open');
    expect(ready?.pendingSteer).toBeNull();
    expect(ready?.body).toMatch(/Factory PR marked ready/);
    expect(ready?.body).toContain('https://github.com/example-org/acme/pull/41');
    expect(ready?.verifiedSha ?? null).toBeNull();
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'ready')).toBe(true);
    expect(draft).toBe(false);

    const mergeGh = async (args: readonly string[]) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            url: 'https://github.com/example-org/acme/pull/41',
            baseRefName: 'main',
            headRefName: 'cursor/cloud-T-factory-abc',
            state: 'MERGED',
            mergeCommit: { oid: MERGE_SHA },
          }),
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'nope' };
    };
    const mergeActions = new ActionService(
      new FakePort(tasks, repos()),
      {
        async probe() {
          return { branches: ['main'] };
        },
      },
      mergeGh,
    );
    expect((await mergeActions.syncOpenPrStatuses()).updated).toEqual(['T-factory']);
    const closed = tasks.get('T-factory');
    expect(closed?.state).toBe('done');
    expect(closed?.prStatus).toBe('merged');
    expect(closed?.mergedSha).toBe(MERGE_SHA);
    expect(closed?.mergedVia).toBe('operator');
    expect(closed?.verifiedSha ?? null).toBeNull();
    expect(verifyCalls.n).toBe(0);
    expect(workspaces.createCalls).toBe(0);
    expect(client.launches).toHaveLength(1);
  });

  it('squash-merges a CLEAN green factory PR so dependents are not parked on a human click', async () => {
    const MERGE_SHA = 'f'.repeat(40);
    const client = new ScriptedClient();
    const workspaces = new RefusingWorkspaces('/tmp/hercules-cursor-factory-ring12');
    const tasks = new Map([
      ['T-factory', task('T-factory', { body: 'Land the factory cut that is ready to merge.' })],
      [
        'T-next',
        task('T-next', {
          body: 'Implement the follow-on change.',
          blockedBy: ['T-factory'],
        }),
      ],
    ]);
    const { orch, verifyCalls } = factoryOrchestrator({ tasks, client, workspaces });

    expect((await orch.tick()).dispatched).toEqual(['T-factory']);
    await flush();
    expect((await orch.tick()).completed).toEqual(['T-factory']);
    expect(tasks.get('T-factory')?.state).toBe('review');
    expect(tasks.get('T-factory')?.prUrl).toBe('https://github.com/example-org/acme/pull/41');
    expect(verifyCalls.n).toBe(0);
    expect(workspaces.createCalls).toBe(0);

    const calls: string[][] = [];
    let merged = false;
    const gh = async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'merge') {
        merged = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            url: 'https://github.com/example-org/acme/pull/41',
            baseRefName: 'main',
            headRefName: 'cursor/cloud-T-factory-abc',
            state: merged ? 'MERGED' : 'OPEN',
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'CLEAN',
            isDraft: false,
            statusCheckRollup: [
              {
                name: 'CI / gates',
                conclusion: 'SUCCESS',
                status: 'COMPLETED',
              },
            ],
            ...(merged ? { mergeCommit: { oid: MERGE_SHA } } : {}),
          }),
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'nope' };
    };
    const actions = new ActionService(
      new FakePort(tasks, repos()),
      {
        async probe() {
          return { branches: ['main'] };
        },
      },
      gh,
    );
    expect((await actions.syncOpenPrStatuses()).updated).toEqual(['T-factory']);
    const closed = tasks.get('T-factory');
    expect(closed?.state).toBe('done');
    expect(closed?.prStatus).toBe('merged');
    expect(closed?.mergedSha).toBe(MERGE_SHA);
    expect(closed?.mergedVia).toBe('operator');
    expect(closed?.verifiedSha ?? null).toBeNull();
    expect(closed?.body).toMatch(/Factory PR merged via GitHub/);
    expect(merged).toBe(true);
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'merge' && args.includes('--squash'))).toBe(true);
    expect(verifyCalls.n).toBe(0);
    expect(workspaces.createCalls).toBe(0);
    expect(client.launches).toHaveLength(1);
  });

  it('persists the live Cloud Agent handle and reattaches after restart instead of launching again', async () => {
    const PR = {
      prUrl: 'https://github.com/example-org/acme/pull/41',
      prNumber: 41,
    };
    const client = new ScriptedClient();
    client.launch = async (request) => {
      client.launches.push(request);
      const snap: CursorCloudSnapshot = { id: 'bc_live', status: 'running', pr: PR };
      client.byId.set(snap.id, snap);
      return snap;
    };
    const workspaces = new RefusingWorkspaces('/tmp/hercules-cursor-factory-ring16');
    const tasks = new Map([
      ['T-factory', task('T-factory', { body: 'Land the factory cut that outlives a restart.' })],
    ]);
    const sleep = async (ms: number): Promise<void> => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
    };
    const first = factoryOrchestrator({
      tasks,
      client,
      workspaces,
      pollIntervalMs: 20,
      sleep,
    });

    expect((await first.orch.tick()).dispatched).toEqual(['T-factory']);
    expect(client.launches).toHaveLength(1);
    expect(first.starts[0]?.attachFactoryAgentId).toBeUndefined();
    await flush();
    expect((await first.orch.tick()).completed).toEqual([]);
    const live = tasks.get('T-factory');
    expect(live?.state).toBe('in_progress');
    expect(live?.agentSession).toBe('bc_live');
    expect(live?.agentSessionAdapter).toBe('cursor');
    expect(live?.prUrl).toBe(PR.prUrl);
    expect(live?.prStatus).toBe('open');
    expect(live?.verifiedSha ?? null).toBeNull();

    const restarted = factoryOrchestrator({
      tasks,
      client,
      workspaces: new RefusingWorkspaces('/tmp/hercules-cursor-factory-ring16-restart'),
      pollIntervalMs: 20,
      sleep,
    });
    const recovered = await restarted.orch.tick();
    expect(recovered.recovered).toEqual(['T-factory']);
    expect(recovered.dispatched).toEqual([]);
    expect(client.launches).toHaveLength(1);
    expect(restarted.starts).toHaveLength(1);
    expect(restarted.starts[0]?.attachFactoryAgentId).toBe('bc_live');
    expect(restarted.starts[0]?.existingFactoryPr).toEqual(PR);
    expect(tasks.get('T-factory')?.state).toBe('in_progress');

    client.byId.set('bc_live', {
      id: 'bc_live',
      status: 'finished',
      pr: PR,
      summary: 'Finished after reattach.',
    });
    await sleep(50);
    expect((await restarted.orch.tick()).completed).toEqual(['T-factory']);
    const done = tasks.get('T-factory');
    expect(done?.state).toBe('review');
    expect(done?.prUrl).toBe(PR.prUrl);
    expect(done?.prStatus).toBe('open');
    expect(done?.verifiedSha ?? null).toBeNull();
    expect(client.launches).toHaveLength(1);
    expect(first.verifyCalls.n).toBe(0);
    expect(restarted.verifyCalls.n).toBe(0);
    expect(workspaces.createCalls).toBe(0);
  });

  it('still relaunches a factory orphan that has no persisted Cloud Agent id', async () => {
    const client = new ScriptedClient();
    const workspaces = new RefusingWorkspaces('/tmp/hercules-cursor-factory-ring16-nosession');
    const tasks = new Map([
      [
        'T-factory',
        task('T-factory', {
          state: 'in_progress',
          startedAt: '2026-08-27T00:00:00.000Z',
          agentSession: null,
          body: 'Coordinator died before the Cloud Agent id landed.',
        }),
      ],
    ]);
    const { orch, starts } = factoryOrchestrator({ tasks, client, workspaces });

    const first = await orch.tick();
    expect(first.recovered).toEqual(['T-factory']);
    expect(first.dispatched).toEqual(['T-factory']);
    expect(client.launches).toHaveLength(1);
    expect(starts[0]?.attachFactoryAgentId).toBeUndefined();
    expect(tasks.get('T-factory')?.state).toBe('in_progress');
  });
});

