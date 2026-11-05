/**
 * Shared multi-line composer for free + task live sessions.
 * Enter = newline; Ctrl/Cmd+Enter = send; phone uses Send icon.
 *
 * Voice (free default): push-to-talk via browser Web Speech — no API key.
 * Optional paid fallback: WAV → Grok STT when Web Speech missing and server
 * has XAI_API_KEY.
 * Overlays (+ menu, task ref picker) dismiss on: ×, Escape, outside tap, or
 * choosing an item.
 */
import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import type { ChatAttachment, MessageRef, Task } from './api.js';
import { fetchSttStatus, transcribeVoice, uploadSessionAttachment } from './api.js';
import { startVoiceCapture, type VoiceCapture } from './voiceCapture.js';
import {
  startWebSpeechDictation,
  webSpeechAvailability,
  type WebSpeechDictation,
} from './webSpeechDictation.js';

export interface ComposerPayload {
  readonly message: string;
  readonly attachments: readonly ChatAttachment[];
  readonly refs: readonly MessageRef[];
}

type Overlay = 'none' | 'plus' | 'refs';

export function ChatComposer({
  sessionId,
  disabled,
  busy,
  running,
  tasks,
  placeholder,
  onSend,
  onError,
}: {
  sessionId: string;
  disabled?: boolean;
  busy?: boolean;
  running?: boolean;
  /** Optional task list for #ref picker. */
  tasks?: readonly Task[];
  placeholder?: string;
  onSend: (payload: ComposerPayload) => void | Promise<void>;
  onError: (msg: string) => void;
}): JSX.Element {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [refs, setRefs] = useState<MessageRef[]>([]);
  /** Free Web Speech session, if active. */
  const speechRef = useRef<WebSpeechDictation | null>(null);
  /** Paid WAV capture fallback. */
  const captureRef = useRef<VoiceCapture | null>(null);
  const [overlay, setOverlay] = useState<Overlay>('none');
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const closeOverlay = (): void => setOverlay('none');

  // Cleanup mic if composer unmounts mid-recording.
  useEffect(() => {
    return () => {
      speechRef.current?.abort();
      speechRef.current = null;
      captureRef.current?.abort();
      captureRef.current = null;
    };
  }, []);

  // Dismiss + / ref panels on outside pointer or Escape.
  useEffect(() => {
    if (overlay === 'none') return;
    const onPointer = (e: PointerEvent): void => {
      const el = rootRef.current;
      if (!el) return;
      const t = e.target;
      if (t instanceof Node && !el.contains(t)) closeOverlay();
    };
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeOverlay();
      }
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [overlay]);

  const canSend =
    !disabled &&
    !busy &&
    !uploading &&
    !transcribing &&
    (text.trim().length > 0 || attachments.length > 0 || refs.length > 0);

  const submit = async (): Promise<void> => {
    if (!canSend) return;
    const payload: ComposerPayload = {
      message: text,
      attachments: [...attachments],
      refs: [...refs],
    };
    setText('');
    setAttachments([]);
    setRefs([]);
    closeOverlay();
    await onSend(payload);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Escape' && overlay !== 'none') {
      e.preventDefault();
      closeOverlay();
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  };

  const onPickFiles = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) {
      closeOverlay();
      return;
    }
    setUploading(true);
    try {
      for (const file of Array.from(files).slice(0, 6 - attachments.length)) {
        const att = await uploadSessionAttachment(sessionId, file);
        setAttachments((prev) => [...prev, att]);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      closeOverlay();
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  /**
   * Push-to-talk dictation (free first):
   *  1) Browser Web Speech (no API key, no xAI bill)
   *  2) Optional paid Grok STT when Web Speech missing and server has a key
   */
  const toggleVoice = async (): Promise<void> => {
    closeOverlay();
    if (transcribing) return;

    // --- stop free speech ---
    if (listening && speechRef.current) {
      const session = speechRef.current;
      speechRef.current = null;
      setListening(false);
      setTranscribing(true);
      try {
        const chunk = (await session.stop()).trim();
        if (chunk) {
          setText((t) => (t.trim().length > 0 ? `${t.trimEnd()} ${chunk}` : chunk));
        }
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      } finally {
        setTranscribing(false);
      }
      return;
    }

    // --- stop paid WAV capture ---
    if (listening && captureRef.current) {
      const cap = captureRef.current;
      captureRef.current = null;
      setListening(false);
      setTranscribing(true);
      try {
        const blob = await cap.stop();
        const result = await transcribeVoice(blob, { filename: 'voice.wav' });
        const chunk = result.text.trim();
        if (chunk) {
          setText((t) => (t.trim().length > 0 ? `${t.trimEnd()} ${chunk}` : chunk));
        }
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      } finally {
        setTranscribing(false);
      }
      return;
    }

    // --- start free speech ---
    if (webSpeechAvailability() === 'available') {
      try {
        speechRef.current = startWebSpeechDictation();
        setListening(true);
        return;
      } catch (err) {
        // Fall through to paid STT if configured.
        onError(err instanceof Error ? err.message : String(err));
      }
    }

    // --- optional paid server STT ---
    try {
      const stt = await fetchSttStatus().catch(() => ({ configured: false }));
      if (!stt.configured) {
        onError(
          webSpeechAvailability() === 'unsupported'
            ? 'Free speech not supported in this browser. Type instead (no paid API required).'
            : 'Mic dictation unavailable. Type instead.',
        );
        setListening(false);
        return;
      }
      const cap = await startVoiceCapture();
      captureRef.current = cap;
      setListening(true);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      setListening(false);
    }
  };

  const taskChoices = (tasks ?? []).filter((t) => t.state !== 'cancelled').slice(0, 40);
  const already = new Set(refs.filter((r) => r.kind === 'task').map((r) => r.target));
  const voiceBusy = listening || transcribing;

  return (
    <div className="chat-compose" ref={rootRef}>
      {(attachments.length > 0 || refs.length > 0) && (
        <div className="compose-chips">
          {refs.map((r, i) => (
            <span key={`${r.kind}-${r.target}-${i}`} className="compose-chip">
              {r.kind}:{r.label ?? r.target}
              <button
                type="button"
                className="chip-x"
                aria-label="Remove ref"
                onClick={() => setRefs((prev) => prev.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </span>
          ))}
          {attachments.map((a) => (
            <span key={a.id} className="compose-chip">
              {a.kind === 'image' ? '🖼' : '📎'} {a.name}
              <button
                type="button"
                className="chip-x"
                aria-label="Remove attachment"
                onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <textarea
        rows={2}
        value={text}
        disabled={disabled || busy}
        placeholder={
          placeholder ??
          (transcribing
            ? 'Transcribing…'
            : listening
              ? 'Listening… tap mic again to stop'
              : running
                ? 'Queue a follow-up…'
                : 'Message…')
        }
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />

      <input
        ref={fileRef}
        type="file"
        multiple
        accept="image/*,.txt,.md,.json,.log,.csv,.pdf"
        className="compose-file-input"
        onChange={(e) => void onPickFiles(e.target.files)}
      />

      {overlay !== 'none' && (
        <div className="compose-overlay" role="dialog" aria-modal="true">
          <div className="compose-overlay-head">
            <span className="body-label">
              {overlay === 'plus' ? 'Add to message' : 'Reference a task'}
            </span>
            <button
              type="button"
              className="compose-overlay-close"
              aria-label="Close"
              onClick={closeOverlay}
            >
              ×
            </button>
          </div>

          {overlay === 'plus' && (
            <div className="compose-menu" role="menu">
              <button
                type="button"
                className="compose-menu-item"
                role="menuitem"
                onClick={() => fileRef.current?.click()}
              >
                Attach file / photo
              </button>
              <button
                type="button"
                className="compose-menu-item"
                role="menuitem"
                onClick={() => setOverlay('refs')}
              >
                Reference task…
              </button>
              <button type="button" className="compose-menu-item compose-menu-cancel" onClick={closeOverlay}>
                Cancel
              </button>
            </div>
          )}

          {overlay === 'refs' && (
            <div className="compose-ref-picker">
              {taskChoices.length === 0 ? (
                <div className="muted compose-ref-empty">No tasks available</div>
              ) : (
                taskChoices.map((t) => {
                  const taken = already.has(t.id);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      className="compose-menu-item compose-ref-item"
                      disabled={taken}
                      onClick={() => {
                        if (taken) return;
                        setRefs((prev) => [
                          ...prev,
                          { kind: 'task', target: t.id, label: t.title.slice(0, 40) },
                        ]);
                        closeOverlay();
                      }}
                    >
                      <code>{t.id}</code>
                      <span className="compose-ref-meta">
                        {t.state} · {t.title.slice(0, 40)}
                        {taken ? ' · added' : ''}
                      </span>
                    </button>
                  );
                })
              )}
              <button type="button" className="compose-menu-item compose-menu-cancel" onClick={closeOverlay}>
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {/* Not .actions — that class forces min-width:96px and stacks icon buttons. */}
      <div className="compose-main-actions">
        <button
          type="button"
          className={`icon-btn compose-plus${overlay !== 'none' ? ' is-open' : ''}`}
          disabled={disabled || busy || uploading || voiceBusy}
          title="Attach or reference"
          aria-label={overlay !== 'none' ? 'Close menu' : 'Attach or reference'}
          aria-expanded={overlay === 'plus' || overlay === 'refs'}
          onClick={() => setOverlay((o) => (o === 'plus' || o === 'refs' ? 'none' : 'plus'))}
        >
          {overlay !== 'none' ? '×' : '+'}
        </button>
        <button
          type="button"
          className={`icon-btn${listening ? ' is-live' : ''}${transcribing ? ' is-busy' : ''}`}
          disabled={disabled || busy || uploading || transcribing}
          title={
            listening
              ? 'Stop & transcribe (Grok STT)'
              : transcribing
                ? 'Transcribing…'
                : 'Voice (tap to talk · Grok STT)'
          }
          aria-label={
            listening ? 'Stop recording' : transcribing ? 'Transcribing' : 'Voice input'
          }
          onClick={() => void toggleVoice()}
        >
          {transcribing ? <span className="spinner" /> : listening ? '■' : '🎙'}
        </button>
        <span className="compose-actions-spacer" aria-hidden />
        <button
          type="button"
          className="icon-btn icon-btn-primary compose-send"
          disabled={!canSend}
          title={running ? 'Interrupt & send' : 'Send'}
          aria-label={running ? 'Interrupt and send' : 'Send'}
          onClick={() => void submit()}
        >
          {busy || uploading ? <span className="spinner" /> : '↑'}
        </button>
      </div>
    </div>
  );
}
