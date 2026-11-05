import { describe, it, expect } from 'vitest';
import {
  isDueForAutoDelete,
  msUntilAutoDelete,
  taskAutoDeleteAnchorMs,
  DEFAULT_AUTO_DELETE_DAYS,
  type Task,
  type TaskState,
} from '../../src/domain/task.js';

function t(partial: Partial<Task> & { state: TaskState }): Task {
  return {
    id: partial.id ?? 'x',
    title: partial.title ?? 't',
    repo: 'app',
    state: partial.state,
    priority: 100,
    blockedBy: [],
    labels: [],
    adapter: null,
    agentSession: null,
    pendingSteer: null,
    attempts: 0,
    lastEventAt: partial.lastEventAt ?? null,
    createdAt: partial.createdAt ?? null,
    startedAt: null,
    endedAt: partial.endedAt ?? null,
    prUrl: null,
    prStatus: null,
    planPending: false,
    body: '',
  };
}

const DAY = 86_400_000;
const RET = DEFAULT_AUTO_DELETE_DAYS * DAY;

describe('per-task auto-delete retention', () => {
  it('uses endedAt as anchor when present', () => {
    const task = t({
      state: 'done',
      endedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    expect(taskAutoDeleteAnchorMs(task)).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
  });

  it('each deleted task ages alone — only past retention is due', () => {
    const now = Date.parse('2026-02-15T00:00:00.000Z');
    const old = t({
      id: 'old',
      state: 'deleted',
      endedAt: '2026-01-01T00:00:00.000Z', // 45d ago
    });
    const recent = t({
      id: 'new',
      state: 'deleted',
      endedAt: '2026-02-10T00:00:00.000Z', // 5d ago
    });
    expect(isDueForAutoDelete(old, now, RET)).toBe(true);
    expect(isDueForAutoDelete(recent, now, RET)).toBe(false);
    expect(msUntilAutoDelete(recent, now, RET)).toBeGreaterThan(20 * DAY);
  });

  it('does not auto-purge done/cancelled/review — only Deleted trash', () => {
    const now = Date.now();
    const old = '2000-01-01T00:00:00.000Z';
    expect(isDueForAutoDelete(t({ state: 'done', endedAt: old }), now, RET)).toBe(false);
    expect(isDueForAutoDelete(t({ state: 'cancelled', endedAt: old }), now, RET)).toBe(false);
    expect(isDueForAutoDelete(t({ state: 'review', endedAt: old }), now, RET)).toBe(false);
    expect(isDueForAutoDelete(t({ state: 'todo', endedAt: old }), now, RET)).toBe(false);
  });

  it('retention 0 disables', () => {
    const now = Date.now();
    expect(
      isDueForAutoDelete(t({ state: 'deleted', endedAt: '2000-01-01T00:00:00.000Z' }), now, 0),
    ).toBe(false);
  });

  it('missing timestamps never auto-delete', () => {
    expect(isDueForAutoDelete(t({ state: 'deleted' }), Date.now(), RET)).toBe(false);
  });
});
