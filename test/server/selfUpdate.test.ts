/**
 * Self-update: pull latest code → install → build → restart service.
 * Injected runner so tests never touch real git/systemd.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SelfUpdateError,
  SelfUpdateService,
  type SelfUpdateRunner,
  type SelfUpdateRestart,
} from '../../src/server/selfUpdate.js';

function makeRunner(
  results: Record<string, { code?: number; stdout?: string; stderr?: string } | Error> = {},
): SelfUpdateRunner & { calls: { cmd: string; args: string[]; cwd: string }[] } {
  const calls: { cmd: string; args: string[]; cwd: string }[] = [];
  return {
    calls,
    async run(cmd, args, cwd) {
      calls.push({ cmd, args: [...args], cwd });
      const key = [cmd, ...args].join(' ');
      // Match by leading tokens so we don't need full arg equality.
      const hit = Object.entries(results).find(([k]) => key.startsWith(k) || key === k);
      if (hit?.[1] instanceof Error) throw hit[1];
      if (hit?.[1]) {
        return {
          code: hit[1].code ?? 0,
          stdout: hit[1].stdout ?? '',
          stderr: hit[1].stderr ?? '',
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

describe('SelfUpdateService', () => {
  let restart: SelfUpdateRestart & { calls: number };
  let clock: { now: number };

  beforeEach(() => {
    clock = { now: 1_700_000_000_000 };
    restart = {
      calls: 0,
      async restart() {
        restart.calls += 1;
      },
    };
  });

  it('starts idle and reports disabled when HERCULES_SELF_UPDATE=0', () => {
    const svc = new SelfUpdateService({
      repoRoot: '/repo',
      enabled: false,
      runner: makeRunner(),
      restarter: restart,
      clock: () => clock.now,
    });
    expect(svc.status().phase).toBe('idle');
    expect(svc.status().enabled).toBe(false);
    expect(() => svc.start()).toThrow(SelfUpdateError);
    expect(() => svc.start()).toThrow(/disabled/i);
  });

  it('rejects concurrent starts', async () => {
    let resolvePull: (() => void) | undefined;
    const pullGate = new Promise<void>((r) => {
      resolvePull = r;
    });
    const runner = makeRunner();
    runner.run = async (cmd, args, cwd) => {
      runner.calls.push({ cmd, args: [...args], cwd });
      if (cmd === 'git' && args[0] === 'pull') {
        await pullGate;
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    const svc = new SelfUpdateService({
      repoRoot: '/repo',
      runner,
      restarter: restart,
      clock: () => clock.now,
    });
    const first = svc.start();
    expect(first.phase).toBe('running');
    expect(() => svc.start()).toThrow(/already|in progress/i);
    resolvePull!();
    await svc.waitForIdle();
  });

  it('runs pull → install → build → restart in order', async () => {
    const runner = makeRunner();
    const svc = new SelfUpdateService({
      repoRoot: '/repo',
      serviceUnit: 'hercules',
      runner,
      restarter: restart,
      clock: () => clock.now,
    });
    svc.start();
    await svc.waitForIdle();
    const cmds = runner.calls.map((c) => [c.cmd, ...c.args].join(' '));
    expect(cmds[0]).toMatch(/^git pull --ff-only/);
    expect(cmds[1]).toMatch(/^pnpm install --frozen-lockfile/);
    expect(cmds[2]).toMatch(/^pnpm build$/);
    expect(restart.calls).toBe(1);
    expect(svc.status().phase).toBe('ok');
    expect(svc.status().message).toMatch(/restart/i);
  });

  it('stops on pull failure and does not restart', async () => {
    const runner = makeRunner({
      'git pull': { code: 1, stderr: 'not possible to fast-forward' },
    });
    const svc = new SelfUpdateService({
      repoRoot: '/repo',
      runner,
      restarter: restart,
      clock: () => clock.now,
    });
    svc.start();
    await svc.waitForIdle();
    expect(svc.status().phase).toBe('failed');
    expect(svc.status().message).toMatch(/pull|fast-forward/i);
    expect(restart.calls).toBe(0);
    // install/build never ran
    expect(runner.calls.some((c) => c.cmd === 'pnpm')).toBe(false);
  });

  it('stops on build failure and does not restart', async () => {
    const runner = makeRunner({
      'pnpm build': { code: 1, stderr: 'Type error' },
    });
    const svc = new SelfUpdateService({
      repoRoot: '/repo',
      runner,
      restarter: restart,
      clock: () => clock.now,
    });
    svc.start();
    await svc.waitForIdle();
    expect(svc.status().phase).toBe('failed');
    expect(svc.status().message).toMatch(/build/i);
    expect(restart.calls).toBe(0);
  });

  it('records restart failure', async () => {
    const runner = makeRunner();
    const badRestart: SelfUpdateRestart = {
      async restart() {
        throw new Error('systemctl denied');
      },
    };
    const svc = new SelfUpdateService({
      repoRoot: '/repo',
      runner,
      restarter: badRestart,
      clock: () => clock.now,
    });
    svc.start();
    await svc.waitForIdle();
    expect(svc.status().phase).toBe('failed');
    expect(svc.status().message).toMatch(/systemctl|restart/i);
  });

  it('serializes status with phase timestamps', () => {
    const svc = new SelfUpdateService({
      repoRoot: '/repo',
      runner: makeRunner(),
      restarter: restart,
      clock: () => clock.now,
    });
    const s = svc.status();
    expect(s).toMatchObject({
      phase: 'idle',
      enabled: true,
      startedAt: null,
      finishedAt: null,
      message: null,
      step: null,
    });
  });
});
