import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dispatchVoiceCommand,
  pickFocusSessionId,
  realtimeVoiceTools,
  resolveVoiceLanguageHint,
  VOICE_COMMANDS,
  voiceControlInstructions,
} from '../../src/web/voiceCommands.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('voice control command registry (P1–P3)', () => {
  it('exposes layered UX tools without coding verbs', () => {
    const names = new Set(VOICE_COMMANDS.map((c) => c.name));
    // L0 + structured inspect
    for (const n of [
      'get_status',
      'get_session',
      'list_messages',
      'read_live_steps',
      'get_diff_summary',
      'inspect_task',
      'inspect_session',
    ]) {
      expect(names.has(n)).toBe(true);
    }
    expect(names.has('get_task_evidence')).toBe(false);
    // L1
    expect(names.has('send_chat')).toBe(true);
    // L2
    for (const n of [
      'set_permission_mode',
      'resolve_permission',
      'resolve_all_permissions',
      'approve_proposal',
      'dismiss_proposal',
      'promote_to_task',
      'stop_session',
    ]) {
      expect(names.has(n)).toBe(true);
    }
    // L3
    for (const n of [
      'navigate',
      'open_live_for_task',
      'approve_and_pr',
      'steer_task',
      'task_action',
    ]) {
      expect(names.has(n)).toBe(true);
    }
    expect([...names].join(' ')).not.toMatch(/write_file|edit_worktree|run_shell|apply_patch/i);
    const tools = realtimeVoiceTools() as { name: string; type: string }[];
    expect(tools.length).toBe(VOICE_COMMANDS.length);
    expect(tools.every((t) => t.type === 'function')).toBe(true);
  });

  it('blocks confirmRequired tools without confirmed:true', async () => {
    const r = await dispatchVoiceCommand(
      { stop_session: () => ({ ok: true, message: 'stopped' }) },
      'stop_session',
      '{}',
    );
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/confirm/i);
  });

  it('allows send_chat without confirmation', async () => {
    const r = await dispatchVoiceCommand(
      {
        send_chat: (args) => ({
          ok: true,
          message: `got:${String(args['message'])}`,
        }),
      },
      'send_chat',
      JSON.stringify({ message: 'list files' }),
    );
    expect(r).toEqual({ ok: true, message: 'got:list files' });
  });

  it('dispatches confirmed tools', async () => {
    const r = await dispatchVoiceCommand(
      { stop_session: () => ({ ok: true, message: 'stopped rc-1' }) },
      'stop_session',
      JSON.stringify({ confirmed: true, sessionId: 'rc-1' }),
    );
    expect(r).toEqual({ ok: true, message: 'stopped rc-1' });
  });

  it('instructions route intents via inspect_task/session and warn about FRAGMENTs', () => {
    const text = voiceControlInstructions('focus_session: rc-1\nview: session:rc-1', 'zh-CN');
    expect(text).toMatch(/do not write code|never write code/i);
    expect(text).toMatch(/send_chat/);
    expect(text).toMatch(/INTENT ROUTING|L0/i);
    expect(text).toMatch(/FOCUS/);
    expect(text).toMatch(/SCREEN CONTEXT/);
    expect(text).toMatch(/FRAGMENT/);
    expect(text).toMatch(/inspect_task/);
    expect(text).toMatch(/inspect_session/);
    expect(text).toMatch(/nextOffset|NOT a source of truth/i);
    expect(text).toMatch(/Never invent|do not invent/i);
    // Language policy must lead so English tool docs do not force English speech.
    expect(text).toMatch(/LANGUAGE \(highest priority/);
    expect(text).toMatch(/reply ONLY in Chinese|中文/i);
    expect(text.indexOf('LANGUAGE')).toBeLessThan(text.indexOf('INTENT ROUTING'));
    expect(text).toMatch(/BREVITY \(strict/);
    expect(text).toMatch(/ONE short sentence|Hard cap TWO/i);
  });

  it('resolveVoiceLanguageHint prefers zh even when primary UI is en', () => {
    expect(resolveVoiceLanguageHint('zh-CN')).toBe('zh');
    expect(resolveVoiceLanguageHint('en-US', ['en-US', 'zh-CN'])).toBe('zh');
    expect(resolveVoiceLanguageHint('en-US', ['en-US'])).toBeNull();
    expect(resolveVoiceLanguageHint('ja-JP')).toBe('ja');
  });

  it('pickFocusSessionId prefers explicit then focus then unique running/perm', () => {
    const sessions = [
      { id: 'a', status: 'idle', pendingPermissions: [] },
      { id: 'b', status: 'running', pendingPermissions: [{ id: 'p' }] },
    ];
    expect(pickFocusSessionId(sessions, null, 'a')).toBe('a');
    expect(pickFocusSessionId(sessions, 'a', undefined)).toBe('a');
    expect(pickFocusSessionId(sessions, null, undefined)).toBe('b'); // unique running
    expect(
      pickFocusSessionId(
        [
          { id: 'x', status: 'idle', pendingPermissions: [{ id: '1' }] },
          { id: 'y', status: 'idle', pendingPermissions: [] },
        ],
        null,
      ),
    ).toBe('x');
  });
});

describe('voice control wiring', () => {
  it('session.update sets language_hint from resolveVoiceLanguageHint', async () => {
    const src = await readFile(join(ROOT, 'src/web/VoiceControl.tsx'), 'utf8');
    expect(src).toMatch(/resolveVoiceLanguageHint/);
    expect(src).toMatch(/language_hint/);
    expect(src).toMatch(/transcription/);
  });

  it('uses echoCancellation + element-routed playback (AEC pattern)', async () => {
    const src = await readFile(join(ROOT, 'src/web/VoiceControl.tsx'), 'utf8');
    expect(src).toMatch(/echoCancellation:\s*true/);
    expect(src).toMatch(/createMediaStreamDestination/);
    expect(src).toMatch(/playsinline/);
  });

  it('supports text assistant panel wired to agent session protocol', async () => {
    const vc = await readFile(join(ROOT, 'src/web/VoiceControl.tsx'), 'utf8');
    expect(vc).toMatch(/assistant-text-panel|voice-text-panel/);
    expect(vc).toMatch(/startAgentSession|ASSISTANT_SESSION_TITLE/);
    expect(vc).toMatch(/formatAssistantUserTurn/);
    expect(vc).toMatch(/loadAssistantMode|setAssistantMode/);
    // Text tool loop lives in App (runs for turns sent from ANY surface,
    // incl. the Chat sheet) — the panel must not carry a second dispatcher.
    // (Realtime voice mode still dispatches its own websocket tool calls.)
    expect(vc).not.toMatch(/runAssistantToolLoop|formatAssistantToolResults/);
    const appSrc = await readFile(join(ROOT, 'src/web/App.tsx'), 'utf8');
    expect(appSrc).toMatch(/pendingAssistantToolRound/);
    expect(appSrc).toMatch(/targetAssistantToolArgs/);
    expect(appSrc).toMatch(/formatAssistantToolResults/);
    expect(appSrc).toMatch(/waitForSessionSettled/);
    // Assistant bubbles: Markdown + fit content (75% of log viewport) + chrome
    // fullscreen only when clamped.
    expect(vc).toMatch(/AssistantReplyBubble/);
    const bubble = await readFile(join(ROOT, 'src/web/AssistantReplyBubble.tsx'), 'utf8');
    expect(bubble).toMatch(/import \{ Markdown \}/);
    expect(bubble).toMatch(/<Markdown text=\{content\}/);
    expect(bubble).toMatch(/isReplyClamped/);
    expect(bubble).toMatch(/onDoubleClick|setFull|is-overlay/);
    expect(bubble).toMatch(/voice-reply-chrome/);
    // Outside tap collapses expanded assistant shell.
    expect(vc).toMatch(/shellRef/);
    expect(vc).toMatch(/pointerdown/);
    expect(vc).toMatch(/collapsed:\s*true/);
    // Desktop: click opens via pointerup when not dragged (capture only after move).
    expect(vc).toMatch(/activateOrb/);
    expect(vc).toMatch(/skipClickRef/);
    expect(vc).toMatch(/setPointerCapture/);
    expect(vc).toMatch(/d\.moved = true/);
    // Same free-session system; stay in panel by default; optional Chat jump.
    expect(vc).toMatch(/onOpenInChat/);
    expect(vc).toMatch(/sessionActivity/);
    expect(vc).toMatch(/assistant-live-steps|voice-text-live/);
    expect(vc).toMatch(/在 Chat 打开/);
    expect(vc).toMatch(/setSessionPermissionMode|changeAssistantPermMode/);
    expect(vc).toMatch(/assistant-perm-mode/);
    // Must NOT auto-open Chat on every send.
    const sendBlock = vc.slice(vc.indexOf('const sendTextTurn'), vc.indexOf('const onOrbClick'));
    expect(sendBlock).not.toMatch(/onOpenInChat\?\.\(s\.id\)/);
    const app = await readFile(join(ROOT, 'src/web/App.tsx'), 'utf8');
    expect(app).toMatch(/onOpenInChat=\{/);
    expect(app).toMatch(/setLiveSessionFocus\(sessionId\)/);
    const css = await readFile(join(ROOT, 'src/web/styles.css'), 'utf8');
    expect(css).toMatch(/\.voice-text-panel/);
    expect(css).toMatch(/\.voice-shell/);
    expect(css).toMatch(/--assistant-panel-h/);
    expect(css).toMatch(/max-height:\s*calc\(\s*var\(--assistant-log-h[^)]*\)\s*\*\s*0\.75\s*\)/);
  });

  it('clamps dock above bottom chrome so it is not covered by bottom-nav', async () => {
    const { clampVoiceDockPos } = await import('../../src/web/VoiceControl.js');
    const pos = clampVoiceDockPos(0.9, 0.99, 60, {
      width: 390,
      height: 844,
      bottomChrome: 72,
      topChrome: 48,
    });
    // Center must stay above bottom-nav band (~72px).
    const centerY = pos.y * 844;
    expect(centerY).toBeLessThanOrEqual(844 - 72 - 10 - 30); // pad + half size
    expect(pos.y).toBeLessThan(0.95);
    // z-index above bottom-nav
    const css = await readFile(join(ROOT, 'src/web/styles.css'), 'utf8');
    expect(css).toMatch(/\.voice-shell\s*\{[^}]*z-index:\s*55/s);
    expect(css).toMatch(/\.bottom-nav\s*\{[^}]*z-index:\s*50/s);
  });

  it('matches the reference audio path: 24kHz + MediaStream sink + speech_started flush only', async () => {
    // projects/va-rewrite/app/VoiceAgent.tsx is the known-good phone client.
    const src = await readFile(join(ROOT, 'src/web/VoiceControl.tsx'), 'utf8');
    expect(src).toMatch(/INPUT_SAMPLE_RATE = 24_000/);
    expect(src).toMatch(/createMediaStreamDestination/);
    expect(src).toMatch(/sinkNodeRef/);
    expect(src).toMatch(/speech_started_flush|speech_started/);
    expect(src).toMatch(/flushPlayback\(\)/);
    // Must not cancel the model mid-turn (silence footgun).
    expect(src).not.toMatch(/response\.cancel/);
    // TTS must prefer sink (AEC), not only raw destination.
    expect(src).toMatch(/source\.connect\(sinkNodeRef/);
  });

  it('server mints realtime token; SPA wires full handler set + announce', async () => {
    const voice = await readFile(join(ROOT, 'src/server/voice.ts'), 'utf8');
    expect(voice).toMatch(/mintVoiceClientSecret/);
    const api = await readFile(join(ROOT, 'src/server/api.ts'), 'utf8');
    expect(api).toMatch(/\/api\/voice\/session/);
    const app = await readFile(join(ROOT, 'src/web/App.tsx'), 'utf8');
    expect(app).toMatch(/VoiceControl/);
    // Face stays visible; Realtime is opt-in (not hide-orb-when-free).
    expect(app).toMatch(/realtimeAvailable=\{voiceConfigured\}/);
    expect(app).toMatch(/visible=\{Boolean\(token\)\}/);
    // Dual mode: agent text session + voice realtime.
    expect(app).toMatch(/sessions=\{/);
    expect(app).toMatch(/onSessionSynced/);
    expect(app).toMatch(/get_session/);
    expect(app).toMatch(/list_messages/);
    expect(app).toMatch(/read_live_steps/);
    expect(app).toMatch(/get_diff_summary/);
    expect(app).toMatch(/inspect_task/);
    expect(app).toMatch(/inspect_session/);
    expect(app).toMatch(/formatTaskIndex|readTaskPart/);
    expect(app).toMatch(/resolve_all_permissions/);
    expect(app).toMatch(/promote_to_task/);
    expect(app).toMatch(/approve_and_pr/);
    expect(app).toMatch(/steer_task/);
    expect(app).toMatch(/open_live_for_task/);
    expect(app).toMatch(/voiceAnnounceRef/);
    const css = await readFile(join(ROOT, 'src/web/styles.css'), 'utf8');
    expect(css).toMatch(/\.fab\s*\{[^}]*left:\s*max/s);
    expect(css).toMatch(/voice-orb-breathe|voice-orb-spin/);
    expect(css).toMatch(/backdrop-filter/);
    expect(css).toMatch(/\.voice-dock/);
    const vc = await readFile(join(ROOT, 'src/web/VoiceControl.tsx'), 'utf8');
    expect(vc).toMatch(/realtimeClientProtocols|xai-client-secret/);
    expect(vc).toMatch(/flushAnnouncements|announceRef/);
    expect(vc).toMatch(/mintVoiceSession/);
    expect(vc).toMatch(/loadVoiceDock/);
    expect(vc).toMatch(/is-collapsed|voice-orb-dot/);
    const va = await readFile(join(ROOT, 'src/web/voiceAudio.ts'), 'utf8');
    expect(va).toMatch(/xai-client-secret/);
    expect(vc).toMatch(/VoiceAvatar/);
    expect(vc).not.toMatch(/🎙/);
    const avatar = await readFile(join(ROOT, 'src/web/voiceAvatar.ts'), 'utf8');
    expect(avatar).toMatch(/isoWeekKey/);
    expect(avatar).toMatch(/voiceAvatarTraits/);
  });

  it('every VOICE_COMMAND has a handler key in App buildVoiceHandlers', async () => {
    const app = await readFile(join(ROOT, 'src/web/App.tsx'), 'utf8');
    for (const cmd of VOICE_COMMANDS) {
      // handler keys appear as `name: async` or `name: (`
      expect(app).toMatch(new RegExp(`${cmd.name}\\s*:`));
    }
  });
});

describe('assistant chat text selection (voice panel)', () => {
  // .voice-shell sets user-select:none for drag; every text bubble must
  // explicitly opt back in or it is unselectable on desktop and iOS.
  it('user bubbles opt back into text selection with iOS long-press support', async () => {
    const css = await readFile(join(ROOT, 'src/web/styles.css'), 'utf8');
    const userBlock = css.match(/\.voice-text-user \{[^}]*\}/)?.[0] ?? '';
    expect(userBlock).toMatch(/user-select:\s*text/);
    expect(userBlock).toMatch(/-webkit-user-select:\s*text/);
    expect(userBlock).toMatch(/-webkit-touch-callout:\s*default/);
  });

  it('assistant reply body allows iOS long-press callout', async () => {
    const css = await readFile(join(ROOT, 'src/web/styles.css'), 'utf8');
    const bodyBlock = css.match(/\.voice-reply-body \{[^}]*\}/)?.[0] ?? '';
    expect(bodyBlock).toMatch(/user-select:\s*text/);
    expect(bodyBlock).toMatch(/-webkit-touch-callout:\s*default/);
  });
});

describe('assistant panel cancel affordance', () => {
  it('shows a stop button while the agent turn is in flight', async () => {
    const vc = await readFile(join(ROOT, 'src/web/VoiceControl.tsx'), 'utf8');
    // Busy turn → visible cancel that stops the assistant session.
    expect(vc).toMatch(/stopSession as stopRemoteSession/);
    expect(vc).toMatch(/stopRemoteSession\(assistantSession\.id\)/);
    expect(vc).toMatch(/voice-text-cancel/);
  });
});

describe('assistant adapter choice', () => {
  it('Phone Assistant sessions start on the claude adapter (grok co-pilot kept narrating without acting)', async () => {
    const vc = await readFile(join(ROOT, 'src/web/VoiceControl.tsx'), 'utf8');
    const start = vc.slice(vc.indexOf('startAgentSession({'), vc.indexOf('permissionMode:'));
    expect(start).toMatch(/adapter: 'claude'/);
  });
});
