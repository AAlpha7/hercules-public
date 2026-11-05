import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../../src/sessions/manager.js';
import { FakeAdapter } from '../../src/orchestrator/fakeAdapter.js';
import { AgentRegistry } from '../../src/orchestrator/agentRegistry.js';
import { NoopWorkspaces } from '../../src/isolation/worktree.js';
import type { ReposConfig } from '../../src/domain/repos.js';
import type { Task } from '../../src/domain/task.js';
import type { TaskSessionBridge } from '../../src/sessions/taskBridge.js';

const repos: ReposConfig = {
  repos: {
    app: {
      key: 'app',
      url: 'https://github.com/example/app.git',
      defaultBranch: 'main',
      workflow: 'WORKFLOW.md',
      maxConcurrent: 1,
      adapter: null, readiness: 'ready',
    },
  },
};

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 'T1',
    title: 'Do the thing',
    repo: 'app',
    state: 'in_progress',
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
    body: 'task body',
    ...over,
  };
}

describe('SessionManager task live sessions', () => {
  let clock: number;
  let deliveries: { id: string; message: string }[];
  let task: Task;
  let bridge: TaskSessionBridge;
  let mgr: SessionManager;

  beforeEach(() => {
    clock = 1_000_000;
    deliveries = [];
    task = makeTask();
    bridge = {
      getTask: async (id) => (id === task.id ? task : null),
      isRunning: (id) => id === task.id && task.state === 'in_progress',
      activity: () => ['edit src/x.ts'],
      deliverMessage: async (id, message) => {
        deliveries.push({ id, message });
        if (task.state === 'in_progress') return { mode: 'queued' };
        return { mode: 'steer' };
      },
      workspaceDir: () => null,
    };
    mgr = new SessionManager({
      agents: AgentRegistry.of(new FakeAdapter({ durationMs: 50_000 })),
      workspaces: new NoopWorkspaces('/tmp/hercules-rc-test'),
      getRepos: () => repos,
      clock: () => clock,
      maxConcurrent: 2,
      taskBridge: bridge,
      workRoot: '/tmp/hercules-rc-test-work',
    });
  });

  it('openTaskLive creates a kind=task session with task id', async () => {
    const s = await mgr.openTaskLive('T1');
    expect(s.id).toBe('T1');
    expect(s.kind).toBe('task');
    expect(s.taskId).toBe('T1');
    expect(s.status).toBe('running');
    expect(mgr.activity()['T1']).toEqual(['edit src/x.ts']);
  });

  it('reuses existing task session', async () => {
    const a = await mgr.openTaskLive('T1');
    const b = await mgr.openTaskLive('T1');
    expect(b.id).toBe(a.id);
    expect(mgr.list().filter((s) => s.id === 'T1')).toHaveLength(1);
  });

  it('reopen refreshes status and transcript even when id is unchanged', async () => {
    const a = await mgr.openTaskLive('T1');
    expect(a.status).toBe('running');
    // Agent finishes → task moves to review
    task = makeTask({ state: 'review', title: 'Do the thing (done)' });
    clock += 1_000;
    const b = await mgr.openTaskLive('T1');
    expect(b.id).toBe('T1');
    expect(b.status).toBe('idle');
    expect(b.title).toContain('done');
    expect(b.updatedAt).not.toBe(a.updatedAt);
    const finish = b.messages.find((m) => m.role === 'system' && /review|finished/i.test(m.content));
    expect(finish).toBeTruthy();
    // Structured jump target — phone UI renders an "Open review packet" button.
    expect(finish?.actions?.some((a) => a.kind === 'open_task' && a.target === 'T1')).toBe(true);
    expect(finish?.actions?.[0]?.label).toMatch(/review|Open/i);
  });

  it('list/get expose open_task on finished system lines', async () => {
    await mgr.openTaskLive('T1');
    task = makeTask({ state: 'review' });
    clock += 1_000;
    await mgr.openTaskLive('T1');
    const listed = mgr.list().find((s) => s.id === 'T1');
    const got = mgr.get('T1');
    expect(listed).toBeTruthy();
    expect(got).toBeTruthy();
    for (const s of [listed!, got!]) {
      const finishes = s.messages.filter(
        (m) => m.role === 'system' && /finished this turn/i.test(m.content),
      );
      expect(finishes.length).toBeGreaterThan(0);
      for (const f of finishes) {
        expect(f.actions?.some((a) => a.kind === 'open_task' && a.target === 'T1')).toBe(true);
      }
    }
  });

  it('reopen while still running stamps a live refresh marker', async () => {
    await mgr.openTaskLive('T1');
    clock += 500;
    const b = await mgr.openTaskLive('T1');
    expect(b.status).toBe('running');
    expect(b.messages.some((m) => /agent running|refreshed/i.test(m.content))).toBe(true);
  });

  it('send on task session delivers via bridge and records transcript', async () => {
    await mgr.openTaskLive('T1');
    const next = await mgr.send('T1', 'please fix lint');
    expect(deliveries).toEqual([{ id: 'T1', message: 'please fix lint' }]);
    expect(next.messages.some((m) => m.role === 'user' && m.content.includes('please fix lint'))).toBe(
      true,
    );
    expect(next.messages.some((m) => m.role === 'system' && /Queued/i.test(m.content))).toBe(true);
  });

  it('send includes attachment paths in agent text', async () => {
    await mgr.openTaskLive('T1');
    await mgr.send('T1', 'see screenshot', {
      attachments: [
        {
          id: 'att1',
          kind: 'image',
          name: 'ui.png',
          relPath: '.scratch/uploads/att1-ui.png',
          mime: 'image/png',
          bytes: 100,
        },
      ],
      refs: [{ kind: 'task', target: 'OTHER', label: 'other' }],
    });
    expect(deliveries[0]?.message).toContain('see screenshot');
    expect(deliveries[0]?.message).toContain('.scratch/uploads/att1-ui.png');
    expect(deliveries[0]?.message).toContain('OTHER');
  });

  it('rejects open when bridge missing task', async () => {
    await expect(mgr.openTaskLive('ghost')).rejects.toThrow(/unknown task/);
  });
});
