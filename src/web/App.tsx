import { useEffect, useState, useCallback, useRef, type JSX } from 'react';
import { t } from './i18n.js';
import { loadLang, loadPreferredAgent, saveLang, savePreferredAgent, type Lang } from './prefs.js';
import { ReposPanel } from './ReposPanel.js';
import { ReleasesPanel } from './ReleasesPanel.js';
import { SessionsPanel } from './SessionsPanel.js';
import { SettingsPanel } from './SettingsPanel.js';
import { TasksPanel } from './TasksPanel.js';
import { TaskDetail } from './TaskDetail.js';
import { CreateForm } from './CreateForm.js';
import {
  draftReadyNotice,
  formatPipelineCreatedFeedback,
  formatPlanApprovedFeedback,
  formatTaskCreatedFeedback,
} from './operatorFeedback.js';
import { PullToRefresh } from './PullToRefresh.js';
import { applyTaskListRefresh } from './pullToRefresh.js';
import {
  taskChatUiEffect,
  withTaskChatOutcome,
  withoutTaskChatOutcome,
} from './taskChatUi.js';
import { VoiceControl } from './VoiceControl.js';
import type { VoiceHandlers } from './voiceCommands.js';
import {
  act,
  ackDraftJob,
  ApiError,
  approveAndOpenPr,
  approveHostOperation,
  approvePlan,
  approveSessionProposal,
  chatTask,
  newClientMessageId,
  clearToken,
  createPipeline,
  createTask,
  createTaskFromSession,
  deleteTask,
  dismissSessionProposal,
  fetchSessionDiff,
  fetchSessionTaskDraft,
  fetchReleases,
  fetchState,
  fetchVoiceStatus,
  forceAbort,
  getToken,
  openPr,
  openTaskLiveSession,
  patchSession,
  resolveSessionPermission,
  reverifyTask,
  salvageForkTask,
  sendSessionMessage,
  waitForSessionSettled,
  setSessionPermissionMode,
  setTaskAdapter,
  rewireDependencies,
  setToken,
  startSession,
  steerFromPr,
  steerTask,
  stopSession,
  subscribeState,
  type AdapterKind,
  type DraftJobDto,
  type DraftJobEvent,
  type DraftJobStatus,
  type IntentDraftDto,
  type PermissionMode,
  type RemoteSession,
  type StateDto,
  type Task,
  type TaskState,
  handoffCodeFromHash,
  redeemStagingHandoff,
} from './api.js';
import { useReviewExperienceConfig } from './review/useReviewExperienceConfig.js';
import {
  findAssistantSession,
  formatAssistantToolResults,
  formatAssistantRoundCapNotice,
  danglingAssistantUserTurn,
  pendingAssistantToolRound,
  targetAssistantToolArgs,
} from './assistantProtocol.js';
import { dispatchVoiceCommand, pickFocusSessionId } from './voiceCommands.js';
import {
  navCloseLabel,
  peekNav,
  popNav,
  pushNav,
  type NavReturn,
} from './navReturn.js';
import { clipFragment, listFragment } from './voiceFragments.js';
import {
  formatReadPlan,
  formatTaskIndex,
  formatTaskMeta,
  readTaskPart,
} from './taskInspect.js';
import { findTask, resolveTaskDetail } from './taskDetail.js';
import { makeQueueFrontHandler } from './queueFrontAction.js';
import { taskIdFromSearch } from './taskDeepLink.js';
import {
  brokenDependencies,
  mergeBlockedDependencies,
  pendingDependencies,
} from '../domain/scheduling.js';
import { buildDecisionInbox } from './decisionInbox.js';
import { buildDigest, formatDigestLine } from './digest.js';
import { copyToClipboard } from './clipboard.js';
import { findFixtureUnprovenReviewTask } from './fixtureAutoOpen.js';
import {
  allTasksFromState,
  canBulkDeleteState,
  dropTask,
  effectiveAgent,
  githubOpenHref,
  loadCollapsed,
  COLLAPSE_KEY,
  moveTask,
  openGithub,
  originalDescription,
  upsertSession,
} from './taskUi.js';

export function App(): JSX.Element {
  const [token, setTok] = useState<string | null>(() => getToken());
  const [state, setState] = useState<StateDto | null>(null);
  const [selected, setSelected] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  creatingRef.current = creating;
  const [drafts, setDrafts] = useState<ReadonlyMap<string, DraftJobDto>>(new Map());
  const draftStatusRef = useRef<Map<string, DraftJobStatus>>(new Map());
  const [reposOpen, setReposOpen] = useState(false);
  const [releasesOpen, setReleasesOpen] = useState(false);
  /** Sheet element of the Releases panel (scroll capture for nav return). */
  const releasesSheetRef = useRef<HTMLDivElement | null>(null);
  /** Pending scroll restore after returning from a task (consumed once). */
  const releasesRestoreScrollRef = useRef<number | null>(null);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lang, setLang] = useState<Lang>(() => loadLang());
  const [preferredAgent, setPreferredAgent] = useState<string>(
    () => loadPreferredAgent() ?? '',
  );
  /** When set, SessionsPanel opens this session (task live). */
  const [liveSessionFocus, setLiveSessionFocus] = useState<string | null>(null);
  /** Bump to force SessionsPanel back to the list (Chat tab re-tap). */
  const [sessionsListEpoch, setSessionsListEpoch] = useState(0);
  /** Bump when re-opening a session so Chat re-selects even if id is unchanged. */
  const [sessionFocusEpoch, setSessionFocusEpoch] = useState(0);
  /**
   * Sheet return stack: chat → task → Close restores chat; task → live → Close
   * restores task. Bottom-nav / Logout clear it (new root destination).
   */
  const [navStack, setNavStack] = useState<NavReturn[]>([]);
  /** Grok Realtime Voice Control available (server has xAI credential). */
  const [voiceConfigured, setVoiceConfigured] = useState(false);
  const voiceHandlersRef = useRef<VoiceHandlers>({});
  /** Push spoken notices into a live Voice Control session (perms / turn done). */
  const voiceAnnounceRef = useRef<(text: string) => void>(() => undefined);
  const voiceAnnounceSeenRef = useRef<string>('');
  /** App-level Phone Assistant tool loop — single owner (no panel dispatcher). */
  const assistantToolMsgRef = useRef<string | null>(null);
  const assistantToolBusyRef = useRef(false);
  const [prefill, setPrefill] = useState<{
    title: string;
    repo: string;
    body: string;
    adapter?: AdapterKind | null;
    executionClass?: Task['executionClass'];
    draft?: IntentDraftDto;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Non-error operator feedback (create / plan approved) — green toast. */
  const [notice, setNotice] = useState<string | null>(null);
  /** After Approve&PR / Open PR — sticky tappable link (async popup often blocked). */
  const [prBanner, setPrBanner] = useState<{ url: string; label: string } | null>(null);
  // Which action is in flight (for the per-button spinner); null = idle.
  const [pending, setPending] = useState<string | null>(null);
  /** Per-task chat delivery banner (queued / pending / steer / duplicate). */
  const [chatOutcomeByTask, setChatOutcomeByTask] = useState<Record<string, string>>({});
  /** Bulk clear of a task-list state section, e.g. `bulk:done`. */
  const [bulkPending, setBulkPending] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Partial<Record<TaskState, boolean>>>(() => loadCollapsed());
  // A 1s clock so live durations (running/awaiting-review elapsed) tick smoothly.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }, [lang]);

  // L2 fixture: open unproven-review once so shell shot hits DecisionCard.
  const deepLinkedTaskIdRef = useRef(taskIdFromSearch(window.location.search));
  const deepLinkOpenedRef = useRef(false);
  useEffect(() => {
    const id = deepLinkedTaskIdRef.current;
    if (!id || deepLinkOpenedRef.current || !state?.ready) return;
    deepLinkOpenedRef.current = true;
    const task = findTask(state, id);
    if (task) setSelected(task);
    else setError(`Unknown task ${id}`);
  }, [state]);
  const fixtureAutoOpenedRef = useRef(false);
  useEffect(() => {
    if (deepLinkedTaskIdRef.current || fixtureAutoOpenedRef.current || selected || !state?.ready) return;
    const fixtureReview = findFixtureUnprovenReviewTask(allTasksFromState(state));
    if (!fixtureReview) return;
    fixtureAutoOpenedRef.current = true;
    setSelected(fixtureReview);
  }, [state, selected]);

  const toggleSection = useCallback((s: TaskState) => {
    setCollapsed((prev) => {
      const next = { ...prev, [s]: !prev[s] };
      try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next)); } catch { /* ignore quota */ }
      return next;
    });
  }, []);

  // A stale or rotated token is rejected with 401. Forget it and return to the
  // gate, so the user can re-enter — otherwise they're stuck on "unauthorized"
  // with no input field.
  const signOut = useCallback(() => {
    clearToken();
    setTok(null);
    setState(null);
    setSelected(null);
    setCreating(false);
    setSettingsOpen(false);
    setReleasesOpen(false);
    setPrefill(null);
    setError(null);
  }, []);

  const reviewExperience = useReviewExperienceConfig({
    authenticated: token !== null,
    onUnauthorized: signOut,
  });

  const changeLang = useCallback((next: Lang) => {
    saveLang(next);
    setLang(next);
  }, []);

  const changePreferredAgent = useCallback((agent: string) => {
    savePreferredAgent(agent === '' ? null : agent);
    setPreferredAgent(agent);
  }, []);

  // CEO decision inbox: release facts fetched lightly (server-side cached);
  // never blocks the task refresh path.
  const [inboxReleases, setInboxReleases] = useState<
    readonly { repoKey: string; canPromote: boolean; stagingStatus: string | null; aheadTasks: unknown[]; directCommits?: unknown[]; history: { at?: string; outcome?: string }[] }[]
  >([]);
  useEffect(() => {
    if (!token) return;
    let alive = true;
    const load = (): void => {
      void fetchReleases()
        .then((rs) => {
          if (alive) setInboxReleases(rs);
        })
        .catch(() => {});
    };
    load();
    const t = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [token]);

  /**
   * Order guard for FULL snapshot applies (fetchState + SSE). A slow GET
   * started before a mutation can resolve after the optimistic update and
   * shove the list back to pre-action state for seconds (Retry-shows-failed,
   * 2026-07-18). Returns false when the snapshot is stale and was dropped.
   */
  const stateSeqRef = useRef(0);
  const acceptServerState = useCallback((next: StateDto): boolean => {
    if (typeof next.seq === 'number') {
      if (next.seq < stateSeqRef.current) return false;
      stateSeqRef.current = next.seq;
    }
    setState(next);
    return true;
  }, []);

  /** Authoritative re-fetch of task list + related runtime (PTR + manual refresh). */
  const refreshAsync = useCallback(async (): Promise<void> => {
    try {
      const next = await fetchState();
      // Full snapshot for list + running/activity; reconcile open task status.
      if (!acceptServerState(next)) return;
      setSelected((prev) => applyTaskListRefresh(next, prev).selected);
      setNow(Date.now());
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 401) {
        signOut();
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, [signOut, acceptServerState]);

  const refresh = useCallback(() => {
    void refreshAsync().catch(() => {
      /* error already surfaced via setError */
    });
  }, [refreshAsync]);

  /**
   * Delete every task currently listed under a state section (or open-PR group).
   * Skips live runs; cleanup=true so sessions/worktrees go with them.
   */
  const bulkDeleteTasks = useCallback(
    async (key: string, tasks: readonly Task[]): Promise<void> => {
      if (tasks.length === 0 || bulkPending || pending) return;
      const deletable = tasks.filter((t) => canBulkDeleteState(t.state));
      if (deletable.length === 0) {
        setError('Nothing deletable in this group (running tasks must be cancelled first)');
        return;
      }
      setBulkPending(key);
      const notes: string[] = [];
      let ok = 0;
      let fail = 0;
      try {
        for (const t of deletable) {
          try {
            const res = await deleteTask(t.id, { cleanup: true });
            setState((s) => (s ? dropTask(s, t.id) : s));
            ok += 1;
            if (res.notes?.length) notes.push(...res.notes.map((n) => `${t.id}: ${n}`));
          } catch (e) {
            fail += 1;
            notes.push(`${t.id}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (selected && deletable.some((t) => t.id === selected.id)) {
          setSelected(null);
        }
        if (fail > 0) {
          setError(`Cleared ${ok}, failed ${fail}. ${notes.slice(0, 3).join(' · ')}`);
        } else if (notes.length > 0) {
          setError(`Deleted ${ok} · ${notes.slice(0, 2).join(' · ')}`);
        }
        refresh();
      } finally {
        setBulkPending(null);
      }
    },
    [bulkPending, pending, refresh, selected],
  );

  const onDraftEvent = useCallback((ev: DraftJobEvent): void => {
    if ('removed' in ev) {
      draftStatusRef.current.delete(ev.removed);
      setDrafts((prev) => {
        if (!prev.has(ev.removed)) return prev;
        const m = new Map(prev);
        m.delete(ev.removed);
        return m;
      });
      return;
    }
    const job = ev.job;
    const prevStatus = draftStatusRef.current.get(job.id);
    draftStatusRef.current.set(job.id, job.status);
    setDrafts((prev) => {
      const m = new Map(prev);
      m.set(job.id, job);
      return m;
    });
    if (prevStatus === 'running' && job.status === 'ready' && !creatingRef.current) {
      setNotice(draftReadyNotice(job));
    } else if (prevStatus === 'running' && job.status === 'failed' && !creatingRef.current) {
      setError(`analyst 失败：${job.error ?? 'unknown'}`);
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    refresh();
    const unsubscribe = subscribeState(acceptServerState, signOut, onDraftEvent);
    return unsubscribe;
  }, [token, refresh, signOut, acceptServerState, onDraftEvent]);

  useEffect(() => {
    if (!token) {
      setVoiceConfigured(false);
      return;
    }
    void fetchVoiceStatus()
      .then((s) => setVoiceConfigured(s.configured))
      .catch(() => setVoiceConfigured(false));
  }, [token]);

  // Lock the background from scrolling while a bottom sheet is open (iOS-robust:
  // fix the body and restore the scroll position on close). Without this, a
  // touch-scroll inside the sheet chains to the page behind it.
  const sheetOpen =
    selected !== null ||
    creating ||
    reposOpen ||
    releasesOpen ||
    sessionsOpen ||
    settingsOpen;
  const navBack = peekNav(navStack);
  const sheetCloseLabel = navCloseLabel(navBack);

  const clearNav = useCallback((): void => {
    setNavStack([]);
  }, []);

  const pushNavFrame = useCallback((frame: NavReturn): void => {
    setNavStack((s) => pushNav(s, frame));
  }, []);

  /** Restore a pushed sheet (session / task list / task detail). */
  const restoreNav = useCallback(
    (frame: NavReturn): void => {
      setCreating(false);
      setPrefill(null);
      setReposOpen(false);
      setReleasesOpen(false);
      setSettingsOpen(false);
      if (frame.kind === 'session') {
        setSelected(null);
        setLiveSessionFocus(frame.sessionId);
        setSessionFocusEpoch((n) => n + 1);
        setSessionsOpen(true);
      } else if (frame.kind === 'sessions') {
        setSelected(null);
        setLiveSessionFocus(null);
        setSessionsOpen(true);
      } else if (frame.kind === 'releases') {
        // Back from a task opened out of the Releases briefing: reopen the
        // sheet and restore the reading position (scroll restored by the
        // panel once its data has rendered).
        setSelected(null);
        setSessionsOpen(false);
        setLiveSessionFocus(null);
        releasesRestoreScrollRef.current = frame.scrollTop;
        setReleasesOpen(true);
      } else {
        const t = findTask(state, frame.taskId);
        setSessionsOpen(false);
        setLiveSessionFocus(null);
        if (t) setSelected(t);
        else setSelected(null);
      }
    },
    [state],
  );

  /** Close task detail; if opened from chat (or similar), pop and restore. */
  const closeTaskSheet = useCallback((): void => {
    setSelected((prev) => {
      if (prev) {
        setChatOutcomeByTask((m) => withoutTaskChatOutcome(m, prev.id));
      }
      return null;
    });
    setNavStack((s) => {
      const { stack, frame } = popNav(s);
      if (frame) {
        // Defer restore so selected is cleared first (sheet mutual exclusion).
        queueMicrotask(() => restoreNav(frame));
      }
      return stack;
    });
  }, [restoreNav]);

  /** Close sessions sheet; restore task if we came from task detail. */
  const closeSessionsSheet = useCallback((): void => {
    setSessionsOpen(false);
    setLiveSessionFocus(null);
    setNavStack((s) => {
      const { stack, frame } = popNav(s);
      if (frame) {
        queueMicrotask(() => restoreNav(frame));
      }
      return stack;
    });
  }, [restoreNav]);

  /** Open task detail, optionally remembering where we came from. */
  const openTaskSheet = useCallback(
    (task: Task, from?: NavReturn | null): void => {
      if (from) pushNavFrame(from);
      setSessionsOpen(false);
      setLiveSessionFocus(null);
      setReposOpen(false);
      setReleasesOpen(false);
      setSettingsOpen(false);
      setCreating(false);
      setPrefill(null);
      setSelected(task);
    },
    [pushNavFrame],
  );

  useEffect(() => {
    if (!sheetOpen) return;
    const scrollY = window.scrollY;
    const body = document.body;
    Object.assign(body.style, {
      position: 'fixed',
      top: `-${scrollY}px`,
      left: '0',
      right: '0',
      overflow: 'hidden',
    });
    return () => {
      Object.assign(body.style, { position: '', top: '', left: '', right: '', overflow: '' });
      window.scrollTo(0, scrollY);
    };
  }, [sheetOpen]);

  // Proactive Voice announce: new pending permissions or session failures while orb is live.
  useEffect(() => {
    if (!state?.sessions) return;
    const bits: string[] = [];
    for (const s of state.sessions) {
      if (s.status === 'closed' || s.archived) continue;
      for (const p of s.pendingPermissions ?? []) {
        bits.push(`perm:${s.id}:${p.id}`);
      }
      if (s.status === 'failed' && s.error) bits.push(`fail:${s.id}:${s.error.slice(0, 80)}`);
      if (s.status === 'idle' && s.messages.length > 0) {
        const last = s.messages[s.messages.length - 1];
        if (last?.role === 'assistant') bits.push(`idle:${s.id}:${last.id}`);
      }
    }
    const sig = bits.sort().join('|');
    if (!sig || sig === voiceAnnounceSeenRef.current) {
      if (!voiceAnnounceSeenRef.current) voiceAnnounceSeenRef.current = sig;
      return;
    }
    const prev = new Set(voiceAnnounceSeenRef.current.split('|').filter(Boolean));
    voiceAnnounceSeenRef.current = sig;
    if (prev.size === 0) return; // first snapshot — don't speak history
    const added = bits.filter((b) => !prev.has(b));
    for (const a of added) {
      if (a.startsWith('perm:')) {
        const [, sid, pid] = a.split(':');
        const sess = state.sessions.find((s) => s.id === sid);
        const perm = sess?.pendingPermissions?.find((p) => p.id === pid);
        if (perm) {
          voiceAnnounceRef.current(
            `Session ${sid} needs permission: ${perm.title}. Ask the user to allow or deny.`,
          );
        }
      } else if (a.startsWith('fail:')) {
        const sid = a.split(':')[1];
        voiceAnnounceRef.current(`Session ${sid} failed. Offer to open it or summarize the error.`);
      } else if (a.startsWith('idle:')) {
        const sid = a.split(':')[1];
        voiceAnnounceRef.current(
          `Session ${sid} finished a turn. Offer a short summary if useful.`,
        );
      }
    }
  }, [state?.sessions]);

  // Phone Assistant tool loop (single owner). Runs whenever the pinned free
  // session settles with <<HERCULES_TOOL>> calls in its LAST message — no
  // matter which surface sent the turn (panel textarea or the Chat sheet).
  // pendingAssistantToolRound guards: processed-id, freshness (no replay on
  // app reload), and the per-user-turn round cap.
  useEffect(() => {
    const s = findAssistantSession(state?.sessions ?? []);
    if (!s || s.status !== 'idle') return;
    if (assistantToolBusyRef.current) return;
    const round = pendingAssistantToolRound(s.messages, assistantToolMsgRef.current, Date.now());
    if (!round) {
      // A user message with no reply on an idle session: the agent turn was
      // eaten (daemon restart mid-send). Resend it once so the conversation
      // continues instead of looking dead.
      const dangling = danglingAssistantUserTurn(s.messages, s.status, Date.now());
      if (dangling === null) return;
      assistantToolBusyRef.current = true;
      void (async () => {
        try {
          let fresh = await sendSessionMessage(s.id, dangling, { interrupt: false });
          setState((prev) => (prev ? upsertSession(prev, fresh) : prev));
          fresh = await waitForSessionSettled(fresh.id);
          setState((prev) => (prev ? upsertSession(prev, fresh) : prev));
        } catch {
          // next SSE tick retries via the same detection
        } finally {
          assistantToolBusyRef.current = false;
        }
      })();
      return;
    }
    assistantToolBusyRef.current = true;
    assistantToolMsgRef.current = round.messageId;
    void (async () => {
      try {
        // Round cap hit: run nothing, tell the agent to answer with what it
        // has (once) — silence here read as "assistant died mid-work".
        if (round.capped) {
          let fresh = await sendSessionMessage(s.id, formatAssistantRoundCapNotice(), {
            interrupt: false,
          });
          setState((prev) => (prev ? upsertSession(prev, fresh) : prev));
          fresh = await waitForSessionSettled(fresh.id);
          setState((prev) => (prev ? upsertSession(prev, fresh) : prev));
          return;
        }
        const results: { name: string; ok: boolean; message: string }[] = [];
        for (const call of round.calls) {
          const r = await dispatchVoiceCommand(
            voiceHandlersRef.current,
            call.name,
            targetAssistantToolArgs(call.name, call.argsJson, s.id),
          );
          results.push({ name: call.name, ok: r.ok, message: r.message });
        }
        let fresh = await sendSessionMessage(
          s.id,
          formatAssistantToolResults(results, round.expired),
          { interrupt: false },
        );
        setState((prev) => (prev ? upsertSession(prev, fresh) : prev));
        // SSE may lag — settle-wait so the next round (or the final answer)
        // re-triggers this effect promptly.
        fresh = await waitForSessionSettled(fresh.id);
        setState((prev) => (prev ? upsertSession(prev, fresh) : prev));
      } catch (err) {
        // Posting results failed (network / phone slept mid-dispatch). Leave
        // the round claimable so the next SSE tick retries instead of
        // wedging the conversation on a permanently "processed" message.
        assistantToolMsgRef.current = null;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        assistantToolBusyRef.current = false;
      }
    })();
  }, [state?.sessions]);

  // Derived CEO surfaces (pure, cheap; recompute per render).
  const inboxItems = state?.ready
    ? buildDecisionInbox(
        allTasksFromState(state),
        inboxReleases.map((r) => ({
          repoKey: r.repoKey,
          canPromote: r.canPromote,
          stagingReady: r.stagingStatus === 'ready',
          changeCount: (r.aheadTasks?.length ?? 0) + (r.directCommits?.length ?? 0),
        })),
        {
          dispatchHold: state.dispatchHold ?? null,
          adapterFailover: state.adapterFailover ?? null,
          draftJobs: Array.from(drafts.values()),
          lang,
        },
      )
    : [];
  const digestLine = formatDigestLine(
    buildDigest(allTasksFromState(state), inboxReleases, state?.costSummary, Date.now(), 7),
    lang,
  );

  if (!token) {
    return (
      <TokenGate
        lang={lang}
        onToken={(tok) => {
          setToken(tok);
          setTok(tok);
        }}
      />
    );
  }

  const busy = pending !== null;
  const running = new Set(state?.running ?? []);
  const stopping = new Set(state?.stopping ?? []);
  // Re-derive the open task from the latest snapshot so the sheet updates live,
  // but do not let a lagging snapshot resurrect a just-cleared planPending.
  const detail = resolveTaskDetail(state, selected);
  const openSessions = (state?.sessions ?? []).filter((s) => s.status !== 'closed');
  const chatBadge = openSessions.length;
  const reviewCount = state?.byState?.review?.length ?? 0;
  // Voice Control handlers (UX only — never edit worktrees / write code).
  voiceHandlersRef.current = buildVoiceHandlers({
    state,
    selected,
    liveSessionFocus,
    sessionsOpen,
    setSelected,
    setCreating,
    setPrefill,
    setSessionsOpen,
    setReposOpen,
    setReleasesOpen,
    setSettingsOpen,
    setLiveSessionFocus,
    setSessionsListEpoch,
    setSessionFocusEpoch,
    setError,
    setPrBanner,
    clearNav,
    pushNavFrame,
    openTaskSheet,
  });

  const buildVoiceScreenContext = (): string =>
    buildHerculesScreenContext({
      state,
      selected,
      liveSessionFocus,
      sessionsOpen,
      reposOpen,
      creating,
    });

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-brand">
          <h1>Hercules</h1>
          <span className="topbar-status muted">
            {!state?.ready
              ? t(lang, 'statusConnecting')
              : running.size > 0
                ? `${running.size} ${t(lang, 'statusLive')}`
                : reviewCount > 0
                  ? `${reviewCount} ${t(lang, 'statusReview')}`
                  : t(lang, 'statusIdle')}
            {state?.agents?.default ? ` · ${state.agents.default}` : ''}
          </span>
          <VersionStamp
            serverVersion={state?.build?.version}
            serverSha={state?.build?.gitSha}
          />
        </div>
      </header>

      {state?.build?.version &&
        typeof __APP_VERSION__ !== 'undefined' &&
        __APP_VERSION__ &&
        displayVer(state.build.version) !== displayVer(__APP_VERSION__) && (
          <button
            type="button"
            className="spa-reload-banner"
            onClick={() => window.location.reload()}
          >
            New UI available ({displayVer(state.build.version)}) — tap to reload
          </button>
        )}

      {error && (
        <div className="toast" onClick={() => setError(null)}>
          {error} <span className="muted">(tap to dismiss)</span>
        </div>
      )}
      {notice && (
        <div
          className="toast toast-ok"
          data-evidence="operator-notice"
          role="status"
          onClick={() => setNotice(null)}
        >
          {notice} <span className="muted">(tap to dismiss)</span>
        </div>
      )}

      {prBanner && (
        <div className="pr-banner">
          <a href={prBanner.url} target="_blank" rel="noopener noreferrer" className="pr-banner-link">
            {prBanner.label}
          </a>
          <button type="button" className="pr-banner-x" onClick={() => setPrBanner(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {state?.problems && state.problems.length > 0 && (
        <div className="banner">
          {state.problems.length} task file problem(s): {state.problems.map((p) => p.stem).join(', ')}
        </div>
      )}

      {/* Disk critical: red pause banner — exact reason from same code as tick pause.
          Hosts stay mounted (hidden when inactive) so L2 can assert data-evidence
          hooks without forcing live disk ≥95% on the verification host. */}
      <div
        className="banner banner-danger"
        data-evidence="dispatch-hold"
        role="alert"
        hidden={!state?.dispatchHold}
        aria-hidden={!state?.dispatchHold}
      >
        {state?.dispatchHold?.detail ?? ''}
      </div>
      {/* Disk warn only: subtle amber hint (no pause). Hidden when critical or ok. */}
      <div
        className="banner banner-warn dispatch-disk-warn"
        data-evidence="disk-warn"
        hidden={Boolean(state?.dispatchHold) || !state?.diskWarn}
        aria-hidden={Boolean(state?.dispatchHold) || !state?.diskWarn}
      >
        {state?.diskWarn ?? ''}
      </div>
      {/* Human-AC L2 hosts — always mounted (hidden). Real ref/action buttons live
          on TaskDetail decide when a review task has how/refs or mark-ready text;
          L2 only visits the task list and still needs to assert claimed hooks
          (same pattern as dispatch-hold). */}
      <div className="human-ac-l2-hosts" hidden aria-hidden="true">
        <button type="button" data-evidence="human-ac-ref" tabIndex={-1} disabled>
          ref
        </button>
        <button type="button" data-evidence="human-ac-action" tabIndex={-1} disabled>
          action
        </button>
      </div>

      <main>
        <PullToRefresh lang={lang} disabled={sheetOpen} onRefresh={refreshAsync}>
          {!state?.ready && <p className="muted center">Waiting for the first tick…</p>}
          {state?.ready && inboxItems.length > 0 && (
            <div className="decision-inbox" data-evidence="decision-inbox">
              <div className="decision-inbox-head">
                <strong>
                  {t(lang, 'inboxPendingToday').replace('{n}', String(inboxItems.length))}
                </strong>
                <span className="muted decision-inbox-digest">{digestLine}</span>
              </div>
              {inboxItems.map((item, i) => (
                <button
                  key={`${item.kind}-${item.taskId ?? item.repoKey ?? item.draftJobId ?? i}`}
                  type="button"
                  className={`decision-inbox-row inbox-${item.kind}`}
                  onClick={() => {
                    if (item.draftJobId) {
                      const job = drafts.get(item.draftJobId);
                      if (job?.draft) {
                        setPrefill({
                          title: job.draft.title,
                          repo: job.repo,
                          body: job.draft.body,
                          draft: job.draft,
                        });
                        setCreating(true);
                        setDrafts((prev) => {
                          const m = new Map(prev);
                          m.delete(item.draftJobId!);
                          return m;
                        });
                        draftStatusRef.current.delete(item.draftJobId);
                        void ackDraftJob(item.draftJobId).catch(() => undefined);
                      }
                      return;
                    }
                    if (item.taskId) {
                      const t = allTasksFromState(state).find((x) => x.id === item.taskId);
                      if (t) {
                        clearNav();
                        setSelected(t);
                      }
                    } else if (item.repoKey) {
                      setReleasesOpen(true);
                    }
                  }}
                >
                  {item.line}
                </button>
              ))}
            </div>
          )}
          {state?.ready && inboxItems.length === 0 && (
            <div className="decision-inbox decision-inbox-empty" data-evidence="decision-inbox">
              <span className="muted">
                {t(lang, 'inboxNothingToday').replace('{digest}', digestLine)}
              </span>
            </div>
          )}
          {state?.ready && (
            <TasksPanel
              state={state}
              lang={lang}
              now={now}
              collapsed={collapsed}
              running={running}
              bulkPending={bulkPending}
              pending={pending}
              onToggleSection={toggleSection}
              onBulkDelete={(key, tasks) => void bulkDeleteTasks(key, tasks)}
              onSelectTask={(t) => {
                clearNav();
                setSelected(t);
              }}
            />
          )}
        </PullToRefresh>
      </main>

      {!sessionsOpen && !reposOpen && !releasesOpen && !settingsOpen && (
        <button
          className="fab"
          data-evidence="create-open"
          onClick={() => {
            setPrefill(null);
            setCreating(true);
          }}
          aria-label="New task"
        >
          +
        </button>
      )}

      {/* Voice face always visible; Realtime only when configured (paid opt-in). */}
      <VoiceControl
        visible={Boolean(token)}
        realtimeAvailable={voiceConfigured}
        sessions={state?.sessions ?? []}
        repos={state?.repos ?? []}
        sessionActivity={state?.sessionActivity ?? {}}
        onSessionSynced={(s) => {
          setState((prev) => (prev ? upsertSession(prev, s) : prev));
        }}
        onOpenInChat={(sessionId) => {
          // Phone Assistant IS a free session — open the real Chat sheet (live steps,
          // perms, markdown) instead of inventing a second transcript UI.
          clearNav();
          setSelected(null);
          setCreating(false);
          setPrefill(null);
          setReposOpen(false);
          setSettingsOpen(false);
          setLiveSessionFocus(sessionId);
          setSessionFocusEpoch((n) => n + 1);
          setSessionsOpen(true);
        }}
        handlersRef={voiceHandlersRef}
        buildScreenContext={buildVoiceScreenContext}
        announceRef={voiceAnnounceRef}
        onError={setError}
      />

      <nav className="bottom-nav" aria-label="Primary" data-evidence="bottom-nav">
        <button
          type="button"
          data-evidence="nav-tasks"
          className={`bottom-nav-item${!sessionsOpen && !reposOpen && !releasesOpen && !settingsOpen && !selected && !creating ? ' is-active' : ''}`}
          onClick={() => {
            // Root destination — clear return stack.
            clearNav();
            setSelected(null);
            setCreating(false);
            setPrefill(null);
            setSessionsOpen(false);
            setLiveSessionFocus(null);
            setReposOpen(false);
            setReleasesOpen(false);
            setSettingsOpen(false);
          }}
        >
          <span className="bottom-nav-icon" aria-hidden>
            ▤
          </span>
          <span>{t(lang, 'navTasks')}</span>
          {reviewCount > 0 ? <span className="bottom-nav-badge">{reviewCount}</span> : null}
        </button>
        <button
          type="button"
          data-evidence="nav-chat"
          className={`bottom-nav-item${sessionsOpen ? ' is-active' : ''}`}
          onClick={() => {
            // Root Chat destination — not "back to task".
            clearNav();
            setSelected(null);
            setCreating(false);
            setPrefill(null);
            setReposOpen(false);
            setReleasesOpen(false);
            setSettingsOpen(false);
            // Re-tap Chat while already on Chat → leave open conversation / form,
            // land on the session list (same as the in-chat ← control).
            if (sessionsOpen) {
              setLiveSessionFocus(null);
              setSessionsListEpoch((n) => n + 1);
            }
            setSessionsOpen(true);
          }}
        >
          <span className="bottom-nav-icon" aria-hidden>
            ✦
          </span>
          <span>{t(lang, 'navChat')}</span>
          {chatBadge > 0 ? <span className="bottom-nav-badge">{chatBadge}</span> : null}
        </button>
        <button
          type="button"
          data-evidence="nav-repos"
          className={`bottom-nav-item${reposOpen ? ' is-active' : ''}`}
          onClick={() => {
            clearNav();
            setSelected(null);
            setCreating(false);
            setPrefill(null);
            setSessionsOpen(false);
            setLiveSessionFocus(null);
            setReleasesOpen(false);
            setSettingsOpen(false);
            setReposOpen(true);
          }}
        >
          <span className="bottom-nav-icon" aria-hidden>
            ◎
          </span>
          <span>{t(lang, 'navRepos')}</span>
        </button>
        <button
          type="button"
          data-evidence="nav-releases"
          className={`bottom-nav-item${releasesOpen ? ' is-active' : ''}`}
          onClick={() => {
            clearNav();
            setSelected(null);
            setCreating(false);
            setPrefill(null);
            setSessionsOpen(false);
            setLiveSessionFocus(null);
            setReposOpen(false);
            setSettingsOpen(false);
            setReleasesOpen(true);
          }}
        >
          <span className="bottom-nav-icon" aria-hidden>
            ⇪
          </span>
          <span>{t(lang, 'navReleases')}</span>
        </button>
        <button
          type="button"
          data-evidence="nav-settings"
          className={`bottom-nav-item${settingsOpen ? ' is-active' : ''}`}
          onClick={() => {
            clearNav();
            setSelected(null);
            setCreating(false);
            setPrefill(null);
            setSessionsOpen(false);
            setLiveSessionFocus(null);
            setReposOpen(false);
            setReleasesOpen(false);
            setSettingsOpen(true);
          }}
        >
          <span className="bottom-nav-icon" aria-hidden>
            ⚙
          </span>
          <span>{t(lang, 'navSettings')}</span>
        </button>
      </nav>

      {detail && (
        <TaskDetail
          task={detail}
          now={now}
          activity={state?.activity?.[detail.id] ?? []}
          pendingChat={state?.pendingChat?.[detail.id] ?? []}
          liveRun={state?.liveRuns?.[detail.id] ?? null}
          verificationRun={state?.verificationRuns?.[detail.id] ?? null}
          brokenDeps={brokenDependencies(detail, allTasksFromState(state))}
          pendingDeps={pendingDependencies(detail, allTasksFromState(state))}
          mergeBlockedDeps={mergeBlockedDependencies(detail, allTasksFromState(state))}
          dispatchHoldReason={state?.holds?.[detail.id] ?? null}
          busy={busy}
          pending={pending}
          stopping={stopping.has(detail.id)}
          agentLabel={effectiveAgent(detail, state?.repos ?? [], state?.agents?.default ?? 'grok')}
          inheritAgent={
            state?.repos.find((r) => r.key === detail.repo)?.effectiveAdapter ??
            state?.agents?.default ??
            'grok'
          }
          availableAgents={state?.agents?.available ?? ['grok', 'codex', 'fake']}
          reviewExperience={reviewExperience}
          closeLabel={sheetCloseLabel}
          onClose={closeTaskSheet}
          chatOutcome={chatOutcomeByTask[detail.id] ?? null}
          onChat={async (message) => {
            if (busy) return;
            setPending('chat');
            const taskId = detail.id;
            // One id per user submission so network/UI retries stay idempotent.
            const clientMessageId = newClientMessageId();
            try {
              const res = await chatTask(taskId, message, { clientMessageId });
              const fx = taskChatUiEffect(res);
              setChatOutcomeByTask((m) => withTaskChatOutcome(m, taskId, fx.label));
              if (fx.applyTask) setState((s) => (s ? moveTask(s, res.task) : s));
              if (fx.closeOnSteer) closeTaskSheet();
              refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setPending(null);
            }
          }}
          onOpenLive={async () => {
            if (busy) return;
            setPending('live');
            try {
              const s = await openTaskLiveSession(detail.id);
              // Remember task so closing Chat returns here.
              pushNavFrame({ kind: 'task', taskId: detail.id });
              setSelected(null);
              setCreating(false);
              setReposOpen(false);
              // Merge before opening so SessionChat mounts on the fresh snapshot
              // (updatedAt key), not a stale SSE copy of the same id.
              setState((prev) => (prev ? upsertSession(prev, s) : prev));
              setLiveSessionFocus(s.id);
              setSessionFocusEpoch((n) => n + 1);
              setSessionsOpen(true);
              // Authoritative follow-up (activity matrix, etc.).
              refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setPending(null);
            }
          }}
          onAction={async (action, opts) => {
            if (busy) return;
            setPending(action);
            try {
              const updated = await act(
                detail.id,
                action,
                action === 'approve'
                  ? {
                      humanAcknowledged: opts?.humanAcknowledged ?? [],
                      ...(opts?.overrideNote ? { overrideNote: opts.overrideNote } : {}),
                    }
                  : undefined,
              );
              setState((s) => (s ? moveTask(s, updated) : s)); // optimistic
              closeTaskSheet();
              refresh(); // authoritative follow-up
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setPending(null);
            }
          }}
          onForceAbort={async () => {
            if (busy) return;
            setPending('forceAbort');
            try {
              await forceAbort(detail.id);
              closeTaskSheet();
              refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setPending(null);
            }
          }}
          onDelete={async (cleanup) => {
            if (busy) return;
            setPending('delete');
            try {
              const res = await deleteTask(detail.id, { cleanup });
              setState((s) => (s ? dropTask(s, detail.id) : s)); // optimistic remove
              closeTaskSheet();
              if (res.notes?.length) {
                setError(
                  `Deleted ${detail.id}${res.cleanup ? ` · ${res.notes.join('; ')}` : ' (no cleanup)'}`,
                );
              }
              refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setPending(null);
            }
          }}
          onOpenPr={async () => {
            if (busy) return;
            setPending('pr');
            try {
              const pr = await openPr(detail.id);
              const href = githubOpenHref(pr);
              openGithub(href);
              setPrBanner({
                url: href,
                label: `${pr.mode === 'created' ? 'PR created' : pr.mode === 'existing' ? 'PR open' : 'Compare'} · tap to open (GitHub sign-in if needed) →`,
              });
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setPending(null);
            }
          }}
          onApprovePr={async (opts) => {
            if (busy) return;
            setPending('approvePr');
            try {
              const { task: updated, pr } = await approveAndOpenPr(detail.id, {
                humanAcknowledged: opts?.humanAcknowledged ?? [],
              });
              setState((s) => (s ? moveTask(s, updated) : s));
              const href = githubOpenHref(pr);
              openGithub(href);
              setPrBanner({
                url: href,
                label: `Approved · ${pr.mode === 'created' ? 'PR created' : pr.mode === 'existing' ? 'PR open' : 'compare'} · tap to open (GitHub sign-in if needed) →`,
              });
              closeTaskSheet();
              refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
              refresh(); // approve may have succeeded before PR failed
            } finally {
              setPending(null);
            }
          }}
          onSteerFromPr={async () => {
            if (busy) return;
            setPending('steerPr');
            try {
              const res = await steerFromPr(detail.id);
              setState((s) => (s ? moveTask(s, res.task) : s));
              closeTaskSheet();
              if (detail.prUrl) {
                setPrBanner({
                  url: githubOpenHref({ url: detail.prUrl }),
                  label: `Steer queued from ${res.commentCount} PR comment(s) · same PR updates after push · open PR →`,
                });
              }
              refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setPending(null);
            }
          }}
          onApprovePlan={async () => {
            if (busy) return;
            // Optimistic: hide the plan panel immediately so multi-tap cannot
            // re-fire while the request is in flight or SSE lags one tick.
            const optimistic: Task = {
              ...detail,
              planPending: false,
              labels: detail.labels.filter((l) => l.toLowerCase() !== 'needs-plan'),
              lastEventAt: new Date().toISOString(),
            };
            setSelected(optimistic);
            setState((s) => (s ? moveTask(s, optimistic) : s));
            setPending('approvePlan');
            try {
              const updated = await approvePlan(detail.id);
              setState((s) => (s ? moveTask(s, updated) : s));
              setSelected(updated);
              // Plan left the decision inbox by design — say where it went (incl. repo cap wait).
              setNotice(
                formatPlanApprovedFeedback(
                  updated,
                  allTasksFromState(state),
                  state?.repos ?? [],
                ),
              );
              // Server now refreshes orchestrator snapshot on commit; refresh is
              // safe and picks up any concurrent fields without planPending flash.
              refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
              // Roll back optimistic plan clear only if the request failed.
              refresh();
            } finally {
              setPending(null);
            }
          }}
          onApproveHostOperation={async (scope) => {
            if (busy) return;
            setPending('approveHostOp');
            try {
              const u = await approveHostOperation(detail.id, scope);
              setState((s) => (s ? moveTask(s, u) : s));
              setSelected(u);
              refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
              refresh();
            } finally {
              setPending(null);
            }
          }}
          onReverify={async () => {
            if (busy) return;
            setPending('reverify');
            try {
              const updated = await reverifyTask(detail.id);
              setState((s) => (s ? moveTask(s, updated) : s));
              setSelected(updated);
              refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setPending(null);
            }
          }}
          onSetAdapter={async (adapter, opts) => {
            if (busy) return;
            setPending(opts?.switchNow ? 'switchNow' : 'adapter');
            try {
              const updated = await setTaskAdapter(detail.id, adapter, opts);
              setState((s) => (s ? moveTask(s, updated) : s));
              setSelected(updated);
              refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setPending(null);
            }
          }}
          onRewireDependencies={async (change) => { setPending('dependencies'); try { await rewireDependencies([change]); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setPending(null); refresh(); } }}
          onClone={() => {
            // Clone is a new root flow (create form), not back-navigation.
            clearNav();
            setSelected(null);
            setPrefill({
              title: detail.title,
              repo: detail.repo,
              body: originalDescription(detail.body),
              adapter: detail.adapter,
              executionClass: detail.executionClass,
            });
            setCreating(true);
          }}
          onSalvageFork={async () => {
            if (busy) return;
            setPending('salvageFork');
            try {
              const created = await salvageForkTask(detail.id);
              setState((s) => (s ? moveTask(s, created) : s));
              setSelected(created);
              refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setPending(null);
            }
          }}
          onQueueFront={makeQueueFrontHandler({ busy, detail, setPending, setState, setSelected, setError, refresh })}
        />
      )}

      {creating && (
        <CreateForm
          repos={state?.repos ?? []}
          availableAgents={state?.agents?.available ?? ['grok', 'codex', 'fake']}
          defaultAgent={state?.agents?.default ?? 'grok'}
          preferredAgent={preferredAgent}
          initial={prefill ?? undefined}
          drafts={drafts}
          onAckDraft={(id) => {
            void ackDraftJob(id).catch(() => undefined);
            setDrafts((prev) => {
              const m = new Map(prev);
              m.delete(id);
              return m;
            });
            draftStatusRef.current.delete(id);
          }}
          onClose={() => { setCreating(false); setPrefill(null); }}
          onCreate={async (input) => {
            try {
              const created = await createTask(input);
              setNotice(
                formatTaskCreatedFeedback(
                  created,
                  allTasksFromState(state),
                  state?.repos ?? [],
                ),
              );
              setCreating(false);
              setPrefill(null);
              refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
              throw e;
            }
          }}
          onCreatePipeline={async (input) => {
            try {
              const created = await createPipeline(input);
              setNotice(
                formatPipelineCreatedFeedback(
                  created,
                  allTasksFromState(state),
                  state?.repos ?? [],
                ),
              );
              setCreating(false);
              setPrefill(null);
              refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
              throw e;
            }
          }}
        />
      )}

      {reposOpen && (
        <div className="sheet-backdrop" onClick={() => setReposOpen(false)}>
          <div
            className="sheet sheet-flush"
            onClick={(e) => e.stopPropagation()}
            data-sheet="repos"
          >
            <ReposPanel
              repos={state?.repos ?? []} successionRefreshKey={state?.seq}
              tasks={allTasksFromState(state)}
              defaultAgent={state?.agents?.default ?? '—'}
              availableAgents={state?.agents?.available ?? ['grok', 'codex', 'fake']}
              onClose={() => setReposOpen(false)}
              onError={setError}
              onChanged={refresh}
              onOpenTask={(taskId, task) => {
                setReposOpen(false);
                setSelected(task ?? findTask(state, taskId));
                if (task) {
                  setState((s) => (s ? moveTask(s, task) : s));
                }
                refresh();
              }}
            />
          </div>
        </div>
      )}

      {/* Mount like Settings/Repos/Sessions: unmount when closed so home shell
          is not painted over (display:flex on .sheet-backdrop ignores [hidden]).
          L2 opens via click [data-evidence=nav-releases] (WORKFLOW + nav-* harden). */}
      {releasesOpen && (
        <div className="sheet-backdrop" onClick={() => setReleasesOpen(false)}>
          <div
            className="sheet sheet-flush"
            onClick={(e) => e.stopPropagation()}
            data-sheet="releases"
            ref={releasesSheetRef}
          >
            <ReleasesPanel
              lang={lang}
              onClose={() => setReleasesOpen(false)}
              onError={setError}
              onChanged={refresh}
              restoreScrollTop={releasesRestoreScrollRef}
              scrollHost={releasesSheetRef}
              onOpenTask={(taskId) => {
                // Remember where the reader was so closing the task returns
                // here, at the same scroll position (operator request).
                pushNavFrame({
                  kind: 'releases',
                  scrollTop: releasesSheetRef.current?.scrollTop ?? 0,
                });
                setReleasesOpen(false);
                const task = findTask(state, taskId);
                if (task) {
                  setSelected(task);
                } else {
                  // Task may not be in the SSE snapshot yet — still surface id.
                  setSelected({ id: taskId } as never);
                }
                refresh();
              }}
            />
          </div>
        </div>
      )}

      {settingsOpen && (
        <div className="sheet-backdrop" onClick={() => setSettingsOpen(false)}>
          <div
            className="sheet sheet-flush"
            onClick={(e) => e.stopPropagation()}
            data-sheet="settings"
          >
            <SettingsPanel
              lang={lang}
              costSummary={state?.costSummary ?? null}
              preferredAgent={preferredAgent}
              daemonDefault={state?.agents?.default ?? 'grok'}
              availableAgents={state?.agents?.available ?? ['grok', 'codex', 'fake']}
              providerPolicy={state?.agents?.providerPolicy ?? null}
              reviewerHealth={state?.reviewerHealth ?? []}
              onLangChange={changeLang}
              onPreferredAgentChange={changePreferredAgent}
              onLogout={() => {
                clearNav();
                setSettingsOpen(false);
                setSelected(null);
                setCreating(false);
                setPrefill(null);
                setSessionsOpen(false);
                setLiveSessionFocus(null);
                setReposOpen(false);
                setReleasesOpen(false);
                signOut();
              }}
              onClose={() => setSettingsOpen(false)}
            />
          </div>
        </div>
      )}

      {sessionsOpen && (
        <div className="sheet-backdrop" onClick={closeSessionsSheet}>
          <div className="sheet sheet-tall" onClick={(e) => e.stopPropagation()}>
            <SessionsPanel
              sessions={state?.sessions ?? []}
              sessionActivity={{
                ...(state?.sessionActivity ?? {}),
                // Task live sessions also surface orchestrator activity by task id.
                ...(state?.activity ?? {}),
              }}
              repos={state?.repos ?? []}
              availableAgents={state?.agents?.available ?? ['grok', 'codex', 'fake']}
              defaultAgent={state?.agents?.default ?? 'grok'}
              tasks={allTasksFromState(state)}
              initialSessionId={liveSessionFocus}
              listEpoch={sessionsListEpoch}
              focusEpoch={sessionFocusEpoch}
              closeLabel={sheetCloseLabel}
              onClose={closeSessionsSheet}
              onError={setError}
              onSessionSynced={(s) => {
                // Upsert only — open paths set liveSessionFocus themselves.
                // Archive/permission patches must not re-focus a hidden session.
                setState((prev) => (prev ? upsertSession(prev, s) : prev));
                if (s.archived) {
                  setLiveSessionFocus((cur) => (cur === s.id ? null : cur));
                }
                refresh();
              }}
              onOpenTask={(taskId) => {
                const t = findTask(state, taskId);
                if (!t) {
                  setError(`Unknown task ${taskId}`);
                  return;
                }
                const sessionId =
                  liveSessionFocus ??
                  state?.sessions?.find((s) => s.id === taskId || s.taskId === taskId)?.id ??
                  taskId;
                openTaskSheet(t, { kind: 'session', sessionId });
              }}
              onOpenSession={(sessionId) => {
                setSelected(null);
                setReposOpen(false);
                setReleasesOpen(false);
                setSettingsOpen(false);
                setCreating(false);
                setLiveSessionFocus(sessionId);
                setSessionFocusEpoch((n) => n + 1);
                setSessionsOpen(true);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function buildHerculesScreenContext(opts: {
  state: StateDto | null;
  selected: Task | null;
  liveSessionFocus: string | null;
  sessionsOpen: boolean;
  reposOpen: boolean;
  creating: boolean;
}): string {
  const { state, selected, liveSessionFocus, sessionsOpen, reposOpen, creating } = opts;
  const lines: string[] = [];
  const sheet = creating
    ? 'creating-task'
    : reposOpen
      ? 'repos'
      : sessionsOpen
        ? liveSessionFocus
          ? `session:${liveSessionFocus}`
          : 'sessions-list'
        : selected
          ? `task:${selected.id}`
          : 'tasks-home';
  lines.push(`view: ${sheet}`);
  if (!state) {
    lines.push('(state loading)');
    return lines.join('\n');
  }

  const sessions = (state.sessions ?? []).filter((s) => s.status !== 'closed' && !s.archived);
  const focusId = pickFocusSessionId(sessions, liveSessionFocus);
  if (focusId) lines.push(`focus_session: ${focusId}`);

  const review = state.byState.review ?? [];
  if (review.length) {
    lines.push(`review (${review.length}):`);
    for (const t of review.slice(0, 8)) {
      lines.push(`  - ${t.id}: ${t.title.slice(0, 60)}`);
    }
  }
  const progress = [...(state.byState.in_progress ?? []), ...(state.byState.retrying ?? [])];
  if (progress.length) {
    lines.push(`in progress (${progress.length}):`);
    for (const t of progress.slice(0, 6)) {
      lines.push(`  - ${t.id}: ${t.title.slice(0, 50)}`);
    }
  }

  if (sessions.length) {
    lines.push(`sessions (${sessions.length}):`);
    for (const s of sessions.slice(0, 10)) {
      const perms = s.pendingPermissions?.length ?? 0;
      const props = s.pendingProposals?.length ?? 0;
      const mark = s.id === focusId ? ' *focus*' : '';
      lines.push(
        `  - ${s.id} [${s.status}${s.kind === 'task' ? ' task-live' : ''}]${mark} ${s.title.slice(0, 40)}` +
          ` mode=${s.permissionMode}` +
          (perms ? ` perms=${perms}` : '') +
          (props ? ` proposals=${props}` : '') +
          (s.queued.length ? ` queued=${s.queued.length}` : ''),
      );
    }
  }

  if (focusId) {
    const s = sessions.find((x) => x.id === focusId);
    if (s) lines.push(...formatSessionDeep(s, state));
  }

  if (selected) {
    lines.push(`open_task: ${selected.id} [${selected.state}] ${selected.title.slice(0, 50)}`);
    lines.push(...formatTaskEvidencePreview(selected));
  }

  const repos = state.repos?.map((r) => r.key).join(', ') ?? '';
  if (repos) lines.push(`repos: ${repos}`);
  return lines.join('\n');
}

/**
 * Screen-context teaser only — NOT for answering content questions.
 * Always steers the model to inspect_task (index/read).
 */
function formatTaskEvidencePreview(task: Task): string[] {
  const metaLines = formatTaskMeta(task).split('\n').slice(0, 8);
  return [
    `  task_inspect: use inspect_task action=index|read (screen lines below are NOT full content)`,
    ...metaLines.map((l) => `  ${l}`),
  ];
}

function formatSessionDeep(s: RemoteSession, state: StateDto): string[] {
  const lines: string[] = [];
  lines.push(`FOCUS DETAIL ${s.id}:`);
  lines.push(
    `  status=${s.status} kind=${s.kind} repo=${s.repo} mode=${s.permissionMode}` +
      (s.taskId ? ` taskId=${s.taskId}` : '') +
      (s.linkedTaskId ? ` linked=${s.linkedTaskId}` : '') +
      (s.error ? ` error=${clipFragment(s.error, 100)}` : ''),
  );
  const permLines = (s.pendingPermissions ?? []).map(
    (p) =>
      `  perm ${p.id}: [${p.toolKind}] ${p.title.slice(0, 60)} opts=${p.options.map((o) => o.optionId).join(',')}`,
  );
  const { text: permText, truncated: permTrunc } = listFragment(permLines, 5, 'permissions');
  if (permLines.length) {
    if (permTrunc) lines.push(permText);
    else lines.push(...permLines);
  }
  for (const p of s.pendingProposals?.slice(0, 3) ?? []) {
    lines.push(`  proposal ${p.id}: ${p.title.slice(0, 50)}`);
  }
  const msgs = s.messages.slice(-4);
  if (msgs.length) {
    lines.push(
      `  recent_messages: ${FRAGMENT_NOTE_TAIL(s.messages.length, msgs.length)}`,
    );
    for (const m of msgs) {
      lines.push(
        `    ${m.role}: ${clipFragment(m.content.replace(/\s+/g, ' '), 100, { forceFragment: true })}`,
      );
    }
  }
  const actKey = s.kind === 'task' && s.taskId ? s.taskId : s.id;
  const steps = state.sessionActivity?.[s.id] ?? state.activity?.[actKey] ?? [];
  if (steps.length) {
    const tail = steps.slice(-5);
    lines.push(`  live_steps_tail: ${FRAGMENT_NOTE_TAIL(steps.length, tail.length)}`);
    for (const line of tail) {
      lines.push(`    - ${clipFragment(line, 100, { forceFragment: true })}`);
    }
  }
  return lines;
}

function FRAGMENT_NOTE_TAIL(total: number, shown: number): string {
  if (shown >= total) return `(${shown} items)`;
  return `[FRAGMENT — last ${shown} of ${total} only; not the full history]`;
}

function resolveVoiceTask(
  opts: { state: StateDto | null; selected: Task | null },
  taskId: unknown,
): Task | null {
  if (typeof taskId === 'string' && taskId.trim()) {
    return findTask(opts.state, taskId.trim());
  }
  if (opts.selected) return findTask(opts.state, opts.selected.id) ?? opts.selected;
  return null;
}

function pickPermOption(
  perm: NonNullable<RemoteSession['pendingPermissions']>[number],
  decision: string,
): { optionId: string; name: string } | null {
  const option =
    decision === 'deny'
      ? perm.options.find(
          (o) =>
            /deny|reject|cancel|no/i.test(o.optionId) || /deny|reject|no/i.test(o.name),
        )
      : perm.options.find((o) => o.optionId.startsWith('allow') || o.kind.startsWith('allow'));
  return option ? { optionId: option.optionId, name: option.name } : null;
}

function buildVoiceHandlers(opts: {
  state: StateDto | null;
  selected: Task | null;
  liveSessionFocus: string | null;
  sessionsOpen: boolean;
  setSelected: (t: Task | null) => void;
  setCreating: (v: boolean) => void;
  setPrefill: (p: { title: string; repo: string; body: string } | null) => void;
  setSessionsOpen: (v: boolean) => void;
  setReposOpen: (v: boolean) => void;
  setReleasesOpen: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
  setLiveSessionFocus: (id: string | null) => void;
  setSessionsListEpoch: (fn: (n: number) => number) => void;
  setSessionFocusEpoch: (fn: (n: number) => number) => void;
  setError: (msg: string | null) => void;
  setPrBanner: (b: { url: string; label: string } | null) => void;
  clearNav: () => void;
  pushNavFrame: (frame: NavReturn) => void;
  openTaskSheet: (task: Task, from?: NavReturn | null) => void;
}): VoiceHandlers {
  const sessions = (): RemoteSession[] =>
    (opts.state?.sessions ?? []).filter((s) => s.status !== 'closed');

  const pickSession = (id?: unknown): string | null =>
    pickFocusSessionId(sessions(), opts.liveSessionFocus, id);

  const requireSession = (id?: unknown): { sid: string; sess: RemoteSession } | { error: string } => {
    const sid = pickSession(id);
    if (!sid) return { error: 'No focus session — open_session or start_session first' };
    const sess = sessions().find((s) => s.id === sid);
    if (!sess) return { error: `Unknown session ${sid}` };
    return { sid, sess };
  };

  const defaultRepo = (): string => opts.state?.repos?.[0]?.key ?? '';

  const focusSessionUi = (sid: string, fromTask?: string | null): void => {
    if (fromTask) opts.pushNavFrame({ kind: 'task', taskId: fromTask });
    opts.setSelected(null);
    opts.setReposOpen(false);
    opts.setReleasesOpen(false);
    opts.setSettingsOpen(false);
    opts.setCreating(false);
    opts.setLiveSessionFocus(sid);
    opts.setSessionFocusEpoch((n) => n + 1);
    opts.setSessionsOpen(true);
  };

  return {
    get_status: () => ({
      ok: true,
      message: buildHerculesScreenContext({
        state: opts.state,
        selected: opts.selected,
        liveSessionFocus: opts.liveSessionFocus,
        sessionsOpen: opts.liveSessionFocus != null,
        reposOpen: false,
        creating: false,
      }),
    }),

    get_session: (args) => {
      const r = requireSession(args['sessionId']);
      if ('error' in r) return { ok: false, message: r.error };
      if (!opts.state) return { ok: false, message: 'state not ready' };
      const lines = formatSessionDeep(r.sess, opts.state);
      return { ok: true, message: lines.join('\n') };
    },

    list_messages: (args) => {
      const r = requireSession(args['sessionId']);
      if ('error' in r) return { ok: false, message: r.error };
      let limit = 8;
      if (typeof args['limit'] === 'number' && Number.isFinite(args['limit'])) {
        limit = Math.max(1, Math.min(20, Math.floor(args['limit'])));
      }
      const all = r.sess.messages;
      const msgs = all.slice(-limit);
      if (msgs.length === 0) return { ok: true, message: '(no messages yet)' };
      const header =
        msgs.length < all.length
          ? `[FRAGMENT — last ${msgs.length} of ${all.length} messages only; not the full transcript]\n`
          : '';
      const lines = msgs.map(
        (m) =>
          `${m.role}: ${clipFragment(m.content.replace(/\s+/g, ' '), 280, {
            forceFragment: m.content.length > 280,
          })}`,
      );
      return { ok: true, message: header + lines.join('\n') };
    },

    read_live_steps: (args) => {
      const r = requireSession(args['sessionId']);
      if ('error' in r) return { ok: false, message: r.error };
      const actKey = r.sess.kind === 'task' && r.sess.taskId ? r.sess.taskId : r.sid;
      const steps =
        opts.state?.sessionActivity?.[r.sid] ??
        opts.state?.activity?.[actKey] ??
        opts.state?.activity?.[r.sid] ??
        [];
      if (steps.length === 0) {
        return {
          ok: true,
          message:
            r.sess.status === 'running'
              ? 'running — quiet (no stream lines yet; long tools are normal)'
              : `status=${r.sess.status} (not running)`,
        };
      }
      const tail = steps.slice(-12);
      const header =
        tail.length < steps.length
          ? `[FRAGMENT — last ${tail.length} of ${steps.length} steps only]\n`
          : '';
      return {
        ok: true,
        message: header + tail.map((l) => clipFragment(l, 200, { forceFragment: l.length > 200 })).join('\n'),
      };
    },

    get_diff_summary: async (args) => {
      const r = requireSession(args['sessionId']);
      if ('error' in r) return { ok: false, message: r.error };
      try {
        const d = await fetchSessionDiff(r.sid);
        if (!d.available) {
          return { ok: true, message: d.reason ?? 'Diff unavailable' };
        }
        const fileSlice = d.files.slice(0, 30);
        const filesNote =
          d.files.length > 30
            ? `[FRAGMENT — ${fileSlice.length} of ${d.files.length} files listed]\n`
            : '';
        const summary = clipFragment(d.summary, 500, {
          forceFragment: d.summary.length > 500,
        });
        return {
          ok: true,
          message: `${summary}\n${filesNote}files: ${fileSlice.join(', ') || '(none)'}`,
        };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    },

    inspect_task: (args) => {
      const task = resolveVoiceTask(opts, args['taskId']);
      if (!task) return { ok: false, message: 'No open task — open_task first or pass taskId' };
      const action = String(args['action'] ?? '');
      if (action === 'meta') return { ok: true, message: formatTaskMeta(task) };
      if (action === 'index') return { ok: true, message: formatTaskIndex(task) };
      if (action === 'plan') {
        const topic = typeof args['topic'] === 'string' ? args['topic'] : 'all';
        return { ok: true, message: formatReadPlan(task, topic) };
      }
      if (action === 'read') {
        const part =
          typeof args['part'] === 'string' || typeof args['part'] === 'number'
            ? (args['part'] as string | number)
            : undefined;
        const offset =
          typeof args['offset'] === 'number' && Number.isFinite(args['offset'])
            ? Math.floor(args['offset'])
            : 0;
        const maxChars =
          typeof args['maxChars'] === 'number' && Number.isFinite(args['maxChars'])
            ? Math.floor(args['maxChars'])
            : undefined;
        const result = readTaskPart(task, part, {
          offset,
          ...(maxChars !== undefined ? { maxChars } : {}),
        });
        if ('error' in result) return { ok: false, message: result.error };
        return { ok: true, message: result.text };
      }
      return {
        ok: false,
        message: 'action must be meta|index|plan|read',
      };
    },

    inspect_session: (args) => {
      const r = requireSession(args['sessionId']);
      if ('error' in r) return { ok: false, message: r.error };
      const action = String(args['action'] ?? '');
      if (action === 'meta') {
        return {
          ok: true,
          message: [
            `SESSION META ${r.sid}`,
            `status=${r.sess.status} kind=${r.sess.kind} repo=${r.sess.repo} mode=${r.sess.permissionMode}`,
            `title=${r.sess.title}`,
            `messages=${r.sess.messages.length} queued=${r.sess.queued.length}`,
            `perms=${r.sess.pendingPermissions?.length ?? 0} proposals=${r.sess.pendingProposals?.length ?? 0}`,
            r.sess.taskId ? `taskId=${r.sess.taskId}` : '',
            r.sess.error ? `error=${r.sess.error}` : '',
            'For content: action=messages or action=activity with offset/limit.',
          ]
            .filter(Boolean)
            .join('\n'),
        };
      }
      if (action === 'messages') {
        const all = r.sess.messages;
        let offset = 0;
        if (typeof args['offset'] === 'number' && Number.isFinite(args['offset'])) {
          offset = Math.max(0, Math.floor(args['offset']));
        }
        let limit = 10;
        if (typeof args['limit'] === 'number' && Number.isFinite(args['limit'])) {
          limit = Math.max(1, Math.min(40, Math.floor(args['limit'])));
        }
        if (offset >= all.length) {
          return {
            ok: true,
            message: `[COMPLETE] messages: offset ${offset} past end (total ${all.length}).`,
          };
        }
        const page = all.slice(offset, offset + limit);
        const end = offset + page.length;
        const complete = end >= all.length;
        const header = complete
          ? `[COMPLETE] messages ${offset}..${end - 1} of ${all.length}`
          : `[FRAGMENT — messages ${offset}..${end - 1} of ${all.length}; continue offset=${end}]`;
        const body = page
          .map(
            (m, i) =>
              `[${offset + i}] ${m.role}: ${clipFragment(m.content.replace(/\s+/g, ' '), 500, {
                forceFragment: m.content.length > 500,
              })}`,
          )
          .join('\n');
        return { ok: true, message: `${header}\n${body}` };
      }
      if (action === 'activity') {
        const actKey = r.sess.kind === 'task' && r.sess.taskId ? r.sess.taskId : r.sid;
        const steps =
          opts.state?.sessionActivity?.[r.sid] ??
          opts.state?.activity?.[actKey] ??
          opts.state?.activity?.[r.sid] ??
          [];
        let limit = 15;
        if (typeof args['limit'] === 'number' && Number.isFinite(args['limit'])) {
          limit = Math.max(1, Math.min(40, Math.floor(args['limit'])));
        }
        if (steps.length === 0) {
          return { ok: true, message: `activity: (none) status=${r.sess.status}` };
        }
        const tail = steps.slice(-limit);
        const header =
          tail.length < steps.length
            ? `[FRAGMENT — last ${tail.length} of ${steps.length} activity lines]`
            : `[COMPLETE] ${tail.length} activity lines`;
        return {
          ok: true,
          message:
            header +
            '\n' +
            tail
              .map((l) => clipFragment(l, 300, { forceFragment: l.length > 300 }))
              .join('\n'),
        };
      }
      return { ok: false, message: 'action must be meta|messages|activity' };
    },

    send_chat: async (args) => {
      // Preserve user wording — only trim ends.
      const message = typeof args['message'] === 'string' ? args['message'].trim() : '';
      if (!message) return { ok: false, message: 'message required' };
      const r = requireSession(args['sessionId']);
      if ('error' in r) return { ok: false, message: r.error };
      const queueOnly = args['queueOnly'] === true;
      const running = r.sess.status === 'running';
      const isTask = r.sess.kind === 'task';
      const interrupt = running && !isTask && !queueOnly;
      await sendSessionMessage(r.sid, message, { interrupt });
      focusSessionUi(r.sid);
      return {
        ok: true,
        message: interrupt ? `Interrupted & sent to ${r.sid}` : `Sent to ${r.sid}`,
      };
    },

    set_permission_mode: async (args) => {
      const r = requireSession(args['sessionId']);
      if ('error' in r) return { ok: false, message: r.error };
      const mode = String(args['mode'] ?? '') as PermissionMode;
      if (!['acceptEdits', 'bypass', 'default'].includes(mode)) {
        return { ok: false, message: 'mode must be acceptEdits|bypass|default' };
      }
      await setSessionPermissionMode(r.sid, mode);
      return { ok: true, message: `Permission mode → ${mode} on ${r.sid}` };
    },

    stop_session: async (args) => {
      const r = requireSession(args['sessionId']);
      if ('error' in r) return { ok: false, message: r.error };
      await stopSession(r.sid);
      return { ok: true, message: `Stopped ${r.sid}` };
    },

    resolve_permission: async (args) => {
      const r = requireSession(args['sessionId']);
      if ('error' in r) return { ok: false, message: r.error };
      const perms = r.sess.pendingPermissions ?? [];
      let permId = typeof args['permissionId'] === 'string' ? args['permissionId'] : '';
      if (!permId && perms.length === 1) permId = perms[0]!.id;
      if (!permId) return { ok: false, message: 'permissionId required (or only one pending)' };
      const perm = perms.find((p) => p.id === permId);
      if (!perm) return { ok: false, message: `Permission ${permId} not found` };
      const decision = String(args['decision'] ?? 'allow');
      const option = pickPermOption(perm, decision);
      if (!option) return { ok: false, message: `No ${decision} option on permission` };
      await resolveSessionPermission(r.sid, permId, option.optionId);
      focusSessionUi(r.sid);
      return { ok: true, message: `${decision} → ${option.name} (${perm.title.slice(0, 40)})` };
    },

    resolve_all_permissions: async (args) => {
      const r = requireSession(args['sessionId']);
      if ('error' in r) return { ok: false, message: r.error };
      const perms = [...(r.sess.pendingPermissions ?? [])];
      if (perms.length === 0) return { ok: true, message: 'No pending permissions' };
      const decision = String(args['decision'] ?? 'allow');
      const results: string[] = [];
      for (const perm of perms) {
        const option = pickPermOption(perm, decision);
        if (!option) {
          results.push(`${perm.id}: no ${decision} option`);
          continue;
        }
        await resolveSessionPermission(r.sid, perm.id, option.optionId);
        results.push(`${perm.id}: ${option.name}`);
      }
      focusSessionUi(r.sid);
      return { ok: true, message: results.join('; ') };
    },

    approve_proposal: async (args) => {
      const r = requireSession(args['sessionId']);
      if ('error' in r) return { ok: false, message: r.error };
      const props = r.sess.pendingProposals ?? [];
      let pid = typeof args['proposalId'] === 'string' ? args['proposalId'] : '';
      if (!pid && props.length === 1) pid = props[0]!.id;
      if (!pid) return { ok: false, message: 'proposalId required (or only one pending)' };
      const out = await approveSessionProposal(r.sid, pid);
      opts.openTaskSheet(out.task, { kind: 'session', sessionId: r.sid });
      return { ok: true, message: `Created task ${out.task.id} from proposal` };
    },

    dismiss_proposal: async (args) => {
      const r = requireSession(args['sessionId']);
      if ('error' in r) return { ok: false, message: r.error };
      const props = r.sess.pendingProposals ?? [];
      let pid = typeof args['proposalId'] === 'string' ? args['proposalId'] : '';
      if (!pid && props.length === 1) pid = props[0]!.id;
      if (!pid) return { ok: false, message: 'proposalId required (or only one pending)' };
      await dismissSessionProposal(r.sid, pid);
      return { ok: true, message: `Dismissed proposal ${pid}` };
    },

    promote_to_task: async (args) => {
      const r = requireSession(args['sessionId']);
      if ('error' in r) return { ok: false, message: r.error };
      const draft = await fetchSessionTaskDraft(r.sid);
      const title =
        typeof args['title'] === 'string' && args['title'].trim()
          ? args['title'].trim()
          : draft.title;
      const out = await createTaskFromSession(r.sid, {
        title,
        repo: draft.repo,
        body: draft.body,
        confirm: true,
      });
      opts.openTaskSheet(out.task, { kind: 'session', sessionId: r.sid });
      return { ok: true, message: `Promoted chat → task ${out.task.id}` };
    },

    pin_session: async (args) => {
      const r = requireSession(args['sessionId']);
      if ('error' in r) return { ok: false, message: r.error };
      const pinned = args['pinned'] === true;
      await patchSession(r.sid, { pinned });
      return { ok: true, message: pinned ? `Pinned ${r.sid}` : `Unpinned ${r.sid}` };
    },

    navigate: (args) => {
      const tab = String(args['tab'] ?? 'home');
      // Tab switches are root destinations — drop return stack.
      opts.clearNav();
      opts.setCreating(false);
      opts.setPrefill(null);
      opts.setSelected(null);
      opts.setReposOpen(false);
      opts.setReleasesOpen(false);
      opts.setSettingsOpen(false);
      opts.setSessionsOpen(false);
      opts.setLiveSessionFocus(null);
      if (tab === 'chat') {
        opts.setSessionsOpen(true);
        opts.setSessionsListEpoch((n) => n + 1);
      } else if (tab === 'repos') {
        opts.setReposOpen(true);
      } else if (tab === 'releases') {
        opts.setReleasesOpen(true);
      } else if (tab === 'settings') {
        opts.setSettingsOpen(true);
      }
      return { ok: true, message: `Navigated to ${tab}` };
    },

    open_session: (args) => {
      const id = typeof args['sessionId'] === 'string' ? args['sessionId'] : '';
      if (!id) return { ok: false, message: 'sessionId required' };
      const fromTask = opts.selected?.id ?? null;
      focusSessionUi(id, fromTask);
      return { ok: true, message: `Opened session ${id}` };
    },

    open_task: (args) => {
      const id = typeof args['taskId'] === 'string' ? args['taskId'] : '';
      const task = id ? findTask(opts.state, id) : null;
      if (!task) return { ok: false, message: `Unknown task ${id}` };
      let from: NavReturn | null = null;
      if (opts.sessionsOpen || opts.liveSessionFocus) {
        const sessionId =
          opts.liveSessionFocus ??
          opts.state?.sessions?.find((s) => s.id === id || s.taskId === id)?.id ??
          id;
        from = { kind: 'session', sessionId };
      }
      opts.openTaskSheet(task, from);
      return { ok: true, message: `Opened task ${id}` };
    },

    open_live_for_task: async (args) => {
      const id = typeof args['taskId'] === 'string' ? args['taskId'] : '';
      if (!id) return { ok: false, message: 'taskId required' };
      const s = await openTaskLiveSession(id);
      // Voice path: same force-open as the phone list / task detail.
      focusSessionUi(s.id, id);
      return { ok: true, message: `Opened live session ${s.id} for task ${id}` };
    },

    task_action: async (args) => {
      const id = typeof args['taskId'] === 'string' ? args['taskId'] : '';
      const action = String(args['action'] ?? '');
      if (!id || !['approve', 'reject', 'retry', 'cancel'].includes(action)) {
        return { ok: false, message: 'taskId and action required' };
      }
      await act(id, action as 'approve' | 'reject' | 'retry' | 'cancel');
      return { ok: true, message: `${action} ${id}` };
    },

    approve_and_pr: async (args) => {
      const id = typeof args['taskId'] === 'string' ? args['taskId'] : '';
      if (!id) return { ok: false, message: 'taskId required' };
      const out = await approveAndOpenPr(id);
      const url = out.pr.openUrl ?? out.pr.url;
      opts.setPrBanner({ url, label: `PR · ${out.pr.mode}` });
      opts.openTaskSheet(out.task, null);
      return { ok: true, message: `Approved ${id}; PR ${out.pr.mode}: ${url}` };
    },

    steer_task: async (args) => {
      const id = typeof args['taskId'] === 'string' ? args['taskId'] : '';
      const comment = typeof args['comment'] === 'string' ? args['comment'].trim() : '';
      if (!id || !comment) return { ok: false, message: 'taskId and comment required' };
      await steerTask(id, comment);
      const task = findTask(opts.state, id);
      if (task) opts.openTaskSheet(task, null);
      return { ok: true, message: `Steered ${id}` };
    },

    create_task: async (args) => {
      const title = typeof args['title'] === 'string' ? args['title'].trim() : '';
      if (!title) return { ok: false, message: 'title required' };
      const body = typeof args['body'] === 'string' ? args['body'] : '';
      const repo =
        typeof args['repo'] === 'string' && args['repo'].trim()
          ? args['repo'].trim()
          : defaultRepo();
      if (!repo) return { ok: false, message: 'No repo available' };
      const task = await createTask({ title, repo, body });
      opts.clearNav();
      opts.openTaskSheet(task, null);
      return { ok: true, message: `Created ${task.id}` };
    },

    start_session: async (args) => {
      const message = typeof args['message'] === 'string' ? args['message'].trim() : '';
      if (!message) return { ok: false, message: 'message required' };
      const repo =
        typeof args['repo'] === 'string' && args['repo'].trim()
          ? args['repo'].trim()
          : defaultRepo();
      if (!repo) return { ok: false, message: 'No repo available' };
      const s = await startSession({ repo, message });
      opts.clearNav();
      focusSessionUi(s.id);
      return { ok: true, message: `Started ${s.id}` };
    },
  };
}

/**
 * Deploy stamp: vYYYYMMDD.<dayPush> → chip `M/D · #N`.
 * Tap copies the full stamp (and server sha when present) to the clipboard.
 */
function displayVer(v: string): string {
  const t = v.trim();
  if (!t) return 'dev';
  const m = /^v(\d{4})(\d{2})(\d{2})\.(\d{1,3})\b/.exec(t);
  if (m) return `${Number(m[2])}/${Number(m[3])} · #${m[4]}`;
  // Legacy sha stamps
  const legacy = /^v\d{8}\.([0-9a-fA-F]{4,12})/.exec(t);
  if (legacy?.[1]) return legacy[1].toLowerCase();
  return t.replace(/^v/, '').slice(0, 14);
}

function VersionStamp({
  serverVersion,
  serverSha,
}: {
  serverVersion?: string;
  serverSha?: string;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const uiVersion =
    typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__ ? __APP_VERSION__ : 'dev';
  const server = typeof serverVersion === 'string' ? serverVersion : '';
  // Prefer server stamp (authoritative after deploy); fall back to baked UI.
  const shown = server || uiVersion;
  const label = displayVer(shown);
  const mismatch =
    server.length > 0 && uiVersion.length > 0 && displayVer(server) !== displayVer(uiVersion);
  const copyText = [shown, serverSha && serverSha !== 'forced' ? serverSha : null, mismatch ? `UI ${uiVersion}` : null]
    .filter(Boolean)
    .join(' · ');
  const title = mismatch
    ? `UI ${displayVer(uiVersion)} ≠ server ${displayVer(server)} — tap to reload SPA\n${copyText}`
    : `Tap to copy · ${copyText}`;

  const onCopy = async (): Promise<void> => {
    if (await copyToClipboard(copyText)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  const onClick = (): void => {
    // Stale SPA cannot render new features (e.g. in-chat action buttons) even
    // when SSE shows fresh text. Mismatch → hard reload; match → copy stamp.
    if (mismatch) {
      window.location.reload();
      return;
    }
    void onCopy();
  };

  return (
    <button
      type="button"
      className={`topbar-version${mismatch ? ' is-mismatch' : ''}${copied ? ' is-copied' : ''}`}
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      {copied ? 'copied' : mismatch ? `↻ reload ${label}` : label}
    </button>
  );
}

function TokenGate({
  lang,
  onToken,
}: {
  lang: Lang;
  onToken: (tok: string) => void;
}): JSX.Element {
  const [value, setValue] = useState('');
  // Staging auto-unlock: `#hsc=` one-time code from production → daemon token.
  const [autoUnlock, setAutoUnlock] = useState<'idle' | 'pending' | 'failed'>(() =>
    handoffCodeFromHash(window.location.hash) ? 'pending' : 'idle',
  );
  useEffect(() => {
    const code = handoffCodeFromHash(window.location.hash);
    if (!code) return;
    // Consume the fragment immediately — single-use either way.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    void redeemStagingHandoff(code).then((tok) => {
      if (tok) onToken(tok);
      else setAutoUnlock('failed');
    });
  }, []);
  if (autoUnlock === 'pending') {
    return (
      <div className="gate">
        <h1>{t(lang, 'tokenTitle')}</h1>
        <p className="muted">{t(lang, 'tokenAutoUnlocking')}</p>
      </div>
    );
  }
  return (
    <div className="gate">
      <h1>{t(lang, 'tokenTitle')}</h1>
      {autoUnlock === 'failed' ? (
        <p className="muted">{t(lang, 'tokenAutoUnlockFailed')}</p>
      ) : null}
      <p className="muted">{t(lang, 'tokenHint')}</p>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t(lang, 'tokenPlaceholder')}
        type="password"
      />
      <button className="primary" disabled={!value.trim()} onClick={() => onToken(value.trim())}>
        {t(lang, 'tokenUnlock')}
      </button>
    </div>
  );
}
