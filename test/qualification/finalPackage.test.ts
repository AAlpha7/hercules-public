import { describe, expect, it } from 'vitest';
import { canonicalSerialize } from '../../src/domain/canonicalJson.js';
import {
  assertFinalReviewPackageV1,
  REMAINING_OWNER_GATE,
} from '../../src/domain/qualification.js';
import {
  buildFinalReviewPackage,
  M0_BASELINE_CHECK_FULL_COMMIT,
  QUALIFICATION_METRICS_FIXTURE,
  QUALIFICATION_REMAINING_RISKS,
} from '../../src/qualification/finalPackage.js';

const NOW = '2026-09-01T00:00:00.000Z';
const QUALIFIED_MAIN_SHA = 'cccccccccccccccccccccccccccccccccccccccc';

describe('buildFinalReviewPackage', () => {
  it('returns a valid FinalReviewPackageV1 over real held-out + adversarial + mobile-web + metrics', () => {
    const packageValue = buildFinalReviewPackage(NOW, QUALIFIED_MAIN_SHA);
    expect(() => assertFinalReviewPackageV1(packageValue)).not.toThrow();
    expect(packageValue.schema).toBe('hercules-final-review-package/v1');
    expect(packageValue.qualifiedMainSha).toBe(QUALIFIED_MAIN_SHA);
    expect(packageValue.remainingOwnerGate).toBe(REMAINING_OWNER_GATE);
    expect(packageValue.metrics.baselineCheckFullCommit).toBe(
      M0_BASELINE_CHECK_FULL_COMMIT,
    );
    expect(packageValue.metrics.qualifiedMainSha).toBe(QUALIFIED_MAIN_SHA);
    expect(packageValue.metrics.totalTests).toBe(
      QUALIFICATION_METRICS_FIXTURE.totalTests,
    );
    expect(packageValue.metrics.addedTests).toBe(
      QUALIFICATION_METRICS_FIXTURE.addedTests,
    );
    expect(packageValue.metrics.addedAdditiveModules).toBe(
      QUALIFICATION_METRICS_FIXTURE.addedAdditiveModules,
    );
    expect(packageValue.metrics.remainingRisks).toEqual([
      ...QUALIFICATION_REMAINING_RISKS,
    ]);
    expect(packageValue.heldOutSummaryHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(packageValue.adversarialSummaryHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(packageValue.mobileWebResultHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(packageValue.packageHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is deterministic for identical now and qualifiedMainSha', () => {
    const first = buildFinalReviewPackage(NOW, QUALIFIED_MAIN_SHA);
    const second = buildFinalReviewPackage(NOW, QUALIFIED_MAIN_SHA);
    expect(canonicalSerialize(second)).toBe(canonicalSerialize(first));
  });

  it('rejects a non-canonical now and a non-git qualifiedMainSha', () => {
    expect(() =>
      buildFinalReviewPackage('not-a-timestamp', QUALIFIED_MAIN_SHA),
    ).toThrow(/canonical UTC-Z/);
    expect(() => buildFinalReviewPackage(NOW, 'not-a-sha')).toThrow(/40-hex/);
  });
});
