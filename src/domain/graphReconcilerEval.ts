/** Evaluate local replan + top-level integration packet (pure, advisory). */
import { isValidIdentifier } from './task.js';
import { taskGraphDigest, validateTaskGraph, type TaskGraph } from './taskGraph.js';
import {
  GRAPH_RECONCILER_VERSION, GraphReconcilerError, MAX_GRAPH_RECONCILER_ACTIONS,
  MAX_GRAPH_RECONCILER_REASONS, boundReconcilerText, graphReconcilerResultDigest,
  type GraphAcceptedProvenance, type GraphIntegrationEvidence, type GraphIntegrationStatus,
  type GraphNodeEvidence, type GraphReconcilerInput, type GraphReconcilerOverallVerdict,
  type GraphReconcilerResult, type IntegrationAcceptanceStatus, type LocalReplanAction,
  type LocalReplanProposal, type ProposedReplanInvestigation, type TopLevelIntegrationAssessment,
} from './graphReconcilerTypes.js';
import {
  computeAffectedSubgraph, evidenceMap, leaseKeysFor, nodeMap, pushUniqueId, statusOf,
} from './graphReconcilerSubgraph.js';

function invId(related: string, tag: string): string {
  const raw = 'inv-' + related + '-' + tag;
  return isValidIdentifier(raw) ? raw : 'inv-replan';
}

function mkInv(
  id: string, _nodeId: string, title: string, goal: string, scope: string,
  unknown: string, related: readonly string[], codes: readonly string[],
): ProposedReplanInvestigation {
  return {
    id, kind: 'investigation',
    title: boundReconcilerText(title, 120), goal: boundReconcilerText(goal),
    scope: boundReconcilerText(scope, 200), unknownToResolve: boundReconcilerText(unknown),
    relatedNodeIds: [...related], reasonCodes: [...codes],
  };
}

function act(
  kind: LocalReplanAction['kind'], nodeId: string, reason: string, investigationId?: string,
): LocalReplanAction {
  if (investigationId !== undefined) {
    return { kind, nodeId, reason: boundReconcilerText(reason), investigationId };
  }
  return { kind, nodeId, reason: boundReconcilerText(reason) };
}

/** Every id in any cycle/coupling discovery (plus reporter) is investigation-required. */
function collectCycleAndCouplingParticipants(
  map: Map<string, GraphNodeEvidence>,
): { cycleRelated: Map<string, string[]>; couplingRelated: Map<string, string[]> } {
  const cycleRelated = new Map<string, string[]>();
  const couplingRelated = new Map<string, string[]>();
  const merge = (target: Map<string, string[]>, related: readonly string[]): void => {
    const sorted = [...new Set(related)].sort();
    for (const id of sorted) {
      const prev = target.get(id) ?? [];
      target.set(id, [...new Set([...prev, ...sorted])].sort());
    }
  };
  for (const [nodeId, ev] of map) {
    const cycleIds = ev.discoveredCycleNodeIds ?? [];
    if (cycleIds.length > 0) merge(cycleRelated, [nodeId, ...cycleIds]);
    const couplingIds = ev.discoveredCouplingNodeIds ?? [];
    if (couplingIds.length > 0) merge(couplingRelated, [nodeId, ...couplingIds]);
  }
  return { cycleRelated, couplingRelated };
}

function buildActions(
  graph: TaskGraph, map: Map<string, GraphNodeEvidence>, affected: Set<string>,
): { actions: LocalReplanAction[]; investigations: ProposedReplanInvestigation[] } {
  const byId = nodeMap(graph);
  const actions: LocalReplanAction[] = [];
  const investigations: ProposedReplanInvestigation[] = [];
  const invSeen = new Set<string>();
  const { cycleRelated, couplingRelated } = collectCycleAndCouplingParticipants(map);
  const addInv = (inv: ProposedReplanInvestigation): void => {
    if (invSeen.has(inv.id)) return;
    invSeen.add(inv.id);
    investigations.push(inv);
  };
  const push = (a: LocalReplanAction): void => {
    if (actions.length < MAX_GRAPH_RECONCILER_ACTIONS) actions.push(a);
  };
  for (const nodeId of [...affected].sort()) {
    const node = byId.get(nodeId);
    if (!node || node.kind === 'objective') continue;
    const ev = map.get(nodeId);
    const st = statusOf(map, nodeId);
    // Peers named in any discovery are investigation-required - never speculative retry.
    const cyclePeers = cycleRelated.get(nodeId);
    if (cyclePeers !== undefined && cyclePeers.length > 0) {
      const id = invId(nodeId, 'cycle');
      const related = cyclePeers;
      addInv(mkInv(id, nodeId, 'Investigate cycle involving ' + nodeId,
        'Resolve cyclic dependency before any retry of ' + related.join(', '),
        node.scope, 'cycle among ' + related.join(', '), related, ['cyclic_discovery']));
      push(act('require_investigation', nodeId,
        'cycle discovered - investigation required, not speculative retry', id));
      continue;
    }
    const couplingPeers = couplingRelated.get(nodeId);
    if (couplingPeers !== undefined && couplingPeers.length > 0) {
      const id = invId(nodeId, 'coupling');
      const related = couplingPeers;
      addInv(mkInv(id, nodeId, 'Investigate coupling involving ' + nodeId,
        'Map discovered coupling before re-dispatch of ' + related.join(', '),
        node.scope, 'coupling ' + related.join(', '), related, ['hidden_coupling']));
      push(act('require_investigation', nodeId,
        'discovered coupling - investigation required, not speculative retry', id));
      continue;
    }
    if (st === 'failed') {
      const attempts = ev?.attemptCount ?? 0;
      const max = node.contract.retry.maxAttempts;
      if (attempts < max && node.contract.retry.rollbackDefined) {
        push(act('retry', nodeId, 'bounded retry ' + String(attempts + 1) + '/' + String(max)));
      } else {
        const id = invId(nodeId, 'exhausted');
        addInv(mkInv(id, nodeId, 'Investigate exhausted retries for ' + nodeId,
          'Diagnose persistent failure of ' + nodeId, node.scope,
          ev?.failureDetail ?? 'retry budget exhausted', [nodeId], ['retry_exhausted']));
        push(act('require_investigation', nodeId,
          'retry budget exhausted - investigation required, not speculative retry', id));
      }
      continue;
    }
    if (st === 'uncertain') {
      const id = invId(nodeId, 'uncertain');
      addInv(mkInv(id, nodeId, 'Resolve uncertainty for ' + nodeId,
        'Make failure/uncertainty visible for ' + nodeId, node.scope,
        ev?.failureDetail ?? 'node evidence is uncertain', [nodeId], ['uncertain_evidence']));
      push(act('require_investigation', nodeId,
        'uncertain evidence remains visible - investigation required', id));
      continue;
    }
    if (st === 'blocked') {
      push(act('hold_for_integration', nodeId, 'blocked - hold; no auto-dispatch'));
      continue;
    }
    if (st === 'accepted') {
      push(act('accept', nodeId, 'accepted evidence retained inside affected set'));
      continue;
    }
    push(act('hold_for_integration', nodeId, 'pending/running - no speculative replan dispatch'));
  }
  return { actions, investigations };
}

function buildLocalReplan(
  graph: TaskGraph,
  map: Map<string, GraphNodeEvidence>,
  provenance: readonly GraphAcceptedProvenance[],
): LocalReplanProposal {
  const affected = computeAffectedSubgraph(graph, map);
  const preservedNodeIds: string[] = [];
  const preservedLeaseKeys: string[] = [];
  const preservedProvenance: GraphAcceptedProvenance[] = [];
  const provById = new Map(provenance.map((p) => [p.nodeId, p]));
  for (const n of graph.nodes) {
    if (n.kind === 'objective' || affected.has(n.id) || statusOf(map, n.id) !== 'accepted') continue;
    pushUniqueId(preservedNodeIds, n.id);
    for (const k of leaseKeysFor(n)) pushUniqueId(preservedLeaseKeys, k);
    const p = provById.get(n.id);
    if (p) {
      preservedProvenance.push({
        nodeId: p.nodeId, evidenceDigest: p.evidenceDigest, leaseKeys: [...p.leaseKeys],
      });
    } else {
      const dig = map.get(n.id)?.evidenceDigest;
      if (typeof dig === 'string' && dig.length > 0) {
        preservedProvenance.push({ nodeId: n.id, evidenceDigest: dig, leaseKeys: leaseKeysFor(n) });
      }
    }
  }
  for (const p of provenance) {
    if (affected.has(p.nodeId)) continue;
    if (statusOf(map, p.nodeId) === 'accepted') pushUniqueId(preservedNodeIds, p.nodeId);
    for (const k of p.leaseKeys) pushUniqueId(preservedLeaseKeys, k);
  }
  const { actions, investigations } = buildActions(graph, map, affected);
  for (const id of preservedNodeIds.sort()) {
    if (actions.length >= MAX_GRAPH_RECONCILER_ACTIONS) break;
    actions.push(act('preserve', id, 'accepted unaffected node - preserve leases and provenance'));
  }
  return {
    affectedNodeIds: [...affected].sort(),
    preservedNodeIds: preservedNodeIds.sort(),
    preservedLeaseKeys: preservedLeaseKeys.sort(),
    preservedProvenance: preservedProvenance.sort((a, b) =>
      a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0),
    actions: actions.slice(0, MAX_GRAPH_RECONCILER_ACTIONS),
    proposedInvestigations: investigations,
    mutatesAcceptedGraph: false,
    authorizesDispatch: false,
    limitedToAffectedSubgraph: true,
  };
}

function buildIntegration(
  graph: TaskGraph,
  map: Map<string, GraphNodeEvidence>,
  integrationEvidence: GraphIntegrationEvidence | undefined,
): TopLevelIntegrationAssessment {
  const accepted: string[] = [];
  const failed: string[] = [];
  const uncertain: string[] = [];
  const pending: string[] = [];
  const running: string[] = [];
  const blocked: string[] = [];
  for (const n of graph.nodes) {
    if (n.kind === 'objective') continue;
    const st = statusOf(map, n.id);
    if (st === 'accepted') accepted.push(n.id);
    else if (st === 'failed') failed.push(n.id);
    else if (st === 'uncertain') uncertain.push(n.id);
    else if (st === 'running') running.push(n.id);
    else if (st === 'blocked') blocked.push(n.id);
    else pending.push(n.id);
  }
  const children = graph.nodes.filter((n) => n.kind !== 'objective');
  const allChildrenAccepted =
    children.length > 0 && children.every((n) => statusOf(map, n.id) === 'accepted');
  const childSummary = {
    accepted: accepted.sort(), failed: failed.sort(), uncertain: uncertain.sort(),
    pending: pending.sort(), running: running.sort(), blocked: blocked.sort(),
    allChildrenAccepted,
  };
  const objective = graph.nodes.find((n) => n.id === graph.integration.objectiveNodeId);
  const objectiveGoal = objective?.goal ?? graph.rationale;
  const raw = integrationEvidence?.status ?? 'unproven';
  let status: GraphIntegrationStatus;
  if (!allChildrenAccepted) {
    if (raw === 'passed') status = 'blocked_by_children';
    else if (raw === 'failed') status = 'failed';
    else if (raw === 'uncertain') status = 'uncertain';
    else status = failed.length > 0 || uncertain.length > 0 ? 'blocked_by_children' : 'unproven';
  } else if (raw === 'passed') status = 'passed';
  else if (raw === 'failed') status = 'failed';
  else if (raw === 'uncertain') status = 'uncertain';
  else status = 'unproven';
  const acceptance: IntegrationAcceptanceStatus[] = graph.integration.acceptance.map((a) => {
    if (a.kind === 'human') {
      return {
        kind: a.kind, description: boundReconcilerText(a.description),
        status: 'human_required' as const,
        ...(a.evidenceHook !== undefined ? { evidenceHook: a.evidenceHook } : {}),
      };
    }
    const itemStatus: IntegrationAcceptanceStatus['status'] =
      status === 'passed' ? 'passed'
        : status === 'failed' ? 'failed'
          : status === 'uncertain' ? 'uncertain' : 'unproven';
    return {
      kind: a.kind, description: boundReconcilerText(a.description), status: itemStatus,
      ...(a.evidenceHook !== undefined ? { evidenceHook: a.evidenceHook } : {}),
    };
  });
  let detail: string;
  if (status === 'passed') {
    detail = 'top-level objective re-verified independently of child green status';
  } else if (status === 'failed') {
    detail = integrationEvidence?.detail
      ?? 'top-level integration proof failed - child success does not greenwash';
  } else if (status === 'uncertain') {
    detail = integrationEvidence?.detail ?? 'top-level integration remains uncertain';
  } else if (status === 'blocked_by_children') {
    detail = 'integration blocked: not all children accepted; objective remains unproven';
  } else if (allChildrenAccepted) {
    detail = 'all children accepted but top-level objective still unproven (children green is not success)';
  } else {
    detail = 'top-level objective unproven; waiting on children and/or integration evidence';
  }
  return {
    objectiveNodeId: graph.integration.objectiveNodeId,
    objectiveGoal: boundReconcilerText(objectiveGoal),
    requiresTopLevelVerification: true,
    status, acceptance, childSummary,
    childrenGreenIsNotSuccess: true,
    detail: boundReconcilerText(detail),
  };
}

function overallVerdict(
  replan: LocalReplanProposal, integration: TopLevelIntegrationAssessment,
): GraphReconcilerOverallVerdict {
  if (replan.actions.some((a) => a.kind === 'escalate_human')) return 'needs_human';
  if (replan.actions.some((a) => a.kind === 'require_investigation' || a.kind === 'retry')) {
    return 'needs_replan';
  }
  if (integration.status === 'failed') return 'integration_failed';
  if (integration.status === 'uncertain') return 'integration_uncertain';
  if (integration.status === 'passed' && integration.childSummary.allChildrenAccepted) {
    if (integration.acceptance.some((a) => a.status === 'human_required')) return 'needs_human';
    return 'objective_proven';
  }
  if (
    integration.childSummary.allChildrenAccepted
    && (integration.status === 'unproven' || integration.status === 'blocked_by_children')
  ) {
    return 'awaiting_integration';
  }
  return 'in_progress';
}

export function evaluateGraphReconciler(input: GraphReconcilerInput): GraphReconcilerResult {
  const validated = validateTaskGraph(input.graph);
  if (!validated.ok) {
    throw new GraphReconcilerError(
      validated.errors[0]?.message ?? 'invalid graph', validated.errors,
    );
  }
  const graph = validated.graph;
  if (typeof input.evaluatedAtMs !== 'number' || !Number.isFinite(input.evaluatedAtMs)) {
    throw new GraphReconcilerError('evaluatedAtMs required');
  }
  const map = evidenceMap(input.nodeEvidence);
  const localReplan = buildLocalReplan(graph, map, input.acceptedProvenance ?? []);
  const integration = buildIntegration(graph, map, input.integrationEvidence);
  const failures: string[] = [];
  const uncertainties: string[] = [];
  for (const n of graph.nodes) {
    if (n.kind === 'objective') continue;
    const ev = map.get(n.id);
    const st = statusOf(map, n.id);
    if (st === 'failed') {
      failures.push(boundReconcilerText(
        n.id + ': ' + (ev?.failureDetail ?? ev?.failureKind ?? 'failed'),
      ));
    } else if (st === 'uncertain') {
      uncertainties.push(boundReconcilerText(
        n.id + ': ' + (ev?.failureDetail ?? 'uncertain evidence'),
      ));
    }
  }
  if (integration.status === 'failed') {
    failures.push(boundReconcilerText('integration: ' + integration.detail));
  } else if (integration.status === 'uncertain') {
    uncertainties.push(boundReconcilerText('integration: ' + integration.detail));
  } else if (integration.childSummary.allChildrenAccepted && integration.status === 'unproven') {
    uncertainties.push(boundReconcilerText(
      'integration: children green but objective unproven (no greenwash)',
    ));
  }
  const withoutDigest = {
    version: GRAPH_RECONCILER_VERSION,
    kind: 'graph_reconciler_integration_packet' as const,
    mode: 'advisory' as const,
    verifiedWork: false as const,
    mutatesGraph: false as const,
    authorizesDispatch: false as const,
    authorizesMerge: false as const,
    authorizesDeploy: false as const,
    authorizesPermissionChange: false as const,
    autoAppliesHumanDecisions: false as const,
    autoDispatchesReplan: false as const,
    graphId: graph.id,
    graphDigest: taskGraphDigest(graph),
    evaluatedAtMs: input.evaluatedAtMs,
    overallVerdict: overallVerdict(localReplan, integration),
    localReplan,
    integration,
    reservedHumanActions: [...graph.integration.reservedHumanActions],
    visibleFailures: failures.slice(0, MAX_GRAPH_RECONCILER_REASONS),
    visibleUncertainties: uncertainties.slice(0, MAX_GRAPH_RECONCILER_REASONS),
  };
  return { ...withoutDigest, resultDigest: graphReconcilerResultDigest(withoutDigest) };
}
