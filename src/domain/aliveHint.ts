/**
 * Domain — live honesty when the agent process is alive but the stream is quiet.
 *
 * Case study (orbit onboarding, 2026-07-15): cargo/rustc ran for tens of minutes
 * with no stream events. processAlive correctly skipped idle-stall, but the phone
 * looked "stuck" (empty activity). Vision: human *reviews*, not *supervises* —
 * so mid-run must surface "working but quiet" without requiring SSH.
 *
 * Pure helpers only (no /proc I/O). Process-tree sampling lives in adapters/.
 */

/** Emit a synthetic quiet-progress line after this much stream silence. */
export const QUIET_PROGRESS_THRESHOLD_MS = 30_000;

/**
 * Known heavy child names we surface as an "alive hint" on the phone.
 * Order is priority when several match (more specific first).
 */
export const KNOWN_WORKER_COMMS: readonly string[] = [
  'rustc',
  'cargo',
  'clippy-driver',
  'rustdoc',
  'pnpm',
  'npm',
  'yarn',
  'node',
  'vitest',
  'jest',
  'tsx',
  'tsc',
  'eslint',
  'webpack',
  'esbuild',
  'vite',
  'pytest',
  'python',
  'python3',
  'go',
  'java',
  'gradle',
  'mvn',
  'make',
  'cmake',
  'ninja',
  'cc1',
  'cc1plus',
  'clang',
  'gcc',
  'ld',
  'chrome',
  'chromium',
  'headless_shell',
  'playwright',
  'ffmpeg',
  'docker',
  'podman',
  'git',
];

/**
 * Pick a single human-readable worker name from process comm strings.
 * Returns null when nothing recognizable is running under the agent.
 */
export function pickWorkerName(comms: readonly string[]): string | null {
  if (comms.length === 0) return null;
  const normalized = comms
    .map((c) => c.trim().toLowerCase())
    // Linux /proc/comm truncates at 15 chars; strip path basenames if present.
    .map((c) => {
      const slash = c.lastIndexOf('/');
      return slash >= 0 ? c.slice(slash + 1) : c;
    })
    .filter((c) => c.length > 0);

  for (const known of KNOWN_WORKER_COMMS) {
    for (const c of normalized) {
      if (c === known || c.startsWith(known) || known.startsWith(c)) {
        return known;
      }
    }
  }
  // Fallback: first non-shell / non-agent wrapper name.
  const skip = new Set([
    'sh',
    'bash',
    'dash',
    'zsh',
    'fish',
    'grok',
    'claude',
    'codex',
    'node', // often the agent itself; prefer more specific above
  ]);
  for (const c of normalized) {
    if (!skip.has(c) && !c.startsWith('grok') && !c.startsWith('claude')) {
      return c.slice(0, 24);
    }
  }
  return null;
}

/** Compact duration for phone lines ("12m", "2h 5m", "45s"). */
export function formatCompactMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return sec > 0 && m < 10 ? `${m}m ${sec}s` : `${m}m`;
  return `${sec}s`;
}

/**
 * CPU% of the worker tree from two cumulative-jiffies samples. Can exceed
 * 100 on multi-core builds. Null when no honest number exists (no wall time
 * elapsed, or counters went backwards after a child died).
 */
export function cpuPctFromSamples(
  prev: { readonly jiffies: number; readonly atMs: number },
  cur: { readonly jiffies: number; readonly atMs: number },
  hz: number,
): number | null {
  const wallMs = cur.atMs - prev.atMs;
  const dj = cur.jiffies - prev.jiffies;
  if (wallMs <= 0 || dj < 0 || hz <= 0) return null;
  return Math.round(((dj / hz) * 1000 * 100) / wallMs);
}

/** "1.4GB" / "300MB" for phone lines. */
export function formatRssMb(rssMb: number): string {
  if (rssMb >= 1024) return `${(rssMb / 1024).toFixed(1)}GB`;
  return `${Math.round(rssMb)}MB`;
}

/**
 * Synthetic activity line: process is alive, stream is quiet (long tool).
 * Not a stall — hard kill still applies at maxRunMs. When process stats are
 * known they ride inside the parens so the quiet line visibly *moves*
 * (CPU fluctuates) until real output replaces it.
 */
export function formatQuietProgressLine(input: {
  readonly silenceMs: number;
  readonly runMs: number;
  readonly maxRunMs: number;
  readonly aliveHint: string | null;
  readonly cpuPct?: number | null;
  readonly rssMb?: number | null;
}): string {
  const quiet = formatCompactMs(input.silenceMs);
  const run = formatCompactMs(input.runMs);
  const hard = formatCompactMs(input.maxRunMs);
  const bits: string[] = [];
  if (input.aliveHint?.trim()) bits.push(input.aliveHint.trim());
  if (typeof input.cpuPct === 'number') bits.push(`CPU ${input.cpuPct}%`);
  if (typeof input.rssMb === 'number') bits.push(formatRssMb(input.rssMb));
  const hint = bits.length > 0 ? ` (${bits.join(' · ')})` : '';
  return `⏱ Quiet ${quiet} — process alive${hint} · run ${run} / hard kill ${hard}`;
}

/** Whether stream silence is long enough to warrant a quiet-progress signal. */
export function shouldShowQuietProgress(silenceMs: number, processAlive: boolean): boolean {
  return processAlive && silenceMs >= QUIET_PROGRESS_THRESHOLD_MS;
}

/**
 * Prefer tool-stream labels over /proc when the adapter surfaces tool events.
 * Maps "Bash: cargo test", "shell cargo", "tool:pnpm" → a short worker name.
 */
export function hintFromToolLabel(label: string): string | null {
  const raw = label.trim();
  if (raw.length === 0) return null;
  // Strip common prefixes from activity lines.
  const stripped = raw
    .replace(/^\$\s*/, '')
    .replace(/^(bash|shell|tool|run|exec|command)[:\s]+/i, '')
    .trim();
  const tokens = stripped.split(/[\s/;|&]+/).filter((t) => t.length > 0);
  // Prefer a known worker token anywhere in the command line.
  for (const tok of tokens) {
    const base = tok.replace(/^.*\//, '').toLowerCase();
    for (const known of KNOWN_WORKER_COMMS) {
      if (base === known || base.startsWith(known) || known.startsWith(base)) {
        return known;
      }
    }
  }
  // Fallback: first path basename, capped.
  const first = tokens[0]?.replace(/^.*\//, '') ?? raw;
  const cleaned = first.replace(/[^a-zA-Z0-9._+-]/g, '').slice(0, 24);
  return cleaned.length > 0 ? cleaned : null;
}

/** Quiet long enough for operator digest (not the 30s phone QUIET pill). */
export const QUIET_LONG_DIGEST_MS = 30 * 60_000;
