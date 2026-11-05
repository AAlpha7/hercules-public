import { describe, expect, it } from 'vitest';
import { decideEventCursor } from '../../src/controlapi/eventCursor.js';
import {
  assertControlEventView,
  type ControlEventView,
} from '../../src/domain/controlApiV2.js';

const HASH_A =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B =
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C =
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const HASH_D =
  'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';

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

describe('decideEventCursor', () => {
  it('returns a genesis page afterSequence=0 with null prev link', () => {
    const events = [
      controlEventView(),
      controlEventView({
        sequence: 2,
        eventId: 'evt-2',
        previousEventHash: HASH_A,
        eventHash: HASH_B,
      }),
    ];
    expect(
      decideEventCursor({
        afterSequence: 0,
        expectedPreviousEventHash: null,
        events,
        eventsHasMore: false,
      }),
    ).toEqual({
      kind: 'page',
      events,
      nextAfterSequence: 2,
      endOfStream: true,
    });
  });

  it('verifies the resume link when afterSequence > 0', () => {
    const events = [
      controlEventView({
        sequence: 3,
        eventId: 'evt-3',
        previousEventHash: HASH_B,
        eventHash: HASH_C,
      }),
    ];
    expect(
      decideEventCursor({
        afterSequence: 2,
        expectedPreviousEventHash: HASH_B,
        events,
        eventsHasMore: true,
      }),
    ).toEqual({
      kind: 'page',
      events,
      nextAfterSequence: 3,
      endOfStream: false,
    });
  });

  it('refuses broken_event_chain when the first-event resume link mismatches', () => {
    const events = [
      controlEventView({
        sequence: 3,
        eventId: 'evt-3',
        previousEventHash: HASH_A,
        eventHash: HASH_C,
      }),
    ];
    expect(
      decideEventCursor({
        afterSequence: 2,
        expectedPreviousEventHash: HASH_B,
        events,
        eventsHasMore: false,
      }),
    ).toEqual({ kind: 'broken_event_chain' });
  });

  it('refuses broken_event_chain when an adjacent pair link fails', () => {
    const events = [
      controlEventView(),
      controlEventView({
        sequence: 2,
        eventId: 'evt-2',
        previousEventHash: HASH_D,
        eventHash: HASH_B,
      }),
    ];
    expect(
      decideEventCursor({
        afterSequence: 0,
        expectedPreviousEventHash: null,
        events,
        eventsHasMore: false,
      }),
    ).toEqual({ kind: 'broken_event_chain' });
  });

  it('returns an empty page with nextAfterSequence = afterSequence', () => {
    expect(
      decideEventCursor({
        afterSequence: 7,
        expectedPreviousEventHash: HASH_A,
        events: [],
        eventsHasMore: false,
      }),
    ).toEqual({
      kind: 'page',
      events: [],
      nextAfterSequence: 7,
      endOfStream: true,
    });
  });

  it('sets endOfStream from eventsHasMore on a non-empty page', () => {
    const events = [controlEventView()];
    expect(
      decideEventCursor({
        afterSequence: 0,
        expectedPreviousEventHash: null,
        events,
        eventsHasMore: true,
      }).kind === 'page'
        ? (
            decideEventCursor({
              afterSequence: 0,
              expectedPreviousEventHash: null,
              events,
              eventsHasMore: true,
            }) as { endOfStream: boolean }
          ).endOfStream
        : null,
    ).toBe(false);
  });

  it('is byte-deterministic for identical inputs', () => {
    const events = [
      controlEventView(),
      controlEventView({
        sequence: 2,
        eventId: 'evt-2',
        previousEventHash: HASH_A,
        eventHash: HASH_B,
      }),
    ];
    const input = {
      afterSequence: 0 as const,
      expectedPreviousEventHash: null,
      events,
      eventsHasMore: false,
    };
    expect(decideEventCursor(input)).toEqual(decideEventCursor(input));
  });
});
