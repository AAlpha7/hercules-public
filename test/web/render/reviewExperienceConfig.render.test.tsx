import './setup.js';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../src/web/api.js';

const { fetchReviewExperienceCapabilities } = vi.hoisted(() => ({
  fetchReviewExperienceCapabilities: vi.fn(),
}));

vi.mock('../../../src/web/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/web/api.js')>();
  return { ...actual, fetchReviewExperienceCapabilities };
});

import { useReviewExperienceConfig } from '../../../src/web/review/useReviewExperienceConfig.js';

const available = {
  schema: 'hercules-review-experience-capabilities/v1' as const,
  outcomeReviewRead: true,
  boundDecisions: false,
  evidenceContent: false,
  learningProposals: false,
  controlApiV2: false,
};

describe('useReviewExperienceConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('stays legacy and makes no capability request while unauthenticated', () => {
    const { result } = renderHook(() =>
      useReviewExperienceConfig({ authenticated: false, onUnauthorized: vi.fn() }),
    );

    expect(result.current.preference).toBe('legacy');
    expect(result.current.capabilities.outcomeReviewRead).toBe(false);
    expect(fetchReviewExperienceCapabilities).not.toHaveBeenCalled();
  });

  it('loads capabilities and persists only the selected presentation preference', async () => {
    const onUnauthorized = vi.fn();
    fetchReviewExperienceCapabilities.mockResolvedValueOnce(available);
    const { result } = renderHook(() =>
      useReviewExperienceConfig({ authenticated: true, onUnauthorized }),
    );

    await waitFor(() => expect(result.current.capabilities).toEqual(available));
    act(() => result.current.onPreferenceChange('outcome_v2'));
    expect(result.current.preference).toBe('outcome_v2');
    expect(localStorage.getItem('hercules_review_experience')).toBe('outcome_v2');
  });

  it('routes 401 to the auth boundary and keeps capabilities fail-closed', async () => {
    const onUnauthorized = vi.fn();
    fetchReviewExperienceCapabilities.mockRejectedValueOnce(new ApiError(401, 'unauthorized'));
    const { result } = renderHook(() =>
      useReviewExperienceConfig({ authenticated: true, onUnauthorized }),
    );

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledOnce());
    expect(result.current.capabilities.outcomeReviewRead).toBe(false);
  });
});
