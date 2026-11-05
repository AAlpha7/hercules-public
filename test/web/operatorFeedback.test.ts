import { describe, expect, it } from 'vitest';
import type { RepoDto, Task } from '../../src/web/api.js';
import {
  draftReadyNotice,
  formatPipelineCreatedFeedback,
  formatPlanApprovedFeedback,
  formatTaskCreatedFeedback,
  repoMaxConcurrent,
  tasksHoldingRepoSlot,
} from '../../src/web/operatorFeedback.js';

function task(partial: Partial<Task> & Pick<Task, 'id' | 'repo' | 'state'>): Task {
  return {
    title: partial.title ?? partial.id,
    priority: 100,
    blockedBy: [],
    labels: [],
    adapter: null,
    agentSession: null,
    pendingSteer: null,
    attempts: 0,
    lastEventAt: null,
    createdAt: null,
    startedAt: null,
    endedAt: null,
    prUrl: null,
    prStatus: null,
    planPending: false,
    verifiedSha: null,
    body: '',
    ...partial,
  };
}

function repo(key: string, maxConcurrent = 1): RepoDto {
  return {
    key,
    url: `git@h:${key}.git`,
    defaultBranch: 'main',
    workflow: 'WORKFLOW.md',
    maxConcurrent,
    adapter: null,
    effectiveAdapter: 'grok',
    readiness: 'ready',
  };
}

describe('operatorFeedback', () => {
  it('counts only in_progress/retrying as repo slot holders', () => {
    const tasks = [
      task({ id: 'a', repo: 'Demo', state: 'in_progress' }),
      task({ id: 'b', repo: 'Demo', state: 'todo' }),
      task({ id: 'c', repo: 'Demo', state: 'retrying' }),
      task({ id: 'd', repo: 'hercules', state: 'in_progress' }),
    ];
    expect(tasksHoldingRepoSlot(tasks, 'Demo').map((t) => t.id)).toEqual(['a', 'c']);
    expect(tasksHoldingRepoSlot(tasks, 'Demo', 'a').map((t) => t.id)).toEqual(['c']);
  });

  it('defaults maxConcurrent to 1', () => {
    expect(repoMaxConcurrent([repo('Demo', 2)], 'Demo')).toBe(2);
    expect(repoMaxConcurrent([], 'ghost')).toBe(1);
  });

  it('create: plan draft asks for plan approval', () => {
    const created = task({
      id: 'task-10',
      repo: 'Demo',
      state: 'todo',
      title: '考据默认关',
      planPending: true,
    });
    const msg = formatTaskCreatedFeedback(created, [], [repo('Demo')]);
    expect(msg).toMatch(/等你批计划/);
    expect(msg).toContain('task-10');
  });

  it('create: at repo cap explains queue wait', () => {
    const peers = [task({ id: 'task-8', repo: 'Demo', state: 'in_progress', title: 'old' })];
    const created = task({
      id: 'task-10',
      repo: 'Demo',
      state: 'todo',
      title: '考据选项',
    });
    const msg = formatTaskCreatedFeedback(created, peers, [repo('Demo', 1)]);
    expect(msg).toContain('task-10');
    expect(msg).toMatch(/已入队/);
    expect(msg).toContain('task-8');
    expect(msg).toMatch(/并发×1/);
  });

  it('create: free slot says soon to dispatch', () => {
    const created = task({ id: 'task-11', repo: 'Demo', state: 'todo', title: 'x' });
    const msg = formatTaskCreatedFeedback(created, [], [repo('Demo', 1)]);
    expect(msg).toMatch(/即将调度/);
  });

  it('approve plan: explains departure from plan inbox when capped', () => {
    const peers = [task({ id: 'task-8', repo: 'Demo', state: 'in_progress' })];
    const updated = task({ id: 'task-10', repo: 'Demo', state: 'todo', title: 'x' });
    const msg = formatPlanApprovedFeedback(updated, peers, [repo('Demo', 1)]);
    expect(msg).toMatch(/计划已批/);
    expect(msg).toContain('task-10');
    expect(msg).toContain('task-8');
  });

  it('pipeline: mentions stage count and first id', () => {
    const stages = [
      task({ id: 'p-1', repo: 'app', state: 'todo' }),
      task({ id: 'p-2', repo: 'app', state: 'todo' }),
    ];
    const msg = formatPipelineCreatedFeedback(stages, [], [repo('app', 1)]);
    expect(msg).toMatch(/2 段/);
    expect(msg).toContain('p-1');
  });

  it('draftReadyNotice clips long intents and points at 待决', () => {
    const long =
      '把底栏 Logout 改成 Settings，并加入语言切换与默认 agent 选择，外加更多说明文字确保超长';
    const msg = draftReadyNotice({ repo: 'hercules', intent: long });
    expect(msg).toMatch(/^分析完成：hercules · /);
    expect(msg).toMatch(/点击待决打开草稿$/);
    expect(msg.length).toBeLessThan(long.length + 40);
    expect(msg).toContain('…');
  });
});
