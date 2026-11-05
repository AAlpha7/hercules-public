/**
 * Isolation layer — capture the change a task made in its worktree (SPEC §9.6).
 *
 * Stages everything the agent touched and diffs it against the **merge-base**
 * with the repo default branch (not the tip of main alone). That way a branch
 * that merely lags main does not look like it "deleted" protected files that
 * only exist on newer main — L5 anti-cheat and the review packet see the
 * task's own delta (logout case study: protected-path false positive).
 */
import { access } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import {
  parseForeignTaskCommits,
  type CrossTaskCommit,
} from '../domain/decisionCard.js';

export type { CrossTaskCommit };

export interface WorktreeDiff {
  /** Unified diff of the change vs the comparison base. */
  readonly diff: string;
  readonly filesTouched: string[];
  /** Human summary (git --shortstat), or 'no changes'. */
  readonly diffSummary: string;
  /**
   * Ref actually used for the left side of the diff (merge-base SHA or baseRef).
   * Surfaced for logs/tests.
   */
  readonly compareBase: string;
  /**
   * Task ids other than this branch's own that appear in commit subjects on
   * the branch ("hercules: <id> …"). Cross-task cherry-picks blur audit
   * lineage — R3 silently carried failed R2's commits (2026-07-22). Surfaced
   * as an L5 review-severity finding, never discovered by git archaeology.
   */
  readonly foreignTaskIds?: readonly string[];
  /**
   * Same detection loop as foreignTaskIds, with sha + subject for the CEO
   * boundary badge (no extra git call).
   */
  readonly foreignCommits?: readonly CrossTaskCommit[];
}

export class WorktreeDiffError extends Error {
  override readonly name = 'WorktreeDiffError';
}

/**
 * Resolve the left-hand ref for packet/L5 diffs.
 * Prefer merge-base(baseRef, HEAD); fall back to baseRef.
 */
export async function resolveCompareBase(
  worktreeDir: string,
  baseRef: string,
): Promise<string> {
  const git = simpleGit(worktreeDir);
  try {
    const mb = (await git.raw(['merge-base', baseRef, 'HEAD'])).trim();
    if (/^[0-9a-f]{7,40}$/i.test(mb)) return mb;
  } catch {
    /* no common ancestor */
  }
  return baseRef;
}

export async function captureWorktreeDiff(
  worktreeDir: string,
  baseRef: string,
): Promise<WorktreeDiff> {
  try {
    await access(worktreeDir);
  } catch {
    throw new WorktreeDiffError(
      `worktree directory does not exist: ${worktreeDir} — cannot capture diff (recover branch / re-create worktree)`,
    );
  }

  const git = simpleGit(worktreeDir);
  await git.add(['-A']);
  const compareBase = await resolveCompareBase(worktreeDir, baseRef);

  // core.quotepath=false → Chinese/non-ASCII paths stay readable in the packet
  // (default git quotes them as "\345\245\207..." which is unreadable on phone).
  // -c must precede the subcommand.
  const q = ['-c', 'core.quotepath=false'] as const;
  const diff = await git.raw([...q, 'diff', '--cached', compareBase]);
  const names = await git.raw([...q, 'diff', '--cached', '--name-only', compareBase]);
  const stat = await git.raw([...q, 'diff', '--cached', '--shortstat', compareBase]);
  // git raw leaves a trailing newline; also strip optional surrounding quotes.
  const filesTouched = names
    .split('\n')
    .map((s) => s.trim().replace(/^"(.*)"$/, '$1'))
    .filter((s) => s.length > 0);
  // Cross-task lineage: commits on this branch attributed to another task id.
  // One log call yields sha + subject; pure parser extracts foreign entries.
  let foreignTaskIds: string[] = [];
  let foreignCommits: CrossTaskCommit[] = [];
  try {
    const branch = (await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const ownId = branch.startsWith('hercules/') ? branch.slice('hercules/'.length) : null;
    const log = await git.raw(['log', '--format=%H%x09%s', `${compareBase}..HEAD`]);
    foreignCommits = parseForeignTaskCommits(log.split('\n'), ownId);
    foreignTaskIds = [...new Set(foreignCommits.map((c) => c.taskId))];
  } catch {
    // detached HEAD / no commits — lineage check is best-effort
  }

  return {
    diff,
    filesTouched,
    diffSummary: stat.trim() || 'no changes',
    compareBase,
    ...(foreignTaskIds.length > 0 ? { foreignTaskIds } : {}),
    ...(foreignCommits.length > 0 ? { foreignCommits } : {}),
  };
}
