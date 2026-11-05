/** Assemble a digest-bound leaf-readiness decision. */
import {
  LEAF_READINESS_CRITIC_VERSION,
  leafReadinessDecisionDigest,
} from './leafReadinessCritic.js';
import type {
  LeafReadinessCheck,
  LeafReadinessDecision,
  LeafReadinessReason,
  LeafReadinessVerdict,
  ProposedInvestigationNode,
} from './leafReadinessCritic.js';

export function makeLeafDecision(input: {
  readonly nodeId: string;
  readonly graphId: string;
  readonly graphDigest: string;
  readonly verdict: LeafReadinessVerdict;
  readonly checks: readonly LeafReadinessCheck[];
  readonly reasons: readonly LeafReadinessReason[];
  readonly proposedInvestigation: ProposedInvestigationNode | null;
}): LeafReadinessDecision {
  const base = {
    version: LEAF_READINESS_CRITIC_VERSION,
    kind: 'leaf_readiness' as const,
    mode: 'advisory' as const,
    verifiedWork: false as const,
    mutatesGraph: false as const,
    authorizesDispatch: false as const,
    nodeId: input.nodeId,
    graphId: input.graphId,
    graphDigest: input.graphDigest,
    verdict: input.verdict,
    checks: input.checks,
    reasons: input.reasons,
    proposedInvestigation: input.proposedInvestigation,
  };
  return { ...base, decisionDigest: leafReadinessDecisionDigest(base) };
}
