import type {
  ApprovalPolicy,
  BudgetPolicy,
  CapabilityPolicy,
  ContextRef,
  ContractCriterion,
  TaskContract,
  VerificationPolicy,
} from './taskContract.js';
import {
  CanonicalJsonError,
  canonicalSerialize,
  hashCanonicalJson,
} from './canonicalJson.js';
import { assertTaskContract } from './taskContractValidation.js';

export const TASK_CONTRACT_HASH_RE = /^sha256:[0-9a-f]{64}$/;

export interface TaskContractSemanticProjection {
  readonly objective: string;
  readonly context: readonly ContextRef[];
  readonly acceptanceCriteria: readonly ContractCriterion[];
  readonly constraints: readonly string[];
  readonly forbiddenActions: readonly string[];
  readonly capabilityPolicy: CapabilityPolicy;
  readonly verificationPolicy: VerificationPolicy;
  readonly approvalPolicy: ApprovalPolicy;
  readonly budgetPolicy: BudgetPolicy;
}

export class ContractHashError extends Error {
  override readonly name = 'ContractHashError';
}

function assertStableContractInput(contract: unknown): asserts contract is TaskContract {
  if (contract === null || typeof contract !== 'object' || Array.isArray(contract)) {
    throw new ContractHashError('task contract hash input must be a stable record');
  }
  try {
    canonicalSerialize(contract);
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      throw new ContractHashError(`task contract hash input is not stable JSON: ${error.message}`);
    }
    throw new ContractHashError(`task contract hash input could not be inspected: ${String(error)}`);
  }
}

/** Excludes provenance and task/version binding facts from semantic identity. */
export function taskContractSemanticProjection(
  contract: TaskContract,
): TaskContractSemanticProjection {
  assertStableContractInput(contract);
  try {
    return {
      objective: contract.objective,
      context: contract.context.map((context) => ({
        kind: context.kind,
        uri: context.uri,
        digest: context.digest,
      })),
      acceptanceCriteria: contract.acceptanceCriteria.map((criterion) => ({
        id: criterion.id,
        text: criterion.text,
        authority: criterion.authority,
        required: criterion.required,
        proofBinding: criterion.proofBinding === null
          ? null
          : {
              proofType: criterion.proofBinding.proofType,
              requirement: criterion.proofBinding.requirement,
            },
      })),
      constraints: [...contract.constraints],
      forbiddenActions: [...contract.forbiddenActions],
      capabilityPolicy: {
        version: contract.capabilityPolicy.version,
        grants: [...contract.capabilityPolicy.grants],
      },
      verificationPolicy: {
        version: contract.verificationPolicy.version,
        requiredEvidence: [...contract.verificationPolicy.requiredEvidence],
        independentEvaluatorRequired: contract.verificationPolicy.independentEvaluatorRequired,
      },
      approvalPolicy: {
        version: contract.approvalPolicy.version,
        requiredDecisions: [...contract.approvalPolicy.requiredDecisions],
      },
      budgetPolicy: {
        version: contract.budgetPolicy.version,
        maxCostUsd: contract.budgetPolicy.maxCostUsd,
        maxTokens: contract.budgetPolicy.maxTokens,
        maxDurationMs: contract.budgetPolicy.maxDurationMs,
      },
    };
  } catch (error) {
    throw new ContractHashError(`task contract semantic projection is invalid: ${String(error)}`);
  }
}

export function computeTaskContractHash(contract: TaskContract): string {
  return hashCanonicalJson(taskContractSemanticProjection(contract));
}

export function assertTaskContractHash(contract: TaskContract): void {
  try {
    assertTaskContract(contract);
  } catch (error) {
    throw new ContractHashError(`task contract structure is invalid: ${String(error)}`);
  }
  if (!TASK_CONTRACT_HASH_RE.test(contract.contractHash)) {
    throw new ContractHashError(
      'task contract hash must use sha256:<64 lowercase hexadecimal characters>',
    );
  }
  const expected = computeTaskContractHash(contract);
  if (contract.contractHash !== expected) {
    throw new ContractHashError(
      `task contract hash does not match semantic content: expected ${expected}`,
    );
  }
}
