/** Graph reconciler + top-level integration packet (adaptive-task-graph step 5). */
import { describe, it, expect } from 'vitest';
import {
  TASK_GRAPH_VERSION,
  TASK_GRAPH_RESERVED_HUMAN_ACTIONS,
  validateTaskGraph,
  taskGraphDigest,
  type TaskGraph,
  type TaskGraphNode,
  type TaskGraphEdge,
  type TaskGraphIntegrationContract,
  type TaskGraphRetryPolicy,
  type TaskGraphNodeContract,
} from '../../src/domain/taskGraph.js';
import {
  GRAPH_RECONCILER_VERSION,
  GRAPH_RECONCILER_HEADING,
  GRAPH_RECONCILER_BLOCK_START,
  GRAPH_RECONCILER_FORBIDDEN_ACTIONS,
  GraphReconcilerError,
  evaluateGraphReconciler,
  buildGraphReconcilerResult,
  graphReconcilerResultDigest,
  serializeGraphReconcilerResult,
  formatGraphReconcilerResultMarkdown,
  parseGraphReconcilerResult,
  graphReconcilerAuthorizesDispatch,
  graphReconcilerMutatesAcceptedGraph,
  graphReconcilerAutoDispatchesReplan,
  graphReconcilerAutoAppliesHumanDecisions,
  graphReconcilerAuthorizesMerge,
  graphReconcilerAuthorizesDeploy,
  graphReconcilerAuthorizesPermissionChange,
  graphReconcilerWeakensExecutionPolicy,
  graphReconcilerWeakensLeases,
  graphReconcilerWeakensGates,
  graphReconcilerWeakensHumanApproval,
  graphReconcilerMayEnterScheduling,
  type GraphNodeEvidence,
  type GraphReconcilerInput,
} from '../../src/domain/graphReconciler.js';

const RETRY: TaskGraphRetryPolicy = { maxAttempts: 3, backoffMs: 1000, rollbackDefined: true };

function contract(over: Partial<TaskGraphNodeContract> = {}): TaskGraphNodeContract {
  return {
    inputs: ['objective-brief'],
    outputs: ['artifact'],
    acceptance: [{ kind: 'mechanical', description: 'pnpm test:unit -- domain/reconciler' }],
    resources: [{ kind: 'path_lease', key: 'src/domain/reconciler.ts', exclusive: true }],
    allowedConcurrentNodeIds: [],
    retry: RETRY,
    ...over,
  };
}

function node(id: string, kind: TaskGraphNode['kind'], over: Partial<TaskGraphNode> = {}): TaskGraphNode {
  return {
    id,
    kind,
    title: kind + ' ' + id,
    goal: 'one behavior goal for ' + id,
    scope: 'src/domain/' + id + '.ts',
    contract: contract({
      resources: [{ kind: 'path_lease', key: 'src/domain/' + id + '.ts', exclusive: true }],
    }),
    ...over,
  };
}

function edge(
  id: string,
  from: string,
  to: string,
  kind: TaskGraphEdge['kind'] = 'semantic_output',
): TaskGraphEdge {
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

/** Dual independent leaves under one objective. */
function dualLeafGraph(): TaskGraph {
  return mustGraph({
    version: TASK_GRAPH_VERSION,
    id: 'graph-reconciler-dual',
    rationale: 'two leaves; replan one without touching the other',
    nodes: [
      node('obj-1', 'objective', {
        title: 'Ship dual leaves',
        goal: 'original objective proven only by top-level integration',
        contract: contract({
          inputs: [],
          outputs: ['top-level-goal'],
          resources: [],
          acceptance: [{ kind: 'human', description: 'operator accepts objective' }],
        }),
      }),
      node('impl-a', 'implementation', {
        title: 'Implement leaf A',
        goal: 'deliver A in isolation',
        scope: 'src/domain/a.ts',
        contract: contract({
          inputs: ['top-level-goal'],
          outputs: ['src/domain/a.ts'],
          resources: [{ kind: 'path_lease', key: 'src/domain/a.ts', exclusive: true }],
          acceptance: [{ kind: 'mechanical', description: 'pnpm test:unit -- domain/a' }],
        }),
      }),
      node('impl-b', 'implementation', {
        title: 'Implement leaf B',
        goal: 'deliver B in isolation',
        scope: 'src/domain/b.ts',
        contract: contract({
          inputs: ['top-level-goal'],
          outputs: ['src/domain/b.ts'],
          resources: [{ kind: 'path_lease', key: 'src/domain/b.ts', exclusive: true }],
          acceptance: [{ kind: 'mechanical', description: 'pnpm test:unit -- domain/b' }],
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

function ev(
  nodeId: string,
  status: GraphNodeEvidence['status'],
  over: Partial<GraphNodeEvidence> = {},
): GraphNodeEvidence {
  return { nodeId, status, attemptCount: 0, ...over };
}

function input(
  over: Partial<GraphReconcilerInput> & Pick<GraphReconcilerInput, 'graph' | 'nodeEvidence'>,
): GraphReconcilerInput {
  return {
    evaluatedAtMs: Date.UTC(2026, 7, 8, 14),
    ...over,
  };
}

describe('graph reconciler / integration packet', () => {
  it('limits replan to affected subgraph and preserves accepted unaffected nodes/leases/provenance', () => {
    const graph = dualLeafGraph();
    const result = evaluateGraphReconciler(
      input({
        graph,
        nodeEvidence: [
          ev('impl-a', 'accepted', { evidenceDigest: 'a'.repeat(64), attemptCount: 1 }),
          ev('impl-b', 'failed', {
            attemptCount: 1,
            failureKind: 'gate_fail',
            failureDetail: 'unit-b red',
          }),
        ],
        acceptedProvenance: [
          {
            nodeId: 'impl-a',
            evidenceDigest: 'a'.repeat(64),
            leaseKeys: ['src/domain/a.ts'],
          },
        ],
      }),
    );

    expect(result.version).toBe(GRAPH_RECONCILER_VERSION);
    expect(result.mode).toBe('advisory');
    expect(result.localReplan.limitedToAffectedSubgraph).toBe(true);
    expect(result.localReplan.affectedNodeIds).toEqual(['impl-b']);
    expect(result.localReplan.preservedNodeIds).toEqual(['impl-a']);
    expect(result.localReplan.preservedLeaseKeys).toContain('src/domain/a.ts');
    expect(result.localReplan.preservedProvenance).toEqual([
      { nodeId: 'impl-a', evidenceDigest: 'a'.repeat(64), leaseKeys: ['src/domain/a.ts'] },
    ]);
    expect(result.localReplan.actions.some((a) => a.nodeId === 'impl-a' && a.kind === 'preserve')).toBe(
      true,
    );
    expect(result.localReplan.actions.some((a) => a.nodeId === 'impl-b' && a.kind === 'retry')).toBe(
      true,
    );
    expect(result.graphDigest).toBe(taskGraphDigest(graph));
    expect(result.resultDigest).toBe(graphReconcilerResultDigest(result));
  });

  it('requires investigation for cycles instead of speculative retry', () => {
    const graph = dualLeafGraph();
    const result = evaluateGraphReconciler(
      input({
        graph,
        nodeEvidence: [
          ev('impl-a', 'failed', {
            attemptCount: 0,
            discoveredCycleNodeIds: ['impl-a', 'impl-b'],
            failureDetail: 'runtime cycle A↔B',
          }),
          ev('impl-b', 'pending'),
        ],
      }),
    );
    const a = result.localReplan.actions.find((x) => x.nodeId === 'impl-a');
    expect(a?.kind).toBe('require_investigation');
    expect(result.localReplan.actions.some((x) => x.kind === 'retry')).toBe(false);
    expect(result.localReplan.proposedInvestigations.some((i) => i.reasonCodes.includes('cyclic_discovery'))).toBe(
      true,
    );
    expect(result.overallVerdict).toBe('needs_replan');
  });

  it('requires investigation for discovered coupling instead of speculative retry', () => {
    const graph = dualLeafGraph();
    const result = evaluateGraphReconciler(
      input({
        graph,
        nodeEvidence: [
          ev('impl-a', 'failed', {
            attemptCount: 0,
            discoveredCouplingNodeIds: ['impl-b'],
            failureDetail: 'shared mutable module',
          }),
          ev('impl-b', 'accepted', { evidenceDigest: 'b'.repeat(64) }),
        ],
      }),
    );
    expect(
      result.localReplan.actions.find((x) => x.nodeId === 'impl-a')?.kind,
    ).toBe('require_investigation');
    expect(result.localReplan.actions.some((x) => x.kind === 'retry')).toBe(false);
    expect(
      result.localReplan.proposedInvestigations.some((i) => i.reasonCodes.includes('hidden_coupling')),
    ).toBe(true);
  });

  it('proves original objective separately from child-node green status', () => {
    const graph = dualLeafGraph();
    const greenOnly = evaluateGraphReconciler(
      input({
        graph,
        nodeEvidence: [
          ev('impl-a', 'accepted', { evidenceDigest: 'a'.repeat(64) }),
          ev('impl-b', 'accepted', { evidenceDigest: 'b'.repeat(64) }),
        ],
        integrationEvidence: { status: 'unproven' },
      }),
    );
    expect(greenOnly.integration.childSummary.allChildrenAccepted).toBe(true);
    expect(greenOnly.integration.childrenGreenIsNotSuccess).toBe(true);
    expect(greenOnly.integration.status).toBe('unproven');
    expect(greenOnly.overallVerdict).toBe('awaiting_integration');
    expect(greenOnly.overallVerdict).not.toBe('objective_proven');
    expect(greenOnly.visibleUncertainties.some((u) => /greenwash|unproven/i.test(u))).toBe(true);

    const proven = evaluateGraphReconciler(
      input({
        graph,
        nodeEvidence: [
          ev('impl-a', 'accepted', { evidenceDigest: 'a'.repeat(64) }),
          ev('impl-b', 'accepted', { evidenceDigest: 'b'.repeat(64) }),
        ],
        integrationEvidence: { status: 'passed', detail: 'pnpm check:full green on tip' },
      }),
    );
    expect(proven.integration.status).toBe('passed');
    expect(proven.overallVerdict).toBe('objective_proven');

    const failedIntegration = evaluateGraphReconciler(
      input({
        graph,
        nodeEvidence: [
          ev('impl-a', 'accepted', { evidenceDigest: 'a'.repeat(64) }),
          ev('impl-b', 'accepted', { evidenceDigest: 'b'.repeat(64) }),
        ],
        integrationEvidence: { status: 'failed', detail: 'top-level check red' },
      }),
    );
    expect(failedIntegration.overallVerdict).toBe('integration_failed');
    expect(failedIntegration.visibleFailures.some((f) => /integration/i.test(f))).toBe(true);
  });

  it('never auto-applies human-gated merge/deploy/permission decisions or replan dispatch', () => {
    const graph = dualLeafGraph();
    const result = evaluateGraphReconciler(
      input({
        graph,
        nodeEvidence: [
          ev('impl-a', 'accepted', { evidenceDigest: 'a'.repeat(64) }),
          ev('impl-b', 'accepted', { evidenceDigest: 'b'.repeat(64) }),
        ],
        integrationEvidence: { status: 'passed' },
      }),
    );
    expect(result.authorizesDispatch).toBe(false);
    expect(result.authorizesMerge).toBe(false);
    expect(result.authorizesDeploy).toBe(false);
    expect(result.authorizesPermissionChange).toBe(false);
    expect(result.autoAppliesHumanDecisions).toBe(false);
    expect(result.autoDispatchesReplan).toBe(false);
    expect(result.mutatesGraph).toBe(false);
    expect(result.localReplan.authorizesDispatch).toBe(false);
    expect(result.localReplan.mutatesAcceptedGraph).toBe(false);
    for (const action of TASK_GRAPH_RESERVED_HUMAN_ACTIONS) {
      expect(result.reservedHumanActions).toContain(action);
    }
    expect(graphReconcilerAuthorizesDispatch(result)).toBe(false);
    expect(graphReconcilerMutatesAcceptedGraph(result)).toBe(false);
    expect(graphReconcilerAutoDispatchesReplan(result)).toBe(false);
    expect(graphReconcilerAutoAppliesHumanDecisions(result)).toBe(false);
    expect(graphReconcilerAuthorizesMerge(result)).toBe(false);
    expect(graphReconcilerAuthorizesDeploy(result)).toBe(false);
    expect(graphReconcilerAuthorizesPermissionChange(result)).toBe(false);
    expect(graphReconcilerWeakensExecutionPolicy(result)).toBe(false);
    expect(graphReconcilerWeakensLeases(result)).toBe(false);
    expect(graphReconcilerWeakensGates(result)).toBe(false);
    expect(graphReconcilerWeakensHumanApproval(result)).toBe(false);
    expect(graphReconcilerMayEnterScheduling(result)).toBe(false);
    for (const a of GRAPH_RECONCILER_FORBIDDEN_ACTIONS) expect(String(a).length).toBeGreaterThan(0);
  });

  it('keeps failure and uncertainty visible and durable in markdown packet', () => {
    const graph = dualLeafGraph();
    const result = evaluateGraphReconciler(
      input({
        graph,
        nodeEvidence: [
          ev('impl-a', 'failed', { attemptCount: 3, failureDetail: 'still red after retries' }),
          ev('impl-b', 'uncertain', { failureDetail: 'flake suspected' }),
        ],
      }),
    );
    expect(result.visibleFailures.some((f) => /impl-a|still red/i.test(f))).toBe(true);
    expect(result.visibleUncertainties.some((u) => /impl-b|flake/i.test(u))).toBe(true);
    expect(result.localReplan.actions.find((a) => a.nodeId === 'impl-a')?.kind).toBe(
      'require_investigation',
    );

    const md = formatGraphReconcilerResultMarkdown(result);
    expect(md).toContain(GRAPH_RECONCILER_HEADING);
    expect(md).toContain(GRAPH_RECONCILER_BLOCK_START);
    expect(md).toMatch(/does not (dispatch|mutate)/i);
    expect(md).toMatch(/Children green is not success/i);
    expect(serializeGraphReconcilerResult(result)).toContain(result.resultDigest);

    const parsed = parseGraphReconcilerResult(md);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.result.resultDigest).toBe(result.resultDigest);

    const tampered = md.replace(result.resultDigest, 'c'.repeat(64));
    expect(parseGraphReconcilerResult(tampered).ok).toBe(false);
    expect(buildGraphReconcilerResult({ evaluatedAtMs: 1 }).ok).toBe(false);
    expect(() => parseGraphReconcilerResult('nope')).toThrow(GraphReconcilerError);
  });
});
