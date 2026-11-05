/**
 * Isolated, fake-only, deterministic Control API V2 provider.
 * Implements the reader / mutator / event-read ports in memory.
 * Never imports the concrete SQLite state store, the pure engine layer, or
 * test fixtures — a self-contained in-memory provider for isolated runs.
 */

import { canonicalClone } from '../domain/canonicalJson.js';
import {
  assertAdmissionLedgerEntryV1,
  assertControlApiV2ReceiptV1,
  assertControlEventView,
  computeReceiptHash,
  deriveAggregateId,
  type AdmissionLedgerEntryV1,
  type AdmissionVerdictV1,
  type ControlApiV2MutatorPortV1,
  type ControlApiV2ReaderPortV1,
  type ControlApiV2ReadsV1,
  type ControlApiV2ReceiptV1,
  type ControlApiV2RequestV1,
  type ControlEventReadPortV1,
  type ControlEventView,
  type DecisionPayloadV1,
  type EventCursorRequestV1,
  type ReceiptRefusalReasonV1,
} from '../domain/controlApiV2.js';
import {
  assertControlEvent,
  assertV2AggregateEventPayload,
  assertV2DecisionCommittedPayload,
  buildControlEvent,
  type ControlEvent,
  type V2AggregateEventPayload,
  type V2DecisionCommittedPayload,
} from '../domain/controlEvent.js';
import type { HumanDecision } from '../domain/humanDecision.js';
import type { ReviewPackageV2, ReviewPackageV2Source } from '../domain/reviewPackageV2.js';
import type { V2TaskStatus } from '../domain/v2TaskStatus.js';
import {
  buildEligibleControlApiV2ReviewSource,
  buildIneligibleControlApiV2ReviewSource,
  CONTROL_API_V2_ELIGIBLE_SEED_TASK_ID,
  CONTROL_API_V2_INELIGIBLE_SEED_TASK_ID,
  projectControlApiV2ReviewSource,
} from './controlApiV2ReviewSeed.js';

const DEFAULT_SEED_TASK_IDS: readonly string[] = [
  CONTROL_API_V2_ELIGIBLE_SEED_TASK_ID,
  CONTROL_API_V2_INELIGIBLE_SEED_TASK_ID,
];

const DEFAULT_NOW = (): string => '2026-08-31T12:00:00.000Z';

export interface IsolatedControlApiV2Deps {
  readonly controlApiV2Reader: ControlApiV2ReaderPortV1;
  readonly controlApiV2Mutator: ControlApiV2MutatorPortV1;
  readonly controlApiV2Events: ControlEventReadPortV1;
}

export interface OpenIsolatedControlApiV2DepsOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => string;
  readonly seedTaskIds?: readonly string[];
}

interface AggregateState {
  stateVersion: number;
  taskStatus: V2TaskStatus;
  reviewPackage: ReviewPackageV2;
  source: ReviewPackageV2Source;
}

function isolationFlagEnabled(env: NodeJS.ProcessEnv | undefined): boolean {
  // Same multi-guard as the M7 fake provider: the fake is constructible ONLY in
  // the exact isolated L2 harness, never in production, however the env is set.
  return (
    env?.['HERCULES_ADAPTER'] === 'fake' &&
    env?.['HERCULES_FAKE_FAULT_INJECTION'] === '1' &&
    env?.['HERCULES_L2_ISOLATED'] === '1'
  );
}

function toEventView(event: ControlEvent): ControlEventView {
  const view: ControlEventView = {
    sequence: event.sequence,
    eventId: event.eventId,
    eventType: event.eventType,
    aggregateKind: event.aggregateKind,
    aggregateId: event.aggregateId,
    previousEventHash: event.previousEventHash,
    eventHash: event.eventHash,
  };
  assertControlEventView(view);
  return view;
}

function cloneReads(reads: ControlApiV2ReadsV1): ControlApiV2ReadsV1 {
  return canonicalClone(reads) as ControlApiV2ReadsV1;
}

function seedSource(taskId: string): ReviewPackageV2Source {
  if (taskId === CONTROL_API_V2_INELIGIBLE_SEED_TASK_ID) {
    return buildIneligibleControlApiV2ReviewSource(taskId);
  }
  return buildEligibleControlApiV2ReviewSource(taskId);
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

function buildCommittedReceipt(input: {
  readonly resource: 'task' | 'decision';
  readonly aggregateId: string;
  readonly keyHash: string;
  readonly requestHash: string;
  readonly stateVersion: number;
  readonly eventSequence: number;
  readonly decidedAt: string;
}): ControlApiV2ReceiptV1 {
  const withoutHash: Omit<ControlApiV2ReceiptV1, 'receiptHash'> = {
    schema: 'hercules-control-api-receipt/v2',
    outcome: 'committed',
    resource: input.resource,
    aggregateId: input.aggregateId,
    keyHash: input.keyHash,
    requestHash: input.requestHash,
    stateVersion: input.stateVersion,
    eventSequence: input.eventSequence,
    reason: null,
    decidedAt: input.decidedAt,
  };
  const receipt: ControlApiV2ReceiptV1 = {
    ...withoutHash,
    receiptHash: computeReceiptHash(withoutHash),
  };
  assertControlApiV2ReceiptV1(receipt);
  return receipt;
}

class IsolatedControlApiV2Provider
  implements ControlApiV2ReaderPortV1, ControlApiV2MutatorPortV1, ControlEventReadPortV1
{
  readonly #now: () => string;
  readonly #ledger = new Map<string, AdmissionLedgerEntryV1>();
  readonly #events: ControlEvent[] = [];
  readonly #aggregates = new Map<string, AggregateState>();

  constructor(now: () => string, seedTaskIds: readonly string[]) {
    this.#now = now;
    const seedOccurredAt = this.#now();
    for (const taskId of seedTaskIds) {
      const source = seedSource(taskId);
      const reviewPackage = projectControlApiV2ReviewSource(source);
      const payload: V2AggregateEventPayload = {
        kind: 'v2-aggregate',
        stateVersion: 1,
        taskStatus: 'review',
        projectionState: 'projected',
        projectionHash: reviewPackage.projectionHash,
        unprojectableReason: null,
      };
      assertV2AggregateEventPayload(payload);
      this.#appendEvent({
        eventType: 'V2AggregateMaterialized',
        aggregateId: taskId,
        actor: { kind: 'control_plane', id: 'v2-aggregate-projection' },
        occurredAt: seedOccurredAt,
        eventId: `v2-${taskId}-1`,
        payload,
      });
      this.#aggregates.set(taskId, {
        stateVersion: 1,
        taskStatus: 'review',
        reviewPackage,
        source,
      });
    }
  }

  #appendEvent(input: {
    readonly eventType: 'V2AggregateMaterialized' | 'V2AggregateRefreshed' | 'V2DecisionCommitted';
    readonly aggregateId: string;
    readonly actor: ControlEvent['actor'];
    readonly occurredAt: string;
    readonly eventId: string;
    readonly payload: V2AggregateEventPayload | V2DecisionCommittedPayload;
  }): ControlEvent {
    const previous = this.#events[this.#events.length - 1];
    const nextSequence = previous === undefined ? 1 : previous.sequence + 1;
    const previousEventHash = previous === undefined ? null : previous.eventHash;
    const event = buildControlEvent({
      sequence: nextSequence,
      eventId: input.eventId,
      eventType: input.eventType,
      aggregateKind: 'task',
      aggregateId: input.aggregateId,
      actor: input.actor,
      occurredAt: input.occurredAt,
      payload: input.payload,
      previousEventHash,
    });
    assertControlEvent(event);
    this.#events.push(event);
    return event;
  }

  readEvents(
    afterSequence: number,
    limit: number,
  ): { readonly events: readonly ControlEventView[]; readonly hasMore: boolean } {
    const suffix = this.#events.filter((event) => event.sequence > afterSequence);
    const hasMore = suffix.length > limit;
    const page = suffix.slice(0, limit).map(toEventView);
    return { events: page, hasMore };
  }

  read(request: ControlApiV2RequestV1): ControlApiV2ReadsV1 {
    const keyHash = request.idempotencyKey?.keyHash;
    const admissionLedger =
      keyHash === undefined
        ? []
        : (() => {
            const entry = this.#ledger.get(keyHash);
            return entry === undefined ? [] : [canonicalClone(entry) as AdmissionLedgerEntryV1];
          })();

    if (request.resource === 'event' && request.operation === 'read') {
      const cursor = request.payload as EventCursorRequestV1;
      const page = this.readEvents(cursor.afterSequence, cursor.limit);
      return cloneReads({
        aggregateExists: false,
        currentStateVersion: null,
        taskStatus: null,
        latestEventSequence: null,
        freshProjectionHash: null,
        reviewPackage: null,
        admissionLedger,
        events: page.events,
        eventsHasMore: page.hasMore,
      });
    }

    if (request.resource === 'task' && request.operation === 'create') {
      return cloneReads({
        aggregateExists: false,
        currentStateVersion: null,
        taskStatus: null,
        latestEventSequence: null,
        freshProjectionHash: null,
        reviewPackage: null,
        admissionLedger,
        events: null,
        eventsHasMore: false,
      });
    }

    const aggregateId = request.aggregateId;
    const aggregate = this.#aggregates.get(aggregateId);
    const aggregateExists = aggregate !== undefined;

    if (!aggregateExists) {
      return cloneReads({
        aggregateExists: false,
        currentStateVersion: null,
        taskStatus: null,
        latestEventSequence: null,
        freshProjectionHash: null,
        reviewPackage: null,
        admissionLedger,
        events: null,
        eventsHasMore: false,
      });
    }

    // Aggregate-scoped: sequence of this aggregate's latest event (not the global tail).
    let latestEventSequence = 0;
    for (let index = this.#events.length - 1; index >= 0; index -= 1) {
      if (this.#events[index]!.aggregateId === aggregateId) {
        latestEventSequence = this.#events[index]!.sequence;
        break;
      }
    }

    const reviewPackage = canonicalClone(aggregate.reviewPackage) as ReviewPackageV2;
    const includeReview =
      request.resource === 'review' ||
      (request.resource === 'decision' && request.operation === 'submit');
    const includeStatusFields = request.resource === 'status';

    return cloneReads({
      aggregateExists: true,
      currentStateVersion: aggregate.stateVersion,
      taskStatus: includeStatusFields ? aggregate.taskStatus : null,
      latestEventSequence: includeStatusFields ? latestEventSequence : null,
      freshProjectionHash: reviewPackage.projectionHash,
      reviewPackage: includeReview ? reviewPackage : null,
      admissionLedger,
      events: null,
      eventsHasMore: false,
    });
  }

  commit(
    request: ControlApiV2RequestV1,
    verdict: AdmissionVerdictV1,
  ): ControlApiV2ReceiptV1 {
    const isCreate = request.resource === 'task' && request.operation === 'create';
    if (isCreate) {
      return this.#commitCreate(request, verdict);
    }
    return this.#commitDecision(request, verdict);
  }

  #commitCreate(
    request: ControlApiV2RequestV1,
    verdict: AdmissionVerdictV1,
  ): ControlApiV2ReceiptV1 {
    const existing = this.#ledger.get(verdict.keyHash);
    if (existing !== undefined) {
      if (existing.requestHash === request.requestHash) {
        return canonicalClone(existing.receipt) as ControlApiV2ReceiptV1;
      }
      // Same key, different request: replay-with-hash-compare refuses (never ledgered).
      return buildRefusedReceipt({
        resource: 'task',
        aggregateId: verdict.aggregateId,
        keyHash: verdict.keyHash,
        requestHash: request.requestHash,
        reason: 'idempotency_conflict',
        decidedAt: verdict.decidedAt,
      });
    }

    const decidedAt = verdict.decidedAt;
    const aggregateId = verdict.aggregateId;
    if (this.#aggregates.has(aggregateId)) {
      throw new TypeError(
        `control api v2 fake provider: create aggregate ${aggregateId} already exists`,
      );
    }
    if (aggregateId !== deriveAggregateId(verdict.keyHash)) {
      throw new TypeError(
        'control api v2 fake provider: create aggregateId must equal deriveAggregateId(keyHash)',
      );
    }

    const source = buildEligibleControlApiV2ReviewSource(aggregateId);
    const reviewPackage = projectControlApiV2ReviewSource(source);
    const nextStateVersion = 1;
    const payload: V2AggregateEventPayload = {
      kind: 'v2-aggregate',
      stateVersion: nextStateVersion,
      taskStatus: 'todo',
      projectionState: 'projected',
      projectionHash: reviewPackage.projectionHash,
      unprojectableReason: null,
    };
    assertV2AggregateEventPayload(payload);
    const event = this.#appendEvent({
      eventType: 'V2AggregateMaterialized',
      aggregateId,
      actor: { kind: 'control_plane', id: 'v2-aggregate-projection' },
      occurredAt: decidedAt,
      eventId: `v2-${aggregateId}-1`,
      payload,
    });
    this.#aggregates.set(aggregateId, {
      stateVersion: nextStateVersion,
      taskStatus: 'todo',
      reviewPackage,
      source,
    });

    const receipt = buildCommittedReceipt({
      resource: 'task',
      aggregateId,
      keyHash: verdict.keyHash,
      requestHash: verdict.requestHash,
      stateVersion: nextStateVersion,
      eventSequence: event.sequence,
      decidedAt,
    });
    const entry: AdmissionLedgerEntryV1 = {
      keyHash: verdict.keyHash,
      requestHash: verdict.requestHash,
      receipt,
    };
    assertAdmissionLedgerEntryV1(entry);
    this.#ledger.set(verdict.keyHash, entry);
    return canonicalClone(receipt) as ControlApiV2ReceiptV1;
  }

  #commitDecision(
    request: ControlApiV2RequestV1,
    verdict: AdmissionVerdictV1,
  ): ControlApiV2ReceiptV1 {
    if (
      request.resource !== 'decision' ||
      request.operation !== 'submit' ||
      !('kind' in request.payload) ||
      request.payload.kind !== 'decision'
    ) {
      throw new TypeError('control api v2 fake provider: decision submit required');
    }
    if (request.idempotencyKey === null || request.concurrencyToken === null) {
      throw new TypeError('control api v2 fake provider: decision requires key and token');
    }

    const keyHash = request.idempotencyKey.keyHash;
    const existing = this.#ledger.get(keyHash);
    if (existing !== undefined) {
      if (existing.requestHash === request.requestHash) {
        return canonicalClone(existing.receipt) as ControlApiV2ReceiptV1;
      }
      return buildRefusedReceipt({
        resource: 'decision',
        aggregateId: request.aggregateId,
        keyHash,
        requestHash: request.requestHash,
        reason: 'idempotency_conflict',
        decidedAt: verdict.decidedAt,
      });
    }

    const aggregateId = verdict.aggregateId;
    const aggregate = this.#aggregates.get(aggregateId);
    if (aggregate === undefined) {
      throw new TypeError(
        `control api v2 fake provider: submit aggregate ${aggregateId} does not exist`,
      );
    }
    if (aggregate.stateVersion !== request.concurrencyToken.stateVersion) {
      return buildRefusedReceipt({
        resource: 'decision',
        aggregateId,
        keyHash,
        requestHash: request.requestHash,
        reason: 'stale_version',
        decidedAt: verdict.decidedAt,
      });
    }

    const binding = aggregate.reviewPackage.decisionBinding;
    if (binding === null) {
      throw new TypeError('control api v2 fake provider: decisionBinding is required');
    }

    const decisionPayload = request.payload as DecisionPayloadV1;
    const decidedAt = verdict.decidedAt;
    const stateVersion = aggregate.stateVersion + 1;
    const decisionId = `decision-${keyHash.slice('sha256:'.length)}`;
    const v2DecisionPayload: V2DecisionCommittedPayload = {
      kind: 'v2-decision',
      stateVersion,
      decisionId,
      keyHash,
      requestHash: request.requestHash,
      action: decisionPayload.action,
      actor: { kind: 'human', id: request.idempotencyKey.actorId },
      actorIssuer: request.idempotencyKey.actorIssuer,
      reason: decisionPayload.reason,
      decidedAt,
      binding,
      acknowledgedRiskCodes: decisionPayload.acknowledgedRiskCodes,
    };
    assertV2DecisionCommittedPayload(v2DecisionPayload);
    const decisionEvent = this.#appendEvent({
      eventType: 'V2DecisionCommitted',
      aggregateId,
      actor: { kind: 'human', id: request.idempotencyKey.actorId },
      occurredAt: decidedAt,
      eventId: `v2-${aggregateId}-${stateVersion}`,
      payload: v2DecisionPayload,
    });

    aggregate.stateVersion = stateVersion;

    const receipt = buildCommittedReceipt({
      resource: 'decision',
      aggregateId,
      keyHash,
      requestHash: request.requestHash,
      stateVersion,
      eventSequence: decisionEvent.sequence,
      decidedAt,
    });
    const entry: AdmissionLedgerEntryV1 = {
      keyHash,
      requestHash: request.requestHash,
      receipt,
    };
    assertAdmissionLedgerEntryV1(entry);
    this.#ledger.set(keyHash, entry);

    const rebuiltDecision: HumanDecision = {
      id: decisionId,
      binding,
      decision: decisionPayload.action,
      comment: decisionPayload.reason,
      actor: { kind: 'human', id: request.idempotencyKey.actorId },
      createdAt: decidedAt,
    };
    const refreshedSource: ReviewPackageV2Source = {
      ...aggregate.source,
      humanDecisions: [...aggregate.source.humanDecisions, rebuiltDecision],
      projectedAt: decidedAt,
    };
    const refreshedPackage = projectControlApiV2ReviewSource(refreshedSource);
    const refreshVersion = stateVersion + 1;
    const refreshPayload: V2AggregateEventPayload = {
      kind: 'v2-aggregate',
      stateVersion: refreshVersion,
      taskStatus: aggregate.taskStatus,
      projectionState: 'projected',
      projectionHash: refreshedPackage.projectionHash,
      unprojectableReason: null,
    };
    assertV2AggregateEventPayload(refreshPayload);
    this.#appendEvent({
      eventType: 'V2AggregateRefreshed',
      aggregateId,
      actor: { kind: 'control_plane', id: 'v2-aggregate-projection' },
      occurredAt: decidedAt,
      eventId: `v2-${aggregateId}-${refreshVersion}`,
      payload: refreshPayload,
    });
    aggregate.stateVersion = refreshVersion;
    aggregate.reviewPackage = refreshedPackage;
    aggregate.source = refreshedSource;

    return canonicalClone(receipt) as ControlApiV2ReceiptV1;
  }
}

/**
 * Opens the isolated fake Control API V2 ports when
 * the isolated L2 harness (HERCULES_ADAPTER=fake, HERCULES_FAKE_FAULT_INJECTION=1,
 * HERCULES_L2_ISOLATED=1). Returns `undefined` otherwise.
 */
export function openIsolatedControlApiV2Deps(
  opts: OpenIsolatedControlApiV2DepsOptions = {},
): IsolatedControlApiV2Deps | undefined {
  if (!isolationFlagEnabled(opts.env ?? process.env)) {
    return undefined;
  }
  const provider = new IsolatedControlApiV2Provider(
    opts.now ?? DEFAULT_NOW,
    opts.seedTaskIds ?? DEFAULT_SEED_TASK_IDS,
  );
  return Object.freeze({
    controlApiV2Reader: provider,
    controlApiV2Mutator: provider,
    controlApiV2Events: provider,
  });
}
