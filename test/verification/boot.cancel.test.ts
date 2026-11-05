import { describe, it, expect } from 'vitest';
import { CommandBootController } from '../../src/verification/boot.js';
import {
  isVerificationAborted,
  VerificationAbortedError,
} from '../../src/domain/verificationRun.js';

describe('CommandBootController cancel signal', () => {
  it('aborts health polling when signal fires mid-wait', async () => {
    const ac = new AbortController();
    let polls = 0;
    const boot = new CommandBootController({
      bootCommands: [],
      healthCommand: 'curl health',
      cwd: '/ws',
      signal: ac.signal,
      healthTimeoutMs: 30_000,
      healthIntervalMs: 10,
      clock: () => 0,
      exec: async () => {
        polls += 1;
        if (polls === 2) ac.abort();
        return { exitCode: 1, output: 'not ready' };
      },
      sleep: async () => undefined,
    });
    await expect(boot.waitHealthy()).rejects.toSatisfy((err: unknown) =>
      isVerificationAborted(err),
    );
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  it('tears down boot pids when signal aborts', async () => {
    const ac = new AbortController();
    const killed: number[] = [];
    const boot = new CommandBootController({
      bootCommands: ['server'],
      healthCommand: undefined,
      cwd: '/ws',
      signal: ac.signal,
      spawn: () => ({ pid: 5555, unref: () => undefined }),
      kill: (pid) => {
        killed.push(pid);
      },
    });
    await boot.boot();
    ac.abort();
    // Abort listener runs teardown asynchronously.
    await new Promise((r) => setTimeout(r, 20));
    expect(killed).toContain(5555);
    // Second teardown is idempotent.
    await boot.teardown();
    expect(killed.filter((p) => p === 5555).length).toBe(1);
  });

  it('boot throws when already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const boot = new CommandBootController({
      bootCommands: ['x'],
      healthCommand: undefined,
      cwd: '/ws',
      signal: ac.signal,
    });
    await expect(boot.boot()).rejects.toBeInstanceOf(VerificationAbortedError);
  });
});
