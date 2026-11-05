import { describe, expect, it, vi } from 'vitest';
import {
  createApi,
  type LearningProposalReadPort,
  type ReviewEvidenceReadPort,
  type ReviewPackageV2SourceReadPort,
} from '../../src/server/api.js';
import { projectAndAssertReviewPackageV2 } from '../../src/domain/reviewPackageV2.js';
import type { ActionService } from '../../src/orchestrator/actions.js';
import type { RuntimeView } from '../../src/orchestrator/orchestrator.js';
import {
  REVIEW_EVIDENCE_FIXTURE_BYTES,
  REVIEW_EVIDENCE_FIXTURE_DIGEST,
  reviewPackageV2SourceFixture,
} from '../fixtures/reviewPackageV2Source.js';

const TOKEN = 'review-reads-secret';
const auth = { headers: { authorization: `Bearer ${TOKEN}` } };
const actor = { kind: 'human' as const, id: 'operator-1', issuer: 'fixture-issuer' };

function sourcePort(
  read: ReviewPackageV2SourceReadPort['read'] = async () => ({
    status: 'available',
    source: reviewPackageV2SourceFixture(),
  }),
): ReviewPackageV2SourceReadPort {
  return { read };
}

function evidencePort(
  read: ReviewEvidenceReadPort['read'] = async (request) => ({
    status: 'available',
    sha256: request.sha256,
    mediaType: 'application/json',
    redactionState: 'none',
    bytes: REVIEW_EVIDENCE_FIXTURE_BYTES,
  }),
): ReviewEvidenceReadPort {
  return { isReady: vi.fn(() => true), resolveActor: vi.fn(async () => actor), read: vi.fn(read) };
}

function app(input: {
  source?: ReviewPackageV2SourceReadPort;
  evidence?: ReviewEvidenceReadPort;
  learning?: LearningProposalReadPort;
} = {}) {
  const view: RuntimeView = {
    snapshot: { repos: { repos: {} }, tasks: [], problems: [] },
    running: [], stopping: [], activity: {}, pendingChat: {}, liveRuns: {},
    lastReport: null, agents: { default: 'fake', available: ['fake'] },
  };
  const actions = new Proxy({}, {
    get() { throw new Error('review read routes must not call actions'); },
  }) as ActionService;
  return createApi({
    runtime: { getState: () => view, subscribe: () => () => {}, forceAbort: () => {} },
    actions,
    token: TOKEN,
    ...(input.source === undefined ? {} : { reviewPackageV2: input.source }),
    ...(input.evidence === undefined ? {} : { reviewEvidence: input.evidence }),
    ...(input.learning === undefined ? {} : { learningProposals: input.learning }),
  });
}

function currentProjectionHash(): string {
  return projectAndAssertReviewPackageV2(reviewPackageV2SourceFixture()).projectionHash;
}

function evidenceBody(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    schema: 'hercules-review-evidence-read/v1',
    taskId: 'task-1',
    projectionHash: currentProjectionHash(),
    artifactRefId: 'artifact-1',
    ...overrides,
  });
}

describe('M7 evidence reads', () => {
  it('keeps direct routes closed when optional ports are not ready', async () => {
    const source = sourcePort(vi.fn(async () => ({
      status: 'available' as const, source: reviewPackageV2SourceFixture(),
    })));
    const evidence = evidencePort();
    vi.mocked(evidence.isReady).mockReturnValue(false);
    const evidenceResponse = await app({ source, evidence }).request(
      '/api/v2/tasks/task-1/review-evidence',
      {
        method: 'POST', body: evidenceBody(),
        headers: { ...auth.headers, 'content-type': 'application/json' },
      },
    );
    expect(evidenceResponse.status).toBe(503);
    expect(source.read).not.toHaveBeenCalled();
    expect(evidence.read).not.toHaveBeenCalled();

    const learning: LearningProposalReadPort = {
      isReady: () => false,
      read: vi.fn(),
    };
    const learningResponse = await app({ source, learning }).request(
      `/api/v2/tasks/task-1/learning-proposals?projectionHash=${encodeURIComponent(currentProjectionHash())}`,
      auth,
    );
    expect(learningResponse.status).toBe(503);
    expect(source.read).not.toHaveBeenCalled();
    expect(learning.read).not.toHaveBeenCalled();
  });

  it('requires header auth and rejects non-exact or path-mismatched requests before ports', async () => {
    const source = sourcePort(vi.fn(async () => ({ status: 'available' as const, source: reviewPackageV2SourceFixture() })));
    const evidence = evidencePort();
    expect((await app({ source, evidence }).request('/api/v2/tasks/task-1/review-evidence', {
      method: 'POST', body: evidenceBody(), headers: { 'content-type': 'application/json' },
    })).status).toBe(401);
    for (const body of [
      evidenceBody({ extra: true }),
      evidenceBody({ taskId: 'task-2' }),
      evidenceBody({ projectionHash: 'bad' }),
    ]) {
      const response = await app({ source, evidence }).request(
        '/api/v2/tasks/task-1/review-evidence',
        { method: 'POST', body, headers: { ...auth.headers, 'content-type': 'application/json' } },
      );
      expect(response.status).toBe(400);
    }
    expect(source.read).not.toHaveBeenCalled();
    expect(evidence.read).not.toHaveBeenCalled();
  });

  it('rejects stale projections and non-member artifacts before evidence authority', async () => {
    const evidence = evidencePort();
    const stale = await app({ source: sourcePort(), evidence }).request(
      '/api/v2/tasks/task-1/review-evidence',
      {
        method: 'POST',
        body: evidenceBody({ projectionHash: `sha256:${'0'.repeat(64)}` }),
        headers: { ...auth.headers, 'content-type': 'application/json' },
      },
    );
    expect(stale.status).toBe(409);
    const missing = await app({ source: sourcePort(), evidence }).request(
      '/api/v2/tasks/task-1/review-evidence',
      {
        method: 'POST',
        body: evidenceBody({ artifactRefId: 'artifact-404' }),
        headers: { ...auth.headers, 'content-type': 'application/json' },
      },
    );
    expect(missing.status).toBe(404);
    expect(evidence.read).not.toHaveBeenCalled();
  });

  it('binds the trusted actor and exact current evidence, then revalidates before returning text', async () => {
    const source = sourcePort(vi.fn(async () => ({ status: 'available' as const, source: reviewPackageV2SourceFixture() })));
    const evidence = evidencePort();
    const response = await app({ source, evidence }).request(
      '/api/v2/tasks/task-1/review-evidence',
      {
        method: 'POST', body: evidenceBody(),
        headers: { ...auth.headers, 'content-type': 'application/json' },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      schema: 'hercules-review-evidence-content/v1',
      kind: 'text',
      artifactRefId: 'artifact-1',
      sha256: REVIEW_EVIDENCE_FIXTURE_DIGEST,
      mediaType: 'application/json',
      redactionState: 'none',
      text: '{"passed":true}',
    });
    expect(source.read).toHaveBeenCalledTimes(2);
    expect(evidence.resolveActor).toHaveBeenCalledOnce();
    expect(evidence.read).toHaveBeenCalledWith({
      schema: 'hercules-review-evidence-read/v1',
      taskId: 'task-1',
      projectionHash: currentProjectionHash(),
      artifactRefId: 'artifact-1',
      actor,
      sha256: REVIEW_EVIDENCE_FIXTURE_DIGEST,
      redactionState: 'none',
      purpose: 'operator_review',
    });
  });

  it('fails closed when a port reports the bound digest for different bytes', async () => {
    const response = await app({ source: sourcePort(), evidence: evidencePort(async () => ({
      status: 'available', sha256: REVIEW_EVIDENCE_FIXTURE_DIGEST,
      mediaType: 'text/plain', redactionState: 'none',
      bytes: new TextEncoder().encode('different bytes'),
    })) }).request('/api/v2/tasks/task-1/review-evidence', {
      method: 'POST', body: evidenceBody(),
      headers: { ...auth.headers, 'content-type': 'application/json' },
    });
    expect(response.status).toBe(503);
  });

  it.each([
    ['digest mismatch', REVIEW_EVIDENCE_FIXTURE_BYTES, async () => ({
      status: 'available' as const, sha256: `sha256:${'d'.repeat(64)}`,
      mediaType: 'text/plain', redactionState: 'none' as const,
      bytes: REVIEW_EVIDENCE_FIXTURE_BYTES,
    })],
    ['invalid UTF-8', Uint8Array.from([0xc3, 0x28]), async (request: Parameters<ReviewEvidenceReadPort['read']>[0]) => ({
      status: 'available' as const, sha256: request.sha256,
      mediaType: 'text/plain', redactionState: 'none' as const,
      bytes: Uint8Array.from([0xc3, 0x28]),
    })],
    ['oversize text', new Uint8Array(256 * 1024 + 1), async (request: Parameters<ReviewEvidenceReadPort['read']>[0]) => ({
      status: 'available' as const, sha256: request.sha256,
      mediaType: 'text/plain', redactionState: 'none' as const,
      bytes: new Uint8Array(256 * 1024 + 1),
    })],
  ])('fails closed on %s', async (_label, artifactBytes, read) => {
    const source = sourcePort(async () => ({
      status: 'available', source: reviewPackageV2SourceFixture({ artifactBytes }),
    }));
    const projectionHash = projectAndAssertReviewPackageV2(
      reviewPackageV2SourceFixture({ artifactBytes }),
    ).projectionHash;
    const response = await app({ source, evidence: evidencePort(read) }).request(
      '/api/v2/tasks/task-1/review-evidence',
      {
        method: 'POST', body: evidenceBody({ projectionHash }),
        headers: { ...auth.headers, 'content-type': 'application/json' },
      },
    );
    expect(response.status).toBe(503);
  });

  it('accepts text at the exact 256 KiB UTF-8 boundary', async () => {
    const bytes = new TextEncoder().encode('a'.repeat(256 * 1024));
    const sourceValue = reviewPackageV2SourceFixture({ artifactBytes: bytes });
    const projectionHash = projectAndAssertReviewPackageV2(sourceValue).projectionHash;
    const response = await app({
      source: sourcePort(async () => ({ status: 'available', source: sourceValue })),
      evidence: evidencePort(async (request) => ({
        status: 'available', sha256: request.sha256, mediaType: 'text/plain',
        redactionState: 'none', bytes,
      })),
    }).request('/api/v2/tasks/task-1/review-evidence', {
      method: 'POST', body: evidenceBody({ projectionHash }),
      headers: { ...auth.headers, 'content-type': 'application/json' },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { text: string }).text.length).toBe(256 * 1024);
  });

  it('never returns bytes for restricted evidence and preserves closed unavailable reasons', async () => {
    const restrictedSource = sourcePort(async () => ({
      status: 'available', source: reviewPackageV2SourceFixture({ redactionState: 'restricted' }),
    }));
    const restrictedHash = projectAndAssertReviewPackageV2(
      reviewPackageV2SourceFixture({ redactionState: 'restricted' }),
    ).projectionHash;
    const denied = evidencePort(async () => ({ status: 'unavailable', reason: 'restricted' }));
    const response = await app({ source: restrictedSource, evidence: denied }).request(
      '/api/v2/tasks/task-1/review-evidence',
      {
        method: 'POST', body: evidenceBody({ projectionHash: restrictedHash }),
        headers: { ...auth.headers, 'content-type': 'application/json' },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schema: 'hercules-review-evidence-content/v1',
      kind: 'unavailable', artifactRefId: 'artifact-1', reason: 'restricted',
    });
    const forgedBytes = evidencePort(async (request) => ({
      status: 'available', sha256: request.sha256, mediaType: 'image/png',
      redactionState: 'none', bytes: Uint8Array.from([1]),
    }));
    const forged = await app({ source: restrictedSource, evidence: forgedBytes }).request(
      '/api/v2/tasks/task-1/review-evidence',
      {
        method: 'POST', body: evidenceBody({ projectionHash: restrictedHash }),
        headers: { ...auth.headers, 'content-type': 'application/json' },
      },
    );
    expect(forged.status).toBe(503);
    const disguised = evidencePort(async () => ({
      status: 'unavailable', reason: 'content_unavailable',
    }));
    const disguisedResponse = await app({ source: restrictedSource, evidence: disguised }).request(
      '/api/v2/tasks/task-1/review-evidence',
      {
        method: 'POST', body: evidenceBody({ projectionHash: restrictedHash }),
        headers: { ...auth.headers, 'content-type': 'application/json' },
      },
    );
    expect(disguisedResponse.status).toBe(503);
  });

  it('issues only an authenticated image path and repeats every check for the byte GET', async () => {
    const imageBytes = Uint8Array.from([137, 80, 78, 71]);
    const imageSource = reviewPackageV2SourceFixture({ artifactBytes: imageBytes });
    const source = sourcePort(vi.fn(async () => ({ status: 'available' as const, source: imageSource })));
    const evidence = evidencePort(async (request) => ({
      status: 'available', sha256: request.sha256, mediaType: 'image/png',
      redactionState: 'none', bytes: imageBytes,
    }));
    const server = app({ source, evidence });
    const descriptor = await server.request('/api/v2/tasks/task-1/review-evidence', {
      method: 'POST', body: evidenceBody({
        projectionHash: projectAndAssertReviewPackageV2(imageSource).projectionHash,
      }),
      headers: { ...auth.headers, 'content-type': 'application/json' },
    });
    const body = await descriptor.json() as { authenticatedPath: string };
    expect(body.authenticatedPath).toMatch(/^\/api\/v2\/tasks\/task-1\/review-evidence\/artifact-1\/content\/sha256%3A[0-9a-f]{64}$/);
    expect(body.authenticatedPath).not.toContain('?');
    expect((await server.request(body.authenticatedPath)).status).toBe(401);
    const image = await server.request(body.authenticatedPath, auth);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(Uint8Array.from([137, 80, 78, 71]));
    expect(source.read).toHaveBeenCalledTimes(4);
    expect(evidence.read).toHaveBeenCalledTimes(2);
  });

  it('fails stale when the package changes while evidence is being read', async () => {
    const first = reviewPackageV2SourceFixture();
    const changed = reviewPackageV2SourceFixture({ projectedAt: '2026-08-29T00:00:08.000Z' });
    let reads = 0;
    const read: ReviewPackageV2SourceReadPort['read'] = vi.fn(async () => ({
      status: 'available' as const,
      source: reads++ === 0 ? first : changed,
    }));
    const response = await app({ source: sourcePort(read), evidence: evidencePort() }).request(
      '/api/v2/tasks/task-1/review-evidence',
      {
        method: 'POST', body: evidenceBody(),
        headers: { ...auth.headers, 'content-type': 'application/json' },
      },
    );
    expect(response.status).toBe(409);
  });
});

describe('M7 learning proposal reads', () => {
  function proposal(projectionHash = currentProjectionHash()) {
    return {
      schema: 'hercules-learning-proposal-view/v1' as const,
      id: 'proposal-1', taskId: 'task-1', projectionHash,
      title: 'Keep the exact gate command',
      advisorySummary: 'Advisory proposal based on the bound artifact.',
      status: 'proposed' as const,
      evidenceArtifactIds: ['artifact-1'],
    };
  }

  it('returns only exact task/hash/evidence-bound advisory proposals after a second fresh read', async () => {
    const source = sourcePort(vi.fn(async () => ({ status: 'available' as const, source: reviewPackageV2SourceFixture() })));
    const learning: LearningProposalReadPort = {
      isReady: () => true,
      read: vi.fn(async () => ({ status: 'available' as const, proposals: [proposal()] })),
    };
    const response = await app({ source, learning }).request(
      `/api/v2/tasks/task-1/learning-proposals?projectionHash=${encodeURIComponent(currentProjectionHash())}`,
      auth,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual([proposal()]);
    expect(source.read).toHaveBeenCalledTimes(2);
    expect(learning.read).toHaveBeenCalledWith({
      taskId: 'task-1', projectionHash: currentProjectionHash(),
    });
  });

  it('rejects stale, malformed, cross-boundary, and raced proposals closed', async () => {
    const learning = (proposals: readonly ReturnType<typeof proposal>[]): LearningProposalReadPort => ({
      isReady: () => true,
      read: vi.fn(async () => ({ status: 'available' as const, proposals })),
    });
    const stale = await app({ source: sourcePort(), learning: learning([proposal()]) }).request(
      `/api/v2/tasks/task-1/learning-proposals?projectionHash=sha256:${'0'.repeat(64)}`,
      auth,
    );
    expect(stale.status).toBe(409);
    for (const bad of [
      { ...proposal(), taskId: 'task-2' },
      { ...proposal(), evidenceArtifactIds: ['artifact-404'] },
    ]) {
      const response = await app({
        source: sourcePort(),
        learning: learning([bad]),
      }).request(
        `/api/v2/tasks/task-1/learning-proposals?projectionHash=${encodeURIComponent(currentProjectionHash())}`,
        auth,
      );
      expect(response.status).toBe(503);
    }
    const first = reviewPackageV2SourceFixture();
    const changed = reviewPackageV2SourceFixture({ projectedAt: '2026-08-29T00:00:08.000Z' });
    let reads = 0;
    const racedRead: ReviewPackageV2SourceReadPort['read'] = vi.fn(async () => ({
      status: 'available' as const,
      source: reads++ === 0 ? first : changed,
    }));
    const racedSource = sourcePort(racedRead);
    const raced = await app({ source: racedSource, learning: learning([proposal()]) }).request(
      `/api/v2/tasks/task-1/learning-proposals?projectionHash=${encodeURIComponent(currentProjectionHash())}`,
      auth,
    );
    expect(raced.status).toBe(409);
  });
});
