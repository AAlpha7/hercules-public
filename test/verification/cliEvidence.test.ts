import { createServer } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assembleCliEvidenceReceipt,
  extractCliEvidenceReceipt,
  formatCliEvidenceReceipt,
  parseCliEvidenceConfig,
  type CliEvidencePlan,
} from '../../src/domain/cliEvidence.js';
import { effectiveRepoExecutionPolicy } from '../../src/domain/repoExecutionPolicy.js';
import { VerificationAbortedError } from '../../src/domain/verificationRun.js';
import {
  collectCliEvidenceArtifacts,
  runCliEvidence,
} from '../../src/verification/cliEvidence.js';
import { buildCliEvidenceInvocation } from '../../src/verification/cliEvidenceSandbox.js';
import { assembleReviewPacket, renderPacketMarkdown } from '../../src/verification/packet.js';

const BWRAP_PATH = '/usr/bin/bwrap';

/** Real host binary only — never stubbed. Host-boundary cases skipIf this is false. */
function probeExecutableBwrap(): boolean {
  try {
    accessSync(BWRAP_PATH, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const hasExecutableBwrap = probeExecutableBwrap();

function probeHostCargo(): boolean {
  const home = homedir();
  for (const candidate of [
    join(home, '.cargo', 'bin', 'cargo'),
    join(home, '.local', 'bin', 'cargo'),
    '/usr/bin/cargo',
  ]) {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

const hasHostCargo = probeHostCargo();

const roots: string[] = [];

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cli-ev-'));
  roots.push(dir);
  await mkdir(join(dir, 'scripts'), { recursive: true });
  return dir;
}

function plan(step: Record<string, unknown>): CliEvidencePlan {
  return parseCliEvidenceConfig({ version: 1, steps: [step] })!;
}

afterEach(async () => {
  // Temporary roots are intentionally left to the host temp cleaner. A live
  // cancellation regression may still have a just-reaped descendant briefly.
  roots.length = 0;
});

describe('runCliEvidence outcomes', () => {
  it('passes a successful observable contract', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'scripts', 'ok.py'), 'print("hello-cli")\n');
    const receipt = await runCliEvidence({
      plan: plan({
        id: 'ok', argv: ['python3', 'scripts/ok.py'],
        expect: { exit_code: 0, stdout_contains: 'hello-cli' },
      }),
      workspaceDir: dir,
    });
    expect(receipt.status, JSON.stringify(receipt)).toBe('passed');
    expect(receipt.steps[0]?.status).toBe('passed');
  });

  it('passes an expected nonzero exit and fails a mismatch', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'scripts', 'exit.py'), 'import sys\nprint("expected", file=sys.stderr)\nsys.exit(2)\n');
    const expected = await runCliEvidence({
      plan: plan({
        id: 'expected', argv: ['python3', 'scripts/exit.py'],
        expect: { exit_code: 2, stderr_matches: '^expected\\n$' },
      }),
      workspaceDir: dir,
    });
    expect(expected.status).toBe('passed');
    expect(expected.steps[0]?.assertions.some((a) => a.name === 'stderr_matches' && a.ok)).toBe(true);

    const mismatch = await runCliEvidence({
      plan: plan({ id: 'mismatch', argv: ['python3', 'scripts/exit.py'], expect: { exit_code: 0 } }),
      workspaceDir: dir,
    });
    expect(mismatch.status).toBe('failed');
    expect(mismatch.steps[0]?.exitCode).toBe(2);
  });

  it('reports timeout and asynchronous spawn error separately', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'scripts', 'slow.py'), 'import time\ntime.sleep(3)\n');
    const timed = await runCliEvidence({
      plan: plan({
        id: 'slow', argv: ['python3', 'scripts/slow.py'], timeout_ms: 100,
      }),
      workspaceDir: dir,
    });
    expect(timed.steps[0]?.status).toBe('timeout');

    const missing = await runCliEvidence({
      plan: plan({ id: 'missing', argv: ['not-a-real-cli-evidence-binary'] }),
      workspaceDir: dir,
    });
    expect(missing.steps[0]?.status).toBe('spawn_error');
  });

  it('settles a timeout even when process-group termination rejects', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'scripts', 'slow.py'), 'import time\ntime.sleep(10)\n');
    let pid: number | undefined;
    const spawnCapture = ((file: string, args: readonly string[], options: object) => {
      const child = spawn(file, [...args], options);
      pid = child.pid;
      return child;
    }) as typeof spawn;
    const started = Date.now();
    try {
      const receipt = await runCliEvidence({
        plan: plan({ id: 'kill-failure', argv: ['python3', 'scripts/slow.py'], timeout_ms: 100 }),
        workspaceDir: dir,
        spawnProcess: spawnCapture,
        killGroup: async () => { throw new Error('injected kill failure'); },
      });
      expect(receipt.steps[0]?.status).toBe('timeout');
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      if (pid) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  }, 4_000);

  it('settles cancellation when process-group termination never returns', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'scripts', 'slow.py'), 'import time\ntime.sleep(10)\n');
    let pid: number | undefined;
    const spawnCapture = ((file: string, args: readonly string[], options: object) => {
      const child = spawn(file, [...args], options);
      pid = child.pid;
      return child;
    }) as typeof spawn;
    const controller = new AbortController();
    const started = Date.now();
    try {
      const running = runCliEvidence({
        plan: plan({ id: 'cancel-kill-hang', argv: ['python3', 'scripts/slow.py'] }),
        workspaceDir: dir,
        signal: controller.signal,
        spawnProcess: spawnCapture,
        killGroup: async () => new Promise<never>(() => {}),
      });
      setTimeout(() => controller.abort(), 50);
      await expect(running).rejects.toBeInstanceOf(VerificationAbortedError);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      if (pid) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  }, 4_000);

  it.each(['stdout', 'stderr'] as const)(
    'bounds combined byte capture while streaming oversized %s',
    async (stream) => {
      const dir = await workspace();
      await writeFile(
        join(dir, 'scripts', 'large.py'),
        `import sys, time\nsys.${stream}.write('界' * 50000)\nsys.${stream}.flush()\ntime.sleep(3)\n`,
      );
      const receipt = await runCliEvidence({
        plan: plan({
          id: 'large', argv: ['python3', 'scripts/large.py'], max_output_bytes: 256,
        }),
        workspaceDir: dir,
        overflowMode: 'terminate',
      });
      expect(receipt.steps[0]?.status).toBe('oversized_output');
      const step = receipt.steps[0]!;
      expect(Buffer.byteLength(step.stdoutTail) + Buffer.byteLength(step.stderrTail)).toBeLessThanOrEqual(256);
      expect(step.stdoutTail + step.stderrTail).not.toContain('\uFFFD');
    },
  );

  it('truncates by default — a verbose step never burns the attempt (2026-09-09)', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'scripts', 'large.py'), `print('y' * 50000)\n`);
    const receipt = await runCliEvidence({
      plan: plan({ id: 'verbose', argv: ['python3', 'scripts/large.py'], max_output_bytes: 256 }),
      workspaceDir: dir,
    });
    expect(receipt.status).toBe('passed');
    expect(receipt.steps[0]?.status).toBe('passed');
    expect(Buffer.byteLength(receipt.steps[0]?.stdoutTail ?? '')).toBeLessThanOrEqual(256);
    expect(receipt.steps[0]?.stderrTail ?? '').toMatch(/truncated/);
  });

  it('truncated capture can never prove stderr_empty — flooding stdout does not hide stderr (Claude round 19 B2)', async () => {
    const dir = await workspace();
    await writeFile(
      join(dir, 'scripts', 'flood.py'),
      `import sys\nsys.stdout.write('y' * 600)\nsys.stdout.flush()\nsys.stderr.write('BOOM')\nsys.stderr.flush()\n`,
    );
    const receipt = await runCliEvidence({
      plan: plan({
        id: 'flood', argv: ['python3', 'scripts/flood.py'], max_output_bytes: 512,
        expect: { exit_code: 0, stderr_empty: true },
      }),
      workspaceDir: dir,
    });
    expect(receipt.status).toBe('failed');
    const step = receipt.steps[0]!;
    expect(step.status).toBe('failed');
    const empty = step.assertions.find((a) => a.name === 'stderr_empty');
    expect(empty?.ok).toBe(false);
    expect(empty?.detail).toMatch(/truncated at the capture budget/);
    // A positive match inside the captured prefix still counts.
    await writeFile(join(dir, 'scripts', 'seen.py'), `print('needle-' + 'z' * 5000)\n`);
    const seen = await runCliEvidence({
      plan: plan({
        id: 'seen', argv: ['python3', 'scripts/seen.py'], max_output_bytes: 256,
        expect: { exit_code: 0, stdout_contains: 'needle-' },
      }),
      workspaceDir: dir,
    });
    expect(seen.steps[0]?.status).toBe('passed');
    // A miss on a truncated stream fails with the truncation detail, not "missing".
    const unseen = await runCliEvidence({
      plan: plan({
        id: 'unseen', argv: ['python3', 'scripts/seen.py'], max_output_bytes: 256,
        expect: { exit_code: 0, stdout_contains: 'never-captured' },
      }),
      workspaceDir: dir,
    });
    expect(unseen.steps[0]?.status).toBe('failed');
    expect(unseen.steps[0]?.assertions.find((a) => a.name === 'stdout_contains')?.detail)
      .toMatch(/truncated at the capture budget/);
  });

  it('bounds trusted build output by truncating without killing the command', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'scripts', 'large.py'), `print('x' * 50000)\n`);
    const receipt = await runCliEvidence({
      plan: plan({
        id: 'trusted-build-output',
        argv: ['python3', 'scripts/large.py'],
        max_output_bytes: 256,
      }),
      workspaceDir: dir,
      overflowMode: 'truncate',
    });
    expect(receipt.status).toBe('passed');
    expect(receipt.steps[0]?.status).toBe('passed');
    expect(Buffer.byteLength(receipt.steps[0]?.stdoutTail ?? '')).toBeLessThanOrEqual(256);
  });

  it.skipIf(!hasExecutableBwrap)(
    'mounts only credential-free Rust toolchain trees read-only',
    async () => {
    const dir = await workspace();
    const fakeHome = join(dir, 'fake-home');
    const cargoBin = join(fakeHome, '.cargo', 'bin');
    const cargoRegistry = join(fakeHome, '.cargo', 'registry');
    const rustup = join(fakeHome, '.rustup');
    await mkdir(cargoBin, { recursive: true });
    await mkdir(cargoRegistry, { recursive: true });
    await mkdir(rustup, { recursive: true });
    await writeFile(join(fakeHome, '.cargo', 'credentials.toml'), 'token = "secret"\n');

    const invocation = await buildCliEvidenceInvocation({
      policy: effectiveRepoExecutionPolicy({ profile: 'guardian' }),
      workspaceRoot: dir,
      cwd: dir,
      argv: ['cargo', '--version'],
      bubblewrapPath: '/usr/bin/bwrap',
      platform: 'linux',
      rustToolchainHome: fakeHome,
    });
    const serialized = JSON.stringify(invocation.args);
    for (const mount of [cargoBin, cargoRegistry, rustup]) {
      expect(serialized).toContain(JSON.stringify(['--ro-bind', mount, mount]).slice(1, -1));
    }
    expect(serialized).not.toContain('credentials.toml');
    expect(serialized).not.toContain('secret');
    },
  );

  it.skipIf(!hasExecutableBwrap)(
    'redacts a non-pattern secret value derived from the pre-filter environment',
    async () => {
    const dir = await workspace();
    const secret = 'v!o?';
    await writeFile(join(dir, 'scripts', 'secret.py'), `print(${JSON.stringify(secret)} * 40)\n`);
    const receipt = await runCliEvidence({
      plan: plan({
        id: 'secret', argv: ['python3', 'scripts/secret.py'], max_output_bytes: 256,
      }),
      workspaceDir: dir,
      executionPolicy: effectiveRepoExecutionPolicy({
        sandbox: 'workspace', network: 'unrestricted', workspaceWrite: true,
      }),
      sourceEnv: { ...process.env, ORDINARY_DROPPED_VALUE: secret },
      // Filesystem isolation is enough for this redaction test; the invocation
      // builder itself is covered for --unshare-net below.
      bubblewrapPath: '/usr/bin/bwrap',
    });
    expect(JSON.stringify(receipt)).not.toContain(secret);
    expect(receipt.steps[0]?.stdoutTail).toContain('[REDACTED]');
    expect(
      Buffer.byteLength(receipt.steps[0]?.stdoutTail ?? '') +
        Buffer.byteLength(receipt.steps[0]?.stderrTail ?? ''),
    ).toBeLessThanOrEqual(256);
    },
  );

  it('fails closed when a required host boundary is unavailable', async () => {
    const dir = await workspace();
    const receipt = await runCliEvidence({
      plan: plan({ id: 'boundary', argv: ['node', '--version'] }),
      workspaceDir: dir,
      executionPolicy: effectiveRepoExecutionPolicy({ profile: 'guardian' }),
      bubblewrapPath: null,
    });
    expect(receipt.status).toBe('failed');
    expect(receipt.steps[0]?.status).toBe('sandbox_error');
  });

  it('honors optional failures and marks later required steps passed', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'scripts', 'exit.py'), 'import sys\nsys.exit(3)\n');
    const receipt = await runCliEvidence({
      plan: parseCliEvidenceConfig({
        version: 1,
        steps: [
          { id: 'optional', argv: ['python3', 'scripts/exit.py'], optional: true },
          { id: 'required', argv: ['python3', '--version'] },
        ],
      })!,
      workspaceDir: dir,
    });
    expect(receipt.status, JSON.stringify(receipt)).toBe('passed');
    expect(receipt.steps.map((step) => step.status)).toEqual(['failed', 'passed']);
    expect(receipt.steps[0]?.ok).toBe(true);
  });

  it('marks remaining steps not-run after a required failure', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'scripts', 'fail.py'), 'import sys\nsys.exit(1)\n');
    const receipt = await runCliEvidence({
      plan: parseCliEvidenceConfig({
        version: 1,
        steps: [
          { id: 'failed', argv: ['python3', 'scripts/fail.py'] },
          { id: 'later', argv: ['python3', '--version'] },
        ],
      })!,
      workspaceDir: dir,
    });
    expect(receipt.status).toBe('failed');
    expect(receipt.steps.map((step) => step.status)).toEqual(['failed', 'not_run']);
  });
});

describe('CLI evidence artifacts_dir collection', () => {
  it('collects png/webm, skips txt and oversized, records sha256 and skip note', async () => {
    const dir = await workspace();
    const artDir = join(dir, 'target', 'hercules-ui-evidence');
    await mkdir(artDir, { recursive: true });
    await writeFile(join(dir, 'scripts', 'write-arts.py'),
      'print("wrote-arts")\n');
    await writeFile(join(artDir, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
    await writeFile(join(artDir, 'b.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
    await writeFile(join(artDir, 'clip.webm'), Buffer.from('webm-fake-bytes'));
    await writeFile(join(artDir, 'notes.txt'), 'not media\n');
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 7);
    await writeFile(join(artDir, 'too-big.png'), oversized);

    const evidenceDir = join(dir, 'evidence-out');
    const receipt = await runCliEvidence({
      plan: plan({
        id: 'web-console-flow',
        argv: ['python3', 'scripts/write-arts.py'],
        artifacts_dir: 'target/hercules-ui-evidence',
        expect: { stdout_contains: 'wrote-arts' },
      }),
      workspaceDir: dir,
      evidenceDir,
      taskId: 'T-arts',
    });
    expect(receipt.status, JSON.stringify(receipt)).toBe('passed');
    const step = receipt.steps[0]!;
    expect(step.artifacts).toHaveLength(3);
    expect(step.artifacts!.map((a) => a.name).sort()).toEqual([
      'cli-web-console-flow-a.png',
      'cli-web-console-flow-b.png',
      'cli-web-console-flow-clip.webm',
    ].sort());
    for (const art of step.artifacts!) {
      expect(art.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(art.bytes).toBeGreaterThan(0);
      expect(['image', 'video']).toContain(art.kind);
      await expect(access(join(evidenceDir, art.name))).resolves.toBeUndefined();
    }
    expect(step.artifacts!.find((a) => a.name.endsWith('.webm'))?.kind).toBe('video');
    expect(step.artifactsSkipped).toMatch(/too-big\.png/i);
    // Disallowed .txt is ignored (not collected, not necessarily named in skip).
    expect(step.artifacts!.every((a) => !a.name.includes('notes'))).toBe(true);
  });

  it('refuses a symlinked artifacts_dir that escapes the workspace', async () => {
    const dir = await workspace();
    const outside = join(dir, '..', 'outside-arts-' + basename(dir));
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'escape.png'), Buffer.from([0x89, 0x50]));
    await mkdir(join(dir, 'target'), { recursive: true });
    await symlink(outside, join(dir, 'target', 'hercules-ui-evidence'));
    await writeFile(join(dir, 'scripts', 'ok.py'), 'print("ok")\n');
    const evidenceDir = join(dir, 'evidence-out');
    const receipt = await runCliEvidence({
      plan: plan({
        id: 'link-escape',
        argv: ['python3', 'scripts/ok.py'],
        artifacts_dir: 'target/hercules-ui-evidence',
        expect: { stdout_contains: 'ok' },
      }),
      workspaceDir: dir,
      evidenceDir,
    });
    expect(receipt.status).toBe('passed');
    expect(receipt.steps[0]?.artifacts ?? []).toHaveLength(0);
    expect(receipt.steps[0]?.artifactsSkipped).toMatch(/symlink|escape|refused/i);
  });

  it('enforces the per-step file count cap', async () => {
    const dir = await workspace();
    const artDir = join(dir, 'shots');
    await mkdir(artDir, { recursive: true });
    for (let i = 0; i < 26; i += 1) {
      const name = 'f' + String(i).padStart(2, '0') + '.png';
      await writeFile(join(artDir, name), Buffer.from([0x89, i & 0xff]));
    }
    await writeFile(join(dir, 'scripts', 'ok.py'), 'print("ok")\n');
    const evidenceDir = join(dir, 'evidence-out');
    const receipt = await runCliEvidence({
      plan: plan({
        id: 'cap',
        argv: ['python3', 'scripts/ok.py'],
        artifacts_dir: 'shots',
        expect: { stdout_contains: 'ok' },
      }),
      workspaceDir: dir,
      evidenceDir,
    });
    expect(receipt.steps[0]?.artifacts).toHaveLength(24);
    expect(receipt.steps[0]?.artifactsSkipped).toMatch(/file cap/i);
  });

  it('pins artifacts_dir identity across a rename/symlink swap after listing (B1)', async () => {
    const dir = await workspace();
    const artDir = join(dir, 'art');
    await mkdir(artDir, { recursive: true });
    await writeFile(join(artDir, 'secret.png'), 'inside');
    const outside = join(dir, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.png'), 'OUTSIDE-SYNTHETIC-CANARY');
    const evidenceDir = join(dir, 'evidence-out');
    const insideSha = createHash('sha256').update('inside').digest('hex');
    const collected = await collectCliEvidenceArtifacts(
      {
        workspaceRoot: dir,
        artifactsDir: 'art',
        stepId: 'flow',
        evidenceDir,
      },
      {
        readdir: async (path) => {
          const entries = await readdir(path);
          await rename(artDir, join(dir, 'art-old'));
          await symlink(outside, artDir);
          return entries;
        },
      },
    );
    const served = collected.artifacts.find((a) => a.name.includes('secret'));
    if (served !== undefined) {
      expect(served.sha256).toBe(insideSha);
      const bytes = await readFile(join(evidenceDir, served.name), 'utf8');
      expect(bytes).toBe('inside');
      expect(bytes).not.toContain('OUTSIDE');
    } else {
      expect(collected.artifactsSkipped ?? '').toMatch(/secret/i);
    }
    expect(
      collected.artifacts.every((a) => a.sha256 !== createHash('sha256').update('OUTSIDE-SYNTHETIC-CANARY').digest('hex')),
    ).toBe(true);
  });

  it('skips a FIFO with an allowed extension instead of blocking (R11 B3)', async () => {
    const dir = await workspace();
    const artDir = join(dir, 'art');
    await mkdir(artDir, { recursive: true });
    execFileSync('mkfifo', [join(artDir, 'hang.png')]);
    await writeFile(join(artDir, 'ok.png'), 'inside');
    const evidenceDir = join(dir, 'evidence-out');
    const started = Date.now();
    const collected = await collectCliEvidenceArtifacts({
      workspaceRoot: dir,
      artifactsDir: 'art',
      stepId: 'fifo',
      evidenceDir,
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(collected.artifacts.map((a) => a.name)).toEqual(['cli-fifo-ok.png']);
    expect(collected.artifactsSkipped).toMatch(/hang\.png not a regular file/);
  });

  it('skips an entry that becomes a symlink between listing and open (B1)', async () => {
    const dir = await workspace();
    const artDir = join(dir, 'art');
    await mkdir(artDir, { recursive: true });
    await writeFile(join(artDir, 'flip.png'), 'inside');
    await writeFile(join(dir, 'elsewhere.png'), 'other');
    const evidenceDir = join(dir, 'evidence-out');
    const collected = await collectCliEvidenceArtifacts(
      {
        workspaceRoot: dir,
        artifactsDir: 'art',
        stepId: 'flip',
        evidenceDir,
      },
      {
        readdir: async (path) => {
          const entries = await readdir(path);
          await unlink(join(artDir, 'flip.png'));
          await symlink(join(dir, 'elsewhere.png'), join(artDir, 'flip.png'));
          return entries;
        },
      },
    );
    expect(collected.artifacts).toHaveLength(0);
    expect(collected.artifactsSkipped).toMatch(/flip\.png.*symlink skipped/i);
  });

  it('bounds skip notes so 80 long-named symlinks still round-trip a receipt (B3)', async () => {
    const dir = await workspace();
    const artDir = join(dir, 'art');
    await mkdir(artDir, { recursive: true });
    await writeFile(join(dir, 'target.png'), 'x');
    for (let i = 0; i < 80; i += 1) {
      const name = 'long-artifact-name-' + String(i) + '-'.repeat(45) + '.png';
      await symlink(join(dir, 'target.png'), join(artDir, name));
    }
    const evidenceDir = join(dir, 'evidence-out');
    const collected = await collectCliEvidenceArtifacts({
      workspaceRoot: dir,
      artifactsDir: 'art',
      stepId: 'flow',
      evidenceDir,
    });
    expect(collected.artifacts).toHaveLength(0);
    expect(collected.artifactsSkipped).toBeDefined();
    expect(Buffer.from(collected.artifactsSkipped!, 'utf8').byteLength).toBeLessThanOrEqual(1024);
    expect(collected.artifactsSkipped).toMatch(/\+72 more skipped$/);

    const planCfg = parseCliEvidenceConfig({
      version: 1,
      steps: [{ id: 'flow', argv: ['node', 'scripts/a.mjs'] }],
    })!;
    expect(collected.artifactsSkipped).toEqual(expect.any(String));
    const receipt = assembleCliEvidenceReceipt({
      plan: planCfg,
      durationMs: 1,
      steps: [{
        id: 'flow',
        argv: ['node', 'scripts/a.mjs'],
        cwd: '.',
        status: 'passed',
        exitCode: 0,
        durationMs: 1,
        stdoutTail: '',
        stderrTail: '',
        assertions: [{ name: 'exit_code', ok: true, detail: '0' }],
        ok: true,
        optional: false,
        artifactsSkipped: collected.artifactsSkipped!,
      }],
    });
    const md = renderPacketMarkdown(assembleReviewPacket({
      taskId: 'T-skip',
      branch: 'hercules/T-skip',
      filesTouched: [],
      diffSummary: '',
      cheatFindings: [],
      selfAssessment: '',
      gates: [{ name: 'test', command: 't', passed: true, output: '' }],
      reviewerVerdict: { approved: true, summary: 'ok', comments: [] },
      screenshots: [],
      cliEvidence: receipt,
    }));
    expect(extractCliEvidenceReceipt(md)).not.toBeNull();
    expect(extractCliEvidenceReceipt(md)?.steps[0]?.artifactsSkipped).toMatch(/\+72 more skipped/);
    expect(formatCliEvidenceReceipt(receipt)).toContain('artifacts skipped');
  });
});

describe.skipIf(!hasExecutableBwrap)('CLI evidence host boundary', () => {
  it.runIf(process.platform === 'linux')(
    'provides private writable temp space without exposing host temp files',
    async () => {
      const dir = await workspace();
      const suffix = basename(dir);
      const hostSentinel = join(tmpdir(), `cli-evidence-host-${suffix}`);
      const privateProbe = `/tmp/hercules-cli/private-${suffix}`;
      await writeFile(hostSentinel, 'host-secret\n');
      await writeFile(
        join(dir, 'scripts', 'private-temp.py'),
        `from pathlib import Path\n` +
          `assert not Path(${JSON.stringify(hostSentinel)}).exists()\n` +
          `Path(${JSON.stringify(privateProbe)}).write_text('private-ok')\n` +
          `print(Path(${JSON.stringify(privateProbe)}).read_text())\n`,
      );
      try {
        const receipt = await runCliEvidence({
          plan: plan({
            id: 'private-temp',
            argv: ['python3', 'scripts/private-temp.py'],
            expect: { stdout_contains: 'private-ok' },
          }),
          workspaceDir: dir,
          executionPolicy: effectiveRepoExecutionPolicy({ profile: 'guardian' }),
        });
        expect(receipt.status, JSON.stringify(receipt)).toBe('passed');
      } finally {
        await unlink(hostSentinel);
      }
    },
  );

  it.runIf(process.platform === 'linux' && hasHostCargo)(
    'keeps the host Rust toolchain executable inside the Guardian boundary',
    async () => {
      const dir = await workspace();
      const home = homedir();
      const receipt = await runCliEvidence({
        plan: plan({ id: 'rust-toolchain', argv: ['cargo', '--version'] }),
        workspaceDir: dir,
        executionPolicy: effectiveRepoExecutionPolicy({ profile: 'guardian' }),
        rustToolchainHome: home,
        // Matches the systemd daemon PATH: cargo is exposed only through the
        // masked ~/.local symlink unless the trusted mount adds ~/.cargo/bin.
        sourceEnv: {
          ...process.env,
          HOME: home,
          PATH: `${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
        },
      });
      expect(receipt.status, JSON.stringify(receipt)).toBe('passed');
    },
  );

  it('rejects a symlink cwd escape before spawn', async () => {
    const dir = await workspace();
    await symlink(tmpdir(), join(dir, 'outside'));
    const receipt = await runCliEvidence({
      plan: plan({ id: 'escape', argv: ['node', '--version'], cwd: 'outside' }),
      workspaceDir: dir,
    });
    expect(receipt.steps[0]?.status).toBe('workspace_escape');
  });

  it('denies writes outside the workspace under workspace sandbox policy', async () => {
    const dir = await workspace();
    const outside = join(dir, '..', 'outside-' + basename(dir));
    await expect(access(outside)).rejects.toThrow();
    await writeFile(
      join(dir, 'scripts', 'write-outside.py'),
      `import pathlib, sys\ntry:\n pathlib.Path(${JSON.stringify(outside)}).write_text('bad')\n sys.exit(9)\n` +
        `except OSError:\n print('write-blocked')\n`,
    );
    const policy = effectiveRepoExecutionPolicy({
      sandbox: 'workspace', network: 'unrestricted', workspaceWrite: true,
    });
    const receipt = await runCliEvidence({
      plan: plan({
        id: 'write', argv: ['python3', 'scripts/write-outside.py'],
        expect: { stdout_contains: 'write-blocked' },
      }),
      workspaceDir: dir,
      executionPolicy: policy,
    });
    expect(receipt.status, JSON.stringify(receipt)).toBe('passed');
    await expect(access(outside)).rejects.toThrow();
  });

  it('mounts worktree Git metadata read-only inside a writable workspace', async () => {
    const dir = await workspace();
    await writeFile(join(dir, '.git'), 'gitdir: /trusted/mirror/worktrees/example\n');
    await writeFile(
      join(dir, 'scripts', 'git-metadata.py'),
      `from pathlib import Path\ntry:\n Path('.git').write_text('rewired')\n raise SystemExit(9)\n` +
        `except OSError:\n print('git-metadata-blocked')\n`,
    );
    const receipt = await runCliEvidence({
      plan: plan({
        id: 'git-metadata', argv: ['python3', 'scripts/git-metadata.py'],
        expect: { stdout_contains: 'git-metadata-blocked' },
      }),
      workspaceDir: dir,
      executionPolicy: effectiveRepoExecutionPolicy({
        sandbox: 'workspace', network: 'unrestricted', workspaceWrite: true,
      }),
    });
    expect(receipt.status).toBe('passed');
    expect(await readFile(join(dir, '.git'), 'utf8')).toContain('/trusted/mirror/');
  });

  it('makes an exact workspace readable but not writable under read-only policy', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'input.txt'), 'readable\n');
    await writeFile(
      join(dir, 'scripts', 'readonly.py'),
      `from pathlib import Path\nprint(Path('input.txt').read_text().strip())\n` +
        `try:\n Path('blocked.txt').write_text('bad')\n raise SystemExit(9)\n` +
        `except OSError:\n print('write-blocked')\n`,
    );
    const receipt = await runCliEvidence({
      plan: plan({
        id: 'readonly', argv: ['python3', 'scripts/readonly.py'],
        expect: { stdout_contains: 'readable\nwrite-blocked' },
      }),
      workspaceDir: dir,
      executionPolicy: effectiveRepoExecutionPolicy({
        sandbox: 'read-only', network: 'unrestricted', workspaceWrite: false,
      }),
    });
    expect(receipt.status, JSON.stringify(receipt)).toBe('passed');
    await expect(access(join(dir, 'blocked.txt'))).rejects.toThrow();
  });

  it('keeps the exact workspace executable for a network-off-only boundary', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'scripts', 'offline.py'), 'print("offline-workspace-ok")\n');
    const receipt = await runCliEvidence({
      plan: plan({
        id: 'offline-only', argv: ['python3', 'scripts/offline.py'],
        expect: { stdout_contains: 'offline-workspace-ok' },
      }),
      workspaceDir: dir,
      executionPolicy: effectiveRepoExecutionPolicy({
        sandbox: 'none', network: 'off', workspaceWrite: false,
      }),
    });
    expect(receipt.status, JSON.stringify(receipt)).toBe('passed');
  });

  it('enforces network off with a separate network namespace', async () => {
    const dir = await workspace();
    const server = createServer((socket) => socket.end('reachable'));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');
    await writeFile(
      join(dir, 'scripts', 'network.py'),
      `import socket, sys\ns = socket.socket()\ns.settimeout(.3)\ntry:\n` +
        ` s.connect(('127.0.0.1', int(sys.argv[1])))\n sys.exit(9)\n` +
        `except OSError:\n print('network-blocked')\n`,
    );
    try {
      const receipt = await runCliEvidence({
        plan: plan({
          id: 'network', argv: ['python3', 'scripts/network.py', String(address.port)],
          expect: { stdout_contains: 'network-blocked' },
        }),
        workspaceDir: dir,
        executionPolicy: effectiveRepoExecutionPolicy({ profile: 'guardian' }),
      });
      expect(receipt.status).toBe('passed');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('blocks variables and host proc environ recovery', async () => {
    const dir = await workspace();
    const secret = 'parent-proc-secret-9274';
    const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      env: { ...process.env, BLOCKED_ENV: secret },
      stdio: 'ignore',
    });
    if (!helper.pid) throw new Error('secret helper failed to start');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await readFile('/proc/' + String(helper.pid) + '/environ', 'utf8')).toContain(secret);
    await writeFile(
      join(dir, 'scripts', 'proc.py'),
      `import os, pathlib, sys\nsecret=${JSON.stringify(secret)}\n` +
        `found=os.environ.get('BLOCKED_ENV') == secret\n` +
        `for p in pathlib.Path('/proc').iterdir():\n` +
        ` if not p.name.isdigit(): continue\n` +
        ` try:\n  found = found or secret.encode() in (p / 'environ').read_bytes()\n` +
        ` except OSError:\n  pass\n` +
        `print('leaked' if found else 'blocked')\nsys.exit(8 if found else 0)\n`,
    );
    try {
      const receipt = await runCliEvidence({
        plan: plan({
          id: 'proc', argv: ['python3', 'scripts/proc.py'],
          expect: { stdout_contains: 'blocked' },
        }),
        workspaceDir: dir,
        executionPolicy: effectiveRepoExecutionPolicy({
          sandbox: 'workspace', network: 'unrestricted', workspaceWrite: true,
        }),
        sourceEnv: { ...process.env, BLOCKED_ENV: secret },
      });
      expect(receipt.status).toBe('passed');
      expect(JSON.stringify(receipt)).not.toContain(secret);
    } finally {
      helper.kill('SIGKILL');
      await new Promise<void>((resolve) => helper.once('close', () => resolve()));
    }
  });

  it('hides host sensitive roots while keeping workspace tools executable', async () => {
    const dir = await workspace();
    const canary = join(homedir(), '.cli-evidence-canary-' + basename(dir));
    await writeFile(canary, 'host-sensitive-canary\n');
    await writeFile(
      join(dir, 'scripts', 'host-roots.py'),
      `from pathlib import Path\np=Path(${JSON.stringify(canary)})\n` +
        `print('hidden' if not p.exists() else p.read_text())\nprint('workspace-tool-ok')\n`,
    );
    try {
      const receipt = await runCliEvidence({
        plan: plan({
          id: 'host-roots', argv: ['python3', 'scripts/host-roots.py'],
          expect: { stdout_contains: 'hidden\nworkspace-tool-ok' },
        }),
        workspaceDir: dir,
        executionPolicy: effectiveRepoExecutionPolicy({ profile: 'guardian' }),
      });
      expect(receipt.status, JSON.stringify(receipt)).toBe('passed');
      expect(JSON.stringify(receipt)).not.toContain('host-sensitive-canary');
    } finally {
      await unlink(canary).catch(() => {});
    }
  });

  it('aborts by throwing and kills the entire process group', async () => {
    const dir = await workspace();
    const marker = join(dir, 'late-marker');
    await writeFile(
      join(dir, 'scripts', 'tree.py'),
      `import subprocess, sys, time\nsubprocess.Popen([sys.executable, '-c', ${JSON.stringify(
        `import pathlib,time; time.sleep(.5); pathlib.Path(${JSON.stringify(marker)}).write_text('late')`,
      )}], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\ntime.sleep(3)\n`,
    );
    const controller = new AbortController();
    const running = runCliEvidence({
      plan: plan({ id: 'cancel', argv: ['python3', 'scripts/tree.py'] }),
      workspaceDir: dir,
      signal: controller.signal,
      executionPolicy: effectiveRepoExecutionPolicy({
        sandbox: 'workspace', network: 'unrestricted', workspaceWrite: true,
      }),
    });
    setTimeout(() => controller.abort(), 80);
    await expect(running).rejects.toBeInstanceOf(VerificationAbortedError);
    await new Promise((resolve) => setTimeout(resolve, 700));
    await expect(access(marker)).rejects.toThrow();
  });

  it('does not leave a detached descendant running after a normal sandbox exit', async () => {
    const dir = await workspace();
    const marker = join(dir, 'detached-late-marker');
    await writeFile(
      join(dir, 'scripts', 'detach.py'),
      `import subprocess, sys\nsubprocess.Popen([sys.executable, '-c', ${JSON.stringify(
        `import pathlib,time; time.sleep(.5); pathlib.Path(${JSON.stringify(marker)}).write_text('late')`,
      )}], start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\nprint('parent-done')\n`,
    );
    const receipt = await runCliEvidence({
      plan: plan({
        id: 'detach', argv: ['python3', 'scripts/detach.py'],
        expect: { stdout_contains: 'parent-done' },
      }),
      workspaceDir: dir,
      executionPolicy: effectiveRepoExecutionPolicy({
        sandbox: 'workspace', network: 'unrestricted', workspaceWrite: true,
      }),
    });
    expect(receipt.status, JSON.stringify(receipt)).toBe('passed');
    await new Promise((resolve) => setTimeout(resolve, 700));
    await expect(access(marker)).rejects.toThrow();
  });
});
