/**
 * Domain — Cursor Cloud factory CI-failure rework (pure).
 *
 * Factory skips local L1/L2, so GitHub checks are the mechanical gate before
 * a human can merge. A red rollup must requeue onto the existing Cloud Agent
 * head — the same observe → todo → launch path as CONFLICTING (ring 6).
 */

/** Max automatic pr-ci system steers before leaving it to the human. */
export const PR_CI_REQUEUE_CAP = 2;

const PR_CI_STEER_RE = /##\s+System steer \(pr-ci\)/gi;
const PR_CI_CAP_RE = /##\s+Thrash brake \(pr-ci\)/i;

/** Only a finished red rollup is actionable. Pending/green/empty stay in review. */
export function isFactoryCiFailure(status: string): boolean {
  return status.trim().toLowerCase() === 'failure';
}

/** How many pr-ci system steers already appear in the body. */
export function countPrCiSteers(body: string): number {
  const re = new RegExp(PR_CI_STEER_RE.source, 'gi');
  let n = 0;
  while (re.exec(body) !== null) n += 1;
  return n;
}

export function shouldCapPrCiRequeue(body: string): boolean {
  if (PR_CI_CAP_RE.test(body)) return true;
  return countPrCiSteers(body) >= PR_CI_REQUEUE_CAP;
}

export function buildFactoryCiSteer(input: {
  readonly prUrl: string;
  readonly headRef: string;
  readonly defaultBranch: string;
  readonly taskId: string;
  readonly ciSummary: string;
  readonly failingChecks?: readonly string[];
}): string {
  const names = (input.failingChecks ?? [])
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .slice(0, 5);
  const failLine = names.length > 0 ? ` Failing checks: ${names.join(', ')}.` : '';
  const summary = input.ciSummary.trim() || 'checks failed';
  return (
    `GitHub CI is failing on the open factory PR (${input.prUrl}): ${summary}.${failLine} ` +
    `Single source of truth: work **only** on the existing Cloud Agent branch \`${input.headRef}\` ` +
    `(the open PR tip). Do **not** create \`hercules/${input.taskId}\` and do **not** ` +
    `dual-write \`${input.defaultBranch}\` while the PR is open. ` +
    `Read the failing check logs, fix the failures on that same branch, commit, and push ` +
    `so the existing PR updates. Do not open a second PR. ` +
    `Do not claim success until the failing checks are green.`
  );
}

export function buildFactoryCiThrashSection(input: {
  readonly stamp: string;
  readonly prUrl: string;
  readonly headRef: string;
  readonly taskId: string;
  readonly ciSummary: string;
}): string {
  return [
    `## Thrash brake (pr-ci) (${input.stamp})`,
    '',
    `Stopped auto re-queue after **${PR_CI_REQUEUE_CAP}** CI-failure system steers.`,
    `PR: ${input.prUrl}`,
    `Checks: ${input.ciSummary.trim() || 'checks failed'}`,
    '',
    '### Single source of truth',
    `- Work **only** on the existing Cloud Agent branch \`${input.headRef}\` (open PR tip).`,
    `- Do **not** create \`hercules/${input.taskId}\` and do **not** dual-write main.`,
    '- Read the failing check logs, fix on that same branch, push it.',
    '',
    '### Next actions',
    '1. **Steer** with the failing-check log, or fix CI on the Cloud Agent branch',
    '2. Wait until the checks are green — do not open a second PR',
    '3. Close/reopen PR only if the branch tip is already correct',
    '',
  ].join('\n');
}
