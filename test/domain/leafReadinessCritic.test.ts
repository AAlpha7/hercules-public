/**
 * Leaf-readiness critic — adaptive-task-graph step 3.
 * Held-out fixtures: under-split, over-split, hidden coupling, cyclic discovery,
 * false conflict. Advisory only: never mutates graph or authorizes dispatch.
 */
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
  LEAF_READINESS_CRITIC_VERSION,
  LEAF_READINESS_DECISION_HEADING,
  LEAF_READINESS_BLOCK_START,
  LEAF_READINESS_CHECK_CODES,
  LeafReadinessCriticError,
  evaluateLeafReadiness,
  buildLeafReadinessDecision,
  leafReadinessDecisionDigest,
  serializeLeafReadinessDecision,
  formatLeafReadinessDecisionMarkdown,
  parseLeafReadinessDecision,
  leafReadinessAuthorizesDispatch,
  leafReadinessMutatesAcceptedGraph,
  leafReadinessWeakensExecutionPolicy,
  leafReadinessWeakensLeases,
  leafReadinessWeakensGates,
  leafReadinessWeakensHumanApproval,
  leafReadinessMayEnterScheduling,
} from '../../src/domain/leafReadinessCritic.js';

const RETRY: TaskGraphRetryPolicy = {
  maxAttempts: 3,
  backoffMs: 1000,
  rollbackDefined: true,
};

function contract(over: Partial<TaskGraphNodeContract> = {}): TaskGraphNodeContract {
  return {
    inputs: ['objective-brief'],
    outputs: ['artifact'],
    acceptance: [{ kind: 'mechanical', description: 'pnpm test:unit -- domain/leaf' }],
    resources: [{ kind: 'path_lease', key: 'src/domain/leaf.ts', exclusive: true }],
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

function integration(objectiveNodeId = 'obj-1'): TaskGraphIntegrationContract {
  return {
    objectiveNodeId,
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
  if (!result.ok) {
    throw new Error(
      'fixture graph invalid: ' + result.errors.map((e) => e.code + ':' + e.message).join('; '),
    );
  }
  return result.graph;
}

/** Clean leaf: single goal, mechanical proof, declared IO, scoped path, no conflicts. */
function readyLeafGraph(): TaskGraph {
  return mustGraph({
    version: TASK_GRAPH_VERSION,
    id: 'graph-ready-leaf',
    rationale: 'single ready implementation leaf after investigation',
    nodes: [
      node('obj-1', 'objective', {
        title: 'Ship leaf critic',
        goal: 'operators see leaf readiness before dispatch',
        contract: contract({
          inputs: [],
          outputs: ['top-level-goal'],
          resources: [],
          acceptance: [{ kind: 'human', description: 'operator accepts objective' }],
        }),
      }),
      node('inv-1', 'investigation', {
        title: 'Map readiness signals',
        goal: 'list existing graph contracts used by the critic',
        contract: contract({
          inputs: ['top-level-goal'],
          outputs: ['readiness-design-notes'],
          resources: [{ kind: 'concurrency_budget', key: 'investigate', exclusive: false }],
          acceptance: [{ kind: 'reviewer', description: 'design notes cite taskGraph contracts' }],
        }),
      }),
      node('impl-1', 'implementation', {
        title: 'Implement leaf readiness critic',
        goal: 'evaluate one node for independent dispatch readiness',
        scope: 'src/domain/leafReadinessCritic.ts',
        contract: contract({
          inputs: ['readiness-design-notes'],
          outputs: ['src/domain/leafReadinessCritic.ts'],
          resources: [
            {
              kind: 'path_lease',
              key: 'src/domain/leafReadinessCritic.ts',
              exclusive: true,
            },
          ],
          acceptance: [
            {
              kind: 'mechanical',
              description: 'pnpm test:unit -- domain/leafReadinessCritic',
              evidenceHook: 'unit-leaf-critic',
            },
          ],
        }),
      }),
    ],
    edges: [
      edge('e-obj-inv', 'obj-1', 'inv-1', 'integration_prerequisite'),
      edge('e-inv-impl', 'inv-1', 'impl-1', 'semantic_output'),
    ],
    integration: integration(),
  });
}

// ---------------------------------------------------------------------------
// Held-out fixtures (step 3 evaluation set)
// ---------------------------------------------------------------------------

/** Under-splitting: one implementation covers multiple unrelated behaviors. */
function fixtureUnderSplit(): { graph: TaskGraph; nodeId: string } {
  const graph = mustGraph({
    version: TASK_GRAPH_VERSION,
    id: 'fixture-under-split',
    rationale: 'held-out under-split',
    nodes: [
      node('obj-1', 'objective', {
        contract: contract({
          inputs: [],
          outputs: ['top-level-goal'],
          resources: [],
          acceptance: [{ kind: 'human', description: 'accept scope' }],
        }),
      }),
      node('impl-mega', 'implementation', {
        title: 'Do auth billing and deploy',
        goal: 'implement auth flow AND billing webhooks AND production deploy pipeline',
        scope: 'src/auth;src/billing;deploy/prod',
        contract: contract({
          inputs: ['top-level-goal'],
          outputs: ['src/auth/index.ts', 'src/billing/hooks.ts', 'deploy/prod.yaml'],
          resources: [
            { kind: 'path_lease', key: 'src/auth', exclusive: true },
            { kind: 'path_lease', key: 'src/billing', exclusive: true },
            { kind: 'deploy_lock', key: 'production', exclusive: true },
          ],
          acceptance: [
            { kind: 'mechanical', description: 'pnpm test -- auth' },
            { kind: 'mechanical', description: 'pnpm test -- billing' },
            { kind: 'human', description: 'approve production deploy' },
          ],
        }),
      }),
    ],
    edges: [edge('e1', 'obj-1', 'impl-mega', 'integration_prerequisite')],
    integration: integration(),
  });
  return { graph, nodeId: 'impl-mega' };
}

/** Over-splitting: tiny fragment with high fan-in and lost context. */
function fixtureOverSplit(): { graph: TaskGraph; nodeId: string } {
  const graph = mustGraph({
    version: TASK_GRAPH_VERSION,
    id: 'fixture-over-split',
    rationale: 'held-out over-split',
    nodes: [
      node('obj-1', 'objective', {
        contract: contract({
          inputs: [],
          outputs: ['top-level-goal'],
          resources: [],
          acceptance: [{ kind: 'human', description: 'accept' }],
        }),
      }),
      node('a', 'implementation', {
        goal: 'produce design fragment a',
        contract: contract({
          inputs: ['top-level-goal'],
          outputs: ['frag-a'],
          resources: [{ kind: 'path_lease', key: 'src/a.ts', exclusive: true }],
        }),
      }),
      node('b', 'implementation', {
        goal: 'produce design fragment b',
        contract: contract({
          inputs: ['top-level-goal'],
          outputs: ['frag-b'],
          resources: [{ kind: 'path_lease', key: 'src/b.ts', exclusive: true }],
        }),
      }),
      node('c', 'implementation', {
        goal: 'produce design fragment c',
        contract: contract({
          inputs: ['top-level-goal'],
          outputs: ['frag-c'],
          resources: [{ kind: 'path_lease', key: 'src/c.ts', exclusive: true }],
        }),
      }),
      node('impl-nit', 'implementation', {
        title: 'Rename helper nit',
        goal: 'tweak rename helper alias only',
        scope: 'src/util/rename.ts',
        contract: contract({
          inputs: ['frag-a', 'frag-b', 'frag-c', 'top-level-goal'],
          outputs: ['src/util/rename.ts'],
          resources: [{ kind: 'path_lease', key: 'src/util/rename.ts', exclusive: true }],
          acceptance: [{ kind: 'mechanical', description: 'pnpm test:unit -- util/rename' }],
        }),
      }),
    ],
    edges: [
      edge('e-obj-a', 'obj-1', 'a'),
      edge('e-obj-b', 'obj-1', 'b'),
      edge('e-obj-c', 'obj-1', 'c'),
      edge('e-a-nit', 'a', 'impl-nit'),
      edge('e-b-nit', 'b', 'impl-nit'),
      edge('e-c-nit', 'c', 'impl-nit'),
    ],
    integration: integration(),
  });
  return { graph, nodeId: 'impl-nit' };
}

/** Hidden coupling: consumer inputs producer outputs without a dependency edge. */
function fixtureHiddenCoupling(): { graph: TaskGraph; nodeId: string } {
  const graph = mustGraph({
    version: TASK_GRAPH_VERSION,
    id: 'fixture-hidden-coupling',
    rationale: 'held-out hidden coupling',
    nodes: [
      node('obj-1', 'objective', {
        contract: contract({
          inputs: [],
          outputs: ['top-level-goal'],
          resources: [],
          acceptance: [{ kind: 'human', description: 'accept' }],
        }),
      }),
      node('producer', 'implementation', {
        goal: 'write shared contract types',
        scope: 'src/domain/sharedContract.ts',
        contract: contract({
          inputs: ['top-level-goal'],
          outputs: ['shared-contract-types'],
          resources: [
            { kind: 'path_lease', key: 'src/domain/sharedContract.ts', exclusive: true },
          ],
          acceptance: [{ kind: 'mechanical', description: 'pnpm test:unit -- sharedContract' }],
        }),
      }),
      node('consumer', 'implementation', {
        goal: 'consume shared contract in API layer',
        scope: 'src/server/api.ts',
        contract: contract({
          inputs: ['shared-contract-types'],
          outputs: ['src/server/api.ts'],
          resources: [{ kind: 'path_lease', key: 'src/server/api.ts', exclusive: true }],
          acceptance: [{ kind: 'mechanical', description: 'pnpm test:unit -- server/api' }],
        }),
      }),
    ],
    // Both hang off objective; no producer -> consumer edge despite IO coupling.
    edges: [
      edge('e-obj-p', 'obj-1', 'producer'),
      edge('e-obj-c', 'obj-1', 'consumer'),
    ],
    integration: integration(),
  });
  return { graph, nodeId: 'consumer' };
}

/**
 * Cyclic discovery: mutual IO coupling between investigation nodes forms a
 * discovery cycle (formal edges stay acyclic via objective only).
 */
function fixtureCyclicDiscovery(): { graph: TaskGraph; nodeId: string } {
  const graph = mustGraph({
    version: TASK_GRAPH_VERSION,
    id: 'fixture-cyclic-discovery',
    rationale: 'held-out cyclic discovery',
    nodes: [
      node('obj-1', 'objective', {
        contract: contract({
          inputs: [],
          outputs: ['top-level-goal'],
          resources: [],
          acceptance: [{ kind: 'human', description: 'accept' }],
        }),
      }),
      node('inv-a', 'investigation', {
        title: 'Discover module A shape',
        goal: 'map module A using findings from B',
        scope: 'src/a',
        contract: contract({
          inputs: ['findings-from-b', 'top-level-goal'],
          outputs: ['findings-from-a'],
          resources: [{ kind: 'concurrency_budget', key: 'inv-a', exclusive: false }],
          acceptance: [{ kind: 'reviewer', description: 'A map cites real modules' }],
        }),
      }),
      node('inv-b', 'investigation', {
        title: 'Discover module B shape',
        goal: 'map module B using findings from A',
        scope: 'src/b',
        contract: contract({
          inputs: ['findings-from-a', 'top-level-goal'],
          outputs: ['findings-from-b'],
          resources: [{ kind: 'concurrency_budget', key: 'inv-b', exclusive: false }],
          acceptance: [{ kind: 'reviewer', description: 'B map cites real modules' }],
        }),
      }),
    ],
    edges: [
      edge('e-obj-a', 'obj-1', 'inv-a', 'integration_prerequisite'),
      edge('e-obj-b', 'obj-1', 'inv-b', 'integration_prerequisite'),
    ],
    integration: integration(),
  });
  return { graph, nodeId: 'inv-a' };
}

/** False conflict: exclusive path overlap allowed via mutual concurrency. */
function fixtureFalseConflict(): { graph: TaskGraph; nodeId: string } {
  const graph = mustGraph({
    version: TASK_GRAPH_VERSION,
    id: 'fixture-false-conflict',
    rationale: 'held-out false conflict',
    nodes: [
      node('obj-1', 'objective', {
        contract: contract({
          inputs: [],
          outputs: ['top-level-goal'],
          resources: [],
          acceptance: [{ kind: 'human', description: 'accept' }],
        }),
      }),
      node('impl-left', 'implementation', {
        goal: 'edit shared helper from left entrypoint',
        scope: 'src/shared/helper.ts',
        contract: contract({
          inputs: ['top-level-goal'],
          outputs: ['src/shared/helper.ts'],
          resources: [{ kind: 'path_lease', key: 'src/shared/helper.ts', exclusive: true }],
          allowedConcurrentNodeIds: ['impl-right'],
          acceptance: [{ kind: 'mechanical', description: 'pnpm test:unit -- shared/helper' }],
        }),
      }),
      node('impl-right', 'implementation', {
        goal: 'edit shared helper from right entrypoint',
        scope: 'src/shared/helper.ts',
        contract: contract({
          inputs: ['top-level-goal'],
          outputs: ['src/shared/helper.ts'],
          resources: [{ kind: 'path_lease', key: 'src/shared/helper.ts', exclusive: true }],
          allowedConcurrentNodeIds: ['impl-left'],
          acceptance: [{ kind: 'mechanical', description: 'pnpm test:unit -- shared/helper' }],
        }),
      }),
    ],
    edges: [
      edge('e-obj-l', 'obj-1', 'impl-left'),
      edge('e-obj-r', 'obj-1', 'impl-right'),
    ],
    integration: integration(),
  });
  return { graph, nodeId: 'impl-left' };
}

describe('evaluateLeafReadiness — ready leaf',
  () => {
    it('passes all six mechanical checks for a clean implementation leaf',
      () => {
        const graph = readyLeafGraph();
        const decision = evaluateLeafReadiness({
          graph,
          nodeId: 'impl-1',
        });
        expect(decision.version).toBe(LEAF_READINESS_CRITIC_VERSION);
        expect(decision.kind).toBe('leaf_readiness');
        expect(decision.mode).toBe('advisory');
        expect(decision.verifiedWork).toBe(false);
        expect(decision.mutatesGraph).toBe(false);
        expect(decision.authorizesDispatch).toBe(false);
        expect(decision.verdict).toBe('leaf_ready');
        expect(decision.nodeId).toBe('impl-1');
        expect(decision.graphDigest).toBe(taskGraphDigest(graph));
        expect(decision.checks).toHaveLength(LEAF_READINESS_CHECK_CODES.length);
        for (const code of LEAF_READINESS_CHECK_CODES) {
          const check = decision.checks.find((c) => c.code === code);
          expect(check?.ok).toBe(true);
        }
        expect(decision.reasons).toHaveLength(0);
        expect(decision.proposedInvestigation).toBeNull();
        expect(decision.decisionDigest).toBe(leafReadinessDecisionDigest(decision));
      });
  });

describe('held-out fixtures',
  () => {
    it('under-splitting → not leaf with bounded reasons + investigation proposal',
      () => {
        const { graph, nodeId } = fixtureUnderSplit();
        const decision = evaluateLeafReadiness({ graph, nodeId });
        expect(decision.verdict).not.toBe('leaf_ready');
        expect(decision.reasons.some((r) => r.code === 'under_split')).toBe(true);
        expect(decision.proposedInvestigation).not.toBeNull();
        expect(decision.proposedInvestigation?.kind).toBe('investigation');
        expect(decision.proposedInvestigation?.relatedNodeId).toBe(nodeId);
        expect(decision.mutatesGraph).toBe(false);
        // Graph identity unchanged (critic does not rewrite accepted graph).
        expect(decision.graphDigest).toBe(taskGraphDigest(graph));
      });

    it('over-splitting → not leaf with over_split reason + investigation proposal',
      () => {
        const { graph, nodeId } = fixtureOverSplit();
        const decision = evaluateLeafReadiness({ graph, nodeId });
        expect(decision.verdict).not.toBe('leaf_ready');
        expect(decision.reasons.some((r) => r.code === 'over_split')).toBe(true);
        expect(decision.proposedInvestigation).not.toBeNull();
        expect(decision.mutatesGraph).toBe(false);
      });

    it('hidden coupling → not leaf with hidden_coupling reason',
      () => {
        const { graph, nodeId } = fixtureHiddenCoupling();
        const decision = evaluateLeafReadiness({ graph, nodeId });
        expect(decision.verdict).not.toBe('leaf_ready');
        expect(decision.reasons.some((r) => r.code === 'hidden_coupling')).toBe(true);
        const dep = decision.checks.find((c) => c.code === 'unresolved_dependency');
        expect(dep?.ok).toBe(false);
        expect(decision.proposedInvestigation).not.toBeNull();
      });

    it('cyclic discovery → investigation_required with cyclic_discovery',
      () => {
        const { graph, nodeId } = fixtureCyclicDiscovery();
        const decision = evaluateLeafReadiness({ graph, nodeId });
        expect(decision.verdict).toBe('investigation_required');
        expect(decision.reasons.some((r) => r.code === 'cyclic_discovery')).toBe(true);
        expect(decision.proposedInvestigation).not.toBeNull();
        expect(decision.proposedInvestigation?.kind).toBe('investigation');
        expect(decision.authorizesDispatch).toBe(false);
      });

    it('false conflict → leaf_ready (concurrent exclusive paths allowed)',
      () => {
        const { graph, nodeId } = fixtureFalseConflict();
        const decision = evaluateLeafReadiness({ graph, nodeId });
        const conflict = decision.checks.find((c) => c.code === 'path_resource_conflict');
        expect(conflict?.ok).toBe(true);
        expect(decision.reasons.some((r) => r.code === 'path_conflict')).toBe(false);
        expect(decision.reasons.some((r) => r.code === 'resource_conflict')).toBe(false);
        expect(decision.verdict).toBe('leaf_ready');
        expect(decision.proposedInvestigation).toBeNull();
      });
  });

describe('mechanical checks',
  () => {
    it('fails independent_proof when implementation has only human acceptance',
      () => {
        const graph = mustGraph({
          version: TASK_GRAPH_VERSION,
          id: 'graph-human-only',
          rationale: 'no independent proof',
          nodes: [
            node('obj-1', 'objective', {
              contract: contract({
                inputs: [],
                outputs: ['top-level-goal'],
                resources: [],
                acceptance: [{ kind: 'human', description: 'accept' }],
              }),
            }),
            node('impl-1', 'implementation', {
              goal: 'change API response shape for errors',
              scope: 'src/server/api.ts',
              contract: contract({
                inputs: ['top-level-goal'],
                outputs: ['src/server/api.ts'],
                resources: [{ kind: 'path_lease', key: 'src/server/api.ts', exclusive: true }],
                acceptance: [{ kind: 'human', description: 'looks good to me' }],
              }),
            }),
          ],
          edges: [edge('e1', 'obj-1', 'impl-1')],
          integration: integration(),
        });
        const decision = evaluateLeafReadiness({ graph, nodeId: 'impl-1' });
        const proof = decision.checks.find((c) => c.code === 'independent_proof');
        expect(proof?.ok).toBe(false);
        expect(decision.verdict).not.toBe('leaf_ready');
        expect(decision.reasons.some((r) => r.code === 'missing_independent_proof')).toBe(true);
      });

    it('fails declared_inputs when non-objective node has empty inputs',
      () => {
        // Bypass validateTaskGraph emptiness: construct via override after validate
        // by using a placeholder input then evaluate a surgically empty contract
        // through evaluateLeafReadiness which accepts typed graph.
        const base = readyLeafGraph();
        const hollow: TaskGraph = {
          ...base,
          nodes: base.nodes.map((n) =>
            n.id === 'impl-1'
              ? {
                  ...n,
                  contract: { ...n.contract, inputs: [] },
                }
              : n,
          ),
        };
        const decision = evaluateLeafReadiness({ graph: hollow, nodeId: 'impl-1' });
        const inputs = decision.checks.find((c) => c.code === 'declared_inputs');
        expect(inputs?.ok).toBe(false);
        expect(decision.reasons.some((r) => r.code === 'missing_declared_inputs')).toBe(true);
      });

    it('fails repository_scope when scope is unknown or absolute',
      () => {
        const base = readyLeafGraph();
        const hollow: TaskGraph = {
          ...base,
          nodes: base.nodes.map((n) =>
            n.id === 'impl-1'
              ? { ...n, scope: 'TBD entire monorepo /home/ubuntu/secret' }
              : n,
          ),
        };
        const decision = evaluateLeafReadiness({ graph: hollow, nodeId: 'impl-1' });
        const scope = decision.checks.find((c) => c.code === 'repository_scope');
        expect(scope?.ok).toBe(false);
        expect(
          decision.reasons.some(
            (r) => r.code === 'scope_unknown' || r.code === 'scope_overbroad',
          ),
        ).toBe(true);
      });

    it('detects exclusive path conflict without allowed concurrency',
      () => {
        const graph = mustGraph({
          version: TASK_GRAPH_VERSION,
          id: 'graph-path-conflict',
          rationale: 'real path conflict',
          nodes: [
            node('obj-1', 'objective', {
              contract: contract({
                inputs: [],
                outputs: ['top-level-goal'],
                resources: [],
                acceptance: [{ kind: 'human', description: 'accept' }],
              }),
            }),
            node('impl-a', 'implementation', {
              goal: 'edit shared module from A',
              scope: 'src/shared/mod.ts',
              contract: contract({
                inputs: ['top-level-goal'],
                outputs: ['src/shared/mod.ts'],
                resources: [{ kind: 'path_lease', key: 'src/shared/mod.ts', exclusive: true }],
                acceptance: [{ kind: 'mechanical', description: 'pnpm test:unit -- a' }],
              }),
            }),
            node('impl-b', 'implementation', {
              goal: 'edit shared module from B',
              scope: 'src/shared/mod.ts',
              contract: contract({
                inputs: ['top-level-goal'],
                outputs: ['src/shared/mod.ts'],
                resources: [{ kind: 'path_lease', key: 'src/shared/mod.ts', exclusive: true }],
                acceptance: [{ kind: 'mechanical', description: 'pnpm test:unit -- b' }],
              }),
            }),
          ],
          edges: [
            edge('e-a', 'obj-1', 'impl-a'),
            edge('e-b', 'obj-1', 'impl-b'),
          ],
          integration: integration(),
        });
        const decision = evaluateLeafReadiness({ graph, nodeId: 'impl-a' });
        const conflict = decision.checks.find((c) => c.code === 'path_resource_conflict');
        expect(conflict?.ok).toBe(false);
        expect(decision.reasons.some((r) => r.code === 'path_conflict')).toBe(true);
        expect(decision.verdict).not.toBe('leaf_ready');
      });

    it('surfaces unresolved packet unknowns as dependency failures',
      () => {
        const graph = readyLeafGraph();
        const decision = evaluateLeafReadiness({
          graph,
          nodeId: 'impl-1',
          unknowns: [
            {
              source: 'declared',
              text: 'which adapter owns the critic UI surface',
              nodeId: 'impl-1',
            },
          ],
        });
        const dep = decision.checks.find((c) => c.code === 'unresolved_dependency');
        expect(dep?.ok).toBe(false);
        expect(decision.reasons.some((r) => r.code === 'unresolved_unknown')).toBe(true);
        expect(decision.verdict).toBe('investigation_required');
        expect(decision.proposedInvestigation).not.toBeNull();
      });
  });

describe('non-leaf output contract',
  () => {
    it('does not dispatch or mutate; reasons are bounded',
      () => {
        const { graph, nodeId } = fixtureUnderSplit();
        const decision = evaluateLeafReadiness({ graph, nodeId });
        expect(decision.mutatesGraph).toBe(false);
        expect(decision.authorizesDispatch).toBe(false);
        expect(leafReadinessAuthorizesDispatch(decision)).toBe(false);
        expect(leafReadinessMutatesAcceptedGraph(decision)).toBe(false);
        expect(leafReadinessMayEnterScheduling(decision)).toBe(false);
        for (const r of decision.reasons) {
          expect(r.detail.length).toBeLessThanOrEqual(400);
        }
        const inv = decision.proposedInvestigation;
        expect(inv).not.toBeNull();
        if (!inv) return;
        expect(inv.kind).toBe('investigation');
        expect(inv.goal.length).toBeGreaterThan(0);
        expect(inv.goal.length).toBeLessThanOrEqual(400);
        expect(graph.nodes.some((n) => n.id === inv.id)).toBe(false);
      });
  });

describe('digest binding and durability',
  () => {
    it('is digest-bound and restart-parseable from markdown',
      () => {
        const graph = readyLeafGraph();
        const a = evaluateLeafReadiness({ graph, nodeId: 'impl-1' });
        const b = evaluateLeafReadiness({ graph, nodeId: 'impl-1' });
        expect(a.decisionDigest).toBe(b.decisionDigest);
        expect(a.decisionDigest).toBe(leafReadinessDecisionDigest(a));
        const md = formatLeafReadinessDecisionMarkdown(a);
        expect(md).toContain(LEAF_READINESS_DECISION_HEADING);
        expect(md).toContain(LEAF_READINESS_BLOCK_START);
        expect(md).toMatch(/advisory/i);
        expect(md).toMatch(/does not (create|dispatch|mutate)/i);
        const again = parseLeafReadinessDecision(md);
        expect(again.ok).toBe(true);
        if (!again.ok) return;
        expect(again.decision.decisionDigest).toBe(a.decisionDigest);
        expect(serializeLeafReadinessDecision(again.decision)).toBe(
          serializeLeafReadinessDecision(a),
        );
      });

    it('fails closed when decision digest is tampered',
      () => {
        const graph = readyLeafGraph();
        const decision = evaluateLeafReadiness({ graph, nodeId: 'impl-1' });
        const md = formatLeafReadinessDecisionMarkdown(decision);
        const tampered = md.replace(decision.decisionDigest, 'b'.repeat(64));
        const parsed = parseLeafReadinessDecision(tampered);
        expect(parsed.ok).toBe(false);
      });

    it('buildLeafReadinessDecision rejects incomplete input fail-closed',
      () => {
        const bad = buildLeafReadinessDecision({ nodeId: 'x' });
        expect(bad.ok).toBe(false);
        expect(leafReadinessMayEnterScheduling(null)).toBe(false);
      });

    it('throws on missing decision document',
      () => {
        expect(() => parseLeafReadinessDecision('not a decision')).toThrow(
          LeafReadinessCriticError,
        );
      });
  });

describe('authority boundary — cannot weaken policy/leases/gates/human',
  () => {
    it('never weakens execution policy, leases, gates, or human approval',
      () => {
        const graph = readyLeafGraph();
        const decision = evaluateLeafReadiness({ graph, nodeId: 'impl-1' });
        expect(leafReadinessWeakensExecutionPolicy(decision)).toBe(false);
        expect(leafReadinessWeakensLeases(decision)).toBe(false);
        expect(leafReadinessWeakensGates(decision)).toBe(false);
        expect(leafReadinessWeakensHumanApproval(decision)).toBe(false);
        expect(leafReadinessAuthorizesDispatch(decision)).toBe(false);
        expect(leafReadinessMutatesAcceptedGraph(decision)).toBe(false);
        expect(decision.mode).toBe('advisory');
        expect(decision.verifiedWork).toBe(false);
        for (const action of TASK_GRAPH_RESERVED_HUMAN_ACTIONS) {
          expect(decision.authorizesDispatch).toBe(false);
          expect(String(action).length).toBeGreaterThan(0);
        }
      });

    it('non-leaf decisions still refuse scheduling and graph mutation',
      () => {
        const { graph, nodeId } = fixtureCyclicDiscovery();
        const decision = evaluateLeafReadiness({ graph, nodeId });
        expect(decision.verdict).toBe('investigation_required');
        expect(leafReadinessMayEnterScheduling(decision)).toBe(false);
        expect(leafReadinessAuthorizesDispatch(decision)).toBe(false);
        expect(leafReadinessMutatesAcceptedGraph(decision)).toBe(false);
        expect(leafReadinessWeakensExecutionPolicy(decision)).toBe(false);
        expect(leafReadinessWeakensLeases(decision)).toBe(false);
        expect(leafReadinessWeakensGates(decision)).toBe(false);
        expect(leafReadinessWeakensHumanApproval(decision)).toBe(false);
      });
  });

describe('observable outcome',
  () => {
    it('fails when goal is placeholder / non-observable',
      () => {
        const base = readyLeafGraph();
        const hollow: TaskGraph = {
          ...base,
          nodes: base.nodes.map((n) =>
            n.id === 'impl-1' ? { ...n, goal: 'TBD figure out later' } : n,
          ),
        };
        const decision = evaluateLeafReadiness({ graph: hollow, nodeId: 'impl-1' });
        const obs = decision.checks.find((c) => c.code === 'observable_outcome');
        expect(obs?.ok).toBe(false);
        expect(decision.reasons.some((r) => r.code === 'missing_observable_outcome')).toBe(
          true,
        );
      });
  });
