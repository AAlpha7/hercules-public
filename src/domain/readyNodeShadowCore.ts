/** Evaluate + serialize ready-node shadow schedules (pure, advisory). */
import type { TaskGraph, TaskGraphNode, TaskGraphResourceKind } from './taskGraph.js';
import { taskGraphDigest, validateTaskGraph } from './taskGraph.js';
import { concurrencyAllowed, pathsOverlap } from './leafReadinessCriticGraph.js';
import { buildIoAdjacency, findCycleThrough } from './leafReadinessCriticIo.js';
import {
  MAX_READY_NODE_REASONS, MAX_READY_NODE_RESULT_BYTES, READY_NODE_BLOCK_CODES,
  READY_NODE_SHADOW_BLOCK_END, READY_NODE_SHADOW_BLOCK_START,
  READY_NODE_SHADOW_HEADING, READY_NODE_SHADOW_VERSION, READY_NODE_VERDICTS,
  ReadyNodeShadowSchedulerError, boundReadyNodeText, readyNodeShadowResultDigest,
  sortReadyNodeKeysDeep,
  type LinearScheduleObservation, type ReadyNodeBlockCode,
  type ReadyNodeDependencyStatus, type ReadyNodeExplanation,
  type ReadyNodeLeafVerdict, type ReadyNodeLinearComparison,
  type ReadyNodeResourceClaim, type ReadyNodeResourceStatus,
  type ReadyNodeRepoConcurrency, type ReadyNodeRuntimeSnapshot,
  type ReadyNodeShadowBuildResult, type ReadyNodeShadowInput,
  type ReadyNodeShadowParseResult, type ReadyNodeShadowResult,
  type ReadyNodeTaskBudget, type ReadyNodeVerdict,
} from './readyNodeShadowTypes.js';

function pushReason(rs: string[], text: string): void {
  if (rs.length >= MAX_READY_NODE_REASONS) return;
  const t = boundReadyNodeText(text);
  if (t.length > 0 && !rs.includes(t)) rs.push(t);
}
function pushCode(cs: ReadyNodeBlockCode[], c: ReadyNodeBlockCode): void {
  if (!cs.includes(c)) cs.push(c);
}
function preds(g: TaskGraph, id: string): string[] {
  return g.edges.filter((e) => e.to === id).map((e) => e.from);
}
function resBlock(k: TaskGraphResourceKind): ReadyNodeBlockCode {
  if (k === 'path_lease') return 'path_lease_conflict';
  if (k === 'branch_lease') return 'branch_lease_conflict';
  if (k === 'env_lock') return 'env_lock_conflict';
  if (k === 'deploy_lock') return 'deploy_lock_conflict';
  if (k === 'concurrency_budget') return 'repo_concurrency_cap';
  return 'build_cache_pressure';
}

type Held = {
  kind: TaskGraphResourceKind; key: string; exclusive: boolean;
  holderId: string; holderNode: TaskGraphNode | null;
};

function collectHeld(g: TaskGraph, rt: ReadyNodeRuntimeSnapshot, extra: readonly string[]): Held[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const held: Held[] = [];
  for (const c of rt.externalClaims) {
    held.push({ kind: c.kind, key: c.key, exclusive: c.exclusive,
      holderId: c.holderId, holderNode: byId.get(c.holderId) ?? null });
  }
  for (const id of new Set([...rt.runningNodeIds, ...extra])) {
    const n = byId.get(id);
    if (!n) continue;
    for (const r of n.contract.resources) {
      held.push({ kind: r.kind, key: r.key, exclusive: r.exclusive, holderId: n.id, holderNode: n });
    }
  }
  return held;
}

function resourceConflicts(
  node: TaskGraphNode, held: readonly Held[], pressure: ReadyNodeRuntimeSnapshot['buildCachePressure'],
): { codes: ReadyNodeBlockCode[]; resources: ReadyNodeResourceStatus[]; reasons: string[] } {
  const codes: ReadyNodeBlockCode[] = [];
  const resources: ReadyNodeResourceStatus[] = [];
  const reasons: string[] = [];
  for (const res of node.contract.resources) {
    if (res.kind === 'build_cache' && pressure === 'critical') {
      pushCode(codes, 'build_cache_pressure');
      resources.push({ kind: res.kind, key: res.key, exclusive: res.exclusive, status: 'pressure' });
      pushReason(reasons, 'build_cache ' + res.key + ' blocked under critical cache pressure');
      continue;
    }
    if (res.kind === 'build_cache' && pressure === 'warn') {
      resources.push({ kind: res.kind, key: res.key, exclusive: res.exclusive, status: 'pressure' });
      pushReason(reasons, 'build_cache ' + res.key + ' under warn pressure (still eligible)');
      continue;
    }
    let status: ReadyNodeResourceStatus['status'] = 'free';
    for (const h of held) {
      if (h.holderId === node.id || h.kind !== res.kind) continue;
      if (!pathsOverlap(res.key, h.key)) continue;
      if (!res.exclusive && !h.exclusive) continue;
      if (h.holderNode && concurrencyAllowed(node, h.holderNode)) continue;
      status = 'conflict';
      pushCode(codes, resBlock(res.kind));
      pushReason(reasons, res.kind + ':' + res.key + ' conflicts with holder ' + h.holderId);
      break;
    }
    resources.push({ kind: res.kind, key: res.key, exclusive: res.exclusive, status });
  }
  return { codes, resources, reasons };
}

function repoCapBlocks(
  node: TaskGraphNode, rt: ReadyNodeRuntimeSnapshot, admitted: readonly string[], g: TaskGraph,
): { blocked: boolean; reason: string | null } {
  const budgets = node.contract.resources.filter((r) => r.kind === 'concurrency_budget');
  if (budgets.length === 0) return { blocked: false, reason: null };
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  for (const b of budgets) {
    const cfg = rt.repoConcurrency.find((c) => c.key === b.key);
    if (!cfg) continue;
    const shares = (id: string) => {
      const o = byId.get(id);
      return !!o && o.contract.resources.some((r) => r.kind === 'concurrency_budget' && r.key === b.key);
    };
    const used = Math.max(cfg.currentRunning, rt.runningNodeIds.filter(shares).length) + admitted.filter(shares).length;
    if (used >= cfg.maxConcurrent) {
      return { blocked: true, reason: 'repo concurrency_budget ' + b.key + ' at cap ' + String(cfg.maxConcurrent) + ' (used ' + String(used) + ')' };
    }
  }
  return { blocked: false, reason: null };
}

function budgetBlocks(node: TaskGraphNode, rt: ReadyNodeRuntimeSnapshot): { blocked: boolean; reason: string | null } {
  if (rt.globalBudgetRemaining === 0) return { blocked: true, reason: 'global task budget remaining is 0' };
  const hit = (rt.taskBudgets ?? []).find((b) => b.nodeId === node.id);
  if (!hit) return { blocked: false, reason: null };
  if (hit.remainingUnits < hit.requiredUnits) {
    return { blocked: true, reason: 'task budget exhausted for ' + node.id };
  }
  return { blocked: false, reason: null };
}

type BaseEval = {
  verdict: ReadyNodeVerdict; blockCodes: ReadyNodeBlockCode[]; reasons: string[];
  dependencies: ReadyNodeDependencyStatus[]; resourcesConsidered: ReadyNodeResourceStatus[];
  eligibleForAdmission: boolean;
};

function evaluateNodeBase(
  node: TaskGraphNode, graph: TaskGraph, rt: ReadyNodeRuntimeSnapshot,
  leafVerdicts: readonly ReadyNodeLeafVerdict[] | undefined, ioAdj: Map<string, string[]>,
): BaseEval {
  const blockCodes: ReadyNodeBlockCode[] = [];
  const reasons: string[] = [];
  const completed = new Set(rt.completedNodeIds);
  const running = new Set(rt.runningNodeIds);
  if (node.kind === 'objective') {
    pushCode(blockCodes, 'objective_not_schedulable');
    pushReason(reasons, 'objective nodes are not worker-schedulable');
    return { verdict: 'skipped_objective', blockCodes, reasons, dependencies: [], resourcesConsidered: [], eligibleForAdmission: false };
  }
  if (completed.has(node.id)) {
    pushCode(blockCodes, 'already_completed');
    pushReason(reasons, 'node already completed');
    return { verdict: 'completed', blockCodes, reasons, dependencies: [], resourcesConsidered: [], eligibleForAdmission: false };
  }
  if (running.has(node.id)) {
    pushCode(blockCodes, 'already_running');
    pushReason(reasons, 'node already running');
    return { verdict: 'running', blockCodes, reasons, dependencies: [], resourcesConsidered: [], eligibleForAdmission: false };
  }
  const deps: ReadyNodeDependencyStatus[] = [];
  let hard = false;
  const cycle = findCycleThrough(node.id, ioAdj);
  if (cycle && cycle.length > 0) {
    hard = true;
    pushCode(blockCodes, 'cyclic_dependency');
    pushReason(reasons, 'cyclic dependency/discovery: ' + cycle.join(' -> '));
    for (const id of cycle) if (id !== node.id) deps.push({ nodeId: id, status: 'cyclic' });
  }
  for (const pred of preds(graph, node.id)) {
    if (completed.has(pred)) deps.push({ nodeId: pred, status: 'satisfied' });
    else if (!graph.nodes.some((n) => n.id === pred)) {
      hard = true; deps.push({ nodeId: pred, status: 'missing' });
      pushCode(blockCodes, 'unresolved_dependency'); pushReason(reasons, 'missing dependency ' + pred);
    } else {
      hard = true; deps.push({ nodeId: pred, status: 'unresolved' });
      pushCode(blockCodes, 'unresolved_dependency'); pushReason(reasons, 'unresolved dependency ' + pred);
    }
  }
  const leaf = leafVerdicts && leafVerdicts.length > 0
    ? (leafVerdicts.find((v) => v.nodeId === node.id)?.verdict ?? 'unknown') : 'unknown';
  if (leaf !== 'leaf_ready') {
    hard = true; pushCode(blockCodes, 'not_leaf_ready');
    pushReason(reasons, 'leaf readiness verdict is ' + leaf + ' (require leaf_ready)');
  }
  const budget = budgetBlocks(node, rt);
  if (budget.blocked) {
    hard = true; pushCode(blockCodes, 'task_budget_exhausted');
    if (budget.reason) pushReason(reasons, budget.reason);
  }
  const res = resourceConflicts(node, collectHeld(graph, rt, []), rt.buildCachePressure);
  for (const c of res.codes) pushCode(blockCodes, c);
  for (const r of res.reasons) pushReason(reasons, r);
  const eligible = !hard && res.codes.length === 0;
  return {
    verdict: eligible ? 'recommend' : 'blocked', blockCodes, reasons,
    dependencies: deps, resourcesConsidered: res.resources, eligibleForAdmission: eligible,
  };
}

function buildComparison(
  recommended: readonly string[], linear: LinearScheduleObservation | undefined,
  explanations: readonly ReadyNodeExplanation[],
): ReadyNodeLinearComparison | null {
  if (!linear) return null;
  const shadow = [...recommended].sort();
  const lin = [...new Set(linear.dispatchedNodeIds)].sort();
  const sSet = new Set(shadow); const lSet = new Set(lin);
  const both = shadow.filter((id) => lSet.has(id));
  const shadowOnly = shadow.filter((id) => !lSet.has(id));
  const linearOnly = lin.filter((id) => !sSet.has(id));
  const blocked = new Set(explanations.filter((e) => e.verdict === 'blocked' || e.verdict === 'skipped_objective').map((e) => e.nodeId));
  const conflicts = [...new Set(linear.conflictNodeIds ?? [])].sort();
  const rework = [...new Set(linear.reworkNodeIds ?? [])].sort();
  const linearConflictsAlsoBlockedByShadow = conflicts.filter((id) => blocked.has(id));
  const linearReworkAlsoBlockedByShadow = rework.filter((id) => blocked.has(id));
  const union = new Set([...shadow, ...lin]);
  const agreementRatio = union.size === 0 ? 1 : both.length / union.size;
  const notes: string[] = [];
  pushReason(notes, 'shadow recommended ' + String(shadow.length) + '; linear dispatched ' + String(lin.length) + '; agreement ' + (agreementRatio * 100).toFixed(0) + '%');
  if (linearConflictsAlsoBlockedByShadow.length) pushReason(notes, 'shadow would have blocked linear conflict nodes: ' + linearConflictsAlsoBlockedByShadow.join(', '));
  if (linearReworkAlsoBlockedByShadow.length) pushReason(notes, 'shadow would have blocked linear rework nodes: ' + linearReworkAlsoBlockedByShadow.join(', '));
  if (shadowOnly.length) pushReason(notes, 'shadow-only recommendations: ' + shadowOnly.join(', '));
  if (linearOnly.length) pushReason(notes, 'linear-only dispatches: ' + linearOnly.join(', '));
  return { shadowRecommended: shadow, linearDispatched: lin, both, shadowOnly, linearOnly, linearConflictsAlsoBlockedByShadow, linearReworkAlsoBlockedByShadow, agreementRatio, notes };
}

/** Evaluate a shadow ready-node / resource schedule. Pure. Does not dispatch. */
export function evaluateReadyNodeShadowSchedule(input: ReadyNodeShadowInput): ReadyNodeShadowResult {
  const graph = input.graph; const rt = input.runtime;
  const ioAdj = buildIoAdjacency(graph);
  const nodeBase = new Map<string, BaseEval>();
  for (const n of graph.nodes) nodeBase.set(n.id, evaluateNodeBase(n, graph, rt, input.leafVerdicts, ioAdj));
  const candidates = graph.nodes.filter((n) => nodeBase.get(n.id)?.eligibleForAdmission)
    .slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const admitted: string[] = [];
  const finalMap = new Map<string, ReadyNodeExplanation>();
  for (const n of graph.nodes) {
    const base = nodeBase.get(n.id)!;
    if (!base.eligibleForAdmission) {
      finalMap.set(n.id, { nodeId: n.id, verdict: base.verdict, rank: null, blockCodes: base.blockCodes, reasons: base.reasons, resourcesConsidered: base.resourcesConsidered, dependencies: base.dependencies });
    }
  }
  const globalCap = Math.max(0, Math.floor(rt.globalCap));
  for (const n of candidates) {
    const base = nodeBase.get(n.id)!;
    if (admitted.length >= globalCap) {
      const codes = [...base.blockCodes]; const reasons = [...base.reasons];
      pushCode(codes, 'global_concurrency_cap');
      pushReason(reasons, 'global concurrency cap ' + String(globalCap) + ' already filled by shadow admission');
      finalMap.set(n.id, { nodeId: n.id, verdict: 'blocked', rank: null, blockCodes: codes, reasons, resourcesConsidered: base.resourcesConsidered, dependencies: base.dependencies });
      continue;
    }
    const repo = repoCapBlocks(n, rt, admitted, graph);
    if (repo.blocked) {
      const codes = [...base.blockCodes]; const reasons = [...base.reasons];
      pushCode(codes, 'repo_concurrency_cap');
      if (repo.reason) pushReason(reasons, repo.reason);
      finalMap.set(n.id, { nodeId: n.id, verdict: 'blocked', rank: null, blockCodes: codes, reasons, resourcesConsidered: base.resourcesConsidered, dependencies: base.dependencies });
      continue;
    }
    const held = collectHeld(graph, rt, admitted);
    const res = resourceConflicts(n, held, rt.buildCachePressure);
    if (res.codes.length > 0) {
      const codes = [...base.blockCodes]; const reasons = [...base.reasons];
      for (const c of res.codes) pushCode(codes, c);
      for (const r of res.reasons) pushReason(reasons, r);
      finalMap.set(n.id, { nodeId: n.id, verdict: 'blocked', rank: null, blockCodes: codes, reasons, resourcesConsidered: res.resources.length ? res.resources : base.resourcesConsidered, dependencies: base.dependencies });
      continue;
    }
    admitted.push(n.id);
    finalMap.set(n.id, { nodeId: n.id, verdict: 'recommend', rank: admitted.length, blockCodes: [], reasons: base.reasons.length ? base.reasons : ['dependency-ready and resource-safe (shadow)'], resourcesConsidered: res.resources.length ? res.resources : base.resourcesConsidered, dependencies: base.dependencies });
  }
  const explanations = graph.nodes.map((n) => finalMap.get(n.id)!).sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
  const comparison = buildComparison(admitted, input.linearObservation, explanations);
  const withoutDigest = {
    version: READY_NODE_SHADOW_VERSION, kind: 'ready_node_shadow_schedule' as const,
    mode: 'shadow' as const, verifiedWork: false as const, mutatesGraph: false as const,
    authorizesDispatch: false as const, affectsLinearDispatch: false as const,
    graphId: graph.id, graphDigest: taskGraphDigest(graph), evaluatedAtMs: input.evaluatedAtMs,
    recommendedNodeIds: admitted, explanations, comparison,
  };
  return { ...withoutDigest, resultDigest: readyNodeShadowResultDigest(withoutDigest) };
}

export function buildReadyNodeShadowSchedule(raw: unknown): ReadyNodeShadowBuildResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [{ code: 'schema', message: 'ready-node shadow input must be an object' }] };
  }
  const o = raw as Record<string, unknown>;
  if (typeof o['evaluatedAtMs'] !== 'number' || !Number.isFinite(o['evaluatedAtMs'])) {
    return { ok: false, errors: [{ code: 'schema', message: 'evaluatedAtMs required' }] };
  }
  if (o['graph'] === undefined) return { ok: false, errors: [{ code: 'schema', message: 'graph required' }] };
  const validated = validateTaskGraph(o['graph']);
  if (!validated.ok) return { ok: false, errors: validated.errors };
  if (o['runtime'] === null || typeof o['runtime'] !== 'object' || Array.isArray(o['runtime'])) {
    return { ok: false, errors: [{ code: 'schema', message: 'runtime snapshot required' }] };
  }
  const rt = o['runtime'] as Record<string, unknown>;
  if (!Array.isArray(rt['completedNodeIds']) || !Array.isArray(rt['runningNodeIds'])) {
    return { ok: false, errors: [{ code: 'schema', message: 'runtime completed/running node id lists required' }] };
  }
  if (typeof rt['globalCap'] !== 'number' || !Number.isFinite(rt['globalCap'])) {
    return { ok: false, errors: [{ code: 'schema', message: 'runtime.globalCap required' }] };
  }
  const pressure = rt['buildCachePressure'];
  if (pressure !== 'ok' && pressure !== 'warn' && pressure !== 'critical') {
    return { ok: false, errors: [{ code: 'schema', message: 'runtime.buildCachePressure invalid' }] };
  }
  const runtime: ReadyNodeRuntimeSnapshot = {
    completedNodeIds: rt['completedNodeIds'].filter((x): x is string => typeof x === 'string'),
    runningNodeIds: rt['runningNodeIds'].filter((x): x is string => typeof x === 'string'),
    externalClaims: Array.isArray(rt['externalClaims']) ? (rt['externalClaims'] as ReadyNodeResourceClaim[]) : [],
    repoConcurrency: Array.isArray(rt['repoConcurrency']) ? (rt['repoConcurrency'] as ReadyNodeRepoConcurrency[]) : [],
    globalCap: rt['globalCap'] as number, buildCachePressure: pressure,
    ...(Array.isArray(rt['taskBudgets']) ? { taskBudgets: rt['taskBudgets'] as ReadyNodeTaskBudget[] } : {}),
    ...(rt['globalBudgetRemaining'] === null || typeof rt['globalBudgetRemaining'] === 'number'
      ? { globalBudgetRemaining: rt['globalBudgetRemaining'] as number | null } : {}),
  };
  const input: ReadyNodeShadowInput = {
    graph: validated.graph, runtime, evaluatedAtMs: o['evaluatedAtMs'] as number,
    ...(Array.isArray(o['leafVerdicts']) ? { leafVerdicts: o['leafVerdicts'] as ReadyNodeLeafVerdict[] } : {}),
    ...(o['linearObservation'] !== undefined && o['linearObservation'] !== null && typeof o['linearObservation'] === 'object'
      ? { linearObservation: o['linearObservation'] as LinearScheduleObservation } : {}),
  };
  try { return { ok: true, result: evaluateReadyNodeShadowSchedule(input) }; }
  catch (err) {
    const message = err instanceof Error ? err.message : 'evaluation failed';
    return { ok: false, errors: [{ code: 'schema', message: boundReadyNodeText(message) }] };
  }
}

export function serializeReadyNodeShadowResult(result: ReadyNodeShadowResult): string {
  const body = {
    version: result.version, kind: result.kind, mode: result.mode,
    verifiedWork: false as const, mutatesGraph: false as const,
    authorizesDispatch: false as const, affectsLinearDispatch: false as const,
    graphId: result.graphId, graphDigest: result.graphDigest, evaluatedAtMs: result.evaluatedAtMs,
    recommendedNodeIds: result.recommendedNodeIds, explanations: result.explanations,
    comparison: result.comparison, resultDigest: result.resultDigest,
  };
  return JSON.stringify(sortReadyNodeKeysDeep(body)) + '\n';
}

export function formatReadyNodeShadowResultMarkdown(result: ReadyNodeShadowResult): string {
  const rd = result.resultDigest.slice(0, 12); const gd = result.graphDigest.slice(0, 12);
  const lines: string[] = [
    READY_NODE_SHADOW_HEADING, '', READY_NODE_SHADOW_BLOCK_START,
    serializeReadyNodeShadowResult(result).trimEnd(), READY_NODE_SHADOW_BLOCK_END, '',
    '**Mode:** `shadow` — advisory ready-node / resource schedule.',
    'It does not dispatch, mutate the accepted graph, or authorize merge/deploy.', '',
    '- **Graph id:** `' + result.graphId + '`',
    '- **Graph digest:** `' + gd + '…`', '- **Result digest:** `' + rd + '…`',
    '- **Recommended:** ' + (result.recommendedNodeIds.length === 0 ? '_none_' : result.recommendedNodeIds.map((id) => '`' + id + '`').join(', ')),
    '- **Verified work:** `false`', '- **Mutates graph:** `false`',
    '- **Authorizes dispatch:** `false`', '- **Affects linear dispatch:** `false`', '',
    '### Explanations', '',
  ];
  for (const ex of result.explanations) {
    lines.push('- `' + ex.nodeId + '` → **' + ex.verdict + '**' + (ex.rank !== null ? ' (rank ' + String(ex.rank) + ')' : '') + (ex.blockCodes.length ? ' [' + ex.blockCodes.join(', ') + ']' : ''));
    for (const r of ex.reasons) lines.push('  - ' + r);
  }
  lines.push('', '### Linear comparison', '');
  if (!result.comparison) lines.push('_No linear observation provided._');
  else {
    const c = result.comparison;
    lines.push('- **Agreement:** ' + (c.agreementRatio * 100).toFixed(0) + '%');
    lines.push('- **Both:** ' + (c.both.length === 0 ? '_none_' : c.both.map((id) => '`' + id + '`').join(', ')));
    lines.push('- **Shadow only:** ' + (c.shadowOnly.length === 0 ? '_none_' : c.shadowOnly.map((id) => '`' + id + '`').join(', ')));
    lines.push('- **Linear only:** ' + (c.linearOnly.length === 0 ? '_none_' : c.linearOnly.map((id) => '`' + id + '`').join(', ')));
    for (const n of c.notes) lines.push('- ' + n);
  }
  lines.push('', '_End of advisory ready-node shadow schedule. Does not dispatch or mutate._', '');
  return lines.join('\n');
}

function isSha(v: string): boolean { return v.length === 64 && /^[0-9a-f]+$/.test(v); }
function isBlock(v: unknown): v is ReadyNodeBlockCode {
  return typeof v === 'string' && (READY_NODE_BLOCK_CODES as readonly string[]).includes(v);
}
function isVerdict(v: unknown): v is ReadyNodeVerdict {
  return typeof v === 'string' && (READY_NODE_VERDICTS as readonly string[]).includes(v);
}

function normalizeExplanation(raw: unknown): ReadyNodeExplanation | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o['nodeId'] !== 'string' || !isVerdict(o['verdict'])) return null;
  let rank: number | null = null;
  if (o['rank'] === null || o['rank'] === undefined) rank = null;
  else if (typeof o['rank'] === 'number' && Number.isInteger(o['rank'])) rank = o['rank'];
  else return null;
  const blockCodes = Array.isArray(o['blockCodes']) ? o['blockCodes'].filter(isBlock) : [];
  const reasons = Array.isArray(o['reasons'])
    ? o['reasons'].filter((r): r is string => typeof r === 'string').map((r) => boundReadyNodeText(r)).slice(0, MAX_READY_NODE_REASONS)
    : [];
  const resourcesConsidered = Array.isArray(o['resourcesConsidered'])
    ? o['resourcesConsidered'].map((item): ReadyNodeResourceStatus | null => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
      const r = item as Record<string, unknown>;
      if (typeof r['kind'] !== 'string' || typeof r['key'] !== 'string') return null;
      if (typeof r['exclusive'] !== 'boolean' || typeof r['status'] !== 'string') return null;
      if (!['free', 'held', 'conflict', 'pressure'].includes(r['status'])) return null;
      return { kind: r['kind'] as TaskGraphResourceKind, key: r['key'], exclusive: r['exclusive'], status: r['status'] as ReadyNodeResourceStatus['status'] };
    }).filter((x): x is ReadyNodeResourceStatus => x !== null) : [];
  const dependencies = Array.isArray(o['dependencies'])
    ? o['dependencies'].map((item): ReadyNodeDependencyStatus | null => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
      const d = item as Record<string, unknown>;
      if (typeof d['nodeId'] !== 'string' || typeof d['status'] !== 'string') return null;
      if (!['satisfied', 'unresolved', 'missing', 'cyclic'].includes(d['status'])) return null;
      return { nodeId: d['nodeId'], status: d['status'] as ReadyNodeDependencyStatus['status'] };
    }).filter((x): x is ReadyNodeDependencyStatus => x !== null) : [];
  return { nodeId: o['nodeId'], verdict: o['verdict'], rank, blockCodes, reasons, resourcesConsidered, dependencies };
}

function normalizeComparison(raw: unknown): ReadyNodeLinearComparison | null {
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const strArr = (k: string): string[] => Array.isArray(o[k]) ? o[k].filter((x): x is string => typeof x === 'string') : [];
  if (typeof o['agreementRatio'] !== 'number' || !Number.isFinite(o['agreementRatio'])) return null;
  return {
    shadowRecommended: strArr('shadowRecommended'), linearDispatched: strArr('linearDispatched'),
    both: strArr('both'), shadowOnly: strArr('shadowOnly'), linearOnly: strArr('linearOnly'),
    linearConflictsAlsoBlockedByShadow: strArr('linearConflictsAlsoBlockedByShadow'),
    linearReworkAlsoBlockedByShadow: strArr('linearReworkAlsoBlockedByShadow'),
    agreementRatio: o['agreementRatio'], notes: strArr('notes').map((n) => boundReadyNodeText(n)),
  };
}

export function parseReadyNodeShadowResult(markdown: string): ReadyNodeShadowParseResult {
  if (typeof markdown !== 'string' || markdown.trim().length === 0) {
    throw new ReadyNodeShadowSchedulerError('missing ready-node shadow schedule document');
  }
  if (markdown.length > MAX_READY_NODE_RESULT_BYTES) {
    throw new ReadyNodeShadowSchedulerError('ready-node shadow document exceeds bound');
  }
  const start = markdown.indexOf(READY_NODE_SHADOW_BLOCK_START);
  const end = markdown.indexOf(READY_NODE_SHADOW_BLOCK_END);
  if (start < 0 || end < 0 || end <= start) {
    throw new ReadyNodeShadowSchedulerError('missing ready-node shadow schedule document');
  }
  const jsonText = markdown.slice(start + READY_NODE_SHADOW_BLOCK_START.length, end).trim();
  let raw: unknown;
  try { raw = JSON.parse(jsonText); }
  catch { return { ok: false, errors: [{ code: 'schema', message: 'ready-node shadow JSON parse failed' }] }; }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [{ code: 'schema', message: 'ready-node shadow body invalid' }] };
  }
  const o = raw as Record<string, unknown>;
  if (
    o['version'] !== READY_NODE_SHADOW_VERSION || o['kind'] !== 'ready_node_shadow_schedule' ||
    o['mode'] !== 'shadow' || o['verifiedWork'] !== false || o['mutatesGraph'] !== false ||
    o['authorizesDispatch'] !== false || o['affectsLinearDispatch'] !== false ||
    typeof o['graphId'] !== 'string' || typeof o['graphDigest'] !== 'string' || !isSha(o['graphDigest']) ||
    typeof o['evaluatedAtMs'] !== 'number' || typeof o['resultDigest'] !== 'string' || !isSha(o['resultDigest']) ||
    !Array.isArray(o['recommendedNodeIds']) || !Array.isArray(o['explanations'])
  ) {
    return { ok: false, errors: [{ code: 'schema', message: 'ready-node shadow fields invalid' }] };
  }
  const explanations = o['explanations'].map(normalizeExplanation).filter((x): x is ReadyNodeExplanation => x !== null);
  if (explanations.length !== o['explanations'].length) {
    return { ok: false, errors: [{ code: 'schema', message: 'ready-node shadow explanations invalid' }] };
  }
  const comparison = normalizeComparison(o['comparison'] ?? null);
  if (o['comparison'] !== null && o['comparison'] !== undefined && comparison === null) {
    return { ok: false, errors: [{ code: 'schema', message: 'ready-node shadow comparison invalid' }] };
  }
  const withoutDigest = {
    version: READY_NODE_SHADOW_VERSION, kind: 'ready_node_shadow_schedule' as const,
    mode: 'shadow' as const, verifiedWork: false as const, mutatesGraph: false as const,
    authorizesDispatch: false as const, affectsLinearDispatch: false as const,
    graphId: o['graphId'], graphDigest: o['graphDigest'], evaluatedAtMs: o['evaluatedAtMs'],
    recommendedNodeIds: o['recommendedNodeIds'].filter((x): x is string => typeof x === 'string'),
    explanations, comparison,
  };
  const expected = readyNodeShadowResultDigest(withoutDigest);
  if (expected !== o['resultDigest']) {
    return { ok: false, errors: [{ code: 'schema', message: 'ready-node shadow resultDigest mismatch' }] };
  }
  return { ok: true, result: { ...withoutDigest, resultDigest: expected } };
}
