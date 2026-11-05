import { useState, type JSX } from 'react';
import type { ReviewPackageV2Dto } from './reviewTypes.js';
import { windowRows } from './reviewViewModel.js';

export function IterationHistory({ packageValue }: { packageValue: ReviewPackageV2Dto }): JSX.Element {
  const [limit, setLimit] = useState(20);
  const newestFirst = [...packageValue.iterations].reverse();
  const iterationWindow = windowRows(newestFirst, limit);
  return (
    <section
      className="outcome-review-band"
      aria-labelledby="outcome-review-iterations"
      data-evidence="review-iteration-history"
    >
      <h4 id="outcome-review-iterations">Iterations</h4>
      <div className="outcome-review-iteration-list">
        {iterationWindow.rows.map((iteration) => (
          <div
            className="outcome-review-iteration"
            key={iteration.id}
            data-iteration-id={iteration.id}
          >
            <span>#{iteration.ordinal}</span>
            <strong>{iteration.state}</strong>
            <code>{iteration.candidateRef?.kind === 'git' ? iteration.candidateRef.revision.slice(0, 12) : 'no candidate'}</code>
          </div>
        ))}
      </div>
      {iterationWindow.hasMore ? (
        <button
          type="button"
          className="outcome-review-more"
          onClick={() => setLimit((current) => current + 20)}
        >
          Show more iterations ({iterationWindow.totalCount - iterationWindow.visibleCount})
        </button>
      ) : null}
    </section>
  );
}
