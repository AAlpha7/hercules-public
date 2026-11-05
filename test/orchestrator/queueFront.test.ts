import { describe, it, expect } from 'vitest';
import { ActionService, ActionError } from '../../src/orchestrator/actions.js';
import type { ControlPort } from '../../src/orchestrator/orchestrator.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import type { Task, TaskState } from '../../src/domain/task.js';
import type { ReposConfig } from '../../src/domain/repos.js';
import type { RepoProbe } from '../../src/orchestrator/repoProbe.js';

function task(id: string, state: TaskState = 'todo', priority = 100): Task {
  return {
    id,
    title: id,
    repo: 'app',
    state,
    priority,
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
    body: '',
  };
}

class FakePort implements ControlPort {
  readonly commits: string[] = [];
  repos: ReposConfig = {
    repos: {
      app: {
        key: 'app',
        url: 'x',
        defaultBranch: 'main',
        workflow: 'WORKFLOW.md',
        maxConcurrent: 1,
        adapter: null,
        readiness: 'ready',
      },
    },
  };
  constructor(readonly tasks: Map<string, Task>) {}
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
  async writeRepos(config: ReposConfig): Promise<void> {
    this.repos = config;
  }
}

class FakeProbe implements RepoProbe {
  async probe(): Promise<{ branches: string[] }> {
    return { branches: ['main'] };
  }
}

function svc(tasks: Task[]) {
  const port = new FakePort(new Map(tasks.map((t) => [t.id, t])));
  return { service: new ActionService(port, new FakeProbe()), port };
}

describe('ActionService.moveToQueueFront', () => {
  it('lowers priority below every queued peer', async () => {
    const { service, port } = svc([
      task('late', 'todo', 100),
      task('early', 'todo', 5),
      task('mid', 'retrying', 10),
    ]);
    const next = await service.moveToQueueFront('late');
    expect(next.priority).toBe(4);
    expect(port.tasks.get('late')!.priority).toBe(4);
    expect(port.commits.at(-1)).toMatch(/queue-front/);
  });

  it('is a no-op commit when already front', async () => {
    const { service, port } = svc([
      task('front', 'todo', 0),
      task('other', 'todo', 10),
    ]);
    const n = port.commits.length;
    const next = await service.moveToQueueFront('front');
    expect(next.priority).toBe(0);
    expect(port.commits.length).toBe(n);
  });

  it('rejects non-queue states', async () => {
    const { service } = svc([task('R', 'review', 100)]);
    await expect(service.moveToQueueFront('R')).rejects.toThrow(ActionError);
    await expect(service.moveToQueueFront('R')).rejects.toThrow(/todo\/retrying/);
  });

  it('rejects unknown task', async () => {
    const { service } = svc([]);
    await expect(service.moveToQueueFront('NOPE')).rejects.toThrow(/unknown task/);
  });
});
