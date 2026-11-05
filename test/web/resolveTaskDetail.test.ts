import { describe, it, expect } from 'vitest';
import { resolveTaskDetail } from '../../src/web/taskDetail.js';
import type { StateDto, Task } from '../../src/web/api.js';

function task(over: Partial<Task> & { id: string }): Task {
  return {
    id: over.id,
    title: over.title ?? over.id,
    repo: over.repo ?? 'hercules',
    state: over.state ?? 'todo',
    priority: 100,
    blockedBy: [],
    labels: over.labels ?? [],
    adapter: null,
    agentSession: null,
    pendingSteer: null,
    attempts: 0,
    lastEventAt: over.lastEventAt ?? null,
    createdAt: null,
    startedAt: null,
    endedAt: over.endedAt ?? null,
    prUrl: over.prUrl ?? null,
    prStatus: over.prStatus ?? null,
    planPending: over.planPending ?? false,
    body: '',
  };
}

function stateWith(t: Task): StateDto {
  return {
    ready: true,
    running: [],
    stopping: [],
    repos: [],
    problems: [],
    byState: {
      todo: t.state === 'todo' ? [t] : [],
      in_progress: t.state === 'in_progress' ? [t] : [],
      review: t.state === 'review' ? [t] : [],
      done: t.state === 'done' ? [t] : [],
      cancelled: [],
      retrying: [],
      failed: [],
      deleted: [],
    },
    activity: {},
    lastReport: null,
    agents: { default: 'fake', available: ['fake'] },
  };
}

describe('resolveTaskDetail', () => {
  it('does not resurrect planPending after local approve', () => {
    const selected = task({
      id: 'A',
      planPending: false,
      labels: ['ui'],
      lastEventAt: '2026-07-15T01:00:00.000Z',
    });
    const stale = task({
      id: 'A',
      planPending: true,
      labels: ['needs-plan', 'ui'],
      lastEventAt: '2026-07-15T00:00:00.000Z',
    });
    const d = resolveTaskDetail(stateWith(stale), selected);
    expect(d?.planPending).toBe(false);
    expect(d?.labels).toEqual(['ui']);
  });

  it('does not regress done → review when local already done', () => {
    const selected = task({
      id: 'B',
      state: 'done',
      prStatus: 'merged',
      endedAt: '2026-07-15T01:00:00.000Z',
    });
    const stale = task({ id: 'B', state: 'review', prStatus: 'open' });
    const d = resolveTaskDetail(stateWith(stale), selected);
    expect(d?.state).toBe('done');
    expect(d?.prStatus).toBe('merged');
  });

  it('trusts server when lifecycle advanced (dispatch)', () => {
    const selected = task({ id: 'C', state: 'todo', planPending: false });
    const live = task({ id: 'C', state: 'in_progress', planPending: false });
    const d = resolveTaskDetail(stateWith(live), selected);
    expect(d?.state).toBe('in_progress');
  });
});
