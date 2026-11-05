/**
 * Domain — agent death diagnosis + transient error classification.
 *
 * Case study 2026-07-29: task agents died with bare `exit unknown` (no stderr
 * tail / cause), mid-stream xAI 502 burned the run with no same-round retry,
 * and human Retry kept a poisoned `agent_session` so thrash resumed the dead
 * session. Pure helpers shared by the task adapter path and ACP sessions.
 */
import { parseLatestRunFailure } from './runFailure.js';

/**
 * Transient agent-side failures worth one automatic same-round retry
 * (xAI 5xx / connection reset / stream interrupt). Matches the ACP path
 * patterns plus common mid-stream disconnect signals.
 *
 * Permanent / poison signals (resume rejected, auth, max turns) return false.
 */
export function isTransientAgentError(message: string): boolean {
  if (!message || message.trim().length === 0) return false;
  // Poison / permanent first — never soft-retry these even if another clause matches.
  if (
    /resume\s+(session\s+)?(reject|invalid|fail|not found|expired|unknown)/i.test(message) ||
    /session not found|authentication failed|max turns reached|permission denied/i.test(message)
  ) {
    return false;
  }
  return (
    /internal error|status\s*5\d\d|HTTP\/?\s*5\d\d|\b5(?:0[0-9]|[1-9][0-9])\b|ACP request timeout|overloaded|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|connection reset|stream (?:interrupted|closed|error)|mid-stream|network (?:error|unreachable)|temporarily unavailable|bad gateway|service unavailable|gateway timeout/i.test(
      message,
    )
  );
}

export interface AgentDeathInput {
  readonly stderrTail?: string;
  readonly activityTail?: readonly string[];
  readonly finalMessage?: string;
  readonly exitCode?: number | null;
  readonly exitSignal?: string | null;
}

/** Concatenate death evidence for classification / packet detail. */
export function deathEvidenceBlob(input: AgentDeathInput): string {
  return [
    input.stderrTail ?? '',
    ...(input.activityTail ?? []),
    input.finalMessage ?? '',
  ]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('\n');
}

/** True when the agent died because the coding CLI/provider is not authenticated. */
export function isAdapterAuthInfraDeath(input: AgentDeathInput | string): boolean {
  const blob = typeof input === 'string' ? input : deathEvidenceBlob(input);
  return /not signed in|adapter not signed in|grok login|device-code|login --device|XAI_API_KEY|authentication required|please (?:log|sign)\s*in/i.test(
    blob,
  );
}

/**
 * One-line cause for timeline / mini-packet (not bare `exit unknown`).
 * Prefer high-signal stderr/activity patterns over raw exit codes.
 */
export function summarizeAgentDeath(input: AgentDeathInput): string {
  const blob = deathEvidenceBlob(input);

  if (/resume\s+(session\s+)?(reject|invalid|fail)|session not found|unknown session|session expired/i.test(blob)) {
    return 'resume session rejected';
  }

  // Local CLI auth gaps — infrastructure, not product defects (Guardian dogfood 2026-08).
  if (isAdapterAuthInfraDeath(blob)) {
    return 'adapter not signed in';
  }

  const statusM = blob.match(/status\s*(5\d\d)/i) ?? blob.match(/\b(5\d\d)\s*(?:Bad Gateway|Service Unavailable|Gateway Timeout)?/i);
  if (statusM) {
    const code = statusM[1]!;
    const mid = /mid-stream|stream|while streaming|streaming/i.test(blob);
    if (code === '502' || /bad gateway/i.test(blob)) {
      return mid ? 'xAI 502 mid-stream' : 'xAI 502';
    }
    if (code === '503' || /service unavailable|overloaded/i.test(blob)) {
      return mid ? `provider 503 mid-stream` : 'provider 503';
    }
    if (code === '504' || /gateway timeout/i.test(blob)) {
      return 'provider 504 timeout';
    }
    return mid ? `HTTP ${code} mid-stream` : `HTTP ${code}`;
  }

  if (/ECONNRESET|connection reset/i.test(blob)) return 'connection reset';
  if (/socket hang up/i.test(blob)) return 'socket hang up';
  if (/ETIMEDOUT|timed?\s*out|request timeout|ACP request timeout/i.test(blob)) {
    return 'timeout';
  }
  if (/overloaded|capacity/i.test(blob)) return 'provider overloaded';
  if (/internal error/i.test(blob)) return 'internal error';
  if (/stream (?:interrupted|closed|error)|mid-stream/i.test(blob)) {
    return 'stream interrupted';
  }

  // First high-signal activity / stderr line (error/crash/fail).
  for (const line of blob.split('\n')) {
    const t = line.trim().replace(/\s+/g, ' ');
    if (t.length === 0) continue;
    if (/error|crash|fail|fatal|exception/i.test(t)) {
      return t.length > 120 ? `${t.slice(0, 117)}…` : t;
    }
  }

  if (input.exitSignal && input.exitSignal.trim().length > 0) {
    return `killed by ${input.exitSignal.trim()}`;
  }
  if (input.exitCode !== undefined && input.exitCode !== null) {
    if (input.exitCode === 0) return 'exit 0 without done event';
    // C3.59: a shell reports a signal death as 128 + N. Reporting the raw
    // number reads like an application error and sent the operator at env /
    // quota / WORKFLOW (a downstream project task 47: two SIGILL crashes of the grok
    // binary, note said only "exit 132"). Name the signal instead.
    const signal = agentDeathSignalName(input.exitCode);
    return signal === null
      ? `exit ${input.exitCode}`
      : `killed by ${signal} (exit ${input.exitCode}) — adapter process crashed`;
  }
  // Never surface the useless bare phrase alone.
  return 'agent exited without done event';
}

/**
 * C3.59: POSIX signal name for a shell's 128 + N exit code, or null when the
 * code is an ordinary application status. Only the signals a crashing or
 * killed agent actually produces are named.
 */
export function agentDeathSignalName(exitCode: number): string | null {
  if (!Number.isSafeInteger(exitCode) || exitCode <= 128 || exitCode > 128 + 64) return null;
  const names: Record<number, string> = {
    1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 4: 'SIGILL', 6: 'SIGABRT', 7: 'SIGBUS',
    8: 'SIGFPE', 9: 'SIGKILL', 11: 'SIGSEGV', 13: 'SIGPIPE', 15: 'SIGTERM',
    24: 'SIGXCPU', 25: 'SIGXFSZ', 31: 'SIGSYS',
  };
  return names[exitCode - 128] ?? `signal ${exitCode - 128}`;
}

/** Human Retry after agent_exit should drop a poisoned adapter session. */
export function shouldAbandonSessionOnRetry(input: {
  readonly agentSession: string | null | undefined;
  readonly body: string;
}): boolean {
  const sess = input.agentSession?.trim() ?? '';
  if (sess.length === 0) return false;
  return parseLatestRunFailure(input.body).kind === 'agent_exit';
}

/** Packet / body note when Retry clears agent_session after agent_exit. */
export function formatAbandonSessionNote(
  priorSessionId: string,
  stamp: string = 'now',
): string {
  void priorSessionId;
  return [
    `## Session abandoned (${stamp})`,
    '',
    '**已放弃损坏会话** (abandoned corrupted session) after `agent_exit`.',
    'Prior provider session quarantined; next dispatch is fresh (no `--resume`).',
    '',
  ].join('\n');
}
