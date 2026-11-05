import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PathLeaseStoreError,
  TaskPathLeaseStore,
} from '../../src/isolation/taskPathLeaseStore.js';

const BASE = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

async function tempStore(
  alive: (pid: number) => boolean | null = () => false,
): Promise<TaskPathLeaseStore> {
  const root = await mkdtemp(join(tmpdir(), 'hercules-path-lease-'));
  return new TaskPathLeaseStore(root, {
    readProcessIdentity: (pid) => ({
      pid,
      startTimeTicks: String(pid * 10),
      bootId: '12345678-1234-1234-1234-123456789abc',
    }),
    processGroupIdentityAlive: (identity) => alive(identity.pid),
    unboundOwnerAlive: (_repoKey, entry) => alive(entry.taskId.length),
  });
}

describe('TaskPathLeaseStore', () => {
  it('atomically acquires, rejects overlap, and releases only for owner token', async () => {
    const store = await tempStore((pid) => pid === 101);
    const a = await store.acquire('app', {
      taskId: 'T1',
      runToken: 'tok-1',
      declaredBaseRevision: BASE,
      declaredPaths: ['src/a.ts'],
      declaredProtectedSnapshot: [],
      trustedBaseRevision: BASE,
      currentProtectedPaths: [],
      maxWriters: 2,
      requireDeclarations: true,
      acquiredAtMs: 1,
    });
    expect(a.ok).toBe(true);

    const overlap = await store.acquire('app', {
      taskId: 'T2',
      runToken: 'tok-2',
      declaredBaseRevision: BASE,
      declaredPaths: ['src/'],
      declaredProtectedSnapshot: [],
      trustedBaseRevision: BASE,
      currentProtectedPaths: [],
      maxWriters: 2,
      requireDeclarations: true,
      acquiredAtMs: 2,
    });
    expect(overlap).toMatchObject({ ok: false, reason: 'path_overlap' });

    const steal = await store.release('app', 'T1', 'wrong-token');
    expect(steal).toMatchObject({ ok: false, reason: 'token_mismatch' });
    expect(await store.list('app')).toHaveLength(1);

    const rel = await store.release('app', 'T1', 'tok-1');
    expect(rel.ok).toBe(true);
    expect(await store.list('app')).toEqual([]);
  });

  it('reclaims stale owners after crash without stealing live tokens', async () => {
    const store = await tempStore();
    await store.acquire('app', {
      taskId: 'LIVE',
      runToken: 'live',
      declaredBaseRevision: BASE,
      declaredPaths: ['src/a.ts'],
      declaredProtectedSnapshot: [],
      trustedBaseRevision: BASE,
      currentProtectedPaths: [],
      maxWriters: 2,
      requireDeclarations: true,
      acquiredAtMs: 1,
    });
    expect((await store.bindOwnerProcess('app', 'LIVE', 'live', 101)).ok).toBe(true);
    await store.acquire('app', {
      taskId: 'DEAD',
      runToken: 'dead',
      declaredBaseRevision: BASE,
      declaredPaths: ['docs/x.md'],
      declaredProtectedSnapshot: [],
      trustedBaseRevision: BASE,
      currentProtectedPaths: [],
      maxWriters: 2,
      requireDeclarations: true,
      acquiredAtMs: 2,
    });
    expect((await store.bindOwnerProcess('app', 'DEAD', 'dead', 202)).ok).toBe(true);

    const r = await store.reclaimStale('app', new Set(['live']));
    expect(r.reclaimed.map((e) => e.taskId)).toEqual(['DEAD']);
    const held = await store.list('app');
    expect(held.map((e) => e.taskId)).toEqual(['LIVE']);
  });

  it('serializes concurrent acquires so only one writer wins an exclusive scope', async () => {
    const store = await tempStore();
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        store.acquire('app', {
          taskId: `T${n}`,
          runToken: `tok-${n}`,
          declaredBaseRevision: BASE,
          declaredPaths: ['src/shared.ts'],
          declaredProtectedSnapshot: [],
          trustedBaseRevision: BASE,
          currentProtectedPaths: [],
          maxWriters: 4,
          requireDeclarations: true,
          acquiredAtMs: n,
        }),
      ),
    );
    const ok = results.filter((r) => r.ok);
    const blocked = results.filter((r) => !r.ok);
    expect(ok).toHaveLength(1);
    expect(blocked).toHaveLength(3);
    expect(blocked.every((r) => !r.ok && r.reason === 'path_overlap')).toBe(true);
    expect(await store.list('app')).toHaveLength(1);
  });

  it('persists durable JSON under the work root', async () => {
    const store = await tempStore();
    await store.acquire('app', {
      taskId: 'T1',
      runToken: 'tok-1',
      declaredBaseRevision: BASE,
      declaredPaths: ['src/a.ts'],
      declaredProtectedSnapshot: ['WORKFLOW.md'],
      trustedBaseRevision: BASE,
      currentProtectedPaths: ['WORKFLOW.md'],
      maxWriters: 1,
      requireDeclarations: true,
      acquiredAtMs: 1,
    });
    const raw = await readFile(
      join(store.workRoot, '.hercules-path-leases', 'app.json'),
      'utf8',
    );
    expect(raw).toMatch(/"taskId": "T1"/);
    expect(raw).toMatch(/src\/a\.ts/);
  });

  it('blocks stale base and does not write a lease', async () => {
    const store = await tempStore();
    const v = await store.acquire('app', {
      taskId: 'T1',
      runToken: 'tok-1',
      declaredBaseRevision: BASE,
      declaredPaths: ['src/a.ts'],
      declaredProtectedSnapshot: [],
      trustedBaseRevision: OTHER,
      currentProtectedPaths: [],
      maxWriters: 1,
      requireDeclarations: true,
      acquiredAtMs: 1,
    });
    expect(v).toMatchObject({ ok: false, reason: 'stale_base' });
    expect(await store.list('app')).toEqual([]);
  });

  it('keeps unknown owners fail-closed after restart', async () => {
    const store = await tempStore(() => null);
    await store.acquire('app', {
      taskId: 'UNKNOWN',
      runToken: 'unknown',
      declaredBaseRevision: BASE,
      declaredPaths: ['src/a.ts'],
      declaredProtectedSnapshot: [],
      trustedBaseRevision: BASE,
      currentProtectedPaths: [],
      maxWriters: 1,
      requireDeclarations: true,
      acquiredAtMs: 1,
    });
    const result = await store.reclaimStale('app', new Set());
    expect(result.reclaimed).toEqual([]);
    expect(result.uncertain.map((entry) => entry.taskId)).toEqual(['UNKNOWN']);
    expect(await store.list('app')).toHaveLength(1);
  });

  it('does not release a terminal leader while its detached process group is alive', async () => {
    let groupAlive: boolean | null = true;
    const store = await tempStore(() => groupAlive);
    await store.acquire('app', {
      taskId: 'GROUP', runToken: 'group-token', declaredBaseRevision: BASE,
      declaredPaths: ['src/a.ts'], declaredProtectedSnapshot: [], trustedBaseRevision: BASE,
      currentProtectedPaths: [], maxWriters: 1, requireDeclarations: true, acquiredAtMs: 1,
    });
    await store.bindOwnerProcess('app', 'GROUP', 'group-token', 101);

    await expect(store.releaseIfOwnerDead('app', 'GROUP', 'group-token')).resolves.toEqual({
      ok: true,
      released: false,
      ownerState: 'alive',
    });
    expect(await store.list('app')).toHaveLength(1);
    groupAlive = null;
    await expect(store.releaseIfOwnerDead('app', 'GROUP', 'group-token')).resolves.toEqual({
      ok: true,
      released: false,
      ownerState: 'unknown',
    });
    groupAlive = false;
    await expect(store.releaseIfOwnerDead('app', 'GROUP', 'group-token')).resolves.toEqual({
      ok: true,
      released: true,
      ownerState: 'dead',
    });
    expect(await store.list('app')).toEqual([]);
  });

  it('keeps a bound lease when a task-marked writer escaped the original group', async () => {
    let originalGroupAlive: boolean | null = false;
    let markedWriterAlive: boolean | null = true;
    const root = await mkdtemp(join(tmpdir(), 'hercules-path-lease-detached-'));
    const store = new TaskPathLeaseStore(root, {
      readProcessIdentity: (pid) => ({
        pid,
        startTimeTicks: String(pid * 10),
        bootId: '12345678-1234-1234-1234-123456789abc',
      }),
      processGroupIdentityAlive: () => originalGroupAlive,
      unboundOwnerAlive: () => markedWriterAlive,
    });
    await store.acquire('app', {
      taskId: 'DETACHED', runToken: 'detached-token', declaredBaseRevision: BASE,
      declaredPaths: ['src/a.ts'], declaredProtectedSnapshot: [], trustedBaseRevision: BASE,
      currentProtectedPaths: [], maxWriters: 1, requireDeclarations: true, acquiredAtMs: 1,
    });
    await store.bindOwnerProcess('app', 'DETACHED', 'detached-token', 101);

    await expect(
      store.releaseIfOwnerDead('app', 'DETACHED', 'detached-token'),
    ).resolves.toMatchObject({ ok: true, released: false, ownerState: 'alive' });
    expect((await store.reclaimStale('app', new Set())).reclaimed).toEqual([]);

    // Bound group dead + proven marked writer still holds (escaped descendant).
    originalGroupAlive = false;
    markedWriterAlive = true;
    await expect(
      store.releaseIfOwnerDead('app', 'DETACHED', 'detached-token'),
    ).resolves.toMatchObject({ ok: true, released: false, ownerState: 'alive' });

    // Bound group dead + unrelated /proc uncertainty (marker null) must release
    // — do not let inaccessible foreign /proc entries poison reclaim forever.
    markedWriterAlive = null;
    await expect(
      store.releaseIfOwnerDead('app', 'DETACHED', 'detached-token'),
    ).resolves.toMatchObject({ ok: true, released: true, ownerState: 'dead' });
    expect(await store.list('app')).toEqual([]);

    // Re-acquire to prove proven-dead marker path still releases.
    await store.acquire('app', {
      taskId: 'DETACHED', runToken: 'detached-token-2', declaredBaseRevision: BASE,
      declaredPaths: ['src/a.ts'], declaredProtectedSnapshot: [], trustedBaseRevision: BASE,
      currentProtectedPaths: [], maxWriters: 1, requireDeclarations: true, acquiredAtMs: 2,
    });
    await store.bindOwnerProcess('app', 'DETACHED', 'detached-token-2', 102);
    originalGroupAlive = false;
    markedWriterAlive = false;
    await expect(
      store.releaseIfOwnerDead('app', 'DETACHED', 'detached-token-2'),
    ).resolves.toMatchObject({ ok: true, released: true, ownerState: 'dead' });
  });

  it('releases dead bound PID when unrelated /proc scan is unknown (incident regression)', async () => {
    let groupAlive: boolean | null = false;
    let markerAlive: boolean | null = null; // unrelated inaccessible /proc
    const root = await mkdtemp(join(tmpdir(), 'hercules-path-lease-poison-'));
    const store = new TaskPathLeaseStore(root, {
      readProcessIdentity: (pid) => ({
        pid,
        startTimeTicks: String(pid * 10),
        bootId: '12345678-1234-1234-1234-123456789abc',
      }),
      processGroupIdentityAlive: () => groupAlive,
      unboundOwnerAlive: () => markerAlive,
    });
    await store.acquire('app', {
      taskId: 'POISON',
      runToken: 'poison-token',
      declaredBaseRevision: BASE,
      declaredPaths: ['src/a.ts'],
      declaredProtectedSnapshot: [],
      trustedBaseRevision: BASE,
      currentProtectedPaths: [],
      maxWriters: 1,
      requireDeclarations: true,
      acquiredAtMs: 1,
    });
    await store.bindOwnerProcess('app', 'POISON', 'poison-token', 4242);

    // Exact bound PID dead + marker scan null → release (not fail-closed forever).
    await expect(
      store.releaseIfOwnerDead('app', 'POISON', 'poison-token'),
    ).resolves.toEqual({ ok: true, released: true, ownerState: 'dead' });
    expect(await store.list('app')).toEqual([]);

    // Token mismatch stays held / not releasable.
    await store.acquire('app', {
      taskId: 'POISON',
      runToken: 'poison-token-2',
      declaredBaseRevision: BASE,
      declaredPaths: ['src/a.ts'],
      declaredProtectedSnapshot: [],
      trustedBaseRevision: BASE,
      currentProtectedPaths: [],
      maxWriters: 1,
      requireDeclarations: true,
      acquiredAtMs: 2,
    });
    await store.bindOwnerProcess('app', 'POISON', 'poison-token-2', 4243);
    groupAlive = false;
    markerAlive = null;
    await expect(
      store.releaseIfOwnerDead('app', 'POISON', 'wrong-token'),
    ).resolves.toMatchObject({ ok: false, reason: 'token_mismatch' });
    expect(await store.list('app')).toHaveLength(1);

    // Live owner stays held.
    groupAlive = true;
    await expect(
      store.releaseIfOwnerDead('app', 'POISON', 'poison-token-2'),
    ).resolves.toMatchObject({ ok: true, released: false, ownerState: 'alive' });

    // Genuinely unknown bound group stays fail-closed.
    groupAlive = null;
    markerAlive = null;
    await expect(
      store.releaseIfOwnerDead('app', 'POISON', 'poison-token-2'),
    ).resolves.toMatchObject({ ok: true, released: false, ownerState: 'unknown' });
    expect((await store.reclaimStale('app', new Set())).reclaimed).toEqual([]);
    expect(await store.list('app')).toHaveLength(1);
  });

  it('prepares replacement only after both prior owner proofs are dead', async () => {
    let priorGroupAlive: boolean | null = true;
    let markedWriterAlive: boolean | null = false;
    const root = await mkdtemp(join(tmpdir(), 'hercules-path-lease-rebind-'));
    const store = new TaskPathLeaseStore(root, {
      readProcessIdentity: (pid) => ({
        pid,
        startTimeTicks: String(pid * 10),
        bootId: '12345678-1234-1234-1234-123456789abc',
      }),
      processGroupIdentityAlive: () => priorGroupAlive,
      unboundOwnerAlive: () => markedWriterAlive,
    });
    await store.acquire('app', {
      taskId: 'REPLACE', runToken: 'replace-token', declaredBaseRevision: BASE,
      declaredPaths: ['src/a.ts'], declaredProtectedSnapshot: [], trustedBaseRevision: BASE,
      currentProtectedPaths: [], maxWriters: 1, requireDeclarations: true, acquiredAtMs: 1,
    });
    await store.bindOwnerProcess('app', 'REPLACE', 'replace-token', 101);
    await expect(
      store.prepareReplacement('app', 'REPLACE', 'replace-token'),
    ).resolves.toMatchObject({ ok: false, reason: 'owner_alive' });
    expect((await store.list('app'))[0]?.ownerProcess?.pid).toBe(101);

    priorGroupAlive = null;
    await expect(
      store.prepareReplacement('app', 'REPLACE', 'replace-token'),
    ).resolves.toMatchObject({ ok: false, reason: 'owner_unknown' });
    expect((await store.list('app'))[0]?.ownerProcess?.pid).toBe(101);

    priorGroupAlive = false;
    await expect(
      store.prepareReplacement('app', 'REPLACE', 'wrong-token'),
    ).resolves.toMatchObject({ ok: false, reason: 'token_mismatch' });
    expect((await store.list('app'))[0]?.ownerProcess?.pid).toBe(101);
    await expect(
      store.prepareReplacement('app', 'REPLACE', 'replace-token'),
    ).resolves.toEqual({ ok: true });
    expect((await store.list('app'))[0]).not.toHaveProperty('ownerProcess');

    markedWriterAlive = true;
    await expect(
      store.releaseIfOwnerDead('app', 'REPLACE', 'replace-token'),
    ).resolves.toMatchObject({ ok: true, released: false, ownerState: 'alive' });
    expect((await store.reclaimStale('app', new Set())).reclaimed).toEqual([]);

    markedWriterAlive = false;
    expect((await store.reclaimStale('app', new Set())).reclaimed).toMatchObject([
      { taskId: 'REPLACE' },
    ]);
  });

  it('mechanically reclaims an unbound acquire only when process scan proves no owner', async () => {
    const dead = await tempStore(() => false);
    await dead.acquire('app', {
      taskId: 'PENDING', runToken: 'pending', declaredBaseRevision: BASE,
      declaredPaths: ['src/a.ts'], declaredProtectedSnapshot: [], trustedBaseRevision: BASE,
      currentProtectedPaths: [], maxWriters: 1, requireDeclarations: true, acquiredAtMs: 1,
    });
    await expect(dead.reclaimStale('app', new Set())).resolves.toMatchObject({
      reclaimed: [{ taskId: 'PENDING' }],
      uncertain: [],
    });

    for (const alive of [true, null] as const) {
      const held = await tempStore(() => alive);
      await held.acquire('app', {
        taskId: 'PENDING', runToken: 'pending', declaredBaseRevision: BASE,
        declaredPaths: ['src/a.ts'], declaredProtectedSnapshot: [], trustedBaseRevision: BASE,
        currentProtectedPaths: [], maxWriters: 1, requireDeclarations: true, acquiredAtMs: 1,
      });
      const result = await held.reclaimStale('app', new Set());
      expect(result.reclaimed).toEqual([]);
      expect(result.uncertain.map((entry) => entry.taskId)).toEqual(
        alive === null ? ['PENDING'] : [],
      );
      expect(await held.list('app')).toHaveLength(1);
    }
  });

  it('does not report acquire success when durable replacement cannot be written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hercules-path-lease-fault-'));
    let fail = false;
    const store = new TaskPathLeaseStore(root, {
      beforeDurableRename: () => {
        if (fail) throw new Error('injected pre-rename failure');
      },
    });
    await store.acquire('app', {
      taskId: 'T1', runToken: 'one', declaredBaseRevision: BASE,
      declaredPaths: ['src/a.ts'], declaredProtectedSnapshot: [], trustedBaseRevision: BASE,
      currentProtectedPaths: [], maxWriters: 2, requireDeclarations: true, acquiredAtMs: 1,
    });
    fail = true;
    await expect(store.acquire('app', {
      taskId: 'T2', runToken: 'two', declaredBaseRevision: BASE,
      declaredPaths: ['docs/b.md'], declaredProtectedSnapshot: [], trustedBaseRevision: BASE,
      currentProtectedPaths: [], maxWriters: 2, requireDeclarations: true, acquiredAtMs: 2,
    })).rejects.toThrow(/durably write path leases/);
    expect((await store.list('app')).map((entry) => entry.taskId)).toEqual(['T1']);
  });

  it('redacts absolute paths from filesystem errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hercules-path-lease-redact-'));
    await mkdir(join(root, '.hercules-path-leases', 'app.json'), { recursive: true });
    const store = new TaskPathLeaseStore(root);

    let caught: unknown;
    try {
      await store.list('app');
    } catch (err) {
      caught = err;
    }
    const error = caught as Error;
    expect(error.message).toMatch(/could not read path leases for app \(code [A-Z0-9_]+\)/);
    expect(error.message).not.toContain(root);
    expect(error.message).not.toContain(tmpdir());
  });

  it('rejects oversized process identity fields in a corrupt durable record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hercules-path-lease-corrupt-'));
    const dir = join(root, '.hercules-path-leases');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'app.json'), JSON.stringify({
      version: 1,
      repo: 'app',
      leases: [{
        taskId: 'T1', runToken: 'one', baseRevision: BASE,
        scopes: [{ kind: 'exact', path: 'src/a.ts' }],
        protectedPathsSnapshot: [], acquiredAtMs: 1,
        ownerProcess: {
          pid: 123,
          startTimeTicks: '1'.repeat(1000),
          bootId: 'not-a-linux-boot-id',
        },
      }],
    }));
    const store = new TaskPathLeaseStore(root);
    await expect(store.list('app')).rejects.toThrow(/invalid path-lease entries/);
  });

  it.each([
    ['zero-byte', ''],
    ['whitespace-only', ' \n\t\r\n'],
  ])('fails closed on an existing %s authoritative file', async (_label, raw) => {
    const root = await mkdtemp(join(tmpdir(), 'hercules-path-lease-empty-'));
    const dir = join(root, '.hercules-path-leases');
    const path = join(dir, 'app.json');
    await mkdir(dir, { recursive: true });
    await writeFile(path, raw);
    const store = new TaskPathLeaseStore(root);

    let caught: unknown;
    try {
      await store.list('app');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PathLeaseStoreError);
    expect(caught).toMatchObject({ repoKey: 'app', code: 'CORRUPT_FILE' });
    const error = caught as PathLeaseStoreError;
    expect(error.message).toMatch(/corrupt path-lease file for repo app \(empty content\)/);
    expect(error.message).not.toContain(root);
    expect(error.message).not.toContain(tmpdir());

    await expect(store.acquire('app', {
      taskId: 'T1', runToken: 'one', declaredBaseRevision: BASE,
      declaredPaths: ['src/a.ts'], declaredProtectedSnapshot: [], trustedBaseRevision: BASE,
      currentProtectedPaths: [], maxWriters: 1, requireDeclarations: true, acquiredAtMs: 1,
    })).rejects.toMatchObject({ repoKey: 'app', code: 'CORRUPT_FILE' });
    expect(await readFile(path, 'utf8')).toBe(raw);
  });

  it('reports post-rename directory sync failure as applied and recoverable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hercules-path-lease-dir-sync-'));
    let failSync = false;
    const store = new TaskPathLeaseStore(root, {
      syncDirectory: async () => {
        if (!failSync) return;
        const err = new Error('secret absolute path must not escape') as NodeJS.ErrnoException;
        err.code = 'EIO';
        throw err;
      },
    });
    await store.acquire('app', {
      taskId: 'T1', runToken: 'one', declaredBaseRevision: BASE,
      declaredPaths: ['src/a.ts'], declaredProtectedSnapshot: [], trustedBaseRevision: BASE,
      currentProtectedPaths: [], maxWriters: 2, requireDeclarations: true, acquiredAtMs: 1,
    });
    failSync = true;
    let caught: unknown;
    try {
      await store.acquire('app', {
        taskId: 'T2', runToken: 'two', declaredBaseRevision: BASE,
        declaredPaths: ['docs/b.md'], declaredProtectedSnapshot: [], trustedBaseRevision: BASE,
        currentProtectedPaths: [], maxWriters: 2, requireDeclarations: true, acquiredAtMs: 2,
      });
    } catch (err) {
      caught = err;
    }
    const error = caught as import('../../src/isolation/taskPathLeaseStore.js').PathLeaseStoreError;

    expect(error.replacementApplied).toBe(true);
    expect(error.code).toBe('EIO');
    expect(error.message).toMatch(/replacement applied.*re-read authoritative state/);
    expect(error.message).not.toContain(root);
    expect((await store.list('app')).map((entry) => entry.taskId)).toEqual(['T1', 'T2']);

    failSync = false;
    await expect(store.release('app', 'T2', 'two')).resolves.toMatchObject({ ok: true });
    expect((await store.list('app')).map((entry) => entry.taskId)).toEqual(['T1']);
  });
});
