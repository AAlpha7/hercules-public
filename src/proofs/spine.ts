/**
 * Local M12 spine fixture — a self-contained ReviewPackageV2Source builder.
 *
 * Ports the minimal logic of `test/fixtures/reviewPackageV2Source.ts` so
 * `src/proofs/` never imports from `test/`. One TaskContract + one
 * EvidenceManifest + one artifact feed every engine in the chain.
 */

import { createHash } from 'node:crypto';

import type { ArtifactRef, EvidenceManifest } from '../domain/artifact.js';
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
import type {
  EvaluationBinding,
  EvaluationVerdict,
} from '../domain/evaluationVerdict.js';
import type { Iteration } from '../domain/iteration.js';
import type {
  EvaluationDecisionRecordV2,
  ReviewPackageV2Source,
} from '../domain/reviewPackageV2.js';
import type { TaskContract } from '../domain/taskContract.js';

export const PROOF_CANDIDATE_COMMIT =
  '0123456789abcdef0123456789abcdef01234567';

export const PROOF_EVIDENCE_BYTES = new TextEncoder().encode('{"passed":true}');
export const PROOF_EVIDENCE_DIGEST =
  `sha256:${createHash('sha256').update(PROOF_EVIDENCE_BYTES).digest('hex')}`;

// A genuine browser-surface evidence blob (a seeded DOM snapshot of a rendered
// user surface) — distinct in bytes, digest, media type, surface, and storage key
// from the generic code/non-code JSON artifact, so the browser lane binds a real
// browser artifact rather than a relabeled JSON one.
export const PROOF_BROWSER_EVIDENCE_BYTES = new TextEncoder().encode(
  '<!doctype html><html><body data-hercules-render="ok"><h1>Task complete</h1></body></html>',
);
export const PROOF_BROWSER_EVIDENCE_DIGEST =
  `sha256:${createHash('sha256').update(PROOF_BROWSER_EVIDENCE_BYTES).digest('hex')}`;
export const PROOF_BROWSER_SURFACE = 'browser-dom-snapshot';
export const PROOF_BROWSER_MEDIA_TYPE = 'text/html';

export class ProofHarnessError extends Error {
  override readonly name = 'ProofHarnessError';

  constructor(message: string) {
    super(message);
  }
}

export interface SpineSeed {
  readonly taskId: string;
  readonly iterationId: string;
  readonly requiresHumanDecision?: boolean;
  readonly projectedAt?: string;
  /**
   * When true, the single evidence artifact is a genuine browser-surface DOM
   * snapshot (distinct bytes/digest/mediaType/surface/storageKey) instead of the
   * generic code/non-code JSON artifact — so the browser archetype binds a real
   * browser artifact.
   */
  readonly browserEvidence?: boolean;
}

/**
 * Build a mutually-consistent ReviewPackageV2Source for one task/iteration.
 * Contract hash and manifest hash are recomputed — never pinned.
 */
export function buildReviewPackageSource(seed: SpineSeed): ReviewPackageV2Source {
  const taskId = seed.taskId;
  const iterationId = seed.iterationId;
  const isBrowser = seed.browserEvidence === true;
  const evidenceSurface = isBrowser ? PROOF_BROWSER_SURFACE : 'pnpm-test';
  const candidate = {
    kind: 'git' as const,
    repository: 'example-org/acme',
    revision: PROOF_CANDIDATE_COMMIT,
  };
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
    capabilityPolicy: { version: 'capability-v1' as const, grants: [] },
    verificationPolicy: {
      version: 'verification-v1' as const,
      requiredEvidence: [evidenceSurface],
      independentEvaluatorRequired: true,
    },
    approvalPolicy: {
      version: 'approval-v1' as const,
      requiredDecisions: seed.requiresHumanDecision ? ['approve_outcome'] : [],
    },
    budgetPolicy: {
      version: 'budget-v1' as const,
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
    sha256: isBrowser ? PROOF_BROWSER_EVIDENCE_DIGEST : PROOF_EVIDENCE_DIGEST,
    mediaType: isBrowser ? PROOF_BROWSER_MEDIA_TYPE : 'application/json',
    byteLength: isBrowser
      ? PROOF_BROWSER_EVIDENCE_BYTES.byteLength
      : PROOF_EVIDENCE_BYTES.byteLength,
    storageKey: isBrowser ? 'artifacts/browser-render-1' : 'artifacts/artifact-1',
    producerStageRunId: 'verifier-1',
    createdAt: '2026-08-29T00:00:01.000Z',
    trustClass: 'primary',
    redactionState: 'none',
  };
  const manifestWithoutHash = {
    id: 'manifest-1',
    taskId,
    contractVersion: 1,
    iterationId,
    candidateRef: candidate,
    entries: [
      {
        artifactRefId: artifact.id,
        criterionIds: ['criterion-1'],
        candidateRef: candidate,
        observedAt: '2026-08-29T00:00:02.000Z',
        environmentRef: 'test',
        surface: evidenceSurface,
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
    iterationId,
    candidateRef: candidate,
    evidenceManifestHash: manifest.manifestHash,
    evaluatorVersion: 'evaluator-v1',
    evaluatorModel: 'model-v1',
    evaluatorRuntime: 'runtime-v1',
    policyVersion: 'policy-v1',
  };
  const iteration: Iteration = {
    id: iterationId,
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
    iterationId,
    candidateRef: candidate,
    evidenceManifestId: manifest.id,
    evidenceManifestHash: manifest.manifestHash,
    evidenceEntryArtifactIds: [artifact.id],
    criterionIds: ['criterion-1'],
    verifierRunId: 'verifier-1',
    verifierImplementation: 'fixture-v1',
    observationSurface: evidenceSurface,
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
    task: { id: taskId, title: `Task ${taskId}`, state: 'review' },
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
    projectedAt: seed.projectedAt ?? '2026-08-29T00:00:07.000Z',
  };
}
