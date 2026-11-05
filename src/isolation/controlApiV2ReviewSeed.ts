/**
 * Isolation-local deterministic ReviewPackageV2 fixtures for the Control API V2
 * fake provider. Never imports test/ or src/control/state/*.
 */

import { createHash } from 'node:crypto';
import { hashCanonicalJson } from '../domain/canonicalJson.js';
import {
  computeAssertionPayloadHash,
  computeEvidenceIntegrityAttestationHash,
  computeVerificationReceiptHash,
  type AssertionVerificationReceipt,
  type DecisionAssertion,
  type EvidenceIntegrityAttestation,
} from '../domain/claimAuthorityV2.js';
import { computeTaskContractHash } from '../domain/contractHash.js';
import type { ArtifactRef, EvidenceManifest } from '../domain/artifact.js';
import type { EvaluationBinding, EvaluationVerdict } from '../domain/evaluationVerdict.js';
import type { Iteration } from '../domain/iteration.js';
import type { TaskContract } from '../domain/taskContract.js';
import {
  projectAndAssertReviewPackageV2,
  type EvaluationDecisionRecordV2,
  type ReviewPackageV2,
  type ReviewPackageV2Source,
} from '../domain/reviewPackageV2.js';

export const CONTROL_API_V2_ELIGIBLE_SEED_TASK_ID = 'ctrl-v2-eligible';
export const CONTROL_API_V2_INELIGIBLE_SEED_TASK_ID = 'ctrl-v2-ineligible';

const EVIDENCE_BYTES = new TextEncoder().encode('{"passed":true}');
const CANDIDATE = {
  kind: 'git' as const,
  repository: 'example-org/acme',
  revision: '0123456789abcdef0123456789abcdef01234567',
};

function buildBaseSource(taskId: string): ReviewPackageV2Source {
  const contractWithoutHash = {
    taskId,
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
    approvalPolicy: { version: 'approval-v1', requiredDecisions: ['approve_outcome'] },
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
    sha256: `sha256:${createHash('sha256').update(EVIDENCE_BYTES).digest('hex')}`,
    mediaType: 'application/json',
    byteLength: EVIDENCE_BYTES.byteLength,
    storageKey: 'artifacts/artifact-1',
    producerStageRunId: 'verifier-1',
    createdAt: '2026-08-29T00:00:01.000Z',
    trustClass: 'primary',
    redactionState: 'none',
  };
  const manifestWithoutHash = {
    id: 'manifest-1',
    taskId,
    contractVersion: 1,
    iterationId: 'iteration-1',
    candidateRef: CANDIDATE,
    entries: [
      {
        artifactRefId: artifact.id,
        criterionIds: ['criterion-1'],
        candidateRef: CANDIDATE,
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
    taskId,
    contractVersion: 1,
    contractHash: contract.contractHash,
    iterationId: 'iteration-1',
    candidateRef: CANDIDATE,
    evidenceManifestHash: manifest.manifestHash,
    evaluatorVersion: 'evaluator-v1',
    evaluatorModel: 'model-v1',
    evaluatorRuntime: 'runtime-v1',
    policyVersion: 'policy-v1',
  };
  const iteration: Iteration = {
    id: 'iteration-1',
    taskId,
    contractVersion: 1,
    ordinal: 1,
    state: 'evaluating',
    candidateRef: CANDIDATE,
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
    taskId,
    contractVersion: 1,
    contractHash: contract.contractHash,
    iterationId: iteration.id,
    candidateRef: CANDIDATE,
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
    candidateRef: CANDIDATE,
    checkedArtifacts: [{ artifactRefId: artifact.id, sha256: artifact.sha256 }],
    verifierImplementation: 'integrity-v1',
    checkedAt: '2026-08-29T00:00:05.000Z',
  };
  const evidenceIntegrity: EvidenceIntegrityAttestation = {
    ...attestationWithoutHash,
    attestationHash: computeEvidenceIntegrityAttestationHash(attestationWithoutHash),
  };
  const criterionResult: EvaluationVerdict['criterionResults'][number] = {
    criterionId: 'criterion-1',
    status: 'pass',
    authority: 'mechanical',
    evidenceRefs: [artifact.id],
    observedAt: '2026-08-29T00:00:02.000Z',
    candidateBinding: JSON.stringify([
      CANDIDATE.kind,
      CANDIDATE.repository,
      CANDIDATE.revision,
    ]),
    explanation: 'gate passed',
  };
  const verdict: EvaluationVerdict = {
    id: 'verdict-1',
    binding,
    outcome: 'pass',
    criterionResults: [criterionResult],
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
    task: { id: taskId, title: 'Control API V2 seed task', state: 'review' },
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

/** Deterministic source that projects to a decision-eligible ReviewPackageV2. */
export function buildEligibleControlApiV2ReviewSource(
  taskId: string = CONTROL_API_V2_ELIGIBLE_SEED_TASK_ID,
): ReviewPackageV2Source {
  return buildBaseSource(taskId);
}

/**
 * Deterministic source that projects to an ineligible ReviewPackageV2
 * (`decisionBinding === null`) via a self-report receipt (untrusted verifier).
 */
export function buildIneligibleControlApiV2ReviewSource(
  taskId: string = CONTROL_API_V2_INELIGIBLE_SEED_TASK_ID,
): ReviewPackageV2Source {
  const source = buildBaseSource(taskId);
  const current = source.verificationReceipts[0];
  if (current === undefined) {
    throw new TypeError('control api v2 review seed must carry a verification receipt');
  }
  const { receiptHash: _receiptHash, ...withoutHash } = current;
  const next = { ...withoutHash, verifierRunId: 'untrusted-agent' };
  return {
    ...source,
    verificationReceipts: [
      { ...next, receiptHash: computeVerificationReceiptHash(next) },
    ],
  };
}

export function buildEligibleControlApiV2ReviewPackage(
  taskId: string = CONTROL_API_V2_ELIGIBLE_SEED_TASK_ID,
): ReviewPackageV2 {
  return projectAndAssertReviewPackageV2(buildEligibleControlApiV2ReviewSource(taskId));
}

export function buildIneligibleControlApiV2ReviewPackage(
  taskId: string = CONTROL_API_V2_INELIGIBLE_SEED_TASK_ID,
): ReviewPackageV2 {
  return projectAndAssertReviewPackageV2(buildIneligibleControlApiV2ReviewSource(taskId));
}

/** Isolation-local projection seam — keep projectAndAssertReviewPackageV2 behind this module. */
export function projectControlApiV2ReviewSource(
  source: ReviewPackageV2Source,
): ReviewPackageV2 {
  return projectAndAssertReviewPackageV2(source);
}
