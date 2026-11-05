/** Shared client action: push a task to the front of the dispatch queue. */
import type { Dispatch, SetStateAction } from 'react';
import { moveTaskToQueueFront, type StateDto, type Task } from './api.js';
import { moveTask } from './taskUi.js';

export function makeQueueFrontHandler(opts: {
  busy: boolean;
  detail: Task | null | undefined;
  setPending: Dispatch<SetStateAction<string | null>>;
  setState: Dispatch<SetStateAction<StateDto | null>>;
  setSelected: Dispatch<SetStateAction<Task | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  refresh: () => void;
}): () => void {
  return () => {
    if (opts.busy || !opts.detail) return;
    const taskId = opts.detail.id;
    opts.setPending('queueFront');
    void moveTaskToQueueFront(taskId)
      .then((updated) => {
        opts.setState((s) => (s ? moveTask(s, updated) : s));
        opts.setSelected(updated);
        opts.refresh();
      })
      .catch((e: unknown) => {
        opts.setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        opts.setPending(null);
      });
  };
}
