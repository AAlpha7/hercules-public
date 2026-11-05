import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { SessionManager } from '../../src/sessions/manager.js';
import { FakeAdapter } from '../../src/orchestrator/fakeAdapter.js';
import { AgentRegistry } from '../../src/orchestrator/agentRegistry.js';
import { NoopWorkspaces } from '../../src/isolation/worktree.js';
import { AcpClient, type AcpSpawnFn } from '../../src/adapters/acpClient.js';
import type { ReposConfig } from '../../src/domain/repos.js';

const repos: ReposConfig = {
  repos: {
    app: {
      key: 'app',
      url: 'https://github.com/example/app.git',
      defaultBranch: 'main',
      workflow: 'WORKFLOW.md',
      maxConcurrent: 1,
      adapter: null, readiness: 'ready',
    },
  },
};

function makeFakePeer(): {
  spawn: AcpSpawnFn;
  feed: (obj: unknown) => void;
  nextRequest: () => Promise<Record<string, unknown>>;
} {
  let agentIn: PassThrough | null = null;
  let clientOut: PassThrough | null = null;
  const waiters: Array<(r: Record<string, unknown>) => void> = [];
  const inbox: Record<string, unknown>[] = [];
  let buf = '';

  const deliver = (obj: Record<string, unknown>): void => {
    const waiter = waiters.shift();
    if (waiter) waiter(obj);
    else inbox.push(obj);
  };

  const spawn: AcpSpawnFn = () => {
    agentIn = new PassThrough();
    clientOut = new PassThrough();
    const stderr = new PassThrough();
    buf = '';
    agentIn.on('data', (chunk: Buffer | string) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        deliver(JSON.parse(line) as Record<string, unknown>);
      }
    });
    const ee = new EventEmitter() as ReturnType<AcpSpawnFn>;
    Object.assign(ee, {
      stdin: agentIn,
      stdout: clientOut,
      stderr,
      pid: 1,
      kill: () => ee.emit('exit', 0),
    });
    return ee;
  };

  return {
    spawn,
    feed: (obj) => {
      if (!clientOut) throw new Error('not spawned');
      clientOut.write(JSON.stringify(obj) + '\n');
    },
    nextRequest: () => {
      if (inbox.length > 0) return Promise.resolve(inbox.shift()!);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout waiting request')), 3000);
        waiters.push((r) => {
          clearTimeout(t);
          resolve(r);
        });
      });
    },
  };
}

/** Answer initialize + authenticate + session/new. */
async function handshake(peer: ReturnType<typeof makeFakePeer>, sessionId = 'acp-sess-1'): Promise<void> {
  let req = await peer.nextRequest();
  expect(req['method']).toBe('initialize');
  peer.feed({ jsonrpc: '2.0', id: req['id'], result: { protocolVersion: 1 } });
  req = await peer.nextRequest();
  expect(req['method']).toBe('authenticate');
  peer.feed({ jsonrpc: '2.0', id: req['id'], result: {} });
  req = await peer.nextRequest();
  expect(req['method']).toBe('session/new');
  peer.feed({ jsonrpc: '2.0', id: req['id'], result: { sessionId } });
}

/** Answer one session/prompt with text chunks + end_turn. */
async function answerPrompt(
  peer: ReturnType<typeof makeFakePeer>,
  reply: string,
  sessionId = 'acp-sess-1',
): Promise<Record<string, unknown>> {
  const req = await peer.nextRequest();
  expect(req['method']).toBe('session/prompt');
  peer.feed({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: reply },
      },
    },
  });
  peer.feed({ jsonrpc: '2.0', id: req['id'], result: { stopReason: 'end_turn' } });
  return req;
}

describe('SessionManager + ACP', () => {
  let clock: number;
  let peer: ReturnType<typeof makeFakePeer>;
  let mgr: SessionManager;

  beforeEach(() => {
    clock = 1_000_000;
    peer = makeFakePeer();
    mgr = new SessionManager({
      agents: AgentRegistry.of(new FakeAdapter({ durationMs: 60_000 })),
      workspaces: new NoopWorkspaces('/tmp/hercules-acp-test'),
      getRepos: () => repos,
      clock: () => clock,
      maxConcurrent: 2,
      createAcp: async (cwd, permissionMode) => {
        const client = new AcpClient({
          command: 'fake',
          args: [],
          cwd,
          authProvider: 'none',
          spawn: peer.spawn,
          setupTimeoutMs: 2000,
          promptTimeoutMs: 5000,
          permissionMode,
          permissionTimeoutMs: 60_000,
        });
        // Handshake in parallel with connect()
        const hs = handshake(peer);
        await Promise.all([client.connect(), hs]);
        return client;
      },
    });
  });

  afterEach(async () => {
    for (const s of mgr.list()) {
      if (s.status !== 'closed') await mgr.close(s.id).catch(() => {});
    }
  });

  it('first turn over ACP ends idle with agent reply; same process for second turn', async () => {
    const startP = mgr.start({ repo: 'app', message: 'first question' });
    // createAcp handshake runs inside start; then prompt is fired
    // Wait until session is created then answer prompt
    const session = await startP;
    expect(session.status).toBe('running');
    expect(session.agentSession).toBe('acp-sess-1');

    await answerPrompt(peer, 'Answer one');
    // allow async runAcpPrompt to settle
    await new Promise((r) => setTimeout(r, 50));

    let s = mgr.get(session.id)!;
    expect(s.status).toBe('idle');
    expect(s.messages.some((m) => m.role === 'assistant' && m.content === 'Answer one')).toBe(true);

    // Second turn: true multi-turn on same ACP process (no new session/new)
    const sendP = mgr.send(session.id, 'second question');
    await sendP;
    const promptReq = await answerPrompt(peer, 'Answer two');
    const params = promptReq['params'] as { sessionId: string; prompt: { text: string }[] };
    expect(params.sessionId).toBe('acp-sess-1');
    expect(params.prompt[0]?.text).toBe('second question');

    await new Promise((r) => setTimeout(r, 50));
    s = mgr.get(session.id)!;
    expect(s.status).toBe('idle');
    expect(s.messages.filter((m) => m.role === 'assistant')).toHaveLength(2);
  });

  it('queues follow-up while ACP prompt is in flight, then drains', async () => {
    const startP = mgr.start({ repo: 'app', message: 'one' });
    const session = await startP;

    // Don't answer first prompt yet — queue second message
    await mgr.send(session.id, 'two');
    let s = mgr.get(session.id)!;
    expect(s.queued).toEqual(['two']);
    expect(s.messages.filter((m) => m.role === 'user')).toHaveLength(2);

    // Finish first prompt
    await answerPrompt(peer, 'A1');
    // Second prompt should auto-drain
    await answerPrompt(peer, 'A2');
    await new Promise((r) => setTimeout(r, 50));

    s = mgr.get(session.id)!;
    expect(s.status).toBe('idle');
    expect(s.queued).toEqual([]);
    expect(s.messages.filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual([
      'A1',
      'A2',
    ]);
  });

  it('stop cancels in-flight ACP prompt', async () => {
    const session = await mgr.start({ repo: 'app', message: 'long task' });
    const promptReqP = peer.nextRequest(); // session/prompt
    const promptReq = await promptReqP;
    expect(promptReq['method']).toBe('session/prompt');

    mgr.stop(session.id);
    const cancel = await peer.nextRequest();
    expect(cancel['method']).toBe('session/cancel');

    peer.feed({
      jsonrpc: '2.0',
      id: promptReq['id'],
      result: { stopReason: 'cancelled' },
    });
    await new Promise((r) => setTimeout(r, 50));
    const s = mgr.get(session.id)!;
    expect(s.status).toBe('idle');
  });


describe('ACP turn usage → recordUsage', () => {
  it('records usage per turn, accumulates on the session, and swallows recordUsage errors', async () => {
    const events: Array<{
      scopeId: string;
      turn: number;
      usage: { inputTokens: number; outputTokens: number; costUsd: number };
    }> = [];
    let failOnce = true;
    let promptN = 0;
    const fakeClient = {
      acpSessionId: 'acp-fake-1',
      isClosed: false,
      setPermissionMode() {},
      getPermissionMode: () => 'acceptEdits' as const,
      listPendingPermissions: () => [],
      recentActivity: () => [],
      on() {
        return fakeClient;
      },
      close() {},
      cancel() {},
      async prompt() {
        promptN += 1;
        if (promptN === 1) {
          return {
            stopReason: 'end_turn',
            text: 'first',
            usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
          };
        }
        return {
          stopReason: 'end_turn',
          text: 'second',
          usage: { inputTokens: 20, outputTokens: 8, costUsd: 0.02 },
        };
      },
    };
    const usageMgr = new SessionManager({
      agents: AgentRegistry.of(new FakeAdapter({ durationMs: 60_000 })),
      workspaces: new NoopWorkspaces('/tmp/hercules-acp-usage-test'),
      getRepos: () => repos,
      clock: () => clock,
      maxConcurrent: 2,
      createAcp: async () => fakeClient as unknown as AcpClient,
      recordUsage: (e) => {
        events.push({ scopeId: e.scopeId, turn: e.turn, usage: e.usage });
        if (failOnce) {
          failOnce = false;
          throw new Error('ledger down');
        }
      },
    });

    const session = await usageMgr.start({ repo: 'app', message: 'one' });
    await new Promise((r) => setTimeout(r, 50));
    let s = usageMgr.get(session.id)!;
    expect(s.status).toBe('idle');
    expect(s.messages.some((m) => m.role === 'assistant' && m.content === 'first')).toBe(true);
    expect(events).toEqual([
      {
        scopeId: session.id,
        turn: 1,
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
      },
    ]);
    expect(s.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.01,
      turns: 1,
    });

    await usageMgr.send(session.id, 'two');
    await new Promise((r) => setTimeout(r, 50));
    s = usageMgr.get(session.id)!;
    expect(s.status).toBe('idle');
    expect(s.messages.some((m) => m.role === 'assistant' && m.content === 'second')).toBe(true);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      scopeId: session.id,
      turn: 2,
      usage: { inputTokens: 20, outputTokens: 8, costUsd: 0.02 },
    });
    expect(s.usage).toEqual({
      inputTokens: 30,
      outputTokens: 13,
      costUsd: 0.03,
      turns: 2,
    });

    await usageMgr.close(session.id).catch(() => {});
  });
});

describe('ACP prompt transient-error retry', () => {
  it('retries once on Internal error and recovers to idle with the reply', async () => {
    await mgr.start({ repo: 'app', message: 'flaky question' });
    // First prompt attempt → JSON-RPC internal error (xAI 500 passthrough).
    const req1 = await peer.nextRequest();
    expect(req1['method']).toBe('session/prompt');
    peer.feed({ jsonrpc: '2.0', id: req1['id'], error: { code: -32603, message: 'Internal error' } });
    // Manager retries the same text once on the same live client.
    const req2 = await peer.nextRequest();
    expect(req2['method']).toBe('session/prompt');
    const p2 = (req2['params'] as { prompt: { text: string }[] }).prompt[0]?.text ?? '';
    expect(p2).toContain('flaky question');
    peer.feed({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'acp-sess-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'recovered answer' } },
      },
    });
    peer.feed({ jsonrpc: '2.0', id: req2['id'], result: { stopReason: 'end_turn' } });
    await new Promise((r) => setTimeout(r, 200));
    const s = mgr.list()[0]!;
    expect(s.status).toBe('idle');
    expect(s.error ?? null).toBeNull();
    expect(s.messages.some((m) => m.content.includes('recovered answer'))).toBe(true);
  });

  it('marks failed after the retry also errors', async () => {
    await mgr.start({ repo: 'app', message: 'doubly flaky' });
    for (const _ of [1, 2]) {
      const req = await peer.nextRequest();
      expect(req['method']).toBe('session/prompt');
      peer.feed({ jsonrpc: '2.0', id: req['id'], error: { code: -32603, message: 'Internal error' } });
    }
    await new Promise((r) => setTimeout(r, 300));
    const s = mgr.list()[0]!;
    expect(s.status).toBe('failed');
    expect(s.error).toMatch(/Internal error/);
  });
});
});
