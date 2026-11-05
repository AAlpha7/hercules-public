import { canonicalSerialize } from './canonicalJson.js';
import type { TaskContract } from './taskContract.js';
import {
  isNonEmptyString,
  isNullableNonEmptyString,
  isRecord,
  isStringArray,
  V2InvariantError,
} from './v2Invariant.js';

export const ACTOR_KINDS = ['human', 'control_plane', 'agent', 'service'] as const;

export const CRITERION_AUTHORITIES = [
  'mechanical',
  'verifier',
  'evaluator',
  'human',
] as const;

function fail(message: string): never {
  throw new V2InvariantError('invalid_contract_history', message);
}

/** Validate a decoded contract without depending on hashing or executing accessors. */
export function assertTaskContract(contract: TaskContract): void {
  try {
    canonicalSerialize(contract);
  } catch (error) {
    fail(`contract must use stable canonical JSON data: ${String(error)}`);
  }
  if (!isRecord(contract)) {
    fail('contract record must be an object');
  }
  if (
    !isNonEmptyString(contract.taskId) ||
    !isNonEmptyString(contract.contractHash) ||
    !isNonEmptyString(contract.objective) ||
    !isNonEmptyString(contract.createdAt)
  ) {
    fail('contract identities, objective, and createdAt must be non-empty strings');
  }
  if (!Number.isSafeInteger(contract.version) || contract.version < 1) {
    fail(`contract version must be a positive integer: ${contract.version}`);
  }
  if (
    (contract.version === 1 && contract.supersedesVersion !== null) ||
    (contract.version > 1 && contract.supersedesVersion !== contract.version - 1)
  ) {
    fail('contract supersedesVersion must identify the immediately prior version');
  }
  if (
    !Array.isArray(contract.context) ||
    !Array.isArray(contract.acceptanceCriteria) ||
    contract.acceptanceCriteria.length === 0 ||
    !isStringArray(contract.constraints) ||
    !isStringArray(contract.forbiddenActions)
  ) {
    fail('contract context and rule lists must be valid arrays');
  }
  for (const context of contract.context) {
    if (
      !isRecord(context) ||
      !isNonEmptyString(context['kind']) ||
      !isNonEmptyString(context['uri']) ||
      !isNullableNonEmptyString(context['digest'])
    ) {
      fail('contract context refs must carry valid kind, uri, and digest fields');
    }
  }

  const criterionIds = new Set<string>();
  for (const criterion of contract.acceptanceCriteria) {
    const criterionId = isRecord(criterion) ? criterion['id'] : undefined;
    const proofBinding = isRecord(criterion) ? criterion['proofBinding'] : undefined;
    if (
      !isRecord(criterion) ||
      !isNonEmptyString(criterionId) ||
      !isNonEmptyString(criterion['text']) ||
      !(CRITERION_AUTHORITIES as readonly unknown[]).includes(criterion['authority']) ||
      typeof criterion['required'] !== 'boolean' ||
      (proofBinding !== null &&
        (!isRecord(proofBinding) ||
          !isNonEmptyString(proofBinding['proofType']) ||
          !isNonEmptyString(proofBinding['requirement']))) ||
      criterionIds.has(criterionId)
    ) {
      fail(`criterion records must be valid with unique ids: ${String(criterionId ?? '(invalid)')}`);
    }
    criterionIds.add(criterionId);
  }

  if (
    !isRecord(contract.capabilityPolicy) ||
    !isNonEmptyString(contract.capabilityPolicy.version) ||
    !isStringArray(contract.capabilityPolicy.grants) ||
    !isRecord(contract.verificationPolicy) ||
    !isNonEmptyString(contract.verificationPolicy.version) ||
    !isStringArray(contract.verificationPolicy.requiredEvidence) ||
    typeof contract.verificationPolicy.independentEvaluatorRequired !== 'boolean' ||
    !isRecord(contract.approvalPolicy) ||
    !isNonEmptyString(contract.approvalPolicy.version) ||
    !isStringArray(contract.approvalPolicy.requiredDecisions)
  ) {
    fail('contract capability, verification, and approval policies are invalid');
  }
  const budgetValues = [
    contract.budgetPolicy?.maxCostUsd,
    contract.budgetPolicy?.maxTokens,
    contract.budgetPolicy?.maxDurationMs,
  ];
  if (
    !isRecord(contract.budgetPolicy) ||
    !isNonEmptyString(contract.budgetPolicy.version) ||
    budgetValues.some(
      (value) => value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0),
    )
  ) {
    fail('contract budget policy is invalid');
  }
  if (
    !isRecord(contract.createdBy) ||
    !(ACTOR_KINDS as readonly unknown[]).includes(contract.createdBy.kind) ||
    !isNonEmptyString(contract.createdBy.id)
  ) {
    fail('contract creator identity is invalid');
  }
}
