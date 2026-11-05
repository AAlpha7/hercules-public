import { TASK_STATES, type TaskState } from './task.js';

export const V2_TASK_STATUSES = TASK_STATES;
export type V2TaskStatus = TaskState;

/** Closed TOTAL mapping legacy TaskState → V2 task_status (identity today; Record type makes totality compiler-checked). */
export const LEGACY_TASK_STATE_TO_V2_STATUS: Readonly<Record<TaskState, V2TaskStatus>> = {
  todo: 'todo',
  in_progress: 'in_progress',
  review: 'review',
  done: 'done',
  cancelled: 'cancelled',
  retrying: 'retrying',
  failed: 'failed',
  deleted: 'deleted',
};

export function toV2TaskStatus(state: TaskState): V2TaskStatus {
  if (!(TASK_STATES as readonly string[]).includes(state)) {
    throw new TypeError(`unknown task state for V2 mapping: ${String(state)}`);
  }
  return LEGACY_TASK_STATE_TO_V2_STATUS[state];
}

export function isV2TaskStatus(value: unknown): value is V2TaskStatus {
  return typeof value === 'string' && (V2_TASK_STATUSES as readonly string[]).includes(value);
}
