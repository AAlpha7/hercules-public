import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  DEFAULT_COST_LEDGER_RETAIN_DAYS,
  MAX_COST_LEDGER_BYTES,
  appendUsageReceipt,
  costLedgerDocumentIntegrity,
  costLedgerIntegrity,
  emptyCostLedger,
  parseCostLedger,
  pruneCostLedger,
  serializeCostLedger,
  unavailableCostLedgerDiagnostics,
  type CostLedger,
  type CostLedgerDiagnostics,
  type UsageReceipt,
} from '../domain/costLedger.js';

export const COST_LEDGER_FILENAME = 'cost-ledger.json';
const COST_LEDGER_TEMP_FILENAME = 'cost-ledger.json.tmp';
const COST_LEDGER_CLEAN_FILENAME = 'cost-ledger.clean';
const COST_LEDGER_DIRTY_FILENAME = 'cost-ledger.dirty';
const COST_LEDGER_MARKER_TEMP_FILENAME = 'cost-ledger.marker.tmp';
const COST_LEDGER_MARKER_VERSION = 2;
const PRIVATE_FILE_MODE = 0o600;

export class CostLedgerStoreError extends Error {
  override readonly name = 'CostLedgerStoreError';
  constructor(
    message: string,
    readonly code: 'io' | 'disk_full' | 'corrupt' | 'unavailable',
  ) {
    super(message);
  }
}

export interface CostLedgerFileOps {
  readonly mkdir: typeof mkdir;
  readonly readFile: typeof readFile;
  readonly writeFile: typeof writeFile;
  readonly rename: typeof rename;
  readonly unlink: typeof unlink;
  readonly chmod: typeof chmod;
  readonly syncFile: (path: string) => Promise<void>;
  readonly syncDirectory: (path: string) => Promise<void>;
}

export interface CostLedgerStoreOptions {
  readonly rootDir: string;
  readonly retainDays?: number;
  readonly clock?: () => number;
  readonly fileOps?: CostLedgerFileOps;
}

export type CostLedgerLoadResult =
  | { readonly ok: true; readonly ledger: CostLedger; readonly diagnostics: CostLedgerDiagnostics }
  | { readonly ok: false; readonly ledger: CostLedger; readonly diagnostics: CostLedgerDiagnostics };

function errorCode(error: unknown): string {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
}

function marker(integrity: string): string {
  return `${JSON.stringify({ version: COST_LEDGER_MARKER_VERSION, integrity })}\n`;
}

function transactionMarker(baseIntegrity: string, targetIntegrity: string): string {
  return `${JSON.stringify({
    version: COST_LEDGER_MARKER_VERSION,
    baseIntegrity,
    targetIntegrity,
  })}\n`;
}

function parseMarker(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    return item['version'] === COST_LEDGER_MARKER_VERSION &&
      typeof item['integrity'] === 'string' &&
      /^[0-9a-f]{64}$/.test(item['integrity'])
      ? item['integrity']
      : null;
  } catch {
    return null;
  }
}

function parseTransactionMarker(
  raw: string | null,
): { readonly baseIntegrity: string; readonly targetIntegrity: string } | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (
      item['version'] !== COST_LEDGER_MARKER_VERSION ||
      typeof item['baseIntegrity'] !== 'string' ||
      typeof item['targetIntegrity'] !== 'string' ||
      !/^[0-9a-f]{64}$/.test(item['baseIntegrity']) ||
      !/^[0-9a-f]{64}$/.test(item['targetIntegrity'])
    ) return null;
    return { baseIntegrity: item['baseIntegrity'], targetIntegrity: item['targetIntegrity'] };
  } catch {
    return null;
  }
}

export class CostLedgerStore {
  private readonly rootDir: string;
  private readonly retainDays: number;
  private readonly clock: () => number;
  private readonly fileOps: CostLedgerFileOps;
  private chain: Promise<void> = Promise.resolve();

  constructor(options: CostLedgerStoreOptions) {
    this.rootDir = options.rootDir;
    this.retainDays = options.retainDays ?? DEFAULT_COST_LEDGER_RETAIN_DAYS;
    this.clock = options.clock ?? (() => Date.now());
    this.fileOps = options.fileOps ?? CostLedgerStore.defaultFileOps();
  }

  static defaultFileOps(): CostLedgerFileOps {
    return {
      mkdir,
      readFile,
      writeFile,
      rename,
      unlink,
      chmod,
      syncFile: async (path) => {
        const handle = await open(path, 'r+');
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      },
      syncDirectory: async (path) => {
        const handle = await open(path, 'r');
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      },
    };
  }

  path(): string {
    return join(this.rootDir, COST_LEDGER_FILENAME);
  }

  private tempPath(): string { return join(this.rootDir, COST_LEDGER_TEMP_FILENAME); }
  private cleanPath(): string { return join(this.rootDir, COST_LEDGER_CLEAN_FILENAME); }
  private dirtyPath(): string { return join(this.rootDir, COST_LEDGER_DIRTY_FILENAME); }
  private markerTempPath(): string { return join(this.rootDir, COST_LEDGER_MARKER_TEMP_FILENAME); }

  private async readOptional(path: string): Promise<string | null> {
    try {
      return await this.fileOps.readFile(path, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
  }

  private unavailable(nowMs: number, note: string): CostLedgerLoadResult {
    return {
      ok: false,
      ledger: emptyCostLedger(),
      diagnostics: unavailableCostLedgerDiagnostics(nowMs, note),
    };
  }

  private async removeOptional(path: string): Promise<void> {
    try {
      await this.fileOps.unlink(path);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }

  private async writePrivate(path: string, data: string): Promise<void> {
    await this.fileOps.writeFile(path, data, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
    await this.fileOps.chmod(path, PRIVATE_FILE_MODE);
  }

  private parseRaw(raw: string | null, nowMs: number) {
    return parseCostLedger(raw, { nowMs, retainDays: this.retainDays });
  }

  private async installMarker(integrity: string): Promise<void> {
    const temp = this.markerTempPath();
    await this.writePrivate(temp, marker(integrity));
    await this.fileOps.syncFile(temp);
    await this.fileOps.rename(temp, this.cleanPath());
    await this.fileOps.syncDirectory(this.rootDir);
  }

  private async initialize(nowMs: number): Promise<CostLedgerLoadResult> {
    const ledger = { ...emptyCostLedger(), lastPersistedAtMs: nowMs };
    const temp = this.tempPath();
    await this.fileOps.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await this.writePrivate(temp, serializeCostLedger(ledger));
    await this.fileOps.syncFile(temp);
    await this.fileOps.rename(temp, this.path());
    await this.fileOps.syncDirectory(this.rootDir);
    await this.installMarker(costLedgerIntegrity(ledger));
    const parsed = this.parseRaw(serializeCostLedger(ledger), nowMs);
    if (parsed.kind === 'corrupt') throw new CostLedgerStoreError('Initialized ledger is invalid', 'corrupt');
    return {
      ok: true,
      ledger,
      diagnostics: {
        ...parsed.diagnostics,
        status: 'migrated',
        note: 'Initialized durable accounting from a genuine first-run empty state.',
      },
    };
  }

  private async loadInternal(allowDirtyRollback: boolean): Promise<CostLedgerLoadResult> {
    const nowMs = this.clock();
    try {
      await this.fileOps.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
      const [cleanRaw, dirtyRaw, ledgerRaw, tempRaw, markerTempRaw] = await Promise.all([
        this.readOptional(this.cleanPath()),
        this.readOptional(this.dirtyPath()),
        this.readOptional(this.path()),
        this.readOptional(this.tempPath()),
        this.readOptional(this.markerTempPath()),
      ]);
      if (cleanRaw === null && dirtyRaw === null) {
        if (ledgerRaw === null && tempRaw === null && markerTempRaw === null) {
          return await this.initialize(nowMs);
        }
        return this.unavailable(
          nowMs,
          'Cost ledger initialization witness is missing; current-day caps fail closed.',
        );
      }
      const parsed = this.parseRaw(ledgerRaw, nowMs);
      if (parsed.kind === 'corrupt' || parsed.kind === 'empty') {
        return parsed.kind === 'corrupt'
          ? { ok: false, ledger: emptyCostLedger(), diagnostics: parsed.diagnostics }
          : this.unavailable(nowMs, 'Initialized cost ledger data is missing; caps fail closed.');
      }
      const actualIntegrity = ledgerRaw === null ? null : costLedgerDocumentIntegrity(ledgerRaw);
      if (actualIntegrity === null) {
        return this.unavailable(nowMs, 'Cost ledger integrity is unavailable; caps fail closed.');
      }
      if (dirtyRaw !== null) {
        const transaction = parseTransactionMarker(dirtyRaw);
        const preTransactionIntegrity = parseMarker(dirtyRaw);
        if (transaction === null && preTransactionIntegrity !== null) {
          if (cleanRaw !== null || actualIntegrity !== preTransactionIntegrity) {
            return this.unavailable(nowMs, 'Cost ledger transaction witness is inconsistent; caps fail closed.');
          }
          if (!allowDirtyRollback) {
            return this.unavailable(
              nowMs,
              'Cost ledger transaction was interrupted before durable usage was proven; caps fail closed.',
            );
          }
          await this.fileOps.rename(this.dirtyPath(), this.cleanPath());
          await this.fileOps.syncDirectory(this.rootDir);
        } else if (transaction === null) {
          return this.unavailable(nowMs, 'Cost ledger transaction witness is corrupt; caps fail closed.');
        } else {
          const cleanIntegrity = parseMarker(cleanRaw);
          if (
            cleanRaw !== null &&
            cleanIntegrity !== transaction.baseIntegrity &&
            cleanIntegrity !== transaction.targetIntegrity
          ) {
            return this.unavailable(nowMs, 'Cost ledger transaction witness is inconsistent; caps fail closed.');
          }
          if (actualIntegrity === transaction.targetIntegrity) {
            if (cleanIntegrity !== actualIntegrity) await this.installMarker(actualIntegrity);
            await this.removeOptional(this.dirtyPath());
            await this.fileOps.syncDirectory(this.rootDir);
          } else if (actualIntegrity === transaction.baseIntegrity && !allowDirtyRollback) {
            return this.unavailable(
              nowMs,
              'Cost ledger transaction was interrupted before durable usage was proven; caps fail closed.',
            );
          } else if (actualIntegrity === transaction.baseIntegrity) {
            if (cleanIntegrity !== actualIntegrity) await this.installMarker(actualIntegrity);
            await this.removeOptional(this.dirtyPath());
            await this.fileOps.syncDirectory(this.rootDir);
          } else {
            return this.unavailable(nowMs, 'Cost ledger transaction does not bind its data; caps fail closed.');
          }
        }
      } else {
        const witnessIntegrity = parseMarker(cleanRaw);
        if (witnessIntegrity === null || actualIntegrity !== witnessIntegrity) {
          return this.unavailable(nowMs, 'Cost ledger does not match its integrity witness; caps fail closed.');
        }
      }
      await this.fileOps.chmod(this.path(), PRIVATE_FILE_MODE);
      await this.fileOps.chmod(this.cleanPath(), PRIVATE_FILE_MODE);
      await this.removeOptional(this.tempPath());
      await this.removeOptional(this.markerTempPath());
      await this.fileOps.syncDirectory(this.rootDir);
      return {
        ok: true,
        ledger: parsed.ledger,
        diagnostics: dirtyRaw === null
          ? parsed.diagnostics
          : {
              ...parsed.diagnostics,
              status: 'partial',
              note: 'Recovered an interrupted atomic cost-ledger transaction.',
            },
      };
    } catch {
      return this.unavailable(nowMs, 'Cost ledger recovery failed; current-day caps fail closed.');
    }
  }

  async load(): Promise<CostLedgerLoadResult> {
    return this.loadInternal(false);
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.chain;
    let release: () => void = () => undefined;
    this.chain = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async save(ledger: CostLedger): Promise<CostLedger> {
    return this.serialized(async () => {
      const loaded = await this.load();
      if (!loaded.ok) throw new CostLedgerStoreError('Cost ledger fail-closed', 'unavailable');
      return this.saveNow(ledger);
    });
  }

  private async saveNow(ledger: CostLedger): Promise<CostLedger> {
    const nowMs = this.clock();
    const pruned = pruneCostLedger(ledger, { nowMs, retainDays: this.retainDays });
    const next: CostLedger = { ...pruned.ledger, lastPersistedAtMs: nowMs };
    const nextRaw = serializeCostLedger(next);
    const path = this.path();
    try {
      const cleanRaw = await this.readOptional(this.cleanPath());
      const raw = await this.readOptional(path);
      const parsed = this.parseRaw(raw, nowMs);
      const cleanIntegrity = parseMarker(cleanRaw);
      if (cleanIntegrity === null || parsed.kind === 'corrupt' || parsed.kind === 'empty') {
        throw new CostLedgerStoreError('Cost ledger base is unavailable', 'unavailable');
      }
      if (raw === null || costLedgerDocumentIntegrity(raw) !== cleanIntegrity) {
        throw new CostLedgerStoreError('Cost ledger base integrity mismatch', 'corrupt');
      }
      const targetIntegrity = costLedgerIntegrity(next);
      await this.fileOps.rename(this.cleanPath(), this.dirtyPath());
      await this.fileOps.syncDirectory(dirname(path));
      await this.writePrivate(
        this.markerTempPath(),
        transactionMarker(cleanIntegrity, targetIntegrity),
      );
      await this.fileOps.syncFile(this.markerTempPath());
      await this.fileOps.rename(this.markerTempPath(), this.dirtyPath());
      await this.fileOps.syncDirectory(dirname(path));
      if (pruned.overflow || Buffer.byteLength(nextRaw, 'utf8') > MAX_COST_LEDGER_BYTES) {
        throw new CostLedgerStoreError(
          'Cost ledger cannot compact within its bound without losing usage',
          'unavailable',
        );
      }
      await this.writePrivate(this.tempPath(), nextRaw);
      await this.fileOps.syncFile(this.tempPath());
      await this.fileOps.rename(this.tempPath(), path);
      await this.fileOps.syncDirectory(dirname(path));
      await this.installMarker(targetIntegrity);
      await this.removeOptional(this.dirtyPath());
      await this.fileOps.syncDirectory(dirname(path));
      await this.fileOps.chmod(path, PRIVATE_FILE_MODE);
      return next;
    } catch (error) {
      if (error instanceof CostLedgerStoreError) throw error;
      if (errorCode(error) === 'ENOSPC') {
        throw new CostLedgerStoreError('Cost ledger write failed: disk full', 'disk_full');
      }
      throw new CostLedgerStoreError('Cost ledger atomic write failed', 'io');
    }
  }

  async appendReceipt(
    current: CostLedger,
    receipt: UsageReceipt,
  ): Promise<{ readonly ledger: CostLedger; readonly applied: boolean }> {
    return this.serialized(async () => {
      const loaded = await this.loadInternal(true);
      if (!loaded.ok) {
        throw new CostLedgerStoreError(
          'Cost ledger fail-closed; refusing a partial rewrite',
          loaded.diagnostics.status === 'corrupt' ? 'corrupt' : 'unavailable',
        );
      }
      let merged = loaded.ledger;
      let diskDelta = false;
      for (const existing of current.receipts) {
        const result = appendUsageReceipt(merged, existing);
        if (result.conflict) throw new CostLedgerStoreError('Conflicting in-memory cost receipt', 'corrupt');
        merged = result.ledger;
        diskDelta = diskDelta || result.applied;
      }
      const appended = appendUsageReceipt(merged, receipt);
      if (appended.conflict) throw new CostLedgerStoreError('Conflicting cost receipt replay', 'corrupt');
      // A duplicate is successful only after any prior disk-vs-memory delta is flushed.
      if (!appended.applied && !diskDelta) return { ledger: appended.ledger, applied: false };
      return { ledger: await this.saveNow(appended.ledger), applied: appended.applied };
    });
  }
}
