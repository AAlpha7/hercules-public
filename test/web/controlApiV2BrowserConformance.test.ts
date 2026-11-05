/**
 * @vitest-environment jsdom
 *
 * Wire-level two-client conformance: Node CLI client vs browser WebCrypto client
 * against independent in-process Hono apps (same seed + pinned clock). Asserts
 * byte-identical recorded requests and canonicalSerialize-equal raw responses.
 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '../../src/server/api.js';
import type { ActionService } from '../../src/orchestrator/actions.js';
import type { RuntimeView } from '../../src/orchestrator/orchestrator.js';
import { openIsolatedControlApiV2Deps } from '../../src/isolation/controlApiV2FakeProvider.js';
import {
  createControlApiV2Client,
  type ControlApiV2Client,
  type ControlApiV2Fetch,
} from '../../src/client/controlApiV2Client.js';
import {
  createControlApiV2BrowserClient,
  type ControlApiV2BrowserClient,
  type ControlApiV2BrowserFetch,
} from '../../src/web/controlApiV2Client.js';
import {
  buildConcurrencyToken,
  buildControlApiV2Request,
  buildIdempotencyKey,
  computeEventCursorHash,
  type ControlApiV2RequestV1,
  type ControlApiV2ReceiptV1,
} from '../../src/domain/controlApiV2.js';
import { canonicalSerialize } from '../../src/domain/canonicalJson.js';

const TOKEN = 'control-api-v2-browser-conformance-secret';
const NOW = '2026-09-01T00:00:00.000Z';
const ACTOR_ISSUER = 'hercules-second-client';
const ACTOR_ID = 'actor-1';
const FAKE_ENV = {
  HERCULES_ADAPTER: 'fake',
  HERCULES_FAKE_FAULT_INJECTION: '1',
  HERCULES_L2_ISOLATED: '1',
} as const;

interface RecordedCall {
  readonly path: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  readonly rawResponse: unknown;
  readonly status: number;
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

function makeApp() {
  const actions = new Proxy({}, { get() { throw new Error('no actions'); } }) as ActionService;
  const provider = openIsolatedControlApiV2Deps({ env: FAKE_ENV, now: () => NOW })!;
  return createApi({
    runtime: { getState: () => runtimeStub(), subscribe: () => () => {}, forceAbort: () => {} },
    actions,
    token: TOKEN,
    ...provider,
  });
}

function recordingFetch(
  inner: ControlApiV2Fetch | ControlApiV2BrowserFetch,
  sink: RecordedCall[],
): ControlApiV2BrowserFetch {
  return async (path, init) => {
    const response = await inner(path, init);
    const rawResponse = await response.json();
    sink.push({
      path,
      method: init.method,
      headers: { ...init.headers },
      body: init.body,
      rawResponse,
      status: response.status,
    });
    return {
      status: response.status,
      json: async () => rawResponse,
    };
  };
}

beforeEach(() => {
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') {
    vi.stubGlobal('crypto', webcrypto);
  }
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Control API V2 — browser vs Node wire conformance', () => {
  it('records byte-identical requests and canonical responses across the full sequence', async () => {
    const nodeCalls: RecordedCall[] = [];
    const browserCalls: RecordedCall[] = [];

    const nodeApp = makeApp();
    const browserApp = makeApp();

    const nodeClient: ControlApiV2Client = createControlApiV2Client({
      token: TOKEN,
      fetch: recordingFetch(honoFetch(nodeApp), nodeCalls) as ControlApiV2Fetch,
    });
    const browserClient: ControlApiV2BrowserClient = createControlApiV2BrowserClient({
      token: TOKEN,
      fetch: recordingFetch(honoFetch(browserApp), browserCalls),
    });

    const createInput = {
      actorIssuer: ACTOR_ISSUER,
      actorId: ACTOR_ID,
      clientRequestId: 'req-create-1',
      payload: {
        kind: 'create' as const,
        taskContractHash: 'sha256:' + 'a'.repeat(64),
        intentDigest: 'sha256:' + 'b'.repeat(64),
      },
      issuedAt: NOW,
    };

    // --- create ---
    const nodeCreate = await nodeClient.createTask(createInput);
    const browserCreate = await browserClient.createTask(createInput);
    expect(nodeCreate.status).toBe(200);
    expect(browserCreate.status).toBe(200);
    const nodeAggregateId = (nodeCreate.body as { aggregateId: string }).aggregateId;
    const browserAggregateId = (browserCreate.body as { aggregateId: string }).aggregateId;
    expect(browserAggregateId).toBe(nodeAggregateId);

    // --- status ---
    const nodeStatus = await nodeClient.readStatus({
      aggregateId: nodeAggregateId,
      issuedAt: NOW,
    });
    const browserStatus = await browserClient.readStatus({
      aggregateId: browserAggregateId,
      issuedAt: NOW,
    });
    expect(nodeStatus.status).toBe(200);
    expect(browserStatus.status).toBe(200);

    // --- review ---
    const nodeReview = await nodeClient.readReview({
      aggregateId: nodeAggregateId,
      issuedAt: NOW,
    });
    const browserReview = await browserClient.readReview({
      aggregateId: browserAggregateId,
      issuedAt: NOW,
    });
    expect(nodeReview.status).toBe(200);
    expect(browserReview.status).toBe(200);
    const nodeRv = nodeReview.body as {
      stateVersion: number;
      reviewPackage: {
        projectionHash: string;
        validDecisions: readonly ('approve_outcome' | 'reject_outcome' | 'request_changes')[];
      };
    };
    const browserRv = browserReview.body as {
      stateVersion: number;
      reviewPackage: { projectionHash: string };
    };
    expect(browserRv.stateVersion).toBe(nodeRv.stateVersion);
    expect(browserRv.reviewPackage.projectionHash).toBe(
      nodeRv.reviewPackage.projectionHash,
    );

    const preDecisionStateVersion = nodeRv.stateVersion;
    const preDecisionProjectionHash = nodeRv.reviewPackage.projectionHash;
    const decisionAction = nodeRv.reviewPackage.validDecisions[0]!;
    const decisionPayload = {
      kind: 'decision' as const,
      action: decisionAction,
      reason: 'ok',
      acknowledgedRiskCodes: [] as const,
    };

    // Build decision requests once (issuedAt is inside requestHash — never rebuild for retry).
    const nodeDecisionRequest: ControlApiV2RequestV1 = buildControlApiV2Request({
      resource: 'decision',
      operation: 'submit',
      aggregateId: nodeAggregateId,
      idempotencyKey: buildIdempotencyKey({
        actorIssuer: ACTOR_ISSUER,
        actorId: ACTOR_ID,
        aggregateId: nodeAggregateId,
        clientRequestId: 'req-decision-1',
      }),
      concurrencyToken: buildConcurrencyToken({
        aggregateId: nodeAggregateId,
        stateVersion: preDecisionStateVersion,
        projectionHash: preDecisionProjectionHash,
      }),
      payload: decisionPayload,
      issuedAt: NOW,
    });
    const browserDecisionRequest = await browserClient.prepareDecision({
      aggregateId: browserAggregateId,
      stateVersion: preDecisionStateVersion,
      projectionHash: preDecisionProjectionHash,
      actorIssuer: ACTOR_ISSUER,
      actorId: ACTOR_ID,
      clientRequestId: 'req-decision-1',
      payload: decisionPayload,
      issuedAt: NOW,
    });
    expect(canonicalSerialize(browserDecisionRequest)).toBe(
      canonicalSerialize(nodeDecisionRequest),
    );

    // --- decision ---
    const nodeDecision = await nodeClient.execute(nodeDecisionRequest);
    const browserDecision = await browserClient.execute(browserDecisionRequest);
    expect(nodeDecision.status).toBe(200);
    expect(browserDecision.status).toBe(200);

    // --- replay (identical request object) ---
    const nodeReplay = await nodeClient.execute(nodeDecisionRequest);
    const browserReplay = await browserClient.execute(browserDecisionRequest);
    expect(nodeReplay.status).toBe(200);
    expect(browserReplay.status).toBe(200);
    expect(canonicalSerialize(nodeReplay.body)).toBe(
      canonicalSerialize(nodeDecision.body),
    );
    expect(canonicalSerialize(browserReplay.body)).toBe(
      canonicalSerialize(browserDecision.body),
    );

    // --- conflict (same clientRequestId, different reason) ---
    const conflictPayload = {
      kind: 'decision' as const,
      action: decisionAction,
      reason: 'changed',
      acknowledgedRiskCodes: [] as const,
    };
    const nodeConflictReq = buildControlApiV2Request({
      resource: 'decision',
      operation: 'submit',
      aggregateId: nodeAggregateId,
      idempotencyKey: buildIdempotencyKey({
        actorIssuer: ACTOR_ISSUER,
        actorId: ACTOR_ID,
        aggregateId: nodeAggregateId,
        clientRequestId: 'req-decision-1',
      }),
      concurrencyToken: buildConcurrencyToken({
        aggregateId: nodeAggregateId,
        stateVersion: preDecisionStateVersion,
        projectionHash: preDecisionProjectionHash,
      }),
      payload: conflictPayload,
      issuedAt: NOW,
    });
    const browserConflictReq = await browserClient.prepareDecision({
      aggregateId: browserAggregateId,
      stateVersion: preDecisionStateVersion,
      projectionHash: preDecisionProjectionHash,
      actorIssuer: ACTOR_ISSUER,
      actorId: ACTOR_ID,
      clientRequestId: 'req-decision-1',
      payload: conflictPayload,
      issuedAt: NOW,
    });
    const nodeConflict = await nodeClient.execute(nodeConflictReq);
    const browserConflict = await browserClient.execute(browserConflictReq);
    expect(nodeConflict.status).toBe(409);
    expect(browserConflict.status).toBe(409);
    expect((nodeConflict.body as ControlApiV2ReceiptV1).reason).toBe(
      'idempotency_conflict',
    );
    expect((browserConflict.body as ControlApiV2ReceiptV1).reason).toBe(
      'idempotency_conflict',
    );

    // --- stale (new clientRequestId, pre-decision version/hash) ---
    const stalePayload = {
      kind: 'decision' as const,
      action: decisionAction,
      reason: 'ok',
      acknowledgedRiskCodes: [] as const,
    };
    const nodeStaleReq = buildControlApiV2Request({
      resource: 'decision',
      operation: 'submit',
      aggregateId: nodeAggregateId,
      idempotencyKey: buildIdempotencyKey({
        actorIssuer: ACTOR_ISSUER,
        actorId: ACTOR_ID,
        aggregateId: nodeAggregateId,
        clientRequestId: 'req-decision-stale',
      }),
      concurrencyToken: buildConcurrencyToken({
        aggregateId: nodeAggregateId,
        stateVersion: preDecisionStateVersion,
        projectionHash: preDecisionProjectionHash,
      }),
      payload: stalePayload,
      issuedAt: NOW,
    });
    const browserStaleReq = await browserClient.prepareDecision({
      aggregateId: browserAggregateId,
      stateVersion: preDecisionStateVersion,
      projectionHash: preDecisionProjectionHash,
      actorIssuer: ACTOR_ISSUER,
      actorId: ACTOR_ID,
      clientRequestId: 'req-decision-stale',
      payload: stalePayload,
      issuedAt: NOW,
    });
    const nodeStale = await nodeClient.execute(nodeStaleReq);
    const browserStale = await browserClient.execute(browserStaleReq);
    expect(nodeStale.status).toBe(409);
    expect(browserStale.status).toBe(409);
    expect((nodeStale.body as ControlApiV2ReceiptV1).reason).toBe('stale_version');
    expect((browserStale.body as ControlApiV2ReceiptV1).reason).toBe('stale_version');

    // --- events ---
    const browserCursor = await browserClient.buildEventCursor({
      afterSequence: 0,
      expectedPreviousEventHash: null,
      limit: 10,
    });
    const nodeCursorWithout = {
      schema: 'hercules-control-api-event-cursor/v2' as const,
      afterSequence: 0,
      expectedPreviousEventHash: null,
      limit: 10,
    };
    const nodeCursor = {
      ...nodeCursorWithout,
      cursorHash: computeEventCursorHash(nodeCursorWithout),
    };
    expect(canonicalSerialize(browserCursor)).toBe(canonicalSerialize(nodeCursor));

    const nodeEvents = await nodeClient.readEvents({
      cursor: nodeCursor,
      issuedAt: NOW,
    });
    const browserEvents = await browserClient.readEvents({
      cursor: browserCursor,
      issuedAt: NOW,
    });
    expect(nodeEvents.status).toBe(200);
    expect(browserEvents.status).toBe(200);

    // Per-step wire assertions (create, status, review, decision, replay, conflict, stale, events).
    expect(nodeCalls).toHaveLength(8);
    expect(browserCalls).toHaveLength(8);
    const stepNames = [
      'create',
      'status',
      'review',
      'decision',
      'replay',
      'conflict',
      'stale',
      'events',
    ] as const;
    for (let i = 0; i < stepNames.length; i += 1) {
      const n = nodeCalls[i]!;
      const b = browserCalls[i]!;
      expect(b.status, stepNames[i]).toBe(n.status);
      expect(
        { path: b.path, method: b.method, headers: b.headers, body: b.body },
        stepNames[i],
      ).toEqual({
        path: n.path,
        method: n.method,
        headers: n.headers,
        body: n.body,
      });
      expect(canonicalSerialize(b.rawResponse), stepNames[i]).toBe(
        canonicalSerialize(n.rawResponse),
      );
    }

    // Expose decision request bodies for the acceptance report.
    expect(nodeCalls[3]!.body).toBe(browserCalls[3]!.body);
    expect(typeof nodeCalls[3]!.body).toBe('string');
  });
});
