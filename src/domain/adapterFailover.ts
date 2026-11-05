/**
 * Domain — adapter failover when a provider dies repeatedly (agent_exit).
 *
 * Case study (2026-07-29): xAI mid-stream disconnects killed a chain of grok
 * tasks; earlier, claude failed instantly on Fable quota exhaustion. Both
 * required an operator to notice and hand-switch adapters. Single-provider
 * thrash must not stop the whole factory.
 *
 * Pure policy only. Orchestrator records agent_exit timestamps per adapter
 * and calls {@link chooseAdapterWithFailover} on **new** dispatch. Running
 * agents are never interrupted; after the health window elapses the preferred
 * adapter is used again automatically.
 *
 * Kill-switch: HERCULES_ADAPTER_FAILOVER=0 (wired at the orchestrator).
 */

import { isAdapterKind, type AdapterKind } from './agents.js';

/** Sliding window: ≥ threshold agent_exit ⇒ unhealthy. Default 15 minutes. */
export const DEFAULT_FAILOVER_WINDOW_MS = 15 * 60_000;

/** Consecutive (windowed) agent_exit count that marks an adapter unhealthy. */
export const UNHEALTHY_EXIT_THRESHOLD = 3;

/**
 * Default preference chain when the requested adapter is unhealthy.
 * Skips entries that are themselves unhealthy or not available.
 */
export const DEFAULT_FAILOVER_ORDER: readonly AdapterKind[] = [
  'grok',
  'codex',
] as const;

export interface ChooseAdapterWithFailoverInput {
  /** Adapter resolved from task → repo → daemon (before failover). */
  readonly requested: AdapterKind;
  /**
   * agent_exit timestamps (ms since epoch) per adapter kind.
   * Caller may include events older than the window; this function filters.
   */
  readonly recentExitsByAdapter: Readonly<Partial<Record<string, readonly number[]>>>;
  /** Adapters registered / usable for dispatch. */
  readonly available: readonly AdapterKind[];
  /** Clock for the sliding window. */
  readonly nowMs: number;
  /** Sliding window length (default {@link DEFAULT_FAILOVER_WINDOW_MS}). */
  readonly windowMs?: number;
  /** Unhealthy threshold (default {@link UNHEALTHY_EXIT_THRESHOLD}). */
  readonly threshold?: number;
  /**
   * Preference order when failing over (default grok → codex). An explicit
   * policy may include opt-in providers such as Claude.
   * Does not include `fake` — dry-run is never an automatic substitute.
   */
  readonly failoverOrder?: readonly AdapterKind[];
  /** When false, always return `requested` with no note. */
  readonly enabled?: boolean;
  /**
   * Task has an explicit `adapter:` front-matter pin. Do not failover;
   * still emit a warning note when the pinned adapter is unhealthy.
   */
  readonly pinned?: boolean;
  /**
   * Optional policy gate for failover substitutes only (e.g. Guardian
   * sandbox-compatible). Requested is never filtered here — pre-dispatch
   * still fails closed when the requested adapter cannot enforce policy.
   */
  readonly isPolicyCompatible?: (kind: AdapterKind) => boolean;
}

export interface ChooseAdapterWithFailoverResult {
  readonly chosen: AdapterKind;
  readonly requested: AdapterKind;
  /** True only when we actually switched away from `requested`. */
  readonly failedOver: boolean;
  /** Exit count for `requested` inside the window. */
  readonly requestedExitCount: number;
  /** Adapters currently at/above the unhealthy threshold. */
  readonly unhealthy: readonly AdapterKind[];
  /**
   * Operator-facing one-liner for timeline / decision inbox.
   * Null when no degradation or warning applies.
   */
  readonly note: string | null;
  /**
   * Every candidate (requested + failover chain ∩ available) is unhealthy;
   * we keep `requested` and warn.
   */
  readonly allUnhealthy: boolean;
}

export type FailoverNoteMode = 'failover' | 'pinned' | 'all_unhealthy';

export function countExitsInWindow(
  stamps: readonly number[] | undefined,
  nowMs: number,
  windowMs: number,
): number {
  if (!stamps || stamps.length === 0) return 0;
  const cutoff = nowMs - windowMs;
  let n = 0;
  for (const t of stamps) {
    if (Number.isFinite(t) && t >= cutoff && t <= nowMs + 1_000) n += 1;
  }
  return n;
}

export function isAdapterUnhealthy(
  exitCount: number,
  threshold: number = UNHEALTHY_EXIT_THRESHOLD,
): boolean {
  return exitCount >= threshold;
}

/**
 * Drop timestamps outside the window (and empty adapter keys). Pure helper
 * for the orchestrator's in-memory exit log housekeeping.
 */
export function pruneExitsOutsideWindow(
  recentExitsByAdapter: Readonly<Partial<Record<string, readonly number[]>>>,
  nowMs: number,
  windowMs: number = DEFAULT_FAILOVER_WINDOW_MS,
): Partial<Record<string, number[]>> {
  const cutoff = nowMs - windowMs;
  const out: Partial<Record<string, number[]>> = {};
  for (const [kind, stamps] of Object.entries(recentExitsByAdapter)) {
    if (!stamps) continue;
    const kept = stamps.filter((t) => Number.isFinite(t) && t >= cutoff);
    if (kept.length > 0) out[kind] = kept;
  }
  return out;
}

export function formatAdapterFailoverNote(input: {
  readonly requested: AdapterKind;
  readonly chosen: AdapterKind;
  readonly exitCount: number;
  readonly mode: FailoverNoteMode;
}): string {
  if (input.mode === 'all_unhealthy') {
    return `adapter 降级: 全部不健康, 回退首选 ${input.requested}`;
  }
  if (input.mode === 'pinned') {
    return (
      `adapter 不健康提示: ${input.requested} 不健康(${input.exitCount} 次异常退出), ` +
      `任务固定使用 ${input.requested} (未降级)`
    );
  }
  return (
    `adapter 降级: ${input.requested} 不健康(${input.exitCount} 次异常退出), ` +
    `本轮使用 ${input.chosen}`
  );
}

/**
 * Zh one-liner for the decision inbox while any adapter is unhealthy.
 * Distinct from the per-task timeline note (which names the chosen substitute).
 */
export function formatAdapterFailoverInboxLine(input: {
  readonly unhealthy: readonly AdapterKind[];
  readonly activeSubstitute?: AdapterKind | null;
  readonly preferred?: AdapterKind | null;
}): string | null {
  if (input.unhealthy.length === 0) return null;
  const list = input.unhealthy.join(', ');
  if (input.activeSubstitute && input.preferred && input.activeSubstitute !== input.preferred) {
    return `⚠️ adapter 降级 — ${list} 不健康, 新派发使用 ${input.activeSubstitute}`;
  }
  return `⚠️ adapter 降级 — ${list} 不健康, 新派发自动避开`;
}

function availableSet(available: readonly AdapterKind[]): ReadonlySet<AdapterKind> {
  return new Set(available.filter((k) => isAdapterKind(k)));
}

/**
 * Pick an adapter for a **new** dispatch given recent agent_exit history.
 *
 * Rules:
 * 1. Disabled / requested healthy → requested, no note.
 * 2. Pinned + unhealthy → requested + warn (never switch).
 * 3. Unhealthy → first healthy entry in failover order that is available.
 * 4. All unhealthy → requested + all_unhealthy warning.
 */
export function chooseAdapterWithFailover(
  input: ChooseAdapterWithFailoverInput,
): ChooseAdapterWithFailoverResult {
  const windowMs = input.windowMs ?? DEFAULT_FAILOVER_WINDOW_MS;
  const threshold = input.threshold ?? UNHEALTHY_EXIT_THRESHOLD;
  const order = input.failoverOrder ?? DEFAULT_FAILOVER_ORDER;
  const enabled = input.enabled !== false;
  const avail = availableSet(input.available);

  const unhealthy: AdapterKind[] = [];
  for (const kind of order) {
    const n = countExitsInWindow(
      input.recentExitsByAdapter[kind],
      input.nowMs,
      windowMs,
    );
    if (isAdapterUnhealthy(n, threshold)) unhealthy.push(kind);
  }
  // Requested might not be in the default order (e.g. fake) — still score it.
  if (!unhealthy.includes(input.requested)) {
    const nReq = countExitsInWindow(
      input.recentExitsByAdapter[input.requested],
      input.nowMs,
      windowMs,
    );
    if (isAdapterUnhealthy(nReq, threshold)) unhealthy.push(input.requested);
  }

  const requestedExitCount = countExitsInWindow(
    input.recentExitsByAdapter[input.requested],
    input.nowMs,
    windowMs,
  );
  const requestedUnhealthy = isAdapterUnhealthy(requestedExitCount, threshold);

  const base = {
    requested: input.requested,
    requestedExitCount,
    unhealthy,
  };

  if (!enabled) {
    return {
      ...base,
      chosen: input.requested,
      failedOver: false,
      note: null,
      allUnhealthy: false,
    };
  }

  if (!requestedUnhealthy) {
    return {
      ...base,
      chosen: input.requested,
      failedOver: false,
      note: null,
      allUnhealthy: false,
    };
  }

  // Explicit task.adapter pin: keep requested, surface a warning only.
  if (input.pinned) {
    return {
      ...base,
      chosen: input.requested,
      failedOver: false,
      note: formatAdapterFailoverNote({
        requested: input.requested,
        chosen: input.requested,
        exitCount: requestedExitCount,
        mode: 'pinned',
      }),
      allUnhealthy: false,
    };
  }

  // Walk preference chain; pick first healthy + available + policy-compatible
  // (may equal requested only if somehow not unhealthy — already handled above).
  const policyOk = input.isPolicyCompatible;
  for (const candidate of order) {
    if (!avail.has(candidate)) continue;
    if (unhealthy.includes(candidate)) continue;
    // Prefer a real substitute over staying on the dying requested.
    if (candidate === input.requested) continue;
    if (policyOk && !policyOk(candidate)) continue;
    return {
      ...base,
      chosen: candidate,
      failedOver: true,
      note: formatAdapterFailoverNote({
        requested: input.requested,
        chosen: candidate,
        exitCount: requestedExitCount,
        mode: 'failover',
      }),
      allUnhealthy: false,
    };
  }

  return {
    ...base,
    chosen: input.requested,
    failedOver: false,
    note: formatAdapterFailoverNote({
      requested: input.requested,
      chosen: input.requested,
      exitCount: requestedExitCount,
      mode: 'all_unhealthy',
    }),
    allUnhealthy: true,
  };
}

/**
 * Parse HERCULES_ADAPTER_FAILOVER. Default on; only explicit 0/false/off disables.
 */
export function isAdapterFailoverEnabled(
  env: Readonly<Record<string, string | undefined>> = {},
): boolean {
  const raw = (env['HERCULES_ADAPTER_FAILOVER'] ?? '1').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
}
