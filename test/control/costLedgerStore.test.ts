import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COST_LEDGER_FILENAME,
  CostLedgerStore,
  CostLedgerStoreError,
  type CostLedgerFileOps,
} from '../../src/control/costLedgerStore.js';
import {
  MAX_COST_LEDGER_RECEIPTS,
  appendUsageReceipt,
  emptyCostLedger,
  makeUsageReceiptId,
  type UsageReceipt,
} from '../../src/domain/costLedger.js';

const now = Date.UTC(2026, 7, 4, 12);

function receipt(runKey: string, costUsd: number): UsageReceipt {
  return {
    runKey,
    taskId: runKey.startsWith('A') ? 'A' : 'B',
    atMs: now,
    usage: { inputTokens: 10, outputTokens: 5, costUsd },
  };
}

describe('CostLedgerStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hercules-cost-ledger-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function store(fileOps?: CostLedgerFileOps): CostLedgerStore {
    return new CostLedgerStore({ rootDir: dir, clock: () => now, ...(fileOps ? { fileOps } : {}) });
  }

  it('migrates missing state and round-trips durable totals', async () => {
    const first = store();
    const loaded = await first.load();
    expect(loaded.ok).toBe(true);
    expect(loaded.diagnostics.status).toBe('migrated');

    await first.appendReceipt(emptyCostLedger(), receipt('A-0-1722772800000', 1.5));
    const restarted = await store().load();
    expect(restarted.ok).toBe(true);
    expect(restarted.ledger.receipts).toHaveLength(1);
    expect(restarted.ledger.receipts[0]!.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 1.5,
    });
    expect(restarted.diagnostics.lastPersistedAtMs).toBe(now);
    expect(restarted.diagnostics.recoveredAtMs).toBe(now);
    expect((await stat(join(dir, COST_LEDGER_FILENAME))).mode & 0o777).toBe(0o600);
  });

  it('serializes concurrent updates and deduplicates a replay', async () => {
    const ledgerStore = store();
    const base = emptyCostLedger();
    await Promise.all([
      ledgerStore.appendReceipt(base, receipt('A-0-1722772800000', 1)),
      ledgerStore.appendReceipt(base, receipt('B-0-1722772801000', 2)),
      ledgerStore.appendReceipt(base, receipt('A-0-1722772800000', 1)),
    ]);

    const loaded = await ledgerStore.load();
    expect(loaded.ledger.receipts).toHaveLength(2);
    expect(loaded.ledger.receipts.reduce((sum, item) => sum + item.usage.costUsd, 0)).toBe(3);
  });

  it('fails closed after an atomic replacement tears before the new spend is durable', async () => {
    const first = store();
    await first.appendReceipt(emptyCostLedger(), receipt('A-0-1722772800000', 1));
    const realOps = CostLedgerStore.defaultFileOps();
    const torn = store({
      ...realOps,
      rename: async (from, to) => {
        if (String(from).endsWith('.json.tmp')) {
          throw Object.assign(new Error('injected rename fault'), { code: 'EIO' });
        }
        await realOps.rename(from, to);
      },
    });

    await expect(
      torn.appendReceipt((await torn.load()).ledger, receipt('B-0-1722772801000', 2)),
    ).rejects.toBeInstanceOf(CostLedgerStoreError);
    const recovered = await first.load();
    expect(recovered.ok).toBe(false);
    expect(recovered.diagnostics.failClosed).toBe(true);
    expect(recovered.diagnostics.note).toMatch(/interrupted/i);
    const authoritative = await readFile(join(dir, COST_LEDGER_FILENAME), 'utf8');
    expect(authoritative).toContain('A-0-1722772800000');
    expect(authoritative).not.toContain('B-0-1722772801000');
  });

  it('classifies disk-full and refuses to overwrite corrupt current-day state', async () => {
    await store().load();
    const realOps = CostLedgerStore.defaultFileOps();
    const full = store({
      ...realOps,
      writeFile: async () => {
        throw Object.assign(new Error('full'), { code: 'ENOSPC' });
      },
    });
    await expect(full.save(emptyCostLedger())).rejects.toMatchObject({ code: 'disk_full' });

    await writeFile(join(dir, COST_LEDGER_FILENAME), '{broken', 'utf8');
    const corrupt = store();
    const loaded = await corrupt.load();
    expect(loaded.ok).toBe(false);
    expect(loaded.diagnostics).toMatchObject({ status: 'corrupt', failClosed: true });
    await expect(
      corrupt.appendReceipt(emptyCostLedger(), receipt('A-0-1722772800000', 1)),
    ).rejects.toMatchObject({ code: 'corrupt' });
    expect(await readFile(join(dir, COST_LEDGER_FILENAME), 'utf8')).toBe('{broken');
  });

  it('heals a prior persist failure when the only next event is a duplicate replay', async () => {
    const healthy = store();
    await healthy.load();
    const base = await healthy.appendReceipt(emptyCostLedger(), receipt('A-run', 1));
    const second = receipt('B-run', 2);
    const memory = appendUsageReceipt(base.ledger, second).ledger;
    const realOps = CostLedgerStore.defaultFileOps();
    let failed = false;
    const failing = store({
      ...realOps,
      writeFile: async (path, data, options) => {
        if (!failed && String(path).endsWith('.json.tmp')) {
          failed = true;
          throw Object.assign(new Error('injected write failure'), { code: 'EIO' });
        }
        await realOps.writeFile(path, data, options);
      },
    });
    await expect(failing.appendReceipt(base.ledger, second)).rejects.toBeInstanceOf(
      CostLedgerStoreError,
    );

    const healed = await healthy.appendReceipt(memory, second);
    expect(healed.applied).toBe(false);
    expect(healed.ledger.receipts).toHaveLength(2);
    const restarted = await store().load();
    expect(restarted.ok).toBe(true);
    expect(restarted.ledger.receipts.reduce((sum, item) => sum + item.usage.costUsd, 0)).toBe(3);
  });

  it('fails closed when initialized ledger data disappears or is valid-looking but modified', async () => {
    const initialized = store();
    await initialized.load();
    await initialized.appendReceipt(emptyCostLedger(), receipt('A-run', 4));
    const path = join(dir, COST_LEDGER_FILENAME);
    const raw = await readFile(path, 'utf8');
    await unlink(path);
    const missing = await store().load();
    expect(missing.ok).toBe(false);
    expect(missing.diagnostics.note).toMatch(/missing/i);

    await writeFile(path, raw.replace('"costUsd": 4', '"costUsd": 0'), 'utf8');
    const tampered = await store().load();
    expect(tampered.ok).toBe(false);
    expect(tampered.diagnostics).toMatchObject({ status: 'corrupt', failClosed: true });
  });

  it('deduplicates multiple terminal samples across repeated restarts', async () => {
    const runKey = makeUsageReceiptId('A', 'a4a1e0db-80c1-4c55-8bb7-dae28d980ae6');
    const first = { ...receipt(runKey, 1), taskId: 'A' };
    await store().appendReceipt(emptyCostLedger(), first);
    const restarted = store();
    const loaded = await restarted.load();
    await restarted.appendReceipt(loaded.ledger, {
      ...first,
      atMs: now + 10_000,
      usage: { inputTokens: 20, outputTokens: 8, costUsd: 2.5 },
    });
    const afterUpgrade = await store().load();
    await store().appendReceipt(afterUpgrade.ledger, {
      ...first,
      atMs: now + 10_000,
      usage: { inputTokens: 20, outputTokens: 8, costUsd: 2.5 },
    });
    const replayed = await store().load();
    expect(replayed.ledger.receipts).toHaveLength(1);
    expect(replayed.ledger.receipts[0]?.usage).toEqual({
      inputTokens: 20,
      outputTokens: 8,
      costUsd: 2.5,
    });
    expect(replayed.ledger.receipts[0]?.atMs).toBe(now + 10_000);
  });

  it('attributes a larger post-restart replay to its current UTC completion day', async () => {
    let clockMs = Date.UTC(2026, 7, 4, 23, 59);
    const runKey = makeUsageReceiptId('A', 'f3c51b51-20e3-47ad-97a3-564fd75ad85b');
    const firstStore = new CostLedgerStore({ rootDir: dir, clock: () => clockMs });
    await firstStore.appendReceipt(emptyCostLedger(), {
      ...receipt(runKey, 1),
      taskId: 'A',
      atMs: clockMs,
    });

    clockMs = Date.UTC(2026, 7, 5, 0, 1);
    const restarted = new CostLedgerStore({ rootDir: dir, clock: () => clockMs });
    const recovered = await restarted.load();
    await restarted.appendReceipt(recovered.ledger, {
      ...receipt(runKey, 2),
      taskId: 'A',
      atMs: clockMs,
      usage: { inputTokens: 20, outputTokens: 10, costUsd: 2 },
    });

    const replayed = await new CostLedgerStore({ rootDir: dir, clock: () => clockMs }).load();
    expect(replayed.ok).toBe(true);
    expect(replayed.ledger.receipts).toHaveLength(1);
    expect(replayed.ledger.receipts[0]).toMatchObject({
      atMs: clockMs,
      usage: { inputTokens: 20, outputTokens: 10, costUsd: 2 },
    });
    const todayStart = Date.UTC(2026, 7, 5);
    expect(
      replayed.ledger.receipts
        .filter((item) => item.atMs >= todayStart)
        .reduce((sum, item) => sum + item.usage.costUsd, 0),
    ).toBe(2);
  });

  it('fails closed before prior-day receipts can overflow the durable identity bound', async () => {
    const ledgerStore = store();
    await ledgerStore.load();
    const overflowing = {
      ...emptyCostLedger(),
      receipts: Array.from({ length: MAX_COST_LEDGER_RECEIPTS + 1 }, (_, index) => ({
        ...receipt(`A-${index}`, 1),
        taskId: 'A',
        atMs: now - 86_400_000 + index,
      })),
    };

    await expect(ledgerStore.save(overflowing)).rejects.toMatchObject({ code: 'unavailable' });
    const restarted = await store().load();
    expect(restarted.ok).toBe(false);
    expect(restarted.diagnostics.failClosed).toBe(true);
    const raw = await readFile(join(dir, COST_LEDGER_FILENAME), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ receipts: [] });
  });

  it('never silently resets spend across faults before and after each durability boundary', async () => {
    const stages = [
      'write-before',
      'write-after',
      'sync-before',
      'sync-after',
      'rename-before',
      'rename-after',
      'directory-before',
      'directory-after',
    ] as const;
    for (const stage of stages) {
      const caseDir = await mkdtemp(join(tmpdir(), `hercules-ledger-${stage}-`));
      try {
        const baseStore = new CostLedgerStore({ rootDir: caseDir, clock: () => now });
        const initialized = await baseStore.load();
        const base = await baseStore.appendReceipt(initialized.ledger, receipt('A-run', 1));
        const next = receipt('B-run', 2);
        const memory = appendUsageReceipt(base.ledger, next).ledger;
        const real = CostLedgerStore.defaultFileOps();
        let injected = false;
        let directorySyncs = 0;
        const shouldInject = (operation: string, phase: 'before' | 'after'): boolean => {
          if (injected || stage !== `${operation}-${phase}`) return false;
          injected = true;
          return true;
        };
        const ops: CostLedgerFileOps = {
          ...real,
          writeFile: async (path, data, options) => {
            const target = String(path).endsWith('.json.tmp');
            if (target && shouldInject('write', 'before')) throw Object.assign(new Error(stage), { code: 'EIO' });
            await real.writeFile(path, data, options);
            if (target && shouldInject('write', 'after')) throw Object.assign(new Error(stage), { code: 'EIO' });
          },
          syncFile: async (path) => {
            const target = String(path).endsWith('.json.tmp');
            if (target && shouldInject('sync', 'before')) throw Object.assign(new Error(stage), { code: 'EIO' });
            await real.syncFile(path);
            if (target && shouldInject('sync', 'after')) throw Object.assign(new Error(stage), { code: 'EIO' });
          },
          rename: async (from, to) => {
            const target = String(from).endsWith('.json.tmp');
            if (target && shouldInject('rename', 'before')) throw Object.assign(new Error(stage), { code: 'EIO' });
            await real.rename(from, to);
            if (target && shouldInject('rename', 'after')) throw Object.assign(new Error(stage), { code: 'EIO' });
          },
          syncDirectory: async (path) => {
            directorySyncs += 1;
            const target = directorySyncs === 3;
            if (target && shouldInject('directory', 'before')) throw Object.assign(new Error(stage), { code: 'EIO' });
            await real.syncDirectory(path);
            if (target && shouldInject('directory', 'after')) throw Object.assign(new Error(stage), { code: 'EIO' });
          },
        };
        const failing = new CostLedgerStore({ rootDir: caseDir, clock: () => now, fileOps: ops });
        await expect(failing.appendReceipt(base.ledger, next), stage).rejects.toBeInstanceOf(
          CostLedgerStoreError,
        );
        expect(injected, stage).toBe(true);

        const afterCrash = await new CostLedgerStore({ rootDir: caseDir, clock: () => now }).load();
        if (afterCrash.ok) {
          expect(
            afterCrash.ledger.receipts.reduce((sum, item) => sum + item.usage.costUsd, 0),
            stage,
          ).toBe(3);
        } else {
          expect(afterCrash.diagnostics.failClosed, stage).toBe(true);
        }

        const healer = new CostLedgerStore({ rootDir: caseDir, clock: () => now });
        const healed = await healer.appendReceipt(memory, next);
        expect(healed.ledger.receipts.reduce((sum, item) => sum + item.usage.costUsd, 0), stage).toBe(3);
        const restarted = await new CostLedgerStore({ rootDir: caseDir, clock: () => now }).load();
        expect(restarted.ok, stage).toBe(true);
        expect(restarted.ledger.receipts.reduce((sum, item) => sum + item.usage.costUsd, 0), stage).toBe(3);
      } finally {
        await rm(caseDir, { recursive: true, force: true });
      }
    }
  });
});
