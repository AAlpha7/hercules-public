import {
  BRIDGE_DECIDED_AT,
  BRIDGE_OWNER_ACTOR,
  bridgeContractSuccessorCommand,
  bridgeDeliveryId,
  contractNeedsBridge,
} from './approvalPolicyBridge.js';
import { canonicalClone, hashCanonicalJson } from './canonicalJson.js';
import { appendApprovedContractChange } from './contractChange.js';
import type {
  ContractChangeProvenance,
  ContractChangeRequest,
  TrustedContractChangeAuthority,
} from './contractChange.js';
import { compileLegacyTaskContract } from './contractCompiler.js';
import { transitionIteration, type Iteration, type IterationState } from './iteration.js';
import type { Task } from './task.js';
import type { ActorRef, TaskContract } from './taskContract.js';

export type LegacyProjectionMutation =
  | { readonly kind: 'insert_contract_root'; readonly contract: TaskContract }
  | {
      readonly kind: 'append_contract_successor';
      readonly request: ContractChangeRequest;
      readonly provenance: ContractChangeProvenance;
      readonly trustedAuthority: TrustedContractChangeAuthority;
    }
  | { readonly kind: 'put_iteration'; readonly iteration: Iteration }
  | { readonly kind: 'retire_task'; readonly taskId: string; readonly revision: string };

export interface LegacyProjectionCommand {
  readonly idempotencyKey: string;
  readonly event: {
    readonly eventId: string;
    readonly actor: ActorRef;
    readonly occurredAt: string;
  };
  readonly mutation: LegacyProjectionMutation;
}

export interface ExistingShadowProjection {
  readonly contracts: readonly TaskContract[];
  readonly iterations: readonly Iteration[];
  readonly retirement: { readonly taskId: string; readonly revision: string } | null;
}

export const SHADOW_GAP_CODES = [
  'candidate_missing',
  'candidate_mismatch',
  'contract_change_requires_trusted_authority',
  'evidence_verdict_deferred',
  'iteration_state_mismatch',
  'pre_activation_history_missing',
  'retired_task_resurrection',
] as const;

export type ShadowGapCode = (typeof SHADOW_GAP_CODES)[number];

export interface LegacyTaskProjection {
  readonly taskId: string;
  readonly commands: readonly LegacyProjectionCommand[];
  readonly gapCodes: readonly ShadowGapCode[];
  readonly expectedContract: TaskContract;
  readonly expectedIterations: readonly Iteration[];
  readonly expectedDigest: string;
}

const EXACT_GIT_REVISION = /^[0-9a-f]{40}$/;

function stableId(kind: string, revision: string, taskId: string, value: unknown): string {
  return `${kind}-${hashCanonicalJson({ schema: 'm4-shadow-id-v1', revision, taskId, value })
    .slice('sha256:'.length)}`;
}

function eventTime(task: Task, revision: string): string {
  return task.lastEventAt ?? task.endedAt ?? task.startedAt ?? task.createdAt ??
    `git-revision:${revision}`;
}

export function compileM4LegacyContract(task: Task): TaskContract {
  return compileLegacyTaskContract({
    taskId: task.id,
    objective: task.title,
    body: task.body,
    context: [
      { kind: 'control-task', uri: `control-task:${task.id}`, digest: null },
      { kind: 'repository', uri: `repository:${task.repo}`, digest: null },
    ],
    constraints: [
      'legacy Git and Markdown remain authoritative',
      'V2 state is shadow-only and cannot authorize cutover',
    ],
    forbiddenActions: ['deploy', 'authority cutover', 'unbound external writes'],
    capabilityPolicy: {
      version: 'm4-legacy-bridge-v1',
      grants: ['read_control_task', 'write_shadow_projection'],
    },
    verificationPolicy: {
      version: 'm4-legacy-bridge-v1',
      requiredEvidence: ['authoritative_git_revision', 'deterministic_projection_parity'],
      independentEvaluatorRequired: true,
    },
    approvalPolicy: {
      version: 'm4-legacy-bridge-v1',
      requiredDecisions: ['owner_database_authority_gate'],
    },
    budgetPolicy: {
      version: 'm4-legacy-bridge-v1',
      maxCostUsd: null,
      maxTokens: null,
      maxDurationMs: null,
    },
    createdBy: { kind: 'control_plane', id: 'legacy-shadow-projector' },
    createdAt: task.createdAt ?? 'legacy-created-at-unknown',
  }).contract;
}

function baseIteration(
  task: Task,
  revision: string,
  ordinal = 1,
  contractVersion = 1,
): Iteration {
  const createdAt = ordinal === 1
    ? task.createdAt ?? 'legacy-created-at-unknown'
    : task.lastEventAt ?? task.endedAt ?? `git-revision:${revision}`;
  return {
    id: stableId('iteration', revision, task.id, { ordinal }),
    taskId: task.id,
    contractVersion,
    ordinal,
    state: 'planned',
    candidateRef: null,
    evidenceManifestId: null,
    finalVerdictId: null,
    createdAt,
    endedAt: null,
    supersedesIterationId: null,
  };
}

function transition(
  current: Iteration,
  state: IterationState,
  task: Task,
  revision: string,
): Iteration {
  const terminal = state === 'failed' || state === 'abandoned';
  const candidateRef = state === 'verifying'
    ? { kind: 'git' as const, repository: task.repo, revision: task.verifiedSha! }
    : current.candidateRef;
  return transitionIteration(
    current,
    state,
    terminal ? (task.endedAt ?? task.lastEventAt ?? `git-revision:${revision}`) : null,
    {
      candidateRef,
      evidenceManifestId: null,
      finalVerdictId: null,
    },
  );
}

function iterationPlan(
  task: Task,
  revision: string,
  existing: readonly Iteration[],
  contractVersion: number,
): { readonly values: readonly Iteration[]; readonly gaps: readonly ShadowGapCode[] } {
  if (existing.length === 0 && task.attempts > 0) {
    return { values: [], gaps: ['pre_activation_history_missing'] };
  }
  const values: Iteration[] = [];
  let current = existing.at(-1) ?? baseIteration(task, revision, 1, contractVersion);
  if (existing.length === 0) values.push(current);
  const advance = (state: IterationState): void => {
    if (current.state === state) return;
    current = transition(current, state, task, revision);
    values.push(current);
  };
  const gaps: ShadowGapCode[] = [];
  const ensureExecuting = (): void => {
    if (current.state === 'planned') advance('executing');
  };
  const mismatchUnless = (states: readonly IterationState[]): boolean => {
    if (states.includes(current.state)) return false;
    gaps.push('iteration_state_mismatch');
    return true;
  };

  switch (task.state) {
    case 'todo':
      mismatchUnless(['planned']);
      break;
    case 'in_progress':
      if (!mismatchUnless(['planned', 'executing'])) ensureExecuting();
      break;
    case 'review':
      if (mismatchUnless(['planned', 'executing', 'verifying'])) break;
      ensureExecuting();
      if (typeof task.verifiedSha === 'string' && EXACT_GIT_REVISION.test(task.verifiedSha)) {
        if (current.state === 'executing') advance('verifying');
        else if (current.candidateRef?.kind !== 'git' ||
                 current.candidateRef.repository !== task.repo ||
                 current.candidateRef.revision !== task.verifiedSha) {
          gaps.push('candidate_mismatch');
        }
      } else {
        gaps.push('candidate_missing');
      }
      break;
    case 'retrying': {
      if (current.state === 'planned' && current.ordinal > 1) break;
      if (mismatchUnless(['planned', 'executing', 'verifying', 'evaluating', 'failed'])) break;
      ensureExecuting();
      if (current.state !== 'failed') advance('failed');
      const next: Iteration = {
        ...baseIteration(task, revision, current.ordinal + 1, contractVersion),
        supersedesIterationId: current.id,
      };
      current = next;
      values.push(next);
      break;
    }
    case 'failed':
      if (mismatchUnless(['planned', 'executing', 'verifying', 'evaluating', 'failed'])) break;
      ensureExecuting();
      if (current.state !== 'failed') advance('failed');
      break;
    case 'cancelled':
    case 'deleted':
      if (mismatchUnless(['planned', 'executing', 'verifying', 'evaluating', 'abandoned'])) break;
      if (current.state !== 'abandoned') advance('abandoned');
      break;
    case 'done':
      gaps.push('evidence_verdict_deferred');
      break;
  }
  return { values, gaps };
}

function commandFor(
  task: Task,
  revision: string,
  operation: string,
  mutation: LegacyProjectionMutation,
): LegacyProjectionCommand {
  const identity = stableId('projection', revision, task.id, { operation, mutation });
  return {
    idempotencyKey: identity,
    event: {
      eventId: stableId('event', revision, task.id, { operation, mutation }),
      actor: { kind: 'control_plane', id: 'legacy-shadow-projector' },
      occurredAt: eventTime(task, revision),
    },
    mutation,
  };
}

/** Owner-gated bridge successor with pinned identities (new-root and resume share this). */
function pushBridgeSuccessor(
  commands: LegacyProjectionCommand[],
  taskId: string,
  authorityRevision: string,
  priorContracts: readonly TaskContract[],
): number {
  const mutation = bridgeContractSuccessorCommand(
    bridgeDeliveryId(authorityRevision),
    priorContracts,
  );
  commands.push({
    idempotencyKey: stableId('projection', authorityRevision, taskId, {
      operation: 'contract-successor',
      mutation,
    }),
    event: {
      eventId: stableId('event', authorityRevision, taskId, {
        operation: 'contract-successor',
        mutation,
      }),
      actor: BRIDGE_OWNER_ACTOR,
      occurredAt: BRIDGE_DECIDED_AT,
    },
    mutation,
  });
  const bridged = appendApprovedContractChange(
    priorContracts,
    mutation.request,
    mutation.provenance,
    mutation.trustedAuthority,
  );
  return bridged.at(-1)!.version;
}

/**
 * Project a legacy control-plane task into shadow commands.
 *
 * `options.bridgeActive` (default false): once at least one `bridge-` envelope
 * exists in projection history, a newly inserted root (`existing === null`) is
 * immediately followed by the owner-gated bridge successor
 * (`bridgeContractSuccessorCommand(bridgeDeliveryId(authorityRevision), [root])`)
 * and its first iteration binds `contractVersion` 2 — so post-bridge tasks are
 * decision-eligible without waiting for a retry.
 *
 * Resume: when `existing` already has the root (hash matches) but still needs
 * the bridge, the same successor is emitted so a partial triple interrupted at
 * a 256-command batch boundary replays byte-identically from the suffix.
 */
export function projectLegacyTask(
  task: Task,
  authorityRevision: string,
  existing: ExistingShadowProjection | null,
  options: { readonly bridgeActive?: boolean } = {},
): LegacyTaskProjection {
  if (!EXACT_GIT_REVISION.test(authorityRevision)) {
    throw new TypeError('authority revision must be an exact lowercase Git SHA');
  }
  const bridgeActive = options.bridgeActive === true;
  const contract = compileM4LegacyContract(task);
  const commands: LegacyProjectionCommand[] = [];
  const gaps: ShadowGapCode[] = [];
  let contractVersion = existing?.contracts.at(-1)?.version ?? 1;
  if (existing?.retirement !== null && existing !== null) {
    gaps.push('retired_task_resurrection');
  } else if (existing === null) {
    commands.push(commandFor(task, authorityRevision, 'contract-root', {
      kind: 'insert_contract_root',
      contract,
    }));
    if (bridgeActive) {
      contractVersion = pushBridgeSuccessor(
        commands, task.id, authorityRevision, [contract],
      );
    }
  } else if (existing.contracts[0]?.contractHash !== contract.contractHash) {
    gaps.push('contract_change_requires_trusted_authority');
  } else if (
    bridgeActive &&
    existing.retirement === null &&
    contractNeedsBridge(existing.contracts)
  ) {
    contractVersion = pushBridgeSuccessor(
      commands, task.id, authorityRevision, existing.contracts,
    );
  }

  const plan = iterationPlan(
    task, authorityRevision, existing?.iterations ?? [], contractVersion,
  );
  gaps.push(...plan.gaps);
  if (!gaps.includes('retired_task_resurrection') &&
      !gaps.includes('contract_change_requires_trusted_authority')) {
    for (const iteration of plan.values) {
      commands.push(commandFor(task, authorityRevision, `iteration-${iteration.ordinal}-${iteration.state}`, {
        kind: 'put_iteration',
        iteration,
      }));
    }
  }
  const gapCodes = [...new Set(gaps)].sort() as ShadowGapCode[];
  const iterationsById = new Map(
    (existing?.iterations ?? []).map((iteration) => [iteration.id, iteration]),
  );
  for (const iteration of plan.values) iterationsById.set(iteration.id, iteration);
  const expectedIterations = [...iterationsById.values()].sort((left, right) =>
    left.ordinal - right.ordinal);
  const expectedDigest = hashCanonicalJson({
    schema: 'm4-shadow-expected-v1',
    taskId: task.id,
    contractHash: contract.contractHash,
    iterations: expectedIterations,
    gaps: gapCodes,
    manifest: commands.map((command) => ({
      idempotencyKey: command.idempotencyKey,
      commandDigest: hashCanonicalJson(command),
    })),
  });
  return canonicalClone({
    taskId: task.id,
    commands,
    gapCodes,
    expectedContract: contract,
    expectedIterations,
    expectedDigest,
  });
}

export function retirementCommand(
  taskId: string,
  authorityRevision: string,
): LegacyProjectionCommand {
  if (!EXACT_GIT_REVISION.test(authorityRevision)) {
    throw new TypeError('authority revision must be an exact lowercase Git SHA');
  }
  const identity = stableId('projection', authorityRevision, taskId, { operation: 'retire' });
  return {
    idempotencyKey: identity,
    event: {
      eventId: stableId('event', authorityRevision, taskId, { operation: 'retire' }),
      actor: { kind: 'control_plane', id: 'legacy-shadow-projector' },
      occurredAt: `git-revision:${authorityRevision}`,
    },
    mutation: { kind: 'retire_task', taskId, revision: authorityRevision },
  };
}
