/**
 * Domain — safe fetch policy for hercules/* task branches on the bare mirror.
 *
 * Case study (2026-07-30, release-verify-timeout): agent pushed a verified tip
 * to the local mirror only; a later force-fetch of heads rewound the branch to
 * GitHub's older tip. Approve then failed with verified-SHA mismatch and the
 * verified commit became unreachable from the branch.
 *
 * Policy for `hercules/*` only (main / release refs stay force-synced):
 * - local ahead of remote → keep local (never silent rewind)
 * - remote ahead of local → fast-forward to remote
 * - diverged → follow remote (status quo) and surface a log line; verified-SHA
 *   mismatch detection remains the Approve backstop
 * - equal → noop
 *
 * Pure: no IO. Isolation applies the decision with real git ancestry counts.
 */

/** Commits on remote not reachable from local. */
export type FetchBehind = number;
/** Commits on local not reachable from remote. */
export type FetchAhead = number;

export type TaskBranchFetchReason =
  | 'equal'
  | 'local_ahead'
  | 'remote_ahead'
  | 'diverged'
  | 'unknown';

export type TaskBranchFetchAction = 'noop' | 'keep' | 'update';

export interface TaskBranchFetchDecision {
  readonly action: TaskBranchFetchAction;
  readonly reason: TaskBranchFetchReason;
  /**
   * Operator-facing one-liner when the decision is non-trivial
   * (skip rewind / take remote on diverge). Empty for silent equal/ff.
   */
  readonly logLine: string;
}

/** Log sample: fetch would have rewound a local tip that origin lacks. */
export const SKIP_REWIND_LOG = '跳过回卷: 本地领先';

/** Log sample: preserve could not publish hercules/<id> to origin. */
export const NOT_PROPAGATED_LOG = '分支未传播到远端';

/**
 * Decide whether a local hercules/* ref should absorb the remote tip.
 *
 * `behind` = rev-list --count local..remote (remote has, local lacks)
 * `ahead`  = rev-list --count remote..local (local has, remote lacks)
 */
export function decideTaskBranchFetch(
  behind: number,
  ahead: number,
): TaskBranchFetchDecision {
  const b = Number.isFinite(behind) ? Math.max(0, Math.floor(behind)) : -1;
  const a = Number.isFinite(ahead) ? Math.max(0, Math.floor(ahead)) : -1;
  if (b < 0 || a < 0) {
    return { action: 'noop', reason: 'unknown', logLine: '' };
  }
  if (b === 0 && a === 0) {
    return { action: 'noop', reason: 'equal', logLine: '' };
  }
  if (b === 0 && a > 0) {
    return {
      action: 'keep',
      reason: 'local_ahead',
      logLine: SKIP_REWIND_LOG,
    };
  }
  if (a === 0 && b > 0) {
    return {
      action: 'update',
      reason: 'remote_ahead',
      logLine: '',
    };
  }
  // Diverged: follow remote (may drop local-only commits). Surface loudly;
  // verified-SHA gate still blocks Approve if the packet tip vanishes.
  return {
    action: 'update',
    reason: 'diverged',
    logLine: `分叉: 跟随远端 (local ahead ${a}, remote ahead ${b})`,
  };
}

/** True when local tip must not be replaced by remote (local strictly ahead). */
export function mustKeepLocalTaskTip(behind: number, ahead: number): boolean {
  return decideTaskBranchFetch(behind, ahead).action === 'keep';
}

/** Format a skip-rewind timeline/packet line for a concrete branch. */
export function formatSkipRewindEvent(branch: string, localTip: string, remoteTip: string): string {
  const b = branch.trim() || 'hercules/?';
  const l = localTip.trim().slice(0, 12) || '?';
  const r = remoteTip.trim().slice(0, 12) || '?';
  return `${SKIP_REWIND_LOG} (\`${b}\` local ${l} vs origin ${r})`;
}

/** Format an unpropagated-branch warning for packet / timeline. */
export function formatNotPropagatedEvent(
  branch: string,
  detail?: string,
): string {
  const b = branch.trim() || 'hercules/?';
  const d = detail?.trim();
  return d && d.length > 0
    ? `${NOT_PROPAGATED_LOG} (\`${b}\`): ${d}`
    : `${NOT_PROPAGATED_LOG} (\`${b}\`)`;
}

/**
 * Append mirror-policy notes to a task body for phone visibility.
 * Prefers extending the latest `## Run timeline` with **mirror** rows;
 * otherwise adds a short `## Mirror branch` section.
 */
export function appendMirrorBranchNotes(
  body: string,
  stamp: string,
  messages: readonly string[],
  opts?: { readonly ok?: boolean },
): string {
  const lines = messages.map((m) => m.trim()).filter((m) => m.length > 0);
  if (lines.length === 0) return body;
  const at = stamp.trim() || new Date().toISOString();
  const ok = opts?.ok;
  const mark = ok === true ? ' ✅' : ok === false ? ' ❌' : '';
  const eventLines = lines.map((summary) => {
    const clean = summary.replace(/\s+/g, ' ').slice(0, 200);
    return `- \`${at}\` **mirror**${mark} — ${clean}`;
  });

  const lower = body.toLowerCase();
  const idx = lower.lastIndexOf('## run timeline');
  if (idx >= 0) {
    // Insert before the next ## heading after the timeline (or at end of section).
    const from = body.slice(idx);
    const nextRel = from.slice(1).search(/^##\s+/m);
    if (nextRel >= 0) {
      const insertAt = idx + 1 + nextRel;
      // Walk back over trailing blank lines in the timeline section.
      let end = insertAt;
      while (end > idx && (body[end - 1] === '\n' || body[end - 1] === '\r')) end--;
      return `${body.slice(0, end)}\n${eventLines.join('\n')}\n\n${body.slice(insertAt)}`;
    }
    const trimmed = body.trimEnd();
    return `${trimmed}\n${eventLines.join('\n')}\n`;
  }

  const block = ['## Mirror branch', '', ...eventLines, ''].join('\n');
  return `${body.trimEnd()}\n\n${block}\n`;
}
