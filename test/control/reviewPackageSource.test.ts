import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSerialize } from '../../src/domain/canonicalJson.js';
import {
  applyApprovedContractChange,
  type ContractChangeRequest,
  type TrustedContractChangeAuthority,
} from '../../src/domain/contractChange.js';
import {
  UNEVALUATED_EVALUATOR_MODEL,
  UNEVALUATED_EVALUATOR_RUNTIME,
  UNEVALUATED_EVALUATOR_VERSION,
} from '../../src/domain/evaluatorSentinels.js';
import type { HumanDecision } from '../../src/domain/humanDecision.js';
import {
  computeCancellationDispatchHash,
  computeCriterionRelationshipHash,
  computeEvaluationReceiptHash,
  computeVerdictHash,
  type EvaluationCancellationDispatchV1,
  type EvaluationCriterionRelationshipV1,
  type IndependentEvaluationReceiptV1,
} from '../../src/domain/independentEvaluation.js';
import type { Iteration } from '../../src/domain/iteration.js';
import {
  projectAndAssertReviewPackageV2,
  ReviewPackageV2Error,
  type ReviewPackageV2Source,
} from '../../src/domain/reviewPackageV2.js';
import {
  compileM4LegacyContract,
  projectLegacyTask,
} from '../../src/domain/shadowProjection.js';
import type { Task } from '../../src/domain/task.js';
import { buildEligibleControlApiV2ReviewSource } from '../../src/isolation/controlApiV2ReviewSeed.js';
import {
  assembleReviewPackageSource,
  createReviewPackageRefreshSeam,
  REVIEW_PACKAGE_SOURCE_VERIFIER,
  type AuthorityRoster,
} from '../../src/control/reviewPackageSource.js';
import { deliverShadowProjection } from '../../src/control/state/shadowReconciler.js';
import { SqliteStateStore } from '../../src/control/state/sqliteStateStore.js';
import type {
  ReviewPackageRefreshInput,
  ShadowTaskState,
  V2BoundEvaluationV1,
  V2BoundEvidenceV1,
} from '../../src/control/state/stateStore.js';
import {
  computeV2BoundEvaluationHash,
  computeV2BoundEvidenceHash,
} from '../../src/control/state/stateStoreValidation.js';

const FIXED_CLOCK = '2026-09-04T12:00:00.000Z';
const REVISION = 'a'.repeat(40);
const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Project ${id}`,
    repo: 'app',
    state: 'todo',
    priority: 1,
    blockedBy: [],
    labels: [],
    adapter: null,
    agentSession: null,
    pendingSteer: null,
    attempts: 0,
    lastEventAt: null,
    createdAt: '2026-08-28T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    prUrl: null,
    prStatus: null,
    planPending: false,
    verifiedSha: null,
    body: '## Definition of Done\n- [ ] (mechanical) tests pass @gate:test',
    ...overrides,
  };
}

function shadowFromLegacy(item: Task): ShadowTaskState {
  const projection = projectLegacyTask(item, REVISION, null);
  return {
    taskId: item.id,
    contracts: [projection.expectedContract],
    iterations: projection.expectedIterations,
    stageRuns: [],
    retirement: null,
  };
}

function refreshInput(
  shadow: ShadowTaskState,
  overrides: Partial<ReviewPackageRefreshInput> = {},
): ReviewPackageRefreshInput {
  return {
    aggregateId: shadow.taskId,
    taskStatus: 'todo',
    shadow,
    humanDecisions: [],
    evidence: null,
    evaluation: null,
    ...overrides,
  };
}

function successorContract(current: ReturnType<typeof compileM4LegacyContract>) {
  const change: ContractChangeRequest = {
    id: 'change-1',
    taskId: current.taskId,
    baseContractVersion: current.version,
    requestedBy: { kind: 'human', id: 'owner' },
    reason: 'Bridge tip contract for selection test',
    proposedPatch: [{ op: 'replace', path: '/objective', value: 'Tip contract v2' }],
    meaningChange: true,
    riskChange: false,
    status: 'approved',
    policyDecisionId: 'policy-1',
    humanDecisionId: null,
  };
  const trusted: TrustedContractChangeAuthority = {
    approvedRequestId: 'change-1',
    policyDecisionId: 'policy-1',
    humanDecisionId: null,
  };
  return applyApprovedContractChange(
    current,
    change,
    {
      createdBy: { kind: 'control_plane', id: 'contract-change' },
      createdAt: '2026-08-28T01:00:00.000Z',
    },
    trusted,
  );
}

describe('assembleReviewPackageSource (C2.3)', () => {
  it('(a) projects a live single-iteration task with honest C2 degraded fields', () => {
    const item = task('live-1');
    const shadow = shadowFromLegacy(item);
    const assembled = assembleReviewPackageSource(
      refreshInput(shadow, { taskStatus: 'todo' }),
      FIXED_CLOCK,
    );
    expect(assembled.kind).toBe('source');
    if (assembled.kind !== 'source') return;

    expect(assembled.source.task).toEqual({
      id: 'live-1',
      title: 'Project live-1',
      state: 'todo',
    });
    expect(assembled.source.currentBinding).toMatchObject({
      taskId: 'live-1',
      contractVersion: 1,
      iterationId: shadow.iterations[0]!.id,
      candidateRef: null,
      evidenceManifestHash: null,
      evaluatorVersion: UNEVALUATED_EVALUATOR_VERSION,
      evaluatorModel: UNEVALUATED_EVALUATOR_MODEL,
      evaluatorRuntime: UNEVALUATED_EVALUATOR_RUNTIME,
      policyVersion: 'm4-legacy-bridge-v1',
    });
    expect(assembled.source.evidenceManifest).toBeNull();
    expect(assembled.source.artifacts).toEqual([]);
    expect(assembled.source.assertions).toEqual([]);
    expect(assembled.source.verificationReceipts).toEqual([]);
    expect(assembled.source.evaluation).toBeNull();
    expect(assembled.source.usage).toBeNull();
    expect(assembled.source.evidenceIntegrity).toMatchObject({
      schema: 'hercules-evidence-integrity-attestation/v1',
      result: 'unavailable',
      evidenceManifestId: null,
      evidenceManifestHash: null,
      candidateRef: null,
      checkedArtifacts: [],
      verifierImplementation: REVIEW_PACKAGE_SOURCE_VERIFIER,
      checkedAt: FIXED_CLOCK,
    });
    expect(assembled.source.authorityContext).toEqual({
      trustedVerifierRunIds: [],
      implementerRunIds: [],
      reviewerRunIds: [],
      evaluatorRunIds: [],
      agentClaimProducerRunIds: [],
      evaluationAuthority: {
        evaluatorAgentRunId: null,
        implementerAgentRunIds: [],
      },
    });

    const seam = createReviewPackageRefreshSeam(() => FIXED_CLOCK);
    const result = seam(refreshInput(shadow, { taskStatus: 'todo' }));
    expect(result.kind).toBe('projected');
    if (result.kind !== 'projected') return;
    expect(result.reviewPackage.task).toMatchObject({
      id: 'live-1',
      title: 'Project live-1',
      state: 'todo',
    });
    expect(result.reviewPackage.outcome.decisionEligible).toBe(false);
    expect(result.reviewPackage.outcome.reasonCodes).toContain('unsupported_policy_decision');
    expect(result.reviewPackage.binding.evaluatorVersion).toBe(UNEVALUATED_EVALUATOR_VERSION);
    expect(result.reviewPackage.binding.evaluatorModel).toBe(UNEVALUATED_EVALUATOR_MODEL);
    expect(result.reviewPackage.binding.evaluatorRuntime).toBe(UNEVALUATED_EVALUATOR_RUNTIME);
  });

  it('(b) refuses empty iteration history as empty_iteration_history', () => {
    const item = task('gap-1', { state: 'failed', attempts: 3 });
    const shadow = shadowFromLegacy(item);
    expect(shadow.iterations).toEqual([]);
    const assembled = assembleReviewPackageSource(refreshInput(shadow), FIXED_CLOCK);
    expect(assembled).toMatchObject({
      kind: 'unprojectable',
      reason: 'empty_iteration_history',
    });
    const seam = createReviewPackageRefreshSeam(() => FIXED_CLOCK);
    expect(seam(refreshInput(shadow))).toEqual({
      kind: 'unprojectable',
      reason: 'empty_iteration_history',
    });
  });

  it('(c) refuses an iteration bound to a missing contract version', () => {
    const item = task('missing-contract');
    const shadow = shadowFromLegacy(item);
    const orphaned: ShadowTaskState = {
      ...shadow,
      iterations: [{ ...shadow.iterations[0]!, contractVersion: 99 }],
    };
    const assembled = assembleReviewPackageSource(refreshInput(orphaned), FIXED_CLOCK);
    expect(assembled).toMatchObject({
      kind: 'unprojectable',
      reason: 'missing_contract',
    });
  });

  it('(d) selects the contract bound by the CURRENT iteration, not the tip', () => {
    const item = task('bound-v1');
    const shadow = shadowFromLegacy(item);
    const v1 = shadow.contracts[0]!;
    const v2 = successorContract(v1);
    const dual: ShadowTaskState = {
      ...shadow,
      contracts: [v1, v2],
    };
    expect(shadow.iterations[0]!.contractVersion).toBe(1);
    const assembled = assembleReviewPackageSource(refreshInput(dual), FIXED_CLOCK);
    expect(assembled.kind).toBe('source');
    if (assembled.kind !== 'source') return;
    expect(assembled.source.contract.version).toBe(1);
    expect(assembled.source.contract.contractHash).toBe(v1.contractHash);
    expect(assembled.source.task.title).toBe(v1.objective);
    expect(assembled.source.currentBinding.contractVersion).toBe(1);
  });

  it('(e) surfaces projector refusal for non-null evidenceManifestId as invalid_source', () => {
    const item = task('manifest-id');
    const shadow = shadowFromLegacy(item);
    const poisoned: ShadowTaskState = {
      ...shadow,
      iterations: [{ ...shadow.iterations[0]!, evidenceManifestId: 'manifest-1' }],
    };
    const seam = createReviewPackageRefreshSeam(() => FIXED_CLOCK);
    expect(seam(refreshInput(poisoned))).toEqual({
      kind: 'unprojectable',
      reason: 'invalid_source',
    });
  });

  it('(f) surfaces non-failed non-tip history as invalid_source', () => {
    const item = task('history-gap');
    const shadow = shadowFromLegacy(item);
    const first = shadow.iterations[0]!;
    const second: Iteration = {
      ...first,
      id: `${first.id}-next`,
      ordinal: 2,
      state: 'planned',
      supersedesIterationId: first.id,
      createdAt: '2026-08-28T01:00:00.000Z',
    };
    const badHistory: ShadowTaskState = {
      ...shadow,
      iterations: [first, second],
    };
    const seam = createReviewPackageRefreshSeam(() => FIXED_CLOCK);
    expect(seam(refreshInput(badHistory))).toEqual({
      kind: 'unprojectable',
      reason: 'invalid_source',
    });
  });

  it('(g) does not swallow non-ReviewPackageV2Error throws from the projector path', () => {
    const item = task('loud-infra');
    const shadow = shadowFromLegacy(item);
    const seam = createReviewPackageRefreshSeam(
      () => FIXED_CLOCK,
      () => {
        throw new TypeError('simulated projector infrastructure failure');
      },
    );
    expect(() => seam(refreshInput(shadow))).toThrow(TypeError);
    expect(() => seam(refreshInput(shadow))).toThrow('simulated projector infrastructure failure');
  });

  it('(h) is deterministic for the same input and projectedAt', () => {
    const item = task('determinism');
    const shadow = shadowFromLegacy(item);
    const input = refreshInput(shadow);
    const left = assembleReviewPackageSource(input, FIXED_CLOCK);
    const right = assembleReviewPackageSource(input, FIXED_CLOCK);
    expect(left.kind).toBe('source');
    expect(right.kind).toBe('source');
    if (left.kind !== 'source' || right.kind !== 'source') return;
    expect(canonicalSerialize(left.source)).toBe(canonicalSerialize(right.source));
  });

  it('(i) passes humanDecisions through into the package human projection', () => {
    const item = task('human-pass', {
      body:
        '## Definition of Done\n' +
        '- [ ] (mechanical) tests pass @gate:test\n' +
        '- [ ] (human) owner accepts the outcome\n',
    });
    const shadow = shadowFromLegacy(item);
    const assembledBare = assembleReviewPackageSource(refreshInput(shadow), FIXED_CLOCK);
    expect(assembledBare.kind).toBe('source');
    if (assembledBare.kind !== 'source') return;

    const staleDecision: HumanDecision = {
      id: 'hd-stale-1',
      binding: {
        ...assembledBare.source.currentBinding,
        candidateRef: {
          kind: 'git',
          repository: 'app',
          revision: 'b'.repeat(40),
        },
        evidenceManifestHash: `sha256:${'c'.repeat(64)}`,
        evaluatorVersion: 'stale-evaluator',
      },
      decision: 'approve_outcome',
      comment: null,
      actor: { kind: 'human', id: 'owner' },
      createdAt: FIXED_CLOCK,
    };
    const input = refreshInput(shadow, { humanDecisions: [staleDecision] });
    const assembled = assembleReviewPackageSource(input, FIXED_CLOCK);
    expect(assembled.kind).toBe('source');
    if (assembled.kind !== 'source') return;
    expect(assembled.source.humanDecisions).toEqual([staleDecision]);

    const packageValue = projectAndAssertReviewPackageV2(assembled.source);
    const humanCriterion = packageValue.criteria.find((row) => row.authority === 'human');
    expect(humanCriterion?.reasonCodes).toEqual(
      expect.arrayContaining(['human_decision_required', 'human_decision_stale']),
    );
    expect(packageValue.trustAxes.human.reasonCodes).toEqual(
      expect.arrayContaining(['human_decision_stale', 'unsupported_policy_decision']),
    );
  });
});

describe('createReviewPackageRefreshSeam store integration (C2.3 j)', () => {
  it('projects a delivered live task and marks empty-history delivery unprojectable', () => {
    const parent = mkdtempSync(join(tmpdir(), 'hercules-review-package-source-'));
    cleanup.push(parent);
    const root = join(parent, 'state');
    const store = new SqliteStateStore({
      trustedRoot: root,
      databasePath: join(root, 'shadow.sqlite'),
      busyTimeoutMs: 100,
      clock: () => FIXED_CLOCK,
      refreshReviewPackage: createReviewPackageRefreshSeam(() => FIXED_CLOCK),
    });
    store.initialize();

    const live = task('seam-live');
    deliverShadowProjection(store, {
      deliveryId: 'delivery-live',
      revision: REVISION,
      writes: [live],
      retiredTaskIds: [],
    });
    const liveAggregate = store.readV2Aggregate('seam-live');
    expect(liveAggregate).toMatchObject({
      projectionState: 'projected',
      unprojectableReason: null,
    });
    expect(liveAggregate?.reviewPackage).not.toBeNull();
    expect(liveAggregate?.projectionHash).toBe(liveAggregate?.reviewPackage?.projectionHash);
    expect(liveAggregate?.reviewPackage?.outcome.decisionEligible).toBe(false);
    expect(liveAggregate?.reviewPackage?.outcome.reasonCodes).toContain(
      'unsupported_policy_decision',
    );

    const gap = task('seam-gap', { state: 'failed', attempts: 3 });
    deliverShadowProjection(store, {
      deliveryId: 'delivery-gap',
      revision: REVISION,
      writes: [gap],
      retiredTaskIds: [],
    });
    expect(store.readTask('seam-gap')?.iterations).toEqual([]);
    expect(store.readV2Aggregate('seam-gap')).toMatchObject({
      projectionState: 'unprojectable',
      unprojectableReason: 'empty_iteration_history',
      projectionHash: null,
      reviewPackage: null,
    });

    store.close();
  });

  it('maps ReviewPackageV2Error codes and keeps other errors loud', () => {
    const item = task('error-map');
    const shadow = shadowFromLegacy(item);
    const invalidSource = createReviewPackageRefreshSeam(
      () => FIXED_CLOCK,
      () => {
        throw new ReviewPackageV2Error('invalid_source', 'forced invalid_source');
      },
    );
    expect(invalidSource(refreshInput(shadow))).toEqual({
      kind: 'unprojectable',
      reason: 'invalid_source',
    });
    const invalidPackage = createReviewPackageRefreshSeam(
      () => FIXED_CLOCK,
      () => {
        throw new ReviewPackageV2Error('invalid_package', 'forced invalid_package');
      },
    );
    expect(invalidPackage(refreshInput(shadow))).toEqual({
      kind: 'unprojectable',
      reason: 'invalid_package',
    });
  });
});

describe('assembleReviewPackageSource purity', () => {
  it('never throws on malformed-but-typed shadow task data', () => {
    const item = task('pure');
    const shadow = shadowFromLegacy(item);
    const weird: ShadowTaskState = {
      ...shadow,
      contracts: [],
      iterations: [{ ...shadow.iterations[0]!, contractVersion: 1 }],
    };
    expect(() => assembleReviewPackageSource(refreshInput(weird), FIXED_CLOCK)).not.toThrow();
    expect(assembleReviewPackageSource(refreshInput(weird), FIXED_CLOCK).kind).toBe(
      'unprojectable',
    );
  });

  it('keeps REVIEW_PACKAGE_SOURCE_VERIFIER pinned', () => {
    expect(REVIEW_PACKAGE_SOURCE_VERIFIER).toBe('hercules-control/reviewPackageSource/v1');
  });
});

const HASH_A =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B =
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C =
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

const C3_ROSTER: AuthorityRoster = {
  schema: 'hercules-authority-roster/v1',
  verifier: { runId: 'verifier-1', implementation: 'fixture-v1' },
  evaluator: {
    runId: 'evaluator-1',
    implementationId: 'evaluator-impl-1',
    version: 'evaluator-v1',
    model: 'model-v1',
    runtime: 'runtime-v1',
  },
};

function shadowFromEligibleSeed(taskId: string): {
  readonly source: ReviewPackageV2Source;
  readonly shadow: ShadowTaskState;
} {
  const source = buildEligibleControlApiV2ReviewSource(taskId);
  const storedIteration: Iteration = {
    ...source.currentIteration,
    state: 'verifying',
    evidenceManifestId: null,
    finalVerdictId: null,
    endedAt: null,
  };
  return {
    source,
    shadow: {
      taskId,
      contracts: [source.contract],
      iterations: [storedIteration],
      stageRuns: [],
      retirement: null,
    },
  };
}

function c3CancellationDispatch(): EvaluationCancellationDispatchV1 {
  const withoutHash = {
    signalId: 'signal-1',
    attemptId: 'attempt-1',
    reason: 'peer_settled' as const,
    status: 'dispatched' as const,
    dispatchedAt: '2026-08-29T00:00:15.000Z',
  };
  return {
    ...withoutHash,
    dispatchHash: computeCancellationDispatchHash(withoutHash),
  };
}

function c3CriterionRelationship(): EvaluationCriterionRelationshipV1 {
  const withoutHash = {
    criterionId: 'criterion-1',
    assertionIds: ['assertion-1'],
    evidenceArtifactIds: ['artifact-1'],
    verificationReceiptIds: ['receipt-1'],
  };
  return {
    ...withoutHash,
    relationshipHash: computeCriterionRelationshipHash(withoutHash),
  };
}

function c3AlignedEvaluation(source: ReviewPackageV2Source): NonNullable<ReviewPackageV2Source['evaluation']> {
  const evaluation = source.evaluation;
  if (evaluation === null) throw new Error('seed evaluation required');
  // Assembler currentBinding.policyVersion comes from contract.approvalPolicy.version
  // (`approval-v1`); rewrite the seed verdict binding so evaluation is not stale.
  const verdict = {
    ...evaluation.verdict,
    binding: {
      ...evaluation.verdict.binding,
      policyVersion: source.contract.approvalPolicy.version,
    },
  };
  return { ...evaluation, verdict };
}

function c3EvaluationReceipt(source: ReviewPackageV2Source): IndependentEvaluationReceiptV1 {
  const evaluation = c3AlignedEvaluation(source);
  const verdict = evaluation.verdict;
  const candidate = source.evidenceManifest!.candidateRef;
  if (candidate.kind !== 'git') throw new Error('seed candidate must be git');
  const withoutHash = {
    schema: 'hercules-independent-evaluation-receipt/v1' as const,
    receiptId: 'receipt-eval-1',
    requestId: 'request-1',
    inputHash: HASH_A,
    taskId: source.task.id,
    taskContractHash: source.contract.contractHash,
    iterationId: source.currentIteration.id,
    candidateCommit: candidate.revision,
    manifestId: source.evidenceManifest!.id,
    manifestHash: source.evidenceManifest!.manifestHash,
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
    proposalHash: null,
    noProposalReason: 'deterministic_pass' as const,
    cancellationDispatches: [c3CancellationDispatch()],
    verdict,
    verdictHash: computeVerdictHash(verdict),
    criterionRelationships: [c3CriterionRelationship()],
    outcomeReasonCodes: ['criterion-pass'],
    createdAt: FIXED_CLOCK,
  };
  return {
    ...withoutHash,
    receiptHash: computeEvaluationReceiptHash(withoutHash),
  };
}

function boundEvidenceRecord(source: ReviewPackageV2Source): V2BoundEvidenceV1 {
  const candidate = source.evidenceManifest!.candidateRef;
  const withoutHash: Omit<V2BoundEvidenceV1, 'evidenceHash'> = {
    schema: 'hercules-v2-bound-evidence/v1',
    aggregateId: source.task.id,
    iterationId: source.currentIteration.id,
    candidateRef: candidate,
    evidenceManifest: source.evidenceManifest!,
    artifacts: source.artifacts,
    assertions: source.assertions,
    verificationReceipts: source.verificationReceipts,
    evidenceIntegrity: source.evidenceIntegrity,
    producer: { implementation: 'fixture-v1', verifierRunId: 'verifier-1' },
    recordedAt: FIXED_CLOCK,
  };
  return {
    ...withoutHash,
    evidenceHash: computeV2BoundEvidenceHash(withoutHash),
  };
}

function boundEvaluationRecord(
  source: ReviewPackageV2Source,
  evidenceHash: string,
  overrides: Partial<Omit<V2BoundEvaluationV1, 'evaluationHash'>> = {},
): V2BoundEvaluationV1 {
  const evaluation = c3AlignedEvaluation(source);
  const withoutHash: Omit<V2BoundEvaluationV1, 'evaluationHash'> = {
    schema: 'hercules-v2-bound-evaluation/v1',
    aggregateId: source.task.id,
    iterationId: source.currentIteration.id,
    evidenceHash,
    receipt: c3EvaluationReceipt(source),
    evaluation,
    evaluator: {
      runId: 'evaluator-1',
      implementationId: 'evaluator-impl-1',
      version: 'evaluator-v1',
      model: 'model-v1',
      runtime: 'runtime-v1',
    },
    recordedAt: FIXED_CLOCK,
    ...overrides,
  };
  return {
    ...withoutHash,
    evaluationHash: computeV2BoundEvaluationHash(withoutHash),
  };
}

describe('assembleReviewPackageSource (C3.0 bound truth)', () => {
  it('(a) degraded null evidence/evaluation path stays byte-identical across projections', () => {
    // Proves the C3 overlay does not change the null-evidence/null-evaluation path.
    const item = task('c3-degraded');
    const shadow = shadowFromLegacy(item);
    const input = refreshInput(shadow, {
      taskStatus: 'todo',
      evidence: null,
      evaluation: null,
    });
    const seam = createReviewPackageRefreshSeam(() => FIXED_CLOCK);
    const first = seam(input);
    const second = seam(input);
    expect(first.kind).toBe('projected');
    expect(second.kind).toBe('projected');
    if (first.kind !== 'projected' || second.kind !== 'projected') return;
    expect(first.reviewPackage.projectionHash).toBe(second.reviewPackage.projectionHash);
    expect(canonicalSerialize(first.reviewPackage)).toBe(canonicalSerialize(second.reviewPackage));
  });

  it('(b) bound evidence only projects intact evidence with unverified_pending assertions', () => {
    const { source, shadow } = shadowFromEligibleSeed('c3-evidence-only');
    const evidence = boundEvidenceRecord(source);
    const assembled = assembleReviewPackageSource(
      refreshInput(shadow, {
        taskStatus: 'review',
        evidence,
        evaluation: null,
      }),
      FIXED_CLOCK,
      C3_ROSTER,
    );
    expect(assembled.kind).toBe('source');
    if (assembled.kind !== 'source') return;
    expect(assembled.source.evidenceIntegrity.result).toBe('intact');
    expect(assembled.source.currentIteration.evidenceManifestId).toBe(evidence.evidenceManifest.id);
    expect(shadow.iterations[0]!.evidenceManifestId).toBeNull();
    // Nested evaluatorAgentRunId is null without a bound evaluation → evaluatorRunIds stay empty
    // (claimAuthorityV2 requires that pairing; item 10 roster-declared form is deferred).
    expect(assembled.source.authorityContext.evaluatorRunIds).toEqual([]);
    expect(assembled.source.authorityContext.evaluationAuthority.evaluatorAgentRunId).toBeNull();

    const seam = createReviewPackageRefreshSeam(() => FIXED_CLOCK, { roster: C3_ROSTER });
    const result = seam(refreshInput(shadow, {
      taskStatus: 'review',
      evidence,
      evaluation: null,
    }));
    expect(result.kind).toBe('projected');
    if (result.kind !== 'projected') return;
    expect(result.reviewPackage.assertions.every(
      (assertion) => assertion.classification === 'unverified_pending',
    )).toBe(true);
    expect(result.reviewPackage.validDecisions).toEqual([]);
    expect(result.reviewPackage.outcome.decisionEligible).toBe(false);
    expect(result.reviewPackage.decisionBinding).toBeNull();
  });

  it('(c) evidence + evaluation + roster is decision-eligible under approve_outcome', () => {
    // C3.4 bridges the real M4 lock contract; this test uses the seed contract with
    // requiredDecisions: ['approve_outcome'].
    const { source, shadow } = shadowFromEligibleSeed('c3-decision-eligible');
    const evidence = boundEvidenceRecord(source);
    const evaluation = boundEvaluationRecord(source, evidence.evidenceHash);
    const seam = createReviewPackageRefreshSeam(() => FIXED_CLOCK, { roster: C3_ROSTER });
    const result = seam(refreshInput(shadow, {
      taskStatus: 'review',
      evidence,
      evaluation,
    }));
    expect(result.kind).toBe('projected');
    if (result.kind !== 'projected') return;
    expect(result.reviewPackage.validDecisions.length).toBeGreaterThan(0);
    expect(result.reviewPackage.outcome.decisionEligible).toBe(true);
    expect(result.reviewPackage.decisionBinding).not.toBeNull();
    expect(source.contract.approvalPolicy.requiredDecisions).toEqual(['approve_outcome']);
  });

  it('(d) evaluator fields that disagree with receipt.verdict.binding are unprojectable', () => {
    const { source, shadow } = shadowFromEligibleSeed('c3-eval-disagree');
    const evidence = boundEvidenceRecord(source);
    const evaluation = boundEvaluationRecord(source, evidence.evidenceHash, {
      evaluator: {
        runId: 'evaluator-1',
        implementationId: 'evaluator-impl-1',
        version: 'evaluator-wrong',
        model: 'model-v1',
        runtime: 'runtime-v1',
      },
    });
    const assembled = assembleReviewPackageSource(
      refreshInput(shadow, {
        taskStatus: 'review',
        evidence,
        evaluation,
      }),
      FIXED_CLOCK,
      C3_ROSTER,
    );
    expect(assembled).toMatchObject({
      kind: 'unprojectable',
      reason: 'invalid_source',
    });
    const seam = createReviewPackageRefreshSeam(() => FIXED_CLOCK, { roster: C3_ROSTER });
    expect(seam(refreshInput(shadow, {
      taskStatus: 'review',
      evidence,
      evaluation,
    }))).toEqual({
      kind: 'unprojectable',
      reason: 'invalid_source',
    });
  });

  it('(d2) evaluation.verdict.binding that disagrees with shadow taskId is unprojectable', () => {
    const { source, shadow } = shadowFromEligibleSeed('c3-eval-binding-mismatch');
    const evidence = boundEvidenceRecord(source);
    const base = boundEvaluationRecord(source, evidence.evidenceHash);
    const tamperedVerdict = {
      ...base.evaluation.verdict,
      binding: {
        ...base.evaluation.verdict.binding,
        taskId: 'other-task',
      },
    };
    const evaluation = boundEvaluationRecord(source, evidence.evidenceHash, {
      evaluation: {
        ...base.evaluation,
        verdict: tamperedVerdict,
      },
    });
    const assembled = assembleReviewPackageSource(
      refreshInput(shadow, {
        taskStatus: 'review',
        evidence,
        evaluation,
      }),
      FIXED_CLOCK,
      C3_ROSTER,
    );
    expect(assembled).toMatchObject({
      kind: 'unprojectable',
      reason: 'invalid_source',
    });
  });

  it('(e) evaluation bound to a different evidenceHash is ignored', () => {
    const { source, shadow } = shadowFromEligibleSeed('c3-eval-ignored');
    const evidence = boundEvidenceRecord(source);
    const evaluation = boundEvaluationRecord(
      source,
      `sha256:${'f'.repeat(64)}`,
    );
    const assembled = assembleReviewPackageSource(
      refreshInput(shadow, {
        taskStatus: 'review',
        evidence,
        evaluation,
      }),
      FIXED_CLOCK,
      C3_ROSTER,
    );
    expect(assembled.kind).toBe('source');
    if (assembled.kind !== 'source') return;
    expect(assembled.source.evaluation).toBeNull();
    expect(assembled.source.currentBinding.evaluatorVersion).toBe(UNEVALUATED_EVALUATOR_VERSION);
    expect(assembled.source.currentBinding.evaluatorModel).toBe(UNEVALUATED_EVALUATOR_MODEL);
    expect(assembled.source.currentBinding.evaluatorRuntime).toBe(UNEVALUATED_EVALUATOR_RUNTIME);
    expect(assembled.source.authorityContext.evaluationAuthority.evaluatorAgentRunId).toBeNull();
  });
});
