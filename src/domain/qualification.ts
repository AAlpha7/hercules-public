/**
 * M13 qualification domain records.
 *
 * Slice 1: closed corpus/adversarial/metrics/package/inventory records,
 * validators, hashing, and the two pure control-side decisions. Harnesses
 * and fixtures live in later slices under `src/qualification/`.
 */

import { canonicalSerialize, hashCanonicalJson } from './canonicalJson.js';
import { parseGithubPrUrl } from './prIdentity.js';
import { type M6OutcomeDecision } from './reviewPackageV2.js';
import { isValidIdentifier } from './task.js';
import { isCanonicalTimestamp } from './workerBoundary.js';

// ---------------------------------------------------------------------------
// Fail-closed error class
// ---------------------------------------------------------------------------

/** Assembly precondition reasons thrown by assembleFinalReviewPackage (exactly 5). */
export const QUALIFICATION_PRECONDITION_REASONS = [
  'held_out_case_invalid',
  'adversarial_coverage_incomplete',
  'mobile_web_properties_incomplete',
  'metrics_binding_mismatch',
  'remaining_gate_mismatch',
] as const;

export type QualificationPreconditionReason =
  (typeof QUALIFICATION_PRECONDITION_REASONS)[number];

export type QualificationErrorCode =
  | 'invalid_input_schema'
  | QualificationPreconditionReason;

export class QualificationError extends Error {
  override readonly name = 'QualificationError';

  constructor(
    readonly code: QualificationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Closed unions / bounded constants
// ---------------------------------------------------------------------------

export const ADVERSARIAL_CASES = [
  'false_green',
  'stale_approval',
  'evidence_tamper',
  'restart_recovery',
  'duplicate_action',
  'reviewer_rejection',
  'missing_browser_environment',
  'human_criterion',
] as const;

export type AdversarialCaseV1 = (typeof ADVERSARIAL_CASES)[number];

export const ADVERSARIAL_EXPECTATIONS = [
  'refused',
  'excluded',
  'held_for_human',
  'no_effect',
] as const;

export type AdversarialExpectationV1 = (typeof ADVERSARIAL_EXPECTATIONS)[number];

export const ADVERSARIAL_ENGINES = [
  'm6_eligibility',
  'm8_evaluation',
  'm9_routing',
  'm11_admission',
  'm12_assembler',
] as const;

export type AdversarialEngineV1 = (typeof ADVERSARIAL_ENGINES)[number];

export const ADVERSARIAL_TAINT_KINDS = [
  'confident_self_report',
  'inference',
  'opinion',
  'missing_binding',
  'stale_binding',
  'contradictory_evidence',
  'tampering',
  'raw_prose',
] as const;

export type AdversarialTaintKindV1 = (typeof ADVERSARIAL_TAINT_KINDS)[number];

export const MOBILE_WEB_PROVED_PROPERTIES = [
  'criterion_evidence',
  'immutable_prior_iteration',
  'outcome_review',
  'refresh',
  'request_changes',
  'stale_rejection',
] as const;

export type MobileWebProvedPropertyV1 =
  (typeof MOBILE_WEB_PROVED_PROPERTIES)[number];

export const REMAINING_OWNER_GATE = 'controlled_database_authority_cutover' as const;
export type RemainingOwnerGateV1 = typeof REMAINING_OWNER_GATE;

export const TERMINAL_DISPOSITIONS = [
  'closed_scope_decision',
  'discharged_into_db_cutover_gate',
  'external_followup_ci_billing',
] as const;

export type TerminalDispositionV1 = (typeof TERMINAL_DISPOSITIONS)[number];

/**
 * Pinned closed case→engine→taintKind→expectation table (contract §Pure
 * control-side decisions). `missing_browser_environment` may be driven by
 * either M6 eligibility or the M12 assembler.
 */
export const ADVERSARIAL_CASE_TABLE: Readonly<
  Record<
    AdversarialCaseV1,
    {
      readonly taintKind: AdversarialTaintKindV1;
      readonly engines: readonly AdversarialEngineV1[];
      readonly expectation: AdversarialExpectationV1;
    }
  >
> = {
  false_green: {
    taintKind: 'confident_self_report',
    engines: ['m8_evaluation'],
    expectation: 'refused',
  },
  stale_approval: {
    taintKind: 'stale_binding',
    engines: ['m11_admission'],
    expectation: 'refused',
  },
  evidence_tamper: {
    taintKind: 'tampering',
    engines: ['m6_eligibility'],
    expectation: 'refused',
  },
  restart_recovery: {
    taintKind: 'raw_prose',
    engines: ['m11_admission'],
    expectation: 'no_effect',
  },
  duplicate_action: {
    taintKind: 'inference',
    engines: ['m11_admission'],
    expectation: 'no_effect',
  },
  reviewer_rejection: {
    taintKind: 'opinion',
    engines: ['m11_admission'],
    expectation: 'refused',
  },
  missing_browser_environment: {
    taintKind: 'missing_binding',
    engines: ['m6_eligibility', 'm12_assembler'],
    expectation: 'refused',
  },
  human_criterion: {
    taintKind: 'missing_binding',
    engines: ['m6_eligibility'],
    expectation: 'held_for_human',
  },
};

const M6_OUTCOME_DECISIONS = [
  'approve_outcome',
  'reject_outcome',
  'request_changes',
] as const satisfies readonly M6OutcomeDecision[];

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_REASON_BYTES = 1_024;
const MAX_ARRAY_ITEMS = 4_096;
const MAX_REMAINING_RISKS = 64;

// ---------------------------------------------------------------------------
// Records (verbatim from M13 closed-records contract)
// ---------------------------------------------------------------------------

export interface HeldOutCaseResultV1 {
  readonly caseId: string;
  readonly taskContractHash: string;
  readonly outcomeDecision: M6OutcomeDecision;
  readonly evidenceManifestHash: string;
  readonly resultHash: string;
}

export interface AdversarialCaseResultV1 {
  readonly case: AdversarialCaseV1;
  readonly expectation: AdversarialExpectationV1;
  readonly engine: AdversarialEngineV1;
  readonly refusalReason: string;
  readonly taintKind: string;
  readonly resultHash: string;
}

export interface MobileWebReviewResultV1 {
  readonly scenario: 'mobile_web_outcome_review';
  readonly browserProofHash: string;
  readonly provedProperties: readonly MobileWebProvedPropertyV1[];
  readonly resultHash: string;
}

export interface BeforeAfterMetricsV1 {
  readonly baselineCheckFullCommit: string;
  readonly qualifiedMainSha: string;
  readonly totalTests: number;
  readonly addedTests: number;
  readonly addedAdditiveModules: number;
  readonly remainingRisks: readonly string[];
  readonly metricsHash: string;
}

export interface FinalReviewPackageV1 {
  readonly schema: 'hercules-final-review-package/v1';
  readonly qualifiedMainSha: string;
  readonly heldOutSummaryHash: string;
  readonly adversarialSummaryHash: string;
  readonly mobileWebResultHash: string;
  readonly metrics: BeforeAfterMetricsV1;
  readonly remainingOwnerGate: RemainingOwnerGateV1;
  readonly packageHash: string;
}

export interface ResolvedOwnerDecisionV1 {
  readonly id: string;
  readonly decided_at: string;
  readonly scope: 'program';
  readonly decision: string;
  readonly terminal_disposition: TerminalDispositionV1;
}

export interface TerminalOpenPrIdentityV1 {
  readonly number: number;
  readonly url: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly state: 'OPEN';
}

export interface TerminalInventoryProjectionV1 {
  readonly schema: 'hercules-terminal-inventory-projection/v1';
  readonly sourceInventoryHash: string;
  readonly repository: 'example-org/acme';
  readonly queryScope: 'all-open-base-refs';
  readonly baseRefFilter: null;
  readonly defaultBranchHead: string;
  readonly expiresAt: string;
  readonly paginationComplete: true;
  readonly nextCursor: null;
  readonly serverTotalOpenCount: number;
  readonly finalServerTotalOpenCount: number;
  readonly totalOpenCount: number;
  readonly pullRequests: readonly TerminalOpenPrIdentityV1[];
  readonly projectionHash: string;
}

export interface TerminalInventoryVerdictV1 {
  readonly schema: 'hercules-terminal-inventory-verdict/v1';
  readonly outcome: 'pass' | 'fail';
  readonly resolvedMainSha: string;
  readonly totalOpenCount: number;
  readonly reason: string | null;
  readonly verdictHash: string;
}

/** Trusted inputs the pure final-package assembler binds. */
export interface AssembleFinalReviewPackageInputsV1 {
  readonly qualifiedMainSha: string;
  readonly heldOutResults: readonly HeldOutCaseResultV1[];
  readonly adversarialResults: readonly AdversarialCaseResultV1[];
  readonly mobileWebResult: MobileWebReviewResultV1;
  readonly metrics: BeforeAfterMetricsV1;
  readonly remainingOwnerGate: string;
}

// ---------------------------------------------------------------------------
// Closed key lists
// ---------------------------------------------------------------------------

export const HELD_OUT_CASE_RESULT_KEYS = [
  'caseId',
  'taskContractHash',
  'outcomeDecision',
  'evidenceManifestHash',
  'resultHash',
] as const;

export const ADVERSARIAL_CASE_RESULT_KEYS = [
  'case',
  'expectation',
  'engine',
  'refusalReason',
  'taintKind',
  'resultHash',
] as const;

export const MOBILE_WEB_REVIEW_RESULT_KEYS = [
  'scenario',
  'browserProofHash',
  'provedProperties',
  'resultHash',
] as const;

export const BEFORE_AFTER_METRICS_KEYS = [
  'baselineCheckFullCommit',
  'qualifiedMainSha',
  'totalTests',
  'addedTests',
  'addedAdditiveModules',
  'remainingRisks',
  'metricsHash',
] as const;

export const FINAL_REVIEW_PACKAGE_KEYS = [
  'schema',
  'qualifiedMainSha',
  'heldOutSummaryHash',
  'adversarialSummaryHash',
  'mobileWebResultHash',
  'metrics',
  'remainingOwnerGate',
  'packageHash',
] as const;

export const RESOLVED_OWNER_DECISION_KEYS = [
  'id',
  'decided_at',
  'scope',
  'decision',
  'terminal_disposition',
] as const;

export const TERMINAL_OPEN_PR_IDENTITY_KEYS = [
  'number',
  'url',
  'headSha',
  'baseRef',
  'state',
] as const;

export const TERMINAL_INVENTORY_PROJECTION_KEYS = [
  'schema',
  'sourceInventoryHash',
  'repository',
  'queryScope',
  'baseRefFilter',
  'defaultBranchHead',
  'expiresAt',
  'paginationComplete',
  'nextCursor',
  'serverTotalOpenCount',
  'finalServerTotalOpenCount',
  'totalOpenCount',
  'pullRequests',
  'projectionHash',
] as const;

export const TERMINAL_INVENTORY_VERDICT_KEYS = [
  'schema',
  'outcome',
  'resolvedMainSha',
  'totalOpenCount',
  'reason',
  'verdictHash',
] as const;

export const ASSEMBLE_FINAL_REVIEW_PACKAGE_INPUT_KEYS = [
  'qualifiedMainSha',
  'heldOutResults',
  'adversarialResults',
  'mobileWebResult',
  'metrics',
  'remainingOwnerGate',
] as const;

// ---------------------------------------------------------------------------
// Local helpers (M8/M11/M12 house pattern)
// ---------------------------------------------------------------------------

function failSchema(message: string): never {
  throw new QualificationError('invalid_input_schema', message);
}

function failPrecondition(
  code: QualificationPreconditionReason,
  message: string,
): never {
  throw new QualificationError(code, message);
}

function assertExactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Readonly<Record<string, unknown>> {
  try {
    canonicalSerialize(value);
  } catch (error) {
    failSchema(`${label} must be stable canonical JSON: ${String(error)}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    failSchema(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    failSchema(`${label} must use the exact closed schema`);
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isBoundedNfcString(
  value: unknown,
  maxBytes = MAX_IDENTIFIER_BYTES,
): value is string {
  return (
    typeof value === 'string' &&
    utf8Bytes(value) >= 1 &&
    utf8Bytes(value) <= maxBytes &&
    value.normalize('NFC') === value
  );
}

function isBoundedIdentifier(value: unknown): value is string {
  return isBoundedNfcString(value) && isValidIdentifier(value);
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_RE.test(value);
}

function isGitSha(value: unknown): value is string {
  return typeof value === 'string' && GIT_SHA_RE.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function omitHash<T extends object>(
  value: T,
  keyToOmit: string,
): Readonly<Record<string, unknown>> {
  const record = value as unknown as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== keyToOmit),
  );
}

function assertDenseArray(
  value: unknown,
  label: string,
): asserts value is readonly unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) {
    failSchema(`${label} must be a bounded array`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) {
      failSchema(`${label} must not be sparse`);
    }
  }
}

function assertSortedUniqueBoundedStrings(
  value: unknown,
  label: string,
  options: {
    readonly allowEmpty?: boolean;
    readonly maxItems?: number;
    readonly maxBytes?: number;
  } = {},
): asserts value is readonly string[] {
  const allowEmpty = options.allowEmpty ?? true;
  const maxItems = options.maxItems ?? MAX_ARRAY_ITEMS;
  const maxBytes = options.maxBytes ?? MAX_IDENTIFIER_BYTES;
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    (!allowEmpty && value.length === 0)
  ) {
    failSchema(
      `${label} must be a bounded${allowEmpty ? '' : ' non-empty'} array`,
    );
  }
  let previous: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || !isBoundedNfcString(value[index], maxBytes)) {
      failSchema(`${label} must contain bounded non-empty NFC strings`);
    }
    const current = value[index];
    if (previous !== null && previous >= current) {
      failSchema(`${label} must contain sorted unique strings`);
    }
    previous = current;
  }
}

/**
 * Deep-freeze acyclic canonical records. Recurses into already-frozen parents
 * so nested children are still sealed (M8/M10/M12 idiom).
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  if (!Object.isFrozen(value)) {
    Object.freeze(value);
  }
  return value;
}

function assertInjectedNow(now: string): void {
  if (!isCanonicalTimestamp(now)) {
    failSchema('injected now must be a canonical UTC-Z timestamp');
  }
}

function compareAdversarialCase(
  left: AdversarialCaseV1,
  right: AdversarialCaseV1,
): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isFullMobileWebPropertySet(
  properties: readonly string[],
): properties is readonly MobileWebProvedPropertyV1[] {
  return (
    properties.length === MOBILE_WEB_PROVED_PROPERTIES.length &&
    properties.every(
      (property, index) => property === MOBILE_WEB_PROVED_PROPERTIES[index],
    )
  );
}

function assertMobileWebProvedPropertiesShape(
  value: unknown,
  label: string,
): asserts value is readonly MobileWebProvedPropertyV1[] {
  assertSortedUniqueBoundedStrings(value, label, { allowEmpty: false });
  const closed = new Set<string>(MOBILE_WEB_PROVED_PROPERTIES);
  for (const property of value) {
    if (!closed.has(property)) {
      failSchema(`${label} must use the closed mobile-Web property set`);
    }
  }
}

// ---------------------------------------------------------------------------
// Hashing (omit-own-hash)
// ---------------------------------------------------------------------------

export function computeHeldOutCaseResultHash(
  result: Omit<HeldOutCaseResultV1, 'resultHash'>,
): string {
  return hashCanonicalJson(result);
}

export function computeAdversarialCaseResultHash(
  result: Omit<AdversarialCaseResultV1, 'resultHash'>,
): string {
  return hashCanonicalJson(result);
}

export function computeMobileWebReviewResultHash(
  result: Omit<MobileWebReviewResultV1, 'resultHash'>,
): string {
  return hashCanonicalJson(result);
}

export function computeBeforeAfterMetricsHash(
  metrics: Omit<BeforeAfterMetricsV1, 'metricsHash'>,
): string {
  return hashCanonicalJson(metrics);
}

export function computeFinalReviewPackageHash(
  packageValue: Omit<FinalReviewPackageV1, 'packageHash'>,
): string {
  return hashCanonicalJson(packageValue);
}

export function computeTerminalInventoryProjectionHash(
  projection: Omit<TerminalInventoryProjectionV1, 'projectionHash'>,
): string {
  return hashCanonicalJson(projection);
}

export function computeTerminalInventoryVerdictHash(
  verdict: Omit<TerminalInventoryVerdictV1, 'verdictHash'>,
): string {
  return hashCanonicalJson(verdict);
}

export function computeHeldOutSummaryHash(
  results: readonly HeldOutCaseResultV1[],
): string {
  return hashCanonicalJson(results);
}

export function computeAdversarialSummaryHash(
  results: readonly AdversarialCaseResultV1[],
): string {
  return hashCanonicalJson(results);
}

// ---------------------------------------------------------------------------
// Structural validators
// ---------------------------------------------------------------------------

export function assertHeldOutCaseResultV1(
  value: unknown,
): asserts value is HeldOutCaseResultV1 {
  assertExactRecord(value, HELD_OUT_CASE_RESULT_KEYS, 'held-out case result');
  const result = value as unknown as HeldOutCaseResultV1;
  if (
    !isBoundedIdentifier(result.caseId) ||
    !isHash(result.taskContractHash) ||
    !(M6_OUTCOME_DECISIONS as readonly unknown[]).includes(
      result.outcomeDecision,
    ) ||
    !isHash(result.evidenceManifestHash) ||
    !isHash(result.resultHash)
  ) {
    failSchema('held-out case result fields must use closed grammars');
  }
  const expected = computeHeldOutCaseResultHash(
    omitHash(result, 'resultHash') as Omit<HeldOutCaseResultV1, 'resultHash'>,
  );
  if (result.resultHash !== expected) {
    failSchema('held-out case result hash does not match the exact record');
  }
  deepFreeze(result);
}

export function assertAdversarialCaseResultV1(
  value: unknown,
): asserts value is AdversarialCaseResultV1 {
  assertExactRecord(
    value,
    ADVERSARIAL_CASE_RESULT_KEYS,
    'adversarial case result',
  );
  const result = value as unknown as AdversarialCaseResultV1;
  if (
    !(ADVERSARIAL_CASES as readonly unknown[]).includes(result.case) ||
    !(ADVERSARIAL_EXPECTATIONS as readonly unknown[]).includes(
      result.expectation,
    ) ||
    !(ADVERSARIAL_ENGINES as readonly unknown[]).includes(result.engine) ||
    !isBoundedNfcString(result.refusalReason, MAX_REASON_BYTES) ||
    !(ADVERSARIAL_TAINT_KINDS as readonly unknown[]).includes(result.taintKind) ||
    !isHash(result.resultHash)
  ) {
    failSchema('adversarial case result fields must use closed grammars');
  }
  const expected = computeAdversarialCaseResultHash(
    omitHash(result, 'resultHash') as Omit<
      AdversarialCaseResultV1,
      'resultHash'
    >,
  );
  if (result.resultHash !== expected) {
    failSchema('adversarial case result hash does not match the exact record');
  }
  deepFreeze(result);
}

export function assertMobileWebReviewResultV1(
  value: unknown,
): asserts value is MobileWebReviewResultV1 {
  assertExactRecord(
    value,
    MOBILE_WEB_REVIEW_RESULT_KEYS,
    'mobile-Web review result',
  );
  const result = value as unknown as MobileWebReviewResultV1;
  if (
    result.scenario !== 'mobile_web_outcome_review' ||
    !isHash(result.browserProofHash) ||
    !isHash(result.resultHash)
  ) {
    failSchema(
      'mobile-Web review result scenario and digests must use closed grammars',
    );
  }
  assertMobileWebProvedPropertiesShape(
    result.provedProperties,
    'mobile-Web review result provedProperties',
  );
  if (!isFullMobileWebPropertySet(result.provedProperties)) {
    failSchema(
      'mobile-Web review result provedProperties must equal the full six-property set',
    );
  }
  const expected = computeMobileWebReviewResultHash(
    omitHash(result, 'resultHash') as Omit<
      MobileWebReviewResultV1,
      'resultHash'
    >,
  );
  if (result.resultHash !== expected) {
    failSchema('mobile-Web review result hash does not match the exact record');
  }
  deepFreeze(result);
}

export function assertBeforeAfterMetricsV1(
  value: unknown,
): asserts value is BeforeAfterMetricsV1 {
  assertExactRecord(value, BEFORE_AFTER_METRICS_KEYS, 'before/after metrics');
  const metrics = value as unknown as BeforeAfterMetricsV1;
  if (
    !isGitSha(metrics.baselineCheckFullCommit) ||
    !isGitSha(metrics.qualifiedMainSha) ||
    !isNonNegativeSafeInteger(metrics.totalTests) ||
    !isNonNegativeSafeInteger(metrics.addedTests) ||
    !isNonNegativeSafeInteger(metrics.addedAdditiveModules) ||
    metrics.addedTests > metrics.totalTests ||
    !isHash(metrics.metricsHash)
  ) {
    failSchema('before/after metrics fields must use closed grammars');
  }
  assertSortedUniqueBoundedStrings(
    metrics.remainingRisks,
    'before/after metrics remainingRisks',
    { maxItems: MAX_REMAINING_RISKS, maxBytes: MAX_REASON_BYTES },
  );
  const expected = computeBeforeAfterMetricsHash(
    omitHash(metrics, 'metricsHash') as Omit<
      BeforeAfterMetricsV1,
      'metricsHash'
    >,
  );
  if (metrics.metricsHash !== expected) {
    failSchema('before/after metrics hash does not match the exact record');
  }
  deepFreeze(metrics);
}

export function assertFinalReviewPackageV1(
  value: unknown,
): asserts value is FinalReviewPackageV1 {
  assertExactRecord(value, FINAL_REVIEW_PACKAGE_KEYS, 'final review package');
  const packageValue = value as unknown as FinalReviewPackageV1;
  if (
    packageValue.schema !== 'hercules-final-review-package/v1' ||
    !isGitSha(packageValue.qualifiedMainSha) ||
    !isHash(packageValue.heldOutSummaryHash) ||
    !isHash(packageValue.adversarialSummaryHash) ||
    !isHash(packageValue.mobileWebResultHash) ||
    packageValue.remainingOwnerGate !== REMAINING_OWNER_GATE ||
    !isHash(packageValue.packageHash)
  ) {
    failSchema('final review package fields must use closed grammars');
  }
  assertBeforeAfterMetricsV1(packageValue.metrics);
  if (packageValue.metrics.qualifiedMainSha !== packageValue.qualifiedMainSha) {
    failSchema(
      'final review package metrics.qualifiedMainSha must equal qualifiedMainSha',
    );
  }
  const expected = computeFinalReviewPackageHash(
    omitHash(packageValue, 'packageHash') as Omit<
      FinalReviewPackageV1,
      'packageHash'
    >,
  );
  if (packageValue.packageHash !== expected) {
    failSchema('final review package hash does not match the exact record');
  }
  deepFreeze(packageValue);
}

export function assertResolvedOwnerDecisionV1(
  value: unknown,
): asserts value is ResolvedOwnerDecisionV1 {
  assertExactRecord(
    value,
    RESOLVED_OWNER_DECISION_KEYS,
    'resolved owner decision',
  );
  const decision = value as unknown as ResolvedOwnerDecisionV1;
  if (
    !isBoundedIdentifier(decision.id) ||
    !isCanonicalTimestamp(decision.decided_at) ||
    decision.scope !== 'program' ||
    !isBoundedNfcString(decision.decision, MAX_REASON_BYTES) ||
    !(TERMINAL_DISPOSITIONS as readonly unknown[]).includes(
      decision.terminal_disposition,
    )
  ) {
    failSchema('resolved owner decision fields must use closed grammars');
  }
  deepFreeze(decision);
}

export function assertTerminalOpenPrIdentityV1(
  value: unknown,
): asserts value is TerminalOpenPrIdentityV1 {
  assertExactRecord(
    value,
    TERMINAL_OPEN_PR_IDENTITY_KEYS,
    'terminal open PR identity',
  );
  const identity = value as unknown as TerminalOpenPrIdentityV1;
  if (
    !isPositiveSafeInteger(identity.number) ||
    !isBoundedNfcString(identity.url, MAX_REASON_BYTES) ||
    parseGithubPrUrl(identity.url) === null ||
    !isGitSha(identity.headSha) ||
    !isBoundedIdentifier(identity.baseRef) ||
    identity.state !== 'OPEN'
  ) {
    failSchema('terminal open PR identity fields must use closed grammars');
  }
  deepFreeze(identity);
}

export function assertTerminalInventoryProjectionV1(
  value: unknown,
): asserts value is TerminalInventoryProjectionV1 {
  assertExactRecord(
    value,
    TERMINAL_INVENTORY_PROJECTION_KEYS,
    'terminal inventory projection',
  );
  const projection = value as unknown as TerminalInventoryProjectionV1;
  if (
    projection.schema !== 'hercules-terminal-inventory-projection/v1' ||
    !isHash(projection.sourceInventoryHash) ||
    projection.repository !== 'example-org/acme' ||
    projection.queryScope !== 'all-open-base-refs' ||
    projection.baseRefFilter !== null ||
    !isGitSha(projection.defaultBranchHead) ||
    !isCanonicalTimestamp(projection.expiresAt) ||
    projection.paginationComplete !== true ||
    projection.nextCursor !== null ||
    !isNonNegativeSafeInteger(projection.serverTotalOpenCount) ||
    !isNonNegativeSafeInteger(projection.finalServerTotalOpenCount) ||
    !isNonNegativeSafeInteger(projection.totalOpenCount) ||
    !isHash(projection.projectionHash)
  ) {
    failSchema(
      'terminal inventory projection fields must use closed grammars',
    );
  }
  assertDenseArray(
    projection.pullRequests,
    'terminal inventory projection pullRequests',
  );
  if (projection.pullRequests.length !== projection.totalOpenCount) {
    failSchema(
      'terminal inventory projection pullRequests length must equal totalOpenCount',
    );
  }
  const seenNumbers = new Set<number>();
  const seenUrls = new Set<string>();
  for (const identity of projection.pullRequests) {
    assertTerminalOpenPrIdentityV1(identity);
    if (seenNumbers.has(identity.number) || seenUrls.has(identity.url)) {
      failSchema(
        'terminal inventory projection pullRequests must have unique number and url',
      );
    }
    seenNumbers.add(identity.number);
    seenUrls.add(identity.url);
  }
  const expected = computeTerminalInventoryProjectionHash(
    omitHash(projection, 'projectionHash') as Omit<
      TerminalInventoryProjectionV1,
      'projectionHash'
    >,
  );
  if (projection.projectionHash !== expected) {
    failSchema(
      'terminal inventory projection hash does not match the exact record',
    );
  }
  deepFreeze(projection);
}

export function assertTerminalInventoryVerdictV1(
  value: unknown,
): asserts value is TerminalInventoryVerdictV1 {
  assertExactRecord(
    value,
    TERMINAL_INVENTORY_VERDICT_KEYS,
    'terminal inventory verdict',
  );
  const verdict = value as unknown as TerminalInventoryVerdictV1;
  if (
    verdict.schema !== 'hercules-terminal-inventory-verdict/v1' ||
    (verdict.outcome !== 'pass' && verdict.outcome !== 'fail') ||
    !isGitSha(verdict.resolvedMainSha) ||
    !isNonNegativeSafeInteger(verdict.totalOpenCount) ||
    !isHash(verdict.verdictHash)
  ) {
    failSchema('terminal inventory verdict fields must use closed grammars');
  }
  if (verdict.outcome === 'pass') {
    if (verdict.reason !== null) {
      failSchema('terminal inventory pass verdict reason must be null');
    }
  } else if (
    verdict.reason === null ||
    !isBoundedNfcString(verdict.reason, MAX_REASON_BYTES)
  ) {
    failSchema(
      'terminal inventory fail verdict reason must be a bounded non-empty NFC string',
    );
  }
  const expected = computeTerminalInventoryVerdictHash(
    omitHash(verdict, 'verdictHash') as Omit<
      TerminalInventoryVerdictV1,
      'verdictHash'
    >,
  );
  if (verdict.verdictHash !== expected) {
    failSchema('terminal inventory verdict hash does not match the exact record');
  }
  deepFreeze(verdict);
}

// ---------------------------------------------------------------------------
// Pure control-side decisions
// ---------------------------------------------------------------------------

function assertMobileWebForAssembly(
  value: unknown,
): MobileWebReviewResultV1 {
  assertExactRecord(
    value,
    MOBILE_WEB_REVIEW_RESULT_KEYS,
    'mobile-Web review result',
  );
  const result = value as unknown as MobileWebReviewResultV1;
  if (
    result.scenario !== 'mobile_web_outcome_review' ||
    !isHash(result.browserProofHash) ||
    !isHash(result.resultHash)
  ) {
    failSchema(
      'mobile-Web review result scenario and digests must use closed grammars',
    );
  }
  assertMobileWebProvedPropertiesShape(
    result.provedProperties,
    'mobile-Web review result provedProperties',
  );
  if (!isFullMobileWebPropertySet(result.provedProperties)) {
    failPrecondition(
      'mobile_web_properties_incomplete',
      'mobile-Web provedProperties must equal the full six-property set',
    );
  }
  const expected = computeMobileWebReviewResultHash(
    omitHash(result, 'resultHash') as Omit<
      MobileWebReviewResultV1,
      'resultHash'
    >,
  );
  if (result.resultHash !== expected) {
    failSchema('mobile-Web review result hash does not match the exact record');
  }
  return deepFreeze(result);
}

function assertAdversarialCoverage(
  results: readonly AdversarialCaseResultV1[],
): readonly AdversarialCaseResultV1[] {
  if (results.length !== ADVERSARIAL_CASES.length) {
    failPrecondition(
      'adversarial_coverage_incomplete',
      'adversarial results must cover all eight cases exactly once',
    );
  }
  const byCase = new Map<AdversarialCaseV1, AdversarialCaseResultV1>();
  for (const result of results) {
    if (byCase.has(result.case)) {
      failPrecondition(
        'adversarial_coverage_incomplete',
        `adversarial case ${result.case} appears more than once`,
      );
    }
    const pinned = ADVERSARIAL_CASE_TABLE[result.case];
    if (
      result.expectation !== pinned.expectation ||
      result.taintKind !== pinned.taintKind ||
      !pinned.engines.includes(result.engine)
    ) {
      failPrecondition(
        'adversarial_coverage_incomplete',
        `adversarial case ${result.case} does not reach its pinned fail-closed disposition`,
      );
    }
    byCase.set(result.case, result);
  }
  for (const caseId of ADVERSARIAL_CASES) {
    if (!byCase.has(caseId)) {
      failPrecondition(
        'adversarial_coverage_incomplete',
        `adversarial results missing case ${caseId}`,
      );
    }
  }
  return [...byCase.values()].sort((left, right) =>
    compareAdversarialCase(left.case, right.case),
  );
}

/**
 * Aggregates held-out, adversarial, mobile-Web, and metrics evidence into the
 * sealed final review package. Originates no verdict; throws exactly one of the
 * five closed assembly preconditions on trusted-input inconsistency.
 */
export function assembleFinalReviewPackage(
  inputs: AssembleFinalReviewPackageInputsV1,
  now: string,
): FinalReviewPackageV1 {
  assertInjectedNow(now);
  assertExactRecord(
    inputs,
    ASSEMBLE_FINAL_REVIEW_PACKAGE_INPUT_KEYS,
    'assemble final review package inputs',
  );
  if (!isGitSha(inputs.qualifiedMainSha)) {
    failSchema('qualifiedMainSha must be a 40-hex git SHA');
  }
  if (!isBoundedNfcString(inputs.remainingOwnerGate, MAX_REASON_BYTES)) {
    failSchema('remainingOwnerGate must be a bounded non-empty NFC string');
  }

  assertDenseArray(inputs.heldOutResults, 'held-out results');
  if (inputs.heldOutResults.length === 0) {
    failPrecondition(
      'held_out_case_invalid',
      'held-out results must contain at least one case',
    );
  }
  const heldOutCaseIds = new Set<string>();
  for (const result of inputs.heldOutResults) {
    try {
      assertHeldOutCaseResultV1(result);
    } catch (error) {
      if (error instanceof QualificationError) {
        failPrecondition('held_out_case_invalid', error.message);
      }
      throw error;
    }
    if (heldOutCaseIds.has(result.caseId)) {
      failPrecondition(
        'held_out_case_invalid',
        `held-out caseId ${result.caseId} appears more than once`,
      );
    }
    heldOutCaseIds.add(result.caseId);
  }

  assertDenseArray(inputs.adversarialResults, 'adversarial results');
  for (const result of inputs.adversarialResults) {
    assertAdversarialCaseResultV1(result);
  }
  const orderedAdversarial = assertAdversarialCoverage(inputs.adversarialResults);

  const mobileWebResult = assertMobileWebForAssembly(inputs.mobileWebResult);

  assertBeforeAfterMetricsV1(inputs.metrics);
  if (inputs.metrics.qualifiedMainSha !== inputs.qualifiedMainSha) {
    failPrecondition(
      'metrics_binding_mismatch',
      'metrics.qualifiedMainSha must equal the package qualifiedMainSha',
    );
  }

  if (inputs.remainingOwnerGate !== REMAINING_OWNER_GATE) {
    failPrecondition(
      'remaining_gate_mismatch',
      'remainingOwnerGate must be controlled_database_authority_cutover',
    );
  }

  const withoutHash: Omit<FinalReviewPackageV1, 'packageHash'> = {
    schema: 'hercules-final-review-package/v1',
    qualifiedMainSha: inputs.qualifiedMainSha,
    heldOutSummaryHash: computeHeldOutSummaryHash(inputs.heldOutResults),
    adversarialSummaryHash: computeAdversarialSummaryHash(orderedAdversarial),
    mobileWebResultHash: mobileWebResult.resultHash,
    metrics: inputs.metrics,
    remainingOwnerGate: REMAINING_OWNER_GATE,
  };
  const packageValue: FinalReviewPackageV1 = {
    ...withoutHash,
    packageHash: computeFinalReviewPackageHash(withoutHash),
  };
  return deepFreeze(packageValue);
}

function sealVerdict(
  outcome: 'pass' | 'fail',
  resolvedMainSha: string,
  totalOpenCount: number,
  reason: string | null,
): TerminalInventoryVerdictV1 {
  const withoutHash: Omit<TerminalInventoryVerdictV1, 'verdictHash'> = {
    schema: 'hercules-terminal-inventory-verdict/v1',
    outcome,
    resolvedMainSha,
    totalOpenCount,
    reason,
  };
  const verdict: TerminalInventoryVerdictV1 = {
    ...withoutHash,
    verdictHash: computeTerminalInventoryVerdictHash(withoutHash),
  };
  return deepFreeze(verdict);
}

/**
 * Observational terminal-inventory validator. TOTAL: returns pass/fail and
 * never throws the assembly precondition union. A nonzero, mismatched, stale,
 * or incomplete projection is a fail verdict, not an engine crash.
 */
export function validateTerminalInventory(
  projection: TerminalInventoryProjectionV1,
  expectedMainSha: string,
  now: string,
): TerminalInventoryVerdictV1 {
  const resolvedMainSha = isGitSha(expectedMainSha)
    ? expectedMainSha
    : '0000000000000000000000000000000000000000';
  const totalOpenCount =
    projection !== null &&
    typeof projection === 'object' &&
    isNonNegativeSafeInteger(
      (projection as TerminalInventoryProjectionV1).totalOpenCount,
    )
      ? (projection as TerminalInventoryProjectionV1).totalOpenCount
      : 0;

  if (!isGitSha(expectedMainSha)) {
    return sealVerdict(
      'fail',
      resolvedMainSha,
      totalOpenCount,
      'expectedMainSha',
    );
  }
  if (!isCanonicalTimestamp(now)) {
    return sealVerdict('fail', resolvedMainSha, totalOpenCount, 'now');
  }

  if (
    projection === null ||
    typeof projection !== 'object' ||
    Array.isArray(projection)
  ) {
    return sealVerdict('fail', resolvedMainSha, totalOpenCount, 'projection');
  }

  if (!isHash(projection.sourceInventoryHash)) {
    return sealVerdict(
      'fail',
      resolvedMainSha,
      totalOpenCount,
      'sourceInventoryHash',
    );
  }
  if (projection.defaultBranchHead !== expectedMainSha) {
    return sealVerdict(
      'fail',
      resolvedMainSha,
      totalOpenCount,
      'defaultBranchHead',
    );
  }
  if (projection.queryScope !== 'all-open-base-refs') {
    return sealVerdict('fail', resolvedMainSha, totalOpenCount, 'queryScope');
  }
  if (projection.baseRefFilter !== null) {
    return sealVerdict('fail', resolvedMainSha, totalOpenCount, 'baseRefFilter');
  }
  if (projection.paginationComplete !== true) {
    return sealVerdict(
      'fail',
      resolvedMainSha,
      totalOpenCount,
      'paginationComplete',
    );
  }
  if (projection.nextCursor !== null) {
    return sealVerdict('fail', resolvedMainSha, totalOpenCount, 'nextCursor');
  }
  if (projection.totalOpenCount !== 0) {
    return sealVerdict(
      'fail',
      resolvedMainSha,
      projection.totalOpenCount,
      'totalOpenCount',
    );
  }
  if (projection.serverTotalOpenCount !== 0) {
    return sealVerdict(
      'fail',
      resolvedMainSha,
      projection.totalOpenCount,
      'serverTotalOpenCount',
    );
  }
  if (projection.finalServerTotalOpenCount !== 0) {
    return sealVerdict(
      'fail',
      resolvedMainSha,
      projection.totalOpenCount,
      'finalServerTotalOpenCount',
    );
  }
  if (
    !Array.isArray(projection.pullRequests) ||
    projection.pullRequests.length !== 0
  ) {
    return sealVerdict(
      'fail',
      resolvedMainSha,
      projection.totalOpenCount,
      'pullRequests',
    );
  }
  if (
    !isCanonicalTimestamp(projection.expiresAt) ||
    now > projection.expiresAt
  ) {
    return sealVerdict('fail', resolvedMainSha, projection.totalOpenCount, 'expiresAt');
  }

  return sealVerdict('pass', resolvedMainSha, 0, null);
}
