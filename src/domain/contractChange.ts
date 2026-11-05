import {
  canonicalClone,
  CanonicalJsonError,
  canonicalSerialize,
} from './canonicalJson.js';
import {
  assertTaskContractHash,
  computeTaskContractHash,
  taskContractSemanticProjection,
  type TaskContractSemanticProjection,
} from './contractHash.js';
import {
  ACTOR_KINDS,
  assertContractHistory,
  assertTaskContract,
  type ActorRef,
  type TaskContract,
} from './taskContract.js';
import {
  isNonEmptyString,
  isNullableNonEmptyString,
  isRecord,
} from './v2Invariant.js';

export const CONTRACT_CHANGE_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'superseded',
] as const;
export type ContractChangeStatus = (typeof CONTRACT_CHANGE_STATUSES)[number];

export const CONTRACT_SEMANTIC_PATHS = [
  '/objective',
  '/context',
  '/acceptanceCriteria',
  '/constraints',
  '/forbiddenActions',
  '/capabilityPolicy',
  '/verificationPolicy',
  '/approvalPolicy',
  '/budgetPolicy',
] as const;
export type ContractSemanticPath = (typeof CONTRACT_SEMANTIC_PATHS)[number];

export interface ContractPatchOperation {
  readonly op: 'replace';
  readonly path: ContractSemanticPath;
  readonly value: unknown;
}

export interface ContractChangeRequest {
  readonly id: string;
  readonly taskId: string;
  readonly baseContractVersion: number;
  readonly requestedBy: ActorRef;
  readonly reason: string;
  readonly proposedPatch: readonly ContractPatchOperation[];
  readonly meaningChange: boolean;
  readonly riskChange: boolean;
  readonly status: ContractChangeStatus;
  readonly policyDecisionId: string | null;
  readonly humanDecisionId: string | null;
}

export interface ContractChangeProvenance {
  readonly createdBy: ActorRef;
  readonly createdAt: string;
}

/** Caller-supplied authority facts from the trusted control plane, never agent input. */
export interface TrustedContractChangeAuthority {
  readonly approvedRequestId: string;
  readonly policyDecisionId: string | null;
  readonly humanDecisionId: string | null;
}

export class ContractChangeError extends Error {
  override readonly name = 'ContractChangeError';
}

function fail(message: string): never {
  throw new ContractChangeError(message);
}

export function assertContractChangeRequest(request: ContractChangeRequest): void {
  try {
    canonicalSerialize(request);
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      fail(`contract change request is not stable JSON: ${error.message}`);
    }
    throw error;
  }
  if (!isRecord(request)) fail('contract change request must be an object');
  if (
    !isNonEmptyString(request.id) ||
    !isNonEmptyString(request.taskId) ||
    !Number.isSafeInteger(request.baseContractVersion) ||
    request.baseContractVersion < 1 ||
    !isNonEmptyString(request.reason) ||
    typeof request.meaningChange !== 'boolean' ||
    typeof request.riskChange !== 'boolean' ||
    !(CONTRACT_CHANGE_STATUSES as readonly unknown[]).includes(request.status) ||
    !isNullableNonEmptyString(request.policyDecisionId) ||
    !isNullableNonEmptyString(request.humanDecisionId)
  ) {
    fail('contract change request identities, state, flags, or bindings are invalid');
  }
  if (
    !isRecord(request.requestedBy) ||
    !(ACTOR_KINDS as readonly unknown[]).includes(request.requestedBy.kind) ||
    !isNonEmptyString(request.requestedBy.id)
  ) {
    fail('contract change requester identity is invalid');
  }
  if (!Array.isArray(request.proposedPatch) || request.proposedPatch.length === 0) {
    fail('contract change request must contain at least one semantic patch');
  }

  const paths = new Set<string>();
  for (let index = 0; index < request.proposedPatch.length; index += 1) {
    if (!(index in request.proposedPatch)) fail('contract change patch array cannot be sparse');
    const operation = request.proposedPatch[index];
    const op = isRecord(operation) ? operation['op'] : null;
    const path = isRecord(operation) ? operation['path'] : null;
    if (
      !isRecord(operation) ||
      op !== 'replace' ||
      typeof path !== 'string' ||
      !(CONTRACT_SEMANTIC_PATHS as readonly string[]).includes(path) ||
      !Object.prototype.hasOwnProperty.call(operation, 'value')
    ) {
      fail(`contract change patch ${index} must replace an approved semantic path`);
    }
    if (paths.has(path)) fail(`contract change path ${path} is duplicated`);
    paths.add(path);
    try {
      canonicalClone(operation['value']);
    } catch (error) {
      if (error instanceof CanonicalJsonError) {
        fail(`contract change path ${path} has unstable value: ${error.message}`);
      }
      throw error;
    }
  }
}

function replaceSemanticPath(
  semantic: TaskContractSemanticProjection,
  operation: ContractPatchOperation,
): TaskContractSemanticProjection {
  const value = canonicalClone(operation.value);
  switch (operation.path) {
    case '/objective':
      return { ...semantic, objective: value as string };
    case '/context':
      return { ...semantic, context: value as TaskContractSemanticProjection['context'] };
    case '/acceptanceCriteria':
      return {
        ...semantic,
        acceptanceCriteria: value as TaskContractSemanticProjection['acceptanceCriteria'],
      };
    case '/constraints':
      return { ...semantic, constraints: value as TaskContractSemanticProjection['constraints'] };
    case '/forbiddenActions':
      return {
        ...semantic,
        forbiddenActions: value as TaskContractSemanticProjection['forbiddenActions'],
      };
    case '/capabilityPolicy':
      return {
        ...semantic,
        capabilityPolicy: value as TaskContractSemanticProjection['capabilityPolicy'],
      };
    case '/verificationPolicy':
      return {
        ...semantic,
        verificationPolicy: value as TaskContractSemanticProjection['verificationPolicy'],
      };
    case '/approvalPolicy':
      return {
        ...semantic,
        approvalPolicy: value as TaskContractSemanticProjection['approvalPolicy'],
      };
    case '/budgetPolicy':
      return {
        ...semantic,
        budgetPolicy: value as TaskContractSemanticProjection['budgetPolicy'],
      };
  }
}

function assertTrustedAuthority(
  request: ContractChangeRequest,
  trusted: TrustedContractChangeAuthority,
): void {
  if (
    !isRecord(trusted) ||
    !isNonEmptyString(trusted.approvedRequestId) ||
    !isNullableNonEmptyString(trusted.policyDecisionId) ||
    !isNullableNonEmptyString(trusted.humanDecisionId)
  ) {
    fail('trusted contract change authority is invalid or absent');
  }
  if (
    trusted.approvedRequestId !== request.id ||
    trusted.policyDecisionId !== request.policyDecisionId ||
    trusted.humanDecisionId !== request.humanDecisionId
  ) {
    fail('contract change self-claims do not match trusted approval authority');
  }
  if (trusted.policyDecisionId === null && trusted.humanDecisionId === null) {
    fail('trusted contract change authority contains no approving decision');
  }
  if (request.riskChange && trusted.humanDecisionId === null) {
    fail('a risk-changing contract request requires a trusted human decision');
  }
}

function assertCriterionAuthorityPreserved(
  current: TaskContract,
  next: TaskContract,
): void {
  const nextById = new Map(next.acceptanceCriteria.map((criterion) => [criterion.id, criterion]));
  for (const criterion of current.acceptanceCriteria) {
    const successor = nextById.get(criterion.id);
    if (!successor) {
      fail(`contract change cannot remove existing criterion authority: ${criterion.id}`);
    }
    if (successor.authority !== criterion.authority) {
      fail(`contract change cannot alter criterion authority: ${criterion.id}`);
    }
    if (criterion.required && !successor.required) {
      fail(`contract change cannot make a required criterion optional: ${criterion.id}`);
    }
  }
}

/** Apply only an approved exact-base semantic request as the next immutable version. */
export function applyApprovedContractChange(
  current: TaskContract,
  request: ContractChangeRequest,
  provenance: ContractChangeProvenance,
  trusted: TrustedContractChangeAuthority,
): TaskContract {
  assertTaskContract(current);
  assertTaskContractHash(current);
  assertContractChangeRequest(request);
  if (
    !isRecord(provenance) ||
    !isRecord(provenance.createdBy) ||
    !(ACTOR_KINDS as readonly unknown[]).includes(provenance.createdBy.kind) ||
    !isNonEmptyString(provenance.createdBy.id) ||
    !isNonEmptyString(provenance.createdAt)
  ) {
    fail('contract change provenance is invalid');
  }
  if (request.taskId !== current.taskId) fail('contract change task identity does not match');
  if (request.baseContractVersion !== current.version) {
    fail('contract change base version does not match the current exact version');
  }
  if (request.status !== 'approved') fail('contract change request is not approved');
  if (!request.meaningChange) fail('a new contract version requires a semantic meaning change');
  assertTrustedAuthority(request, trusted);

  let semantic = canonicalClone(taskContractSemanticProjection(current));
  for (const operation of request.proposedPatch) {
    semantic = replaceSemanticPath(semantic, operation);
  }
  const draft: TaskContract = {
    taskId: current.taskId,
    version: current.version + 1,
    contractHash: 'pending',
    ...semantic,
    createdBy: canonicalClone(provenance.createdBy),
    createdAt: provenance.createdAt,
    supersedesVersion: current.version,
  };
  let next: TaskContract;
  try {
    assertTaskContract(draft);
    next = { ...draft, contractHash: computeTaskContractHash(draft) };
    assertTaskContract(next);
    assertTaskContractHash(next);
  } catch (error) {
    fail(`contract change produced an invalid successor: ${String(error)}`);
  }
  if (next.contractHash === current.contractHash) {
    fail('contract change did not alter the semantic hash');
  }
  assertCriterionAuthorityPreserved(current, next);
  return next;
}

/** Validate history, apply one trusted request, and append without mutating prior versions. */
export function appendApprovedContractChange(
  history: readonly TaskContract[],
  request: ContractChangeRequest,
  provenance: ContractChangeProvenance,
  trusted: TrustedContractChangeAuthority,
): readonly TaskContract[] {
  assertContractHistory(history);
  if (history.length === 0) {
    fail('approved contract changes require an existing root contract');
  }
  const next = applyApprovedContractChange(
    history[history.length - 1]!,
    request,
    provenance,
    trusted,
  );
  return [...history, next];
}
