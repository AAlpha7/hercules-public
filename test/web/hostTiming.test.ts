import { describe, it, expect } from 'vitest';
import { shortTiming } from '../../src/web/taskUi.js';
import type { LiveRunMeta, Task } from '../../src/web/api.js';

function baseTask(over: Partial<Task> = {}): Task {
  return {
    id: 'HOST',
    title: 'host op',
    body: 'do it',
    state: 'in_progress',
    repo: 'app',
    priority: 50,
    blockedBy: [],
    labels: [],
    createdAt: '2026-07-31T12:00:00.000Z',
    startedAt: '2026-07-31T12:00:00.000Z',
    endedAt: null,
    attempts: 0,
    lastEventAt: '2026-07-31T12:00:00.000Z',
    agentSession: null,
    pendingSteer: null,
    adapter: 'grok',
    prUrl: null,
    prStatus: null,
    planPending: false,
    executionClass: 'host_operation',
    hostCommandScope: ['systemctl restart hercules'],
    hostApprovedAt: '2026-07-31T11:59:00.000Z',
    ...over,
  };
}

describe('shortTiming — host executor elapsed/timeout', () => {
  it('shows command index/name + elapsed/timeout without secrets or overflow', () => {
    const live: LiveRunMeta = {
      taskId: 'HOST',
      sessionId: 'host-exec:HOST:1',
      lastEventAt: '2026-07-31T12:00:05.000Z',
      branchTip: null,
      runKind: 'implementer',
      activityLines: 1,
      processAlive: true,
      silenceMs: 0,
      runMs: 65_000,
      maxRunMs: 7_200_000,
      aliveHint: 'host:1/2 systemctl restart hercules',
      procCpuPct: null,
      procRssMb: null,
      hostCommandIndex: 1,
      hostCommandTotal: 2,
      hostCommandName: 'systemctl restart hercules',
      hostCommandTimeoutMs: 1_800_000,
    };
    const label = shortTiming(baseTask(), Date.parse('2026-07-31T12:01:05.000Z'), live);
    expect(label).not.toBeNull();
    expect(label!).toMatch(/host 1\/2/);
    expect(label!).toMatch(/systemctl restart hercules/);
    // Elapsed (~1m) and timeout (~30m) both present.
    expect(label!).toMatch(/1m/);
    expect(label!).toMatch(/30m/);
    expect(label!).not.toMatch(/TOKEN|password|secret|sk-|xai-/i);
  });

  it('bounds a long command name so the card does not overflow', () => {
    const longName =
      'systemctl restart very-long-service-name-that-would-overflow-the-phone-card-ui';
    const live: LiveRunMeta = {
      taskId: 'HOST',
      sessionId: 'host-exec:HOST:1',
      lastEventAt: '2026-07-31T12:00:05.000Z',
      branchTip: null,
      runKind: 'implementer',
      activityLines: 1,
      processAlive: true,
      silenceMs: 0,
      runMs: 5_000,
      maxRunMs: 7_200_000,
      aliveHint: null,
      procCpuPct: null,
      procRssMb: null,
      hostCommandIndex: 1,
      hostCommandTotal: 1,
      hostCommandName: longName,
      hostCommandTimeoutMs: 60_000,
    };
    const label = shortTiming(baseTask(), Date.now(), live)!;
    expect(label.length).toBeLessThan(80);
    expect(label).toContain('…');
    expect(label).toMatch(/1m|60s|s\b/);
  });
});
