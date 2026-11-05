import { useState, type JSX } from 'react';
import type { ReviewPackageV2Dto } from './reviewTypes.js';
import { windowRows } from './reviewViewModel.js';
import { StatusToken } from './StatusToken.js';

export function RiskSummary({ packageValue }: { packageValue: ReviewPackageV2Dto }): JSX.Element {
  const [limit, setLimit] = useState(20);
  const assertionsById = new Map(
    packageValue.assertions.map((assertion) => [assertion.id, assertion] as const),
  );
  const rows = [...packageValue.blockingFindings, ...packageValue.remainingRisks];
  const riskWindow = windowRows(rows, limit);

  return (
    <section className="outcome-review-band" aria-labelledby="outcome-review-risks">
      <div className="outcome-review-section-head">
        <h4 id="outcome-review-risks">Risks</h4>
        <span className="muted">
          {packageValue.blockingFindings.length} blocking · {packageValue.remainingRisks.length} remaining
        </span>
      </div>
      {rows.length === 0 ? <p className="muted">No structured risks reported.</p> : null}
      <div className="outcome-review-rows">
        {riskWindow.rows.map((finding) => (
          <div className="outcome-review-row" key={finding.code}>
            <div className="outcome-review-row-main">
              <StatusToken status={finding.classification} />
              <strong>{finding.code}</strong>
            </div>
            <div className="outcome-review-row-detail">{finding.advisorySummary}</div>
            {finding.assertionIds.map((id) => {
              const assertion = assertionsById.get(id);
              return assertion ? (
                <div className="outcome-review-row-detail" key={id}>
                  <StatusToken status={assertion.classification} />
                  <span>{assertion.advisoryText ?? assertion.subjectKey}</span>
                </div>
              ) : null;
            })}
          </div>
        ))}
      </div>
      {riskWindow.hasMore ? (
        <button
          type="button"
          className="outcome-review-more"
          onClick={() => setLimit((current) => current + 20)}
        >
          Show more risks ({riskWindow.totalCount - riskWindow.visibleCount})
        </button>
      ) : null}
    </section>
  );
}
