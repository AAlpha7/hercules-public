/**
 * M11 Control API V2 — second-client conformance proof.
 *
 * Two INDEPENDENT client instances (each over its own fake-provider-backed Hono
 * app, same seed + pinned clock) drive the identical create → status → review →
 * decision → event sequence through the SHARED pure contract
 * (`src/domain/controlApiV2.ts`) and receive BYTE-IDENTICAL responses. This is the
 * mechanical "a second client using the same shared contract gets the same
 * semantics" proof. Root-compiled, DOM-free. The browser SPA client (WebCrypto
 * hashing) lives in `test/web/controlApiV2BrowserConformance.test.ts` (jsdom
 * two-client wire conformance vs this Node client). Also asserts the shared
 * `controlApiV2HttpRoute` mapping is stable.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '../../src/server/api.js';
import type { ActionService } from '../../src/orchestrator/actions.js';
import type { RuntimeView } from '../../src/orchestrator/orchestrator.js';
import { openIsolatedControlApiV2Deps } from '../../src/isolation/controlApiV2FakeProvider.js';
import {
  buildEligibleControlApiV2ReviewSource,
  CONTROL_API_V2_ELIGIBLE_SEED_TASK_ID,
} from '../../src/isolation/controlApiV2ReviewSeed.js';
import {
  createControlApiV2Client,
  type ControlApiV2Client,
  type ControlApiV2ClientResult,
  type ControlApiV2Fetch,
} from '../../src/client/controlApiV2Client.js';
import { SqliteStateStore } from '../../src/control/state/sqliteStateStore.js';
import type { ReviewPackageRefreshSeam } from '../../src/control/state/stateStore.js';
import { canonicalSerialize } from '../../src/domain/canonicalJson.js';
import {
  assertControlEventView,
  buildConcurrencyToken,
  buildControlApiV2Request,
  buildIdempotencyKey,
  computeAdmissionVerdictHash,
  computeEventCursorHash,
  controlApiV2HttpRoute,
  type AdmissionVerdictV1,
  type ControlApiV2ReceiptV1,
  type ControlApiV2RequestV1,
  type ControlEventView,
  type EventCursorRequestV1,
} from '../../src/domain/controlApiV2.js';
import { projectAndAssertReviewPackageV2 } from '../../src/domain/reviewPackageV2.js';
import type { Task } from '../../src/domain/task.js';

const TOKEN = 'control-api-v2-conformance-secret';
const NOW = '2026-09-01T00:00:00.000Z';
const FAKE_ENV = {
  HERCULES_ADAPTER: 'fake',
  HERCULES_FAKE_FAULT_INJECTION: '1',
  HERCULES_L2_ISOLATED: '1',
} as const;

function runtimeStub(): RuntimeView {
  return {
    snapshot: { repos: { repos: {} }, tasks: [], problems: [] },
    running: [],
    stopping: [],
    activity: {},
    pendingChat: {},
    liveRuns: {},
    lastReport: null,
    agents: { default: 'fake', available: ['fake'] },
  };
}

function honoFetch(app: ReturnType<typeof createApi>): ControlApiV2Fetch {
  return async (path, init) => {
    const requestInit: RequestInit = { method: init.method, headers: init.headers };
    if (init.body !== undefined) {
      requestInit.body = init.body;
    }
    const response = await app.request(path, requestInit);
    return { status: response.status, json: () => response.json() };
  };
}

function makeClient(): ControlApiV2Client {
  const actions = new Proxy({}, { get() { throw new Error('no actions'); } }) as ActionService;
  const provider = openIsolatedControlApiV2Deps({ env: FAKE_ENV, now: () => NOW })!;
  const app = createApi({
    runtime: { getState: () => runtimeStub(), subscribe: () => () => {}, forceAbort: () => {} },
    actions,
    token: TOKEN,
    ...provider,
  });
  return createControlApiV2Client({ token: TOKEN, fetch: honoFetch(app) });
}

function eventCursor(): EventCursorRequestV1 {
  const withoutHash: Omit<EventCursorRequestV1, 'cursorHash'> = {
    schema: 'hercules-control-api-event-cursor/v2',
    afterSequence: 0,
    expectedPreviousEventHash: null,
    limit: 10,
  };
  return { ...withoutHash, cursorHash: computeEventCursorHash(withoutHash) };
}

async function runSequence(client: ControlApiV2Client): Promise<readonly ControlApiV2ClientResult[]> {
  const results: ControlApiV2ClientResult[] = [];
  const created = await client.createTask({
    actorIssuer: 'hercules-second-client',
    actorId: 'actor-1',
    clientRequestId: 'req-create-1',
    payload: {
      kind: 'create',
      taskContractHash: 'sha256:' + 'a'.repeat(64),
      intentDigest: 'sha256:' + 'b'.repeat(64),
    },
    issuedAt: NOW,
  });
  results.push(created);
  const aggregateId = (created.body as { aggregateId: string }).aggregateId;
  results.push(await client.readStatus({ aggregateId, issuedAt: NOW }));
  const review = await client.readReview({ aggregateId, issuedAt: NOW });
  results.push(review);
  const rv = review.body as {
    stateVersion: number;
    reviewPackage: { projectionHash: string; validDecisions: readonly ('approve_outcome' | 'reject_outcome' | 'request_changes')[] };
  };
  results.push(
    await client.submitDecision({
      aggregateId,
      stateVersion: rv.stateVersion,
      projectionHash: rv.reviewPackage.projectionHash,
      actorIssuer: 'hercules-second-client',
      actorId: 'actor-1',
      clientRequestId: 'req-decision-1',
      payload: { kind: 'decision', action: rv.reviewPackage.validDecisions[0]!, reason: 'ok', acknowledgedRiskCodes: [] },
      issuedAt: NOW,
    }),
  );
  results.push(await client.readEvents({ cursor: eventCursor(), issuedAt: NOW }));
  return results;
}

describe('Control API V2 — second-client conformance', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => vi.useRealTimers());

  it('two independent clients over the shared contract get byte-identical responses', async () => {
    const a = await runSequence(makeClient());
    const b = await runSequence(makeClient());
    expect(a).toHaveLength(5);
    expect(b).toHaveLength(5);
    for (let i = 0; i < a.length; i += 1) {
      expect(canonicalSerialize(b[i]!)).toBe(canonicalSerialize(a[i]!));
    }
    // every step succeeded (200)
    for (const r of a) {
      expect(r.status).toBe(200);
    }
  });

  it('the shared controlApiV2HttpRoute mapping is stable per resource', () => {
    expect(controlApiV2HttpRoute('task', '')).toEqual({ method: 'POST', path: '/api/v2/control/tasks' });
    expect(controlApiV2HttpRoute('decision', 'task-x')).toEqual({
      method: 'POST',
      path: '/api/v2/control/tasks/task-x/decision',
    });
    expect(controlApiV2HttpRoute('status', 'task-x')).toEqual({
      method: 'GET',
      path: '/api/v2/control/tasks/task-x/status',
    });
    expect(controlApiV2HttpRoute('review', 'task-x')).toEqual({
      method: 'GET',
      path: '/api/v2/control/tasks/task-x/review',
    });
    expect(controlApiV2HttpRoute('event', '')).toEqual({ method: 'GET', path: '/api/v2/control/events' });
  });
});

describe('Control API V2 — fake vs SqliteStateStore commit conformance', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it('commit / replay / conflict / stale receipts and event views match byte-for-byte (hashes aside)', () => {
    const aggregateId = CONTROL_API_V2_ELIGIBLE_SEED_TASK_ID;
    const decidedAt = NOW;
    const seam: ReviewPackageRefreshSeam = (input) => {
      const base = buildEligibleControlApiV2ReviewSource(input.aggregateId);
      return {
        kind: 'projected',
        reviewPackage: projectAndAssertReviewPackageV2({
          ...base,
          humanDecisions: [...input.humanDecisions],
          // Match the fake: seeds keep the source projectedAt; post-decision refresh
          // stamps verdict.decidedAt.
          projectedAt: input.humanDecisions.length === 0 ? base.projectedAt : decidedAt,
        }),
      };
    };

    const fake = openIsolatedControlApiV2Deps({
      env: FAKE_ENV,
      now: () => decidedAt,
      seedTaskIds: [aggregateId],
    })!;

    const parent = mkdtempSync(join(tmpdir(), 'hercules-v2-conform-'));
    cleanup.push(parent);
    const root = join(parent, 'state');
    const store = new SqliteStateStore({
      trustedRoot: root,
      databasePath: join(root, 'shadow.sqlite'),
      busyTimeoutMs: 100,
      clock: () => decidedAt,
      refreshReviewPackage: seam,
    });
    store.initialize();
    const taskRow: Task = {
      id: aggregateId,
      title: 'Control API V2 seed task',
      repo: 'app',
      state: 'review',
      priority: 1,
      blockedBy: [],
      labels: [],
      adapter: null,
      agentSession: null,
      pendingSteer: null,
      attempts: 0,
      lastEventAt: null,
      createdAt: '2026-08-28T00:00:00Z',
      startedAt: null,
      endedAt: null,
      prUrl: null,
      prStatus: null,
      planPending: false,
      verifiedSha: null,
      body: 'body',
    };
    store.beginEnvelope({
      deliveryId: 'delivery-conform',
      authorityRevision: 'a'.repeat(40),
      authorityInput: { writes: [taskRow], retiredTaskIds: [] },
      manifest: [],
      gapCodes: [],
    });
    store.completeEnvelope('delivery-conform');

    const fakeReview = fake.controlApiV2Reader.read(buildControlApiV2Request({
      resource: 'review',
      operation: 'read',
      aggregateId,
      idempotencyKey: null,
      concurrencyToken: null,
      payload: { kind: 'read' },
      issuedAt: decidedAt,
    }));
    const storeRow = store.readV2Aggregate(aggregateId)!;
    expect(storeRow.stateVersion).toBe(1);
    expect(fakeReview.currentStateVersion).toBe(1);
    // Seed packages may differ in projectedAt; align the store package to the fake's
    // projected hash by using the same seam clock above. Compare decision fields.
    expect(storeRow.reviewPackage?.decisionBinding).toEqual(fakeReview.reviewPackage?.decisionBinding);
    expect(storeRow.reviewPackage?.validDecisions).toEqual(fakeReview.reviewPackage?.validDecisions);

    const projectionHash = fakeReview.freshProjectionHash!;
    // Force store row to the same projection hash/token surface as the fake by
    // building the request against the fake package, then committing both with
    // identical request + verdict (store must already be at version 1).
    expect(storeRow.projectionHash).toBe(projectionHash);

    function submit(
      clientRequestId: string,
      stateVersion: number,
      hash: string,
      reason = 'Looks correct',
    ): ControlApiV2RequestV1 {
      return buildControlApiV2Request({
        resource: 'decision',
        operation: 'submit',
        aggregateId,
        idempotencyKey: buildIdempotencyKey({
          actorIssuer: 'hercules-web',
          actorId: 'actor-1',
          aggregateId,
          clientRequestId,
        }),
        concurrencyToken: buildConcurrencyToken({
          aggregateId,
          stateVersion,
          projectionHash: hash,
        }),
        payload: {
          kind: 'decision',
          action: 'approve_outcome',
          reason,
          acknowledgedRiskCodes: [],
        },
        issuedAt: decidedAt,
      });
    }

    function verdictFor(request: ControlApiV2RequestV1): AdmissionVerdictV1 {
      const withoutHash: Omit<AdmissionVerdictV1, 'verdictHash'> = {
        schema: 'hercules-control-api-admit-verdict/v2',
        resource: 'decision',
        aggregateId,
        keyHash: request.idempotencyKey!.keyHash,
        requestHash: request.requestHash,
        decidedAt,
      };
      return { ...withoutHash, verdictHash: computeAdmissionVerdictHash(withoutHash) };
    }

    const request = submit('req-conform-1', 1, projectionHash);
    const verdict = verdictFor(request);
    const fakeCommitted = fake.controlApiV2Mutator.commit(request, verdict);
    const storeCommitted = store.commitV2(request, verdict);
    expect(canonicalSerialize(storeCommitted)).toBe(canonicalSerialize(fakeCommitted));

    const fakeReplay = fake.controlApiV2Mutator.commit(request, verdict);
    const storeReplay = store.commitV2(request, verdict);
    expect(canonicalSerialize(fakeReplay)).toBe(canonicalSerialize(fakeCommitted));
    expect(canonicalSerialize(storeReplay)).toBe(canonicalSerialize(storeCommitted));

    const conflict = submit('req-conform-1', 1, projectionHash, 'Different reason');
    const fakeConflict = fake.controlApiV2Mutator.commit(conflict, verdictFor(conflict));
    const storeConflict = store.commitV2(conflict, verdictFor(conflict));
    expect(canonicalSerialize(storeConflict)).toBe(canonicalSerialize(fakeConflict));
    expect((fakeConflict as ControlApiV2ReceiptV1).reason).toBe('idempotency_conflict');

    const stale = submit('req-conform-stale', 1, projectionHash);
    const fakeStale = fake.controlApiV2Mutator.commit(stale, verdictFor(stale));
    const storeStale = store.commitV2(stale, verdictFor(stale));
    expect(canonicalSerialize(storeStale)).toBe(canonicalSerialize(fakeStale));
    expect((fakeStale as ControlApiV2ReceiptV1).reason).toBe('stale_version');

    const fakeEvents = fake.controlApiV2Events.readEvents(0, 100).events;
    const storeEvents = store.readEvents(0, 100).map((event): ControlEventView => {
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
    });
    expect(fakeEvents.map((event) => event.eventType)).toEqual(
      storeEvents.map((event) => event.eventType),
    );
    expect(fakeEvents.map((event) => event.eventId)).toEqual(
      storeEvents.map((event) => event.eventId),
    );
    expect(fakeEvents.map((event) => event.aggregateId)).toEqual(
      storeEvents.map((event) => event.aggregateId),
    );
    expect(fakeEvents.map((event) => event.sequence)).toEqual(
      storeEvents.map((event) => event.sequence),
    );

    const stripHashes = (events: readonly ControlEventView[]) =>
      events.map(({ eventHash: _eh, previousEventHash: _ph, ...rest }) => rest);
    expect(stripHashes(fakeEvents)).toEqual(stripHashes(storeEvents));
    // Seed/decision occurredAt and eventIds are aligned in this fixture, so the
    // hash chain is also byte-identical — assert full equality.
    expect(canonicalSerialize(fakeEvents)).toBe(canonicalSerialize(storeEvents));

    store.close();
  });
});
