import { describe, it, expect, beforeEach } from 'vitest';
import {
  chromiumChildEnv,
  cleanupHerculesChromeResiduals,
  findHerculesChromeResidualPids,
  getActiveCdpPids,
  killProcessGroup,
  registerActiveCdpPid,
  unregisterActiveCdpPid,
} from '../../src/verification/cdp.js';
import { effectiveRepoExecutionPolicy } from '../../src/domain/repoExecutionPolicy.js';

describe('chromiumChildEnv', () => {
  it('filters the real browser child with the explicit repository allowlist', () => {
    const policy = effectiveRepoExecutionPolicy({ envAllowlist: ['PATH'] });
    const env = chromiumChildEnv(policy, {
      PATH: '/usr/bin',
      HOME: '/home/operator',
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://prod-secret',
      HERCULES_TOKEN: 'daemon-secret',
      OPENAI_API_KEY: 'cross-provider-secret',
      HTTP_PROXY: 'http://proxy-secret',
    });

    expect(env).toEqual({ PATH: '/usr/bin' });
    expect(JSON.stringify(env)).not.toMatch(
      /prod-secret|daemon-secret|cross-provider-secret|proxy-secret/,
    );
  });
});

describe('killProcessGroup', () => {
  it('sends TERM then KILL while alive; second full cleanup is idempotent', async () => {
    const signals: { pid: number; signal: string }[] = [];
    let alive = true;
    const logs: string[] = [];

    await killProcessGroup(4242, {
      graceMs: 0,
      sleep: async () => undefined,
      kill: (pid, signal) => {
        signals.push({ pid, signal });
      },
      isAlive: () => alive,
      log: (line) => logs.push(line),
    });

    // After first ladder, still "alive" → TERM + KILL both attempted
    expect(signals.some((s) => s.signal === 'SIGTERM')).toBe(true);
    expect(signals.some((s) => s.signal === 'SIGKILL')).toBe(true);
    expect(signals.every((s) => s.pid === -4242 || s.pid === 4242)).toBe(true);

    // Process dead — pure noop
    alive = false;
    const before = signals.length;
    await killProcessGroup(4242, {
      graceMs: 0,
      sleep: async () => undefined,
      kill: (pid, signal) => {
        signals.push({ pid, signal });
      },
      isAlive: () => alive,
      log: (line) => logs.push(line),
    });
    expect(signals.length).toBe(before);
    expect(logs.some((l) => /already dead|noop/i.test(l))).toBe(true);
  });
});

describe('cleanupHerculesChromeResiduals', () => {
  beforeEach(() => {
    // Clear any leaked registrations from prior tests.
    for (const pid of [...getActiveCdpPids()]) unregisterActiveCdpPid(pid);
  });

  it('kills residual pids and is idempotent on empty second pass', async () => {
    const killed: number[] = [];
    let pids = [111, 222];
    const result = await cleanupHerculesChromeResiduals({
      findPids: async () => pids,
      isAlive: (pid) => pids.includes(pid),
      kill: (pid) => {
        const abs = Math.abs(pid);
        killed.push(abs);
        pids = pids.filter((p) => p !== abs);
      },
      sleep: async () => undefined,
      log: () => undefined,
    });
    expect(result.cleaned).toEqual(expect.arrayContaining([111, 222]));
    expect(killed.length).toBeGreaterThan(0);

    // Second pass: nothing left
    const second = await cleanupHerculesChromeResiduals({
      findPids: async () => [],
      isAlive: () => false,
      kill: () => {
        throw new Error('should not kill');
      },
      sleep: async () => undefined,
      log: () => undefined,
    });
    expect(second.cleaned).toEqual([]);
  });

  it('never reports active registered CDP pids as residuals', async () => {
    registerActiveCdpPid(777);
    registerActiveCdpPid(888);
    const ages = new Map<number, number>([
      [777, 60 * 60 * 1000],
      [888, 60 * 60 * 1000],
      [999, 60 * 60 * 1000],
    ]);
    const residuals = await findHerculesChromeResidualPids({
      candidatePids: [777, 888, 999],
      excludePids: getActiveCdpPids(),
      minAgeMs: 1_000,
      getAgeMs: async (pid) => ages.get(pid) ?? null,
    });
    expect(getActiveCdpPids().has(777)).toBe(true);
    expect(getActiveCdpPids().has(888)).toBe(true);
    expect(residuals).toEqual([999]);
    expect(residuals).not.toContain(777);
    expect(residuals).not.toContain(888);

    const cleaned = await cleanupHerculesChromeResiduals({
      findPids: async () => [999],
      isAlive: () => true,
      kill: () => undefined,
      sleep: async () => undefined,
      log: () => undefined,
    });
    expect(cleaned.cleaned).toContain(999);

    unregisterActiveCdpPid(777);
    unregisterActiveCdpPid(888);
  });

  it('skips young processes and unknown-age pids (concurrent / peer safety)', async () => {
    const ages = new Map<number, number | null>([
      [1001, 500], // 0.5s — young concurrent session
      [1002, 10 * 60 * 1000], // 10m — stale residual
      [1003, null], // unknown age — never kill
    ]);
    const residuals = await findHerculesChromeResidualPids({
      candidatePids: [1001, 1002, 1003],
      excludePids: new Set(),
      minAgeMs: 60_000,
      getAgeMs: async (pid) => ages.get(pid) ?? null,
    });
    expect(residuals).toEqual([1002]);
  });
});
