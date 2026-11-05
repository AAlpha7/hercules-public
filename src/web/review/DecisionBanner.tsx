import type { JSX } from 'react';
import type { ReviewPackageV2Dto } from './reviewTypes.js';

function messageFor(packageValue: ReviewPackageV2Dto, writeAvailable: boolean): string {
  if (packageValue.validDecisions.length === 0) {
    return 'More evidence is required before any outcome decision is available.';
  }
  if (packageValue.outcome.status === 'needs_human') {
    return writeAvailable
      ? 'A bound human outcome decision is required.'
      : 'A bound human outcome decision is required. This read-only view cannot submit it.';
  }
  if (packageValue.outcome.status === 'fail') {
    return 'Verified failure. Request changes is the only eligible next decision.';
  }
  return 'Verified pass. Request changes remains available; approval is not implied by this view.';
}

export function DecisionBanner({
  packageValue,
  writeAvailable,
}: {
  packageValue: ReviewPackageV2Dto;
  writeAvailable: boolean;
}): JSX.Element {
  return (
    <section
      className="outcome-review-band outcome-review-decision"
      aria-label="Decision status"
      data-evidence="review-decision-status"
    >
      <strong>{messageFor(packageValue, writeAvailable)}</strong>
      <span className="muted">
        {writeAvailable
          ? 'Any submitted decision is bound to this exact package.'
          : 'No decision write capability is connected.'}
      </span>
    </section>
  );
}
