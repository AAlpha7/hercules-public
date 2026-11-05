import { hashCanonicalJson } from '../../src/domain/canonicalJson.js';
import { createHash } from 'node:crypto';
import { computeTaskContractHash } from '../../src/domain/contractHash.js';
import {
  computeAssertionPayloadHash,
  computeEvidenceIntegrityAttestationHash,
  computeVerificationReceiptHash,
  type AssertionVerificationReceipt,
  type DecisionAssertion,
  type EvidenceIntegrityAttestation,
} from '../../src/domain/claimAuthorityV2.js';
import type {
  EvaluationDecisionRecordV2,
  ReviewPackageV2Source,
} from '../../src/domain/reviewPackageV2.js';
import type { ArtifactRef, EvidenceManifest } from '../../src/domain/artifact.js';
import type { EvaluationBinding, EvaluationVerdict } from '../../src/domain/evaluationVerdict.js';
import type { Iteration } from '../../src/domain/iteration.js';
import type { TaskContract } from '../../src/domain/taskContract.js';

export function reviewPackageV2SourceFixture(
  overrides: Readonly<{
    taskId?: string;
    projectedAt?: string;
    redactionState?: 'none' | 'redacted' | 'restricted';
    artifactBytes?: Uint8Array;
    requiresHumanDecision?: boolean;
    remainingRiskCode?: string;
  }> = {},
): ReviewPackageV2Source {
  const taskId = overrides.taskId ?? 'task-1';
  const candidate = {
    kind: 'git' as const,
    repository: 'example-org/acme',
    revision: '0123456789abcdef0123456789abcdef01234567',
  };
  const contractWithoutHash = {
    taskId,
    version: 1,
    contractHash: '',
    objective: 'Verify the exact candidate.',
    context: [],
    acceptanceCriteria: [{
      id: 'criterion-1',
      text: 'The unit gate passes.',
      authority: 'mechanical' as const,
      required: true,
      proofBinding: null,
    }],
    constraints: [],
    forbiddenActions: [],
    capabilityPolicy: { version: 'capability-v1', grants: [] },
    verificationPolicy: {
      version: 'verification-v1',
      requiredEvidence: ['pnpm-test'],
      independentEvaluatorRequired: true,
    },
    approvalPolicy: {
      version: 'approval-v1',
      requiredDecisions: overrides.requiresHumanDecision ? ['approve_outcome'] : [],
    },
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
  const artifactBytes = overrides.artifactBytes ?? REVIEW_EVIDENCE_FIXTURE_BYTES;
  const artifact: ArtifactRef = {
    id: 'artifact-1',
    sha256: `sha256:${createHash('sha256').update(artifactBytes).digest('hex')}`,
    mediaType: 'application/json',
    byteLength: artifactBytes.byteLength,
    storageKey: 'artifacts/artifact-1',
    producerStageRunId: 'verifier-1',
    createdAt: '2026-08-29T00:00:01.000Z',
    trustClass: 'primary',
    redactionState: overrides.redactionState ?? 'none',
  };
  const manifestWithoutHash = {
    id: 'manifest-1',
    taskId,
    contractVersion: 1,
    iterationId: 'iteration-1',
    candidateRef: candidate,
    entries: [{
      artifactRefId: artifact.id,
      criterionIds: ['criterion-1'],
      candidateRef: candidate,
      observedAt: '2026-08-29T00:00:02.000Z',
      environmentRef: 'test',
      surface: 'pnpm-test',
      trustClass: 'primary' as const,
    }],
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
    candidateRef: candidate,
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
    taskId,
    contractVersion: 1,
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
  const criterionResult: EvaluationVerdict['criterionResults'][number] = {
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
    criterionResults: [criterionResult],
    blockingFindings: [],
    nonBlockingRisks: overrides.remainingRiskCode === undefined ? [] : [{
      code: overrides.remainingRiskCode,
      summary: 'A remaining verified risk.',
      criterionIds: ['criterion-1'],
    }],
    recommendedNextStage: 'complete',
    evaluatorAgentRunId: 'evaluator-1',
    createdAt: '2026-08-29T00:00:06.000Z',
  };
  const evaluation: EvaluationDecisionRecordV2 = {
    schema: 'hercules-evaluation-decision/v2',
    verdict,
    criterionPremises: [{ key: 'criterion-1', assertionIds: [assertion.id] }],
    findingPremises: overrides.remainingRiskCode === undefined ? [] : [{
      key: overrides.remainingRiskCode,
      assertionIds: [assertion.id],
    }],
    outcomeAssertionIds: [assertion.id],
    nextStageAssertionIds: [assertion.id],
  };
  return {
    task: { id: taskId, title: 'Task 1', state: 'review' },
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
    projectedAt: overrides.projectedAt ?? '2026-08-29T00:00:07.000Z',
  };
}

export const REVIEW_EVIDENCE_FIXTURE_BYTES = new TextEncoder().encode('{"passed":true}');
export const REVIEW_EVIDENCE_FIXTURE_DIGEST =
  `sha256:${createHash('sha256').update(REVIEW_EVIDENCE_FIXTURE_BYTES).digest('hex')}`;
