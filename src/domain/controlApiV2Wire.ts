/**
 * Browser-safe Control API V2 wire contract.
 *
 * Closed records, key lists, reason unions, and HTTP route mapping.
 * No Node / hashing / validators / ports — those remain in controlApiV2.ts.
 */

// ---------------------------------------------------------------------------
// Fail-closed error class (validators throw only invalid_input_schema)
// ---------------------------------------------------------------------------

export type EngineRefusalReasonV1 =
  | 'invalid_input_schema'
  | 'unknown_aggregate'
  | 'idempotency_conflict'
  | 'stale_version'
  | 'stale_projection'
  | 'need_more_evidence'
  | 'ineligible_decision'
  | 'broken_event_chain';

export const ENGINE_REFUSAL_REASONS = [
  'invalid_input_schema',
  'unknown_aggregate',
  'idempotency_conflict',
  'stale_version',
  'stale_projection',
  'need_more_evidence',
  'ineligible_decision',
  'broken_event_chain',
] as const satisfies readonly EngineRefusalReasonV1[];

export type RouteRefusalReasonV1 = 'unauthorized' | 'provider_unavailable';

export const ROUTE_REFUSAL_REASONS = [
  'unauthorized',
  'provider_unavailable',
] as const satisfies readonly RouteRefusalReasonV1[];

/** Mutation-reachable refused-receipt reasons (never schema/chain carriers). */
export type ReceiptRefusalReasonV1 = Exclude<
  EngineRefusalReasonV1,
  'invalid_input_schema' | 'broken_event_chain'
>;

export const RECEIPT_REFUSAL_REASONS = [
  'unknown_aggregate',
  'idempotency_conflict',
  'stale_version',
  'stale_projection',
  'need_more_evidence',
  'ineligible_decision',
] as const satisfies readonly ReceiptRefusalReasonV1[];

/** Structural/refusal-carrier reasons on ControlApiV2RefusalV1. */
export type RefusalCarrierReasonV1 =
  | 'invalid_input_schema'
  | 'unknown_aggregate'
  | 'broken_event_chain';

export const REFUSAL_CARRIER_REASONS = [
  'invalid_input_schema',
  'unknown_aggregate',
  'broken_event_chain',
] as const satisfies readonly RefusalCarrierReasonV1[];

export type ControlApiV2ErrorCode =
  | EngineRefusalReasonV1
  | RouteRefusalReasonV1;

export class ControlApiV2Error extends Error {
  override readonly name = 'ControlApiV2Error';

  constructor(
    readonly code: ControlApiV2ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Closed unions
// ---------------------------------------------------------------------------

export type ControlApiV2Resource =
  | 'task'
  | 'status'
  | 'review'
  | 'decision'
  | 'event';

export const CONTROL_API_V2_RESOURCES = [
  'task',
  'status',
  'review',
  'decision',
  'event',
] as const satisfies readonly ControlApiV2Resource[];

export type ControlApiV2Operation = 'create' | 'read' | 'submit';

export const CONTROL_API_V2_OPERATIONS = [
  'create',
  'read',
  'submit',
] as const satisfies readonly ControlApiV2Operation[];

export type ControlApiV2ReceiptOutcomeV1 = 'committed' | 'refused';

export const CONTROL_API_V2_RECEIPT_OUTCOMES = [
  'committed',
  'refused',
] as const satisfies readonly ControlApiV2ReceiptOutcomeV1[];

export const M6_OUTCOME_DECISIONS = ['approve_outcome', 'reject_outcome', 'request_changes'] as const;
/** Wire-side decision action union; pinned equal to the domain M6OutcomeDecision in controlApiV2.ts. */
export type ControlApiV2DecisionActionV1 = (typeof M6_OUTCOME_DECISIONS)[number];

/** Bounded page size for event cursor reads (aligned with state-store max). */
export const MAX_EVENT_PAGE = 1_000;

// ---------------------------------------------------------------------------
// Records (verbatim from M11 closed-records contract)
// ---------------------------------------------------------------------------

export interface IdempotencyKeyV2 {
  readonly actorIssuer: string;
  readonly actorId: string;
  readonly aggregateId: string;
  readonly clientRequestId: string;
  readonly keyHash: string;
}

export interface ConcurrencyTokenV2 {
  readonly aggregateId: string;
  readonly stateVersion: number;
  readonly projectionHash: string;
  readonly tokenHash: string;
}

export interface CreatePayloadV1 {
  readonly kind: 'create';
  readonly taskContractHash: string;
  readonly intentDigest: string;
}

export interface DecisionPayloadV1 {
  readonly kind: 'decision';
  readonly action: ControlApiV2DecisionActionV1;
  readonly reason: string;
  readonly acknowledgedRiskCodes: readonly string[];
}

export interface ReadPayloadV1 {
  readonly kind: 'read';
}

export interface EventCursorRequestV1 {
  readonly schema: 'hercules-control-api-event-cursor/v2';
  readonly afterSequence: number;
  readonly expectedPreviousEventHash: string | null;
  readonly limit: number;
  readonly cursorHash: string;
}

export type ControlApiV2PayloadV1 =
  | CreatePayloadV1
  | DecisionPayloadV1
  | ReadPayloadV1
  | EventCursorRequestV1;

export interface ControlApiV2RequestV1 {
  readonly schema: 'hercules-control-api-request/v2';
  readonly resource: ControlApiV2Resource;
  readonly operation: ControlApiV2Operation;
  readonly aggregateId: string;
  readonly idempotencyKey: null | IdempotencyKeyV2;
  readonly concurrencyToken: null | ConcurrencyTokenV2;
  readonly payload: ControlApiV2PayloadV1;
  readonly payloadHash: string;
  readonly issuedAt: string;
  readonly requestHash: string;
}

export interface ControlApiV2ReceiptV1 {
  readonly schema: 'hercules-control-api-receipt/v2';
  readonly outcome: ControlApiV2ReceiptOutcomeV1;
  readonly resource: ControlApiV2Resource;
  readonly aggregateId: string;
  readonly keyHash: string;
  readonly requestHash: string;
  readonly stateVersion: number | null;
  readonly eventSequence: number | null;
  readonly reason: EngineRefusalReasonV1 | null;
  readonly decidedAt: string;
  readonly receiptHash: string;
}

export interface AdmissionLedgerEntryV1 {
  readonly keyHash: string;
  readonly requestHash: string;
  readonly receipt: ControlApiV2ReceiptV1;
}

export interface ControlApiV2RefusalV1 {
  readonly schema: 'hercules-control-api-refusal/v2';
  readonly resource: ControlApiV2Resource;
  readonly aggregateId: string;
  readonly requestHash: string;
  readonly reason: EngineRefusalReasonV1;
  readonly decidedAt: string;
  readonly refusalHash: string;
}

export interface ControlApiV2StatusViewV1 {
  readonly schema: 'hercules-control-api-status-view/v2';
  readonly aggregateId: string;
  readonly stateVersion: number;
  readonly taskStatus: string;
  readonly latestEventSequence: number;
  readonly viewHash: string;
}

export interface ControlEventView {
  readonly sequence: number;
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateKind: string;
  readonly aggregateId: string;
  readonly previousEventHash: string | null;
  readonly eventHash: string;
}

export interface EventPageV1 {
  readonly schema: 'hercules-control-api-event-page/v2';
  readonly afterSequence: number;
  readonly events: readonly ControlEventView[];
  readonly nextAfterSequence: number;
  readonly endOfStream: boolean;
  readonly pageHash: string;
}

export interface AdmissionVerdictV1 {
  readonly schema: 'hercules-control-api-admit-verdict/v2';
  readonly resource: ControlApiV2Resource;
  readonly aggregateId: string;
  readonly keyHash: string;
  readonly requestHash: string;
  readonly decidedAt: string;
  readonly verdictHash: string;
}

// ---------------------------------------------------------------------------
// Closed key lists
// ---------------------------------------------------------------------------

export const IDEMPOTENCY_KEY_V2_KEYS = [
  'actorIssuer',
  'actorId',
  'aggregateId',
  'clientRequestId',
  'keyHash',
] as const;

export const CONCURRENCY_TOKEN_V2_KEYS = [
  'aggregateId',
  'stateVersion',
  'projectionHash',
  'tokenHash',
] as const;

export const CREATE_PAYLOAD_V1_KEYS = [
  'kind',
  'taskContractHash',
  'intentDigest',
] as const;

export const DECISION_PAYLOAD_V1_KEYS = [
  'kind',
  'action',
  'reason',
  'acknowledgedRiskCodes',
] as const;

export const READ_PAYLOAD_V1_KEYS = ['kind'] as const;

export const EVENT_CURSOR_REQUEST_V1_KEYS = [
  'schema',
  'afterSequence',
  'expectedPreviousEventHash',
  'limit',
  'cursorHash',
] as const;

export const CONTROL_API_V2_REQUEST_V1_KEYS = [
  'schema',
  'resource',
  'operation',
  'aggregateId',
  'idempotencyKey',
  'concurrencyToken',
  'payload',
  'payloadHash',
  'issuedAt',
  'requestHash',
] as const;

/** Mechanical proof: receipt carries no task-state / verdict / eligibility field. */
export const CONTROL_API_V2_RECEIPT_V1_KEYS = [
  'schema',
  'outcome',
  'resource',
  'aggregateId',
  'keyHash',
  'requestHash',
  'stateVersion',
  'eventSequence',
  'reason',
  'decidedAt',
  'receiptHash',
] as const;

export const ADMISSION_LEDGER_ENTRY_V1_KEYS = [
  'keyHash',
  'requestHash',
  'receipt',
] as const;

/** Mechanical proof: refusal carries no task-state / verdict / eligibility field. */
export const CONTROL_API_V2_REFUSAL_V1_KEYS = [
  'schema',
  'resource',
  'aggregateId',
  'requestHash',
  'reason',
  'decidedAt',
  'refusalHash',
] as const;

/** Mechanical proof: review view carries no mutation field. */
export const CONTROL_API_V2_REVIEW_VIEW_V1_KEYS = [
  'schema',
  'aggregateId',
  'stateVersion',
  'reviewPackage',
  'viewHash',
] as const;

/** Mechanical proof: status view carries no mutation field. */
export const CONTROL_API_V2_STATUS_VIEW_V1_KEYS = [
  'schema',
  'aggregateId',
  'stateVersion',
  'taskStatus',
  'latestEventSequence',
  'viewHash',
] as const;

export const CONTROL_EVENT_VIEW_KEYS = [
  'sequence',
  'eventId',
  'eventType',
  'aggregateKind',
  'aggregateId',
  'previousEventHash',
  'eventHash',
] as const;

export const EVENT_PAGE_V1_KEYS = [
  'schema',
  'afterSequence',
  'events',
  'nextAfterSequence',
  'endOfStream',
  'pageHash',
] as const;

export const ADMISSION_VERDICT_V1_KEYS = [
  'schema',
  'resource',
  'aggregateId',
  'keyHash',
  'requestHash',
  'decidedAt',
  'verdictHash',
] as const;

// ---------------------------------------------------------------------------
// Shared HTTP route mapping + server-side read request builders
// ---------------------------------------------------------------------------

export interface ControlApiV2HttpRouteV1 {
  readonly method: 'GET' | 'POST';
  readonly path: string;
}

/**
 * Pure path/method mapping for Control API V2 resources.
 * Defined once here so CLI/test and Web clients stay DOM-free and identical.
 * Event reads append cursor query params separately (not part of the path).
 */
export function controlApiV2HttpRoute(
  resource: ControlApiV2Resource,
  aggregateId: string,
): ControlApiV2HttpRouteV1 {
  switch (resource) {
    case 'task':
      return { method: 'POST', path: '/api/v2/control/tasks' };
    case 'decision':
      return {
        method: 'POST',
        path: `/api/v2/control/tasks/${encodeURIComponent(aggregateId)}/decision`,
      };
    case 'status':
      return {
        method: 'GET',
        path: `/api/v2/control/tasks/${encodeURIComponent(aggregateId)}/status`,
      };
    case 'review':
      return {
        method: 'GET',
        path: `/api/v2/control/tasks/${encodeURIComponent(aggregateId)}/review`,
      };
    case 'event':
      return { method: 'GET', path: '/api/v2/control/events' };
  }
}

/**
 * Engine reason → HTTP status (one table for all V2 control routes).
 * Route-only reasons (`unauthorized` / `provider_unavailable`) are handled
 * by auth middleware / fail-closed ports, not this table.
 */
export function controlApiV2HttpStatusForReason(
  reason: EngineRefusalReasonV1,
): 400 | 404 | 409 | 422 {
  switch (reason) {
    case 'invalid_input_schema':
      return 400;
    case 'unknown_aggregate':
      return 404;
    case 'idempotency_conflict':
    case 'stale_version':
    case 'stale_projection':
    case 'broken_event_chain':
      return 409;
    case 'need_more_evidence':
    case 'ineligible_decision':
      return 422;
  }
}

/** Query-string builder for GET /api/v2/control/events (clients + tests). */
export function controlApiV2EventQuery(input: {
  readonly afterSequence: number;
  readonly limit: number;
  readonly expectedPreviousEventHash: string | null;
}): string {
  const params = new URLSearchParams();
  params.set('afterSequence', String(input.afterSequence));
  params.set('limit', String(input.limit));
  params.set(
    'expectedPreviousEventHash',
    input.expectedPreviousEventHash === null
      ? ''
      : input.expectedPreviousEventHash,
  );
  return params.toString();
}
