/** Pure task-branch ownership and compare-and-swap rules. */

export interface TaskBranchLease {
  /** Trusted default-branch tip used when this run acquired ownership. */
  readonly expectedBaseRevision: string;
  /** Exact remote task-branch tip, or null only for an absent-branch creation lease. */
  readonly expectedRemoteTip: string | null;
}

export type TaskBranchCasRejectReason =
  | 'invalid_local_tip'
  | 'invalid_expected_tip'
  | 'invalid_remote_tip'
  | 'remote_missing'
  | 'remote_unexpected'
  | 'remote_changed'
  | 'remote_rewind';

export type TaskBranchCasVerdict =
  | { readonly ok: true; readonly mode: 'create' | 'update' | 'noop' }
  | {
      readonly ok: false;
      readonly reason: TaskBranchCasRejectReason;
      readonly expectedRemoteTip: string | null;
      readonly actualRemoteTip: string | null;
      readonly localTip: string;
    };

export function isFullCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value.trim());
}

function normalizeSha(value: string | null): string | null {
  return value === null ? null : value.trim().toLowerCase();
}

export function decideTaskBranchCas(input: {
  readonly expectedRemoteTip: string | null;
  readonly actualRemoteTip: string | null;
  readonly localTip: string;
  readonly localIsStrictAncestorOfRemote: boolean;
  readonly allowOwnedReset: boolean;
}): TaskBranchCasVerdict {
  const local = normalizeSha(input.localTip);
  const expected = normalizeSha(input.expectedRemoteTip);
  const actual = normalizeSha(input.actualRemoteTip);

  if (local === null || !isFullCommitSha(local)) {
    return {
      ok: false,
      reason: 'invalid_local_tip',
      expectedRemoteTip: expected,
      actualRemoteTip: actual,
      localTip: input.localTip,
    };
  }
  if (expected !== null && !isFullCommitSha(expected)) {
    return {
      ok: false,
      reason: 'invalid_expected_tip',
      expectedRemoteTip: expected,
      actualRemoteTip: actual,
      localTip: local,
    };
  }
  if (actual !== null && !isFullCommitSha(actual)) {
    return {
      ok: false,
      reason: 'invalid_remote_tip',
      expectedRemoteTip: expected,
      actualRemoteTip: actual,
      localTip: local,
    };
  }
  if (expected === null && actual !== null) {
    return {
      ok: false,
      reason: 'remote_unexpected',
      expectedRemoteTip: null,
      actualRemoteTip: actual,
      localTip: local,
    };
  }
  if (expected !== null && actual === null) {
    return {
      ok: false,
      reason: 'remote_missing',
      expectedRemoteTip: expected,
      actualRemoteTip: null,
      localTip: local,
    };
  }
  if (expected !== actual) {
    return {
      ok: false,
      reason: 'remote_changed',
      expectedRemoteTip: expected,
      actualRemoteTip: actual,
      localTip: local,
    };
  }
  if (actual === local) return { ok: true, mode: 'noop' };
  if (input.localIsStrictAncestorOfRemote && !input.allowOwnedReset) {
    return {
      ok: false,
      reason: 'remote_rewind',
      expectedRemoteTip: expected,
      actualRemoteTip: actual,
      localTip: local,
    };
  }
  return { ok: true, mode: expected === null ? 'create' : 'update' };
}

export function taskBranchLeaseArg(branch: string, expectedRemoteTip: string | null): string {
  const ref = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
  return `--force-with-lease=${ref}:${expectedRemoteTip ?? ''}`;
}

export function shortLeaseSha(value: string | null | undefined): string {
  return value === null || value === undefined ? '(absent)' : value.slice(0, 12);
}
