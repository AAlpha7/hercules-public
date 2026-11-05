/**
 * Generic process-group TERM→KILL ladder (gates, boot servers, chrome, …).
 *
 * Not chrome-specific — callers supply log labels. CDP residual cleanup wraps
 * this with "chrome cleanup" messages; L1 gates must not log chrome wording.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { nextProcessGroupCleanupSignal } from '../domain/stagingVerify.js';
import {
  isForceVerificationCancel,
  type VerificationCancelReason,
} from '../domain/verificationRun.js';

export interface KillProcessGroupOpts {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  readonly isAlive?: (pid: number) => boolean;
  /** Grace after SIGTERM before SIGKILL. Ignored when force (immediate KILL). */
  readonly graceMs?: number;
  readonly log?: (line: string) => void;
  /** Log noun, e.g. "process-group" or "chrome cleanup". */
  readonly label?: string;
  /**
   * Force path: skip SIGTERM grace and SIGKILL immediately (and again if still
   * alive). Used by human force-abort during verification.
   */
  readonly force?: boolean;
  /**
   * Mutable cancel reason (same object as AbortSignal.reason). Polled during
   * graceful wait so force-abort after soft cancel escalates without re-abort.
   */
  readonly cancelReason?: VerificationCancelReason;
}

/**
 * A detached shell can exit before cargo/chromium descendants. Probe the
 * process group first so that a dead leader never makes cleanup stop early.
 */
export function isProcessGroupAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    try {
      // Fallback for a non-detached process or a platform without group probes.
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Kill a process group: SIGTERM → brief wait → SIGKILL (or immediate KILL when
 * force). Idempotent — dead pids / already-killed groups are no-ops.
 */
export async function killProcessGroup(
  pid: number,
  opts: KillProcessGroupOpts = {},
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const sleepFn = opts.sleep ?? ((ms: number) => sleep(ms));
  const killFn =
    opts.kill ??
    ((target: number, signal: NodeJS.Signals) => {
      process.kill(target, signal);
    });
  const isAlive = opts.isAlive ?? isProcessGroupAlive;
  const label = opts.label ?? 'process-group';
  const log = opts.log ?? ((line: string) => console.error(`[hercules] ${line}`));
  const graceMs = opts.graceMs ?? 400;

  const wantForce = (): boolean =>
    opts.force === true || isForceVerificationCancel(opts.cancelReason);

  let termSent = false;
  let killSent = false;

  // Force: jump straight to KILL (no TERM grace hang under cargo/chrome).
  if (wantForce()) {
    termSent = true; // skip TERM step in the ladder
  }

  for (let i = 0; i < 3; i += 1) {
    if (wantForce() && !killSent) {
      termSent = true;
    }
    const alive = isAlive(pid);
    const next = nextProcessGroupCleanupSignal({ alive, termSent, killSent });
    if (next === 'done') {
      if (!alive) log(`${label} pid=${pid}: already dead (noop)`);
      return;
    }
    const signal: NodeJS.Signals = next === 'TERM' ? 'SIGTERM' : 'SIGKILL';
    try {
      // Negative pid → process group (requires detached spawn).
      killFn(-pid, signal);
      log(`${label} pid=${pid}: sent ${signal} to process group`);
    } catch {
      try {
        killFn(pid, signal);
        log(`${label} pid=${pid}: sent ${signal} to process`);
      } catch {
        log(`${label} pid=${pid}: ${signal} failed (gone?)`);
      }
    }
    if (next === 'TERM') termSent = true;
    if (next === 'KILL') killSent = true;

    // Graceful wait is interruptible: force-abort mid-wait escalates now.
    if (next === 'TERM') {
      const slice = Math.max(25, Math.min(100, graceMs));
      let waited = 0;
      while (waited < graceMs) {
        if (wantForce()) break;
        await sleepFn(Math.min(slice, graceMs - waited));
        waited += slice;
        if (!isAlive(pid)) break;
      }
    } else {
      await sleepFn(wantForce() ? 0 : graceMs);
    }
  }
}
