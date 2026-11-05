/**
 * M13 final review package assembly.
 *
 * Runs the held-out corpus, the eight adversarial fixtures, the mobile-Web
 * result (re-consuming the M12 browser proof), and the before/after metrics,
 * then seals via the pure `assembleFinalReviewPackage`. No live execution,
 * no state mutation, no cutover authorization.
 */

import {
  assembleFinalReviewPackage,
  assertBeforeAfterMetricsV1,
  assertFinalReviewPackageV1,
  computeBeforeAfterMetricsHash,
  REMAINING_OWNER_GATE,
  type BeforeAfterMetricsV1,
  type FinalReviewPackageV1,
} from '../domain/qualification.js';
import { isCanonicalTimestamp } from '../domain/workerBoundary.js';
import { buildBrowserCapabilityProof } from '../proofs/archetypes/browser.js';
import { runAdversarialCases } from './adversarialCases.js';
import { QualificationHarnessError, runHeldOutCorpus } from './heldOutCorpus.js';
import { buildMobileWebReviewResult } from './mobileWebReview.js';

/** M0 baseline `pnpm check:full` commit (program-state baseline.check_full.commit). */
export const M0_BASELINE_CHECK_FULL_COMMIT =
  '72dd0b75a1a0761e32c2143c60b0879d3d124905';

/**
 * Recorded before/after fixture counts for the qualification package.
 * These are closed fixture numbers, not a live inventory of the working tree.
 * `totalTests` tracks the measured `pnpm test` total on the qualified tree
 * (4681 at qualification) so the before/after metrics do not understate it.
 */
export const QUALIFICATION_METRICS_FIXTURE = {
  totalTests: 4_681,
  addedTests: 208,
  addedAdditiveModules: 48,
} as const;

/**
 * The three residual risk classes named by the M13 terminal disposition set:
 * DB-cutover gate, CI-billing follow-up, and composition-fixture / closed-scope.
 * Sorted-unique for BeforeAfterMetricsV1.
 */
export const QUALIFICATION_REMAINING_RISKS = [
  'closed_scope_decision',
  'discharged_into_db_cutover_gate',
  'external_followup_ci_billing',
] as const;

function assertInjectedNow(now: string): void {
  if (!isCanonicalTimestamp(now)) {
    throw new QualificationHarnessError(
      'injected now must be a canonical UTC-Z timestamp',
    );
  }
}

function assertGitSha(value: string, label: string): void {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new QualificationHarnessError(
      `${label} must be a 40-hex git SHA`,
    );
  }
}

function buildBeforeAfterMetrics(
  qualifiedMainSha: string,
): BeforeAfterMetricsV1 {
  const withoutHash: Omit<BeforeAfterMetricsV1, 'metricsHash'> = {
    baselineCheckFullCommit: M0_BASELINE_CHECK_FULL_COMMIT,
    qualifiedMainSha,
    totalTests: QUALIFICATION_METRICS_FIXTURE.totalTests,
    addedTests: QUALIFICATION_METRICS_FIXTURE.addedTests,
    addedAdditiveModules: QUALIFICATION_METRICS_FIXTURE.addedAdditiveModules,
    remainingRisks: [...QUALIFICATION_REMAINING_RISKS],
  };
  const metrics: BeforeAfterMetricsV1 = {
    ...withoutHash,
    metricsHash: computeBeforeAfterMetricsHash(withoutHash),
  };
  assertBeforeAfterMetricsV1(metrics);
  return metrics;
}

/**
 * Build the sealed final Hercules Web review package over the real held-out
 * corpus, adversarial fixtures, mobile-Web result, and before/after metrics.
 *
 * @param now injected canonical clock
 * @param qualifiedMainSha the exact main SHA under qualification (injected)
 */
export function buildFinalReviewPackage(
  now: string,
  qualifiedMainSha: string,
): FinalReviewPackageV1 {
  assertInjectedNow(now);
  assertGitSha(qualifiedMainSha, 'qualifiedMainSha');

  const heldOutResults = runHeldOutCorpus(now);
  const adversarialResults = runAdversarialCases(now);
  const browserProof = buildBrowserCapabilityProof(now);
  const mobileWebResult = buildMobileWebReviewResult(
    browserProof.proofHash,
    now,
  );
  const metrics = buildBeforeAfterMetrics(qualifiedMainSha);

  const packageValue = assembleFinalReviewPackage(
    {
      qualifiedMainSha,
      heldOutResults,
      adversarialResults,
      mobileWebResult,
      metrics,
      remainingOwnerGate: REMAINING_OWNER_GATE,
    },
    now,
  );
  assertFinalReviewPackageV1(packageValue);
  return packageValue;
}
