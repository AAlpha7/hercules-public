import { describe, it, expect } from 'vitest';
import {
  Orchestrator,
  type ControlPort,
} from '../../src/orchestrator/orchestrator.js';
import { AgentRegistry } from '../../src/orchestrator/agentRegistry.js';
import { FakeAdapter } from '../../src/orchestrator/fakeAdapter.js';
import { makeConfig } from '../../src/config.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import type { Task, TaskState } from '../../src/domain/task.js';
import type { ReposConfig } from '../../src/domain/repos.js';

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

class FakePort implements ControlPort {
  readonly commits: string[] = [];
  syncs = 0;
  reads = 0;
  readonly readResults: ControlSnapshot[] = [];
  constructor(
    readonly tasks: Map<string, Task>,
    private readonly repos: ReposConfig,
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
  async deleteTask(id: string): Promise<void> {
    this.tasks.delete(id);
  }
  async commit(message: string): Promise<{ committed: boolean }> {
    this.commits.push(message);
    return { committed: true };
  }
  async writeRepos(): Promise<void> {}
}

function setup(
  tasks: Task[],
  opts: {
    adapter?: FakeAdapter;
    config?: Parameters<typeof makeConfig>[1];
  } = {},
): { orch: Orchestrator; port: FakePort; clock: { now: number } } {
  const port = new FakePort(
    new Map(tasks.map((t) => [t.id, t])),
    reposWithCaps({ app: 1 }),
  );
  const adapter = opts.adapter ?? new FakeAdapter({ durationMs: 100 });
  const clock = { now: 0 };
  const orch = new Orchestrator({
    config: makeConfig('/ctrl', opts.config),
    control: port,
    agents: AgentRegistry.of(adapter),
    clock: () => clock.now,
  });
  return { orch, port, clock };
}

describe('Orchestrator.tick — snapshot read-after-write', () => {
  it('publishes completed task state in getState().snapshot before tick resolves', async () => {
    const { orch, port, clock } = setup([task('A')], {
      adapter: new FakeAdapter({ durationMs: 100 }),
    });
    await orch.tick();
    clock.now = 100;

    let emittedState: ReturnType<Orchestrator['getState']> | null = null;
    orch.subscribe((view) => {
      emittedState = view;
    });

    // Capture pre-mutation identity from the completion tick's first read.
    const readsAtSubscribe = port.reads;
    const report = await orch.tick();

    expect(report.completed).toEqual(['A']);
    expect(report.running).toEqual([]);
    const snapTask = orch.getState().snapshot?.tasks.find((t) => t.id === 'A');
    expect(snapTask?.state).toBe('review');
    expect(emittedState).not.toBeNull();
    expect(emittedState!.snapshot?.tasks.find((t) => t.id === 'A')?.state).toBe('review');
    expect(emittedState!.running).toEqual([]);
    // Published view must be the final local read — never the pre-mutation snap.
    const finalRead = port.readResults[port.readResults.length - 1];
    const firstReadThisTick = port.readResults[readsAtSubscribe];
    expect(orch.getState().snapshot).toBe(finalRead);
    expect(emittedState!.snapshot).toBe(finalRead);
    expect(finalRead).not.toBe(firstReadThisTick);
    expect(firstReadThisTick?.tasks.find((t) => t.id === 'A')?.state).not.toBe('review');
  });

  it('publishes recovery + dispatch writes without a second tick', async () => {
    const { orch, port } = setup([
      task('A', { state: 'in_progress', agentSession: 'dead' }),
    ]);

    let emits = 0;
    let emittedState: ReturnType<Orchestrator['getState']> | null = null;
    orch.subscribe((view) => {
      emits += 1;
      emittedState = view;
    });

    const readsBefore = port.reads;
    const report = await orch.tick();
    expect(report.recovered).toEqual(['A']);
    expect(report.dispatched).toEqual(['A']);
    expect(port.tasks.get('A')!.state).toBe('in_progress');
    expect(port.tasks.get('A')!.agentSession).not.toBe('dead');
    const published = orch.getState().snapshot?.tasks.find((t) => t.id === 'A');
    expect(published?.state).toBe('in_progress');
    expect(published?.agentSession).toBe(port.tasks.get('A')!.agentSession);
    expect(published?.agentSession).not.toBe('dead');
    expect(emittedState!.snapshot?.tasks.find((t) => t.id === 'A')?.agentSession).not.toBe(
      'dead',
    );
    expect(emittedState!.running).toEqual(['A']);
    expect(emits).toBe(1);
    // Same tick: recovery + re-dispatch are visible; not the orphan's dead session.
    const finalRead = port.readResults[port.readResults.length - 1];
    const firstRead = port.readResults[readsBefore];
    expect(orch.getState().snapshot).toBe(finalRead);
    expect(emittedState!.snapshot).toBe(finalRead);
    expect(firstRead?.tasks.find((t) => t.id === 'A')?.agentSession).toBe('dead');
    expect(finalRead?.tasks.find((t) => t.id === 'A')?.agentSession).not.toBe('dead');
  });

  it('dispatch-enabled mode does one final local read and no extra sync', async () => {
    const { orch, port } = setup([task('A')]);
    const readsBefore = port.reads;
    const syncsBefore = port.syncs;

    await orch.tick();

    expect(port.syncs - syncsBefore).toBe(1);
    expect(port.reads - readsBefore).toBeGreaterThanOrEqual(2);
    expect(orch.getState().snapshot).toBe(port.readResults[port.readResults.length - 1]);
    expect(orch.getState().snapshot?.tasks.find((t) => t.id === 'A')?.state).toBe(
      'in_progress',
    );
  });

  it('observer mode stays read-only and may keep the initial snapshot', async () => {
    const { orch, port } = setup([task('A')], {
      config: { dispatchEnabled: false },
    });

    let emits = 0;
    orch.subscribe(() => {
      emits += 1;
    });

    const readsBefore = port.reads;
    const syncsBefore = port.syncs;
    await orch.tick();

    expect(port.syncs - syncsBefore).toBe(1);
    expect(port.reads - readsBefore).toBe(1);
    expect(port.commits).toEqual([]);
    expect(port.tasks.get('A')!.state).toBe('todo');
    expect(orch.getState().snapshot?.tasks.find((t) => t.id === 'A')?.state).toBe('todo');
    expect(orch.getState().snapshot).toBe(port.readResults[port.readResults.length - 1]);
    expect(emits).toBe(1);
  });

  it('refreshSnapshotFromControl still syncs then reads (ActionService path)', async () => {
    const { orch, port } = setup([task('P', { planPending: true })]);
    await orch.tick();
    port.tasks.set('P', { ...port.tasks.get('P')!, planPending: false });

    const syncsBefore = port.syncs;
    const readsBefore = port.reads;
    await orch.refreshSnapshotFromControl();

    expect(port.syncs - syncsBefore).toBe(1);
    expect(port.reads - readsBefore).toBe(1);
    expect(orch.getState().snapshot?.tasks.find((t) => t.id === 'P')?.planPending).toBe(false);
    expect(orch.getState().snapshot).toBe(port.readResults[port.readResults.length - 1]);
  });
});
