import { describe, expect, it } from 'vitest';
import {
  bridgeContractSuccessorCommand,
  bridgeDeliveryId,
} from '../../src/domain/approvalPolicyBridge.js';
import { hashCanonicalJson } from '../../src/domain/canonicalJson.js';
import { appendApprovedContractChange } from '../../src/domain/contractChange.js';
import { appendIteration, transitionIteration } from '../../src/domain/iteration.js';
import type { Task } from '../../src/domain/task.js';
import type { TaskContract } from '../../src/domain/taskContract.js';
import {
  projectLegacyTask,
  retirementCommand,
} from '../../src/domain/shadowProjection.js';

const REVISION = 'a'.repeat(40);

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'M4-1',
    title: 'Project legacy task honestly',
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

function projectedState(
  projection: ReturnType<typeof projectLegacyTask>,
  contracts?: readonly TaskContract[],
) {
  return {
    contracts: contracts ?? [projection.expectedContract],
    iterations: projection.expectedIterations,
    retirement: null,
  };
}

function bridgeContracts(root: TaskContract): readonly TaskContract[] {
  const mutation = bridgeContractSuccessorCommand(bridgeDeliveryId(REVISION), [root]);
  return appendApprovedContractChange(
    [root],
    mutation.request,
    mutation.provenance,
    mutation.trustedAuthority,
  );
}

describe('M4 legacy shadow projection', () => {
  it('compiles a conservative immutable root and planned first iteration', () => {
    const projection = projectLegacyTask(task(), REVISION, null);
    expect(projection.gapCodes).toEqual([]);
    expect(projection.commands.map((item) => item.mutation.kind)).toEqual([
      'insert_contract_root',
      'put_iteration',
    ]);
    expect(projection.expectedContract).toMatchObject({
      taskId: 'M4-1',
      createdBy: { kind: 'control_plane', id: 'legacy-shadow-projector' },
      budgetPolicy: { maxCostUsd: null, maxTokens: null, maxDurationMs: null },
    });
    expect(projection.expectedIterations).toMatchObject([{ ordinal: 1, state: 'planned' }]);
  });

  it('advances only through legal observed lifecycle facts', () => {
    const planned = projectLegacyTask(task(), REVISION, null);
    const executing = projectLegacyTask(
      task({ state: 'in_progress', attempts: 1, startedAt: '2026-08-28T00:01:00Z' }),
      'b'.repeat(40),
      projectedState(planned),
    );
    expect(executing.commands).toHaveLength(1);
    expect(executing.expectedIterations.at(-1)?.state).toBe('executing');

    const review = projectLegacyTask(
      task({ state: 'review', attempts: 1, verifiedSha: 'c'.repeat(40) }),
      'c'.repeat(40),
      projectedState(executing),
    );
    expect(review.gapCodes).toEqual([]);
    expect(review.expectedIterations.at(-1)).toMatchObject({
      state: 'verifying',
      candidateRef: { kind: 'git', repository: 'app', revision: 'c'.repeat(40) },
    });
    const wrongCandidate = projectLegacyTask(
      task({ state: 'review', attempts: 1, verifiedSha: 'd'.repeat(40) }),
      'd'.repeat(40),
      projectedState(review),
    );
    expect(wrongCandidate.gapCodes).toEqual(['candidate_mismatch']);
    const regressed = projectLegacyTask(task(), 'e'.repeat(40), projectedState(executing));
    expect(regressed.gapCodes).toEqual(['iteration_state_mismatch']);
  });

  it('reports missing candidate, deferred evidence, and omitted history without invention', () => {
    const planned = projectLegacyTask(task(), REVISION, null);
    const missing = projectLegacyTask(
      task({ state: 'review', attempts: 0 }), 'b'.repeat(40), projectedState(planned),
    );
    expect(missing.gapCodes).toEqual(['candidate_missing']);
    expect(missing.expectedIterations.at(-1)?.state).toBe('executing');
    expect(missing.expectedIterations.at(-1)?.candidateRef).toBeNull();

    const done = projectLegacyTask(
      task({ state: 'done', attempts: 0 }), 'b'.repeat(40), projectedState(planned),
    );
    expect(done.gapCodes).toEqual(['evidence_verdict_deferred']);
    expect(done.expectedIterations.at(-1)).toMatchObject({
      state: 'planned',
      evidenceManifestId: null,
      finalVerdictId: null,
    });

    const old = projectLegacyTask(task({ state: 'failed', attempts: 3 }), REVISION, null);
    expect(old.gapCodes).toEqual(['pre_activation_history_missing']);
    expect(old.expectedIterations).toEqual([]);
  });

  it('binds retry iteration creation to the retry event instead of task creation', () => {
    const planned = projectLegacyTask(task(), REVISION, null);
    const first = projectLegacyTask(task({
      state: 'in_progress', attempts: 0, startedAt: '2026-08-28T00:01:00Z',
    }), 'b'.repeat(40), projectedState(planned));
    const retryAt = '2026-08-28T00:05:00Z';
    const retry = projectLegacyTask(task({
      state: 'retrying',
      attempts: 1,
      lastEventAt: retryAt,
      endedAt: retryAt,
    }), 'c'.repeat(40), projectedState(first));
    expect(retry.expectedIterations.at(-1)).toMatchObject({
      ordinal: 2,
      state: 'planned',
      createdAt: retryAt,
    });
    expect(retry.expectedIterations.at(-1)?.createdAt).not.toBe(task().createdAt);
  });

  it('detects semantic contract drift and retired identity resurrection', () => {
    const original = projectLegacyTask(task(), REVISION, null);
    const changed = projectLegacyTask(
      task({ title: 'Changed meaning' }),
      'b'.repeat(40),
      projectedState(original),
    );
    expect(changed.gapCodes).toContain('contract_change_requires_trusted_authority');
    expect(changed.commands).toEqual([]);

    const retired = projectLegacyTask(task(), 'c'.repeat(40), {
      ...projectedState(original),
      retirement: { taskId: 'M4-1', revision: 'b'.repeat(40) },
    });
    expect(retired.gapCodes).toContain('retired_task_resurrection');
    expect(retired.commands).toEqual([]);
  });

  it('is unchanged by fields excluded from the M4 projection contract', () => {
    const base = projectLegacyTask(task(), REVISION, null);
    const excluded = projectLegacyTask(task({
      priority: 999,
      blockedBy: ['OTHER'],
      labels: ['changed'],
      adapter: 'codex',
      agentSession: 'session',
      pendingSteer: 'steer',
      prUrl: 'https://example.test/pr/1',
      prStatus: 'open',
      planPending: true,
    }), REVISION, null);
    expect(excluded.expectedDigest).toBe(base.expectedDigest);
    expect(excluded.commands).toEqual(base.commands);
  });

  it('derives a deterministic retirement command bound to exact authority', () => {
    expect(retirementCommand('M4-1', REVISION)).toEqual(retirementCommand('M4-1', REVISION));
    expect(retirementCommand('M4-1', REVISION).mutation).toEqual({
      kind: 'retire_task',
      taskId: 'M4-1',
      revision: REVISION,
    });
  });

  it('rejects non-40-character or non-lowercase authority revisions at the domain boundary', () => {
    const planned = projectLegacyTask(task(), REVISION, null);
    for (const revision of [
      'a'.repeat(39),
      'a'.repeat(41),
      'a'.repeat(64),
      'A'.repeat(40),
    ]) {
      expect(() => projectLegacyTask(task(), revision, null)).toThrow(
        'authority revision must be an exact lowercase Git SHA',
      );
      expect(() => retirementCommand('M4-1', revision)).toThrow(
        'authority revision must be an exact lowercase Git SHA',
      );
      const invalidCandidate = projectLegacyTask(task({
        state: 'review',
        attempts: 1,
        verifiedSha: revision,
      }), 'b'.repeat(40), projectedState(planned));
      expect(invalidCandidate.gapCodes).toEqual(['candidate_missing']);
      expect(invalidCandidate.expectedIterations.at(-1)?.candidateRef).toBeNull();
    }
  });

  it('binds new retry ordinals to the current contract version after a bridge', () => {
    const planned = projectLegacyTask(task(), REVISION, null);
    expect(planned.expectedIterations[0]?.contractVersion).toBe(1);
    const executing = projectLegacyTask(
      task({ state: 'in_progress', attempts: 0, startedAt: '2026-08-28T00:01:00Z' }),
      'b'.repeat(40),
      projectedState(planned),
    );
    const bridged = bridgeContracts(planned.expectedContract);
    expect(bridged[1]?.version).toBe(2);

    const inFlight = projectLegacyTask(
      task({
        state: 'in_progress',
        attempts: 0,
        startedAt: '2026-08-28T00:01:00Z',
        lastEventAt: '2026-08-28T00:01:00Z',
      }),
      'c'.repeat(40),
      projectedState(executing, bridged),
    );
    expect(inFlight.expectedIterations.at(-1)).toMatchObject({
      ordinal: 1,
      contractVersion: 1,
      state: 'executing',
    });
    expect(() => transitionIteration(
      inFlight.expectedIterations.at(-1)!,
      'executing',
      null,
    )).not.toThrow();

    const retryAt = '2026-08-28T00:05:00Z';
    const retry = projectLegacyTask(task({
      state: 'retrying',
      attempts: 1,
      lastEventAt: retryAt,
      endedAt: retryAt,
    }), 'd'.repeat(40), projectedState(executing, bridged));
    expect(retry.gapCodes).toEqual([]);
    expect(retry.expectedIterations.at(-1)).toMatchObject({
      ordinal: 2,
      state: 'planned',
      contractVersion: 2,
      createdAt: retryAt,
    });
    expect(retry.expectedIterations[0]?.contractVersion).toBe(1);
    expect(() => appendIteration(
      retry.expectedIterations.slice(0, -1),
      retry.expectedIterations.at(-1)!,
    )).not.toThrow();

    const rootStillAgrees = projectLegacyTask(
      task(),
      'e'.repeat(40),
      {
        contracts: bridged,
        iterations: retry.expectedIterations,
        retirement: null,
      },
    );
    expect(rootStillAgrees.gapCodes).not.toContain('contract_change_requires_trusted_authority');
    expect(rootStillAgrees.expectedDigest).toBe(
      projectLegacyTask(task(), 'e'.repeat(40), {
        contracts: bridged,
        iterations: retry.expectedIterations,
        retirement: null,
      }).expectedDigest,
    );
  });

  it('keeps expectedDigest stable for untouched tasks after unrelated bridge history', () => {
    const base = projectLegacyTask(task(), REVISION, null);
    const withRoot = projectLegacyTask(task(), REVISION, projectedState(base));
    const bridged = bridgeContracts(base.expectedContract);
    const withBridge = projectLegacyTask(task(), REVISION, {
      contracts: bridged,
      iterations: base.expectedIterations,
      retirement: null,
    });
    expect(withBridge.expectedDigest).toBe(withRoot.expectedDigest);
    expect(withBridge.commands).toEqual([]);
    expect(withBridge.gapCodes).toEqual([]);
  });

  it('emits bridge successor + v2 iteration for a new root when bridgeActive', () => {
    const without = projectLegacyTask(task(), REVISION, null);
    expect(without.commands.map((item) => item.mutation.kind)).toEqual([
      'insert_contract_root',
      'put_iteration',
    ]);
    expect(without.expectedIterations).toMatchObject([
      { ordinal: 1, contractVersion: 1, state: 'planned' },
    ]);

    const withBridge = projectLegacyTask(task(), REVISION, null, { bridgeActive: true });
    expect(withBridge.commands.map((item) => item.mutation.kind)).toEqual([
      'insert_contract_root',
      'append_contract_successor',
      'put_iteration',
    ]);
    expect(withBridge.gapCodes).toEqual([]);
    expect(withBridge.expectedIterations).toMatchObject([
      { ordinal: 1, contractVersion: 2, state: 'planned' },
    ]);
    const successor = withBridge.commands[1]!.mutation;
    expect(successor).toMatchObject({
      kind: 'append_contract_successor',
      request: { taskId: 'M4-1', baseContractVersion: 1 },
    });
    expect(withBridge.commands[1]!.event.actor).toEqual({
      kind: 'human',
      id: 'hercules-owner',
    });
  });

  it('resumes bridge successor + v2 iteration when only the root exists', () => {
    const full = projectLegacyTask(task(), REVISION, null, { bridgeActive: true });
    expect(full.commands).toHaveLength(3);
    // expectedContract remains the compiled root even when bridgeActive.
    const resume = projectLegacyTask(
      task(),
      REVISION,
      { contracts: [full.expectedContract], iterations: [], retirement: null },
      { bridgeActive: true },
    );
    expect(resume.commands.map((item) => item.mutation.kind)).toEqual([
      'append_contract_successor',
      'put_iteration',
    ]);
    expect(resume.expectedIterations).toMatchObject([
      { ordinal: 1, contractVersion: 2, state: 'planned' },
    ]);
    expect(hashCanonicalJson(resume.commands)).toBe(
      hashCanonicalJson(full.commands.slice(1)),
    );
  });

  it('resumes only the v2 iteration when root + successor already exist', () => {
    const full = projectLegacyTask(task(), REVISION, null, { bridgeActive: true });
    const root = projectLegacyTask(task(), REVISION, null).expectedContract;
    const bridged = bridgeContracts(root);
    const resume = projectLegacyTask(
      task(),
      REVISION,
      { contracts: bridged, iterations: [], retirement: null },
      { bridgeActive: true },
    );
    expect(resume.commands.map((item) => item.mutation.kind)).toEqual([
      'put_iteration',
    ]);
    expect(resume.expectedIterations).toMatchObject([
      { ordinal: 1, contractVersion: 2, state: 'planned' },
    ]);
    expect(hashCanonicalJson(resume.commands)).toBe(
      hashCanonicalJson(full.commands.slice(2)),
    );
  });

  it('does not re-bridge an already-bridged existing projection', () => {
    const root = projectLegacyTask(task(), REVISION, null).expectedContract;
    const bridged = bridgeContracts(root);
    const full = projectLegacyTask(task(), REVISION, null, { bridgeActive: true });
    const again = projectLegacyTask(
      task(),
      REVISION,
      {
        contracts: bridged,
        iterations: full.expectedIterations,
        retirement: null,
      },
      { bridgeActive: true },
    );
    expect(again.commands).toEqual([]);
    expect(again.expectedIterations).toMatchObject([
      { ordinal: 1, contractVersion: 2 },
    ]);
  });
});
