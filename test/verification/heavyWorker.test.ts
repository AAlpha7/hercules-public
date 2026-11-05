/**
 * Verification tests — RemoteHeavyRunner + FakeHeavyTransport (SPEC §11 spike).
 *
 * Additive BehavioralRunner for L2 on one optional remote host. No multi-node
 * mesh; does not take the local heavy permit.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeHeavyTransport,
  RemoteHeavyRunner,
  type HeavyWorkerTransport,
  type RemoteHeavyDeps,
  type HeavyJobExecResult,
} from '../../src/verification/heavyWorker.js';
import type { HeavyJobRequest, HeavyRemoteEndpoint } from '../../src/domain/heavyWorker.js';
import { IdentifierError } from '../../src/domain/task.js';
import { Semaphore } from '../../src/orchestrator/semaphore.js';

const endpoint: HeavyRemoteEndpoint = {
  host: 'heavy.example',
  user: 'ubuntu',
  sshPort: 22,
  remoteRoot: '/var/hercules-heavy',
};

function baseInput(cwd: string) {
  return {
    taskId: 'T-heavy-1',
    baseUrl: 'http://127.0.0.1:4100',
    bootCommands: ['pnpm start'],
    healthCommand: 'curl -sf http://127.0.0.1:4100/',
    captures: 2,
    cwd,
  };
}

/** Compile-time: RemoteHeavyDeps must not carry a local heavy permit. */
type AssertNoLocalPermit = 'permit' extends keyof RemoteHeavyDeps ? never : true;
const _noPermitOnDeps: AssertNoLocalPermit = true;
void _noPermitOnDeps;

describe('FakeHeavyTransport', () => {
  it('records protocol calls in order and returns canned exec results', async () => {
    const localShots = await mkdtemp(join(tmpdir(), 'hercules-fake-down-'));
    try {
      const transport = new FakeHeavyTransport({
        execResult: {
          healthy: true,
          screenshotBasenames: ['shell.png', 'settings.png'],
        },
      });
      const req: HeavyJobRequest = {
        taskId: 'T-1',
        baseUrl: 'http://127.0.0.1:4100',
        bootCommands: ['boot'],
        healthCommand: undefined,
        captures: 2,
      };
      await transport.syncUp('/ws/T-1', '/var/hercules-heavy/T-1');
      const exec = await transport.execJob('/var/hercules-heavy/T-1', req);
      const down = await transport.syncDown(
        '/var/hercules-heavy/T-1',
        join(localShots, 'T-1'),
      );
      await transport.cleanup('/var/hercules-heavy/T-1');

      expect(exec.healthy).toBe(true);
      expect(down).toEqual(['shell.png', 'settings.png']);
      expect(transport.calls.map((c) => c.op)).toEqual([
        'syncUp',
        'execJob',
        'syncDown',
        'cleanup',
      ]);
    } finally {
      await rm(localShots, { recursive: true, force: true });
    }
  });
});

describe('RemoteHeavyRunner', () => {
  let shotsRoot: string;
  let workspace: string;

  beforeEach(async () => {
    shotsRoot = await mkdtemp(join(tmpdir(), 'hercules-remote-shots-'));
    workspace = await mkdtemp(join(tmpdir(), 'hercules-remote-ws-'));
    await writeFile(join(workspace, 'README.md'), 'spike\n', 'utf8');
  });

  afterEach(async () => {
    await rm(shotsRoot, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  it('runs syncUp → execJob → syncDown → cleanup and returns remote screenshots', async () => {
    const transport = new FakeHeavyTransport({
      execResult: { healthy: true, screenshotBasenames: ['shell.png'] },
    });
    const runner = new RemoteHeavyRunner({
      endpoint,
      transport,
      screenshotsRoot: shotsRoot,
    });

    const result = await runner.run(baseInput(workspace));

    expect(result.healthy).toBe(true);
    expect(result.screenshots).toEqual(['shell.png']);
    expect(transport.calls.map((c) => c.op)).toEqual([
      'syncUp',
      'execJob',
      'syncDown',
      'cleanup',
    ]);
    // Screenshots land under the daemon screenshots root for the packet API.
    const written = await readFile(join(shotsRoot, 'T-heavy-1', 'shell.png'));
    expect(written.byteLength).toBeGreaterThan(0);
  });

  it('does not use a local heavy Semaphore (free-tier win)', async () => {
    const localPermit = new Semaphore(1);
    let acquired = false;
    const original = localPermit.acquire.bind(localPermit);
    localPermit.acquire = async () => {
      acquired = true;
      return original();
    };

    const transport = new FakeHeavyTransport({
      execResult: { healthy: true, screenshotBasenames: ['a.png'] },
    });
    // Constructor intentionally has no permit field — unlike LiveBehavioralRunner.
    const deps: RemoteHeavyDeps = {
      endpoint,
      transport,
      screenshotsRoot: shotsRoot,
    };
    expect(Object.prototype.hasOwnProperty.call(deps, 'permit')).toBe(false);

    const runner = new RemoteHeavyRunner(deps);
    await runner.run(baseInput(workspace));

    // Even if a caller holds a local semaphore, RemoteHeavyRunner never touches it.
    expect(acquired).toBe(false);
    const release = await localPermit.acquire();
    release();
  });

  it('maps transport failures to healthy:false + error string (no silent swallow)', async () => {
    const transport = new FakeHeavyTransport({
      failOn: 'syncUp',
      failMessage: 'rsync: connection refused',
    });
    const runner = new RemoteHeavyRunner({
      endpoint,
      transport,
      screenshotsRoot: shotsRoot,
    });

    const result = await runner.run(baseInput(workspace));

    expect(result.healthy).toBe(false);
    expect(result.screenshots).toEqual([]);
    expect(result.error).toMatch(/connection refused/);
    // Cleanup still attempted after failure.
    expect(transport.calls.map((c) => c.op)).toContain('cleanup');
  });

  it('maps execJob failure to healthy:false with remote error string', async () => {
    const transport = new FakeHeavyTransport({
      execResult: {
        healthy: false,
        screenshotBasenames: [],
        error: 'remote boot timed out',
      },
    });
    const runner = new RemoteHeavyRunner({
      endpoint,
      transport,
      screenshotsRoot: shotsRoot,
    });

    const result = await runner.run(baseInput(workspace));
    expect(result.healthy).toBe(false);
    expect(result.error).toMatch(/remote boot timed out/);
    expect(transport.calls.map((c) => c.op)).toEqual([
      'syncUp',
      'execJob',
      'syncDown',
      'cleanup',
    ]);
  });

  it('surfaces syncDown throws as unhealthy with error (still cleans up)', async () => {
    const transport = new FakeHeavyTransport({
      execResult: { healthy: true, screenshotBasenames: ['x.png'] },
      failOn: 'syncDown',
      failMessage: 'scp: no such file',
    });
    const runner = new RemoteHeavyRunner({
      endpoint,
      transport,
      screenshotsRoot: shotsRoot,
    });

    const result = await runner.run(baseInput(workspace));
    expect(result.healthy).toBe(false);
    expect(result.error).toMatch(/scp: no such file/);
    expect(transport.calls.at(-1)?.op).toBe('cleanup');
  });

  it('keeps a healthy job result when cleanup fails (best-effort, not silent)', async () => {
    const logs: string[] = [];
    const transport = new FakeHeavyTransport({
      execResult: { healthy: true, screenshotBasenames: ['ok.png'] },
      failOn: 'cleanup',
      failMessage: 'rm: device busy',
    });
    const runner = new RemoteHeavyRunner({
      endpoint,
      transport,
      screenshotsRoot: shotsRoot,
      logError: (msg) => {
        logs.push(msg);
      },
    });

    const result = await runner.run(baseInput(workspace));
    expect(result.healthy).toBe(true);
    expect(result.screenshots).toEqual(['ok.png']);
    expect(logs.some((l) => /cleanup failed/i.test(l) && /device busy/.test(l))).toBe(
      true,
    );
  });

  it('rejects unsafe task ids with IdentifierError (not unhealthy L2)', async () => {
    const transport = new FakeHeavyTransport();
    const runner = new RemoteHeavyRunner({
      endpoint,
      transport,
      screenshotsRoot: shotsRoot,
    });

    await expect(
      runner.run({ ...baseInput(workspace), taskId: '../escape' }),
    ).rejects.toBeInstanceOf(IdentifierError);
    expect(transport.calls).toEqual([]);
  });

  it('passes job request fields through to remote exec', async () => {
    const transport = new FakeHeavyTransport({
      execResult: { healthy: true, screenshotBasenames: [] },
    });
    const runner = new RemoteHeavyRunner({
      endpoint,
      transport,
      screenshotsRoot: shotsRoot,
    });

    await runner.run({
      ...baseInput(workspace),
      taskId: 'job-fields',
      localStorage: { hercules_token: 'tok' },
      mobile: true,
      taskBody: '## Evidence\n- unlock\n',
    });

    const exec = transport.calls.find((c) => c.op === 'execJob');
    expect(exec?.op).toBe('execJob');
    if (exec?.op !== 'execJob') throw new Error('expected execJob call');
    expect(exec.request.taskId).toBe('job-fields');
    expect(exec.request.localStorage).toEqual({ hercules_token: 'tok' });
    expect(exec.request.mobile).toBe(true);
    expect(exec.request.taskBody).toContain('## Evidence');
    expect(exec.remoteJobDir).toBe('/var/hercules-heavy/job-fields');
  });
});

describe('HeavyWorkerTransport contract (hand-rolled stub)', () => {
  it('is implementable without SSH for unit tests', async () => {
    const order: string[] = [];
    const stub: HeavyWorkerTransport = {
      async syncUp(local, remote) {
        order.push(`up:${local}->${remote}`);
      },
      async execJob(remote, request): Promise<HeavyJobExecResult> {
        order.push(`exec:${remote}:${request.taskId}`);
        return { healthy: true, screenshotBasenames: ['s.png'] };
      },
      async syncDown(remote, local) {
        order.push(`down:${remote}->${local}`);
        await mkdir(local, { recursive: true });
        await writeFile(join(local, 's.png'), 'png', 'utf8');
        return ['s.png'];
      },
      async cleanup(remote) {
        order.push(`clean:${remote}`);
      },
    };
    const root = await mkdtemp(join(tmpdir(), 'hercules-stub-shots-'));
    try {
      const runner = new RemoteHeavyRunner({
        endpoint: { ...endpoint, remoteRoot: '/r' },
        transport: stub,
        screenshotsRoot: root,
      });
      const result = await runner.run(baseInput('/ws'));
      expect(result.healthy).toBe(true);
      expect(order).toEqual([
        'up:/ws->/r/T-heavy-1',
        'exec:/r/T-heavy-1:T-heavy-1',
        `down:/r/T-heavy-1->${join(root, 'T-heavy-1')}`,
        'clean:/r/T-heavy-1',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
