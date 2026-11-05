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
  assertDeterministicPreflightResultV1,
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

function taskContract(): TaskContract {
  const draft = {
    taskId: 'task-1',
    version: 1,
    contractHash: '',
    objective: 'Verify the exact candidate.',
    context: [],
    acceptanceCriteria: [
      {
        id: 'criterion-mechanical',
        text: 'The unit gate passes.',
        authority: 'mechanical' as const,
        required: true,
        proofBinding: null,
      },
      {
        id: 'criterion-model',
        text: 'The change is sound.',
        authority: 'evaluator' as const,
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

function evidenceManifest(contract: TaskContract): EvidenceManifest {
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
        criterionIds: ['criterion-mechanical'],
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

interface HappyPathOptions {
  readonly modelAuthority?: 'evaluator' | 'mechanical' | 'human';
  readonly requiredSurfaceIds?: readonly string[];
  readonly includeRealSurfaceObservation?: boolean;
}

function buildHappyPath(options: HappyPathOptions = {}): PreflightSubjectV1 {
  const modelAuthority = options.modelAuthority ?? 'evaluator';
  const requiredSurfaceIds = options.requiredSurfaceIds ?? [];
  const includeRealSurface =
    options.includeRealSurfaceObservation ?? requiredSurfaceIds.length > 0;

  const contract = taskContract();
  const artifacts = [artifact('artifact-1', HASH_C)];
  if (requiredSurfaceIds.includes('surface-1')) {
    artifacts.push(artifact('surface-1', HASH_E));
  }
  const manifest = evidenceManifest(contract);
  const assertionMechanical = decisionAssertion('assertion-mechanical', 'tests.unit', {
    passed: true,
  });
  const assertionModel = decisionAssertion('assertion-model', 'design.soundness', {
    passed: true,
  });
  const assertions = [assertionMechanical, assertionModel];
  const receipts = [
    verificationReceipt(
      assertionMechanical,
      contract,
      manifest,
      ['criterion-mechanical'],
      'receipt-mechanical',
    ),
    verificationReceipt(
      assertionModel,
      contract,
      manifest,
      ['criterion-model'],
      'receipt-model',
    ),
  ];
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
    observation({
      observationId: 'observation-model',
      kind: 'mechanical',
      criterionIds: ['criterion-model'],
      status: 'pass',
      artifactIds: ['artifact-1'],
      assertionIds: ['assertion-model'],
      verificationReceiptIds: ['receipt-model'],
    }),
  ];
  if (includeRealSurface && requiredSurfaceIds.length > 0) {
    observations.push(
      observation({
        observationId: 'observation-surface',
        kind: 'real_surface',
        criterionIds: ['criterion-mechanical'],
        status: 'pass',
        artifactIds: [...requiredSurfaceIds].sort(),
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

  const criteria = [
    criterion({
      criterionId: 'criterion-mechanical',
      authority: 'mechanical',
      requiredGateIds: ['gate-external-1'],
      requiredSurfaceIds: [...requiredSurfaceIds].sort(),
      evaluatorInstructionArtifactId: 'artifact-instruction-1',
    }),
    criterion({
      criterionId: 'criterion-model',
      authority: modelAuthority,
      requiredGateIds: [],
      requiredSurfaceIds: [],
      evaluatorInstructionArtifactId: 'artifact-instruction-2',
      evaluatorInstructionArtifactHash: HASH_D,
    }),
  ];
  const rubricRecord = rubric(contract, criteria);
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

  // Re-hash control identity if control body changed.
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
    // Keep input subject fields aligned with evidence after mutations unless
    // the mutator intentionally diverged them.
    inputHash: computeInputHash(inputWithoutHash),
  };

  return draft;
}

describe('runDeterministicPreflight', () => {
  it('happy path classifies model_judgment_required with nine prior passes', () => {
    const subject = buildHappyPath();
    const result = runDeterministicPreflight(subject);
    expect(() => assertDeterministicPreflightResultV1(result)).not.toThrow();
    expect(result.classification).toBe('model_judgment_required');
    expect(result.checks).toHaveLength(10);
    expect(result.checks.slice(0, 9).every((check) => check.status === 'pass')).toBe(true);
    expect(result.checks[9]?.checkId).toBe('model_judgment_necessity');
    expect(result.checks[9]?.status).toBe('model_judgment_required');
    expect(result.eligibleAssertionIds).toEqual([
      'assertion-mechanical',
      'assertion-model',
    ]);
    expect(result.inputHash).toBe(subject.input.inputHash);
    expect(result.controlIdentityHash).toBe(subject.control.controlIdentityHash);
    expect(result.evidenceIdentityHash).toBe(subject.evidence.evidenceIdentityHash);
  });

  it('all-deterministic rubric classifies pass', () => {
    const subject = buildHappyPath({ modelAuthority: 'mechanical' });
    const result = runDeterministicPreflight(subject);
    expect(result.classification).toBe('pass');
    expect(result.checks).toHaveLength(10);
    expect(result.checks.every((check) => check.status === 'pass')).toBe(true);
  });

  it('stops at first non-pass (ordering proof: step 2 before step 7)', () => {
    const base = buildHappyPath();
    // Fail step 2 (iteration mismatch) AND step 7 (remove gate receipt).
    const subject = rebuildSubject(base, (draft) => {
      draft.input = {
        ...draft.input,
        iterationId: 'iteration-stale',
      };
      draft.gateReceipts = [];
    });
    // rebuildSubject recomputes inputHash but leaves evidence.iterationId intact → step 2 fails.
    const result = runDeterministicPreflight(subject);
    expect(result.classification).toBe('need_more_evidence');
    expect(result.checks).toHaveLength(2);
    expect(result.checks[0]?.checkId).toBe('structural_input');
    expect(result.checks[0]?.status).toBe('pass');
    expect(result.checks[1]?.checkId).toBe('subject_relationships');
    expect(result.checks[1]?.status).toBe('need_more_evidence');
    expect(result.checks[1]?.code).toBe('stale_binding');
  });

  it('never throws on garbage input', () => {
    const result = runDeterministicPreflight({} as unknown as PreflightSubjectV1);
    expect(result.classification).toBe('need_more_evidence');
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.checkId).toBe('structural_input');
    expect(result.checks[0]?.status).toBe('need_more_evidence');
    expect(() => assertDeterministicPreflightResultV1(result)).not.toThrow();
  });

  it('is deterministic across repeated runs', () => {
    const subject = buildHappyPath();
    const first = runDeterministicPreflight(subject);
    const second = runDeterministicPreflight(subject);
    expect(second.preflightHash).toBe(first.preflightHash);
    expect(hashCanonicalJson(second)).toBe(hashCanonicalJson(first));
  });

  it.each([
    {
      name: 'step2 ref hash mismatch',
      mutate: (draft: {
        input: IndependentEvaluationInputV1;
        control: TrustedEvaluationControlSnapshotV1;
        evidence: TrustedEvaluationEvidenceSnapshotV1;
        gateReceipts: DeterministicGateReceiptV1[];
      }) => {
        draft.input = {
          ...draft.input,
          policyRef: {
            ...draft.input.policyRef,
            policyHash:
              'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
          },
        };
      },
      checkId: 'subject_relationships',
      status: 'need_more_evidence' as const,
      code: 'stale_binding',
    },
    {
      name: 'step3 tampered attestation',
      mutate: (draft: {
        input: IndependentEvaluationInputV1;
        control: TrustedEvaluationControlSnapshotV1;
        evidence: TrustedEvaluationEvidenceSnapshotV1;
        gateReceipts: DeterministicGateReceiptV1[];
      }) => {
        const withoutHash = {
          ...draft.evidence.integrityAttestation,
          result: 'tampered' as const,
        };
        const { attestationHash: _drop, ...rest } = withoutHash;
        const attestation = {
          ...rest,
          attestationHash: computeEvidenceIntegrityAttestationHash(rest),
        };
        draft.evidence = {
          ...draft.evidence,
          integrityAttestation: attestation,
        };
        draft.input = {
          ...draft.input,
          integrityAttestation: attestation,
        };
      },
      checkId: 'artifact_integrity',
      status: 'need_more_evidence' as const,
      code: 'artifact_integrity',
    },
    {
      name: 'step4 incomplete verification result',
      mutate: (draft: {
        input: IndependentEvaluationInputV1;
        control: TrustedEvaluationControlSnapshotV1;
        evidence: TrustedEvaluationEvidenceSnapshotV1;
        gateReceipts: DeterministicGateReceiptV1[];
      }) => {
        const { resultHash: _drop, ...rest } = draft.evidence.verificationResult;
        const verification = {
          ...rest,
          status: 'incomplete' as const,
          resultHash: computeVerificationResultHash({
            ...rest,
            status: 'incomplete',
          }),
        };
        draft.evidence = { ...draft.evidence, verificationResult: verification };
        draft.input = { ...draft.input, verificationResult: verification };
      },
      checkId: 'verification_result',
      status: 'need_more_evidence' as const,
      code: 'verification_incomplete',
    },
    {
      name: 'step5 receipt referencing unknown assertion',
      mutate: (draft: {
        input: IndependentEvaluationInputV1;
        control: TrustedEvaluationControlSnapshotV1;
        evidence: TrustedEvaluationEvidenceSnapshotV1;
        gateReceipts: DeterministicGateReceiptV1[];
      }) => {
        const ghostPayload = { passed: true };
        const ghostAssertion = decisionAssertion('assertion-ghost', 'ghost.key', ghostPayload);
        const ghostReceipt = verificationReceipt(
          ghostAssertion,
          draft.evidence.taskContract,
          draft.evidence.evidenceManifest,
          ['criterion-mechanical'],
          'receipt-ghost',
        );
        // Receipt present without the assertion in the snapshot.
        const receipts = [...draft.evidence.verificationReceipts, ghostReceipt];
        draft.evidence = { ...draft.evidence, verificationReceipts: receipts };
        draft.input = { ...draft.input, verificationReceipts: receipts };
      },
      checkId: 'claim_eligibility',
      status: 'need_more_evidence' as const,
      code: 'claim_ineligible',
    },
    {
      name: 'step6 evaluator implementation not allowed',
      mutate: (draft: {
        input: IndependentEvaluationInputV1;
        control: TrustedEvaluationControlSnapshotV1;
        evidence: TrustedEvaluationEvidenceSnapshotV1;
        gateReceipts: DeterministicGateReceiptV1[];
      }) => {
        const roles = runAuthority({
          evaluatorImplementationId: 'evaluator-impl-forbidden',
        });
        draft.control = { ...draft.control, roles };
      },
      checkId: 'control_authority',
      status: 'need_more_evidence' as const,
      code: 'policy_denial',
    },
    {
      name: 'step7 missing gate receipt',
      mutate: (draft: {
        input: IndependentEvaluationInputV1;
        control: TrustedEvaluationControlSnapshotV1;
        evidence: TrustedEvaluationEvidenceSnapshotV1;
        gateReceipts: DeterministicGateReceiptV1[];
      }) => {
        draft.gateReceipts = [];
      },
      checkId: 'deterministic_gates',
      status: 'need_more_evidence' as const,
      code: 'stale_binding',
    },
    {
      name: 'step7 fabricated extra receipt',
      mutate: (draft: {
        input: IndependentEvaluationInputV1;
        control: TrustedEvaluationControlSnapshotV1;
        evidence: TrustedEvaluationEvidenceSnapshotV1;
        gateReceipts: DeterministicGateReceiptV1[];
      }) => {
        const extraDef = gateDefinition({
          gateId: 'gate-extra',
          registryFunctionId: 'external.extra',
        });
        const extra = gateReceipt(
          extraDef,
          draft.control.gatePlan,
          draft.evidence.taskContract,
          {
            gateId: 'gate-extra',
            gateDefinitionHash: extraDef.definitionHash,
          },
        );
        draft.gateReceipts = [...draft.gateReceipts, extra];
      },
      checkId: 'deterministic_gates',
      status: 'need_more_evidence' as const,
      code: 'stale_binding',
    },
    {
      name: 'step7 verified_fail with eligible assertions',
      mutate: (draft: {
        input: IndependentEvaluationInputV1;
        control: TrustedEvaluationControlSnapshotV1;
        evidence: TrustedEvaluationEvidenceSnapshotV1;
        gateReceipts: DeterministicGateReceiptV1[];
      }) => {
        const definition = draft.control.gatePlan.gates[0]!;
        const failed = gateReceipt(
          definition,
          draft.control.gatePlan,
          draft.evidence.taskContract,
          {
            status: 'verified_fail',
            exitCode: 1,
            assertionIds: ['assertion-mechanical'],
          },
        );
        draft.gateReceipts = [failed];
      },
      checkId: 'deterministic_gates',
      status: 'verified_fail' as const,
      code: 'deterministic_gate_failed',
    },
    {
      name: 'step7 verified_fail with ineligible assertion',
      mutate: (draft: {
        input: IndependentEvaluationInputV1;
        control: TrustedEvaluationControlSnapshotV1;
        evidence: TrustedEvaluationEvidenceSnapshotV1;
        gateReceipts: DeterministicGateReceiptV1[];
      }) => {
        const definition = draft.control.gatePlan.gates[0]!;
        const failed = gateReceipt(
          definition,
          draft.control.gatePlan,
          draft.evidence.taskContract,
          {
            status: 'verified_fail',
            exitCode: 1,
            assertionIds: ['assertion-not-eligible'],
          },
        );
        draft.gateReceipts = [failed];
      },
      checkId: 'deterministic_gates',
      status: 'need_more_evidence' as const,
      code: 'claim_ineligible',
    },
  ])('$name', ({ mutate, checkId, status, code }) => {
    const subject = rebuildSubject(buildHappyPath(), mutate);
    const result = runDeterministicPreflight(subject);
    const last = result.checks[result.checks.length - 1];
    expect(last?.checkId).toBe(checkId);
    expect(last?.status).toBe(status);
    expect(last?.code).toBe(code);
    expect(result.classification).toBe(status);
  });

  it('step8 missing real-surface observation', () => {
    const subject = buildHappyPath({
      requiredSurfaceIds: ['surface-1'],
      includeRealSurfaceObservation: false,
    });
    const result = runDeterministicPreflight(subject);
    const last = result.checks[result.checks.length - 1];
    expect(last?.checkId).toBe('real_surface_coverage');
    expect(last?.status).toBe('need_more_evidence');
    expect(last?.code).toBe('real_surface_missing');
  });

  it('step9 required criterion with zero eligible premises', () => {
    const subject = rebuildSubject(buildHappyPath(), (draft) => {
      // Drop model assertion eligibility by changing receipt verifier to implementer.
      const receipts = draft.evidence.verificationReceipts.map((receipt) => {
        if (receipt.assertionId !== 'assertion-model') {
          return receipt;
        }
        const { receiptHash: _drop, ...rest } = receipt;
        const next = {
          ...rest,
          verifierRunId: 'implementer-1',
        };
        return {
          ...next,
          receiptHash: computeVerificationReceiptHash(next),
        };
      });
      // Also remove observation/receipt criterion links for model by clearing criterionIds
      // on the model receipt and observation — then no eligible premises remain.
      const observations = draft.evidence.verificationResult.observations.map((obs) => {
        if (!obs.criterionIds.includes('criterion-model')) {
          return obs;
        }
        const { observationHash: _drop, ...rest } = obs;
        const next = {
          ...rest,
          assertionIds: [] as string[],
          verificationReceiptIds: [] as string[],
        };
        return {
          ...next,
          observationHash: computeVerificationObservationHash(next),
        };
      });
      const clearedReceipts = receipts.map((receipt) => {
        if (receipt.assertionId !== 'assertion-model') {
          return receipt;
        }
        const { receiptHash: _drop, ...rest } = receipt;
        const next = { ...rest, criterionIds: [] as string[] };
        return { ...next, receiptHash: computeVerificationReceiptHash(next) };
      });
      const { resultHash: _drop, ...vrRest } = draft.evidence.verificationResult;
      const verification = {
        ...vrRest,
        observations,
        resultHash: computeVerificationResultHash({
          ...vrRest,
          observations,
        }),
      };
      draft.evidence = {
        ...draft.evidence,
        verificationResult: verification,
        verificationReceipts: clearedReceipts,
      };
      draft.input = {
        ...draft.input,
        verificationResult: verification,
        verificationReceipts: clearedReceipts,
      };
    });
    const result = runDeterministicPreflight(subject);
    const last = result.checks[result.checks.length - 1];
    expect(last?.checkId).toBe('contradiction_and_sufficiency');
    expect(last?.status).toBe('need_more_evidence');
    expect(last?.code).toBe('claim_ineligible');
  });

  it('step9 contradiction between confirming receipts touching a required criterion', () => {
    const subject = rebuildSubject(buildHappyPath(), (draft) => {
      const original = draft.evidence.assertions.find(
        (assertion) => assertion.id === 'assertion-mechanical',
      )!;
      // Second fact assertion, same subjectKey, different payload/valueHash.
      const conflicting = decisionAssertion('assertion-conflict', original.subjectKey, {
        passed: false,
      });
      const conflictReceipt = verificationReceipt(
        conflicting,
        draft.evidence.taskContract,
        draft.evidence.evidenceManifest,
        ['criterion-mechanical'],
        'receipt-conflict',
      );
      const assertions = [...draft.evidence.assertions, conflicting];
      const receipts = [...draft.evidence.verificationReceipts, conflictReceipt];
      // Link conflict assertion into the mechanical observation premises.
      const observations = draft.evidence.verificationResult.observations.map((obs) => {
        if (obs.observationId !== 'observation-mechanical') {
          return obs;
        }
        const { observationHash: _drop, ...rest } = obs;
        const next = {
          ...rest,
          assertionIds: [...rest.assertionIds, 'assertion-conflict'].sort(),
          verificationReceiptIds: [...rest.verificationReceiptIds, 'receipt-conflict'].sort(),
        };
        return {
          ...next,
          observationHash: computeVerificationObservationHash(next),
        };
      });
      const { resultHash: _drop, ...vrRest } = draft.evidence.verificationResult;
      const verification = {
        ...vrRest,
        observations,
        resultHash: computeVerificationResultHash({
          ...vrRest,
          observations,
        }),
      };
      draft.evidence = {
        ...draft.evidence,
        assertions,
        verificationReceipts: receipts,
        verificationResult: verification,
      };
      draft.input = {
        ...draft.input,
        assertions,
        verificationReceipts: receipts,
        verificationResult: verification,
      };
    });
    const result = runDeterministicPreflight(subject);
    const last = result.checks[result.checks.length - 1];
    expect(last?.checkId).toBe('contradiction_and_sufficiency');
    expect(last?.status).toBe('need_more_evidence');
    expect(last?.code).toBe('claim_contradiction');
  });
});
