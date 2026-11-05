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
  IndependentEvaluationError,
  computeControlIdentityHash,
  computeControlObservationHash,
  computeEvaluationPolicyHash,
  computeEvaluationRubricHash,
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
  type DeterministicGateDefinitionV1,
  type DeterministicGatePlanV1,
  type DeterministicGateReceiptV1,
  type EvaluationPolicyV1,
  type EvaluationRubricCriterionV1,
  type EvaluationRubricV1,
  type EvaluationRunAuthorityV1,
  type EvaluatorProposalV1,
  type IndependentEvaluationInputV1,
  type TrustedEvaluationControlSnapshotV1,
  type TrustedEvaluationEvidenceSnapshotV1,
  type VerificationObservationV1,
  type VerificationResultV1,
} from '../../src/domain/independentEvaluation.js';
import {
  runDeterministicPreflight,
  type PreflightSubjectV1,
} from '../../src/evaluation/deterministicPreflight.js';
import {
  collectCriterionPremises,
  deriveVerdict,
} from '../../src/evaluation/verdictPolicy.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const HASH_C =
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const HASH_D =
  'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const HASH_E =
  'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const CREATED_AT = '2026-08-29T00:01:00.000Z';

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

function deriveArgs(
  subject: PreflightSubjectV1,
  proposal: EvaluatorProposalV1 | null,
  verdictId = 'verdict-1',
) {
  const preflight = runDeterministicPreflight(subject);
  return {
    input: subject.input,
    control: subject.control,
    evidence: subject.evidence,
    preflight,
    proposal,
    verdictId,
    createdAt: CREATED_AT,
    evaluatorVersion: 'evaluator-v1',
    evaluatorModel: proposal === null ? null : 'test-model',
    evaluatorRuntime: 'test-runtime',
  };
}

describe('collectCriterionPremises', () => {
  it('unions observation and receipt assertion ids for a criterion', () => {
    const subject = buildSubject({ kind: 'all_deterministic' });
    expect(collectCriterionPremises(subject.evidence, 'criterion-mechanical')).toEqual([
      'assertion-mechanical',
    ]);
    expect(collectCriterionPremises(subject.evidence, 'criterion-model')).toEqual([
      'assertion-model',
    ]);
    expect(collectCriterionPremises(subject.evidence, 'criterion-missing')).toEqual([]);
  });
});

describe('deriveVerdict', () => {
  it('all-deterministic rubric + preflight pass → pass / complete / no evaluator run id', () => {
    const subject = buildSubject({ kind: 'all_deterministic' });
    const args = deriveArgs(subject, null);
    expect(args.preflight.classification).toBe('pass');
    const derived = deriveVerdict(args);
    expect(derived.verdict.outcome).toBe('pass');
    expect(derived.verdict.recommendedNextStage).toBe('complete');
    expect(derived.verdict.evaluatorAgentRunId).toBeNull();
    expect(derived.outcomeReasonCodes).toEqual(['all_required_criteria_pass']);
    expect(
      derived.verdict.criterionResults.every((result) => result.status === 'pass'),
    ).toBe(true);
  });

  it('model criterion + valid all-pass proposal → pass', () => {
    const subject = buildSubject({ kind: 'model_pass' });
    const proposal = buildProposal(subject, { modelStatus: 'pass' });
    const args = deriveArgs(subject, proposal);
    expect(args.preflight.classification).toBe('model_judgment_required');
    const derived = deriveVerdict(args);
    expect(derived.verdict.outcome).toBe('pass');
    expect(derived.verdict.recommendedNextStage).toBe('complete');
    expect(derived.verdict.evaluatorAgentRunId).toBe('evaluator-1');
    expect(derived.outcomeReasonCodes).toEqual(['all_required_criteria_pass']);
    expect(
      derived.verdict.criterionResults.find((result) => result.criterionId === 'criterion-model')
        ?.status,
    ).toBe('pass');
  });

  it('proposal fail with eligible-premise-backed blocking finding → fail / repair', () => {
    const subject = buildSubject({ kind: 'model_fail_with_blocking' });
    const proposal = buildProposal(subject, {
      modelStatus: 'fail',
      findings: [
        {
          findingCode: 'soundness-block',
          severity: 'blocking',
          criterionIds: ['criterion-model'],
          assertionIds: ['assertion-model'],
          advisoryRationale: 'Change is not sound under verified premises.',
        },
      ],
    });
    const args = deriveArgs(subject, proposal);
    const derived = deriveVerdict(args);
    expect(derived.verdict.outcome).toBe('fail');
    expect(derived.verdict.recommendedNextStage).toBe('repair');
    expect(derived.outcomeReasonCodes).toEqual([
      'blocking_finding',
      'required_criterion_failed',
    ]);
    expect(
      derived.verdict.criterionResults.find((result) => result.criterionId === 'criterion-model')
        ?.status,
    ).toBe('fail');
    expect(derived.verdict.blockingFindings).toEqual([
      {
        code: 'soundness-block',
        summary: 'Change is not sound under verified premises.',
        criterionIds: ['criterion-model'],
      },
    ]);
  });

  it('proposal fail without blocking finding → insufficient_evidence → need_more_evidence', () => {
    const subject = buildSubject({ kind: 'model_pass' });
    const proposal = buildProposal(subject, { modelStatus: 'fail', findings: [] });
    const args = deriveArgs(subject, proposal);
    const derived = deriveVerdict(args);
    expect(
      derived.verdict.criterionResults.find((result) => result.criterionId === 'criterion-model')
        ?.status,
    ).toBe('insufficient_evidence');
    expect(derived.verdict.outcome).toBe('need_more_evidence');
    expect(derived.verdict.recommendedNextStage).toBe('reverify');
    expect(derived.outcomeReasonCodes).toEqual(['insufficient_evidence']);
    expect(derived.verdict.blockingFindings).toEqual([]);
  });

  it('proposal pass citing ineligible premise → criterion insufficient_evidence', () => {
    const subject = buildSubject({ kind: 'model_pass' });
    const valid = buildProposal(subject, { modelStatus: 'pass' });
    // Mutate after construction: cite a premise not in the eligible set.
    const { proposalHash: _drop, ...rest } = valid;
    const criterionProposals = rest.criterionProposals.map((entry) =>
      entry.criterionId === 'criterion-model'
        ? {
            ...entry,
            premiseAssertionIds: ['assertion-not-eligible'],
          }
        : entry,
    );
    const proposal: EvaluatorProposalV1 = {
      ...rest,
      criterionProposals,
      proposalHash: computeProposalHash({ ...rest, criterionProposals }),
    };
    const args = deriveArgs(subject, proposal);
    const derived = deriveVerdict(args);
    expect(
      derived.verdict.criterionResults.find((result) => result.criterionId === 'criterion-model')
        ?.status,
    ).toBe('insufficient_evidence');
    expect(derived.verdict.outcome).toBe('need_more_evidence');
    expect(derived.outcomeReasonCodes).toEqual(['insufficient_evidence']);
  });

  it('blocking finding with ineligible assertion degrades to nonBlockingRisks with -ineligible', () => {
    const subject = buildSubject({ kind: 'model_pass' });
    const proposal = buildProposal(subject, {
      modelStatus: 'pass',
      findings: [
        {
          findingCode: 'risk-block',
          severity: 'blocking',
          criterionIds: ['criterion-model'],
          assertionIds: ['assertion-not-eligible'],
          advisoryRationale: 'Would block if premises were eligible.',
        },
        {
          findingCode: 'note-advisory',
          severity: 'advisory',
          criterionIds: ['criterion-model'],
          assertionIds: ['assertion-model'],
          advisoryRationale: 'Advisory only.',
        },
      ],
    });
    const args = deriveArgs(subject, proposal);
    const derived = deriveVerdict(args);
    expect(derived.verdict.blockingFindings).toEqual([]);
    expect(derived.verdict.nonBlockingRisks.map((finding) => finding.code).sort()).toEqual([
      'note-advisory',
      'risk-block-ineligible',
    ]);
    expect(
      derived.verdict.nonBlockingRisks.find((finding) => finding.code === 'risk-block-ineligible')
        ?.summary,
    ).toMatch(/degraded: ineligible/);
    // Model still passes; ineligible blocking does not become a verdict blocker.
    expect(derived.verdict.outcome).toBe('pass');
  });

  it('required human criterion pending → need_more_evidence + escalate_human', () => {
    const subject = buildSubject({ kind: 'human_pending' });
    const proposal = buildProposal(subject, { modelStatus: 'pass' });
    const args = deriveArgs(subject, proposal);
    expect(args.preflight.classification).toBe('model_judgment_required');
    const derived = deriveVerdict(args);
    expect(
      derived.verdict.criterionResults.find((result) => result.criterionId === 'criterion-human')
        ?.status,
    ).toBe('pending');
    expect(derived.verdict.outcome).toBe('need_more_evidence');
    expect(derived.verdict.recommendedNextStage).toBe('escalate_human');
    expect(derived.outcomeReasonCodes).toEqual(['human_criterion_pending']);
  });

  it('preflight verified_fail naming a required criterion → fail with that criterion fail', () => {
    const subject = buildSubject({ kind: 'surface_verified_fail' });
    const args = deriveArgs(subject, null);
    expect(args.preflight.classification).toBe('verified_fail');
    const last = args.preflight.checks[args.preflight.checks.length - 1];
    expect(last?.criterionIds).toContain('criterion-mechanical');
    const derived = deriveVerdict(args);
    expect(
      derived.verdict.criterionResults.find(
        (result) => result.criterionId === 'criterion-mechanical',
      )?.status,
    ).toBe('fail');
    expect(derived.verdict.outcome).toBe('fail');
    expect(derived.verdict.recommendedNextStage).toBe('repair');
    expect(derived.outcomeReasonCodes).toEqual(['required_criterion_failed']);
    expect(derived.verdict.evaluatorAgentRunId).toBeNull();
  });

  it('preflight verified_fail with empty criterionIds still yields fail, never pass', () => {
    // A trusted external gate receipt verified_fail stops preflight at step 7
    // with an empty criterionIds. The verdict must remain fail (deterministic
    // verified failure outranks any evidence gap) and can never soften to pass.
    const subject = buildSubject({ kind: 'surface_verified_fail' });
    const baseArgs = deriveArgs(subject, null);
    const gateShapedChecks = baseArgs.preflight.checks.map((check, index) =>
      index === baseArgs.preflight.checks.length - 1
        ? { ...check, criterionIds: [] }
        : check,
    );
    const args = {
      ...baseArgs,
      preflight: { ...baseArgs.preflight, checks: gateShapedChecks },
    };
    expect(args.preflight.classification).toBe('verified_fail');
    const derived = deriveVerdict(args);
    expect(derived.verdict.outcome).toBe('fail');
    expect(derived.verdict.recommendedNextStage).toBe('repair');
    expect(derived.outcomeReasonCodes).toContain('deterministic_gate_failed');
  });

  it('preflight need_more_evidence, no proposal → need_more_evidence / reverify', () => {
    const base = buildSubject({ kind: 'all_deterministic' });
    const subject = rebuildSubject(base, (draft) => {
      draft.gateReceipts = [];
    });
    const args = deriveArgs(subject, null);
    expect(args.preflight.classification).toBe('need_more_evidence');
    const derived = deriveVerdict(args);
    expect(derived.verdict.outcome).toBe('need_more_evidence');
    expect(derived.verdict.recommendedNextStage).toBe('reverify');
    expect(derived.outcomeReasonCodes).toEqual(['insufficient_evidence']);
  });

  it('non-required criterion with zero premises → insufficient_evidence without dragging pass', () => {
    const subject = buildSubject({ kind: 'optional_insufficient' });
    const args = deriveArgs(subject, null);
    expect(args.preflight.classification).toBe('pass');
    const derived = deriveVerdict(args);
    expect(
      derived.verdict.criterionResults.find(
        (result) => result.criterionId === 'criterion-optional',
      )?.status,
    ).toBe('insufficient_evidence');
    expect(derived.verdict.outcome).toBe('pass');
    expect(derived.verdict.recommendedNextStage).toBe('complete');
    expect(derived.outcomeReasonCodes).toEqual(['all_required_criteria_pass']);
  });

  it('is deterministic for identical args', () => {
    const subject = buildSubject({ kind: 'model_pass' });
    const proposal = buildProposal(subject, {
      modelStatus: 'pass',
      findings: [
        {
          findingCode: 'note-advisory',
          severity: 'advisory',
          criterionIds: ['criterion-model'],
          assertionIds: ['assertion-model'],
          advisoryRationale: 'Advisory note.',
        },
      ],
    });
    const args = deriveArgs(subject, proposal);
    const first = deriveVerdict(args);
    const second = deriveVerdict(args);
    expect(hashCanonicalJson(second.verdict)).toBe(hashCanonicalJson(first.verdict));
    expect(hashCanonicalJson(second.criterionRelationships)).toBe(
      hashCanonicalJson(first.criterionRelationships),
    );
    expect(second.outcomeReasonCodes).toEqual(first.outcomeReasonCodes);
  });

  it('throws when proposal is missing for model_judgment_required', () => {
    const subject = buildSubject({ kind: 'model_pass' });
    const args = deriveArgs(subject, null);
    expect(args.preflight.classification).toBe('model_judgment_required');
    expect(() => deriveVerdict(args)).toThrow(IndependentEvaluationError);
    try {
      deriveVerdict(args);
    } catch (error) {
      expect(error).toBeInstanceOf(IndependentEvaluationError);
      expect((error as IndependentEvaluationError).code).toBe('evaluator_contract_violation');
    }
  });

  it('throws when proposal is present for deterministic pass', () => {
    const subject = buildSubject({ kind: 'all_deterministic' });
    const proposal = buildProposal(subject, { modelStatus: 'pass' });
    const args = deriveArgs(subject, proposal);
    expect(args.preflight.classification).toBe('pass');
    expect(() => deriveVerdict(args)).toThrow(IndependentEvaluationError);
    try {
      deriveVerdict(args);
    } catch (error) {
      expect(error).toBeInstanceOf(IndependentEvaluationError);
      expect((error as IndependentEvaluationError).code).toBe('evaluator_contract_violation');
    }
  });

  it('model_judgment_required + null proposal + evaluatorInfrastructureFailure → need_more_evidence/reverify', () => {
    const subject = buildSubject({ kind: 'model_pass' });
    const args = {
      ...deriveArgs(subject, null),
      evaluatorInfrastructureFailure: {
        code: 'evaluator_unavailable' as const,
        detail: 'provider down',
      },
    };
    expect(args.preflight.classification).toBe('model_judgment_required');
    const derived = deriveVerdict(args);
    expect(derived.verdict.outcome).toBe('need_more_evidence');
    expect(derived.verdict.recommendedNextStage).toBe('reverify');
    expect(derived.outcomeReasonCodes).toEqual([
      'evaluator_unavailable',
      'insufficient_evidence',
    ]);
    expect(
      derived.verdict.criterionResults
        .filter((result) => result.authority === 'evaluator')
        .every((result) => result.status === 'insufficient_evidence'),
    ).toBe(true);
    // Infrastructure failure still binds the authorized evaluator run so the
    // independentEvaluatorRequired M1 check can pass without a proposal body.
    expect(derived.verdict.evaluatorAgentRunId).toBe('evaluator-1');
  });

  it('rejects evaluatorInfrastructureFailure when a proposal is present', () => {
    const subject = buildSubject({ kind: 'model_pass' });
    const proposal = buildProposal(subject, { modelStatus: 'pass' });
    const args = {
      ...deriveArgs(subject, proposal),
      evaluatorInfrastructureFailure: {
        code: 'evaluator_unavailable' as const,
        detail: 'should not combine with proposal',
      },
    };
    expect(() => deriveVerdict(args)).toThrow(IndependentEvaluationError);
  });
});
