/**
 * M11 Control API V2 domain records.
 *
 * Slice 1: closed request/response records, hashing, structural validators,
 * ports (type-only), and shared client contract helpers. The pure decision
 * engine and route wiring live in later slices.
 */

import {
  canonicalClone,
  canonicalSerialize,
  hashCanonicalJson,
} from './canonicalJson.js';
import {
  CONTROL_EVENT_AGGREGATES,
  CONTROL_EVENT_TYPES,
} from './controlEvent.js';
import {
  type M6OutcomeDecision,
  type ReviewPackageV2,
} from './reviewPackageV2.js';
import { isValidIdentifier } from './task.js';
import { isCanonicalTimestamp } from './workerBoundary.js';
import {
  ADMISSION_LEDGER_ENTRY_V1_KEYS,
  ADMISSION_VERDICT_V1_KEYS,
  CONCURRENCY_TOKEN_V2_KEYS,
  CONTROL_API_V2_OPERATIONS,
  CONTROL_API_V2_RECEIPT_OUTCOMES,
  CONTROL_API_V2_RECEIPT_V1_KEYS,
  CONTROL_API_V2_REFUSAL_V1_KEYS,
  CONTROL_API_V2_REQUEST_V1_KEYS,
  CONTROL_API_V2_RESOURCES,
  CONTROL_API_V2_REVIEW_VIEW_V1_KEYS,
  CONTROL_API_V2_STATUS_VIEW_V1_KEYS,
  CONTROL_EVENT_VIEW_KEYS,
  CREATE_PAYLOAD_V1_KEYS,
  ControlApiV2Error,
  DECISION_PAYLOAD_V1_KEYS,
  EVENT_CURSOR_REQUEST_V1_KEYS,
  EVENT_PAGE_V1_KEYS,
  IDEMPOTENCY_KEY_V2_KEYS,
  M6_OUTCOME_DECISIONS,
  MAX_EVENT_PAGE,
  READ_PAYLOAD_V1_KEYS,
  RECEIPT_REFUSAL_REASONS,
  REFUSAL_CARRIER_REASONS,
  controlApiV2HttpStatusForReason,
  type AdmissionLedgerEntryV1,
  type AdmissionVerdictV1,
  type ConcurrencyTokenV2,
  type ControlApiV2DecisionActionV1,
  type ControlApiV2Operation,
  type ControlApiV2PayloadV1,
  type ControlApiV2ReceiptV1,
  type ControlApiV2RefusalV1,
  type ControlApiV2RequestV1,
  type ControlApiV2Resource,
  type ControlApiV2StatusViewV1,
  type ControlEventView,
  type CreatePayloadV1,
  type DecisionPayloadV1,
  type EventCursorRequestV1,
  type EventPageV1,
  type IdempotencyKeyV2,
  type ReadPayloadV1,
} from './controlApiV2Wire.js';

export {
  ADMISSION_LEDGER_ENTRY_V1_KEYS,
  ADMISSION_VERDICT_V1_KEYS,
  CONCURRENCY_TOKEN_V2_KEYS,
  CONTROL_API_V2_OPERATIONS,
  CONTROL_API_V2_RECEIPT_OUTCOMES,
  CONTROL_API_V2_RECEIPT_V1_KEYS,
  CONTROL_API_V2_REFUSAL_V1_KEYS,
  CONTROL_API_V2_REQUEST_V1_KEYS,
  CONTROL_API_V2_RESOURCES,
  CONTROL_API_V2_REVIEW_VIEW_V1_KEYS,
  CONTROL_API_V2_STATUS_VIEW_V1_KEYS,
  CONTROL_EVENT_VIEW_KEYS,
  CREATE_PAYLOAD_V1_KEYS,
  ControlApiV2Error,
  DECISION_PAYLOAD_V1_KEYS,
  ENGINE_REFUSAL_REASONS,
  EVENT_CURSOR_REQUEST_V1_KEYS,
  EVENT_PAGE_V1_KEYS,
  IDEMPOTENCY_KEY_V2_KEYS,
  M6_OUTCOME_DECISIONS,
  MAX_EVENT_PAGE,
  READ_PAYLOAD_V1_KEYS,
  RECEIPT_REFUSAL_REASONS,
  REFUSAL_CARRIER_REASONS,
  ROUTE_REFUSAL_REASONS,
  controlApiV2EventQuery,
  controlApiV2HttpRoute,
  controlApiV2HttpStatusForReason,
} from './controlApiV2Wire.js';

export type {
  AdmissionLedgerEntryV1,
  AdmissionVerdictV1,
  ConcurrencyTokenV2,
  ControlApiV2DecisionActionV1,
  ControlApiV2ErrorCode,
  ControlApiV2HttpRouteV1,
  ControlApiV2Operation,
  ControlApiV2PayloadV1,
  ControlApiV2ReceiptOutcomeV1,
  ControlApiV2ReceiptV1,
  ControlApiV2RefusalV1,
  ControlApiV2RequestV1,
  ControlApiV2Resource,
  ControlApiV2StatusViewV1,
  ControlEventView,
  CreatePayloadV1,
  DecisionPayloadV1,
  EngineRefusalReasonV1,
  EventCursorRequestV1,
  EventPageV1,
  IdempotencyKeyV2,
  ReadPayloadV1,
  ReceiptRefusalReasonV1,
  RefusalCarrierReasonV1,
  RouteRefusalReasonV1,
} from './controlApiV2Wire.js';

/** Compile-time pin: wire decision action union === domain M6OutcomeDecision. */
type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const controlApiV2DecisionActionEqualsM6OutcomeDecision: AssertEqual<
  ControlApiV2DecisionActionV1,
  M6OutcomeDecision
> = true;

export interface ControlApiV2ReviewViewV1 {
  readonly schema: 'hercules-control-api-review-view/v2';
  readonly aggregateId: string;
  readonly stateVersion: number;
  readonly reviewPackage: ReviewPackageV2;
  readonly viewHash: string;
}

export type ControlApiV2DecisionV1 =
  | ControlApiV2ReceiptV1
  | ControlApiV2ReviewViewV1
  | ControlApiV2StatusViewV1
  | EventPageV1
  | ControlApiV2RefusalV1
  | AdmissionVerdictV1;

export type ControlApiV2ResponseV1 =
  | ControlApiV2ReceiptV1
  | ControlApiV2ReviewViewV1
  | ControlApiV2StatusViewV1
  | EventPageV1
  | ControlApiV2RefusalV1;

export interface ControlApiV2ReadsV1 {
  readonly aggregateExists: boolean;
  readonly currentStateVersion: number | null;
  readonly taskStatus: string | null;
  readonly latestEventSequence: number | null;
  readonly freshProjectionHash: string | null;
  readonly reviewPackage: ReviewPackageV2 | null;
  readonly admissionLedger: readonly AdmissionLedgerEntryV1[];
  readonly events: readonly ControlEventView[] | null;
  readonly eventsHasMore: boolean;
}

// ---------------------------------------------------------------------------
// Ports (type-only — no implementation in this slice)
// ---------------------------------------------------------------------------

export interface ControlEventReadPortV1 {
  readEvents(
    afterSequence: number,
    limit: number,
  ): {
    readonly events: readonly ControlEventView[];
    readonly hasMore: boolean;
  };
}

export interface ControlApiV2ReaderPortV1 {
  read(request: ControlApiV2RequestV1): ControlApiV2ReadsV1;
}

export interface ControlApiV2MutatorPortV1 {
  commit(
    request: ControlApiV2RequestV1,
    verdict: AdmissionVerdictV1,
  ): ControlApiV2ReceiptV1;
}

// ---------------------------------------------------------------------------
// Local helpers (M8/M9/M10 house pattern)
// ---------------------------------------------------------------------------

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_REASON_BYTES = 8 * 1024;
const MAX_ARRAY_ITEMS = 4_096;

function fail(message: string): never {
  throw new ControlApiV2Error('invalid_input_schema', message);
}

function assertExactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Readonly<Record<string, unknown>> {
  try {
    canonicalSerialize(value);
  } catch (error) {
    fail(`${label} must be stable canonical JSON: ${String(error)}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} must use the exact closed schema`);
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isBoundedNfcString(
  value: unknown,
  maxBytes = MAX_IDENTIFIER_BYTES,
): value is string {
  return (
    typeof value === 'string' &&
    utf8Bytes(value) >= 1 &&
    utf8Bytes(value) <= maxBytes &&
    value.normalize('NFC') === value
  );
}

function isBoundedIdentifier(value: unknown): value is string {
  return isBoundedNfcString(value) && isValidIdentifier(value);
}

/** Empty-string exception for create/event aggregateId surfaces. */
function isBoundedIdentifierOrEmpty(value: unknown): value is string {
  return value === '' || isBoundedIdentifier(value);
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_RE.test(value);
}

function assertSha256Digest(
  value: unknown,
  label: string,
): asserts value is string {
  if (!isHash(value)) {
    fail(`${label} must be a sha256:<64hex> digest`);
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function omitHash<T extends object>(
  value: T,
  keyToOmit: string,
): Readonly<Record<string, unknown>> {
  const record = value as unknown as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== keyToOmit),
  );
}

function assertSortedUniqueBoundedStrings(
  value: unknown,
  label: string,
  allowEmpty = true,
): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_ARRAY_ITEMS ||
    (!allowEmpty && value.length === 0)
  ) {
    fail(`${label} must be a bounded${allowEmpty ? '' : ' non-empty'} array`);
  }
  let previous: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || !isBoundedNfcString(value[index])) {
      fail(`${label} must contain bounded non-empty NFC strings`);
    }
    const current = value[index];
    if (previous !== null && previous >= current) {
      fail(`${label} must contain sorted unique strings`);
    }
    previous = current;
  }
}

function assertDenseArray(
  value: unknown,
  label: string,
): asserts value is readonly unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) {
    fail(`${label} must be a bounded array`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) {
      fail(`${label} must not be sparse`);
    }
  }
}

/**
 * Deep-freeze acyclic canonical records. Recurses into already-frozen parents
 * so nested children are still sealed (M8 independentEvaluator idiom).
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  if (!Object.isFrozen(value)) {
    Object.freeze(value);
  }
  return value;
}

function isMutationResource(
  resource: ControlApiV2Resource,
): resource is 'task' | 'decision' {
  return resource === 'task' || resource === 'decision';
}

// ---------------------------------------------------------------------------
// Hashing (omit-own-hash rule)
// ---------------------------------------------------------------------------

export function computeIdempotencyKeyHash(
  key: Omit<IdempotencyKeyV2, 'keyHash'>,
): string {
  return hashCanonicalJson(canonicalClone(key));
}

export function computeConcurrencyTokenHash(
  token: Omit<ConcurrencyTokenV2, 'tokenHash'>,
): string {
  return hashCanonicalJson(canonicalClone(token));
}

export function computePayloadHash(payload: ControlApiV2PayloadV1): string {
  return hashCanonicalJson(canonicalClone(payload));
}

export function computeEventCursorHash(
  cursor: Omit<EventCursorRequestV1, 'cursorHash'>,
): string {
  return hashCanonicalJson(canonicalClone(cursor));
}

export function computeRequestHash(
  request: Omit<ControlApiV2RequestV1, 'requestHash'>,
): string {
  return hashCanonicalJson(canonicalClone(request));
}

export function computeReceiptHash(
  receipt: Omit<ControlApiV2ReceiptV1, 'receiptHash'>,
): string {
  return hashCanonicalJson(canonicalClone(receipt));
}

export function computeRefusalHash(
  refusal: Omit<ControlApiV2RefusalV1, 'refusalHash'>,
): string {
  return hashCanonicalJson(canonicalClone(refusal));
}

export function computeReviewViewHash(
  view: Omit<ControlApiV2ReviewViewV1, 'viewHash'>,
): string {
  return hashCanonicalJson(canonicalClone(view));
}

export function computeStatusViewHash(
  view: Omit<ControlApiV2StatusViewV1, 'viewHash'>,
): string {
  return hashCanonicalJson(canonicalClone(view));
}

export function computeEventPageHash(
  page: Omit<EventPageV1, 'pageHash'>,
): string {
  return hashCanonicalJson(canonicalClone(page));
}

export function computeAdmissionVerdictHash(
  verdict: Omit<AdmissionVerdictV1, 'verdictHash'>,
): string {
  return hashCanonicalJson(canonicalClone(verdict));
}

/**
 * Deterministic aggregate id for a create commit.
 * Uses `task-${hex64}` (not raw `sha256:…`) so the result passes
 * {@link isValidIdentifier}.
 */
export function deriveAggregateId(keyHash: string): string {
  assertSha256Digest(keyHash, 'deriveAggregateId keyHash');
  const digest = hashCanonicalJson({
    kind: 'control-api-aggregate-id',
    keyHash,
  });
  const hex64 = digest.slice('sha256:'.length);
  const aggregateId = `task-${hex64}`;
  if (!isValidIdentifier(aggregateId) || !isBoundedIdentifier(aggregateId)) {
    fail('deriveAggregateId produced an unbound or unsafe identifier');
  }
  return aggregateId;
}

// ---------------------------------------------------------------------------
// Structural validators
// ---------------------------------------------------------------------------

export function assertIdempotencyKeyV2(
  value: unknown,
  options: { readonly allowEmptyAggregateId?: boolean } = {},
): asserts value is IdempotencyKeyV2 {
  assertExactRecord(value, IDEMPOTENCY_KEY_V2_KEYS, 'idempotency key');
  const key = value as unknown as IdempotencyKeyV2;
  const allowEmpty = options.allowEmptyAggregateId === true;
  if (
    !isBoundedIdentifier(key.actorIssuer) ||
    !isBoundedIdentifier(key.actorId) ||
    !isBoundedIdentifier(key.clientRequestId) ||
    !(allowEmpty
      ? isBoundedIdentifierOrEmpty(key.aggregateId)
      : isBoundedIdentifier(key.aggregateId)) ||
    !isHash(key.keyHash)
  ) {
    fail(
      'idempotency key actor, aggregate, clientRequestId, and keyHash must be valid',
    );
  }
  const expectedHash = computeIdempotencyKeyHash(omitHash(key, 'keyHash') as Omit<
    IdempotencyKeyV2,
    'keyHash'
  >);
  if (key.keyHash !== expectedHash) {
    fail('idempotency key hash does not match the exact record');
  }
  deepFreeze(key);
}

export function assertConcurrencyTokenV2(
  value: unknown,
): asserts value is ConcurrencyTokenV2 {
  assertExactRecord(value, CONCURRENCY_TOKEN_V2_KEYS, 'concurrency token');
  const token = value as unknown as ConcurrencyTokenV2;
  if (
    !isBoundedIdentifier(token.aggregateId) ||
    !isNonNegativeSafeInteger(token.stateVersion) ||
    !isHash(token.projectionHash) ||
    !isHash(token.tokenHash)
  ) {
    fail(
      'concurrency token aggregateId, stateVersion, projectionHash, and tokenHash must be valid',
    );
  }
  const expectedHash = computeConcurrencyTokenHash(
    omitHash(token, 'tokenHash') as Omit<ConcurrencyTokenV2, 'tokenHash'>,
  );
  if (token.tokenHash !== expectedHash) {
    fail('concurrency token hash does not match the exact record');
  }
  deepFreeze(token);
}

export function assertCreatePayloadV1(
  value: unknown,
): asserts value is CreatePayloadV1 {
  assertExactRecord(value, CREATE_PAYLOAD_V1_KEYS, 'create payload');
  const payload = value as unknown as CreatePayloadV1;
  if (payload.kind !== 'create') {
    fail('create payload kind must be create');
  }
  assertSha256Digest(payload.taskContractHash, 'create payload taskContractHash');
  assertSha256Digest(payload.intentDigest, 'create payload intentDigest');
  deepFreeze(payload);
}

export function assertDecisionPayloadV1(
  value: unknown,
): asserts value is DecisionPayloadV1 {
  assertExactRecord(value, DECISION_PAYLOAD_V1_KEYS, 'decision payload');
  const payload = value as unknown as DecisionPayloadV1;
  if (payload.kind !== 'decision') {
    fail('decision payload kind must be decision');
  }
  if (!(M6_OUTCOME_DECISIONS as readonly unknown[]).includes(payload.action)) {
    fail('decision payload action must be a closed M6OutcomeDecision');
  }
  if (!isBoundedNfcString(payload.reason, MAX_REASON_BYTES)) {
    fail('decision payload reason must be a bounded non-empty NFC string');
  }
  assertSortedUniqueBoundedStrings(
    payload.acknowledgedRiskCodes,
    'decision payload acknowledgedRiskCodes',
  );
  deepFreeze(payload);
}

export function assertReadPayloadV1(
  value: unknown,
): asserts value is ReadPayloadV1 {
  assertExactRecord(value, READ_PAYLOAD_V1_KEYS, 'read payload');
  const payload = value as unknown as ReadPayloadV1;
  if (payload.kind !== 'read') {
    fail('read payload kind must be read');
  }
  deepFreeze(payload);
}

export function assertEventCursorRequestV1(
  value: unknown,
): asserts value is EventCursorRequestV1 {
  assertExactRecord(value, EVENT_CURSOR_REQUEST_V1_KEYS, 'event cursor request');
  const cursor = value as unknown as EventCursorRequestV1;
  if (cursor.schema !== 'hercules-control-api-event-cursor/v2') {
    fail('event cursor request schema must be hercules-control-api-event-cursor/v2');
  }
  if (!isNonNegativeSafeInteger(cursor.afterSequence)) {
    fail('event cursor afterSequence must be a non-negative safe integer');
  }
  if (
    !isPositiveSafeInteger(cursor.limit) ||
    cursor.limit > MAX_EVENT_PAGE
  ) {
    fail(`event cursor limit must be in 1..${MAX_EVENT_PAGE}`);
  }
  if (cursor.afterSequence === 0) {
    if (cursor.expectedPreviousEventHash !== null) {
      fail(
        'event cursor expectedPreviousEventHash must be null when afterSequence is 0',
      );
    }
  } else {
    assertSha256Digest(
      cursor.expectedPreviousEventHash,
      'event cursor expectedPreviousEventHash',
    );
  }
  assertSha256Digest(cursor.cursorHash, 'event cursor cursorHash');
  const expectedHash = computeEventCursorHash(
    omitHash(cursor, 'cursorHash') as Omit<EventCursorRequestV1, 'cursorHash'>,
  );
  if (cursor.cursorHash !== expectedHash) {
    fail('event cursor hash does not match the exact record');
  }
  deepFreeze(cursor);
}

export function assertControlApiV2PayloadV1(
  value: unknown,
): asserts value is ControlApiV2PayloadV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('control api v2 payload must be an object');
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (record['kind'] === 'create') {
    assertCreatePayloadV1(value);
    return;
  }
  if (record['kind'] === 'decision') {
    assertDecisionPayloadV1(value);
    return;
  }
  if (record['kind'] === 'read') {
    assertReadPayloadV1(value);
    return;
  }
  if (record['schema'] === 'hercules-control-api-event-cursor/v2') {
    assertEventCursorRequestV1(value);
    return;
  }
  fail('control api v2 payload discriminant is unrecognized');
}

function payloadKind(
  payload: ControlApiV2PayloadV1,
): 'create' | 'decision' | 'read' | 'event-cursor' {
  if ('kind' in payload) {
    return payload.kind;
  }
  return 'event-cursor';
}

function assertPayloadMatchesResourceOperation(
  resource: ControlApiV2Resource,
  operation: ControlApiV2Operation,
  payload: ControlApiV2PayloadV1,
): void {
  const kind = payloadKind(payload);
  if (resource === 'task' && operation === 'create') {
    if (kind !== 'create') {
      fail('create request payload must be CreatePayloadV1');
    }
    return;
  }
  if (resource === 'decision' && operation === 'submit') {
    if (kind !== 'decision') {
      fail('submit request payload must be DecisionPayloadV1');
    }
    return;
  }
  if (
    (resource === 'status' || resource === 'review') &&
    operation === 'read'
  ) {
    if (kind !== 'read') {
      fail('status/review read payload must be ReadPayloadV1');
    }
    return;
  }
  if (resource === 'event' && operation === 'read') {
    if (kind !== 'event-cursor') {
      fail('event read payload must be EventCursorRequestV1');
    }
    return;
  }
  fail(
    `resource/operation pair (${resource}, ${operation}) is not a closed Control API V2 surface`,
  );
}

export function assertControlApiV2RequestV1(
  value: unknown,
): asserts value is ControlApiV2RequestV1 {
  assertExactRecord(value, CONTROL_API_V2_REQUEST_V1_KEYS, 'control api v2 request');
  const request = value as unknown as ControlApiV2RequestV1;
  if (request.schema !== 'hercules-control-api-request/v2') {
    fail('control api v2 request schema must be hercules-control-api-request/v2');
  }
  if (
    !(CONTROL_API_V2_RESOURCES as readonly unknown[]).includes(request.resource)
  ) {
    fail('control api v2 request resource must be a closed ControlApiV2Resource');
  }
  if (
    !(CONTROL_API_V2_OPERATIONS as readonly unknown[]).includes(request.operation)
  ) {
    fail('control api v2 request operation must be a closed ControlApiV2Operation');
  }
  if (!isCanonicalTimestamp(request.issuedAt)) {
    fail('control api v2 request issuedAt must be a canonical timestamp');
  }
  assertSha256Digest(request.payloadHash, 'control api v2 request payloadHash');
  assertSha256Digest(request.requestHash, 'control api v2 request requestHash');

  assertControlApiV2PayloadV1(request.payload);
  assertPayloadMatchesResourceOperation(
    request.resource,
    request.operation,
    request.payload,
  );
  if (request.payloadHash !== computePayloadHash(request.payload)) {
    fail('control api v2 request payloadHash does not match the payload');
  }

  // Presence/absence matrix
  if (request.resource === 'task' && request.operation === 'create') {
    if (request.aggregateId !== '') {
      fail('create request aggregateId must be the empty string');
    }
    if (request.idempotencyKey === null) {
      fail('create request must carry an idempotency key');
    }
    if (request.concurrencyToken !== null) {
      fail('create request concurrencyToken must be null');
    }
    assertIdempotencyKeyV2(request.idempotencyKey, {
      allowEmptyAggregateId: true,
    });
    if (request.idempotencyKey.aggregateId !== '') {
      fail('create idempotency key aggregateId must be the empty string');
    }
  } else if (request.resource === 'decision' && request.operation === 'submit') {
    if (!isBoundedIdentifier(request.aggregateId)) {
      fail('submit request aggregateId must be a non-empty bounded identifier');
    }
    if (request.idempotencyKey === null) {
      fail('submit request must carry an idempotency key');
    }
    if (request.concurrencyToken === null) {
      fail('submit request must carry a concurrency token');
    }
    assertIdempotencyKeyV2(request.idempotencyKey);
    assertConcurrencyTokenV2(request.concurrencyToken);
    if (request.idempotencyKey.aggregateId !== request.aggregateId) {
      fail('submit idempotency key aggregateId must equal request aggregateId');
    }
    if (request.concurrencyToken.aggregateId !== request.aggregateId) {
      fail('submit concurrency token aggregateId must equal request aggregateId');
    }
  } else if (
    (request.resource === 'status' || request.resource === 'review') &&
    request.operation === 'read'
  ) {
    if (!isBoundedIdentifier(request.aggregateId)) {
      fail('status/review read aggregateId must be a non-empty bounded identifier');
    }
    if (request.idempotencyKey !== null || request.concurrencyToken !== null) {
      fail('status/review read must carry neither idempotency key nor concurrency token');
    }
  } else if (request.resource === 'event' && request.operation === 'read') {
    if (request.aggregateId !== '') {
      fail('event read aggregateId must be the empty string');
    }
    if (request.idempotencyKey !== null || request.concurrencyToken !== null) {
      fail('event read must carry neither idempotency key nor concurrency token');
    }
  } else {
    fail(
      `resource/operation pair (${request.resource}, ${request.operation}) is not a closed Control API V2 surface`,
    );
  }

  const expectedHash = computeRequestHash(
    omitHash(request, 'requestHash') as Omit<ControlApiV2RequestV1, 'requestHash'>,
  );
  if (request.requestHash !== expectedHash) {
    fail('control api v2 request hash does not match the exact record');
  }
  deepFreeze(request);
}

export function assertControlApiV2ReceiptV1(
  value: unknown,
): asserts value is ControlApiV2ReceiptV1 {
  assertExactRecord(value, CONTROL_API_V2_RECEIPT_V1_KEYS, 'control api v2 receipt');
  const receipt = value as unknown as ControlApiV2ReceiptV1;
  if (receipt.schema !== 'hercules-control-api-receipt/v2') {
    fail('control api v2 receipt schema must be hercules-control-api-receipt/v2');
  }
  if (
    !(CONTROL_API_V2_RECEIPT_OUTCOMES as readonly unknown[]).includes(
      receipt.outcome,
    )
  ) {
    fail('control api v2 receipt outcome must be committed or refused');
  }
  if (!isMutationResource(receipt.resource)) {
    fail('control api v2 receipt resource must be task or decision');
  }
  if (!isBoundedIdentifier(receipt.aggregateId)) {
    fail('control api v2 receipt aggregateId must be a non-empty bounded identifier');
  }
  assertSha256Digest(receipt.keyHash, 'control api v2 receipt keyHash');
  assertSha256Digest(receipt.requestHash, 'control api v2 receipt requestHash');
  if (!isCanonicalTimestamp(receipt.decidedAt)) {
    fail('control api v2 receipt decidedAt must be a canonical timestamp');
  }
  assertSha256Digest(receipt.receiptHash, 'control api v2 receipt receiptHash');

  const reasonPresent = receipt.reason !== null;
  if (receipt.outcome === 'refused') {
    if (!reasonPresent) {
      fail('control api v2 receipt reason must be non-null when outcome is refused');
    }
    if (
      !(RECEIPT_REFUSAL_REASONS as readonly unknown[]).includes(receipt.reason)
    ) {
      fail(
        'control api v2 receipt refused reason must be a mutation-reachable engine reason',
      );
    }
    if (receipt.stateVersion !== null || receipt.eventSequence !== null) {
      fail(
        'control api v2 receipt stateVersion and eventSequence must be null when refused',
      );
    }
  } else {
    if (reasonPresent) {
      fail('control api v2 receipt reason must be null when outcome is committed');
    }
    if (
      !isNonNegativeSafeInteger(receipt.stateVersion) ||
      !isPositiveSafeInteger(receipt.eventSequence)
    ) {
      fail(
        'control api v2 receipt stateVersion and eventSequence must be non-null when committed',
      );
    }
  }

  const expectedHash = computeReceiptHash(
    omitHash(receipt, 'receiptHash') as Omit<ControlApiV2ReceiptV1, 'receiptHash'>,
  );
  if (receipt.receiptHash !== expectedHash) {
    fail('control api v2 receipt hash does not match the exact record');
  }
  deepFreeze(receipt);
}

export function assertAdmissionLedgerEntryV1(
  value: unknown,
): asserts value is AdmissionLedgerEntryV1 {
  assertExactRecord(
    value,
    ADMISSION_LEDGER_ENTRY_V1_KEYS,
    'admission ledger entry',
  );
  const entry = value as unknown as AdmissionLedgerEntryV1;
  assertSha256Digest(entry.keyHash, 'admission ledger entry keyHash');
  assertSha256Digest(entry.requestHash, 'admission ledger entry requestHash');
  assertControlApiV2ReceiptV1(entry.receipt);
  if (entry.receipt.outcome !== 'committed') {
    fail('admission ledger entry receipt must be a committed receipt');
  }
  if (entry.keyHash !== entry.receipt.keyHash) {
    fail('admission ledger entry keyHash must equal receipt.keyHash');
  }
  if (entry.requestHash !== entry.receipt.requestHash) {
    fail('admission ledger entry requestHash must equal receipt.requestHash');
  }
  deepFreeze(entry);
}

export function assertControlApiV2RefusalV1(
  value: unknown,
): asserts value is ControlApiV2RefusalV1 {
  assertExactRecord(value, CONTROL_API_V2_REFUSAL_V1_KEYS, 'control api v2 refusal');
  const refusal = value as unknown as ControlApiV2RefusalV1;
  if (refusal.schema !== 'hercules-control-api-refusal/v2') {
    fail('control api v2 refusal schema must be hercules-control-api-refusal/v2');
  }
  if (
    !(CONTROL_API_V2_RESOURCES as readonly unknown[]).includes(refusal.resource)
  ) {
    fail('control api v2 refusal resource must be a closed ControlApiV2Resource');
  }
  if (!isBoundedIdentifierOrEmpty(refusal.aggregateId)) {
    fail(
      'control api v2 refusal aggregateId must be empty or a bounded identifier',
    );
  }
  assertSha256Digest(refusal.requestHash, 'control api v2 refusal requestHash');
  if (
    !(REFUSAL_CARRIER_REASONS as readonly unknown[]).includes(refusal.reason)
  ) {
    fail(
      'control api v2 refusal reason must be invalid_input_schema, unknown_aggregate, or broken_event_chain',
    );
  }
  if (!isCanonicalTimestamp(refusal.decidedAt)) {
    fail('control api v2 refusal decidedAt must be a canonical timestamp');
  }
  assertSha256Digest(refusal.refusalHash, 'control api v2 refusal refusalHash');
  const expectedHash = computeRefusalHash(
    omitHash(refusal, 'refusalHash') as Omit<ControlApiV2RefusalV1, 'refusalHash'>,
  );
  if (refusal.refusalHash !== expectedHash) {
    fail('control api v2 refusal hash does not match the exact record');
  }
  deepFreeze(refusal);
}

export function assertControlApiV2ReviewViewV1(
  value: unknown,
): asserts value is ControlApiV2ReviewViewV1 {
  assertExactRecord(
    value,
    CONTROL_API_V2_REVIEW_VIEW_V1_KEYS,
    'control api v2 review view',
  );
  const view = value as unknown as ControlApiV2ReviewViewV1;
  if (view.schema !== 'hercules-control-api-review-view/v2') {
    fail(
      'control api v2 review view schema must be hercules-control-api-review-view/v2',
    );
  }
  if (!isBoundedIdentifier(view.aggregateId)) {
    fail('control api v2 review view aggregateId must be a bounded identifier');
  }
  if (!isNonNegativeSafeInteger(view.stateVersion)) {
    fail('control api v2 review view stateVersion must be a non-negative safe integer');
  }
  assertSha256Digest(view.viewHash, 'control api v2 review view viewHash');
  // reviewPackage is a trusted, already-projected M6 ReviewPackageV2 supplied by
  // the trusted reader port; per the ReviewPackageV2 authority model we do NOT
  // re-run its authority-bearing structural projection here (that is confined to
  // the projection site). A light shape gate keeps the closed record well-formed.
  if (
    view.reviewPackage === null ||
    typeof view.reviewPackage !== 'object' ||
    (view.reviewPackage as { schema?: unknown }).schema !==
      'hercules-review-package/v2'
  ) {
    fail('control api v2 review view reviewPackage must be a ReviewPackageV2');
  }
  const expectedHash = computeReviewViewHash(
    omitHash(view, 'viewHash') as Omit<ControlApiV2ReviewViewV1, 'viewHash'>,
  );
  if (view.viewHash !== expectedHash) {
    fail('control api v2 review view hash does not match the exact record');
  }
  deepFreeze(view);
}

export function assertControlApiV2StatusViewV1(
  value: unknown,
): asserts value is ControlApiV2StatusViewV1 {
  assertExactRecord(
    value,
    CONTROL_API_V2_STATUS_VIEW_V1_KEYS,
    'control api v2 status view',
  );
  const view = value as unknown as ControlApiV2StatusViewV1;
  if (view.schema !== 'hercules-control-api-status-view/v2') {
    fail(
      'control api v2 status view schema must be hercules-control-api-status-view/v2',
    );
  }
  if (!isBoundedIdentifier(view.aggregateId)) {
    fail('control api v2 status view aggregateId must be a bounded identifier');
  }
  if (!isNonNegativeSafeInteger(view.stateVersion)) {
    fail('control api v2 status view stateVersion must be a non-negative safe integer');
  }
  if (!isBoundedNfcString(view.taskStatus)) {
    fail('control api v2 status view taskStatus must be a bounded non-empty NFC string');
  }
  if (!isNonNegativeSafeInteger(view.latestEventSequence)) {
    fail(
      'control api v2 status view latestEventSequence must be a non-negative safe integer',
    );
  }
  assertSha256Digest(view.viewHash, 'control api v2 status view viewHash');
  const expectedHash = computeStatusViewHash(
    omitHash(view, 'viewHash') as Omit<ControlApiV2StatusViewV1, 'viewHash'>,
  );
  if (view.viewHash !== expectedHash) {
    fail('control api v2 status view hash does not match the exact record');
  }
  deepFreeze(view);
}

export function assertControlEventView(
  value: unknown,
): asserts value is ControlEventView {
  assertExactRecord(value, CONTROL_EVENT_VIEW_KEYS, 'control event view');
  const view = value as unknown as ControlEventView;
  if (!isPositiveSafeInteger(view.sequence)) {
    fail('control event view sequence must be a positive safe integer');
  }
  if (!isBoundedIdentifier(view.eventId)) {
    fail('control event view eventId must be a bounded identifier');
  }
  if (!(CONTROL_EVENT_TYPES as readonly unknown[]).includes(view.eventType)) {
    fail('control event view eventType must be a closed ControlEventType');
  }
  if (
    !(CONTROL_EVENT_AGGREGATES as readonly unknown[]).includes(view.aggregateKind)
  ) {
    fail('control event view aggregateKind must be a closed ControlEventAggregate');
  }
  if (!isBoundedIdentifier(view.aggregateId)) {
    fail('control event view aggregateId must be a bounded identifier');
  }
  assertSha256Digest(view.eventHash, 'control event view eventHash');
  if (view.sequence === 1) {
    if (view.previousEventHash !== null) {
      fail(
        'control event view previousEventHash must be null for the genesis event (sequence 1)',
      );
    }
  } else if (view.previousEventHash === null) {
    fail(
      'control event view previousEventHash must be non-null when sequence is greater than 1',
    );
  } else {
    assertSha256Digest(
      view.previousEventHash,
      'control event view previousEventHash',
    );
  }
  deepFreeze(view);
}

export function assertEventPageV1(value: unknown): asserts value is EventPageV1 {
  assertExactRecord(value, EVENT_PAGE_V1_KEYS, 'event page');
  const page = value as unknown as EventPageV1;
  if (page.schema !== 'hercules-control-api-event-page/v2') {
    fail('event page schema must be hercules-control-api-event-page/v2');
  }
  if (!isNonNegativeSafeInteger(page.afterSequence)) {
    fail('event page afterSequence must be a non-negative safe integer');
  }
  if (typeof page.endOfStream !== 'boolean') {
    fail('event page endOfStream must be a boolean');
  }
  if (!isNonNegativeSafeInteger(page.nextAfterSequence)) {
    fail('event page nextAfterSequence must be a non-negative safe integer');
  }
  assertSha256Digest(page.pageHash, 'event page pageHash');
  assertDenseArray(page.events, 'event page events');
  if (page.events.length > MAX_EVENT_PAGE) {
    fail(`event page events must not exceed MAX_EVENT_PAGE (${MAX_EVENT_PAGE})`);
  }
  let previousSequence: number | null = null;
  for (let index = 0; index < page.events.length; index += 1) {
    const event = page.events[index];
    if (event === undefined) {
      fail('event page events must not be sparse');
    }
    assertControlEventView(event);
    if (previousSequence !== null && event.sequence <= previousSequence) {
      fail('event page events must be strictly increasing by sequence');
    }
    previousSequence = event.sequence;
  }
  if (page.events.length === 0) {
    if (page.nextAfterSequence !== page.afterSequence) {
      fail(
        'empty event page nextAfterSequence must equal afterSequence',
      );
    }
  } else {
    const last = page.events[page.events.length - 1];
    if (last === undefined || page.nextAfterSequence !== last.sequence) {
      fail(
        'non-empty event page nextAfterSequence must equal the last event sequence',
      );
    }
  }
  const expectedHash = computeEventPageHash(
    omitHash(page, 'pageHash') as Omit<EventPageV1, 'pageHash'>,
  );
  if (page.pageHash !== expectedHash) {
    fail('event page hash does not match the exact record');
  }
  deepFreeze(page);
}

export function assertAdmissionVerdictV1(
  value: unknown,
): asserts value is AdmissionVerdictV1 {
  assertExactRecord(value, ADMISSION_VERDICT_V1_KEYS, 'admission verdict');
  const verdict = value as unknown as AdmissionVerdictV1;
  if (verdict.schema !== 'hercules-control-api-admit-verdict/v2') {
    fail(
      'admission verdict schema must be hercules-control-api-admit-verdict/v2',
    );
  }
  if (!isMutationResource(verdict.resource)) {
    fail('admission verdict resource must be task or decision');
  }
  if (!isBoundedIdentifier(verdict.aggregateId)) {
    fail('admission verdict aggregateId must be a bounded identifier');
  }
  assertSha256Digest(verdict.keyHash, 'admission verdict keyHash');
  assertSha256Digest(verdict.requestHash, 'admission verdict requestHash');
  if (!isCanonicalTimestamp(verdict.decidedAt)) {
    fail('admission verdict decidedAt must be a canonical timestamp');
  }
  assertSha256Digest(verdict.verdictHash, 'admission verdict verdictHash');
  const expectedHash = computeAdmissionVerdictHash(
    omitHash(verdict, 'verdictHash') as Omit<AdmissionVerdictV1, 'verdictHash'>,
  );
  if (verdict.verdictHash !== expectedHash) {
    fail('admission verdict hash does not match the exact record');
  }
  deepFreeze(verdict);
}

// ---------------------------------------------------------------------------
// Shared client contract helpers
// ---------------------------------------------------------------------------

export function buildIdempotencyKey(input: {
  readonly actorIssuer: string;
  readonly actorId: string;
  readonly aggregateId: string;
  readonly clientRequestId: string;
}): IdempotencyKeyV2 {
  const withoutHash: Omit<IdempotencyKeyV2, 'keyHash'> = {
    actorIssuer: input.actorIssuer,
    actorId: input.actorId,
    aggregateId: input.aggregateId,
    clientRequestId: input.clientRequestId,
  };
  const key = {
    ...withoutHash,
    keyHash: computeIdempotencyKeyHash(withoutHash),
  };
  assertIdempotencyKeyV2(key, {
    allowEmptyAggregateId: input.aggregateId === '',
  });
  return key;
}

export function buildConcurrencyToken(input: {
  readonly aggregateId: string;
  readonly stateVersion: number;
  readonly projectionHash: string;
}): ConcurrencyTokenV2 {
  const withoutHash: Omit<ConcurrencyTokenV2, 'tokenHash'> = {
    aggregateId: input.aggregateId,
    stateVersion: input.stateVersion,
    projectionHash: input.projectionHash,
  };
  const token: ConcurrencyTokenV2 = {
    ...withoutHash,
    tokenHash: computeConcurrencyTokenHash(withoutHash),
  };
  assertConcurrencyTokenV2(token);
  return token;
}

export function buildControlApiV2Request(input: {
  readonly resource: ControlApiV2Resource;
  readonly operation: ControlApiV2Operation;
  readonly aggregateId: string;
  readonly idempotencyKey: null | IdempotencyKeyV2;
  readonly concurrencyToken: null | ConcurrencyTokenV2;
  readonly payload: ControlApiV2PayloadV1;
  readonly issuedAt: string;
}): ControlApiV2RequestV1 {
  assertControlApiV2PayloadV1(input.payload);
  const payloadHash = computePayloadHash(input.payload);
  const withoutHash: Omit<ControlApiV2RequestV1, 'requestHash'> = {
    schema: 'hercules-control-api-request/v2',
    resource: input.resource,
    operation: input.operation,
    aggregateId: input.aggregateId,
    idempotencyKey: input.idempotencyKey,
    concurrencyToken: input.concurrencyToken,
    payload: input.payload,
    payloadHash,
    issuedAt: input.issuedAt,
  };
  const request: ControlApiV2RequestV1 = {
    ...withoutHash,
    requestHash: computeRequestHash(withoutHash),
  };
  assertControlApiV2RequestV1(request);
  return request;
}

/**
 * Closed structural parser for route-completed client responses.
 * Validates shapes only — never mints control authority.
 */
export function parseControlApiV2Response(
  value: unknown,
): ControlApiV2ResponseV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('control api v2 response must be an object');
  }
  const schema = (value as Readonly<Record<string, unknown>>)['schema'];
  if (schema === 'hercules-control-api-receipt/v2') {
    assertControlApiV2ReceiptV1(value);
    return value;
  }
  if (schema === 'hercules-control-api-refusal/v2') {
    assertControlApiV2RefusalV1(value);
    return value;
  }
  if (schema === 'hercules-control-api-review-view/v2') {
    assertControlApiV2ReviewViewV1(value);
    return value;
  }
  if (schema === 'hercules-control-api-status-view/v2') {
    assertControlApiV2StatusViewV1(value);
    return value;
  }
  if (schema === 'hercules-control-api-event-page/v2') {
    assertEventPageV1(value);
    return value;
  }
  fail('control api v2 response schema is unrecognized');
}

// ---------------------------------------------------------------------------
// Shared HTTP route mapping + server-side read request builders
// ---------------------------------------------------------------------------

/**
 * Server-side builder for GET status/review reads.
 * GET carries no body — the route constructs the closed request from `:id` + clock.
 */
export function buildControlApiV2ReadRequest(
  resource: 'status' | 'review',
  aggregateId: string,
  now: string,
): ControlApiV2RequestV1 {
  return buildControlApiV2Request({
    resource,
    operation: 'read',
    aggregateId,
    idempotencyKey: null,
    concurrencyToken: null,
    payload: { kind: 'read' },
    issuedAt: now,
  });
}

/**
 * Server-side builder for GET event reads from query params.
 * GET carries no body — cursor fields come only from the query string.
 */
export function buildControlApiV2EventReadRequest(input: {
  readonly afterSequence: number;
  readonly limit: number;
  readonly expectedPreviousEventHash: string | null;
  readonly issuedAt: string;
}): ControlApiV2RequestV1 {
  const withoutHash: Omit<EventCursorRequestV1, 'cursorHash'> = {
    schema: 'hercules-control-api-event-cursor/v2',
    afterSequence: input.afterSequence,
    expectedPreviousEventHash: input.expectedPreviousEventHash,
    limit: input.limit,
  };
  const payload: EventCursorRequestV1 = {
    ...withoutHash,
    cursorHash: computeEventCursorHash(withoutHash),
  };
  return buildControlApiV2Request({
    resource: 'event',
    operation: 'read',
    aggregateId: '',
    idempotencyKey: null,
    concurrencyToken: null,
    payload,
    issuedAt: input.issuedAt,
  });
}

/** Map a completed Control API V2 response to its HTTP status. */
export function controlApiV2HttpStatusForResponse(
  response: ControlApiV2ResponseV1,
): 200 | 400 | 404 | 409 | 422 {
  if (response.schema === 'hercules-control-api-receipt/v2') {
    if (response.outcome === 'committed') {
      return 200;
    }
    if (response.reason === null) {
      fail('refused receipt must carry an engine reason');
    }
    return controlApiV2HttpStatusForReason(response.reason);
  }
  if (response.schema === 'hercules-control-api-refusal/v2') {
    return controlApiV2HttpStatusForReason(response.reason);
  }
  return 200;
}
