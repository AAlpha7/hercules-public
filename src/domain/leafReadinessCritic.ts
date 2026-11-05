/**
 * Domain — evidence-bound leaf-readiness critic (adaptive-task-graph step 3).
 * Pure, advisory only: never mutates the accepted graph, never authorizes
 * dispatch/scheduling, never weakens execution policy, leases, gates, or human
 * approval. Non-leaf outcomes yield bounded reasons + a proposed investigation
 * node (not inserted). Decisions are durable and digest-bound.
 */
import { createHash } from 'node:crypto';
import type { TaskGraph, TaskGraphResourceKind, TaskGraphValidationIssue } from './taskGraph.js';
import type { ProposedGraphUnknown } from './proposedGraphPacket.js';
import { redactProposedGraphText } from './proposedGraphPacket.js';

export const LEAF_READINESS_CRITIC_VERSION = 1 as const;
export const LEAF_READINESS_DECISION_HEADING = '## Leaf readiness (advisory)';
export const LEAF_READINESS_BLOCK_START = '<!-- hercules-leaf-readiness:v1';
export const LEAF_READINESS_BLOCK_END = '-->';

export const MAX_LEAF_READINESS_REASONS = 16;
export const MAX_LEAF_READINESS_REASON_LEN = 400;
export const MAX_LEAF_READINESS_EVIDENCE = 8;
export const MAX_LEAF_READINESS_DECISION_BYTES = 64 * 1024;

export const LEAF_READINESS_CHECK_CODES = [
  'observable_outcome',
  'independent_proof',
  'declared_inputs',
  'repository_scope',
  'path_resource_conflict',
  'unresolved_dependency',
] as const;
export type LeafReadinessCheckCode = (typeof LEAF_READINESS_CHECK_CODES)[number];

export const LEAF_READINESS_REASON_CODES = [
  'missing_observable_outcome',
  'missing_independent_proof',
  'missing_declared_inputs',
  'scope_unknown',
  'scope_overbroad',
  'path_conflict',
  'resource_conflict',
  'unresolved_dependency',
  'unresolved_unknown',
  'under_split',
  'over_split',
  'hidden_coupling',
  'cyclic_discovery',
] as const;
export type LeafReadinessReasonCode = (typeof LEAF_READINESS_REASON_CODES)[number];

export const LEAF_READINESS_VERDICTS = [
  'leaf_ready',
  'not_leaf',
  'investigation_required',
] as const;
export type LeafReadinessVerdict = (typeof LEAF_READINESS_VERDICTS)[number];

export class LeafReadinessCriticError extends Error {
  override readonly name = 'LeafReadinessCriticError';
  readonly issues: readonly TaskGraphValidationIssue[];
  constructor(message: string, issues: readonly TaskGraphValidationIssue[] = []) {
    super(message);
    this.issues = issues;
  }
}

export interface LeafReadinessCheck {
  readonly code: LeafReadinessCheckCode;
  readonly ok: boolean;
  readonly detail: string;
  readonly evidence: readonly string[];
}

export interface LeafReadinessReason {
  readonly code: LeafReadinessReasonCode;
  readonly detail: string;
  readonly evidence: readonly string[];
}

/** Proposed only — never inserted into the accepted graph by this module. */
export interface ProposedInvestigationNode {
  readonly id: string;
  readonly kind: 'investigation';
  readonly title: string;
  readonly goal: string;
  readonly scope: string;
  readonly unknownToResolve: string;
  readonly relatedNodeId: string;
}

export interface LeafReadinessDecision {
  readonly version: typeof LEAF_READINESS_CRITIC_VERSION;
  readonly kind: 'leaf_readiness';
  readonly mode: 'advisory';
  readonly verifiedWork: false;
  readonly mutatesGraph: false;
  readonly authorizesDispatch: false;
  readonly nodeId: string;
  readonly graphId: string;
  readonly graphDigest: string;
  readonly verdict: LeafReadinessVerdict;
  readonly checks: readonly LeafReadinessCheck[];
  readonly reasons: readonly LeafReadinessReason[];
  readonly proposedInvestigation: ProposedInvestigationNode | null;
  readonly decisionDigest: string;
}

export type LeafReadinessBuildResult =
  | { readonly ok: true; readonly decision: LeafReadinessDecision }
  | { readonly ok: false; readonly errors: readonly TaskGraphValidationIssue[] };

export type LeafReadinessParseResult = LeafReadinessBuildResult;

export interface LeafReadinessExternalClaim {
  readonly kind: TaskGraphResourceKind;
  readonly key: string;
  readonly exclusive: boolean;
  readonly holderId?: string;
}

export interface LeafReadinessCriticInput {
  readonly graph: TaskGraph;
  readonly nodeId: string;
  readonly unknowns?: readonly ProposedGraphUnknown[];
  readonly externalClaims?: readonly LeafReadinessExternalClaim[];
}

export function boundLeafText(text: string, max = MAX_LEAF_READINESS_REASON_LEN): string {
  return redactProposedGraphText(text, max);
}

export function boundLeafEvidence(items: readonly string[]): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const t = boundLeafText(raw, 120);
    if (t.length === 0 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_LEAF_READINESS_EVIDENCE) break;
  }
  return out;
}

export function sortLeafKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortLeafKeysDeep);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v !== undefined) out[key] = sortLeafKeysDeep(v);
  }
  return out;
}

export function leafReadinessDecisionCanonicalPayload(
  decision: Omit<LeafReadinessDecision, 'decisionDigest'> | LeafReadinessDecision,
): string {
  const d = decision as LeafReadinessDecision;
  return JSON.stringify(
    sortLeafKeysDeep({
      version: d.version,
      kind: d.kind,
      mode: d.mode,
      verifiedWork: false,
      mutatesGraph: false,
      authorizesDispatch: false,
      nodeId: d.nodeId,
      graphId: d.graphId,
      graphDigest: d.graphDigest,
      verdict: d.verdict,
      checks: d.checks,
      reasons: d.reasons,
      proposedInvestigation: d.proposedInvestigation,
    }),
  );
}

export function leafReadinessDecisionDigest(
  decision: Omit<LeafReadinessDecision, 'decisionDigest'> | LeafReadinessDecision,
): string {
  return createHash('sha256')
    .update(leafReadinessDecisionCanonicalPayload(decision), 'utf8')
    .digest('hex');
}

export function leafReadinessIssue(
  code: TaskGraphValidationIssue['code'],
  message: string,
): TaskGraphValidationIssue {
  return { code, message: boundLeafText(message) };
}

export function leafReadinessAuthorizesDispatch(_d: LeafReadinessDecision | null): false {
  return false;
}

export function leafReadinessMutatesAcceptedGraph(_d: LeafReadinessDecision | null): false {
  return false;
}

export function leafReadinessMayEnterScheduling(_input: unknown): false {
  return false;
}

export function leafReadinessWeakensExecutionPolicy(_d: LeafReadinessDecision | null): false {
  return false;
}

export function leafReadinessWeakensLeases(_d: LeafReadinessDecision | null): false {
  return false;
}

export function leafReadinessWeakensGates(_d: LeafReadinessDecision | null): false {
  return false;
}

export function leafReadinessWeakensHumanApproval(_d: LeafReadinessDecision | null): false {
  return false;
}

export { evaluateLeafReadiness, buildLeafReadinessDecision } from './leafReadinessCriticEval.js';
export {
  serializeLeafReadinessDecision,
  formatLeafReadinessDecisionMarkdown,
  parseLeafReadinessDecision,
} from './leafReadinessCriticOps.js';
