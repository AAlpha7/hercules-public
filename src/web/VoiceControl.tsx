/**
 * Hercules Voice Control — Grok Realtime full-duplex assistant for the phone UI.
 *
 * Scope: navigate, open sessions/tasks, send_chat, approvals, stop — NOT coding.
 *
 * Audio path is aligned with a reference voice-agent app,
 * which is known-good on phones:
 *   - Fixed 24 kHz AudioContext + session PCM (not device-native rates)
 *   - Reply audio: WebAudio → MediaStreamDestination → hidden <audio>
 *     (browser AEC uses the *element* as reference; raw destination is NOT
 *     echo-cancelled → agent heard itself → speech_started barge-in)
 *   - Mic always uplinks; speech_started only flushes local playback (no cancel)
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type MouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  mintVoiceSession,
  patchSession,
  sendSessionMessage,
  setSessionPermissionMode,
  stopSession as stopRemoteSession,
  startSession as startAgentSession,
  waitForSessionSettled,
  type PermissionMode,
  type RemoteSession,
  type RepoDto,
} from './api.js';
import { SegmentedControl } from './SegmentedControl.js';
import {
  dispatchVoiceCommand,
  realtimeVoiceTools,
  resolveVoiceLanguageHint,
  voiceControlInstructions,
  type VoiceHandlers,
} from './voiceCommands.js';
import {
  ASSISTANT_SESSION_TITLE,
  buildAssistantBootMessage,
  findAssistantSession,
  formatAssistantUserTurn,
  pickAssistantRepo,
  visibleAssistantMessages,
} from './assistantProtocol.js';
import { AssistantReplyBubble } from './AssistantReplyBubble.js';
import { VoiceAvatar } from './VoiceAvatar.js';
import { isoWeekKey, voiceAvatarTraits } from './voiceAvatar.js';
import {
  buildRealtimeWsUrl,
  decodeBase64Pcm16,
  realtimeClientProtocols,
} from './voiceAudio.js';
import { VoiceDiag } from './voiceDiag.js';
import {
  loadAssistantMode,
  loadVoiceDock,
  saveAssistantMode,
  saveVoiceDock,
  type AssistantMode,
  type VoiceDockPrefs,
} from './prefs.js';

const IDLE_HANGUP_MS = 120_000;
const CONTEXT_POLL_MS = 3_000;
const MAX_RECONNECT = 2;
/** xAI default PCM rate — keep session + AudioContext + buffers identical. */
const INPUT_SAMPLE_RATE = 24_000;

type Phase = 'idle' | 'connecting' | 'live';

/** Keep the dock fully above bottom-nav / safe edges (viewport fractions). */
export function clampVoiceDockPos(
  x: number,
  y: number,
  sizePx: number,
  viewport?: { width: number; height: number; bottomChrome: number; topChrome: number },
): { x: number; y: number } {
  const vw = Math.max(1, viewport?.width ?? (typeof window !== 'undefined' ? window.innerWidth : 390));
  const vh = Math.max(1, viewport?.height ?? (typeof window !== 'undefined' ? window.innerHeight : 844));
  let bottomChrome = viewport?.bottomChrome;
  const topChrome = viewport?.topChrome ?? 48;
  if (bottomChrome === undefined) {
    bottomChrome = 72;
    if (typeof document !== 'undefined') {
      const nav = document.querySelector('.bottom-nav');
      if (nav instanceof HTMLElement) {
        bottomChrome = Math.max(56, nav.getBoundingClientRect().height);
      }
    }
  }
  const pad = 10;
  const half = sizePx / 2;
  const minX = (half + pad) / vw;
  const maxX = Math.max(minX, 1 - (half + pad) / vw);
  // Bottom: reserve full bottom-nav so the orb is never covered.
  const minY = (half + pad + topChrome) / vh;
  const maxY = Math.max(minY, 1 - (half + pad + bottomChrome) / vh);
  const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
  return {
    x: clamp(x, minX, maxX),
    y: clamp(y, minY, maxY),
  };
}

export function VoiceControl({
  /** Show the orb + avatar (false only when logged out). */
  visible = true,
  /** Server can mint Realtime secrets (credentials present). */
  realtimeAvailable = false,
  /** Live sessions — used to find/reuse Phone Assistant free session. */
  sessions = [],
  /** Repos for assistant worktree pick. */
  repos = [],
  /** Same activity matrix as Chat SessionChat (ACP tool stream). */
  sessionActivity = {},
  /** Parent merges session after assistant turns (SSE may lag). */
  onSessionSynced,
  /**
   * Open the real Chat sheet on the Phone Assistant free session — full live
   * steps / permissions / markdown (one system, not a second chat stack).
   */
  onOpenInChat,
  handlersRef,
  buildScreenContext,
  announceRef,
  onError,
}: {
  readonly visible?: boolean;
  readonly realtimeAvailable?: boolean;
  readonly sessions?: readonly RemoteSession[];
  readonly repos?: readonly RepoDto[];
  readonly sessionActivity?: Record<string, string[]>;
  readonly onSessionSynced?: (s: RemoteSession) => void;
  readonly onOpenInChat?: (sessionId: string) => void;
  handlersRef: MutableRefObject<VoiceHandlers>;
  buildScreenContext: () => string;
  /** Parent pushes proactive notices (new perms / turn done) while live. */
  announceRef?: MutableRefObject<(text: string) => void>;
  onError: (msg: string) => void;
}): JSX.Element | null {
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  /** voice = Grok Realtime; text = free agent session co-pilot. */
  const [mode, setMode] = useState<AssistantMode>(() => loadAssistantMode());
  const [textDraft, setTextDraft] = useState('');
  const [textBusy, setTextBusy] = useState(false);
  const [localAssistant, setLocalAssistant] = useState<RemoteSession | null>(null);
  const textEndRef = useRef<HTMLDivElement | null>(null);
  const activityListRef = useRef<HTMLOListElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  // Rarely-used controls (mode seg / permissions / open-in-chat) collapse
  // behind ⋯; fresh panel opens always start collapsed.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Publish the log's visible height so bubbles cap at 75% of what the user
  // can actually see (--assistant-log-h, consumed in styles.css).
  const logRoRef = useRef<ResizeObserver | null>(null);
  const attachTextLog = useCallback((el: HTMLDivElement | null): void => {
    logRoRef.current?.disconnect();
    logRoRef.current = null;
    if (!el) return;
    const apply = (): void => {
      el.style.setProperty('--assistant-log-h', `${el.clientHeight}px`);
    };
    apply();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(apply);
      ro.observe(el);
      logRoRef.current = ro;
    }
  }, []);

  const buildCtxRef = useRef(buildScreenContext);
  useEffect(() => {
    buildCtxRef.current = buildScreenContext;
  });

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  /** Reference path: WebAudio → MediaStreamDestination → <audio> (AEC reference). */
  const sinkNodeRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const sinkElRef = useRef<HTMLAudioElement | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scheduledRef = useRef<AudioBufferSourceNode[]>([]);
  const nextPlayRef = useRef(0);
  const timersRef = useRef<ReturnType<typeof setInterval>[]>([]);
  const lastActivityRef = useRef(0);
  const lastContextRef = useRef('');
  const stoppingRef = useRef(false);
  const userStoppedRef = useRef(false);
  const reconnectRef = useRef(0);
  const conversationIdRef = useRef<string | null>(null);
  const sessionSeqRef = useRef(0);
  const activeResponsesRef = useRef(0);
  const pendingCreateAcksRef = useRef(0);
  const announceQueueRef = useRef<string[]>([]);
  const mintAndConnectRef = useRef<((opts: { startedAt: number; seq: number }) => Promise<void>) | null>(
    null,
  );
  const orbRef = useRef<HTMLDivElement | null>(null);
  /** True after a live/connecting session — used to auto-collapse only post hang-up. */
  const wasLiveRef = useRef(false);
  const flushPlaybackRef = useRef<() => void>(() => undefined);
  const diagRef = useRef(new VoiceDiag());
  /** Last session fact dump (for long-press copy). */
  const [lastDiagDump, setLastDiagDump] = useState<string | null>(null);
  /** Collapsed mini-dot + free position (localStorage). */
  const [dock, setDock] = useState<VoiceDockPrefs>(() => loadVoiceDock());
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
    captured: boolean;
  } | null>(null);
  /** Suppress synthetic click after we already handled pointerup as a click. */
  const skipClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  // Re-clamp after mount/resize so a saved "under nav" position is lifted.
  useEffect(() => {
    const reclamp = (): void => {
      setDock((prev) => {
        const size = prev.collapsed ? 22 : 60;
        const pos = clampVoiceDockPos(prev.x, prev.y, size);
        if (pos.x === prev.x && pos.y === prev.y) return prev;
        const next = { ...prev, ...pos };
        saveVoiceDock(next);
        return next;
      });
    };
    reclamp();
    window.addEventListener('resize', reclamp);
    window.visualViewport?.addEventListener('resize', reclamp);
    window.visualViewport?.addEventListener('scroll', reclamp);
    return () => {
      window.removeEventListener('resize', reclamp);
      window.visualViewport?.removeEventListener('resize', reclamp);
      window.visualViewport?.removeEventListener('scroll', reclamp);
    };
  }, []);

  const stopSession = useCallback((notice?: string, opts?: { readonly quiet?: boolean }) => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    sessionSeqRef.current += 1;
    for (const t of timersRef.current) clearInterval(t);
    timersRef.current = [];
    announceQueueRef.current = [];
    conversationIdRef.current = null;
    // Capture facts before tearing down audio graph.
    diagRef.current.note('session_stop', notice ?? (opts?.quiet ? 'unmount' : 'user'));
    const dump = diagRef.current.formatDump();
    const summary = diagRef.current.formatSummary();
    setLastDiagDump(dump);
    // .catch, not try/catch — the rejection is async (headless/Safari deny
    // clipboard without a user gesture) and try/catch never sees it.
    navigator.clipboard?.writeText(dump).catch(() => {
      /* clipboard may be blocked */
    });
    try {
      processorRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      micSourceRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    processorRef.current = null;
    micSourceRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    for (const s of scheduledRef.current) {
      try {
        s.stop();
      } catch {
        /* ignore */
      }
    }
    scheduledRef.current = [];
    nextPlayRef.current = 0;
    activeResponsesRef.current = 0;
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    if (sinkElRef.current) {
      try {
        sinkElRef.current.pause();
        sinkElRef.current.srcObject = null;
      } catch {
        /* ignore */
      }
      sinkElRef.current = null;
    }
    sinkNodeRef.current = null;
    void audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
    setPhase('idle');
    setElapsed(0);
    setBusy(false);
    // Quiet stop by default (no toast spam). Diag is on clipboard + long-press.
    // Errors still surface notice + one-line summary.
    if (!opts?.quiet && notice) {
      onError(`${notice}\n${summary}`);
    }
    stoppingRef.current = false;
  }, [onError]);

  useEffect(() => () => stopSession(undefined, { quiet: true }), [stopSession]);
  useEffect(() => {
    if (!visible || !realtimeAvailable) stopSession(undefined, { quiet: true });
  }, [visible, realtimeAvailable, stopSession]);

  const locale = typeof navigator !== 'undefined' ? navigator.language || 'en' : 'en';
  const preferredLangs =
    typeof navigator !== 'undefined' && Array.isArray(navigator.languages)
      ? navigator.languages
      : [locale];
  /** ASR bias (null = auto). Prefer zh when any preferred language is Chinese. */
  const languageHint = resolveVoiceLanguageHint(locale, preferredLangs);

  const sendSessionUpdate = useCallback((screenContext: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          instructions: voiceControlInstructions(screenContext, locale),
          turn_detection: { type: 'server_vad' },
          voice: 'eve',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: INPUT_SAMPLE_RATE },
              ...(languageHint
                ? { transcription: { language_hint: languageHint } }
                : {}),
            },
            output: { format: { type: 'audio/pcm', rate: INPUT_SAMPLE_RATE } },
          },
          // The reference app enables resumption for phone background reconnects.
          resumption: { enabled: true },
          tools: realtimeVoiceTools(),
          tool_choice: 'auto',
        },
      }),
    );
  }, [locale, languageHint]);

  const flushPlayback = useCallback(() => {
    for (const s of scheduledRef.current) {
      try {
        s.stop();
      } catch {
        /* ignore */
      }
    }
    scheduledRef.current = [];
    nextPlayRef.current = 0;
  }, []);

  useEffect(() => {
    flushPlaybackRef.current = flushPlayback;
  }, [flushPlayback]);

  const isSpeaking = useCallback(() => {
    const ctx = audioCtxRef.current;
    return Boolean(ctx && nextPlayRef.current > ctx.currentTime + 0.05);
  }, []);

  const flushAnnouncements = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (activeResponsesRef.current > 0 || isSpeaking()) return;
    const pending = announceQueueRef.current.splice(0, announceQueueRef.current.length);
    if (!pending.length) return;
    for (const text of pending) {
      ws.send(
        JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'system',
            content: [
              {
                type: 'input_text',
                text: `BACKGROUND UPDATE — relay briefly in the user's language: ${text}`,
              },
            ],
          },
        }),
      );
    }
    activeResponsesRef.current += 1;
    pendingCreateAcksRef.current += 1;
    ws.send(JSON.stringify({ type: 'response.create' }));
  }, [isSpeaking]);

  useEffect(() => {
    if (!announceRef) return;
    announceRef.current = (text: string) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      announceQueueRef.current.push(text);
      flushAnnouncements();
    };
    return () => {
      announceRef.current = () => undefined;
    };
  }, [announceRef, flushAnnouncements]);

  /**
   * Reference path: decode PCM16 → schedule on MediaStreamDestination → <audio>.
   * Never connect TTS to ctx.destination (breaks AEC → self-hear barge-in).
   */
  const playAudioDelta = useCallback((base64: string) => {
    const ctx = audioCtxRef.current;
    if (!ctx || !base64) return;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => undefined);
    }
    const pcm = decodeBase64Pcm16(base64);
    diagRef.current.note('response.output_audio.delta', String(base64.length));
    if (pcm.length === 0) {
      diagRef.current.note('audio_delta_empty_pcm', String(base64.length));
      return;
    }
    const buffer = ctx.createBuffer(1, pcm.length, INPUT_SAMPLE_RATE);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = (pcm[i] ?? 0) / 32768;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(sinkNodeRef.current ?? ctx.destination);
    const startAt = Math.max(ctx.currentTime, nextPlayRef.current);
    try {
      source.start(startAt);
    } catch {
      return;
    }
    nextPlayRef.current = startAt + buffer.duration;
    scheduledRef.current.push(source);
    source.onended = () => {
      scheduledRef.current = scheduledRef.current.filter((s) => s !== source);
    };
  }, []);

  const pushContextIfChanged = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Skip mid-TTS so we don't talk over the agent (the reference app still pushes; we prefer quiet).
    if (isSpeaking() || activeResponsesRef.current > 0) return;
    const context = buildCtxRef.current();
    if (context === lastContextRef.current) return;
    lastContextRef.current = context;
    sendSessionUpdate(context);
    ws.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text: `SCREEN CONTEXT UPDATE:\n${context}` }],
        },
      }),
    );
  }, [sendSessionUpdate, isSpeaking]);

  const handleFunctionCall = useCallback(
    async (name: string, callId: string, argsJson: string) => {
      setBusy(true);
      const result = await dispatchVoiceCommand(handlersRef.current, name, argsJson);
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: callId,
            output: JSON.stringify(result),
          },
        }),
      );
      activeResponsesRef.current += 1;
      pendingCreateAcksRef.current += 1;
      ws.send(JSON.stringify({ type: 'response.create' }));
      setTimeout(() => {
        if (wsRef.current === ws) pushContextIfChanged();
      }, 600);
    },
    [handlersRef, pushContextIfChanged],
  );

  const mintAndConnect = useCallback(
    async (opts: { startedAt: number; seq: number }) => {
      let data;
      try {
        data = await mintVoiceSession();
      } catch (err) {
        throw new Error(
          `Voice mint failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (sessionSeqRef.current !== opts.seq) return;
      // Server mints with XAI_VOICE_MODEL_DEFAULT (grok-voice-latest); keep same fallback.
      const wsUrl = buildRealtimeWsUrl(data.wsUrl, {
        model: data.model || 'grok-voice-latest',
        conversationId: conversationIdRef.current,
      });
      const protocols = realtimeClientProtocols(data.clientSecret);
      if (protocols.length === 0) {
        throw new Error('Voice mint returned an empty client token');
      }
      const ws = new WebSocket(wsUrl, protocols);
      wsRef.current = ws;
      lastActivityRef.current = Date.now();
      const maxMs = Math.max(60, data.maxSessionSeconds || 600) * 1000;
      let opened = false;

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        opened = true;
        activeResponsesRef.current = 0;
        pendingCreateAcksRef.current = 0;
        setTimeout(() => {
          if (wsRef.current === ws && ws.readyState === WebSocket.OPEN) reconnectRef.current = 0;
        }, 10_000);

        lastContextRef.current = buildCtxRef.current();
        sendSessionUpdate(lastContextRef.current);

        const ctx = audioCtxRef.current;
        const stream = streamRef.current;
        if (ctx && stream && !processorRef.current) {
          // iOS often starts suspended until a user gesture — we are inside one.
          if (ctx.state === 'suspended') {
            void ctx.resume().catch(() => undefined);
          }
          const source = ctx.createMediaStreamSource(stream);
          const processor = ctx.createScriptProcessor(2048, 1, 1);
          micSourceRef.current = source;
          processorRef.current = processor;
          // Reference app: always uplink mic. AEC comes from element-routed playback,
          // not from muting the mic (muting caused silent sessions when stuck).
          processor.onaudioprocess = (event) => {
            const socket = wsRef.current;
            if (!socket || socket.readyState !== WebSocket.OPEN) return;
            const input = event.inputBuffer.getChannelData(0);
            const pcm = new Int16Array(input.length);
            let energy = 0;
            for (let i = 0; i < input.length; i++) {
              const v = Math.max(-1, Math.min(1, input[i] ?? 0));
              pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
              energy += v * v;
            }
            const level = Math.min(1, Math.sqrt(energy / Math.max(1, input.length)) * 6);
            orbRef.current?.style.setProperty('--voice-level', level.toFixed(3));
            const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0);
            socket.send(
              JSON.stringify({ type: 'input_audio_buffer.append', audio: btoa(binary) }),
            );
          };
          source.connect(processor);
          // ScriptProcessor only fires when connected to a destination; zero-gain.
          const mute = ctx.createGain();
          mute.gain.value = 0;
          processor.connect(mute);
          mute.connect(ctx.destination);
        }

        setPhase('live');
        if (timersRef.current.length === 0) {
          timersRef.current.push(
            setInterval(() => {
              setElapsed(Math.floor((Date.now() - opts.startedAt) / 1000));
              flushAnnouncements();
              if (Date.now() - opts.startedAt >= maxMs) {
                userStoppedRef.current = true;
                stopSession('Voice Control: session time limit reached.');
              } else if (Date.now() - lastActivityRef.current >= IDLE_HANGUP_MS) {
                userStoppedRef.current = true;
                stopSession('Voice Control: idle disconnect.');
              }
            }, 1000),
          );
          timersRef.current.push(setInterval(() => pushContextIfChanged(), CONTEXT_POLL_MS));
        }
      };

      ws.onmessage = (event) => {
        if (wsRef.current !== ws) return;
        let message: {
          type?: string;
          delta?: string;
          name?: string;
          call_id?: string;
          arguments?: string;
          error?: { message?: string };
          conversation?: { id?: string };
        };
        try {
          message = JSON.parse(String(event.data)) as typeof message;
        } catch {
          return;
        }
        // Fact log every event type (audio deltas logged in playAudioDelta with size).
        if (message.type !== 'response.output_audio.delta') {
          diagRef.current.note(message.type || 'unknown_event');
        }
        switch (message.type) {
          case 'conversation.created':
            if (message.conversation?.id) conversationIdRef.current = String(message.conversation.id);
            break;
          case 'response.created':
            if (pendingCreateAcksRef.current > 0) pendingCreateAcksRef.current -= 1;
            else activeResponsesRef.current += 1;
            setBusy(true);
            break;
          case 'response.done':
            activeResponsesRef.current = Math.max(0, activeResponsesRef.current - 1);
            if (activeResponsesRef.current === 0) setBusy(false);
            flushAnnouncements();
            break;
          case 'response.output_audio.delta':
            lastActivityRef.current = Date.now();
            playAudioDelta(String(message.delta || ''));
            break;
          case 'input_audio_buffer.speech_started':
            // Reference app: barge-in = flush local TTS only (AEC via <audio> prevents self-hear).
            lastActivityRef.current = Date.now();
            diagRef.current.note('speech_started_flush');
            flushPlayback();
            break;
          case 'response.function_call_arguments.done':
            lastActivityRef.current = Date.now();
            void handleFunctionCall(
              String(message.name || ''),
              String(message.call_id || ''),
              String(message.arguments || '{}'),
            );
            break;
          case 'error':
            onError(message.error?.message || 'Voice Control error');
            if (pendingCreateAcksRef.current > 0) pendingCreateAcksRef.current -= 1;
            activeResponsesRef.current = Math.max(0, activeResponsesRef.current - 1);
            flushAnnouncements();
            break;
          default:
            break;
        }
      };

      ws.onerror = () => {
        // Browsers hide the real reason; onclose carries code/reason.
        if (!opened) {
          onError('Voice WebSocket failed to open (network or auth). Retry the orb.');
        }
      };

      ws.onclose = (ev) => {
        if (wsRef.current !== ws) return;
        if (userStoppedRef.current || stoppingRef.current) {
          stopSession();
          return;
        }
        if (reconnectRef.current < MAX_RECONNECT) {
          reconnectRef.current += 1;
          setPhase('connecting');
          void mintAndConnectRef.current?.(opts).catch((err) =>
            stopSession(
              err instanceof Error ? err.message : 'Voice connection lost.',
            ),
          );
          return;
        }
        const reason = ev.reason?.trim() ? ` (${ev.reason.trim()})` : '';
        stopSession(
          opened
            ? `Voice connection lost${reason}.`
            : `Voice WebSocket closed before open (code ${ev.code})${reason}.`,
        );
      };
    },
    [
      sendSessionUpdate,
      playAudioDelta,
      flushPlayback,
      flushAnnouncements,
      handleFunctionCall,
      pushContextIfChanged,
      stopSession,
      onError,
    ],
  );

  useEffect(() => {
    mintAndConnectRef.current = mintAndConnect;
  }, [mintAndConnect]);

  const startSession = useCallback(async () => {
    if (phase !== 'idle') return;
    if (!realtimeAvailable) {
      onError(
        'Voice agent is not configured. Log in with Grok CLI on the host, or set XAI_API_KEY, then restart Hercules.',
      );
      return;
    }
    setPhase('connecting');
    userStoppedRef.current = false;
    reconnectRef.current = 0;
    conversationIdRef.current = null;
    const seq = sessionSeqRef.current + 1;
    sessionSeqRef.current = seq;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (sessionSeqRef.current !== seq) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) throw new Error('Web Audio not available');
      // Reference app: pin 24 kHz so capture, session, and createBuffer match.
      const ctx = new AudioCtx({ sampleRate: INPUT_SAMPLE_RATE });
      if (ctx.state === 'suspended') {
        await ctx.resume().catch(() => undefined);
      }
      audioCtxRef.current = ctx;
      nextPlayRef.current = 0;
      diagRef.current.reset({
        sampleRateCtx: ctx.sampleRate,
        sampleRateSession: INPUT_SAMPLE_RATE,
      });
      diagRef.current.note(
        'audio_ctx',
        `ctx=${ctx.sampleRate} session=${INPUT_SAMPLE_RATE} state=${ctx.state}`,
      );
      // Reference app: element-routed playback for AEC (click is the user gesture for play()).
      const sink = ctx.createMediaStreamDestination();
      sinkNodeRef.current = sink;
      const el = document.createElement('audio');
      el.autoplay = true;
      el.setAttribute('playsinline', 'true');
      el.muted = false;
      el.volume = 1;
      el.srcObject = sink.stream;
      void el.play().catch(() => undefined);
      sinkElRef.current = el;

      await mintAndConnect({ startedAt: Date.now(), seq });
    } catch (err) {
      stopSession();
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [phase, realtimeAvailable, mintAndConnect, stopSession, onError]);

  const updateDock = useCallback((next: VoiceDockPrefs): void => {
    setDock(next);
    saveVoiceDock(next);
  }, []);

  // Tap outside the assistant shell → collapse panel/orb back to the mini-dot.
  useEffect(() => {
    if (dock.collapsed || phase !== 'idle') return;
    const onPointer = (e: PointerEvent): void => {
      const root = shellRef.current;
      const t = e.target;
      if (!root || !(t instanceof Node)) return;
      if (root.contains(t)) return;
      // Fullscreen reply overlay portals to <body> — taps inside it (收起,
      // scrolling, selecting) must not collapse the dock.
      if (t instanceof Element && t.closest('.voice-text-assistant.is-overlay')) return;
      // Don't steal taps while the user is mid-drag on the orb.
      if (dragRef.current) return;
      setDock((prev) => {
        if (prev.collapsed) return prev;
        const next = { ...prev, collapsed: true };
        saveVoiceDock(next);
        return next;
      });
    };
    // Capture phase so sheet stopPropagation does not swallow outside taps.
    document.addEventListener('pointerdown', onPointer, true);
    return () => document.removeEventListener('pointerdown', onPointer, true);
  }, [dock.collapsed, phase]);

  const setAssistantMode = useCallback((next: AssistantMode): void => {
    setMode(next);
    saveAssistantMode(next);
    // Switching to text stops live voice so we don't double-bill.
    if (next === 'text' && phase !== 'idle') {
      userStoppedRef.current = true;
      stopSession();
    }
  }, [phase, stopSession]);

  // Prefer SSE/parent sessions; fall back to last local snapshot after send.
  const assistantSession =
    findAssistantSession(sessions) ??
    (localAssistant && findAssistantSession([localAssistant]) ? localAssistant : null);

  // Live / connecting always expands so status is visible.
  useEffect(() => {
    if (phase === 'idle') return;
    wasLiveRef.current = true;
    setDock((prev) => {
      if (!prev.collapsed) return prev;
      const next = { ...prev, collapsed: false };
      saveVoiceDock(next);
      return next;
    });
  }, [phase]);

  // After hang-up only, fold back to the mini-dot (don't collapse a manual expand).
  // Skip when text mode panel is open — user is mid-chat.
  useEffect(() => {
    if (phase !== 'idle' || !wasLiveRef.current) return;
    if (mode === 'text' && !dock.collapsed) {
      wasLiveRef.current = false;
      return;
    }
    wasLiveRef.current = false;
    const t = window.setTimeout(() => {
      setDock((prev) => {
        if (prev.collapsed) return prev;
        const next = { ...prev, collapsed: true };
        saveVoiceDock(next);
        return next;
      });
    }, 2_500);
    return () => window.clearTimeout(t);
  }, [phase, mode, dock.collapsed]);

  // Pin text transcript to latest.
  useEffect(() => {
    if (mode !== 'text' || dock.collapsed) return;
    textEndRef.current?.scrollIntoView({ block: 'end' });
  }, [mode, dock.collapsed, assistantSession?.messages.length, assistantSession?.updatedAt]);

  // NOTE: the <<HERCULES_TOOL>> dispatch loop lives in App (single owner) —
  // it runs for turns sent from ANY surface, including the Chat sheet.

  const sendTextTurn = useCallback(async (): Promise<void> => {
    const text = textDraft.trim();
    if (!text || textBusy) return;
    const repo = pickAssistantRepo(repos);
    if (!repo) {
      onError('No repo configured — add a repo before using text assistant.');
      return;
    }
    setTextBusy(true);
    try {
      const turn = formatAssistantUserTurn(text, buildCtxRef.current());
      let s = findAssistantSession(sessions) ?? localAssistant;
      if (!s || s.status === 'closed') {
        const boot = buildAssistantBootMessage();
        // claude (2026-07-18, user-approved): the grok-4.5 co-pilot kept
        // ending turns with "Next I'll…" narration without acting.
        s = await startAgentSession({
          repo,
          title: ASSISTANT_SESSION_TITLE,
          message: `${boot}\n\n${turn}`,
          adapter: 'claude',
          permissionMode: 'acceptEdits',
        });
        try {
          s = await patchSession(s.id, { pinned: true });
        } catch {
          /* pin is best-effort */
        }
      } else {
        s = await sendSessionMessage(s.id, turn, {
          interrupt: s.status === 'running',
        });
      }
      onSessionSynced?.(s);
      setLocalAssistant(s);
      setTextDraft('');
      // Stay in text panel (same free-session system). Optional Chat jump is a link only.
      // Wait for the agent reply to land (SSE may lag); App runs the tool loop.
      if (s.status === 'running') {
        s = await waitForSessionSettled(s.id);
        onSessionSynced?.(s);
        setLocalAssistant(s);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setTextBusy(false);
    }
  }, [
    textDraft,
    textBusy,
    repos,
    sessions,
    localAssistant,
    onError,
    onSessionSynced,
  ]);

  const changeAssistantPermMode = useCallback(
    async (next: PermissionMode): Promise<void> => {
      const s = findAssistantSession(sessions) ?? localAssistant;
      if (!s || s.status === 'closed') {
        onError('Start a text turn first, then change permission mode.');
        return;
      }
      setTextBusy(true);
      try {
        const fresh = await setSessionPermissionMode(s.id, next);
        onSessionSynced?.(fresh);
        setLocalAssistant(fresh);
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      } finally {
        setTextBusy(false);
      }
    },
    [sessions, localAssistant, onError, onSessionSynced],
  );

  /** Open / expand / start voice — used from pointerup (desktop-safe) and keyboard. */
  const activateOrb = useCallback((): void => {
    if (phase !== 'idle') {
      userStoppedRef.current = true;
      stopSession();
      return;
    }
    if (dock.collapsed) {
      // First click on mini-dot: expand (don't start mic yet).
      updateDock({ ...dock, collapsed: false });
      return;
    }
    // Expanded + voice mode → start Realtime; text mode uses the panel send.
    if (mode === 'voice') {
      void startSession();
    }
  }, [phase, dock, mode, updateDock, stopSession, startSession]);

  const onOrbClick = (): void => {
    // pointerup already handled the click; ignore the synthetic mouse click.
    if (skipClickRef.current) {
      skipClickRef.current = false;
      return;
    }
    if (dragRef.current?.moved) return;
    activateOrb();
  };

  /** Long-press: re-copy last session diag dump (facts only). */
  const onOrbContextMenu = (e: MouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    if (!lastDiagDump) {
      onError('No voice diag yet — run a session, then long-press the orb.');
      return;
    }
    try {
      navigator.clipboard?.writeText(lastDiagDump).catch(() => {});
    } catch {
      /* ignore */
    }
    onError(`Voice diag copied (facts):\n${lastDiagDump.split('\n')[0] ?? ''}`);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    // Do NOT capture yet — early capture steals click away from the button on desktop.
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origX: dock.x,
      origY: dock.y,
      moved: false,
      captured: false,
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    // 10px threshold — tiny mouse jitter must not count as drag.
    if (!d.moved && dx * dx + dy * dy < 100) return;
    if (!d.moved) {
      d.moved = true;
      setDragging(true);
      try {
        orbRef.current?.setPointerCapture(e.pointerId);
        d.captured = true;
      } catch {
        /* ignore */
      }
    }
    const vw = Math.max(1, window.innerWidth);
    const vh = Math.max(1, window.innerHeight);
    setDock((prev) => {
      const size = prev.collapsed && phase === 'idle' ? 22 : 60;
      const rawX = d.origX + dx / vw;
      const rawY = d.origY + dy / vh;
      const pos = clampVoiceDockPos(rawX, rawY, size);
      return { ...prev, ...pos };
    });
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (d.captured) {
      try {
        orbRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    const wasDrag = d.moved;
    dragRef.current = null;
    setDragging(false);
    if (wasDrag) {
      setDock((prev) => {
        saveVoiceDock(prev);
        return prev;
      });
      // Swallow the trailing click after a drag.
      skipClickRef.current = true;
      window.setTimeout(() => {
        skipClickRef.current = false;
      }, 50);
      return;
    }
    // True click: handle here (desktop-reliable). Suppress the synthetic click.
    skipClickRef.current = true;
    window.setTimeout(() => {
      skipClickRef.current = false;
    }, 50);
    activateOrb();
  };

  if (!visible) return null;

  const persona = voiceAvatarTraits(isoWeekKey());
  const collapsed = dock.collapsed && phase === 'idle';
  const textOpen = !collapsed && mode === 'text';
  const title = collapsed
    ? `${persona.name} · drag to move · tap to expand`
    : mode === 'text'
      ? `${persona.name} · Text assistant · agent session`
      : phase === 'idle'
        ? `${persona.name} · Voice · tap to talk · long-press = diag`
        : phase === 'connecting'
          ? `${persona.name} connecting…`
          : `${persona.name} live · ${elapsed}s — tap to stop`;

  const size = collapsed ? 22 : 60;
  const visibleMsgs = assistantSession
    ? visibleAssistantMessages(assistantSession.messages)
    : [];
  const agentRunning = assistantSession?.status === 'running';
  const activityLines =
    assistantSession != null
      ? (sessionActivity[assistantSession.id] ?? [])
      : [];
  /** Last line text — length alone misses in-place draft updates. */
  const activityTail = activityLines.length > 0 ? activityLines[activityLines.length - 1] : '';

  // Live steps stream into an inner scroll box (.voice-text-activity, 7.5rem
  // cap) — pin it to the newest line, and keep the outer log at the end too
  // (the message-based pin never fires for pure activity updates).
  useEffect(() => {
    if (mode !== 'text' || dock.collapsed) return;
    const el = activityListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    textEndRef.current?.scrollIntoView({ block: 'end' });
  }, [mode, dock.collapsed, activityLines.length, activityTail]);

  return (
    <div
      ref={shellRef}
      className={[
        'voice-shell',
        collapsed ? 'is-collapsed' : 'is-expanded',
        textOpen ? 'is-text-open' : '',
        dragging ? 'is-dragging' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        left: `calc(${dock.x * 100}vw - ${size / 2}px)`,
        top: `calc(${dock.y * 100}vh - ${size / 2}px)`,
      }}
      data-evidence="voice-dock"
      data-mode={mode}
    >
      {textOpen && (
        <div
          className="voice-text-panel"
          data-evidence="assistant-text-panel"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="voice-text-head">
            <div className="voice-text-head-row">
              <span className="voice-text-title">
                {persona.name} · 文本助手
                {agentRunning ? ' · 处理中…' : ''}
              </span>
              <button
                type="button"
                className="voice-text-more"
                data-evidence="assistant-settings-toggle"
                aria-label="更多设置"
                aria-expanded={settingsOpen}
                title="模式 / 权限 / 在 Chat 打开"
                onClick={() => setSettingsOpen((v) => !v)}
              >
                ⋯
              </button>
            </div>
          </div>
          {settingsOpen && (
            <div className="voice-text-settings" data-evidence="assistant-settings">
              <span className="muted voice-text-sub">
                free session · Grok
                {assistantSession
                  ? ` · ${assistantSession.permissionMode === 'bypass' ? 'YOLO' : assistantSession.permissionMode === 'default' ? 'Ask' : 'Edits auto'}`
                  : ''}
              </span>
              <div className="voice-mode-seg" role="tablist" aria-label="Assistant mode">
                <button
                  type="button"
                  role="tab"
                  aria-selected
                  className="voice-mode-btn is-on"
                  onClick={() => setAssistantMode('text')}
                >
                  文本
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={false}
                  className="voice-mode-btn"
                  onClick={() => setAssistantMode('voice')}
                  title={
                    realtimeAvailable
                      ? 'Grok Realtime voice'
                      : 'Voice needs Grok credentials (Realtime)'
                  }
                >
                  语音
                </button>
              </div>
              {assistantSession && (
                <div className="voice-text-perm" data-evidence="assistant-perm-mode">
                  <span className="muted voice-text-perm-label">工具权限</span>
                  <SegmentedControl
                    ariaLabel="Assistant session permission mode"
                    value={assistantSession.permissionMode ?? 'acceptEdits'}
                    disabled={textBusy || assistantSession.status === 'closed'}
                    size="sm"
                    options={[
                      { value: 'acceptEdits', label: 'Edits auto', hint: 'Files auto; shell asks' },
                      { value: 'bypass', label: 'YOLO', hint: 'Auto-allow all tools' },
                      { value: 'default', label: 'Ask', hint: 'Ask for non-read tools' },
                    ]}
                    onChange={(next) => void changeAssistantPermMode(next)}
                  />
                </div>
              )}
              {assistantSession && onOpenInChat && (
                <button
                  type="button"
                  className="link voice-text-open-chat"
                  data-evidence="assistant-open-chat"
                  title="Optional: open the same free session in Chat sheet"
                  onClick={() => {
                    onOpenInChat(assistantSession.id);
                    setDock((prev) => {
                      const next = { ...prev, collapsed: true };
                      saveVoiceDock(next);
                      return next;
                    });
                  }}
                >
                  在 Chat 打开
                </button>
              )}
            </div>
          )}
          <div className="voice-text-log" data-evidence="assistant-text-log" ref={attachTextLog}>
            {visibleMsgs.length === 0 ? (
              <p className="muted voice-text-empty">
                回复贴合内容；超长回复会出现顶栏，可双击或点「全屏」。模式 / 权限 /
                在 Chat 打开见右上 ⋯。
              </p>
            ) : (
              visibleMsgs.map((m) =>
                m.role === 'assistant' ? (
                  <AssistantReplyBubble key={m.id} messageId={m.id} content={m.content} />
                ) : (
                  <div key={m.id} className="voice-text-bubble voice-text-user">
                    {m.content}
                  </div>
                ),
              )
            )}
            {agentRunning && (
              <details className="voice-text-live" open data-evidence="assistant-live-steps">
                <summary className="muted">
                  live steps
                  {activityLines.length > 0 ? ` · ${activityLines.length}` : ' · quiet'}
                </summary>
                <ol className="activity-timeline voice-text-activity" ref={activityListRef}>
                  {activityLines.length > 0 ? (
                    activityLines.map((line, i) => (
                      <li
                        key={i}
                        className={line.startsWith('…') ? 'activity-draft' : undefined}
                      >
                        {line}
                      </li>
                    ))
                  ) : (
                    <li className="muted">agent 运行中 — tools / 推理流可能稍后出现</li>
                  )}
                </ol>
              </details>
            )}
            {(assistantSession?.pendingPermissions?.length ?? 0) > 0 && (
              <div className="voice-text-perm-hint muted">
                有待批权限 · 可改模式，或说「允许 / 改成 YOLO」
              </div>
            )}
            <div ref={textEndRef} />
          </div>
          <div className="voice-text-compose">
            <textarea
              rows={2}
              value={textDraft}
              disabled={textBusy}
              placeholder={textBusy || agentRunning ? '助手处理中…' : '说点什么…'}
              onChange={(e) => setTextDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void sendTextTurn();
                }
              }}
            />
            {agentRunning && assistantSession ? (
              <button
                type="button"
                className="voice-text-cancel"
                title="取消当前回合"
                onClick={() => {
                  void stopRemoteSession(assistantSession.id).catch(() => {});
                }}
              >
                取消
              </button>
            ) : (
              <button
                type="button"
                className="primary voice-text-send"
                disabled={textBusy || textDraft.trim().length === 0}
                onClick={() => void sendTextTurn()}
              >
                {textBusy ? '…' : '发送'}
              </button>
            )}
          </div>
        </div>
      )}

      <div
        ref={orbRef}
        className={[
          'voice-dock',
          collapsed ? 'is-collapsed' : 'is-expanded',
          dragging ? 'is-dragging' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ width: size, height: size }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={onOrbContextMenu}
      >
        <button
          type="button"
          className={[
            'voice-orb',
            `phase-${phase}`,
            busy ? 'is-busy' : '',
            phase === 'live' && busy ? 'is-speaking' : '',
            collapsed ? 'is-collapsed' : '',
            mode === 'text' && !collapsed ? 'is-text-mode' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          aria-label={title}
          title={title}
          onClick={onOrbClick}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              activateOrb();
            }
          }}
          data-evidence="voice-orb"
          data-realtime={realtimeAvailable ? 'on' : 'off'}
          data-collapsed={collapsed ? '1' : '0'}
          data-mode={mode}
        >
          {collapsed ? (
            <span className="voice-orb-dot" aria-hidden />
          ) : (
            <>
              <VoiceAvatar phase={phase} />
              {phase === 'connecting' && (
                <span className="voice-orb-badge" aria-hidden>
                  …
                </span>
              )}
              {phase === 'live' && (
                <span className="voice-orb-time" aria-hidden>
                  {elapsed}s
                </span>
              )}
              {mode === 'text' && phase === 'idle' && (
                <span className="voice-orb-badge voice-orb-text-badge" aria-hidden>
                  Aa
                </span>
              )}
            </>
          )}
        </button>
        {!collapsed && phase === 'idle' && (
          <>
            {mode === 'voice' && (
              <div className="voice-mode-seg voice-mode-seg-float" role="tablist">
                <button
                  type="button"
                  className="voice-mode-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAssistantMode('text');
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  文本
                </button>
                <button
                  type="button"
                  className="voice-mode-btn is-on"
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  语音
                </button>
              </div>
            )}
            <button
              type="button"
              className="voice-orb-collapse"
              aria-label="Collapse voice dock"
              title="Collapse"
              onClick={(e) => {
                e.stopPropagation();
                updateDock({ ...dock, collapsed: true });
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              –
            </button>
          </>
        )}
      </div>
    </div>
  );
}
