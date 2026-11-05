/**
 * Best-effort session worktree diff for the phone Diff drawer.
 */
import { simpleGit } from 'simple-git';

export interface SessionDiffResult {
  readonly available: boolean;
  readonly summary: string;
  readonly files: readonly string[];
  /** Truncated unified diff. */
  readonly diff: string;
  readonly reason?: string;
}

const MAX_DIFF_CHARS = 40_000;

export async function captureSessionDiff(
  cwd: string,
  baseRef = 'HEAD',
): Promise<SessionDiffResult> {
  try {
    const git = simpleGit(cwd);
    // Include unstaged + untracked via status names; prefer diff against base.
    let filesRaw = '';
    let diff = '';
    let summary = '';
    try {
      filesRaw = await git.raw(['diff', '--name-only', baseRef]);
      diff = await git.raw(['diff', baseRef]);
      summary = (await git.raw(['diff', '--shortstat', baseRef])).trim();
    } catch {
      // Dirty tree vs index only
      filesRaw = await git.raw(['diff', '--name-only']);
      diff = await git.raw(['diff']);
      summary = (await git.raw(['diff', '--shortstat'])).trim() || 'working tree changes';
    }
    // Untracked
    const untracked = await git.raw(['ls-files', '--others', '--exclude-standard']);
    const files = [
      ...filesRaw.split('\n').map((s) => s.trim()).filter(Boolean),
      ...untracked.split('\n').map((s) => s.trim()).filter(Boolean),
    ];
    const unique = [...new Set(files)];
    if (unique.length === 0 && !diff.trim()) {
      return { available: true, summary: 'no changes', files: [], diff: '' };
    }
    if (diff.length > MAX_DIFF_CHARS) {
      diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n… (truncated)`;
    }
    return {
      available: true,
      summary: summary || `${unique.length} file(s)`,
      files: unique,
      diff,
    };
  } catch (err) {
    return {
      available: false,
      summary: '',
      files: [],
      diff: '',
      reason: (err as Error).message.slice(0, 160),
    };
  }
}
