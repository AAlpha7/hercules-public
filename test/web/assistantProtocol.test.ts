/**
 * Phone Assistant text-mode protocol (agent session + client tools).
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSISTANT_SESSION_TITLE,
  buildAssistantBootMessage,
  findAssistantSession,
  formatAssistantToolResults,
  formatAssistantRoundCapNotice,
  danglingAssistantUserTurn,
  formatAssistantUserTurn,
  cleanAssistantChatMessages,
  isAssistantBootMessage,
  isAssistantInternalUserTurn,
  isAssistantSession,
  parseAssistantToolCalls,
  pendingAssistantToolRound,
  pickAssistantRepo,
  targetAssistantToolArgs,
  stripAssistantToolLines,
  visibleAssistantMessages,
} from '../../src/web/assistantProtocol.js';
import type { ChatMessage } from '../../src/web/api.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('assistantProtocol', () => {
  it('boot message lists phone tools and forbids coding', () => {
    const boot = buildAssistantBootMessage();
    expect(isAssistantBootMessage(boot)).toBe(true);
    expect(boot).toMatch(/Phone Assistant|co-pilot/i);
    expect(boot).toMatch(/HERCULES_TOOL/);
    expect(boot).toMatch(/get_status/);
    expect(boot).toMatch(/do NOT write product code/i);
    expect(boot).toMatch(/set_permission_mode/);
    expect(boot).toMatch(/NEVER change mode without the user agreeing/i);
  });

  it('wraps user turn with screen context', () => {
    const t = formatAssistantUserTurn('现在有什么待办？', 'view: tasks\nreview: 2');
    expect(t).toMatch(/\[Screen context\]/);
    expect(t).toMatch(/view: tasks/);
    expect(t).toMatch(/\[User\]/);
    expect(t).toMatch(/现在有什么待办/);
  });

  it('every turn carries the standing rules (pinned sessions never re-boot)', () => {
    // The boot blob is only sent on session creation; protocol upgrades must
    // still reach the long-lived pinned session — via a per-turn rules line.
    const t = formatAssistantUserTurn('几个任务?', 'view: tasks');
    expect(t).toMatch(/\[Rules\]/);
    expect(t).toMatch(/HERCULES_TOOL/);
    // End the turn with the answer — never with progress narration.
    expect(t).toMatch(/direct answer|直接回答/i);
    // Rules ride above [User] so extractUserVisibleFromTurn still works.
    expect(t.indexOf('[Rules]')).toBeLessThan(t.indexOf('[User]'));
    const visible = visibleAssistantMessages([{ id: '1', role: 'user', content: t }]);
    expect(visible[0]?.content).toBe('几个任务?');
  });

  it('boot forbids self-investigation for status and progress-narration endings', () => {
    const boot = buildAssistantBootMessage();
    expect(boot).toMatch(/phone tools.*not.*repo|NOT.*worktree.*(files|MCP)/is);
    expect(boot).toMatch(/direct answer/i);
  });

  it('parses and strips tool lines', () => {
    const raw =
      '先看一眼。\n<<HERCULES_TOOL get_status {}>>\n<<HERCULES_TOOL inspect_task {"taskId":"t1","action":"meta"}>>\n完。';
    const calls = parseAssistantToolCalls(raw);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.name).toBe('get_status');
    expect(calls[1]?.name).toBe('inspect_task');
    expect(JSON.parse(calls[1]!.argsJson)).toEqual({ taskId: 't1', action: 'meta' });
    expect(stripAssistantToolLines(raw)).toBe('先看一眼。\n\n完。');
  });

  it('formats tool results as internal user turns', () => {
    const msg = formatAssistantToolResults([
      { name: 'get_status', ok: true, message: '2 review' },
    ]);
    expect(isAssistantInternalUserTurn(msg)).toBe(true);
    expect(msg).toMatch(/get_status: ok/);
  });

  it('visibleAssistantMessages hides boot/tools and shows user text', () => {
    const boot = buildAssistantBootMessage();
    const turn = formatAssistantUserTurn('hello', 'ctx:1');
    const msgs = visibleAssistantMessages([
      { id: '1', role: 'user', content: `${boot}\n\n${turn}` },
      {
        id: '2',
        role: 'assistant',
        content: 'Hi\n<<HERCULES_TOOL get_status {}>>',
      },
      { id: '3', role: 'user', content: formatAssistantToolResults([{ name: 'get_status', ok: true, message: 'ok' }]) },
      { id: '4', role: 'assistant', content: 'All clear.' },
    ]);
    expect(msgs.map((m) => m.content)).toEqual(['hello', 'Hi', 'All clear.']);
  });

  it('hides assistant bubbles with no substance (bare punctuation like ".")', () => {
    const msgs = visibleAssistantMessages([
      { id: '1', role: 'user', content: '[Screen context]\nx\n\n[User]\nhello' },
      { id: '2', role: 'assistant', content: '.\n<<HERCULES_TOOL get_status {}>>' },
      { id: '3', role: 'assistant', content: '…' },
      { id: '4', role: 'assistant', content: '好' },
      { id: '5', role: 'assistant', content: '42' },
    ]);
    expect(msgs.map((m) => m.content)).toEqual(['hello', '好', '42']);
  });

  it('pendingAssistantToolRound: dispatches only fresh, uncapped, unprocessed tail calls', () => {
    const now = Date.parse('2026-07-16T10:00:00Z');
    const fresh = new Date(now - 30_000).toISOString();
    const stale = new Date(now - 10 * 60_000).toISOString();
    const user = { id: 'u1', role: 'user', content: '[Screen context]\nx\n\n[User]\nq', at: fresh };
    const toolMsg = (id: string, at = fresh) => ({
      id,
      role: 'assistant',
      content: `.\n<<HERCULES_TOOL get_status {}>>`,
      at,
    });

    // Happy path: last message is an assistant tool call → one round.
    const round = pendingAssistantToolRound([user, toolMsg('a1')], null, now);
    expect(round?.messageId).toBe('a1');
    expect(round?.calls[0]?.name).toBe('get_status');

    // Already processed → null. Plain answer tail → null. User tail → null.
    expect(pendingAssistantToolRound([user, toolMsg('a1')], 'a1', now)).toBeNull();
    expect(
      pendingAssistantToolRound(
        [user, { id: 'a2', role: 'assistant', content: 'done', at: fresh }],
        null,
        now,
      ),
    ).toBeNull();
    expect(pendingAssistantToolRound([toolMsg('a1'), user], null, now)).toBeNull();

    // Stale read-only tail (phone slept / app reload) DOES replay — dropping
    // it permanently wedged the conversation (2026-07-18).
    const staleRound = pendingAssistantToolRound([user, toolMsg('a1', stale)], null, now);
    expect(staleRound?.calls.map((c) => c.name)).toEqual(['get_status']);
    expect(staleRound?.expired).toEqual([]);

    // Round cap since the last real user turn → no calls execute; the loop
    // posts a wrap-up notice instead (capped flag, see dedicated test).
    const internal = { id: 'r', role: 'user', content: '[Tool results]\n- x: ok', at: fresh };
    const capped = [user, toolMsg('a1'), internal, toolMsg('a2'), internal, toolMsg('a3'), internal, toolMsg('a4')];
    expect(pendingAssistantToolRound(capped, null, now)?.capped).toBe(true);
  });

  it('dangling user tail (turn eaten by a daemon restart) is resent once', () => {
    const now = Date.parse('2026-07-18T08:10:00Z');
    const old = new Date(now - 2 * 60_000).toISOString();
    const justNow = new Date(now - 5_000).toISOString();
    const userTurn = { id: 'u9', role: 'user', content: '[Screen context]\nx\n\n[User]\n看看进度', at: old };
    const reply = { id: 'a9', role: 'assistant', content: 'ok', at: old };
    // Idle session whose LAST message is an unanswered user turn → resend it.
    expect(danglingAssistantUserTurn([reply, userTurn], 'idle', now)).toBe(userTurn.content);
    // Answered, running, or too-fresh tails → no resend.
    expect(danglingAssistantUserTurn([userTurn, reply], 'idle', now)).toBeNull();
    expect(danglingAssistantUserTurn([reply, userTurn], 'running', now)).toBeNull();
    expect(danglingAssistantUserTurn([reply, { ...userTurn, at: justNow }], 'idle', now)).toBeNull();
    // Already resent once (identical user message twice in a row) → give up.
    expect(
      danglingAssistantUserTurn([reply, userTurn, { ...userTurn, id: 'u10' }], 'idle', now),
    ).toBeNull();
  });

  it('App loop wires the dangling-turn resend', async () => {
    const app = await readFile(join(ROOT, 'src/web/App.tsx'), 'utf8');
    expect(app).toMatch(/danglingAssistantUserTurn\(s\.messages, s\.status/);
  });

  it('per-turn catalog carries enum values so the model stops guessing them', () => {
    // The agent burned whole tool rounds on action=overview/body guesses.
    const turn = formatAssistantUserTurn('q', 'ctx');
    expect(turn).toMatch(/inspect_task\(taskId,action=meta\|index\|plan\|read/);
  });

  it('round cap posts a wrap-up notice instead of silently stopping', () => {
    const now = Date.parse('2026-07-16T10:00:00Z');
    const fresh = new Date(now - 30_000).toISOString();
    const user = { id: 'u1', role: 'user', content: '[Screen context]\nx\n\n[User]\nq', at: fresh };
    const toolMsg = (id: string) => ({
      id,
      role: 'assistant',
      content: `.\n<<HERCULES_TOOL get_status {}>>`,
      at: fresh,
    });
    const internal = { id: 'r', role: 'user', content: '[Tool results]\n- x: ok', at: fresh };
    const capped = [user, toolMsg('a1'), internal, toolMsg('a2'), internal, toolMsg('a3'), internal, toolMsg('a4')];
    const round = pendingAssistantToolRound(capped, null, now);
    // Calls are NOT executed, but the loop is told to post a wrap-up notice.
    expect(round?.calls).toEqual([]);
    expect(round?.capped).toBe(true);
    // Once the cap notice is already posted, stay silent (no notice loop).
    const notified = [...capped, { id: 'rc', role: 'user', content: formatAssistantRoundCapNotice(), at: fresh }, toolMsg('a5')];
    expect(pendingAssistantToolRound(notified, null, now)).toBeNull();
    // The notice reads as an internal turn (hidden from the human).
    expect(isAssistantInternalUserTurn(formatAssistantRoundCapNotice())).toBe(true);
    expect(formatAssistantRoundCapNotice()).toMatch(/answer the user now/i);
  });

  it('parses and strips no-args tool lines (<<HERCULES_TOOL get_status>>)', () => {
    // The model legally omits the JSON object for zero-arg tools; requiring
    // {…} left the line unexecuted AND unstripped — the turn silently stalled.
    const calls = parseAssistantToolCalls('查一下。\n<<HERCULES_TOOL get_status>>');
    expect(calls).toEqual([{ name: 'get_status', argsJson: '{}' }]);
    expect(stripAssistantToolLines('查一下。\n<<HERCULES_TOOL get_status>>')).toBe('查一下。');
    // With args still works, mixed both forms in one message.
    const mixed = parseAssistantToolCalls(
      '<<HERCULES_TOOL get_status>>\n<<HERCULES_TOOL inspect_task {"taskId":"t1","action":"meta"}>>',
    );
    expect(mixed.map((c) => c.name)).toEqual(['get_status', 'inspect_task']);
  });

  it('per-turn rules forbid re-emitting the same tool batch (agent looped for minutes, 2026-07-18)', () => {
    const turn = formatAssistantUserTurn('q', 'ctx');
    expect(turn).toMatch(/exactly once/i);
    expect(turn).toMatch(/STOP and end the message/i);
  });

  it('stale rounds: unsafe calls expire (reported, not executed); safe calls replay; dupes dedupe', () => {
    const now = Date.parse('2026-07-16T10:00:00Z');
    const fresh = new Date(now - 30_000).toISOString();
    const stale = new Date(now - 60 * 60_000).toISOString();
    const user = { id: 'u1', role: 'user', content: '[Screen context]\nx\n\n[User]\nq', at: fresh };
    const mixed = {
      id: 'a1',
      role: 'assistant',
      content:
        'ok\n<<HERCULES_TOOL inspect_task {"taskId":"t1","action":"meta"}>>\n' +
        '<<HERCULES_TOOL send_chat {"text":"hi"}>>\n' +
        '<<HERCULES_TOOL steer_task {"taskId":"t1","text":"go"}>>\n' +
        '<<HERCULES_TOOL inspect_task {"taskId":"t1","action":"meta"}>>',
      at: stale,
    };
    const round = pendingAssistantToolRound([user, mixed], null, now);
    // Duplicate inspect_task deduped; send_chat/steer_task too risky to replay stale.
    expect(round?.calls.map((c) => c.name)).toEqual(['inspect_task']);
    expect(round?.expired.map((c) => c.name)).toEqual(['send_chat', 'steer_task']);

    // Fresh mixed round: everything executes, nothing expires, dupes still dedupe.
    const freshRound = pendingAssistantToolRound([user, { ...mixed, at: fresh }], null, now);
    expect(freshRound?.calls.map((c) => c.name)).toEqual(['inspect_task', 'send_chat', 'steer_task']);
    expect(freshRound?.expired).toEqual([]);
  });

  it('formatAssistantToolResults carries expired-call notices so the agent continues', () => {
    const text = formatAssistantToolResults(
      [{ name: 'inspect_task', ok: true, message: 'meta…' }],
      [{ name: 'send_chat', argsJson: '{"text":"hi"}' }],
    );
    expect(text).toMatch(/send_chat: expired/);
    expect(text).toMatch(/re-issue/i);
  });

  it('App tool loop reports expired calls and retries after dispatch errors', async () => {
    const app = await readFile(join(ROOT, 'src/web/App.tsx'), 'utf8');
    // Expired calls travel into the tool-results message.
    expect(app).toMatch(/round\.expired/);
    // A failed dispatch must not permanently mark the round processed.
    expect(app).toMatch(/assistantToolMsgRef\.current = null/);
  });

  it('targetAssistantToolArgs defaults self-target tools to the assistant session', () => {
    expect(JSON.parse(targetAssistantToolArgs('set_permission_mode', '{"mode":"bypass"}', 'rc-1'))).toEqual({
      mode: 'bypass',
      sessionId: 'rc-1',
    });
    // Explicit sessionId wins; unrelated tools untouched; broken JSON kept raw.
    expect(JSON.parse(targetAssistantToolArgs('stop_session', '{"sessionId":"rc-9"}', 'rc-1'))).toEqual({
      sessionId: 'rc-9',
    });
    expect(targetAssistantToolArgs('navigate', '{"view":"tasks"}', 'rc-1')).toBe('{"view":"tasks"}');
    expect(targetAssistantToolArgs('stop_session', '{broken', 'rc-1')).toBe('{broken');
  });

  it('cleanAssistantChatMessages: chat-sheet view of the assistant session', () => {
    const boot = buildAssistantBootMessage();
    const turn = formatAssistantUserTurn('查一下状态', 'view: tasks');
    const msgs: readonly ChatMessage[] = [
      { id: 'b', role: 'user', content: `${boot}\n\n${turn}`, at: 't0' },
      { id: 'a1', role: 'assistant', content: '.\n<<HERCULES_TOOL get_status {}>>', at: 't1' },
      { id: 'r1', role: 'user', content: formatAssistantToolResults([{ name: 'get_status', ok: true, message: 'ok' }]), at: 't2' },
      { id: 'a2', role: 'assistant', content: '一切正常。\n<<HERCULES_TOOL navigate {"view":"tasks"}>>', at: 't3', actions: [{ kind: 'open_task', target: 'x' }] },
      { id: 's1', role: 'system', content: 'task done', at: 't4' },
      { id: 'u2', role: 'user', content: '直接从 Chat 发的原文', at: 't5' },
    ];
    const out = cleanAssistantChatMessages(msgs);
    // boot+turn → extracted user text; tool-only reply hidden; internal hidden;
    // tool lines stripped; system + raw chat sends untouched; extra fields kept.
    expect(out.map((m) => [m.id, m.content])).toEqual([
      ['b', '查一下状态'],
      ['a2', '一切正常。'],
      ['s1', 'task done'],
      ['u2', '直接从 Chat 发的原文'],
    ]);
    expect(out[0]?.at).toBe('t0');
    expect(out[1]?.actions).toEqual([{ kind: 'open_task', target: 'x' }]);
  });

  it('isAssistantSession matches the pinned co-pilot session only', () => {
    expect(isAssistantSession({ kind: 'free', title: ASSISTANT_SESSION_TITLE })).toBe(true);
    expect(isAssistantSession({ kind: 'free', title: `${ASSISTANT_SESSION_TITLE} 2` })).toBe(true);
    expect(isAssistantSession({ kind: 'free', title: 'other chat' })).toBe(false);
    expect(isAssistantSession({ kind: 'task', title: ASSISTANT_SESSION_TITLE })).toBe(false);
  });

  it('wait helper is exported for ACP fire-and-forget settle', async () => {
    // Structural: tool loop depends on waitForSessionSettled in the web API.
    const api = await import('../../src/web/api.js');
    expect(typeof api.waitForSessionSettled).toBe('function');
    expect(typeof api.fetchSession).toBe('function');
  });

  it('findAssistantSession matches title; pickAssistantRepo prefers hercules', () => {
    expect(
      findAssistantSession([
        { kind: 'free', title: 'other', status: 'idle' },
        { kind: 'free', title: ASSISTANT_SESSION_TITLE, status: 'idle' },
      ])?.title,
    ).toBe(ASSISTANT_SESSION_TITLE);
    expect(
      pickAssistantRepo([
        { key: 'bookshelf', readiness: 'ready' },
        { key: 'hercules', readiness: 'ready' },
      ]),
    ).toBe('hercules');
  });
});

describe('per-turn tool catalog (stalled long-lived session, 2026-07-18)', () => {
  it('every turn carries the tool catalog and forbids deferred action', () => {
    // The pinned session outlives protocol upgrades: a session created before
    // the boot blob never saw the tool list, announced "I will look up how to
    // read the task" and stalled — the per-turn rules must name the tools and
    // demand the call in the SAME message.
    const turn = formatAssistantUserTurn('读取这个任务', 'view: task:x');
    expect(turn).toMatch(/inspect_task\(/);
    expect(turn).toMatch(/get_status/);
    expect(turn).toMatch(/IN THIS message|in THIS message/i);
    expect(turn).toMatch(/never announce/i);
  });
});
