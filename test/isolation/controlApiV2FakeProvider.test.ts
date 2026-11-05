import { describe, expect, it } from 'vitest';
import {
  assertAdmissionLedgerEntryV1,
  assertControlApiV2ReceiptV1,
  assertControlEventView,
  buildConcurrencyToken,
  buildControlApiV2Request,
  buildIdempotencyKey,
  computeAdmissionVerdictHash,
  computeEventCursorHash,
  computeReceiptHash,
  deriveAggregateId,
  type AdmissionVerdictV1,
  type ControlApiV2ReadsV1,
  type ControlApiV2RequestV1,
  type CreatePayloadV1,
  type DecisionPayloadV1,
  type EventCursorRequestV1,
  type ReadPayloadV1,
} from '../../src/domain/controlApiV2.js';
import { decideControlApiV2 } from '../../src/controlapi/requestPolicy.js';
import { openIsolatedControlApiV2Deps } from '../../src/isolation/controlApiV2FakeProvider.js';
import {
  buildEligibleControlApiV2ReviewPackage,
  buildIneligibleControlApiV2ReviewPackage,
  CONTROL_API_V2_ELIGIBLE_SEED_TASK_ID,
  CONTROL_API_V2_INELIGIBLE_SEED_TASK_ID,
} from '../../src/isolation/controlApiV2ReviewSeed.js';

/** The isolated L2 fake harness guards (same as the M7 fake provider). */
const FAKE_ENV = {
  HERCULES_ADAPTER: 'fake',
  HERCULES_FAKE_FAULT_INJECTION: '1',
  HERCULES_L2_ISOLATED: '1',
} as const;

const NOW = '2026-08-31T15:00:00.000Z';
const ISSUED = '2026-08-31T14:00:00.000Z';
const HASH_A =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B =
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function assertReadsShape(reads: ControlApiV2ReadsV1): void {
  expect(typeof reads.aggregateExists).toBe('boolean');
  expect(
    reads.currentStateVersion === null ||
      (typeof reads.currentStateVersion === 'number' &&
        Number.isSafeInteger(reads.currentStateVersion) &&
        reads.currentStateVersion >= 0),
  ).toBe(true);
  expect(
    reads.taskStatus === null ||
      (typeof reads.taskStatus === 'string' && reads.taskStatus.length > 0),
  ).toBe(true);
  expect(
    reads.latestEventSequence === null ||
      (typeof reads.latestEventSequence === 'number' &&
        Number.isSafeInteger(reads.latestEventSequence) &&
        reads.latestEventSequence >= 0),
  ).toBe(true);
  expect(
    reads.freshProjectionHash === null ||
      /^sha256:[0-9a-f]{64}$/.test(reads.freshProjectionHash),
  ).toBe(true);
  expect(Array.isArray(reads.admissionLedger)).toBe(true);
  expect(typeof reads.eventsHasMore).toBe('boolean');
  expect(reads.events === null || Array.isArray(reads.events)).toBe(true);
  for (const entry of reads.admissionLedger) {
    assertAdmissionLedgerEntryV1(entry);
  }
  if (reads.events !== null) {
    for (const event of reads.events) {
      assertControlEventView(event);
    }
  }
}

function openProvider(
  seedTaskIds?: readonly string[],
): NonNullable<ReturnType<typeof openIsolatedControlApiV2Deps>> {
  const deps = openIsolatedControlApiV2Deps(
    seedTaskIds === undefined
      ? {
          env: FAKE_ENV,
          now: () => NOW,
        }
      : {
          env: FAKE_ENV,
          now: () => NOW,
          seedTaskIds,
        },
  );
  expect(deps).toBeDefined();
  return deps!;
}

function createPayload(): CreatePayloadV1 {
  return {
    kind: 'create',
    taskContractHash: HASH_A,
    intentDigest: HASH_B,
  };
}

function readPayload(): ReadPayloadV1 {
  return { kind: 'read' };
}

function decisionPayload(
  overrides: Partial<DecisionPayloadV1> = {},
): DecisionPayloadV1 {
  return {
    kind: 'decision',
    action: 'approve_outcome',
    reason: 'Looks correct',
    acknowledgedRiskCodes: [],
    ...overrides,
  };
}

function eventCursor(
  overrides: Partial<EventCursorRequestV1> = {},
): EventCursorRequestV1 {
  const { cursorHash: overrideHash, ...fields } = overrides;
  const withoutHash: Omit<EventCursorRequestV1, 'cursorHash'> = {
    schema: 'hercules-control-api-event-cursor/v2',
    afterSequence: 0,
    expectedPreviousEventHash: null,
    limit: 10,
    ...fields,
  };
  return {
    ...withoutHash,
    cursorHash: overrideHash ?? computeEventCursorHash(withoutHash),
  };
}

function createRequest(clientRequestId = 'req-create-1'): ControlApiV2RequestV1 {
  return buildControlApiV2Request({
    resource: 'task',
    operation: 'create',
    aggregateId: '',
    idempotencyKey: buildIdempotencyKey({
      actorIssuer: 'hercules-web',
      actorId: 'actor-1',
      aggregateId: '',
      clientRequestId,
    }),
    concurrencyToken: null,
    payload: createPayload(),
    issuedAt: ISSUED,
  });
}

function statusReadRequest(aggregateId: string): ControlApiV2RequestV1 {
  return buildControlApiV2Request({
    resource: 'status',
    operation: 'read',
    aggregateId,
    idempotencyKey: null,
    concurrencyToken: null,
    payload: readPayload(),
    issuedAt: ISSUED,
  });
}

function reviewReadRequest(aggregateId: string): ControlApiV2RequestV1 {
  return buildControlApiV2Request({
    resource: 'review',
    operation: 'read',
    aggregateId,
    idempotencyKey: null,
    concurrencyToken: null,
    payload: readPayload(),
    issuedAt: ISSUED,
  });
}

function submitRequest(
  aggregateId: string,
  stateVersion: number,
  projectionHash: string,
  clientRequestId = 'req-submit-1',
  payload: DecisionPayloadV1 = decisionPayload(),
): ControlApiV2RequestV1 {
  return buildControlApiV2Request({
    resource: 'decision',
    operation: 'submit',
    aggregateId,
    idempotencyKey: buildIdempotencyKey({
      actorIssuer: 'hercules-web',
      actorId: 'actor-1',
      aggregateId,
      clientRequestId,
    }),
    concurrencyToken: buildConcurrencyToken({
      aggregateId,
      stateVersion,
      projectionHash,
    }),
    payload,
    issuedAt: ISSUED,
  });
}

function eventReadRequest(
  cursorOverrides: Partial<EventCursorRequestV1> = {},
): ControlApiV2RequestV1 {
  return buildControlApiV2Request({
    resource: 'event',
    operation: 'read',
    aggregateId: '',
    idempotencyKey: null,
    concurrencyToken: null,
    payload: eventCursor(cursorOverrides),
    issuedAt: ISSUED,
  });
}

function admitVerdict(
  request: ControlApiV2RequestV1,
  aggregateId: string,
): AdmissionVerdictV1 {
  const keyHash = request.idempotencyKey!.keyHash;
  const withoutHash: Omit<AdmissionVerdictV1, 'verdictHash'> = {
    schema: 'hercules-control-api-admit-verdict/v2',
    resource: request.resource === 'task' ? 'task' : 'decision',
    aggregateId,
    keyHash,
    requestHash: request.requestHash,
    decidedAt: NOW,
  };
  return {
    ...withoutHash,
    verdictHash: computeAdmissionVerdictHash(withoutHash),
  };
}

describe('controlApiV2ReviewSeed', () => {
  it('builds a genuinely decision-eligible ReviewPackageV2', () => {
    const pkg = buildEligibleControlApiV2ReviewPackage();
    expect(pkg.decisionBinding).not.toBeNull();
    expect(pkg.validDecisions).toEqual([
      'approve_outcome',
      'reject_outcome',
      'request_changes',
    ]);
    expect(pkg.outcome.decisionEligible).toBe(true);
    expect(pkg.outcome.status).toBe('needs_human');
  });

  it('builds an ineligible ReviewPackageV2', () => {
    const pkg = buildIneligibleControlApiV2ReviewPackage();
    expect(pkg.decisionBinding).toBeNull();
    expect(pkg.validDecisions).toEqual([]);
    expect(pkg.outcome.decisionEligible).toBe(false);
  });
});

describe('openIsolatedControlApiV2Deps', () => {
  it('returns undefined when the isolation env flag is unset', () => {
    expect(openIsolatedControlApiV2Deps({ env: {} })).toBeUndefined();
    expect(
      openIsolatedControlApiV2Deps({
        env: {},
      }),
    ).toBeUndefined();
  });

  it('opens ports under the isolated L2 fake harness', () => {
    const deps = openProvider();
    expect(deps.controlApiV2Reader).toBeDefined();
    expect(deps.controlApiV2Mutator).toBeDefined();
    expect(deps.controlApiV2Events).toBeDefined();
  });
});

describe('Control API V2 fake provider read', () => {
  it('assembles a valid ControlApiV2ReadsV1 for create', () => {
    const deps = openProvider([]);
    const reads = deps.controlApiV2Reader.read(createRequest());
    assertReadsShape(reads);
    expect(reads.aggregateExists).toBe(false);
    expect(reads.currentStateVersion).toBeNull();
    expect(reads.reviewPackage).toBeNull();
    expect(reads.events).toBeNull();
    expect(reads.eventsHasMore).toBe(false);
    expect(reads.admissionLedger).toEqual([]);
  });

  it('assembles status and review reads for a seeded aggregate', () => {
    const deps = openProvider();
    const eligibleId = CONTROL_API_V2_ELIGIBLE_SEED_TASK_ID;
    const status = deps.controlApiV2Reader.read(statusReadRequest(eligibleId));
    assertReadsShape(status);
    expect(status.aggregateExists).toBe(true);
    expect(status.currentStateVersion).toBe(1);
    expect(status.taskStatus).toBe('review');
    expect(status.latestEventSequence).toBe(1);
    expect(status.freshProjectionHash).toBe(
      buildEligibleControlApiV2ReviewPackage(eligibleId).projectionHash,
    );
    expect(status.reviewPackage).toBeNull();

    const review = deps.controlApiV2Reader.read(reviewReadRequest(eligibleId));
    assertReadsShape(review);
    expect(review.aggregateExists).toBe(true);
    expect(review.reviewPackage).not.toBeNull();
    expect(review.reviewPackage!.decisionBinding).not.toBeNull();
    expect(review.reviewPackage!.validDecisions.length).toBeGreaterThan(0);
    expect(review.freshProjectionHash).toBe(review.reviewPackage!.projectionHash);
    expect(review.taskStatus).toBeNull();
    expect(review.latestEventSequence).toBeNull();

    const ineligible = deps.controlApiV2Reader.read(
      reviewReadRequest(CONTROL_API_V2_INELIGIBLE_SEED_TASK_ID),
    );
    expect(ineligible.reviewPackage).not.toBeNull();
    expect(ineligible.reviewPackage!.decisionBinding).toBeNull();

    const seedEvents = deps.controlApiV2Events.readEvents(0, 10);
    expect(seedEvents.events.map((event) => event.eventType)).toEqual([
      'V2AggregateMaterialized',
      'V2AggregateMaterialized',
    ]);
    expect(seedEvents.events[0]!.eventId).toBe(`v2-${eligibleId}-1`);
  });

  it('assembles an existing-aggregate submit read', () => {
    const deps = openProvider();
    const aggregateId = CONTROL_API_V2_ELIGIBLE_SEED_TASK_ID;
    const projectionHash =
      buildEligibleControlApiV2ReviewPackage(aggregateId).projectionHash;
    const request = submitRequest(aggregateId, 1, projectionHash);
    const reads = deps.controlApiV2Reader.read(request);
    assertReadsShape(reads);
    expect(reads.aggregateExists).toBe(true);
    expect(reads.currentStateVersion).toBe(1);
    expect(reads.reviewPackage).not.toBeNull();
    expect(reads.freshProjectionHash).toBe(projectionHash);
    expect(reads.admissionLedger).toEqual([]);
  });

  it('assembles an event read with limit+1 hasMore', () => {
    const deps = openProvider([]);
    const create = createRequest('req-create-evt-1');
    const aggregateId = deriveAggregateId(create.idempotencyKey!.keyHash);
    deps.controlApiV2Mutator.commit(create, admitVerdict(create, aggregateId));

    const create2 = createRequest('req-create-evt-2');
    const aggregateId2 = deriveAggregateId(create2.idempotencyKey!.keyHash);
    deps.controlApiV2Mutator.commit(create2, admitVerdict(create2, aggregateId2));

    const page = deps.controlApiV2Reader.read(
      eventReadRequest({ afterSequence: 0, limit: 1 }),
    );
    assertReadsShape(page);
    expect(page.events).not.toBeNull();
    expect(page.events!).toHaveLength(1);
    expect(page.eventsHasMore).toBe(true);
    expect(page.events![0]!.sequence).toBe(1);
    expect(page.events![0]!.previousEventHash).toBeNull();
    expect(page.events![0]!.eventType).toBe('V2AggregateMaterialized');

    const full = deps.controlApiV2Reader.read(
      eventReadRequest({ afterSequence: 0, limit: 10 }),
    );
    expect(full.events!).toHaveLength(2);
    expect(full.eventsHasMore).toBe(false);
  });
});

describe('Control API V2 fake provider commit', () => {
  it('assigns monotonic version/sequence, receipt, and ledger entry', () => {
    const deps = openProvider([]);
    const request = createRequest('req-commit-1');
    const keyHash = request.idempotencyKey!.keyHash;
    const aggregateId = deriveAggregateId(keyHash);
    const verdict = admitVerdict(request, aggregateId);
    const receipt = deps.controlApiV2Mutator.commit(request, verdict);
    assertControlApiV2ReceiptV1(receipt);
    expect(receipt.outcome).toBe('committed');
    expect(receipt.stateVersion).toBe(1);
    expect(receipt.eventSequence).toBe(1);
    expect(receipt.aggregateId).toBe(aggregateId);
    expect(receipt.keyHash).toBe(keyHash);
    expect(receipt.decidedAt).toBe(verdict.decidedAt);
    expect(receipt.receiptHash).toBe(
      computeReceiptHash({
        schema: receipt.schema,
        outcome: receipt.outcome,
        resource: receipt.resource,
        aggregateId: receipt.aggregateId,
        keyHash: receipt.keyHash,
        requestHash: receipt.requestHash,
        stateVersion: receipt.stateVersion,
        eventSequence: receipt.eventSequence,
        reason: receipt.reason,
        decidedAt: receipt.decidedAt,
      }),
    );

    const replayReads = deps.controlApiV2Reader.read(request);
    expect(replayReads.admissionLedger).toHaveLength(1);
    assertAdmissionLedgerEntryV1(replayReads.admissionLedger[0]!);
    expect(replayReads.admissionLedger[0]!.keyHash).toBe(keyHash);
    expect(replayReads.admissionLedger[0]!.receipt).toEqual(receipt);

    const status = deps.controlApiV2Reader.read(statusReadRequest(aggregateId));
    expect(status.aggregateExists).toBe(true);
    expect(status.currentStateVersion).toBe(1);

    const events = deps.controlApiV2Events.readEvents(0, 10);
    expect(events.events).toHaveLength(1);
    expect(events.events[0]!.eventType).toBe('V2AggregateMaterialized');
    expect(events.events[0]!.eventId).toBe(`v2-${aggregateId}-1`);
  });

  it('returns the stored receipt on a repeated verdict (no second effect)', () => {
    const deps = openProvider([]);
    const request = createRequest('req-idempotent-1');
    const aggregateId = deriveAggregateId(request.idempotencyKey!.keyHash);
    const verdict = admitVerdict(request, aggregateId);
    const first = deps.controlApiV2Mutator.commit(request, verdict);
    const second = deps.controlApiV2Mutator.commit(request, verdict);
    expect(second).toEqual(first);

    const events = deps.controlApiV2Events.readEvents(0, 10);
    expect(events.events).toHaveLength(1);
    expect(events.hasMore).toBe(false);

    const status = deps.controlApiV2Reader.read(statusReadRequest(aggregateId));
    expect(status.currentStateVersion).toBe(1);
  });

  it('refuses a create replay under the same key with a different request hash', () => {
    const deps = openProvider([]);
    const request = createRequest('req-create-conflict-1');
    const aggregateId = deriveAggregateId(request.idempotencyKey!.keyHash);
    const first = deps.controlApiV2Mutator.commit(request, admitVerdict(request, aggregateId));
    expect(first.outcome).toBe('committed');

    // Same idempotency key (same actor + clientRequestId), different payload bytes.
    const altered = buildControlApiV2Request({
      resource: 'task',
      operation: 'create',
      aggregateId: '',
      idempotencyKey: request.idempotencyKey,
      concurrencyToken: null,
      payload: { ...createPayload(), intentDigest: HASH_A },
      issuedAt: ISSUED,
    });
    expect(altered.idempotencyKey!.keyHash).toBe(request.idempotencyKey!.keyHash);
    expect(altered.requestHash).not.toBe(request.requestHash);

    const conflict = deps.controlApiV2Mutator.commit(altered, admitVerdict(altered, aggregateId));
    expect(conflict.outcome).toBe('refused');
    expect(conflict.reason).toBe('idempotency_conflict');
    expect(conflict.requestHash).toBe(altered.requestHash);
    expect(conflict.stateVersion).toBeNull();

    // The refusal is never ledgered and nothing else moved.
    const ledger = deps.controlApiV2Reader.read(request).admissionLedger;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.receipt).toEqual(first);
    expect(deps.controlApiV2Events.readEvents(0, 10).events).toHaveLength(1);
    expect(deps.controlApiV2Reader.read(statusReadRequest(aggregateId)).currentStateVersion).toBe(1);
  });

  it('commits a decision with V2DecisionCommitted then V2AggregateRefreshed', () => {
    const deps = openProvider([CONTROL_API_V2_ELIGIBLE_SEED_TASK_ID]);
    const aggregateId = CONTROL_API_V2_ELIGIBLE_SEED_TASK_ID;
    const projectionHash =
      buildEligibleControlApiV2ReviewPackage(aggregateId).projectionHash;
    const request = submitRequest(aggregateId, 1, projectionHash, 'req-decision-1');
    const verdict = admitVerdict(request, aggregateId);
    const receipt = deps.controlApiV2Mutator.commit(request, verdict);
    assertControlApiV2ReceiptV1(receipt);
    expect(receipt.outcome).toBe('committed');
    expect(receipt.stateVersion).toBe(2);
    expect(receipt.eventSequence).toBe(2);
    expect(receipt.resource).toBe('decision');
    expect(receipt.decidedAt).toBe(verdict.decidedAt);

    const status = deps.controlApiV2Reader.read(statusReadRequest(aggregateId));
    expect(status.currentStateVersion).toBe(3);
    expect(status.taskStatus).toBe('review');

    const events = deps.controlApiV2Events.readEvents(0, 10);
    expect(events.events.map((event) => event.eventType)).toEqual([
      'V2AggregateMaterialized',
      'V2DecisionCommitted',
      'V2AggregateRefreshed',
    ]);
    expect(events.events[1]!.eventId).toBe(`v2-${aggregateId}-2`);
    expect(events.events[2]!.eventId).toBe(`v2-${aggregateId}-3`);
    assertControlEventView(events.events[0]!);

    const review = deps.controlApiV2Reader.read(reviewReadRequest(aggregateId));
    expect(review.reviewPackage!.decisionBinding).not.toBeNull();
    expect(review.reviewPackage!.validDecisions).toEqual(['request_changes']);
    expect(review.freshProjectionHash).not.toBe(projectionHash);
  });

  it('replays a decision byte-identically and refuses idempotency_conflict / stale_version', () => {
    const deps = openProvider([CONTROL_API_V2_ELIGIBLE_SEED_TASK_ID]);
    const aggregateId = CONTROL_API_V2_ELIGIBLE_SEED_TASK_ID;
    const projectionHash =
      buildEligibleControlApiV2ReviewPackage(aggregateId).projectionHash;
    const request = submitRequest(aggregateId, 1, projectionHash, 'req-decision-replay');
    const verdict = admitVerdict(request, aggregateId);
    const first = deps.controlApiV2Mutator.commit(request, verdict);
    const replay = deps.controlApiV2Mutator.commit(request, verdict);
    expect(replay).toEqual(first);
    expect(deps.controlApiV2Events.readEvents(0, 10).events).toHaveLength(3);

    const conflictRequest = submitRequest(
      aggregateId,
      1,
      projectionHash,
      'req-decision-replay',
      decisionPayload({ reason: 'Different body' }),
    );
    // Same clientRequestId / actor → same keyHash; different reason → different requestHash.
    expect(conflictRequest.idempotencyKey!.keyHash).toBe(request.idempotencyKey!.keyHash);
    expect(conflictRequest.requestHash).not.toBe(request.requestHash);
    const conflict = deps.controlApiV2Mutator.commit(
      conflictRequest,
      admitVerdict(conflictRequest, aggregateId),
    );
    expect(conflict).toMatchObject({
      outcome: 'refused',
      reason: 'idempotency_conflict',
      stateVersion: null,
      eventSequence: null,
      decidedAt: NOW,
    });
    expect(deps.controlApiV2Reader.read(conflictRequest).admissionLedger).toHaveLength(1);
    expect(deps.controlApiV2Reader.read(conflictRequest).admissionLedger[0]!.receipt).toEqual(first);

    const staleRequest = submitRequest(aggregateId, 1, projectionHash, 'req-decision-stale');
    const stale = deps.controlApiV2Mutator.commit(
      staleRequest,
      admitVerdict(staleRequest, aggregateId),
    );
    expect(stale).toMatchObject({
      outcome: 'refused',
      reason: 'stale_version',
      stateVersion: null,
      eventSequence: null,
    });
    expect(deps.controlApiV2Events.readEvents(0, 10).events).toHaveLength(3);
  });

  it('refuses a second approve_outcome via the engine as ineligible_decision', () => {
    const deps = openProvider([CONTROL_API_V2_ELIGIBLE_SEED_TASK_ID]);
    const aggregateId = CONTROL_API_V2_ELIGIBLE_SEED_TASK_ID;
    const initial = deps.controlApiV2Reader.read(reviewReadRequest(aggregateId));
    const firstRequest = submitRequest(
      aggregateId,
      1,
      initial.freshProjectionHash!,
      'req-approve-1',
      decisionPayload({ action: 'approve_outcome' }),
    );
    const firstVerdict = decideControlApiV2(firstRequest, deps.controlApiV2Reader.read(firstRequest), NOW);
    expect(firstVerdict).toMatchObject({ schema: 'hercules-control-api-admit-verdict/v2' });
    const committed = deps.controlApiV2Mutator.commit(
      firstRequest,
      firstVerdict as AdmissionVerdictV1,
    );
    expect(committed.outcome).toBe('committed');

    const after = deps.controlApiV2Reader.read(reviewReadRequest(aggregateId));
    expect(after.reviewPackage!.validDecisions).toEqual(['request_changes']);
    expect(after.reviewPackage!.decisionBinding).not.toBeNull();
    const secondRequest = submitRequest(
      aggregateId,
      after.currentStateVersion!,
      after.freshProjectionHash!,
      'req-approve-2',
      decisionPayload({ action: 'approve_outcome' }),
    );
    const secondDecision = decideControlApiV2(
      secondRequest,
      deps.controlApiV2Reader.read(secondRequest),
      NOW,
    );
    expect(secondDecision).toMatchObject({
      outcome: 'refused',
      reason: 'ineligible_decision',
    });
  });
});

describe('Control API V2 fake provider readEvents', () => {
  it('returns the correct global suffix, hasMore, and chain links', () => {
    const deps = openProvider([]);
    const ids: string[] = [];
    for (let i = 1; i <= 3; i += 1) {
      const request = createRequest(`req-chain-${String(i)}`);
      const aggregateId = deriveAggregateId(request.idempotencyKey!.keyHash);
      ids.push(aggregateId);
      deps.controlApiV2Mutator.commit(request, admitVerdict(request, aggregateId));
    }

    const all = deps.controlApiV2Events.readEvents(0, 10);
    expect(all.events).toHaveLength(3);
    expect(all.hasMore).toBe(false);
    expect(all.events[0]!.previousEventHash).toBeNull();
    expect(all.events[0]!.sequence).toBe(1);
    expect(all.events[0]!.eventType).toBe('V2AggregateMaterialized');
    expect(all.events[1]!.previousEventHash).toBe(all.events[0]!.eventHash);
    expect(all.events[2]!.previousEventHash).toBe(all.events[1]!.eventHash);
    for (const event of all.events) {
      assertControlEventView(event);
    }

    const mid = deps.controlApiV2Events.readEvents(1, 1);
    expect(mid.events).toHaveLength(1);
    expect(mid.events[0]!.sequence).toBe(2);
    expect(mid.hasMore).toBe(true);

    const tail = deps.controlApiV2Events.readEvents(2, 10);
    expect(tail.events).toHaveLength(1);
    expect(tail.events[0]!.sequence).toBe(3);
    expect(tail.hasMore).toBe(false);
  });
});
