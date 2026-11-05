/**
 * Isolation — cargo target auto-prune (FS side of domain/cargoCachePrune).
 *
 * Safety: refuse any root that fails isSafeCargoTargetPath before listing or
 * deleting. Only removes under debug/incremental/* and large stale
 * debug/deps/* (plan from domain). Never walks outside the given root.
 *
 * Live-build safety (2026-07-31): before wiping incremental, detect an active
 * cargo build via non-blocking flock on `.cargo-lock` / `.package-cache`, then
 * mtime window under debug/incremental. Skip incremental wipe (log 跳过) unless
 * `force` (disk emergency). Deps mtime window is already safe and always runs.
 */
import { execFile } from 'node:child_process';
import { readdir, rm, stat, lstat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  DEFAULT_ACTIVE_BUILD_WINDOW_MS,
  DEFAULT_CARGO_CACHE_RETAIN_DAYS,
  DEFAULT_CARGO_DEPS_KEEP_GENERATIONS,
  DEFAULT_CARGO_LARGE_FILE_BYTES,
  formatCargoCachePruneForceActiveBuildLogLine,
  formatCargoCachePruneLogLine,
  formatCargoCachePruneSkipActiveBuildLogLine,
  hasRecentIncrementalActivity,
  isSafeCargoTargetPath,
  planCargoCachePrune,
  shouldRunPressureEscalationPass,
  type ActiveBuildReason,
  type CargoCacheFileMeta,
  type CargoCachePruneTrigger,
} from '../domain/cargoCachePrune.js';

const execFileAsync = promisify(execFile);

export class CargoCachePruneError extends Error {
  override readonly name = 'CargoCachePruneError';
}

export interface CargoCachePruneResult {
  readonly targetDir: string;
  readonly incrementalDeleted: number;
  readonly depsDeleted: number;
  readonly freedBytes: number;
  readonly durationMs: number;
  readonly dryRun: boolean;
  readonly rejected: boolean;
  readonly logLine: string;
  readonly trigger: string;
}

export interface PruneCargoCacheOpts {
  readonly dryRun?: boolean;
  readonly retainDays?: number;
  readonly largeFileBytes?: number;
  readonly nowMs?: number;
  readonly trigger?: CargoCachePruneTrigger | string;
  /**
   * Wipe incremental even when an active cargo build is detected.
   * Default false — only for disk-critical emergency paths.
   */
  readonly force?: boolean;
  /**
   * Disk-pressure second pass (retainDays=0). When true, an active build
   * skips the entire pass (deps included) unless `force` — more aggressive
   * than the first pass, which still prunes age-stale deps under load.
   */
  readonly pressureEscalation?: boolean;
  /** Keep latest N hash generations of same-named large deps (default 2). */
  readonly keepGenerations?: number;
  /** Active-build mtime window in ms (default 120s). */
  readonly activeBuildWindowMs?: number;
  /** Optional logger (defaults to console.error). */
  readonly log?: (line: string) => void;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Non-blocking exclusive flock probe. Returns true when another process holds
 * the lock (cargo mid-build). Missing file → not locked. flock binary missing
 * or probe errors → treat as unlocked (mtime fallback still applies).
 */
async function isExclusivelyLocked(lockPath: string): Promise<boolean> {
  if (!(await pathExists(lockPath))) return false;
  try {
    // flock -n: fail immediately if lock held; -c true releases on exit.
    await execFileAsync('flock', ['-n', lockPath, '-c', 'true'], {
      timeout: 2_000,
    });
    return false;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: string | number; status?: number };
    // flock conflict exit is 1; missing binary is ENOENT — both fall through.
    if (e.code === 'ENOENT') return false;
    // Non-zero exit from flock -n means lock is held (or rare I/O error).
    if (typeof e.status === 'number' && e.status !== 0) return true;
    if (typeof e.code === 'number' && e.code !== 0) return true;
    return false;
  }
}

/**
 * Detect active cargo build under a target root. Order: lock flock first
 * (`.cargo-lock`, then `.package-cache`), then incremental mtime window.
 */
export async function detectActiveCargoBuild(
  targetRoot: string,
  files: readonly CargoCacheFileMeta[],
  opts: { readonly nowMs: number; readonly windowMs?: number },
): Promise<{ active: true; reason: ActiveBuildReason } | { active: false }> {
  if (await isExclusivelyLocked(join(targetRoot, '.cargo-lock'))) {
    return { active: true, reason: 'cargo-lock' };
  }
  if (await isExclusivelyLocked(join(targetRoot, '.package-cache'))) {
    return { active: true, reason: 'package-cache' };
  }
  // Also probe directory mtimes under incremental (cargo touches crate dirs).
  const incRoot = join(targetRoot, 'debug', 'incremental');
  const windowMs = opts.windowMs ?? DEFAULT_ACTIVE_BUILD_WINDOW_MS;
  const cutoffMs = opts.nowMs - windowMs;
  if (await pathExists(incRoot)) {
    try {
      const entries = await readdir(incRoot, { withFileTypes: true });
      for (const ent of entries) {
        const child = join(incRoot, ent.name);
        try {
          const st = await lstat(child);
          if (st.isSymbolicLink()) continue;
          if (st.mtimeMs >= cutoffMs) {
            return { active: true, reason: 'incremental-mtime' };
          }
        } catch {
          continue;
        }
      }
    } catch {
      // unreadable incremental — fall through to file list
    }
  }
  if (hasRecentIncrementalActivity(files, { nowMs: opts.nowMs, windowMs })) {
    return { active: true, reason: 'incremental-mtime' };
  }
  return { active: false };
}

/**
 * Recursively list files under `root` as paths relative to root (`/` sep).
 * Skips symlinks (do not follow) so a crafty link cannot escape the tree.
 */
async function listFilesRecursive(root: string): Promise<CargoCacheFileMeta[]> {
  const out: CargoCacheFileMeta[] = [];

  async function walk(abs: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const child = join(abs, ent.name);
      let st;
      try {
        st = await lstat(child);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        await walk(child);
        continue;
      }
      if (!st.isFile()) continue;
      const rel = relative(root, child).split(sep).join('/');
      out.push({
        relPath: rel,
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
  }

  await walk(root);
  return out;
}

function assertSafeRoot(targetDir: string): string {
  const trimmed = targetDir.trim();
  if (!isSafeCargoTargetPath(trimmed)) {
    throw new CargoCachePruneError(
      `refusing cargo cache prune: path is not a cargo output dir ` +
        `(must be absolute and contain a "target" or ".shared-target" segment): ${trimmed}`,
    );
  }
  return trimmed;
}

/**
 * Prune one cargo target directory. Throws {@link CargoCachePruneError} when
 * the path fails the safety guard (nothing is deleted). Missing dirs → empty
 * success (verify hosts often have no shared target).
 */
export async function pruneCargoCacheTarget(
  targetDir: string,
  opts: PruneCargoCacheOpts = {},
): Promise<CargoCachePruneResult> {
  const started = Date.now();
  const dryRun = opts.dryRun === true;
  const trigger = opts.trigger ?? 'verify-teardown';
  const log = opts.log ?? ((line: string) => console.error(line));
  const nowMs = opts.nowMs ?? Date.now();
  const retainDays = opts.retainDays ?? DEFAULT_CARGO_CACHE_RETAIN_DAYS;
  const largeFileBytes = opts.largeFileBytes ?? DEFAULT_CARGO_LARGE_FILE_BYTES;

  let root: string;
  try {
    root = assertSafeRoot(targetDir);
  } catch (err) {
    const durationMs = Date.now() - started;
    const logLine = formatCargoCachePruneLogLine({
      trigger,
      targetDir: targetDir.trim(),
      incrementalDeleted: 0,
      depsDeleted: 0,
      freedBytes: 0,
      durationMs,
      dryRun,
      rejected: true,
    });
    // Still throw so callers/tests see the guard — but log first.
    log(logLine);
    throw err;
  }

  if (!(await pathExists(root))) {
    const durationMs = Date.now() - started;
    const result: CargoCachePruneResult = {
      targetDir: root,
      incrementalDeleted: 0,
      depsDeleted: 0,
      freedBytes: 0,
      durationMs,
      dryRun,
      rejected: false,
      trigger,
      logLine: formatCargoCachePruneLogLine({
        trigger,
        targetDir: root,
        incrementalDeleted: 0,
        depsDeleted: 0,
        freedBytes: 0,
        durationMs,
        dryRun,
      }),
    };
    log(result.logLine);
    return result;
  }

  const files = await listFilesRecursive(root);
  const keepGenerations = opts.keepGenerations ?? DEFAULT_CARGO_DEPS_KEEP_GENERATIONS;
  const plan = planCargoCachePrune(files, {
    nowMs,
    retainDays,
    largeFileBytes,
    keepGenerations,
  });
  const sizeByRel = new Map(files.map((f) => [f.relPath.replace(/\\/g, '/'), f.sizeBytes]));
  const force = opts.force === true;
  const pressureEscalation = opts.pressureEscalation === true;
  const activeBuildWindowMs = opts.activeBuildWindowMs ?? DEFAULT_ACTIVE_BUILD_WINDOW_MS;
  const live = await detectActiveCargoBuild(root, files, {
    nowMs,
    windowMs: activeBuildWindowMs,
  });
  // Escalation second pass: skip entirely when active build (unless force).
  // First pass: skip only incremental; age-gated deps still safe under load.
  const escalateOk = shouldRunPressureEscalationPass({
    stillCritical: true, // isolation only sees this flag when orchestrator already decided critical
    activeBuild: live.active,
    force,
  });
  const skipEscalationForActiveBuild = pressureEscalation && !escalateOk;
  const wipeIncremental = !skipEscalationForActiveBuild && (!live.active || force);
  const wipeDeps = !skipEscalationForActiveBuild;

  if (live.active && !force) {
    log(
      formatCargoCachePruneSkipActiveBuildLogLine({
        trigger,
        targetDir: root,
        reason: live.reason,
      }),
    );
  } else if (live.active && force) {
    log(
      formatCargoCachePruneForceActiveBuildLogLine({
        trigger,
        targetDir: root,
        reason: live.reason,
      }),
    );
  }

  let freedBytes = 0;
  let incrementalDeleted = 0;
  let depsDeleted = 0;

  const deleteRel = async (rel: string, bucket: 'incremental' | 'deps'): Promise<void> => {
    const abs = join(root, ...rel.split('/'));
    // Confine: resolved path must still be under root.
    const relCheck = relative(root, abs);
    if (relCheck.startsWith('..') || relCheck.startsWith(`..${sep}`)) {
      throw new CargoCachePruneError(`path escape blocked: ${rel}`);
    }
    const sz = sizeByRel.get(rel) ?? 0;
    if (!dryRun) {
      await rm(abs, { force: true }).catch(() => undefined);
    }
    freedBytes += sz;
    if (bucket === 'incremental') incrementalDeleted += 1;
    else depsDeleted += 1;
  };

  if (wipeIncremental) {
    for (const rel of plan.incremental) {
      await deleteRel(rel, 'incremental');
    }
  }
  // Deps: first pass always; escalation pass only when not skipped for active build.
  if (wipeDeps) {
    for (const rel of plan.deps) {
      await deleteRel(rel, 'deps');
    }
  }

  // Best-effort: remove empty incremental dirs after file wipe.
  if (!dryRun && wipeIncremental && plan.incremental.length > 0) {
    const incRoot = join(root, 'debug', 'incremental');
    await rm(incRoot, { recursive: true, force: true }).catch(() => undefined);
    await import('node:fs/promises')
      .then((m) => m.mkdir(incRoot, { recursive: true }))
      .catch(() => undefined);
  }

  const durationMs = Date.now() - started;
  const result: CargoCachePruneResult = {
    targetDir: root,
    incrementalDeleted,
    depsDeleted,
    freedBytes,
    durationMs,
    dryRun,
    rejected: false,
    trigger,
    logLine: formatCargoCachePruneLogLine({
      trigger,
      targetDir: root,
      incrementalDeleted,
      depsDeleted,
      freedBytes,
      durationMs,
      dryRun,
    }),
  };
  log(result.logLine);
  return result;
}

/**
 * Prune every configured target dir. Skips unsafe paths (logs + continues)
 * so one bad repos.yaml entry cannot abort the whole tick.
 */
export async function pruneCargoCacheTargets(
  targetDirs: readonly string[],
  opts: PruneCargoCacheOpts = {},
): Promise<{
  readonly results: readonly CargoCachePruneResult[];
  readonly freedBytes: number;
}> {
  const results: CargoCachePruneResult[] = [];
  let freedBytes = 0;
  for (const dir of targetDirs) {
    try {
      const r = await pruneCargoCacheTarget(dir, opts);
      results.push(r);
      freedBytes += r.freedBytes;
    } catch (err) {
      if (err instanceof CargoCachePruneError) {
        // already logged inside pruneCargoCacheTarget
        continue;
      }
      const log = opts.log ?? ((line: string) => console.error(line));
      log(
        `[hercules] cargo-cache-prune error dir=${dir}: ${(err as Error).message}`,
      );
    }
  }
  return { results, freedBytes };
}
