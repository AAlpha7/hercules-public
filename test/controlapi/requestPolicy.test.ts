import { describe, expect, it } from 'vitest';
import { decideControlApiV2 } from '../../src/controlapi/requestPolicy.js';
import { hashCanonicalJson } from '../../src/domain/canonicalJson.js';
import {
  ControlApiV2Error,
  MAX_EVENT_PAGE,
  assertAdmissionLedgerEntryV1,
  assertControlApiV2ReceiptV1,
  assertControlApiV2RequestV1,
  assertControlEventView,
  buildConcurrencyToken,
  buildControlApiV2Request,
  buildIdempotencyKey,
  computeEventCursorHash,
  computePayloadHash,
  computeReceiptHash,
  computeRequestHash,
  deriveAggregateId,
  type AdmissionLedgerEntryV1,
  type ConcurrencyTokenV2,
  type ControlApiV2ReadsV1,
  type ControlApiV2ReceiptV1,
  type ControlApiV2RequestV1,
  type ControlEventView,
  type CreatePayloadV1,
  type DecisionPayloadV1,
  type EventCursorRequestV1,
  type IdempotencyKeyV2,
  type ReadPayloadV1,
} from '../../src/domain/controlApiV2.js';
import {
  computeVerificationReceiptHash,
} from '../../src/domain/claimAuthorityV2.js';
import {
  projectAndAssertReviewPackageV2,
  type ReviewPackageV2,
  type ReviewPackageV2Source,
} from '../../src/domain/reviewPackageV2.js';
import { reviewPackageV2SourceFixture } from '../fixtures/reviewPackageV2Source.js';

const HASH_A =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B =
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C =
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const TS = '2026-08-31T12:00:00.000Z';
const NOW = '2026-08-31T12:05:00.000Z';

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
    action: 'request_changes',
    reason: 'Need a follow-up',
    acknowledgedRiskCodes: [],
    ...overrides,
  };
}

function readPayload(): ReadPayloadV1 {
  return { kind: 'read' };
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
  const key =
    overrides.idempotencyKey === undefined
      ? buildIdempotencyKey({
          actorIssuer: 'hercules-web',
          actorId: 'actor-1',
          aggregateId: '',
          clientRequestId: 'req-create-1',
        })
      : overrides.idempotencyKey;
  return buildControlApiV2Request({
    resource: 'task',
    operation: 'create',
    aggregateId: '',
    idempotencyKey: key,
    concurrencyToken: null,
    payload: overrides.payload ?? createPayload(),
    issuedAt: overrides.issuedAt ?? TS,
  });
}

function eligibleReviewPackage(): ReviewPackageV2 {
  return projectAndAssertReviewPackageV2(reviewPackageV2SourceFixture());
}

function ineligibleReviewPackage(): ReviewPackageV2 {
  const source = reviewPackageV2SourceFixture();
  const current = source.verificationReceipts[0];
  if (current === undefined) {
    throw new Error('fixture must carry a verification receipt');
  }
  const { receiptHash: _receiptHash, ...withoutHash } = current;
  const next = { ...withoutHash, verifierRunId: 'untrusted-agent' };
  const mutated: ReviewPackageV2Source = {
    ...source,
    verificationReceipts: [
      { ...next, receiptHash: computeVerificationReceiptHash(next) },
    ],
  };
  return projectAndAssertReviewPackageV2(mutated);
}

function submitRequest(
  overrides: {
    readonly action?: DecisionPayloadV1['action'];
    readonly aggregateId?: string;
    readonly stateVersion?: number;
    readonly projectionHash?: string;
    readonly clientRequestId?: string;
    readonly concurrencyToken?: ConcurrencyTokenV2 | null;
    readonly idempotencyKey?: IdempotencyKeyV2 | null;
    readonly payload?: DecisionPayloadV1;
  } = {},
): ControlApiV2RequestV1 {
  const aggregateId = overrides.aggregateId ?? 'task-1';
  const review = eligibleReviewPackage();
  const projectionHash =
    overrides.projectionHash ?? review.projectionHash;
  const key =
    overrides.idempotencyKey === undefined
      ? buildIdempotencyKey({
          actorIssuer: 'hercules-web',
          actorId: 'actor-1',
          aggregateId,
          clientRequestId: overrides.clientRequestId ?? 'req-submit-1',
        })
      : overrides.idempotencyKey;
  const token =
    overrides.concurrencyToken === undefined
      ? buildConcurrencyToken({
          aggregateId,
          stateVersion: overrides.stateVersion ?? 3,
          projectionHash,
        })
      : overrides.concurrencyToken;
  return buildControlApiV2Request({
    resource: 'decision',
    operation: 'submit',
    aggregateId,
    idempotencyKey: key,
    concurrencyToken: token,
    payload:
      overrides.payload ??
      decisionPayload({
        action: overrides.action ?? 'request_changes',
      }),
    issuedAt: TS,
  });
}

function statusReadRequest(
  aggregateId = 'task-1',
): ControlApiV2RequestV1 {
  return buildControlApiV2Request({
    resource: 'status',
    operation: 'read',
    aggregateId,
    idempotencyKey: null,
    concurrencyToken: null,
    payload: readPayload(),
    issuedAt: TS,
  });
}

function reviewReadRequest(
  aggregateId = 'task-1',
): ControlApiV2RequestV1 {
  return buildControlApiV2Request({
    resource: 'review',
    operation: 'read',
    aggregateId,
    idempotencyKey: null,
    concurrencyToken: null,
    payload: readPayload(),
    issuedAt: TS,
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
    issuedAt: TS,
  });
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
  const receipt: ControlApiV2ReceiptV1 = {
    ...withoutHash,
    receiptHash: overrideHash ?? computeReceiptHash(withoutHash),
  };
  assertControlApiV2ReceiptV1(receipt);
  return receipt;
}

function ledgerEntry(
  overrides: Partial<AdmissionLedgerEntryV1> = {},
): AdmissionLedgerEntryV1 {
  const receipt = overrides.receipt ?? committedReceipt();
  const entry: AdmissionLedgerEntryV1 = {
    keyHash: overrides.keyHash ?? receipt.keyHash,
    requestHash: overrides.requestHash ?? receipt.requestHash,
    receipt,
  };
  assertAdmissionLedgerEntryV1(entry);
  return entry;
}

function controlEventView(
  overrides: Partial<ControlEventView> = {},
): ControlEventView {
  const view: ControlEventView = {
    sequence: 1,
    eventId: 'evt-1',
    eventType: 'ShadowContractRootProjected',
    aggregateKind: 'task',
    aggregateId: 'task-1',
    previousEventHash: null,
    eventHash: HASH_A,
    ...overrides,
  };
  assertControlEventView(view);
  return view;
}

function emptyReads(
  overrides: Partial<ControlApiV2ReadsV1> = {},
): ControlApiV2ReadsV1 {
  return {
    aggregateExists: false,
    currentStateVersion: null,
    taskStatus: null,
    latestEventSequence: null,
    freshProjectionHash: null,
    reviewPackage: null,
    admissionLedger: [],
    events: null,
    eventsHasMore: false,
    ...overrides,
  };
}

function submitReads(
  overrides: Partial<ControlApiV2ReadsV1> = {},
): ControlApiV2ReadsV1 {
  const review = overrides.reviewPackage ?? eligibleReviewPackage();
  return emptyReads({
    aggregateExists: true,
    currentStateVersion: 3,
    taskStatus: 'review',
    latestEventSequence: 7,
    freshProjectionHash: review.projectionHash,
    reviewPackage: review,
    admissionLedger: [],
    events: null,
    eventsHasMore: false,
    ...overrides,
  });
}

describe('decideControlApiV2 — create', () => {
  it('structural-invalid → Refusal invalid_input_schema', () => {
    const valid = createRequest();
    const invalid = {
      ...valid,
      concurrencyToken: buildConcurrencyToken({
        aggregateId: 'task-1',
        stateVersion: 0,
        projectionHash: HASH_A,
      }),
    };
    const decision = decideControlApiV2(
      invalid as unknown as ControlApiV2RequestV1,
      emptyReads(),
      NOW,
    );
    expect(decision).toMatchObject({
      schema: 'hercules-control-api-refusal/v2',
      reason: 'invalid_input_schema',
      resource: 'task',
    });
  });

  it('replay → byte-identical stored committed receipt', () => {
    const request = createRequest();
    const keyHash = request.idempotencyKey!.keyHash;
    const receipt = committedReceipt({
      resource: 'task',
      aggregateId: deriveAggregateId(keyHash),
      keyHash,
      requestHash: request.requestHash,
      stateVersion: 1,
      eventSequence: 1,
    });
    const reads = emptyReads({
      admissionLedger: [ledgerEntry({ receipt })],
    });
    const decision = decideControlApiV2(request, reads, NOW);
    expect(decision).toEqual(receipt);
    expect(decision).toBe(reads.admissionLedger[0]?.receipt);
  });

  it('idempotency_conflict → refused receipt', () => {
    const request = createRequest();
    const keyHash = request.idempotencyKey!.keyHash;
    const prior = committedReceipt({
      resource: 'task',
      aggregateId: deriveAggregateId(keyHash),
      keyHash,
      requestHash: HASH_C,
      stateVersion: 1,
      eventSequence: 1,
    });
    const decision = decideControlApiV2(
      request,
      emptyReads({ admissionLedger: [ledgerEntry({ receipt: prior })] }),
      NOW,
    );
    expect(decision).toMatchObject({
      schema: 'hercules-control-api-receipt/v2',
      outcome: 'refused',
      reason: 'idempotency_conflict',
      keyHash,
      requestHash: request.requestHash,
      stateVersion: null,
      eventSequence: null,
      aggregateId: deriveAggregateId(keyHash),
    });
  });

  it('fresh → AdmissionVerdict with deriveAggregateId(keyHash)', () => {
    const request = createRequest();
    const keyHash = request.idempotencyKey!.keyHash;
    const decision = decideControlApiV2(request, emptyReads(), NOW);
    expect(decision).toMatchObject({
      schema: 'hercules-control-api-admit-verdict/v2',
      resource: 'task',
      aggregateId: deriveAggregateId(keyHash),
      keyHash,
      requestHash: request.requestHash,
      decidedAt: NOW,
    });
  });
});

describe('decideControlApiV2 — submit', () => {
  it('structural-invalid → Refusal', () => {
    const valid = submitRequest();
    const invalid = { ...valid, concurrencyToken: null };
    const decision = decideControlApiV2(
      invalid as unknown as ControlApiV2RequestV1,
      submitReads(),
      NOW,
    );
    expect(decision).toMatchObject({
      schema: 'hercules-control-api-refusal/v2',
      reason: 'invalid_input_schema',
    });
  });

  it('unknown_aggregate → refused receipt (before concurrency)', () => {
    const request = submitRequest();
    const decision = decideControlApiV2(
      request,
      emptyReads({ aggregateExists: false }),
      NOW,
    );
    expect(decision).toMatchObject({
      schema: 'hercules-control-api-receipt/v2',
      outcome: 'refused',
      reason: 'unknown_aggregate',
      resource: 'decision',
      keyHash: request.idempotencyKey!.keyHash,
    });
  });

  it('replay → byte-identical stored receipt', () => {
    const request = submitRequest();
    const keyHash = request.idempotencyKey!.keyHash;
    const receipt = committedReceipt({
      resource: 'decision',
      aggregateId: 'task-1',
      keyHash,
      requestHash: request.requestHash,
      stateVersion: 4,
      eventSequence: 9,
    });
    const decision = decideControlApiV2(
      request,
      submitReads({ admissionLedger: [ledgerEntry({ receipt })] }),
      NOW,
    );
    expect(decision).toEqual(receipt);
  });

  it('idempotency_conflict → refused receipt', () => {
    const request = submitRequest();
    const keyHash = request.idempotencyKey!.keyHash;
    const prior = committedReceipt({
      resource: 'decision',
      aggregateId: 'task-1',
      keyHash,
      requestHash: HASH_C,
      stateVersion: 2,
      eventSequence: 3,
    });
    const decision = decideControlApiV2(
      request,
      submitReads({ admissionLedger: [ledgerEntry({ receipt: prior })] }),
      NOW,
    );
    expect(decision).toMatchObject({
      outcome: 'refused',
      reason: 'idempotency_conflict',
    });
  });

  it('stale_version → refused receipt (before projection check)', () => {
    const review = eligibleReviewPackage();
    const request = submitRequest({
      stateVersion: 1,
      projectionHash: HASH_A,
    });
    const decision = decideControlApiV2(
      request,
      submitReads({
        currentStateVersion: 3,
        freshProjectionHash: review.projectionHash,
        reviewPackage: review,
      }),
      NOW,
    );
    expect(decision).toMatchObject({
      outcome: 'refused',
      reason: 'stale_version',
    });
  });

  it('stale_projection → refused receipt when version matches', () => {
    const review = eligibleReviewPackage();
    const request = submitRequest({
      stateVersion: 3,
      projectionHash: HASH_A,
    });
    const decision = decideControlApiV2(
      request,
      submitReads({
        currentStateVersion: 3,
        freshProjectionHash: review.projectionHash,
        reviewPackage: review,
      }),
      NOW,
    );
    expect(decision).toMatchObject({
      outcome: 'refused',
      reason: 'stale_projection',
    });
  });

  it('both version+projection mismatch yields stale_version (sub-order)', () => {
    const review = eligibleReviewPackage();
    const request = submitRequest({
      stateVersion: 0,
      projectionHash: HASH_A,
    });
    const decision = decideControlApiV2(
      request,
      submitReads({
        currentStateVersion: 3,
        freshProjectionHash: review.projectionHash,
        reviewPackage: review,
      }),
      NOW,
    );
    expect(decision).toMatchObject({ reason: 'stale_version' });
  });

  it('need_more_evidence when decisionBinding is null (before action check)', () => {
    const ineligible = ineligibleReviewPackage();
    expect(ineligible.decisionBinding).toBeNull();
    const request = submitRequest({
      stateVersion: 3,
      projectionHash: ineligible.projectionHash,
      action: 'approve_outcome',
    });
    const decision = decideControlApiV2(
      request,
      submitReads({
        currentStateVersion: 3,
        freshProjectionHash: ineligible.projectionHash,
        reviewPackage: ineligible,
      }),
      NOW,
    );
    expect(decision).toMatchObject({
      outcome: 'refused',
      reason: 'need_more_evidence',
    });
  });

  it('ineligible_decision when action ∉ validDecisions', () => {
    const review = eligibleReviewPackage();
    expect(review.validDecisions).toEqual(['request_changes']);
    const request = submitRequest({
      action: 'approve_outcome',
      stateVersion: 3,
      projectionHash: review.projectionHash,
    });
    const decision = decideControlApiV2(
      request,
      submitReads({
        currentStateVersion: 3,
        freshProjectionHash: review.projectionHash,
        reviewPackage: review,
      }),
      NOW,
    );
    expect(decision).toMatchObject({
      outcome: 'refused',
      reason: 'ineligible_decision',
    });
  });

  it('eligibility sub-order: need_more_evidence wins over ineligible action', () => {
    const ineligible = ineligibleReviewPackage();
    const request = submitRequest({
      stateVersion: 3,
      projectionHash: ineligible.projectionHash,
      action: 'approve_outcome',
    });
    const decision = decideControlApiV2(
      request,
      submitReads({
        currentStateVersion: 3,
        freshProjectionHash: ineligible.projectionHash,
        reviewPackage: ineligible,
      }),
      NOW,
    );
    expect(decision).toMatchObject({ reason: 'need_more_evidence' });
  });

  it('ineligible_decision when approve omits a remaining risk code', () => {
    const review = projectAndAssertReviewPackageV2(
      reviewPackageV2SourceFixture({
        requiresHumanDecision: true,
        remainingRiskCode: 'residual_surface_risk',
      }),
    );
    expect(review.validDecisions).toContain('approve_outcome');
    expect(review.remainingRisks.map((finding) => finding.code)).toContain(
      'residual_surface_risk',
    );
    const request = submitRequest({
      action: 'approve_outcome',
      stateVersion: 3,
      projectionHash: review.projectionHash,
      payload: decisionPayload({
        action: 'approve_outcome',
        acknowledgedRiskCodes: [],
      }),
    });
    const decision = decideControlApiV2(
      request,
      submitReads({
        currentStateVersion: 3,
        freshProjectionHash: review.projectionHash,
        reviewPackage: review,
      }),
      NOW,
    );
    expect(decision).toMatchObject({
      outcome: 'refused',
      reason: 'ineligible_decision',
    });
  });

  it('admits approve when every structured risk code is acknowledged', () => {
    const review = projectAndAssertReviewPackageV2(
      reviewPackageV2SourceFixture({
        requiresHumanDecision: true,
        remainingRiskCode: 'residual_surface_risk',
      }),
    );
    const codes = [
      ...new Set([
        ...review.blockingFindings.map((finding) => finding.code),
        ...review.remainingRisks.map((finding) => finding.code),
        ...review.criteria
          .filter((criterion) => criterion.authority === 'human' && criterion.required)
          .map((criterion) => `human:${criterion.criterionId}`),
      ]),
    ].sort();
    const request = submitRequest({
      action: 'approve_outcome',
      stateVersion: 3,
      projectionHash: review.projectionHash,
      payload: decisionPayload({
        action: 'approve_outcome',
        acknowledgedRiskCodes: codes,
      }),
    });
    const decision = decideControlApiV2(
      request,
      submitReads({
        currentStateVersion: 3,
        freshProjectionHash: review.projectionHash,
        reviewPackage: review,
      }),
      NOW,
    );
    expect(decision).toMatchObject({
      schema: 'hercules-control-api-admit-verdict/v2',
      resource: 'decision',
      aggregateId: 'task-1',
    });
  });

  it('ineligible_decision when approve omits a human:<criterionId> acknowledgement', () => {
    // Engine step 5 reads criteria[] shape only (trusted reads are lightly gated), so
    // patch a human row onto an otherwise eligible package without re-projecting.
    const base = projectAndAssertReviewPackageV2(
      reviewPackageV2SourceFixture({ requiresHumanDecision: true }),
    );
    const review = {
      ...base,
      criteria: [
        ...base.criteria,
        {
          criterionId: 'human-ui',
          authority: 'human' as const,
          required: true,
          status: 'needs_human' as const,
          assertionIds: [] as const,
          evidenceArtifactIds: [] as const,
          reasonCodes: ['human_decision_required'] as const,
          advisoryExplanation: 'Operator reviewed the UI',
        },
      ],
    };
    expect(review.validDecisions).toContain('approve_outcome');
    expect(review.decisionBinding).not.toBeNull();
    const structured = [
      ...new Set([
        ...review.blockingFindings.map((finding) => finding.code),
        ...review.remainingRisks.map((finding) => finding.code),
      ]),
    ].sort();
    const request = submitRequest({
      action: 'approve_outcome',
      stateVersion: 3,
      projectionHash: review.projectionHash,
      payload: decisionPayload({
        action: 'approve_outcome',
        acknowledgedRiskCodes: structured,
      }),
    });
    const decision = decideControlApiV2(
      request,
      submitReads({
        currentStateVersion: 3,
        freshProjectionHash: review.projectionHash,
        reviewPackage: review as ReviewPackageV2,
      }),
      NOW,
    );
    expect(decision).toMatchObject({
      outcome: 'refused',
      reason: 'ineligible_decision',
    });
  });

  it('admits request_changes without acknowledging risk codes', () => {
    const review = projectAndAssertReviewPackageV2(
      reviewPackageV2SourceFixture({
        requiresHumanDecision: true,
        remainingRiskCode: 'residual_surface_risk',
      }),
    );
    expect(review.validDecisions).toContain('request_changes');
    const request = submitRequest({
      action: 'request_changes',
      stateVersion: 3,
      projectionHash: review.projectionHash,
      payload: decisionPayload({
        action: 'request_changes',
        acknowledgedRiskCodes: [],
      }),
    });
    const decision = decideControlApiV2(
      request,
      submitReads({
        currentStateVersion: 3,
        freshProjectionHash: review.projectionHash,
        reviewPackage: review,
      }),
      NOW,
    );
    expect(decision).toMatchObject({
      schema: 'hercules-control-api-admit-verdict/v2',
      resource: 'decision',
    });
  });

  it('ineligible_decision when approve acknowledges an unknown human: code', () => {
    const base = projectAndAssertReviewPackageV2(
      reviewPackageV2SourceFixture({ requiresHumanDecision: true }),
    );
    const review = {
      ...base,
      criteria: [
        ...base.criteria,
        {
          criterionId: 'human-ui',
          authority: 'human' as const,
          required: true,
          status: 'needs_human' as const,
          assertionIds: [] as const,
          evidenceArtifactIds: [] as const,
          reasonCodes: ['human_decision_required'] as const,
          advisoryExplanation: 'Operator reviewed the UI',
        },
      ],
    };
    const codes = [
      ...new Set([
        ...review.blockingFindings.map((finding) => finding.code),
        ...review.remainingRisks.map((finding) => finding.code),
        'human:human-ui',
        'human:zz-bogus',
      ]),
    ].sort();
    const request = submitRequest({
      action: 'approve_outcome',
      stateVersion: 3,
      projectionHash: review.projectionHash,
      payload: decisionPayload({
        action: 'approve_outcome',
        acknowledgedRiskCodes: codes,
      }),
    });
    const decision = decideControlApiV2(
      request,
      submitReads({
        currentStateVersion: 3,
        freshProjectionHash: review.projectionHash,
        reviewPackage: review as ReviewPackageV2,
      }),
      NOW,
    );
    expect(decision).toMatchObject({
      outcome: 'refused',
      reason: 'ineligible_decision',
    });
  });

  it('admits approve when a non-required human code accompanies the required one', () => {
    const base = projectAndAssertReviewPackageV2(
      reviewPackageV2SourceFixture({ requiresHumanDecision: true }),
    );
    const review = {
      ...base,
      criteria: [
        ...base.criteria,
        {
          criterionId: 'human-required',
          authority: 'human' as const,
          required: true,
          status: 'needs_human' as const,
          assertionIds: [] as const,
          evidenceArtifactIds: [] as const,
          reasonCodes: ['human_decision_required'] as const,
          advisoryExplanation: 'Owner accepts the change',
        },
        {
          criterionId: 'human-after-deploy',
          authority: 'human' as const,
          required: false,
          status: 'not_applicable' as const,
          assertionIds: [] as const,
          evidenceArtifactIds: [] as const,
          reasonCodes: [] as const,
          advisoryExplanation: '',
        },
      ],
    };
    const codes = [
      ...new Set([
        ...review.blockingFindings.map((finding) => finding.code),
        ...review.remainingRisks.map((finding) => finding.code),
        'human:human-required',
        'human:human-after-deploy',
      ]),
    ].sort();
    const request = submitRequest({
      action: 'approve_outcome',
      stateVersion: 3,
      projectionHash: review.projectionHash,
      payload: decisionPayload({
        action: 'approve_outcome',
        acknowledgedRiskCodes: codes,
      }),
    });
    const decision = decideControlApiV2(
      request,
      submitReads({
        currentStateVersion: 3,
        freshProjectionHash: review.projectionHash,
        reviewPackage: review as ReviewPackageV2,
      }),
      NOW,
    );
    expect(decision).toMatchObject({
      schema: 'hercules-control-api-admit-verdict/v2',
      resource: 'decision',
      aggregateId: 'task-1',
    });
  });

  it('fresh → AdmissionVerdict', () => {
    const review = eligibleReviewPackage();
    const request = submitRequest({
      action: 'request_changes',
      stateVersion: 3,
      projectionHash: review.projectionHash,
    });
    const decision = decideControlApiV2(
      request,
      submitReads({
        currentStateVersion: 3,
        freshProjectionHash: review.projectionHash,
        reviewPackage: review,
      }),
      NOW,
    );
    expect(decision).toMatchObject({
      schema: 'hercules-control-api-admit-verdict/v2',
      resource: 'decision',
      aggregateId: 'task-1',
      keyHash: request.idempotencyKey!.keyHash,
      requestHash: request.requestHash,
      decidedAt: NOW,
    });
  });
});

describe('decideControlApiV2 — status/review', () => {
  it('status structural-invalid → Refusal', () => {
    const valid = statusReadRequest();
    const invalid = { ...valid, aggregateId: '' };
    const decision = decideControlApiV2(
      invalid as unknown as ControlApiV2RequestV1,
      emptyReads(),
      NOW,
    );
    expect(decision).toMatchObject({
      schema: 'hercules-control-api-refusal/v2',
      reason: 'invalid_input_schema',
    });
  });

  it('status unknown_aggregate → Refusal', () => {
    const decision = decideControlApiV2(
      statusReadRequest('missing-task'),
      emptyReads({ aggregateExists: false }),
      NOW,
    );
    expect(decision).toMatchObject({
      schema: 'hercules-control-api-refusal/v2',
      reason: 'unknown_aggregate',
      resource: 'status',
      aggregateId: 'missing-task',
    });
  });

  it('status ok → StatusView', () => {
    const decision = decideControlApiV2(
      statusReadRequest(),
      emptyReads({
        aggregateExists: true,
        currentStateVersion: 5,
        taskStatus: 'review',
        latestEventSequence: 12,
      }),
      NOW,
    );
    expect(decision).toMatchObject({
      schema: 'hercules-control-api-status-view/v2',
      aggregateId: 'task-1',
      stateVersion: 5,
      taskStatus: 'review',
      latestEventSequence: 12,
    });
  });

  it('review unknown_aggregate → Refusal', () => {
    const decision = decideControlApiV2(
      reviewReadRequest('ghost'),
      emptyReads({ aggregateExists: false }),
      NOW,
    );
    expect(decision).toMatchObject({
      schema: 'hercules-control-api-refusal/v2',
      reason: 'unknown_aggregate',
      resource: 'review',
    });
  });

  it('review ok → ReviewView echoing reads.reviewPackage', () => {
    const review = eligibleReviewPackage();
    const decision = decideControlApiV2(
      reviewReadRequest(),
      emptyReads({
        aggregateExists: true,
        currentStateVersion: 4,
        reviewPackage: review,
      }),
      NOW,
    );
    expect(decision).toMatchObject({
      schema: 'hercules-control-api-review-view/v2',
      aggregateId: 'task-1',
      stateVersion: 4,
    });
    if (
      decision !== null &&
      typeof decision === 'object' &&
      'reviewPackage' in decision
    ) {
      expect(decision.reviewPackage).toBe(review);
      expect(decision.reviewPackage.validDecisions).toEqual([
        'request_changes',
      ]);
    }
  });
});

describe('decideControlApiV2 — event', () => {
  it('invalid limit → Refusal invalid_input_schema', () => {
    const valid = eventReadRequest();
    const badCursor = eventCursor({ limit: MAX_EVENT_PAGE + 1 });
    const withoutHash: Omit<ControlApiV2RequestV1, 'requestHash'> = {
      ...valid,
      payload: badCursor,
      payloadHash: computePayloadHash(badCursor),
    };
    const invalid = {
      ...withoutHash,
      requestHash: computeRequestHash(withoutHash),
    };
    const decision = decideControlApiV2(
      invalid as unknown as ControlApiV2RequestV1,
      emptyReads({ events: [] }),
      NOW,
    );
    expect(decision).toMatchObject({
      schema: 'hercules-control-api-refusal/v2',
      reason: 'invalid_input_schema',
      resource: 'event',
    });
  });

  it('invalid expectedPreviousEventHash null when afterSequence > 0 → Refusal', () => {
    const valid = eventReadRequest();
    const badCursor: EventCursorRequestV1 = {
      schema: 'hercules-control-api-event-cursor/v2',
      afterSequence: 2,
      expectedPreviousEventHash: null,
      limit: 10,
      cursorHash: HASH_A,
    };
    const withoutHash: Omit<ControlApiV2RequestV1, 'requestHash'> = {
      ...valid,
      payload: badCursor,
      payloadHash: computePayloadHash(badCursor),
    };
    const invalid = {
      ...withoutHash,
      requestHash: computeRequestHash(withoutHash),
    };
    const decision = decideControlApiV2(
      invalid as unknown as ControlApiV2RequestV1,
      emptyReads({ events: [] }),
      NOW,
    );
    expect(decision).toMatchObject({
      reason: 'invalid_input_schema',
      resource: 'event',
    });
  });

  it('broken_event_chain → Refusal', () => {
    const request = eventReadRequest({
      afterSequence: 1,
      expectedPreviousEventHash: HASH_B,
      limit: 10,
    });
    const decision = decideControlApiV2(
      request,
      emptyReads({
        events: [
          controlEventView({
            sequence: 2,
            eventId: 'evt-2',
            previousEventHash: HASH_A,
            eventHash: HASH_C,
          }),
        ],
      }),
      NOW,
    );
    expect(decision).toMatchObject({
      schema: 'hercules-control-api-refusal/v2',
      reason: 'broken_event_chain',
      resource: 'event',
      aggregateId: '',
    });
  });

  it('ok → EventPage (genesis afterSequence=0)', () => {
    const events = [
      controlEventView(),
      controlEventView({
        sequence: 2,
        eventId: 'evt-2',
        previousEventHash: HASH_A,
        eventHash: HASH_B,
      }),
    ];
    const request = eventReadRequest({ afterSequence: 0, limit: 10 });
    const decision = decideControlApiV2(
      request,
      emptyReads({ events, eventsHasMore: false }),
      NOW,
    );
    expect(decision).toMatchObject({
      schema: 'hercules-control-api-event-page/v2',
      afterSequence: 0,
      nextAfterSequence: 2,
      endOfStream: true,
    });
    if (
      decision !== null &&
      typeof decision === 'object' &&
      'events' in decision
    ) {
      expect(decision.events).toEqual(events);
    }
  });

  it('empty page keeps nextAfterSequence = afterSequence', () => {
    const request = eventReadRequest({
      afterSequence: 5,
      expectedPreviousEventHash: HASH_A,
      limit: 10,
    });
    const decision = decideControlApiV2(
      request,
      emptyReads({ events: [], eventsHasMore: false }),
      NOW,
    );
    expect(decision).toMatchObject({
      schema: 'hercules-control-api-event-page/v2',
      afterSequence: 5,
      events: [],
      nextAfterSequence: 5,
      endOfStream: true,
    });
  });

  it('endOfStream false when eventsHasMore', () => {
    const events = [controlEventView()];
    const request = eventReadRequest({ afterSequence: 0, limit: 1 });
    const decision = decideControlApiV2(
      request,
      emptyReads({ events, eventsHasMore: true }),
      NOW,
    );
    expect(decision).toMatchObject({
      endOfStream: false,
      nextAfterSequence: 1,
    });
  });

  it('byte-identical determinism on repeat', () => {
    const events = [
      controlEventView(),
      controlEventView({
        sequence: 2,
        eventId: 'evt-2',
        previousEventHash: HASH_A,
        eventHash: HASH_B,
      }),
    ];
    const request = eventReadRequest({ afterSequence: 0, limit: 10 });
    const reads = emptyReads({ events, eventsHasMore: false });
    const a = decideControlApiV2(request, reads, NOW);
    const b = decideControlApiV2(request, reads, NOW);
    expect(a).toEqual(b);
    expect(hashCanonicalJson(a)).toBe(hashCanonicalJson(b));
  });
});

describe('decideControlApiV2 — cross-cutting', () => {
  it('replay is version-independent', () => {
    const request = createRequest();
    const keyHash = request.idempotencyKey!.keyHash;
    const receipt = committedReceipt({
      resource: 'task',
      aggregateId: deriveAggregateId(keyHash),
      keyHash,
      requestHash: request.requestHash,
      stateVersion: 1,
      eventSequence: 1,
      decidedAt: '2026-08-01T00:00:00.000Z',
    });
    const decision = decideControlApiV2(
      request,
      emptyReads({
        aggregateExists: true,
        currentStateVersion: 99,
        admissionLedger: [ledgerEntry({ receipt })],
      }),
      NOW,
    );
    expect(decision).toEqual(receipt);
    expect(
      decision !== null &&
        typeof decision === 'object' &&
        'stateVersion' in decision
        ? decision.stateVersion
        : null,
    ).toBe(1);
  });

  it('restart determinism: identical (request, reads, now) → byte-identical decision', () => {
    const review = eligibleReviewPackage();
    const request = submitRequest({
      action: 'request_changes',
      stateVersion: 3,
      projectionHash: review.projectionHash,
    });
    const reads = submitReads({
      currentStateVersion: 3,
      freshProjectionHash: review.projectionHash,
      reviewPackage: review,
    });
    const a = decideControlApiV2(request, reads, NOW);
    const b = decideControlApiV2(request, reads, NOW);
    expect(a).toEqual(b);
    expect(hashCanonicalJson(a)).toBe(hashCanonicalJson(b));
  });

  it('throws ControlApiV2Error invalid_input_schema on malformed reads', () => {
    const request = createRequest();
    expect(() =>
      decideControlApiV2(
        request,
        {
          ...emptyReads(),
          admissionLedger: [
            {
              keyHash: HASH_A,
              requestHash: HASH_B,
              receipt: {
                schema: 'hercules-control-api-receipt/v2',
                outcome: 'refused',
                resource: 'task',
                aggregateId: 'task-1',
                keyHash: HASH_A,
                requestHash: HASH_B,
                stateVersion: null,
                eventSequence: null,
                reason: 'stale_version',
                decidedAt: TS,
                receiptHash: HASH_C,
              },
            },
          ],
        } as unknown as ControlApiV2ReadsV1,
        NOW,
      ),
    ).toThrow(ControlApiV2Error);
    try {
      decideControlApiV2(
        request,
        {
          ...emptyReads(),
          admissionLedger: 'not-an-array',
        } as unknown as ControlApiV2ReadsV1,
        NOW,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ControlApiV2Error);
      expect((error as ControlApiV2Error).code).toBe('invalid_input_schema');
    }
  });

  it('throws on non-canonical now', () => {
    expect(() =>
      decideControlApiV2(createRequest(), emptyReads(), 'not-a-timestamp'),
    ).toThrow(ControlApiV2Error);
  });

  it('never emits a RouteRefusalReasonV1', () => {
    const review = eligibleReviewPackage();
    const cases: Array<{
      request: ControlApiV2RequestV1;
      reads: ControlApiV2ReadsV1;
    }> = [
      { request: createRequest(), reads: emptyReads() },
      {
        request: submitRequest({
          action: 'request_changes',
          stateVersion: 3,
          projectionHash: review.projectionHash,
        }),
        reads: submitReads({
          currentStateVersion: 3,
          freshProjectionHash: review.projectionHash,
          reviewPackage: review,
        }),
      },
      {
        request: statusReadRequest(),
        reads: emptyReads({
          aggregateExists: true,
          currentStateVersion: 1,
          taskStatus: 'todo',
          latestEventSequence: 0,
        }),
      },
      {
        request: eventReadRequest(),
        reads: emptyReads({ events: [], eventsHasMore: false }),
      },
    ];
    for (const { request, reads } of cases) {
      const decision = decideControlApiV2(request, reads, NOW);
      if (
        decision !== null &&
        typeof decision === 'object' &&
        'reason' in decision &&
        decision.reason !== null
      ) {
        expect(decision.reason).not.toBe('unauthorized');
        expect(decision.reason).not.toBe('provider_unavailable');
      }
    }
  });
});

describe('fixture sanity', () => {
  it('builders produce assertable closed requests', () => {
    assertControlApiV2RequestV1(createRequest());
    assertControlApiV2RequestV1(
      submitRequest({
        action: 'request_changes',
        stateVersion: 3,
        projectionHash: eligibleReviewPackage().projectionHash,
      }),
    );
    assertControlApiV2RequestV1(statusReadRequest());
    assertControlApiV2RequestV1(reviewReadRequest());
    assertControlApiV2RequestV1(eventReadRequest());
  });
});
