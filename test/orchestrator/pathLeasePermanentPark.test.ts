import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Orchestrator,
  type ControlMutation,
  type ControlPort,
} from '../../src/orchestrator/orchestrator.js';
import { AgentRegistry } from '../../src/orchestrator/agentRegistry.js';
import { FakeAdapter } from '../../src/orchestrator/fakeAdapter.js';
import { makeConfig } from '../../src/config.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import type { Task, TaskState } from '../../src/domain/task.js';
import type { ReposConfig } from '../../src/domain/repos.js';
import { NoopWorkspaces } from '../../src/isolation/worktree.js';
import { TaskPathLeaseStore } from '../../src/isolation/taskPathLeaseStore.js';
import { ControlMutationConflictError } from '../../src/orchestrator/gitControlPort.js';

const BASE = 'a'.repeat(40);
const STALE = 'b'.repeat(40);

function repos(over: { maxConcurrent?: number; guardian?: boolean } = {}): ReposConfig {
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
        ...(over.guardian ? { executionPolicy: { profile: 'guardian' as const } } : {}),
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

class MemoryPort implements ControlPort {
  failMutationsRemaining = 0;
  mutationAttempts = 0;
  /** When set, only these task ids receive injected CAS failures. */
  failTaskIds: Set<string> | null = null;

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
    return { committed: true };
  }
  async writeRepos(): Promise<void> {}

  async mutateCommitted(
    mutation: ControlMutation,
    _message: string,
  ): Promise<{ committed: boolean }> {
    this.mutationAttempts += 1;
    const id =
      mutation.writeTasks && mutation.writeTasks[0]
        ? mutation.writeTasks[0].next.id
        : 'unknown';
    const scoped =
      this.failTaskIds === null || this.failTaskIds.has(id);
    if (scoped && this.failMutationsRemaining > 0) {
      this.failMutationsRemaining -= 1;
      throw new ControlMutationConflictError(
        "task '" + id + "' changed before atomic mutation",
      );
    }
    for (const write of mutation.writeTasks ?? []) {
      this.tasks.set(write.next.id, write.next);
    }
    for (const id of mutation.deleteTaskIds ?? []) {
      this.tasks.delete(id);
    }
    return { committed: true };
  }
}

function workspacesWithTip(tip: string): NoopWorkspaces {
  const base = new NoopWorkspaces('/tmp/noop-ws-permanent-park');
  base.setDefaultBranchTip(tip);
  base.setTrustedWorkflow('---\nprotected_paths: []\n---\n');
  return base;
}

async function makeStore(): Promise<TaskPathLeaseStore> {
  const root = await mkdtemp(join(tmpdir(), 'orch-path-lease-permanent-'));
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

describe('path lease permanent park (no tick thrash)', () => {
  it('parks permanent stale_base so the task is not forever-selectable todo', async () => {
    const store = await makeStore();
    const adapter = new FakeAdapter({ durationMs: 50 });
    const stale = task('STALE-PERM', {
      plannedBaseRevision: STALE,
      affectedPaths: ['docs/stale.md'],
      protectedPathsSnapshot: [],
      priority: 1,
    });
    const port = new MemoryPort(new Map([[stale.id, stale]]), repos());
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
    expect(adapter.started).toHaveLength(0);
    const parked = port.tasks.get(stale.id)!;
    expect(parked.state).toBe('review');
    expect(parked.body).toMatch(/Path lease blocked|Stale base/);

    // Second tick must not re-select a parked permanent defect.
    const second = await orch.tick();
    expect(second.dispatched).toEqual([]);
    expect(port.tasks.get(stale.id)!.state).toBe('review');
  });

  it('retries park once after CAS failure and still parks durably', async () => {
    const store = await makeStore();
    const adapter = new FakeAdapter({ durationMs: 50 });
    const stale = task('STALE-CAS-RETRY', {
      plannedBaseRevision: STALE,
      affectedPaths: ['docs/stale.md'],
      protectedPathsSnapshot: [],
    });
    const port = new MemoryPort(new Map([[stale.id, stale]]), repos());
    // First mutate fails (CAS), second succeeds on retry.
    port.failMutationsRemaining = 1;
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
    expect(port.mutationAttempts).toBeGreaterThanOrEqual(2);
    expect(port.tasks.get(stale.id)!.state).toBe('review');
    expect(port.tasks.get(stale.id)!.body).toMatch(/Path lease blocked|Stale base/);
  });

  it('does not abort the tick when park CAS keeps failing; peer tasks still dispatch', async () => {
    const store = await makeStore();
    const adapter = new FakeAdapter({ durationMs: 10_000 });
    const stale = task('STALE-CAS-HARD', {
      plannedBaseRevision: STALE,
      affectedPaths: ['docs/stale.md'],
      protectedPathsSnapshot: [],
      priority: 1,
    });
    const peer = task('PEER-OK', {
      plannedBaseRevision: BASE,
      affectedPaths: ['src/peer.ts'],
      protectedPathsSnapshot: [],
      priority: 50,
    });
    const port = new MemoryPort(
      new Map([
        [stale.id, stale],
        [peer.id, peer],
      ]),
      repos({ maxConcurrent: 4 }),
    );
    // Exhaust first attempt + single retry for the permanent park.
    port.failMutationsRemaining = 10;
    port.failTaskIds = new Set([stale.id]);
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      agents: AgentRegistry.of(adapter),
      workspaces: workspacesWithTip(BASE),
      pathLeaseStore: store,
      clock: () => 0,
    });

    // Must not throw out of the tick when park CAS fails repeatedly.
    const report = await orch.tick();

    // Peer must still run; permanent-defect task stays out of dispatch this tick.
    expect(report.dispatched).toContain(peer.id);
    expect(adapter.started.map((s) => s.taskId)).toContain(peer.id);
    expect(report.dispatched).not.toContain(stale.id);
    // Still selectable next tick only if not parked; CAS hard-fail leaves todo
    // but must not have aborted the loop mid-tick.
    expect(port.tasks.get(stale.id)!.state).toBe('todo');
  });

  it('keeps transient writer_limit retriable (todo) without parking', async () => {
    const store = await makeStore();
    const adapter = new FakeAdapter({ durationMs: 10_000 });
    const a = task('WRITER-A', {
      plannedBaseRevision: BASE,
      affectedPaths: ['src/a.ts'],
      protectedPathsSnapshot: [],
      priority: 1,
    });
    const b = task('WRITER-B', {
      plannedBaseRevision: BASE,
      affectedPaths: ['docs/b.md'],
      protectedPathsSnapshot: [],
      priority: 20,
    });
    const port = new MemoryPort(
      new Map([
        [a.id, a],
        [b.id, b],
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
    expect(report.dispatched).toHaveLength(1);
    const stillTodo = [...port.tasks.values()].filter((t) => t.state === 'todo');
    expect(stillTodo).toHaveLength(1);
    expect(stillTodo[0]!.body).not.toMatch(/Path lease blocked/);
  });
});
