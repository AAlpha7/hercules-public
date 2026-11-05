import { describe, expect, it } from 'vitest';
import {
  decodeReviewExperienceCapabilitiesV1,
  decodeReviewPackageV2,
  isOutcomeReviewPreference,
  ReviewDtoDecodeError,
  type OutcomeReviewLoadState,
  type ReviewPackageV2Dto,
} from '../../src/web/review/reviewTypes.js';
import {
  buildReviewViewModel,
  selectStrongestEvidence,
  statusPresentation,
  windowRows,
} from '../../src/web/review/reviewViewModel.js';

const SHA = `sha256:${'a'.repeat(64)}`;

function packageFixture(): ReviewPackageV2Dto {
  const candidate = {
    kind: 'git' as const,
    repository: 'example-org/acme',
    revision: '0123456789abcdef0123456789abcdef01234567',
  };
  const decisionBinding = {
    taskId: 'task-1',
    contractVersion: 1,
    contractHash: SHA,
    iterationId: 'iteration-1',
    candidateRef: candidate,
    evidenceManifestHash: SHA,
    evaluatorVersion: 'evaluator-v1',
    evaluatorModel: 'model-v1',
    evaluatorRuntime: 'runtime-v1',
    policyVersion: 'policy-v1',
  };
  const axis = {
    status: 'verified' as const,
    assertionIds: ['assertion-1'],
    evidenceArtifactIds: ['artifact-a', 'artifact-z', 'artifact-zz'],
    reasonCodes: [],
  };
  return {
    schema: 'hercules-review-package/v2',
    projectionHash: SHA,
    projectedAt: '2026-08-29T00:00:07.000Z',
    task: {
      id: 'task-1',
      title: 'Review task',
      objective: 'Verify the exact candidate.',
      state: 'review',
      advisoryTextAuthority: 'advisory',
    },
    binding: { ...decisionBinding, evidenceManifestId: 'manifest-1' },
    outcome: {
      status: 'pass',
      evaluatorOutcome: 'pass',
      decisionEligible: true,
      reasonCodes: [],
      advisorySummary: 'pass',
    },
    assertions: [
      {
        id: 'assertion-1',
        subjectKey: 'tests.unit',
        payloadHash: SHA,
        classification: 'verified',
        decisionEligible: true,
        usedByCriterionIds: ['criterion-1'],
        evidenceArtifactIds: ['artifact-a', 'artifact-z', 'artifact-zz'],
        receiptIds: ['receipt-1'],
        reasonCodes: [],
        advisoryText: 'Unit tests passed.',
      },
    ],
    trustAxes: {
      contractBinding: { ...axis, assertionIds: [], evidenceArtifactIds: [] },
      mechanical: axis,
      realSurface: {
        status: 'not_applicable',
        assertionIds: [],
        evidenceArtifactIds: [],
        reasonCodes: [],
      },
      independentReview: {
        status: 'not_applicable',
        assertionIds: [],
        evidenceArtifactIds: [],
        reasonCodes: ['review_axis_deferred'],
      },
      independentEvaluation: axis,
      human: {
        status: 'not_applicable',
        assertionIds: [],
        evidenceArtifactIds: [],
        reasonCodes: [],
      },
    },
    criteria: [
      {
        criterionId: 'criterion-1',
        authority: 'mechanical',
        required: true,
        status: 'pass',
        assertionIds: ['assertion-1'],
        evidenceArtifactIds: ['artifact-a', 'artifact-z', 'artifact-zz'],
        reasonCodes: [],
        advisoryExplanation: 'gate passed',
      },
    ],
    evidence: [
      {
        artifactRefId: 'artifact-a',
        sha256: `sha256:${'b'.repeat(64)}`,
        trustClass: 'derived',
        redactionState: 'none',
        criterionIds: ['criterion-1'],
        surface: 'derived-report',
        supportsAssertionIds: ['assertion-1'],
      },
      {
        artifactRefId: 'artifact-z',
        sha256: `sha256:${'c'.repeat(64)}`,
        trustClass: 'primary',
        redactionState: 'none',
        criterionIds: ['criterion-1'],
        surface: 'pnpm-test',
        supportsAssertionIds: ['assertion-1'],
      },
      {
        artifactRefId: 'artifact-zz',
        sha256: `sha256:${'d'.repeat(64)}`,
        trustClass: 'agent_claim',
        redactionState: 'restricted',
        criterionIds: ['criterion-1'],
        surface: 'agent-summary',
        supportsAssertionIds: ['assertion-1'],
      },
    ],
    blockingFindings: [],
    remainingRisks: [
      {
        code: 'risk-a',
        criterionIds: ['criterion-1'],
        assertionIds: ['assertion-1'],
        classification: 'verified',
        reasonCodes: [],
        advisorySummary: 'A retained risk.',
      },
    ],
    iterations: [
      {
        id: 'iteration-1',
        ordinal: 1,
        state: 'evaluating',
        candidateRef: candidate,
        evidenceManifestId: 'manifest-1',
        finalVerdictId: null,
        createdAt: '2026-08-29T00:00:04.000Z',
        endedAt: null,
      },
    ],
    requiredDecision: null,
    validDecisions: ['request_changes'],
    decisionBinding,
    decisionToken: null,
    usage: { durationMs: 100, tokens: 20, costUsd: 0.01 },
  };
}

function jsonClone(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

describe('browser ReviewPackageV2 decoder', () => {
  it('decodes the complete closed DTO without a domain or Node dependency', () => {
    const decoded = decodeReviewPackageV2(jsonClone(packageFixture()));
    expect(decoded).toEqual(packageFixture());
    expect(decoded.outcome.status).toBe('pass');
  });

  it('decodes closed capabilities and exposes closed preference/load types', () => {
    expect(
      decodeReviewExperienceCapabilitiesV1({
        schema: 'hercules-review-experience-capabilities/v1',
        outcomeReviewRead: true,
        boundDecisions: false,
        evidenceContent: true,
        learningProposals: false,
        controlApiV2: false,
      }),
    ).toEqual({
      schema: 'hercules-review-experience-capabilities/v1',
      outcomeReviewRead: true,
      boundDecisions: false,
      evidenceContent: true,
      learningProposals: false,
      controlApiV2: false,
    });
    expect(isOutcomeReviewPreference('legacy')).toBe(true);
    expect(isOutcomeReviewPreference('outcome_v2')).toBe(true);
    expect(isOutcomeReviewPreference('control_v2')).toBe(true);
    expect(isOutcomeReviewPreference('v3')).toBe(false);

    const state: OutcomeReviewLoadState = {
      kind: 'available',
      taskId: 'task-1',
      package: packageFixture(),
      source: 'legacy',
      stateVersion: null,
    };
    expect(state.kind).toBe('available');
  });

  it.each([
    ['top-level unknown field', (value: Record<string, unknown>) => { value['green'] = true; }],
    ['nested unknown field', (value: Record<string, unknown>) => {
      (value['outcome'] as Record<string, unknown>)['approved'] = true;
    }],
    ['unknown status', (value: Record<string, unknown>) => {
      (value['outcome'] as Record<string, unknown>)['status'] = 'verified';
    }],
    ['forged assertion eligibility', (value: Record<string, unknown>) => {
      const assertion = (value['assertions'] as Record<string, unknown>[])[0]!;
      assertion['classification'] = 'opinion';
    }],
    ['unsorted evidence', (value: Record<string, unknown>) => {
      (value['evidence'] as unknown[]).reverse();
    }],
    ['pass with a failing required criterion', (value: Record<string, unknown>) => {
      const criterion = (value['criteria'] as Record<string, unknown>[])[0]!;
      criterion['status'] = 'fail';
      criterion['reasonCodes'] = ['criterion_failed'];
    }],
    ['approve action on pass', (value: Record<string, unknown>) => {
      value['validDecisions'] = ['approve_outcome', 'reject_outcome', 'request_changes'];
    }],
    ['coordinated unverified pass premise', (value: Record<string, unknown>) => {
      const assertion = (value['assertions'] as Record<string, unknown>[])[0]!;
      assertion['classification'] = 'unverified_pending';
      assertion['decisionEligible'] = false;
      assertion['evidenceArtifactIds'] = [];
      assertion['receiptIds'] = [];
      assertion['reasonCodes'] = ['receipt_missing'];
      for (const evidence of value['evidence'] as Record<string, unknown>[]) {
        evidence['supportsAssertionIds'] = [];
      }
    }],
    ['pass with a failed authority axis', (value: Record<string, unknown>) => {
      const axes = value['trustAxes'] as Record<string, Record<string, unknown>>;
      axes['mechanical']!['status'] = 'failed';
    }],
    ['actionable non-exact Git binding', (value: Record<string, unknown>) => {
      const binding = value['binding'] as Record<string, unknown>;
      const decisionBinding = value['decisionBinding'] as Record<string, unknown>;
      const iterations = value['iterations'] as Record<string, unknown>[];
      for (const holder of [binding, decisionBinding, iterations[0]!]) {
        const candidate = holder['candidateRef'] as Record<string, unknown>;
        candidate['revision'] = 'short-sha';
      }
    }],
    ['task and binding identity mismatch', (value: Record<string, unknown>) => {
      const binding = value['binding'] as Record<string, unknown>;
      const decisionBinding = value['decisionBinding'] as Record<string, unknown>;
      binding['taskId'] = 'other-task';
      decisionBinding['taskId'] = 'other-task';
    }],
    ['pass with evaluator failure', (value: Record<string, unknown>) => {
      const outcome = value['outcome'] as Record<string, unknown>;
      outcome['evaluatorOutcome'] = 'fail';
    }],
    ['failure without a structural failure fact', (value: Record<string, unknown>) => {
      const outcome = value['outcome'] as Record<string, unknown>;
      outcome['status'] = 'fail';
      outcome['advisorySummary'] = 'fail';
      outcome['evaluatorOutcome'] = 'fail';
    }],
  ])('rejects %s before rendering', (_label, mutate) => {
    const value = jsonClone(packageFixture()) as Record<string, unknown>;
    mutate(value);
    expect(() => decodeReviewPackageV2(value)).toThrow(ReviewDtoDecodeError);
  });

  it('rejects malformed or optimistic capabilities', () => {
    expect(() =>
      decodeReviewExperienceCapabilitiesV1({
        schema: 'hercules-review-experience-capabilities/v1',
        outcomeReviewRead: true,
        boundDecisions: false,
        evidenceContent: false,
        learningProposals: false,
        controlApiV2: false,
        enabled: true,
      }),
    ).toThrow(ReviewDtoDecodeError);
  });
});

describe('outcome review view model', () => {
  it.each([
    ['verified', 'Verified', 'check', 'green'],
    ['pass', 'Pass', 'check', 'green'],
    ['inference', 'Inference', 'branch', 'blue'],
    ['unverified_pending', 'Needs evidence', 'search', 'amber'],
    ['need_more_evidence', 'Needs evidence', 'search', 'amber'],
    ['needs_human', 'Needs human', 'user', 'amber'],
    ['opinion', 'Opinion', 'message', 'gray'],
    ['failed', 'Failed', 'x', 'red'],
    ['fail', 'Failed', 'x', 'red'],
    ['not_applicable', 'Not applicable', 'minus', 'gray'],
  ] as const)('maps %s without false green', (status, label, icon, tone) => {
    expect(statusPresentation(status)).toEqual({ label, icon, tone });
  });

  it('counts required criteria and preserves the first failing/gap and risk rows', () => {
    const packageValue = packageFixture();
    const criteria = [
      { ...packageValue.criteria[0]!, criterionId: 'criterion-optional', required: false },
      { ...packageValue.criteria[0]!, criterionId: 'criterion-pass' },
      {
        ...packageValue.criteria[0]!,
        criterionId: 'criterion-gap',
        status: 'need_more_evidence' as const,
        reasonCodes: ['evidence_missing'] as const,
      },
      {
        ...packageValue.criteria[0]!,
        criterionId: 'criterion-fail',
        status: 'fail' as const,
        reasonCodes: ['criterion_failed'] as const,
      },
    ];
    const risks = [
      { ...packageValue.remainingRisks[0]!, code: 'risk-first' },
      { ...packageValue.remainingRisks[0]!, code: 'risk-second' },
    ];
    const view = buildReviewViewModel({
      ...packageValue,
      criteria,
      remainingRisks: risks,
    });

    expect(view.requiredCounts).toEqual({ total: 3, pass: 1, fail: 1, gap: 1 });
    expect(view.firstRequiredProblem?.criterionId).toBe('criterion-gap');
    expect(view.remainingRiskCount).toBe(2);
    expect(view.firstRemainingRisk?.code).toBe('risk-first');
  });

  it('windows rows at 20 without changing total or order', () => {
    const rows = Array.from({ length: 45 }, (_, index) => `row-${index}`);
    expect(windowRows(rows)).toEqual({
      rows: rows.slice(0, 20),
      totalCount: 45,
      visibleCount: 20,
      hasMore: true,
    });
    expect(windowRows(rows, 40).rows).toEqual(rows.slice(0, 40));
  });

  it('selects primary before derived, bytewise ID within rank, and never agent claims', () => {
    const packageValue = packageFixture();
    const criterion = packageValue.criteria[0]!;
    expect(
      selectStrongestEvidence(criterion, packageValue.evidence)?.artifactRefId,
    ).toBe('artifact-z');

    const withoutPrimary = packageValue.evidence.filter(
      (item) => item.trustClass !== 'primary',
    );
    expect(selectStrongestEvidence(criterion, withoutPrimary)?.artifactRefId).toBe(
      'artifact-a',
    );
    expect(
      selectStrongestEvidence(
        criterion,
        packageValue.evidence.map((item) => ({ ...item, trustClass: 'agent_claim' })),
      ),
    ).toBeNull();
  });
});
