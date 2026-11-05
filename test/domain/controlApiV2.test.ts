import { describe, expect, it } from 'vitest';
import { isValidIdentifier } from '../../src/domain/task.js';
import {
  projectAndAssertReviewPackageV2,
} from '../../src/domain/reviewPackageV2.js';
import { reviewPackageV2SourceFixture } from '../fixtures/reviewPackageV2Source.js';
import {
  ADMISSION_LEDGER_ENTRY_V1_KEYS,
  ADMISSION_VERDICT_V1_KEYS,
  CONTROL_API_V2_RECEIPT_V1_KEYS,
  CONTROL_API_V2_REFUSAL_V1_KEYS,
  CONTROL_API_V2_REVIEW_VIEW_V1_KEYS,
  CONTROL_API_V2_STATUS_VIEW_V1_KEYS,
  CONTROL_EVENT_VIEW_KEYS,
  ControlApiV2Error,
  ENGINE_REFUSAL_REASONS,
  EVENT_PAGE_V1_KEYS,
  MAX_EVENT_PAGE,
  RECEIPT_REFUSAL_REASONS,
  REFUSAL_CARRIER_REASONS,
  ROUTE_REFUSAL_REASONS,
  assertAdmissionLedgerEntryV1,
  assertAdmissionVerdictV1,
  assertConcurrencyTokenV2,
  assertControlApiV2ReceiptV1,
  assertControlApiV2RefusalV1,
  assertControlApiV2RequestV1,
  assertControlApiV2ReviewViewV1,
  assertControlApiV2StatusViewV1,
  assertControlEventView,
  assertCreatePayloadV1,
  assertDecisionPayloadV1,
  assertEventCursorRequestV1,
  assertEventPageV1,
  assertIdempotencyKeyV2,
  assertReadPayloadV1,
  buildConcurrencyToken,
  buildControlApiV2Request,
  buildIdempotencyKey,
  computeAdmissionVerdictHash,
  computeConcurrencyTokenHash,
  computeEventCursorHash,
  computeEventPageHash,
  computeIdempotencyKeyHash,
  computePayloadHash,
  computeReceiptHash,
  computeRefusalHash,
  computeRequestHash,
  computeReviewViewHash,
  computeStatusViewHash,
  deriveAggregateId,
  parseControlApiV2Response,
  type AdmissionLedgerEntryV1,
  type AdmissionVerdictV1,
  type ConcurrencyTokenV2,
  type ControlApiV2ReceiptV1,
  type ControlApiV2RefusalV1,
  type ControlApiV2RequestV1,
  type ControlApiV2ReviewViewV1,
  type ControlApiV2StatusViewV1,
  type ControlEventView,
  type CreatePayloadV1,
  type DecisionPayloadV1,
  type EventCursorRequestV1,
  type EventPageV1,
  type IdempotencyKeyV2,
  type ReadPayloadV1,
} from '../../src/domain/controlApiV2.js';

const HASH_A =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B =
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C =
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const TS = '2026-08-31T12:00:00.000Z';

function expectSchemaError(run: () => void): void {
  expect(run).toThrow(ControlApiV2Error);
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ControlApiV2Error);
    expect((error as ControlApiV2Error).code).toBe('invalid_input_schema');
  }
}

function idempotencyKey(
  overrides: Partial<IdempotencyKeyV2> = {},
): IdempotencyKeyV2 {
  const { keyHash: overrideHash, ...fields } = overrides;
  const withoutHash: Omit<IdempotencyKeyV2, 'keyHash'> = {
    actorIssuer: 'hercules-web',
    actorId: 'actor-1',
    aggregateId: 'task-1',
    clientRequestId: 'req-1',
    ...fields,
  };
  return {
    ...withoutHash,
    keyHash: overrideHash ?? computeIdempotencyKeyHash(withoutHash),
  };
}

function concurrencyToken(
  overrides: Partial<ConcurrencyTokenV2> = {},
): ConcurrencyTokenV2 {
  const { tokenHash: overrideHash, ...fields } = overrides;
  const withoutHash: Omit<ConcurrencyTokenV2, 'tokenHash'> = {
    aggregateId: 'task-1',
    stateVersion: 3,
    projectionHash: HASH_A,
    ...fields,
  };
  return {
    ...withoutHash,
    tokenHash: overrideHash ?? computeConcurrencyTokenHash(withoutHash),
  };
}

function createPayload(
  overrides: Partial<CreatePayloadV1> = {},
): CreatePayloadV1 {
  return {
    kind: 'create',
    taskContractHash: HASH_A,
    intentDigest: HASH_B,
    ...overrides,
  };
}

function decisionPayload(
  overrides: Partial<DecisionPayloadV1> = {},
): DecisionPayloadV1 {
  return {
    kind: 'decision',
    action: 'approve_outcome',
    reason: 'Looks good',
    acknowledgedRiskCodes: ['risk-a'],
    ...overrides,
  };
}

function readPayload(overrides: Partial<ReadPayloadV1> = {}): ReadPayloadV1 {
  return { kind: 'read', ...overrides };
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

function createRequest(
  overrides: Partial<ControlApiV2RequestV1> = {},
): ControlApiV2RequestV1 {
  const {
    requestHash: overrideRequestHash,
    payloadHash: overridePayloadHash,
    payload: overridePayload,
    idempotencyKey: overrideKey,
    ...fields
  } = overrides;
  const payload = overridePayload ?? createPayload();
  const key =
    overrideKey === undefined
      ? idempotencyKey({ aggregateId: '' })
      : overrideKey;
  const withoutHash: Omit<ControlApiV2RequestV1, 'requestHash'> = {
    schema: 'hercules-control-api-request/v2',
    resource: 'task',
    operation: 'create',
    aggregateId: '',
    idempotencyKey: key,
    concurrencyToken: null,
    payload,
    payloadHash: overridePayloadHash ?? computePayloadHash(payload),
    issuedAt: TS,
    ...fields,
  };
  return {
    ...withoutHash,
    requestHash: overrideRequestHash ?? computeRequestHash(withoutHash),
  };
}

function submitRequest(
  overrides: Partial<ControlApiV2RequestV1> = {},
): ControlApiV2RequestV1 {
  const payload = overrides.payload ?? decisionPayload();
  const key =
    overrides.idempotencyKey ??
    idempotencyKey({ aggregateId: 'task-1', clientRequestId: 'req-submit-1' });
  const token = overrides.concurrencyToken ?? concurrencyToken();
  const {
    requestHash: overrideRequestHash,
    payloadHash: overridePayloadHash,
    ...fields
  } = overrides;
  const withoutHash: Omit<ControlApiV2RequestV1, 'requestHash'> = {
    schema: 'hercules-control-api-request/v2',
    resource: 'decision',
    operation: 'submit',
    aggregateId: 'task-1',
    idempotencyKey: key,
    concurrencyToken: token,
    payload,
    payloadHash: overridePayloadHash ?? computePayloadHash(payload),
    issuedAt: TS,
    ...fields,
  };
  return {
    ...withoutHash,
    requestHash: overrideRequestHash ?? computeRequestHash(withoutHash),
  };
}

function statusReadRequest(
  overrides: Partial<ControlApiV2RequestV1> = {},
): ControlApiV2RequestV1 {
  const payload = overrides.payload ?? readPayload();
  const {
    requestHash: overrideRequestHash,
    payloadHash: overridePayloadHash,
    ...fields
  } = overrides;
  const withoutHash: Omit<ControlApiV2RequestV1, 'requestHash'> = {
    schema: 'hercules-control-api-request/v2',
    resource: 'status',
    operation: 'read',
    aggregateId: 'task-1',
    idempotencyKey: null,
    concurrencyToken: null,
    payload,
    payloadHash: overridePayloadHash ?? computePayloadHash(payload),
    issuedAt: TS,
    ...fields,
  };
  return {
    ...withoutHash,
    requestHash: overrideRequestHash ?? computeRequestHash(withoutHash),
  };
}

function reviewReadRequest(
  overrides: Partial<ControlApiV2RequestV1> = {},
): ControlApiV2RequestV1 {
  return statusReadRequest({ resource: 'review', ...overrides });
}

function eventReadRequest(
  overrides: Partial<ControlApiV2RequestV1> = {},
): ControlApiV2RequestV1 {
  const payload = overrides.payload ?? eventCursor();
  const {
    requestHash: overrideRequestHash,
    payloadHash: overridePayloadHash,
    ...fields
  } = overrides;
  const withoutHash: Omit<ControlApiV2RequestV1, 'requestHash'> = {
    schema: 'hercules-control-api-request/v2',
    resource: 'event',
    operation: 'read',
    aggregateId: '',
    idempotencyKey: null,
    concurrencyToken: null,
    payload,
    payloadHash: overridePayloadHash ?? computePayloadHash(payload),
    issuedAt: TS,
    ...fields,
  };
  return {
    ...withoutHash,
    requestHash: overrideRequestHash ?? computeRequestHash(withoutHash),
  };
}

function committedReceipt(
  overrides: Partial<ControlApiV2ReceiptV1> = {},
): ControlApiV2ReceiptV1 {
  const { receiptHash: overrideHash, ...fields } = overrides;
  const withoutHash: Omit<ControlApiV2ReceiptV1, 'receiptHash'> = {
    schema: 'hercules-control-api-receipt/v2',
    outcome: 'committed',
    resource: 'task',
    aggregateId: 'task-1',
    keyHash: HASH_A,
    requestHash: HASH_B,
    stateVersion: 1,
    eventSequence: 1,
    reason: null,
    decidedAt: TS,
    ...fields,
  };
  return {
    ...withoutHash,
    receiptHash: overrideHash ?? computeReceiptHash(withoutHash),
  };
}

function refusedReceipt(
  overrides: Partial<ControlApiV2ReceiptV1> = {},
): ControlApiV2ReceiptV1 {
  return committedReceipt({
    outcome: 'refused',
    resource: 'decision',
    stateVersion: null,
    eventSequence: null,
    reason: 'stale_version',
    ...overrides,
  });
}

function refusal(
  overrides: Partial<ControlApiV2RefusalV1> = {},
): ControlApiV2RefusalV1 {
  const { refusalHash: overrideHash, ...fields } = overrides;
  const withoutHash: Omit<ControlApiV2RefusalV1, 'refusalHash'> = {
    schema: 'hercules-control-api-refusal/v2',
    resource: 'status',
    aggregateId: 'task-1',
    requestHash: HASH_A,
    reason: 'unknown_aggregate',
    decidedAt: TS,
    ...fields,
  };
  return {
    ...withoutHash,
    refusalHash: overrideHash ?? computeRefusalHash(withoutHash),
  };
}

function statusView(
  overrides: Partial<ControlApiV2StatusViewV1> = {},
): ControlApiV2StatusViewV1 {
  const { viewHash: overrideHash, ...fields } = overrides;
  const withoutHash: Omit<ControlApiV2StatusViewV1, 'viewHash'> = {
    schema: 'hercules-control-api-status-view/v2',
    aggregateId: 'task-1',
    stateVersion: 2,
    taskStatus: 'review',
    latestEventSequence: 7,
    ...fields,
  };
  return {
    ...withoutHash,
    viewHash: overrideHash ?? computeStatusViewHash(withoutHash),
  };
}

function controlEventView(
  overrides: Partial<ControlEventView> = {},
): ControlEventView {
  return {
    sequence: 1,
    eventId: 'evt-1',
    eventType: 'ShadowContractRootProjected',
    aggregateKind: 'task',
    aggregateId: 'task-1',
    previousEventHash: null,
    eventHash: HASH_A,
    ...overrides,
  };
}

function eventPage(overrides: Partial<EventPageV1> = {}): EventPageV1 {
  const { pageHash: overrideHash, events: overrideEvents, ...fields } =
    overrides;
  const events = overrideEvents ?? [
    controlEventView(),
    controlEventView({
      sequence: 2,
      eventId: 'evt-2',
      previousEventHash: HASH_A,
      eventHash: HASH_B,
    }),
  ];
  const withoutHash: Omit<EventPageV1, 'pageHash'> = {
    schema: 'hercules-control-api-event-page/v2',
    afterSequence: 0,
    events,
    nextAfterSequence: events.length === 0 ? 0 : (events[events.length - 1]?.sequence ?? 0),
    endOfStream: true,
    ...fields,
  };
  return {
    ...withoutHash,
    pageHash: overrideHash ?? computeEventPageHash(withoutHash),
  };
}

function admissionVerdict(
  overrides: Partial<AdmissionVerdictV1> = {},
): AdmissionVerdictV1 {
  const { verdictHash: overrideHash, ...fields } = overrides;
  const withoutHash: Omit<AdmissionVerdictV1, 'verdictHash'> = {
    schema: 'hercules-control-api-admit-verdict/v2',
    resource: 'task',
    aggregateId: 'task-1',
    keyHash: HASH_A,
    requestHash: HASH_B,
    decidedAt: TS,
    ...fields,
  };
  return {
    ...withoutHash,
    verdictHash: overrideHash ?? computeAdmissionVerdictHash(withoutHash),
  };
}

function ledgerEntry(
  overrides: Partial<AdmissionLedgerEntryV1> = {},
): AdmissionLedgerEntryV1 {
  const receipt = overrides.receipt ?? committedReceipt();
  return {
    keyHash: overrides.keyHash ?? receipt.keyHash,
    requestHash: overrides.requestHash ?? receipt.requestHash,
    receipt,
  };
}

function projectedReviewPackage() {
  return projectAndAssertReviewPackageV2(reviewPackageV2SourceFixture());
}

function reviewView(
  overrides: Partial<ControlApiV2ReviewViewV1> = {},
): ControlApiV2ReviewViewV1 {
  const { viewHash: overrideHash, ...fields } = overrides;
  const withoutHash: Omit<ControlApiV2ReviewViewV1, 'viewHash'> = {
    schema: 'hercules-control-api-review-view/v2',
    aggregateId: 'task-1',
    stateVersion: 4,
    reviewPackage: projectedReviewPackage(),
    ...fields,
  };
  return {
    ...withoutHash,
    viewHash: overrideHash ?? computeReviewViewHash(withoutHash),
  };
}

const FORBIDDEN_MUTATION_FIELDS = [
  'taskState',
  'verdict',
  'eligibility',
  'recommendedNextStage',
  'route',
  'approval',
  'merge',
  'deployment',
] as const;

describe('controlApiV2 records', () => {
  it('happy-path construct+validate+hash round-trip for every record', () => {
    const key = idempotencyKey({ aggregateId: '' });
    assertIdempotencyKeyV2(key, { allowEmptyAggregateId: true });

    const token = concurrencyToken();
    assertConcurrencyTokenV2(token);

    const create = createPayload();
    assertCreatePayloadV1(create);
    const decision = decisionPayload();
    assertDecisionPayloadV1(decision);
    const read = readPayload();
    assertReadPayloadV1(read);
    const cursor = eventCursor();
    assertEventCursorRequestV1(cursor);

    assertControlApiV2RequestV1(createRequest());
    assertControlApiV2RequestV1(submitRequest());
    assertControlApiV2RequestV1(statusReadRequest());
    assertControlApiV2RequestV1(reviewReadRequest());
    assertControlApiV2RequestV1(eventReadRequest());

    assertControlApiV2ReceiptV1(committedReceipt());
    assertControlApiV2ReceiptV1(refusedReceipt());
    assertAdmissionLedgerEntryV1(ledgerEntry());
    assertControlApiV2RefusalV1(refusal());
    assertControlApiV2RefusalV1(refusal({ aggregateId: '', resource: 'event' }));
    assertControlApiV2StatusViewV1(statusView());
    assertControlApiV2ReviewViewV1(reviewView());
    assertControlEventView(controlEventView());
    assertControlEventView(
      controlEventView({
        sequence: 2,
        previousEventHash: HASH_A,
        eventHash: HASH_B,
      }),
    );
    assertEventPageV1(eventPage());
    assertEventPageV1(
      eventPage({ events: [], afterSequence: 5, nextAfterSequence: 5 }),
    );
    assertAdmissionVerdictV1(admissionVerdict());
  });

  it('hash determinism and mutation sensitivity', () => {
    const keyInput = {
      actorIssuer: 'hercules-web',
      actorId: 'actor-1',
      aggregateId: '',
      clientRequestId: 'req-1',
    };
    expect(computeIdempotencyKeyHash(keyInput)).toBe(
      computeIdempotencyKeyHash(keyInput),
    );
    expect(
      computeIdempotencyKeyHash({ ...keyInput, clientRequestId: 'req-2' }),
    ).not.toBe(computeIdempotencyKeyHash(keyInput));

    const tokenInput = {
      aggregateId: 'task-1',
      stateVersion: 1,
      projectionHash: HASH_A,
    };
    expect(computeConcurrencyTokenHash(tokenInput)).toBe(
      computeConcurrencyTokenHash(tokenInput),
    );
    expect(
      computeConcurrencyTokenHash({ ...tokenInput, stateVersion: 2 }),
    ).not.toBe(computeConcurrencyTokenHash(tokenInput));

    const payload = createPayload();
    expect(computePayloadHash(payload)).toBe(computePayloadHash(payload));
    expect(
      computePayloadHash(createPayload({ intentDigest: HASH_C })),
    ).not.toBe(computePayloadHash(payload));

    const receipt = committedReceipt();
    const without = {
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
    } as const;
    expect(computeReceiptHash(without)).toBe(receipt.receiptHash);
    expect(
      computeReceiptHash({ ...without, stateVersion: 99 }),
    ).not.toBe(receipt.receiptHash);
  });

  it('closed key-set proofs: receipt/refusal/views carry no forbidden fields', () => {
    for (const keys of [
      CONTROL_API_V2_RECEIPT_V1_KEYS,
      CONTROL_API_V2_REFUSAL_V1_KEYS,
      CONTROL_API_V2_REVIEW_VIEW_V1_KEYS,
      CONTROL_API_V2_STATUS_VIEW_V1_KEYS,
      EVENT_PAGE_V1_KEYS,
      ADMISSION_VERDICT_V1_KEYS,
      ADMISSION_LEDGER_ENTRY_V1_KEYS,
      CONTROL_EVENT_VIEW_KEYS,
    ]) {
      for (const forbidden of FORBIDDEN_MUTATION_FIELDS) {
        expect(keys).not.toContain(forbidden);
      }
    }

    for (const forbidden of FORBIDDEN_MUTATION_FIELDS) {
      expectSchemaError(() =>
        assertControlApiV2ReceiptV1({
          ...committedReceipt(),
          [forbidden]: 'x',
        } as unknown as ControlApiV2ReceiptV1),
      );
      expectSchemaError(() =>
        assertControlApiV2RefusalV1({
          ...refusal(),
          [forbidden]: 'x',
        } as unknown as ControlApiV2RefusalV1),
      );
      expectSchemaError(() =>
        assertControlApiV2StatusViewV1({
          ...statusView(),
          [forbidden]: 'x',
        } as unknown as ControlApiV2StatusViewV1),
      );
    }
  });

  it('request presence/absence matrix: create/submit/read/event and rejected mis-shapes', () => {
    assertControlApiV2RequestV1(createRequest());
    assertControlApiV2RequestV1(submitRequest());
    assertControlApiV2RequestV1(statusReadRequest());
    assertControlApiV2RequestV1(reviewReadRequest());
    assertControlApiV2RequestV1(eventReadRequest());

    // create with concurrency token
    expectSchemaError(() =>
      assertControlApiV2RequestV1(
        createRequest({ concurrencyToken: concurrencyToken() }),
      ),
    );
    // create with non-empty aggregateId
    expectSchemaError(() =>
      assertControlApiV2RequestV1(createRequest({ aggregateId: 'task-1' })),
    );
    // create without key
    expectSchemaError(() =>
      assertControlApiV2RequestV1(createRequest({ idempotencyKey: null })),
    );
    // submit without token
    expectSchemaError(() =>
      assertControlApiV2RequestV1(submitRequest({ concurrencyToken: null })),
    );
    // submit without key
    expectSchemaError(() =>
      assertControlApiV2RequestV1(submitRequest({ idempotencyKey: null })),
    );
    // submit with empty aggregateId
    expectSchemaError(() =>
      assertControlApiV2RequestV1(submitRequest({ aggregateId: '' })),
    );
    // status read with key
    expectSchemaError(() =>
      assertControlApiV2RequestV1(
        statusReadRequest({
          idempotencyKey: idempotencyKey({ aggregateId: 'task-1' }),
        }),
      ),
    );
    // event read with non-empty aggregateId
    expectSchemaError(() =>
      assertControlApiV2RequestV1(eventReadRequest({ aggregateId: 'task-1' })),
    );
    // event read with token
    expectSchemaError(() =>
      assertControlApiV2RequestV1(
        eventReadRequest({ concurrencyToken: concurrencyToken() }),
      ),
    );
    // wrong payload discriminant for create
    expectSchemaError(() =>
      assertControlApiV2RequestV1(createRequest({ payload: readPayload() })),
    );
    // wrong payload for submit
    expectSchemaError(() =>
      assertControlApiV2RequestV1(submitRequest({ payload: createPayload() })),
    );
  });

  it('rejects payloadHash mismatch', () => {
    expectSchemaError(() =>
      assertControlApiV2RequestV1(
        createRequest({ payloadHash: HASH_C }),
      ),
    );
  });

  it('deriveAggregateId yields a valid bounded identifier, is deterministic, and distinct', () => {
    const idA = deriveAggregateId(HASH_A);
    const idA2 = deriveAggregateId(HASH_A);
    const idB = deriveAggregateId(HASH_B);
    expect(idA).toBe(idA2);
    expect(idA).not.toBe(idB);
    expect(isValidIdentifier(idA)).toBe(true);
    expect(idA.startsWith('task-')).toBe(true);
    expect(idA.includes(':')).toBe(false);
    expectSchemaError(() => deriveAggregateId('not-a-hash'));
  });

  it('ControlEventView genesis null accepted; non-genesis null rejected', () => {
    assertControlEventView(controlEventView({ sequence: 1, previousEventHash: null }));
    expectSchemaError(() =>
      assertControlEventView(
        controlEventView({ sequence: 1, previousEventHash: HASH_A }),
      ),
    );
    expectSchemaError(() =>
      assertControlEventView(
        controlEventView({ sequence: 2, previousEventHash: null }),
      ),
    );
    assertControlEventView(
      controlEventView({
        sequence: 2,
        previousEventHash: HASH_A,
        eventHash: HASH_B,
      }),
    );
  });

  it('EventCursor limit bounds and expectedPreviousEventHash genesis rule', () => {
    assertEventCursorRequestV1(eventCursor({ limit: 1 }));
    assertEventCursorRequestV1(eventCursor({ limit: MAX_EVENT_PAGE }));
    expectSchemaError(() =>
      assertEventCursorRequestV1(eventCursor({ limit: 0 })),
    );
    expectSchemaError(() =>
      assertEventCursorRequestV1(eventCursor({ limit: MAX_EVENT_PAGE + 1 })),
    );
    expectSchemaError(() =>
      assertEventCursorRequestV1(
        eventCursor({
          afterSequence: 0,
          expectedPreviousEventHash: HASH_A,
        }),
      ),
    );
    expectSchemaError(() =>
      assertEventCursorRequestV1(
        eventCursor({
          afterSequence: 3,
          expectedPreviousEventHash: null,
        }),
      ),
    );
    assertEventCursorRequestV1(
      eventCursor({
        afterSequence: 3,
        expectedPreviousEventHash: HASH_A,
      }),
    );
  });

  it('frozen reason unions equal the contract sets', () => {
    expect([...ENGINE_REFUSAL_REASONS]).toEqual([
      'invalid_input_schema',
      'unknown_aggregate',
      'idempotency_conflict',
      'stale_version',
      'stale_projection',
      'need_more_evidence',
      'ineligible_decision',
      'broken_event_chain',
    ]);
    expect(ENGINE_REFUSAL_REASONS).toHaveLength(8);
    for (const route of ROUTE_REFUSAL_REASONS) {
      expect(ENGINE_REFUSAL_REASONS).not.toContain(route);
    }
    expect([...ROUTE_REFUSAL_REASONS]).toEqual([
      'unauthorized',
      'provider_unavailable',
    ]);
    expect(ROUTE_REFUSAL_REASONS).toHaveLength(2);
    expect([...RECEIPT_REFUSAL_REASONS]).not.toContain('invalid_input_schema');
    expect([...RECEIPT_REFUSAL_REASONS]).not.toContain('broken_event_chain');
    expect([...REFUSAL_CARRIER_REASONS]).toEqual([
      'invalid_input_schema',
      'unknown_aggregate',
      'broken_event_chain',
    ]);
  });

  it('receipt refuses invalid_input_schema / broken_event_chain as reason', () => {
    expectSchemaError(() =>
      assertControlApiV2ReceiptV1(
        refusedReceipt({ reason: 'invalid_input_schema' }),
      ),
    );
    expectSchemaError(() =>
      assertControlApiV2ReceiptV1(
        refusedReceipt({ reason: 'broken_event_chain' }),
      ),
    );
    expectSchemaError(() =>
      assertControlApiV2ReceiptV1(
        committedReceipt({ reason: 'stale_version' }),
      ),
    );
    expectSchemaError(() =>
      assertControlApiV2ReceiptV1(
        refusedReceipt({ stateVersion: 1, eventSequence: null }),
      ),
    );
  });

  it('client helpers round-trip and parseControlApiV2Response accepts each member', () => {
    const key = buildIdempotencyKey({
      actorIssuer: 'hercules-web',
      actorId: 'actor-1',
      aggregateId: '',
      clientRequestId: 'req-create-1',
    });
    expect(key.keyHash).toBe(
      computeIdempotencyKeyHash({
        actorIssuer: 'hercules-web',
        actorId: 'actor-1',
        aggregateId: '',
        clientRequestId: 'req-create-1',
      }),
    );

    const token = buildConcurrencyToken({
      aggregateId: 'task-1',
      stateVersion: 3,
      projectionHash: HASH_A,
    });
    expect(token.tokenHash).toBe(
      computeConcurrencyTokenHash({
        aggregateId: 'task-1',
        stateVersion: 3,
        projectionHash: HASH_A,
      }),
    );

    const create = buildControlApiV2Request({
      resource: 'task',
      operation: 'create',
      aggregateId: '',
      idempotencyKey: key,
      concurrencyToken: null,
      payload: createPayload(),
      issuedAt: TS,
    });
    assertControlApiV2RequestV1(create);

    const submitKey = buildIdempotencyKey({
      actorIssuer: 'hercules-web',
      actorId: 'actor-1',
      aggregateId: 'task-1',
      clientRequestId: 'req-submit-1',
    });
    const submit = buildControlApiV2Request({
      resource: 'decision',
      operation: 'submit',
      aggregateId: 'task-1',
      idempotencyKey: submitKey,
      concurrencyToken: token,
      payload: decisionPayload(),
      issuedAt: TS,
    });
    assertControlApiV2RequestV1(submit);

    const receipt = committedReceipt();
    expect(parseControlApiV2Response(receipt)).toEqual(receipt);

    const refused = refusedReceipt();
    expect(parseControlApiV2Response(refused)).toEqual(refused);

    const refusalValue = refusal();
    expect(parseControlApiV2Response(refusalValue)).toEqual(refusalValue);

    const status = statusView();
    expect(parseControlApiV2Response(status)).toEqual(status);

    const review = reviewView();
    expect(parseControlApiV2Response(review)).toEqual(review);

    const page = eventPage();
    expect(parseControlApiV2Response(page)).toEqual(page);

    expectSchemaError(() => parseControlApiV2Response(null));
    expectSchemaError(() => parseControlApiV2Response({ schema: 'nope' }));
    expectSchemaError(() =>
      parseControlApiV2Response({
        ...receipt,
        receiptHash: HASH_C,
      }),
    );
  });

  it('deep-freeze immutability after validation', () => {
    const receipt = committedReceipt();
    assertControlApiV2ReceiptV1(receipt);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(() => {
      (receipt as { outcome: string }).outcome = 'refused';
    }).toThrow();

    const page = eventPage();
    assertEventPageV1(page);
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.events)).toBe(true);
    expect(Object.isFrozen(page.events[0])).toBe(true);

    const request = createRequest();
    assertControlApiV2RequestV1(request);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.payload)).toBe(true);
    expect(Object.isFrozen(request.idempotencyKey)).toBe(true);
  });
});
