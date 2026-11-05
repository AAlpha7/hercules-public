/**
 * API contract: GET /api/tasks/:id must surface the same post-mutation snapshot
 * the Orchestrator publishes after one mutating tick (completion or recovery).
 *
 * Orchestrator unit tests cover getState/subscribe; this suite crosses the real
 * createApi boundary so a stale handler cache or alternate read path cannot
 * regress the phone while the orchestrator suite stays green.
 */
import { describe, it, expect } from 'vitest';
import { createApi } from '../../src/server/api.js';
import { ActionService } from '../../src/orchestrator/actions.js';
import {
  Orchestrator,
  type ControlPort,
  type RuntimeView,
} from '../../src/orchestrator/orchestrator.js';
import { AgentRegistry } from '../../src/orchestrator/agentRegistry.js';
import { FakeAdapter } from '../../src/orchestrator/fakeAdapter.js';
import { makeConfig } from '../../src/config.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import type { Task, TaskState } from '../../src/domain/task.js';
import type { ReposConfig } from '../../src/domain/repos.js';
import type { RepoProbe } from '../../src/orchestrator/repoProbe.js';

const TOKEN = 'tick-snapshot-api-secret';
const auth = { headers: { authorization: 'Bearer tick-snapshot-api-secret' } };

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

class FakeProbe implements RepoProbe {
  async probe(): Promise<{ branches: string[] }> {
    return { branches: ['main'] };
  }
}

function identityOf(t: Task) {
  return {
    id: t.id,
    state: t.state,
    agentSession: t.agentSession,
    attempts: t.attempts,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
  };
}

function setupApi(tasks: Task[], opts: { adapter?: FakeAdapter } = {}) {
  const port = new FakePort(new Map(tasks.map((t) => [t.id, t])), reposWithCaps({ app: 1 }));
  const adapter = opts.adapter ?? new FakeAdapter({ durationMs: 100 });
  const clock = { now: 0 };
  const orch = new Orchestrator({
    config: makeConfig('/ctrl'),
    control: port,
    agents: AgentRegistry.of(adapter),
    clock: () => clock.now,
  });
  const api = createApi({
    runtime: orch,
    actions: new ActionService(port, new FakeProbe()),
    token: TOKEN,
  });
  return { api, orch, port, clock };
}

describe('GET /api/tasks/:id post-tick snapshot freshness', () => {
  it('returns completed state after one mutating tick without a second tick', async () => {
    const { api, orch, clock } = setupApi([task('A')], {
      adapter: new FakeAdapter({ durationMs: 100 }),
    });

    await orch.tick();
    clock.now = 100;

    const preSnap = orch.getState().snapshot;
    expect(preSnap).toBeTruthy();
    const preMutation = preSnap!.tasks.find((t) => t.id === 'A');
    expect(preMutation).toBeTruthy();
    expect(preMutation!.state).toBe('in_progress');
    const preIdentity = identityOf(preMutation!);

    let subscribed: RuntimeView | null = null;
    orch.subscribe((view) => {
      subscribed = view;
    });

    const report = await orch.tick();
    expect(report.completed).toEqual(['A']);
    expect(report.running).toEqual([]);

    const res = await api.request('/api/tasks/A', auth);
    expect(res.status).toBe(200);
    const apiTask = (await res.json()) as Task;

    const postSnap = orch.getState().snapshot;
    expect(postSnap).toBeTruthy();
    const runtimeTask = postSnap!.tasks.find((t) => t.id === 'A');
    expect(runtimeTask).toBeTruthy();
    expect(subscribed).toBeTruthy();
    const subTask = subscribed!.snapshot!.tasks.find((t) => t.id === 'A');
    expect(subTask).toBeTruthy();

    expect(apiTask.state).toBe('review');
    expect(apiTask.state).not.toBe(preIdentity.state);
    expect(apiTask.endedAt).not.toBe(preIdentity.endedAt);

    const apiIdentity = identityOf(apiTask);
    expect(apiIdentity).toEqual(identityOf({ ...runtimeTask!, agentSession: null }));
    expect(apiIdentity).toEqual(identityOf({ ...subTask!, agentSession: null }));
    expect(apiIdentity).not.toEqual(preIdentity);
    expect(orch.getState().snapshot).toBe(subscribed!.snapshot);
  });

  it('returns recovered re-dispatched identity after one mutating tick', async () => {
    const { api, orch, port } = setupApi([
      task('A', { state: 'in_progress', agentSession: 'dead' }),
    ]);

    let subscribed: RuntimeView | null = null;
    orch.subscribe((view) => {
      subscribed = view;
    });

    const report = await orch.tick();
    expect(report.recovered).toEqual(['A']);
    expect(report.dispatched).toEqual(['A']);

    const res = await api.request('/api/tasks/A', auth);
    expect(res.status).toBe(200);
    const apiTask = (await res.json()) as Task;

    const postSnap = orch.getState().snapshot;
    expect(postSnap).toBeTruthy();
    const runtimeTask = postSnap!.tasks.find((t) => t.id === 'A');
    expect(runtimeTask).toBeTruthy();
    expect(subscribed).toBeTruthy();
    const subTask = subscribed!.snapshot!.tasks.find((t) => t.id === 'A');
    expect(subTask).toBeTruthy();

    expect(apiTask.state).toBe('in_progress');
    expect(port.tasks.get('A')!.agentSession).not.toBe('dead');
    expect(apiTask.agentSession).toBeNull();
    expect(identityOf(apiTask)).toEqual(identityOf({ ...runtimeTask!, agentSession: null }));
    expect(identityOf(apiTask)).toEqual(identityOf({ ...subTask!, agentSession: null }));
    expect(orch.getState().snapshot).toBe(subscribed!.snapshot);
  });
});
