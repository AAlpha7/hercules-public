import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { canonicalSerialize, hashCanonicalJson } from '../domain/canonicalJson.js';
import { isRecord } from '../domain/v2Invariant.js';
import { isValidIdentifier, type Task } from '../domain/task.js';
import type { ControlGit } from '../control/git.js';
import type { ShadowDelivery } from '../control/state/shadowReconciler.js';
import { parseTaskFile } from '../control/taskFile.js';

export interface ShadowOutboxEntryInput {
  readonly path: string;
  readonly original: Buffer | null;
  readonly proposed: Buffer | null;
}

export interface PrepareShadowDeliveryInput {
  readonly beforeHead: string;
  readonly message: string;
  readonly entries: readonly ShadowOutboxEntryInput[];
  readonly writes: readonly Task[];
  readonly retiredTaskIds: readonly string[];
}

interface ShadowOutboxRecord {
  readonly version: 1;
  readonly deliveryId: string;
  readonly beforeHead: string;
  readonly revision: string | null;
  readonly message: string;
  readonly entries: readonly {
    readonly path: string;
    readonly originalBase64: string | null;
    readonly originalSha256: string;
    readonly proposedBase64: string | null;
    readonly proposedSha256: string;
  }[];
  readonly writes: readonly Task[];
  readonly retiredTaskIds: readonly string[];
  readonly integrity: string;
}

export class ShadowOutboxError extends Error {
  override readonly name = 'ShadowOutboxError';
}

export interface ShadowDeliveryOutboxOptions {
  /** Test-only crash boundary after restored files, directories, and index are durable. */
  readonly afterRecoveryDurability?: (syncedPaths: readonly string[]) => Promise<void>;
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const SAFE_PATH = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const OUTBOX_DIRECTORY = 'hercules-shadow-delivery';
const MAX_RECORD_BYTES = 32 * 1024 * 1024;
const MAX_TASK_BYTES = 1024 * 1024;
const MAX_ENTRIES = 4096;
const RECORD_MODE = 0o600;
const TEMP_NAME = /^git-[0-9a-f]{64}\.json\.[0-9a-f-]{36}\.tmp$/;

function fail(message: string): never {
  throw new ShadowOutboxError(message);
}

function bytesHash(bytes: Buffer | null): string {
  return `sha256:${createHash('sha256').update(bytes ?? Buffer.alloc(0)).digest('hex')}`;
}

function exactKeys(value: Readonly<Record<PropertyKey, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safePath(root: string, path: string): string {
  if (!SAFE_PATH.test(path) || path.split('/').some((part) => part === '.' || part === '..')) {
    fail('shadow outbox contains an unsafe declared path');
  }
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel !== path || rel.startsWith('..')) fail('shadow outbox path escapes the control repo');
  return absolute;
}

function recordIntegrity(record: Omit<ShadowOutboxRecord, 'integrity'>): string {
  return hashCanonicalJson({ schema: 'm4-shadow-outbox-v1', ...record });
}

function parseRecord(raw: unknown, controlDir: string): ShadowOutboxRecord {
  if (!isRecord(raw) || !exactKeys(raw, [
    'version', 'deliveryId', 'beforeHead', 'revision', 'message', 'entries',
    'writes', 'retiredTaskIds', 'integrity',
  ]) || raw['version'] !== 1 || typeof raw['deliveryId'] !== 'string' ||
      !FULL_SHA.test(String(raw['beforeHead'])) ||
      !(raw['revision'] === null || FULL_SHA.test(String(raw['revision']))) ||
      typeof raw['message'] !== 'string' || !Array.isArray(raw['entries']) ||
      !Array.isArray(raw['writes']) || !Array.isArray(raw['retiredTaskIds']) ||
      typeof raw['integrity'] !== 'string') {
    fail('shadow outbox record schema is invalid');
  }
  if (raw['entries'].length === 0 || raw['entries'].length > MAX_ENTRIES) {
    fail('shadow outbox entry count is invalid');
  }
  for (const entry of raw['entries']) {
    if (!isRecord(entry) || !exactKeys(entry, [
      'path', 'originalBase64', 'originalSha256', 'proposedBase64', 'proposedSha256',
    ]) || typeof entry['path'] !== 'string' ||
        !(entry['originalBase64'] === null || typeof entry['originalBase64'] === 'string') ||
        !(entry['proposedBase64'] === null || typeof entry['proposedBase64'] === 'string') ||
        typeof entry['originalSha256'] !== 'string' || typeof entry['proposedSha256'] !== 'string') {
      fail('shadow outbox entry schema is invalid');
    }
    const original = entry['originalBase64'] === null ? null : Buffer.from(entry['originalBase64'], 'base64');
    const proposed = entry['proposedBase64'] === null ? null : Buffer.from(entry['proposedBase64'], 'base64');
    if ((original?.toString('base64') ?? null) !== entry['originalBase64'] ||
        (proposed?.toString('base64') ?? null) !== entry['proposedBase64']) {
      fail('shadow outbox entry encoding is non-canonical');
    }
    if (bytesHash(original) !== entry['originalSha256'] || bytesHash(proposed) !== entry['proposedSha256']) {
      fail('shadow outbox entry digest is invalid');
    }
    safePath(controlDir, entry['path']);
  }
  for (const task of raw['writes']) {
    if (!isRecord(task) || typeof task['id'] !== 'string' || !isValidIdentifier(task['id']) ||
        Buffer.byteLength(canonicalSerialize(task), 'utf8') > MAX_TASK_BYTES) {
      fail('shadow outbox task payload is invalid or too large');
    }
  }
  if (raw['retiredTaskIds'].some((taskId) =>
    typeof taskId !== 'string' || !isValidIdentifier(taskId))) {
    fail('shadow outbox retirement identity is invalid');
  }
  const record = raw as unknown as ShadowOutboxRecord;
  const { integrity: _integrity, ...payload } = record;
  if (record.integrity !== recordIntegrity(payload)) fail('shadow outbox integrity is invalid');
  return record;
}

async function fsyncPath(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncIfPresent(path: string): Promise<boolean> {
  try {
    await fsyncPath(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function durableWrite(path: string, value: unknown): Promise<void> {
  const payload = canonicalSerialize(value);
  if (Buffer.byteLength(payload, 'utf8') > MAX_RECORD_BYTES) fail('shadow outbox record is too large');
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, payload, { encoding: 'utf8', mode: RECORD_MODE, flag: 'wx' });
  await fsyncPath(temp);
  await rename(temp, path);
  await chmod(path, RECORD_MODE);
  await fsyncPath(dirname(path));
}

async function readPrivateRecord(path: string): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() ||
      (before.mode & 0o777) !== RECORD_MODE ||
      (typeof process.getuid === 'function' && before.uid !== process.getuid())) {
    fail('shadow outbox record is permission-unsafe');
  }
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino ||
        (after.mode & 0o777) !== RECORD_MODE ||
        (typeof process.getuid === 'function' && after.uid !== process.getuid())) {
      fail('shadow outbox record changed during safe open');
    }
    if (after.size > MAX_RECORD_BYTES) fail('shadow outbox record is too large');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function parseRecordText(text: string, controlDir: string): ShadowOutboxRecord {
  try {
    const raw: unknown = JSON.parse(text);
    if (canonicalSerialize(raw) !== text) fail('shadow outbox record encoding is non-canonical');
    return parseRecord(raw, controlDir);
  } catch (error) {
    if (error instanceof ShadowOutboxError) throw error;
    fail('shadow outbox record is not valid canonical JSON');
  }
}

async function assertSafeControlPath(controlDir: string, path: string): Promise<void> {
  const parts = path.split('/');
  let current = controlDir;
  for (const part of parts) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() ||
          (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
        fail('shadow outbox declared path has an unsafe owner or symlink');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

async function removeDurable(path: string): Promise<void> {
  try {
    await unlink(path);
    await fsyncPath(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function readOptional(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export class ShadowDeliveryOutbox {
  private constructor(
    private readonly controlDir: string,
    private readonly git: ControlGit,
    private readonly directory: string,
    private readonly deliver: (delivery: ShadowDelivery) => Promise<void>,
    private readonly options: ShadowDeliveryOutboxOptions,
  ) {}

  static async open(
    controlDir: string,
    git: ControlGit,
    deliver: (delivery: ShadowDelivery) => Promise<void>,
    options: ShadowDeliveryOutboxOptions = {},
  ): Promise<ShadowDeliveryOutbox> {
    const gitDir = await realpath(await git.gitDir());
    const directory = join(gitDir, OUTBOX_DIRECTORY);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 ||
        (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
      fail('shadow outbox directory is permission-unsafe');
    }
    return new ShadowDeliveryOutbox(await realpath(controlDir), git, directory, deliver, options);
  }

  async prepare(input: PrepareShadowDeliveryInput): Promise<string> {
    const writeIds = input.writes.map((task) => task.id);
    if (!FULL_SHA.test(input.beforeHead) || input.entries.length === 0 ||
        input.entries.length > MAX_ENTRIES ||
        input.message.length === 0 ||
        new Set(input.entries.map((entry) => entry.path)).size !== input.entries.length ||
        new Set(writeIds).size !== writeIds.length ||
        new Set(input.retiredTaskIds).size !== input.retiredTaskIds.length ||
        input.retiredTaskIds.some((taskId) => writeIds.includes(taskId))) {
      fail('shadow outbox preparation input is invalid');
    }
    for (const entry of input.entries) {
      safePath(this.controlDir, entry.path);
      await assertSafeControlPath(this.controlDir, entry.path);
    }
    const entriesByPath = new Map(input.entries.map((entry) => [entry.path, entry]));
    const writes = input.writes.map((task): Task => {
      const proposed = entriesByPath.get(`tasks/${task.id}.md`)?.proposed;
      if (proposed === null || proposed === undefined) {
        fail('shadow outbox task write has no exact proposed task bytes');
      }
      try {
        return parseTaskFile(proposed.toString('utf8'), task.id);
      } catch {
        fail('shadow outbox proposed task bytes are not canonical task authority');
      }
    });
    for (const taskId of input.retiredTaskIds) {
      if (entriesByPath.get(`tasks/${taskId}.md`)?.proposed !== null) {
        fail('shadow outbox retirement has no exact proposed deletion');
      }
    }
    for (const task of writes) {
      if (Buffer.byteLength(canonicalSerialize(task), 'utf8') > MAX_TASK_BYTES) {
        fail('shadow outbox task payload is too large');
      }
    }
    const seed = { beforeHead: input.beforeHead, message: input.message, nonce: randomUUID() };
    const deliveryId = `git-${hashCanonicalJson(seed).slice('sha256:'.length)}`;
    const payload: Omit<ShadowOutboxRecord, 'integrity'> = {
      version: 1,
      deliveryId,
      beforeHead: input.beforeHead,
      revision: null,
      message: input.message,
      entries: input.entries.map((entry) => ({
        path: entry.path,
        originalBase64: entry.original?.toString('base64') ?? null,
        originalSha256: bytesHash(entry.original),
        proposedBase64: entry.proposed?.toString('base64') ?? null,
        proposedSha256: bytesHash(entry.proposed),
      })),
      writes,
      retiredTaskIds: [...input.retiredTaskIds],
    };
    const record: ShadowOutboxRecord = { ...payload, integrity: recordIntegrity(payload) };
    await durableWrite(this.recordPath(deliveryId), record);
    return deliveryId;
  }

  async committed(deliveryId: string, revision: string): Promise<boolean> {
    const record = await this.read(deliveryId);
    await this.proveCommit(record, revision);
    const { integrity: _integrity, ...unbound } = record;
    const boundPayload: Omit<ShadowOutboxRecord, 'integrity'> = { ...unbound, revision };
    const bound: ShadowOutboxRecord = {
      ...boundPayload,
      integrity: recordIntegrity(boundPayload),
    };
    await durableWrite(this.recordPath(deliveryId), bound);
    await this.recover();
    return !(await this.recordExists(deliveryId));
  }

  async recoverPrepared(deliveryId: string): Promise<string | null> {
    const record = await this.read(deliveryId);
    const revision = await this.resolveRevision(record);
    if (revision === null) {
      await this.restoreUncommitted(record);
      await removeDurable(this.recordPath(deliveryId));
      return null;
    }
    if (record.revision === null) await this.bind(record, revision);
    await this.recover();
    return revision;
  }

  async discardUncommitted(deliveryId: string): Promise<void> {
    const record = await this.read(deliveryId);
    if (await this.resolveRevision(record) !== null) {
      fail('cannot discard a committed shadow delivery');
    }
    await this.restoreUncommitted(record);
    await removeDurable(this.recordPath(deliveryId));
  }

  async recover(): Promise<void> {
    const names = (await readdir(this.directory)).sort();
    for (const name of names.filter((value) => value.endsWith('.tmp'))) {
      if (!TEMP_NAME.test(name)) fail('shadow outbox contains an unknown temporary file');
      await readPrivateRecord(join(this.directory, name));
      await removeDurable(join(this.directory, name));
    }
    const records: ShadowOutboxRecord[] = [];
    for (const name of names.filter((value) => !value.endsWith('.tmp'))) {
      if (!/^git-[0-9a-f]{64}\.json$/.test(name)) {
        fail('shadow outbox contains an unknown durable file');
      }
      const record = parseRecordText(await readPrivateRecord(join(this.directory, name)), this.controlDir);
      if (name !== `${record.deliveryId}.json`) fail('shadow outbox filename does not match delivery identity');
      for (const entry of record.entries) await assertSafeControlPath(this.controlDir, entry.path);
      records.push(record);
    }
    const committed: Array<{ readonly record: ShadowOutboxRecord; readonly distance: number }> = [];
    let restoredUncommitted = false;
    const head = await this.git.headHash();
    const atHead = records.filter((record) => record.beforeHead === head);
    if (atHead.length > 1 || atHead.some((record) => record.revision !== null)) {
      fail('shadow outbox contains ambiguous deliveries at current HEAD');
    }
    for (const record of records) {
      const revision = await this.resolveRevision(record, head);
      if (revision === null) {
        if (restoredUncommitted) {
          fail('shadow outbox contains ambiguous uncommitted deliveries');
        }
        await this.restoreUncommitted(record);
        await removeDurable(this.recordPath(record.deliveryId));
        restoredUncommitted = true;
        continue;
      }
      const bound = record.revision === null ? await this.bind(record, revision) : record;
      if (head === null) fail('shadow outbox recovery found an unborn divergent HEAD');
      const distance = (await this.git.firstParentAfter(revision, head)).length;
      committed.push({ record: bound, distance });
    }
    committed.sort((left, right) =>
      right.distance - left.distance || left.record.deliveryId.localeCompare(right.record.deliveryId));
    if (new Set(committed.map((item) => item.record.revision)).size !== committed.length) {
      fail('shadow outbox contains duplicate authority revisions');
    }
    for (const item of committed) {
      if (!(await this.tryDeliver(item.record))) break;
    }
  }

  async hasPending(): Promise<boolean> {
    return (await readdir(this.directory)).some((name) => name.endsWith('.json'));
  }

  private recordPath(deliveryId: string): string {
    if (!/^git-[0-9a-f]{64}$/.test(deliveryId)) fail('shadow delivery id is invalid');
    return join(this.directory, `${deliveryId}.json`);
  }

  private async read(deliveryId: string): Promise<ShadowOutboxRecord> {
    const record = parseRecordText(
      await readPrivateRecord(this.recordPath(deliveryId)), this.controlDir,
    );
    if (record.deliveryId !== deliveryId) fail('shadow outbox record identity does not match its path');
    for (const entry of record.entries) await assertSafeControlPath(this.controlDir, entry.path);
    return record;
  }

  private async recordExists(deliveryId: string): Promise<boolean> {
    try {
      await lstat(this.recordPath(deliveryId));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async resolveRevision(
    record: ShadowOutboxRecord,
    knownHead?: string | null,
  ): Promise<string | null> {
    const head = knownHead === undefined ? await this.git.headHash() : knownHead;
    if (head === record.beforeHead) {
      if (record.revision !== null) fail('bound shadow delivery is absent from current HEAD');
      return null;
    }
    if (head === null) fail('shadow outbox recovery found an unborn divergent HEAD');
    const range = await this.git.firstParentAfter(record.beforeHead, head);
    const immediateChild = range[0];
    if (immediateChild === undefined) fail('shadow outbox recovery cannot bind a unique commit');
    const revision = record.revision ?? immediateChild;
    if (revision !== immediateChild) fail('shadow outbox revision is not the immediate first-parent child');
    await this.proveCommit(record, revision);
    return revision;
  }

  private async bind(record: ShadowOutboxRecord, revision: string): Promise<ShadowOutboxRecord> {
    const { integrity: _integrity, ...unbound } = record;
    const payload: Omit<ShadowOutboxRecord, 'integrity'> = { ...unbound, revision };
    const bound: ShadowOutboxRecord = { ...payload, integrity: recordIntegrity(payload) };
    await durableWrite(this.recordPath(record.deliveryId), bound);
    return bound;
  }

  private async proveCommit(record: ShadowOutboxRecord, revision: string): Promise<void> {
    const metadata = await this.git.commitMetadata(revision);
    const paths = record.entries
      .filter((entry) => entry.originalBase64 !== entry.proposedBase64)
      .map((entry) => entry.path)
      .sort();
    if (metadata.parent !== record.beforeHead || metadata.message !== record.message ||
        canonicalSerialize(metadata.paths) !== canonicalSerialize(paths)) {
      fail('shadow outbox commit metadata does not match the prepared mutation');
    }
    for (const entry of record.entries) {
      const text = await this.git.readPathAtRevision(revision, entry.path);
      const bytes = text === null ? null : Buffer.from(text, 'utf8');
      if ((bytes?.toString('base64') ?? null) !== entry.proposedBase64 ||
          bytesHash(bytes) !== entry.proposedSha256) {
        fail('shadow outbox commit bytes do not match the prepared mutation');
      }
    }
  }

  private async restoreUncommitted(record: ShadowOutboxRecord): Promise<void> {
    const declared = new Set(record.entries.map((entry) => entry.path));
    const dirt = await this.git.statusPaths();
    if (dirt.some((path) => !declared.has(path))) {
      fail('shadow outbox recovery found undeclared control-repo dirt');
    }
    for (const entry of record.entries) {
      const absolute = safePath(this.controlDir, entry.path);
      await assertSafeControlPath(this.controlDir, entry.path);
      const worktree = await readOptional(absolute);
      const indexText = await this.git.readPathAtIndex(entry.path);
      const index = indexText === null ? null : Buffer.from(indexText, 'utf8');
      for (const [kind, value] of [['worktree', worktree], ['index', index]] as const) {
        const encoded = value?.toString('base64') ?? null;
        if (encoded !== entry.originalBase64 && encoded !== entry.proposedBase64) {
          fail(`shadow outbox recovery found a third ${kind} value`);
        }
      }
    }
    for (const entry of record.entries) {
      const absolute = safePath(this.controlDir, entry.path);
      await assertSafeControlPath(this.controlDir, entry.path);
      if (entry.originalBase64 === null) {
        try {
          await unlink(absolute);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await this.git.removePathFromIndex(entry.path);
      } else {
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, Buffer.from(entry.originalBase64, 'base64'));
        await this.git.resetPath(entry.path);
      }
    }
    const syncedPaths = await this.syncRecoveredState(record.entries.map((entry) => entry.path));
    if (await this.git.headHash() !== record.beforeHead || !(await this.git.isClean())) {
      fail('shadow outbox recovery did not restore the exact clean before-state');
    }
    await this.options.afterRecoveryDurability?.(syncedPaths);
  }

  private async syncRecoveredState(paths: readonly string[]): Promise<readonly string[]> {
    const synced: string[] = [];
    const directories = new Set<string>();
    for (const path of [...paths].sort()) {
      const absolute = safePath(this.controlDir, path);
      if (await fsyncIfPresent(absolute)) synced.push(absolute);
      let current = dirname(absolute);
      while (true) {
        const rel = relative(this.controlDir, current);
        if (rel === '..' || rel.startsWith('../') || resolve(current) !== current) {
          fail('shadow outbox recovery directory escapes the control repo');
        }
        directories.add(current);
        if (current === this.controlDir) break;
        current = dirname(current);
      }
    }
    const gitDirectory = dirname(this.directory);
    const indexPath = join(gitDirectory, 'index');
    await fsyncPath(indexPath);
    synced.push(indexPath);
    directories.add(gitDirectory);
    for (const directory of [...directories].sort((left, right) =>
      right.length - left.length || left.localeCompare(right))) {
      await fsyncPath(directory);
      synced.push(directory);
    }
    return synced;
  }

  private async tryDeliver(record: ShadowOutboxRecord): Promise<boolean> {
    if (record.revision === null) fail('unbound shadow outbox cannot be delivered');
    try {
      await this.deliver({
        deliveryId: record.deliveryId,
        revision: record.revision,
        writes: record.writes,
        retiredTaskIds: record.retiredTaskIds,
      });
      await removeDurable(this.recordPath(record.deliveryId));
      return true;
    } catch (error) {
      if (isRecord(error) && ['integrity', 'migration', 'unsafe_path'].includes(String(error['code']))) {
        throw error;
      }
      return false;
    }
  }
}
