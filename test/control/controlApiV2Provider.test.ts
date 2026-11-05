import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalSerialize } from '../../src/domain/canonicalJson.js';
import {
  assertControlEventView,
  buildConcurrencyToken,
  buildControlApiV2Request,
  buildIdempotencyKey,
  computeAdmissionVerdictHash,
  computeEventCursorHash,
  ControlApiV2Error,
  type AdmissionVerdictV1,
  type ControlApiV2RequestV1,
  type DecisionPayloadV1,
  type EventCursorRequestV1,
} from '../../src/domain/controlApiV2.js';
import {
  buildEligibleControlApiV2ReviewPackage,
  buildEligibleControlApiV2ReviewSource,
} from '../../src/isolation/controlApiV2ReviewSeed.js';
import { openIsolatedControlApiV2Deps } from '../../src/isolation/controlApiV2FakeProvider.js';
import {
  CONTROL_API_V2_AUTHORITY_ENV,
  createControlApiV2Provider,
  openControlApiV2Deps,
} from '../../src/control/controlApiV2Provider.js';
import { createReviewPackageRefreshSeam } from '../../src/control/reviewPackageSource.js';
import { deliverShadowProjection } from '../../src/control/state/shadowReconciler.js';
import { SqliteStateStore } from '../../src/control/state/sqliteStateStore.js';
import {
  type ReviewPackageRefreshInput,
  type ReviewPackageRefreshSeam,
} from '../../src/control/state/stateStore.js';
import { projectAndAssertReviewPackageV2 } from '../../src/domain/reviewPackageV2.js';
import type { Task } from '../../src/domain/task.js';
import { createApi } from '../../src/server/api.js';
import type { ActionService } from '../../src/orchestrator/actions.js';
import type { RuntimeView } from '../../src/orchestrator/orchestrator.js';
import {
  createControlApiV2Client,
  type ControlApiV2Fetch,
} from '../../src/client/controlApiV2Client.js';

const FIXED_CLOCK = '2026-09-04T12:00:00.000Z';
const REVISION = 'a'.repeat(40);
const TOKEN = 'control-api-v2-provider-secret';
const FAKE_ENV = {
  HERCULES_ADAPTER: 'fake',
  HERCULES_FAKE_FAULT_INJECTION: '1',
  HERCULES_L2_ISOLATED: '1',
} as const;

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Project ${id}`,
    repo: 'app',
    state: 'todo',
    priority: 1,
    blockedBy: [],
    labels: [],
    adapter: null,
    agentSession: null,
    pendingSteer: null,
    attempts: 0,
    lastEventAt: null,
    createdAt: '2026-08-28T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    prUrl: null,
    prStatus: null,
    planPending: false,
    verifiedSha: null,
    body: '## Definition of Done\n- [ ] (mechanical) tests pass @gate:test',
    ...overrides,
  };
}

function openStore(options: {
  readonly refreshReviewPackage?: ReviewPackageRefreshSeam;
  readonly clock?: () => string;
} = {}): SqliteStateStore {
  const parent = mkdtempSync(join(tmpdir(), 'hercules-control-api-v2-provider-'));
  cleanup.push(parent);
  const store = new SqliteStateStore({
    trustedRoot: join(parent, 'state'),
    databasePath: join(parent, 'state', 'shadow.sqlite'),
    busyTimeoutMs: 100,
    clock: options.clock ?? (() => FIXED_CLOCK),
    refreshReviewPackage:
      options.refreshReviewPackage ??
      createReviewPackageRefreshSeam(() => FIXED_CLOCK),
  });
  store.initialize();
  return store;
}

function deliver(store: SqliteStateStore, item: Task, deliveryId: string): void {
  deliverShadowProjection(store, {
    deliveryId,
    revision: REVISION,
    writes: [item],
    retiredTaskIds: [],
  });
}

function statusRead(aggregateId: string): ControlApiV2RequestV1 {
  return buildControlApiV2Request({
    resource: 'status',
    operation: 'read',
    aggregateId,
    idempotencyKey: null,
    concurrencyToken: null,
    payload: { kind: 'read' },
    issuedAt: FIXED_CLOCK,
  });
}

function reviewRead(aggregateId: string): ControlApiV2RequestV1 {
  return buildControlApiV2Request({
    resource: 'review',
    operation: 'read',
    aggregateId,
    idempotencyKey: null,
    concurrencyToken: null,
    payload: { kind: 'read' },
    issuedAt: FIXED_CLOCK,
  });
}

function decisionSubmit(
  aggregateId: string,
  stateVersion: number,
  projectionHash: string,
  clientRequestId: string,
  payload: DecisionPayloadV1 = {
    kind: 'decision',
    action: 'approve_outcome',
    reason: 'Looks correct',
    acknowledgedRiskCodes: [],
  },
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
      projectionHash,
    }),
    payload,
    issuedAt: FIXED_CLOCK,
  });
}

function admitVerdict(request: ControlApiV2RequestV1): AdmissionVerdictV1 {
  const withoutHash: Omit<AdmissionVerdictV1, 'verdictHash'> = {
    schema: 'hercules-control-api-admit-verdict/v2',
    resource: 'decision',
    aggregateId: request.aggregateId,
    keyHash: request.idempotencyKey!.keyHash,
    requestHash: request.requestHash,
    decidedAt: FIXED_CLOCK,
  };
  return {
    ...withoutHash,
    verdictHash: computeAdmissionVerdictHash(withoutHash),
  };
}

function eligibleSeam(): ReviewPackageRefreshSeam {
  return (input: ReviewPackageRefreshInput) => ({
    kind: 'projected',
    reviewPackage: projectAndAssertReviewPackageV2({
      ...buildEligibleControlApiV2ReviewSource(input.aggregateId),
      humanDecisions: [...input.humanDecisions],
      projectedAt: FIXED_CLOCK,
    }),
  });
}

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

function makeApi(deps: ReturnType<typeof createControlApiV2Provider>) {
  return createApi({
    runtime: { getState: () => runtimeStub(), subscribe: () => () => {}, forceAbort: () => {} },
    actions: new Proxy({}, {
      get() { throw new Error('provider route tests must not call actions'); },
    }) as ActionService,
    token: TOKEN,
    ...deps,
  });
}

describe('openControlApiV2Deps', () => {
  it('returns {} across the authority/store matrix with the contract log lines', () => {
    const store = openStore();
    const lines: string[] = [];
    const log = (line: string): void => { lines.push(line); };

    lines.length = 0;
    expect(openControlApiV2Deps({ store: null, env: {}, log })).toEqual({});
    expect(lines.some((line) => line.includes('HERCULES_CONTROL_API_V2_AUTHORITY=1 but'))).toBe(false);

    lines.length = 0;
    expect(openControlApiV2Deps({
      store: null,
      env: { [CONTROL_API_V2_AUTHORITY_ENV]: '1' },
      log,
    })).toEqual({});
    expect(lines).toEqual([
      '[hercules] HERCULES_CONTROL_API_V2_AUTHORITY=1 but the V2 store is not configured (HERCULES_V2_SHADOW_ROOT/HERCULES_V2_SHADOW_DATABASE unset) — /api/v2/control routes stay 503 provider_unavailable',
    ]);

    lines.length = 0;
    expect(openControlApiV2Deps({ store, env: {}, log })).toEqual({});
    expect(lines).toEqual([
      '[hercules] control API v2 authority off (set HERCULES_CONTROL_API_V2_AUTHORITY=1 to serve /api/v2/control routes from the V2 store)',
    ]);

    lines.length = 0;
    const on = openControlApiV2Deps({
      store,
      env: { [CONTROL_API_V2_AUTHORITY_ENV]: '1' },
      log,
    });
    expect(on).toEqual(expect.objectContaining({
      controlApiV2Reader: expect.anything(),
      controlApiV2Mutator: expect.anything(),
      controlApiV2Events: expect.anything(),
    }));
    expect(lines).toEqual([
      '[hercules] control API v2 authority ON: /api/v2/control routes served from the V2 store',
    ]);

    lines.length = 0;
    expect(openControlApiV2Deps({
      store,
      env: { [CONTROL_API_V2_AUTHORITY_ENV]: 'true' },
      log,
    })).toEqual({});
    expect(openControlApiV2Deps({
      store,
      env: { [CONTROL_API_V2_AUTHORITY_ENV]: 'yes' },
      log,
    })).toEqual({});
    expect(lines.every((line) => line.includes('authority off'))).toBe(true);

    store.close();
  });
});

describe('createControlApiV2Provider reader/events/mutator', () => {
  it('assembles status and review reads over projected and unprojectable aggregates', () => {
    const store = openStore();
    const deps = createControlApiV2Provider(store);
    const live = task('provider-live');
    deliver(store, live, 'delivery-live');
    const row = store.readV2Aggregate('provider-live')!;
    expect(row.projectionState).toBe('projected');

    const status = deps.controlApiV2Reader.read(statusRead('provider-live'));
    expect(status.aggregateExists).toBe(true);
    expect(status.currentStateVersion).toBe(row.stateVersion);
    expect(status.taskStatus).toBe(row.taskStatus);
    expect(status.latestEventSequence).toBe(row.updatedAtSequence);
    expect(status.reviewPackage).toBeNull();
    expect(status.freshProjectionHash).toBe(row.projectionHash);

    const review = deps.controlApiV2Reader.read(reviewRead('provider-live'));
    expect(review.aggregateExists).toBe(true);
    expect(canonicalSerialize(review.reviewPackage)).toBe(
      canonicalSerialize(store.readV2Aggregate('provider-live')!.reviewPackage),
    );
    expect(review.taskStatus).toBeNull();
    expect(review.latestEventSequence).toBeNull();

    const unknown = deps.controlApiV2Reader.read(statusRead('missing-task'));
    expect(unknown).toMatchObject({
      aggregateExists: false,
      currentStateVersion: null,
      taskStatus: null,
      latestEventSequence: null,
      freshProjectionHash: null,
      reviewPackage: null,
      events: null,
      eventsHasMore: false,
    });

    const gap = task('provider-gap', { state: 'failed', attempts: 3 });
    deliver(store, gap, 'delivery-gap');
    expect(store.readV2Aggregate('provider-gap')?.projectionState).toBe('unprojectable');
    expect(deps.controlApiV2Reader.read(statusRead('provider-gap')).aggregateExists).toBe(false);

    expect(deps.controlApiV2Reader.read(statusRead('provider-live')).admissionLedger).toEqual([]);
    store.close();
  });

  it('exposes admission-ledger entries after a committed decision', () => {
    const store = openStore({ refreshReviewPackage: eligibleSeam() });
    const deps = createControlApiV2Provider(store);
    deliver(store, task('ledger-task', { state: 'review' }), 'delivery-ledger');
    const row = store.readV2Aggregate('ledger-task')!;
    const request = decisionSubmit(
      'ledger-task',
      row.stateVersion,
      row.projectionHash!,
      'req-ledger-1',
    );
    const receipt = deps.controlApiV2Mutator.commit(request, admitVerdict(request));
    expect(receipt.outcome).toBe('committed');

    const withKey = deps.controlApiV2Reader.read(request);
    expect(withKey.admissionLedger).toHaveLength(1);
    expect(withKey.admissionLedger[0]).toMatchObject({
      keyHash: request.idempotencyKey!.keyHash,
      requestHash: request.requestHash,
      receipt,
    });

    const otherKey = decisionSubmit(
      'ledger-task',
      row.stateVersion,
      row.projectionHash!,
      'req-ledger-other',
    );
    expect(deps.controlApiV2Reader.read(otherKey).admissionLedger).toEqual([]);
    store.close();
  });

  it('pages events with hasMore and rejects out-of-range limits', () => {
    const store = openStore();
    const deps = createControlApiV2Provider(store);
    deliver(store, task('evt-a'), 'delivery-a');
    deliver(store, task('evt-b'), 'delivery-b');
    deliver(store, task('evt-c'), 'delivery-c');
    const all = store.readEvents(0, 1000);
    expect(all.length).toBeGreaterThanOrEqual(3);

    const page = deps.controlApiV2Events.readEvents(0, 2);
    expect(page.events).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    for (const view of page.events) assertControlEventView(view);
    expect(page.events[0]).toMatchObject({
      sequence: all[0]!.sequence,
      eventId: all[0]!.eventId,
      eventType: all[0]!.eventType,
      aggregateKind: all[0]!.aggregateKind,
      aggregateId: all[0]!.aggregateId,
      previousEventHash: all[0]!.previousEventHash,
      eventHash: all[0]!.eventHash,
    });

    const full = deps.controlApiV2Events.readEvents(0, 1000);
    expect(full.events).toHaveLength(all.length);
    expect(full.hasMore).toBe(false);

    const lastSeq = all[all.length - 1]!.sequence;
    expect(deps.controlApiV2Events.readEvents(lastSeq, 5)).toEqual({
      events: [],
      hasMore: false,
    });

    expect(() => deps.controlApiV2Events.readEvents(0, 0)).toThrow(RangeError);
    expect(() => deps.controlApiV2Events.readEvents(0, 1001)).toThrow(RangeError);
    store.close();
  });

  it('refuses create and delegates decision commit to the store', () => {
    const store = openStore({ refreshReviewPackage: eligibleSeam() });
    const deps = createControlApiV2Provider(store);
    const create = buildControlApiV2Request({
      resource: 'task',
      operation: 'create',
      aggregateId: '',
      idempotencyKey: buildIdempotencyKey({
        actorIssuer: 'hercules-web',
        actorId: 'actor-1',
        aggregateId: '',
        clientRequestId: 'req-create-refuse',
      }),
      concurrencyToken: null,
      payload: {
        kind: 'create',
        taskContractHash: 'sha256:' + 'a'.repeat(64),
        intentDigest: 'sha256:' + 'b'.repeat(64),
      },
      issuedAt: FIXED_CLOCK,
    });
    const createVerdict: AdmissionVerdictV1 = {
      schema: 'hercules-control-api-admit-verdict/v2',
      resource: 'task',
      aggregateId: 'task-deadbeef',
      keyHash: create.idempotencyKey!.keyHash,
      requestHash: create.requestHash,
      decidedAt: FIXED_CLOCK,
      verdictHash: 'sha256:' + 'c'.repeat(64),
    };
    try {
      deps.controlApiV2Mutator.commit(create, createVerdict);
      expect.fail('expected create commit to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ControlApiV2Error);
      expect((error as ControlApiV2Error).code).toBe('provider_unavailable');
    }

    deliver(store, task('commit-task', { state: 'review' }), 'delivery-commit');
    const row = store.readV2Aggregate('commit-task')!;
    const spy = vi.spyOn(store, 'commitV2');
    const request = decisionSubmit(
      'commit-task',
      row.stateVersion,
      row.projectionHash!,
      'req-commit-1',
    );
    const verdict = admitVerdict(request);
    const receipt = deps.controlApiV2Mutator.commit(request, verdict);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(request, verdict);
    expect(receipt.outcome).toBe('committed');
    expect(store.readV2AdmissionLedgerEntry(request.idempotencyKey!.keyHash)).not.toBeNull();
    store.close();
  });
});

describe('Control API V2 routes through the production provider', () => {
  let clock: { restore(): void };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_CLOCK));
    clock = { restore: () => vi.useRealTimers() };
  });
  afterEach(() => clock.restore());

  it('serves status/review/decision/events for a materialized legacy task', async () => {
    const store = openStore();
    const deps = createControlApiV2Provider(store);
    const live = task('route-live');
    deliver(store, live, 'delivery-route-live');
    const row = store.readV2Aggregate('route-live')!;
    const app = makeApi(deps);
    const client = createControlApiV2Client({ token: TOKEN, fetch: honoFetch(app) });

    const status = await client.readStatus({ aggregateId: 'route-live', issuedAt: FIXED_CLOCK });
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      schema: 'hercules-control-api-status-view/v2',
      latestEventSequence: row.updatedAtSequence,
    });

    const review = await client.readReview({ aggregateId: 'route-live', issuedAt: FIXED_CLOCK });
    expect(review.status).toBe(200);
    expect(review.body).toMatchObject({
      schema: 'hercules-control-api-review-view/v2',
    });
    const reviewBody = review.body as {
      reviewPackage: { outcome: { decisionEligible: boolean } };
    };
    expect(reviewBody.reviewPackage.outcome.decisionEligible).toBe(false);

    const decision = await client.submitDecision({
      aggregateId: 'route-live',
      stateVersion: row.stateVersion,
      projectionHash: row.projectionHash!,
      actorIssuer: 'hercules-cli',
      actorId: 'actor-1',
      clientRequestId: 'req-route-decision',
      payload: {
        kind: 'decision',
        action: 'approve_outcome',
        reason: 'attempt',
        acknowledgedRiskCodes: [],
      },
      issuedAt: FIXED_CLOCK,
    });
    // Real C2.3 packages are decision-ineligible (null decisionBinding) → engine
    // refuses need_more_evidence (422). ineligible_decision is the binding-present
    // / action-not-in-validDecisions path; both are honest refusals.
    expect(decision.status).toBe(422);
    expect((decision.body as { reason: string }).reason).toBe('need_more_evidence');

    const unknown = await client.readStatus({
      aggregateId: 'route-missing',
      issuedAt: FIXED_CLOCK,
    });
    expect(unknown.status).toBe(404);
    expect((unknown.body as { reason: string }).reason).toBe('unknown_aggregate');

    const gap = task('route-gap', { state: 'failed', attempts: 3 });
    deliver(store, gap, 'delivery-route-gap');
    const unprojectable = await client.readReview({
      aggregateId: 'route-gap',
      issuedAt: FIXED_CLOCK,
    });
    expect(unprojectable.status).toBe(404);
    expect((unprojectable.body as { reason: string }).reason).toBe('unknown_aggregate');

    const createBody = canonicalSerialize(
      buildControlApiV2Request({
        resource: 'task',
        operation: 'create',
        aggregateId: '',
        idempotencyKey: buildIdempotencyKey({
          actorIssuer: 'hercules-cli',
          actorId: 'actor-1',
          aggregateId: '',
          clientRequestId: 'req-route-create',
        }),
        concurrencyToken: null,
        payload: {
          kind: 'create',
          taskContractHash: 'sha256:' + 'a'.repeat(64),
          intentDigest: 'sha256:' + 'b'.repeat(64),
        },
        issuedAt: FIXED_CLOCK,
      }),
    );
    const created = await app.request('/api/v2/control/tasks', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: createBody,
    });
    expect(created.status).toBe(503);
    expect(await created.json()).toEqual({ reason: 'provider_unavailable' });

    const cursorWithoutHash: Omit<EventCursorRequestV1, 'cursorHash'> = {
      schema: 'hercules-control-api-event-cursor/v2',
      afterSequence: 0,
      expectedPreviousEventHash: null,
      limit: 10,
    };
    const events = await client.readEvents({
      cursor: {
        ...cursorWithoutHash,
        cursorHash: computeEventCursorHash(cursorWithoutHash),
      },
      issuedAt: FIXED_CLOCK,
    });
    expect(events.status).toBe(200);
    expect(events.body.schema).toBe('hercules-control-api-event-page/v2');
    store.close();
  });

  it('matches the fake provider byte-for-byte on shared refusal paths', async () => {
    const store = openStore();
    const realDeps = createControlApiV2Provider(store);
    const realApp = makeApi(realDeps);
    const fakeDeps = openIsolatedControlApiV2Deps({
      env: FAKE_ENV,
      now: () => FIXED_CLOCK,
      seedTaskIds: [],
    })!;
    const fakeApp = makeApi(fakeDeps);
    const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

    const invalidBody = '{"schema":"not-a-request"}';
    const realInvalid = await realApp.request('/api/v2/control/tasks', {
      method: 'POST',
      headers: auth,
      body: invalidBody,
    });
    const fakeInvalid = await fakeApp.request('/api/v2/control/tasks', {
      method: 'POST',
      headers: auth,
      body: invalidBody,
    });
    expect(realInvalid.status).toBe(fakeInvalid.status);
    expect(canonicalSerialize(await realInvalid.json())).toBe(
      canonicalSerialize(await fakeInvalid.json()),
    );

    for (const path of [
      '/api/v2/control/tasks/unknown-agg/status',
      '/api/v2/control/tasks/unknown-agg/review',
    ] as const) {
      const real = await realApp.request(path, { headers: { authorization: `Bearer ${TOKEN}` } });
      const fake = await fakeApp.request(path, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(real.status).toBe(fake.status);
      expect(canonicalSerialize(await real.json())).toBe(canonicalSerialize(await fake.json()));
    }

    const decisionBody = canonicalSerialize(
      buildControlApiV2Request({
        resource: 'decision',
        operation: 'submit',
        aggregateId: 'unknown-agg',
        idempotencyKey: buildIdempotencyKey({
          actorIssuer: 'hercules-cli',
          actorId: 'actor-1',
          aggregateId: 'unknown-agg',
          clientRequestId: 'req-unknown-decision',
        }),
        concurrencyToken: buildConcurrencyToken({
          aggregateId: 'unknown-agg',
          stateVersion: 1,
          projectionHash: buildEligibleControlApiV2ReviewPackage('unknown-agg').projectionHash,
        }),
        payload: {
          kind: 'decision',
          action: 'approve_outcome',
          reason: 'x',
          acknowledgedRiskCodes: [],
        },
        issuedAt: FIXED_CLOCK,
      }),
    );
    const realDecision = await realApp.request('/api/v2/control/tasks/unknown-agg/decision', {
      method: 'POST',
      headers: auth,
      body: decisionBody,
    });
    const fakeDecision = await fakeApp.request('/api/v2/control/tasks/unknown-agg/decision', {
      method: 'POST',
      headers: auth,
      body: decisionBody,
    });
    expect(realDecision.status).toBe(fakeDecision.status);
    expect(canonicalSerialize(await realDecision.json())).toBe(
      canonicalSerialize(await fakeDecision.json()),
    );

    deliver(store, task('evt-shape'), 'delivery-evt-shape');
    const realEvents = await realApp.request(
      '/api/v2/control/events?afterSequence=0&limit=5',
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    const fakeEvents = await fakeApp.request(
      '/api/v2/control/events?afterSequence=0&limit=5',
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(realEvents.status).toBe(200);
    expect(fakeEvents.status).toBe(200);
    const realPage = await realEvents.json() as { events: readonly unknown[] };
    const fakePage = await fakeEvents.json() as { events: readonly unknown[] };
    for (const event of realPage.events) assertControlEventView(event);
    for (const event of fakePage.events) assertControlEventView(event);
    store.close();
  });
});
