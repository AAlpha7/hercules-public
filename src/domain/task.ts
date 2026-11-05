/**
 * Domain layer — task model and state machine (SPEC §3.2, §5, §10).
 *
 * This module is pure: no IO, no git, no filesystem. The control layer turns
 * markdown files into these types and back; the orchestrator reasons over them.
 */
import type { AdapterKind } from './agents.js';
import type { FakeBehaviorScript } from './fakeBehavior.js';
import type { ExecutionClass } from './executionClass.js';
import type { DependencyMode } from './dependencyGate.js';
import type { ProjectStateClosureStatus } from './projectStateClosure.js';
import type { ReviewerInfrastructureReceipt } from './reviewerInfrastructure.js';
import type {
  PlatformRemediationKind,
  PlatformRemediationResumedOutcome,
} from './platformRemediation.js';
import type { PlanPendingReason } from './acceptance.js';

/** All task states (SPEC §5 + soft-delete trash). */
export const TASK_STATES = [
  'todo',
  'in_progress',
  'review',
  'done',
  'cancelled',
  'retrying',
  'failed',
  /** Soft-deleted trash; shown under Deleted; hard-purged after retention. */
  'deleted',
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/**
 * States that are terminal for scheduling (SPEC §5). A task blocked by a task
 * in one of these states is considered unblocked.
 */
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'done',
  'cancelled',
  'failed',
  'deleted',
]);

export function isTaskState(value: unknown): value is TaskState {
  return typeof value === 'string' && (TASK_STATES as readonly string[]).includes(value);
}

export function isTerminalState(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Soft-delete (→ `deleted`) allowed from any non-running state, including
 * already-deleted (no-op path handled by actions). Hard purge only from deleted.
 */
export function isDeletableState(state: TaskState): boolean {
  return state !== 'in_progress' && state !== 'retrying';
}

/** Can move into the Deleted trash section. */
export function canSoftDelete(state: TaskState): boolean {
  return isDeletableState(state) && state !== 'deleted';
}

/**
 * Identifier safety (SPEC §10). Task ids and repo keys MUST match this pattern
 * before being used in any filesystem path or git branch name. This is the
 * single chokepoint that prevents path traversal and command injection via
 * task/repo identifiers.
 */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._-]+$/;

export function isValidIdentifier(value: string): boolean {
  if (value.length === 0) return false;
  // Reject "." and ".." outright — they are valid per the charset but unsafe as path segments.
  if (value === '.' || value === '..') return false;
  return IDENTIFIER_PATTERN.test(value);
}

/** Thrown when an id/key that becomes a path or branch fails {@link isValidIdentifier}. */
export class IdentifierError extends Error {
  override readonly name = 'IdentifierError';
}

/**
 * A task, as the orchestrator sees it. Field names are camelCase here; the
 * on-disk front matter uses snake_case (SPEC §3.2) — the control layer maps
 * between the two.
 */
export interface Task {
  /** MUST equal the file stem; sanitized per {@link isValidIdentifier}. */
  readonly id: string;
  readonly title: string;
  /** MUST be a key in repos.yaml (validated by the orchestrator, not here). */
  readonly repo: string;
  readonly state: TaskState;
  /** Lower = higher priority. */
  readonly priority: number;
  /**
   * Task ids this task is blocked by. Satisfaction is mode-aware: same-repo
   * code consumers require gate-merge ancestry (see {@link DependencyMode}).
   */
  readonly blockedBy: readonly string[];
  /**
   * How `blocked_by` edges are satisfied. `null`/absent = legacy inference
   * (same-repo implement/verify/host → gate_merge; explore/cross-repo →
   * completion_only). Explicit `completion_only` is legitimate for explore
   * or cross-repo only — same-repo code consumers always require gate_merge.
   */
  readonly dependencyMode?: DependencyMode | null;
  readonly labels: readonly string[];
  /**
   * Optional agent for *this* task only (`grok`|`codex`|`claude`|`cursor`|`fake`).
   * `null` = fall through to repo override, then daemon default.
   * Soft change mid-run does not kill the live process (next dispatch applies).
   * Switch-now (UI) stops the live run and re-queues with the new agent.
   */
  readonly adapter: AdapterKind | null;
  /**
   * Isolation-only fake-adapter fault script (`die-immediately` | `die-mid-turn` |
   * `succeed`). Honored only when `HERCULES_ADAPTER=fake` **and**
   * `HERCULES_FAKE_FAULT_INJECTION=1`. Real adapters ignore this field.
   * Optional on legacy / hand-built tasks (treated as null).
   */
  readonly fakeBehavior?: FakeBehaviorScript | null;
  /** Adapter session/thread id, for resume. Written by the daemon. */
  readonly agentSession: string | null;
  /** Provider that owns {@link agentSession}; absent legacy ownership is not resumable. */
  readonly agentSessionAdapter?: AdapterKind | null;
  /**
   * Human follow-up waiting for the next dispatch (comment-to-steer).
   * When set with a non-empty {@link agentSession}, the orchestrator resumes
   * the prior adapter session with a short prompt (token-efficient Q&A).
   * Cleared when the steered run starts. Written by human action only.
   */
  readonly pendingSteer: string | null;
  readonly attempts: number;
  /** ISO timestamp of the last agent event; used for stall detection. */
  readonly lastEventAt: string | null;
  /** ISO timestamp the task was created (human action). */
  readonly createdAt: string | null;
  /** ISO timestamp the agent first started (first dispatch; not reset on retry). */
  readonly startedAt: string | null;
  /** ISO timestamp the agent last left `in_progress` (work finished). */
  readonly endedAt: string | null;
  /** Daemon-generated durable identity for the latest dispatch's cost receipt. */
  readonly costRunId?: string | null;
  /**
   * GitHub PR URL after Approve&PR / Open PR (if any).
   * Survives restarts so the phone UI can highlight open PRs.
   */
  readonly prUrl: string | null;
  /**
   * Last known PR lifecycle: open = still active on GitHub;
   * merged/closed = terminal. null = never opened a PR from Hercules.
   * Written on Approve&PR / Open PR, then reconciled from GitHub (tick +
   * pr-summary) so Awaiting merge clears after merge on the website.
   */
  readonly prStatus: 'open' | 'merged' | 'closed' | null;
  /**
   * When true, task is a plan draft awaiting human "Approve plan" before
   * dispatch (G5). Not eligible for scheduling while set.
   */
  readonly planPending: boolean;
  /**
   * API/view-only bilingual reason when {@link planPending} is true.
   * Never persisted to task front matter.
   */
  readonly planPendingReason?: PlanPendingReason | null;
  /**
   * Worktree HEAD the last verification packet was produced from. Approve
   * refuses when the preserved branch tip no longer contains this commit
   * (verified-SHA invariant; optional — legacy tasks have none).
   */
  readonly verifiedSha?: string | null;
  /**
   * C3.57: true when every WORKFLOW L1 gate passed on `verifiedSha`
   * (`verified_gates_green` front matter, emitted only when true). Cleared
   * with `verifiedSha`. A single-task merge whose merge-base is the current
   * default tip inherits L1 from this instead of re-running the gates.
   */
  readonly verifiedGatesGreen?: boolean | null;
  /**
   * Hercules-owned provenance nonce for the latest review packet body
   * (`packet_nonce` front matter; 32 hex). SPA parsers prefer this over
   * scanning for the last header fence. Cleared when a new run starts or
   * the body's packet is removed. Legacy tasks have none.
   */
  readonly packetNonce?: string | null;
  /**
   * Merge-commit SHA on the repo default branch after a human-authorized
   * batch Merge (design §1 / §3). Optional audit field — legacy / unmerged
   * tasks have none. Does not change the task state machine.
   */
  readonly mergedSha?: string | null;
  /**
   * How {@link mergedSha} was recorded: `gate` = machine Merge service
   * (verified-SHA + L1 on merged result); `operator` = human/backfill.
   * Absent is treated as operator for promote trust-chain honesty.
   */
  readonly mergedVia?: 'gate' | 'operator' | null;
  /**
   * Execution class (`execution_class` front matter). Absent/legacy →
   * `implement` via {@link resolveExecutionClass}. Coding classes never
   * authorize host package/service mutations; `host_operation` / `deploy`
   * need a human approval record with bounded command scope.
   */
  readonly executionClass?: ExecutionClass | null;
  /**
   * Bounded named host commands approved by a human (host_operation/deploy).
   * Null/absent when unset. Required (with {@link hostApprovedAt}) before
   * autonomous dispatch of host-mutating classes.
   */
  readonly hostCommandScope?: readonly string[] | null;
  /**
   * ISO timestamp of the human host-operation approval record.
   * Null/absent when unset.
   */
  readonly hostApprovedAt?: string | null;
  /**
   * Durable marker: deterministic host executor has begun this approval's
   * scope (committed before the first command can spawn). Restart orphans
   * for host_operation/deploy are always replay-blocked (including legacy
   * tasks without this marker) — never re-queued as retrying.
   */
  readonly hostExecutionStartedAt?: string | null;
  /**
   * Explicit clean-salvage fork provenance: source failed or cancelled task id.
   * Only set by the audited salvage-fork action — never by heuristics.
   */
  readonly salvageSourceTask?: string | null;
  /**
   * Exact source tip SHA the target branch was seeded from. Provisioning
   * continues from this stamp even after the source worktree is reclaimed.
   */
  readonly salvageSourceSha?: string | null;
  /**
   * Verify-from-ref (C3.43): exact origin commit the task branch is seeded
   * from at first provision, so the verifier judges an existing tip without
   * an agent re-creating files. Only stamped with executionClass `verify`.
   * Omitted when absent — never null (task-file hash stability).
   */
  readonly seedFromSha?: string;
  /** Trusted default-branch tip captured before this task run can spawn. */
  readonly expectedBaseRevision?: string;
  /** Exact remote task-branch tip; explicit null is the branch-creation lease. */
  readonly expectedRemoteTip?: string | null;
  /**
   * Immutable reviewed base for the affected-path plan. Unlike
   * expectedBaseRevision, this is never advanced by task-branch ownership.
   */
  readonly plannedBaseRevision?: string;
  /**
   * Declared affected paths for repository path/writer leases.
   * Exact file (`src/a.ts`) or directory subtree (`src/domain/` or trailing
   * double-star form). Validated/canonicalized at parse time; absent on legacy
   * tasks.
   */
  readonly affectedPaths?: readonly string[];
  /**
   * WORKFLOW `protected_paths` snapshot at plan time. Compared at dispatch for
   * protected-path drift. Empty array is a valid snapshot; absent means unset.
   */
  readonly protectedPathsSnapshot?: readonly string[];
  /** Verification-time binding of the immutable path declaration. */
  readonly verifiedPathLeaseDigest?: string | null;
  /**
   * Project-state closure lane (opt-in repos only). Distinct from verified_sha
   * (code verification) and merged_sha (gate-merge). Never implies deployment
   * or that a milestone is complete merely because a SHA merged.
   */
  readonly projectStateClosureStatus?: ProjectStateClosureStatus | null;
  /**
   * Policy digest (+ provenance) of the last closure evaluation. Bound to the
   * trusted contract; survives restart via task front matter + body receipt.
   */
  readonly projectStateClosureDigest?: string | null;
  /** Durable exact-candidate checkpoint after L3 provider infrastructure failure. */
  readonly reviewerInfrastructure?: ReviewerInfrastructureReceipt | null;
  /**
   * Platform remediation kind (`bug` | `capability_gap` | `platform_limit`).
   * Set on both the blocked original and its remediation task. Absent on
   * ordinary retries / review / merge events (never misclassified).
   */
  readonly platformRemediationKind?: PlatformRemediationKind | null;
  /**
   * On the blocked original: id of the linked Hercules remediation task.
   * Causal telemetry only — not a blocked_by edge.
   */
  readonly platformRemediationTask?: string | null;
  /** On the remediation task: id of the original blocked task. */
  readonly platformRemediationOf?: string | null;
  /**
   * On the original: auditable resumed outcome after the remediation ends.
   */
  readonly platformRemediationResumedOutcome?: PlatformRemediationResumedOutcome | null;
  /** ISO timestamp when the platform-remediation chain was opened. */
  readonly platformRemediationRecordedAt?: string | null;
  /**
   * True when this remediation task hit the same platform issue and recursive
   * self-remediation was refused (bootstrap / platform-external rescue).
   */
  readonly bootstrapEscalation?: boolean | null;
  /** Bounded external-maintenance action text (no credentials/paths). */
  readonly bootstrapEscalationAction?: string | null;
  /** ISO timestamp when bootstrap escalation was recorded. */
  readonly bootstrapEscalationRecordedAt?: string | null;
  /** Free-form markdown body (everything after the front matter). */
  readonly body: string;
}

export type PrStatus = NonNullable<Task['prStatus']>;

export function isPrStatus(v: unknown): v is PrStatus {
  return v === 'open' || v === 'merged' || v === 'closed';
}

/**
 * Map GitHub PR `state` (from `gh pr view --json state`) onto our pr_status.
 * Accepts OPEN / MERGED / CLOSED (any case). Unknown → null (do not overwrite).
 */
export function githubPrStateToStatus(state: string): PrStatus | null {
  const s = state.trim().toUpperCase();
  if (s === 'OPEN') return 'open';
  if (s === 'MERGED') return 'merged';
  if (s === 'CLOSED') return 'closed';
  return null;
}

/**
 * Extract a validated full commit SHA from GitHub mergeCommit JSON
 * (object with oid field, or a bare string). Short / malformed / missing -> null.
 * Callers must not invent a substitute (no main tip, no branch HEAD).
 */
export function parseGithubMergeCommitSha(mergeCommit: unknown): string | null {
  if (mergeCommit == null) return null;
  if (typeof mergeCommit === 'string') {
    return isFullCommitShaString(mergeCommit) ? mergeCommit : null;
  }
  if (typeof mergeCommit === 'object') {
    const rec = mergeCommit as Record<string, unknown>;
    const oid = rec['oid'];
    if (typeof oid === 'string' && isFullCommitShaString(oid)) return oid;
  }
  return null;
}

function isFullCommitShaString(value: string): boolean {
  return value.length === 40 && /^[0-9a-f]+$/i.test(value);
}

/** Task still has an active GitHub PR link (any Hercules state). */
export function hasOpenPr(task: {
  readonly prStatus: PrStatus | null;
  readonly prUrl: string | null;
}): boolean {
  return task.prStatus === 'open' && typeof task.prUrl === 'string' && task.prUrl.length > 0;
}

/**
 * Phone "Awaiting merge" bucket: Hercules work is **done** and the PR is still
 * open on GitHub. Failed / in-flight / review tasks may keep pr_url for salvage
 * but must NOT claim "waiting for merge" (orbit onboarding case: failed + PR #5).
 */
export function isAwaitingMerge(task: {
  readonly state: TaskState;
  readonly prStatus: PrStatus | null;
  readonly prUrl: string | null;
}): boolean {
  return task.state === 'done' && hasOpenPr(task);
}

/**
 * Only the **Deleted** trash is auto hard-purged after retention.
 * Each task ages alone from when it entered `deleted` (`endedAt`).
 */
export const AUTO_DELETE_STATES: ReadonlySet<TaskState> = new Set<TaskState>(['deleted']);

/** Default days in Deleted before hard purge. Override with HERCULES_AUTO_DELETE_DAYS. */
export const DEFAULT_AUTO_DELETE_DAYS = 30;

/**
 * Last activity clock for phone list ordering within a state bucket.
 * Prefers lastEventAt, then endedAt, then createdAt.
 */
export function taskLastActivityMs(task: {
  readonly lastEventAt: string | null;
  readonly endedAt: string | null;
  readonly createdAt: string | null;
}): number | null {
  const iso = task.lastEventAt ?? task.endedAt ?? task.createdAt;
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

type ActivitySortable = {
  readonly id: string;
  readonly lastEventAt: string | null;
  readonly endedAt: string | null;
  readonly createdAt: string | null;
};

/**
 * Descending last-activity for UI buckets. Missing activity sorts last;
 * equal activity breaks ties by id ascending. Not used by dispatch.
 */
export function compareTasksByLastActivityDesc(a: ActivitySortable, b: ActivitySortable): number {
  const am = taskLastActivityMs(a);
  const bm = taskLastActivityMs(b);
  if (am === null && bm === null) return a.id.localeCompare(b.id);
  if (am === null) return 1;
  if (bm === null) return -1;
  if (am !== bm) return bm - am;
  return a.id.localeCompare(b.id);
}

/**
 * Anchor clock for trash retention: when soft-deleted we stamp `endedAt`.
 * Fallback lastEventAt / createdAt only if endedAt missing.
 */
export function taskAutoDeleteAnchorMs(task: Task): number | null {
  const iso = task.endedAt ?? task.lastEventAt ?? task.createdAt;
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * True when a **deleted** task has been in the trash past retention.
 * Other states are never auto hard-purged (use Clear / Delete to trash first).
 */
export function isDueForAutoDelete(
  task: Task,
  nowMs: number,
  retentionMs: number,
): boolean {
  if (retentionMs <= 0) return false;
  if (task.state !== 'deleted') return false;
  const anchor = taskAutoDeleteAnchorMs(task);
  if (anchor === null) return false;
  if (anchor > nowMs) return false;
  return nowMs - anchor >= retentionMs;
}

/** Ms remaining until hard purge from Deleted, or null if not in trash. */
export function msUntilAutoDelete(
  task: Task,
  nowMs: number,
  retentionMs: number,
): number | null {
  if (retentionMs <= 0) return null;
  if (task.state !== 'deleted') return null;
  const anchor = taskAutoDeleteAnchorMs(task);
  if (anchor === null) return null;
  return retentionMs - (nowMs - anchor);
}
