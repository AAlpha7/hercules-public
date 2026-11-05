import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { canonicalSerialize, hashCanonicalJson } from '../../domain/canonicalJson.js';
import type {
  ArtifactArchiveLineage,
  ArtifactMetadataSqliteSnapshot,
} from '../state/artifactMetadataStore.js';
import { verifyArtifactMetadataSnapshotBytes } from '../state/sqliteArtifactMetadataStore.js';
import {
  snapshotArtifactArchiveAnchor,
  type ArtifactArchiveAnchor,
} from './archiveAnchor.js';
import { assertCanonicalUtcTimestamp, assertSha256Digest, type Sha256Digest } from './archiveTypes.js';

const BUNDLE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_DATABASE_BYTES = 1024 * 1024 * 1024;
const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const MAX_ANCHOR_BYTES = 1024 * 1024;

export class ArtifactExportError extends Error {
  override readonly name = 'ArtifactExportError';

  constructor(
    readonly code: 'invalid_input' | 'unsafe_path' | 'conflict' | 'integrity' | 'io',
    message: string,
    readonly originalCause?: unknown,
  ) {
    super(message);
  }
}

export interface ArtifactExportBlob {
  readonly sha256: Sha256Digest;
  readonly byteLength: number;
}

export interface ArtifactExportSource {
  readonly bundleName: string;
  readonly createdAt: string;
  readonly databaseLineageId: string;
  readonly lineage: ArtifactArchiveLineage;
  readonly metadata: ArtifactMetadataSqliteSnapshot;
  readonly anchors: readonly ArtifactArchiveAnchor[];
  readonly blobs: readonly ArtifactExportBlob[];
  readonly readBlob: (blob: ArtifactExportBlob) => Promise<Uint8Array>;
}

interface InventoryFile {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
}

interface AnchorInventoryFile extends InventoryFile {
  readonly sealedThroughSequence: number;
  readonly anchorHash: string;
}

export interface ArtifactExportInventory {
  readonly schema: 'hercules-artifact-export-inventory/v1';
  readonly bundleName: string;
  readonly createdAt: string;
  readonly databaseLineageId: string;
  readonly lineage: ArtifactArchiveLineage;
  readonly database: InventoryFile & {
    readonly eventCount: number;
    readonly lastEventHash: string | null;
    readonly v3InventoryDigest: string;
  };
  readonly anchors: readonly AnchorInventoryFile[];
  readonly blobs: readonly InventoryFile[];
}

export interface ArtifactExportReceipt {
  readonly schema: 'hercules-artifact-export-receipt/v1';
  readonly bundleName: string;
  readonly inventorySha256: string;
  readonly databaseSha256: string;
  readonly anchorCount: number;
  readonly blobCount: number;
  readonly completedAt: string;
}

export interface ArtifactExportIntegrityReport extends ArtifactExportReceipt {
  readonly limitation: 'internally_consistent_not_authenticity_signed';
}

function fail(
  code: ArtifactExportError['code'],
  message: string,
  cause?: unknown,
): never {
  throw new ArtifactExportError(code, message, cause);
}

function uid(): number {
  const value = process.getuid?.();
  if (value === undefined) fail('unsafe_path', 'export ownership cannot be established');
  return value;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function snapshotArtifactExportBundleName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !BUNDLE_NAME_RE.test(value) ||
    value === '.' ||
    value === '..' ||
    value.includes('..')
  ) {
    fail('invalid_input', 'export bundle name is invalid');
  }
  return value;
}

function exactKeys(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('integrity', `${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  const actual = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    fail('integrity', `${label} must use the exact schema`);
  }
  return value as Record<string, unknown>;
}

function storageKey(digest: string): string {
  assertSha256Digest(digest, 'export digest');
  const hex = digest.slice('sha256:'.length);
  return join('content', 'sha256', hex.slice(0, 2), hex.slice(2, 4), hex);
}

function anchorName(anchor: ArtifactArchiveAnchor): string {
  return `${String(anchor.sealedThroughSequence).padStart(20, '0')}-${anchor.anchorHash.slice('sha256:'.length)}.json`;
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function inspectDirectory(path: string): Promise<Stats> {
  let info: Stats;
  let canonical: string;
  try {
    info = await lstat(path);
    canonical = await realpath(path);
  } catch (error) {
    fail('unsafe_path', 'export directory cannot be inspected', error);
  }
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== uid() ||
    (info.mode & 0o777) !== 0o700 ||
    canonical !== path
  ) {
    fail('unsafe_path', 'export directory is not private and canonical');
  }
  return info;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) {
      fail('io', 'export directory cannot be created', error);
    }
  }
  await inspectDirectory(path);
  if (created) await fsyncDirectory(dirname(path));
}

function assertNormalizedExportRoot(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) {
    fail('unsafe_path', 'export root must be absolute and normalized');
  }
}

async function assertNoSymlinkAncestors(path: string): Promise<void> {
  const segments = resolve(path).split(sep).filter((segment) => segment.length > 0);
  let cursor: string = sep;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) fail('unsafe_path', 'export root has a symlink ancestor');
    } catch (error) {
      if (error instanceof ArtifactExportError) throw error;
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        return;
      }
      fail('unsafe_path', 'export root ancestor cannot be inspected', error);
    }
  }
}

async function prepareExportRoot(path: string): Promise<void> {
  assertNormalizedExportRoot(path);
  await assertNoSymlinkAncestors(path);
  const parent = dirname(path);
  let parentInfo: Stats;
  try {
    parentInfo = await lstat(parent);
  } catch (error) {
    fail('unsafe_path', 'export root parent cannot be inspected', error);
  }
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    fail('unsafe_path', 'export root parent is unsafe');
  }
  await ensurePrivateDirectory(path);
}

async function inspectExportRoot(path: string): Promise<Stats> {
  assertNormalizedExportRoot(path);
  await assertNoSymlinkAncestors(path);
  return inspectDirectory(path);
}

async function assertDirectoryIdentity(path: string, expected: Stats): Promise<void> {
  const current = await inspectDirectory(path);
  if (!sameIdentity(current, expected)) {
    fail('integrity', 'export directory identity changed during verification');
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  } catch (error) {
    fail('io', 'export directory cannot be opened for fsync', error);
  }
  try {
    await handle.sync();
  } catch (error) {
    fail('io', 'export directory cannot be fsynced', error);
  } finally {
    await handle.close();
  }
}

async function writePrivateFile(path: string, bytes: Uint8Array): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    fail('conflict', 'export file already exists or cannot be created', error);
  }
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.uid !== uid() ||
      (info.mode & 0o777) !== 0o600 ||
      info.nlink !== 1 ||
      info.size !== bytes.byteLength
    ) {
      fail('integrity', 'written export file identity is unsafe');
    }
  } finally {
    await handle.close();
  }
  const stored = await readPrivateFile(path, bytes.byteLength, bytes.byteLength);
  if (sha256(stored) !== sha256(bytes)) fail('integrity', 'written export file changed');
  await fsyncDirectory(dirname(path));
}

async function readPrivateFile(
  path: string,
  maximumBytes: number,
  expectedBytes?: number,
): Promise<Uint8Array> {
  let before: Stats;
  try {
    before = await lstat(path);
  } catch (error) {
    fail('integrity', 'export file is missing', error);
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.uid !== uid() ||
    (before.mode & 0o777) !== 0o600 ||
    before.nlink !== 1 ||
    !Number.isSafeInteger(before.size) ||
    before.size < 0 ||
    before.size > maximumBytes ||
    (expectedBytes !== undefined && before.size !== expectedBytes)
  ) {
    fail('integrity', 'export file identity or size is unsafe');
  }
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    fail('integrity', 'export file cannot be opened safely', error);
  }
  let bytes: Uint8Array;
  try {
    const openedBefore = await handle.stat();
    if (!sameIdentity(before, openedBefore) || openedBefore.size !== before.size) {
      fail('integrity', 'export file changed before read');
    }
    bytes = Uint8Array.from(await handle.readFile());
    const openedAfter = await handle.stat();
    if (
      !sameIdentity(before, openedAfter) ||
      openedAfter.size !== before.size ||
      openedAfter.mtimeMs !== before.mtimeMs ||
      openedAfter.nlink !== before.nlink
    ) {
      fail('integrity', 'export file changed during read');
    }
  } finally {
    await handle.close();
  }
  const after = await lstat(path);
  if (
    !sameIdentity(before, after) ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.nlink !== before.nlink
  ) {
    fail('integrity', 'export file changed after read');
  }
  return bytes;
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalSerialize(value), 'utf8');
}

function sourceSnapshotBinding(source: ArtifactExportSource): string {
  return hashCanonicalJson({
    databaseLineageId: source.databaseLineageId,
    lineage: source.lineage,
    database: {
      sha256: source.metadata.databaseSha256,
      byteLength: source.metadata.bytes.byteLength,
      eventCount: source.metadata.eventCount,
      lastEventHash: source.metadata.lastEventHash,
      v3InventoryDigest: source.metadata.v3InventoryDigest,
    },
    anchors: source.anchors.map((anchor) => ({
      sha256: sha256(jsonBytes(anchor)),
      byteLength: jsonBytes(anchor).byteLength,
      sealedThroughSequence: anchor.sealedThroughSequence,
      anchorHash: anchor.anchorHash,
    })),
    blobs: source.blobs.map((blob) => ({
      sha256: blob.sha256,
      byteLength: blob.byteLength,
    })),
  });
}

function inventorySnapshotBinding(inventory: ArtifactExportInventory): string {
  return hashCanonicalJson({
    databaseLineageId: inventory.databaseLineageId,
    lineage: inventory.lineage,
    database: {
      sha256: inventory.database.sha256,
      byteLength: inventory.database.byteLength,
      eventCount: inventory.database.eventCount,
      lastEventHash: inventory.database.lastEventHash,
      v3InventoryDigest: inventory.database.v3InventoryDigest,
    },
    anchors: inventory.anchors.map((anchor) => ({
      sha256: anchor.sha256,
      byteLength: anchor.byteLength,
      sealedThroughSequence: anchor.sealedThroughSequence,
      anchorHash: anchor.anchorHash,
    })),
    blobs: inventory.blobs.map((blob) => ({
      sha256: blob.sha256,
      byteLength: blob.byteLength,
    })),
  });
}

async function readCanonicalJson(path: string, maximumBytes = MAX_JSON_BYTES): Promise<unknown> {
  const bytes = await readPrivateFile(path, maximumBytes);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    fail('integrity', 'export JSON is not valid UTF-8', error);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail('integrity', 'export JSON cannot be parsed', error);
  }
  if (canonicalSerialize(value) !== text) fail('integrity', 'export JSON is not canonical');
  return value;
}

async function closedDirectory(path: string, expected: ReadonlySet<string>): Promise<void> {
  await inspectDirectory(path);
  const entries = await readdir(path, { withFileTypes: true });
  const actual = new Set(entries.map((entry) => entry.name));
  if (actual.size !== expected.size || [...expected].some((name) => !actual.has(name))) {
    fail('integrity', 'export directory contains unexpected or missing entries');
  }
}

function validateInventory(value: unknown, bundleName: string): ArtifactExportInventory {
  const record = exactKeys(value, [
    'schema', 'bundleName', 'createdAt', 'databaseLineageId', 'lineage', 'database', 'anchors', 'blobs',
  ], 'export inventory');
  if (record['schema'] !== 'hercules-artifact-export-inventory/v1' || record['bundleName'] !== bundleName) {
    fail('integrity', 'export inventory identity is invalid');
  }
  assertCanonicalUtcTimestamp(record['createdAt'], 'export createdAt');
  if (typeof record['databaseLineageId'] !== 'string' || record['databaseLineageId'].length === 0) {
    fail('integrity', 'export database lineage is invalid');
  }
  const lineage = exactKeys(record['lineage'], [
    'databaseLineageId', 'artifactRoot', 'rootDevice', 'rootInode',
  ], 'export lineage');
  if (
    lineage['databaseLineageId'] !== record['databaseLineageId'] ||
    typeof lineage['artifactRoot'] !== 'string' ||
    !Number.isSafeInteger(lineage['rootDevice']) ||
    !Number.isSafeInteger(lineage['rootInode'])
  ) {
    fail('integrity', 'export lineage facts are invalid');
  }
  const database = exactKeys(record['database'], [
    'path', 'sha256', 'byteLength', 'eventCount', 'lastEventHash', 'v3InventoryDigest',
  ], 'export database inventory');
  if (
    database['path'] !== 'database.sqlite' ||
    typeof database['sha256'] !== 'string' ||
    typeof database['v3InventoryDigest'] !== 'string' ||
    !Number.isSafeInteger(database['byteLength']) ||
    Number(database['byteLength']) < 0 ||
    Number(database['byteLength']) > MAX_DATABASE_BYTES ||
    !Number.isSafeInteger(database['eventCount']) ||
    Number(database['eventCount']) < 0 ||
    (database['lastEventHash'] !== null && typeof database['lastEventHash'] !== 'string')
  ) {
    fail('integrity', 'export database inventory is invalid');
  }
  assertSha256Digest(database['sha256'], 'export database digest');
  assertSha256Digest(database['v3InventoryDigest'], 'export database inventory digest');
  if (!Array.isArray(record['anchors']) || !Array.isArray(record['blobs'])) {
    fail('integrity', 'export file inventories must be arrays');
  }
  const anchors: AnchorInventoryFile[] = [];
  const anchorPaths = new Set<string>();
  let previousSequence = 0;
  for (const raw of record['anchors']) {
    const item = exactKeys(raw, [
      'path', 'sha256', 'byteLength', 'sealedThroughSequence', 'anchorHash',
    ], 'export anchor inventory item');
    if (
      typeof item['path'] !== 'string' ||
      typeof item['sha256'] !== 'string' ||
      typeof item['anchorHash'] !== 'string' ||
      !Number.isSafeInteger(item['byteLength']) ||
      Number(item['byteLength']) < 1 ||
      Number(item['byteLength']) > MAX_ANCHOR_BYTES ||
      !Number.isSafeInteger(item['sealedThroughSequence']) ||
      Number(item['sealedThroughSequence']) <= previousSequence
    ) {
      fail('integrity', 'export anchor inventory item is invalid');
    }
    assertSha256Digest(item['sha256'], 'export anchor file digest');
    assertSha256Digest(item['anchorHash'], 'export anchor hash');
    const expectedPath = join(
      'anchors',
      `${String(item['sealedThroughSequence']).padStart(20, '0')}-${item['anchorHash'].slice('sha256:'.length)}.json`,
    );
    if (item['path'] !== expectedPath || anchorPaths.has(expectedPath)) {
      fail('integrity', 'export anchor inventory path is invalid or duplicated');
    }
    anchorPaths.add(expectedPath);
    previousSequence = Number(item['sealedThroughSequence']);
    anchors.push(Object.freeze({
      path: expectedPath,
      sha256: item['sha256'],
      byteLength: Number(item['byteLength']),
      sealedThroughSequence: Number(item['sealedThroughSequence']),
      anchorHash: item['anchorHash'],
    }));
  }
  const blobs: InventoryFile[] = [];
  const blobPaths = new Set<string>();
  let previousDigest = '';
  for (const raw of record['blobs']) {
    const item = exactKeys(raw, ['path', 'sha256', 'byteLength'], 'export blob inventory item');
    if (
      typeof item['path'] !== 'string' ||
      typeof item['sha256'] !== 'string' ||
      !Number.isSafeInteger(item['byteLength']) ||
      Number(item['byteLength']) < 0 ||
      Number(item['byteLength']) > MAX_BLOB_BYTES
    ) {
      fail('integrity', 'export blob inventory item is invalid');
    }
    assertSha256Digest(item['sha256'], 'export blob digest');
    const expectedPath = storageKey(item['sha256']);
    if (
      item['path'] !== expectedPath ||
      blobPaths.has(expectedPath) ||
      item['sha256'] <= previousDigest
    ) {
      fail('integrity', 'export blob inventory order or path is invalid');
    }
    blobPaths.add(expectedPath);
    previousDigest = item['sha256'];
    blobs.push(Object.freeze({
      path: expectedPath,
      sha256: item['sha256'],
      byteLength: Number(item['byteLength']),
    }));
  }
  return Object.freeze({
    schema: 'hercules-artifact-export-inventory/v1',
    bundleName,
    createdAt: record['createdAt'] as string,
    databaseLineageId: record['databaseLineageId'],
    lineage: Object.freeze({
      databaseLineageId: lineage['databaseLineageId'] as string,
      artifactRoot: lineage['artifactRoot'],
      rootDevice: Number(lineage['rootDevice']),
      rootInode: Number(lineage['rootInode']),
    }),
    database: Object.freeze({
      path: 'database.sqlite',
      sha256: database['sha256'],
      byteLength: Number(database['byteLength']),
      eventCount: Number(database['eventCount']),
      lastEventHash: database['lastEventHash'] as string | null,
      v3InventoryDigest: database['v3InventoryDigest'],
    }),
    anchors: Object.freeze(anchors),
    blobs: Object.freeze(blobs),
  });
}

export async function publishArtifactExport(
  exportRoot: string,
  source: ArtifactExportSource,
): Promise<Readonly<ArtifactExportReceipt>> {
  snapshotArtifactExportBundleName(source.bundleName);
  assertCanonicalUtcTimestamp(source.createdAt, 'export createdAt');
  await prepareExportRoot(exportRoot);
  const finalRoot = join(exportRoot, source.bundleName);
  try {
    await lstat(finalRoot);
    try {
      await lstat(join(finalRoot, '.complete'));
      fail('conflict', 'export bundle already exists');
    } catch (error) {
      if (
        error instanceof ArtifactExportError ||
        !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      ) {
        throw error;
      }
    }
    const recovered = await verifyArtifactExportBundle(exportRoot, source.bundleName, false);
    const recoveredInventory = validateInventory(
      await readCanonicalJson(join(finalRoot, 'inventory.json')),
      source.bundleName,
    );
    if (
      recovered.databaseSha256 !== source.metadata.databaseSha256 ||
      inventorySnapshotBinding(recoveredInventory) !== sourceSnapshotBinding(source)
    ) {
      fail('conflict', 'unmarked export residue does not match the current archive snapshot');
    }
    const ownerBytes = await readPrivateFile(join(finalRoot, 'owner.json'), MAX_JSON_BYTES);
    const complete = Object.freeze({
      schema: 'hercules-artifact-export-complete/v1',
      inventorySha256: recovered.inventorySha256,
      ownerSha256: sha256(ownerBytes),
      completedAt: recovered.completedAt,
    });
    await writePrivateFile(join(finalRoot, '.complete'), jsonBytes(complete));
    await fsyncDirectory(finalRoot);
    await fsyncDirectory(exportRoot);
    const verified = await verifyArtifactExport(exportRoot, source.bundleName);
    return Object.freeze({
      schema: verified.schema,
      bundleName: verified.bundleName,
      inventorySha256: verified.inventorySha256,
      databaseSha256: verified.databaseSha256,
      anchorCount: verified.anchorCount,
      blobCount: verified.blobCount,
      completedAt: verified.completedAt,
    });
  } catch (error) {
    if (
      error instanceof ArtifactExportError ||
      !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
    ) {
      throw error;
    }
  }
  const tempRoot = join(exportRoot, `.tmp-${randomUUID()}`);
  try {
    await mkdir(tempRoot, { mode: 0o700 });
  } catch (error) {
    fail('io', 'export temp directory cannot be created', error);
  }
  await inspectDirectory(tempRoot);
  const owner = Object.freeze({
    schema: 'hercules-artifact-export-owner/v1',
    bundleName: source.bundleName,
    nonce: randomUUID(),
    createdAt: source.createdAt,
    databaseLineageId: source.databaseLineageId,
  });
  const ownerBytes = jsonBytes(owner);
  await writePrivateFile(join(tempRoot, 'owner.json'), ownerBytes);
  await writePrivateFile(join(tempRoot, 'database.sqlite'), source.metadata.bytes);

  await ensurePrivateDirectory(join(tempRoot, 'anchors'));
  const anchorInventory: AnchorInventoryFile[] = [];
  for (const anchor of source.anchors) {
    const name = anchorName(anchor);
    const bytes = jsonBytes(anchor);
    await writePrivateFile(join(tempRoot, 'anchors', name), bytes);
    anchorInventory.push(Object.freeze({
      path: join('anchors', name),
      sha256: sha256(bytes),
      byteLength: bytes.byteLength,
      sealedThroughSequence: anchor.sealedThroughSequence,
      anchorHash: anchor.anchorHash,
    }));
  }

  await ensurePrivateDirectory(join(tempRoot, 'content'));
  await ensurePrivateDirectory(join(tempRoot, 'content', 'sha256'));
  const blobInventory: InventoryFile[] = [];
  for (const blob of source.blobs) {
    assertSha256Digest(blob.sha256, 'export blob digest');
    if (!Number.isSafeInteger(blob.byteLength) || blob.byteLength < 0 || blob.byteLength > MAX_BLOB_BYTES) {
      fail('invalid_input', 'export blob length is invalid');
    }
    const relativePath = storageKey(blob.sha256);
    const path = join(tempRoot, relativePath);
    await ensurePrivateDirectory(dirname(dirname(path)));
    await ensurePrivateDirectory(dirname(path));
    const bytes = await source.readBlob(blob);
    if (bytes.byteLength !== blob.byteLength || sha256(bytes) !== blob.sha256) {
      fail('integrity', 'export source blob differs from its verified inventory');
    }
    await writePrivateFile(path, bytes);
    blobInventory.push(Object.freeze({
      path: relativePath,
      sha256: blob.sha256,
      byteLength: blob.byteLength,
    }));
  }
  const databaseBytes = source.metadata.bytes;
  if (databaseBytes.byteLength > MAX_DATABASE_BYTES || sha256(databaseBytes) !== source.metadata.databaseSha256) {
    fail('integrity', 'export database snapshot differs from its receipt');
  }
  const inventory: ArtifactExportInventory = Object.freeze({
    schema: 'hercules-artifact-export-inventory/v1',
    bundleName: source.bundleName,
    createdAt: source.createdAt,
    databaseLineageId: source.databaseLineageId,
    lineage: source.lineage,
    database: Object.freeze({
      path: 'database.sqlite',
      sha256: source.metadata.databaseSha256,
      byteLength: databaseBytes.byteLength,
      eventCount: source.metadata.eventCount,
      lastEventHash: source.metadata.lastEventHash,
      v3InventoryDigest: source.metadata.v3InventoryDigest,
    }),
    anchors: Object.freeze(anchorInventory),
    blobs: Object.freeze(blobInventory),
  });
  const inventoryBytes = jsonBytes(inventory);
  if (inventoryBytes.byteLength > MAX_JSON_BYTES) {
    fail('invalid_input', 'export inventory exceeds the bounded JSON limit');
  }
  const inventorySha256 = sha256(inventoryBytes);
  await writePrivateFile(join(tempRoot, 'inventory.json'), inventoryBytes);
  await fsyncDirectory(tempRoot);

  try {
    await mkdir(finalRoot, { mode: 0o700 });
  } catch (error) {
    fail('conflict', 'export bundle already exists', error);
  }
  await inspectDirectory(finalRoot);
  for (const name of ['owner.json', 'database.sqlite', 'anchors', 'content', 'inventory.json']) {
    try {
      await rename(join(tempRoot, name), join(finalRoot, name));
    } catch (error) {
      fail('io', 'export payload cannot be installed into its reservation', error);
    }
  }
  await fsyncDirectory(finalRoot);
  const complete = Object.freeze({
    schema: 'hercules-artifact-export-complete/v1',
    inventorySha256,
    ownerSha256: sha256(ownerBytes),
    completedAt: source.createdAt,
  });
  await writePrivateFile(join(finalRoot, '.complete'), jsonBytes(complete));
  await fsyncDirectory(finalRoot);
  await fsyncDirectory(exportRoot);
  try {
    await rmdir(tempRoot);
  } catch (error) {
    fail('io', 'empty export temp directory cannot be removed', error);
  }
  await fsyncDirectory(exportRoot);
  await verifyArtifactExport(exportRoot, source.bundleName);
  return Object.freeze({
    schema: 'hercules-artifact-export-receipt/v1',
    bundleName: source.bundleName,
    inventorySha256,
    databaseSha256: source.metadata.databaseSha256,
    anchorCount: source.anchors.length,
    blobCount: source.blobs.length,
    completedAt: source.createdAt,
  });
}

export async function verifyArtifactExport(
  exportRoot: string,
  bundleName: string,
): Promise<Readonly<ArtifactExportIntegrityReport>> {
  return verifyArtifactExportBundle(exportRoot, bundleName, true);
}

async function verifyArtifactExportBundle(
  exportRoot: string,
  bundleName: string,
  requireCompleteMarker: boolean,
): Promise<Readonly<ArtifactExportIntegrityReport>> {
  snapshotArtifactExportBundleName(bundleName);
  const exportRootIdentity = await inspectExportRoot(exportRoot);
  const root = join(exportRoot, bundleName);
  const bundleIdentity = await inspectDirectory(root);
  const rootEntries = ['owner.json', 'database.sqlite', 'anchors', 'content', 'inventory.json'];
  if (requireCompleteMarker) rootEntries.unshift('.complete');
  await closedDirectory(root, new Set(rootEntries));
  const owner = exactKeys(await readCanonicalJson(join(root, 'owner.json')), [
    'schema', 'bundleName', 'nonce', 'createdAt', 'databaseLineageId',
  ], 'export owner');
  if (
    owner['schema'] !== 'hercules-artifact-export-owner/v1' ||
    owner['bundleName'] !== bundleName ||
    typeof owner['nonce'] !== 'string' ||
    !UUID_RE.test(owner['nonce']) ||
    typeof owner['databaseLineageId'] !== 'string' ||
    owner['databaseLineageId'].length === 0
  ) {
    fail('integrity', 'export owner marker is invalid');
  }
  assertCanonicalUtcTimestamp(owner['createdAt'], 'export owner createdAt');
  const inventoryBytes = await readPrivateFile(join(root, 'inventory.json'), MAX_JSON_BYTES);
  let inventoryValue: unknown;
  try {
    inventoryValue = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inventoryBytes));
  } catch (error) {
    fail('integrity', 'export inventory cannot be parsed', error);
  }
  if (canonicalSerialize(inventoryValue) !== Buffer.from(inventoryBytes).toString('utf8')) {
    fail('integrity', 'export inventory is not canonical');
  }
  const inventory = validateInventory(inventoryValue, bundleName);
  if (
    owner['databaseLineageId'] !== inventory.databaseLineageId ||
    owner['createdAt'] !== inventory.createdAt
  ) {
    fail('integrity', 'export owner and inventory identity differ');
  }
  if (requireCompleteMarker) {
    const complete = exactKeys(await readCanonicalJson(join(root, '.complete')), [
      'schema', 'inventorySha256', 'ownerSha256', 'completedAt',
    ], 'export completion marker');
    if (
      complete['schema'] !== 'hercules-artifact-export-complete/v1' ||
      complete['inventorySha256'] !== sha256(inventoryBytes) ||
      complete['ownerSha256'] !== sha256(await readPrivateFile(join(root, 'owner.json'), MAX_JSON_BYTES)) ||
      complete['completedAt'] !== inventory.createdAt
    ) {
      fail('integrity', 'export completion marker does not bind its inventory and owner');
    }
  }
  const database = await readPrivateFile(
    join(root, inventory.database.path),
    MAX_DATABASE_BYTES,
    inventory.database.byteLength,
  );
  if (sha256(database) !== inventory.database.sha256) {
    fail('integrity', 'export database hash differs from inventory');
  }
  await closedDirectory(join(root, 'anchors'), new Set(inventory.anchors.map((item) => item.path.slice('anchors/'.length))));
  let previousAnchorHash: string | null = null;
  let previousSequence = 0;
  const parsedAnchors: ArtifactArchiveAnchor[] = [];
  for (const item of inventory.anchors) {
    const anchor = snapshotArtifactArchiveAnchor(
      await readCanonicalJson(join(root, item.path), MAX_ANCHOR_BYTES),
    );
    const bytes = await readPrivateFile(join(root, item.path), MAX_ANCHOR_BYTES, item.byteLength);
    const body: Record<string, unknown> = { ...anchor };
    delete body['anchorHash'];
    if (
      sha256(bytes) !== item.sha256 ||
      anchor.lineageId !== inventory.databaseLineageId ||
      anchor.sealedThroughSequence !== item.sealedThroughSequence ||
      anchor.anchorHash !== item.anchorHash ||
      anchor.anchorHash !== hashCanonicalJson(body) ||
      anchor.previousAnchorHash !== previousAnchorHash ||
      anchor.sealedThroughSequence <= previousSequence ||
      item.path !== join('anchors', `${String(item.sealedThroughSequence).padStart(20, '0')}-${item.anchorHash.slice('sha256:'.length)}.json`)
    ) {
      fail('integrity', 'export anchor chain or inventory binding is invalid');
    }
    parsedAnchors.push(anchor);
    previousAnchorHash = item.anchorHash;
    previousSequence = item.sealedThroughSequence;
  }
  const expectedContent = new Map<string, Set<string>>();
  const firstShards = new Set<string>();
  const secondShards = new Map<string, Set<string>>();
  for (const item of inventory.blobs) {
    assertSha256Digest(item.sha256, 'export blob digest');
    if (item.path !== storageKey(item.sha256) || !Number.isSafeInteger(item.byteLength)) {
      fail('integrity', 'export blob inventory is invalid');
    }
    const bytes = await readPrivateFile(join(root, item.path), MAX_BLOB_BYTES, item.byteLength);
    if (sha256(bytes) !== item.sha256) fail('integrity', 'export blob hash differs from inventory');
    const directory = dirname(item.path);
    const names = expectedContent.get(directory) ?? new Set<string>();
    names.add(item.path.slice(directory.length + 1));
    expectedContent.set(directory, names);
    const parts = item.path.split('/');
    const first = parts[2]!;
    const second = parts[3]!;
    firstShards.add(first);
    const seconds = secondShards.get(first) ?? new Set<string>();
    seconds.add(second);
    secondShards.set(first, seconds);
  }
  await closedDirectory(join(root, 'content'), new Set(['sha256']));
  await closedDirectory(join(root, 'content', 'sha256'), firstShards);
  for (const [first, seconds] of secondShards) {
    await closedDirectory(join(root, 'content', 'sha256', first), seconds);
  }
  for (const [directory, names] of expectedContent) {
    await closedDirectory(join(root, directory), names);
  }
  try {
    verifyArtifactMetadataSnapshotBytes(database, {
      lineage: inventory.lineage,
      eventCount: inventory.database.eventCount,
      lastEventHash: inventory.database.lastEventHash,
      v3InventoryDigest: inventory.database.v3InventoryDigest,
      anchors: parsedAnchors,
      retainedAt: inventory.createdAt,
      retainedBlobs: inventory.blobs.map((blob) => ({
        sha256: blob.sha256,
        byteLength: blob.byteLength,
      })),
    });
  } catch (error) {
    if (error instanceof ArtifactExportError) throw error;
    fail('integrity', 'exported SQLite metadata is not internally consistent', error);
  }
  await assertDirectoryIdentity(root, bundleIdentity);
  await assertDirectoryIdentity(exportRoot, exportRootIdentity);
  return Object.freeze({
    schema: 'hercules-artifact-export-receipt/v1' as const,
    bundleName,
    inventorySha256: sha256(inventoryBytes),
    databaseSha256: inventory.database.sha256,
    anchorCount: inventory.anchors.length,
    blobCount: inventory.blobs.length,
    completedAt: inventory.createdAt,
    limitation: 'internally_consistent_not_authenticity_signed' as const,
  });
}
