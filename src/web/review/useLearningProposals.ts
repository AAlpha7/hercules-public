import { useEffect, useRef, useState } from 'react';
import { ApiError, fetchLearningProposals } from '../api.js';
import type { LearningProposalViewDto } from './learningProposalTypes.js';
import type { ReviewPackageV2Dto } from './reviewTypes.js';

export function useLearningProposals(input: {
  readonly packageValue: ReviewPackageV2Dto;
  readonly enabled: boolean;
  readonly onUnauthorized: () => void;
  readonly onStale: () => void;
}): readonly LearningProposalViewDto[] {
  const requestSequence = useRef(0);
  const [proposals, setProposals] = useState<readonly LearningProposalViewDto[]>([]);

  useEffect(() => {
    const requestId = ++requestSequence.current;
    setProposals([]);
    if (!input.enabled) return;
    const controller = new AbortController();
    const evidenceIds = new Set(
      input.packageValue.evidence.map((item) => item.artifactRefId),
    );
    void fetchLearningProposals(
      input.packageValue.task.id,
      input.packageValue.projectionHash,
      evidenceIds,
      { signal: controller.signal },
    ).then((value) => {
      if (controller.signal.aborted || requestSequence.current !== requestId) return;
      setProposals(value);
    }).catch((error: unknown) => {
      if (controller.signal.aborted || requestSequence.current !== requestId) return;
      if (error instanceof ApiError && error.status === 401) input.onUnauthorized();
      if (error instanceof ApiError && error.status === 409) input.onStale();
      setProposals([]);
    });
    return () => controller.abort();
  }, [
    input.enabled,
    input.onStale,
    input.onUnauthorized,
    input.packageValue,
  ]);
  return proposals;
}
