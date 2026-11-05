import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  GrokAdapter,
  buildGrokArgs,
  extractToolLabel,
  resolveToolActivityLabel,
  type GrokAdapterOptions,
} from '../../src/adapters/grok.js';
import type { ChildLike, SpawnFn } from '../../src/adapters/claude.js';
import type { AgentStartInput } from '../../src/orchestrator/adapter.js';

const input: AgentStartInput = {
  taskId: 'T-1',
  workspace: '/ws/app/T-1',
  prompt: 'fix the bug',
  allocation: { slug: 'T-1', port: 4000, scratchDir: '/ws/app/T-1/.scratch' },
};

/** Controllable fake child — no pid so tests exercise the child.kill fallback. */
class FakeChild extends EventEmitter implements ChildLike {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  lastSignal: NodeJS.Signals | undefined = undefined;
  kill(signal?: NodeJS.Signals): boolean {
    this.lastSignal = signal;
    return true;
  }
  emitEvent(obj: unknown): void {
    this.stdout.write(JSON.stringify(obj) + '\n');
  }
  finish(code: number): void {
    this.emit('exit', code);
  }
}

function harness(opts: GrokAdapterOptions = {}): {
  adapter: GrokAdapter;
  child: FakeChild;
  calls: { command: string; args: readonly string[]; cwd: string; env?: NodeJS.ProcessEnv }[];
} {
  const child = new FakeChild();
  const calls: {
    command: string;
    args: readonly string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
  }[] = [];
  const spawn: SpawnFn = (command, args, o) => {
    calls.push({ command, args, cwd: o.cwd, ...(o.env ? { env: o.env } : {}) });
    return child;
  };
  // Unit stream tests use synthetic paths; skip GROK_HOME unless a case opts in.
  const adapter = new GrokAdapter({ spawn, clock: () => 0, prepareHome: false, ...opts });
  return { adapter, child, calls };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('buildGrokArgs', () => {
  it('builds a fail-closed headless streaming-json invocation for coding', () => {
    const args = buildGrokArgs(input, {});
    expect(args).toContain('-p');
    expect(args).toContain('fix the bug');
    expect(args).toContain('--output-format');
    expect(args).toContain('streaming-json');
    expect(args).toContain('dontAsk');
    expect(args).toContain('workspace');
    // Default class is implement: safe built-ins + H MCP mutation; no shell.
    expect(args).toContain('read_file,grep,list_dir,search_replace');
    expect(args).toContain('run_terminal_command,write');
    expect(args).toContain('Bash');
    expect(args).toContain('MCPTool(hercules_workspace__apply_patch)');
    expect(args).toContain('MCPTool(hercules_workspace__delete_file)');
    expect(args).not.toContain('--always-approve');
    expect(args).toContain('--cwd');
    expect(args).toContain('/ws/app/T-1');
    expect(args).toContain('--disable-web-search');
  });

  it('coding classes strip shell via disallowed-tools + deny Bash', () => {
    for (const executionClass of ['explore', 'implement', 'verify'] as const) {
      const args = buildGrokArgs({ ...input, executionClass }, {});
      expect(args).toContain('dontAsk');
      expect(args).not.toContain('--always-approve');
      expect(args).toContain('--deny');
      expect(args).toContain('Bash');
      // verify is read-only (C3.56): its disallowed CSV also strips the edit surfaces.
      expect(args).toContain(
        executionClass === 'verify'
          ? 'run_terminal_command,write,search_replace,edit'
          : 'run_terminal_command,write',
      );
      const tools = args[args.indexOf('--tools') + 1] ?? '';
      expect(tools).not.toMatch(/run_terminal_command|run_terminal_cmd/);
    }
  });

  it('implement exposes H MCP mutation tools; explore/verify stay constrained', () => {
    const implement = buildGrokArgs({ ...input, executionClass: 'implement' }, {});
    expect(implement).toContain('read_file,grep,list_dir,search_replace');
    expect(implement).toContain('MCPTool(hercules_workspace__apply_patch)');
    expect(implement).toContain('MCPTool(hercules_workspace__delete_file)');

    const explore = buildGrokArgs({ ...input, executionClass: 'explore' }, {});
    expect(explore).toContain('read_file,grep,list_dir,search_replace');
    // verify (C3.56): read-only surface — no edit tool of any kind.
    const verify = buildGrokArgs({ ...input, executionClass: 'verify' }, {});
    expect(verify[verify.indexOf('--tools') + 1]).toBe('read_file,grep,list_dir');
    expect(verify[verify.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(verify).not.toContain('Edit');
    for (const args of [explore, verify]) {
      const tools = args[args.indexOf('--tools') + 1] ?? '';
      expect(tools).not.toMatch(/delete_file|apply_patch|run_terminal_command/);
      expect(args.join(' ')).not.toMatch(/MCPTool\(hercules_workspace__/);
    }
  });

  it('host_operation uses only scoped command allows', () => {
    const args = buildGrokArgs(
      {
        ...input,
        executionClass: 'host_operation',
        hostCommandScope: ['systemctl restart hercules'],
      },
      {},
    );
    expect(args).not.toContain('--always-approve');
    expect(args).toContain('read_file,grep,list_dir,run_terminal_command');
    const tools = args[args.indexOf('--tools') + 1] ?? '';
    expect(tools).not.toMatch(/search_replace|delete_file|apply_patch/);
    expect(args).toContain('off');
    expect(args).toContain('Bash(systemctl restart hercules)');
  });

  it('deploy with multiple scoped commands emits one --allow each', () => {
    const args = buildGrokArgs(
      {
        ...input,
        executionClass: 'deploy',
        hostCommandScope: [
          './scripts/deploy-staging.sh',
          'curl -sf http://localhost:8788/',
        ],
      },
      {},
    );
    expect(args).not.toContain('--always-approve');
    const allows: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '--allow' && args[i + 1]?.startsWith('Bash(')) {
        allows.push(args[i + 1]!);
      }
    }
    expect(allows).toEqual([
      'Bash(./scripts/deploy-staging.sh)',
      'Bash(curl -sf http://localhost:8788/)',
    ]);
  });

  it('appends extraArgs and respects a model override', () => {
    const args = buildGrokArgs(input, { model: 'grok-build', extraArgs: ['--max-turns', '20'] });
    expect(args.join(' ')).toContain('-m grok-build');
    expect(args.join(' ')).toContain('--max-turns 20');
  });

  it('rejects extraArgs that try to override the execution permission policy', () => {
    expect(() => buildGrokArgs(input, { extraArgs: ['--always-approve'] })).toThrow(
      /must not override execution permission policy/,
    );
    expect(() =>
      buildGrokArgs(input, { extraArgs: ['--permission-mode=bypassPermissions'] }),
    ).toThrow(/must not override execution permission policy/);
    expect(() =>
      buildGrokArgs(input, { extraArgs: ['--tools', 'run_terminal_command'] }),
    ).toThrow(/must not override execution permission policy/);
  });

  it('passes --resume when resumeSessionId is set (comment-to-steer)', () => {
    const args = buildGrokArgs({ ...input, resumeSessionId: 'sess-abc' }, {});
    const i = args.indexOf('--resume');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('sess-abc');
  });
});

describe('GrokRun death diagnosis', () => {
  it('surfaces bounded stderrTail and exitSignal on process death', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    child.stderr.write('Error: status 502 Bad Gateway while streaming\n');
    child.emit('exit', 1, null);
    await tick();
    const snap = run.poll(0);
    expect(snap.status).toBe('failed');
    expect(snap.exitCode).toBe(1);
    expect(snap.stderrTail).toMatch(/status 502/);
  });
});

describe('GrokAdapter.start', () => {
  it('spawns grok in the workspace cwd and starts running', () => {
    const { adapter, calls } = harness();
    const run = adapter.start(input, 0);
    expect(calls[0]!.command).toBe('grok');
    expect(calls[0]!.cwd).toBe('/ws/app/T-1');
    expect(run.poll(0).status).toBe('running');
  });

  it('scrubs inherited HERCULES_* env (agents must not see the live work root/token)', () => {
    // 2026-07-17 incident: an agent booting the app under test inherited the
    // daemon's HERCULES_WORK_DIR and the booted instance wiped live worktrees.
    const saved = { ...process.env };
    process.env['HERCULES_WORK_DIR'] = '/home/live/work';
    process.env['HERCULES_TOKEN'] = 'live-secret';
    try {
      const { adapter, calls } = harness();
      adapter.start(input, 0);
      const env = calls[0]!.env;
      expect(env).toBeDefined();
      expect(env!['HERCULES_WORK_DIR']).toBeUndefined();
      expect(env!['HERCULES_TOKEN']).toBeUndefined();
      // Allocation vars the adapter sets on purpose survive.
      expect(env!['HERCULES_SLUG']).toBe('T-1');
      expect(env!['HERCULES_TASK_ID']).toBe('T-1');
      expect(env!['PATH']).toBe(process.env['PATH']);
    } finally {
      process.env = saved;
    }
  });

  it('extracts the session id from the end event', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    child.emitEvent({ type: 'text', data: 'hi' });
    child.emitEvent({
      type: 'end',
      stopReason: 'EndTurn',
      sessionId: '019f52a2-ddd3-7da0-83ca-05be09c575bf',
      requestId: 'req-1',
    });
    await tick();
    expect(run.poll(0).sessionId).toBe('019f52a2-ddd3-7da0-83ca-05be09c575bf');
    expect(run.poll(0).status).toBe('done');
  });

  it('assembles the final message from streamed text chunks', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    child.emitEvent({ type: 'text', data: '## Self-assessment\n' });
    child.emitEvent({ type: 'text', data: 'Result: PASS' });
    child.emitEvent({ type: 'end', stopReason: 'EndTurn', sessionId: 's1' });
    await tick();
    expect(run.finalMessage()).toBe('## Self-assessment\nResult: PASS');
    expect(run.poll(0).status).toBe('done');
  });

  it('reports token usage + cost from the end event (cost-ledger receipt)', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    expect(run.poll(0).usage).toBeUndefined();
    // Shape observed from grok CLI 1.0.5 `--output-format streaming-json`.
    child.emitEvent({
      type: 'end',
      stopReason: 'end_turn',
      sessionId: 's1',
      usage: { input_tokens: 17502, output_tokens: 37, reasoning_tokens: 32 },
      total_cost_usd: 0.011989896,
      total_cost_usd_ticks: 119898960,
    });
    await tick();
    expect(run.poll(0).usage).toEqual({
      inputTokens: 17502,
      outputTokens: 37,
      costUsd: 0.011989896,
    });
  });

  it('tolerates an end event with malformed usage (zeros, never NaN)', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    child.emitEvent({
      type: 'end',
      stopReason: 'end_turn',
      sessionId: 's1',
      usage: { input_tokens: '12', output_tokens: -1 },
      total_cost_usd: 'free',
    });
    await tick();
    expect(run.poll(0).usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(run.poll(0).status).toBe('done');
  });

  it('records activity from the first line of the assembled text', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    child.emitEvent({ type: 'text', data: 'Fixed the flaky retry.\n' });
    child.emitEvent({ type: 'text', data: 'More detail.' });
    child.emitEvent({ type: 'end', stopReason: 'EndTurn', sessionId: 's1' });
    await tick();
    expect(run.activityLog().some((l) => l.includes('Fixed the flaky retry.'))).toBe(true);
  });

  it('fails on an error event', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    child.emitEvent({ type: 'error', message: "Couldn't start session: auth" });
    await tick();
    expect(run.poll(0).status).toBe('failed');
  });

  it('fails on max_turns_reached', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    child.emitEvent({ type: 'max_turns_reached' });
    await tick();
    expect(run.poll(0).status).toBe('failed');
  });

  it('fails when the process exits non-zero without completing', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    child.finish(1);
    await tick();
    expect(run.poll(0).status).toBe('failed');
  });

  it('fails on a spawn error', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    child.emit('error', new Error('ENOENT'));
    await tick();
    expect(run.poll(0).status).toBe('failed');
  });

  it('stop() sends SIGTERM and stays running until exit', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    run.stop();
    expect(child.lastSignal).toBe('SIGTERM');
    expect(run.poll(0).status).toBe('running');
    child.finish(143);
    await tick();
    expect(run.poll(0).status).toBe('failed');
  });

  it('stop({force:true}) sends SIGKILL', () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    run.stop({ force: true });
    expect(child.lastSignal).toBe('SIGKILL');
  });

  it('uses a custom binary when configured', () => {
    const { adapter, calls } = harness({ grokBin: '/opt/grok' });
    adapter.start(input, 0);
    expect(calls[0]!.command).toBe('/opt/grok');
  });

  it('ignores non-JSON noise on the stream', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    child.stdout.write('not-json-noise\n');
    child.emitEvent({ type: 'end', stopReason: 'EndTurn', sessionId: 's1' });
    await tick();
    expect(run.poll(0).status).toBe('done');
  });

  it('keeps lastEventAt fresh on thought chunks (stall detection)', async () => {
    let now = 1000;
    const { adapter, child } = harness({ clock: () => now });
    const run = adapter.start(input, now);
    now = 5000;
    child.emitEvent({ type: 'thought', data: 'considering' });
    await tick();
    expect(run.poll(now).lastEventAt).toBe(5000);
    expect(run.poll(now).status).toBe('running');
  });

  it('surfaces tool events as activity + aliveHint (prefer over /proc)', async () => {
    const { adapter, child } = harness({ prepareHome: false });
    const run = adapter.start(input, 0);
    // tool_call activity only — fail-closed is on available_commands, not here.
    child.emitEvent({
      type: 'tool_call',
      name: 'search_replace',
      command: 'cargo test --workspace',
    });
    await tick();
    const snap = run.poll(0);
    expect(snap.status).toBe('running');
    expect(snap.aliveHint).toBe('cargo');
    expect(run.activityLog().some((l) => /cargo/i.test(l))).toBe(true);
  });

  it('surfaces ACP-shaped tool_call with title/path (not bare tool_call)', async () => {
    const { adapter, child } = harness({ prepareHome: false });
    const run = adapter.start(input, 0);
    child.emitEvent({
      type: 'tool_call',
      title: 'read_file',
      rawInput: { path: 'src/web/App.tsx' },
    });
    await tick();
    const log = run.activityLog();
    expect(log.some((l) => l === 'tool_call')).toBe(false);
    expect(log.some((l) => /read_file/i.test(l) && /App\.tsx/i.test(l))).toBe(true);
  });

  it('surfaces tool_call_update status with title (not bare tool_call_update)', async () => {
    const { adapter, child } = harness({ prepareHome: false });
    const run = adapter.start(input, 0);
    child.emitEvent({
      type: 'tool_call_update',
      title: 'run_terminal_command',
      status: 'completed',
      data: { command: 'pnpm test' },
    });
    await tick();
    const log = run.activityLog();
    expect(log.some((l) => l === 'tool_call_update')).toBe(false);
    expect(
      log.some(
        (l) =>
          /run_terminal_command|pnpm test/i.test(l) && /completed/i.test(l),
      ),
    ).toBe(true);
  });

  it('sticks prior tool identity onto status-only tool_call_update', async () => {
    const { adapter, child } = harness({ prepareHome: false });
    const run = adapter.start(input, 0);
    child.emitEvent({
      type: 'tool_call',
      title: 'read_file',
      rawInput: { path: 'src/web/App.tsx' },
    });
    await tick();
    child.emitEvent({
      type: 'tool_call_update',
      status: 'completed',
    });
    await tick();
    const log = run.activityLog();
    expect(log.some((l) => l === 'tool_call_update')).toBe(false);
    expect(log.some((l) => l === 'completed')).toBe(false);
    expect(
      log.some(
        (l) =>
          /read_file/i.test(l) && /App\.tsx/i.test(l) && /completed/i.test(l),
      ),
    ).toBe(true);
  });

  it('sticks prior identity when tool_call_update carries no fields', async () => {
    const { adapter, child } = harness({ prepareHome: false });
    const run = adapter.start(input, 0);
    child.emitEvent({
      type: 'tool_call',
      title: 'grep',
      rawInput: { pattern: 'mergeGate', path: 'src' },
    });
    await tick();
    child.emitEvent({ type: 'tool_call_update' });
    await tick();
    const log = run.activityLog();
    expect(log.some((l) => l === 'tool_call_update')).toBe(false);
    expect(log.some((l) => /grep/i.test(l))).toBe(true);
  });

  it('fails closed when available_commands advertises run_terminal_command', async () => {
    const { adapter, child } = harness({ prepareHome: false });
    const run = adapter.start({ ...input, executionClass: 'implement' }, 0);
    child.emitEvent({
      type: 'available_commands',
      tools: ['read_file', 'run_terminal_command', 'search_replace'],
      commands: [],
    });
    await tick();
    const snap = run.poll(0);
    expect(snap.status).toBe('failed');
    expect(run.activityLog().some((l) => /security:.*run_terminal_command/i.test(l))).toBe(true);
    expect(snap.stderrTail ?? '').toMatch(/forbidden tool.*run_terminal_command/i);
    expect(child.lastSignal).toBe('SIGKILL');
  });

  it('does not abort coding runs when only safe tools are advertised', async () => {
    const { adapter, child } = harness({ prepareHome: false });
    const run = adapter.start({ ...input, executionClass: 'implement' }, 0);
    child.emitEvent({
      type: 'available_commands',
      tools: ['read_file', 'grep', 'list_dir', 'search_replace', 'hercules_workspace__apply_patch'],
    });
    await tick();
    expect(run.poll(0).status).toBe('running');
    child.emitEvent({ type: 'end', stopReason: 'EndTurn', sessionId: 's-ok' });
    await tick();
    expect(run.poll(0).status).toBe('done');
  });

});

describe('GrokAdapter.start env isolation', () => {
  it('implement prepares GROK_HOME under scratch (outside workspace) with MCP env', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const scratch = await mkdtemp(join(tmpdir(), 'hercules-grok-start-'));
    try {
      const { adapter, calls } = harness({
        prepareHome: true,
        operatorGrokHome: join(scratch, 'no-auth'),
        workspaceMcpServerPath: '/opt/hercules/workspaceServer.js',
      });
      const startInput: AgentStartInput = {
        ...input,
        executionClass: 'implement',
        allocation: {
          slug: 'T-1',
          port: 4000,
          scratchDir: scratch,
        },
      };
      adapter.start(startInput, 0);
      const env = calls[0]!.env!;
      expect(env['GROK_HOME']?.startsWith(scratch)).toBe(true);
      expect(env['GROK_HOME']?.includes(input.workspace)).toBe(false);
      expect(env['HERCULES_WORKSPACE']).toBe('/ws/app/T-1');
      expect(env['HERCULES_WORKSPACE_MCP_SERVER']).toBe('/opt/hercules/workspaceServer.js');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('explore does not set mutation MCP workspace env vars', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const scratch = await mkdtemp(join(tmpdir(), 'hercules-grok-explore-'));
    try {
      const { adapter, calls } = harness({
        prepareHome: true,
        operatorGrokHome: join(scratch, 'no-auth'),
      });
      adapter.start(
        {
          ...input,
          executionClass: 'explore',
          allocation: { slug: 'T-1', port: 4000, scratchDir: scratch },
        },
        0,
      );
      const env = calls[0]!.env!;
      expect(env['GROK_HOME']?.startsWith(scratch)).toBe(true);
      expect(env['HERCULES_WORKSPACE']).toBeUndefined();
      expect(env['HERCULES_WORKSPACE_MCP_SERVER']).toBeUndefined();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

describe('extractToolLabel', () => {
  it('returns bare type only when no semantic fields exist', () => {
    expect(extractToolLabel({ type: 'tool_call' })).toBe('tool_call');
    expect(extractToolLabel({ type: 'tool_call_update' })).toBe('tool_call_update');
  });

  it('prefers ACP title + rawInput path over bare type', () => {
    const label = extractToolLabel({
      type: 'tool_call',
      title: 'read_file',
      rawInput: { path: 'src/adapters/grok.ts' },
    });
    expect(label).not.toBe('tool_call');
    expect(label).toMatch(/read_file/i);
    expect(label).toMatch(/grok\.ts/i);
  });

  it('includes status on tool_call_update with title', () => {
    const label = extractToolLabel({
      type: 'tool_call_update',
      title: 'search_replace',
      status: 'completed',
      data: { file_path: 'src/web/App.tsx' },
    });
    expect(label).not.toBe('tool_call_update');
    expect(label).toMatch(/search_replace/i);
    expect(label).toMatch(/completed|App\.tsx/i);
  });

  it('keeps legacy name + command shape', () => {
    const label = extractToolLabel({
      type: 'tool_call',
      name: 'shell',
      command: 'pnpm exec vitest run',
    });
    expect(label).toMatch(/shell/i);
    expect(label).toMatch(/vitest/i);
  });
});

describe('resolveToolActivityLabel stickiness', () => {
  it('attaches status-only update to prior title+path', () => {
    const start = resolveToolActivityLabel(
      {
        type: 'tool_call',
        title: 'read_file',
        rawInput: { path: 'src/adapters/grok.ts' },
      },
      null,
    );
    expect(start.label).toMatch(/read_file/i);
    expect(start.label).toMatch(/grok\.ts/i);
    expect(start.prior?.name).toMatch(/read_file/i);

    const update = resolveToolActivityLabel(
      { type: 'tool_call_update', status: 'completed' },
      start.prior,
    );
    expect(update.label).not.toBe('tool_call_update');
    expect(update.label).not.toBe('completed');
    expect(update.label).toMatch(/read_file/i);
    expect(update.label).toMatch(/grok\.ts/i);
    expect(update.label).toMatch(/completed/i);
  });

  it('does not emit bare tool_call_update when prior identity exists', () => {
    const prior = { name: 'search_replace', detail: 'src/web/App.tsx' };
    const empty = resolveToolActivityLabel({ type: 'tool_call_update' }, prior);
    expect(empty.label).not.toBe('tool_call_update');
    expect(empty.label).toMatch(/search_replace/i);
    expect(empty.label).toMatch(/App\.tsx/i);
  });

  it('falls back to bare type only with no prior and no semantics', () => {
    const empty = resolveToolActivityLabel({ type: 'tool_call_update' }, null);
    expect(empty.label).toBe('tool_call_update');
    expect(empty.prior).toBeNull();
  });
});
