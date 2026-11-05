/**
 * Domain — Cursor Cloud factory BEHIND (pure).
 *
 * Parallel factory slices share a default branch. After one PR merges, siblings
 * become BEHIND while still MERGEABLE. Left alone they later CONFLICTING and
 * burn the ring-6 cap.
 *
 * Ring 9 relaunched a Cloud Agent to rebase. That spends a factory slot on a
 * GitHub-only git op — the same class as draft→ready (ring 10) and CLEAN
 * squash-merge (ring 12). Identity-bound `gh pr rebase` is the conveyor bit;
 * Cloud Agent requeue stays the fallback when rebase cannot land.
 */

/** Max automatic pr-behind system steers before leaving it to the human. */
export const PR_BEHIND_REQUEUE_CAP = 2;

const PR_BEHIND_STEER_RE = /##\s+System steer \(pr-behind\)/gi;
const PR_BEHIND_CAP_RE = /##\s+Thrash brake \(pr-behind\)/i;

/** GitHub mergeStateStatus BEHIND — head lags the base branch. */
export function isFactoryBehind(mergeStateStatus: string): boolean {
  return mergeStateStatus.trim().toUpperCase() === 'BEHIND';
}

/**
 * GitHub-side rebase when the PR is behind and checks are not red.
 * Pending CI is stale against the old base — rebase it instead of waiting.
 * CONFLICTING / red CI stay on earlier observe paths.
 */
export function shouldRebaseFactoryBehind(input: {
  readonly mergeStateStatus: string;
  readonly ciStatus: string;
}): boolean {
  if (!isFactoryBehind(input.mergeStateStatus)) return false;
  return input.ciStatus.trim().toLowerCase() !== 'failure';
}

/**
 * Requeue only a finished, non-red, behind factory PR.
 * CONFLICTING is a different path. Red CI is ring 8. Pending checks stay
 * on the Cloud Agent path (rebase may still run first).
 */
export function shouldRequeueFactoryBehind(input: {
  readonly mergeStateStatus: string;
  readonly ciStatus: string;
}): boolean {
  if (!isFactoryBehind(input.mergeStateStatus)) return false;
  const ci = input.ciStatus.trim().toLowerCase();
  if (ci === 'failure' || ci === 'pending') return false;
  return true;
}

export function buildFactoryRebasedAuditSection(input: {
  readonly stamp: string;
  readonly prUrl: string;
}): string {
  return [
    `## Factory PR rebased via GitHub (${input.stamp})`,
    '',
    `Rebased the open factory PR onto the default branch on GitHub (${input.prUrl}).`,
    'Not a Cloud Agent relaunch. Not an Approve. Not MergeService.',
    '',
  ].join('\n');
}

/** How many pr-behind system steers already appear in the body. */
export function countPrBehindSteers(body: string): number {
  const re = new RegExp(PR_BEHIND_STEER_RE.source, 'gi');
  let n = 0;
  while (re.exec(body) !== null) n += 1;
  return n;
}

export function shouldCapPrBehindRequeue(body: string): boolean {
  if (PR_BEHIND_CAP_RE.test(body)) return true;
  return countPrBehindSteers(body) >= PR_BEHIND_REQUEUE_CAP;
}

export function buildFactoryBehindSteer(input: {
  readonly prUrl: string;
  readonly headRef: string;
  readonly defaultBranch: string;
  readonly taskId: string;
}): string {
  return (
    `Open factory PR is BEHIND \`${input.defaultBranch}\` on GitHub (${input.prUrl}). ` +
    `Single source of truth: work **only** on the existing Cloud Agent branch \`${input.headRef}\` ` +
    `(the open PR tip). Do **not** create \`hercules/${input.taskId}\` and do **not** ` +
    `dual-write \`${input.defaultBranch}\` while the PR is open. ` +
    `In the Cloud Agent workspace: fetch origin, rebase or merge \`${input.defaultBranch}\` ` +
    `into \`${input.headRef}\`, resolve every conflict, commit, and push that same branch ` +
    `so the existing PR updates. Do not open a second PR. ` +
    `Do not claim success until GitHub mergeStateStatus is no longer BEHIND.`
  );
}

export function buildFactoryBehindThrashSection(input: {
  readonly stamp: string;
  readonly prUrl: string;
  readonly headRef: string;
  readonly taskId: string;
}): string {
  return [
    `## Thrash brake (pr-behind) (${input.stamp})`,
    '',
    `Stopped auto re-queue after **${PR_BEHIND_REQUEUE_CAP}** BEHIND system steers.`,
    `PR: ${input.prUrl}`,
    '',
    '### Single source of truth',
    `- Work **only** on the existing Cloud Agent branch \`${input.headRef}\` (open PR tip).`,
    `- Do **not** create \`hercules/${input.taskId}\` and do **not** dual-write main.`,
    '- Fetch, rebase/merge the default branch into that same branch, resolve, push it.',
    '',
    '### Next actions',
    '1. **Steer** with an explicit rebase instruction, or update the Cloud Agent branch',
    '2. Wait until the PR is no longer BEHIND — do not open a second PR',
    '3. Close/reopen PR only if the branch tip is already correct',
    '',
  ].join('\n');
}
