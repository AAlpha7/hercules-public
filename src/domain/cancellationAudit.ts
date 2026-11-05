/** Domain: privacy-safe cancellation / force-abort audit receipts. Pure. */
/** Completed module — cancellation audit receipts. */
import type { TaskState } from './task.js';
import { redactHostOutput } from './hostExecutor.js';

export const CANCELLATION_AUDIT_VERSION = 1 as const;
export const CANCELLATION_AUDIT_HEADING = '## Cancellation audit';
export const CANCELLATION_MESSAGE_MAX = 240;
export const CANCELLATION_ACTOR_ID_MAX = 64;
export const CANCELLATION_ORIGIN_MAX = 64;
export const CANCELLATION_CORRELATION_ID_MAX = 128;
export const CANCELLATION_REASON_CODE_MAX = 64;

export const CANCELLATION_SOURCES = [
  'human_ui', 'human_api', 'agent', 'daemon_safety', 'external_state', 'unknown',
] as const;
export type CancellationSource = (typeof CANCELLATION_SOURCES)[number];

export const CANCELLATION_KINDS = ['cancel', 'force_abort'] as const;
export type CancellationKind = (typeof CANCELLATION_KINDS)[number];

export const CANCELLATION_LIFECYCLE_PHASES = [
  'pre_session', 'agent_running', 'verifying', 'stopping', 'terminal', 'unknown',
] as const;
export type CancellationLifecyclePhase = (typeof CANCELLATION_LIFECYCLE_PHASES)[number];

export const CANCELLATION_ACTOR_CATEGORIES = [
  'operator', 'agent', 'daemon', 'integration', 'unavailable',
] as const;
export type CancellationActorCategory = (typeof CANCELLATION_ACTOR_CATEGORIES)[number];

export const CANCELLATION_REASON_CODES = [
  'human_cancel', 'human_force_abort', 'daemon_grace_timeout', 'daemon_safety',
  'agent_request', 'external_state_change', 'attribution_unavailable',
] as const;
export type CancellationReasonCode = (typeof CANCELLATION_REASON_CODES)[number];

export interface CancellationActor {
  readonly category: CancellationActorCategory;
  readonly id: string | null;
}

export interface CancellationAuditReceipt {
  readonly version: typeof CANCELLATION_AUDIT_VERSION;
  readonly kind: CancellationKind;
  readonly source: CancellationSource;
  readonly reasonCode: CancellationReasonCode;
  readonly message: string;
  readonly at: string;
  readonly lifecyclePhase: CancellationLifecyclePhase;
  readonly hadActiveSession: boolean;
  readonly actor: CancellationActor;
  readonly origin: string;
  readonly correlationId: string | null;
}
export type CancellationAuditDto = CancellationAuditReceipt;

export class CancellationAuditError extends Error {
  override readonly name = 'CancellationAuditError';
}

const SOURCE_SET: ReadonlySet<string> = new Set(CANCELLATION_SOURCES);
const KIND_SET: ReadonlySet<string> = new Set(CANCELLATION_KINDS);
const PHASE_SET: ReadonlySet<string> = new Set(CANCELLATION_LIFECYCLE_PHASES);
const ACTOR_SET: ReadonlySet<string> = new Set(CANCELLATION_ACTOR_CATEGORIES);
const REASON_SET: ReadonlySet<string> = new Set(CANCELLATION_REASON_CODES);
const SAFE_ID_RE = /^[A-Za-z0-9._:*-]{1,64}$/;
const SAFE_ORIGIN_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const SAFE_CORR_RE = /^[A-Za-z0-9._:*-]{1,128}$/;
const REASON_RE = /^[a-z][a-z0-9_]{0,62}$/;
const FORBIDDEN_IDS = new Set([
  'hercules', 'ubuntu', 'root', 'git', 'noreply', 'unknown', 'n/a', 'na', 'none', 'system',
]);

function isSource(v: string): v is CancellationSource { return SOURCE_SET.has(v); }
function isKind(v: string): v is CancellationKind { return KIND_SET.has(v); }
function isPhase(v: string): v is CancellationLifecyclePhase { return PHASE_SET.has(v); }
function isActorCat(v: string): v is CancellationActorCategory { return ACTOR_SET.has(v); }
function isReason(v: string): v is CancellationReasonCode { return REASON_SET.has(v); }

export function isCancellationTimestamp(value: string): boolean {
  const t = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(t)) return false;
  return Number.isFinite(Date.parse(t));
}

export function normalizeCancellationActorId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  if (id.length === 0 || id.length > CANCELLATION_ACTOR_ID_MAX) return null;
  if (!SAFE_ID_RE.test(id)) return null;
  if (id.includes('/') || id.includes('\\') || id.includes('..')) return null;
  if (FORBIDDEN_IDS.has(id.toLowerCase())) return null;
  if (id.includes('@') || /token|secret|password|bearer/i.test(id)) return null;
  return id;
}

export function normalizeCancellationOrigin(raw: unknown): string {
  if (typeof raw !== 'string') return 'unknown';
  const o = raw.trim().toLowerCase().slice(0, CANCELLATION_ORIGIN_MAX);
  return o.length > 0 && SAFE_ORIGIN_RE.test(o) ? o : 'unknown';
}

export function normalizeCancellationCorrelationId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  if (id.length === 0 || id.length > CANCELLATION_CORRELATION_ID_MAX) return null;
  return SAFE_CORR_RE.test(id) ? id : null;
}

export function normalizeCancellationReasonCode(raw: unknown): CancellationReasonCode {
  if (typeof raw !== 'string') return 'attribution_unavailable';
  const code = raw.trim().toLowerCase().replace(/-/g, '_').slice(0, CANCELLATION_REASON_CODE_MAX);
  return REASON_RE.test(code) && isReason(code) ? code : 'attribution_unavailable';
}

export function redactCancellationMessage(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let text = redactHostOutput(raw, CANCELLATION_MESSAGE_MAX);
  text = text.replace(/(?:^|[\s"'])(\/[\w./-]+)/g, (m, p1: string) => m.replace(p1, '[path]'));
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > CANCELLATION_MESSAGE_MAX) text = text.slice(0, CANCELLATION_MESSAGE_MAX - 1) + '...';
  return text;
}

export interface BuildCancellationAuditInput {
  readonly kind: CancellationKind;
  readonly source?: CancellationSource | string | null;
  readonly reasonCode?: string | null;
  readonly message?: string | null;
  readonly at: string;
  readonly lifecyclePhase?: CancellationLifecyclePhase | string | null;
  readonly hadActiveSession: boolean;
  readonly actorCategory?: CancellationActorCategory | string | null;
  readonly actorId?: string | null;
  readonly gitCommitAuthor?: string | null;
  readonly origin?: string | null;
  readonly correlationId?: string | null;
}

export function defaultActorCategoryForSource(s: CancellationSource): CancellationActorCategory {
  if (s === 'human_ui' || s === 'human_api') return 'operator';
  if (s === 'agent') return 'agent';
  if (s === 'daemon_safety') return 'daemon';
  return 'unavailable';
}

export function defaultReasonCodeFor(k: CancellationKind, s: CancellationSource): CancellationReasonCode {
  if (k === 'force_abort' && (s === 'human_ui' || s === 'human_api')) return 'human_force_abort';
  if (k === 'cancel' && (s === 'human_ui' || s === 'human_api')) return 'human_cancel';
  if (s === 'daemon_safety') return k === 'force_abort' ? 'daemon_grace_timeout' : 'daemon_safety';
  if (s === 'agent') return 'agent_request';
  if (s === 'external_state') return 'external_state_change';
  return 'attribution_unavailable';
}

export function defaultOriginForSource(s: CancellationSource): string {
  if (s === 'human_ui') return 'ui';
  if (s === 'human_api') return 'api';
  if (s === 'agent') return 'agent';
  if (s === 'daemon_safety') return 'daemon';
  if (s === 'external_state') return 'external';
  return 'unknown'; // default origin
}

export function buildCancellationAuditReceipt(input: BuildCancellationAuditInput): CancellationAuditReceipt {
  if (!isKind(input.kind)) throw new CancellationAuditError('invalid cancellation kind');
  if (!isCancellationTimestamp(input.at)) {
    throw new CancellationAuditError('cancellation audit requires an ISO timestamp');
  }
  const sourceRaw = typeof input.source === 'string' ? input.source.trim() : '';
  const source: CancellationSource = isSource(sourceRaw) ? sourceRaw : 'unknown';
  const phaseRaw = typeof input.lifecyclePhase === 'string' ? input.lifecyclePhase.trim() : '';
  const lifecyclePhase: CancellationLifecyclePhase = isPhase(phaseRaw) ? phaseRaw : 'unknown';
  const catRaw = typeof input.actorCategory === 'string' ? input.actorCategory.trim() : '';
  const actorCategory: CancellationActorCategory = isActorCat(catRaw)
    ? catRaw : defaultActorCategoryForSource(source);
  const gitAuthor = typeof input.gitCommitAuthor === 'string' ? input.gitCommitAuthor.trim() : '';
  let actorId = normalizeCancellationActorId(input.actorId ?? null);
  if (gitAuthor.length > 0) {
    if (actorId && actorId.toLowerCase() === gitAuthor.toLowerCase()) actorId = null;
    if (input.actorId == null) actorId = null;
  }
  const reasonCode = input.reasonCode
    ? normalizeCancellationReasonCode(input.reasonCode)
    : defaultReasonCodeFor(input.kind, source);
  const message = redactCancellationMessage(input.message ?? '') ||
    ((input.kind === 'force_abort' ? 'Force-abort' : 'Cancellation') +
      ' requested (' + source + ' / ' + reasonCode + ').');
  const origin = input.origin
    ? normalizeCancellationOrigin(input.origin)
    : defaultOriginForSource(source);
  const correlationId = normalizeCancellationCorrelationId(input.correlationId ?? null);
  return {
    version: CANCELLATION_AUDIT_VERSION,
    kind: input.kind,
    source,
    reasonCode,
    message,
    at: input.at.trim(),
    lifecyclePhase,
    hadActiveSession: input.hadActiveSession === true,
    actor: { category: actorCategory, id: actorId },
    origin,
    correlationId,
  };
}

export function deriveCancellationLifecyclePhase(input: {
  readonly state: TaskState;
  readonly agentSession?: string | null;
  readonly runtimePhase?: CancellationLifecyclePhase | null;
}): CancellationLifecyclePhase {
  if (input.runtimePhase && isPhase(input.runtimePhase)) return input.runtimePhase;
  const s = input.state;
  if (s === 'cancelled' || s === 'deleted' || s === 'done' || s === 'failed') return 'terminal';
  if (s === 'in_progress') return 'agent_running';
  if (s === 'todo' || s === 'retrying') return input.agentSession ? 'agent_running' : 'pre_session';
  if (s === 'review') return 'pre_session';
  return 'unknown';
}

export function bodyHasCancellationAudit(body: string): boolean {
  return body.includes(CANCELLATION_AUDIT_HEADING);
}

