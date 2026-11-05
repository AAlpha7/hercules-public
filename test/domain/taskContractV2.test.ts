import { describe, expect, it } from 'vitest';
import {
  appendContractVersion,
  assertContractHistory,
  type TaskContract,
} from '../../src/domain/taskContract.js';
import { computeTaskContractHash } from '../../src/domain/contractHash.js';
import { V2InvariantError } from '../../src/domain/v2Invariant.js';

function contract(version: number, overrides: Partial<TaskContract> = {}): TaskContract {
  const draft: TaskContract = {
    taskId: 'task-1',
    version,
    contractHash: 'pending',
    objective: `Produce a verified outcome v${version}`,
    context: [],
    acceptanceCriteria: [
      {
        id: 'criterion-1',
        text: 'The outcome is proven',
        authority: 'mechanical',
        required: true,
        proofBinding: null,
      },
    ],
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
    createdAt: `2026-08-28T00:00:0${version}Z`,
    supersedesVersion: version === 1 ? null : version - 1,
    ...overrides,
  };
  return {
    ...draft,
    contractHash: overrides.contractHash ?? computeTaskContractHash(draft),
  };
}

describe('V2 task contract history', () => {
  it('appends the verified root without mutating the prior history', () => {
    const first = contract(1);
    const history = [] as const;
    const result = appendContractVersion(history, first);

    expect(result).toEqual([first]);
    expect(history).toEqual([]);
    expect(result).not.toBe(history);
  });

  it('refuses every later version outside the approved change workflow', () => {
    expect(() => appendContractVersion([contract(1)], contract(2))).toThrow(
      'approved contract-change',
    );
  });

  it('requires version 1 as the immutable root', () => {
    expect(() => appendContractVersion([], contract(2))).toThrow(V2InvariantError);
    expect(() =>
      appendContractVersion([], contract(1, { supersedesVersion: 1 })),
    ).toThrow('supersedesVersion');
  });

  it('rejects version overwrite, gaps, and invalid supersession in decoded history', () => {
    expect(() => assertContractHistory([contract(1), contract(1)])).toThrow(
      'already exists',
    );
    expect(() => assertContractHistory([contract(1), contract(3)])).toThrow(
      'contiguous at version 2',
    );
    expect(() => assertContractHistory([
      contract(1),
      contract(2, { supersedesVersion: null }),
    ])).toThrow('supersedesVersion');
  });

  it('rejects a malformed existing version chain before considering the next record', () => {
    expect(() => assertContractHistory([contract(1), contract(3), contract(4)])).toThrow(
      'contiguous at version 2',
    );
  });

  it('rejects identity changes and duplicate semantic hashes', () => {
    expect(() => assertContractHistory([
      contract(1),
      contract(2, { taskId: 'other-task' }),
    ])).toThrow('more than one task identity');
    const first = contract(1);
    expect(() => assertContractHistory([
      first,
      contract(2, { objective: first.objective, contractHash: first.contractHash }),
    ])).toThrow('already exists');
  });

  it('rejects duplicate criterion identities inside a contract version', () => {
    const duplicate = contract(1, {
      acceptanceCriteria: [
        {
          id: 'same',
          text: 'One',
          authority: 'verifier',
          required: true,
          proofBinding: null,
        },
        {
          id: 'same',
          text: 'Two',
          authority: 'human',
          required: true,
          proofBinding: null,
        },
      ],
    });
    expect(() => appendContractVersion([], duplicate)).toThrow('unique');
  });

  it('rejects a contract with no acceptance criteria', () => {
    expect(() =>
      appendContractVersion([], contract(1, { acceptanceCriteria: [] })),
    ).toThrow('valid arrays');
  });

  it('rejects a forged root hash', () => {
    expect(() => appendContractVersion([], contract(1, {
      contractHash: `sha256:${'0'.repeat(64)}`,
    }))).toThrow('does not match');
  });

  it('rejects decoded contracts with invalid scalar identity or criterion authority', () => {
    const numericTaskId = contract(1, { taskId: 42 as unknown as string });
    const bogusAuthority = contract(1, {
      acceptanceCriteria: [
        {
          ...contract(1).acceptanceCriteria[0]!,
          authority: 'bogus' as TaskContract['acceptanceCriteria'][number]['authority'],
        },
      ],
    });

    expect(() => appendContractVersion([], numericTaskId)).toThrow(V2InvariantError);
    expect(() => appendContractVersion([], bogusAuthority)).toThrow(V2InvariantError);
    expect(() =>
      appendContractVersion(
        [],
        contract(1, { supersedesVersion: '1' as unknown as number }),
      ),
    ).toThrow('supersedesVersion');
  });

  it('rejects decoded null records and non-array histories with a typed error', () => {
    expect(() =>
      appendContractVersion(
        null as unknown as readonly TaskContract[],
        contract(1),
      ),
    ).toThrow(V2InvariantError);
    expect(() =>
      appendContractVersion([], null as unknown as TaskContract),
    ).toThrow(V2InvariantError);
  });
});
