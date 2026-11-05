/**
 * Domain — staging release verify hard timeouts + process-cleanup plan.
 *
 * Pure: no IO, git, fs, or network. Orchestrator/CDP layers apply the
 * decisions (Promise.race, process-group kill). Incident 2026-07-28: staging
 * verifying hung 10+ hours with zombie Chromium; only a daemon restart cleared
 * the stuck `verifying` status.
 */

import type { StagingStatus } from './release.js';

/** Pipeline stages that can own a timeout attribution. */
export const STAGING_VERIFY_STAGES = ['deploy', 'health', 'evidence'] as const;
export type StagingVerifyStage = (typeof STAGING_VERIFY_STAGES)[number];

/** Overall wall-clock budget for one staging deploy→health→evidence cycle. */
export const DEFAULT_STAGING_VERIFY_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Per-stage budgets (must not exceed overall). Evidence includes Chromium
 * CDP boot + multi-step drive; deploy is shell; health is poll loop.
 */
export const DEFAULT_STAGING_STAGE_TIMEOUT_MS: Readonly<
  Record<StagingVerifyStage, number>
> = {
  deploy: 10 * 60 * 1000,
  health: 2 * 60 * 1000,
  evidence: 10 * 60 * 1000,
};

export function isStagingBudgetExceeded(input: {
  readonly startedAtMs: number | null;
  readonly nowMs: number;
  readonly timeoutMs: number;
}): boolean {
  if (input.startedAtMs === null) return false;
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) return false;
  return input.nowMs - input.startedAtMs >= input.timeoutMs;
}

/** Human failure text for the Release packet / failureReason. */
export function formatStagingTimeoutFailureReason(input: {
  readonly stage: StagingVerifyStage | 'overall';
  readonly timeoutMs: number;
  readonly elapsedMs: number;
}): string {
  const elapsed = Math.max(0, Math.floor(input.elapsedMs));
  const limit = Math.max(0, Math.floor(input.timeoutMs));
  return `staging ${input.stage} timed out after ${elapsed}ms (limit ${limit}ms)`;
}

export type StuckStagingDecision =
  | { readonly action: 'continue' }
  | {
      readonly action: 'fail';
      readonly stage: StagingVerifyStage;
      readonly reason: string;
      readonly elapsedMs: number;
    };

/**
 * Disk-status stuck recovery: `deploying` / `verifying` past the overall
 * budget → fail with stage attribution. Used on each reconciler tick so a
 * hung verify (or crashed mid-flight status) cannot sit forever.
 *
 * Legacy records without `staging_started_at` (pre-upgrade stuck state) force-fail
 * when no live worker is in flight — otherwise they would remain forever.
 */
export function evaluateStuckStaging(input: {
  readonly stagingStatus: StagingStatus | null;
  readonly stagingStartedAtMs: number | null;
  readonly nowMs: number;
  readonly overallTimeoutMs: number;
  /** Reserved for callers that want different policy while live; timeout still applies. */
  readonly processInFlight?: boolean;
}): StuckStagingDecision {
  const status = input.stagingStatus;
  if (status !== 'deploying' && status !== 'verifying') {
    return { action: 'continue' };
  }
  const stage: StagingVerifyStage = status === 'deploying' ? 'deploy' : 'evidence';

  // Pre-upgrade / crashed mid-flight without a timestamp: only the live
  // pipeline stamps startedAt, so null + no in-flight worker is orphaned poison.
  if (input.stagingStartedAtMs === null) {
    if (input.processInFlight === true) {
      return { action: 'continue' };
    }
    return {
      action: 'fail',
      stage,
      elapsedMs: 0,
      reason: `staging ${status} stuck without staging_started_at (legacy; force-fail for recovery)`,
    };
  }

  const elapsedMs = Math.max(0, input.nowMs - input.stagingStartedAtMs);
  if (
    !isStagingBudgetExceeded({
      startedAtMs: input.stagingStartedAtMs,
      nowMs: input.nowMs,
      timeoutMs: input.overallTimeoutMs,
    })
  ) {
    return { action: 'continue' };
  }
  return {
    action: 'fail',
    stage,
    elapsedMs,
    reason: formatStagingTimeoutFailureReason({
      stage,
      timeoutMs: input.overallTimeoutMs,
      elapsedMs,
    }),
  };
}

/**
 * After `staging_status=failed`, allow another cycle once the quiet period
 * elapses (or deploy-now), even when tip sha matches (no drift). Without this
 * a failed tip never retried until main moved or the daemon restarted.
 */
export function shouldRetryFailedStaging(input: {
  readonly stagingStatus: StagingStatus | null;
  readonly hasDrift: boolean;
  readonly promotingSha: string | null;
  readonly deployNow: boolean;
  /** ms when failure was recorded or main last advanced (caller chooses). */
  readonly lastFailureOrAdvanceAtMs: number | null;
  readonly nowMs: number;
  readonly debounceMs: number;
  readonly inFlight: boolean;
}): boolean {
  if (input.stagingStatus !== 'failed') return false;
  if (input.promotingSha !== null && input.promotingSha !== '') return false;
  if (input.inFlight) return false;
  if (input.deployNow) return true;
  if (input.lastFailureOrAdvanceAtMs === null) return false;
  return input.nowMs - input.lastFailureOrAdvanceAtMs >= input.debounceMs;
}

// ── Process-group cleanup plan (pure; IO applies signals) ───────────────

export type CleanupSignal = 'TERM' | 'KILL';
export type CleanupNext = CleanupSignal | 'done';

/**
 * Escalation ladder for one process group: TERM → KILL → done.
 * Calling again after death or after KILL is always `done` (idempotent).
 */
export function nextProcessGroupCleanupSignal(input: {
  readonly alive: boolean;
  readonly termSent: boolean;
  readonly killSent: boolean;
}): CleanupNext {
  if (!input.alive) return 'done';
  if (!input.termSent) return 'TERM';
  if (!input.killSent) return 'KILL';
  return 'done';
}

export interface CleanupPlan {
  readonly actions: readonly { readonly pid: number; readonly signal: CleanupSignal }[];
  readonly skippedDead: readonly number[];
  readonly logLines: readonly string[];
}

/**
 * Pure multi-pid cleanup plan. Residual Chromium from a prior evidence run
 * should be TERM/KILL'd before a new launch; re-planning with updated
 * alreadyTermed/alreadyKilled sets is idempotent.
 */
export function planIdempotentCleanup(input: {
  readonly pids: readonly number[];
  readonly alive: ReadonlyMap<number, boolean>;
  readonly alreadyTermed: ReadonlySet<number>;
  readonly alreadyKilled: ReadonlySet<number>;
}): CleanupPlan {
  const actions: { pid: number; signal: CleanupSignal }[] = [];
  const skippedDead: number[] = [];
  const logLines: string[] = [];

  for (const pid of input.pids) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const isAlive = input.alive.get(pid) === true;
    const next = nextProcessGroupCleanupSignal({
      alive: isAlive,
      termSent: input.alreadyTermed.has(pid),
      killSent: input.alreadyKilled.has(pid),
    });
    if (next === 'done') {
      if (!isAlive) {
        skippedDead.push(pid);
        logLines.push(`cleanup pid=${pid}: already dead (noop)`);
      } else {
        logLines.push(`cleanup pid=${pid}: KILL already sent (noop)`);
      }
      continue;
    }
    actions.push({ pid, signal: next });
    logLines.push(`cleanup pid=${pid}: send SIG${next}`);
  }

  return { actions, skippedDead, logLines };
}

// ── Panel / UI helpers ──────────────────────────────────────────────────

export function stagingElapsedMs(input: {
  readonly stagingStartedAtMs: number | null;
  readonly nowMs: number;
}): number | null {
  if (input.stagingStartedAtMs === null) return null;
  return Math.max(0, input.nowMs - input.stagingStartedAtMs);
}

/** Verifying/deploying longer than the overall budget → show as abnormal in UI. */
export function isStagingVerifyAbnormal(input: {
  readonly stagingStatus: StagingStatus | null;
  readonly elapsedMs: number | null;
  readonly overallTimeoutMs: number;
}): boolean {
  if (input.stagingStatus !== 'verifying' && input.stagingStatus !== 'deploying') {
    return false;
  }
  if (input.elapsedMs === null) return false;
  return input.elapsedMs >= input.overallTimeoutMs;
}

/** Compact duration for phone pills (`45s`, `3m 12s`, `1h 05m`). */
export function formatStagingElapsedLabel(elapsedMs: number): string {
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}h ${String(m).padStart(2, '0')}m`;
  }
  if (m > 0) {
    return `${m}m ${String(s).padStart(2, '0')}s`;
  }
  return `${s}s`;
}

/** Map disk status → active stage for live race attribution. */
export function stageForStatus(status: StagingStatus | null): StagingVerifyStage | null {
  if (status === 'deploying') return 'deploy';
  if (status === 'verifying') return 'evidence';
  return null;
}

/**
 * Remaining ms in a budget (0 when already exceeded). Null startedAt → full budget.
 */
export function remainingBudgetMs(input: {
  readonly startedAtMs: number | null;
  readonly nowMs: number;
  readonly timeoutMs: number;
}): number {
  if (input.startedAtMs === null) return Math.max(0, input.timeoutMs);
  return Math.max(0, input.timeoutMs - (input.nowMs - input.startedAtMs));
}
