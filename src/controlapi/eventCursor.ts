/**
 * M11 Control API V2 — pure resumable global-stream event-cursor decision.
 *
 * Consumes the already-read global suffix (`events` + `eventsHasMore`); never
 * touches a store. Imports only `src/domain/*`.
 */

import type { ControlEventView } from '../domain/controlApiV2.js';

/** Closed event-cursor outcomes over a trusted global suffix. */
export type EventCursorDecisionV1 =
  | { readonly kind: 'broken_event_chain' }
  | {
      readonly kind: 'page';
      readonly events: readonly ControlEventView[];
      readonly nextAfterSequence: number;
      readonly endOfStream: boolean;
    };

/**
 * Verify the resume link + intra-page chain, then emit the page fields.
 *
 * - `afterSequence > 0` and first event's `previousEventHash` ≠ expected → broken.
 * - Any adjacent pair failing `events[i].eventHash === events[i+1].previousEventHash`
 *   → broken.
 * - Empty page: `nextAfterSequence = afterSequence`; non-empty: last sequence.
 * - `endOfStream = !eventsHasMore`.
 */
export function decideEventCursor(input: {
  readonly afterSequence: number;
  readonly expectedPreviousEventHash: string | null;
  readonly events: readonly ControlEventView[];
  readonly eventsHasMore: boolean;
}): EventCursorDecisionV1 {
  const { afterSequence, expectedPreviousEventHash, events, eventsHasMore } =
    input;

  if (afterSequence > 0 && events.length > 0) {
    const first = events[0];
    if (
      first === undefined ||
      first.previousEventHash !== expectedPreviousEventHash
    ) {
      return { kind: 'broken_event_chain' };
    }
  }

  for (let index = 0; index + 1 < events.length; index += 1) {
    const current = events[index];
    const next = events[index + 1];
    if (
      current === undefined ||
      next === undefined ||
      current.eventHash !== next.previousEventHash
    ) {
      return { kind: 'broken_event_chain' };
    }
  }

  if (events.length === 0) {
    return {
      kind: 'page',
      events,
      nextAfterSequence: afterSequence,
      endOfStream: !eventsHasMore,
    };
  }

  const last = events[events.length - 1];
  if (last === undefined) {
    return { kind: 'broken_event_chain' };
  }
  return {
    kind: 'page',
    events,
    nextAfterSequence: last.sequence,
    endOfStream: !eventsHasMore,
  };
}
