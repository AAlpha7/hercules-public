/**
 * M9 closed class→route policy (pure lookup).
 *
 * Pure. Imports only from `src/domain/`. Never throws.
 */

import type { FailureClassV1, RouteV1 } from '../domain/repairRouting.js';

/**
 * Closed FailureClassV1 → RouteV1 map (contract rule 6, plus `none`→`complete`
 * for totality — success normally short-circuits before this lookup).
 */
export const CLASS_TO_ROUTE = {
  none: 'complete',
  evidence_gap: 'reverify',
  evidence_conflict: 'request_contract_change',
  contract_unsatisfiable: 'request_contract_change',
  infrastructure_failure: 'platform_remediation',
  human_pending: 'escalate_human',
  unrecognized_failure: 'escalate_human',
  verified_defect: 'repair',
} as const satisfies Readonly<Record<FailureClassV1, RouteV1>>;

/** Special reason codes used by budget / non-reversible guards and success. */
export const ROUTE_REASON_ALL_CRITERIA_PASS = 'all_criteria_pass';
export const ROUTE_REASON_BUDGET_OR_CONVERGENCE = 'budget_or_convergence';
export const ROUTE_REASON_NON_REVERSIBLE_ACTION = 'non_reversible_action';

/** Rationale stamped onto a verified-defect repair proposal. */
export const REPAIR_RATIONALE_CODE = 'verified_defect_repair';

/**
 * Pure class→route lookup. `none` returns `complete` for totality; the router
 * success short-circuit normally handles pass before calling this.
 */
export function routeForClass(failureClass: FailureClassV1): RouteV1 {
  return CLASS_TO_ROUTE[failureClass];
}

/**
 * Default reason-code list for a class-routed decision (sorted-unique singleton).
 * Guard overrides (`budget_or_convergence`, `non_reversible_action`) replace this.
 */
export function reasonCodesForClass(
  failureClass: FailureClassV1,
): readonly string[] {
  if (failureClass === 'none') {
    return [ROUTE_REASON_ALL_CRITERIA_PASS];
  }
  return [failureClass];
}
