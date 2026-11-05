import { useCallback, useEffect, useState } from 'react';
import { ApiError, fetchReviewExperienceCapabilities } from '../api.js';
import {
  loadReviewExperiencePreference,
  saveReviewExperiencePreference,
  type ReviewExperiencePreference,
} from '../prefs.js';
import type { ReviewExperienceCapabilitiesV1 } from './reviewTypes.js';

const UNAVAILABLE_CAPABILITIES: ReviewExperienceCapabilitiesV1 = {
  schema: 'hercules-review-experience-capabilities/v1',
  outcomeReviewRead: false,
  boundDecisions: false,
  evidenceContent: false,
  learningProposals: false,
  controlApiV2: false,
};

export function useReviewExperienceConfig(input: {
  readonly authenticated: boolean;
  readonly onUnauthorized: () => void;
}): {
  readonly preference: ReviewExperiencePreference;
  readonly capabilities: ReviewExperienceCapabilitiesV1;
  readonly onPreferenceChange: (next: ReviewExperiencePreference) => void;
  readonly onUnauthorized: () => void;
} {
  const [preference, setPreference] = useState<ReviewExperiencePreference>(() =>
    loadReviewExperiencePreference(),
  );
  const [capabilities, setCapabilities] =
    useState<ReviewExperienceCapabilitiesV1>(UNAVAILABLE_CAPABILITIES);

  useEffect(() => {
    setCapabilities(UNAVAILABLE_CAPABILITIES);
    if (!input.authenticated) return;
    const controller = new AbortController();
    void fetchReviewExperienceCapabilities({ signal: controller.signal })
      .then((next) => {
        if (!controller.signal.aborted) setCapabilities(next);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) input.onUnauthorized();
        else setCapabilities(UNAVAILABLE_CAPABILITIES);
      });
    return () => controller.abort();
  }, [input.authenticated, input.onUnauthorized]);

  const onPreferenceChange = useCallback((next: ReviewExperiencePreference) => {
    saveReviewExperiencePreference(next);
    setPreference(next);
  }, []);

  return { preference, capabilities, onPreferenceChange, onUnauthorized: input.onUnauthorized };
}
