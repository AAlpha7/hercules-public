/**
 * Promote restart reconciliation: network vs HTTP, and release-record terminal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/web/api.js';
import {
  isNetworkLayerFailure,
  promoteReconcileConfig,
  readPromoteTerminal,
  waitForPromoteOutcome,
} from '../../src/web/promoteReconcile.js';

const fetchReleases = vi.fn();

vi.mock('../../src/web/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/web/api.js')>();
  return {
    ...actual,
    fetchReleases: (...args: unknown[]) => fetchReleases(...args),
  };
});

describe('isNetworkLayerFailure', () => {
  it('treats ApiError status 0 as network-layer failure', () => {
    expect(isNetworkLayerFailure(new ApiError(0, 'Network error'))).toBe(true);
  });

  it('does not treat HTTP status errors as network-layer failure', () => {
    expect(isNetworkLayerFailure(new ApiError(409, 'promote blocked'))).toBe(false);
    expect(isNetworkLayerFailure(new ApiError(503, 'unavailable'))).toBe(false);
  });

  it('does not treat non-ApiError throws as network-layer failure', () => {
    expect(isNetworkLayerFailure(new Error('boom'))).toBe(false);
  });
});

describe('readPromoteTerminal', () => {
  const expected = 'stagesha1';

  it('is pending while promotingSha is still set', () => {
    expect(
      readPromoteTerminal(
        { productionSha: 'prodsha01', promotingSha: expected, history: [] },
        expected,
      ),
    ).toEqual({ status: 'pending' });
  });

  it('returns ok when production advanced with latest history ok', () => {
    expect(
      readPromoteTerminal(
        {
          productionSha: expected,
          promotingSha: null,
          history: [{ sha: expected, at: '2026-09-01T00:00:00Z', outcome: 'ok' }],
        },
        expected,
      ),
    ).toEqual({ status: 'ok' });
  });

  it('returns rolled_back with target when history is rolled_back', () => {
    expect(
      readPromoteTerminal(
        {
          productionSha: 'prodsha01',
          promotingSha: null,
          history: [
            {
              sha: 'prodsha01',
              at: '2026-09-01T00:00:00Z',
              outcome: 'rolled_back',
              rollbackOf: expected,
            },
          ],
        },
        expected,
      ),
    ).toEqual({ status: 'rolled_back', targetSha: 'prodsha01' });
  });

  it('stays pending when production matches but history is not terminal', () => {
    expect(
      readPromoteTerminal(
        { productionSha: expected, promotingSha: null, history: [] },
        expected,
      ),
    ).toEqual({ status: 'pending' });
  });
});

describe('waitForPromoteOutcome', () => {
  const expected = 'stagesha1';
  const savedInterval = promoteReconcileConfig.intervalMs;
  const savedAttempts = promoteReconcileConfig.maxAttempts;

  beforeEach(() => {
    fetchReleases.mockReset();
    promoteReconcileConfig.intervalMs = 1;
    promoteReconcileConfig.maxAttempts = 5;
  });

  afterEach(() => {
    promoteReconcileConfig.intervalMs = savedInterval;
    promoteReconcileConfig.maxAttempts = savedAttempts;
  });

  it('resolves ok after polling reaches production tip with history ok', async () => {
    fetchReleases
      .mockRejectedValueOnce(new ApiError(0, 'Network error'))
      .mockResolvedValueOnce([
        {
          repoKey: 'app',
          productionSha: 'prodsha01',
          promotingSha: expected,
          history: [],
        },
      ])
      .mockResolvedValue([
        {
          repoKey: 'app',
          productionSha: expected,
          promotingSha: null,
          history: [{ sha: expected, at: '2026-09-01T07:02:00Z', outcome: 'ok' }],
        },
      ]);

    await expect(waitForPromoteOutcome('app', expected)).resolves.toEqual({ status: 'ok' });
    expect(fetchReleases.mock.calls.length).toBeGreaterThan(1);
  });

  it('resolves rolled_back with target from the release record', async () => {
    fetchReleases.mockResolvedValue([
      {
        repoKey: 'app',
        productionSha: 'prodsha01',
        promotingSha: null,
        history: [
          {
            sha: 'prodsha01',
            at: '2026-09-01T07:03:00Z',
            outcome: 'rolled_back',
            rollbackOf: expected,
          },
        ],
      },
    ]);

    await expect(waitForPromoteOutcome('app', expected)).resolves.toEqual({
      status: 'rolled_back',
      targetSha: 'prodsha01',
    });
  });

  it('resolves unknown when the bound expires without a terminal record', async () => {
    fetchReleases.mockResolvedValue([
      {
        repoKey: 'app',
        productionSha: 'prodsha01',
        promotingSha: expected,
        history: [],
      },
    ]);

    await expect(waitForPromoteOutcome('app', expected)).resolves.toEqual({
      status: 'unknown',
    });
  });
});
