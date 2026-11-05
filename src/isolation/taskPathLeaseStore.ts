/**
 * Isolation layer — durable repository path/writer lease table.
 *
 * Pure acquire/release decisions live in domain/taskPathLease.ts. This module
 * persists per-repo held leases under the work root and serializes mutations
 * with an in-process mutex + atomic write (rename). Single-daemon ownership of
 * the work root is already enforced by the daemon lease; this store still
 * refuses token steal and recovers stale owners after crash/restart.
 */
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isValidIdentifier } from '../domain/task.js';
import {
  formatScope,
  normalizeAffectedPaths,
  normalizeProtectedPathsSnapshot,
  scopesOverlap,
  decidePathLeaseAcquire,
  decidePathLeaseRelease,
  PATH_LEASE_VERSION,
  reclaimStalePathLeases,
  type PathLeaseAcquireInput,
  type PathLeaseAcquireVerdict,
  type PathLeaseEntry,
  type PathLeaseReleaseVerdict,
  type PathScope,
} from '../domain/taskPathLease.js';
import { isFullCommitSha } from '../domain/taskBranchLease.js';
import {
  hasManagedProcessForTask,
  isOsProcessGroupIdentityAlive,
  readOsProcessIdentity,
  type OsProcessIdentity,
} from '../adapters/processTree.js'; // PATH_LEASE_PROCESS_PROBE (named exception; do not invert)

export class PathLeaseStoreError extends Error {
  override readonly name = 'PathLeaseStoreError';

  constructor(
    message: string,
    readonly repoKey?: string,
    readonly code?: string,
    readonly replacementApplied = false,
  ) {
    super(message);
  }
}

export const PATH_LEASE_DIRNAME = '.hercules-path-leases';

export interface TaskPathLeaseStoreOptions {
  readonly readProcessIdentity?: (pid: number) => OsProcessIdentity | null;
  readonly processGroupIdentityAlive?: (identity: OsProcessIdentity) => boolean | null;
  /** Test seam for proving pre-rename failures preserve the prior table. */
  readonly beforeDurableRename?: () => void | Promise<void>;
  /** Test seam for proving post-rename directory durability failures are explicit. */
  readonly syncDirectory?: (directory: string) => Promise<void>;
  /** Exact process scan for leases left between acquire and owner binding. */
  readonly unboundOwnerAlive?: (
    repoKey: string,
    entry: PathLeaseEntry,
  ) => boolean | null;
}

interface PathLeaseFile {
  readonly version: typeof PATH_LEASE_VERSION;
  readonly repo: string;
  readonly leases: readonly PathLeaseEntry[];
}

function isPathScope(v: unknown): v is PathScope {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    (o['kind'] === 'exact' || o['kind'] === 'subtree') &&
    typeof o['path'] === 'string' &&
    o['path'].length > 0
  );
}

function isPathLeaseEntry(v: unknown): v is PathLeaseEntry {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o['taskId'] !== 'string' || !isValidIdentifier(o['taskId'])) return false;
  if (
    typeof o['runToken'] !== 'string' ||
    o['runToken'].trim() !== o['runToken'] ||
    o['runToken'].length === 0 ||
    o['runToken'].length > 256
  ) return false;
  if (
    typeof o['baseRevision'] !== 'string' ||
    !isFullCommitSha(o['baseRevision']) ||
    o['baseRevision'] !== o['baseRevision'].toLowerCase()
  ) return false;
  if (!Array.isArray(o['scopes']) || !o['scopes'].every(isPathScope)) return false;
  if (
    !Array.isArray(o['protectedPathsSnapshot']) ||
    !o['protectedPathsSnapshot'].every((p) => typeof p === 'string')
  ) {
    return false;
  }
  const normalizedScopes = normalizeAffectedPaths(
    (o['scopes'] as PathScope[]).map(formatScope),
  );
  if (
    !normalizedScopes.ok ||
    normalizedScopes.scopes.length !== (o['scopes'] as PathScope[]).length ||
    normalizedScopes.scopes.some((scope, index) => {
      const stored = (o['scopes'] as PathScope[])[index];
      return stored?.kind !== scope.kind || stored.path !== scope.path;
    })
  ) return false;
  const protectedPaths = normalizeProtectedPathsSnapshot(
    o['protectedPathsSnapshot'] as string[],
  );
  if (
    !protectedPaths.ok ||
    protectedPaths.paths.length !== (o['protectedPathsSnapshot'] as string[]).length ||
    protectedPaths.paths.some(
      (path, index) => path !== (o['protectedPathsSnapshot'] as string[])[index],
    )
  ) return false;
  if (typeof o['acquiredAtMs'] !== 'number' || !Number.isFinite(o['acquiredAtMs'])) {
    return false;
  }
  if (o['ownerProcess'] !== undefined) {
    if (o['ownerProcess'] === null || typeof o['ownerProcess'] !== 'object') return false;
    const owner = o['ownerProcess'] as Record<string, unknown>;
    if (
      typeof owner['pid'] !== 'number' ||
      !Number.isInteger(owner['pid']) ||
      owner['pid'] <= 0 ||
      typeof owner['startTimeTicks'] !== 'string' ||
      !/^\d+$/.test(owner['startTimeTicks']) ||
      owner['startTimeTicks'].length > 32 ||
      typeof owner['bootId'] !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        owner['bootId'],
      )
    ) return false;
  }
  return true;
}

function parseLeaseFile(raw: string, repo: string): PathLeaseFile {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new PathLeaseStoreError(
      `corrupt path-lease file for repo ${repo} (empty content)`,
      repo,
      'CORRUPT_FILE',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    throw new PathLeaseStoreError(`corrupt path-lease file for repo ${repo}`);
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new PathLeaseStoreError(`invalid path-lease file for repo ${repo}`);
  }
  const o = parsed as Record<string, unknown>;
  if (o['version'] !== PATH_LEASE_VERSION) {
    throw new PathLeaseStoreError(`unsupported path-lease version for repo ${repo}`);
  }
  if (o['repo'] !== repo) {
    throw new PathLeaseStoreError(`path-lease file repo mismatch for ${repo}`);
  }
  if (!Array.isArray(o['leases']) || !o['leases'].every(isPathLeaseEntry)) {
    throw new PathLeaseStoreError(`invalid path-lease entries for repo ${repo}`);
  }
  const leases = o['leases'] as PathLeaseEntry[];
  const taskIds = new Set<string>();
  const tokens = new Set<string>();
  for (const lease of leases) {
    if (taskIds.has(lease.taskId) || tokens.has(lease.runToken)) {
      throw new PathLeaseStoreError(`duplicate path-lease owner for repo ${repo}`);
    }
    taskIds.add(lease.taskId);
    tokens.add(lease.runToken);
  }
  for (let i = 0; i < leases.length; i += 1) {
    for (let j = i + 1; j < leases.length; j += 1) {
      if (
        leases[i]!.scopes.some((a) =>
          leases[j]!.scopes.some((b) => scopesOverlap(a, b)),
        )
      ) {
        throw new PathLeaseStoreError(`overlapping durable path leases for repo ${repo}`);
      }
    }
  }
  return {
    version: PATH_LEASE_VERSION,
    repo,
    leases,
  };
}

function serializeLeaseFile(file: PathLeaseFile): string {
  return JSON.stringify(file, null, 2) + '\n';
}

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

/**
 * Per work-root path lease store. Mutations are serialized via a promise chain
 * (in-process mutex). Concurrent acquire cannot interleave nextHeld writes.
 */
export class TaskPathLeaseStore {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly readIdentity: (pid: number) => OsProcessIdentity | null;
  private readonly identityAlive: (identity: OsProcessIdentity) => boolean | null;
  private readonly beforeDurableRename: (() => void | Promise<void>) | undefined;
  private readonly syncDirectory: (directory: string) => Promise<void>;
  private readonly unboundOwnerAlive: (
    repoKey: string,
    entry: PathLeaseEntry,
  ) => boolean | null;

  constructor(readonly workRoot: string, opts: TaskPathLeaseStoreOptions = {}) {
    this.readIdentity = opts.readProcessIdentity ?? readOsProcessIdentity;
    this.identityAlive = opts.processGroupIdentityAlive ?? isOsProcessGroupIdentityAlive;
    this.beforeDurableRename = opts.beforeDurableRename;
    this.syncDirectory = opts.syncDirectory ?? syncDirectory;
    this.unboundOwnerAlive =
      opts.unboundOwnerAlive ??
      ((repoKey, entry) =>
        hasManagedProcessForTask(
          join(this.workRoot, repoKey, entry.taskId),
          entry.taskId,
        ));
  }

  /**
   * Combine the exact original group with task-marker/cwd descendant proof.
   *
   * Bound owner group proven dead releases the lease unless a task-marked
   * writer is still proven alive. Unrelated inaccessible /proc entries that
   * make the marker scan return null must not poison reclaim forever once the
   * exact bound identity is dead (cli-only-readiness-diagnostics-v2 incident).
   * Missing bound identity / genuinely unknown group stays fail-closed.
   */
  private ownerAlive(repoKey: string, entry: PathLeaseEntry): boolean | null {
    const markerAlive = this.unboundOwnerAlive(repoKey, entry);
    if (!entry.ownerProcess) return markerAlive;
    const groupAlive = this.identityAlive(entry.ownerProcess);
    // Proven live writer (original group or escaped marked descendant) holds.
    if (groupAlive === true || markerAlive === true) return true;
    // Exact bound owner identity is dead: only a proven-live marker holds
    // (handled above). Unknown marker scan must not retain the lease.
    if (groupAlive === false) return false;
    // groupAlive === null — bound owner liveness genuinely unknown.
    return null;
  }

  private leasePath(repoKey: string): string {
    if (!isValidIdentifier(repoKey)) {
      throw new PathLeaseStoreError(`unsafe repo key for path lease: ${repoKey}`);
    }
    return join(this.workRoot, PATH_LEASE_DIRNAME, `${repoKey}.json`);
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    // Keep the chain alive even when the op fails (swallow for queueing only).
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readHeld(repoKey: string): Promise<readonly PathLeaseEntry[]> {
    const path = this.leasePath(repoKey);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      throw new PathLeaseStoreError(
        `could not read path leases for ${repoKey} (code ${safeErrorCode(err)})`,
        repoKey,
        safeErrorCode(err),
      );
    }
    return parseLeaseFile(raw, repoKey).leases;
  }

  private async writeHeld(repoKey: string, leases: readonly PathLeaseEntry[]): Promise<void> {
    const path = this.leasePath(repoKey);
    const body = serializeLeaseFile({
      version: PATH_LEASE_VERSION,
      repo: repoKey,
      leases,
    });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    let tempHandle: Awaited<ReturnType<typeof open>> | null = null;
    let replacementApplied = false;
    try {
      await mkdir(dirname(path), { recursive: true });
      tempHandle = await open(tmp, 'wx', 0o600);
      await tempHandle.writeFile(body, 'utf8');
      await tempHandle.sync();
      await tempHandle.close();
      tempHandle = null;
      await this.beforeDurableRename?.();
      await rename(tmp, path);
      replacementApplied = true;
      await this.syncDirectory(dirname(path));
    } catch (err) {
      if (tempHandle) await tempHandle.close().catch(() => undefined);
      await unlink(tmp).catch(() => undefined);
      const code = safeErrorCode(err);
      throw new PathLeaseStoreError(
        replacementApplied
          ? `path-lease replacement applied for ${repoKey}, but directory durability failed (code ${code}); re-read authoritative state`
          : `could not durably write path leases for ${repoKey} before replacement (code ${code})`,
        repoKey,
        code,
        replacementApplied,
      );
    }
  }

  /** Current held leases for a repo (empty when none). */
  async list(repoKey: string): Promise<readonly PathLeaseEntry[]> {
    return this.withLock(() => this.readHeld(repoKey));
  }

  /**
   * Atomically reclaim leases whose run tokens are not live, then return the
   * residual held set. Crash/restart recovery entry point.
   */
  async reclaimStale(
    repoKey: string,
    liveRunTokens: ReadonlySet<string>,
  ): Promise<{
    readonly reclaimed: readonly PathLeaseEntry[];
    readonly uncertain: readonly PathLeaseEntry[];
  }> {
    return this.withLock(async () => {
      const held = await this.readHeld(repoKey);
      const { nextHeld, reclaimed, uncertain } = reclaimStalePathLeases({
        held,
        liveRunTokens,
        ownerProcessAlive: (entry) => this.ownerAlive(repoKey, entry),
      });
      if (reclaimed.length > 0) {
        await this.writeHeld(repoKey, nextHeld);
      }
      return { reclaimed, uncertain };
    });
  }

  /**
   * Atomic acquire: read held → pure decide → write nextHeld.
   * On reject, durable state is unchanged.
   */
  async acquire(
    repoKey: string,
    input: Omit<PathLeaseAcquireInput, 'held'>,
  ): Promise<PathLeaseAcquireVerdict> {
    return this.withLock(async () => {
      const held = await this.readHeld(repoKey);
      const verdict = decidePathLeaseAcquire({ ...input, held });
      if (!verdict.ok) return verdict;
      // Legacy no-op (compatible, no declaration): nextHeld equals held and
      // entry.scopes is empty — do not persist a ghost lease.
      if (verdict.entry.scopes.length === 0 && verdict.nextHeld === held) {
        return verdict;
      }
      if (verdict.nextHeld !== held) {
        await this.writeHeld(repoKey, verdict.nextHeld);
      }
      return verdict;
    });
  }

  /** Release only when taskId + runToken both match. */
  async release(
    repoKey: string,
    taskId: string,
    runToken: string,
  ): Promise<PathLeaseReleaseVerdict> {
    return this.withLock(async () => {
      const held = await this.readHeld(repoKey);
      const verdict = decidePathLeaseRelease({ held, taskId, runToken });
      if (!verdict.ok) return verdict;
      await this.writeHeld(repoKey, verdict.nextHeld);
      return verdict;
    });
  }

  /**
   * Post-agent release boundary. Token ownership alone is insufficient because
   * adapter root exit does not prove a detached process group is gone.
   */
  async releaseIfOwnerDead(
    repoKey: string,
    taskId: string,
    runToken: string,
  ): Promise<
    | { readonly ok: true; readonly released: boolean; readonly ownerState: 'dead' | 'alive' | 'unknown' }
    | { readonly ok: false; readonly reason: 'not_found' | 'token_mismatch'; readonly detail: string }
  > {
    return this.withLock(async () => {
      const held = await this.readHeld(repoKey);
      const entry = held.find((candidate) => candidate.taskId === taskId);
      if (!entry) {
        return { ok: false as const, reason: 'not_found' as const, detail: `task ${taskId} does not hold a path lease` };
      }
      if (entry.runToken !== runToken) {
        return {
          ok: false as const,
          reason: 'token_mismatch' as const,
          detail: `run token does not own task ${taskId}'s path lease`,
        };
      }
      const alive = this.ownerAlive(repoKey, entry);
      if (alive !== false) {
        return {
          ok: true as const,
          released: false,
          ownerState: alive === true ? 'alive' as const : 'unknown' as const,
        };
      }
      const nextHeld = held.filter((candidate) => candidate !== entry);
      await this.writeHeld(repoKey, nextHeld);
      return { ok: true as const, released: true, ownerState: 'dead' as const };
    });
  }

  /**
   * Bind the exact detached process-group identity after adapter start. If the
   * identity cannot be proven, callers must stop the run and release the lease.
   */
  async bindOwnerProcess(
    repoKey: string,
    taskId: string,
    runToken: string,
    pid: number,
  ): Promise<{ readonly ok: true; readonly identity: OsProcessIdentity } | { readonly ok: false; readonly reason: string }> {
    return this.withLock(async () => {
      const held = await this.readHeld(repoKey);
      const index = held.findIndex((entry) => entry.taskId === taskId);
      if (index < 0) return { ok: false as const, reason: 'path lease not found' };
      const entry = held[index]!;
      if (entry.runToken !== runToken) {
        return { ok: false as const, reason: 'run token does not own path lease' };
      }
      const identity = this.readIdentity(pid);
      if (!identity) {
        return { ok: false as const, reason: `could not read process identity for pid ${pid}` };
      }
      const next = held.map((lease, at) =>
        at === index ? { ...lease, ownerProcess: identity } : lease,
      );
      await this.writeHeld(repoKey, next);
      return { ok: true as const, identity };
    });
  }

  /**
   * Prove the prior writer dead and durably clear its exact identity under one
   * lock. A replacement must not start until this succeeds.
   */
  async prepareReplacement(
    repoKey: string,
    taskId: string,
    runToken: string,
  ): Promise<
    | { readonly ok: true }
    | {
        readonly ok: false;
        readonly reason: 'not_found' | 'token_mismatch' | 'owner_alive' | 'owner_unknown';
        readonly detail: string;
      }
  > {
    return this.withLock(async () => {
      const held = await this.readHeld(repoKey);
      const index = held.findIndex((entry) => entry.taskId === taskId);
      if (index < 0) {
        return {
          ok: false as const,
          reason: 'not_found' as const,
          detail: `task ${taskId} does not hold a path lease`,
        };
      }
      const entry = held[index]!;
      if (entry.runToken !== runToken) {
        return {
          ok: false as const,
          reason: 'token_mismatch' as const,
          detail: `run token does not own task ${taskId}'s path lease`,
        };
      }
      const alive = this.ownerAlive(repoKey, entry);
      if (alive !== false) {
        return {
          ok: false as const,
          reason: alive === true ? 'owner_alive' as const : 'owner_unknown' as const,
          detail: alive === true
            ? `task ${taskId}'s prior path-lease owner is still alive`
            : `task ${taskId}'s prior path-lease owner liveness is unknown`,
        };
      }
      if (!entry.ownerProcess) return { ok: true as const };
      const next = held.map((lease, at) => {
        if (at !== index) return lease;
        const { ownerProcess: _ownerProcess, ...unbound } = lease;
        return unbound;
      });
      await this.writeHeld(repoKey, next);
      return { ok: true as const };
    });
  }
}
