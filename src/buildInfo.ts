/**
 * Deploy-visible build identity.
 *
 * Format: `vYYYYMMDD.<n>` where `<n>` is how many commits on HEAD landed on
 * that UTC calendar day (≈ “today’s push count” for a linear main).
 * Example: third ship on 2026-07-13 → `v20260713.3`
 *
 * Phone chip shows `7/13 · #3` (month/day + count). Tap copies the full stamp.
 * Prefer env `HERCULES_VERSION` when set (CI / packaged dist).
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface BuildInfo {
  /** Canonical stamp, e.g. v20260713.3 */
  readonly version: string;
  /** Short git sha (support / debug; not the primary UI label). */
  readonly gitSha: string;
  readonly dirty: boolean;
  /** Commits on this UTC day reachable from HEAD (1-based push index). */
  readonly dayPush: number;
  /** UTC YYYYMMDD used in the stamp. */
  readonly dateYmd: string;
  /** ISO time the process resolved build info (startup). */
  readonly resolvedAt: string;
}

let cached: BuildInfo | null = null;

/** Project root (repo checkout) — works for both src/ and dist/src/ layouts. */
function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  if (here.endsWith(`${join('dist', 'src')}`) || here.endsWith('/dist/src')) {
    return join(here, '..', '..');
  }
  return join(here, '..');
}

function git(args: readonly string[], cwd: string): string | null {
  try {
    return execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Auditable runtime capability boundary for Guardian B-022. A compile-time
 * boolean is not evidence: the running checkout must be clean and its HEAD
 * must contain the exact merged control baseline.
 */
export function currentBuildContains(
  requiredRevision: string,
  cwd = repoRoot(),
): boolean {
  if (!/^[0-9a-f]{40}$/i.test(requiredRevision) || isGitDirty(cwd)) return false;
  const head = git(['rev-parse', 'HEAD'], cwd);
  if (!head || !/^[0-9a-f]{40}$/i.test(head)) return false;
  const base = git(['merge-base', requiredRevision, head], cwd);
  return base?.toLowerCase() === requiredRevision.toLowerCase();
}

export function ymdUtc(d = new Date()): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * How many commits on `HEAD` have committer date on the given UTC day.
 * Counts as “pushes today” for a linear main (each deploy commit increments).
 */
export function countDayPushes(cwd: string, dateYmd: string): number {
  // dateYmd = YYYYMMDD → ISO day bounds in UTC
  if (!/^\d{8}$/.test(dateYmd)) return 1;
  const y = dateYmd.slice(0, 4);
  const m = dateYmd.slice(4, 6);
  const day = dateYmd.slice(6, 8);
  const since = `${y}-${m}-${day}T00:00:00Z`;
  const until = `${y}-${m}-${day}T23:59:59Z`;
  const out = git(
    ['rev-list', '--count', `--since=${since}`, `--until=${until}`, 'HEAD'],
    cwd,
  );
  const n = out ? Number(out) : 0;
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), 999);
}

/** Canonical stamp: vYYYYMMDD.<dayPush> */
export function formatBuildVersion(input: {
  readonly dateYmd: string;
  readonly dayPush: number;
}): string {
  const n = Math.max(1, Math.min(999, Math.floor(input.dayPush) || 1));
  return `v${input.dateYmd}.${n}`;
}

/**
 * Phone chip label — keeps the calendar day visible.
 * `v20260713.3` → `7/13 · #3`
 */
export function displayBuildLabel(version: string): string {
  const m = /^v(\d{4})(\d{2})(\d{2})\.(\d{1,3})\b/.exec(version.trim());
  if (!m) {
    // Legacy sha-based stamps still show something short.
    const legacy = /^v\d{8}\.([0-9a-fA-F]{4,12})/.exec(version.trim());
    if (legacy?.[1]) return legacy[1].toLowerCase();
    return version.replace(/^v/, '').slice(0, 14) || 'dev';
  }
  const month = String(Number(m[2]));
  const day = String(Number(m[3]));
  return `${month}/${day} · #${m[4]}`;
}

/** Full string for clipboard (support-friendly). */
export function clipboardBuildText(info: {
  version: string;
  gitSha?: string;
  dirty?: boolean;
}): string {
  const parts = [info.version];
  if (info.gitSha && info.gitSha !== 'unknown') parts.push(info.gitSha);
  if (info.dirty) parts.push('dirty');
  return parts.join(' · ');
}

/**
 * Tracked-file dirtiness only (`-uno`). Untracked `tmp/` does not count.
 */
export function isGitDirty(cwd: string): boolean {
  const out = git(['status', '--porcelain', '-uno'], cwd);
  return out !== null && out.length > 0;
}

export function resolveBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  if (cached) return cached;
  const resolvedAt = new Date().toISOString();
  const forced = env['HERCULES_VERSION']?.trim();
  if (forced) {
    const cleaned = forced.replace(/\.dirty$/i, '');
    const parsed = /^v(\d{8})\.(\d{1,3})\b/.exec(cleaned);
    const dateYmd = parsed?.[1] ?? ymdUtc();
    const dayPush = parsed?.[2] ? Number(parsed[2]) : 1;
    cached = {
      version: cleaned,
      gitSha: 'forced',
      dirty: forced.toLowerCase().endsWith('.dirty'),
      dayPush: Number.isFinite(dayPush) ? dayPush : 1,
      dateYmd,
      resolvedAt,
    };
    return cached;
  }

  const root = repoRoot();
  const dateYmd = ymdUtc();
  const dayPush = countDayPushes(root, dateYmd);
  const sha = git(['rev-parse', '--short=7', 'HEAD'], root) ?? 'unknown';
  const dirty = isGitDirty(root);
  cached = {
    version: formatBuildVersion({ dateYmd, dayPush }),
    gitSha: sha,
    dirty,
    dayPush,
    dateYmd,
    resolvedAt,
  };
  return cached;
}

/** Test-only: clear the process-level cache. */
export function resetBuildInfoCache(): void {
  cached = null;
}
