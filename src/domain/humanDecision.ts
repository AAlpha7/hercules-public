import {
  assertDecisionBinding,
  assertDecisionBindingIdentity,
  type DecisionBinding,
} from './evaluationVerdict.js';
import { type ActorRef } from './taskContract.js';
import {
  isNonEmptyString,
  isNullableNonEmptyString,
  isRecord,
  V2InvariantError,
} from './v2Invariant.js';

export const HUMAN_DECISION_KINDS = [
  'approve_outcome',
  'reject_outcome',
  'request_changes',
  'approve_high_risk_action',
  'reject_high_risk_action',
  'approve_contract_change',
  'reject_contract_change',
  'approve_learning_proposal',
  'reject_learning_proposal',
] as const;

export type HumanDecisionKind = (typeof HUMAN_DECISION_KINDS)[number];

export interface HumanDecision {
  readonly id: string;
  readonly binding: DecisionBinding;
  readonly decision: HumanDecisionKind;
  readonly comment: string | null;
  readonly actor: ActorRef;
  readonly createdAt: string;
}

export function assertHumanDecisionBinding(
  decision: HumanDecision,
  expected: DecisionBinding,
): void {
  if (!isRecord(decision)) {
    throw new V2InvariantError(
      'invalid_human_decision',
      'human decision must be an object',
    );
  }
  if (
    !isNonEmptyString(decision.id) ||
    !(HUMAN_DECISION_KINDS as readonly unknown[]).includes(decision.decision) ||
    !isNullableNonEmptyString(decision.comment) ||
    decision.actor === null ||
    typeof decision.actor !== 'object' ||
    decision.actor.kind !== 'human' ||
    !isNonEmptyString(decision.actor.id) ||
    !isNonEmptyString(decision.createdAt)
  ) {
    throw new V2InvariantError(
      'invalid_human_decision',
      'human decision identity, kind, actor, comment, and timing must be valid',
    );
  }
  assertDecisionBindingIdentity(decision.binding);
  const requiresOutcomeBinding =
    decision.decision === 'approve_outcome' ||
    decision.decision === 'reject_outcome' ||
    decision.decision === 'request_changes';
  if (
    requiresOutcomeBinding &&
    (decision.binding.iterationId === null ||
      decision.binding.candidateRef === null ||
      decision.binding.evidenceManifestHash === null)
  ) {
    throw new V2InvariantError(
      'invalid_human_decision',
      `${decision.decision} requires an exact iteration, candidate, and evidence binding`,
    );
  }
  assertDecisionBinding(decision.binding, expected);
}
