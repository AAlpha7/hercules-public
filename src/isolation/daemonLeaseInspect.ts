/**
 * Process liveness probes + work-root ownership inspection.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyLeaseOwner,
  classifyLegacyOwnerPid,
  LEGACY_OWNER_LOCK_FILENAME,
  parseLegacyOwnerPid,
  type DaemonLeaseIdentity,
  type DaemonLeaseRecord,
  type LeaseOwnerStatus,
  type OwnerLivenessProbe,
} from '../domain/daemonLease.js';
import { daemonLeaseIoError } from './daemonLeaseErrors.js';
import {
  readOwnerFile,
  resolveCanonicalPath,
  workLeasePaths,
} from './daemonLeasePaths.js';

export function readProcStarttime(pid: number): string | null {
  try {
    const raw = readFileSync('/proc/' + String(pid) + '/stat', 'utf8');
    const closeParen = raw.lastIndexOf(')');
    if (closeParen < 0) return null;
    const rest = raw.slice(closeParen + 2).trim().split(/\s+/);
    const starttime = rest[19];
    return starttime !== undefined && starttime.length > 0 ? starttime : null;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readBootId(): string {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return '';
  }
}

export function probeOwner(
  pid: number,
  readStarttime: (pid: number) => string | null,
  readBoot: () => string,
  alive: (pid: number) => boolean,
): OwnerLivenessProbe {
  const isAlive = alive(pid);
  return {
    pidAlive: isAlive,
    currentStarttime: isAlive ? readStarttime(pid) : null,
    currentBootId: readBoot(),
  };
}

function inspectLegacy(
  root: string,
  ourPid: number,
  alive: (pid: number) => boolean,
  record: DaemonLeaseRecord | null,
): LeaseOwnerStatus {
  try {
    const legacyRaw = readFileSync(
      join(root, LEGACY_OWNER_LOCK_FILENAME),
      'utf8',
    );
    const legacyPid = parseLegacyOwnerPid(legacyRaw);
    let legacyAlive = false;
    if (legacyPid !== null) legacyAlive = alive(legacyPid);
    return classifyLegacyOwnerPid(legacyPid, ourPid, legacyAlive);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw daemonLeaseIoError('read_legacy', 'legacy', join(root, LEGACY_OWNER_LOCK_FILENAME), err);
    }
  }
  if (record === null) return { kind: 'absent' };
  return { kind: 'invalid', detail: 'malformed lease record' };
}

/** Classify work-root ownership for reclaim and diagnostics. */
export function inspectWorkRootOwnership(
  workRoot: string,
  opts: {
    identity?: DaemonLeaseIdentity;
    pid?: number;
    instanceId?: string;
    readStarttime?: typeof readProcStarttime;
    readBootId?: typeof readBootId;
    pidAlive?: typeof pidAlive;
  } = {},
): LeaseOwnerStatus {
  const ourPid = opts.identity?.pid ?? opts.pid ?? process.pid;
  const us: DaemonLeaseIdentity = opts.identity ?? {
    instanceId: opts.instanceId ?? 'inspect',
    pid: ourPid,
    starttime: '',
    bootId: '',
  };
  const rs = opts.readStarttime ?? readProcStarttime;
  const rb = opts.readBootId ?? readBootId;
  const alive = opts.pidAlive ?? pidAlive;
  const root = resolveCanonicalPath(workRoot);
  const record = readOwnerFile(workLeasePaths(root).ownerPath, 'work');
  if (record !== null) {
    const status = classifyLeaseOwner(
      record,
      us,
      probeOwner(record.pid, rs, rb, alive),
    );
    if (
      status.kind === 'ours' ||
      status.kind === 'live_foreign' ||
      status.kind === 'stale'
    ) {
      return status;
    }
  }
  return inspectLegacy(root, ourPid, alive, record);
}
