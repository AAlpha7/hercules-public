/**
 * Phone Assistant (text mode) — same co-pilot purpose as Voice Control,
 * backed by a free Remote Control agent session so the agent stack owns
 * multi-turn history / context window.
 *
 * Phone UI actions use a single-line tool protocol the client executes with
 * the existing VoiceHandlers (no worktree coding from the assistant).
 */
import { VOICE_COMMANDS } from './voiceCommands.js';

/** Stable title — used to find/reuse the assistant free session. */
export const ASSISTANT_SESSION_TITLE = 'Phone Assistant';

/** Max tool rounds per user turn (client-executed phone tools). */
export const ASSISTANT_MAX_TOOL_ROUNDS = 3;

// Args object is optional — zero-arg tools are legally written
// <<HERCULES_TOOL get_status>> and must still parse (and strip).
const TOOL_LINE_RE = /<<HERCULES_TOOL\s+([A-Za-z0-9_]+)(?:\s+(\{[\s\S]*?\}))?\s*>>/g;

export type AssistantToolCall = {
  readonly name: string;
  readonly argsJson: string;
};

/** Boot message for a new free session (agent keeps this in history). */
export function buildAssistantBootMessage(): string {
  const toolLines = VOICE_COMMANDS.map(
    (c) =>
      `- ${c.name}: ${c.description.slice(0, 140)}${c.description.length > 140 ? '…' : ''}` +
      (c.confirmRequired ? ' [needs confirmed:true after user yes]' : ''),
  ).join('\n');

  return (
    '[SYSTEM — Hercules Phone Assistant]\n' +
    'You are the co-pilot for the Hercules phone Remote Control UI.\n' +
    'A separate coding agent may run inside session worktrees — you do NOT write product code, ' +
    'edit app files, or run shell for implementation. You help the human operate the phone UI: ' +
    'tasks, sessions, permissions, live status, PRs, navigation.\n\n' +
    'LANGUAGE: reply in the same language as the user.\n' +
    'BREVITY: prefer short answers; use lists only when needed.\n\n' +
    'Each user turn includes fresh [Screen context] — trust it over memory when they conflict.\n\n' +
    'PHONE UI TOOLS: to act on the phone (not the worktree), emit one or more lines exactly:\n' +
    '<<HERCULES_TOOL name {"arg":"value"}>>\n' +
    'JSON must be a single object. You may explain briefly, then emit tools.\n' +
    'After tools run you will receive [Tool results] in the next user message — then continue.\n' +
    'Destructive tools require the user to confirm first, then call with "confirmed": true.\n\n' +
    'PERMISSION MODE (this co-pilot free session):\n' +
    '- Modes: acceptEdits (default, files auto / shell asks), bypass (YOLO), default (Ask).\n' +
    '- NEVER change mode without the user agreeing in chat. Explain what will change, wait for yes, ' +
    'then <<HERCULES_TOOL set_permission_mode {"mode":"bypass","confirmed":true}>> ' +
    '(omit sessionId — client targets this Phone Assistant session).\n' +
    '- Prefer YOLO only when the user explicitly wants fewer permission prompts for shell tools.\n\n' +
    'Available tools:\n' +
    toolLines +
    '\n\n' +
    'If you only need to answer or advise, do not emit tools. Prefer complete markdown tables when summarizing.\n\n' +
    'ANSWER DISCIPLINE:\n' +
    '- For status/count/listing questions use the phone tools (get_status, list_messages, inspect_task…), ' +
    'NOT your worktree files or MCP — the phone tools are the source of truth the user sees.\n' +
    '- ALWAYS end your turn with a direct answer to the user. Never end on progress narration ' +
    '(“正在…”, “let me check…”) — run the tool, read [Tool results], then answer.'
  );
}

/**
 * Standing per-turn rules. The boot blob is only sent when the session is
 * created; the pinned Phone Assistant session lives for weeks, so protocol
 * upgrades ride on every turn (short, above [User] so UI extraction holds).
 */
/**
 * Compact per-turn tool catalog: `name(arg,…)`. The pinned session outlives
 * protocol upgrades — a session created before the boot blob never saw the
 * tool list, announced "I'll look up how to read the task" and stalled
 * (2026-07-18). Names + arg keys are enough to act; full docs stay in boot.
 */
const TOOL_CATALOG = VOICE_COMMANDS.map((c) => {
  const properties =
    (c.parameters as { properties?: Record<string, { enum?: readonly string[] }> }).properties ??
    {};
  const props = Object.entries(properties).map(([key, spec]) =>
    // Enum values inline — the model burned whole rounds guessing them.
    Array.isArray(spec.enum) && spec.enum.length > 0 ? `${key}=${spec.enum.join('|')}` : key,
  );
  return props.length > 0 ? `${c.name}(${props.join(',')})` : c.name;
}).join(' ');

const TURN_RULES =
  '[Rules] Phone UI actions → <<HERCULES_TOOL name {...}>> (phone tools are the ' +
  'source of truth — not your worktree). Tools: ' +
  TOOL_CATALOG +
  '. Emit any needed tool calls IN THIS message — never announce you will act ' +
  'later; a message without a tool call ends your turn. ' +
  'Emit each tool batch exactly once, then STOP and end the message — results ' +
  'arrive in the NEXT user message; repeating the batch in the same message ' +
  'does nothing. ' +
  'End with a direct answer, never progress narration.';

/** Wrap a human text turn with live screen context (agent manages full history). */
export function formatAssistantUserTurn(userText: string, screenContext: string): string {
  const body = userText.trim();
  const ctx = screenContext.trim() || '(no screen context)';
  return `[Screen context]\n${ctx}\n\n${TURN_RULES}\n\n[User]\n${body}`;
}

/** Parse tool calls from an assistant message. */
export function parseAssistantToolCalls(content: string): readonly AssistantToolCall[] {
  const out: AssistantToolCall[] = [];
  const re = new RegExp(TOOL_LINE_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const name = m[1] ?? '';
    const argsJson = (m[2] ?? '{}').trim();
    if (!name) continue;
    // Validate JSON early so we can report cleanly.
    try {
      JSON.parse(argsJson);
    } catch {
      out.push({ name, argsJson: '{}' });
      continue;
    }
    out.push({ name, argsJson });
  }
  return out;
}

/** Strip tool lines for human-readable bubbles in the text panel. */
export function stripAssistantToolLines(content: string): string {
  return content
    .replace(TOOL_LINE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Tool calls older than this are "stale" (phone slept / app reloaded). */
export const ASSISTANT_TOOL_MAX_AGE_MS = 5 * 60_000;

/**
 * Tools safe to replay from a stale round: pure reads + UI navigation. A
 * dangling tool round used to be dropped entirely past the age cutoff, which
 * permanently wedged the conversation when the phone locked during the
 * agent's think (2026-07-18). Anything that sends messages or mutates
 * sessions/tasks stays out — those expire and the agent is told to re-issue.
 */
const REPLAY_SAFE_TOOLS = new Set([
  'get_status',
  'get_session',
  'list_messages',
  'read_live_steps',
  'get_diff_summary',
  'inspect_task',
  'inspect_session',
  'pin_session',
  'navigate',
  'open_session',
  'open_task',
  'open_live_for_task',
]);

/** Phone tools that act on the co-pilot session itself when sessionId is omitted. */
const SELF_TARGET_TOOLS = new Set([
  'set_permission_mode',
  'stop_session',
  'resolve_permission',
  'resolve_all_permissions',
]);

export type AssistantToolRound = {
  readonly messageId: string;
  /** Calls to execute now (fresh, or stale-but-replay-safe). */
  readonly calls: readonly AssistantToolCall[];
  /** Stale unsafe calls — report as expired so the agent re-issues. */
  readonly expired: readonly AssistantToolCall[];
  /** True when the per-user-turn round cap is hit: execute nothing and post
   *  {@link formatAssistantRoundCapNotice} so the agent answers instead of
   *  the conversation dying silently mid-work. */
  readonly capped?: boolean;
};

/** Don't resend a dangling user turn younger than this (turn may be booting). */
export const ASSISTANT_DANGLING_MIN_AGE_MS = 60_000;
/** Nor older than this (don't resurrect ancient conversations). */
export const ASSISTANT_DANGLING_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * A user message with no reply on an idle session = the agent turn was eaten
 * (daemon restart killed the ACP process mid-send, 2026-07-18). Return the
 * message content to resend, or null. Resent at most once: two identical
 * consecutive user messages mean we already tried.
 */
export function danglingAssistantUserTurn(
  messages: readonly { role: string; content: string; at?: string }[],
  status: string,
  nowMs: number,
): string | null {
  if (status !== 'idle') return null;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return null;
  const at = last.at ? Date.parse(last.at) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const age = nowMs - at;
  if (age < ASSISTANT_DANGLING_MIN_AGE_MS || age > ASSISTANT_DANGLING_MAX_AGE_MS) return null;
  const prev = messages[messages.length - 2];
  if (prev && prev.role === 'user' && prev.content === last.content) return null;
  return last.content;
}

/** Internal wrap-up notice posted exactly once when the round cap is hit. */
export function formatAssistantRoundCapNotice(): string {
  return (
    '[Tool results]\n- (round cap) tool round limit reached for this user turn — ' +
    'no more tools will run. Answer the user now with the information you already have.'
  );
}

/**
 * The tool round the app-level loop should dispatch now, or null.
 * Owns all the guards: the session's LAST message must be an assistant turn
 * with tool calls, not yet processed, and within ASSISTANT_MAX_TOOL_ROUNDS
 * since the last real user turn. Stale rounds still return: safe calls
 * replay, unsafe ones land in `expired` (never silently dropped — that
 * wedges the conversation).
 */
export function pendingAssistantToolRound(
  messages: readonly { id: string; role: string; content: string; at?: string }[],
  processedMessageId: string | null,
  nowMs: number,
): AssistantToolRound | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return null;
  if (processedMessageId !== null && last.id === processedMessageId) return null;
  const parsed = parseAssistantToolCalls(last.content);
  if (parsed.length === 0) return null;
  // Agents sometimes emit the same batch several times in one message.
  const seen = new Set<string>();
  const calls: AssistantToolCall[] = [];
  for (const c of parsed) {
    const key = `${c.name} ${c.argsJson}`;
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push(c);
  }
  const at = last.at ? Date.parse(last.at) : Number.NaN;
  const stale = !Number.isFinite(at) || nowMs - at > ASSISTANT_TOOL_MAX_AGE_MS;
  // Count tool rounds since the last real (non-internal) user turn; also
  // detect an already-posted cap notice (never notify twice → no loop).
  let rounds = 0;
  let capNoticeSent = false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m) break;
    if (m.role === 'user' && !isAssistantInternalUserTurn(m.content)) break;
    if (m.role === 'user' && m.content.includes('(round cap)')) capNoticeSent = true;
    if (m.role === 'assistant' && parseAssistantToolCalls(m.content).length > 0) rounds += 1;
  }
  if (rounds > ASSISTANT_MAX_TOOL_ROUNDS) {
    if (capNoticeSent) return null;
    return { messageId: last.id, calls: [], expired: [], capped: true };
  }
  if (!stale) return { messageId: last.id, calls, expired: [] };
  return {
    messageId: last.id,
    calls: calls.filter((c) => REPLAY_SAFE_TOOLS.has(c.name)),
    expired: calls.filter((c) => !REPLAY_SAFE_TOOLS.has(c.name)),
  };
}

/**
 * Default self-target phone tools to the co-pilot session when the agent
 * omitted sessionId (so set_permission_mode / stop hit the assistant session,
 * not a random focus). Non-object / broken JSON is returned untouched.
 */
export function targetAssistantToolArgs(
  name: string,
  argsJson: string,
  assistantSessionId: string,
): string {
  if (!SELF_TARGET_TOOLS.has(name)) return argsJson;
  try {
    const obj = JSON.parse(argsJson || '{}') as Record<string, unknown>;
    if (typeof obj['sessionId'] !== 'string' || !obj['sessionId']) {
      obj['sessionId'] = assistantSessionId;
      return JSON.stringify(obj);
    }
    return argsJson;
  } catch {
    return argsJson;
  }
}

export function formatAssistantToolResults(
  results: readonly { name: string; ok: boolean; message: string }[],
  expired: readonly AssistantToolCall[] = [],
): string {
  const lines = results.map(
    (r) => `- ${r.name}: ${r.ok ? 'ok' : 'fail'} — ${r.message.slice(0, 500)}`,
  );
  const expiredLines = expired.map(
    (c) =>
      `- ${c.name}: expired — emitted while the app was closed; not executed for safety. Re-issue it now if still needed.`,
  );
  return (
    '[Tool results]\n' +
    [...lines, ...expiredLines].join('\n') +
    '\n\nContinue helping the user. Emit more <<HERCULES_TOOL ...>> if needed, or answer.'
  );
}

/** True when a user message is an internal tool-result follow-up (hide in UI). */
export function isAssistantInternalUserTurn(content: string): boolean {
  return content.startsWith('[Tool results]');
}

/** True when content is the boot system blob (hide raw boot in UI). */
export function isAssistantBootMessage(content: string): boolean {
  return content.startsWith('[SYSTEM — Hercules Phone Assistant]');
}

/**
 * Human-facing text for one assistant-session message, or null to hide it
 * (boot blobs, [Tool results] internals, tool-only filler replies).
 */
function cleanAssistantMessage(role: string, content: string): string | null {
  if (role === 'user') {
    if (isAssistantInternalUserTurn(content)) return null;
    // Pure boot (no user body) is hidden; boot+first-turn keeps the [User] slice.
    if (isAssistantBootMessage(content) && !content.includes('[User]\n')) return null;
    return extractUserVisibleFromTurn(content) || null;
  }
  if (role === 'assistant') {
    const text = stripAssistantToolLines(content);
    // Tool-only turns sometimes carry filler punctuation ("." / "…") — a
    // bubble with no letter/digit (any script) is noise, not an answer.
    if (!text || !/[\p{L}\p{N}]/u.test(text)) return null;
    return text;
  }
  return content;
}

/**
 * Messages to show in the text panel: drop boot, tool-result users, strip tool lines.
 */
export function visibleAssistantMessages(
  messages: readonly { id: string; role: string; content: string }[],
): readonly { id: string; role: 'user' | 'assistant'; content: string }[] {
  const out: { id: string; role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = cleanAssistantMessage(m.role, m.content);
    if (text === null) continue;
    out.push({ id: m.id, role: m.role, content: text });
  }
  return out;
}

/**
 * Chat-sheet view of the assistant session: same cleaning, but generic — it
 * preserves every other message field (at, attachments, actions…) and keeps
 * system messages (chat-level lifecycle notes) untouched.
 */
export function cleanAssistantChatMessages<
  T extends { readonly id: string; readonly role: string; readonly content: string },
>(messages: readonly T[]): T[] {
  const out: T[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      out.push(m);
      continue;
    }
    const text = cleanAssistantMessage(m.role, m.content);
    if (text === null) continue;
    out.push(text === m.content ? m : { ...m, content: text });
  }
  return out;
}

function extractUserVisibleFromTurn(content: string): string {
  if (isAssistantBootMessage(content)) {
    const idx = content.indexOf('[User]\n');
    if (idx < 0) return '';
    return content.slice(idx + '[User]\n'.length).trim();
  }
  if (content.startsWith('[Screen context]')) {
    const idx = content.indexOf('[User]\n');
    if (idx < 0) return content.trim();
    return content.slice(idx + '[User]\n'.length).trim();
  }
  return content.trim();
}

/** Prefer a stable product repo for the assistant worktree (read-only co-pilot). */
export function pickAssistantRepo(
  repos: readonly { key: string; readiness?: string }[],
): string | null {
  if (repos.length === 0) return null;
  const hercules = repos.find((r) => r.key === 'hercules');
  if (hercules) return hercules.key;
  const ready = repos.find((r) => r.readiness === 'ready');
  if (ready) return ready.key;
  return repos[0]?.key ?? null;
}

/** True when this session is the Phone Assistant co-pilot free session. */
export function isAssistantSession(s: { readonly kind: string; readonly title: string }): boolean {
  return (
    s.kind === 'free' &&
    (s.title === ASSISTANT_SESSION_TITLE || s.title.startsWith(`${ASSISTANT_SESSION_TITLE} `))
  );
}

export function findAssistantSession<
  T extends { kind: string; title: string; status: string; archived?: boolean },
>(sessions: readonly T[]): T | null {
  const open = sessions.filter(
    (s) => isAssistantSession(s) && s.status !== 'closed' && s.archived !== true,
  );
  return open.find((s) => s.title === ASSISTANT_SESSION_TITLE) ?? open[0] ?? null;
}
