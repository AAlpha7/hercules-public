/** Proposed investigation node builder (advisory only). */
import { isValidIdentifier } from './task.js';
import {
  boundLeafText,
  type LeafReadinessReason,
  type ProposedInvestigationNode,
} from './leafReadinessCritic.js';

export function proposeInvestigation(
  nodeId: string,
  scope: string,
  reasons: readonly LeafReadinessReason[],
): ProposedInvestigationNode {
  const top = reasons.slice(0, 4).map((r) => r.code);
  const unknownToResolve = boundLeafText(
    reasons.map((r) => r.code + ': ' + r.detail).join('; ') || 'resolve leaf-readiness unknowns',
  );
  const rawId = 'inv-' + nodeId + '-leaf-ready';
  const id = isValidIdentifier(rawId) ? rawId : 'inv-leaf-ready';
  return {
    id,
    kind: 'investigation',
    title: boundLeafText('Resolve leaf readiness for ' + nodeId, 120),
    goal: boundLeafText(
      'Remove leaf-readiness blockers (' + top.join(', ') + ') before any dispatch of ' + nodeId,
    ),
    scope: boundLeafText(scope, 200),
    unknownToResolve,
    relatedNodeId: nodeId,
  };
}
