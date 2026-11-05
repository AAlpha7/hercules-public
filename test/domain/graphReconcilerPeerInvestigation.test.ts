/** Regression: cycle/coupling peers never get speculative retry (L3 rework). */
import { describe, it, expect } from 'vitest';
import {
  TASK_GRAPH_VERSION,
  TASK_GRAPH_RESERVED_HUMAN_ACTIONS,
  validateTaskGraph,
  type TaskGraph,
} from '../../src/domain/taskGraph.js';
import {
  evaluateGraphReconciler,
  type GraphNodeEvidence,
} from '../../src/domain/graphReconciler.js';

const RETRY = { maxAttempts: 3, backoffMs: 1000, rollbackDefined: true } as const;

function mkGraph(): TaskGraph {
  const raw = {
    version: TASK_GRAPH_VERSION,
    id: 'graph-peer-inv',
    rationale: 'peer cycle must not retry',
    nodes: [
      {
        id: 'obj-1', kind: 'objective' as const, title: 'Obj', goal: 'goal', scope: 'src',
        contract: {
          inputs: [] as string[], outputs: ['top'],
          acceptance: [{ kind: 'human' as const, description: 'ok' }],
          resources: [] as [], allowedConcurrentNodeIds: [] as string[], retry: RETRY,
        },
      },
      {
        id: 'impl-a', kind: 'implementation' as const, title: 'A', goal: 'a', scope: 'src/a.ts',
        contract: {
          inputs: ['top'], outputs: ['src/a.ts'],
          acceptance: [{ kind: 'mechanical' as const, description: 'a' }],
          resources: [{ kind: 'path_lease' as const, key: 'src/a.ts', exclusive: true }],
          allowedConcurrentNodeIds: [] as string[], retry: RETRY,
        },
      },
      {
        id: 'impl-b', kind: 'implementation' as const, title: 'B', goal: 'b', scope: 'src/b.ts',
        contract: {
          inputs: ['top'], outputs: ['src/b.ts'],
          acceptance: [{ kind: 'mechanical' as const, description: 'b' }],
          resources: [{ kind: 'path_lease' as const, key: 'src/b.ts', exclusive: true }],
          allowedConcurrentNodeIds: [] as string[], retry: RETRY,
        },
      },
    ],
    edges: [
      { id: 'e1', from: 'obj-1', to: 'impl-a', kind: 'integration_prerequisite' as const, description: 'a' },
      { id: 'e2', from: 'obj-1', to: 'impl-b', kind: 'integration_prerequisite' as const, description: 'b' },
    ],
    integration: {
      objectiveNodeId: 'obj-1',
      acceptance: [{ kind: 'integration' as const, description: 'top' }],
      requiresTopLevelVerification: true,
      reservedHumanActions: [...TASK_GRAPH_RESERVED_HUMAN_ACTIONS],
    },
  };
  const v = validateTaskGraph(raw);
  if (!v.ok) throw new Error('bad fixture');
  return v.graph;
}

function run(a: Partial<GraphNodeEvidence>, b: Partial<GraphNodeEvidence>) {
  return evaluateGraphReconciler({
    graph: mkGraph(),
    evaluatedAtMs: 1,
    nodeEvidence: [
      { nodeId: 'impl-a', status: 'failed', attemptCount: 0, ...a },
      { nodeId: 'impl-b', status: 'failed', attemptCount: 0, ...b },
    ],
  });
}

function assertPeerInvestigation(r: ReturnType<typeof evaluateGraphReconciler>): void {
  expect(r.localReplan.actions.some((x) => x.kind === 'retry')).toBe(false);
  expect(r.localReplan.actions.find((x) => x.nodeId === 'impl-a')?.kind).toBe('require_investigation');
  expect(r.localReplan.actions.find((x) => x.nodeId === 'impl-b')?.kind).toBe('require_investigation');
  const cov = new Set(r.localReplan.proposedInvestigations.flatMap((i) => i.relatedNodeIds));
  expect(cov.has('impl-a')).toBe(true);
  expect(cov.has('impl-b')).toBe(true);
}

describe('graph reconciler peer investigation (L3 rework)', () => {
  it('never retries cycle peers when only one node reports the cycle', () => {
    assertPeerInvestigation(run(
      { discoveredCycleNodeIds: ['impl-a', 'impl-b'], failureDetail: 'cycle' },
      { failureDetail: 'peer' },
    ));
  });

  it('never retries coupling peers when only one node reports the coupling', () => {
    assertPeerInvestigation(run(
      { discoveredCouplingNodeIds: ['impl-a', 'impl-b'], failureDetail: 'coupling' },
      { attemptCount: 1, failureDetail: 'peer' },
    ));
  });
});
