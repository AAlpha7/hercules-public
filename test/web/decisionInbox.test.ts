/**
 * CEO decision inbox: everything that needs the human TODAY, one line each,
 * one action each — instead of hunting across review/failed/releases panels.
 * Pure derivation from existing state; no new storage.
 */
import { describe, it, expect } from 'vitest';
import { buildDecisionInbox } from '../../src/web/decisionInbox.js';
import type { Task } from '../../src/web/api.js';

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id, title: id, repo: 'app', state: 'todo', priority: 1, blockedBy: [],
    labels: [], adapter: null, agentSession: null, pendingSteer: null,
    attempts: 0, lastEventAt: null, createdAt: null, startedAt: null,
    endedAt: null, prUrl: null, prStatus: null, planPending: false, body: '',
    ...over,
  } as Task;
}

describe('buildDecisionInbox', () => {
  it('collects review, plan, failed, blocked and promote items with zh one-liners', () => {
    const tasks = [
      task('R', {
        state: 'review',
        title: '修复重试',
        body: '## Review packet\n**✅ automated proof complete**\n',
      }),
      task('P', { state: 'todo', planPending: true, title: '模糊想法' }),
      task('F', { state: 'failed', title: '失败任务', attempts: 3 }),
      task('DEP', { state: 'failed' }),
      task('B', { state: 'todo', blockedBy: ['DEP'], title: '被扣任务' }),
      task('quiet', { state: 'done' }),
    ];
    const items = buildDecisionInbox(tasks, [
      { repoKey: 'app', canPromote: true, stagingReady: true, changeCount: 4 },
    ]);
    const kinds = items.map((i) => i.kind);
    expect(kinds).toContain('approve');
    expect(kinds).toContain('plan');
    expect(kinds).toContain('failed');
    expect(kinds).toContain('blocked');
    expect(kinds).toContain('promote');
    // done tasks don't nag.
    expect(items.some((i) => i.taskId === 'quiet')).toBe(false);
    // zh, one line, actionable.
    const approve = items.find((i) => i.kind === 'approve')!;
    expect(approve.line).toMatch(/待批|批准/);
    expect(approve.taskId).toBe('R');
    const promote = items.find((i) => i.kind === 'promote')!;
    expect(promote.line).toMatch(/发布|Promote/i);
  });

  it('orders by decision urgency: approve → promote → plan → failed → blocked', () => {
    const tasks = [
      task('F', { state: 'failed' }),
      task('P', { state: 'todo', planPending: true }),
      task('R', { state: 'review' }),
    ];
    const items = buildDecisionInbox(tasks, [
      { repoKey: 'app', canPromote: true, stagingReady: true, changeCount: 1 },
    ]);
    expect(items.map((i) => i.kind)).toEqual(['approve', 'promote', 'plan', 'failed']);
  });

  it('green review items say 可放心批; non-green say 需要人工判断', () => {
    const tasks = [
      task('G', {
        state: 'review',
        body: '## Review packet\n**✅ automated proof complete**\n',
      }),
      task('N', { state: 'review', body: 'DoD mechanical fail' }),
      task('S', {
        state: 'review',
        // Whole-body phrase without a packet must NOT count as green (C3.27 N1).
        body: 'x **✅ automated proof complete** y',
      }),
    ];
    const items = buildDecisionInbox(tasks, []);
    expect(items.find((i) => i.taskId === 'G')!.line).toMatch(/全绿|放心/);
    expect(items.find((i) => i.taskId === 'N')!.line).toMatch(/人工|未全绿/);
    expect(items.find((i) => i.taskId === 'S')!.line).toMatch(/人工|未全绿/);
  });

  it('trunk-inherited gate fail hints 需先修 main in the approve line', () => {
    const tasks = [
      task('T', {
        state: 'review',
        title: 'webapp evidence',
        body: '⚠ 该失败在 main (merge-base 7dbb9a39aabb) 上同样存在 — 属主干既有问题, 非本任务引入',
      }),
    ];
    const items = buildDecisionInbox(tasks, []);
    expect(items.find((i) => i.taskId === 'T')!.line).toMatch(/主干|修 main/);
  });

  it('empty state → empty inbox (no noise)', () => {
    expect(buildDecisionInbox([task('D', { state: 'done' })], [])).toEqual([]);
  });

  it('surfaces same-repo implement waiting on Merge Selected after Approve', () => {
    const tasks = [
      task('UP', { state: 'done', title: '上游已批' }),
      task('DOWN', {
        state: 'todo',
        blockedBy: ['UP'],
        title: '下游实现',
        executionClass: 'implement',
      }),
    ];
    const items = buildDecisionInbox(tasks, []);
    const blocked = items.find((i) => i.taskId === 'DOWN');
    expect(blocked?.kind).toBe('blocked');
    expect(blocked?.line).toMatch(/Merge Selected|未合并/);
  });

  it('adds a system item when dispatchHold is active (no deep-link)', () => {
    const items = buildDecisionInbox([task('D', { state: 'done' })], [], {
      dispatchHold: {
        reason: 'disk',
        detail: '磁盘 98% (剩 2.0G) — 清出空间后自动恢复',
      },
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('system');
    expect(items[0]!.taskId).toBeUndefined();
    expect(items[0]!.repoKey).toBeUndefined();
    expect(items[0]!.line).toMatch(/调度暂停/);
    expect(items[0]!.line).toMatch(/98%/);
  });

  it('orders system ahead of approve when hold is active', () => {
    const items = buildDecisionInbox(
      [task('R', { state: 'review', title: '待批' })],
      [],
      {
        dispatchHold: {
          reason: 'disk',
          detail: '磁盘 97% (剩 3.0G) — 清出空间后自动恢复',
        },
      },
    );
    expect(items.map((i) => i.kind)).toEqual(['system', 'approve']);
  });

  it('adds a system item when adapter failover is active', () => {
    const items = buildDecisionInbox([task('D', { state: 'done' })], [], {
      adapterFailover: {
        unhealthy: ['grok'],
        detail: '⚠️ adapter 降级 — grok 不健康, 新派发使用 claude',
        substitute: 'claude',
      },
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('system');
    expect(items[0]!.taskId).toBeUndefined();
    expect(items[0]!.line).toMatch(/adapter 降级/);
    expect(items[0]!.line).toMatch(/claude/);
  });

  it('ready draft job → one draft row with draftJobId, after system and before approve', () => {
    const items = buildDecisionInbox(
      [task('R', { state: 'review', title: '待批' })],
      [],
      {
        dispatchHold: {
          reason: 'disk',
          detail: '磁盘 97% — 清出空间后自动恢复',
        },
        draftJobs: [
          {
            id: 'dj-ready',
            repo: 'app',
            intent: '把底栏 Logout 改成 Settings 并加语言切换',
            status: 'ready',
          },
          {
            id: 'dj-run',
            repo: 'app',
            intent: 'still running',
            status: 'running',
          },
          {
            id: 'dj-fail',
            repo: 'app',
            intent: 'failed job',
            status: 'failed',
          },
        ],
      },
    );
    expect(items.map((i) => i.kind)).toEqual(['system', 'draft', 'approve']);
    const draft = items.find((i) => i.kind === 'draft')!;
    expect(draft.draftJobId).toBe('dj-ready');
    expect(draft.line).toMatch(/分析完成/);
    expect(draft.line).toContain('app');
    expect(items.some((i) => i.draftJobId === 'dj-run')).toBe(false);
    expect(items.some((i) => i.draftJobId === 'dj-fail')).toBe(false);
  });

  it('running/failed draft jobs produce no inbox row', () => {
    const items = buildDecisionInbox([task('D', { state: 'done' })], [], {
      draftJobs: [
        { id: 'dj-a', repo: 'app', intent: 'a', status: 'running' },
        { id: 'dj-b', repo: 'app', intent: 'b', status: 'failed' },
      ],
    });
    expect(items).toEqual([]);
  });
});

describe('inbox + digest + failure-brief wiring', () => {
  it('App renders the decision inbox card with digest header', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
    const app = await readFile(join(root, 'src/web/App.tsx'), 'utf8');
    expect(app).toMatch(/buildDecisionInbox\(/);
    expect(app).toMatch(/formatDigestLine\(/);
    expect(app).toMatch(/data-evidence="decision-inbox"/);
    // Always-mounted hosts (not conditional JSX) so L2 finds them without
    // live disk critical; visibility gated via `hidden` from state.
    expect(app).toMatch(/data-evidence="dispatch-hold"/);
    expect(app).toMatch(/data-evidence="disk-warn"/);
    expect(app).toMatch(/hidden=\{!state\?\.dispatchHold\}/);
    expect(app).toMatch(/hidden=\{Boolean\(state\?\.dispatchHold\) \|\| !state\?\.diskWarn\}/);
    expect(app).toMatch(/dispatchHold/);
    const detail = await readFile(join(root, 'src/web/TaskDetail.tsx'), 'utf8');
    expect(detail).toMatch(/failureBrief\(/);
    expect(detail).toMatch(/adviceZh/);
  });
});
