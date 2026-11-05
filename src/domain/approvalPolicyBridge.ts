import { hashCanonicalJson } from './canonicalJson.js';
import type {
  ContractChangeProvenance,
  ContractChangeRequest,
  ContractPatchOperation,
  TrustedContractChangeAuthority,
} from './contractChange.js';
import type { TaskContract } from './taskContract.js';

/** The owner decision that authorizes this program (ledger `authorization.owner_decision`, 执行 on 2026-09-01). */
export const BRIDGE_OWNER_DECISION_ID = 'owner-decision-2026-09-01-cutover-execute' as const;
export const BRIDGE_DECIDED_AT = '2026-09-01T00:00:00.000Z' as const;
export const BRIDGE_OWNER_ACTOR = { kind: 'human', id: 'hercules-owner' } as const;
export const BRIDGE_TRUSTED_AUTHORITY_ID = 'hercules-cutover-c3-owner-gate' as const;
export const BRIDGE_POLICY_DECISION_ID = 'cutover-c3-approval-policy-bridge-v1' as const;
export const BRIDGED_APPROVAL_POLICY = {
  version: 'c3-approve-outcome-v1',
  requiredDecisions: ['approve_outcome'],
} as const;
export const BRIDGE_DELIVERY_PREFIX = 'bridge-' as const;

/** Owner decision date that authorized the C3.9 legacy-compat successor fields. */
export const BRIDGE_LEGACY_COMPAT_OWNER_DECISION_DATE = '2026-09-05' as const;

export class ApprovalPolicyBridgeError extends Error {
  override readonly name = 'ApprovalPolicyBridgeError';
}

function fail(message: string): never {
  throw new ApprovalPolicyBridgeError(message);
}

/**
 * Pure factory of the C3.9 three-part successor patch from the prior contract.
 * Criterion ids are kept explicitly when nulling mechanical `proofBinding`
 * (compile-time ids hash the full semantic including proofBinding; re-deriving
 * would change the id).
 */
export function BRIDGED_CONTRACT_PATCH(
  current: TaskContract,
): readonly ContractPatchOperation[] {
  return [
    {
      op: 'replace',
      path: '/approvalPolicy',
      value: {
        version: BRIDGED_APPROVAL_POLICY.version,
        requiredDecisions: [...BRIDGED_APPROVAL_POLICY.requiredDecisions],
      },
    },
    {
      op: 'replace',
      path: '/verificationPolicy',
      value: {
        version: 'c3-legacy-compat-v1',
        requiredEvidence: [...current.verificationPolicy.requiredEvidence],
        independentEvaluatorRequired: false,
      },
    },
    {
      op: 'replace',
      path: '/acceptanceCriteria',
      value: current.acceptanceCriteria.map((criterion) =>
        criterion.authority === 'mechanical'
          ? {
              id: criterion.id,
              text: criterion.text,
              authority: criterion.authority,
              required: criterion.required,
              proofBinding: null,
            }
          : criterion,
      ),
    },
  ];
}

/** Deterministic provenance id for one bridge delivery at one authority revision. */
export function bridgeDeliveryId(authorityRevision: string): string {
  return BRIDGE_DELIVERY_PREFIX + hashCanonicalJson({
    schema: 'm4-approval-policy-bridge-delivery/v1',
    ownerDecisionId: BRIDGE_OWNER_DECISION_ID,
    decidedAt: BRIDGE_DECIDED_AT,
    authorityRevision,
  }).slice('sha256:'.length);
}

export function isBridgeDeliveryId(deliveryId: string): boolean {
  return deliveryId.startsWith(BRIDGE_DELIVERY_PREFIX);
}

/**
 * True when the current (last) contract still needs the owner-gated bridge:
 * M4 lock present, independentEvaluatorRequired, or any mechanical criterion
 * still carries a non-null proofBinding.
 */
export function contractNeedsBridge(history: readonly TaskContract[]): boolean {
  const current = history.at(-1);
  if (current === undefined) return false;
  if (current.approvalPolicy.requiredDecisions.includes('owner_database_authority_gate')) {
    return true;
  }
  if (current.verificationPolicy.independentEvaluatorRequired) {
    return true;
  }
  return current.acceptanceCriteria.some(
    (criterion) => criterion.authority === 'mechanical' && criterion.proofBinding !== null,
  );
}

/**
 * PURE factory: the successor command for one task from the provenance id and the
 * replayed prior contract history. Byte-stable.
 */
export function bridgeContractSuccessorCommand(
  deliveryId: string,
  priorContracts: readonly TaskContract[],
): {
  readonly kind: 'append_contract_successor';
  readonly request: ContractChangeRequest;
  readonly provenance: ContractChangeProvenance;
  readonly trustedAuthority: TrustedContractChangeAuthority;
} {
  if (!isBridgeDeliveryId(deliveryId)) {
    fail('bridge successor requires a bridge- provenance delivery id');
  }
  if (!contractNeedsBridge(priorContracts)) {
    fail(
      'bridge successor requires a current contract that still needs the legacy-compat bridge',
    );
  }
  const prior = priorContracts.at(-1)!;
  const baseContractVersion = prior.version;
  const taskId = prior.taskId;
  const requestId = 'bridge-change-' + hashCanonicalJson({
    deliveryId,
    taskId,
    baseContractVersion,
  }).slice('sha256:'.length);
  const request: ContractChangeRequest = {
    id: requestId,
    taskId,
    baseContractVersion,
    requestedBy: BRIDGE_OWNER_ACTOR,
    reason:
      `C3 owner-gated legacy-compat bridge (owner decision ${BRIDGE_LEGACY_COMPAT_OWNER_DECISION_DATE}): ` +
      'owner_database_authority_gate → approve_outcome; ' +
      'independentEvaluatorRequired → false; ' +
      'mechanical proofBinding → null',
    proposedPatch: BRIDGED_CONTRACT_PATCH(prior),
    meaningChange: true,
    riskChange: true,
    status: 'approved',
    policyDecisionId: BRIDGE_POLICY_DECISION_ID,
    humanDecisionId: BRIDGE_OWNER_DECISION_ID,
  };
  const provenance: ContractChangeProvenance = {
    createdBy: BRIDGE_OWNER_ACTOR,
    createdAt: BRIDGE_DECIDED_AT,
  };
  const trustedAuthority: TrustedContractChangeAuthority = {
    approvedRequestId: request.id,
    policyDecisionId: BRIDGE_POLICY_DECISION_ID,
    humanDecisionId: BRIDGE_OWNER_DECISION_ID,
  };
  return {
    kind: 'append_contract_successor',
    request,
    provenance,
    trustedAuthority,
  };
}
