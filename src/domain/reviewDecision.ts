import { canonicalClone, hashCanonicalJson } from './canonicalJson.js';
import type { DecisionBinding } from './evaluationVerdict.js';
import { isValidIdentifier } from './task.js';
import { snapshotReviewActorV1, type ReviewActorV1 } from './reviewEvidence.js';

export const REVIEW_DECISION_ACTIONS = [
  'approve_outcome',
  'reject_outcome',
  'request_changes',
] as const;

export type ReviewDecisionAction = (typeof REVIEW_DECISION_ACTIONS)[number];

export interface ReviewDecisionRequestV1 {
  readonly schema: 'hercules-review-decision-request/v1';
  readonly clientRequestId: string;
  readonly taskId: string;
  readonly projectionHash: string;
  readonly decisionBinding: DecisionBinding;
  readonly action: ReviewDecisionAction;
  readonly reason: string | null;
  readonly acknowledgedRiskCodes: readonly string[];
}

export interface ReviewDecisionReceiptV1 {
  readonly schema: 'hercules-review-decision-receipt/v1';
  readonly clientRequestId: string;
  readonly requestHash: string;
  readonly taskId: string;
  readonly actor: ReviewActorV1;
  readonly acceptedProjectionHash: string;
  readonly acceptedDecisionBindingHash: string;
  readonly action: ReviewDecisionAction;
  readonly humanDecisionId: string;
  readonly eventId: string;
  readonly priorIterationId: string;
  readonly resultingIterationId: string;
  readonly recordedAt: string;
  readonly receiptHash: string;
}

export interface ReviewDecisionResponseV1 {
  readonly schema: 'hercules-review-decision-response/v1';
  readonly receipt: ReviewDecisionReceiptV1;
  readonly duplicate: boolean;
}

export interface ReviewDecisionIdempotencyKeyV1 {
  readonly actorIssuer: string;
  readonly actorId: string;
  readonly taskId: string;
  readonly clientRequestId: string;
}

export interface ReviewDecisionCommandV1 {
  readonly request: ReviewDecisionRequestV1;
  readonly requestHash: string;
  readonly actor: ReviewActorV1;
  readonly expectedProjectionHash: string;
  readonly expectedDecisionBindingHash: string;
}

export type ReviewDecisionApplyResultV1 =
  | { readonly kind: 'committed'; readonly receipt: ReviewDecisionReceiptV1 }
  | { readonly kind: 'duplicate'; readonly receipt: ReviewDecisionReceiptV1 }
  | { readonly kind: 'stale' }
  | { readonly kind: 'idempotency_conflict' }
  | {
      readonly kind: 'unavailable';
      readonly reason:
        | 'source_unavailable'
        | 'integrity_unavailable'
        | 'transaction_unavailable'
        | 'provider_contract_violation';
    };

export interface ReviewDecisionPortV1 {
  isReady(): boolean;
  lookup(key: ReviewDecisionIdempotencyKeyV1): Promise<ReviewDecisionReceiptV1 | null>;
  apply(command: ReviewDecisionCommandV1): Promise<ReviewDecisionApplyResultV1>;
  validateCommittedReceipt(input: Readonly<{
    key: ReviewDecisionIdempotencyKeyV1;
    requestHash: string;
    receipt: ReviewDecisionReceiptV1;
  }>): Promise<
    | { readonly kind: 'valid' }
    | { readonly kind: 'invalid' }
    | { readonly kind: 'unavailable' }
  >;
}

export interface ReviewActorResolverV1 {
  isReady(): boolean;
  resolveActor(): Promise<ReviewActorV1 | null>;
}

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GIT_REVISION = /^[0-9a-f]{40}$/;
const MAX_REASON_BYTES = 8 * 1024;
const MAX_RISK_CODES = 8 * 1024;
const encoder = new TextEncoder();

function exactRecord(value: unknown, keys: readonly string[], label: string): Readonly<Record<string, unknown>> {
  const detached = canonicalClone(value);
  if (detached === null || typeof detached !== 'object' || Array.isArray(detached)) {
    throw new TypeError(`${label} must be an exact object`);
  }
  const record = detached as Readonly<Record<string, unknown>>;
  const own = Object.keys(record);
  if (own.length !== keys.length || own.some((key) => !keys.includes(key))) {
    throw new TypeError(`${label} has an invalid schema`);
  }
  return record;
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !isValidIdentifier(value) ||
    encoder.encode(value).byteLength > 256
  ) throw new TypeError(`${label} is invalid`);
  return value;
}

function boundedText(value: unknown, label: string, maxBytes = 256): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    encoder.encode(value).byteLength > maxBytes
  ) throw new TypeError(`${label} is invalid`);
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function action(value: unknown): ReviewDecisionAction {
  if (!(REVIEW_DECISION_ACTIONS as readonly unknown[]).includes(value)) {
    throw new TypeError('review decision action is invalid');
  }
  return value as ReviewDecisionAction;
}

function decisionBinding(value: unknown): Readonly<DecisionBinding> {
  const record = exactRecord(value, [
    'taskId',
    'contractVersion',
    'contractHash',
    'iterationId',
    'candidateRef',
    'evidenceManifestHash',
    'evaluatorVersion',
    'evaluatorModel',
    'evaluatorRuntime',
    'policyVersion',
  ], 'decision binding');
  if (!Number.isSafeInteger(record['contractVersion']) || Number(record['contractVersion']) < 1) {
    throw new TypeError('decision binding contract version is invalid');
  }
  if (record['iterationId'] === null || record['candidateRef'] === null || record['evidenceManifestHash'] === null) {
    throw new TypeError('review decision requires an exact iteration, candidate, and manifest');
  }
  const candidate = exactRecord(
    record['candidateRef'],
    ['kind', 'repository', 'revision'],
    'decision candidate',
  );
  if (
    candidate['kind'] !== 'git' ||
    typeof candidate['revision'] !== 'string' ||
    !GIT_REVISION.test(candidate['revision'])
  ) throw new TypeError('review decision requires an exact Git candidate');
  const evaluatorModel = record['evaluatorModel'] === null
    ? null
    : boundedText(record['evaluatorModel'], 'evaluator model');
  return Object.freeze({
    taskId: identifier(record['taskId'], 'binding task id'),
    contractVersion: record['contractVersion'] as number,
    contractHash: digest(record['contractHash'], 'contract hash'),
    iterationId: identifier(record['iterationId'], 'iteration id'),
    candidateRef: Object.freeze({
      kind: 'git',
      repository: boundedText(candidate['repository'], 'candidate repository'),
      revision: candidate['revision'],
    }),
    evidenceManifestHash: digest(record['evidenceManifestHash'], 'evidence manifest hash'),
    evaluatorVersion: identifier(record['evaluatorVersion'], 'evaluator version'),
    evaluatorModel,
    evaluatorRuntime: identifier(record['evaluatorRuntime'], 'evaluator runtime'),
    policyVersion: identifier(record['policyVersion'], 'policy version'),
  });
}

function reason(value: unknown): string | null {
  if (value === null) return null;
  return boundedText(value, 'review decision reason', MAX_REASON_BYTES);
}

function riskCodes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_RISK_CODES) {
    throw new TypeError('acknowledged risk codes must be a bounded array');
  }
  const codes = value.map((item) => identifier(item, 'acknowledged risk code'));
  if (codes.some((item, index) => index > 0 && codes[index - 1]! >= item)) {
    throw new TypeError('acknowledged risk codes must be sorted and unique');
  }
  return Object.freeze(codes);
}

function timestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) throw new TypeError('receipt timestamp is invalid');
  return value;
}

export function parseReviewDecisionRequestV1(value: unknown): Readonly<ReviewDecisionRequestV1> {
  const record = exactRecord(value, [
    'schema',
    'clientRequestId',
    'taskId',
    'projectionHash',
    'decisionBinding',
    'action',
    'reason',
    'acknowledgedRiskCodes',
  ], 'review decision request');
  if (record['schema'] !== 'hercules-review-decision-request/v1') {
    throw new TypeError('review decision request schema is invalid');
  }
  const parsed = Object.freeze({
    schema: 'hercules-review-decision-request/v1',
    clientRequestId: identifier(record['clientRequestId'], 'client request id'),
    taskId: identifier(record['taskId'], 'task id'),
    projectionHash: digest(record['projectionHash'], 'projection hash'),
    decisionBinding: decisionBinding(record['decisionBinding']),
    action: action(record['action']),
    reason: reason(record['reason']),
    acknowledgedRiskCodes: riskCodes(record['acknowledgedRiskCodes']),
  });
  if (parsed.decisionBinding.taskId !== parsed.taskId) {
    throw new TypeError('review decision task and binding do not match');
  }
  return parsed;
}

export function snapshotReviewDecisionReceiptV1(value: unknown): Readonly<ReviewDecisionReceiptV1> {
  const record = exactRecord(value, [
    'schema',
    'clientRequestId',
    'requestHash',
    'taskId',
    'actor',
    'acceptedProjectionHash',
    'acceptedDecisionBindingHash',
    'action',
    'humanDecisionId',
    'eventId',
    'priorIterationId',
    'resultingIterationId',
    'recordedAt',
    'receiptHash',
  ], 'review decision receipt');
  if (record['schema'] !== 'hercules-review-decision-receipt/v1') {
    throw new TypeError('review decision receipt schema is invalid');
  }
  const body = {
    schema: 'hercules-review-decision-receipt/v1' as const,
    clientRequestId: identifier(record['clientRequestId'], 'receipt client request id'),
    requestHash: digest(record['requestHash'], 'receipt request hash'),
    taskId: identifier(record['taskId'], 'receipt task id'),
    actor: snapshotReviewActorV1(record['actor']),
    acceptedProjectionHash: digest(record['acceptedProjectionHash'], 'accepted projection hash'),
    acceptedDecisionBindingHash: digest(record['acceptedDecisionBindingHash'], 'accepted binding hash'),
    action: action(record['action']),
    humanDecisionId: identifier(record['humanDecisionId'], 'human decision id'),
    eventId: identifier(record['eventId'], 'decision event id'),
    priorIterationId: identifier(record['priorIterationId'], 'prior iteration id'),
    resultingIterationId: identifier(record['resultingIterationId'], 'resulting iteration id'),
    recordedAt: timestamp(record['recordedAt']),
  };
  const receiptHash = digest(record['receiptHash'], 'receipt hash');
  if (hashCanonicalJson(body) !== receiptHash) {
    throw new TypeError('review decision receipt hash is invalid');
  }
  return Object.freeze({ ...body, receiptHash });
}

export function snapshotReviewDecisionResponseV1(value: unknown): Readonly<ReviewDecisionResponseV1> {
  const record = exactRecord(
    value,
    ['schema', 'receipt', 'duplicate'],
    'review decision response',
  );
  if (
    record['schema'] !== 'hercules-review-decision-response/v1' ||
    typeof record['duplicate'] !== 'boolean'
  ) throw new TypeError('review decision response is invalid');
  return Object.freeze({
    schema: 'hercules-review-decision-response/v1',
    receipt: snapshotReviewDecisionReceiptV1(record['receipt']),
    duplicate: record['duplicate'],
  });
}

export function reviewDecisionIdempotencyKey(
  actor: ReviewActorV1,
  request: ReviewDecisionRequestV1,
): Readonly<ReviewDecisionIdempotencyKeyV1> {
  const trustedActor = snapshotReviewActorV1(actor);
  return Object.freeze({
    actorIssuer: trustedActor.issuer,
    actorId: trustedActor.id,
    taskId: request.taskId,
    clientRequestId: request.clientRequestId,
  });
}

export function assertReviewDecisionReceiptMatches(input: Readonly<{
  request: ReviewDecisionRequestV1;
  requestHash: string;
  actor: ReviewActorV1;
  receipt: unknown;
}>): Readonly<ReviewDecisionReceiptV1> {
  const receipt = snapshotReviewDecisionReceiptV1(input.receipt);
  const actor = snapshotReviewActorV1(input.actor);
  const bindingHash = reviewDecisionBindingHash(input.request.decisionBinding);
  const priorIterationId = input.request.decisionBinding.iterationId;
  if (
    priorIterationId === null ||
    receipt.clientRequestId !== input.request.clientRequestId ||
    receipt.requestHash !== input.requestHash ||
    receipt.taskId !== input.request.taskId ||
    receipt.actor.kind !== actor.kind ||
    receipt.actor.id !== actor.id ||
    receipt.actor.issuer !== actor.issuer ||
    receipt.acceptedProjectionHash !== input.request.projectionHash ||
    receipt.acceptedDecisionBindingHash !== bindingHash ||
    receipt.action !== input.request.action ||
    receipt.priorIterationId !== priorIterationId ||
    (input.request.action === 'request_changes'
      ? receipt.resultingIterationId === priorIterationId
      : receipt.resultingIterationId !== priorIterationId)
  ) throw new TypeError('review decision receipt does not match the accepted command');
  return receipt;
}

export function reviewDecisionRequestHash(request: ReviewDecisionRequestV1): string {
  return hashCanonicalJson(request);
}

export function reviewDecisionBindingHash(binding: DecisionBinding): string {
  return hashCanonicalJson(binding);
}

export function reviewDecisionReceiptHash(
  receipt: Omit<ReviewDecisionReceiptV1, 'receiptHash'>,
): string {
  return hashCanonicalJson(receipt);
}
