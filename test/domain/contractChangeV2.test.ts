import { describe, expect, it } from 'vitest';
import {
  BRIDGE_OWNER_DECISION_ID,
  BRIDGE_POLICY_DECISION_ID,
  BRIDGED_CONTRACT_PATCH,
  bridgeContractSuccessorCommand,
  bridgeDeliveryId,
} from '../../src/domain/approvalPolicyBridge.js';
import {
  applyApprovedContractChange,
  appendApprovedContractChange,
  assertContractChangeRequest,
  ContractChangeError,
  type ContractChangeRequest,
  type TrustedContractChangeAuthority,
} from '../../src/domain/contractChange.js';
import {
  compileLegacyTaskContract,
  type LegacyTaskContractInput,
} from '../../src/domain/contractCompiler.js';
import { compileM4LegacyContract } from '../../src/domain/shadowProjection.js';
import type { Task } from '../../src/domain/task.js';

function legacyInput(): LegacyTaskContractInput {
  return {
    taskId: 'task-1',
    objective: 'Original objective',
    body: '## DoD\n- [ ] (mechanical) tests pass @gate:test',
    context: [],
    constraints: [],
    forbiddenActions: ['deploy'],
    capabilityPolicy: { version: '1', grants: [] },
    verificationPolicy: {
      version: '1',
      requiredEvidence: ['test'],
      independentEvaluatorRequired: true,
    },
    approvalPolicy: { version: '1', requiredDecisions: [] },
    budgetPolicy: {
      version: '1',
      maxCostUsd: null,
      maxTokens: null,
      maxDurationMs: null,
    },
    createdBy: { kind: 'human', id: 'owner' },
    createdAt: '2026-08-28T00:00:00Z',
  };
}

function request(overrides: Partial<ContractChangeRequest> = {}): ContractChangeRequest {
  return {
    id: 'change-1',
    taskId: 'task-1',
    baseContractVersion: 1,
    requestedBy: { kind: 'human', id: 'owner' },
    reason: 'Clarify the requested outcome',
    proposedPatch: [{ op: 'replace', path: '/objective', value: 'Changed objective' }],
    meaningChange: true,
    riskChange: false,
    status: 'approved',
    policyDecisionId: 'policy-1',
    humanDecisionId: null,
    ...overrides,
  };
}

function trusted(
  overrides: Partial<TrustedContractChangeAuthority> = {},
): TrustedContractChangeAuthority {
  return {
    approvedRequestId: 'change-1',
    policyDecisionId: 'policy-1',
    humanDecisionId: null,
    ...overrides,
  };
}

describe('V2 contract change requests', () => {
  it('applies an approved exact-base semantic patch as one immutable successor', () => {
    const current = compileLegacyTaskContract(legacyInput()).contract;
    const result = applyApprovedContractChange(current, request(), {
      createdBy: { kind: 'control_plane', id: 'contract-change' },
      createdAt: '2026-08-28T01:00:00Z',
    }, trusted());

    expect(result.version).toBe(2);
    expect(result.supersedesVersion).toBe(1);
    expect(result.objective).toBe('Changed objective');
    expect(result.contractHash).not.toBe(current.contractHash);
    expect(current).toEqual(compileLegacyTaskContract(legacyInput()).contract);
  });

  it('supports consecutive exact-base requests without rewriting prior versions', () => {
    const first = compileLegacyTaskContract(legacyInput()).contract;
    const firstHistory = [first] as const;
    const secondHistory = appendApprovedContractChange(firstHistory, request(), {
      createdBy: { kind: 'human', id: 'owner' },
      createdAt: '2026-08-28T01:00:00Z',
    }, trusted());
    const second = secondHistory[1]!;
    const thirdHistory = appendApprovedContractChange(secondHistory, request({
      id: 'change-2',
      baseContractVersion: 2,
      proposedPatch: [{ op: 'replace', path: '/constraints', value: ['remain offline'] }],
    }), {
      createdBy: { kind: 'human', id: 'owner' },
      createdAt: '2026-08-28T02:00:00Z',
    }, trusted({ approvedRequestId: 'change-2' }));
    const third = thirdHistory[2]!;

    expect([first.version, second.version, third.version]).toEqual([1, 2, 3]);
    expect(third.supersedesVersion).toBe(2);
    expect(first.constraints).toEqual([]);
    expect(second.constraints).toEqual([]);
    expect(third.constraints).toEqual(['remain offline']);
    expect(firstHistory).toEqual([first]);
  });

  it('requires approval, a meaning change, and an approval authority binding', () => {
    const current = compileLegacyTaskContract(legacyInput()).contract;
    for (const invalid of [
      request({ status: 'pending' }),
      request({ meaningChange: false }),
      request({ policyDecisionId: null, humanDecisionId: null }),
    ]) {
      expect(() => applyApprovedContractChange(current, invalid, {
        createdBy: { kind: 'human', id: 'owner' },
        createdAt: '2026-08-28T01:00:00Z',
      }, trusted({
        policyDecisionId: invalid.policyDecisionId,
        humanDecisionId: invalid.humanDecisionId,
      }))).toThrow(ContractChangeError);
    }
  });

  it('requires a human decision for a risk-changing request', () => {
    const current = compileLegacyTaskContract(legacyInput()).contract;
    expect(() => applyApprovedContractChange(current, request({ riskChange: true }), {
      createdBy: { kind: 'human', id: 'owner' },
      createdAt: '2026-08-28T01:00:00Z',
    }, trusted())).toThrow('human decision');
  });

  it('rejects task/base mismatches, metadata paths, duplicate paths, and unstable values', () => {
    const current = compileLegacyTaskContract(legacyInput()).contract;
    const invalidRequests: readonly ContractChangeRequest[] = [
      request({ taskId: 'other-task' }),
      request({ baseContractVersion: 2 }),
      request({ proposedPatch: [{ op: 'replace', path: '/createdAt' as '/objective', value: 'x' }] }),
      request({ proposedPatch: [
        { op: 'replace', path: '/objective', value: 'one' },
        { op: 'replace', path: '/objective', value: 'two' },
      ] }),
      request({ proposedPatch: [{ op: 'replace', path: '/objective', value: undefined }] }),
    ];

    for (const invalid of invalidRequests) {
      expect(() => applyApprovedContractChange(current, invalid, {
        createdBy: { kind: 'human', id: 'owner' },
        createdAt: '2026-08-28T01:00:00Z',
      }, trusted())).toThrow(ContractChangeError);
    }
  });

  it('wraps structurally invalid but stable JSON patches as typed change failures', () => {
    const current = compileLegacyTaskContract(legacyInput()).contract;
    for (const [path, value] of [
      ['/acceptanceCriteria', null],
      ['/context', null],
      ['/capabilityPolicy', null],
      ['/verificationPolicy', { version: 'v1', requiredEvidence: null }],
    ] as const) {
      expect(() => applyApprovedContractChange(current, request({
        proposedPatch: [{ op: 'replace', path, value }],
      }), {
        createdBy: { kind: 'human', id: 'owner' },
        createdAt: '2026-08-28T01:00:00Z',
      }, trusted())).toThrow(ContractChangeError);
    }
  });

  it('rejects metadata-only/no-op versions and a forged current contract hash', () => {
    const current = compileLegacyTaskContract(legacyInput()).contract;
    expect(() => applyApprovedContractChange(current, request({
      proposedPatch: [{ op: 'replace', path: '/objective', value: current.objective }],
    }), {
      createdBy: { kind: 'human', id: 'different-author' },
      createdAt: '2027-01-01T00:00:00Z',
    }, trusted())).toThrow('semantic hash');

    expect(() => applyApprovedContractChange(
      { ...current, contractHash: 'sha256:' + 'f'.repeat(64) },
      request(),
      { createdBy: { kind: 'human', id: 'owner' }, createdAt: '2026-08-28T01:00:00Z' },
      trusted(),
    )).toThrow('does not match');
  });

  it('does not trust approval and decision IDs declared only by the request', () => {
    const current = compileLegacyTaskContract(legacyInput()).contract;
    expect(() => applyApprovedContractChange(current, request(), {
      createdBy: { kind: 'human', id: 'owner' },
      createdAt: '2026-08-28T01:00:00Z',
    }, trusted({ policyDecisionId: 'trusted-policy-other' }))).toThrow('trusted approval');
    expect(() => applyApprovedContractChange(current, request(), {
      createdBy: { kind: 'human', id: 'owner' },
      createdAt: '2026-08-28T01:00:00Z',
    }, undefined as unknown as TrustedContractChangeAuthority)).toThrow('authority');
  });

  it('forbids removing, downgrading, or otherwise changing existing criterion authority', () => {
    const source = legacyInput();
    const current = compileLegacyTaskContract({
      ...source,
      body: '## DoD\n- [ ] (human) Owner accepts\n- [ ] (reviewer) Reviewer accepts',
    }).contract;
    const human = current.acceptanceCriteria[0]!;
    const evaluator = current.acceptanceCriteria[1]!;
    const invalidCriteria = [
      [{ ...human, authority: 'mechanical' as const }, evaluator],
      [human, { ...evaluator, required: false }],
      [human],
    ] as const;

    for (const acceptanceCriteria of invalidCriteria) {
      const change = request({
        proposedPatch: [{ op: 'replace', path: '/acceptanceCriteria', value: acceptanceCriteria }],
      });
      expect(() => applyApprovedContractChange(current, change, {
        createdBy: { kind: 'human', id: 'owner' },
        createdAt: '2026-08-28T01:00:00Z',
      }, trusted())).toThrow(/criterion authority|required criterion/);
    }
  });

  it('validates decoded change records before use', () => {
    expect(() => assertContractChangeRequest(null as unknown as ContractChangeRequest)).toThrow(
      ContractChangeError,
    );
    expect(() => assertContractChangeRequest(request({ reason: '' }))).toThrow(
      ContractChangeError,
    );
    const current = compileLegacyTaskContract(legacyInput()).contract;
    expect(() => applyApprovedContractChange(current, request(), {
      createdBy: { kind: 'human', id: '' },
      createdAt: '',
    }, trusted())).toThrow('provenance');
  });

  it('accepts the C3.9 three-part legacy-compat bridge patch with stable criterion ids', () => {
    const m4Task: Task = {
      id: 'task-bridge-v2',
      title: 'Bridge acceptance',
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
      body:
        '## Definition of Done\n' +
        '- [ ] (mechanical) Unit tests pass @test:test/example.test.ts\n' +
        '- [ ] (human) Owner accepts the change\n',
    };
    const current = compileM4LegacyContract(m4Task);
    const mechanical = current.acceptanceCriteria.find(
      (criterion) => criterion.authority === 'mechanical',
    )!;
    expect(mechanical.proofBinding).not.toBeNull();
    const priorIds = current.acceptanceCriteria.map((criterion) => criterion.id);

    const patch = BRIDGED_CONTRACT_PATCH(current);
    expect(patch.map((operation) => operation.path)).toEqual([
      '/approvalPolicy',
      '/verificationPolicy',
      '/acceptanceCriteria',
    ]);
    const patchedCriteria = patch[2]!.value as typeof current.acceptanceCriteria;
    expect(patchedCriteria.map((criterion) => criterion.id)).toEqual(priorIds);
    expect(
      patchedCriteria
        .filter((criterion) => criterion.authority === 'mechanical')
        .every((criterion) => criterion.proofBinding === null),
    ).toBe(true);

    const mutation = bridgeContractSuccessorCommand(bridgeDeliveryId('a'.repeat(40)), [current]);
    expect(mutation.request.meaningChange).toBe(true);
    expect(mutation.request.riskChange).toBe(true);
    expect(mutation.request.humanDecisionId).toBe(BRIDGE_OWNER_DECISION_ID);
    expect(mutation.request.policyDecisionId).toBe(BRIDGE_POLICY_DECISION_ID);
    expect(mutation.request.proposedPatch).toEqual(patch);

    const history = appendApprovedContractChange(
      [current],
      mutation.request,
      mutation.provenance,
      mutation.trustedAuthority,
    );
    expect(history).toHaveLength(2);
    expect(history[1]!.acceptanceCriteria.map((criterion) => criterion.id)).toEqual(priorIds);
    expect(
      history[1]!.acceptanceCriteria.map((criterion) => ({
        id: criterion.id,
        authority: criterion.authority,
        required: criterion.required,
      })),
    ).toEqual(
      current.acceptanceCriteria.map((criterion) => ({
        id: criterion.id,
        authority: criterion.authority,
        required: criterion.required,
      })),
    );
    expect(history[1]!.verificationPolicy).toMatchObject({
      version: 'c3-legacy-compat-v1',
      independentEvaluatorRequired: false,
    });
  });
});
