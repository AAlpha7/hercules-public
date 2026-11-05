import { describe, expect, it, vi } from 'vitest';
import {
  createApi,
  type ReviewActorResolverV1,
  type ReviewDecisionAuthorityV1,
  type ReviewDecisionPortV1,
  type ReviewPackageV2SourceReadPort,
} from '../../src/server/api.js';
import {
  reviewDecisionBindingHash,
  reviewDecisionReceiptHash,
  reviewDecisionRequestHash,
  type ReviewDecisionReceiptV1,
  type ReviewDecisionRequestV1,
} from '../../src/domain/reviewDecision.js';
import { projectAndAssertReviewPackageV2 } from '../../src/domain/reviewPackageV2.js';
import type { ActionService } from '../../src/orchestrator/actions.js';
import type { RuntimeView } from '../../src/orchestrator/orchestrator.js';
import { reviewPackageV2SourceFixture } from '../fixtures/reviewPackageV2Source.js';

const TOKEN = 'review-decisions-secret';
const auth = {
  authorization: `Bearer ${TOKEN}`,
  'content-type': 'application/json',
};
const actor = { kind: 'human' as const, id: 'operator-1', issuer: 'fixture-issuer' };

function sourcePort(
  source = reviewPackageV2SourceFixture(),
): ReviewPackageV2SourceReadPort {
  return { read: vi.fn(async () => ({ status: 'available' as const, source })) };
}

function actorResolver(): ReviewActorResolverV1 {
  return { isReady: vi.fn(() => true), resolveActor: vi.fn(async () => actor) };
}

function request(
  source = reviewPackageV2SourceFixture(),
  overrides: Readonly<Record<string, unknown>> = {},
): ReviewDecisionRequestV1 {
  const packageValue = projectAndAssertReviewPackageV2(source);
  if (packageValue.decisionBinding === null) throw new Error('fixture must be actionable');
  return {
    schema: 'hercules-review-decision-request/v1',
    clientRequestId: 'request-1',
    taskId: source.task.id,
    projectionHash: packageValue.projectionHash,
    decisionBinding: packageValue.decisionBinding,
    action: 'request_changes',
    reason: 'Please repair the verified issue.',
    acknowledgedRiskCodes: [],
    ...overrides,
  } as ReviewDecisionRequestV1;
}

function receiptFor(
  decisionRequest: ReviewDecisionRequestV1,
  overrides: Partial<ReviewDecisionReceiptV1> = {},
): ReviewDecisionReceiptV1 {
  const priorIterationId = decisionRequest.decisionBinding.iterationId!;
  const body = {
    schema: 'hercules-review-decision-receipt/v1' as const,
    clientRequestId: decisionRequest.clientRequestId,
    requestHash: reviewDecisionRequestHash(decisionRequest),
    taskId: decisionRequest.taskId,
    actor,
    acceptedProjectionHash: decisionRequest.projectionHash,
    acceptedDecisionBindingHash: reviewDecisionBindingHash(decisionRequest.decisionBinding),
    action: decisionRequest.action,
    humanDecisionId: 'decision-1',
    eventId: 'event-1',
    priorIterationId,
    resultingIterationId:
      decisionRequest.action === 'request_changes' ? 'iteration-2' : priorIterationId,
    recordedAt: '2026-08-29T10:00:00.000Z',
    ...overrides,
  };
  return { ...body, receiptHash: reviewDecisionReceiptHash(body) };
}

function decisionPort(
  input: Readonly<{
    lookup?: ReviewDecisionPortV1['lookup'];
    apply?: ReviewDecisionPortV1['apply'];
    validate?: ReviewDecisionPortV1['validateCommittedReceipt'];
    ready?: boolean;
  }> = {},
): ReviewDecisionPortV1 {
  return {
    isReady: vi.fn(() => input.ready ?? true),
    lookup: vi.fn(input.lookup ?? (async () => null)),
    apply: vi.fn(input.apply ?? (async (command) => ({
      kind: 'committed' as const,
      receipt: receiptFor(command.request),
    }))),
    validateCommittedReceipt: vi.fn(input.validate ?? (async () => ({ kind: 'valid' as const }))),
  };
}

function api(input: Readonly<{
  source?: ReviewPackageV2SourceReadPort;
  actor?: ReviewActorResolverV1;
  decisions?: ReviewDecisionPortV1;
  separateAuthorities?: boolean;
}> = {}) {
  const view: RuntimeView = {
    snapshot: { repos: { repos: {} }, tasks: [], problems: [] },
    running: [], stopping: [], activity: {}, pendingChat: {}, liveRuns: {},
    lastReport: null, agents: { default: 'fake', available: ['fake'] },
  };
  const actions = new Proxy({}, {
    get() { throw new Error('V2 review decisions must not call legacy actions'); },
  }) as ActionService;
  const authority: ReviewDecisionAuthorityV1 | undefined =
    input.source === undefined || input.decisions === undefined
      ? undefined
      : {
          read: input.source.read,
          isReady: input.decisions.isReady,
          lookup: input.decisions.lookup,
          apply: input.decisions.apply,
          validateCommittedReceipt: input.decisions.validateCommittedReceipt,
        };
  return createApi({
    runtime: { getState: () => view, subscribe: () => () => {}, forceAbort: () => {} },
    actions,
    token: TOKEN,
    ...(input.source === undefined
      ? {}
      : { reviewPackageV2: input.separateAuthorities ? input.source : authority ?? input.source }),
    ...(input.actor === undefined ? {} : { reviewDecisionActor: input.actor }),
    ...(authority === undefined ? {} : { reviewDecisions: authority }),
  });
}

async function post(app: ReturnType<typeof api>, value: unknown, path = 'task-1') {
  return app.request(`/api/v2/tasks/${path}/review-decisions`, {
    method: 'POST', headers: auth, body: JSON.stringify(value),
  });
}

describe('M7 bound review decisions', () => {
  it('fails closed when the display source and decision authority are different objects', async () => {
    const source = sourcePort();
    const resolver = actorResolver();
    const decisions = decisionPort();
    const application = api({
      source,
      actor: resolver,
      decisions,
      separateAuthorities: true,
    });
    expect((await post(application, request())).status).toBe(503);
    expect(resolver.resolveActor).not.toHaveBeenCalled();
    expect(source.read).not.toHaveBeenCalled();
    expect(decisions.lookup).not.toHaveBeenCalled();
  });

  it('requires auth and all ready dependencies before actor or source reads', async () => {
    const source = sourcePort();
    const resolver = actorResolver();
    const decisions = decisionPort({ ready: false });
    const application = api({ source, actor: resolver, decisions });
    expect((await application.request('/api/v2/tasks/task-1/review-decisions', {
      method: 'POST', body: JSON.stringify(request()),
      headers: { 'content-type': 'application/json' },
    })).status).toBe(401);
    expect((await post(application, request())).status).toBe(503);
    expect(resolver.resolveActor).not.toHaveBeenCalled();
    expect(source.read).not.toHaveBeenCalled();
    expect(decisions.lookup).not.toHaveBeenCalled();
  });

  it('rejects caller actor, unknown fields, URL mismatch, and malformed binding before lookup', async () => {
    const source = sourcePort();
    const resolver = actorResolver();
    const decisions = decisionPort();
    const application = api({ source, actor: resolver, decisions });
    for (const [value, path] of [
      [{ ...request(), actor }, 'task-1'],
      [{ ...request(), trusted: true }, 'task-1'],
      [request(), 'task-2'],
      [{ ...request(), decisionBinding: { ...request().decisionBinding, taskId: 'task-2' } }, 'task-1'],
    ] as const) {
      expect((await post(application, value, path)).status).toBe(400);
    }
    expect(source.read).not.toHaveBeenCalled();
    expect(decisions.lookup).not.toHaveBeenCalled();
    expect(resolver.resolveActor).toHaveBeenCalledTimes(4);
  });

  it('fails closed on missing actor, lookup failure, and unavailable authoritative source', async () => {
    const source = sourcePort();
    const decisions = decisionPort();
    const missingActor: ReviewActorResolverV1 = {
      isReady: () => true,
      resolveActor: vi.fn(async () => null),
    };
    expect((await post(api({ source, actor: missingActor, decisions }), request())).status).toBe(503);
    expect(decisions.lookup).not.toHaveBeenCalled();
    expect(source.read).not.toHaveBeenCalled();

    const lookupFailure = decisionPort({ lookup: async () => { throw new Error('store down'); } });
    expect((await post(api({ source, actor: actorResolver(), decisions: lookupFailure }), request())).status).toBe(503);
    expect(source.read).not.toHaveBeenCalled();
    expect(lookupFailure.apply).not.toHaveBeenCalled();

    const notFound: ReviewPackageV2SourceReadPort = {
      read: vi.fn(async () => ({ status: 'not_found' as const })),
    };
    expect((await post(api({
      source: notFound, actor: actorResolver(), decisions: decisionPort(),
    }), request())).status).toBe(404);
    const unavailable: ReviewPackageV2SourceReadPort = {
      read: vi.fn(async () => ({ status: 'unavailable' as const, reason: 'integrity_unavailable' as const })),
    };
    expect((await post(api({
      source: unavailable, actor: actorResolver(), decisions: decisionPort(),
    }), request())).status).toBe(503);
  });

  it('submits an exact freshly bound command and validates the durable receipt', async () => {
    const source = sourcePort();
    const resolver = actorResolver();
    const decisions = decisionPort();
    const value = request();
    const response = await post(api({ source, actor: resolver, decisions }), value);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      schema: 'hercules-review-decision-response/v1',
      receipt: receiptFor(value),
      duplicate: false,
    });
    expect(decisions.lookup).toHaveBeenCalledWith({
      actorIssuer: actor.issuer,
      actorId: actor.id,
      taskId: 'task-1',
      clientRequestId: 'request-1',
    });
    expect(decisions.apply).toHaveBeenCalledWith({
      request: value,
      requestHash: reviewDecisionRequestHash(value),
      actor,
      expectedProjectionHash: value.projectionHash,
      expectedDecisionBindingHash: reviewDecisionBindingHash(value.decisionBinding),
    });
    expect(decisions.validateCommittedReceipt).toHaveBeenCalledWith({
      key: {
        actorIssuer: actor.issuer, actorId: actor.id,
        taskId: 'task-1', clientRequestId: 'request-1',
      },
      requestHash: reviewDecisionRequestHash(value),
      receipt: receiptFor(value),
    });
  });

  it('replays an exact stored receipt before reading current source or applying again', async () => {
    const value = request();
    const source = sourcePort();
    const decisions = decisionPort({ lookup: async () => receiptFor(value) });
    const response = await post(api({ source, actor: actorResolver(), decisions }), value);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ duplicate: true, receipt: receiptFor(value) });
    expect(source.read).not.toHaveBeenCalled();
    expect(decisions.apply).not.toHaveBeenCalled();
    expect(decisions.validateCommittedReceipt).toHaveBeenCalledOnce();
  });

  it('validates an apply-time duplicate before returning the replay marker', async () => {
    const value = request();
    const decisions = decisionPort({ apply: async () => ({
      kind: 'duplicate', receipt: receiptFor(value),
    }) });
    const response = await post(api({
      source: sourcePort(), actor: actorResolver(), decisions,
    }), value);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ duplicate: true, receipt: receiptFor(value) });
    expect(decisions.validateCommittedReceipt).toHaveBeenCalledOnce();
  });

  it('rejects a conflicting idempotency replay without reading or mutating current state', async () => {
    const original = request();
    const changed = request(undefined, { reason: 'A different repair request.' });
    const source = sourcePort();
    const decisions = decisionPort({ lookup: async () => receiptFor(original) });
    const response = await post(api({ source, actor: actorResolver(), decisions }), changed);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'idempotency_conflict' });
    expect(source.read).not.toHaveBeenCalled();
    expect(decisions.apply).not.toHaveBeenCalled();
    expect(decisions.validateCommittedReceipt).not.toHaveBeenCalled();
  });

  it('rejects stale projection, stale binding, and ineligible actions before apply', async () => {
    const source = sourcePort();
    const decisions = decisionPort();
    const application = api({ source, actor: actorResolver(), decisions });
    expect((await post(application, request(undefined, {
      projectionHash: `sha256:${'0'.repeat(64)}`,
    }))).status).toBe(409);
    expect((await post(application, request(undefined, {
      decisionBinding: { ...request().decisionBinding, policyVersion: 'policy-v2' },
    }))).status).toBe(409);
    expect((await post(application, request(undefined, {
      action: 'approve_outcome', reason: null,
    }))).status).toBe(422);
    const ineligibleSource = { ...reviewPackageV2SourceFixture(), evaluation: null };
    const ineligiblePackage = projectAndAssertReviewPackageV2(ineligibleSource);
    expect(ineligiblePackage.decisionBinding).toBeNull();
    expect((await post(api({
      source: sourcePort(ineligibleSource), actor: actorResolver(), decisions,
    }), request(undefined, {
      projectionHash: ineligiblePackage.projectionHash,
    }))).status).toBe(422);
    expect(decisions.apply).not.toHaveBeenCalled();
  });

  it('requires exact risk acknowledgement for approve/reject and no acknowledgement for request changes', async () => {
    const humanSource = reviewPackageV2SourceFixture({
      requiresHumanDecision: true,
      remainingRiskCode: 'risk-a',
    });
    const decisions = decisionPort();
    const application = api({ source: sourcePort(humanSource), actor: actorResolver(), decisions });
    const approve = request(humanSource, {
      action: 'approve_outcome', reason: null, acknowledgedRiskCodes: ['risk-a'],
    });
    expect((await post(application, approve)).status).toBe(200);
    expect((await post(application, request(humanSource, {
      clientRequestId: 'request-2', action: 'reject_outcome', reason: null,
      acknowledgedRiskCodes: [],
    }))).status).toBe(400);
    expect((await post(application, request(humanSource, {
      clientRequestId: 'request-3', acknowledgedRiskCodes: ['risk-a'],
    }))).status).toBe(400);
  });

  it('requires request-changes reason and forbids reasons on approve/reject', async () => {
    const humanSource = reviewPackageV2SourceFixture({ requiresHumanDecision: true });
    const passApplication = api({
      source: sourcePort(), actor: actorResolver(), decisions: decisionPort(),
    });
    const humanApplication = api({
      source: sourcePort(humanSource), actor: actorResolver(), decisions: decisionPort(),
    });
    expect((await post(passApplication, request(undefined, { reason: null }))).status).toBe(400);
    expect((await post(passApplication, request(undefined, { reason: '   ' }))).status).toBe(400);
    expect((await post(humanApplication, request(humanSource, {
      action: 'approve_outcome', reason: 'not allowed', acknowledgedRiskCodes: [],
    }))).status).toBe(400);
  });

  it.each([
    ['stale', 409],
    ['idempotency_conflict', 409],
    ['unavailable', 503],
  ] as const)('maps apply %s closed', async (kind, status) => {
    const decisions = decisionPort({ apply: async () => kind === 'unavailable'
      ? { kind, reason: 'transaction_unavailable' }
      : { kind } });
    const response = await post(api({
      source: sourcePort(), actor: actorResolver(), decisions,
    }), request());
    expect(response.status).toBe(status);
    expect(decisions.validateCommittedReceipt).not.toHaveBeenCalled();
  });

  it('fails closed on forged, mismatched, or durably invalid receipts', async () => {
    const value = request();
    for (const decisions of [
      decisionPort({ apply: async () => ({
        kind: 'committed',
        receipt: { ...receiptFor(value), eventId: 'forged-event' },
      }) }),
      decisionPort({ apply: async () => ({
        kind: 'committed',
        receipt: receiptFor(value, { actor: { ...actor, issuer: 'other-issuer' } }),
      }) }),
      decisionPort({ validate: async () => ({ kind: 'invalid' }) }),
      decisionPort({ validate: async () => ({ kind: 'unavailable' }) }),
    ]) {
      const response = await post(api({
        source: sourcePort(), actor: actorResolver(), decisions,
      }), value);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ reason: 'provider_contract_violation' });
    }
  });
});
