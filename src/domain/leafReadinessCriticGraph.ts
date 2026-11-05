/** Graph edge / concurrency helpers for leaf readiness. */
import type { TaskGraph, TaskGraphNode } from './taskGraph.js';
import { producersOf } from './leafReadinessCriticStruct.js';

export function hasEdge(graph: TaskGraph, from: string, to: string): boolean {
  return graph.edges.some((e) => e.from === from && e.to === to);
}

export function concurrencyAllowed(a: TaskGraphNode, b: TaskGraphNode): boolean {
  return (
    a.contract.allowedConcurrentNodeIds.includes(b.id) &&
    b.contract.allowedConcurrentNodeIds.includes(a.id)
  );
}

export function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

export function findHiddenCouplings(node: TaskGraphNode, graph: TaskGraph): string[] {
  const evidence: string[] = [];
  for (const input of node.contract.inputs) {
    for (const p of producersOf(input, graph)) {
      if (p.id === node.id) continue;
      if (!hasEdge(graph, p.id, node.id)) {
        evidence.push("input '" + input + "' produced by " + p.id + ' without edge');
      }
    }
  }
  return evidence;
}
