/**
 * L2 fixture only: pick the review task that carries a soft UI-AC gap so the
 * first shell screenshot can land on DecisionCard chrome. Never matches real
 * work (id / label / title must be fixture-tagged).
 */
import { unprovenUiFromTaskBody } from '../domain/decisionCard.js';
import type { Task } from './api.js';

export function findFixtureUnprovenReviewTask(
  tasks: readonly Task[],
): Task | null {
  for (const t of tasks) {
    if (t.state !== 'review') continue;
    const isFixture =
      t.id.startsWith('l2-fixture-') ||
      (t.labels ?? []).includes('l2-fixture') ||
      t.title.includes('[L2 fixture]');
    if (!isFixture) continue;
    if (unprovenUiFromTaskBody(t.body) !== null) return t;
  }
  return null;
}
