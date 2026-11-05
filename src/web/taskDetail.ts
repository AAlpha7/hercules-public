/**
 * Merge live snapshot task with locally selected task for the detail sheet.
 * Pure — keeps phone UI from flashing pre-mutation fields when SSE/refresh lag.
 */
import type { StateDto, Task } from './api.js';

export function findTask(state: StateDto | null, id: string): Task | null {
  if (!state) return null;
  for (const list of Object.values(state.byState)) {
    const found = list.find((t) => t.id === id);
    if (found) return found;
  }
  return null;
}

/** Rough lifecycle rank — higher means further through the loop. */
export function taskLifecycleRank(state: Task['state']): number {
  switch (state) {
    case 'todo':
      return 1;
    case 'in_progress':
    case 'retrying':
      return 2;
    case 'review':
      return 3;
    case 'done':
      return 4;
    case 'failed':
    case 'cancelled':
    case 'deleted':
      return 5;
    default:
      return 0;
  }
}

/**
 * Sheet detail prefers the live snapshot, but never regresses fields the user
 * just mutated when SSE/refresh lags (plan approve, PR merged, etc.).
 */
export function resolveTaskDetail(
  state: StateDto | null,
  selected: Task | null,
): Task | null {
  if (!selected) return null;
  const fromState = findTask(state, selected.id);
  if (!fromState) return selected;

  // Daemon advanced the task (dispatch, complete) — trust server state.
  if (taskLifecycleRank(fromState.state) > taskLifecycleRank(selected.state)) {
    if (!selected.planPending && fromState.planPending) {
      return { ...fromState, planPending: false, labels: selected.labels };
    }
    return fromState;
  }

  let merged: Task = fromState;
  // Anti-regression overlays while server snapshot catches up.
  if (!selected.planPending && merged.planPending) {
    merged = {
      ...merged,
      planPending: false,
      labels: selected.labels,
      lastEventAt: selected.lastEventAt ?? merged.lastEventAt,
    };
  }
  if (selected.prStatus === 'merged' && merged.prStatus === 'open') {
    merged = { ...merged, prStatus: 'merged' };
  }
  if (selected.state === 'done' && merged.state === 'review') {
    merged = {
      ...merged,
      state: 'done',
      prStatus: selected.prStatus ?? merged.prStatus,
      endedAt: selected.endedAt ?? merged.endedAt,
    };
  }
  return merged;
}
