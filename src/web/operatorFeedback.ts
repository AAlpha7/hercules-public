/**
 * Phone operator feedback after create / approve-plan.
 * Pure strings — no React. Keeps "where did my task go?" from looking like data loss.
 */
import type { RepoDto, Task } from './api.js';

/** States that occupy a per-repo dispatch slot (matches tick running set). */
const SLOT_STATES = new Set(['in_progress', 'retrying']);

export function tasksHoldingRepoSlot(
  tasks: readonly Task[],
  repo: string,
  /** Exclude this id (e.g. the task we just approved still listed as todo). */
  excludeId?: string,
): readonly Task[] {
  return tasks.filter(
    (t) =>
      t.repo === repo &&
      SLOT_STATES.has(t.state) &&
      (excludeId === undefined || t.id !== excludeId),
  );
}

export function repoMaxConcurrent(
  repos: readonly RepoDto[],
  repo: string,
): number {
  const r = repos.find((x) => x.key === repo);
  const n = r?.maxConcurrent;
  return typeof n === 'number' && n > 0 ? Math.floor(n) : 1;
}

function clipTitle(title: string, max = 28): string {
  const t = title.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function queueHint(
  repo: string,
  maxConcurrent: number,
  holders: readonly Task[],
): string {
  if (holders.length === 0 || holders.length < maxConcurrent) {
    return '已入队，即将调度';
  }
  const names = holders
    .slice(0, 3)
    .map((t) => t.id)
    .join('、');
  const more = holders.length > 3 ? ` 等${holders.length}个` : '';
  return `已入队（${repo} 正跑 ${names}${more}，并发×${maxConcurrent}）`;
}

/** After createTask returns (sheet still open until parent closes). */
export function formatTaskCreatedFeedback(
  task: Task,
  allTasks: readonly Task[],
  repos: readonly RepoDto[],
): string {
  const title = clipTitle(task.title);
  if (task.planPending) {
    return `已创建「${title}」· 等你批计划（${task.id}）`;
  }
  const max = repoMaxConcurrent(repos, task.repo);
  const holders = tasksHoldingRepoSlot(allTasks, task.repo, task.id);
  return `已创建 ${task.id} · ${queueHint(task.repo, max, holders)}`;
}

/** After approvePlan — plan panel is gone; tell the operator where the task went. */
export function formatPlanApprovedFeedback(
  task: Task,
  allTasks: readonly Task[],
  repos: readonly RepoDto[],
): string {
  const max = repoMaxConcurrent(repos, task.repo);
  const holders = tasksHoldingRepoSlot(allTasks, task.repo, task.id);
  return `计划已批 · ${task.id} ${queueHint(task.repo, max, holders)}`;
}

/** After createPipeline — N tasks, first stage usually runnable. */
export function formatPipelineCreatedFeedback(
  tasks: readonly Task[],
  allTasks: readonly Task[],
  repos: readonly RepoDto[],
): string {
  if (tasks.length === 0) return '流水线已创建';
  const first = tasks[0]!;
  const max = repoMaxConcurrent(repos, first.repo);
  const holders = tasksHoldingRepoSlot(allTasks, first.repo);
  const head = `已创建 ${tasks.length} 段流水线 · 首段 ${first.id}`;
  return `${head} · ${queueHint(first.repo, max, holders)}`;
}

/** Toast when a background analyst draft finishes while CreateForm is closed. */
export function draftReadyNotice(job: { repo: string; intent: string }): string {
  return `分析完成：${job.repo} · ${clipTitle(job.intent, 28)} — 点击待决打开草稿`;
}
