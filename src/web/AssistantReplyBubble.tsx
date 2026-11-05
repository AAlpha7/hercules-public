/**
 * Assistant reply bubble:
 * - Default: height fits content, capped at 75% of the message log's visible
 *   height (--assistant-log-h, published by VoiceControl).
 * - Short (unclamped) replies render as a plain markdown bubble — no chrome.
 * - Clamped replies get a chrome strip: double-click or 「全屏」→ fullscreen
 *   overlay; double-click again or 「收起」 to collapse.
 * Markdown body has no dblclick handler so select/copy stay normal.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Markdown } from './Markdown.js';
import { isReplyClamped } from './assistantReplyLayout.js';

export function AssistantReplyBubble({
  messageId,
  content,
}: {
  readonly messageId: string;
  readonly content: string;
}): JSX.Element {
  const [full, setFull] = useState(false);
  const [clamped, setClamped] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Track whether the capped scroll box actually cuts content off. Content
  // streams in and the log resizes (settings strip, keyboard), so observe.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = (): void => {
      // Fullscreen lifts the cap (nothing overflows) — keep the last inline
      // measurement so the chrome doesn't flicker away on exit.
      if (full) return;
      setClamped(isReplyClamped(el.scrollHeight, el.clientHeight));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // `full` re-attaches after the portal swap remounts the scroll box.
  }, [content, full]);

  // Esc closes fullscreen.
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFull(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [full]);

  const toggleFull = useCallback((e?: ReactMouseEvent): void => {
    e?.preventDefault();
    e?.stopPropagation();
    // Avoid leaving a word-selection from the second click of a double-click on chrome.
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    sel?.removeAllRanges();
    setFull((v) => !v);
  }, []);

  const onChromeDoubleClick = (e: ReactMouseEvent): void => {
    toggleFull(e);
  };

  const bubble = (
    <div
      className={`voice-text-bubble voice-text-assistant${full ? ' is-overlay' : ''}`}
      data-evidence="assistant-reply-bubble"
      data-message-id={messageId}
      data-full={full ? '1' : '0'}
      data-clamped={clamped ? '1' : '0'}
    >
      {(clamped || full) && (
        <div
          className="voice-reply-chrome"
          data-evidence="assistant-reply-chrome"
          onDoubleClick={onChromeDoubleClick}
          title={full ? '双击收起' : '双击全屏'}
        >
          <span className="muted voice-reply-chrome-label">
            {full ? '全屏 · 双击或点收起' : '双击顶栏全屏 · 正文可选中复制'}
          </span>
          <button
            type="button"
            className="voice-reply-expand-btn"
            aria-label={full ? 'Shrink reply' : 'Expand reply full screen'}
            title={full ? '收起' : '全屏'}
            onClick={(e) => toggleFull(e)}
          >
            {full ? '收起' : '全屏'}
          </button>
        </div>
      )}
      <div className="voice-reply-scroll" ref={scrollRef}>
        <div className="voice-reply-body">
          <Markdown text={content} />
        </div>
      </div>
    </div>
  );
  // Fullscreen escapes the panel: backdrop-filter on .voice-text-panel makes
  // it the containing block for position:fixed, so portal overlay to <body>.
  return full ? createPortal(bubble, document.body) : bubble;
}
