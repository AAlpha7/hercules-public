import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  execRunner,
  GATE_CANCEL_OUTPUT_MARK,
  runGates,
  type CommandRunner,
} from '../../src/verification/gates.js';
import {
  VerificationAbortedError,
  isVerificationAborted,
} from '../../src/domain/verificationRun.js';

describe('runGates cancel (signal)', () => {
  it('stops before the next gate when signal aborts between gates', async () => {
    const ran: string[] = [];
    const ac = new AbortController();
    const run: CommandRunner = async (command) => {
      ran.push(command);
      if (command === 'gate-a') {
        ac.abort();
      }
      return { exitCode: 0, output: 'ok' };
    };
    await expect(
      runGates(
        [
          { name: 'a', command: 'gate-a' },
          { name: 'b', command: 'gate-b' },
        ],
        '/ws',
        run,
        { signal: ac.signal },
      ),
    ).rejects.toSatisfy((err: unknown) => isVerificationAborted(err));
    expect(ran).toEqual(['gate-a']);
  });

  it('passes signal into the command runner', async () => {
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    const run: CommandRunner = async (_cmd, _cwd, opts) => {
      seen = opts?.signal;
      return { exitCode: 0, output: '' };
    };
    await runGates([{ name: 't', command: 'true' }], '/ws', run, {
      signal: ac.signal,
    });
    expect(seen).toBe(ac.signal);
  });

  it('reports progress for each gate', async () => {
    const events: string[] = [];
    const run: CommandRunner = async () => ({ exitCode: 0, output: 'ok' });
    await runGates(
      [
        { name: 'typecheck', command: 'tc' },
        { name: 'test', command: 't' },
      ],
      '/ws',
      run,
      {
        onProgress: (p) => {
          events.push(`${p.phase}:${p.stage}:${p.processAlive ? 1 : 0}`);
          if (p.completedStage) events.push(`done:${p.completedStage}`);
        },
      },
    );
    expect(events).toContain('l1:typecheck:1');
    expect(events).toContain('done:typecheck');
    expect(events).toContain('l1:test:1');
    expect(events).toContain('done:test');
  });

  it('ordinary non-zero exit is a gate failure, not verification abort', async () => {
    const run: CommandRunner = async () => ({
      exitCode: 1,
      output: 'FAIL tests/foo.test.ts',
    });
    const results = await runGates(
      [{ name: 'test', command: 'pnpm test' }],
      '/ws',
      run,
      { signal: new AbortController().signal },
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.output).toContain('FAIL tests/foo.test.ts');
  });

  it('runner AbortError / cancel reject is not folded into a failing GateResult', async () => {
    const run: CommandRunner = async () => {
      const err = new DOMException('The operation was aborted.', 'AbortError');
      throw err;
    };
    await expect(
      runGates([{ name: 'test', command: 'pnpm test' }], '/ws', run, {
        signal: new AbortController().signal,
      }),
    ).rejects.toSatisfy((err: unknown) => isVerificationAborted(err));
  });

  it('cancel output marker is never a normal failing gate', async () => {
    const run: CommandRunner = async () => ({
      exitCode: 130,
      output: `${GATE_CANCEL_OUTPUT_MARK}\n`,
    });
    await expect(
      runGates([{ name: 'test', command: 'cargo test' }], '/ws', run),
    ).rejects.toBeInstanceOf(VerificationAbortedError);
  });
});

describe('execRunner process-group abort', { timeout: 15_000 }, () => {
  it('rejects VerificationAbortedError when the signal aborts (not exit-code fail)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'h-gate-cancel-'));
    // Marker file written only if sleep finishes — must NOT appear after abort.
    const marker = join(dir, 'finished.txt');
    const ac = new AbortController();
    const cmd = `sleep 30; echo done > "${marker}"`;
    const running = execRunner(cmd, dir, { signal: ac.signal });
    // Give the shell a moment to spawn sleep.
    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    await expect(running).rejects.toSatisfy(
      (err: unknown) =>
        isVerificationAborted(err) && err instanceof VerificationAbortedError,
    );
    // sleep must not have completed the marker write
    await new Promise((r) => setTimeout(r, 200));
    await expect(writeFile(marker + '.probe', 'x')).resolves.toBeUndefined();
    const { access } = await import('node:fs/promises');
    await expect(access(marker)).rejects.toThrow();
  });

  it('rejects immediately when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(execRunner('sleep 10', tmpdir(), { signal: ac.signal })).rejects.toSatisfy(
      (err: unknown) => isVerificationAborted(err),
    );
  });
});
