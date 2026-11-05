/**
 * Production Control API V2 provider — three sync ports over ControlStateStore.
 * Imports the ControlStateStore interface only; never the concrete SQLite module,
 * the pure engine layer, HTTP server, or isolation fakes.
 */

import { canonicalClone } from '../domain/canonicalJson.js';
import {
  assertControlEventView,
  ControlApiV2Error,
  MAX_EVENT_PAGE,
  type AdmissionLedgerEntryV1,
  type AdmissionVerdictV1,
  type ControlApiV2MutatorPortV1,
  type ControlApiV2ReaderPortV1,
  type ControlApiV2ReadsV1,
  type ControlApiV2ReceiptV1,
  type ControlApiV2RequestV1,
  type ControlEventReadPortV1,
  type ControlEventView,
  type EventCursorRequestV1,
} from '../domain/controlApiV2.js';
import type { ControlEvent } from '../domain/controlEvent.js';
import type { ReviewPackageV2 } from '../domain/reviewPackageV2.js';
import type { ControlStateStore } from './state/stateStore.js';

export const CONTROL_API_V2_AUTHORITY_ENV = 'HERCULES_CONTROL_API_V2_AUTHORITY' as const;

export interface ControlApiV2ProviderDeps {
  readonly controlApiV2Reader: ControlApiV2ReaderPortV1;
  readonly controlApiV2Mutator: ControlApiV2MutatorPortV1;
  readonly controlApiV2Events: ControlEventReadPortV1;
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

class ControlApiV2Provider
  implements ControlApiV2ReaderPortV1, ControlApiV2MutatorPortV1, ControlEventReadPortV1
{
  readonly #store: ControlStateStore;

  constructor(store: ControlStateStore) {
    this.#store = store;
  }

  readEvents(
    afterSequence: number,
    limit: number,
  ): { readonly events: readonly ControlEventView[]; readonly hasMore: boolean } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_PAGE) {
      throw new RangeError(`event limit must be in 1..${MAX_EVENT_PAGE}`);
    }
    const events = this.#store.readEvents(afterSequence, limit).map(toEventView);
    if (events.length === 0) {
      return { events, hasMore: false };
    }
    const hasMore =
      events.length === limit &&
      this.#store.readEvents(events[events.length - 1]!.sequence, 1).length > 0;
    return { events, hasMore };
  }

  read(request: ControlApiV2RequestV1): ControlApiV2ReadsV1 {
    const admissionLedger: readonly AdmissionLedgerEntryV1[] =
      request.idempotencyKey === null
        ? []
        : (() => {
            const entry = this.#store.readV2AdmissionLedgerEntry(
              request.idempotencyKey.keyHash,
            );
            return entry === null ? [] : [entry];
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

    const row = this.#store.readV2Aggregate(request.aggregateId);
    // Unprojectable aggregates are NOT served — engine unknown_aggregate → 404 is
    // the contract's "historical attempts>0 task → 404 + legacy fallback".
    if (row === null || row.projectionState !== 'projected') {
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

    const includeReview =
      request.resource === 'review' ||
      (request.resource === 'decision' && request.operation === 'submit');
    const includeStatusFields = request.resource === 'status';
    const reviewPackage =
      row.reviewPackage === null
        ? null
        : (canonicalClone(row.reviewPackage) as ReviewPackageV2);

    return cloneReads({
      aggregateExists: true,
      currentStateVersion: row.stateVersion,
      taskStatus: includeStatusFields ? row.taskStatus : null,
      // Aggregate-scoped: chain sequence of this aggregate's latest V2 event.
      latestEventSequence: includeStatusFields ? row.updatedAtSequence : null,
      freshProjectionHash: row.projectionHash,
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
    if (request.resource === 'task' && request.operation === 'create') {
      throw new ControlApiV2Error(
        'provider_unavailable',
        'V2 task create is not served by this program; tasks are created through the legacy control repo',
      );
    }
    return this.#store.commitV2(request, verdict);
  }
}

/** The production provider: three sync ports over the store. */
export function createControlApiV2Provider(store: ControlStateStore): ControlApiV2ProviderDeps {
  const provider = new ControlApiV2Provider(store);
  return Object.freeze({
    controlApiV2Reader: provider,
    controlApiV2Mutator: provider,
    controlApiV2Events: provider,
  });
}

/**
 * Composition-root helper (the ONLY thing main.ts calls). Returns the three deps
 * iff `env[CONTROL_API_V2_AUTHORITY_ENV] === '1'` AND `store !== null`; otherwise `{}`.
 */
export function openControlApiV2Deps(input: {
  readonly store: ControlStateStore | null;
  readonly env: NodeJS.ProcessEnv;
  readonly log: (line: string) => void;
}): ControlApiV2ProviderDeps | Record<string, never> {
  const enabled = input.env[CONTROL_API_V2_AUTHORITY_ENV] === '1';
  if (enabled && input.store === null) {
    input.log(
      '[hercules] HERCULES_CONTROL_API_V2_AUTHORITY=1 but the V2 store is not configured (HERCULES_V2_SHADOW_ROOT/HERCULES_V2_SHADOW_DATABASE unset) — /api/v2/control routes stay 503 provider_unavailable',
    );
    return {};
  }
  if (!enabled) {
    if (input.store !== null) {
      input.log(
        '[hercules] control API v2 authority off (set HERCULES_CONTROL_API_V2_AUTHORITY=1 to serve /api/v2/control routes from the V2 store)',
      );
    }
    return {};
  }
  input.log(
    '[hercules] control API v2 authority ON: /api/v2/control routes served from the V2 store',
  );
  return createControlApiV2Provider(input.store!);
}
