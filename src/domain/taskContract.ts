import { V2InvariantError } from './v2Invariant.js';
import { assertTaskContractHash } from './contractHash.js';
import {
  ACTOR_KINDS,
  assertTaskContract,
  CRITERION_AUTHORITIES,
} from './taskContractValidation.js';

export {
  ACTOR_KINDS,
  assertTaskContract,
  CRITERION_AUTHORITIES,
};

export type ActorKind = (typeof ACTOR_KINDS)[number];

export interface ActorRef {
  readonly kind: ActorKind;
  readonly id: string;
}

export interface ContextRef {
  readonly kind: string;
  readonly uri: string;
  readonly digest: string | null;
}

export interface ProofBinding {
  readonly proofType: string;
  readonly requirement: string;
}

export type CriterionAuthority = (typeof CRITERION_AUTHORITIES)[number];

export interface ContractCriterion {
  readonly id: string;
  readonly text: string;
  readonly authority: CriterionAuthority;
  readonly required: boolean;
  readonly proofBinding: ProofBinding | null;
}

export interface CapabilityPolicy {
  readonly version: string;
  readonly grants: readonly string[];
}

export interface VerificationPolicy {
  readonly version: string;
  readonly requiredEvidence: readonly string[];
  readonly independentEvaluatorRequired: boolean;
}

export interface ApprovalPolicy {
  readonly version: string;
  readonly requiredDecisions: readonly string[];
}

export interface BudgetPolicy {
  readonly version: string;
  readonly maxCostUsd: number | null;
  readonly maxTokens: number | null;
  readonly maxDurationMs: number | null;
}

export interface TaskContract {
  readonly taskId: string;
  readonly version: number;
  readonly contractHash: string;
  readonly objective: string;
  readonly context: readonly ContextRef[];
  readonly acceptanceCriteria: readonly ContractCriterion[];
  readonly constraints: readonly string[];
  readonly forbiddenActions: readonly string[];
  readonly capabilityPolicy: CapabilityPolicy;
  readonly verificationPolicy: VerificationPolicy;
  readonly approvalPolicy: ApprovalPolicy;
  readonly budgetPolicy: BudgetPolicy;
  readonly createdBy: ActorRef;
  readonly createdAt: string;
  readonly supersedesVersion: number | null;
}

function failContractHistory(message: string): never {
  throw new V2InvariantError('invalid_contract_history', message);
}

export function assertContractHistory(history: readonly TaskContract[]): void {
  if (!Array.isArray(history)) {
    failContractHistory('contract history must be an array');
  }
  const hashes = new Set<string>();
  let taskId: string | null = null;
  let previous: TaskContract | null = null;
  for (const contract of history) {
    assertTaskContract(contract);
    assertTaskContractHash(contract);
    taskId ??= contract.taskId;
    if (contract.taskId !== taskId) {
      failContractHistory('contract history contains more than one task identity');
    }
    if (hashes.has(contract.contractHash)) {
      failContractHistory(`contract hash ${contract.contractHash} already exists`);
    }
    const expectedVersion = previous === null ? 1 : previous.version + 1;
    const expectedSupersedes = previous?.version ?? null;
    if (
      contract.version !== expectedVersion ||
      contract.supersedesVersion !== expectedSupersedes
    ) {
      failContractHistory(
        `contract history must be contiguous at version ${expectedVersion}`,
      );
    }
    hashes.add(contract.contractHash);
    previous = contract;
  }
}

/** Create only the verified immutable root; successors use contractChange.ts. */
export function appendContractVersion(
  history: readonly TaskContract[],
  next: TaskContract,
): readonly TaskContract[] {
  assertContractHistory(history);
  assertTaskContract(next);
  assertTaskContractHash(next);

  if (history.length === 0) {
    if (next.version !== 1 || next.supersedesVersion !== null) {
      failContractHistory('the first contract must be version 1 and supersede nothing');
    }
    return [next];
  }
  failContractHistory(
    'later contract versions require the approved contract-change append workflow',
  );
}
