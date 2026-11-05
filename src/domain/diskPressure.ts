/**
 * Domain layer — disk watermark policy (harness self-protection).
 *
 * The root disk filled to 100% twice in three days (47 GB cargo cache regrowth
 * from orbit Rust gates, 2026-07-22): daemon writes, control-repo commits and
 * session saves all start failing silently. Pure mapping from free/total bytes
 * to a pressure level; the orchestrator logs on WARN and stops dispatching new
 * agents on CRITICAL (running work may finish; no new fuel on the fire).
 *
 * Dispatch-hold surface (2026-07-24 silent-stuck-queue incident): when the
 * tick pauses dispatch for disk pressure, RuntimeView carries the same reason
 * the pause decision used — phone banner + decision inbox, never silent todo.
 */

export type DiskPressureLevel = 'ok' | 'warn' | 'critical';

export interface DiskPressure {
  readonly level: DiskPressureLevel;
  /** Percent used, rounded (0-100). */
  readonly usedPct: number;
  readonly freeBytes: number;
}

/**
 * Why the orchestrator is not feeding new agents. Extensible for future hold
 * reasons (mem, cost hard-cap day, …). Pure shape — no IO.
 */
export interface DispatchHold {
  readonly reason: 'disk' | 'configured';
  /** Operator-facing zh one-liner with exact numbers (pct + free). */
  readonly detail: string;
}

/** ≥ this % used → warn (log loudly, surface amber hint; no pause). */
export const DISK_WARN_PCT = 85;
/** ≥ this % used → critical (stop dispatching new agents). */
export const DISK_CRITICAL_PCT = 95;

export function evaluateDiskPressure(
  freeBytes: number | null,
  totalBytes: number | null,
): DiskPressure | null {
  if (
    freeBytes === null ||
    totalBytes === null ||
    !Number.isFinite(freeBytes) ||
    !Number.isFinite(totalBytes) ||
    totalBytes <= 0
  ) {
    return null; // unknown (read failure) — never block on missing data
  }
  const usedPct = Math.round(((totalBytes - freeBytes) / totalBytes) * 100);
  const level: DiskPressureLevel =
    usedPct >= DISK_CRITICAL_PCT ? 'critical' : usedPct >= DISK_WARN_PCT ? 'warn' : 'ok';
  return { level, usedPct, freeBytes };
}

/** Phone-friendly free space ("4.7G", "12G"). */
export function formatFreeGiB(freeBytes: number): string {
  const g = freeBytes / 1024 ** 3;
  if (!Number.isFinite(g) || g < 0) return '?G';
  if (g >= 10) return `${Math.round(g)}G`;
  // One decimal under 10G so 4.7G stays exact (not 5G).
  return `${(Math.round(g * 10) / 10).toFixed(1)}G`;
}

/**
 * Zh detail shared by the red pause banner and the amber warn hint.
 * Critical includes the recovery promise; warn only urges cleanup.
 */
export function formatDiskDetail(p: DiskPressure): string {
  const free = formatFreeGiB(p.freeBytes);
  if (p.level === 'critical') {
    return `磁盘 ${p.usedPct}% (剩 ${free}) — 清出空间后自动恢复`;
  }
  if (p.level === 'warn') {
    return `磁盘 ${p.usedPct}% (剩 ${free}) — 接近满盘，建议清理`;
  }
  return `磁盘 ${p.usedPct}% (剩 ${free})`;
}

/**
 * Same code path as the pause decision: critical → hold, else null.
 * Orchestrator must call this on the pressure it just evaluated.
 */
export function toDispatchHold(p: DiskPressure | null): DispatchHold | null {
  if (p === null || p.level !== 'critical') return null;
  return { reason: 'disk', detail: formatDiskDetail(p) };
}

/**
 * Amber hint only in the warn band (critical uses dispatchHold instead).
 * When cargo auto-prune just ran, append the operator-facing free note.
 */
export function toDiskWarnDetail(
  p: DiskPressure | null,
  opts?: { readonly pruneNote?: string | null },
): string | null {
  if (p === null || p.level !== 'warn') return null;
  const base = formatDiskDetail(p);
  const note = opts?.pruneNote?.trim();
  if (note) return `${base} — ${note}`;
  return base;
}
