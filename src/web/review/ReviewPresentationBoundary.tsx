import { useCallback, useState, type JSX } from 'react';
import type { ReviewExperiencePreference } from '../prefs.js';
import type { ReviewExperienceCapabilitiesV1 } from './reviewTypes.js';
import { browserControlApiV2Supported } from './controlApiV2Support.js';
import { OutcomeReviewPanel } from './OutcomeReviewPanel.js';
import { useOutcomeReview } from './useOutcomeReview.js';
import { useReviewDecision } from './useReviewDecision.js';

export type ReviewPresentationOwner = 'legacy' | 'outcome_v2' | 'control_v2';

export interface ReviewPresentationConfig {
  readonly preference: ReviewExperiencePreference;
  readonly capabilities: ReviewExperienceCapabilitiesV1;
  readonly onPreferenceChange: (next: ReviewExperiencePreference) => void;
  readonly onUnauthorized: () => void;
  /** Secure-context probe result; defaults to browserControlApiV2Supported() when omitted. */
  readonly controlApiV2Supported?: boolean;
}

/**
 * Which surface owns presentation. `control_v2` requires the explicit preference AND the
 * controlApiV2 capability AND a secure context — it never depends on the legacy
 * outcomeReviewRead bit (the control routes are their own read path; on the C2 staging
 * composition outcomeReviewRead is false while controlApiV2 is true). When the control
 * surface is not available it degrades to `outcome_v2` when outcomeReviewRead is on, else
 * `legacy`. `outcome_v2` requires the preference AND outcomeReviewRead.
 */
export function reviewPresentationOwner(config: ReviewPresentationConfig): ReviewPresentationOwner {
  const outcomeRead = config.capabilities.outcomeReviewRead;
  const supported =
    config.controlApiV2Supported ?? browserControlApiV2Supported();

  if (config.preference === 'legacy') return 'legacy';

  if (config.preference === 'outcome_v2') {
    return outcomeRead ? 'outcome_v2' : 'legacy';
  }

  // preference === 'control_v2'
  if (config.capabilities.controlApiV2 && supported) return 'control_v2';
  return outcomeRead ? 'outcome_v2' : 'legacy';
}

/** Unchanged public meaning for existing callers (TaskDetail): true iff the owner is not `legacy`. */
export function outcomeReviewOwnsPresentation(config: ReviewPresentationConfig): boolean {
  return reviewPresentationOwner(config) !== 'legacy';
}

export function ReviewPresentationBoundary({
  taskId,
  config,
  taskBody,
}: {
  readonly taskId: string;
  readonly config: ReviewPresentationConfig;
  /** Legacy task body for control-route human-ack checkbox labels. */
  readonly taskBody?: string;
}): JSX.Element {
  const owner = reviewPresentationOwner(config);
  const ownsPresentation = owner !== 'legacy';
  const [refreshKey, setRefreshKey] = useState(0);
  const onStale = useCallback(() => setRefreshKey((current) => current + 1), []);
  const state = useOutcomeReview({
    taskId,
    enabled: ownsPresentation,
    refreshKey,
    onUnauthorized: config.onUnauthorized,
    source: owner === 'control_v2' ? 'control_v2' : 'legacy',
  });
  const decisions = useReviewDecision({
    taskId,
    projectionHash: state.kind === 'available' ? state.package.projectionHash : null,
    onUnauthorized: config.onUnauthorized,
    onAuthoritativeRefetch: onStale,
    mode:
      owner === 'control_v2' &&
      state.kind === 'available' &&
      state.source === 'control_v2' &&
      state.stateVersion !== null
        ? {
            kind: 'control_v2',
            aggregateId: taskId,
            stateVersion: state.stateVersion,
          }
        : { kind: 'legacy' },
  });

  return (
    <div
      className="outcome-review-boundary"
      data-owner={owner}
      {...(state.kind === 'available' ? { 'data-source': state.source } : {})}
    >
      {config.capabilities.outcomeReviewRead || config.capabilities.controlApiV2 ? (
        <div className="outcome-review-mode" role="group" aria-label="Review experience">
          <button
            type="button"
            data-evidence="review-mode-legacy"
            aria-pressed={config.preference === 'legacy'}
            onClick={() => config.onPreferenceChange('legacy')}
          >
            Legacy
          </button>
          {config.capabilities.outcomeReviewRead ? (
            <button
              type="button"
              data-evidence="review-mode-outcome"
              aria-pressed={config.preference === 'outcome_v2'}
              onClick={() => config.onPreferenceChange('outcome_v2')}
            >
              Outcome
            </button>
          ) : null}
          {config.capabilities.controlApiV2 ? (
            <button
              type="button"
              data-evidence="review-mode-control"
              aria-pressed={config.preference === 'control_v2'}
              onClick={() => config.onPreferenceChange('control_v2')}
            >
              Control
            </button>
          ) : null}
        </div>
      ) : null}
      {!config.capabilities.outcomeReviewRead && config.preference === 'outcome_v2' ? (
        <div className="outcome-review-unavailable" role="status">
          Outcome review is unavailable. The legacy review remains active.
        </div>
      ) : null}

      {config.preference === 'control_v2' && owner !== 'control_v2' ? (
        <div
          className="outcome-review-unavailable"
          role="status"
          data-evidence="review-control-unavailable"
        >
          {config.capabilities.controlApiV2
            ? 'Control API review is unavailable on this origin (a secure context is required).'
            : 'Control API review is not enabled on this server.'}{' '}
          {owner === 'outcome_v2'
            ? 'The outcome review remains active.'
            : 'The legacy review remains active.'}
        </div>
      ) : null}

      {ownsPresentation && state.kind === 'loading' ? (
        decisions.state.kind === 'error' && !decisions.state.retryable ? (
          <div
            className="outcome-review-unavailable"
            role="alert"
            data-evidence="review-stale-explanation"
          >
            {decisions.state.message} Refreshing authoritative review…
          </div>
        ) : (
          <div className="outcome-review-unavailable" role="status">Loading outcome review…</div>
        )
      ) : null}
      {ownsPresentation &&
      state.kind === 'available' &&
      state.source === 'control_v2_fallback' ? (
        <div
          className="outcome-review-unavailable"
          role="status"
          data-evidence="review-control-fallback"
        >
          The Control API has no record for this task yet. Showing the legacy review.
        </div>
      ) : null}
      {ownsPresentation && state.kind === 'available' && state.taskId === taskId ? (
        <OutcomeReviewPanel
          key={`${state.taskId}:${state.package.projectionHash}:${state.stateVersion ?? 'none'}:${refreshKey}`}
          packageValue={state.package}
          capabilities={config.capabilities}
          decisionRoute={owner === 'control_v2' && state.source === 'control_v2' ? 'control_v2' : 'legacy'}
          {...(taskBody !== undefined ? { taskBody } : {})}
          decisionState={decisions.state}
          onSubmitDecision={decisions.submit}
          onRetryDecision={decisions.retry}
          onUnauthorized={config.onUnauthorized}
          onStale={onStale}
        />
      ) : null}
      {ownsPresentation && (state.kind === 'unavailable' || state.kind === 'stale') ? (
        <div className="outcome-review-unavailable" role="alert">
          <div>{state.kind === 'stale' ? state.message : state.reason}</div>
          <button type="button" onClick={() => config.onPreferenceChange('legacy')}>
            Use legacy review
          </button>
        </div>
      ) : null}
    </div>
  );
}
