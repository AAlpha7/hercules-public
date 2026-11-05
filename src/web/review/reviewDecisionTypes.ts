import type { DecisionBindingDto, OutcomeDecision } from './reviewTypes.js';
import { ReviewDtoDecodeError } from './reviewTypes.js';

export interface ReviewDecisionRequestDto {
  readonly schema: 'hercules-review-decision-request/v1';
  readonly clientRequestId: string;
  readonly taskId: string;
  readonly projectionHash: string;
  readonly decisionBinding: DecisionBindingDto;
  readonly action: OutcomeDecision;
  readonly reason: string | null;
  readonly acknowledgedRiskCodes: readonly string[];
}

export interface ReviewDecisionReceiptDto {
  readonly schema: 'hercules-review-decision-receipt/v1';
  readonly clientRequestId: string;
  readonly requestHash: string;
  readonly taskId: string;
  readonly actor: {
    readonly kind: 'human';
    readonly id: string;
    readonly issuer: string;
  };
  readonly acceptedProjectionHash: string;
  readonly acceptedDecisionBindingHash: string;
  readonly action: OutcomeDecision;
  readonly humanDecisionId: string;
  readonly eventId: string;
  readonly priorIterationId: string;
  readonly resultingIterationId: string;
  readonly recordedAt: string;
  readonly receiptHash: string;
}

export interface ReviewDecisionResponseDto {
  readonly schema: 'hercules-review-decision-response/v1';
  readonly receipt: ReviewDecisionReceiptDto;
  readonly duplicate: boolean;
}

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9._-]+$/;
const encoder = new TextEncoder();

function reject(message: string): never {
  throw new ReviewDtoDecodeError(message);
}

function record(value: unknown, keys: readonly string[], label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return reject(`${label} must be an exact object`);
  }
  const row = value as Readonly<Record<string, unknown>>;
  const own = Object.keys(row);
  if (own.length !== keys.length || own.some((key) => !keys.includes(key))) {
    return reject(`${label} has an invalid schema`);
  }
  return row;
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !IDENTIFIER.test(value) ||
    value === '.' ||
    value === '..' ||
    encoder.encode(value).byteLength > 256
  ) return reject(`${label} is invalid`);
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) return reject(`${label} is invalid`);
  return value;
}

function action(value: unknown): OutcomeDecision {
  if (
    value !== 'approve_outcome' &&
    value !== 'reject_outcome' &&
    value !== 'request_changes'
  ) return reject('receipt action is invalid');
  return value;
}

function timestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) return reject('receipt timestamp is invalid');
  return value;
}

export function decodeReviewDecisionResponseV1(value: unknown): ReviewDecisionResponseDto {
  const root = record(value, ['schema', 'receipt', 'duplicate'], 'review decision response');
  if (
    root['schema'] !== 'hercules-review-decision-response/v1' ||
    typeof root['duplicate'] !== 'boolean'
  ) return reject('review decision response is invalid');
  const row = record(root['receipt'], [
    'schema', 'clientRequestId', 'requestHash', 'taskId', 'actor',
    'acceptedProjectionHash', 'acceptedDecisionBindingHash', 'action',
    'humanDecisionId', 'eventId', 'priorIterationId', 'resultingIterationId',
    'recordedAt', 'receiptHash',
  ], 'review decision receipt');
  if (row['schema'] !== 'hercules-review-decision-receipt/v1') {
    return reject('review decision receipt schema is invalid');
  }
  const actor = record(row['actor'], ['kind', 'id', 'issuer'], 'review decision actor');
  if (actor['kind'] !== 'human') return reject('review decision actor is invalid');
  return {
    schema: 'hercules-review-decision-response/v1',
    receipt: {
      schema: 'hercules-review-decision-receipt/v1',
      clientRequestId: identifier(row['clientRequestId'], 'receipt client request id'),
      requestHash: digest(row['requestHash'], 'receipt request hash'),
      taskId: identifier(row['taskId'], 'receipt task id'),
      actor: {
        kind: 'human',
        id: identifier(actor['id'], 'actor id'),
        issuer: identifier(actor['issuer'], 'actor issuer'),
      },
      acceptedProjectionHash: digest(row['acceptedProjectionHash'], 'accepted projection hash'),
      acceptedDecisionBindingHash: digest(row['acceptedDecisionBindingHash'], 'accepted binding hash'),
      action: action(row['action']),
      humanDecisionId: identifier(row['humanDecisionId'], 'human decision id'),
      eventId: identifier(row['eventId'], 'event id'),
      priorIterationId: identifier(row['priorIterationId'], 'prior iteration id'),
      resultingIterationId: identifier(row['resultingIterationId'], 'resulting iteration id'),
      recordedAt: timestamp(row['recordedAt']),
      receiptHash: digest(row['receiptHash'], 'receipt hash'),
    },
    duplicate: root['duplicate'],
  };
}
