/**
 * Presentation layer — serialize the runtime view into the DTO the UI consumes
 * (SPEC §14). Pure: same input → same output, so it is trivially testable and
 * safe to send over both /api/state and the SSE stream.
 */
import { groupByState } from '../control/snapshot.js';
import { redactUrl } from '../control/reposConfig.js';
import {
  effectiveRepoExecutionPolicy,
  policyDiagnostics,
} from '../domain/repoExecutionPolicy.js';
import { isAdapterKind, resolveAdapterKind, type AdapterKind } from '../domain/agents.js';
import { TASK_STATES, type Task, type TaskState } from '../domain/task.js';
import type { SnapshotProblem } from '../control/snapshot.js';
import type { RuntimeView, TickReport } from '../orchestrator/orchestrator.js';
import type { RemoteSession } from '../domain/session.js';
import { resolveBuildInfo, type BuildInfo } from '../buildInfo.js';
import {
  DEFAULT_COST_CAPS,
  costMeaningForMode,
  zeroUsage,
  type CostCapSummary,
} from '../domain/costCaps.js';
import type { DiskPressure, DispatchHold } from '../domain/diskPressure.js';
import { toDiskWarnDetail } from '../domain/diskPressure.js';
import type { SchedulingHoldReason } from '../domain/scheduling.js';
import type { AdapterFailoverNotice } from '../orchestrator/orchestrator.js';
import {
  redactVerificationStage,
  type VerificationPhase,
  type VerificationRunMeta,
} from '../domain/verificationRun.js';
import type { ReviewerProviderHealth } from '../domain/reviewerInfrastructure.js';
import type { AutoMergePolicy } from '../domain/autoMerge.js';
import { planPendingReasonFor } from '../domain/acceptance.js';

export interface RepoDto {
  readonly key: string;
  readonly url: string;
  readonly defaultBranch: string;
  readonly workflow: string;
  readonly maxConcurrent: number;
  /** Explicit override from repos.yaml, or null to inherit daemon default. */
  readonly adapter: AdapterKind | null;
  /** What would actually run (override or default). */
  readonly effectiveAdapter: AdapterKind;
  /** ready | incomplete — incomplete only dispatches onboarding tasks. */
  readonly readiness: 'ready' | 'incomplete';
  /**
   * Effective execution policy (names/structure only — never secret values).
   * Compatible defaults when repos.yaml omits execution_policy.
   */
  readonly executionPolicy: ReturnType<typeof policyDiagnostics>;
  /** Per-repo auto-merge pilot policy, or null when unset/off. */
  readonly autoMerge: AutoMergePolicy | null;
}

export interface AgentsDto {
  readonly default: string;
  readonly available: readonly string[];
  readonly providerPolicy?: {
    readonly codex: { readonly model: string; readonly reasoningEffort: string };
    readonly claudeEnabled: boolean;
  };
}

export interface StateDto {
  /**
   * Strictly increasing per serialization (clock-based, restart-safe).
   * Clients drop full snapshots whose seq is lower than the last applied —
   * a slow GET racing an optimistic mutation must not roll the UI back.
   */
  readonly seq: number;
  /** False until the first tick has built a snapshot. */
  readonly ready: boolean;
  readonly running: string[];
  /** Cancelled tasks winding down (Plan 2a). */
  readonly stopping: string[];
  readonly repos: readonly RepoDto[];
  readonly problems: SnapshotProblem[];
  readonly byState: Record<TaskState, Task[]>;
  /** Recent activity lines per task id (live log, Task 1/2/3). */
  readonly activity: Record<string, string[]>;
  /** Remote Control: human messages queued while a task is running. */
  readonly pendingChat: Record<string, string[]>;
  readonly lastReport: TickReport | null;
  /** Daemon agent registry (default + available kinds). */
  readonly agents: AgentsDto;
  /** Free Remote Control sessions. */
  readonly sessions: readonly RemoteSession[];
  /** Live activity for free sessions. */
  readonly sessionActivity: Record<string, string[]>;
  /**
   * Mid-run overlay (session / last event / tip) — disk task files lag.
   */
  readonly liveRuns: Record<
    string,
    {
      taskId: string;
      sessionId: string | null;
      lastEventAt: string;
      branchTip: string | null;
      runKind: 'implementer' | 'steer';
      activityLines: number;
      processAlive: boolean;
      silenceMs: number;
      runMs: number;
      maxRunMs: number;
      aliveHint: string | null;
      hostCommandIndex?: number;
      hostCommandTotal?: number;
      hostCommandName?: string | null;
      hostCommandTimeoutMs?: number;
    }
  >;
  /**
   * Bounded live verification overlay (phase/stage only — no command secrets
   * or unbounded gate output). Empty when no task is verifying.
   */
  readonly verificationRuns: Record<string, VerificationRunMeta>;
  /**
   * Deploy stamp from the Node process. Compare with the SPA's
   * baked-in `__APP_VERSION__` to catch stale UI cache vs new daemon.
   */
  readonly build: BuildInfo;
  /** Token/cost caps (Settings summary). Always present; enabled false when off. */
  readonly costSummary: CostCapSummary;
  /**
   * Why dispatch is paused. Null when agents may start.
   * Phone red banner + decision-inbox system item.
   */
  readonly dispatchHold: DispatchHold | null;
  /**
   * Amber hint when disk is warn-only (no pause). Null when ok or critical
   * (critical is covered by dispatchHold).
   */
  readonly diskWarn: string | null;
  /** Latest disk pressure reading (ok/warn/critical) or null if unknown. */
  readonly diskPressure: DiskPressure | null;
  /**
   * Provider failover active (some adapter unhealthy in the window).
   * Decision-inbox system item. Null when healthy or failover disabled.
   */
  readonly adapterFailover: AdapterFailoverNotice | null;
  /** Redacted reviewer-provider recovery state; never includes host paths. */
  readonly reviewerHealth: readonly ReviewerProviderHealth[];
  /**
   * Per-task scheduling holds (todo/retrying not admitted). Empty object when
   * none; keys are task ids. May briefly retain entries after cancel/done until
   * the next tick — consumers must ignore holds unless the task's current state
   * is `todo` or `retrying` (GET /api/tasks/:id already nulls non-queued).
   */
  readonly holds: Readonly<Record<string, SchedulingHoldReason>>;
}

function emptyCostSummary(): CostCapSummary {
  return {
    enabled: false,
    level: 'ok',
    day: zeroUsage(),
    taskTotals: {},
    breaches: [],
    reasons: [],
    policy: DEFAULT_COST_CAPS,
    billingMode: DEFAULT_COST_CAPS.billingMode,
    billingModeNote: DEFAULT_COST_CAPS.billingModeNote,
    costMeaning: costMeaningForMode(DEFAULT_COST_CAPS.billingMode),
  };
}

function emptyGroups(): Record<TaskState, Task[]> {
  return Object.fromEntries(TASK_STATES.map((s) => [s, [] as Task[]])) as Record<TaskState, Task[]>;
}

function copyActivity(activity: Record<string, readonly string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(activity).map(([k, v]) => [k, [...v]]));
}

// Clock-based so it stays monotonic across daemon restarts; the +1 branch
// keeps it strictly increasing within one millisecond.
let lastStateSeq = 0;
function nextStateSeq(): number {
  const now = Date.now();
  lastStateSeq = now > lastStateSeq ? now : lastStateSeq + 1;
  return lastStateSeq;
}

export function serializeState(view: RuntimeView): StateDto {
  const seq = nextStateSeq();
  const defaultKind: AdapterKind = isAdapterKind(view.agents.default)
    ? view.agents.default
    : 'grok';
  const agentsDto = {
    default: view.agents.default,
    available: [...view.agents.available],
    ...(view.agents.providerPolicy ? { providerPolicy: view.agents.providerPolicy } : {}),
  };
  const pendingChat = Object.fromEntries(
    Object.entries(view.pendingChat ?? {}).map(([k, v]) => [k, [...v]]),
  );
  const sessions = view.sessions
    ? view.sessions.map(redactRemoteSessionProviderSession)
    : [];
  const sessionActivity = copyActivity(view.sessionActivity ?? {});
  const build = resolveBuildInfo();

  const liveRuns = Object.fromEntries(
    Object.entries(view.liveRuns ?? {}).map(([k, v]) => [k, { ...v, sessionId: null }]),
  );
  const verificationRuns = serializeVerificationRuns(view.verificationRuns ?? {});
  const costSummary = view.costSummary ?? emptyCostSummary();
  const diskPressure = view.diskPressure ?? null;
  const dispatchHold = view.dispatchHold ?? null;
  const diskWarn = toDiskWarnDetail(diskPressure, {
    pruneNote: view.diskPruneNote ?? null,
  });
  const adapterFailover = view.adapterFailover ?? null;
  const reviewerHealth = (view.reviewerHealth ?? []).map((health) => ({ ...health }));
  const holds = { ...(view.holds ?? {}) };

  if (!view.snapshot) {
    return {
      seq,
      ready: false,
      running: [...view.running],
      stopping: [...view.stopping],
      repos: [],
      problems: [],
      byState: emptyGroups(),
      activity: copyActivity(view.activity),
      pendingChat,
      liveRuns,
      verificationRuns,
      lastReport: view.lastReport,
      agents: agentsDto,
      sessions,
      sessionActivity,
      build,
      costSummary,
      dispatchHold,
      diskWarn,
      diskPressure,
      adapterFailover,
      reviewerHealth,
      holds,
    };
  }
  return {
    seq,
    ready: true,
    running: [...view.running],
    stopping: [...view.stopping],
    repos: Object.values(view.snapshot.repos.repos)
      .map((r) => ({
        key: r.key,
        url: redactUrl(r.url),
        defaultBranch: r.defaultBranch,
        workflow: r.workflow,
        maxConcurrent: r.maxConcurrent,
        adapter: r.adapter,
        effectiveAdapter: resolveAdapterKind(r.adapter, defaultKind),
        readiness: r.readiness ?? 'ready',
        // Names/structure only — never env values.
        executionPolicy: policyDiagnostics(
          effectiveRepoExecutionPolicy(r.executionPolicy ?? null),
        ),
        autoMerge: r.autoMerge ?? null,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    problems: [...view.snapshot.problems],
    byState: groupByState(view.snapshot.tasks.map(redactTaskProviderSession)),
    activity: copyActivity(view.activity),
    pendingChat,
    liveRuns,
    verificationRuns,
    lastReport: view.lastReport,
    agents: agentsDto,
    sessions,
    sessionActivity,
    build,
    costSummary,
    dispatchHold,
    diskWarn,
    diskPressure,
    adapterFailover,
    reviewerHealth,
    holds,
  };
}

/** Provider resume ids are control-plane state, never phone/API data. */
export function redactTaskProviderSession(task: Task): Task {
  let body = task.body;
  const currentSession = task.agentSession?.trim();
  if (currentSession) {
    body = body.split(currentSession).join('[session-redacted]');
  }
  // Backward compatibility for notes written before session ids were removed
  // from abandonment diagnostics. Keep this deliberately format-specific.
  body = body.replace(
    /Prior `agent_session`: `[^`\r\n]+`/g,
    'Prior `agent_session`: [session-redacted]',
  );
  body = body.replace(
    /(Session\s+")[0-9a-f-]{16,}("\s+not found locally,\s+restoring from remote[^\r\n]*)/gi,
    '$1[session-redacted]$2',
  );
  return {
    ...task,
    body,
    agentSession: null,
    agentSessionAdapter: null,
    planPendingReason: planPendingReasonFor(task),
    ...(task.reviewerInfrastructure
      ? {
          reviewerInfrastructure: {
            ...task.reviewerInfrastructure,
            worktree: '[redacted-local-worktree]',
          },
        }
      : {}),
  };
}

export function redactRemoteSessionProviderSession(session: RemoteSession): RemoteSession {
  return { ...session, agentSession: null };
}

/** Copy + re-redact verification meta so secrets never leak over the wire. */
function serializeVerificationRuns(
  runs: Record<string, VerificationRunMeta>,
): Record<string, VerificationRunMeta> {
  return Object.fromEntries(
    Object.entries(runs).map(([k, v]) => {
      const phase = v.phase as VerificationPhase;
      return [
        k,
        {
          taskId: v.taskId,
          phase,
          stage: redactVerificationStage(v.stage),
          startedAt: v.startedAt,
          elapsedMs: Math.max(0, Math.floor(v.elapsedMs)),
          processAlive: v.processAlive === true,
          cancelRequested: v.cancelRequested === true,
          lastCompletedStage:
            v.lastCompletedStage === null || v.lastCompletedStage === undefined
              ? null
              : redactVerificationStage(v.lastCompletedStage),
        },
      ];
    }),
  );
}
