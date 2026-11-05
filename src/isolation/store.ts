/**
 * pnpm shared-store health (SPEC §8.4).
 *
 * pnpm's content-addressed store hard-links packages into each worktree's
 * node_modules instead of copying — a major disk/install saving on the
 * constrained target box. Hard links cannot cross filesystems, so this only
 * works when the store and the worktrees share one device; otherwise pnpm
 * silently falls back to copying and every worktree duplicates node_modules.
 *
 * The daemon uses pnpm's default global store, so the property holds when the
 * store and the work root are on the same filesystem. This check makes a
 * regression (e.g. work root moved to a separate mount) loud at boot rather
 * than a silent disk blowout.
 */
import { statSync, type StatFn } from './statfs.js';

export interface StoreHardlinkStatus {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Whether pnpm can hard-link from `storeDir` into worktrees under `workRoot`
 * (i.e. they are on the same filesystem device). Unknown (unstat-able) paths
 * return ok — the dirs are created lazily and we must not false-alarm at boot.
 */
export function storeHardlinksAcrossWorktrees(
  storeDir: string,
  workRoot: string,
  stat: StatFn = statSync,
): StoreHardlinkStatus {
  let storeDev: number;
  let workDev: number;
  try {
    storeDev = stat(storeDir).dev;
    workDev = stat(workRoot).dev;
  } catch {
    return { ok: true, reason: 'could not stat store/work paths (unknown; not blocking)' };
  }
  if (storeDev === workDev) return { ok: true };
  return {
    ok: false,
    reason:
      `pnpm store (${storeDir}) and work root (${workRoot}) are on different ` +
      `filesystems — hard links cannot cross devices, so pnpm will COPY and ` +
      `each worktree duplicates node_modules (SPEC §8.4). Put the pnpm store ` +
      `on the same filesystem as the work root.`,
  };
}
