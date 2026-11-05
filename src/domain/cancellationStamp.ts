/** Build next task fields for a cancel / force-abort audit stamp. Pure. */
import type { Task } from './task.js';
import { buildCancellationAuditReceipt, deriveCancellationLifecyclePhase } from './cancellationAudit.js';
import { appendCancellationAuditReceipt, humanCancelMessage } from './cancellationAuditIo.js';
import type { CancellationRequestOpts } from './cancellationRequest.js';

export function stampCancellationFields(
  task: Task,
  kind: 'cancel' | 'force_abort',
  opts: CancellationRequestOpts = {},
): { readonly body: string; readonly endedAt: string | null; readonly source: string } {
  const at = opts.at && opts.at.length > 0 ? opts.at : new Date().toISOString();
  const hadActiveSession = opts.hadActiveSession === true ||
    (opts.hadActiveSession !== false && Boolean(task.agentSession));
  const lifecyclePhase = opts.lifecyclePhase ??
    deriveCancellationLifecyclePhase({ state: task.state, agentSession: task.agentSession });
  const source = opts.source ?? 'human_api';
  const receipt = buildCancellationAuditReceipt({
    kind,
    source,
    at,
    lifecyclePhase,
    hadActiveSession,
    message: opts.message ?? humanCancelMessage(kind),
    actorId: opts.actorId ?? null,
    correlationId: opts.correlationId ?? null,
    gitCommitAuthor: opts.gitCommitAuthor ?? null,
    ...(opts.actorCategory !== undefined ? { actorCategory: opts.actorCategory } : {}),
    ...(opts.reasonCode !== undefined ? { reasonCode: opts.reasonCode } : {}),
    ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
  });
  return {
    body: appendCancellationAuditReceipt(task.body, receipt),
    endedAt: (task.state === 'in_progress' || kind === 'cancel') ? at : task.endedAt,
    source,
  };
}
