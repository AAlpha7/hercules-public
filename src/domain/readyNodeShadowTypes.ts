/** Types + digests + authority for ready-node shadow scheduler. */
import { createHash } from 'node:crypto';
import type { TaskGraph, TaskGraphResourceKind, TaskGraphValidationIssue } from './taskGraph.js';
import { redactProposedGraphText } from './proposedGraphPacket.js';

export const READY_NODE_SHADOW_VERSION = 1 as const;
export const READY_NODE_SHADOW_HEADING = '## Ready-node shadow schedule (advisory)';
export const READY_NODE_SHADOW_BLOCK_START = '<!-- hercules-ready-node-shadow:v1';
export const READY_NODE_SHADOW_BLOCK_END = '-->';
export const MAX_READY_NODE_REASONS = 16;
export const MAX_READY_NODE_REASON_LEN = 400;
export const MAX_READY_NODE_RESULT_BYTES = 96 * 1024;

export const READY_NODE_SHADOW_FORBIDDEN_ACTIONS = [
  'dispatch', 'execute', 'schedule', 'merge', 'deploy', 'promote',
  'privilege_change', 'permission_change', 'external_publication',
  'destructive_action', 'cost_expansion', 'autonomous_fan_out',
] as const;
export type ReadyNodeShadowForbiddenAction = (typeof READY_NODE_SHADOW_FORBIDDEN_ACTIONS)[number];
export type ReadyNodeBlockCode =
  | 'not_leaf_ready' | 'unresolved_dependency' | 'cyclic_dependency'
  | 'path_lease_conflict' | 'branch_lease_conflict' | 'env_lock_conflict'
  | 'deploy_lock_conflict' | 'repo_concurrency_cap' | 'build_cache_pressure'
  | 'task_budget_exhausted' | 'already_running' | 'already_completed'
  | 'objective_not_schedulable' | 'global_concurrency_cap';

export const READY_NODE_BLOCK_CODES: readonly ReadyNodeBlockCode[] = [
  'not_leaf_ready', 'unresolved_dependency', 'cyclic_dependency', 'path_lease_conflict',
  'branch_lease_conflict', 'env_lock_conflict', 'deploy_lock_conflict', 'repo_concurrency_cap',
  'build_cache_pressure', 'task_budget_exhausted', 'already_running', 'already_completed',
  'objective_not_schedulable', 'global_concurrency_cap',
];

export const READY_NODE_VERDICTS = ['recommend', 'blocked', 'running', 'completed', 'skipped_objective'] as const;
export type ReadyNodeVerdict = (typeof READY_NODE_VERDICTS)[number];

export class ReadyNodeShadowSchedulerError extends Error {
  override readonly name = 'ReadyNodeShadowSchedulerError';
  readonly issues: readonly TaskGraphValidationIssue[];
  constructor(message: string, issues: readonly TaskGraphValidationIssue[] = []) {
    super(message);
    this.issues = issues;
  }
}

export interface ReadyNodeResourceClaim {
  readonly kind: TaskGraphResourceKind; readonly key: string;
  readonly exclusive: boolean; readonly holderId: string;
}
export interface ReadyNodeLeafVerdict {
  readonly nodeId: string;
  readonly verdict: 'leaf_ready' | 'not_leaf' | 'investigation_required' | 'unknown';
}
export interface ReadyNodeRepoConcurrency {
  readonly key: string; readonly maxConcurrent: number; readonly currentRunning: number;
}
export interface ReadyNodeTaskBudget {
  readonly nodeId: string; readonly remainingUnits: number; readonly requiredUnits: number;
}
export interface ReadyNodeRuntimeSnapshot {
  readonly completedNodeIds: readonly string[];
  readonly runningNodeIds: readonly string[];
  readonly externalClaims: readonly ReadyNodeResourceClaim[];
  readonly repoConcurrency: readonly ReadyNodeRepoConcurrency[];
  readonly globalCap: number;
  readonly buildCachePressure: 'ok' | 'warn' | 'critical';
  readonly taskBudgets?: readonly ReadyNodeTaskBudget[];
  readonly globalBudgetRemaining?: number | null;
}
export interface LinearScheduleObservation {
  readonly dispatchedNodeIds: readonly string[];
  readonly conflictNodeIds?: readonly string[];
  readonly reworkNodeIds?: readonly string[];
}
export interface ReadyNodeShadowInput {
  readonly graph: TaskGraph;
  readonly runtime: ReadyNodeRuntimeSnapshot;
  readonly leafVerdicts?: readonly ReadyNodeLeafVerdict[];
  readonly linearObservation?: LinearScheduleObservation;
  readonly evaluatedAtMs: number;
}
export interface ReadyNodeDependencyStatus {
  readonly nodeId: string;
  readonly status: 'satisfied' | 'unresolved' | 'missing' | 'cyclic';
}
export interface ReadyNodeResourceStatus {
  readonly kind: TaskGraphResourceKind; readonly key: string;
  readonly exclusive: boolean; readonly status: 'free' | 'held' | 'conflict' | 'pressure';
}
export interface ReadyNodeExplanation {
  readonly nodeId: string; readonly verdict: ReadyNodeVerdict; readonly rank: number | null;
  readonly blockCodes: readonly ReadyNodeBlockCode[];
  readonly reasons: readonly string[];
  readonly resourcesConsidered: readonly ReadyNodeResourceStatus[];
  readonly dependencies: readonly ReadyNodeDependencyStatus[];
}
export interface ReadyNodeLinearComparison {
  readonly shadowRecommended: readonly string[];
  readonly linearDispatched: readonly string[];
  readonly both: readonly string[];
  readonly shadowOnly: readonly string[];
  readonly linearOnly: readonly string[];
  readonly linearConflictsAlsoBlockedByShadow: readonly string[];
  readonly linearReworkAlsoBlockedByShadow: readonly string[];
  readonly agreementRatio: number;
  readonly notes: readonly string[];
}
export interface ReadyNodeShadowResult {
  readonly version: typeof READY_NODE_SHADOW_VERSION;
  readonly kind: 'ready_node_shadow_schedule';
  readonly mode: 'shadow';
  readonly verifiedWork: false;
  readonly mutatesGraph: false;
  readonly authorizesDispatch: false;
  readonly affectsLinearDispatch: false;
  readonly graphId: string;
  readonly graphDigest: string;
  readonly evaluatedAtMs: number;
  readonly recommendedNodeIds: readonly string[];
  readonly explanations: readonly ReadyNodeExplanation[];
  readonly comparison: ReadyNodeLinearComparison | null;
  readonly resultDigest: string;
}
export type ReadyNodeShadowBuildResult =
  | { readonly ok: true; readonly result: ReadyNodeShadowResult }
  | { readonly ok: false; readonly errors: readonly TaskGraphValidationIssue[] };
export type ReadyNodeShadowParseResult = ReadyNodeShadowBuildResult;

export function boundReadyNodeText(text: string, max = MAX_READY_NODE_REASON_LEN): string {
  return redactProposedGraphText(text, max);
}

export function sortReadyNodeKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortReadyNodeKeysDeep);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v !== undefined) out[key] = sortReadyNodeKeysDeep(v);
  }
  return out;
}

export function readyNodeShadowCanonicalPayload(
  result: Omit<ReadyNodeShadowResult, 'resultDigest'> | ReadyNodeShadowResult,
): string {
  const r = result as ReadyNodeShadowResult;
  return JSON.stringify(sortReadyNodeKeysDeep({
    version: r.version, kind: r.kind, mode: r.mode,
    verifiedWork: false, mutatesGraph: false, authorizesDispatch: false,
    affectsLinearDispatch: false, graphId: r.graphId, graphDigest: r.graphDigest,
    evaluatedAtMs: r.evaluatedAtMs, recommendedNodeIds: r.recommendedNodeIds,
    explanations: r.explanations, comparison: r.comparison,
  }));
}

export function readyNodeShadowResultDigest(
  result: Omit<ReadyNodeShadowResult, 'resultDigest'> | ReadyNodeShadowResult,
): string {
  return createHash('sha256').update(readyNodeShadowCanonicalPayload(result), 'utf8').digest('hex');
}

export function readyNodeShadowAuthorizesDispatch(_r: ReadyNodeShadowResult | null): false { return false; }
export function readyNodeShadowMutatesAcceptedGraph(_r: ReadyNodeShadowResult | null): false { return false; }
export function readyNodeShadowAffectsLinearDispatch(_r: ReadyNodeShadowResult | null): false { return false; }
export function readyNodeShadowWeakensExecutionPolicy(_r: ReadyNodeShadowResult | null): false { return false; }
export function readyNodeShadowWeakensLeases(_r: ReadyNodeShadowResult | null): false { return false; }
export function readyNodeShadowWeakensGates(_r: ReadyNodeShadowResult | null): false { return false; }
export function readyNodeShadowWeakensHumanApproval(_r: ReadyNodeShadowResult | null): false { return false; }
export function readyNodeShadowMayAutonomousFanOut(_r: ReadyNodeShadowResult | null): false { return false; }
export function readyNodeShadowMayWidenPermissions(_r: ReadyNodeShadowResult | null): false { return false; }
export function readyNodeShadowMayMergeOrDeploy(_r: ReadyNodeShadowResult | null): false { return false; }
