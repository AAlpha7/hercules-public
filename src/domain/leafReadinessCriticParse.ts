/** Parse digest-bound leaf-readiness decisions. */
import {
  LEAF_READINESS_BLOCK_END,
  LEAF_READINESS_BLOCK_START,
  LEAF_READINESS_CHECK_CODES,
  LEAF_READINESS_CRITIC_VERSION,
  LEAF_READINESS_DECISION_HEADING,
  LEAF_READINESS_REASON_CODES,
  LEAF_READINESS_VERDICTS,
  MAX_LEAF_READINESS_DECISION_BYTES,
  LeafReadinessCriticError,
  boundLeafEvidence,
  boundLeafText,
  leafReadinessDecisionDigest,
  leafReadinessIssue,
  type LeafReadinessCheck,
  type LeafReadinessCheckCode,
  type LeafReadinessParseResult,
  type LeafReadinessReason,
  type LeafReadinessReasonCode,
  type LeafReadinessVerdict,
  type ProposedInvestigationNode,
} from './leafReadinessCritic.js';

function isSha256Hex(v: string): boolean {
  return v.length === 64 && /^[0-9a-f]+$/.test(v);
}

function isReasonCode(v: unknown): v is LeafReadinessReasonCode {
  return typeof v === 'string' && (LEAF_READINESS_REASON_CODES as readonly string[]).includes(v);
}

function isCheckCode(v: unknown): v is LeafReadinessCheckCode {
  return typeof v === 'string' && (LEAF_READINESS_CHECK_CODES as readonly string[]).includes(v);
}

function isVerdict(v: unknown): v is LeafReadinessVerdict {
  return typeof v === 'string' && (LEAF_READINESS_VERDICTS as readonly string[]).includes(v);
}

function normalizeCheck(raw: unknown): LeafReadinessCheck | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!isCheckCode(o['code']) || typeof o['ok'] !== 'boolean' || typeof o['detail'] !== 'string') {
    return null;
  }
  const evidence = Array.isArray(o['evidence'])
    ? o['evidence'].filter((e): e is string => typeof e === 'string').map((e) => boundLeafText(e, 120))
    : [];
  return {
    code: o['code'],
    ok: o['ok'],
    detail: boundLeafText(o['detail']),
    evidence: boundLeafEvidence(evidence),
  };
}

function normalizeReason(raw: unknown): LeafReadinessReason | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!isReasonCode(o['code']) || typeof o['detail'] !== 'string') return null;
  const evidence = Array.isArray(o['evidence'])
    ? o['evidence'].filter((e): e is string => typeof e === 'string').map((e) => boundLeafText(e, 120))
    : [];
  return {
    code: o['code'],
    detail: boundLeafText(o['detail']),
    evidence: boundLeafEvidence(evidence),
  };
}

function normalizeInvestigation(raw: unknown): ProposedInvestigationNode | null {
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o['kind'] !== 'investigation') return null;
  if (typeof o['id'] !== 'string' || typeof o['title'] !== 'string') return null;
  if (typeof o['goal'] !== 'string' || typeof o['scope'] !== 'string') return null;
  if (typeof o['unknownToResolve'] !== 'string' || typeof o['relatedNodeId'] !== 'string') {
    return null;
  }
  return {
    id: o['id'],
    kind: 'investigation',
    title: boundLeafText(o['title'], 120),
    goal: boundLeafText(o['goal']),
    scope: boundLeafText(o['scope'], 200),
    unknownToResolve: boundLeafText(o['unknownToResolve']),
    relatedNodeId: o['relatedNodeId'],
  };
}

export function parseLeafReadinessDecision(text: string): LeafReadinessParseResult {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new LeafReadinessCriticError(
      'leaf readiness decision document must be a non-empty string',
    );
  }
  if (text.length > MAX_LEAF_READINESS_DECISION_BYTES) {
    throw new LeafReadinessCriticError('leaf readiness decision document exceeds size bound');
  }
  if (
    !text.includes(LEAF_READINESS_DECISION_HEADING) &&
    !text.includes(LEAF_READINESS_BLOCK_START)
  ) {
    throw new LeafReadinessCriticError('leaf readiness decision not found');
  }
  let searchFrom = 0;
  let lastJson: string | null = null;
  while (searchFrom < text.length) {
    const s = text.indexOf(LEAF_READINESS_BLOCK_START, searchFrom);
    if (s < 0) break;
    const jsonStart = s + LEAF_READINESS_BLOCK_START.length;
    const after = text.slice(jsonStart);
    const nl = after.startsWith('\n') ? 1 : after.startsWith('\r\n') ? 2 : 0;
    const e = text.indexOf(LEAF_READINESS_BLOCK_END, jsonStart + nl);
    if (e < 0) break;
    lastJson = text.slice(jsonStart + nl, e).trim();
    searchFrom = e + LEAF_READINESS_BLOCK_END.length;
  }
  if (!lastJson) {
    return { ok: false, errors: [leafReadinessIssue('schema', 'leaf readiness JSON block missing')] };
  }
  let value: unknown;
  try {
    value = JSON.parse(lastJson) as unknown;
  } catch {
    return { ok: false, errors: [leafReadinessIssue('schema', 'leaf readiness JSON is not valid')] };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      errors: [leafReadinessIssue('schema', 'leaf readiness payload must be an object')],
    };
  }
  const o = value as Record<string, unknown>;
  if (o['version'] !== LEAF_READINESS_CRITIC_VERSION) {
    return { ok: false, errors: [leafReadinessIssue('schema', 'leaf readiness version mismatch')] };
  }
  if (
    o['kind'] !== 'leaf_readiness' ||
    o['mode'] !== 'advisory' ||
    o['verifiedWork'] !== false ||
    o['mutatesGraph'] !== false ||
    o['authorizesDispatch'] !== false
  ) {
    return {
      ok: false,
      errors: [
        leafReadinessIssue(
          'schema',
          'leaf readiness must be advisory with no dispatch/mutation authority',
        ),
      ],
    };
  }
  if (typeof o['decisionDigest'] !== 'string' || !isSha256Hex(o['decisionDigest'])) {
    return { ok: false, errors: [leafReadinessIssue('schema', 'decisionDigest missing or invalid')] };
  }
  if (typeof o['graphDigest'] !== 'string' || !isSha256Hex(o['graphDigest'])) {
    return { ok: false, errors: [leafReadinessIssue('schema', 'graphDigest missing or invalid')] };
  }
  if (typeof o['nodeId'] !== 'string' || typeof o['graphId'] !== 'string') {
    return { ok: false, errors: [leafReadinessIssue('schema', 'nodeId and graphId required')] };
  }
  if (!isVerdict(o['verdict'])) {
    return { ok: false, errors: [leafReadinessIssue('schema', 'verdict invalid')] };
  }
  if (!Array.isArray(o['checks']) || !Array.isArray(o['reasons'])) {
    return {
      ok: false,
      errors: [leafReadinessIssue('schema', 'checks and reasons must be arrays')],
    };
  }
  const checks: LeafReadinessCheck[] = [];
  for (const c of o['checks']) {
    const n = normalizeCheck(c);
    if (n) checks.push(n);
  }
  const reasons: LeafReadinessReason[] = [];
  for (const r of o['reasons']) {
    const n = normalizeReason(r);
    if (n) reasons.push(n);
  }
  const proposedInvestigation =
    o['proposedInvestigation'] === null || o['proposedInvestigation'] === undefined
      ? null
      : normalizeInvestigation(o['proposedInvestigation']);
  if (o['proposedInvestigation'] != null && proposedInvestigation === null) {
    return {
      ok: false,
      errors: [leafReadinessIssue('schema', 'proposedInvestigation invalid')],
    };
  }
  const base = {
    version: LEAF_READINESS_CRITIC_VERSION,
    kind: 'leaf_readiness' as const,
    mode: 'advisory' as const,
    verifiedWork: false as const,
    mutatesGraph: false as const,
    authorizesDispatch: false as const,
    nodeId: o['nodeId'] as string,
    graphId: o['graphId'] as string,
    graphDigest: o['graphDigest'] as string,
    verdict: o['verdict'] as LeafReadinessVerdict,
    checks,
    reasons,
    proposedInvestigation,
  };
  const expected = leafReadinessDecisionDigest(base);
  if (expected !== o['decisionDigest']) {
    return { ok: false, errors: [leafReadinessIssue('schema', 'decisionDigest mismatch')] };
  }
  return { ok: true, decision: { ...base, decisionDigest: expected } };
}
