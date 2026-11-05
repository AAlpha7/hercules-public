import { createHash, randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
  link,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  MAX_ARTIFACT_BYTES,
  assertArtifactArchiveAdmissionGate,
  assertSha256Digest,
  snapshotArtifactAccessContext,
  type ArtifactAccessClass,
  type ArtifactAccessContext,
  type ArtifactArchiveAdmissionGate,
  type ArtifactArchiveAdmissionToken,
  type Sha256Digest,
} from './archiveTypes.js';
import {
  ArchiveLockManager,
  openArchiveLockManager,
  type ArchiveLockLease,
} from './archiveLock.js';
import {
  ArtifactContentError,
  type ArtifactContentReceipt,
  type ArtifactContentStore,
  type ArtifactContentWrite,
  type ArtifactOrphan,
} from './artifactStore.js';
import { scanArtifactSecrets } from './secretScanner.js';

const CONTENT_TEMP_RE = /^content-([0-9a-f]{64})-([0-9a-f]{32})\.tmp$/;
const ANCHOR_TEMP_RE =
  /^anchor-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const SHARD_RE = /^[0-9a-f]{2}$/;
const HEX_DIGEST_RE = /^[0-9a-f]{64}$/;
const MAX_ORPHAN_PAGE = 4_096;
const MAX_SHARED_ANCHOR_TEMP_BYTES = 1024 * 1024;

export interface FilesystemArtifactStoreFaultHooks {
  /** Test-only crash boundary: thrown errors intentionally leave the linked temp. */
  readonly beforePublishLink?: (tempPath: string, finalPath: string) => void | Promise<void>;
  readonly afterLinkBeforeTempUnlink?: (tempPath: string) => void | Promise<void>;
  readonly afterPublishConflictBeforeTempUnlink?: (tempPath: string) => void | Promise<void>;
  readonly beforeRetiredUnlink?: () => void | Promise<void>;
  readonly beforeOrphanUnlink?: () => void | Promise<void>;
  readonly afterContentReadBeforeReprove?: () => void | Promise<void>;
}

export interface SharedAnchorTempClaim {
  readonly name: string;
  readonly byteLength: number;
  readonly linkCount: 1 | 2;
}

export interface FilesystemArtifactStoreOptions {
  readonly root: string;
  readonly admissionGate: ArtifactArchiveAdmissionGate;
  readonly lock?: ArchiveLockManager;
  readonly lifetimeLease?: ArchiveLockLease;
  readonly forbiddenRoots?: readonly string[];
  readonly maxArtifactBytes?: number;
  readonly now?: () => Date;
  readonly resolveAccessClass?: (
    token: ArtifactArchiveAdmissionToken,
    digest: Sha256Digest,
  ) => ArtifactAccessClass | Promise<ArtifactAccessClass>;
  readonly faultHooks?: FilesystemArtifactStoreFaultHooks;
  readonly claimAnchorTemp?: (
    token: ArtifactArchiveAdmissionToken,
    candidate: SharedAnchorTempClaim,
    lease: ArchiveLockLease,
  ) => void | Promise<void>;
}

interface FilesystemArtifactStoreOptionsSnapshot {
  readonly root: string;
  readonly admissionGate: ArtifactArchiveAdmissionGate;
  readonly lock: ArchiveLockManager | null;
  readonly lifetimeLease: ArchiveLockLease | null;
  readonly forbiddenRoots: readonly string[];
  readonly maxArtifactBytes: number;
  readonly now: () => Date;
  readonly resolveAccessClass: (
    token: ArtifactArchiveAdmissionToken,
    digest: Sha256Digest,
  ) => ArtifactAccessClass | Promise<ArtifactAccessClass>;
  readonly faultHooks: FilesystemArtifactStoreFaultHooks;
  readonly claimAnchorTemp: (
    (
      token: ArtifactArchiveAdmissionToken,
      candidate: SharedAnchorTempClaim,
      lease: ArchiveLockLease,
    ) => void | Promise<void>
  ) | null;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface PreparedFilesystemArtifactRoot {
  readonly root: string;
  readonly device: number;
  readonly inode: number;
}

interface DirectoryIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

interface VerifiedFile {
  readonly receipt: ArtifactContentReceipt;
  readonly bytes: Uint8Array;
  readonly identity: FileIdentity;
  readonly modifiedAt: string;
}

interface OrphanProof extends FileIdentity {
  readonly owner: object;
}

const orphanProofs = new WeakMap<object, OrphanProof>();

function nodeErrno(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return null;
}

function snapshotOptions(
  options: FilesystemArtifactStoreOptions,
): FilesystemArtifactStoreOptionsSnapshot {
  const root = options.root;
  const admissionGate = options.admissionGate;
  assertArtifactArchiveAdmissionGate(admissionGate);
  const lock = options.lock ?? null;
  const lifetimeLease = options.lifetimeLease ?? null;
  if ((lock === null) !== (lifetimeLease === null)) {
    throw new ArtifactContentError('unsafe_root', { operation: 'external_lock_pair' });
  }
  if (lock !== null && !(lock instanceof ArchiveLockManager)) {
    throw new ArtifactContentError('unsafe_root', { operation: 'external_lock_manager' });
  }
  const configuredRoots = options.forbiddenRoots ?? [];
  if (!Array.isArray(configuredRoots)) {
    throw new ArtifactContentError('unsafe_root', { operation: 'forbidden_roots_schema' });
  }
  const forbiddenRoots: string[] = [];
  for (let index = 0; index < configuredRoots.length; index += 1) {
    if (!(index in configuredRoots)) {
      throw new ArtifactContentError('unsafe_root', { operation: 'forbidden_roots_dense' });
    }
    const value = configuredRoots[index];
    if (typeof value !== 'string') {
      throw new ArtifactContentError('unsafe_root', { operation: 'forbidden_root_type' });
    }
    forbiddenRoots.push(value);
  }
  const maximum = options.maxArtifactBytes ?? MAX_ARTIFACT_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_ARTIFACT_BYTES) {
    throw new ArtifactContentError('invalid_size_limit', { operation: 'open_store' });
  }
  const now = options.now ?? (() => new Date());
  const resolveAccessClass = options.resolveAccessClass ?? (() => 'operator' as const);
  const claimAnchorTemp = options.claimAnchorTemp ?? null;
  if (
    typeof root !== 'string' ||
    typeof now !== 'function' ||
    typeof resolveAccessClass !== 'function' ||
    (claimAnchorTemp !== null && typeof claimAnchorTemp !== 'function')
  ) {
    throw new ArtifactContentError('unsafe_root', { operation: 'store_options_schema' });
  }
  const hooks = options.faultHooks ?? {};
  const faultHooks: FilesystemArtifactStoreFaultHooks = Object.freeze({
    ...(hooks.beforePublishLink === undefined
      ? {}
      : { beforePublishLink: hooks.beforePublishLink }),
    ...(hooks.afterLinkBeforeTempUnlink === undefined
      ? {}
      : { afterLinkBeforeTempUnlink: hooks.afterLinkBeforeTempUnlink }),
    ...(hooks.afterPublishConflictBeforeTempUnlink === undefined
      ? {}
      : { afterPublishConflictBeforeTempUnlink: hooks.afterPublishConflictBeforeTempUnlink }),
    ...(hooks.beforeRetiredUnlink === undefined
      ? {}
      : { beforeRetiredUnlink: hooks.beforeRetiredUnlink }),
    ...(hooks.beforeOrphanUnlink === undefined
      ? {}
      : { beforeOrphanUnlink: hooks.beforeOrphanUnlink }),
    ...(hooks.afterContentReadBeforeReprove === undefined
      ? {}
      : { afterContentReadBeforeReprove: hooks.afterContentReadBeforeReprove }),
  });
  for (const hook of Object.values(faultHooks)) {
    if (typeof hook !== 'function') {
      throw new ArtifactContentError('unsafe_root', { operation: 'fault_hook_schema' });
    }
  }
  return Object.freeze({
    root,
    admissionGate,
    lock,
    lifetimeLease,
    forbiddenRoots: Object.freeze(forbiddenRoots),
    maxArtifactBytes: maximum,
    now,
    resolveAccessClass,
    faultHooks,
    claimAnchorTemp,
  });
}

function failIo(operation: string, error: unknown): never {
  throw new ArtifactContentError('io_failure', {
    operation,
    errno: nodeErrno(error),
  });
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isContainedOrEqual(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function digestHex(digest: Sha256Digest): string {
  return digest.slice('sha256:'.length);
}

function storageKey(digest: Sha256Digest): string {
  const hex = digestHex(digest);
  return join('sha256', hex.slice(0, 2), hex.slice(2, 4), hex);
}

function receiptFor(digest: Sha256Digest, byteLength: number): ArtifactContentReceipt {
  return Object.freeze({ sha256: digest, byteLength, storageKey: storageKey(digest) });
}

function sha256(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function assertPathMatchesVerifiedIdentity(
  path: string,
  expected: FileIdentity,
  operation: string,
): Promise<void> {
  let current: Stats;
  try {
    current = await lstat(path);
  } catch (error) {
    throw new ArtifactContentError('identity_changed', {
      operation,
      errno: nodeErrno(error),
    });
  }
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.uid !== currentUid() ||
    (current.mode & 0o777) !== 0o600 ||
    current.nlink !== 1 ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.size !== expected.size ||
    current.mtimeMs !== expected.mtimeMs
  ) {
    throw new ArtifactContentError('identity_changed', { operation });
  }
}

async function assertTempPathIdentity(
  path: string,
  expected: FileIdentity,
  allowedLinks: readonly number[],
  operation: string,
): Promise<void> {
  let current: Stats;
  try {
    current = await lstat(path);
  } catch (error) {
    throw new ArtifactContentError('unsafe_temp', {
      operation,
      errno: nodeErrno(error),
    });
  }
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.uid !== currentUid() ||
    (current.mode & 0o777) !== 0o600 ||
    !allowedLinks.includes(current.nlink) ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.size !== expected.size ||
    current.mtimeMs !== expected.mtimeMs
  ) {
    throw new ArtifactContentError('unsafe_temp', { operation });
  }
}

async function assertPathAbsent(path: string, operation: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (nodeErrno(error) === 'ENOENT') return;
    throw new ArtifactContentError('identity_changed', {
      operation,
      errno: nodeErrno(error),
    });
  }
  throw new ArtifactContentError('identity_changed', { operation });
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new ArtifactContentError('unsafe_root', { operation: 'uid' });
  return uid;
}

async function fsyncDirectory(path: string): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  } catch (error) {
    failIo('open_directory_for_fsync', error);
  }
  try {
    await handle.sync();
  } catch (error) {
    failIo('fsync_directory', error);
  } finally {
    await handle.close();
  }
}

async function prospectiveCanonical(path: string): Promise<string> {
  let cursor = resolve(path);
  const missingSuffix: string[] = [];
  while (true) {
    try {
      return join(await realpath(cursor), ...missingSuffix);
    } catch (error) {
      if (nodeErrno(error) !== 'ENOENT') failIo('canonicalize', error);
      const parent = dirname(cursor);
      if (parent === cursor) failIo('canonicalize', error);
      missingSuffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

export async function assertProspectiveRootsNonOverlapping(paths: readonly string[]): Promise<void> {
  const canonicalRoots = new Set<string>();
  for (const path of paths) {
    const canonical = await prospectiveCanonical(path);
    if (canonicalRoots.has(canonical)) {
      throw new ArtifactContentError('root_overlap', { operation: 'configured_root_overlap' });
    }
    canonicalRoots.add(canonical);
  }
  for (const path of canonicalRoots) {
    let cursor = dirname(path);
    while (cursor !== dirname(cursor)) {
      if (canonicalRoots.has(cursor)) {
        throw new ArtifactContentError('root_overlap', { operation: 'configured_root_overlap' });
      }
      cursor = dirname(cursor);
    }
    if (canonicalRoots.has(cursor)) {
      throw new ArtifactContentError('root_overlap', { operation: 'configured_root_overlap' });
    }
  }
}

async function assertNoSymlinkAncestors(path: string): Promise<void> {
  const absolute = resolve(path);
  const segments = absolute.split(sep).filter((segment) => segment.length > 0);
  let cursor: string = sep;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    try {
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink()) {
        throw new ArtifactContentError('unsafe_root', { operation: 'symlink_ancestor' });
      }
    } catch (error) {
      if (error instanceof ArtifactContentError) throw error;
      if (nodeErrno(error) === 'ENOENT') return;
      failIo('lstat_ancestor', error);
    }
  }
}

async function assertPrivateDirectory(path: string, operation: string): Promise<Stats> {
  let entry: Stats;
  try {
    entry = await lstat(path);
  } catch (error) {
    failIo(operation, error);
  }
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    entry.uid !== currentUid() ||
    (entry.mode & 0o777) !== 0o700
  ) {
    throw new ArtifactContentError('unsafe_directory', { operation });
  }
  const canonical = await prospectiveCanonical(path);
  if (canonical !== resolve(path)) {
    throw new ArtifactContentError('unsafe_directory', { operation: `${operation}_canonical` });
  }
  return entry;
}

async function ensurePrivateDirectory(path: string): Promise<boolean> {
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (nodeErrno(error) !== 'EEXIST') failIo('mkdir_private', error);
  }
  await assertPrivateDirectory(path, 'verify_private_directory');
  if (created) await fsyncDirectory(dirname(path));
  return created;
}

async function createRoot(options: {
  readonly root: string;
  readonly forbiddenRoots: readonly string[];
}): Promise<{
  readonly root: string;
  readonly identity: FileIdentity;
}> {
  if (!isAbsolute(options.root) || resolve(options.root) !== options.root) {
    throw new ArtifactContentError('unsafe_root', { operation: 'absolute_root' });
  }
  await assertNoSymlinkAncestors(options.root);
  const parent = dirname(options.root);
  let parentEntry: Stats;
  try {
    parentEntry = await lstat(parent);
  } catch (error) {
    failIo('lstat_root_parent', error);
  }
  if (!parentEntry.isDirectory() || parentEntry.isSymbolicLink()) {
    throw new ArtifactContentError('unsafe_root', { operation: 'root_parent' });
  }
  let created = false;
  try {
    await mkdir(options.root, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (nodeErrno(error) !== 'EEXIST') failIo('mkdir_root', error);
  }
  let rootEntry: Stats;
  try {
    rootEntry = await lstat(options.root);
  } catch (error) {
    failIo('lstat_root', error);
  }
  if (
    !rootEntry.isDirectory() ||
    rootEntry.isSymbolicLink() ||
    rootEntry.uid !== currentUid() ||
    (rootEntry.mode & 0o777) !== 0o700
  ) {
    throw new ArtifactContentError('unsafe_root', { operation: 'root_mode_owner' });
  }
  const canonical = await realpath(options.root);
  if (canonical !== options.root) {
    throw new ArtifactContentError('unsafe_root', { operation: 'root_canonical' });
  }
  for (const configured of options.forbiddenRoots ?? []) {
    if (!isAbsolute(configured)) {
      throw new ArtifactContentError('unsafe_root', { operation: 'forbidden_root_absolute' });
    }
    const forbidden = await prospectiveCanonical(configured);
    if (isContainedOrEqual(canonical, forbidden) || isContainedOrEqual(forbidden, canonical)) {
      throw new ArtifactContentError('root_overlap', { operation: 'forbidden_root_overlap' });
    }
  }
  if (created) await fsyncDirectory(parent);
  return {
    root: canonical,
    identity: {
      dev: rootEntry.dev,
      ino: rootEntry.ino,
      size: rootEntry.size,
      mtimeMs: rootEntry.mtimeMs,
    },
  };
}

export async function prepareFilesystemArtifactRoot(
  root: string,
  forbiddenRoots: readonly string[],
): Promise<Readonly<PreparedFilesystemArtifactRoot>> {
  const prepared = await createRoot({ root, forbiddenRoots });
  return Object.freeze({
    root: prepared.root,
    device: prepared.identity.dev,
    inode: prepared.identity.ino,
  });
}

function assertDigest(value: string): asserts value is Sha256Digest {
  try {
    assertSha256Digest(value, 'sha256');
  } catch {
    throw new ArtifactContentError('invalid_digest', { operation: 'digest' });
  }
}

function snapshotOwnedBytes(input: ArtifactContentWrite): Uint8Array {
  let source: Uint8Array;
  try {
    source = input.bytes;
  } catch {
    throw new ArtifactContentError('invalid_byte_length', { operation: 'content_bytes' });
  }
  try {
    if (
      !(source instanceof Uint8Array) ||
      (!Buffer.isBuffer(source) && Object.getPrototypeOf(source) !== Uint8Array.prototype) ||
      (typeof SharedArrayBuffer !== 'undefined' && source.buffer instanceof SharedArrayBuffer) ||
      Object.prototype.hasOwnProperty.call(source, Symbol.iterator)
    ) {
      throw new ArtifactContentError('invalid_byte_length', { operation: 'content_bytes' });
    }
    const byteLength = source.byteLength;
    const snapshot = new Uint8Array(byteLength);
    Uint8Array.prototype.set.call(snapshot, source);
    if (source.byteLength !== byteLength || snapshot.byteLength !== byteLength) {
      throw new ArtifactContentError('invalid_byte_length', { operation: 'content_bytes' });
    }
    return snapshot;
  } catch (error) {
    if (error instanceof ArtifactContentError) throw error;
    throw new ArtifactContentError('invalid_byte_length', { operation: 'content_bytes' });
  }
}

function snapshotDigestSet(
  value: ReadonlySet<Sha256Digest>,
  operation: string,
): ReadonlySet<Sha256Digest> {
  try {
    if (Object.getPrototypeOf(value) !== Set.prototype) {
      throw new ArtifactContentError('invalid_orphan_request', { operation });
    }
    const snapshot = new Set<Sha256Digest>();
    const iterator = Set.prototype.values.call(value) as SetIterator<Sha256Digest>;
    for (const digest of iterator) {
      assertDigest(digest);
      snapshot.add(digest);
    }
    return snapshot;
  } catch (error) {
    if (error instanceof ArtifactContentError) throw error;
    throw new ArtifactContentError('invalid_orphan_request', { operation });
  }
}

function snapshotCutoff(value: Date): number {
  let milliseconds: number;
  try {
    if (Object.getPrototypeOf(value) !== Date.prototype) {
      throw new ArtifactContentError('invalid_orphan_request', { operation: 'orphan_cutoff' });
    }
    milliseconds = Date.prototype.getTime.call(value);
  } catch (error) {
    if (error instanceof ArtifactContentError) throw error;
    throw new ArtifactContentError('invalid_orphan_request', { operation: 'orphan_cutoff' });
  }
  if (!Number.isFinite(milliseconds)) {
    throw new ArtifactContentError('invalid_orphan_request', { operation: 'orphan_cutoff' });
  }
  return milliseconds;
}

export class FilesystemArtifactStore implements ArtifactContentStore {
  readonly #root: string;
  readonly #rootIdentity: FileIdentity;
  readonly #maxBytes: number;
  readonly #lock: ArchiveLockManager;
  readonly #lifetimeLease: ArchiveLockLease;
  readonly #admissionGate: ArtifactArchiveAdmissionGate;
  readonly #releaseLeaseOnClose: boolean;
  readonly #now: () => Date;
  readonly #resolveAccessClass: (
    token: ArtifactArchiveAdmissionToken,
    digest: Sha256Digest,
  ) => ArtifactAccessClass | Promise<ArtifactAccessClass>;
  readonly #faultHooks: FilesystemArtifactStoreFaultHooks;
  readonly #claimAnchorTemp:
    | ((
        token: ArtifactArchiveAdmissionToken,
        candidate: SharedAnchorTempClaim,
        lease: ArchiveLockLease,
      ) => void | Promise<void>)
    | null;
  #closed = false;
  #poisoned: ArtifactContentError | null = null;
  readonly #orphanOwner = {};

  constructor(input: {
    readonly root: string;
    readonly rootIdentity: FileIdentity;
    readonly maxBytes: number;
    readonly lock: ArchiveLockManager;
    readonly lifetimeLease: ArchiveLockLease;
    readonly admissionGate: ArtifactArchiveAdmissionGate;
    readonly releaseLeaseOnClose: boolean;
    readonly now: () => Date;
    readonly resolveAccessClass: (
      token: ArtifactArchiveAdmissionToken,
      digest: Sha256Digest,
    ) => ArtifactAccessClass | Promise<ArtifactAccessClass>;
    readonly faultHooks: FilesystemArtifactStoreFaultHooks;
    readonly claimAnchorTemp:
      | ((
          token: ArtifactArchiveAdmissionToken,
          candidate: SharedAnchorTempClaim,
          lease: ArchiveLockLease,
        ) => void | Promise<void>)
      | null;
  }) {
    this.#root = input.root;
    this.#rootIdentity = input.rootIdentity;
    this.#maxBytes = input.maxBytes;
    this.#lock = input.lock;
    this.#lifetimeLease = input.lifetimeLease;
    this.#admissionGate = input.admissionGate;
    this.#releaseLeaseOnClose = input.releaseLeaseOnClose;
    this.#now = input.now;
    this.#resolveAccessClass = input.resolveAccessClass;
    this.#faultHooks = input.faultHooks;
    this.#claimAnchorTemp = input.claimAnchorTemp;
  }

  async withLease<T>(
    token: ArtifactArchiveAdmissionToken,
    operation: (lease: ArchiveLockLease) => Promise<T>,
  ): Promise<T> {
    this.#admissionGate.assertOwns(token);
    if (this.#poisoned !== null) throw this.#poisoned;
    if (this.#closed) {
      throw new ArtifactContentError('store_closed', { operation: 'with_lease' });
    }
    await this.#lock.assertOwns(this.#lifetimeLease);
    this.#admissionGate.assertOwns(token);
    try {
      const result = await operation(this.#lifetimeLease);
      await this.#lock.assertOwns(this.#lifetimeLease);
      this.#admissionGate.assertOwns(token);
      return result;
    } catch (error) {
      if (
        error instanceof ArtifactContentError &&
        [
          'unsafe_root',
          'unsafe_directory',
          'unsafe_content_file',
          'missing_content',
          'digest_mismatch',
          'length_mismatch',
          'identity_changed',
          'unsafe_temp',
          'unknown_archive_entry',
          'orphan_is_referenced',
          'invalid_access_policy',
        ].includes(error.reason)
      ) {
        this.#poisoned ??= error;
      }
      throw error;
    }
  }

  async close(token: ArtifactArchiveAdmissionToken): Promise<void> {
    this.#admissionGate.assertOwns(token);
    if (this.#closed) return;
    this.#closed = true;
    if (this.#releaseLeaseOnClose) await this.#lifetimeLease.release();
  }

  async #assertBoundary(
    token: ArtifactArchiveAdmissionToken,
    lease: ArchiveLockLease,
  ): Promise<void> {
    this.#admissionGate.assertOwns(token);
    if (this.#poisoned !== null) throw this.#poisoned;
    if (this.#closed || lease !== this.#lifetimeLease) {
      throw new ArtifactContentError('store_closed', { operation: 'archive_boundary' });
    }
    await this.#lock.assertOwns(lease);
    this.#admissionGate.assertOwns(token);
    let root: Stats;
    let canonicalRoot: string;
    try {
      root = await lstat(this.#root);
      canonicalRoot = await realpath(this.#root);
    } catch (error) {
      throw new ArtifactContentError('unsafe_root', {
        operation: 'recheck_root',
        errno: nodeErrno(error),
      });
    }
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      root.dev !== this.#rootIdentity.dev ||
      root.ino !== this.#rootIdentity.ino ||
      root.uid !== currentUid() ||
      (root.mode & 0o777) !== 0o700 ||
      canonicalRoot !== this.#root
    ) {
      throw new ArtifactContentError('unsafe_root', { operation: 'root_identity' });
    }
    this.#admissionGate.assertOwns(token);
  }

  async #assertContentDirectories(
    digest: Sha256Digest,
  ): Promise<readonly DirectoryIdentity[]> {
    const hex = digestHex(digest);
    const paths = [
      join(this.#root, 'sha256'),
      join(this.#root, 'sha256', hex.slice(0, 2)),
      join(this.#root, 'sha256', hex.slice(0, 2), hex.slice(2, 4)),
    ];
    const identities: DirectoryIdentity[] = [];
    for (let index = 0; index < paths.length; index += 1) {
      const path = paths[index];
      if (path === undefined) continue;
      const entry = await assertPrivateDirectory(path, `content_directory_${index}`);
      identities.push({ path, dev: entry.dev, ino: entry.ino });
    }
    return identities;
  }

  async #reproveDirectories(identities: readonly DirectoryIdentity[]): Promise<void> {
    for (const identity of identities) {
      const current = await assertPrivateDirectory(identity.path, 'reprove_content_directory');
      if (current.dev !== identity.dev || current.ino !== identity.ino) {
        throw new ArtifactContentError('identity_changed', {
          operation: 'content_directory_identity',
        });
      }
    }
  }

  async #ensureContentDirectories(digest: Sha256Digest): Promise<void> {
    const hex = digestHex(digest);
    const first = join(this.#root, 'sha256', hex.slice(0, 2));
    const second = join(first, hex.slice(2, 4));
    const firstCreated = await ensurePrivateDirectory(first);
    const secondCreated = await ensurePrivateDirectory(second);
    // A directory entry becomes durable when its parent is synced. Repeating
    // these bottom-up syncs is harmless when ensurePrivateDirectory synced too.
    if (secondCreated) await fsyncDirectory(first);
    if (firstCreated) await fsyncDirectory(join(this.#root, 'sha256'));
  }

  async #verifiedFile(
    digest: Sha256Digest,
    expectedLength: number | null,
    allowedLinks = 1,
  ): Promise<VerifiedFile> {
    const directories = await this.#assertContentDirectories(digest);
    const finalPath = join(this.#root, storageKey(digest));
    let pathEntry: Stats;
    try {
      pathEntry = await lstat(finalPath);
    } catch (error) {
      if (nodeErrno(error) === 'ENOENT') {
        throw new ArtifactContentError('missing_content', { operation: 'lstat_content' });
      }
      failIo('lstat_content', error);
    }
    if (
      !pathEntry.isFile() ||
      pathEntry.isSymbolicLink() ||
      pathEntry.uid !== currentUid() ||
      (pathEntry.mode & 0o777) !== 0o600 ||
      pathEntry.nlink !== allowedLinks
    ) {
      throw new ArtifactContentError('unsafe_content_file', { operation: 'content_path' });
    }
    let handle: FileHandle;
    try {
      handle = await open(finalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (nodeErrno(error) === 'ENOENT') {
        throw new ArtifactContentError('missing_content', { operation: 'open_content' });
      }
      failIo('open_content', error);
    }
    try {
      const before = await handle.stat();
      if (
        !sameIdentity(pathEntry, before) ||
        !before.isFile() ||
        before.uid !== currentUid() ||
        (before.mode & 0o777) !== 0o600 ||
        before.nlink !== allowedLinks
      ) {
        throw new ArtifactContentError('unsafe_content_file', { operation: 'content_identity' });
      }
      if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > this.#maxBytes) {
        throw new ArtifactContentError('content_too_large', { operation: 'stored_content_size' });
      }
      if (expectedLength !== null && before.size !== expectedLength) {
        throw new ArtifactContentError('length_mismatch', { operation: 'stored_content_length' });
      }
      const bytes = Uint8Array.from(await handle.readFile());
      if (this.#faultHooks.afterContentReadBeforeReprove !== undefined) {
        await this.#faultHooks.afterContentReadBeforeReprove();
      }
      const after = await handle.stat();
      if (
        !sameIdentity(before, after) ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        after.nlink !== allowedLinks ||
        !after.isFile() ||
        after.uid !== currentUid() ||
        (after.mode & 0o777) !== 0o600
      ) {
        throw new ArtifactContentError('identity_changed', { operation: 'read_content' });
      }
      if (sha256(bytes) !== digest) {
        throw new ArtifactContentError('digest_mismatch', { operation: 'read_content' });
      }
      await this.#reproveDirectories(directories);
      return {
        receipt: receiptFor(digest, bytes.byteLength),
        bytes,
        identity: {
          dev: after.dev,
          ino: after.ino,
          size: after.size,
          mtimeMs: after.mtimeMs,
        },
        modifiedAt: after.mtime.toISOString(),
      };
    } finally {
      await handle.close();
    }
  }

  async put(
    token: ArtifactArchiveAdmissionToken,
    input: ArtifactContentWrite,
    lease: ArchiveLockLease,
  ): Promise<ArtifactContentReceipt> {
    this.#admissionGate.assertOwns(token);
    const bytes = snapshotOwnedBytes(input);
    if (bytes.byteLength > this.#maxBytes) {
      throw new ArtifactContentError('content_too_large', { operation: 'put' });
    }
    scanArtifactSecrets({ bytes });
    const digest = sha256(bytes);
    await this.#assertBoundary(token, lease);
    await this.#ensureContentDirectories(digest);
    const finalPath = join(this.#root, storageKey(digest));
    try {
      const existing = await this.#verifiedFile(digest, bytes.byteLength);
      await this.#assertBoundary(token, lease);
      return existing.receipt;
    } catch (error) {
      if (!(error instanceof ArtifactContentError) || error.reason !== 'missing_content') throw error;
    }

    const tempPath = join(
      this.#root,
      '.tmp',
      `content-${digestHex(digest)}-${randomBytes(16).toString('hex')}.tmp`,
    );
    let tempHandle: FileHandle | null = null;
    let tempIdentity: FileIdentity | null = null;
    let preserveCrashResidue = false;
    try {
      tempHandle = await open(
        tempPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      await tempHandle.writeFile(bytes);
      await tempHandle.sync();
      const tempBefore = await tempHandle.stat();
      if (
        !tempBefore.isFile() ||
        tempBefore.uid !== currentUid() ||
        (tempBefore.mode & 0o777) !== 0o600 ||
        tempBefore.nlink !== 1 ||
        tempBefore.size !== bytes.byteLength
      ) {
        throw new ArtifactContentError('unsafe_temp', { operation: 'verify_temp' });
      }
      const rereadBuffer = Buffer.alloc(bytes.byteLength);
      const rereadResult = await tempHandle.read(
        rereadBuffer,
        0,
        rereadBuffer.byteLength,
        0,
      );
      if (rereadResult.bytesRead !== rereadBuffer.byteLength) {
        throw new ArtifactContentError('unsafe_temp', { operation: 'reread_temp_length' });
      }
      const reread = Uint8Array.from(rereadBuffer);
      const tempAfter = await tempHandle.stat();
      if (!sameIdentity(tempBefore, tempAfter) || sha256(reread) !== digest) {
        throw new ArtifactContentError('unsafe_temp', { operation: 'reread_temp' });
      }
      tempIdentity = {
        dev: tempAfter.dev,
        ino: tempAfter.ino,
        size: tempAfter.size,
        mtimeMs: tempAfter.mtimeMs,
      };
      await tempHandle.close();
      tempHandle = null;
      await this.#assertBoundary(token, lease);

      if (this.#faultHooks.beforePublishLink !== undefined) {
        await this.#faultHooks.beforePublishLink(tempPath, finalPath);
      }
      try {
        await link(tempPath, finalPath);
      } catch (error) {
        if (nodeErrno(error) !== 'EEXIST') failIo('publish_link', error);
        const winner = await this.#verifiedFile(digest, bytes.byteLength);
        if (this.#faultHooks.afterPublishConflictBeforeTempUnlink !== undefined) {
          await this.#faultHooks.afterPublishConflictBeforeTempUnlink(tempPath);
        }
        await assertTempPathIdentity(
          tempPath,
          tempIdentity,
          [1],
          'publish_conflict_temp_unlink_reproof',
        );
        await unlink(tempPath);
        await assertPathAbsent(tempPath, 'publish_conflict_temp_unlink_absence');
        await fsyncDirectory(join(this.#root, '.tmp'));
        await assertPathAbsent(tempPath, 'publish_conflict_temp_unlink_durable_absence');
        await this.#assertBoundary(token, lease);
        return winner.receipt;
      }
      await fsyncDirectory(dirname(finalPath));
      if (this.#faultHooks.afterLinkBeforeTempUnlink !== undefined) {
        preserveCrashResidue = true;
        await this.#faultHooks.afterLinkBeforeTempUnlink(tempPath);
        preserveCrashResidue = false;
      }
      await assertTempPathIdentity(
        tempPath,
        tempIdentity,
        [2],
        'published_temp_unlink_reproof',
      );
      await unlink(tempPath);
      await assertPathAbsent(tempPath, 'published_temp_unlink_absence');
      await fsyncDirectory(join(this.#root, '.tmp'));
      await assertPathAbsent(tempPath, 'published_temp_unlink_durable_absence');
      const verified = await this.#verifiedFile(digest, bytes.byteLength);
      await this.#assertBoundary(token, lease);
      return verified.receipt;
    } catch (error) {
      if (tempHandle !== null) {
        try {
          await tempHandle.close();
        } catch (closeError) {
          if (!(error instanceof ArtifactContentError)) failIo('close_temp', closeError);
        }
      }
      if (!preserveCrashResidue && tempIdentity !== null) {
        try {
          await assertTempPathIdentity(
            tempPath,
            tempIdentity,
            [1, 2],
            'cleanup_temp_reproof',
          );
          await unlink(tempPath);
          await assertPathAbsent(tempPath, 'cleanup_temp_absence');
          await fsyncDirectory(join(this.#root, '.tmp'));
          await assertPathAbsent(tempPath, 'cleanup_temp_durable_absence');
        } catch (cleanupError) {
          if (
            !(
              cleanupError instanceof ArtifactContentError &&
              cleanupError.errno === 'ENOENT'
            )
          ) {
            throw new ArtifactContentError('unsafe_temp', { operation: 'cleanup_temp' });
          }
        }
      }
      throw error;
    }
  }

  async verifyClosedLayout(
    token: ArtifactArchiveAdmissionToken,
    lease: ArchiveLockLease,
  ): Promise<void> {
    await this.#assertBoundary(token, lease);
    const entries = await readdir(this.#root, { withFileTypes: true });
    const expected = new Set(['.archive.lock', '.tmp', 'anchors', 'sha256']);
    if (
      entries.length !== expected.size ||
      entries.some((entry) => !expected.has(entry.name))
    ) {
      throw new ArtifactContentError('unknown_archive_entry', { operation: 'root_layout' });
    }
    for (const name of ['.tmp', 'anchors', 'sha256']) {
      await assertPrivateDirectory(join(this.#root, name), `root_layout_${name}`);
    }
    const lockPath = join(this.#root, '.archive.lock');
    let lockEntry: Stats;
    try {
      lockEntry = await lstat(lockPath);
    } catch (error) {
      throw new ArtifactContentError('unsafe_root', {
        operation: 'root_layout_lock',
        errno: nodeErrno(error),
      });
    }
    if (
      !lockEntry.isFile() ||
      lockEntry.isSymbolicLink() ||
      lockEntry.uid !== currentUid() ||
      (lockEntry.mode & 0o777) !== 0o600 ||
      lockEntry.nlink !== 1
    ) {
      throw new ArtifactContentError('unsafe_root', { operation: 'root_layout_lock' });
    }
    await this.#assertBoundary(token, lease);
  }

  async read(
    token: ArtifactArchiveAdmissionToken,
    digest: Sha256Digest,
    access: ArtifactAccessContext,
    lease: ArchiveLockLease,
  ): Promise<Uint8Array> {
    assertDigest(digest);
    this.#admissionGate.assertOwns(token);
    await this.#assertBoundary(token, lease);
    const accessFacts = snapshotArtifactAccessContext(
      access,
      digest,
      this.#now().toISOString(),
    );
    if (
      accessFacts.purpose !== 'read' &&
      accessFacts.purpose !== 'export' &&
      accessFacts.purpose !== 'operator_review'
    ) {
      throw new ArtifactContentError('unsafe_content_file', { operation: 'access_purpose' });
    }
    let required: ArtifactAccessClass;
    try {
      required = await this.#resolveAccessClass(token, digest);
    } catch {
      throw new ArtifactContentError('invalid_access_policy', { operation: 'access_policy' });
    }
    if (required !== 'operator' && required !== 'restricted') {
      throw new ArtifactContentError('invalid_access_policy', { operation: 'access_policy' });
    }
    if (required === 'restricted' && accessFacts.authorizationClass !== 'restricted') {
      throw new ArtifactContentError('unsafe_content_file', { operation: 'access_class' });
    }
    const verified = await this.#verifiedFile(digest, null);
    await this.#assertBoundary(token, lease);
    return Uint8Array.from(verified.bytes);
  }

  async verify(
    token: ArtifactArchiveAdmissionToken,
    digest: Sha256Digest,
    byteLength: number,
    lease: ArchiveLockLease,
  ): Promise<ArtifactContentReceipt> {
    assertDigest(digest);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > this.#maxBytes) {
      throw new ArtifactContentError('invalid_byte_length', { operation: 'verify' });
    }
    this.#admissionGate.assertOwns(token);
    await this.#assertBoundary(token, lease);
    const verified = await this.#verifiedFile(digest, byteLength);
    await this.#assertBoundary(token, lease);
    return verified.receipt;
  }

  async exportVerified(
    token: ArtifactArchiveAdmissionToken,
    digest: Sha256Digest,
    byteLength: number,
    lease: ArchiveLockLease,
  ): Promise<Uint8Array> {
    assertDigest(digest);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > this.#maxBytes) {
      throw new ArtifactContentError('invalid_byte_length', { operation: 'export_verified' });
    }
    this.#admissionGate.assertOwns(token);
    await this.#assertBoundary(token, lease);
    const verified = await this.#verifiedFile(digest, byteLength);
    await this.#assertBoundary(token, lease);
    return Uint8Array.from(verified.bytes);
  }

  async removeRetired(
    token: ArtifactArchiveAdmissionToken,
    digest: Sha256Digest,
    lease: ArchiveLockLease,
  ): Promise<void> {
    this.#admissionGate.assertOwns(token);
    assertDigest(digest);
    await this.#assertBoundary(token, lease);
    const verified = await this.#verifiedFile(digest, null);
    if (this.#faultHooks.beforeRetiredUnlink !== undefined) {
      await this.#faultHooks.beforeRetiredUnlink();
    }
    await this.#assertBoundary(token, lease);
    const finalPath = join(this.#root, verified.receipt.storageKey);
    await assertPathMatchesVerifiedIdentity(finalPath, verified.identity, 'retired_unlink_reproof');
    try {
      await unlink(finalPath);
    } catch (error) {
      failIo('remove_retired', error);
    }
    await assertPathAbsent(finalPath, 'retired_unlink_absence');
    await fsyncDirectory(dirname(finalPath));
    await assertPathAbsent(finalPath, 'retired_unlink_durable_absence');
    await this.#assertBoundary(token, lease);
  }

  async #contentDigests(): Promise<readonly Sha256Digest[]> {
    const base = join(this.#root, 'sha256');
    const digests: Sha256Digest[] = [];
    const firstEntries = await readdir(base, { withFileTypes: true });
    for (const first of firstEntries) {
      if (!first.isDirectory() || !SHARD_RE.test(first.name)) {
        throw new ArtifactContentError('unknown_archive_entry', { operation: 'scan_shard_one' });
      }
      const firstPath = join(base, first.name);
      await assertPrivateDirectory(firstPath, 'scan_shard_one_directory');
      const secondEntries = await readdir(firstPath, { withFileTypes: true });
      for (const second of secondEntries) {
        if (!second.isDirectory() || !SHARD_RE.test(second.name)) {
          throw new ArtifactContentError('unknown_archive_entry', { operation: 'scan_shard_two' });
        }
        const secondPath = join(firstPath, second.name);
        await assertPrivateDirectory(secondPath, 'scan_shard_two_directory');
        const files = await readdir(secondPath, { withFileTypes: true });
        for (const file of files) {
          if (
            !file.isFile() ||
            !HEX_DIGEST_RE.test(file.name) ||
            file.name.slice(0, 2) !== first.name ||
            file.name.slice(2, 4) !== second.name
          ) {
            throw new ArtifactContentError('unknown_archive_entry', { operation: 'scan_content_name' });
          }
          digests.push(`sha256:${file.name}`);
        }
      }
    }
    return digests.sort();
  }

  async scanOrphans(
    token: ArtifactArchiveAdmissionToken,
    cutoff: Date,
    limit: number,
    referencedDigests: ReadonlySet<Sha256Digest>,
    lease: ArchiveLockLease,
  ): Promise<readonly ArtifactOrphan[]> {
    this.#admissionGate.assertOwns(token);
    const cutoffMilliseconds = snapshotCutoff(cutoff);
    const referencedSnapshot = snapshotDigestSet(referencedDigests, 'referenced_digests');
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_ORPHAN_PAGE
    ) {
      throw new ArtifactContentError('invalid_orphan_request', { operation: 'scan_orphans' });
    }
    await this.#assertBoundary(token, lease);
    const result: ArtifactOrphan[] = [];
    for (const digest of await this.#contentDigests()) {
      if (referencedSnapshot.has(digest)) continue;
      const verified = await this.#verifiedFile(digest, null);
      if (verified.identity.mtimeMs > cutoffMilliseconds) continue;
      const orphan: ArtifactOrphan = Object.freeze({
        sha256: digest,
        byteLength: verified.receipt.byteLength,
        modifiedAt: verified.modifiedAt,
      });
      orphanProofs.set(orphan, { ...verified.identity, owner: this.#orphanOwner });
      result.push(orphan);
      if (result.length === limit) break;
    }
    await this.#assertBoundary(token, lease);
    return result;
  }

  async removeOrphan(
    token: ArtifactArchiveAdmissionToken,
    orphan: ArtifactOrphan,
    activeDigests: ReadonlySet<Sha256Digest>,
    lease: ArchiveLockLease,
  ): Promise<void> {
    this.#admissionGate.assertOwns(token);
    const proof = orphanProofs.get(orphan as object);
    if (proof === undefined || proof.owner !== this.#orphanOwner) {
      throw new ArtifactContentError('invalid_orphan_request', { operation: 'remove_orphan' });
    }
    assertDigest(orphan.sha256);
    const activeSnapshot = snapshotDigestSet(activeDigests, 'active_digests');
    if (activeSnapshot.has(orphan.sha256)) {
      throw new ArtifactContentError('orphan_is_referenced', { operation: 'remove_orphan' });
    }
    await this.#assertBoundary(token, lease);
    const verified = await this.#verifiedFile(orphan.sha256, orphan.byteLength);
    if (
      verified.identity.dev !== proof.dev ||
      verified.identity.ino !== proof.ino ||
      verified.identity.size !== proof.size ||
      verified.identity.mtimeMs !== proof.mtimeMs
    ) {
      throw new ArtifactContentError('identity_changed', { operation: 'remove_orphan' });
    }
    if (this.#faultHooks.beforeOrphanUnlink !== undefined) {
      await this.#faultHooks.beforeOrphanUnlink();
    }
    await this.#assertBoundary(token, lease);
    const finalPath = join(this.#root, verified.receipt.storageKey);
    await assertPathMatchesVerifiedIdentity(finalPath, verified.identity, 'orphan_unlink_reproof');
    try {
      await unlink(finalPath);
    } catch (error) {
      failIo('remove_orphan', error);
    }
    await assertPathAbsent(finalPath, 'orphan_unlink_absence');
    await fsyncDirectory(dirname(finalPath));
    await assertPathAbsent(finalPath, 'orphan_unlink_durable_absence');
    orphanProofs.delete(orphan as object);
    await this.#assertBoundary(token, lease);
  }

  async recoverContentTemps(
    token: ArtifactArchiveAdmissionToken,
    lease: ArchiveLockLease,
  ): Promise<void> {
    this.#admissionGate.assertOwns(token);
    await this.#assertBoundary(token, lease);
    const tempRoot = join(this.#root, '.tmp');
    const entries = (await readdir(tempRoot, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (ANCHOR_TEMP_RE.test(entry.name)) {
        const anchorTempPath = join(tempRoot, entry.name);
        const anchorTemp = await lstat(anchorTempPath);
        if (
          !entry.isFile() ||
          !anchorTemp.isFile() ||
          anchorTemp.isSymbolicLink() ||
          anchorTemp.uid !== currentUid() ||
          (anchorTemp.mode & 0o777) !== 0o600 ||
          (anchorTemp.nlink !== 1 && anchorTemp.nlink !== 2) ||
          anchorTemp.size > MAX_SHARED_ANCHOR_TEMP_BYTES ||
          this.#claimAnchorTemp === null
        ) {
          throw new ArtifactContentError('unsafe_temp', { operation: 'claim_anchor_temp' });
        }
        await this.#claimAnchorTemp(
          token,
          Object.freeze({
            name: entry.name,
            byteLength: anchorTemp.size,
            linkCount: anchorTemp.nlink,
          } as SharedAnchorTempClaim),
          lease,
        );
        await assertPathAbsent(anchorTempPath, 'anchor_temp_claim_completion');
        continue;
      }
      const match = CONTENT_TEMP_RE.exec(entry.name);
      if (!entry.isFile() || match === null) {
        throw new ArtifactContentError('unknown_archive_entry', { operation: 'recover_temp_name' });
      }
      const hex = match[1];
      if (hex === undefined) {
        throw new ArtifactContentError('unsafe_temp', { operation: 'recover_temp_digest' });
      }
      const digest: Sha256Digest = `sha256:${hex}`;
      const tempPath = join(tempRoot, entry.name);
      const tempEntry = await lstat(tempPath);
      if (
        !tempEntry.isFile() ||
        tempEntry.isSymbolicLink() ||
        tempEntry.uid !== currentUid() ||
        (tempEntry.mode & 0o777) !== 0o600 ||
        (tempEntry.nlink !== 1 && tempEntry.nlink !== 2) ||
        tempEntry.size > this.#maxBytes
      ) {
        throw new ArtifactContentError('unsafe_temp', { operation: 'recover_temp_identity' });
      }
      if (tempEntry.nlink === 1) {
        throw new ArtifactContentError('unsafe_temp', { operation: 'recover_unlinked_temp' });
      }
      const handle = await open(tempPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Uint8Array;
      try {
        const buffer = Buffer.alloc(tempEntry.size);
        let offset = 0;
        while (offset < buffer.byteLength) {
          const result = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
          if (result.bytesRead === 0) {
            throw new ArtifactContentError('unsafe_temp', { operation: 'recover_temp_short_read' });
          }
          offset += result.bytesRead;
        }
        bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const after = await handle.stat();
        if (
          !sameIdentity(tempEntry, after) ||
          after.uid !== currentUid() ||
          (after.mode & 0o777) !== 0o600 ||
          after.nlink !== 2 ||
          after.size !== tempEntry.size ||
          after.mtimeMs !== tempEntry.mtimeMs
        ) {
          throw new ArtifactContentError('unsafe_temp', { operation: 'recover_temp_race' });
        }
      } finally {
        await handle.close();
      }
      if (sha256(bytes) !== digest) {
        throw new ArtifactContentError('unsafe_temp', { operation: 'recover_temp_hash' });
      }
      await this.#assertContentDirectories(digest);
      const finalEntry = await lstat(join(this.#root, storageKey(digest)));
      if (
        !finalEntry.isFile() ||
        finalEntry.isSymbolicLink() ||
        finalEntry.uid !== currentUid() ||
        (finalEntry.mode & 0o777) !== 0o600 ||
        finalEntry.nlink !== 2 ||
        !sameIdentity(tempEntry, finalEntry) ||
        finalEntry.size !== tempEntry.size ||
        finalEntry.mtimeMs !== tempEntry.mtimeMs
      ) {
        throw new ArtifactContentError('unsafe_temp', { operation: 'recover_temp_link_pair' });
      }
      await assertTempPathIdentity(tempPath, {
        dev: tempEntry.dev,
        ino: tempEntry.ino,
        size: tempEntry.size,
        mtimeMs: tempEntry.mtimeMs,
      }, [2], 'recover_temp_unlink_reproof');
      await unlink(tempPath);
      await assertPathAbsent(tempPath, 'recover_temp_unlink_absence');
      await fsyncDirectory(tempRoot);
      await assertPathAbsent(tempPath, 'recover_temp_unlink_durable_absence');
      await this.#verifiedFile(digest, bytes.byteLength);
    }
    await this.#assertBoundary(token, lease);
  }
}

export async function openFilesystemArtifactStore(
  token: ArtifactArchiveAdmissionToken,
  options: FilesystemArtifactStoreOptions,
): Promise<FilesystemArtifactStore> {
  const snapshot = snapshotOptions(options);
  const admissionGate: ArtifactArchiveAdmissionGate = snapshot.admissionGate;
  admissionGate.assertOwns(token);
  const root = await createRoot(snapshot);
  admissionGate.assertOwns(token);
  const lock = snapshot.lock ?? await openArchiveLockManager(join(root.root, '.archive.lock'));
  const lifetimeLease = snapshot.lifetimeLease ?? await lock.acquire();
  await lock.assertOwns(lifetimeLease);
  admissionGate.assertOwns(token);
  const store = new FilesystemArtifactStore({
    root: root.root,
    rootIdentity: root.identity,
    maxBytes: snapshot.maxArtifactBytes,
    lock,
    lifetimeLease,
    admissionGate,
    releaseLeaseOnClose: snapshot.lock === null,
    now: snapshot.now,
    resolveAccessClass: snapshot.resolveAccessClass,
    faultHooks: snapshot.faultHooks,
    claimAnchorTemp: snapshot.claimAnchorTemp,
  });
  try {
    await store.withLease(token, async (lease) => {
      await ensurePrivateDirectory(join(root.root, 'sha256'));
      await ensurePrivateDirectory(join(root.root, '.tmp'));
      await ensurePrivateDirectory(join(root.root, 'anchors'));
      await store.recoverContentTemps(token, lease);
      await store.verifyClosedLayout(token, lease);
    });
    return store;
  } catch (error) {
    await store.close(token);
    throw error;
  }
}
