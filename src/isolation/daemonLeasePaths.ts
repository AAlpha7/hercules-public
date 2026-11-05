/**
 * Canonical paths + diagnostic owner file I/O for the exclusive lease.
 * Control artifacts never land in the control worktree.
 */
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  DAEMON_LEASE_CONTROL_SIDECAR_DIR,
  DAEMON_LEASE_GIT_LOCK_FILENAME,
  DAEMON_LEASE_GIT_OWNER_FILENAME,
  DAEMON_LEASE_LOCK_FILENAME,
  DAEMON_LEASE_OWNER_FILENAME,
  parseLeaseRecord,
  scopeFingerprint,
  type DaemonLeaseRecord,
} from '../domain/daemonLease.js';
import {
  daemonLeaseIoError,
  type DaemonLeaseScopeKind,
} from './daemonLeaseErrors.js';

export interface LeasePathPair {
  readonly lockPath: string;
  readonly ownerPath: string;
}

/**
 * Canonical absolute path. Existing paths use realpath (symlink collapse);
 * missing leaf segments walk up to the nearest real parent so aliases and
 * not-yet-created children share one scope.
 */
export function resolveCanonicalPath(path: string): string {
  const abs = resolve(path);
  const missing: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpathSync(cur);
      return missing.length === 0 ? real : join(real, ...missing);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      missing.unshift(basename(cur));
      cur = parent;
    }
  }
}

export function workLeasePaths(workRoot: string): LeasePathPair {
  return {
    lockPath: join(workRoot, DAEMON_LEASE_LOCK_FILENAME),
    ownerPath: join(workRoot, DAEMON_LEASE_OWNER_FILENAME),
  };
}

export function resolveGitCommonDir(controlRepo: string): string | null {
  const gitPath = join(controlRepo, '.git');
  try {
    const st = statSync(gitPath);
    if (st.isDirectory()) return gitPath;
    if (st.isFile()) {
      const text = readFileSync(gitPath, 'utf8');
      const marker = 'gitdir:';
      const idx = text.indexOf(marker);
      if (idx < 0) return null;
      let rest = text.slice(idx + marker.length);
      const nl = rest.indexOf(String.fromCharCode(10));
      if (nl >= 0) rest = rest.slice(0, nl);
      const gitdir = resolve(controlRepo, rest.trim());
      try {
        const common = readFileSync(join(gitdir, 'commondir'), 'utf8').trim();
        return resolve(gitdir, common);
      } catch {
        return gitdir;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function controlLeasePaths(controlRepo: string): LeasePathPair {
  const gitCommon = resolveGitCommonDir(controlRepo);
  if (gitCommon) {
    return {
      lockPath: join(gitCommon, DAEMON_LEASE_GIT_LOCK_FILENAME),
      ownerPath: join(gitCommon, DAEMON_LEASE_GIT_OWNER_FILENAME),
    };
  }
  const abs = resolveCanonicalPath(controlRepo);
  const sidecar = join(
    dirname(abs),
    DAEMON_LEASE_CONTROL_SIDECAR_DIR,
    scopeFingerprint(abs),
  );
  return {
    lockPath: join(sidecar, DAEMON_LEASE_GIT_LOCK_FILENAME),
    ownerPath: join(sidecar, DAEMON_LEASE_GIT_OWNER_FILENAME),
  };
}

/** Read diagnostic owner JSON; missing/malformed => null (reclaimable). */
export function readOwnerFile(
  path: string,
  scopeKind: DaemonLeaseScopeKind,
): DaemonLeaseRecord | null {
  try {
    return parseLeaseRecord(readFileSync(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw daemonLeaseIoError('read_owner', scopeKind, path, err);
  }
}

/** Write diagnostic owner JSON (flock is the ownership primitive). */
export function writeOwnerFile(
  path: string,
  body: string,
  scopeKind: DaemonLeaseScopeKind,
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (err) {
    throw daemonLeaseIoError('mkdir', scopeKind, dirname(path), err);
  }
  try {
    writeFileSync(path, body, 'utf8');
  } catch (err) {
    throw daemonLeaseIoError('write_owner', scopeKind, path, err);
  }
}
