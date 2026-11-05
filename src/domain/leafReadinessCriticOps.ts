/** Serialize / format leaf-readiness decisions. */
import {
  LEAF_READINESS_BLOCK_END,
  LEAF_READINESS_BLOCK_START,
  LEAF_READINESS_DECISION_HEADING,
  sortLeafKeysDeep,
  type LeafReadinessDecision,
} from './leafReadinessCritic.js';

export function serializeLeafReadinessDecision(decision: LeafReadinessDecision): string {
  const body = {
    version: decision.version,
    kind: decision.kind,
    mode: decision.mode,
    verifiedWork: false as const,
    mutatesGraph: false as const,
    authorizesDispatch: false as const,
    nodeId: decision.nodeId,
    graphId: decision.graphId,
    graphDigest: decision.graphDigest,
    verdict: decision.verdict,
    checks: decision.checks,
    reasons: decision.reasons,
    proposedInvestigation: decision.proposedInvestigation,
    decisionDigest: decision.decisionDigest,
  };
  return JSON.stringify(sortLeafKeysDeep(body)) + '\n';
}

export function formatLeafReadinessDecisionMarkdown(decision: LeafReadinessDecision): string {
  const dd = decision.decisionDigest.slice(0, 12);
  const gd = decision.graphDigest.slice(0, 12);
  const lines: string[] = [
    LEAF_READINESS_DECISION_HEADING,
    '',
    LEAF_READINESS_BLOCK_START,
    serializeLeafReadinessDecision(decision).trimEnd(),
    LEAF_READINESS_BLOCK_END,
    '',
    '**Mode:** `advisory` — this is a leaf-readiness critique, not verified work.',
    'It does not create, dispatch, or mutate tasks or the accepted graph.',
    '',
    '- **Node:** `' + decision.nodeId + '`',
    '- **Graph id:** `' + decision.graphId + '`',
    '- **Graph digest:** `' + gd + '…`',
    '- **Decision digest:** `' + dd + '…`',
    '- **Verdict:** `' + decision.verdict + '`',
    '- **Verified work:** `false`',
    '- **Mutates graph:** `false`',
    '- **Authorizes dispatch:** `false`',
    '',
    '### Checks',
    '',
  ];
  for (const c of decision.checks) {
    lines.push('- `' + c.code + '` ' + (c.ok ? 'ok' : 'FAIL') + ' — ' + c.detail);
  }
  lines.push('', '### Reasons', '');
  if (decision.reasons.length === 0) lines.push('_No blockers._');
  else {
    for (const r of decision.reasons) lines.push('- `' + r.code + '`: ' + r.detail);
  }
  lines.push('', '### Proposed investigation', '');
  if (!decision.proposedInvestigation) {
    lines.push('_None — node is leaf-ready (advisory only)._');
  } else {
    const inv = decision.proposedInvestigation;
    lines.push('- **Id:** `' + inv.id + '` (not inserted into accepted graph)');
    lines.push('- **Title:** ' + inv.title);
    lines.push('- **Goal:** ' + inv.goal);
    lines.push('- **Scope:** ' + inv.scope);
    lines.push('- **Unknown to resolve:** ' + inv.unknownToResolve);
    lines.push('- **Related node:** `' + inv.relatedNodeId + '`');
  }
  lines.push('', '_End of advisory leaf-readiness decision. Does not dispatch or mutate._', '');
  return lines.join('\n');
}

export { parseLeafReadinessDecision } from './leafReadinessCriticParse.js';
