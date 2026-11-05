import { describe, it, expect } from 'vitest';
import { CommandBootController, type CommandBootOptions } from '../../src/verification/boot.js';
import type { CommandRunner } from '../../src/verification/gates.js';
import { effectiveRepoExecutionPolicy } from '../../src/domain/repoExecutionPolicy.js';

function deps(over: Partial<CommandBootOptions> = {}) {
  const spawned: { cmd: string; cwd: string }[] = [];
  const spawnedEnv: (NodeJS.ProcessEnv | undefined)[] = [];
  const killed: number[] = [];
  let pid = 1000;
  return {
    spawned,
    spawnedEnv,
    killed,
    base: {
      bootCommands: ['pnpm dev --port 4100'],
      healthCommand: 'curl -sf localhost:4100/health',
      cwd: '/ws/T-1',
      spawn: (cmd: string, args: readonly string[], o: { cwd: string; env?: NodeJS.ProcessEnv }) => {
        spawned.push({ cmd: args[1] ?? cmd, cwd: o.cwd });
        spawnedEnv.push(o.env);
        return { pid: ++pid, unref(): void {} };
      },
      kill: (p: number) => killed.push(p),
      sleep: async (): Promise<void> => {},
      clock: (() => {
        let t = 0;
        return () => (t += 100);
      })(),
      healthTimeoutMs: 5000,
      healthIntervalMs: 100,
      ...over,
    },
  };
}

describe('CommandBootController', () => {
  it('spawns each boot command detached in the worktree', async () => {
    const d = deps();
    const boot = new CommandBootController(d.base);
    await boot.boot();
    expect(d.spawned).toEqual([{ cmd: 'pnpm dev --port 4100', cwd: '/ws/T-1' }]);
  });

  it('scrubs inherited HERCULES_* env from the app under test', async () => {
    // Live incident 2026-07-15/17: the booted instance inherited the daemon's
    // HERCULES_WORK_DIR and reclaimOrphans'd the PRODUCTION work root, deleting
    // every live worktree. The instance under test gets a clean env; WORKFLOW
    // sets its own vars inline in the boot command.
    const saved = { ...process.env };
    process.env['HERCULES_WORK_DIR'] = '/home/live/work';
    process.env['HERCULES_TOKEN'] = 'live-secret';
    try {
      const d = deps();
      const boot = new CommandBootController(d.base);
      await boot.boot();
      const env = d.spawnedEnv[0];
      expect(env).toBeDefined();
      expect(env!['HERCULES_WORK_DIR']).toBeUndefined();
      expect(env!['HERCULES_TOKEN']).toBeUndefined();
      expect(env!['PATH']).toBe(process.env['PATH']);
    } finally {
      process.env = saved;
    }
  });

  it('honors an explicit repo env allowlist for the boot child (no widening)', async () => {
    const saved = { ...process.env };
    process.env['NODE_ENV'] = 'production';
    process.env['DATABASE_URL'] = 'postgres://secret';
    try {
      const d = deps({
        executionPolicy: effectiveRepoExecutionPolicy({ envAllowlist: ['PATH'] }),
      });
      const boot = new CommandBootController(d.base);
      await boot.boot();
      const env = d.spawnedEnv[0];
      expect(env).toBeDefined();
      expect(env!['PATH']).toBe(process.env['PATH']);
      // Explicit allowlist is authoritative — no NODE_* prefix widening.
      expect(env!['NODE_ENV']).toBeUndefined();
      expect(env!['DATABASE_URL']).toBeUndefined();
    } finally {
      process.env = saved;
    }
  });

  it('forwards the repo policy into health-check exec children', async () => {
    const policy = effectiveRepoExecutionPolicy({ envAllowlist: ['PATH'] });
    const seenPolicies: unknown[] = [];
    const exec: CommandRunner = async (_c, _cwd, opts) => {
      seenPolicies.push(opts?.executionPolicy);
      return { exitCode: 0, output: '' };
    };
    const boot = new CommandBootController(deps({ exec, executionPolicy: policy }).base);
    expect(await boot.waitHealthy()).toBe(true);
    expect(seenPolicies).toEqual([policy]);
  });

  it('waitHealthy polls the health command until it succeeds', async () => {
    let calls = 0;
    const exec: CommandRunner = async () => ({ exitCode: calls++ < 2 ? 1 : 0, output: '' });
    const boot = new CommandBootController(deps({ exec }).base);
    expect(await boot.waitHealthy()).toBe(true);
    expect(calls).toBe(3);
  });

  it('waitHealthy returns false on timeout', async () => {
    const exec: CommandRunner = async () => ({ exitCode: 1, output: '' });
    const boot = new CommandBootController(deps({ exec, healthTimeoutMs: 300 }).base);
    expect(await boot.waitHealthy()).toBe(false);
  });

  it('waitHealthy is true immediately when no health command is set', async () => {
    const boot = new CommandBootController(deps({ healthCommand: undefined }).base);
    expect(await boot.waitHealthy()).toBe(true);
  });

  it('teardown kills the spawned process groups', async () => {
    const d = deps();
    const boot = new CommandBootController(d.base);
    await boot.boot();
    await boot.teardown();
    expect(d.killed).toHaveLength(1); // one boot process killed
  });
});
