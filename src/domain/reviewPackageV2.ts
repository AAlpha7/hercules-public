import {
  assertEvidenceManifestArtifacts,
  candidateRefsEqual,
  type ArtifactRef,
  type ArtifactRedactionState,
  type ArtifactTrustClass,
  type CandidateRef,
  type EvidenceManifest,
} from './artifact.js';
import { canonicalSerialize, hashCanonicalJson } from './canonicalJson.js';
import {
  assertAssertionVerificationReceiptShape,
  assertClaimAuthorityContext,
  assertDecisionAssertion,
  assertEvidenceIntegrityAttestation,
  computeVerificationReceiptHash,
  type AssertionVerificationReceipt,
  type ClaimAuthorityContext,
  type DecisionAssertion,
  type EvidenceIntegrityAttestation,
} from './claimAuthorityV2.js';
import { assertTaskContractHash } from './contractHash.js';
import {
  assertDecisionBindingIdentity,
  assertEvaluationVerdictBinding,
  decisionBindingsEqual,
  type DecisionBinding,
  type EvaluationBinding,
  type EvaluationVerdict,
} from './evaluationVerdict.js';
import { assertHumanDecisionBinding, type HumanDecision } from './humanDecision.js';
import { transitionIteration, type Iteration } from './iteration.js';
import type { CriterionAuthority, TaskContract } from './taskContract.js';

export type AssertionClassification =
  | 'verified'
  | 'inference'
  | 'unverified_pending'
  | 'opinion';

export interface AssertionPremiseSet {
  readonly key: string;
  readonly assertionIds: readonly string[];
}

export interface EvaluationDecisionRecordV2 {
  readonly schema: 'hercules-evaluation-decision/v2';
  readonly verdict: EvaluationVerdict;
  readonly criterionPremises: readonly AssertionPremiseSet[];
  readonly findingPremises: readonly AssertionPremiseSet[];
  readonly outcomeAssertionIds: readonly string[];
  readonly nextStageAssertionIds: readonly string[];
}

export interface ReviewTaskIdentity {
  readonly id: string;
  readonly title: string;
  readonly state: string;
}

export interface ReviewUsageSummary {
  readonly durationMs: number;
  readonly tokens: number;
  readonly costUsd: number;
}

export interface ReviewPackageV2Source {
  readonly task: ReviewTaskIdentity;
  readonly currentBinding: DecisionBinding;
  readonly contract: TaskContract;
  readonly currentIteration: Iteration;
  readonly iterationHistory: readonly Iteration[];
  readonly evidenceManifest: EvidenceManifest | null;
  readonly artifacts: readonly ArtifactRef[];
  readonly evidenceIntegrity: EvidenceIntegrityAttestation;
  readonly assertions: readonly DecisionAssertion[];
  readonly verificationReceipts: readonly AssertionVerificationReceipt[];
  readonly evaluation: EvaluationDecisionRecordV2 | null;
  readonly humanDecisions: readonly HumanDecision[];
  readonly authorityContext: ClaimAuthorityContext;
  readonly usage: ReviewUsageSummary | null;
  readonly projectedAt: string;
}

export const REVIEW_REASON_CODES = [
  'integrity_unavailable',
  'evidence_missing',
  'evidence_tampered',
  'non_primary_evidence',
  'self_report',
  'receipt_missing',
  'receipt_stale',
  'receipt_hash_mismatch',
  'assertion_binding_mismatch',
  'receipt_coverage_mismatch',
  'observation_mismatch',
  'value_mismatch',
  'structured_contradiction',
  'evaluation_missing',
  'evaluation_stale',
  'evaluation_incomplete',
  'evaluation_premise_ineligible',
  'criterion_failed',
  'blocking_finding',
  'human_decision_required',
  'human_decision_stale',
  'human_decision_conflict',
  'human_rejected',
  'unsupported_policy_decision',
  'review_axis_deferred',
] as const;

export type ReviewReasonCode = (typeof REVIEW_REASON_CODES)[number];
export type ReviewAxisStatus =
  | 'verified'
  | 'failed'
  | 'need_more_evidence'
  | 'needs_human'
  | 'not_applicable';

export interface ReviewBindingV2 {
  readonly taskId: string;
  readonly contractVersion: number;
  readonly contractHash: string;
  readonly iterationId: string;
  readonly candidateRef: CandidateRef | null;
  readonly evidenceManifestId: string | null;
  readonly evidenceManifestHash: string | null;
  readonly evaluatorVersion: string;
  readonly evaluatorModel: string | null;
  readonly evaluatorRuntime: string;
  readonly policyVersion: string;
}

export interface AssertionProjection {
  readonly id: string;
  readonly subjectKey: string;
  readonly payloadHash: string;
  readonly classification: AssertionClassification;
  readonly decisionEligible: boolean;
  readonly usedByCriterionIds: readonly string[];
  readonly evidenceArtifactIds: readonly string[];
  readonly receiptIds: readonly string[];
  readonly reasonCodes: readonly ReviewReasonCode[];
  readonly advisoryText: string | null;
}

export interface ReviewTrustAxis {
  readonly status: ReviewAxisStatus;
  readonly assertionIds: readonly string[];
  readonly evidenceArtifactIds: readonly string[];
  readonly reasonCodes: readonly ReviewReasonCode[];
}

export interface ReviewTrustAxes {
  readonly contractBinding: ReviewTrustAxis;
  readonly mechanical: ReviewTrustAxis;
  readonly realSurface: ReviewTrustAxis;
  readonly independentReview: ReviewTrustAxis;
  readonly independentEvaluation: ReviewTrustAxis;
  readonly human: ReviewTrustAxis;
}

export interface CriterionResultViewV2 {
  readonly criterionId: string;
  readonly authority: CriterionAuthority;
  readonly required: boolean;
  readonly status:
    | 'pass'
    | 'fail'
    | 'need_more_evidence'
    | 'needs_human'
    | 'not_applicable';
  readonly assertionIds: readonly string[];
  readonly evidenceArtifactIds: readonly string[];
  readonly reasonCodes: readonly ReviewReasonCode[];
  readonly advisoryExplanation: string;
}

export interface EvidenceSummaryV2 {
  readonly artifactRefId: string;
  readonly sha256: string;
  readonly trustClass: ArtifactTrustClass;
  readonly redactionState: ArtifactRedactionState;
  readonly criterionIds: readonly string[];
  readonly surface: string;
  readonly supportsAssertionIds: readonly string[];
}

export interface FindingViewV2 {
  readonly code: string;
  readonly criterionIds: readonly string[];
  readonly assertionIds: readonly string[];
  readonly classification: 'verified' | 'unverified_pending';
  readonly reasonCodes: readonly ReviewReasonCode[];
  readonly advisorySummary: string;
}

export interface IterationSummaryV2 {
  readonly id: string;
  readonly ordinal: number;
  readonly state: Iteration['state'];
  readonly candidateRef: CandidateRef | null;
  readonly evidenceManifestId: string | null;
  readonly finalVerdictId: string | null;
  readonly createdAt: string;
  readonly endedAt: string | null;
}

export type M6OutcomeDecision =
  | 'approve_outcome'
  | 'reject_outcome'
  | 'request_changes';

export interface RequiredDecisionV2 {
  readonly kinds: readonly M6OutcomeDecision[];
  readonly policyDecisionIds: readonly string[];
  readonly reasonCodes: readonly ReviewReasonCode[];
}

export interface ReviewPackageV2 {
  readonly schema: 'hercules-review-package/v2';
  readonly projectionHash: string;
  readonly projectedAt: string;
  readonly task: {
    readonly id: string;
    readonly title: string;
    readonly objective: string;
    readonly state: string;
    readonly advisoryTextAuthority: 'advisory';
  };
  readonly binding: ReviewBindingV2;
  readonly outcome: {
    readonly status: 'pass' | 'fail' | 'need_more_evidence' | 'needs_human';
    readonly evaluatorOutcome: 'pass' | 'fail' | 'need_more_evidence' | null;
    readonly decisionEligible: boolean;
    readonly reasonCodes: readonly ReviewReasonCode[];
    readonly advisorySummary: string;
  };
  readonly assertions: readonly AssertionProjection[];
  readonly trustAxes: ReviewTrustAxes;
  readonly criteria: readonly CriterionResultViewV2[];
  readonly evidence: readonly EvidenceSummaryV2[];
  readonly blockingFindings: readonly FindingViewV2[];
  readonly remainingRisks: readonly FindingViewV2[];
  readonly iterations: readonly IterationSummaryV2[];
  readonly requiredDecision: RequiredDecisionV2 | null;
  readonly validDecisions: readonly M6OutcomeDecision[];
  readonly decisionBinding: DecisionBinding | null;
  readonly decisionToken: null;
  readonly usage: ReviewUsageSummary | null;
}

declare const sourceProjectedReviewPackageV2Brand: unique symbol;

/**
 * A package projected from a validated source record in this module. The brand
 * prevents accidental DTO reuse; trusted port ownership establishes authority.
 */
export type SourceProjectedReviewPackageV2 = ReviewPackageV2 & {
  readonly [sourceProjectedReviewPackageV2Brand]: true;
};

export type ReviewPackageV2ErrorCode = 'invalid_source' | 'invalid_package';

export class ReviewPackageV2Error extends Error {
  override readonly name = 'ReviewPackageV2Error';

  constructor(
    readonly code: ReviewPackageV2ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const SOURCE_KEYS = [
  'task',
  'currentBinding',
  'contract',
  'currentIteration',
  'iterationHistory',
  'evidenceManifest',
  'artifacts',
  'evidenceIntegrity',
  'assertions',
  'verificationReceipts',
  'evaluation',
  'humanDecisions',
  'authorityContext',
  'usage',
  'projectedAt',
] as const;

const PACKAGE_KEYS = [
  'schema',
  'projectionHash',
  'projectedAt',
  'task',
  'binding',
  'outcome',
  'assertions',
  'trustAxes',
  'criteria',
  'evidence',
  'blockingFindings',
  'remainingRisks',
  'iterations',
  'requiredDecision',
  'validDecisions',
  'decisionBinding',
  'decisionToken',
  'usage',
] as const;

const AXIS_KEYS = [
  'contractBinding',
  'mechanical',
  'realSurface',
  'independentReview',
  'independentEvaluation',
  'human',
] as const;

const OUTCOME_DECISIONS = [
  'approve_outcome',
  'reject_outcome',
  'request_changes',
] as const;

const REQUEST_CHANGES_ONLY = ['request_changes'] as const;

const DECISION_BLOCKING_REASONS: readonly ReviewReasonCode[] = [
  'integrity_unavailable',
  'evidence_missing',
  'evidence_tampered',
  'non_primary_evidence',
  'self_report',
  'receipt_missing',
  'receipt_stale',
  'receipt_hash_mismatch',
  'assertion_binding_mismatch',
  'receipt_coverage_mismatch',
  'observation_mismatch',
  'value_mismatch',
  'structured_contradiction',
  'evaluation_missing',
  'evaluation_stale',
  'evaluation_incomplete',
  'evaluation_premise_ineligible',
  'human_decision_conflict',
  'unsupported_policy_decision',
];

const ACTIONABLE_FAIL_REASONS: readonly ReviewReasonCode[] = [
  'criterion_failed',
  'blocking_finding',
  'human_rejected',
];

const MAX_IDENTIFIER_BYTES = 256;
const MAX_TEXT_BYTES = 8 * 1024;
const MAX_ARRAY_ITEMS = 4_096;

function fail(code: ReviewPackageV2ErrorCode, message: string): never {
  throw new ReviewPackageV2Error(code, message);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    utf8Bytes(value) >= 1 &&
    utf8Bytes(value) <= MAX_IDENTIFIER_BYTES
  );
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && utf8Bytes(value) <= MAX_TEXT_BYTES;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || utf8Bytes(value) > MAX_IDENTIFIER_BYTES) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function assertCanonicalRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Readonly<Record<string, unknown>> {
  try {
    canonicalSerialize(value);
  } catch (error) {
    fail('invalid_source', `${label} must be stable canonical JSON: ${String(error)}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_source', `${label} must be an object`);
  }
  const actual = Object.getOwnPropertyNames(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail('invalid_source', `${label} must use the exact closed schema`);
  }
}

function assertPackageRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_package', `${label} must be an object`);
  }
  const actual = Object.getOwnPropertyNames(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail('invalid_package', `${label} must use the exact closed schema`);
  }
}

function assertPackageStringArray(
  value: unknown,
  label: string,
): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) {
    fail('invalid_package', `${label} must be a bounded array`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || !isIdentifier(value[index])) {
      fail('invalid_package', `${label} must contain bounded identities`);
    }
  }
}

function assertSortedUniquePackageIds(value: unknown, label: string): void {
  assertPackageStringArray(value, label);
  if (!sameStrings(value, sortedUnique(value))) {
    fail('invalid_package', `${label} must be sorted and unique`);
  }
}

function assertReasonCodes(value: unknown, label: string): void {
  if (!Array.isArray(value)) {
    fail('invalid_package', `${label} must be a reason array`);
  }
  if (
    value.some(
      (reason) => !(REVIEW_REASON_CODES as readonly unknown[]).includes(reason),
    )
  ) {
    fail('invalid_package', `${label} contains an unknown reason code`);
  }
  const reasons = value as ReviewReasonCode[];
  if (canonicalSerialize(reasons) !== canonicalSerialize(orderReasons(reasons))) {
    fail('invalid_package', `${label} must contain unique reasons in declared order`);
  }
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return canonicalSerialize(left) === canonicalSerialize(right);
}

function orderReasons(values: Iterable<ReviewReasonCode>): ReviewReasonCode[] {
  const selected = new Set(values);
  return REVIEW_REASON_CODES.filter((reason) => selected.has(reason));
}

function validateStringArray(
  value: unknown,
  label: string,
  unique = true,
): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) {
    fail('invalid_source', `${label} must be a bounded array`);
  }
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || !isIdentifier(value[index])) {
      fail('invalid_source', `${label} must contain bounded identities`);
    }
    if (unique && seen.has(value[index])) {
      fail('invalid_source', `${label} identities must be unique`);
    }
    seen.add(value[index]);
  }
}

function assertCandidateSnapshot(
  candidate: CandidateRef,
  code: ReviewPackageV2ErrorCode,
  label: string,
): void {
  const keys =
    candidate.kind === 'git'
      ? (['kind', 'repository', 'revision'] as const)
      : candidate.kind === 'artifact'
        ? (['kind', 'artifactId', 'sha256'] as const)
        : candidate.kind === 'external'
          ? (['kind', 'system', 'version', 'digest'] as const)
          : null;
  if (keys === null) fail(code, `${label} kind is invalid`);
  if (code === 'invalid_source') {
    assertCanonicalRecord(candidate, keys, label);
  } else {
    assertPackageRecord(candidate, keys, label);
  }
  const fields =
    candidate.kind === 'git'
      ? [candidate.repository, candidate.revision]
      : candidate.kind === 'artifact'
        ? [candidate.artifactId, candidate.sha256]
        : [candidate.system, candidate.version, candidate.digest];
  if (fields.some((field) => !isIdentifier(field))) {
    fail(code, `${label} identity fields are invalid`);
  }
}

const DECISION_BINDING_KEYS = [
  'taskId',
  'contractVersion',
  'contractHash',
  'iterationId',
  'candidateRef',
  'evidenceManifestHash',
  'evaluatorVersion',
  'evaluatorModel',
  'evaluatorRuntime',
  'policyVersion',
] as const;

function assertDecisionBindingSnapshot(
  binding: DecisionBinding,
  code: ReviewPackageV2ErrorCode,
  label: string,
): void {
  if (code === 'invalid_source') {
    assertCanonicalRecord(binding, DECISION_BINDING_KEYS, label);
  } else {
    assertPackageRecord(binding, DECISION_BINDING_KEYS, label);
  }
  if (
    !isIdentifier(binding.taskId) ||
    !Number.isSafeInteger(binding.contractVersion) ||
    binding.contractVersion < 1 ||
    !isIdentifier(binding.contractHash) ||
    !(binding.iterationId === null || isIdentifier(binding.iterationId)) ||
    !(binding.evidenceManifestHash === null || isIdentifier(binding.evidenceManifestHash)) ||
    !isIdentifier(binding.evaluatorVersion) ||
    !(binding.evaluatorModel === null || isIdentifier(binding.evaluatorModel)) ||
    !isIdentifier(binding.evaluatorRuntime) ||
    !isIdentifier(binding.policyVersion)
  ) {
    fail(code, `${label} identity fields are invalid`);
  }
  if (binding.candidateRef !== null) {
    assertCandidateSnapshot(binding.candidateRef, code, `${label} candidate`);
  }
  try {
    assertDecisionBindingIdentity(binding);
  } catch (error) {
    fail(code, `${label} identity is invalid: ${String(error)}`);
  }
}

function manifestHash(manifest: EvidenceManifest): string {
  const { manifestHash: _manifestHash, ...withoutHash } = manifest;
  return hashCanonicalJson(withoutHash);
}

function receiptHash(receipt: AssertionVerificationReceipt): string {
  const { receiptHash: _receiptHash, ...withoutHash } = receipt;
  return computeVerificationReceiptHash(withoutHash);
}

function assertIterationHistory(source: ReviewPackageV2Source): void {
  if (
    !Array.isArray(source.iterationHistory) ||
    source.iterationHistory.length === 0 ||
    source.iterationHistory.length > MAX_ARRAY_ITEMS
  ) {
    fail('invalid_source', 'iteration history must be a bounded non-empty array');
  }
  const ids = new Set<string>();
  let previous: Iteration | null = null;
  for (const iteration of source.iterationHistory) {
    try {
      transitionIteration(iteration, iteration.state, iteration.endedAt);
    } catch (error) {
      fail('invalid_source', `iteration history is invalid: ${String(error)}`);
    }
    if (
      ids.has(iteration.id) ||
      iteration.taskId !== source.task.id ||
      iteration.ordinal !== (previous?.ordinal ?? 0) + 1 ||
      iteration.supersedesIterationId !== (previous?.id ?? null) ||
      (previous !== null && previous.state !== 'failed')
    ) {
      fail('invalid_source', 'iteration history identity and supersession must be contiguous');
    }
    ids.add(iteration.id);
    previous = iteration;
  }
  if (
    canonicalSerialize(source.currentIteration) !==
    canonicalSerialize(source.iterationHistory[source.iterationHistory.length - 1])
  ) {
    fail('invalid_source', 'current iteration must equal the unique history tip');
  }
}

function assertUsage(
  usage: ReviewUsageSummary | null,
  code: ReviewPackageV2ErrorCode,
): void {
  if (usage === null) return;
  if (code === 'invalid_source') {
    assertCanonicalRecord(usage, ['durationMs', 'tokens', 'costUsd'], 'review usage');
  } else {
    assertPackageRecord(usage, ['durationMs', 'tokens', 'costUsd'], 'review usage');
  }
  if (
    !Number.isFinite(usage.durationMs) ||
    usage.durationMs < 0 ||
    !Number.isFinite(usage.tokens) ||
    usage.tokens < 0 ||
    !Number.isFinite(usage.costUsd) ||
    usage.costUsd < 0
  ) {
    fail(code, 'review usage values must be finite and non-negative');
  }
}

function assertSourceTuple(source: ReviewPackageV2Source): void {
  assertCanonicalRecord(source, SOURCE_KEYS, 'review package source');
  assertCanonicalRecord(source.task, ['id', 'title', 'state'], 'review task');
  if (
    !isIdentifier(source.task.id) ||
    !isText(source.task.title) ||
    !isIdentifier(source.task.state) ||
    !isText(source.contract.objective) ||
    !isCanonicalTimestamp(source.projectedAt)
  ) {
    fail('invalid_source', 'task fields and projected timestamp exceed M6 bounds');
  }
  try {
    assertTaskContractHash(source.contract);
  } catch (error) {
    fail('invalid_source', `contract or binding is invalid: ${String(error)}`);
  }
  assertDecisionBindingSnapshot(source.currentBinding, 'invalid_source', 'current binding');
  if (
    source.task.id !== source.contract.taskId ||
    source.task.id !== source.currentBinding.taskId ||
    source.contract.version !== source.currentBinding.contractVersion ||
    source.contract.contractHash !== source.currentBinding.contractHash
  ) {
    fail('invalid_source', 'task, contract, and decision binding identities must agree');
  }
  assertIterationHistory(source);
  if (
    source.currentIteration.taskId !== source.task.id ||
    source.currentIteration.contractVersion !== source.contract.version ||
    source.currentBinding.iterationId !== source.currentIteration.id ||
    ((source.currentBinding.candidateRef === null) !==
      (source.currentIteration.candidateRef === null)) ||
    (source.currentBinding.candidateRef !== null &&
      source.currentIteration.candidateRef !== null &&
      !candidateRefsEqual(
        source.currentBinding.candidateRef,
        source.currentIteration.candidateRef,
      ))
  ) {
    fail('invalid_source', 'current iteration and decision binding must identify one tuple');
  }
  if (source.evidenceManifest === null) {
    if (
      source.currentIteration.evidenceManifestId !== null ||
      source.currentBinding.evidenceManifestHash !== null
    ) {
      fail('invalid_source', 'missing manifest requires null iteration and binding facts');
    }
  } else {
    try {
      assertEvidenceManifestArtifacts(source.evidenceManifest, source.artifacts);
    } catch (error) {
      fail('invalid_source', `manifest or artifacts are invalid: ${String(error)}`);
    }
    if (
      manifestHash(source.evidenceManifest) !== source.evidenceManifest.manifestHash ||
      source.evidenceManifest.id !== source.currentIteration.evidenceManifestId ||
      source.evidenceManifest.manifestHash !== source.currentBinding.evidenceManifestHash ||
      source.evidenceManifest.taskId !== source.task.id ||
      source.evidenceManifest.contractVersion !== source.contract.version ||
      source.evidenceManifest.iterationId !== source.currentIteration.id ||
      source.currentBinding.candidateRef === null ||
      !candidateRefsEqual(
        source.evidenceManifest.candidateRef,
        source.currentBinding.candidateRef,
      )
    ) {
      fail('invalid_source', 'manifest does not match the exact current tuple and hash');
    }
  }
  assertUsage(source.usage, 'invalid_source');
}

interface IntegrityProjection {
  readonly result: EvidenceIntegrityAttestation['result'];
  readonly intact: boolean;
}

function validateIntegrity(source: ReviewPackageV2Source): IntegrityProjection {
  try {
    assertEvidenceIntegrityAttestation(source.evidenceIntegrity);
  } catch (error) {
    fail('invalid_source', `integrity attestation is invalid: ${String(error)}`);
  }
  const attestation = source.evidenceIntegrity;
  if (attestation.result !== 'intact') {
    return { result: attestation.result, intact: false };
  }
  const manifest = source.evidenceManifest;
  const candidate = source.currentBinding.candidateRef;
  const checked = new Map(
    attestation.checkedArtifacts.map((item) => [item.artifactRefId, item.sha256] as const),
  );
  const artifacts = new Map(source.artifacts.map((item) => [item.id, item] as const));
  const intact =
    manifest !== null &&
    candidate !== null &&
    attestation.evidenceManifestId === manifest.id &&
    attestation.evidenceManifestHash === manifest.manifestHash &&
    attestation.candidateRef !== null &&
    candidateRefsEqual(attestation.candidateRef, candidate) &&
    manifest.entries.every((entry) => {
      const artifact = artifacts.get(entry.artifactRefId);
      return artifact !== undefined && checked.get(entry.artifactRefId) === artifact.sha256;
    });
  if (!intact) {
    fail('invalid_source', 'intact attestation contradicts current manifest inventory');
  }
  return { result: 'intact', intact: true };
}

function assertEvaluationShape(evaluation: EvaluationDecisionRecordV2): void {
  assertCanonicalRecord(
    evaluation,
    [
      'schema',
      'verdict',
      'criterionPremises',
      'findingPremises',
      'outcomeAssertionIds',
      'nextStageAssertionIds',
    ],
    'evaluation decision record',
  );
  if (
    evaluation.schema !== 'hercules-evaluation-decision/v2' ||
    !Array.isArray(evaluation.criterionPremises) ||
    !Array.isArray(evaluation.findingPremises)
  ) {
    fail('invalid_source', 'evaluation record schema and premise arrays are invalid');
  }
  validateStringArray(evaluation.outcomeAssertionIds, 'evaluation outcome assertions');
  validateStringArray(evaluation.nextStageAssertionIds, 'evaluation next-stage assertions');
  assertCanonicalRecord(
    evaluation.verdict,
    [
      'id',
      'binding',
      'outcome',
      'criterionResults',
      'blockingFindings',
      'nonBlockingRisks',
      'recommendedNextStage',
      'evaluatorAgentRunId',
      'createdAt',
    ],
    'evaluation verdict',
  );
  if (
    !isIdentifier(evaluation.verdict.id) ||
    !(['pass', 'fail', 'need_more_evidence'] as const).includes(
      evaluation.verdict.outcome,
    ) ||
    !(['complete', 'repair', 'reverify', 'request_contract_change', 'escalate_human'] as const).includes(
      evaluation.verdict.recommendedNextStage,
    ) ||
    !(
      evaluation.verdict.evaluatorAgentRunId === null ||
      isIdentifier(evaluation.verdict.evaluatorAgentRunId)
    ) ||
    !isCanonicalTimestamp(evaluation.verdict.createdAt)
  ) {
    fail('invalid_source', 'evaluation verdict scalar fields are invalid');
  }
  for (const [label, rows] of [
    ['evaluation criterion results', evaluation.verdict.criterionResults],
    ['evaluation blocking findings', evaluation.verdict.blockingFindings],
    ['evaluation remaining risks', evaluation.verdict.nonBlockingRisks],
  ] as const) {
    if (!Array.isArray(rows) || rows.length > MAX_ARRAY_ITEMS) {
      fail('invalid_source', `${label} must be a bounded array`);
    }
    for (let index = 0; index < rows.length; index += 1) {
      if (!(index in rows)) fail('invalid_source', `${label} cannot be sparse`);
    }
  }
  const criterionIds = new Set<string>();
  for (const result of evaluation.verdict.criterionResults) {
    assertCanonicalRecord(
      result,
      [
        'criterionId',
        'status',
        'authority',
        'evidenceRefs',
        'observedAt',
        'candidateBinding',
        'explanation',
      ],
      'evaluation criterion result',
    );
    if (
      !isIdentifier(result.criterionId) ||
      criterionIds.has(result.criterionId) ||
      !(['pass', 'fail', 'pending', 'not_applicable', 'insufficient_evidence'] as const).includes(
        result.status,
      ) ||
      !(['mechanical', 'verifier', 'evaluator', 'human'] as const).includes(
        result.authority,
      ) ||
      !(result.observedAt === null || isCanonicalTimestamp(result.observedAt)) ||
      !isText(result.candidateBinding) ||
      !isText(result.explanation)
    ) {
      fail('invalid_source', 'evaluation criterion result fields are invalid');
    }
    validateStringArray(result.evidenceRefs, 'evaluation criterion evidence refs');
    criterionIds.add(result.criterionId);
  }
  const findingCodes = new Set<string>();
  for (const finding of [
    ...evaluation.verdict.blockingFindings,
    ...evaluation.verdict.nonBlockingRisks,
  ]) {
    assertCanonicalRecord(
      finding,
      ['code', 'summary', 'criterionIds'],
      'evaluation finding',
    );
    if (
      !isIdentifier(finding.code) ||
      findingCodes.has(finding.code) ||
      !isText(finding.summary)
    ) {
      fail('invalid_source', 'evaluation finding fields are invalid');
    }
    validateStringArray(finding.criterionIds, 'evaluation finding criterion ids');
    findingCodes.add(finding.code);
  }
  assertDecisionBindingSnapshot(
    evaluation.verdict.binding,
    'invalid_source',
    'evaluation binding',
  );
  for (const [label, rows] of [
    ['criterion premises', evaluation.criterionPremises],
    ['finding premises', evaluation.findingPremises],
  ] as const) {
    if (rows.length > MAX_ARRAY_ITEMS) {
      fail('invalid_source', `${label} exceed the M6 array bound`);
    }
    const keys = new Set<string>();
    for (const row of rows) {
      assertCanonicalRecord(row, ['key', 'assertionIds'], label);
      const key = row['key'];
      const assertionIds = row['assertionIds'];
      if (!isIdentifier(key) || keys.has(key)) {
        fail('invalid_source', `${label} keys must be bounded and unique`);
      }
      validateStringArray(assertionIds, `${label} assertion ids`);
      keys.add(key);
    }
  }
}

interface EvaluationState {
  readonly kind: 'complete' | 'missing' | 'stale' | 'incomplete';
  readonly evaluation: EvaluationDecisionRecordV2 | null;
  readonly criterionPremises: ReadonlyMap<string, readonly string[]>;
  readonly findingPremises: ReadonlyMap<string, readonly string[]>;
  readonly usedByCriterionIds: ReadonlyMap<string, readonly string[]>;
}

function emptyEvaluationState(kind: 'missing' | 'stale' | 'incomplete'): EvaluationState {
  return {
    kind,
    evaluation: null,
    criterionPremises: new Map(),
    findingPremises: new Map(),
    usedByCriterionIds: new Map(),
  };
}

function evaluationState(source: ReviewPackageV2Source): EvaluationState {
  if (source.evaluation !== null) assertEvaluationShape(source.evaluation);
  if (source.evaluation === null || source.evidenceManifest === null) {
    return emptyEvaluationState('missing');
  }
  const currentBinding = source.currentBinding;
  if (
    currentBinding.iterationId === null ||
    currentBinding.candidateRef === null ||
    currentBinding.evidenceManifestHash === null
  ) {
    return emptyEvaluationState('missing');
  }
  if (!decisionBindingsEqual(source.evaluation.verdict.binding, currentBinding)) {
    return emptyEvaluationState('stale');
  }
  const evaluation = source.evaluation;
  const assertionIds = new Set(source.assertions.map((assertion) => assertion.id));
  const criterionIds = new Set(source.contract.acceptanceCriteria.map((item) => item.id));
  const evidenceIds = new Set(source.evidenceManifest.entries.map((item) => item.artifactRefId));
  const results = new Map(
    evaluation.verdict.criterionResults.map((result) => [result.criterionId, result] as const),
  );
  const criterionPremises = new Map(
    evaluation.criterionPremises.map((row) => [row.key, row.assertionIds] as const),
  );
  const findingPremises = new Map(
    evaluation.findingPremises.map((row) => [row.key, row.assertionIds] as const),
  );
  const findings = [
    ...evaluation.verdict.blockingFindings,
    ...evaluation.verdict.nonBlockingRisks,
  ];
  const requiredMissing = source.contract.acceptanceCriteria.some(
    (criterion) => criterion.required && !results.has(criterion.id),
  );
  const resultRowsMismatch =
    results.size !== criterionPremises.size ||
    [...results.keys()].some((criterionId) => !criterionPremises.has(criterionId));
  const premiseAuthorityGap = source.contract.acceptanceCriteria.some((criterion) => {
    if (!criterion.required) return false;
    const ids = criterionPremises.get(criterion.id);
    return criterion.authority === 'human' ? ids?.length !== 0 : !ids || ids.length === 0;
  });
  const findingRowsMismatch =
    findings.length !== findingPremises.size ||
    findings.some((finding) => !findingPremises.has(finding.code));
  const unknownReference =
    [...criterionPremises.entries()].some(
      ([criterionId, ids]) =>
        !criterionIds.has(criterionId) || ids.some((id) => !assertionIds.has(id)),
    ) ||
    [...findingPremises.entries()].some(
      ([code, ids]) =>
        !findings.some((finding) => finding.code === code) ||
        ids.length === 0 ||
        ids.some((id) => !assertionIds.has(id)),
    ) ||
    evaluation.verdict.criterionResults.some((result) =>
      result.evidenceRefs.some((id) => !evidenceIds.has(id)),
    ) ||
    findings.some(
      (finding) =>
        finding.criterionIds.length === 0 ||
        finding.criterionIds.some((id) => !criterionIds.has(id)),
    ) ||
    evaluation.outcomeAssertionIds.some((id) => !assertionIds.has(id)) ||
    evaluation.nextStageAssertionIds.some((id) => !assertionIds.has(id));
  const expectedOutcome = sortedUnique([
    ...source.contract.acceptanceCriteria.flatMap((criterion) =>
      criterion.required && criterion.authority !== 'human'
        ? [...(criterionPremises.get(criterion.id) ?? [])]
        : [],
    ),
    ...evaluation.verdict.blockingFindings.flatMap(
      (finding) => findingPremises.get(finding.code) ?? [],
    ),
  ]);
  const nextStageGap =
    evaluation.verdict.recommendedNextStage !== 'escalate_human' &&
    evaluation.nextStageAssertionIds.length === 0;
  if (
    requiredMissing ||
    resultRowsMismatch ||
    premiseAuthorityGap ||
    findingRowsMismatch ||
    unknownReference ||
    !sameStrings(sortedUnique(evaluation.outcomeAssertionIds), expectedOutcome) ||
    nextStageGap
  ) {
    return emptyEvaluationState('incomplete');
  }
  const expectedBinding = currentBinding as EvaluationBinding;
  try {
    assertEvaluationVerdictBinding(
      evaluation.verdict,
      expectedBinding,
      source.contract,
      source.evidenceManifest,
      source.artifacts,
      source.authorityContext.evaluationAuthority,
    );
  } catch (error) {
    fail('invalid_source', `complete evaluation is semantically invalid: ${String(error)}`);
  }
  const used = new Map<string, Set<string>>();
  for (const [criterionId, ids] of criterionPremises) {
    for (const id of ids) {
      const values = used.get(id) ?? new Set<string>();
      values.add(criterionId);
      used.set(id, values);
    }
  }
  for (const finding of findings) {
    for (const id of findingPremises.get(finding.code) ?? []) {
      const values = used.get(id) ?? new Set<string>();
      for (const criterionId of finding.criterionIds) values.add(criterionId);
      used.set(id, values);
    }
  }
  return {
    kind: 'complete',
    evaluation,
    criterionPremises,
    findingPremises,
    usedByCriterionIds: new Map(
      [...used.entries()].map(([id, values]) => [id, [...values].sort()] as const),
    ),
  };
}

function validateRecords(source: ReviewPackageV2Source): void {
  if (
    !Array.isArray(source.assertions) ||
    !Array.isArray(source.verificationReceipts) ||
    !Array.isArray(source.humanDecisions) ||
    source.assertions.length > MAX_ARRAY_ITEMS ||
    source.verificationReceipts.length > MAX_ARRAY_ITEMS ||
    source.humanDecisions.length > MAX_ARRAY_ITEMS
  ) {
    fail('invalid_source', 'assertion, receipt, and decision arrays must be bounded');
  }
  try {
    assertClaimAuthorityContext(source.authorityContext);
  } catch (error) {
    fail('invalid_source', `claim authority context is invalid: ${String(error)}`);
  }
  const assertionIds = new Set<string>();
  for (const assertion of source.assertions) {
    try {
      assertDecisionAssertion(assertion);
    } catch (error) {
      fail('invalid_source', `decision assertion is invalid: ${String(error)}`);
    }
    if (assertionIds.has(assertion.id)) {
      fail('invalid_source', 'decision assertion identities must be unique');
    }
    assertionIds.add(assertion.id);
  }
  const assertions = new Map(source.assertions.map((item) => [item.id, item] as const));
  const receiptIds = new Set<string>();
  for (const receipt of source.verificationReceipts) {
    try {
      assertAssertionVerificationReceiptShape(receipt);
    } catch (error) {
      fail('invalid_source', `verification receipt shape is invalid: ${String(error)}`);
    }
    if (receiptIds.has(receipt.id)) {
      fail('invalid_source', 'verification receipt identities must be unique');
    }
    const assertion = assertions.get(receipt.assertionId);
    if (assertion === undefined || assertion.kind !== 'fact') {
      fail('invalid_source', 'every receipt must target one existing factual assertion');
    }
    receiptIds.add(receipt.id);
  }
  const decisionIds = new Set<string>();
  for (const decision of source.humanDecisions) {
    const typedDecision = decision;
    assertCanonicalRecord(
      decision,
      ['id', 'binding', 'decision', 'comment', 'actor', 'createdAt'],
      'human decision',
    );
    assertCanonicalRecord(
      typedDecision.actor,
      ['kind', 'id'],
      'human decision actor',
    );
    assertDecisionBindingSnapshot(
      typedDecision.binding,
      'invalid_source',
      'human decision binding',
    );
    if (
      !(typedDecision.comment === null || isText(typedDecision.comment)) ||
      !isCanonicalTimestamp(typedDecision.createdAt)
    ) {
      fail('invalid_source', 'human decision comment or timestamp exceeds M6 bounds');
    }
    try {
      assertHumanDecisionBinding(typedDecision, typedDecision.binding);
    } catch (error) {
      fail('invalid_source', `human decision shape is invalid: ${String(error)}`);
    }
    if (
      decisionIds.has(typedDecision.id) ||
      typedDecision.binding.taskId !== source.task.id
    ) {
      fail('invalid_source', 'human decision identities must be unique and task-bound');
    }
    decisionIds.add(typedDecision.id);
  }
}

interface ReceiptDiagnostic {
  readonly receipt: AssertionVerificationReceipt;
  readonly reasons: readonly ReviewReasonCode[];
  readonly otherwiseEligible: boolean;
}

function bindingMatchesReceipt(
  receipt: AssertionVerificationReceipt,
  source: ReviewPackageV2Source,
): boolean {
  return (
    receipt.taskId === source.currentBinding.taskId &&
    receipt.contractVersion === source.currentBinding.contractVersion &&
    receipt.contractHash === source.currentBinding.contractHash &&
    receipt.iterationId === source.currentBinding.iterationId &&
    source.currentBinding.candidateRef !== null &&
    candidateRefsEqual(receipt.candidateRef, source.currentBinding.candidateRef) &&
    source.evidenceManifest !== null &&
    receipt.evidenceManifestId === source.evidenceManifest.id &&
    receipt.evidenceManifestHash === source.currentBinding.evidenceManifestHash
  );
}

function receiptDiagnostics(
  source: ReviewPackageV2Source,
  assertion: DecisionAssertion,
  evaluation: EvaluationState,
  integrity: IntegrityProjection,
): ReceiptDiagnostic[] {
  const manifestEntries = new Map(
    (source.evidenceManifest?.entries ?? []).map((entry) => [entry.artifactRefId, entry] as const),
  );
  const artifacts = new Map(source.artifacts.map((artifact) => [artifact.id, artifact] as const));
  const derivedCriteria = evaluation.usedByCriterionIds.get(assertion.id) ?? [];
  return source.verificationReceipts
    .filter((receipt) => receipt.assertionId === assertion.id)
    .map((receipt) => {
      const reasons: ReviewReasonCode[] = [];
      if (receiptHash(receipt) !== receipt.receiptHash) reasons.push('receipt_hash_mismatch');
      if (!bindingMatchesReceipt(receipt, source)) reasons.push('receipt_stale');
      if (
        receipt.subjectKey !== assertion.subjectKey ||
        receipt.assertionPayloadHash !== assertion.payloadHash
      ) {
        reasons.push('assertion_binding_mismatch');
      }
      if (evaluation.kind === 'complete') {
        if (
          derivedCriteria.length === 0
            ? receipt.criterionIds.length > 0
            : !sameStrings(receipt.criterionIds, derivedCriteria)
        ) {
          reasons.push('receipt_coverage_mismatch');
        }
      }
      if (receipt.evidenceEntryArtifactIds.length === 0) reasons.push('evidence_missing');
      const cited = receipt.evidenceEntryArtifactIds.map((id) => ({
        entry: manifestEntries.get(id),
        artifact: artifacts.get(id),
      }));
      if (cited.some(({ entry, artifact }) => entry === undefined || artifact === undefined)) {
        reasons.push('evidence_missing');
      } else if (
        cited.some(
          ({ entry, artifact }) =>
            entry?.trustClass !== 'primary' || artifact?.trustClass !== 'primary',
        )
      ) {
        reasons.push('non_primary_evidence');
      }
      if (!integrity.intact) {
        if (integrity.result === 'missing') reasons.push('evidence_missing');
        if (integrity.result === 'tampered') reasons.push('evidence_tampered');
        if (integrity.result === 'unavailable') reasons.push('integrity_unavailable');
      }
      if (!source.authorityContext.trustedVerifierRunIds.includes(receipt.verifierRunId)) {
        reasons.push('self_report');
      }
      if (
        cited.some(
          ({ entry }) =>
            entry !== undefined &&
            (entry.surface !== receipt.observationSurface ||
              entry.observedAt !== receipt.observedAt),
        )
      ) {
        reasons.push('observation_mismatch');
      }
      if (receipt.valueHash !== assertion.payloadHash) {
        reasons.push('value_mismatch', 'structured_contradiction');
      }
      const ordered = orderReasons(reasons);
      return {
        receipt,
        reasons: ordered,
        otherwiseEligible:
          evaluation.kind === 'complete' &&
          derivedCriteria.length > 0 &&
          ordered.length === 0,
      };
    });
}

interface ProjectionWork {
  readonly assertions: readonly AssertionProjection[];
  readonly byId: ReadonlyMap<string, AssertionProjection>;
  readonly diagnosticsById: ReadonlyMap<string, readonly ReviewReasonCode[]>;
}

function projectAssertions(
  source: ReviewPackageV2Source,
  evaluation: EvaluationState,
  integrity: IntegrityProjection,
): ProjectionWork {
  const factDiagnostics = new Map(
    source.assertions
      .filter((assertion) => assertion.kind === 'fact')
      .map(
        (assertion) =>
          [
            assertion.id,
            receiptDiagnostics(source, assertion, evaluation, integrity),
          ] as const,
      ),
  );
  const eligibleSubjectPayloads = new Map<string, Set<string>>();
  for (const assertion of source.assertions) {
    if (
      assertion.kind !== 'fact' ||
      !(factDiagnostics.get(assertion.id) ?? []).some(
        (diagnostic) => diagnostic.otherwiseEligible,
      )
    ) {
      continue;
    }
    const payloads = eligibleSubjectPayloads.get(assertion.subjectKey) ?? new Set<string>();
    payloads.add(assertion.payloadHash);
    eligibleSubjectPayloads.set(assertion.subjectKey, payloads);
  }
  const bucketReason: ReviewReasonCode | null =
    evaluation.kind === 'missing'
      ? 'evaluation_missing'
      : evaluation.kind === 'stale'
        ? 'evaluation_stale'
        : evaluation.kind === 'incomplete'
          ? 'evaluation_incomplete'
          : null;
  const diagnosticsById = new Map<string, readonly ReviewReasonCode[]>();
  const projected = [...source.assertions]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((assertion): AssertionProjection => {
      if (assertion.kind === 'inference' || assertion.kind === 'opinion') {
        diagnosticsById.set(assertion.id, []);
        return {
          id: assertion.id,
          subjectKey: assertion.subjectKey,
          payloadHash: assertion.payloadHash,
          classification: assertion.kind,
          decisionEligible: false,
          usedByCriterionIds: [],
          evidenceArtifactIds: [],
          receiptIds: [],
          reasonCodes: [],
          advisoryText: assertion.advisoryText,
        };
      }
      const diagnostics = factDiagnostics.get(assertion.id) ?? [];
      const localReasons =
        diagnostics.length === 0
          ? (['receipt_missing'] as const)
          : orderReasons(diagnostics.flatMap((item) => item.reasons));
      const subjectConflict =
        (eligibleSubjectPayloads.get(assertion.subjectKey)?.size ?? 0) > 1;
      const eligible = diagnostics.filter((item) => item.otherwiseEligible);
      const receiptValues = new Set(eligible.map((item) => item.receipt.valueHash));
      const contradictory = subjectConflict || receiptValues.size > 1;
      const verified = eligible.length > 0 && !contradictory;
      const reasons = verified
        ? []
        : orderReasons([
            ...localReasons,
            ...(contradictory ? (['structured_contradiction'] as const) : []),
            ...(bucketReason === null ? [] : [bucketReason]),
          ]);
      diagnosticsById.set(assertion.id, reasons);
      return {
        id: assertion.id,
        subjectKey: assertion.subjectKey,
        payloadHash: assertion.payloadHash,
        classification: verified ? 'verified' : 'unverified_pending',
        decisionEligible: verified,
        usedByCriterionIds:
          evaluation.kind === 'complete'
            ? [...(evaluation.usedByCriterionIds.get(assertion.id) ?? [])]
            : [],
        evidenceArtifactIds: verified
          ? sortedUnique(
              eligible.flatMap((item) => item.receipt.evidenceEntryArtifactIds),
            )
          : [],
        receiptIds: verified
          ? eligible.map((item) => item.receipt.id).sort()
          : [],
        reasonCodes: reasons,
        advisoryText: assertion.advisoryText,
      };
    });
  return {
    assertions: projected,
    byId: new Map(projected.map((assertion) => [assertion.id, assertion] as const)),
    diagnosticsById,
  };
}

function emptyAxis(
  status: ReviewAxisStatus,
  reasonCodes: readonly ReviewReasonCode[] = [],
): ReviewTrustAxis {
  return { status, assertionIds: [], evidenceArtifactIds: [], reasonCodes };
}

function evidenceForAssertions(
  assertionIds: readonly string[],
  assertions: ReadonlyMap<string, AssertionProjection>,
): string[] {
  return sortedUnique(
    assertionIds.flatMap((id) => assertions.get(id)?.evidenceArtifactIds ?? []),
  );
}

interface HumanProjection {
  readonly statuses: ReadonlyMap<string, CriterionResultViewV2['status']>;
  readonly reasons: readonly ReviewReasonCode[];
  readonly rejected: boolean;
  readonly conflict: boolean;
  readonly approved: boolean;
}

function projectHumanAuthority(source: ReviewPackageV2Source): HumanProjection {
  const current = source.humanDecisions.filter(
    (decision) =>
      OUTCOME_DECISIONS.includes(decision.decision as M6OutcomeDecision) &&
      decisionBindingsEqual(decision.binding, source.currentBinding),
  );
  const kinds = new Set(current.map((decision) => decision.decision));
  const conflict = kinds.size > 1;
  const rejected =
    !conflict &&
    (kinds.has('reject_outcome') || kinds.has('request_changes'));
  const approved = !conflict && kinds.has('approve_outcome');
  const stale =
    current.length === 0 &&
    source.humanDecisions.some(
      (decision) =>
        OUTCOME_DECISIONS.includes(decision.decision as M6OutcomeDecision) &&
        !decisionBindingsEqual(decision.binding, source.currentBinding),
    );
  const reasons = conflict
    ? orderReasons(['human_decision_required', 'human_decision_conflict'])
    : rejected
      ? orderReasons(['human_rejected'])
      : approved
        ? []
        : orderReasons([
            'human_decision_required',
            ...(stale ? (['human_decision_stale'] as const) : []),
          ]);
  const status: CriterionResultViewV2['status'] = conflict
    ? 'need_more_evidence'
    : rejected
      ? 'fail'
      : approved
        ? 'pass'
        : 'needs_human';
  return {
    statuses: new Map(
      source.contract.acceptanceCriteria
        .filter((criterion) => criterion.authority === 'human')
        .map((criterion) => [criterion.id, status] as const),
    ),
    reasons,
    rejected,
    conflict,
    approved,
  };
}

interface CompleteViews {
  readonly criteria: readonly CriterionResultViewV2[];
  readonly blockingFindings: readonly FindingViewV2[];
  readonly remainingRisks: readonly FindingViewV2[];
  readonly outcomeReasons: readonly ReviewReasonCode[];
  readonly hasEligibleFailure: boolean;
}

function projectCompleteViews(
  source: ReviewPackageV2Source,
  evaluation: EvaluationState,
  work: ProjectionWork,
  human: HumanProjection,
): CompleteViews {
  const record = evaluation.evaluation!;
  const results = new Map(
    record.verdict.criterionResults.map((result) => [result.criterionId, result] as const),
  );
  const blockingCodes = new Set(record.verdict.blockingFindings.map((finding) => finding.code));
  const projectFinding = (finding: EvaluationVerdict['blockingFindings'][number]): FindingViewV2 => {
    const assertionIds = sortedUnique(evaluation.findingPremises.get(finding.code) ?? []);
    const verified = assertionIds.every(
      (id) => work.byId.get(id)?.classification === 'verified',
    );
    const premiseReasons = assertionIds.flatMap(
      (id) => work.byId.get(id)?.reasonCodes ?? [],
    );
    return {
      code: finding.code,
      criterionIds: sortedUnique(finding.criterionIds),
      assertionIds,
      classification: verified ? 'verified' : 'unverified_pending',
      reasonCodes: verified
        ? blockingCodes.has(finding.code)
          ? ['blocking_finding']
          : []
        : orderReasons([...premiseReasons, 'evaluation_premise_ineligible']),
      advisorySummary: finding.summary,
    };
  };
  const blockingFindings = [...record.verdict.blockingFindings]
    .sort((left, right) => left.code.localeCompare(right.code))
    .map(projectFinding);
  const remainingRisks = [...record.verdict.nonBlockingRisks]
    .sort((left, right) => left.code.localeCompare(right.code))
    .map(projectFinding);
  const eligibleBlocking = new Set(
    blockingFindings
      .filter((finding) => finding.classification === 'verified')
      .map((finding) => finding.code),
  );
  const criteria = source.contract.acceptanceCriteria.map((criterion) => {
    const ownAssertions = evaluation.criterionPremises.get(criterion.id) ?? [];
    const findingAssertions = [...record.verdict.blockingFindings, ...record.verdict.nonBlockingRisks]
      .filter((finding) => finding.criterionIds.includes(criterion.id))
      .flatMap((finding) => evaluation.findingPremises.get(finding.code) ?? []);
    const assertionIds = sortedUnique([...ownAssertions, ...findingAssertions]);
    const ownVerified = ownAssertions.every(
      (id) => work.byId.get(id)?.classification === 'verified',
    );
    const eligibleNamedBlocking = record.verdict.blockingFindings.some(
      (finding) =>
        finding.criterionIds.includes(criterion.id) && eligibleBlocking.has(finding.code),
    );
    const result = results.get(criterion.id);
    let status: CriterionResultViewV2['status'];
    if (criterion.authority === 'human') {
      status = human.statuses.get(criterion.id) ?? 'needs_human';
    } else if (eligibleNamedBlocking || (result?.status === 'fail' && ownVerified)) {
      status = 'fail';
    } else if (result === undefined && !criterion.required) {
      status = 'not_applicable';
    } else if (result?.status === 'pass' && ownVerified) {
      status = 'pass';
    } else {
      status = 'need_more_evidence';
    }
    const ownReasons = ownAssertions.flatMap(
      (id) => work.byId.get(id)?.reasonCodes ?? [],
    );
    const hasIneligibleOwn = ownAssertions.some(
      (id) => work.byId.get(id)?.classification !== 'verified',
    );
    const reasons =
      criterion.authority === 'human'
        ? orderReasons([
            ...human.reasons,
            ...(eligibleNamedBlocking ? (['blocking_finding'] as const) : []),
          ])
        : orderReasons([
            ...ownReasons,
            ...(hasIneligibleOwn ? (['evaluation_premise_ineligible'] as const) : []),
            ...(result?.status === 'fail' && ownVerified
              ? (['criterion_failed'] as const)
              : []),
            ...(eligibleNamedBlocking ? (['blocking_finding'] as const) : []),
          ]);
    return {
      criterionId: criterion.id,
      authority: criterion.authority,
      required: criterion.required,
      status,
      assertionIds,
      evidenceArtifactIds: evidenceForAssertions(assertionIds, work.byId),
      reasonCodes: reasons,
      advisoryExplanation: result?.explanation ?? '',
    };
  });
  const outcomeIds = record.outcomeAssertionIds;
  const ineligibleOutcome = outcomeIds.some(
    (id) => work.byId.get(id)?.classification !== 'verified',
  );
  const outcomeReasons = orderReasons([
    ...outcomeIds.flatMap((id) => work.byId.get(id)?.reasonCodes ?? []),
    ...(ineligibleOutcome ? (['evaluation_premise_ineligible'] as const) : []),
    ...criteria.flatMap((criterion) =>
      criterion.required
        ? criterion.reasonCodes.filter(
            (reason) => reason === 'criterion_failed' || reason === 'blocking_finding',
          )
        : [],
    ),
    ...(eligibleBlocking.size > 0 ? (['blocking_finding'] as const) : []),
  ]);
  return {
    criteria,
    blockingFindings,
    remainingRisks,
    outcomeReasons,
    hasEligibleFailure:
      criteria.some((criterion) => criterion.required && criterion.status === 'fail') ||
      eligibleBlocking.size > 0,
  };
}

function projectUnavailableCriteria(
  source: ReviewPackageV2Source,
  reasons: readonly ReviewReasonCode[],
  human: HumanProjection,
): CriterionResultViewV2[] {
  return source.contract.acceptanceCriteria.map((criterion) => {
    if (!criterion.required) {
      return {
        criterionId: criterion.id,
        authority: criterion.authority,
        required: false,
        status: 'not_applicable',
        assertionIds: [],
        evidenceArtifactIds: [],
        reasonCodes: [],
        advisoryExplanation: '',
      };
    }
    return {
      criterionId: criterion.id,
      authority: criterion.authority,
      required: true,
      status:
        criterion.authority === 'human'
          ? (human.statuses.get(criterion.id) ?? 'needs_human')
          : 'need_more_evidence',
      assertionIds: [],
      evidenceArtifactIds: [],
      reasonCodes:
        criterion.authority === 'human'
          ? orderReasons([...reasons, ...human.reasons])
          : [...reasons],
      advisoryExplanation: '',
    };
  });
}

function axisForCriteria(
  criteria: readonly CriterionResultViewV2[],
  authority: CriterionAuthority,
): ReviewTrustAxis {
  const required = criteria.filter(
    (criterion) => criterion.required && criterion.authority === authority,
  );
  if (required.length === 0) return emptyAxis('not_applicable');
  const status: ReviewAxisStatus = required.some(
    (criterion) =>
      criterion.status === 'fail' || criterion.reasonCodes.includes('blocking_finding'),
  )
    ? 'failed'
    : required.some((criterion) => criterion.status === 'need_more_evidence')
      ? 'need_more_evidence'
      : required.some((criterion) => criterion.status === 'needs_human')
        ? 'needs_human'
        : 'verified';
  return {
    status,
    assertionIds: sortedUnique(required.flatMap((criterion) => criterion.assertionIds)),
    evidenceArtifactIds: sortedUnique(
      required.flatMap((criterion) => criterion.evidenceArtifactIds),
    ),
    reasonCodes: orderReasons(required.flatMap((criterion) => criterion.reasonCodes)),
  };
}

function publicEvidence(
  source: ReviewPackageV2Source,
  assertions: readonly AssertionProjection[],
): EvidenceSummaryV2[] {
  if (source.evidenceManifest === null) return [];
  const artifacts = new Map(source.artifacts.map((artifact) => [artifact.id, artifact] as const));
  return [...source.evidenceManifest.entries]
    .sort((left, right) => left.artifactRefId.localeCompare(right.artifactRefId))
    .map((entry) => {
      const artifact = artifacts.get(entry.artifactRefId)!;
      return {
        artifactRefId: entry.artifactRefId,
        sha256: artifact.sha256,
        trustClass: entry.trustClass,
        redactionState: artifact.redactionState,
        criterionIds: sortedUnique(entry.criterionIds),
        surface: entry.surface,
        supportsAssertionIds: assertions
          .filter((assertion) => assertion.evidenceArtifactIds.includes(entry.artifactRefId))
          .map((assertion) => assertion.id)
          .sort(),
      };
    });
}

function projectionHash(packageValue: Omit<ReviewPackageV2, 'projectionHash'>): string {
  return hashCanonicalJson(packageValue);
}

function projectReviewPackageV2(source: ReviewPackageV2Source): ReviewPackageV2 {
  assertSourceTuple(source);
  validateRecords(source);
  const integrity = validateIntegrity(source);
  const evaluation = evaluationState(source);
  const work = projectAssertions(source, evaluation, integrity);
  const human = projectHumanAuthority(source);
  const localFactReasons = orderReasons(
    work.assertions
      .filter((assertion) => assertion.classification === 'unverified_pending')
      .flatMap((assertion) =>
        assertion.reasonCodes.filter(
          (reason) =>
            reason !== 'evaluation_missing' &&
            reason !== 'evaluation_stale' &&
            reason !== 'evaluation_incomplete',
        ),
      ),
  );
  const bucketReason: ReviewReasonCode | null =
    evaluation.kind === 'missing'
      ? 'evaluation_missing'
      : evaluation.kind === 'stale'
        ? 'evaluation_stale'
        : evaluation.kind === 'incomplete'
          ? 'evaluation_incomplete'
          : null;
  const baseGapReasons =
    bucketReason === null ? [] : orderReasons([...localFactReasons, bucketReason]);
  const completeViews =
    evaluation.kind === 'complete'
      ? projectCompleteViews(source, evaluation, work, human)
      : null;
  const criteria =
    completeViews?.criteria ?? projectUnavailableCriteria(source, baseGapReasons, human);
  const unsupportedPolicyIds = source.contract.approvalPolicy.requiredDecisions.filter(
    (id) => id !== 'approve_outcome',
  );
  const policyReasons =
    unsupportedPolicyIds.length === 0
      ? []
      : (['unsupported_policy_decision'] as const);
  const supportedApprovalRequired =
    source.contract.approvalPolicy.requiredDecisions.includes('approve_outcome');
  const supportedApprovalUnsatisfied = supportedApprovalRequired && !human.approved;
  const requiredNonHumanGap = criteria.some(
    (criterion) =>
      criterion.required &&
      criterion.authority !== 'human' &&
      criterion.status === 'need_more_evidence',
  );
  const outcomePremiseGap =
    evaluation.kind === 'complete' &&
    evaluation.evaluation!.outcomeAssertionIds.some(
      (id) => work.byId.get(id)?.classification !== 'verified',
    );
  const resultsById =
    evaluation.kind === 'complete'
      ? new Map(
          evaluation.evaluation!.verdict.criterionResults.map(
            (result) => [result.criterionId, result] as const,
          ),
        )
      : new Map<string, EvaluationVerdict['criterionResults'][number]>();
  const requiredCriteria = source.contract.acceptanceCriteria.filter(
    (criterion) => criterion.required,
  );
  const humanOnlyEvaluatorGap =
    evaluation.kind === 'complete' &&
    evaluation.evaluation!.verdict.outcome === 'need_more_evidence' &&
    evaluation.evaluation!.verdict.recommendedNextStage === 'escalate_human' &&
    evaluation.evaluation!.verdict.blockingFindings.length === 0 &&
    requiredCriteria.some(
      (criterion) =>
        criterion.authority === 'human' &&
        resultsById.get(criterion.id)?.status === 'pending',
    ) &&
    requiredCriteria.every((criterion) => {
      const status = resultsById.get(criterion.id)?.status;
      return criterion.authority === 'human'
        ? status === 'pending' || status === 'insufficient_evidence'
        : status === 'pass' &&
            criteria.find((row) => row.criterionId === criterion.id)?.status === 'pass';
    });
  const evaluatorEvidenceGap =
    evaluation.kind === 'complete' &&
    evaluation.evaluation!.verdict.outcome === 'need_more_evidence' &&
    !humanOnlyEvaluatorGap;
  const hasMachineGap =
    evaluation.kind !== 'complete' ||
    requiredNonHumanGap ||
    outcomePremiseGap ||
    evaluatorEvidenceGap ||
    unsupportedPolicyIds.length > 0;
  const hasFailure = completeViews?.hasEligibleFailure === true || human.rejected;
  const hasHumanRequirement =
    supportedApprovalUnsatisfied ||
    source.contract.acceptanceCriteria.some(
      (criterion) => criterion.required && criterion.authority === 'human',
    );
  const outcomeStatus: ReviewPackageV2['outcome']['status'] = human.conflict
    ? 'need_more_evidence'
    : hasFailure
      ? 'fail'
      : hasMachineGap
        ? 'need_more_evidence'
        : hasHumanRequirement && !human.approved
          ? 'needs_human'
          : 'pass';
  const outcomeReasons = orderReasons([
    ...(completeViews?.outcomeReasons ?? baseGapReasons),
    ...(human.conflict ? (['human_decision_conflict'] as const) : []),
    ...(human.rejected ? (['human_rejected'] as const) : []),
    ...(outcomeStatus === 'needs_human'
      ? (['human_decision_required'] as const)
      : []),
    ...policyReasons,
  ]);
  const decisionTupleEligible =
    integrity.intact &&
    source.currentBinding.candidateRef?.kind === 'git' &&
    /^[0-9a-f]{40}$/.test(source.currentBinding.candidateRef.revision) &&
    evaluation.kind === 'complete' &&
    evaluation.evaluation!.outcomeAssertionIds.every(
      (id) => work.byId.get(id)?.classification === 'verified',
    ) &&
    unsupportedPolicyIds.length === 0;
  const verifiedFailureEligible =
    outcomeStatus === 'fail' &&
    hasFailure &&
    !hasMachineGap &&
    human.conflict === false &&
    completeViews !== null &&
    completeViews.blockingFindings.every(
      (finding) => finding.classification === 'verified',
    );
  const validDecisions: readonly M6OutcomeDecision[] = !decisionTupleEligible
    ? []
    : outcomeStatus === 'needs_human'
      ? OUTCOME_DECISIONS
      : outcomeStatus === 'pass' || verifiedFailureEligible
        ? REQUEST_CHANGES_ONLY
        : [];
  const decisionEligible = validDecisions.length > 0;
  const mechanical = axisForCriteria(criteria, 'mechanical');
  const realSurface = axisForCriteria(criteria, 'verifier');
  const criterionHumanAxis = axisForCriteria(criteria, 'human');
  const hasHumanPolicyRequirement =
    source.contract.approvalPolicy.requiredDecisions.length > 0;
  const humanAxis: ReviewTrustAxis =
    unsupportedPolicyIds.length > 0
      ? {
          ...criterionHumanAxis,
          status: 'need_more_evidence',
          reasonCodes: orderReasons([
            ...criterionHumanAxis.reasonCodes,
            'unsupported_policy_decision',
          ]),
        }
      : human.conflict
        ? {
            ...criterionHumanAxis,
            status: 'need_more_evidence',
            reasonCodes: orderReasons([
              ...criterionHumanAxis.reasonCodes,
              'human_decision_required',
              'human_decision_conflict',
            ]),
          }
        : human.rejected
          ? {
              ...criterionHumanAxis,
              status: 'failed',
              reasonCodes: orderReasons([
                ...criterionHumanAxis.reasonCodes,
                'human_rejected',
              ]),
            }
          : criterionHumanAxis.status === 'failed'
            ? criterionHumanAxis
            : supportedApprovalUnsatisfied
              ? {
                  ...criterionHumanAxis,
                  status: 'needs_human',
                  reasonCodes: orderReasons([
                    ...criterionHumanAxis.reasonCodes,
                    'human_decision_required',
                  ]),
                }
              : hasHumanPolicyRequirement && criterionHumanAxis.status === 'not_applicable'
                ? emptyAxis('verified')
                : criterionHumanAxis;
  const evaluatorRequired =
    source.contract.verificationPolicy.independentEvaluatorRequired ||
    source.contract.acceptanceCriteria.some(
      (criterion) => criterion.required && criterion.authority === 'evaluator',
    );
  const evaluatorAxisGap = requiredNonHumanGap || outcomePremiseGap || evaluatorEvidenceGap;
  const eligibleEvaluatorRejection =
    evaluation.kind === 'complete' &&
    evaluation.evaluation!.verdict.outcome === 'fail' &&
    completeViews?.hasEligibleFailure === true;
  const independentEvaluation = !evaluatorRequired && !eligibleEvaluatorRejection
    ? emptyAxis('not_applicable')
    : evaluation.kind !== 'complete'
      ? {
          ...emptyAxis('need_more_evidence'),
          reasonCodes: baseGapReasons,
        }
      : {
          status: eligibleEvaluatorRejection
            ? ('failed' as const)
            : evaluatorAxisGap
              ? ('need_more_evidence' as const)
              : ('verified' as const),
          assertionIds: sortedUnique(evaluation.evaluation!.outcomeAssertionIds),
          evidenceArtifactIds: evidenceForAssertions(
            evaluation.evaluation!.outcomeAssertionIds,
            work.byId,
          ),
          reasonCodes: eligibleEvaluatorRejection
            ? completeViews?.outcomeReasons ?? []
            : evaluatorAxisGap
              ? orderReasons(
                  criteria
                    .filter(
                      (criterion) => criterion.required && criterion.authority !== 'human',
                    )
                    .flatMap((criterion) => criterion.reasonCodes),
                )
              : [],
        };
  const binding: ReviewBindingV2 = {
    taskId: source.currentBinding.taskId,
    contractVersion: source.currentBinding.contractVersion,
    contractHash: source.currentBinding.contractHash,
    iterationId: source.currentIteration.id,
    candidateRef: source.currentBinding.candidateRef,
    evidenceManifestId: source.evidenceManifest?.id ?? null,
    evidenceManifestHash: source.currentBinding.evidenceManifestHash,
    evaluatorVersion: source.currentBinding.evaluatorVersion,
    evaluatorModel: source.currentBinding.evaluatorModel,
    evaluatorRuntime: source.currentBinding.evaluatorRuntime,
    policyVersion: source.currentBinding.policyVersion,
  };
  const requiredDecision: RequiredDecisionV2 | null =
    unsupportedPolicyIds.length > 0
      ? {
          kinds: [],
          policyDecisionIds: [...unsupportedPolicyIds].sort(),
          reasonCodes: ['unsupported_policy_decision'],
        }
      : decisionEligible && outcomeStatus === 'needs_human'
        ? {
            kinds: [...OUTCOME_DECISIONS],
            policyDecisionIds: source.contract.approvalPolicy.requiredDecisions.includes(
              'approve_outcome',
            )
              ? ['approve_outcome']
              : [],
            reasonCodes: ['human_decision_required'],
          }
        : null;
  const withoutHash: Omit<ReviewPackageV2, 'projectionHash'> = {
    schema: 'hercules-review-package/v2',
    projectedAt: source.projectedAt,
    task: {
      id: source.task.id,
      title: source.task.title,
      objective: source.contract.objective,
      state: source.task.state,
      advisoryTextAuthority: 'advisory',
    },
    binding,
    outcome: {
      status: outcomeStatus,
      evaluatorOutcome:
        evaluation.kind === 'complete' ? evaluation.evaluation!.verdict.outcome : null,
      decisionEligible,
      reasonCodes: outcomeReasons,
      advisorySummary: outcomeStatus,
    },
    assertions: work.assertions,
    trustAxes: {
      contractBinding: emptyAxis('verified'),
      mechanical,
      realSurface,
      independentReview: emptyAxis('not_applicable', ['review_axis_deferred']),
      independentEvaluation,
      human: humanAxis,
    },
    criteria,
    evidence: publicEvidence(source, work.assertions),
    blockingFindings: completeViews?.blockingFindings ?? [],
    remainingRisks: completeViews?.remainingRisks ?? [],
    iterations: source.iterationHistory.map((iteration) => ({
      id: iteration.id,
      ordinal: iteration.ordinal,
      state: iteration.state,
      candidateRef: iteration.candidateRef,
      evidenceManifestId: iteration.evidenceManifestId,
      finalVerdictId: iteration.finalVerdictId,
      createdAt: iteration.createdAt,
      endedAt: iteration.endedAt,
    })),
    requiredDecision,
    validDecisions: [...validDecisions],
    decisionBinding: decisionEligible ? source.currentBinding : null,
    decisionToken: null,
    usage: source.usage,
  };
  const result: ReviewPackageV2 = {
    ...withoutHash,
    projectionHash: projectionHash(withoutHash),
  };
  assertReviewPackageV2StructuralConsistency(result);
  return result;
}

/**
 * Validates closed DTO shape and internal consistency only. projectionHash is
 * an unkeyed freshness digest, not source authentication. Workflow decisions
 * must freshly read a trusted source port and project it inside the authority
 * service. The SourceProjectedReviewPackageV2 brand alone is not provenance.
 */
export function assertReviewPackageV2StructuralConsistency(
  packageValue: ReviewPackageV2,
): void {
  try {
    canonicalSerialize(packageValue);
  } catch (error) {
    fail('invalid_package', `review package must be stable canonical JSON: ${String(error)}`);
  }
  assertPackageRecord(packageValue, PACKAGE_KEYS, 'review package');
  if (
    packageValue.schema !== 'hercules-review-package/v2' ||
    packageValue.decisionToken !== null ||
    !/^sha256:[0-9a-f]{64}$/.test(packageValue.projectionHash) ||
    !isCanonicalTimestamp(packageValue.projectedAt)
  ) {
    fail('invalid_package', 'review package schema, hash, and null token are required');
  }
  assertPackageRecord(
    packageValue.task,
    ['id', 'title', 'objective', 'state', 'advisoryTextAuthority'],
    'review task projection',
  );
  if (
    !isIdentifier(packageValue.task.id) ||
    !isText(packageValue.task.title) ||
    !isText(packageValue.task.objective) ||
    !isIdentifier(packageValue.task.state) ||
    packageValue.task.advisoryTextAuthority !== 'advisory'
  ) {
    fail('invalid_package', 'review task projection fields exceed their bounds');
  }
  assertPackageRecord(
    packageValue.binding,
    [
      'taskId',
      'contractVersion',
      'contractHash',
      'iterationId',
      'candidateRef',
      'evidenceManifestId',
      'evidenceManifestHash',
      'evaluatorVersion',
      'evaluatorModel',
      'evaluatorRuntime',
      'policyVersion',
    ],
    'review binding',
  );
  const bindingIdentity: DecisionBinding = {
    taskId: packageValue.binding.taskId,
    contractVersion: packageValue.binding.contractVersion,
    contractHash: packageValue.binding.contractHash,
    iterationId: packageValue.binding.iterationId,
    candidateRef: packageValue.binding.candidateRef,
    evidenceManifestHash: packageValue.binding.evidenceManifestHash,
    evaluatorVersion: packageValue.binding.evaluatorVersion,
    evaluatorModel: packageValue.binding.evaluatorModel,
    evaluatorRuntime: packageValue.binding.evaluatorRuntime,
    policyVersion: packageValue.binding.policyVersion,
  };
  assertDecisionBindingSnapshot(bindingIdentity, 'invalid_package', 'review binding identity');
  if (
    !isIdentifier(packageValue.binding.iterationId) ||
    !(
      packageValue.binding.evidenceManifestId === null ||
      isIdentifier(packageValue.binding.evidenceManifestId)
    ) ||
    packageValue.task.id !== packageValue.binding.taskId ||
    ((packageValue.binding.evidenceManifestId === null) !==
      (packageValue.binding.evidenceManifestHash === null))
  ) {
    fail('invalid_package', 'review binding task, iteration, and manifest identities are invalid');
  }
  assertPackageRecord(
    packageValue.outcome,
    [
      'status',
      'evaluatorOutcome',
      'decisionEligible',
      'reasonCodes',
      'advisorySummary',
    ],
    'review outcome',
  );
  if (
    !(['pass', 'fail', 'need_more_evidence', 'needs_human'] as const).includes(
      packageValue.outcome.status,
    ) ||
    !(
      packageValue.outcome.evaluatorOutcome === null ||
      (['pass', 'fail', 'need_more_evidence'] as const).includes(
        packageValue.outcome.evaluatorOutcome,
      )
    ) ||
    typeof packageValue.outcome.decisionEligible !== 'boolean' ||
    packageValue.outcome.advisorySummary !== packageValue.outcome.status
  ) {
    fail('invalid_package', 'review outcome status and advisory summary are invalid');
  }
  assertReasonCodes(packageValue.outcome.reasonCodes, 'review outcome reasons');
  if (
    !Array.isArray(packageValue.assertions) ||
    !Array.isArray(packageValue.criteria) ||
    !Array.isArray(packageValue.evidence) ||
    !Array.isArray(packageValue.blockingFindings) ||
    !Array.isArray(packageValue.remainingRisks) ||
    !Array.isArray(packageValue.iterations) ||
    packageValue.assertions.length > MAX_ARRAY_ITEMS ||
    packageValue.criteria.length > MAX_ARRAY_ITEMS ||
    packageValue.evidence.length > MAX_ARRAY_ITEMS ||
    packageValue.blockingFindings.length > MAX_ARRAY_ITEMS ||
    packageValue.remainingRisks.length > MAX_ARRAY_ITEMS ||
    packageValue.iterations.length > MAX_ARRAY_ITEMS
  ) {
    fail('invalid_package', 'review package collections exceed their bounds');
  }
  const assertionIds = new Set<string>();
  let priorAssertionId: string | null = null;
  for (const assertion of packageValue.assertions) {
    assertPackageRecord(
      assertion,
      [
        'id',
        'subjectKey',
        'payloadHash',
        'classification',
        'decisionEligible',
        'usedByCriterionIds',
        'evidenceArtifactIds',
        'receiptIds',
        'reasonCodes',
        'advisoryText',
      ],
      'assertion projection',
    );
    if (
      !isIdentifier(assertion.id) ||
      !isIdentifier(assertion.subjectKey) ||
      !/^sha256:[0-9a-f]{64}$/.test(assertion.payloadHash) ||
      !(['verified', 'inference', 'unverified_pending', 'opinion'] as const).includes(
        assertion.classification,
      ) ||
      assertion.decisionEligible !== (assertion.classification === 'verified') ||
      (assertion.advisoryText !== null && !isText(assertion.advisoryText)) ||
      assertionIds.has(assertion.id) ||
      (priorAssertionId !== null && priorAssertionId >= assertion.id)
    ) {
      fail('invalid_package', 'assertion projection identity or classification is invalid');
    }
    assertSortedUniquePackageIds(
      assertion.usedByCriterionIds,
      'assertion criterion ids',
    );
    assertSortedUniquePackageIds(
      assertion.evidenceArtifactIds,
      'assertion evidence ids',
    );
    assertSortedUniquePackageIds(assertion.receiptIds, 'assertion receipt ids');
    assertReasonCodes(assertion.reasonCodes, 'assertion reasons');
    if (
      assertion.classification !== 'verified' &&
      (assertion.evidenceArtifactIds.length > 0 || assertion.receiptIds.length > 0)
    ) {
      fail('invalid_package', 'only verified assertions may expose public support');
    }
    if (
      assertion.classification === 'verified' &&
      (assertion.evidenceArtifactIds.length === 0 || assertion.receiptIds.length === 0)
    ) {
      fail('invalid_package', 'verified assertions require receipt and primary evidence support');
    }
    assertionIds.add(assertion.id);
    priorAssertionId = assertion.id;
  }
  assertPackageRecord(packageValue.trustAxes, AXIS_KEYS, 'review trust axes');
  for (const [name, axis] of Object.entries(packageValue.trustAxes)) {
    assertPackageRecord(
      axis,
      ['status', 'assertionIds', 'evidenceArtifactIds', 'reasonCodes'],
      `review axis ${name}`,
    );
    if (
      !([
        'verified',
        'failed',
        'need_more_evidence',
        'needs_human',
        'not_applicable',
      ] as const).includes(axis.status)
    ) {
      fail('invalid_package', `review axis ${name} status is invalid`);
    }
    assertSortedUniquePackageIds(axis.assertionIds, `review axis ${name} assertions`);
    assertSortedUniquePackageIds(
      axis.evidenceArtifactIds,
      `review axis ${name} evidence`,
    );
    assertReasonCodes(axis.reasonCodes, `review axis ${name} reasons`);
  }
  const criterionIds = new Set<string>();
  for (const criterion of packageValue.criteria) {
    assertPackageRecord(
      criterion,
      [
        'criterionId',
        'authority',
        'required',
        'status',
        'assertionIds',
        'evidenceArtifactIds',
        'reasonCodes',
        'advisoryExplanation',
      ],
      'criterion projection',
    );
    if (
      !isIdentifier(criterion.criterionId) ||
      !(['mechanical', 'verifier', 'evaluator', 'human'] as const).includes(
        criterion.authority,
      ) ||
      typeof criterion.required !== 'boolean' ||
      !(['pass', 'fail', 'need_more_evidence', 'needs_human', 'not_applicable'] as const).includes(
        criterion.status,
      ) ||
      !isText(criterion.advisoryExplanation) ||
      criterionIds.has(criterion.criterionId)
    ) {
      fail('invalid_package', 'criterion projection fields are invalid');
    }
    assertSortedUniquePackageIds(criterion.assertionIds, 'criterion assertion ids');
    assertSortedUniquePackageIds(criterion.evidenceArtifactIds, 'criterion evidence ids');
    assertReasonCodes(criterion.reasonCodes, 'criterion reasons');
    criterionIds.add(criterion.criterionId);
  }
  const evidenceIds = new Set<string>();
  let priorEvidenceId: string | null = null;
  for (const evidence of packageValue.evidence) {
    assertPackageRecord(
      evidence,
      [
        'artifactRefId',
        'sha256',
        'trustClass',
        'redactionState',
        'criterionIds',
        'surface',
        'supportsAssertionIds',
      ],
      'evidence summary',
    );
    if (
      !isIdentifier(evidence.artifactRefId) ||
      !/^sha256:[0-9a-f]{64}$/.test(evidence.sha256) ||
      !(['primary', 'derived', 'agent_claim'] as const).includes(evidence.trustClass) ||
      !(['none', 'redacted', 'restricted'] as const).includes(evidence.redactionState) ||
      !isIdentifier(evidence.surface) ||
      evidenceIds.has(evidence.artifactRefId) ||
      (priorEvidenceId !== null && priorEvidenceId >= evidence.artifactRefId)
    ) {
      fail('invalid_package', 'evidence summary fields are invalid');
    }
    assertSortedUniquePackageIds(evidence.criterionIds, 'evidence criterion ids');
    assertSortedUniquePackageIds(
      evidence.supportsAssertionIds,
      'evidence supporting assertion ids',
    );
    const expectedInverse = packageValue.assertions
      .filter((assertion) =>
        assertion.evidenceArtifactIds.includes(evidence.artifactRefId),
      )
      .map((assertion) => assertion.id);
    if (!sameStrings(evidence.supportsAssertionIds, expectedInverse)) {
      fail('invalid_package', 'evidence support inverse does not match assertions');
    }
    evidenceIds.add(evidence.artifactRefId);
    priorEvidenceId = evidence.artifactRefId;
  }
  const findingCodes = new Set<string>();
  for (const finding of [
    ...packageValue.blockingFindings,
    ...packageValue.remainingRisks,
  ]) {
    assertPackageRecord(
      finding,
      [
        'code',
        'criterionIds',
        'assertionIds',
        'classification',
        'reasonCodes',
        'advisorySummary',
      ],
      'finding projection',
    );
    if (
      !isIdentifier(finding.code) ||
      !(['verified', 'unverified_pending'] as const).includes(finding.classification) ||
      !isText(finding.advisorySummary) ||
      findingCodes.has(finding.code)
    ) {
      fail('invalid_package', 'finding projection fields are invalid');
    }
    assertSortedUniquePackageIds(finding.criterionIds, 'finding criterion ids');
    assertSortedUniquePackageIds(finding.assertionIds, 'finding assertion ids');
    assertReasonCodes(finding.reasonCodes, 'finding reasons');
    findingCodes.add(finding.code);
  }
  const assertKnown = (
    values: readonly string[],
    known: ReadonlySet<string>,
    label: string,
  ): void => {
    if (values.some((id) => !known.has(id))) {
      fail('invalid_package', `${label} contains an unknown public identity`);
    }
  };
  for (const assertion of packageValue.assertions) {
    assertKnown(assertion.usedByCriterionIds, criterionIds, 'assertion criterion ids');
    assertKnown(assertion.evidenceArtifactIds, evidenceIds, 'assertion evidence ids');
  }
  for (const criterion of packageValue.criteria) {
    assertKnown(criterion.assertionIds, assertionIds, 'criterion assertion ids');
    assertKnown(criterion.evidenceArtifactIds, evidenceIds, 'criterion evidence ids');
  }
  for (const evidence of packageValue.evidence) {
    assertKnown(evidence.criterionIds, criterionIds, 'evidence criterion ids');
    assertKnown(
      evidence.supportsAssertionIds,
      assertionIds,
      'evidence supporting assertion ids',
    );
  }
  for (const finding of [
    ...packageValue.blockingFindings,
    ...packageValue.remainingRisks,
  ]) {
    assertKnown(finding.criterionIds, criterionIds, 'finding criterion ids');
    assertKnown(finding.assertionIds, assertionIds, 'finding assertion ids');
  }
  for (const [name, axis] of Object.entries(packageValue.trustAxes)) {
    assertKnown(axis.assertionIds, assertionIds, `review axis ${name} assertions`);
    assertKnown(axis.evidenceArtifactIds, evidenceIds, `review axis ${name} evidence`);
  }
  let priorOrdinal = 0;
  const iterationIds = new Set<string>();
  for (const iteration of packageValue.iterations) {
    assertPackageRecord(
      iteration,
      [
        'id',
        'ordinal',
        'state',
        'candidateRef',
        'evidenceManifestId',
        'finalVerdictId',
        'createdAt',
        'endedAt',
      ],
      'iteration summary',
    );
    if (
      !isIdentifier(iteration.id) ||
      !Number.isSafeInteger(iteration.ordinal) ||
      iteration.ordinal !== priorOrdinal + 1 ||
      !(['planned', 'executing', 'verifying', 'evaluating', 'passed', 'failed', 'abandoned'] as const).includes(
        iteration.state,
      ) ||
      !isCanonicalTimestamp(iteration.createdAt) ||
      !(iteration.endedAt === null || isCanonicalTimestamp(iteration.endedAt)) ||
      !(iteration.evidenceManifestId === null || isIdentifier(iteration.evidenceManifestId)) ||
      !(iteration.finalVerdictId === null || isIdentifier(iteration.finalVerdictId)) ||
      iterationIds.has(iteration.id)
    ) {
      fail('invalid_package', 'iteration summary identity and order are invalid');
    }
    if (iteration.candidateRef !== null) {
      assertCandidateSnapshot(
        iteration.candidateRef,
        'invalid_package',
        'iteration summary candidate',
      );
    }
    iterationIds.add(iteration.id);
    priorOrdinal = iteration.ordinal;
  }
  const currentIteration = packageValue.iterations.at(-1);
  if (
    currentIteration === undefined ||
    currentIteration.id !== packageValue.binding.iterationId ||
    currentIteration.evidenceManifestId !== packageValue.binding.evidenceManifestId ||
    ((currentIteration.candidateRef === null) !==
      (packageValue.binding.candidateRef === null)) ||
    (currentIteration.candidateRef !== null &&
      packageValue.binding.candidateRef !== null &&
      !candidateRefsEqual(
        currentIteration.candidateRef,
        packageValue.binding.candidateRef,
      ))
  ) {
    fail('invalid_package', 'review binding must equal the public current iteration');
  }
  assertPackageStringArray(packageValue.validDecisions, 'valid outcome decisions');
  if (packageValue.requiredDecision !== null) {
    assertPackageRecord(
      packageValue.requiredDecision,
      ['kinds', 'policyDecisionIds', 'reasonCodes'],
      'required decision',
    );
    assertPackageStringArray(packageValue.requiredDecision.kinds, 'required decision kinds');
    assertPackageStringArray(
      packageValue.requiredDecision.policyDecisionIds,
      'required policy decision ids',
    );
    assertReasonCodes(packageValue.requiredDecision.reasonCodes, 'required decision reasons');
  }
  if (packageValue.decisionBinding !== null) {
    assertDecisionBindingSnapshot(
      packageValue.decisionBinding,
      'invalid_package',
      'decision binding',
    );
    if (!decisionBindingsEqual(packageValue.decisionBinding, bindingIdentity)) {
      fail('invalid_package', 'decision binding must equal the public current binding');
    }
  }
  assertUsage(packageValue.usage, 'invalid_package');
  const { projectionHash: actual, ...withoutHash } = packageValue;
  if (actual !== projectionHash(withoutHash)) {
    fail('invalid_package', 'review package projection hash does not match its fields');
  }
  const expectedDecisions: readonly M6OutcomeDecision[] =
    packageValue.outcome.status === 'needs_human'
      ? OUTCOME_DECISIONS
      : packageValue.outcome.status === 'pass' || packageValue.outcome.status === 'fail'
        ? REQUEST_CHANGES_ONLY
        : [];
  if (
    packageValue.outcome.decisionEligible !== (packageValue.validDecisions.length > 0) ||
    (packageValue.decisionBinding !== null) !== (packageValue.validDecisions.length > 0) ||
    (packageValue.outcome.decisionEligible &&
      !sameStrings(packageValue.validDecisions, expectedDecisions)) ||
    (!packageValue.outcome.decisionEligible && packageValue.validDecisions.length > 0)
  ) {
    fail('invalid_package', 'decision eligibility, binding, and actions must agree');
  }
  if (packageValue.outcome.decisionEligible) {
    const candidate = packageValue.binding.candidateRef;
    if (
      candidate?.kind !== 'git' ||
      !/^[0-9a-f]{40}$/.test(candidate.revision) ||
      packageValue.binding.evidenceManifestId === null ||
      packageValue.binding.evidenceManifestHash === null ||
      packageValue.outcome.evaluatorOutcome === null ||
      packageValue.trustAxes.contractBinding.status !== 'verified'
    ) {
      fail('invalid_package', 'actionable package requires one exact verified binding');
    }

    const requiredCriteria = packageValue.criteria.filter(
      (criterion) => criterion.required,
    );
    const decisionReasons = [
      ...packageValue.outcome.reasonCodes,
      ...requiredCriteria.flatMap((criterion) => criterion.reasonCodes),
      ...packageValue.blockingFindings.flatMap((finding) => finding.reasonCodes),
      ...Object.entries(packageValue.trustAxes)
        .filter(([name]) => name !== 'independentReview')
        .flatMap(([, axis]) => axis.reasonCodes),
    ];
    if (decisionReasons.some((reason) => DECISION_BLOCKING_REASONS.includes(reason))) {
      fail('invalid_package', 'actionable package contains a decision-blocking reason');
    }

    const assertionsById = new Map(
      packageValue.assertions.map((assertion) => [assertion.id, assertion] as const),
    );
    const decisionAssertionIds = sortedUnique([
      ...requiredCriteria.flatMap((criterion) => criterion.assertionIds),
      ...packageValue.blockingFindings.flatMap((finding) => finding.assertionIds),
      ...packageValue.trustAxes.independentEvaluation.assertionIds,
    ]);
    if (
      decisionAssertionIds.some(
        (id) => assertionsById.get(id)?.classification !== 'verified',
      )
    ) {
      fail('invalid_package', 'actionable package contains an unverified premise');
    }

    const authorityAxes = Object.entries(packageValue.trustAxes).filter(
      ([name]) => name !== 'independentReview',
    );
    const humanDecisionPending =
      requiredCriteria.some(
        (criterion) =>
          criterion.authority === 'human' && criterion.status === 'needs_human',
      ) ||
      packageValue.requiredDecision?.policyDecisionIds.includes('approve_outcome') ===
        true;
    const criterionFailure = requiredCriteria.some(
      (criterion) =>
        criterion.status === 'fail' &&
        criterion.reasonCodes.includes('criterion_failed'),
    );
    const blockingFailure = packageValue.blockingFindings.length > 0;
    const humanRejection =
      packageValue.trustAxes.human.status === 'failed' &&
      packageValue.trustAxes.human.reasonCodes.includes('human_rejected');
    const structuralFailReasons = orderReasons([
      ...(criterionFailure ? (['criterion_failed'] as const) : []),
      ...(blockingFailure ? (['blocking_finding'] as const) : []),
      ...(humanRejection ? (['human_rejected'] as const) : []),
    ]);
    const malformedBlockingFailure = packageValue.blockingFindings.some(
      (finding) =>
        finding.classification !== 'verified' ||
        !sameStrings(finding.reasonCodes, ['blocking_finding']),
    );
    const malformedRequiredFailure = requiredCriteria.some(
      (criterion) =>
        criterion.status === 'fail' &&
        !criterion.reasonCodes.some((reason: ReviewReasonCode) =>
          ACTIONABLE_FAIL_REASONS.includes(reason),
        ),
    );
    const machineFailure = criterionFailure || blockingFailure;
    if (
      authorityAxes.some(([, axis]) => axis.status === 'need_more_evidence') ||
      (packageValue.outcome.evaluatorOutcome === 'fail') !== machineFailure ||
      (packageValue.outcome.status === 'pass' &&
        (packageValue.outcome.reasonCodes.length > 0 ||
          requiredCriteria.some((criterion) => criterion.status !== 'pass') ||
          authorityAxes.some(
            ([, axis]) => axis.status === 'failed' || axis.status === 'needs_human',
          ))) ||
      (packageValue.outcome.status === 'needs_human' &&
        (!sameStrings(packageValue.outcome.reasonCodes, ['human_decision_required']) ||
          !humanDecisionPending ||
          requiredCriteria.some(
            (criterion) =>
              criterion.authority === 'human'
                ? criterion.status !== 'pass' && criterion.status !== 'needs_human'
                : criterion.status !== 'pass',
          ) ||
          packageValue.trustAxes.human.status !== 'needs_human' ||
          authorityAxes.some(([, axis]) => axis.status === 'failed'))) ||
      (packageValue.outcome.status === 'fail' &&
        (!sameStrings(packageValue.outcome.reasonCodes, structuralFailReasons) ||
          structuralFailReasons.length === 0 ||
          malformedBlockingFailure ||
          malformedRequiredFailure ||
          requiredCriteria.some(
            (criterion) =>
              criterion.status === 'need_more_evidence' ||
              criterion.status === 'not_applicable',
          )))
    ) {
      fail('invalid_package', 'actionable package surfaces are not authority-consistent');
    }
  }
  if (
    packageValue.requiredDecision !== null &&
    !packageValue.outcome.decisionEligible &&
    (!sameStrings(packageValue.requiredDecision.kinds, []) ||
      packageValue.requiredDecision.policyDecisionIds.length === 0 ||
      canonicalSerialize(packageValue.requiredDecision.policyDecisionIds) !==
        canonicalSerialize([...packageValue.requiredDecision.policyDecisionIds].sort()) ||
      !sameStrings(packageValue.requiredDecision.reasonCodes, [
        'unsupported_policy_decision',
      ]) ||
      !packageValue.outcome.reasonCodes.includes('unsupported_policy_decision'))
  ) {
    fail('invalid_package', 'ineligible required decision must be the unsupported-policy diagnostic');
  }
  if (
    packageValue.outcome.decisionEligible &&
    packageValue.outcome.status === 'needs_human' &&
    (packageValue.requiredDecision === null ||
      !sameStrings(packageValue.requiredDecision.kinds, OUTCOME_DECISIONS) ||
      !(
        sameStrings(packageValue.requiredDecision.policyDecisionIds, []) ||
        sameStrings(packageValue.requiredDecision.policyDecisionIds, ['approve_outcome'])
      ) ||
      !sameStrings(packageValue.requiredDecision.reasonCodes, [
        'human_decision_required',
      ]))
  ) {
    fail('invalid_package', 'eligible human decision must match the exact required-decision table');
  }
  if (
    packageValue.outcome.decisionEligible &&
    packageValue.outcome.status !== 'needs_human' &&
    packageValue.requiredDecision !== null
  ) {
    fail('invalid_package', 'eligible non-human outcome cannot require an outcome decision');
  }
  if (
    packageValue.outcome.decisionEligible &&
    packageValue.outcome.status !== 'pass' &&
    packageValue.outcome.status !== 'needs_human' &&
    packageValue.outcome.status !== 'fail'
  ) {
    fail('invalid_package', 'eligible package must use an actionable outcome');
  }
  if (
    packageValue.outcome.decisionEligible &&
    packageValue.outcome.status === 'fail' &&
    (packageValue.blockingFindings.some(
      (finding) => finding.classification !== 'verified',
    ) ||
      packageValue.outcome.reasonCodes.includes('human_decision_conflict') ||
      packageValue.outcome.reasonCodes.includes('unsupported_policy_decision'))
  ) {
    fail('invalid_package', 'eligible failure must be fully verified and conflict-free');
  }
}

/** The sole constructor for a validated source-projected review package. */
export function projectAndAssertReviewPackageV2(
  source: ReviewPackageV2Source,
): SourceProjectedReviewPackageV2 {
  const projected = projectReviewPackageV2(source);
  assertReviewPackageV2StructuralConsistency(projected);
  return projected as SourceProjectedReviewPackageV2;
}
