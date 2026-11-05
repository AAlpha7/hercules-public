import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WORKTREE_GC_DAYS,
  formatWorktreeGcLogLine,
  isDueForWorktreeGc,
  msUntilWorktreeGc,
  selectWorktreeGcTargets,
  taskWorktreeGcAnchorMs,
  WORKTREE_GC_STATES,
} from '../../src/domain/worktreeGc.js';
import type { Task, TaskState } from '../../src/domain/task.js';

function t(partial: Partial<Task> & { state: TaskState }): Task {
  return {
    id: partial.id ?? 'x',
    title: partial.title ?? 't',
    repo: partial.repo ?? 'app',
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
const RET = DEFAULT_WORKTREE_GC_DAYS * DAY;

describe('worktree GC retention boundaries', () => {
  it('uses endedAt as anchor when present', () => {
    const task = t({
      state: 'failed',
      endedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    expect(taskWorktreeGcAnchorMs(task)).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
  });

  it('each terminal task ages alone — only past retention is due', () => {
    const now = Date.parse('2026-02-15T00:00:00.000Z');
    const old = t({
      id: 'old-fail',
      state: 'failed',
      endedAt: '2026-01-01T00:00:00.000Z', // 45d ago
    });
    const recent = t({
      id: 'new-fail',
      state: 'failed',
      endedAt: '2026-02-12T00:00:00.000Z', // 3d ago (< 7d)
    });
    expect(isDueForWorktreeGc(old, now, RET)).toBe(true);
    expect(isDueForWorktreeGc(recent, now, RET)).toBe(false);
    expect(msUntilWorktreeGc(recent, now, RET)).toBeGreaterThan(3 * DAY);
  });

  it('GC applies to done/cancelled/failed/deleted but not active or review', () => {
    const now = Date.now();
    const old = '2000-01-01T00:00:00.000Z';
    for (const state of WORKTREE_GC_STATES) {
      expect(isDueForWorktreeGc(t({ state, endedAt: old }), now, RET)).toBe(true);
    }
    expect(isDueForWorktreeGc(t({ state: 'review', endedAt: old }), now, RET)).toBe(false);
    expect(isDueForWorktreeGc(t({ state: 'todo', endedAt: old }), now, RET)).toBe(false);
    expect(isDueForWorktreeGc(t({ state: 'in_progress', endedAt: old }), now, RET)).toBe(
      false,
    );
    expect(isDueForWorktreeGc(t({ state: 'retrying', endedAt: old }), now, RET)).toBe(false);
  });

  it('exactly at retention boundary is due; one ms before is not', () => {
    const ended = Date.parse('2026-01-01T00:00:00.000Z');
    const task = t({ state: 'done', endedAt: new Date(ended).toISOString() });
    expect(isDueForWorktreeGc(task, ended + RET - 1, RET)).toBe(false);
    expect(isDueForWorktreeGc(task, ended + RET, RET)).toBe(true);
  });

  it('retention 0 disables', () => {
    const now = Date.now();
    expect(
      isDueForWorktreeGc(t({ state: 'failed', endedAt: '2000-01-01T00:00:00.000Z' }), now, 0),
    ).toBe(false);
  });

  it('missing timestamps never GC', () => {
    expect(isDueForWorktreeGc(t({ state: 'failed' }), Date.now(), RET)).toBe(false);
  });

  it('future anchor is never due', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    expect(
      isDueForWorktreeGc(
        t({ state: 'done', endedAt: '2026-06-01T00:00:00.000Z' }),
        now,
        RET,
      ),
    ).toBe(false);
  });

  it('selectWorktreeGcTargets returns repo+id for due tasks only', () => {
    const now = Date.parse('2026-02-15T00:00:00.000Z');
    const tasks = [
      t({
        id: 'old',
        repo: 'orbit',
        state: 'failed',
        endedAt: '2026-01-01T00:00:00.000Z',
      }),
      t({
        id: 'fresh',
        repo: 'orbit',
        state: 'failed',
        endedAt: '2026-02-14T00:00:00.000Z',
      }),
      t({
        id: 'running',
        repo: 'orbit',
        state: 'in_progress',
        endedAt: '2026-01-01T00:00:00.000Z',
      }),
    ];
    expect(selectWorktreeGcTargets(tasks, now, RET)).toEqual([
      { taskId: 'old', repoKey: 'orbit' },
    ]);
  });

  it('formatWorktreeGcLogLine is a single dry-run-safe digest', () => {
    const line = formatWorktreeGcLogLine({
      dryRun: true,
      retentionDays: 7,
      candidates: 2,
      worktrees: ['old-a'],
      screenshots: [],
      skippedLive: ['live-1'],
    });
    expect(line).toContain('worktree-gc dry-run');
    expect(line).toContain('retention=7d');
    expect(line).toContain('worktrees=[old-a]');
    expect(line).toContain('skippedLive=[live-1]');
  });
});
