/**
 * M8 coordinator verdict derivation (pure).
 *
 * May import only from `src/domain/`. No Node builtins, no Buffer, no other
 * `src/` subtrees. Deterministic and total except caller-contract violations.
 */

import { candidateRefBinding } from '../domain/artifact.js';
import {
  assertEvaluationCriterionRelationshipV1,
  IndependentEvaluationError,
  computeCriterionRelationshipHash,
  type DeterministicPreflightResultV1,
  type EvaluationCriterionRelationshipV1,
  type EvaluatorFindingProposalV1,
  type EvaluatorProposalV1,
  type IndependentEvaluationInputV1,
  type TrustedEvaluationControlSnapshotV1,
  type TrustedEvaluationEvidenceSnapshotV1,
} from '../domain/independentEvaluation.js';
import {
  assertEvaluationVerdictBinding,
  type CriterionResult,
  type EvaluationAuthorityContext,
  type EvaluationBinding,
  type EvaluationVerdict,
  type Finding,
} from '../domain/evaluationVerdict.js';
import type { CriterionAuthority } from '../domain/taskContract.js';

const MAX_EXPLANATION_BYTES = 512;
const DETERMINISTIC_AUTHORITIES: ReadonlySet<CriterionAuthority> = new Set([
  'mechanical',
  'verifier',
]);

export interface VerdictDerivationArgsV1 {
  readonly input: IndependentEvaluationInputV1;
  readonly control: TrustedEvaluationControlSnapshotV1;
  readonly evidence: TrustedEvaluationEvidenceSnapshotV1;
  readonly preflight: DeterministicPreflightResultV1;
  readonly proposal: EvaluatorProposalV1 | null;
  readonly verdictId: string;
  readonly createdAt: string;
  readonly evaluatorVersion: string;
  readonly evaluatorModel: string | null;
  readonly evaluatorRuntime: string;
  /**
   * Legal only when classification is `model_judgment_required` and proposal is
   * null: model judgment was required but evaluator infrastructure failed.
   * Adds the code to outcomeReasonCodes and forces stage `reverify`.
   */
  readonly evaluatorInfrastructureFailure?: {
    readonly code: 'evaluator_unavailable' | 'evaluator_contract_violation';
    readonly detail: string;
  };
}

export interface VerdictDerivationV1 {
  readonly verdict: EvaluationVerdict;
  readonly outcomeReasonCodes: readonly string[];
  readonly criterionRelationships: readonly EvaluationCriterionRelationshipV1[];
}

function sortedUnique(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)].sort();
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) {
    return value;
  }
  const bytes = new TextEncoder().encode(value);
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/**
 * Collect assertion ids that name `criterionId` via observations or verification
 * receipts (preflight step 9 premise-collection rule).
 */
export function collectCriterionPremises(
  evidence: TrustedEvaluationEvidenceSnapshotV1,
  criterionId: string,
): readonly string[] {
  const premiseAssertionIds = new Set<string>();
  for (const observation of evidence.verificationResult.observations) {
    if (observation.criterionIds.includes(criterionId)) {
      for (const assertionId of observation.assertionIds) {
        premiseAssertionIds.add(assertionId);
      }
    }
  }
  for (const receipt of evidence.verificationReceipts) {
    if (receipt.criterionIds.includes(criterionId)) {
      premiseAssertionIds.add(receipt.assertionId);
    }
  }
  return sortedUnique([...premiseAssertionIds]);
}

function eligiblePremisesForCriterion(
  evidence: TrustedEvaluationEvidenceSnapshotV1,
  criterionId: string,
  eligibleAssertionIds: ReadonlySet<string>,
): readonly string[] {
  return collectCriterionPremises(evidence, criterionId).filter((id) =>
    eligibleAssertionIds.has(id),
  );
}

function evidenceArtifactIdsForCriterion(
  evidence: TrustedEvaluationEvidenceSnapshotV1,
  criterionId: string,
): readonly string[] {
  const ids = new Set<string>();
  for (const observation of evidence.verificationResult.observations) {
    if (observation.criterionIds.includes(criterionId)) {
      for (const artifactId of observation.artifactIds) {
        ids.add(artifactId);
      }
    }
  }
  return sortedUnique([...ids]);
}

function verificationReceiptIdsForCriterion(
  evidence: TrustedEvaluationEvidenceSnapshotV1,
  criterionId: string,
): readonly string[] {
  const ids = new Set<string>();
  for (const receipt of evidence.verificationReceipts) {
    if (receipt.criterionIds.includes(criterionId)) {
      ids.add(receipt.id);
    }
  }
  return sortedUnique([...ids]);
}

function preflightAdvancedPastDeterministicChecks(
  preflight: DeterministicPreflightResultV1,
): boolean {
  const gates = preflight.checks.find((check) => check.checkId === 'deterministic_gates');
  const surfaces = preflight.checks.find(
    (check) => check.checkId === 'real_surface_coverage',
  );
  return gates?.status === 'pass' && surfaces?.status === 'pass';
}

function lastPreflightCheck(preflight: DeterministicPreflightResultV1) {
  return preflight.checks[preflight.checks.length - 1];
}

function allAssertionsEligible(
  assertionIds: readonly string[],
  eligibleAssertionIds: ReadonlySet<string>,
): boolean {
  return (
    assertionIds.length > 0 &&
    assertionIds.every((assertionId) => eligibleAssertionIds.has(assertionId))
  );
}

function allocateUniqueFindingCode(
  preferred: string,
  used: Set<string>,
): string {
  if (!used.has(preferred)) {
    used.add(preferred);
    return preferred;
  }
  let suffix = 2;
  while (used.has(`${preferred}-${suffix}`)) {
    suffix += 1;
  }
  const allocated = `${preferred}-${suffix}`;
  used.add(allocated);
  return allocated;
}

function mapFindings(
  proposal: EvaluatorProposalV1,
  eligibleAssertionIds: ReadonlySet<string>,
): {
  readonly blockingFindings: readonly Finding[];
  readonly nonBlockingRisks: readonly Finding[];
} {
  const blockingFindings: Finding[] = [];
  const nonBlockingRisks: Finding[] = [];
  const usedCodes = new Set<string>();

  for (const finding of proposal.findings) {
    const eligible = allAssertionsEligible(finding.assertionIds, eligibleAssertionIds);
    const summary = truncateUtf8(finding.advisoryRationale, MAX_EXPLANATION_BYTES);
    const criterionIds = sortedUnique(finding.criterionIds);

    if (finding.severity === 'blocking' && eligible) {
      const code = allocateUniqueFindingCode(finding.findingCode, usedCodes);
      blockingFindings.push({ code, summary, criterionIds });
      continue;
    }

    if (finding.severity === 'blocking' && !eligible) {
      const code = allocateUniqueFindingCode(
        `${finding.findingCode}-ineligible`,
        usedCodes,
      );
      nonBlockingRisks.push({
        code,
        summary: truncateUtf8(
          `${summary} (degraded: ineligible or unknown assertion premises)`,
          MAX_EXPLANATION_BYTES,
        ),
        criterionIds,
      });
      continue;
    }

    // advisory
    const code = allocateUniqueFindingCode(finding.findingCode, usedCodes);
    nonBlockingRisks.push({ code, summary, criterionIds });
  }

  return { blockingFindings, nonBlockingRisks };
}

function proposalBlockingSupportsFail(
  proposal: EvaluatorProposalV1,
  criterionId: string,
  eligibleAssertionIds: ReadonlySet<string>,
): boolean {
  return proposal.findings.some(
    (finding: EvaluatorFindingProposalV1) =>
      finding.severity === 'blocking' &&
      finding.criterionIds.includes(criterionId) &&
      allAssertionsEligible(finding.assertionIds, eligibleAssertionIds),
  );
}

function deriveCriterionResult(args: {
  readonly criterionId: string;
  readonly authority: CriterionAuthority;
  readonly evidence: TrustedEvaluationEvidenceSnapshotV1;
  readonly preflight: DeterministicPreflightResultV1;
  readonly proposal: EvaluatorProposalV1 | null;
  readonly eligibleAssertionIds: ReadonlySet<string>;
  readonly candidateBinding: string;
  readonly observedAt: string;
}): {
  readonly result: CriterionResult;
  readonly usedAssertionIds: readonly string[];
} {
  const {
    criterionId,
    authority,
    evidence,
    preflight,
    proposal,
    eligibleAssertionIds,
    candidateBinding,
    observedAt,
  } = args;

  if (authority === 'human') {
    return {
      result: {
        criterionId,
        status: 'pending',
        authority,
        evidenceRefs: [],
        observedAt: null,
        candidateBinding,
        explanation: truncateUtf8(
          'Human authority criterion remains pending; evaluator never decides it.',
          MAX_EXPLANATION_BYTES,
        ),
      },
      usedAssertionIds: [],
    };
  }

  // M1 evidenceRefs are manifest artifact ids (not assertion ids). Eligible
  // premise assertion ids are carried on the criterion relationship instead.
  const artifactRefs = evidenceArtifactIdsForCriterion(evidence, criterionId);

  if (DETERMINISTIC_AUTHORITIES.has(authority)) {
    const last = lastPreflightCheck(preflight);
    const eligiblePremises = eligiblePremisesForCriterion(
      evidence,
      criterionId,
      eligibleAssertionIds,
    );
    if (
      preflight.classification === 'verified_fail' &&
      last !== undefined &&
      last.criterionIds.includes(criterionId)
    ) {
      return {
        result: {
          criterionId,
          status: 'fail',
          authority,
          evidenceRefs: artifactRefs,
          observedAt,
          candidateBinding,
          explanation: truncateUtf8(
            `Deterministic criterion ${criterionId} failed under verified preflight evidence.`,
            MAX_EXPLANATION_BYTES,
          ),
        },
        usedAssertionIds: eligiblePremises,
      };
    }
    if (
      preflightAdvancedPastDeterministicChecks(preflight) &&
      eligiblePremises.length > 0
    ) {
      return {
        result: {
          criterionId,
          status: 'pass',
          authority,
          evidenceRefs: artifactRefs,
          observedAt,
          candidateBinding,
          explanation: truncateUtf8(
            `Deterministic criterion ${criterionId} passed with eligible verified premises.`,
            MAX_EXPLANATION_BYTES,
          ),
        },
        usedAssertionIds: eligiblePremises,
      };
    }
    return {
      result: {
        criterionId,
        status: 'insufficient_evidence',
        authority,
        evidenceRefs: artifactRefs,
        observedAt,
        candidateBinding,
        explanation: truncateUtf8(
          `Deterministic criterion ${criterionId} lacks eligible premises or gate coverage.`,
          MAX_EXPLANATION_BYTES,
        ),
      },
      usedAssertionIds: eligiblePremises,
    };
  }

  // evaluator (model-owned) and any future non-deterministic authority
  if (proposal === null) {
    return {
      result: {
        criterionId,
        status: 'insufficient_evidence',
        authority,
        evidenceRefs: artifactRefs,
        observedAt,
        candidateBinding,
        explanation: truncateUtf8(
          `Model-owned criterion ${criterionId} has no evaluator proposal to decide it.`,
          MAX_EXPLANATION_BYTES,
        ),
      },
      usedAssertionIds: [],
    };
  }

  const criterionProposal = proposal.criterionProposals.find(
    (entry) => entry.criterionId === criterionId,
  );
  if (criterionProposal === undefined) {
    return {
      result: {
        criterionId,
        status: 'insufficient_evidence',
        authority,
        evidenceRefs: artifactRefs,
        observedAt,
        candidateBinding,
        explanation: truncateUtf8(
          `Model-owned criterion ${criterionId} is missing from the evaluator proposal.`,
          MAX_EXPLANATION_BYTES,
        ),
      },
      usedAssertionIds: [],
    };
  }

  const premisesEligible = allAssertionsEligible(
    criterionProposal.premiseAssertionIds,
    eligibleAssertionIds,
  );
  const usedAssertionIds = premisesEligible
    ? sortedUnique(criterionProposal.premiseAssertionIds)
    : [];

  if (!premisesEligible) {
    return {
      result: {
        criterionId,
        status: 'insufficient_evidence',
        authority,
        evidenceRefs: artifactRefs,
        observedAt,
        candidateBinding,
        explanation: truncateUtf8(
          `Model-owned criterion ${criterionId} cites empty or ineligible premises.`,
          MAX_EXPLANATION_BYTES,
        ),
      },
      usedAssertionIds: [],
    };
  }

  if (criterionProposal.proposedStatus === 'pass') {
    return {
      result: {
        criterionId,
        status: 'pass',
        authority,
        evidenceRefs: artifactRefs,
        observedAt,
        candidateBinding,
        explanation: truncateUtf8(
          criterionProposal.advisoryRationale.length > 0
            ? criterionProposal.advisoryRationale
            : `Evaluator proposed pass for ${criterionId} on eligible premises.`,
          MAX_EXPLANATION_BYTES,
        ),
      },
      usedAssertionIds,
    };
  }

  if (criterionProposal.proposedStatus === 'fail') {
    if (proposalBlockingSupportsFail(proposal, criterionId, eligibleAssertionIds)) {
      return {
        result: {
          criterionId,
          status: 'fail',
          authority,
          evidenceRefs: artifactRefs,
          observedAt,
          candidateBinding,
          explanation: truncateUtf8(
            criterionProposal.advisoryRationale.length > 0
              ? criterionProposal.advisoryRationale
              : `Evaluator proposed fail for ${criterionId} with a blocking finding.`,
            MAX_EXPLANATION_BYTES,
          ),
        },
        usedAssertionIds,
      };
    }
    return {
      result: {
        criterionId,
        status: 'insufficient_evidence',
        authority,
        evidenceRefs: artifactRefs,
        observedAt,
        candidateBinding,
        explanation: truncateUtf8(
          `Evaluator fail for ${criterionId} lacks an eligible-premise-backed blocking finding.`,
          MAX_EXPLANATION_BYTES,
        ),
      },
      usedAssertionIds,
    };
  }

  // insufficient_evidence
  return {
    result: {
      criterionId,
      status: 'insufficient_evidence',
      authority,
      evidenceRefs: artifactRefs,
      observedAt,
      candidateBinding,
      explanation: truncateUtf8(
        criterionProposal.advisoryRationale.length > 0
          ? criterionProposal.advisoryRationale
          : `Evaluator reported insufficient evidence for ${criterionId}.`,
        MAX_EXPLANATION_BYTES,
      ),
    },
    usedAssertionIds,
  };
}

function deriveOutcome(args: {
  readonly control: TrustedEvaluationControlSnapshotV1;
  readonly criterionResults: readonly CriterionResult[];
  readonly blockingFindings: readonly Finding[];
  readonly preflight: DeterministicPreflightResultV1;
}): {
  readonly outcome: EvaluationVerdict['outcome'];
  readonly recommendedNextStage: EvaluationVerdict['recommendedNextStage'];
  readonly outcomeReasonCodes: readonly string[];
} {
  const { control, criterionResults, blockingFindings, preflight } = args;
  const resultsById = new Map(
    criterionResults.map((result) => [result.criterionId, result] as const),
  );
  const requiredCriteria = control.rubric.criteria.filter((criterion) => criterion.required);
  const requiredIds = new Set(requiredCriteria.map((criterion) => criterion.criterionId));

  const requiredFailed = requiredCriteria.some(
    (criterion) => resultsById.get(criterion.criterionId)?.status === 'fail',
  );
  const blockingOnRequired = blockingFindings.some((finding) =>
    finding.criterionIds.some((criterionId) => requiredIds.has(criterionId)),
  );
  // A deterministically verified failure is an intact, eligible-premise-backed
  // failure. It outranks every evidence gap and can never soften to pass or
  // need_more_evidence, even when the failing check named no rubric criterion
  // (e.g. a trusted external gate receipt verified_fail). See the contract's
  // "verified failure is distinct from missing evidence" rule.
  const preflightVerifiedFail = preflight.classification === 'verified_fail';

  if (requiredFailed || blockingOnRequired || preflightVerifiedFail) {
    const reasons: string[] = [];
    if (requiredFailed) {
      reasons.push('required_criterion_failed');
    }
    if (blockingOnRequired) {
      reasons.push('blocking_finding');
    }
    if (preflightVerifiedFail && reasons.length === 0) {
      reasons.push('deterministic_gate_failed');
    }
    return {
      outcome: 'fail',
      recommendedNextStage: 'repair',
      outcomeReasonCodes: sortedUnique(reasons),
    };
  }

  const requiredNonHumanInsufficient = requiredCriteria.some((criterion) => {
    if (criterion.authority === 'human') {
      return false;
    }
    return resultsById.get(criterion.criterionId)?.status === 'insufficient_evidence';
  });
  const preflightNeedsEvidence = preflight.classification === 'need_more_evidence';
  const requiredHumanPending = requiredCriteria.some(
    (criterion) =>
      criterion.authority === 'human' &&
      resultsById.get(criterion.criterionId)?.status === 'pending',
  );

  // M1 assertEvaluationVerdictBinding requires escalate_human whenever a
  // required human criterion is pending on a need_more_evidence verdict.
  // Prefer that stage when human pending coexists with insufficiency.
  if (requiredNonHumanInsufficient || preflightNeedsEvidence || requiredHumanPending) {
    if (requiredHumanPending) {
      const reasons: string[] = ['human_criterion_pending'];
      if (requiredNonHumanInsufficient || preflightNeedsEvidence) {
        reasons.push('insufficient_evidence');
      }
      return {
        outcome: 'need_more_evidence',
        recommendedNextStage: 'escalate_human',
        outcomeReasonCodes: sortedUnique(reasons),
      };
    }
    return {
      outcome: 'need_more_evidence',
      recommendedNextStage: 'reverify',
      outcomeReasonCodes: ['insufficient_evidence'],
    };
  }

  return {
    outcome: 'pass',
    recommendedNextStage: 'complete',
    outcomeReasonCodes: ['all_required_criteria_pass'],
  };
}

/**
 * Derive the immutable evaluation verdict and criterion relationships from
 * preflight + optional evaluator proposal. Throws only on caller contract errors.
 */
export function deriveVerdict(args: VerdictDerivationArgsV1): VerdictDerivationV1 {
  const {
    input,
    control,
    evidence,
    preflight,
    proposal,
    verdictId,
    createdAt,
    evaluatorVersion,
    evaluatorModel,
    evaluatorRuntime,
    evaluatorInfrastructureFailure,
  } = args;

  const requiresProposal = preflight.classification === 'model_judgment_required';
  const infraFailure = evaluatorInfrastructureFailure;
  if (infraFailure !== undefined) {
    if (!requiresProposal || proposal !== null) {
      throw new IndependentEvaluationError(
        'evaluator_contract_violation',
        'evaluatorInfrastructureFailure is legal only for model_judgment_required with a null proposal',
      );
    }
    if (
      infraFailure.code !== 'evaluator_unavailable' &&
      infraFailure.code !== 'evaluator_contract_violation'
    ) {
      throw new IndependentEvaluationError(
        'evaluator_contract_violation',
        'evaluatorInfrastructureFailure.code must be evaluator_unavailable or evaluator_contract_violation',
      );
    }
    if (typeof infraFailure.detail !== 'string') {
      throw new IndependentEvaluationError(
        'evaluator_contract_violation',
        'evaluatorInfrastructureFailure.detail must be a string',
      );
    }
  }
  if (requiresProposal && proposal === null && infraFailure === undefined) {
    throw new IndependentEvaluationError(
      'evaluator_contract_violation',
      'deriveVerdict requires an evaluator proposal when preflight classification is model_judgment_required',
    );
  }
  if (!requiresProposal && proposal !== null) {
    throw new IndependentEvaluationError(
      'evaluator_contract_violation',
      `deriveVerdict forbids an evaluator proposal when preflight classification is ${preflight.classification}`,
    );
  }

  const eligibleAssertionIds = new Set(preflight.eligibleAssertionIds);
  const candidateBinding = candidateRefBinding(evidence.candidateRef);
  const observedAt = evidence.observedAt;

  const criterionResults: CriterionResult[] = [];
  const criterionRelationships: EvaluationCriterionRelationshipV1[] = [];
  const usedAssertionsByCriterion = new Map<string, readonly string[]>();

  for (const criterion of control.rubric.criteria) {
    const derived = deriveCriterionResult({
      criterionId: criterion.criterionId,
      authority: criterion.authority,
      evidence,
      preflight,
      proposal,
      eligibleAssertionIds,
      candidateBinding,
      observedAt,
    });
    criterionResults.push(derived.result);
    usedAssertionsByCriterion.set(criterion.criterionId, derived.usedAssertionIds);
  }

  const mapped =
    proposal === null
      ? { blockingFindings: [] as Finding[], nonBlockingRisks: [] as Finding[] }
      : mapFindings(proposal, eligibleAssertionIds);
  // A deterministic verified_fail always fails the candidate. M1 requires a
  // fail verdict to carry a *required* failed criterion or a blocking finding,
  // so synthesize a blocking finding whenever the verified_fail is attributed
  // only to a non-required criterion (or to no criterion at all) and no
  // blocking finding already covers it. Basing this on required-criterion fail
  // (not any-criterion fail) keeps a non-required verified_fail a clean fail
  // rather than an M1-binding throw the coordinator would downgrade to a gap.
  const requiredCriterionIds = new Set(
    control.rubric.criteria
      .filter((criterion) => criterion.required)
      .map((criterion) => criterion.criterionId),
  );
  const gateVerifiedFailUnattributed =
    preflight.classification === 'verified_fail' &&
    !criterionResults.some(
      (result) =>
        result.status === 'fail' && requiredCriterionIds.has(result.criterionId),
    ) &&
    mapped.blockingFindings.length === 0;
  const mappedFindings = gateVerifiedFailUnattributed
    ? {
        blockingFindings: [
          {
            code: 'deterministic_gate_failed',
            summary: truncateUtf8(
              'A deterministic gate reported verified_fail without naming a rubric criterion.',
              MAX_EXPLANATION_BYTES,
            ),
            criterionIds: [] as readonly string[],
          },
          ...mapped.blockingFindings,
        ] as readonly Finding[],
        nonBlockingRisks: mapped.nonBlockingRisks,
      }
    : mapped;

  const outcome =
    infraFailure !== undefined
      ? {
          outcome: 'need_more_evidence' as const,
          recommendedNextStage: 'reverify' as const,
          outcomeReasonCodes: sortedUnique([
            'insufficient_evidence',
            infraFailure.code,
          ]),
        }
      : deriveOutcome({
          control,
          criterionResults,
          blockingFindings: mappedFindings.blockingFindings,
          preflight,
        });

  // Infrastructure-failure path still binds the authorized evaluator run id so
  // M1 independentEvaluatorRequired checks remain satisfiable without a proposal.
  const evaluatorAgentRunId =
    proposal !== null || infraFailure !== undefined
      ? control.roles.evaluatorRunId
      : null;

  const binding: EvaluationBinding = {
    taskId: evidence.taskContract.taskId,
    contractVersion: evidence.taskContract.version,
    contractHash: evidence.taskContract.contractHash,
    iterationId: evidence.iterationId,
    candidateRef: evidence.candidateRef,
    evidenceManifestHash: evidence.evidenceManifest.manifestHash,
    evaluatorVersion,
    evaluatorModel,
    evaluatorRuntime,
    policyVersion: String(control.policy.version),
  };

  const verdict: EvaluationVerdict = {
    id: verdictId,
    binding,
    outcome: outcome.outcome,
    criterionResults,
    blockingFindings: mappedFindings.blockingFindings,
    nonBlockingRisks: mappedFindings.nonBlockingRisks,
    recommendedNextStage: outcome.recommendedNextStage,
    evaluatorAgentRunId,
    createdAt,
  };

  for (const criterion of control.rubric.criteria) {
    const assertionIds = usedAssertionsByCriterion.get(criterion.criterionId) ?? [];
    const evidenceArtifactIds = evidenceArtifactIdsForCriterion(
      evidence,
      criterion.criterionId,
    );
    const verificationReceiptIds = verificationReceiptIdsForCriterion(
      evidence,
      criterion.criterionId,
    );
    const withoutHash = {
      criterionId: criterion.criterionId,
      assertionIds,
      evidenceArtifactIds,
      verificationReceiptIds,
    };
    const relationship: EvaluationCriterionRelationshipV1 = {
      ...withoutHash,
      relationshipHash: computeCriterionRelationshipHash(withoutHash),
    };
    assertEvaluationCriterionRelationshipV1(relationship);
    criterionRelationships.push(relationship);
  }

  const authorityContext: EvaluationAuthorityContext = {
    evaluatorAgentRunId,
    implementerAgentRunIds: control.roles.implementerRunIds,
  };
  assertEvaluationVerdictBinding(
    verdict,
    binding,
    evidence.taskContract,
    evidence.evidenceManifest,
    evidence.artifacts,
    authorityContext,
  );

  // Keep input referenced so callers must supply the sealed subject.
  void input;

  return {
    verdict,
    outcomeReasonCodes: outcome.outcomeReasonCodes,
    criterionRelationships,
  };
}
