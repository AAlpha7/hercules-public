import { describe, expect, it } from 'vitest';

import {
  ADVERSARIAL_CASES,
  ADVERSARIAL_CASE_TABLE,
  MOBILE_WEB_PROVED_PROPERTIES,
  QUALIFICATION_PRECONDITION_REASONS,
  QualificationError,
  REMAINING_OWNER_GATE,
  assembleFinalReviewPackage,
  assertAdversarialCaseResultV1,
  assertBeforeAfterMetricsV1,
  assertFinalReviewPackageV1,
  assertHeldOutCaseResultV1,
  assertMobileWebReviewResultV1,
  assertResolvedOwnerDecisionV1,
  assertTerminalInventoryProjectionV1,
  assertTerminalInventoryVerdictV1,
  assertTerminalOpenPrIdentityV1,
  computeAdversarialCaseResultHash,
  computeBeforeAfterMetricsHash,
  computeFinalReviewPackageHash,
  computeHeldOutCaseResultHash,
  computeMobileWebReviewResultHash,
  computeTerminalInventoryProjectionHash,
  validateTerminalInventory,
  type AdversarialCaseResultV1,
  type AdversarialCaseV1,
  type AssembleFinalReviewPackageInputsV1,
  type BeforeAfterMetricsV1,
  type HeldOutCaseResultV1,
  type MobileWebReviewResultV1,
  type TerminalInventoryProjectionV1,
} from '../../src/domain/qualification.js';

const hash = (seed: number): string =>
  `sha256:${seed.toString(16).padStart(64, '0')}`;

const GIT_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CANONICAL_NOW = '2026-09-01T00:00:00.000Z';
const EXPIRES_LATER = '2026-09-01T01:00:00.000Z';
const EXPIRES_EARLIER = '2026-08-31T23:00:00.000Z';

function heldOutWithoutHash(
  over: Partial<Omit<HeldOutCaseResultV1, 'resultHash'>> = {},
): Omit<HeldOutCaseResultV1, 'resultHash'> {
  return {
    caseId: 'corpus-case-1',
    taskContractHash: hash(1),
    outcomeDecision: 'approve_outcome',
    evidenceManifestHash: hash(2),
    ...over,
  };
}

function validHeldOut(
  over: Partial<Omit<HeldOutCaseResultV1, 'resultHash'>> = {},
): HeldOutCaseResultV1 {
  const withoutHash = heldOutWithoutHash(over);
  return {
    ...withoutHash,
    resultHash: computeHeldOutCaseResultHash(withoutHash),
  };
}

function adversarialWithoutHash(
  caseId: AdversarialCaseV1,
  over: Partial<Omit<AdversarialCaseResultV1, 'resultHash' | 'case'>> = {},
): Omit<AdversarialCaseResultV1, 'resultHash'> {
  const pinned = ADVERSARIAL_CASE_TABLE[caseId];
  return {
    case: caseId,
    expectation: pinned.expectation,
    engine: pinned.engines[0]!,
    refusalReason: `closed-reason-${caseId}`,
    taintKind: pinned.taintKind,
    ...over,
  };
}

function validAdversarial(
  caseId: AdversarialCaseV1,
  over: Partial<Omit<AdversarialCaseResultV1, 'resultHash' | 'case'>> = {},
): AdversarialCaseResultV1 {
  const withoutHash = adversarialWithoutHash(caseId, over);
  return {
    ...withoutHash,
    resultHash: computeAdversarialCaseResultHash(withoutHash),
  };
}

function allAdversarialResults(): AdversarialCaseResultV1[] {
  return ADVERSARIAL_CASES.map((caseId) => validAdversarial(caseId));
}

function mobileWithoutHash(
  over: Partial<Omit<MobileWebReviewResultV1, 'resultHash'>> = {},
): Omit<MobileWebReviewResultV1, 'resultHash'> {
  return {
    scenario: 'mobile_web_outcome_review',
    browserProofHash: hash(10),
    provedProperties: [...MOBILE_WEB_PROVED_PROPERTIES],
    ...over,
  };
}

function validMobile(
  over: Partial<Omit<MobileWebReviewResultV1, 'resultHash'>> = {},
): MobileWebReviewResultV1 {
  const withoutHash = mobileWithoutHash(over);
  return {
    ...withoutHash,
    resultHash: computeMobileWebReviewResultHash(withoutHash),
  };
}

function metricsWithoutHash(
  over: Partial<Omit<BeforeAfterMetricsV1, 'metricsHash'>> = {},
): Omit<BeforeAfterMetricsV1, 'metricsHash'> {
  return {
    baselineCheckFullCommit: OTHER_SHA,
    qualifiedMainSha: GIT_SHA,
    totalTests: 100,
    addedTests: 10,
    addedAdditiveModules: 3,
    remainingRisks: [
      'closed_scope_decision',
      'discharged_into_db_cutover_gate',
      'external_followup_ci_billing',
    ],
    ...over,
  };
}

function validMetrics(
  over: Partial<Omit<BeforeAfterMetricsV1, 'metricsHash'>> = {},
): BeforeAfterMetricsV1 {
  const withoutHash = metricsWithoutHash(over);
  return {
    ...withoutHash,
    metricsHash: computeBeforeAfterMetricsHash(withoutHash),
  };
}

function validAssembleInputs(
  over: Partial<AssembleFinalReviewPackageInputsV1> = {},
): AssembleFinalReviewPackageInputsV1 {
  return {
    qualifiedMainSha: GIT_SHA,
    heldOutResults: [validHeldOut()],
    adversarialResults: allAdversarialResults(),
    mobileWebResult: validMobile(),
    metrics: validMetrics(),
    remainingOwnerGate: REMAINING_OWNER_GATE,
    ...over,
  };
}

function projectionWithoutHash(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: 'hercules-terminal-inventory-projection/v1',
    sourceInventoryHash: hash(20),
    repository: 'example-org/acme',
    queryScope: 'all-open-base-refs',
    baseRefFilter: null,
    defaultBranchHead: GIT_SHA,
    expiresAt: EXPIRES_LATER,
    paginationComplete: true,
    nextCursor: null,
    serverTotalOpenCount: 0,
    finalServerTotalOpenCount: 0,
    totalOpenCount: 0,
    pullRequests: [],
    ...over,
  };
}

function validProjection(
  over: Record<string, unknown> = {},
): TerminalInventoryProjectionV1 {
  const withoutHash = projectionWithoutHash(over);
  const projection = {
    ...withoutHash,
    projectionHash: computeTerminalInventoryProjectionHash(
      withoutHash as unknown as Omit<
        TerminalInventoryProjectionV1,
        'projectionHash'
      >,
    ),
  };
  return projection as unknown as TerminalInventoryProjectionV1;
}

describe('qualification — closed unions', () => {
  it('pins exactly eight adversarial cases and the five-member precondition union', () => {
    expect(ADVERSARIAL_CASES).toEqual([
      'false_green',
      'stale_approval',
      'evidence_tamper',
      'restart_recovery',
      'duplicate_action',
      'reviewer_rejection',
      'missing_browser_environment',
      'human_criterion',
    ]);
    expect(QUALIFICATION_PRECONDITION_REASONS).toEqual([
      'held_out_case_invalid',
      'adversarial_coverage_incomplete',
      'mobile_web_properties_incomplete',
      'metrics_binding_mismatch',
      'remaining_gate_mismatch',
    ]);
    expect(MOBILE_WEB_PROVED_PROPERTIES).toEqual([
      'criterion_evidence',
      'immutable_prior_iteration',
      'outcome_review',
      'refresh',
      'request_changes',
      'stale_rejection',
    ]);
  });

  it('pins the closed case→engine→taint→expectation table for every case', () => {
    expect(ADVERSARIAL_CASE_TABLE.false_green).toEqual({
      taintKind: 'confident_self_report',
      engines: ['m8_evaluation'],
      expectation: 'refused',
    });
    expect(ADVERSARIAL_CASE_TABLE.stale_approval).toEqual({
      taintKind: 'stale_binding',
      engines: ['m11_admission'],
      expectation: 'refused',
    });
    expect(ADVERSARIAL_CASE_TABLE.evidence_tamper).toEqual({
      taintKind: 'tampering',
      engines: ['m6_eligibility'],
      expectation: 'refused',
    });
    expect(ADVERSARIAL_CASE_TABLE.restart_recovery).toEqual({
      taintKind: 'raw_prose',
      engines: ['m11_admission'],
      expectation: 'no_effect',
    });
    expect(ADVERSARIAL_CASE_TABLE.duplicate_action).toEqual({
      taintKind: 'inference',
      engines: ['m11_admission'],
      expectation: 'no_effect',
    });
    expect(ADVERSARIAL_CASE_TABLE.reviewer_rejection).toEqual({
      taintKind: 'opinion',
      engines: ['m11_admission'],
      expectation: 'refused',
    });
    expect(ADVERSARIAL_CASE_TABLE.missing_browser_environment).toEqual({
      taintKind: 'missing_binding',
      engines: ['m6_eligibility', 'm12_assembler'],
      expectation: 'refused',
    });
    expect(ADVERSARIAL_CASE_TABLE.human_criterion).toEqual({
      taintKind: 'missing_binding',
      engines: ['m6_eligibility'],
      expectation: 'held_for_human',
    });
  });
});

describe('qualification — record validators', () => {
  it('accepts a valid held-out result and rejects extras, missing keys, and hash mismatch', () => {
    const result = validHeldOut();
    expect(() => assertHeldOutCaseResultV1(result)).not.toThrow();
    expect(Object.isFrozen(result)).toBe(true);
    expect(() =>
      assertHeldOutCaseResultV1({ ...result, extra: 1 }),
    ).toThrow(QualificationError);
    const { caseId: _removed, ...missing } = result;
    expect(() => assertHeldOutCaseResultV1(missing)).toThrow(QualificationError);
    expect(() =>
      assertHeldOutCaseResultV1({ ...result, resultHash: hash(999) }),
    ).toThrow(QualificationError);
    expect(() =>
      assertHeldOutCaseResultV1({
        ...result,
        outcomeDecision: 'not_a_decision',
      }),
    ).toThrow(QualificationError);
  });

  it('rejects sparse arrays and unsafe numbers on metrics', () => {
    const metrics = validMetrics();
    expect(() => assertBeforeAfterMetricsV1(metrics)).not.toThrow();
    expect(() =>
      assertBeforeAfterMetricsV1({ ...metrics, totalTests: Number.NaN }),
    ).toThrow(QualificationError);
    expect(() =>
      assertBeforeAfterMetricsV1({ ...metrics, addedTests: -1 }),
    ).toThrow(QualificationError);
    const sparse = validMetrics();
    const risks = ['a', 'b'] as string[];
    delete (risks as { [k: number]: string | undefined })[1];
    expect(() =>
      assertBeforeAfterMetricsV1({
        ...sparse,
        remainingRisks: risks,
        metricsHash: hash(1),
      }),
    ).toThrow(QualificationError);
    expect(() =>
      assertBeforeAfterMetricsV1({
        ...metrics,
        remainingRisks: ['z', 'a'],
        metricsHash: computeBeforeAfterMetricsHash({
          ...metricsWithoutHash(),
          remainingRisks: ['z', 'a'],
        }),
      }),
    ).toThrow(QualificationError);
  });

  it('deep-freezes records and rejects post-freeze mutation', () => {
    const result = validHeldOut();
    assertHeldOutCaseResultV1(result);
    expect(() => {
      (result as { caseId: string }).caseId = 'mutated';
    }).toThrow();
    const adversarial = validAdversarial('false_green');
    assertAdversarialCaseResultV1(adversarial);
    expect(() => {
      (adversarial as { refusalReason: string }).refusalReason = 'x';
    }).toThrow();
  });

  it('validates mobile-Web full property set and resolved owner decisions', () => {
    expect(() => assertMobileWebReviewResultV1(validMobile())).not.toThrow();
    expect(() =>
      assertMobileWebReviewResultV1(
        validMobile({
          provedProperties: ['outcome_review', 'refresh'],
        }),
      ),
    ).toThrow(QualificationError);
    expect(() =>
      assertResolvedOwnerDecisionV1({
        id: 'm13-terminal-decision-resolution',
        decided_at: CANONICAL_NOW,
        scope: 'program',
        decision: 'archive prior deferrals',
        terminal_disposition: 'closed_scope_decision',
      }),
    ).not.toThrow();
    expect(() =>
      assertResolvedOwnerDecisionV1({
        id: 'm13-terminal-decision-resolution',
        decided_at: CANONICAL_NOW,
        scope: 'program',
        decision: 'archive prior deferrals',
        terminal_disposition: 'not_a_disposition',
      }),
    ).toThrow(QualificationError);
  });

  it('validates terminal PR identity and zero projection', () => {
    expect(() =>
      assertTerminalOpenPrIdentityV1({
        number: 42,
        url: 'https://github.com/example-org/acme/pull/42',
        headSha: GIT_SHA,
        baseRef: 'main',
        state: 'OPEN',
      }),
    ).not.toThrow();
    expect(() =>
      assertTerminalOpenPrIdentityV1({
        number: 42,
        url: 'not-a-url',
        headSha: GIT_SHA,
        baseRef: 'main',
        state: 'OPEN',
      }),
    ).toThrow(QualificationError);
    const projection = validProjection();
    expect(() => assertTerminalInventoryProjectionV1(projection)).not.toThrow();
    expect(Object.isFrozen(projection)).toBe(true);
    expect(() =>
      assertTerminalInventoryProjectionV1({
        ...projection,
        projectionHash: hash(999),
      }),
    ).toThrow(QualificationError);
  });
});

describe('qualification — assembleFinalReviewPackage', () => {
  it('assembles a sealed final review package on the happy path', () => {
    const packageValue = assembleFinalReviewPackage(
      validAssembleInputs(),
      CANONICAL_NOW,
    );
    expect(() => assertFinalReviewPackageV1(packageValue)).not.toThrow();
    expect(packageValue.schema).toBe('hercules-final-review-package/v1');
    expect(packageValue.qualifiedMainSha).toBe(GIT_SHA);
    expect(packageValue.remainingOwnerGate).toBe(REMAINING_OWNER_GATE);
    expect(packageValue.mobileWebResultHash).toBe(validMobile().resultHash);
    expect(packageValue.packageHash).toBe(
      computeFinalReviewPackageHash({
        schema: packageValue.schema,
        qualifiedMainSha: packageValue.qualifiedMainSha,
        heldOutSummaryHash: packageValue.heldOutSummaryHash,
        adversarialSummaryHash: packageValue.adversarialSummaryHash,
        mobileWebResultHash: packageValue.mobileWebResultHash,
        metrics: packageValue.metrics,
        remainingOwnerGate: packageValue.remainingOwnerGate,
      }),
    );
    expect(Object.isFrozen(packageValue)).toBe(true);
  });

  it('throws exactly the five-member precondition union, each at its assembly step', () => {
    const thrown = new Set<string>();

    try {
      assembleFinalReviewPackage(
        validAssembleInputs({
          heldOutResults: [
            {
              ...validHeldOut(),
              resultHash: hash(999),
            },
          ],
        }),
        CANONICAL_NOW,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(QualificationError);
      expect((error as QualificationError).code).toBe('held_out_case_invalid');
      thrown.add((error as QualificationError).code);
    }

    try {
      assembleFinalReviewPackage(
        validAssembleInputs({
          adversarialResults: allAdversarialResults().slice(0, 7),
        }),
        CANONICAL_NOW,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(QualificationError);
      expect((error as QualificationError).code).toBe(
        'adversarial_coverage_incomplete',
      );
      thrown.add((error as QualificationError).code);
    }

    try {
      assembleFinalReviewPackage(
        validAssembleInputs({
          adversarialResults: allAdversarialResults().map((result) =>
            result.case === 'false_green'
              ? validAdversarial('false_green', { expectation: 'excluded' })
              : result,
          ),
        }),
        CANONICAL_NOW,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(QualificationError);
      expect((error as QualificationError).code).toBe(
        'adversarial_coverage_incomplete',
      );
      thrown.add((error as QualificationError).code);
    }

    try {
      assembleFinalReviewPackage(
        validAssembleInputs({
          mobileWebResult: validMobile({
            provedProperties: ['outcome_review', 'refresh'],
          }),
        }),
        CANONICAL_NOW,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(QualificationError);
      expect((error as QualificationError).code).toBe(
        'mobile_web_properties_incomplete',
      );
      thrown.add((error as QualificationError).code);
    }

    try {
      assembleFinalReviewPackage(
        validAssembleInputs({
          metrics: validMetrics({ qualifiedMainSha: OTHER_SHA }),
        }),
        CANONICAL_NOW,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(QualificationError);
      expect((error as QualificationError).code).toBe(
        'metrics_binding_mismatch',
      );
      thrown.add((error as QualificationError).code);
    }

    try {
      assembleFinalReviewPackage(
        validAssembleInputs({
          remainingOwnerGate: 'something_else',
        }),
        CANONICAL_NOW,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(QualificationError);
      expect((error as QualificationError).code).toBe('remaining_gate_mismatch');
      thrown.add((error as QualificationError).code);
    }

    expect([...thrown].sort()).toEqual(
      [...QUALIFICATION_PRECONDITION_REASONS].sort(),
    );
  });

  it('is deterministic for identical inputs and now', () => {
    const inputs = validAssembleInputs();
    const first = assembleFinalReviewPackage(inputs, CANONICAL_NOW);
    const second = assembleFinalReviewPackage(inputs, CANONICAL_NOW);
    expect(first).toEqual(second);
    expect(first.packageHash).toBe(second.packageHash);
  });
});

describe('qualification — validateTerminalInventory', () => {
  it('returns pass for a fully-valid zero projection', () => {
    const verdict = validateTerminalInventory(
      validProjection(),
      GIT_SHA,
      CANONICAL_NOW,
    );
    expect(() => assertTerminalInventoryVerdictV1(verdict)).not.toThrow();
    expect(verdict.outcome).toBe('pass');
    expect(verdict.reason).toBeNull();
    expect(verdict.totalOpenCount).toBe(0);
    expect(verdict.resolvedMainSha).toBe(GIT_SHA);
  });

  it('returns fail with a reason for each broken carrier and never throws', () => {
    const cases: Array<{ over: Record<string, unknown>; reason: string }> = [
      { over: { defaultBranchHead: OTHER_SHA }, reason: 'defaultBranchHead' },
      { over: { paginationComplete: false }, reason: 'paginationComplete' },
      { over: { nextCursor: 'page-2' }, reason: 'nextCursor' },
      { over: { totalOpenCount: 1, pullRequests: [] }, reason: 'totalOpenCount' },
      {
        over: { serverTotalOpenCount: 1 },
        reason: 'serverTotalOpenCount',
      },
      {
        over: { finalServerTotalOpenCount: 1 },
        reason: 'finalServerTotalOpenCount',
      },
      {
        over: {
          totalOpenCount: 1,
          pullRequests: [
            {
              number: 1,
              url: 'https://github.com/example-org/acme/pull/1',
              headSha: GIT_SHA,
              baseRef: 'main',
              state: 'OPEN',
            },
          ],
        },
        reason: 'totalOpenCount',
      },
      { over: { expiresAt: EXPIRES_EARLIER }, reason: 'expiresAt' },
      {
        over: { sourceInventoryHash: 'not-a-hash' },
        reason: 'sourceInventoryHash',
      },
      { over: { queryScope: 'default-branch-only' }, reason: 'queryScope' },
      { over: { baseRefFilter: 'main' }, reason: 'baseRefFilter' },
    ];

    for (const testCase of cases) {
      let verdict;
      expect(() => {
        verdict = validateTerminalInventory(
          validProjection(testCase.over),
          GIT_SHA,
          CANONICAL_NOW,
        );
      }).not.toThrow();
      expect(verdict!.outcome).toBe('fail');
      expect(verdict!.reason).toBe(testCase.reason);
      expect(
        QUALIFICATION_PRECONDITION_REASONS.includes(
          verdict!.reason as (typeof QUALIFICATION_PRECONDITION_REASONS)[number],
        ),
      ).toBe(false);
    }

    // Non-empty pullRequests with zero counts still fails on pullRequests.
    let nonEmpty;
    expect(() => {
      nonEmpty = validateTerminalInventory(
        validProjection({
          pullRequests: [
            {
              number: 1,
              url: 'https://github.com/example-org/acme/pull/1',
              headSha: GIT_SHA,
              baseRef: 'main',
              state: 'OPEN',
            },
          ],
        }),
        GIT_SHA,
        CANONICAL_NOW,
      );
    }).not.toThrow();
    expect(nonEmpty!.outcome).toBe('fail');
    expect(nonEmpty!.reason).toBe('pullRequests');
  });

  it('is deterministic for identical projection, expectedMainSha, and now', () => {
    const projection = validProjection();
    const first = validateTerminalInventory(projection, GIT_SHA, CANONICAL_NOW);
    const second = validateTerminalInventory(
      projection,
      GIT_SHA,
      CANONICAL_NOW,
    );
    expect(first).toEqual(second);
    expect(first.verdictHash).toBe(second.verdictHash);
  });
});
