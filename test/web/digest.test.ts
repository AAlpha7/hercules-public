/**
 * CEO outcome digest: shipped / first-pass rate / promotes / today's cost —
 * derived purely from state the client already has (tasks, release history,
 * costSummary). Honest: only counts what is recorded, no invention.
 */
import { describe, it, expect } from 'vitest';
import { buildDigest, formatDigestLine } from '../../src/web/digest.js';
import type { Task } from '../../src/web/api.js';

const NOW = Date.parse('2026-07-23T12:00:00Z');
const d = (daysAgo: number): string => new Date(NOW - daysAgo * 86400_000).toISOString();

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id, title: id, repo: 'app', state: 'done', priority: 1, blockedBy: [],
    labels: [], adapter: null, agentSession: null, pendingSteer: null,
    attempts: 0, lastEventAt: null, createdAt: null, startedAt: null,
    endedAt: d(1), prUrl: null, prStatus: null, planPending: false, body: '',
    ...over,
  } as Task;
}

describe('buildDigest', () => {
  it('counts shipped, first-pass rate, promotes and rollbacks inside the window', () => {
    const tasks = [
      task('a'),                                  // done, attempts 0 → first pass
      task('b', { attempts: 3 }),                 // done after retries
      task('old', { endedAt: d(20) }),            // outside window
      task('f', { state: 'failed', endedAt: d(2) }),
    ];
    const releases = [
      { history: [
        { sha: 'x', at: d(2), outcome: 'ok' },
        { sha: 'y', at: d(30), outcome: 'ok' },       // outside window
        { sha: 'z', at: d(1), outcome: 'rolled_back' },
      ] },
    ];
    const g = buildDigest(tasks, releases, { day: { costUsd: 1.25 } }, NOW, 7);
    expect(g.shipped).toBe(2);
    expect(g.firstPass).toBe(1);
    expect(g.failed).toBe(1);
    expect(g.promotes).toBe(1);
    expect(g.rollbacks).toBe(1);
    expect(g.costTodayUsd).toBe(1.25);
  });

  it('formats a compact zh line', () => {
    const line = formatDigestLine({
      shipped: 5, firstPass: 4, failed: 1, promotes: 2, rollbacks: 0,
      costTodayUsd: 0.8, windowDays: 7,
    });
    expect(line).toMatch(/7 天/);
    expect(line).toMatch(/上线 5/);
    expect(line).toMatch(/一次通过 4\/5/);
    expect(line).toMatch(/发布 2/);
    expect(line).toMatch(/\$0\.80/);
  });

  it('empty history / missing cost degrade gracefully', () => {
    const g = buildDigest([], [], undefined, NOW, 7);
    expect(g.shipped).toBe(0);
    expect(g.costTodayUsd).toBeNull();
    expect(formatDigestLine(g)).not.toMatch(/\$/);
  });
});
