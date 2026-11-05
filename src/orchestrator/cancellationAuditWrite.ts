/** Persist privacy-safe cancellation audit receipts (orchestrator helper). */
import type { Task } from '../domain/task.js';
import {
  bodyHasCancellationAudit,
  type CancellationLifecyclePhase,
} from '../domain/cancellationAudit.js';
import { parseCancellationAuditReceipts } from '../domain/cancellationAuditIo.js';
import { stampCancellationFields } from '../domain/cancellationStamp.js';
import type { ControlPort } from './orchestrator.js';
import { mutateControl } from './controlMutation.js';

export async function writeCancellationAuditIfNeeded(input: {
  readonly control: ControlPort;
  readonly taskId: string;
  readonly task: Task;
  readonly source: 'external_state' | 'daemon_safety';
  readonly kind: 'cancel' | 'force_abort';
  readonly hadActiveSession: boolean;
  readonly lifecyclePhase: CancellationLifecyclePhase;
  readonly byId?: Map<string, Task>;
}): Promise<Task> {
  const task = input.task;
  const kind = input.kind;
  const source = input.source;
  if (kind === 'cancel' && bodyHasCancellationAudit(task.body)) return task;
  const existing = parseCancellationAuditReceipts(task.body);
  if (kind === 'force_abort' && existing.some((r) => r.kind === 'force_abort')) return task;
  let message =
    'Task entered cancelled state without an operator cancel receipt.';
  if (source === 'daemon_safety') {
    message = 'Grace period expired; daemon forced SIGKILL.';
  }
  const stamped = stampCancellationFields(task, kind, {
    source,
    hadActiveSession: input.hadActiveSession,
    lifecyclePhase: input.lifecyclePhase,
    message,
  });
  const next: Task = {
    ...task,
    body: stamped.body,
    endedAt: stamped.endedAt ?? task.endedAt,
  };
  await mutateControl(
    input.control,
    { writeTasks: [{ expected: task, next }] },
    'hercules: ' + input.taskId + ' ' + kind + ' audit (' + source + ')',
  );
  input.byId?.set(input.taskId, next);
  return next;
}
