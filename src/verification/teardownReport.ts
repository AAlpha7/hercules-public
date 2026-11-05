/**
 * Pure markdown renderer for the teardown residue section (SPEC §9).
 *
 * Consumes the workspace impact snapshot and token usage collected at task
 * teardown and produces a human-readable "## Teardown" section for the review
 * packet. No I/O, no side effects.
 */
import type { WorkspaceImpact } from '../isolation/worktree.js';
import type { TokenUsage } from '../orchestrator/adapter.js';

export interface TeardownReport {
  readonly method: 'graceful' | 'forced';
  readonly impact: WorkspaceImpact | null;
  readonly usage?: TokenUsage;
}

/**
 * Render a `## Teardown` markdown section summarising how the agent was
 * stopped, what it left behind, and whether any repo-external side effects
 * occurred (which cannot be known).
 */
export function renderTeardownReport(r: TeardownReport): string {
  const lines: string[] = [];

  lines.push('## Teardown');
  lines.push('');

  if (r.method === 'graceful') {
    lines.push('**Method:** graceful — sent SIGTERM, the agent exited on its own.');
  } else {
    lines.push('**Method:** forced — sent SIGKILL, work may be partially unflushed.');
  }

  lines.push('');
  lines.push('**Cleaned:** worktree, port, scratch directory, process group.');

  lines.push('');
  lines.push('### Persists / for you to judge');

  if (r.impact !== null) {
    lines.push('');
    lines.push('**Discarded work:**');
    lines.push(`- ${r.impact.changedFiles} uncommitted file change(s) in the worktree.`);
    lines.push(`- ${r.impact.localCommits} local commit(s) on the task branch.`);
    if (r.impact.pushedRemote) {
      lines.push('- Branch was pushed to the remote — it persists on origin.');
    } else {
      lines.push('- Branch was NOT pushed to the remote — local only.');
    }
  }

  if (r.usage !== undefined) {
    lines.push('');
    lines.push(`**Token spend:** ${r.usage.inputTokens} input / ${r.usage.outputTokens} output — cost $${r.usage.costUsd.toFixed(2)}.`);
  }

  lines.push('');
  lines.push(
    '**Note:** repo-external side effects (API calls, PRs opened, webhooks fired) are NOT knowable from this report.',
  );

  return lines.join('\n');
}
