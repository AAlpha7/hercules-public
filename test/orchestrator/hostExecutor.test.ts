import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HostExecutorAdapter,
  HostExecutorRun,
  startHostExecution,
  type HostSpawnFn,
} from '../../src/orchestrator/hostExecutor.js';
import { parseHostOperationReceipt } from '../../src/domain/executionClass.js';
import type { AgentStartInput } from '../../src/orchestrator/adapter.js';
import type { AllocationContext } from '../../src/domain/allocation.js';

const alloc: AllocationContext = {
  slug: 'host-test',
  port: 4100,
  scratchDir: '/tmp/host-test-scratch',
};

function input(over: Partial<AgentStartInput> & Pick<AgentStartInput, 'workspace' | 'hostCommandScope'>): AgentStartInput {
  return {
    taskId: 'HOST',
    prompt: 'host op',
    allocation: alloc,
    executionClass: 'host_operation',
    ...over,
  };
}

async function withWorkspace<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'hercules-host-exec-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function settle(run: HostExecutorRun, timeoutMs = 15_000): Promise<void> {
  await Promise.race([
    run.whenSettled(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('host executor settle timeout')), timeoutMs),
    ),
  ]);
}

describe('HostExecutor — sequential once, no LLM', () => {
  it('runs two approved commands exactly once in order', async () => {
    await withWorkspace(async (dir) => {
      // Write a tiny marker script via sequential shell-free commands: use /bin/sh
      // is rejected by scope validation — use true/printf via absolute paths that
      // pass the alphabet. `touch` + `echo` via coreutils.
      const marker = join(dir, 'a.txt');
      const marker2 = join(dir, 'b.txt');
      // Use /usr/bin/touch and /usr/bin/bash is banned — use `touch` from PATH.
      // validateHostCommandScope allows letters and /._:=,@%+-
      const scope = [
        `touch ${marker}`,
        `touch ${marker2}`,
      ];
      const run = startHostExecution(
        input({ workspace: dir, hostCommandScope: scope }),
        Date.now(),
        { commandTimeoutMs: 60_000 },
      );
      run.begin();
      await settle(run);
      const snap = run.poll(Date.now());
      expect(snap.status).toBe('done');
      expect(snap.exitCode).toBe(0);
      const receipt = parseHostOperationReceipt(run.finalMessage());
      expect(receipt?.outcome).toBe('success');
      expect(receipt?.commandScope).toEqual(scope);
      // Exactly one start line per command.
      const starts = run.activityLog().filter((l) => l.includes('] start '));
      expect(starts).toHaveLength(2);
      expect(starts[0]).toContain('1/2');
      expect(starts[1]).toContain('2/2');
      const { access } = await import('node:fs/promises');
      await access(marker);
      await access(marker2);
    });
  });

  it('stops after non-zero exit and does not run later commands', async () => {
    await withWorkspace(async (dir) => {
      const later = join(dir, 'should-not-exist');
      const scope = ['false', `touch ${later}`];
      const run = startHostExecution(
        input({ workspace: dir, hostCommandScope: scope }),
        Date.now(),
        { commandTimeoutMs: 60_000 },
      );
      run.begin();
      await settle(run);
      expect(run.poll(Date.now()).status).toBe('failed');
      const receipt = parseHostOperationReceipt(run.finalMessage());
      expect(receipt?.outcome).toBe('failed');
      expect(receipt?.commandScope).toEqual(scope);
      const starts = run.activityLog().filter((l) => l.includes('] start '));
      expect(starts).toHaveLength(1);
      await expect(
        import('node:fs/promises').then((fs) => fs.access(later)),
      ).rejects.toThrow();
    });
  });

  it('timeout kills the process group and skips later commands', async () => {
    await withWorkspace(async (dir) => {
      const later = join(dir, 'after-timeout');
      const scope = ['sleep 30', `touch ${later}`];
      const run = startHostExecution(
        input({ workspace: dir, hostCommandScope: scope }),
        Date.now(),
        { commandTimeoutMs: 200, allowShortTimeout: true },
      );
      run.begin();
      await settle(run);
      expect(run.poll(Date.now()).status).toBe('failed');
      const receipt = parseHostOperationReceipt(run.finalMessage());
      expect(receipt?.outcome).toBe('failed');
      expect(receipt?.postCheckEvidence.toLowerCase()).toMatch(/timeout|fail|stopped/);
      const starts = run.activityLog().filter((l) => l.includes('] start '));
      expect(starts).toHaveLength(1);
      await expect(
        import('node:fs/promises').then((fs) => fs.access(later)),
      ).rejects.toThrow();
    });
  });

  it('cancel stops the process group and does not run later commands', async () => {
    await withWorkspace(async (dir) => {
      const later = join(dir, 'after-cancel');
      const scope = ['sleep 60', `touch ${later}`];
      const run = startHostExecution(
        input({ workspace: dir, hostCommandScope: scope }),
        Date.now(),
        { commandTimeoutMs: 120_000 },
      );
      run.begin();
      // Give sleep a moment to spawn.
      await new Promise((r) => setTimeout(r, 100));
      expect(run.poll(Date.now()).processAlive).toBe(true);
      run.stop({ force: true });
      await settle(run);
      const snap = run.poll(Date.now());
      expect(snap.status).toBe('failed');
      const receipt = parseHostOperationReceipt(run.finalMessage());
      expect(receipt?.outcome).toBe('failed');
      expect(receipt?.postCheckEvidence.toLowerCase()).toMatch(/cancel|signal|fail/i);
      const starts = run.activityLog().filter((l) => l.includes('] start '));
      expect(starts).toHaveLength(1);
      await expect(
        import('node:fs/promises').then((fs) => fs.access(later)),
      ).rejects.toThrow();
    });
  });

  it('redacts secret-like output in receipt evidence', async () => {
    await withWorkspace(async (dir) => {
      const { writeFile } = await import('node:fs/promises');
      const secretFile = join(dir, 'out.txt');
      await writeFile(secretFile, 'Bearer sk-live-secret-abcdef12\nHERCULES_TOKEN=supersecret\n');
      const scope = [`cat ${secretFile}`];
      const run = startHostExecution(
        input({ workspace: dir, hostCommandScope: scope }),
        Date.now(),
        { commandTimeoutMs: 60_000 },
      );
      run.begin();
      await settle(run);
      const msg = run.finalMessage();
      expect(msg).not.toContain('sk-live-secret-abcdef12');
      expect(msg).not.toContain('supersecret');
      expect(msg).toMatch(/REDACTED/i);
    });
  });

  it('liveMeta exposes current command without output/secrets', async () => {
    await withWorkspace(async (dir) => {
      const scope = ['sleep 60'];
      const run = startHostExecution(
        input({ workspace: dir, hostCommandScope: scope }),
        1000,
        { commandTimeoutMs: 120_000, clock: () => Date.now() },
      );
      run.begin();
      await new Promise((r) => setTimeout(r, 80));
      const meta = run.liveMeta(Date.now());
      expect(meta.taskId).toBe('HOST');
      expect(meta.commandTotal).toBe(1);
      expect(meta.commandName).toBe('sleep 60');
      expect(meta.processAlive).toBe(true);
      expect(meta.timeoutMs).toBeGreaterThanOrEqual(60_000);
      expect(meta).not.toHaveProperty('stdout');
      expect(meta).not.toHaveProperty('env');
      run.stop({ force: true });
      await settle(run);
    });
  });

  it('HostExecutorAdapter.start returns a run that does not use LLM adapters', () => {
    const adapter = new HostExecutorAdapter({ commandTimeoutMs: 60_000 });
    expect(adapter.name).toBe('host-executor');
    const run = adapter.start(
      input({
        workspace: '/tmp',
        hostCommandScope: ['true'],
      }),
      0,
    );
    expect(run.sessionId.startsWith('host-exec:')).toBe(true);
    // begin not called — no process yet
    expect(run.poll(0).status).toBe('running');
    run.stop({ force: true });
  });

  it('spawn-capture: hostile injection/credential vars never reach the host child', async () => {
    await withWorkspace(async (dir) => {
      const { spawn: realSpawn } = await import('node:child_process');
      const { hostChildEnv } = await import('../../src/adapters/env.js');
      const hostile: NodeJS.ProcessEnv = {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: process.env['HOME'] ?? '/tmp',
        USER: process.env['USER'] ?? 'ubuntu',
        LOGNAME: process.env['LOGNAME'] ?? 'ubuntu',
        SHELL: process.env['SHELL'] ?? '/bin/bash',
        LANG: 'C.UTF-8',
        TZ: 'UTC',
        TERM: 'xterm',
        TMPDIR: process.env['TMPDIR'] ?? '/tmp',
        JAVA_HOME: '/usr/lib/jvm/default',
        // Hostile / credential injection set (must all be absent in child).
        NODE_OPTIONS: '--require /tmp/evil.js',
        NPM_TOKEN: 'npm-secret-token',
        NODE_AUTH_TOKEN: 'node-auth-secret',
        npm_config__auth: 'npm-auth-secret',
        'npm_config_//registry.npmjs.org/:_authToken': 'registry-token',
        DATABASE_URL: 'postgres://user:pass@prod/db',
        XAI_API_KEY: 'xai-should-not-leak',
        GITHUB_TOKEN: 'ghp-should-not-leak',
        BASH_ENV: '/tmp/evil.bashrc',
        ENV: '/tmp/evil.profile',
        LD_PRELOAD: '/tmp/evil.so',
        LD_LIBRARY_PATH: '/tmp/evil-lib',
        DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
        HTTPS_PROXY: 'http://user:pass@proxy.example:8080',
        HTTP_PROXY: 'http://user:pass@proxy.example:8080',
        https_proxy: 'http://user:pass@proxy.example:8080',
        OPENAI_API_KEY: 'sk-should-not-leak',
        HERCULES_TOKEN: 'daemon-token',
      };
      const expectedAbsent = [
        'NODE_OPTIONS',
        'NPM_TOKEN',
        'NODE_AUTH_TOKEN',
        'npm_config__auth',
        'npm_config_//registry.npmjs.org/:_authToken',
        'DATABASE_URL',
        'XAI_API_KEY',
        'GITHUB_TOKEN',
        'BASH_ENV',
        'ENV',
        'LD_PRELOAD',
        'LD_LIBRARY_PATH',
        'DYLD_INSERT_LIBRARIES',
        'HTTPS_PROXY',
        'HTTP_PROXY',
        'https_proxy',
        'OPENAI_API_KEY',
        'HERCULES_TOKEN',
      ];
      const expectedPresent = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TZ', 'TERM', 'TMPDIR', 'JAVA_HOME'];

      // Unit gate: allowlist itself drops hostile names.
      const filtered = hostChildEnv(hostile);
      for (const k of expectedAbsent) {
        expect(filtered[k], `${k} must be filtered by hostChildEnv`).toBeUndefined();
      }
      for (const k of expectedPresent) {
        expect(filtered[k], `${k} must remain`).toBe(hostile[k]);
      }

      // Spawn-capture: prove the env object passed to the child matches.
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const capturingSpawn: HostSpawnFn = (command, args, options) => {
        capturedEnv = { ...options.env };
        return realSpawn(command, [...args], {
          cwd: options.cwd,
          env: options.env,
          detached: options.detached,
          stdio: options.stdio,
        }) as ReturnType<HostSpawnFn>;
      };

      // Default path (no opts.env) must also scrub process.env pollution.
      const prev: Record<string, string | undefined> = {};
      for (const k of expectedAbsent) {
        prev[k] = process.env[k];
        process.env[k] = hostile[k];
      }
      try {
        const runDefault = startHostExecution(
          input({ workspace: dir, hostCommandScope: ['true'] }),
          Date.now(),
          { commandTimeoutMs: 60_000, spawn: capturingSpawn },
        );
        runDefault.begin();
        await settle(runDefault);
        expect(capturedEnv).toBeDefined();
        for (const k of expectedAbsent) {
          expect(capturedEnv![k], `default host child must not inherit ${k}`).toBeUndefined();
        }
        expect(capturedEnv!['PATH']).toBeTruthy();
        expect(capturedEnv!['HERCULES_TASK_ID']).toBe('HOST');
        expect(capturedEnv!['HERCULES_SLUG']).toBe('host-test');
      } finally {
        for (const [k, v] of Object.entries(prev)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }

      // Explicit filtered env path (real child runs clean).
      capturedEnv = undefined;
      const run = startHostExecution(
        input({ workspace: dir, hostCommandScope: ['true'] }),
        Date.now(),
        { commandTimeoutMs: 60_000, env: filtered, spawn: capturingSpawn },
      );
      run.begin();
      await settle(run);
      expect(capturedEnv).toBeDefined();
      for (const k of expectedAbsent) {
        expect(capturedEnv![k], `captured child env must not contain ${k}`).toBeUndefined();
      }
      for (const k of expectedPresent) {
        expect(capturedEnv![k]).toBe(hostile[k]);
      }
      expect(capturedEnv!['HERCULES_TASK_ID']).toBe('HOST');
      expect(capturedEnv!['HERCULES_SLUG']).toBe('host-test');
      expect(parseHostOperationReceipt(run.finalMessage())?.outcome).toBe('success');
    });
  });

  it('begin is idempotent and cancel-before-begin never spawns', async () => {
    await withWorkspace(async (dir) => {
      const { spawn: realSpawn } = await import('node:child_process');
      const later = join(dir, 'should-not-spawn');
      let spawnCount = 0;
      const countingSpawn: HostSpawnFn = (command, args, options) => {
        spawnCount += 1;
        // HostSpawnFn is a narrow contract; Node's spawn overloads are wider.
        return realSpawn(command, [...args], {
          cwd: options.cwd,
          env: options.env,
          detached: options.detached,
          stdio: options.stdio,
        }) as ReturnType<HostSpawnFn>;
      };

      // Cancel/stop before begin: never spawns, even with double begin.
      {
        spawnCount = 0;
        const run = startHostExecution(
          input({ workspace: dir, hostCommandScope: [`touch ${later}`] }),
          Date.now(),
          { commandTimeoutMs: 60_000, spawn: countingSpawn },
        );
        run.stop({ force: true }); // cancel before begin
        run.begin();
        run.begin(); // double begin after pre-begin stop
        await settle(run);
        expect(spawnCount).toBe(0);
        expect(run.poll(Date.now()).status).toBe('failed');
        const receipt = parseHostOperationReceipt(run.finalMessage());
        expect(receipt).not.toBeNull();
        expect(receipt!.outcome).not.toBe('success');
        await expect(
          import('node:fs/promises').then((fs) => fs.access(later)),
        ).rejects.toThrow();
      }

      // Double begin after start: at most one spawn chain for a single command.
      {
        spawnCount = 0;
        const marker = join(dir, 'once.txt');
        const run = startHostExecution(
          input({ workspace: dir, hostCommandScope: [`touch ${marker}`] }),
          Date.now(),
          { commandTimeoutMs: 60_000, spawn: countingSpawn },
        );
        run.begin();
        run.begin(); // idempotent — must not spawn a second chain
        await settle(run);
        expect(spawnCount).toBe(1);
        expect(run.poll(Date.now()).status).toBe('done');
        expect(parseHostOperationReceipt(run.finalMessage())?.outcome).toBe('success');
      }
    });
  });

  it('emits one complete canonical receipt for exit/timeout/cancel/signal/spawn_error', async () => {
    await withWorkspace(async (dir) => {
      const assertOneReceipt = (msg: string): void => {
        expect(msg.match(/## Host operation receipt/g)).toHaveLength(1);
        expect(msg).toContain('## Self-assessment');
        expect(parseHostOperationReceipt(msg)).not.toBeNull();
        // Full narrative+receipt must not be replaced by a short generic fail line.
        expect(msg.length).toBeGreaterThan(80);
      };

      // exit failure
      {
        const run = startHostExecution(
          input({ workspace: dir, hostCommandScope: ['false'] }),
          Date.now(),
          { commandTimeoutMs: 60_000 },
        );
        run.begin();
        await settle(run);
        const msg = run.finalMessage();
        assertOneReceipt(msg);
        expect(parseHostOperationReceipt(msg)?.outcome).toBe('failed');
        expect(msg.toLowerCase()).toMatch(/exit|fail|stopped/);
      }
      // spawn_error (invalid executable)
      {
        const run = startHostExecution(
          input({
            workspace: dir,
            hostCommandScope: ['/nonexistent/host-exec-bin-xyz'],
          }),
          Date.now(),
          { commandTimeoutMs: 60_000 },
        );
        run.begin();
        await settle(run);
        const msg = run.finalMessage();
        assertOneReceipt(msg);
        expect(parseHostOperationReceipt(msg)?.outcome).toBe('failed');
        expect(msg.toLowerCase()).toMatch(/spawn|launch|fail|enoent/);
      }
      // timeout
      {
        const run = startHostExecution(
          input({ workspace: dir, hostCommandScope: ['sleep 30'] }),
          Date.now(),
          { commandTimeoutMs: 150, allowShortTimeout: true },
        );
        run.begin();
        await settle(run);
        const msg = run.finalMessage();
        assertOneReceipt(msg);
        expect(parseHostOperationReceipt(msg)?.postCheckEvidence.toLowerCase()).toMatch(
          /timeout|fail|stopped/,
        );
      }
      // cancel (graceful stop after spawn)
      {
        const run = startHostExecution(
          input({ workspace: dir, hostCommandScope: ['sleep 30'] }),
          Date.now(),
          { commandTimeoutMs: 60_000 },
        );
        run.begin();
        // Brief wait so the child is alive, then cancel.
        await new Promise((r) => setTimeout(r, 80));
        run.stop();
        await settle(run);
        const msg = run.finalMessage();
        assertOneReceipt(msg);
        expect(parseHostOperationReceipt(msg)?.outcome).not.toBe('success');
        expect(msg.toLowerCase()).toMatch(/cancel|signal|fail|stopped/);
      }
      // force cancel (SIGKILL via process-group kill)
      {
        const run = startHostExecution(
          input({ workspace: dir, hostCommandScope: ['sleep 30'] }),
          Date.now(),
          { commandTimeoutMs: 60_000 },
        );
        run.begin();
        await new Promise((r) => setTimeout(r, 80));
        run.stop({ force: true });
        await settle(run);
        const msg = run.finalMessage();
        assertOneReceipt(msg);
        expect(parseHostOperationReceipt(msg)?.outcome).not.toBe('success');
        expect(msg.toLowerCase()).toMatch(/cancel|signal|sigkill|fail|stopped/);
      }
      // external signal (kill process group without stop() cancel flag)
      {
        const run = startHostExecution(
          input({ workspace: dir, hostCommandScope: ['sleep 30'] }),
          Date.now(),
          { commandTimeoutMs: 60_000 },
        );
        run.begin();
        let pid = 0;
        for (let i = 0; i < 40 && pid <= 0; i += 1) {
          pid = run.poll(Date.now()).processPid ?? 0;
          if (pid <= 0) await new Promise((r) => setTimeout(r, 25));
        }
        expect(pid).toBeGreaterThan(0);
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          process.kill(pid, 'SIGTERM');
        }
        await settle(run);
        const msg = run.finalMessage();
        assertOneReceipt(msg);
        expect(parseHostOperationReceipt(msg)?.outcome).not.toBe('success');
        expect(msg.toLowerCase()).toMatch(/signal|sigterm|fail|stopped|kill/);
      }
    });
  });

  it('process-tree: descendant dies on graceful cancel, force kill, and timeout; invalid stops later', async () => {
    await withWorkspace(async (dir) => {
      const { writeFile, chmod, readFile, rm } = await import('node:fs/promises');
      const leader = join(dir, 'leader-with-child');
      const childPidFile = join(dir, 'child.pid');
      const later = join(dir, 'after-tree');
      // Leader spawns a same-process-group descendant (not detached) so
      // killProcessGroup(-leader) reaps both. Writes child pid then idles.
      await writeFile(
        leader,
        '#!/usr/bin/env node\n' +
          "const { spawn } = require('node:child_process');\n" +
          "const { writeFileSync } = require('node:fs');\n" +
          `const pidFile = ${JSON.stringify(childPidFile)};\n` +
          'const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {\n' +
          '  stdio: "ignore",\n' +
          '});\n' +
          'if (child.pid) writeFileSync(pidFile, String(child.pid));\n' +
          // Stay alive until killed so the host executor owns the process group.
          'setInterval(() => {}, 1000);\n',
      );
      await chmod(leader, 0o755);

      const isAlive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };

      const waitChildPid = async (): Promise<number> => {
        for (let i = 0; i < 50; i += 1) {
          try {
            const n = Number((await readFile(childPidFile, 'utf8')).trim());
            if (n > 0) return n;
          } catch {
            // Pid file not written yet — keep polling.
            await new Promise((r) => setTimeout(r, 0));
          }
          await new Promise((r) => setTimeout(r, 40));
        }
        return 0;
      };

      // Graceful cancel
      {
        await rm(childPidFile, { force: true });
        const run = startHostExecution(
          input({ workspace: dir, hostCommandScope: [leader, `touch ${later}`] }),
          Date.now(),
          { commandTimeoutMs: 120_000 },
        );
        run.begin();
        const childPid = await waitChildPid();
        expect(childPid).toBeGreaterThan(0);
        const leaderPid = run.poll(Date.now()).processPid;
        expect(leaderPid).toBeGreaterThan(0);
        run.stop(); // graceful SIGTERM first
        await settle(run);
        expect(isAlive(leaderPid!)).toBe(false);
        expect(isAlive(childPid)).toBe(false);
        await expect(
          import('node:fs/promises').then((fs) => fs.access(later)),
        ).rejects.toThrow();
      }

      // Force cancel
      {
        await rm(childPidFile, { force: true });
        const laterForce = join(dir, 'after-force');
        const run = startHostExecution(
          input({ workspace: dir, hostCommandScope: [leader, `touch ${laterForce}`] }),
          Date.now(),
          { commandTimeoutMs: 120_000 },
        );
        run.begin();
        const childPid = await waitChildPid();
        expect(childPid).toBeGreaterThan(0);
        const leaderPid = run.poll(Date.now()).processPid;
        expect(leaderPid).toBeGreaterThan(0);
        run.stop({ force: true });
        await settle(run);
        expect(isAlive(leaderPid!)).toBe(false);
        expect(isAlive(childPid)).toBe(false);
        await expect(
          import('node:fs/promises').then((fs) => fs.access(laterForce)),
        ).rejects.toThrow();
        const receipt = parseHostOperationReceipt(run.finalMessage());
        expect(receipt?.outcome).not.toBe('success');
      }

      // Timeout path also kills the tree and skips later commands.
      {
        await rm(childPidFile, { force: true });
        const later2 = join(dir, 'after-timeout-tree');
        const run = startHostExecution(
          input({ workspace: dir, hostCommandScope: [leader, `touch ${later2}`] }),
          Date.now(),
          { commandTimeoutMs: 250, allowShortTimeout: true },
        );
        run.begin();
        const childPid = await waitChildPid();
        await settle(run);
        expect(run.poll(Date.now()).status).toBe('failed');
        if (childPid > 0) expect(isAlive(childPid)).toBe(false);
        await expect(
          import('node:fs/promises').then((fs) => fs.access(later2)),
        ).rejects.toThrow();
      }

      // Invalid executable stops later commands.
      {
        const later3 = join(dir, 'after-invalid');
        const run = startHostExecution(
          input({
            workspace: dir,
            hostCommandScope: ['/no/such/host-bin-zzz', `touch ${later3}`],
          }),
          Date.now(),
          { commandTimeoutMs: 60_000 },
        );
        run.begin();
        await settle(run);
        const starts = run.activityLog().filter((l) => l.includes('] start '));
        expect(starts).toHaveLength(1);
        await expect(
          import('node:fs/promises').then((fs) => fs.access(later3)),
        ).rejects.toThrow();
      }
    });
  });
});
