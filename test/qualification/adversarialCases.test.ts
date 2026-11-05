import { describe, expect, it } from 'vitest';
import { canonicalSerialize } from '../../src/domain/canonicalJson.js';
import {
  ADVERSARIAL_CASES,
  ADVERSARIAL_CASE_TABLE,
  MOBILE_WEB_PROVED_PROPERTIES,
  REMAINING_OWNER_GATE,
  assembleFinalReviewPackage,
  assertAdversarialCaseResultV1,
  assertFinalReviewPackageV1,
  computeBeforeAfterMetricsHash,
  computeHeldOutCaseResultHash,
  computeMobileWebReviewResultHash,
  type AdversarialCaseResultV1,
  type BeforeAfterMetricsV1,
  type HeldOutCaseResultV1,
  type MobileWebReviewResultV1,
} from '../../src/domain/qualification.js';
import { runAdversarialCases } from '../../src/qualification/adversarialCases.js';

const NOW = '2026-09-01T00:00:00.000Z';
const GIT_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const hash = (seed: number): string =>
  `sha256:${seed.toString(16).padStart(64, '0')}`;

/** Expected closed reason token each fixture must surface from the real engine. */
const EXPECTED_REFUSAL_REASON: Readonly<Record<string, string>> = {
  false_green: 'fail',
  stale_approval: 'stale_version',
  evidence_tamper: 'need_more_evidence',
  restart_recovery: 'committed',
  duplicate_action: 'idempotency_conflict',
  reviewer_rejection: 'ineligible_decision',
  missing_browser_environment: 'need_more_evidence',
  human_criterion: 'needs_human',
};

function stubHeldOut(): HeldOutCaseResultV1 {
  const withoutHash = {
    caseId: 'corpus-case-1',
    taskContractHash: hash(1),
    outcomeDecision: 'request_changes' as const,
    evidenceManifestHash: hash(2),
  };
  return {
    ...withoutHash,
    resultHash: computeHeldOutCaseResultHash(withoutHash),
  };
}

function stubMobile(): MobileWebReviewResultV1 {
  const withoutHash = {
    scenario: 'mobile_web_outcome_review' as const,
    browserProofHash: hash(10),
    provedProperties: [...MOBILE_WEB_PROVED_PROPERTIES],
  };
  return {
    ...withoutHash,
    resultHash: computeMobileWebReviewResultHash(withoutHash),
  };
}

function stubMetrics(): BeforeAfterMetricsV1 {
  const withoutHash = {
    baselineCheckFullCommit: OTHER_SHA,
    qualifiedMainSha: GIT_SHA,
    totalTests: 100,
    addedTests: 10,
    addedAdditiveModules: 3,
    remainingRisks: ['closed_scope_decision'] as const,
  };
  return {
    ...withoutHash,
    metricsHash: computeBeforeAfterMetricsHash(withoutHash),
  };
}

describe('runAdversarialCases', () => {
  it('returns all eight cases sorted-unique, each matching ADVERSARIAL_CASE_TABLE', () => {
    const results = runAdversarialCases(NOW);
    expect(results).toHaveLength(ADVERSARIAL_CASES.length);

    const seen = new Set<string>();
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index]!;
      assertAdversarialCaseResultV1(result);
      expect(result.case).toBe(ADVERSARIAL_CASES[index]);
      expect(seen.has(result.case)).toBe(false);
      seen.add(result.case);

      const pinned = ADVERSARIAL_CASE_TABLE[result.case];
      expect(result.expectation).toBe(pinned.expectation);
      expect(result.taintKind).toBe(pinned.taintKind);
      expect(pinned.engines).toContain(result.engine);
      expect(result.refusalReason).toBe(EXPECTED_REFUSAL_REASON[result.case]);
    }
  });

  it('drives each engine to the pinned closed reason token', () => {
    const byCase = new Map(
      runAdversarialCases(NOW).map((result) => [result.case, result] as const),
    );

    expect(byCase.get('false_green')?.refusalReason).toBe('fail');
    expect(byCase.get('false_green')?.engine).toBe('m8_evaluation');

    expect(byCase.get('stale_approval')?.refusalReason).toBe('stale_version');
    expect(byCase.get('stale_approval')?.engine).toBe('m11_admission');

    expect(byCase.get('evidence_tamper')?.refusalReason).toBe(
      'need_more_evidence',
    );
    expect(byCase.get('evidence_tamper')?.engine).toBe('m6_eligibility');

    expect(byCase.get('restart_recovery')?.refusalReason).toBe('committed');
    expect(byCase.get('restart_recovery')?.expectation).toBe('no_effect');

    expect(byCase.get('duplicate_action')?.refusalReason).toBe(
      'idempotency_conflict',
    );
    expect(byCase.get('duplicate_action')?.expectation).toBe('no_effect');

    expect(byCase.get('reviewer_rejection')?.refusalReason).toBe(
      'ineligible_decision',
    );

    expect(byCase.get('missing_browser_environment')?.refusalReason).toBe(
      'need_more_evidence',
    );
    expect(byCase.get('missing_browser_environment')?.engine).toBe(
      'm6_eligibility',
    );

    expect(byCase.get('human_criterion')?.refusalReason).toBe('needs_human');
    expect(byCase.get('human_criterion')?.expectation).toBe('held_for_human');
  });

  it('is deterministic for a fixed injected now', () => {
    const first = runAdversarialCases(NOW);
    const second = runAdversarialCases(NOW);
    expect(canonicalSerialize(second)).toBe(canonicalSerialize(first));
  });

  it('passes assembleFinalReviewPackage coverage with a mobile-web stub', () => {
    const adversarialResults: readonly AdversarialCaseResultV1[] =
      runAdversarialCases(NOW);
    const packageValue = assembleFinalReviewPackage(
      {
        qualifiedMainSha: GIT_SHA,
        heldOutResults: [stubHeldOut()],
        adversarialResults,
        mobileWebResult: stubMobile(),
        metrics: stubMetrics(),
        remainingOwnerGate: REMAINING_OWNER_GATE,
      },
      NOW,
    );
    assertFinalReviewPackageV1(packageValue);
    expect(packageValue.remainingOwnerGate).toBe(REMAINING_OWNER_GATE);
    expect(packageValue.qualifiedMainSha).toBe(GIT_SHA);
  });
});
