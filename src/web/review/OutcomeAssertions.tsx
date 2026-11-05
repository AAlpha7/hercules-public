import { useState, type JSX } from 'react';
import type { ReviewPackageV2Dto } from './reviewTypes.js';
import { windowRows } from './reviewViewModel.js';
import { StatusToken } from './StatusToken.js';

export function outcomeAssertions(packageValue: ReviewPackageV2Dto) {
  const assertionsById = new Map(
    packageValue.assertions.map((assertion) => [assertion.id, assertion] as const),
  );
  return packageValue.trustAxes.independentEvaluation.assertionIds
    .map((id) => assertionsById.get(id))
    .filter((assertion) => assertion !== undefined);
}

export function OutcomeAssertions({ packageValue }: { packageValue: ReviewPackageV2Dto }): JSX.Element | null {
  const [limit, setLimit] = useState(20);
  const assertions = outcomeAssertions(packageValue);
  const assertionWindow = windowRows(assertions, limit);
  if (assertions.length === 0) return null;

  return (
    <section className="outcome-review-band" aria-label="All outcome assertions">
      <div className="outcome-review-section-head">
        <h4>Outcome assertions</h4>
        <span className="muted">{assertions.length}</span>
      </div>
      <div className="outcome-review-assertions">
        {assertionWindow.rows.map((assertion) => (
          <div className="outcome-review-assertion" key={assertion.id}>
            <StatusToken status={assertion.classification} />
            <span>
              {assertion.advisoryText ?? assertion.subjectKey}
              {assertion.advisoryText === null ? (
                <code className="outcome-review-hash">{assertion.payloadHash}</code>
              ) : null}
            </span>
          </div>
        ))}
        {assertionWindow.hasMore ? (
          <button
            type="button"
            className="outcome-review-more"
            onClick={() => setLimit((current) => current + 20)}
          >
            Show more assertions ({assertionWindow.totalCount - assertionWindow.visibleCount})
          </button>
        ) : null}
      </div>
    </section>
  );
}
