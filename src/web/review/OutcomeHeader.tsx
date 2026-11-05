import type { JSX } from 'react';
import type { ReviewPackageV2Dto } from './reviewTypes.js';
import { outcomeAssertions } from './OutcomeAssertions.js';
import { StatusToken } from './StatusToken.js';

export function OutcomeHeader({ packageValue }: { packageValue: ReviewPackageV2Dto }): JSX.Element {
  const assertions = outcomeAssertions(packageValue);
  const preview = assertions.find((assertion) => assertion.classification !== 'verified') ?? assertions[0];
  const previewText = preview
    ? preview.advisoryText ?? `${preview.subjectKey} · ${preview.payloadHash}`
    : null;

  return (
    <section className="outcome-review-band outcome-review-header" aria-labelledby="outcome-review-title">
      <div className="outcome-review-heading-row">
        <div>
          <div className="body-label">Outcome review</div>
          <h3 id="outcome-review-title">{packageValue.task.title}</h3>
        </div>
        <StatusToken status={packageValue.outcome.status} />
      </div>
      <p className="outcome-review-objective">{packageValue.task.objective}</p>
      {preview ? (
        <div className="outcome-review-assertion-preview" aria-label="Outcome assertion preview">
          <div className="outcome-review-assertion">
            <StatusToken status={preview.classification} />
            <span className="outcome-review-assertion-preview-text" title={previewText ?? undefined}>
              {previewText}
            </span>
          </div>
          {assertions.length > 1 ? (
            <span className="muted">{assertions.length - 1} more below</span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
