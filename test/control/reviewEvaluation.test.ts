/**
 * C3.3 — production review-evaluation runtime over a real SqliteStateStore.
 *
 * Contract approvalPolicy.requiredDecisions is `['approve_outcome']` (the
 * post-C3.4 shape). Bound evidence follows the C3.1a assertion grammar:
 * `gate:<name>` and `criterion:<id>` facts with roster-verifier receipts.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashCanonicalJson } from '../../src/domain/canonicalJson.js';
import {
  computeAssertionPayloadHash,
  computeEvidenceIntegrityAttestationHash,
  computeVerificationReceiptHash,
  type DecisionAssertion,
} from '../../src/domain/claimAuthorityV2.js';
import { computeTaskContractHash } from '../../src/domain/contractHash.js';
import { transitionIteration, type Iteration } from '../../src/domain/iteration.js';
import type { ArtifactRef, EvidenceManifest } from '../../src/domain/artifact.js';
import type { Task } from '../../src/domain/task.js';
import type { TaskContract } from '../../src/domain/taskContract.js';
import type { AuthorityRoster } from '../../src/control/authorityRoster.js';
import { createReviewPackageRefreshSeam } from '../../src/control/reviewPackageSource.js';
import type { EvaluationVerdict } from '../../src/domain/evaluationVerdict.js';
import type { DeterministicGateReceiptV1 } from '../../src/domain/independentEvaluation.js';
import {
  REVIEW_EVALUATION_AUTHORITY_EPOCH,
  REVIEW_EVALUATION_CAPABILITY_IDS,
  REVIEW_EVALUATION_COORDINATOR_RUN_ID,
  attributeUnnamedGateFailures,
  createUnavailableEvaluatorPort,
  evaluateAllAwaiting,
  evaluateReviewAggregate,
  type ReviewEvaluationPorts,
} from '../../src/control/reviewEvaluation.js';
import { SqliteStateStore } from '../../src/control/state/sqliteStateStore.js';
import type {
  ShadowCommitCommand,
  V2BoundEvidenceV1,
} from '../../src/control/state/stateStore.js';

const FIXED_CLOCK = '2026-09-05T12:00:00.000Z';
const ACTOR = { kind: 'control_plane' as const, id: 'review-evaluation-test' };
const CANDIDATE = {
  kind: 'git' as const,
  repository: 'example-org/acme',
  revision: '0123456789abcdef0123456789abcdef01234567',
};
const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const ROSTER: AuthorityRoster = {
  schema: 'hercules-authority-roster/v1',
  verifier: { runId: 'verifier-prod-1', implementation: 'hercules-l1-gates' },
  evaluator: {
    runId: 'evaluator-prod-1',
    implementationId: 'independent-evaluation-v1',
    version: '1.0.0',
    model: null,
    runtime: 'node22',
  },
};

interface Paths {
  readonly parent: string;
  readonly root: string;
  readonly database: string;
}

function paths(): Paths {
  const parent = mkdtempSync(join(tmpdir(), 'hercules-review-eval-'));
  cleanup.push(parent);
  const root = join(parent, 'state');
  return { parent, root, database: join(root, 'shadow.sqlite') };
}

function storeAt(target: Paths): SqliteStateStore {
  return new SqliteStateStore({
    trustedRoot: target.root,
    databasePath: target.database,
    busyTimeoutMs: 100,
    clock: () => FIXED_CLOCK,
    refreshReviewPackage: createReviewPackageRefreshSeam(() => FIXED_CLOCK, {
      roster: ROSTER,
    }),
  });
}

function portsFor(
  store: SqliteStateStore,
  overrides: Partial<ReviewEvaluationPorts> = {},
): ReviewEvaluationPorts {
  return {
    store,
    roster: ROSTER,
    clock: () => FIXED_CLOCK,
    evaluatorPort: createUnavailableEvaluatorPort(),
    deadlineMs: 5_000,
    log: () => {},
    ...overrides,
  };
}

function command(
  id: string,
  mutation: ShadowCommitCommand['mutation'],
): ShadowCommitCommand {
  return {
    idempotencyKey: `idem-${id}`,
    event: {
      eventId: `event-${id}`,
      actor: ACTOR,
      occurredAt: FIXED_CLOCK,
    },
    mutation,
  };
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Project ${id}`,
    repo: 'app',
    state: 'review',
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

function completeZeroCommandDelivery(
  store: SqliteStateStore,
  deliveryId: string,
  writes: readonly Task[],
): void {
  const ordered = [...writes].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  store.beginEnvelope({
    deliveryId,
    authorityRevision: 'a'.repeat(40),
    authorityInput: { writes: ordered, retiredTaskIds: [] },
    manifest: [],
    gapCodes: [],
  });
  store.completeEnvelope(deliveryId);
}

type CriterionSpec = {
  readonly id: string;
  readonly authority: 'mechanical' | 'human' | 'evaluator';
  readonly required?: boolean;
  readonly text?: string;
};

function buildContract(
  taskId: string,
  criteria: readonly CriterionSpec[],
  overrides: Partial<{ independentEvaluatorRequired: boolean }> = {},
): TaskContract {
  const withoutHash = {
    taskId,
    version: 1,
    contractHash: '',
    objective: 'Verify the exact candidate.',
    context: [],
    acceptanceCriteria: criteria.map((criterion) => ({
      id: criterion.id,
      text: criterion.text ?? `${criterion.id} must hold.`,
      authority: criterion.authority,
      required: criterion.required ?? true,
      proofBinding: null,
    })),
    constraints: [],
    forbiddenActions: [],
    capabilityPolicy: { version: 'capability-v1', grants: [] },
    verificationPolicy: {
      version: 'verification-v1',
      // Must match the bound evidence manifest entry surface (`gate-log`) so a
      // pure mechanical pass verdict satisfies required primary evidence.
      requiredEvidence: ['gate-log'],
      // Deterministic human-pending receipts leave evaluatorAgentRunId null.
      independentEvaluatorRequired: overrides.independentEvaluatorRequired ?? false,
    },
    // Post-C3.4 shape — C3.4 bridges the M4 lock to approve_outcome.
    approvalPolicy: { version: 'approval-v1', requiredDecisions: ['approve_outcome'] },
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
    ...withoutHash,
    contractHash: computeTaskContractHash(withoutHash),
  };
}

function sha256Bytes(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function iterationIdFor(taskId: string): string {
  // Iteration ids are aggregate-global in the shadow store; keep them unique per task.
  return `iteration-${taskId}`;
}

function buildBoundEvidence(args: {
  readonly taskId: string;
  readonly contract: TaskContract;
  readonly gatePassed: boolean;
  readonly includeCriterionAssertion?: boolean;
  /** Override criterionIds on mechanical/gate verification receipts (default: mechanical ids). */
  readonly gateReceiptCriterionIds?: readonly string[];
}): Omit<V2BoundEvidenceV1, 'evidenceHash'> {
  const { taskId, contract, gatePassed } = args;
  const includeCriterionAssertion = args.includeCriterionAssertion ?? true;
  const iterationId = iterationIdFor(taskId);
  const mechanicalIds = contract.acceptanceCriteria
    .filter((criterion) => criterion.authority === 'mechanical')
    .map((criterion) => criterion.id);
  const primaryCriterionId = mechanicalIds[0] ?? contract.acceptanceCriteria[0]!.id;

  const gateBytes = JSON.stringify({
    gate: 'test',
    command: 'pnpm test',
    passed: gatePassed,
    exitCode: gatePassed ? 0 : 1,
    outcome: gatePassed ? 'pass' : 'fail',
  });
  const gateArtifact: ArtifactRef = {
    id: 'artifact-gate-test',
    sha256: sha256Bytes(gateBytes),
    mediaType: 'application/json',
    byteLength: Buffer.byteLength(gateBytes),
    storageKey: 'artifacts/artifact-gate-test',
    producerStageRunId: ROSTER.verifier.runId,
    createdAt: FIXED_CLOCK,
    trustClass: 'primary',
    redactionState: 'none',
  };

  const artifacts: ArtifactRef[] = [gateArtifact];
  const gatePayload = {
    gate: 'test',
    command: 'pnpm test',
    passed: gatePassed,
    exitCode: gatePassed ? 0 : 1,
    outcome: gatePassed ? 'pass' : 'fail',
  };
  const gateAssertion: DecisionAssertion = {
    id: 'assertion-gate-test',
    subjectKey: 'gate:test',
    kind: 'fact',
    canonicalPayload: gatePayload,
    payloadHash: computeAssertionPayloadHash(gatePayload),
    advisoryText: null,
  };
  const assertions: DecisionAssertion[] = [gateAssertion];

  if (includeCriterionAssertion) {
    const criterionPayload = {
      criterionId: primaryCriterionId,
      status: gatePassed ? 'pass' : 'fail',
      proof: 'gate:test',
    };
    assertions.push({
      id: 'assertion-criterion-mechanical',
      subjectKey: `criterion:${primaryCriterionId}`,
      kind: 'fact',
      canonicalPayload: criterionPayload,
      payloadHash: computeAssertionPayloadHash(criterionPayload),
      advisoryText: null,
    });
  }

  // Preflight step 9 needs eligible premises for every required criterion.
  // Mechanical receipts carry only mechanical ids (so M6 receipt coverage matches
  // criterionPremises). Human/evaluator criteria get their OWN premise assertions
  // whose receipts list that criterion id — those assertions are intentionally
  // absent from criterionPremises/outcomeAssertionIds so the projector never
  // marks a human/evaluator criterion as verified by a mechanical gate receipt.
  for (const criterion of contract.acceptanceCriteria) {
    if (!criterion.required) continue;
    if (criterion.authority === 'mechanical' || criterion.authority === 'verifier') continue;
    const premisePayload = {
      criterionId: criterion.id,
      status: 'pending',
      proof: 'preflight-premise',
    };
    assertions.push({
      id: `assertion-premise-${criterion.id}`,
      subjectKey: `criterion:${criterion.id}`,
      kind: 'fact',
      canonicalPayload: premisePayload,
      payloadHash: computeAssertionPayloadHash(premisePayload),
      advisoryText: null,
    });
  }

  const manifestWithoutHash = {
    id: `manifest-${taskId}`,
    taskId,
    contractVersion: contract.version,
    iterationId,
    candidateRef: CANDIDATE,
    entries: [
      {
        artifactRefId: gateArtifact.id,
        criterionIds: mechanicalIds.length > 0 ? mechanicalIds : [primaryCriterionId],
        candidateRef: CANDIDATE,
        observedAt: FIXED_CLOCK,
        environmentRef: 'test',
        surface: 'gate-log',
        trustClass: 'primary' as const,
      },
    ],
    createdAt: FIXED_CLOCK,
  };
  const evidenceManifest: EvidenceManifest = {
    ...manifestWithoutHash,
    manifestHash: hashCanonicalJson(manifestWithoutHash),
  };

  const verificationReceipts = assertions.map((assertion) => {
    const criterionIds = assertion.id.startsWith('assertion-premise-')
      ? [assertion.subjectKey.slice('criterion:'.length)]
      : args.gateReceiptCriterionIds !== undefined
        ? [...args.gateReceiptCriterionIds]
        : mechanicalIds.length > 0
          ? mechanicalIds
          : [primaryCriterionId];
    const withoutHash = {
      schema: 'hercules-assertion-verification/v1' as const,
      id: `receipt-${assertion.id}`,
      assertionId: assertion.id,
      assertionPayloadHash: assertion.payloadHash,
      subjectKey: assertion.subjectKey,
      valueHash: assertion.payloadHash,
      taskId,
      contractVersion: contract.version,
      contractHash: contract.contractHash,
      iterationId,
      candidateRef: CANDIDATE,
      evidenceManifestId: evidenceManifest.id,
      evidenceManifestHash: evidenceManifest.manifestHash,
      evidenceEntryArtifactIds: [gateArtifact.id],
      criterionIds,
      verifierRunId: ROSTER.verifier.runId,
      verifierImplementation: ROSTER.verifier.implementation,
      observationSurface: 'gate-log',
      observedAt: FIXED_CLOCK,
    };
    return {
      ...withoutHash,
      receiptHash: computeVerificationReceiptHash(withoutHash),
    };
  });

  const attestationWithoutHash = {
    schema: 'hercules-evidence-integrity-attestation/v1' as const,
    result: 'intact' as const,
    evidenceManifestId: evidenceManifest.id,
    evidenceManifestHash: evidenceManifest.manifestHash,
    candidateRef: CANDIDATE,
    checkedArtifacts: [{ artifactRefId: gateArtifact.id, sha256: gateArtifact.sha256 }],
    verifierImplementation: 'integrity-v1',
    checkedAt: FIXED_CLOCK,
  };
  const evidenceIntegrity = {
    ...attestationWithoutHash,
    attestationHash: computeEvidenceIntegrityAttestationHash(attestationWithoutHash),
  };

  return {
    schema: 'hercules-v2-bound-evidence/v1',
    aggregateId: taskId,
    iterationId,
    candidateRef: CANDIDATE,
    evidenceManifest,
    artifacts,
    assertions,
    verificationReceipts,
    evidenceIntegrity,
    producer: {
      implementation: ROSTER.verifier.implementation,
      verifierRunId: ROSTER.verifier.runId,
    },
    recordedAt: FIXED_CLOCK,
  };
}

function seedReviewAggregate(
  store: SqliteStateStore,
  taskId: string,
  contract: TaskContract,
): void {
  store.commit(
    command(`root-${taskId}`, {
      kind: 'insert_contract_root',
      contract,
    }),
  );
  const planned: Iteration = {
    id: iterationIdFor(taskId),
    taskId,
    contractVersion: contract.version,
    ordinal: 1,
    state: 'planned',
    candidateRef: null,
    evidenceManifestId: null,
    finalVerdictId: null,
    createdAt: '2026-08-29T00:00:04.000Z',
    endedAt: null,
    supersedesIterationId: null,
  };
  store.commit(command(`planned-${taskId}`, { kind: 'put_iteration', iteration: planned }));
  const executing = transitionIteration(planned, 'executing', null);
  store.commit(command(`executing-${taskId}`, { kind: 'put_iteration', iteration: executing }));
  const verifying = transitionIteration(executing, 'verifying', null, {
    candidateRef: CANDIDATE,
    evidenceManifestId: null,
    finalVerdictId: null,
  });
  store.commit(command(`verifying-${taskId}`, { kind: 'put_iteration', iteration: verifying }));
  completeZeroCommandDelivery(store, `delivery-${taskId}`, [task(taskId, { state: 'review' })]);
}

function seedWithEvidence(
  store: SqliteStateStore,
  taskId: string,
  criteria: readonly CriterionSpec[],
  options: {
    readonly gatePassed?: boolean;
    readonly independentEvaluatorRequired?: boolean;
    readonly includeCriterionAssertion?: boolean;
    readonly gateReceiptCriterionIds?: readonly string[];
  } = {},
): { readonly contract: TaskContract; readonly evidenceHash: string } {
  const contract = buildContract(
    taskId,
    criteria,
    options.independentEvaluatorRequired === undefined
      ? {}
      : { independentEvaluatorRequired: options.independentEvaluatorRequired },
  );
  seedReviewAggregate(store, taskId, contract);
  const evidenceInput = buildBoundEvidence({
    taskId,
    contract,
    gatePassed: options.gatePassed ?? true,
    ...(options.includeCriterionAssertion === undefined
      ? {}
      : { includeCriterionAssertion: options.includeCriterionAssertion }),
    ...(options.gateReceiptCriterionIds === undefined
      ? {}
      : { gateReceiptCriterionIds: options.gateReceiptCriterionIds }),
  });
  const bound = store.bindReviewEvidence(evidenceInput, ACTOR);
  return { contract, evidenceHash: bound.evidenceHash };
}

describe('reviewEvaluation module surface', () => {
  it('exports the pinned epoch, coordinator run id, and capability ids', () => {
    expect(REVIEW_EVALUATION_AUTHORITY_EPOCH).toBe(
      'hercules-c3-review-evaluation/epoch-1',
    );
    expect(REVIEW_EVALUATION_COORDINATOR_RUN_ID).toBe(
      'hercules-control/reviewEvaluation/coordinator/v1',
    );
    expect(REVIEW_EVALUATION_CAPABILITY_IDS.evaluator).toContain('evaluator-port');
    expect(createUnavailableEvaluatorPort).toBeTypeOf('function');
  });
});

describe('evaluateReviewAggregate', () => {
  it('(a) mechanical pass + required human → bound need_more_evidence/escalate_human and decision-eligible needs_human', async () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    const taskId = 'c3-eval-human';
    seedWithEvidence(store, taskId, [
      { id: 'mechanical-1', authority: 'mechanical' },
      { id: 'human-1', authority: 'human' },
    ]);

    const outcome = await evaluateReviewAggregate(portsFor(store), taskId);
    expect(outcome).toMatchObject({
      kind: 'bound',
      aggregateId: taskId,
      verdictOutcome: 'need_more_evidence',
      recommendedNextStage: 'escalate_human',
    });
    if (outcome.kind !== 'bound') return;

    const bound = store.readBoundEvaluation(taskId, iterationIdFor(taskId));
    expect(bound).not.toBeNull();
    expect(bound!.receipt.proposalHash).toBeNull();
    expect(bound!.receipt.noProposalReason).toBe('deterministic_pass');
    expect(bound!.receipt.verdict.outcome).toBe('need_more_evidence');
    expect(bound!.receipt.verdict.recommendedNextStage).toBe('escalate_human');
    // Preflight reached model_judgment_necessity with classification pass
    // (deterministic + human only — no evaluator-authority criterion).

    const boundEvidence = store.readBoundEvidence(taskId, iterationIdFor(taskId));
    expect(boundEvidence?.evidenceIntegrity.result).toBe('intact');

    const aggregate = store.readV2Aggregate(taskId);
    expect(aggregate?.projectionState).toBe('projected');
    expect(aggregate?.reviewPackage).toBeTruthy();
    const pkg = aggregate!.reviewPackage!;
    expect(pkg.outcome.status).toBe('needs_human');
    expect(pkg.validDecisions).toEqual([
      'approve_outcome',
      'reject_outcome',
      'request_changes',
    ]);
    expect(pkg.decisionBinding).not.toBeNull();
    expect(
      pkg.assertions
        .filter((assertion) => assertion.subjectKey.startsWith('gate:'))
        .every((assertion) => assertion.classification === 'verified'),
    ).toBe(true);
    // Human premise assertion stays unverified — never treated as verifying the
    // human criterion (criterionPremises for human stay empty).
    expect(
      pkg.assertions.find((assertion) => assertion.id === 'assertion-premise-human-1')
        ?.classification,
    ).toBe('unverified_pending');
    expect(
      pkg.criteria.find((row) => row.criterionId === 'human-1')?.status,
    ).toBe('needs_human');
    store.close();
  });

  it('(b) failing gate → fail/repair and request_changes when failure is verified', async () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    const taskId = 'c3-eval-fail-gate';
    // Two mechanical criteria; the failing gate receipt evidences only mechanical-1.
    // mechanical-2 is optional so an unevidenced required gap cannot hide the
    // verified failure's request_changes eligibility.
    seedWithEvidence(
      store,
      taskId,
      [
        { id: 'mechanical-1', authority: 'mechanical' },
        { id: 'mechanical-2', authority: 'mechanical', required: false },
      ],
      { gatePassed: false, gateReceiptCriterionIds: ['mechanical-1'] },
    );

    const outcome = await evaluateReviewAggregate(portsFor(store), taskId);
    expect(outcome).toMatchObject({
      kind: 'bound',
      aggregateId: taskId,
      verdictOutcome: 'fail',
      recommendedNextStage: 'repair',
    });
    if (outcome.kind !== 'bound') return;

    const bound = store.readBoundEvaluation(taskId, iterationIdFor(taskId));
    expect(bound).not.toBeNull();
    expect(bound!.receipt.noProposalReason).toBe('deterministic_fail');
    // Receipt stays engine-produced (unnamed finding); evaluation.verdict is attributed.
    expect(
      bound!.receipt.verdict.blockingFindings.find(
        (finding) => finding.code === 'deterministic_gate_failed',
      )?.criterionIds,
    ).toEqual([]);
    expect(
      bound!.evaluation.verdict.blockingFindings.find(
        (finding) => finding.code === 'deterministic_gate_failed',
      )?.criterionIds,
    ).toEqual(['mechanical-1']);
    expect(
      bound!.evaluation.verdict.criterionResults.find(
        (row) => row.criterionId === 'mechanical-1',
      )?.status,
    ).toBe('fail');
    expect(
      bound!.evaluation.verdict.criterionResults.find(
        (row) => row.criterionId === 'mechanical-2',
      )?.status,
    ).not.toBe('fail');
    // Preflight stopped at deterministic_gates with verified_fail.

    const pkg = store.readV2Aggregate(taskId)?.reviewPackage;
    expect(pkg).not.toBeNull();
    expect(pkg!.outcome.status).toBe('fail');
    expect(pkg!.validDecisions).toEqual(['request_changes']);
    expect(pkg!.decisionBinding).not.toBeNull();
    expect(pkg!.criteria.find((row) => row.criterionId === 'mechanical-1')?.status).toBe(
      'fail',
    );
    expect(pkg!.criteria.find((row) => row.criterionId === 'mechanical-2')?.status).not.toBe(
      'fail',
    );
    store.close();
  });

  it('(b2) failing gate whose receipt evidences no criterion → bound unmodified + loud log', async () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    const taskId = 'c3-eval-fail-unattributed';
    seedWithEvidence(
      store,
      taskId,
      [{ id: 'mechanical-1', authority: 'mechanical' }],
      { gatePassed: false, gateReceiptCriterionIds: [] },
    );
    const logs: string[] = [];
    const outcome = await evaluateReviewAggregate(
      portsFor(store, { log: (line) => logs.push(line) }),
      taskId,
    );
    expect(outcome.kind).toBe('bound');
    expect(logs.some((line) => line.includes('attribution impossible'))).toBe(true);
    const bound = store.readBoundEvaluation(taskId, iterationIdFor(taskId));
    expect(bound).not.toBeNull();
    expect(bound!.evaluation.verdict).toEqual(bound!.receipt.verdict);
    store.close();
  });

  it('(c) evaluator-authority criterion + unavailable port → insufficient_evidence, no proposal', async () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    const taskId = 'c3-eval-model';
    seedWithEvidence(
      store,
      taskId,
      [
        { id: 'mechanical-1', authority: 'mechanical' },
        { id: 'model-1', authority: 'evaluator' },
      ],
      { independentEvaluatorRequired: true },
    );

    const outcome = await evaluateReviewAggregate(portsFor(store), taskId);
    expect(outcome).toMatchObject({
      kind: 'bound',
      aggregateId: taskId,
      verdictOutcome: 'need_more_evidence',
    });
    if (outcome.kind !== 'bound') return;

    const bound = store.readBoundEvaluation(taskId, iterationIdFor(taskId));
    expect(bound).not.toBeNull();
    expect(bound!.receipt.proposalHash).toBeNull();
    expect(bound!.receipt.noProposalReason).toBe('evidence_gap');
    expect(bound!.receipt.verdict.outcome).toBe('need_more_evidence');
    expect(
      bound!.receipt.verdict.criterionResults.find(
        (result) => result.criterionId === 'model-1',
      )?.status,
    ).toBe('insufficient_evidence');
    // Preflight reached model_judgment_necessity → model_judgment_required.
    store.close();
  });

  it('(d) already_bound, no_bound_evidence, evidence_hash_mismatch, store throw → skipped/failed', async () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    const taskId = 'c3-eval-skips';
    seedWithEvidence(store, taskId, [{ id: 'mechanical-1', authority: 'mechanical' }]);

    const first = await evaluateReviewAggregate(portsFor(store), taskId);
    expect(first.kind).toBe('bound');
    const second = await evaluateReviewAggregate(portsFor(store), taskId);
    expect(second).toMatchObject({
      kind: 'skipped',
      reason: 'already_bound',
    });

    const noEvidenceId = 'c3-eval-no-evidence';
    seedReviewAggregate(
      store,
      noEvidenceId,
      buildContract(noEvidenceId, [{ id: 'mechanical-1', authority: 'mechanical' }]),
    );
    const noEvidence = await evaluateReviewAggregate(portsFor(store), noEvidenceId);
    expect(noEvidence).toMatchObject({
      kind: 'skipped',
      reason: 'no_bound_evidence',
    });

    const mismatchPorts: ReviewEvaluationPorts = {
      ...portsFor(store),
      store: {
        listAggregatesAwaitingEvaluation: () => [
          {
            aggregateId: taskId,
            iterationId: iterationIdFor(taskId),
            evidenceHash: `sha256:${'f'.repeat(64)}`,
          },
        ],
        readBoundEvidence: (id, iterationId) => store.readBoundEvidence(id, iterationId),
        readBoundEvaluation: () => null,
        readTask: (id) => store.readTask(id),
        bindReviewEvaluation: (record, actor) => store.bindReviewEvaluation(record, actor),
      },
    };
    // already_bound short-circuits before hash mismatch when evaluation exists;
    // clear-evaluation path: use an aggregate with evidence but force mismatch list.
    const mismatchId = 'c3-eval-mismatch';
    seedWithEvidence(store, mismatchId, [{ id: 'mechanical-1', authority: 'mechanical' }]);
    const mismatchOnly: ReviewEvaluationPorts = {
      ...portsFor(store),
      store: {
        listAggregatesAwaitingEvaluation: () => [
          {
            aggregateId: mismatchId,
            iterationId: iterationIdFor(mismatchId),
            evidenceHash: `sha256:${'f'.repeat(64)}`,
          },
        ],
        readBoundEvidence: (id, iterationId) => store.readBoundEvidence(id, iterationId),
        readBoundEvaluation: () => null,
        readTask: (id) => store.readTask(id),
        bindReviewEvaluation: (record, actor) => store.bindReviewEvaluation(record, actor),
      },
    };
    const mismatch = await evaluateReviewAggregate(mismatchOnly, mismatchId);
    expect(mismatch).toMatchObject({
      kind: 'skipped',
      reason: 'evidence_hash_mismatch',
    });
    void mismatchPorts;

    const throwing: ReviewEvaluationPorts = {
      ...portsFor(store),
      store: {
        listAggregatesAwaitingEvaluation: () => {
          throw new Error('store exploded');
        },
        readBoundEvidence: () => null,
        readBoundEvaluation: () => null,
        readTask: () => null,
        bindReviewEvaluation: () => {
          throw new Error('bind exploded');
        },
      },
    };
    const all = await evaluateAllAwaiting(throwing);
    expect(all.some((entry) => entry.kind === 'failed')).toBe(true);
    store.close();
  });

  it('(e) determinism: same evidence on fresh stores yields equal criterion statuses/outcome/stage/reasons', async () => {
    const criteria: CriterionSpec[] = [
      { id: 'mechanical-1', authority: 'mechanical' },
      { id: 'human-1', authority: 'human' },
    ];

    const targetA = paths();
    const storeA = storeAt(targetA);
    storeA.initialize();
    seedWithEvidence(storeA, 'c3-eval-det-a', criteria);
    expect((await evaluateReviewAggregate(portsFor(storeA), 'c3-eval-det-a')).kind).toBe(
      'bound',
    );
    const receiptA = storeA.readBoundEvaluation(
      'c3-eval-det-a',
      iterationIdFor('c3-eval-det-a'),
    )!.receipt;
    storeA.close();

    const targetB = paths();
    const storeB = storeAt(targetB);
    storeB.initialize();
    seedWithEvidence(storeB, 'c3-eval-det-b', criteria);
    expect((await evaluateReviewAggregate(portsFor(storeB), 'c3-eval-det-b')).kind).toBe(
      'bound',
    );
    const receiptB = storeB.readBoundEvaluation(
      'c3-eval-det-b',
      iterationIdFor('c3-eval-det-b'),
    )!.receipt;
    storeB.close();

    expect(receiptA.verdict.criterionResults.map((row) => row.status)).toEqual(
      receiptB.verdict.criterionResults.map((row) => row.status),
    );
    expect(receiptA.verdict.outcome).toBe(receiptB.verdict.outcome);
    expect(receiptA.verdict.recommendedNextStage).toBe(
      receiptB.verdict.recommendedNextStage,
    );
    expect(receiptA.outcomeReasonCodes).toEqual(receiptB.outcomeReasonCodes);
  });
});

describe('attributeUnnamedGateFailures', () => {
  const binding = {
    taskId: 'task-1',
    contractVersion: 1,
    contractHash: `sha256:${'a'.repeat(64)}`,
    iterationId: 'iteration-1',
    candidateRef: CANDIDATE,
    evidenceManifestHash: `sha256:${'b'.repeat(64)}`,
    evaluatorVersion: '1.0.0',
    evaluatorModel: null,
    evaluatorRuntime: 'node22',
    policyVersion: '1',
  };

  function baseVerdict(
    overrides: Partial<EvaluationVerdict> = {},
  ): EvaluationVerdict {
    return {
      id: 'verdict-1',
      binding,
      outcome: 'fail',
      criterionResults: [
        {
          criterionId: 'mechanical-1',
          status: 'insufficient_evidence',
          authority: 'mechanical',
          evidenceRefs: [],
          observedAt: FIXED_CLOCK,
          candidateBinding: JSON.stringify([
            CANDIDATE.kind,
            CANDIDATE.repository,
            CANDIDATE.revision,
          ]),
          explanation: 'gap',
        },
        {
          criterionId: 'mechanical-2',
          status: 'insufficient_evidence',
          authority: 'mechanical',
          evidenceRefs: [],
          observedAt: FIXED_CLOCK,
          candidateBinding: JSON.stringify([
            CANDIDATE.kind,
            CANDIDATE.repository,
            CANDIDATE.revision,
          ]),
          explanation: 'gap',
        },
      ],
      blockingFindings: [
        {
          code: 'deterministic_gate_failed',
          summary: 'gate failed',
          criterionIds: [],
        },
      ],
      nonBlockingRisks: [],
      recommendedNextStage: 'repair',
      evaluatorAgentRunId: null,
      createdAt: FIXED_CLOCK,
      ...overrides,
    };
  }

  function evidenceWithGate(
    criterionIds: readonly string[],
  ): V2BoundEvidenceV1 {
    const contract = buildContract('task-1', [
      { id: 'mechanical-1', authority: 'mechanical' },
      { id: 'mechanical-2', authority: 'mechanical', required: false },
    ]);
    const withoutHash = buildBoundEvidence({
      taskId: 'task-1',
      contract,
      gatePassed: false,
      gateReceiptCriterionIds: criterionIds,
    });
    return {
      ...withoutHash,
      evidenceHash: hashCanonicalJson(withoutHash),
    };
  }

  function gateReceipt(
    assertionId: string,
    status: 'pass' | 'verified_fail',
  ): DeterministicGateReceiptV1 {
    return {
      schema: 'hercules-deterministic-gate-receipt/v1',
      gatePlanId: 'plan',
      gatePlanHash: `sha256:${'c'.repeat(64)}`,
      gateId: 'legacy-gate.test',
      gateVersion: 1,
      gateDefinitionHash: `sha256:${'d'.repeat(64)}`,
      runnerIssuer: 'hercules-program-control',
      runnerRunId: ROSTER.verifier.runId,
      authorityEpoch: REVIEW_EVALUATION_AUTHORITY_EPOCH,
      taskId: 'task-1',
      taskContractHash: `sha256:${'a'.repeat(64)}`,
      iterationId: 'iteration-1',
      candidateCommit: CANDIDATE.revision,
      environmentIdentity: { verifierRunId: ROSTER.verifier.runId },
      commandOrSpecHash: `sha256:${'e'.repeat(64)}`,
      startedAt: FIXED_CLOCK,
      completedAt: FIXED_CLOCK,
      expiresAt: '2026-09-05T13:00:00.000Z',
      status,
      exitCode: status === 'pass' ? 0 : 1,
      outputArtifactIds: ['artifact-gate-test'],
      outputArtifactHashes: [`sha256:${'f'.repeat(64)}`],
      assertionIds: [assertionId],
      verificationReceiptIds: [`receipt-${assertionId}`],
      receiptHash: `sha256:${'1'.repeat(64)}`,
    };
  }

  it('attributes only criteria evidenced by failing gate receipts', () => {
    const verdict = baseVerdict();
    const evidence = evidenceWithGate(['mechanical-1']);
    const result = attributeUnnamedGateFailures(verdict, evidence, [
      gateReceipt('assertion-gate-test', 'verified_fail'),
    ]);
    expect(result.attributedCriterionIds).toEqual(['mechanical-1']);
    expect(result.failingGateAssertionIds).toEqual(['assertion-gate-test']);
    expect(
      result.verdict.criterionResults.find((row) => row.criterionId === 'mechanical-1')
        ?.status,
    ).toBe('fail');
    expect(
      result.verdict.criterionResults.find((row) => row.criterionId === 'mechanical-2')
        ?.status,
    ).toBe('insufficient_evidence');
    expect(result.verdict.blockingFindings[0]?.criterionIds).toEqual(['mechanical-1']);
  });

  it('leaves a verdict without empty-criterion findings byte-identical', () => {
    const verdict = baseVerdict({
      blockingFindings: [
        {
          code: 'deterministic_gate_failed',
          summary: 'already attributed',
          criterionIds: ['mechanical-1'],
        },
      ],
      criterionResults: [
        {
          criterionId: 'mechanical-1',
          status: 'fail',
          authority: 'mechanical',
          evidenceRefs: ['artifact-gate-test'],
          observedAt: FIXED_CLOCK,
          candidateBinding: JSON.stringify([
            CANDIDATE.kind,
            CANDIDATE.repository,
            CANDIDATE.revision,
          ]),
          explanation: 'failed',
        },
      ],
    });
    const evidence = evidenceWithGate(['mechanical-1']);
    const result = attributeUnnamedGateFailures(verdict, evidence, [
      gateReceipt('assertion-gate-test', 'verified_fail'),
    ]);
    expect(result.verdict).toBe(verdict);
    expect(result.attributedCriterionIds).toEqual([]);
  });

  it('empty union → identical verdict (no invention)', () => {
    const verdict = baseVerdict();
    const evidence = evidenceWithGate([]);
    const result = attributeUnnamedGateFailures(verdict, evidence, [
      gateReceipt('assertion-gate-test', 'verified_fail'),
    ]);
    expect(result.verdict).toBe(verdict);
    expect(result.attributedCriterionIds).toEqual([]);
    expect(result.failingGateAssertionIds).toEqual(['assertion-gate-test']);
  });
});

describe('reviewEvaluation gap logging', () => {
  it('logs gap reason and underlying port error when the coordinator returns a gap', async () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    const taskId = 'c3-eval-gap-log';
    seedWithEvidence(store, taskId, [
      { id: 'mechanical-1', authority: 'mechanical' },
      { id: 'human-1', authority: 'human' },
    ]);
    let clockCalls = 0;
    const logs: string[] = [];
    const outcome = await evaluateReviewAggregate(
      portsFor(store, {
        log: (line) => logs.push(line),
        clock: () => {
          clockCalls += 1;
          // Call 1: evaluateReviewAggregate setup observedAt.
          // Call 2: pre_acceptance resolveFreshContext.
          // Call 3+: post-evaluation refresh (or mid-eval) — surface cause.
          if (clockCalls >= 3) {
            throw new Error('engine invariant: fabricated boom');
          }
          return FIXED_CLOCK;
        },
      }),
      taskId,
    );
    expect(outcome.kind).toBe('skipped');
    if (outcome.kind !== 'skipped') return;
    expect(outcome.reason).toBe('gap');
    expect(outcome.detail).toContain('underlying=engine invariant: fabricated boom');
    expect(
      logs.some(
        (line) =>
          line.includes('reviewEvaluation gap') &&
          line.includes('underlying=engine invariant: fabricated boom'),
      ),
    ).toBe(true);
    store.close();
  });
});

describe('evaluateAllAwaiting', () => {
  it('never throws and evaluates every awaiting aggregate', async () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    seedWithEvidence(store, 'c3-eval-all-a', [
      { id: 'mechanical-1', authority: 'mechanical' },
      { id: 'human-1', authority: 'human' },
    ]);
    seedWithEvidence(store, 'c3-eval-all-b', [
      { id: 'mechanical-1', authority: 'mechanical' },
      { id: 'human-1', authority: 'human' },
    ]);
    const results = await evaluateAllAwaiting(portsFor(store));
    expect(results).toHaveLength(2);
    expect(results.every((entry) => entry.kind === 'bound')).toBe(true);
    store.close();
  });
});
