/**
 * Domain layer — per-task and rolling daily token/cost caps.
 *
 * Pure. Tracks adapter-reported usage, evaluates soft warn vs hard stop, and
 * produces human-readable reasons. No IO — the orchestrator owns the ledger
 * and env wiring; this module only accounts and decides.
 *
 * Caps are off by default so single normal tasks are never blocked. When
 * enabled, billing-profile USD thresholds can fire. Token counts remain
 * telemetry unless an owner explicitly configures a token threshold.
 *
 * USD defaults come from {@link BillingMode} profiles (`subscription` vs
 * `metered`). Explicit per-field env overrides remain authoritative. Token
 * overrides and off/unlimited syntax are independent of billing mode.
 */

import type { CostLedgerDiagnostics } from './costLedger.js';

/** Adapter-shaped spend sample (structurally TokenUsage / PacketUsage). */
export interface UsageSample {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

/** One recorded spend event (one agent run or mid-run snapshot delta). */
export interface UsageLedgerEntry {
  readonly taskId: string;
  /** ms since epoch when the spend was observed. */
  readonly atMs: number;
  readonly usage: UsageSample;
}

/** Soft/hard thresholds for one scope (per-task or daily). null = unlimited. */
export interface CostCapThresholds {
  readonly softUsd: number | null;
  readonly hardUsd: number | null;
  readonly softTokens: number | null;
  readonly hardTokens: number | null;
}

/**
 * How USD figures should be interpreted on this host.
 * - `subscription` — flat plan; adapter USD is an internal estimate, not invoice.
 * - `metered` — conservative profile for true pay-as-you-go spend.
 */
export type BillingMode = 'subscription' | 'metered';

export interface CostCapsPolicy {
  /** When false, always ok (safe default). */
  readonly enabled: boolean;
  /** Effective billing profile after parse (never raw env). */
  readonly billingMode: BillingMode;
  /**
   * Actionable diagnostic when mode was missing/invalid.
   * Never includes the raw env value.
   */
  readonly billingModeNote: string | null;
  readonly perTask: CostCapThresholds;
  readonly daily: CostCapThresholds;
}

export type CostCapLevel = 'ok' | 'soft' | 'hard';

export type CostCapScope = 'task' | 'day';

export interface CostCapBreach {
  readonly scope: CostCapScope;
  readonly level: 'soft' | 'hard';
  /** Which metric tripped the threshold. */
  readonly metric: 'usd' | 'tokens';
  readonly observed: number;
  readonly threshold: number;
}

export interface CostCapVerdict {
  readonly level: CostCapLevel;
  readonly breaches: readonly CostCapBreach[];
  /** Stable, human-readable lines for packets / fail mini-packets. */
  readonly reasons: readonly string[];
}

export interface CostCapSummary {
  readonly enabled: boolean;
  readonly level: CostCapLevel;
  readonly day: UsageSample;
  readonly taskTotals: Readonly<Record<string, UsageSample>>;
  readonly breaches: readonly CostCapBreach[];
  readonly reasons: readonly string[];
  readonly policy: CostCapsPolicy;
  /** Effective billing mode (mirrors policy for phone DTO convenience). */
  readonly billingMode: BillingMode;
  readonly billingModeNote: string | null;
  /** Phone-facing meaning of USD figures for this mode. */
  readonly costMeaning: string;
  /** Bounded durable recovery/freshness metadata. */
  readonly ledger?: CostLedgerDiagnostics;
}

/** Unlimited thresholds — used when a scope has no env limits. */
export const UNLIMITED_THRESHOLDS: CostCapThresholds = {
  softUsd: null,
  hardUsd: null,
  softTokens: null,
  hardTokens: null,
};

/**
 * Legacy reference values retained for API compatibility and telemetry charts.
 * They are not enforcement defaults; only explicit token env values are used.
 */
export const DEFAULT_TOKEN_PER_TASK = {
  softTokens: 400_000,
  hardTokens: 500_000,
} as const;

export const DEFAULT_TOKEN_DAILY = {
  softTokens: 2_000_000,
  hardTokens: 2_500_000,
} as const;

/**
 * Metered (conservative) USD defaults when caps are enabled without explicit
 * numbers. Exactly half the subscription USD profile. Tokens are advisory.
 */
export const DEFAULT_ENABLED_PER_TASK: CostCapThresholds = {
  softUsd: 20,
  hardUsd: 25,
  softTokens: null,
  hardTokens: null,
};

export const DEFAULT_ENABLED_DAILY: CostCapThresholds = {
  softUsd: 40,
  hardUsd: 50,
  softTokens: null,
  hardTokens: null,
};

/** Subscription profile: higher USD ceilings for flat-plan hosts. */
export const SUBSCRIPTION_ENABLED_PER_TASK: CostCapThresholds = {
  softUsd: 40,
  hardUsd: 50,
  softTokens: null,
  hardTokens: null,
};

export const SUBSCRIPTION_ENABLED_DAILY: CostCapThresholds = {
  softUsd: 80,
  hardUsd: 100,
  softTokens: null,
  hardTokens: null,
};

/** Conservative default mode when unset/invalid. */
export const DEFAULT_BILLING_MODE: BillingMode = 'metered';

/** Off by default — opt in via HERCULES_COST_CAPS=1 (or config override). */
export const DEFAULT_COST_CAPS: CostCapsPolicy = {
  enabled: false,
  billingMode: DEFAULT_BILLING_MODE,
  billingModeNote: null,
  perTask: DEFAULT_ENABLED_PER_TASK,
  daily: DEFAULT_ENABLED_DAILY,
};

export interface BillingModeParseResult {
  readonly mode: BillingMode;
  /**
   * Actionable operator note when mode was missing/invalid.
   * Never includes the raw env value.
   */
  readonly note: string | null;
}

const BILLING_MODE_HELP =
  'Set HERCULES_BILLING_MODE=subscription or metered.';

/**
 * Parse HERCULES_BILLING_MODE. Missing/invalid → metered + diagnostic.
 * Never echoes the raw env value into the note.
 */
export function parseBillingMode(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): BillingModeParseResult {
  const raw = env['HERCULES_BILLING_MODE'];
  if (raw === undefined || raw.trim() === '') {
    return {
      mode: DEFAULT_BILLING_MODE,
      note:
        `HERCULES_BILLING_MODE unset; using metered (conservative). ${BILLING_MODE_HELP}`,
    };
  }
  const t = raw.trim().toLowerCase();
  if (t === 'subscription' || t === 'metered') {
    return { mode: t, note: null };
  }
  return {
    mode: DEFAULT_BILLING_MODE,
    note:
      `HERCULES_BILLING_MODE invalid/unrecognized; using metered (conservative). ${BILLING_MODE_HELP}`,
  };
}

/** USD default thresholds for a billing mode; token defaults are advisory. */
export function thresholdsForBillingMode(mode: BillingMode): {
  readonly perTask: CostCapThresholds;
  readonly daily: CostCapThresholds;
} {
  if (mode === 'subscription') {
    return {
      perTask: SUBSCRIPTION_ENABLED_PER_TASK,
      daily: SUBSCRIPTION_ENABLED_DAILY,
    };
  }
  return {
    perTask: DEFAULT_ENABLED_PER_TASK,
    daily: DEFAULT_ENABLED_DAILY,
  };
}

/**
 * Phone/packet wording for what USD figures mean under this mode.
 * Subscription must not be misread as charged invoice spend.
 */
export function costMeaningForMode(mode: BillingMode): string {
  if (mode === 'subscription') {
    return (
      'USD figures are an internal estimate under a flat subscription — ' +
      'not an invoice or charged spend.'
    );
  }
  return (
    'USD figures estimate metered adapter spend against configured caps.'
  );
}

/** Env truthy for HERCULES_COST_CAPS (off by default — conservative). */
export function isCostCapsEnabled(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  const raw = (env['HERCULES_COST_CAPS'] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/**
 * Build a cost-caps policy from environment variables.
 *
 * | Env | Meaning |
 * | --- | --- |
 * | `HERCULES_COST_CAPS` | `1`/`true`/`on`/`yes` enables (default off) |
 * | `HERCULES_BILLING_MODE` | `subscription` \| `metered` (default metered) |
 * | `HERCULES_TASK_COST_SOFT_USD` / `_HARD_USD` | per-task $ soft/hard |
 * | `HERCULES_DAY_COST_SOFT_USD` / `_HARD_USD` | daily $ soft/hard |
 * | `HERCULES_TASK_TOKENS_SOFT` / `_HARD` | per-task total-token soft/hard |
 * | `HERCULES_DAY_TOKENS_SOFT` / `_HARD` | daily total-token soft/hard |
 *
 * When enabled without explicit numbers, billing-mode USD defaults apply
 * (subscription: task 40/50 day 80/100; metered: half). Explicit per-field
 * overrides remain authoritative. Token counts are telemetry unless an owner
 * explicitly configures a token threshold. Set a threshold to empty / `off` /
 * `none` / `unlimited` to disable that axis.
 */
export function parseCostCapsPolicy(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): CostCapsPolicy {
  const { mode, note } = parseBillingMode(env);
  const defaults = thresholdsForBillingMode(mode);

  if (!isCostCapsEnabled(env)) {
    return {
      enabled: false,
      billingMode: mode,
      billingModeNote: note,
      perTask: defaults.perTask,
      daily: defaults.daily,
    };
  }

  return {
    enabled: true,
    billingMode: mode,
    billingModeNote: note,
    perTask: {
      softUsd: parseThreshold(env['HERCULES_TASK_COST_SOFT_USD'], defaults.perTask.softUsd),
      hardUsd: parseThreshold(env['HERCULES_TASK_COST_HARD_USD'], defaults.perTask.hardUsd),
      softTokens: parseThreshold(env['HERCULES_TASK_TOKENS_SOFT'], defaults.perTask.softTokens),
      hardTokens: parseThreshold(env['HERCULES_TASK_TOKENS_HARD'], defaults.perTask.hardTokens),
    },
    daily: {
      softUsd: parseThreshold(env['HERCULES_DAY_COST_SOFT_USD'], defaults.daily.softUsd),
      hardUsd: parseThreshold(env['HERCULES_DAY_COST_HARD_USD'], defaults.daily.hardUsd),
      softTokens: parseThreshold(env['HERCULES_DAY_TOKENS_SOFT'], defaults.daily.softTokens),
      hardTokens: parseThreshold(env['HERCULES_DAY_TOKENS_HARD'], defaults.daily.hardTokens),
    },
  };
}

/**
 * Parse one numeric threshold. Missing → default. `off`/`none`/`unlimited`/empty
 * when the key is present → null (unlimited). Invalid numbers → default.
 */
function parseThreshold(raw: string | undefined, fallback: number | null): number | null {
  if (raw === undefined) return fallback;
  const t = raw.trim().toLowerCase();
  if (t === '' || t === 'off' || t === 'none' || t === 'unlimited' || t === 'null') {
    return null;
  }
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/** Empty usage sample. */
export function zeroUsage(): UsageSample {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

/** Non-negative finite clamp for token/cost fields. */
export function sanitizeUsage(raw: UsageSample): UsageSample {
  return {
    inputTokens: clampNonNegInt(raw.inputTokens),
    outputTokens: clampNonNegInt(raw.outputTokens),
    costUsd: clampNonNegFinite(raw.costUsd),
  };
}

/** Sum two samples (cost rounded to avoid IEEE float noise). */
export function addUsage(a: UsageSample, b: UsageSample): UsageSample {
  const x = sanitizeUsage(a);
  const y = sanitizeUsage(b);
  return {
    inputTokens: x.inputTokens + y.inputTokens,
    outputTokens: x.outputTokens + y.outputTokens,
    costUsd: Math.round((x.costUsd + y.costUsd) * 1e6) / 1e6,
  };
}

/** Total tokens (input + output). */
export function totalTokens(u: UsageSample): number {
  const s = sanitizeUsage(u);
  return s.inputTokens + s.outputTokens;
}

/**
 * UTC calendar day key `YYYY-MM-DD` for rolling daily windows.
 * Injected clock → deterministic tests.
 */
export function utcDayKey(atMs: number): string {
  const d = new Date(atMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Filter ledger entries belonging to the same UTC day as `nowMs`. */
export function entriesForUtcDay(
  ledger: readonly UsageLedgerEntry[],
  nowMs: number,
): UsageLedgerEntry[] {
  const key = utcDayKey(nowMs);
  return ledger.filter((e) => utcDayKey(e.atMs) === key);
}

/** Filter ledger entries for one task id. */
export function entriesForTask(
  ledger: readonly UsageLedgerEntry[],
  taskId: string,
): UsageLedgerEntry[] {
  return ledger.filter((e) => e.taskId === taskId);
}

/** Aggregate samples from a list of ledger entries. */
export function sumLedger(entries: readonly UsageLedgerEntry[]): UsageSample {
  let acc = zeroUsage();
  for (const e of entries) acc = addUsage(acc, e.usage);
  return acc;
}

/** Per-task totals across the whole ledger. */
export function taskTotals(
  ledger: readonly UsageLedgerEntry[],
): Record<string, UsageSample> {
  const out: Record<string, UsageSample> = {};
  for (const e of ledger) {
    const prev = out[e.taskId] ?? zeroUsage();
    out[e.taskId] = addUsage(prev, e.usage);
  }
  return out;
}

/**
 * Append a spend event. If the same task already has a mid-run snapshot, the
 * orchestrator should prefer {@link replaceTaskLiveUsage} so cumulative adapter
 * usage is not double-counted.
 */
export function appendUsage(
  ledger: readonly UsageLedgerEntry[],
  entry: UsageLedgerEntry,
): UsageLedgerEntry[] {
  return [...ledger, { ...entry, usage: sanitizeUsage(entry.usage) }];
}

/**
 * Replace the single *live* (running) entry for a task with the latest cumulative
 * adapter snapshot. Terminal run commits should use {@link commitTaskUsage} so
 * the final sample is kept after the live slot is cleared.
 *
 * Convention: live entries use `atMs` equal to the dispatch start; the ledger
 * may hold at most one live entry per task (tagged via optional bookkeeping in
 * the orchestrator). This pure helper simply replaces the last entry for the
 * task when `replaceLastForTask` is true, else appends.
 */
export function upsertTaskUsage(
  ledger: readonly UsageLedgerEntry[],
  entry: UsageLedgerEntry,
  opts: { readonly replaceLastForTask?: boolean } = {},
): UsageLedgerEntry[] {
  const usage = sanitizeUsage(entry.usage);
  const next: UsageLedgerEntry = { taskId: entry.taskId, atMs: entry.atMs, usage };
  if (!opts.replaceLastForTask) return [...ledger, next];
  let lastIdx = -1;
  for (let i = ledger.length - 1; i >= 0; i -= 1) {
    if (ledger[i]!.taskId === entry.taskId) {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx < 0) return [...ledger, next];
  const copy = ledger.slice();
  copy[lastIdx] = next;
  return copy;
}

/**
 * Evaluate thresholds against an observed sample.
 * Hard always dominates soft. Multiple metrics/scopes can appear in breaches.
 */
export function evaluateThresholds(
  scope: CostCapScope,
  observed: UsageSample,
  thresholds: CostCapThresholds,
): CostCapBreach[] {
  const u = sanitizeUsage(observed);
  const tokens = totalTokens(u);
  const breaches: CostCapBreach[] = [];

  const push = (
    level: 'soft' | 'hard',
    metric: 'usd' | 'tokens',
    value: number,
    threshold: number | null,
  ): void => {
    if (threshold === null || !Number.isFinite(threshold) || threshold < 0) return;
    if (value >= threshold) {
      breaches.push({ scope, level, metric, observed: value, threshold });
    }
  };

  // Hard first so callers can filter; soft still recorded when both trip.
  push('hard', 'usd', u.costUsd, thresholds.hardUsd);
  push('hard', 'tokens', tokens, thresholds.hardTokens);
  push('soft', 'usd', u.costUsd, thresholds.softUsd);
  push('soft', 'tokens', tokens, thresholds.softTokens);

  return breaches;
}

/**
 * Combined per-task + daily verdict. Highest level wins.
 * When policy is disabled, always ok with empty breaches.
 */
export function evaluateCostCaps(input: {
  readonly policy: CostCapsPolicy;
  readonly taskUsage: UsageSample;
  readonly dayUsage: UsageSample;
}): CostCapVerdict {
  if (!input.policy.enabled) {
    return { level: 'ok', breaches: [], reasons: [] };
  }

  const breaches = [
    ...evaluateThresholds('task', input.taskUsage, input.policy.perTask),
    ...evaluateThresholds('day', input.dayUsage, input.policy.daily),
  ];

  let level: CostCapLevel = 'ok';
  if (breaches.some((b) => b.level === 'hard')) level = 'hard';
  else if (breaches.some((b) => b.level === 'soft')) level = 'soft';

  const reasons = formatBreachReasons(breaches);
  return { level, breaches, reasons };
}

/** True when daily hard cap is breached — new dispatches should stop. */
export function isDailyHardBlocked(
  policy: CostCapsPolicy,
  dayUsage: UsageSample,
): boolean {
  if (!policy.enabled) return false;
  return evaluateThresholds('day', dayUsage, policy.daily).some((b) => b.level === 'hard');
}

/** True when this task's cumulative spend already hit a hard cap. */
export function isTaskHardBlocked(
  policy: CostCapsPolicy,
  taskUsage: UsageSample,
): boolean {
  if (!policy.enabled) return false;
  return evaluateThresholds('task', taskUsage, policy.perTask).some((b) => b.level === 'hard');
}

/** Human-readable reason lines for fail mini-packets / logs. */
export function formatBreachReasons(breaches: readonly CostCapBreach[]): string[] {
  const hard = breaches.filter((b) => b.level === 'hard');
  const soft = breaches.filter((b) => b.level === 'soft');
  // Prefer hard-only reasons when both present for the same scope/metric.
  const preferred = hard.length > 0 ? hard : soft;
  const lines: string[] = [];
  for (const b of preferred) {
    lines.push(formatOneBreach(b));
  }
  return lines;
}

function formatOneBreach(b: CostCapBreach): string {
  const scope = b.scope === 'task' ? 'per-task' : 'daily';
  const level = b.level === 'hard' ? 'hard stop' : 'soft warn';
  if (b.metric === 'usd') {
    return (
      `${scope} ${level}: cost $${formatUsd(b.observed)} ≥ $${formatUsd(b.threshold)}`
    );
  }
  return (
    `${scope} ${level}: explicit token override ${formatTokens(b.observed)} ≥ ${formatTokens(b.threshold)}`
  );
}

/** Compact summary for Settings / RuntimeView. */
export function buildCostCapSummary(input: {
  readonly policy: CostCapsPolicy;
  readonly ledger: readonly UsageLedgerEntry[];
  readonly nowMs: number;
  /** Optional live task samples not yet committed as separate terminal entries. */
  readonly liveByTask?: Readonly<Record<string, UsageSample>>;
  readonly ledgerDiagnostics?: CostLedgerDiagnostics;
}): CostCapSummary {
  const dayEntries = entriesForUtcDay(input.ledger, input.nowMs);
  let day = sumLedger(dayEntries);
  const totals = taskTotals(input.ledger);

  if (input.liveByTask) {
    for (const [taskId, live] of Object.entries(input.liveByTask)) {
      // Live usage is cumulative for the current run; if ledger already has
      // historical task spend, add live on top only when ledger has no entry
      // for this run. Callers should keep live separate from committed ledger.
      const committed = totals[taskId] ?? zeroUsage();
      // Prefer max per field so mid-run replace does not under-count when
      // live is absolute cumulative for the active run only.
      totals[taskId] = addUsage(committed, live);
      day = addUsage(day, live);
    }
  }

  // Day-level verdict uses aggregated day; task-level max hard across tasks
  // for the overall "level" banner.
  const dayVerdict = evaluateCostCaps({
    policy: input.policy,
    taskUsage: zeroUsage(),
    dayUsage: day,
  });

  let level: CostCapLevel = dayVerdict.level;
  const allBreaches: CostCapBreach[] = [...dayVerdict.breaches];

  for (const [, usage] of Object.entries(totals)) {
    const v = evaluateCostCaps({
      policy: input.policy,
      taskUsage: usage,
      dayUsage: zeroUsage(),
    });
    if (v.level === 'hard') level = 'hard';
    else if (v.level === 'soft' && level === 'ok') level = 'soft';
    for (const b of v.breaches) allBreaches.push(b);
  }

  const reasons = formatBreachReasons(allBreaches);
  if (input.policy.enabled && input.ledgerDiagnostics?.failClosed === true) {
    level = 'hard';
    const note =
      input.ledgerDiagnostics.note ??
      'Cost ledger is unavailable; current-day caps fail closed.';
    if (!reasons.includes(note)) reasons.push(note);
  }

  return {
    enabled: input.policy.enabled,
    level: input.policy.enabled ? level : 'ok',
    day,
    taskTotals: totals,
    breaches: allBreaches,
    reasons,
    policy: input.policy,
    billingMode: input.policy.billingMode,
    billingModeNote: input.policy.billingModeNote,
    costMeaning: costMeaningForMode(input.policy.billingMode),
    ...(input.ledgerDiagnostics ? { ledger: input.ledgerDiagnostics } : {}),
  };
}

/**
 * Markdown block for review packets when caps are enabled.
 * Includes this run's usage plus cap verdict for task/day.
 */
export function renderCostCapPacketSection(input: {
  readonly policy: CostCapsPolicy;
  readonly runUsage?: UsageSample;
  readonly taskUsage: UsageSample;
  readonly dayUsage: UsageSample;
  readonly verdict: CostCapVerdict;
}): string {
  if (!input.policy.enabled) return '';

  const lines: string[] = ['**Cost caps**', ''];
  lines.push(`- Billing mode: **${input.policy.billingMode}**`);
  lines.push(`- ${costMeaningForMode(input.policy.billingMode)}`);
  lines.push(
    `- Thresholds: task $${formatThresholdPair(input.policy.perTask.softUsd, input.policy.perTask.hardUsd)} · ` +
      `day $${formatThresholdPair(input.policy.daily.softUsd, input.policy.daily.hardUsd)}`,
  );
  lines.push(
    `- Enforced: task USD hard $${formatHardThreshold(input.policy.perTask.hardUsd)}; ` +
      `day USD hard $${formatHardThreshold(input.policy.daily.hardUsd)}`,
  );
  const tokenOverrides = formatTokenHardOverrides(input.policy);
  if (tokenOverrides.length > 0) {
    lines.push(`- Enforced override: ${tokenOverrides.join('; ')}`);
  }
  const advisoryTokenScopes = formatAdvisoryTokenScopes(input.policy);
  if (advisoryTokenScopes.length > 0) {
    lines.push(`- Advisory: ${advisoryTokenScopes.join(' and ')} token telemetry`);
  }
  if (input.policy.billingModeNote) {
    lines.push(`- Note: ${input.policy.billingModeNote}`);
  }
  if (input.runUsage) {
    const u = sanitizeUsage(input.runUsage);
    lines.push(
      `- This run: $${formatUsd(u.costUsd)} · ${formatTokens(totalTokens(u))} tokens ` +
        `(${formatTokens(u.inputTokens)} in / ${formatTokens(u.outputTokens)} out)`,
    );
  }
  const task = sanitizeUsage(input.taskUsage);
  const day = sanitizeUsage(input.dayUsage);
  lines.push(
    `- Task total: $${formatUsd(task.costUsd)} · ${formatTokens(totalTokens(task))} tokens`,
  );
  lines.push(
    `- Day (UTC) total: $${formatUsd(day.costUsd)} · ${formatTokens(totalTokens(day))} tokens`,
  );
  lines.push(`- Cap level: **${input.verdict.level}**`);
  if (input.verdict.reasons.length > 0) {
    for (const r of input.verdict.reasons) lines.push(`- ⚠ ${r}`);
  } else {
    lines.push('- Within configured soft/hard thresholds.');
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Mini-packet section when a hard cost cap stops a run.
 * Always parks as failed (retries would re-burn the same budget).
 */
export function buildCostCapFailureSection(input: {
  readonly stamp: string;
  readonly reasons: readonly string[];
  readonly taskUsage: UsageSample;
  readonly dayUsage: UsageSample;
  readonly attempt: number;
  readonly maxAttempts: number;
}): string {
  const task = sanitizeUsage(input.taskUsage);
  const day = sanitizeUsage(input.dayUsage);
  const reasonLines =
    input.reasons.length > 0
      ? input.reasons.map((r) => `- ${r}`)
      : ['- Hard cost cap or explicit token override exceeded.'];

  return [
    `## Cost cap (${input.stamp})`,
    '',
    '**Hard stop** — task parked in `failed` to prevent runaway spend.',
    `**Attempt:** ${input.attempt} / ${input.maxAttempts}`,
    '',
    '### Reasons',
    ...reasonLines,
    '',
    '### Spend',
    `- Task: $${formatUsd(task.costUsd)} · ${formatTokens(totalTokens(task))} tokens`,
    `- Day (UTC): $${formatUsd(day.costUsd)} · ${formatTokens(totalTokens(day))} tokens`,
    '',
    '### Next actions',
    '1. **Raise caps** via env (`HERCULES_TASK_COST_HARD_USD`, `HERCULES_DAY_COST_HARD_USD`, or an explicit `*_TOKENS_HARD` override) and restart',
    '2. **Retry** only after raising caps or clearing daily spend (new UTC day)',
    '3. **Steer** / salvage partial branch work without a full re-run',
    '',
  ].join('\n');
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '0.00';
  return n.toFixed(2);
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.floor(n));
}

/** Soft/hard pair for packet/Settings threshold lines (`∞` when unlimited). */
export function formatThresholdPair(
  soft: number | null,
  hard: number | null,
): string {
  const s = soft === null ? '∞' : formatUsd(soft);
  const h = hard === null ? '∞' : formatUsd(hard);
  return `${s}/${h}`;
}

function formatHardThreshold(value: number | null): string {
  return value === null ? '∞' : formatUsd(value);
}

function formatTokenHardOverrides(policy: CostCapsPolicy): string[] {
  const overrides: string[] = [];
  if (policy.perTask.hardTokens !== null) {
    overrides.push(`task tokens explicit hard override ${formatTokens(policy.perTask.hardTokens)}`);
  }
  if (policy.daily.hardTokens !== null) {
    overrides.push(`day tokens explicit hard override ${formatTokens(policy.daily.hardTokens)}`);
  }
  return overrides;
}

function formatAdvisoryTokenScopes(policy: CostCapsPolicy): string[] {
  const scopes: string[] = [];
  if (policy.perTask.hardTokens === null) scopes.push('task');
  if (policy.daily.hardTokens === null) scopes.push('day');
  return scopes;
}

function clampNonNegInt(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

function clampNonNegFinite(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, n);
}
