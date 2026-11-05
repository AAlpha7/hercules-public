import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ArtifactContentError,
  MAX_ARTIFACT_BYTES,
} from '../../../src/control/artifacts/artifactStore.js';
import {
  createArtifactArchiveAdmissionGate,
  TEST_ONLY_ARTIFACT_CAPABILITY_ISSUER,
  type ArtifactArchiveAdmissionGate,
  type ArtifactArchiveAdmissionToken,
} from '../../../src/control/artifacts/archiveTypes.js';
import {
  openArchiveLockManager,
  type ArchiveLockLease,
} from '../../../src/control/artifacts/archiveLock.js';
import {
  openFilesystemArtifactStore as openFilesystemArtifactStoreRaw,
  type FilesystemArtifactStore,
  type FilesystemArtifactStoreOptions,
} from '../../../src/control/artifacts/filesystemArtifactStore.js';

type TestStoreOptions = Omit<
  FilesystemArtifactStoreOptions,
  'admissionGate' | 'lock' | 'lifetimeLease' | 'claimAnchorTemp'
> & {
  readonly claimAnchorTemp?: (
    candidate: Parameters<NonNullable<FilesystemArtifactStoreOptions['claimAnchorTemp']>>[1],
    lease: ArchiveLockLease,
  ) => void | Promise<void>;
};

class TestFilesystemArtifactStore {
  #activeToken: ArtifactArchiveAdmissionToken | null = null;

  constructor(
    readonly raw: FilesystemArtifactStore,
    readonly gate: ArtifactArchiveAdmissionGate,
  ) {}

  async withLease<T>(operation: (lease: ArchiveLockLease) => Promise<T>): Promise<T> {
    const token = this.gate.enter();
    this.#activeToken = token;
    try {
      return await this.raw.withLease(token, operation);
    } finally {
      this.#activeToken = null;
      this.gate.leave(token);
    }
  }

  verifyClosedLayout(
    lease: ArchiveLockLease,
  ): ReturnType<FilesystemArtifactStore['verifyClosedLayout']> {
    return this.raw.verifyClosedLayout(this.#token(), lease);
  }

  put(
    input: Parameters<FilesystemArtifactStore['put']>[1],
    lease: ArchiveLockLease,
  ): ReturnType<FilesystemArtifactStore['put']> {
    return this.raw.put(this.#token(), input, lease);
  }

  read(
    digest: Parameters<FilesystemArtifactStore['read']>[1],
    access: Parameters<FilesystemArtifactStore['read']>[2],
    lease: ArchiveLockLease,
  ): ReturnType<FilesystemArtifactStore['read']> {
    return this.raw.read(this.#token(), digest, access, lease);
  }

  verify(
    digest: Parameters<FilesystemArtifactStore['verify']>[1],
    byteLength: number,
    lease: ArchiveLockLease,
  ): ReturnType<FilesystemArtifactStore['verify']> {
    return this.raw.verify(this.#token(), digest, byteLength, lease);
  }

  exportVerified(
    digest: Parameters<FilesystemArtifactStore['exportVerified']>[1],
    byteLength: number,
    lease: ArchiveLockLease,
  ): ReturnType<FilesystemArtifactStore['exportVerified']> {
    return this.raw.exportVerified(this.#token(), digest, byteLength, lease);
  }

  removeRetired(
    digest: Parameters<FilesystemArtifactStore['removeRetired']>[1],
    lease: ArchiveLockLease,
  ): ReturnType<FilesystemArtifactStore['removeRetired']> {
    return this.raw.removeRetired(this.#token(), digest, lease);
  }

  scanOrphans(
    cutoff: Date,
    limit: number,
    referenced: Parameters<FilesystemArtifactStore['scanOrphans']>[3],
    lease: ArchiveLockLease,
  ): ReturnType<FilesystemArtifactStore['scanOrphans']> {
    return this.raw.scanOrphans(this.#token(), cutoff, limit, referenced, lease);
  }

  removeOrphan(
    orphan: Parameters<FilesystemArtifactStore['removeOrphan']>[1],
    active: Parameters<FilesystemArtifactStore['removeOrphan']>[2],
    lease: ArchiveLockLease,
  ): ReturnType<FilesystemArtifactStore['removeOrphan']> {
    return this.raw.removeOrphan(this.#token(), orphan, active, lease);
  }

  async close(): Promise<void> {
    const token = this.gate.enter();
    try {
      await this.raw.close(token);
    } finally {
      this.gate.leave(token);
    }
  }

  #token(): ArtifactArchiveAdmissionToken {
    if (this.#activeToken === null) throw new Error('test store operation requires withLease');
    return this.#activeToken;
  }
}

const openStores: TestFilesystemArtifactStore[] = [];

async function openFilesystemArtifactStore(
  options: TestStoreOptions,
): Promise<TestFilesystemArtifactStore> {
  const gate = createArtifactArchiveAdmissionGate();
  const token = gate.enter();
  const { claimAnchorTemp, ...rawOptions } = options;
  let raw: FilesystemArtifactStore;
  try {
    raw = await openFilesystemArtifactStoreRaw(token, {
      ...rawOptions,
      admissionGate: gate,
      ...(claimAnchorTemp === undefined
        ? {}
        : {
            claimAnchorTemp: (_token, candidate, lease) =>
              claimAnchorTemp(candidate, lease),
          }),
    });
  } finally {
    gate.leave(token);
  }
  const store = new TestFilesystemArtifactStore(raw, gate);
  openStores.push(store);
  return store;
}

afterEach(async () => {
  for (const store of openStores.splice(0).reverse()) await store.close();
});

async function privateParent(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'hercules-artifacts-'));
  await chmod(parent, 0o700);
  return parent;
}

async function allFiles(root: string): Promise<readonly string[]> {
  const result: string[] = [];
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else result.push(child);
    }
  }
  await visit(root);
  return result.sort();
}

describe('filesystem artifact store', () => {
  it('creates a private root and publishes owned bytes by hard-link no-clobber', async () => {
    const parent = await privateParent();
    const root = join(parent, 'archive');
    const store = await openFilesystemArtifactStore({ root });
    const caller = Buffer.from('ordinary verifier evidence');

    const first = await store.withLease((lease) => store.put({ bytes: caller }, lease));
    caller.fill(0);
    const second = await store.withLease((lease) =>
      store.put({ bytes: Buffer.from('ordinary verifier evidence') }, lease),
    );

    expect(second).toEqual(first);
    expect(first.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.storageKey).toBe(
      `sha256/${first.sha256.slice(7, 9)}/${first.sha256.slice(9, 11)}/${first.sha256.slice(7)}`,
    );
    expect(await readFile(join(root, first.storageKey), 'utf8')).toBe(
      'ordinary verifier evidence',
    );
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, first.storageKey))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(root, first.storageKey))).nlink).toBe(1);
    expect((await readdir(join(root, '.tmp'))).length).toBe(0);
  });

  it('snapshots caller bytes before the first await and rejects shared memory', async () => {
    const parent = await privateParent();
    const root = join(parent, 'archive');
    const store = await openFilesystemArtifactStore({ root });
    const caller = Buffer.from('immutable input snapshot');

    const receipt = await store.withLease(async (lease) => {
      const pending = store.put({ bytes: caller }, lease);
      caller.fill(0);
      return pending;
    });
    expect(await readFile(join(root, receipt.storageKey), 'utf8')).toBe(
      'immutable input snapshot',
    );

    const shared = new Uint8Array(new SharedArrayBuffer(16));
    await expect(
      store.withLease((lease) => store.put({ bytes: shared }, lease)),
    ).rejects.toMatchObject({ reason: 'invalid_byte_length' });

    const hostile = new Uint8Array([1]);
    Object.defineProperty(hostile, Symbol.iterator, {
      value: function* (): Generator<number> {
        for (let index = 0; index < 1_000; index += 1) yield index & 0xff;
      },
    });
    await expect(
      store.withLease((lease) => store.put({ bytes: hostile }, lease)),
    ).rejects.toMatchObject({ reason: 'invalid_byte_length' });
  });

  it('rejects oversized or secret-bearing bytes before creating a temp or blob', async () => {
    const parent = await privateParent();
    const root = join(parent, 'archive');
    const store = await openFilesystemArtifactStore({ root, maxArtifactBytes: 32 });

    await expect(
      store.withLease((lease) => store.put({ bytes: new Uint8Array(33) }, lease)),
    ).rejects.toMatchObject({ reason: 'content_too_large' });
    await expect(
      store.withLease((lease) =>
        store.put({ bytes: Buffer.from('token=xai-synthetic-provider') }, lease),
      ),
    ).rejects.toMatchObject({ code: 'artifact_secret' });

    expect(await readdir(join(root, '.tmp'))).toEqual([]);
    expect((await allFiles(join(root, 'sha256'))).length).toBe(0);
  });

  it('never overwrites a conflicting final blob', async () => {
    const parent = await privateParent();
    const root = join(parent, 'archive');
    const store = await openFilesystemArtifactStore({ root });
    const receipt = await store.withLease((lease) =>
      store.put({ bytes: Buffer.from('expected artifact') }, lease),
    );
    const finalPath = join(root, receipt.storageKey);
    await writeFile(finalPath, 'tampered artifact', { mode: 0o600 });

    await expect(
      store.withLease((lease) =>
        store.put({ bytes: Buffer.from('expected artifact') }, lease),
      ),
    ).rejects.toMatchObject({ code: 'artifact_integrity' });
    expect(await readFile(finalPath, 'utf8')).toBe('tampered artifact');
  });

  it('fails closed on a symlinked or permissive root and forbidden overlap', async () => {
    const parent = await privateParent();
    const target = join(parent, 'target');
    await mkdir(target, { mode: 0o700 });
    const linked = join(parent, 'linked');
    await symlink(target, linked);
    await expect(openFilesystemArtifactStore({ root: linked })).rejects.toMatchObject({
      reason: 'unsafe_root',
    });

    const permissive = join(parent, 'permissive');
    await mkdir(permissive, { mode: 0o755 });
    await expect(openFilesystemArtifactStore({ root: permissive })).rejects.toMatchObject({
      reason: 'unsafe_root',
    });

    const forbidden = join(parent, 'control');
    await mkdir(forbidden, { mode: 0o700 });
    await expect(
      openFilesystemArtifactStore({ root: join(forbidden, 'archive'), forbiddenRoots: [forbidden] }),
    ).rejects.toMatchObject({ reason: 'root_overlap' });

    const prospectiveRoot = join(parent, 'prospective-archive');
    const providerAlias = join(parent, 'provider-link');
    await symlink(prospectiveRoot, providerAlias);
    await expect(openFilesystemArtifactStore({
      root: prospectiveRoot,
      forbiddenRoots: [join(providerAlias, 'missing-worktree')],
    })).rejects.toMatchObject({ reason: 'root_overlap' });
  });

  it('rejects an otherwise safe root that contains an unknown top-level entry', async () => {
    const parent = await privateParent();
    const root = join(parent, 'archive');
    const store = await openFilesystemArtifactStore({ root });
    await store.close();
    await writeFile(join(root, 'unexpected'), 'not archive state', { mode: 0o600 });

    await expect(openFilesystemArtifactStore({ root })).rejects.toMatchObject({
      reason: 'unknown_archive_entry',
    });
  });

  it('detects a hard-linked or mutated blob during strict verification', async () => {
    const parent = await privateParent();
    const root = join(parent, 'archive');
    const store = await openFilesystemArtifactStore({ root });
    const receipt = await store.withLease((lease) =>
      store.put({ bytes: Buffer.from('verified artifact') }, lease),
    );
    const finalPath = join(root, receipt.storageKey);
    const foreign = join(parent, 'foreign-link');
    await link(finalPath, foreign);

    await expect(
      store.withLease((lease) => store.verify(receipt.sha256, receipt.byteLength, lease)),
    ).rejects.toMatchObject({ reason: 'unsafe_content_file' });
    await rm(foreign);
    await writeFile(finalPath, 'changed bytes', { mode: 0o600 });
    await expect(
      store.withLease((lease) => store.verify(receipt.sha256, receipt.byteLength, lease)),
    ).rejects.toBeInstanceOf(ArtifactContentError);
  });

  it('requires a digest-bound live capability and returns a fresh byte copy', async () => {
    const parent = await privateParent();
    const root = join(parent, 'archive');
    const now = new Date('2026-08-28T19:00:00.000Z');
    const store = await openFilesystemArtifactStore({
      root,
      now: () => now,
      resolveAccessClass: () => 'restricted',
    });
    const receipt = await store.withLease((lease) =>
      store.put({ bytes: Buffer.from('bounded read result') }, lease),
    );
    const access = TEST_ONLY_ARTIFACT_CAPABILITY_ISSUER.issueArtifactAccess({
      sha256: receipt.sha256,
      purpose: 'read',
      authorizationClass: 'restricted',
      issuer: 'trusted-operator',
      issuedAt: '2026-08-28T18:59:00.000Z',
      expiresAt: '2026-08-28T19:01:00.000Z',
    });

    await expect(
      store.withLease((lease) => store.read(receipt.sha256, {} as never, lease)),
    ).rejects.toMatchObject({ code: 'invalid_capability' });
    const first = await store.withLease((lease) => store.read(receipt.sha256, access, lease));
    first.fill(0);
    const second = await store.withLease((lease) => store.read(receipt.sha256, access, lease));
    expect(Buffer.from(second).toString('utf8')).toBe('bounded read result');
    const reviewAccess = TEST_ONLY_ARTIFACT_CAPABILITY_ISSUER.issueArtifactAccess({
      sha256: receipt.sha256,
      purpose: 'operator_review',
      authorizationClass: 'restricted',
      issuer: 'trusted-operator',
      issuedAt: '2026-08-28T18:59:00.000Z',
      expiresAt: '2026-08-28T19:01:00.000Z',
    });
    const reviewBytes = await store.withLease((lease) =>
      store.read(receipt.sha256, reviewAccess, lease));
    expect(Buffer.from(reviewBytes).toString('utf8')).toBe('bounded read result');

    const weak = TEST_ONLY_ARTIFACT_CAPABILITY_ISSUER.issueArtifactAccess({
      sha256: receipt.sha256,
      purpose: 'read',
      authorizationClass: 'operator',
      issuer: 'trusted-operator',
      issuedAt: '2026-08-28T18:59:00.000Z',
      expiresAt: '2026-08-28T19:01:00.000Z',
    });
    await expect(
      store.withLease((lease) => store.read(receipt.sha256, weak, lease)),
    ).rejects.toMatchObject({ code: 'artifact_integrity' });
  });

  it('fails closed on an invalid or throwing digest access policy', async () => {
    const parent = await privateParent();
    const now = new Date('2026-08-28T19:00:00.000Z');
    let policy: 'invalid' | 'throw' = 'invalid';
    const store = await openFilesystemArtifactStore({
      root: join(parent, 'archive'),
      now: () => now,
      resolveAccessClass: () => {
        if (policy === 'throw') throw new Error('sensitive policy failure');
        return 'invalid' as never;
      },
    });
    const receipt = await store.withLease((lease) =>
      store.put({ bytes: Buffer.from('policy protected bytes') }, lease),
    );
    const access = TEST_ONLY_ARTIFACT_CAPABILITY_ISSUER.issueArtifactAccess({
      sha256: receipt.sha256,
      purpose: 'read',
      authorizationClass: 'restricted',
      issuer: 'trusted-operator',
      issuedAt: '2026-08-28T18:59:00.000Z',
      expiresAt: '2026-08-28T19:01:00.000Z',
    });

    await expect(
      store.withLease((lease) => store.read(receipt.sha256, access, lease)),
    ).rejects.toMatchObject({ reason: 'invalid_access_policy' });
    policy = 'throw';
    await expect(
      store.withLease((lease) => store.read(receipt.sha256, access, lease)),
    ).rejects.toMatchObject({
      reason: 'invalid_access_policy',
      message: expect.not.stringContaining('sensitive'),
    });
  });

  it('poisons the lifetime store permanently when its flock holder dies', async () => {
    const parent = await privateParent();
    const store = await openFilesystemArtifactStore({ root: join(parent, 'archive') });
    await store.withLease(async (lease) => {
      process.kill(lease.pid, 'SIGKILL');
      await lease.whenLost;
    }).catch(() => undefined);

    await expect(
      store.withLease((lease) => store.put({ bytes: Buffer.from('never written') }, lease)),
    ).rejects.toMatchObject({ code: 'archive_lock_lost' });
  });

  it('rejects forged, foreign, and revoked admission tokens', async () => {
    const parent = await privateParent();
    const root = join(parent, 'archive');
    const store = await openFilesystemArtifactStore({ root });
    const foreignGate = createArtifactArchiveAdmissionGate();
    const foreign = foreignGate.enter();
    await expect(
      store.raw.withLease(foreign, async () => undefined),
    ).rejects.toMatchObject({ code: 'invalid_capability' });
    foreignGate.leave(foreign);

    const revoked = store.gate.enter();
    store.gate.leave(revoked);
    await expect(
      store.raw.withLease(revoked, async () => undefined),
    ).rejects.toMatchObject({ code: 'invalid_capability' });
    await expect(
      store.raw.withLease({} as ArtifactArchiveAdmissionToken, async () => undefined),
    ).rejects.toMatchObject({ code: 'invalid_capability' });
  });

  it('rejects when the admission token is revoked across an async boundary', async () => {
    const parent = await privateParent();
    const root = join(parent, 'archive');
    const gate = createArtifactArchiveAdmissionGate();
    let activeToken: ArtifactArchiveAdmissionToken | null = null;
    const openingToken = gate.enter();
    const store = await openFilesystemArtifactStoreRaw(openingToken, {
      root,
      admissionGate: gate,
      now: () => new Date('2026-08-28T19:00:00.000Z'),
      resolveAccessClass: async () => {
        if (activeToken === null) throw new Error('missing active token');
        gate.leave(activeToken);
        activeToken = null;
        return 'operator' as const;
      },
    });
    gate.leave(openingToken);

    const writeToken = gate.enter();
    const receipt = await store.withLease(writeToken, (lease) =>
      store.put(writeToken, { bytes: Buffer.from('revocation boundary') }, lease),
    );
    gate.leave(writeToken);

    activeToken = gate.enter();
    const access = TEST_ONLY_ARTIFACT_CAPABILITY_ISSUER.issueArtifactAccess({
      sha256: receipt.sha256,
      purpose: 'read',
      authorizationClass: 'operator',
      issuer: 'trusted-operator',
      issuedAt: '2026-08-28T18:59:00.000Z',
      expiresAt: '2026-08-28T19:01:00.000Z',
    });
    await expect(
      store.withLease(activeToken, (lease) =>
        store.read(activeToken!, receipt.sha256, access, lease),
      ),
    ).rejects.toMatchObject({ code: 'invalid_capability' });

    const closeToken = gate.enter();
    await store.close(closeToken);
    gate.leave(closeToken);
  });

  it('permanently poisons the store when the archive root becomes unsafe', async () => {
    const parent = await privateParent();
    const root = join(parent, 'archive');
    const store = await openFilesystemArtifactStore({ root });
    await chmod(root, 0o755);

    await expect(
      store.withLease((lease) => store.put({ bytes: Buffer.from('not written') }, lease)),
    ).rejects.toMatchObject({ reason: 'unsafe_root' });
    await chmod(root, 0o700);
    await expect(
      store.withLease((lease) => store.put({ bytes: Buffer.from('still blocked') }, lease)),
    ).rejects.toMatchObject({ reason: 'unsafe_root' });
  });

  it('does not release a coordinator-owned lifetime lease when content closes', async () => {
    const parent = await privateParent();
    const root = join(parent, 'archive');
    await mkdir(root, { mode: 0o700 });
    const lock = await openArchiveLockManager(join(root, '.archive.lock'));
    const lease = await lock.acquire();
    const gate = createArtifactArchiveAdmissionGate();
    const token = gate.enter();
    const store = await openFilesystemArtifactStoreRaw(token, {
      root,
      admissionGate: gate,
      lock,
      lifetimeLease: lease,
    });
    await store.close(token);
    await expect(lock.assertOwns(lease)).resolves.toBeUndefined();
    await lease.release();
    gate.leave(token);
  });

  it('reproves file and ancestor identity after read before returning bytes', async () => {
    const parent = await privateParent();
    const root = join(parent, 'archive');
    let shardPath: string | null = null;
    let mutate = false;
    const store = await openFilesystemArtifactStore({
      root,
      faultHooks: {
        afterContentReadBeforeReprove: async () => {
          if (mutate && shardPath !== null) await chmod(shardPath, 0o755);
        },
      },
    });
    const receipt = await store.withLease((lease) =>
      store.put({ bytes: Buffer.from('ancestor checked bytes') }, lease),
    );
    shardPath = join(root, 'sha256', receipt.sha256.slice(7, 9));
    mutate = true;

    await expect(
      store.withLease((lease) => store.verify(receipt.sha256, receipt.byteLength, lease)),
    ).rejects.toMatchObject({ code: 'artifact_integrity' });
    await chmod(shardPath, 0o700);
    mutate = false;
    await expect(
      store.withLease((lease) => store.verify(receipt.sha256, receipt.byteLength, lease)),
    ).rejects.toMatchObject({ code: 'artifact_integrity' });
  });

  it('recovers only an exact post-link temp/final inode pair', async () => {
    const parent = await privateParent();
    const root = join(parent, 'archive');
    let injected = false;
    const store = await openFilesystemArtifactStore({
      root,
      faultHooks: {
        afterLinkBeforeTempUnlink: () => {
          injected = true;
          throw new ArtifactContentError('fault_injected');
        },
      },
    });

    await expect(
      store.withLease((lease) => store.put({ bytes: Buffer.from('recoverable bytes') }, lease)),
    ).rejects.toMatchObject({ reason: 'fault_injected' });
    expect(injected).toBe(true);
    expect(await readdir(join(root, '.tmp'))).toHaveLength(1);

    await store.close();
    const reopened = await openFilesystemArtifactStore({ root });
    expect(await readdir(join(root, '.tmp'))).toEqual([]);
    const receipt = await reopened.withLease((lease) =>
      reopened.put({ bytes: Buffer.from('recoverable bytes') }, lease),
    );
    expect((await lstat(join(root, receipt.storageKey))).nlink).toBe(1);
  });

  it('retains and rejects an unlinked content temp at startup', async () => {
    const parent = await privateParent();
    const root = join(parent, 'archive');
    const first = await openFilesystemArtifactStore({ root });
    await first.close();

    const bytes = Buffer.from('unlinked crash residue');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const residue = join(root, '.tmp', `content-${digest}-${'a'.repeat(32)}.tmp`);
    await writeFile(residue, bytes, { mode: 0o600 });

    await expect(openFilesystemArtifactStore({ root })).rejects.toMatchObject({
      reason: 'unsafe_temp',
      operation: 'recover_unlinked_temp',
    });
    expect(await readFile(residue, 'utf8')).toBe('unlinked crash residue');
  });

  it('retains a third value substituted for a linked publication temp', async () => {
    const parent = await privateParent();
    const root = join(parent, 'archive');
    let replacementPath: string | null = null;
    const store = await openFilesystemArtifactStore({
      root,
      faultHooks: {
        afterLinkBeforeTempUnlink: async (tempPath) => {
          replacementPath = tempPath;
          await unlink(tempPath);
          await writeFile(tempPath, 'publication third value', { mode: 0o600 });
        },
      },
    });

    await expect(
      store.withLease((lease) =>
        store.put({ bytes: Buffer.from('published original') }, lease),
      ),
    ).rejects.toMatchObject({ reason: 'unsafe_temp' });
    expect(replacementPath).not.toBeNull();
    expect(await readFile(replacementPath!, 'utf8')).toBe('publication third value');
  });

  it('retains a third value substituted for a conflict-path temp', async () => {
    const parent = await privateParent();
    const root = join(parent, 'archive');
    const bytes = Buffer.from('concurrent winner bytes');
    let replacementPath: string | null = null;
    const store = await openFilesystemArtifactStore({
      root,
      faultHooks: {
        beforePublishLink: async (_tempPath, finalPath) => {
          await writeFile(finalPath, bytes, { flag: 'wx', mode: 0o600 });
        },
        afterPublishConflictBeforeTempUnlink: async (tempPath) => {
          replacementPath = tempPath;
          await unlink(tempPath);
          await writeFile(tempPath, 'conflict third value', { mode: 0o600 });
        },
      },
    });

    await expect(
      store.withLease((lease) => store.put({ bytes }, lease)),
    ).rejects.toMatchObject({ reason: 'unsafe_temp' });
    expect(replacementPath).not.toBeNull();
    expect(await readFile(replacementPath!, 'utf8')).toBe('conflict third value');
  });

  it('reports deterministic bounded orphans and removes only a re-proven candidate', async () => {
    const parent = await privateParent();
    const root = join(parent, 'archive');
    const store = await openFilesystemArtifactStore({ root });
    const old = new Date('2026-01-01T00:00:00.000Z');
    const first = await store.withLease((lease) =>
      store.put({ bytes: Buffer.from('orphan a') }, lease),
    );
    const second = await store.withLease((lease) =>
      store.put({ bytes: Buffer.from('orphan b') }, lease),
    );
    await utimes(join(root, first.storageKey), old, old);
    await utimes(join(root, second.storageKey), old, old);

    const orphans = await store.withLease((lease) =>
      {
        const cutoff = new Date('2026-02-01T00:00:00.000Z');
        const referenced = new Set([second.sha256]);
        const pending = store.scanOrphans(
          cutoff,
          1,
          referenced,
          lease,
        );
        cutoff.setTime(0);
        referenced.clear();
        return pending;
      },
    );
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.sha256).toBe(first.sha256);
    await store.withLease((lease) => store.removeOrphan(orphans[0]!, new Set(), lease));
    await expect(lstat(join(root, first.storageKey))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await lstat(join(root, second.storageKey))).toBeDefined();
  });

  it('retains a replacement third value instead of unlinking it', async () => {
    const parent = await privateParent();
    const root = join(parent, 'archive');
    let replacementPath: string | null = null;
    const store = await openFilesystemArtifactStore({
      root,
      faultHooks: {
        beforeRetiredUnlink: async () => {
          if (replacementPath === null) return;
          await unlink(replacementPath);
          await writeFile(replacementPath, 'replacement third value', { mode: 0o600 });
        },
      },
    });
    const receipt = await store.withLease((lease) =>
      store.put({ bytes: Buffer.from('retired original') }, lease),
    );
    replacementPath = join(root, receipt.storageKey);

    await expect(
      store.withLease((lease) => store.removeRetired(receipt.sha256, lease)),
    ).rejects.toMatchObject({ reason: 'identity_changed' });
    expect(await readFile(replacementPath, 'utf8')).toBe('replacement third value');
  });

  it('retains a replaced orphan instead of unlinking the third value', async () => {
    const parent = await privateParent();
    const root = join(parent, 'archive');
    let replacementPath: string | null = null;
    const store = await openFilesystemArtifactStore({
      root,
      faultHooks: {
        beforeOrphanUnlink: async () => {
          if (replacementPath === null) return;
          await unlink(replacementPath);
          await writeFile(replacementPath, 'replacement orphan', { mode: 0o600 });
        },
      },
    });
    const receipt = await store.withLease((lease) =>
      store.put({ bytes: Buffer.from('original orphan') }, lease),
    );
    replacementPath = join(root, receipt.storageKey);
    const old = new Date('2026-01-01T00:00:00.000Z');
    await utimes(replacementPath, old, old);
    const [orphan] = await store.withLease((lease) =>
      store.scanOrphans(new Date('2026-02-01T00:00:00.000Z'), 1, new Set(), lease),
    );
    expect(orphan).toBeDefined();

    await expect(
      store.withLease((lease) => store.removeOrphan(orphan!, new Set(), lease)),
    ).rejects.toMatchObject({ reason: 'identity_changed' });
    expect(await readFile(replacementPath, 'utf8')).toBe('replacement orphan');
  });

  it('fails closed on hostile or unclaimed shared temp entries', async () => {
    const parent = await privateParent();
    const uuid = '12345678-1234-4123-8123-123456789abc';

    const hostileRoot = join(parent, 'hostile');
    await mkdir(join(hostileRoot, '.tmp'), { recursive: true, mode: 0o700 });
    await chmod(hostileRoot, 0o700);
    await mkdir(join(hostileRoot, '.tmp', `anchor-${uuid}.tmp`), { mode: 0o700 });
    await expect(openFilesystemArtifactStore({ root: hostileRoot })).rejects.toMatchObject({
      reason: 'unsafe_temp',
    });

    const unclaimedRoot = join(parent, 'unclaimed');
    await mkdir(join(unclaimedRoot, '.tmp'), { recursive: true, mode: 0o700 });
    await chmod(unclaimedRoot, 0o700);
    await writeFile(join(unclaimedRoot, '.tmp', `anchor-${uuid}.tmp`), 'anchor', {
      mode: 0o600,
    });
    await expect(openFilesystemArtifactStore({ root: unclaimedRoot })).rejects.toMatchObject({
      reason: 'unsafe_temp',
    });

    const malformedRoot = join(parent, 'malformed');
    await mkdir(join(malformedRoot, '.tmp'), { recursive: true, mode: 0o700 });
    await chmod(malformedRoot, 0o700);
    await writeFile(join(malformedRoot, '.tmp', 'anchor-not-a-uuid.tmp'), 'anchor', {
      mode: 0o600,
    });
    await expect(openFilesystemArtifactStore({ root: malformedRoot })).rejects.toMatchObject({
      reason: 'unknown_archive_entry',
    });

    const symlinkRoot = join(parent, 'symlink-temp');
    await mkdir(join(symlinkRoot, '.tmp'), { recursive: true, mode: 0o700 });
    await chmod(symlinkRoot, 0o700);
    const target = join(parent, 'anchor-target');
    await writeFile(target, 'anchor', { mode: 0o600 });
    await symlink(target, join(symlinkRoot, '.tmp', `anchor-${uuid}.tmp`));
    await expect(openFilesystemArtifactStore({ root: symlinkRoot })).rejects.toMatchObject({
      reason: 'unsafe_temp',
    });

    const claimedRoot = join(parent, 'claimed');
    const claimedPath = join(claimedRoot, '.tmp', `anchor-${uuid}.tmp`);
    await mkdir(join(claimedRoot, '.tmp'), { recursive: true, mode: 0o700 });
    await chmod(claimedRoot, 0o700);
    await writeFile(claimedPath, 'anchor', { mode: 0o600 });
    const claimed = await openFilesystemArtifactStore({
      root: claimedRoot,
      claimAnchorTemp: async (candidate) => {
        expect(candidate.name).toBe(`anchor-${uuid}.tmp`);
        await unlink(claimedPath);
      },
    });
    expect(await readdir(join(claimedRoot, '.tmp'))).toEqual([]);
    await claimed.close();
  });

  it('enforces the hard 64 MiB maximum at construction', async () => {
    const parent = await privateParent();
    await expect(
      openFilesystemArtifactStore({
        root: join(parent, 'archive'),
        maxArtifactBytes: MAX_ARTIFACT_BYTES + 1,
      }),
    ).rejects.toMatchObject({ reason: 'invalid_size_limit' });
  });
});
