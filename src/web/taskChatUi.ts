/**
 * Phone Remote Control chat outcome labels (per-task, not global).
 * Kept out of App.tsx so the shell stays under the appSplit line budget.
 */

export type TaskChatMode = 'queued' | 'pending' | 'steer' | 'duplicate';

export type TaskChatApiResult = {
  readonly mode: TaskChatMode;
  readonly reason?: string;
  readonly task?: unknown;
};

/** UI side-effects derived from a chat API response (App applies them). */
export type TaskChatUiEffect = {
  readonly label: string;
  readonly applyTask: boolean;
  readonly closeOnSteer: boolean;
};

export function taskChatOutcomeLabel(
  mode: TaskChatMode,
  reason?: string | null,
): string {
  switch (mode) {
    case 'queued':
      return 'Queued — will send when this turn ends';
    case 'pending':
      return 'Pending — will include on next dispatch';
    case 'steer':
      return 'Steered — task re-queued for the agent';
    case 'duplicate':
      return reason
        ? `Already delivered — ${reason}`
        : 'Already delivered — same submission not re-queued';
  }
}

/** Map API chat result → phone banner + sheet behavior. */
export function taskChatUiEffect(res: TaskChatApiResult): TaskChatUiEffect {
  return {
    label: taskChatOutcomeLabel(
      res.mode,
      res.mode === 'duplicate' ? (res.reason ?? null) : null,
    ),
    applyTask: res.mode !== 'queued',
    closeOnSteer: res.mode === 'steer',
  };
}

/** Merge a per-task outcome into the map (immutable). */
export function withTaskChatOutcome(
  map: Readonly<Record<string, string>>,
  taskId: string,
  label: string,
): Record<string, string> {
  return { ...map, [taskId]: label };
}

/** Drop one task's outcome when its sheet closes. */
export function withoutTaskChatOutcome(
  map: Readonly<Record<string, string>>,
  taskId: string,
): Record<string, string> {
  if (!(taskId in map)) return { ...map };
  const next = { ...map };
  delete next[taskId];
  return next;
}
