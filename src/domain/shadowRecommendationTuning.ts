/**
 * Domain — shadow recommendation comparison + bounded reversible tuning policy.
 *
 * Implements docs/autonomy/autonomy-observability.md rollout steps 3–4:
 * 3. Run decomposition / routing / context recommendations in shadow mode.
 * 4. Define bounded reversible tuning only after repeated measured benefit.
 *
 * Pure types + comparison + disposition. Live tuning is NEVER enabled here;
 * applying a bound requires a separate explicit policy and human approval.
 * Core safety, evidence, merge, deploy, production, permission, and gate
 * boundaries cannot be self-modified by this module.
 */
import { createHash } from 'node:crypto';
import { makeCohortKey } from './autonomyObservability.js';
import { isValidIdentifier } from './task.js';

export const SHADOW_REC_SCHEMA_VERSION = 1 as const;
export const SHADOW_REC_MODE = 'shadow' as const;

export const SHADOW_REC_KINDS = ['decomposition', 'routing', 'context'] as const;
export type ShadowRecommendationKind = (typeof SHADOW_REC_KINDS)[number];

export const SHADOW_REC_RISK_CLASSES = ['low', 'medium', 'high'] as const;
export type ShadowRiskClass = (typeof SHADOW_REC_RISK_CLASSES)[number];

/** Cohort metrics compared for every shadow recommendation. */
export const SHADOW_COMPARISON_METRICS = [
  'success',
  'guardrails',
  'rework',
  'cost',
  'human_burden',
] as const;
export type ShadowComparisonMetric = (typeof SHADOW_COMPARISON_METRICS)[number];

export const SHADOW_COMPARISON_VERDICTS = [
  'benefit',
  'neutral',
  'regression',
  'insufficient_evidence',
] as const;
export type ShadowComparisonVerdict = (typeof SHADOW_COMPARISON_VERDICTS)[number];

export const SHADOW_DISPOSITIONS = [
  'shadow_continue',
  'bounded_tuning_eligible',
  'proposal_only',
  'human_task_only',
] as const;
export type ShadowDisposition = (typeof SHADOW_DISPOSITIONS)[number];

/** Targets this module must never tune or auto-apply. */
export const SHADOW_REC_FORBIDDEN_TARGETS = [
  'core_safety',
  'evidence_policy',
  'merge_policy',
  'deploy_policy',
  'production_boundary',
  'permission_policy',
  'security_policy',
  'gate_policy',
] as const;
export type ShadowForbiddenTarget = (typeof SHADOW_REC_FORBIDDEN_TARGETS)[number];

/** Actions this shadow/tuning stage never authorizes. */
export const SHADOW_REC_FORBIDDEN_ACTIONS = [
  'alter_core_safety',
  'alter_evidence_policy',
  'alter_merge_policy',
  'alter_deploy_policy',
  'alter_production_boundary',
  'alter_permissions',
  'alter_security_policy',
  'enable_live_tuning',
  'weaken_gates',
  'alter_scheduling',
  'skip_tests',
  'broaden_permissions',
] as const;
export type ShadowRecForbiddenAction = (typeof SHADOW_REC_FORBIDDEN_ACTIONS)[number];

/** Minimum distinct benefit windows before low-risk bounded tuning is eligible. */
export const MIN_REPEATED_MEASURED_BENEFIT = 2 as const;
/** Minimum observed samples per cohort side for a decisive comparison. */
export const MIN_COHORT_SAMPLES = 5 as const;
/** Guardrail / burden regression tolerance (absolute). */
export const GUARDRAIL_REGRESSION_EPS = 0.02 as const;
export const BURDEN_REGRESSION_EPS = 0.05 as const;
/** Success must improve by at least this for a "benefit" verdict. */
export const SUCCESS_BENEFIT_EPS = 0.02 as const;

export const MAX_SHADOW_REC_ID_LEN = 200;
export const MAX_SHADOW_REC_TEXT_LEN = 400;
export const MAX_SHADOW_REC_SUMMARY_LEN = 800;
export const MAX_SHADOW_REC_EVIDENCE = 32;
export const MAX_SHADOW_REC_STORE_ITEMS = 2_000;
export const MAX_SHADOW_REC_BYTES = 512 * 1024;
export const MAX_SHADOW_REC_VALIDATION_ERRORS = 64;

export type ShadowRecValidationCode =
  | 'schema'
  | 'invalid_identifier'
  | 'invalid_kind'
  | 'invalid_risk'
  | 'forbidden_target'
  | 'forbidden_field'
  | 'missing_evidence'
  | 'missing_owner'
  | 'missing_bound'
  | 'missing_rollback'
  | 'missing_expiry'
  | 'missing_metrics'
  | 'live_tuning_forbidden'
  | 'applied_forbidden'
  | 'unbounded'
  | 'risk_mismatch'
  | 'not_eligible';

export interface ShadowRecValidationIssue {
  readonly code: ShadowRecValidationCode;
  readonly message: string;
}

export class ShadowRecommendationTuningError extends Error {
  override readonly name = 'ShadowRecommendationTuningError';
  readonly issues: readonly ShadowRecValidationIssue[];
  constructor(message: string, issues: readonly ShadowRecValidationIssue[] = []) {
    super(message);
    this.issues = issues;
  }
}

export interface ShadowCohortMetrics {
  /** Higher is better (0..1 composite of completion × verification). */
  readonly success: number;
  /** Higher is better (guardrail / anti-gaming score). */
  readonly guardrails: number;
  /** Lower is better. */
  readonly rework: number;
  /** Lower is better (normalized cost units). */
  readonly cost: number;
  /** Lower is better. */
  readonly humanBurden: number;
  readonly sampleCount: number;
  readonly unknownCount: number;
}

export interface ShadowRecommendation {
  readonly id: string;
  readonly kind: 'shadow_recommendation';
  readonly version: typeof SHADOW_REC_SCHEMA_VERSION;
  readonly mode: typeof SHADOW_REC_MODE;
  readonly recommendationKind: ShadowRecommendationKind;
  readonly riskClass: ShadowRiskClass;
  readonly repoKey: string;
  readonly taskClass: string;
  readonly cohortKey: string;
  readonly targetKey: string;
  readonly summary: string;
  readonly evidenceDigests: readonly string[];
  readonly observedAtMs: number;
  readonly liveTuningEnabled: false;
  readonly mutatesRuntime: false;
}

export interface MetricDelta {
  readonly baseline: number;
  readonly candidate: number;
  readonly delta: number;
  /** True when candidate is better for this metric's polarity. */
  readonly improved: boolean;
  readonly worsened: boolean;
}

export interface ShadowComparisonMetrics {
  readonly success: MetricDelta;
  readonly guardrails: MetricDelta;
  readonly rework: MetricDelta;
  readonly cost: MetricDelta;
  readonly human_burden: MetricDelta;
}

export interface ShadowComparisonResult {
  readonly id: string;
  readonly kind: 'shadow_comparison';
  readonly mode: typeof SHADOW_REC_MODE;
  readonly recommendationId: string;
  readonly recommendationKind: ShadowRecommendationKind;
  readonly cohortKey: string;
  readonly windowId: string;
  readonly metrics: ShadowComparisonMetrics;
  readonly verdict: ShadowComparisonVerdict;
  readonly measuredBenefit: boolean;
  readonly guardrailBreach: boolean;
  readonly appliesLiveTuning: false;
  readonly observedAtMs: number;
}

export interface RepeatedBenefitEvaluation {
  readonly benefitCount: number;
  readonly repeatedBenefit: boolean;
  readonly minRequired: typeof MIN_REPEATED_MEASURED_BENEFIT;
}

export interface ShadowDispositionResult {
  readonly disposition: ShadowDisposition;
  readonly riskClass: ShadowRiskClass;
  readonly mayBuildBoundedTuning: boolean;
  readonly requiresHumanTask: boolean;
  readonly liveTuningEnabled: false;
  readonly repeatedBenefit: boolean;
  readonly benefitCount: number;
  readonly reasons: readonly string[];
}

export type BoundDirection = 'increase' | 'decrease' | 'either';

export interface TuningBound {
  readonly parameter: string;
  readonly maxDelta: number;
  readonly unit: string;
  readonly direction: BoundDirection;
}

export interface TuningRollback {
  readonly strategy: 'restore_prior_value';
  readonly priorValueDigest: string;
}

export interface BoundedTuningSpec {
  readonly id: string;
  readonly kind: 'bounded_tuning_spec';
  readonly recommendationId: string;
  readonly targetKey: string;
  readonly owner: string;
  readonly bound: TuningBound;
  readonly rollback: TuningRollback;
  readonly expiryMs: number;
  readonly successMetrics: readonly ShadowComparisonMetric[];
  readonly guardrailMetrics: readonly ShadowComparisonMetric[];
  /** Always false in this module — live apply needs separate policy. */
  readonly liveEnabled: false;
  readonly requiresSeparatePolicyApproval: true;
  /** Always false — this task never applies tuning. */
  readonly applied: false;
  readonly observedAtMs: number;
}

export interface HighRiskHumanTaskProposal {
  readonly id: string;
  readonly kind: 'human_task_proposal';
  readonly recommendationId: string;
  readonly targetKey: string;
  readonly title: string;
  readonly body: string;
  readonly evidenceDigests: readonly string[];
  readonly autoApply: false;
  readonly riskClass: 'high';
  readonly observedAtMs: number;
}

export interface ShadowRecommendationStore {
  readonly version: typeof SHADOW_REC_SCHEMA_VERSION;
  readonly mode: typeof SHADOW_REC_MODE;
  readonly liveTuningEnabled: false;
  readonly recommendations: readonly ShadowRecommendation[];
  readonly comparisons: readonly ShadowComparisonResult[];
  readonly tuningSpecs: readonly BoundedTuningSpec[];
}

export type ShadowRecValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly ShadowRecValidationIssue[] };

export type ShadowRecommendationBuildResult =
  | { readonly ok: true; readonly recommendation: ShadowRecommendation }
  | { readonly ok: false; readonly errors: readonly ShadowRecValidationIssue[] };

export type ShadowComparisonBuildResult =
  | { readonly ok: true; readonly comparison: ShadowComparisonResult }
  | { readonly ok: false; readonly errors: readonly ShadowRecValidationIssue[] };

export type BoundedTuningBuildResult =
  | { readonly ok: true; readonly spec: BoundedTuningSpec }
  | { readonly ok: false; readonly errors: readonly ShadowRecValidationIssue[] };

export type HumanTaskBuildResult =
  | { readonly ok: true; readonly proposal: HighRiskHumanTaskProposal }
  | { readonly ok: false; readonly errors: readonly ShadowRecValidationIssue[] };

export type BoundedTuningFromDispositionResult =
  | {
      readonly ok: true;
      readonly spec: BoundedTuningSpec;
      readonly liveTuningEnabled: false;
    }
  | { readonly ok: false; readonly errors: readonly ShadowRecValidationIssue[] };

export type ShadowStoreParseResult =
  | { readonly ok: true; readonly store: ShadowRecommendationStore }
  | { readonly ok: false; readonly errors: readonly ShadowRecValidationIssue[] };

export interface AppendShadowResult {
  readonly store: ShadowRecommendationStore;
  readonly applied: boolean;
  readonly conflict: boolean;
}

// ---------------------------------------------------------------------------
// Risk classification
// ---------------------------------------------------------------------------

const LOW_RISK_PATTERNS: readonly RegExp[] = [
  /retrieval[_\s-]?rank/i,
  /context[_\s-]?budget/i,
  /concurrency[_\s-]?(?:soft[_\s-]?)?cap/i,
  /agent[_\s-]?routing/i,
  /adapter[_\s-]?preference/i,
  /routing[_\s-]?preference/i,
];

const MEDIUM_RISK_PATTERNS: readonly RegExp[] = [
  /decomposition[_\s-]?graph/i,
  /graph[_\s-]?shape/i,
  /default[_\s-]?adapter/i,
  /pipeline[_\s-]?stage/i,
  /adapter[_\s-]?switch/i,
];

const HIGH_RISK_PATTERNS: readonly RegExp[] = [
  /permission/i,
  /security/i,
  /core[_\s-]?safety/i,
  /merge/i,
  /deploy/i,
  /production/i,
  /evidence[_\s-]?gate/i,
  /gate[_\s-]?policy/i,
  /gate[_\s-]?skip/i,
  /privilege/i,
  /destructive/i,
];

const FORBIDDEN_TARGET_PATTERNS: readonly RegExp[] = [
  /\bcore[_\s-]?safety\b/i,
  /\bevidence[_\s-]?policy\b/i,
  /\bmerge[_\s-]?(?:policy|auto)/i,
  /\bdeploy[_\s-]?(?:policy|production)/i,
  /\bproduction[_\s-]?boundary\b/i,
  /\bpermission[_\s-]?policy\b/i,
  /\bsecurity[_\s-]?policy\b/i,
  /\bgate[_\s-]?policy\b/i,
  /\bpermission\b/i,
  /\bsecurity\b/i,
];

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_');
}

export function isForbiddenTuningTarget(targetKey: string): boolean {
  const raw = targetKey.trim();
  if (!raw) return true;
  const norm = normalizeKey(raw);
  for (const t of SHADOW_REC_FORBIDDEN_TARGETS) {
    if (norm === t || norm.includes(t)) return true;
  }
  for (const re of FORBIDDEN_TARGET_PATTERNS) {
    if (re.test(raw) || re.test(norm)) return true;
  }
  return false;
}

export function classifyRecommendationRisk(input: {
  readonly targetKey: string;
  readonly recommendationKind?: ShadowRecommendationKind;
}): ShadowRiskClass {
  const key = input.targetKey.trim();
  if (!key || isForbiddenTuningTarget(key)) return 'high';
  for (const re of HIGH_RISK_PATTERNS) {
    if (re.test(key)) return 'high';
  }
  for (const re of MEDIUM_RISK_PATTERNS) {
    if (re.test(key)) return 'medium';
  }
  for (const re of LOW_RISK_PATTERNS) {
    if (re.test(key)) return 'low';
  }
  // Unknown targets stay medium (proposal-only) — never auto low.
  if (input.recommendationKind === 'decomposition') return 'medium';
  return 'medium';
}

// ---------------------------------------------------------------------------
// Contract helpers
// ---------------------------------------------------------------------------

export function shadowRecMode(): typeof SHADOW_REC_MODE {
  return SHADOW_REC_MODE;
}

export function shadowRecLiveTuningEnabled(): false {
  return false;
}

export function shadowRecMayMutateRuntime(): false {
  return false;
}

export function shadowRecMayEnableLiveTuning(): false {
  return false;
}

export function shadowRecMayMutateCoreSafety(): false {
  return false;
}

export function shadowRecAuthorizes(_action: ShadowRecForbiddenAction | string): false {
  return false;
}

// ---------------------------------------------------------------------------
// Ids / validation helpers
// ---------------------------------------------------------------------------

function boundMsg(text: string): string {
  const one = text.split(/\s+/).join(' ').trim();
  if (one.length <= MAX_SHADOW_REC_TEXT_LEN) return one;
  return one.slice(0, MAX_SHADOW_REC_TEXT_LEN - 1) + '...';
}

function pushError(
  errors: ShadowRecValidationIssue[],
  code: ShadowRecValidationCode,
  message: string,
): void {
  if (errors.length >= MAX_SHADOW_REC_VALIDATION_ERRORS) return;
  errors.push({ code, message: boundMsg(message) });
}

function isSafeId(value: string, max = MAX_SHADOW_REC_ID_LEN): boolean {
  return value.length > 0 && value.length <= max && isValidIdentifier(value);
}

function isRecordId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SHADOW_REC_ID_LEN &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
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

function isNonEmptyBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function isShadowRecKind(v: unknown): v is ShadowRecommendationKind {
  return typeof v === 'string' && (SHADOW_REC_KINDS as readonly string[]).includes(v);
}

function isShadowRisk(v: unknown): v is ShadowRiskClass {
  return typeof v === 'string' && (SHADOW_REC_RISK_CLASSES as readonly string[]).includes(v);
}

function isComparisonMetric(v: unknown): v is ShadowComparisonMetric {
  return typeof v === 'string' && (SHADOW_COMPARISON_METRICS as readonly string[]).includes(v);
}

function isBoundDirection(v: unknown): v is BoundDirection {
  return v === 'increase' || v === 'decrease' || v === 'either';
}

export function makeShadowRecommendationId(input: {
  readonly kind: ShadowRecommendationKind;
  readonly repoKey: string;
  readonly taskClass: string;
  readonly targetKey: string;
  readonly observedAtMs: number;
}): string {
  const material = [
    input.kind,
    input.repoKey,
    input.taskClass,
    normalizeKey(input.targetKey),
    String(Math.trunc(input.observedAtMs)),
  ].join('\0');
  return `srec-${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}

export function makeShadowComparisonId(input: {
  readonly recommendationId: string;
  readonly windowId: string;
  readonly observedAtMs: number;
}): string {
  const material = [
    input.recommendationId,
    input.windowId,
    String(Math.trunc(input.observedAtMs)),
  ].join('\0');
  return `scmp-${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}

export function makeBoundedTuningId(input: {
  readonly recommendationId: string;
  readonly observedAtMs: number;
}): string {
  const material = [
    'btune',
    input.recommendationId,
    String(Math.trunc(input.observedAtMs)),
  ].join('\0');
  return `btune-${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}

export function makeHumanTaskProposalId(input: {
  readonly recommendationId: string;
  readonly observedAtMs: number;
}): string {
  const material = [
    'htask',
    input.recommendationId,
    String(Math.trunc(input.observedAtMs)),
  ].join('\0');
  return `htask-${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}

function validateEvidenceDigests(
  raw: unknown,
  errors: ShadowRecValidationIssue[],
  opts: { readonly requireNonEmpty: boolean },
): readonly string[] | null {
  if (!Array.isArray(raw)) {
    pushError(errors, 'schema', 'evidenceDigests must be an array');
    return null;
  }
  if (raw.length > MAX_SHADOW_REC_EVIDENCE) {
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

function redactSummary(raw: string): string {
  const one = raw.split(/\s+/).join(' ').trim();
  // Strip credential-shaped fragments.
  const cleaned = one
    .replace(
      /(?:\b(?:token|password|passwd|secret|api[_-]?key|authorization|bearer)\b\s*[:=]\s*\S+)/gi,
      '[redacted]',
    )
    .replace(/\b(?:sk|xai|ghp)[-_][A-Za-z0-9_-]{8,}\b/gi, '[redacted]');
  if (cleaned.length <= MAX_SHADOW_REC_SUMMARY_LEN) return cleaned;
  return cleaned.slice(0, MAX_SHADOW_REC_SUMMARY_LEN - 1) + '...';
}

// ---------------------------------------------------------------------------
// Shadow recommendation build / validate
// ---------------------------------------------------------------------------

export function validateShadowRecommendation(input: unknown): ShadowRecommendationBuildResult {
  const errors: ShadowRecValidationIssue[] = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    pushError(errors, 'schema', 'recommendation must be an object');
    return { ok: false, errors };
  }
  const r = input as Record<string, unknown>;
  if (r['kind'] !== 'shadow_recommendation') {
    pushError(errors, 'invalid_kind', 'kind must be shadow_recommendation');
  }
  if (r['version'] !== SHADOW_REC_SCHEMA_VERSION) {
    pushError(errors, 'schema', 'unsupported schema version');
  }
  if (r['mode'] !== SHADOW_REC_MODE) {
    pushError(errors, 'schema', 'mode must be shadow');
  }
  if (r['liveTuningEnabled'] !== false) {
    pushError(errors, 'live_tuning_forbidden', 'liveTuningEnabled must be false');
  }
  if (r['mutatesRuntime'] !== false) {
    pushError(errors, 'live_tuning_forbidden', 'mutatesRuntime must be false');
  }
  if (typeof r['id'] !== 'string' || !isRecordId(r['id'])) {
    pushError(errors, 'invalid_identifier', 'recommendation id invalid');
  }
  if (typeof r['repoKey'] !== 'string' || !isSafeId(r['repoKey'])) {
    pushError(errors, 'invalid_identifier', 'repoKey invalid');
  }
  if (!isNonEmptyBoundedText(r['taskClass'], MAX_SHADOW_REC_TEXT_LEN)) {
    pushError(errors, 'schema', 'taskClass invalid');
  }
  if (typeof r['cohortKey'] !== 'string' || !/^cohort-[0-9a-f]{16,64}$/i.test(r['cohortKey'])) {
    pushError(errors, 'schema', 'cohortKey invalid');
  }
  if (!isShadowRecKind(r['recommendationKind'])) {
    pushError(errors, 'invalid_kind', 'recommendationKind invalid');
  }
  if (!isShadowRisk(r['riskClass'])) {
    pushError(errors, 'invalid_risk', 'riskClass invalid');
  }
  if (typeof r['targetKey'] !== 'string' || !isNonEmptyBoundedText(r['targetKey'], 128)) {
    pushError(errors, 'invalid_identifier', 'targetKey invalid');
  } else if (isForbiddenTuningTarget(r['targetKey'])) {
    // Forbidden targets may only exist as high-risk shadow proposals that
    // route to human tasks — never as low/medium forgeable tuning keys.
    if (r['riskClass'] !== 'high') {
      pushError(errors, 'forbidden_target', 'forbidden target requires high risk');
    }
  }
  if (!isFiniteNonNegInt(r['observedAtMs'])) {
    pushError(errors, 'schema', 'observedAtMs must be non-negative integer');
  }
  if (!isNonEmptyBoundedText(r['summary'], MAX_SHADOW_REC_SUMMARY_LEN)) {
    pushError(errors, 'unbounded', 'summary missing or too long');
  }

  // Risk class must match classifier (no forging low for high targets).
  if (typeof r['targetKey'] === 'string' && isShadowRisk(r['riskClass'])) {
    const expected = isShadowRecKind(r['recommendationKind'])
      ? classifyRecommendationRisk({
          targetKey: r['targetKey'],
          recommendationKind: r['recommendationKind'],
        })
      : classifyRecommendationRisk({ targetKey: r['targetKey'] });
    if (r['riskClass'] !== expected) {
      pushError(
        errors,
        'risk_mismatch',
        `riskClass ${r['riskClass']} does not match classified ${expected}`,
      );
    }
  }

  const evidenceDigests = validateEvidenceDigests(r['evidenceDigests'], errors, {
    requireNonEmpty: true,
  });

  if (errors.length > 0 || !evidenceDigests) {
    return { ok: false, errors };
  }

  const recommendation: ShadowRecommendation = {
    id: r['id'] as string,
    kind: 'shadow_recommendation',
    version: SHADOW_REC_SCHEMA_VERSION,
    mode: SHADOW_REC_MODE,
    recommendationKind: r['recommendationKind'] as ShadowRecommendationKind,
    riskClass: r['riskClass'] as ShadowRiskClass,
    repoKey: r['repoKey'] as string,
    taskClass: (r['taskClass'] as string).trim(),
    cohortKey: r['cohortKey'] as string,
    targetKey: normalizeKey(r['targetKey'] as string),
    summary: redactSummary(r['summary'] as string),
    evidenceDigests,
    observedAtMs: r['observedAtMs'] as number,
    liveTuningEnabled: false,
    mutatesRuntime: false,
  };
  return { ok: true, recommendation };
}

export function buildShadowRecommendation(input: {
  readonly recommendationKind: ShadowRecommendationKind;
  readonly repoKey: string;
  readonly taskClass: string;
  readonly targetKey: string;
  readonly summary: string;
  readonly evidenceDigests: readonly string[];
  readonly observedAtMs: number;
  readonly id?: string;
  readonly cohortKey?: string;
}): ShadowRecommendationBuildResult {
  const riskClass = classifyRecommendationRisk({
    targetKey: input.targetKey,
    recommendationKind: input.recommendationKind,
  });
  const cohortKey =
    input.cohortKey ??
    makeCohortKey({
      repoKey: input.repoKey,
      taskClass: input.taskClass,
      metricKind: 'completion',
    });
  const id =
    input.id ??
    makeShadowRecommendationId({
      kind: input.recommendationKind,
      repoKey: input.repoKey,
      taskClass: input.taskClass,
      targetKey: input.targetKey,
      observedAtMs: input.observedAtMs,
    });
  return validateShadowRecommendation({
    id,
    kind: 'shadow_recommendation',
    version: SHADOW_REC_SCHEMA_VERSION,
    mode: SHADOW_REC_MODE,
    recommendationKind: input.recommendationKind,
    riskClass,
    repoKey: input.repoKey,
    taskClass: input.taskClass,
    cohortKey,
    targetKey: input.targetKey,
    summary: input.summary,
    evidenceDigests: input.evidenceDigests,
    observedAtMs: input.observedAtMs,
    liveTuningEnabled: false,
    mutatesRuntime: false,
  });
}

// ---------------------------------------------------------------------------
// Cohort comparison
// ---------------------------------------------------------------------------

function validateCohortMetrics(
  raw: unknown,
  errors: ShadowRecValidationIssue[],
  label: string,
): ShadowCohortMetrics | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    pushError(errors, 'schema', `${label} metrics must be an object`);
    return null;
  }
  const m = raw as Record<string, unknown>;
  const fields = ['success', 'guardrails', 'rework', 'cost', 'humanBurden'] as const;
  for (const f of fields) {
    if (!isFiniteNumber(m[f]) || (m[f] as number) < 0) {
      pushError(errors, 'schema', `${label}.${f} must be finite non-negative`);
      return null;
    }
  }
  if (!isFiniteNonNegInt(m['sampleCount'])) {
    pushError(errors, 'schema', `${label}.sampleCount must be non-negative integer`);
    return null;
  }
  if (!isFiniteNonNegInt(m['unknownCount'])) {
    pushError(errors, 'schema', `${label}.unknownCount must be non-negative integer`);
    return null;
  }
  return {
    success: m['success'] as number,
    guardrails: m['guardrails'] as number,
    rework: m['rework'] as number,
    cost: m['cost'] as number,
    humanBurden: m['humanBurden'] as number,
    sampleCount: m['sampleCount'] as number,
    unknownCount: m['unknownCount'] as number,
  };
}

function metricDelta(
  baseline: number,
  candidate: number,
  polarity: 'higher_better' | 'lower_better',
  eps: number,
): MetricDelta {
  const delta = candidate - baseline;
  if (polarity === 'higher_better') {
    return {
      baseline,
      candidate,
      delta,
      improved: delta > eps,
      worsened: delta < -eps,
    };
  }
  return {
    baseline,
    candidate,
    delta,
    improved: delta < -eps,
    worsened: delta > eps,
  };
}

export function compareShadowAgainstCohort(input: {
  readonly recommendation: ShadowRecommendation;
  readonly baseline: ShadowCohortMetrics;
  readonly candidate: ShadowCohortMetrics;
  readonly windowId: string;
  readonly observedAtMs: number;
}): ShadowComparisonBuildResult {
  const errors: ShadowRecValidationIssue[] = [];
  const recResult = validateShadowRecommendation(input.recommendation);
  if (!recResult.ok) return { ok: false, errors: recResult.errors };

  if (!isNonEmptyBoundedText(input.windowId, 128) || !/^[A-Za-z0-9._-]+$/.test(input.windowId)) {
    pushError(errors, 'invalid_identifier', 'windowId invalid');
  }
  if (!isFiniteNonNegInt(input.observedAtMs)) {
    pushError(errors, 'schema', 'observedAtMs must be non-negative integer');
  }

  const baseline = validateCohortMetrics(input.baseline, errors, 'baseline');
  const candidate = validateCohortMetrics(input.candidate, errors, 'candidate');
  if (errors.length > 0 || !baseline || !candidate) {
    return { ok: false, errors };
  }

  const metrics: ShadowComparisonMetrics = {
    success: metricDelta(baseline.success, candidate.success, 'higher_better', SUCCESS_BENEFIT_EPS),
    guardrails: metricDelta(
      baseline.guardrails,
      candidate.guardrails,
      'higher_better',
      GUARDRAIL_REGRESSION_EPS,
    ),
    rework: metricDelta(baseline.rework, candidate.rework, 'lower_better', BURDEN_REGRESSION_EPS),
    cost: metricDelta(baseline.cost, candidate.cost, 'lower_better', BURDEN_REGRESSION_EPS),
    human_burden: metricDelta(
      baseline.humanBurden,
      candidate.humanBurden,
      'lower_better',
      BURDEN_REGRESSION_EPS,
    ),
  };

  const thin =
    baseline.sampleCount < MIN_COHORT_SAMPLES || candidate.sampleCount < MIN_COHORT_SAMPLES;
  const guardrailBreach = metrics.guardrails.worsened;
  const burdenWorsened =
    metrics.rework.worsened || metrics.cost.worsened || metrics.human_burden.worsened;

  let verdict: ShadowComparisonVerdict;
  let measuredBenefit = false;
  if (thin) {
    verdict = 'insufficient_evidence';
  } else if (guardrailBreach || burdenWorsened) {
    verdict = 'regression';
  } else if (metrics.success.improved && !metrics.guardrails.worsened) {
    verdict = 'benefit';
    measuredBenefit = true;
  } else {
    verdict = 'neutral';
  }

  const comparison: ShadowComparisonResult = {
    id: makeShadowComparisonId({
      recommendationId: recResult.recommendation.id,
      windowId: input.windowId,
      observedAtMs: input.observedAtMs,
    }),
    kind: 'shadow_comparison',
    mode: SHADOW_REC_MODE,
    recommendationId: recResult.recommendation.id,
    recommendationKind: recResult.recommendation.recommendationKind,
    cohortKey: recResult.recommendation.cohortKey,
    windowId: input.windowId,
    metrics,
    verdict,
    measuredBenefit,
    guardrailBreach,
    appliesLiveTuning: false,
    observedAtMs: input.observedAtMs,
  };
  return { ok: true, comparison };
}

export function evaluateRepeatedMeasuredBenefit(input: {
  readonly comparisons: readonly ShadowComparisonResult[];
}): RepeatedBenefitEvaluation {
  const benefitCount = input.comparisons.filter((c) => c.measuredBenefit && c.verdict === 'benefit')
    .length;
  return {
    benefitCount,
    repeatedBenefit: benefitCount >= MIN_REPEATED_MEASURED_BENEFIT,
    minRequired: MIN_REPEATED_MEASURED_BENEFIT,
  };
}

// ---------------------------------------------------------------------------
// Disposition
// ---------------------------------------------------------------------------

export function disposeShadowRecommendation(input: {
  readonly recommendation: ShadowRecommendation;
  readonly comparisons: readonly ShadowComparisonResult[];
}): ShadowDispositionResult {
  const riskClass = input.recommendation.riskClass;
  const repeated = evaluateRepeatedMeasuredBenefit({ comparisons: input.comparisons });
  const reasons: string[] = [];

  if (riskClass === 'high' || isForbiddenTuningTarget(input.recommendation.targetKey)) {
    reasons.push('high-risk or protected target requires evidence-backed human task');
    return {
      disposition: 'human_task_only',
      riskClass: 'high',
      mayBuildBoundedTuning: false,
      requiresHumanTask: true,
      liveTuningEnabled: false,
      repeatedBenefit: repeated.repeatedBenefit,
      benefitCount: repeated.benefitCount,
      reasons,
    };
  }

  if (riskClass === 'medium') {
    reasons.push('medium-risk remains a shadow-mode proposal only');
    return {
      disposition: 'proposal_only',
      riskClass: 'medium',
      mayBuildBoundedTuning: false,
      requiresHumanTask: false,
      liveTuningEnabled: false,
      repeatedBenefit: repeated.repeatedBenefit,
      benefitCount: repeated.benefitCount,
      reasons,
    };
  }

  // low risk
  if (!repeated.repeatedBenefit) {
    reasons.push(
      `need ${MIN_REPEATED_MEASURED_BENEFIT} benefit windows; have ${repeated.benefitCount}`,
    );
    return {
      disposition: 'shadow_continue',
      riskClass: 'low',
      mayBuildBoundedTuning: false,
      requiresHumanTask: false,
      liveTuningEnabled: false,
      repeatedBenefit: false,
      benefitCount: repeated.benefitCount,
      reasons,
    };
  }

  reasons.push('low-risk with repeated measured benefit; bounded tuning eligible (not live)');
  return {
    disposition: 'bounded_tuning_eligible',
    riskClass: 'low',
    mayBuildBoundedTuning: true,
    requiresHumanTask: false,
    liveTuningEnabled: false,
    repeatedBenefit: true,
    benefitCount: repeated.benefitCount,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Bounded tuning
// ---------------------------------------------------------------------------

function validateMetricList(
  raw: unknown,
  errors: ShadowRecValidationIssue[],
  label: string,
): readonly ShadowComparisonMetric[] | null {
  if (!Array.isArray(raw)) {
    pushError(errors, 'missing_metrics', `${label} must be an array`);
    return null;
  }
  if (raw.length === 0) {
    pushError(errors, 'missing_metrics', `${label} required`);
    return null;
  }
  if (raw.length > SHADOW_COMPARISON_METRICS.length) {
    pushError(errors, 'unbounded', `${label} exceed bound`);
    return null;
  }
  const out: ShadowComparisonMetric[] = [];
  for (const m of raw) {
    if (!isComparisonMetric(m)) {
      pushError(errors, 'missing_metrics', `${label} contains invalid metric`);
      return null;
    }
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

function validateBound(
  raw: unknown,
  errors: ShadowRecValidationIssue[],
): TuningBound | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    pushError(errors, 'missing_bound', 'bound must be an object');
    return null;
  }
  const b = raw as Record<string, unknown>;
  if (!isNonEmptyBoundedText(b['parameter'], 128)) {
    pushError(errors, 'missing_bound', 'bound.parameter required');
    return null;
  }
  if (!isFiniteNumber(b['maxDelta']) || (b['maxDelta'] as number) <= 0) {
    pushError(errors, 'missing_bound', 'bound.maxDelta must be positive finite');
    return null;
  }
  if (!isNonEmptyBoundedText(b['unit'], 64)) {
    pushError(errors, 'missing_bound', 'bound.unit required');
    return null;
  }
  if (!isBoundDirection(b['direction'])) {
    pushError(errors, 'missing_bound', 'bound.direction invalid');
    return null;
  }
  if (isForbiddenTuningTarget(b['parameter'] as string)) {
    pushError(errors, 'forbidden_target', 'bound.parameter is a forbidden target');
    return null;
  }
  return {
    parameter: normalizeKey(b['parameter'] as string),
    maxDelta: b['maxDelta'] as number,
    unit: (b['unit'] as string).trim(),
    direction: b['direction'] as BoundDirection,
  };
}

function validateRollback(
  raw: unknown,
  errors: ShadowRecValidationIssue[],
): TuningRollback | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    pushError(errors, 'missing_rollback', 'rollback must be an object');
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (r['strategy'] !== 'restore_prior_value') {
    pushError(errors, 'missing_rollback', 'rollback.strategy must be restore_prior_value');
    return null;
  }
  if (typeof r['priorValueDigest'] !== 'string' || !isShaLike(r['priorValueDigest'])) {
    pushError(errors, 'missing_rollback', 'rollback.priorValueDigest must be hex digest');
    return null;
  }
  return {
    strategy: 'restore_prior_value',
    priorValueDigest: (r['priorValueDigest'] as string).toLowerCase(),
  };
}

export function validateBoundedTuningSpec(input: unknown): BoundedTuningBuildResult {
  const errors: ShadowRecValidationIssue[] = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    pushError(errors, 'schema', 'tuning spec must be an object');
    return { ok: false, errors };
  }
  const r = input as Record<string, unknown>;
  if (r['kind'] !== 'bounded_tuning_spec') {
    pushError(errors, 'invalid_kind', 'kind must be bounded_tuning_spec');
  }
  if (typeof r['id'] !== 'string' || !isRecordId(r['id'])) {
    pushError(errors, 'invalid_identifier', 'tuning id invalid');
  }
  if (typeof r['recommendationId'] !== 'string' || !isRecordId(r['recommendationId'])) {
    pushError(errors, 'invalid_identifier', 'recommendationId invalid');
  }
  if (typeof r['targetKey'] !== 'string' || !isNonEmptyBoundedText(r['targetKey'], 128)) {
    pushError(errors, 'invalid_identifier', 'targetKey invalid');
  } else if (isForbiddenTuningTarget(r['targetKey'])) {
    pushError(errors, 'forbidden_target', 'targetKey is forbidden for bounded tuning');
  } else if (classifyRecommendationRisk({ targetKey: r['targetKey'] }) !== 'low') {
    pushError(errors, 'risk_mismatch', 'bounded tuning only for low-risk targets');
  }
  if (typeof r['owner'] !== 'string' || r['owner'].trim().length === 0) {
    pushError(errors, 'missing_owner', 'owner required');
  } else if (!/^[A-Za-z0-9._@-]{1,128}$/.test(r['owner'].trim())) {
    pushError(errors, 'missing_owner', 'owner identifier invalid');
  }
  if (!isFiniteNonNegInt(r['observedAtMs'])) {
    pushError(errors, 'schema', 'observedAtMs must be non-negative integer');
  }
  if (!isFiniteNonNegInt(r['expiryMs'])) {
    pushError(errors, 'missing_expiry', 'expiryMs required');
  } else if (
    isFiniteNonNegInt(r['observedAtMs']) &&
    (r['expiryMs'] as number) <= (r['observedAtMs'] as number)
  ) {
    pushError(errors, 'missing_expiry', 'expiryMs must be after observedAtMs');
  }
  if (r['liveEnabled'] !== false) {
    pushError(errors, 'live_tuning_forbidden', 'liveEnabled must be false without separate policy');
  }
  if (r['requiresSeparatePolicyApproval'] !== true) {
    pushError(errors, 'live_tuning_forbidden', 'requiresSeparatePolicyApproval must be true');
  }
  if (r['applied'] !== false) {
    pushError(errors, 'applied_forbidden', 'applied must be false; this module never applies');
  }

  const bound = validateBound(r['bound'], errors);
  const rollback = validateRollback(r['rollback'], errors);
  const successMetrics = validateMetricList(r['successMetrics'], errors, 'successMetrics');
  const guardrailMetrics = validateMetricList(r['guardrailMetrics'], errors, 'guardrailMetrics');

  if (errors.length > 0 || !bound || !rollback || !successMetrics || !guardrailMetrics) {
    return { ok: false, errors };
  }

  const owner = (r['owner'] as string).trim();
  const spec: BoundedTuningSpec = {
    id: r['id'] as string,
    kind: 'bounded_tuning_spec',
    recommendationId: r['recommendationId'] as string,
    targetKey: normalizeKey(r['targetKey'] as string),
    owner,
    bound,
    rollback,
    expiryMs: r['expiryMs'] as number,
    successMetrics,
    guardrailMetrics,
    liveEnabled: false,
    requiresSeparatePolicyApproval: true,
    applied: false,
    observedAtMs: r['observedAtMs'] as number,
  };
  return { ok: true, spec };
}

export function buildBoundedTuningSpec(input: {
  readonly recommendationId: string;
  readonly targetKey: string;
  readonly owner: string;
  readonly bound: TuningBound;
  readonly rollback: TuningRollback;
  readonly expiryMs: number;
  readonly successMetrics: readonly ShadowComparisonMetric[];
  readonly guardrailMetrics: readonly ShadowComparisonMetric[];
  readonly observedAtMs: number;
  readonly id?: string;
}): BoundedTuningBuildResult {
  const id =
    input.id ??
    makeBoundedTuningId({
      recommendationId: input.recommendationId,
      observedAtMs: input.observedAtMs,
    });
  return validateBoundedTuningSpec({
    id,
    kind: 'bounded_tuning_spec',
    recommendationId: input.recommendationId,
    targetKey: input.targetKey,
    owner: input.owner,
    bound: input.bound,
    rollback: input.rollback,
    expiryMs: input.expiryMs,
    successMetrics: input.successMetrics,
    guardrailMetrics: input.guardrailMetrics,
    liveEnabled: false,
    requiresSeparatePolicyApproval: true,
    applied: false,
    observedAtMs: input.observedAtMs,
  });
}

export function tryBuildBoundedTuningFromDisposition(input: {
  readonly recommendation: ShadowRecommendation;
  readonly comparisons: readonly ShadowComparisonResult[];
  readonly owner: string;
  readonly bound: TuningBound;
  readonly rollback: TuningRollback;
  readonly expiryMs: number;
  readonly successMetrics: readonly ShadowComparisonMetric[];
  readonly guardrailMetrics: readonly ShadowComparisonMetric[];
  readonly observedAtMs: number;
}): BoundedTuningFromDispositionResult {
  const disposition = disposeShadowRecommendation({
    recommendation: input.recommendation,
    comparisons: input.comparisons,
  });
  if (!disposition.mayBuildBoundedTuning || disposition.disposition !== 'bounded_tuning_eligible') {
    return {
      ok: false,
      errors: [
        {
          code: 'not_eligible',
          message: `disposition ${disposition.disposition} is not bounded_tuning_eligible`,
        },
      ],
    };
  }
  const built = buildBoundedTuningSpec({
    recommendationId: input.recommendation.id,
    targetKey: input.recommendation.targetKey,
    owner: input.owner,
    bound: input.bound,
    rollback: input.rollback,
    expiryMs: input.expiryMs,
    successMetrics: input.successMetrics,
    guardrailMetrics: input.guardrailMetrics,
    observedAtMs: input.observedAtMs,
  });
  if (!built.ok) return built;
  return { ok: true, spec: built.spec, liveTuningEnabled: false };
}

export function buildHighRiskHumanTaskProposal(input: {
  readonly recommendation: ShadowRecommendation;
  readonly observedAtMs: number;
}): HumanTaskBuildResult {
  const recResult = validateShadowRecommendation(input.recommendation);
  if (!recResult.ok) return { ok: false, errors: recResult.errors };
  const rec = recResult.recommendation;
  if (rec.riskClass !== 'high' && !isForbiddenTuningTarget(rec.targetKey)) {
    return {
      ok: false,
      errors: [
        {
          code: 'risk_mismatch',
          message: 'human task proposals are for high-risk recommendations',
        },
      ],
    };
  }
  if (!isFiniteNonNegInt(input.observedAtMs)) {
    return {
      ok: false,
      errors: [{ code: 'schema', message: 'observedAtMs must be non-negative integer' }],
    };
  }
  const title = boundMsg(
    `Human review: high-risk ${rec.targetKey} (${rec.recommendationKind}) — permission/security boundary`,
  );
  const body = redactSummary(
    [
      `Shadow recommendation \`${rec.id}\` targets \`${rec.targetKey}\`.`,
      'This change is high-risk and must not auto-apply.',
      `Summary: ${rec.summary}`,
      'Create an evidence-backed human task; never alter core safety, evidence, merge, deploy, or production boundaries automatically.',
    ].join(' '),
  );
  const proposal: HighRiskHumanTaskProposal = {
    id: makeHumanTaskProposalId({
      recommendationId: rec.id,
      observedAtMs: input.observedAtMs,
    }),
    kind: 'human_task_proposal',
    recommendationId: rec.id,
    targetKey: rec.targetKey,
    title,
    body,
    evidenceDigests: rec.evidenceDigests,
    autoApply: false,
    riskClass: 'high',
    observedAtMs: input.observedAtMs,
  };
  return { ok: true, proposal };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function emptyShadowRecommendationStore(): ShadowRecommendationStore {
  return {
    version: SHADOW_REC_SCHEMA_VERSION,
    mode: SHADOW_REC_MODE,
    liveTuningEnabled: false,
    recommendations: [],
    comparisons: [],
    tuningSpecs: [],
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function appendShadowComparison(
  store: ShadowRecommendationStore,
  input: {
    readonly recommendation: ShadowRecommendation;
    readonly comparison: ShadowComparisonResult;
  },
): AppendShadowResult {
  if (store.liveTuningEnabled !== false || store.mode !== SHADOW_REC_MODE) {
    return { store, applied: false, conflict: true };
  }
  const recV = validateShadowRecommendation(input.recommendation);
  if (!recV.ok) return { store, applied: false, conflict: true };
  if (input.comparison.appliesLiveTuning !== false || input.comparison.mode !== SHADOW_REC_MODE) {
    return { store, applied: false, conflict: true };
  }
  if (input.comparison.recommendationId !== recV.recommendation.id) {
    return { store, applied: false, conflict: true };
  }
  if (
    store.recommendations.length >= MAX_SHADOW_REC_STORE_ITEMS ||
    store.comparisons.length >= MAX_SHADOW_REC_STORE_ITEMS
  ) {
    return { store, applied: false, conflict: true };
  }

  let recommendations = store.recommendations;
  const existingRec = recommendations.find((r) => r.id === recV.recommendation.id);
  if (existingRec) {
    if (!sameJson(existingRec, recV.recommendation)) {
      return { store, applied: false, conflict: true };
    }
  } else {
    recommendations = [...recommendations, recV.recommendation];
  }

  const existingCmp = store.comparisons.find((c) => c.id === input.comparison.id);
  if (existingCmp) {
    if (sameJson(existingCmp, input.comparison)) {
      return { store, applied: false, conflict: false };
    }
    return { store, applied: false, conflict: true };
  }

  return {
    store: {
      version: SHADOW_REC_SCHEMA_VERSION,
      mode: SHADOW_REC_MODE,
      liveTuningEnabled: false,
      recommendations,
      comparisons: [...store.comparisons, input.comparison],
      tuningSpecs: store.tuningSpecs,
    },
    applied: true,
    conflict: false,
  };
}

export function serializeShadowRecommendationStore(store: ShadowRecommendationStore): string {
  if (store.liveTuningEnabled !== false) {
    throw new ShadowRecommendationTuningError('store claims live tuning', [
      { code: 'live_tuning_forbidden', message: 'liveTuningEnabled must be false' },
    ]);
  }
  for (const rec of store.recommendations) {
    const v = validateShadowRecommendation(rec);
    if (!v.ok) {
      throw new ShadowRecommendationTuningError(
        v.errors[0]?.message ?? 'invalid recommendation',
        v.errors,
      );
    }
  }
  for (const spec of store.tuningSpecs) {
    const v = validateBoundedTuningSpec(spec);
    if (!v.ok) {
      throw new ShadowRecommendationTuningError(
        v.errors[0]?.message ?? 'invalid tuning spec',
        v.errors,
      );
    }
  }
  const doc = {
    version: SHADOW_REC_SCHEMA_VERSION,
    mode: SHADOW_REC_MODE,
    liveTuningEnabled: false as const,
    recommendations: store.recommendations,
    comparisons: store.comparisons,
    tuningSpecs: store.tuningSpecs,
  };
  const json = JSON.stringify(doc);
  if (json.length > MAX_SHADOW_REC_BYTES) {
    throw new ShadowRecommendationTuningError('store exceeds byte bound', [
      { code: 'unbounded', message: 'store exceeds byte bound' },
    ]);
  }
  return json;
}

export function parseShadowRecommendationStore(raw: string): ShadowStoreParseResult {
  const errors: ShadowRecValidationIssue[] = [];
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
  if (d['version'] !== SHADOW_REC_SCHEMA_VERSION) {
    pushError(errors, 'schema', 'unsupported schema version');
  }
  if (d['mode'] !== SHADOW_REC_MODE) {
    pushError(errors, 'schema', 'mode must be shadow');
  }
  if (d['liveTuningEnabled'] !== false) {
    pushError(errors, 'live_tuning_forbidden', 'liveTuningEnabled must be false');
  }
  if (
    !Array.isArray(d['recommendations']) ||
    !Array.isArray(d['comparisons']) ||
    !Array.isArray(d['tuningSpecs'])
  ) {
    pushError(errors, 'schema', 'recommendations, comparisons, tuningSpecs must be arrays');
    return { ok: false, errors };
  }
  if (
    d['recommendations'].length > MAX_SHADOW_REC_STORE_ITEMS ||
    d['comparisons'].length > MAX_SHADOW_REC_STORE_ITEMS ||
    d['tuningSpecs'].length > MAX_SHADOW_REC_STORE_ITEMS
  ) {
    pushError(errors, 'unbounded', 'store collections exceed bound');
  }
  if (errors.length > 0) return { ok: false, errors };

  const recommendations: ShadowRecommendation[] = [];
  for (const item of d['recommendations']) {
    const v = validateShadowRecommendation(item);
    if (!v.ok) return { ok: false, errors: v.errors };
    recommendations.push(v.recommendation);
  }

  const comparisons: ShadowComparisonResult[] = [];
  for (const item of d['comparisons']) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return {
        ok: false,
        errors: [{ code: 'schema', message: 'comparison must be an object' }],
      };
    }
    const c = item as Record<string, unknown>;
    if (c['kind'] !== 'shadow_comparison' || c['mode'] !== SHADOW_REC_MODE) {
      return {
        ok: false,
        errors: [{ code: 'schema', message: 'comparison kind/mode invalid' }],
      };
    }
    if (c['appliesLiveTuning'] !== false) {
      return {
        ok: false,
        errors: [
          {
            code: 'live_tuning_forbidden',
            message: 'comparison appliesLiveTuning must be false',
          },
        ],
      };
    }
    comparisons.push(item as ShadowComparisonResult);
  }

  const tuningSpecs: BoundedTuningSpec[] = [];
  for (const item of d['tuningSpecs']) {
    const v = validateBoundedTuningSpec(item);
    if (!v.ok) return { ok: false, errors: v.errors };
    tuningSpecs.push(v.spec);
  }

  return {
    ok: true,
    store: {
      version: SHADOW_REC_SCHEMA_VERSION,
      mode: SHADOW_REC_MODE,
      liveTuningEnabled: false,
      recommendations,
      comparisons,
      tuningSpecs,
    },
  };
}
