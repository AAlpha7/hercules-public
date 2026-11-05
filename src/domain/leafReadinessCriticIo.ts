/** IO adjacency and cycle detection for leaf readiness. */
import type { TaskGraph } from './taskGraph.js';
import { producersOf } from './leafReadinessCriticStruct.js';

export function buildIoAdjacency(graph: TaskGraph): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) adj.set(n.id, []);
  for (const consumer of graph.nodes) {
    for (const input of consumer.contract.inputs) {
      for (const producer of producersOf(input, graph)) {
        if (producer.id === consumer.id) continue;
        const list = adj.get(producer.id);
        if (list && !list.includes(consumer.id)) list.push(consumer.id);
      }
    }
  }
  return adj;
}

export function findCycleThrough(startId: string, adj: Map<string, string[]>): string[] | null {
  for (const mid of adj.get(startId) ?? []) {
    if ((adj.get(mid) ?? []).includes(startId)) return [startId, mid, startId];
  }
  const visited = new Set<string>();
  const path: string[] = [];
  const walk = (u: string): string[] | null => {
    if (path.includes(u)) return path.slice(path.indexOf(u)).concat(u);
    if (visited.has(u)) return null;
    visited.add(u);
    path.push(u);
    for (const v of adj.get(u) ?? []) {
      const cyc = walk(v);
      if (cyc) return cyc;
    }
    path.pop();
    return null;
  };
  return walk(startId);
}
