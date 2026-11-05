import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSerialize, hashCanonicalJson } from '../../../src/domain/canonicalJson.js';
import type { CandidateRef } from '../../../src/domain/artifact.js';
import {
  computeAssertionPayloadHash,
  computeEvidenceIntegrityAttestationHash,
  computeVerificationReceiptHash,
  type AssertionVerificationReceipt,
  type DecisionAssertion,
} from '../../../src/domain/claimAuthorityV2.js';
import {
  computeCancellationDispatchHash,
  computeCriterionRelationshipHash,
  computeEvaluationReceiptHash,
  computeVerdictHash,
  type EvaluationCancellationDispatchV1,
  type EvaluationCriterionRelationshipV1,
  type IndependentEvaluationReceiptV1,
} from '../../../src/domain/independentEvaluation.js';
import { transitionIteration, type Iteration } from '../../../src/domain/iteration.js';
import type { ReviewPackageV2Source } from '../../../src/domain/reviewPackageV2.js';
import type { Task } from '../../../src/domain/task.js';
import { buildEligibleControlApiV2ReviewSource } from '../../../src/isolation/controlApiV2ReviewSeed.js';
import { createReviewPackageRefreshSeam } from '../../../src/control/reviewPackageSource.js';
import { STATE_MIGRATIONS } from '../../../src/control/state/migrations.js';
import { SqliteStateStore } from '../../../src/control/state/sqliteStateStore.js';
import {
  StateStoreError,
  type ShadowCommitCommand,
  type V2BoundEvaluationV1,
  type V2BoundEvidenceV1,
} from '../../../src/control/state/stateStore.js';
import {
  computeV2BoundEvaluationHash,
  computeV2BoundEvidenceHash,
} from '../../../src/control/state/stateStoreValidation.js';

interface Paths {
  readonly parent: string;
  readonly root: string;
  readonly database: string;
}

const cleanup: string[] = [];
const FIXED_CLOCK = '2026-09-04T12:00:00.000Z';
const ACTOR = { kind: 'control_plane' as const, id: 'v2-c3-test' };
const HASH_A =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B =
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C =
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function paths(): Paths {
  const parent = mkdtempSync(join(tmpdir(), 'hercules-state-store-c3-'));
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
    refreshReviewPackage: createReviewPackageRefreshSeam(() => FIXED_CLOCK),
  });
}

function expectCode(
  action: () => unknown,
  code: StateStoreError['code'],
  message?: RegExp,
): void {
  try {
    action();
    throw new Error(`expected StateStoreError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(StateStoreError);
    expect((error as StateStoreError).code).toBe(code);
    if (message !== undefined) {
      expect((error as StateStoreError).message).toMatch(message);
    }
  }
}

function withTriggersDisabled(
  db: Database.Database,
  triggers: readonly string[],
  mutate: () => void,
): void {
  const ddl = triggers.map((name) => {
    const row = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
    ).get(name) as { sql: string } | undefined;
    if (row === undefined) throw new Error(`missing trigger ${name}`);
    return row.sql;
  });
  for (const name of triggers) db.exec(`DROP TRIGGER ${name}`);
  mutate();
  for (const sql of ddl) db.exec(sql);
}

function command(
  id: string,
  mutation: ShadowCommitCommand['mutation'],
  occurredAt = FIXED_CLOCK,
): ShadowCommitCommand {
  return {
    idempotencyKey: `idem-${id}`,
    event: {
      eventId: `event-${id}`,
      actor: ACTOR,
      occurredAt,
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
  retiredTaskIds: readonly string[] = [],
): void {
  const ordered = [...writes].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  store.beginEnvelope({
    deliveryId,
    authorityRevision: 'a'.repeat(40),
    authorityInput: { writes: ordered, retiredTaskIds: [...retiredTaskIds] },
    manifest: [],
    gapCodes: [],
  });
  store.completeEnvelope(deliveryId);
}

function seedSource(taskId: string): ReviewPackageV2Source {
  return buildEligibleControlApiV2ReviewSource(taskId);
}

function gitCandidate(source: ReviewPackageV2Source): CandidateRef & { kind: 'git' } {
  const candidate = source.evidenceManifest!.candidateRef;
  if (candidate.kind !== 'git') throw new Error('seed candidate must be git');
  return candidate;
}

function seedShadowWithGitIteration(store: SqliteStateStore, source: ReviewPackageV2Source): void {
  const taskId = source.task.id;
  const candidate = gitCandidate(source);
  store.commit(command(`root-${taskId}`, {
    kind: 'insert_contract_root',
    contract: source.contract,
  }));
  const planned: Iteration = {
    id: source.currentIteration.id,
    taskId,
    contractVersion: source.contract.version,
    ordinal: 1,
    state: 'planned',
    candidateRef: null,
    evidenceManifestId: null,
    finalVerdictId: null,
    createdAt: source.currentIteration.createdAt,
    endedAt: null,
    supersedesIterationId: null,
  };
  store.commit(command(`planned-${taskId}`, { kind: 'put_iteration', iteration: planned }));
  const executing = transitionIteration(planned, 'executing', null);
  store.commit(command(`executing-${taskId}`, { kind: 'put_iteration', iteration: executing }));
  const verifying = transitionIteration(executing, 'verifying', null, {
    candidateRef: candidate,
    evidenceManifestId: null,
    finalVerdictId: null,
  });
  store.commit(command(`verifying-${taskId}`, { kind: 'put_iteration', iteration: verifying }));
}

function boundEvidenceInput(
  source: ReviewPackageV2Source,
  overrides: Partial<Omit<V2BoundEvidenceV1, 'evidenceHash'>> = {},
): Omit<V2BoundEvidenceV1, 'evidenceHash'> {
  return {
    schema: 'hercules-v2-bound-evidence/v1',
    aggregateId: source.task.id,
    iterationId: source.currentIteration.id,
    candidateRef: gitCandidate(source),
    evidenceManifest: source.evidenceManifest!,
    artifacts: source.artifacts,
    assertions: source.assertions,
    verificationReceipts: source.verificationReceipts,
    evidenceIntegrity: source.evidenceIntegrity,
    producer: { implementation: 'fixture-v1', verifierRunId: 'verifier-1' },
    recordedAt: FIXED_CLOCK,
    ...overrides,
  };
}

/** Bound evidence whose gate fact failed and justifies `criterion-1` attribution. */
function boundEvidenceWithFailingGate(
  source: ReviewPackageV2Source,
): Omit<V2BoundEvidenceV1, 'evidenceHash'> {
  const payload = {
    gate: 'test',
    command: 'pnpm test',
    passed: false,
    exitCode: 1,
    outcome: 'verified_fail',
  };
  const assertion: DecisionAssertion = {
    id: 'assertion-gate-fail',
    subjectKey: 'gate:test',
    kind: 'fact',
    canonicalPayload: payload,
    payloadHash: computeAssertionPayloadHash(payload),
    advisoryText: null,
  };
  const baseReceipt = source.verificationReceipts[0]!;
  const receiptWithoutHash = {
    schema: 'hercules-assertion-verification/v1' as const,
    id: 'receipt-gate-fail',
    assertionId: assertion.id,
    assertionPayloadHash: assertion.payloadHash,
    subjectKey: assertion.subjectKey,
    valueHash: assertion.payloadHash,
    taskId: source.task.id,
    contractVersion: source.contract.version,
    contractHash: source.contract.contractHash,
    iterationId: source.currentIteration.id,
    candidateRef: gitCandidate(source),
    evidenceManifestId: source.evidenceManifest!.id,
    evidenceManifestHash: source.evidenceManifest!.manifestHash,
    evidenceEntryArtifactIds: baseReceipt.evidenceEntryArtifactIds,
    criterionIds: ['criterion-1'],
    verifierRunId: baseReceipt.verifierRunId,
    verifierImplementation: baseReceipt.verifierImplementation,
    observationSurface: baseReceipt.observationSurface,
    observedAt: baseReceipt.observedAt,
  };
  const receipt: AssertionVerificationReceipt = {
    ...receiptWithoutHash,
    receiptHash: computeVerificationReceiptHash(receiptWithoutHash),
  };
  return boundEvidenceInput(source, {
    assertions: [assertion],
    verificationReceipts: [receipt],
  });
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

function evaluationReceiptFor(
  source: ReviewPackageV2Source,
  overrides: Partial<IndependentEvaluationReceiptV1> = {},
): IndependentEvaluationReceiptV1 {
  const evaluation = source.evaluation;
  if (evaluation === null) throw new Error('seed evaluation required');
  const { receiptHash: overrideHash, ...fields } = overrides;
  const verdict = fields.verdict ?? evaluation.verdict;
  const withoutHash = {
    schema: 'hercules-independent-evaluation-receipt/v1' as const,
    receiptId: 'receipt-eval-1',
    requestId: 'request-1',
    inputHash: HASH_A,
    taskId: source.task.id,
    taskContractHash: source.contract.contractHash,
    iterationId: source.currentIteration.id,
    candidateCommit: gitCandidate(source).revision,
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
    cancellationDispatches: [cancellationDispatch()],
    criterionRelationships: [criterionRelationship()],
    outcomeReasonCodes: ['criterion-pass'],
    createdAt: FIXED_CLOCK,
    ...fields,
    verdict,
    verdictHash: computeVerdictHash(verdict),
  };
  return {
    ...withoutHash,
    receiptHash: overrideHash ?? computeEvaluationReceiptHash(withoutHash),
  };
}

function boundEvaluationInput(
  source: ReviewPackageV2Source,
  evidenceHash: string,
  overrides: Partial<Omit<V2BoundEvaluationV1, 'evaluationHash'>> = {},
): Omit<V2BoundEvaluationV1, 'evaluationHash'> {
  const evaluation = source.evaluation;
  if (evaluation === null) throw new Error('seed evaluation required');
  return {
    schema: 'hercules-v2-bound-evaluation/v1',
    aggregateId: source.task.id,
    iterationId: source.currentIteration.id,
    evidenceHash,
    receipt: evaluationReceiptFor(source),
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
}

function seedReviewAggregate(store: SqliteStateStore, taskId: string): ReviewPackageV2Source {
  const source = seedSource(taskId);
  seedShadowWithGitIteration(store, source);
  completeZeroCommandDelivery(store, `delivery-${taskId}`, [task(taskId, { state: 'review' })]);
  return source;
}

describe('SQLite state store C3.0 bound evidence/evaluation', () => {
  it('initializes a fresh store at schemaVersion 7', () => {
    const target = paths();
    const store = storeAt(target);
    expect(store.initialize().schemaVersion).toBe(7);
    store.close();
  });

  it('records and reads the observed authority revision cursor (C3.58)', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    expect(store.observedAuthorityRevision()).toBeNull();
    store.recordObservedAuthorityRevision('a'.repeat(40));
    expect(store.observedAuthorityRevision()).toBe('a'.repeat(40));
    store.recordObservedAuthorityRevision('b'.repeat(40));
    expect(store.observedAuthorityRevision()).toBe('b'.repeat(40));
    store.close();
    const reopened = storeAt(target);
    reopened.initialize();
    expect(reopened.observedAuthorityRevision()).toBe('b'.repeat(40));
    reopened.close();
  });

  it('migrates schema-4 → 7 while preserving prior data', () => {
    const target = paths();
    mkdirSync(target.root, { mode: 0o700 });
    const raw = new Database(target.database);
    for (const migration of STATE_MIGRATIONS.slice(0, 4)) {
      raw.exec(migration.sql);
      raw.prepare(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
      ).run(migration.version, migration.name, migration.checksum, FIXED_CLOCK);
    }
    raw.prepare(
      'INSERT INTO v2_sweeps (sweep_key, completed_at_sequence, materialized_count) VALUES (?, ?, ?)',
    ).run('c3-migration-marker', 0, 7);
    const before = raw.prepare(
      'SELECT version FROM schema_migrations ORDER BY version',
    ).all() as Array<{ version: number }>;
    expect(before.map((row) => row.version)).toEqual([1, 2, 3, 4]);
    raw.close();

    const store = storeAt(target);
    expect(store.initialize().schemaVersion).toBe(7);
    store.close();

    const verify = new Database(target.database, { readonly: true });
    const after = verify.prepare(
      'SELECT version FROM schema_migrations ORDER BY version',
    ).all() as Array<{ version: number }>;
    expect(after.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(
      verify.prepare(
        'SELECT sweep_key, completed_at_sequence, materialized_count FROM v2_sweeps WHERE sweep_key = ?',
      ).get('c3-migration-marker'),
    ).toEqual({
      sweep_key: 'c3-migration-marker',
      completed_at_sequence: 0,
      materialized_count: 7,
    });
    expect(
      verify.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'v2_review_evidence'",
      ).get(),
    ).toEqual({ name: 'v2_review_evidence' });
    verify.close();
  });

  it('binds evidence, lists awaiting evaluation, then binds evaluation', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    const source = seedReviewAggregate(store, 'c3-bind-happy');

    expect(store.listAggregatesAwaitingEvidence()).toEqual([
      {
        aggregateId: 'c3-bind-happy',
        iterationId: 'iteration-1',
        candidateRef: gitCandidate(source),
      },
    ]);
    expect(store.listAggregatesAwaitingEvaluation()).toEqual([]);

    const evidenceInput = boundEvidenceInput(source);
    const bound = store.bindReviewEvidence(evidenceInput, ACTOR);
    expect(bound.evidenceHash).toBe(computeV2BoundEvidenceHash(evidenceInput));
    expect(store.readBoundEvidence('c3-bind-happy', 'iteration-1')).toEqual({
      ...evidenceInput,
      evidenceHash: bound.evidenceHash,
    });
    expect(
      store.readEvents(0, 100).some((event) => event.eventType === 'V2EvidenceBound'),
    ).toBe(true);
    expect(store.listAggregatesAwaitingEvidence()).toEqual([]);
    expect(store.listAggregatesAwaitingEvaluation()).toEqual([
      {
        aggregateId: 'c3-bind-happy',
        iterationId: 'iteration-1',
        evidenceHash: bound.evidenceHash,
      },
    ]);

    const evaluationInput = boundEvaluationInput(source, bound.evidenceHash);
    const evaluated = store.bindReviewEvaluation(evaluationInput, ACTOR);
    expect(evaluated.evaluationHash).toBe(computeV2BoundEvaluationHash(evaluationInput));
    expect(store.readBoundEvaluation('c3-bind-happy', 'iteration-1')).toEqual({
      ...evaluationInput,
      evaluationHash: evaluated.evaluationHash,
    });
    expect(
      store.readEvents(0, 100).some((event) => event.eventType === 'V2EvaluationBound'),
    ).toBe(true);
    expect(store.listAggregatesAwaitingEvaluation()).toEqual([]);
    store.close();
  });

  it('binds evaluation when verdict.evaluatorAgentRunId is null (deterministic path)', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    const source = seedReviewAggregate(store, 'c3-eval-null-agent');
    const evidenceInput = boundEvidenceInput(source);
    const bound = store.bindReviewEvidence(evidenceInput, ACTOR);
    const baseEvaluation = source.evaluation!;
    const nullAgentVerdict = {
      ...baseEvaluation.verdict,
      evaluatorAgentRunId: null,
    };
    const receipt = evaluationReceiptFor(source, {
      verdict: nullAgentVerdict,
      proposalHash: null,
      noProposalReason: 'deterministic_pass',
    });
    const evaluated = store.bindReviewEvaluation(
      boundEvaluationInput(source, bound.evidenceHash, {
        receipt,
        evaluation: {
          ...baseEvaluation,
          verdict: nullAgentVerdict,
        },
      }),
      ACTOR,
    );
    expect(evaluated.evaluationHash.length).toBeGreaterThan(0);
    expect(
      store.readBoundEvaluation('c3-eval-null-agent', 'iteration-1')
        ?.receipt.verdict.evaluatorAgentRunId,
    ).toBeNull();
    store.close();
  });

  it('binds evaluation when verdict.evaluatorAgentRunId matches evaluator.runId', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    const source = seedReviewAggregate(store, 'c3-eval-set-agent');
    const evidenceInput = boundEvidenceInput(source);
    const bound = store.bindReviewEvidence(evidenceInput, ACTOR);
    // Seed evaluation already has evaluatorAgentRunId === 'evaluator-1'.
    const evaluated = store.bindReviewEvaluation(
      boundEvaluationInput(source, bound.evidenceHash),
      ACTOR,
    );
    expect(evaluated.evaluationHash.length).toBeGreaterThan(0);
    expect(
      store.readBoundEvaluation('c3-eval-set-agent', 'iteration-1')
        ?.receipt.verdict.evaluatorAgentRunId,
    ).toBe('evaluator-1');
    store.close();
  });

  it('rejects evaluation when verdict.evaluatorAgentRunId disagrees with evaluator.runId', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    const source = seedReviewAggregate(store, 'c3-eval-bad-agent');
    const evidenceInput = boundEvidenceInput(source);
    const bound = store.bindReviewEvidence(evidenceInput, ACTOR);
    const baseEvaluation = source.evaluation!;
    const badVerdict = {
      ...baseEvaluation.verdict,
      evaluatorAgentRunId: 'other-evaluator',
    };
    expectCode(
      () =>
        store.bindReviewEvaluation(
          boundEvaluationInput(source, bound.evidenceHash, {
            receipt: evaluationReceiptFor(source, { verdict: badVerdict }),
            evaluation: { ...baseEvaluation, verdict: badVerdict },
          }),
          ACTOR,
        ),
      'invalid_input',
      /evaluatorAgentRunId/,
    );
    store.close();
  });

  it('accepts attribution that only rewrites empty deterministic_gate_failed criterionIds + criterion status', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    const source = seedReviewAggregate(store, 'c3-eval-attr-ok');
    const evidenceInput = boundEvidenceWithFailingGate(source);
    const bound = store.bindReviewEvidence(evidenceInput, ACTOR);
    const baseEvaluation = source.evaluation!;
    const receiptVerdict = {
      ...baseEvaluation.verdict,
      outcome: 'fail' as const,
      recommendedNextStage: 'repair' as const,
      blockingFindings: [
        {
          code: 'deterministic_gate_failed',
          summary: 'A deterministic gate reported verified_fail without naming a rubric criterion.',
          criterionIds: [] as string[],
        },
      ],
      criterionResults: baseEvaluation.verdict.criterionResults.map((row) => ({
        ...row,
        status: 'insufficient_evidence' as const,
      })),
    };
    const attributedVerdict = {
      ...receiptVerdict,
      blockingFindings: [
        {
          ...receiptVerdict.blockingFindings[0]!,
          criterionIds: ['criterion-1'],
        },
      ],
      criterionResults: receiptVerdict.criterionResults.map((row) =>
        row.criterionId === 'criterion-1'
          ? {
              ...row,
              status: 'fail' as const,
              explanation: 'Deterministic gate failure attributed from gate(s): test.',
            }
          : row,
      ),
    };
    const receipt = evaluationReceiptFor(source, { verdict: receiptVerdict });
    const evaluated = store.bindReviewEvaluation(
      boundEvaluationInput(source, bound.evidenceHash, {
        receipt,
        evaluation: {
          ...baseEvaluation,
          verdict: attributedVerdict,
          findingPremises: [
            { key: 'deterministic_gate_failed', assertionIds: ['assertion-gate-fail'] },
          ],
          outcomeAssertionIds: ['assertion-gate-fail'],
          nextStageAssertionIds: ['assertion-gate-fail'],
        },
      }),
      ACTOR,
    );
    expect(evaluated.evaluationHash.length).toBeGreaterThan(0);
    store.close();
  });

  it('rejects attribution naming a criterion no failing gate evidences', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    const source = seedReviewAggregate(store, 'c3-eval-attr-unjustified');
    // Default seed evidence has no failing gate: assertion subjectKey is not gate:*.
    const bound = store.bindReviewEvidence(boundEvidenceInput(source), ACTOR);
    const baseEvaluation = source.evaluation!;
    const receiptVerdict = {
      ...baseEvaluation.verdict,
      outcome: 'fail' as const,
      recommendedNextStage: 'repair' as const,
      blockingFindings: [
        {
          code: 'deterministic_gate_failed',
          summary: 'gate failed',
          criterionIds: [] as string[],
        },
      ],
      criterionResults: baseEvaluation.verdict.criterionResults.map((row) => ({
        ...row,
        status: 'insufficient_evidence' as const,
      })),
    };
    const attributedVerdict = {
      ...receiptVerdict,
      blockingFindings: [
        {
          ...receiptVerdict.blockingFindings[0]!,
          criterionIds: ['criterion-1'],
        },
      ],
      criterionResults: receiptVerdict.criterionResults.map((row) =>
        row.criterionId === 'criterion-1'
          ? { ...row, status: 'fail' as const, explanation: 'unjustified' }
          : row,
      ),
    };
    expectCode(
      () =>
        store.bindReviewEvaluation(
          boundEvaluationInput(source, bound.evidenceHash, {
            receipt: evaluationReceiptFor(source, { verdict: receiptVerdict }),
            evaluation: { ...baseEvaluation, verdict: attributedVerdict },
          }),
          ACTOR,
        ),
      'invalid_input',
      /not justified|no failing gate/,
    );
    store.close();
  });

  it('rejects attribution when no gate failed', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    const source = seedReviewAggregate(store, 'c3-eval-attr-no-fail');
    const bound = store.bindReviewEvidence(boundEvidenceInput(source), ACTOR);
    const baseEvaluation = source.evaluation!;
    const receiptVerdict = {
      ...baseEvaluation.verdict,
      outcome: 'fail' as const,
      recommendedNextStage: 'repair' as const,
      blockingFindings: [
        {
          code: 'deterministic_gate_failed',
          summary: 'gate failed',
          criterionIds: [] as string[],
        },
      ],
      criterionResults: baseEvaluation.verdict.criterionResults.map((row) => ({
        ...row,
        status: 'insufficient_evidence' as const,
      })),
    };
    const attributedVerdict = {
      ...receiptVerdict,
      blockingFindings: [
        {
          ...receiptVerdict.blockingFindings[0]!,
          criterionIds: ['criterion-1'],
        },
      ],
      criterionResults: receiptVerdict.criterionResults.map((row) =>
        row.criterionId === 'criterion-1'
          ? { ...row, status: 'fail' as const, explanation: 'no gate failed' }
          : row,
      ),
    };
    expectCode(
      () =>
        store.bindReviewEvaluation(
          boundEvaluationInput(source, bound.evidenceHash, {
            receipt: evaluationReceiptFor(source, { verdict: receiptVerdict }),
            evaluation: { ...baseEvaluation, verdict: attributedVerdict },
          }),
          ACTOR,
        ),
      'invalid_input',
      /no failing gate/,
    );
    store.close();
  });

  it('rejects attributed status rewrite to anything other than fail', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    const source = seedReviewAggregate(store, 'c3-eval-attr-status');
    const bound = store.bindReviewEvidence(boundEvidenceWithFailingGate(source), ACTOR);
    const baseEvaluation = source.evaluation!;
    const receiptVerdict = {
      ...baseEvaluation.verdict,
      outcome: 'fail' as const,
      recommendedNextStage: 'repair' as const,
      blockingFindings: [
        {
          code: 'deterministic_gate_failed',
          summary: 'gate failed',
          criterionIds: [] as string[],
        },
      ],
      criterionResults: baseEvaluation.verdict.criterionResults.map((row) => ({
        ...row,
        status: 'insufficient_evidence' as const,
      })),
    };
    const attributedVerdict = {
      ...receiptVerdict,
      blockingFindings: [
        {
          ...receiptVerdict.blockingFindings[0]!,
          criterionIds: ['criterion-1'],
        },
      ],
      criterionResults: receiptVerdict.criterionResults.map((row) =>
        row.criterionId === 'criterion-1'
          ? {
              ...row,
              status: 'pass' as const,
              explanation: 'sneaky pass rewrite',
            }
          : row,
      ),
    };
    expectCode(
      () =>
        store.bindReviewEvaluation(
          boundEvaluationInput(source, bound.evidenceHash, {
            receipt: evaluationReceiptFor(source, { verdict: receiptVerdict }),
            evaluation: {
              ...baseEvaluation,
              verdict: attributedVerdict,
              findingPremises: [
                { key: 'deterministic_gate_failed', assertionIds: ['assertion-gate-fail'] },
              ],
              outcomeAssertionIds: ['assertion-gate-fail'],
              nextStageAssertionIds: ['assertion-gate-fail'],
            },
          }),
          ACTOR,
        ),
      'invalid_input',
      /only rewrite to fail/,
    );
    store.close();
  });

  it('rejects attribution that changes verdict.outcome', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    const source = seedReviewAggregate(store, 'c3-eval-attr-outcome');
    const evidenceInput = boundEvidenceInput(source);
    const bound = store.bindReviewEvidence(evidenceInput, ACTOR);
    const baseEvaluation = source.evaluation!;
    const receiptVerdict = {
      ...baseEvaluation.verdict,
      outcome: 'fail' as const,
      recommendedNextStage: 'repair' as const,
      blockingFindings: [
        {
          code: 'deterministic_gate_failed',
          summary: 'gate failed',
          criterionIds: [] as string[],
        },
      ],
    };
    const rewritten = {
      ...receiptVerdict,
      outcome: 'need_more_evidence' as const,
      blockingFindings: [
        {
          ...receiptVerdict.blockingFindings[0]!,
          criterionIds: ['criterion-1'],
        },
      ],
    };
    expectCode(
      () =>
        store.bindReviewEvaluation(
          boundEvaluationInput(source, bound.evidenceHash, {
            receipt: evaluationReceiptFor(source, { verdict: receiptVerdict }),
            evaluation: { ...baseEvaluation, verdict: rewritten },
          }),
          ACTOR,
        ),
      'invalid_input',
      /outcome/,
    );
    store.close();
  });

  it('rejects a criterion status rewrite when the finding was not attributed', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    const source = seedReviewAggregate(store, 'c3-eval-attr-extra');
    const evidenceInput = boundEvidenceInput(source);
    const bound = store.bindReviewEvidence(evidenceInput, ACTOR);
    const baseEvaluation = source.evaluation!;
    const receiptVerdict = {
      ...baseEvaluation.verdict,
      outcome: 'fail' as const,
      recommendedNextStage: 'repair' as const,
      blockingFindings: [
        {
          code: 'deterministic_gate_failed',
          summary: 'gate failed',
          criterionIds: [] as string[],
        },
      ],
      criterionResults: baseEvaluation.verdict.criterionResults.map((row) => ({
        ...row,
        status: 'insufficient_evidence' as const,
      })),
    };
    // Finding criterionIds left empty (no attribution) but criterion status rewritten.
    const rewritten = {
      ...receiptVerdict,
      criterionResults: receiptVerdict.criterionResults.map((row) =>
        row.criterionId === 'criterion-1'
          ? { ...row, status: 'fail' as const, explanation: 'sneaky fail' }
          : row,
      ),
    };
    expectCode(
      () =>
        store.bindReviewEvaluation(
          boundEvaluationInput(source, bound.evidenceHash, {
            receipt: evaluationReceiptFor(source, { verdict: receiptVerdict }),
            evaluation: { ...baseEvaluation, verdict: rewritten },
          }),
          ACTOR,
        ),
      'invalid_input',
      /status\/explanation/,
    );
    store.close();
  });

  describe('fail-closed binds', () => {
    it('rejects evidence without a shadow task / iteration history', () => {
      const target = paths();
      const store = storeAt(target);
      store.initialize();
      const source = seedSource('c3-no-shadow');
      expectCode(
        () => store.bindReviewEvidence(boundEvidenceInput(source), ACTOR),
        'invalid_input',
        /shadow task with iteration history/,
      );
      store.close();
    });

    it('rejects evidence whose iterationId is not current', () => {
      const target = paths();
      const store = storeAt(target);
      store.initialize();
      const source = seedReviewAggregate(store, 'c3-stale-iter');
      // Keep receipt↔record iterationId consistent so assertV2BoundEvidenceV1
      // passes; bindReviewEvidence then refuses the non-current iteration tip.
      const base = boundEvidenceInput(source);
      const receipts = base.verificationReceipts.map((receipt) => {
        const { receiptHash: _ignored, ...withoutHash } = receipt;
        const mutatedWithoutHash = { ...withoutHash, iterationId: 'iteration-other' };
        return {
          ...mutatedWithoutHash,
          receiptHash: computeVerificationReceiptHash(mutatedWithoutHash),
        };
      });
      expectCode(
        () => store.bindReviewEvidence(
          boundEvidenceInput(source, {
            iterationId: 'iteration-other',
            verificationReceipts: receipts,
          }),
          ACTOR,
        ),
        'invalid_input',
        /current iteration/,
      );
      store.close();
    });

    it('rejects evidence with candidateRef mismatch or non-git candidate', () => {
      const target = paths();
      const store = storeAt(target);
      store.initialize();
      const source = seedReviewAggregate(store, 'c3-candidate');
      expectCode(
        () => store.bindReviewEvidence(
          boundEvidenceInput(source, {
            candidateRef: {
              kind: 'git',
              repository: 'example-org/acme',
              revision: 'ffffffffffffffffffffffffffffffffffffffff',
            },
          }),
          ACTOR,
        ),
        'invalid_input',
        /candidateRef/,
      );
      expectCode(
        () => store.bindReviewEvidence(
          boundEvidenceInput(source, {
            candidateRef: {
              kind: 'artifact',
              artifactId: 'artifact-1',
              sha256: `sha256:${'a'.repeat(64)}`,
            },
          }),
          ACTOR,
        ),
        'invalid_input',
        /candidateRef|git/,
      );
      store.close();
    });

    it('rejects evidence when the manifest identity does not match the iteration', () => {
      const target = paths();
      const store = storeAt(target);
      store.initialize();
      const source = seedReviewAggregate(store, 'c3-manifest');
      const { manifestHash: _ignored, ...withoutHash } = source.evidenceManifest!;
      const mismatched = { ...withoutHash, taskId: 'other-task' };
      const rehashed = {
        ...mismatched,
        manifestHash: hashCanonicalJson(mismatched),
      };
      expectCode(
        () => store.bindReviewEvidence(
          boundEvidenceInput(source, { evidenceManifest: rehashed }),
          ACTOR,
        ),
        'invalid_input',
        /manifest/,
      );
      store.close();
    });

    it('rejects a second evidence bind for the same aggregate iteration', () => {
      const target = paths();
      const store = storeAt(target);
      store.initialize();
      const source = seedReviewAggregate(store, 'c3-evidence-twice');
      const input = boundEvidenceInput(source);
      store.bindReviewEvidence(input, ACTOR);
      expectCode(
        () => store.bindReviewEvidence(input, ACTOR),
        'integrity',
        /immutable/,
      );
      store.close();
    });

    it('rejects evidence when a verification receipt field disagrees with the record', () => {
      const target = paths();
      const store = storeAt(target);
      store.initialize();
      const source = seedReviewAggregate(store, 'c3-receipt-consistency');
      const base = boundEvidenceInput(source);
      const receipt = base.verificationReceipts[0]!;
      const cases: Array<{
        readonly label: string;
        readonly mutate: (
          withoutHash: Omit<AssertionVerificationReceipt, 'receiptHash'>,
        ) => Omit<AssertionVerificationReceipt, 'receiptHash'>;
        readonly pattern: RegExp;
      }> = [
        {
          label: 'taskId',
          mutate: (row) => ({ ...row, taskId: 'different-task' }),
          pattern: /receipt taskId/,
        },
        {
          label: 'iterationId',
          mutate: (row) => ({ ...row, iterationId: 'iteration-other' }),
          pattern: /receipt iterationId/,
        },
        {
          label: 'evidenceManifestId',
          mutate: (row) => ({ ...row, evidenceManifestId: 'manifest-other' }),
          pattern: /receipt evidenceManifestId/,
        },
        {
          label: 'evidenceManifestHash',
          mutate: (row) => ({ ...row, evidenceManifestHash: HASH_C }),
          pattern: /receipt evidenceManifestHash/,
        },
        {
          label: 'verifierRunId',
          mutate: (row) => ({ ...row, verifierRunId: 'verifier-other' }),
          pattern: /receipt verifierRunId/,
        },
        {
          label: 'assertionPayloadHash',
          mutate: (row) => ({ ...row, assertionPayloadHash: HASH_C }),
          pattern: /assertionPayloadHash/,
        },
        {
          label: 'contractHash',
          mutate: (row) => ({ ...row, contractHash: HASH_C }),
          pattern: /contractHash/,
        },
      ];
      for (const testCase of cases) {
        const { receiptHash: _ignored, ...withoutHash } = receipt;
        const mutatedWithoutHash = testCase.mutate(withoutHash);
        const mutated: AssertionVerificationReceipt = {
          ...mutatedWithoutHash,
          receiptHash: computeVerificationReceiptHash(mutatedWithoutHash),
        };
        expectCode(
          () =>
            store.bindReviewEvidence(
              boundEvidenceInput(source, {
                verificationReceipts: [mutated, ...base.verificationReceipts.slice(1)],
              }),
              ACTOR,
            ),
          'invalid_input',
          testCase.pattern,
        );
      }
      store.close();
    });

    it('rejects evidence when attestation checkedArtifacts disagree with the manifest', () => {
      const target = paths();
      const store = storeAt(target);
      store.initialize();
      const source = seedReviewAggregate(store, 'c3-attestation-consistency');
      const base = boundEvidenceInput(source);
      const { attestationHash: _ignored, ...withoutHash } = base.evidenceIntegrity;
      const mutatedWithoutHash = {
        ...withoutHash,
        checkedArtifacts: [
          ...withoutHash.checkedArtifacts,
          { artifactRefId: 'artifact-forged', sha256: HASH_C },
        ],
      };
      const mutated = {
        ...mutatedWithoutHash,
        attestationHash: computeEvidenceIntegrityAttestationHash(mutatedWithoutHash),
      };
      expectCode(
        () =>
          store.bindReviewEvidence(
            boundEvidenceInput(source, { evidenceIntegrity: mutated }),
            ACTOR,
          ),
        'invalid_input',
        /checkedArtifacts|attestation/,
      );
      store.close();
    });

    it('rejects evaluation without bound evidence', () => {
      const target = paths();
      const store = storeAt(target);
      store.initialize();
      const source = seedReviewAggregate(store, 'c3-eval-no-evidence');
      expectCode(
        () => store.bindReviewEvaluation(
          boundEvaluationInput(source, `sha256:${'d'.repeat(64)}`),
          ACTOR,
        ),
        'invalid_input',
        /requires existing bound evidence/,
      );
      store.close();
    });

    it('rejects evaluation whose evidenceHash does not match the bound row', () => {
      const target = paths();
      const store = storeAt(target);
      store.initialize();
      const source = seedReviewAggregate(store, 'c3-eval-hash');
      store.bindReviewEvidence(boundEvidenceInput(source), ACTOR);
      expectCode(
        () => store.bindReviewEvaluation(
          boundEvaluationInput(source, `sha256:${'e'.repeat(64)}`),
          ACTOR,
        ),
        'invalid_input',
        /evidenceHash/,
      );
      store.close();
    });

    it('rejects evaluation when receipt.iterationId mismatches', () => {
      const target = paths();
      const store = storeAt(target);
      store.initialize();
      const source = seedReviewAggregate(store, 'c3-eval-receipt-iter');
      const { evidenceHash } = store.bindReviewEvidence(boundEvidenceInput(source), ACTOR);
      const receipt = evaluationReceiptFor(source, { iterationId: 'iteration-other' });
      expectCode(
        () => store.bindReviewEvaluation(
          boundEvaluationInput(source, evidenceHash, { receipt }),
          ACTOR,
        ),
        'invalid_input',
        /receipt\.iterationId/,
      );
      store.close();
    });

    it('rejects evaluation when evaluator.runId mismatches the receipt', () => {
      const target = paths();
      const store = storeAt(target);
      store.initialize();
      const source = seedReviewAggregate(store, 'c3-eval-runid');
      const { evidenceHash } = store.bindReviewEvidence(boundEvidenceInput(source), ACTOR);
      expectCode(
        () => store.bindReviewEvaluation(
          boundEvaluationInput(source, evidenceHash, {
            evaluator: {
              runId: 'evaluator-other',
              implementationId: 'evaluator-impl-1',
              version: 'evaluator-v1',
              model: 'model-v1',
              runtime: 'runtime-v1',
            },
          }),
          ACTOR,
        ),
        'invalid_input',
        /evaluator\.runId/,
      );
      store.close();
    });

    it('rejects a second evaluation bind for the same aggregate iteration', () => {
      const target = paths();
      const store = storeAt(target);
      store.initialize();
      const source = seedReviewAggregate(store, 'c3-eval-twice');
      const { evidenceHash } = store.bindReviewEvidence(boundEvidenceInput(source), ACTOR);
      const input = boundEvaluationInput(source, evidenceHash);
      store.bindReviewEvaluation(input, ACTOR);
      expectCode(
        () => store.bindReviewEvaluation(input, ACTOR),
        'integrity',
        /immutable/,
      );
      store.close();
    });
  });

  it('fails boot integrity when bound evidence record_json is tampered', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    const source = seedReviewAggregate(store, 'c3-tamper');
    const { evidenceHash } = store.bindReviewEvidence(boundEvidenceInput(source), ACTOR);
    store.bindReviewEvaluation(boundEvaluationInput(source, evidenceHash), ACTOR);
    store.close();

    const raw = new Database(target.database);
    withTriggersDisabled(raw, ['v2_review_evidence_no_update'], () => {
      const row = raw.prepare(
        'SELECT record_json FROM v2_review_evidence WHERE aggregate_id = ?',
      ).get('c3-tamper') as { record_json: string };
      const record = JSON.parse(row.record_json) as V2BoundEvidenceV1;
      const { evidenceHash: _ignored, ...withoutHash } = {
        ...record,
        producer: { ...record.producer, implementation: 'tampered-v1' },
      };
      // Keep the row's evidence_hash column stale while the JSON stays internally consistent.
      const tampered: V2BoundEvidenceV1 = {
        ...withoutHash,
        evidenceHash: computeV2BoundEvidenceHash(withoutHash),
      };
      raw.prepare(
        'UPDATE v2_review_evidence SET record_json = ? WHERE aggregate_id = ?',
      ).run(canonicalSerialize(tampered), 'c3-tamper');
    });
    raw.close();

    const reopened = storeAt(target);
    expectCode(() => reopened.initialize(), 'integrity');
    reopened.close();
  });

  it('fails boot integrity when the V2EvidenceBound event row is deleted', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    const source = seedReviewAggregate(store, 'c3-event-orphan');
    store.bindReviewEvidence(boundEvidenceInput(source), ACTOR);
    const eventSeq = store.readEvents(0, 100)
      .find((event) => event.eventType === 'V2EvidenceBound')!.sequence;
    store.close();

    const raw = new Database(target.database);
    raw.pragma('foreign_keys = OFF');
    withTriggersDisabled(raw, ['control_events_no_delete'], () => {
      raw.prepare('DELETE FROM control_events WHERE sequence = ?').run(eventSeq);
    });
    raw.pragma('foreign_keys = ON');
    raw.close();

    const reopened = storeAt(target);
    expectCode(() => reopened.initialize(), 'integrity');
    reopened.close();
  });

  it('refreshes retiredTaskIds to deleted without throwing on delivery', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    const source = seedReviewAggregate(store, 'c3-retired');
    expect(store.readV2Aggregate('c3-retired')?.taskStatus).toBe('review');

    expect(() => {
      completeZeroCommandDelivery(store, 'delivery-retire-c3-retired', [], ['c3-retired']);
    }).not.toThrow();

    const aggregate = store.readV2Aggregate('c3-retired');
    expect(aggregate?.taskStatus).toBe('deleted');
    expect(
      store.readEvents(0, 100).some((event) =>
        event.eventType === 'V2AggregateRefreshed' && event.aggregateId === 'c3-retired'
      ),
    ).toBe(true);
    // Keep the seed contract/iteration reachable for later binds if needed.
    expect(store.readTask('c3-retired')?.contracts[0]?.contractHash)
      .toBe(source.contract.contractHash);
    store.close();
  });
});
