/**
 * Proposed graph packet — advisory planner artifact (adaptive-task-graph step 2).
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
  PROPOSED_GRAPH_PACKET_VERSION,
  PROPOSED_GRAPH_PACKET_HEADING,
  PROPOSED_GRAPH_PACKET_BLOCK_START,
  ProposedGraphPacketError,
  buildProposedGraphPacket,
  proposedGraphPacketDigest,
  serializeProposedGraphPacket,
  parseProposedGraphPacket,
  formatProposedGraphPacketMarkdown,
  proposedGraphMayEnterScheduling,
  proposedGraphAuthorizesDispatch,
  proposedGraphAuthorizesChildTaskCreation,
  redactProposedGraphText,
  extractProofCommands,
  extractDeclaredUnknowns,
  extractOperatorDecisions,
} from '../../src/domain/proposedGraphPacket.js';

const RETRY: TaskGraphRetryPolicy = {
  maxAttempts: 3,
  backoffMs: 1000,
  rollbackDefined: true,
};

function contract(over: Partial<TaskGraphNodeContract> = {}): TaskGraphNodeContract {
  return {
    inputs: ['objective-brief'],
    outputs: ['artifact'],
    acceptance: [{ kind: 'mechanical', description: 'pnpm test:unit -- domain/taskGraph' }],
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

function sampleGraph(over: Partial<TaskGraph> = {}): TaskGraph {
  return {
    version: TASK_GRAPH_VERSION,
    id: 'graph-sample-1',
    rationale: 'split unknown then implement leaf',
    nodes: [
      node('obj-1', 'objective', {
        title: 'Ship advisory graph packet',
        goal: 'operators can review a proposed DAG without dispatch',
        contract: contract({
          inputs: [],
          outputs: ['top-level-goal'],
          resources: [],
          acceptance: [{ kind: 'human', description: 'operator accepts decomposition scope' }],
        }),
      }),
      node('inv-1', 'investigation', {
        title: 'Map existing packet patterns',
        goal: 'discover whether a packet renderer already exists',
        contract: contract({
          inputs: ['top-level-goal'],
          outputs: ['design-notes'],
          resources: [{ kind: 'concurrency_budget', key: 'investigate', exclusive: false }],
          acceptance: [{ kind: 'reviewer', description: 'design notes cite real modules' }],
        }),
      }),
      node('impl-1', 'implementation', {
        title: 'Render proposed graph packet',
        goal: 'durable advisory markdown from typed graph',
        contract: contract({
          inputs: ['design-notes'],
          outputs: ['src/domain/proposedGraphPacket.ts'],
          acceptance: [
            {
              kind: 'mechanical',
              description: 'pnpm test:unit -- domain/proposedGraphPacket',
              evidenceHook: 'unit-packet',
            },
            {
              kind: 'human',
              description: 'confirm packet is not treated as verified work',
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
    ...over,
  };
}

function validGraph(): TaskGraph {
  const result = validateTaskGraph(sampleGraph());
  if (!result.ok) throw new Error('fixture graph invalid');
  return result.graph;
}

describe('buildProposedGraphPacket content', () => {
  it('binds graph digest and surfaces objective through render', () => {
    const graph = validGraph();
    const built = buildProposedGraphPacket({
      graph,
      unknowns: [
        'whether phone UI should host the packet yet',
        'See /home/ubuntu/secret/worktree for local notes',
      ],
      notes: 'provider dump: Bearer sk-abc123xyz and path /Users/dev/hercules/log.txt',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const p = built.packet;
    expect(p.version).toBe(PROPOSED_GRAPH_PACKET_VERSION);
    expect(p.kind).toBe('proposed_graph');
    expect(p.mode).toBe('advisory');
    expect(p.verifiedWork).toBe(false);
    expect(p.graphDigest).toBe(taskGraphDigest(graph));
    expect(p.unknowns.some((u) => u.source === 'investigation_node')).toBe(true);
    expect(p.unknowns.some((u) => u.text.includes('phone UI'))).toBe(true);
    expect(p.unknowns.every((u) => !u.text.includes('/home/ubuntu'))).toBe(true);

    const md = formatProposedGraphPacketMarkdown(p);
    expect(md).toContain('### Objective');
    expect(md).toContain('Ship advisory graph packet');
    expect(md).toContain('### Node contracts');
    expect(md).toContain('### Dependencies');
    expect(md).toContain('### Resources');
    expect(md).toContain('### Proof commands');
    expect(md).toContain('pnpm test:unit');
    expect(md).toContain('pnpm check:full');
    expect(md).toContain('### Unknowns');
    expect(md).toContain('### Top-level integration check');
    expect(md).toContain('### Operator decisions');
    expect(md).toMatch(/advisory/i);
    expect(md).toMatch(/not verified work/i);
    expect(md).toMatch(/does not (create|dispatch)/i);
    expect(md).not.toContain('/Users/dev');
    expect(md).not.toContain('sk-abc123xyz');
  });
});

describe('digest binding and restart safety', () => {
  it('is digest-bound and restart-parseable', () => {
    const graph = validGraph();
    const a = buildProposedGraphPacket({ graph, unknowns: ['u1'] });
    const b = buildProposedGraphPacket({ graph, unknowns: ['u1'] });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.packet.packetDigest).toBe(b.packet.packetDigest);
    expect(a.packet.packetDigest).toBe(proposedGraphPacketDigest(a.packet));
    const md = formatProposedGraphPacketMarkdown(a.packet);
    expect(md).toContain(PROPOSED_GRAPH_PACKET_HEADING);
    expect(md).toContain(PROPOSED_GRAPH_PACKET_BLOCK_START);
    const again = parseProposedGraphPacket(md);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.packet.packetDigest).toBe(a.packet.packetDigest);
    expect(serializeProposedGraphPacket(again.packet)).toBe(
      serializeProposedGraphPacket(a.packet),
    );
  });

  it('fails closed when embedded digest is tampered', () => {
    const graph = validGraph();
    const built = buildProposedGraphPacket({ graph });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const md = formatProposedGraphPacketMarkdown(built.packet);
    const tampered = md.replace(built.packet.packetDigest, 'a'.repeat(64));
    const parsed = parseProposedGraphPacket(tampered);
    expect(parsed.ok).toBe(false);
  });
});

describe('extractors', () => {
  it('extracts mechanical proof commands and declared unknowns', () => {
    const graph = validGraph();
    const proof = extractProofCommands(graph);
    expect(proof.some((c) => c.command.includes('pnpm test:unit'))).toBe(true);
    expect(proof.some((c) => c.nodeId === 'integration')).toBe(true);
    const declared = extractDeclaredUnknowns(['open question', '', 42, '/home/ubuntu/x']);
    expect(declared).toHaveLength(2);
    expect(declared.every((u) => u.source === 'declared')).toBe(true);
    expect(declared.every((u) => !u.text.includes('/home/ubuntu'))).toBe(true);
  });
});

describe('redaction', () => {
  it('redacts host paths and provider secrets', () => {
    const raw =
      'trace at /home/ubuntu/hercules-work/task-1/src/x.ts only path leakage';
    const clean = redactProposedGraphText(raw);
    expect(clean).not.toContain('/home/ubuntu');
    expect(clean).toContain('[host-path]');
    const secrets = 'provider dump Bearer sk-live-abcdef012345 token=supersecret';
    const cleanSecrets = redactProposedGraphText(secrets);
    expect(cleanSecrets).not.toContain('sk-live-abcdef012345');
    expect(cleanSecrets).not.toContain('supersecret');
  });
});

describe('fail closed', () => {
  it('rejects invalid graphs', () => {
    const bad = buildProposedGraphPacket({
      graph: { version: 1, id: 'bad', rationale: '', nodes: [], edges: [] },
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(proposedGraphMayEnterScheduling(bad)).toBe(false);
  });

  it('rejects incomplete envelope', () => {
    const bad = buildProposedGraphPacket({ unknowns: ['x'] });
    expect(bad.ok).toBe(false);
    expect(proposedGraphMayEnterScheduling(null)).toBe(false);
  });

  it('rejects cycles', () => {
    const cyclic = sampleGraph({
      edges: [
        edge('e1', 'obj-1', 'inv-1'),
        edge('e2', 'inv-1', 'impl-1'),
        edge('e3', 'impl-1', 'obj-1'),
      ],
    });
    const bad = buildProposedGraphPacket({ graph: cyclic });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.some((e) => e.code === 'cycle')).toBe(true);
  });

  it('throws on missing packet document', () => {
    expect(() => parseProposedGraphPacket('not a packet')).toThrow(ProposedGraphPacketError);
  });
});

describe('authority boundary', () => {
  it('never authorizes scheduling, dispatch, or child creation', () => {
    const graph = validGraph();
    const built = buildProposedGraphPacket({ graph });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(proposedGraphMayEnterScheduling(built.packet)).toBe(false);
    expect(proposedGraphAuthorizesDispatch(built.packet)).toBe(false);
    expect(proposedGraphAuthorizesChildTaskCreation(built.packet)).toBe(false);
    const decisions = extractOperatorDecisions(graph, built.packet.unknowns);
    expect(decisions.some((d) => d.kind === 'reserved_human_action')).toBe(true);
    expect(decisions.some((d) => d.kind === 'human_acceptance')).toBe(true);
    expect(decisions.some((d) => d.text.includes('merge'))).toBe(true);
    // Packet mode is advisory only — never verified work, never a dispatch grant.
    expect(built.packet.mode).toBe('advisory');
    expect(built.packet.verifiedWork).toBe(false);
  });
});
