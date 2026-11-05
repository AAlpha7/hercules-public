import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  fetchControlApiV2Review,
  fetchReviewPackageV2,
} from '../api.js';
import type { OutcomeReviewLoadState } from './reviewTypes.js';

export function useOutcomeReview(input: {
  readonly taskId: string;
  readonly enabled: boolean;
  readonly refreshKey?: number;
  readonly onUnauthorized: () => void;
  readonly source?: 'legacy' | 'control_v2';
}): OutcomeReviewLoadState {
  const requestSequence = useRef(0);
  const [state, setState] = useState<OutcomeReviewLoadState>({ kind: 'disabled' });
  const source = input.source ?? 'legacy';

  useEffect(() => {
    const requestId = ++requestSequence.current;
    if (!input.enabled) {
      setState({ kind: 'disabled' });
      return;
    }

    const controller = new AbortController();
    const taskId = input.taskId;
    setState({ kind: 'loading', taskId, requestId });

    const load = async (): Promise<void> => {
      if (source === 'control_v2') {
        try {
          const read = await fetchControlApiV2Review(taskId, {
            signal: controller.signal,
          });
          if (controller.signal.aborted || requestSequence.current !== requestId) return;
          setState({
            kind: 'available',
            taskId,
            package: read.package,
            source: 'control_v2',
            stateVersion: read.stateVersion,
          });
          return;
        } catch (error: unknown) {
          if (controller.signal.aborted || requestSequence.current !== requestId) return;
          if (error instanceof ApiError && error.status === 401) {
            input.onUnauthorized();
            setState({
              kind: 'unavailable',
              taskId,
              reason: error.message,
            });
            return;
          }
          if (error instanceof ApiError && error.status === 404) {
            try {
              const packageValue = await fetchReviewPackageV2(taskId, {
                signal: controller.signal,
              });
              if (controller.signal.aborted || requestSequence.current !== requestId) return;
              setState({
                kind: 'available',
                taskId,
                package: packageValue,
                source: 'control_v2_fallback',
                stateVersion: null,
              });
              return;
            } catch (fallbackError: unknown) {
              if (controller.signal.aborted || requestSequence.current !== requestId) return;
              if (fallbackError instanceof ApiError && fallbackError.status === 401) {
                input.onUnauthorized();
              }
              const reason =
                fallbackError instanceof ApiError && fallbackError.status === 404
                  ? 'No outcome review package exists for this task.'
                  : fallbackError instanceof ApiError && fallbackError.status === 503
                    ? 'Outcome review is temporarily unavailable.'
                    : fallbackError instanceof Error
                      ? fallbackError.message
                      : 'Outcome review is unavailable.';
              setState({ kind: 'unavailable', taskId, reason });
              return;
            }
          }
          if (error instanceof ApiError && error.status === 503) {
            setState({
              kind: 'unavailable',
              taskId,
              reason: 'Control API review is temporarily unavailable.',
            });
            return;
          }
          const reason =
            error instanceof Error ? error.message : 'Outcome review is unavailable.';
          setState({ kind: 'unavailable', taskId, reason });
          return;
        }
      }

      try {
        const packageValue = await fetchReviewPackageV2(taskId, {
          signal: controller.signal,
        });
        if (controller.signal.aborted || requestSequence.current !== requestId) return;
        setState({
          kind: 'available',
          taskId,
          package: packageValue,
          source: 'legacy',
          stateVersion: null,
        });
      } catch (error: unknown) {
        if (controller.signal.aborted || requestSequence.current !== requestId) return;
        if (error instanceof ApiError && error.status === 401) input.onUnauthorized();
        const reason =
          error instanceof ApiError && error.status === 404
            ? 'No outcome review package exists for this task.'
            : error instanceof ApiError && error.status === 503
              ? 'Outcome review is temporarily unavailable.'
              : error instanceof Error
                ? error.message
                : 'Outcome review is unavailable.';
        setState({ kind: 'unavailable', taskId, reason });
      }
    };

    void load();
    return () => controller.abort();
  }, [input.enabled, input.onUnauthorized, input.refreshKey, input.taskId, source]);

  return state;
}
