/**
 * Domain — dependency satisfaction / gate-merge barrier (pure).
 *
 * Same-repo code consumers must not dispatch merely because an upstream task
 * is `done` after Approve. Local CLI work stays blocked until Merge Selected
 * stamped `merged_via=gate` + `merged_sha`, and those SHAs (plus the verified
 * tip) are ancestors of the trusted default branch used for dispatch.
 *
 * Cursor Cloud factory close-out is the other success path: GitHub-observed
 * merge (`merged_via=operator`, `pr_status=merged`, merge SHA from GitHub).
 * Factory runs never produce `verified_sha`. Dependents unlock on the merge
 * SHA's ancestry — never by inventing a verified tip.
 *
 * Completion-only mode covers analysis / no-diff / cross-repo orchestration
 * where code ancestry is not the contract. Same-repo implement/verify/host/
 * deploy consumers cannot override that with completion_only. No IO —
 * ancestry facts are injected by the orchestrator at the pre-provision recheck.
 */
import type { Task, TaskState } from './task.js';
import { isRemoteFactoryAdapter } from './agents.js';
import {
  isHostMutatingClass,
  resolveExecutionClass,
  type ExecutionClass,
} from './executionClass.js';

/** How a dependent task treats each `blocked_by` edge. */
export const DEPENDENCY_MODES = ['gate_merge', 'completion_only'] as const;
export type DependencyMode = (typeof DEPENDENCY_MODES)[number];

/** Stable reason codes for schedule holds and phone remediation. */
export const DEPENDENCY_BLOCK_CODES = [
  'dep_missing',
  'dep_not_done',
  'dep_failed',
  'dep_cancelled',
  'dep_deleted',
  'dep_awaiting_merge',
  'dep_merge_not_gate',
  'dep_missing_merged_sha',
  'dep_missing_verified_sha',
  'dep_stale_mirror',
  'dep_ancestry_mismatch',
] as const;
export type DependencyBlockCode = (typeof DEPENDENCY_BLOCK_CODES)[number];

export type DependencyHoldKind = 'broken' | 'pending' | 'awaiting_merge';

export interface DependencyHold {
  readonly id: string;
  readonly code: DependencyBlockCode;
  readonly kind: DependencyHoldKind;
  readonly state: TaskState | 'missing';
  /** Concise phone / log remediation. */
  readonly remediation: string;
}

/** Git facts for one required SHA on the trusted default branch. */
export type ShaAncestryFact = 'reachable' | 'not_reachable' | 'unknown';

/**
 * Ancestry facts for a gate_merge dependency, supplied by isolation at the
 * atomic pre-provision recheck. Omit at pure schedule time (metadata only).
 */
export interface DependencyAncestryFacts {
  /** Tip of the trusted default branch, or null when the mirror cannot answer. */
  readonly defaultBranchTip: string | null;
  /** Whether `merged_sha` is an ancestor of (or equal to) the tip. */
  readonly mergedSha: ShaAncestryFact;
  /** Whether `verified_sha` is an ancestor of (or equal to) the tip. */
  readonly verifiedSha: ShaAncestryFact;
}

export function isDependencyMode(value: unknown): value is DependencyMode {
  return (
    typeof value === 'string' &&
    (DEPENDENCY_MODES as readonly string[]).includes(value.trim().toLowerCase())
  );
}

export function parseDependencyMode(raw: unknown): DependencyMode | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (v.length === 0) return null;
  if (isDependencyMode(v)) return v;
  return null;
}

/**
 * Onboarding / readiness / pipeline stages are sequential completion contracts.
 * Stage N-1 often lands via operator PR merge (`merged_via=operator`), not
 * Hercules Merge Selected. Applying same-repo implement gate_merge there
 * permanently starves R3+ after a successful readiness pipeline (Demo-ready-3,
 * 2026-08-05). Explicit `dependency_mode: gate_merge` still wins when set.
 */
export function isReadinessPipelineLabeled(labels: readonly string[] | undefined): boolean {
  for (const raw of labels ?? []) {
    const x = raw.trim().toLowerCase();
    if (x === 'onboarding' || x === 'readiness') return true;
    // pipeline / pipeline:<id> / stage:N
    if (x === 'pipeline' || x.startsWith('pipeline:') || x.startsWith('stage:')) return true;
  }
  return false;
}

/**
 * Resolve how this dependent treats a specific upstream dependency.
 *
 * Same-repo code consumers (implement / verify / host_operation / deploy)
 * always require gate_merge — explicit `dependency_mode: completion_only`
 * cannot bypass that contract, **except** readiness/onboarding/pipeline
 * labeled work (sequential stage completion; see
 * {@link isReadinessPipelineLabeled}). Completion-only is also legitimate for
 * explore / no-diff analysis or cross-repo orchestration.
 *
 * Legacy inference when mode is unset:
 * - readiness/onboarding/pipeline labeled dependent -> completion_only
 * - same repo + implement/verify/host/deploy -> gate_merge
 * - same-repo explore or cross-repo -> completion_only
 */
export function resolveDependencyMode(
  dependent: {
    readonly repo: string;
    readonly dependencyMode?: DependencyMode | null;
    readonly executionClass?: ExecutionClass | null;
    readonly labels?: readonly string[];
  },
  dependency: { readonly repo: string },
): DependencyMode {
  // Explicit always wins.
  if (dependent.dependencyMode === 'gate_merge') return 'gate_merge';

  // Readiness pipeline stages: sequential completion (not gate-merge).
  // Checked before the same-repo implement fail-closed rule so R3 can follow
  // an operator-merged R2 without a manual merged_via re-stamp.
  if (isReadinessPipelineLabeled(dependent.labels)) {
    return 'completion_only';
  }

  // Fail closed: same-repo code consumers cannot opt out of gate merge.
  if (dependent.repo === dependency.repo) {
    const klass = resolveExecutionClass(dependent);
    if (
      klass === 'implement' ||
      klass === 'verify' ||
      isHostMutatingClass(klass)
    ) {
      return 'gate_merge';
    }
  }

  if (dependent.dependencyMode === 'completion_only') return 'completion_only';

  // Legacy / unset: explore (same-repo) and all cross-repo edges.
  return 'completion_only';
}

function remediationFor(code: DependencyBlockCode, depId: string): string {
  switch (code) {
    case 'dep_missing':
      return `Missing dependency ${depId} - create it or edit blocked_by.`;
    case 'dep_not_done':
      return `Waiting for ${depId} to finish and be approved.`;
    case 'dep_failed':
      return `Dependency ${depId} failed - retry it or edit blocked_by.`;
    case 'dep_cancelled':
      return `Dependency ${depId} was cancelled - restore it or edit blocked_by.`;
    case 'dep_deleted':
      return `Dependency ${depId} was deleted - restore it or edit blocked_by.`;
    case 'dep_awaiting_merge':
      return `Merge Selected on ${depId} first (Approve alone does not unlock).`;
    case 'dep_merge_not_gate':
      return `${depId} lacks merged_via=gate - use Merge Selected, or set dependency_mode: completion_only.`;
    case 'dep_missing_merged_sha':
      return `Wait for merge stamp (merged_sha) on ${depId}.`;
    case 'dep_missing_verified_sha':
      return `${depId} has no verified_sha - re-verify before Merge Selected.`;
    case 'dep_stale_mirror':
      return `Mirror has not absorbed ${depId}'s merge yet - wait for the next sync.`;
    case 'dep_ancestry_mismatch':
      return `${depId}'s gate merge / verified tip is not on the trusted default branch.`;
  }
}

function hold(
  id: string,
  code: DependencyBlockCode,
  kind: DependencyHoldKind,
  state: TaskState | 'missing',
): DependencyHold {
  return { id, code, kind, state, remediation: remediationFor(code, id) };
}

function nonSuccessHold(depId: string, state: TaskState | 'missing'): DependencyHold {
  if (state === 'missing') return hold(depId, 'dep_missing', 'broken', 'missing');
  if (state === 'failed') return hold(depId, 'dep_failed', 'broken', state);
  if (state === 'cancelled') return hold(depId, 'dep_cancelled', 'broken', state);
  if (state === 'deleted') return hold(depId, 'dep_deleted', 'broken', state);
  return hold(depId, 'dep_not_done', 'pending', state);
}

function hasNonEmptySha(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Cursor Cloud factory identity: task adapter or the session that ran it. */
export function isFactoryDependency(dependency: Task): boolean {
  return (
    isRemoteFactoryAdapter(dependency.adapter ?? '') ||
    isRemoteFactoryAdapter(dependency.agentSessionAdapter ?? '')
  );
}

/**
 * Factory close-out that GitHub already reported as merged.
 * Honest operator provenance + merge SHA; `verified_sha` stays absent.
 */
export function isObservedFactoryMerge(dependency: Task): boolean {
  return (
    isFactoryDependency(dependency) &&
    dependency.prStatus === 'merged' &&
    dependency.mergedVia === 'operator' &&
    hasNonEmptySha(dependency.mergedSha)
  );
}

/**
 * Evaluate one dependency edge.
 *
 * When `ancestry` is omitted, gate_merge stops at metadata (schedule filter).
 * When provided, local CLI also requires merged_sha + verified_sha on the
 * trusted tip. Observed factory merges prove the GitHub merge SHA only.
 */
export function evaluateDependency(
  dependent: Task,
  depId: string,
  dependency: Task | undefined,
  ancestry?: DependencyAncestryFacts,
): { readonly ok: true; readonly mode: DependencyMode } | DependencyHold {
  if (!dependency) {
    return nonSuccessHold(depId, 'missing');
  }
  if (dependency.state !== 'done') {
    return nonSuccessHold(depId, dependency.state);
  }

  const mode = resolveDependencyMode(dependent, dependency);
  if (mode === 'completion_only') {
    return { ok: true, mode };
  }

  // Factory close-out: GitHub-observed merge SHA unblocks same-repo implement.
  // Do not require verified_sha — factory never runs local verify.
  if (isObservedFactoryMerge(dependency)) {
    if (ancestry === undefined) {
      return { ok: true, mode };
    }
    if (!ancestry.defaultBranchTip || ancestry.mergedSha === 'unknown') {
      return hold(depId, 'dep_stale_mirror', 'awaiting_merge', dependency.state);
    }
    if (ancestry.mergedSha === 'not_reachable') {
      return hold(depId, 'dep_ancestry_mismatch', 'awaiting_merge', dependency.state);
    }
    return { ok: true, mode };
  }

  // Factory PR is merged on GitHub but the merge SHA has not been stamped yet
  // (offline heal). Wait for provenance backfill — not Merge Selected.
  if (
    isFactoryDependency(dependency) &&
    dependency.prStatus === 'merged' &&
    !hasNonEmptySha(dependency.mergedSha)
  ) {
    return hold(depId, 'dep_missing_merged_sha', 'awaiting_merge', dependency.state);
  }

  // gate_merge (local CLI): Approve alone is not enough.
  // Deterministic reason ordering (do not collapse into one code):
  // 1) merged_via=gate but missing merged_sha -> dep_missing_merged_sha
  // 2) operator / direct / non-gate provenance -> dep_merge_not_gate
  // 3) ordinary approved/done with no merge metadata -> dep_awaiting_merge
  const hasMergedSha = hasNonEmptySha(dependency.mergedSha);
  if (dependency.mergedVia === 'gate') {
    if (!hasMergedSha) {
      return hold(depId, 'dep_missing_merged_sha', 'awaiting_merge', dependency.state);
    }
  } else if (dependency.mergedVia === 'operator' || hasMergedSha) {
    // operator stamp, or any merged_sha without gate provenance.
    return hold(depId, 'dep_merge_not_gate', 'awaiting_merge', dependency.state);
  } else {
    return hold(depId, 'dep_awaiting_merge', 'awaiting_merge', dependency.state);
  }

  if (!hasNonEmptySha(dependency.verifiedSha)) {
    return hold(depId, 'dep_missing_verified_sha', 'awaiting_merge', dependency.state);
  }

  // Metadata OK. Ancestry is optional at schedule time (`ancestry` omitted).
  // When provided (dispatch recheck), both SHAs must be on the trusted tip.
  if (ancestry === undefined) {
    return { ok: true, mode };
  }

  // Unknown probes (missing mirror/object) and a missing tip both mean the
  // trusted baseline is not proven yet — fail closed as stale, not unlock.
  if (
    !ancestry.defaultBranchTip ||
    ancestry.mergedSha === 'unknown' ||
    ancestry.verifiedSha === 'unknown'
  ) {
    return hold(depId, 'dep_stale_mirror', 'awaiting_merge', dependency.state);
  }
  if (ancestry.mergedSha === 'not_reachable' || ancestry.verifiedSha === 'not_reachable') {
    return hold(depId, 'dep_ancestry_mismatch', 'awaiting_merge', dependency.state);
  }

  return { ok: true, mode };
}

/** All holds for a task's blocked_by list (metadata-only; no ancestry). */
export function dependencyHolds(
  task: Task,
  tasks: readonly Task[],
): readonly DependencyHold[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out: DependencyHold[] = [];
  for (const depId of task.blockedBy) {
    const result = evaluateDependency(task, depId, byId.get(depId));
    if ('ok' in result && result.ok) continue;
    out.push(result as DependencyHold);
  }
  return out;
}

/** True when every blocked_by edge passes metadata satisfaction (schedule). */
export function dependenciesSatisfiedForSchedule(
  task: Task,
  tasks: readonly Task[],
): boolean {
  return dependencyHolds(task, tasks).length === 0;
}

/**
 * Dispatch-time gate: metadata + per-dep ancestry facts.
 * Always fail-closed for gate_merge edges: missing map or missing entry ->
 * `dep_stale_mirror` (never metadata-pass). Schedule-only evaluation uses
 * {@link dependencyHolds} / {@link dependenciesSatisfiedForSchedule} instead.
 */
export function firstUnsatisfiedDependency(
  task: Task,
  tasks: readonly Task[],
  ancestryByDepId?: ReadonlyMap<string, DependencyAncestryFacts>,
): DependencyHold | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const depId of task.blockedBy) {
    const dep = byId.get(depId);
    let ancestry: DependencyAncestryFacts | undefined;
    // Dispatch helper always injects ancestry for gate_merge (fail closed).
    // completion_only edges skip ancestry.
    if (dep && resolveDependencyMode(task, dep) === 'gate_merge') {
      ancestry = ancestryByDepId?.get(depId) ?? {
        defaultBranchTip: null,
        mergedSha: 'unknown',
        verifiedSha: 'unknown',
      };
    }
    const result = evaluateDependency(task, depId, dep, ancestry);
    if ('ok' in result && result.ok) continue;
    return result as DependencyHold;
  }
  return null;
}

/** Classify a boolean|null ancestry probe into a fact. */
export function toShaAncestryFact(value: boolean | null | undefined): ShaAncestryFact {
  if (value === true) return 'reachable';
  if (value === false) return 'not_reachable';
  return 'unknown';
}
