import { canonicalClone, canonicalSerialize, hashCanonicalJson } from './canonicalJson.js';
import {
  assertDecisionBindingIdentity,
  type DecisionBinding,
} from './evaluationVerdict.js';
import type { M6OutcomeDecision } from './reviewPackageV2.js';
import { ACTOR_KINDS, type ActorRef } from './taskContract.js';
import { isNonEmptyString, isRecord } from './v2Invariant.js';
import {
  isV2TaskStatus,
  type V2TaskStatus,
} from './v2TaskStatus.js';

export const CONTROL_EVENT_TYPES = [
  'ShadowContractRootProjected',
  'ShadowContractSuccessorProjected',
  'ShadowIterationProjectionCommitted',
  'ShadowStageRunProjectionCommitted',
  'ShadowTaskRetired',
  'ArtifactCaptureAuthorized',
  'ArtifactMetadataRecorded',
  'EvidenceManifestRecorded',
  'ArtifactMetadataRetired',
  'V2AggregateMaterialized',
  'V2AggregateRefreshed',
  'V2DecisionCommitted',
  'V2EvidenceBound',
  'V2EvaluationBound',
] as const;

export type ControlEventType = (typeof CONTROL_EVENT_TYPES)[number];

export const CONTROL_EVENT_AGGREGATES = [
  'task',
  'iteration',
  'stage_run',
  'artifact_authorization',
  'artifact_ref',
  'evidence_manifest',
] as const;
export type ControlEventAggregate = (typeof CONTROL_EVENT_AGGREGATES)[number];

export interface ControlEventMetadata {
  readonly eventId: string;
  readonly actor: ActorRef;
  readonly occurredAt: string;
}

export interface ControlEvent {
  readonly sequence: number;
  readonly eventId: string;
  readonly eventType: ControlEventType;
  readonly aggregateKind: ControlEventAggregate;
  readonly aggregateId: string;
  readonly actor: ActorRef;
  readonly occurredAt: string;
  readonly payload: unknown;
  readonly previousEventHash: string | null;
  readonly eventHash: string;
}

export class ControlEventError extends Error {
  override readonly name = 'ControlEventError';
}

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const MAX_TEXT = 512;

function fail(message: string): never {
  throw new ControlEventError(message);
}

function exactKeys(value: Readonly<Record<PropertyKey, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validText(value: unknown): value is string {
  return isNonEmptyString(value) && value.length <= MAX_TEXT;
}

export function assertControlEventMetadata(value: unknown): asserts value is ControlEventMetadata {
  canonicalSerialize(value);
  if (!isRecord(value) || !exactKeys(value, ['eventId', 'actor', 'occurredAt'])) {
    fail('event metadata must use the exact public schema');
  }
  if (!validText(value['eventId']) || !validText(value['occurredAt'])) {
    fail('event metadata identity and timestamp must be bounded non-empty strings');
  }
  const actor = value['actor'];
  if (
    !isRecord(actor) ||
    !exactKeys(actor, ['kind', 'id']) ||
    !(ACTOR_KINDS as readonly unknown[]).includes(actor['kind']) ||
    !validText(actor['id'])
  ) {
    fail('event actor is invalid');
  }
}

function eventHashInput(event: Omit<ControlEvent, 'eventHash'>): unknown {
  return {
    aggregateId: event.aggregateId,
    aggregateKind: event.aggregateKind,
    actor: event.actor,
    eventId: event.eventId,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    payload: event.payload,
    previousEventHash: event.previousEventHash,
    sequence: event.sequence,
  };
}

export function buildControlEvent(
  input: Omit<ControlEvent, 'eventHash'>,
): ControlEvent {
  assertControlEventMetadata({
    eventId: input.eventId,
    actor: input.actor,
    occurredAt: input.occurredAt,
  });
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    fail('event sequence must be a positive safe integer');
  }
  if (!(CONTROL_EVENT_TYPES as readonly unknown[]).includes(input.eventType)) {
    fail('event type is invalid');
  }
  if (!(CONTROL_EVENT_AGGREGATES as readonly unknown[]).includes(input.aggregateKind)) {
    fail('event aggregate kind is invalid');
  }
  if (!validText(input.aggregateId)) fail('event aggregate identity is invalid');
  if (input.previousEventHash !== null && !HASH_RE.test(input.previousEventHash)) {
    fail('previous event hash is invalid');
  }
  canonicalSerialize(input.payload);
  const detached = canonicalClone(input);
  return {
    ...detached,
    eventHash: hashCanonicalJson(eventHashInput(detached)),
  };
}

export function assertControlEvent(value: unknown): asserts value is ControlEvent {
  canonicalSerialize(value);
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'sequence',
      'eventId',
      'eventType',
      'aggregateKind',
      'aggregateId',
      'actor',
      'occurredAt',
      'payload',
      'previousEventHash',
      'eventHash',
    ])
  ) {
    fail('control event must use the exact schema');
  }
  const expected = buildControlEvent({
    sequence: value['sequence'] as number,
    eventId: value['eventId'] as string,
    eventType: value['eventType'] as ControlEventType,
    aggregateKind: value['aggregateKind'] as ControlEventAggregate,
    aggregateId: value['aggregateId'] as string,
    actor: value['actor'] as ActorRef,
    occurredAt: value['occurredAt'] as string,
    payload: value['payload'],
    previousEventHash: value['previousEventHash'] as string | null,
  });
  if (value['eventHash'] !== expected.eventHash || !HASH_RE.test(expected.eventHash)) {
    fail('control event hash does not match canonical event fields');
  }
}

export const V2_CONTROL_EVENT_TYPES = [
  'V2AggregateMaterialized',
  'V2AggregateRefreshed',
  'V2DecisionCommitted',
  'V2EvidenceBound',
  'V2EvaluationBound',
] as const;
export type V2ControlEventType = (typeof V2_CONTROL_EVENT_TYPES)[number];

/** V2 events that participate in the aggregate state_version chain. */
export const V2_VERSIONED_EVENT_TYPES = [
  'V2AggregateMaterialized',
  'V2AggregateRefreshed',
  'V2DecisionCommitted',
] as const;
export type V2VersionedEventType = (typeof V2_VERSIONED_EVENT_TYPES)[number];

/** V2 bind events that pair with review-truth rows (do not bump state_version). */
export const V2_BIND_EVENT_TYPES = [
  'V2EvidenceBound',
  'V2EvaluationBound',
] as const;
export type V2BindEventType = (typeof V2_BIND_EVENT_TYPES)[number];

export const V2_PROJECTION_STATES = ['projected', 'unprojectable'] as const;
export type V2ProjectionState = (typeof V2_PROJECTION_STATES)[number];

export const V2_UNPROJECTABLE_REASONS = [
  'empty_iteration_history',
  'missing_contract',
  'invalid_source',
  'invalid_package',
] as const;
export type V2UnprojectableReason = (typeof V2_UNPROJECTABLE_REASONS)[number];

const V2_AGGREGATE_EVENT_KEYS = [
  'kind',
  'stateVersion',
  'taskStatus',
  'projectionState',
  'projectionHash',
  'unprojectableReason',
] as const;

const V2_DECISION_COMMITTED_KEYS = [
  'kind',
  'stateVersion',
  'decisionId',
  'keyHash',
  'requestHash',
  'action',
  'actor',
  'actorIssuer',
  'reason',
  'decidedAt',
  'binding',
  'acknowledgedRiskCodes',
] as const;

const V2_EVIDENCE_BOUND_KEYS = [
  'kind',
  'iterationId',
  'manifestId',
  'manifestHash',
  'evidenceHash',
] as const;

const V2_EVALUATION_BOUND_KEYS = [
  'kind',
  'iterationId',
  'receiptId',
  'evidenceHash',
  'evaluationHash',
] as const;

const M6_OUTCOME_DECISIONS = [
  'approve_outcome',
  'reject_outcome',
  'request_changes',
] as const satisfies readonly M6OutcomeDecision[];

const DECISION_BINDING_KEYS = [
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
] as const;

/** Payload of V2AggregateMaterialized and V2AggregateRefreshed (exact keys). */
export interface V2AggregateEventPayload {
  readonly kind: 'v2-aggregate';
  readonly stateVersion: number;
  readonly taskStatus: V2TaskStatus;
  readonly projectionState: V2ProjectionState;
  readonly projectionHash: string | null;
  readonly unprojectableReason: V2UnprojectableReason | null;
}

/** Payload of V2DecisionCommitted (exact keys) — the FULL reconstructible human decision. */
export interface V2DecisionCommittedPayload {
  readonly kind: 'v2-decision';
  readonly stateVersion: number;
  readonly decisionId: string;
  readonly keyHash: string;
  readonly requestHash: string;
  readonly action: M6OutcomeDecision;
  readonly actor: { readonly kind: 'human'; readonly id: string };
  readonly actorIssuer: string;
  readonly reason: string;
  readonly decidedAt: string;
  readonly binding: DecisionBinding;
  /**
   * Operator attestation from the decision request (sorted-unique NFC), including
   * structured risk codes and `human:<criterionId>` codes for human-axis criteria.
   */
  readonly acknowledgedRiskCodes: readonly string[];
}

/** Payload of V2EvidenceBound (exact keys). */
export interface V2EvidenceBoundPayload {
  readonly kind: 'v2-evidence-bound';
  readonly iterationId: string;
  readonly manifestId: string;
  readonly manifestHash: string;
  readonly evidenceHash: string;
}

/** Payload of V2EvaluationBound (exact keys). */
export interface V2EvaluationBoundPayload {
  readonly kind: 'v2-evaluation-bound';
  readonly iterationId: string;
  readonly receiptId: string;
  readonly evidenceHash: string;
  readonly evaluationHash: string;
}

export function assertV2AggregateEventPayload(
  value: unknown,
): asserts value is V2AggregateEventPayload {
  canonicalSerialize(value);
  if (!isRecord(value) || !exactKeys(value, V2_AGGREGATE_EVENT_KEYS)) {
    fail('V2 aggregate event payload must use the exact schema');
  }
  if (value['kind'] !== 'v2-aggregate') {
    fail('V2 aggregate event payload kind must be v2-aggregate');
  }
  const stateVersion = value['stateVersion'];
  if (!Number.isSafeInteger(stateVersion) || (stateVersion as number) < 1) {
    fail('V2 aggregate event stateVersion must be a safe integer >= 1');
  }
  if (!isV2TaskStatus(value['taskStatus'])) {
    fail('V2 aggregate event taskStatus is invalid');
  }
  if (!(V2_PROJECTION_STATES as readonly unknown[]).includes(value['projectionState'])) {
    fail('V2 aggregate event projectionState is invalid');
  }
  const projectionState = value['projectionState'] as V2ProjectionState;
  const projectionHash = value['projectionHash'];
  const unprojectableReason = value['unprojectableReason'];
  if (projectionState === 'projected') {
    if (typeof projectionHash !== 'string' || !HASH_RE.test(projectionHash)) {
      fail('V2 aggregate projected payload requires a valid projectionHash');
    }
    if (unprojectableReason !== null) {
      fail('V2 aggregate projected payload must have null unprojectableReason');
    }
  } else {
    if (projectionHash !== null) {
      fail('V2 aggregate unprojectable payload must have null projectionHash');
    }
    if (!(V2_UNPROJECTABLE_REASONS as readonly unknown[]).includes(unprojectableReason)) {
      fail('V2 aggregate unprojectable payload requires a closed unprojectableReason');
    }
  }
}

export function assertV2DecisionCommittedPayload(
  value: unknown,
): asserts value is V2DecisionCommittedPayload {
  canonicalSerialize(value);
  if (!isRecord(value) || !exactKeys(value, V2_DECISION_COMMITTED_KEYS)) {
    fail('V2 decision committed payload must use the exact schema');
  }
  if (value['kind'] !== 'v2-decision') {
    fail('V2 decision committed payload kind must be v2-decision');
  }
  const stateVersion = value['stateVersion'];
  if (!Number.isSafeInteger(stateVersion) || (stateVersion as number) < 1) {
    fail('V2 decision committed stateVersion must be a safe integer >= 1');
  }
  const keyHash = value['keyHash'];
  const requestHash = value['requestHash'];
  if (typeof keyHash !== 'string' || !HASH_RE.test(keyHash)) {
    fail('V2 decision committed keyHash is invalid');
  }
  if (typeof requestHash !== 'string' || !HASH_RE.test(requestHash)) {
    fail('V2 decision committed requestHash is invalid');
  }
  const decisionId = value['decisionId'];
  const expectedDecisionId = `decision-${(keyHash as string).slice('sha256:'.length)}`;
  if (typeof decisionId !== 'string' || decisionId !== expectedDecisionId) {
    fail('V2 decision committed decisionId must be decision-${keyHash hex64}');
  }
  if (!(M6_OUTCOME_DECISIONS as readonly unknown[]).includes(value['action'])) {
    fail('V2 decision committed action must be a closed M6OutcomeDecision');
  }
  const actor = value['actor'];
  if (
    !isRecord(actor) ||
    !exactKeys(actor, ['kind', 'id']) ||
    actor['kind'] !== 'human' ||
    !validText(actor['id'])
  ) {
    fail('V2 decision committed actor must be {kind:human,id}');
  }
  if (!validText(value['actorIssuer']) || !validText(value['reason']) || !validText(value['decidedAt'])) {
    fail('V2 decision committed actorIssuer, reason, and decidedAt must be bounded non-empty strings');
  }
  const binding = value['binding'];
  if (!isRecord(binding) || !exactKeys(binding, DECISION_BINDING_KEYS)) {
    fail('V2 decision committed binding must use the exact DecisionBinding schema');
  }
  assertDecisionBindingIdentity(binding as unknown as DecisionBinding);
  const acknowledgedRiskCodes = value['acknowledgedRiskCodes'];
  if (!Array.isArray(acknowledgedRiskCodes)) {
    fail('V2 decision committed acknowledgedRiskCodes must be an array');
  }
  for (let index = 0; index < acknowledgedRiskCodes.length; index += 1) {
    if (!(index in acknowledgedRiskCodes) || !validText(acknowledgedRiskCodes[index])) {
      fail('V2 decision committed acknowledgedRiskCodes entries must be bounded non-empty strings');
    }
  }
  const normalized = acknowledgedRiskCodes.map((code) => (code as string).normalize('NFC'));
  const sortedUnique = [...new Set(normalized)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (
    acknowledgedRiskCodes.length !== sortedUnique.length ||
    acknowledgedRiskCodes.some((code, index) => code !== sortedUnique[index])
  ) {
    fail('V2 decision committed acknowledgedRiskCodes must be sorted-unique NFC');
  }
}

export function assertV2EvidenceBoundPayload(
  value: unknown,
): asserts value is V2EvidenceBoundPayload {
  canonicalSerialize(value);
  if (!isRecord(value) || !exactKeys(value, V2_EVIDENCE_BOUND_KEYS)) {
    fail('V2 evidence bound payload must use the exact schema');
  }
  if (value['kind'] !== 'v2-evidence-bound') {
    fail('V2 evidence bound payload kind must be v2-evidence-bound');
  }
  if (!validText(value['iterationId']) || !validText(value['manifestId'])) {
    fail('V2 evidence bound iterationId and manifestId must be bounded non-empty strings');
  }
  const manifestHash = value['manifestHash'];
  const evidenceHash = value['evidenceHash'];
  if (typeof manifestHash !== 'string' || !HASH_RE.test(manifestHash)) {
    fail('V2 evidence bound manifestHash is invalid');
  }
  if (typeof evidenceHash !== 'string' || !HASH_RE.test(evidenceHash)) {
    fail('V2 evidence bound evidenceHash is invalid');
  }
}

export function assertV2EvaluationBoundPayload(
  value: unknown,
): asserts value is V2EvaluationBoundPayload {
  canonicalSerialize(value);
  if (!isRecord(value) || !exactKeys(value, V2_EVALUATION_BOUND_KEYS)) {
    fail('V2 evaluation bound payload must use the exact schema');
  }
  if (value['kind'] !== 'v2-evaluation-bound') {
    fail('V2 evaluation bound payload kind must be v2-evaluation-bound');
  }
  if (!validText(value['iterationId']) || !validText(value['receiptId'])) {
    fail('V2 evaluation bound iterationId and receiptId must be bounded non-empty strings');
  }
  const evidenceHash = value['evidenceHash'];
  const evaluationHash = value['evaluationHash'];
  if (typeof evidenceHash !== 'string' || !HASH_RE.test(evidenceHash)) {
    fail('V2 evaluation bound evidenceHash is invalid');
  }
  if (typeof evaluationHash !== 'string' || !HASH_RE.test(evaluationHash)) {
    fail('V2 evaluation bound evaluationHash is invalid');
  }
}
