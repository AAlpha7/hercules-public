import type { JSX } from 'react';
import type { ReviewPackageV2Dto } from './reviewTypes.js';
import { buildReviewViewModel } from './reviewViewModel.js';
import { StatusToken } from './StatusToken.js';

export function OutcomeSummary({ packageValue }: { packageValue: ReviewPackageV2Dto }): JSX.Element {
  const view = buildReviewViewModel(packageValue);
  return (
    <section className="outcome-review-band" aria-label="Outcome review summary">
      <div className="outcome-review-summary-grid">
        <div className="outcome-review-summary-item">
          <div className="outcome-review-section-head">
            <h4>Required acceptance</h4>
            <strong>{view.requiredCounts.pass}/{view.requiredCounts.total}</strong>
          </div>
          <div className="muted">
            {view.requiredCounts.fail} failed · {view.requiredCounts.gap} need attention
          </div>
          {view.firstRequiredProblem ? (
            <div className="outcome-review-summary-first">
              <StatusToken status={view.firstRequiredProblem.status} />
              <strong>{view.firstRequiredProblem.criterionId}</strong>
            </div>
          ) : (
            <div className="outcome-review-summary-first muted">No required gap.</div>
          )}
        </div>
        <div className="outcome-review-summary-item">
          <div className="outcome-review-section-head">
            <h4>Remaining risks</h4>
            <strong>{view.remainingRiskCount}</strong>
          </div>
          {view.firstRemainingRisk ? (
            <div className="outcome-review-summary-first">
              <StatusToken status={view.firstRemainingRisk.classification} />
              <strong>{view.firstRemainingRisk.code}</strong>
            </div>
          ) : (
            <div className="outcome-review-summary-first muted">No remaining risk.</div>
          )}
        </div>
      </div>
    </section>
  );
}
