/**
 * Remote Control — free interactive agent sessions (no task).
 * Phone-first chat: ACP multi-turn + permission modes + approval cards.
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import {
  approveSessionProposal,
  closeSession,
  createTaskFromSession,
  dismissSessionProposal,
  fetchSessionDiff,
  fetchSessionTaskDraft,
  openTaskLiveSession,
  patchSession,
  resolveSessionPermission,
  sendSessionMessage,
  setSessionPermissionMode,
  startSession,
  stopSession,
  type AdapterKind,
  type ChatMessage,
  type MessageAction,
  type PermissionMode,
  type RemoteSession,
  type RepoDto,
  type SessionDiff,
  type Task,
} from './api.js';
import { Markdown } from './Markdown.js';
import { cleanAssistantChatMessages, isAssistantSession } from './assistantProtocol.js';
import { ConfirmButton } from './ConfirmButton.js';
import { SegmentedControl } from './SegmentedControl.js';
import { ChatComposer } from './ChatComposer.js';

const MODE_OPTIONS: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'acceptEdits', label: 'Edits auto', hint: 'Files auto; shell asks' },
  { value: 'bypass', label: 'YOLO', hint: 'Auto-allow all tools' },
  { value: 'default', label: 'Ask', hint: 'Ask for non-read tools' },
];

/**
 * Client-side safety net for finished-task system lines that predate `actions`
 * (or lost them). Mirrors domain backfill so buttons still appear after soft refresh.
 */
function withMessageActions(
  messages: readonly ChatMessage[],
  fallbackTaskId?: string | null,
): ChatMessage[] {
  const finishedRe =
    /Task\s+`([A-Za-z0-9._-]+)`\s+finished this turn\s*→\s*\*?\*?([A-Za-z0-9._-]+)\*?\*?/i;
  return messages.map((msg) => {
    if (msg.role !== 'system' || (msg.actions?.length ?? 0) > 0) return msg;
    if (!/finished this turn/i.test(msg.content)) return msg;
    const m = finishedRe.exec(msg.content);
    const target = m?.[1] ?? fallbackTaskId ?? null;
    if (!target || !/^[A-Za-z0-9._-]+$/.test(target)) return msg;
    const state = (m?.[2] ?? '').toLowerCase();
    const label =
      state === 'review'
        ? 'Open review packet'
        : state === 'failed'
          ? 'Open failed task'
          : `Open task ${target}`;
    return {
      ...msg,
      actions: [{ kind: 'open_task' as const, target, label }],
    };
  });
}

export function SessionsPanel({
  sessions,
  sessionActivity,
  repos,
  availableAgents,
  defaultAgent,
  tasks,
  initialSessionId,
  /** Bump when bottom-nav Chat is re-tapped → force session list (deselect). */
  listEpoch,
  /**
   * Bump when App re-opens a session (e.g. task → Open live again) so we re-select
   * even if initialSessionId is unchanged.
   */
  focusEpoch,
  closeLabel = 'Close',
  onClose,
  onError,
  /** Parent merges forced task-live resync into state (and can refresh activity). */
  onSessionSynced,
  /** Deep-link from in-chat system actions (e.g. Open review packet). */
  onOpenTask,
  onOpenSession,
}: {
  sessions: readonly RemoteSession[];
  sessionActivity: Record<string, string[]>;
  repos: readonly RepoDto[];
  availableAgents: readonly string[];
  defaultAgent: string;
  /** For task reference picker. */
  tasks?: readonly Task[];
  /** Open this session when the panel mounts (e.g. task live). */
  initialSessionId?: string | null;
  listEpoch?: number;
  focusEpoch?: number;
  /** List-level dismiss label — "← Task" when opened from task detail. */
  closeLabel?: string;
  onClose: () => void;
  onError: (msg: string) => void;
  onSessionSynced?: (s: RemoteSession) => void;
  onOpenTask?: (taskId: string) => void;
  onOpenSession?: (sessionId: string) => void;
}): JSX.Element {
  const visible = sessions.filter((s) => s.status !== 'closed');
  const active = visible.filter((s) => !s.archived);
  const archived = visible.filter((s) => s.archived === true);
  const [selectedId, setSelectedId] = useState<string | null>(initialSessionId ?? null);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const selected = visible.find((s) => s.id === selectedId) ?? null;

  useEffect(() => {
    if (initialSessionId) setSelectedId(initialSessionId);
  }, [initialSessionId, focusEpoch]);

  // Bottom-nav Chat re-tap: leave the open conversation and show the list.
  // (Same destination as the in-chat ← control — not a third navigation path.)
  useEffect(() => {
    if (listEpoch === undefined || listEpoch === 0) return;
    setSelectedId(null);
    setCreating(false);
  }, [listEpoch]);

  useEffect(() => {
    if (selectedId && !visible.some((s) => s.id === selectedId)) {
      setSelectedId(null);
    }
  }, [selectedId, visible]);

  /**
   * Open a session from the list. Task-live sessions must re-hit openTaskLive so
   * status/transcript stamps refresh — setSelectedId alone keeps a stale SSE snapshot.
   */
  const openFromList = async (s: RemoteSession): Promise<void> => {
    if (busyId) return;
    if (s.kind === 'task') {
      setBusyId(s.id);
      try {
        const fresh = await openTaskLiveSession(s.taskId ?? s.id);
        onSessionSynced?.(fresh);
        setSelectedId(fresh.id);
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
      return;
    }
    setSelectedId(s.id);
  };

  const runPatch = async (
    id: string,
    patch: { pinned?: boolean; archived?: boolean },
  ): Promise<void> => {
    setBusyId(id);
    try {
      const fresh = await patchSession(id, patch);
      onSessionSynced?.(fresh);
      // Archive hides from the main list — leave the open chat so it feels done.
      if (patch.archived === true && selectedId === id) {
        setSelectedId(null);
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const runDelete = async (id: string): Promise<void> => {
    setBusyId(id);
    try {
      await closeSession(id); // tears down ACP + worktree
      if (selectedId === id) setSelectedId(null);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  if (creating) {
    return (
      <>
        <div className="sheet-grip" />
        <NewSessionForm
          repos={repos}
          availableAgents={availableAgents}
          defaultAgent={defaultAgent}
          onCancel={() => setCreating(false)}
          onCreated={(s) => {
            setCreating(false);
            setSelectedId(s.id);
          }}
          onError={onError}
        />
      </>
    );
  }

  if (selected) {
    // Key includes updatedAt so a forced reopen (fresh sync) remounts the chat
    // scroll/compose shell against the latest session snapshot.
    return (
      <SessionChat
        key={`${selected.id}:${selected.updatedAt}`}
        session={selected}
        activity={
          sessionActivity[selected.id] ??
          (selected.taskId ? sessionActivity[selected.taskId] : undefined) ??
          []
        }
        repos={repos}
        tasks={tasks ?? []}
        onBack={() => setSelectedId(null)}
        onError={onError}
        onSessionSynced={onSessionSynced}
        onPin={() => void runPatch(selected.id, { pinned: !selected.pinned })}
        onArchive={() => void runPatch(selected.id, { archived: !selected.archived })}
        onDelete={() => void runDelete(selected.id)}
        onMessageAction={(a) => {
          if (a.kind === 'open_task') onOpenTask?.(a.target);
          else if (a.kind === 'open_session') {
            if (a.target === selected.id) return;
            if (onOpenSession) onOpenSession(a.target);
            else setSelectedId(a.target);
          }
        }}
      />
    );
  }

  const renderCard = (s: RemoteSession): JSX.Element => (
    <div key={s.id} className={`card session-card${s.pinned ? ' card-pinned' : ''}`}>
      <button
        type="button"
        className="session-card-main"
        disabled={busyId === s.id}
        onClick={() => void openFromList(s)}
      >
        <div className="card-head">
          <span className="id">{s.id}</span>
          {s.kind === 'task' && <span className="pill pill-tone-accent">task live</span>}
          {s.pinned && <span className="pin-badge">PIN</span>}
          {s.status === 'running' && <span className="live">● live</span>}
          {s.status === 'failed' && <span className="pill pill-failed">failed</span>}
          {s.status === 'idle' && <span className="muted">idle</span>}
          {(s.pendingPermissions?.length ?? 0) > 0 && (
            <span className="pill pill-tone-warn">perm</span>
          )}
          {(s.pendingProposals?.length ?? 0) > 0 && (
            <span className="pill pill-tone-ok">task?</span>
          )}
          {busyId === s.id && <span className="muted">…</span>}
        </div>
        <div className="title">{s.title}</div>
        <div className="meta muted">
          {s.repo}
          {s.adapter ? ` · ${s.adapter}` : ` · ${defaultAgent}`}
          {` · ${modeShort(s.permissionMode)}`}
          {s.linkedTaskId ? ` · task ${s.linkedTaskId}` : ''}
          {s.queued.length > 0 ? ` · ${s.queued.length} queued` : ''}
        </div>
      </button>
      {/* Rare actions only — not a permanent 3-button strip. */}
      <div className="session-card-actions">
        <ConfirmButton
          className="danger session-card-delete"
          label="Delete"
          confirmLabel="Delete?"
          disabled={busyId === s.id}
          onConfirm={() => void runDelete(s.id)}
        />
      </div>
    </div>
  );

  return (
    <div className="sessions-list-panel" data-evidence="sessions-list">
      <div className="sheet-head-row sessions-list-head">
        <div className="sessions-list-titles">
          <h2>Sessions</h2>
          <span className="muted sessions-list-sub">
            {active.length} active
            {archived.length > 0 ? ` · ${archived.length} archived` : ''}
          </span>
        </div>
        <button type="button" className="link" onClick={onClose}>
          {closeLabel}
        </button>
      </div>

      {active.length === 0 ? (
        <p className="muted center sessions-list-empty">No active sessions.</p>
      ) : (
        <div className="sessions-list-cards">{active.map(renderCard)}</div>
      )}

      {archived.length > 0 && (
        <>
          <button
            type="button"
            className="session-section-label"
            style={{ background: 'none', border: 'none', width: '100%', textAlign: 'left' }}
            onClick={() => setShowArchived((v) => !v)}
          >
            {showArchived ? '▾' : '▸'} Archived ({archived.length})
          </button>
          {showArchived ? <div className="sessions-list-cards">{archived.map(renderCard)}</div> : null}
        </>
      )}

      <div className="actions sessions-list-actions">
        <button className="primary" disabled={repos.length === 0} onClick={() => setCreating(true)}>
          New session
        </button>
      </div>
    </div>
  );
}

function modeShort(mode: PermissionMode | undefined): string {
  if (mode === 'bypass') return 'YOLO';
  if (mode === 'default') return 'Ask';
  return 'Edits auto';
}

function NewSessionForm({
  repos,
  availableAgents,
  defaultAgent,
  onCancel,
  onCreated,
  onError,
}: {
  repos: readonly RepoDto[];
  availableAgents: readonly string[];
  defaultAgent: string;
  onCancel: () => void;
  onCreated: (s: RemoteSession) => void;
  onError: (msg: string) => void;
}): JSX.Element {
  const [repo, setRepo] = useState(repos[0]?.key ?? '');
  const [message, setMessage] = useState('');
  const [adapter, setAdapter] = useState('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('acceptEdits');
  const [busy, setBusy] = useState(false);

  return (
    <>
      <h2>New session</h2>
      <label>
        Repo
        <select value={repo} onChange={(e) => setRepo(e.target.value)}>
          {repos.map((r) => (
            <option key={r.key} value={r.key}>
              {r.key}
            </option>
          ))}
        </select>
      </label>
      <label>
        Agent
        <select value={adapter} onChange={(e) => setAdapter(e.target.value)}>
          <option value="">Default → {defaultAgent}</option>
          {availableAgents.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>
      <div className="perm-mode-field">
        <div className="body-label">Permissions</div>
        <SegmentedControl
          ariaLabel="Permission mode"
          value={permissionMode}
          onChange={setPermissionMode}
          size="sm"
          options={MODE_OPTIONS.map((m) => ({
            value: m.value,
            label: m.label,
            hint: m.hint,
          }))}
        />
      </div>
      <label>
        Message
        <textarea
          rows={4}
          value={message}
          placeholder="What should the agent do?"
          onChange={(e) => setMessage(e.target.value)}
        />
      </label>
      <div className="actions">
        <button
          className="primary"
          disabled={busy || !repo || message.trim().length === 0}
          onClick={async () => {
            setBusy(true);
            try {
              const s = await startSession({
                repo,
                message: message.trim(),
                adapter: adapter === '' ? null : (adapter as AdapterKind),
                permissionMode,
              });
              onCreated(s);
            } catch (e) {
              onError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <span className="spinner" /> : 'Start'}
        </button>
        <button disabled={busy} onClick={onCancel}>
          Back
        </button>
      </div>
    </>
  );
}

function SessionChat({
  session,
  activity,
  repos,
  tasks,
  onBack,
  onError,
  onSessionSynced,
  onPin,
  onArchive,
  onDelete,
  onMessageAction,
}: {
  session: RemoteSession;
  activity: string[];
  repos: readonly RepoDto[];
  tasks: readonly Task[];
  onBack: () => void;
  onError: (msg: string) => void;
  onSessionSynced?: (s: RemoteSession) => void;
  onPin: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onMessageAction?: (action: MessageAction) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftRepo, setDraftRepo] = useState(session.repo);
  const [draftBody, setDraftBody] = useState('');
  const [diffOpen, setDiffOpen] = useState(false);
  const [diff, setDiff] = useState<SessionDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  /** Pin / Archive / Delete / → Task collapsed under More. */
  const [moreOpen, setMoreOpen] = useState(false);
  /** Permission segmented control — collapsed by default to free transcript height. */
  const [permOpen, setPermOpen] = useState(false);
  /** Live steps details — start collapsed; user expands when needed. */
  const [liveStepsOpen, setLiveStepsOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const liveStepsEndRef = useRef<HTMLLIElement | null>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  /**
   * Stick transcript to bottom: true on open + while user stays near the end.
   * Scrolling up to read history clears it until they return to the bottom.
   */
  const stickToBottomRef = useRef(true);
  const perms = session.pendingPermissions ?? [];
  const proposals = session.pendingProposals ?? [];
  const mode = session.permissionMode ?? 'acceptEdits';
  const isTaskLive = session.kind === 'task';
  /** Last live step text — length alone misses in-place draft updates. */
  const activityTail = activity.length > 0 ? activity[activity.length - 1] : '';

  // Opening a chat always lands on the latest message (not the top).
  useEffect(() => {
    stickToBottomRef.current = true;
    const root = scrollRef.current;
    if (!root) return;
    // rAF: wait for layout after messages paint.
    const id = requestAnimationFrame(() => {
      root.scrollTop = root.scrollHeight;
      bottomRef.current?.scrollIntoView({ block: 'end' });
    });
    return () => cancelAnimationFrame(id);
  }, [session.id]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const onScroll = (): void => {
      const dist = root.scrollHeight - root.scrollTop - root.clientHeight;
      stickToBottomRef.current = dist < 120;
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => root.removeEventListener('scroll', onScroll);
  }, [session.id]);

  useEffect(() => {
    if (!moreOpen && !permOpen) return;
    const onPointer = (e: PointerEvent): void => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      const moreEl = moreRef.current;
      const chromeEl = chromeRef.current;
      if (moreOpen && moreEl && !moreEl.contains(t)) setMoreOpen(false);
      // Close perm expander when tapping outside chrome (not when using the control).
      if (permOpen && chromeEl && !chromeEl.contains(t)) setPermOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setMoreOpen(false);
        setPermOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [moreOpen, permOpen]);

  // Keep transcript pinned to bottom while the turn streams (messages + live steps).
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const root = scrollRef.current;
    const pin = (): void => {
      if (root) root.scrollTop = root.scrollHeight;
      else bottomRef.current?.scrollIntoView({ block: 'end' });
      if (liveStepsOpen) {
        liveStepsEndRef.current?.scrollIntoView({ block: 'nearest' });
      }
    };
    // Double rAF covers markdown/layout growth in the same tick.
    const a = requestAnimationFrame(() => {
      pin();
      requestAnimationFrame(pin);
    });
    return () => cancelAnimationFrame(a);
  }, [
    session.messages.length,
    activity.length,
    activityTail,
    perms.length,
    proposals.length,
    liveStepsOpen,
  ]);

  const running = session.status === 'running';
  // Phone Assistant free session: hide protocol internals (boot blob,
  // [Tool results] turns, <<HERCULES_TOOL>> lines) here too — one system,
  // same cleaned transcript as the panel.
  const displayMessages = withMessageActions(
    isAssistantSession(session) ? cleanAssistantChatMessages(session.messages) : session.messages,
    session.taskId ?? (session.kind === 'task' ? session.id : null),
  );

  const openPromote = async (): Promise<void> => {
    setBusy(true);
    try {
      const d = await fetchSessionTaskDraft(session.id);
      setDraftTitle(d.title);
      setDraftRepo(d.repo);
      setDraftBody(d.body);
      setPromoting(true);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (promoting) {
    return (
      <>
        <div className="sheet-grip" />
        <h2>Create task from chat</h2>
        <p className="muted sheet-meta">
          Human confirm only — the agent cannot open tasks by itself. Edit the draft, then create.
        </p>
        <label>
          Title
          <input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} />
        </label>
        <label>
          Repo
          <select value={draftRepo} onChange={(e) => setDraftRepo(e.target.value)}>
            {repos.map((r) => (
              <option key={r.key} value={r.key}>
                {r.key}
              </option>
            ))}
          </select>
        </label>
        <label>
          Body
          <textarea rows={10} value={draftBody} onChange={(e) => setDraftBody(e.target.value)} />
        </label>
        <div className="actions">
          <button
            className="primary"
            disabled={busy || draftTitle.trim().length === 0 || !draftRepo}
            onClick={async () => {
              setBusy(true);
              try {
                await createTaskFromSession(session.id, {
                  title: draftTitle.trim(),
                  repo: draftRepo,
                  body: draftBody,
                  confirm: true,
                });
                setPromoting(false);
              } catch (e) {
                onError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <span className="spinner" /> : 'Confirm create task'}
          </button>
          <button disabled={busy} onClick={() => setPromoting(false)}>
            Cancel
          </button>
        </div>
      </>
    );
  }

  const needsAction = perms.length > 0 || proposals.length > 0;

  const loadDiff = async (): Promise<void> => {
    setDiffOpen(true);
    setDiffLoading(true);
    try {
      setDiff(await fetchSessionDiff(session.id));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setDiffLoading(false);
    }
  };

  return (
    <div className="session-chat session-chat-compact">
      {/* Compact sticky chrome — one row; rare controls expand on demand. */}
      <div className="session-chat-chrome" ref={chromeRef}>
        <div className="session-chat-topbar">
          <button
            type="button"
            className="session-back-icon"
            disabled={busy}
            aria-label="Back to sessions"
            title="Sessions"
            onClick={onBack}
          >
            ←
          </button>
          <div className="session-chat-topbar-main">
            <h2 className="chat-title" title={session.title}>
              {session.title}
            </h2>
            <div className="sheet-kicker session-chat-meta-row">
              <span className={`pill pill-${session.status === 'running' ? 'live' : session.status}`}>
                {session.status}
              </span>
              <span className="muted session-repo-chip">{session.repo}</span>
              {isTaskLive ? (
                <span className="pill pill-tone-accent">LIVE</span>
              ) : session.linkedTaskId ? (
                <span className="pill pill-tone-ok">task</span>
              ) : null}
            </div>
          </div>
          <div className="session-chat-top-actions">
            {!isTaskLive && (
              <button
                type="button"
                className={`session-mode-chip${permOpen ? ' is-open' : ''}`}
                disabled={busy || session.status === 'closed'}
                aria-expanded={permOpen}
                aria-label={`Permission mode ${modeShort(mode)}. Tap to change.`}
                title="Permission mode"
                onClick={() => {
                  setMoreOpen(false);
                  setPermOpen((v) => !v);
                }}
              >
                {modeShort(mode)}
              </button>
            )}
            {running && !isTaskLive && (
              <button
                type="button"
                className="session-stop-chip"
                disabled={busy}
                title="Stop agent"
                onClick={async () => {
                  setBusy(true);
                  try {
                    await stopSession(session.id);
                  } catch (e) {
                    onError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Stop
              </button>
            )}
            <div className="session-more-wrap" ref={moreRef}>
              <button
                type="button"
                className={`session-more-icon${moreOpen ? ' is-open' : ''}`}
                disabled={busy}
                aria-expanded={moreOpen}
                aria-label={moreOpen ? 'Close menu' : 'More actions'}
                title="More"
                onClick={() => {
                  setPermOpen(false);
                  setMoreOpen((v) => !v);
                }}
              >
                ⋯
              </button>
              {moreOpen && (
                <div className="session-more-menu session-more-menu-top" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    disabled={busy || diffLoading}
                    onClick={() => {
                      setMoreOpen(false);
                      void loadDiff();
                    }}
                  >
                    {diffLoading ? 'Diff…' : diffOpen ? 'Refresh diff' : 'Show worktree diff'}
                  </button>
                  {diffOpen && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMoreOpen(false);
                        setDiffOpen(false);
                      }}
                    >
                      Hide diff
                    </button>
                  )}
                  {!isTaskLive && (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={session.status === 'closed'}
                      onClick={() => {
                        setMoreOpen(false);
                        void openPromote();
                      }}
                    >
                      → Create task
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      onPin();
                    }}
                  >
                    {session.pinned ? 'Unpin' : 'Pin'}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      onArchive();
                    }}
                  >
                    {session.archived ? 'Unarchive' : 'Archive'}
                  </button>
                  <ConfirmButton
                    className="danger"
                    label="Delete session"
                    confirmLabel="Delete permanently?"
                    disabled={busy}
                    onConfirm={() => {
                      setMoreOpen(false);
                      onDelete();
                    }}
                  />
                  <p className="muted session-more-hint">
                    <code className="id">{session.id}</code>
                    <br />
                    Delete purges worktree. Archive only hides.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
        {!isTaskLive && permOpen && (
          <div className="perm-mode-field perm-mode-sticky perm-mode-expand">
            <SegmentedControl
              ariaLabel="Permission mode"
              value={mode}
              disabled={busy || session.status === 'closed'}
              size="sm"
              options={MODE_OPTIONS.map((m) => ({
                value: m.value,
                label: m.label,
                hint: m.hint,
              }))}
              onChange={async (next) => {
                setBusy(true);
                try {
                  const fresh = await setSessionPermissionMode(session.id, next);
                  onSessionSynced?.(fresh);
                  setPermOpen(false);
                } catch (err) {
                  onError(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusy(false);
                }
              }}
            />
          </div>
        )}
      </div>

      <div className="session-chat-scroll" ref={scrollRef}>
        {diffOpen && (
          <div className="session-diff-panel session-diff-inline">
            <div className="session-diff-head">
              <span className="body-label">Worktree diff</span>
              <button
                type="button"
                className="link"
                onClick={() => setDiffOpen(false)}
              >
                Hide
              </button>
            </div>
            {diffLoading && <div className="muted">Loading…</div>}
            {!diffLoading && diff && (
              !diff.available ? (
                <div className="muted">{diff.reason ?? 'Diff unavailable'}</div>
              ) : (
                <>
                  <div className="muted">{diff.summary}</div>
                  {diff.files.length > 0 && (
                    <ul className="session-diff-files">
                      {diff.files.slice(0, 40).map((f) => (
                        <li key={f}>
                          <code>{f}</code>
                        </li>
                      ))}
                    </ul>
                  )}
                  {diff.diff ? (
                    <pre className="session-diff-body">{diff.diff}</pre>
                  ) : (
                    <div className="muted">No textual diff</div>
                  )}
                </>
              )
            )}
          </div>
        )}

        <div className="chat-log">
          {displayMessages.map((m) => (
            <div key={m.id} className={`chat-bubble chat-${m.role}`}>
              <div className="chat-role muted">{m.role}</div>
              {(m.refs?.length ?? 0) > 0 && (
                <div className="compose-chips in-bubble">
                  {m.refs!.map((r, i) => (
                    <span key={i} className="compose-chip">
                      {r.kind}:{r.label ?? r.target}
                    </span>
                  ))}
                </div>
              )}
              {(m.attachments?.length ?? 0) > 0 && (
                <div className="compose-chips in-bubble">
                  {m.attachments!.map((a) => (
                    <span key={a.id} className="compose-chip">
                      {a.kind === 'image' ? '🖼' : '📎'} {a.name}
                    </span>
                  ))}
                </div>
              )}
              {m.role === 'assistant' ? (
                <Markdown text={m.content} />
              ) : m.role === 'system' ? (
                <div className="chat-text chat-system-md">
                  <Markdown text={m.content} />
                </div>
              ) : (
                <div className="chat-text">{m.content}</div>
              )}
              {(m.actions?.length ?? 0) > 0 && (
                <div className="chat-msg-actions">
                  {m.actions!.map((a, i) => (
                    <button
                      key={`${a.kind}:${a.target}:${i}`}
                      type="button"
                      className="chat-msg-action"
                      disabled={busy}
                      onClick={() => onMessageAction?.(a)}
                    >
                      {a.label?.trim() ||
                        (a.kind === 'open_task' ? `Open ${a.target}` : `Session ${a.target}`)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {running && (
            <details
              className="chat-bubble chat-assistant chat-live activity-collapse"
              open={liveStepsOpen}
              onToggle={(e) => setLiveStepsOpen((e.target as HTMLDetailsElement).open)}
            >
              <summary className="chat-role muted activity-summary">
                {/* recentActivity is a 40-line tail (+ optional streaming draft),
                    so the raw length bounces 40↔41 at cap — show "40+". */}
                live steps
                {activity.length >= 40
                  ? ' · 40+'
                  : activity.length > 0
                    ? ` · ${activity.length}`
                    : ' · quiet'}
              </summary>
              <ol className="activity-timeline">
                {activity.length > 0 ? (
                  activity.map((line, i) => (
                    <li
                      key={i}
                      ref={i === activity.length - 1 ? liveStepsEndRef : undefined}
                      className={line.startsWith('…') ? 'activity-draft' : undefined}
                    >
                      {line}
                    </li>
                  ))
                ) : (
                  <li className="muted">
                    quiet — tools may run with no stream (cargo/pnpm); not always stuck
                  </li>
                )}
              </ol>
            </details>
          )}
          {session.queued.length > 0 && (
            <div className="muted chat-queued">
              Queued ({session.queued.length}): will send after this turn
            </div>
          )}
          {session.error && session.status === 'failed' && (
            <div className="toast">{session.error}</div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Thumb zone: permission + task proposals stay pinned above compose */}
      {needsAction && (
        <div className="session-action-dock" role="region" aria-label="Needs your approval">
          {perms.length > 0 && (
            <div className="perm-cards perm-cards-dock">
              {perms.map((p) => (
                <div key={p.id} className="perm-card">
                  <div className="perm-card-head">
                    <span className="pill pill-tone-warn">Permission</span>
                    <span className="muted perm-kind">{p.toolKind}</span>
                  </div>
                  <div className="perm-title">{p.title}</div>
                  {p.detail && <pre className="perm-detail">{p.detail}</pre>}
                  <div className="perm-actions">
                    {p.options.map((o) => {
                      const allow =
                        o.kind.startsWith('allow') || o.optionId.startsWith('allow');
                      return (
                        <button
                          key={o.optionId}
                          className={allow ? 'primary' : 'danger'}
                          disabled={busy}
                          onClick={async () => {
                            setBusy(true);
                            try {
                              await resolveSessionPermission(session.id, p.id, o.optionId);
                            } catch (e) {
                              onError(e instanceof Error ? e.message : String(e));
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          {o.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
          {proposals.length > 0 && (
            <div className="perm-cards perm-cards-dock">
              {proposals.map((p) => (
                <div key={p.id} className="perm-card proposal-card">
                  <div className="perm-card-head">
                    <span className="pill pill-tone-ok">Task suggestion</span>
                    <span className="muted perm-kind">{p.repo ?? session.repo}</span>
                  </div>
                  <div className="perm-title">{p.title}</div>
                  <pre className="perm-detail">
                    {p.body.slice(0, 280)}
                    {p.body.length > 280 ? '…' : ''}
                  </pre>
                  <div className="perm-actions">
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await approveSessionProposal(session.id, p.id);
                        } catch (e) {
                          onError(e instanceof Error ? e.message : String(e));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Approve → task
                    </button>
                    <button
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await dismissSessionProposal(session.id, p.id);
                        } catch (e) {
                          onError(e instanceof Error ? e.message : String(e));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <ChatComposer
        sessionId={session.id}
        disabled={session.status === 'closed'}
        busy={busy}
        running={running}
        tasks={tasks}
        onError={onError}
        onSend={async (payload) => {
          setBusy(true);
          try {
            await sendSessionMessage(session.id, payload.message, {
              interrupt: running && !isTaskLive,
              attachments: payload.attachments,
              refs: payload.refs,
            });
          } catch (e) {
            onError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}
