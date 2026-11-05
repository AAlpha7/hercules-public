/**
 * Domain — advisory proposed graph packet (adaptive-task-graph step 2).
 * Digest-bound planner artifact from a validated TaskGraph. Advisory only:
 * never creates/dispatches children; invalid output fails closed. Pure.
 */
import { createHash } from 'node:crypto';
import { redactHostOutput } from './hostExecutor.js';
import {
  TASK_GRAPH_RESERVED_HUMAN_ACTIONS,
  serializeTaskGraph,
  type TaskGraph,
  type TaskGraphAcceptanceKind,
  type TaskGraphValidationIssue,
} from './taskGraph.js';

export const PROPOSED_GRAPH_PACKET_VERSION = 1 as const;
export const PROPOSED_GRAPH_PACKET_HEADING = '## Proposed graph (advisory)';
export const PROPOSED_GRAPH_PACKET_BLOCK_START = '<!-- hercules-proposed-graph:v1';
export const PROPOSED_GRAPH_PACKET_BLOCK_END = '-->';
export const MAX_PROPOSED_GRAPH_UNKNOWNS = 32;
export const MAX_PROPOSED_GRAPH_UNKNOWN_LEN = 400;
export const MAX_PROPOSED_GRAPH_NOTES_LEN = 800;
export const MAX_PROPOSED_GRAPH_PACKET_BYTES = 96 * 1024;

export class ProposedGraphPacketError extends Error {
  override readonly name = 'ProposedGraphPacketError';
  readonly issues: readonly TaskGraphValidationIssue[];
  constructor(message: string, issues: readonly TaskGraphValidationIssue[] = []) {
    super(message);
    this.issues = issues;
  }
}

export interface ProposedGraphProofCommand {
  readonly nodeId: string;
  readonly kind: TaskGraphAcceptanceKind;
  readonly command: string;
  readonly evidenceHook?: string;
}

export interface ProposedGraphUnknown {
  readonly source: 'declared' | 'investigation_node';
  readonly text: string;
  readonly nodeId?: string;
}

export interface ProposedGraphOperatorDecision {
  readonly kind: 'reserved_human_action' | 'human_acceptance' | 'unknown';
  readonly text: string;
  readonly nodeId?: string;
}

/** Stored advisory artifact. Display fields are derived from graph at render. */
export interface ProposedGraphPacket {
  readonly version: typeof PROPOSED_GRAPH_PACKET_VERSION;
  readonly kind: 'proposed_graph';
  readonly mode: 'advisory';
  readonly verifiedWork: false;
  readonly graph: TaskGraph;
  readonly graphDigest: string;
  readonly unknowns: readonly ProposedGraphUnknown[];
  readonly notes: string | null;
  readonly packetDigest: string;
}

export type ProposedGraphPacketBuildResult =
  | { readonly ok: true; readonly packet: ProposedGraphPacket }
  | { readonly ok: false; readonly errors: readonly TaskGraphValidationIssue[] };

export type ProposedGraphPacketParseResult = ProposedGraphPacketBuildResult;

function boundText(text: string, max: number): string {
  const one = text.split(/\s+/).join(' ').trim();
  return one.length <= max ? one : one.slice(0, max - 1) + '…';
}

/** Redact host paths and provider/secret material from planner free text. */
export function redactProposedGraphText(raw: string, max = MAX_PROPOSED_GRAPH_NOTES_LEN): string {
  let text = raw.replace(/\r\n/g, '\n');
  text = text.replace(
    /(?:^|[\s"'`=(])(\/(?:home|Users|var|tmp|private|opt|etc|usr|root)\/[^\s"'`<>]+)/g,
    (m, p1: string) => m.replace(p1, '[host-path]'),
  );
  text = text.replace(
    /\/(?:home|Users|var|tmp|private|opt|etc|usr|root)\/[^\s"'`<>]+/g,
    '[host-path]',
  );
  text = text.replace(/\b[A-Za-z]:\\[^\s"'`<>]+/g, '[host-path]');
  text = text.replace(/\\\\[^\s"'`<>]+/g, '[host-path]');
  text = text.replace(/\b(?:stderr|stdout)\s+from\s+\[host-path\]/gi, 'provider-log [redacted]');
  text = text.replace(/\bxAI\s+stream:\s*/gi, 'provider-log: ');
  text = redactHostOutput(text, Math.max(max * 2, max));
  text = text.replace(/^…\[truncated \d+ chars]…\n/, '');
  return boundText(text, max);
}

function proofFrom(
  nodeId: string,
  kind: TaskGraphAcceptanceKind,
  description: string,
  evidenceHook?: string,
): ProposedGraphProofCommand {
  const command = redactProposedGraphText(description, MAX_PROPOSED_GRAPH_UNKNOWN_LEN);
  if (evidenceHook !== undefined) return { nodeId, kind, command, evidenceHook };
  return { nodeId, kind, command };
}

export function extractProofCommands(graph: TaskGraph): readonly ProposedGraphProofCommand[] {
  const out: ProposedGraphProofCommand[] = [];
  for (const n of graph.nodes) {
    for (const a of n.contract.acceptance) {
      if (a.kind === 'mechanical') {
        out.push(proofFrom(n.id, a.kind, a.description, a.evidenceHook));
      }
    }
  }
  for (const a of graph.integration.acceptance) {
    if (a.kind === 'mechanical') {
      out.push(proofFrom('integration', a.kind, a.description, a.evidenceHook));
    }
  }
  return out;
}

export function extractDeclaredUnknowns(raw: unknown): readonly ProposedGraphUnknown[] {
  if (!Array.isArray(raw)) return [];
  const out: ProposedGraphUnknown[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const text = redactProposedGraphText(item, MAX_PROPOSED_GRAPH_UNKNOWN_LEN);
    if (text.length === 0) continue;
    out.push({ source: 'declared', text });
    if (out.length >= MAX_PROPOSED_GRAPH_UNKNOWNS) break;
  }
  return out;
}

export function mergeUnknowns(
  a: readonly ProposedGraphUnknown[],
  b: readonly ProposedGraphUnknown[],
): readonly ProposedGraphUnknown[] {
  const out: ProposedGraphUnknown[] = [];
  const seen = new Set<string>();
  for (const u of [...a, ...b]) {
    const key = (u.nodeId ?? '') + '|' + u.text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
    if (out.length >= MAX_PROPOSED_GRAPH_UNKNOWNS) break;
  }
  return out;
}

export function extractOperatorDecisions(
  graph: TaskGraph,
  unknowns: readonly ProposedGraphUnknown[],
): readonly ProposedGraphOperatorDecision[] {
  const out: ProposedGraphOperatorDecision[] = [];
  for (const action of TASK_GRAPH_RESERVED_HUMAN_ACTIONS) {
    out.push({
      kind: 'reserved_human_action',
      text: 'Human boundary reserved: ' + action + ' (never authorized by this packet)',
    });
  }
  for (const n of graph.nodes) {
    for (const a of n.contract.acceptance) {
      if (a.kind !== 'human') continue;
      out.push({
        kind: 'human_acceptance',
        text: redactProposedGraphText(a.description, MAX_PROPOSED_GRAPH_UNKNOWN_LEN),
        nodeId: n.id,
      });
    }
  }
  for (const u of unknowns) {
    if (u.nodeId !== undefined) {
      out.push({ kind: 'unknown', text: 'Unresolved: ' + u.text, nodeId: u.nodeId });
    } else {
      out.push({ kind: 'unknown', text: 'Unresolved: ' + u.text });
    }
  }
  return out;
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

export function proposedGraphPacketCanonicalPayload(
  packet: Omit<ProposedGraphPacket, 'packetDigest'> | ProposedGraphPacket,
): string {
  const p = packet as ProposedGraphPacket;
  return JSON.stringify(
    sortKeysDeep({
      version: p.version,
      kind: p.kind,
      mode: p.mode,
      verifiedWork: false,
      graphCanonical: serializeTaskGraph(p.graph).replace(/\n$/, ''),
      graphDigest: p.graphDigest,
      unknowns: p.unknowns,
      notes: p.notes,
    }),
  );
}

export function proposedGraphPacketDigest(
  packet: Omit<ProposedGraphPacket, 'packetDigest'> | ProposedGraphPacket,
): string {
  return createHash('sha256')
    .update(proposedGraphPacketCanonicalPayload(packet), 'utf8')
    .digest('hex');
}

export {
  buildProposedGraphPacket,
  serializeProposedGraphPacket,
  formatProposedGraphPacketMarkdown,
  parseProposedGraphPacket,
  proposedGraphMayEnterScheduling,
  proposedGraphAuthorizesDispatch,
  proposedGraphAuthorizesChildTaskCreation,
} from './proposedGraphPacketOps.js';
