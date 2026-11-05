import { describe, it, expect } from 'vitest';
import { ActionService } from '../../src/orchestrator/actions.js';
import type { ControlPort } from '../../src/orchestrator/orchestrator.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import type { Task, TaskState } from '../../src/domain/task.js';
import type { ReposConfig } from '../../src/domain/repos.js';
import type { RepoProbe } from '../../src/orchestrator/repoProbe.js';

function task(id: string, state: TaskState = 'todo'): Task {
  return {
    id,
    title: id,
    repo: 'app',
    state,
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
  };
}

class FakePort implements ControlPort {
  readonly commits: string[] = [];
  repos: ReposConfig = {
    repos: {
      app: {
        key: 'app',
        url: 'https://github.com/example-org/acme.git',
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

describe('ActionService.chat idempotency', () => {
  it('same clientMessageId while todo is duplicate with priorMode=pending (not delivered)', async () => {
    const port = new FakePort(new Map([['A', task('A', 'todo')]]));
    const svc = new ActionService(port, new FakeProbe());

    const first = await svc.chat('A', 'please rework the flaky gate', {
      clientMessageId: 'msg-1',
    });
    expect(first.mode).toBe('pending');
    expect(first.task.pendingSteer).toBe('please rework the flaky gate');
    expect(first.task.body).toContain('<!-- client-message-id: msg-1 -->');
    expect(first.task.body.match(/## Human steer/g)).toHaveLength(1);

    const second = await svc.chat('A', 'please rework the flaky gate', {
      clientMessageId: 'msg-1',
    });
    expect(second.mode).toBe('duplicate');
    expect(second.priorMode).toBe('pending');
    expect(second.reason).toMatch(/pending for next dispatch/i);
    expect(second.task.body.match(/## Human steer/g)).toHaveLength(1);
    expect(port.commits.filter((c) => c.includes('chat pending'))).toHaveLength(1);
  });

  it('same clientMessageId while retrying is priorMode=pending', async () => {
    const port = new FakePort(new Map([['A', task('A', 'retrying')]]));
    const svc = new ActionService(port, new FakeProbe());
    await svc.chat('A', 'retry note', { clientMessageId: 'r1' });
    const dup = await svc.chat('A', 'retry note', { clientMessageId: 'r1' });
    expect(dup.mode).toBe('duplicate');
    expect(dup.priorMode).toBe('pending');
  });

  it('new clientMessageId with identical text is accepted', async () => {
    const port = new FakePort(new Map([['A', task('A', 'todo')]]));
    const svc = new ActionService(port, new FakeProbe());

    await svc.chat('A', 'same words', { clientMessageId: 'old' });
    const again = await svc.chat('A', 'same words', { clientMessageId: 'new' });
    expect(again.mode).toBe('pending');
    expect(again.task.body.match(/## Human steer/g)).toHaveLength(2);
  });

  it('legacy identical text while still pending is duplicate', async () => {
    const port = new FakePort(new Map([['A', task('A', 'todo')]]));
    const svc = new ActionService(port, new FakeProbe());

    await svc.chat('A', 'hold this');
    const dup = await svc.chat('A', 'hold this');
    expect(dup.mode).toBe('duplicate');
    expect(dup.task.body.match(/## Human steer/g)).toHaveLength(1);
  });

  it('steer from review embeds clientMessageId in audit section', async () => {
    const port = new FakePort(
      new Map([['A', { ...task('A', 'review'), agentSession: 'sess' }]]),
    );
    const svc = new ActionService(port, new FakeProbe());
    const res = await svc.chat('A', 'What did you change?', {
      clientMessageId: 'steer-1',
    });
    expect(res.mode).toBe('steer');
    expect(res.task.state).toBe('todo');
    expect(res.task.body).toContain('<!-- client-message-id: steer-1 -->');
  });
});
