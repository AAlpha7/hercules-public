/**
 * Isolation — durable Merge Selected operation receipts.
 *
 * Stored under the work root (not the control repo). Atomic write via temp +
 * rename. Single-daemon ownership of the work root is already enforced by the
 * daemon lease; this store still serializes mutations with an in-process mutex.
 */
import { createHash } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isValidIdentifier } from '../domain/task.js';
import {
  isMergeOperationFailureKind,
  isMergeOperationPhase,
  isMergeOperationStatus,
  isFullGitSha,
  MERGE_OPERATION_RECORD_VERSION,
  type MergeGateProgress,
  type MergeOperationFailure,
  type MergeOperationRecord,
} from '../domain/mergeOperation.js';

export class MergeOperationStoreError extends Error {
  override readonly name = 'MergeOperationStoreError';
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export const MERGE_OPERATION_DIRNAME = '.hercules-merge-ops';

function safeErrorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'UNKNOWN';
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } catch (err) {
    const code = safeErrorCode(err);
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR') throw err;
  } finally {
    await handle.close();
  }
}

function isGateProgress(v: unknown): v is MergeGateProgress {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o['completed'] !== 'number' || !Number.isFinite(o['completed'])) return false;
  if (typeof o['total'] !== 'number' || !Number.isFinite(o['total'])) return false;
  if (o['currentGate'] !== null && typeof o['currentGate'] !== 'string') return false;
  return true;
}

function isFailure(v: unknown): v is MergeOperationFailure {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o['taskId'] !== 'string' || !isValidIdentifier(o['taskId'])) return false;
  if (typeof o['reason'] !== 'string') return false;
  if (!isMergeOperationFailureKind(o['kind'])) return false;
  return true;
}

function parseRecord(raw: string, expectedId?: string): MergeOperationRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new MergeOperationStoreError('corrupt merge operation file');
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new MergeOperationStoreError('invalid merge operation file');
  }
  const o = parsed as Record<string, unknown>;
  if (o['version'] !== MERGE_OPERATION_RECORD_VERSION) {
    throw new MergeOperationStoreError('unsupported merge operation version');
  }
  if (typeof o['operationId'] !== 'string' || !isValidIdentifier(o['operationId'])) {
    throw new MergeOperationStoreError('invalid merge operation id');
  }
  if (expectedId !== undefined && o['operationId'] !== expectedId) {
    throw new MergeOperationStoreError('merge operation id mismatch');
  }
  if (typeof o['repoKey'] !== 'string' || !isValidIdentifier(o['repoKey'])) {
    throw new MergeOperationStoreError('invalid merge operation repo key');
  }
  if (
    !Array.isArray(o['taskIds']) ||
    !o['taskIds'].every((id) => typeof id === 'string' && isValidIdentifier(id))
  ) {
    throw new MergeOperationStoreError('invalid merge operation taskIds');
  }
  const idem =
    o['idempotencyKey'] === null || o['idempotencyKey'] === undefined
      ? null
      : typeof o['idempotencyKey'] === 'string'
        ? o['idempotencyKey']
        : null;
  if (o['idempotencyKey'] !== undefined && o['idempotencyKey'] !== null && idem === null) {
    throw new MergeOperationStoreError('invalid merge operation idempotencyKey');
  }
  if (!isMergeOperationStatus(o['status'])) {
    throw new MergeOperationStoreError('invalid merge operation status');
  }
  if (!isMergeOperationPhase(o['phase'])) {
    throw new MergeOperationStoreError('invalid merge operation phase');
  }
  const mergedSha =
    o['mergedSha'] === null || o['mergedSha'] === undefined
      ? null
      : typeof o['mergedSha'] === 'string'
        ? o['mergedSha']
        : null;
  if (o['mergedSha'] !== undefined && o['mergedSha'] !== null && mergedSha === null) {
    throw new MergeOperationStoreError('invalid merge operation mergedSha');
  }
  if (mergedSha !== null && !isFullGitSha(mergedSha)) {
    throw new MergeOperationStoreError('invalid merge operation mergedSha');
  }
  if (o['status'] === 'succeeded' && mergedSha === null) {
    throw new MergeOperationStoreError('invalid merge operation mergedSha');
  }
  if (o['status'] === 'succeeded' && o['phase'] !== 'stamped') {
    throw new MergeOperationStoreError('invalid succeeded merge operation phase');
  }
  if (!Array.isArray(o['failures']) || !o['failures'].every(isFailure)) {
    throw new MergeOperationStoreError('invalid merge operation failures');
  }
  if (typeof o['createdAtMs'] !== 'number' || !Number.isFinite(o['createdAtMs'])) {
    throw new MergeOperationStoreError('invalid merge operation createdAtMs');
  }
  if (typeof o['updatedAtMs'] !== 'number' || !Number.isFinite(o['updatedAtMs'])) {
    throw new MergeOperationStoreError('invalid merge operation updatedAtMs');
  }
  const gateProgress =
    o['gateProgress'] === null || o['gateProgress'] === undefined
      ? null
      : isGateProgress(o['gateProgress'])
        ? o['gateProgress']
        : null;
  if (
    o['gateProgress'] !== undefined &&
    o['gateProgress'] !== null &&
    gateProgress === null
  ) {
    throw new MergeOperationStoreError('invalid merge operation gateProgress');
  }
  const failureKind =
    o['failureKind'] === null || o['failureKind'] === undefined
      ? null
      : isMergeOperationFailureKind(o['failureKind'])
        ? o['failureKind']
        : null;
  if (
    o['failureKind'] !== undefined &&
    o['failureKind'] !== null &&
    failureKind === null
  ) {
    throw new MergeOperationStoreError('invalid merge operation failureKind');
  }
  if (typeof o['ownerPid'] !== 'number' || !Number.isInteger(o['ownerPid'])) {
    throw new MergeOperationStoreError('invalid merge operation ownerPid');
  }
  return {
    version: MERGE_OPERATION_RECORD_VERSION,
    operationId: o['operationId'],
    repoKey: o['repoKey'],
    taskIds: o['taskIds'] as string[],
    idempotencyKey: idem,
    status: o['status'],
    phase: o['phase'],
    mergedSha,
    failures: o['failures'] as MergeOperationFailure[],
    createdAtMs: o['createdAtMs'],
    updatedAtMs: o['updatedAtMs'],
    gateProgress,
    failureKind,
    ownerPid: o['ownerPid'],
  };
}

function serializeRecord(record: MergeOperationRecord): string {
  return JSON.stringify(record, null, 2) + '\n';
}

export class MergeOperationStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly workRoot: string) {}

  private rootDir(): string {
    return join(this.workRoot, MERGE_OPERATION_DIRNAME);
  }

  private opPath(operationId: string): string {
    if (!isValidIdentifier(operationId)) {
      throw new MergeOperationStoreError(`unsafe operation id '${operationId}'`);
    }
    return join(this.rootDir(), 'ops', `${operationId}.json`);
  }

  private keyPath(repoKey: string, idempotencyKey: string): string {
    if (!isValidIdentifier(repoKey)) {
      throw new MergeOperationStoreError(`unsafe repo key '${repoKey}'`);
    }
    const h = createHash('sha256')
      .update(`${repoKey}\0${idempotencyKey}`, 'utf8')
      .digest('hex')
      .slice(0, 32);
    return join(this.rootDir(), 'by-key', `${repoKey}.${h}.json`);
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async atomicWrite(path: string, body: string): Promise<void> {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    let tempHandle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      await mkdir(dirname(path), { recursive: true });
      tempHandle = await open(tmp, 'wx', 0o600);
      await tempHandle.writeFile(body, 'utf8');
      await tempHandle.sync();
      await tempHandle.close();
      tempHandle = null;
      await rename(tmp, path);
      await syncDirectory(dirname(path));
    } catch (err) {
      if (tempHandle) await tempHandle.close().catch(() => undefined);
      await unlink(tmp).catch(() => undefined);
      throw new MergeOperationStoreError(
        `could not durably write merge operation (code ${safeErrorCode(err)})`,
        safeErrorCode(err),
      );
    }
  }

  async get(operationId: string): Promise<MergeOperationRecord | null> {
    return this.withLock(async () => {
      const path = this.opPath(operationId);
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new MergeOperationStoreError(
          `could not read merge operation (code ${safeErrorCode(err)})`,
          safeErrorCode(err),
        );
      }
      return parseRecord(raw, operationId);
    });
  }

  async getByIdempotencyKey(
    repoKey: string,
    idempotencyKey: string,
  ): Promise<MergeOperationRecord | null> {
    return this.withLock(async () => {
      const path = this.keyPath(repoKey, idempotencyKey);
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          const records = await this.listAllUnlocked();
          return (
            records.find(
              (record) =>
                record.repoKey === repoKey &&
                record.idempotencyKey === idempotencyKey,
            ) ?? null
          );
        }
        throw new MergeOperationStoreError(
          `could not read merge idempotency index (code ${safeErrorCode(err)})`,
          safeErrorCode(err),
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        throw new MergeOperationStoreError('corrupt merge idempotency index');
      }
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        typeof (parsed as { operationId?: unknown }).operationId !== 'string'
      ) {
        throw new MergeOperationStoreError('invalid merge idempotency index');
      }
      const operationId = (parsed as { operationId: string }).operationId;
      const opPath = this.opPath(operationId);
      let opRaw: string;
      try {
        opRaw = await readFile(opPath, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new MergeOperationStoreError(
          `could not read merge operation (code ${safeErrorCode(err)})`,
          safeErrorCode(err),
        );
      }
      const record = parseRecord(opRaw, operationId);
      if (
        record.repoKey !== repoKey ||
        record.idempotencyKey !== idempotencyKey
      ) {
        throw new MergeOperationStoreError(
          'merge idempotency index target mismatch',
        );
      }
      return record;
    });
  }

  async put(record: MergeOperationRecord): Promise<void> {
    await this.withLock(async () => {
      if (!isValidIdentifier(record.operationId)) {
        throw new MergeOperationStoreError(
          `unsafe operation id '${record.operationId}'`,
        );
      }
      if (!isValidIdentifier(record.repoKey)) {
        throw new MergeOperationStoreError(`unsafe repo key '${record.repoKey}'`);
      }
      const serialized = serializeRecord(record);
      parseRecord(serialized, record.operationId);
      await this.atomicWrite(this.opPath(record.operationId), serialized);
      if (record.idempotencyKey) {
        await this.atomicWrite(
          this.keyPath(record.repoKey, record.idempotencyKey),
          JSON.stringify({ operationId: record.operationId }) + '\n',
        );
      }
    });
  }

  /** List all durable operations (small N; used for restart reconciliation). */
  async listAll(): Promise<readonly MergeOperationRecord[]> {
    return this.withLock(() => this.listAllUnlocked());
  }

  private async listAllUnlocked(): Promise<readonly MergeOperationRecord[]> {
      const dir = join(this.rootDir(), 'ops');
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw new MergeOperationStoreError(
          `could not list merge operations (code ${safeErrorCode(err)})`,
          safeErrorCode(err),
        );
      }
      const records: MergeOperationRecord[] = [];
      for (const name of names.sort()) {
        if (!name.endsWith('.json')) continue;
        const operationId = name.slice(0, -'.json'.length);
        if (!isValidIdentifier(operationId)) continue;
        const raw = await readFile(join(dir, name), 'utf8');
        records.push(parseRecord(raw, operationId));
      }
      return records;
  }

  async findActiveForRepo(repoKey: string): Promise<MergeOperationRecord | null> {
    const records = await this.listAll();
    return (
      records
        .filter(
          (record) =>
            record.repoKey === repoKey &&
            (record.status === 'accepted' || record.status === 'running'),
        )
        .sort((a, b) => b.createdAtMs - a.createdAtMs)[0] ?? null
    );
  }
}
