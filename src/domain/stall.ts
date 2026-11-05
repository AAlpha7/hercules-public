/**
 * Domain — stall / hard-kill policy for agent runs (SPEC §7.3).
 *
 * Pure. Classifies activity sources so long silent tools (cargo, pnpm test)
 * are not mistaken for a dead agent, without disabling stall entirely on the
 * free-tier arm64 box.
 *
 * ## Activity sources
 *
 * 1. **Adapter stream events** — NDJSON / ACP / tool lines update `lastEventAt`.
 * 2. **Process liveness** — agent child still running (`processAlive`), optionally
 *    confirmed by OS probe / worker children under the agent tree.
 * 3. **Wall-clock run age** — hard `maxRunMs` always bounds deadlocks.
 *
 * ## Policy
 *
 * - Hard max always wins (force kill).
 * - Idle stream stall only when process is **not** known-alive.
 * - Prefer **not** marking `stall` while the agent process is alive (silent
 *   cargo/pnpm is normal). Stall is never fully off: `maxRunMs` is the backstop.
 */

/** Default idle-stream timeout: 10 minutes (SPEC implementer default). */
export const DEFAULT_STALL_TIMEOUT_MS = 10 * 60_000;

/**
 * Hard wall-clock cap for one agent run. Long cargo/pnpm gates on A1 can exceed
 * 10m with zero stream events; 2h still bounds true deadlocks.
 */
export const DEFAULT_MAX_RUN_MS = 2 * 60 * 60_000;

export type StallAction = 'continue' | 'idle_stall' | 'hard_max_run';

export interface StallInput {
  readonly nowMs: number;
  /** ms since epoch of last adapter stream event. */
  readonly lastEventAt: number;
  /** ms since epoch when this dispatch started. */
  readonly startedAtMs: number;
  /**
   * True when the agent process is still live (and/or has active worker
   * children). Real adapters set this while the child has not exited.
   */
  readonly processAlive: boolean;
  readonly stallTimeoutMs: number;
  readonly maxRunMs: number;
}

export interface StallDecision {
  readonly action: StallAction;
  readonly silenceMs: number;
  readonly runMs: number;
  /** Human-readable reason for activity log / failure mini-packet. */
  readonly reason: string;
}

/**
 * Decide whether a running agent should continue, idle-stall, or hard-kill.
 * Caller only invokes this while `status === 'running'`.
 */
export function evaluateStall(input: StallInput): StallDecision {
  const silenceMs = Math.max(0, input.nowMs - input.lastEventAt);
  const runMs = Math.max(0, input.nowMs - input.startedAtMs);

  // Hard wall-clock always wins (deadlocked child that never exits).
  if (runMs > input.maxRunMs) {
    return {
      action: 'hard_max_run',
      silenceMs,
      runMs,
      reason: `hard max run ${input.maxRunMs}ms exceeded`,
    };
  }

  // Idle stream stall only when process is not known-alive — long cargo /
  // pnpm / browser tools emit no stream events but processAlive=true.
  if (silenceMs > input.stallTimeoutMs && !input.processAlive) {
    return {
      action: 'idle_stall',
      silenceMs,
      runMs,
      reason: `stream idle > ${input.stallTimeoutMs}ms (process not reporting alive)`,
    };
  }

  const reason =
    input.processAlive && silenceMs > input.stallTimeoutMs
      ? 'stream silent but process alive (long tool)'
      : 'within limits';
  return { action: 'continue', silenceMs, runMs, reason };
}

/**
 * Merge adapter flag + optional OS process probe into a single processAlive bit.
 *
 * - OS dead overrides adapter alive (missed exit / zombie bookkeeping).
 * - OS alive can establish liveness when the adapter forgot the flag.
 * - `hasActiveChildren` alone is never enough (stale tree samples).
 */
export function resolveProcessAlive(input: {
  readonly processAlive?: boolean;
  readonly osAlive?: boolean | null;
  readonly hasActiveChildren?: boolean;
}): boolean {
  if (input.osAlive === false) return false;
  if (input.processAlive === true) return true;
  if (input.osAlive === true) return true;
  return false;
}

/**
 * Parse a positive millisecond env override. Invalid / missing → fallback.
 * Used for `HERCULES_STALL_TIMEOUT_MS` and `HERCULES_MAX_RUN_MS`.
 */
export function parsePositiveMsEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === '') return fallback;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}
