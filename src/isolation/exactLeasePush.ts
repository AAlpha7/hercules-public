import type { SimpleGit } from 'simple-git';
import {
  decideTaskBranchCas,
  isFullCommitSha,
  shortLeaseSha,
  taskBranchLeaseArg,
  type TaskBranchLease,
  type TaskBranchCasRejectReason,
} from '../domain/taskBranchLease.js';

export class TaskBranchLeaseError extends Error {
  override readonly name = 'TaskBranchLeaseError';

  constructor(
    readonly code: TaskBranchCasRejectReason | 'remote_unavailable' | 'remote_fetch_failed',
    readonly expectedRemoteTip: string | null,
    readonly actualRemoteTip: string | null,
  ) {
    super(
      `task branch exact lease ${code} ` +
        `(expected ${shortLeaseSha(expectedRemoteTip)}, actual ${shortLeaseSha(actualRemoteTip)})`,
    );
  }
}

/** Read exactly one task ref. Transport failure is not equivalent to absence. */
export async function readRemoteTaskBranchTip(
  git: SimpleGit,
  originUrl: string,
  branch: string,
): Promise<string | null> {
  let output: string;
  try {
    output = await git.raw(['ls-remote', '--heads', originUrl, `refs/heads/${branch}`]);
  } catch {
    throw new TaskBranchLeaseError('remote_unavailable', null, null);
  }
  const line = output.trim();
  if (line.length === 0) return null;
  const rows = line.split('\n').filter((row) => row.trim().length > 0);
  const tip = (rows[0]?.trim().split(/\s+/)[0] ?? '').toLowerCase();
  if (rows.length !== 1 || !isFullCommitSha(tip)) {
    throw new TaskBranchLeaseError('invalid_remote_tip', null, tip || null);
  }
  return tip;
}

/**
 * The only production task-branch publication primitive.
 *
 * The preflight gives a typed diagnostic; the ref-qualified force-with-lease is
 * the atomic compare-and-swap that closes a change between preflight and push.
 */
export async function pushTaskBranchWithExactLease(input: {
  readonly git: SimpleGit;
  readonly originUrl: string;
  readonly branch: string;
  readonly localTip: string;
  readonly lease: TaskBranchLease;
  readonly allowOwnedReset: boolean;
  /** Deterministic race hook for real-git regression tests. */
  readonly beforePush?: () => Promise<void>;
}): Promise<TaskBranchLease> {
  const localTip = input.localTip.trim().toLowerCase();
  const actualRemoteTip = await readRemoteTaskBranchTip(
    input.git,
    input.originUrl,
    input.branch,
  );

  let localIsStrictAncestorOfRemote = false;
  if (actualRemoteTip !== null && actualRemoteTip !== localTip) {
    try {
      await input.git.raw(['fetch', '--no-tags', input.originUrl, actualRemoteTip]);
      const behind = Number(
        (await input.git.raw(['rev-list', '--count', `${localTip}..${actualRemoteTip}`])).trim(),
      );
      const ahead = Number(
        (await input.git.raw(['rev-list', '--count', `${actualRemoteTip}..${localTip}`])).trim(),
      );
      if (!Number.isFinite(behind) || !Number.isFinite(ahead)) throw new Error('bad count');
      localIsStrictAncestorOfRemote = behind > 0 && ahead === 0;
    } catch {
      throw new TaskBranchLeaseError(
        'remote_fetch_failed',
        input.lease.expectedRemoteTip,
        actualRemoteTip,
      );
    }
  }

  const verdict = decideTaskBranchCas({
    expectedRemoteTip: input.lease.expectedRemoteTip,
    actualRemoteTip,
    localTip,
    localIsStrictAncestorOfRemote,
    allowOwnedReset: input.allowOwnedReset,
  });
  if (!verdict.ok) {
    throw new TaskBranchLeaseError(
      verdict.reason,
      verdict.expectedRemoteTip,
      verdict.actualRemoteTip,
    );
  }
  if (verdict.mode === 'noop') {
    return { ...input.lease, expectedRemoteTip: localTip };
  }

  await input.beforePush?.();
  try {
    await input.git.raw([
      'push',
      input.originUrl,
      `${localTip}:refs/heads/${input.branch}`,
      taskBranchLeaseArg(input.branch, input.lease.expectedRemoteTip),
    ]);
  } catch {
    const after = await readRemoteTaskBranchTip(input.git, input.originUrl, input.branch);
    throw new TaskBranchLeaseError(
      'remote_changed',
      input.lease.expectedRemoteTip,
      after,
    );
  }

  const published = await readRemoteTaskBranchTip(input.git, input.originUrl, input.branch);
  if (published !== localTip) {
    throw new TaskBranchLeaseError(
      'remote_changed',
      input.lease.expectedRemoteTip,
      published,
    );
  }
  return { ...input.lease, expectedRemoteTip: localTip };
}
