/** buildLeafReadinessDecision from untyped planner input. */
import { validateTaskGraph } from './taskGraph.js';
import type { ProposedGraphUnknown } from './proposedGraphPacket.js';
import {
  boundLeafText,
  leafReadinessIssue,
  type LeafReadinessBuildResult,
} from './leafReadinessCritic.js';
import { evaluateLeafReadiness } from './leafReadinessCriticEvalRun.js';

export function buildLeafReadinessDecision(input: unknown): LeafReadinessBuildResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      errors: [leafReadinessIssue('schema', 'leaf readiness input must be an object')],
    };
  }
  const o = input as Record<string, unknown>;
  if (typeof o['nodeId'] !== 'string' || o['nodeId'].length === 0) {
    return { ok: false, errors: [leafReadinessIssue('schema', 'nodeId is required')] };
  }
  if (o['graph'] === undefined || o['graph'] === null) {
    return { ok: false, errors: [leafReadinessIssue('schema', 'graph is required')] };
  }
  const validated = validateTaskGraph(o['graph']);
  if (!validated.ok) return { ok: false, errors: validated.errors };
  const unknowns: ProposedGraphUnknown[] = [];
  if (Array.isArray(o['unknowns'])) {
    for (const item of o['unknowns']) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
      const u = item as Record<string, unknown>;
      if (u['source'] !== 'declared' && u['source'] !== 'investigation_node') continue;
      if (typeof u['text'] !== 'string') continue;
      const text = boundLeafText(u['text']);
      if (text.length === 0) continue;
      if (typeof u['nodeId'] === 'string' && u['nodeId'].length > 0) {
        unknowns.push({ source: u['source'], text, nodeId: u['nodeId'] });
      } else {
        unknowns.push({ source: u['source'], text });
      }
    }
  }
  return {
    ok: true,
    decision: evaluateLeafReadiness({
      graph: validated.graph,
      nodeId: o['nodeId'],
      unknowns,
    }),
  };
}
