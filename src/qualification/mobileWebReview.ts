/**
 * M13 mobile-Web outcome-review closed record.
 *
 * Produces the sealed `MobileWebReviewResultV1` over a re-consumed M12 browser
 * CapabilityProofV1 proofHash. The six proved properties are asserted in the
 * mobile-viewport render test (`test/web/render/mobileWebReview.render.test.tsx`);
 * this module is pure record assembly only — no React, no DOM, no live browser.
 */

import {
  assertMobileWebReviewResultV1,
  computeMobileWebReviewResultHash,
  MOBILE_WEB_PROVED_PROPERTIES,
  type MobileWebReviewResultV1,
} from '../domain/qualification.js';
import { isCanonicalTimestamp } from '../domain/workerBoundary.js';
import { QualificationHarnessError } from './heldOutCorpus.js';

function assertInjectedNow(now: string): void {
  if (!isCanonicalTimestamp(now)) {
    throw new QualificationHarnessError(
      'injected now must be a canonical UTC-Z timestamp',
    );
  }
}

function assertBrowserProofHash(browserProofHash: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(browserProofHash)) {
    throw new QualificationHarnessError(
      'browserProofHash must be a sha256:<64hex> digest',
    );
  }
}

/**
 * Seal the mobile-Web outcome-review result for the full six-property set.
 * `browserProofHash` is the re-consumed M12 browser CapabilityProofV1 proofHash.
 * `now` is the injected clock (validated; not stored on the closed record).
 */
export function buildMobileWebReviewResult(
  browserProofHash: string,
  now: string,
): MobileWebReviewResultV1 {
  assertInjectedNow(now);
  assertBrowserProofHash(browserProofHash);

  const withoutHash: Omit<MobileWebReviewResultV1, 'resultHash'> = {
    scenario: 'mobile_web_outcome_review',
    browserProofHash,
    provedProperties: [...MOBILE_WEB_PROVED_PROPERTIES],
  };
  const result: MobileWebReviewResultV1 = {
    ...withoutHash,
    resultHash: computeMobileWebReviewResultHash(withoutHash),
  };
  assertMobileWebReviewResultV1(result);
  return result;
}
