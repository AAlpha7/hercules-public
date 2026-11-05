/**
 * M11 Control API V2 — pure `decideControlApiV2` dispatcher.
 *
 * Total over well-formed inputs. Client-input failures return a closed refusal
 * or refused receipt; only a malformed trusted `reads` (or non-canonical `now`)
 * throws `ControlApiV2Error('invalid_input_schema')`. Never calls a mutator or
 * store. Imports only `src/domain/*` and `./` peers. Time comes from `now`.
 */

import { hashCanonicalJson } from '../domain/canonicalJson.js';
import {
  CONTROL_API_V2_RESOURCES,
  ControlApiV2Error,
  assertAdmissionLedgerEntryV1,
  assertAdmissionVerdictV1,
  assertControlApiV2ReceiptV1,
  assertControlApiV2RefusalV1,
  assertControlApiV2RequestV1,
  assertControlApiV2ReviewViewV1,
  assertControlApiV2StatusViewV1,
  assertControlEventView,
  assertEventPageV1,
  computeAdmissionVerdictHash,
  computeEventPageHash,
  computeReceiptHash,
  computeRefusalHash,
  computeReviewViewHash,
  computeStatusViewHash,
  deriveAggregateId,
  type AdmissionVerdictV1,
  type ControlApiV2DecisionV1,
  type ControlApiV2ReadsV1,
  type ControlApiV2ReceiptV1,
  type ControlApiV2RefusalV1,
  type ControlApiV2RequestV1,
  type ControlApiV2Resource,
  type ControlApiV2ReviewViewV1,
  type ControlApiV2StatusViewV1,
  type DecisionPayloadV1,
  type EventCursorRequestV1,
  type EventPageV1,
  type ReceiptRefusalReasonV1,
  type RefusalCarrierReasonV1,
} from '../domain/controlApiV2.js';
import { isCanonicalTimestamp } from '../domain/workerBoundary.js';
import { decideOptimisticConcurrency } from './concurrency.js';
import { decideEventCursor } from './eventCursor.js';
import { decideIdempotency } from './idempotency.js';

const HASH_RE = /^sha256:[0-9a-f]{64}$/;

function failReads(message: string): never {
  throw new ControlApiV2Error('invalid_input_schema', message);
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_RE.test(value);
}

function isResource(value: unknown): value is ControlApiV2Resource {
  return (
    typeof value === 'string' &&
    (CONTROL_API_V2_RESOURCES as readonly string[]).includes(value)
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedNfcString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.normalize('NFC') === value
  );
}

/**
 * Validate the trusted reads bundle. Malformed control-owned input is a
 * precondition — throws `invalid_input_schema`.
 */
function assertControlApiV2ReadsV1(reads: unknown): asserts reads is ControlApiV2ReadsV1 {
  if (reads === null || typeof reads !== 'object' || Array.isArray(reads)) {
    failReads('control api v2 reads must be an object');
  }
  const bundle = reads as Readonly<Record<string, unknown>>;
  if (typeof bundle['aggregateExists'] !== 'boolean') {
    failReads('control api v2 reads.aggregateExists must be a boolean');
  }
  if (
    bundle['currentStateVersion'] !== null &&
    !isNonNegativeSafeInteger(bundle['currentStateVersion'])
  ) {
    failReads(
      'control api v2 reads.currentStateVersion must be null or a non-negative safe integer',
    );
  }
  if (
    bundle['taskStatus'] !== null &&
    !isBoundedNfcString(bundle['taskStatus'])
  ) {
    failReads('control api v2 reads.taskStatus must be null or a bounded NFC string');
  }
  if (
    bundle['latestEventSequence'] !== null &&
    !isNonNegativeSafeInteger(bundle['latestEventSequence'])
  ) {
    failReads(
      'control api v2 reads.latestEventSequence must be null or a non-negative safe integer',
    );
  }
  if (
    bundle['freshProjectionHash'] !== null &&
    !isHash(bundle['freshProjectionHash'])
  ) {
    failReads(
      'control api v2 reads.freshProjectionHash must be null or a sha256 digest',
    );
  }
  if (typeof bundle['eventsHasMore'] !== 'boolean') {
    failReads('control api v2 reads.eventsHasMore must be a boolean');
  }
  if (!Array.isArray(bundle['admissionLedger'])) {
    failReads('control api v2 reads.admissionLedger must be an array');
  }
  for (let index = 0; index < bundle['admissionLedger'].length; index += 1) {
    if (!(index in bundle['admissionLedger'])) {
      failReads('control api v2 reads.admissionLedger must not be sparse');
    }
    try {
      assertAdmissionLedgerEntryV1(bundle['admissionLedger'][index]);
    } catch (error) {
      failReads(
        `control api v2 reads.admissionLedger[${String(index)}] is malformed: ${String(error)}`,
      );
    }
  }
  const reviewPackage = bundle['reviewPackage'];
  // reviewPackage is a trusted, already-projected M6 ReviewPackageV2 from the
  // trusted reader port; per the ReviewPackageV2 authority model the engine trusts
  // the branded value and never re-runs its authority-bearing projection. A light
  // shape gate keeps the reads bundle well-formed for the eligibility check.
  if (reviewPackage !== null && reviewPackage !== undefined) {
    if (
      typeof reviewPackage !== 'object' ||
      (reviewPackage as { schema?: unknown }).schema !==
        'hercules-review-package/v2'
    ) {
      failReads('control api v2 reads.reviewPackage must be a ReviewPackageV2');
    }
  }
  const events = bundle['events'];
  if (events !== null && events !== undefined) {
    if (!Array.isArray(events)) {
      failReads('control api v2 reads.events must be null or an array');
    }
    for (let index = 0; index < events.length; index += 1) {
      if (!(index in events)) {
        failReads('control api v2 reads.events must not be sparse');
      }
      try {
        assertControlEventView(events[index]);
      } catch (error) {
        failReads(
          `control api v2 reads.events[${String(index)}] is malformed: ${String(error)}`,
        );
      }
    }
  }
}

function buildRefusal(input: {
  readonly resource: ControlApiV2Resource;
  readonly aggregateId: string;
  readonly requestHash: string;
  readonly reason: RefusalCarrierReasonV1;
  readonly decidedAt: string;
}): ControlApiV2RefusalV1 {
  const withoutHash: Omit<ControlApiV2RefusalV1, 'refusalHash'> = {
    schema: 'hercules-control-api-refusal/v2',
    resource: input.resource,
    aggregateId: input.aggregateId,
    requestHash: input.requestHash,
    reason: input.reason,
    decidedAt: input.decidedAt,
  };
  const refusal: ControlApiV2RefusalV1 = {
    ...withoutHash,
    refusalHash: computeRefusalHash(withoutHash),
  };
  assertControlApiV2RefusalV1(refusal);
  return refusal;
}

function buildRefusedReceipt(input: {
  readonly resource: 'task' | 'decision';
  readonly aggregateId: string;
  readonly keyHash: string;
  readonly requestHash: string;
  readonly reason: ReceiptRefusalReasonV1;
  readonly decidedAt: string;
}): ControlApiV2ReceiptV1 {
  const withoutHash: Omit<ControlApiV2ReceiptV1, 'receiptHash'> = {
    schema: 'hercules-control-api-receipt/v2',
    outcome: 'refused',
    resource: input.resource,
    aggregateId: input.aggregateId,
    keyHash: input.keyHash,
    requestHash: input.requestHash,
    stateVersion: null,
    eventSequence: null,
    reason: input.reason,
    decidedAt: input.decidedAt,
  };
  const receipt: ControlApiV2ReceiptV1 = {
    ...withoutHash,
    receiptHash: computeReceiptHash(withoutHash),
  };
  assertControlApiV2ReceiptV1(receipt);
  return receipt;
}

function buildAdmissionVerdict(input: {
  readonly resource: 'task' | 'decision';
  readonly aggregateId: string;
  readonly keyHash: string;
  readonly requestHash: string;
  readonly decidedAt: string;
}): AdmissionVerdictV1 {
  const withoutHash: Omit<AdmissionVerdictV1, 'verdictHash'> = {
    schema: 'hercules-control-api-admit-verdict/v2',
    resource: input.resource,
    aggregateId: input.aggregateId,
    keyHash: input.keyHash,
    requestHash: input.requestHash,
    decidedAt: input.decidedAt,
  };
  const verdict: AdmissionVerdictV1 = {
    ...withoutHash,
    verdictHash: computeAdmissionVerdictHash(withoutHash),
  };
  assertAdmissionVerdictV1(verdict);
  return verdict;
}

function buildStatusView(input: {
  readonly aggregateId: string;
  readonly stateVersion: number;
  readonly taskStatus: string;
  readonly latestEventSequence: number;
}): ControlApiV2StatusViewV1 {
  const withoutHash: Omit<ControlApiV2StatusViewV1, 'viewHash'> = {
    schema: 'hercules-control-api-status-view/v2',
    aggregateId: input.aggregateId,
    stateVersion: input.stateVersion,
    taskStatus: input.taskStatus,
    latestEventSequence: input.latestEventSequence,
  };
  const view: ControlApiV2StatusViewV1 = {
    ...withoutHash,
    viewHash: computeStatusViewHash(withoutHash),
  };
  assertControlApiV2StatusViewV1(view);
  return view;
}

function buildReviewView(input: {
  readonly aggregateId: string;
  readonly stateVersion: number;
  readonly reviewPackage: NonNullable<ControlApiV2ReadsV1['reviewPackage']>;
}): ControlApiV2ReviewViewV1 {
  const withoutHash: Omit<ControlApiV2ReviewViewV1, 'viewHash'> = {
    schema: 'hercules-control-api-review-view/v2',
    aggregateId: input.aggregateId,
    stateVersion: input.stateVersion,
    reviewPackage: input.reviewPackage,
  };
  const view: ControlApiV2ReviewViewV1 = {
    ...withoutHash,
    viewHash: computeReviewViewHash(withoutHash),
  };
  assertControlApiV2ReviewViewV1(view);
  return view;
}

function buildEventPage(input: {
  readonly afterSequence: number;
  readonly events: EventPageV1['events'];
  readonly nextAfterSequence: number;
  readonly endOfStream: boolean;
}): EventPageV1 {
  const withoutHash: Omit<EventPageV1, 'pageHash'> = {
    schema: 'hercules-control-api-event-page/v2',
    afterSequence: input.afterSequence,
    events: input.events,
    nextAfterSequence: input.nextAfterSequence,
    endOfStream: input.endOfStream,
  };
  const page: EventPageV1 = {
    ...withoutHash,
    pageHash: computeEventPageHash(withoutHash),
  };
  assertEventPageV1(page);
  return page;
}

/**
 * Best-effort refusal carrier for a structurally invalid client request.
 * Uses whatever closed fields are recoverable; synthesizes a requestHash when
 * the input does not carry a valid digest (keyless-safe path).
 */
function structuralRefusal(
  request: unknown,
  now: string,
): ControlApiV2RefusalV1 {
  const record =
    request !== null && typeof request === 'object' && !Array.isArray(request)
      ? (request as Readonly<Record<string, unknown>>)
      : null;
  const resource: ControlApiV2Resource = isResource(record?.['resource'])
    ? record['resource']
    : 'task';
  const aggregateId =
    typeof record?.['aggregateId'] === 'string' &&
    (record['aggregateId'] === '' ||
      (record['aggregateId'].length >= 1 &&
        record['aggregateId'].normalize('NFC') === record['aggregateId']))
      ? record['aggregateId']
      : '';
  const requestHash = isHash(record?.['requestHash'])
    ? record['requestHash']
    : hashCanonicalJson({
        kind: 'control-api-v2-invalid-input',
        resource,
        aggregateId,
      });
  return buildRefusal({
    resource,
    aggregateId,
    requestHash,
    reason: 'invalid_input_schema',
    decidedAt: now,
  });
}

function decideMutation(
  request: ControlApiV2RequestV1,
  reads: ControlApiV2ReadsV1,
  now: string,
): ControlApiV2DecisionV1 {
  const key = request.idempotencyKey;
  if (key === null) {
    // Unreachable after assertControlApiV2RequestV1; defensive keyless carrier.
    return structuralRefusal(request, now);
  }
  const keyHash = key.keyHash;
  const resource = request.resource === 'task' ? 'task' : 'decision';
  const aggregateIdForRefusal =
    request.resource === 'task'
      ? deriveAggregateId(keyHash)
      : request.aggregateId;

  // Step 2 — aggregate existence (submit only; create skips).
  if (request.operation === 'submit' && reads.aggregateExists === false) {
    return buildRefusedReceipt({
      resource: 'decision',
      aggregateId: request.aggregateId,
      keyHash,
      requestHash: request.requestHash,
      reason: 'unknown_aggregate',
      decidedAt: now,
    });
  }

  // Step 3 — idempotency (mutations), before concurrency.
  const idempotency = decideIdempotency({
    keyHash,
    requestHash: request.requestHash,
    admissionLedger: reads.admissionLedger,
  });
  if (idempotency.kind === 'replay') {
    assertControlApiV2ReceiptV1(idempotency.receipt);
    return idempotency.receipt;
  }
  if (idempotency.kind === 'conflict') {
    return buildRefusedReceipt({
      resource,
      aggregateId: aggregateIdForRefusal,
      keyHash,
      requestHash: request.requestHash,
      reason: 'idempotency_conflict',
      decidedAt: now,
    });
  }

  // Step 4 — optimistic concurrency (submit only).
  if (request.operation === 'submit') {
    const token = request.concurrencyToken;
    if (token === null) {
      return structuralRefusal(request, now);
    }
    const concurrency = decideOptimisticConcurrency({
      concurrencyToken: token,
      currentStateVersion: reads.currentStateVersion,
      freshProjectionHash: reads.freshProjectionHash,
    });
    if (concurrency.kind === 'stale_version') {
      return buildRefusedReceipt({
        resource: 'decision',
        aggregateId: request.aggregateId,
        keyHash,
        requestHash: request.requestHash,
        reason: 'stale_version',
        decidedAt: now,
      });
    }
    if (concurrency.kind === 'stale_projection') {
      return buildRefusedReceipt({
        resource: 'decision',
        aggregateId: request.aggregateId,
        keyHash,
        requestHash: request.requestHash,
        reason: 'stale_projection',
        decidedAt: now,
      });
    }

    // Step 5 — eligibility (submit only), fixed sub-order.
    const reviewPackage = reads.reviewPackage;
    if (reviewPackage === null) {
      failReads(
        'control api v2 reads.reviewPackage must be non-null for an existing-aggregate submit',
      );
    }
    if (reviewPackage.decisionBinding === null) {
      return buildRefusedReceipt({
        resource: 'decision',
        aggregateId: request.aggregateId,
        keyHash,
        requestHash: request.requestHash,
        reason: 'need_more_evidence',
        decidedAt: now,
      });
    }
    const payload = request.payload as DecisionPayloadV1;
    if (!reviewPackage.validDecisions.includes(payload.action)) {
      return buildRefusedReceipt({
        resource: 'decision',
        aggregateId: request.aggregateId,
        keyHash,
        requestHash: request.requestHash,
        reason: 'ineligible_decision',
        decidedAt: now,
      });
    }
    if (payload.action === 'approve_outcome' || payload.action === 'reject_outcome') {
      // Human-axis acknowledgement codes ride the existing wire as `human:<criterionId>`.
      // request_changes is exempt. Prefer required human rows; if a row omits `required`,
      // treat every human criterion as required. Known set includes every human-authority
      // criterion (required or not) so after-deploy codes are admitted but never gate.
      const humanCriteria = reviewPackage.criteria.filter(
        (criterion) => criterion.authority === 'human',
      );
      const humanRequired = humanCriteria.some(
        (criterion) => typeof criterion.required === 'boolean',
      )
        ? humanCriteria.filter((criterion) => criterion.required === true)
        : humanCriteria;
      const required = [
        ...new Set([
          ...reviewPackage.blockingFindings.map((finding) => finding.code),
          ...reviewPackage.remainingRisks.map((finding) => finding.code),
          ...humanRequired.map((criterion) => `human:${criterion.criterionId}`),
        ]),
      ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      const known = new Set([
        ...reviewPackage.blockingFindings.map((finding) => finding.code),
        ...reviewPackage.remainingRisks.map((finding) => finding.code),
        ...humanCriteria.map((criterion) => `human:${criterion.criterionId}`),
      ]);
      const acknowledged = new Set(payload.acknowledgedRiskCodes);
      if (required.some((code) => !acknowledged.has(code))) {
        return buildRefusedReceipt({
          resource: 'decision',
          aggregateId: request.aggregateId,
          keyHash,
          requestHash: request.requestHash,
          reason: 'ineligible_decision',
          decidedAt: now,
        });
      }
      if (payload.acknowledgedRiskCodes.some((code) => !known.has(code))) {
        return buildRefusedReceipt({
          resource: 'decision',
          aggregateId: request.aggregateId,
          keyHash,
          requestHash: request.requestHash,
          reason: 'ineligible_decision',
          decidedAt: now,
        });
      }
    }
  }

  // Step 6 — admit (fresh admissible mutation). No committed receipt here.
  const admitAggregateId =
    request.resource === 'task'
      ? deriveAggregateId(keyHash)
      : request.aggregateId;
  return buildAdmissionVerdict({
    resource,
    aggregateId: admitAggregateId,
    keyHash,
    requestHash: request.requestHash,
    decidedAt: now,
  });
}

function decideStatusOrReviewRead(
  request: ControlApiV2RequestV1,
  reads: ControlApiV2ReadsV1,
  now: string,
): ControlApiV2DecisionV1 {
  // Step 2 — aggregate existence → Refusal carrier (reads mint no receipt).
  if (reads.aggregateExists === false) {
    return buildRefusal({
      resource: request.resource,
      aggregateId: request.aggregateId,
      requestHash: request.requestHash,
      reason: 'unknown_aggregate',
      decidedAt: now,
    });
  }

  if (reads.currentStateVersion === null) {
    failReads(
      'control api v2 reads.currentStateVersion must be non-null when aggregateExists',
    );
  }

  if (request.resource === 'status') {
    if (reads.taskStatus === null || reads.latestEventSequence === null) {
      failReads(
        'control api v2 reads.taskStatus and latestEventSequence must be non-null for a status read',
      );
    }
    return buildStatusView({
      aggregateId: request.aggregateId,
      stateVersion: reads.currentStateVersion,
      taskStatus: reads.taskStatus,
      latestEventSequence: reads.latestEventSequence,
    });
  }

  // review
  if (reads.reviewPackage === null) {
    failReads(
      'control api v2 reads.reviewPackage must be non-null for a review read',
    );
  }
  return buildReviewView({
    aggregateId: request.aggregateId,
    stateVersion: reads.currentStateVersion,
    reviewPackage: reads.reviewPackage,
  });
}

function decideEventRead(
  request: ControlApiV2RequestV1,
  reads: ControlApiV2ReadsV1,
  now: string,
): ControlApiV2DecisionV1 {
  if (reads.events === null) {
    failReads('control api v2 reads.events must be non-null for an event read');
  }
  const cursor = request.payload as EventCursorRequestV1;
  const decision = decideEventCursor({
    afterSequence: cursor.afterSequence,
    expectedPreviousEventHash: cursor.expectedPreviousEventHash,
    events: reads.events,
    eventsHasMore: reads.eventsHasMore,
  });
  if (decision.kind === 'broken_event_chain') {
    return buildRefusal({
      resource: 'event',
      aggregateId: '',
      requestHash: request.requestHash,
      reason: 'broken_event_chain',
      decidedAt: now,
    });
  }
  return buildEventPage({
    afterSequence: cursor.afterSequence,
    events: decision.events,
    nextAfterSequence: decision.nextAfterSequence,
    endOfStream: decision.endOfStream,
  });
}

/**
 * Pure Control API V2 decision engine — pinned first-match pipeline.
 *
 * Every well-formed `(request, reads, now)` maps to exactly one closed
 * {@link ControlApiV2DecisionV1} member. Client-input failures never throw;
 * only a malformed trusted `reads` or non-canonical `now` throws.
 */
export function decideControlApiV2(
  request: ControlApiV2RequestV1,
  reads: ControlApiV2ReadsV1,
  now: string,
): ControlApiV2DecisionV1 {
  if (!isCanonicalTimestamp(now)) {
    failReads('decideControlApiV2 now must be a canonical UTC-Z timestamp');
  }
  assertControlApiV2ReadsV1(reads);

  // Step 1 — structural validation (ALL surfaces) → Refusal carrier.
  try {
    assertControlApiV2RequestV1(request);
  } catch (error) {
    if (
      error instanceof ControlApiV2Error &&
      error.code === 'invalid_input_schema'
    ) {
      return structuralRefusal(request, now);
    }
    throw error;
  }

  if (
    (request.resource === 'task' && request.operation === 'create') ||
    (request.resource === 'decision' && request.operation === 'submit')
  ) {
    return decideMutation(request, reads, now);
  }

  if (
    (request.resource === 'status' || request.resource === 'review') &&
    request.operation === 'read'
  ) {
    return decideStatusOrReviewRead(request, reads, now);
  }

  if (request.resource === 'event' && request.operation === 'read') {
    return decideEventRead(request, reads, now);
  }

  // Unreachable after assertControlApiV2RequestV1.
  return structuralRefusal(request, now);
}
