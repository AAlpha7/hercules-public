import { describe, it, expect, vi } from 'vitest';
import {
  isProcessGroupAlive,
  killProcessGroup,
} from '../../src/verification/processGroup.js';
import { createVerificationCancelReason } from '../../src/domain/verificationRun.js';

describe('killProcessGroup (shared)', () => {
  it('probes the process group before the leader pid', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === -4242) return true;
      throw new Error(`unexpected pid ${pid}`);
    });
    try {
      expect(isProcessGroupAlive(4242)).toBe(true);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith(-4242, 0);
    } finally {
      kill.mockRestore();
    }
  });

  it('falls back to the leader probe when no detached group exists', () => {
    const seen: number[] = [];
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      seen.push(pid);
      if (pid < 0) throw new Error('no group');
      return true;
    });
    try {
      expect(isProcessGroupAlive(3131)).toBe(true);
      expect(seen).toEqual([-3131, 3131]);
    } finally {
      kill.mockRestore();
    }
  });

  it('graceful path sends TERM then KILL', async () => {
    const signals: string[] = [];
    let alive = true;
    const logs: string[] = [];
    await killProcessGroup(4242, {
      graceMs: 0,
      sleep: async () => undefined,
      kill: (_pid, signal) => {
        signals.push(signal);
      },
      isAlive: () => {
        // Die after first signal so ladder can complete.
        const was = alive;
        if (signals.length >= 1) alive = false;
        return was;
      },
      log: (line) => logs.push(line),
      label: 'gate process-group',
    });
    expect(signals[0]).toBe('SIGTERM');
    expect(logs.some((l) => /chrome cleanup/i.test(l))).toBe(false);
    expect(logs.some((l) => /gate process-group/i.test(l))).toBe(true);
  });

  it('force path skips TERM and SIGKILLs immediately', async () => {
    const signals: string[] = [];
    let alive = true;
    let slept = 0;
    await killProcessGroup(9001, {
      force: true,
      graceMs: 5_000, // would hang if force still waited full grace
      sleep: async (ms) => {
        slept += ms;
      },
      kill: (_pid, signal) => {
        signals.push(signal);
        alive = false;
      },
      isAlive: () => alive,
      log: () => undefined,
      label: 'gate process-group',
    });
    expect(signals).toEqual(['SIGKILL']);
    expect(signals).not.toContain('SIGTERM');
    expect(slept).toBe(0);
  });

  it('mutable cancelReason.force escalates mid-grace wait', async () => {
    const signals: string[] = [];
    const reason = createVerificationCancelReason(false);
    let alive = true;
    let sleepCount = 0;
    const run = killProcessGroup(7001, {
      graceMs: 10_000,
      cancelReason: reason,
      sleep: async () => {
        sleepCount += 1;
        // After first grace slice, flip force so wait aborts and KILL fires.
        if (sleepCount === 1) reason.force = true;
      },
      kill: (_pid, signal) => {
        signals.push(signal);
        if (signal === 'SIGKILL') alive = false;
      },
      isAlive: () => alive,
      log: () => undefined,
      label: 'process-group',
    });
    await run;
    expect(signals[0]).toBe('SIGTERM');
    expect(signals).toContain('SIGKILL');
  });
});
