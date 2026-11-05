import { describe, expect, it, vi } from 'vitest';
import {
  computeAssertionPayloadHash,
  type DecisionAssertion,
} from '../../src/domain/claimAuthorityV2.js';
import {
  IndependentEvaluationError,
  PREFLIGHT_CHECK_IDS,
  assertSanitizedEvaluationRequestV1,
  computeCancellationDispatchHash,
  computeEvaluationPolicyHash,
  computeEvaluationRubricHash,
  computePreflightCheckHash,
  computePreflightResultHash,
  computeProposalHash,
  computeRunAuthorityHash,
  computeSanitizedEvaluationRequestHash,
  type DeterministicPreflightCheckV1,
  type DeterministicPreflightResultV1,
  type EvaluationCancellationAttemptV1,
  type EvaluationCancellationControllerV1,
  type EvaluationCancellationDispatchV1,
  type EvaluationCancellationReasonV1,
  type EvaluationCancellationSignalV1,
  type EvaluationDeadlinePortV1,
  type EvaluationPolicyV1,
  type EvaluationRubricCriterionV1,
  type EvaluationRubricV1,
  type EvaluationRunAuthorityV1,
  type EvaluatorProposalV1,
  type IndependentEvaluationInputV1,
  type IndependentEvaluatorPortV1,
  type SanitizedEvaluationRequestV1,
  type TrustedEvaluationCancellationFactoryV1,
  type TrustedEvaluationControlSnapshotV1,
} from '../../src/domain/independentEvaluation.js';
import {
  buildSanitizedEvaluationRequest,
  runEvaluatorAttempt,
} from '../../src/evaluation/evaluatorPort.js';

const HASH_A =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B =
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C =
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const HASH_D =
  'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const HASH_E =
  'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

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

function factAssertion(
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

function inferenceAssertion(
  id: string,
  subjectKey: string,
  payload: { readonly note: string },
): DecisionAssertion {
  return {
    id,
    subjectKey,
    kind: 'inference',
    canonicalPayload: payload,
    payloadHash: computeAssertionPayloadHash(payload),
    advisoryText: 'advisory inference',
  };
}

function opinionAssertion(
  id: string,
  subjectKey: string,
  payload: { readonly note: string },
): DecisionAssertion {
  return {
    id,
    subjectKey,
    kind: 'opinion',
    canonicalPayload: payload,
    payloadHash: computeAssertionPayloadHash(payload),
    advisoryText: 'advisory opinion',
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
    criterionId: 'criterion-model',
    required: true,
    authority: 'evaluator',
    allowedAdvisoryClasses: ['inference', 'opinion'],
    requiredGateIds: [],
    requiredSurfaceIds: [],
    evaluatorInstructionArtifactId: 'artifact-instruction-1',
    evaluatorInstructionArtifactHash: HASH_C,
    ...overrides,
  };
}

function rubric(
  criteria: readonly EvaluationRubricCriterionV1[] = [criterion()],
  overrides: Partial<EvaluationRubricV1> = {},
): EvaluationRubricV1 {
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
    criteria: [...criteria],
    ...fields,
  };
  return {
    ...withoutHash,
    rubricHash: overrideHash ?? computeEvaluationRubricHash(withoutHash),
  };
}

function roles(
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

function preflightCheck(
  checkId: (typeof PREFLIGHT_CHECK_IDS)[number],
  status: DeterministicPreflightCheckV1['status'],
  code: DeterministicPreflightCheckV1['code'],
): DeterministicPreflightCheckV1 {
  const withoutHash = {
    checkId,
    status,
    code,
    criterionIds: [] as const,
    assertionIds: [] as const,
    evidenceIds: [] as const,
    advisoryDetail: status === 'pass' ? '' : 'model judgment required',
  };
  return {
    ...withoutHash,
    checkHash: computePreflightCheckHash(withoutHash),
  };
}

function preflightResult(
  overrides: Partial<DeterministicPreflightResultV1> = {},
): DeterministicPreflightResultV1 {
  const { preflightHash: overrideHash, ...fields } = overrides;
  const checks =
    fields.checks ??
    PREFLIGHT_CHECK_IDS.map((checkId, index) => {
      const isLast = index === PREFLIGHT_CHECK_IDS.length - 1;
      return preflightCheck(
        checkId,
        isLast ? 'model_judgment_required' : 'pass',
        isLast ? 'model_judgment_required' : 'ok',
      );
    });
  const { checks: _ignoredChecks, ...fieldRest } = fields;
  const withoutHash = {
    schema: 'hercules-deterministic-preflight/v1' as const,
    inputHash: HASH_A,
    controlIdentityHash: HASH_B,
    evidenceIdentityHash: HASH_C,
    gateReceiptSetHash: HASH_D,
    classification: 'model_judgment_required' as const,
    eligibleAssertionIds: ['assertion-eligible-a', 'assertion-eligible-b'],
    ...fieldRest,
    checks,
  };
  return {
    ...withoutHash,
    preflightHash: overrideHash ?? computePreflightResultHash(withoutHash),
  };
}

function controlSnapshot(
  rubricRecord: EvaluationRubricV1,
  policyRecord: EvaluationPolicyV1 = policy(),
): TrustedEvaluationControlSnapshotV1 {
  return {
    schema: 'hercules-trusted-evaluation-control/v1',
    issuer: 'hercules-program-control',
    authorityEpoch: 'epoch-1',
    policy: policyRecord,
    rubric: rubricRecord,
    gatePlan: {
      schema: 'hercules-deterministic-gate-plan/v1',
      gatePlanId: 'gate-plan-1',
      version: 1,
      issuer: 'hercules-program-control',
      authorityEpoch: 'epoch-1',
      taskContractHash: HASH_A,
      candidateCommit: '0123456789abcdef0123456789abcdef01234567',
      gates: [],
      gatePlanHash: HASH_E,
    },
    roles: roles(),
    observedAt: '2026-08-29T00:00:00.000Z',
    controlIdentityHash: HASH_B,
    controlObservationHash: HASH_C,
  };
}

function inputRecord(
  assertions: readonly DecisionAssertion[],
  overrides: Partial<IndependentEvaluationInputV1> = {},
): IndependentEvaluationInputV1 {
  return {
    schema: 'hercules-independent-evaluation-input/v1',
    requestId: 'request-1',
    taskContract: {
      taskId: 'task-1',
      version: 1,
      contractHash: HASH_A,
      objective: 'obj',
      context: [],
      acceptanceCriteria: [],
      constraints: [],
      forbiddenActions: [],
      capabilityPolicy: { version: 'capability-v1', grants: [] },
      verificationPolicy: {
        version: 'verification-v1',
        requiredEvidence: [],
        independentEvaluatorRequired: true,
      },
      approvalPolicy: { version: 'approval-v1', requiredDecisions: [] },
      budgetPolicy: {
        version: 'budget-v1',
        maxCostUsd: null,
        maxTokens: null,
        maxDurationMs: null,
      },
      createdBy: { kind: 'human', id: 'owner' },
      createdAt: '2026-08-29T00:00:00.000Z',
      supersedesVersion: null,
    },
    iterationId: 'iteration-1',
    candidateRef: {
      kind: 'git',
      repository: 'example-org/acme',
      revision: '0123456789abcdef0123456789abcdef01234567',
    },
    evidenceManifest: {
      id: 'manifest-1',
      taskId: 'task-1',
      contractVersion: 1,
      iterationId: 'iteration-1',
      candidateRef: {
        kind: 'git',
        repository: 'example-org/acme',
        revision: '0123456789abcdef0123456789abcdef01234567',
      },
      entries: [],
      createdAt: '2026-08-29T00:00:00.000Z',
      manifestHash: HASH_B,
    },
    artifacts: [],
    verificationResult: {
      schema: 'hercules-verification-result/v1',
      verificationResultId: 'verification-result-1',
      verifierRunId: 'verifier-1',
      taskId: 'task-1',
      taskContractHash: HASH_A,
      iterationId: 'iteration-1',
      candidateCommit: '0123456789abcdef0123456789abcdef01234567',
      manifestId: 'manifest-1',
      manifestHash: HASH_B,
      startedAt: '2026-08-29T00:00:00.000Z',
      completedAt: '2026-08-29T00:00:01.000Z',
      status: 'complete',
      observations: [],
      resultHash: HASH_C,
    },
    assertions,
    verificationReceipts: [],
    integrityAttestation: {
      schema: 'hercules-evidence-integrity-attestation/v1',
      result: 'intact',
      evidenceManifestId: 'manifest-1',
      evidenceManifestHash: HASH_B,
      candidateRef: {
        kind: 'git',
        repository: 'example-org/acme',
        revision: '0123456789abcdef0123456789abcdef01234567',
      },
      checkedArtifacts: [],
      verifierImplementation: 'integrity-v1',
      checkedAt: '2026-08-29T00:00:00.000Z',
      attestationHash: HASH_D,
    },
    policyRef: {
      schema: 'hercules-evaluation-policy-ref/v1',
      policyId: 'hercules-v1-independent-evaluation',
      version: 1,
      policyHash: HASH_E,
    },
    rubricRef: {
      schema: 'hercules-evaluation-rubric-ref/v1',
      rubricId: 'rubric-1',
      version: 1,
      rubricHash: HASH_A,
    },
    gatePlanRef: {
      schema: 'hercules-deterministic-gate-plan-ref/v1',
      gatePlanId: 'gate-plan-1',
      version: 1,
      gatePlanHash: HASH_B,
    },
    locatorHints: [],
    inputHash: HASH_A,
    ...overrides,
  };
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

function makeFactory(
  attemptId = 'attempt-1',
): {
  readonly factory: TrustedEvaluationCancellationFactoryV1;
  readonly getLastAttempt: () => EvaluationCancellationAttemptV1;
} {
  let lastAttempt!: EvaluationCancellationAttemptV1;
  return {
    factory: {
      createAttempt: () => {
        lastAttempt = {
          attemptId,
          evaluatorController: makeController('signal-evaluator', attemptId),
          deadlineController: makeController('signal-deadline', attemptId),
        };
        return lastAttempt;
      },
    },
    getLastAttempt: () => lastAttempt,
  };
}

function validProposal(
  request: SanitizedEvaluationRequestV1,
  rubricRecord: EvaluationRubricV1,
  runRoles: EvaluationRunAuthorityV1,
  overrides: Partial<EvaluatorProposalV1> = {},
): EvaluatorProposalV1 {
  const eligibleId =
    request.eligibleAssertions[0]?.assertionId ?? 'assertion-eligible-a';
  const { proposalHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    schema: 'hercules-evaluator-proposal/v1' as const,
    requestId: request.requestId,
    inputHash: request.inputHash,
    evaluatorRunId: runRoles.evaluatorRunId,
    evaluatorImplementationId: runRoles.evaluatorImplementationId,
    proposalId: 'proposal-1',
    criterionProposals: rubricRecord.criteria.map((item) => ({
      criterionId: item.criterionId,
      proposedStatus: 'pass' as const,
      premiseAssertionIds: [eligibleId],
      advisoryRationale: 'Matches verified premises.',
    })),
    findings: [
      {
        findingCode: 'finding-1',
        severity: 'advisory' as const,
        criterionIds: [rubricRecord.criteria[0]!.criterionId],
        assertionIds: [eligibleId],
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

function buildHappySanitized(options?: {
  readonly allowAdvisory?: boolean;
  readonly includeAdvisoryAssertions?: boolean;
}): {
  readonly request: SanitizedEvaluationRequestV1;
  readonly rubric: EvaluationRubricV1;
  readonly policy: EvaluationPolicyV1;
  readonly roles: EvaluationRunAuthorityV1;
  readonly input: IndependentEvaluationInputV1;
  readonly control: TrustedEvaluationControlSnapshotV1;
  readonly preflight: DeterministicPreflightResultV1;
} {
  const allowAdvisory = options?.allowAdvisory ?? true;
  const includeAdvisory = options?.includeAdvisoryAssertions ?? allowAdvisory;
  const rubricRecord = rubric([
    criterion({
      allowedAdvisoryClasses: allowAdvisory ? ['inference', 'opinion'] : [],
    }),
  ]);
  const policyRecord = policy();
  const runRoles = roles();
  const assertions: DecisionAssertion[] = [
    factAssertion('assertion-eligible-a', 'tests.unit', { passed: true }),
    factAssertion('assertion-eligible-b', 'design.soundness', { passed: true }),
    factAssertion('assertion-other-fact', 'other.fact', { passed: false }),
  ];
  if (includeAdvisory) {
    assertions.push(
      inferenceAssertion('assertion-inference-z', 'design.inference', {
        note: 'likely',
      }),
      opinionAssertion('assertion-opinion-a', 'design.opinion', {
        note: 'nice',
      }),
    );
  }
  const input = inputRecord(assertions);
  const control = controlSnapshot(rubricRecord, policyRecord);
  const preflight = preflightResult();
  const request = buildSanitizedEvaluationRequest({ input, control, preflight });
  return {
    request,
    rubric: rubricRecord,
    policy: policyRecord,
    roles: runRoles,
    input,
    control,
    preflight,
  };
}

describe('buildSanitizedEvaluationRequest', () => {
  it('builds a closed sanitized request with sorted ids and recomputed hashes', () => {
    const built = buildHappySanitized();
    expect(() =>
      assertSanitizedEvaluationRequestV1(built.request, built.rubric),
    ).not.toThrow();
    expect(built.request.schema).toBe('hercules-sanitized-evaluation-request/v1');
    expect(built.request.eligibleAssertions.map((view) => view.assertionId)).toEqual([
      'assertion-eligible-a',
      'assertion-eligible-b',
    ]);
    expect(built.request.advisoryAssertions.map((view) => view.assertionId)).toEqual([
      'assertion-inference-z',
      'assertion-opinion-a',
    ]);
    expect(built.request.advisoryAssertions[0]?.classification).toBe(
      'advisory_inference',
    );
    expect(built.request.advisoryAssertions[1]?.classification).toBe(
      'advisory_opinion',
    );
    expect(built.request.eligibleAssertions.every((view) => view.classification === 'eligible_fact')).toBe(
      true,
    );
    expect(built.request.requestHash).toBe(
      computeSanitizedEvaluationRequestHash(
        (({ requestHash: _omit, ...rest }) => rest)(built.request),
      ),
    );
    expect(built.request).not.toHaveProperty('locatorHints');
    expect(JSON.stringify(built.request)).not.toMatch(/workspace_relative_path/);
  });

  it('rejects non-model_judgment_required preflight', () => {
    const built = buildHappySanitized();
    const checks = PREFLIGHT_CHECK_IDS.slice(0, 1).map((checkId) =>
      preflightCheck(checkId, 'verified_fail', 'deterministic_gate_failed'),
    );
    const badPreflight = preflightResult({
      checks,
      classification: 'verified_fail',
      eligibleAssertionIds: [],
    });
    expect(() =>
      buildSanitizedEvaluationRequest({
        input: built.input,
        control: built.control,
        preflight: badPreflight,
      }),
    ).toThrow(IndependentEvaluationError);
    expect(() =>
      buildSanitizedEvaluationRequest({
        input: built.input,
        control: built.control,
        preflight: badPreflight,
      }),
    ).toThrow(/model_judgment_required/);
  });

  it('omits advisory views entirely when no criterion allows them', () => {
    const built = buildHappySanitized({
      allowAdvisory: false,
      includeAdvisoryAssertions: true,
    });
    expect(built.request.advisoryAssertions).toEqual([]);
    expect(() =>
      assertSanitizedEvaluationRequestV1(built.request, built.rubric),
    ).not.toThrow();
  });

  it('throws when an eligible id is missing from input assertions', () => {
    const built = buildHappySanitized();
    const preflight = preflightResult({
      eligibleAssertionIds: ['assertion-eligible-a', 'assertion-missing'],
    });
    expect(() =>
      buildSanitizedEvaluationRequest({
        input: built.input,
        control: built.control,
        preflight,
      }),
    ).toThrow(/assertion-missing/);
  });
});

describe('runEvaluatorAttempt', () => {
  it('returns a proposal when the evaluator settles before the deadline', async () => {
    const built = buildHappySanitized();
    const { factory, getLastAttempt } = makeFactory();
    const evaluatorDeferred = deferred<EvaluatorProposalV1>();
    const deadlineDeferred = deferred<'deadline_expired'>();
    const proposal = validProposal(built.request, built.rubric, built.roles);
    const evaluatorPort: IndependentEvaluatorPortV1 = {
      evaluate: vi.fn(() => evaluatorDeferred.promise),
    };
    const deadline: EvaluationDeadlinePortV1 = {
      expireAfter: vi.fn(() => deadlineDeferred.promise),
    };

    const pending = runEvaluatorAttempt({
      request: built.request,
      evaluatorPort,
      deadline,
      cancellationFactory: factory,
      policy: built.policy,
      rubric: built.rubric,
      roles: built.roles,
    });
    evaluatorDeferred.resolve(proposal);
    const outcome = await pending;

    expect(outcome.kind).toBe('proposal');
    if (outcome.kind !== 'proposal') {
      return;
    }
    expect(outcome.proposal).toEqual(proposal);
    expect(outcome.dispatches).toHaveLength(1);
    expect(outcome.dispatches[0]?.reason).toBe('peer_settled');
    expect(outcome.dispatches[0]?.signalId).toBe(
      getLastAttempt().deadlineController.signal.signalId,
    );
  });

  it('returns evaluator_unavailable when the deadline settles first', async () => {
    const built = buildHappySanitized();
    const { factory, getLastAttempt } = makeFactory();
    const evaluatorDeferred = deferred<EvaluatorProposalV1>();
    const deadlineDeferred = deferred<'deadline_expired'>();
    const evaluatorPort: IndependentEvaluatorPortV1 = {
      evaluate: vi.fn(() => evaluatorDeferred.promise),
    };
    const deadline: EvaluationDeadlinePortV1 = {
      expireAfter: vi.fn(() => deadlineDeferred.promise),
    };

    const pending = runEvaluatorAttempt({
      request: built.request,
      evaluatorPort,
      deadline,
      cancellationFactory: factory,
      policy: built.policy,
      rubric: built.rubric,
      roles: built.roles,
    });
    deadlineDeferred.resolve('deadline_expired');
    const outcome = await pending;

    expect(outcome).toMatchObject({
      kind: 'infrastructure_gap',
      code: 'evaluator_unavailable',
      evaluatorWasInvoked: true,
    });
    if (outcome.kind !== 'infrastructure_gap') {
      return;
    }
    expect(outcome.dispatches).toHaveLength(1);
    expect(outcome.dispatches[0]?.reason).toBe('deadline');
    expect(outcome.dispatches[0]?.signalId).toBe(
      getLastAttempt().evaluatorController.signal.signalId,
    );
  });

  it('fails closed without invoking the evaluator when createAttempt throws', async () => {
    const built = buildHappySanitized();
    const evaluate = vi.fn();
    const outcome = await runEvaluatorAttempt({
      request: built.request,
      evaluatorPort: { evaluate },
      deadline: { expireAfter: vi.fn() },
      cancellationFactory: {
        createAttempt: () => {
          throw new Error('factory down');
        },
      },
      policy: built.policy,
      rubric: built.rubric,
      roles: built.roles,
    });
    expect(outcome).toMatchObject({
      kind: 'infrastructure_gap',
      code: 'evaluator_unavailable',
      evaluatorWasInvoked: false,
      dispatches: [],
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('fails closed for shared signalId without invoking the evaluator', async () => {
    const built = buildHappySanitized();
    const evaluate = vi.fn();
    const shared = makeController('shared-signal', 'attempt-1');
    const outcome = await runEvaluatorAttempt({
      request: built.request,
      evaluatorPort: { evaluate },
      deadline: { expireAfter: vi.fn() },
      cancellationFactory: {
        createAttempt: () => ({
          attemptId: 'attempt-1',
          evaluatorController: shared,
          deadlineController: shared,
        }),
      },
      policy: built.policy,
      rubric: built.rubric,
      roles: built.roles,
    });
    expect(outcome).toMatchObject({
      kind: 'infrastructure_gap',
      code: 'evaluator_unavailable',
      evaluatorWasInvoked: false,
      dispatches: [],
    });
    expect(String((outcome as { advisoryDetail: string }).advisoryDetail)).toMatch(
      /signalId/,
    );
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('fails closed for mismatched attemptIds without invoking the evaluator', async () => {
    const built = buildHappySanitized();
    const evaluate = vi.fn();
    const outcome = await runEvaluatorAttempt({
      request: built.request,
      evaluatorPort: { evaluate },
      deadline: { expireAfter: vi.fn() },
      cancellationFactory: {
        createAttempt: () => ({
          attemptId: 'attempt-1',
          evaluatorController: makeController('signal-evaluator', 'attempt-1'),
          deadlineController: makeController('signal-deadline', 'attempt-2'),
        }),
      },
      policy: built.policy,
      rubric: built.rubric,
      roles: built.roles,
    });
    expect(outcome).toMatchObject({
      kind: 'infrastructure_gap',
      code: 'evaluator_unavailable',
      evaluatorWasInvoked: false,
      dispatches: [],
    });
    expect(String((outcome as { advisoryDetail: string }).advisoryDetail)).toMatch(
      /attemptId/,
    );
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('fails closed when expireAfter throws synchronously and never calls evaluate', async () => {
    const built = buildHappySanitized();
    const evaluate = vi.fn();
    const outcome = await runEvaluatorAttempt({
      request: built.request,
      evaluatorPort: { evaluate },
      deadline: {
        expireAfter: () => {
          throw new Error('deadline sync boom');
        },
      },
      cancellationFactory: makeFactory().factory,
      policy: built.policy,
      rubric: built.rubric,
      roles: built.roles,
    });
    expect(outcome).toMatchObject({
      kind: 'infrastructure_gap',
      code: 'evaluator_unavailable',
      evaluatorWasInvoked: false,
      dispatches: [],
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('fails closed when expireAfter returns a non-Promise and never calls evaluate', async () => {
    const built = buildHappySanitized();
    const evaluate = vi.fn();
    const outcome = await runEvaluatorAttempt({
      request: built.request,
      evaluatorPort: { evaluate },
      deadline: {
        expireAfter: () => 'deadline_expired' as unknown as Promise<'deadline_expired'>,
      },
      cancellationFactory: makeFactory().factory,
      policy: built.policy,
      rubric: built.rubric,
      roles: built.roles,
    });
    expect(outcome).toMatchObject({
      kind: 'infrastructure_gap',
      code: 'evaluator_unavailable',
      evaluatorWasInvoked: false,
      dispatches: [],
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('records peer_settled and invoked=true when evaluate throws synchronously', async () => {
    const built = buildHappySanitized();
    const { factory, getLastAttempt } = makeFactory();
    const outcome = await runEvaluatorAttempt({
      request: built.request,
      evaluatorPort: {
        evaluate: () => {
          throw new Error('evaluate sync boom');
        },
      },
      deadline: {
        expireAfter: () => deferred<'deadline_expired'>().promise,
      },
      cancellationFactory: factory,
      policy: built.policy,
      rubric: built.rubric,
      roles: built.roles,
    });
    expect(outcome).toMatchObject({
      kind: 'infrastructure_gap',
      code: 'evaluator_unavailable',
      evaluatorWasInvoked: true,
    });
    if (outcome.kind !== 'infrastructure_gap') {
      return;
    }
    expect(outcome.dispatches).toHaveLength(1);
    expect(outcome.dispatches[0]?.reason).toBe('peer_settled');
    expect(outcome.dispatches[0]?.signalId).toBe(
      getLastAttempt().deadlineController.signal.signalId,
    );
  });

  it('dispatches deadline and reports invoked when the deadline promise rejects', async () => {
    const built = buildHappySanitized();
    const { factory, getLastAttempt } = makeFactory();
    const evaluatorDeferred = deferred<EvaluatorProposalV1>();
    const deadlineDeferred = deferred<'deadline_expired'>();
    const pending = runEvaluatorAttempt({
      request: built.request,
      evaluatorPort: { evaluate: () => evaluatorDeferred.promise },
      deadline: { expireAfter: () => deadlineDeferred.promise },
      cancellationFactory: factory,
      policy: built.policy,
      rubric: built.rubric,
      roles: built.roles,
    });
    deadlineDeferred.reject(new Error('deadline reject'));
    const outcome = await pending;
    expect(outcome).toMatchObject({
      kind: 'infrastructure_gap',
      code: 'evaluator_unavailable',
      evaluatorWasInvoked: true,
    });
    if (outcome.kind !== 'infrastructure_gap') {
      return;
    }
    expect(outcome.advisoryDetail).toMatch(/deadline/i);
    expect(outcome.dispatches[0]?.reason).toBe('deadline');
    expect(outcome.dispatches[0]?.signalId).toBe(
      getLastAttempt().evaluatorController.signal.signalId,
    );
  });

  it('dispatches deadline and reports invoked when the deadline resolves a wrong value', async () => {
    const built = buildHappySanitized();
    const { factory } = makeFactory();
    const evaluatorDeferred = deferred<EvaluatorProposalV1>();
    const deadlineDeferred = deferred<'deadline_expired'>();
    const pending = runEvaluatorAttempt({
      request: built.request,
      evaluatorPort: { evaluate: () => evaluatorDeferred.promise },
      deadline: { expireAfter: () => deadlineDeferred.promise },
      cancellationFactory: factory,
      policy: built.policy,
      rubric: built.rubric,
      roles: built.roles,
    });
    deadlineDeferred.resolve('not-expired' as unknown as 'deadline_expired');
    const outcome = await pending;
    expect(outcome).toMatchObject({
      kind: 'infrastructure_gap',
      code: 'evaluator_unavailable',
      evaluatorWasInvoked: true,
    });
    if (outcome.kind !== 'infrastructure_gap') {
      return;
    }
    expect(outcome.advisoryDetail).toMatch(/deadline/i);
    expect(outcome.dispatches[0]?.reason).toBe('deadline');
  });

  it('returns unavailable with peer_settled when the evaluator promise rejects', async () => {
    const built = buildHappySanitized();
    const { factory, getLastAttempt } = makeFactory();
    const evaluatorDeferred = deferred<EvaluatorProposalV1>();
    const deadlineDeferred = deferred<'deadline_expired'>();
    const pending = runEvaluatorAttempt({
      request: built.request,
      evaluatorPort: { evaluate: () => evaluatorDeferred.promise },
      deadline: { expireAfter: () => deadlineDeferred.promise },
      cancellationFactory: factory,
      policy: built.policy,
      rubric: built.rubric,
      roles: built.roles,
    });
    evaluatorDeferred.reject(new Error('provider down'));
    const outcome = await pending;
    expect(outcome).toMatchObject({
      kind: 'infrastructure_gap',
      code: 'evaluator_unavailable',
      evaluatorWasInvoked: true,
    });
    if (outcome.kind !== 'infrastructure_gap') {
      return;
    }
    expect(outcome.dispatches[0]?.reason).toBe('peer_settled');
    expect(outcome.dispatches[0]?.signalId).toBe(
      getLastAttempt().deadlineController.signal.signalId,
    );
  });

  it('does not mutate the outcome when the deadline settles after the evaluator wins', async () => {
    const built = buildHappySanitized();
    const { factory } = makeFactory();
    const evaluatorDeferred = deferred<EvaluatorProposalV1>();
    const deadlineDeferred = deferred<'deadline_expired'>();
    const proposal = validProposal(built.request, built.rubric, built.roles);
    const pending = runEvaluatorAttempt({
      request: built.request,
      evaluatorPort: { evaluate: () => evaluatorDeferred.promise },
      deadline: { expireAfter: () => deadlineDeferred.promise },
      cancellationFactory: factory,
      policy: built.policy,
      rubric: built.rubric,
      roles: built.roles,
    });
    evaluatorDeferred.resolve(proposal);
    const outcome = await pending;
    expect(outcome.kind).toBe('proposal');
    if (outcome.kind !== 'proposal') {
      return;
    }
    const dispatchesBefore = [...outcome.dispatches];
    deadlineDeferred.resolve('deadline_expired');
    await Promise.resolve();
    await Promise.resolve();
    expect(outcome.dispatches).toEqual(dispatchesBefore);
    expect(outcome.kind).toBe('proposal');
  });

  describe('proposal contract violations', () => {
    async function runWithProposal(
      mutate: (
        proposal: EvaluatorProposalV1,
        built: ReturnType<typeof buildHappySanitized>,
      ) => EvaluatorProposalV1,
    ) {
      const built = buildHappySanitized();
      const { factory } = makeFactory();
      const base = validProposal(built.request, built.rubric, built.roles);
      const proposal = mutate(base, built);
      const evaluatorDeferred = deferred<EvaluatorProposalV1>();
      const deadlineDeferred = deferred<'deadline_expired'>();
      const pending = runEvaluatorAttempt({
        request: built.request,
        evaluatorPort: { evaluate: () => evaluatorDeferred.promise },
        deadline: { expireAfter: () => deadlineDeferred.promise },
        cancellationFactory: factory,
        policy: built.policy,
        rubric: built.rubric,
        roles: built.roles,
      });
      evaluatorDeferred.resolve(proposal);
      return pending;
    }

    it('rejects wrong requestId', async () => {
      const outcome = await runWithProposal((proposal) => {
        const withoutHash = { ...proposal, requestId: 'request-other' };
        const { proposalHash: _omit, ...rest } = withoutHash;
        return {
          ...rest,
          proposalHash: computeProposalHash(rest),
        };
      });
      expect(outcome).toMatchObject({
        kind: 'infrastructure_gap',
        code: 'evaluator_contract_violation',
        evaluatorWasInvoked: true,
      });
    });

    it('rejects wrong inputHash', async () => {
      const outcome = await runWithProposal((proposal) => {
        const withoutHash = { ...proposal, inputHash: HASH_B };
        const { proposalHash: _omit, ...rest } = withoutHash;
        return {
          ...rest,
          proposalHash: computeProposalHash(rest),
        };
      });
      expect(outcome).toMatchObject({
        kind: 'infrastructure_gap',
        code: 'evaluator_contract_violation',
        evaluatorWasInvoked: true,
      });
    });

    it('rejects wrong evaluator run id', async () => {
      const outcome = await runWithProposal((proposal) => {
        const withoutHash = { ...proposal, evaluatorRunId: 'evaluator-other' };
        const { proposalHash: _omit, ...rest } = withoutHash;
        return {
          ...rest,
          proposalHash: computeProposalHash(rest),
        };
      });
      expect(outcome).toMatchObject({
        kind: 'infrastructure_gap',
        code: 'evaluator_contract_violation',
        evaluatorWasInvoked: true,
      });
    });

    it('rejects a premise citing an advisory assertion id', async () => {
      const outcome = await runWithProposal((proposal, built) => {
        const advisoryId = built.request.advisoryAssertions[0]!.assertionId;
        const criterionProposals = proposal.criterionProposals.map((item) => ({
          ...item,
          premiseAssertionIds: [advisoryId],
        }));
        const withoutHash = { ...proposal, criterionProposals };
        const { proposalHash: _omit, ...rest } = withoutHash;
        return {
          ...rest,
          proposalHash: computeProposalHash(rest),
        };
      });
      expect(outcome).toMatchObject({
        kind: 'infrastructure_gap',
        code: 'evaluator_contract_violation',
        evaluatorWasInvoked: true,
      });
    });

    it('rejects a premise citing an unknown id', async () => {
      const outcome = await runWithProposal((proposal) => {
        const criterionProposals = proposal.criterionProposals.map((item) => ({
          ...item,
          premiseAssertionIds: ['assertion-unknown'],
        }));
        const withoutHash = { ...proposal, criterionProposals };
        const { proposalHash: _omit, ...rest } = withoutHash;
        return {
          ...rest,
          proposalHash: computeProposalHash(rest),
        };
      });
      expect(outcome).toMatchObject({
        kind: 'infrastructure_gap',
        code: 'evaluator_contract_violation',
        evaluatorWasInvoked: true,
      });
    });

    it('rejects a finding citing an unknown assertion id', async () => {
      const outcome = await runWithProposal((proposal) => {
        const findings = proposal.findings.map((finding) => ({
          ...finding,
          assertionIds: ['assertion-unknown-finding'],
        }));
        const withoutHash = { ...proposal, findings };
        const { proposalHash: _omit, ...rest } = withoutHash;
        return {
          ...rest,
          proposalHash: computeProposalHash(rest),
        };
      });
      expect(outcome).toMatchObject({
        kind: 'infrastructure_gap',
        code: 'evaluator_contract_violation',
        evaluatorWasInvoked: true,
      });
    });

    it('rejects a malformed proposal record with an extra field', async () => {
      const outcome = await runWithProposal((proposal) => {
        return {
          ...proposal,
          extraField: 'nope',
        } as unknown as EvaluatorProposalV1;
      });
      expect(outcome).toMatchObject({
        kind: 'infrastructure_gap',
        code: 'evaluator_contract_violation',
        evaluatorWasInvoked: true,
      });
    });
  });
});
