/**
 * Task list home: search, sections by state, awaiting-merge strip, bulk clear, cards.
 * Optional repo chip bar when tasks span 2+ repos.
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { ConfirmButton } from './ConfirmButton.js';
import { t } from './i18n.js';
import type { Lang } from './prefs.js';
import {
  autoDeleteMeta,
  canBulkDeleteState,
  collectAwaitingMergeTasks,
  collectTaskRepos,
  effectiveAgent,
  loadRepoFilter,
  matchesRepoFilter,
  matchesTaskSearch,
  normalizeRepoFilter,
  saveRepoFilter,
  shortTiming,
  STATE_ORDER,
  stateLabel,
  type RepoFilter,
} from './taskUi.js';
import { hasOpenPr } from '../domain/task.js';
import { unprovenUiFromTaskBody } from '../domain/decisionCard.js';
import { packetCostChip } from './taskBody.js';
import type { LiveRunMeta, StateDto, Task, TaskState } from './api.js';

function SectionClearControl({
  count,
  disabled,
  loading,
  onConfirm,
}: {
  count: number;
  disabled?: boolean;
  loading?: boolean;
  onConfirm: () => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!expanded) return;
    const onOutside = (e: PointerEvent): void => {
      const t = e.target;
      if (t instanceof Node && wrapRef.current && !wrapRef.current.contains(t)) {
        setExpanded(false);
      }
    };
    document.addEventListener('pointerdown', onOutside, true);
    return () => document.removeEventListener('pointerdown', onOutside, true);
  }, [expanded]);

  if (!expanded) {
    return (
      <button
        type="button"
        className="section-clear-affordance"
        disabled={disabled || loading || count < 1}
        aria-label={`Clear ${count} tasks in this group`}
        title={`Clear ${count} tasks`}
        onClick={(e) => {
          e.stopPropagation();
          setExpanded(true);
        }}
      >
        <span className="section-clear-glyph" aria-hidden>
          ⌫
        </span>
      </button>
    );
  }

  return (
    <div ref={wrapRef} className="section-clear-expanded" onClick={(e) => e.stopPropagation()}>
      <ConfirmButton
        className="section-clear-btn"
        label="Clear"
        confirmLabel={`Delete ${count}?`}
        disabled={disabled}
        loading={loading}
        onConfirm={() => {
          setExpanded(false);
          onConfirm();
        }}
      />
    </div>
  );
}


export function TaskCard({
  task,
  now,
  running,
  agentLabel,
  liveRun,
  verificationRun,
  onTap,
}: {
  task: Task;
  now: number;
  running: boolean;
  agentLabel: string;
  liveRun?: LiveRunMeta | null;
  verificationRun?: import('./api.js').VerificationRunMeta | null;
  onTap: () => void;
}): JSX.Element {
  const time = shortTiming(task, now, liveRun, verificationRun);
  const prOpen = hasOpenPr(task);
  const costChip = packetCostChip(task.body, { nonce: task.packetNonce ?? null });
  const autoClear = autoDeleteMeta(task, now);
  // Soft UI-AC gap from DecisionCard — list surface so the warn is visible
  // without opening the sheet, and remains in the DOM under Settings overlay
  // (daemon L2 plan may greenwash to Settings; assert still finds the hook).
  const unprovenUi =
    task.state === 'review' ? unprovenUiFromTaskBody(task.body) : null;
  const verifying = Boolean(verificationRun);
  const quiet =
    running &&
    !verifying &&
    liveRun?.processAlive === true &&
    (liveRun.silenceMs ?? 0) >= 30_000;
  return (
    <button
      className={`card card-state-${task.state}${running || verifying ? ' is-live' : ''}${quiet ? ' is-quiet' : ''}${prOpen ? ' card-pr-open' : ''}${costChip?.kind === 'steer' ? ' card-steer-cost' : ''}`}
      data-evidence="task-card"
      data-task-id={task.id}
      onClick={onTap}
    >
      <div className="card-head">
        <span className="id">{task.id}</span>
        {task.state === 'failed' ? (
          <span className="failed-badge" data-evidence="task-card-failed">
            Failed
          </span>
        ) : null}
        {(running || verifying) && (
          <span className={quiet ? 'live live-quiet' : 'live'}>
            {verifying
              ? `● verifying${verificationRun?.stage ? `: ${verificationRun.stage}` : ''}`
              : quiet
                ? `● quiet${liveRun?.aliveHint ? ` · ${liveRun.aliveHint}` : ''}`
                : '● live'}
          </span>
        )}
        {prOpen && <span className="pr-open-badge">PR open</span>}
        {autoClear ? <span className="auto-clear-badge">{autoClear}</span> : null}
        {costChip ? (
          <span className={`cost-badge cost-badge-${costChip.tone}`}>{costChip.label}</span>
        ) : null}
      </div>
      <div className="title">{task.title}</div>
      <div className="meta muted">
        {task.repo}
        {` · ${agentLabel}`}
        {time && ` · ${time}`}
        {task.attempts > 0 && ` · attempt ${task.attempts}`}
        {task.blockedBy.length > 0 && ` · blocked by ${task.blockedBy.join(', ')}`}
        {/* PR state is only the head badge — do not also append "· PR open" in meta. */}
      </div>
      {unprovenUi ? (
        <span
          className="human-ac-unproven human-ac-unproven-card"
          data-evidence="human-ac-unproven"
          role="status"
        >
          {unprovenUi.warning}
          {unprovenUi.reason ? (
            <span className="muted"> — {unprovenUi.reason}</span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}


export function TasksPanel({
  state,
  lang,
  now,
  collapsed,
  running,
  bulkPending,
  pending,
  onToggleSection,
  onBulkDelete,
  onSelectTask,
}: {
  state: StateDto;
  lang: Lang;
  now: number;
  collapsed: Partial<Record<TaskState, boolean>>;
  running: ReadonlySet<string>;
  bulkPending: string | null;
  pending: string | null;
  onToggleSection: (s: TaskState) => void;
  onBulkDelete: (key: string, tasks: Task[]) => void;
  onSelectTask: (task: Task) => void;
}): JSX.Element {
  const repoKeys = collectTaskRepos(state);
  const [repoFilter, setRepoFilter] = useState<RepoFilter>(() => loadRepoFilter());
  const effectiveFilter = normalizeRepoFilter(repoFilter, repoKeys);
  const [searchQuery, setSearchQuery] = useState('');

  // Stale stored key (repo gone) → fall back to All and persist.
  useEffect(() => {
    if (effectiveFilter !== repoFilter) {
      setRepoFilter(effectiveFilter);
      saveRepoFilter(effectiveFilter);
    }
  }, [effectiveFilter, repoFilter]);

  const selectRepoFilter = (next: RepoFilter): void => {
    setRepoFilter(next);
    saveRepoFilter(next);
  };

  const allAwaitingMerge = collectAwaitingMergeTasks(state);
  const awaitingMerge = allAwaitingMerge.filter((t) =>
    matchesRepoFilter(t, effectiveFilter) && matchesTaskSearch(t, searchQuery),
  );
  // Unfiltered ids keep done+open-PR out of Done regardless of repo chip.
  const awaitingMergeIds = new Set(allAwaitingMerge.map((t) => t.id));

  let visibleCount = awaitingMerge.length;
  const sections = STATE_ORDER.map((s) => {
    // Hide done+open-PR from Done (shown in Awaiting merge above).
    // Failed/review with leftover PR stay in their real state section.
    const tasks = (state.byState[s] ?? []).filter(
      (t) =>
        !awaitingMergeIds.has(t.id) &&
        matchesRepoFilter(t, effectiveFilter) &&
        matchesTaskSearch(t, searchQuery),
    );
    visibleCount += tasks.length;
    return { state: s, tasks };
  });

  const showRepoFilter = repoKeys.length >= 2;

  return (
    <>
      <div className="task-search-wrap">
        <input
          type="search"
          className="task-search"
          data-evidence="task-search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t(lang, 'taskSearchPlaceholder')}
          aria-label={t(lang, 'taskSearchAria')}
        />
      </div>
      {showRepoFilter && (
        <div
          className="repo-filter"
          role="toolbar"
          aria-label={t(lang, 'repoFilterAria')}
          data-evidence="repo-filter"
        >
          <button
            type="button"
            className={`repo-filter-chip${effectiveFilter === null ? ' is-selected' : ''}`}
            data-evidence="repo-filter-all"
            aria-pressed={effectiveFilter === null}
            onClick={() => selectRepoFilter(null)}
          >
            {t(lang, 'repoFilterAll')}
          </button>
          {repoKeys.map((key) => {
            const selected = effectiveFilter === key;
            return (
              <button
                key={key}
                type="button"
                className={`repo-filter-chip${selected ? ' is-selected' : ''}`}
                data-evidence="repo-filter-chip"
                data-repo={key}
                aria-pressed={selected}
                onClick={() => selectRepoFilter(key)}
              >
                {key}
              </button>
            );
          })}
        </div>
      )}
      {awaitingMerge.length > 0 && (
        <section className="section-pr-open" key="pr-open">
          <div className="section-head-row">
            <h2 className="section-head section-head-pr">
              <span className="section-pr-dot" aria-hidden />
              {t(lang, 'sectionAwaitingMerge')}
              <span className="count count-pr">{awaitingMerge.length}</span>
            </h2>
            <SectionClearControl
              count={awaitingMerge.length}
              disabled={bulkPending !== null || pending !== null}
              loading={bulkPending === 'bulk:pr-open'}
              onConfirm={() => onBulkDelete('bulk:pr-open', awaitingMerge)}
            />
          </div>
          <p className="section-pr-hint muted">
            {t(lang, 'sectionAwaitingMergeHint')}
          </p>
          {awaitingMerge.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
              now={now}
              running={running.has(t.id)}
              agentLabel={effectiveAgent(t, state.repos, state.agents?.default ?? 'grok')}
              liveRun={state.liveRuns?.[t.id] ?? null}
              verificationRun={state.verificationRuns?.[t.id] ?? null}
              onTap={() => onSelectTask(t)}
            />
          ))}
        </section>
      )}
      {sections.map(({ state: s, tasks }) => {
        if (tasks.length === 0) return null;
        const isCollapsed = collapsed[s] === true;
        const showClear = canBulkDeleteState(s) && tasks.length > 0;
        return (
          <section key={s}>
            <div className="section-head-row">
              <h2 className="section-head" onClick={() => onToggleSection(s)}>
                <span className="caret">{isCollapsed ? '▸' : '▾'}</span>
                {stateLabel(lang, s)} <span className="count">{tasks.length}</span>
              </h2>
              {showClear && (
                <SectionClearControl
                  count={tasks.length}
                  disabled={bulkPending !== null || pending !== null}
                  loading={bulkPending === `bulk:${s}`}
                  onConfirm={() => onBulkDelete(`bulk:${s}`, tasks)}
                />
              )}
            </div>
            {!isCollapsed &&
              tasks.map((t) => (
                <TaskCard
                  key={t.id}
                  task={t}
                  now={now}
                  running={running.has(t.id)}
                  agentLabel={effectiveAgent(t, state.repos, state.agents?.default ?? 'grok')}
                  liveRun={state.liveRuns?.[t.id] ?? null}
                  verificationRun={state.verificationRuns?.[t.id] ?? null}
                  onTap={() => onSelectTask(t)}
                />
              ))}
          </section>
        );
      })}
      {searchQuery.trim().length === 0 &&
      showRepoFilter &&
      effectiveFilter !== null &&
      visibleCount === 0 && (
        <p className="muted repo-filter-empty" data-evidence="repo-filter-empty" role="status">
          {t(lang, 'repoFilterEmpty')}
        </p>
      )}
      {searchQuery.trim().length > 0 && visibleCount === 0 && (
        <p
          className="muted task-search-empty"
          data-evidence="task-search-empty"
          role="status"
        >
          {t(lang, 'taskSearchEmpty')}
        </p>
      )}
    </>
  );
}
