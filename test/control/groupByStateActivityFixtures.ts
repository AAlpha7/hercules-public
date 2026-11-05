import type { Task } from '../../src/domain/task.js';

function t(
  id: string,
  priority: number,
  lastEventAt: string | null,
  endedAt: string | null,
  createdAt: string | null,
): Task {
  return {
    id,
    title: id,
    repo: 'my-app',
    state: 'done',
    priority,
    blockedBy: [],
    labels: [],
    adapter: null,
    agentSession: null,
    pendingSteer: null,
    attempts: 0,
    lastEventAt,
    createdAt,
    startedAt: null,
    endedAt,
    prUrl: null,
    prStatus: null,
    planPending: false,
    verifiedSha: null,
    body: '',
  };
}

/** Unsorted done-bucket tasks for last-activity descending coverage. */
export function activitySortFixtureTasks(): Task[] {
  return [
    t('old-high-pri', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'),
    t('newer', 50, '2026-06-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '2025-06-01T00:00:00.000Z'),
    t('ended-only', 2, null, '2026-03-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'),
    t('created-only', 3, null, null, '2026-02-01T00:00:00.000Z'),
    t('no-ts-b', 0, null, null, null),
    t('no-ts-a', 0, null, null, null),
    t('tie-a', 9, '2026-04-01T00:00:00.000Z', null, null),
    t('tie-b', 1, '2026-04-01T00:00:00.000Z', null, null),
  ];
}

export const ACTIVITY_SORT_EXPECTED_IDS = [
  'newer',
  'tie-a',
  'tie-b',
  'ended-only',
  'created-only',
  'old-high-pri',
  'no-ts-a',
  'no-ts-b',
] as const;
