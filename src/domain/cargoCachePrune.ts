/**
 * Domain — cargo target auto-prune policy (disk hygiene for shared caches).
 *
 * Pure: no IO. Isolation layer walks/deletes; this module only:
 *  - path safety (only cargo output dirs named `target` / `.shared-target`)
 *  - which files to drop (all debug/incremental; large old debug/deps)
 *  - one-line operator log + phone banner note
 *
 * Growth source (2026-07-28): orbit verify stacks ~1–2G test bins under
 * debug/deps forever + 31G incremental. Never hard-code host paths here —
 * callers pass configured roots (repos.yaml / HERCULES_CARGO_TARGET_DIR).
 */

import { formatFreeGiB } from './diskPressure.js';

/** Default: keep large debug/deps files newer than this many days. */
export const DEFAULT_CARGO_CACHE_RETAIN_DAYS = 2;
/** Only prune deps files larger than this (default 100 MiB). */
export const DEFAULT_CARGO_LARGE_FILE_BYTES = 100 * 1024 * 1024;
/**
 * Same-named artifact hash generations to keep under debug/deps (by mtime).
 * High-frequency same-day rebuilds otherwise fill the retain window with
 * obsolete hashes of the same crate. 0 disables generation capping.
 */
export const DEFAULT_CARGO_DEPS_KEEP_GENERATIONS = 2;
/**
 * Default active-build mtime window for debug/incremental/* (seconds of age).
 * Fresh writes inside this window mean a cargo build may still be running —
 * skip incremental wipe unless `force` (disk 95% emergency).
 */
export const DEFAULT_ACTIVE_BUILD_WINDOW_MS = 120_000;

export type CargoCachePruneTrigger = 'verify-teardown' | 'disk-pressure';

/** Why we believe cargo is still writing under this target root. */
export type ActiveBuildReason = 'cargo-lock' | 'package-cache' | 'incremental-mtime';

export interface CargoCacheFileMeta {
  /** Path relative to the cargo target root, using `/` separators. */
  readonly relPath: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

export interface CargoCachePrunePlan {
  /** All files under debug/incremental/ (fully regenerative). */
  readonly incremental: readonly string[];
  /** Large, stale files under debug/deps/. */
  readonly deps: readonly string[];
}

/**
 * True when `path` is an absolute cargo output root we are allowed to prune.
 * Segment match only — `my-target-dir` is NOT enough; must be `target` or
 * `.shared-target` as a path component (plus optional children).
 */
export function isSafeCargoTargetPath(path: string): boolean {
  const raw = path.trim();
  if (raw.length === 0) return false;
  // Absolute only — never resolve relative (could escape into source trees).
  if (!raw.startsWith('/')) return false;
  // Reject obvious traversal before segment check.
  if (raw.includes('/../') || raw.endsWith('/..') || raw.includes('/./')) return false;
  const parts = raw.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) return false;
  return parts.some((p) => p === 'target' || p === '.shared-target');
}

function normalizeRel(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * Group key for cargo deps hash generations: strip trailing `-<hex>` before
 * the extension. `libfoo-aaaaaaaaaaaaaaaa.rlib` → `libfoo.rlib`.
 * Non-hash names return null (age filter only).
 */
export function depsArtifactGenerationKey(relPath: string): string | null {
  const base = normalizeRel(relPath).split('/').pop() ?? '';
  if (base.length === 0) return null;
  // rustc metadata hashes are hex; require ≥8 chars to avoid false stems.
  const m = /^(.+)-([0-9a-fA-F]{8,})(\.[^.]+)?$/.exec(base);
  if (!m) return null;
  const stem = m[1] ?? '';
  const ext = m[3] ?? '';
  if (stem.length === 0) return null;
  return `${stem}${ext}`;
}

/**
 * Pure selection: wipe debug/incremental entirely; drop large debug/deps that
 * are outside the retain window OR are excess hash generations of the same
 * artifact (keep latest N by mtime). Everything else is left alone.
 *
 * `retainDays <= 0` disables the age filter (pressure-escalation second pass:
 * all large deps are eligible). Generation capping still applies unless
 * `keepGenerations` is 0.
 */
export function planCargoCachePrune(
  files: readonly CargoCacheFileMeta[],
  opts: {
    readonly nowMs: number;
    readonly retainDays?: number;
    readonly largeFileBytes?: number;
    /** Keep latest N hash gens per stem; default 2; 0 = disable. */
    readonly keepGenerations?: number;
  },
): CargoCachePrunePlan {
  const retainDays = opts.retainDays ?? DEFAULT_CARGO_CACHE_RETAIN_DAYS;
  const largeFileBytes = opts.largeFileBytes ?? DEFAULT_CARGO_LARGE_FILE_BYTES;
  const keepGenerations =
    opts.keepGenerations ?? DEFAULT_CARGO_DEPS_KEEP_GENERATIONS;
  // retainDays<=0 → no age retain (pressure escalation / operator retainDays=0).
  const ageFilterOff = retainDays <= 0;
  const cutoffMs = ageFilterOff
    ? Number.POSITIVE_INFINITY
    : opts.nowMs - retainDays * 86_400_000;
  const incremental: string[] = [];
  const depsSet = new Set<string>();

  const largeDeps: CargoCacheFileMeta[] = [];

  for (const f of files) {
    const rel = normalizeRel(f.relPath);
    if (rel === 'debug/incremental' || rel.startsWith('debug/incremental/')) {
      incremental.push(rel);
      continue;
    }
    if (
      (rel === 'debug/deps' || rel.startsWith('debug/deps/')) &&
      f.sizeBytes > largeFileBytes
    ) {
      largeDeps.push({ ...f, relPath: rel });
      if (ageFilterOff || f.mtimeMs < cutoffMs) {
        depsSet.add(rel);
      }
    }
  }

  // Same-stem hash generation cap: among large deps sharing a key, keep the
  // newest N by mtime and mark the rest for deletion (even inside the window).
  if (keepGenerations > 0) {
    const byKey = new Map<string, CargoCacheFileMeta[]>();
    for (const f of largeDeps) {
      const key = depsArtifactGenerationKey(f.relPath);
      if (key === null) continue;
      const list = byKey.get(key) ?? [];
      list.push(f);
      byKey.set(key, list);
    }
    for (const group of byKey.values()) {
      if (group.length <= keepGenerations) continue;
      const sorted = [...group].sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const drop of sorted.slice(keepGenerations)) {
        depsSet.add(normalizeRel(drop.relPath));
      }
    }
  }

  return { incremental, deps: [...depsSet] };
}

/**
 * After a disk-pressure first pass, decide whether the aggressive second pass
 * (retainDays=0 deps) should run for a given target root.
 *
 * Conservative: only when disk is still critical. Active builds skip the
 * upgrade pass unless `force` (emergency override).
 */
export function shouldRunPressureEscalationPass(input: {
  readonly stillCritical: boolean;
  readonly activeBuild: boolean;
  readonly force?: boolean;
}): boolean {
  if (!input.stillCritical) return false;
  if (input.activeBuild && input.force !== true) return false;
  return true;
}

/**
 * Pure mtime fallback for live-build detection: any file under
 * `debug/incremental/` with mtime within `windowMs` of `nowMs` counts as
 * activity. Lock flock (isolation) is preferred when available; this catches
 * builds that hold no probeable lock file yet still rewrite incremental.
 */
export function hasRecentIncrementalActivity(
  files: readonly CargoCacheFileMeta[],
  opts: {
    readonly nowMs: number;
    readonly windowMs?: number;
  },
): boolean {
  const windowMs = opts.windowMs ?? DEFAULT_ACTIVE_BUILD_WINDOW_MS;
  const cutoffMs = opts.nowMs - windowMs;
  for (const f of files) {
    const rel = normalizeRel(f.relPath);
    if (
      (rel === 'debug/incremental' || rel.startsWith('debug/incremental/')) &&
      f.mtimeMs >= cutoffMs
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Collect configured cargo target roots. No defaults — empty means skip prune
 * (never invent an acme path).
 *
 * `envValue` may be comma- or colon-separated absolute paths.
 */
export function resolveCargoTargetDirs(input: {
  readonly envValue?: string | null | undefined;
  readonly repoPaths?: readonly (string | null | undefined)[];
}): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | null | undefined): void => {
    if (raw === null || raw === undefined) return;
    const p = raw.trim();
    if (p.length === 0) return;
    if (seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };
  const env = input.envValue?.trim();
  if (env) {
    for (const part of env.split(/[,:]+/)) push(part);
  }
  for (const r of input.repoPaths ?? []) push(r);
  return out;
}

/** One-line operator digest (always safe — no secrets). */
export function formatCargoCachePruneLogLine(input: {
  readonly trigger: CargoCachePruneTrigger | string;
  readonly targetDir: string;
  readonly incrementalDeleted: number;
  readonly depsDeleted: number;
  readonly freedBytes: number;
  readonly durationMs: number;
  readonly dryRun: boolean;
  readonly rejected?: boolean;
}): string {
  const mode = input.rejected ? 'rejected' : input.dryRun ? 'dry-run' : 'apply';
  const freed = formatFreeGiB(input.freedBytes);
  return (
    `[hercules] cargo-cache-prune ${mode} trigger=${input.trigger} ` +
    `dir=${input.targetDir} incremental=${input.incrementalDeleted} ` +
    `deps=${input.depsDeleted} freed=${freed} ${input.durationMs}ms`
  );
}

/** Phone banner fragment after auto-prune at disk warn. */
export function formatCargoPruneBannerNote(freedBytes: number): string {
  return `已自动修剪, 释放 ${formatFreeGiB(freedBytes)}`;
}

/**
 * Operator tip when disk-pressure prune fires with zero configured roots.
 * Once per pressure episode only (caller latches the log, not the prune).
 */
export function formatCargoCachePruneSkipNoDirsLogLine(): string {
  return (
    '[hercules] cargo-cache-prune skipped: no cargo_target_dir configured ' +
    '(set repos.yaml cargo_target_dir or HERCULES_CARGO_TARGET_DIRS)'
  );
}

/**
 * Operator line when incremental wipe is skipped because a live cargo build
 * was detected (lock held or recent incremental mtime). Deps prune still runs.
 */
export function formatCargoCachePruneSkipActiveBuildLogLine(input: {
  readonly trigger: CargoCachePruneTrigger | string;
  readonly targetDir: string;
  readonly reason: ActiveBuildReason | string;
}): string {
  return (
    `[hercules] cargo-cache-prune skipped: 检测到活动构建 ` +
    `trigger=${input.trigger} dir=${input.targetDir} reason=${input.reason}`
  );
}

/**
 * Operator warn when force=true overrides live-build protection (disk emergency).
 * Incremental wipe proceeds; caller still logs the normal apply line after.
 */
export function formatCargoCachePruneForceActiveBuildLogLine(input: {
  readonly trigger: CargoCachePruneTrigger | string;
  readonly targetDir: string;
  readonly reason: ActiveBuildReason | string;
}): string {
  return (
    `[hercules] cargo-cache-prune force: 检测到活动构建仍清理 incremental ` +
    `trigger=${input.trigger} dir=${input.targetDir} reason=${input.reason}`
  );
}

/**
 * Operator line when disk is still critical after the configured retain-window
 * pass — second pass drops age retain (retainDays=0) for large deps only.
 */
export function formatCargoCachePruneEscalationLogLine(input: {
  readonly trigger: CargoCachePruneTrigger | string;
  readonly retainDays: number;
}): string {
  return (
    `[hercules] cargo-cache-prune 压力升级第二遍 ` +
    `trigger=${input.trigger} retainDays=${input.retainDays}`
  );
}
