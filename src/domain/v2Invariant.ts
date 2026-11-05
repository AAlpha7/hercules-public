export const V2_INVARIANT_CODES = [
  'invalid_contract_history',
  'invalid_iteration_history',
  'invalid_iteration_transition',
  'invalid_stage_history',
  'invalid_stage_transition',
  'invalid_artifact_ref',
  'invalid_candidate_ref',
  'invalid_decision_binding',
  'invalid_evidence_manifest',
  'invalid_evaluation_verdict',
  'invalid_human_decision',
  'stale_decision_binding',
] as const;

export type V2InvariantCode = (typeof V2_INVARIANT_CODES)[number];

export function isRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

export function isStringArray(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || !isNonEmptyString(value[index])) return false;
  }
  return true;
}

export function isUniqueStringArray(value: unknown): value is readonly string[] {
  return isStringArray(value) && new Set(value).size === value.length;
}

export class V2InvariantError extends Error {
  override readonly name = 'V2InvariantError';

  constructor(
    readonly code: V2InvariantCode,
    message: string,
  ) {
    super(message);
  }
}
