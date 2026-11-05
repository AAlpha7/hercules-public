import { describe, it, expect } from 'vitest';
import { serializeState } from '../../src/server/view.js';
import type { RuntimeView } from '../../src/orchestrator/orchestrator.js';
import type { LiveRunMeta } from '../../src/orchestrator/orchestrator.js';

const agents = { default: 'grok', available: ['grok', 'codex', 'claude', 'fake'] as const };

function baseView(over: Partial<RuntimeView> = {}): RuntimeView {
  return {
    snapshot: null,
    running: [],
    stopping: [],
    lastReport: null,
    activity: {},
    pendingChat: {},
    liveRuns: {},
    verificationRuns: {},
    agents: { default: agents.default, available: [...agents.available] },
    ...over,
  };
}

describe('serializeState — host run live meta', () => {
  it('exposes current host command index/name/timeout without output/secrets', () => {
    const live: LiveRunMeta = {
      taskId: 'HOST',
      sessionId: 'host-exec:HOST:1',
      lastEventAt: '2026-07-31T12:00:00.000Z',
      branchTip: null,
      runKind: 'implementer',
      activityLines: 2,
      processAlive: true,
      silenceMs: 100,
      runMs: 5000,
      maxRunMs: 7_200_000,
      aliveHint: 'host:1/2 systemctl restart hercules',
      procCpuPct: null,
      procRssMb: null,
      hostCommandIndex: 1,
      hostCommandTotal: 2,
      hostCommandName: 'systemctl restart hercules',
      hostCommandTimeoutMs: 1_800_000,
    };
    const dto = serializeState(
      baseView({
        running: ['HOST'],
        liveRuns: { HOST: live },
      }),
    );
    expect(dto.liveRuns['HOST']?.hostCommandIndex).toBe(1);
    expect(dto.liveRuns['HOST']?.hostCommandTotal).toBe(2);
    expect(dto.liveRuns['HOST']?.hostCommandName).toBe('systemctl restart hercules');
    expect(dto.liveRuns['HOST']?.hostCommandTimeoutMs).toBe(1_800_000);
    expect(dto.liveRuns['HOST']?.processAlive).toBe(true);
    expect(dto.liveRuns['HOST']?.runMs).toBe(5000);
    expect(dto.liveRuns['HOST']).not.toHaveProperty('stdout');
    expect(dto.liveRuns['HOST']).not.toHaveProperty('env');
    expect(JSON.stringify(dto.liveRuns['HOST'])).not.toMatch(/TOKEN|password|secret|sk-|xai-/i);
  });
});
