/** Pure check helpers for leaf-readiness critic. */
import type { TaskGraph, TaskGraphNode } from './taskGraph.js';
import type { ProposedGraphUnknown } from './proposedGraphPacket.js';
import {
  boundLeafEvidence,
  boundLeafText,
  type LeafReadinessCheck,
  type LeafReadinessExternalClaim,
  type LeafReadinessReason,
  type LeafReadinessReasonCode,
} from './leafReadinessCritic.js';
import { pushLeafReason } from './leafReadinessCriticPush.js';
import { isUnderSplit } from './leafReadinessCriticStruct.js';
import { findHiddenCouplings } from './leafReadinessCriticGraph.js';
import { findPathResourceConflicts } from './leafReadinessCriticConflict.js';
import { buildIoAdjacency, findCycleThrough } from './leafReadinessCriticIo.js';

export { pushLeafReason } from './leafReadinessCriticPush.js';
export { isUnderSplit, isOverSplit } from './leafReadinessCriticStruct.js';

function isPlaceholderGoal(goal: string): boolean {
  const g = goal.trim();
  if (g.length === 0) return true;
  if (/\b(tbd|todo|unknown|figure out later|not sure|\?\?\?)\b/i.test(g)) return true;
  if (/^(tbd|todo|unknown)\b/i.test(g)) return true;
  return false;
}

function hasIndependentProof(node: TaskGraphNode): boolean {
  return node.contract.acceptance.some(
    (a) => a.kind === 'mechanical' || a.kind === 'reviewer' || a.kind === 'integration',
  );
}

function scopeLooksUnknown(scope: string): boolean {
  const s = scope.trim();
  if (s.length === 0) return true;
  if (/\b(tbd|todo|unknown|entire monorepo|whole repo|all files)\b/i.test(s)) return true;
  if (s.startsWith('/') || s.startsWith('~') || /^[A-Za-z]:/.test(s)) return true;
  if (s.includes('://') || /\/home\/|\/Users\/|\/var\/|\/tmp\//.test(s)) return true;
  return false;
}

export function runLeafChecks(
  node: TaskGraphNode,
  graph: TaskGraph,
  unknowns: readonly ProposedGraphUnknown[],
  external: readonly LeafReadinessExternalClaim[],
  reasons: LeafReadinessReason[],
): readonly LeafReadinessCheck[] {
  const checks: LeafReadinessCheck[] = [];

  if (isPlaceholderGoal(node.goal) || node.contract.outputs.length === 0) {
    pushLeafReason(
      reasons,
      'missing_observable_outcome',
      'node lacks a clear observable outcome (placeholder goal or empty outputs)',
      [node.goal, ...node.contract.outputs],
    );
    checks.push({
      code: 'observable_outcome',
      ok: false,
      detail: boundLeafText('observable outcome missing or placeholder'),
      evidence: boundLeafEvidence([node.goal]),
    });
  } else {
    checks.push({
      code: 'observable_outcome',
      ok: true,
      detail: boundLeafText('goal and outputs declare an observable change'),
      evidence: boundLeafEvidence([node.goal, ...node.contract.outputs.slice(0, 3)]),
    });
  }

  if (!hasIndependentProof(node)) {
    pushLeafReason(
      reasons,
      'missing_independent_proof',
      'node has no mechanical/reviewer/integration acceptance for independent proof',
      node.contract.acceptance.map((a) => a.kind + ':' + a.description),
    );
    checks.push({
      code: 'independent_proof',
      ok: false,
      detail: boundLeafText('independent proof missing'),
      evidence: boundLeafEvidence(node.contract.acceptance.map((a) => a.kind)),
    });
  } else {
    const proof = node.contract.acceptance
      .filter((a) => a.kind === 'mechanical' || a.kind === 'reviewer' || a.kind === 'integration')
      .map((a) => a.kind + ':' + a.description);
    checks.push({
      code: 'independent_proof',
      ok: true,
      detail: boundLeafText('independent proof declared'),
      evidence: boundLeafEvidence(proof),
    });
  }

  if (node.kind !== 'objective' && node.contract.inputs.length === 0) {
    pushLeafReason(
      reasons,
      'missing_declared_inputs',
      'non-objective node must declare inputs before dispatch',
      [node.id],
    );
    checks.push({
      code: 'declared_inputs',
      ok: false,
      detail: boundLeafText('declared inputs missing'),
      evidence: boundLeafEvidence([node.id]),
    });
  } else {
    checks.push({
      code: 'declared_inputs',
      ok: true,
      detail: boundLeafText(
        node.contract.inputs.length === 0 ? 'objective may have empty inputs' : 'inputs declared',
      ),
      evidence: boundLeafEvidence(node.contract.inputs),
    });
  }

  if (scopeLooksUnknown(node.scope)) {
    const code: LeafReadinessReasonCode = /entire monorepo|whole repo|all files/i.test(node.scope)
      ? 'scope_overbroad'
      : 'scope_unknown';
    pushLeafReason(reasons, code, 'repository scope is unknown, absolute, or host-path', [
      node.scope,
    ]);
    checks.push({
      code: 'repository_scope',
      ok: false,
      detail: boundLeafText('repository scope invalid'),
      evidence: boundLeafEvidence([node.scope]),
    });
  } else if (isUnderSplit(node) && node.kind === 'implementation') {
    const parts = node.scope.split(/[;,]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 3) {
      pushLeafReason(reasons, 'scope_overbroad', 'scope spans multiple repository roots', [
        node.scope,
      ]);
      checks.push({
        code: 'repository_scope',
        ok: false,
        detail: boundLeafText('repository scope overbroad for a leaf'),
        evidence: boundLeafEvidence([node.scope]),
      });
    } else {
      checks.push({
        code: 'repository_scope',
        ok: true,
        detail: boundLeafText('repository scope is bounded and relative'),
        evidence: boundLeafEvidence([node.scope]),
      });
    }
  } else {
    checks.push({
      code: 'repository_scope',
      ok: true,
      detail: boundLeafText('repository scope is bounded and relative'),
      evidence: boundLeafEvidence([node.scope]),
    });
  }

  const { path, resource } = findPathResourceConflicts(node, graph, external);
  if (path.length > 0) {
    pushLeafReason(reasons, 'path_conflict', 'exclusive path/branch lease conflicts with peers', path);
  }
  if (resource.length > 0) {
    pushLeafReason(reasons, 'resource_conflict', 'exclusive resource conflicts with peers', resource);
  }
  checks.push({
    code: 'path_resource_conflict',
    ok: path.length === 0 && resource.length === 0,
    detail: boundLeafText(
      path.length === 0 && resource.length === 0
        ? 'no unresolved path/resource conflicts'
        : 'path/resource conflicts',
    ),
    evidence: boundLeafEvidence([...path, ...resource]),
  });

  const evidence: string[] = [];
  const hidden = findHiddenCouplings(node, graph);
  if (hidden.length > 0) {
    pushLeafReason(
      reasons,
      'hidden_coupling',
      'node consumes outputs without declared dependency edges',
      hidden,
    );
    pushLeafReason(
      reasons,
      'unresolved_dependency',
      'hidden coupling implies unresolved dependency edges',
      hidden,
    );
    evidence.push(...hidden);
  }
  const blockingUnknowns = unknowns.filter((u) => u.nodeId === node.id);
  if (blockingUnknowns.length > 0) {
    const texts = blockingUnknowns.map((u) => u.text);
    pushLeafReason(reasons, 'unresolved_unknown', 'node has unresolved declared unknowns', texts);
    evidence.push(...texts);
  }
  const cycle = findCycleThrough(node.id, buildIoAdjacency(graph));
  if (cycle && cycle.length > 0) {
    pushLeafReason(
      reasons,
      'cyclic_discovery',
      'IO coupling forms a discovery cycle: ' + cycle.join(' -> '),
      cycle,
    );
    evidence.push('cycle:' + cycle.join('->'));
  }
  checks.push({
    code: 'unresolved_dependency',
    ok: hidden.length === 0 && blockingUnknowns.length === 0 && !cycle,
    detail: boundLeafText(
      hidden.length === 0 && blockingUnknowns.length === 0 && !cycle
        ? 'dependencies resolved'
        : 'unresolved dependencies or unknowns',
    ),
    evidence: boundLeafEvidence(evidence),
  });

  return checks;
}
