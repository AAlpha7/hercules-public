/** Structural under/over-split helpers for leaf readiness. */
import type { TaskGraph, TaskGraphNode } from './taskGraph.js';

export function isUnderSplit(node: TaskGraphNode): boolean {
  if (node.kind === 'objective') return false;
  const goal = node.goal;
  if (/\bAND\b/.test(goal) || /\s+and\s+.*\s+and\s+/i.test(goal)) return true;
  const pathOutputs = node.contract.outputs.filter((o) => o.includes('/') || o.includes('.'));
  const pathRoots = new Set(pathOutputs.map((o) => o.split('/')[0] ?? o));
  if (pathRoots.size >= 3) return true;
  const parts = node.scope.split(/[;,]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3) return true;
  const hasDeploy =
    node.contract.resources.some((r) => r.kind === 'deploy_lock') ||
    /\bdeploy\b/i.test(goal) ||
    pathOutputs.some((o) => o.startsWith('deploy'));
  const hasMultiCode =
    pathRoots.size >= 2 ||
    (node.contract.acceptance.filter((a) => a.kind === 'mechanical').length >= 2 &&
      /\band\b/i.test(goal));
  return hasDeploy && hasMultiCode;
}

export function isOverSplit(node: TaskGraphNode, graph: TaskGraph): boolean {
  if (node.kind !== 'implementation') return false;
  const fanIn = graph.edges.filter((e) => e.to === node.id).length;
  const trivialGoal =
    /\b(tweak|nit|rename|alias only|tiny|minor)\b/i.test(node.goal) ||
    (node.goal.length <= 40 && /\brename\b/i.test(node.goal));
  const narrowScope =
    !node.scope.includes(';') &&
    !node.scope.includes(',') &&
    (node.scope.match(/\//g) ?? []).length >= 1;
  return fanIn >= 3 && trivialGoal && narrowScope && node.contract.inputs.length >= 3;
}

export function producersOf(token: string, graph: TaskGraph): readonly TaskGraphNode[] {
  return graph.nodes.filter((n) => n.contract.outputs.includes(token));
}

