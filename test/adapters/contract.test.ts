/**
 * Cross-adapter contract tests (SPEC §13).
 *
 * When a new adapter is added — or one is "simplified" during feature work —
 * these cases catch shared-surface regressions that per-adapter suites can miss
 * (forgotten finalMessage, stop that marks terminal synchronously, etc.).
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ClaudeAdapter } from '../../src/adapters/claude.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { GrokAdapter } from '../../src/adapters/grok.js';
import type { ChildLike, SpawnFn } from '../../src/adapters/claude.js';
import type { AgentAdapter, AgentStartInput } from '../../src/orchestrator/adapter.js';

const input: AgentStartInput = {
  taskId: 'T-contract',
  workspace: '/ws/app/T-contract',
  prompt: 'do the thing',
  allocation: { slug: 'T-contract', port: 4100, scratchDir: '/ws/app/T-contract/.scratch' },
};

class FakeChild extends EventEmitter implements ChildLike {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  lastSignal: NodeJS.Signals | undefined = undefined;
  kill(signal?: NodeJS.Signals): boolean {
    this.lastSignal = signal;
    return true;
  }
  finish(code: number): void {
    this.emit('exit', code);
  }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

interface AdapterCase {
  readonly name: string;
  readonly create: (spawn: SpawnFn) => AgentAdapter;
  /** Emit the adapter's success stream events onto the fake child. */
  readonly emitSuccess: (child: FakeChild) => void;
}

const cases: readonly AdapterCase[] = [
  {
    name: 'claude',
    create: (spawn) => new ClaudeAdapter({ spawn, clock: () => 0 }),
    emitSuccess: (child) => {
      child.stdout.write(
        JSON.stringify({
          type: 'result',
          is_error: false,
          session_id: 'sess-c',
          usage: { input_tokens: 1, output_tokens: 2 },
          total_cost_usd: 0.01,
        }) + '\n',
      );
    },
  },
  {
    name: 'codex',
    create: (spawn) => new CodexAdapter({ spawn, clock: () => 0 }),
    emitSuccess: (child) => {
      child.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thr-c' }) + '\n');
      child.stdout.write(
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'item_0', type: 'agent_message', text: 'done' },
        }) + '\n',
      );
      child.stdout.write(
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }) +
          '\n',
      );
    },
  },
  {
    name: 'grok',
    create: (spawn) => new GrokAdapter({ spawn, clock: () => 0, prepareHome: false }),
    emitSuccess: (child) => {
      child.stdout.write(JSON.stringify({ type: 'text', data: 'done' }) + '\n');
      child.stdout.write(
        JSON.stringify({ type: 'end', stopReason: 'EndTurn', sessionId: 'sess-g' }) + '\n',
      );
    },
  },
];

describe.each(cases)('adapter contract: $name', (c) => {
  function harness(): { adapter: AgentAdapter; child: FakeChild } {
    const child = new FakeChild();
    const spawn: SpawnFn = () => child;
    return { adapter: c.create(spawn), child };
  }

  it('reports its stable name', () => {
    const { adapter } = harness();
    expect(adapter.name).toBe(c.name);
  });

  it('exposes the AgentRun surface (poll / activityLog / finalMessage / stop)', () => {
    const { adapter } = harness();
    const run = adapter.start(input, 0);
    expect(typeof run.poll).toBe('function');
    expect(typeof run.activityLog).toBe('function');
    expect(typeof run.finalMessage).toBe('function');
    expect(typeof run.stop).toBe('function');
    // activityLog / finalMessage are safe to call while still running
    expect(Array.isArray(run.activityLog())).toBe(true);
    expect(typeof run.finalMessage()).toBe('string');
  });

  it('starts as running', () => {
    const { adapter } = harness();
    expect(adapter.start(input, 0).poll(0).status).toBe('running');
  });

  it('reaches done on a success stream (without requiring process exit)', async () => {
    const { adapter, child } = harness();
    const run = adapter.start(input, 0);
    c.emitSuccess(child);
    await tick();
    expect(run.poll(0).status).toBe('done');
  });

  it('stop() is graceful: SIGTERM, stays running until exit', async () => {
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

  it('never leaks the daemon HERCULES_* env into the agent process', () => {
    // 2026-07-17 incident: agent-booted app instances inherited the live
    // HERCULES_WORK_DIR and wiped production worktrees; the token is a secret.
    const saved = { ...process.env };
    process.env['HERCULES_WORK_DIR'] = '/home/live/work';
    process.env['HERCULES_TOKEN'] = 'live-secret';
    process.env['DATABASE_URL'] = 'postgres://prod/secret-db';
    process.env['GITHUB_TOKEN'] = 'ghp_secret_value';
    process.env['CUSTOMER_EMAIL'] = 'person@example.com';
    try {
      const child = new FakeChild();
      const envs: (NodeJS.ProcessEnv | undefined)[] = [];
      const spawn: SpawnFn = (_c, _a, o) => {
        envs.push(o.env);
        return child;
      };
      c.create(spawn).start(input, 0);
      expect(envs[0]).toBeDefined();
      expect(envs[0]!['HERCULES_WORK_DIR']).toBeUndefined();
      expect(envs[0]!['HERCULES_TOKEN']).toBeUndefined();
      expect(envs[0]!['DATABASE_URL']).toBeUndefined();
      expect(envs[0]!['GITHUB_TOKEN']).toBeUndefined();
      expect(envs[0]!['CUSTOMER_EMAIL']).toBeUndefined();
      expect(envs[0]!['PATH']).toBe(process.env['PATH']);
      // Values must not appear as diagnostic side-channels either.
      expect(JSON.stringify(envs[0])).not.toContain('secret-db');
      expect(JSON.stringify(envs[0])).not.toContain('ghp_secret_value');
    } finally {
      process.env = saved;
    }
  });
});

/**
 * When a new real adapter is wired into buildExecution, add it here too.
 * Keeps the composition-root matrix and the contract suite from drifting apart.
 */
describe('adapter roster', () => {
  it('covers every local CLI adapter name buildExecution accepts', () => {
    const contracted = new Set(cases.map((c) => c.name));
    expect(contracted).toEqual(new Set(['grok', 'codex', 'claude']));
  });

  it('names the remote factory adapter separately (not a spawn CLI)', () => {
    expect(new Set([...cases.map((c) => c.name), 'cursor'])).toEqual(
      new Set(['grok', 'codex', 'claude', 'cursor']),
    );
  });
});
