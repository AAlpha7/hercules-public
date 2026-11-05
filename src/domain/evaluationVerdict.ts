import {
  assertEvidenceManifestArtifacts,
  candidateRefBinding,
  candidateRefsEqual,
  type ArtifactRef,
  type CandidateRef,
  type EvidenceManifest,
} from './artifact.js';
import {
  assertTaskContract,
  CRITERION_AUTHORITIES,
  type CriterionAuthority,
  type TaskContract,
} from './taskContract.js';
import {
  isNonEmptyString,
  isNullableNonEmptyString,
  isRecord,
  isUniqueStringArray,
  V2InvariantError,
} from './v2Invariant.js';

export interface DecisionBinding {
  readonly taskId: string;
  readonly contractVersion: number;
  readonly contractHash: string;
  readonly iterationId: string | null;
  readonly candidateRef: CandidateRef | null;
  readonly evidenceManifestHash: string | null;
  readonly evaluatorVersion: string;
  readonly evaluatorModel: string | null;
  readonly evaluatorRuntime: string;
  readonly policyVersion: string;
}

export interface EvaluationBinding extends DecisionBinding {
  readonly iterationId: string;
  readonly candidateRef: CandidateRef;
  readonly evidenceManifestHash: string;
}

export const CRITERION_RESULT_STATUSES = [
  'pass',
  'fail',
  'pending',
  'not_applicable',
  'insufficient_evidence',
] as const;
export type CriterionResultStatus = (typeof CRITERION_RESULT_STATUSES)[number];

export const EVALUATION_OUTCOMES = ['pass', 'fail', 'need_more_evidence'] as const;
export const RECOMMENDED_NEXT_STAGES = [
  'complete',
  'repair',
  'reverify',
  'request_contract_change',
  'escalate_human',
] as const;

export interface CriterionResult {
  readonly criterionId: string;
  readonly status: CriterionResultStatus;
  readonly authority: CriterionAuthority;
  readonly evidenceRefs: readonly string[];
  readonly observedAt: string | null;
  readonly candidateBinding: string;
  readonly explanation: string;
}

export interface Finding {
  readonly code: string;
  readonly summary: string;
  readonly criterionIds: readonly string[];
}

export interface EvaluationVerdict {
  readonly id: string;
  readonly binding: EvaluationBinding;
  readonly outcome: (typeof EVALUATION_OUTCOMES)[number];
  readonly criterionResults: readonly CriterionResult[];
  readonly blockingFindings: readonly Finding[];
  readonly nonBlockingRisks: readonly Finding[];
  readonly recommendedNextStage: (typeof RECOMMENDED_NEXT_STAGES)[number];
  readonly evaluatorAgentRunId: string | null;
  readonly createdAt: string;
}

export interface EvaluationAuthorityContext {
  readonly evaluatorAgentRunId: string | null;
  readonly implementerAgentRunIds: readonly string[];
}

function decisionBindingIdentityIsValid(binding: DecisionBinding): boolean {
  return (
    isRecord(binding) &&
    isNonEmptyString(binding.taskId) &&
    Number.isSafeInteger(binding.contractVersion) &&
    binding.contractVersion >= 1 &&
    isNonEmptyString(binding.contractHash) &&
    isNullableNonEmptyString(binding.iterationId) &&
    (binding.candidateRef === null ||
      candidateRefsEqual(binding.candidateRef, binding.candidateRef)) &&
    isNullableNonEmptyString(binding.evidenceManifestHash) &&
    isNonEmptyString(binding.evaluatorVersion) &&
    isNullableNonEmptyString(binding.evaluatorModel) &&
    isNonEmptyString(binding.evaluatorRuntime) &&
    isNonEmptyString(binding.policyVersion)
  );
}

export function decisionBindingsEqual(left: DecisionBinding, right: DecisionBinding): boolean {
  if (!decisionBindingIdentityIsValid(left) || !decisionBindingIdentityIsValid(right)) {
    return false;
  }
  return (
    left.taskId === right.taskId &&
    left.contractVersion === right.contractVersion &&
    left.contractHash === right.contractHash &&
    left.iterationId === right.iterationId &&
    ((left.candidateRef === null && right.candidateRef === null) ||
      (left.candidateRef !== null &&
        right.candidateRef !== null &&
        candidateRefsEqual(left.candidateRef, right.candidateRef))) &&
    left.evidenceManifestHash === right.evidenceManifestHash &&
    left.evaluatorVersion === right.evaluatorVersion &&
    left.evaluatorModel === right.evaluatorModel &&
    left.evaluatorRuntime === right.evaluatorRuntime &&
    left.policyVersion === right.policyVersion
  );
}

export function assertDecisionBindingIdentity(binding: DecisionBinding): void {
  if (!decisionBindingIdentityIsValid(binding)) {
    throw new V2InvariantError(
      'invalid_decision_binding',
      'decision and freshness binding identities must be non-empty and contractVersion must be positive',
    );
  }
}

export function assertDecisionBinding(
  actual: DecisionBinding,
  expected: DecisionBinding,
): void {
  assertDecisionBindingIdentity(actual);
  assertDecisionBindingIdentity(expected);
  if (!decisionBindingsEqual(actual, expected)) {
    throw new V2InvariantError(
      'stale_decision_binding',
      'decision binding does not match the exact contract, iteration, candidate, evidence, evaluator, and policy',
    );
  }
}

export function assertEvaluationVerdictBinding(
  verdict: EvaluationVerdict,
  expected: EvaluationBinding,
  contract: TaskContract,
  manifest: EvidenceManifest,
  artifacts: readonly ArtifactRef[],
  authorityContext: EvaluationAuthorityContext,
): void {
  if (!isRecord(verdict)) {
    throw new V2InvariantError(
      'invalid_evaluation_verdict',
      'evaluation verdict must be an object',
    );
  }
  if (
    !isNonEmptyString(verdict.id) ||
    !(EVALUATION_OUTCOMES as readonly unknown[]).includes(verdict.outcome) ||
    !(RECOMMENDED_NEXT_STAGES as readonly unknown[]).includes(verdict.recommendedNextStage) ||
    !Array.isArray(verdict.criterionResults) ||
    !Array.isArray(verdict.blockingFindings) ||
    !Array.isArray(verdict.nonBlockingRisks) ||
    !isNullableNonEmptyString(verdict.evaluatorAgentRunId) ||
    !isNonEmptyString(verdict.createdAt)
  ) {
    throw new V2InvariantError(
      'invalid_evaluation_verdict',
      'evaluation verdict identity, outcome, next stage, collections, and timing must be valid',
    );
  }
  const criterionIds = new Set<string>();
  for (const result of verdict.criterionResults) {
    if (
      result === null ||
      typeof result !== 'object' ||
      !isNonEmptyString(result.criterionId) ||
      !(CRITERION_RESULT_STATUSES as readonly unknown[]).includes(result.status) ||
      !(CRITERION_AUTHORITIES as readonly unknown[]).includes(result.authority) ||
      !isUniqueStringArray(result.evidenceRefs) ||
      !isNullableNonEmptyString(result.observedAt) ||
      !isNonEmptyString(result.candidateBinding) ||
      typeof result.explanation !== 'string'
    ) {
      throw new V2InvariantError(
        'invalid_evaluation_verdict',
        'evaluation criterion results must carry valid authority, status, evidence, and binding',
      );
    }
    if (criterionIds.has(result.criterionId)) {
      throw new V2InvariantError(
        'invalid_evaluation_verdict',
        `evaluation criterion ids must be unique: ${result.criterionId}`,
      );
    }
    criterionIds.add(result.criterionId);
  }
  const findingCodes = new Set<string>();
  for (const finding of [...verdict.blockingFindings, ...verdict.nonBlockingRisks]) {
    if (
      finding === null ||
      typeof finding !== 'object' ||
      !isNonEmptyString(finding.code) ||
      !isNonEmptyString(finding.summary) ||
      !isUniqueStringArray(finding.criterionIds)
    ) {
      throw new V2InvariantError(
        'invalid_evaluation_verdict',
        'evaluation findings must carry valid codes, summaries, and criterion identities',
      );
    }
    if (findingCodes.has(finding.code)) {
      throw new V2InvariantError(
        'invalid_evaluation_verdict',
        `evaluation finding codes must be unique across classifications: ${finding.code}`,
      );
    }
    findingCodes.add(finding.code);
  }
  assertTaskContract(contract);
  assertEvidenceManifestArtifacts(manifest, artifacts);
  if (
    !isRecord(authorityContext) ||
    !isNullableNonEmptyString(authorityContext.evaluatorAgentRunId) ||
    !isUniqueStringArray(authorityContext.implementerAgentRunIds) ||
    verdict.evaluatorAgentRunId !== authorityContext.evaluatorAgentRunId
  ) {
    throw new V2InvariantError(
      'invalid_evaluation_verdict',
      'evaluation verdict must match valid trusted evaluator and implementer run identities',
    );
  }
  assertDecisionBindingIdentity(verdict.binding);
  assertDecisionBindingIdentity(expected);
  for (const binding of [verdict.binding, expected]) {
    if (
      binding.iterationId === null ||
      binding.candidateRef === null ||
      binding.evidenceManifestHash === null
    ) {
      throw new V2InvariantError(
        'invalid_decision_binding',
        'evaluation binding requires an exact iteration, candidate, and evidence manifest',
      );
    }
  }
  if (
    contract.taskId !== verdict.binding.taskId ||
    contract.version !== verdict.binding.contractVersion ||
    contract.contractHash !== verdict.binding.contractHash
  ) {
    throw new V2InvariantError(
      'invalid_evaluation_verdict',
      'evaluation verdict is not bound to the supplied trusted contract',
    );
  }
  if (
    manifest.taskId !== verdict.binding.taskId ||
    manifest.contractVersion !== verdict.binding.contractVersion ||
    manifest.iterationId !== verdict.binding.iterationId ||
    manifest.manifestHash !== verdict.binding.evidenceManifestHash ||
    !candidateRefsEqual(manifest.candidateRef, verdict.binding.candidateRef)
  ) {
    throw new V2InvariantError(
      'invalid_evaluation_verdict',
      'evaluation verdict is not bound to the supplied trusted evidence manifest',
    );
  }
  const criteriaById = new Map(
    contract.acceptanceCriteria.map((criterion) => [criterion.id, criterion] as const),
  );
  const resultsById = new Map(
    verdict.criterionResults.map((result) => [result.criterionId, result] as const),
  );
  const evidenceById = new Map(
    manifest.entries.map((entry) => [entry.artifactRefId, entry] as const),
  );
  if (
    contract.verificationPolicy.independentEvaluatorRequired &&
    (authorityContext.evaluatorAgentRunId === null ||
      authorityContext.implementerAgentRunIds.includes(
        authorityContext.evaluatorAgentRunId,
      ))
  ) {
    throw new V2InvariantError(
      'invalid_evaluation_verdict',
      'trusted verification policy requires an independent evaluator agent run',
    );
  }
  for (const finding of [...verdict.blockingFindings, ...verdict.nonBlockingRisks]) {
    for (const criterionId of finding.criterionIds) {
      if (!criteriaById.has(criterionId)) {
        throw new V2InvariantError(
          'invalid_evaluation_verdict',
          `evaluation finding ${finding.code} references unknown criterion ${criterionId}`,
        );
      }
    }
  }
  for (const result of verdict.criterionResults) {
    const criterion = criteriaById.get(result.criterionId);
    if (criterion === undefined || criterion.authority !== result.authority) {
      throw new V2InvariantError(
        'invalid_evaluation_verdict',
        `evaluation criterion ${result.criterionId} does not match trusted contract authority`,
      );
    }
    for (const evidenceRef of result.evidenceRefs) {
      const evidence = evidenceById.get(evidenceRef);
      if (evidence === undefined || !evidence.criterionIds.includes(result.criterionId)) {
        throw new V2InvariantError(
          'invalid_evaluation_verdict',
          `evaluation criterion ${result.criterionId} references unbound evidence`,
        );
      }
    }
  }
  for (const criterion of contract.acceptanceCriteria) {
    if (criterion.required && !resultsById.has(criterion.id)) {
      throw new V2InvariantError(
        'invalid_evaluation_verdict',
        `evaluation verdict omits required criterion ${criterion.id}`,
      );
    }
  }
  const requiredCriterionResults = contract.acceptanceCriteria
    .filter((criterion) => criterion.required)
    .map((criterion) => ({
      criterion,
      result: resultsById.get(criterion.id)!,
    }));
  const requiredHumanPending = requiredCriterionResults.some(
    ({ criterion, result }) =>
      criterion.authority === 'human' && result.status === 'pending',
  );
  const requiredEvidenceGap = requiredCriterionResults.some(
    ({ criterion, result }) =>
      result.status === 'insufficient_evidence' ||
      (criterion.authority !== 'human' && result.status === 'pending'),
  );
  const expectedCandidateBinding = candidateRefBinding(verdict.binding.candidateRef);
  if (
    verdict.criterionResults.some(
      (result) => result.candidateBinding !== expectedCandidateBinding,
    )
  ) {
    throw new V2InvariantError(
      'invalid_evaluation_verdict',
      'evaluation criterion result is bound to a different candidate',
    );
  }
  if (
    verdict.criterionResults.some(
      (result) =>
        result.status === 'pass' &&
        (result.evidenceRefs.length === 0 ||
          result.observedAt === null ||
          !result.evidenceRefs.some(
            (evidenceRef: string) =>
              evidenceById.get(evidenceRef)?.trustClass === 'primary',
          )),
    )
  ) {
    throw new V2InvariantError(
      'invalid_evaluation_verdict',
      'a passing criterion requires bound primary evidence and an observation timestamp',
    );
  }
  if (
    verdict.criterionResults.some(
      (result) =>
        result.status === 'pass' &&
        criteriaById.get(result.criterionId)?.proofBinding !== null,
    )
  ) {
    throw new V2InvariantError(
      'invalid_evaluation_verdict',
      'M1 cannot grant pass authority for an opaque proof-bound criterion',
    );
  }
  if (verdict.outcome === 'pass') {
    const referencedPrimarySurfaces = new Set(
      verdict.criterionResults.flatMap((result) =>
        result.evidenceRefs.flatMap((evidenceRef: string) => {
          const entry = evidenceById.get(evidenceRef);
          return entry?.trustClass === 'primary' ? [entry.surface] : [];
        }),
      ),
    );
    const missingRequiredEvidence = contract.verificationPolicy.requiredEvidence.find(
      (requiredSurface) => !referencedPrimarySurfaces.has(requiredSurface),
    );
    if (missingRequiredEvidence !== undefined) {
      throw new V2InvariantError(
        'invalid_evaluation_verdict',
        `pass verdict is missing required primary evidence surface ${missingRequiredEvidence}`,
      );
    }
  }
  if (
    verdict.criterionResults.some(
      (result) =>
        result.authority === 'human' &&
        result.status !== 'pending' &&
        result.status !== 'insufficient_evidence',
    )
  ) {
    throw new V2InvariantError(
      'invalid_evaluation_verdict',
      'an evaluation verdict cannot decide human criterion authority',
    );
  }
  if (
    verdict.outcome === 'pass' &&
    (verdict.criterionResults.length === 0 ||
      verdict.blockingFindings.length > 0 ||
      contract.acceptanceCriteria.some((criterion) => {
        if (!criterion.required) return false;
        return resultsById.get(criterion.id)?.status !== 'pass';
      }))
  ) {
    throw new V2InvariantError(
      'invalid_evaluation_verdict',
      'a pass verdict requires all trusted required criteria to satisfy their authority and no blocking findings',
    );
  }
  if (
    verdict.outcome === 'fail' &&
    verdict.blockingFindings.length === 0 &&
    !requiredCriterionResults.some(({ result }) => result.status === 'fail')
  ) {
    throw new V2InvariantError(
      'invalid_evaluation_verdict',
      'a fail verdict requires a failed criterion or blocking finding',
    );
  }
  if (
    verdict.outcome === 'need_more_evidence' &&
    (verdict.blockingFindings.length > 0 ||
      requiredCriterionResults.some(({ result }) => result.status === 'fail') ||
      !requiredCriterionResults.some(
        ({ result }) =>
          result.status === 'pending' || result.status === 'insufficient_evidence',
      ))
  ) {
    throw new V2InvariantError(
      'invalid_evaluation_verdict',
      'a need-more-evidence verdict requires a pending or insufficient criterion',
    );
  }
  if (
    (verdict.outcome === 'pass' &&
      verdict.recommendedNextStage !== 'complete' &&
      verdict.recommendedNextStage !== 'escalate_human') ||
    (verdict.outcome === 'fail' &&
      verdict.recommendedNextStage !== 'repair' &&
      verdict.recommendedNextStage !== 'request_contract_change' &&
      verdict.recommendedNextStage !== 'escalate_human') ||
    (verdict.outcome === 'need_more_evidence' &&
      ((requiredHumanPending &&
        verdict.recommendedNextStage !== 'escalate_human') ||
        (!requiredHumanPending &&
          requiredEvidenceGap &&
          verdict.recommendedNextStage !== 'reverify')))
  ) {
    throw new V2InvariantError(
      'invalid_evaluation_verdict',
      'evaluation outcome and recommended next stage are inconsistent',
    );
  }
  assertDecisionBinding(verdict.binding, expected);
}
