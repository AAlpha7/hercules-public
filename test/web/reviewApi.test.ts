import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  fetchReviewExperienceCapabilities,
  fetchReviewEvidence,
  fetchReviewEvidenceImage,
  fetchLearningProposals,
  fetchReviewPackageV2,
  newReviewDecisionRequestId,
  submitReviewDecision,
} from '../../src/web/api.js';
import {
  ReviewDtoDecodeError,
  type ReviewPackageV2Dto,
} from '../../src/web/review/reviewTypes.js';
import { hashCanonicalJson } from '../../src/domain/canonicalJson.js';
import type { ReviewDecisionRequestDto } from '../../src/web/review/reviewDecisionTypes.js';

const SHA = `sha256:${'a'.repeat(64)}`;

function packageFixture(taskId = 'task-1'): ReviewPackageV2Dto {
  const candidate = {
    kind: 'git' as const,
    repository: 'example-org/acme',
    revision: '0123456789abcdef0123456789abcdef01234567',
  };
  const decisionBinding = {
    taskId,
    contractVersion: 1,
    contractHash: SHA,
    iterationId: 'iteration-1',
    candidateRef: candidate,
    evidenceManifestHash: SHA,
    evaluatorVersion: 'evaluator-v1',
    evaluatorModel: 'model-v1',
    evaluatorRuntime: 'runtime-v1',
    policyVersion: 'policy-v1',
  };
  const axis = {
    status: 'verified' as const,
    assertionIds: ['assertion-1'],
    evidenceArtifactIds: ['artifact-1'],
    reasonCodes: [],
  };
  const fixture: ReviewPackageV2Dto = {
    schema: 'hercules-review-package/v2',
    projectionHash: SHA,
    projectedAt: '2026-08-29T00:00:07.000Z',
    task: {
      id: taskId,
      title: 'Review task',
      objective: 'Verify the candidate.',
      state: 'review',
      advisoryTextAuthority: 'advisory',
    },
    binding: { ...decisionBinding, evidenceManifestId: 'manifest-1' },
    outcome: {
      status: 'pass',
      evaluatorOutcome: 'pass',
      decisionEligible: true,
      reasonCodes: [],
      advisorySummary: 'pass',
    },
    assertions: [{
      id: 'assertion-1',
      subjectKey: 'tests.unit',
      payloadHash: SHA,
      classification: 'verified',
      decisionEligible: true,
      usedByCriterionIds: ['criterion-1'],
      evidenceArtifactIds: ['artifact-1'],
      receiptIds: ['receipt-1'],
      reasonCodes: [],
      advisoryText: 'Unit tests passed.',
    }],
    trustAxes: {
      contractBinding: { ...axis, assertionIds: [], evidenceArtifactIds: [] },
      mechanical: axis,
      realSurface: {
        status: 'not_applicable',
        assertionIds: [],
        evidenceArtifactIds: [],
        reasonCodes: [],
      },
      independentReview: {
        status: 'not_applicable',
        assertionIds: [],
        evidenceArtifactIds: [],
        reasonCodes: ['review_axis_deferred'],
      },
      independentEvaluation: axis,
      human: {
        status: 'not_applicable',
        assertionIds: [],
        evidenceArtifactIds: [],
        reasonCodes: [],
      },
    },
    criteria: [{
      criterionId: 'criterion-1',
      authority: 'mechanical',
      required: true,
      status: 'pass',
      assertionIds: ['assertion-1'],
      evidenceArtifactIds: ['artifact-1'],
      reasonCodes: [],
      advisoryExplanation: 'gate passed',
    }],
    evidence: [{
      artifactRefId: 'artifact-1',
      sha256: `sha256:${'b'.repeat(64)}`,
      trustClass: 'primary',
      redactionState: 'none',
      criterionIds: ['criterion-1'],
      surface: 'pnpm-test',
      supportsAssertionIds: ['assertion-1'],
    }],
    blockingFindings: [],
    remainingRisks: [],
    iterations: [{
      id: 'iteration-1',
      ordinal: 1,
      state: 'evaluating',
      candidateRef: candidate,
      evidenceManifestId: 'manifest-1',
      finalVerdictId: null,
      createdAt: '2026-08-29T00:00:04.000Z',
      endedAt: null,
    }],
    requiredDecision: null,
    validDecisions: ['request_changes'],
    decisionBinding,
    decisionToken: null,
    usage: { durationMs: 100, tokens: 20, costUsd: 0.01 },
  };
  const { projectionHash: _placeholder, ...boundFields } = fixture;
  return { ...fixture, projectionHash: hashCanonicalJson(boundFields) };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => key === 'hercules_token' ? 'review-token' : null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('review API client', () => {
  it('fetches and decodes capabilities with Bearer auth and the caller signal', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => response({
      schema: 'hercules-review-experience-capabilities/v1',
      outcomeReviewRead: true,
      boundDecisions: false,
      evidenceContent: false,
      learningProposals: false,
      controlApiV2: false,
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchReviewExperienceCapabilities({ signal: controller.signal }),
    ).resolves.toMatchObject({ outcomeReviewRead: true, boundDecisions: false });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/review-experience/capabilities',
      expect.objectContaining({
        signal: controller.signal,
        headers: expect.objectContaining({ authorization: 'Bearer review-token' }),
      }),
    );
  });

  it('encodes the task id, forwards the signal, and decodes a review package', async () => {
    const controller = new AbortController();
    const fixture = packageFixture('task / one');
    const fetchMock = vi.fn(async () => response(fixture));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchReviewPackageV2('task / one', { signal: controller.signal }),
    ).resolves.toEqual(fixture);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/tasks/task%20%2F%20one/review-package',
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('passes response JSON through the browser-safe decoders', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ schema: 'invented' })));

    await expect(fetchReviewExperienceCapabilities({})).rejects.toBeInstanceOf(
      ReviewDtoDecodeError,
    );
    await expect(fetchReviewPackageV2('task-1', {})).rejects.toBeInstanceOf(
      ReviewDtoDecodeError,
    );
  });

  it('rejects a valid package projected for a different task', async () => {
    const fixture = packageFixture();
    const wrongTask = {
      ...fixture,
      task: { ...fixture.task, id: 'task-2' },
      binding: { ...fixture.binding, taskId: 'task-2' },
      decisionBinding: { ...fixture.decisionBinding!, taskId: 'task-2' },
    };
    vi.stubGlobal('fetch', vi.fn(async () => response(wrongTask)));

    await expect(fetchReviewPackageV2('task-1', {})).rejects.toBeInstanceOf(
      ReviewDtoDecodeError,
    );
  });

  it('rejects a package whose projection hash no longer matches its fields', async () => {
    const fixture = packageFixture();
    const tampered = {
      ...fixture,
      task: { ...fixture.task, title: 'Tampered after projection' },
    };
    vi.stubGlobal('fetch', vi.fn(async () => response(tampered)));

    await expect(fetchReviewPackageV2('task-1', {})).rejects.toThrow(
      'projection hash does not match',
    );
  });

  it('fails closed when browser integrity verification is unavailable', async () => {
    const fixture = packageFixture();
    vi.stubGlobal('fetch', vi.fn(async () => response(fixture)));
    vi.stubGlobal('crypto', undefined);

    await expect(fetchReviewPackageV2('task-1', {})).rejects.toThrow(
      'integrity verification is unavailable',
    );
  });

  it.each([401, 404, 503])('preserves ApiError status %s', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'unavailable' }, status)));

    try {
      await fetchReviewPackageV2('task-1', {});
      throw new Error('expected request to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(status);
    }
  });

  it('posts the exact evidence binding and rejects mismatched or unsafe content', async () => {
    const fixture = packageFixture();
    const evidence = fixture.evidence[0]!;
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => response({
      schema: 'hercules-review-evidence-content/v1',
      kind: 'text',
      artifactRefId: evidence.artifactRefId,
      sha256: evidence.sha256,
      mediaType: 'text/plain',
      redactionState: 'none',
      text: 'verified output',
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchReviewEvidence(
      fixture.task.id, fixture.projectionHash, evidence, { signal: controller.signal },
    )).resolves.toMatchObject({ kind: 'text', text: 'verified output' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/tasks/task-1/review-evidence',
      expect.objectContaining({
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          schema: 'hercules-review-evidence-read/v1',
          taskId: fixture.task.id,
          projectionHash: fixture.projectionHash,
          artifactRefId: evidence.artifactRefId,
        }),
      }),
    );

    for (const invalid of [
      {
        schema: 'hercules-review-evidence-content/v1', kind: 'text',
        artifactRefId: 'artifact-2', sha256: evidence.sha256,
        mediaType: 'text/plain', redactionState: 'none', text: 'wrong member',
      },
      {
        schema: 'hercules-review-evidence-content/v1', kind: 'image',
        artifactRefId: evidence.artifactRefId, sha256: evidence.sha256,
        mediaType: 'image/png', redactionState: 'none',
        authenticatedPath: 'https://outside.invalid/evidence.png',
      },
      {
        schema: 'hercules-review-evidence-content/v1', kind: 'image',
        artifactRefId: evidence.artifactRefId, sha256: evidence.sha256,
        mediaType: 'image/png', redactionState: 'none',
        authenticatedPath: '/api/evidence.png?token=secret',
      },
    ]) {
      vi.stubGlobal('fetch', vi.fn(async () => response(invalid)));
      await expect(fetchReviewEvidence(
        fixture.task.id, fixture.projectionHash, evidence,
      )).rejects.toBeInstanceOf(ReviewDtoDecodeError);
    }
  });

  it('fetches learning proposals with exact binding and rejects unknown evidence', async () => {
    const fixture = packageFixture();
    const proposal = {
      schema: 'hercules-learning-proposal-view/v1',
      id: 'proposal-1', taskId: fixture.task.id,
      projectionHash: fixture.projectionHash,
      title: 'Retain the gate', advisorySummary: 'Advisory only.',
      status: 'proposed', evidenceArtifactIds: ['artifact-1'],
    };
    const fetchMock = vi.fn(async () => response([proposal]));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchLearningProposals(
      fixture.task.id,
      fixture.projectionHash,
      new Set(['artifact-1']),
    )).resolves.toEqual([proposal]);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v2/tasks/task-1/learning-proposals?projectionHash=${encodeURIComponent(fixture.projectionHash)}`,
      expect.anything(),
    );

    vi.stubGlobal('fetch', vi.fn(async () => response([
      { ...proposal, evidenceArtifactIds: ['artifact-404'] },
    ])));
    await expect(fetchLearningProposals(
      fixture.task.id,
      fixture.projectionHash,
      new Set(['artifact-1']),
    )).rejects.toBeInstanceOf(ReviewDtoDecodeError);
  });

  it('never sends the bearer token to an unbound evidence image path', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const path of [
      'https://attacker.invalid/image.png',
      '//attacker.invalid/image.png',
      '/api/state',
      '/api/v2/tasks/../review-evidence/a/content/sha256%3A' + 'a'.repeat(64),
      '/api/v2/tasks/a/review-evidence/./content/sha256%3A' + 'a'.repeat(64),
      '/api/v2/tasks/task-1/review-evidence/artifact-1/content/sha256%3A' + 'a'.repeat(64) + '?token=x',
    ]) {
      await expect(fetchReviewEvidenceImage(path, 'image/png'))
        .rejects.toBeInstanceOf(ReviewDtoDecodeError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts an exact bound decision and independently validates the receipt hashes', async () => {
    const fixture = packageFixture();
    const decisionRequest: ReviewDecisionRequestDto = {
      schema: 'hercules-review-decision-request/v1',
      clientRequestId: 'review-request-1',
      taskId: fixture.task.id,
      projectionHash: fixture.projectionHash,
      decisionBinding: fixture.decisionBinding!,
      action: 'request_changes',
      reason: 'Please repair the issue.',
      acknowledgedRiskCodes: [],
    };
    const receiptBody = {
      schema: 'hercules-review-decision-receipt/v1' as const,
      clientRequestId: decisionRequest.clientRequestId,
      requestHash: hashCanonicalJson(decisionRequest),
      taskId: decisionRequest.taskId,
      actor: { kind: 'human' as const, id: 'operator-1', issuer: 'fixture-issuer' },
      acceptedProjectionHash: decisionRequest.projectionHash,
      acceptedDecisionBindingHash: hashCanonicalJson(decisionRequest.decisionBinding),
      action: decisionRequest.action,
      humanDecisionId: 'decision-1',
      eventId: 'event-1',
      priorIterationId: 'iteration-1',
      resultingIterationId: 'iteration-2',
      recordedAt: '2026-08-29T10:00:00.000Z',
    };
    const receipt = { ...receiptBody, receiptHash: hashCanonicalJson(receiptBody) };
    const fetchMock = vi.fn(async () => response({
      schema: 'hercules-review-decision-response/v1', receipt, duplicate: false,
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(submitReviewDecision(decisionRequest)).resolves.toEqual({
      schema: 'hercules-review-decision-response/v1', receipt, duplicate: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/tasks/task-1/review-decisions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(decisionRequest),
        headers: expect.objectContaining({ authorization: 'Bearer review-token' }),
      }),
    );

    vi.stubGlobal('fetch', vi.fn(async () => response({
      schema: 'hercules-review-decision-response/v1',
      receipt: { ...receipt, resultingIterationId: 'iteration-1' },
      duplicate: false,
    })));
    await expect(submitReviewDecision(decisionRequest)).rejects.toBeInstanceOf(
      ReviewDtoDecodeError,
    );
  });

  it('fails closed when secure review decision request ids are unavailable', () => {
    vi.stubGlobal('crypto', { subtle: globalThis.crypto.subtle });
    expect(newReviewDecisionRequestId()).toBeNull();
  });
});
