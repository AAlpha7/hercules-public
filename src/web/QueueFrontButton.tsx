/**
 * Primary action: push a todo/retrying task to the front of the dispatch queue.
 */
import type { JSX } from 'react';
import type { Task } from './api.js';

export function QueueFrontButton({
  task,
  busy,
  pending,
  onQueueFront,
}: {
  task: Task;
  busy: boolean;
  pending: string | null;
  onQueueFront?: () => void;
}): JSX.Element | null {
  if ((task.state !== 'todo' && task.state !== 'retrying') || !onQueueFront) {
    return null;
  }
  return (
    <button
      type="button"
      className="primary"
      disabled={busy}
      onClick={onQueueFront}
      data-evidence="queue-front"
      title="Dispatch this task next"
    >
      {pending === 'queueFront' ? <span className="spinner" /> : 'To front'}
    </button>
  );
}
