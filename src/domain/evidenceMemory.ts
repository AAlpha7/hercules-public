/**
 * Domain — evidence memory event schema (record-only foundation).
 *
 * Pure types + validation + idempotent store append + redaction.
 * Implements docs/autonomy/evidence-memory.md stage 1: record only.
 * Does NOT alter prompts, routing, permissions, scheduling, or source code.
 */
import { createHash } from 'node:crypto';
import { redactHostOutput } from './hostExecutor.js';
import { isValidIdentifier } from './task.js';

export const EVIDENCE_MEMORY_SCHEMA_VERSION = 1 as const;

export const EVIDENCE_MEMORY_RECORD_KINDS = [
  'raw_event',
  'verified_outcome',
  'superseded_evidence',
  'playbook_knowledge',
] as const;
export type EvidenceMemoryRecordKind = (typeof EVIDENCE_MEMORY_RECORD_KINDS)[number];

export const EVIDENCE_MEMORY_CONTRADICTION_STATES = [
  'none',
  'suspected',
  'confirmed',
] as const;
export type EvidenceMemoryContradictionState =
  (typeof EVIDENCE_MEMORY_CONTRADICTION_STATES)[number];

/** Actions this record-only stage never authorizes. */
export const EVIDENCE_MEMORY_FORBIDDEN_ACTIONS = [
  'alter_prompt',
  'alter_routing',
  'alter_permissions',
  'alter_scheduling',
  'alter_source_code',
] as const;
export type EvidenceMemoryForbiddenAction =
  (typeof EVIDENCE_MEMORY_FORBIDDEN_ACTIONS)[number];

export const EVIDENCE_MEMORY_GATE_LEVELS = [
  'l1',
  'l2',
  'l3',
  'held-out',
  'packet',
  'integration',
] as const;
export type EvidenceMemoryGateLevel = (typeof EVIDENCE_MEMORY_GATE_LEVELS)[number];

export const MAX_EVIDENCE_MEMORY_RECORDS = 5_000;
export const MAX_EVIDENCE_MEMORY_ID_LEN = 128;
export const MAX_EVIDENCE_MEMORY_TEXT_LEN = 400;
export const MAX_EVIDENCE_MEMORY_SUMMARY_LEN = 800;
export const MAX_EVIDENCE_MEMORY_REDACT_LEN = 2_000;
export const MAX_EVIDENCE_MEMORY_GATES = 32;
export const MAX_EVIDENCE_MEMORY_LIST = 32;
export const MAX_EVIDENCE_MEMORY_VALIDATION_ERRORS = 64;
export const MAX_EVIDENCE_MEMORY_BYTES = 256 * 1024;

export type EvidenceMemoryValidationCode =
  | 'schema'
  | 'invalid_identifier'
  | 'invalid_kind'
  | 'invalid_provenance'
  | 'invalid_scope'
  | 'invalid_payload'
  | 'forbidden_field'
  | 'unbounded'
  | 'duplicate_id'
  | 'missing_link';

export interface EvidenceMemoryValidationIssue {
  readonly code: EvidenceMemoryValidationCode;
  readonly message: string;
}

export class EvidenceMemoryValidationError extends Error {
  override readonly name = 'EvidenceMemoryValidationError';
  readonly issues: readonly EvidenceMemoryValidationIssue[];
  constructor(message: string, issues: readonly EvidenceMemoryValidationIssue[] = []) {
    super(message);
    this.issues = issues;
  }
}

/** Exact task / candidate / gate provenance for every reusable fact. */
export interface EvidenceMemoryProvenance {
  readonly taskId: string;
  readonly candidateSha?: string;
  readonly gateId?: string;
  readonly durableRunId?: string;
  readonly verificationRunId?: string;
}

export interface EvidenceMemoryScope {
  readonly project?: string;
  readonly module?: string;
  readonly repoKey?: string;
}

/** Task fingerprint — digests only; never raw body/logs. */
export interface EvidenceMemoryFingerprint {
  readonly taskId: string;
  readonly repoKey: string;
  readonly featureKind?: string;
  readonly bodyDigest: string;
}

export interface EvidenceMemoryGraphFeatures {
  readonly nodeCount?: number;
  readonly edgeCount?: number;
  readonly decompositionDepth?: number;
  readonly hasIntegrationContract?: boolean;
}

export interface EvidenceMemoryRouting {
  readonly adapter: string;
  readonly permissionClass?: string;
}

export interface EvidenceMemoryRetries {
  readonly attempts: number;
  readonly failureKinds: readonly string[];
}

export interface EvidenceMemoryGateResult {
  readonly gateId: string;
  readonly level: EvidenceMemoryGateLevel;
  readonly ok: boolean;
}

export interface EvidenceMemoryConflict {
  readonly kind: string;
  readonly resourceKey?: string;
}

export interface EvidenceMemoryIntervention {
  readonly kind: string;
  readonly noteDigest?: string;
}

export interface EvidenceMemoryDiagnosis {
  readonly cause: string;
  readonly confidence: number;
}

/**
 * Normalized evidence-memory record.
 * Kinds distinguish raw receipts, verified outcomes, superseded evidence,
 * and promoted playbook knowledge (still record-only).
 */
export interface EvidenceMemoryRecord {
  readonly id: string;
  readonly kind: EvidenceMemoryRecordKind;
  readonly observedAtMs: number;
  readonly scope: EvidenceMemoryScope;
  /** Wall-clock recency marker for retrieval ranking (ms epoch). */
  readonly recencyMs: number;
  readonly contradictionState: EvidenceMemoryContradictionState;
  readonly provenance: EvidenceMemoryProvenance;
  readonly fingerprint: EvidenceMemoryFingerprint;
  readonly graphFeatures?: EvidenceMemoryGraphFeatures;
  readonly routing?: EvidenceMemoryRouting;
  readonly retries?: EvidenceMemoryRetries;
  readonly gates?: readonly EvidenceMemoryGateResult[];
  readonly conflicts?: readonly EvidenceMemoryConflict[];
  readonly interventions?: readonly EvidenceMemoryIntervention[];
  readonly diagnosed?: EvidenceMemoryDiagnosis;
  readonly summary: string;
  /** Stable outcome identity for verified results (double-count guard). */
  readonly outcomeIdentity?: string;
  /** Prior record this supersession entry replaces. */
  readonly supersedesRecordId?: string;
  /** Verified outcome ids that justify playbook knowledge. */
  readonly sourceOutcomeIds?: readonly string[];
  /** Optional sanitized scalar map — never secrets/raw logs. */
  readonly payload?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface EvidenceMemoryStore {
  readonly version: typeof EVIDENCE_MEMORY_SCHEMA_VERSION;
  readonly records: readonly EvidenceMemoryRecord[];
}

export type EvidenceMemoryValidationResult =
  | { readonly ok: true; readonly record: EvidenceMemoryRecord }
  | { readonly ok: false; readonly errors: readonly EvidenceMemoryValidationIssue[] };

export type EvidenceMemoryStoreParseResult =
  | { readonly ok: true; readonly store: EvidenceMemoryStore }
  | { readonly ok: false; readonly errors: readonly EvidenceMemoryValidationIssue[] };

export interface AppendEvidenceMemoryResult {
  readonly store: EvidenceMemoryStore;
  readonly applied: boolean;
  readonly conflict: boolean;
  readonly doubleCountPrevented: boolean;
}

/** Field names excluded from reusable payloads (secrets, credentials, PII, raw logs). */
const FORBIDDEN_PAYLOAD_KEYS = new Set([
  'password',
  'passwd',
  'token',
  'secret',
  'apikey',
  'api_key',
  'credential',
  'credentials',
  'authorization',
  'auth',
  'bearer',
  'cookie',
  'session',
  'privatekey',
  'private_key',
  'rawlog',
  'rawlogs',
  'raw_log',
  'raw_logs',
  'stdout',
  'stderr',
  'logfile',
  'log_file',
  'email',
  'phone',
  'ssn',
  'personaldata',
  'personal_data',
  'pii',
]);

export function isEvidenceMemoryRecordKind(v: unknown): v is EvidenceMemoryRecordKind {
  return typeof v === 'string' && (EVIDENCE_MEMORY_RECORD_KINDS as readonly string[]).includes(v);
}

export function isEvidenceMemoryContradictionState(
  v: unknown,
): v is EvidenceMemoryContradictionState {
  return (
    typeof v === 'string' &&
    (EVIDENCE_MEMORY_CONTRADICTION_STATES as readonly string[]).includes(v)
  );
}

export function isEvidenceMemoryGateLevel(v: unknown): v is EvidenceMemoryGateLevel {
  return typeof v === 'string' && (EVIDENCE_MEMORY_GATE_LEVELS as readonly string[]).includes(v);
}

export function isEvidenceMemoryForbiddenAction(v: unknown): v is EvidenceMemoryForbiddenAction {
  return (
    typeof v === 'string' &&
    (EVIDENCE_MEMORY_FORBIDDEN_ACTIONS as readonly string[]).includes(v)
  );
}

export function emptyEvidenceMemoryStore(): EvidenceMemoryStore {
  return { version: EVIDENCE_MEMORY_SCHEMA_VERSION, records: [] };
}

function boundMsg(text: string): string {
  const one = text.split(/\s+/).join(' ').trim();
  if (one.length <= MAX_EVIDENCE_MEMORY_TEXT_LEN) return one;
  return one.slice(0, MAX_EVIDENCE_MEMORY_TEXT_LEN - 1) + '...';
}

function pushError(
  errors: EvidenceMemoryValidationIssue[],
  code: EvidenceMemoryValidationCode,
  message: string,
): void {
  if (errors.length >= MAX_EVIDENCE_MEMORY_VALIDATION_ERRORS) return;
  errors.push({ code, message: boundMsg(message) });
}

function isSafeId(value: string, max = MAX_EVIDENCE_MEMORY_ID_LEN): boolean {
  return value.length > 0 && value.length <= max && isValidIdentifier(value);
}

function isNonEmptyBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function isFiniteNonNegInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && Number.isFinite(value);
}

function isShaLike(value: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(value);
}

/** Bound + redact free text for summaries / diagnostics. */
export function redactEvidenceText(
  raw: string,
  max = MAX_EVIDENCE_MEMORY_REDACT_LEN,
): string {
  const redacted = redactHostOutput(raw, Math.max(max * 4, max));
  const cleaned = redacted.replace(/^…\[truncated \d+ chars]…\n/, '');
  if (cleaned.length <= max) return cleaned;
  return `…[truncated ${cleaned.length - max} chars]…\n${cleaned.slice(-max)}`;
}

function normalizeForbiddenKey(key: string): string {
  return key.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
}

function isForbiddenPayloadKey(key: string): boolean {
  const n = normalizeForbiddenKey(key);
  if (FORBIDDEN_PAYLOAD_KEYS.has(n)) return true;
  if (n.includes('password') || n.includes('secret') || n.includes('token')) return true;
  if (n.includes('credential') || n.includes('rawlog') || n.includes('personal')) return true;
  if (n.endsWith('apikey') || n.includes('privatekey')) return true;
  return false;
}

/**
 * Drop secret/credential/PII/raw-log fields; keep only bounded scalars.
 * Nested objects/arrays are dropped (not expanded into raw dumps).
 */
export function sanitizeEvidencePayload(
  input: unknown,
): Readonly<Record<string, string | number | boolean | null>> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, string | number | boolean | null> = {};
  let count = 0;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (count >= MAX_EVIDENCE_MEMORY_LIST) break;
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_EVIDENCE_MEMORY_TEXT_LEN) {
      continue;
    }
    if (isForbiddenPayloadKey(key)) continue;
    if (value === null) {
      out[key] = null;
      count += 1;
      continue;
    }
    if (typeof value === 'boolean') {
      out[key] = value;
      count += 1;
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
      count += 1;
      continue;
    }
    if (typeof value === 'string') {
      const redacted = redactEvidenceText(value, MAX_EVIDENCE_MEMORY_TEXT_LEN);
      out[key] = redacted;
      count += 1;
    }
    // objects/arrays intentionally dropped
  }
  return out;
}

function payloadHasForbiddenKeys(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  for (const key of Object.keys(payload as Record<string, unknown>)) {
    if (isForbiddenPayloadKey(key)) return true;
  }
  return false;
}

export function makeEvidenceRecordId(input: {
  readonly kind: EvidenceMemoryRecordKind;
  readonly provenance: EvidenceMemoryProvenance;
  readonly observedAtMs: number;
  readonly payloadDigest: string;
}): string {
  const material = [
    input.kind,
    input.provenance.taskId,
    input.provenance.candidateSha ?? '',
    input.provenance.gateId ?? '',
    input.provenance.durableRunId ?? '',
    String(Math.trunc(input.observedAtMs)),
    input.payloadDigest,
  ].join('\0');
  return `em-${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}

/** Stable verified-outcome identity — restart/replay must not double-count. */
export function makeOutcomeIdentity(input: {
  readonly taskId: string;
  readonly durableRunId: string;
  readonly gateId: string;
}): string {
  const material = [input.taskId, input.durableRunId, input.gateId].join('\0');
  return `eo-${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}

function validateProvenance(
  raw: unknown,
  kind: EvidenceMemoryRecordKind,
  errors: EvidenceMemoryValidationIssue[],
): EvidenceMemoryProvenance | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    pushError(errors, 'invalid_provenance', 'provenance must be an object');
    return null;
  }
  const p = raw as Record<string, unknown>;
  if (typeof p['taskId'] !== 'string' || !isSafeId(p['taskId'])) {
    pushError(errors, 'invalid_identifier', 'provenance.taskId must be a safe identifier');
    return null;
  }
  const reusable =
    kind === 'verified_outcome' ||
    kind === 'playbook_knowledge' ||
    kind === 'superseded_evidence';
  let candidateSha: string | undefined;
  if (p['candidateSha'] !== undefined) {
    if (typeof p['candidateSha'] !== 'string' || !isShaLike(p['candidateSha'])) {
      pushError(errors, 'invalid_provenance', 'candidateSha must be a hex sha');
      return null;
    }
    candidateSha = p['candidateSha'].toLowerCase();
  } else if (reusable) {
    pushError(errors, 'invalid_provenance', 'reusable facts require candidateSha');
    return null;
  }
  let gateId: string | undefined;
  if (p['gateId'] !== undefined) {
    if (typeof p['gateId'] !== 'string' || !isSafeId(p['gateId'])) {
      pushError(errors, 'invalid_identifier', 'gateId must be a safe identifier');
      return null;
    }
    gateId = p['gateId'];
  } else if (reusable) {
    pushError(errors, 'invalid_provenance', 'reusable facts require gateId');
    return null;
  }
  let durableRunId: string | undefined;
  if (p['durableRunId'] !== undefined) {
    if (typeof p['durableRunId'] !== 'string' || !isSafeId(p['durableRunId'], 200)) {
      pushError(errors, 'invalid_identifier', 'durableRunId invalid');
      return null;
    }
    durableRunId = p['durableRunId'];
  }
  let verificationRunId: string | undefined;
  if (p['verificationRunId'] !== undefined) {
    if (typeof p['verificationRunId'] !== 'string' || !isSafeId(p['verificationRunId'], 200)) {
      pushError(errors, 'invalid_identifier', 'verificationRunId invalid');
      return null;
    }
    verificationRunId = p['verificationRunId'];
  }
  const out: EvidenceMemoryProvenance = { taskId: p['taskId'] };
  if (candidateSha !== undefined) {
    return {
      ...out,
      candidateSha,
      ...(gateId !== undefined ? { gateId } : {}),
      ...(durableRunId !== undefined ? { durableRunId } : {}),
      ...(verificationRunId !== undefined ? { verificationRunId } : {}),
    };
  }
  return {
    ...out,
    ...(gateId !== undefined ? { gateId } : {}),
    ...(durableRunId !== undefined ? { durableRunId } : {}),
    ...(verificationRunId !== undefined ? { verificationRunId } : {}),
  };
}

function validateScope(
  raw: unknown,
  errors: EvidenceMemoryValidationIssue[],
): EvidenceMemoryScope | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    pushError(errors, 'invalid_scope', 'scope must be an object');
    return null;
  }
  const s = raw as Record<string, unknown>;
  const out: {
    project?: string;
    module?: string;
    repoKey?: string;
  } = {};
  for (const key of ['project', 'module', 'repoKey'] as const) {
    if (s[key] === undefined) continue;
    if (typeof s[key] !== 'string' || !isSafeId(s[key] as string, MAX_EVIDENCE_MEMORY_TEXT_LEN)) {
      pushError(errors, 'invalid_scope', `scope.${key} invalid`);
      return null;
    }
    out[key] = s[key] as string;
  }
  return out;
}

function validateFingerprint(
  raw: unknown,
  taskId: string,
  errors: EvidenceMemoryValidationIssue[],
): EvidenceMemoryFingerprint | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    pushError(errors, 'schema', 'fingerprint must be an object');
    return null;
  }
  const f = raw as Record<string, unknown>;
  if (typeof f['taskId'] !== 'string' || !isSafeId(f['taskId'])) {
    pushError(errors, 'invalid_identifier', 'fingerprint.taskId invalid');
    return null;
  }
  if (f['taskId'] !== taskId) {
    pushError(errors, 'invalid_provenance', 'fingerprint.taskId must match provenance.taskId');
    return null;
  }
  if (typeof f['repoKey'] !== 'string' || !isSafeId(f['repoKey'])) {
    pushError(errors, 'invalid_identifier', 'fingerprint.repoKey invalid');
    return null;
  }
  if (typeof f['bodyDigest'] !== 'string' || !isShaLike(f['bodyDigest'])) {
    pushError(errors, 'schema', 'fingerprint.bodyDigest must be a hex digest');
    return null;
  }
  let featureKind: string | undefined;
  if (f['featureKind'] !== undefined) {
    if (!isNonEmptyBoundedText(f['featureKind'], MAX_EVIDENCE_MEMORY_TEXT_LEN)) {
      pushError(errors, 'unbounded', 'featureKind invalid');
      return null;
    }
    featureKind = (f['featureKind'] as string).trim();
  }
  if (featureKind !== undefined) {
    return {
      taskId: f['taskId'],
      repoKey: f['repoKey'],
      featureKind,
      bodyDigest: (f['bodyDigest'] as string).toLowerCase(),
    };
  }
  return {
    taskId: f['taskId'],
    repoKey: f['repoKey'],
    bodyDigest: (f['bodyDigest'] as string).toLowerCase(),
  };
}

function validateGraphFeatures(
  raw: unknown,
  errors: EvidenceMemoryValidationIssue[],
): EvidenceMemoryGraphFeatures | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    pushError(errors, 'schema', 'graphFeatures must be an object');
    return undefined;
  }
  const g = raw as Record<string, unknown>;
  const out: {
    nodeCount?: number;
    edgeCount?: number;
    decompositionDepth?: number;
    hasIntegrationContract?: boolean;
  } = {};
  for (const key of ['nodeCount', 'edgeCount', 'decompositionDepth'] as const) {
    if (g[key] === undefined) continue;
    if (!isFiniteNonNegInt(g[key]) || (g[key] as number) > 10_000) {
      pushError(errors, 'unbounded', `graphFeatures.${key} out of range`);
      return undefined;
    }
    out[key] = g[key] as number;
  }
  if (g['hasIntegrationContract'] !== undefined) {
    if (typeof g['hasIntegrationContract'] !== 'boolean') {
      pushError(errors, 'schema', 'hasIntegrationContract must be boolean');
      return undefined;
    }
    out.hasIntegrationContract = g['hasIntegrationContract'];
  }
  return out;
}

function validateRouting(
  raw: unknown,
  errors: EvidenceMemoryValidationIssue[],
): EvidenceMemoryRouting | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    pushError(errors, 'schema', 'routing must be an object');
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyBoundedText(r['adapter'], MAX_EVIDENCE_MEMORY_TEXT_LEN)) {
    pushError(errors, 'schema', 'routing.adapter required');
    return undefined;
  }
  if (isForbiddenPayloadKey(String(r['adapter']))) {
    pushError(errors, 'forbidden_field', 'routing.adapter looks secret-bearing');
    return undefined;
  }
  let permissionClass: string | undefined;
  if (r['permissionClass'] !== undefined) {
    if (!isNonEmptyBoundedText(r['permissionClass'], MAX_EVIDENCE_MEMORY_TEXT_LEN)) {
      pushError(errors, 'schema', 'permissionClass invalid');
      return undefined;
    }
    permissionClass = (r['permissionClass'] as string).trim();
  }
  if (permissionClass !== undefined) {
    return { adapter: (r['adapter'] as string).trim(), permissionClass };
  }
  return { adapter: (r['adapter'] as string).trim() };
}

function validateRetries(
  raw: unknown,
  errors: EvidenceMemoryValidationIssue[],
): EvidenceMemoryRetries | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    pushError(errors, 'schema', 'retries must be an object');
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  if (!isFiniteNonNegInt(r['attempts']) || (r['attempts'] as number) > 10_000) {
    pushError(errors, 'unbounded', 'retries.attempts out of range');
    return undefined;
  }
  if (!Array.isArray(r['failureKinds'])) {
    pushError(errors, 'schema', 'failureKinds must be an array');
    return undefined;
  }
  if (r['failureKinds'].length > MAX_EVIDENCE_MEMORY_LIST) {
    pushError(errors, 'unbounded', 'failureKinds exceed bound');
    return undefined;
  }
  const kinds: string[] = [];
  for (const k of r['failureKinds']) {
    if (!isNonEmptyBoundedText(k, MAX_EVIDENCE_MEMORY_TEXT_LEN)) {
      pushError(errors, 'schema', 'failureKinds entry invalid');
      return undefined;
    }
    kinds.push((k as string).trim());
  }
  return { attempts: r['attempts'] as number, failureKinds: kinds };
}

function validateGates(
  raw: unknown,
  errors: EvidenceMemoryValidationIssue[],
): readonly EvidenceMemoryGateResult[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    pushError(errors, 'schema', 'gates must be an array');
    return undefined;
  }
  if (raw.length > MAX_EVIDENCE_MEMORY_GATES) {
    pushError(errors, 'unbounded', 'gates exceed bound');
    return undefined;
  }
  const out: EvidenceMemoryGateResult[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      pushError(errors, 'schema', 'gate entry must be an object');
      return undefined;
    }
    const g = item as Record<string, unknown>;
    if (typeof g['gateId'] !== 'string' || !isSafeId(g['gateId'])) {
      pushError(errors, 'invalid_identifier', 'gateId invalid');
      return undefined;
    }
    if (!isEvidenceMemoryGateLevel(g['level'])) {
      pushError(errors, 'schema', 'gate level invalid');
      return undefined;
    }
    if (typeof g['ok'] !== 'boolean') {
      pushError(errors, 'schema', 'gate.ok must be boolean');
      return undefined;
    }
    out.push({ gateId: g['gateId'], level: g['level'], ok: g['ok'] });
  }
  return out;
}

function validateNamedList(
  raw: unknown,
  field: 'conflicts' | 'interventions',
  errors: EvidenceMemoryValidationIssue[],
): readonly { readonly kind: string; readonly resourceKey?: string; readonly noteDigest?: string }[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    pushError(errors, 'schema', `${field} must be an array`);
    return undefined;
  }
  if (raw.length > MAX_EVIDENCE_MEMORY_LIST) {
    pushError(errors, 'unbounded', `${field} exceed bound`);
    return undefined;
  }
  const out: { kind: string; resourceKey?: string; noteDigest?: string }[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      pushError(errors, 'schema', `${field} entry must be an object`);
      return undefined;
    }
    const o = item as Record<string, unknown>;
    if (!isNonEmptyBoundedText(o['kind'], MAX_EVIDENCE_MEMORY_TEXT_LEN)) {
      pushError(errors, 'schema', `${field}.kind invalid`);
      return undefined;
    }
    const entry: { kind: string; resourceKey?: string; noteDigest?: string } = {
      kind: (o['kind'] as string).trim(),
    };
    if (field === 'conflicts' && o['resourceKey'] !== undefined) {
      if (!isNonEmptyBoundedText(o['resourceKey'], MAX_EVIDENCE_MEMORY_TEXT_LEN)) {
        pushError(errors, 'schema', 'conflict.resourceKey invalid');
        return undefined;
      }
      entry.resourceKey = (o['resourceKey'] as string).trim();
    }
    if (field === 'interventions' && o['noteDigest'] !== undefined) {
      if (typeof o['noteDigest'] !== 'string' || !isShaLike(o['noteDigest'])) {
        pushError(errors, 'schema', 'intervention.noteDigest must be a digest');
        return undefined;
      }
      entry.noteDigest = (o['noteDigest'] as string).toLowerCase();
    }
    out.push(entry);
  }
  return out;
}

function validateDiagnosed(
  raw: unknown,
  errors: EvidenceMemoryValidationIssue[],
): EvidenceMemoryDiagnosis | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    pushError(errors, 'schema', 'diagnosed must be an object');
    return undefined;
  }
  const d = raw as Record<string, unknown>;
  if (!isNonEmptyBoundedText(d['cause'], MAX_EVIDENCE_MEMORY_SUMMARY_LEN)) {
    pushError(errors, 'unbounded', 'diagnosed.cause invalid');
    return undefined;
  }
  if (
    typeof d['confidence'] !== 'number' ||
    !Number.isFinite(d['confidence']) ||
    d['confidence'] < 0 ||
    d['confidence'] > 1
  ) {
    pushError(errors, 'schema', 'diagnosed.confidence must be 0..1');
    return undefined;
  }
  return {
    cause: redactEvidenceText((d['cause'] as string).trim(), MAX_EVIDENCE_MEMORY_SUMMARY_LEN),
    confidence: d['confidence'],
  };
}

function isRecordId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

function validateIdList(
  raw: unknown,
  field: string,
  errors: EvidenceMemoryValidationIssue[],
): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    pushError(errors, 'schema', `${field} must be an array`);
    return undefined;
  }
  if (raw.length > MAX_EVIDENCE_MEMORY_LIST) {
    pushError(errors, 'unbounded', `${field} exceed bound`);
    return undefined;
  }
  const out: string[] = [];
  for (const id of raw) {
    if (!isRecordId(id)) {
      pushError(errors, 'invalid_identifier', `${field} entry invalid`);
      return undefined;
    }
    out.push(id);
  }
  return out;
}

export function validateEvidenceMemoryRecord(input: unknown): EvidenceMemoryValidationResult {
  const errors: EvidenceMemoryValidationIssue[] = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    pushError(errors, 'schema', 'record must be an object');
    return { ok: false, errors };
  }
  const r = input as Record<string, unknown>;
  if (!isEvidenceMemoryRecordKind(r['kind'])) {
    pushError(errors, 'invalid_kind', 'record kind invalid');
    return { ok: false, errors };
  }
  const kind = r['kind'];
  if (typeof r['id'] !== 'string' || r['id'].length === 0 || r['id'].length > 200) {
    pushError(errors, 'invalid_identifier', 'record id invalid');
    return { ok: false, errors };
  }
  if (!/^[A-Za-z0-9._-]+$/.test(r['id'])) {
    pushError(errors, 'invalid_identifier', 'record id has unsafe characters');
    return { ok: false, errors };
  }
  if (!isFiniteNonNegInt(r['observedAtMs'])) {
    pushError(errors, 'schema', 'observedAtMs must be a non-negative integer');
    return { ok: false, errors };
  }
  if (!isFiniteNonNegInt(r['recencyMs'])) {
    pushError(errors, 'schema', 'recencyMs must be a non-negative integer');
    return { ok: false, errors };
  }
  if (!isEvidenceMemoryContradictionState(r['contradictionState'])) {
    pushError(errors, 'schema', 'contradictionState invalid');
    return { ok: false, errors };
  }
  if (!isNonEmptyBoundedText(r['summary'], MAX_EVIDENCE_MEMORY_SUMMARY_LEN)) {
    pushError(errors, 'unbounded', 'summary missing or too long');
    return { ok: false, errors };
  }
  const summary = redactEvidenceText((r['summary'] as string).trim(), MAX_EVIDENCE_MEMORY_SUMMARY_LEN);
  if (payloadHasForbiddenKeys(r['payload'])) {
    pushError(errors, 'forbidden_field', 'payload contains secret/credential/PII/raw-log fields');
  }
  // Also reject forbidden keys at top-level dump fields
  for (const key of Object.keys(r)) {
    if (isForbiddenPayloadKey(key) && key !== 'kind') {
      // kind is never forbidden; other secret-shaped top-level keys are banned
      if (
        key === 'password' ||
        key === 'token' ||
        key === 'secret' ||
        key === 'rawLog' ||
        key === 'rawLogs' ||
        key === 'stdout' ||
        key === 'stderr' ||
        key === 'email' ||
        key === 'personalData'
      ) {
        pushError(errors, 'forbidden_field', `forbidden top-level field: ${key}`);
      }
    }
  }

  const provenance = validateProvenance(r['provenance'], kind, errors);
  const scope = validateScope(r['scope'], errors);
  if (!provenance || !scope) {
    return { ok: false, errors };
  }
  const fingerprint = validateFingerprint(r['fingerprint'], provenance.taskId, errors);
  if (!fingerprint) {
    return { ok: false, errors };
  }

  const graphFeatures = validateGraphFeatures(r['graphFeatures'], errors);
  const routing = validateRouting(r['routing'], errors);
  const retries = validateRetries(r['retries'], errors);
  const gates = validateGates(r['gates'], errors);
  const conflictsRaw = validateNamedList(r['conflicts'], 'conflicts', errors);
  const interventionsRaw = validateNamedList(r['interventions'], 'interventions', errors);
  const diagnosed = validateDiagnosed(r['diagnosed'], errors);

  let supersedesRecordId: string | undefined;
  if (r['supersedesRecordId'] !== undefined) {
    if (
      typeof r['supersedesRecordId'] !== 'string' ||
      !/^[A-Za-z0-9._-]+$/.test(r['supersedesRecordId'])
    ) {
      pushError(errors, 'invalid_identifier', 'supersedesRecordId invalid');
    } else {
      supersedesRecordId = r['supersedesRecordId'];
    }
  }
  if (kind === 'superseded_evidence' && !supersedesRecordId) {
    pushError(errors, 'missing_link', 'superseded_evidence requires supersedesRecordId');
  }

  const sourceOutcomeIds = validateIdList(r['sourceOutcomeIds'], 'sourceOutcomeIds', errors);
  if (kind === 'playbook_knowledge') {
    if (!sourceOutcomeIds || sourceOutcomeIds.length === 0) {
      pushError(errors, 'missing_link', 'playbook_knowledge requires sourceOutcomeIds');
    }
  }

  let outcomeIdentity: string | undefined;
  if (r['outcomeIdentity'] !== undefined) {
    if (
      typeof r['outcomeIdentity'] !== 'string' ||
      !/^[A-Za-z0-9._-]+$/.test(r['outcomeIdentity']) ||
      r['outcomeIdentity'].length > 200
    ) {
      pushError(errors, 'invalid_identifier', 'outcomeIdentity invalid');
    } else {
      outcomeIdentity = r['outcomeIdentity'];
    }
  }

  let payload: Readonly<Record<string, string | number | boolean | null>> | undefined;
  if (r['payload'] !== undefined) {
    if (payloadHasForbiddenKeys(r['payload'])) {
      // already pushed forbidden_field
    } else {
      payload = sanitizeEvidencePayload(r['payload']);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const record: EvidenceMemoryRecord = {
    id: r['id'] as string,
    kind,
    observedAtMs: r['observedAtMs'] as number,
    scope,
    recencyMs: r['recencyMs'] as number,
    contradictionState: r['contradictionState'] as EvidenceMemoryContradictionState,
    provenance,
    fingerprint,
    summary,
    ...(graphFeatures !== undefined ? { graphFeatures } : {}),
    ...(routing !== undefined ? { routing } : {}),
    ...(retries !== undefined ? { retries } : {}),
    ...(gates !== undefined ? { gates } : {}),
    ...(conflictsRaw !== undefined
      ? {
          conflicts: conflictsRaw.map((c) =>
            c.resourceKey !== undefined
              ? { kind: c.kind, resourceKey: c.resourceKey }
              : { kind: c.kind },
          ),
        }
      : {}),
    ...(interventionsRaw !== undefined
      ? {
          interventions: interventionsRaw.map((i) =>
            i.noteDigest !== undefined
              ? { kind: i.kind, noteDigest: i.noteDigest }
              : { kind: i.kind },
          ),
        }
      : {}),
    ...(diagnosed !== undefined ? { diagnosed } : {}),
    ...(outcomeIdentity !== undefined ? { outcomeIdentity } : {}),
    ...(supersedesRecordId !== undefined ? { supersedesRecordId } : {}),
    ...(sourceOutcomeIds !== undefined ? { sourceOutcomeIds } : {}),
    ...(payload !== undefined ? { payload } : {}),
  };
  return { ok: true, record };
}

function sameRecord(a: EvidenceMemoryRecord, b: EvidenceMemoryRecord): boolean {
  return evidenceMemoryRecordCanonical(a) === evidenceMemoryRecordCanonical(b);
}

function evidenceMemoryRecordCanonical(record: EvidenceMemoryRecord): string {
  return stableStringify(record);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    out[k] = sortKeys(obj[k]);
  }
  return out;
}

export function appendEvidenceMemoryRecord(
  store: EvidenceMemoryStore,
  rawRecord: unknown,
): AppendEvidenceMemoryResult {
  const validated = validateEvidenceMemoryRecord(rawRecord);
  if (!validated.ok) {
    return { store, applied: false, conflict: true, doubleCountPrevented: false };
  }
  const record = validated.record;
  if (store.records.length >= MAX_EVIDENCE_MEMORY_RECORDS) {
    return { store, applied: false, conflict: true, doubleCountPrevented: false };
  }

  const byId = store.records.find((item) => item.id === record.id);
  if (byId) {
    if (sameRecord(byId, record)) {
      return { store, applied: false, conflict: false, doubleCountPrevented: false };
    }
    return { store, applied: false, conflict: true, doubleCountPrevented: false };
  }

  if (record.kind === 'verified_outcome' && record.outcomeIdentity) {
    const priorOutcome = store.records.find(
      (item) =>
        item.kind === 'verified_outcome' && item.outcomeIdentity === record.outcomeIdentity,
    );
    if (priorOutcome) {
      return {
        store,
        applied: false,
        conflict: false,
        doubleCountPrevented: true,
      };
    }
  }

  return {
    store: {
      version: EVIDENCE_MEMORY_SCHEMA_VERSION,
      records: [...store.records, record],
    },
    applied: true,
    conflict: false,
    doubleCountPrevented: false,
  };
}

export function countVerifiedOutcomes(store: EvidenceMemoryStore): number {
  return store.records.filter((r) => r.kind === 'verified_outcome').length;
}

export function evidenceMemoryCanonical(store: EvidenceMemoryStore): string {
  return stableStringify({
    version: store.version,
    records: store.records,
  });
}

export function evidenceMemoryDigest(store: EvidenceMemoryStore): string {
  return createHash('sha256').update(evidenceMemoryCanonical(store), 'utf8').digest('hex');
}

export function serializeEvidenceMemoryStore(store: EvidenceMemoryStore): string {
  const validatedRecords: EvidenceMemoryRecord[] = [];
  for (const r of store.records) {
    const v = validateEvidenceMemoryRecord(r);
    if (!v.ok) {
      throw new EvidenceMemoryValidationError(
        v.errors[0]?.message ?? 'invalid record in store',
        v.errors,
      );
    }
    validatedRecords.push(v.record);
  }
  const doc = {
    version: EVIDENCE_MEMORY_SCHEMA_VERSION,
    records: validatedRecords,
  };
  const json = JSON.stringify(doc);
  if (json.length > MAX_EVIDENCE_MEMORY_BYTES) {
    throw new EvidenceMemoryValidationError('evidence memory document exceeds byte bound');
  }
  return json;
}

export function parseEvidenceMemoryStore(raw: string): EvidenceMemoryStoreParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return {
      ok: false,
      errors: [{ code: 'schema', message: 'evidence memory document is not valid JSON' }],
    };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: [{ code: 'schema', message: 'store must be an object' }] };
  }
  const o = value as Record<string, unknown>;
  if (o['version'] !== EVIDENCE_MEMORY_SCHEMA_VERSION) {
    return { ok: false, errors: [{ code: 'schema', message: 'version must be 1' }] };
  }
  if (!Array.isArray(o['records'])) {
    return { ok: false, errors: [{ code: 'schema', message: 'records must be an array' }] };
  }
  if (o['records'].length > MAX_EVIDENCE_MEMORY_RECORDS) {
    return { ok: false, errors: [{ code: 'unbounded', message: 'too many records' }] };
  }
  const records: EvidenceMemoryRecord[] = [];
  const seen = new Set<string>();
  const errors: EvidenceMemoryValidationIssue[] = [];
  for (const item of o['records']) {
    const v = validateEvidenceMemoryRecord(item);
    if (!v.ok) {
      for (const e of v.errors) pushError(errors, e.code, e.message);
      continue;
    }
    if (seen.has(v.record.id)) {
      pushError(errors, 'duplicate_id', 'duplicate record id ' + v.record.id);
      continue;
    }
    seen.add(v.record.id);
    records.push(v.record);
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    store: { version: EVIDENCE_MEMORY_SCHEMA_VERSION, records },
  };
}

/** Record-only: never grants runtime mutation authority. */
export function evidenceMemoryMayMutateRuntime(_store: EvidenceMemoryStore): false {
  return false;
}

export function evidenceMemoryAuthorizes(
  _store: EvidenceMemoryStore,
  _action: EvidenceMemoryForbiddenAction | string,
): false {
  return false;
}
