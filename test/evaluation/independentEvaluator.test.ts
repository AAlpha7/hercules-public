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
import type { ArtifactRef, CandidateRef, EvidenceManifest } from '../../src/domain/artifact.js';
import type { TaskContract } from '../../src/domain/taskContract.js';
import {
  assertIndependentEvaluationReceiptV1,
  computeCancellationDispatchHash,
  computeCapabilitySetHash,
  computeControlIdentityHash,
  computeControlObservationHash,
  computeEvaluationPolicyHash,
  computeEvaluationReceiptHash,
  computeVerdictHash,
  computeEvaluationRubricHash,
  computeEvaluatorAuthorityHash,
  computeEvidenceIdentityHash,
  computeEvidenceObservationHash,
  computeGateDefinitionHash,
  computeGatePlanHash,
  computeGateReceiptHash,
  computeInputHash,
  computeProposalHash,
  computeRunAuthorityHash,
  computeVerificationObservationHash,
  computeVerificationResultHash,
  type CurrentGateReceiptQueryV1,
  type DeterministicGateDefinitionV1,
  type DeterministicGatePlanV1,
  type DeterministicGateReceiptV1,
  type EvaluationCancellationControllerV1,
  type EvaluationCancellationDispatchV1,
  type EvaluationCancellationReasonV1,
  type EvaluationCancellationSignalV1,
  type EvaluationClockV1,
  type EvaluationDeadlinePortV1,
  type EvaluationPolicyV1,
  type EvaluationRubricCriterionV1,
  type EvaluationRubricV1,
  type EvaluationRunAuthorityV1,
  type EvaluatorProposalV1,
  type IndependentEvaluationInputV1,
  type IndependentEvaluationReceiptV1,
  type IndependentEvaluatorPortV1,
  type TrustedEvaluationCancellationFactoryV1,
  type TrustedEvaluationControlSnapshotV1,
  type TrustedEvaluationEvidenceSnapshotV1,
  type TrustedEvaluationRuntimeCapabilityIdentityV1,
  type TrustedEvaluatorAuthoritySnapshotV1,
  type VerificationObservationV1,
  type VerificationResultV1,
} from '../../src/domain/independentEvaluation.js';
import {
  type PreflightSubjectV1,
} from '../../src/evaluation/deterministicPreflight.js';
import {
  createIndependentEvaluationCoordinator,
  type TrustedEvaluationRuntimeCapabilitiesV1,
  type TrustedEvaluationSourcesV1,
} from '../../src/evaluation/independentEvaluator.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const HASH_C =
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const HASH_D =
  'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const HASH_E =
  'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
function candidateRef(): CandidateRef {
  return {
    kind: 'git',
    repository: 'example-org/acme',
    revision: COMMIT,
  };
}

interface ContractOptions {
  readonly criteria: readonly {
    readonly id: string;
    readonly authority: 'mechanical' | 'verifier' | 'evaluator' | 'human';
    readonly required: boolean;
  }[];
  readonly independentEvaluatorRequired: boolean;
}

function taskContract(options: ContractOptions): TaskContract {
  const draft = {
    taskId: 'task-1',
    version: 1,
    contractHash: '',
    objective: 'Verify the exact candidate.',
    context: [],
    acceptanceCriteria: options.criteria.map((criterion) => ({
      id: criterion.id,
      text: `Criterion ${criterion.id}`,
      authority: criterion.authority,
      required: criterion.required,
      proofBinding: null,
    })),
    constraints: [],
    forbiddenActions: [],
    capabilityPolicy: { version: 'capability-v1', grants: [] },
    verificationPolicy: {
      version: 'verification-v1',
      requiredEvidence: ['pnpm-test'],
      independentEvaluatorRequired: options.independentEvaluatorRequired,
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

function artifact(id: string, sha256: string): ArtifactRef {
  return {
    id,
    sha256,
    mediaType: 'application/json',
    byteLength: 42,
    storageKey: `artifacts/${id}`,
    producerStageRunId: 'verifier-1',
    createdAt: '2026-08-29T00:00:01.000Z',
    trustClass: 'primary',
    redactionState: 'none',
  };
}

function evidenceManifest(
  contract: TaskContract,
  criterionIds: readonly string[],
  extraEntries: readonly {
    readonly artifactRefId: string;
    readonly criterionIds: readonly string[];
    readonly surface: string;
  }[] = [],
): EvidenceManifest {
  const candidate = candidateRef();
  const withoutHash = {
    id: 'manifest-1',
    taskId: contract.taskId,
    contractVersion: contract.version,
    iterationId: 'iteration-1',
    candidateRef: candidate,
    entries: [
      {
        artifactRefId: 'artifact-1',
        criterionIds: [...criterionIds].sort(),
        candidateRef: candidate,
        observedAt: '2026-08-29T00:00:02.000Z',
        environmentRef: 'test',
        surface: 'pnpm-test',
        trustClass: 'primary' as const,
      },
      ...extraEntries.map((entry) => ({
        artifactRefId: entry.artifactRefId,
        criterionIds: [...entry.criterionIds].sort(),
        candidateRef: candidate,
        observedAt: '2026-08-29T00:00:02.000Z',
        environmentRef: 'test',
        surface: entry.surface,
        trustClass: 'primary' as const,
      })),
    ],
    createdAt: '2026-08-29T00:00:03.000Z',
  };
  return {
    ...withoutHash,
    manifestHash: hashCanonicalJson(withoutHash),
  };
}

function decisionAssertion(
  id: string,
  subjectKey: string,
  payload: { readonly passed: boolean },
): DecisionAssertion {
  return {
    id,
    subjectKey,
    kind: 'fact',
    canonicalPayload: payload,
    payloadHash: computeAssertionPayloadHash(payload),
    advisoryText: null,
  };
}

function verificationReceipt(
  assertion: DecisionAssertion,
  contract: TaskContract,
  manifest: EvidenceManifest,
  criterionIds: readonly string[],
  id: string,
): AssertionVerificationReceipt {
  const withoutHash = {
    schema: 'hercules-assertion-verification/v1' as const,
    id,
    assertionId: assertion.id,
    assertionPayloadHash: assertion.payloadHash,
    subjectKey: assertion.subjectKey,
    valueHash: assertion.payloadHash,
    taskId: contract.taskId,
    contractVersion: contract.version,
    contractHash: contract.contractHash,
    iterationId: 'iteration-1',
    candidateRef: candidateRef(),
    evidenceManifestId: manifest.id,
    evidenceManifestHash: manifest.manifestHash,
    evidenceEntryArtifactIds: ['artifact-1'],
    criterionIds: [...criterionIds].sort(),
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

function integrityAttestation(
  manifest: EvidenceManifest,
  artifacts: readonly ArtifactRef[],
): EvidenceIntegrityAttestation {
  const withoutHash = {
    schema: 'hercules-evidence-integrity-attestation/v1' as const,
    result: 'intact' as const,
    evidenceManifestId: manifest.id,
    evidenceManifestHash: manifest.manifestHash,
    candidateRef: candidateRef(),
    checkedArtifacts: artifacts.map((entry) => ({
      artifactRefId: entry.id,
      sha256: entry.sha256,
    })),
    verifierImplementation: 'integrity-v1',
    checkedAt: '2026-08-29T00:00:05.000Z',
  };
  return {
    ...withoutHash,
    attestationHash: computeEvidenceIntegrityAttestationHash(withoutHash),
  };
}

function observation(
  overrides: Partial<VerificationObservationV1> &
    Pick<VerificationObservationV1, 'observationId'>,
): VerificationObservationV1 {
  const { observationHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    kind: 'mechanical' as const,
    criterionIds: ['criterion-mechanical'],
    status: 'pass' as const,
    artifactIds: ['artifact-1'],
    assertionIds: ['assertion-mechanical'],
    verificationReceiptIds: ['receipt-mechanical'],
    observedAt: '2026-08-29T00:00:00.000Z',
    ...fields,
  };
  return {
    ...withoutHash,
    observationHash: overrideHash ?? computeVerificationObservationHash(withoutHash),
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
  overrides: Partial<EvaluationRubricCriterionV1>,
): EvaluationRubricCriterionV1 {
  return {
    criterionId: 'criterion-mechanical',
    required: true,
    authority: 'mechanical',
    allowedAdvisoryClasses: ['inference', 'opinion'],
    requiredGateIds: ['gate-external-1'],
    requiredSurfaceIds: [],
    evaluatorInstructionArtifactId: 'artifact-instruction-1',
    evaluatorInstructionArtifactHash: HASH_C,
    ...overrides,
  };
}

function rubric(
  contract: TaskContract,
  criteria: readonly EvaluationRubricCriterionV1[],
): EvaluationRubricV1 {
  const withoutHash = {
    schema: 'hercules-evaluation-rubric/v1' as const,
    rubricId: 'rubric-1',
    version: 1,
    issuer: 'hercules-program-control' as const,
    authorityEpoch: 'epoch-1',
    taskContractId: contract.taskId,
    taskContractVersion: contract.version,
    taskContractHash: contract.contractHash,
    criteria: [...criteria],
  };
  return {
    ...withoutHash,
    rubricHash: computeEvaluationRubricHash(withoutHash),
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
    gateId: 'gate-external-1',
    version: 1,
    kind: 'trusted_external_receipt' as const,
    registryFunctionId: 'external.unit-gate',
    requiredEnvironmentFields: ['host'],
    requiredArtifactKinds: ['test-log'],
    ...fields,
  };
  return {
    ...withoutHash,
    definitionHash: overrideHash ?? computeGateDefinitionHash(withoutHash),
  };
}

function gatePlan(
  contract: TaskContract,
  gates: readonly DeterministicGateDefinitionV1[],
): DeterministicGatePlanV1 {
  const withoutHash = {
    schema: 'hercules-deterministic-gate-plan/v1' as const,
    gatePlanId: 'gate-plan-1',
    version: 1,
    issuer: 'hercules-program-control' as const,
    authorityEpoch: 'epoch-1',
    taskContractHash: contract.contractHash,
    candidateCommit: COMMIT,
    gates: [...gates],
  };
  return {
    ...withoutHash,
    gatePlanHash: computeGatePlanHash(withoutHash),
  };
}

function gateReceipt(
  definition: DeterministicGateDefinitionV1,
  plan: DeterministicGatePlanV1,
  contract: TaskContract,
  overrides: Partial<DeterministicGateReceiptV1> = {},
): DeterministicGateReceiptV1 {
  const environmentIdentity: Record<string, string> = {};
  for (const key of definition.requiredEnvironmentFields) {
    environmentIdentity[key] = `${key}-value`;
  }
  const { receiptHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    schema: 'hercules-deterministic-gate-receipt/v1' as const,
    gatePlanId: plan.gatePlanId,
    gatePlanHash: plan.gatePlanHash,
    gateId: definition.gateId,
    gateVersion: definition.version,
    gateDefinitionHash: definition.definitionHash,
    runnerIssuer: 'hercules-program-control' as const,
    runnerRunId: 'runner-1',
    authorityEpoch: 'epoch-1',
    taskId: contract.taskId,
    taskContractHash: contract.contractHash,
    iterationId: 'iteration-1',
    candidateCommit: COMMIT,
    environmentIdentity,
    commandOrSpecHash: HASH_D,
    startedAt: '2026-08-29T00:00:00.000Z',
    completedAt: '2026-08-29T00:00:01.000Z',
    expiresAt: '2026-08-29T01:00:00.000Z',
    status: 'pass' as const,
    exitCode: 0,
    outputArtifactIds: ['artifact-1'],
    outputArtifactHashes: [HASH_C],
    assertionIds: ['assertion-mechanical'],
    verificationReceiptIds: ['receipt-mechanical'],
    ...fields,
  };
  return {
    ...withoutHash,
    receiptHash: overrideHash ?? computeGateReceiptHash(withoutHash),
  };
}

type ScenarioKind =
  | 'all_deterministic'
  | 'model_pass'
  | 'model_fail_with_blocking'
  | 'human_pending'
  | 'optional_insufficient'
  | 'surface_verified_fail';

interface ScenarioSpec {
  readonly kind: ScenarioKind;
}

function buildSubject(spec: ScenarioSpec): PreflightSubjectV1 {
  const kind = spec.kind;
  const includeEvaluatorModel =
    kind === 'model_pass' ||
    kind === 'model_fail_with_blocking' ||
    kind === 'human_pending';
  const includeMechanicalModel =
    kind === 'all_deterministic' || kind === 'optional_insufficient';
  const includeHuman = kind === 'human_pending';
  const includeOptional = kind === 'optional_insufficient';
  const includeSurfaceFail = kind === 'surface_verified_fail';
  const independentEvaluatorRequired = includeEvaluatorModel;

  const contractCriteria: Array<ContractOptions['criteria'][number]> = [
    { id: 'criterion-mechanical', authority: 'mechanical', required: true },
  ];
  if (includeEvaluatorModel) {
    contractCriteria.push({
      id: 'criterion-model',
      authority: 'evaluator',
      required: true,
    });
  }
  if (includeMechanicalModel) {
    contractCriteria.push({
      id: 'criterion-model',
      authority: 'mechanical',
      required: true,
    });
  }
  if (includeHuman) {
    contractCriteria.push({
      id: 'criterion-human',
      authority: 'human',
      required: true,
    });
  }
  if (includeOptional) {
    contractCriteria.push({
      id: 'criterion-optional',
      authority: 'mechanical',
      required: false,
    });
  }

  const contract = taskContract({
    criteria: contractCriteria,
    independentEvaluatorRequired,
  });

  const artifacts = [artifact('artifact-1', HASH_C)];
  if (includeSurfaceFail) {
    artifacts.push(artifact('surface-1', HASH_E));
  }

  const manifestCriterionIds = contractCriteria.map((entry) => entry.id);
  const manifest = evidenceManifest(
    contract,
    manifestCriterionIds,
    includeSurfaceFail
      ? [
          {
            artifactRefId: 'surface-1',
            criterionIds: ['criterion-mechanical'],
            surface: 'surface-1',
          },
        ]
      : [],
  );

  const assertionMechanical = decisionAssertion('assertion-mechanical', 'tests.unit', {
    passed: true,
  });
  const assertionModel = decisionAssertion('assertion-model', 'design.soundness', {
    passed: true,
  });
  const assertions: DecisionAssertion[] = [assertionMechanical];
  if (includeEvaluatorModel || includeMechanicalModel) {
    assertions.push(assertionModel);
  }

  const receipts = [
    verificationReceipt(
      assertionMechanical,
      contract,
      manifest,
      ['criterion-mechanical'],
      'receipt-mechanical',
    ),
  ];
  if (assertions.some((entry) => entry.id === 'assertion-model')) {
    receipts.push(
      verificationReceipt(
        assertionModel,
        contract,
        manifest,
        ['criterion-model'],
        'receipt-model',
      ),
    );
  }

  const observations: VerificationObservationV1[] = [
    observation({
      observationId: 'observation-mechanical',
      kind: 'mechanical',
      criterionIds: ['criterion-mechanical'],
      status: 'pass',
      artifactIds: ['artifact-1'],
      assertionIds: ['assertion-mechanical'],
      verificationReceiptIds: ['receipt-mechanical'],
    }),
  ];

  if (assertions.some((entry) => entry.id === 'assertion-model')) {
    observations.push(
      observation({
        observationId: 'observation-model',
        kind: 'mechanical',
        criterionIds: ['criterion-model'],
        status: 'pass',
        artifactIds: ['artifact-1'],
        assertionIds: ['assertion-model'],
        verificationReceiptIds: ['receipt-model'],
      }),
    );
  }

  // Required human criteria still need eligible premises for preflight step 9;
  // verdict derivation keeps the criterion pending regardless.
  if (includeHuman) {
    observations.push(
      observation({
        observationId: 'observation-human',
        kind: 'mechanical',
        criterionIds: ['criterion-human'],
        status: 'pass',
        artifactIds: ['artifact-1'],
        assertionIds: ['assertion-model'],
        verificationReceiptIds: ['receipt-model'],
      }),
    );
  }

  // optional criterion intentionally has zero premises / observations

  if (includeSurfaceFail) {
    observations.push(
      observation({
        observationId: 'observation-surface',
        kind: 'real_surface',
        criterionIds: ['criterion-mechanical'],
        status: 'verified_fail',
        artifactIds: ['surface-1'],
        assertionIds: ['assertion-mechanical'],
        verificationReceiptIds: ['receipt-mechanical'],
      }),
    );
  }

  const verificationWithoutHash = {
    schema: 'hercules-verification-result/v1' as const,
    verificationResultId: 'verification-result-1',
    verifierRunId: 'verifier-1',
    taskId: contract.taskId,
    taskContractHash: contract.contractHash,
    iterationId: 'iteration-1',
    candidateCommit: COMMIT,
    manifestId: manifest.id,
    manifestHash: manifest.manifestHash,
    startedAt: '2026-08-29T00:00:00.000Z',
    completedAt: '2026-08-29T00:00:01.000Z',
    status: 'complete' as const,
    observations,
  };
  const verification: VerificationResultV1 = {
    ...verificationWithoutHash,
    resultHash: computeVerificationResultHash(verificationWithoutHash),
  };
  const attestation = integrityAttestation(manifest, artifacts);

  const evidenceBase = {
    schema: 'hercules-trusted-evaluation-evidence/v1' as const,
    sourceId: 'evidence-source-1',
    taskContract: contract,
    iterationId: 'iteration-1',
    candidateRef: candidateRef(),
    evidenceManifest: manifest,
    artifacts,
    verificationResult: verification,
    assertions,
    verificationReceipts: receipts,
    integrityAttestation: attestation,
    observedAt: '2026-08-29T00:00:06.000Z',
    freshUntil: '2026-08-29T01:00:00.000Z',
  };
  const evidenceIdentityHash = computeEvidenceIdentityHash(evidenceBase);
  const evidence: TrustedEvaluationEvidenceSnapshotV1 = {
    ...evidenceBase,
    evidenceIdentityHash,
    evidenceObservationHash: computeEvidenceObservationHash(
      evidenceIdentityHash,
      evidenceBase.observedAt,
      evidenceBase.freshUntil,
    ),
  };

  const rubricCriteria: EvaluationRubricCriterionV1[] = [
    criterion({
      criterionId: 'criterion-mechanical',
      authority: 'mechanical',
      required: true,
      requiredGateIds: ['gate-external-1'],
      requiredSurfaceIds: includeSurfaceFail ? ['surface-1'] : [],
    }),
  ];
  if (includeMechanicalModel) {
    rubricCriteria.push(
      criterion({
        criterionId: 'criterion-model',
        authority: 'mechanical',
        required: true,
        requiredGateIds: [],
        requiredSurfaceIds: [],
        evaluatorInstructionArtifactId: 'artifact-instruction-2',
        evaluatorInstructionArtifactHash: HASH_D,
      }),
    );
  }
  if (includeEvaluatorModel) {
    rubricCriteria.push(
      criterion({
        criterionId: 'criterion-model',
        authority: 'evaluator',
        required: true,
        requiredGateIds: [],
        requiredSurfaceIds: [],
        evaluatorInstructionArtifactId: 'artifact-instruction-2',
        evaluatorInstructionArtifactHash: HASH_D,
      }),
    );
  }
  if (includeHuman) {
    rubricCriteria.push(
      criterion({
        criterionId: 'criterion-human',
        authority: 'human',
        required: true,
        requiredGateIds: [],
        requiredSurfaceIds: [],
        evaluatorInstructionArtifactId: 'artifact-instruction-3',
        evaluatorInstructionArtifactHash: HASH_E,
      }),
    );
  }
  if (includeOptional) {
    rubricCriteria.push(
      criterion({
        criterionId: 'criterion-optional',
        authority: 'mechanical',
        required: false,
        requiredGateIds: [],
        requiredSurfaceIds: [],
        evaluatorInstructionArtifactId: 'artifact-instruction-4',
        evaluatorInstructionArtifactHash: HASH_E,
      }),
    );
  }

  const rubricRecord = rubric(contract, rubricCriteria);
  const definition = gateDefinition();
  const plan = gatePlan(contract, [definition]);
  const policyRecord = policy();
  const roles = runAuthority();
  const controlBase = {
    schema: 'hercules-trusted-evaluation-control/v1' as const,
    issuer: 'hercules-program-control' as const,
    authorityEpoch: 'epoch-1',
    policy: policyRecord,
    rubric: rubricRecord,
    gatePlan: plan,
    roles,
    observedAt: '2026-08-29T00:00:02.000Z',
  };
  const controlIdentityHash = computeControlIdentityHash(controlBase);
  const control: TrustedEvaluationControlSnapshotV1 = {
    ...controlBase,
    controlIdentityHash,
    controlObservationHash: computeControlObservationHash(
      controlIdentityHash,
      controlBase.observedAt,
    ),
  };

  const inputBase = {
    schema: 'hercules-independent-evaluation-input/v1' as const,
    requestId: 'request-1',
    taskContract: contract,
    iterationId: evidence.iterationId,
    candidateRef: evidence.candidateRef,
    evidenceManifest: evidence.evidenceManifest,
    artifacts: evidence.artifacts,
    verificationResult: evidence.verificationResult,
    assertions: evidence.assertions,
    verificationReceipts: evidence.verificationReceipts,
    integrityAttestation: evidence.integrityAttestation,
    policyRef: {
      schema: 'hercules-evaluation-policy-ref/v1' as const,
      policyId: 'hercules-v1-independent-evaluation' as const,
      version: policyRecord.version,
      policyHash: policyRecord.policyHash,
    },
    rubricRef: {
      schema: 'hercules-evaluation-rubric-ref/v1' as const,
      rubricId: rubricRecord.rubricId,
      version: rubricRecord.version,
      rubricHash: rubricRecord.rubricHash,
    },
    gatePlanRef: {
      schema: 'hercules-deterministic-gate-plan-ref/v1' as const,
      gatePlanId: plan.gatePlanId,
      version: plan.version,
      gatePlanHash: plan.gatePlanHash,
    },
    locatorHints: [] as const,
  };
  const input: IndependentEvaluationInputV1 = {
    ...inputBase,
    inputHash: computeInputHash(inputBase),
  };

  const receipt = gateReceipt(definition, plan, contract);
  return {
    input,
    control,
    evidence,
    gateReceipts: [receipt],
  };
}

function rebuildSubject(
  subject: PreflightSubjectV1,
  mutate: (draft: {
    input: IndependentEvaluationInputV1;
    control: TrustedEvaluationControlSnapshotV1;
    evidence: TrustedEvaluationEvidenceSnapshotV1;
    gateReceipts: DeterministicGateReceiptV1[];
  }) => void,
): PreflightSubjectV1 {
  const draft = {
    input: structuredClone(subject.input) as IndependentEvaluationInputV1,
    control: structuredClone(subject.control) as TrustedEvaluationControlSnapshotV1,
    evidence: structuredClone(subject.evidence) as TrustedEvaluationEvidenceSnapshotV1,
    gateReceipts: structuredClone(subject.gateReceipts) as DeterministicGateReceiptV1[],
  };
  mutate(draft);

  const controlIdentityHash = computeControlIdentityHash(draft.control);
  draft.control = {
    ...draft.control,
    controlIdentityHash,
    controlObservationHash: computeControlObservationHash(
      controlIdentityHash,
      draft.control.observedAt,
    ),
  };

  const evidenceIdentityHash = computeEvidenceIdentityHash(draft.evidence);
  draft.evidence = {
    ...draft.evidence,
    evidenceIdentityHash,
    evidenceObservationHash: computeEvidenceObservationHash(
      evidenceIdentityHash,
      draft.evidence.observedAt,
      draft.evidence.freshUntil,
    ),
  };

  const { inputHash: _drop, ...inputWithoutHash } = draft.input;
  draft.input = {
    ...inputWithoutHash,
    inputHash: computeInputHash(inputWithoutHash),
  };

  return draft;
}

function buildProposal(
  subject: PreflightSubjectV1,
  options: {
    readonly modelStatus: 'pass' | 'fail' | 'insufficient_evidence';
    readonly findings?: EvaluatorProposalV1['findings'];
    readonly modelPremises?: readonly string[];
    readonly mechanicalPremises?: readonly string[];
  },
): EvaluatorProposalV1 {
  const criterionProposals = subject.control.rubric.criteria.map((entry) => {
    if (entry.authority === 'evaluator') {
      return {
        criterionId: entry.criterionId,
        proposedStatus: options.modelStatus,
        premiseAssertionIds: sortedUnique(
          options.modelPremises ?? ['assertion-model'],
        ),
        advisoryRationale: `proposal for ${entry.criterionId}`,
      };
    }
    if (entry.authority === 'human') {
      return {
        criterionId: entry.criterionId,
        proposedStatus: 'insufficient_evidence' as const,
        premiseAssertionIds: [] as const,
        advisoryRationale: 'human pending',
      };
    }
    return {
      criterionId: entry.criterionId,
      proposedStatus: 'pass' as const,
      premiseAssertionIds: sortedUnique(
        options.mechanicalPremises ??
          (entry.criterionId === 'criterion-mechanical'
            ? ['assertion-mechanical']
            : ['assertion-model']),
      ),
      advisoryRationale: `deterministic ${entry.criterionId}`,
    };
  });

  const withoutHash = {
    schema: 'hercules-evaluator-proposal/v1' as const,
    requestId: subject.input.requestId,
    inputHash: subject.input.inputHash,
    evaluatorRunId: subject.control.roles.evaluatorRunId,
    evaluatorImplementationId: subject.control.roles.evaluatorImplementationId,
    proposalId: 'proposal-1',
    criterionProposals,
    findings: options.findings ?? [],
    declaredUnknowns: [] as const,
    remainingRisks: [] as const,
  };
  return {
    ...withoutHash,
    proposalHash: computeProposalHash(withoutHash),
  };
}

function sortedUnique(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)].sort();
}

const CLOCK_CAP = 'clock-1';
const CLOCK_EPOCH = 'clock-epoch-1';
const EVAL_CAP = 'evaluator-capability-1';

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeDispatch(
  signalId: string,
  attemptId: string,
  reason: EvaluationCancellationReasonV1,
  status: EvaluationCancellationDispatchV1['status'] = 'dispatched',
): EvaluationCancellationDispatchV1 {
  const withoutHash = {
    signalId,
    attemptId,
    reason,
    status,
    dispatchedAt: '2026-08-29T00:00:10.000Z',
  };
  return {
    ...withoutHash,
    dispatchHash: computeCancellationDispatchHash(withoutHash),
  };
}

function makeController(
  signalId: string,
  attemptId: string,
): EvaluationCancellationControllerV1 {
  let cancelled: EvaluationCancellationReasonV1 | null = null;
  const listeners = new Set<(reason: EvaluationCancellationReasonV1) => void>();
  const signal: EvaluationCancellationSignalV1 = {
    signalId,
    attemptId,
    isCancelled: () => cancelled !== null,
    onCancel: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    signal,
    cancel: (reason) => {
      if (cancelled !== null) {
        return makeDispatch(signalId, attemptId, reason, 'already_cancelled');
      }
      cancelled = reason;
      for (const listener of listeners) {
        listener(reason);
      }
      return makeDispatch(signalId, attemptId, reason, 'dispatched');
    },
  };
}

function makeFactory(): TrustedEvaluationCancellationFactoryV1 {
  let attemptSeq = 0;
  return {
    createAttempt: () => {
      attemptSeq += 1;
      const attemptId = `attempt-${attemptSeq}`;
      return {
        attemptId,
        evaluatorController: makeController(`signal-evaluator-${attemptSeq}`, attemptId),
        deadlineController: makeController(`signal-deadline-${attemptSeq}`, attemptId),
      };
    },
  };
}

function evaluatorAuthorityFor(
  roles: EvaluationRunAuthorityV1,
): TrustedEvaluatorAuthoritySnapshotV1 {
  const withoutHash = {
    schema: 'hercules-trusted-evaluator-authority/v1' as const,
    issuer: 'hercules-program-control' as const,
    authorityEpoch: roles.authorityEpoch,
    evaluatorRunId: roles.evaluatorRunId,
    evaluatorImplementationId: roles.evaluatorImplementationId,
    evaluatorCapabilityId: EVAL_CAP,
    freshContextId: roles.freshContextId,
    issuedAt: '2026-08-29T00:00:00.000Z',
    expiresAt: roles.expiresAt,
  };
  return {
    ...withoutHash,
    authorityHash: computeEvaluatorAuthorityHash(withoutHash),
  };
}

function runtimeIdentity(): TrustedEvaluationRuntimeCapabilityIdentityV1 {
  const withoutHash = {
    schema: 'hercules-trusted-evaluation-runtime-capabilities/v1' as const,
    evaluatorCapabilityId: EVAL_CAP,
    gateResolverCapabilityId: 'gate-resolver-1',
    deadlineCapabilityId: 'deadline-1',
    cancellationFactoryCapabilityId: 'cancellation-factory-1',
    clockCapabilityId: CLOCK_CAP,
    clockEpochId: CLOCK_EPOCH,
  };
  return {
    ...withoutHash,
    capabilitySetHash: computeCapabilitySetHash(withoutHash),
  };
}

function manualClock(times: string[]): EvaluationClockV1 & {
  readonly remaining: () => number;
  readonly callCount: () => number;
} {
  const queue = [...times];
  let calls = 0;
  return {
    capabilityId: CLOCK_CAP,
    epochId: CLOCK_EPOCH,
    remaining: () => queue.length,
    callCount: () => calls,
    nowUtc(): string {
      calls += 1;
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('manual clock exhausted');
      }
      return next;
    },
  };
}

function bumpControlPolicy(
  control: TrustedEvaluationControlSnapshotV1,
): TrustedEvaluationControlSnapshotV1 {
  const bumped = policy({
    version: control.policy.version + 1,
    expiresAt: control.policy.expiresAt,
  });
  const base = {
    schema: control.schema,
    issuer: control.issuer,
    authorityEpoch: control.authorityEpoch,
    policy: bumped,
    rubric: control.rubric,
    gatePlan: control.gatePlan,
    roles: control.roles,
    observedAt: control.observedAt,
  };
  const controlIdentityHash = computeControlIdentityHash(base);
  return {
    ...base,
    controlIdentityHash,
    controlObservationHash: computeControlObservationHash(
      controlIdentityHash,
      base.observedAt,
    ),
  };
}

function defaultClockTimes(count = 24): string[] {
  const times: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const totalSec = 10 + i;
    const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const ss = String(totalSec % 60).padStart(2, '0');
    times.push(`2026-08-29T00:${mm}:${ss}.000Z`);
  }
  return times;
}

interface Harness {
  readonly coordinator: ReturnType<typeof createIndependentEvaluationCoordinator>;
  readonly subject: PreflightSubjectV1;
  readonly clock: ReturnType<typeof manualClock>;
  readonly pendingEvaluator: ReturnType<typeof deferred<EvaluatorProposalV1>>;
  readonly counts: () => {
    controlCalls: number;
    evidenceCalls: number;
    authorityCalls: number;
    gateCalls: number;
    evaluatorCalls: number;
  };
  pushControl: (next: TrustedEvaluationControlSnapshotV1) => void;
  setDefaultControl: (next: TrustedEvaluationControlSnapshotV1) => void;
  setEvaluator: (impl: IndependentEvaluatorPortV1['evaluate']) => void;
  rejectControlOnce: (error: Error) => void;
}

function createHarness(options: {
  readonly subject: PreflightSubjectV1;
  readonly clockTimes: string[];
  readonly maxReservations?: number;
  readonly evaluatorModel?: string | null;
  readonly deferEvaluator?: boolean;
}): Harness {
  const subject = options.subject;
  const controlQueue: TrustedEvaluationControlSnapshotV1[] = [];
  let defaultControl = subject.control;
  const evidence = subject.evidence;
  const gateReceipts = [...subject.gateReceipts];
  let pendingControlReject: Error | null = null;

  let controlCalls = 0;
  let evidenceCalls = 0;
  let authorityCalls = 0;
  let gateCalls = 0;
  let evaluatorCalls = 0;

  let lastControlRoles = subject.control.roles;
  const sources: TrustedEvaluationSourcesV1 = {
    resolveControl: async () => {
      controlCalls += 1;
      if (pendingControlReject !== null) {
        const error = pendingControlReject;
        pendingControlReject = null;
        throw error;
      }
      const queued = controlQueue.shift();
      const snapshot = queued ?? defaultControl;
      lastControlRoles = snapshot.roles;
      return snapshot;
    },
    resolveEvidence: async () => {
      evidenceCalls += 1;
      return evidence;
    },
    resolveEvaluatorAuthority: async () => {
      authorityCalls += 1;
      return evaluatorAuthorityFor(lastControlRoles);
    },
  };

  const gateRunner = {
    resolveCurrentReceipts: async (_query: CurrentGateReceiptQueryV1) => {
      gateCalls += 1;
      return gateReceipts;
    },
  };

  const pendingEvaluator = deferred<EvaluatorProposalV1>();
  let evaluatorImpl: IndependentEvaluatorPortV1['evaluate'] = async () => {
    return buildProposal(subject, { modelStatus: 'pass' });
  };
  if (options.deferEvaluator) {
    evaluatorImpl = async () => pendingEvaluator.promise;
  }

  const evaluatorPort: IndependentEvaluatorPortV1 = {
    evaluate: async (request, cancellation) => {
      evaluatorCalls += 1;
      return evaluatorImpl(request, cancellation);
    },
  };

  const deadline: EvaluationDeadlinePortV1 = {
    expireAfter: async () =>
      await new Promise<'deadline_expired'>(() => {
        /* hang until peer cancel; runEvaluatorAttempt does not await after peer settles */
      }),
  };

  const clock = manualClock(options.clockTimes);
  const capabilities: TrustedEvaluationRuntimeCapabilitiesV1 = {
    identity: runtimeIdentity(),
    sources,
    gateRunner,
    evaluatorPort,
    deadline,
    cancellationFactory: makeFactory(),
    clock,
    coordinatorRunId: subject.control.roles.coordinatorRunId,
    evaluatorVersion: 'evaluator-v1',
    evaluatorModel:
      options.evaluatorModel === undefined ? 'test-model' : options.evaluatorModel,
    evaluatorRuntime: 'test-runtime',
  };

  const coordinator = createIndependentEvaluationCoordinator(
    capabilities,
    options.maxReservations !== undefined
      ? { maxReservations: options.maxReservations }
      : undefined,
  );

  return {
    coordinator,
    subject,
    clock,
    pendingEvaluator,
    counts: () => ({
      controlCalls,
      evidenceCalls,
      authorityCalls,
      gateCalls,
      evaluatorCalls,
    }),
    pushControl: (next) => {
      controlQueue.push(next);
    },
    setDefaultControl: (next) => {
      defaultControl = next;
      lastControlRoles = next.roles;
    },
    setEvaluator: (impl) => {
      evaluatorImpl = impl;
    },
    rejectControlOnce: (error) => {
      pendingControlReject = error;
    },
  };
}

describe('createIndependentEvaluationCoordinator', () => {
  it('deterministic-pass path → receipt, branded; JSON clone not qualified', async () => {
    const subject = buildSubject({ kind: 'all_deterministic' });
    const harness = createHarness({
      subject,
      clockTimes: defaultClockTimes(),
      evaluatorModel: null,
    });
    const outcome = await harness.coordinator.evaluate(subject.input);
    expect(outcome.kind).toBe('receipt');
    if (outcome.kind !== 'receipt') {
      return;
    }
    expect(outcome.receipt.noProposalReason).toBe('deterministic_pass');
    expect(outcome.receipt.proposalHash).toBeNull();
    expect(outcome.receipt.verdict.outcome).toBe('pass');
    expect(() => assertIndependentEvaluationReceiptV1(outcome.receipt)).not.toThrow();
    expect(harness.coordinator.isAuthorityQualified(outcome.receipt)).toBe(true);
    const cloned = JSON.parse(
      JSON.stringify(outcome.receipt),
    ) as IndependentEvaluationReceiptV1;
    expect(harness.coordinator.isAuthorityQualified(cloned)).toBe(false);
    expect(harness.counts().evaluatorCalls).toBe(0);
  });

  it('model path with valid proposal → proposalHash set and peer_settled dispatch', async () => {
    const subject = buildSubject({ kind: 'model_pass' });
    const harness = createHarness({
      subject,
      clockTimes: defaultClockTimes(),
    });
    const outcome = await harness.coordinator.evaluate(subject.input);
    expect(outcome.kind).toBe('receipt');
    if (outcome.kind !== 'receipt') {
      return;
    }
    expect(outcome.receipt.proposalHash).not.toBeNull();
    expect(outcome.receipt.noProposalReason).toBeNull();
    expect(outcome.receipt.verdict.outcome).toBe('pass');
    expect(
      outcome.receipt.cancellationDispatches.some((d) => d.reason === 'peer_settled'),
    ).toBe(true);
    expect(harness.counts().evaluatorCalls).toBe(1);
  });

  it('model path infrastructure failure → evidence_gap with evaluator_unavailable', async () => {
    const subject = buildSubject({ kind: 'model_pass' });
    const harness = createHarness({
      subject,
      clockTimes: defaultClockTimes(),
    });
    harness.setEvaluator(async () => {
      throw new Error('provider down');
    });
    const outcome = await harness.coordinator.evaluate(subject.input);
    expect(outcome.kind).toBe('receipt');
    if (outcome.kind !== 'receipt') {
      return;
    }
    expect(outcome.receipt.noProposalReason).toBe('evidence_gap');
    expect(outcome.receipt.proposalHash).toBeNull();
    expect(outcome.receipt.verdict.outcome).toBe('need_more_evidence');
    expect(outcome.receipt.verdict.recommendedNextStage).toBe('reverify');
    expect(outcome.receipt.outcomeReasonCodes).toEqual([
      'evaluator_unavailable',
      'insufficient_evidence',
    ]);
    expect(
      outcome.receipt.verdict.criterionResults
        .filter((r) => r.authority === 'evaluator')
        .every((r) => r.status === 'insufficient_evidence'),
    ).toBe(true);
  });

  it('post-evaluation control change → gap control_changed; memoized; proposal not reused', async () => {
    const subject = buildSubject({ kind: 'model_pass' });
    const harness = createHarness({
      subject,
      clockTimes: defaultClockTimes(),
    });
    // First resolve: original. Second resolve: bumped policy (different identity).
    harness.pushControl(subject.control);
    harness.pushControl(bumpControlPolicy(subject.control));
    const first = await harness.coordinator.evaluate(subject.input);
    expect(first.kind).toBe('gap');
    if (first.kind !== 'gap') {
      return;
    }
    expect(first.gap.reason).toBe('control_changed');
    expect(first.gap.proposalDiscarded).toBe(true);
    expect(harness.counts().evaluatorCalls).toBe(1);

    // Restore default control and replay same requestId/stable key from first acceptance.
    // Reservation is under the accepted (original) stable hash; replay reconsults sources.
    harness.setDefaultControl(subject.control);
    const before = harness.counts();
    const second = await harness.coordinator.evaluate(subject.input);
    expect(second).toBe(first);
    expect(harness.counts().controlCalls).toBeGreaterThan(before.controlCalls);
    expect(harness.counts().evaluatorCalls).toBe(1);
  });

  it('clock moved backwards between resolutions → gap clock_moved_backwards', async () => {
    const subject = buildSubject({ kind: 'all_deterministic' });
    const harness = createHarness({
      subject,
      clockTimes: [
        '2026-08-29T00:00:20.000Z',
        '2026-08-29T00:00:15.000Z',
        ...defaultClockTimes(8),
      ],
      evaluatorModel: null,
    });
    const outcome = await harness.coordinator.evaluate(subject.input);
    expect(outcome.kind).toBe('gap');
    if (outcome.kind !== 'gap') {
      return;
    }
    expect(outcome.gap.reason).toBe('clock_moved_backwards');
  });

  it('expiry crossed during evaluation → gap freshness_expired', async () => {
    const subject = buildSubject({ kind: 'all_deterministic' });
    // evidence/gate freshUntil is 2026-08-29T01:00:00.000Z
    const harness = createHarness({
      subject,
      clockTimes: [
        '2026-08-29T00:00:20.000Z',
        '2026-08-29T01:00:01.000Z',
        ...defaultClockTimes(8),
      ],
      evaluatorModel: null,
    });
    const outcome = await harness.coordinator.evaluate(subject.input);
    expect(outcome.kind).toBe('gap');
    if (outcome.kind !== 'gap') {
      return;
    }
    expect(outcome.gap.reason).toBe('freshness_expired');
  });

  it('replay returns the same frozen receipt object; evaluator not recalled', async () => {
    const subject = buildSubject({ kind: 'model_pass' });
    const harness = createHarness({
      subject,
      clockTimes: defaultClockTimes(),
    });
    const first = await harness.coordinator.evaluate(subject.input);
    expect(first.kind).toBe('receipt');
    const mid = harness.counts();
    const second = await harness.coordinator.evaluate(subject.input);
    expect(second).toBe(first);
    expect(harness.counts().evaluatorCalls).toBe(1);
    expect(harness.counts().controlCalls).toBeGreaterThan(mid.controlCalls);
    expect(harness.counts().gateCalls).toBeGreaterThan(mid.gateCalls);
    expect(harness.clock.callCount()).toBeGreaterThan(2);
  });

  it('changed control between calls → idempotency_conflict', async () => {
    const subject = buildSubject({ kind: 'all_deterministic' });
    const harness = createHarness({
      subject,
      clockTimes: defaultClockTimes(),
      evaluatorModel: null,
    });
    const first = await harness.coordinator.evaluate(subject.input);
    expect(first.kind).toBe('receipt');
    harness.setDefaultControl(bumpControlPolicy(subject.control));
    const second = await harness.coordinator.evaluate(subject.input);
    expect(second.kind).toBe('conflict');
    if (second.kind !== 'conflict') {
      return;
    }
    expect(second.code).toBe('idempotency_conflict');
  });

  it('concurrent equal-key evaluates share one outcome and one evaluator invocation', async () => {
    const subject = buildSubject({ kind: 'model_pass' });
    const harness = createHarness({
      subject,
      clockTimes: defaultClockTimes(),
      deferEvaluator: true,
    });
    const p1 = harness.coordinator.evaluate(subject.input);
    const p2 = harness.coordinator.evaluate(subject.input);
    // Wait until the shared in-flight evaluation has invoked the evaluator port.
    for (let i = 0; i < 50 && harness.counts().evaluatorCalls < 1; i += 1) {
      await Promise.resolve();
    }
    expect(harness.counts().evaluatorCalls).toBe(1);
    harness.pendingEvaluator.resolve(buildProposal(subject, { modelStatus: 'pass' }));
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(b);
    expect(a.kind).toBe('receipt');
    expect(harness.counts().evaluatorCalls).toBe(1);
  });

  it('capacity: second distinct request → coordinator_capacity; evaluator not called', async () => {
    const subjectA = buildSubject({ kind: 'all_deterministic' });
    const subjectB = rebuildSubject(subjectA, (draft) => {
      draft.input = {
        ...draft.input,
        requestId: 'request-2',
      };
      const { inputHash: _drop, ...rest } = draft.input;
      draft.input = {
        ...rest,
        inputHash: computeInputHash(rest),
      };
    });
    const harness = createHarness({
      subject: subjectA,
      clockTimes: defaultClockTimes(),
      maxReservations: 1,
      evaluatorModel: null,
    });
    const first = await harness.coordinator.evaluate(subjectA.input);
    expect(first.kind).toBe('receipt');
    const before = harness.counts().evaluatorCalls;
    const second = await harness.coordinator.evaluate(subjectB.input);
    expect(second.kind).toBe('capacity');
    if (second.kind !== 'capacity') {
      return;
    }
    expect(second.code).toBe('coordinator_capacity');
    expect(harness.counts().evaluatorCalls).toBe(before);
  });

  it('pre-acceptance source failure → unavailable; nothing memoized', async () => {
    const subject = buildSubject({ kind: 'all_deterministic' });
    const harness = createHarness({
      subject,
      clockTimes: defaultClockTimes(),
      evaluatorModel: null,
    });
    harness.rejectControlOnce(new Error('control source down'));
    const failed = await harness.coordinator.evaluate(subject.input);
    expect(failed.kind).toBe('unavailable');
    const recovered = await harness.coordinator.evaluate(subject.input);
    expect(recovered.kind).toBe('receipt');
  });

  it('restoreQualifiedReceipt succeeds across coordinators; fails after control change or tamper', async () => {
    const subject = buildSubject({ kind: 'all_deterministic' });
    const harnessA = createHarness({
      subject,
      clockTimes: defaultClockTimes(),
      evaluatorModel: null,
    });
    const outcome = await harnessA.coordinator.evaluate(subject.input);
    expect(outcome.kind).toBe('receipt');
    if (outcome.kind !== 'receipt') {
      return;
    }

    const harnessB = createHarness({
      subject,
      clockTimes: defaultClockTimes(),
      evaluatorModel: null,
    });
    const reconstruction = { input: subject.input, proposal: null } as const;
    const restored = await harnessB.coordinator.restoreQualifiedReceipt(
      outcome.receipt,
      reconstruction,
    );
    expect(restored.restored).toBe(true);
    expect(harnessB.coordinator.isAuthorityQualified(outcome.receipt)).toBe(true);

    harnessB.setDefaultControl(bumpControlPolicy(subject.control));
    const afterChange = await harnessB.coordinator.restoreQualifiedReceipt(
      outcome.receipt,
      reconstruction,
    );
    expect(afterChange.restored).toBe(false);
    expect(afterChange.reason).toMatch(/control/i);

    const { receiptHash: _drop, ...rest } = outcome.receipt;
    // Flip a bound control identity byte and recompute the outer receipt hash so
    // structural validation can pass while restore binding checks fail.
    const flippedIdentity =
      rest.controlIdentityHash.slice(0, -1) +
      (rest.controlIdentityHash.endsWith('a') ? 'b' : 'a');
    const tamperedWithoutHash = {
      ...rest,
      controlIdentityHash: flippedIdentity,
    };
    const tampered: IndependentEvaluationReceiptV1 = {
      ...tamperedWithoutHash,
      receiptHash: computeEvaluationReceiptHash(tamperedWithoutHash),
    };
    const harnessC = createHarness({
      subject,
      clockTimes: defaultClockTimes(),
      evaluatorModel: null,
    });
    const tamperResult = await harnessC.coordinator.restoreQualifiedReceipt(
      tampered,
      { input: subject.input, proposal: null },
    );
    expect(tamperResult.restored).toBe(false);
    expect(tamperResult.reason).toMatch(/controlIdentityHash/i);
  });

  it('restoreQualifiedReceipt rejects a forged pass verdict under intact bindings', async () => {
    // surface_verified_fail derives a genuine `fail` verdict, so forging
    // `pass` is a real change the re-derivation must reject.
    const subject = buildSubject({ kind: 'surface_verified_fail' });
    const harnessA = createHarness({
      subject,
      clockTimes: defaultClockTimes(),
      evaluatorModel: null,
    });
    const outcome = await harnessA.coordinator.evaluate(subject.input);
    expect(outcome.kind).toBe('receipt');
    if (outcome.kind !== 'receipt') {
      return;
    }
    expect(outcome.receipt.verdict.outcome).not.toBe('pass');
    // Forge a pass verdict while keeping every binding hash intact, and
    // recompute verdictHash + receiptHash so structural validation passes.
    const forgedVerdict = { ...outcome.receipt.verdict, outcome: 'pass' as const };
    const { receiptHash: _drop, ...rest } = outcome.receipt;
    const forgedWithoutHash = {
      ...rest,
      verdict: forgedVerdict,
      verdictHash: computeVerdictHash(forgedVerdict),
    };
    const forged: IndependentEvaluationReceiptV1 = {
      ...forgedWithoutHash,
      receiptHash: computeEvaluationReceiptHash(forgedWithoutHash),
    };
    const harnessB = createHarness({
      subject,
      clockTimes: defaultClockTimes(),
      evaluatorModel: null,
    });
    const forgedResult = await harnessB.coordinator.restoreQualifiedReceipt(forged, {
      input: subject.input,
      proposal: null,
    });
    expect(forgedResult.restored).toBe(false);
    expect(forgedResult.reason).toMatch(/verdict/i);
    expect(harnessB.coordinator.isAuthorityQualified(forged)).toBe(false);
  });

  it('refuses to restore a receipt that consumed an evaluator proposal', async () => {
    // A genuine model-path receipt carries proposalHash !== null. Its verdict
    // depends on non-deterministic evaluator output that restore cannot
    // re-authenticate, so restore must refuse it outright — otherwise a
    // fabricated pass proposal could mint an authority-qualified pass.
    const subject = buildSubject({ kind: 'model_pass' });
    const harnessA = createHarness({
      subject,
      clockTimes: defaultClockTimes(),
      evaluatorModel: 'grok-4.5',
    });
    const outcome = await harnessA.coordinator.evaluate(subject.input);
    expect(outcome.kind).toBe('receipt');
    if (outcome.kind !== 'receipt') {
      return;
    }
    expect(outcome.receipt.proposalHash).not.toBeNull();
    const harnessB = createHarness({
      subject,
      clockTimes: defaultClockTimes(),
      evaluatorModel: 'grok-4.5',
    });
    const result = await harnessB.coordinator.restoreQualifiedReceipt(
      outcome.receipt,
      { input: subject.input, proposal: null },
    );
    expect(result.restored).toBe(false);
    expect(result.reason).toMatch(/proposal/i);
    expect(harnessB.coordinator.isAuthorityQualified(outcome.receipt)).toBe(false);
  });

  it('deep-freezes the branded receipt so nested state cannot be mutated', async () => {
    const subject = buildSubject({ kind: 'all_deterministic' });
    const harness = createHarness({
      subject,
      clockTimes: defaultClockTimes(),
      evaluatorModel: null,
    });
    const outcome = await harness.coordinator.evaluate(subject.input);
    expect(outcome.kind).toBe('receipt');
    if (outcome.kind !== 'receipt') {
      return;
    }
    expect(Object.isFrozen(outcome.receipt)).toBe(true);
    expect(Object.isFrozen(outcome.receipt.verdict)).toBe(true);
    expect(Object.isFrozen(outcome.receipt.verdict.criterionResults)).toBe(true);
    expect(() => {
      (outcome.receipt.verdict as { outcome: string }).outcome = 'fail';
    }).toThrow(TypeError);
  });
});
