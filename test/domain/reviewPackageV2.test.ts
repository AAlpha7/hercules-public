import { describe, expect, it } from 'vitest';
import { hashCanonicalJson } from '../../src/domain/canonicalJson.js';
import { computeTaskContractHash } from '../../src/domain/contractHash.js';
import {
  computeAssertionPayloadHash,
  computeEvidenceIntegrityAttestationHash,
  computeVerificationReceiptHash,
  type AssertionVerificationReceipt,
  type DecisionAssertion,
  type EvidenceIntegrityAttestation,
} from '../../src/domain/claimAuthorityV2.js';
import {
  assertReviewPackageV2StructuralConsistency,
  projectAndAssertReviewPackageV2,
  ReviewPackageV2Error,
  type SourceProjectedReviewPackageV2,
  type EvaluationDecisionRecordV2,
  type ReviewPackageV2,
  type ReviewPackageV2Source,
} from '../../src/domain/reviewPackageV2.js';
import type { ArtifactRef, EvidenceManifest } from '../../src/domain/artifact.js';
import type { EvaluationBinding, EvaluationVerdict } from '../../src/domain/evaluationVerdict.js';
import type { Iteration } from '../../src/domain/iteration.js';
import type { TaskContract } from '../../src/domain/taskContract.js';

const candidate = {
  kind: 'git' as const,
  repository: 'example-org/acme',
  revision: '0123456789abcdef0123456789abcdef01234567',
};

function buildSource(): ReviewPackageV2Source {
  const contractWithoutHash = {
    taskId: 'task-1',
    version: 1,
    contractHash: '',
    objective: 'Verify the exact candidate.',
    context: [],
    acceptanceCriteria: [
      {
        id: 'criterion-1',
        text: 'The unit gate passes.',
        authority: 'mechanical' as const,
        required: true,
        proofBinding: null,
      },
    ],
    constraints: [],
    forbiddenActions: [],
    capabilityPolicy: { version: 'capability-v1', grants: [] },
    verificationPolicy: {
      version: 'verification-v1',
      requiredEvidence: ['pnpm-test'],
      independentEvaluatorRequired: true,
    },
    approvalPolicy: { version: 'approval-v1', requiredDecisions: [] },
    budgetPolicy: {
      version: 'budget-v1',
      maxCostUsd: null,
      maxTokens: null,
      maxDurationMs: null,
    },
    createdBy: { kind: 'human' as const, id: 'owner' },
    createdAt: '2026-08-29T00:00:00.000Z',
    supersedesVersion: null,
  };
  const contract: TaskContract = {
    ...contractWithoutHash,
    contractHash: computeTaskContractHash(contractWithoutHash),
  };
  const artifact: ArtifactRef = {
    id: 'artifact-1',
    sha256: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    mediaType: 'application/json',
    byteLength: 42,
    storageKey: 'artifacts/artifact-1',
    producerStageRunId: 'verifier-1',
    createdAt: '2026-08-29T00:00:01.000Z',
    trustClass: 'primary',
    redactionState: 'none',
  };
  const manifestWithoutHash = {
    id: 'manifest-1',
    taskId: contract.taskId,
    contractVersion: contract.version,
    iterationId: 'iteration-1',
    candidateRef: candidate,
    entries: [
      {
        artifactRefId: artifact.id,
        criterionIds: ['criterion-1'],
        candidateRef: candidate,
        observedAt: '2026-08-29T00:00:02.000Z',
        environmentRef: 'test',
        surface: 'pnpm-test',
        trustClass: 'primary' as const,
      },
    ],
    createdAt: '2026-08-29T00:00:03.000Z',
  };
  const manifest: EvidenceManifest = {
    ...manifestWithoutHash,
    manifestHash: hashCanonicalJson(manifestWithoutHash),
  };
  const binding: EvaluationBinding = {
    taskId: contract.taskId,
    contractVersion: contract.version,
    contractHash: contract.contractHash,
    iterationId: 'iteration-1',
    candidateRef: candidate,
    evidenceManifestHash: manifest.manifestHash,
    evaluatorVersion: 'evaluator-v1',
    evaluatorModel: 'model-v1',
    evaluatorRuntime: 'runtime-v1',
    policyVersion: 'policy-v1',
  };
  const iteration: Iteration = {
    id: 'iteration-1',
    taskId: contract.taskId,
    contractVersion: contract.version,
    ordinal: 1,
    state: 'evaluating',
    candidateRef: candidate,
    evidenceManifestId: manifest.id,
    finalVerdictId: null,
    createdAt: '2026-08-29T00:00:04.000Z',
    endedAt: null,
    supersedesIterationId: null,
  };
  const assertion: DecisionAssertion = {
    id: 'assertion-1',
    subjectKey: 'tests.unit',
    kind: 'fact',
    canonicalPayload: { passed: true },
    payloadHash: computeAssertionPayloadHash({ passed: true }),
    advisoryText: 'Unit tests passed.',
  };
  const receiptWithoutHash = {
    schema: 'hercules-assertion-verification/v1' as const,
    id: 'receipt-1',
    assertionId: assertion.id,
    assertionPayloadHash: assertion.payloadHash,
    subjectKey: assertion.subjectKey,
    valueHash: assertion.payloadHash,
    taskId: contract.taskId,
    contractVersion: contract.version,
    contractHash: contract.contractHash,
    iterationId: iteration.id,
    candidateRef: candidate,
    evidenceManifestId: manifest.id,
    evidenceManifestHash: manifest.manifestHash,
    evidenceEntryArtifactIds: [artifact.id],
    criterionIds: ['criterion-1'],
    verifierRunId: 'verifier-1',
    verifierImplementation: 'fixture-v1',
    observationSurface: 'pnpm-test',
    observedAt: '2026-08-29T00:00:02.000Z',
  };
  const receipt: AssertionVerificationReceipt = {
    ...receiptWithoutHash,
    receiptHash: computeVerificationReceiptHash(receiptWithoutHash),
  };
  const attestationWithoutHash = {
    schema: 'hercules-evidence-integrity-attestation/v1' as const,
    result: 'intact' as const,
    evidenceManifestId: manifest.id,
    evidenceManifestHash: manifest.manifestHash,
    candidateRef: candidate,
    checkedArtifacts: [{ artifactRefId: artifact.id, sha256: artifact.sha256 }],
    verifierImplementation: 'integrity-v1',
    checkedAt: '2026-08-29T00:00:05.000Z',
  };
  const evidenceIntegrity: EvidenceIntegrityAttestation = {
    ...attestationWithoutHash,
    attestationHash: computeEvidenceIntegrityAttestationHash(attestationWithoutHash),
  };
  const result: EvaluationVerdict['criterionResults'][number] = {
    criterionId: 'criterion-1',
    status: 'pass',
    authority: 'mechanical',
    evidenceRefs: [artifact.id],
    observedAt: '2026-08-29T00:00:02.000Z',
    candidateBinding: JSON.stringify([
      candidate.kind,
      candidate.repository,
      candidate.revision,
    ]),
    explanation: 'gate passed',
  };
  const verdict: EvaluationVerdict = {
    id: 'verdict-1',
    binding,
    outcome: 'pass',
    criterionResults: [result],
    blockingFindings: [],
    nonBlockingRisks: [],
    recommendedNextStage: 'complete',
    evaluatorAgentRunId: 'evaluator-1',
    createdAt: '2026-08-29T00:00:06.000Z',
  };
  const evaluation: EvaluationDecisionRecordV2 = {
    schema: 'hercules-evaluation-decision/v2',
    verdict,
    criterionPremises: [{ key: 'criterion-1', assertionIds: [assertion.id] }],
    findingPremises: [],
    outcomeAssertionIds: [assertion.id],
    nextStageAssertionIds: [assertion.id],
  };

  return {
    task: { id: contract.taskId, title: 'Task 1', state: 'review' },
    currentBinding: binding,
    contract,
    currentIteration: iteration,
    iterationHistory: [iteration],
    evidenceManifest: manifest,
    artifacts: [artifact],
    evidenceIntegrity,
    assertions: [assertion],
    verificationReceipts: [receipt],
    evaluation,
    humanDecisions: [],
    authorityContext: {
      trustedVerifierRunIds: ['verifier-1'],
      implementerRunIds: ['implementer-1'],
      reviewerRunIds: ['reviewer-1'],
      evaluatorRunIds: ['evaluator-1'],
      agentClaimProducerRunIds: ['agent-claim-1'],
      evaluationAuthority: {
        evaluatorAgentRunId: 'evaluator-1',
        implementerAgentRunIds: ['implementer-1'],
      },
    },
    usage: { durationMs: 100, tokens: 20, costUsd: 0.01 },
    projectedAt: '2026-08-29T00:00:07.000Z',
  };
}

function replaceReceipt(
  source: ReviewPackageV2Source,
  overrides: Partial<Omit<AssertionVerificationReceipt, 'receiptHash'>>,
): ReviewPackageV2Source {
  const current = source.verificationReceipts[0]!;
  const { receiptHash: _receiptHash, ...withoutHash } = current;
  const next = { ...withoutHash, ...overrides };
  return {
    ...source,
    verificationReceipts: [
      { ...next, receiptHash: computeVerificationReceiptHash(next) },
    ],
  };
}

function replaceAttestation(
  source: ReviewPackageV2Source,
  overrides: Partial<Omit<EvidenceIntegrityAttestation, 'attestationHash'>>,
): ReviewPackageV2Source {
  const { attestationHash: _attestationHash, ...withoutHash } =
    source.evidenceIntegrity;
  const next = { ...withoutHash, ...overrides };
  return {
    ...source,
    evidenceIntegrity: {
      ...next,
      attestationHash: computeEvidenceIntegrityAttestationHash(next),
    },
  };
}

function rehashPackage(value: Omit<ReviewPackageV2, 'projectionHash'>): ReviewPackageV2 {
  return { ...value, projectionHash: hashCanonicalJson(value) };
}

function replaceContract(
  source: ReviewPackageV2Source,
  mutate: (contract: TaskContract) => TaskContract,
): ReviewPackageV2Source {
  const proposed = mutate(source.contract);
  const { contractHash: _contractHash, ...withoutHash } = proposed;
  const hashInput: TaskContract = { ...withoutHash, contractHash: '' };
  const contract: TaskContract = {
    ...hashInput,
    contractHash: computeTaskContractHash(hashInput),
  };
  const currentBinding = {
    ...source.currentBinding,
    contractHash: contract.contractHash,
  };
  const verificationReceipts = source.verificationReceipts.map((receipt) => {
    const { receiptHash: _receiptHash, ...receiptWithoutHash } = receipt;
    const rebound = { ...receiptWithoutHash, contractHash: contract.contractHash };
    return { ...rebound, receiptHash: computeVerificationReceiptHash(rebound) };
  });
  const evaluation =
    source.evaluation === null
      ? null
      : {
          ...source.evaluation,
          verdict: {
            ...source.evaluation.verdict,
            binding: {
              ...source.evaluation.verdict.binding,
              contractHash: contract.contractHash,
            },
          },
        };
  return {
    ...source,
    contract,
    currentBinding,
    verificationReceipts,
    evaluation,
    humanDecisions: source.humanDecisions.map((decision) => ({
      ...decision,
      binding: { ...decision.binding, contractHash: contract.contractHash },
    })),
  };
}

function withHumanCriterion(
  source: ReviewPackageV2Source,
  status: 'pending' | 'insufficient_evidence',
  recommendedNextStage: 'escalate_human' | 'reverify',
): ReviewPackageV2Source {
  const rebound = replaceContract(source, (contract) => ({
    ...contract,
    acceptanceCriteria: [
      ...contract.acceptanceCriteria,
      {
        id: 'criterion-human',
        text: 'The owner accepts the outcome.',
        authority: 'human',
        required: true,
        proofBinding: null,
      },
    ],
  }));
  const evaluation = rebound.evaluation!;
  return {
    ...rebound,
    evaluation: {
      ...evaluation,
      verdict: {
        ...evaluation.verdict,
        outcome: 'need_more_evidence',
        recommendedNextStage,
        criterionResults: [
          ...evaluation.verdict.criterionResults,
          {
            criterionId: 'criterion-human',
            status,
            authority: 'human',
            evidenceRefs: [],
            observedAt: null,
            candidateBinding:
              evaluation.verdict.criterionResults[0]!.candidateBinding,
            explanation: 'awaiting owner authority',
          },
        ],
      },
      criterionPremises: [
        ...evaluation.criterionPremises,
        { key: 'criterion-human', assertionIds: [] },
      ],
    },
  };
}

function withOutcomeDecision(
  source: ReviewPackageV2Source,
  decision: 'approve_outcome' | 'reject_outcome' | 'request_changes',
): ReviewPackageV2Source {
  return {
    ...source,
    humanDecisions: [
      {
        id: `decision-${decision}`,
        binding: source.currentBinding,
        decision,
        comment: null,
        actor: { kind: 'human', id: 'owner' },
        createdAt: '2026-08-29T00:00:06.500Z',
      },
    ],
  };
}

describe('M6 ReviewPackageV2 projection', () => {
  it('constructs the opaque authority type only from an authoritative source', () => {
    const displayDto: ReviewPackageV2 = projectAndAssertReviewPackageV2(buildSource());
    const acceptSourceProjected = (value: SourceProjectedReviewPackageV2) => value;
    type DisplayDtoCannotEnterAuthorityPath = ReviewPackageV2 extends SourceProjectedReviewPackageV2
      ? never
      : false;
    const displayDtoCannotEnterAuthorityPath: DisplayDtoCannotEnterAuthorityPath = false;

    expect(displayDtoCannotEnterAuthorityPath).toBe(false);
    const projected = projectAndAssertReviewPackageV2(buildSource());
    expect(acceptSourceProjected(projected)).toEqual(displayDto);
  });

  it('projects a deterministic evidence-bound pass package', () => {
    const source = buildSource();
    const result = projectAndAssertReviewPackageV2(source);

    expect(() => assertReviewPackageV2StructuralConsistency(result)).not.toThrow();
    expect(result.outcome).toMatchObject({
      status: 'pass',
      evaluatorOutcome: 'pass',
      decisionEligible: true,
      reasonCodes: [],
    });
    expect(result.assertions).toEqual([
      expect.objectContaining({
        id: 'assertion-1',
        classification: 'verified',
        decisionEligible: true,
        usedByCriterionIds: ['criterion-1'],
        receiptIds: ['receipt-1'],
        evidenceArtifactIds: ['artifact-1'],
        reasonCodes: [],
      }),
    ]);
    expect(result.trustAxes).toMatchObject({
      contractBinding: { status: 'verified', reasonCodes: [] },
      mechanical: { status: 'verified', reasonCodes: [] },
      realSurface: { status: 'not_applicable', reasonCodes: [] },
      independentReview: {
        status: 'not_applicable',
        reasonCodes: ['review_axis_deferred'],
      },
      independentEvaluation: { status: 'verified', reasonCodes: [] },
      human: { status: 'not_applicable', reasonCodes: [] },
    });
    expect(result.evidence[0]).toMatchObject({
      artifactRefId: 'artifact-1',
      supportsAssertionIds: ['assertion-1'],
    });
    expect(result.validDecisions).toEqual(['request_changes']);
    expect(result.decisionBinding).toEqual(source.currentBinding);
    expect(result.decisionToken).toBeNull();
    expect(projectAndAssertReviewPackageV2(source)).toEqual(result);
  });

  it('fails closed and withholds support when evaluation is missing', () => {
    const source = buildSource();
    const result = projectAndAssertReviewPackageV2({ ...source, evaluation: null });

    expect(result.outcome).toEqual({
      status: 'need_more_evidence',
      evaluatorOutcome: null,
      decisionEligible: false,
      reasonCodes: ['evaluation_missing'],
      advisorySummary: 'need_more_evidence',
    });
    expect(result.assertions[0]).toMatchObject({
      classification: 'unverified_pending',
      decisionEligible: false,
      usedByCriterionIds: [],
      receiptIds: [],
      evidenceArtifactIds: [],
      reasonCodes: ['evaluation_missing'],
    });
    expect(result.criteria[0]).toMatchObject({
      status: 'need_more_evidence',
      assertionIds: [],
      evidenceArtifactIds: [],
      reasonCodes: ['evaluation_missing'],
      advisoryExplanation: '',
    });
    expect(result.blockingFindings).toEqual([]);
    expect(result.remainingRisks).toEqual([]);
    expect(result.validDecisions).toEqual([]);
    expect(result.decisionBinding).toBeNull();
    expect(result.requiredDecision).toBeNull();
    expect(() => assertReviewPackageV2StructuralConsistency(result)).not.toThrow();
  });

  it.each([
    [
      'self report',
      (source: ReviewPackageV2Source) =>
        replaceReceipt(source, { verifierRunId: 'untrusted-agent' }),
      ['self_report', 'evaluation_premise_ineligible'],
    ],
    [
      'coverage mismatch',
      (source: ReviewPackageV2Source) =>
        replaceReceipt(source, { criterionIds: ['other-criterion'] }),
      ['receipt_coverage_mismatch', 'evaluation_premise_ineligible'],
    ],
    [
      'observation mismatch',
      (source: ReviewPackageV2Source) =>
        replaceReceipt(source, { observedAt: '2026-08-29T00:00:02.001Z' }),
      ['observation_mismatch', 'evaluation_premise_ineligible'],
    ],
  ] as const)('keeps an otherwise green %s non-authoritative', (_case, mutate, reasons) => {
    const result = projectAndAssertReviewPackageV2(mutate(buildSource()));

    expect(result.outcome.status).toBe('need_more_evidence');
    expect(result.outcome.reasonCodes).toEqual(reasons);
    expect(result.assertions[0]).toMatchObject({
      classification: 'unverified_pending',
      receiptIds: [],
      evidenceArtifactIds: [],
      reasonCodes: [reasons[0]],
    });
    expect(result.validDecisions).toEqual([]);
    expect(result.decisionBinding).toBeNull();
  });

  it.each([
    [
      'receipt hash mismatch',
      (source: ReviewPackageV2Source): ReviewPackageV2Source => ({
        ...source,
        verificationReceipts: [
          {
            ...source.verificationReceipts[0]!,
            receiptHash:
              'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
        ],
      }),
      ['receipt_hash_mismatch'],
    ],
    [
      'stale receipt binding',
      (source: ReviewPackageV2Source): ReviewPackageV2Source =>
        replaceReceipt(source, {
          candidateRef: { ...candidate, revision: '1'.repeat(40) },
        }),
      ['receipt_stale'],
    ],
    [
      'assertion binding mismatch',
      (source: ReviewPackageV2Source): ReviewPackageV2Source =>
        replaceReceipt(source, { subjectKey: 'tests.other' }),
      ['assertion_binding_mismatch'],
    ],
    [
      'value mismatch',
      (source: ReviewPackageV2Source): ReviewPackageV2Source =>
        replaceReceipt(source, {
          valueHash:
            'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        }),
      ['value_mismatch', 'structured_contradiction'],
    ],
    [
      'missing cited evidence',
      (source: ReviewPackageV2Source): ReviewPackageV2Source =>
        replaceReceipt(source, { evidenceEntryArtifactIds: [] }),
      ['evidence_missing'],
    ],
  ] as const)('emits the exact local reason for %s', (_case, mutate, reasons) => {
    const result = projectAndAssertReviewPackageV2(mutate(buildSource()));

    expect(result.assertions[0]).toMatchObject({
      classification: 'unverified_pending',
      decisionEligible: false,
      evidenceArtifactIds: [],
      receiptIds: [],
      reasonCodes: reasons,
    });
    expect(result.outcome.reasonCodes).toEqual([
      ...reasons,
      'evaluation_premise_ineligible',
    ]);
  });

  it('projects stale and relationship-incomplete evaluations as distinct closed gaps', () => {
    const source = buildSource();
    const staleEvaluation = {
      ...source.evaluation!,
      verdict: {
        ...source.evaluation!.verdict,
        binding: {
          ...source.evaluation!.verdict.binding,
          evaluatorVersion: 'stale-evaluator',
        },
      },
    };
    const incompleteEvaluation = {
      ...source.evaluation!,
      criterionPremises: [],
    };

    expect(
      projectAndAssertReviewPackageV2({ ...source, evaluation: staleEvaluation }).outcome
        .reasonCodes,
    ).toEqual(['evaluation_stale']);
    expect(
      projectAndAssertReviewPackageV2({ ...source, evaluation: incompleteEvaluation }).outcome
        .reasonCodes,
    ).toEqual(['evaluation_incomplete']);
  });

  it.each([
    [
      'omitted required criterion result',
      (source: ReviewPackageV2Source): EvaluationDecisionRecordV2 => ({
        ...source.evaluation!,
        verdict: { ...source.evaluation!.verdict, criterionResults: [] },
        criterionPremises: [],
      }),
    ],
    [
      'extra criterion premise row',
      (source: ReviewPackageV2Source): EvaluationDecisionRecordV2 => ({
        ...source.evaluation!,
        criterionPremises: [
          ...source.evaluation!.criterionPremises,
          { key: 'unknown-criterion', assertionIds: [] },
        ],
      }),
    ],
    [
      'outcome assertion union mismatch',
      (source: ReviewPackageV2Source): EvaluationDecisionRecordV2 => ({
        ...source.evaluation!,
        outcomeAssertionIds: [],
      }),
    ],
    [
      'empty non-human next-stage premise',
      (source: ReviewPackageV2Source): EvaluationDecisionRecordV2 => ({
        ...source.evaluation!,
        nextStageAssertionIds: [],
      }),
    ],
    [
      'missing blocking-finding premise row',
      (source: ReviewPackageV2Source): EvaluationDecisionRecordV2 => ({
        ...source.evaluation!,
        verdict: {
          ...source.evaluation!.verdict,
          outcome: 'fail',
          recommendedNextStage: 'repair',
          blockingFindings: [
            {
              code: 'finding-1',
              summary: 'A blocking finding.',
              criterionIds: ['criterion-1'],
            },
          ],
        },
      }),
    ],
    [
      'extra finding premise row',
      (source: ReviewPackageV2Source): EvaluationDecisionRecordV2 => ({
        ...source.evaluation!,
        findingPremises: [
          { key: 'unknown-finding', assertionIds: ['assertion-1'] },
        ],
      }),
    ],
    [
      'unknown next-stage assertion',
      (source: ReviewPackageV2Source): EvaluationDecisionRecordV2 => ({
        ...source.evaluation!,
        nextStageAssertionIds: ['unknown-assertion'],
      }),
    ],
    [
      'finding with an unknown criterion',
      (source: ReviewPackageV2Source): EvaluationDecisionRecordV2 => ({
        ...source.evaluation!,
        verdict: {
          ...source.evaluation!.verdict,
          outcome: 'fail',
          recommendedNextStage: 'repair',
          blockingFindings: [
            {
              code: 'finding-1',
              summary: 'A blocking finding.',
              criterionIds: ['unknown-criterion'],
            },
          ],
        },
        findingPremises: [{ key: 'finding-1', assertionIds: ['assertion-1'] }],
        outcomeAssertionIds: ['assertion-1'],
      }),
    ],
  ] as const)('maps a structurally valid %s relationship gap to a closed package', (_case, mutate) => {
    const source = buildSource();
    const result = projectAndAssertReviewPackageV2({
      ...source,
      evaluation: mutate(source),
    });

    expect(result.outcome).toMatchObject({
      status: 'need_more_evidence',
      evaluatorOutcome: null,
      decisionEligible: false,
      reasonCodes: ['evaluation_incomplete'],
    });
    expect(result.blockingFindings).toEqual([]);
    expect(result.validDecisions).toEqual([]);
    expect(result.decisionBinding).toBeNull();
  });

  it('maps a valid negative integrity result to evidence failure and rejects a lying intact result', () => {
    const source = buildSource();
    const tampered = projectAndAssertReviewPackageV2(
      replaceAttestation(source, { result: 'tampered' }),
    );
    expect(tampered.outcome.reasonCodes).toEqual([
      'evidence_tampered',
      'evaluation_premise_ineligible',
    ]);
    expect(tampered.assertions[0]?.reasonCodes).toEqual(['evidence_tampered']);

    expect(() =>
      projectAndAssertReviewPackageV2(
        replaceAttestation(source, { checkedArtifacts: [] }),
      ),
    ).toThrow('contradicts current manifest inventory');
  });

  it('keeps a policy-only outcome approval unresolved until exact human authority exists', () => {
    const source = replaceContract(buildSource(), (contract) => ({
      ...contract,
      approvalPolicy: {
        ...contract.approvalPolicy,
        requiredDecisions: ['approve_outcome'],
      },
    }));
    const unresolved = projectAndAssertReviewPackageV2(source);

    expect(unresolved.outcome).toMatchObject({
      status: 'needs_human',
      evaluatorOutcome: 'pass',
      decisionEligible: true,
      reasonCodes: ['human_decision_required'],
    });
    expect(unresolved.trustAxes.human).toMatchObject({
      status: 'needs_human',
      reasonCodes: ['human_decision_required'],
    });
    expect(unresolved.requiredDecision).toEqual({
      kinds: ['approve_outcome', 'reject_outcome', 'request_changes'],
      policyDecisionIds: ['approve_outcome'],
      reasonCodes: ['human_decision_required'],
    });
    expect(unresolved.validDecisions).toEqual([
      'approve_outcome',
      'reject_outcome',
      'request_changes',
    ]);

    const approved = projectAndAssertReviewPackageV2(
      withOutcomeDecision(source, 'approve_outcome'),
    );
    expect(approved.outcome.status).toBe('pass');
    expect(approved.trustAxes.human.status).toBe('verified');
    expect(approved.requiredDecision).toBeNull();
    expect(approved.validDecisions).toEqual(['request_changes']);
  });

  it('distinguishes a human-only gap from an all-insufficient reverify gap', () => {
    const reverify = projectAndAssertReviewPackageV2(
      withHumanCriterion(buildSource(), 'insufficient_evidence', 'reverify'),
    );
    expect(reverify.outcome.status).toBe('need_more_evidence');
    expect(reverify.outcome.decisionEligible).toBe(false);
    expect(reverify.trustAxes.independentEvaluation.status).toBe(
      'need_more_evidence',
    );
    expect(reverify.validDecisions).toEqual([]);
    expect(reverify.decisionBinding).toBeNull();

    const pendingSource = withHumanCriterion(
      buildSource(),
      'pending',
      'escalate_human',
    );
    const pending = projectAndAssertReviewPackageV2(pendingSource);
    expect(pending.outcome.status).toBe('needs_human');
    expect(pending.outcome.decisionEligible).toBe(true);
    expect(pending.trustAxes.independentEvaluation.status).toBe('verified');

    const approved = projectAndAssertReviewPackageV2(
      withOutcomeDecision(pendingSource, 'approve_outcome'),
    );
    expect(approved.outcome).toMatchObject({
      status: 'pass',
      evaluatorOutcome: 'need_more_evidence',
      decisionEligible: true,
    });
  });

  it('publishes a verified human-only blocking finding on every owning authority surface', () => {
    const source = withHumanCriterion(
      buildSource(),
      'pending',
      'escalate_human',
    );
    const evaluation = source.evaluation!;
    const currentReceipt = source.verificationReceipts[0]!;
    const { receiptHash: _receiptHash, ...receiptWithoutHash } = currentReceipt;
    const receipt = {
      ...receiptWithoutHash,
      criterionIds: ['criterion-1', 'criterion-human'],
    };
    const projected = projectAndAssertReviewPackageV2({
      ...source,
      verificationReceipts: [
        { ...receipt, receiptHash: computeVerificationReceiptHash(receipt) },
      ],
      evaluation: {
        ...evaluation,
        verdict: {
          ...evaluation.verdict,
          outcome: 'fail',
          recommendedNextStage: 'repair',
          blockingFindings: [
            {
              code: 'owner-block',
              summary: 'Owner-facing blocker.',
              criterionIds: ['criterion-human'],
            },
          ],
        },
        findingPremises: [
          { key: 'owner-block', assertionIds: ['assertion-1'] },
        ],
      },
    });

    expect(projected.outcome).toMatchObject({
      status: 'fail',
      reasonCodes: ['blocking_finding'],
      decisionEligible: true,
    });
    expect(projected.validDecisions).toEqual(['request_changes']);
    expect(projected.decisionBinding).toEqual(source.currentBinding);
    expect(projected.criteria.find((row) => row.criterionId === 'criterion-human')).toMatchObject({
      status: 'needs_human',
      reasonCodes: ['blocking_finding', 'human_decision_required'],
    });
    expect(projected.trustAxes.human).toMatchObject({
      status: 'failed',
      reasonCodes: ['blocking_finding', 'human_decision_required'],
    });
    expect(projected.trustAxes.independentEvaluation).toMatchObject({
      status: 'failed',
      reasonCodes: ['blocking_finding'],
    });
  });

  it('keeps the independent-evaluation axis non-green when required premises are unverified', () => {
    const projected = projectAndAssertReviewPackageV2({
      ...buildSource(),
      verificationReceipts: [],
    });

    expect(projected.outcome.status).toBe('need_more_evidence');
    expect(projected.trustAxes.independentEvaluation).toMatchObject({
      status: 'need_more_evidence',
      reasonCodes: ['receipt_missing', 'evaluation_premise_ineligible'],
    });
    expect(projected.decisionBinding).toBeNull();
  });

  it('does not attribute a human-only rejection to a non-required evaluator axis', () => {
    const source = replaceContract(buildSource(), (contract) => ({
      ...contract,
      verificationPolicy: {
        ...contract.verificationPolicy,
        independentEvaluatorRequired: false,
      },
    }));
    const projected = projectAndAssertReviewPackageV2(
      withOutcomeDecision(source, 'reject_outcome'),
    );

    expect(projected.outcome.status).toBe('fail');
    expect(projected.outcome.reasonCodes).toEqual(['human_rejected']);
    expect(projected.outcome.decisionEligible).toBe(true);
    expect(projected.validDecisions).toEqual(['request_changes']);
    expect(projected.trustAxes.independentEvaluation).toEqual({
      status: 'not_applicable',
      assertionIds: [],
      evidenceArtifactIds: [],
      reasonCodes: [],
    });
  });

  it('fails closed when opposite current human decisions share one exact binding', () => {
    const source = withHumanCriterion(
      buildSource(),
      'pending',
      'escalate_human',
    );
    const approval = withOutcomeDecision(source, 'approve_outcome').humanDecisions[0]!;
    const rejection = withOutcomeDecision(source, 'reject_outcome').humanDecisions[0]!;
    const projected = projectAndAssertReviewPackageV2({
      ...source,
      humanDecisions: [approval, rejection],
    });

    expect(projected.outcome.status).toBe('need_more_evidence');
    expect(projected.outcome.reasonCodes).toEqual(['human_decision_conflict']);
    expect(projected.outcome.decisionEligible).toBe(false);
    expect(projected.validDecisions).toEqual([]);
    expect(projected.decisionBinding).toBeNull();
  });

  it('offers only request changes for a fully verified criterion failure', () => {
    const source = buildSource();
    const evaluation = source.evaluation!;
    const projected = projectAndAssertReviewPackageV2({
      ...source,
      evaluation: {
        ...evaluation,
        verdict: {
          ...evaluation.verdict,
          outcome: 'fail',
          recommendedNextStage: 'repair',
          criterionResults: evaluation.verdict.criterionResults.map((result) => ({
            ...result,
            status: 'fail' as const,
          })),
        },
      },
    });

    expect(projected.outcome).toMatchObject({
      status: 'fail',
      decisionEligible: true,
      reasonCodes: ['criterion_failed'],
    });
    expect(projected.validDecisions).toEqual(['request_changes']);
    expect(projected.decisionBinding).toEqual(source.currentBinding);
  });

  it('withholds actions when a verified failure coexists with an unverified blocker', () => {
    const source = buildSource();
    const evaluation = source.evaluation!;
    const unverified: DecisionAssertion = {
      id: 'assertion-unverified-blocker',
      subjectKey: 'finding.unverified-blocker',
      kind: 'fact',
      canonicalPayload: { blocked: true },
      payloadHash: computeAssertionPayloadHash({ blocked: true }),
      advisoryText: 'An unverified blocker.',
    };
    const projected = projectAndAssertReviewPackageV2({
      ...source,
      assertions: [...source.assertions, unverified],
      evaluation: {
        ...evaluation,
        verdict: {
          ...evaluation.verdict,
          outcome: 'fail',
          recommendedNextStage: 'repair',
          criterionResults: evaluation.verdict.criterionResults.map((result) => ({
            ...result,
            status: 'fail' as const,
          })),
          blockingFindings: [
            {
              code: 'unverified-blocker',
              summary: 'An unverified blocker.',
              criterionIds: ['criterion-1'],
            },
          ],
        },
        findingPremises: [
          {
            key: 'unverified-blocker',
            assertionIds: [unverified.id],
          },
        ],
        outcomeAssertionIds: ['assertion-1', unverified.id],
      },
    });

    expect(projected.outcome.status).toBe('fail');
    expect(projected.blockingFindings).toEqual([
      expect.objectContaining({
        code: 'unverified-blocker',
        classification: 'unverified_pending',
      }),
    ]);
    expect(projected.outcome.decisionEligible).toBe(false);
    expect(projected.validDecisions).toEqual([]);
    expect(projected.decisionBinding).toBeNull();
  });

  it('preserves unsupported policy IDs exactly and never lets them hide an eligible failure', () => {
    const source = replaceContract(buildSource(), (contract) => ({
      ...contract,
      approvalPolicy: {
        ...contract.approvalPolicy,
        requiredDecisions: ['z-policy', 'a-policy', 'z-policy'],
      },
    }));
    const diagnostic = projectAndAssertReviewPackageV2(source);
    expect(diagnostic.outcome.status).toBe('need_more_evidence');
    expect(diagnostic.requiredDecision).toEqual({
      kinds: [],
      policyDecisionIds: ['a-policy', 'z-policy', 'z-policy'],
      reasonCodes: ['unsupported_policy_decision'],
    });

    const evaluation = source.evaluation!;
    const failed = projectAndAssertReviewPackageV2({
      ...source,
      evaluation: {
        ...evaluation,
        verdict: {
          ...evaluation.verdict,
          outcome: 'fail',
          recommendedNextStage: 'repair',
          criterionResults: evaluation.verdict.criterionResults.map((result) => ({
            ...result,
            status: 'fail' as const,
          })),
        },
      },
    });
    expect(failed.outcome.status).toBe('fail');
    expect(failed.outcome.reasonCodes).toEqual([
      'criterion_failed',
      'unsupported_policy_decision',
    ]);
    expect(failed.outcome.decisionEligible).toBe(false);
    expect(failed.requiredDecision).toEqual(diagnostic.requiredDecision);
  });

  it('keeps stale human records advisory and off the package outcome reasons', () => {
    const source = withHumanCriterion(
      buildSource(),
      'pending',
      'escalate_human',
    );
    const stale = withOutcomeDecision(source, 'approve_outcome').humanDecisions[0]!;
    const projected = projectAndAssertReviewPackageV2({
      ...source,
      humanDecisions: [
        {
          ...stale,
          binding: { ...stale.binding, evaluatorVersion: 'stale-evaluator' },
        },
      ],
    });

    expect(projected.outcome.reasonCodes).toEqual(['human_decision_required']);
    expect(projected.criteria.find((row) => row.criterionId === 'criterion-human')?.reasonCodes).toEqual([
      'human_decision_required',
      'human_decision_stale',
    ]);
    expect(projected.trustAxes.human.reasonCodes).toEqual([
      'human_decision_required',
      'human_decision_stale',
    ]);
  });

  it('is permutation-stable and excludes extra artifact inventory from the public hash', () => {
    const source = buildSource();
    const advisory: DecisionAssertion = {
      id: 'inference-1',
      subjectKey: 'risk.follow-up',
      kind: 'inference',
      canonicalPayload: { possible: true },
      payloadHash: computeAssertionPayloadHash({ possible: true }),
      advisoryText: 'Follow-up may be useful.',
    };
    const extraArtifact: ArtifactRef = {
      ...source.artifacts[0]!,
      id: 'artifact-extra',
      sha256:
        'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      storageKey: 'artifacts/artifact-extra',
    };
    const withExtraIntegrity = replaceAttestation(source, {
      checkedArtifacts: [
        ...source.evidenceIntegrity.checkedArtifacts,
        { artifactRefId: extraArtifact.id, sha256: extraArtifact.sha256 },
      ],
    });
    const first = projectAndAssertReviewPackageV2({
      ...withExtraIntegrity,
      assertions: [source.assertions[0]!, advisory],
      artifacts: [source.artifacts[0]!, extraArtifact],
    });
    const second = projectAndAssertReviewPackageV2({
      ...withExtraIntegrity,
      assertions: [advisory, source.assertions[0]!],
      artifacts: [extraArtifact, source.artifacts[0]!],
      evidenceIntegrity: replaceAttestation(source, {
        checkedArtifacts: [
          { artifactRefId: extraArtifact.id, sha256: extraArtifact.sha256 },
          ...source.evidenceIntegrity.checkedArtifacts,
        ],
      }).evidenceIntegrity,
    });

    expect(second).toEqual(first);
    expect(first.evidence.map((item) => item.artifactRefId)).toEqual(['artifact-1']);
  });

  it('does not let an unused unsupported value contradict verified current facts', () => {
    const source = buildSource();
    const unused: DecisionAssertion = {
      id: 'assertion-unused',
      subjectKey: source.assertions[0]!.subjectKey,
      kind: 'fact',
      canonicalPayload: { passed: false },
      payloadHash: computeAssertionPayloadHash({ passed: false }),
      advisoryText: 'An unsupported conflicting claim.',
    };
    const projected = projectAndAssertReviewPackageV2({
      ...source,
      assertions: [...source.assertions, unused],
    });

    expect(projected.outcome.status).toBe('pass');
    expect(projected.outcome.decisionEligible).toBe(true);
    expect(projected.assertions).toEqual([
      expect.objectContaining({
        id: 'assertion-1',
        classification: 'verified',
        reasonCodes: [],
      }),
      expect.objectContaining({
        id: 'assertion-unused',
        classification: 'unverified_pending',
        reasonCodes: ['receipt_missing'],
      }),
    ]);
  });

  it('fails closed on distinct same-subject values only when both are otherwise eligible', () => {
    const source = buildSource();
    const conflicting: DecisionAssertion = {
      id: 'assertion-2',
      subjectKey: source.assertions[0]!.subjectKey,
      kind: 'fact',
      canonicalPayload: { passed: false },
      payloadHash: computeAssertionPayloadHash({ passed: false }),
      advisoryText: 'The same gate failed.',
    };
    const current = source.verificationReceipts[0]!;
    const { receiptHash: _receiptHash, ...receiptWithoutHash } = current;
    const conflictingReceipt = {
      ...receiptWithoutHash,
      id: 'receipt-2',
      assertionId: conflicting.id,
      assertionPayloadHash: conflicting.payloadHash,
      valueHash: conflicting.payloadHash,
    };
    const evaluation = source.evaluation!;
    const projected = projectAndAssertReviewPackageV2({
      ...source,
      assertions: [...source.assertions, conflicting],
      verificationReceipts: [
        ...source.verificationReceipts,
        {
          ...conflictingReceipt,
          receiptHash: computeVerificationReceiptHash(conflictingReceipt),
        },
      ],
      evaluation: {
        ...evaluation,
        criterionPremises: [
          { key: 'criterion-1', assertionIds: ['assertion-1', 'assertion-2'] },
        ],
        outcomeAssertionIds: ['assertion-1', 'assertion-2'],
      },
    });

    expect(projected.outcome.status).toBe('need_more_evidence');
    expect(projected.assertions.map((assertion) => assertion.reasonCodes)).toEqual([
      ['structured_contradiction'],
      ['structured_contradiction'],
    ]);
    expect(projected.validDecisions).toEqual([]);
  });

  it('rejects unknown human-decision authority fields before they can affect outcome', () => {
    const source = withOutcomeDecision(buildSource(), 'approve_outcome');
    const injected = {
      ...source.humanDecisions[0]!,
      administratorOverride: true,
    };

    expect(() =>
      projectAndAssertReviewPackageV2({
        ...source,
        humanDecisions: [injected] as unknown as ReviewPackageV2Source['humanDecisions'],
      }),
    ).toThrow('exact closed schema');
  });

  it('rejects receipts targeting advisory assertions before projection', () => {
    const source = buildSource();
    const advisory: DecisionAssertion = {
      id: 'inference-1',
      subjectKey: 'risk.maybe',
      kind: 'inference',
      canonicalPayload: { possible: true },
      payloadHash: computeAssertionPayloadHash({ possible: true }),
      advisoryText: 'May require follow-up.',
    };
    const current = source.verificationReceipts[0]!;
    const { receiptHash: _receiptHash, ...withoutHash } = current;
    const target = {
      ...withoutHash,
      id: 'receipt-advisory',
      assertionId: advisory.id,
      assertionPayloadHash: advisory.payloadHash,
      subjectKey: advisory.subjectKey,
      valueHash: advisory.payloadHash,
    };

    expect(() =>
      projectAndAssertReviewPackageV2({
        ...source,
        assertions: [...source.assertions, advisory],
        verificationReceipts: [
          ...source.verificationReceipts,
          { ...target, receiptHash: computeVerificationReceiptHash(target) },
        ],
      }),
    ).toThrow('factual assertion');
  });

  it('rejects a forged closed DTO even when its projection hash is recomputed', () => {
    const projected = projectAndAssertReviewPackageV2(buildSource());
    const { projectionHash: _projectionHash, ...withoutHash } = projected;
    const forged = rehashPackage({
      ...withoutHash,
      callerApproved: true,
    } as unknown as Omit<ReviewPackageV2, 'projectionHash'>);

    expect(() => assertReviewPackageV2StructuralConsistency(forged)).toThrow(ReviewPackageV2Error);
  });

  it('rejects forged public references and lifecycle fields with recomputed hashes', () => {
    const projected = projectAndAssertReviewPackageV2(buildSource());
    const { projectionHash: _projectionHash, ...withoutHash } = projected;
    const unknownAxisReference = rehashPackage({
      ...withoutHash,
      trustAxes: {
        ...withoutHash.trustAxes,
        mechanical: {
          ...withoutHash.trustAxes.mechanical,
          assertionIds: ['unknown-assertion'],
        },
      },
    });
    const invalidIteration = rehashPackage({
      ...withoutHash,
      iterations: withoutHash.iterations.map((iteration) => ({
        ...iteration,
        state: 'invented-state',
      })) as unknown as ReviewPackageV2['iterations'],
    });

    for (const forged of [unknownAxisReference, invalidIteration]) {
      expect(() => assertReviewPackageV2StructuralConsistency(forged)).toThrow(ReviewPackageV2Error);
    }
  });

  it('allows unreferenced artifacts without a manifest and excludes them publicly', () => {
    const source = buildSource();
    const binding = {
      ...source.currentBinding,
      candidateRef: null,
      evidenceManifestHash: null,
    };
    const iteration = {
      ...source.currentIteration,
      state: 'planned' as const,
      candidateRef: null,
      evidenceManifestId: null,
    };
    const attestationWithoutHash = {
      schema: 'hercules-evidence-integrity-attestation/v1' as const,
      result: 'missing' as const,
      evidenceManifestId: null,
      evidenceManifestHash: null,
      candidateRef: null,
      checkedArtifacts: [],
      verifierImplementation: 'integrity-v1',
      checkedAt: '2026-08-29T00:00:05.000Z',
    };
    const result = projectAndAssertReviewPackageV2({
      ...source,
      currentBinding: binding,
      currentIteration: iteration,
      iterationHistory: [iteration],
      evidenceManifest: null,
      evidenceIntegrity: {
        ...attestationWithoutHash,
        attestationHash:
          computeEvidenceIntegrityAttestationHash(attestationWithoutHash),
      },
    });

    expect(result.outcome.status).toBe('need_more_evidence');
    expect(result.evidence).toEqual([]);
    expect(result.binding.candidateRef).toBeNull();
  });

  it('rejects malformed nested evaluation shape even when the evaluation is stale', () => {
    const source = buildSource();
    const evaluation = {
      ...source.evaluation!,
      verdict: {
        ...source.evaluation!.verdict,
        binding: {
          ...source.evaluation!.verdict.binding,
          evaluatorVersion: 'stale-evaluator',
        },
        injectedAuthority: true,
      },
    } as unknown as EvaluationDecisionRecordV2;

    expect(() => projectAndAssertReviewPackageV2({ ...source, evaluation })).toThrow(
      'exact closed schema',
    );
  });

  it('validates public usage and required decisions in the package error domain', () => {
    const unavailable = projectAndAssertReviewPackageV2({
      ...buildSource(),
      evaluation: null,
    });
    const { projectionHash: _projectionHash, ...withoutHash } = unavailable;
    const badUsage = rehashPackage({
      ...withoutHash,
      usage: { durationMs: -1, tokens: 0, costUsd: 0 },
    });
    const badDecision = rehashPackage({
      ...withoutHash,
      requiredDecision: {
        kinds: ['approve_outcome'],
        policyDecisionIds: [],
        reasonCodes: ['human_decision_required'],
      },
    });
    const pass = projectAndAssertReviewPackageV2(buildSource());
    const { projectionHash: _passHash, ...passWithoutHash } = pass;
    const badPassActions = rehashPackage({
      ...passWithoutHash,
      validDecisions: [
        'approve_outcome',
        'reject_outcome',
        'request_changes',
      ],
    });
    const pending = projectAndAssertReviewPackageV2(
      withHumanCriterion(buildSource(), 'pending', 'escalate_human'),
    );
    const { projectionHash: _pendingHash, ...pendingWithoutHash } = pending;
    const badPendingActions = rehashPackage({
      ...pendingWithoutHash,
      validDecisions: ['request_changes'],
    });
    const source = buildSource();
    const evaluation = source.evaluation!;
    const failed = projectAndAssertReviewPackageV2({
      ...source,
      evaluation: {
        ...evaluation,
        verdict: {
          ...evaluation.verdict,
          outcome: 'fail',
          recommendedNextStage: 'repair',
          criterionResults: evaluation.verdict.criterionResults.map((result) => ({
            ...result,
            status: 'fail' as const,
          })),
        },
      },
    });
    const { projectionHash: _failedHash, ...failedWithoutHash } = failed;
    const badFailedActions = rehashPackage({
      ...failedWithoutHash,
      validDecisions: [
        'approve_outcome',
        'reject_outcome',
        'request_changes',
      ],
    });
    const missing = projectAndAssertReviewPackageV2({
      ...buildSource(),
      evaluation: null,
    });
    const { projectionHash: _missingHash, ...missingWithoutHash } = missing;
    const forgedMissingFailure = rehashPackage({
      ...missingWithoutHash,
      outcome: {
        ...missing.outcome,
        status: 'fail',
        decisionEligible: true,
        advisorySummary: 'fail',
      },
      validDecisions: ['request_changes'],
      decisionBinding: buildSource().currentBinding,
    });
    const forgedHumanPending = rehashPackage({
      ...passWithoutHash,
      outcome: {
        ...pass.outcome,
        status: 'needs_human',
        reasonCodes: ['human_decision_required'],
        advisorySummary: 'needs_human',
      },
      requiredDecision: {
        kinds: ['approve_outcome', 'reject_outcome', 'request_changes'],
        policyDecisionIds: [],
        reasonCodes: ['human_decision_required'],
      },
      validDecisions: [
        'approve_outcome',
        'reject_outcome',
        'request_changes',
      ],
    });
    const forgedPassEvaluatorFailure = rehashPackage({
      ...passWithoutHash,
      outcome: {
        ...pass.outcome,
        evaluatorOutcome: 'fail',
      },
    });
    const forgedPendingEvaluatorFailure = rehashPackage({
      ...pendingWithoutHash,
      outcome: {
        ...pending.outcome,
        evaluatorOutcome: 'fail',
      },
    });
    const forgedCriterionFailure = rehashPackage({
      ...passWithoutHash,
      outcome: {
        ...pass.outcome,
        status: 'fail',
        reasonCodes: ['criterion_failed'],
        advisorySummary: 'fail',
      },
    });
    const forgedBlockingFailure = rehashPackage({
      ...passWithoutHash,
      outcome: {
        ...pass.outcome,
        status: 'fail',
        reasonCodes: ['blocking_finding'],
        advisorySummary: 'fail',
      },
    });
    const forgedHumanFailure = rehashPackage({
      ...passWithoutHash,
      outcome: {
        ...pass.outcome,
        status: 'fail',
        reasonCodes: ['human_rejected'],
        advisorySummary: 'fail',
      },
    });
    const invalidCandidate = {
      ...candidate,
      revision: 'NOT-A-LOWERCASE-40-HEX-SHA',
    };
    const invalidShaBinding = {
      ...pass.binding,
      candidateRef: invalidCandidate,
    };
    const invalidShaDecisionBinding = {
      ...pass.decisionBinding!,
      candidateRef: invalidCandidate,
    };
    const forgedInvalidSha = rehashPackage({
      ...passWithoutHash,
      binding: invalidShaBinding,
      decisionBinding: invalidShaDecisionBinding,
      iterations: pass.iterations.map((iteration, index) =>
        index === pass.iterations.length - 1
          ? { ...iteration, candidateRef: invalidCandidate }
          : iteration,
      ),
    });

    for (const value of [
      badUsage,
      badDecision,
      badPassActions,
      badPendingActions,
      badFailedActions,
      forgedMissingFailure,
      forgedHumanPending,
      forgedPassEvaluatorFailure,
      forgedPendingEvaluatorFailure,
      forgedCriterionFailure,
      forgedBlockingFailure,
      forgedHumanFailure,
      forgedInvalidSha,
    ]) {
      try {
        assertReviewPackageV2StructuralConsistency(value);
        throw new Error('expected package validation to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewPackageV2Error);
        expect((error as ReviewPackageV2Error).code).toBe('invalid_package');
      }
    }
  });
});
