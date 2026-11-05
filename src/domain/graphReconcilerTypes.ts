/**
 * Types + digests + authority for the graph reconciler / top-level integration
 * packet (adaptive-task-graph step 5). Pure, advisory only.
 */
import { createHash } from 'node:crypto';
import type { TaskGraph, TaskGraphAcceptanceKind, TaskGraphReservedHumanAction, TaskGraphValidationIssue } from './taskGraph.js';
import { redactProposedGraphText } from './proposedGraphPacket.js';

export const GRAPH_RECONCILER_VERSION = 1 as const;
export const GRAPH_RECONCILER_HEADING = '## Graph reconciler / integration packet (advisory)';
export const GRAPH_RECONCILER_BLOCK_START = '<!-- hercules-graph-reconciler:v1';
export const GRAPH_RECONCILER_BLOCK_END = '-->';
export const MAX_GRAPH_RECONCILER_REASONS = 16;
export const MAX_GRAPH_RECONCILER_REASON_LEN = 400;
export const MAX_GRAPH_RECONCILER_RESULT_BYTES = 96 * 1024;
export const MAX_GRAPH_RECONCILER_EVIDENCE = 64;
export const MAX_GRAPH_RECONCILER_ACTIONS = 64;

/** Actions this reconciler never authorizes or auto-applies. */
export const GRAPH_RECONCILER_FORBIDDEN_ACTIONS = [
  'dispatch',
  'execute',
  'schedule',
  'auto_dispatch_replan',
  'merge',
  'deploy',
  'promote',
  'privilege_change',
  'permission_change',
  'external_publication',
  'destructive_action',
  'cost_expansion',
  'autonomous_fan_out',
  'auto_apply_human_decision',
] as const;
export type GraphReconcilerForbiddenAction =
  (typeof GRAPH_RECONCILER_FORBIDDEN_ACTIONS)[number];

export const GRAPH_NODE_EVIDENCE_STATUSES = [
  'accepted',
  'failed',
  'uncertain',
  'running',
  'pending',
  'blocked',
] as const;
export type GraphNodeEvidenceStatus = (typeof GRAPH_NODE_EVIDENCE_STATUSES)[number];

export const GRAPH_INTEGRATION_STATUSES = [
  'unproven',
  'passed',
  'failed',
  'uncertain',
  'blocked_by_children',
] as const;
export type GraphIntegrationStatus = (typeof GRAPH_INTEGRATION_STATUSES)[number];

export const GRAPH_RECONCILER_OVERALL_VERDICTS = [
  'in_progress',
  'awaiting_integration',
  'integration_failed',
  'integration_uncertain',
  'objective_proven',
  'needs_replan',
  'needs_human',
] as const;
export type GraphReconcilerOverallVerdict =
  (typeof GRAPH_RECONCILER_OVERALL_VERDICTS)[number];

export const LOCAL_REPLAN_ACTION_KINDS = [
  'preserve',
  'retry',
  'require_investigation',
  'escalate_human',
  'hold_for_integration',
  'accept',
] as const;
export type LocalReplanActionKind = (typeof LOCAL_REPLAN_ACTION_KINDS)[number];

export class GraphReconcilerError extends Error {
  override readonly name = 'GraphReconcilerError';
  readonly issues: readonly TaskGraphValidationIssue[];
  constructor(message: string, issues: readonly TaskGraphValidationIssue[] = []) {
    super(message);
    this.issues = issues;
  }
}

/** Actual runtime evidence for one graph node (not planner assertion). */
export interface GraphNodeEvidence {
  readonly nodeId: string;
  readonly status: GraphNodeEvidenceStatus;
  readonly attemptCount: number;
  readonly evidenceDigest?: string | null;
  readonly failureKind?: string | null;
  readonly failureDetail?: string | null;
  /** Nodes newly discovered as coupled to this one (requires investigation). */
  readonly discoveredCouplingNodeIds?: readonly string[];
  /** Cycle participants discovered at runtime (requires investigation). */
  readonly discoveredCycleNodeIds?: readonly string[];
}

export interface GraphAcceptedProvenance {
  readonly nodeId: string;
  readonly evidenceDigest: string;
  readonly leaseKeys: readonly string[];
}

export interface GraphIntegrationEvidence {
  readonly status: 'unproven' | 'passed' | 'failed' | 'uncertain';
  readonly detail?: string | null;
  readonly proofDigests?: readonly string[];
}

export interface GraphReconcilerInput {
  readonly graph: TaskGraph;
  readonly nodeEvidence: readonly GraphNodeEvidence[];
  readonly evaluatedAtMs: number;
  readonly acceptedProvenance?: readonly GraphAcceptedProvenance[];
  readonly integrationEvidence?: GraphIntegrationEvidence;
}

export interface ProposedReplanInvestigation {
  readonly id: string;
  readonly kind: 'investigation';
  readonly title: string;
  readonly goal: string;
  readonly scope: string;
  readonly unknownToResolve: string;
  readonly relatedNodeIds: readonly string[];
  readonly reasonCodes: readonly string[];
}

export interface LocalReplanAction {
  readonly kind: LocalReplanActionKind;
  readonly nodeId: string;
  readonly reason: string;
  readonly investigationId?: string;
  readonly humanAction?: TaskGraphReservedHumanAction | 'product_judgement';
}

/** Bounded local replan proposal — never mutates accepted graph or dispatches. */
export interface LocalReplanProposal {
  readonly affectedNodeIds: readonly string[];
  readonly preservedNodeIds: readonly string[];
  readonly preservedLeaseKeys: readonly string[];
  readonly preservedProvenance: readonly GraphAcceptedProvenance[];
  readonly actions: readonly LocalReplanAction[];
  readonly proposedInvestigations: readonly ProposedReplanInvestigation[];
  readonly mutatesAcceptedGraph: false;
  readonly authorizesDispatch: false;
  readonly limitedToAffectedSubgraph: true;
}

export interface IntegrationAcceptanceStatus {
  readonly kind: TaskGraphAcceptanceKind;
  readonly description: string;
  readonly status: 'unproven' | 'passed' | 'failed' | 'uncertain' | 'human_required';
  readonly evidenceHook?: string;
}

export interface ChildNodeSummary {
  readonly accepted: readonly string[];
  readonly failed: readonly string[];
  readonly uncertain: readonly string[];
  readonly pending: readonly string[];
  readonly running: readonly string[];
  readonly blocked: readonly string[];
  readonly allChildrenAccepted: boolean;
}

/**
 * Top-level integration assessment: original objective is proven separately
 * from child-node green status. Child success alone never yields objective_proven.
 */
export interface TopLevelIntegrationAssessment {
  readonly objectiveNodeId: string;
  readonly objectiveGoal: string;
  readonly requiresTopLevelVerification: true;
  readonly status: GraphIntegrationStatus;
  readonly acceptance: readonly IntegrationAcceptanceStatus[];
  readonly childSummary: ChildNodeSummary;
  /** Hard invariant: green children ≠ objective success. */
  readonly childrenGreenIsNotSuccess: true;
  readonly detail: string;
}

export interface GraphReconcilerResult {
  readonly version: typeof GRAPH_RECONCILER_VERSION;
  readonly kind: 'graph_reconciler_integration_packet';
  readonly mode: 'advisory';
  readonly verifiedWork: false;
  readonly mutatesGraph: false;
  readonly authorizesDispatch: false;
  readonly authorizesMerge: false;
  readonly authorizesDeploy: false;
  readonly authorizesPermissionChange: false;
  readonly autoAppliesHumanDecisions: false;
  readonly autoDispatchesReplan: false;
  readonly graphId: string;
  readonly graphDigest: string;
  readonly evaluatedAtMs: number;
  readonly overallVerdict: GraphReconcilerOverallVerdict;
  readonly localReplan: LocalReplanProposal;
  readonly integration: TopLevelIntegrationAssessment;
  readonly reservedHumanActions: readonly TaskGraphReservedHumanAction[];
  readonly visibleFailures: readonly string[];
  readonly visibleUncertainties: readonly string[];
  readonly resultDigest: string;
}

export type GraphReconcilerBuildResult =
  | { readonly ok: true; readonly result: GraphReconcilerResult }
  | { readonly ok: false; readonly errors: readonly TaskGraphValidationIssue[] };

export type GraphReconcilerParseResult = GraphReconcilerBuildResult;

export function boundReconcilerText(
  text: string,
  max = MAX_GRAPH_RECONCILER_REASON_LEN,
): string {
  return redactProposedGraphText(text, max);
}

export function sortReconcilerKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortReconcilerKeysDeep);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v !== undefined) out[key] = sortReconcilerKeysDeep(v);
  }
  return out;
}

export function graphReconcilerCanonicalPayload(
  result: Omit<GraphReconcilerResult, 'resultDigest'> | GraphReconcilerResult,
): string {
  const r = result as GraphReconcilerResult;
  return JSON.stringify(
    sortReconcilerKeysDeep({
      version: r.version,
      kind: r.kind,
      mode: r.mode,
      verifiedWork: false,
      mutatesGraph: false,
      authorizesDispatch: false,
      authorizesMerge: false,
      authorizesDeploy: false,
      authorizesPermissionChange: false,
      autoAppliesHumanDecisions: false,
      autoDispatchesReplan: false,
      graphId: r.graphId,
      graphDigest: r.graphDigest,
      evaluatedAtMs: r.evaluatedAtMs,
      overallVerdict: r.overallVerdict,
      localReplan: r.localReplan,
      integration: r.integration,
      reservedHumanActions: r.reservedHumanActions,
      visibleFailures: r.visibleFailures,
      visibleUncertainties: r.visibleUncertainties,
    }),
  );
}

export function graphReconcilerResultDigest(
  result: Omit<GraphReconcilerResult, 'resultDigest'> | GraphReconcilerResult,
): string {
  return createHash('sha256')
    .update(graphReconcilerCanonicalPayload(result), 'utf8')
    .digest('hex');
}

export function graphReconcilerAuthorizesDispatch(
  _r: GraphReconcilerResult | null,
): false {
  return false;
}
export function graphReconcilerMutatesAcceptedGraph(
  _r: GraphReconcilerResult | null,
): false {
  return false;
}
export function graphReconcilerAutoDispatchesReplan(
  _r: GraphReconcilerResult | null,
): false {
  return false;
}
export function graphReconcilerAutoAppliesHumanDecisions(
  _r: GraphReconcilerResult | null,
): false {
  return false;
}
export function graphReconcilerAuthorizesMerge(
  _r: GraphReconcilerResult | null,
): false {
  return false;
}
export function graphReconcilerAuthorizesDeploy(
  _r: GraphReconcilerResult | null,
): false {
  return false;
}
export function graphReconcilerAuthorizesPermissionChange(
  _r: GraphReconcilerResult | null,
): false {
  return false;
}
export function graphReconcilerWeakensExecutionPolicy(
  _r: GraphReconcilerResult | null,
): false {
  return false;
}
export function graphReconcilerWeakensLeases(
  _r: GraphReconcilerResult | null,
): false {
  return false;
}
export function graphReconcilerWeakensGates(
  _r: GraphReconcilerResult | null,
): false {
  return false;
}
export function graphReconcilerWeakensHumanApproval(
  _r: GraphReconcilerResult | null,
): false {
  return false;
}
export function graphReconcilerMayEnterScheduling(
  _r: GraphReconcilerResult | null,
): false {
  return false;
}
