/**
 * Closed sentinel identifiers for a decision binding that has NO persisted
 * evaluation yet (cutover contract §C2.3). `DecisionBinding` requires
 * non-empty evaluator identifiers; nullability was rejected because it would
 * ripple through binding equality, receipt matching, and human-decision
 * staleness for every V1 consumer. These exact values are pinned by test.
 */
export const UNEVALUATED_EVALUATOR_VERSION = 'hercules-unevaluated/v1' as const;
export const UNEVALUATED_EVALUATOR_RUNTIME = 'hercules-unevaluated/v1' as const;
/** `DecisionBinding.evaluatorModel` is already nullable; null is the honest value. */
export const UNEVALUATED_EVALUATOR_MODEL = null;
