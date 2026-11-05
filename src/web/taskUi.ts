/**
 * Shared pure helpers for task list / detail UI (no React).
 */
import type {
  LiveRunMeta,
  RemoteSession,
  RepoDto,
  StateDto,
  Task,
  TaskState,
  VerificationRunMeta,
} from './api.js';
import { compareTasksByLastActivityDesc, isAwaitingMerge } from '../domain/task.js';
import type { Lang } from './prefs.js';
import { t } from './i18n.js';

// Deleted is trash awaiting purge — expanded-by-default probe noise buried
// the useful sections on the phone (visual audit 2026-07-23).
export const DEFAULT_COLLAPSED: Partial<Record<TaskState, boolean>> = {
  done: true,
  cancelled: true,
  deleted: true,
};
export const COLLAPSE_KEY = 'hercules_collapsed';

export function loadCollapsed(): Partial<Record<TaskState, boolean>> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    return raw ? { ...DEFAULT_COLLAPSED, ...(JSON.parse(raw) as Record<string, boolean>) } : { ...DEFAULT_COLLAPSED };
  } catch {
    return { ...DEFAULT_COLLAPSED };
  }
}

/**
 * Task-list repo filter: null = All repos. Stored on-device like collapse prefs.
 * Only valid identifier keys are accepted (same charset as domain ids).
 */
export type RepoFilter = string | null;
export const REPO_FILTER_KEY = 'hercules_repo_filter';
const REPO_FILTER_IDENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function loadRepoFilter(): RepoFilter {
  try {
    const raw = localStorage.getItem(REPO_FILTER_KEY);
    if (raw === null || raw === '') return null;
    if (!REPO_FILTER_IDENT.test(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveRepoFilter(filter: RepoFilter): void {
  try {
    if (filter === null || filter === '' || !REPO_FILTER_IDENT.test(filter)) {
      localStorage.removeItem(REPO_FILTER_KEY);
      return;
    }
    localStorage.setItem(REPO_FILTER_KEY, filter);
  } catch {
    /* ignore quota / private mode */
  }
}

/** Sorted unique repo keys that currently have at least one task. */
export function collectTaskRepos(state: StateDto): string[] {
  const set = new Set<string>();
  for (const list of Object.values(state.byState)) {
    for (const t of list) {
      if (t.repo) set.add(t.repo);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** null filter = show every task; otherwise exact repo key match. */
export function matchesRepoFilter(task: Task, filter: RepoFilter): boolean {
  if (filter === null) return true;
  return task.repo === filter;
}

/**
 * Drop a stale stored filter when that repo no longer appears in the list.
 * Keeps the chip bar honest after tasks are deleted or purged.
 */
export function normalizeRepoFilter(
  filter: RepoFilter,
  available: readonly string[],
): RepoFilter {
  if (filter === null) return null;
  return available.includes(filter) ? filter : null;
}

/** Case-insensitive id/title/repo/labels match; empty query matches all. */
export function matchesTaskSearch(task: Task, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  if (task.id.toLowerCase().includes(q)) return true;
  if (task.title.toLowerCase().includes(q)) return true;
  if (task.repo.toLowerCase().includes(q)) return true;
  for (const label of task.labels) {
    if (label.toLowerCase().includes(q)) return true;
  }
  return false;
}

// Review first — it's what needs the human. Then active, queued, terminal.
export const STATE_ORDER: TaskState[] = [
  'review',
  'in_progress',
  'retrying',
  'todo',
  'failed',
  'done',
  'cancelled',
  'deleted',
];

export const STATE_LABEL: Record<TaskState, string> = {
  review: 'Needs review',
  in_progress: 'Running',
  retrying: 'Retrying',
  todo: 'Queued',
  failed: 'Failed',
  done: 'Done',
  cancelled: 'Cancelled',
  deleted: 'Deleted',
};

export function stateLabel(lang: Lang, s: TaskState): string {
  switch (s) {
    case 'review':
      return t(lang, 'stateReview');
    case 'in_progress':
      return t(lang, 'stateRunning');
    case 'retrying':
      return t(lang, 'stateRetrying');
    case 'todo':
      return t(lang, 'stateQueued');
    case 'failed':
      return t(lang, 'stateFailed');
    case 'done':
      return t(lang, 'stateDone');
    case 'cancelled':
      return t(lang, 'stateCancelled');
    case 'deleted':
      return t(lang, 'stateDeleted');
  }
}

/** States that allow "clear this kind" bulk delete from the list (not live runs). */
export function canBulkDeleteState(s: TaskState): boolean {
  return s !== 'in_progress' && s !== 'retrying';
}

/**
 * "Awaiting merge" = done + open PR only.
 * Failed salvage with a leftover PR must stay under Failed (not 等待合并).
 */
export function collectAwaitingMergeTasks(state: StateDto): Task[] {
  const out: Task[] = [];
  for (const list of Object.values(state.byState)) {
    for (const t of list) {
      if (isAwaitingMerge(t)) out.push(t);
    }
  }
  return out.sort(compareTasksByLastActivityDesc);
}

/**
 * The original task description, without the sections the daemon appends after a
 * run (the review packet, the teardown report) — so cloning a finished task
 * starts a fresh instance from the task as it was written, not its results.
 */
export function originalDescription(body: string): string {
  const at = body.search(/\n#{1,6}\s+(Review packet|Teardown)\b/i);
  return (at === -1 ? body : body.slice(0, at)).trim();
}

/** Match daemon packet copy for no-change / read-only runs (no branch to PR). */
export function looksNoChange(body: string): boolean {
  return /\*\*ℹ️ No file changes\.\*\*|No file changes\./i.test(body);
}

/**
 * Prefer API `openUrl` (login?return_to=…); else wrap bare github.com PR URLs so
 * private repos don't show anonymous 404.
 */
export function githubOpenHref(pr: { url: string; openUrl?: string }): string {
  if (pr.openUrl && /^https:\/\/github\.com\//i.test(pr.openUrl)) return pr.openUrl;
  if (!/^https:\/\/github\.com\//i.test(pr.url)) return pr.url;
  if (/^https:\/\/github\.com\/login(?:\?|$)/i.test(pr.url)) return pr.url;
  return `https://github.com/login?return_to=${encodeURIComponent(pr.url)}`;
}

/** Synthetic <a> click — only https://github.com/… */
export function openGithub(url: string): void {
  if (!/^https:\/\/github\.com\//i.test(url)) {
    console.error('[hercules] refusing non-GitHub URL', url);
    return;
  }
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export const parseMs = (s: string | null): number | null => (s ? Date.parse(s) : null);

/** "2h 5m" / "4m 20s" / "45s". */
export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** A compact "running 4m" / "ran 4m20s" / "queued" string for a card. */
export function shortTiming(
  task: Task,
  now: number,
  live?: LiveRunMeta | null,
  verify?: VerificationRunMeta | null,
): string | null {
  const started = parseMs(task.startedAt);
  const ended = parseMs(task.endedAt);
  // Live verification overlay wins even if disk already says cancelled
  // (cancel-while-verifying race — keep the card honest until abort finishes).
  const verifyLabel = verificationStatusLabel(verify ?? null);
  if (verifyLabel) return verifyLabel;
  if (task.state === 'in_progress' && started !== null) {
    // Deterministic host executor: index/name + elapsed/timeout (no secrets).
    if (live?.hostCommandTotal && live.hostCommandTotal > 0) {
      const idx = live.hostCommandIndex ?? 0;
      // Bound name so the card never overflows on long paths.
      const rawName = live.hostCommandName?.trim() ?? '';
      const name =
        rawName.length === 0
          ? ''
          : rawName.length > 28
            ? `${rawName.slice(0, 27)}…`
            : rawName;
      const runMs = live.runMs ?? now - started;
      const timeoutMs = live.hostCommandTimeoutMs;
      const label = name
        ? `host ${idx}/${live.hostCommandTotal} ${name}`
        : `host ${idx}/${live.hostCommandTotal}`;
      const timeoutBit =
        typeof timeoutMs === 'number' && timeoutMs > 0
          ? ` / ${fmtDur(timeoutMs)}`
          : '';
      return `${label} · ${fmtDur(runMs)}${timeoutBit}`;
    }
    // Prefer live honesty: quiet + worker name beats opaque "running 45m".
    if (live?.processAlive === true && (live.silenceMs ?? 0) >= 30_000) {
      const quiet = fmtDur(live.silenceMs ?? 0);
      const hint = live.aliveHint?.trim();
      return hint ? `quiet ${quiet} · ${hint}` : `quiet ${quiet}`;
    }
    const runMs = live?.runMs ?? now - started;
    return `running ${fmtDur(runMs)}`;
  }
  if (started !== null && ended !== null) {
    const ran = ended - started;
    // started/ended can straddle park/retry cycles — "ran 19h 40m" is
    // bookkeeping garbage (hard-kill is 2h). Beyond 4h, omit.
    if (ran > 0 && ran <= 4 * 3600_000) return `ran ${fmtDur(ran)}`;
    return task.state === 'todo' ? 'queued' : null;
  }
  if (task.state === 'todo' && parseMs(task.createdAt) !== null) return 'queued';
  return null;
}

/** Live panel pill: LIVE vs QUIET (process alive, stream silent). */
export function liveStatusPill(live: LiveRunMeta | null | undefined): {
  label: string;
  className: string;
} {
  if (live?.processAlive === true && (live.silenceMs ?? 0) >= 30_000) {
    const hint = live.aliveHint?.trim();
    const quiet = fmtDur(live.silenceMs ?? 0);
    return {
      label: hint ? `● QUIET ${quiet} · ${hint}` : `● QUIET ${quiet}`,
      className: 'pill pill-quiet',
    };
  }
  return { label: '● LIVE', className: 'pill pill-live' };
}

/**
 * Phone honesty: distinguish agent-running from post-agent verification.
 * Prefer verificationRuns stage over opaque "running".
 */
export function verificationStatusLabel(
  verify: VerificationRunMeta | null | undefined,
): string | null {
  if (!verify) return null;
  const stage = verify.stage?.trim() || verify.phase;
  return `verifying: ${stage}`;
}

/** Live pill when a verification run is active. */
export function verifyStatusPill(verify: VerificationRunMeta | null | undefined): {
  label: string;
  className: string;
} | null {
  if (!verify) return null;
  const stage = verify.stage?.trim() || verify.phase;
  if (verify.cancelRequested) {
    return {
      label: `● STOPPING VERIFY · ${stage}`,
      className: 'pill pill-quiet',
    };
  }
  return {
    label: `● VERIFYING · ${stage}`,
    className: 'pill pill-live',
  };
}

/** Optimistically move a task into its new state group (instant UI; SSE reconciles). */
export function moveTask(state: StateDto, task: Task): StateDto {
  const byState = Object.fromEntries(
    Object.entries(state.byState).map(([s, list]) => [s, list.filter((t) => t.id !== task.id)]),
  ) as StateDto['byState'];
  const nextList = [...(byState[task.state] ?? []), task];
  nextList.sort(compareTasksByLastActivityDesc);
  byState[task.state] = nextList;
  return { ...state, byState };
}

/** Optimistically drop a task from every group (for delete). */
export function dropTask(state: StateDto, id: string): StateDto {
  const byState = Object.fromEntries(
    Object.entries(state.byState).map(([s, list]) => [s, list.filter((t) => t.id !== id)]),
  ) as StateDto['byState'];
  return { ...state, byState };
}

/** Upsert a Remote Control session after openTaskLive / send (SSE may lag a beat). */
export function upsertSession(state: StateDto, session: RemoteSession): StateDto {
  const list = state.sessions ?? [];
  const i = list.findIndex((s) => s.id === session.id);
  const sessions =
    i >= 0 ? list.map((s, idx) => (idx === i ? session : s)) : [session, ...list];
  return { ...state, sessions };
}

export function allTasksFromState(state: StateDto | null): Task[] {
  if (!state) return [];
  return Object.values(state.byState).flat();
}

export function effectiveAgent(
  task: Task,
  repos: readonly RepoDto[],
  daemonDefault: string,
): string {
  if (task.adapter) return task.adapter;
  const r = repos.find((x) => x.key === task.repo);
  return r?.effectiveAdapter ?? daemonDefault;
}

/** Days left in Deleted trash before hard purge (matches daemon 30d retention). */
const AUTO_DELETE_MS = 30 * 24 * 60 * 60 * 1000;

export function autoDeleteMeta(task: Task, now: number): string | null {
  if (task.state !== 'deleted') return null;
  const iso = task.endedAt ?? task.lastEventAt ?? task.createdAt;
  if (!iso) return null;
  const anchor = Date.parse(iso);
  if (!Number.isFinite(anchor)) return null;
  const left = AUTO_DELETE_MS - (now - anchor);
  if (left <= 0) return 'purge soon';
  const days = Math.max(1, Math.ceil(left / 86_400_000));
  return `purge ${days}d`;
}
