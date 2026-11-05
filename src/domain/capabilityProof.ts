/**
 * M12 capability-proof domain records.
 *
 * Slice 1: closed proof/suite/summary records, validators, hashing, and the
 * pure assembler. Archetype harnesses and engine driving live in later slices.
 */

import { assertEvidenceManifest, type EvidenceManifest } from './artifact.js';
import { hashCanonicalJson, canonicalSerialize } from './canonicalJson.js';
import { computeTaskContractHash } from './contractHash.js';
import {
  assertAdmissionVerdictV1,
  assertControlApiV2RequestV1,
  deriveAggregateId,
  type AdmissionVerdictV1,
  type ControlApiV2RequestV1,
} from './controlApiV2.js';
import {
  CRITERION_RESULT_STATUSES,
  type CriterionResultStatus,
} from './evaluationVerdict.js';
import {
  assertIndependentEvaluationReceiptV1,
  type IndependentEvaluationReceiptV1,
} from './independentEvaluation.js';
import {
  assertRoutingDecisionV1,
  type RoutingDecisionV1,
} from './repairRouting.js';
import {
  type M6OutcomeDecision,
  type ReviewPackageV2,
} from './reviewPackageV2.js';
import { isValidIdentifier } from './task.js';
import { assertTaskContract, type TaskContract } from './taskContract.js';
import {
  assertJobSpecV1,
  assertResultAdmissionV1,
  assertResultPackageV1,
  isCanonicalTimestamp,
  type JobSpecV1,
  type ResultAdmissionV1,
  type ResultPackageV1,
} from './workerBoundary.js';

// ---------------------------------------------------------------------------
// Fail-closed error class
// ---------------------------------------------------------------------------

/** Binding/precondition reasons thrown by the pure assembler (exactly 7). */
export const CAPABILITY_PROOF_PRECONDITION_REASONS = [
  'inconsistent_contract_binding',
  'criterion_coverage_mismatch',
  'dangling_evidence_ref',
  'archetype_evidence_mismatch',
  'repair_binding_mismatch',
  'outcome_binding_mismatch',
  'archetype_coverage_incomplete',
] as const;

export type CapabilityProofPreconditionReason =
  (typeof CAPABILITY_PROOF_PRECONDITION_REASONS)[number];

export type CapabilityProofErrorCode =
  | 'invalid_input_schema'
  | CapabilityProofPreconditionReason;

export class CapabilityProofError extends Error {
  override readonly name = 'CapabilityProofError';

  constructor(
    readonly code: CapabilityProofErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Closed unions / bounded constants
// ---------------------------------------------------------------------------

export const CAPABILITY_ARCHETYPES = [
  'bounded_non_code',
  'browser',
  'code',
] as const;

export type CapabilityArchetypeV1 = (typeof CAPABILITY_ARCHETYPES)[number];

/** M12 copies M8's verdict vocabulary VERBATIM — never mint a parallel union. */
export type CapabilityCriterionStatusV1 = CriterionResultStatus;

export const METRIC_PROVENANCES = ['fixture_declared', 'measured'] as const;
export type MetricProvenanceV1 = (typeof METRIC_PROVENANCES)[number];

/**
 * Upper bound (ms) on a capability-proof wall-clock duration — 7 days. Finite and
 * generous (any realistic single-task proof run fits well inside it) yet bounded, so
 * a validator-blessed fixture can never carry an absurd or overflow-prone duration.
 */
export const MAX_PROOF_WALLCLOCK_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * Upper bound (ms) on recorded operator-review duration — 1 day. An operator review
 * of a single result is minutes; this bounded ceiling leaves generous headroom.
 */
export const MAX_OPERATOR_REVIEW_MS = 24 * 60 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Records (verbatim from M12 closed-records contract)
// ---------------------------------------------------------------------------

export interface CriterionVerdictRefV1 {
  readonly criterionId: string;
  readonly status: CapabilityCriterionStatusV1;
  readonly evidenceRefs: readonly string[];
}

export interface CapabilityCostV1 {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly wallClockMillis: number;
  readonly provenance: MetricProvenanceV1;
  readonly costHash: string;
}

export interface CapabilityOperatorReviewV1 {
  readonly millis: number;
  readonly provenance: MetricProvenanceV1;
}

export interface BrowserEvidenceRefV1 {
  readonly artifactRefId: string;
  readonly sha256: string;
}

export interface CapabilityProofV1 {
  readonly schema: 'hercules-capability-proof/v1';
  readonly archetype: CapabilityArchetypeV1;
  readonly taskContractHash: string;
  readonly evidenceManifestId: string;
  readonly evidenceManifestHash: string;
  readonly reviewProjectionHash: string;
  readonly browserEvidenceRef: BrowserEvidenceRefV1 | null;
  readonly evaluationReceiptHash: string;
  readonly criterionVerdicts: readonly CriterionVerdictRefV1[];
  readonly repairExercised: boolean;
  readonly routingDecisionHash: string | null;
  readonly routedEvaluationReceiptHash: string | null;
  readonly workerJobSpecHash: string;
  readonly workerResultAdmissionHash: string;
  readonly controlCreateVerdictHash: string;
  readonly controlDecisionVerdictHash: string;
  readonly outcomeDecision: M6OutcomeDecision;
  readonly cost: CapabilityCostV1;
  readonly operatorReview: CapabilityOperatorReviewV1;
  readonly proofHash: string;
}

export interface CapabilityProofSuiteV1 {
  readonly schema: 'hercules-capability-proof-suite/v1';
  readonly builtAgainstMainSha: string;
  readonly proofs: readonly CapabilityProofV1[];
  readonly archetypeCoverage: readonly CapabilityArchetypeV1[];
  readonly suiteHash: string;
}

export interface CapabilityProofSummaryRowV1 {
  readonly archetype: CapabilityArchetypeV1;
  readonly outcomeDecision: M6OutcomeDecision;
  readonly passCriteria: number;
  readonly totalCriteria: number;
  readonly repairExercised: boolean;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly wallClockMillis: number;
  readonly operatorReviewMillis: number;
  readonly metricsProvenance: MetricProvenanceV1;
}

export interface CapabilityProofSummaryV1 {
  readonly schema: 'hercules-capability-proof-summary/v1';
  readonly suiteHash: string;
  readonly rows: readonly CapabilityProofSummaryRowV1[];
  readonly summaryHash: string;
}

/** Trusted layer outputs the pure assembler binds for one archetype proof. */
export interface AssembleCapabilityProofInputsV1 {
  readonly archetype: CapabilityArchetypeV1;
  readonly contract: TaskContract;
  readonly evidenceManifest: EvidenceManifest;
  readonly reviewPackage: ReviewPackageV2;
  readonly evaluationReceipt: IndependentEvaluationReceiptV1;
  readonly routingDecision: RoutingDecisionV1 | null;
  readonly routedEvaluationReceipt: IndependentEvaluationReceiptV1 | null;
  readonly browserEvidenceRef: BrowserEvidenceRefV1 | null;
  readonly jobSpec: JobSpecV1;
  readonly resultPackage: ResultPackageV1;
  readonly resultAdmission: ResultAdmissionV1;
  readonly controlCreateRequest: ControlApiV2RequestV1;
  readonly controlCreateVerdict: AdmissionVerdictV1;
  readonly controlDecisionRequest: ControlApiV2RequestV1;
  readonly controlDecisionVerdict: AdmissionVerdictV1;
  readonly cost: CapabilityCostV1;
  readonly operatorReview: CapabilityOperatorReviewV1;
}

// ---------------------------------------------------------------------------
// Closed key lists
// ---------------------------------------------------------------------------

export const CRITERION_VERDICT_REF_KEYS = [
  'criterionId',
  'status',
  'evidenceRefs',
] as const;

export const CAPABILITY_COST_KEYS = [
  'inputTokens',
  'outputTokens',
  'wallClockMillis',
  'provenance',
  'costHash',
] as const;

export const CAPABILITY_OPERATOR_REVIEW_KEYS = [
  'millis',
  'provenance',
] as const;

export const BROWSER_EVIDENCE_REF_KEYS = [
  'artifactRefId',
  'sha256',
] as const;

export const CAPABILITY_PROOF_KEYS = [
  'schema',
  'archetype',
  'taskContractHash',
  'evidenceManifestId',
  'evidenceManifestHash',
  'reviewProjectionHash',
  'browserEvidenceRef',
  'evaluationReceiptHash',
  'criterionVerdicts',
  'repairExercised',
  'routingDecisionHash',
  'routedEvaluationReceiptHash',
  'workerJobSpecHash',
  'workerResultAdmissionHash',
  'controlCreateVerdictHash',
  'controlDecisionVerdictHash',
  'outcomeDecision',
  'cost',
  'operatorReview',
  'proofHash',
] as const;

export const CAPABILITY_PROOF_SUITE_KEYS = [
  'schema',
  'builtAgainstMainSha',
  'proofs',
  'archetypeCoverage',
  'suiteHash',
] as const;

export const CAPABILITY_PROOF_SUMMARY_ROW_KEYS = [
  'archetype',
  'outcomeDecision',
  'passCriteria',
  'totalCriteria',
  'repairExercised',
  'inputTokens',
  'outputTokens',
  'wallClockMillis',
  'operatorReviewMillis',
  'metricsProvenance',
] as const;

export const CAPABILITY_PROOF_SUMMARY_KEYS = [
  'schema',
  'suiteHash',
  'rows',
  'summaryHash',
] as const;

export const ASSEMBLE_CAPABILITY_PROOF_INPUT_KEYS = [
  'archetype',
  'contract',
  'evidenceManifest',
  'reviewPackage',
  'evaluationReceipt',
  'routingDecision',
  'routedEvaluationReceipt',
  'browserEvidenceRef',
  'jobSpec',
  'resultPackage',
  'resultAdmission',
  'controlCreateRequest',
  'controlCreateVerdict',
  'controlDecisionRequest',
  'controlDecisionVerdict',
  'cost',
  'operatorReview',
] as const;

// ---------------------------------------------------------------------------
// Local helpers (M8/M10/M11 house pattern)
// ---------------------------------------------------------------------------

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_ARRAY_ITEMS = 4_096;

const M6_OUTCOME_DECISIONS = [
  'approve_outcome',
  'reject_outcome',
  'request_changes',
] as const satisfies readonly M6OutcomeDecision[];

function failSchema(message: string): never {
  throw new CapabilityProofError('invalid_input_schema', message);
}

function failPrecondition(
  code: CapabilityProofPreconditionReason,
  message: string,
): never {
  throw new CapabilityProofError(code, message);
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

function isBoundedNfcString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    utf8Bytes(value) >= 1 &&
    utf8Bytes(value) <= MAX_IDENTIFIER_BYTES &&
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
  allowEmpty = true,
): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_ARRAY_ITEMS ||
    (!allowEmpty && value.length === 0)
  ) {
    failSchema(`${label} must be a bounded${allowEmpty ? '' : ' non-empty'} array`);
  }
  let previous: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || !isBoundedNfcString(value[index])) {
      failSchema(`${label} must contain bounded non-empty NFC strings`);
    }
    const current = value[index];
    if (previous !== null && previous >= current) {
      failSchema(`${label} must contain sorted unique strings`);
    }
    previous = current;
  }
}

function assertSortedUniqueIdentifiers(
  value: unknown,
  label: string,
  allowEmpty = true,
): asserts value is readonly string[] {
  assertSortedUniqueBoundedStrings(value, label, allowEmpty);
  for (const item of value) {
    if (!isValidIdentifier(item)) {
      failSchema(`${label} must contain safe-grammar identifiers`);
    }
  }
}

/**
 * Deep-freeze acyclic canonical records. Recurses into already-frozen parents
 * so nested children are still sealed (M8/M10 idiom).
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

function compareArchetype(
  left: CapabilityArchetypeV1,
  right: CapabilityArchetypeV1,
): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Hashing (omit-own-hash)
// ---------------------------------------------------------------------------

export function computeCapabilityCostHash(
  cost: Omit<CapabilityCostV1, 'costHash'>,
): string {
  return hashCanonicalJson(cost);
}

export function computeCapabilityProofHash(
  proof: Omit<CapabilityProofV1, 'proofHash'>,
): string {
  return hashCanonicalJson(proof);
}

export function computeCapabilityProofSuiteHash(
  suite: Omit<CapabilityProofSuiteV1, 'suiteHash'>,
): string {
  return hashCanonicalJson(suite);
}

export function computeCapabilityProofSummaryHash(
  summary: Omit<CapabilityProofSummaryV1, 'summaryHash'>,
): string {
  return hashCanonicalJson(summary);
}

// ---------------------------------------------------------------------------
// Structural validators
// ---------------------------------------------------------------------------

export function assertCriterionVerdictRefV1(
  value: unknown,
): asserts value is CriterionVerdictRefV1 {
  assertExactRecord(value, CRITERION_VERDICT_REF_KEYS, 'criterion verdict ref');
  const ref = value as unknown as CriterionVerdictRefV1;
  if (
    !isBoundedIdentifier(ref.criterionId) ||
    !(CRITERION_RESULT_STATUSES as readonly unknown[]).includes(ref.status)
  ) {
    failSchema(
      'criterion verdict ref criterionId and status must use closed grammars',
    );
  }
  assertSortedUniqueIdentifiers(
    ref.evidenceRefs,
    'criterion verdict ref evidenceRefs',
  );
  deepFreeze(ref);
}

export function assertCapabilityCostV1(
  value: unknown,
): asserts value is CapabilityCostV1 {
  assertExactRecord(value, CAPABILITY_COST_KEYS, 'capability cost');
  const cost = value as unknown as CapabilityCostV1;
  if (
    !isNonNegativeSafeInteger(cost.inputTokens) ||
    !isNonNegativeSafeInteger(cost.outputTokens) ||
    !isNonNegativeSafeInteger(cost.wallClockMillis) ||
    cost.wallClockMillis > MAX_PROOF_WALLCLOCK_MS ||
    !(METRIC_PROVENANCES as readonly unknown[]).includes(cost.provenance) ||
    !isHash(cost.costHash)
  ) {
    failSchema(
      'capability cost tokens, wall-clock, provenance, and hash must be valid',
    );
  }
  const expected = computeCapabilityCostHash(
    omitHash(cost, 'costHash') as Omit<CapabilityCostV1, 'costHash'>,
  );
  if (cost.costHash !== expected) {
    failSchema('capability cost hash does not match the exact record');
  }
  deepFreeze(cost);
}

export function assertCapabilityOperatorReviewV1(
  value: unknown,
): asserts value is CapabilityOperatorReviewV1 {
  assertExactRecord(
    value,
    CAPABILITY_OPERATOR_REVIEW_KEYS,
    'capability operator review',
  );
  const review = value as unknown as CapabilityOperatorReviewV1;
  if (
    !isNonNegativeSafeInteger(review.millis) ||
    review.millis > MAX_OPERATOR_REVIEW_MS ||
    !(METRIC_PROVENANCES as readonly unknown[]).includes(review.provenance)
  ) {
    failSchema(
      'capability operator review millis and provenance must be valid',
    );
  }
  deepFreeze(review);
}

export function assertBrowserEvidenceRefV1(
  value: unknown,
): asserts value is BrowserEvidenceRefV1 {
  assertExactRecord(value, BROWSER_EVIDENCE_REF_KEYS, 'browser evidence ref');
  const ref = value as unknown as BrowserEvidenceRefV1;
  if (!isBoundedIdentifier(ref.artifactRefId) || !isHash(ref.sha256)) {
    failSchema(
      'browser evidence ref artifactRefId and sha256 must use closed grammars',
    );
  }
  deepFreeze(ref);
}

export function assertCapabilityProofV1(
  value: unknown,
): asserts value is CapabilityProofV1 {
  assertExactRecord(value, CAPABILITY_PROOF_KEYS, 'capability proof');
  const proof = value as unknown as CapabilityProofV1;
  if (
    proof.schema !== 'hercules-capability-proof/v1' ||
    !(CAPABILITY_ARCHETYPES as readonly unknown[]).includes(proof.archetype) ||
    !isHash(proof.taskContractHash) ||
    !isBoundedIdentifier(proof.evidenceManifestId) ||
    !isHash(proof.evidenceManifestHash) ||
    !isHash(proof.reviewProjectionHash) ||
    !isHash(proof.evaluationReceiptHash) ||
    typeof proof.repairExercised !== 'boolean' ||
    !isHash(proof.workerJobSpecHash) ||
    !isHash(proof.workerResultAdmissionHash) ||
    !isHash(proof.controlCreateVerdictHash) ||
    !isHash(proof.controlDecisionVerdictHash) ||
    !(M6_OUTCOME_DECISIONS as readonly unknown[]).includes(
      proof.outcomeDecision,
    ) ||
    !isHash(proof.proofHash)
  ) {
    failSchema(
      'capability proof schema, archetype, digests, and outcome must be valid',
    );
  }

  const browserExpected = proof.archetype === 'browser';
  const browserPresent = proof.browserEvidenceRef !== null;
  if (browserExpected !== browserPresent) {
    failSchema(
      'capability proof browserEvidenceRef must be non-null iff archetype is browser',
    );
  }
  if (proof.browserEvidenceRef !== null) {
    assertBrowserEvidenceRefV1(proof.browserEvidenceRef);
  }

  const repairHashPresent = proof.routingDecisionHash !== null;
  const routedHashPresent = proof.routedEvaluationReceiptHash !== null;
  if (
    proof.repairExercised !== repairHashPresent ||
    proof.repairExercised !== routedHashPresent
  ) {
    failSchema(
      'capability proof repairExercised must equal both repair hash fields non-null',
    );
  }
  if (proof.routingDecisionHash !== null && !isHash(proof.routingDecisionHash)) {
    failSchema('capability proof routingDecisionHash must be a sha256 digest');
  }
  if (
    proof.routedEvaluationReceiptHash !== null &&
    !isHash(proof.routedEvaluationReceiptHash)
  ) {
    failSchema(
      'capability proof routedEvaluationReceiptHash must be a sha256 digest',
    );
  }

  assertDenseArray(proof.criterionVerdicts, 'capability proof criterionVerdicts');
  if (proof.criterionVerdicts.length === 0) {
    failSchema('capability proof criterionVerdicts must be non-empty');
  }
  let previousCriterionId: string | null = null;
  for (const verdict of proof.criterionVerdicts) {
    assertCriterionVerdictRefV1(verdict);
    if (
      previousCriterionId !== null &&
      previousCriterionId >= verdict.criterionId
    ) {
      failSchema(
        'capability proof criterionVerdicts must be sorted-unique by criterionId',
      );
    }
    previousCriterionId = verdict.criterionId;
  }

  assertCapabilityCostV1(proof.cost);
  assertCapabilityOperatorReviewV1(proof.operatorReview);

  const expected = computeCapabilityProofHash(
    omitHash(proof, 'proofHash') as Omit<CapabilityProofV1, 'proofHash'>,
  );
  if (proof.proofHash !== expected) {
    failSchema('capability proof hash does not match the exact record');
  }
  deepFreeze(proof);
}

export function assertCapabilityProofSuiteV1(
  value: unknown,
): asserts value is CapabilityProofSuiteV1 {
  assertExactRecord(value, CAPABILITY_PROOF_SUITE_KEYS, 'capability proof suite');
  const suite = value as unknown as CapabilityProofSuiteV1;
  if (
    suite.schema !== 'hercules-capability-proof-suite/v1' ||
    !isGitSha(suite.builtAgainstMainSha) ||
    !isHash(suite.suiteHash)
  ) {
    failSchema(
      'capability proof suite schema, main SHA, and suiteHash must be valid',
    );
  }
  assertDenseArray(suite.proofs, 'capability proof suite proofs');
  if (suite.proofs.length !== CAPABILITY_ARCHETYPES.length) {
    failSchema('capability proof suite must carry exactly three proofs');
  }
  for (const proof of suite.proofs) {
    assertCapabilityProofV1(proof);
  }
  for (let index = 1; index < suite.proofs.length; index += 1) {
    const previous = suite.proofs[index - 1];
    const current = suite.proofs[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareArchetype(previous.archetype, current.archetype) >= 0
    ) {
      failSchema('capability proof suite proofs must be sorted by archetype');
    }
  }
  assertSortedUniqueBoundedStrings(
    suite.archetypeCoverage,
    'capability proof suite archetypeCoverage',
    false,
  );
  if (
    suite.archetypeCoverage.length !== CAPABILITY_ARCHETYPES.length ||
    suite.archetypeCoverage.some(
      (archetype, index) => archetype !== CAPABILITY_ARCHETYPES[index],
    )
  ) {
    failSchema(
      'capability proof suite archetypeCoverage must equal the full archetype set',
    );
  }
  for (let index = 0; index < suite.proofs.length; index += 1) {
    const proof = suite.proofs[index];
    const expectedArchetype = CAPABILITY_ARCHETYPES[index];
    if (
      proof === undefined ||
      expectedArchetype === undefined ||
      proof.archetype !== expectedArchetype
    ) {
      failSchema(
        'capability proof suite must carry exactly one proof per archetype',
      );
    }
  }
  const expected = computeCapabilityProofSuiteHash(
    omitHash(suite, 'suiteHash') as Omit<CapabilityProofSuiteV1, 'suiteHash'>,
  );
  if (suite.suiteHash !== expected) {
    failSchema('capability proof suite hash does not match the exact record');
  }
  deepFreeze(suite);
}

export function assertCapabilityProofSummaryRowV1(
  value: unknown,
): asserts value is CapabilityProofSummaryRowV1 {
  assertExactRecord(
    value,
    CAPABILITY_PROOF_SUMMARY_ROW_KEYS,
    'capability proof summary row',
  );
  const row = value as unknown as CapabilityProofSummaryRowV1;
  if (
    !(CAPABILITY_ARCHETYPES as readonly unknown[]).includes(row.archetype) ||
    !(M6_OUTCOME_DECISIONS as readonly unknown[]).includes(row.outcomeDecision) ||
    !isNonNegativeSafeInteger(row.passCriteria) ||
    !isNonNegativeSafeInteger(row.totalCriteria) ||
    row.passCriteria > row.totalCriteria ||
    typeof row.repairExercised !== 'boolean' ||
    !isNonNegativeSafeInteger(row.inputTokens) ||
    !isNonNegativeSafeInteger(row.outputTokens) ||
    !isNonNegativeSafeInteger(row.wallClockMillis) ||
    row.wallClockMillis > MAX_PROOF_WALLCLOCK_MS ||
    !isNonNegativeSafeInteger(row.operatorReviewMillis) ||
    row.operatorReviewMillis > MAX_OPERATOR_REVIEW_MS ||
    !(METRIC_PROVENANCES as readonly unknown[]).includes(row.metricsProvenance)
  ) {
    failSchema('capability proof summary row fields must be valid');
  }
  deepFreeze(row);
}

export function assertCapabilityProofSummaryV1(
  value: unknown,
): asserts value is CapabilityProofSummaryV1 {
  assertExactRecord(
    value,
    CAPABILITY_PROOF_SUMMARY_KEYS,
    'capability proof summary',
  );
  const summary = value as unknown as CapabilityProofSummaryV1;
  if (
    summary.schema !== 'hercules-capability-proof-summary/v1' ||
    !isHash(summary.suiteHash) ||
    !isHash(summary.summaryHash)
  ) {
    failSchema(
      'capability proof summary schema, suiteHash, and summaryHash must be valid',
    );
  }
  assertDenseArray(summary.rows, 'capability proof summary rows');
  if (summary.rows.length !== CAPABILITY_ARCHETYPES.length) {
    failSchema('capability proof summary must carry exactly three rows');
  }
  for (const row of summary.rows) {
    assertCapabilityProofSummaryRowV1(row);
  }
  const expected = computeCapabilityProofSummaryHash(
    omitHash(summary, 'summaryHash') as Omit<
      CapabilityProofSummaryV1,
      'summaryHash'
    >,
  );
  if (summary.summaryHash !== expected) {
    failSchema('capability proof summary hash does not match the exact record');
  }
  deepFreeze(summary);
}

// ---------------------------------------------------------------------------
// Pure assembler
// ---------------------------------------------------------------------------

/**
 * Light schema gate on the TRUSTED, branded {@link ReviewPackageV2} the harness
 * obtains from the real M6 engine. Per the M6 ReviewPackageV2 authority boundary,
 * M12 TRUSTS the branded value and never imports or re-runs
 * `assertReviewPackageV2StructuralConsistency`; this gate only confirms the schema
 * tag and the coarse shape of the fields the assembler binds, so a fabricated
 * non-package fails closed instead of raising a raw TypeError. The exact
 * cross-layer bindings are enforced by the assembler's own precondition checks.
 */
function assertReviewPackageV2SchemaGate(value: ReviewPackageV2): void {
  const record = value as unknown as Record<string, unknown> | null;
  const binding =
    record === null ? null : (record['binding'] as Record<string, unknown> | null);
  if (
    record === null ||
    typeof record !== 'object' ||
    record['schema'] !== 'hercules-review-package/v2' ||
    binding === null ||
    typeof binding !== 'object' ||
    !isHash(binding['contractHash']) ||
    typeof binding['taskId'] !== 'string' ||
    typeof binding['contractVersion'] !== 'number' ||
    !isHash(record['projectionHash']) ||
    !Array.isArray(record['evidence']) ||
    !Array.isArray(record['validDecisions'])
  ) {
    failSchema(
      'trusted review package must carry the hercules-review-package/v2 schema tag and the fields the proof binds',
    );
  }
}

export function assembleCapabilityProof(
  inputs: AssembleCapabilityProofInputsV1,
  now: string,
): CapabilityProofV1 {
  assertInjectedNow(now);
  assertExactRecord(
    inputs,
    ASSEMBLE_CAPABILITY_PROOF_INPUT_KEYS,
    'assemble capability proof inputs',
  );

  if (!(CAPABILITY_ARCHETYPES as readonly unknown[]).includes(inputs.archetype)) {
    failSchema('assemble capability proof archetype must be closed');
  }

  assertTaskContract(inputs.contract);
  assertEvidenceManifest(inputs.evidenceManifest);
  assertReviewPackageV2SchemaGate(inputs.reviewPackage);
  assertIndependentEvaluationReceiptV1(inputs.evaluationReceipt);
  assertJobSpecV1(inputs.jobSpec);
  assertResultPackageV1(inputs.resultPackage);
  assertResultAdmissionV1(inputs.resultAdmission);
  assertControlApiV2RequestV1(inputs.controlCreateRequest);
  assertAdmissionVerdictV1(inputs.controlCreateVerdict);
  assertControlApiV2RequestV1(inputs.controlDecisionRequest);
  assertAdmissionVerdictV1(inputs.controlDecisionVerdict);
  assertCapabilityCostV1(inputs.cost);
  assertCapabilityOperatorReviewV1(inputs.operatorReview);

  if (inputs.routingDecision !== null) {
    assertRoutingDecisionV1(inputs.routingDecision);
  }
  if (inputs.routedEvaluationReceipt !== null) {
    assertIndependentEvaluationReceiptV1(inputs.routedEvaluationReceipt);
  }
  if (inputs.browserEvidenceRef !== null) {
    assertBrowserEvidenceRefV1(inputs.browserEvidenceRef);
  }

  // 1. Spine binding
  const spine = computeTaskContractHash(inputs.contract);
  const createPayload = inputs.controlCreateRequest.payload;
  if (!('kind' in createPayload) || createPayload.kind !== 'create') {
    failPrecondition(
      'inconsistent_contract_binding',
      'control create request payload must be a create payload',
    );
  }
  if (
    spine !== inputs.reviewPackage.binding.contractHash ||
    spine !== inputs.evaluationReceipt.taskContractHash ||
    spine !== inputs.jobSpec.taskContractHash ||
    spine !== createPayload.taskContractHash
  ) {
    failPrecondition(
      'inconsistent_contract_binding',
      'task contract hash does not bind consistently across review, evaluation, job, and create request',
    );
  }

  // 2. M5 ↔ M6 ↔ M8 evidence binding
  const binding = inputs.reviewPackage.binding;
  if (
    inputs.evidenceManifest.id !== binding.evidenceManifestId ||
    inputs.evidenceManifest.manifestHash !== binding.evidenceManifestHash ||
    inputs.evidenceManifest.taskId !== binding.taskId ||
    inputs.evidenceManifest.contractVersion !== binding.contractVersion ||
    inputs.evaluationReceipt.manifestId !== inputs.evidenceManifest.id ||
    inputs.evaluationReceipt.manifestHash !== inputs.evidenceManifest.manifestHash
  ) {
    failPrecondition(
      'inconsistent_contract_binding',
      'evidence manifest does not bind consistently to the review package and evaluation receipt',
    );
  }

  // 3. Copy criterion verdicts verbatim + coverage / dangling checks
  const contractCriterionIds = new Set(
    inputs.contract.acceptanceCriteria.map((criterion) => criterion.id),
  );
  const requiredCriterionIds = new Set(
    inputs.contract.acceptanceCriteria
      .filter((criterion) => criterion.required)
      .map((criterion) => criterion.id),
  );
  const manifestArtifactIds = new Set(
    inputs.evidenceManifest.entries.map((entry) => entry.artifactRefId),
  );

  const copiedVerdicts: CriterionVerdictRefV1[] =
    inputs.evaluationReceipt.verdict.criterionResults.map((result) => ({
      criterionId: result.criterionId,
      status: result.status,
      evidenceRefs: [...result.evidenceRefs],
    }));

  const seenCriterionIds = new Set<string>();
  for (const verdict of copiedVerdicts) {
    if (!contractCriterionIds.has(verdict.criterionId)) {
      failPrecondition(
        'criterion_coverage_mismatch',
        `criterion verdict ${verdict.criterionId} is absent from the contract`,
      );
    }
    if (seenCriterionIds.has(verdict.criterionId)) {
      failPrecondition(
        'criterion_coverage_mismatch',
        `criterion verdict ${verdict.criterionId} is duplicated`,
      );
    }
    seenCriterionIds.add(verdict.criterionId);
    for (const evidenceRef of verdict.evidenceRefs) {
      if (!manifestArtifactIds.has(evidenceRef)) {
        failPrecondition(
          'dangling_evidence_ref',
          `criterion evidence ref ${evidenceRef} is absent from the evidence manifest`,
        );
      }
    }
  }
  for (const requiredId of requiredCriterionIds) {
    if (!seenCriterionIds.has(requiredId)) {
      failPrecondition(
        'criterion_coverage_mismatch',
        `required contract criterion ${requiredId} has no evaluation result`,
      );
    }
  }

  copiedVerdicts.sort((left, right) => {
    if (left.criterionId < right.criterionId) return -1;
    if (left.criterionId > right.criterionId) return 1;
    return 0;
  });
  if (copiedVerdicts.length === 0) {
    failPrecondition(
      'criterion_coverage_mismatch',
      'evaluation receipt produced no criterion verdicts',
    );
  }

  // 4. Browser evidence binding
  const browserExpected = inputs.archetype === 'browser';
  const browserPresent = inputs.browserEvidenceRef !== null;
  if (browserExpected !== browserPresent) {
    failPrecondition(
      'archetype_evidence_mismatch',
      'browserEvidenceRef must be non-null iff archetype is browser',
    );
  }
  if (inputs.browserEvidenceRef !== null) {
    const browserRef = inputs.browserEvidenceRef;
    if (!manifestArtifactIds.has(browserRef.artifactRefId)) {
      failPrecondition(
        'archetype_evidence_mismatch',
        'browserEvidenceRef artifactRefId is absent from the evidence manifest',
      );
    }
    const projected = inputs.reviewPackage.evidence.find(
      (entry) => entry.artifactRefId === browserRef.artifactRefId,
    );
    if (projected === undefined || projected.sha256 !== browserRef.sha256) {
      failPrecondition(
        'archetype_evidence_mismatch',
        'browserEvidenceRef sha256 does not match the review package evidence projection',
      );
    }
  }

  // 5. Repair two-receipt binding
  const repairExercised =
    inputs.routingDecision !== null && inputs.routedEvaluationReceipt !== null;
  if (
    (inputs.routingDecision !== null) !==
      (inputs.routedEvaluationReceipt !== null) ||
    (inputs.routingDecision !== null) !== repairExercised
  ) {
    failPrecondition(
      'repair_binding_mismatch',
      'repairExercised requires both routingDecision and routedEvaluationReceipt, or neither',
    );
  }

  let routingDecisionHash: string | null = null;
  let routedEvaluationReceiptHash: string | null = null;
  if (repairExercised) {
    const routingDecision = inputs.routingDecision;
    const routedReceipt = inputs.routedEvaluationReceipt;
    if (routingDecision === null || routedReceipt === null) {
      failPrecondition(
        'repair_binding_mismatch',
        'repairExercised requires both routingDecision and routedEvaluationReceipt',
      );
    }
    if (
      routingDecision.route !== 'repair' ||
      routingDecision.receiptId !== routedReceipt.receiptId ||
      routingDecision.taskId !== routedReceipt.taskId ||
      routedReceipt.taskContractHash !== spine ||
      routedReceipt.taskId !== inputs.evaluationReceipt.taskId ||
      routedReceipt.taskId !== inputs.reviewPackage.binding.taskId ||
      routedReceipt.taskId !== inputs.evidenceManifest.taskId ||
      routedReceipt.iterationId === inputs.evaluationReceipt.iterationId
    ) {
      failPrecondition(
        'repair_binding_mismatch',
        'routing decision does not bind the pre-repair receipt on the same task and spine',
      );
    }
    routingDecisionHash = routingDecision.decisionHash;
    routedEvaluationReceiptHash = routedReceipt.receiptHash;
  }

  // 6. Worker boundary binding
  if (
    inputs.jobSpec.taskContractHash !== spine ||
    inputs.resultPackage.jobSpecHash !== inputs.jobSpec.jobSpecHash ||
    inputs.resultAdmission.resultId !== inputs.resultPackage.resultId ||
    inputs.resultAdmission.resultHash !== inputs.resultPackage.resultHash ||
    inputs.resultAdmission.outcome !== 'admitted'
  ) {
    failPrecondition(
      'inconsistent_contract_binding',
      'worker job spec, result package, and admission do not bind consistently',
    );
  }

  // 7. Outcome / Control API V2 admission binding
  if (
    inputs.controlCreateVerdict.requestHash !==
      inputs.controlCreateRequest.requestHash ||
    inputs.controlDecisionVerdict.requestHash !==
      inputs.controlDecisionRequest.requestHash
  ) {
    failPrecondition(
      'outcome_binding_mismatch',
      'admission verdict requestHash does not bind its request',
    );
  }
  const createKey = inputs.controlCreateRequest.idempotencyKey;
  if (createKey === null) {
    failPrecondition(
      'outcome_binding_mismatch',
      'control create request must carry an idempotency key',
    );
  }
  const derivedAggregateId = deriveAggregateId(createKey.keyHash);
  if (
    inputs.controlCreateVerdict.aggregateId !== derivedAggregateId ||
    inputs.controlDecisionRequest.aggregateId !== derivedAggregateId
  ) {
    failPrecondition(
      'outcome_binding_mismatch',
      'create verdict aggregate does not match deriveAggregateId or the decision target',
    );
  }
  const decisionPayload = inputs.controlDecisionRequest.payload;
  if (!('kind' in decisionPayload) || decisionPayload.kind !== 'decision') {
    failPrecondition(
      'outcome_binding_mismatch',
      'control decision request payload must be a decision action',
    );
  }
  const outcomeDecision = decisionPayload.action;
  if (!inputs.reviewPackage.validDecisions.includes(outcomeDecision)) {
    failPrecondition(
      'outcome_binding_mismatch',
      'decision action is not in the review package validDecisions',
    );
  }

  // 8–9. Record metrics and seal
  const withoutHash: Omit<CapabilityProofV1, 'proofHash'> = {
    schema: 'hercules-capability-proof/v1',
    archetype: inputs.archetype,
    taskContractHash: spine,
    evidenceManifestId: inputs.evidenceManifest.id,
    evidenceManifestHash: inputs.evidenceManifest.manifestHash,
    reviewProjectionHash: inputs.reviewPackage.projectionHash,
    browserEvidenceRef: inputs.browserEvidenceRef,
    evaluationReceiptHash: inputs.evaluationReceipt.receiptHash,
    criterionVerdicts: copiedVerdicts,
    repairExercised,
    routingDecisionHash,
    routedEvaluationReceiptHash,
    workerJobSpecHash: inputs.jobSpec.jobSpecHash,
    workerResultAdmissionHash: inputs.resultAdmission.admissionHash,
    controlCreateVerdictHash: inputs.controlCreateVerdict.verdictHash,
    controlDecisionVerdictHash: inputs.controlDecisionVerdict.verdictHash,
    outcomeDecision,
    cost: inputs.cost,
    operatorReview: inputs.operatorReview,
  };
  const proof: CapabilityProofV1 = {
    ...withoutHash,
    proofHash: computeCapabilityProofHash(withoutHash),
  };
  assertCapabilityProofV1(proof);
  return proof;
}

export function assembleCapabilityProofSuite(
  proofs: readonly CapabilityProofV1[],
  mainSha: string,
  now: string,
): CapabilityProofSuiteV1 {
  assertInjectedNow(now);
  if (!isGitSha(mainSha)) {
    failSchema('suite builtAgainstMainSha must be a 40-hex git SHA');
  }
  assertDenseArray(proofs, 'capability proof suite proofs input');
  for (const proof of proofs) {
    assertCapabilityProofV1(proof);
  }

  const sorted = [...proofs].sort((left, right) =>
    compareArchetype(left.archetype, right.archetype),
  );
  if (sorted.length !== CAPABILITY_ARCHETYPES.length) {
    failPrecondition(
      'archetype_coverage_incomplete',
      'capability proof suite must carry exactly three proofs',
    );
  }
  const coverage = sorted.map((proof) => proof.archetype);
  for (let index = 0; index < CAPABILITY_ARCHETYPES.length; index += 1) {
    if (coverage[index] !== CAPABILITY_ARCHETYPES[index]) {
      failPrecondition(
        'archetype_coverage_incomplete',
        'capability proof suite must carry exactly one proof per archetype',
      );
    }
  }

  const withoutHash: Omit<CapabilityProofSuiteV1, 'suiteHash'> = {
    schema: 'hercules-capability-proof-suite/v1',
    builtAgainstMainSha: mainSha,
    proofs: sorted,
    archetypeCoverage: [...CAPABILITY_ARCHETYPES],
  };
  const suite: CapabilityProofSuiteV1 = {
    ...withoutHash,
    suiteHash: computeCapabilityProofSuiteHash(withoutHash),
  };
  assertCapabilityProofSuiteV1(suite);
  return suite;
}

export function summarizeCapabilityProofSuite(
  suite: CapabilityProofSuiteV1,
): CapabilityProofSummaryV1 {
  assertCapabilityProofSuiteV1(suite);
  const rows: CapabilityProofSummaryRowV1[] = suite.proofs.map((proof) => {
    const passCriteria = proof.criterionVerdicts.filter(
      (verdict) => verdict.status === 'pass',
    ).length;
    return {
      archetype: proof.archetype,
      outcomeDecision: proof.outcomeDecision,
      passCriteria,
      totalCriteria: proof.criterionVerdicts.length,
      repairExercised: proof.repairExercised,
      inputTokens: proof.cost.inputTokens,
      outputTokens: proof.cost.outputTokens,
      wallClockMillis: proof.cost.wallClockMillis,
      operatorReviewMillis: proof.operatorReview.millis,
      metricsProvenance: proof.cost.provenance,
    };
  });
  const withoutHash: Omit<CapabilityProofSummaryV1, 'summaryHash'> = {
    schema: 'hercules-capability-proof-summary/v1',
    suiteHash: suite.suiteHash,
    rows,
  };
  const summary: CapabilityProofSummaryV1 = {
    ...withoutHash,
    summaryHash: computeCapabilityProofSummaryHash(withoutHash),
  };
  assertCapabilityProofSummaryV1(summary);
  return summary;
}
