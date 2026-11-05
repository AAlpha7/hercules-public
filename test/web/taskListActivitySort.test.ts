import { describe, it, expect } from 'vitest';
import type { StateDto, Task, TaskState } from '../../src/web/api.js';
import { collectAwaitingMergeTasks } from '../../src/web/taskUi.js';

function emptyByState(): Record<TaskState, Task[]> {
  return {
    todo: [],
    in_progress: [],
    review: [],
    done: [],
    cancelled: [],
    retrying: [],
    failed: [],
    deleted: [],
  };
}

function makeTask(over: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    title: over.id,
    repo: 'app',
    state: 'done',
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
    prUrl: 'https://github.com/org/app/pull/1',
    prStatus: 'open',
    planPending: false,
    body: '',
    ...over,
  };
}

function stateWith(tasks: Task[]): StateDto {
  const byState = emptyByState();
  for (const t of tasks) byState[t.state].push(t);
  return {
    ready: true,
    running: [],
    stopping: [],
    repos: [],
    problems: [],
    byState,
    activity: {},
    lastReport: null,
    agents: { default: 'grok', available: ['grok'] },
  };
}

describe('collectAwaitingMergeTasks activity sort', () => {
  it('collectAwaitingMergeTasks orders by last activity descending', () => {
    const tasks = [
      makeTask({ id: 'z-old', lastEventAt: '2026-01-01T00:00:00.000Z', priority: 1 }),
      makeTask({ id: 'a-new', lastEventAt: '2026-06-01T00:00:00.000Z', priority: 90 }),
      makeTask({
        id: 'ended-mid',
        lastEventAt: null,
        endedAt: '2026-03-01T00:00:00.000Z',
        createdAt: '2025-01-01T00:00:00.000Z',
      }),
      makeTask({
        id: 'created-low',
        lastEventAt: null,
        endedAt: null,
        createdAt: '2026-02-01T00:00:00.000Z',
      }),
      makeTask({ id: 'no-ts', lastEventAt: null, endedAt: null, createdAt: null, priority: 0 }),
    ];
    const ids = collectAwaitingMergeTasks(stateWith(tasks)).map((x) => x.id);
    expect(ids).toEqual(['a-new', 'ended-mid', 'created-low', 'z-old', 'no-ts']);
  });
});
