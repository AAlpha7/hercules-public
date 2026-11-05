/**
 * M8 independent-evaluation domain records.
 *
 * Slice 1a: control-plane records.
 * Slice 1b: subject input, proposal, context, gap, cancellation, and receipt.
 * Slice 3: sanitized evaluation request + trusted cancellation factory.
 */

import {
  assertArtifactRef,
  assertCandidateRef,
  assertEvidenceManifest,
  type ArtifactRef,
  type CandidateRef,
  type EvidenceManifest,
} from './artifact.js';
import {
  assertAssertionVerificationReceipt,
  assertDecisionAssertion,
  assertEvidenceIntegrityAttestation,
  computeAssertionPayloadHash,
  type AssertionVerificationReceipt,
  type CanonicalJsonValue,
  type DecisionAssertion,
  type EvidenceIntegrityAttestation,
} from './claimAuthorityV2.js';
import { canonicalSerialize, hashCanonicalJson } from './canonicalJson.js';
import {
  CRITERION_RESULT_STATUSES,
  EVALUATION_OUTCOMES,
  RECOMMENDED_NEXT_STAGES,
  type EvaluationVerdict,
} from './evaluationVerdict.js';
import {
  assertTaskContract,
  CRITERION_AUTHORITIES,
  type CriterionAuthority,
  type TaskContract,
} from './taskContract.js';
import { assertTaskContractHash } from './contractHash.js';
import { isValidIdentifier } from './task.js';

// ---------------------------------------------------------------------------
// Fail-closed error classes (full M8 union; this slice throws schema codes)
// ---------------------------------------------------------------------------

export type IndependentEvaluationErrorCode =
  | 'invalid_input_schema'
  | 'stale_binding'
  | 'artifact_integrity'
  | 'verification_incomplete'
  | 'claim_ineligible'
  | 'claim_contradiction'
  | 'policy_denial'
  | 'role_conflict'
  | 'deterministic_gate_failed'
  | 'real_surface_missing'
  | 'evaluator_unavailable'
  | 'evaluator_contract_violation'
  | 'idempotency_conflict';

export class IndependentEvaluationError extends Error {
  override readonly name = 'IndependentEvaluationError';

  constructor(
    readonly code: IndependentEvaluationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Control-plane records (verbatim from M8 contract)
// ---------------------------------------------------------------------------

export interface VerificationObservationV1 {
  readonly observationId: string;
  readonly kind: 'mechanical' | 'real_surface' | 'integrity';
  readonly criterionIds: readonly string[];
  readonly status: 'pass' | 'verified_fail' | 'unavailable';
  readonly artifactIds: readonly string[];
  readonly assertionIds: readonly string[];
  readonly verificationReceiptIds: readonly string[];
  readonly observedAt: string;
  readonly observationHash: string;
}

export interface VerificationResultV1 {
  readonly schema: 'hercules-verification-result/v1';
  readonly verificationResultId: string;
  readonly verifierRunId: string;
  readonly taskId: string;
  readonly taskContractHash: string;
  readonly iterationId: string;
  readonly candidateCommit: string;
  readonly manifestId: string;
  readonly manifestHash: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: 'complete' | 'incomplete' | 'unavailable';
  readonly observations: readonly VerificationObservationV1[];
  readonly resultHash: string;
}

export interface EvaluationPolicyRefV1 {
  readonly schema: 'hercules-evaluation-policy-ref/v1';
  readonly policyId: 'hercules-v1-independent-evaluation';
  readonly version: number;
  readonly policyHash: string;
}

export interface EvaluationRubricRefV1 {
  readonly schema: 'hercules-evaluation-rubric-ref/v1';
  readonly rubricId: string;
  readonly version: number;
  readonly rubricHash: string;
}

export interface DeterministicGatePlanRefV1 {
  readonly schema: 'hercules-deterministic-gate-plan-ref/v1';
  readonly gatePlanId: string;
  readonly version: number;
  readonly gatePlanHash: string;
}

export interface EvaluationPolicyV1 {
  readonly schema: 'hercules-evaluation-policy/v1';
  readonly policyId: 'hercules-v1-independent-evaluation';
  readonly version: number;
  readonly issuer: 'hercules-program-control';
  readonly authorityEpoch: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly maxInputBytes: number;
  readonly maxArtifacts: number;
  readonly maxAssertions: number;
  readonly maxPremisesPerCriterion: number;
  readonly maxRationaleBytes: number;
  readonly evaluatorDeadlineMs: number;
  readonly requiredRoleDisjointness: readonly ('implementer' | 'verifier' | 'reviewer')[];
  readonly allowedEvaluatorImplementationIds: readonly string[];
  readonly verifiedFactsOnly: true;
  readonly failClosedOnEvidenceGap: true;
  readonly freshEvaluatorRequired: true;
  readonly implementerEvaluatorForbidden: true;
  readonly callerGateResultsForbidden: true;
  readonly automaticRetryForbidden: true;
  readonly recommendationIsAdvisory: true;
  readonly policyHash: string;
}

export interface EvaluationRubricCriterionV1 {
  readonly criterionId: string;
  readonly required: boolean;
  readonly authority: CriterionAuthority;
  readonly allowedAdvisoryClasses: readonly ('inference' | 'opinion')[];
  readonly requiredGateIds: readonly string[];
  readonly requiredSurfaceIds: readonly string[];
  readonly evaluatorInstructionArtifactId: string;
  readonly evaluatorInstructionArtifactHash: string;
}

export interface EvaluationRubricV1 {
  readonly schema: 'hercules-evaluation-rubric/v1';
  readonly rubricId: string;
  readonly version: number;
  readonly issuer: 'hercules-program-control';
  readonly authorityEpoch: string;
  readonly taskContractId: string;
  readonly taskContractVersion: number;
  readonly taskContractHash: string;
  readonly criteria: readonly EvaluationRubricCriterionV1[];
  readonly rubricHash: string;
}

export interface EvaluationRunAuthorityV1 {
  readonly schema: 'hercules-evaluation-run-authority/v1';
  readonly issuer: 'hercules-program-control';
  readonly authorityEpoch: string;
  readonly coordinatorRunId: string;
  readonly coordinatorRole: 'trusted_coordinator';
  readonly evaluatorRunId: string;
  readonly evaluatorImplementationId: string;
  readonly evaluatorRole: 'evaluator';
  readonly implementerRunIds: readonly string[];
  readonly verifierRunIds: readonly string[];
  readonly reviewerRunIds: readonly string[];
  readonly freshContextId: string;
  readonly freshContextCreatedAt: string;
  readonly expiresAt: string;
  readonly authorityHash: string;
}

export interface DeterministicGateDefinitionV1 {
  readonly gateId: string;
  readonly version: number;
  readonly kind: 'coordinator_builtin' | 'trusted_external_receipt';
  readonly registryFunctionId: string;
  readonly requiredEnvironmentFields: readonly string[];
  readonly requiredArtifactKinds: readonly string[];
  readonly definitionHash: string;
}

export interface DeterministicGatePlanV1 {
  readonly schema: 'hercules-deterministic-gate-plan/v1';
  readonly gatePlanId: string;
  readonly version: number;
  readonly issuer: 'hercules-program-control';
  readonly authorityEpoch: string;
  readonly taskContractHash: string;
  readonly candidateCommit: string;
  readonly gates: readonly DeterministicGateDefinitionV1[];
  readonly gatePlanHash: string;
}

export interface DeterministicGateReceiptV1 {
  readonly schema: 'hercules-deterministic-gate-receipt/v1';
  readonly gatePlanId: string;
  readonly gatePlanHash: string;
  readonly gateId: string;
  readonly gateVersion: number;
  readonly gateDefinitionHash: string;
  readonly runnerIssuer: 'hercules-program-control';
  readonly runnerRunId: string;
  readonly authorityEpoch: string;
  readonly taskId: string;
  readonly taskContractHash: string;
  readonly iterationId: string;
  readonly candidateCommit: string;
  readonly environmentIdentity: Readonly<Record<string, string>>;
  readonly commandOrSpecHash: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly expiresAt: string;
  readonly status: 'pass' | 'verified_fail' | 'unavailable';
  readonly exitCode: number | null;
  readonly outputArtifactIds: readonly string[];
  readonly outputArtifactHashes: readonly string[];
  readonly assertionIds: readonly string[];
  readonly verificationReceiptIds: readonly string[];
  readonly receiptHash: string;
}

export interface CurrentGateReceiptQueryV1 {
  readonly gatePlanId: string;
  readonly gatePlanHash: string;
  readonly taskId: string;
  readonly taskContractHash: string;
  readonly iterationId: string;
  readonly candidateCommit: string;
  readonly authorityEpoch: string;
}

export interface TrustedDeterministicGateRunnerV1 {
  resolveCurrentReceipts(
    query: CurrentGateReceiptQueryV1,
  ): Promise<readonly DeterministicGateReceiptV1[]>;
}

export interface TrustedEvaluationControlSnapshotV1 {
  readonly schema: 'hercules-trusted-evaluation-control/v1';
  readonly issuer: 'hercules-program-control';
  readonly authorityEpoch: string;
  readonly policy: EvaluationPolicyV1;
  readonly rubric: EvaluationRubricV1;
  readonly gatePlan: DeterministicGatePlanV1;
  readonly roles: EvaluationRunAuthorityV1;
  readonly observedAt: string;
  readonly controlIdentityHash: string;
  readonly controlObservationHash: string;
}

export interface TrustedEvaluationEvidenceSnapshotV1 {
  readonly schema: 'hercules-trusted-evaluation-evidence/v1';
  readonly sourceId: string;
  readonly taskContract: TaskContract;
  readonly iterationId: string;
  readonly candidateRef: CandidateRef;
  readonly evidenceManifest: EvidenceManifest;
  readonly artifacts: readonly ArtifactRef[];
  readonly verificationResult: VerificationResultV1;
  readonly assertions: readonly DecisionAssertion[];
  readonly verificationReceipts: readonly AssertionVerificationReceipt[];
  readonly integrityAttestation: EvidenceIntegrityAttestation;
  readonly observedAt: string;
  readonly freshUntil: string;
  readonly evidenceIdentityHash: string;
  readonly evidenceObservationHash: string;
}

// ---------------------------------------------------------------------------
// Subject input / locator / evaluator port / proposal / context / gap / receipt
// ---------------------------------------------------------------------------

export interface IndependentEvaluationInputV1 {
  readonly schema: 'hercules-independent-evaluation-input/v1';
  readonly requestId: string;
  readonly taskContract: TaskContract;
  readonly iterationId: string;
  readonly candidateRef: CandidateRef;
  readonly evidenceManifest: EvidenceManifest;
  readonly artifacts: readonly ArtifactRef[];
  readonly verificationResult: VerificationResultV1;
  readonly assertions: readonly DecisionAssertion[];
  readonly verificationReceipts: readonly AssertionVerificationReceipt[];
  readonly integrityAttestation: EvidenceIntegrityAttestation;
  readonly policyRef: EvaluationPolicyRefV1;
  readonly rubricRef: EvaluationRubricRefV1;
  readonly gatePlanRef: DeterministicGatePlanRefV1;
  readonly locatorHints: readonly ArtifactLocatorHintV1[];
  readonly inputHash: string;
}

export interface ArtifactLocatorHintV1 {
  readonly schema: 'hercules-artifact-locator-hint/v1';
  readonly artifactRefId: string;
  readonly producerRunId: string;
  readonly trustClass: 'agent_claim';
  readonly locatorKind: 'artifact_ref' | 'workspace_relative_path';
  readonly locator: string;
  readonly locatorHash: string;
}

export interface SanitizedAssertionViewV1 {
  readonly assertionId: string;
  readonly subjectKey: string;
  readonly classification: 'eligible_fact' | 'advisory_inference' | 'advisory_opinion';
  readonly canonicalPayload: CanonicalJsonValue;
  readonly payloadHash: string;
}

export interface SanitizedCriterionViewV1 {
  readonly criterionId: string;
  readonly required: boolean;
  readonly authority: CriterionAuthority;
  readonly allowedAdvisoryClasses: readonly ('inference' | 'opinion')[];
  readonly evaluatorInstructionArtifactId: string;
  readonly evaluatorInstructionArtifactHash: string;
}

export interface SanitizedEvaluationRequestV1 {
  readonly schema: 'hercules-sanitized-evaluation-request/v1';
  readonly requestId: string;
  readonly inputHash: string;
  readonly taskContractId: string;
  readonly taskContractVersion: number;
  readonly taskContractHash: string;
  readonly policyVersion: number;
  readonly policyHash: string;
  readonly rubricId: string;
  readonly rubricVersion: number;
  readonly rubricHash: string;
  readonly criteria: readonly SanitizedCriterionViewV1[];
  readonly preflight: DeterministicPreflightResultV1;
  readonly eligibleAssertions: readonly SanitizedAssertionViewV1[];
  readonly advisoryAssertions: readonly SanitizedAssertionViewV1[];
  readonly requestHash: string;
}

export interface IndependentEvaluatorPortV1 {
  evaluate(
    request: SanitizedEvaluationRequestV1,
    cancellation: EvaluationCancellationSignalV1,
  ): Promise<EvaluatorProposalV1>;
}

export interface EvaluationClockV1 {
  readonly capabilityId: string;
  readonly epochId: string;
  nowUtc(): string;
}

export interface EvaluationCancellationSignalV1 {
  readonly signalId: string;
  readonly attemptId: string;
  isCancelled(): boolean;
  onCancel(listener: (reason: EvaluationCancellationReasonV1) => void): () => void;
}

export type EvaluationCancellationReasonV1 = 'deadline' | 'peer_settled';

export interface EvaluationCancellationDispatchV1 {
  readonly signalId: string;
  readonly attemptId: string;
  readonly reason: EvaluationCancellationReasonV1;
  readonly status: 'dispatched' | 'already_cancelled' | 'dispatch_failed';
  readonly dispatchedAt: string;
  readonly dispatchHash: string;
}

export interface EvaluationCancellationControllerV1 {
  readonly signal: EvaluationCancellationSignalV1;
  cancel(reason: EvaluationCancellationReasonV1): EvaluationCancellationDispatchV1;
}

export interface EvaluationDeadlinePortV1 {
  expireAfter(
    milliseconds: number,
    cancellation: EvaluationCancellationSignalV1,
  ): Promise<'deadline_expired'>;
}

export interface EvaluationCancellationAttemptV1 {
  readonly attemptId: string;
  readonly evaluatorController: EvaluationCancellationControllerV1;
  readonly deadlineController: EvaluationCancellationControllerV1;
}

export interface TrustedEvaluationCancellationFactoryV1 {
  createAttempt(): EvaluationCancellationAttemptV1;
}

export interface TrustedEvaluatorAuthoritySnapshotV1 {
  readonly schema: 'hercules-trusted-evaluator-authority/v1';
  readonly issuer: 'hercules-program-control';
  readonly authorityEpoch: string;
  readonly evaluatorRunId: string;
  readonly evaluatorImplementationId: string;
  readonly evaluatorCapabilityId: string;
  readonly freshContextId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly authorityHash: string;
}

export interface TrustedEvaluationRuntimeCapabilityIdentityV1 {
  readonly schema: 'hercules-trusted-evaluation-runtime-capabilities/v1';
  readonly evaluatorCapabilityId: string;
  readonly gateResolverCapabilityId: string;
  readonly deadlineCapabilityId: string;
  readonly cancellationFactoryCapabilityId: string;
  readonly clockCapabilityId: string;
  readonly clockEpochId: string;
  readonly capabilitySetHash: string;
}

export interface TrustedEvaluationStableContextIdentityV1 {
  readonly schema: 'hercules-trusted-evaluation-stable-context/v1';
  readonly inputHash: string;
  readonly controlIdentityHash: string;
  readonly evidenceIdentityHash: string;
  readonly gateReceiptSetHash: string;
  readonly roleAuthorityHash: string;
  readonly evaluatorAuthorityHash: string;
  readonly runtimeCapabilitySetHash: string;
  readonly authorityEpoch: string;
  readonly clockCapabilityId: string;
  readonly clockEpochId: string;
  readonly freshUntil: string;
  readonly stableContextHash: string;
}

export interface TrustedCurrentEvaluationContextV1 {
  readonly schema: 'hercules-trusted-current-evaluation-context/v1';
  readonly inputHash: string;
  readonly control: TrustedEvaluationControlSnapshotV1;
  readonly evidence: TrustedEvaluationEvidenceSnapshotV1;
  readonly gateReceipts: readonly DeterministicGateReceiptV1[];
  readonly gateReceiptSetHash: string;
  readonly evaluatorAuthority: TrustedEvaluatorAuthoritySnapshotV1;
  readonly runtimeCapabilities: TrustedEvaluationRuntimeCapabilityIdentityV1;
  readonly stableIdentity: TrustedEvaluationStableContextIdentityV1;
  readonly observedAt: string;
  readonly freshness: 'fresh';
  readonly contextHash: string;
}

export interface EvaluationGapV1 {
  readonly schema: 'hercules-independent-evaluation-gap/v1';
  readonly requestId: string;
  readonly inputHash: string;
  readonly acceptedContextHash: string;
  readonly acceptedStableContextHash: string;
  readonly observedContextHash: string | null;
  readonly observedStableContextHash: string | null;
  readonly reason:
    | 'control_changed'
    | 'evidence_changed'
    | 'gate_receipts_changed'
    | 'role_authority_changed'
    | 'evaluator_authority_changed'
    | 'capability_identity_changed'
    | 'clock_identity_changed'
    | 'authority_epoch_changed'
    | 'clock_moved_backwards'
    | 'freshness_expired'
    | 'trusted_source_unavailable'
    | 'post_evaluation_context_malformed';
  readonly proposalDiscarded: true;
  readonly outcome: 'need_more_evidence';
  readonly observedAt: string;
  readonly gapHash: string;
}

export interface EvaluatorCriterionProposalV1 {
  readonly criterionId: string;
  readonly proposedStatus: 'pass' | 'fail' | 'insufficient_evidence';
  readonly premiseAssertionIds: readonly string[];
  readonly advisoryRationale: string;
}

export interface EvaluatorFindingProposalV1 {
  readonly findingCode: string;
  readonly severity: 'blocking' | 'advisory';
  readonly criterionIds: readonly string[];
  readonly assertionIds: readonly string[];
  readonly advisoryRationale: string;
}

export interface EvaluatorProposalV1 {
  readonly schema: 'hercules-evaluator-proposal/v1';
  readonly requestId: string;
  readonly inputHash: string;
  readonly evaluatorRunId: string;
  readonly evaluatorImplementationId: string;
  readonly proposalId: string;
  readonly criterionProposals: readonly EvaluatorCriterionProposalV1[];
  readonly findings: readonly EvaluatorFindingProposalV1[];
  readonly declaredUnknowns: readonly string[];
  readonly remainingRisks: readonly string[];
  readonly proposalHash: string;
}

export interface EvaluationCriterionRelationshipV1 {
  readonly criterionId: string;
  readonly assertionIds: readonly string[];
  readonly evidenceArtifactIds: readonly string[];
  readonly verificationReceiptIds: readonly string[];
  readonly relationshipHash: string;
}

export interface IndependentEvaluationReceiptV1 {
  readonly schema: 'hercules-independent-evaluation-receipt/v1';
  readonly receiptId: string;
  readonly requestId: string;
  readonly inputHash: string;
  readonly taskId: string;
  readonly taskContractHash: string;
  readonly iterationId: string;
  readonly candidateCommit: string;
  readonly manifestId: string;
  readonly manifestHash: string;
  readonly artifactInventoryHash: string;
  readonly verificationResultHash: string;
  readonly verificationReceiptSetHash: string;
  readonly integrityAttestationHash: string;
  readonly assertionSetHash: string;
  readonly gatePlanHash: string;
  readonly gateReceiptSetHash: string;
  readonly policyHash: string;
  readonly rubricHash: string;
  readonly roleAuthorityHash: string;
  readonly controlIdentityHash: string;
  readonly evidenceSourceId: string;
  readonly evidenceIdentityHash: string;
  readonly authorityEpoch: string;
  readonly coordinatorRunId: string;
  readonly evaluatorRunId: string;
  readonly evaluatorImplementationId: string;
  readonly acceptedContextHash: string;
  readonly postEvaluationContextHash: string;
  readonly stableContextHash: string;
  readonly acceptedObservedAt: string;
  readonly postEvaluationObservedAt: string;
  readonly freshUntil: string;
  readonly preflightHash: string;
  readonly proposalHash: string | null;
  readonly noProposalReason:
    | 'deterministic_fail'
    | 'deterministic_pass'
    | 'evidence_gap'
    | null;
  readonly cancellationDispatches: readonly EvaluationCancellationDispatchV1[];
  readonly verdict: EvaluationVerdict;
  readonly verdictHash: string;
  readonly criterionRelationships: readonly EvaluationCriterionRelationshipV1[];
  readonly outcomeReasonCodes: readonly string[];
  readonly createdAt: string;
  readonly receiptHash: string;
}

// ---------------------------------------------------------------------------
// Deterministic preflight records (M8 slice 2)
// ---------------------------------------------------------------------------

export const PREFLIGHT_CHECK_IDS = [
  'structural_input',
  'subject_relationships',
  'artifact_integrity',
  'verification_result',
  'claim_eligibility',
  'control_authority',
  'deterministic_gates',
  'real_surface_coverage',
  'contradiction_and_sufficiency',
  'model_judgment_necessity',
] as const;
export type PreflightCheckIdV1 = (typeof PREFLIGHT_CHECK_IDS)[number];

export const PREFLIGHT_CHECK_STATUSES = [
  'pass',
  'verified_fail',
  'need_more_evidence',
  'model_judgment_required',
] as const;
export type PreflightCheckStatusV1 = (typeof PREFLIGHT_CHECK_STATUSES)[number];

export interface DeterministicPreflightCheckV1 {
  readonly checkId: PreflightCheckIdV1;
  readonly status: PreflightCheckStatusV1;
  readonly code: IndependentEvaluationErrorCode | 'ok' | 'model_judgment_required';
  readonly criterionIds: readonly string[];
  readonly assertionIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly advisoryDetail: string;
  readonly checkHash: string;
}

export interface DeterministicPreflightResultV1 {
  readonly schema: 'hercules-deterministic-preflight/v1';
  readonly inputHash: string;
  readonly controlIdentityHash: string;
  readonly evidenceIdentityHash: string;
  readonly gateReceiptSetHash: string;
  readonly checks: readonly DeterministicPreflightCheckV1[];
  readonly classification: PreflightCheckStatusV1;
  readonly eligibleAssertionIds: readonly string[];
  readonly preflightHash: string;
}

// ---------------------------------------------------------------------------
// Internal helpers (claimAuthorityV2 pattern)
// ---------------------------------------------------------------------------

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_ARRAY_ITEMS = 4_096;
const MAX_LOCATOR_BYTES = 1_024;
const MAX_DECLARED_STRINGS = 64;

const MAX_INPUT_BYTES = 2_097_152;
const MAX_ARTIFACTS = 512;
const MAX_ASSERTIONS = 2_048;
const MAX_PREMISES_PER_CRITERION = 128;
const MAX_RATIONALE_BYTES = 8_192;
const MAX_EVALUATOR_DEADLINE_MS = 300_000;

const ROLE_DISJOINTNESS_VALUES = ['implementer', 'verifier', 'reviewer'] as const;
const ADVISORY_CLASSES = ['inference', 'opinion'] as const;
const OBSERVATION_KINDS = ['mechanical', 'real_surface', 'integrity'] as const;
const OBSERVATION_STATUSES = ['pass', 'verified_fail', 'unavailable'] as const;
const RESULT_STATUSES = ['complete', 'incomplete', 'unavailable'] as const;
const GATE_KINDS = ['coordinator_builtin', 'trusted_external_receipt'] as const;
const GATE_RECEIPT_STATUSES = ['pass', 'verified_fail', 'unavailable'] as const;
const LOCATOR_KINDS = ['artifact_ref', 'workspace_relative_path'] as const;
const PROPOSED_STATUSES = ['pass', 'fail', 'insufficient_evidence'] as const;
const FINDING_SEVERITIES = ['blocking', 'advisory'] as const;
const CANCELLATION_REASONS = ['deadline', 'peer_settled'] as const;
const CANCELLATION_STATUSES = [
  'dispatched',
  'already_cancelled',
  'dispatch_failed',
] as const;
const GAP_REASONS = [
  'control_changed',
  'evidence_changed',
  'gate_receipts_changed',
  'role_authority_changed',
  'evaluator_authority_changed',
  'capability_identity_changed',
  'clock_identity_changed',
  'authority_epoch_changed',
  'clock_moved_backwards',
  'freshness_expired',
  'trusted_source_unavailable',
  'post_evaluation_context_malformed',
] as const;
const NO_PROPOSAL_REASONS = [
  'deterministic_fail',
  'deterministic_pass',
  'evidence_gap',
] as const;
const VERIFICATION_OBSERVATION_KEYS = [
  'observationId',
  'kind',
  'criterionIds',
  'status',
  'artifactIds',
  'assertionIds',
  'verificationReceiptIds',
  'observedAt',
  'observationHash',
] as const;

const VERIFICATION_RESULT_KEYS = [
  'schema',
  'verificationResultId',
  'verifierRunId',
  'taskId',
  'taskContractHash',
  'iterationId',
  'candidateCommit',
  'manifestId',
  'manifestHash',
  'startedAt',
  'completedAt',
  'status',
  'observations',
  'resultHash',
] as const;

const POLICY_REF_KEYS = ['schema', 'policyId', 'version', 'policyHash'] as const;
const RUBRIC_REF_KEYS = ['schema', 'rubricId', 'version', 'rubricHash'] as const;
const GATE_PLAN_REF_KEYS = ['schema', 'gatePlanId', 'version', 'gatePlanHash'] as const;

const POLICY_KEYS = [
  'schema',
  'policyId',
  'version',
  'issuer',
  'authorityEpoch',
  'issuedAt',
  'expiresAt',
  'maxInputBytes',
  'maxArtifacts',
  'maxAssertions',
  'maxPremisesPerCriterion',
  'maxRationaleBytes',
  'evaluatorDeadlineMs',
  'requiredRoleDisjointness',
  'allowedEvaluatorImplementationIds',
  'verifiedFactsOnly',
  'failClosedOnEvidenceGap',
  'freshEvaluatorRequired',
  'implementerEvaluatorForbidden',
  'callerGateResultsForbidden',
  'automaticRetryForbidden',
  'recommendationIsAdvisory',
  'policyHash',
] as const;

const RUBRIC_CRITERION_KEYS = [
  'criterionId',
  'required',
  'authority',
  'allowedAdvisoryClasses',
  'requiredGateIds',
  'requiredSurfaceIds',
  'evaluatorInstructionArtifactId',
  'evaluatorInstructionArtifactHash',
] as const;

const RUBRIC_KEYS = [
  'schema',
  'rubricId',
  'version',
  'issuer',
  'authorityEpoch',
  'taskContractId',
  'taskContractVersion',
  'taskContractHash',
  'criteria',
  'rubricHash',
] as const;

const RUN_AUTHORITY_KEYS = [
  'schema',
  'issuer',
  'authorityEpoch',
  'coordinatorRunId',
  'coordinatorRole',
  'evaluatorRunId',
  'evaluatorImplementationId',
  'evaluatorRole',
  'implementerRunIds',
  'verifierRunIds',
  'reviewerRunIds',
  'freshContextId',
  'freshContextCreatedAt',
  'expiresAt',
  'authorityHash',
] as const;

const GATE_DEFINITION_KEYS = [
  'gateId',
  'version',
  'kind',
  'registryFunctionId',
  'requiredEnvironmentFields',
  'requiredArtifactKinds',
  'definitionHash',
] as const;

const GATE_PLAN_KEYS = [
  'schema',
  'gatePlanId',
  'version',
  'issuer',
  'authorityEpoch',
  'taskContractHash',
  'candidateCommit',
  'gates',
  'gatePlanHash',
] as const;

const GATE_RECEIPT_KEYS = [
  'schema',
  'gatePlanId',
  'gatePlanHash',
  'gateId',
  'gateVersion',
  'gateDefinitionHash',
  'runnerIssuer',
  'runnerRunId',
  'authorityEpoch',
  'taskId',
  'taskContractHash',
  'iterationId',
  'candidateCommit',
  'environmentIdentity',
  'commandOrSpecHash',
  'startedAt',
  'completedAt',
  'expiresAt',
  'status',
  'exitCode',
  'outputArtifactIds',
  'outputArtifactHashes',
  'assertionIds',
  'verificationReceiptIds',
  'receiptHash',
] as const;

const GATE_RECEIPT_QUERY_KEYS = [
  'gatePlanId',
  'gatePlanHash',
  'taskId',
  'taskContractHash',
  'iterationId',
  'candidateCommit',
  'authorityEpoch',
] as const;

const CONTROL_SNAPSHOT_KEYS = [
  'schema',
  'issuer',
  'authorityEpoch',
  'policy',
  'rubric',
  'gatePlan',
  'roles',
  'observedAt',
  'controlIdentityHash',
  'controlObservationHash',
] as const;

const EVIDENCE_SNAPSHOT_KEYS = [
  'schema',
  'sourceId',
  'taskContract',
  'iterationId',
  'candidateRef',
  'evidenceManifest',
  'artifacts',
  'verificationResult',
  'assertions',
  'verificationReceipts',
  'integrityAttestation',
  'observedAt',
  'freshUntil',
  'evidenceIdentityHash',
  'evidenceObservationHash',
] as const;

const INPUT_KEYS = [
  'schema',
  'requestId',
  'taskContract',
  'iterationId',
  'candidateRef',
  'evidenceManifest',
  'artifacts',
  'verificationResult',
  'assertions',
  'verificationReceipts',
  'integrityAttestation',
  'policyRef',
  'rubricRef',
  'gatePlanRef',
  'locatorHints',
  'inputHash',
] as const;

const LOCATOR_HINT_KEYS = [
  'schema',
  'artifactRefId',
  'producerRunId',
  'trustClass',
  'locatorKind',
  'locator',
  'locatorHash',
] as const;

const SANITIZED_ASSERTION_VIEW_KEYS = [
  'assertionId',
  'subjectKey',
  'classification',
  'canonicalPayload',
  'payloadHash',
] as const;

const SANITIZED_CRITERION_VIEW_KEYS = [
  'criterionId',
  'required',
  'authority',
  'allowedAdvisoryClasses',
  'evaluatorInstructionArtifactId',
  'evaluatorInstructionArtifactHash',
] as const;

const SANITIZED_EVALUATION_REQUEST_KEYS = [
  'schema',
  'requestId',
  'inputHash',
  'taskContractId',
  'taskContractVersion',
  'taskContractHash',
  'policyVersion',
  'policyHash',
  'rubricId',
  'rubricVersion',
  'rubricHash',
  'criteria',
  'preflight',
  'eligibleAssertions',
  'advisoryAssertions',
  'requestHash',
] as const;

const SANITIZED_ASSERTION_CLASSIFICATIONS = [
  'eligible_fact',
  'advisory_inference',
  'advisory_opinion',
] as const;

const CRITERION_PROPOSAL_KEYS = [
  'criterionId',
  'proposedStatus',
  'premiseAssertionIds',
  'advisoryRationale',
] as const;

const FINDING_PROPOSAL_KEYS = [
  'findingCode',
  'severity',
  'criterionIds',
  'assertionIds',
  'advisoryRationale',
] as const;

const PROPOSAL_KEYS = [
  'schema',
  'requestId',
  'inputHash',
  'evaluatorRunId',
  'evaluatorImplementationId',
  'proposalId',
  'criterionProposals',
  'findings',
  'declaredUnknowns',
  'remainingRisks',
  'proposalHash',
] as const;

const EVALUATOR_AUTHORITY_KEYS = [
  'schema',
  'issuer',
  'authorityEpoch',
  'evaluatorRunId',
  'evaluatorImplementationId',
  'evaluatorCapabilityId',
  'freshContextId',
  'issuedAt',
  'expiresAt',
  'authorityHash',
] as const;

const RUNTIME_CAPABILITY_KEYS = [
  'schema',
  'evaluatorCapabilityId',
  'gateResolverCapabilityId',
  'deadlineCapabilityId',
  'cancellationFactoryCapabilityId',
  'clockCapabilityId',
  'clockEpochId',
  'capabilitySetHash',
] as const;

const STABLE_CONTEXT_KEYS = [
  'schema',
  'inputHash',
  'controlIdentityHash',
  'evidenceIdentityHash',
  'gateReceiptSetHash',
  'roleAuthorityHash',
  'evaluatorAuthorityHash',
  'runtimeCapabilitySetHash',
  'authorityEpoch',
  'clockCapabilityId',
  'clockEpochId',
  'freshUntil',
  'stableContextHash',
] as const;

const CURRENT_CONTEXT_KEYS = [
  'schema',
  'inputHash',
  'control',
  'evidence',
  'gateReceipts',
  'gateReceiptSetHash',
  'evaluatorAuthority',
  'runtimeCapabilities',
  'stableIdentity',
  'observedAt',
  'freshness',
  'contextHash',
] as const;

const GAP_KEYS = [
  'schema',
  'requestId',
  'inputHash',
  'acceptedContextHash',
  'acceptedStableContextHash',
  'observedContextHash',
  'observedStableContextHash',
  'reason',
  'proposalDiscarded',
  'outcome',
  'observedAt',
  'gapHash',
] as const;

const CANCELLATION_DISPATCH_KEYS = [
  'signalId',
  'attemptId',
  'reason',
  'status',
  'dispatchedAt',
  'dispatchHash',
] as const;

const CRITERION_RELATIONSHIP_KEYS = [
  'criterionId',
  'assertionIds',
  'evidenceArtifactIds',
  'verificationReceiptIds',
  'relationshipHash',
] as const;

const RECEIPT_KEYS = [
  'schema',
  'receiptId',
  'requestId',
  'inputHash',
  'taskId',
  'taskContractHash',
  'iterationId',
  'candidateCommit',
  'manifestId',
  'manifestHash',
  'artifactInventoryHash',
  'verificationResultHash',
  'verificationReceiptSetHash',
  'integrityAttestationHash',
  'assertionSetHash',
  'gatePlanHash',
  'gateReceiptSetHash',
  'policyHash',
  'rubricHash',
  'roleAuthorityHash',
  'controlIdentityHash',
  'evidenceSourceId',
  'evidenceIdentityHash',
  'authorityEpoch',
  'coordinatorRunId',
  'evaluatorRunId',
  'evaluatorImplementationId',
  'acceptedContextHash',
  'postEvaluationContextHash',
  'stableContextHash',
  'acceptedObservedAt',
  'postEvaluationObservedAt',
  'freshUntil',
  'preflightHash',
  'proposalHash',
  'noProposalReason',
  'cancellationDispatches',
  'verdict',
  'verdictHash',
  'criterionRelationships',
  'outcomeReasonCodes',
  'createdAt',
  'receiptHash',
] as const;

const VERDICT_KEYS = [
  'id',
  'binding',
  'outcome',
  'criterionResults',
  'blockingFindings',
  'nonBlockingRisks',
  'recommendedNextStage',
  'evaluatorAgentRunId',
  'createdAt',
] as const;

const PREFLIGHT_CHECK_KEYS = [
  'checkId',
  'status',
  'code',
  'criterionIds',
  'assertionIds',
  'evidenceIds',
  'advisoryDetail',
  'checkHash',
] as const;

const PREFLIGHT_RESULT_KEYS = [
  'schema',
  'inputHash',
  'controlIdentityHash',
  'evidenceIdentityHash',
  'gateReceiptSetHash',
  'checks',
  'classification',
  'eligibleAssertionIds',
  'preflightHash',
] as const;

const PREFLIGHT_CHECK_CODES = [
  'ok',
  'model_judgment_required',
  'invalid_input_schema',
  'stale_binding',
  'artifact_integrity',
  'verification_incomplete',
  'claim_ineligible',
  'claim_contradiction',
  'policy_denial',
  'role_conflict',
  'deterministic_gate_failed',
  'real_surface_missing',
  'evaluator_unavailable',
  'evaluator_contract_violation',
  'idempotency_conflict',
] as const;

function fail(message: string): never {
  throw new IndependentEvaluationError('invalid_input_schema', message);
}

function assertExactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Readonly<Record<string, unknown>> {
  try {
    canonicalSerialize(value);
  } catch (error) {
    fail(`${label} must be stable canonical JSON: ${String(error)}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} must use the exact closed schema`);
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

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || utf8Bytes(value) > MAX_IDENTIFIER_BYTES) {
    return false;
  }
  const time = new Date(value);
  return !Number.isNaN(time.valueOf()) && time.toISOString() === value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
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

function assertSortedUniqueIdentifiers(
  value: unknown,
  label: string,
  allowEmpty = true,
): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_ARRAY_ITEMS ||
    (!allowEmpty && value.length === 0)
  ) {
    fail(`${label} must be a bounded${allowEmpty ? '' : ' non-empty'} array`);
  }
  let previous: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || !isBoundedIdentifier(value[index])) {
      fail(`${label} must contain bounded UTF-8 identities`);
    }
    const current = value[index];
    if (previous !== null && previous >= current) {
      fail(`${label} must contain sorted unique identities`);
    }
    previous = current;
  }
}

function assertSortedUniqueLiteralSet<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): asserts value is readonly T[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) {
    fail(`${label} must be a bounded array`);
  }
  let previous: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || typeof value[index] !== 'string') {
      fail(`${label} must not be sparse and must contain strings`);
    }
    const current = value[index] as string;
    if (!(allowed as readonly string[]).includes(current)) {
      fail(`${label} contains an unknown member`);
    }
    if (previous !== null && previous >= current) {
      fail(`${label} must contain sorted unique members`);
    }
    previous = current;
  }
}

function assertTimestampAfter(
  later: string,
  earlier: string,
  label: string,
): void {
  if (Date.parse(later) <= Date.parse(earlier)) {
    fail(`${label} must be strictly after its earlier timestamp`);
  }
}

function assertTimestampNotAfter(
  earlierOrEqual: string,
  laterOrEqual: string,
  label: string,
): void {
  if (Date.parse(earlierOrEqual) > Date.parse(laterOrEqual)) {
    fail(`${label} must not be after its later bound`);
  }
}

function assertAdvisoryRationale(
  value: unknown,
  maxBytes: number,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || utf8Bytes(value) > maxBytes) {
    fail(`${label} must be a UTF-8 string within the rationale byte bound`);
  }
}

function assertBoundedStringList(
  value: unknown,
  label: string,
  maxItems: number,
): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    fail(`${label} must be a bounded array of at most ${maxItems} entries`);
  }
  let previous: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || !isBoundedNfcString(value[index])) {
      fail(`${label} must contain bounded non-empty NFC strings`);
    }
    const current = value[index];
    if (previous !== null && previous >= current) {
      fail(`${label} must contain sorted unique strings`);
    }
    previous = current;
  }
}

function assertDenseArray(
  value: unknown,
  label: string,
): asserts value is readonly unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) {
    fail(`${label} must be a bounded array`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) {
      fail(`${label} must not be sparse`);
    }
  }
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function computeVerificationObservationHash(
  observation: Omit<VerificationObservationV1, 'observationHash'>,
): string {
  return hashCanonicalJson(observation);
}

export function computeVerificationResultHash(
  result: Omit<VerificationResultV1, 'resultHash'>,
): string {
  return hashCanonicalJson(result);
}

export function computeEvaluationPolicyHash(
  policy: Omit<EvaluationPolicyV1, 'policyHash'>,
): string {
  return hashCanonicalJson(policy);
}

export function computeEvaluationRubricHash(
  rubric: Omit<EvaluationRubricV1, 'rubricHash'>,
): string {
  return hashCanonicalJson(rubric);
}

export function computeRunAuthorityHash(
  authority: Omit<EvaluationRunAuthorityV1, 'authorityHash'>,
): string {
  return hashCanonicalJson(authority);
}

export function computeGateDefinitionHash(
  definition: Omit<DeterministicGateDefinitionV1, 'definitionHash'>,
): string {
  return hashCanonicalJson(definition);
}

export function computeGatePlanHash(
  plan: Omit<DeterministicGatePlanV1, 'gatePlanHash'>,
): string {
  return hashCanonicalJson(plan);
}

export function computeGateReceiptHash(
  receipt: Omit<DeterministicGateReceiptV1, 'receiptHash'>,
): string {
  return hashCanonicalJson(receipt);
}

export function computeControlIdentityHash(
  snapshot: Pick<
    TrustedEvaluationControlSnapshotV1,
    | 'schema'
    | 'issuer'
    | 'authorityEpoch'
    | 'policy'
    | 'rubric'
    | 'gatePlan'
    | 'roles'
  >,
): string {
  return hashCanonicalJson({
    schema: snapshot.schema,
    issuer: snapshot.issuer,
    authorityEpoch: snapshot.authorityEpoch,
    policy: snapshot.policy,
    rubric: snapshot.rubric,
    gatePlan: snapshot.gatePlan,
    roles: snapshot.roles,
  });
}

export function computeControlObservationHash(
  controlIdentityHash: string,
  observedAt: string,
): string {
  return hashCanonicalJson({
    controlIdentityHash,
    observedAt,
  });
}

export function computeEvidenceIdentityHash(
  snapshot: Pick<
    TrustedEvaluationEvidenceSnapshotV1,
    | 'schema'
    | 'sourceId'
    | 'taskContract'
    | 'iterationId'
    | 'candidateRef'
    | 'evidenceManifest'
    | 'artifacts'
    | 'verificationResult'
    | 'assertions'
    | 'verificationReceipts'
    | 'integrityAttestation'
  >,
): string {
  return hashCanonicalJson({
    schema: snapshot.schema,
    sourceId: snapshot.sourceId,
    taskContract: snapshot.taskContract,
    iterationId: snapshot.iterationId,
    candidateRef: snapshot.candidateRef,
    evidenceManifest: snapshot.evidenceManifest,
    artifacts: snapshot.artifacts,
    verificationResult: snapshot.verificationResult,
    assertions: snapshot.assertions,
    verificationReceipts: snapshot.verificationReceipts,
    integrityAttestation: snapshot.integrityAttestation,
  });
}

export function computeEvidenceObservationHash(
  evidenceIdentityHash: string,
  observedAt: string,
  freshUntil: string,
): string {
  return hashCanonicalJson({
    evidenceIdentityHash,
    observedAt,
    freshUntil,
  });
}

export function computeGateReceiptSetHash(
  receipts: readonly DeterministicGateReceiptV1[],
): string {
  const sorted = [...receipts].sort((left, right) => {
    if (left.receiptHash < right.receiptHash) return -1;
    if (left.receiptHash > right.receiptHash) return 1;
    return 0;
  });
  return hashCanonicalJson(sorted);
}

export function computeInputHash(
  input: Omit<IndependentEvaluationInputV1, 'inputHash'>,
): string {
  return hashCanonicalJson(input);
}

export function computeLocatorHintHash(
  hint: Omit<ArtifactLocatorHintV1, 'locatorHash'>,
): string {
  return hashCanonicalJson(hint);
}

export function computeProposalHash(
  proposal: Omit<EvaluatorProposalV1, 'proposalHash'>,
): string {
  return hashCanonicalJson(proposal);
}

export function computeCriterionRelationshipHash(
  relationship: Omit<EvaluationCriterionRelationshipV1, 'relationshipHash'>,
): string {
  return hashCanonicalJson(relationship);
}

export function computeEvaluatorAuthorityHash(
  authority: Omit<TrustedEvaluatorAuthoritySnapshotV1, 'authorityHash'>,
): string {
  return hashCanonicalJson(authority);
}

export function computeCapabilitySetHash(
  identity: Omit<TrustedEvaluationRuntimeCapabilityIdentityV1, 'capabilitySetHash'>,
): string {
  return hashCanonicalJson(identity);
}

export function computeStableContextHash(
  identity: Omit<TrustedEvaluationStableContextIdentityV1, 'stableContextHash'>,
): string {
  return hashCanonicalJson(identity);
}

export function computeCurrentContextHash(
  context: Omit<TrustedCurrentEvaluationContextV1, 'contextHash'>,
): string {
  return hashCanonicalJson(context);
}

export function computeGapHash(gap: Omit<EvaluationGapV1, 'gapHash'>): string {
  return hashCanonicalJson(gap);
}

export function computeCancellationDispatchHash(
  dispatch: Omit<EvaluationCancellationDispatchV1, 'dispatchHash'>,
): string {
  return hashCanonicalJson(dispatch);
}

export function computeVerdictHash(verdict: EvaluationVerdict): string {
  return hashCanonicalJson(verdict);
}

export function computeEvaluationReceiptHash(
  receipt: Omit<IndependentEvaluationReceiptV1, 'receiptHash'>,
): string {
  return hashCanonicalJson(receipt);
}

export function computePreflightCheckHash(
  check: Omit<DeterministicPreflightCheckV1, 'checkHash'>,
): string {
  return hashCanonicalJson(check);
}

export function computePreflightResultHash(
  result: Omit<DeterministicPreflightResultV1, 'preflightHash'>,
): string {
  return hashCanonicalJson(result);
}

export function computeSanitizedEvaluationRequestHash(
  request: Omit<SanitizedEvaluationRequestV1, 'requestHash'>,
): string {
  return hashCanonicalJson(request);
}

// ---------------------------------------------------------------------------
// Structural validators
// ---------------------------------------------------------------------------

export function assertVerificationObservationV1(
  observation: VerificationObservationV1,
): void {
  assertExactRecord(
    observation,
    VERIFICATION_OBSERVATION_KEYS,
    'verification observation',
  );
  if (
    !isBoundedIdentifier(observation.observationId) ||
    !(OBSERVATION_KINDS as readonly unknown[]).includes(observation.kind) ||
    !(OBSERVATION_STATUSES as readonly unknown[]).includes(observation.status) ||
    !isCanonicalTimestamp(observation.observedAt) ||
    !isHash(observation.observationHash)
  ) {
    fail(
      'verification observation identity, kind, status, timestamp, and hash must be valid',
    );
  }
  assertSortedUniqueIdentifiers(observation.criterionIds, 'observation criterion ids');
  assertSortedUniqueIdentifiers(observation.artifactIds, 'observation artifact ids');
  assertSortedUniqueIdentifiers(observation.assertionIds, 'observation assertion ids');
  assertSortedUniqueIdentifiers(
    observation.verificationReceiptIds,
    'observation verification receipt ids',
  );
  const expected = hashCanonicalJson(omitHash(observation, 'observationHash'));
  if (observation.observationHash !== expected) {
    fail('verification observation hash does not match the exact record');
  }
}

export function assertVerificationResultV1(result: VerificationResultV1): void {
  assertExactRecord(result, VERIFICATION_RESULT_KEYS, 'verification result');
  if (
    result.schema !== 'hercules-verification-result/v1' ||
    !isBoundedIdentifier(result.verificationResultId) ||
    !isBoundedIdentifier(result.verifierRunId) ||
    !isBoundedIdentifier(result.taskId) ||
    !isHash(result.taskContractHash) ||
    !isBoundedIdentifier(result.iterationId) ||
    !isGitSha(result.candidateCommit) ||
    !isBoundedIdentifier(result.manifestId) ||
    !isHash(result.manifestHash) ||
    !isCanonicalTimestamp(result.startedAt) ||
    !isCanonicalTimestamp(result.completedAt) ||
    !(RESULT_STATUSES as readonly unknown[]).includes(result.status) ||
    !isHash(result.resultHash)
  ) {
    fail(
      'verification result identity, binding, timestamps, status, and hash must be valid',
    );
  }
  assertDenseArray(result.observations, 'verification result observations');
  const observationIds = new Set<string>();
  for (const observation of result.observations) {
    assertVerificationObservationV1(observation);
    if (observationIds.has(observation.observationId)) {
      fail('verification result observation ids must be unique');
    }
    observationIds.add(observation.observationId);
  }
  const expected = hashCanonicalJson(omitHash(result, 'resultHash'));
  if (result.resultHash !== expected) {
    fail('verification result hash does not match the exact record');
  }
}

export function assertEvaluationPolicyRefV1(ref: EvaluationPolicyRefV1): void {
  assertExactRecord(ref, POLICY_REF_KEYS, 'evaluation policy ref');
  if (
    ref.schema !== 'hercules-evaluation-policy-ref/v1' ||
    ref.policyId !== 'hercules-v1-independent-evaluation' ||
    !isPositiveSafeInteger(ref.version) ||
    !isHash(ref.policyHash)
  ) {
    fail('evaluation policy ref must use the exact closed literals and hash');
  }
}

export function assertEvaluationRubricRefV1(ref: EvaluationRubricRefV1): void {
  assertExactRecord(ref, RUBRIC_REF_KEYS, 'evaluation rubric ref');
  if (
    ref.schema !== 'hercules-evaluation-rubric-ref/v1' ||
    !isBoundedIdentifier(ref.rubricId) ||
    !isPositiveSafeInteger(ref.version) ||
    !isHash(ref.rubricHash)
  ) {
    fail('evaluation rubric ref must use bounded identity, version, and hash');
  }
}

export function assertDeterministicGatePlanRefV1(
  ref: DeterministicGatePlanRefV1,
): void {
  assertExactRecord(ref, GATE_PLAN_REF_KEYS, 'deterministic gate plan ref');
  if (
    ref.schema !== 'hercules-deterministic-gate-plan-ref/v1' ||
    !isBoundedIdentifier(ref.gatePlanId) ||
    !isPositiveSafeInteger(ref.version) ||
    !isHash(ref.gatePlanHash)
  ) {
    fail('deterministic gate plan ref must use bounded identity, version, and hash');
  }
}

export function assertEvaluationPolicyV1(policy: EvaluationPolicyV1): void {
  assertExactRecord(policy, POLICY_KEYS, 'evaluation policy');
  if (
    policy.schema !== 'hercules-evaluation-policy/v1' ||
    policy.policyId !== 'hercules-v1-independent-evaluation' ||
    policy.issuer !== 'hercules-program-control' ||
    !isPositiveSafeInteger(policy.version) ||
    !isBoundedNfcString(policy.authorityEpoch) ||
    !isCanonicalTimestamp(policy.issuedAt) ||
    !isCanonicalTimestamp(policy.expiresAt) ||
    !isPositiveSafeInteger(policy.maxInputBytes) ||
    policy.maxInputBytes > MAX_INPUT_BYTES ||
    !isPositiveSafeInteger(policy.maxArtifacts) ||
    policy.maxArtifacts > MAX_ARTIFACTS ||
    !isPositiveSafeInteger(policy.maxAssertions) ||
    policy.maxAssertions > MAX_ASSERTIONS ||
    !isPositiveSafeInteger(policy.maxPremisesPerCriterion) ||
    policy.maxPremisesPerCriterion > MAX_PREMISES_PER_CRITERION ||
    !isPositiveSafeInteger(policy.maxRationaleBytes) ||
    policy.maxRationaleBytes > MAX_RATIONALE_BYTES ||
    !isPositiveSafeInteger(policy.evaluatorDeadlineMs) ||
    policy.evaluatorDeadlineMs > MAX_EVALUATOR_DEADLINE_MS ||
    policy.verifiedFactsOnly !== true ||
    policy.failClosedOnEvidenceGap !== true ||
    policy.freshEvaluatorRequired !== true ||
    policy.implementerEvaluatorForbidden !== true ||
    policy.callerGateResultsForbidden !== true ||
    policy.automaticRetryForbidden !== true ||
    policy.recommendationIsAdvisory !== true ||
    !isHash(policy.policyHash)
  ) {
    fail(
      'evaluation policy must use exact literals, positive compiled ceilings, and valid timestamps/hash',
    );
  }
  assertTimestampAfter(policy.expiresAt, policy.issuedAt, 'evaluation policy expiresAt');
  assertSortedUniqueLiteralSet(
    policy.requiredRoleDisjointness,
    ROLE_DISJOINTNESS_VALUES,
    'evaluation policy requiredRoleDisjointness',
  );
  assertSortedUniqueIdentifiers(
    policy.allowedEvaluatorImplementationIds,
    'evaluation policy allowedEvaluatorImplementationIds',
  );
  const expected = hashCanonicalJson(omitHash(policy, 'policyHash'));
  if (policy.policyHash !== expected) {
    fail('evaluation policy hash does not match the exact record');
  }
}

export function assertEvaluationRubricCriterionV1(
  criterion: EvaluationRubricCriterionV1,
): void {
  assertExactRecord(criterion, RUBRIC_CRITERION_KEYS, 'evaluation rubric criterion');
  if (
    !isBoundedIdentifier(criterion.criterionId) ||
    typeof criterion.required !== 'boolean' ||
    !(CRITERION_AUTHORITIES as readonly unknown[]).includes(criterion.authority) ||
    !isBoundedIdentifier(criterion.evaluatorInstructionArtifactId) ||
    !isHash(criterion.evaluatorInstructionArtifactHash)
  ) {
    fail(
      'evaluation rubric criterion identity, authority, and instruction artifact must be valid',
    );
  }
  assertSortedUniqueLiteralSet(
    criterion.allowedAdvisoryClasses,
    ADVISORY_CLASSES,
    'evaluation rubric criterion allowedAdvisoryClasses',
  );
  assertSortedUniqueIdentifiers(
    criterion.requiredGateIds,
    'evaluation rubric criterion requiredGateIds',
  );
  assertSortedUniqueIdentifiers(
    criterion.requiredSurfaceIds,
    'evaluation rubric criterion requiredSurfaceIds',
  );
}

export function assertEvaluationRubricV1(rubric: EvaluationRubricV1): void {
  assertExactRecord(rubric, RUBRIC_KEYS, 'evaluation rubric');
  if (
    rubric.schema !== 'hercules-evaluation-rubric/v1' ||
    !isBoundedIdentifier(rubric.rubricId) ||
    !isPositiveSafeInteger(rubric.version) ||
    rubric.issuer !== 'hercules-program-control' ||
    !isBoundedNfcString(rubric.authorityEpoch) ||
    !isBoundedIdentifier(rubric.taskContractId) ||
    !isPositiveSafeInteger(rubric.taskContractVersion) ||
    !isHash(rubric.taskContractHash) ||
    !isHash(rubric.rubricHash)
  ) {
    fail(
      'evaluation rubric identity, issuer, contract binding, and hash must be valid',
    );
  }
  assertDenseArray(rubric.criteria, 'evaluation rubric criteria');
  if (rubric.criteria.length === 0) {
    fail('evaluation rubric criteria must be non-empty');
  }
  const criterionIds = new Set<string>();
  for (const criterion of rubric.criteria) {
    assertEvaluationRubricCriterionV1(criterion);
    if (criterionIds.has(criterion.criterionId)) {
      fail('evaluation rubric criterion ids must be unique');
    }
    criterionIds.add(criterion.criterionId);
  }
  const expected = hashCanonicalJson(omitHash(rubric, 'rubricHash'));
  if (rubric.rubricHash !== expected) {
    fail('evaluation rubric hash does not match the exact record');
  }
}

export function assertEvaluationRunAuthorityV1(
  authority: EvaluationRunAuthorityV1,
): void {
  assertExactRecord(authority, RUN_AUTHORITY_KEYS, 'evaluation run authority');
  if (
    authority.schema !== 'hercules-evaluation-run-authority/v1' ||
    authority.issuer !== 'hercules-program-control' ||
    !isBoundedNfcString(authority.authorityEpoch) ||
    !isBoundedIdentifier(authority.coordinatorRunId) ||
    authority.coordinatorRole !== 'trusted_coordinator' ||
    !isBoundedIdentifier(authority.evaluatorRunId) ||
    !isBoundedIdentifier(authority.evaluatorImplementationId) ||
    authority.evaluatorRole !== 'evaluator' ||
    !isBoundedIdentifier(authority.freshContextId) ||
    !isCanonicalTimestamp(authority.freshContextCreatedAt) ||
    !isCanonicalTimestamp(authority.expiresAt) ||
    !isHash(authority.authorityHash)
  ) {
    fail(
      'evaluation run authority must use exact role literals, bounded identities, timestamps, and hash',
    );
  }
  assertSortedUniqueIdentifiers(
    authority.implementerRunIds,
    'evaluation run authority implementerRunIds',
  );
  assertSortedUniqueIdentifiers(
    authority.verifierRunIds,
    'evaluation run authority verifierRunIds',
  );
  assertSortedUniqueIdentifiers(
    authority.reviewerRunIds,
    'evaluation run authority reviewerRunIds',
  );
  if (authority.implementerRunIds.includes(authority.evaluatorRunId)) {
    fail('evaluator run id must not appear in implementerRunIds');
  }
  const expected = hashCanonicalJson(omitHash(authority, 'authorityHash'));
  if (authority.authorityHash !== expected) {
    fail('evaluation run authority hash does not match the exact record');
  }
}

export function assertRunAuthorityDisjointness(
  authority: EvaluationRunAuthorityV1,
  policy: EvaluationPolicyV1,
): void {
  assertEvaluationRunAuthorityV1(authority);
  assertEvaluationPolicyV1(policy);
  if (authority.implementerRunIds.includes(authority.evaluatorRunId)) {
    fail('evaluator run id must not appear in implementerRunIds');
  }
  if (
    policy.requiredRoleDisjointness.includes('verifier') &&
    authority.verifierRunIds.includes(authority.evaluatorRunId)
  ) {
    fail('evaluator run id must not appear in verifierRunIds under policy disjointness');
  }
  if (
    policy.requiredRoleDisjointness.includes('reviewer') &&
    authority.reviewerRunIds.includes(authority.evaluatorRunId)
  ) {
    fail('evaluator run id must not appear in reviewerRunIds under policy disjointness');
  }
  if (
    policy.requiredRoleDisjointness.includes('implementer') &&
    authority.implementerRunIds.includes(authority.evaluatorRunId)
  ) {
    fail('evaluator run id must not appear in implementerRunIds under policy disjointness');
  }
}

export function assertDeterministicGateDefinitionV1(
  definition: DeterministicGateDefinitionV1,
): void {
  assertExactRecord(definition, GATE_DEFINITION_KEYS, 'deterministic gate definition');
  if (
    !isBoundedIdentifier(definition.gateId) ||
    !isPositiveSafeInteger(definition.version) ||
    !(GATE_KINDS as readonly unknown[]).includes(definition.kind) ||
    !isBoundedIdentifier(definition.registryFunctionId) ||
    !isHash(definition.definitionHash)
  ) {
    fail(
      'deterministic gate definition identity, kind, registry function, and hash must be valid',
    );
  }
  assertSortedUniqueIdentifiers(
    definition.requiredEnvironmentFields,
    'gate definition requiredEnvironmentFields',
  );
  assertSortedUniqueIdentifiers(
    definition.requiredArtifactKinds,
    'gate definition requiredArtifactKinds',
  );
  const expected = hashCanonicalJson(omitHash(definition, 'definitionHash'));
  if (definition.definitionHash !== expected) {
    fail('deterministic gate definition hash does not match the exact record');
  }
}

export function assertDeterministicGatePlanV1(plan: DeterministicGatePlanV1): void {
  assertExactRecord(plan, GATE_PLAN_KEYS, 'deterministic gate plan');
  if (
    plan.schema !== 'hercules-deterministic-gate-plan/v1' ||
    !isBoundedIdentifier(plan.gatePlanId) ||
    !isPositiveSafeInteger(plan.version) ||
    plan.issuer !== 'hercules-program-control' ||
    !isBoundedNfcString(plan.authorityEpoch) ||
    !isHash(plan.taskContractHash) ||
    !isGitSha(plan.candidateCommit) ||
    !isHash(plan.gatePlanHash)
  ) {
    fail(
      'deterministic gate plan identity, issuer, bindings, and hash must be valid',
    );
  }
  assertDenseArray(plan.gates, 'deterministic gate plan gates');
  const gateIds = new Set<string>();
  for (const gate of plan.gates) {
    assertDeterministicGateDefinitionV1(gate);
    if (gateIds.has(gate.gateId)) {
      fail('deterministic gate plan gate ids must be unique');
    }
    gateIds.add(gate.gateId);
  }
  const expected = hashCanonicalJson(omitHash(plan, 'gatePlanHash'));
  if (plan.gatePlanHash !== expected) {
    fail('deterministic gate plan hash does not match the exact record');
  }
}

export function assertDeterministicGateReceiptShapeV1(
  receipt: DeterministicGateReceiptV1,
): void {
  assertExactRecord(receipt, GATE_RECEIPT_KEYS, 'deterministic gate receipt');
  if (
    receipt.schema !== 'hercules-deterministic-gate-receipt/v1' ||
    !isBoundedIdentifier(receipt.gatePlanId) ||
    !isHash(receipt.gatePlanHash) ||
    !isBoundedIdentifier(receipt.gateId) ||
    !isPositiveSafeInteger(receipt.gateVersion) ||
    !isHash(receipt.gateDefinitionHash) ||
    receipt.runnerIssuer !== 'hercules-program-control' ||
    !isBoundedIdentifier(receipt.runnerRunId) ||
    !isBoundedNfcString(receipt.authorityEpoch) ||
    !isBoundedIdentifier(receipt.taskId) ||
    !isHash(receipt.taskContractHash) ||
    !isBoundedIdentifier(receipt.iterationId) ||
    !isGitSha(receipt.candidateCommit) ||
    !isHash(receipt.commandOrSpecHash) ||
    !isCanonicalTimestamp(receipt.startedAt) ||
    !isCanonicalTimestamp(receipt.completedAt) ||
    !isCanonicalTimestamp(receipt.expiresAt) ||
    !(GATE_RECEIPT_STATUSES as readonly unknown[]).includes(receipt.status) ||
    !isHash(receipt.receiptHash)
  ) {
    fail(
      'deterministic gate receipt identity, bindings, timestamps, status, and hash must be valid',
    );
  }
  if (
    receipt.exitCode !== null &&
    (typeof receipt.exitCode !== 'number' ||
      !Number.isSafeInteger(receipt.exitCode) ||
      !Number.isFinite(receipt.exitCode))
  ) {
    fail('deterministic gate receipt exitCode must be null or a safe finite integer');
  }
  assertTimestampAfter(
    receipt.expiresAt,
    receipt.completedAt,
    'deterministic gate receipt expiresAt',
  );
  if (
    receipt.environmentIdentity === null ||
    typeof receipt.environmentIdentity !== 'object' ||
    Array.isArray(receipt.environmentIdentity)
  ) {
    fail('deterministic gate receipt environmentIdentity must be an object');
  }
  for (const key of Object.keys(receipt.environmentIdentity)) {
    const envValue = receipt.environmentIdentity[key];
    if (!isBoundedNfcString(envValue)) {
      fail('deterministic gate receipt environmentIdentity values must be bounded NFC strings');
    }
  }
  assertSortedUniqueIdentifiers(
    receipt.outputArtifactIds,
    'deterministic gate receipt outputArtifactIds',
  );
  assertDenseArray(
    receipt.outputArtifactHashes,
    'deterministic gate receipt outputArtifactHashes',
  );
  if (receipt.outputArtifactIds.length !== receipt.outputArtifactHashes.length) {
    fail(
      'deterministic gate receipt outputArtifactIds and outputArtifactHashes must be the same length',
    );
  }
  for (let index = 0; index < receipt.outputArtifactHashes.length; index += 1) {
    if (!isHash(receipt.outputArtifactHashes[index])) {
      fail('deterministic gate receipt outputArtifactHashes must use sha256 grammar');
    }
  }
  assertSortedUniqueIdentifiers(
    receipt.assertionIds,
    'deterministic gate receipt assertionIds',
  );
  assertSortedUniqueIdentifiers(
    receipt.verificationReceiptIds,
    'deterministic gate receipt verificationReceiptIds',
  );
  const expected = hashCanonicalJson(omitHash(receipt, 'receiptHash'));
  if (receipt.receiptHash !== expected) {
    fail('deterministic gate receipt hash does not match the exact record');
  }
}

export function assertDeterministicGateReceiptV1(
  receipt: DeterministicGateReceiptV1,
  definition: DeterministicGateDefinitionV1,
): void {
  assertDeterministicGateReceiptShapeV1(receipt);
  assertDeterministicGateDefinitionV1(definition);
  if (receipt.gateId !== definition.gateId || receipt.gateVersion !== definition.version) {
    fail('deterministic gate receipt must bind the exact gate definition identity');
  }
  if (receipt.gateDefinitionHash !== definition.definitionHash) {
    fail('deterministic gate receipt gateDefinitionHash must match the definition');
  }
  assertExactRecord(
    receipt.environmentIdentity,
    definition.requiredEnvironmentFields,
    'deterministic gate receipt environmentIdentity',
  );
  for (const key of definition.requiredEnvironmentFields) {
    const envValue = receipt.environmentIdentity[key];
    if (!isBoundedNfcString(envValue)) {
      fail('deterministic gate receipt environmentIdentity values must be bounded NFC strings');
    }
  }
}
export function assertCurrentGateReceiptQueryV1(
  query: CurrentGateReceiptQueryV1,
): void {
  assertExactRecord(query, GATE_RECEIPT_QUERY_KEYS, 'current gate receipt query');
  if (
    !isBoundedIdentifier(query.gatePlanId) ||
    !isHash(query.gatePlanHash) ||
    !isBoundedIdentifier(query.taskId) ||
    !isHash(query.taskContractHash) ||
    !isBoundedIdentifier(query.iterationId) ||
    !isGitSha(query.candidateCommit) ||
    !isBoundedNfcString(query.authorityEpoch)
  ) {
    fail('current gate receipt query fields must be valid bounded identities and hashes');
  }
}

export function assertTrustedDeterministicGateRunnerV1(
  runner: TrustedDeterministicGateRunnerV1,
): void {
  if (
    runner === null ||
    typeof runner !== 'object' ||
    Array.isArray(runner) ||
    typeof runner.resolveCurrentReceipts !== 'function'
  ) {
    fail(
      'trusted deterministic gate runner must expose resolveCurrentReceipts as a function',
    );
  }
}

export function assertTrustedEvaluationControlSnapshotV1(
  snapshot: TrustedEvaluationControlSnapshotV1,
): void {
  assertExactRecord(snapshot, CONTROL_SNAPSHOT_KEYS, 'trusted evaluation control snapshot');
  if (
    snapshot.schema !== 'hercules-trusted-evaluation-control/v1' ||
    snapshot.issuer !== 'hercules-program-control' ||
    !isBoundedNfcString(snapshot.authorityEpoch) ||
    !isCanonicalTimestamp(snapshot.observedAt) ||
    !isHash(snapshot.controlIdentityHash) ||
    !isHash(snapshot.controlObservationHash)
  ) {
    fail(
      'trusted evaluation control snapshot schema, issuer, epoch, timestamp, and hashes must be valid',
    );
  }
  assertEvaluationPolicyV1(snapshot.policy);
  assertEvaluationRubricV1(snapshot.rubric);
  assertDeterministicGatePlanV1(snapshot.gatePlan);
  assertEvaluationRunAuthorityV1(snapshot.roles);
  assertRunAuthorityDisjointness(snapshot.roles, snapshot.policy);
  const expectedIdentity = computeControlIdentityHash(snapshot);
  if (snapshot.controlIdentityHash !== expectedIdentity) {
    fail('control identity hash does not match the exact control snapshot identity');
  }
  const expectedObservation = computeControlObservationHash(
    snapshot.controlIdentityHash,
    snapshot.observedAt,
  );
  if (snapshot.controlObservationHash !== expectedObservation) {
    fail('control observation hash does not match the exact control snapshot observation');
  }
}

export function assertTrustedEvaluationEvidenceSnapshotV1(
  snapshot: TrustedEvaluationEvidenceSnapshotV1,
): void {
  assertExactRecord(
    snapshot,
    EVIDENCE_SNAPSHOT_KEYS,
    'trusted evaluation evidence snapshot',
  );
  if (
    snapshot.schema !== 'hercules-trusted-evaluation-evidence/v1' ||
    !isBoundedIdentifier(snapshot.sourceId) ||
    !isBoundedIdentifier(snapshot.iterationId) ||
    !isCanonicalTimestamp(snapshot.observedAt) ||
    !isCanonicalTimestamp(snapshot.freshUntil) ||
    !isHash(snapshot.evidenceIdentityHash) ||
    !isHash(snapshot.evidenceObservationHash)
  ) {
    fail(
      'trusted evaluation evidence snapshot identity, timestamps, and hashes must be valid',
    );
  }
  assertTimestampAfter(
    snapshot.freshUntil,
    snapshot.observedAt,
    'trusted evaluation evidence snapshot freshUntil',
  );
  try {
    assertTaskContract(snapshot.taskContract);
    assertTaskContractHash(snapshot.taskContract);
  } catch (error) {
    fail(`trusted evaluation evidence task contract is invalid: ${String(error)}`);
  }
  try {
    assertCandidateRef(snapshot.candidateRef);
  } catch (error) {
    fail(`trusted evaluation evidence candidate is invalid: ${String(error)}`);
  }
  try {
    assertEvidenceManifest(snapshot.evidenceManifest);
  } catch (error) {
    fail(`trusted evaluation evidence manifest is invalid: ${String(error)}`);
  }
  assertDenseArray(snapshot.artifacts, 'trusted evaluation evidence artifacts');
  const artifactIds = new Set<string>();
  for (const artifact of snapshot.artifacts) {
    try {
      assertArtifactRef(artifact);
    } catch (error) {
      fail(`trusted evaluation evidence artifact is invalid: ${String(error)}`);
    }
    if (artifactIds.has(artifact.id)) {
      fail('trusted evaluation evidence artifact ids must be unique');
    }
    artifactIds.add(artifact.id);
  }
  assertVerificationResultV1(snapshot.verificationResult);
  assertDenseArray(snapshot.assertions, 'trusted evaluation evidence assertions');
  const assertionIds = new Set<string>();
  for (const assertion of snapshot.assertions) {
    try {
      assertDecisionAssertion(assertion);
    } catch (error) {
      fail(`trusted evaluation evidence assertion is invalid: ${String(error)}`);
    }
    if (assertionIds.has(assertion.id)) {
      fail('trusted evaluation evidence assertion ids must be unique');
    }
    assertionIds.add(assertion.id);
  }
  assertDenseArray(
    snapshot.verificationReceipts,
    'trusted evaluation evidence verification receipts',
  );
  const receiptIds = new Set<string>();
  for (const receipt of snapshot.verificationReceipts) {
    try {
      assertAssertionVerificationReceipt(receipt);
    } catch (error) {
      fail(
        `trusted evaluation evidence verification receipt is invalid: ${String(error)}`,
      );
    }
    if (receiptIds.has(receipt.id)) {
      fail('trusted evaluation evidence verification receipt ids must be unique');
    }
    receiptIds.add(receipt.id);
  }
  try {
    assertEvidenceIntegrityAttestation(snapshot.integrityAttestation);
  } catch (error) {
    fail(
      `trusted evaluation evidence integrity attestation is invalid: ${String(error)}`,
    );
  }
  const expectedIdentity = computeEvidenceIdentityHash(snapshot);
  if (snapshot.evidenceIdentityHash !== expectedIdentity) {
    fail('evidence identity hash does not match the exact evidence snapshot identity');
  }
  const expectedObservation = computeEvidenceObservationHash(
    snapshot.evidenceIdentityHash,
    snapshot.observedAt,
    snapshot.freshUntil,
  );
  if (snapshot.evidenceObservationHash !== expectedObservation) {
    fail(
      'evidence observation hash does not match the exact evidence snapshot observation',
    );
  }
}

export function assertArtifactLocatorHintV1(hint: ArtifactLocatorHintV1): void {
  assertExactRecord(hint, LOCATOR_HINT_KEYS, 'artifact locator hint');
  if (
    hint.schema !== 'hercules-artifact-locator-hint/v1' ||
    !isBoundedIdentifier(hint.artifactRefId) ||
    !isBoundedIdentifier(hint.producerRunId) ||
    hint.trustClass !== 'agent_claim' ||
    !(LOCATOR_KINDS as readonly unknown[]).includes(hint.locatorKind) ||
    typeof hint.locator !== 'string' ||
    utf8Bytes(hint.locator) < 1 ||
    utf8Bytes(hint.locator) > MAX_LOCATOR_BYTES ||
    hint.locator.normalize('NFC') !== hint.locator ||
    !isHash(hint.locatorHash)
  ) {
    fail(
      'artifact locator hint must use agent_claim trust, a closed locator kind, and a bounded NFC locator',
    );
  }
  const expected = hashCanonicalJson(omitHash(hint, 'locatorHash'));
  if (hint.locatorHash !== expected) {
    fail('artifact locator hint hash does not match the exact record');
  }
}

export function assertIndependentEvaluationInputV1(
  input: IndependentEvaluationInputV1,
  policy: EvaluationPolicyV1,
): void {
  assertExactRecord(input, INPUT_KEYS, 'independent evaluation input');
  assertEvaluationPolicyV1(policy);
  if (
    input.schema !== 'hercules-independent-evaluation-input/v1' ||
    !isBoundedIdentifier(input.requestId) ||
    !isBoundedIdentifier(input.iterationId) ||
    !isHash(input.inputHash)
  ) {
    fail('independent evaluation input identity and hash must be valid');
  }
  try {
    assertTaskContract(input.taskContract);
    assertTaskContractHash(input.taskContract);
  } catch (error) {
    fail(`independent evaluation input task contract is invalid: ${String(error)}`);
  }
  try {
    assertCandidateRef(input.candidateRef);
  } catch (error) {
    fail(`independent evaluation input candidate is invalid: ${String(error)}`);
  }
  try {
    assertEvidenceManifest(input.evidenceManifest);
  } catch (error) {
    fail(`independent evaluation input manifest is invalid: ${String(error)}`);
  }
  assertDenseArray(input.artifacts, 'independent evaluation input artifacts');
  if (input.artifacts.length > policy.maxArtifacts) {
    fail('independent evaluation input exceeds policy maxArtifacts');
  }
  const artifactIds = new Set<string>();
  for (const artifact of input.artifacts) {
    try {
      assertArtifactRef(artifact);
    } catch (error) {
      fail(`independent evaluation input artifact is invalid: ${String(error)}`);
    }
    if (artifactIds.has(artifact.id)) {
      fail('independent evaluation input artifact ids must be unique');
    }
    artifactIds.add(artifact.id);
  }
  assertVerificationResultV1(input.verificationResult);
  assertDenseArray(input.assertions, 'independent evaluation input assertions');
  if (input.assertions.length > policy.maxAssertions) {
    fail('independent evaluation input exceeds policy maxAssertions');
  }
  const assertionIds = new Set<string>();
  for (const assertion of input.assertions) {
    try {
      assertDecisionAssertion(assertion);
    } catch (error) {
      fail(`independent evaluation input assertion is invalid: ${String(error)}`);
    }
    if (assertionIds.has(assertion.id)) {
      fail('independent evaluation input assertion ids must be unique');
    }
    assertionIds.add(assertion.id);
  }
  assertDenseArray(
    input.verificationReceipts,
    'independent evaluation input verification receipts',
  );
  const receiptIds = new Set<string>();
  for (const receipt of input.verificationReceipts) {
    try {
      assertAssertionVerificationReceipt(receipt);
    } catch (error) {
      fail(
        `independent evaluation input verification receipt is invalid: ${String(error)}`,
      );
    }
    if (receiptIds.has(receipt.id)) {
      fail('independent evaluation input verification receipt ids must be unique');
    }
    receiptIds.add(receipt.id);
  }
  try {
    assertEvidenceIntegrityAttestation(input.integrityAttestation);
  } catch (error) {
    fail(
      `independent evaluation input integrity attestation is invalid: ${String(error)}`,
    );
  }
  assertEvaluationPolicyRefV1(input.policyRef);
  assertEvaluationRubricRefV1(input.rubricRef);
  assertDeterministicGatePlanRefV1(input.gatePlanRef);
  assertDenseArray(input.locatorHints, 'independent evaluation input locator hints');
  for (const hint of input.locatorHints) {
    assertArtifactLocatorHintV1(hint);
  }
  const serializedBytes = utf8Bytes(canonicalSerialize(input));
  if (serializedBytes > policy.maxInputBytes) {
    fail('independent evaluation input exceeds policy maxInputBytes');
  }
  const expected = hashCanonicalJson(omitHash(input, 'inputHash'));
  if (input.inputHash !== expected) {
    fail('independent evaluation input hash does not match the exact record');
  }
}

function assertEvaluatorCriterionProposalV1(
  proposal: EvaluatorCriterionProposalV1,
  policy: EvaluationPolicyV1,
): void {
  assertExactRecord(proposal, CRITERION_PROPOSAL_KEYS, 'evaluator criterion proposal');
  if (
    !isBoundedIdentifier(proposal.criterionId) ||
    !(PROPOSED_STATUSES as readonly unknown[]).includes(proposal.proposedStatus)
  ) {
    fail('evaluator criterion proposal identity and status must be valid');
  }
  assertSortedUniqueIdentifiers(
    proposal.premiseAssertionIds,
    'evaluator criterion proposal premiseAssertionIds',
  );
  if (proposal.premiseAssertionIds.length > policy.maxPremisesPerCriterion) {
    fail('evaluator criterion proposal exceeds policy maxPremisesPerCriterion');
  }
  assertAdvisoryRationale(
    proposal.advisoryRationale,
    policy.maxRationaleBytes,
    'evaluator criterion proposal advisoryRationale',
  );
}

function assertEvaluatorFindingProposalV1(
  finding: EvaluatorFindingProposalV1,
  policy: EvaluationPolicyV1,
  rubricCriterionIds: ReadonlySet<string>,
): void {
  assertExactRecord(finding, FINDING_PROPOSAL_KEYS, 'evaluator finding proposal');
  if (
    !isBoundedIdentifier(finding.findingCode) ||
    !(FINDING_SEVERITIES as readonly unknown[]).includes(finding.severity)
  ) {
    fail('evaluator finding proposal code and severity must be valid');
  }
  assertSortedUniqueIdentifiers(
    finding.criterionIds,
    'evaluator finding proposal criterionIds',
  );
  for (const criterionId of finding.criterionIds) {
    if (!rubricCriterionIds.has(criterionId)) {
      fail('evaluator finding proposal criterionIds must reference rubric criteria');
    }
  }
  assertSortedUniqueIdentifiers(
    finding.assertionIds,
    'evaluator finding proposal assertionIds',
  );
  assertAdvisoryRationale(
    finding.advisoryRationale,
    policy.maxRationaleBytes,
    'evaluator finding proposal advisoryRationale',
  );
}

export function assertEvaluatorProposalV1(
  proposal: EvaluatorProposalV1,
  policy: EvaluationPolicyV1,
  rubric: EvaluationRubricV1,
): void {
  assertExactRecord(proposal, PROPOSAL_KEYS, 'evaluator proposal');
  assertEvaluationPolicyV1(policy);
  assertEvaluationRubricV1(rubric);
  if (
    proposal.schema !== 'hercules-evaluator-proposal/v1' ||
    !isBoundedIdentifier(proposal.requestId) ||
    !isHash(proposal.inputHash) ||
    !isBoundedIdentifier(proposal.evaluatorRunId) ||
    !isBoundedIdentifier(proposal.evaluatorImplementationId) ||
    !isBoundedIdentifier(proposal.proposalId) ||
    !isHash(proposal.proposalHash)
  ) {
    fail('evaluator proposal identity and hash must be valid');
  }
  assertDenseArray(proposal.criterionProposals, 'evaluator proposal criterionProposals');
  if (proposal.criterionProposals.length !== rubric.criteria.length) {
    fail('evaluator proposal must contain exactly one criterion proposal per rubric criterion');
  }
  const rubricCriterionIds = new Set<string>();
  for (let index = 0; index < rubric.criteria.length; index += 1) {
    const expectedCriterionId = rubric.criteria[index]!.criterionId;
    const criterionProposal = proposal.criterionProposals[index]!;
    assertEvaluatorCriterionProposalV1(criterionProposal, policy);
    if (criterionProposal.criterionId !== expectedCriterionId) {
      fail(
        'evaluator proposal criterionProposals must match rubric criteria in exact order',
      );
    }
    if (rubricCriterionIds.has(criterionProposal.criterionId)) {
      fail('evaluator proposal criterion ids must be unique');
    }
    rubricCriterionIds.add(criterionProposal.criterionId);
  }
  assertDenseArray(proposal.findings, 'evaluator proposal findings');
  for (const finding of proposal.findings) {
    assertEvaluatorFindingProposalV1(finding, policy, rubricCriterionIds);
  }
  assertBoundedStringList(
    proposal.declaredUnknowns,
    'evaluator proposal declaredUnknowns',
    MAX_DECLARED_STRINGS,
  );
  assertBoundedStringList(
    proposal.remainingRisks,
    'evaluator proposal remainingRisks',
    MAX_DECLARED_STRINGS,
  );
  const expected = hashCanonicalJson(omitHash(proposal, 'proposalHash'));
  if (proposal.proposalHash !== expected) {
    fail('evaluator proposal hash does not match the exact record');
  }
}

export function assertEvaluatorAuthoritySnapshotV1(
  authority: TrustedEvaluatorAuthoritySnapshotV1,
): void {
  assertExactRecord(authority, EVALUATOR_AUTHORITY_KEYS, 'trusted evaluator authority');
  if (
    authority.schema !== 'hercules-trusted-evaluator-authority/v1' ||
    authority.issuer !== 'hercules-program-control' ||
    !isBoundedNfcString(authority.authorityEpoch) ||
    !isBoundedIdentifier(authority.evaluatorRunId) ||
    !isBoundedIdentifier(authority.evaluatorImplementationId) ||
    !isBoundedIdentifier(authority.evaluatorCapabilityId) ||
    !isBoundedIdentifier(authority.freshContextId) ||
    !isCanonicalTimestamp(authority.issuedAt) ||
    !isCanonicalTimestamp(authority.expiresAt) ||
    !isHash(authority.authorityHash)
  ) {
    fail(
      'trusted evaluator authority must use exact literals, bounded identities, timestamps, and hash',
    );
  }
  assertTimestampAfter(
    authority.expiresAt,
    authority.issuedAt,
    'trusted evaluator authority expiresAt',
  );
  const expected = hashCanonicalJson(omitHash(authority, 'authorityHash'));
  if (authority.authorityHash !== expected) {
    fail('trusted evaluator authority hash does not match the exact record');
  }
}

export function assertRuntimeCapabilityIdentityV1(
  identity: TrustedEvaluationRuntimeCapabilityIdentityV1,
): void {
  assertExactRecord(
    identity,
    RUNTIME_CAPABILITY_KEYS,
    'trusted evaluation runtime capability identity',
  );
  if (
    identity.schema !== 'hercules-trusted-evaluation-runtime-capabilities/v1' ||
    !isBoundedIdentifier(identity.evaluatorCapabilityId) ||
    !isBoundedIdentifier(identity.gateResolverCapabilityId) ||
    !isBoundedIdentifier(identity.deadlineCapabilityId) ||
    !isBoundedIdentifier(identity.cancellationFactoryCapabilityId) ||
    !isBoundedIdentifier(identity.clockCapabilityId) ||
    !isBoundedIdentifier(identity.clockEpochId) ||
    !isHash(identity.capabilitySetHash)
  ) {
    fail(
      'trusted evaluation runtime capability identity must use bounded identities and hash',
    );
  }
  const expected = hashCanonicalJson(omitHash(identity, 'capabilitySetHash'));
  if (identity.capabilitySetHash !== expected) {
    fail('runtime capability set hash does not match the exact record');
  }
}

export function assertStableContextIdentityV1(
  identity: TrustedEvaluationStableContextIdentityV1,
): void {
  assertExactRecord(identity, STABLE_CONTEXT_KEYS, 'trusted evaluation stable context');
  if (
    identity.schema !== 'hercules-trusted-evaluation-stable-context/v1' ||
    !isHash(identity.inputHash) ||
    !isHash(identity.controlIdentityHash) ||
    !isHash(identity.evidenceIdentityHash) ||
    !isHash(identity.gateReceiptSetHash) ||
    !isHash(identity.roleAuthorityHash) ||
    !isHash(identity.evaluatorAuthorityHash) ||
    !isHash(identity.runtimeCapabilitySetHash) ||
    !isBoundedNfcString(identity.authorityEpoch) ||
    !isBoundedIdentifier(identity.clockCapabilityId) ||
    !isBoundedIdentifier(identity.clockEpochId) ||
    !isCanonicalTimestamp(identity.freshUntil) ||
    !isHash(identity.stableContextHash)
  ) {
    fail(
      'trusted evaluation stable context must use valid hashes, epoch, clock identity, and freshUntil',
    );
  }
  const expected = hashCanonicalJson(omitHash(identity, 'stableContextHash'));
  if (identity.stableContextHash !== expected) {
    fail('stable context hash does not match the exact record');
  }
}

export function assertCurrentEvaluationContextV1(
  context: TrustedCurrentEvaluationContextV1,
): void {
  assertExactRecord(context, CURRENT_CONTEXT_KEYS, 'trusted current evaluation context');
  if (
    context.schema !== 'hercules-trusted-current-evaluation-context/v1' ||
    !isHash(context.inputHash) ||
    !isHash(context.gateReceiptSetHash) ||
    !isCanonicalTimestamp(context.observedAt) ||
    context.freshness !== 'fresh' ||
    !isHash(context.contextHash)
  ) {
    fail(
      'trusted current evaluation context schema, hashes, observedAt, and freshness must be valid',
    );
  }
  assertTrustedEvaluationControlSnapshotV1(context.control);
  assertTrustedEvaluationEvidenceSnapshotV1(context.evidence);
  assertDenseArray(context.gateReceipts, 'trusted current evaluation context gateReceipts');
  for (const receipt of context.gateReceipts) {
    assertDeterministicGateReceiptShapeV1(receipt);
  }
  const expectedGateSetHash = computeGateReceiptSetHash(context.gateReceipts);
  if (context.gateReceiptSetHash !== expectedGateSetHash) {
    fail('current evaluation context gateReceiptSetHash must match the gate receipts');
  }
  assertEvaluatorAuthoritySnapshotV1(context.evaluatorAuthority);
  assertRuntimeCapabilityIdentityV1(context.runtimeCapabilities);
  assertStableContextIdentityV1(context.stableIdentity);
  const stable = context.stableIdentity;
  if (
    context.inputHash !== stable.inputHash ||
    context.control.controlIdentityHash !== stable.controlIdentityHash ||
    context.evidence.evidenceIdentityHash !== stable.evidenceIdentityHash ||
    context.gateReceiptSetHash !== stable.gateReceiptSetHash ||
    context.control.roles.authorityHash !== stable.roleAuthorityHash ||
    context.evaluatorAuthority.authorityHash !== stable.evaluatorAuthorityHash ||
    context.runtimeCapabilities.capabilitySetHash !== stable.runtimeCapabilitySetHash ||
    context.control.authorityEpoch !== stable.authorityEpoch ||
    context.runtimeCapabilities.clockCapabilityId !== stable.clockCapabilityId ||
    context.runtimeCapabilities.clockEpochId !== stable.clockEpochId
  ) {
    fail(
      'current evaluation context stableIdentity fields must match nested control, evidence, and capability identities',
    );
  }
  if (context.evaluatorAuthority.evaluatorRunId !== context.control.roles.evaluatorRunId) {
    fail(
      'evaluator authority evaluatorRunId must equal control.roles.evaluatorRunId',
    );
  }
  assertTimestampNotAfter(
    context.observedAt,
    stable.freshUntil,
    'trusted current evaluation context observedAt',
  );
  const expected = hashCanonicalJson(omitHash(context, 'contextHash'));
  if (context.contextHash !== expected) {
    fail('current evaluation context hash does not match the exact record');
  }
}

export function assertEvaluationGapV1(gap: EvaluationGapV1): void {
  assertExactRecord(gap, GAP_KEYS, 'evaluation gap');
  if (
    gap.schema !== 'hercules-independent-evaluation-gap/v1' ||
    !isBoundedIdentifier(gap.requestId) ||
    !isHash(gap.inputHash) ||
    !isHash(gap.acceptedContextHash) ||
    !isHash(gap.acceptedStableContextHash) ||
    !(GAP_REASONS as readonly unknown[]).includes(gap.reason) ||
    gap.proposalDiscarded !== true ||
    gap.outcome !== 'need_more_evidence' ||
    !isCanonicalTimestamp(gap.observedAt) ||
    !isHash(gap.gapHash)
  ) {
    fail(
      'evaluation gap must use exact literals, bounded identities, timestamps, and hash',
    );
  }
  const observedContextOk =
    gap.observedContextHash === null || isHash(gap.observedContextHash);
  const observedStableOk =
    gap.observedStableContextHash === null || isHash(gap.observedStableContextHash);
  if (!observedContextOk || !observedStableOk) {
    fail('evaluation gap observed hashes must be null or sha256 digests');
  }
  const bothNull =
    gap.observedContextHash === null && gap.observedStableContextHash === null;
  const bothPresent =
    gap.observedContextHash !== null && gap.observedStableContextHash !== null;
  if (!bothNull && !bothPresent) {
    fail('evaluation gap observed hashes must be both null or both non-null');
  }
  const expected = hashCanonicalJson(omitHash(gap, 'gapHash'));
  if (gap.gapHash !== expected) {
    fail('evaluation gap hash does not match the exact record');
  }
}

export function assertEvaluationCancellationDispatchV1(
  dispatch: EvaluationCancellationDispatchV1,
): void {
  assertExactRecord(dispatch, CANCELLATION_DISPATCH_KEYS, 'evaluation cancellation dispatch');
  if (
    !isBoundedIdentifier(dispatch.signalId) ||
    !isBoundedIdentifier(dispatch.attemptId) ||
    !(CANCELLATION_REASONS as readonly unknown[]).includes(dispatch.reason) ||
    !(CANCELLATION_STATUSES as readonly unknown[]).includes(dispatch.status) ||
    !isCanonicalTimestamp(dispatch.dispatchedAt) ||
    !isHash(dispatch.dispatchHash)
  ) {
    fail(
      'evaluation cancellation dispatch identity, reason, status, timestamp, and hash must be valid',
    );
  }
  const expected = hashCanonicalJson(omitHash(dispatch, 'dispatchHash'));
  if (dispatch.dispatchHash !== expected) {
    fail('evaluation cancellation dispatch hash does not match the exact record');
  }
}

function assertEvaluationVerdictStructureV1(verdict: EvaluationVerdict): void {
  assertExactRecord(verdict, VERDICT_KEYS, 'evaluation verdict');
  if (
    !isBoundedIdentifier(verdict.id) ||
    !(EVALUATION_OUTCOMES as readonly unknown[]).includes(verdict.outcome) ||
    !(RECOMMENDED_NEXT_STAGES as readonly unknown[]).includes(
      verdict.recommendedNextStage,
    ) ||
    (verdict.evaluatorAgentRunId !== null &&
      !isBoundedIdentifier(verdict.evaluatorAgentRunId)) ||
    !isCanonicalTimestamp(verdict.createdAt)
  ) {
    fail(
      'evaluation verdict identity, outcome, next stage, evaluator run, and createdAt must be valid',
    );
  }
  if (
    verdict.binding === null ||
    typeof verdict.binding !== 'object' ||
    Array.isArray(verdict.binding)
  ) {
    fail('evaluation verdict binding must be an object');
  }
  assertDenseArray(verdict.criterionResults, 'evaluation verdict criterionResults');
  const criterionIds = new Set<string>();
  for (const result of verdict.criterionResults) {
    if (
      result === null ||
      typeof result !== 'object' ||
      !isBoundedIdentifier(result.criterionId) ||
      !(CRITERION_RESULT_STATUSES as readonly unknown[]).includes(result.status) ||
      !(CRITERION_AUTHORITIES as readonly unknown[]).includes(result.authority) ||
      !Array.isArray(result.evidenceRefs) ||
      (result.observedAt !== null && !isCanonicalTimestamp(result.observedAt)) ||
      typeof result.candidateBinding !== 'string' ||
      typeof result.explanation !== 'string'
    ) {
      fail('evaluation verdict criterion results must carry valid fields');
    }
    assertSortedUniqueIdentifiers(
      result.evidenceRefs,
      'evaluation verdict criterion evidenceRefs',
    );
    if (criterionIds.has(result.criterionId)) {
      fail('evaluation verdict criterion ids must be unique');
    }
    criterionIds.add(result.criterionId);
  }
  assertDenseArray(verdict.blockingFindings, 'evaluation verdict blockingFindings');
  assertDenseArray(verdict.nonBlockingRisks, 'evaluation verdict nonBlockingRisks');
  const findingCodes = new Set<string>();
  for (const finding of [...verdict.blockingFindings, ...verdict.nonBlockingRisks]) {
    if (
      finding === null ||
      typeof finding !== 'object' ||
      !isBoundedIdentifier(finding.code) ||
      typeof finding.summary !== 'string' ||
      !Array.isArray(finding.criterionIds)
    ) {
      fail('evaluation verdict findings must carry valid codes and criterion ids');
    }
    assertSortedUniqueIdentifiers(
      finding.criterionIds,
      'evaluation verdict finding criterionIds',
    );
    if (findingCodes.has(finding.code)) {
      fail('evaluation verdict finding codes must be unique');
    }
    findingCodes.add(finding.code);
  }
}

export function assertEvaluationCriterionRelationshipV1(
  relationship: EvaluationCriterionRelationshipV1,
): void {
  assertExactRecord(
    relationship,
    CRITERION_RELATIONSHIP_KEYS,
    'evaluation criterion relationship',
  );
  if (!isBoundedIdentifier(relationship.criterionId) || !isHash(relationship.relationshipHash)) {
    fail('evaluation criterion relationship identity and hash must be valid');
  }
  assertSortedUniqueIdentifiers(
    relationship.assertionIds,
    'evaluation criterion relationship assertionIds',
  );
  assertSortedUniqueIdentifiers(
    relationship.evidenceArtifactIds,
    'evaluation criterion relationship evidenceArtifactIds',
  );
  assertSortedUniqueIdentifiers(
    relationship.verificationReceiptIds,
    'evaluation criterion relationship verificationReceiptIds',
  );
  const expected = hashCanonicalJson(omitHash(relationship, 'relationshipHash'));
  if (relationship.relationshipHash !== expected) {
    fail('evaluation criterion relationship hash does not match the exact record');
  }
}

export function assertIndependentEvaluationReceiptV1(
  receipt: IndependentEvaluationReceiptV1,
): void {
  assertExactRecord(receipt, RECEIPT_KEYS, 'independent evaluation receipt');
  if (
    receipt.schema !== 'hercules-independent-evaluation-receipt/v1' ||
    !isBoundedIdentifier(receipt.receiptId) ||
    !isBoundedIdentifier(receipt.requestId) ||
    !isHash(receipt.inputHash) ||
    !isBoundedIdentifier(receipt.taskId) ||
    !isHash(receipt.taskContractHash) ||
    !isBoundedIdentifier(receipt.iterationId) ||
    !isGitSha(receipt.candidateCommit) ||
    !isBoundedIdentifier(receipt.manifestId) ||
    !isHash(receipt.manifestHash) ||
    !isHash(receipt.artifactInventoryHash) ||
    !isHash(receipt.verificationResultHash) ||
    !isHash(receipt.verificationReceiptSetHash) ||
    !isHash(receipt.integrityAttestationHash) ||
    !isHash(receipt.assertionSetHash) ||
    !isHash(receipt.gatePlanHash) ||
    !isHash(receipt.gateReceiptSetHash) ||
    !isHash(receipt.policyHash) ||
    !isHash(receipt.rubricHash) ||
    !isHash(receipt.roleAuthorityHash) ||
    !isHash(receipt.controlIdentityHash) ||
    !isBoundedIdentifier(receipt.evidenceSourceId) ||
    !isHash(receipt.evidenceIdentityHash) ||
    !isBoundedNfcString(receipt.authorityEpoch) ||
    !isBoundedIdentifier(receipt.coordinatorRunId) ||
    !isBoundedIdentifier(receipt.evaluatorRunId) ||
    !isBoundedIdentifier(receipt.evaluatorImplementationId) ||
    !isHash(receipt.acceptedContextHash) ||
    !isHash(receipt.postEvaluationContextHash) ||
    !isHash(receipt.stableContextHash) ||
    !isCanonicalTimestamp(receipt.acceptedObservedAt) ||
    !isCanonicalTimestamp(receipt.postEvaluationObservedAt) ||
    !isCanonicalTimestamp(receipt.freshUntil) ||
    !isHash(receipt.preflightHash) ||
    !isHash(receipt.verdictHash) ||
    !isCanonicalTimestamp(receipt.createdAt) ||
    !isHash(receipt.receiptHash)
  ) {
    fail(
      'independent evaluation receipt identity, bindings, timestamps, and hashes must be valid',
    );
  }
  const proposalPresent = receipt.proposalHash !== null;
  const noProposalPresent = receipt.noProposalReason !== null;
  if (proposalPresent === noProposalPresent) {
    fail(
      'independent evaluation receipt must set exactly one of proposalHash or noProposalReason',
    );
  }
  if (proposalPresent && !isHash(receipt.proposalHash)) {
    fail('independent evaluation receipt proposalHash must use sha256 grammar');
  }
  if (
    noProposalPresent &&
    !(NO_PROPOSAL_REASONS as readonly unknown[]).includes(receipt.noProposalReason)
  ) {
    fail('independent evaluation receipt noProposalReason must use a closed literal');
  }
  assertDenseArray(
    receipt.cancellationDispatches,
    'independent evaluation receipt cancellationDispatches',
  );
  for (const dispatch of receipt.cancellationDispatches) {
    assertEvaluationCancellationDispatchV1(dispatch);
  }
  assertEvaluationVerdictStructureV1(receipt.verdict);
  // A dispatch_failed cancellation record is an infrastructure gap and can
  // never accompany a pass verdict (contract: "A dispatch_failed record is an
  // infrastructure gap and can never accompany pass").
  if (
    receipt.verdict.outcome === 'pass' &&
    receipt.cancellationDispatches.some(
      (dispatch) => dispatch.status === 'dispatch_failed',
    )
  ) {
    fail(
      'independent evaluation receipt cannot brand a pass verdict alongside a dispatch_failed cancellation record',
    );
  }
  const expectedVerdictHash = computeVerdictHash(receipt.verdict);
  if (receipt.verdictHash !== expectedVerdictHash) {
    fail('independent evaluation receipt verdictHash does not match the verdict');
  }
  assertDenseArray(
    receipt.criterionRelationships,
    'independent evaluation receipt criterionRelationships',
  );
  const criterionIds = new Set<string>();
  for (const relationship of receipt.criterionRelationships) {
    assertEvaluationCriterionRelationshipV1(relationship);
    if (criterionIds.has(relationship.criterionId)) {
      fail('independent evaluation receipt criterion relationships must be unique per criterionId');
    }
    criterionIds.add(relationship.criterionId);
  }
  assertSortedUniqueIdentifiers(
    receipt.outcomeReasonCodes,
    'independent evaluation receipt outcomeReasonCodes',
  );
  assertTimestampNotAfter(
    receipt.acceptedObservedAt,
    receipt.postEvaluationObservedAt,
    'independent evaluation receipt acceptedObservedAt',
  );
  assertTimestampNotAfter(
    receipt.postEvaluationObservedAt,
    receipt.freshUntil,
    'independent evaluation receipt postEvaluationObservedAt',
  );
  const expected = hashCanonicalJson(omitHash(receipt, 'receiptHash'));
  if (receipt.receiptHash !== expected) {
    fail('independent evaluation receipt hash does not match the exact record');
  }
}

export function assertDeterministicPreflightCheckV1(
  check: DeterministicPreflightCheckV1,
): void {
  assertExactRecord(check, PREFLIGHT_CHECK_KEYS, 'deterministic preflight check');
  if (
    !(PREFLIGHT_CHECK_IDS as readonly unknown[]).includes(check.checkId) ||
    !(PREFLIGHT_CHECK_STATUSES as readonly unknown[]).includes(check.status) ||
    !(PREFLIGHT_CHECK_CODES as readonly unknown[]).includes(check.code) ||
    typeof check.advisoryDetail !== 'string' ||
    utf8Bytes(check.advisoryDetail) > MAX_RATIONALE_BYTES ||
    !isHash(check.checkHash)
  ) {
    fail(
      'deterministic preflight check identity, status, code, advisory detail, and hash must be valid',
    );
  }
  assertSortedUniqueIdentifiers(
    check.criterionIds,
    'deterministic preflight check criterionIds',
  );
  assertSortedUniqueIdentifiers(
    check.assertionIds,
    'deterministic preflight check assertionIds',
  );
  assertSortedUniqueIdentifiers(
    check.evidenceIds,
    'deterministic preflight check evidenceIds',
  );
  const expected = hashCanonicalJson(omitHash(check, 'checkHash'));
  if (check.checkHash !== expected) {
    fail('deterministic preflight check hash does not match the exact record');
  }
}

export function assertDeterministicPreflightResultV1(
  result: DeterministicPreflightResultV1,
): void {
  assertExactRecord(result, PREFLIGHT_RESULT_KEYS, 'deterministic preflight result');
  if (
    result.schema !== 'hercules-deterministic-preflight/v1' ||
    !isHash(result.inputHash) ||
    !isHash(result.controlIdentityHash) ||
    !isHash(result.evidenceIdentityHash) ||
    !isHash(result.gateReceiptSetHash) ||
    !(PREFLIGHT_CHECK_STATUSES as readonly unknown[]).includes(result.classification) ||
    !isHash(result.preflightHash)
  ) {
    fail(
      'deterministic preflight result schema, hashes, and classification must be valid',
    );
  }
  assertDenseArray(result.checks, 'deterministic preflight result checks');
  if (result.checks.length < 1 || result.checks.length > PREFLIGHT_CHECK_IDS.length) {
    fail('deterministic preflight result checks must be a non-empty prefix of PREFLIGHT_CHECK_IDS');
  }
  const seenCheckIds = new Set<string>();
  for (let index = 0; index < result.checks.length; index += 1) {
    const check = result.checks[index];
    if (check === undefined) {
      fail('deterministic preflight result checks must not be sparse');
    }
    assertDeterministicPreflightCheckV1(check);
    if (check.checkId !== PREFLIGHT_CHECK_IDS[index]) {
      fail(
        'deterministic preflight result checks must follow PREFLIGHT_CHECK_IDS order as a prefix',
      );
    }
    if (seenCheckIds.has(check.checkId)) {
      fail('deterministic preflight result checks must not contain duplicate check ids');
    }
    seenCheckIds.add(check.checkId);
    const isLast = index === result.checks.length - 1;
    if (!isLast && check.status !== 'pass') {
      fail('deterministic preflight result non-final checks must have status pass');
    }
  }
  const lastCheck = result.checks[result.checks.length - 1];
  if (lastCheck === undefined || result.classification !== lastCheck.status) {
    fail('deterministic preflight result classification must equal the last check status');
  }
  assertSortedUniqueIdentifiers(
    result.eligibleAssertionIds,
    'deterministic preflight result eligibleAssertionIds',
  );
  const expected = hashCanonicalJson(omitHash(result, 'preflightHash'));
  if (result.preflightHash !== expected) {
    fail('deterministic preflight result hash does not match the exact record');
  }
}

export function assertSanitizedAssertionViewV1(
  view: SanitizedAssertionViewV1,
): void {
  assertExactRecord(view, SANITIZED_ASSERTION_VIEW_KEYS, 'sanitized assertion view');
  if (
    !isBoundedIdentifier(view.assertionId) ||
    !isBoundedNfcString(view.subjectKey) ||
    !(SANITIZED_ASSERTION_CLASSIFICATIONS as readonly unknown[]).includes(
      view.classification,
    ) ||
    !isHash(view.payloadHash)
  ) {
    fail(
      'sanitized assertion view identity, classification, and payload hash must be valid',
    );
  }
  let expectedPayloadHash: string;
  try {
    expectedPayloadHash = computeAssertionPayloadHash(view.canonicalPayload);
  } catch (error) {
    fail(
      `sanitized assertion view canonicalPayload must be hashable: ${String(error)}`,
    );
  }
  if (view.payloadHash !== expectedPayloadHash) {
    fail('sanitized assertion view payloadHash does not match canonicalPayload');
  }
}

export function assertSanitizedCriterionViewV1(
  view: SanitizedCriterionViewV1,
): void {
  assertExactRecord(view, SANITIZED_CRITERION_VIEW_KEYS, 'sanitized criterion view');
  if (
    !isBoundedIdentifier(view.criterionId) ||
    typeof view.required !== 'boolean' ||
    !(CRITERION_AUTHORITIES as readonly unknown[]).includes(view.authority) ||
    !isBoundedIdentifier(view.evaluatorInstructionArtifactId) ||
    !isHash(view.evaluatorInstructionArtifactHash)
  ) {
    fail(
      'sanitized criterion view identity, authority, and instruction artifact must be valid',
    );
  }
  assertSortedUniqueLiteralSet(
    view.allowedAdvisoryClasses,
    ADVISORY_CLASSES,
    'sanitized criterion view allowedAdvisoryClasses',
  );
}

export function assertSanitizedEvaluationRequestV1(
  request: SanitizedEvaluationRequestV1,
  rubric: EvaluationRubricV1,
): void {
  assertExactRecord(
    request,
    SANITIZED_EVALUATION_REQUEST_KEYS,
    'sanitized evaluation request',
  );
  assertEvaluationRubricV1(rubric);
  if (
    request.schema !== 'hercules-sanitized-evaluation-request/v1' ||
    !isBoundedIdentifier(request.requestId) ||
    !isHash(request.inputHash) ||
    !isBoundedIdentifier(request.taskContractId) ||
    !isPositiveSafeInteger(request.taskContractVersion) ||
    !isHash(request.taskContractHash) ||
    !isPositiveSafeInteger(request.policyVersion) ||
    !isHash(request.policyHash) ||
    !isBoundedIdentifier(request.rubricId) ||
    !isPositiveSafeInteger(request.rubricVersion) ||
    !isHash(request.rubricHash) ||
    !isHash(request.requestHash)
  ) {
    fail(
      'sanitized evaluation request schema, identities, versions, and hashes must be valid',
    );
  }
  if (
    request.rubricId !== rubric.rubricId ||
    request.rubricVersion !== rubric.version ||
    request.rubricHash !== rubric.rubricHash ||
    request.taskContractId !== rubric.taskContractId ||
    request.taskContractVersion !== rubric.taskContractVersion ||
    request.taskContractHash !== rubric.taskContractHash
  ) {
    fail(
      'sanitized evaluation request must mirror the given rubric identity and contract binding',
    );
  }
  assertDenseArray(request.criteria, 'sanitized evaluation request criteria');
  if (request.criteria.length !== rubric.criteria.length) {
    fail(
      'sanitized evaluation request criteria must exactly mirror the rubric criteria',
    );
  }
  for (let index = 0; index < rubric.criteria.length; index += 1) {
    const expected = rubric.criteria[index]!;
    const actual = request.criteria[index]!;
    assertSanitizedCriterionViewV1(actual);
    if (
      actual.criterionId !== expected.criterionId ||
      actual.required !== expected.required ||
      actual.authority !== expected.authority ||
      actual.evaluatorInstructionArtifactId !==
        expected.evaluatorInstructionArtifactId ||
      actual.evaluatorInstructionArtifactHash !==
        expected.evaluatorInstructionArtifactHash
    ) {
      fail(
        'sanitized evaluation request criteria must equal rubric criterion fields in order',
      );
    }
    if (
      actual.allowedAdvisoryClasses.length !==
        expected.allowedAdvisoryClasses.length ||
      actual.allowedAdvisoryClasses.some(
        (value, advisoryIndex) =>
          value !== expected.allowedAdvisoryClasses[advisoryIndex],
      )
    ) {
      fail(
        'sanitized evaluation request criteria allowedAdvisoryClasses must equal the rubric',
      );
    }
  }
  assertDeterministicPreflightResultV1(request.preflight);
  if (request.preflight.classification !== 'model_judgment_required') {
    fail(
      'sanitized evaluation request preflight classification must be model_judgment_required',
    );
  }
  const eligibleIdSet = new Set(request.preflight.eligibleAssertionIds);
  assertDenseArray(
    request.eligibleAssertions,
    'sanitized evaluation request eligibleAssertions',
  );
  assertDenseArray(
    request.advisoryAssertions,
    'sanitized evaluation request advisoryAssertions',
  );
  const seenEligibleIds = new Set<string>();
  let previousEligibleId: string | null = null;
  for (const view of request.eligibleAssertions) {
    assertSanitizedAssertionViewV1(view);
    if (view.classification !== 'eligible_fact') {
      fail('sanitized eligibleAssertions must use classification eligible_fact');
    }
    if (!eligibleIdSet.has(view.assertionId)) {
      fail(
        'sanitized eligibleAssertions ids must be members of preflight.eligibleAssertionIds',
      );
    }
    if (seenEligibleIds.has(view.assertionId)) {
      fail('sanitized eligibleAssertions must be unique by assertionId');
    }
    if (previousEligibleId !== null && previousEligibleId >= view.assertionId) {
      fail('sanitized eligibleAssertions must be sorted by assertionId');
    }
    seenEligibleIds.add(view.assertionId);
    previousEligibleId = view.assertionId;
  }
  const allowedAdvisory = new Set<'inference' | 'opinion'>();
  for (const criterion of request.criteria) {
    for (const advisoryClass of criterion.allowedAdvisoryClasses) {
      allowedAdvisory.add(advisoryClass);
    }
  }
  const seenAdvisoryIds = new Set<string>();
  let previousAdvisoryId: string | null = null;
  for (const view of request.advisoryAssertions) {
    assertSanitizedAssertionViewV1(view);
    if (
      view.classification !== 'advisory_inference' &&
      view.classification !== 'advisory_opinion'
    ) {
      fail(
        'sanitized advisoryAssertions must use advisory_inference or advisory_opinion',
      );
    }
    const admittedClass =
      view.classification === 'advisory_inference' ? 'inference' : 'opinion';
    if (!allowedAdvisory.has(admittedClass)) {
      fail(
        'sanitized advisoryAssertions may be non-empty only when a criterion admits that class',
      );
    }
    if (seenEligibleIds.has(view.assertionId)) {
      fail('sanitized advisoryAssertions must not overlap eligibleAssertions');
    }
    if (seenAdvisoryIds.has(view.assertionId)) {
      fail('sanitized advisoryAssertions must be unique by assertionId');
    }
    if (previousAdvisoryId !== null && previousAdvisoryId >= view.assertionId) {
      fail('sanitized advisoryAssertions must be sorted by assertionId');
    }
    seenAdvisoryIds.add(view.assertionId);
    previousAdvisoryId = view.assertionId;
  }
  if (request.advisoryAssertions.length > 0 && allowedAdvisory.size === 0) {
    fail(
      'sanitized advisoryAssertions must be empty when no criterion admits advisory classes',
    );
  }
  const expected = hashCanonicalJson(omitHash(request, 'requestHash'));
  if (request.requestHash !== expected) {
    fail('sanitized evaluation request hash does not match the exact record');
  }
}
