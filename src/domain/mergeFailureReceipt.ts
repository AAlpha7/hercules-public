/**
 * Domain — durable diagnostic receipt when post-merge L1 gates fail.
 *
 * Pure: no IO. Build / format / parse / redact only. Persistence and
 * merge orchestration live in isolation/ and orchestrator/.
 *
 * Contract: verification may have succeeded (verified_sha present) while
 * the subsequent merge-gate run fails. The receipt must stay bounded,
 * secret-redacted, restart-parseable, and must state that the remote
 * default branch was not pushed.
 */
import { redactHostOutput } from './hostExecutor.js';
import { neutralizeUntrustedPacketText } from './packetNeutralize.js';

export const MERGE_FAILURE_RECEIPT_VERSION = 1 as const;
export const MERGE_FAILURE_RECEIPT_HEADING = '## Merge failure diagnostic';
export const MERGE_FAILURE_RECEIPT_BLOCK_START = '<!-- hercules-merge-failure:v1';
export const MERGE_FAILURE_RECEIPT_BLOCK_END = '-->';

/** Bounded failure summary (actionable last lines). */
export const MERGE_FAILURE_SUMMARY_MAX = 800;
/** Bounded raw excerpt retained in receipt / API / UI. */
export const MERGE_FAILURE_RAW_MAX = 2_000;

export type MergeGateOperationStatus = 'merge_gate_failed';

export interface MergeFailureTruncation {
  readonly truncated: boolean;
  readonly originalChars: number;
  readonly retainedChars: number;
}

/**
 * Durable merge-gate failure receipt. All text fields are already
 * redacted and size-bounded when produced by {@link buildMergeGateFailureReceipt}.
 */
export interface MergeFailureReceipt {
  readonly version: typeof MERGE_FAILURE_RECEIPT_VERSION;
  readonly kind: 'merge_gate_failure';
  readonly operationStatus: MergeGateOperationStatus;
  readonly operationId: string;
  readonly createdAt: string;
  readonly repoKey: string;
  readonly taskIds: readonly string[];
  readonly failedGate: string;
  readonly exitStatus: number | null;
  readonly failureSummary: string;
  readonly rawExcerpt: string;
  readonly truncation: MergeFailureTruncation;
  /** Always false for pre-push gate failure. */
  readonly remoteDefaultBranchChanged: false;
  /** Pre-merge verification succeeded; only the merge gate failed. */
  readonly verificationSucceeded: true;
  /** Safe remediation path — no secrets, paths, or full commands. */
  readonly nextAction: string;
}

export interface BuildMergeGateFailureReceiptInput {
  readonly operationId: string;
  readonly createdAt: string;
  readonly repoKey: string;
  readonly taskIds: readonly string[];
  readonly failedGate: string;
  readonly exitStatus: number | null;
  readonly rawOutput: string;
}

/** Public API/UI surface — same bounds; never expands raw logs. */
export type PublicMergeFailureReceipt = MergeFailureReceipt;

const FAILURE_LINE =
  /\b(FAIL|FAILED|ERROR|Error|AssertionError|expected|not ok|✗|×|ELIFECYCLE|ERR!)\b/i;

/**
 * Redact secrets in gate stdout/stderr for receipts, task bodies, API, UI.
 * Reuses host-output redaction (Bearer, KEY=value, token prefixes, URIs).
 */
export function redactMergeDiagnosticText(raw: string, max = MERGE_FAILURE_RAW_MAX * 4): string {
  return redactHostOutput(raw, max);
}

export function boundMergeDiagnosticExcerpt(
  raw: string,
  max = MERGE_FAILURE_RAW_MAX,
): { readonly text: string; readonly truncated: boolean; readonly originalChars: number; readonly retainedChars: number } {
  const redacted = redactMergeDiagnosticText(raw, Math.max(max * 4, max));
  // Strip host-output's own truncation prefix so we control the marker.
  const cleaned = redacted.replace(/^…\[truncated \d+ chars]…\n/, '');
  const originalChars = cleaned.length;
  if (cleaned.length <= max) {
    return {
      text: cleaned,
      truncated: false,
      originalChars,
      retainedChars: cleaned.length,
    };
  }
  const tail = cleaned.slice(-max);
  const text = `…[truncated ${originalChars - max} of ${originalChars} chars; retaining final ${max}]…\n${tail}`;
  return {
    text,
    truncated: true,
    originalChars,
    retainedChars: max,
  };
}

/**
 * Prefer final failure-bearing lines over leading compile noise.
 * Always redacted + bounded.
 */
export function extractMergeFailureSummary(
  raw: string,
  max = MERGE_FAILURE_SUMMARY_MAX,
): string {
  const redacted = redactMergeDiagnosticText(raw, Math.max(max * 8, 8_000));
  const cleaned = redacted.replace(/^…\[truncated \d+ chars]…\n/, '');
  const lines = cleaned.split('\n').map((l) => l.trimEnd());
  const meaningful = lines.filter((l) => l.trim().length > 0);
  if (meaningful.length === 0) return 'gate failed (no output)';

  let start = Math.max(0, meaningful.length - 16);
  for (let i = meaningful.length - 1; i >= 0; i -= 1) {
    if (FAILURE_LINE.test(meaningful[i] ?? '')) {
      start = Math.max(0, i - 2);
      break;
    }
  }
  let summary = meaningful.slice(start).join('\n');
  if (summary.length > max) {
    summary = `…[summary truncated]…\n${summary.slice(-max)}`;
  }
  return summary;
}

const DEFAULT_NEXT_ACTION =
  'Verification succeeded earlier; post-merge gates failed and the default branch was not updated. ' +
  'Inspect the failure summary, fix on the feature branch, re-verify, then run Merge Selected again.';

export function buildMergeGateFailureReceipt(
  input: BuildMergeGateFailureReceiptInput,
): MergeFailureReceipt {
  const bound = boundMergeDiagnosticExcerpt(input.rawOutput, MERGE_FAILURE_RAW_MAX);
  const failureSummary = extractMergeFailureSummary(input.rawOutput, MERGE_FAILURE_SUMMARY_MAX);
  const gate = input.failedGate.trim() || 'unknown';
  return {
    version: MERGE_FAILURE_RECEIPT_VERSION,
    kind: 'merge_gate_failure',
    operationStatus: 'merge_gate_failed',
    operationId: input.operationId.trim(),
    createdAt: input.createdAt.trim(),
    repoKey: input.repoKey.trim(),
    taskIds: input.taskIds.map((id) => id.trim()).filter((id) => id.length > 0),
    failedGate: gate,
    exitStatus: input.exitStatus,
    failureSummary,
    rawExcerpt: bound.text,
    truncation: {
      truncated: bound.truncated,
      originalChars: bound.originalChars,
      retainedChars: bound.retainedChars,
    },
    remoteDefaultBranchChanged: false,
    verificationSucceeded: true,
    nextAction: DEFAULT_NEXT_ACTION,
  };
}

/** Markdown section for task body (durable audit; phone-parseable). */
export function formatMergeFailureReceiptMarkdown(receipt: MergeFailureReceipt): string {
  const exit =
    receipt.exitStatus === null || receipt.exitStatus === undefined
      ? 'unknown'
      : String(receipt.exitStatus);
  const trunc = receipt.truncation.truncated
    ? `truncated from ${receipt.truncation.originalChars} to ${receipt.truncation.retainedChars} chars`
    : 'none';
  const lines: string[] = [
    MERGE_FAILURE_RECEIPT_HEADING,
    '',
    `${MERGE_FAILURE_RECEIPT_BLOCK_START}`,
    JSON.stringify(receipt),
    MERGE_FAILURE_RECEIPT_BLOCK_END,
    '',
    `**Operation status:** \`merge_gate_failed\``,
    `**Operation id:** \`${receipt.operationId}\``,
    `**Repo:** \`${receipt.repoKey}\``,
    `**Tasks:** ${receipt.taskIds.map((id) => `\`${id}\``).join(', ')}`,
    `**Failed gate:** \`${receipt.failedGate}\``,
    `**Exit status:** \`${exit}\``,
    `**Remote default branch changed:** \`no\``,
    '**Verification:** succeeded (pre-merge); merge gates failed after local merge — not a verification failure',
    `**Truncation:** ${trunc}`,
    '',
    '### Failure summary',
    '',
    '```',
    neutralizeUntrustedPacketText(receipt.failureSummary),
    '```',
    '',
    '### Raw excerpt',
    '',
    '```',
    neutralizeUntrustedPacketText(receipt.rawExcerpt),
    '```',
    '',
    '### Next action',
    '',
    neutralizeUntrustedPacketText(receipt.nextAction),
    '',
  ];
  return lines.join('\n');
}

/** Runtime type guard for durable / wire receipts. */
export function isMergeFailureReceipt(v: unknown): v is MergeFailureReceipt {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r['version'] !== 1) return false;
  if (r['kind'] !== 'merge_gate_failure') return false;
  if (r['operationStatus'] !== 'merge_gate_failed') return false;
  if (typeof r['operationId'] !== 'string') return false;
  if (typeof r['createdAt'] !== 'string') return false;
  if (typeof r['repoKey'] !== 'string') return false;
  if (!Array.isArray(r['taskIds'])) return false;
  if (typeof r['failedGate'] !== 'string') return false;
  if (!(typeof r['exitStatus'] === 'number' || r['exitStatus'] === null)) return false;
  if (typeof r['failureSummary'] !== 'string') return false;
  if (typeof r['rawExcerpt'] !== 'string') return false;
  if (r['remoteDefaultBranchChanged'] !== false) return false;
  if (r['verificationSucceeded'] !== true) return false;
  if (typeof r['nextAction'] !== 'string') return false;
  const trunc = r['truncation'];
  if (trunc === null || typeof trunc !== 'object') return false;
  const t = trunc as Record<string, unknown>;
  if (typeof t['truncated'] !== 'boolean') return false;
  if (typeof t['originalChars'] !== 'number') return false;
  if (typeof t['retainedChars'] !== 'number') return false;
  return true;
}

/**
 * Parse the latest structured merge-failure diagnostic from a task body.
 * Prefers the JSON block; falls back to markdown fields when present.
 */
export function parseMergeFailureReceipt(body: string): MergeFailureReceipt | null {
  if (!body.includes(MERGE_FAILURE_RECEIPT_HEADING) && !body.includes(MERGE_FAILURE_RECEIPT_BLOCK_START)) {
    return null;
  }
  // Prefer last JSON block (multiple failures append chronologically).
  const startMark = MERGE_FAILURE_RECEIPT_BLOCK_START;
  const endMark = MERGE_FAILURE_RECEIPT_BLOCK_END;
  let searchFrom = 0;
  let lastJson: string | null = null;
  while (searchFrom < body.length) {
    const s = body.indexOf(startMark, searchFrom);
    if (s < 0) break;
    const jsonStart = s + startMark.length;
    // Skip optional newline after start marker
    const after = body.slice(jsonStart);
    const nl = after.startsWith('\n') ? 1 : after.startsWith('\r\n') ? 2 : 0;
    const e = body.indexOf(endMark, jsonStart + nl);
    if (e < 0) break;
    lastJson = body.slice(jsonStart + nl, e).trim();
    searchFrom = e + endMark.length;
  }
  if (lastJson) {
    try {
      const parsed: unknown = JSON.parse(lastJson);
      if (isMergeFailureReceipt(parsed)) return parsed;
    } catch {
      // fall through to markdown parse
    }
  }

  // Markdown field fallback (still structured; not the legacy free-text section).
  const idx = body.lastIndexOf(MERGE_FAILURE_RECEIPT_HEADING);
  if (idx < 0) return null;
  const slice = body.slice(idx);
  const gate = /\*\*Failed gate:\*\*\s*`([^`]+)`/i.exec(slice)?.[1]?.trim();
  if (!gate) return null;
  const exitRaw = /\*\*Exit status:\*\*\s*`([^`]+)`/i.exec(slice)?.[1]?.trim();
  const exitStatus =
    exitRaw === undefined || exitRaw === 'unknown'
      ? null
      : Number.parseInt(exitRaw, 10);
  const operationId =
    /\*\*Operation id:\*\*\s*`([^`]+)`/i.exec(slice)?.[1]?.trim() ?? 'unknown';
  const repoKey = /\*\*Repo:\*\*\s*`([^`]+)`/i.exec(slice)?.[1]?.trim() ?? 'unknown';
  const summaryBlock = /### Failure summary[\s\S]*?```([\s\S]*?)```/i.exec(slice)?.[1]?.trim();
  const rawBlock = /### Raw excerpt[\s\S]*?```([\s\S]*?)```/i.exec(slice)?.[1]?.trim();
  const next =
    /### Next action\s*([\s\S]*?)(?=\n##\s|$)/i.exec(slice)?.[1]?.trim() ?? DEFAULT_NEXT_ACTION;
  const createdAt =
    /\*\*Created:\*\*\s*`([^`]+)`/i.exec(slice)?.[1]?.trim() ?? new Date(0).toISOString();
  return {
    version: MERGE_FAILURE_RECEIPT_VERSION,
    kind: 'merge_gate_failure',
    operationStatus: 'merge_gate_failed',
    operationId,
    createdAt,
    repoKey,
    taskIds: [],
    failedGate: gate,
    exitStatus: Number.isFinite(exitStatus) ? (exitStatus as number) : null,
    failureSummary: summaryBlock ?? 'gate failed',
    rawExcerpt: rawBlock ?? '',
    truncation: {
      truncated: /truncated/i.test(slice),
      originalChars: (rawBlock ?? '').length,
      retainedChars: (rawBlock ?? '').length,
    },
    remoteDefaultBranchChanged: false,
    verificationSucceeded: true,
    nextAction: next,
  };
}

/** Identity public projection — receipt is already bounded + redacted. */
export function publicMergeFailureReceipt(
  receipt: MergeFailureReceipt,
): PublicMergeFailureReceipt {
  return receipt;
}

export function bodyHasMergeGateFailure(body: string): boolean {
  return body.includes(MERGE_FAILURE_RECEIPT_HEADING)
    || body.includes(MERGE_FAILURE_RECEIPT_BLOCK_START)
    || body.includes('merge_gate_failed');
}
