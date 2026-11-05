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
import type { TaskContract } from '../../src/domain/taskContract.js';
import {
  IndependentEvaluationError,
  assertCurrentGateReceiptQueryV1,
  assertDeterministicGateDefinitionV1,
  assertDeterministicGatePlanRefV1,
  assertDeterministicGatePlanV1,
  assertDeterministicGateReceiptV1,
  assertEvaluationPolicyRefV1,
  assertEvaluationPolicyV1,
  assertEvaluationRubricCriterionV1,
  assertEvaluationRubricRefV1,
  assertEvaluationRubricV1,
  assertEvaluationRunAuthorityV1,
  assertRunAuthorityDisjointness,
  assertTrustedDeterministicGateRunnerV1,
  assertTrustedEvaluationControlSnapshotV1,
  assertTrustedEvaluationEvidenceSnapshotV1,
  assertVerificationObservationV1,
  assertVerificationResultV1,
  computeControlIdentityHash,
  computeControlObservationHash,
  computeEvidenceIdentityHash,
  computeEvidenceObservationHash,
  computeEvaluationPolicyHash,
  computeEvaluationRubricHash,
  computeGateDefinitionHash,
  computeGatePlanHash,
  computeGateReceiptHash,
  computeGateReceiptSetHash,
  computeRunAuthorityHash,
  computeVerificationObservationHash,
  computeVerificationResultHash,
  type CurrentGateReceiptQueryV1,
  type DeterministicGateDefinitionV1,
  type DeterministicGatePlanRefV1,
  type DeterministicGatePlanV1,
  type DeterministicGateReceiptV1,
  type EvaluationPolicyRefV1,
  type EvaluationPolicyV1,
  type EvaluationRubricCriterionV1,
  type EvaluationRubricRefV1,
  type EvaluationRubricV1,
  type EvaluationRunAuthorityV1,
  type TrustedEvaluationControlSnapshotV1,
  type TrustedEvaluationEvidenceSnapshotV1,
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
    criteria: [criterion()],
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

function artifact(): ArtifactRef {
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

function decisionAssertion(): DecisionAssertion {
  const payload = { passed: true };
  return {
    id: 'assertion-1',
    subjectKey: 'tests.unit',
    kind: 'fact',
    canonicalPayload: payload,
    payloadHash: computeAssertionPayloadHash(payload),
    advisoryText: null,
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

describe('M8 independent evaluation control-plane records', () => {
  it('accepts happy-path fixtures for every control record with matching hashes', () => {
    const obs = observation();
    const result = verificationResult();
    const policyRecord = policy();
    const rubricRecord = rubric();
    const criterionRecord = criterion();
    const authority = runAuthority();
    const definition = gateDefinition();
    const plan = gatePlan();
    const receipt = gateReceipt(definition);
    const query: CurrentGateReceiptQueryV1 = {
      gatePlanId: 'gate-plan-1',
      gatePlanHash: plan.gatePlanHash,
      taskId: 'task-1',
      taskContractHash: HASH_A,
      iterationId: 'iteration-1',
      candidateCommit: COMMIT,
      authorityEpoch: 'epoch-1',
    };
    const policyRef: EvaluationPolicyRefV1 = {
      schema: 'hercules-evaluation-policy-ref/v1',
      policyId: 'hercules-v1-independent-evaluation',
      version: 1,
      policyHash: policyRecord.policyHash,
    };
    const rubricRef: EvaluationRubricRefV1 = {
      schema: 'hercules-evaluation-rubric-ref/v1',
      rubricId: 'rubric-1',
      version: 1,
      rubricHash: rubricRecord.rubricHash,
    };
    const planRef: DeterministicGatePlanRefV1 = {
      schema: 'hercules-deterministic-gate-plan-ref/v1',
      gatePlanId: 'gate-plan-1',
      version: 1,
      gatePlanHash: plan.gatePlanHash,
    };

    expect(() => assertVerificationObservationV1(obs)).not.toThrow();
    expect(() => assertVerificationResultV1(result)).not.toThrow();
    expect(() => assertEvaluationPolicyRefV1(policyRef)).not.toThrow();
    expect(() => assertEvaluationRubricRefV1(rubricRef)).not.toThrow();
    expect(() => assertDeterministicGatePlanRefV1(planRef)).not.toThrow();
    expect(() => assertEvaluationPolicyV1(policyRecord)).not.toThrow();
    expect(() => assertEvaluationRubricCriterionV1(criterionRecord)).not.toThrow();
    expect(() => assertEvaluationRubricV1(rubricRecord)).not.toThrow();
    expect(() => assertEvaluationRunAuthorityV1(authority)).not.toThrow();
    expect(() => assertRunAuthorityDisjointness(authority, policyRecord)).not.toThrow();
    expect(() => assertDeterministicGateDefinitionV1(definition)).not.toThrow();
    expect(() => assertDeterministicGatePlanV1(plan)).not.toThrow();
    expect(() => assertDeterministicGateReceiptV1(receipt, definition)).not.toThrow();
    expect(() => assertCurrentGateReceiptQueryV1(query)).not.toThrow();
    expect(() =>
      assertTrustedDeterministicGateRunnerV1({
        resolveCurrentReceipts: async () => [receipt],
      }),
    ).not.toThrow();
    expect(() =>
      assertTrustedEvaluationControlSnapshotV1(controlSnapshot()),
    ).not.toThrow();
    expect(() =>
      assertTrustedEvaluationEvidenceSnapshotV1(evidenceSnapshot()),
    ).not.toThrow();
  });

  it.each([
    {
      name: 'verification observation unknown field',
      run: () =>
        assertVerificationObservationV1({
          ...observation(),
          extra: true,
        } as unknown as VerificationObservationV1),
    },
    {
      name: 'verification observation missing field',
      run: () => {
        const { observationId: _drop, ...rest } = observation();
        assertVerificationObservationV1(rest as unknown as VerificationObservationV1);
      },
    },
    {
      name: 'verification observation wrong hash',
      run: () =>
        assertVerificationObservationV1(observation({ observationHash: HASH_ZERO })),
    },
    {
      name: 'verification observation non-canonical timestamp',
      run: () =>
        assertVerificationObservationV1(observation({ observedAt: '2026-08-29T00:00:00Z' })),
    },
    {
      name: 'verification observation duplicate criterion id',
      run: () =>
        assertVerificationObservationV1(
          observation({ criterionIds: ['criterion-1', 'criterion-1'] }),
        ),
    },
    {
      name: 'verification observation unsorted criterion ids',
      run: () =>
        assertVerificationObservationV1(
          observation({ criterionIds: ['criterion-2', 'criterion-1'] }),
        ),
    },
    {
      name: 'verification result short git sha',
      run: () =>
        assertVerificationResultV1(verificationResult({ candidateCommit: 'abc123' })),
    },
    {
      name: 'verification result uppercase git sha',
      run: () =>
        assertVerificationResultV1(
          verificationResult({
            candidateCommit: '0123456789ABCDEF0123456789ABCDEF01234567',
          }),
        ),
    },
    {
      name: 'policy wrong policyId',
      run: () =>
        assertEvaluationPolicyV1(
          policy({
            policyId: 'other-policy' as EvaluationPolicyV1['policyId'],
          }),
        ),
    },
    {
      name: 'policy wrong issuer',
      run: () =>
        assertEvaluationPolicyV1(
          policy({
            issuer: 'other-issuer' as EvaluationPolicyV1['issuer'],
          }),
        ),
    },
    {
      name: 'policy boolean weakened',
      run: () =>
        assertEvaluationPolicyV1(
          policy({
            verifiedFactsOnly: false as unknown as true,
          }),
        ),
    },
    {
      name: 'policy ceiling exceeded',
      run: () => assertEvaluationPolicyV1(policy({ maxArtifacts: 513 })),
    },
    {
      name: 'policy expiry not after issuedAt',
      run: () =>
        assertEvaluationPolicyV1(
          policy({
            issuedAt: '2026-08-30T00:00:00.000Z',
            expiresAt: '2026-08-30T00:00:00.000Z',
          }),
        ),
    },
    {
      name: 'policy unsorted role disjointness',
      run: () =>
        assertEvaluationPolicyV1(
          policy({
            requiredRoleDisjointness: ['verifier', 'implementer'],
          }),
        ),
    },
    {
      name: 'policy wrong hash',
      run: () => assertEvaluationPolicyV1(policy({ policyHash: HASH_ZERO })),
    },
    {
      name: 'rubric duplicate criterion id',
      run: () =>
        assertEvaluationRubricV1(
          rubric({
            criteria: [criterion(), criterion()],
          }),
        ),
    },
    {
      name: 'rubric invalid authority',
      run: () =>
        assertEvaluationRubricV1(
          rubric({
            criteria: [
              criterion({
                authority: 'not-an-authority' as EvaluationRubricCriterionV1['authority'],
              }),
            ],
          }),
        ),
    },
    {
      name: 'rubric duplicate advisory class',
      run: () =>
        assertEvaluationRubricV1(
          rubric({
            criteria: [
              criterion({
                allowedAdvisoryClasses: ['inference', 'inference'],
              }),
            ],
          }),
        ),
    },
    {
      name: 'rubric bad artifact hash grammar',
      run: () =>
        assertEvaluationRubricV1(
          rubric({
            criteria: [
              criterion({
                evaluatorInstructionArtifactHash: 'not-a-hash',
              }),
            ],
          }),
        ),
    },
    {
      name: 'run authority wrong coordinator role',
      run: () =>
        assertEvaluationRunAuthorityV1(
          runAuthority({
            coordinatorRole:
              'coordinator' as EvaluationRunAuthorityV1['coordinatorRole'],
          }),
        ),
    },
    {
      name: 'run authority unsorted implementer ids',
      run: () =>
        assertEvaluationRunAuthorityV1(
          runAuthority({
            implementerRunIds: ['implementer-2', 'implementer-1'],
          }),
        ),
    },
    {
      name: 'gate definition wrong hash',
      run: () =>
        assertDeterministicGateDefinitionV1(gateDefinition({ definitionHash: HASH_ZERO })),
    },
    {
      name: 'gate plan bad candidate commit',
      run: () => assertDeterministicGatePlanV1(gatePlan({ candidateCommit: 'SHORT' })),
    },
    {
      name: 'gate receipt expiry not after completedAt',
      run: () => {
        const definition = gateDefinition();
        assertDeterministicGateReceiptV1(
          gateReceipt(definition, {
            completedAt: '2026-08-29T01:00:00.000Z',
            expiresAt: '2026-08-29T01:00:00.000Z',
          }),
          definition,
        );
      },
    },
    {
      name: 'gate receipt wrong status',
      run: () => {
        const definition = gateDefinition();
        assertDeterministicGateReceiptV1(
          gateReceipt(definition, {
            status: 'fail' as DeterministicGateReceiptV1['status'],
          }),
          definition,
        );
      },
    },
    {
      name: 'control snapshot wrong issuer',
      run: () =>
        assertTrustedEvaluationControlSnapshotV1(
          controlSnapshot({
            issuer: 'other' as TrustedEvaluationControlSnapshotV1['issuer'],
          }),
        ),
    },
    {
      name: 'control snapshot wrong identity hash',
      run: () =>
        assertTrustedEvaluationControlSnapshotV1(
          controlSnapshot({ controlIdentityHash: HASH_ZERO }),
        ),
    },
    {
      name: 'evidence snapshot freshUntil not after observedAt',
      run: () =>
        assertTrustedEvaluationEvidenceSnapshotV1(
          evidenceSnapshot({
            observedAt: '2026-08-29T01:00:00.000Z',
            freshUntil: '2026-08-29T01:00:00.000Z',
          }),
        ),
    },
    {
      name: 'evidence snapshot wrong observation hash',
      run: () =>
        assertTrustedEvaluationEvidenceSnapshotV1(
          evidenceSnapshot({ evidenceObservationHash: HASH_ZERO }),
        ),
    },
  ])('rejects $name', ({ run }) => {
    expect(run).toThrow(IndependentEvaluationError);
  });

  it('rejects environmentIdentity extra and missing keys against the gate definition', () => {
    const definition = gateDefinition({
      requiredEnvironmentFields: ['host', 'toolchain'],
    });
    expect(() =>
      assertDeterministicGateReceiptV1(
        gateReceipt(definition, {
          environmentIdentity: {
            host: 'host-value',
            toolchain: 'toolchain-value',
            extra: 'nope',
          },
        }),
        definition,
      ),
    ).toThrow('environmentIdentity');
    expect(() =>
      assertDeterministicGateReceiptV1(
        gateReceipt(definition, {
          environmentIdentity: {
            host: 'host-value',
          },
        }),
        definition,
      ),
    ).toThrow('environmentIdentity');
  });

  it('rejects evaluator overlap with implementer and with verifier when required', () => {
    const basePolicy = policy({
      requiredRoleDisjointness: ['implementer', 'verifier'],
    });
    expect(() =>
      assertEvaluationRunAuthorityV1(
        runAuthority({
          evaluatorRunId: 'implementer-1',
          implementerRunIds: ['implementer-1'],
        }),
      ),
    ).toThrow('implementerRunIds');

    expect(() =>
      assertRunAuthorityDisjointness(
        runAuthority({
          evaluatorRunId: 'verifier-1',
          verifierRunIds: ['verifier-1'],
        }),
        basePolicy,
      ),
    ).toThrow('verifierRunIds');

    expect(() =>
      assertRunAuthorityDisjointness(
        runAuthority({
          evaluatorRunId: 'reviewer-1',
          reviewerRunIds: ['reviewer-1'],
        }),
        policy({ requiredRoleDisjointness: ['implementer', 'reviewer'] }),
      ),
    ).toThrow('reviewerRunIds');

    expect(() =>
      assertRunAuthorityDisjointness(
        runAuthority({
          evaluatorRunId: 'reviewer-1',
          reviewerRunIds: ['reviewer-1'],
        }),
        policy({ requiredRoleDisjointness: ['implementer'] }),
      ),
    ).not.toThrow();
  });

  it('computes gate-receipt-set hash order-insensitively and member-sensitively', () => {
    const definition = gateDefinition();
    const first = gateReceipt(definition, {
      runnerRunId: 'runner-a',
      assertionIds: ['assertion-a'],
    });
    const second = gateReceipt(definition, {
      runnerRunId: 'runner-b',
      assertionIds: ['assertion-b'],
    });
    const third = gateReceipt(definition, {
      runnerRunId: 'runner-c',
      assertionIds: ['assertion-c'],
    });

    expect(computeGateReceiptSetHash([first, second])).toBe(
      computeGateReceiptSetHash([second, first]),
    );
    expect(computeGateReceiptSetHash([first, second])).not.toBe(
      computeGateReceiptSetHash([first, third]),
    );
  });

  it('rejects policy refs and gate runners with invalid shapes', () => {
    expect(() =>
      assertEvaluationPolicyRefV1({
        schema: 'hercules-evaluation-policy-ref/v1',
        policyId: 'hercules-v1-independent-evaluation',
        version: 1,
        policyHash: HASH_A,
        extra: 1,
      } as unknown as EvaluationPolicyRefV1),
    ).toThrow(IndependentEvaluationError);
    expect(() =>
      assertTrustedDeterministicGateRunnerV1({} as never),
    ).toThrow(IndependentEvaluationError);
  });
});
