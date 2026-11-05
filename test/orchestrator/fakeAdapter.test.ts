import { describe, it, expect } from 'vitest';
import { summarizeAgentDeath } from '../../src/domain/agentDeath.js';
import { FakeAdapter } from '../../src/orchestrator/fakeAdapter.js';

const input = {
  taskId: 'A',
  workspace: '/tmp/A',
  prompt: 'do it',
  allocation: { slug: 'A', port: 4000, scratchDir: '/tmp/A/.scratch' },
};

const start = (a: FakeAdapter, id: string, now: number) =>
  a.start({ taskId: id, workspace: '/w', prompt: '', allocation: { slug: id, port: 0, scratchDir: '/s' } }, now);

const isolationEnv = {
  HERCULES_ADAPTER: 'fake',
  HERCULES_FAKE_FAULT_INJECTION: '1',
} as const;

describe('FakeAdapter', () => {
  it('runs, then reports done after its duration elapses (default success)', () => {
    const adapter = new FakeAdapter({ durationMs: 1000 });
    const run = adapter.start(input, 0);

    expect(run.poll(0).status).toBe('running');
    expect(run.poll(999).status).toBe('running');
    expect(run.poll(1000).status).toBe('done');
    expect(run.poll(5000).status).toBe('done');
  });

  it('advances lastEventAt while running so the run looks alive', () => {
    const adapter = new FakeAdapter({ durationMs: 1000 });
    const run = adapter.start(input, 100);
    expect(run.poll(400).lastEventAt).toBe(400);
    expect(run.poll(700).lastEventAt).toBe(700);
  });

  it('reports failed when configured to fail', () => {
    const adapter = new FakeAdapter({ durationMs: 500, fail: true });
    const run = adapter.start(input, 0);
    expect(run.poll(499).status).toBe('running');
    expect(run.poll(500).status).toBe('failed');
  });

  it('hangs: stays running with a frozen lastEventAt (drives stall detection)', () => {
    const adapter = new FakeAdapter({ durationMs: 1000, hang: true });
    const run = adapter.start(input, 100);
    expect(run.poll(10_000).status).toBe('running');
    expect(run.poll(10_000).lastEventAt).toBe(100);
  });

  it('supports per-task behavior overrides', () => {
    const adapter = new FakeAdapter({ durationMs: 1000 }, { B: { durationMs: 100, fail: true } });
    const a = adapter.start({ ...input, taskId: 'A' }, 0);
    const b = adapter.start({ ...input, taskId: 'B' }, 0);
    expect(a.poll(1000).status).toBe('done');
    expect(b.poll(100).status).toBe('failed');
  });

  it('reports stopped runs as failed and records the stop', () => {
    const adapter = new FakeAdapter({ durationMs: 1000 });
    const run = adapter.start(input, 0);
    run.stop();
    expect(run.poll(10).status).toBe('failed');
    expect(adapter.stopped).toContainEqual({ id: 'A', force: false });
  });

  it('assigns a unique session id per run', () => {
    const adapter = new FakeAdapter({ durationMs: 1 });
    const a = adapter.start({ ...input, taskId: 'A' }, 0);
    const b = adapter.start({ ...input, taskId: 'B' }, 0);
    expect(a.sessionId).not.toBe(b.sessionId);
  });
});

describe('FakeAdapter activity reveal', () => {
  it('reveals scripted activity over time', () => {
    const a = new FakeAdapter({ durationMs: 10_000, activity: ['a', 'b', 'c'] });
    const run = a.start({ taskId: 'A', workspace: '/w', prompt: '', allocation: { slug: 'A', port: 0, scratchDir: '/s' } }, 0);
    expect(run.poll(0).recentActivity).toEqual(['a']);
    expect(run.poll(2_000).recentActivity).toEqual(['a', 'b', 'c']);
  });
});

describe('FakeAdapter graceful stop', () => {
  it('keeps running through the grace window after a graceful stop, then exits', () => {
    const a = new FakeAdapter({ durationMs: 10_000, stopGraceMs: 5_000 });
    const run = start(a, 'A', 0);
    run.stop();
    expect(run.poll(1_000).status).toBe('running'); // still winding down
    expect(run.poll(6_000).status).toBe('failed');  // grace elapsed → exited
    expect(a.stopped).toContainEqual({ id: 'A', force: false });
  });
  it('force stop exits immediately', () => {
    const a = new FakeAdapter({ durationMs: 10_000, stopGraceMs: 5_000 });
    const run = start(a, 'B', 0);
    run.stop({ force: true });
    expect(run.poll(1).status).toBe('failed');
    expect(a.stopped).toContainEqual({ id: 'B', force: true });
  });
});

describe('FakeAdapter fault-injection scripts (isolation only)', () => {
  it('die-immediately fails at first poll with 502 death evidence when enabled', () => {
    const a = new FakeAdapter({ durationMs: 60_000 }, {}, { env: isolationEnv });
    const run = a.start({ ...input, fakeBehavior: 'die-immediately' }, 0);
    const snap = run.poll(0);
    expect(snap.status).toBe('failed');
    expect(snap.exitCode).toBe(1);
    expect(snap.stderrTail).toMatch(/502|mid-stream/i);
    const cause = summarizeAgentDeath({
      ...(snap.stderrTail ? { stderrTail: snap.stderrTail } : {}),
      ...(snap.exitCode !== undefined ? { exitCode: snap.exitCode } : {}),
    });
    expect(cause).toMatch(/502|mid-stream/i);
  });

  it('die-mid-turn stays running then fails with activity + stderr', () => {
    const a = new FakeAdapter({ durationMs: 60_000 }, {}, { env: isolationEnv });
    const run = a.start({ ...input, fakeBehavior: 'die-mid-turn' }, 0);
    expect(run.poll(0).status).toBe('running');
    const snap = run.poll(80);
    expect(snap.status).toBe('failed');
    expect(run.activityLog().length).toBeGreaterThan(0);
    expect(snap.stderrTail).toMatch(/502|stream/i);
  });

  it('succeed completes as done under isolation', () => {
    const a = new FakeAdapter({ durationMs: 60_000, fail: true }, {}, { env: isolationEnv });
    const run = a.start({ ...input, fakeBehavior: 'succeed' }, 0);
    expect(run.poll(0).status).toBe('running');
    expect(run.poll(50).status).toBe('done');
  });

  it('ignores fakeBehavior when fault injection is disabled (no production leak)', () => {
    const a = new FakeAdapter(
      { durationMs: 1_000 },
      {},
      { env: { HERCULES_ADAPTER: 'fake', HERCULES_FAKE_FAULT_INJECTION: '0' } },
    );
    const run = a.start({ ...input, fakeBehavior: 'die-immediately' }, 0);
    // Default duration still applies — not instant die.
    expect(run.poll(0).status).toBe('running');
    expect(run.poll(1_000).status).toBe('done');
  });

  it('ignores fakeBehavior when adapter default is not fake env (real path guard)', () => {
    const a = new FakeAdapter(
      { durationMs: 500 },
      {},
      { env: { HERCULES_ADAPTER: 'grok', HERCULES_FAKE_FAULT_INJECTION: '1' } },
    );
    const run = a.start({ ...input, fakeBehavior: 'die-immediately' }, 0);
    expect(run.poll(0).status).toBe('running');
    expect(run.poll(500).status).toBe('done');
  });

  it('per-task constructor override still wins over front-matter script', () => {
    const a = new FakeAdapter(
      { durationMs: 1_000 },
      { A: { durationMs: 10, hang: true } },
      { env: isolationEnv },
    );
    const run = a.start({ ...input, taskId: 'A', fakeBehavior: 'die-immediately' }, 0);
    expect(run.poll(10_000).status).toBe('running');
    expect(run.poll(10_000).lastEventAt).toBe(0);
  });
});
