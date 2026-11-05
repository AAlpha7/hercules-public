import { describe, expect, it } from 'vitest';
import { hashCanonicalJson } from '../../src/domain/canonicalJson.js';
import { computeTaskContractHash } from '../../src/domain/contractHash.js';
import {
  computeAssertionPayloadHash,
  computeEvidenceIntegrityAttestationHash,
  computeVerificationReceiptHash,
  type AssertionVerificationReceipt,
  type DecisionAssertion,
  type EvidenceIntegrityAttestation,
} from '../../src/domain/claimAuthorityV2.js';
import type { ArtifactRef, EvidenceManifest } from '../../src/domain/artifact.js';
import type { EvaluationVerdict } from '../../src/domain/evaluationVerdict.js';
import type { TaskContract } from '../../src/domain/taskContract.js';
import {
  IndependentEvaluationError,
  assertArtifactLocatorHintV1,
  assertCurrentEvaluationContextV1,
  assertEvaluationCancellationDispatchV1,
  assertEvaluationGapV1,
  assertEvaluatorAuthoritySnapshotV1,
  assertEvaluatorProposalV1,
  assertIndependentEvaluationInputV1,
  assertIndependentEvaluationReceiptV1,
  assertRuntimeCapabilityIdentityV1,
  assertStableContextIdentityV1,
  computeCancellationDispatchHash,
  computeCapabilitySetHash,
  computeCriterionRelationshipHash,
  computeCurrentContextHash,
  computeControlIdentityHash,
  computeControlObservationHash,
  computeEvaluationPolicyHash,
  computeEvaluationReceiptHash,
  computeEvaluationRubricHash,
  computeEvaluatorAuthorityHash,
  computeEvidenceIdentityHash,
  computeEvidenceObservationHash,
  computeGapHash,
  computeGateDefinitionHash,
  computeGatePlanHash,
  computeGateReceiptHash,
  computeGateReceiptSetHash,
  computeInputHash,
  computeLocatorHintHash,
  computeProposalHash,
  computeRunAuthorityHash,
  computeStableContextHash,
  computeVerificationObservationHash,
  computeVerificationResultHash,
  computeVerdictHash,
  type ArtifactLocatorHintV1,
  type DeterministicGateDefinitionV1,
  type DeterministicGatePlanRefV1,
  type DeterministicGatePlanV1,
  type DeterministicGateReceiptV1,
  type EvaluationCancellationDispatchV1,
  type EvaluationCriterionRelationshipV1,
  type EvaluationGapV1,
  type EvaluationPolicyRefV1,
  type EvaluationPolicyV1,
  type EvaluationRubricCriterionV1,
  type EvaluationRubricRefV1,
  type EvaluationRubricV1,
  type EvaluationRunAuthorityV1,
  type EvaluatorCriterionProposalV1,
  type EvaluatorProposalV1,
  type IndependentEvaluationInputV1,
  type IndependentEvaluationReceiptV1,
  type TrustedCurrentEvaluationContextV1,
  type TrustedEvaluationControlSnapshotV1,
  type TrustedEvaluationEvidenceSnapshotV1,
  type TrustedEvaluationRuntimeCapabilityIdentityV1,
  type TrustedEvaluationStableContextIdentityV1,
  type TrustedEvaluatorAuthoritySnapshotV1,
  type VerificationObservationV1,
  type VerificationResultV1,
} from '../../src/domain/independentEvaluation.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const HASH_A =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B =
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C =
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const HASH_ZERO =
  'sha256:0000000000000000000000000000000000000000000000000000000000000000';

function observation(
  overrides: Partial<VerificationObservationV1> = {},
): VerificationObservationV1 {
  const { observationHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    observationId: 'observation-1',
    kind: 'mechanical' as const,
    criterionIds: ['criterion-1'],
    status: 'pass' as const,
    artifactIds: ['artifact-1'],
    assertionIds: ['assertion-1'],
    verificationReceiptIds: ['receipt-1'],
    observedAt: '2026-08-29T00:00:00.000Z',
    ...fields,
  };
  return {
    ...withoutHash,
    observationHash: overrideHash ?? computeVerificationObservationHash(withoutHash),
  };
}

function verificationResult(
  overrides: Partial<VerificationResultV1> = {},
): VerificationResultV1 {
  const { resultHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    schema: 'hercules-verification-result/v1' as const,
    verificationResultId: 'verification-result-1',
    verifierRunId: 'verifier-1',
    taskId: 'task-1',
    taskContractHash: HASH_A,
    iterationId: 'iteration-1',
    candidateCommit: COMMIT,
    manifestId: 'manifest-1',
    manifestHash: HASH_B,
    startedAt: '2026-08-29T00:00:00.000Z',
    completedAt: '2026-08-29T00:00:01.000Z',
    status: 'complete' as const,
    observations: [observation()],
    ...fields,
  };
  return {
    ...withoutHash,
    resultHash: overrideHash ?? computeVerificationResultHash(withoutHash),
  };
}

function policy(overrides: Partial<EvaluationPolicyV1> = {}): EvaluationPolicyV1 {
  const { policyHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    schema: 'hercules-evaluation-policy/v1' as const,
    policyId: 'hercules-v1-independent-evaluation' as const,
    version: 1,
    issuer: 'hercules-program-control' as const,
    authorityEpoch: 'epoch-1',
    issuedAt: '2026-08-29T00:00:00.000Z',
    expiresAt: '2026-08-30T00:00:00.000Z',
    maxInputBytes: 1_048_576,
    maxArtifacts: 64,
    maxAssertions: 256,
    maxPremisesPerCriterion: 32,
    maxRationaleBytes: 4_096,
    evaluatorDeadlineMs: 60_000,
    requiredRoleDisjointness: ['implementer', 'reviewer', 'verifier'] as const,
    allowedEvaluatorImplementationIds: ['evaluator-impl-1'],
    verifiedFactsOnly: true as const,
    failClosedOnEvidenceGap: true as const,
    freshEvaluatorRequired: true as const,
    implementerEvaluatorForbidden: true as const,
    callerGateResultsForbidden: true as const,
    automaticRetryForbidden: true as const,
    recommendationIsAdvisory: true as const,
    ...fields,
  };
  return {
    ...withoutHash,
    policyHash: overrideHash ?? computeEvaluationPolicyHash(withoutHash),
  };
}

function criterion(
  overrides: Partial<EvaluationRubricCriterionV1> = {},
): EvaluationRubricCriterionV1 {
  return {
    criterionId: 'criterion-1',
    required: true,
    authority: 'mechanical',
    allowedAdvisoryClasses: ['inference', 'opinion'],
    requiredGateIds: ['gate-1'],
    requiredSurfaceIds: ['surface-1'],
    evaluatorInstructionArtifactId: 'artifact-instruction-1',
    evaluatorInstructionArtifactHash: HASH_C,
    ...overrides,
  };
}

function rubric(overrides: Partial<EvaluationRubricV1> = {}): EvaluationRubricV1 {
  const { rubricHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    schema: 'hercules-evaluation-rubric/v1' as const,
    rubricId: 'rubric-1',
    version: 1,
    issuer: 'hercules-program-control' as const,
    authorityEpoch: 'epoch-1',
    taskContractId: 'task-1',
    taskContractVersion: 1,
    taskContractHash: HASH_A,
    criteria: [
      criterion(),
      criterion({
        criterionId: 'criterion-2',
        requiredGateIds: ['gate-2'],
        requiredSurfaceIds: ['surface-2'],
        evaluatorInstructionArtifactId: 'artifact-instruction-2',
      }),
    ],
    ...fields,
  };
  return {
    ...withoutHash,
    rubricHash: overrideHash ?? computeEvaluationRubricHash(withoutHash),
  };
}

function runAuthority(
  overrides: Partial<EvaluationRunAuthorityV1> = {},
): EvaluationRunAuthorityV1 {
  const { authorityHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    schema: 'hercules-evaluation-run-authority/v1' as const,
    issuer: 'hercules-program-control' as const,
    authorityEpoch: 'epoch-1',
    coordinatorRunId: 'coordinator-1',
    coordinatorRole: 'trusted_coordinator' as const,
    evaluatorRunId: 'evaluator-1',
    evaluatorImplementationId: 'evaluator-impl-1',
    evaluatorRole: 'evaluator' as const,
    implementerRunIds: ['implementer-1'],
    verifierRunIds: ['verifier-1'],
    reviewerRunIds: ['reviewer-1'],
    freshContextId: 'fresh-context-1',
    freshContextCreatedAt: '2026-08-29T00:00:00.000Z',
    expiresAt: '2026-08-30T00:00:00.000Z',
    ...fields,
  };
  return {
    ...withoutHash,
    authorityHash: overrideHash ?? computeRunAuthorityHash(withoutHash),
  };
}

function gateDefinition(
  overrides: Partial<DeterministicGateDefinitionV1> = {},
): DeterministicGateDefinitionV1 {
  const { definitionHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    gateId: 'gate-1',
    version: 1,
    kind: 'coordinator_builtin' as const,
    registryFunctionId: 'builtin.check-unit',
    requiredEnvironmentFields: ['host', 'toolchain'],
    requiredArtifactKinds: ['test-log'],
    ...fields,
  };
  return {
    ...withoutHash,
    definitionHash: overrideHash ?? computeGateDefinitionHash(withoutHash),
  };
}

function gatePlan(overrides: Partial<DeterministicGatePlanV1> = {}): DeterministicGatePlanV1 {
  const { gatePlanHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    schema: 'hercules-deterministic-gate-plan/v1' as const,
    gatePlanId: 'gate-plan-1',
    version: 1,
    issuer: 'hercules-program-control' as const,
    authorityEpoch: 'epoch-1',
    taskContractHash: HASH_A,
    candidateCommit: COMMIT,
    gates: [gateDefinition()],
    ...fields,
  };
  return {
    ...withoutHash,
    gatePlanHash: overrideHash ?? computeGatePlanHash(withoutHash),
  };
}

function gateReceipt(
  definition: DeterministicGateDefinitionV1 = gateDefinition(),
  overrides: Partial<DeterministicGateReceiptV1> = {},
): DeterministicGateReceiptV1 {
  const environmentIdentity: Record<string, string> = {};
  for (const key of definition.requiredEnvironmentFields) {
    environmentIdentity[key] = `${key}-value`;
  }
  const { receiptHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    schema: 'hercules-deterministic-gate-receipt/v1' as const,
    gatePlanId: 'gate-plan-1',
    gatePlanHash: HASH_B,
    gateId: definition.gateId,
    gateVersion: definition.version,
    gateDefinitionHash: definition.definitionHash,
    runnerIssuer: 'hercules-program-control' as const,
    runnerRunId: 'runner-1',
    authorityEpoch: 'epoch-1',
    taskId: 'task-1',
    taskContractHash: HASH_A,
    iterationId: 'iteration-1',
    candidateCommit: COMMIT,
    environmentIdentity,
    commandOrSpecHash: HASH_C,
    startedAt: '2026-08-29T00:00:00.000Z',
    completedAt: '2026-08-29T00:00:01.000Z',
    expiresAt: '2026-08-29T01:00:00.000Z',
    status: 'pass' as const,
    exitCode: 0,
    outputArtifactIds: ['artifact-1'],
    outputArtifactHashes: [HASH_C],
    assertionIds: ['assertion-1'],
    verificationReceiptIds: ['receipt-1'],
    ...fields,
  };
  return {
    ...withoutHash,
    receiptHash: overrideHash ?? computeGateReceiptHash(withoutHash),
  };
}

function controlSnapshot(
  overrides: Partial<TrustedEvaluationControlSnapshotV1> = {},
): TrustedEvaluationControlSnapshotV1 {
  const {
    controlIdentityHash: overrideIdentityHash,
    controlObservationHash: overrideObservationHash,
    ...fields
  } = overrides;
  const base = {
    schema: 'hercules-trusted-evaluation-control/v1' as const,
    issuer: 'hercules-program-control' as const,
    authorityEpoch: 'epoch-1',
    policy: policy(),
    rubric: rubric(),
    gatePlan: gatePlan(),
    roles: runAuthority(),
    observedAt: '2026-08-29T00:00:02.000Z',
    ...fields,
  };
  const identityHash = overrideIdentityHash ?? computeControlIdentityHash(base);
  const observationHash =
    overrideObservationHash ??
    computeControlObservationHash(identityHash, base.observedAt);
  return {
    ...base,
    controlIdentityHash: identityHash,
    controlObservationHash: observationHash,
  };
}

function taskContract(): TaskContract {
  const draft = {
    taskId: 'task-1',
    version: 1,
    contractHash: '',
    objective: 'Verify the exact candidate.',
    context: [],
    acceptanceCriteria: [
      {
        id: 'criterion-1',
        text: 'The unit gate passes.',
        authority: 'mechanical' as const,
        required: true,
        proofBinding: null,
      },
      {
        id: 'criterion-2',
        text: 'The surface gate passes.',
        authority: 'mechanical' as const,
        required: true,
        proofBinding: null,
      },
    ],
    constraints: [],
    forbiddenActions: [],
    capabilityPolicy: { version: 'capability-v1', grants: [] },
    verificationPolicy: {
      version: 'verification-v1',
      requiredEvidence: ['pnpm-test'],
      independentEvaluatorRequired: true,
    },
    approvalPolicy: { version: 'approval-v1', requiredDecisions: [] },
    budgetPolicy: {
      version: 'budget-v1',
      maxCostUsd: null,
      maxTokens: null,
      maxDurationMs: null,
    },
    createdBy: { kind: 'human' as const, id: 'owner' },
    createdAt: '2026-08-29T00:00:00.000Z',
    supersedesVersion: null,
  };
  return {
    ...draft,
    contractHash: computeTaskContractHash(draft),
  };
}

function artifact(overrides: Partial<ArtifactRef> = {}): ArtifactRef {
  return {
    id: 'artifact-1',
    sha256: HASH_C,
    mediaType: 'application/json',
    byteLength: 42,
    storageKey: 'artifacts/artifact-1',
    producerStageRunId: 'verifier-1',
    createdAt: '2026-08-29T00:00:01.000Z',
    trustClass: 'primary',
    redactionState: 'none',
    ...overrides,
  };
}

function evidenceManifest(contract: TaskContract): EvidenceManifest {
  const candidate = {
    kind: 'git' as const,
    repository: 'example-org/acme',
    revision: COMMIT,
  };
  const withoutHash = {
    id: 'manifest-1',
    taskId: contract.taskId,
    contractVersion: contract.version,
    iterationId: 'iteration-1',
    candidateRef: candidate,
    entries: [
      {
        artifactRefId: 'artifact-1',
        criterionIds: ['criterion-1'],
        candidateRef: candidate,
        observedAt: '2026-08-29T00:00:02.000Z',
        environmentRef: 'test',
        surface: 'pnpm-test',
        trustClass: 'primary' as const,
      },
    ],
    createdAt: '2026-08-29T00:00:03.000Z',
  };
  return {
    ...withoutHash,
    manifestHash: hashCanonicalJson(withoutHash),
  };
}

function decisionAssertion(overrides: Partial<DecisionAssertion> = {}): DecisionAssertion {
  const payload = { passed: true };
  return {
    id: 'assertion-1',
    subjectKey: 'tests.unit',
    kind: 'fact',
    canonicalPayload: payload,
    payloadHash: computeAssertionPayloadHash(payload),
    advisoryText: null,
    ...overrides,
  };
}

function verificationReceipt(
  assertion: DecisionAssertion,
  contract: TaskContract,
): AssertionVerificationReceipt {
  const withoutHash = {
    schema: 'hercules-assertion-verification/v1' as const,
    id: 'receipt-1',
    assertionId: assertion.id,
    assertionPayloadHash: assertion.payloadHash,
    subjectKey: assertion.subjectKey,
    valueHash: assertion.payloadHash,
    taskId: contract.taskId,
    contractVersion: contract.version,
    contractHash: contract.contractHash,
    iterationId: 'iteration-1',
    candidateRef: {
      kind: 'git' as const,
      repository: 'example-org/acme',
      revision: COMMIT,
    },
    evidenceManifestId: 'manifest-1',
    evidenceManifestHash: HASH_B,
    evidenceEntryArtifactIds: ['artifact-1'],
    criterionIds: ['criterion-1'],
    verifierRunId: 'verifier-1',
    verifierImplementation: 'fixture-verifier-v1',
    observationSurface: 'pnpm-test',
    observedAt: '2026-08-29T00:00:04.000Z',
  };
  return {
    ...withoutHash,
    receiptHash: computeVerificationReceiptHash(withoutHash),
  };
}

function integrityAttestation(): EvidenceIntegrityAttestation {
  const withoutHash = {
    schema: 'hercules-evidence-integrity-attestation/v1' as const,
    result: 'intact' as const,
    evidenceManifestId: 'manifest-1',
    evidenceManifestHash: HASH_B,
    candidateRef: {
      kind: 'git' as const,
      repository: 'example-org/acme',
      revision: COMMIT,
    },
    checkedArtifacts: [{ artifactRefId: 'artifact-1', sha256: HASH_C }],
    verifierImplementation: 'integrity-v1',
    checkedAt: '2026-08-29T00:00:05.000Z',
  };
  return {
    ...withoutHash,
    attestationHash: computeEvidenceIntegrityAttestationHash(withoutHash),
  };
}

function evidenceSnapshot(
  overrides: Partial<TrustedEvaluationEvidenceSnapshotV1> = {},
): TrustedEvaluationEvidenceSnapshotV1 {
  const {
    evidenceIdentityHash: overrideIdentityHash,
    evidenceObservationHash: overrideObservationHash,
    ...fields
  } = overrides;
  const contract = fields.taskContract ?? taskContract();
  const assertion = decisionAssertion();
  const base = {
    schema: 'hercules-trusted-evaluation-evidence/v1' as const,
    sourceId: 'evidence-source-1',
    iterationId: 'iteration-1',
    candidateRef: {
      kind: 'git' as const,
      repository: 'example-org/acme',
      revision: COMMIT,
    },
    evidenceManifest: evidenceManifest(contract),
    artifacts: [artifact()],
    verificationResult: verificationResult({
      taskContractHash: contract.contractHash,
    }),
    assertions: [assertion],
    verificationReceipts: [verificationReceipt(assertion, contract)],
    integrityAttestation: integrityAttestation(),
    observedAt: '2026-08-29T00:00:06.000Z',
    freshUntil: '2026-08-29T01:00:00.000Z',
    ...fields,
    taskContract: contract,
  };
  const identityHash = overrideIdentityHash ?? computeEvidenceIdentityHash(base);
  const observationHash =
    overrideObservationHash ??
    computeEvidenceObservationHash(identityHash, base.observedAt, base.freshUntil);
  return {
    ...base,
    evidenceIdentityHash: identityHash,
    evidenceObservationHash: observationHash,
  };
}

function locatorHint(
  overrides: Partial<ArtifactLocatorHintV1> = {},
): ArtifactLocatorHintV1 {
  const { locatorHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    schema: 'hercules-artifact-locator-hint/v1' as const,
    artifactRefId: 'artifact-1',
    producerRunId: 'implementer-1',
    trustClass: 'agent_claim' as const,
    locatorKind: 'artifact_ref' as const,
    locator: 'artifact-1',
    ...fields,
  };
  return {
    ...withoutHash,
    locatorHash: overrideHash ?? computeLocatorHintHash(withoutHash),
  };
}

function evaluationInput(
  overrides: Partial<IndependentEvaluationInputV1> = {},
): IndependentEvaluationInputV1 {
  const { inputHash: overrideHash, ...fields } = overrides;
  const contract = fields.taskContract ?? taskContract();
  const assertion = decisionAssertion();
  const policyRecord = policy();
  const rubricRecord = rubric({ taskContractHash: contract.contractHash });
  const plan = gatePlan({ taskContractHash: contract.contractHash });
  const withoutHash = {
    schema: 'hercules-independent-evaluation-input/v1' as const,
    requestId: 'request-1',
    iterationId: 'iteration-1',
    candidateRef: {
      kind: 'git' as const,
      repository: 'example-org/acme',
      revision: COMMIT,
    },
    evidenceManifest: evidenceManifest(contract),
    artifacts: [artifact()],
    verificationResult: verificationResult({
      taskContractHash: contract.contractHash,
    }),
    assertions: [assertion],
    verificationReceipts: [verificationReceipt(assertion, contract)],
    integrityAttestation: integrityAttestation(),
    policyRef: {
      schema: 'hercules-evaluation-policy-ref/v1' as const,
      policyId: 'hercules-v1-independent-evaluation' as const,
      version: 1,
      policyHash: policyRecord.policyHash,
    } satisfies EvaluationPolicyRefV1,
    rubricRef: {
      schema: 'hercules-evaluation-rubric-ref/v1' as const,
      rubricId: 'rubric-1',
      version: 1,
      rubricHash: rubricRecord.rubricHash,
    } satisfies EvaluationRubricRefV1,
    gatePlanRef: {
      schema: 'hercules-deterministic-gate-plan-ref/v1' as const,
      gatePlanId: 'gate-plan-1',
      version: 1,
      gatePlanHash: plan.gatePlanHash,
    } satisfies DeterministicGatePlanRefV1,
    locatorHints: [locatorHint()],
    ...fields,
    taskContract: contract,
  };
  return {
    ...withoutHash,
    inputHash: overrideHash ?? computeInputHash(withoutHash),
  };
}

function criterionProposal(
  overrides: Partial<EvaluatorCriterionProposalV1> = {},
): EvaluatorCriterionProposalV1 {
  return {
    criterionId: 'criterion-1',
    proposedStatus: 'pass',
    premiseAssertionIds: ['assertion-1'],
    advisoryRationale: 'Matches verified premises.',
    ...overrides,
  };
}

function evaluatorProposal(
  overrides: Partial<EvaluatorProposalV1> = {},
  rubricRecord: EvaluationRubricV1 = rubric(),
): EvaluatorProposalV1 {
  const { proposalHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    schema: 'hercules-evaluator-proposal/v1' as const,
    requestId: 'request-1',
    inputHash: HASH_A,
    evaluatorRunId: 'evaluator-1',
    evaluatorImplementationId: 'evaluator-impl-1',
    proposalId: 'proposal-1',
    criterionProposals: rubricRecord.criteria.map((item) =>
      criterionProposal({
        criterionId: item.criterionId,
        premiseAssertionIds: ['assertion-1'],
      }),
    ),
    findings: [
      {
        findingCode: 'finding-1',
        severity: 'advisory' as const,
        criterionIds: ['criterion-1'],
        assertionIds: ['assertion-1'],
        advisoryRationale: 'Residual advisory risk.',
      },
    ],
    declaredUnknowns: ['unknown-surface-coverage'],
    remainingRisks: ['residual-flake'],
    ...fields,
  };
  return {
    ...withoutHash,
    proposalHash: overrideHash ?? computeProposalHash(withoutHash),
  };
}

function evaluatorAuthority(
  overrides: Partial<TrustedEvaluatorAuthoritySnapshotV1> = {},
): TrustedEvaluatorAuthoritySnapshotV1 {
  const { authorityHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    schema: 'hercules-trusted-evaluator-authority/v1' as const,
    issuer: 'hercules-program-control' as const,
    authorityEpoch: 'epoch-1',
    evaluatorRunId: 'evaluator-1',
    evaluatorImplementationId: 'evaluator-impl-1',
    evaluatorCapabilityId: 'evaluator-capability-1',
    freshContextId: 'fresh-context-1',
    issuedAt: '2026-08-29T00:00:00.000Z',
    expiresAt: '2026-08-30T00:00:00.000Z',
    ...fields,
  };
  return {
    ...withoutHash,
    authorityHash: overrideHash ?? computeEvaluatorAuthorityHash(withoutHash),
  };
}

function runtimeCapabilities(
  overrides: Partial<TrustedEvaluationRuntimeCapabilityIdentityV1> = {},
): TrustedEvaluationRuntimeCapabilityIdentityV1 {
  const { capabilitySetHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    schema: 'hercules-trusted-evaluation-runtime-capabilities/v1' as const,
    evaluatorCapabilityId: 'evaluator-capability-1',
    gateResolverCapabilityId: 'gate-resolver-1',
    deadlineCapabilityId: 'deadline-1',
    cancellationFactoryCapabilityId: 'cancellation-factory-1',
    clockCapabilityId: 'clock-1',
    clockEpochId: 'clock-epoch-1',
    ...fields,
  };
  return {
    ...withoutHash,
    capabilitySetHash: overrideHash ?? computeCapabilitySetHash(withoutHash),
  };
}

function stableIdentity(
  overrides: Partial<TrustedEvaluationStableContextIdentityV1> = {},
): TrustedEvaluationStableContextIdentityV1 {
  const { stableContextHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    schema: 'hercules-trusted-evaluation-stable-context/v1' as const,
    inputHash: HASH_A,
    controlIdentityHash: HASH_B,
    evidenceIdentityHash: HASH_C,
    gateReceiptSetHash: HASH_A,
    roleAuthorityHash: HASH_B,
    evaluatorAuthorityHash: HASH_C,
    runtimeCapabilitySetHash: HASH_A,
    authorityEpoch: 'epoch-1',
    clockCapabilityId: 'clock-1',
    clockEpochId: 'clock-epoch-1',
    freshUntil: '2026-08-29T01:00:00.000Z',
    ...fields,
  };
  return {
    ...withoutHash,
    stableContextHash: overrideHash ?? computeStableContextHash(withoutHash),
  };
}

function currentContext(
  overrides: Partial<TrustedCurrentEvaluationContextV1> = {},
): TrustedCurrentEvaluationContextV1 {
  const { contextHash: overrideHash, ...fields } = overrides;
  const control = fields.control ?? controlSnapshot();
  const evidence = fields.evidence ?? evidenceSnapshot();
  const definition = gateDefinition();
  const receipts = fields.gateReceipts ?? [gateReceipt(definition)];
  const authority = fields.evaluatorAuthority ?? evaluatorAuthority();
  const capabilities = fields.runtimeCapabilities ?? runtimeCapabilities();
  const gateReceiptSetHash =
    fields.gateReceiptSetHash ?? computeGateReceiptSetHash(receipts);
  const inputHash = fields.inputHash ?? HASH_A;
  const identity =
    fields.stableIdentity ??
    stableIdentity({
      inputHash,
      controlIdentityHash: control.controlIdentityHash,
      evidenceIdentityHash: evidence.evidenceIdentityHash,
      gateReceiptSetHash,
      roleAuthorityHash: control.roles.authorityHash,
      evaluatorAuthorityHash: authority.authorityHash,
      runtimeCapabilitySetHash: capabilities.capabilitySetHash,
      authorityEpoch: control.authorityEpoch,
      clockCapabilityId: capabilities.clockCapabilityId,
      clockEpochId: capabilities.clockEpochId,
      freshUntil: '2026-08-29T01:00:00.000Z',
    });
  const withoutHash = {
    schema: 'hercules-trusted-current-evaluation-context/v1' as const,
    inputHash,
    control,
    evidence,
    gateReceipts: receipts,
    gateReceiptSetHash,
    evaluatorAuthority: authority,
    runtimeCapabilities: capabilities,
    stableIdentity: identity,
    observedAt: '2026-08-29T00:00:10.000Z',
    freshness: 'fresh' as const,
    ...fields,
  };
  return {
    ...withoutHash,
    contextHash: overrideHash ?? computeCurrentContextHash(withoutHash),
  };
}

function evaluationGap(overrides: Partial<EvaluationGapV1> = {}): EvaluationGapV1 {
  const { gapHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    schema: 'hercules-independent-evaluation-gap/v1' as const,
    requestId: 'request-1',
    inputHash: HASH_A,
    acceptedContextHash: HASH_B,
    acceptedStableContextHash: HASH_C,
    observedContextHash: HASH_A,
    observedStableContextHash: HASH_B,
    reason: 'freshness_expired' as const,
    proposalDiscarded: true as const,
    outcome: 'need_more_evidence' as const,
    observedAt: '2026-08-29T00:00:20.000Z',
    ...fields,
  };
  return {
    ...withoutHash,
    gapHash: overrideHash ?? computeGapHash(withoutHash),
  };
}

function cancellationDispatch(
  overrides: Partial<EvaluationCancellationDispatchV1> = {},
): EvaluationCancellationDispatchV1 {
  const { dispatchHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    signalId: 'signal-1',
    attemptId: 'attempt-1',
    reason: 'peer_settled' as const,
    status: 'dispatched' as const,
    dispatchedAt: '2026-08-29T00:00:15.000Z',
    ...fields,
  };
  return {
    ...withoutHash,
    dispatchHash: overrideHash ?? computeCancellationDispatchHash(withoutHash),
  };
}

function criterionRelationship(
  overrides: Partial<EvaluationCriterionRelationshipV1> = {},
): EvaluationCriterionRelationshipV1 {
  const { relationshipHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    criterionId: 'criterion-1',
    assertionIds: ['assertion-1'],
    evidenceArtifactIds: ['artifact-1'],
    verificationReceiptIds: ['receipt-1'],
    ...fields,
  };
  return {
    ...withoutHash,
    relationshipHash: overrideHash ?? computeCriterionRelationshipHash(withoutHash),
  };
}

function verdict(overrides: Partial<EvaluationVerdict> = {}): EvaluationVerdict {
  return {
    id: 'verdict-1',
    binding: {
      taskId: 'task-1',
      contractVersion: 1,
      contractHash: HASH_A,
      iterationId: 'iteration-1',
      candidateRef: {
        kind: 'git',
        repository: 'example-org/acme',
        revision: COMMIT,
      },
      evidenceManifestHash: HASH_B,
      evaluatorVersion: 'evaluator-v1',
      evaluatorModel: 'model-1',
      evaluatorRuntime: 'runtime-1',
      policyVersion: 'policy-v1',
    },
    outcome: 'pass',
    criterionResults: [
      {
        criterionId: 'criterion-1',
        status: 'pass',
        authority: 'mechanical',
        evidenceRefs: ['artifact-1'],
        observedAt: '2026-08-29T00:00:10.000Z',
        candidateBinding: COMMIT,
        explanation: 'Passed under mechanical authority.',
      },
    ],
    blockingFindings: [],
    nonBlockingRisks: [
      {
        code: 'risk-1',
        summary: 'Advisory residual risk.',
        criterionIds: ['criterion-1'],
      },
    ],
    recommendedNextStage: 'complete',
    evaluatorAgentRunId: 'evaluator-1',
    createdAt: '2026-08-29T00:00:30.000Z',
    ...overrides,
  };
}

function evaluationReceipt(
  overrides: Partial<IndependentEvaluationReceiptV1> = {},
): IndependentEvaluationReceiptV1 {
  const { receiptHash: overrideHash, ...fields } = overrides;
  const verdictRecord = fields.verdict ?? verdict();
  const withoutHash = {
    schema: 'hercules-independent-evaluation-receipt/v1' as const,
    receiptId: 'receipt-eval-1',
    requestId: 'request-1',
    inputHash: HASH_A,
    taskId: 'task-1',
    taskContractHash: HASH_A,
    iterationId: 'iteration-1',
    candidateCommit: COMMIT,
    manifestId: 'manifest-1',
    manifestHash: HASH_B,
    artifactInventoryHash: HASH_C,
    verificationResultHash: HASH_A,
    verificationReceiptSetHash: HASH_B,
    integrityAttestationHash: HASH_C,
    assertionSetHash: HASH_A,
    gatePlanHash: HASH_B,
    gateReceiptSetHash: HASH_C,
    policyHash: HASH_A,
    rubricHash: HASH_B,
    roleAuthorityHash: HASH_C,
    controlIdentityHash: HASH_A,
    evidenceSourceId: 'evidence-source-1',
    evidenceIdentityHash: HASH_B,
    authorityEpoch: 'epoch-1',
    coordinatorRunId: 'coordinator-1',
    evaluatorRunId: 'evaluator-1',
    evaluatorImplementationId: 'evaluator-impl-1',
    acceptedContextHash: HASH_C,
    postEvaluationContextHash: HASH_A,
    stableContextHash: HASH_B,
    acceptedObservedAt: '2026-08-29T00:00:10.000Z',
    postEvaluationObservedAt: '2026-08-29T00:00:20.000Z',
    freshUntil: '2026-08-29T01:00:00.000Z',
    preflightHash: HASH_C,
    proposalHash: HASH_A,
    noProposalReason: null,
    cancellationDispatches: [cancellationDispatch()],
    verdict: verdictRecord,
    verdictHash: computeVerdictHash(verdictRecord),
    criterionRelationships: [criterionRelationship()],
    outcomeReasonCodes: ['criterion-pass'],
    createdAt: '2026-08-29T00:00:30.000Z',
    ...fields,
  };
  return {
    ...withoutHash,
    receiptHash: overrideHash ?? computeEvaluationReceiptHash(withoutHash),
  };
}

describe('M8 independent evaluation subject records', () => {
  it('accepts happy-path fixtures for every subject/context/receipt record', () => {
    const policyRecord = policy();
    const rubricRecord = rubric();
    const input = evaluationInput();
    const proposal = evaluatorProposal({}, rubricRecord);
    const authority = evaluatorAuthority();
    const capabilities = runtimeCapabilities();
    const context = currentContext();
    const gap = evaluationGap();
    const dispatch = cancellationDispatch();
    const withProposal = evaluationReceipt();
    const withoutProposal = evaluationReceipt({
      proposalHash: null,
      noProposalReason: 'deterministic_pass',
    });

    expect(() => assertArtifactLocatorHintV1(locatorHint())).not.toThrow();
    expect(() => assertIndependentEvaluationInputV1(input, policyRecord)).not.toThrow();
    expect(() =>
      assertEvaluatorProposalV1(proposal, policyRecord, rubricRecord),
    ).not.toThrow();
    expect(() => assertEvaluatorAuthoritySnapshotV1(authority)).not.toThrow();
    expect(() => assertRuntimeCapabilityIdentityV1(capabilities)).not.toThrow();
    expect(() =>
      assertStableContextIdentityV1(context.stableIdentity),
    ).not.toThrow();
    expect(() => assertCurrentEvaluationContextV1(context)).not.toThrow();
    expect(() => assertEvaluationGapV1(gap)).not.toThrow();
    expect(() => assertEvaluationCancellationDispatchV1(dispatch)).not.toThrow();
    expect(() => assertIndependentEvaluationReceiptV1(withProposal)).not.toThrow();
    expect(() => assertIndependentEvaluationReceiptV1(withoutProposal)).not.toThrow();
  });

  it.each([
    {
      name: 'input over maxArtifacts',
      run: () =>
        assertIndependentEvaluationInputV1(
          evaluationInput({
            artifacts: [
              artifact(),
              artifact({ id: 'artifact-2', storageKey: 'artifacts/artifact-2' }),
            ],
          }),
          policy({ maxArtifacts: 1 }),
        ),
    },
    {
      name: 'input over maxAssertions',
      run: () =>
        assertIndependentEvaluationInputV1(
          evaluationInput({
            assertions: [
              decisionAssertion(),
              decisionAssertion({ id: 'assertion-2', subjectKey: 'tests.unit-2' }),
            ],
          }),
          policy({ maxAssertions: 1 }),
        ),
    },
    {
      name: 'input over maxInputBytes',
      run: () =>
        assertIndependentEvaluationInputV1(evaluationInput(), policy({ maxInputBytes: 64 })),
    },
    {
      name: 'input caller-supplied outcome field',
      run: () =>
        assertIndependentEvaluationInputV1(
          {
            ...evaluationInput(),
            outcome: 'pass',
          } as unknown as IndependentEvaluationInputV1,
          policy(),
        ),
    },
    {
      name: 'locator hint with status field',
      run: () =>
        assertArtifactLocatorHintV1({
          ...locatorHint(),
          status: 'ok',
        } as unknown as ArtifactLocatorHintV1),
    },
    {
      name: 'proposal missing criterion',
      run: () => {
        const rubricRecord = rubric();
        assertEvaluatorProposalV1(
          evaluatorProposal(
            {
              criterionProposals: [
                criterionProposal({ criterionId: 'criterion-1' }),
              ],
            },
            rubricRecord,
          ),
          policy(),
          rubricRecord,
        );
      },
    },
    {
      name: 'proposal extra criterion',
      run: () => {
        const rubricRecord = rubric();
        assertEvaluatorProposalV1(
          evaluatorProposal(
            {
              criterionProposals: [
                criterionProposal({ criterionId: 'criterion-1' }),
                criterionProposal({ criterionId: 'criterion-2' }),
                criterionProposal({ criterionId: 'criterion-3' }),
              ],
            },
            rubricRecord,
          ),
          policy(),
          rubricRecord,
        );
      },
    },
    {
      name: 'proposal reordered criteria',
      run: () => {
        const rubricRecord = rubric();
        assertEvaluatorProposalV1(
          evaluatorProposal(
            {
              criterionProposals: [
                criterionProposal({ criterionId: 'criterion-2' }),
                criterionProposal({ criterionId: 'criterion-1' }),
              ],
            },
            rubricRecord,
          ),
          policy(),
          rubricRecord,
        );
      },
    },
    {
      name: 'proposal duplicate criterion',
      run: () => {
        const rubricRecord = rubric();
        assertEvaluatorProposalV1(
          evaluatorProposal(
            {
              criterionProposals: [
                criterionProposal({ criterionId: 'criterion-1' }),
                criterionProposal({ criterionId: 'criterion-1' }),
              ],
            },
            rubricRecord,
          ),
          policy(),
          rubricRecord,
        );
      },
    },
    {
      name: 'proposal premises over maxPremisesPerCriterion',
      run: () => {
        const rubricRecord = rubric();
        assertEvaluatorProposalV1(
          evaluatorProposal(
            {
              criterionProposals: [
                criterionProposal({
                  criterionId: 'criterion-1',
                  premiseAssertionIds: ['assertion-1', 'assertion-2'],
                }),
                criterionProposal({ criterionId: 'criterion-2' }),
              ],
            },
            rubricRecord,
          ),
          policy({ maxPremisesPerCriterion: 1 }),
          rubricRecord,
        );
      },
    },
    {
      name: 'proposal rationale over maxRationaleBytes',
      run: () => {
        const rubricRecord = rubric();
        assertEvaluatorProposalV1(
          evaluatorProposal(
            {
              criterionProposals: [
                criterionProposal({
                  criterionId: 'criterion-1',
                  advisoryRationale: 'too-long-rationale',
                }),
                criterionProposal({ criterionId: 'criterion-2' }),
              ],
            },
            rubricRecord,
          ),
          policy({ maxRationaleBytes: 4 }),
          rubricRecord,
        );
      },
    },
    {
      name: 'proposal caller-supplied outcome field',
      run: () => {
        const rubricRecord = rubric();
        assertEvaluatorProposalV1(
          {
            ...evaluatorProposal({}, rubricRecord),
            outcome: 'pass',
          } as unknown as EvaluatorProposalV1,
          policy(),
          rubricRecord,
        );
      },
    },
    {
      name: 'context roleAuthorityHash mismatch',
      run: () => {
        const context = currentContext();
        const {
          stableContextHash: _ignoredStableHash,
          ...stableFields
        } = context.stableIdentity;
        assertCurrentEvaluationContextV1(
          currentContext({
            stableIdentity: stableIdentity({
              ...stableFields,
              roleAuthorityHash: HASH_ZERO,
            }),
          }),
        );
      },
    },
    {
      name: 'context gateReceiptSetHash mismatch',
      run: () =>
        assertCurrentEvaluationContextV1(
          currentContext({
            gateReceiptSetHash: HASH_ZERO,
          }),
        ),
    },
    {
      name: 'context freshness not fresh',
      run: () =>
        assertCurrentEvaluationContextV1(
          currentContext({
            freshness: 'stale' as TrustedCurrentEvaluationContextV1['freshness'],
          }),
        ),
    },
    {
      name: 'context observedAt after freshUntil',
      run: () =>
        assertCurrentEvaluationContextV1(
          currentContext({
            observedAt: '2026-08-29T02:00:00.000Z',
          }),
        ),
    },
    {
      name: 'context stable-identity field drift',
      run: () => {
        const context = currentContext();
        const {
          stableContextHash: _ignoredStableHash,
          ...stableFields
        } = context.stableIdentity;
        assertCurrentEvaluationContextV1(
          currentContext({
            stableIdentity: stableIdentity({
              ...stableFields,
              controlIdentityHash: HASH_ZERO,
            }),
          }),
        );
      },
    },
    {
      name: 'gap one-sided observed hashes',
      run: () =>
        assertEvaluationGapV1(
          evaluationGap({
            observedContextHash: HASH_A,
            observedStableContextHash: null,
          }),
        ),
    },
    {
      name: 'gap wrong reason literal',
      run: () =>
        assertEvaluationGapV1(
          evaluationGap({
            reason: 'not-a-reason' as EvaluationGapV1['reason'],
          }),
        ),
    },
    {
      name: 'gap proposalDiscarded false',
      run: () =>
        assertEvaluationGapV1(
          evaluationGap({
            proposalDiscarded: false as unknown as true,
          }),
        ),
    },
    {
      name: 'receipt both proposalHash and noProposalReason',
      run: () =>
        assertIndependentEvaluationReceiptV1(
          evaluationReceipt({
            proposalHash: HASH_A,
            noProposalReason: 'evidence_gap',
          }),
        ),
    },
    {
      name: 'receipt neither proposalHash nor noProposalReason',
      run: () =>
        assertIndependentEvaluationReceiptV1(
          evaluationReceipt({
            proposalHash: null,
            noProposalReason: null,
          }),
        ),
    },
    {
      name: 'receipt postEvaluationObservedAt before acceptedObservedAt',
      run: () =>
        assertIndependentEvaluationReceiptV1(
          evaluationReceipt({
            acceptedObservedAt: '2026-08-29T00:00:20.000Z',
            postEvaluationObservedAt: '2026-08-29T00:00:10.000Z',
          }),
        ),
    },
    {
      name: 'receipt wrong verdictHash',
      run: () =>
        assertIndependentEvaluationReceiptV1(
          evaluationReceipt({
            verdictHash: HASH_ZERO,
          }),
        ),
    },
    {
      name: 'receipt wrong receiptHash',
      run: () =>
        assertIndependentEvaluationReceiptV1(
          evaluationReceipt({
            receiptHash: HASH_ZERO,
          }),
        ),
    },
    {
      name: 'receipt pass verdict with a dispatch_failed cancellation record',
      run: () =>
        assertIndependentEvaluationReceiptV1(
          evaluationReceipt({
            cancellationDispatches: [
              cancellationDispatch({ status: 'dispatch_failed' }),
            ],
          }),
        ),
    },
    {
      name: 'receipt duplicate criterion relationship',
      run: () =>
        assertIndependentEvaluationReceiptV1(
          evaluationReceipt({
            criterionRelationships: [
              criterionRelationship({ criterionId: 'criterion-1' }),
              criterionRelationship({
                criterionId: 'criterion-1',
                assertionIds: ['assertion-2'],
              }),
            ],
          }),
        ),
    },
  ])('rejects $name', ({ run }) => {
    expect(run).toThrow(IndependentEvaluationError);
  });

  it('computes subject hashes deterministically for identical logical records', () => {
    const inputA = evaluationInput();
    const inputB = evaluationInput();
    expect(inputA.inputHash).toBe(inputB.inputHash);
    const { inputHash: _ignoredInputHash, ...inputWithoutHash } = inputA;
    expect(computeInputHash(inputWithoutHash)).toBe(inputA.inputHash);

    const rubricRecord = rubric();
    const proposalA = evaluatorProposal({}, rubricRecord);
    const proposalB = evaluatorProposal({}, rubricRecord);
    expect(proposalA.proposalHash).toBe(proposalB.proposalHash);

    const contextA = currentContext();
    const contextB = currentContext();
    expect(contextA.contextHash).toBe(contextB.contextHash);
    expect(contextA.stableIdentity.stableContextHash).toBe(
      contextB.stableIdentity.stableContextHash,
    );

    const gapA = evaluationGap();
    const gapB = evaluationGap();
    expect(gapA.gapHash).toBe(gapB.gapHash);

    const dispatchA = cancellationDispatch();
    const dispatchB = cancellationDispatch();
    expect(dispatchA.dispatchHash).toBe(dispatchB.dispatchHash);

    const receiptA = evaluationReceipt();
    const receiptB = evaluationReceipt();
    expect(receiptA.receiptHash).toBe(receiptB.receiptHash);
    expect(receiptA.verdictHash).toBe(computeVerdictHash(receiptA.verdict));
  });
});
