/**
 * M9 failure taxonomy — total first-match-wins classification.
 *
 * Pure. Imports only from `src/domain/`. Never throws.
 */

import {
  CONFLICT_REASON_CODES,
  EVALUATOR_INFRASTRUCTURE_REASON_CODES,
  UNSATISFIABLE_REASON_CODES,
  VERIFIED_DEFECT_REASON_CODES,
  type FailureClassV1,
  type QualifiedEvaluationReceiptViewV1,
} from '../domain/repairRouting.js';

function intersects(
  codes: readonly string[],
  closed: readonly string[],
): boolean {
  if (closed.length === 0 || codes.length === 0) {
    return false;
  }
  const set = closed as readonly string[];
  return codes.some((code) => set.includes(code));
}

function everyMemberIn(
  codes: readonly string[],
  closed: readonly string[],
): boolean {
  if (codes.length === 0) {
    return false;
  }
  const set = closed as readonly string[];
  return codes.every((code) => set.includes(code));
}

/**
 * Classify a qualified evaluation receipt view into exactly one FailureClassV1.
 *
 * Ordered cascade (first match wins). Total: never throws.
 */
export function classifyFailure(
  view: QualifiedEvaluationReceiptViewV1,
): FailureClassV1 {
  // 1. Pass short-circuit.
  if (view.outcome === 'pass') {
    return 'none';
  }

  // 2. Evaluator / gate / environment infrastructure.
  if (
    view.evaluatorInfrastructureFailed ||
    intersects(view.outcomeReasonCodes, EVALUATOR_INFRASTRUCTURE_REASON_CODES)
  ) {
    return 'infrastructure_failure';
  }

  // 3. Required human criterion still pending.
  if (view.requiredHumanCriterionPending) {
    return 'human_pending';
  }

  // 4. Evidence outcomes.
  if (view.outcome === 'need_more_evidence') {
    if (intersects(view.outcomeReasonCodes, CONFLICT_REASON_CODES)) {
      return 'evidence_conflict';
    }
    return 'evidence_gap';
  }

  // 5. Fail outcomes (verified defect, unsatisfiable, or unrecognized).
  if (view.outcome === 'fail') {
    if (intersects(view.outcomeReasonCodes, UNSATISFIABLE_REASON_CODES)) {
      return 'contract_unsatisfiable';
    }
    if (everyMemberIn(view.outcomeReasonCodes, VERIFIED_DEFECT_REASON_CODES)) {
      return 'verified_defect';
    }
    return 'unrecognized_failure';
  }

  // Defensive totality for any non-closed outcome shape.
  return 'unrecognized_failure';
}
