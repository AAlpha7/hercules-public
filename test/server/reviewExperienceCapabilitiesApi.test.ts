import { describe, expect, it, vi } from 'vitest';
import {
  createApi,
  type LearningProposalReadPort,
  type ReviewActorResolverV1,
  type ReviewDecisionAuthorityV1,
  type ReviewDecisionPortV1,
  type ReviewEvidenceReadPort,
  type ReviewPackageV2SourceReadPort,
} from '../../src/server/api.js';
import type { ActionService } from '../../src/orchestrator/actions.js';
import type { RuntimeView } from '../../src/orchestrator/orchestrator.js';
import { openIsolatedControlApiV2Deps } from '../../src/isolation/controlApiV2FakeProvider.js';

const TOKEN = 'review-capabilities-secret';
const auth = { headers: { authorization: `Bearer ${TOKEN}` } };

function api(
  reviewPackageV2?: ReviewPackageV2SourceReadPort,
  reviewEvidence?: ReviewEvidenceReadPort,
  learningProposals?: LearningProposalReadPort,
  reviewDecisionActor?: ReviewActorResolverV1,
  reviewDecisions?: ReviewDecisionAuthorityV1,
  controlApiV2?: ReturnType<typeof openIsolatedControlApiV2Deps>,
) {
  const view: RuntimeView = {
    snapshot: { repos: { repos: {} }, tasks: [], problems: [] },
    running: [],
    stopping: [],
    activity: {},
    pendingChat: {},
    liveRuns: {},
    lastReport: null,
    agents: { default: 'fake', available: ['fake'] },
  };
  const getState = vi.fn(() => view);
  const subscribe = vi.fn(() => () => {});
  const forceAbort = vi.fn();
  const actions = new Proxy(
    {},
    {
      get() {
        throw new Error('capabilities route must not call actions');
      },
    },
  ) as ActionService;
  const app = createApi({
    runtime: { getState, subscribe, forceAbort },
    actions,
    token: TOKEN,
    ...(reviewPackageV2 === undefined ? {} : { reviewPackageV2 }),
    ...(reviewEvidence === undefined ? {} : { reviewEvidence }),
    ...(learningProposals === undefined ? {} : { learningProposals }),
    ...(reviewDecisionActor === undefined ? {} : { reviewDecisionActor }),
    ...(reviewDecisions === undefined ? {} : { reviewDecisions }),
    ...(controlApiV2 === undefined ? {} : controlApiV2),
  });
  return { app, getState, subscribe, forceAbort };
}

describe('GET /api/v2/review-experience/capabilities', () => {
  it('requires Bearer auth and rejects a query token', async () => {
    const { app } = api();
    expect((await app.request('/api/v2/review-experience/capabilities')).status).toBe(401);
    expect(
      (await app.request(
        `/api/v2/review-experience/capabilities?token=${TOKEN}`,
      )).status,
    ).toBe(401);
  });

  it('fails closed when no review-package source is injected', async () => {
    const { app, getState, subscribe, forceAbort } = api();
    const response = await app.request(
      '/api/v2/review-experience/capabilities',
      auth,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      schema: 'hercules-review-experience-capabilities/v1',
      outcomeReviewRead: false,
      boundDecisions: false,
      evidenceContent: false,
      learningProposals: false,
      controlApiV2: false,
    });
    expect(getState).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(forceAbort).not.toHaveBeenCalled();
  });

  it('advertises only outcome review read without invoking the source', async () => {
    const read = vi.fn(async () => ({ status: 'not_found' as const }));
    const { app, getState, subscribe, forceAbort } = api({ read });
    const response = await app.request(
      '/api/v2/review-experience/capabilities',
      auth,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      schema: 'hercules-review-experience-capabilities/v1',
      outcomeReviewRead: true,
      boundDecisions: false,
      evidenceContent: false,
      learningProposals: false,
      controlApiV2: false,
    });
    expect(read).not.toHaveBeenCalled();
    expect(getState).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(forceAbort).not.toHaveBeenCalled();
  });

  it('advertises optional reads only when each real port and the review source are injected', async () => {
    const read = vi.fn(async () => ({ status: 'not_found' as const }));
    const resolveActor = vi.fn(async () => ({
      kind: 'human' as const, id: 'operator-1', issuer: 'fixture-issuer',
    }));
    const readEvidence = vi.fn<ReviewEvidenceReadPort['read']>();
    const readLearning = vi.fn<LearningProposalReadPort['read']>();
    const evidence: ReviewEvidenceReadPort = {
      isReady: () => true, resolveActor, read: readEvidence,
    };
    const learning: LearningProposalReadPort = { isReady: () => true, read: readLearning };

    const withoutSource = await api(undefined, evidence, learning).app.request(
      '/api/v2/review-experience/capabilities', auth,
    );
    expect(await withoutSource.json()).toMatchObject({
      outcomeReviewRead: false, evidenceContent: false, learningProposals: false,
    });

    const withSource = await api({ read }, evidence, learning).app.request(
      '/api/v2/review-experience/capabilities', auth,
    );
    expect(await withSource.json()).toEqual({
      schema: 'hercules-review-experience-capabilities/v1',
      outcomeReviewRead: true,
      boundDecisions: false,
      evidenceContent: true,
      learningProposals: true,
      controlApiV2: false,
    });
    expect(read).not.toHaveBeenCalled();
    expect(resolveActor).not.toHaveBeenCalled();
    expect(readEvidence).not.toHaveBeenCalled();
    expect(readLearning).not.toHaveBeenCalled();
  });

  it('fails capabilities closed when optional ports are not ready or readiness throws', async () => {
    const reviewPackageV2 = { read: vi.fn(async () => ({ status: 'not_found' as const })) };
    const reviewEvidence: ReviewEvidenceReadPort = {
      isReady: () => false,
      resolveActor: vi.fn(),
      read: vi.fn(),
    };
    const learningProposals: LearningProposalReadPort = {
      isReady: () => { throw new Error('private startup failure'); },
      read: vi.fn(),
    };
    const response = await api(reviewPackageV2, reviewEvidence, learningProposals).app.request(
      '/api/v2/review-experience/capabilities', auth,
    );
    expect(await response.json()).toMatchObject({
      outcomeReviewRead: true,
      evidenceContent: false,
      learningProposals: false,
    });
    expect(reviewPackageV2.read).not.toHaveBeenCalled();
    expect(reviewEvidence.resolveActor).not.toHaveBeenCalled();
    expect(reviewEvidence.read).not.toHaveBeenCalled();
    expect(learningProposals.read).not.toHaveBeenCalled();
  });

  it('fails every source-dependent capability closed when the source is unhealthy', async () => {
    const read = vi.fn(async () => ({ status: 'not_found' as const }));
    const evidence: ReviewEvidenceReadPort = {
      isReady: () => true,
      resolveActor: vi.fn(),
      read: vi.fn(),
    };
    const learning: LearningProposalReadPort = { isReady: () => true, read: vi.fn() };

    for (const isReady of [() => false, () => { throw new Error('integrity failure'); }]) {
      const source: ReviewPackageV2SourceReadPort & { isReady(): boolean } = {
        isReady,
        read,
      };
      const response = await api(source, evidence, learning).app.request(
        '/api/v2/review-experience/capabilities',
        auth,
      );
      expect(await response.json()).toEqual({
        schema: 'hercules-review-experience-capabilities/v1',
        outcomeReviewRead: false,
        boundDecisions: false,
        evidenceContent: false,
        learningProposals: false,
        controlApiV2: false,
      });
    }
    expect(read).not.toHaveBeenCalled();
    expect(evidence.resolveActor).not.toHaveBeenCalled();
    expect(evidence.read).not.toHaveBeenCalled();
    expect(learning.read).not.toHaveBeenCalled();
  });

  it('advertises controlApiV2 when the three Control API V2 ports are injected', async () => {
    const control = openIsolatedControlApiV2Deps({
      env: {
        HERCULES_ADAPTER: 'fake',
        HERCULES_FAKE_FAULT_INJECTION: '1',
        HERCULES_L2_ISOLATED: '1',
      },
      now: () => '2026-09-01T00:00:00.000Z',
      seedTaskIds: [],
    });
    expect(control).toBeDefined();
    const { app } = api(undefined, undefined, undefined, undefined, undefined, control);
    const response = await app.request('/api/v2/review-experience/capabilities', auth);
    expect(await response.json()).toEqual({
      schema: 'hercules-review-experience-capabilities/v1',
      outcomeReviewRead: false,
      boundDecisions: false,
      evidenceContent: false,
      learningProposals: false,
      controlApiV2: true,
    });
  });

  it('advertises bound decisions only with a ready source, actor resolver, and transactional port', async () => {
    const source = { read: vi.fn(async () => ({ status: 'not_found' as const })) };
    const actorResolver: ReviewActorResolverV1 = {
      isReady: vi.fn(() => true),
      resolveActor: vi.fn(),
    };
    const decisionPort: ReviewDecisionPortV1 = {
      isReady: vi.fn(() => true),
      lookup: vi.fn(),
      apply: vi.fn(),
      validateCommittedReceipt: vi.fn(),
    };
    const decisions: ReviewDecisionAuthorityV1 = {
      ...decisionPort,
      read: source.read,
    };
    const missingActor = await api(
      source, undefined, undefined, undefined, decisions,
    ).app.request('/api/v2/review-experience/capabilities', auth);
    expect(await missingActor.json()).toMatchObject({ boundDecisions: false });

    const mismatched = await api(
      source, undefined, undefined, actorResolver, decisions,
    ).app.request('/api/v2/review-experience/capabilities', auth);
    expect(await mismatched.json()).toMatchObject({ boundDecisions: false });

    const ready = await api(
      decisions, undefined, undefined, actorResolver, decisions,
    ).app.request('/api/v2/review-experience/capabilities', auth);
    expect(await ready.json()).toMatchObject({
      outcomeReviewRead: true,
      boundDecisions: true,
    });
    expect(source.read).not.toHaveBeenCalled();
    expect(actorResolver.resolveActor).not.toHaveBeenCalled();
    expect(decisions.lookup).not.toHaveBeenCalled();
    expect(decisions.apply).not.toHaveBeenCalled();
    expect(decisions.validateCommittedReceipt).not.toHaveBeenCalled();

    vi.mocked(decisions.isReady).mockImplementation(() => {
      throw new Error('startup check failed');
    });
    const unavailable = await api(
      decisions, undefined, undefined, actorResolver, decisions,
    ).app.request('/api/v2/review-experience/capabilities', auth);
    expect(await unavailable.json()).toMatchObject({ boundDecisions: false });
  });
});
