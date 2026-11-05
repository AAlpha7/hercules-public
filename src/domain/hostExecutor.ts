/**
 * Domain — deterministic host-operation / deploy executor contract.
 *
 * Approved host commands are executed by Hercules itself (not an LLM adapter).
 * Pure helpers: timeout bounds, argv split, output redaction, durable start
 * markers, receipt evidence, and live-run metadata shaping. No IO.
 */
import {
  formatHostOperationReceipt,
  isIsoTimestamp,
  validateHostCommandScope,
  type HostOperationOutcome,
  type HostOperationReceipt,
} from './executionClass.js';

/** Safe default: long deploys (~20m) must not false-timeout. */
export const DEFAULT_HOST_COMMAND_TIMEOUT_MS = 30 * 60_000;

/** Floor for explicit per-command timeout (1 minute). */
export const MIN_HOST_COMMAND_TIMEOUT_MS = 60_000;

/** Ceiling for explicit per-command timeout (4 hours). */
export const MAX_HOST_COMMAND_TIMEOUT_MS = 4 * 60 * 60_000;

/** Bounded stdout/stderr tails kept in receipts / activity. */
export const HOST_OUTPUT_TAIL_MAX = 4 * 1024;

/** Body audit heading when deterministic execution begins. */
export const HOST_EXECUTION_STARTED_HEADING = '## Host execution started';

/** Session id prefix for deterministic host runs (not an LLM session). */
export const HOST_EXECUTOR_SESSION_PREFIX = 'host-exec:';

/** How long identical mirror console lines are suppressed (ms). */
export const MIRROR_LOG_RATE_LIMIT_MS = 60_000;

/**
 * Bounded wait for HostExecutorRun.whenSettled() during human cancel /
 * force-abort / deadline teardown — must finish before workspace inspect/remove.
 */
export const HOST_CANCEL_SETTLE_BOUND_MS = 15_000;

export type HostCommandTerminalKind =
  | 'exit'
  | 'timeout'
  | 'cancel'
  | 'signal'
  | 'spawn_error';

export interface HostCommandResult {
  readonly command: string;
  readonly index: number;
  readonly kind: HostCommandTerminalKind;
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  readonly durationMs: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly ok: boolean;
}

export interface HostExecutionSummary {
  readonly commandScope: readonly string[];
  readonly results: readonly HostCommandResult[];
  readonly outcome: HostOperationOutcome;
  readonly stoppedAtIndex: number | null;
  readonly stopReason: string | null;
}

/** Public live-run overlay for a host execution (no env / full output). */
export interface HostRunLiveMeta {
  readonly taskId: string;
  /** 1-based current command index (0 before first spawn). */
  readonly commandIndex: number;
  readonly commandTotal: number;
  /** Bounded redacted command label (never env or secrets). */
  readonly commandName: string | null;
  readonly elapsedMs: number;
  readonly processAlive: boolean;
  readonly timeoutMs: number;
  readonly cancelRequested: boolean;
}

const SECRETISH =
  /(?:token|password|secret|api[_-]?key|authorization|bearer\s+\S+|HERCULES_[A-Z0-9_]*TOKEN|sk-[A-Za-z0-9_-]{8,}|xai-[A-Za-z0-9_-]{8,})/i;

/**
 * Validate / clamp a configured host-command timeout.
 * Non-finite / out of range → default.
 */
export function resolveHostCommandTimeoutMs(raw: unknown): number {
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    return DEFAULT_HOST_COMMAND_TIMEOUT_MS;
  }
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return DEFAULT_HOST_COMMAND_TIMEOUT_MS;
  const ms = Math.floor(n);
  if (ms < MIN_HOST_COMMAND_TIMEOUT_MS || ms > MAX_HOST_COMMAND_TIMEOUT_MS) {
    return DEFAULT_HOST_COMMAND_TIMEOUT_MS;
  }
  return ms;
}

/**
 * Split a validateHostCommandScope-approved literal into argv.
 * No shell — spaces only. Empty → error result from caller.
 */
export function splitHostCommandArgv(
  command: string,
): { readonly ok: true; readonly argv: readonly string[] } | { readonly ok: false; readonly reason: string } {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'command is blank' };
  }
  // Re-validate so executor never trusts a stale scope entry.
  const scope = validateHostCommandScope([trimmed]);
  if (!scope.ok) {
    return { ok: false, reason: scope.reason };
  }
  const argv = trimmed.split(/\s+/).filter((p) => p.length > 0);
  if (argv.length === 0) {
    return { ok: false, reason: 'command produced empty argv' };
  }
  return { ok: true, argv };
}

/** Bound + redact command/output text for receipts and activity. */
export function redactHostOutput(raw: string, max = HOST_OUTPUT_TAIL_MAX): string {
  let text = raw.replace(/\r\n/g, '\n');
  // Redact common secret shapes before truncating so tails stay useful.
  text = text.replace(
    /(?:Bearer\s+)\S+/gi,
    'Bearer [REDACTED]',
  );
  // Credential-bearing URIs: scheme://user:pass@host → scheme://[REDACTED]@host
  // Every unbounded character class before a required literal is capped:
  // `[...]*` followed by `://` or `[=:]` backtracks per start position and is
  // quadratic on one long line (256 KB of `x` took 317 s on the daemon loop,
  // Claude round 19); scheme / key names are short in practice.
  text = text.replace(
    /([a-z][a-z0-9+.-]{0,31}:\/\/)([^/\s@]{1,512}):([^/\s@]{1,512})@/gi,
    '$1[REDACTED]@',
  );
  // Generic secret-ish KEY=value / KEY: value (TOKEN, PASSWORD, API_KEY, DATABASE_URL, …).
  text = text.replace(
    /(?:(?:HERCULES_[A-Z0-9_]{0,64}TOKEN|[A-Z0-9_]{0,64}(?:API[_-]?KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL|DATABASE_URL|PRIVATE[_-]?KEY)[A-Z0-9_]{0,64})\s*[=:]\s*)\S+/gi,
    (m) => {
      const eq = m.includes('=') ? '=' : ':';
      const key = m.split(/[=:]/)[0] ?? 'SECRET';
      return `${key.trim()}${eq}[REDACTED]`;
    },
  );
  // Provider tokens use either hyphen (sk-…, xai-…) or underscore (ghp_…).
  text = text.replace(
    /\b(?:sk|xai|ghp|gho|ghu|ghs)[-_][A-Za-z0-9_-]{8,}\b/g,
    '[REDACTED]',
  );
  if (SECRETISH.test(text) && /(?:token|password|secret|authorization|api[_-]?key|database_url)/i.test(text)) {
    // Last-resort: blank lines that still look secret-bearing.
    text = text
      .split('\n')
      .map((line) => (SECRETISH.test(line) ? '[REDACTED LINE]' : line))
      .join('\n');
  }
  if (text.length <= max) return text;
  return `…[truncated ${text.length - max} chars]…\n${text.slice(-max)}`;
}

/** Short public label for a command (index + basename-ish, redacted). */
export function hostCommandPublicName(command: string, maxLen = 64): string {
  const cleaned = command.trim().replace(/\s+/g, ' ');
  if (cleaned.length === 0) return '(none)';
  if (SECRETISH.test(cleaned)) return 'redacted';
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1)}…`;
}

export function hasHostExecutionStartMarker(task: {
  readonly hostExecutionStartedAt?: string | null;
  readonly body?: string;
}): boolean {
  const at = task.hostExecutionStartedAt?.trim() ?? '';
  if (at.length > 0 && isIsoTimestamp(at)) return true;
  const body = task.body ?? '';
  return body.includes(HOST_EXECUTION_STARTED_HEADING);
}

/** Append durable body audit when execution is about to begin. */
export function stampHostExecutionStart(
  body: string,
  stamp: { readonly startedAt: string; readonly commandCount: number },
): string {
  const at = stamp.startedAt.trim();
  const n = Math.max(0, Math.floor(stamp.commandCount));
  const note =
    `\n\n${HOST_EXECUTION_STARTED_HEADING}\n\n` +
    `${at}: deterministic host executor began approved scope (${n} command${n === 1 ? '' : 's'}). ` +
    `Replay is blocked if this run is interrupted.\n`;
  return `${body.trimEnd()}${note}`;
}

export function buildHostExecutionSummary(
  commandScope: readonly string[],
  results: readonly HostCommandResult[],
): HostExecutionSummary {
  const failed = results.find((r) => !r.ok);
  if (results.length === 0) {
    return {
      commandScope,
      results,
      outcome: 'skipped',
      stoppedAtIndex: null,
      stopReason: 'no commands executed',
    };
  }
  if (failed) {
    const partial = results.some((r) => r.ok);
    return {
      commandScope,
      results,
      outcome: partial ? 'partial' : 'failed',
      stoppedAtIndex: failed.index,
      stopReason: describeHostCommandStop(failed),
    };
  }
  if (results.length < commandScope.length) {
    return {
      commandScope,
      results,
      outcome: 'partial',
      stoppedAtIndex: results.length,
      stopReason: 'scope incomplete',
    };
  }
  return {
    commandScope,
    results,
    outcome: 'success',
    stoppedAtIndex: null,
    stopReason: null,
  };
}

export function describeHostCommandStop(result: HostCommandResult): string {
  switch (result.kind) {
    case 'timeout':
      return `command ${result.index + 1} timed out after ${result.durationMs}ms`;
    case 'cancel':
      return `command ${result.index + 1} cancelled`;
    case 'signal':
      return `command ${result.index + 1} killed by ${result.exitSignal ?? 'signal'}`;
    case 'spawn_error':
      return `command ${result.index + 1} failed to launch`;
    case 'exit':
      return `command ${result.index + 1} exited ${result.exitCode ?? 'unknown'}`;
  }
}

/**
 * Build the canonical host-operation receipt from mechanical results.
 * Outcome is authoritative (success only when every approved command ok).
 */
export function receiptFromHostExecution(
  summary: HostExecutionSummary,
): HostOperationReceipt {
  const evidence = formatHostExecutionEvidence(summary);
  return {
    commandScope: [...summary.commandScope],
    outcome: summary.outcome,
    postCheckEvidence: evidence,
  };
}

export function formatHostExecutionEvidence(summary: HostExecutionSummary): string {
  if (summary.results.length === 0) {
    return summary.stopReason ?? 'no commands executed';
  }
  const lines = summary.results.map((r) => {
    const status = r.ok ? 'ok' : 'FAIL';
    const code =
      r.exitCode !== null
        ? `exit=${r.exitCode}`
        : r.exitSignal
          ? `signal=${r.exitSignal}`
          : `kind=${r.kind}`;
    const out = redactHostOutput(r.stdoutTail, 400).trim();
    const err = redactHostOutput(r.stderrTail, 400).trim();
    const tails = [
      out.length > 0 ? `stdout: ${out.replace(/\s+/g, ' ').slice(0, 200)}` : null,
      err.length > 0 ? `stderr: ${err.replace(/\s+/g, ' ').slice(0, 200)}` : null,
    ]
      .filter((x): x is string => x !== null)
      .join('; ');
    return (
      `[${r.index + 1}/${summary.commandScope.length}] \`${r.command}\` ${status} ` +
      `(${code}, ${r.durationMs}ms)${tails ? ` — ${tails}` : ''}`
    );
  });
  if (summary.stopReason && summary.outcome !== 'success') {
    lines.push(`stopped: ${summary.stopReason}`);
  }
  return lines.join(' | ');
}

/** Final agent-style message: narrative + receipt + self-assessment. */
export function formatHostExecutorFinalMessage(
  summary: HostExecutionSummary,
): string {
  const receipt = receiptFromHostExecution(summary);
  const receiptMd = formatHostOperationReceipt(receipt).trimEnd();
  const narrative =
    summary.outcome === 'success'
      ? `Deterministic host executor ran ${summary.results.length} approved command(s) successfully.`
      : `Deterministic host executor stopped: ${summary.stopReason ?? summary.outcome}.`;
  return [
    narrative,
    '',
    receiptMd,
    '',
    '## Self-assessment',
    '',
    `- Host commands: ${summary.outcome === 'success' ? 'executed once in order' : summary.outcome}`,
    `- Receipt outcome: ${receipt.outcome}`,
    '',
  ].join('\n');
}

export function toHostRunLiveMeta(input: {
  readonly taskId: string;
  readonly commandIndex: number;
  readonly commandTotal: number;
  readonly commandName: string | null;
  readonly startedAtMs: number;
  readonly nowMs: number;
  readonly processAlive: boolean;
  readonly timeoutMs: number;
  readonly cancelRequested: boolean;
}): HostRunLiveMeta {
  const total = Math.max(0, Math.floor(input.commandTotal));
  const idx = Math.max(0, Math.floor(input.commandIndex));
  return {
    taskId: input.taskId,
    commandIndex: idx,
    commandTotal: total,
    commandName:
      input.commandName === null ? null : hostCommandPublicName(input.commandName),
    elapsedMs: Math.max(0, input.nowMs - input.startedAtMs),
    processAlive: input.processAlive === true,
    timeoutMs: resolveHostCommandTimeoutMs(input.timeoutMs),
    cancelRequested: input.cancelRequested === true,
  };
}

/**
 * Rate-limit identical console log lines. Distinct keys always emit.
 * Returns true when the line should be printed.
 */
export function shouldEmitRateLimitedLog(
  state: Map<string, number>,
  key: string,
  nowMs: number,
  windowMs: number = MIRROR_LOG_RATE_LIMIT_MS,
): boolean {
  const k = key.trim();
  if (k.length === 0) return true;
  const prev = state.get(k);
  if (prev !== undefined && nowMs - prev < windowMs) {
    return false;
  }
  state.set(k, nowMs);
  // Bound map growth: drop oldest half when large.
  if (state.size > 256) {
    const entries = [...state.entries()].sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < Math.floor(entries.length / 2); i += 1) {
      state.delete(entries[i]![0]);
    }
  }
  return true;
}

/** Stable key for mirror skip/rewind console noise. */
export function mirrorLogRateKey(
  kind: string,
  branch: string,
  detail: string,
): string {
  return `${kind.trim()}|${branch.trim()}|${detail.trim().replace(/\s+/g, ' ')}`;
}
