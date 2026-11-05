import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '../../src/server/api.js';
import type { ActionService } from '../../src/orchestrator/actions.js';
import type { RuntimeView } from '../../src/orchestrator/orchestrator.js';
import { openIsolatedControlApiV2Deps } from '../../src/isolation/controlApiV2FakeProvider.js';
import {
  CONTROL_API_V2_ELIGIBLE_SEED_TASK_ID,
  buildEligibleControlApiV2ReviewPackage,
} from '../../src/isolation/controlApiV2ReviewSeed.js';
import {
  createControlApiV2Client,
  type ControlApiV2Fetch,
} from '../../src/client/controlApiV2Client.js';
import {
  ControlApiV2Error,
  buildControlApiV2Request,
  buildIdempotencyKey,
  computeEventCursorHash,
  type ControlApiV2MutatorPortV1,
  type ControlApiV2ReaderPortV1,
  type ControlEventReadPortV1,
  type EventCursorRequestV1,
} from '../../src/domain/controlApiV2.js';
import { canonicalSerialize } from '../../src/domain/canonicalJson.js';

function eventCursor(): EventCursorRequestV1 {
  const withoutHash: Omit<EventCursorRequestV1, 'cursorHash'> = {
    schema: 'hercules-control-api-event-cursor/v2',
    afterSequence: 0,
    expectedPreviousEventHash: null,
    limit: 10,
  };
  return { ...withoutHash, cursorHash: computeEventCursorHash(withoutHash) };
}

const TOKEN = 'control-api-v2-routes-secret';
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

function makeApp(withProvider: boolean) {
  const actions = new Proxy(
    {},
    {
      get() {
        throw new Error('control api v2 routes must not call actions');
      },
    },
  ) as ActionService;
  const provider = withProvider
    ? openIsolatedControlApiV2Deps({ env: FAKE_ENV, now: () => NOW })
    : undefined;
  return createApi({
    runtime: { getState: () => runtimeStub(), subscribe: () => () => {}, forceAbort: () => {} },
    actions,
    token: TOKEN,
    ...(provider ?? {}),
  });
}

/** Adapt Hono's app.request to the injected-fetch shape the client expects. */
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

describe('Control API V2 routes — fail-closed + auth', () => {
  it('returns 503 provider_unavailable on every route when the ports are unset', async () => {
    const app = makeApp(false);
    const auth = { headers: { authorization: `Bearer ${TOKEN}` } };
    const routes: ReadonlyArray<{ method: 'GET' | 'POST'; path: string }> = [
      { method: 'POST', path: '/api/v2/control/tasks' },
      { method: 'POST', path: '/api/v2/control/tasks/task-1/decision' },
      { method: 'GET', path: '/api/v2/control/tasks/task-1/status' },
      { method: 'GET', path: '/api/v2/control/tasks/task-1/review' },
      { method: 'GET', path: '/api/v2/control/events?afterSequence=0&limit=5' },
    ];
    for (const route of routes) {
      const init: RequestInit =
        route.method === 'POST'
          ? { method: 'POST', headers: { ...auth.headers, 'content-type': 'application/json' }, body: '{}' }
          : { method: 'GET', headers: auth.headers };
      const response = await app.request(route.path, init);
      expect(response.status, route.path).toBe(503);
      expect(await response.json()).toEqual({ reason: 'provider_unavailable' });
    }
  });

  it('rejects a missing/invalid Bearer token with 401', async () => {
    const app = makeApp(true);
    expect((await app.request('/api/v2/control/tasks/task-1/status')).status).toBe(401);
    expect(
      (
        await app.request('/api/v2/control/tasks/task-1/status', {
          headers: { authorization: 'Bearer wrong' },
        })
      ).status,
    ).toBe(401);
  });

  it('maps create mutator provider_unavailable to 503 and lets other throws escape', async () => {
    const emptyReads = {
      aggregateExists: false,
      currentStateVersion: null,
      taskStatus: null,
      latestEventSequence: null,
      freshProjectionHash: null,
      reviewPackage: null,
      admissionLedger: [] as const,
      events: null,
      eventsHasMore: false,
    };
    const reader: ControlApiV2ReaderPortV1 = { read: () => emptyReads };
    const events: ControlEventReadPortV1 = {
      readEvents: () => ({ events: [], hasMore: false }),
    };
    const authHeaders = {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    };
    const createBody = canonicalSerialize(
      buildControlApiV2Request({
        resource: 'task',
        operation: 'create',
        aggregateId: '',
        idempotencyKey: buildIdempotencyKey({
          actorIssuer: 'hercules-cli',
          actorId: 'actor-1',
          aggregateId: '',
          clientRequestId: 'req-create-provider-unavailable',
        }),
        concurrencyToken: null,
        payload: {
          kind: 'create',
          taskContractHash: 'sha256:' + 'a'.repeat(64),
          intentDigest: 'sha256:' + 'b'.repeat(64),
        },
        issuedAt: NOW,
      }),
    );

    const unavailableMutator: ControlApiV2MutatorPortV1 = {
      commit: () => {
        throw new ControlApiV2Error('provider_unavailable', 'create not served');
      },
    };
    const unavailableApp = createApi({
      runtime: { getState: () => runtimeStub(), subscribe: () => () => {}, forceAbort: () => {} },
      actions: new Proxy({}, { get() { throw new Error('no actions'); } }) as ActionService,
      token: TOKEN,
      controlApiV2Reader: reader,
      controlApiV2Mutator: unavailableMutator,
      controlApiV2Events: events,
    });
    const unavailable = await unavailableApp.request('/api/v2/control/tasks', {
      method: 'POST',
      headers: authHeaders,
      body: createBody,
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ reason: 'provider_unavailable' });

    const plainMutator: ControlApiV2MutatorPortV1 = {
      commit: () => {
        throw new Error('plain mutator failure');
      },
    };
    const plainApp = createApi({
      runtime: { getState: () => runtimeStub(), subscribe: () => () => {}, forceAbort: () => {} },
      actions: new Proxy({}, { get() { throw new Error('no actions'); } }) as ActionService,
      token: TOKEN,
      controlApiV2Reader: reader,
      controlApiV2Mutator: plainMutator,
      controlApiV2Events: events,
    });
    const plain = await plainApp.request('/api/v2/control/tasks', {
      method: 'POST',
      headers: authHeaders,
      body: createBody,
    });
    expect(plain.status).not.toBe(503);
  });
});

describe('Control API V2 routes — happy path + reason map (fake provider)', () => {
  let clock: { restore(): void };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    clock = { restore: () => vi.useRealTimers() };
  });
  afterEach(() => clock.restore());

  it('drives create → status → review → decision → event', async () => {
    const app = makeApp(true);
    const client = createControlApiV2Client({ token: TOKEN, fetch: honoFetch(app) });

    // create
    const created = await client.createTask({
      actorIssuer: 'hercules-cli',
      actorId: 'actor-1',
      clientRequestId: 'req-create-1',
      payload: {
        kind: 'create',
        taskContractHash: 'sha256:' + 'a'.repeat(64),
        intentDigest: 'sha256:' + 'b'.repeat(64),
      },
      issuedAt: NOW,
    });
    expect(created.status).toBe(200);
    expect(created.body.schema).toBe('hercules-control-api-receipt/v2');
    const receipt = created.body as { outcome: string; aggregateId: string; stateVersion: number };
    expect(receipt.outcome).toBe('committed');
    const aggregateId = receipt.aggregateId;
    expect(aggregateId.startsWith('task-')).toBe(true);

    // idempotent replay → byte-identical committed receipt
    const replay = await client.createTask({
      actorIssuer: 'hercules-cli',
      actorId: 'actor-1',
      clientRequestId: 'req-create-1',
      payload: {
        kind: 'create',
        taskContractHash: 'sha256:' + 'a'.repeat(64),
        intentDigest: 'sha256:' + 'b'.repeat(64),
      },
      issuedAt: NOW,
    });
    expect(replay.body).toEqual(created.body);

    // status
    const status = await client.readStatus({ aggregateId, issuedAt: NOW });
    expect(status.status).toBe(200);
    expect(status.body.schema).toBe('hercules-control-api-status-view/v2');

    // review (exposes eligibility)
    const review = await client.readReview({ aggregateId, issuedAt: NOW });
    expect(review.status).toBe(200);
    expect(review.body.schema).toBe('hercules-control-api-review-view/v2');
    const reviewView = review.body as {
      stateVersion: number;
      reviewPackage: { projectionHash: string; validDecisions: readonly string[]; decisionBinding: unknown };
    };
    expect(reviewView.reviewPackage.decisionBinding).not.toBeNull();

    // decision (eligible → committed)
    const decision = await client.submitDecision({
      aggregateId,
      stateVersion: reviewView.stateVersion,
      projectionHash: reviewView.reviewPackage.projectionHash,
      actorIssuer: 'hercules-cli',
      actorId: 'actor-1',
      clientRequestId: 'req-decision-1',
      payload: {
        kind: 'decision',
        action: reviewView.reviewPackage.validDecisions[0] as 'approve_outcome' | 'reject_outcome' | 'request_changes',
        reason: 'Looks correct.',
        acknowledgedRiskCodes: [],
      },
      issuedAt: NOW,
    });
    expect(decision.status).toBe(200);
    expect((decision.body as { outcome: string }).outcome).toBe('committed');

    // event stream (global, from the beginning)
    const events = await client.readEvents({
      cursor: eventCursor(),
      issuedAt: NOW,
    });
    expect(events.status).toBe(200);
    expect(events.body.schema).toBe('hercules-control-api-event-page/v2');
    expect((events.body as { events: readonly unknown[] }).events.length).toBeGreaterThan(0);
  });

  it('maps refusal reasons to HTTP statuses', async () => {
    const app = makeApp(true);
    const client = createControlApiV2Client({ token: TOKEN, fetch: honoFetch(app) });

    // unknown aggregate → 404
    const unknown = await client.readStatus({ aggregateId: 'task-does-not-exist', issuedAt: NOW });
    expect(unknown.status).toBe(404);
    expect((unknown.body as { reason: string }).reason).toBe('unknown_aggregate');

    // a submit against a pre-seeded eligible aggregate with a STALE version → 409
    const seededId = CONTROL_API_V2_ELIGIBLE_SEED_TASK_ID;
    const pkg = buildEligibleControlApiV2ReviewPackage(seededId);
    const stale = await client.submitDecision({
      aggregateId: seededId,
      stateVersion: 999,
      projectionHash: pkg.projectionHash,
      actorIssuer: 'hercules-cli',
      actorId: 'actor-1',
      clientRequestId: 'req-stale-1',
      payload: { kind: 'decision', action: pkg.validDecisions[0]!, reason: 'x', acknowledgedRiskCodes: [] },
      issuedAt: NOW,
    });
    expect(stale.status).toBe(409);
    expect((stale.body as { reason: string }).reason).toBe('stale_version');
  });
});

describe('Control API V2 decision route — decisionEffects post-commit hook', () => {
  let clock: { restore(): void };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    clock = { restore: () => vi.useRealTimers() };
  });
  afterEach(() => clock.restore());

  function makeAppWithEffects(
    decisionEffects: {
      driveCommitted: (keyHash: string) => Promise<unknown>;
    } | undefined,
  ) {
    const actions = new Proxy(
      {},
      {
        get() {
          throw new Error('control api v2 routes must not call actions');
        },
      },
    ) as ActionService;
    const provider = openIsolatedControlApiV2Deps({ env: FAKE_ENV, now: () => NOW });
    return createApi({
      runtime: { getState: () => runtimeStub(), subscribe: () => () => {}, forceAbort: () => {} },
      actions,
      token: TOKEN,
      ...provider,
      ...(decisionEffects === undefined ? {} : { decisionEffects: decisionEffects as never }),
    });
  }

  it('calls driveCommitted once with the receipt keyHash on a committed decision', async () => {
    const driveCommitted = vi.fn(async () => ({ kind: 'applied' as const }));
    const app = makeAppWithEffects({ driveCommitted });
    const client = createControlApiV2Client({ token: TOKEN, fetch: honoFetch(app) });
    const seededId = CONTROL_API_V2_ELIGIBLE_SEED_TASK_ID;
    const review = await client.readReview({ aggregateId: seededId, issuedAt: NOW });
    expect(review.status).toBe(200);
    const reviewView = review.body as {
      stateVersion: number;
      reviewPackage: { projectionHash: string; validDecisions: readonly string[] };
    };
    const decision = await client.submitDecision({
      aggregateId: seededId,
      stateVersion: reviewView.stateVersion,
      projectionHash: reviewView.reviewPackage.projectionHash,
      actorIssuer: 'hercules-cli',
      actorId: 'actor-1',
      clientRequestId: 'req-effect-committed',
      payload: {
        kind: 'decision',
        action: reviewView.reviewPackage.validDecisions[0] as 'approve_outcome',
        reason: 'ok',
        acknowledgedRiskCodes: [],
      },
      issuedAt: NOW,
    });
    expect(decision.status).toBe(200);
    const body = decision.body as { outcome: string; keyHash: string };
    expect(body.outcome).toBe('committed');
    expect(driveCommitted).toHaveBeenCalledOnce();
    expect(driveCommitted).toHaveBeenCalledWith(body.keyHash);
  });

  it('does not call the driver on a refused decision', async () => {
    const driveCommitted = vi.fn(async () => ({ kind: 'skipped' as const }));
    const app = makeAppWithEffects({ driveCommitted });
    const client = createControlApiV2Client({ token: TOKEN, fetch: honoFetch(app) });
    const seededId = CONTROL_API_V2_ELIGIBLE_SEED_TASK_ID;
    const pkg = buildEligibleControlApiV2ReviewPackage(seededId);
    const stale = await client.submitDecision({
      aggregateId: seededId,
      stateVersion: 999,
      projectionHash: pkg.projectionHash,
      actorIssuer: 'hercules-cli',
      actorId: 'actor-1',
      clientRequestId: 'req-effect-refused',
      payload: {
        kind: 'decision',
        action: pkg.validDecisions[0]!,
        reason: 'x',
        acknowledgedRiskCodes: [],
      },
      issuedAt: NOW,
    });
    expect(stale.status).toBe(409);
    expect((stale.body as { outcome: string }).outcome).toBe('refused');
    expect(driveCommitted).not.toHaveBeenCalled();
  });

  it('returns a byte-identical committed response with or without the driver', async () => {
    const without = makeApp(true);
    const driveCommitted = vi.fn(async () => ({ kind: 'applied' as const }));
    const withDriver = makeAppWithEffects({ driveCommitted });
    const clientWithout = createControlApiV2Client({ token: TOKEN, fetch: honoFetch(without) });
    const clientWith = createControlApiV2Client({ token: TOKEN, fetch: honoFetch(withDriver) });
    const seededId = CONTROL_API_V2_ELIGIBLE_SEED_TASK_ID;

    async function decide(
      client: ReturnType<typeof createControlApiV2Client>,
      clientRequestId: string,
    ) {
      const review = await client.readReview({ aggregateId: seededId, issuedAt: NOW });
      const reviewView = review.body as {
        stateVersion: number;
        reviewPackage: { projectionHash: string; validDecisions: readonly string[] };
      };
      return client.submitDecision({
        aggregateId: seededId,
        stateVersion: reviewView.stateVersion,
        projectionHash: reviewView.reviewPackage.projectionHash,
        actorIssuer: 'hercules-cli',
        actorId: 'actor-1',
        clientRequestId,
        payload: {
          kind: 'decision',
          action: reviewView.reviewPackage.validDecisions[0] as 'approve_outcome',
          reason: 'byte-identical',
          acknowledgedRiskCodes: [],
        },
        issuedAt: NOW,
      });
    }

    const a = await decide(clientWithout, 'req-byte-a');
    const b = await decide(clientWith, 'req-byte-b');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Shape (not keyHash) is identical — different idempotency keys by design.
    expect(a.body).toMatchObject({
      schema: 'hercules-control-api-receipt/v2',
      outcome: 'committed',
      aggregateId: seededId,
    });
    expect(b.body).toMatchObject({
      schema: 'hercules-control-api-receipt/v2',
      outcome: 'committed',
      aggregateId: seededId,
    });
    expect(driveCommitted).toHaveBeenCalledOnce();
  });

  it('still returns the committed response when the driver throws', async () => {
    const driveCommitted = vi.fn(async () => {
      throw new Error('driver boom');
    });
    const app = makeAppWithEffects({ driveCommitted });
    const client = createControlApiV2Client({ token: TOKEN, fetch: honoFetch(app) });
    const seededId = CONTROL_API_V2_ELIGIBLE_SEED_TASK_ID;
    const review = await client.readReview({ aggregateId: seededId, issuedAt: NOW });
    const reviewView = review.body as {
      stateVersion: number;
      reviewPackage: { projectionHash: string; validDecisions: readonly string[] };
    };
    const decision = await client.submitDecision({
      aggregateId: seededId,
      stateVersion: reviewView.stateVersion,
      projectionHash: reviewView.reviewPackage.projectionHash,
      actorIssuer: 'hercules-cli',
      actorId: 'actor-1',
      clientRequestId: 'req-effect-throw',
      payload: {
        kind: 'decision',
        action: reviewView.reviewPackage.validDecisions[0] as 'approve_outcome',
        reason: 'ok',
        acknowledgedRiskCodes: [],
      },
      issuedAt: NOW,
    });
    expect(decision.status).toBe(200);
    expect((decision.body as { outcome: string }).outcome).toBe('committed');
    expect(driveCommitted).toHaveBeenCalledOnce();
  });
});
