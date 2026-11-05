import type { ReviewPackageV2Dto } from '../../../src/web/review/reviewTypes.js';

const SHA = `sha256:${'a'.repeat(64)}`;

export function reviewPackageFixture(overrides: {
  readonly taskId?: string;
  readonly title?: string;
  readonly outcome?: ReviewPackageV2Dto['outcome']['status'];
} = {}): ReviewPackageV2Dto {
  const taskId = overrides.taskId ?? 'review-1';
  const candidate = {
    kind: 'git' as const,
    repository: 'example-org/acme',
    revision: '0123456789abcdef0123456789abcdef01234567',
  };
  const decisionBinding = {
    taskId,
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
  const outcome = overrides.outcome ?? 'pass';
  const decisionEligible = outcome !== 'need_more_evidence';
  const validDecisions =
    outcome === 'needs_human'
      ? (['approve_outcome', 'reject_outcome', 'request_changes'] as const)
      : outcome === 'need_more_evidence'
        ? ([] as const)
        : (['request_changes'] as const);
  const axis = {
    status: 'verified' as const,
    assertionIds: ['assertion-1'],
    evidenceArtifactIds: ['artifact-1'],
    reasonCodes: [],
  };
  return {
    schema: 'hercules-review-package/v2',
    projectionHash: SHA,
    projectedAt: '2026-08-29T00:00:07.000Z',
    task: {
      id: taskId,
      title: overrides.title ?? 'Outcome review task',
      objective: 'Verify the exact candidate.',
      state: 'review',
      advisoryTextAuthority: 'advisory',
    },
    binding: { ...decisionBinding, evidenceManifestId: 'manifest-1' },
    outcome: {
      status: outcome,
      evaluatorOutcome:
        outcome === 'need_more_evidence'
          ? 'need_more_evidence'
          : outcome === 'fail'
            ? 'fail'
            : 'pass',
      decisionEligible,
      reasonCodes:
        outcome === 'needs_human'
          ? ['human_decision_required']
          : outcome === 'need_more_evidence'
            ? ['evidence_missing']
            : outcome === 'fail'
              ? ['criterion_failed']
            : [],
      advisorySummary: outcome,
    },
    assertions: [
      {
        id: 'assertion-1',
        subjectKey: 'tests.unit',
        payloadHash: SHA,
        classification: outcome === 'need_more_evidence' ? 'unverified_pending' : 'verified',
        decisionEligible: outcome !== 'need_more_evidence',
        usedByCriterionIds: ['criterion-1'],
        evidenceArtifactIds: outcome === 'need_more_evidence' ? [] : ['artifact-1'],
        receiptIds: outcome === 'need_more_evidence' ? [] : ['receipt-1'],
        reasonCodes: outcome === 'need_more_evidence' ? ['evidence_missing'] : [],
        advisoryText: 'Unit tests passed.',
      },
    ],
    trustAxes: {
      contractBinding: { ...axis, assertionIds: [], evidenceArtifactIds: [] },
      mechanical:
        outcome === 'need_more_evidence'
          ? {
              status: 'need_more_evidence',
              assertionIds: ['assertion-1'],
              evidenceArtifactIds: [],
              reasonCodes: ['evidence_missing'],
            }
          : outcome === 'fail'
            ? { ...axis, status: 'failed', reasonCodes: ['criterion_failed'] }
            : axis,
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
      independentEvaluation:
        outcome === 'need_more_evidence'
          ? {
              status: 'need_more_evidence',
              assertionIds: ['assertion-1'],
              evidenceArtifactIds: [],
              reasonCodes: ['evidence_missing'],
            }
          : outcome === 'fail'
            ? { ...axis, status: 'failed', reasonCodes: ['criterion_failed'] }
            : axis,
      human:
        outcome === 'needs_human'
          ? {
              status: 'needs_human',
              assertionIds: [],
              evidenceArtifactIds: [],
              reasonCodes: ['human_decision_required'],
            }
          : {
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
        status:
          outcome === 'need_more_evidence'
            ? 'need_more_evidence'
            : outcome === 'fail'
              ? 'fail'
              : 'pass',
        assertionIds: ['assertion-1'],
        evidenceArtifactIds: outcome === 'need_more_evidence' ? [] : ['artifact-1'],
        reasonCodes:
          outcome === 'need_more_evidence'
            ? ['evidence_missing']
            : outcome === 'fail'
              ? ['criterion_failed']
              : [],
        advisoryExplanation: outcome === 'need_more_evidence' ? '' : 'gate passed',
      },
    ],
    evidence:
      outcome === 'need_more_evidence'
        ? []
        : [
            {
              artifactRefId: 'artifact-1',
              sha256: `sha256:${'b'.repeat(64)}`,
              trustClass: 'primary',
              redactionState: 'none',
              criterionIds: ['criterion-1'],
              surface: 'pnpm-test',
              supportsAssertionIds: ['assertion-1'],
            },
          ],
    blockingFindings: [],
    remainingRisks: [],
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
    requiredDecision:
      outcome === 'needs_human'
        ? {
            kinds: ['approve_outcome', 'reject_outcome', 'request_changes'],
            policyDecisionIds: ['approve_outcome'],
            reasonCodes: ['human_decision_required'],
          }
        : null,
    validDecisions,
    decisionBinding: decisionEligible ? decisionBinding : null,
    decisionToken: null,
    usage: { durationMs: 100, tokens: 20, costUsd: 0.01 },
  };
}
