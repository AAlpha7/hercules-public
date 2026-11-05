import { useState, type JSX } from 'react';
import type { EvidenceSummaryDto, ReviewPackageV2Dto } from './reviewTypes.js';
import { buildReviewViewModel, selectStrongestEvidence, windowRows } from './reviewViewModel.js';
import { StatusToken } from './StatusToken.js';

export function AcceptanceMatrix({
  packageValue,
  onOpenEvidence,
}: {
  readonly packageValue: ReviewPackageV2Dto;
  readonly onOpenEvidence?: (evidence: EvidenceSummaryDto) => void;
}): JSX.Element {
  const [limit, setLimit] = useState(20);
  const view = buildReviewViewModel(packageValue);
  const window = windowRows(packageValue.criteria, limit);
  const assertionsById = new Map(
    packageValue.assertions.map((assertion) => [assertion.id, assertion] as const),
  );

  return (
    <section className="outcome-review-band" aria-labelledby="outcome-review-acceptance">
      <div className="outcome-review-section-head">
        <h4 id="outcome-review-acceptance">Acceptance</h4>
        <span className="muted">
          {view.requiredCounts.pass}/{view.requiredCounts.total} required pass
        </span>
      </div>
      <div className="outcome-review-rows">
        {window.rows.map((criterion) => {
          const strongest = selectStrongestEvidence(criterion, packageValue.evidence);
          return (
            <div className="outcome-review-row" key={criterion.criterionId}>
              <div className="outcome-review-row-main">
                <StatusToken status={criterion.status} />
                <strong>{criterion.criterionId}</strong>
                {!criterion.required ? <span className="muted">Optional</span> : null}
              </div>
              {criterion.assertionIds.map((id) => {
                const assertion = assertionsById.get(id);
                return assertion ? (
                  <div className="outcome-review-row-detail" key={id}>
                    <StatusToken status={assertion.classification} />
                    <span>{assertion.advisoryText ?? assertion.subjectKey}</span>
                  </div>
                ) : null;
              })}
              {strongest && onOpenEvidence !== undefined ? (
                <button
                  type="button"
                  className="outcome-review-evidence-open"
                  onClick={() => onOpenEvidence(strongest)}
                  data-evidence="open-review-evidence"
                >
                  Open evidence: {strongest.surface} · {strongest.trustClass}
                </button>
              ) : strongest ? (
                <div className="outcome-review-row-detail muted">
                  Evidence metadata: {strongest.surface} · {strongest.trustClass}
                </div>
              ) : (
                <div className="outcome-review-row-detail muted">Eligible evidence unavailable.</div>
              )}
            </div>
          );
        })}
      </div>
      {window.hasMore ? (
        <button
          type="button"
          className="outcome-review-more"
          onClick={() => setLimit((current) => current + 20)}
        >
          Show more ({window.totalCount - window.visibleCount})
        </button>
      ) : null}
    </section>
  );
}
