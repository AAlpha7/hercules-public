/** Durable merge-gate failure receipts (atomic write-then-rename). */
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isValidIdentifier } from '../domain/task.js';
import {
  isMergeFailureReceipt,
  type MergeFailureReceipt,
  publicMergeFailureReceipt,
} from '../domain/mergeFailureReceipt.js';

export class MergeFailureReceiptStoreError extends Error {
  override readonly name = 'MergeFailureReceiptStoreError';
}

export class MergeFailureReceiptStore {
  constructor(private readonly workRoot: string) {}
  private opsDir(): string { return join(this.workRoot, 'merge-receipts', 'ops'); }
  private byTaskDir(): string { return join(this.workRoot, 'merge-receipts', 'by-task'); }
  private opPath(id: string): string {
    if (!isValidIdentifier(id)) throw new MergeFailureReceiptStoreError('unsafe operation id');
    return join(this.opsDir(), id + '.json');
  }
  private taskPath(id: string): string {
    if (!isValidIdentifier(id)) throw new MergeFailureReceiptStoreError('unsafe task id');
    return join(this.byTaskDir(), id + '.json');
  }

  async persist(receipt: MergeFailureReceipt): Promise<void> {
    if (!isValidIdentifier(receipt.operationId)) throw new MergeFailureReceiptStoreError('unsafe operation id');
    await mkdir(this.opsDir(), { recursive: true });
    await mkdir(this.byTaskDir(), { recursive: true });
    const path = this.opPath(receipt.operationId);
    const tmp = path + '.tmp';
    await writeFile(tmp, JSON.stringify(publicMergeFailureReceipt(receipt), null, 2), 'utf8');
    await rename(tmp, path);
    for (const taskId of receipt.taskIds) {
      if (!isValidIdentifier(taskId)) continue;
      const tPath = this.taskPath(taskId);
      const tTmp = tPath + '.tmp';
      try {
        await writeFile(tTmp, JSON.stringify({ operationId: receipt.operationId, updatedAt: receipt.createdAt }), 'utf8');
        await rename(tTmp, tPath);
      } catch (err) {
        console.error('[hercules] merge-receipt pointer: ' + (err as Error).message);
      }
    }
  }

  async loadByOperationId(operationId: string): Promise<MergeFailureReceipt | null> {
    if (!isValidIdentifier(operationId)) return null;
    try {
      const raw = await readFile(this.opPath(operationId), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return isMergeFailureReceipt(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async loadByTaskId(taskId: string): Promise<MergeFailureReceipt | null> {
    if (!isValidIdentifier(taskId)) return null;
    try {
      const pointerRaw = await readFile(this.taskPath(taskId), 'utf8');
      const pointer = JSON.parse(pointerRaw) as { operationId?: unknown };
      if (typeof pointer.operationId === 'string') {
        const fromPtr = await this.loadByOperationId(pointer.operationId);
        if (fromPtr) return fromPtr;
      }
    } catch {
      // fall through
    }
    return this.scanForTask(taskId);
  }

  private async scanForTask(taskId: string): Promise<MergeFailureReceipt | null> {
    try {
      const names = await readdir(this.opsDir());
      let best: MergeFailureReceipt | null = null;
      for (const name of names) {
        if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
        try {
          const raw = await readFile(join(this.opsDir(), name), 'utf8');
          const parsed: unknown = JSON.parse(raw);
          if (!isMergeFailureReceipt(parsed) || !parsed.taskIds.includes(taskId)) continue;
          if (!best || parsed.createdAt > best.createdAt) best = parsed;
        } catch {
          // skip
        }
      }
      return best;
    } catch {
      return null;
    }
  }
}

export function newMergeFailureOperationId(nowMs = Date.now()): string {
  return 'mf-' + nowMs.toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
}
