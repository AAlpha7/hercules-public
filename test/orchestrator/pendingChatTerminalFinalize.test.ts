/**
 * Regression: pending-chat finalize must not thrash on todo/cancelled
 * (Demo-ready-4, 2026-08-05).
 */
import { describe, it, expect } from 'vitest';
import { Orchestrator, type ControlPort } from '../../src/orchestrator/orchestrator.js';
import { FakeAdapter } from '../../src/orchestrator/fakeAdapter.js';
import { makeConfig } from '../../src/config.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import type { Task, TaskState } from '../../src/domain/task.js';
import type { ReposConfig } from '../../src/domain/repos.js';

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
    private repos: ReposConfig,
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
  async writeRepos(config: ReposConfig): Promise<void> {
    this.repos = config;
  }
}

describe('pending-chat terminal-state finalize', () => {
  it('todo + pending chat does not transition to retrying; queue acked after fold', async () => {
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { maxAttempts: 3, backoffBaseMs: 1 }),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      clock: () => clock.now,
    });

    await orch.tick();
    expect(port.tasks.get('A')!.state).toBe('in_progress');
    orch.queueTaskChat('A', 'operator note after auto-rework', {
      clientMessageId: 'todo-finalize-1',
    });

    await port.writeTask({
      ...port.tasks.get('A')!,
      state: 'todo',
      pendingSteer: null,
      endedAt: null,
      lastEventAt: null,
    });

    clock.now = 100;
    await orch.tick();

    // Same-tick re-dispatch may yield in_progress after durable fold onto todo.
    expect(['todo', 'in_progress']).toContain(port.tasks.get('A')!.state);
    expect(orch.getTaskChatQueue('A')).toEqual([]);
    const after = port.tasks.get('A')!;
    expect(after.state).not.toBe('retrying');
    const folded =
      (after.pendingSteer ?? '').includes('operator note after auto-rework') ||
      after.body.includes('operator note after auto-rework');
    expect(folded).toBe(true);
    expect(after.body).toContain('operator note after auto-rework');

    clock.now = 200;
    await orch.tick();
    expect(orch.getTaskChatQueue('A')).toEqual([]);
    expect(port.tasks.get('A')!.state).not.toBe('retrying');
  });

  it('cancelled + pending chat discards with audit; no illegal transition thrash', async () => {
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', { maxAttempts: 3, backoffBaseMs: 1 }),
      control: port,
      adapter: new FakeAdapter({ durationMs: 10_000, stopGraceMs: 0 }),
      clock: () => clock.now,
    });

    await orch.tick();
    orch.queueTaskChat('A', 'late note before cancel', { clientMessageId: 'cancel-thrash-1' });
    expect(orch.getTaskChatQueue('A')).toHaveLength(1);

    await port.writeTask({ ...port.tasks.get('A')!, state: 'cancelled' });
    await orch.tick();
    clock.now = 1;
    await orch.tick();
    clock.now = 2;
    await orch.tick();

    expect(orch.getTaskChatQueue('A')).toEqual([]);
    const a = port.tasks.get('A')!;
    expect(a.state).toBe('cancelled');
    expect(a.body).toContain('late note before cancel');
    expect(a.body).toMatch(/discarded|cancelled/i);
  });
});
