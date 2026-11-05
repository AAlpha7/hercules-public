/**
 * M8 receipt construction for the M12 proof harness.
 *
 * Driving `createIndependentEvaluationCoordinator` end-to-end requires porting
 * ~1k lines of test-local subject/caps builders and aligning them with the M6
 * spine. Slice 2 therefore builds valid `IndependentEvaluationReceiptV1`
 * records via the real `computeEvaluationReceiptHash` /
 * `assertIndependentEvaluationReceiptV1` / `computeVerdictHash` /
 * `computeCriterionRelationshipHash` — spine fields (taskId, contractHash,
 * iterationId, candidateCommit, manifestId/Hash) are pinned to the shared
 * spine; all own-hashes are recomputed.
 */

import type { EvidenceManifest } from '../domain/artifact.js';
import type { EvaluationVerdict } from '../domain/evaluationVerdict.js';
import {
  assertIndependentEvaluationReceiptV1,
  computeCriterionRelationshipHash,
  computeEvaluationReceiptHash,
  computeVerdictHash,
  type EvaluationCriterionRelationshipV1,
  type IndependentEvaluationReceiptV1,
} from '../domain/independentEvaluation.js';
import type { TaskContract } from '../domain/taskContract.js';
import { PROOF_CANDIDATE_COMMIT, ProofHarnessError } from './spine.js';

/** Deterministic placeholder digest — format-valid only; never a recomputed field. */
function placeholderHash(seed: number): string {
  return `sha256:${seed.toString(16).padStart(64, '0')}`;
}

export interface EvaluationReceiptSeed {
  readonly contract: TaskContract;
  readonly evidenceManifest: EvidenceManifest;
  readonly requestId: string;
  readonly receiptId: string;
  readonly iterationId: string;
  readonly outcome: 'pass' | 'fail';
  readonly createdAt?: string;
}

function candidateBindingString(
  candidate: EvidenceManifest['candidateRef'],
): string {
  if (candidate.kind === 'git') {
    return JSON.stringify([
      candidate.kind,
      candidate.repository,
      candidate.revision,
    ]);
  }
  if (candidate.kind === 'artifact') {
    return JSON.stringify([
      candidate.kind,
      candidate.artifactId,
      candidate.sha256,
    ]);
  }
  return JSON.stringify([
    candidate.kind,
    candidate.system,
    candidate.version,
    candidate.digest,
  ]);
}

function buildVerdict(seed: EvaluationReceiptSeed): EvaluationVerdict {
  const candidate = seed.evidenceManifest.candidateRef;
  const status = seed.outcome === 'pass' ? 'pass' : 'fail';
  const nextStage = seed.outcome === 'pass' ? 'complete' : 'repair';
  return {
    id: `verdict-${seed.receiptId}`,
    binding: {
      taskId: seed.contract.taskId,
      contractVersion: seed.contract.version,
      contractHash: seed.contract.contractHash,
      iterationId: seed.iterationId,
      candidateRef: candidate,
      evidenceManifestHash: seed.evidenceManifest.manifestHash,
      evaluatorVersion: 'evaluator-v1',
      evaluatorModel: null,
      evaluatorRuntime: 'runtime-v1',
      policyVersion: 'policy-v1',
    },
    outcome: seed.outcome,
    criterionResults: [
      {
        criterionId: 'criterion-1',
        status,
        authority: 'mechanical',
        evidenceRefs: ['artifact-1'],
        observedAt: '2026-08-29T00:00:02.000Z',
        candidateBinding: candidateBindingString(candidate),
        explanation:
          seed.outcome === 'pass' ? 'gate passed' : 'required criterion failed',
      },
    ],
    blockingFindings:
      seed.outcome === 'fail'
        ? [
            {
              code: 'required_criterion_failed',
              summary: 'criterion-1 failed',
              criterionIds: ['criterion-1'],
            },
          ]
        : [],
    nonBlockingRisks: [],
    recommendedNextStage: nextStage,
    evaluatorAgentRunId: 'evaluator-1',
    createdAt: seed.createdAt ?? '2026-08-29T00:00:06.000Z',
  };
}

function buildRelationship(
  criterionId: string,
): EvaluationCriterionRelationshipV1 {
  const withoutHash = {
    criterionId,
    assertionIds: ['assertion-1'],
    evidenceArtifactIds: ['artifact-1'],
    verificationReceiptIds: ['receipt-1'],
  };
  return {
    ...withoutHash,
    relationshipHash: computeCriterionRelationshipHash(withoutHash),
  };
}

/**
 * Build a structurally valid M8 receipt bound to the spine contract + manifest.
 * Own-hashes (`verdictHash`, `receiptHash`, relationship hashes) are recomputed.
 */
export function buildEvaluationReceipt(
  seed: EvaluationReceiptSeed,
): IndependentEvaluationReceiptV1 {
  if (seed.evidenceManifest.taskId !== seed.contract.taskId) {
    throw new ProofHarnessError(
      'evaluation receipt seed manifest taskId must match contract.taskId',
    );
  }
  if (seed.contract.contractHash === '') {
    throw new ProofHarnessError(
      'evaluation receipt seed contract must carry a computed contractHash',
    );
  }

  const verdict = buildVerdict(seed);
  const outcomeReasonCodes =
    seed.outcome === 'pass'
      ? ['all_required_criteria_pass']
      : ['required_criterion_failed'];

  const withoutHash: Omit<IndependentEvaluationReceiptV1, 'receiptHash'> = {
    schema: 'hercules-independent-evaluation-receipt/v1',
    receiptId: seed.receiptId,
    requestId: seed.requestId,
    inputHash: placeholderHash(11),
    taskId: seed.contract.taskId,
    taskContractHash: seed.contract.contractHash,
    iterationId: seed.iterationId,
    candidateCommit: PROOF_CANDIDATE_COMMIT,
    manifestId: seed.evidenceManifest.id,
    manifestHash: seed.evidenceManifest.manifestHash,
    artifactInventoryHash: placeholderHash(12),
    verificationResultHash: placeholderHash(13),
    verificationReceiptSetHash: placeholderHash(14),
    integrityAttestationHash: placeholderHash(15),
    assertionSetHash: placeholderHash(16),
    gatePlanHash: placeholderHash(17),
    gateReceiptSetHash: placeholderHash(18),
    policyHash: placeholderHash(19),
    rubricHash: placeholderHash(20),
    roleAuthorityHash: placeholderHash(21),
    controlIdentityHash: placeholderHash(22),
    evidenceSourceId: 'evidence-source-1',
    evidenceIdentityHash: placeholderHash(23),
    authorityEpoch: 'epoch-1',
    coordinatorRunId: 'coordinator-1',
    evaluatorRunId: 'evaluator-1',
    evaluatorImplementationId: 'evaluator-impl-1',
    acceptedContextHash: placeholderHash(24),
    postEvaluationContextHash: placeholderHash(25),
    stableContextHash: placeholderHash(26),
    acceptedObservedAt: '2026-08-29T00:00:06.000Z',
    postEvaluationObservedAt: '2026-08-29T00:00:07.000Z',
    freshUntil: '2026-08-29T01:00:00.000Z',
    preflightHash: placeholderHash(27),
    proposalHash: null,
    noProposalReason:
      seed.outcome === 'pass' ? 'deterministic_pass' : 'deterministic_fail',
    cancellationDispatches: [],
    verdict,
    verdictHash: computeVerdictHash(verdict),
    criterionRelationships: [buildRelationship('criterion-1')],
    outcomeReasonCodes,
    createdAt: seed.createdAt ?? '2026-08-29T00:00:08.000Z',
  };

  const receipt: IndependentEvaluationReceiptV1 = {
    ...withoutHash,
    receiptHash: computeEvaluationReceiptHash(withoutHash),
  };
  assertIndependentEvaluationReceiptV1(receipt);
  return receipt;
}
