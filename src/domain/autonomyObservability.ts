/**
 * Domain — autonomy quality observability (reporting-only).
 *
 * Pure types + normalization + cohort baselines + anomaly receipts.
 * Implements docs/autonomy/autonomy-observability.md rollout steps 1–2:
 * publish reporting and alerts only; no scheduling/routing/policy mutation.
 */
import { createHash } from 'node:crypto';
import { redactHostOutput } from './hostExecutor.js';
import { isValidIdentifier } from './task.js';

export const AUTONOMY_OBS_SCHEMA_VERSION = 1 as const;
export const AUTONOMY_OBS_MODE = 'reporting_only' as const;

export const AUTONOMY_OBS_METRIC_KINDS = [
  'completion',
  'verification_quality',
  'rework',
  'conflicts',
  'retries',
  'cost',
  'human_burden',
] as const;
export type AutonomyMetricKind = (typeof AUTONOMY_OBS_METRIC_KINDS)[number];

export const AUTONOMY_OBS_FAILURE_CLASSES = [
  'product',
  'agent',
  'infrastructure',
  'unknown',
] as const;
export type AutonomyFailureClass = (typeof AUTONOMY_OBS_FAILURE_CLASSES)[number];

export const AUTONOMY_OBS_PRESENCE = ['observed', 'unknown'] as const;
export type AutonomyMetricPresence = (typeof AUTONOMY_OBS_PRESENCE)[number];

/** Actions this reporting-only stage never authorizes. */
export const AUTONOMY_OBS_FORBIDDEN_ACTIONS = [
  'alter_scheduling',
  'alter_routing',
  'alter_context',
  'alter_concurrency',
  'alter_policy',
  'weaken_gates',
  'skip_tests',
  'broaden_permissions',
  'slice_tasks_unnecessarily',
] as const;
export type AutonomyObsForbiddenAction =
  (typeof AUTONOMY_OBS_FORBIDDEN_ACTIONS)[number];

/** Signals that would game quality metrics if rewarded. */
export const AUTONOMY_OBS_GAMING_SIGNALS = [
  'weakened_gates',
  'skipped_tests',
  'broader_permissions',
  'unnecessary_task_slicing',
] as const;
export type AutonomyGamingSignal = (typeof AUTONOMY_OBS_GAMING_SIGNALS)[number];

export const MAX_AUTONOMY_OBS_SAMPLES = 5_000;
export const MAX_AUTONOMY_OBS_RECEIPTS = 2_000;
export const MAX_AUTONOMY_OBS_ID_LEN = 200;
export const MAX_AUTONOMY_OBS_TEXT_LEN = 400;
export const MAX_AUTONOMY_OBS_SUMMARY_LEN = 800;
export const MAX_AUTONOMY_OBS_REDACT_LEN = 2_000;
export const MAX_AUTONOMY_OBS_EVIDENCE = 32;
export const MAX_AUTONOMY_OBS_VALIDATION_ERRORS = 64;
export const MAX_AUTONOMY_OBS_BYTES = 512 * 1024;

export type AutonomyObsValidationCode =
  | 'schema'
  | 'invalid_identifier'
  | 'invalid_kind'
  | 'invalid_observation'
  | 'invalid_failure_class'
  | 'forbidden_field'
  | 'unbounded'
  | 'missing_evidence'
  | 'gaming_green'
  | 'duplicate_id';

export interface AutonomyObsValidationIssue {
  readonly code: AutonomyObsValidationCode;
  readonly message: string;
}

export class AutonomyObservabilityValidationError extends Error {
  override readonly name = 'AutonomyObservabilityValidationError';
  readonly issues: readonly AutonomyObsValidationIssue[];
  constructor(message: string, issues: readonly AutonomyObsValidationIssue[] = []) {
    super(message);
    this.issues = issues;
  }
}

/** Observed numeric sample, or unknown when evidence is missing. */
export interface AutonomyMetricObservation {
  readonly presence: AutonomyMetricPresence;
  /** Null when presence is unknown — never invent zero/green. */
  readonly value: number | null;
}

export interface AutonomyMetricSample {
  readonly id: string;
  readonly kind: 'metric_sample';
  readonly taskId: string;
  readonly durableRunId: string;
  readonly repoKey: string;
  /** Cohort axis: executionClass:featureKind */
  readonly taskClass: string;
  readonly cohortKey: string;
  readonly metricKind: AutonomyMetricKind;
  readonly observation: AutonomyMetricObservation;
  readonly failureClass: AutonomyFailureClass;
  readonly observedAtMs: number;
  /** Evidence digests only — never raw logs. */
  readonly evidenceDigests: readonly string[];
  readonly gamingSignals: readonly AutonomyGamingSignal[];
  readonly summary: string;
}

export interface AutonomyAnomalyReceipt {
  readonly id: string;
  readonly kind: 'anomaly_receipt';
  readonly taskId: string;
  readonly durableRunId: string;
  readonly repoKey: string;
  readonly taskClass: string;
  readonly cohortKey: string;
  readonly metricKind: AutonomyMetricKind;
  readonly observedRegression: string;
  readonly evidenceDigests: readonly string[];
  readonly likelyCause: string;
  readonly confidence: number;
  readonly safeNextAction: string;
  readonly failureClass: AutonomyFailureClass;
  readonly observedAtMs: number;
  readonly gamingSignals: readonly AutonomyGamingSignal[];
}

export interface AutonomyCohortBaseline {
  readonly cohortKey: string;
  readonly repoKey: string;
  readonly taskClass: string;
  readonly metricKind: AutonomyMetricKind;
  readonly observedCount: number;
  readonly unknownCount: number;
  readonly median: number | null;
  readonly mean: number | null;
  readonly p90: number | null;
}

export interface AutonomyObservabilityStore {
  readonly version: typeof AUTONOMY_OBS_SCHEMA_VERSION;
  readonly mode: typeof AUTONOMY_OBS_MODE;
  readonly samples: readonly AutonomyMetricSample[];
  readonly receipts: readonly AutonomyAnomalyReceipt[];
}

export type AutonomySampleValidationResult =
  | { readonly ok: true; readonly sample: AutonomyMetricSample }
  | { readonly ok: false; readonly errors: readonly AutonomyObsValidationIssue[] };

export type AutonomyReceiptValidationResult =
  | { readonly ok: true; readonly receipt: AutonomyAnomalyReceipt }
  | { readonly ok: false; readonly errors: readonly AutonomyObsValidationIssue[] };

export type AutonomyStoreParseResult =
  | { readonly ok: true; readonly store: AutonomyObservabilityStore }
  | { readonly ok: false; readonly errors: readonly AutonomyObsValidationIssue[] };

export interface AppendAutonomyResult {
  readonly store: AutonomyObservabilityStore;
  readonly applied: boolean;
  readonly conflict: boolean;
  readonly doubleCountPrevented: boolean;
}

export interface VerifiedDeliveryScore {
  readonly presence: AutonomyMetricPresence;
  readonly value: number | null;
  readonly green: boolean;
  readonly penalized: boolean;
}

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

const PRODUCT_FAILURE_KINDS = new Set([
  'verify_l1',
  'verify_l2',
  'verify_l3',
  'product',
  'review_reversal',
  'post_merge_regression',
  'merge_conflict_product',
]);

const AGENT_FAILURE_KINDS = new Set([
  'agent_exit',
  'stall',
  'agent',
  'rework_loop',
  'thrash',
  'context_caused_correction',
]);

const INFRA_FAILURE_KINDS = new Set([
  'provision',
  'verify_infra',
  'base_drift',
  'infrastructure',
  'infra',
  'hard_infra',
  'resource_wait',
  'disk',
  'network',
  'auth_infra',
  'session_missing',
]);

export function autonomyObsMode(): typeof AUTONOMY_OBS_MODE {
  return AUTONOMY_OBS_MODE;
}

export function isAutonomyMetricKind(v: unknown): v is AutonomyMetricKind {
  return typeof v === 'string' && (AUTONOMY_OBS_METRIC_KINDS as readonly string[]).includes(v);
}

export function isAutonomyFailureClass(v: unknown): v is AutonomyFailureClass {
  return (
    typeof v === 'string' && (AUTONOMY_OBS_FAILURE_CLASSES as readonly string[]).includes(v)
  );
}

export function isAutonomyGamingSignal(v: unknown): v is AutonomyGamingSignal {
  return (
    typeof v === 'string' && (AUTONOMY_OBS_GAMING_SIGNALS as readonly string[]).includes(v)
  );
}

export function isAutonomyObsForbiddenAction(v: unknown): v is AutonomyObsForbiddenAction {
  return (
    typeof v === 'string' && (AUTONOMY_OBS_FORBIDDEN_ACTIONS as readonly string[]).includes(v)
  );
}

export function emptyAutonomyObservabilityStore(): AutonomyObservabilityStore {
  return {
    version: AUTONOMY_OBS_SCHEMA_VERSION,
    mode: AUTONOMY_OBS_MODE,
    samples: [],
    receipts: [],
  };
}

function boundMsg(text: string): string {
  const one = text.split(/\s+/).join(' ').trim();
  if (one.length <= MAX_AUTONOMY_OBS_TEXT_LEN) return one;
  return one.slice(0, MAX_AUTONOMY_OBS_TEXT_LEN - 1) + '...';
}

function pushError(
  errors: AutonomyObsValidationIssue[],
  code: AutonomyObsValidationCode,
  message: string,
): void {
  if (errors.length >= MAX_AUTONOMY_OBS_VALIDATION_ERRORS) return;
  errors.push({ code, message: boundMsg(message) });
}

function isSafeId(value: string, max = MAX_AUTONOMY_OBS_ID_LEN): boolean {
  return value.length > 0 && value.length <= max && isValidIdentifier(value);
}

function isNonEmptyBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function isFiniteNonNegInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && Number.isFinite(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isShaLike(value: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(value);
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

/** Bound + redact free text for summaries / diagnostics. */
export function redactAutonomyText(
  raw: string,
  max = MAX_AUTONOMY_OBS_REDACT_LEN,
): string {
  const redacted = redactHostOutput(raw, Math.max(max * 4, max));
  const cleaned = redacted.replace(/^…\[truncated \d+ chars]…\n/, '');
  if (cleaned.length <= max) return cleaned;
  return `…[truncated ${cleaned.length - max} chars]…\n${cleaned.slice(-max)}`;
}

export function resolveTaskClass(input: {
  readonly executionClass?: string | null;
  readonly featureKind?: string | null;
}): string {
  const execRaw = (input.executionClass ?? 'implement').trim().toLowerCase();
  const featRaw = (input.featureKind ?? 'general').trim().toLowerCase();
  const exec =
    execRaw.length > 0 && /^[a-z][a-z0-9_]*$/.test(execRaw) ? execRaw : 'implement';
  const feat =
    featRaw.length > 0 && /^[a-z][a-z0-9_]*$/.test(featRaw) ? featRaw : 'general';
  return `${exec}:${feat}`;
}

export function makeCohortKey(input: {
  readonly repoKey: string;
  readonly taskClass: string;
  readonly metricKind: AutonomyMetricKind;
}): string {
  const material = [input.repoKey, input.taskClass, input.metricKind].join('\0');
  return `cohort-${createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 32)}`;
}

export function makeAutonomySampleId(input: {
  readonly taskId: string;
  readonly durableRunId: string;
  readonly metricKind: AutonomyMetricKind;
  readonly observedAtMs: number;
}): string {
  const material = [
    input.taskId,
    input.durableRunId,
    input.metricKind,
    String(Math.trunc(input.observedAtMs)),
  ].join('\0');
  return `aos-${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}

export function makeAnomalyReceiptId(input: {
  readonly taskId: string;
  readonly durableRunId: string;
  readonly metricKind: AutonomyMetricKind;
  readonly observedAtMs: number;
}): string {
  const material = [
    'anomaly',
    input.taskId,
    input.durableRunId,
    input.metricKind,
    String(Math.trunc(input.observedAtMs)),
  ].join('\0');
  return `aar-${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}

/**
 * Map run/verify failure kinds into product / agent / infrastructure / unknown.
 * Missing kind → unknown (never invent a class).
 */
export function classifyAutonomyFailure(input: {
  readonly kind?: string | null;
}): AutonomyFailureClass {
  const raw = (input.kind ?? '').trim().toLowerCase();
  if (!raw) return 'unknown';
  if (PRODUCT_FAILURE_KINDS.has(raw)) return 'product';
  if (AGENT_FAILURE_KINDS.has(raw)) return 'agent';
  if (INFRA_FAILURE_KINDS.has(raw)) return 'infrastructure';
  if (raw.includes('infra') || raw.includes('provision') || raw.includes('enospc')) {
    return 'infrastructure';
  }
  if (raw.includes('agent') || raw.includes('stall') || raw.includes('thrash')) {
    return 'agent';
  }
  if (raw.includes('verify') || raw.includes('product') || raw.includes('test')) {
    return 'product';
  }
  return 'unknown';
}

export function metricPresence(sample: AutonomyMetricSample): AutonomyMetricPresence {
  return sample.observation.presence;
}

/** True when missing evidence is honestly unknown (not zero, not green). */
export function isUnknownNotGreen(sample: AutonomyMetricSample): boolean {
  return (
    sample.observation.presence === 'unknown' &&
    sample.observation.value === null
  );
}

export function detectGamingSignals(input: {
  readonly gatesWeakened?: boolean;
  readonly testsSkipped?: boolean;
  readonly permissionsBroadened?: boolean;
  readonly unnecessaryTaskSlicing?: boolean;
}): AutonomyGamingSignal[] {
  const out: AutonomyGamingSignal[] = [];
  if (input.gatesWeakened) out.push('weakened_gates');
  if (input.testsSkipped) out.push('skipped_tests');
  if (input.permissionsBroadened) out.push('broader_permissions');
  if (input.unnecessaryTaskSlicing) out.push('unnecessary_task_slicing');
  return out;
}

/**
 * Verified-delivery composite. Missing evidence → unknown (not green).
 * Gaming signals penalize and block a green claim.
 */
export function scoreVerifiedDelivery(input: {
  readonly completion: AutonomyMetricObservation;
  readonly verificationQuality: AutonomyMetricObservation;
  readonly rework: AutonomyMetricObservation;
  readonly gamingSignals: readonly AutonomyGamingSignal[];
}): VerifiedDeliveryScore {
  if (
    input.completion.presence === 'unknown' ||
    input.verificationQuality.presence === 'unknown' ||
    input.rework.presence === 'unknown' ||
    input.completion.value === null ||
    input.verificationQuality.value === null ||
    input.rework.value === null
  ) {
    return { presence: 'unknown', value: null, green: false, penalized: false };
  }

  const completion = clamp01(input.completion.value);
  const verification = clamp01(input.verificationQuality.value);
  // Lower rework is better; map to quality contribution.
  const reworkPenalty = clamp01(input.rework.value);
  let value = completion * 0.4 + verification * 0.4 + (1 - reworkPenalty) * 0.2;
  const penalized = input.gamingSignals.length > 0;
  if (penalized) {
    // Each gaming signal removes reward rather than adding efficiency credit.
    value = Math.max(0, value - 0.25 * input.gamingSignals.length);
  }
  const green = !penalized && value >= 0.85 && verification >= 0.9 && completion >= 1;
  return {
    presence: 'observed',
    value,
    green,
    penalized,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function validateObservation(
  raw: unknown,
  errors: AutonomyObsValidationIssue[],
): AutonomyMetricObservation | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    pushError(errors, 'invalid_observation', 'observation must be an object');
    return null;
  }
  const o = raw as Record<string, unknown>;
  if (o['presence'] !== 'observed' && o['presence'] !== 'unknown') {
    pushError(errors, 'invalid_observation', 'presence must be observed|unknown');
    return null;
  }
  if (o['presence'] === 'unknown') {
    if (o['value'] !== null) {
      pushError(
        errors,
        'invalid_observation',
        'unknown presence requires value null (not zero/green)',
      );
      return null;
    }
    return { presence: 'unknown', value: null };
  }
  if (!isFiniteNumber(o['value'])) {
    pushError(errors, 'invalid_observation', 'observed presence requires finite value');
    return null;
  }
  return { presence: 'observed', value: o['value'] as number };
}

function validateEvidenceDigests(
  raw: unknown,
  errors: AutonomyObsValidationIssue[],
  opts: { readonly requireNonEmpty: boolean },
): readonly string[] | null {
  if (!Array.isArray(raw)) {
    pushError(errors, 'schema', 'evidenceDigests must be an array');
    return null;
  }
  if (raw.length > MAX_AUTONOMY_OBS_EVIDENCE) {
    pushError(errors, 'unbounded', 'evidenceDigests exceed bound');
    return null;
  }
  if (opts.requireNonEmpty && raw.length === 0) {
    pushError(errors, 'missing_evidence', 'evidence digests required');
    return null;
  }
  const out: string[] = [];
  for (const d of raw) {
    if (typeof d !== 'string' || !isShaLike(d)) {
      pushError(errors, 'schema', 'evidence digest must be hex');
      return null;
    }
    out.push(d.toLowerCase());
  }
  return out;
}

function validateGamingSignals(
  raw: unknown,
  errors: AutonomyObsValidationIssue[],
): readonly AutonomyGamingSignal[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    pushError(errors, 'schema', 'gamingSignals must be an array');
    return null;
  }
  if (raw.length > AUTONOMY_OBS_GAMING_SIGNALS.length) {
    pushError(errors, 'unbounded', 'gamingSignals exceed bound');
    return null;
  }
  const out: AutonomyGamingSignal[] = [];
  for (const s of raw) {
    if (!isAutonomyGamingSignal(s)) {
      pushError(errors, 'schema', 'gaming signal invalid');
      return null;
    }
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function isRecordId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_AUTONOMY_OBS_ID_LEN &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

export function validateMetricSample(input: unknown): AutonomySampleValidationResult {
  const errors: AutonomyObsValidationIssue[] = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    pushError(errors, 'schema', 'sample must be an object');
    return { ok: false, errors };
  }
  const r = input as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (isForbiddenPayloadKey(key)) {
      pushError(errors, 'forbidden_field', `forbidden field: ${key}`);
    }
  }
  if (r['kind'] !== 'metric_sample') {
    pushError(errors, 'invalid_kind', 'kind must be metric_sample');
  }
  if (typeof r['id'] !== 'string' || !isRecordId(r['id'])) {
    pushError(errors, 'invalid_identifier', 'sample id invalid');
  }
  if (typeof r['taskId'] !== 'string' || !isSafeId(r['taskId'])) {
    pushError(errors, 'invalid_identifier', 'taskId invalid');
  }
  if (typeof r['durableRunId'] !== 'string' || !isSafeId(r['durableRunId'], 200)) {
    pushError(errors, 'invalid_identifier', 'durableRunId invalid');
  }
  if (typeof r['repoKey'] !== 'string' || !isSafeId(r['repoKey'])) {
    pushError(errors, 'invalid_identifier', 'repoKey invalid');
  }
  if (!isNonEmptyBoundedText(r['taskClass'], MAX_AUTONOMY_OBS_TEXT_LEN)) {
    pushError(errors, 'schema', 'taskClass invalid');
  }
  if (typeof r['cohortKey'] !== 'string' || !/^cohort-[0-9a-f]{16,64}$/i.test(r['cohortKey'])) {
    pushError(errors, 'schema', 'cohortKey invalid');
  }
  if (!isAutonomyMetricKind(r['metricKind'])) {
    pushError(errors, 'invalid_kind', 'metricKind invalid');
  }
  if (!isAutonomyFailureClass(r['failureClass'])) {
    pushError(errors, 'invalid_failure_class', 'failureClass invalid');
  }
  if (!isFiniteNonNegInt(r['observedAtMs'])) {
    pushError(errors, 'schema', 'observedAtMs must be non-negative integer');
  }
  if (!isNonEmptyBoundedText(r['summary'], MAX_AUTONOMY_OBS_SUMMARY_LEN)) {
    pushError(errors, 'unbounded', 'summary missing or too long');
  }

  const observation = validateObservation(r['observation'], errors);
  const gamingSignals = validateGamingSignals(r['gamingSignals'], errors);
  const requireEvidence = observation?.presence === 'observed';
  const evidenceDigests = validateEvidenceDigests(r['evidenceDigests'] ?? [], errors, {
    requireNonEmpty: requireEvidence === true,
  });

  if (
    observation &&
    gamingSignals &&
    gamingSignals.length > 0 &&
    observation.presence === 'observed' &&
    isFiniteNumber(observation.value) &&
    observation.value >= 1 &&
    (r['metricKind'] === 'completion' || r['metricKind'] === 'verification_quality')
  ) {
    pushError(
      errors,
      'gaming_green',
      'cannot claim green/perfect metric while gaming signals are present',
    );
  }

  if (errors.length > 0 || !observation || !gamingSignals || !evidenceDigests) {
    return { ok: false, errors };
  }

  const sample: AutonomyMetricSample = {
    id: r['id'] as string,
    kind: 'metric_sample',
    taskId: r['taskId'] as string,
    durableRunId: r['durableRunId'] as string,
    repoKey: r['repoKey'] as string,
    taskClass: (r['taskClass'] as string).trim(),
    cohortKey: r['cohortKey'] as string,
    metricKind: r['metricKind'] as AutonomyMetricKind,
    observation,
    failureClass: r['failureClass'] as AutonomyFailureClass,
    observedAtMs: r['observedAtMs'] as number,
    evidenceDigests,
    gamingSignals,
    summary: redactAutonomyText((r['summary'] as string).trim(), MAX_AUTONOMY_OBS_SUMMARY_LEN),
  };
  return { ok: true, sample };
}

export function normalizeMetricSample(input: {
  readonly taskId: string;
  readonly durableRunId: string;
  readonly repoKey: string;
  readonly executionClass?: string | null;
  readonly featureKind?: string | null;
  readonly metricKind: AutonomyMetricKind;
  readonly observation: AutonomyMetricObservation;
  readonly failureClass?: AutonomyFailureClass;
  readonly observedAtMs: number;
  readonly evidenceDigests?: readonly string[];
  readonly gamingSignals?: readonly AutonomyGamingSignal[];
  readonly summary: string;
  readonly id?: string;
}): AutonomySampleValidationResult {
  const taskClass = resolveTaskClass({
    // exactOptionalPropertyTypes: never pass bare undefined for optional keys
    executionClass: input.executionClass ?? null,
    featureKind: input.featureKind ?? null,
  });
  const cohortKey = makeCohortKey({
    repoKey: input.repoKey,
    taskClass,
    metricKind: input.metricKind,
  });
  const id =
    input.id ??
    makeAutonomySampleId({
      taskId: input.taskId,
      durableRunId: input.durableRunId,
      metricKind: input.metricKind,
      observedAtMs: input.observedAtMs,
    });
  return validateMetricSample({
    id,
    kind: 'metric_sample',
    taskId: input.taskId,
    durableRunId: input.durableRunId,
    repoKey: input.repoKey,
    taskClass,
    cohortKey,
    metricKind: input.metricKind,
    observation: input.observation,
    failureClass: input.failureClass ?? 'unknown',
    observedAtMs: input.observedAtMs,
    evidenceDigests: input.evidenceDigests ?? [],
    gamingSignals: input.gamingSignals ?? [],
    summary: input.summary,
  });
}

export function validateAnomalyReceipt(input: unknown): AutonomyReceiptValidationResult {
  const errors: AutonomyObsValidationIssue[] = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    pushError(errors, 'schema', 'receipt must be an object');
    return { ok: false, errors };
  }
  const r = input as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (isForbiddenPayloadKey(key)) {
      pushError(errors, 'forbidden_field', `forbidden field: ${key}`);
    }
  }
  if (r['kind'] !== 'anomaly_receipt') {
    pushError(errors, 'invalid_kind', 'kind must be anomaly_receipt');
  }
  if (typeof r['id'] !== 'string' || !isRecordId(r['id'])) {
    pushError(errors, 'invalid_identifier', 'receipt id invalid');
  }
  if (typeof r['taskId'] !== 'string' || !isSafeId(r['taskId'])) {
    pushError(errors, 'invalid_identifier', 'taskId invalid');
  }
  if (typeof r['durableRunId'] !== 'string' || !isSafeId(r['durableRunId'], 200)) {
    pushError(errors, 'invalid_identifier', 'durableRunId invalid');
  }
  if (typeof r['repoKey'] !== 'string' || !isSafeId(r['repoKey'])) {
    pushError(errors, 'invalid_identifier', 'repoKey invalid');
  }
  if (!isNonEmptyBoundedText(r['taskClass'], MAX_AUTONOMY_OBS_TEXT_LEN)) {
    pushError(errors, 'schema', 'taskClass invalid');
  }
  if (typeof r['cohortKey'] !== 'string' || !/^cohort-[0-9a-f]{16,64}$/i.test(r['cohortKey'])) {
    pushError(errors, 'schema', 'cohortKey invalid');
  }
  if (!isAutonomyMetricKind(r['metricKind'])) {
    pushError(errors, 'invalid_kind', 'metricKind invalid');
  }
  if (!isAutonomyFailureClass(r['failureClass'])) {
    pushError(errors, 'invalid_failure_class', 'failureClass invalid');
  }
  if (!isFiniteNonNegInt(r['observedAtMs'])) {
    pushError(errors, 'schema', 'observedAtMs must be non-negative integer');
  }
  if (!isNonEmptyBoundedText(r['observedRegression'], MAX_AUTONOMY_OBS_SUMMARY_LEN)) {
    pushError(errors, 'unbounded', 'observedRegression missing or too long');
  }
  if (!isNonEmptyBoundedText(r['likelyCause'], MAX_AUTONOMY_OBS_SUMMARY_LEN)) {
    pushError(errors, 'unbounded', 'likelyCause missing or too long');
  }
  if (!isNonEmptyBoundedText(r['safeNextAction'], MAX_AUTONOMY_OBS_SUMMARY_LEN)) {
    pushError(errors, 'unbounded', 'safeNextAction missing or too long');
  }
  if (
    typeof r['confidence'] !== 'number' ||
    !Number.isFinite(r['confidence']) ||
    r['confidence'] < 0 ||
    r['confidence'] > 1
  ) {
    pushError(errors, 'schema', 'confidence must be 0..1');
  }

  const evidenceDigests = validateEvidenceDigests(r['evidenceDigests'], errors, {
    requireNonEmpty: true,
  });
  const gamingSignals = validateGamingSignals(r['gamingSignals'], errors);

  if (errors.length > 0 || !evidenceDigests || !gamingSignals) {
    return { ok: false, errors };
  }

  const receipt: AutonomyAnomalyReceipt = {
    id: r['id'] as string,
    kind: 'anomaly_receipt',
    taskId: r['taskId'] as string,
    durableRunId: r['durableRunId'] as string,
    repoKey: r['repoKey'] as string,
    taskClass: (r['taskClass'] as string).trim(),
    cohortKey: r['cohortKey'] as string,
    metricKind: r['metricKind'] as AutonomyMetricKind,
    observedRegression: redactAutonomyText(
      (r['observedRegression'] as string).trim(),
      MAX_AUTONOMY_OBS_SUMMARY_LEN,
    ),
    evidenceDigests,
    likelyCause: redactAutonomyText(
      (r['likelyCause'] as string).trim(),
      MAX_AUTONOMY_OBS_SUMMARY_LEN,
    ),
    confidence: r['confidence'] as number,
    safeNextAction: redactAutonomyText(
      (r['safeNextAction'] as string).trim(),
      MAX_AUTONOMY_OBS_SUMMARY_LEN,
    ),
    failureClass: r['failureClass'] as AutonomyFailureClass,
    observedAtMs: r['observedAtMs'] as number,
    gamingSignals,
  };
  return { ok: true, receipt };
}

export function buildAnomalyReceipt(input: {
  readonly taskId: string;
  readonly durableRunId: string;
  readonly repoKey: string;
  readonly taskClass: string;
  readonly metricKind: AutonomyMetricKind;
  readonly observedRegression: string;
  readonly evidenceDigests: readonly string[];
  readonly likelyCause: string;
  readonly confidence: number;
  readonly safeNextAction: string;
  readonly failureClass: AutonomyFailureClass;
  readonly observedAtMs: number;
  readonly gamingSignals?: readonly AutonomyGamingSignal[];
  readonly id?: string;
}): AutonomyReceiptValidationResult {
  // Strip accidental secret/raw-log fields by only projecting known keys.
  const cohortKey = makeCohortKey({
    repoKey: input.repoKey,
    taskClass: input.taskClass,
    metricKind: input.metricKind,
  });
  const id =
    input.id ??
    makeAnomalyReceiptId({
      taskId: input.taskId,
      durableRunId: input.durableRunId,
      metricKind: input.metricKind,
      observedAtMs: input.observedAtMs,
    });
  return validateAnomalyReceipt({
    id,
    kind: 'anomaly_receipt',
    taskId: input.taskId,
    durableRunId: input.durableRunId,
    repoKey: input.repoKey,
    taskClass: input.taskClass,
    cohortKey,
    metricKind: input.metricKind,
    observedRegression: input.observedRegression,
    evidenceDigests: input.evidenceDigests,
    likelyCause: input.likelyCause,
    confidence: input.confidence,
    safeNextAction: input.safeNextAction,
    failureClass: input.failureClass,
    observedAtMs: input.observedAtMs,
    gamingSignals: input.gamingSignals ?? [],
  });
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

function sameSample(a: AutonomyMetricSample, b: AutonomyMetricSample): boolean {
  return stableStringify(a) === stableStringify(b);
}

function sameReceipt(a: AutonomyAnomalyReceipt, b: AutonomyAnomalyReceipt): boolean {
  return stableStringify(a) === stableStringify(b);
}

export function appendMetricSample(
  store: AutonomyObservabilityStore,
  rawSample: unknown,
): AppendAutonomyResult {
  const validated = validateMetricSample(rawSample);
  if (!validated.ok) {
    return { store, applied: false, conflict: true, doubleCountPrevented: false };
  }
  const sample = validated.sample;
  if (store.samples.length >= MAX_AUTONOMY_OBS_SAMPLES) {
    return { store, applied: false, conflict: true, doubleCountPrevented: false };
  }
  const byId = store.samples.find((item) => item.id === sample.id);
  if (byId) {
    if (sameSample(byId, sample)) {
      return { store, applied: false, conflict: false, doubleCountPrevented: true };
    }
    return { store, applied: false, conflict: true, doubleCountPrevented: false };
  }
  return {
    store: {
      version: AUTONOMY_OBS_SCHEMA_VERSION,
      mode: AUTONOMY_OBS_MODE,
      samples: [...store.samples, sample],
      receipts: store.receipts,
    },
    applied: true,
    conflict: false,
    doubleCountPrevented: false,
  };
}

export function appendAnomalyReceipt(
  store: AutonomyObservabilityStore,
  rawReceipt: unknown,
): AppendAutonomyResult {
  const validated = validateAnomalyReceipt(rawReceipt);
  if (!validated.ok) {
    return { store, applied: false, conflict: true, doubleCountPrevented: false };
  }
  const receipt = validated.receipt;
  if (store.receipts.length >= MAX_AUTONOMY_OBS_RECEIPTS) {
    return { store, applied: false, conflict: true, doubleCountPrevented: false };
  }
  const byId = store.receipts.find((item) => item.id === receipt.id);
  if (byId) {
    if (sameReceipt(byId, receipt)) {
      return { store, applied: false, conflict: false, doubleCountPrevented: true };
    }
    return { store, applied: false, conflict: true, doubleCountPrevented: false };
  }
  return {
    store: {
      version: AUTONOMY_OBS_SCHEMA_VERSION,
      mode: AUTONOMY_OBS_MODE,
      samples: store.samples,
      receipts: [...store.receipts, receipt],
    },
    applied: true,
    conflict: false,
    doubleCountPrevented: false,
  };
}

function medianOf(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

export function buildCohortBaseline(
  store: AutonomyObservabilityStore,
  query: {
    readonly repoKey: string;
    readonly taskClass: string;
    readonly metricKind: AutonomyMetricKind;
  },
): AutonomyCohortBaseline {
  const cohortKey = makeCohortKey(query);
  const matched = store.samples.filter(
    (s) =>
      s.cohortKey === cohortKey &&
      s.repoKey === query.repoKey &&
      s.taskClass === query.taskClass &&
      s.metricKind === query.metricKind,
  );
  const observedValues = matched
    .filter((s) => s.observation.presence === 'observed' && s.observation.value !== null)
    .map((s) => s.observation.value as number)
    .sort((a, b) => a - b);
  const unknownCount = matched.filter((s) => s.observation.presence === 'unknown').length;
  const mean =
    observedValues.length === 0
      ? null
      : observedValues.reduce((acc, v) => acc + v, 0) / observedValues.length;
  return {
    cohortKey,
    repoKey: query.repoKey,
    taskClass: query.taskClass,
    metricKind: query.metricKind,
    observedCount: observedValues.length,
    unknownCount,
    median: medianOf(observedValues),
    mean,
    p90: percentile(observedValues, 0.9),
  };
}

export function autonomyObsCanonical(store: AutonomyObservabilityStore): string {
  return stableStringify({
    version: store.version,
    mode: store.mode,
    samples: store.samples,
    receipts: store.receipts,
  });
}

export function autonomyObsDigest(store: AutonomyObservabilityStore): string {
  return createHash('sha256').update(autonomyObsCanonical(store), 'utf8').digest('hex');
}

export function serializeAutonomyObservabilityStore(
  store: AutonomyObservabilityStore,
): string {
  const samples: AutonomyMetricSample[] = [];
  for (const s of store.samples) {
    const v = validateMetricSample(s);
    if (!v.ok) {
      throw new AutonomyObservabilityValidationError(
        v.errors[0]?.message ?? 'invalid sample in store',
        v.errors,
      );
    }
    samples.push(v.sample);
  }
  const receipts: AutonomyAnomalyReceipt[] = [];
  for (const r of store.receipts) {
    const v = validateAnomalyReceipt(r);
    if (!v.ok) {
      throw new AutonomyObservabilityValidationError(
        v.errors[0]?.message ?? 'invalid receipt in store',
        v.errors,
      );
    }
    receipts.push(v.receipt);
  }
  const doc = {
    version: AUTONOMY_OBS_SCHEMA_VERSION,
    mode: AUTONOMY_OBS_MODE,
    samples,
    receipts,
  };
  const json = JSON.stringify(doc);
  if (json.length > MAX_AUTONOMY_OBS_BYTES) {
    throw new AutonomyObservabilityValidationError('store exceeds byte bound', [
      { code: 'unbounded', message: 'store exceeds byte bound' },
    ]);
  }
  return json;
}

export function parseAutonomyObservabilityStore(raw: string): AutonomyStoreParseResult {
  const errors: AutonomyObsValidationIssue[] = [];
  let doc: unknown;
  try {
    doc = JSON.parse(raw) as unknown;
  } catch {
    pushError(errors, 'schema', 'invalid JSON');
    return { ok: false, errors };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    pushError(errors, 'schema', 'store must be an object');
    return { ok: false, errors };
  }
  const d = doc as Record<string, unknown>;
  if (d['version'] !== AUTONOMY_OBS_SCHEMA_VERSION) {
    pushError(errors, 'schema', 'unsupported schema version');
  }
  if (d['mode'] !== AUTONOMY_OBS_MODE) {
    pushError(errors, 'schema', 'mode must be reporting_only');
  }
  if (!Array.isArray(d['samples']) || !Array.isArray(d['receipts'])) {
    pushError(errors, 'schema', 'samples and receipts must be arrays');
    return { ok: false, errors };
  }
  if (d['samples'].length > MAX_AUTONOMY_OBS_SAMPLES) {
    pushError(errors, 'unbounded', 'samples exceed bound');
  }
  if (d['receipts'].length > MAX_AUTONOMY_OBS_RECEIPTS) {
    pushError(errors, 'unbounded', 'receipts exceed bound');
  }
  if (errors.length > 0) return { ok: false, errors };

  const samples: AutonomyMetricSample[] = [];
  for (const item of d['samples']) {
    const v = validateMetricSample(item);
    if (!v.ok) return { ok: false, errors: v.errors };
    samples.push(v.sample);
  }
  const receipts: AutonomyAnomalyReceipt[] = [];
  for (const item of d['receipts']) {
    const v = validateAnomalyReceipt(item);
    if (!v.ok) return { ok: false, errors: v.errors };
    receipts.push(v.receipt);
  }
  return {
    ok: true,
    store: {
      version: AUTONOMY_OBS_SCHEMA_VERSION,
      mode: AUTONOMY_OBS_MODE,
      samples,
      receipts,
    },
  };
}

/** Reporting-only: never mutates runtime control planes. */
export function autonomyObsMayMutateRuntime(_store: AutonomyObservabilityStore): false {
  return false;
}

/** Reporting-only: never authorizes scheduling/routing/policy/gaming actions. */
export function autonomyObsAuthorizes(
  _store: AutonomyObservabilityStore,
  _action: AutonomyObsForbiddenAction | string,
): false {
  return false;
}
