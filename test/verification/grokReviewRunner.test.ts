import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  buildGrokReviewArgs,
  createAnalystSandboxHealthCheck,
  createGrokReviewRunner,
  firstStderrLine,
  type ReviewSpawn,
} from '../../src/verification/grokReviewRunner.js';
import { ReviewerInfraError } from '../../src/verification/reviewer.js';
import type { AnalystActivity } from '../../src/domain/analystActivity.js';
import { isVerificationAborted } from '../../src/domain/verificationRun.js';
import { effectiveRepoExecutionPolicy } from '../../src/domain/repoExecutionPolicy.js';

describe('buildGrokReviewArgs', () => {
  it('uses a fail-closed read-only policy without shell or blanket approval', () => {
    const args = buildGrokReviewArgs('review this', 'grok-test');
    expect(args).toContain('dontAsk');
    expect(args).toContain('read-only');
    expect(args).toContain('read_file,grep,list_dir');
    expect(args).toContain('--disable-web-search');
    expect(args).not.toContain('--always-approve');
    expect(args.join('\n')).not.toMatch(/\b(?:Bash|Edit)\b/);
    expect(args).toContain('grok-test');
  });

  it('appends --reasoning-effort only when set, keeping existing policy args', () => {
    const withEffort = buildGrokReviewArgs('x', 'grok-test', { reasoningEffort: 'low' });
    expect(withEffort.slice(-2)).toEqual(['--reasoning-effort', 'low']);
    expect(withEffort).toContain('dontAsk');
    expect(withEffort).toContain('read-only');
    expect(withEffort).toContain('read_file,grep,list_dir');
    expect(withEffort).toContain('--disable-web-search');

    expect(buildGrokReviewArgs('x', 'grok-test')).not.toContain('--reasoning-effort');
    expect(buildGrokReviewArgs('x', 'grok-test', {})).not.toContain('--reasoning-effort');
  });

  it('honors outputFormat streaming-json and defaults to plain at the same index', () => {
    const streaming = buildGrokReviewArgs('x', 'grok-test', {
      outputFormat: 'streaming-json',
    });
    const fmtIdx = streaming.indexOf('--output-format');
    expect(fmtIdx).toBeGreaterThanOrEqual(0);
    expect(streaming[fmtIdx + 1]).toBe('streaming-json');
    expect(streaming).toContain('dontAsk');
    expect(streaming).toContain('read-only');
    expect(streaming).toContain('read_file,grep,list_dir');
    expect(streaming).toContain('--disable-web-search');
    expect(streaming).toContain('Read');
    expect(streaming).toContain('Grep');

    const plain = buildGrokReviewArgs('x', 'grok-test');
    expect(plain.indexOf('--output-format')).toBe(fmtIdx);
    expect(plain[fmtIdx + 1]).toBe('plain');
  });

  it('createGrokReviewRunner passes --reasoning-effort low when configured', async () => {
    const captured: string[][] = [];
    const spawn: ReviewSpawn = (_cmd, args, _opts) => {
      captured.push([...args]);
      const fake = fakeChild();
      setImmediate(() => {
        fake.stdout.end('```json\n{"title":"t","body":"b"}\n```');
        fake.child.emit('close', 0, null);
      });
      return fake.child;
    };
    const run = createGrokReviewRunner({
      spawn,
      reasoningEffort: 'low',
      outputContract: 'freeform',
    });
    await expect(run('draft')).resolves.toContain('"title":"t"');
    expect(captured).toHaveLength(1);
    const args = captured[0]!;
    expect(args.slice(-2)).toEqual(['--reasoning-effort', 'low']);
  });

  it('sandbox profile defaults to read-only and is overridable; rules appended only when set', () => {
    const dflt = buildGrokReviewArgs('x', 'grok-test');
    const sbIdx = dflt.indexOf('--sandbox');
    expect(dflt[sbIdx + 1]).toBe('read-only');
    expect(dflt).not.toContain('--rules');

    const confined = buildGrokReviewArgs('x', 'grok-test', {
      sandbox: 'hercules-analyst',
      rules: 'stay home',
    });
    expect(confined.indexOf('--sandbox')).toBe(sbIdx);
    expect(confined[sbIdx + 1]).toBe('hercules-analyst');
    const rulesIdx = confined.indexOf('--rules');
    expect(rulesIdx).toBeGreaterThan(confined.indexOf('--disable-web-search'));
    expect(confined[rulesIdx + 1]).toBe('stay home');
    // Everything before the sandbox value is byte-identical to the default policy.
    expect(confined.slice(0, sbIdx + 1)).toEqual(dflt.slice(0, sbIdx + 1));
  });

  it('rejects sandbox profile names that are not plain tokens (argv injection guard)', () => {
    expect(() => buildGrokReviewArgs('x', 'grok-test', { sandbox: 'x y' })).toThrow(
      'invalid sandbox profile',
    );
    expect(() => buildGrokReviewArgs('x', 'grok-test', { sandbox: '../evil' })).toThrow(
      'invalid sandbox profile',
    );
    expect(() => buildGrokReviewArgs('x', 'grok-test', { sandbox: '' })).toThrow(
      'invalid sandbox profile',
    );
  });

  it('createGrokReviewRunner passes sandbox/rules and lets a run override cwd', async () => {
    const captured: { args: string[]; cwd: string | undefined }[] = [];
    const spawn: ReviewSpawn = (_cmd, args, opts) => {
      captured.push({ args: [...args], cwd: opts.cwd });
      const fake = fakeChild();
      setImmediate(() => {
        fake.stdout.end('```json\n{"title":"t","body":"b"}\n```');
        fake.child.emit('close', 0, null);
      });
      return fake.child;
    };
    const run = createGrokReviewRunner({
      spawn,
      cwd: '/default',
      sandbox: 'hercules-analyst',
      rules: 'r',
      outputContract: 'freeform',
    });
    await expect(run('draft', { cwd: '/snap' })).resolves.toContain('"title":"t"');
    await expect(run('draft')).resolves.toContain('"title":"t"');
    expect(captured).toHaveLength(2);
    expect(captured[0]!.cwd).toBe('/snap');
    expect(captured[1]!.cwd).toBe('/default');
    for (const c of captured) {
      const sbIdx = c.args.indexOf('--sandbox');
      expect(c.args[sbIdx + 1]).toBe('hercules-analyst');
      expect(c.args[c.args.indexOf('--rules') + 1]).toBe('r');
    }
  });

  it('createGrokReviewRunner passes GROK_HOME via opts.env to the spawned child', async () => {
    const envs: NodeJS.ProcessEnv[] = [];
    const spawn: ReviewSpawn = (_cmd, _args, opts) => {
      envs.push(opts.env);
      const fake = fakeChild();
      setImmediate(() => {
        fake.stdout.end('```json\n{"title":"t","body":"b"}\n```');
        fake.child.emit('close', 0, null);
      });
      return fake.child;
    };
    const privateHome = '/tmp/analyst-private-grok-home';
    const run = createGrokReviewRunner({
      spawn,
      outputContract: 'freeform',
      sandbox: 'hercules-analyst',
      env: { ...process.env, GROK_HOME: privateHome },
    });
    await expect(run('draft')).resolves.toContain('"title":"t"');
    expect(envs).toHaveLength(1);
    expect(envs[0]!['GROK_HOME']).toBe(privateHome);
  });
});

describe('createAnalystSandboxHealthCheck', () => {
  it('logs sandbox ok with grok version on a clean PONG', async () => {
    const logs: string[] = [];
    let call = 0;
    const spawn: ReviewSpawn = (_cmd, args) => {
      call += 1;
      const fake = fakeChild();
      setImmediate(() => {
        if (args[0] === '--version') {
          fake.stdout.end('grok 1.0.13 (abc) [stable]\n');
        } else {
          expect(args).toContain('PONG');
          expect(args[args.indexOf('--sandbox') + 1]).toBe('hercules-analyst');
          fake.stdout.end('PONG received.\n');
        }
        fake.child.emit('close', 0, null);
      });
      return fake.child;
    };
    const ok = await createAnalystSandboxHealthCheck({
      spawn,
      cwd: '/probe',
      env: { ...process.env, GROK_HOME: '/private' },
      sandbox: 'hercules-analyst',
      log: (line) => {
        logs.push(line);
      },
    })();
    expect(ok).toBe(true);
    expect(logs.some((l) => /analyst: sandbox ok \(grok 1\.0\.13\)/.test(l))).toBe(true);
    expect(call).toBeGreaterThanOrEqual(2);
  });

  it('logs UNAVAILABLE with the first refusing-to-start stderr line', async () => {
    const logs: string[] = [];
    const spawn: ReviewSpawn = (_cmd, args) => {
      const fake = fakeChild();
      setImmediate(() => {
        if (args[0] === '--version') {
          fake.stdout.end('grok 1.0.13\n');
          fake.child.emit('close', 0, null);
          return;
        }
        fake.stderr.end(
          'sandbox reports bwrap but required read-deny mounts are not in effect (read-deny path /home/u/.grok/continuity could not be opened: Permission denied) ; refusing to start\n',
        );
        fake.child.emit('close', 1, null);
      });
      return fake.child;
    };
    const ok = await createAnalystSandboxHealthCheck({
      spawn,
      cwd: '/probe',
      env: { GROK_HOME: '/private' },
      sandbox: 'hercules-analyst',
      log: (line) => {
        logs.push(line);
      },
    })();
    expect(ok).toBe(false);
    expect(logs.some((l) => /analyst: UNAVAILABLE — .*refusing to start/.test(l))).toBe(
      true,
    );
  });

  it('firstStderrLine redacts secrets and bounds length', () => {
    const line = firstStderrLine(
      'Authorization: Bearer sk-live-abc123token\nrefusing to start\n',
      80,
    );
    expect(line).not.toContain('sk-live');
    expect(line.length).toBeLessThanOrEqual(80);
  });
});

function fakeChild(pid = 4242): {
  child: ChildProcessWithoutNullStreams;
  stdout: PassThrough;
  stderr: PassThrough;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    pid,
    stdin: new PassThrough(),
    stdout,
    stderr,
    kill: vi.fn(() => true),
  });
  return { child, stdout, stderr };
}

describe('reviewer infrastructure failures are typed — never a fabricated verdict', () => {
  it('missing-credential exit propagates as ReviewerInfraError with the stderr cause', async () => {
    const { child, stderr } = fakeChild();
    const run = createGrokReviewRunner({ timeoutMs: 60_000, spawn: () => child });

    const pending = run('review me');
    stderr.write('Error: Not signed in. To authenticate without a browser, run:\n');
    child.emit('close', 1, null);

    await expect(pending).rejects.toBeInstanceOf(ReviewerInfraError);
    await expect(pending).rejects.toThrow(/Not signed in/);
    await expect(pending).rejects.not.toThrow(/changes_requested/i);
    await pending.catch((err: unknown) => {
      expect(isVerificationAborted(err)).toBe(false);
    });
  });

  it('child launch failure (spawn error) propagates as ReviewerInfraError', async () => {
    const { child } = fakeChild();
    const run = createGrokReviewRunner({ timeoutMs: 60_000, spawn: () => child });

    const pending = run('review me');
    child.emit('error', new Error('spawn grok ENOENT'));

    await expect(pending).rejects.toBeInstanceOf(ReviewerInfraError);
    await expect(pending).rejects.toThrow(/ENOENT/);
  });

  it('timeout propagates as ReviewerInfraError, not a verdict', async () => {
    const { child } = fakeChild(7);
    const run = createGrokReviewRunner({
      timeoutMs: 20,
      spawn: () => child,
      killGroup: async () => undefined,
    });

    const pending = run('review me');

    await expect(pending).rejects.toBeInstanceOf(ReviewerInfraError);
    await expect(pending).rejects.toThrow(/timed out/);
  });

  it('empty reviewer output on clean exit is infrastructure failure, not changes_requested', async () => {
    const { child } = fakeChild();
    const run = createGrokReviewRunner({ timeoutMs: 60_000, spawn: () => child });

    const pending = run('review me');
    child.emit('close', 0, null);

    await expect(pending).rejects.toBeInstanceOf(ReviewerInfraError);
    await expect(pending).rejects.not.toThrow(/changes_requested/i);
  });

  it('non-verdict garbage on clean exit is infrastructure failure', async () => {
    const { child, stdout } = fakeChild();
    const run = createGrokReviewRunner({ timeoutMs: 60_000, spawn: () => child });

    const pending = run('review me');
    stdout.write('grok: warning: telemetry disabled\n');
    child.emit('close', 0, null);

    await expect(pending).rejects.toBeInstanceOf(ReviewerInfraError);
  });

  it('freeform contract returns non-empty stdout without a VERDICT line (analyst), empty still fails', async () => {
    const ok = fakeChild();
    const run = createGrokReviewRunner({
      timeoutMs: 60_000,
      spawn: () => ok.child,
      outputContract: 'freeform',
    });
    const pending = run('draft json');
    ok.stdout.write('```json\n{"title":"t","body":"b"}\n```\n');
    ok.child.emit('close', 0, null);
    await expect(pending).resolves.toContain('"title":"t"');

    const empty = fakeChild();
    const runEmpty = createGrokReviewRunner({
      timeoutMs: 60_000,
      spawn: () => empty.child,
      outputContract: 'freeform',
    });
    const pendingEmpty = runEmpty('draft json');
    empty.child.emit('close', 0, null);
    await expect(pendingEmpty).rejects.toBeInstanceOf(ReviewerInfraError);
  });

  it('non-zero exit is ReviewerInfraError even when stdout contains verdict-like text', async () => {
    // A dirty exit means the child broke its review contract — stdout must not
    // be salvaged into L3 evidence.
    const { child, stdout } = fakeChild();
    const run = createGrokReviewRunner({ timeoutMs: 60_000, spawn: () => child });

    const pending = run('review me');
    stdout.write('critique...\nVERDICT: changes_requested\nSUMMARY: real review\n');
    child.emit('close', 1, null);

    await expect(pending).rejects.toBeInstanceOf(ReviewerInfraError);
  });

  it.each([
    ['VERDICT: approved_but_unverified'],
    ['VERDICT: changes_requested_later'],
    ['VERDICT: approve'],
    ['VERDICT: maybe fine'],
    ['VERDICT: approved\nVERDICT: changes_requested'],
    ['VERDICT: approved\nVERDICT: approved_but_unverified'],
    ['VERDICT: changes_requested\nVERDICT: wat'],
  ])('inexact or conflicting verdict %j on clean exit is ReviewerInfraError', async (line) => {
    const { child, stdout } = fakeChild();
    const run = createGrokReviewRunner({ timeoutMs: 60_000, spawn: () => child });

    const pending = run('review me');
    stdout.write(`critique...\n${line}\nSUMMARY: x\n`);
    child.emit('close', 0, null);

    await expect(pending).rejects.toBeInstanceOf(ReviewerInfraError);
  });

  it('exact verdict lines on clean exit are the reviewer response (case-insensitive)', async () => {
    const { child, stdout } = fakeChild();
    const run = createGrokReviewRunner({ timeoutMs: 60_000, spawn: () => child });

    const pending = run('review me');
    stdout.write('critique...\n  VERDICT: Changes_Requested  \nSUMMARY: real review\n');
    child.emit('close', 0, null);

    await expect(pending).resolves.toContain('Changes_Requested');
  });

  it('redacts secret-bearing stderr values from the durable infra error', async () => {
    const { child, stderr } = fakeChild();
    const run = createGrokReviewRunner({ timeoutMs: 60_000, spawn: () => child });

    const pending = run('review me');
    stderr.write('Error: Not signed in\n');
    stderr.write('Authorization: Bearer sk-live-abc123token\n');
    stderr.write('XAI_API_KEY=xai-supersecret999\n');
    stderr.write('DATABASE_URL=postgres://dbuser:dbpass@db.internal:5432/app\n');
    stderr.write('fetch https://ci-bot:hunter2@git.example.com/repo failed\n');
    child.emit('close', 1, null);

    const err: unknown = await pending.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ReviewerInfraError);
    const msg = (err as Error).message;
    // Safe reason survives; secret values never reach the task body.
    expect(msg).toContain('Not signed in');
    expect(msg).not.toContain('sk-live-abc123token');
    expect(msg).not.toContain('xai-supersecret999');
    expect(msg).not.toContain('dbpass');
    expect(msg).not.toContain('hunter2');
    expect(msg.length).toBeLessThan(400);
  });
});

describe('createGrokReviewRunner streaming freeform', () => {
  const fenceText = '```json\n{"title":"t","body":"b"}\n```';
  const ndjsonLines = [
    JSON.stringify({ type: 'thought', data: 'pondering' }),
    JSON.stringify({
      type: 'tool_call',
      toolCallId: 'tc1',
      title: 'grep',
      kind: 'search',
      status: 'pending',
      toolName: 'grep',
      rawInput: { pattern: 'foo' },
    }),
    JSON.stringify({ type: 'usage', tokens: 1 }),
    'not json',
    JSON.stringify({ type: 'text', data: 'Hello ' }),
    JSON.stringify({ type: 'text', data: fenceText }),
    JSON.stringify({ type: 'end', stopReason: 'end_turn' }),
  ];
  const fullNdjson = `${ndjsonLines.join('\n')}\n`;

  it('parses NDJSON across chunk boundaries and emits thought/tool/text', async () => {
    const captured: string[][] = [];
    const events: AnalystActivity[] = [];
    const fake = fakeChild();
    const spawn: ReviewSpawn = (_cmd, args) => {
      captured.push([...args]);
      return fake.child;
    };
    const run = createGrokReviewRunner({
      spawn,
      outputContract: 'freeform',
      timeoutMs: 60_000,
    });

    const pending = run('draft', {
      onActivity: (a) => {
        events.push(a);
      },
    });

    // Split mid-line so the carry buffer must reassemble a tool_call line.
    const splitAt = fullNdjson.indexOf('"toolName"') + 5;
    expect(splitAt).toBeGreaterThan(5);
    fake.stdout.write(fullNdjson.slice(0, splitAt));
    fake.stdout.write(fullNdjson.slice(splitAt));
    fake.child.emit('close', 0, null);

    await expect(pending).resolves.toBe(`Hello ${fenceText}`);
    expect(captured[0]).toContain('streaming-json');
    expect(events).toEqual([
      { kind: 'thought', delta: 'pondering' },
      { kind: 'tool', tool: 'grep', target: 'foo' },
      { kind: 'text', delta: 'Hello ' },
      { kind: 'text', delta: fenceText },
    ]);
  });

  it('listener throws do not fail the run', async () => {
    const fake = fakeChild();
    const run = createGrokReviewRunner({
      spawn: () => fake.child,
      outputContract: 'freeform',
      timeoutMs: 60_000,
    });
    const pending = run('draft', {
      onActivity: () => {
        throw new Error('listener boom');
      },
    });
    fake.stdout.write(fullNdjson);
    fake.child.emit('close', 0, null);
    await expect(pending).resolves.toBe(`Hello ${fenceText}`);
  });

  it('freeform without onActivity still uses plain and returns raw stdout', async () => {
    const captured: string[][] = [];
    const fake = fakeChild();
    const spawn: ReviewSpawn = (_cmd, args) => {
      captured.push([...args]);
      return fake.child;
    };
    const run = createGrokReviewRunner({
      spawn,
      outputContract: 'freeform',
      timeoutMs: 60_000,
    });
    const pending = run('draft');
    const raw = '```json\n{"title":"t","body":"b"}\n```\n';
    fake.stdout.write(raw);
    fake.child.emit('close', 0, null);
    await expect(pending).resolves.toBe(raw.trim());
    expect(captured[0]).not.toContain('streaming-json');
    expect(captured[0]![captured[0]!.indexOf('--output-format') + 1]).toBe('plain');
  });

  it('streaming with only thought/usage/end (no text) is ReviewerInfraError', async () => {
    const fake = fakeChild();
    const run = createGrokReviewRunner({
      spawn: () => fake.child,
      outputContract: 'freeform',
      timeoutMs: 60_000,
    });
    const pending = run('draft', { onActivity: () => undefined });
    const lines = [
      JSON.stringify({ type: 'thought', data: 'hmm' }),
      JSON.stringify({ type: 'usage', tokens: 0 }),
      JSON.stringify({ type: 'end', stopReason: 'end_turn' }),
    ];
    fake.stdout.write(`${lines.join('\n')}\n`);
    fake.child.emit('close', 0, null);
    await expect(pending).rejects.toBeInstanceOf(ReviewerInfraError);
    await expect(pending).rejects.toThrow(/no output/);
  });
});

describe('createGrokReviewRunner env boundary', () => {
  it('review child gets xAI auth only, honoring the repo policy allowlist', async () => {
    const saved = { ...process.env };
    process.env['XAI_API_KEY'] = 'leak-xai';
    process.env['OPENAI_API_KEY'] = 'leak-openai';
    process.env['ANTHROPIC_API_KEY'] = 'leak-anthropic';
    process.env['DATABASE_URL'] = 'postgres://leak';
    process.env['NODE_ENV'] = 'leak-node-env';
    try {
      const envs: NodeJS.ProcessEnv[] = [];
      const spawn: ReviewSpawn = (_cmd, _args, opts) => {
        envs.push(opts.env);
        const fake = fakeChild();
        setImmediate(() => {
          fake.stdout.end('VERDICT: approved\nSUMMARY: ok');
          fake.child.emit('close', 0, null);
        });
        return fake.child;
      };
      const run = createGrokReviewRunner({ spawn });
      const text = await run('short review prompt', {
        executionPolicy: effectiveRepoExecutionPolicy({ envAllowlist: ['PATH'] }),
      });
      expect(text).toContain('VERDICT: approved');
      expect(envs).toHaveLength(1);
      const env = envs[0]!;
      expect(env['XAI_API_KEY']).toBe('leak-xai');
      expect(env['OPENAI_API_KEY']).toBeUndefined();
      expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
      expect(env['DATABASE_URL']).toBeUndefined();
      expect(env['NODE_ENV']).toBeUndefined();
      expect(env['PATH']).toBe(process.env['PATH']);
    } finally {
      process.env = { ...saved } as NodeJS.ProcessEnv;
    }
  });
});
