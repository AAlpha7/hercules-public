import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MergeOperationStore } from '../../src/isolation/mergeOperationStore.js';
import type { MergeOperationRecord } from '../../src/domain/mergeOperation.js';

function sample(over: Partial<MergeOperationRecord> = {}): MergeOperationRecord {
  return {
    version: 1,
    operationId: 'mop-test-1-abcd',
    repoKey: 'app',
    taskIds: ['T-1', 'T-2'],
    idempotencyKey: 'idem-1',
    status: 'accepted',
    phase: 'accepted',
    mergedSha: null,
    failures: [],
    createdAtMs: 1000,
    updatedAtMs: 1000,
    gateProgress: null,
    failureKind: null,
    ownerPid: 42,
    ...over,
  };
}

describe('MergeOperationStore', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'h-mop-store-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips by id and idempotency key', async () => {
    const store = new MergeOperationStore(root);
    const rec = sample();
    await store.put(rec);
    expect(await store.get(rec.operationId)).toEqual(rec);
    const byKey = await store.getByIdempotencyKey('app', 'idem-1');
    expect(byKey?.operationId).toBe(rec.operationId);
    expect(byKey?.taskIds).toEqual(['T-1', 'T-2']);
    await store.put(sample({ operationId: 'mop-run-1-xx', status: 'running', phase: 'gating', idempotencyKey: 'k2' }));
    await store.put(sample({ operationId: 'mop-ok-1-yy', status: 'succeeded', phase: 'stamped', mergedSha: 'a'.repeat(40), idempotencyKey: 'k3' }));
    const active = await store.findActiveForRepo('app');
    expect(active?.status).toBe('running');
  });

  it('reconciles an operation record when its key index write was interrupted', async () => {
    const store = new MergeOperationStore(root);
    await store.put(sample());
    const digest = createHash('sha256')
      .update('app\0idem-1', 'utf8')
      .digest('hex')
      .slice(0, 32);
    await unlink(
      join(root, '.hercules-merge-ops', 'by-key', `app.${digest}.json`),
    );
    expect((await store.getByIdempotencyKey('app', 'idem-1'))?.operationId).toBe(
      'mop-test-1-abcd',
    );
  });

  it('rejects a succeeded durable record with a non-SHA mergedSha', async () => {
    const record = sample({
      status: 'succeeded',
      phase: 'stamped',
      mergedSha: 'not-a-commit',
    });
    const ops = join(root, '.hercules-merge-ops', 'ops');
    await mkdir(ops, { recursive: true });
    await writeFile(
      join(ops, `${record.operationId}.json`),
      JSON.stringify(record),
      'utf8',
    );

    await expect(new MergeOperationStore(root).get(record.operationId)).rejects.toThrow(
      /invalid merge operation mergedSha/,
    );
  });

  it('rejects succeeded records unless their phase is stamped', async () => {
    const record = sample({
      status: 'succeeded',
      phase: 'accepted',
      mergedSha: 'a'.repeat(40),
    });
    const store = new MergeOperationStore(root);
    await expect(store.put(record)).rejects.toThrow(
      /invalid succeeded merge operation phase/,
    );

    const ops = join(root, '.hercules-merge-ops', 'ops');
    await mkdir(ops, { recursive: true });
    await writeFile(
      join(ops, `${record.operationId}.json`),
      JSON.stringify(record),
      'utf8',
    );
    await expect(store.get(record.operationId)).rejects.toThrow(
      /invalid succeeded merge operation phase/,
    );
  });

  it.each([
    ['another repository', sample({ operationId: 'mop-other-repo', repoKey: 'other', idempotencyKey: 'idem-1' })],
    ['another idempotency key', sample({ operationId: 'mop-other-key', idempotencyKey: 'different-key' })],
  ])('rejects an idempotency index targeting %s', async (_label, target) => {
    const store = new MergeOperationStore(root);
    const requested = sample();
    await store.put(requested);
    await store.put(target);
    const digest = createHash('sha256')
      .update('app\0idem-1', 'utf8')
      .digest('hex')
      .slice(0, 32);
    await writeFile(
      join(root, '.hercules-merge-ops', 'by-key', `app.${digest}.json`),
      JSON.stringify({ operationId: target.operationId }),
      'utf8',
    );

    await expect(store.getByIdempotencyKey('app', 'idem-1')).rejects.toThrow(
      /idempotency index target mismatch/,
    );
  });
});
