/**
 * Domain — packet file-list + inline-diff noise heuristics.
 *
 * Review packets list every path on the task branch. Lockfiles, build output,
 * agent-map bulk, and other generated paths often dominate even when the real
 * PR is 1–2 source files. Pure helpers: split / classify for rendering only.
 * Anti-cheat and L1 still see the full set.
 */

/** Path looks like lockfile / package manager noise. */
const LOCKFILE =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/i;

/** Build / coverage / cache directories and common generated suffixes. */
const GENERATED =
  /(^|\/)(dist|build|out|coverage|target|\.next|\.turbo|\.cache|node_modules|vendor|\.pytest_cache|__pycache__|\.mypy_cache|\.ruff_cache|\.parcel-cache)(\/|$)/i;

const GENERATED_SUFFIX =
  /\.(map|min\.js|min\.css|tsbuildinfo|rlib|rmeta|pyc|pyo|o|a|so|dylib|dll|exe|wasm)$/i;

/** OS / editor junk. */
const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|\.eslintcache|\.stylelintcache)$/i;

/**
 * Agent-map / harness policy files. Keep in the **files list** (primary for
 * onboarding), but fold their **inline unified-diff hunks** so huge WORKFLOW
 * rewrites do not bury human AC + L1–L3 axes.
 */
const MAP_FILE =
  /(^|\/)(WORKFLOW\.md|AGENTS\.md|CLAUDE\.md|CODEX\.md|\.grok[/\\].*|\.claude[/\\].*)$/i;

export function isNoisePath(path: string): boolean {
  const p = path.trim();
  if (p.length === 0) return false;
  return LOCKFILE.test(p) || GENERATED.test(p) || GENERATED_SUFFIX.test(p) || JUNK.test(p);
}

/** True for policy/agent-map paths (fold in inline diff, keep in file list). */
export function isMapPath(path: string): boolean {
  const p = path.trim();
  if (p.length === 0) return false;
  return MAP_FILE.test(p);
}

export interface PartitionedFiles {
  readonly primary: readonly string[];
  readonly noise: readonly string[];
}

/** Stable partition: primary first (input order), noise after. */
export function partitionFilesForPacket(files: readonly string[]): PartitionedFiles {
  const primary: string[] = [];
  const noise: string[] = [];
  for (const f of files) {
    if (isNoisePath(f)) noise.push(f);
    else primary.push(f);
  }
  return { primary, noise };
}

export interface FoldedDiffFile {
  readonly path: string;
  readonly reason: 'noise' | 'map';
  readonly lineCount: number;
}

export interface FoldedDiff {
  /** Unified diff with noise/map file hunks removed. */
  readonly primary: string;
  readonly folded: readonly FoldedDiffFile[];
}

/**
 * Split a unified diff into primary hunks vs folded map/noise file sections.
 * File headers recognized: `diff --git a/X b/Y` and standalone `+++ b/X`.
 */
export function foldNoiseAndMapDiff(diff: string): FoldedDiff {
  const text = diff.trimEnd();
  if (text.length === 0) return { primary: '', folded: [] };

  const lines = text.split('\n');
  const primaryLines: string[] = [];
  const folded: FoldedDiffFile[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const gitHeader = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (gitHeader) {
      const path = (gitHeader[2] ?? gitHeader[1] ?? '').trim();
      const start = i;
      i += 1;
      while (i < lines.length && !/^diff --git /.test(lines[i]!)) i += 1;
      const chunk = lines.slice(start, i);
      const reason = foldReason(path);
      if (reason) {
        folded.push({ path, reason, lineCount: chunk.length });
      } else {
        primaryLines.push(...chunk);
      }
      continue;
    }
    primaryLines.push(line);
    i += 1;
  }

  return {
    primary: primaryLines.join('\n').trimEnd(),
    folded,
  };
}

function foldReason(path: string): 'noise' | 'map' | null {
  if (isNoisePath(path)) return 'noise';
  if (isMapPath(path)) return 'map';
  return null;
}
