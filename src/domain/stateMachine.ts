/**
 * Domain layer — the task state machine (SPEC §5).
 *
 * Pure. The orchestrator validates its own transitions against this table; it
 * never moves a task out of a terminal state. Humans editing task files by hand
 * are outside this guard (the file is authoritative), but the daemon's own
 * writes go through {@link assertTransition}.
 */
import type { TaskState } from './task.js';

const ALLOWED: Readonly<Record<TaskState, readonly TaskState[]>> = {
  // todo→review: pre-dispatch fail-fast (e.g. body names a protected path) —
  // park for human without burning an agent turn; never skips review→done.
  todo: ['in_progress', 'review', 'cancelled', 'deleted'],
  in_progress: ['review', 'retrying', 'failed', 'cancelled'],
  // retrying→review: recovery when a done run is finalized after disk already
  // moved to retrying (e.g. auto-rework wrote retrying then complete retried).
  // Also: pre-dispatch protected-path park on a re-queued task.
  // retrying→todo: explicit human Retry (reset attempts/backoff; not autonomous).
  retrying: ['in_progress', 'failed', 'cancelled', 'review', 'todo'],
  // review→todo and failed→todo are human-driven (reject-for-rework, manual
  // retry). The orchestrator never makes them; only explicit UI actions do.
  // done→todo is human-driven comment-to-steer after Approve&PR (same branch /
  // open PR gets force-pushed on the next successful run).
  // done→review is human Merge failure (verified-SHA mismatch, conflict, or
  // post-merge L1 gate failure) — design §3 e2e release pipeline.
  // *→deleted is soft-delete trash (human Clear / Delete); deleted→todo restore.
  // cancelled→todo: explicit human Retry recovery (preserves branch + audit).
  review: ['done', 'in_progress', 'todo', 'cancelled', 'deleted'],
  done: ['todo', 'review', 'cancelled', 'deleted'],
  cancelled: ['deleted', 'todo'],
  failed: ['todo', 'cancelled', 'deleted'],
  deleted: ['todo'],
};

export class TransitionError extends Error {
  override readonly name = 'TransitionError';
  constructor(
    readonly from: TaskState,
    readonly to: TaskState,
  ) {
    super(`illegal task state transition: ${from} → ${to}`);
  }
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  if (from === to) return true; // idempotent no-op
  return ALLOWED[from].includes(to);
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) {
    throw new TransitionError(from, to);
  }
}
