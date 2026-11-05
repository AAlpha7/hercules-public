/** Ready-node shadow scheduler (adaptive-task-graph step 4). Advisory only. */
import { describe, it, expect } from 'vitest';
import {
  TASK_GRAPH_VERSION, TASK_GRAPH_RESERVED_HUMAN_ACTIONS, validateTaskGraph, taskGraphDigest,
  type TaskGraph, type TaskGraphNode, type TaskGraphEdge, type TaskGraphIntegrationContract,
  type TaskGraphRetryPolicy, type TaskGraphNodeContract,
} from '../../src/domain/taskGraph.js';
import {
  READY_NODE_SHADOW_VERSION, READY_NODE_SHADOW_HEADING, READY_NODE_SHADOW_BLOCK_START,
  READY_NODE_SHADOW_FORBIDDEN_ACTIONS, ReadyNodeShadowSchedulerError,
  evaluateReadyNodeShadowSchedule, buildReadyNodeShadowSchedule, readyNodeShadowResultDigest,
  serializeReadyNodeShadowResult, formatReadyNodeShadowResultMarkdown, parseReadyNodeShadowResult,
  readyNodeShadowAuthorizesDispatch, readyNodeShadowMutatesAcceptedGraph,
  readyNodeShadowAffectsLinearDispatch, readyNodeShadowWeakensExecutionPolicy,
  readyNodeShadowWeakensLeases, readyNodeShadowWeakensGates, readyNodeShadowWeakensHumanApproval,
  readyNodeShadowMayAutonomousFanOut, readyNodeShadowMayWidenPermissions,
  readyNodeShadowMayMergeOrDeploy, type ReadyNodeRuntimeSnapshot, type ReadyNodeShadowInput,
} from '../../src/domain/readyNodeShadowScheduler.js';
import { selectEligible, type SchedulingState } from '../../src/domain/scheduling.js';
import type { Task } from '../../src/domain/task.js';

const RETRY: TaskGraphRetryPolicy = { maxAttempts: 3, backoffMs: 1000, rollbackDefined: true };
function contract(over: Partial<TaskGraphNodeContract> = {}): TaskGraphNodeContract {
  return {
    inputs: ['objective-brief'], outputs: ['artifact'],
    acceptance: [{ kind: 'mechanical', description: 'pnpm test:unit -- domain/shadow' }],
    resources: [{ kind: 'path_lease', key: 'src/domain/shadow.ts', exclusive: true }],
    allowedConcurrentNodeIds: [], retry: RETRY, ...over,
  };
}
function node(id: string, kind: TaskGraphNode['kind'], over: Partial<TaskGraphNode> = {}): TaskGraphNode {
  return {
    id, kind, title: kind + ' ' + id, goal: 'one behavior goal for ' + id,
    scope: 'src/domain/' + id + '.ts',
    contract: contract({ resources: [{ kind: 'path_lease', key: 'src/domain/' + id + '.ts', exclusive: true }] }),
    ...over,
  };
}
function edge(id: string, from: string, to: string, kind: TaskGraphEdge['kind'] = 'semantic_output'): TaskGraphEdge {
  return { id, from, to, kind, description: from + ' -> ' + to };
}
function integration(): TaskGraphIntegrationContract {
  return {
    objectiveNodeId: 'obj-1',
    acceptance: [
      { kind: 'integration', description: 'top-level objective re-verified after children' },
      { kind: 'mechanical', description: 'pnpm check:full', evidenceHook: 'l1-full' },
    ],
    requiresTopLevelVerification: true,
    reservedHumanActions: [...TASK_GRAPH_RESERVED_HUMAN_ACTIONS],
  };
}
function mustGraph(raw: TaskGraph): TaskGraph {
  const result = validateTaskGraph(raw);
  if (!result.ok) throw new Error('fixture invalid: ' + result.errors.map((e) => e.code).join(','));
  return result.graph;
}
function dualLeafGraph(): TaskGraph {
  return mustGraph({
    version: TASK_GRAPH_VERSION, id: 'graph-dual-leaf',
    rationale: 'two independent ready leaves for shadow admission',
    nodes: [
      node('obj-1', 'objective', {
        title: 'Ship dual leaves', goal: 'operators see independent ready nodes',
        contract: contract({ inputs: [], outputs: ['top-level-goal'], resources: [], acceptance: [{ kind: 'human', description: 'operator accepts objective' }] }),
      }),
      node('impl-a', 'implementation', {
        title: 'Implement leaf A', goal: 'evaluate ready-node A in isolation', scope: 'src/domain/a.ts',
        contract: contract({
          inputs: ['top-level-goal'], outputs: ['src/domain/a.ts'],
          resources: [{ kind: 'path_lease', key: 'src/domain/a.ts', exclusive: true }, { kind: 'concurrency_budget', key: 'repo-app', exclusive: false }],
          acceptance: [{ kind: 'mechanical', description: 'pnpm test:unit -- domain/a', evidenceHook: 'unit-a' }],
        }),
      }),
      node('impl-b', 'implementation', {
        title: 'Implement leaf B', goal: 'evaluate ready-node B in isolation', scope: 'src/domain/b.ts',
        contract: contract({
          inputs: ['top-level-goal'], outputs: ['src/domain/b.ts'],
          resources: [{ kind: 'path_lease', key: 'src/domain/b.ts', exclusive: true }, { kind: 'concurrency_budget', key: 'repo-app', exclusive: false }],
          acceptance: [{ kind: 'mechanical', description: 'pnpm test:unit -- domain/b', evidenceHook: 'unit-b' }],
        }),
      }),
    ],
    edges: [
      edge('e-obj-a', 'obj-1', 'impl-a', 'integration_prerequisite'),
      edge('e-obj-b', 'obj-1', 'impl-b', 'integration_prerequisite'),
    ],
    integration: integration(),
  });
}
function defaultRuntime(over: Partial<ReadyNodeRuntimeSnapshot> = {}): ReadyNodeRuntimeSnapshot {
  return {
    completedNodeIds: ['obj-1'], runningNodeIds: [], externalClaims: [],
    repoConcurrency: [{ key: 'repo-app', maxConcurrent: 2, currentRunning: 0 }],
    globalCap: 2, buildCachePressure: 'ok', ...over,
  };
}
function leafReady(...ids: string[]) {
  return ids.map((nodeId) => ({ nodeId, verdict: 'leaf_ready' as const }));
}
function input(over: Partial<ReadyNodeShadowInput> & Pick<ReadyNodeShadowInput, 'graph'>): ReadyNodeShadowInput {
  return {
    runtime: defaultRuntime(),
    leafVerdicts: leafReady(...over.graph.nodes.filter((n) => n.kind !== 'objective').map((n) => n.id)),
    evaluatedAtMs: Date.UTC(2026, 7, 8, 12),
    ...over,
  };
}

describe('ready-node shadow scheduler', () => {
  it('recommends dependency-ready resource-safe leaves under concurrency', () => {
    const graph = dualLeafGraph();
    const result = evaluateReadyNodeShadowSchedule(input({ graph, runtime: defaultRuntime({ globalCap: 2 }) }));
    expect(result.version).toBe(READY_NODE_SHADOW_VERSION);
    expect(result.mode).toBe('shadow');
    expect(result.authorizesDispatch).toBe(false);
    expect(result.affectsLinearDispatch).toBe(false);
    expect(result.graphDigest).toBe(taskGraphDigest(graph));
    expect(result.recommendedNodeIds).toEqual(['impl-a', 'impl-b']);
    expect(result.resultDigest).toBe(readyNodeShadowResultDigest(result));
  });

  it('honors global concurrency cap', () => {
    const graph = dualLeafGraph();
    const g = evaluateReadyNodeShadowSchedule(input({ graph, runtime: defaultRuntime({ globalCap: 1 }) }));
    expect(g.recommendedNodeIds).toEqual(['impl-a']);
    expect(g.explanations.find((e) => e.nodeId === 'impl-b')?.blockCodes).toContain('global_concurrency_cap');
  });

  it('honors repository concurrency_budget caps', () => {
    const graph = dualLeafGraph();
    const r = evaluateReadyNodeShadowSchedule(input({
      graph,
      runtime: defaultRuntime({ globalCap: 4, repoConcurrency: [{ key: 'repo-app', maxConcurrent: 1, currentRunning: 0 }] }),
    }));
    expect(r.recommendedNodeIds).toHaveLength(1);
  });

  it('never recommends not_leaf or path conflicts', () => {
    const graph = dualLeafGraph();
    const r = evaluateReadyNodeShadowSchedule(input({
      graph,
      leafVerdicts: [{ nodeId: 'impl-a', verdict: 'leaf_ready' }, { nodeId: 'impl-b', verdict: 'not_leaf' }],
      runtime: defaultRuntime({
        externalClaims: [{ kind: 'path_lease', key: 'src/domain/a.ts', exclusive: true, holderId: 'ext' }],
      }),
    }));
    expect(r.recommendedNodeIds).toEqual([]);
    expect(r.explanations.find((e) => e.nodeId === 'impl-b')?.blockCodes).toContain('not_leaf_ready');
    expect(r.explanations.find((e) => e.nodeId === 'impl-a')?.blockCodes).toContain('path_lease_conflict');
  });

  it('blocks budgets and compares linear outcomes', () => {
    const graph = dualLeafGraph();
    const r = evaluateReadyNodeShadowSchedule(input({
      graph,
      runtime: defaultRuntime({ globalCap: 1, globalBudgetRemaining: 0 }),
      linearObservation: { dispatchedNodeIds: ['impl-a', 'impl-b'], conflictNodeIds: ['impl-b'], reworkNodeIds: ['impl-b'] },
    }));
    expect(r.recommendedNodeIds).toEqual([]);
    expect(r.explanations.find((e) => e.nodeId === 'impl-a')?.blockCodes).toContain('task_budget_exhausted');
    expect(r.comparison?.linearOnly).toEqual(['impl-a', 'impl-b']);
    expect(r.comparison?.linearConflictsAlsoBlockedByShadow).toEqual(['impl-b']);
  });

  it('is durable and never affects linear selectEligible', () => {
    const graph = dualLeafGraph();
    const a = evaluateReadyNodeShadowSchedule(input({ graph }));
    const md = formatReadyNodeShadowResultMarkdown(a);
    expect(md).toContain(READY_NODE_SHADOW_HEADING);
    expect(md).toContain(READY_NODE_SHADOW_BLOCK_START);
    expect(serializeReadyNodeShadowResult(a)).toContain(a.resultDigest);
    expect(md).toMatch(/does not (dispatch|mutate|authorize)/i);
    const parsed = parseReadyNodeShadowResult(md);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.result.resultDigest).toBe(a.resultDigest);
    const tampered = md.replace(a.resultDigest, 'c'.repeat(64));
    expect(parseReadyNodeShadowResult(tampered).ok).toBe(false);
    expect(buildReadyNodeShadowSchedule({ evaluatedAtMs: 1 }).ok).toBe(false);
    expect(() => parseReadyNodeShadowResult('nope')).toThrow(ReadyNodeShadowSchedulerError);
    expect(readyNodeShadowAuthorizesDispatch(a)).toBe(false);
    expect(readyNodeShadowMutatesAcceptedGraph(a)).toBe(false);
    expect(readyNodeShadowAffectsLinearDispatch(a)).toBe(false);
    expect(readyNodeShadowWeakensExecutionPolicy(a)).toBe(false);
    expect(readyNodeShadowWeakensLeases(a)).toBe(false);
    expect(readyNodeShadowWeakensGates(a)).toBe(false);
    expect(readyNodeShadowWeakensHumanApproval(a)).toBe(false);
    expect(readyNodeShadowMayAutonomousFanOut(a)).toBe(false);
    expect(readyNodeShadowMayWidenPermissions(a)).toBe(false);
    expect(readyNodeShadowMayMergeOrDeploy(a)).toBe(false);
    for (const action of READY_NODE_SHADOW_FORBIDDEN_ACTIONS) expect(String(action).length).toBeGreaterThan(0);
    const task = (id: string, priority: number): Task => ({
      id, title: id, repo: 'app', state: 'todo', priority,
      createdAt: null, lastEventAt: null, startedAt: null, endedAt: null,
      attempts: 0, labels: [], blockedBy: [], body: '',
      adapter: null, agentSession: null, pendingSteer: null,
      prUrl: null, prStatus: null, planPending: false,
    });
    const state: SchedulingState = {
      tasks: [task('t-a', 10), task('t-b', 20)],
      repos: { repos: { app: { key: 'app', url: 'x', defaultBranch: 'main', workflow: 'WORKFLOW.md', maxConcurrent: 2, adapter: null, readiness: 'ready' } } },
      runningTaskIds: new Set(), globalCap: 2, backoffBaseMs: 1000, now: Date.UTC(2026, 7, 8, 12),
    };
    const before = selectEligible(state).map((t) => t.id);
    expect(a.recommendedNodeIds.length).toBeGreaterThan(0);
    const after = selectEligible(state).map((t) => t.id);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});
