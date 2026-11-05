/**
 * Adaptive task graph domain model — pure validation + canonical digest.
 * Covers docs/autonomy/adaptive-task-graph.md step 1 only.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  TASK_GRAPH_VERSION,
  TASK_GRAPH_NODE_KINDS,
  TASK_GRAPH_EDGE_KINDS,
  TASK_GRAPH_RESOURCE_KINDS,
  TASK_GRAPH_ACCEPTANCE_KINDS,
  TASK_GRAPH_RESERVED_HUMAN_ACTIONS,
  TaskGraphValidationError,
  validateTaskGraph,
  parseTaskGraph,
  serializeTaskGraph,
  taskGraphCanonical,
  taskGraphDigest,
  taskGraphAuthorizes,
  taskGraphAuthorizesExecution,
  isTaskGraphNodeKind,
  isTaskGraphEdgeKind,
  type TaskGraph,
  type TaskGraphNode,
  type TaskGraphEdge,
  type TaskGraphIntegrationContract,
  type TaskGraphRetryPolicy,
  type TaskGraphNodeContract,
} from '../../src/domain/taskGraph.js';

const RETRY: TaskGraphRetryPolicy = {
  maxAttempts: 3,
  backoffMs: 1000,
  rollbackDefined: true,
};

function contract(over: Partial<TaskGraphNodeContract> = {}): TaskGraphNodeContract {
  return {
    inputs: ['objective-brief'],
    outputs: ['artifact'],
    acceptance: [{ kind: 'mechanical', description: 'unit tests pass' }],
    resources: [{ kind: 'path_lease', key: 'src/domain/taskGraph.ts', exclusive: true }],
    allowedConcurrentNodeIds: [],
    retry: RETRY,
    ...over,
  };
}

function node(
  id: string,
  kind: TaskGraphNode['kind'],
  over: Partial<TaskGraphNode> = {},
): TaskGraphNode {
  return {
    id,
    kind,
    title: kind + ' ' + id,
    goal: 'one behavior goal for ' + id,
    scope: 'src/domain/' + id + '.ts',
    contract: contract(),
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

function integration(
  objectiveNodeId = 'obj-1',
  over: Partial<TaskGraphIntegrationContract> = {},
): TaskGraphIntegrationContract {
  return {
    objectiveNodeId,
    acceptance: [
      {
        kind: 'integration',
        description: 'top-level objective re-verified after children',
      },
    ],
    requiresTopLevelVerification: true,
    reservedHumanActions: [...TASK_GRAPH_RESERVED_HUMAN_ACTIONS],
    ...over,
  };
}

function sampleGraph(over: Partial<TaskGraph> = {}): TaskGraph {
  return {
    version: TASK_GRAPH_VERSION,
    id: 'graph-sample-1',
    rationale: 'split unknown then implement leaf',
    nodes: [
      node('obj-1', 'objective', {
        contract: contract({
          inputs: [],
          outputs: ['top-level-goal'],
          resources: [],
        }),
      }),
      node('inv-1', 'investigation', {
        contract: contract({
          inputs: ['top-level-goal'],
          outputs: ['design-notes'],
          resources: [{ kind: 'concurrency_budget', key: 'investigate', exclusive: false }],
        }),
      }),
      node('impl-1', 'implementation', {
        contract: contract({
          inputs: ['design-notes'],
          outputs: ['src/domain/taskGraph.ts'],
        }),
      }),
    ],
    edges: [
      edge('e-obj-inv', 'obj-1', 'inv-1', 'integration_prerequisite'),
      edge('e-inv-impl', 'inv-1', 'impl-1', 'semantic_output'),
    ],
    integration: integration(),
    ...over,
  };
}

describe('taskGraph vocabulary', () => {
  it('names objective, investigation, and implementation node kinds', () => {
    expect([...TASK_GRAPH_NODE_KINDS]).toEqual([
      'objective',
      'investigation',
      'implementation',
    ]);
    expect(isTaskGraphNodeKind('objective')).toBe(true);
    expect(isTaskGraphNodeKind('scheduler')).toBe(false);
  });

  it('names dependency edge and resource/lease kinds', () => {
    expect(TASK_GRAPH_EDGE_KINDS).toContain('semantic_output');
    expect(TASK_GRAPH_EDGE_KINDS).toContain('interface_contract');
    expect(TASK_GRAPH_EDGE_KINDS).toContain('resource_lock');
    expect(TASK_GRAPH_EDGE_KINDS).toContain('integration_prerequisite');
    expect(isTaskGraphEdgeKind('resource_lock')).toBe(true);
    expect(TASK_GRAPH_RESOURCE_KINDS).toContain('path_lease');
    expect(TASK_GRAPH_RESOURCE_KINDS).toContain('branch_lease');
    expect(TASK_GRAPH_RESOURCE_KINDS).toContain('env_lock');
    expect(TASK_GRAPH_RESOURCE_KINDS).toContain('deploy_lock');
    expect(TASK_GRAPH_ACCEPTANCE_KINDS).toContain('mechanical');
    expect(TASK_GRAPH_ACCEPTANCE_KINDS).toContain('integration');
  });

  it('reserves human merge/deploy/permission boundaries', () => {
    expect(TASK_GRAPH_RESERVED_HUMAN_ACTIONS).toEqual(
      expect.arrayContaining([
        'merge',
        'deploy',
        'promote',
        'privilege_change',
        'permission_change',
        'external_publication',
        'destructive_action',
        'cost_expansion',
      ]),
    );
  });
});

describe('taskGraph validation - happy path', () => {
  it('accepts a bounded DAG with contracts, resources, and integration', () => {
    const result = validateTaskGraph(sampleGraph());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.nodes).toHaveLength(3);
    expect(result.graph.edges).toHaveLength(2);
    expect(result.graph.integration.requiresTopLevelVerification).toBe(true);
    expect(result.graph.integration.objectiveNodeId).toBe('obj-1');
  });
});

describe('taskGraph validation - rejects invalid graphs', () => {
  it('rejects duplicate node IDs with a bounded error', () => {
    const g = sampleGraph({
      nodes: [node('dup', 'objective'), node('dup', 'implementation')],
      edges: [],
      integration: integration('dup'),
    });
    const result = validateTaskGraph(g);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === 'duplicate_node_id')).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.length).toBeLessThanOrEqual(64);
  });

  it('rejects duplicate edge IDs', () => {
    const g = sampleGraph({
      edges: [edge('same', 'obj-1', 'inv-1'), edge('same', 'inv-1', 'impl-1')],
    });
    const result = validateTaskGraph(g);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === 'duplicate_edge_id')).toBe(true);
  });

  it('rejects missing dependency endpoints', () => {
    const g = sampleGraph({
      edges: [edge('e-miss', 'obj-1', 'ghost-node')],
    });
    const result = validateTaskGraph(g);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === 'missing_dependency')).toBe(true);
  });

  it('rejects cycles', () => {
    const g = sampleGraph({
      edges: [
        edge('e1', 'obj-1', 'inv-1'),
        edge('e2', 'inv-1', 'impl-1'),
        edge('e3', 'impl-1', 'obj-1'),
      ],
    });
    const result = validateTaskGraph(g);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === 'cycle')).toBe(true);
  });

  it('rejects unbounded nodes missing goal/outputs/acceptance', () => {
    const g = sampleGraph({
      nodes: [
        node('obj-1', 'objective', {
          goal: '',
          contract: contract({ outputs: [], acceptance: [], inputs: [], resources: [] }),
        }),
        node('impl-1', 'implementation'),
      ],
      edges: [edge('e1', 'obj-1', 'impl-1')],
    });
    const result = validateTaskGraph(g);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === 'unbounded_node')).toBe(true);
  });

  it('rejects invalid resource contracts', () => {
    const g = sampleGraph({
      nodes: [
        node('obj-1', 'objective', {
          contract: contract({ inputs: [], outputs: ['goal'], resources: [] }),
        }),
        node('impl-1', 'implementation', {
          contract: contract({
            resources: [{ kind: 'path_lease', key: '../etc/passwd', exclusive: true }],
          }),
        }),
      ],
      edges: [edge('e1', 'obj-1', 'impl-1')],
    });
    const result = validateTaskGraph(g);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === 'invalid_resource')).toBe(true);
  });

  it('rejects invalid identifiers on graph id', () => {
    const g = sampleGraph({ id: '../evil' });
    const result = validateTaskGraph(g);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === 'invalid_identifier')).toBe(true);
  });

  it('rejects integration that drops human boundaries', () => {
    const g = sampleGraph({
      integration: integration('obj-1', {
        reservedHumanActions: ['merge'],
        acceptance: [],
      }),
    });
    const result = validateTaskGraph(g);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === 'invalid_integration')).toBe(true);
  });

  it('throws TaskGraphValidationError from parseTaskGraph on bad JSON', () => {
    expect(() => parseTaskGraph('not-json')).toThrow(TaskGraphValidationError);
    expect(() => parseTaskGraph('{bad}')).toThrow(TaskGraphValidationError);
  });

  it('rejects schema version mismatches via parseTaskGraph', () => {
    expect(() => parseTaskGraph(JSON.stringify({ version: 999 }))).toThrow(
      TaskGraphValidationError,
    );
  });
});

describe('taskGraph canonical serialization and digest', () => {
  it('is deterministic across restart', () => {
    const a = sampleGraph();
    const b = sampleGraph();
    expect(serializeTaskGraph(a)).toBe(serializeTaskGraph(b));
    const digA = taskGraphDigest(a);
    const digB = taskGraphDigest(b);
    expect(digA).toBe(digB);
    expect(digA).toMatch(/^[0-9a-f]{64}$/);
    const again = parseTaskGraph(serializeTaskGraph(a));
    expect(taskGraphDigest(again)).toBe(digA);
    const manual = createHash('sha256').update(taskGraphCanonical(a), 'utf8').digest('hex');
    expect(manual).toBe(digA);
  });

  it('canonical form is key-order stable', () => {
    const g1 = sampleGraph();
    const g2: TaskGraph = {
      edges: g1.edges,
      integration: g1.integration,
      nodes: g1.nodes,
      rationale: g1.rationale,
      id: g1.id,
      version: g1.version,
    };
    expect(taskGraphCanonical(g1)).toBe(taskGraphCanonical(g2));
    expect(taskGraphDigest(g1)).toBe(taskGraphDigest(g2));
  });
});

describe('taskGraph authority boundary', () => {
  it('never authorizes execution, merge, deploy, or privilege changes', () => {
    const g = sampleGraph();
    expect(taskGraphAuthorizesExecution(g)).toBe(false);
    for (const action of TASK_GRAPH_RESERVED_HUMAN_ACTIONS) {
      expect(taskGraphAuthorizes(g, action)).toBe(false);
    }
    const validated = validateTaskGraph(g);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(taskGraphAuthorizesExecution(validated.graph)).toBe(false);
    expect(taskGraphAuthorizes(validated.graph, 'merge')).toBe(false);
    expect(taskGraphAuthorizes(validated.graph, 'deploy')).toBe(false);
    expect(taskGraphAuthorizes(validated.graph, 'dispatch')).toBe(false);
  });
});
