import type { AdapterKind } from './agents.js';
import { redactHostOutput } from './hostExecutor.js';

export const REVIEWER_INFRASTRUCTURE_RECEIPT_VERSION = 1 as const;
export const REVIEWER_INFRASTRUCTURE_DETAIL_MAX = 320;
export const REVIEWER_GREEN_EVIDENCE_MAX = 24;

export type ReviewerInfrastructureFailureKind = 'authentication' | 'transient';
export type ReviewerInfrastructureRecoveryState = 'blocked' | 'ready';

/** Durable task-bound checkpoint. Internal paths never cross the API boundary. */
export interface ReviewerInfrastructureReceipt {
  readonly version: typeof REVIEWER_INFRASTRUCTURE_RECEIPT_VERSION;
  readonly provider: AdapterKind;
  readonly state: ReviewerInfrastructureRecoveryState;
  readonly failureKind: ReviewerInfrastructureFailureKind;
  readonly observedAt: string;
  readonly detail: string;
  readonly nextAction: string;
  readonly candidateSha: string;
  readonly branch: string;
  readonly worktree: string;
  readonly greenEvidence: readonly string[];
}

/** Bounded public aggregation; deliberately omits candidate and host paths. */
export interface ReviewerProviderHealth {
  readonly provider: AdapterKind;
  readonly state: 'blocked' | 'recovering';
  readonly failureKind: ReviewerInfrastructureFailureKind;
  readonly observedAt: string;
  readonly blockedCandidates: number;
  readonly detail: string;
  readonly nextAction: string;
}

const AUTH_FAILURE_RE =
  /not signed in|sign(?:ed)? out|log(?:ged)? out|unauthenticated|authentication|credential|login required|401|403/i;

export function classifyReviewerInfrastructureFailure(
  detail: string,
): ReviewerInfrastructureFailureKind {
  return AUTH_FAILURE_RE.test(detail) ? 'authentication' : 'transient';
}

export function reviewerRecoveryNextAction(provider: AdapterKind): string {
  return `Run reviewer health check or explicitly recover ${provider}`;
}

export function redactReviewerInfrastructureDetail(detail: string): string {
  return redactHostOutput(detail, REVIEWER_INFRASTRUCTURE_DETAIL_MAX)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REVIEWER_INFRASTRUCTURE_DETAIL_MAX);
}

export function buildReviewerInfrastructureReceipt(input: {
  readonly provider: AdapterKind;
  readonly detail: string;
  readonly observedAt: string;
  readonly candidateSha: string;
  readonly branch: string;
  readonly worktree: string;
  readonly greenEvidence: readonly string[];
}): ReviewerInfrastructureReceipt {
  const failureKind = classifyReviewerInfrastructureFailure(input.detail);
  const detail = redactReviewerInfrastructureDetail(input.detail) || 'Reviewer provider unavailable';
  return {
    version: REVIEWER_INFRASTRUCTURE_RECEIPT_VERSION,
    provider: input.provider,
    state: 'blocked',
    failureKind,
    observedAt: input.observedAt,
    detail,
    nextAction: reviewerRecoveryNextAction(input.provider),
    candidateSha: input.candidateSha,
    branch: input.branch,
    worktree: input.worktree,
    greenEvidence: [...new Set(input.greenEvidence.map((v) => v.trim()).filter(Boolean))]
      .slice(0, REVIEWER_GREEN_EVIDENCE_MAX),
  };
}

export function reviewerProviderHealth(
  receipts: readonly ReviewerInfrastructureReceipt[],
): ReviewerProviderHealth[] {
  const byProvider = new Map<AdapterKind, ReviewerInfrastructureReceipt[]>();
  for (const receipt of receipts) {
    const prior = byProvider.get(receipt.provider) ?? [];
    prior.push(receipt);
    byProvider.set(receipt.provider, prior);
  }
  return [...byProvider.entries()]
    .map(([provider, providerReceipts]) => {
      const newest = [...providerReceipts].sort((a, b) =>
        b.observedAt.localeCompare(a.observedAt),
      )[0]!;
      const blockedCandidates = providerReceipts.filter((r) => r.state === 'blocked').length;
      return {
        provider,
        state: blockedCandidates > 0 ? 'blocked' as const : 'recovering' as const,
        failureKind: newest.failureKind,
        observedAt: newest.observedAt,
        blockedCandidates,
        detail: redactReviewerInfrastructureDetail(newest.detail),
        nextAction: reviewerRecoveryNextAction(provider),
      };
    })
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

export function renderReviewerInfrastructureReceipt(
  receipt: ReviewerInfrastructureReceipt,
): string {
  const evidence = receipt.greenEvidence.length > 0
    ? receipt.greenEvidence.map((name) => `\`${name}\``).join(', ')
    : '(none recorded)';
  return [
    '## Reviewer infrastructure recovery',
    '',
    '**Status:** blocked — infrastructure, not a product verdict',
    `**Provider:** \`${receipt.provider}\` (${receipt.failureKind})`,
    `**Candidate:** \`${receipt.candidateSha}\` on \`${receipt.branch}\``,
    '**Preserved worktree:** recorded durably (local path redacted from API/UI)',
    `**Prior green evidence:** ${evidence}`,
    `**Redacted detail:** ${receipt.detail}`,
    `**Next action:** ${receipt.nextAction}`,
  ].join('\n');
}
