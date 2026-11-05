/**
 * Domain — adaptive task graph (typed DAG model).
 *
 * Pure types + validation + canonical serialization/digest for the advisory
 * adaptive-task-graph design (docs/autonomy/adaptive-task-graph.md).
 *
 * Steps 1-5: graph/node/edge/contract model + proposed-graph packet
 * (`proposedGraphPacket.ts`) + leaf-readiness critic (`leafReadinessCritic.ts`)
 * + ready-node shadow scheduler (`readyNodeShadowScheduler.ts`)
 * + graph reconciler / integration packet (`graphReconciler.ts`).
 * Does NOT authorize dispatch, merge, deploy, or privilege changes.
 * Linear scheduler/orchestrator remain unchanged by shadow recommendations.
 */
import { createHash } from 'node:crypto';
import { isValidIdentifier } from './task.js';

export const TASK_GRAPH_VERSION = 1 as const;

export const TASK_GRAPH_NODE_KINDS = [
  'objective',
  'investigation',
  'implementation',
] as const;
export type TaskGraphNodeKind = (typeof TASK_GRAPH_NODE_KINDS)[number];

export const TASK_GRAPH_EDGE_KINDS = [
  'semantic_output',
  'interface_contract',
  'resource_lock',
  'integration_prerequisite',
] as const;
export type TaskGraphEdgeKind = (typeof TASK_GRAPH_EDGE_KINDS)[number];

export const TASK_GRAPH_RESOURCE_KINDS = [
  'path_lease',
  'branch_lease',
  'env_lock',
  'deploy_lock',
  'concurrency_budget',
  'build_cache',
] as const;
export type TaskGraphResourceKind = (typeof TASK_GRAPH_RESOURCE_KINDS)[number];

export const TASK_GRAPH_ACCEPTANCE_KINDS = [
  'mechanical',
  'reviewer',
  'human',
  'integration',
] as const;
export type TaskGraphAcceptanceKind = (typeof TASK_GRAPH_ACCEPTANCE_KINDS)[number];

/** Actions this model never authorizes — always human/system outside the graph. */
export const TASK_GRAPH_RESERVED_HUMAN_ACTIONS = [
  'merge',
  'deploy',
  'promote',
  'privilege_change',
  'permission_change',
  'external_publication',
  'destructive_action',
  'cost_expansion',
] as const;
export type TaskGraphReservedHumanAction =
  (typeof TASK_GRAPH_RESERVED_HUMAN_ACTIONS)[number];

export type TaskGraphAuthorityAction =
  | TaskGraphReservedHumanAction
  | 'dispatch'
  | 'execute'
  | 'schedule';

export const MAX_TASK_GRAPH_NODES = 64;
export const MAX_TASK_GRAPH_EDGES = 128;
export const MAX_TASK_GRAPH_ID_LEN = 64;
export const MAX_TASK_GRAPH_TEXT_LEN = 400;
export const MAX_TASK_GRAPH_ACCEPTANCE = 16;
export const MAX_TASK_GRAPH_RESOURCES = 16;
export const MAX_TASK_GRAPH_IO = 32;
export const MAX_TASK_GRAPH_CONCURRENT = 32;
export const MAX_TASK_GRAPH_RETRY_ATTEMPTS = 16;
export const MAX_TASK_GRAPH_BACKOFF_MS = 86_400_000;
export const MAX_TASK_GRAPH_VALIDATION_ERRORS = 64;
export const MAX_TASK_GRAPH_BYTES = 64 * 1024;

export const TASK_GRAPH_VALIDATION_CODES = [
  'invalid_identifier',
  'duplicate_node_id',
  'duplicate_edge_id',
  'missing_dependency',
  'cycle',
  'unbounded_node',
  'invalid_resource',
  'invalid_edge',
  'invalid_integration',
  'invalid_retry',
  'invalid_contract',
  'empty_graph',
  'too_many_nodes',
  'too_many_edges',
  'schema',
] as const;
export type TaskGraphValidationCode =
  (typeof TASK_GRAPH_VALIDATION_CODES)[number];

export interface TaskGraphValidationIssue {
  readonly code: TaskGraphValidationCode;
  readonly message: string;
  readonly nodeId?: string;
  readonly edgeId?: string;
}

export class TaskGraphValidationError extends Error {
  override readonly name = 'TaskGraphValidationError';
  readonly issues: readonly TaskGraphValidationIssue[];
  constructor(message: string, issues: readonly TaskGraphValidationIssue[] = []) {
    super(message);
    this.issues = issues;
  }
}

export interface TaskGraphRetryPolicy {
  readonly maxAttempts: number;
  readonly backoffMs: number;
  readonly rollbackDefined: boolean;
}

export interface TaskGraphResourceRequirement {
  readonly kind: TaskGraphResourceKind;
  readonly key: string;
  readonly exclusive: boolean;
}

export interface TaskGraphAcceptanceEvidence {
  readonly kind: TaskGraphAcceptanceKind;
  readonly description: string;
  readonly evidenceHook?: string;
}

export interface TaskGraphNodeContract {
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly acceptance: readonly TaskGraphAcceptanceEvidence[];
  readonly resources: readonly TaskGraphResourceRequirement[];
  readonly allowedConcurrentNodeIds: readonly string[];
  readonly retry: TaskGraphRetryPolicy;
}

export interface TaskGraphNode {
  readonly id: string;
  readonly kind: TaskGraphNodeKind;
  readonly title: string;
  readonly goal: string;
  readonly scope: string;
  readonly contract: TaskGraphNodeContract;
}

export interface TaskGraphEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: TaskGraphEdgeKind;
  readonly description: string;
}

export interface TaskGraphIntegrationContract {
  readonly objectiveNodeId: string;
  readonly acceptance: readonly TaskGraphAcceptanceEvidence[];
  readonly requiresTopLevelVerification: true;
  readonly reservedHumanActions: readonly TaskGraphReservedHumanAction[];
}

export interface TaskGraph {
  readonly version: typeof TASK_GRAPH_VERSION;
  readonly id: string;
  readonly rationale: string;
  readonly nodes: readonly TaskGraphNode[];
  readonly edges: readonly TaskGraphEdge[];
  readonly integration: TaskGraphIntegrationContract;
}

export type TaskGraphValidationResult =
  | { readonly ok: true; readonly graph: TaskGraph }
  | { readonly ok: false; readonly errors: readonly TaskGraphValidationIssue[] };

export function isTaskGraphNodeKind(v: unknown): v is TaskGraphNodeKind {
  return typeof v === 'string' && (TASK_GRAPH_NODE_KINDS as readonly string[]).includes(v);
}

export function isTaskGraphEdgeKind(v: unknown): v is TaskGraphEdgeKind {
  return typeof v === 'string' && (TASK_GRAPH_EDGE_KINDS as readonly string[]).includes(v);
}

export function isTaskGraphResourceKind(v: unknown): v is TaskGraphResourceKind {
  return typeof v === 'string' && (TASK_GRAPH_RESOURCE_KINDS as readonly string[]).includes(v);
}

export function isTaskGraphAcceptanceKind(v: unknown): v is TaskGraphAcceptanceKind {
  return typeof v === 'string' && (TASK_GRAPH_ACCEPTANCE_KINDS as readonly string[]).includes(v);
}

export function isTaskGraphReservedHumanAction(v: unknown): v is TaskGraphReservedHumanAction {
  return (
    typeof v === 'string' &&
    (TASK_GRAPH_RESERVED_HUMAN_ACTIONS as readonly string[]).includes(v)
  );
}

function boundMsg(text: string): string {
  const one = text.split(/\s+/).join(' ').trim();
  if (one.length <= MAX_TASK_GRAPH_TEXT_LEN) return one;
  return one.slice(0, MAX_TASK_GRAPH_TEXT_LEN - 1) + '...';
}

function pushError(errors: TaskGraphValidationIssue[], issue: TaskGraphValidationIssue): void {
  if (errors.length >= MAX_TASK_GRAPH_VALIDATION_ERRORS) return;
  if (issue.nodeId !== undefined && issue.edgeId !== undefined) {
    errors.push({
      code: issue.code,
      message: boundMsg(issue.message),
      nodeId: issue.nodeId,
      edgeId: issue.edgeId,
    });
  } else if (issue.nodeId !== undefined) {
    errors.push({
      code: issue.code,
      message: boundMsg(issue.message),
      nodeId: issue.nodeId,
    });
  } else if (issue.edgeId !== undefined) {
    errors.push({
      code: issue.code,
      message: boundMsg(issue.message),
      edgeId: issue.edgeId,
    });
  } else {
    errors.push({ code: issue.code, message: boundMsg(issue.message) });
  }
}

function isSafeGraphId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_TASK_GRAPH_ID_LEN && isValidIdentifier(value);
}

function isNonEmptyBoundedText(value: unknown, max = MAX_TASK_GRAPH_TEXT_LEN): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function isBoundedText(value: unknown, max = MAX_TASK_GRAPH_TEXT_LEN): value is string {
  return typeof value === 'string' && value.length <= max;
}

function isSafePathKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_TASK_GRAPH_TEXT_LEN) return false;
  if (key.startsWith('/') || key.startsWith('~') || key.includes('://')) return false;
  if (/^[A-Za-z]:/.test(key)) return false;
  const parts = key.split('/');
  for (const p of parts) {
    if (p === '.' || p === '..' || p.length === 0) return false;
    if (!/^[A-Za-z0-9._-]+$/.test(p)) return false;
  }
  return true;
}

function isSafeResourceKey(kind: TaskGraphResourceKind, key: string): boolean {
  if (kind === 'path_lease') return isSafePathKey(key);
  if (key.includes('..')) return false;
  return isSafeGraphId(key) || /^[A-Za-z0-9._:-]+$/.test(key);
}

function validateRetry(
  retry: unknown,
  nodeId: string,
  errors: TaskGraphValidationIssue[],
): TaskGraphRetryPolicy | null {
  if (retry === null || typeof retry !== 'object' || Array.isArray(retry)) {
    pushError(errors, {
      code: 'invalid_retry',
      message: 'retry policy must be an object',
      nodeId,
    });
    return null;
  }
  const r = retry as Record<string, unknown>;
  const maxAttempts = r['maxAttempts'];
  const backoffMs = r['backoffMs'];
  const rollbackDefined = r['rollbackDefined'];
  if (
    typeof maxAttempts !== 'number' ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > MAX_TASK_GRAPH_RETRY_ATTEMPTS
  ) {
    pushError(errors, { code: 'invalid_retry', message: 'maxAttempts out of range', nodeId });
    return null;
  }
  if (
    typeof backoffMs !== 'number' ||
    !Number.isInteger(backoffMs) ||
    backoffMs < 0 ||
    backoffMs > MAX_TASK_GRAPH_BACKOFF_MS
  ) {
    pushError(errors, { code: 'invalid_retry', message: 'backoffMs out of range', nodeId });
    return null;
  }
  if (typeof rollbackDefined !== 'boolean') {
    pushError(errors, { code: 'invalid_retry', message: 'rollbackDefined must be boolean', nodeId });
    return null;
  }
  return { maxAttempts, backoffMs, rollbackDefined };
}

function validateAcceptanceList(
  raw: unknown,
  ctx: { readonly nodeId?: string; readonly label: string },
  errors: TaskGraphValidationIssue[],
): readonly TaskGraphAcceptanceEvidence[] | null {
  if (!Array.isArray(raw)) {
    const msg = ctx.label + ' acceptance must be an array';
    if (ctx.nodeId !== undefined) {
      pushError(errors, { code: 'invalid_contract', message: msg, nodeId: ctx.nodeId });
    } else {
      pushError(errors, { code: 'invalid_contract', message: msg });
    }
    return null;
  }
  if (raw.length > MAX_TASK_GRAPH_ACCEPTANCE) {
    const msg = ctx.label + ' acceptance exceeds bound';
    if (ctx.nodeId !== undefined) {
      pushError(errors, { code: 'invalid_contract', message: msg, nodeId: ctx.nodeId });
    } else {
      pushError(errors, { code: 'invalid_contract', message: msg });
    }
    return null;
  }
  const out: TaskGraphAcceptanceEvidence[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      const msg = ctx.label + ' acceptance entry must be an object';
      if (ctx.nodeId !== undefined) {
        pushError(errors, { code: 'invalid_contract', message: msg, nodeId: ctx.nodeId });
      } else {
        pushError(errors, { code: 'invalid_contract', message: msg });
      }
      return null;
    }
    const a = item as Record<string, unknown>;
    if (!isTaskGraphAcceptanceKind(a['kind'])) {
      const msg = ctx.label + ' acceptance has invalid kind';
      if (ctx.nodeId !== undefined) {
        pushError(errors, { code: 'invalid_contract', message: msg, nodeId: ctx.nodeId });
      } else {
        pushError(errors, { code: 'invalid_contract', message: msg });
      }
      return null;
    }
    if (!isNonEmptyBoundedText(a['description'])) {
      const msg = ctx.label + ' acceptance description required';
      if (ctx.nodeId !== undefined) {
        pushError(errors, { code: 'invalid_contract', message: msg, nodeId: ctx.nodeId });
      } else {
        pushError(errors, { code: 'invalid_contract', message: msg });
      }
      return null;
    }
    const hook = a['evidenceHook'];
    if (hook !== undefined && hook !== null) {
      if (typeof hook !== 'string' || hook.length === 0 || hook.length > MAX_TASK_GRAPH_ID_LEN) {
        const msg = ctx.label + ' evidenceHook invalid';
        if (ctx.nodeId !== undefined) {
          pushError(errors, { code: 'invalid_contract', message: msg, nodeId: ctx.nodeId });
        } else {
          pushError(errors, { code: 'invalid_contract', message: msg });
        }
        return null;
      }
      out.push({ kind: a['kind'] as TaskGraphAcceptanceKind, description: String(a['description']).trim(), evidenceHook: hook });
    } else {
      out.push({ kind: a['kind'] as TaskGraphAcceptanceKind, description: String(a['description']).trim() });
    }
  }
  return out;
}

function validateResources(
  raw: unknown,
  nodeId: string,
  errors: TaskGraphValidationIssue[],
): readonly TaskGraphResourceRequirement[] | null {
  if (!Array.isArray(raw)) {
    pushError(errors, { code: 'invalid_resource', message: 'resources must be an array', nodeId });
    return null;
  }
  if (raw.length > MAX_TASK_GRAPH_RESOURCES) {
    pushError(errors, { code: 'invalid_resource', message: 'resources exceed bound', nodeId });
    return null;
  }
  const out: TaskGraphResourceRequirement[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      pushError(errors, { code: 'invalid_resource', message: 'resource entry must be an object', nodeId });
      return null;
    }
    const r = item as Record<string, unknown>;
    if (!isTaskGraphResourceKind(r['kind'])) {
      pushError(errors, { code: 'invalid_resource', message: 'unknown resource kind', nodeId });
      return null;
    }
    if (typeof r['key'] !== 'string' || !isSafeResourceKey(r['kind'], r['key'])) {
      pushError(errors, { code: 'invalid_resource', message: 'invalid resource key', nodeId });
      return null;
    }
    if (typeof r['exclusive'] !== 'boolean') {
      pushError(errors, { code: 'invalid_resource', message: 'resource exclusive must be boolean', nodeId });
      return null;
    }
    out.push({
      kind: r['kind'] as TaskGraphResourceKind,
      key: r['key'] as string,
      exclusive: r['exclusive'] as boolean,
    });
  }
  return out;
}

function validateStringList(
  raw: unknown,
  opts: { field: string; nodeId: string; max: number; allowEmpty: boolean },
  errors: TaskGraphValidationIssue[],
): readonly string[] | null {
  if (!Array.isArray(raw)) {
    pushError(errors, {
      code: 'invalid_contract',
      message: opts.field + ' must be an array',
      nodeId: opts.nodeId,
    });
    return null;
  }
  if (raw.length > opts.max) {
    pushError(errors, {
      code: 'invalid_contract',
      message: opts.field + ' exceeds bound',
      nodeId: opts.nodeId,
    });
    return null;
  }
  if (!opts.allowEmpty && raw.length === 0) {
    pushError(errors, {
      code: 'unbounded_node',
      message: opts.field + ' must be non-empty for a bounded node',
      nodeId: opts.nodeId,
    });
    return null;
  }
  const out: string[] = [];
  for (const item of raw) {
    if (!isNonEmptyBoundedText(item)) {
      pushError(errors, {
        code: 'invalid_contract',
        message: opts.field + ' entries must be non-empty bounded strings',
        nodeId: opts.nodeId,
      });
      return null;
    }
    out.push(item.trim());
  }
  return out;
}

function validateNode(raw: unknown, errors: TaskGraphValidationIssue[]): TaskGraphNode | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    pushError(errors, { code: 'schema', message: 'node must be an object' });
    return null;
  }
  const n = raw as Record<string, unknown>;
  const id = n['id'];
  if (typeof id !== 'string' || !isSafeGraphId(id)) {
    if (typeof id === 'string') {
      pushError(errors, {
        code: 'invalid_identifier',
        message: 'node id must be a safe identifier',
        nodeId: id.slice(0, MAX_TASK_GRAPH_ID_LEN),
      });
    } else {
      pushError(errors, {
        code: 'invalid_identifier',
        message: 'node id must be a safe identifier',
      });
    }
    return null;
  }
  if (!isTaskGraphNodeKind(n['kind'])) {
    pushError(errors, {
      code: 'schema',
      message: 'node kind must be objective|investigation|implementation',
      nodeId: id,
    });
    return null;
  }
  if (!isNonEmptyBoundedText(n['title'])) {
    pushError(errors, { code: 'unbounded_node', message: 'node title required', nodeId: id });
    return null;
  }
  if (!isNonEmptyBoundedText(n['goal'])) {
    pushError(errors, {
      code: 'unbounded_node',
      message: 'node goal required (one behavior goal)',
      nodeId: id,
    });
    return null;
  }
  if (!isNonEmptyBoundedText(n['scope'])) {
    pushError(errors, { code: 'unbounded_node', message: 'node scope required', nodeId: id });
    return null;
  }
  const cRaw = n['contract'];
  if (cRaw === null || typeof cRaw !== 'object' || Array.isArray(cRaw)) {
    pushError(errors, { code: 'unbounded_node', message: 'node contract required', nodeId: id });
    return null;
  }
  const c = cRaw as Record<string, unknown>;
  const allowEmptyInputs = n['kind'] === 'objective';
  const inputs = validateStringList(
    c['inputs'],
    { field: 'inputs', nodeId: id, max: MAX_TASK_GRAPH_IO, allowEmpty: allowEmptyInputs },
    errors,
  );
  const outputs = validateStringList(
    c['outputs'],
    { field: 'outputs', nodeId: id, max: MAX_TASK_GRAPH_IO, allowEmpty: false },
    errors,
  );
  const acceptance = validateAcceptanceList(c['acceptance'], { nodeId: id, label: 'node' }, errors);
  if (acceptance && acceptance.length === 0) {
    pushError(errors, {
      code: 'unbounded_node',
      message: 'node acceptance evidence required',
      nodeId: id,
    });
  }
  const resources = validateResources(c['resources'], id, errors);
  const allowedConcurrentNodeIds = validateStringList(
    c['allowedConcurrentNodeIds'],
    {
      field: 'allowedConcurrentNodeIds',
      nodeId: id,
      max: MAX_TASK_GRAPH_CONCURRENT,
      allowEmpty: true,
    },
    errors,
  );
  const retry = validateRetry(c['retry'], id, errors);
  if (
    inputs === null ||
    outputs === null ||
    acceptance === null ||
    acceptance.length === 0 ||
    resources === null ||
    allowedConcurrentNodeIds === null ||
    retry === null
  ) {
    return null;
  }
  for (const cid of allowedConcurrentNodeIds) {
    if (!isSafeGraphId(cid)) {
      pushError(errors, {
        code: 'invalid_identifier',
        message: 'allowedConcurrentNodeIds entry invalid',
        nodeId: id,
      });
      return null;
    }
  }
  return {
    id,
    kind: n['kind'] as TaskGraphNodeKind,
    title: String(n['title']).trim(),
    goal: String(n['goal']).trim(),
    scope: String(n['scope']).trim(),
    contract: {
      inputs,
      outputs,
      acceptance,
      resources,
      allowedConcurrentNodeIds,
      retry,
    },
  };
}

function validateEdge(
  raw: unknown,
  nodeIds: ReadonlySet<string>,
  errors: TaskGraphValidationIssue[],
): TaskGraphEdge | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    pushError(errors, { code: 'schema', message: 'edge must be an object' });
    return null;
  }
  const e = raw as Record<string, unknown>;
  const id = e['id'];
  if (typeof id !== 'string' || !isSafeGraphId(id)) {
    pushError(errors, { code: 'invalid_identifier', message: 'edge id must be a safe identifier' });
    return null;
  }
  if (!isTaskGraphEdgeKind(e['kind'])) {
    pushError(errors, { code: 'invalid_edge', message: 'edge kind invalid', edgeId: id });
    return null;
  }
  if (typeof e['from'] !== 'string' || typeof e['to'] !== 'string') {
    pushError(errors, { code: 'invalid_edge', message: 'edge from/to must be strings', edgeId: id });
    return null;
  }
  if (e['from'] === e['to']) {
    pushError(errors, { code: 'invalid_edge', message: 'edge cannot be a self-loop', edgeId: id });
    return null;
  }
  if (!nodeIds.has(e['from']) || !nodeIds.has(e['to'])) {
    pushError(errors, {
      code: 'missing_dependency',
      message: 'edge references missing node',
      edgeId: id,
    });
    return null;
  }
  if (typeof e['description'] !== 'string' || !isBoundedText(e['description'])) {
    pushError(errors, { code: 'invalid_edge', message: 'edge description invalid', edgeId: id });
    return null;
  }
  return {
    id,
    from: e['from'] as string,
    to: e['to'] as string,
    kind: e['kind'] as TaskGraphEdgeKind,
    description: String(e['description']).trim(),
  };
}

function validateIntegration(
  raw: unknown,
  nodeIds: ReadonlySet<string>,
  nodes: readonly TaskGraphNode[],
  errors: TaskGraphValidationIssue[],
): TaskGraphIntegrationContract | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    pushError(errors, { code: 'invalid_integration', message: 'integration contract required' });
    return null;
  }
  const i = raw as Record<string, unknown>;
  if (typeof i['objectiveNodeId'] !== 'string' || !nodeIds.has(i['objectiveNodeId'])) {
    pushError(errors, {
      code: 'invalid_integration',
      message: 'integration.objectiveNodeId must reference an existing node',
    });
    return null;
  }
  const objective = nodes.find((n) => n.id === i['objectiveNodeId']);
  if (objective && objective.kind !== 'objective') {
    pushError(errors, {
      code: 'invalid_integration',
      message: 'integration.objectiveNodeId must be an objective node',
      nodeId: i['objectiveNodeId'],
    });
  }
  if (i['requiresTopLevelVerification'] !== true) {
    pushError(errors, {
      code: 'invalid_integration',
      message: 'requiresTopLevelVerification must be true',
    });
  }
  const acceptance = validateAcceptanceList(i['acceptance'], { label: 'integration' }, errors);
  if (acceptance && acceptance.length === 0) {
    pushError(errors, {
      code: 'invalid_integration',
      message: 'integration acceptance evidence required',
    });
  }
  if (!Array.isArray(i['reservedHumanActions'])) {
    pushError(errors, {
      code: 'invalid_integration',
      message: 'reservedHumanActions must list human boundaries',
    });
    return null;
  }
  const reserved = i['reservedHumanActions'];
  const reservedSet = new Set<string>();
  for (const a of reserved) {
    if (!isTaskGraphReservedHumanAction(a)) {
      pushError(errors, {
        code: 'invalid_integration',
        message: 'reservedHumanActions contains unknown action',
      });
      return null;
    }
    reservedSet.add(a);
  }
  for (const required of TASK_GRAPH_RESERVED_HUMAN_ACTIONS) {
    if (!reservedSet.has(required)) {
      pushError(errors, {
        code: 'invalid_integration',
        message: 'reservedHumanActions missing required boundary: ' + required,
      });
    }
  }
  if (
    acceptance === null ||
    acceptance.length === 0 ||
    i['requiresTopLevelVerification'] !== true ||
    reservedSet.size < TASK_GRAPH_RESERVED_HUMAN_ACTIONS.length
  ) {
    return null;
  }
  return {
    objectiveNodeId: i['objectiveNodeId'] as string,
    acceptance,
    requiresTopLevelVerification: true,
    reservedHumanActions: [...TASK_GRAPH_RESERVED_HUMAN_ACTIONS],
  };
}

function findCycle(nodeIds: readonly string[], edges: readonly TaskGraphEdge[]): string[] | null {
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of edges) {
    const list = adj.get(e.from);
    if (list) list.push(e.to);
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of nodeIds) color.set(id, WHITE);
  const stack: string[] = [];
  const dfs = (u: string): string[] | null => {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? WHITE;
      if (c === GRAY) {
        const idx = stack.indexOf(v);
        return stack.slice(idx).concat(v);
      }
      if (c === WHITE) {
        const cycle = dfs(v);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    color.set(u, BLACK);
    return null;
  };
  for (const id of nodeIds) {
    if ((color.get(id) ?? WHITE) === WHITE) {
      const cycle = dfs(id);
      if (cycle) return cycle;
    }
  }
  return null;
}

export function validateTaskGraph(input: unknown): TaskGraphValidationResult {
  const errors: TaskGraphValidationIssue[] = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    pushError(errors, { code: 'schema', message: 'graph must be an object' });
    return { ok: false, errors };
  }
  const g = input as Record<string, unknown>;
  if (g['version'] !== TASK_GRAPH_VERSION) {
    pushError(errors, { code: 'schema', message: 'version must be 1' });
  }
  if (typeof g['id'] !== 'string' || !isSafeGraphId(g['id'])) {
    pushError(errors, { code: 'invalid_identifier', message: 'graph id must be a safe identifier' });
  }
  if (typeof g['rationale'] !== 'string' || !isBoundedText(g['rationale'])) {
    pushError(errors, { code: 'schema', message: 'rationale must be a bounded string' });
  }
  if (!Array.isArray(g['nodes'])) {
    pushError(errors, { code: 'schema', message: 'nodes must be an array' });
    return { ok: false, errors };
  }
  if (g['nodes'].length === 0) {
    pushError(errors, { code: 'empty_graph', message: 'graph has no nodes' });
  }
  if (g['nodes'].length > MAX_TASK_GRAPH_NODES) {
    pushError(errors, { code: 'too_many_nodes', message: 'nodes exceed bound' });
    return { ok: false, errors };
  }
  if (!Array.isArray(g['edges'])) {
    pushError(errors, { code: 'schema', message: 'edges must be an array' });
    return { ok: false, errors };
  }
  if (g['edges'].length > MAX_TASK_GRAPH_EDGES) {
    pushError(errors, { code: 'too_many_edges', message: 'edges exceed bound' });
    return { ok: false, errors };
  }
  const nodes: TaskGraphNode[] = [];
  const seenNodeIds = new Set<string>();
  for (const rawNode of g['nodes']) {
    const node = validateNode(rawNode, errors);
    if (!node) continue;
    if (seenNodeIds.has(node.id)) {
      pushError(errors, {
        code: 'duplicate_node_id',
        message: 'duplicate node id ' + node.id,
        nodeId: node.id,
      });
      continue;
    }
    seenNodeIds.add(node.id);
    nodes.push(node);
  }
  const edges: TaskGraphEdge[] = [];
  const seenEdgeIds = new Set<string>();
  for (const rawEdge of g['edges']) {
    const edge = validateEdge(rawEdge, seenNodeIds, errors);
    if (!edge) continue;
    if (seenEdgeIds.has(edge.id)) {
      pushError(errors, {
        code: 'duplicate_edge_id',
        message: 'duplicate edge id ' + edge.id,
        edgeId: edge.id,
      });
      continue;
    }
    seenEdgeIds.add(edge.id);
    edges.push(edge);
  }
  for (const node of nodes) {
    for (const cid of node.contract.allowedConcurrentNodeIds) {
      if (!seenNodeIds.has(cid)) {
        pushError(errors, {
          code: 'missing_dependency',
          message: 'allowedConcurrentNodeIds references missing node ' + cid,
          nodeId: node.id,
        });
      }
    }
  }
  const cycle = findCycle(
    nodes.map((n) => n.id),
    edges,
  );
  if (cycle) {
    pushError(errors, { code: 'cycle', message: 'cycle detected: ' + cycle.join(' -> ') });
  }
  const integration = validateIntegration(g['integration'], seenNodeIds, nodes, errors);
  if (
    errors.length > 0 ||
    typeof g['id'] !== 'string' ||
    !isSafeGraphId(g['id']) ||
    typeof g['rationale'] !== 'string' ||
    !isBoundedText(g['rationale']) ||
    g['version'] !== TASK_GRAPH_VERSION ||
    integration === null ||
    nodes.length === 0
  ) {
    return { ok: false, errors: errors.slice(0, MAX_TASK_GRAPH_VALIDATION_ERRORS) };
  }
  const sortedNodes = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sortedEdges = [...edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    ok: true,
    graph: {
      version: TASK_GRAPH_VERSION,
      id: g['id'] as string,
      rationale: String(g['rationale']).trim(),
      nodes: sortedNodes,
      edges: sortedEdges,
      integration,
    },
  };
}

function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v !== undefined) out[key] = sortKeysDeep(v);
  }
  return out;
}

function mapAcceptance(a: TaskGraphAcceptanceEvidence): Record<string, string> {
  if (a.evidenceHook !== undefined) {
    return { kind: a.kind, description: a.description, evidenceHook: a.evidenceHook };
  }
  return { kind: a.kind, description: a.description };
}

export function taskGraphToCanonicalObject(graph: TaskGraph): unknown {
  const nodes = [...graph.nodes]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      goal: n.goal,
      scope: n.scope,
      contract: {
        inputs: [...n.contract.inputs],
        outputs: [...n.contract.outputs],
        acceptance: n.contract.acceptance.map(mapAcceptance),
        resources: n.contract.resources.map((r) => ({
          kind: r.kind,
          key: r.key,
          exclusive: r.exclusive,
        })),
        allowedConcurrentNodeIds: [...n.contract.allowedConcurrentNodeIds].sort(),
        retry: {
          maxAttempts: n.contract.retry.maxAttempts,
          backoffMs: n.contract.retry.backoffMs,
          rollbackDefined: n.contract.retry.rollbackDefined,
        },
      },
    }));
  const edges = [...graph.edges]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      kind: e.kind,
      description: e.description,
    }));
  return sortKeysDeep({
    version: graph.version,
    id: graph.id,
    rationale: graph.rationale,
    nodes,
    edges,
    integration: {
      objectiveNodeId: graph.integration.objectiveNodeId,
      acceptance: graph.integration.acceptance.map(mapAcceptance),
      requiresTopLevelVerification: true,
      reservedHumanActions: [...TASK_GRAPH_RESERVED_HUMAN_ACTIONS],
    },
  });
}

export function taskGraphCanonical(graph: TaskGraph): string {
  return JSON.stringify(taskGraphToCanonicalObject(graph));
}

export function taskGraphDigest(graph: TaskGraph): string {
  return createHash('sha256').update(taskGraphCanonical(graph), 'utf8').digest('hex');
}

export function serializeTaskGraph(graph: TaskGraph): string {
  return taskGraphCanonical(graph) + '\n';
}

export function parseTaskGraph(raw: string): TaskGraph {
  if (typeof raw !== 'string') {
    throw new TaskGraphValidationError('graph document must be a string');
  }
  if (raw.length > MAX_TASK_GRAPH_BYTES) {
    throw new TaskGraphValidationError('graph document exceeds size bound');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new TaskGraphValidationError('graph document is not valid JSON');
  }
  const result = validateTaskGraph(value);
  if (!result.ok) {
    throw new TaskGraphValidationError(
      result.errors[0]?.message ?? 'graph validation failed',
      result.errors,
    );
  }
  return result.graph;
}

/** Advisory only — never grants execution, merge, deploy, or privilege authority. */
export function taskGraphAuthorizesExecution(_graph: TaskGraph): false {
  return false;
}

export function taskGraphAuthorizes(
  _graph: TaskGraph,
  _action: TaskGraphAuthorityAction,
): false {
  return false;
}
