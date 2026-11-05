import { candidateRefsEqual } from '../domain/artifact.js';
import { computeEvidenceIntegrityAttestationHash } from '../domain/claimAuthorityV2.js';
import type { V2UnprojectableReason } from '../domain/controlEvent.js';
import {
  UNEVALUATED_EVALUATOR_MODEL,
  UNEVALUATED_EVALUATOR_RUNTIME,
  UNEVALUATED_EVALUATOR_VERSION,
} from '../domain/evaluatorSentinels.js';
import {
  projectAndAssertReviewPackageV2,
  ReviewPackageV2Error,
  type ReviewPackageV2,
  type ReviewPackageV2Source,
} from '../domain/reviewPackageV2.js';
import type { AuthorityRoster } from './authorityRoster.js';
import type {
  ReviewPackageRefreshInput,
  ReviewPackageRefreshResult,
  ReviewPackageRefreshSeam,
} from './state/stateStore.js';

export type { AuthorityRoster };

export const REVIEW_PACKAGE_SOURCE_VERIFIER = 'hercules-control/reviewPackageSource/v1' as const;

export type ReviewPackageSourceAssembly =
  | { readonly kind: 'source'; readonly source: ReviewPackageV2Source }
  | { readonly kind: 'unprojectable'; readonly reason: V2UnprojectableReason; readonly detail: string };

type ReviewPackageProjector = (source: ReviewPackageV2Source) => ReviewPackageV2;

export interface ReviewPackageRefreshSeamOptions {
  readonly projector?: ReviewPackageProjector;
  readonly roster?: AuthorityRoster;
}

/** Pure: builds the source per the §C2.3/C3.0 truth map, or names why no honest source exists. Never throws on task data. */
export function assembleReviewPackageSource(
  input: ReviewPackageRefreshInput,
  projectedAt: string,
  roster?: AuthorityRoster,
): ReviewPackageSourceAssembly {
  const storedHistory = input.shadow.iterations;
  if (storedHistory.length === 0) {
    return {
      kind: 'unprojectable',
      reason: 'empty_iteration_history',
      detail: `task ${input.shadow.taskId} has no reconstructible iteration history`,
    };
  }
  const storedIteration = storedHistory[storedHistory.length - 1]!;
  const contract = input.shadow.contracts.find(
    (entry) => entry.version === storedIteration.contractVersion,
  );
  if (contract === undefined) {
    return {
      kind: 'unprojectable',
      reason: 'missing_contract',
      detail:
        `task ${input.shadow.taskId} current iteration binds contract version ` +
        `${storedIteration.contractVersion}, which is absent from shadow contracts`,
    };
  }

  const boundEvidence =
    input.evidence !== null && input.evidence.iterationId === storedIteration.id
      ? input.evidence
      : null;
  const boundEvaluation =
    boundEvidence !== null &&
    input.evaluation !== null &&
    input.evaluation.iterationId === storedIteration.id &&
    input.evaluation.evidenceHash === boundEvidence.evidenceHash
      ? input.evaluation
      : null;

  const currentIteration = boundEvidence === null
    ? storedIteration
    : { ...storedIteration, evidenceManifestId: boundEvidence.evidenceManifest.id };
  // Projector requires currentIteration === history tip; overlay the tip only.
  const iterationHistory = boundEvidence === null
    ? storedHistory
    : [...storedHistory.slice(0, -1), currentIteration];

  if (boundEvaluation !== null && boundEvidence !== null) {
    const verdictBinding = boundEvaluation.evaluation.verdict.binding;
    const evaluator = boundEvaluation.evaluator;
    if (
      verdictBinding.taskId !== input.shadow.taskId ||
      verdictBinding.contractVersion !== contract.version ||
      verdictBinding.contractHash !== contract.contractHash ||
      verdictBinding.iterationId !== currentIteration.id ||
      !candidateRefsEqual(verdictBinding.candidateRef, boundEvidence.candidateRef) ||
      verdictBinding.evidenceManifestHash !== boundEvidence.evidenceManifest.manifestHash ||
      verdictBinding.evaluatorVersion !== evaluator.version ||
      verdictBinding.evaluatorModel !== evaluator.model ||
      verdictBinding.evaluatorRuntime !== evaluator.runtime
    ) {
      return {
        kind: 'unprojectable',
        reason: 'invalid_source',
        detail:
          `task ${input.shadow.taskId} evaluation.verdict.binding disagrees with ` +
          'shadow/evidence/evaluator identity',
      };
    }
  }

  const degradedAttestationWithoutHash = {
    schema: 'hercules-evidence-integrity-attestation/v1' as const,
    result: 'unavailable' as const,
    evidenceManifestId: null,
    evidenceManifestHash: null,
    candidateRef: null,
    checkedArtifacts: [] as const,
    verifierImplementation: REVIEW_PACKAGE_SOURCE_VERIFIER,
    checkedAt: projectedAt,
  };
  const degradedIntegrity = {
    ...degradedAttestationWithoutHash,
    attestationHash: computeEvidenceIntegrityAttestationHash(degradedAttestationWithoutHash),
  };

  const evaluationApplied = boundEvaluation !== null;
  // When an engine evaluation is bound, currentBinding must deep-equal
  // evaluation.verdict.binding (M6 stale check). Adopt only after the
  // cross-checks above; the M8 coordinator writes policyVersion from the
  // evaluation-policy version, not approvalPolicy.version.
  const currentBinding = evaluationApplied
    ? boundEvaluation.evaluation.verdict.binding
    : {
        taskId: input.shadow.taskId,
        contractVersion: contract.version,
        contractHash: contract.contractHash,
        iterationId: currentIteration.id,
        candidateRef: boundEvidence === null
          ? currentIteration.candidateRef
          : boundEvidence.candidateRef,
        evidenceManifestHash: boundEvidence === null
          ? null
          : boundEvidence.evidenceManifest.manifestHash,
        evaluatorVersion: UNEVALUATED_EVALUATOR_VERSION,
        evaluatorModel: UNEVALUATED_EVALUATOR_MODEL,
        evaluatorRuntime: UNEVALUATED_EVALUATOR_RUNTIME,
        policyVersion: contract.approvalPolicy.version,
      };
  const source: ReviewPackageV2Source = {
    task: {
      id: input.shadow.taskId,
      title: contract.objective,
      state: input.taskStatus,
    },
    currentBinding,
    contract,
    currentIteration,
    iterationHistory,
    evidenceManifest: boundEvidence === null ? null : boundEvidence.evidenceManifest,
    artifacts: boundEvidence === null ? [] : boundEvidence.artifacts,
    evidenceIntegrity: boundEvidence === null ? degradedIntegrity : boundEvidence.evidenceIntegrity,
    assertions: boundEvidence === null ? [] : boundEvidence.assertions,
    verificationReceipts: boundEvidence === null ? [] : boundEvidence.verificationReceipts,
    evaluation: evaluationApplied ? boundEvaluation.evaluation : null,
    humanDecisions: input.humanDecisions,
    authorityContext: {
      trustedVerifierRunIds: roster === undefined ? [] : [roster.verifier.runId],
      implementerRunIds: [],
      reviewerRunIds: [],
      // Deterministic M8 receipts leave verdict.evaluatorAgentRunId null; mirror that
      // so assertEvaluationVerdictBinding / assertClaimAuthorityContext stay consistent.
      // Item 10 asked for roster-declared evaluatorRunIds even when nested is null;
      // claimAuthorityV2 forbids that pairing, so C3.3 behaviour is retained.
      evaluatorRunIds:
        evaluationApplied && boundEvaluation.receipt.verdict.evaluatorAgentRunId !== null
          ? [boundEvaluation.evaluator.runId]
          : [],
      agentClaimProducerRunIds: [],
      evaluationAuthority: {
        evaluatorAgentRunId: evaluationApplied
          ? boundEvaluation.receipt.verdict.evaluatorAgentRunId
          : null,
        implementerAgentRunIds: [],
      },
    },
    usage: null,
    projectedAt,
  };
  return { kind: 'source', source };
}

/**
 * The seam the store calls. `clock` returns a canonical ISO timestamp
 * (Date#toISOString form). Optional `projector` defaults to the real domain
 * projector; tests may inject a stub to prove non-`ReviewPackageV2Error`
 * throws propagate (C2.3 acceptance (g)). Second argument may be a projector
 * (legacy positional) or `{ projector?, roster? }`.
 */
export function createReviewPackageRefreshSeam(
  clock: () => string,
  projectorOrOptions?: ReviewPackageProjector | ReviewPackageRefreshSeamOptions,
): ReviewPackageRefreshSeam {
  const options: ReviewPackageRefreshSeamOptions =
    typeof projectorOrOptions === 'function'
      ? { projector: projectorOrOptions }
      : (projectorOrOptions ?? {});
  const projector = options.projector ?? projectAndAssertReviewPackageV2;
  const roster = options.roster;
  return (input: ReviewPackageRefreshInput): ReviewPackageRefreshResult => {
    const assembled = assembleReviewPackageSource(input, clock(), roster);
    if (assembled.kind === 'unprojectable') {
      return { kind: 'unprojectable', reason: assembled.reason };
    }
    try {
      const reviewPackage = projector(assembled.source);
      return { kind: 'projected', reviewPackage };
    } catch (error) {
      if (error instanceof ReviewPackageV2Error) {
        if (error.code === 'invalid_source') {
          return { kind: 'unprojectable', reason: 'invalid_source' };
        }
        if (error.code === 'invalid_package') {
          return { kind: 'unprojectable', reason: 'invalid_package' };
        }
      }
      throw error;
    }
  };
}
