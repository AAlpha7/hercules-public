/**
 * Regression: cancel / force-abort during post-agent verification
 * (production incident 2026-07-31 — cargo L1 outlived cancel).
 */
import { describe, it, expect } from 'vitest';
import { Orchestrator, type ControlPort } from '../../src/orchestrator/orchestrator.js';
import { AgentRegistry } from '../../src/orchestrator/agentRegistry.js';
import { FakeAdapter } from '../../src/orchestrator/fakeAdapter.js';
import { makeConfig } from '../../src/config.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import type { Task, TaskState } from '../../src/domain/task.js';
import type { ReposConfig } from '../../src/domain/repos.js';
import type { Workspaces, WorkspaceImpact } from '../../src/isolation/worktree.js';
import type { Workspace } from '../../src/domain/allocation.js';
import {
  VerificationAbortedError,
  type VerificationProgress,
  type VerificationRunMeta,
} from '../../src/domain/verificationRun.js';
import type { ReviewPacket } from '../../src/domain/verification.js';
import type { Verifier, VerifyOptions } from '../../src/orchestrator/verifier.js';

function reposWithCaps(caps: Record<string, number>): ReposConfig {
  const entries = Object.entries(caps).map(([key, maxConcurrent]) => [
    key,
    {
      key,
      url: 'x',
      defaultBranch: 'main',
      workflow: 'WORKFLOW.md',
      maxConcurrent,
      adapter: null,
    },
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

const PACKET_EXTRA = {
  runKind: 'implementer' as const,
  reviewerSkipReason: null,
  diffUrl: null,
  evidenceMatrix: [] as const,
  verifiedSha: 'cafe1234cafe1234cafe1234cafe1234cafe1234',
  reworkPath: null as 'steer' | 'full' | null,
  reworkPathReason: null as string | null,
};

const greenPacket: ReviewPacket = {
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

class FakePort implements ControlPort {
  readonly commits: string[] = [];
  constructor(
    readonly tasks: Map<string, Task>,
    private readonly repos: ReposConfig,
  ) {}
  async sync(): Promise<void> {}
  async read(): Promise<ControlSnapshot> {
    return { repos: this.repos, tasks: [...this.tasks.values()], problems: [] };
  }
  async writeTask(t: Task): Promise<void> {
    this.tasks.set(t.id, t);
  }
  async deleteTask(id: string): Promise<void> {
    this.tasks.delete(id);
  }
  async commit(message: string): Promise<{ committed: boolean }> {
    this.commits.push(message);
    return { committed: true };
  }
  async writeRepos(): Promise<void> {}
}

class SpyWorkspaces implements Workspaces {
  removed: string[] = [];
  preserved: string[] = [];
  async create(
    repo: import('../../src/domain/repos.js').RepoConfig,
    taskId: string,
    _opts?: { readonly hadPriorWork?: boolean },
  ): Promise<Workspace> {
    return {
      taskId,
      repo: repo.key,
      dir: `/ws/${repo.key}/${taskId}`,
      branch: `hercules/${taskId}`,
      allocation: {
        slug: taskId,
        port: 4100,
        scratchDir: `/ws/${repo.key}/${taskId}/.scratch`,
      },
      branchLease: { expectedBaseRevision: '0'.repeat(40), expectedRemoteTip: null },
    };
  }
  async remove(id: string): Promise<void> {
    this.removed.push(id);
  }
  async preserve(
    taskId: string,
    _message: string,
  ): Promise<{ notPropagated: boolean; events: readonly string[] }> {
    this.preserved.push(taskId);
    return { notPropagated: false, events: [] };
  }
  async inspect(_taskId: string): Promise<WorkspaceImpact> {
    return { changedFiles: 1, localCommits: 1, pushedRemote: false };
  }
  async readWorkflow(): Promise<string | null> {
    return null;
  }
  async reclaimOrphans(_keep: ReadonlySet<string>): Promise<string[]> {
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Narrow verify() 4th arg — Array.isArray does not strip readonly string[]. */
function asVerifyOptions(
  opts: readonly string[] | VerifyOptions | undefined,
): VerifyOptions | undefined {
  if (opts === undefined || Array.isArray(opts)) return undefined;
  // After Array.isArray false, TS still keeps readonly string[] in the union.
  return opts as VerifyOptions;
}

function verificationOf(orch: Orchestrator, id: string): VerificationRunMeta | undefined {
  return orch.getState().verificationRuns?.[id];
}

describe('Orchestrator — cancel during verification (2026-07-31)', () => {
  it('aborts a blocking verifier, clears running/stopping, keeps cancelled durable', async () => {
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    let commandAlive = false;
    let abortSeen = false;
    let verifyOpts: VerifyOptions | undefined;

    const verifier: Verifier = {
      verify: async (_t, _r, _w, opts) => {
        const bag = asVerifyOptions(opts);
        verifyOpts = bag;
        commandAlive = true;
        bag?.onProgress?.({
          phase: 'l1',
          stage: 'test',
          processAlive: true,
        } satisfies VerificationProgress);

        return await new Promise<ReviewPacket>((resolve, reject) => {
          const timer = setTimeout(() => {
            commandAlive = false;
            resolve(greenPacket);
          }, 60_000);
          const onAbort = (): void => {
            abortSeen = true;
            commandAlive = false;
            clearTimeout(timer);
            reject(new VerificationAbortedError('gate aborted'));
          };
          if (bag?.signal?.aborted) {
            onAbort();
            return;
          }
          bag?.signal?.addEventListener('abort', onAbort, { once: true });
        });
      },
    };

    const workspaces = new SpyWorkspaces();
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { maxAttempts: 3, gracePeriodMs: 5_000 }),
      control: port,
      agents: AgentRegistry.of(new FakeAdapter({ durationMs: 100 })),
      workspaces,
      verifier,
      clock: () => clock.now,
    });

    await orch.tick(); // dispatch
    expect(port.tasks.get('A')!.state).toBe('in_progress');
    expect(orch.running).toContain('A');

    clock.now = 100;
    const tickP = orch.tick(); // agent done → complete → hangs in verify

    // Wait until verify progress has painted (after pre-check await + onProgress).
    for (let i = 0; i < 100; i++) {
      const v = verificationOf(orch, 'A');
      if (v?.stage === 'test' && v.processAlive) break;
      await sleep(10);
    }
    const live = verificationOf(orch, 'A');
    expect(live).toBeDefined();
    expect(live!.phase).toBe('l1');
    expect(live!.stage).toBe('test');
    expect(live!.processAlive).toBe(true);
    expect(commandAlive).toBe(true);
    expect(verifyOpts?.signal).toBeDefined();

    // Human cancel: durable disk state + immediate abort (API contract).
    const cur = port.tasks.get('A')!;
    port.tasks.set('A', {
      ...cur,
      state: 'cancelled',
      endedAt: new Date(clock.now).toISOString(),
    });
    orch.requestCancel('A');

    expect(verificationOf(orch, 'A')?.cancelRequested).toBe(true);
    // Truthful until the aborting verifier actually settles.
    expect(verificationOf(orch, 'A')?.processAlive).toBe(true);
    // Graceful cancel: reason.force stays false (force-abort flips it).
    expect(
      (verifyOpts?.signal?.reason as { force?: boolean } | undefined)?.force,
    ).not.toBe(true);

    await tickP;

    expect(abortSeen).toBe(true);
    expect(commandAlive).toBe(false);
    expect(orch.running).not.toContain('A');
    expect(orch.stopping).not.toContain('A');
    expect(verificationOf(orch, 'A')).toBeUndefined();
    expect(port.tasks.get('A')!.state).toBe('cancelled');
    // Cancel teardown: discard worktree — do not preserve as a verifier failure.
    expect(workspaces.removed).toContain('A');
    expect(workspaces.preserved).not.toContain('A');
    expect(orch.getState().lastReport?.failed ?? []).not.toContain('A');
    expect(orch.getState().lastReport?.tornDown ?? []).toContain('A');
  });

  it('forceAbort during verification aborts and cannot be clobbered by late packet', async () => {
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    // Object box avoids TS control-flow narrowing Promise resolve/reject to never.
    const settle: {
      resolve: ((v: ReviewPacket | PromiseLike<ReviewPacket>) => void) | null;
      reject: ((reason?: unknown) => void) | null;
    } = { resolve: null, reject: null };
    let abortReason: unknown;

    const verifier: Verifier = {
      verify: async (_t, _r, _w, opts) => {
        const bag = asVerifyOptions(opts);
        bag?.onProgress?.({ phase: 'l1', stage: 'build', processAlive: true });
        return await new Promise<ReviewPacket>((resolve, reject) => {
          settle.resolve = resolve;
          settle.reject = reject;
          bag?.signal?.addEventListener(
            'abort',
            () => {
              abortReason = bag.signal?.reason;
              reject(new VerificationAbortedError('forced', true));
            },
            { once: true },
          );
        });
      },
    };

    const workspaces = new SpyWorkspaces();
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { maxAttempts: 3 }),
      control: port,
      adapter: new FakeAdapter({ durationMs: 50 }),
      workspaces,
      verifier,
      clock: () => clock.now,
    });

    await orch.tick();
    clock.now = 50;
    const tickP = orch.tick();

    for (let i = 0; i < 100; i++) {
      if (verificationOf(orch, 'A')?.stage === 'build') break;
      await sleep(10);
    }
    expect(verificationOf(orch, 'A')?.stage).toBe('build');

    // Cancel on disk then force-abort verification (immediate KILL, force=true).
    port.tasks.set('A', { ...port.tasks.get('A')!, state: 'cancelled' });
    orch.forceAbort('A');
    expect(verificationOf(orch, 'A')?.cancelRequested).toBe(true);

    await tickP;
    expect((abortReason as { force?: boolean } | undefined)?.force).toBe(true);
    expect(port.tasks.get('A')!.state).toBe('cancelled');
    expect(orch.running).not.toContain('A');
    expect(orch.stopping).not.toContain('A');
    expect(orch.getState().lastReport?.failed ?? []).not.toContain('A');
    expect(workspaces.removed).toContain('A');
    expect(workspaces.preserved).not.toContain('A');

    // Late resolve must not be possible after abort (promise already settled).
    expect(settle.resolve).not.toBeNull();
    // Calling resolve after reject is a no-op for the orchestrator path.
    settle.resolve?.(greenPacket);
    settle.reject?.(new Error('late'));
    expect(port.tasks.get('A')!.state).toBe('cancelled');
  });

  it('late green packet cannot clobber human cancel (steer-style race)', async () => {
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    const workspaces = new SpyWorkspaces();

    const verifier: Verifier = {
      verify: async () => {
        // Human cancelled while verify was still "running".
        const cur = port.tasks.get('A')!;
        port.tasks.set('A', { ...cur, state: 'cancelled' });
        return greenPacket;
      },
    };

    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { maxAttempts: 3 }),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      workspaces,
      verifier,
      clock: () => clock.now,
    });

    await orch.tick();
    clock.now = 100;
    const bodyBefore = port.tasks.get('A')!.body;
    const sessionBefore = port.tasks.get('A')!.agentSession;
    await orch.tick();

    const after = port.tasks.get('A')!;
    expect(after.state).toBe('cancelled');
    expect(after.body).toBe(bodyBefore);
    expect(after.agentSession).toBe(sessionBefore);
    expect(after.verifiedSha ?? null).toBeNull();
    expect(orch.running).not.toContain('A');
    expect(workspaces.removed).toContain('A');
    expect(workspaces.preserved).not.toContain('A');
    expect(orch.getState().lastReport?.failed ?? []).not.toContain('A');
  });

  it('late todo+steer is preserved (not clobbered, not verifier failure)', async () => {
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    const workspaces = new SpyWorkspaces();

    const verifier: Verifier = {
      verify: async () => {
        const cur = port.tasks.get('A')!;
        port.tasks.set('A', {
          ...cur,
          state: 'todo',
          pendingSteer: 'please fix the copy',
        });
        return greenPacket;
      },
    };

    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { maxAttempts: 3 }),
      control: port,
      adapter: new FakeAdapter({ durationMs: 50 }),
      workspaces,
      verifier,
      clock: () => clock.now,
    });

    await orch.tick();
    clock.now = 50;
    await orch.tick();

    const after = port.tasks.get('A')!;
    expect(after.state).toBe('todo');
    expect(after.pendingSteer).toBe('please fix the copy');
    expect(workspaces.preserved).toContain('A');
    expect(orch.getState().lastReport?.failed ?? []).not.toContain('A');
  });

  it('missing task during verify is terminal cancel teardown', async () => {
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    const workspaces = new SpyWorkspaces();

    const verifier: Verifier = {
      verify: async () => {
        port.tasks.delete('A');
        return greenPacket;
      },
    };

    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { maxAttempts: 3 }),
      control: port,
      adapter: new FakeAdapter({ durationMs: 50 }),
      workspaces,
      verifier,
      clock: () => clock.now,
    });

    await orch.tick();
    clock.now = 50;
    await orch.tick();

    expect(port.tasks.has('A')).toBe(false);
    expect(workspaces.removed).toContain('A');
    expect(workspaces.preserved).not.toContain('A');
    expect(orch.getState().lastReport?.failed ?? []).not.toContain('A');
  });
});
