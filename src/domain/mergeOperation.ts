/**
 * Domain — Merge Selected as a first-class long-running operation.
 *
 * Coordinator lives in orchestrator/mergeOperationService.ts.
 * Pure types + helpers only (no IO). Receipts are authoritative server state;
 * the phone UI may poll but never invents success. Success is exposed only
 * when status is succeeded AND mergedSha is present (push + provenance stamps).
 */

/** Public lifecycle the phone/API distinguish. */
export const MERGE_OPERATION_STATUSES = [
  'accepted',
  'running',
  'succeeded',
  'failed',
  'interrupted',
] as const;

export type MergeOperationStatus = (typeof MERGE_OPERATION_STATUSES)[number];

/** Ordered progress phases inside a running operation. */
export const MERGE_OPERATION_PHASES = [
  'accepted',
  'precheck',
  'merging',
  'gating',
  'pushing',
  'pushed',
  'stamping',
  'stamped',
  'succeeded',
  'failed',
  'interrupted',
] as const;

export type MergeOperationPhase = (typeof MERGE_OPERATION_PHASES)[number];

/** Bounded failure taxonomy for operator-facing receipts. */
export const MERGE_OPERATION_FAILURE_KINDS = [
  'precheck',
  'conflict',
  'gate_failure',
  'push_failure',
  'stamp_failure',
  'single_flight',
  'interrupted',
  'unknown',
] as const;

export type MergeOperationFailureKind =
  (typeof MERGE_OPERATION_FAILURE_KINDS)[number];

export const MERGE_OPERATION_RECORD_VERSION = 1 as const;

/** Max length for a client-supplied merge idempotency key. */
export const MAX_MERGE_IDEMPOTENCY_KEY_LEN = 128;

const MERGE_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:*-]{1,128}$/;

export interface MergeOperationFailure {
  readonly taskId: string;
  /** Operator-facing, redacted reason (no paths / secrets / long output). */
  readonly reason: string;
  readonly kind: MergeOperationFailureKind;
}

export interface MergeGateProgress {
  readonly completed: number;
  readonly total: number;
  /** Gate name only — never the command string. */
  readonly currentGate: string | null;
}

/** Progress callback payload from MergeService phases. */
export interface MergeProgressEvent {
  readonly phase: MergeOperationPhase;
  readonly gateProgress?: MergeGateProgress | null;
}

/** Durable record persisted under the work root. */
export interface MergeOperationRecord {
  readonly version: typeof MERGE_OPERATION_RECORD_VERSION;
  readonly operationId: string;
  readonly repoKey: string;
  /** Exact ordered task selection accepted at start. */
  readonly taskIds: readonly string[];
  readonly idempotencyKey: string | null;
  readonly status: MergeOperationStatus;
  readonly phase: MergeOperationPhase;
  readonly mergedSha: string | null;
  readonly failures: readonly MergeOperationFailure[];
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly gateProgress: MergeGateProgress | null;
  readonly failureKind: MergeOperationFailureKind | null;
  /** C3.57: verified sha whose L1 the merge inherited (gates not re-run); absent/null when gates ran. */
  readonly gatesInheritedFromSha?: string | null;
  /** Process that accepted/ran the op (restart reconciliation). */
  readonly ownerPid: number;
}

/** Authenticated API / phone DTO (ISO timestamps, no owner pid). */
export interface MergeOperationReceipt {
  readonly operationId: string;
  readonly repoKey: string;
  readonly taskIds: readonly string[];
  readonly idempotencyKey: string | null;
  readonly status: MergeOperationStatus;
  readonly phase: MergeOperationPhase;
  readonly mergedSha: string | null;
  readonly failures: readonly MergeOperationFailure[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly gateProgress: MergeGateProgress | null;
  readonly failureKind: MergeOperationFailureKind | null;
  /** C3.57: verified sha whose L1 the merge inherited; null/absent when gates ran. */
  readonly gatesInheritedFromSha?: string | null;
}

export class MergeOperationReceiptError extends Error {
  override readonly name = 'MergeOperationReceiptError';
}

export function isFullGitSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

export function isMergeOperationStatus(v: unknown): v is MergeOperationStatus {
  return (
    typeof v === 'string' &&
    (MERGE_OPERATION_STATUSES as readonly string[]).includes(v)
  );
}

export function isMergeOperationPhase(v: unknown): v is MergeOperationPhase {
  return (
    typeof v === 'string' &&
    (MERGE_OPERATION_PHASES as readonly string[]).includes(v)
  );
}

export function isMergeOperationFailureKind(
  v: unknown,
): v is MergeOperationFailureKind {
  return (
    typeof v === 'string' &&
    (MERGE_OPERATION_FAILURE_KINDS as readonly string[]).includes(v)
  );
}

/** Normalize optional key; null when absent/unsafe. */
export function normalizeMergeIdempotencyKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  if (key.length === 0 || key.length > MAX_MERGE_IDEMPOTENCY_KEY_LEN) return null;
  if (!MERGE_IDEMPOTENCY_KEY_RE.test(key)) return null;
  return key;
}

export type MergeIdempotencyKeyParse =
  | { readonly status: 'absent'; readonly key: null }
  | { readonly status: 'ok'; readonly key: string }
  | { readonly status: 'invalid'; readonly reason: string };

/**
 * Parse optional API field. Present-but-malformed is invalid (HTTP 400) —
 * never silently downgrade to legacy no-key.
 */
export function parseMergeIdempotencyKeyInput(
  raw: unknown,
): MergeIdempotencyKeyParse {
  if (raw === undefined || raw === null) {
    return { status: 'absent', key: null };
  }
  if (typeof raw !== 'string') {
    return { status: 'invalid', reason: 'idempotencyKey must be a string' };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { status: 'invalid', reason: 'idempotencyKey must not be empty' };
  }
  if (trimmed.length > MAX_MERGE_IDEMPOTENCY_KEY_LEN) {
    return {
      status: 'invalid',
      reason: `idempotencyKey exceeds ${MAX_MERGE_IDEMPOTENCY_KEY_LEN} chars`,
    };
  }
  if (!MERGE_IDEMPOTENCY_KEY_RE.test(trimmed)) {
    return {
      status: 'invalid',
      reason:
        'idempotencyKey must match [A-Za-z0-9._:*-] (no path/control chars)',
    };
  }
  return { status: 'ok', key: trimmed };
}

/** Stable operation id from clock + seq + nonce (caller supplies entropy). */
export function makeMergeOperationId(
  nowMs: number,
  seq: number,
  nonceHex: string,
): string {
  const t = Math.max(0, Math.floor(nowMs)).toString(36);
  const s = Math.max(0, Math.floor(seq)).toString(10);
  const n = nonceHex.toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 16) || '0';
  return `mop-${t}-${s}-${n}`;
}

export function isMergeOperationTerminal(status: MergeOperationStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'interrupted';
}

/** Map internal phase → public status. */
export function publicMergeStatus(
  phaseOrStatus: MergeOperationPhase | MergeOperationStatus,
): MergeOperationStatus {
  switch (phaseOrStatus) {
    case 'accepted':
      return 'accepted';
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'interrupted':
      return 'interrupted';
    default:
      return 'running';
  }
}

/**
 * Success is push + merged_sha stamps only — never optimistic client state.
 */
export function isPublicMergeSuccess(record: {
  readonly status: MergeOperationStatus;
  readonly phase: MergeOperationPhase;
  readonly mergedSha: string | null;
}): boolean {
  return (
    record.status === 'succeeded' &&
    record.phase === 'stamped' &&
    isFullGitSha(record.mergedSha)
  );
}

export function sameOrderedTaskIds(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function canTransitionMergeOperationStatus(
  from: MergeOperationStatus,
  to: MergeOperationStatus,
): boolean {
  if (from === to) return true;
  if (isMergeOperationTerminal(from)) return false;
  if (from === 'accepted') {
    return to === 'running' || isMergeOperationTerminal(to);
  }
  if (from === 'running') {
    return isMergeOperationTerminal(to);
  }
  return false;
}

export function classifyMergeFailureReason(
  reason: string,
): MergeOperationFailureKind {
  const r = reason.toLowerCase();
  if (/already in flight|single[- ]flight/.test(r)) return 'single_flight';
  if (/daemon restart|interrupted/.test(r)) return 'interrupted';
  if (/l1 gates failed|gates failed|post-merge l1/.test(r)) return 'gate_failure';
  if (/\bconflict\b|merge conflict/.test(r)) return 'conflict';
  if (/\bpush\b/.test(r) && /fail|refused|rejected|error/.test(r)) {
    return 'push_failure';
  }
  if (/stamp|merged_sha|merged_via/.test(r) && /fail|could not|error/.test(r)) {
    return 'stamp_failure';
  }
  if (
    /verified-sha|missing verified|already merged|pr_status|path-lease|path-scope|project-state|ineligible|refused/.test(
      r,
    )
  ) {
    return 'precheck';
  }
  if (/merge failed|merge refused|could not merge/.test(r)) return 'conflict';
  return 'unknown';
}

const ABS_PATH_RE = /(?:\/|\\)(?:[A-Za-z0-9._-]+(?:\/|\\))+[A-Za-z0-9._-]*/g;
const SECRET_KV_RE =
  /\b(token|secret|password|authorization|bearer|api[_-]?key)[=:\s]+\S+/gi;

/** Bound + redact operator-facing failure text. */
export function redactMergeFailureReason(reason: string): string {
  const kind = classifyMergeFailureReason(reason);
  switch (kind) {
    case 'precheck':
      // Precheck reasons are Hercules-authored sentences (field names, SHAs),
      // never command output — keep them, sanitized and bounded, so the
      // operator learns WHICH rule refused (a downstream project task 23, 2026-09-12: two
      // deterministic refusals read only "merge precheck failed").
      return `merge precheck failed: ${sanitizeMergeFailureText(reason)}`;
    case 'conflict':
      return 'merge conflict';
    case 'gate_failure':
      return 'post-merge gates failed';
    case 'push_failure':
      return 'non-force push failed';
    case 'stamp_failure':
      return 'provenance stamp failed after push';
    case 'single_flight':
      return 'another merge operation is already running for this repository';
    case 'interrupted':
      return 'daemon restart interrupted merge';
    case 'unknown':
      break;
  }
  return sanitizeMergeFailureText(reason);
}

/** Path + secret redaction, single line, bounded to 240 chars. */
function sanitizeMergeFailureText(reason: string): string {
  let s = reason.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  s = s.replace(ABS_PATH_RE, '[path]');
  s = s.replace(SECRET_KV_RE, (_m, k: string) => `${String(k)}=[redacted]`);
  // Collapse multi-line command dumps to a single line.
  s = s.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const max = 240;
  if (s.length > max) s = `${s.slice(0, max)}…`;
  return s;
}

export function toMergeOperationReceipt(
  record: MergeOperationRecord,
): MergeOperationReceipt {
  if (record.status === 'succeeded' && !isPublicMergeSuccess(record)) {
    throw new MergeOperationReceiptError('invalid succeeded merge receipt');
  }
  return {
    operationId: record.operationId,
    repoKey: record.repoKey,
    taskIds: [...record.taskIds],
    idempotencyKey: record.idempotencyKey,
    status: record.status,
    phase: record.phase,
    mergedSha: record.mergedSha,
    failures: record.failures.map((f) => ({
      taskId: f.taskId,
      reason: redactMergeFailureReason(f.reason),
      kind: f.kind,
    })),
    createdAt: new Date(record.createdAtMs).toISOString(),
    updatedAt: new Date(record.updatedAtMs).toISOString(),
    gateProgress: record.gateProgress,
    failureKind: record.failureKind,
    gatesInheritedFromSha: record.gatesInheritedFromSha ?? null,
  };
}

export function safePublicMergeReceipt(
  record: MergeOperationRecord,
): MergeOperationReceipt {
  const receipt = toMergeOperationReceipt(record);
  return isPublicMergeSuccess(record)
    ? receipt
    : { ...receipt, mergedSha: null };
}
