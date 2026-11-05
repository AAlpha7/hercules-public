/**
 * @vitest-environment jsdom
 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  fetchControlApiV2Review,
} from '../../src/web/api.js';
import { ReviewDtoDecodeError } from '../../src/web/review/reviewTypes.js';
import {
  computeRefusalHash,
  computeReviewViewHash,
  type ControlApiV2RefusalV1,
  type ControlApiV2ReviewViewV1,
} from '../../src/domain/controlApiV2.js';
import { projectAndAssertReviewPackageV2 } from '../../src/domain/reviewPackageV2.js';
import { buildEligibleControlApiV2ReviewSource } from '../../src/isolation/controlApiV2ReviewSeed.js';

const NOW = '2026-09-01T00:00:00.000Z';
const HASH_B =
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function reviewView(taskId: string, aggregateId = taskId): ControlApiV2ReviewViewV1 {
  const reviewPackage = projectAndAssertReviewPackageV2(
    buildEligibleControlApiV2ReviewSource(taskId),
  );
  const withoutHash: Omit<ControlApiV2ReviewViewV1, 'viewHash'> = {
    schema: 'hercules-control-api-review-view/v2',
    aggregateId,
    stateVersion: 3,
    reviewPackage,
  };
  return { ...withoutHash, viewHash: computeReviewViewHash(withoutHash) };
}

function unknownAggregateRefusal(aggregateId: string): ControlApiV2RefusalV1 {
  const withoutHash: Omit<ControlApiV2RefusalV1, 'refusalHash'> = {
    schema: 'hercules-control-api-refusal/v2',
    resource: 'review',
    aggregateId,
    requestHash: HASH_B,
    reason: 'unknown_aggregate',
    decidedAt: NOW,
  };
  return { ...withoutHash, refusalHash: computeRefusalHash(withoutHash) };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') {
    vi.stubGlobal('crypto', webcrypto);
  }
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key === 'hercules_token' ? 'review-token' : null),
    setItem: () => undefined,
    removeItem: () => undefined,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchControlApiV2Review', () => {
  it('unwraps a 200 review view when the package task id matches', async () => {
    const view = reviewView('task-1');
    const fetchMock = vi.fn(async () => response(view));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchControlApiV2Review('task-1')).resolves.toEqual({
      aggregateId: 'task-1',
      stateVersion: 3,
      package: view.reviewPackage,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v2/control/tasks/task-1/review',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ authorization: 'Bearer review-token' }),
      }),
    );
  });

  it('rejects when the package task id does not match the request', async () => {
    const view = reviewView('other-task', 'task-1');
    vi.stubGlobal('fetch', vi.fn(async () => response(view)));

    await expect(fetchControlApiV2Review('task-1')).rejects.toBeInstanceOf(
      ReviewDtoDecodeError,
    );
  });

  it('maps 404 unknown_aggregate to ApiError(404)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(unknownAggregateRefusal('task-missing'), 404)),
    );

    await expect(fetchControlApiV2Review('task-missing')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      message: 'unknown_aggregate',
    });
  });

  it('maps route-level 503 to ApiError(503, provider_unavailable)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response({ reason: 'provider_unavailable' }, 503),
      ),
    );

    await expect(fetchControlApiV2Review('task-1')).rejects.toEqual(
      new ApiError(503, 'provider_unavailable'),
    );
  });

  it('throws ApiError(401) when no bearer token is stored', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchControlApiV2Review('task-1')).rejects.toEqual(
      new ApiError(401, 'unauthorized'),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
