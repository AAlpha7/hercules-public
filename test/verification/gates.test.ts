import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { execRunner, runGates, type CommandRunner } from '../../src/verification/gates.js';
import { effectiveRepoExecutionPolicy } from '../../src/domain/repoExecutionPolicy.js';

const gates = [
  { name: 'typecheck', command: 'tsc --noEmit' },
  { name: 'lint', command: 'eslint .' },
  { name: 'test', command: 'vitest run' },
];

describe('runGates (SPEC §9.1)', () => {
  it('runs all gates in order when they pass', async () => {
    const ran: string[] = [];
    const run: CommandRunner = async (command) => {
      ran.push(command);
      return { exitCode: 0, output: 'ok' };
    };
    const results = await runGates(gates, '/ws', run);

    expect(ran).toEqual(['tsc --noEmit', 'eslint .', 'vitest run']);
    expect(results.map((r) => r.passed)).toEqual([true, true, true]);
    expect(results[0]!.name).toBe('typecheck');
  });

  it('stops at the first failing gate (fail-fast) and captures its output', async () => {
    const ran: string[] = [];
    const run: CommandRunner = async (command) => {
      ran.push(command);
      return command.startsWith('eslint')
        ? { exitCode: 1, output: 'lint error: do X to fix' }
        : { exitCode: 0, output: 'ok' };
    };
    const results = await runGates(gates, '/ws', run);

    expect(ran).toEqual(['tsc --noEmit', 'eslint .']); // test gate not run
    expect(results).toHaveLength(2);
    expect(results[1]!.passed).toBe(false);
    expect(results[1]!.output).toContain('do X to fix');
  });

  it('passes the worktree as the cwd', async () => {
    const seen: string[] = [];
    const run: CommandRunner = async (_command, cwd) => {
      seen.push(cwd);
      return { exitCode: 0, output: '' };
    };
    await runGates([gates[0]!], '/ws/app/T-1', run);
    expect(seen).toEqual(['/ws/app/T-1']);
  });

  it('forwards the repo execution policy to the command runner', async () => {
    const policy = effectiveRepoExecutionPolicy({ profile: 'guardian' });
    const seen: unknown[] = [];
    const run: CommandRunner = async (_command, _cwd, opts) => {
      seen.push(opts?.executionPolicy);
      return { exitCode: 0, output: '' };
    };
    await runGates([gates[0]!], '/ws', run, { executionPolicy: policy });
    expect(seen).toEqual([policy]);
  });
});

describe('execRunner env boundary (real child process)', () => {
  it('policy-disallowed names never reach a real gate child; explicit allowlist is not widened', async () => {
    const saved = { ...process.env };
    process.env['DATABASE_URL'] = 'postgres://user:leak@db/prod';
    process.env['HERCULES_TOKEN'] = 'leak-hercules-token';
    process.env['NODE_ENV'] = 'leak-node-env';
    try {
      const policy = effectiveRepoExecutionPolicy({ envAllowlist: ['PATH', 'HOME'] });
      const { exitCode, output } = await execRunner('env', tmpdir(), {
        executionPolicy: policy,
      });
      expect(exitCode).toBe(0);
      expect(output).toContain('PATH=');
      expect(output).not.toContain('DATABASE_URL=');
      expect(output).not.toContain('HERCULES_TOKEN=');
      // Explicit allowlist authoritative: NODE_* must not ride in via prefixes.
      expect(output).not.toContain('NODE_ENV=');
      expect(output).not.toContain('leak-hercules-token');
      expect(output).not.toContain('postgres://user:leak@db/prod');
    } finally {
      process.env = { ...saved } as NodeJS.ProcessEnv;
    }
  });
});
