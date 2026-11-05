import { describe, expect, it } from 'vitest';
import {
  ApprovalPolicyBridgeError,
  BRIDGE_DECIDED_AT,
  BRIDGE_DELIVERY_PREFIX,
  BRIDGE_LEGACY_COMPAT_OWNER_DECISION_DATE,
  BRIDGE_OWNER_ACTOR,
  BRIDGE_OWNER_DECISION_ID,
  BRIDGE_POLICY_DECISION_ID,
  BRIDGED_APPROVAL_POLICY,
  BRIDGED_CONTRACT_PATCH,
  bridgeContractSuccessorCommand,
  bridgeDeliveryId,
  contractNeedsBridge,
  isBridgeDeliveryId,
} from '../../src/domain/approvalPolicyBridge.js';
import { appendApprovedContractChange } from '../../src/domain/contractChange.js';
import { compileM4LegacyContract } from '../../src/domain/shadowProjection.js';
import { assertContractHistory } from '../../src/domain/taskContract.js';
import type { Task } from '../../src/domain/task.js';

const REVISION = 'a'.repeat(40);

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'M4-BRIDGE',
    title: 'Bridge the M4 approval lock',
    repo: 'app',
    state: 'todo',
    priority: 1,
    blockedBy: [],
    labels: [],
    adapter: null,
    agentSession: null,
    pendingSteer: null,
    attempts: 0,
    lastEventAt: null,
    createdAt: '2026-08-28T00:00:00Z',
    startedAt: null,
    endedAt: null,
    prUrl: null,
    prStatus: null,
    planPending: false,
    verifiedSha: null,
    body: '## Definition of Done\n- [ ] (mechanical) unit tests pass @gate:test',
    ...overrides,
  };
}

describe('C3 approval policy bridge factory', () => {
  it('mints a deterministic bridge delivery id from the pinned owner decision', () => {
    const first = bridgeDeliveryId(REVISION);
    const second = bridgeDeliveryId(REVISION);
    expect(first).toBe(second);
    expect(first.startsWith(BRIDGE_DELIVERY_PREFIX)).toBe(true);
    expect(isBridgeDeliveryId(first)).toBe(true);
    expect(isBridgeDeliveryId('git-' + '0'.repeat(64))).toBe(false);
    expect(bridgeDeliveryId('b'.repeat(40))).not.toBe(first);
  });

  it('detects any of the three legacy-compat bridge conditions on the current contract', () => {
    const root = compileM4LegacyContract(task());
    expect(contractNeedsBridge([root])).toBe(true);
    expect(root.approvalPolicy.requiredDecisions).toContain('owner_database_authority_gate');
    expect(root.verificationPolicy.independentEvaluatorRequired).toBe(true);
    expect(
      root.acceptanceCriteria.some(
        (criterion) => criterion.authority === 'mechanical' && criterion.proofBinding !== null,
      ),
    ).toBe(true);
    expect(contractNeedsBridge([])).toBe(false);

    const deliveryId = bridgeDeliveryId(REVISION);
    const mutation = bridgeContractSuccessorCommand(deliveryId, [root]);
    const bridged = appendApprovedContractChange(
      [root],
      mutation.request,
      mutation.provenance,
      mutation.trustedAuthority,
    );
    expect(contractNeedsBridge(bridged)).toBe(false);
    expect(bridged[1]!.verificationPolicy.independentEvaluatorRequired).toBe(false);
    expect(
      bridged[1]!.acceptanceCriteria
        .filter((criterion) => criterion.authority === 'mechanical')
        .every((criterion) => criterion.proofBinding === null),
    ).toBe(true);
  });

  it('builds a byte-stable three-part successor that appendApprovedContractChange accepts', () => {
    const root = compileM4LegacyContract(task());
    const priorIds = root.acceptanceCriteria.map((criterion) => criterion.id);
    const deliveryId = bridgeDeliveryId(REVISION);
    const first = bridgeContractSuccessorCommand(deliveryId, [root]);
    const second = bridgeContractSuccessorCommand(deliveryId, [root]);
    expect(first).toEqual(second);
    expect(first.request).toMatchObject({
      taskId: root.taskId,
      baseContractVersion: 1,
      requestedBy: BRIDGE_OWNER_ACTOR,
      meaningChange: true,
      riskChange: true,
      status: 'approved',
      policyDecisionId: BRIDGE_POLICY_DECISION_ID,
      humanDecisionId: BRIDGE_OWNER_DECISION_ID,
    });
    expect(first.request.reason).toContain(BRIDGE_LEGACY_COMPAT_OWNER_DECISION_DATE);
    expect(first.request.reason).toContain('approve_outcome');
    expect(first.request.reason).toContain('independentEvaluatorRequired');
    expect(first.request.reason).toContain('proofBinding');
    expect(first.request.proposedPatch).toEqual(BRIDGED_CONTRACT_PATCH(root));
    expect(first.request.proposedPatch).toHaveLength(3);
    expect(first.request.proposedPatch.map((operation) => operation.path)).toEqual([
      '/approvalPolicy',
      '/verificationPolicy',
      '/acceptanceCriteria',
    ]);
    expect(first.provenance).toEqual({
      createdBy: BRIDGE_OWNER_ACTOR,
      createdAt: BRIDGE_DECIDED_AT,
    });
    expect(first.trustedAuthority).toEqual({
      approvedRequestId: first.request.id,
      policyDecisionId: BRIDGE_POLICY_DECISION_ID,
      humanDecisionId: BRIDGE_OWNER_DECISION_ID,
    });

    const history = appendApprovedContractChange(
      [root],
      first.request,
      first.provenance,
      first.trustedAuthority,
    );
    assertContractHistory(history);
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({
      version: 2,
      supersedesVersion: 1,
      approvalPolicy: {
        version: BRIDGED_APPROVAL_POLICY.version,
        requiredDecisions: [...BRIDGED_APPROVAL_POLICY.requiredDecisions],
      },
      verificationPolicy: {
        version: 'c3-legacy-compat-v1',
        independentEvaluatorRequired: false,
        requiredEvidence: root.verificationPolicy.requiredEvidence,
      },
    });
    expect(history[1]!.acceptanceCriteria.map((criterion) => criterion.id)).toEqual(priorIds);
    expect(
      history[1]!.acceptanceCriteria
        .filter((criterion) => criterion.authority === 'mechanical')
        .every((criterion) => criterion.proofBinding === null),
    ).toBe(true);
    expect(
      history[1]!.acceptanceCriteria.map((criterion) => ({
        id: criterion.id,
        authority: criterion.authority,
        required: criterion.required,
      })),
    ).toEqual(
      root.acceptanceCriteria.map((criterion) => ({
        id: criterion.id,
        authority: criterion.authority,
        required: criterion.required,
      })),
    );

    const again = appendApprovedContractChange(
      [root],
      second.request,
      second.provenance,
      second.trustedAuthority,
    );
    expect(again[1]!.contractHash).toBe(history[1]!.contractHash);
  });

  it('refuses non-bridge provenance and unlocked histories', () => {
    const root = compileM4LegacyContract(task());
    expect(() => bridgeContractSuccessorCommand('git-not-a-bridge', [root]))
      .toThrow(ApprovalPolicyBridgeError);
    const deliveryId = bridgeDeliveryId(REVISION);
    const mutation = bridgeContractSuccessorCommand(deliveryId, [root]);
    const bridged = appendApprovedContractChange(
      [root],
      mutation.request,
      mutation.provenance,
      mutation.trustedAuthority,
    );
    expect(() => bridgeContractSuccessorCommand(deliveryId, bridged))
      .toThrow(ApprovalPolicyBridgeError);
  });
});
