/** evaluateLeafReadiness implementation. */
import { taskGraphDigest } from './taskGraph.js';
import {
  LEAF_READINESS_CHECK_CODES,
  MAX_LEAF_READINESS_REASONS,
  boundLeafEvidence,
  boundLeafText,
  type LeafReadinessCheck,
  type LeafReadinessCriticInput,
  type LeafReadinessDecision,
  type LeafReadinessReason,
  type LeafReadinessVerdict,
} from './leafReadinessCritic.js';
import {
  isOverSplit,
  isUnderSplit,
  pushLeafReason,
  runLeafChecks,
} from './leafReadinessCriticChecks.js';
import { proposeInvestigation } from './leafReadinessCriticPropose.js';
import { makeLeafDecision } from './leafReadinessCriticDecision.js';

export function evaluateLeafReadiness(input: LeafReadinessCriticInput): LeafReadinessDecision {
  const graph = input.graph;
  const node = graph.nodes.find((n) => n.id === input.nodeId);
  const unknowns = input.unknowns ?? [];
  const external = input.externalClaims ?? [];
  const reasons: LeafReadinessReason[] = [];
  const graphDigest = taskGraphDigest(graph);

  if (!node) {
    pushLeafReason(reasons, 'unresolved_dependency', 'node id not present in graph', [
      input.nodeId,
    ]);
    const checks: LeafReadinessCheck[] = LEAF_READINESS_CHECK_CODES.map((code) => ({
      code,
      ok: false,
      detail: boundLeafText('node missing'),
      evidence: boundLeafEvidence([input.nodeId]),
    }));
    return makeLeafDecision({
      nodeId: input.nodeId,
      graphId: graph.id,
      graphDigest,
      verdict: 'investigation_required',
      checks,
      reasons,
      proposedInvestigation: proposeInvestigation(input.nodeId, 'graph', reasons),
    });
  }

  const checks = [...runLeafChecks(node, graph, unknowns, external, reasons)];
  if (isUnderSplit(node)) {
    pushLeafReason(
      reasons,
      'under_split',
      'node combines multiple independent behaviors or scopes; split by semantic boundary',
      [node.goal, node.scope, ...node.contract.outputs],
    );
  }
  if (isOverSplit(node, graph)) {
    pushLeafReason(
      reasons,
      'over_split',
      'node is split too thin (high fan-in, trivial goal, narrow scope); recombine context',
      [node.goal, String(graph.edges.filter((e) => e.to === node.id).length)],
    );
  }

  const checksFailed = checks.some((c) => !c.ok);
  let verdict: LeafReadinessVerdict = 'leaf_ready';
  if (reasons.some((r) => r.code === 'cyclic_discovery' || r.code === 'unresolved_unknown')) {
    verdict = 'investigation_required';
  } else if (reasons.length > 0 || checksFailed) {
    verdict = 'not_leaf';
  }

  return makeLeafDecision({
    nodeId: node.id,
    graphId: graph.id,
    graphDigest,
    verdict,
    checks,
    reasons: reasons.slice(0, MAX_LEAF_READINESS_REASONS),
    proposedInvestigation:
      verdict === 'leaf_ready' ? null : proposeInvestigation(node.id, node.scope, reasons),
  });
}
