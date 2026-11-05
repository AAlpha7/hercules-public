/**
 * Atomic acquire / claim / release lifecycle for exclusive daemon leases.
 *
 * Order: fingerprint-sorted work+control locks; reverse-order release.
 * Post-flock steps (owner read, stale audit, owner write, hooks) are fully
 * wrapped so any exception releases the newly acquired hold.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  buildLeaseRecord,
  classifyLeaseOwner,
  classifyLegacyOwnerPid,
  DAEMON_LEASE_LOCK_FILENAME,
  DAEMON_LEASE_VERSION,
  formatLeaseConflictDiagnostic,
  formatStaleRecoveryDiagnostic,
  LEGACY_OWNER_LOCK_FILENAME,
  mayReleaseLease,
  parseLegacyOwnerPid,
  scopeFingerprint,
  serializeLeaseRecord,
  type DaemonLeaseIdentity,
  type DaemonLeaseRecord,
} from '../domain/daemonLease.js';
import {
  DaemonLeaseConflictError,
  DaemonLeaseError,
  daemonLeaseIoError,
  logDaemonLeaseIo,
  DaemonLeaseLostError,
  FlockBusyError,
  type DaemonLeaseScopeKind,
} from './daemonLeaseErrors.js';
import {
  acquireFlockHold,
  releaseFlockHold,
  type FlockHold,
} from './daemonLeaseFlock.js';
import {
  pidAlive,
  probeOwner,
  readBootId,
  readProcStarttime,
} from './daemonLeaseInspect.js';
import {
  controlLeasePaths,
  readOwnerFile,
  resolveCanonicalPath,
  workLeasePaths,
  writeOwnerFile,
  type LeasePathPair,
} from './daemonLeasePaths.js';

export interface DaemonLeaseFaultHooks {
  readonly afterOpenBeforeLock?: () => void | Promise<void>;
  readonly afterWorkAcquired?: () => void | Promise<void>;
  readonly beforeOwnerWrite?: () => void | Promise<void>;
}

export interface AcquireDaemonLeaseOptions {
  readonly controlRepo: string;
  readonly workRoot: string;
  readonly nowMs?: () => number;
  readonly instanceId?: string;
  readonly pid?: number;
  readonly hooks?: DaemonLeaseFaultHooks;
  readonly onStaleRecovery?: (message: string) => void;
  readonly readBootId?: () => string;
  readonly pidAlive?: (pid: number) => boolean;
  readonly readStarttime?: (pid: number) => string | null;
}

export interface HeldDaemonLease {
  readonly identity: DaemonLeaseIdentity;
  readonly record: DaemonLeaseRecord;
  readonly controlRepo: string;
  readonly workRoot: string;
  readonly paths: readonly LeasePathPair[];
  readonly flockPids: readonly number[];
  /** Settles when any flock child dies without intentional release. */
  readonly whenLost: Promise<void>;
  /** Fail-closed gate for mutation after unexpected loss or release. */
  assertHeld(): void;
  /** True while exclusive ownership is still live. */
  isHeld(): boolean;
  release(): Promise<void>;
}

interface HeldResource {
  readonly pair: LeasePathPair;
  readonly hold: FlockHold;
  readonly scopeKind: string;
}

function asScopeKind(scopeKind: string): DaemonLeaseScopeKind {
  if (scopeKind === 'control' || scopeKind === 'legacy') return scopeKind;
  return 'work';
}

function throwConflict(
  scope: { controlRepo: string; workRoot: string },
  owner: DaemonLeaseRecord,
  scopeKind: string,
): never {
  const kind = asScopeKind(scopeKind);
  throw new DaemonLeaseConflictError(
    formatLeaseConflictDiagnostic({
      scopeControl: scope.controlRepo,
      scopeWork: scope.workRoot,
      owner,
      scopeKind: kind,
    }),
    owner,
    kind,
  );
}

function conflictOwner(
  ownerPath: string,
  scope: { controlRepo: string; workRoot: string },
  scopeKind: string,
): DaemonLeaseRecord {
  const rec = readOwnerFile(ownerPath, asScopeKind(scopeKind));
  if (rec !== null) return rec;
  return {
    version: DAEMON_LEASE_VERSION,
    instanceId: 'unknown-live-holder',
    pid: 1,
    starttime: '',
    bootId: '',
    controlRepo: scope.controlRepo,
    workRoot: scope.workRoot,
    acquiredAtMs: 0,
  };
}

function noteStale(
  prev: DaemonLeaseRecord,
  us: DaemonLeaseIdentity,
  rs: (pid: number) => string | null,
  rb: () => string,
  alive: (pid: number) => boolean,
  onStale: (msg: string) => void,
  scopeKind: string,
): void {
  const st = classifyLeaseOwner(prev, us, probeOwner(prev.pid, rs, rb, alive));
  onStale(
    formatStaleRecoveryDiagnostic({
      owner: prev,
      reason: st.kind === 'stale' ? st.reason : 'prior flock released',
      scopeKind: asScopeKind(scopeKind),
    }),
  );
}

/**
 * Acquire one scope's flock + write owner record.
 * Every exception after flock success releases the new hold (fail-closed).
 */
async function claimOneResource(
  pair: LeasePathPair,
  body: string,
  us: DaemonLeaseIdentity,
  scope: { controlRepo: string; workRoot: string },
  scopeKind: string,
  readStarttime: (pid: number) => string | null,
  readBoot: () => string,
  alive: (pid: number) => boolean,
  onStale: (msg: string) => void,
  hooks: DaemonLeaseFaultHooks | undefined,
): Promise<HeldResource> {
  let hold: FlockHold;
  try {
    hold = await acquireFlockHold(pair.lockPath, hooks, asScopeKind(scopeKind));
  } catch (err) {
    if (err instanceof FlockBusyError) {
      throwConflict(scope, conflictOwner(pair.ownerPath, scope, scopeKind), scopeKind);
    }
    throw err;
  }
  // Entire post-lock sequence: release hold on any failure.
  try {
    const prev = readOwnerFile(pair.ownerPath, asScopeKind(scopeKind));
    if (prev !== null && prev.instanceId !== us.instanceId) {
      noteStale(prev, us, readStarttime, readBoot, alive, onStale, scopeKind);
    }
    if (hooks?.beforeOwnerWrite) await hooks.beforeOwnerWrite();
    writeOwnerFile(pair.ownerPath, body, asScopeKind(scopeKind));
    return { pair, hold, scopeKind };
  } catch (err) {
    try {
      await releaseFlockHold(hold);
    } catch (relErr) {
      logDaemonLeaseIo('release_flock', asScopeKind(scopeKind), hold.lockPath, relErr);
    }
    throw err;
  }
}

async function releaseHeldResources(
  identity: DaemonLeaseIdentity,
  resources: readonly HeldResource[],
): Promise<void> {
  for (let i = resources.length - 1; i >= 0; i--) {
    const r = resources[i];
    if (r === undefined) continue;
    try {
      const sk = asScopeKind(r.scopeKind);
      const rec = readOwnerFile(r.pair.ownerPath, sk);
      if (mayReleaseLease(rec, identity)) {
        try {
          unlinkSync(r.pair.ownerPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            logDaemonLeaseIo('unlink_owner', sk, r.pair.ownerPath, err);
          }
        }
      }
    } catch (err) {
      const skFail = asScopeKind(r.scopeKind);
      logDaemonLeaseIo('read_owner', skFail, r.pair.ownerPath, err);
    } finally {
      try {
        await releaseFlockHold(r.hold);
      } catch (err) {
        logDaemonLeaseIo('release_flock', asScopeKind(r.scopeKind), r.hold.lockPath, err);
      }
    }
  }
}

async function releaseHeldResourcesPreservingPrimary(
  identity: DaemonLeaseIdentity,
  resources: readonly HeldResource[],
  primary: unknown,
): Promise<never> {
  try {
    await releaseHeldResources(identity, resources);
  } catch (cleanupErr) {
    const sample = resources[0];
    const path = sample !== undefined ? sample.pair.lockPath : 'lease-rollback';
    const kind = sample !== undefined ? asScopeKind(sample.scopeKind) : 'work';
    logDaemonLeaseIo('rollback_cleanup', kind, path, cleanupErr);
  }
  throw primary;
}

/** Best-effort path release for a prior identity (owner-only). */
async function releaseOnePath(
  identity: DaemonLeaseIdentity,
  pair: LeasePathPair,
): Promise<void> {
  let hold: FlockHold;
  const sk: DaemonLeaseScopeKind =
    basename(pair.lockPath) === DAEMON_LEASE_LOCK_FILENAME ? 'work' : 'control';
  try {
    hold = await acquireFlockHold(pair.lockPath, undefined, sk);
  } catch (err) {
    // Live successor holds the flock — expected no-op; never delete their owner.
    if (err instanceof FlockBusyError) {
      return;
    }
    logDaemonLeaseIo('acquire_for_release', sk, pair.lockPath, err);
    return;
  }
  try {
    const rec = readOwnerFile(pair.ownerPath, sk);
    if (mayReleaseLease(rec, identity)) {
      try {
        unlinkSync(pair.ownerPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          logDaemonLeaseIo('unlink_owner', sk, pair.ownerPath, err);
        }
      }
    }
  } catch (err) {
    logDaemonLeaseIo('read_owner', sk, pair.ownerPath, err);
  } finally {
    try {
      await releaseFlockHold(hold);
    } catch (err) {
      logDaemonLeaseIo('release_flock', sk, hold.lockPath, err);
    }
  }
}

/** Release by re-acquiring each path's flock (reverse order). Owner-only. */
export async function releaseDaemonLease(
  identity: DaemonLeaseIdentity,
  paths: readonly LeasePathPair[],
): Promise<void> {
  for (let i = paths.length - 1; i >= 0; i--) {
    const pair = paths[i];
    if (pair === undefined) continue;
    try {
      await releaseOnePath(identity, pair);
    } catch (err) {
      const sk: DaemonLeaseScopeKind =
        basename(pair.lockPath) === DAEMON_LEASE_LOCK_FILENAME
          ? 'work'
          : 'control';
      logDaemonLeaseIo('release_path', sk, pair.lockPath, err);
    }
  }
}

async function clearLegacyIfNeeded(
  workRoot: string,
  ourPid: number,
  alive: (p: number) => boolean,
): Promise<void> {
  const legacy = join(workRoot, LEGACY_OWNER_LOCK_FILENAME);
  try {
    const legacyPid = parseLegacyOwnerPid(readFileSync(legacy, 'utf8'));
    const st = classifyLegacyOwnerPid(
      legacyPid,
      ourPid,
      legacyPid !== null && alive(legacyPid),
    );
    if (st.kind === 'live_foreign') {
      throwConflict({ controlRepo: workRoot, workRoot }, st.owner, 'legacy');
    }
    if (st.kind === 'stale' || st.kind === 'ours') {
      try {
        rmSync(legacy);
      } catch (rmErr) {
        if ((rmErr as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw daemonLeaseIoError('clear_legacy', 'legacy', legacy, rmErr);
        }
      }
    }
  } catch (err) {
    if (err instanceof DaemonLeaseConflictError) throw err;
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (err instanceof DaemonLeaseError) throw err;
      throw daemonLeaseIoError('read_legacy', 'legacy', legacy, err);
    }
  }
}

function buildHeld(
  identity: DaemonLeaseIdentity,
  record: DaemonLeaseRecord,
  controlRepo: string,
  workRoot: string,
  resources: HeldResource[],
): HeldDaemonLease {
  let state: 'held' | 'released' | 'lost' = 'held';
  const whenLost = new Promise<void>((resolve) => {
    let settled = false;
    const markLost = (): void => {
      if (settled) return;
      settled = true;
      if (state === 'held') state = 'lost';
      resolve();
    };
    for (const r of resources) {
      void r.hold.whenLost.then(markLost);
    }
  });

  function isHeld(): boolean {
    if (state !== 'held') return false;
    for (const r of resources) {
      if (!r.hold.isAlive()) {
        state = 'lost';
        return false;
      }
    }
    return true;
  }

  return {
    identity,
    record,
    controlRepo,
    workRoot,
    paths: resources.map((r) => r.pair),
    flockPids: resources.map((r) => r.hold.pid),
    whenLost,
    isHeld,
    assertHeld(): void {
      if (!isHeld()) {
        throw new DaemonLeaseLostError(
          state === 'released' ? 'released' : 'lost',
        );
      }
    },
    async release(): Promise<void> {
      if (state === 'released') return;
      // Intentional release: flock holds mark intentional so exit does not
      // treat this as unexpected whenLost. Idempotent after first call.
      state = 'released';
      await releaseHeldResources(identity, resources);
    },
  };
}

export function defaultWorkRoot(controlRepoDir: string): string {
  return resolve(controlRepoDir, '..', 'hercules-work');
}

/** Acquire exclusive lease on (control, work) scope. Fail-closed on conflict. */
export async function acquireDaemonLease(
  opts: AcquireDaemonLeaseOptions,
): Promise<HeldDaemonLease> {
  const controlRepo = resolveCanonicalPath(opts.controlRepo);
  const workRoot = resolveCanonicalPath(opts.workRoot);
  try {
    mkdirSync(workRoot, { recursive: true });
  } catch (err) {
    throw daemonLeaseIoError('mkdir', 'work', workRoot, err);
  }
  try {
    mkdirSync(controlRepo, { recursive: true });
  } catch (err) {
    throw daemonLeaseIoError('mkdir', 'control', controlRepo, err);
  }
  const ourPid = opts.pid ?? process.pid;
  const rs = opts.readStarttime ?? readProcStarttime;
  const rb = opts.readBootId ?? readBootId;
  const alive = opts.pidAlive ?? pidAlive;
  const identity: DaemonLeaseIdentity = {
    instanceId: opts.instanceId ?? randomUUID(),
    pid: ourPid,
    starttime: rs(ourPid) ?? '',
    bootId: rb(),
  };
  const now = opts.nowMs ? opts.nowMs() : Date.now();
  const record = buildLeaseRecord(identity, { controlRepo, workRoot }, now);
  const body = serializeLeaseRecord(record);
  const onStale =
    opts.onStaleRecovery ??
    ((msg: string) => {
      console.error('[hercules] ' + msg);
    });
  const hooks = opts.hooks;
  const scope = { controlRepo, workRoot };

  await clearLegacyIfNeeded(workRoot, ourPid, alive);

  // Deterministic fingerprint order avoids multi-resource deadlock.
  const ordered = [
    { pair: workLeasePaths(workRoot), scopeKind: 'work' as const },
    { pair: controlLeasePaths(controlRepo), scopeKind: 'control' as const },
  ].sort((a, b) =>
    scopeFingerprint(a.pair.lockPath).localeCompare(
      scopeFingerprint(b.pair.lockPath),
    ),
  );

  const resources: HeldResource[] = [];
  try {
    for (const t of ordered) {
      resources.push(
        await claimOneResource(
          t.pair,
          body,
          identity,
          scope,
          t.scopeKind,
          rs,
          rb,
          alive,
          onStale,
          hooks,
        ),
      );
      // afterWorkAcquired stays inside try so rejection rolls back.
      if (t.scopeKind === 'work' && hooks?.afterWorkAcquired) {
        await hooks.afterWorkAcquired();
      }
    }
  } catch (err) {
    return await releaseHeldResourcesPreservingPrimary(
      identity,
      resources,
      err,
    );
  }
  return buildHeld(identity, record, controlRepo, workRoot, resources);
}

export async function acquireMainDaemonLease(
  controlRepoDir: string,
  workRoot: string,
): Promise<HeldDaemonLease> {
  const held = await acquireDaemonLease({
    controlRepo: controlRepoDir,
    workRoot,
  });
  console.error(
    '[hercules] daemon lease acquired instance=' +
      held.identity.instanceId +
      ' controlFp=' +
      scopeFingerprint(held.controlRepo) +
      ' workFp=' +
      scopeFingerprint(held.workRoot),
  );
  return held;
}

/**
 * Composition-root helper: acquire exclusive lease, then run early boot
 * (e.g. L2 seed). Any boot failure releases the held generation so a
 * successor can start.
 */
export async function acquireLeaseForDaemonStartup(
  controlRepoDir: string,
  workRoot: string,
  earlyBoot: () => void | Promise<void>,
): Promise<HeldDaemonLease> {
  const lease = await acquireMainDaemonLease(controlRepoDir, workRoot);
  try {
    await earlyBoot();
  } catch (err) {
    try {
      await lease.release();
    } catch (releaseErr) {
      logDaemonLeaseIo('release_after_startup_failure', 'work', lease.workRoot, releaseErr);
    }
    throw err;
  }
  return lease;
}
