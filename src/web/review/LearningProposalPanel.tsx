import type { JSX } from 'react';
import type { LearningProposalViewDto } from './learningProposalTypes.js';

export function LearningProposalPanel({
  proposals,
}: {
  readonly proposals: readonly LearningProposalViewDto[];
}): JSX.Element | null {
  if (proposals.length === 0) return null;
  return (
    <section className="outcome-review-band outcome-review-learning" aria-labelledby="outcome-review-learning">
      <div className="outcome-review-section-head">
        <h4 id="outcome-review-learning">Advisory learning proposals</h4>
        <span className="muted">Advisory only</span>
      </div>
      <div className="outcome-review-rows">
        {proposals.map((proposal) => (
          <article className="outcome-review-learning-row" key={proposal.id} data-evidence="learning-proposal">
            <div className="outcome-review-row-main">
              <strong>{proposal.title}</strong>
              <span className="muted">{proposal.status}</span>
            </div>
            <p>{proposal.advisorySummary}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
