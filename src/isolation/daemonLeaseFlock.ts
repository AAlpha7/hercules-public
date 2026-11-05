/**
 * util-linux flock transport + lifetime-loss signal.
 *
 * Ownership primitive:
 *   /usr/bin/flock -n -E 73 <lockPath> /usr/bin/cat
 *
 * Stdin stays open for the lease lifetime; release ends stdin.
 * After a successful handshake a lifetime exit watcher remains attached.
 * Unexpected child death resolves whenLost (intentional release does not).
 */
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  daemonLeaseIoError,
  DaemonLeaseIOError,
  FLOCK_BIN,
  FLOCK_CONFLICT_EXIT,
  FLOCK_HOLDER_BIN,
  FlockBusyError,
  type DaemonLeaseScopeKind,
} from './daemonLeaseErrors.js';

export {
  DaemonLeaseError,
  DaemonLeaseIOError,
  daemonLeaseIoError,
  errnoCodeFrom,
  DaemonLeaseConflictError,
  DaemonLeaseLostError,
  FlockBusyError,
  FLOCK_BIN,
  FLOCK_CONFLICT_EXIT,
  FLOCK_HOLDER_BIN,
  type DaemonLeaseScopeKind,
} from './daemonLeaseErrors.js';

/** Live util-linux flock holder (stdin kept open for lease lifetime). */
export interface FlockHold {
  readonly child: ChildProcessWithoutNullStreams;
  readonly lockPath: string;
  readonly pid: number;
  /** Resolves only on unexpected exit (not intentional release). */
  readonly whenLost: Promise<void>;
  /** True while the flock child is still running. */
  isAlive(): boolean;
  /** Mark intentional release so exit does not signal whenLost. */
  markIntentionalRelease(): void;
}

export interface FlockFaultHooks {
  readonly afterOpenBeforeLock?: () => void | Promise<void>;
}

/**
 * Minimal non-secret env for the flock/cat child — never HERCULES_* tokens,
 * never DATABASE_URL / NODE_OPTIONS / secrets.
 */
export function flockChildEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'TMPDIR',
  ] as const) {
    const v = env[key];
    if (v !== undefined && v.length > 0) out[key] = v;
  }
  if (out['PATH'] === undefined) out['PATH'] = '/usr/bin:/bin';
  return out;
}

function killQuiet(child: ChildProcessWithoutNullStreams): void {
  try {
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
  } catch {
    return;
  }
}

function ensureLockFile(
  lockPath: string,
  scopeKind: DaemonLeaseScopeKind,
): void {
  const dir = dirname(lockPath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw daemonLeaseIoError('mkdir', scopeKind, dir, err);
  }
  try {
    writeFileSync(lockPath, '', { flag: 'a' });
  } catch (err) {
    throw daemonLeaseIoError('open_lock', scopeKind, lockPath, err);
  }
}

/** True when `buf` contains a complete line exactly equal to `nonce`. */
export function hasExactNonceLine(buf: string, nonce: string): boolean {
  if (nonce.length === 0) return false;
  if (!buf.includes('\n')) return false;
  const parts = buf.split('\n');
  // Final segment is incomplete unless buffer ends with newline.
  const complete = parts.slice(0, -1);
  return complete.some((line) => line === nonce);
}

function waitExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    child.once('exit', () => finish());
    // end() can EPIPE if the child already closed stdin; swallow so release
    // stays idempotent and never surfaces uncaught stream errors.
    try {
      child.stdin.end(() => {
        // cat exits after EOF; exit handler finishes the promise.
      });
    } catch {
      killQuiet(child);
      finish();
    }
  });
}

function attachLifetime(holdBase: {
  child: ChildProcessWithoutNullStreams;
  lockPath: string;
  pid: number;
}): FlockHold {
  let intentional = false;
  let lostSettled = false;
  let resolveLost: () => void = () => undefined;
  const whenLost = new Promise<void>((resolve) => {
    resolveLost = resolve;
  });
  holdBase.child.on('exit', () => {
    if (intentional || lostSettled) return;
    lostSettled = true;
    resolveLost();
  });
  return {
    child: holdBase.child,
    lockPath: holdBase.lockPath,
    pid: holdBase.pid,
    whenLost,
    isAlive: () =>
      holdBase.child.exitCode === null && holdBase.child.signalCode === null,
    markIntentionalRelease: () => {
      intentional = true;
    },
  };
}

/**
 * Map child exit to typed failure. Conflict exit 73 becomes FlockBusyError so
 * claimOneResource can promote it to DaemonLeaseConflictError.
 */
function mapEarlyExit(
  lockPath: string,
  code: number | null,
  scopeKind: DaemonLeaseScopeKind,
): Error {
  if (code === FLOCK_CONFLICT_EXIT) return new FlockBusyError();
  const exitCode = code === null ? 'UNKNOWN' : String(code);
  return new DaemonLeaseIOError({
    operation: 'flock_early_exit',
    scopeKind,
    path: lockPath,
    code: exitCode,
  });
}

async function handshake(
  child: ChildProcessWithoutNullStreams,
  lockPath: string,
  nonce: string,
  scopeKind: DaemonLeaseScopeKind,
): Promise<FlockHold> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let out = '';
    const fail = (e: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killQuiet(child);
      reject(e);
    };
    const ok = (h: FlockHold): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Lifetime watcher stays attached via attachLifetime (exit listener).
      resolve(h);
    };
    const timer = setTimeout(() => {
      fail(daemonLeaseIoError('flock_handshake', scopeKind, lockPath));
    }, 5000);

    // flock -n busy exits before cat runs, so writing the nonce races with
    // EPIPE. Without a stdin error listener Node surfaces uncaught EPIPE and
    // aborts the process/test. Never promote bare EPIPE to IO while exit may
    // still report conflict 73 — exit handler (or handshake timeout) decides.
    const onStdinIssue = (): void => {
      if (settled) return;
      const code = child.exitCode;
      if (code !== null) {
        fail(mapEarlyExit(lockPath, code, scopeKind));
      }
      // else: wait for exit event or the handshake timeout (fail-closed).
    };
    // Must be attached before write; also swallows post-settle EPIPE on kill.
    child.stdin.on('error', () => {
      onStdinIssue();
    });

    child.on('error', (e) => {
      fail(daemonLeaseIoError('flock_spawn', scopeKind, lockPath, e));
    });
    child.on('exit', (code) => {
      if (settled) return;
      fail(mapEarlyExit(lockPath, code ?? null, scopeKind));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
      if (hasExactNonceLine(out, nonce) && child.pid !== undefined) {
        ok(attachLifetime({ child, lockPath, pid: child.pid }));
      }
    });
    try {
      child.stdin.write(nonce + '\n', (writeErr) => {
        if (writeErr) onStdinIssue();
      });
    } catch {
      onStdinIssue();
    }
  });
}

/**
 * Spawn: /usr/bin/flock -n -E 73 <lockPath> /usr/bin/cat
 * Hold for lease lifetime via open stdin; handshake = exact nonce line echo.
 */
export async function acquireFlockHold(
  lockPath: string,
  hooks?: FlockFaultHooks,
  scopeKind: DaemonLeaseScopeKind = 'work',
): Promise<FlockHold> {
  ensureLockFile(lockPath, scopeKind);
  if (hooks?.afterOpenBeforeLock) await hooks.afterOpenBeforeLock();
  const nonce = randomBytes(16).toString('hex');
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(
      FLOCK_BIN,
      ['-n', '-E', String(FLOCK_CONFLICT_EXIT), lockPath, FLOCK_HOLDER_BIN],
      { env: flockChildEnv(), stdio: ['pipe', 'pipe', 'pipe'] },
    ) as ChildProcessWithoutNullStreams;
  } catch (err) {
    throw daemonLeaseIoError('flock_spawn', scopeKind, lockPath, err);
  }
  // Drain stderr so a chatty flock never blocks on a full pipe.
  child.stderr.resume();
  return handshake(child, lockPath, nonce, scopeKind);
}

/** End stdin so cat exits and flock is released by the kernel. */
export async function releaseFlockHold(hold: FlockHold): Promise<void> {
  hold.markIntentionalRelease();
  if (hold.child.exitCode !== null) return;
  if (hold.child.signalCode !== null) return;
  await waitExit(hold.child);
}
