import { describe, expect, it } from 'vitest';
import {
  COST_LEDGER_SCHEMA_VERSION,
  DEFAULT_COST_LEDGER_RETAIN_DAYS,
  appendUsageReceipt,
  makeUsageReceiptId,
  emptyCostLedger,
  parseCostLedger,
  pruneCostLedger,
  serializeCostLedger,
  type CostLedger,
  type UsageReceipt,
} from '../../src/domain/costLedger.js';

const today = Date.UTC(2026, 7, 4, 12);
const yesterday = Date.UTC(2026, 7, 3, 23);
const old = Date.UTC(2026, 6, 1, 12);

function receipt(
  runKey: string,
  taskId: string,
  atMs: number,
  costUsd: number,
): UsageReceipt {
  return {
    runKey,
    taskId,
    atMs,
    usage: { inputTokens: 10, outputTokens: 5, costUsd },
  };
}

describe('durable cost-ledger domain', () => {
  it('keeps completion time stable for exact and lower later replays', () => {
    const a = receipt('A-0-1722772800000', 'A', today, 1.25);
    const b = receipt('B-0-1722772801000', 'B', today + 1_000, 2.5);
    let ledger = appendUsageReceipt(emptyCostLedger(), b).ledger;
    ledger = appendUsageReceipt(ledger, a).ledger;
    const exactReplay = appendUsageReceipt(ledger, { ...a, atMs: today + 60_000 });
    const lowerReplay = appendUsageReceipt(exactReplay.ledger, {
      ...a,
      atMs: today + 120_000,
      usage: { inputTokens: 5, outputTokens: 2, costUsd: 1 },
    });

    expect(exactReplay.applied).toBe(false);
    expect(lowerReplay.applied).toBe(false);
    expect(lowerReplay.ledger.receipts).toHaveLength(2);
    expect(lowerReplay.ledger.receipts.find((item) => item.runKey === a.runKey)?.atMs).toBe(today);
    expect(lowerReplay.ledger.receipts.reduce((sum, item) => sum + item.usage.costUsd, 0)).toBe(
      3.75,
    );
  });

  it('binds every terminal path for one durable dispatch to the same receipt id', () => {
    const durableRunId = 'a4a1e0db-80c1-4c55-8bb7-dae28d980ae6';
    const fromDone = makeUsageReceiptId('A', durableRunId);
    const fromAbort = makeUsageReceiptId('A', durableRunId);
    const fromRecovery = makeUsageReceiptId('A', durableRunId);
    expect(new Set([fromDone, fromAbort, fromRecovery])).toEqual(new Set([fromDone]));
    expect(makeUsageReceiptId('A', 'f3c51b51-20e3-47ad-97a3-564fd75ad85b')).not.toBe(fromDone);
  });

  it('keeps the largest cumulative sample when usage events arrive out of order', () => {
    const runKey = 'A-0-1722772800000';
    const large: UsageReceipt = {
      ...receipt(runKey, 'A', today, 2),
      usage: { inputTokens: 50, outputTokens: 20, costUsd: 2 },
    };
    const small: UsageReceipt = {
      ...receipt(runKey, 'A', today + 1_000, 1),
      usage: { inputTokens: 25, outputTokens: 10, costUsd: 1 },
    };
    const first = appendUsageReceipt(emptyCostLedger(), small);
    const upgraded = appendUsageReceipt(first.ledger, large);
    const staleReplay = appendUsageReceipt(upgraded.ledger, small);
    expect(upgraded.applied).toBe(true);
    expect(staleReplay.applied).toBe(false);
    expect(staleReplay.ledger.receipts).toEqual([{ ...large, atMs: small.atMs }]);
  });

  it('fails closed rather than compacting away retained replay identities', () => {
    let ledger = emptyCostLedger();
    ledger = appendUsageReceipt(ledger, receipt('old-0-1', 'old', old, 9)).ledger;
    ledger = appendUsageReceipt(
      ledger,
      receipt('previous-0-1', 'previous', yesterday, 1),
    ).ledger;
    ledger = appendUsageReceipt(ledger, receipt('today-0-1', 'today', today, 2)).ledger;

    ledger = appendUsageReceipt(
      ledger,
      receipt('previous-0-2', 'previous', yesterday + 1, 3),
    ).ledger;
    const pruned = pruneCostLedger(ledger, { nowMs: today, retainDays: 2, maxReceipts: 2 });
    expect(pruned.overflow).toBe(true);
    expect(pruned.ledger.receipts).toHaveLength(3);
    expect(pruned.ledger.receipts.map((item) => item.runKey)).toEqual([
      'previous-0-1',
      'today-0-1',
      'previous-0-2',
    ]);
    expect(pruned.ledger.receipts.reduce((sum, item) => sum + item.usage.costUsd, 0)).toBe(6);
    expect(DEFAULT_COST_LEDGER_RETAIN_DAYS).toBeGreaterThanOrEqual(7);
    expect(DEFAULT_COST_LEDGER_RETAIN_DAYS).toBeLessThanOrEqual(90);
  });

  it('charges a larger cumulative replay to its later completion day, never backward', () => {
    const runKey = 'cross-midnight-run';
    const first = appendUsageReceipt(
      emptyCostLedger(),
      receipt(runKey, 'A', Date.UTC(2026, 7, 4, 23, 59), 1),
    );
    const replayed = appendUsageReceipt(first.ledger, {
      ...receipt(runKey, 'A', Date.UTC(2026, 7, 5, 0, 1), 2),
      usage: { inputTokens: 20, outputTokens: 10, costUsd: 2 },
    });
    const stale = appendUsageReceipt(
      replayed.ledger,
      receipt(runKey, 'A', Date.UTC(2026, 7, 4, 23, 58), 1),
    );

    expect(replayed.ledger.receipts[0]).toMatchObject({
      atMs: Date.UTC(2026, 7, 5, 0, 1),
      usage: { inputTokens: 20, outputTokens: 10, costUsd: 2 },
    });
    expect(stale.applied).toBe(false);
    expect(stale.ledger.receipts[0]?.atMs).toBe(Date.UTC(2026, 7, 5, 0, 1));
  });

  it('fails closed at the deterministic 5,000 current-day receipt boundary', () => {
    const receipts = Array.from({ length: 5_001 }, (_, index) =>
      receipt(`run-${index}`, 'today', today + index, 1),
    );
    const atBoundary = pruneCostLedger(
      { ...emptyCostLedger(), receipts: receipts.slice(0, 5_000) },
      { nowMs: today },
    );
    const overflow = pruneCostLedger(
      { ...emptyCostLedger(), receipts },
      { nowMs: today },
    );
    expect(atBoundary.overflow).toBe(false);
    expect(atBoundary.ledger.receipts).toHaveLength(5_000);
    expect(overflow.overflow).toBe(true);
    expect(overflow.ledger.receipts).toHaveLength(5_001);
    expect(overflow.ledger.receipts.reduce((sum, item) => sum + item.usage.costUsd, 0)).toBe(5_001);
  });

  it('round-trips only bounded accounting fields', () => {
    const ledger: CostLedger = {
      ...appendUsageReceipt(
        emptyCostLedger(),
        receipt('safe-task-0-1722772800000', 'safe-task', today, 1.25),
      ).ledger,
      lastPersistedAtMs: today,
    };
    const raw = serializeCostLedger(ledger);
    const parsed = parseCostLedger(raw, { nowMs: today });

    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(parsed.ledger.version).toBe(COST_LEDGER_SCHEMA_VERSION);
    expect(parsed.ledger.receipts).toEqual(ledger.receipts);
    expect(Object.keys(parsed.ledger.receipts[0]!).sort()).toEqual([
      'atMs',
      'runKey',
      'taskId',
      'usage',
    ]);
    expect(raw).not.toMatch(/prompt|credential|password|api[_-]?key|session|payload|outputText/i);
  });

  it('migrates a missing legacy ledger but fails closed on ambiguous damage', () => {
    const missing = parseCostLedger(null, { nowMs: today });
    expect(missing.kind).toBe('empty');
    expect(missing.diagnostics.failClosed).toBe(false);
    expect(missing.diagnostics.status).toBe('migrated');

    for (const raw of [
      '{broken',
      '[]',
      JSON.stringify({ version: 99, receipts: [], lastPersistedAtMs: today }),
      JSON.stringify({
        version: 1,
        receipts: [{ runKey: 'x', taskId: 'A', atMs: today, usage: null }],
        lastPersistedAtMs: today,
      }),
    ]) {
      const damaged = parseCostLedger(raw, { nowMs: today });
      expect(damaged.kind).toBe('corrupt');
      expect(damaged.diagnostics.failClosed).toBe(true);
      expect(damaged.diagnostics.note).not.toContain(raw);
    }
  });

  it('detects valid-looking accounting edits through the integrity checksum', () => {
    const raw = serializeCostLedger({
      ...appendUsageReceipt(emptyCostLedger(), receipt('run-1', 'A', today, 2)).ledger,
      lastPersistedAtMs: today,
    });
    const tampered = raw.replace('"costUsd": 2', '"costUsd": 1');
    const parsed = parseCostLedger(tampered, { nowMs: today });
    expect(parsed.kind).toBe('corrupt');
    expect(parsed.diagnostics.failClosed).toBe(true);
    expect(parsed.diagnostics.note).toMatch(/integrity/i);
  });

  it('drops explicitly historical invalid receipts but not current-day unknowns', () => {
    const raw = serializeCostLedger({
      version: COST_LEDGER_SCHEMA_VERSION,
      lastPersistedAtMs: today,
      receipts: [
        { runKey: 'bad-old', taskId: '../bad', atMs: old, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } },
        receipt('today-0-1', 'today', today, 2),
      ],
    });
    const parsed = parseCostLedger(raw, { nowMs: today });
    expect(parsed.kind).toBe('partial');
    if (parsed.kind !== 'partial') return;
    expect(parsed.diagnostics.failClosed).toBe(false);
    expect(parsed.ledger.receipts.map((item) => item.taskId)).toEqual(['today']);
  });
});
