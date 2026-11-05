/**
 * Phone-visible run timeline — structured kinds for failure attribution
 * without SSH. Collapsed by default; reuses domain resolve (activity + failure).
 *
 * Uncontrolled <details> (no React `open={…}` without onToggle). Host L2
 * evidenceDrive is plain el.click() — plans click summary to *open*, so the
 * panel must start closed. A death-cause chip stays on the summary so
 * `assert text=Death cause|xAI 502|mid-stream` still sees content if a closed
 * details would omit list rows from document.body.innerText
 * (2026-07-30 prune-latch-honesty L2).
 */
import { useRef, type JSX, type SyntheticEvent } from 'react';
import {
  resolveRunTimeline,
  type RunTimelineEvent,
  type RunTimelineKind,
} from '../domain/runTimeline.js';
import { isRecentSummaryGesture } from './sheetHabits.js';

const KIND_LABEL: Record<RunTimelineKind, string> = {
  dispatch: 'dispatch',
  agent_activity: 'activity',
  stall: 'stall',
  provision: 'provision',
  agent_exit: 'exit',
  l1: 'L1',
  l2: 'L2',
  l3: 'L3',
  packet_finalize: 'packet',
  mirror: 'mirror',
};

function toneClass(e: RunTimelineEvent): string {
  if (e.ok === true) return 'run-tl-ok';
  if (e.ok === false) return 'run-tl-fail';
  if (e.kind === 'agent_activity') return 'run-tl-activity';
  return 'run-tl-neutral';
}

function shortTime(iso: string): string {
  const t = iso.trim();
  if (!t) return '';
  // Prefer HH:MM:SS when ISO; else show truncated stamp.
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(t);
  if (m) return m[1]!;
  return t.length > 16 ? t.slice(0, 16) : t;
}

export function RunTimelinePanel({
  body,
  defaultOpen = false,
  dataSection,
  onUserToggle,
  onContentClick,
}: {
  readonly body: string;
  /** Prefer false — host L2 plain-clicks summary to open. */
  readonly defaultOpen?: boolean;
  /** Habit-adaptive section id (e.g. run-timeline). */
  readonly dataSection?: string;
  /** Real user open/close only — not programmatic. */
  readonly onUserToggle?: (open: boolean) => void;
  /** Real click on list body (not summary). */
  readonly onContentClick?: () => void;
}): JSX.Element | null {
  const events = resolveRunTimeline(body || '');
  const lastSummaryGestureAt = useRef<number | undefined>(undefined);
  const markSummaryGesture = (): void => {
    lastSummaryGestureAt.current = Date.now();
  };
  if (events.length === 0) return null;

  const terminal = events[events.length - 1]!;
  const kinds = new Set(events.map((e) => e.kind));
  // Prefer precise agent_exit death cause on the always-visible summary so
  // closed <details> still contribute to body.innerText for L2 text asserts.
  const deathHint =
    terminal.kind === 'agent_exit' && terminal.ok === false
      ? terminal.summary
      : kinds.has('agent_exit')
        ? events.find((e) => e.kind === 'agent_exit' && e.ok === false)?.summary
        : undefined;
  const kindHint = [
    deathHint
      ? deathHint
      : kinds.has('provision')
        ? 'provision'
        : kinds.has('stall')
          ? 'stall'
          : kinds.has('agent_exit')
            ? 'exit'
            : kinds.has('packet_finalize')
              ? 'packet'
              : terminal.kind,
    `${events.length} steps`,
  ].join(' · ');

  // Only set the open attribute when true — a controlled open={false}/defaultOpen
  // without onToggle fights native summary toggles (L2 plain click).
  return (
    <details
      className="run-timeline-panel"
      data-evidence="run-timeline"
      {...(dataSection ? { 'data-section': dataSection } : {})}
      {...(defaultOpen ? { open: true as const } : {})}
      {...(onUserToggle
        ? {
            onToggle: (e: SyntheticEvent<HTMLDetailsElement>) => {
              if (e.target !== e.currentTarget) return;
              // Programmatic open (defaultOpen / attribute) also fires toggle.
              if (!isRecentSummaryGesture(lastSummaryGestureAt.current)) return;
              lastSummaryGestureAt.current = undefined;
              onUserToggle(e.currentTarget.open);
            },
          }
        : {})}
    >
      <summary
        className="run-timeline-summary"
        data-evidence="run-timeline-summary"
        onPointerDown={markSummaryGesture}
        onClick={markSummaryGesture}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') markSummaryGesture();
        }}
      >
        <span className="run-timeline-title">Run timeline</span>
        <span className="muted run-timeline-hint">{kindHint}</span>
      </summary>
      <ol
        className="run-timeline-list"
        data-evidence="run-timeline-list"
        {...(onContentClick
          ? {
              onClick: (e: SyntheticEvent<HTMLOListElement>) => {
                // See TaskDetail: jsdom userEvent → detail > 0; el.click() → 0.
                const detail = (e.nativeEvent as MouseEvent).detail;
                if (!e.nativeEvent.isTrusted && !(detail > 0)) return;
                onContentClick();
              },
            }
          : {})}
      >
        {events.map((e, i) => (
          <li
            key={`${e.kind}-${e.at}-${i}`}
            className={`run-timeline-item ${toneClass(e)}`}
            data-evidence={`run-timeline-kind-${e.kind}`}
          >
            <span className="run-tl-kind">{KIND_LABEL[e.kind] ?? e.kind}</span>
            <span className="run-tl-time muted">{shortTime(e.at)}</span>
            <span
              className="run-tl-summary"
              data-evidence={
                // Precise death cause on agent_exit (retroactive L2 for agent-death-resilience).
                e.kind === 'agent_exit' && e.ok === false
                  ? 'agent-death-cause'
                  : undefined
              }
            >
              {e.ok === true ? '✅ ' : e.ok === false ? '❌ ' : ''}
              {e.summary}
            </span>
            {e.detail ? (
              <span
                className="run-tl-detail muted"
                data-evidence={
                  /adapter\s*降级|adapter\s*不健康/i.test(e.detail)
                    ? 'adapter-failover-timeline'
                    : undefined
                }
              >
                {e.detail}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </details>
  );
}
