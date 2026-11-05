/**
 * Domain — worktree / screenshot GC retention policy (disk hygiene).
 *
 * Pure: no IO. Isolation layer removes on-disk worktrees + optional screenshots;
 * this module only decides *which* terminal tasks are past retention.
 *
 * Safety contract (enforced by callers, documented here):
 * - Never delete remote branches.
 * - Never delete control-repo history / task files (that's auto-delete trash).
 * - Keep local `hercules/<id>` salvage branches; GC only frees worktrees + shots.
 * - Live / non-terminal tasks are never due.
 */
import { isTerminalState, type Task, type TaskState } from './task.js';

/**
 * States whose on-disk worktrees may be GC'd after retention.
 * Same set as scheduling terminals (done / cancelled / failed / deleted).
 * `review` is intentionally excluded — human salvage / approve still needs the
 * checkout when present, and preserve usually already dropped it.
 */
export const WORKTREE_GC_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'done',
  'cancelled',
  'failed',
  'deleted',
]);

/** Default days after terminal end before worktree/screenshot GC. */
export const DEFAULT_WORKTREE_GC_DAYS = 7;

/**
 * Anchor clock for worktree GC: when the task left active work (`endedAt`),
 * then lastEventAt, then createdAt. Same fallback chain as trash retention so
 * ops behavior is predictable.
 */
export function taskWorktreeGcAnchorMs(task: Task): number | null {
  const iso = task.endedAt ?? task.lastEventAt ?? task.createdAt;
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * True when a task is terminal for GC *and* has been past retention.
 * retentionMs ≤ 0 disables GC (nothing is due).
 */
export function isDueForWorktreeGc(
  task: Task,
  nowMs: number,
  retentionMs: number,
): boolean {
  if (retentionMs <= 0) return false;
  if (!WORKTREE_GC_STATES.has(task.state)) return false;
  // Defense in depth: GC set is a subset of terminals today.
  if (!isTerminalState(task.state)) return false;
  const anchor = taskWorktreeGcAnchorMs(task);
  if (anchor === null) return false;
  if (anchor > nowMs) return false;
  return nowMs - anchor >= retentionMs;
}

/** Ms remaining until worktree GC, or null when not a GC candidate. */
export function msUntilWorktreeGc(
  task: Task,
  nowMs: number,
  retentionMs: number,
): number | null {
  if (retentionMs <= 0) return null;
  if (!WORKTREE_GC_STATES.has(task.state)) return null;
  const anchor = taskWorktreeGcAnchorMs(task);
  if (anchor === null) return null;
  return retentionMs - (nowMs - anchor);
}

/** Pick tasks eligible for isolation-layer GC (repo key needed for paths). */
export function selectWorktreeGcTargets(
  tasks: readonly Task[],
  nowMs: number,
  retentionMs: number,
): readonly { readonly taskId: string; readonly repoKey: string }[] {
  return tasks
    .filter((t) => isDueForWorktreeGc(t, nowMs, retentionMs))
    .map((t) => ({ taskId: t.id, repoKey: t.repo }));
}

/**
 * One-line operator digest for tick / admin action.
 * Always safe to print (no paths that embed secrets).
 */
export function formatWorktreeGcLogLine(input: {
  readonly dryRun: boolean;
  readonly retentionDays: number;
  readonly candidates: number;
  readonly worktrees: readonly string[];
  readonly screenshots: readonly string[];
  readonly skippedLive: readonly string[];
}): string {
  const mode = input.dryRun ? 'dry-run' : 'apply';
  const wt =
    input.worktrees.length > 0 ? input.worktrees.join(',') : '(none)';
  const shots =
    input.screenshots.length > 0 ? input.screenshots.join(',') : '(none)';
  const skip =
    input.skippedLive.length > 0
      ? ` skippedLive=[${input.skippedLive.join(',')}]`
      : '';
  return (
    `[hercules] worktree-gc ${mode} retention=${input.retentionDays}d ` +
    `candidates=${input.candidates} worktrees=[${wt}] screenshots=[${shots}]${skip}`
  );
}
