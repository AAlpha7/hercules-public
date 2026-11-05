/**
 * Symlink escapes in a unified diff (L5 anti-cheat, C3.42).
 *
 * Incident 2026-09-09 (a downstream project console-affordance-v3): told to "copy the
 * content of <draft path> into <file>", the executor created ABSOLUTE
 * SYMLINKS to the draft files. The diff replaces each file body with the
 * link target under mode 120000, so test-integrity reported every test in
 * those files as removed and the attempt burned three times with a
 * misleading verdict. A symlink whose target resolves outside the worktree
 * is now its own critical finding; internal links stay allowed (repos
 * legitimately carry them).
 *
 * Pure string parsing — no filesystem, no git.
 */
import { posix } from 'node:path';
import type { CheatFinding } from '../domain/verification.js';

export interface SymlinkDiffEntry {
  /** Path on the b/ side of the diff. */
  readonly file: string;
  /** Link target bytes (the single `+` content line of the 120000 hunk). */
  readonly target: string;
  /** True when the target resolves outside the worktree root. */
  readonly escapes: boolean;
}

const DIFF_HEADER_RE = /^diff --git a\/(.+?) b\/(.+)$/;
/**
 * A file that BECOMES a symlink carries `new file mode 120000` / `new mode
 * 120000`; re-pointing an EXISTING symlink carries no mode line at all — only
 * `index <a>..<b> 120000` (Claude round 21 B1).
 */
const SYMLINK_MODE_RE = /^(?:new file mode 120000|new mode 120000|index [0-9a-f]+\.\.[0-9a-f]+ 120000)$/;

/** git appends a tab after paths containing spaces; testIntegrity trims it too. */
function cleanPath(path: string): string {
  return path.replace(/\t$/, '');
}

/** POSIX resolution against the link's directory; never touches the filesystem. */
export function symlinkTargetEscapes(file: string, target: string): boolean {
  if (target.length === 0) return false;
  if (target.startsWith('/')) return true;
  const resolved = posix.normalize(posix.join(posix.dirname(file), target));
  return resolved === '..' || resolved.startsWith('../');
}

export function findSymlinkEntries(diff: string): readonly SymlinkDiffEntry[] {
  const entries: SymlinkDiffEntry[] = [];
  let file: string | null = null;
  let symlink = false;
  let inHunk = false;
  let target: string | null = null;
  const flush = (): void => {
    if (file !== null && symlink && target !== null) {
      entries.push({ file, target, escapes: symlinkTargetEscapes(file, target) });
    }
    file = null;
    symlink = false;
    inHunk = false;
    target = null;
  };
  for (const raw of diff.split('\n')) {
    const header = DIFF_HEADER_RE.exec(raw);
    if (header !== null) {
      flush();
      file = cleanPath(header[2]!);
      continue;
    }
    if (file === null) continue;
    if (!inHunk) {
      if (SYMLINK_MODE_RE.test(raw)) symlink = true;
      else if (raw.startsWith('+++ b/')) file = cleanPath(raw.slice('+++ b/'.length));
      else if (raw.startsWith('@@')) inHunk = true;
      continue;
    }
    if (symlink && target === null && raw.startsWith('+') && !raw.startsWith('+++')) {
      target = raw.slice(1);
    }
  }
  flush();
  return entries;
}

/** One critical finding per symlink whose target leaves the worktree. */
export function findSymlinkEscapes(diff: string): CheatFinding[] {
  return findSymlinkEntries(diff)
    .filter((entry) => entry.escapes)
    .map((entry) => ({
      kind: 'symlink-escape' as const,
      file: entry.file,
      detail:
        '`' + entry.file + '` became a symlink to `' + entry.target +
        '` (outside the worktree): copy file contents, never link',
    }));
}
