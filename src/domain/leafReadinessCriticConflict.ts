/** Path/resource conflict detection for leaf readiness. */
import type { TaskGraph, TaskGraphNode } from './taskGraph.js';
import type { LeafReadinessExternalClaim } from './leafReadinessCritic.js';
import { concurrencyAllowed, pathsOverlap } from './leafReadinessCriticGraph.js';

export function findPathResourceConflicts(
  node: TaskGraphNode,
  graph: TaskGraph,
  external: readonly LeafReadinessExternalClaim[],
): { path: string[]; resource: string[] } {
  const pathEvidence: string[] = [];
  const resourceEvidence: string[] = [];
  for (const res of node.contract.resources) {
    if (!res.exclusive) continue;
    for (const other of graph.nodes) {
      if (other.id === node.id || concurrencyAllowed(node, other)) continue;
      for (const oRes of other.contract.resources) {
        if (!oRes.exclusive || oRes.kind !== res.kind || !pathsOverlap(res.key, oRes.key)) continue;
        const ev = res.kind + ':' + res.key + ' conflicts with node ' + other.id;
        if (res.kind === 'path_lease' || res.kind === 'branch_lease') pathEvidence.push(ev);
        else resourceEvidence.push(ev);
      }
    }
    for (const ext of external) {
      if (!ext.exclusive || ext.kind !== res.kind || !pathsOverlap(res.key, ext.key)) continue;
      if (ext.holderId) {
        const peer = graph.nodes.find((n) => n.id === ext.holderId);
        if (peer && concurrencyAllowed(node, peer)) continue;
      }
      const holder = ext.holderId ?? 'external';
      const ev = res.kind + ':' + res.key + ' conflicts with external ' + holder;
      if (res.kind === 'path_lease' || res.kind === 'branch_lease') pathEvidence.push(ev);
      else resourceEvidence.push(ev);
    }
  }
  return { path: pathEvidence, resource: resourceEvidence };
}
