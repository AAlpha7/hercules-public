import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import {
  AcpClient,
  parseAcpTurnUsage,
  type AcpSpawnFn,
} from '../../src/adapters/acpClient.js';

/** Minimal child-like duplex for unit tests (no real grok). */
function makeFakeChild(): {
  child: ReturnType<AcpSpawnFn>;
  agentIn: PassThrough;
  clientOut: PassThrough;
  send: (obj: unknown) => void;
} {
  const agentIn = new PassThrough(); // what client writes (agent reads)
  const clientOut = new PassThrough(); // what agent writes (client reads)
  const stderr = new PassThrough();
  const ee = new EventEmitter() as ReturnType<AcpSpawnFn>;
  Object.assign(ee, {
    stdin: agentIn,
    stdout: clientOut,
    stderr,
    pid: 4242,
    kill: () => {
      ee.emit('exit', 0);
    },
  });
  return {
    child: ee,
    agentIn,
    clientOut,
    send: (obj: unknown) => {
      clientOut.write(JSON.stringify(obj) + '\n');
    },
  };
}

/** Read one NDJSON request from client's stdin (agentIn). */
async function readRequest(
  agentIn: PassThrough,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no request')), timeoutMs);
    let buf = '';
    const onData = (chunk: Buffer | string): void => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(t);
        agentIn.off('data', onData);
        resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
      }
    };
    agentIn.on('data', onData);
  });
}

describe('parseAcpTurnUsage', () => {
  it('converts costUsdTicks to USD (119898960 ticks → 0.011989896)', () => {
    expect(
      parseAcpTurnUsage({
        inputTokens: 100,
        outputTokens: 50,
        costUsdTicks: 119_898_960,
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.011989896,
    });
  });

  it('accepts camelCase costUsd and snake_case fields', () => {
    expect(
      parseAcpTurnUsage({
        inputTokens: 10,
        outputTokens: 20,
        costUsd: 0.5,
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 20, costUsd: 0.5 });
    expect(
      parseAcpTurnUsage({
        input_tokens: 3,
        output_tokens: 4,
        cost_usd_ticks: 1e10,
      }),
    ).toEqual({ inputTokens: 3, outputTokens: 4, costUsd: 1 });
    expect(
      parseAcpTurnUsage({
        input_tokens: 1,
        output_tokens: 2,
        cost_usd: 0.25,
      }),
    ).toEqual({ inputTokens: 1, outputTokens: 2, costUsd: 0.25 });
  });

  it('clamps negative/NaN fields to 0', () => {
    expect(
      parseAcpTurnUsage({
        inputTokens: -5,
        outputTokens: Number.NaN,
        costUsd: -1,
      }),
    ).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
  });

  it('returns null when usage is not an object', () => {
    expect(parseAcpTurnUsage(null)).toBeNull();
    expect(parseAcpTurnUsage(undefined)).toBeNull();
    expect(parseAcpTurnUsage('x')).toBeNull();
    expect(parseAcpTurnUsage(1)).toBeNull();
  });
});

describe('AcpClient', () => {
  let fake: ReturnType<typeof makeFakeChild>;
  let client: AcpClient;

  beforeEach(() => {
    fake = makeFakeChild();
    client = new AcpClient({
      command: 'fake-grok',
      args: ['agent', 'stdio'],
      cwd: '/tmp/ws',
      authProvider: 'none',
      setupTimeoutMs: 2000,
      promptTimeoutMs: 2000,
      permissionMode: 'acceptEdits',
      permissionTimeoutMs: 60_000,
      spawn: () => fake.child,
    });
  });

  afterEach(() => {
    client.close();
  });

  it('connects: initialize → authenticate → session/new', async () => {
    const connectP = client.connect();

    // initialize
    let req = await readRequest(fake.agentIn);
    expect(req['method']).toBe('initialize');
    fake.send({ jsonrpc: '2.0', id: req['id'], result: { protocolVersion: 1, agentCapabilities: {} } });

    // authenticate
    req = await readRequest(fake.agentIn);
    expect(req['method']).toBe('authenticate');
    fake.send({ jsonrpc: '2.0', id: req['id'], result: {} });

    // session/new
    req = await readRequest(fake.agentIn);
    expect(req['method']).toBe('session/new');
    expect((req['params'] as { cwd: string }).cwd).toBe('/tmp/ws');
    fake.send({
      jsonrpc: '2.0',
      id: req['id'],
      result: { sessionId: 'sess-abc' },
    });

    const { sessionId } = await connectP;
    expect(sessionId).toBe('sess-abc');
    expect(client.acpSessionId).toBe('sess-abc');
  });

  it('streams prompt updates and returns assistant text', async () => {
    const connectP = client.connect();
    let req = await readRequest(fake.agentIn);
    fake.send({ jsonrpc: '2.0', id: req['id'], result: { protocolVersion: 1 } });
    req = await readRequest(fake.agentIn);
    fake.send({ jsonrpc: '2.0', id: req['id'], result: {} });
    req = await readRequest(fake.agentIn);
    fake.send({ jsonrpc: '2.0', id: req['id'], result: { sessionId: 's1' } });
    await connectP;

    const promptP = client.prompt('hello');
    req = await readRequest(fake.agentIn);
    expect(req['method']).toBe('session/prompt');
    const params = req['params'] as { prompt: { text: string }[] };
    expect(params.prompt[0]?.text).toBe('hello');

    // stream chunks
    fake.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hi ' },
        },
      },
    });
    fake.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: {
          sessionUpdate: 'tool_call',
          title: 'read_file',
        },
      },
    });
    fake.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'there' },
        },
      },
    });
    // final result
    fake.send({
      jsonrpc: '2.0',
      id: req['id'],
      result: { stopReason: 'end_turn' },
    });

    const result = await promptP;
    expect(result.stopReason).toBe('end_turn');
    expect(result.text).toBe('Hi there');
    // Coalesced tool line uses → title (not per-token spam)
    expect(client.recentActivity().some((l) => l.includes('read_file') || l.startsWith('→'))).toBe(
      true,
    );
  });

  it('auto-allows edit tools under acceptEdits; asks for execute', async () => {
    const connectP = client.connect();
    let req = await readRequest(fake.agentIn);
    fake.send({ jsonrpc: '2.0', id: req['id'], result: { protocolVersion: 1 } });
    req = await readRequest(fake.agentIn);
    fake.send({ jsonrpc: '2.0', id: req['id'], result: {} });
    req = await readRequest(fake.agentIn);
    fake.send({ jsonrpc: '2.0', id: req['id'], result: { sessionId: 's1' } });
    await connectP;

    // edit → auto allow
    fake.send({
      jsonrpc: '2.0',
      id: 99,
      method: 'session/request_permission',
      params: {
        sessionId: 's1',
        toolCall: { toolCallId: 'c1', title: 'Write file', kind: 'edit' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
    const auto = await readRequest(fake.agentIn);
    expect(auto['id']).toBe(99);
    expect((auto['result'] as { outcome: { optionId: string } }).outcome.optionId).toBe(
      'allow-once',
    );

    // execute → ask (pending)
    fake.send({
      jsonrpc: '2.0',
      id: 100,
      method: 'session/request_permission',
      params: {
        sessionId: 's1',
        toolCall: { toolCallId: 'c2', title: 'run bash', kind: 'execute' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(client.listPendingPermissions()).toHaveLength(1);
    const permId = client.listPendingPermissions()[0]!.id;
    client.resolvePermission(permId, 'reject-once');
    const denied = await readRequest(fake.agentIn);
    expect(denied['id']).toBe(100);
    expect((denied['result'] as { outcome: { optionId: string } }).outcome.optionId).toBe(
      'reject-once',
    );
    expect(client.listPendingPermissions()).toHaveLength(0);
  });

  it('hot-switches to bypass and auto-allows execute', async () => {
    const connectP = client.connect();
    let req = await readRequest(fake.agentIn);
    fake.send({ jsonrpc: '2.0', id: req['id'], result: { protocolVersion: 1 } });
    req = await readRequest(fake.agentIn);
    fake.send({ jsonrpc: '2.0', id: req['id'], result: {} });
    req = await readRequest(fake.agentIn);
    fake.send({ jsonrpc: '2.0', id: req['id'], result: { sessionId: 's1' } });
    await connectP;

    client.setPermissionMode('bypass');
    fake.send({
      jsonrpc: '2.0',
      id: 7,
      method: 'session/request_permission',
      params: {
        toolCall: { title: 'rm', kind: 'execute' },
        options: [
          { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
    const reply = await readRequest(fake.agentIn);
    expect((reply['result'] as { outcome: { optionId: string } }).outcome.optionId).toBe(
      'allow-once',
    );
  });

  it('cancel sends session/cancel notification while prompting', async () => {
    const connectP = client.connect();
    let req = await readRequest(fake.agentIn);
    fake.send({ jsonrpc: '2.0', id: req['id'], result: { protocolVersion: 1 } });
    req = await readRequest(fake.agentIn);
    fake.send({ jsonrpc: '2.0', id: req['id'], result: {} });
    req = await readRequest(fake.agentIn);
    fake.send({ jsonrpc: '2.0', id: req['id'], result: { sessionId: 's1' } });
    await connectP;

    void client.prompt('long');
    req = await readRequest(fake.agentIn);
    expect(req['method']).toBe('session/prompt');

    client.cancel();
    const cancel = await readRequest(fake.agentIn);
    expect(cancel['method']).toBe('session/cancel');
    expect(cancel['id']).toBeUndefined();

    fake.send({ jsonrpc: '2.0', id: req['id'], result: { stopReason: 'cancelled' } });
  });

  it('prompt resolves with usage from turn_completed; next prompt without it omits usage', async () => {
    const connectP = client.connect();
    let req = await readRequest(fake.agentIn);
    fake.send({ jsonrpc: '2.0', id: req['id'], result: { protocolVersion: 1 } });
    req = await readRequest(fake.agentIn);
    fake.send({ jsonrpc: '2.0', id: req['id'], result: {} });
    req = await readRequest(fake.agentIn);
    fake.send({ jsonrpc: '2.0', id: req['id'], result: { sessionId: 's1' } });
    await connectP;

    const prompt1 = client.prompt('with usage');
    req = await readRequest(fake.agentIn);
    expect(req['method']).toBe('session/prompt');
    fake.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'ok' },
        },
      },
    });
    fake.send({
      jsonrpc: '2.0',
      method: '_x.ai/session/update',
      params: {
        sessionId: 's1',
        update: {
          sessionUpdate: 'turn_completed',
          usage: {
            inputTokens: 12,
            outputTokens: 34,
            costUsdTicks: 119_898_960,
          },
        },
      },
    });
    fake.send({
      jsonrpc: '2.0',
      id: req['id'],
      result: { stopReason: 'end_turn' },
    });
    const r1 = await prompt1;
    expect(r1.text).toBe('ok');
    expect(r1.usage).toEqual({
      inputTokens: 12,
      outputTokens: 34,
      costUsd: 0.011989896,
    });

    const prompt2 = client.prompt('no usage');
    req = await readRequest(fake.agentIn);
    fake.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'again' },
        },
      },
    });
    fake.send({
      jsonrpc: '2.0',
      id: req['id'],
      result: { stopReason: 'end_turn' },
    });
    const r2 = await prompt2;
    expect(r2.text).toBe('again');
    expect(r2.usage).toBeUndefined();
  });
});

describe('ACP spawn env boundary', () => {
  it('spawns with the explicitly selected provider env only (no all-provider inheritance)', () => {
    const saved = { ...process.env };
    process.env['XAI_API_KEY'] = 'leak-xai';
    process.env['OPENAI_API_KEY'] = 'leak-openai';
    process.env['ANTHROPIC_API_KEY'] = 'leak-anthropic';
    process.env['DATABASE_URL'] = 'postgres://leak';
    try {
      const fakeEnv = makeFakeChild();
      const envs: (NodeJS.ProcessEnv | undefined)[] = [];
      const spawn: AcpSpawnFn = (_c, _a, o) => {
        envs.push(o.env);
        return fakeEnv.child;
      };
      const c = new AcpClient({
        command: 'fake-grok',
        args: ['agent', 'stdio'],
        cwd: '/tmp/ws',
        authProvider: 'xai',
        setupTimeoutMs: 2000,
        promptTimeoutMs: 2000,
        permissionMode: 'acceptEdits',
        permissionTimeoutMs: 60_000,
        spawn,
      });
      c.connect().catch(() => undefined); // spawn happens synchronously
      expect(envs).toHaveLength(1);
      const env = envs[0]!;
      expect(env['XAI_API_KEY']).toBe('leak-xai');
      expect(env['OPENAI_API_KEY']).toBeUndefined();
      expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
      expect(env['DATABASE_URL']).toBeUndefined();
      c.close();
    } finally {
      process.env = { ...saved } as NodeJS.ProcessEnv;
    }
  });

  it('filters a caller-supplied env before spawn instead of treating it as trusted', () => {
    const fakeEnv = makeFakeChild();
    const envs: (NodeJS.ProcessEnv | undefined)[] = [];
    const spawn: AcpSpawnFn = (_c, _a, o) => {
      envs.push(o.env);
      return fakeEnv.child;
    };
    const c = new AcpClient({
      command: 'fake-grok',
      args: ['agent', 'stdio'],
      cwd: '/tmp/ws',
      authProvider: 'xai',
      env: {
        PATH: '/usr/bin',
        HOME: '/home/tester',
        XAI_API_KEY: 'selected-xai',
        GROK_API_KEY: 'selected-grok',
        OPENAI_API_KEY: 'cross-openai',
        ANTHROPIC_API_KEY: 'cross-anthropic',
        DATABASE_URL: 'postgres://production',
        HERCULES_TOKEN: 'control-token',
      },
      setupTimeoutMs: 2000,
      promptTimeoutMs: 2000,
      permissionMode: 'acceptEdits',
      permissionTimeoutMs: 60_000,
      spawn,
    });

    c.connect().catch(() => undefined);
    expect(envs).toHaveLength(1);
    const env = envs[0]!;
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['HOME']).toBe('/home/tester');
    expect(env['XAI_API_KEY']).toBe('selected-xai');
    expect(env['GROK_API_KEY']).toBe('selected-grok');
    expect(env['OPENAI_API_KEY']).toBeUndefined();
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['DATABASE_URL']).toBeUndefined();
    expect(env['HERCULES_TOKEN']).toBeUndefined();
    c.close();
  });
});

describe('tool-loop circuit breaker', () => {
  it('auto-cancels the turn when the same tool line repeats 3 times', async () => {
    const fake2 = makeFakeChild();
    const c = new AcpClient({
      command: 'fake-grok',
      args: ['agent', 'stdio'],
      cwd: '/tmp/ws',
      authProvider: 'none',
      setupTimeoutMs: 2000,
      promptTimeoutMs: 2000,
      permissionMode: 'acceptEdits',
      permissionTimeoutMs: 60_000,
      spawn: () => fake2.child,
    });
    const connectP = c.connect();
    let req = await readRequest(fake2.agentIn);
    fake2.send({ jsonrpc: '2.0', id: req['id'], result: { protocolVersion: 1 } });
    req = await readRequest(fake2.agentIn);
    fake2.send({ jsonrpc: '2.0', id: req['id'], result: {} });
    req = await readRequest(fake2.agentIn);
    fake2.send({ jsonrpc: '2.0', id: req['id'], result: { sessionId: 'sL' } });
    await connectP;

    const promptP = c.prompt('inspect the task');
    req = await readRequest(fake2.agentIn);
    expect(req['method']).toBe('session/prompt');
    const line = '查看中。<<HERCULES_TOOL inspect_task {"taskId":"t1","action":"meta"}>>\n';
    for (let i = 0; i < 3; i += 1) {
      fake2.send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sL',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: line } },
        },
      });
    }
    // Third repeat trips the breaker → session/cancel notification.
    const cancel = await readRequest(fake2.agentIn);
    expect(cancel['method']).toBe('session/cancel');
    // Agent resolves the prompt as cancelled; partial draft is preserved.
    fake2.send({ jsonrpc: '2.0', id: req['id'], result: { stopReason: 'cancelled' } });
    const res = await promptP;
    expect(res.stopReason).toBe('cancelled');
    expect(res.text).toContain('HERCULES_TOOL');
    c.close();
  });
});

describe('runaway-size safety caps', () => {
  it('cancels the turn when the streamed draft exceeds the cap', async () => {
    const fake3 = makeFakeChild();
    const c = new AcpClient({
      command: 'fake-grok',
      args: ['agent', 'stdio'],
      cwd: '/tmp/ws',
      authProvider: 'none',
      setupTimeoutMs: 2000,
      promptTimeoutMs: 2000,
      permissionMode: 'acceptEdits',
      permissionTimeoutMs: 60_000,
      spawn: () => fake3.child,
    });
    const connectP = c.connect();
    let req = await readRequest(fake3.agentIn);
    fake3.send({ jsonrpc: '2.0', id: req['id'], result: { protocolVersion: 1 } });
    req = await readRequest(fake3.agentIn);
    fake3.send({ jsonrpc: '2.0', id: req['id'], result: {} });
    req = await readRequest(fake3.agentIn);
    fake3.send({ jsonrpc: '2.0', id: req['id'], result: { sessionId: 'sB' } });
    await connectP;

    const promptP = c.prompt('go');
    req = await readRequest(fake3.agentIn);
    const big = 'x'.repeat(600_000);
    for (const _ of [1, 2, 3, 4]) {
      fake3.send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sB',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: big } },
        },
      });
    }
    const cancel = await readRequest(fake3.agentIn);
    expect(cancel['method']).toBe('session/cancel');
    fake3.send({ jsonrpc: '2.0', id: req['id'], result: { stopReason: 'cancelled' } });
    const res = await promptP;
    expect(res.stopReason).toBe('cancelled');
    c.close();
  });

  it('stdout line buffer is hard-capped (giant no-newline lines cannot OOM the daemon)', async () => {
    const { readFile: rf } = await import('node:fs/promises');
    const src = await rf(new URL('../../src/adapters/acpClient.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/MAX_STDOUT_BUFFER/);
    expect(src).toMatch(/MAX_TURN_TEXT/);
  });
});
