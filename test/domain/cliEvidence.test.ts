import { describe, it, expect } from 'vitest';
import {
  CliEvidenceParseError,
  parseCliEvidenceConfig,
  evaluateCliEvidenceAssertions,
  redactCliEvidenceOutput,
  formatCliEvidenceReceipt,
  assembleCliEvidenceReceipt,
  omittedCliEvidenceReceipt,
  isCliEvidenceFailed,
  isCliEvidenceNotRun,
  isPathInsideWorkspace,
  truncateCliEvidenceOutput,
  extractCliEvidenceReceipt,
  serializeCliEvidenceReceipt,
  CLI_EVIDENCE_VERSION,
  MAX_CLI_EVIDENCE_TOTAL_OUTPUT_BYTES,
} from '../../src/domain/cliEvidence.js';

describe('cliEvidence domain', () => {
  it('parses valid plan', () => {
    const plan = parseCliEvidenceConfig({
      version: 1,
      steps: [{
        id: 'help',
        argv: ['node', 'scripts/f.mjs', '--help'],
        expect: { exit_code: 0, stdout_contains: 'Usage' },
      }],
    });
    expect(plan?.version).toBe(CLI_EVIDENCE_VERSION);
    expect(plan?.steps[0]?.argv[0]).toBe('node');
    expect(plan?.steps[0]?.expect.stdoutContains).toBe('Usage');
  });

  it('rejects shell and unsafe input', () => {
    expect(() => parseCliEvidenceConfig({ version: 1, steps: ['sh -c id'] })).toThrow(
      CliEvidenceParseError,
    );
    expect(() =>
      parseCliEvidenceConfig({ version: 1, steps: [{ id: 'x', argv: ['bash'] }] }),
    ).toThrow(/shell/i);
    expect(() =>
      parseCliEvidenceConfig({ version: 1, steps: [{ id: 'x', argv: ['/bin/node'] }] }),
    ).toThrow(/absolute|workspace-relative/i);
    expect(() =>
      parseCliEvidenceConfig({
        version: 1,
        steps: [{ id: 'x', argv: ['node'], cwd: '../x' }],
      }),
    ).toThrow(/\.\./);
    expect(() =>
      parseCliEvidenceConfig({
        version: 1,
        steps: [{ id: 'x', argv: ['node'], timeout_ms: 1 }],
      }),
    ).toThrow(/timeout/i);
    expect(() =>
      parseCliEvidenceConfig({ version: 1, steps: [{ id: 'x', argv: ['node'] }], z: 1 }),
    ).toThrow(/unknown/i);
    expect(() =>
      parseCliEvidenceConfig({
        version: 1,
        steps: [{ id: 'x', argv: ['node', '--eval', 'process.exit(0)'] }],
      }),
    ).toThrow(/inline|interpreter/i);
    expect(() =>
      parseCliEvidenceConfig({
        version: 1,
        steps: [{ id: 'x', argv: ['python3', '-c', 'print(1)'] }],
      }),
    ).toThrow(/inline|interpreter/i);
    expect(() =>
      parseCliEvidenceConfig({
        version: 1,
        steps: [{ id: 'x', argv: ['node', '--require', '../outside.cjs', 'scripts/a.mjs'] }],
      }),
    ).toThrow(/inline|interpreter/i);
    expect(() =>
      parseCliEvidenceConfig({ version: 1, steps: [{ id: 'x', argv: ['python3', '/tmp/x.py'] }] }),
    ).toThrow(/workspace-relative/i);
    expect(() =>
      parseCliEvidenceConfig({ version: 1, steps: [{ id: 'x', argv: ['env', 'node'] }] }),
    ).toThrow(/wrapper/i);
    expect(() =>
      parseCliEvidenceConfig({
        version: 1,
        steps: [{ id: 'x', argv: ['tool', '--token', 'ordinary-looking-value'] }],
      }),
    ).toThrow(/secret/i);
    expect(() =>
      parseCliEvidenceConfig({
        version: 1,
        steps: [
          { id: 'same', argv: ['node', 'scripts/a.mjs'] },
          { id: 'same', argv: ['node', 'scripts/b.mjs'] },
        ],
      }),
    ).toThrow(/duplicate/i);
    expect(() =>
      parseCliEvidenceConfig({
        version: 1,
        steps: [{ id: 'x', argv: ['node', 'scripts/a.mjs'], expect: { stdout_matches: '(' } }],
      }),
    ).toThrow(/regex/i);
  });

  it('allows ordinary argv values without treating them as shell source', () => {
    const plan = parseCliEvidenceConfig({
      version: 1,
      steps: [{
        id: 'args',
        argv: ['node', 'scripts/a.mjs', 'two words', 'name=(benign)', '--format=json'],
      }],
    });
    expect(plan?.steps[0]?.argv).toEqual([
      'node', 'scripts/a.mjs', 'two words', 'name=(benign)', '--format=json',
    ]);
  });

  it('allows capture budgets that exceed the receipt total (per-step truncation)', () => {
    const steps = Array.from({ length: 4 }, (_, i) => ({
      id: 'step-' + String(i),
      argv: ['node', '--version'],
      max_output_bytes: 200 * 1024,
    }));
    const plan = parseCliEvidenceConfig({ version: 1, steps });
    expect(plan?.steps).toHaveLength(4);
    expect(plan?.steps[0]?.maxOutputBytes).toBe(200 * 1024);
  });

  it('allows a 20-minute step and fails closed when the plan budget (60 min) is exceeded (C3.45)', () => {
    const twenty = 20 * 60_000;
    const plan = parseCliEvidenceConfig({
      version: 1,
      steps: [{ id: 'web-console-flow', argv: ['node', 'scripts/ui-evidence.mjs'], timeout_ms: twenty }],
    });
    expect(plan?.steps[0]?.timeoutMs).toBe(twenty);
    expect(() => parseCliEvidenceConfig({
      version: 1,
      steps: [{ id: 'too-long', argv: ['node'], timeout_ms: twenty + 1 }],
    })).toThrow(/timeout_ms out of range/);
    const four = Array.from({ length: 4 }, (_, i) => ({ id: 'flow-' + String(i), argv: ['node'], timeout_ms: twenty }));
    expect(() => parseCliEvidenceConfig({ version: 1, steps: four })).toThrow(/plan budget/);
    expect(parseCliEvidenceConfig({ version: 1, steps: four.slice(0, 3) })?.steps).toHaveLength(3);
  });

  it('truncates per step with head+tail marker so a 200 KiB step does not burn the receipt', () => {
    const big = 'A'.repeat(200 * 1024);
    const marker = truncateCliEvidenceOutput(big, 1024);
    expect(marker).toMatch(/\u2026\s+\d+\s+bytes truncated\s+\u2026/);
    expect(Buffer.byteLength(marker, 'utf8')).toBeLessThanOrEqual(1024);
    expect(marker.startsWith('A')).toBe(true);
    expect(marker.endsWith('A')).toBe(true);

    const plan = parseCliEvidenceConfig({
      version: 1,
      steps: [
        { id: 'cargo-test', argv: ['cargo', 'test'], max_output_bytes: 200 * 1024 },
        { id: 'b', argv: ['node', '--version'] },
        { id: 'c', argv: ['node', '--version'] },
        { id: 'd', argv: ['node', '--version'] },
      ],
    })!;
    const assembled = assembleCliEvidenceReceipt({
      plan,
      durationMs: 12,
      steps: [
        {
          id: 'cargo-test',
          argv: ['cargo', 'test'],
          cwd: '.',
          status: 'passed',
          exitCode: 0,
          durationMs: 10,
          stdoutTail: big,
          stderrTail: '',
          assertions: [{ name: 'exit_code', ok: true, detail: 'exit matches expected' }],
          ok: true,
          optional: false,
        },
        {
          id: 'b', argv: ['node', '--version'], cwd: '.', status: 'passed',
          exitCode: 0, durationMs: 1, stdoutTail: 'v1\n', stderrTail: '',
          assertions: [], ok: true, optional: false,
        },
        {
          id: 'c', argv: ['node', '--version'], cwd: '.', status: 'passed',
          exitCode: 0, durationMs: 1, stdoutTail: 'v1\n', stderrTail: '',
          assertions: [], ok: true, optional: false,
        },
        {
          id: 'd', argv: ['node', '--version'], cwd: '.', status: 'passed',
          exitCode: 0, durationMs: 1, stdoutTail: 'v1\n', stderrTail: '',
          assertions: [], ok: true, optional: false,
        },
      ],
    });
    expect(assembled.status).toBe('passed');
    expect(assembled.ok).toBe(true);
    expect(assembled.steps[0]?.exitCode).toBe(0);
    expect(assembled.steps[0]?.status).toBe('passed');
    expect(assembled.steps[0]?.stdoutTail).toMatch(/\u2026\s+\d+\s+bytes truncated\s+\u2026/);
    const total = assembled.steps.reduce(
      (n, s) => n + Buffer.byteLength(s.stdoutTail, 'utf8') + Buffer.byteLength(s.stderrTail, 'utf8'),
      0,
    );
    expect(total).toBeLessThanOrEqual(MAX_CLI_EVIDENCE_TOTAL_OUTPUT_BYTES);
    const roundTrip = extractCliEvidenceReceipt(serializeCliEvidenceReceipt(assembled));
    expect(roundTrip).not.toBeNull();
    expect(roundTrip?.status).toBe('passed');
    expect(roundTrip?.steps[0]?.stdoutTail).toMatch(/bytes truncated/);
  });

  it('evaluates assertions and redacts secrets', () => {
    const ok = evaluateCliEvidenceAssertions({
      expect: { exitCode: 0, stdoutContains: 'hi' },
      exitCode: 0,
      stdout: 'hi there',
      stderr: '',
    });
    expect(ok.every((a) => a.ok)).toBe(true);
    const bad = evaluateCliEvidenceAssertions({
      expect: { exitCode: 0 },
      exitCode: 1,
      stdout: '',
      stderr: '',
    });
    expect(bad[0]!.ok).toBe(false);
    expect(redactCliEvidenceOutput('TOKEN=fixture-value secret', 200)).toMatch(/REDACTED/i);
  });

  it('a truncated stream can prove a positive match but never a negative one', () => {
    const byName = (results: readonly { name: string; ok: boolean; detail: string }[]) =>
      Object.fromEntries(results.map((r) => [r.name, r]));
    const truncated = byName(evaluateCliEvidenceAssertions({
      expect: { exitCode: 0, stdoutContains: 'seen', stderrContains: 'x', stderrEmpty: true },
      exitCode: 0,
      stdout: 'seen-prefix',
      stderr: '',
      truncated: { stdout: true, stderr: true },
    }));
    expect(truncated['stdout_contains']?.ok).toBe(true);
    expect(truncated['stderr_contains']?.ok).toBe(false);
    expect(truncated['stderr_contains']?.detail).toMatch(/truncated at the capture budget/);
    expect(truncated['stderr_empty']?.ok).toBe(false);
    expect(truncated['stderr_empty']?.detail).toMatch(/truncated at the capture budget/);
    const complete = byName(evaluateCliEvidenceAssertions({
      expect: { exitCode: 0, stdoutContains: 'absent', stderrEmpty: true },
      exitCode: 0,
      stdout: 'seen-prefix',
      stderr: '',
      truncated: { stdout: false, stderr: false },
    }));
    expect(complete['stdout_contains']?.detail).toBe('missing');
    expect(complete['stderr_empty']?.ok).toBe(true);
  });

  it('receipts distinguish passed failed not-run', () => {
    const plan = parseCliEvidenceConfig({
      version: 1,
      steps: [{ id: 'a', argv: ['node', '--version'] }],
    })!;
    const omitted = omittedCliEvidenceReceipt(plan, 'gates failed');
    expect(isCliEvidenceNotRun(omitted)).toBe(true);
    expect(formatCliEvidenceReceipt(omitted)).toContain('CLI behavioral evidence');
    expect(isPathInsideWorkspace('/ws', '/ws/sub')).toBe(true);
    expect(isPathInsideWorkspace('/ws', '/etc')).toBe(false);
    const assembled = assembleCliEvidenceReceipt({ plan, steps: [], durationMs: 0 });
    expect(assembled.status).toBe('not_run');
    expect(isCliEvidenceFailed(omitted)).toBe(false);
  });

  it('parses artifacts_dir and rejects unsafe values', () => {
    const withDir = parseCliEvidenceConfig({
      version: 1,
      steps: [{
        id: 'web-console-flow',
        argv: ['node', 'scripts/flow.mjs'],
        artifacts_dir: 'target/hercules-ui-evidence',
      }],
    });
    expect(withDir?.steps[0]?.artifactsDir).toBe('target/hercules-ui-evidence');

    const without = parseCliEvidenceConfig({
      version: 1,
      steps: [{ id: 'plain', argv: ['node', 'scripts/a.mjs'] }],
    });
    expect(without?.steps[0]?.artifactsDir).toBeUndefined();

    expect(() => parseCliEvidenceConfig({
      version: 1,
      steps: [{ id: 'x', argv: ['node', 'a.mjs'], artifacts_dir: '.' }],
    })).toThrow(/workspace root/i);
    expect(() => parseCliEvidenceConfig({
      version: 1,
      steps: [{ id: 'x', argv: ['node', 'a.mjs'], artifacts_dir: '' }],
    })).toThrow(/workspace root/i);
    expect(() => parseCliEvidenceConfig({
      version: 1,
      steps: [{ id: 'x', argv: ['node', 'a.mjs'], artifacts_dir: '/tmp/out' }],
    })).toThrow(/workspace-relative/i);
    expect(() => parseCliEvidenceConfig({
      version: 1,
      steps: [{ id: 'x', argv: ['node', 'a.mjs'], artifacts_dir: '../escape' }],
    })).toThrow(/\.\./);
    expect(() => parseCliEvidenceConfig({
      version: 1,
      steps: [{ id: 'x', argv: ['node', 'a.mjs'], artifacts_dir: 'a/b/../c' }],
    })).toThrow(/\.\./);
  });

  it('formats artifact media lines for the sheet when taskId is provided', () => {
    const receipt = assembleCliEvidenceReceipt({
      plan: parseCliEvidenceConfig({
        version: 1,
        steps: [{ id: 'web-console-flow', argv: ['node', 'scripts/a.mjs'] }],
      })!,
      durationMs: 5,
      steps: [{
        id: 'web-console-flow',
        argv: ['node', 'scripts/a.mjs'],
        cwd: '.',
        status: 'passed',
        exitCode: 0,
        durationMs: 5,
        stdoutTail: '',
        stderrTail: '',
        assertions: [{ name: 'exit_code', ok: true, detail: 'ok' }],
        ok: true,
        optional: false,
        artifacts: [
          {
            name: 'cli-web-console-flow-shot.png',
            kind: 'image',
            bytes: 12,
            sha256: 'a'.repeat(64),
          },
          {
            name: 'cli-web-console-flow-clip.webm',
            kind: 'video',
            bytes: 40,
            sha256: 'b'.repeat(64),
          },
        ],
        artifactsSkipped: 'oversized.bin exceeds 10485760 bytes',
      }],
    });
    const md = formatCliEvidenceReceipt(receipt, { taskId: 'T-flow' });
    expect(md).toContain('- ✅ cli web-console-flow');
    expect(md).toContain(
      '![evidence](/api/tasks/T-flow/screenshots/cli-web-console-flow-shot.png)',
    );
    expect(md).toContain(
      '[video: cli-web-console-flow-clip.webm](/api/tasks/T-flow/screenshots/cli-web-console-flow-clip.webm)',
    );
    expect(md).toMatch(/artifacts skipped:.*oversized\.bin/i);
  });
});
