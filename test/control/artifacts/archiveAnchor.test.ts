import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ArchiveAnchorError,
  openFilesystemArchiveAnchorStore,
  type ArchiveAnchorFaultHooks,
  type ArtifactSealedSnapshot,
  type FilesystemArchiveAnchorStore,
} from '../../../src/control/artifacts/archiveAnchor.js';
import {
  openArchiveLockManager,
  type ArchiveLockLease,
} from '../../../src/control/artifacts/archiveLock.js';
import {
  createArtifactArchiveAdmissionGate,
  type ArtifactArchiveAdmissionToken,
} from '../../../src/control/artifacts/archiveTypes.js';

const cleanup: string[] = [];
const leases: ArchiveLockLease[] = [];

function root(): string {
  const parent = mkdtempSync(join(tmpdir(), 'hercules-anchor-'));
  cleanup.push(parent);
  const target = join(parent, 'artifacts');
  mkdirSync(target, { mode: 0o700 });
  return target;
}

function snapshot(sequence: number, overrides: Partial<ArtifactSealedSnapshot> = {}): ArtifactSealedSnapshot {
  const hash = `sha256:${String(sequence).padStart(64, '0')}`;
  return {
    schema: 'hercules-artifact-sealed-snapshot/v1',
    lineageId: 'lineage-1',
    eventId: `event-${sequence}`,
    mutationKind: 'record_artifact',
    aggregateId: `artifact-${sequence}`,
    requestDigest: hash,
    sealedThroughSequence: sequence,
    sealedThroughEventHash: hash,
    inventoryDigest: hash,
    receiptDigest: hash,
    committedAt: `2026-08-28T00:00:0${sequence}.000Z`,
    ...overrides,
  };
}

type TestAnchorStore = {
  [Key in keyof FilesystemArchiveAnchorStore]: FilesystemArchiveAnchorStore[Key] extends (
    token: ArtifactArchiveAdmissionToken,
    ...args: infer Args
  ) => infer Result ? (...args: Args) => Result : never;
};

function bindTestAnchorStore(
  raw: FilesystemArchiveAnchorStore,
  gate: ReturnType<typeof createArtifactArchiveAdmissionGate>,
): TestAnchorStore {
  return new Proxy(raw, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: readonly unknown[]) => {
        const token = gate.enter();
        const result = Reflect.apply(value, target, [token, ...args]) as Promise<unknown>;
        return result.finally(() => gate.leave(token));
      };
    },
  }) as unknown as TestAnchorStore;
}

async function harness(input: {
  readonly target?: string;
  readonly hooks?: ArchiveAnchorFaultHooks;
  readonly maximumAnchorBytes?: number;
} = {}): Promise<{
  readonly target: string;
  readonly store: TestAnchorStore;
  readonly rawStore: FilesystemArchiveAnchorStore;
  readonly gate: ReturnType<typeof createArtifactArchiveAdmissionGate>;
  readonly lease: ArchiveLockLease;
}> {
  const target = input.target ?? root();
  const lock = await openArchiveLockManager(join(target, '.archive.lock'));
  const lease = await lock.acquire();
  leases.push(lease);
  const gate = createArtifactArchiveAdmissionGate();
  const options = {
    root: target,
    lineageId: 'lineage-1',
    lock,
    lifetimeLease: lease,
    admissionGate: gate,
    ...(input.maximumAnchorBytes === undefined
      ? {}
      : { maximumAnchorBytes: input.maximumAnchorBytes }),
    ...(input.hooks === undefined ? {} : { faultHooks: input.hooks }),
  };
  const token = gate.enter();
  const rawStore = await openFilesystemArchiveAnchorStore(token, options);
  gate.leave(token);
  return { target, store: bindTestAnchorStore(rawStore, gate), rawStore, gate, lease };
}

function anchorPath(target: string): string {
  const [name] = readdirSync(join(target, 'anchors'));
  if (name === undefined) throw new Error('test fixture did not publish an anchor');
  return join(target, 'anchors', name);
}

afterEach(async () => {
  for (const lease of leases.splice(0)) await lease.release();
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('filesystem archive anchor store', () => {
  it('publishes a canonical private hash chain and converges on an exact stable retry', async () => {
    const { target, store, lease } = await harness();
    const first = await store.append(snapshot(1), lease);
    expect(await store.append(snapshot(1), lease)).toEqual(first);
    const second = await store.append(snapshot(2), lease);
    expect(second.previousAnchorHash).toBe(first.anchorHash);
    expect(await store.readAll(lease)).toEqual([first, second]);

    for (const name of ['anchors', '.tmp']) {
      expect(statSync(join(target, name)).mode & 0o777).toBe(0o700);
    }
    for (const name of readdirSync(join(target, 'anchors'))) {
      expect(statSync(join(target, 'anchors', name)).mode & 0o777).toBe(0o600);
      expect(statSync(join(target, 'anchors', name)).nlink).toBe(1);
    }
  });

  it('fails closed on non-canonical content, permission changes, and unknown entries', async () => {
    const { target, store, lease } = await harness();
    await store.append(snapshot(1), lease);
    const path = anchorPath(target);
    const original = readFileSync(path, 'utf8');
    const parsed = JSON.parse(original) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify(parsed, null, 2), 'utf8');
    await expect(store.readAll(lease)).rejects.toThrow(ArchiveAnchorError);

    writeFileSync(path, original, 'utf8');
    chmodSync(path, 0o644);
    await expect(store.readAll(lease)).rejects.toThrow(ArchiveAnchorError);

    chmodSync(path, 0o600);
    writeFileSync(join(target, 'anchors', 'foreign'), '', { mode: 0o600 });
    await expect(store.readAll(lease)).rejects.toThrow(ArchiveAnchorError);
  });

  it('rejects malformed/accessor snapshots before creating an anchor', async () => {
    const { target, store, lease } = await harness();
    await expect(store.append({ ...snapshot(1), inventoryDigest: 'weak' }, lease)).rejects.toThrow(
      ArchiveAnchorError,
    );
    const hostile = snapshot(1) as unknown as Record<string, unknown>;
    Object.defineProperty(hostile, 'eventId', { enumerable: true, get: () => 'event-1' });
    await expect(store.append(hostile as unknown as ArtifactSealedSnapshot, lease)).rejects.toThrow(
      'own data property',
    );
    expect(readdirSync(join(target, 'anchors'))).toEqual([]);
  });

  it('binds every public operation to the exact admission token and lifetime lease', async () => {
    const { store, rawStore, lease } = await harness();
    const forged = Object.create(Object.getPrototypeOf(lease)) as ArchiveLockLease;
    await expect(store.append(snapshot(1), forged)).rejects.toThrow();
    await expect(store.readAll(forged)).rejects.toThrow();
    await expect(store.claimTemp({ name: 'anchor-00000000-0000-4000-8000-000000000000.tmp', byteLength: 1, linkCount: 1 }, snapshot(1), forged)).rejects.toThrow();
    const foreignGate = createArtifactArchiveAdmissionGate();
    const foreignToken = foreignGate.enter();
    await expect(rawStore.append(foreignToken, snapshot(1), lease)).rejects.toThrow('forged or inactive');
    await expect(rawStore.readAll({} as ArtifactArchiveAdmissionToken, lease)).rejects.toThrow('forged or inactive');
    foreignGate.leave(foreignToken);
  });

  it('revalidates admission after an asynchronous publication boundary', async () => {
    const operation: {
      gate?: ReturnType<typeof createArtifactArchiveAdmissionGate>;
      token?: ArtifactArchiveAdmissionToken;
    } = {};
    const target = await harness({
      hooks: {
        afterTempFsyncBeforeLink() {
          if (operation.gate === undefined || operation.token === undefined) {
            throw new Error('operation capability fixture is incomplete');
          }
          operation.gate.leave(operation.token);
        },
      },
    });
    const gate = target.gate;
    const token = gate.enter();
    operation.gate = gate;
    operation.token = token;
    await expect(target.rawStore.append(token, snapshot(1), target.lease))
      .rejects.toThrow('publication failed');
    expect(() => gate.assertOwns(token)).toThrow('forged or inactive');
    expect(readdirSync(join(target.target, 'anchors'))).toEqual([]);
  });

  it('detects replacement of the pinned root or anchor directory', async () => {
    const first = await harness();
    const movedRoot = `${first.target}-old`;
    renameSync(first.target, movedRoot);
    mkdirSync(first.target, { mode: 0o700 });
    mkdirSync(join(first.target, 'anchors'), { mode: 0o700 });
    mkdirSync(join(first.target, '.tmp'), { mode: 0o700 });
    await expect(first.store.readAll(first.lease)).rejects.toThrow();

    const second = await harness();
    renameSync(join(second.target, 'anchors'), join(second.target, 'anchors-old'));
    mkdirSync(join(second.target, 'anchors'), { mode: 0o700 });
    await expect(second.store.readAll(second.lease)).rejects.toThrow('identity changed');
    rmSync(join(second.target, 'anchors'), { recursive: true });
    renameSync(join(second.target, 'anchors-old'), join(second.target, 'anchors'));
    await expect(second.store.readAll(second.lease)).rejects.toThrow('identity changed');
  });

  it('rejects a root reached through a symlinked ancestor', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'hercules-anchor-link-'));
    cleanup.push(parent);
    const realParent = join(parent, 'real');
    mkdirSync(realParent, { mode: 0o700 });
    const realRoot = join(realParent, 'artifacts');
    mkdirSync(realRoot, { mode: 0o700 });
    const alias = join(parent, 'alias');
    symlinkSync(realParent, alias, 'dir');
    const linkedRoot = join(alias, 'artifacts');
    const lock = await openArchiveLockManager(join(realRoot, '.archive.lock'));
    const lease = await lock.acquire();
    leases.push(lease);
    const gate = createArtifactArchiveAdmissionGate();
    const token = gate.enter();
    await expect(openFilesystemArchiveAnchorStore(token, {
      root: linkedRoot,
      lineageId: 'lineage-1',
      lock,
      lifetimeLease: lease,
      admissionGate: gate,
    })).rejects.toThrow('canonical');
    gate.leave(token);
  });

  it('detects a path swap after a no-follow descriptor read', async () => {
    let armed = false;
    let replacement = '';
    const { target, store, lease } = await harness({
      hooks: {
        afterReadBeforeRecheck(path) {
          if (!armed) return;
          armed = false;
          const bytes = readFileSync(path);
          unlinkSync(path);
          writeFileSync(path, bytes, { mode: 0o600 });
          replacement = path;
        },
      },
    });
    await store.append(snapshot(1), lease);
    armed = true;
    await expect(store.readAll(lease)).rejects.toThrow('changed after reading');
    expect(replacement).toBe(anchorPath(target));
  });

  it('bounds no-follow reads before allocation', async () => {
    const { target, store, lease } = await harness({ maximumAnchorBytes: 1024 });
    await store.append(snapshot(1), lease);
    writeFileSync(anchorPath(target), 'x'.repeat(1025), { mode: 0o600 });
    await expect(store.readAll(lease)).rejects.toThrow('bounded read limit');
  });

  it('recovers an exact one-link crash temp only from its immutable sealed snapshot', async () => {
    const expected = snapshot(1);
    const { target, store, lease } = await harness({
      hooks: { afterTempFsyncBeforeLink: () => { throw new Error('crash'); } },
    });
    await expect(store.append(expected, lease)).rejects.toThrow('publication failed');
    const [name] = readdirSync(join(target, '.tmp'));
    if (name === undefined) throw new Error('missing recovery temp');
    const info = lstatSync(join(target, '.tmp', name));
    await store.claimTemp({ name, byteLength: info.size, linkCount: 1 }, expected, lease);
    expect(readdirSync(join(target, '.tmp'))).toEqual([]);
    expect(await store.readAll(lease)).toHaveLength(1);
  });

  it('recovers an exact two-link committed publication and rejects mismatched recovery facts', async () => {
    const expected = snapshot(1);
    const { target, store, lease } = await harness({
      hooks: { afterLinkBeforeTempUnlink: () => { throw new Error('crash'); } },
    });
    await expect(store.append(expected, lease)).rejects.toThrow('completion failed');
    const [name] = readdirSync(join(target, '.tmp'));
    if (name === undefined) throw new Error('missing recovery temp');
    const info = lstatSync(join(target, '.tmp', name));
    await expect(store.claimTemp(
      { name, byteLength: info.size, linkCount: 2 },
      snapshot(1, { inventoryDigest: `sha256:${'f'.repeat(64)}` }),
      lease,
    )).rejects.toThrow('immutable sealed snapshot');
    expect(readdirSync(join(target, '.tmp'))).toEqual([name]);
    await store.claimTemp({ name, byteLength: info.size, linkCount: 2 }, expected, lease);
    expect(readdirSync(join(target, '.tmp'))).toEqual([]);
    expect(statSync(anchorPath(target)).nlink).toBe(1);
  });

  it('enforces constant lineage and unique event identity across the chain', async () => {
    const { store, lease } = await harness();
    await store.append(snapshot(1), lease);
    await expect(store.append(snapshot(2, { lineageId: 'other' }), lease)).rejects.toThrow('lineage');
    await expect(store.append(snapshot(2, { eventId: 'event-1' }), lease)).rejects.toThrow('unique');
  });

  it('snapshots the complete option object without invoking accessors', async () => {
    const target = root();
    const lock = await openArchiveLockManager(join(target, '.archive.lock'));
    const lease = await lock.acquire();
    leases.push(lease);
    const gate = createArtifactArchiveAdmissionGate();
    const options = {
      root: target,
      lineageId: 'lineage-1',
      lock,
      lifetimeLease: lease,
      admissionGate: gate,
      unknown: true,
    };
    const token = gate.enter();
    await expect(openFilesystemArchiveAnchorStore(token, options)).rejects.toThrow('exact schema');
    const accessor = { root: target, lineageId: 'lineage-1', lock, lifetimeLease: lease, admissionGate: gate };
    Object.defineProperty(accessor, 'root', { enumerable: true, get: () => target });
    await expect(openFilesystemArchiveAnchorStore(token, accessor)).rejects.toThrow('own data property');
    gate.leave(token);
  });
});
