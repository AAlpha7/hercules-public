import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ClaudeAdapter, buildClaudeArgs, type ChildLike, type SpawnFn } from '../../src/adapters/claude.js';
import type { AgentStartInput } from '../../src/orchestrator/adapter.js';

const input: AgentStartInput = {
  taskId: 'T-1',
  workspace: '/ws/app/T-1',
  prompt: 'fix the bug',
  allocation: { slug: 'T-1', port: 4000, scratchDir: '/ws/app/T-1/.scratch' },
};

/** A controllable fake child process. No `pid` so tests exercise the child.kill fallback. */
class FakeChild extends EventEmitter implements ChildLike {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  // Intentionally no `pid` to exercise the child.kill(signal) fallback path.
  lastSignal: NodeJS.Signals | undefined = undefined;
  kill(signal?: NodeJS.Signals): boolean {
    this.lastSignal = signal;
    return true;
  }
  /** Emit one newline-delimited stream-json event. */
  emitEvent(obj: unknown): void {
    this.stdout.write(JSON.stringify(obj) + '\n');
  }
  finish(code: number): void {
    this.emit('exit', code);
  }
}

function harness(opts: { clock?: () => number } = {}): {
  adapter: ClaudeAdapter;
  child: FakeChild;
  calls: { command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }[];
} {
  const child = new FakeChild();
  const calls: { command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  const spawn: SpawnFn = (command, args, o) => {
    calls.push({ command, args, cwd: o.cwd, env: o.env ?? {} });
    return child;
  };
  const adapter = new ClaudeAdapter({ spawn, clock: opts.clock ?? (() => 0) });
  return { adapter, child, calls };
}

// let microtask stream 'data' handlers flush
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('buildClaudeArgs', () => {
  it('builds a headless streaming invocation', () => {
    const args = buildClaudeArgs(input, { permissionMode: 'acceptEdits', allowedTools: ['Edit', 'Bash'] });
    expect(args).toContain('-p');
    expect(args).toContain('fix the bug');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--verbose');
    expect(args.join(' ')).toContain('--permission-mode acceptEdits');
    expect(args.join(' ')).toContain('--allowedTools Edit,Bash');
  });

  it('disables user-level hooks so global plugin directives cannot hijack the run', () => {
    // Real incident 2026-07-24: the user's grok-cto SessionStart hook injected
    // "auto mode: ON — delegate implementation to Grok" into a Hercules agent;
    // the agent dispatched an external job and finished with an empty diff,
    // twice. Task agents must be hermetic: no user-global hooks.
    const args = buildClaudeArgs(input, { permissionMode: 'acceptEdits' });
    const i = args.indexOf('--settings');
    expect(i).toBeGreaterThan(-1);
    expect(JSON.parse(args[i + 1]!)).toMatchObject({ disableAllHooks: true });
  });

  it('passes --resume when resumeSessionId is set', () => {
    const args = buildClaudeArgs(
      { ...input, resumeSessionId: 'sess-xyz' },
      { permissionMode: 'acceptEdits' },
    );
    const i = args.indexOf('--resume');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('sess-xyz');
  });
});

describe('ClaudeAdapter.start', () => {
  it('spawns claude in the workspace cwd and starts running', () => {
    const { adapter, calls } = harness();
    const run = adapter.start(input, 0);
    expect(calls[0]!.command).toBe('claude');
    expect(calls[0]!.cwd).toBe('/ws/app/T-1');
    expect(calls[0]!.env['HERCULES_TASK_ID']).toBe('T-1');
    expect(run.poll(0).status).toBe('running');
  });

  it('extracts the session id from the init event', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    child.emitEvent({ type: 'system', subtype: 'init', session_id: 'sess-abc' });
    await tick();
    expect(run.poll(0).sessionId).toBe('sess-abc');
  });

  it('completes as done and reports usage on a success result', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    child.emitEvent({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    child.emitEvent({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'sess-1',
      usage: { input_tokens: 1200, output_tokens: 340 },
      total_cost_usd: 0.012,
    });
    await tick();
    child.finish(0);
    await tick();
    const snap = run.poll(0);
    expect(snap.status).toBe('done');
    expect(snap.usage).toEqual({ inputTokens: 1200, outputTokens: 340, costUsd: 0.012 });
  });

  it('fails on an error result', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    child.emitEvent({ type: 'result', subtype: 'error_during_execution', is_error: true });
    await tick();
    expect(run.poll(0).status).toBe('failed');
  });

  it('fails when the process exits non-zero without a result', async () => {
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

  it('advances lastEventAt as events arrive (for stall detection)', async () => {
    let now = 100;
    const { adapter, child } = harness({ clock: () => now });
    const run = adapter.start(input, 100);
    expect(run.poll(0).lastEventAt).toBe(100);
    now = 250;
    child.emitEvent({ type: 'assistant', message: { role: 'assistant' } });
    await tick();
    expect(run.poll(0).lastEventAt).toBe(250);
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

  it('extracts readable activity from assistant text and tool_use events', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    child.emitEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the code' }] } });
    child.emitEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/foo.ts' } }] } });
    child.emitEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }] } });
    await tick();
    const act = run.poll(0).recentActivity;
    expect(act).toContain('Looking at the code');
    expect(act).toContain('Edit src/foo.ts');
    expect(act).toContain('Bash: pnpm test');
  });

  it('finalMessage() returns the full last text block, not just its first line', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    child.emitEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Let me summarize.' }] } });
    child.emitEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'SPEC.md' } }] } });
    const summary = '# Summary\n\nLine one of the result.\nLine two of the result.';
    child.emitEvent({ type: 'assistant', message: { content: [{ type: 'text', text: summary }] } });
    await tick();
    // The whole final message survives (the deliverable) — not truncated to its heading.
    expect(run.finalMessage()).toBe(summary);
    // The compact activity feed still keeps only the first line of each text block.
    expect(run.activityLog()).toContain('# Summary');
    expect(run.activityLog()).not.toContain('Line two of the result.');
  });

  it('poll() returns only the recent tail while activityLog() returns the full transcript', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    for (let i = 0; i < 60; i++) {
      child.emitEvent({ type: 'assistant', message: { content: [{ type: 'text', text: `step ${i}` }] } });
    }
    await tick();
    // Live tail capped at 40; full log keeps all 60 (up to ACTIVITY_CAP=500).
    expect(run.poll(0).recentActivity).toHaveLength(40);
    expect(run.poll(0).recentActivity).toContain('step 59'); // newest is in the tail
    expect(run.poll(0).recentActivity).not.toContain('step 0'); // oldest dropped from tail
    expect(run.activityLog()).toHaveLength(60);
    expect(run.activityLog()[0]).toBe('step 0'); // full log keeps the oldest
    expect(run.activityLog()).toContain('step 59');
  });
});
