/**
 * Domain layer — the scheduling brain (SPEC §6, §7.4).
 *
 * Pure. Given the current set of tasks and what is already running, decide which
 * tasks to dispatch this tick, honoring the three eligibility rules and the two
 * counting caps (the heavy-validation semaphore is acquired later, inside a run,
 * not here). No IO, no clock — `now` is injected so this is deterministic.
 *
 * ## Selection policy (deterministic)
 *
 * 1. **Eligibility** — `todo` / `retrying` (after backoff), known repo, all
 *    `blocked_by` satisfied (done + gate-merge barrier when required), not
 *    already running.
 * 2. **Cost-aware priority** — optional additive weight for estimated-heaviness
 *    labels (`onboarding`, `readiness`). Effective priority =
 *    `priority + costWeight(labels)` (lower still wins). Ordinary tasks are
 *    unchanged (weight 0).
 * 3. **Repo fairness** — under a tight global cap, do not let one repo's queue
 *    monopolize slots. Admission repeatedly picks among repos still under their
 *    per-repo cap by **least current load** (running + already admitted this
 *    tick), then by effective priority, then by id. This is round-robin when
 *    loads are equal and anti-starvation when one repo is already busy.
 * 4. **Caps** — global and per-repo caps still hard-stop admission.
 */
import type { Task, TaskState } from './task.js';
import type { ReposConfig } from './repos.js';
import { parseNextEligibleMs } from './retryPolicy.js';
import { isAutonomousHostEligible } from './executionClass.js';
import {
  dependencyHolds,
  dependenciesSatisfiedForSchedule,
  resolveDependencyMode,
  type DependencyHold,
} from './dependencyGate.js';
import {
  adapterNeedsLocalWorkspace,
  resolveAdapterChain,
  type AdapterKind,
} from './agents.js';

export interface SchedulingState {
  readonly tasks: readonly Task[];
  readonly repos: ReposConfig;
  /** Task ids the daemon is currently running. */
  readonly runningTaskIds: ReadonlySet<string>;
  /**
   * Soft-blocked this tick (e.g. transient path-lease contention). Excluded
   * from candidates without consuming a running slot, so another eligible
   * task/repo can still fill remaining global capacity.
   */
  readonly excludeTaskIds?: ReadonlySet<string>;
  /**
   * Never-started tasks whose last dispatch failed while provisioning the
   * workspace (exact-head lease conflict, missing seed, clone error …). They
   * are held with exponential backoff instead of being re-tried every tick:
   * `fail()` cannot move a human-owned `todo` record, so each retry only
   * folded a stamped note into the body and committed — two control commits
   * per tick for two a downstream project tasks, 775 commits in one night (C3.49).
   */
  readonly provisionBackoff?: ReadonlyMap<string, ProvisionBackoff>;
  /**
   * C3.60: adapters whose process crashed on two different tasks in a row
   * (signal deaths). Their tasks hold instead of dispatching, so a broken or
   * auto-updated adapter binary cannot consume the queue one attempt at a time.
   */
  readonly adapterCrashHolds?: ReadonlyMap<AdapterKind, { readonly untilMs: number; readonly detail: string }>;
  /** Global concurrency cap (SPEC §6.1). */
  readonly globalCap: number;
  /**
   * Daemon default adapter. Used with task/repo overrides to decide whether a
   * task consumes the per-repo local-worktree cap. Default `grok`.
   */
  readonly defaultKind?: AdapterKind;
  /** Base for exponential retry backoff, ms (SPEC §7.6). */
  readonly backoffBaseMs: number;
  /** Current time, ms since epoch. */
  readonly now: number;
}

/**
 * Labels that mark a task as estimated-heavy (long readiness / onboarding
 * work). Matching is case-insensitive; presence of any one applies the weight
 * once (no stacking).
 */
export const HEAVY_TASK_LABELS: ReadonlySet<string> = new Set(['onboarding', 'readiness']);

/**
 * Additive priority penalty for heavy labels. Kept modest so a true
 * high-priority heavy task still beats low-priority light work, but equal
 * priority light work is preferred.
 */
export const HEAVY_COST_WEIGHT = 10;

/** Optional cost weight from heaviness labels; 0 when none apply. */
export function costWeight(labels: readonly string[]): number {
  for (const raw of labels) {
    if (HEAVY_TASK_LABELS.has(raw.trim().toLowerCase())) return HEAVY_COST_WEIGHT;
  }
  return 0;
}

/** Effective priority used for ordering (lower = more urgent). */
export function effectivePriority(task: Task): number {
  return task.priority + costWeight(task.labels);
}

/** Delay (ms) a retrying task must wait before becoming eligible again. */
export function backoffDelayMs(attempts: number, baseMs: number): number {
  const n = Math.max(0, attempts - 1);
  return baseMs * 2 ** n;
}

/**
 * Absolute time (ms) when a retrying task becomes eligible again.
 * Prefer an explicit body stamp (`Next eligible:`) when present.
 */
export function backoffUntilMs(task: Task, baseMs: number): number {
  const explicit = parseNextEligibleMs(task.body);
  if (explicit !== null) return explicit;
  if (task.lastEventAt === null) return 0;
  const since = Date.parse(task.lastEventAt);
  if (Number.isNaN(since)) return 0; // unparseable timestamp ⇒ don't wedge the task
  return since + backoffDelayMs(task.attempts, baseMs);
}

function backoffElapsed(task: Task, now: number, baseMs: number): boolean {
  return now >= backoffUntilMs(task, baseMs);
}

/** First reason a todo/retrying task is not admitted by {@link selectEligible}. */
export type SchedulingHoldReason =
  | { readonly code: 'plan_pending' }
  | { readonly code: 'host_approval_pending' }
  | { readonly code: 'already_running' }
  | { readonly code: 'excluded' }
  | { readonly code: 'unknown_repo' }
  | { readonly code: 'repo_readiness_incomplete'; readonly repo: string }
  | { readonly code: 'dependency_gate_merge'; readonly waitingOn: readonly string[] }
  | { readonly code: 'dependency_completion'; readonly waitingOn: readonly string[] }
  | { readonly code: 'retry_backoff'; readonly untilMs: number }
  | { readonly code: 'provision_failed'; readonly untilMs: number; readonly detail: string }
  | {
      readonly code: 'adapter_crashing';
      readonly adapter: string;
      readonly untilMs: number;
      readonly detail: string;
    }
  | { readonly code: 'capacity'; readonly scope: 'global' | 'repo'; readonly repo?: string };

/** One never-started task's provisioning failures (C3.49). */
export interface ProvisionBackoff {
  readonly untilMs: number;
  readonly detail: string;
  readonly failures: number;
}

export const PROVISION_BACKOFF_BASE_MS = 5 * 60_000;
export const PROVISION_BACKOFF_MAX_MS = 60 * 60_000;

/** Exponential: 5 → 10 → 20 → 40 → 60 min (capped). */
export function provisionBackoffMs(failures: number): number {
  const exp = Math.min(PROVISION_BACKOFF_MAX_MS, PROVISION_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
  return Math.max(PROVISION_BACKOFF_BASE_MS, Math.min(PROVISION_BACKOFF_MAX_MS, exp));
}

/** G8: incomplete repos only accept onboarding/readiness labelled work. */
export function isRepoReadinessEligible(task: Task, repos: ReposConfig): boolean {
  const repo = repos.repos[task.repo];
  if (!repo || repo.readiness !== 'incomplete') return true;
  return task.labels.some((l) => {
    const x = l.trim().toLowerCase();
    return x === 'onboarding' || x === 'readiness';
  });
}

/** Log / stderr detail fragment after the hold code. */
export function formatSchedulingHoldDetail(reason: SchedulingHoldReason): string {
  switch (reason.code) {
    case 'plan_pending':
      return 'waiting for human Approve plan';
    case 'host_approval_pending':
      return 'host_operation/deploy needs human approval + command scope';
    case 'already_running':
      return 'task id is already in the running set';
    case 'excluded':
      return 'soft-excluded this tick';
    case 'unknown_repo':
      return 'repo not present in repos.yaml';
    case 'repo_readiness_incomplete':
      return (
        `repo=${reason.repo} — only onboarding/readiness-labelled tasks ` +
        'dispatch on an incomplete repo'
      );
    case 'dependency_gate_merge':
      return `waitingOn=${reason.waitingOn.join(',')} (gate_merge)`;
    case 'dependency_completion':
      return `waitingOn=${reason.waitingOn.join(',')} (completion_only)`;
    case 'retry_backoff':
      return `untilMs=${reason.untilMs}`;
    case 'provision_failed':
      return `untilMs=${reason.untilMs} — ${reason.detail}`;
    case 'adapter_crashing':
      return `adapter=${reason.adapter} untilMs=${reason.untilMs} — ${reason.detail}`;
    case 'capacity':
      return reason.scope === 'repo'
        ? `scope=repo repo=${reason.repo ?? ''}`
        : 'scope=global';
  }
}

/** Structural equality for hold transition logging. */
export function schedulingHoldEquals(
  a: SchedulingHoldReason,
  b: SchedulingHoldReason,
): boolean {
  if (a.code !== b.code) return false;
  switch (a.code) {
    case 'repo_readiness_incomplete':
      return a.repo === (b as typeof a).repo;
    case 'dependency_gate_merge':
    case 'dependency_completion': {
      const other = b as typeof a;
      if (a.waitingOn.length !== other.waitingOn.length) return false;
      return a.waitingOn.every((id, i) => id === other.waitingOn[i]);
    }
    case 'retry_backoff':
      return a.untilMs === (b as typeof a).untilMs;
    case 'capacity': {
      const other = b as typeof a;
      return a.scope === other.scope && a.repo === other.repo;
    }
    default:
      return true;
  }
}

function capacityHold(
  scope: 'global' | 'repo',
  repo?: string,
): SchedulingHoldReason {
  if (scope === 'repo') {
    return { code: 'capacity', scope: 'repo', repo: repo ?? '' };
  }
  return { code: 'capacity', scope: 'global' };
}

/**
 * For every todo/retrying task NOT admitted by {@link selectEligible}, the
 * first failing reason in filter order (shared predicates — cannot drift).
 */
export function explainIneligible(
  state: SchedulingState,
): ReadonlyMap<string, SchedulingHoldReason> {
  const { tasks, repos, runningTaskIds, backoffBaseMs, now } = state;
  const defaultKind = state.defaultKind ?? 'grok';
  const excludeTaskIds = state.excludeTaskIds ?? new Set<string>();
  const admittedIds = new Set(selectEligible(state).map((t) => t.id));

  // Post-admission provisional load for capacity scope (same counting as select).
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const repoRunning = new Map<string, number>();
  for (const id of runningTaskIds) {
    const t = taskById.get(id);
    if (!t) continue;
    if (usesLocalRepoSlot(t, repos, defaultKind)) {
      repoRunning.set(t.repo, (repoRunning.get(t.repo) ?? 0) + 1);
    }
  }
  const provisional = new Map(repoRunning);
  for (const id of admittedIds) {
    const t = taskById.get(id);
    if (!t) continue;
    if (usesLocalRepoSlot(t, repos, defaultKind)) {
      provisional.set(t.repo, (provisional.get(t.repo) ?? 0) + 1);
    }
  }

  const out = new Map<string, SchedulingHoldReason>();
  for (const t of tasks) {
    if (t.state !== 'todo' && t.state !== 'retrying') continue;
    if (admittedIds.has(t.id)) continue;

    // Filter order matches selectEligible candidate chain.
    if (t.planPending) {
      out.set(t.id, { code: 'plan_pending' });
      continue;
    }
    if (!isAutonomousHostEligible(t)) {
      out.set(t.id, { code: 'host_approval_pending' });
      continue;
    }
    if (runningTaskIds.has(t.id)) {
      out.set(t.id, { code: 'already_running' });
      continue;
    }
    if (excludeTaskIds.has(t.id)) {
      out.set(t.id, { code: 'excluded' });
      continue;
    }
    const provision = state.provisionBackoff?.get(t.id);
    const crashHold = state.adapterCrashHolds?.get(resolvedDispatchKind(t, repos, defaultKind));
    if (crashHold !== undefined && crashHold.untilMs > now) {
      out.set(t.id, {
        code: 'adapter_crashing',
        adapter: resolvedDispatchKind(t, repos, defaultKind),
        untilMs: crashHold.untilMs,
        detail: crashHold.detail,
      });
      continue;
    }
    if (provision !== undefined && provision.untilMs > now) {
      out.set(t.id, { code: 'provision_failed', untilMs: provision.untilMs, detail: provision.detail });
      continue;
    }
    if (!(t.repo in repos.repos)) {
      out.set(t.id, { code: 'unknown_repo' });
      continue;
    }
    if (!isRepoReadinessEligible(t, repos)) {
      out.set(t.id, { code: 'repo_readiness_incomplete', repo: t.repo });
      continue;
    }
    if (!dependenciesSatisfiedForSchedule(t, tasks)) {
      const holds = dependencyHolds(t, tasks);
      const waitingOn = holds.map((h) => h.id);
      let gateMerge = false;
      for (const h of holds) {
        if (h.kind === 'awaiting_merge') {
          gateMerge = true;
          break;
        }
        const dep = taskById.get(h.id);
        if (dep) {
          if (resolveDependencyMode(t, dep) === 'gate_merge') {
            gateMerge = true;
            break;
          }
        } else if (resolveDependencyMode(t, { repo: t.repo }) === 'gate_merge') {
          gateMerge = true;
          break;
        }
      }
      out.set(t.id, {
        code: gateMerge ? 'dependency_gate_merge' : 'dependency_completion',
        waitingOn,
      });
      continue;
    }
    if (t.state === 'retrying' && !backoffElapsed(t, now, backoffBaseMs)) {
      out.set(t.id, { code: 'retry_backoff', untilMs: backoffUntilMs(t, backoffBaseMs) });
      continue;
    }

    const usesRepoSlot = usesLocalRepoSlot(t, repos, defaultKind);
    const cap = repos.repos[t.repo]?.maxConcurrent ?? 0;
    const used = provisional.get(t.repo) ?? 0;
    if (usesRepoSlot && used >= cap) {
      out.set(t.id, capacityHold('repo', t.repo));
    } else {
      out.set(t.id, capacityHold('global'));
    }
  }
  return out;
}

/**
 * Dependencies that will never self-heal: failed/cancelled/deleted or missing
 * entirely. The task is held; the phone shows WHY so the human can retry the
 * dependency or edit blocked_by (vacuous-satisfaction fix, 2026-07-22).
 */
export function brokenDependencies(
  task: Task,
  tasks: readonly Task[],
): readonly { id: string; state: TaskState | 'missing' }[] {
  return dependencyHolds(task, tasks)
    .filter((h) => h.kind === 'broken')
    .map((h) => ({ id: h.id, state: h.state }));
}

/**
 * Healthy-but-unfinished dependencies (todo/in_progress/retrying/review):
 * the task is simply WAITING, not broken — the phone shows a neutral
 * "starts automatically after X" hint instead of an unexplained QUEUED.
 */
export function pendingDependencies(
  task: Task,
  tasks: readonly Task[],
): readonly { id: string; state: TaskState }[] {
  return dependencyHolds(task, tasks)
    .filter((h) => h.kind === 'pending')
    .map((h) => ({ id: h.id, state: h.state as TaskState }));
}

/**
 * Upstream is done/approved but the gate-merge barrier still holds this task
 * (Merge Selected, provenance, or ancestry). Phone shows concise remediation.
 */
export function mergeBlockedDependencies(
  task: Task,
  tasks: readonly Task[],
): readonly DependencyHold[] {
  return dependencyHolds(task, tasks).filter((h) => h.kind === 'awaiting_merge');
}

function resolvedDispatchKind(
  task: Task,
  repos: ReposConfig,
  defaultKind: AdapterKind,
): AdapterKind {
  return resolveAdapterChain({
    taskAdapter: task.adapter,
    repoAdapter: repos.repos[task.repo]?.adapter ?? null,
    defaultKind,
  });
}

function usesLocalRepoSlot(
  task: Task,
  repos: ReposConfig,
  defaultKind: AdapterKind,
): boolean {
  return adapterNeedsLocalWorkspace(resolvedDispatchKind(task, repos, defaultKind));
}

export function selectEligible(state: SchedulingState): Task[] {
  const { tasks, repos, runningTaskIds, globalCap, backoffBaseMs, now } = state;
  const defaultKind = state.defaultKind ?? 'grok';
  const excludeTaskIds = state.excludeTaskIds ?? new Set<string>();

  // Dependencies are mode-aware: success alone is not enough for same-repo
  // code consumers (gate-merge barrier). "Terminal" once included
  // failed/cancelled — R2 parked failed and vacuously green-lit R3 (2026-07-22).
  // Approve-before-Merge must not unlock implement dependents either.
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  // Count what is already running, globally and per repo.
  // Remote cursor factory tasks count toward the global cap only — they do
  // not occupy a local worktree / port / path-lease writer slot.
  let globalRunning = 0;
  const repoRunning = new Map<string, number>();
  for (const id of runningTaskIds) {
    const t = taskById.get(id);
    if (!t) continue;
    globalRunning += 1;
    if (usesLocalRepoSlot(t, repos, defaultKind)) {
      repoRunning.set(t.repo, (repoRunning.get(t.repo) ?? 0) + 1);
    }
  }

  const candidates = tasks
    .filter((t) => t.state === 'todo' || t.state === 'retrying')
    // G5: plan drafts wait for human "Approve plan" before any agent runs.
    .filter((t) => !t.planPending)
    // P0: host_operation / deploy wait for human approval + command scope.
    .filter((t) => isAutonomousHostEligible(t))
    .filter((t) => !runningTaskIds.has(t.id))
    .filter((t) => !excludeTaskIds.has(t.id))
    // C3.49: provisioning failed recently — held with exponential backoff.
    .filter((t) => {
      const provision = state.provisionBackoff?.get(t.id);
      return provision === undefined || provision.untilMs <= now;
    })
    // C3.60: the adapter process itself is crashing — dispatching only burns
    // attempts and parks tasks for thrash until a human notices.
    .filter((t) => {
      const hold = state.adapterCrashHolds?.get(resolvedDispatchKind(t, repos, defaultKind));
      return hold === undefined || hold.untilMs <= now;
    })
    .filter((t) => t.repo in repos.repos)
    // G8: incomplete repos only accept onboarding/readiness labeled work.
    .filter((t) => isRepoReadinessEligible(t, repos))
    .filter((t) => dependenciesSatisfiedForSchedule(t, tasks))
    .filter((t) => t.state === 'todo' || backoffElapsed(t, now, backoffBaseMs));

  const admitted: Task[] = [];
  let globalRemaining = globalCap - globalRunning;
  const provisional = new Map(repoRunning);
  const remaining = new Set(candidates);

  while (globalRemaining > 0 && remaining.size > 0) {
    let best: Task | null = null;
    let bestLoad = 0;
    let bestEff = 0;

    for (const t of remaining) {
      const usesRepoSlot = usesLocalRepoSlot(t, repos, defaultKind);
      const cap = repos.repos[t.repo]?.maxConcurrent ?? 0;
      const used = provisional.get(t.repo) ?? 0;
      if (usesRepoSlot && used >= cap) continue;

      const load = usesRepoSlot ? used : 0;
      const eff = effectivePriority(t);
      if (
        best === null ||
        load < bestLoad ||
        (load === bestLoad && eff < bestEff) ||
        (load === bestLoad && eff === bestEff && t.id.localeCompare(best.id) < 0)
      ) {
        best = t;
        bestLoad = load;
        bestEff = eff;
      }
    }

    if (best === null) break; // every remaining candidate is over its repo cap

    admitted.push(best);
    remaining.delete(best);
    globalRemaining -= 1;
    if (usesLocalRepoSlot(best, repos, defaultKind)) {
      provisional.set(best.repo, (provisional.get(best.repo) ?? 0) + 1);
    }
  }

  return admitted;
}
