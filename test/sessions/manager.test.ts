import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../../src/sessions/manager.js';
import { FakeAdapter } from '../../src/orchestrator/fakeAdapter.js';
import { AgentRegistry } from '../../src/orchestrator/agentRegistry.js';
import { NoopWorkspaces } from '../../src/isolation/worktree.js';
import type { ReposConfig } from '../../src/domain/repos.js';

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

describe('SessionManager (free Remote Control)', () => {
  let clock: number;
  let adapter: FakeAdapter;
  let mgr: SessionManager;

  beforeEach(() => {
    clock = 1_000_000;
    adapter = new FakeAdapter({
      durationMs: 5_000,
      finalMessage: 'Hello from free session',
      activity: ['thinking…'],
    });
    mgr = new SessionManager({
      agents: AgentRegistry.of(adapter),
      workspaces: new NoopWorkspaces('/tmp/hercules-rc-test'),
      getRepos: () => repos,
      clock: () => clock,
      maxConcurrent: 1,
    });
  });

  it('starts a free session and completes a turn', async () => {
    const s = await mgr.start({ repo: 'app', message: 'Look at README' });
    expect(s.kind).toBe('free');
    expect(s.status).toBe('running');
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]?.role).toBe('user');
    expect(adapter.started).toHaveLength(1);
    expect(adapter.started[0]?.prompt).toContain('Look at README');

    clock += 6_000;
    await mgr.tick();
    const done = mgr.get(s.id)!;
    expect(done.status).toBe('idle');
    expect(done.messages.some((m) => m.role === 'assistant')).toBe(true);
    expect(done.agentSession).toBeTruthy();
  });

  it('queues messages while running and drains after', async () => {
    const s = await mgr.start({ repo: 'app', message: 'first' });
    const queued = await mgr.send(s.id, 'second');
    expect(queued.queued).toEqual(['second']);
    expect(queued.messages.filter((m) => m.role === 'user')).toHaveLength(2);

    clock += 6_000;
    await mgr.tick();
    // After first turn, queue should start a continue turn.
    const mid = mgr.get(s.id)!;
    expect(mid.status).toBe('running');
    expect(mid.queued).toEqual([]);
    expect(adapter.started.length).toBeGreaterThanOrEqual(2);
    expect(adapter.started[1]?.resumeSessionId).toBeTruthy();

    clock += 6_000;
    await mgr.tick();
    expect(mgr.get(s.id)?.status).toBe('idle');
  });

  it('rejects unknown repo', async () => {
    await expect(mgr.start({ repo: 'nope', message: 'x' })).rejects.toThrow(/unknown repo/);
  });

  it('enforces max concurrent free sessions', async () => {
    await mgr.start({ repo: 'app', message: 'one' });
    await expect(mgr.start({ repo: 'app', message: 'two' })).rejects.toThrow(/cap reached/);
  });

  it('closes a session and drops it from the list', async () => {
    const s = await mgr.start({ repo: 'app', message: 'bye' });
    await mgr.close(s.id);
    expect(mgr.get(s.id)).toBeUndefined();
    expect(mgr.list().find((x) => x.id === s.id)).toBeUndefined();
  });
});
