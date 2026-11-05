import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMergeGateFailureReceipt } from '../../src/domain/mergeFailureReceipt.js';
import { MergeFailureReceiptStore, newMergeFailureOperationId } from '../../src/isolation/mergeFailureReceiptStore.js';

describe('MergeFailureReceiptStore', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'mf-receipt-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('persists and reloads after restart', async () => {
    const store = new MergeFailureReceiptStore(root);
    const receipt = buildMergeGateFailureReceipt({
      operationId: newMergeFailureOperationId(1700000000000),
      createdAt: '2026-08-03T12:00:00.000Z',
      repoKey: 'app',
      taskIds: ['T-1'],
      failedGate: 'test',
      exitStatus: 1,
      rawOutput: 'TOKEN=secret-xyz\nFAIL boom\n',
    });
    await store.persist(receipt);
    const reloaded = new MergeFailureReceiptStore(root);
    const byOp = await reloaded.loadByOperationId(receipt.operationId);
    expect(byOp?.failedGate).toBe('test');
    expect(byOp?.operationStatus).toBe('merge_gate_failed');
    expect(byOp?.exitStatus).toBe(1);
    expect(byOp?.remoteDefaultBranchChanged).toBe(false);
    expect(byOp?.verificationSucceeded).toBe(true);
    expect(byOp?.rawExcerpt).not.toMatch(/secret-xyz/);
    expect((await reloaded.loadByTaskId('T-1'))?.operationId).toBe(receipt.operationId);
  });
});
