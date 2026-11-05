/** Pure durable accounting model. Trusted-boundary IO lives in control/. */
import { createHash } from 'node:crypto';
import { isValidIdentifier } from './task.js';
import { sanitizeUsage, type UsageLedgerEntry, type UsageSample } from './costCaps.js';

export const COST_LEDGER_SCHEMA_VERSION = 1 as const;
export const DEFAULT_COST_LEDGER_RETAIN_DAYS = 14;
export const MAX_COST_LEDGER_RECEIPTS = 5_000;
export const MAX_COST_LEDGER_BYTES = 2_000_000;

export type CostLedgerStatus =
  | 'ok'
  | 'migrated'
  | 'partial'
  | 'corrupt'
  | 'unavailable'
  | 'memory';

export interface CostLedgerDiagnostics {
  readonly status: CostLedgerStatus;
  readonly receiptCount: number;
  readonly retainedDays: number;
  readonly lastPersistedAtMs: number | null;
  readonly recoveredAtMs: number | null;
  readonly note: string | null;
  readonly failClosed: boolean;
}

/** Stable daemon-owned dispatch key. It is not a provider session id. */
export interface UsageReceipt {
  readonly runKey: string;
  readonly taskId: string;
  /**
   * Latest terminal observation time for this dispatch. Usage is charged to
   * that UTC completion day; cumulative replays may move it forward, never
   * backward.
   */
  readonly atMs: number;
  readonly usage: UsageSample;
}

export interface CostLedger {
  readonly version: typeof COST_LEDGER_SCHEMA_VERSION;
  readonly receipts: readonly UsageReceipt[];
  readonly lastPersistedAtMs: number;
}

export interface PruneCostLedgerResult {
  readonly ledger: CostLedger;
  readonly removed: number;
  /** True means retained replay identities cannot fit the hard receipt bound. */
  readonly overflow: boolean;
}

export type ParseCostLedgerResult =
  | { readonly kind: 'ok'; readonly ledger: CostLedger; readonly diagnostics: CostLedgerDiagnostics }
  | {
      readonly kind: 'empty';
      readonly ledger: CostLedger;
      readonly diagnostics: CostLedgerDiagnostics;
    }
  | {
      readonly kind: 'partial';
      readonly ledger: CostLedger;
      readonly diagnostics: CostLedgerDiagnostics;
    }
  | { readonly kind: 'corrupt'; readonly diagnostics: CostLedgerDiagnostics };

export function emptyCostLedger(): CostLedger {
  return { version: COST_LEDGER_SCHEMA_VERSION, receipts: [], lastPersistedAtMs: 0 };
}

function validBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && isValidIdentifier(value);
}

export function isValidCostRunKey(value: unknown): value is string {
  return validBoundedIdentifier(value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseUsage(value: unknown): UsageSample | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    !finiteNonNegative(item['inputTokens']) ||
    !finiteNonNegative(item['outputTokens']) ||
    !finiteNonNegative(item['costUsd'])
  ) {
    return null;
  }
  return sanitizeUsage({
    inputTokens: item['inputTokens'],
    outputTokens: item['outputTokens'],
    costUsd: item['costUsd'],
  });
}

function parseReceipt(value: unknown): UsageReceipt | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (!isValidCostRunKey(item['runKey']) || !validBoundedIdentifier(item['taskId'])) return null;
  if (!finiteNonNegative(item['atMs'])) return null;
  const usage = parseUsage(item['usage']);
  if (!usage) return null;
  // Aggregation is deliberately unsupported: dropping original run identities
  // would make a later replay double-count usage.
  if (item['aggregate'] !== undefined) return null;
  return {
    runKey: item['runKey'],
    taskId: item['taskId'],
    atMs: Math.trunc(item['atMs']),
    usage,
  };
}

/** Stable receipt identity derived from the durable daemon run id, never a provider id. */
export function makeUsageReceiptId(taskId: string, durableRunId: string): string {
  return `r-${createHash('sha256').update(`${taskId}\0${durableRunId}`, 'utf8').digest('hex')}`;
}

function sameReceipt(left: UsageReceipt, right: UsageReceipt): boolean {
  return (
    left.runKey === right.runKey &&
    left.taskId === right.taskId &&
    left.atMs === right.atMs &&
    left.usage.inputTokens === right.usage.inputTokens &&
    left.usage.outputTokens === right.usage.outputTokens &&
    left.usage.costUsd === right.usage.costUsd
  );
}

export function appendUsageReceipt(
  ledger: CostLedger,
  rawReceipt: UsageReceipt,
): { readonly ledger: CostLedger; readonly applied: boolean; readonly conflict: boolean } {
  const receipt = parseReceipt(rawReceipt);
  if (!receipt) return { ledger, applied: false, conflict: true };
  const prior = ledger.receipts.find((item) => item.runKey === receipt.runKey);
  if (prior) {
    if (prior.taskId !== receipt.taskId) {
      return { ledger, applied: false, conflict: true };
    }
    const usage = sanitizeUsage({
      inputTokens: Math.max(prior.usage.inputTokens, receipt.usage.inputTokens),
      outputTokens: Math.max(prior.usage.outputTokens, receipt.usage.outputTokens),
      costUsd: Math.max(prior.usage.costUsd, receipt.usage.costUsd),
    });
    const usageIncreased =
      usage.inputTokens > prior.usage.inputTokens ||
      usage.outputTokens > prior.usage.outputTokens ||
      usage.costUsd > prior.usage.costUsd;
    if (!usageIncreased) return { ledger, applied: false, conflict: false };
    const atMs = Math.max(prior.atMs, receipt.atMs);
    return {
      applied: true,
      conflict: false,
      ledger: {
        ...ledger,
        receipts: ledger.receipts.map((item) =>
          item.runKey === receipt.runKey ? { ...item, atMs, usage } : item,
        ),
      },
    };
  }
  return {
    applied: true,
    conflict: false,
    ledger: { ...ledger, receipts: [...ledger.receipts, receipt] },
  };
}

function utcDayStart(atMs: number): number {
  const date = new Date(atMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function pruneCostLedger(
  ledger: CostLedger,
  options: { readonly nowMs: number; readonly retainDays?: number; readonly maxReceipts?: number },
): PruneCostLedgerResult {
  const retainDays = normalizePositive(options.retainDays, DEFAULT_COST_LEDGER_RETAIN_DAYS);
  const maxReceipts = normalizePositive(options.maxReceipts, MAX_COST_LEDGER_RECEIPTS);
  const cutoff = utcDayStart(options.nowMs) - (retainDays - 1) * 86_400_000;
  const retained = ledger.receipts.filter((item) => item.atMs >= cutoff);
  if (retained.length <= maxReceipts) {
    return {
      removed: ledger.receipts.length - retained.length,
      overflow: false,
      ledger: retained.length === ledger.receipts.length ? ledger : { ...ledger, receipts: retained },
    };
  }

  // Never aggregate away run identities. A sum-only aggregate is not replay
  // idempotent: an original receipt could later be appended beside its sum.
  // Expired whole receipts may be removed; any retained overflow fails closed
  // before persistence.
  return {
    removed: ledger.receipts.length - retained.length,
    overflow: true,
    ledger: { ...ledger, receipts: retained },
  };
}

function normalizePositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function diagnostics(input: {
  readonly status: CostLedgerStatus;
  readonly receiptCount: number;
  readonly retainDays: number;
  readonly lastPersistedAtMs: number | null;
  readonly recoveredAtMs: number | null;
  readonly note: string | null;
  readonly failClosed?: boolean;
}): CostLedgerDiagnostics {
  return {
    status: input.status,
    receiptCount: input.receiptCount,
    retainedDays: input.retainDays,
    lastPersistedAtMs: input.lastPersistedAtMs,
    recoveredAtMs: input.recoveredAtMs,
    note: input.note,
    failClosed:
      input.failClosed ?? (input.status === 'corrupt' || input.status === 'unavailable'),
  };
}

function corrupt(nowMs: number, retainDays: number, note: string): ParseCostLedgerResult {
  return {
    kind: 'corrupt',
    diagnostics: diagnostics({
      status: 'corrupt',
      receiptCount: 0,
      retainDays,
      lastPersistedAtMs: null,
      recoveredAtMs: nowMs,
      note,
    }),
  };
}

export function parseCostLedger(
  raw: string | null | undefined,
  options: { readonly nowMs: number; readonly retainDays?: number },
): ParseCostLedgerResult {
  const retainDays = normalizePositive(options.retainDays, DEFAULT_COST_LEDGER_RETAIN_DAYS);
  if (raw === null || raw === undefined || raw.trim() === '') {
    return {
      kind: 'empty',
      ledger: emptyCostLedger(),
      diagnostics: diagnostics({
        status: 'migrated',
        receiptCount: 0,
        retainDays,
        lastPersistedAtMs: null,
        recoveredAtMs: options.nowMs,
        note: 'No prior cost ledger; durable accounting starts with this boot.',
        failClosed: false,
      }),
    };
  }
  if (raw.length > MAX_COST_LEDGER_BYTES) {
    return corrupt(options.nowMs, retainDays, 'Cost ledger exceeds its bounded size; caps fail closed.');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return corrupt(options.nowMs, retainDays, 'Cost ledger JSON is corrupt; caps fail closed.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return corrupt(options.nowMs, retainDays, 'Cost ledger schema is invalid; caps fail closed.');
  }
  const document = value as Record<string, unknown>;
  if (
    document['version'] !== COST_LEDGER_SCHEMA_VERSION ||
    !Array.isArray(document['receipts']) ||
    document['receipts'].length > MAX_COST_LEDGER_RECEIPTS ||
    !finiteNonNegative(document['lastPersistedAtMs']) ||
    typeof document['integrity'] !== 'string' ||
    !/^[0-9a-f]{64}$/.test(document['integrity'])
  ) {
    return corrupt(options.nowMs, retainDays, 'Cost ledger schema is invalid; caps fail closed.');
  }
  const integrity = createHash('sha256')
    .update(
      JSON.stringify({
        version: document['version'],
        lastPersistedAtMs: document['lastPersistedAtMs'],
        receipts: document['receipts'],
      }),
      'utf8',
    )
    .digest('hex');
  if (integrity !== document['integrity']) {
    return corrupt(options.nowMs, retainDays, 'Cost ledger integrity check failed; caps fail closed.');
  }

  const todayStart = utcDayStart(options.nowMs);
  const tomorrowStart = todayStart + 86_400_000;
  const receipts: UsageReceipt[] = [];
  const byRun = new Map<string, UsageReceipt>();
  let historicalDamage = 0;
  for (const rawReceipt of document['receipts']) {
    const receipt = parseReceipt(rawReceipt);
    if (!receipt) {
      const item =
        rawReceipt !== null && typeof rawReceipt === 'object' && !Array.isArray(rawReceipt)
          ? (rawReceipt as Record<string, unknown>)
          : null;
      const atMs = item && finiteNonNegative(item['atMs']) ? item['atMs'] : null;
      if (item?.['aggregate'] !== undefined) {
        return corrupt(
          options.nowMs,
          retainDays,
          'Identity-losing aggregate cost receipt is unsupported; caps fail closed.',
        );
      }
      if (atMs === null || atMs >= todayStart) {
        return corrupt(
          options.nowMs,
          retainDays,
          'Current or undated cost receipt is corrupt; caps fail closed.',
        );
      }
      historicalDamage += 1;
      continue;
    }
    if (receipt.atMs >= tomorrowStart) {
      return corrupt(options.nowMs, retainDays, 'Future cost receipt is invalid; caps fail closed.');
    }
    const prior = byRun.get(receipt.runKey);
    if (prior) {
      if (!sameReceipt(prior, receipt)) {
        return corrupt(options.nowMs, retainDays, 'Conflicting cost receipts found; caps fail closed.');
      }
      continue;
    }
    byRun.set(receipt.runKey, receipt);
    receipts.push(receipt);
  }
  const lastPersistedAtMs = Math.trunc(document['lastPersistedAtMs']);
  const pruned = pruneCostLedger(
    { version: COST_LEDGER_SCHEMA_VERSION, receipts, lastPersistedAtMs },
    { nowMs: options.nowMs, retainDays },
  );
  if (pruned.overflow) {
    return corrupt(
      options.nowMs,
      retainDays,
      'Cost ledger receipt bound cannot be compacted losslessly; caps fail closed.',
    );
  }
  const partial = historicalDamage > 0 || pruned.removed > 0;
  return {
    kind: partial ? 'partial' : 'ok',
    ledger: pruned.ledger,
    diagnostics: diagnostics({
      status: partial ? 'partial' : 'ok',
      receiptCount: pruned.ledger.receipts.length,
      retainDays,
      lastPersistedAtMs: lastPersistedAtMs || null,
      recoveredAtMs: options.nowMs,
      note: partial
        ? 'Pruned expired or invalid historical receipts; current-day accounting recovered.'
        : null,
      failClosed: false,
    }),
  };
}

export function serializeCostLedger(ledger: CostLedger): string {
  const payload = {
    version: COST_LEDGER_SCHEMA_VERSION,
    lastPersistedAtMs: ledger.lastPersistedAtMs,
    receipts: ledger.receipts.map((receipt) => ({
        runKey: receipt.runKey,
        taskId: receipt.taskId,
        atMs: receipt.atMs,
        usage: {
          inputTokens: receipt.usage.inputTokens,
          outputTokens: receipt.usage.outputTokens,
          costUsd: receipt.usage.costUsd,
        },
      })),
  };
  const integrity = createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
  return `${JSON.stringify({ ...payload, integrity }, null, 2)}\n`;
}

export function costLedgerIntegrity(ledger: CostLedger): string {
  const parsed = JSON.parse(serializeCostLedger(ledger)) as { integrity: string };
  return parsed.integrity;
}

export function costLedgerDocumentIntegrity(raw: string): string | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const integrity = (value as Record<string, unknown>)['integrity'];
    return typeof integrity === 'string' && /^[0-9a-f]{64}$/.test(integrity) ? integrity : null;
  } catch {
    return null;
  }
}

export function receiptsToLedgerEntries(receipts: readonly UsageReceipt[]): UsageLedgerEntry[] {
  return receipts.map((receipt) => ({
    taskId: receipt.taskId,
    atMs: receipt.atMs,
    usage: sanitizeUsage(receipt.usage),
  }));
}

export function memoryCostLedgerDiagnostics(receiptCount: number): CostLedgerDiagnostics {
  return diagnostics({
    status: 'memory',
    receiptCount,
    retainDays: DEFAULT_COST_LEDGER_RETAIN_DAYS,
    lastPersistedAtMs: null,
    recoveredAtMs: null,
    note: 'No durable cost-ledger store is configured.',
    failClosed: false,
  });
}

export function unavailableCostLedgerDiagnostics(
  nowMs: number,
  note = 'Cost ledger is unavailable; current-day caps fail closed.',
): CostLedgerDiagnostics {
  return diagnostics({
    status: 'unavailable',
    receiptCount: 0,
    retainDays: DEFAULT_COST_LEDGER_RETAIN_DAYS,
    lastPersistedAtMs: null,
    recoveredAtMs: nowMs,
    note,
    failClosed: true,
  });
}
