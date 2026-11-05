/**
 * Domain — failure-kind aware retry policy.
 *
 * Case study: orbit onboarding burned maxAttempts=3 across mixed
 * provision / stall / agent_exit with weak differentiation. Salvage-friendly
 * onboard needs kind-specific attempt accounting without infinite loops.
 *
 * Pure. Policy table + decision function; orchestrator persists kind +
 * next-eligible in the task body / packet.
 *
 * Note: backoff math is inlined (same curve as {@link backoffDelayMs} in
 * scheduling) so this module does not import scheduling — scheduling may
 * import `parseNextEligibleMs` without a cycle.
 */

/** Normalized failure kinds (single chokepoint for run + verify paths). */
export const FAILURE_KINDS = [
  'provision',
  'stall',
  'agent_exit',
  'verify_l1',
  'verify_l2',
  'verify_l3',
  'verify_infra',
  'base_drift',
] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

/** Crash / pre-verify subset (Run failure mini-packet kinds). */
export type RunFailureKind = Extract<FailureKind, 'provision' | 'stall' | 'agent_exit'>;

export function isFailureKind(raw: string): raw is FailureKind {
  return (FAILURE_KINDS as readonly string[]).includes(raw);
}

export function isRunFailureKind(raw: string): raw is RunFailureKind {
  return raw === 'provision' || raw === 'stall' || raw === 'agent_exit';
}

export function normalizeFailureKind(raw: string): FailureKind | null {
  const k = raw.trim();
  return isFailureKind(k) ? k : null;
}

/**
 * Soft budget beyond maxAttempts for non-burning retries (e.g. stall soft).
 * Global ceiling = maxAttempts + RETRY_SOFT_BUDGET — human-visible, no infinite loop.
 */
export const RETRY_SOFT_BUDGET = 2;

export function globalFailureCeiling(maxAttempts: number): number {
  return Math.max(1, maxAttempts) + RETRY_SOFT_BUDGET;
}

/**
 * Permanent infra signals — park immediately; do not hide behind auto-retry.
 * Matched against provision / verify_infra detail text.
 */
const HARD_INFRA_RE =
  /\b(ENOSPC|no space left|EACCES|EPERM|permission denied|EROFS|read-?only file system|disk quota|out of memory|Cannot allocate memory|ENOMEM|authentication failed|could not read Username|Host key verification failed|Permission denied \(publickey\)|fatal:\s*could not read)\b/i;

export function isHardInfraError(message: string): boolean {
  return HARD_INFRA_RE.test(message);
}

/**
 * Adapter CLI/provider authentication gaps (not product defects).
 * Matched against agent_exit death detail / activity.
 */
const ADAPTER_AUTH_INFRA_RE =
  /not signed in|adapter not signed in|grok login|device-code|login --device|XAI_API_KEY|authentication required|please (?:log|sign)\s*in/i;

export function isAdapterAuthInfraDetail(message: string): boolean {
  return ADAPTER_AUTH_INFRA_RE.test(message);
}

export type BurnMode = 'always' | 'after_soft';

export interface KindPolicyRow {
  /** When to increment task.attempts. */
  readonly burnMode: BurnMode;
  /**
   * Same-kind soft retries allowed without burning (only for after_soft).
   * Streak is 1-based including the current failure.
   */
  readonly softLimit: number;
  /**
   * Park after this many consecutive same-kind failures (inclusive).
   * 0 = thrash brake disabled for this kind.
   */
  readonly thrashLimit: number;
  /** Multiplier on exponential backoff base (0 = immediate). */
  readonly backoffMultiplier: number;
  /** One-line policy summary for packets. */
  readonly summary: string;
}

/**
 * Default policy table.
 *
 * - provision: burn + short backoff; thrash@2; hard infra → immediate fail
 * - stall: soft (no burn) up to softLimit, then burn; quick resume; no thrash park
 * - agent_exit: standard burn + backoff; thrash@2
 * - verify_*: burn (existing rework); L3 slightly faster backoff
 * - verify_infra: burn + thrash@2 like provision
 */
export const DEFAULT_KIND_POLICY: Readonly<Record<FailureKind, KindPolicyRow>> = {
  provision: {
    burnMode: 'always',
    softLimit: 0,
    thrashLimit: 2,
    backoffMultiplier: 0.5,
    summary: 'limited auto-retry after cleanup; hard infra surfaces fast',
  },
  stall: {
    burnMode: 'after_soft',
    softLimit: 2,
    thrashLimit: 0,
    backoffMultiplier: 0.25,
    summary: 'soft resume on same worktree without full attempt burn',
  },
  agent_exit: {
    burnMode: 'always',
    softLimit: 0,
    thrashLimit: 2,
    backoffMultiplier: 1,
    summary: 'standard attempt burn + exponential backoff',
  },
  verify_l1: {
    burnMode: 'always',
    softLimit: 0,
    thrashLimit: 0,
    backoffMultiplier: 1,
    summary: 'L1/mechanical rework path — burn attempt',
  },
  verify_l2: {
    burnMode: 'always',
    softLimit: 0,
    thrashLimit: 0,
    backoffMultiplier: 1,
    summary: 'L2/behavioral rework path — burn attempt',
  },
  verify_l3: {
    burnMode: 'always',
    softLimit: 0,
    thrashLimit: 0,
    backoffMultiplier: 0.5,
    summary: 'L3/reviewer rework path — burn attempt, faster backoff',
  },
  verify_infra: {
    burnMode: 'always',
    softLimit: 0,
    thrashLimit: 2,
    backoffMultiplier: 0.5,
    summary: 'verification runner crash — limited retry, thrash park',
  },
  // Branch lags/conflicts with default after concurrent main moves. Soft so
  // product attempt budget is not burned by rebase thrash (task-9 2026-08-08).
  base_drift: {
    burnMode: 'after_soft',
    softLimit: 2,
    thrashLimit: 0,
    backoffMultiplier: 0.25,
    summary: 'base-drift / rebase conflict — soft retry without product burn',
  },
};

export type ParkedReason = 'max_attempts' | 'thrash' | 'hard_infra' | 'global_ceiling';

export interface RetryDecision {
  readonly kind: FailureKind;
  readonly outcome: 'retry' | 'fail';
  readonly burnedAttempt: boolean;
  readonly attemptsAfter: number;
  readonly kindStreak: number;
  readonly backoffMs: number;
  /** ISO timestamp when eligible again; null when failed. */
  readonly nextEligibleAt: string | null;
  readonly parkedReason: ParkedReason | null;
  readonly reason: string;
  /** Compact line for packet / UI chips. */
  readonly accounting: string;
  readonly policySummary: string;
}

export interface DecideRetryInput {
  readonly kind: FailureKind;
  /** Current task.attempts before this failure. */
  readonly attempts: number;
  readonly maxAttempts: number;
  /** Task body before appending this failure (for streak / ceiling). */
  readonly body: string;
  readonly nowMs: number;
  readonly backoffBaseMs: number;
  /** Optional detail (provision error text) for hard-infra detection. */
  readonly detail?: string;
  /** Override policy table (tests). */
  readonly policy?: Readonly<Record<FailureKind, KindPolicyRow>>;
}

// Match **Kind:** `x` under Run failure; also kind lines under Auto-rework.
const RUN_FAILURE_KIND_RE = /##\s+Run failure\b[\s\S]*?\*\*Kind:\*\*\s*`([^`]+)`/gi;
const AUTO_REWORK_KIND_RE = /##\s+Auto-rework\b[\s\S]*?\*\*Failure kind:\*\*\s*`([^`]+)`/gi;
const ANY_FAILURE_SECTION_RE = /##\s+(Run failure|Auto-rework)\b/gi;
const NEXT_ELIGIBLE_RE = /\*\*Next eligible:\*\*\s*`([^`]+)`/i;

/**
 * Deliberate human continuation (`## Human steer`) starts a fresh failure
 * budget: thrash streaks and the global ceiling ignore history before the
 * latest steer section. Attempts are reset separately by steer/Retry.
 */
export function bodyForFailureAccounting(body: string): string {
  const re = /^##\s+Human steer\b/gim;
  let last = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    last = m.index;
  }
  if (last < 0) return body;
  return body.slice(last);
}

/**
 * Count human-visible failure outcomes already on the task body.
 * Used for the global ceiling (soft retries must not loop forever).
 */
export function countRecordedFailures(body: string): number {
  const scoped = bodyForFailureAccounting(body);
  const re = new RegExp(ANY_FAILURE_SECTION_RE.source, 'gi');
  let n = 0;
  while (re.exec(scoped) !== null) n += 1;
  return n;
}

/** Trailing consecutive streak of the same failure kind (Run failure + Auto-rework kind lines). */
export function trailingFailureKindStreak(
  body: string,
  kind: FailureKind,
): number {
  const scoped = bodyForFailureAccounting(body);
  // Order by appearance: scan both section kinds with index.
  const events: { index: number; kind: FailureKind }[] = [];
  for (const reSrc of [RUN_FAILURE_KIND_RE.source, AUTO_REWORK_KIND_RE.source]) {
    const re = new RegExp(reSrc, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(scoped)) !== null) {
      const k = normalizeFailureKind(m[1] ?? '');
      if (k) events.push({ index: m.index, kind: k });
    }
  }
  events.sort((a, b) => a.index - b.index);

  let count = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]!.kind === kind) count += 1;
    else break;
  }
  return count;
}

/**
 * Backoff delay for a kind given attemptsAfter (or current attempts when soft).
 * Same exponential curve as scheduling `backoffDelayMs`, scaled by kind multiplier.
 */
export function kindBackoffMs(
  kind: FailureKind,
  attemptsForBackoff: number,
  baseMs: number,
  policy: Readonly<Record<FailureKind, KindPolicyRow>> = DEFAULT_KIND_POLICY,
): number {
  const row = policy[kind];
  const n = Math.max(0, Math.max(1, attemptsForBackoff) - 1);
  const base = baseMs * 2 ** n;
  return Math.max(0, Math.floor(base * row.backoffMultiplier));
}

/**
 * Classify L1/L2/L3 from packet signals (for rework path accounting).
 * Preference: behavioral(L2) > mechanical(L1) > reviewer(L3) > L1 default.
 */
export function classifyVerifyFailureKind(input: {
  readonly dod: { readonly mechanical: string; readonly reviewer: string };
  readonly gates: readonly { readonly name: string; readonly passed: boolean }[];
}): FailureKind {
  if (input.gates.some((g) => g.name === 'behavioral' && !g.passed)) {
    return 'verify_l2';
  }
  const failed = input.gates.filter((g) => !g.passed);
  // Exclusive base-drift (other L1 gates green) — concurrent main, not product.
  if (
    failed.length > 0 &&
    failed.every((g) => g.name === 'base-drift') &&
    input.dod.mechanical !== 'pass'
  ) {
    return 'base_drift';
  }
  if (failed.length > 0 && failed.every((g) => g.name === 'base-drift')) {
    return 'base_drift';
  }
  if (input.dod.mechanical === 'fail') return 'verify_l1';
  if (input.dod.reviewer === 'fail') return 'verify_l3';
  return 'verify_l1';
}

export function formatAttemptAccounting(d: Pick<
  RetryDecision,
  'burnedAttempt' | 'attemptsAfter' | 'kind' | 'kindStreak' | 'outcome'
> & { readonly attemptsBefore?: number }): string {
  const before =
    d.attemptsBefore ??
    (d.burnedAttempt ? Math.max(0, d.attemptsAfter - 1) : d.attemptsAfter);
  if (!d.burnedAttempt) {
    return `soft (${d.kind} streak ${d.kindStreak}) · attempts ${before} → ${d.attemptsAfter} (no burn)`;
  }
  return `burn · attempts ${before} → ${d.attemptsAfter}`;
}

/**
 * Core policy decision: burn? retry/fail? backoff? next-eligible?
 */
export function decideRetry(input: DecideRetryInput): RetryDecision {
  const policy = input.policy ?? DEFAULT_KIND_POLICY;
  const row = policy[input.kind];
  const priorStreak = trailingFailureKindStreak(input.body, input.kind);
  const kindStreak = priorStreak + 1;
  const priorFailures = countRecordedFailures(input.body);
  const ceiling = globalFailureCeiling(input.maxAttempts);

  // Hard infra on provision / verify_infra — surface permanently, no retry loop.
  if (
    (input.kind === 'provision' || input.kind === 'verify_infra') &&
    input.detail &&
    isHardInfraError(input.detail)
  ) {
    const attemptsAfter = input.attempts + 1;
    return {
      kind: input.kind,
      outcome: 'fail',
      burnedAttempt: true,
      attemptsAfter,
      kindStreak,
      backoffMs: 0,
      nextEligibleAt: null,
      parkedReason: 'hard_infra',
      reason: `hard infra (${input.kind}) — permanent error, not auto-retried`,
      accounting: formatAttemptAccounting({
        burnedAttempt: true,
        attemptsAfter,
        kind: input.kind,
        kindStreak,
        outcome: 'fail',
        attemptsBefore: input.attempts,
      }),
      policySummary: row.summary,
    };
  }

  // Adapter auth infrastructure (e.g. Grok "Not signed in") — park once without
  // burning implementation attempts or thrashing agent_exit (Guardian dogfood).
  if (
    input.kind === 'agent_exit' &&
    input.detail &&
    isAdapterAuthInfraDetail(input.detail)
  ) {
    return {
      kind: input.kind,
      outcome: 'fail',
      burnedAttempt: false,
      attemptsAfter: input.attempts,
      kindStreak,
      backoffMs: 0,
      nextEligibleAt: null,
      parkedReason: 'hard_infra',
      reason:
        'adapter auth infrastructure — not signed in / login required; ' +
        'parked without burning an implementation attempt',
      accounting: formatAttemptAccounting({
        burnedAttempt: false,
        attemptsAfter: input.attempts,
        kind: input.kind,
        kindStreak,
        outcome: 'fail',
        attemptsBefore: input.attempts,
      }),
      policySummary: row.summary,
    };
  }

  // Global ceiling: all failure events (including soft) count.
  if (priorFailures + 1 > ceiling) {
    // Prefer showing a burn if under max; always park.
    const burnedAttempt = input.attempts < input.maxAttempts;
    const finalAttempts = burnedAttempt ? input.attempts + 1 : input.attempts;
    return {
      kind: input.kind,
      outcome: 'fail',
      burnedAttempt,
      attemptsAfter: finalAttempts,
      kindStreak,
      backoffMs: 0,
      nextEligibleAt: null,
      parkedReason: 'global_ceiling',
      reason: `global failure ceiling (${priorFailures + 1} > ${ceiling}) — human salvage`,
      accounting: formatAttemptAccounting({
        burnedAttempt,
        attemptsAfter: finalAttempts,
        kind: input.kind,
        kindStreak,
        outcome: 'fail',
        attemptsBefore: input.attempts,
      }),
      policySummary: row.summary,
    };
  }

  // Thrash: consecutive same kind hits kind thrashLimit.
  if (row.thrashLimit > 0 && kindStreak >= row.thrashLimit) {
    // Only thrash-park early when we would not already exhaust max on this burn.
    const wouldBurn =
      row.burnMode === 'always' || kindStreak > row.softLimit;
    const attemptsAfter = wouldBurn ? input.attempts + 1 : input.attempts;
    // If this thrash also hits maxAttempts, label max_attempts for clarity.
    if (wouldBurn && attemptsAfter >= input.maxAttempts) {
      return {
        kind: input.kind,
        outcome: 'fail',
        burnedAttempt: true,
        attemptsAfter,
        kindStreak,
        backoffMs: 0,
        nextEligibleAt: null,
        parkedReason: 'max_attempts',
        reason: `max attempts (${attemptsAfter}/${input.maxAttempts}) after ${input.kind}`,
        accounting: formatAttemptAccounting({
          burnedAttempt: true,
          attemptsAfter,
          kind: input.kind,
          kindStreak,
          outcome: 'fail',
          attemptsBefore: input.attempts,
        }),
        policySummary: row.summary,
      };
    }
    // Early thrash park (remaining attempts not burned on same death).
    if (attemptsAfter < input.maxAttempts || !wouldBurn) {
      const burnedAttempt = wouldBurn;
      const finalAttempts = burnedAttempt ? input.attempts + 1 : input.attempts;
      return {
        kind: input.kind,
        outcome: 'fail',
        burnedAttempt,
        attemptsAfter: finalAttempts,
        kindStreak,
        backoffMs: 0,
        nextEligibleAt: null,
        parkedReason: 'thrash',
        reason: `thrash: ${kindStreak}× consecutive ${input.kind} (limit ${row.thrashLimit})`,
        accounting: formatAttemptAccounting({
          burnedAttempt,
          attemptsAfter: finalAttempts,
          kind: input.kind,
          kindStreak,
          outcome: 'fail',
          attemptsBefore: input.attempts,
        }),
        policySummary: row.summary,
      };
    }
  }

  // Burn decision for non-park path.
  const burnedAttempt =
    row.burnMode === 'always' ||
    (row.burnMode === 'after_soft' && kindStreak > row.softLimit);
  const attemptsAfter = burnedAttempt ? input.attempts + 1 : input.attempts;

  if (burnedAttempt && attemptsAfter >= input.maxAttempts) {
    return {
      kind: input.kind,
      outcome: 'fail',
      burnedAttempt: true,
      attemptsAfter,
      kindStreak,
      backoffMs: 0,
      nextEligibleAt: null,
      parkedReason: 'max_attempts',
      reason: `max attempts (${attemptsAfter}/${input.maxAttempts})`,
      accounting: formatAttemptAccounting({
        burnedAttempt: true,
        attemptsAfter,
        kind: input.kind,
        kindStreak,
        outcome: 'fail',
        attemptsBefore: input.attempts,
      }),
      policySummary: row.summary,
    };
  }

  const backoffAttempts = Math.max(1, attemptsAfter);
  const backoffMs = kindBackoffMs(input.kind, backoffAttempts, input.backoffBaseMs, policy);
  const nextEligibleAt = new Date(input.nowMs + backoffMs).toISOString();

  return {
    kind: input.kind,
    outcome: 'retry',
    burnedAttempt,
    attemptsAfter,
    kindStreak,
    backoffMs,
    nextEligibleAt,
    parkedReason: null,
    reason: burnedAttempt
      ? `${input.kind}: burn attempt, retry after ${backoffMs}ms`
      : `${input.kind}: soft retry ${kindStreak}/${row.softLimit}, no attempt burn`,
    accounting: formatAttemptAccounting({
      burnedAttempt,
      attemptsAfter,
      kind: input.kind,
      kindStreak,
      outcome: 'retry',
      attemptsBefore: input.attempts,
    }),
    policySummary: row.summary,
  };
}

/** Parse the latest **Next eligible:** timestamp from the task body. */
export function parseNextEligibleMs(body: string): number | null {
  // Prefer the last occurrence (most recent failure / rework).
  const re = new RegExp(NEXT_ELIGIBLE_RE.source, 'gi');
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    last = m[1]?.trim() ?? null;
  }
  if (!last || last.toLowerCase() === 'n/a') return null;
  const ms = Date.parse(last);
  return Number.isNaN(ms) ? null : ms;
}
