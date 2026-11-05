import type {
  AssertionClassification,
  CriterionResultDto,
  CriterionStatus,
  EvidenceSummaryDto,
  FindingDto,
  OutcomeStatus,
  ReviewAxisStatus,
  ReviewPackageV2Dto,
} from './reviewTypes.js';

export type ReviewPresentationStatus =
  | AssertionClassification
  | CriterionStatus
  | OutcomeStatus
  | ReviewAxisStatus;
export type PresentedStatus = ReviewPresentationStatus;
export type ReviewTone = 'green' | 'blue' | 'amber' | 'gray' | 'red';
export type ReviewIcon = 'check' | 'branch' | 'search' | 'user' | 'message' | 'x' | 'minus';

export interface StatusPresentation {
  readonly label: string;
  readonly icon: ReviewIcon;
  readonly tone: ReviewTone;
}

export interface WindowedRows<T> {
  readonly rows: readonly T[];
  readonly totalCount: number;
  readonly visibleCount: number;
  readonly hasMore: boolean;
}

export interface RequiredCriterionCounts {
  readonly total: number;
  readonly pass: number;
  readonly fail: number;
  readonly gap: number;
}

export interface CriterionRowViewModel {
  readonly criterion: CriterionResultDto;
  readonly presentation: StatusPresentation;
  readonly strongestEvidence: EvidenceSummaryDto | null;
}

export interface ReviewViewModel {
  readonly outcome: StatusPresentation;
  readonly requiredCounts: RequiredCriterionCounts;
  readonly firstRequiredProblem: CriterionResultDto | null;
  readonly remainingRiskCount: number;
  readonly firstRemainingRisk: FindingDto | null;
  readonly criteria: WindowedRows<CriterionRowViewModel>;
  readonly evidence: WindowedRows<EvidenceSummaryDto>;
  readonly blockingFindings: WindowedRows<FindingDto>;
  readonly remainingRisks: WindowedRows<FindingDto>;
  readonly iterations: WindowedRows<ReviewPackageV2Dto['iterations'][number]>;
}

const PRESENTATION: Readonly<Record<ReviewPresentationStatus, StatusPresentation>> = {
  verified: { label: 'Verified', icon: 'check', tone: 'green' },
  pass: { label: 'Pass', icon: 'check', tone: 'green' },
  inference: { label: 'Inference', icon: 'branch', tone: 'blue' },
  unverified_pending: { label: 'Needs evidence', icon: 'search', tone: 'amber' },
  need_more_evidence: { label: 'Needs evidence', icon: 'search', tone: 'amber' },
  needs_human: { label: 'Needs human', icon: 'user', tone: 'amber' },
  opinion: { label: 'Opinion', icon: 'message', tone: 'gray' },
  failed: { label: 'Failed', icon: 'x', tone: 'red' },
  fail: { label: 'Failed', icon: 'x', tone: 'red' },
  not_applicable: { label: 'Not applicable', icon: 'minus', tone: 'gray' },
};

const encoder = new TextEncoder();

export function statusPresentation(status: ReviewPresentationStatus): StatusPresentation {
  return PRESENTATION[status];
}

export function windowRows<T>(rows: readonly T[], limit = 20): WindowedRows<T> {
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : 20;
  const visible = rows.slice(0, safeLimit);
  return {
    rows: visible,
    totalCount: rows.length,
    visibleCount: visible.length,
    hasMore: visible.length < rows.length,
  };
}

function compareBytewise(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

export function selectStrongestEvidence(
  criterion: CriterionResultDto,
  evidence: readonly EvidenceSummaryDto[],
): EvidenceSummaryDto | null {
  const criterionEvidence = new Set(criterion.evidenceArtifactIds);
  const criterionAssertions = new Set(criterion.assertionIds);
  const candidates = evidence.filter(
    (item) =>
      item.trustClass !== 'agent_claim' &&
      criterionEvidence.has(item.artifactRefId) &&
      item.supportsAssertionIds.some((id) => criterionAssertions.has(id)),
  );
  candidates.sort((left, right) => {
    const leftRank = left.trustClass === 'primary' ? 0 : 1;
    const rightRank = right.trustClass === 'primary' ? 0 : 1;
    return leftRank - rightRank || compareBytewise(left.artifactRefId, right.artifactRefId);
  });
  return candidates[0] ?? null;
}

export function buildReviewViewModel(
  packageValue: ReviewPackageV2Dto,
  rowLimit = 20,
): ReviewViewModel {
  const required = packageValue.criteria.filter((criterion) => criterion.required);
  const requiredCounts: RequiredCriterionCounts = {
    total: required.length,
    pass: required.filter((criterion) => criterion.status === 'pass').length,
    fail: required.filter((criterion) => criterion.status === 'fail').length,
    gap: required.filter(
      (criterion) =>
        criterion.status === 'need_more_evidence' || criterion.status === 'needs_human',
    ).length,
  };
  const firstRequiredProblem =
    required.find(
      (criterion) =>
        criterion.status === 'fail' ||
        criterion.status === 'need_more_evidence' ||
        criterion.status === 'needs_human',
    ) ?? null;
  const criterionRows = packageValue.criteria.map((criterion) => ({
    criterion,
    presentation: statusPresentation(criterion.status),
    strongestEvidence: selectStrongestEvidence(criterion, packageValue.evidence),
  }));

  return {
    outcome: statusPresentation(packageValue.outcome.status),
    requiredCounts,
    firstRequiredProblem,
    remainingRiskCount: packageValue.remainingRisks.length,
    firstRemainingRisk: packageValue.remainingRisks[0] ?? null,
    criteria: windowRows(criterionRows, rowLimit),
    evidence: windowRows(packageValue.evidence, rowLimit),
    blockingFindings: windowRows(packageValue.blockingFindings, rowLimit),
    remainingRisks: windowRows(packageValue.remainingRisks, rowLimit),
    iterations: windowRows(packageValue.iterations, rowLimit),
  };
}
