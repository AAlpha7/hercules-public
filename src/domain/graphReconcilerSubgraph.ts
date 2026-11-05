/** Affected-subgraph helpers for graph reconciler. */
import type { TaskGraph, TaskGraphNode } from './taskGraph.js';
import {
  GRAPH_NODE_EVIDENCE_STATUSES,
  MAX_GRAPH_RECONCILER_EVIDENCE,
  type GraphNodeEvidence,
  type GraphNodeEvidenceStatus,
} from './graphReconcilerTypes.js';

export function isNodeEvidenceStatus(v: unknown): v is GraphNodeEvidenceStatus {
  return typeof v === 'string' && (GRAPH_NODE_EVIDENCE_STATUSES as readonly string[]).includes(v);
}

export function pushUniqueId(list: string[], id: string): void {
  if (!list.includes(id)) list.push(id);
}

export function nodeMap(graph: TaskGraph): Map<string, TaskGraphNode> {
  return new Map(graph.nodes.map((n) => [n.id, n]));
}

export function dependentsOf(graph: TaskGraph, id: string): string[] {
  return graph.edges.filter((e) => e.from === id).map((e) => e.to);
}

export function leaseKeysFor(node: TaskGraphNode): string[] {
  return node.contract.resources
    .filter((r) => r.kind === 'path_lease' || r.kind === 'branch_lease')
    .map((r) => r.key);
}

export function evidenceMap(
  evidence: readonly GraphNodeEvidence[],
): Map<string, GraphNodeEvidence> {
  const m = new Map<string, GraphNodeEvidence>();
  for (const e of evidence.slice(0, MAX_GRAPH_RECONCILER_EVIDENCE)) {
    if (typeof e.nodeId === 'string' && isNodeEvidenceStatus(e.status)) m.set(e.nodeId, e);
  }
  return m;
}

export function statusOf(
  map: Map<string, GraphNodeEvidence>,
  nodeId: string,
): GraphNodeEvidenceStatus {
  return map.get(nodeId)?.status ?? 'pending';
}

export function computeAffectedSubgraph(
  graph: TaskGraph,
  map: Map<string, GraphNodeEvidence>,
): Set<string> {
  const seeds = new Set<string>();
  for (const n of graph.nodes) {
    if (n.kind === 'objective') continue;
    const st = statusOf(map, n.id);
    if (st === 'failed' || st === 'uncertain' || st === 'blocked') seeds.add(n.id);
    const ev = map.get(n.id);
    if (!ev) continue;
    for (const c of ev.discoveredCouplingNodeIds ?? []) seeds.add(c);
    for (const c of ev.discoveredCycleNodeIds ?? []) seeds.add(c);
    if ((ev.discoveredCouplingNodeIds?.length ?? 0) > 0) seeds.add(n.id);
    if ((ev.discoveredCycleNodeIds?.length ?? 0) > 0) seeds.add(n.id);
  }
  const affected = new Set<string>(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined) break;
    for (const d of dependentsOf(graph, cur)) {
      if (affected.has(d)) continue;
      if (statusOf(map, d) === 'accepted') continue;
      affected.add(d);
      queue.push(d);
    }
  }
  return affected;
}
