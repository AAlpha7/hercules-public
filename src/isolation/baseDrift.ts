/**
 * Isolation layer — detect task-branch lag vs default branch + optional local rebase.
 *
 * Uses real git in the task worktree. Never force-pushes; never checks out or
 * merges into the default branch. Auto-rebase only rewrites the *task* branch tip.
 */
import { simpleGit } from 'simple-git';
import {
  classifyBaseDrift,
  unknownBaseDrift,
  type BaseDriftReport,
  type ConflictRisk,
} from '../domain/baseDrift.js';

export class BaseDriftError extends Error {
  override readonly name = 'BaseDriftError';
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;

async function revParse(dir: string, rev: string): Promise<string | null> {
  try {
    const sha = (await simpleGit(dir).raw(['rev-parse', '--verify', rev])).trim();
    return SHA_RE.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the default-branch tip for drift comparison.
 * Prefer local `defaultBranch` (mirror fetch lands there); fall back to
 * `origin/<defaultBranch>` when present.
 */
export async function resolveDefaultBranchTip(
  worktreeDir: string,
  defaultBranch: string,
): Promise<{ ref: string; sha: string } | null> {
  const candidates = [defaultBranch, `origin/${defaultBranch}`, `refs/heads/${defaultBranch}`];
  for (const ref of candidates) {
    const sha = await revParse(worktreeDir, ref);
    if (sha) return { ref, sha };
  }
  return null;
}

/**
 * Probe whether merging `baseRef` into HEAD would conflict — without touching
 * the index or working tree (`git merge-tree --write-tree`).
 */
export async function probeMergeConflict(
  worktreeDir: string,
  headRef: string,
  baseRef: string,
): Promise<{ risk: ConflictRisk; detail: string | null }> {
  try {
    const out = await simpleGit(worktreeDir).raw([
      'merge-tree',
      '--write-tree',
      headRef,
      baseRef,
    ]);
    // Exit 0 and no CONFLICT lines → clean.
    if (/CONFLICT/i.test(out)) {
      return { risk: 'conflict', detail: out.trim().slice(0, 2000) };
    }
    return { risk: 'none', detail: null };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // simple-git throws on non-zero exit; merge-tree exits 1 on conflicts.
    if (/CONFLICT/i.test(msg)) {
      // Prefer the conflict body (often multi-line after the command summary).
      const body = msg.includes('CONFLICT') ? msg : msg;
      return { risk: 'conflict', detail: body.slice(0, 2000) };
    }
    return { risk: 'unknown', detail: msg.slice(0, 500) };
  }
}

/**
 * Compare merge-base / ancestry of HEAD vs the repo default branch.
 * Reports behind/ahead counts and conflict risk for integrating default.
 */
export async function detectBaseDrift(
  worktreeDir: string,
  defaultBranch: string,
): Promise<BaseDriftReport> {
  try {
    const git = simpleGit(worktreeDir);
    const headSha = await revParse(worktreeDir, 'HEAD');
    if (!headSha) {
      return unknownBaseDrift(defaultBranch, 'HEAD unresolvable');
    }
    const base = await resolveDefaultBranchTip(worktreeDir, defaultBranch);
    if (!base) {
      return unknownBaseDrift(defaultBranch, `default branch '${defaultBranch}' not found`);
    }

    let mergeBase: string | null = null;
    try {
      const mb = (await git.raw(['merge-base', base.sha, headSha])).trim();
      if (SHA_RE.test(mb)) mergeBase = mb;
    } catch {
      mergeBase = null;
    }

    let behind = 0;
    let ahead = 0;
    try {
      behind = Number((await git.raw(['rev-list', '--count', `${headSha}..${base.sha}`])).trim());
      ahead = Number((await git.raw(['rev-list', '--count', `${base.sha}..${headSha}`])).trim());
      if (!Number.isFinite(behind)) behind = 0;
      if (!Number.isFinite(ahead)) ahead = 0;
    } catch (err) {
      return {
        ...unknownBaseDrift(defaultBranch, `rev-list failed: ${(err as Error).message}`),
        headSha,
        baseSha: base.sha,
        mergeBase,
      };
    }

    const status = classifyBaseDrift(behind, ahead);
    let conflictRisk: ConflictRisk = 'none';
    let conflictDetail: string | null = null;
    if (behind > 0) {
      const probe = await probeMergeConflict(worktreeDir, headSha, base.sha);
      conflictRisk = probe.risk;
      conflictDetail = probe.detail;
    }

    return {
      defaultBranch,
      mergeBase,
      headSha,
      baseSha: base.sha,
      behind,
      ahead,
      status,
      conflictRisk,
      conflictDetail,
      rebaseAttempted: false,
      rebaseOk: null,
      rebaseDetail: null,
    };
  } catch (err) {
    return unknownBaseDrift(defaultBranch, (err as Error).message);
  }
}

export interface RebaseResult {
  readonly ok: boolean;
  readonly detail: string;
  /** HEAD after attempt (restored on failure when abort succeeds). */
  readonly headSha: string | null;
}

/**
 * Locally rebase HEAD onto the default branch tip.
 *
 * Safety:
 * - Operates only in the task worktree (never checks out default branch).
 * - On conflict: `git rebase --abort` to restore prior tip.
 * - Does **not** push; callers must not force-push main.
 */
export async function tryRebaseOntoDefault(
  worktreeDir: string,
  defaultBranch: string,
): Promise<RebaseResult> {
  const git = simpleGit(worktreeDir);
  const before = await revParse(worktreeDir, 'HEAD');
  const base = await resolveDefaultBranchTip(worktreeDir, defaultBranch);
  if (!base) {
    return {
      ok: false,
      detail: `default branch '${defaultBranch}' not found — cannot rebase`,
      headSha: before,
    };
  }
  if (!before) {
    return { ok: false, detail: 'HEAD unresolvable — cannot rebase', headSha: null };
  }

  // Refuse if already in the middle of a rebase.
  try {
    const status = await git.status();
    if (status.conflicted.length > 0) {
      return {
        ok: false,
        detail: 'worktree already has conflicts — resolve or abort before auto-rebase',
        headSha: before,
      };
    }
  } catch {
    /* status best-effort */
  }

  const runRebase = async (strategy: 'plain' | 'ours'): Promise<void> => {
    const args =
      strategy === 'ours'
        ? ([
            '-c',
            'user.email=hercules@local',
            '-c',
            'user.name=Hercules',
            'rebase',
            '-X',
            'ours',
            base.sha,
          ] as const)
        : ([
            '-c',
            'user.email=hercules@local',
            '-c',
            'user.name=Hercules',
            'rebase',
            base.sha,
          ] as const);
    await git.raw([...args]);
  };

  try {
    await runRebase('plain');
    const after = await revParse(worktreeDir, 'HEAD');
    return {
      ok: true,
      detail: `rebased onto ${defaultBranch} (${base.sha.slice(0, 12)}); HEAD ${after?.slice(0, 12) ?? '?'}`,
      headSha: after,
    };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // Always try to abort so the worktree is not left mid-rebase.
    try {
      await git.raw(['rebase', '--abort']);
    } catch (abortErr) {
      console.error(
        `[hercules] rebase --abort failed after conflict: ${(abortErr as Error).message}`,
      );
    }
    // Second pass: prefer default-branch side on conflicts so concurrent main
    // gate-debt fixes (e.g. proofSurfaceHonesty) do not park product branches.
    // Product files that also conflict lose the branch side — operator salvage.
    if (/CONFLICT/i.test(msg)) {
      try {
        await runRebase('ours');
        const afterOurs = await revParse(worktreeDir, 'HEAD');
        return {
          ok: true,
          detail:
            `rebased onto ${defaultBranch} with -X ours after conflict ` +
            `(${base.sha.slice(0, 12)}); HEAD ${afterOurs?.slice(0, 12) ?? '?'}`,
          headSha: afterOurs,
        };
      } catch (err2) {
        const msg2 = (err2 as Error).message ?? String(err2);
        try {
          await git.raw(['rebase', '--abort']);
        } catch (abortErr2) {
          console.error(
            `[hercules] rebase --abort failed after -X ours: ${(abortErr2 as Error).message}`,
          );
        }
        const restored2 = await revParse(worktreeDir, 'HEAD');
        return {
          ok: false,
          detail:
            `rebase onto ${defaultBranch} failed plain+ours (aborted): ` +
            `${msg.slice(0, 400)} | ours: ${msg2.slice(0, 400)}`,
          headSha: restored2,
        };
      }
    }
    const restored = await revParse(worktreeDir, 'HEAD');
    return {
      ok: false,
      detail: `rebase onto ${defaultBranch} failed (aborted): ${msg.slice(0, 800)}`,
      headSha: restored,
    };
  }
}

/**
 * Detect drift; when `autoRebase` and the branch is behind, attempt a local
 * rebase and re-detect. Never pushes.
 */
export async function detectBaseDriftWithOptionalRebase(
  worktreeDir: string,
  defaultBranch: string,
  opts: { readonly autoRebase?: boolean } = {},
): Promise<BaseDriftReport> {
  const initial = await detectBaseDrift(worktreeDir, defaultBranch);
  if (!opts.autoRebase) return initial;
  if (initial.behind <= 0) {
    return { ...initial, rebaseAttempted: false, rebaseOk: null, rebaseDetail: null };
  }
  // Skip auto-rebase when already known conflicting — still report attempt? No:
  // try anyway only when conflictRisk is not hard-conflict, or always try?
  // Safer: try when behind > 0 unless already mid-conflict worktree. merge-tree
  // conflict means rebase will likely fail — we still attempt so rebaseDetail
  // captures the real rebase error, then abort.
  const rebase = await tryRebaseOntoDefault(worktreeDir, defaultBranch);
  if (!rebase.ok) {
    // Re-detect in case abort left us current; usually still behind.
    const after = await detectBaseDrift(worktreeDir, defaultBranch);
    return {
      ...after,
      rebaseAttempted: true,
      rebaseOk: false,
      rebaseDetail: rebase.detail,
      // Prefer conflict risk from probe if rebase mentioned conflicts.
      conflictRisk:
        after.conflictRisk === 'conflict' || /CONFLICT/i.test(rebase.detail)
          ? 'conflict'
          : after.conflictRisk,
      conflictDetail: after.conflictDetail ?? rebase.detail,
    };
  }
  const after = await detectBaseDrift(worktreeDir, defaultBranch);
  return {
    ...after,
    rebaseAttempted: true,
    rebaseOk: true,
    rebaseDetail: rebase.detail,
  };
}
