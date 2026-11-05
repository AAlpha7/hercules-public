/** Serialize / format / parse graph reconciler results (pure, advisory). */
import type { TaskGraphReservedHumanAction } from './taskGraph.js';
import {
  GRAPH_INTEGRATION_STATUSES,
  GRAPH_RECONCILER_BLOCK_END,
  GRAPH_RECONCILER_BLOCK_START,
  GRAPH_RECONCILER_HEADING,
  GRAPH_RECONCILER_OVERALL_VERDICTS,
  GRAPH_RECONCILER_VERSION,
  GraphReconcilerError,
  LOCAL_REPLAN_ACTION_KINDS,
  MAX_GRAPH_RECONCILER_RESULT_BYTES,
  boundReconcilerText,
  graphReconcilerResultDigest,
  sortReconcilerKeysDeep,
  type GraphAcceptedProvenance,
  type GraphIntegrationStatus,
  type GraphReconcilerOverallVerdict,
  type GraphReconcilerParseResult,
  type GraphReconcilerResult,
  type IntegrationAcceptanceStatus,
  type LocalReplanAction,
  type LocalReplanActionKind,
  type ProposedReplanInvestigation,
  type TopLevelIntegrationAssessment,
} from './graphReconcilerTypes.js';

function isOverall(v: unknown): v is GraphReconcilerOverallVerdict {
  return (
    typeof v === 'string' && (GRAPH_RECONCILER_OVERALL_VERDICTS as readonly string[]).includes(v)
  );
}

function isIntegrationStatus(v: unknown): v is GraphIntegrationStatus {
  return typeof v === 'string' && (GRAPH_INTEGRATION_STATUSES as readonly string[]).includes(v);
}

function isActionKind(v: unknown): v is LocalReplanActionKind {
  return typeof v === 'string' && (LOCAL_REPLAN_ACTION_KINDS as readonly string[]).includes(v);
}

function isSha(v: string): boolean {
  return v.length === 64 && /^[0-9a-f]+$/.test(v);
}

export function serializeGraphReconcilerResult(result: GraphReconcilerResult): string {
  const body = {
    version: result.version,
    kind: result.kind,
    mode: result.mode,
    verifiedWork: false as const,
    mutatesGraph: false as const,
    authorizesDispatch: false as const,
    authorizesMerge: false as const,
    authorizesDeploy: false as const,
    authorizesPermissionChange: false as const,
    autoAppliesHumanDecisions: false as const,
    autoDispatchesReplan: false as const,
    graphId: result.graphId,
    graphDigest: result.graphDigest,
    evaluatedAtMs: result.evaluatedAtMs,
    overallVerdict: result.overallVerdict,
    localReplan: result.localReplan,
    integration: result.integration,
    reservedHumanActions: result.reservedHumanActions,
    visibleFailures: result.visibleFailures,
    visibleUncertainties: result.visibleUncertainties,
    resultDigest: result.resultDigest,
  };
  return JSON.stringify(sortReconcilerKeysDeep(body)) + '\n';
}

export function formatGraphReconcilerResultMarkdown(result: GraphReconcilerResult): string {
  const rd = result.resultDigest.slice(0, 12);
  const gd = result.graphDigest.slice(0, 12);
  const lines: string[] = [
    GRAPH_RECONCILER_HEADING,
    '',
    GRAPH_RECONCILER_BLOCK_START,
    serializeGraphReconcilerResult(result).trimEnd(),
    GRAPH_RECONCILER_BLOCK_END,
    '',
    '**Mode:** `advisory` — local replan + top-level integration packet.',
    'It does not dispatch replanned nodes, mutate the accepted graph, or auto-apply',
    'merge, deploy, or permission changes.',
    '',
    '- **Graph id:** `' + result.graphId + '`',
    '- **Graph digest:** `' + gd + '…`',
    '- **Result digest:** `' + rd + '…`',
    '- **Overall verdict:** `' + result.overallVerdict + '`',
    '- **Verified work:** `false`',
    '- **Mutates graph:** `false`',
    '- **Authorizes dispatch:** `false`',
    '- **Auto-dispatches replan:** `false`',
    '- **Auto-applies human decisions:** `false`',
    '',
    '### Local replan (affected subgraph only)',
    '',
    '- **Affected:** ' + (
      result.localReplan.affectedNodeIds.length === 0
        ? '_none_'
        : result.localReplan.affectedNodeIds.map((id) => '`' + id + '`').join(', ')
    ),
    '- **Preserved:** ' + (
      result.localReplan.preservedNodeIds.length === 0
        ? '_none_'
        : result.localReplan.preservedNodeIds.map((id) => '`' + id + '`').join(', ')
    ),
    '- **Preserved leases:** ' + (
      result.localReplan.preservedLeaseKeys.length === 0
        ? '_none_'
        : result.localReplan.preservedLeaseKeys.map((k) => '`' + k + '`').join(', ')
    ),
    '- **Limited to affected subgraph:** `true`',
    '',
  ];
  for (const a of result.localReplan.actions) {
    lines.push(
      '- `' + a.nodeId + '` → **' + a.kind + '**'
        + (a.investigationId ? ' (inv `' + a.investigationId + '`)' : '')
        + ' — ' + a.reason,
    );
  }
  if (result.localReplan.proposedInvestigations.length > 0) {
    lines.push('', '### Proposed investigations (not inserted)', '');
    for (const inv of result.localReplan.proposedInvestigations) {
      lines.push('- `' + inv.id + '` — ' + inv.title + ' [' + inv.reasonCodes.join(', ') + ']');
    }
  }
  lines.push('', '### Top-level integration (objective ≠ child green)', '');
  lines.push('- **Objective:** `' + result.integration.objectiveNodeId + '`');
  lines.push('- **Goal:** ' + result.integration.objectiveGoal);
  lines.push('- **Integration status:** `' + result.integration.status + '`');
  lines.push(
    '- **Children all accepted:** `'
      + String(result.integration.childSummary.allChildrenAccepted) + '`',
  );
  lines.push('- **Children green is not success:** `true`');
  lines.push('- **Detail:** ' + result.integration.detail);
  for (const a of result.integration.acceptance) {
    lines.push('  - [' + a.kind + '/' + a.status + '] ' + a.description);
  }
  lines.push('', '### Visible failures / uncertainties', '');
  if (result.visibleFailures.length === 0) lines.push('- _No node failures._');
  else for (const f of result.visibleFailures) lines.push('- **Failure:** ' + f);
  if (result.visibleUncertainties.length === 0) lines.push('- _No uncertainties._');
  else for (const u of result.visibleUncertainties) lines.push('- **Uncertain:** ' + u);
  lines.push('', '### Reserved human actions (never auto-applied)', '');
  for (const a of result.reservedHumanActions) {
    lines.push('- `' + a + '` — requires explicit human decision');
  }
  lines.push(
    '',
    '_End of advisory graph reconciler / integration packet. Does not dispatch or mutate._',
    '',
  );
  return lines.join('\n');
}

function normalizeAction(raw: unknown): LocalReplanAction | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!isActionKind(o['kind']) || typeof o['nodeId'] !== 'string' || typeof o['reason'] !== 'string') {
    return null;
  }
  const base: LocalReplanAction = {
    kind: o['kind'],
    nodeId: o['nodeId'],
    reason: boundReconcilerText(o['reason']),
  };
  if (typeof o['investigationId'] === 'string') {
    return { ...base, investigationId: o['investigationId'] };
  }
  if (typeof o['humanAction'] === 'string') {
    return {
      ...base,
      humanAction: o['humanAction'] as TaskGraphReservedHumanAction | 'product_judgement',
    };
  }
  return base;
}

function normalizeInvestigation(raw: unknown): ProposedReplanInvestigation | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (
    typeof o['id'] !== 'string'
    || o['kind'] !== 'investigation'
    || typeof o['title'] !== 'string'
    || typeof o['goal'] !== 'string'
    || typeof o['scope'] !== 'string'
    || typeof o['unknownToResolve'] !== 'string'
    || !Array.isArray(o['relatedNodeIds'])
    || !Array.isArray(o['reasonCodes'])
  ) {
    return null;
  }
  return {
    id: o['id'],
    kind: 'investigation',
    title: boundReconcilerText(o['title'], 120),
    goal: boundReconcilerText(o['goal']),
    scope: boundReconcilerText(o['scope'], 200),
    unknownToResolve: boundReconcilerText(o['unknownToResolve']),
    relatedNodeIds: o['relatedNodeIds'].filter((x): x is string => typeof x === 'string'),
    reasonCodes: o['reasonCodes'].filter((x): x is string => typeof x === 'string'),
  };
}

function normalizeProvenance(raw: unknown): GraphAcceptedProvenance | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (
    typeof o['nodeId'] !== 'string'
    || typeof o['evidenceDigest'] !== 'string'
    || !Array.isArray(o['leaseKeys'])
  ) {
    return null;
  }
  return {
    nodeId: o['nodeId'],
    evidenceDigest: o['evidenceDigest'],
    leaseKeys: o['leaseKeys'].filter((x): x is string => typeof x === 'string'),
  };
}

function normalizeIntegration(raw: unknown): TopLevelIntegrationAssessment | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (
    typeof o['objectiveNodeId'] !== 'string'
    || typeof o['objectiveGoal'] !== 'string'
    || o['requiresTopLevelVerification'] !== true
    || !isIntegrationStatus(o['status'])
    || !Array.isArray(o['acceptance'])
    || o['childrenGreenIsNotSuccess'] !== true
    || typeof o['detail'] !== 'string'
    || o['childSummary'] === null
    || typeof o['childSummary'] !== 'object'
    || Array.isArray(o['childSummary'])
  ) {
    return null;
  }
  const cs = o['childSummary'] as Record<string, unknown>;
  const strArr = (k: string): string[] =>
    Array.isArray(cs[k]) ? cs[k].filter((x): x is string => typeof x === 'string') : [];
  if (typeof cs['allChildrenAccepted'] !== 'boolean') return null;
  const acceptance: IntegrationAcceptanceStatus[] = [];
  for (const item of o['acceptance']) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
    const a = item as Record<string, unknown>;
    if (typeof a['kind'] !== 'string' || typeof a['description'] !== 'string') return null;
    if (
      a['status'] !== 'unproven'
      && a['status'] !== 'passed'
      && a['status'] !== 'failed'
      && a['status'] !== 'uncertain'
      && a['status'] !== 'human_required'
    ) {
      return null;
    }
    acceptance.push({
      kind: a['kind'] as IntegrationAcceptanceStatus['kind'],
      description: boundReconcilerText(a['description']),
      status: a['status'],
      ...(typeof a['evidenceHook'] === 'string' ? { evidenceHook: a['evidenceHook'] } : {}),
    });
  }
  return {
    objectiveNodeId: o['objectiveNodeId'],
    objectiveGoal: boundReconcilerText(o['objectiveGoal']),
    requiresTopLevelVerification: true,
    status: o['status'],
    acceptance,
    childSummary: {
      accepted: strArr('accepted'),
      failed: strArr('failed'),
      uncertain: strArr('uncertain'),
      pending: strArr('pending'),
      running: strArr('running'),
      blocked: strArr('blocked'),
      allChildrenAccepted: cs['allChildrenAccepted'],
    },
    childrenGreenIsNotSuccess: true,
    detail: boundReconcilerText(o['detail']),
  };
}

export function parseGraphReconcilerResult(markdown: string): GraphReconcilerParseResult {
  if (typeof markdown !== 'string' || markdown.trim().length === 0) {
    throw new GraphReconcilerError('missing graph reconciler document');
  }
  if (markdown.length > MAX_GRAPH_RECONCILER_RESULT_BYTES) {
    throw new GraphReconcilerError('graph reconciler document exceeds bound');
  }
  const start = markdown.indexOf(GRAPH_RECONCILER_BLOCK_START);
  const end = markdown.indexOf(GRAPH_RECONCILER_BLOCK_END);
  if (start < 0 || end < 0 || end <= start) {
    throw new GraphReconcilerError('missing graph reconciler document');
  }
  const jsonText = markdown.slice(start + GRAPH_RECONCILER_BLOCK_START.length, end).trim();
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return { ok: false, errors: [{ code: 'schema', message: 'graph reconciler JSON parse failed' }] };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [{ code: 'schema', message: 'graph reconciler body invalid' }] };
  }
  const o = raw as Record<string, unknown>;
  if (
    o['version'] !== GRAPH_RECONCILER_VERSION
    || o['kind'] !== 'graph_reconciler_integration_packet'
    || o['mode'] !== 'advisory'
    || o['verifiedWork'] !== false
    || o['mutatesGraph'] !== false
    || o['authorizesDispatch'] !== false
    || o['authorizesMerge'] !== false
    || o['authorizesDeploy'] !== false
    || o['authorizesPermissionChange'] !== false
    || o['autoAppliesHumanDecisions'] !== false
    || o['autoDispatchesReplan'] !== false
    || typeof o['graphId'] !== 'string'
    || typeof o['graphDigest'] !== 'string'
    || !isSha(o['graphDigest'])
    || typeof o['evaluatedAtMs'] !== 'number'
    || !isOverall(o['overallVerdict'])
    || typeof o['resultDigest'] !== 'string'
    || !isSha(o['resultDigest'])
    || o['localReplan'] === null
    || typeof o['localReplan'] !== 'object'
    || Array.isArray(o['localReplan'])
    || !Array.isArray(o['reservedHumanActions'])
    || !Array.isArray(o['visibleFailures'])
    || !Array.isArray(o['visibleUncertainties'])
  ) {
    return { ok: false, errors: [{ code: 'schema', message: 'graph reconciler fields invalid' }] };
  }
  const lr = o['localReplan'] as Record<string, unknown>;
  if (
    !Array.isArray(lr['affectedNodeIds'])
    || !Array.isArray(lr['preservedNodeIds'])
    || !Array.isArray(lr['preservedLeaseKeys'])
    || !Array.isArray(lr['preservedProvenance'])
    || !Array.isArray(lr['actions'])
    || !Array.isArray(lr['proposedInvestigations'])
    || lr['mutatesAcceptedGraph'] !== false
    || lr['authorizesDispatch'] !== false
    || lr['limitedToAffectedSubgraph'] !== true
  ) {
    return { ok: false, errors: [{ code: 'schema', message: 'local replan fields invalid' }] };
  }
  const actions = lr['actions']
    .map(normalizeAction)
    .filter((x): x is LocalReplanAction => x !== null);
  if (actions.length !== lr['actions'].length) {
    return { ok: false, errors: [{ code: 'schema', message: 'local replan actions invalid' }] };
  }
  const proposedInvestigations = lr['proposedInvestigations']
    .map(normalizeInvestigation)
    .filter((x): x is ProposedReplanInvestigation => x !== null);
  if (proposedInvestigations.length !== lr['proposedInvestigations'].length) {
    return { ok: false, errors: [{ code: 'schema', message: 'proposed investigations invalid' }] };
  }
  const preservedProvenance = lr['preservedProvenance']
    .map(normalizeProvenance)
    .filter((x): x is GraphAcceptedProvenance => x !== null);
  if (preservedProvenance.length !== lr['preservedProvenance'].length) {
    return { ok: false, errors: [{ code: 'schema', message: 'preserved provenance invalid' }] };
  }
  const integration = normalizeIntegration(o['integration']);
  if (integration === null) {
    return { ok: false, errors: [{ code: 'schema', message: 'integration assessment invalid' }] };
  }
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
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
    graphId: o['graphId'] as string,
    graphDigest: o['graphDigest'] as string,
    evaluatedAtMs: o['evaluatedAtMs'] as number,
    overallVerdict: o['overallVerdict'] as GraphReconcilerOverallVerdict,
    localReplan: {
      affectedNodeIds: strArr(lr['affectedNodeIds']),
      preservedNodeIds: strArr(lr['preservedNodeIds']),
      preservedLeaseKeys: strArr(lr['preservedLeaseKeys']),
      preservedProvenance,
      actions,
      proposedInvestigations,
      mutatesAcceptedGraph: false as const,
      authorizesDispatch: false as const,
      limitedToAffectedSubgraph: true as const,
    },
    integration,
    reservedHumanActions: strArr(o['reservedHumanActions']) as TaskGraphReservedHumanAction[],
    visibleFailures: strArr(o['visibleFailures']).map((s) => boundReconcilerText(s)),
    visibleUncertainties: strArr(o['visibleUncertainties']).map((s) => boundReconcilerText(s)),
  };
  const expected = graphReconcilerResultDigest(withoutDigest);
  if (expected !== o['resultDigest']) {
    return { ok: false, errors: [{ code: 'schema', message: 'graph reconciler resultDigest mismatch' }] };
  }
  return { ok: true, result: { ...withoutDigest, resultDigest: expected } };
}
