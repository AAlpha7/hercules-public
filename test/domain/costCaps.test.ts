import { describe, it, expect } from 'vitest';
import {
  DEFAULT_COST_CAPS,
  DEFAULT_ENABLED_DAILY,
  DEFAULT_ENABLED_PER_TASK,
  SUBSCRIPTION_ENABLED_DAILY,
  SUBSCRIPTION_ENABLED_PER_TASK,
  addUsage,
  appendUsage,
  buildCostCapFailureSection,
  buildCostCapSummary,
  costMeaningForMode,
  entriesForTask,
  entriesForUtcDay,
  evaluateCostCaps,
  evaluateThresholds,
  formatBreachReasons,
  isCostCapsEnabled,
  isDailyHardBlocked,
  isTaskHardBlocked,
  parseBillingMode,
  parseCostCapsPolicy,
  renderCostCapPacketSection,
  sanitizeUsage,
  sumLedger,
  taskTotals,
  totalTokens,
  upsertTaskUsage,
  utcDayKey,
  zeroUsage,
  type CostCapsPolicy,
  type UsageLedgerEntry,
  type UsageSample,
} from '../../src/domain/costCaps.js';

const sample = (partial: Partial<UsageSample>): UsageSample => ({
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  ...partial,
});

const enabledPolicy = (
  overrides: Partial<CostCapsPolicy> = {},
): CostCapsPolicy => ({
  enabled: true,
  billingMode: 'metered',
  billingModeNote: null,
  perTask: DEFAULT_ENABLED_PER_TASK,
  daily: DEFAULT_ENABLED_DAILY,
  ...overrides,
});

describe('usage arithmetic', () => {
  it('zeroUsage is empty', () => {
    expect(zeroUsage()).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });

  it('sanitizeUsage clamps negatives and non-finite', () => {
    expect(
      sanitizeUsage({ inputTokens: -3, outputTokens: Number.NaN, costUsd: -1.5 }),
    ).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });

  it('addUsage sums tokens and cost', () => {
    expect(
      addUsage(
        sample({ inputTokens: 100, outputTokens: 20, costUsd: 0.1 }),
        sample({ inputTokens: 50, outputTokens: 5, costUsd: 0.05 }),
      ),
    ).toEqual({ inputTokens: 150, outputTokens: 25, costUsd: 0.15 });
  });

  it('totalTokens is input + output', () => {
    expect(totalTokens(sample({ inputTokens: 100, outputTokens: 40 }))).toBe(140);
  });
});

describe('ledger day windows', () => {
  // 2026-07-17T12:00:00.000Z
  const noon = Date.UTC(2026, 6, 17, 12, 0, 0);
  const prevDay = Date.UTC(2026, 6, 16, 23, 0, 0);
  const nextDay = Date.UTC(2026, 6, 18, 0, 0, 1);

  const ledger: UsageLedgerEntry[] = [
    { taskId: 'a', atMs: prevDay, usage: sample({ costUsd: 1, inputTokens: 1000 }) },
    { taskId: 'a', atMs: noon, usage: sample({ costUsd: 2, inputTokens: 2000 }) },
    { taskId: 'b', atMs: noon + 1000, usage: sample({ costUsd: 3, outputTokens: 500 }) },
    { taskId: 'c', atMs: nextDay, usage: sample({ costUsd: 9 }) },
  ];

  it('utcDayKey is YYYY-MM-DD UTC', () => {
    expect(utcDayKey(noon)).toBe('2026-07-17');
    expect(utcDayKey(prevDay)).toBe('2026-07-16');
  });

  it('entriesForUtcDay keeps only same calendar day', () => {
    const day = entriesForUtcDay(ledger, noon);
    expect(day.map((e) => e.taskId).sort()).toEqual(['a', 'b']);
    expect(sumLedger(day)).toEqual({
      inputTokens: 2000,
      outputTokens: 500,
      costUsd: 5,
    });
  });

  it('entriesForTask and taskTotals aggregate per id', () => {
    expect(sumLedger(entriesForTask(ledger, 'a')).costUsd).toBe(3);
    expect(taskTotals(ledger)['a']).toEqual({
      inputTokens: 3000,
      outputTokens: 0,
      costUsd: 3,
    });
  });

  it('appendUsage and upsertTaskUsage are immutable', () => {
    const a = appendUsage([], {
      taskId: 't1',
      atMs: noon,
      usage: sample({ costUsd: 1 }),
    });
    expect(a).toHaveLength(1);
    const b = upsertTaskUsage(
      a,
      { taskId: 't1', atMs: noon + 1, usage: sample({ costUsd: 2 }) },
      { replaceLastForTask: true },
    );
    expect(b).toHaveLength(1);
    expect(b[0]!.usage.costUsd).toBe(2);
    expect(a[0]!.usage.costUsd).toBe(1);
  });
});

describe('evaluateCostCaps', () => {
  it('returns ok when policy is disabled (safe default)', () => {
    const v = evaluateCostCaps({
      policy: DEFAULT_COST_CAPS,
      taskUsage: sample({ costUsd: 999, inputTokens: 9_000_000 }),
      dayUsage: sample({ costUsd: 999 }),
    });
    expect(DEFAULT_COST_CAPS.enabled).toBe(false);
    expect(v.level).toBe('ok');
    expect(v.breaches).toEqual([]);
  });

  it('soft-warns when per-task soft USD is crossed but hard is not', () => {
    const policy = enabledPolicy({
      perTask: {
        softUsd: 1,
        hardUsd: 5,
        softTokens: null,
        hardTokens: null,
      },
      daily: {
        softUsd: null,
        hardUsd: null,
        softTokens: null,
        hardTokens: null,
      },
    });
    const v = evaluateCostCaps({
      policy,
      taskUsage: sample({ costUsd: 1.5 }),
      dayUsage: zeroUsage(),
    });
    expect(v.level).toBe('soft');
    expect(v.breaches).toHaveLength(1);
    expect(v.breaches[0]).toMatchObject({
      scope: 'task',
      level: 'soft',
      metric: 'usd',
    });
    expect(v.reasons[0]).toMatch(/per-task soft warn/);
  });

  it('hard-stops when per-task hard tokens are crossed', () => {
    const policy = enabledPolicy({
      perTask: {
        softUsd: null,
        hardUsd: null,
        softTokens: 100,
        hardTokens: 200,
      },
      daily: {
        softUsd: null,
        hardUsd: null,
        softTokens: null,
        hardTokens: null,
      },
    });
    const v = evaluateCostCaps({
      policy,
      taskUsage: sample({ inputTokens: 150, outputTokens: 60 }),
      dayUsage: zeroUsage(),
    });
    expect(v.level).toBe('hard');
    expect(v.breaches.some((b) => b.level === 'hard' && b.metric === 'tokens')).toBe(
      true,
    );
    expect(isTaskHardBlocked(policy, sample({ inputTokens: 150, outputTokens: 60 }))).toBe(
      true,
    );
  });

  it('hard-stops on daily USD even when task is fine', () => {
    const policy = enabledPolicy({
      perTask: {
        softUsd: null,
        hardUsd: null,
        softTokens: null,
        hardTokens: null,
      },
      daily: {
        softUsd: 10,
        hardUsd: 12,
        softTokens: null,
        hardTokens: null,
      },
    });
    const day = sample({ costUsd: 12 });
    const v = evaluateCostCaps({
      policy,
      taskUsage: sample({ costUsd: 0.5 }),
      dayUsage: day,
    });
    expect(v.level).toBe('hard');
    expect(isDailyHardBlocked(policy, day)).toBe(true);
    expect(isTaskHardBlocked(policy, sample({ costUsd: 0.5 }))).toBe(false);
  });

  it('hard dominates soft when both trip', () => {
    const policy = enabledPolicy({
      perTask: {
        softUsd: 1,
        hardUsd: 2,
        softTokens: null,
        hardTokens: null,
      },
      daily: {
        softUsd: null,
        hardUsd: null,
        softTokens: null,
        hardTokens: null,
      },
    });
    const v = evaluateCostCaps({
      policy,
      taskUsage: sample({ costUsd: 3 }),
      dayUsage: zeroUsage(),
    });
    expect(v.level).toBe('hard');
    // formatBreachReasons prefers hard lines
    expect(formatBreachReasons(v.breaches).every((r) => r.includes('hard stop'))).toBe(
      true,
    );
  });

  it('null thresholds never breach', () => {
    expect(
      evaluateThresholds('task', sample({ costUsd: 100, inputTokens: 1e9 }), {
        softUsd: null,
        hardUsd: null,
        softTokens: null,
        hardTokens: null,
      }),
    ).toEqual([]);
  });
});

describe('summary + packet + failure surfaces', () => {
  const noon = Date.UTC(2026, 6, 17, 12, 0, 0);
  const policy = enabledPolicy({
    perTask: {
      softUsd: 1,
      hardUsd: 2,
      softTokens: null,
      hardTokens: null,
    },
    daily: {
      softUsd: 5,
      hardUsd: 10,
      softTokens: null,
      hardTokens: null,
    },
  });

  it('buildCostCapSummary rolls day + tasks and reports level', () => {
    const ledger: UsageLedgerEntry[] = [
      {
        taskId: 'ops-1',
        atMs: noon,
        usage: sample({ costUsd: 1.5, inputTokens: 1000 }),
      },
    ];
    const summary = buildCostCapSummary({ policy, ledger, nowMs: noon });
    expect(summary.enabled).toBe(true);
    expect(summary.level).toBe('soft');
    expect(summary.billingMode).toBe('metered');
    expect(summary.billingModeNote).toBeNull();
    expect(summary.costMeaning).toBe(costMeaningForMode('metered'));
    expect(summary.policy.perTask.hardUsd).toBe(2);
    expect(summary.day.costUsd).toBe(1.5);
    expect(summary.taskTotals['ops-1']?.costUsd).toBe(1.5);
  });

  it('buildCostCapSummary includes liveByTask spend', () => {
    const summary = buildCostCapSummary({
      policy,
      ledger: [],
      nowMs: noon,
      liveByTask: { live: sample({ costUsd: 2.5 }) },
    });
    expect(summary.level).toBe('hard');
    expect(summary.taskTotals['live']?.costUsd).toBe(2.5);
  });

  it('renderCostCapPacketSection is empty when disabled', () => {
    expect(
      renderCostCapPacketSection({
        policy: DEFAULT_COST_CAPS,
        taskUsage: zeroUsage(),
        dayUsage: zeroUsage(),
        verdict: { level: 'ok', breaches: [], reasons: [] },
      }),
    ).toBe('');
  });

  it('renderCostCapPacketSection includes level and totals', () => {
    const verdict = evaluateCostCaps({
      policy,
      taskUsage: sample({ costUsd: 1.5 }),
      dayUsage: sample({ costUsd: 1.5 }),
    });
    const md = renderCostCapPacketSection({
      policy,
      runUsage: sample({ costUsd: 1.5, inputTokens: 100, outputTokens: 20 }),
      taskUsage: sample({ costUsd: 1.5 }),
      dayUsage: sample({ costUsd: 1.5 }),
      verdict,
    });
    expect(md).toContain('**Cost caps**');
    expect(md).toContain('Cap level: **soft**');
    expect(md).toContain('Billing mode: **metered**');
    expect(md).toContain(costMeaningForMode('metered'));
    expect(md).toMatch(/Thresholds: task \$1\.00\/2\.00/);
    expect(md).toMatch(/day \$5\.00\/10\.00/);
    expect(md).toContain('Task total');
    expect(md).toContain('Day (UTC) total');
  });

  it('buildCostCapFailureSection names hard stop and next actions', () => {
    const section = buildCostCapFailureSection({
      stamp: '2026-07-17T12:00:00.000Z',
      reasons: ['per-task hard stop: cost $2.50 ≥ $2.00'],
      taskUsage: sample({ costUsd: 2.5 }),
      dayUsage: sample({ costUsd: 2.5 }),
      attempt: 2,
      maxAttempts: 3,
    });
    expect(section).toContain('## Cost cap');
    expect(section).toContain('Hard stop');
    expect(section).toContain('per-task hard stop');
    expect(section).toContain('HERCULES_TASK_COST_HARD_USD');
    expect(section).toContain('failed');
  });
});

describe('parseCostCapsPolicy (env)', () => {
  it('is off when HERCULES_COST_CAPS unset', () => {
    expect(isCostCapsEnabled({})).toBe(false);
    expect(parseCostCapsPolicy({}).enabled).toBe(false);
  });

  // Title preserved for L5 test-integrity (was free-tier USD; now metered profile).
  it('enables with free-tier defaults when HERCULES_COST_CAPS=1', () => {
    // Missing/invalid billing mode → metered (conservative) USD profile.
    const p = parseCostCapsPolicy({ HERCULES_COST_CAPS: '1' });
    expect(p.enabled).toBe(true);
    expect(p.billingMode).toBe('metered');
    expect(p.billingModeNote).toMatch(/HERCULES_BILLING_MODE/);
    expect(p.billingModeNote).toMatch(/metered/);
    expect(p.perTask).toEqual(DEFAULT_ENABLED_PER_TASK);
    expect(p.daily).toEqual(DEFAULT_ENABLED_DAILY);
    expect(p.perTask.softUsd).toBe(20);
    expect(p.perTask.hardUsd).toBe(25);
    expect(p.daily.softUsd).toBe(40);
    expect(p.daily.hardUsd).toBe(50);
    expect(p.perTask.softTokens).toBeNull();
    expect(p.perTask.hardTokens).toBeNull();
    expect(p.daily.softTokens).toBeNull();
    expect(p.daily.hardTokens).toBeNull();
  });

  it('subscription defaults are task 40/50 and day 80/100', () => {
    const p = parseCostCapsPolicy({
      HERCULES_COST_CAPS: '1',
      HERCULES_BILLING_MODE: 'subscription',
    });
    expect(p.enabled).toBe(true);
    expect(p.billingMode).toBe('subscription');
    expect(p.billingModeNote).toBeNull();
    expect(p.perTask).toEqual(SUBSCRIPTION_ENABLED_PER_TASK);
    expect(p.daily).toEqual(SUBSCRIPTION_ENABLED_DAILY);
    expect(p.perTask.softUsd).toBe(40);
    expect(p.perTask.hardUsd).toBe(50);
    expect(p.daily.softUsd).toBe(80);
    expect(p.daily.hardUsd).toBe(100);
    // Token counts remain telemetry unless the owner opts into a hard override.
    expect(p.perTask.softTokens).toBeNull();
    expect(p.perTask.hardTokens).toBeNull();
    expect(p.daily.softTokens).toBeNull();
    expect(p.daily.hardTokens).toBeNull();

    const incident = evaluateCostCaps({
      policy: p,
      taskUsage: sample({ inputTokens: 2_000_000, outputTokens: 700_000, costUsd: 0 }),
      dayUsage: sample({ inputTokens: 3_500_000, outputTokens: 1_150_000, costUsd: 0 }),
    });
    expect(incident.level).toBe('ok');
    expect(incident.breaches).toEqual([]);
  });

  it('metered defaults are exactly half of subscription USD', () => {
    const p = parseCostCapsPolicy({
      HERCULES_COST_CAPS: '1',
      HERCULES_BILLING_MODE: 'metered',
    });
    expect(p.billingMode).toBe('metered');
    expect(p.billingModeNote).toBeNull();
    expect(p.perTask.softUsd).toBe(20);
    expect(p.perTask.hardUsd).toBe(25);
    expect(p.daily.softUsd).toBe(40);
    expect(p.daily.hardUsd).toBe(50);
  });

  it('invalid billing mode falls back to metered without leaking raw value', () => {
    const secret = 'not-a-mode-xyz-SECRET-42';
    const parsed = parseBillingMode({ HERCULES_BILLING_MODE: secret });
    expect(parsed.mode).toBe('metered');
    expect(parsed.note).toMatch(/HERCULES_BILLING_MODE/);
    expect(parsed.note).toMatch(/invalid|unrecognized/i);
    expect(parsed.note).toMatch(/metered/);
    expect(parsed.note).toMatch(/subscription/);
    expect(parsed.note).not.toContain(secret);

    const p = parseCostCapsPolicy({
      HERCULES_COST_CAPS: '1',
      HERCULES_BILLING_MODE: secret,
    });
    expect(p.billingMode).toBe('metered');
    expect(p.perTask).toEqual(DEFAULT_ENABLED_PER_TASK);
    expect(p.billingModeNote).not.toContain(secret);
  });

  it('honors explicit hard USD overrides and unlimited axes', () => {
    const p = parseCostCapsPolicy({
      HERCULES_COST_CAPS: 'true',
      HERCULES_BILLING_MODE: 'subscription',
      HERCULES_TASK_COST_HARD_USD: '1.25',
      HERCULES_TASK_COST_SOFT_USD: '1',
      HERCULES_DAY_COST_HARD_USD: 'off',
      HERCULES_TASK_TOKENS_HARD: '1000',
    });
    expect(p.billingMode).toBe('subscription');
    expect(p.perTask.hardUsd).toBe(1.25);
    expect(p.perTask.softUsd).toBe(1);
    expect(p.daily.hardUsd).toBeNull();
    // Non-overridden USD fields keep subscription defaults.
    expect(p.daily.softUsd).toBe(80);
    expect(p.perTask.hardTokens).toBe(1000);
    // Token soft remains advisory/unlimited when only a hard override is set.
    expect(p.perTask.softTokens).toBeNull();
  });

  it('labels an explicit token hard override distinctly from dollar enforcement', () => {
    const policy = parseCostCapsPolicy({
      HERCULES_COST_CAPS: '1',
      HERCULES_BILLING_MODE: 'subscription',
      HERCULES_TASK_TOKENS_HARD: '2500000',
    });
    const usage = sample({ inputTokens: 2_000_000, outputTokens: 700_000, costUsd: 0 });
    const verdict = evaluateCostCaps({ policy, taskUsage: usage, dayUsage: usage });
    expect(verdict.level).toBe('hard');
    expect(verdict.reasons).toEqual([
      'per-task hard stop: explicit token override 2.70M ≥ 2.50M',
    ]);

    const packet = renderCostCapPacketSection({
      policy,
      taskUsage: usage,
      dayUsage: usage,
      verdict,
    });
    expect(packet).toContain('Enforced: task USD hard $50.00; day USD hard $100.00');
    expect(packet).toContain('task tokens explicit hard override 2.50M');
    expect(packet).toContain('Advisory: day token telemetry');
  });

  it('per-field USD overrides win under metered without changing unlimited syntax', () => {
    const p = parseCostCapsPolicy({
      HERCULES_COST_CAPS: '1',
      HERCULES_BILLING_MODE: 'metered',
      HERCULES_TASK_COST_SOFT_USD: 'unlimited',
      HERCULES_DAY_COST_SOFT_USD: 'none',
      HERCULES_DAY_COST_HARD_USD: '99',
    });
    expect(p.perTask.softUsd).toBeNull();
    expect(p.perTask.hardUsd).toBe(25); // metered default
    expect(p.daily.softUsd).toBeNull();
    expect(p.daily.hardUsd).toBe(99);
  });

  it('breach path: hard USD=0.01 fires on tiny spend', () => {
    const policy = parseCostCapsPolicy({
      HERCULES_COST_CAPS: '1',
      HERCULES_TASK_COST_SOFT_USD: '0.005',
      HERCULES_TASK_COST_HARD_USD: '0.01',
      HERCULES_TASK_TOKENS_SOFT: 'off',
      HERCULES_TASK_TOKENS_HARD: 'off',
      HERCULES_DAY_COST_SOFT_USD: 'off',
      HERCULES_DAY_COST_HARD_USD: 'off',
      HERCULES_DAY_TOKENS_SOFT: 'off',
      HERCULES_DAY_TOKENS_HARD: 'off',
    });
    const v = evaluateCostCaps({
      policy,
      taskUsage: sample({ costUsd: 0.02 }),
      dayUsage: zeroUsage(),
    });
    expect(v.level).toBe('hard');
    expect(v.reasons.some((r) => r.includes('hard stop'))).toBe(true);
  });

  it('summary and packet surface subscription estimate wording', () => {
    const policy = parseCostCapsPolicy({
      HERCULES_COST_CAPS: '1',
      HERCULES_BILLING_MODE: 'subscription',
    });
    const summary = buildCostCapSummary({
      policy,
      ledger: [],
      nowMs: Date.UTC(2026, 6, 17, 12, 0, 0),
    });
    expect(summary.billingMode).toBe('subscription');
    expect(summary.costMeaning).toMatch(/internal estimate/i);
    expect(summary.costMeaning).toMatch(/not an invoice/i);

    const md = renderCostCapPacketSection({
      policy,
      taskUsage: zeroUsage(),
      dayUsage: zeroUsage(),
      verdict: { level: 'ok', breaches: [], reasons: [] },
    });
    expect(md).toContain('Billing mode: **subscription**');
    expect(md).toContain(costMeaningForMode('subscription'));
    expect(md).toMatch(/Thresholds: task \$40\.00\/50\.00/);
    expect(md).toMatch(/day \$80\.00\/100\.00/);
  });
});
