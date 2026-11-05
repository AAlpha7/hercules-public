import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import {
  canonicalClone,
  canonicalSerialize,
  hashCanonicalJson,
} from '../../domain/canonicalJson.js';
import {
  ArchiveLockManager,
  type ArchiveLockLease,
} from './archiveLock.js';
import {
  assertArtifactArchiveAdmissionGate,
  type ArtifactArchiveAdmissionGate,
  type ArtifactArchiveAdmissionToken,
} from './archiveTypes.js';

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const ANCHOR_NAME_RE = /^(\d{20})-([0-9a-f]{64})\.json$/;
const ANCHOR_TEMP_RE = /^anchor-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const MAX_TEXT_BYTES = 512;
const DEFAULT_MAXIMUM_ANCHOR_BYTES = 64 * 1024;
const MAXIMUM_ANCHOR_BYTES = 1024 * 1024;

export type ArtifactAnchorMutationKind =
  | 'issue_capture_authorization'
  | 'record_artifact'
  | 'record_manifest'
  | 'retire_artifact';

export interface ArtifactSealedSnapshot {
  readonly schema: 'hercules-artifact-sealed-snapshot/v1';
  readonly lineageId: string;
  readonly eventId: string;
  readonly mutationKind: ArtifactAnchorMutationKind;
  readonly aggregateId: string;
  readonly requestDigest: string;
  readonly sealedThroughSequence: number;
  readonly sealedThroughEventHash: string;
  readonly inventoryDigest: string;
  readonly receiptDigest: string;
  readonly committedAt: string;
}

export interface ArtifactArchiveAnchor extends ArtifactSealedSnapshot {
  readonly previousAnchorHash: string | null;
  readonly anchorHash: string;
}

export interface SharedAnchorTempCandidate {
  readonly name: string;
  readonly byteLength: number;
  readonly linkCount: 1 | 2;
}

export interface ArchiveAnchorFaultHooks {
  readonly afterTempFsyncBeforeLink?: (tempPath: string) => void;
  readonly afterLinkBeforeTempUnlink?: (tempPath: string, finalPath: string) => void;
  readonly afterReadBeforeRecheck?: (path: string) => void;
}

export interface FilesystemArchiveAnchorStoreOptions {
  readonly root: string;
  readonly lineageId: string;
  readonly lock: ArchiveLockManager;
  readonly lifetimeLease: ArchiveLockLease;
  readonly admissionGate: ArtifactArchiveAdmissionGate;
  readonly maximumAnchorBytes?: number;
  readonly faultHooks?: ArchiveAnchorFaultHooks;
}

interface OptionsSnapshot {
  readonly root: string;
  readonly lineageId: string;
  readonly lock: ArchiveLockManager;
  readonly lifetimeLease: ArchiveLockLease;
  readonly admissionGate: ArtifactArchiveAdmissionGate;
  readonly maximumAnchorBytes: number;
  readonly faultHooks: Readonly<ArchiveAnchorFaultHooks>;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
  readonly size: number;
  readonly nlink: number;
  readonly mtimeMs: number;
}

interface DirectoryIdentity extends FileIdentity {
  readonly path: string;
}

export class ArchiveAnchorError extends Error {
  override readonly name = 'ArchiveAnchorError';

  constructor(
    readonly code: 'invalid_input' | 'unsafe_path' | 'integrity' | 'io',
    message: string,
    readonly originalCause?: unknown,
  ) {
    super(message);
  }
}

function fail(
  code: ArchiveAnchorError['code'],
  message: string,
  cause?: unknown,
): never {
  throw new ArchiveAnchorError(code, message, cause);
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) fail('unsafe_path', 'archive ownership cannot be established');
  return uid;
}

function boundedText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES &&
    !containsControlCharacter(value)
  );
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true;
  }
  return false;
}

function canonicalUtc(value: unknown): value is string {
  if (!boundedText(value) || !value.endsWith('Z')) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function readExactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) fail('invalid_input', `${label} must be a plain object`);
  let actual: readonly PropertyKey[];
  try {
    actual = Reflect.ownKeys(value);
  } catch (error) {
    fail('invalid_input', `${label} schema cannot be inspected`, error);
  }
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    fail('invalid_input', `${label} must use the exact schema`);
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch (error) {
      fail('invalid_input', `${label}.${key} cannot be inspected`, error);
    }
    if (descriptor === undefined || !('value' in descriptor)) {
      fail('invalid_input', `${label}.${key} must be an own data property`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function snapshotSealed(value: unknown): Readonly<ArtifactSealedSnapshot> {
  const record = readExactRecord(value, [
    'schema',
    'lineageId',
    'eventId',
    'mutationKind',
    'aggregateId',
    'requestDigest',
    'sealedThroughSequence',
    'sealedThroughEventHash',
    'inventoryDigest',
    'receiptDigest',
    'committedAt',
  ], 'sealed snapshot');
  if (
    record['schema'] !== 'hercules-artifact-sealed-snapshot/v1' ||
    !boundedText(record['lineageId']) ||
    !boundedText(record['eventId']) ||
    ![
      'issue_capture_authorization',
      'record_artifact',
      'record_manifest',
      'retire_artifact',
    ].includes(String(record['mutationKind'])) ||
    !boundedText(record['aggregateId']) ||
    typeof record['requestDigest'] !== 'string' ||
    !HASH_RE.test(record['requestDigest']) ||
    !Number.isSafeInteger(record['sealedThroughSequence']) ||
    (record['sealedThroughSequence'] as number) < 1 ||
    typeof record['sealedThroughEventHash'] !== 'string' ||
    !HASH_RE.test(record['sealedThroughEventHash']) ||
    typeof record['inventoryDigest'] !== 'string' ||
    !HASH_RE.test(record['inventoryDigest']) ||
    typeof record['receiptDigest'] !== 'string' ||
    !HASH_RE.test(record['receiptDigest']) ||
    !canonicalUtc(record['committedAt'])
  ) {
    fail('invalid_input', 'sealed snapshot is invalid');
  }
  return Object.freeze({
    schema: 'hercules-artifact-sealed-snapshot/v1',
    lineageId: record['lineageId'],
    eventId: record['eventId'],
    mutationKind: record['mutationKind'] as ArtifactAnchorMutationKind,
    aggregateId: record['aggregateId'],
    requestDigest: record['requestDigest'],
    sealedThroughSequence: record['sealedThroughSequence'] as number,
    sealedThroughEventHash: record['sealedThroughEventHash'],
    inventoryDigest: record['inventoryDigest'],
    receiptDigest: record['receiptDigest'],
    committedAt: record['committedAt'],
  });
}

function snapshotAnchor(value: unknown): Readonly<ArtifactArchiveAnchor> {
  const record = readExactRecord(value, [
    'schema',
    'lineageId',
    'eventId',
    'mutationKind',
    'aggregateId',
    'requestDigest',
    'sealedThroughSequence',
    'sealedThroughEventHash',
    'inventoryDigest',
    'receiptDigest',
    'committedAt',
    'previousAnchorHash',
    'anchorHash',
  ], 'anchor');
  const snapshot = snapshotSealed({
    schema: record['schema'],
    lineageId: record['lineageId'],
    eventId: record['eventId'],
    mutationKind: record['mutationKind'],
    aggregateId: record['aggregateId'],
    requestDigest: record['requestDigest'],
    sealedThroughSequence: record['sealedThroughSequence'],
    sealedThroughEventHash: record['sealedThroughEventHash'],
    inventoryDigest: record['inventoryDigest'],
    receiptDigest: record['receiptDigest'],
    committedAt: record['committedAt'],
  });
  if (
    (record['previousAnchorHash'] !== null &&
      !HASH_RE.test(String(record['previousAnchorHash']))) ||
    !HASH_RE.test(String(record['anchorHash']))
  ) {
    fail('integrity', 'anchor hash fields are invalid');
  }
  const body = { ...snapshot, previousAnchorHash: record['previousAnchorHash'] as string | null };
  if (record['anchorHash'] !== hashCanonicalJson(body)) {
    fail('integrity', 'anchor hash does not match its body');
  }
  return Object.freeze({ ...body, anchorHash: record['anchorHash'] });
}

export function snapshotArtifactArchiveAnchor(
  value: unknown,
): Readonly<ArtifactArchiveAnchor> {
  return snapshotAnchor(value);
}

function identity(info: Stats): FileIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    uid: info.uid,
    mode: info.mode & 0o777,
    size: info.size,
    nlink: info.nlink,
    mtimeMs: info.mtimeMs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function inspectDirectory(path: string, label: string): DirectoryIdentity {
  let info: Stats;
  try {
    info = lstatSync(path);
  } catch (error) {
    fail('unsafe_path', `${label} cannot be inspected`, error);
  }
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch (error) {
    fail('unsafe_path', `${label} canonical path cannot be established`, error);
  }
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== currentUid() ||
    (info.mode & 0o777) !== 0o700 ||
    canonical !== path
  ) {
    fail('unsafe_path', `${label} is not a private canonical directory`);
  }
  return Object.freeze({ path, ...identity(info) });
}

function assertDirectoryIdentity(expected: DirectoryIdentity, label: string): void {
  const actual = inspectDirectory(expected.path, label);
  if (!sameIdentity(actual, expected)) fail('unsafe_path', `${label} identity changed`);
}

function inspectPrivateFile(path: string, allowedLinks: readonly number[]): FileIdentity {
  let info: Stats;
  try {
    info = lstatSync(path);
  } catch (error) {
    fail('integrity', 'anchor file cannot be inspected', error);
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== currentUid() ||
    (info.mode & 0o777) !== 0o600 ||
    !allowedLinks.includes(info.nlink)
  ) {
    fail('integrity', 'anchor file identity or permissions are invalid');
  }
  return identity(info);
}

function assertFileIdentity(
  path: string,
  expected: FileIdentity,
  allowedLinks: readonly number[],
): FileIdentity {
  const actual = inspectPrivateFile(path, allowedLinks);
  if (!sameIdentity(actual, expected)) fail('integrity', 'anchor file identity changed');
  return actual;
}

function assertPathAbsent(path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    fail('io', 'anchor temp absence cannot be established', error);
  }
  fail('integrity', 'anchor temp remained after owned unlink');
}

function fsyncDirectory(expected: DirectoryIdentity): void {
  let fd: number;
  try {
    fd = openSync(
      expected.path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    fail('io', 'archive directory cannot be opened for durability', error);
  }
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isDirectory() ||
      !sameIdentity(identity(opened), expected) ||
      opened.uid !== currentUid() ||
      (opened.mode & 0o777) !== 0o700
    ) {
      fail('unsafe_path', 'archive durability directory identity changed');
    }
    fsyncSync(fd);
  } catch (error) {
    if (error instanceof ArchiveAnchorError) throw error;
    fail('io', 'archive directory cannot be synchronized', error);
  } finally {
    closeSync(fd);
  }
}

function snapshotOptions(value: unknown): OptionsSnapshot {
  if (!isPlainRecord(value)) fail('invalid_input', 'anchor options must be a plain object');
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch (error) {
    fail('invalid_input', 'anchor options schema cannot be inspected', error);
  }
  const allowed = [
    'root',
    'lineageId',
    'lock',
    'lifetimeLease',
    'admissionGate',
    'maximumAnchorBytes',
    'faultHooks',
  ];
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) {
    fail('invalid_input', 'anchor options must use the exact schema');
  }
  for (const required of ['root', 'lineageId', 'lock', 'lifetimeLease', 'admissionGate']) {
    if (!keys.includes(required)) fail('invalid_input', 'anchor options must use the exact schema');
  }
  const copied: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      fail('invalid_input', `anchor options.${String(key)} must be an own data property`);
    }
    copied[String(key)] = descriptor.value;
  }
  if (typeof copied['root'] !== 'string' || typeof copied['lineageId'] !== 'string') {
    fail('invalid_input', 'anchor root and lineage must be strings');
  }
  if (!(copied['lock'] instanceof ArchiveLockManager)) {
    fail('invalid_input', 'anchor lock must be an archive lock manager');
  }
  if (copied['lifetimeLease'] === null || typeof copied['lifetimeLease'] !== 'object') {
    fail('invalid_input', 'anchor lifetime lease is invalid');
  }
  assertArtifactArchiveAdmissionGate(copied['admissionGate']);
  const maximumAnchorBytes = copied['maximumAnchorBytes'] ?? DEFAULT_MAXIMUM_ANCHOR_BYTES;
  if (
    !Number.isSafeInteger(maximumAnchorBytes) ||
    (maximumAnchorBytes as number) < 1 ||
    (maximumAnchorBytes as number) > MAXIMUM_ANCHOR_BYTES
  ) {
    fail('invalid_input', 'maximum anchor bytes is invalid');
  }
  const hooksValue = copied['faultHooks'] ?? {};
  const hooks = readOptionalHooks(hooksValue);
  return Object.freeze({
    root: copied['root'],
    lineageId: copied['lineageId'],
    lock: copied['lock'],
    lifetimeLease: copied['lifetimeLease'] as ArchiveLockLease,
    admissionGate: copied['admissionGate'],
    maximumAnchorBytes: maximumAnchorBytes as number,
    faultHooks: hooks,
  });
}

function readOptionalHooks(value: unknown): Readonly<ArchiveAnchorFaultHooks> {
  if (!isPlainRecord(value)) fail('invalid_input', 'anchor fault hooks must be a plain object');
  const allowed = [
    'afterTempFsyncBeforeLink',
    'afterLinkBeforeTempUnlink',
    'afterReadBeforeRecheck',
  ];
  const result: Partial<Record<(typeof allowed)[number], (...args: string[]) => void>> = {};
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch (error) {
    fail('invalid_input', 'anchor fault hooks cannot be inspected', error);
  }
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.includes(key)) {
      fail('invalid_input', 'anchor fault hooks must use the exact schema');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'function') {
      fail('invalid_input', `anchor fault hook ${key} must be an own function`);
    }
    result[key] = descriptor.value as (...args: string[]) => void;
  }
  return Object.freeze(result) as Readonly<ArchiveAnchorFaultHooks>;
}

function nameFor(anchor: ArtifactArchiveAnchor): string {
  return `${String(anchor.sealedThroughSequence).padStart(20, '0')}-${anchor.anchorHash.slice('sha256:'.length)}.json`;
}

export interface FilesystemArchiveAnchorStore {
  append(
    token: ArtifactArchiveAdmissionToken,
    input: ArtifactSealedSnapshot,
    lease: ArchiveLockLease,
  ): Promise<Readonly<ArtifactArchiveAnchor>>;
  readAll(token: ArtifactArchiveAdmissionToken, lease: ArchiveLockLease): Promise<readonly ArtifactArchiveAnchor[]>;
  inspectTemp(
    token: ArtifactArchiveAdmissionToken,
    candidate: SharedAnchorTempCandidate,
    lease: ArchiveLockLease,
  ): Promise<Readonly<ArtifactArchiveAnchor>>;
  claimTemp(
    token: ArtifactArchiveAdmissionToken,
    candidate: SharedAnchorTempCandidate,
    expectedSnapshot: ArtifactSealedSnapshot,
    lease: ArchiveLockLease,
  ): Promise<void>;
}

class FilesystemArchiveAnchorStoreImpl implements FilesystemArchiveAnchorStore {
  readonly #root: DirectoryIdentity;
  readonly #anchorRoot: DirectoryIdentity;
  readonly #tempRoot: DirectoryIdentity;
  readonly #lineageId: string;
  readonly #lock: ArchiveLockManager;
  readonly #lifetimeLease: ArchiveLockLease;
  readonly #admissionGate: ArtifactArchiveAdmissionGate;
  readonly #maximumAnchorBytes: number;
  readonly #faultHooks: Readonly<ArchiveAnchorFaultHooks>;
  #poisoned: ArchiveAnchorError | null = null;

  constructor(input: {
    readonly root: DirectoryIdentity;
    readonly anchorRoot: DirectoryIdentity;
    readonly tempRoot: DirectoryIdentity;
    readonly lineageId: string;
    readonly lock: ArchiveLockManager;
    readonly lifetimeLease: ArchiveLockLease;
    readonly admissionGate: ArtifactArchiveAdmissionGate;
    readonly maximumAnchorBytes: number;
    readonly faultHooks: Readonly<ArchiveAnchorFaultHooks>;
  }) {
    this.#root = input.root;
    this.#anchorRoot = input.anchorRoot;
    this.#tempRoot = input.tempRoot;
    this.#lineageId = input.lineageId;
    this.#lock = input.lock;
    this.#lifetimeLease = input.lifetimeLease;
    this.#admissionGate = input.admissionGate;
    this.#maximumAnchorBytes = input.maximumAnchorBytes;
    this.#faultHooks = input.faultHooks;
  }

  async #assertBoundary(
    token: ArtifactArchiveAdmissionToken,
    lease: ArchiveLockLease,
  ): Promise<void> {
    this.#admissionGate.assertOwns(token);
    if (this.#poisoned !== null) throw this.#poisoned;
    if (lease !== this.#lifetimeLease) fail('unsafe_path', 'anchor operation used the wrong lease');
    await this.#lock.assertOwns(lease);
    this.#admissionGate.assertOwns(token);
    try {
      assertDirectoryIdentity(this.#root, 'artifact root');
      assertDirectoryIdentity(this.#anchorRoot, 'anchor directory');
      assertDirectoryIdentity(this.#tempRoot, 'archive temp directory');
      if (this.#root.dev !== this.#anchorRoot.dev || this.#root.dev !== this.#tempRoot.dev) {
        fail('unsafe_path', 'anchor directories no longer share one filesystem');
      }
    } catch (error) {
      if (error instanceof ArchiveAnchorError) this.#poisoned ??= error;
      throw error;
    }
    await this.#lock.assertOwns(lease);
    this.#admissionGate.assertOwns(token);
  }

  async append(
    token: ArtifactArchiveAdmissionToken,
    input: ArtifactSealedSnapshot,
    lease: ArchiveLockLease,
  ): Promise<Readonly<ArtifactArchiveAnchor>> {
    this.#admissionGate.assertOwns(token);
    const snapshot = snapshotSealed(input);
    if (snapshot.lineageId !== this.#lineageId) {
      fail('integrity', 'sealed snapshot lineage does not match the archive');
    }
    await this.#assertBoundary(token, lease);
    const existing = await this.#readChain(token, lease);
    const sameSequence = existing.find(
      (anchor) => anchor.sealedThroughSequence === snapshot.sealedThroughSequence,
    );
    if (sameSequence !== undefined) {
      const expectedBody = { ...snapshot, previousAnchorHash: sameSequence.previousAnchorHash };
      const expected = { ...expectedBody, anchorHash: hashCanonicalJson(expectedBody) };
      if (canonicalSerialize(expected) !== canonicalSerialize(sameSequence)) {
        fail('integrity', 'sealed sequence was already anchored with different facts');
      }
      await this.#assertBoundary(token, lease);
      return canonicalClone(sameSequence);
    }
    const previous = existing.at(-1);
    if ((previous?.sealedThroughSequence ?? 0) >= snapshot.sealedThroughSequence) {
      fail('integrity', 'sealed snapshot sequence must advance the anchor chain');
    }
    if (existing.some((anchor) => anchor.eventId === snapshot.eventId)) {
      fail('integrity', 'archive event identity must be unique');
    }
    const body = { ...snapshot, previousAnchorHash: previous?.anchorHash ?? null };
    const anchor: Readonly<ArtifactArchiveAnchor> = Object.freeze({
      ...body,
      anchorHash: hashCanonicalJson(body),
    });
    const name = nameFor(anchor);
    const finalPath = join(this.#anchorRoot.path, name);
    const bytes = canonicalSerialize(anchor);
    if (Buffer.byteLength(bytes, 'utf8') > this.#maximumAnchorBytes) {
      fail('invalid_input', 'anchor exceeds its configured byte bound');
    }

    const existingWinner = this.#tryReadExisting(finalPath, name);
    if (existingWinner !== null) {
      if (canonicalSerialize(existingWinner) !== bytes) {
        fail('integrity', 'existing anchor conflicts with the sealed snapshot');
      }
      await this.#assertBoundary(token, lease);
      return existingWinner;
    }

    const tempPath = join(this.#tempRoot.path, `anchor-${randomUUID()}.tmp`);
    let tempIdentity: FileIdentity | null = null;
    let linked = false;
    try {
      const fd = openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        fchmodSync(fd, 0o600);
        writeFileSync(fd, bytes, 'utf8');
        fsyncSync(fd);
        const written = fstatSync(fd);
        if (!written.isFile() || written.uid !== currentUid() || (written.mode & 0o777) !== 0o600 || written.nlink !== 1) {
          fail('integrity', 'anchor temp identity changed while writing');
        }
        tempIdentity = identity(written);
      } finally {
        closeSync(fd);
      }
      assertFileIdentity(tempPath, tempIdentity, [1]);
      await this.#assertBoundary(token, lease);
      this.#faultHooks.afterTempFsyncBeforeLink?.(tempPath);
      await this.#assertBoundary(token, lease);
      try {
        linkSync(tempPath, finalPath);
        linked = true;
      } catch (error) {
        const winner = this.#tryReadExisting(finalPath, name);
        if (winner === null || canonicalSerialize(winner) !== bytes) throw error;
      }
      this.#fsyncDirectory(this.#anchorRoot);
      await this.#assertBoundary(token, lease);
      this.#faultHooks.afterLinkBeforeTempUnlink?.(tempPath, finalPath);
      await this.#assertBoundary(token, lease);
      this.#unlinkOwnedTemp(tempPath, tempIdentity, [1, 2]);
      this.#fsyncDirectory(this.#tempRoot);
      assertPathAbsent(tempPath);
      const stored = this.#readOne(finalPath, name);
      if (canonicalSerialize(stored) !== bytes) {
        fail('integrity', 'published anchor differs from its sealed snapshot');
      }
      await this.#assertBoundary(token, lease);
      return stored;
    } catch (error) {
      if (error instanceof ArchiveAnchorError) throw error;
      fail('io', linked
        ? 'anchor publication committed but completion failed'
        : 'anchor publication failed', error);
    }
  }

  async readAll(
    token: ArtifactArchiveAdmissionToken,
    lease: ArchiveLockLease,
  ): Promise<readonly ArtifactArchiveAnchor[]> {
    this.#admissionGate.assertOwns(token);
    await this.#assertBoundary(token, lease);
    const result = await this.#readChain(token, lease);
    await this.#assertBoundary(token, lease);
    return canonicalClone(result);
  }

  async inspectTemp(
    token: ArtifactArchiveAdmissionToken,
    candidate: SharedAnchorTempCandidate,
    lease: ArchiveLockLease,
  ): Promise<Readonly<ArtifactArchiveAnchor>> {
    this.#admissionGate.assertOwns(token);
    const candidateRecord = readExactRecord(
      candidate,
      ['name', 'byteLength', 'linkCount'],
      'anchor temp candidate',
    );
    if (
      typeof candidateRecord['name'] !== 'string' ||
      !ANCHOR_TEMP_RE.test(candidateRecord['name']) ||
      !Number.isSafeInteger(candidateRecord['byteLength']) ||
      (candidateRecord['byteLength'] as number) < 1 ||
      (candidateRecord['byteLength'] as number) > this.#maximumAnchorBytes ||
      (candidateRecord['linkCount'] !== 1 && candidateRecord['linkCount'] !== 2)
    ) {
      fail('invalid_input', 'anchor temp candidate is invalid');
    }
    await this.#assertBoundary(token, lease);
    const tempPath = join(this.#tempRoot.path, candidateRecord['name']);
    const identity = inspectPrivateFile(tempPath, [candidateRecord['linkCount']]);
    if (identity.size !== candidateRecord['byteLength']) {
      fail('integrity', 'anchor temp candidate size changed');
    }
    const anchor = this.#readOne(
      tempPath,
      candidateRecord['name'],
      [candidateRecord['linkCount']],
    );
    assertFileIdentity(tempPath, identity, [candidateRecord['linkCount']]);
    await this.#assertBoundary(token, lease);
    return canonicalClone(anchor);
  }

  async claimTemp(
    token: ArtifactArchiveAdmissionToken,
    candidate: SharedAnchorTempCandidate,
    expectedSnapshot: ArtifactSealedSnapshot,
    lease: ArchiveLockLease,
  ): Promise<void> {
    this.#admissionGate.assertOwns(token);
    const candidateRecord = readExactRecord(candidate, ['name', 'byteLength', 'linkCount'], 'anchor temp candidate');
    if (
      typeof candidateRecord['name'] !== 'string' ||
      !ANCHOR_TEMP_RE.test(candidateRecord['name']) ||
      !Number.isSafeInteger(candidateRecord['byteLength']) ||
      (candidateRecord['byteLength'] as number) < 1 ||
      (candidateRecord['byteLength'] as number) > this.#maximumAnchorBytes ||
      (candidateRecord['linkCount'] !== 1 && candidateRecord['linkCount'] !== 2)
    ) {
      fail('invalid_input', 'anchor temp candidate is invalid');
    }
    const expected = snapshotSealed(expectedSnapshot);
    if (expected.lineageId !== this.#lineageId) fail('integrity', 'recovery lineage is invalid');
    await this.#assertBoundary(token, lease);
    const tempPath = join(this.#tempRoot.path, candidateRecord['name']);
    const tempIdentity = inspectPrivateFile(tempPath, [candidateRecord['linkCount']]);
    if (tempIdentity.size !== candidateRecord['byteLength']) {
      fail('integrity', 'anchor temp candidate size changed');
    }
    const recovered = this.#readOne(
      tempPath,
      candidateRecord['name'],
      [candidateRecord['linkCount']],
    );
    assertFileIdentity(tempPath, tempIdentity, [candidateRecord['linkCount']]);
    const expectedBody = { ...expected, previousAnchorHash: recovered.previousAnchorHash };
    const exactExpected = { ...expectedBody, anchorHash: hashCanonicalJson(expectedBody) };
    if (canonicalSerialize(recovered) !== canonicalSerialize(exactExpected)) {
      fail('integrity', 'anchor temp does not match the immutable sealed snapshot');
    }
    const chain = await this.#readChain(token, lease, nameFor(recovered));
    const previous = chain.at(-1);
    if (
      recovered.previousAnchorHash !== (previous?.anchorHash ?? null) ||
      recovered.sealedThroughSequence <= (previous?.sealedThroughSequence ?? 0) ||
      chain.some((anchor) => anchor.eventId === recovered.eventId)
    ) {
      fail('integrity', 'anchor temp does not extend the verified chain');
    }
    const finalPath = join(this.#anchorRoot.path, nameFor(recovered));
    const winner = this.#tryReadExisting(finalPath, nameFor(recovered), [1, 2]);
    if (winner === null) {
      if (candidateRecord['linkCount'] !== 1) {
        fail('integrity', 'linked anchor temp has no published anchor');
      }
      assertFileIdentity(tempPath, tempIdentity, [1]);
      linkSync(tempPath, finalPath);
      this.#fsyncDirectory(this.#anchorRoot);
    } else {
      if (canonicalSerialize(winner) !== canonicalSerialize(recovered)) {
        fail('integrity', 'anchor temp conflicts with the published anchor');
      }
      if (candidateRecord['linkCount'] === 2) {
        const finalIdentity = inspectPrivateFile(finalPath, [2]);
        if (!sameIdentity(finalIdentity, tempIdentity)) {
          fail('integrity', 'linked anchor temp does not own the published anchor');
        }
      }
    }
    await this.#assertBoundary(token, lease);
    this.#unlinkOwnedTemp(tempPath, tempIdentity, [1, 2]);
    this.#fsyncDirectory(this.#tempRoot);
    assertPathAbsent(tempPath);
    const stored = this.#readOne(finalPath, nameFor(recovered));
    if (canonicalSerialize(stored) !== canonicalSerialize(recovered)) {
      fail('integrity', 'recovered anchor differs from the sealed snapshot');
    }
    await this.#assertBoundary(token, lease);
  }

  async #readChain(
    token: ArtifactArchiveAdmissionToken,
    lease: ArchiveLockLease,
    excludedName?: string,
  ): Promise<readonly ArtifactArchiveAnchor[]> {
    await this.#assertBoundary(token, lease);
    let names: string[];
    try {
      names = readdirSync(this.#anchorRoot.path);
    } catch (error) {
      fail('io', 'anchor directory cannot be read', error);
    }
    names.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    const anchors: ArtifactArchiveAnchor[] = [];
    const eventIds = new Set<string>();
    let previous: string | null = null;
    let sequence = 0;
    for (const name of names) {
      const match = ANCHOR_NAME_RE.exec(name);
      if (match === null) fail('integrity', 'anchor directory contains an unknown entry');
      if (name === excludedName) continue;
      const anchor = this.#readOne(join(this.#anchorRoot.path, name), name);
      const nameSequence = Number(match[1]);
      if (
        anchor.lineageId !== this.#lineageId ||
        eventIds.has(anchor.eventId) ||
        anchor.sealedThroughSequence !== nameSequence ||
        anchor.anchorHash.slice('sha256:'.length) !== match[2] ||
        anchor.previousAnchorHash !== previous ||
        anchor.sealedThroughSequence <= sequence
      ) {
        fail('integrity', 'anchor lineage, identity, filename, or chain is invalid');
      }
      anchors.push(anchor);
      eventIds.add(anchor.eventId);
      previous = anchor.anchorHash;
      sequence = anchor.sealedThroughSequence;
    }
    await this.#assertBoundary(token, lease);
    return anchors;
  }

  #tryReadExisting(
    path: string,
    name: string,
    allowedLinks: readonly number[] = [1],
  ): Readonly<ArtifactArchiveAnchor> | null {
    try {
      lstatSync(path);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        return null;
      }
      fail('integrity', 'existing anchor cannot be inspected', error);
    }
    return this.#readOne(path, name, allowedLinks);
  }

  #readOne(
    path: string,
    name: string,
    allowedLinks: readonly number[] = [1],
  ): Readonly<ArtifactArchiveAnchor> {
    const before = inspectPrivateFile(path, allowedLinks);
    if (before.size < 1 || before.size > this.#maximumAnchorBytes) {
      fail('integrity', `anchor ${name} exceeds the bounded read limit`);
    }
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      fail('integrity', `anchor ${name} cannot be opened safely`, error);
    }
    let bytes: Buffer;
    try {
      const openedBefore = fstatSync(fd);
      if (!sameIdentity(identity(openedBefore), before) || openedBefore.size !== before.size) {
        fail('integrity', `anchor ${name} changed before reading`);
      }
      bytes = Buffer.allocUnsafe(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count === 0) fail('integrity', `anchor ${name} ended before its stated size`);
        offset += count;
      }
      const openedAfter = fstatSync(fd);
      if (
        !sameIdentity(identity(openedAfter), before) ||
        openedAfter.size !== before.size ||
        openedAfter.mtimeMs !== before.mtimeMs ||
        openedAfter.uid !== before.uid ||
        (openedAfter.mode & 0o777) !== before.mode ||
        openedAfter.nlink !== before.nlink
      ) {
        fail('integrity', `anchor ${name} changed while reading`);
      }
    } finally {
      closeSync(fd);
    }
    this.#faultHooks.afterReadBeforeRecheck?.(path);
    let after: FileIdentity;
    try {
      after = assertFileIdentity(path, before, [before.nlink]);
    } catch (error) {
      fail('integrity', 'anchor file changed after reading', error);
    }
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      fail('integrity', `anchor ${name} changed after reading`);
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      fail('integrity', `anchor ${name} is not valid UTF-8`, error);
    }
    if (Buffer.byteLength(text, 'utf8') !== bytes.length) {
      fail('integrity', `anchor ${name} is not valid UTF-8`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      fail('integrity', `anchor ${name} is not JSON`, error);
    }
    const anchor = snapshotAnchor(parsed);
    if (canonicalSerialize(anchor) !== text) {
      fail('integrity', `anchor ${name} is not canonical JSON`);
    }
    return anchor;
  }

  #unlinkOwnedTemp(
    path: string,
    expected: FileIdentity,
    allowedLinks: readonly number[],
  ): void {
    assertFileIdentity(path, expected, allowedLinks);
    try {
      unlinkSync(path);
    } catch (error) {
      fail('io', 'owned anchor temp cannot be removed', error);
    }
  }

  #fsyncDirectory(expected: DirectoryIdentity): void {
    try {
      fsyncDirectory(expected);
    } catch (error) {
      if (error instanceof ArchiveAnchorError && error.code === 'unsafe_path') {
        this.#poisoned ??= error;
      }
      throw error;
    }
  }
}

export async function openFilesystemArchiveAnchorStore(
  token: ArtifactArchiveAdmissionToken,
  value: FilesystemArchiveAnchorStoreOptions,
): Promise<FilesystemArchiveAnchorStore> {
  const options = snapshotOptions(value);
  const admissionGate: ArtifactArchiveAdmissionGate = options.admissionGate;
  admissionGate.assertOwns(token);
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(options.root);
  } catch (error) {
    fail('unsafe_path', 'artifact root cannot be resolved', error);
  }
  if (
    !isAbsolute(options.root) ||
    resolve(options.root) !== options.root ||
    canonicalRoot !== options.root ||
    !boundedText(options.lineageId)
  ) {
    fail('unsafe_path', 'artifact root and lineage must be canonical');
  }
  await options.lock.assertOwns(options.lifetimeLease);
  admissionGate.assertOwns(token);
  const root = inspectDirectory(options.root, 'artifact root');
  const anchorPath = join(root.path, 'anchors');
  const tempPath = join(root.path, '.tmp');
  for (const path of [anchorPath, tempPath]) {
    try {
      mkdirSync(path, { mode: 0o700 });
      fsyncDirectory(root);
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) {
        fail('io', 'anchor directory cannot be created', error);
      }
    }
  }
  const anchorRoot = inspectDirectory(anchorPath, 'anchor directory');
  const tempRoot = inspectDirectory(tempPath, 'archive temp directory');
  if (root.dev !== anchorRoot.dev || root.dev !== tempRoot.dev) {
    fail('unsafe_path', 'anchor directories must share the artifact filesystem');
  }
  await options.lock.assertOwns(options.lifetimeLease);
  admissionGate.assertOwns(token);
  assertDirectoryIdentity(root, 'artifact root');
  assertDirectoryIdentity(anchorRoot, 'anchor directory');
  assertDirectoryIdentity(tempRoot, 'archive temp directory');
  return new FilesystemArchiveAnchorStoreImpl({
    root,
    anchorRoot,
    tempRoot,
    lineageId: options.lineageId,
    lock: options.lock,
    lifetimeLease: options.lifetimeLease,
    admissionGate: options.admissionGate,
    maximumAnchorBytes: options.maximumAnchorBytes,
    faultHooks: options.faultHooks,
  });
}
