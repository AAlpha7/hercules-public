import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  CodexAdapter,
  buildCodexArgs,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  resolveCodexPolicy,
} from '../../src/adapters/codex.js';
import type { ChildLike, SpawnFn } from '../../src/adapters/claude.js';
import type { AgentStartInput } from '../../src/orchestrator/adapter.js';

const input: AgentStartInput = {
  taskId: 'T-1',
  workspace: '/ws/app/T-1',
  prompt: 'fix the bug',
  allocation: { slug: 'T-1', port: 4000, scratchDir: '/ws/app/T-1/.scratch' },
};

class FakeChild extends EventEmitter implements ChildLike {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  // Intentionally no `pid` to exercise the child.kill(signal) fallback path.
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

function harness(): { adapter: CodexAdapter; child: FakeChild; calls: { command: string; cwd: string; env: NodeJS.ProcessEnv }[] } {
  const child = new FakeChild();
  const calls: { command: string; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  const spawn: SpawnFn = (command, _args, o) => {
    calls.push({ command, cwd: o.cwd, env: o.env ?? {} });
    return child;
  };
  return { adapter: new CodexAdapter({ spawn, clock: () => 0 }), child, calls };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('buildCodexArgs', () => {
  it('builds a non-interactive JSONL exec invocation', () => {
    const args = buildCodexArgs(input);
    expect(args).toEqual([
      'exec',
      '--json',
      '--model',
      'gpt-5.6-sol',
      '-c',
      'model_reasoning_effort="medium"',
      'fix the bug',
    ]);
  });

  it('passes validated model and reasoning overrides explicitly', () => {
    expect(
      buildCodexArgs(input, { model: 'gpt-5.6-sol-preview', reasoningEffort: 'high' }),
    ).toContain('model_reasoning_effort="high"');
    expect(buildCodexArgs(input, { model: 'gpt-5.6-sol-preview', reasoningEffort: 'high' }))
      .toEqual(expect.arrayContaining(['--model', 'gpt-5.6-sol-preview']));
  });

  it('resolves invalid env conservatively without retaining raw values', () => {
    const rawModel = 'secret model; --danger';
    const rawReasoning = 'secret-ultra';
    const policy = resolveCodexPolicy({
      HERCULES_CODEX_MODEL: rawModel,
      HERCULES_CODEX_REASONING_EFFORT: rawReasoning,
    });
    expect(policy).toEqual({
      model: DEFAULT_CODEX_MODEL,
      reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
      usedConservativeFallback: true,
    });
    expect(JSON.stringify(policy)).not.toContain(rawModel);
    expect(JSON.stringify(policy)).not.toContain(rawReasoning);
  });

  it('resolves valid env overrides', () => {
    expect(resolveCodexPolicy({
      HERCULES_CODEX_MODEL: 'gpt-5.6-sol-preview',
      HERCULES_CODEX_REASONING_EFFORT: 'ULTRA',
    })).toEqual({
      model: 'gpt-5.6-sol-preview',
      reasoningEffort: 'ultra',
      usedConservativeFallback: false,
    });
  });

  it('accepts every supported gpt-5.6-sol reasoning effort', () => {
    for (const reasoningEffort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const) {
      expect(resolveCodexPolicy({
        HERCULES_CODEX_REASONING_EFFORT: reasoningEffort,
      }).reasoningEffort).toBe(reasoningEffort);
    }
  });

  it('falls back invalid buildCodexArgs options without retaining them', () => {
    const args = buildCodexArgs(input, {
      model: 'bad model; --leak',
      reasoningEffort: 'secret-effort',
    });
    expect(args).toEqual([
      'exec',
      '--json',
      '--model',
      DEFAULT_CODEX_MODEL,
      '-c',
      `model_reasoning_effort="${DEFAULT_CODEX_REASONING_EFFORT}"`,
      'fix the bug',
    ]);
    expect(args.join(' ')).not.toContain('bad model');
    expect(args.join(' ')).not.toContain('secret-effort');
  });
});

describe('CodexAdapter', () => {
  it('spawns codex in the workspace cwd and starts running', () => {
    const { adapter, child, calls } = harness();
    const run = adapter.start(input, 0);
    expect(calls[0]!.command).toBe('codex');
    expect(calls[0]!.cwd).toBe('/ws/app/T-1');
    expect(calls[0]!.env['HERCULES_TASK_ID']).toBe('T-1');
    expect(child.stdin.writableEnded).toBe(true);
    expect(run.poll(0).status).toBe('running');
  });

  it('extracts the thread id from thread.started', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    child.emitEvent({ type: 'thread.started', thread_id: 'thr-9' });
    await tick();
    expect(run.poll(0).sessionId).toBe('thr-9');
  });

  it('completes as done with usage on turn.completed', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    child.emitEvent({ type: 'thread.started', thread_id: 'thr-9' });
    child.emitEvent({ type: 'turn.completed', usage: { input_tokens: 15701, output_tokens: 6 } });
    await tick();
    const snap = run.poll(0);
    expect(snap.status).toBe('done');
    expect(snap.usage).toEqual({ inputTokens: 15701, outputTokens: 6, costUsd: 0 });
  });

  it('fails on turn.failed', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    child.emitEvent({ type: 'turn.failed', error: { message: 'boom' } });
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

  it('stop() sends SIGTERM, keeps running until the process exits, then fails', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    run.stop();
    expect(child.lastSignal).toBe('SIGTERM');
    // Status stays running until the OS process actually exits.
    expect(run.poll(0).status).toBe('running');
    // Drive exit (non-zero = killed by signal).
    child.finish(1);
    await tick();
    expect(run.poll(0).status).toBe('failed');
  });

  it('stop({force:true}) sends SIGKILL', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    run.stop({ force: true });
    expect(child.lastSignal).toBe('SIGKILL');
    child.finish(1);
    await tick();
    expect(run.poll(0).status).toBe('failed');
  });

  it('extracts readable activity from tool.called and shell.command events', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    child.emitEvent({ type: 'tool.called', tool_name: 'functions.exec_command' });
    child.emitEvent({ type: 'shell.command', command: 'pnpm test' });
    await tick();
    const act = run.poll(0).recentActivity;
    expect(act).toContain('functions.exec_command');
    expect(act).toContain('pnpm test');
  });

  it('finalMessage() concatenates item.completed agent_message texts', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    child.emitEvent({ type: 'thread.started', thread_id: 'thr-9' });
    child.emitEvent({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: '## Self-assessment\nPASS' },
    });
    child.emitEvent({
      type: 'item.completed',
      item: { id: 'item_1', type: 'agent_message', text: 'Done.' },
    });
    child.emitEvent({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
    await tick();
    expect(run.finalMessage()).toBe('## Self-assessment\nPASS\n\nDone.');
    expect(run.poll(0).status).toBe('done');
    expect(run.poll(0).recentActivity).toEqual(
      expect.arrayContaining(['## Self-assessment', 'Done.']),
    );
  });

  it('surfaces command_execution and file_change as activity', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    child.emitEvent({
      type: 'item.started',
      item: {
        id: 'item_1',
        type: 'command_execution',
        command: 'pnpm test',
        status: 'in_progress',
      },
    });
    child.emitEvent({
      type: 'item.completed',
      item: {
        id: 'item_1',
        type: 'command_execution',
        command: 'pnpm test',
        exit_code: 0,
        status: 'completed',
      },
    });
    child.emitEvent({
      type: 'item.completed',
      item: {
        id: 'item_2',
        type: 'file_change',
        changes: [{ path: 'src/a.ts', kind: 'update' }],
        status: 'completed',
      },
    });
    await tick();
    const act = run.poll(0).recentActivity ?? [];
    expect(act.some((l) => l.includes('pnpm test'))).toBe(true);
    expect(act.some((l) => l.includes('src/a.ts'))).toBe(true);
  });

  it('treats reconnect error notices as non-fatal', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    child.emitEvent({ type: 'error', message: 'Reconnecting... 1/5' });
    await tick();
    expect(run.poll(0).status).toBe('running');
    child.emitEvent({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    await tick();
    expect(run.poll(0).status).toBe('done');
  });
});
