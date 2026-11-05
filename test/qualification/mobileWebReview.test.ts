import { describe, expect, it } from 'vitest';
import {
  assertMobileWebReviewResultV1,
  computeMobileWebReviewResultHash,
  MOBILE_WEB_PROVED_PROPERTIES,
} from '../../src/domain/qualification.js';
import { buildBrowserCapabilityProof } from '../../src/proofs/archetypes/browser.js';
import { buildMobileWebReviewResult } from '../../src/qualification/mobileWebReview.js';

const NOW = '2026-09-01T00:00:00.000Z';

describe('buildMobileWebReviewResult', () => {
  it('seals a MobileWebReviewResultV1 over a re-consumed M12 browser proof', () => {
    const browserProof = buildBrowserCapabilityProof(NOW);
    const result = buildMobileWebReviewResult(browserProof.proofHash, NOW);
    expect(() => assertMobileWebReviewResultV1(result)).not.toThrow();
    expect(result.scenario).toBe('mobile_web_outcome_review');
    expect(result.browserProofHash).toBe(browserProof.proofHash);
    expect(result.provedProperties).toEqual([...MOBILE_WEB_PROVED_PROPERTIES]);
    expect(result.resultHash).toBe(
      computeMobileWebReviewResultHash({
        scenario: result.scenario,
        browserProofHash: result.browserProofHash,
        provedProperties: result.provedProperties,
      }),
    );
  });

  it('rejects a non-canonical now and a non-digest browserProofHash', () => {
    expect(() =>
      buildMobileWebReviewResult(
        `sha256:${'a'.repeat(64)}`,
        'not-a-timestamp',
      ),
    ).toThrow(/canonical UTC-Z/);
    expect(() =>
      buildMobileWebReviewResult('not-a-hash', NOW),
    ).toThrow(/sha256/);
  });
});
