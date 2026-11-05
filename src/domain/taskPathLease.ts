/**
 * Domain layer -- repository path / writer leases (Guardian path leases).
 *
 * Pure types + decision logic for:
 * - canonical affected-path declarations (exact file vs directory subtree)
 * - atomic acquire / release / stale reclaim against held leases
 * - stale base, path overlap, writer limit, ambiguous scope, protected-path drift
 * - out-of-scope actual-diff revalidation before review/merge
 *
 * No fs/git/network. Isolation owns durable storage; orchestrator owns the
 * server-side acquire chokepoint before any adapter spawn.
 */
import type { EffectiveRepoExecutionPolicy } from './repoExecutionPolicy.js';
import { taskHasOnboardingLabel } from './onboarding.js';
import { isFullCommitSha } from './taskBranchLease.js';
import { isValidIdentifier } from './task.js';

/** On-disk / in-memory lease table schema version. */
export const PATH_LEASE_VERSION = 1 as const;

/** Exact file vs directory subtree (path + all descendants). */
export type PathScopeKind = 'exact' | 'subtree';

/** Canonical path scope after normalization. */
export interface PathScope {
  readonly kind: PathScopeKind;
  /** Repo-relative path, no leading ./, no trailing slash. */
  readonly path: string;
}

/** One held writer/path lease, owned exclusively by a run token. */
export interface PathLeaseEntry {
  readonly taskId: string;
  /** Opaque run ownership token; release requires exact match. */
  readonly runToken: string;
  readonly baseRevision: string;
  readonly scopes: readonly PathScope[];
  /** Sorted protected-path globs snapshotted at plan/acquire time. */
  readonly protectedPathsSnapshot: readonly string[];
  readonly acquiredAtMs: number;
  /**
   * Root process that can still mutate the leased worktree. Set immediately
   * after adapter/host-executor start. A missing identity is deliberately not
   * considered stale after a daemon crash because liveness is then unknown.
   */
  readonly ownerProcess?: {
    readonly pid: number;
    /** Linux /proc start-time ticks; prevents PID-reuse from stealing a lease. */
    readonly startTimeTicks: string;
    /** Kernel boot identity; start-time ticks are only unique within one boot. */
    readonly bootId: string;
  };
}

export type PathLeaseAcquireReject =
  | 'missing_declaration'
  | 'ambiguous_scope'
  | 'invalid_base'
  | 'stale_base'
  | 'path_overlap'
  | 'writer_limit'
  | 'protected_path_drift'
  | 'prior_run_held'
  | 'token_conflict';

export type PathLeaseAcquireVerdict =
  | {
      readonly ok: true;
      readonly entry: PathLeaseEntry;
      readonly nextHeld: readonly PathLeaseEntry[];
    }
  | {
      readonly ok: false;
      readonly reason: PathLeaseAcquireReject;
      readonly detail: string;
      readonly conflictingTaskIds?: readonly string[];
    };

export type PathLeaseReleaseVerdict =
  | {
      readonly ok: true;
      readonly released: PathLeaseEntry;
      readonly nextHeld: readonly PathLeaseEntry[];
    }
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'token_mismatch';
      readonly detail: string;
    };

export type NormalizePathResult =
  | { readonly ok: true; readonly scope: PathScope }
  | { readonly ok: false; readonly reason: string };

export type NormalizePathsResult =
  | { readonly ok: true; readonly scopes: readonly PathScope[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Normalize one affected-path declaration.
 *
 * Semantics:
 * - path/to/file.ts -> exact file
 * - path/to/dir/ or path/to/dir/** -> subtree (dir + descendants)
 *
 * Rejects absolute paths, traversal, empty, mid-path globs, and bare **.
 */
export function normalizePathDeclaration(raw: string): NormalizePathResult {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'path declaration must be a string' };
  }
  let t = raw.trim();
  if (t.length === 0) return { ok: false, reason: 'empty path declaration' };
  // Reject backslashes (Windows paths / escapes).
  if (t.indexOf(String.fromCharCode(92)) >= 0) {
    return { ok: false, reason: 'path must use forward slashes: ' + JSON.stringify(raw) };
  }
  if (t.includes('://') || t.startsWith('/') || t.startsWith('~')) {
    return { ok: false, reason: 'absolute or URL path rejected: ' + JSON.stringify(raw) };
  }
  if (/^[A-Za-z]:\//.test(t) || /^[A-Za-z]:$/.test(t)) {
    return { ok: false, reason: 'absolute path rejected: ' + JSON.stringify(raw) };
  }

  let kind: PathScopeKind = 'exact';
  if (t.endsWith('/**')) {
    kind = 'subtree';
    t = t.slice(0, -3);
  } else if (t.endsWith('/')) {
    kind = 'subtree';
    t = t.slice(0, -1);
  }

  if (t.startsWith('./')) t = t.slice(2);

  t = t.replace(/\/+/g, '/');
  if (t.endsWith('/')) t = t.slice(0, -1);

  if (t.length === 0) {
    return { ok: false, reason: 'ambiguous whole-repo scope is not allowed' };
  }
  if (t === '.' || t === '..' || t.split('/').some((s) => s === '.' || s === '..')) {
    return { ok: false, reason: 'path traversal rejected: ' + JSON.stringify(raw) };
  }
  if (t.includes('*') || t.includes('?') || t.includes('[')) {
    return {
      ok: false,
      reason:
        'glob characters only allowed as a trailing /** subtree: ' + JSON.stringify(raw),
    };
  }
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(t)) {
    return { ok: false, reason: 'invalid path characters: ' + JSON.stringify(raw) };
  }

  return { ok: true, scope: { kind, path: t } };
}

/**
 * Normalize a list of declarations. Fails on any bad entry or internal
 * ambiguity (duplicate / overlapping scopes within the same declaration).
 */
export function normalizeAffectedPaths(raws: readonly string[]): NormalizePathsResult {
  if (raws.length === 0) {
    return { ok: false, reason: 'affected_paths must be a non-empty list' };
  }
  const scopes: PathScope[] = [];
  for (const raw of raws) {
    const one = normalizePathDeclaration(raw);
    if (!one.ok) return { ok: false, reason: one.reason };
    scopes.push(one.scope);
  }
  scopes.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0,
  );

  for (let i = 0; i < scopes.length; i += 1) {
    for (let j = i + 1; j < scopes.length; j += 1) {
      if (scopesOverlap(scopes[i]!, scopes[j]!)) {
        return {
          ok: false,
          reason:
            'ambiguous overlapping scopes in declaration: ' +
            formatScope(scopes[i]!) +
            ' overlaps ' +
            formatScope(scopes[j]!),
        };
      }
    }
  }
  return { ok: true, scopes };
}

export function formatScope(scope: PathScope): string {
  return scope.kind === 'subtree' ? scope.path + '/' : scope.path;
}

/** True when two scopes claim any common path. */
export function scopesOverlap(a: PathScope, b: PathScope): boolean {
  if (a.kind === 'exact' && b.kind === 'exact') return a.path === b.path;
  if (a.kind === 'exact' && b.kind === 'subtree') return pathUnderSubtree(a.path, b.path);
  if (a.kind === 'subtree' && b.kind === 'exact') return pathUnderSubtree(b.path, a.path);
  return pathUnderSubtree(a.path, b.path) || pathUnderSubtree(b.path, a.path);
}

function pathUnderSubtree(filePath: string, subtreeRoot: string): boolean {
  if (filePath === subtreeRoot) return true;
  return filePath.startsWith(subtreeRoot + '/');
}

/** Whether a concrete repo-relative file path falls inside a scope. */
export function pathInScope(filePath: string, scope: PathScope): boolean {
  const normalized = normalizeConcreteFilePath(filePath);
  if (normalized === null) return false;
  if (scope.kind === 'exact') return normalized === scope.path;
  return pathUnderSubtree(normalized, scope.path);
}

/** Normalize a concrete touched-file path (no globs; exact only). */
export function normalizeConcreteFilePath(raw: string): string | null {
  const decl = normalizePathDeclaration(raw);
  if (!decl.ok) return null;
  if (decl.scope.kind !== 'exact') return null;
  return decl.scope.path;
}

export type ScopeDiffVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly outOfScope: readonly string[] };

/** Revalidate actual touched files against declared scopes (pre review/merge). */
export function validateDiffAgainstScopes(
  filesTouched: readonly string[],
  scopes: readonly PathScope[],
): ScopeDiffVerdict {
  if (scopes.length === 0) {
    return { ok: false, outOfScope: [...filesTouched] };
  }
  const outOfScope: string[] = [];
  for (const f of filesTouched) {
    const norm = normalizeConcreteFilePath(f);
    // Git path bytes are evidence, not a declaration to canonicalize. A path
    // that becomes allowed only after trim/normalization must fail closed.
    if (norm === null || norm !== f || !scopes.some((s) => pathInScope(f, s))) {
      outOfScope.push(f);
    }
  }
  if (outOfScope.length > 0) return { ok: false, outOfScope };
  return { ok: true };
}

/** Sorted unique copy for stable snapshot compare. */
export function canonicalizeProtectedPathsSnapshot(
  paths: readonly string[],
): readonly string[] {
  const out = [...new Set(paths.map((p) => p.trim()).filter((p) => p.length > 0))];
  // Security digests must not depend on host locale/ICU collation data.
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

export type NormalizeProtectedPathsResult =
  | { readonly ok: true; readonly paths: readonly string[] }
  | { readonly ok: false; readonly reason: string };

function hasAsciiControlCharacter(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

/** Canonical validation for trusted WORKFLOW protected-path glob snapshots. */
export function normalizeProtectedPathsSnapshot(
  paths: readonly string[],
): NormalizeProtectedPathsResult {
  for (const raw of paths) {
    if (typeof raw !== 'string') {
      return { ok: false, reason: 'protected path entries must be strings' };
    }
    const path = raw.trim();
    if (
      path.length === 0 ||
      path.startsWith('/') ||
      path.startsWith('~') ||
      /^[A-Za-z]:/.test(path) ||
      path.includes('://') ||
      path.includes('\\') ||
      path.split('/').some((segment) => segment === '.' || segment === '..') ||
      hasAsciiControlCharacter(path)
    ) {
      return { ok: false, reason: `invalid protected path ${JSON.stringify(raw)}` };
    }
  }
  return { ok: true, paths: canonicalizeProtectedPathsSnapshot(paths) };
}

export function protectedPathsSnapshotsEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  const na = normalizeProtectedPathsSnapshot(a);
  const nb = normalizeProtectedPathsSnapshot(b);
  if (!na.ok || !nb.ok) return false;
  const ca = na.paths;
  const cb = nb.paths;
  if (ca.length !== cb.length) return false;
  for (let i = 0; i < ca.length; i += 1) {
    if (ca[i] !== cb[i]) return false;
  }
  return true;
}

/**
 * Path-lease enforcement posture derived from repository execution policy.
 * Guardian requires declarations and still enforces a single writer.
 */
export interface PathLeasePolicy {
  readonly requireDeclarations: boolean;
  /**
   * Hard cap on concurrent path-lease holders for the repo.
   * null -> use the repo maxConcurrent only.
   * Guardian forces 1 so disjoint scopes still cannot dual-write.
   */
  readonly maxWritersCap: number | null;
}

export function pathLeasePolicyFor(
  policy: Pick<EffectiveRepoExecutionPolicy, 'profile'>,
): PathLeasePolicy {
  if (policy.profile === 'guardian') {
    return { requireDeclarations: true, maxWritersCap: 1 };
  }
  return { requireDeclarations: false, maxWritersCap: null };
}

/** Effective writer limit: min(repo maxConcurrent, policy cap when set). */
export function effectivePathWriterLimit(
  repoMaxConcurrent: number,
  policy: PathLeasePolicy,
): number {
  const repo = Number.isFinite(repoMaxConcurrent)
    ? Math.max(1, Math.floor(repoMaxConcurrent))
    : 1;
  if (policy.maxWritersCap === null) return repo;
  return Math.max(1, Math.min(repo, policy.maxWritersCap));
}

export interface PathLeaseAcquireInput {
  readonly taskId: string;
  readonly runToken: string;
  readonly declaredBaseRevision: string | undefined;
  readonly declaredPaths: readonly string[] | undefined;
  readonly declaredProtectedSnapshot: readonly string[] | undefined;
  readonly trustedBaseRevision: string;
  readonly currentProtectedPaths: readonly string[];
  readonly held: readonly PathLeaseEntry[];
  readonly maxWriters: number;
  readonly requireDeclarations: boolean;
  readonly acquiredAtMs: number;
}

/**
 * Pure atomic acquire decision. Callers apply nextHeld under a mutex / CAS.
 * Labels and UI are not an enforcement boundary -- only this verdict is.
 */
export function decidePathLeaseAcquire(input: PathLeaseAcquireInput): PathLeaseAcquireVerdict {
  if (!isValidIdentifier(input.taskId)) {
    return { ok: false, reason: 'token_conflict', detail: 'task id is not a safe identifier' };
  }
  const token = input.runToken.trim();
  if (token.length === 0) {
    return { ok: false, reason: 'token_conflict', detail: 'run token must be non-empty' };
  }
  if (input.held.some((h) => h.runToken === token)) {
    return {
      ok: false,
      reason: 'token_conflict',
      detail: 'run token already holds a path lease',
    };
  }
  if (input.held.some((h) => h.taskId === input.taskId)) {
    return {
      ok: false,
      reason: 'prior_run_held',
      detail: 'task ' + input.taskId + ' still holds its prior run path lease',
      conflictingTaskIds: [input.taskId],
    };
  }

  const hasBase =
    typeof input.declaredBaseRevision === 'string' && input.declaredBaseRevision.trim().length > 0;
  const hasPaths = input.declaredPaths !== undefined && input.declaredPaths.length > 0;
  const hasProtectedSnapshot = input.declaredProtectedSnapshot !== undefined;

  if (!hasBase && !hasPaths && !hasProtectedSnapshot) {
    if (input.requireDeclarations) {
      return {
        ok: false,
        reason: 'missing_declaration',
        detail:
          'Guardian path leases require planned_base_revision, affected_paths, and ' +
          'protected_paths_snapshot; ' +
          'legacy tasks must be migrated or stay held for review',
      };
    }
    return {
      ok: true,
      entry: {
        taskId: input.taskId,
        runToken: token,
        baseRevision: '',
        scopes: [],
        protectedPathsSnapshot: [],
        acquiredAtMs: input.acquiredAtMs,
      },
      nextHeld: input.held,
    };
  }

  if (!hasBase || !hasPaths || !hasProtectedSnapshot) {
    return {
      ok: false,
      reason: 'missing_declaration',
      detail:
        'path lease declaration incomplete: planned_base_revision, affected_paths, and ' +
        'protected_paths_snapshot are required together',
    };
  }

  const base = input.declaredBaseRevision!.trim().toLowerCase();
  if (!isFullCommitSha(base)) {
    return {
      ok: false,
      reason: 'invalid_base',
      detail: 'planned_base_revision must be a full 40-char commit SHA',
    };
  }
  const trusted = input.trustedBaseRevision.trim().toLowerCase();
  if (!isFullCommitSha(trusted)) {
    return {
      ok: false,
      reason: 'invalid_base',
      detail: 'trusted default-branch tip is not a full commit SHA',
    };
  }
  if (base !== trusted) {
    return {
      ok: false,
      reason: 'stale_base',
      detail:
        'declared base ' +
        base.slice(0, 12) +
        ' is stale vs trusted tip ' +
        trusted.slice(0, 12) +
        '; re-plan against current default branch before dispatch',
    };
  }

  const normalized = normalizeAffectedPaths(input.declaredPaths!);
  if (!normalized.ok) {
    return { ok: false, reason: 'ambiguous_scope', detail: normalized.reason };
  }

  if (input.declaredProtectedSnapshot !== undefined) {
    const declaredProtected = normalizeProtectedPathsSnapshot(
      input.declaredProtectedSnapshot,
    );
    const currentProtected = normalizeProtectedPathsSnapshot(input.currentProtectedPaths);
    if (!declaredProtected.ok || !currentProtected.ok) {
      return {
        ok: false,
        reason: 'protected_path_drift',
        detail: !declaredProtected.ok
          ? declaredProtected.reason
          : currentProtected.ok
            ? 'invalid trusted protected-path snapshot'
            : currentProtected.reason,
      };
    }
    if (
      !protectedPathsSnapshotsEqual(
        declaredProtected.paths,
        currentProtected.paths,
      )
    ) {
      return {
        ok: false,
        reason: 'protected_path_drift',
        detail:
          'WORKFLOW protected_paths drifted since the task declaration; ' +
          're-review the plan before dispatch',
      };
    }
  }

  const maxWriters = Math.max(1, Math.floor(input.maxWriters));
  if (input.held.length >= maxWriters) {
    return {
      ok: false,
      reason: 'writer_limit',
      detail:
        'repository writer limit ' +
        String(maxWriters) +
        ' already reached (' +
        (input.held.map((h) => h.taskId).join(', ') || 'none') +
        ')',
      conflictingTaskIds: input.held.map((h) => h.taskId),
    };
  }

  const conflicting: string[] = [];
  for (const other of input.held) {
    for (const os of other.scopes) {
      for (const mine of normalized.scopes) {
        if (scopesOverlap(os, mine)) {
          if (!conflicting.includes(other.taskId)) conflicting.push(other.taskId);
        }
      }
    }
  }
  if (conflicting.length > 0) {
    return {
      ok: false,
      reason: 'path_overlap',
      detail: 'affected paths overlap active writers: ' + conflicting.join(', '),
      conflictingTaskIds: conflicting,
    };
  }

  const protectedSnapshot = normalizeProtectedPathsSnapshot(
    input.declaredProtectedSnapshot ?? input.currentProtectedPaths,
  );
  if (!protectedSnapshot.ok) {
    return {
      ok: false,
      reason: 'protected_path_drift',
      detail: protectedSnapshot.reason,
    };
  }

  const entry: PathLeaseEntry = {
    taskId: input.taskId,
    runToken: token,
    baseRevision: base,
    scopes: normalized.scopes,
    protectedPathsSnapshot: protectedSnapshot.paths,
    acquiredAtMs: input.acquiredAtMs,
  };

  return { ok: true, entry, nextHeld: [...input.held, entry] };
}

/** Release only when taskId + runToken both match (no steal). */
export function decidePathLeaseRelease(input: {
  readonly held: readonly PathLeaseEntry[];
  readonly taskId: string;
  readonly runToken: string;
}): PathLeaseReleaseVerdict {
  const at = input.held.findIndex((entry) => entry.taskId === input.taskId);
  if (at < 0) {
    return {
      ok: false,
      reason: 'not_found',
      detail: `task ${input.taskId} does not hold a path lease`,
    };
  }
  const entry = input.held[at]!;
  if (entry.runToken !== input.runToken) {
    return {
      ok: false,
      reason: 'token_mismatch',
      detail: `run token does not own task ${input.taskId}'s path lease`,
    };
  }
  return {
    ok: true,
    released: entry,
    nextHeld: input.held.filter((_, index) => index !== at),
  };
}

export interface ReclaimPathLeaseInput {
  readonly held: readonly PathLeaseEntry[];
  readonly liveRunTokens: ReadonlySet<string>;
  /**
   * Return true only when the exact persisted process identity is alive.
   * false proves it is stale; null means liveness is unknown and fails closed.
   */
  readonly ownerProcessAlive?: (entry: PathLeaseEntry) => boolean | null;
}

/**
 * Reclaim only owners proven dead. Missing/unknown process identity remains
 * held after restart; this is preferable to allowing two writers to overlap.
 */
export function reclaimStalePathLeases(input: ReclaimPathLeaseInput): {
  readonly nextHeld: readonly PathLeaseEntry[];
  readonly reclaimed: readonly PathLeaseEntry[];
  readonly uncertain: readonly PathLeaseEntry[];
} {
  const nextHeld: PathLeaseEntry[] = [];
  const reclaimed: PathLeaseEntry[] = [];
  const uncertain: PathLeaseEntry[] = [];
  for (const entry of input.held) {
    if (input.liveRunTokens.has(entry.runToken)) {
      nextHeld.push(entry);
      continue;
    }
    const alive = input.ownerProcessAlive?.(entry) ?? null;
    if (alive === false) {
      reclaimed.push(entry);
      continue;
    }
    nextHeld.push(entry);
    if (alive === null) uncertain.push(entry);
  }
  return { nextHeld, reclaimed, uncertain };
}

/** Synthetic verifier gate for actual changes outside the declared scope. */
export function outOfScopeDiffGate(outOfScope: readonly string[]): {
  readonly name: string;
  readonly command: string;
  readonly passed: false;
  readonly output: string;
} {
  return {
    name: 'path-lease-scope',
    command: 'hercules:path-lease-scope',
    passed: false,
    output: `actual diff escaped affected_paths: ${formatPathEvidenceList(outOfScope)}`,
  };
}

/** Log/Markdown-safe path evidence. JSON quoting escapes controls and newlines. */
export function formatPathEvidenceList(paths: readonly string[]): string {
  return paths.map((path) => JSON.stringify(path)).join(', ');
}

export function formatPathLeaseBlockMessage(
  reason: PathLeaseAcquireReject,
  detail: string,
): string {
  const heading: Record<PathLeaseAcquireReject, string> = {
    missing_declaration: 'Missing path-lease declaration',
    ambiguous_scope: 'Ambiguous affected paths',
    invalid_base: 'Invalid planned base',
    stale_base: 'Stale base',
    path_overlap: 'Path overlap',
    writer_limit: 'Writer limit reached',
    protected_path_drift: 'Protected-path policy drift',
    prior_run_held: 'Prior writer still active',
    token_conflict: 'Path-lease ownership conflict',
  };
  return `**${heading[reason]}:** ${detail}`;
}

/** Input for the narrowly bounded first-time one-file WORKFLOW bootstrap. */
export interface WorkflowBootstrapEligibilityInput {
  /** Full 40-char trusted default-branch tip (reachability is proven by caller). */
  readonly trustedRevision: string;
  /** null means the configured workflow is absent at the exact trusted revision. */
  readonly workflowContent: string | null;
  readonly repoReadiness: 'ready' | 'incomplete';
  readonly labels: readonly string[];
  readonly plannedBaseRevision: string | undefined;
  readonly affectedPaths: readonly string[] | undefined;
  readonly protectedPathsSnapshot: readonly string[] | undefined;
  readonly configuredWorkflowPath: string;
}

/**
 * The only missing-WORKFLOW carve-out: incomplete onboarding/readiness work
 * adding exactly the configured workflow from an exact base and empty policy
 * snapshot. All other path-lease decisions remain fail-closed.
 */
export function isFirstTimeWorkflowBootstrap(
  input: WorkflowBootstrapEligibilityInput,
): boolean {
  const trusted = input.trustedRevision.trim().toLowerCase();
  if (!isFullCommitSha(trusted)) return false;
  if (input.workflowContent !== null) return false;
  if (input.repoReadiness !== 'incomplete') return false;
  if (!taskHasOnboardingLabel(input.labels)) return false;

  const planned =
    typeof input.plannedBaseRevision === 'string'
      ? input.plannedBaseRevision.trim().toLowerCase()
      : '';
  if (!isFullCommitSha(planned) || planned !== trusted) return false;
  if (input.affectedPaths === undefined || input.protectedPathsSnapshot === undefined) {
    return false;
  }

  const workflowPath = normalizeConfiguredWorkflowPath(input.configuredWorkflowPath);
  if (workflowPath === null) return false;
  const normalized = normalizeAffectedPaths(input.affectedPaths);
  if (!normalized.ok || normalized.scopes.length !== 1) return false;
  const only = normalized.scopes[0]!;
  if (only.kind !== 'exact' || only.path !== workflowPath) return false;

  const protectedSnap = normalizeProtectedPathsSnapshot(input.protectedPathsSnapshot);
  return protectedSnap.ok && protectedSnap.paths.length === 0;
}

/** Normalize the repo-configured workflow path to a concrete exact file path. */
export function normalizeConfiguredWorkflowPath(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^\/+/, '');
  if (trimmed.length === 0) return null;
  return normalizeConcreteFilePath(trimmed);
}

export type WorkflowBootstrapVerifyVerdict =
  | { readonly ok: true; readonly workflowPath: string }
  | {
      readonly ok: false;
      readonly reason:
        | 'not_bootstrap'
        | 'wrong_paths'
        | 'missing_candidate'
        | 'malformed_candidate';
      readonly detail: string;
      readonly outOfScope?: readonly string[];
    };

export interface WorkflowBootstrapVerifyInput {
  readonly eligible: boolean;
  readonly configuredWorkflowPath: string;
  readonly filesTouched: readonly string[];
  /** Raw candidate WORKFLOW content; callers must never execute its commands. */
  readonly candidateContent: string | null;
  /** Pure parse probe: null on success, a safe error message on failure. */
  readonly parseCandidate: (content: string) => string | null;
}

/** Prove an eligible bootstrap changed exactly one workflow file and parses. */
export function verifyWorkflowBootstrapCandidate(
  input: WorkflowBootstrapVerifyInput,
): WorkflowBootstrapVerifyVerdict {
  if (!input.eligible) {
    return {
      ok: false,
      reason: 'not_bootstrap',
      detail: 'task is not a first-time WORKFLOW bootstrap',
    };
  }
  const workflowPath = normalizeConfiguredWorkflowPath(input.configuredWorkflowPath);
  if (workflowPath === null) {
    return {
      ok: false,
      reason: 'wrong_paths',
      detail: 'configured workflow path is not a safe exact file path',
    };
  }
  const scopes = normalizeAffectedPaths([workflowPath]);
  if (!scopes.ok) {
    return { ok: false, reason: 'wrong_paths', detail: scopes.reason };
  }
  const scope = validateDiffAgainstScopes(input.filesTouched, scopes.scopes);
  if (!scope.ok) {
    return {
      ok: false,
      reason: 'wrong_paths',
      detail:
        'bootstrap candidate must change only ' +
        workflowPath +
        '; out of scope: ' +
        scope.outOfScope.join(', '),
      outOfScope: scope.outOfScope,
    };
  }
  const touchedExact = input.filesTouched
    .map((file) => normalizeConcreteFilePath(file) ?? file.trim())
    .filter((file) => file.length > 0);
  if (touchedExact.length === 0) {
    return {
      ok: false,
      reason: 'missing_candidate',
      detail: 'bootstrap candidate did not add ' + workflowPath,
    };
  }
  if (!touchedExact.includes(workflowPath)) {
    return {
      ok: false,
      reason: 'wrong_paths',
      detail: 'bootstrap candidate must include ' + workflowPath,
      outOfScope: touchedExact,
    };
  }
  if (touchedExact.length !== 1 || touchedExact[0] !== workflowPath) {
    return {
      ok: false,
      reason: 'wrong_paths',
      detail:
        'bootstrap candidate must change exactly one path: ' +
        workflowPath +
        '; got: ' +
        touchedExact.join(', '),
      outOfScope: touchedExact.filter((path) => path !== workflowPath),
    };
  }
  if (input.candidateContent === null || input.candidateContent.trim().length === 0) {
    return {
      ok: false,
      reason: 'missing_candidate',
      detail: 'bootstrap candidate content missing at ' + workflowPath,
    };
  }
  const parseError = input.parseCandidate(input.candidateContent);
  if (parseError !== null) {
    return {
      ok: false,
      reason: 'malformed_candidate',
      detail: 'bootstrap candidate WORKFLOW failed to parse: ' + parseError,
    };
  }
  return { ok: true, workflowPath };
}

/** Synthetic L1 evidence row for parse-only bootstrap verification. */
export function workflowBootstrapGate(verdict: WorkflowBootstrapVerifyVerdict): {
  readonly name: string;
  readonly command: string;
  readonly passed: boolean;
  readonly output: string;
} {
  if (verdict.ok) {
    return {
      name: 'workflow-bootstrap',
      command: 'hercules:workflow-bootstrap',
      passed: true,
      output:
        'first-time WORKFLOW bootstrap verified: exact path ' +
        verdict.workflowPath +
        ' parses; candidate commands not executed',
    };
  }
  return {
    name: 'workflow-bootstrap',
    command: 'hercules:workflow-bootstrap',
    passed: false,
    output: verdict.detail,
  };
}
