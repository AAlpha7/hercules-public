/**
 * Isolation layer — per-repo bare mirror + per-task worktree (SPEC §8.1, §8.2).
 *
 * Each target repo gets one local bare mirror; each task gets its own worktree
 * on its own branch (hercules/<task-id>) cut from that mirror. This gives
 * physical isolation: different repos can't touch each other, and two tasks of
 * the same repo share an object store but have independent working trees.
 *
 * The worktree path MUST resolve inside the isolation root (§10); since repo
 * keys and task ids are validated identifiers they cannot escape, but we assert
 * it anyway as defense in depth.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { isValidIdentifier } from '../domain/task.js';
import { formatWorktreeGcLogLine } from '../domain/worktreeGc.js';
import { BRANCH_PREFIX, branchFor, type Workspace } from '../domain/allocation.js';
import type { RepoConfig } from '../domain/repos.js';
import type { AutoMergeDiff } from '../domain/autoMerge.js';
import { parseGitNumstat } from '../domain/release.js';
import type { ManagedDisposition } from '../domain/workspaceSuccession.js';
import {
  filterRepoDocPaths,
  isRepoDocPath,
  isSafeRepoDocRelPath,
} from '../domain/repoDocs.js';
import {
  decideTaskBranchFetch,
  formatNotPropagatedEvent,
  formatSkipRewindEvent,
  mustKeepLocalTaskTip,
} from '../domain/mirrorFetch.js';
import {
  mirrorLogRateKey,
  shouldEmitRateLimitedLog,
} from '../domain/hostExecutor.js';
import { redactDependencyRecoveryText } from '../domain/dependencyRecovery.js';
import { assertSafeRepoUrl } from '../control/reposConfig.js';
import type { PortAllocator } from './ports.js';
import {
  inspectWorkRootOwnership,
} from './daemonLease.js';
import type { DaemonLeaseIdentity } from '../domain/daemonLease.js';
import { scopeFingerprint } from '../domain/daemonLease.js';
import {
  isFullCommitSha,
  shortLeaseSha,
  type TaskBranchLease,
} from '../domain/taskBranchLease.js';
import {
  pushTaskBranchWithExactLease,
  readRemoteTaskBranchTip,
  TaskBranchLeaseError,
} from './exactLeasePush.js';
import {
  observeEmptyTaskLease,
  type EmptyTaskLeaseProofResult,
} from './emptyTaskLeaseObserve.js';
import {
  applyProviderPushBoundary,
  ensureLinkedWorktreeUsable,
  ProviderPushBoundaryError,
} from './providerPushBoundary.js';

/** Snapshot of what a task's worktree left behind (used at teardown). */
export interface WorkspaceImpact {
  /** Uncommitted file count (staged + unstaged + untracked) in the worktree. */
  readonly changedFiles: number;
  /** Commits on the task branch ahead of the repo's default branch. */
  readonly localCommits: number;
  /** Whether the task branch already exists on origin. */
  readonly pushedRemote: boolean;
}

/**
 * Outcome of preserve → origin push (propagation). Empty events when quiet.
 * Case study 2026-07-30: silent push skip left verified tips only on the mirror.
 */
export interface PreserveResult {
  /** True when HERCULES_PUSH is on but the local tip is still not on origin. */
  readonly notPropagated: boolean;
  /** Operator-facing lines for packet / timeline (跳过回卷 / 未传播). */
  readonly events: readonly string[];
  /** New durable ownership after a successful publish; absent when unchanged. */
  readonly branchLease?: TaskBranchLease;
}

/** Queued mirror-policy events for the orchestrator to attach to task timelines. */
export interface MirrorBranchEvent {
  /** Task id derived from `hercules/<id>`, when the branch name is well-formed. */
  readonly taskId: string | null;
  readonly branch: string;
  readonly kind: 'skip_rewind' | 'not_propagated' | 'diverged_take_remote';
  readonly message: string;
}

const EMPTY_PRESERVE: PreserveResult = { notPropagated: false, events: [] };

/** Provisioning hints the orchestrator knows but the isolation layer cannot. */
export interface CreateOptions {
  /**
   * Whether this task has EVER reached a durable dispatch (`startedAt != null`).
   * Provision-only failures may increment attempts but still count as fresh.
   * When false, branch recovery heuristics are disabled: a missing branch is
   * simply cut from the default branch, and an existing branch pointing at
   * work unrelated to the task is reset. Live incident 2026-07-15: brand-new
   * tasks "recovered" other tasks' dangling commits and went to review on
   * foreign diffs. Omitted → legacy behavior (recovery allowed).
   */
  readonly hadPriorWork?: boolean;
  /**
   * Explicit clean-salvage seed: when the task branch is missing, create it at
   * this exact SHA (from audited task metadata). Never rewinds an existing tip
   * (agent progress after the fork is kept). Ordinary tasks omit this so they
   * never adopt foreign SHAs.
   */
  readonly seedFromSha?: string;
  /**
   * Trusted default-branch tip from the dependency gate proof. When set,
   * provisioning confirms the mirror tip still matches after fetch — closes
   * the TOCTOU where main moves between ancestry proof and worktree cut.
   */
  readonly expectedBaseTip?: string;
  /** Persisted ownership from task front matter; explicit null means create-only. */
  readonly expectedRemoteTip?: string | null;
  readonly expectedBaseRevision?: string;
}

/**
 * One-shot trusted-mirror ancestry proof for the dependency gate.
 * Tip is resolved once; every SHA is checked against that exact tip.
 */
export interface DefaultBranchAncestryProof {
  /** Trusted default-branch tip, or null when the mirror cannot answer. */
  readonly tip: string | null;
  /**
   * Per requested SHA: true / false when known; null when the object is
   * missing or the probe fails (stale — never treat as success).
   */
  readonly reachable: ReadonlyMap<string, boolean | null>;
}

export type StaleTaskBranchRecoveryResult =
  | {
      readonly kind: 'recovered';
      readonly lease: TaskBranchLease;
      readonly detail: string;
    }
  | {
      readonly kind: 'held';
      readonly code:
        | 'dirty_worktree'
        | 'foreign_candidate'
        | 'conflict'
        | 'concurrent_move'
        | 'base_moved'
        | 'recovery_failed';
      readonly detail: string;
      readonly nextAction: string;
    };

export type StaleTaskBranchRecoveryRollbackResult =
  | { readonly kind: 'rolled_back'; readonly detail: string }
  | {
      readonly kind: 'held';
      readonly code: 'concurrent_move' | 'recovery_failed';
      readonly detail: string;
      readonly nextAction: string;
    };

/** One immutable trusted default-branch revision plus policy content at it. */
export interface TrustedDefaultRevisionSnapshot {
  readonly revision: string;
  readonly workflowContent: string | null;
}

/** The orchestrator's view of workspace provisioning (dependency inversion). */
export interface Workspaces {
  /** Provision an isolated worktree for a task. */
  create(repo: RepoConfig, taskId: string, opts?: CreateOptions): Promise<Workspace>;
  /** Resolve the actual checked-out HEAD for a pre-dispatch ownership check. */
  workspaceHead?(workspace: Workspace): Promise<string | null>;
  /**
   * Read-only exact remote tip for `hercules/<taskId>` (null when absent).
   * Used by live-run ownership observe; never adopts or mutates refs.
   */
  readRemoteTaskRefTip?(repo: RepoConfig, taskId: string): Promise<string | null>;
  /**
   * True when `ancestor` is an ancestor of `descendant` (or equal) in the
   * trusted mirror. null when the probe cannot run.
   */
  isCommitAncestor?(
    repo: RepoConfig,
    ancestor: string,
    descendant: string,
  ): Promise<boolean | null>;
  /** Discard a worktree AND its branch (abandoned work). No-op if unknown. */
  remove(taskId: string): Promise<void>;
  /**
   * Commit the agent's work to the task branch and KEEP the branch (for review /
   * merge, SPEC §10), removing only the worktree checkout. No-op if unknown.
   * When push is enabled, attempts origin propagation and reports failures
   * (never silent — 2026-07-30 mirror-clobber case study).
   */
  preserve(taskId: string, message: string): Promise<PreserveResult>;
  /** Path-free, read-only truth about Hercules-managed task workspace state. */
  managedDisposition?(repoKey: string, taskId: string): Promise<ManagedDisposition>;
  /**
   * Drain queued mirror-policy events (skip-rewind / not-propagated / diverge)
   * for the orchestrator to attach to related task timelines. Optional for
   * NoopWorkspaces / test doubles.
   */
  drainMirrorEvents?(): MirrorBranchEvent[];
  /**
   * Report the git impact of a task's worktree (call BEFORE remove/preserve).
   * Returns null for an unknown task id.
   */
  inspect(taskId: string): Promise<WorkspaceImpact | null>;
  /**
   * Reclaim on-disk worktrees left by a previously crashed instance (SPEC §7,
   * restart safety). Scans `<root>/<repoKey>/<taskId>` directories; for each
   * taskId NOT in `keep` and NOT in `this.live`, removes the worktree and
   * scratch dir, and returns the reclaimed task ids. Called once on the first
   * tick of a new daemon process.
   */
  reclaimOrphans(keep: ReadonlySet<string>): Promise<string[]>;
  /**
   * Read the repo's WORKFLOW.md from the TRUSTED mirror default branch (never an
   * agent's worktree, §10) so its body can frame the agent's prompt. Null if the
   * repo has no WORKFLOW.md (or no mirror, e.g. NoopWorkspaces).
   * `maxStaleMs` opts into a short freshness window on the underlying mirror
   * refresh (create-path protected-path lint); omit for exact-tip callers.
   */
  readWorkflow(
    repo: RepoConfig,
    opts?: { readonly maxStaleMs?: number },
  ): Promise<string | null>;
  /** Resolve default tip once and read WORKFLOW from that exact commit. */
  readTrustedDefaultRevisionSnapshot?(
    repo: RepoConfig,
  ): Promise<TrustedDefaultRevisionSnapshot | null>;
  /**
   * Tip SHA of the trusted mirror default branch (release reconciler).
   * Null when no mirror / unknown.
   */
  defaultBranchHead?(repo: RepoConfig): Promise<string | null>;
  /**
   * Targeted refresh of the mirror default branch from origin, then its tip
   * (C3.51, release reconciler drift). Rate-limited; fetch failure falls back
   * to the on-disk tip. Null when no mirror / unknown.
   */
  refreshDefaultBranchHead?(repo: RepoConfig): Promise<string | null>;
  /**
   * Whether `sha` is an ancestor of (or equal to) the trusted default-branch
   * tip. Used by the dependency gate-merge barrier before dispatch.
   * - `true` / `false` when known
   * - `null` when the mirror cannot answer (missing mirror / missing object)
   */
  containsOnDefaultBranch?(repo: RepoConfig, sha: string): Promise<boolean | null>;
  /**
   * Atomic ancestry proof: resolve the default tip once, then check every SHA
   * against that exact tip. Prefer this over
   * repeated {@link containsOnDefaultBranch} calls (which re-resolve the tip).
   */
  proveDefaultBranchAncestry?(
    repo: RepoConfig,
    shas: readonly string[],
  ): Promise<DefaultBranchAncestryProof>;
  /**
   * Fetch origin's default branch into the trusted bare mirror.
   * Dispatch-time `gate_merge` proof calls this so a GitHub-observed factory
   * merge SHA is in the object store. Factory tasks never `create()`, so
   * without this the mirror stays stale and dependents hold forever.
   * Read paths (`defaultBranchHead`, UI) stay offline.
   * Returns true when the default tip is origin-fresh.
   */
  refreshTrustedDefault?(repo: RepoConfig): Promise<boolean>;
  /** Read-only exact-ref proof used to decide whether a preserved tip needs recovery. */
  exactCandidateContainsBase?(
    repo: RepoConfig,
    taskId: string,
    expectedTip: string,
    baseRevision: string,
  ): Promise<boolean | null>;
  /** Narrow read-only proof for a restarted base/null-tip first dispatch. */
  proveEmptyTaskLease?(
    repo: RepoConfig,
    taskId: string,
    expectedBaseRevision: string,
  ): Promise<EmptyTaskLeaseProofResult>;
  /**
   * Rebase one preserved exact-lease task branch onto an already proved
   * trusted tip. The implementation may rewrite only that task ref, using a
   * force-with-lease CAS; main/default is read-only.
   */
  recoverStaleTaskBranch?(
    repo: RepoConfig,
    taskId: string,
    trustedTip: string,
    lease: TaskBranchLease,
  ): Promise<StaleTaskBranchRecoveryResult>;
  /**
   * Compensate a published stale-candidate recovery when its durable control
   * receipt fails. Both local and remote rewinds are exact expected-new-tip
   * CAS operations; a concurrent writer is never overwritten.
   */
  rollbackStaleTaskBranchRecovery?(
    repo: RepoConfig,
    taskId: string,
    previousLease: TaskBranchLease,
    recoveredLease: TaskBranchLease,
  ): Promise<StaleTaskBranchRecoveryRollbackResult>;
  /**
   * Working directory for deploy/health shell commands (release reconciler).
   * Prefer a checkout that contains deploy scripts (`DEPLOY_CWD` / Hercules
   * WorkingDirectory); fall back to the bare mirror path.
   */
  deployCwd?(repo: RepoConfig): Promise<string> | string;
  /**
   * Commit SHAs in production..staging for Release packet task selection.
   * Exclusive of production; inclusive of staging when reachable.
   */
  rangeShas?(
    repo: RepoConfig,
    productionSha: string | null,
    stagingSha: string,
  ): Promise<ReadonlySet<string> | undefined>;
  /**
   * Range diff from the trusted mirror (production..staging) for promote
   * risk aggregates. Never from an agent worktree (release-8).
   */
  rangeDiff?(
    repo: RepoConfig,
    productionSha: string | null,
    stagingSha: string,
  ): Promise<{
    readonly files: readonly string[];
    readonly insertions: number;
    readonly deletions: number;
  } | null>;
  /**
   * numstat of `<defaultBranch>...<sha>` (merge-base, three-dot) from the
   * trusted mirror — auto-merge size/sensitive-path facts for one task branch.
   * Null when the mirror or the sha is unavailable (fail closed).
   */
  taskBranchDiff?(repo: RepoConfig, sha: string): Promise<AutoMergeDiff | null>;
  /**
   * Single-commit brief (subject + name-only + numstat) from the trusted
   * mirror — per-task area/size chips on the Releases panel.
   */
  commitDiffBrief?(
    repo: RepoConfig,
    sha: string,
  ): Promise<{
    readonly subject: string;
    readonly files: readonly string[];
    readonly insertions: number;
    readonly deletions: number;
  } | null>;
  /**
   * Locate the merge-service commit for `taskId` in production..staging
   * (`hercules: merge <id>` subject). Fallback when batch stamps share tip.
   */
  findTaskMergeCommit?(
    repo: RepoConfig,
    taskId: string,
    productionSha: string | null,
    stagingSha: string,
  ): Promise<string | null>;
  /**
   * Read any path from the trusted mirror default branch (SPEC §10). Used for
   * readiness soft-checks (AGENTS.md / CLAUDE.md). Null when missing.
   */
  readTrustedFile?(repo: RepoConfig, path: string): Promise<string | null>;
  /**
   * Best-effort full cleanup for a deleted task: worktree + scratch + local
   * branch (and live registry entry). Safe when the task is not currently live.
   */
  purgeTask?(repoKey: string, taskId: string): Promise<void>;
  /**
   * Verified-SHA invariant probe: does `hercules/<taskId>`'s tip still contain
   * the commit the last verification packet described? At most one commit on
   * top is tolerated, and only when that tip's tree is identical to the
   * verified commit's tree (empty/tree-identical preserve auto-commit).
   * Returns the accepted tip SHA to pin for merge (never re-resolve the branch).
   */
  preservedTipStatus?(
    repoKey: string,
    taskId: string,
    verifiedSha: string,
  ): Promise<{ ok: boolean; tip: string | null; reason: string }>;
  /** Exact immutable candidate proof for the narrow path-lease amendment action. */
  inspectPreservedCandidate?(
    repo: RepoConfig,
    taskId: string,
    expectedTip: string,
    baseRevision: string,
  ): Promise<{
    readonly tip: string;
    readonly filesTouched: readonly string[];
    readonly trustedDefaultRevision: string;
    readonly workflowContentAtTrustedDefault: string | null;
  }>;
  /**
   * Disposable worktree of the current default-branch tip for a human
   * batch Merge (design §3). Caller must dispose. Optional — only real
   * GitWorkspaces provides it.
   */
  openMergeWorktree?(repo: RepoConfig): Promise<MergeWorktreeHandle>;
  /**
   * Disk hygiene GC for terminal tasks past retention (policy lives in domain).
   * Removes on-disk worktrees + scratch for the given targets; optionally
   * purges screenshot dirs. **Never** deletes local or remote `hercules/<id>`
   * branches (salvage until/after retention). **Never** touches the control
   * repo. Live map entries and `keep` ids are skipped. dryRun only reports.
   */
  gcTerminalArtifacts?(
    targets: readonly { readonly taskId: string; readonly repoKey: string }[],
    opts: GcTerminalArtifactsOpts,
  ): Promise<GcTerminalArtifactsResult>;
  /**
   * Explicit clean-salvage **read-only** resolve: return the preserved source
   * tip SHA and confirm the target branch is absent. **Never** creates, moves,
   * deletes, or force-pushes any branch. Target branch is created later by
   * {@link create} from stamped `seedFromSha` after control write/commit.
   */
  resolveSalvageSourceTip?(
    repo: RepoConfig,
    sourceTaskId: string,
    targetTaskId: string,
  ): Promise<{
    readonly sourceSha: string;
    readonly sourceBranch: string;
    readonly targetBranch: string;
  }>;
  /**
   * Verify-from-ref (C3.43) **read-only** resolve: an origin branch name or a
   * full commit SHA → the exact 40-hex commit it names on origin, fetched into
   * the mirror. Never creates, moves or deletes branches; rejects refs that do
   * not exist on origin.
   */
  resolveOriginRef?(repo: RepoConfig, ref: string): Promise<string>;
}

/**
 * Temp worktree of current main for safe batch Merge. All merges land here;
 * origin is pushed only after the full batch + L1 gates succeed. Never force-push.
 */
export interface MergeWorktreeHandle {
  readonly dir: string;
  /** True only when tracked, untracked, and ignored workspace state is clean. */
  isClean?(): Promise<boolean>;
  /** True when tracked and ordinary untracked files are clean; ignored build artifacts are allowed. */
  isTrackedAndUntrackedClean?(): Promise<boolean>;
  /**
   * `git merge --no-ff` of an immutable commit SHA (the tip accepted by
   * {@link Workspaces.preservedTipStatus}). Callers must not pass a moving
   * branch ref after the tip check — pin the checked SHA.
   */
  mergeNoFf(
    commitSha: string,
    message: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Name-only, no-renames diff between immutable commits (old + new on rename). */
  filesChangedBetween?(baseRevision: string, tipRevision: string): Promise<readonly string[]>;
  isAncestor?(ancestorRevision: string, descendantRevision: string): Promise<boolean>;
  mergeBase?(leftRevision: string, rightRevision: string): Promise<string | null>;
  readFileAt?(revision: string, repoRelativePath: string): Promise<string | null>;
  headSha(): Promise<string>;
  /**
   * Non-force push of HEAD → origin/<defaultBranch>. Refuses `--force`.
   * Updates the bare mirror default-branch ref to match on success.
   */
  pushDefaultBranch(repo: RepoConfig): Promise<void>;
  /** Read the canonical remote default ref without fetching or mutating a checkout. */
  canonicalDefaultHead?(repo: RepoConfig): Promise<string | null>;
  dispose(): Promise<void>;
}

/** Options for {@link Workspaces.gcTerminalArtifacts}. */
export interface GcTerminalArtifactsOpts {
  readonly dryRun: boolean;
  /** When true and screenshotsRoot set, remove screenshots/<taskId>. */
  readonly purgeScreenshots?: boolean;
  readonly screenshotsRoot?: string;
  /** Extra ids to never GC (in_progress / stopping), in addition to live map. */
  readonly keep?: ReadonlySet<string>;
  /** Retention days for the operator log line (policy already applied). */
  readonly retentionDays?: number;
}

/** Result of a GC pass (apply or dry-run). */
export interface GcTerminalArtifactsResult {
  readonly dryRun: boolean;
  /** Task ids whose worktree was removed (or would be, in dry-run). */
  readonly worktreesRemoved: readonly string[];
  /** Task ids whose screenshot dir was removed (or would be). */
  readonly screenshotsRemoved: readonly string[];
  /** Targets skipped because live / keep. */
  readonly skippedLive: readonly string[];
  /** Single operator digest line (also suitable for tick logs). */
  readonly logLine: string;
}

export class WorkspaceError extends Error {
  override readonly name = 'WorkspaceError';
}

const MIRRORS_DIR = '.mirrors';
const SCRATCH_DIR = '.scratch';
const MERGE_DIR = '.merge';

/** Best-effort cleanup of a disposable merge worktree + its temp branch. */
async function safeRemoveMergeWorktree(
  mirrorPath: string,
  dir: string,
  tempBranch?: string,
): Promise<void> {
  try {
    await simpleGit(mirrorPath).raw(['worktree', 'remove', '--force', dir]);
  } catch {
    // fall through to rm
  }
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
  try {
    await simpleGit(mirrorPath).raw(['worktree', 'prune']);
  } catch {
    // ignore
  }
  if (tempBranch) {
    try {
      await simpleGit(mirrorPath).raw(['branch', '-D', tempBranch]);
    } catch {
      // ignore missing
    }
  }
}
export interface GitWorkspacesOptions {
  /** Isolation root; all mirrors, worktrees and scratch live under it. */
  readonly root: string;
  readonly ports: PortAllocator;
  /** Push the preserved branch to origin (so a PR can be opened). */
  readonly push?: boolean;
  /** Injected clock for mirror skip rate-limit (tests / deterministic). */
  readonly clock?: () => number;
  /** Composition-root lease identity so reclaim sees our own lease as ours. */
  readonly leaseIdentity?: DaemonLeaseIdentity;
  /** Deterministic race hook for exact-candidate fetch regression tests. */
  readonly beforeExactCandidateFetch?: (branch: string) => Promise<void>;
  /** Deterministic race hook before the final remote-lease handoff check. */
  readonly beforeExactCandidateReturnVerify?: (branch: string) => Promise<void>;
  /** Deterministic race hook before an in-place exact-candidate fast-forward. */
  readonly beforeExactCandidateInPlaceUpdate?: (branch: string) => Promise<void>;
  /** Deterministic race hook before attaching an exact-candidate named branch. */
  readonly beforeExactCandidateBranchAttach?: (branch: string) => Promise<void>;
  /** Deterministic failure hook before detached-HEAD branch pinning. */
  readonly beforeTaskBranchPin?: (branch: string) => Promise<void>;
  /** Deterministic race hook immediately before stale-recovery local-ref CAS. */
  readonly beforeStaleRecoveryLocalCas?: (branch: string, rebasedTip: string) => Promise<void>;
  /** Deterministic race hook immediately before compensated remote rollback. */
  readonly beforeStaleRecoveryRollbackPush?: (branch: string) => Promise<void>;
}

export class GitWorkspaces implements Workspaces {
  private readonly root: string;
  private readonly ports: PortAllocator;
  private readonly push: boolean;
  private readonly clock: () => number;
  private readonly leaseIdentity: DaemonLeaseIdentity | undefined;
  private readonly beforeExactCandidateFetch:
    | ((branch: string) => Promise<void>)
    | undefined;
  private readonly beforeExactCandidateReturnVerify:
    | ((branch: string) => Promise<void>)
    | undefined;
  private readonly beforeExactCandidateInPlaceUpdate:
    | ((branch: string) => Promise<void>)
    | undefined;
  private readonly beforeExactCandidateBranchAttach:
    | ((branch: string) => Promise<void>)
    | undefined;
  private readonly beforeTaskBranchPin: ((branch: string) => Promise<void>) | undefined;
  private readonly beforeStaleRecoveryLocalCas:
    | ((branch: string, rebasedTip: string) => Promise<void>)
    | undefined;
  private readonly beforeStaleRecoveryRollbackPush:
    | ((branch: string) => Promise<void>)
    | undefined;
  private readonly live = new Map<string, Workspace>();
  private readonly removed = new Set<string>();
  /** Default branch for each live task — needed by inspect() for rev-list base. */
  private readonly bases = new Map<string, string>();
  /** Live ownership; durable source is task front matter passed back into create. */
  private readonly branchLeases = new Map<string, TaskBranchLease>();
  /**
   * Branches reset by fresh-task provisioning (foreign tip quarantined). Their
   * next push may rewind origin — the no-rewind guard would otherwise keep the
   * polluted tip because it has "more commits ahead of main".
   */
  private readonly freshReset = new Set<string>();
  /** Mirror-policy events until the orchestrator drains them onto task bodies. */
  private readonly branchEvents: MirrorBranchEvent[] = [];
  /** One startup-only stale temp-ref cleanup per mirror; shared by concurrent creates. */
  private readonly exactFetchRefPrunes = new Map<string, Promise<void>>();
  /** Serialize named-ref mutations for one mirror/task branch. */
  private readonly taskBranchMutations = new Map<string, Promise<void>>();
  /** Fresh exact-candidate intents that generic mirror reconciliation must not touch. */
  private readonly exactCandidateProtections = new Map<string, number>();
  /**
   * Rate-limit identical skip/rewind console **and** durable audit entries
   * together. Changed branch/local/remote/reason fingerprints emit immediately.
   */
  private readonly mirrorLogRate = new Map<string, number>();
  /**
   * Last successful default-branch fetch + hercules/* reconcile per repo key.
   * Used only when a caller opts into `maxStaleMs` on {@link ensureMirror}.
   */
  private readonly mirrorFreshness = new Map<
    string,
    { readonly refreshedAt: number; readonly url: string; readonly defaultBranch: string }
  >();
  /**
   * Last successful targeted default-branch refresh per repo (C3.51). The
   * release reconciler judges staging drift from the mirror's default branch,
   * which otherwise only moves when something else touches the repo — three
   * promotes in a row waited on a manual mirror fetch (2026-09-12).
   */
  private readonly defaultBranchRefreshedAt = new Map<string, number>();
  /** Counts remote `git fetch --no-tags origin` attempts (test seam). */
  private remoteFetchAttempts = 0;

  constructor(opts: GitWorkspacesOptions) {
    this.root = resolve(opts.root);
    this.ports = opts.ports;
    this.push = opts.push ?? false;
    this.clock = opts.clock ?? (() => Date.now());
    this.leaseIdentity = opts.leaseIdentity;
    this.beforeExactCandidateFetch = opts.beforeExactCandidateFetch;
    this.beforeExactCandidateReturnVerify = opts.beforeExactCandidateReturnVerify;
    this.beforeExactCandidateInPlaceUpdate = opts.beforeExactCandidateInPlaceUpdate;
    this.beforeExactCandidateBranchAttach = opts.beforeExactCandidateBranchAttach;
    this.beforeTaskBranchPin = opts.beforeTaskBranchPin;
    this.beforeStaleRecoveryLocalCas = opts.beforeStaleRecoveryLocalCas;
    this.beforeStaleRecoveryRollbackPush = opts.beforeStaleRecoveryRollbackPush;
  }

  private taskBranchMutationKey(mirror: string, branch: string): string {
    return `${resolve(mirror)}\0${branch}`;
  }

  private protectExactCandidateBranch(mirror: string, branch: string): void {
    const key = this.taskBranchMutationKey(mirror, branch);
    this.exactCandidateProtections.set(key, (this.exactCandidateProtections.get(key) ?? 0) + 1);
  }

  private unprotectExactCandidateBranch(mirror: string, branch: string): void {
    const key = this.taskBranchMutationKey(mirror, branch);
    const remaining = (this.exactCandidateProtections.get(key) ?? 1) - 1;
    if (remaining <= 0) this.exactCandidateProtections.delete(key);
    else this.exactCandidateProtections.set(key, remaining);
  }

  private isExactCandidateBranchProtected(mirror: string, branch: string): boolean {
    return this.exactCandidateProtections.has(this.taskBranchMutationKey(mirror, branch));
  }

  private async withTaskBranchMutation<T>(
    mirror: string,
    branch: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = this.taskBranchMutationKey(mirror, branch);
    const previous = this.taskBranchMutations.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveWaiter) => {
      release = resolveWaiter;
    });
    const tail = previous.then(() => current);
    this.taskBranchMutations.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.taskBranchMutations.get(key) === tail) {
        this.taskBranchMutations.delete(key);
      }
    }
  }

  /**
   * Emit console + durable audit for a mirror skip only when the fingerprint
   * is new or the rate-limit window has elapsed. Both channels share one gate.
   */
  private emitMirrorSkip(
    kind: MirrorBranchEvent['kind'],
    branch: string,
    line: string,
    auditMessage: string = line,
  ): void {
    const key = mirrorLogRateKey(kind, branch, line);
    if (!shouldEmitRateLimitedLog(this.mirrorLogRate, key, this.clock())) return;
    console.error(line.startsWith('[hercules]') ? line : `[hercules] ${line}`);
    const taskId = taskIdFromHerculesBranch(branch);
    this.branchEvents.push({ taskId, branch, kind, message: auditMessage });
  }

  /** Non-audit console-only rate-limited log (advances / non-skip noise). */
  private emitMirrorLog(kind: string, branch: string, line: string): void {
    const key = mirrorLogRateKey(kind, branch, line);
    if (!shouldEmitRateLimitedLog(this.mirrorLogRate, key, this.clock())) return;
    console.error(line.startsWith('[hercules]') ? line : `[hercules] ${line}`);
  }

  drainMirrorEvents(): MirrorBranchEvent[] {
    return this.branchEvents.splice(0, this.branchEvents.length);
  }

  private recordBranchEvent(
    kind: MirrorBranchEvent['kind'],
    branch: string,
    message: string,
  ): void {
    const taskId = taskIdFromHerculesBranch(branch);
    this.branchEvents.push({ taskId, branch, kind, message });
  }

  async recoverStaleTaskBranch(
    repo: RepoConfig,
    taskId: string,
    trustedTip: string,
    lease: TaskBranchLease,
  ): Promise<StaleTaskBranchRecoveryResult> {
    if (!isValidIdentifier(taskId) || !isValidIdentifier(repo.key)) {
      return {
        kind: 'held',
        code: 'foreign_candidate',
        detail: 'unsafe repository or task identifier',
        nextAction: 'Correct the task/repository identifier before retrying.',
      };
    }
    const base = trustedTip.trim().toLowerCase();
    const candidate = lease.expectedRemoteTip?.trim().toLowerCase() ?? null;
    if (!isFullCommitSha(base) || candidate === null || !isFullCommitSha(candidate)) {
      return {
        kind: 'held',
        code: 'foreign_candidate',
        detail: 'recovery requires a full trusted tip and a non-null exact remote lease',
        nextAction: 'Re-acquire an exact task-branch lease before retrying.',
      };
    }

    const branch = branchFor(taskId);
    const mirrorPath = this.mirrorPath(repo.key);
    this.protectExactCandidateBranch(mirrorPath, branch);
    try {
      return await this.withTaskBranchMutation(mirrorPath, branch, async () => {
        const mirror = await this.ensureMirror(repo, { skipReconcileTaskBranch: branch });
        const mirrorGit = simpleGit(mirror);
        const originUrl = (await mirrorGit.raw(['remote', 'get-url', 'origin'])).trim();
        const tipNow = (await mirrorGit.revparse([repo.defaultBranch])).trim().toLowerCase();
        if (tipNow !== base) {
          return {
            kind: 'held',
            code: 'base_moved',
            detail: `trusted default tip moved from ${base.slice(0, 12)} to ${tipNow.slice(0, 12)}`,
            nextAction: 'Retry after Hercules proves dependency ancestry at the new default tip.',
          };
        }

        let remoteTip: string | null;
        try {
          remoteTip = await readRemoteTaskBranchTip(mirrorGit, originUrl, branch);
        } catch (err) {
          return {
            kind: 'held',
            code: 'recovery_failed',
            detail: `could not read the exact remote task ref: ${(err as Error).message}`.slice(0, 500),
            nextAction: 'Restore remote access and retry; the preserved branch was not rewritten.',
          };
        }
        if (remoteTip !== candidate) {
          return {
            kind: 'held',
            code: 'concurrent_move',
            detail: `remote task ref moved (expected ${shortLeaseSha(candidate)}, actual ${shortLeaseSha(remoteTip)})`,
            nextAction: 'Inspect the moved task ref and explicitly adopt or salvage it before retrying.',
          };
        }

        const branchRef = `refs/heads/${branch}`;
        let localTip: string | null = null;
        try {
          localTip = (await mirrorGit.revparse([branchRef])).trim().toLowerCase();
        } catch {
          localTip = null;
        }
        if (localTip !== null && localTip !== candidate) {
          return {
            kind: 'held',
            code: 'foreign_candidate',
            detail: `local task ref differs from its exact remote lease (${shortLeaseSha(localTip)} vs ${shortLeaseSha(candidate)})`,
            nextAction: 'Inspect and salvage the local task ref; Hercules will not discard divergent work.',
          };
        }

        const taskDir = this.confine(join(this.root, repo.key, taskId));
        const existingWorktree = (await pathExists(taskDir)) && (await this.isWorktree(taskDir));
        if ((await pathExists(taskDir)) && !existingWorktree) {
          return {
            kind: 'held',
            code: 'foreign_candidate',
            detail: 'the allocated task path exists but is not the expected Git worktree',
            nextAction: 'Inspect or move the foreign path, then retry recovery.',
          };
        }

        let recoveryDir: string | null = null;
        let recoveryGit: SimpleGit;
        if (existingWorktree) {
          recoveryGit = simpleGit(taskDir);
          const status = await recoveryGit.status();
          const head = (await recoveryGit.revparse(['HEAD'])).trim().toLowerCase();
          const checkedOut = (await recoveryGit.revparse(['--abbrev-ref', 'HEAD'])).trim();
          if (status.files.length > 0) {
            return {
              kind: 'held',
              code: 'dirty_worktree',
              detail: `preserved worktree has ${status.files.length} uncommitted path(s)`,
              nextAction: 'Commit or explicitly salvage the dirty worktree before retrying.',
            };
          }
          if (head !== candidate || checkedOut !== branch) {
            return {
              kind: 'held',
              code: 'foreign_candidate',
              detail: `preserved checkout does not match the exact leased branch (${checkedOut} at ${shortLeaseSha(head)})`,
              nextAction: 'Inspect the checkout and salvage its unique work before retrying.',
            };
          }
        } else {
          recoveryDir = this.confine(
            join(this.root, SCRATCH_DIR, repo.key, `rebase-${taskId}-${randomBytes(6).toString('hex')}`),
          );
          await mkdir(join(this.root, SCRATCH_DIR, repo.key), { recursive: true });
          await mirrorGit.raw(['worktree', 'add', '--detach', recoveryDir, candidate]);
          recoveryGit = simpleGit(recoveryDir);
        }

        const recoveryRef = `refs/hercules-recovery/${taskId}-${candidate.slice(0, 12)}`;
        try {
          await mirrorGit.raw(['update-ref', recoveryRef, candidate]);
          if (recoveryDir !== null) {
            // Same bare-inheritance hazard as openMergeWorktree: provider boundary
            // enables extensions.worktreeConfig on the shared mirror, so disposable
            // recovery trees inherit core.bare=true until worktree-local override.
            // Usable only — never provider deny-push (exact-CAS still publishes).
            // Inside try so finally still removes the worktree on usable failure.
            await ensureLinkedWorktreeUsable(recoveryDir);
          }
          try {
            await recoveryGit.raw([
              '-c', 'user.email=hercules@local',
              '-c', 'user.name=Hercules',
              'rebase', base,
            ]);
          } catch (err) {
            try {
              await recoveryGit.raw(['rebase', '--abort']);
            } catch (abortErr) {
              console.error(
                `[hercules] ${taskId}: recovery rebase abort failed; old tip retained at ` +
                  `${recoveryRef} — ${redactDependencyRecoveryText((abortErr as Error).message, 300)}`,
              );
            }
            return {
              kind: 'held',
              code: 'conflict',
              detail: `task-branch rebase conflicted and was aborted: ${(err as Error).message}`.slice(0, 700),
              nextAction: 'Resolve the conflict on the preserved task branch, then retry.',
            };
          }

          const rebasedTip = (await recoveryGit.revparse(['HEAD'])).trim().toLowerCase();
          const rebasedRecoveryRef =
            `refs/hercules-recovery/${taskId}-rebased-${rebasedTip.slice(0, 12)}`;
          await mirrorGit.raw(['update-ref', rebasedRecoveryRef, rebasedTip]);
          const stableTip = (await mirrorGit.revparse([repo.defaultBranch])).trim().toLowerCase();
          if (stableTip !== base) {
            return {
              kind: 'held',
              code: 'base_moved',
              detail: `trusted default tip moved during recovery (${shortLeaseSha(base)} to ${shortLeaseSha(stableTip)})`,
              nextAction: 'Retry so dependency ancestry can be proved at the new tip.',
            };
          }
          try {
            await recoveryGit.raw(['merge-base', '--is-ancestor', base, rebasedTip]);
          } catch {
            return {
              kind: 'held',
              code: 'recovery_failed',
              detail: 'rebased candidate does not contain the freshly proved trusted tip',
              nextAction: 'Inspect the recovery ref and retry from a clean exact candidate.',
            };
          }

          // Move the mirror ref first. Publishing before this exact CAS left a
          // crash/failure window where origin advanced while the durable lease
          // and local ownership ref still named the old candidate.
          if (!existingWorktree) {
            try {
              await this.beforeStaleRecoveryLocalCas?.(branch, rebasedTip);
              await mirrorGit.raw(['update-ref', branchRef, rebasedTip, localTip ?? '0'.repeat(40)]);
            } catch {
              return {
                kind: 'held',
                code: 'concurrent_move',
                detail: 'local task ref moved before exact stale-recovery publication',
                nextAction: 'Inspect the local task ref and both recovery refs; the remote lease remains unchanged.',
              };
            }
          } else {
            await this.beforeStaleRecoveryLocalCas?.(branch, rebasedTip);
            const exactLocalTip = (await mirrorGit.revparse([branchRef])).trim().toLowerCase();
            if (exactLocalTip !== rebasedTip) {
              return {
                kind: 'held',
                code: 'concurrent_move',
                detail: 'local checked-out task ref moved before exact stale-recovery publication',
                nextAction: 'Inspect the worktree and both recovery refs; the remote lease remains unchanged.',
              };
            }
          }

          let nextLease: TaskBranchLease;
          try {
            // Publish from the bare mirror (shared object store) so provider
            // worktree deny-push hooks cannot block Hercules exact-CAS recovery.
            nextLease = await pushTaskBranchWithExactLease({
              git: mirrorGit,
              originUrl,
              branch,
              localTip: rebasedTip,
              lease,
              allowOwnedReset: true,
            });
          } catch (err) {
            if (!existingWorktree) {
              try {
                await mirrorGit.raw(['update-ref', branchRef, candidate, rebasedTip]);
              } catch {
                return {
                  kind: 'held',
                  code: 'concurrent_move',
                  detail: 'remote publication failed and the local task ref moved before exact rollback',
                  nextAction: 'Inspect the local/remote task refs and both recovery refs; no concurrent ref was overwritten.',
                };
              }
            }
            const concurrent = err instanceof TaskBranchLeaseError && err.code === 'remote_changed';
            return {
              kind: 'held',
              code: concurrent ? 'concurrent_move' : 'recovery_failed',
              detail: `exact-lease task-ref update refused: ${(err as Error).message}`.slice(0, 500),
              nextAction: concurrent
                ? 'Inspect the concurrently moved ref; both old and rebased work remain reachable.'
                : 'Inspect the preserved recovery ref and restore remote access before retrying.',
            };
          }
          return {
            kind: 'recovered',
            lease: { ...nextLease, expectedBaseRevision: base },
            detail: `rebased ${shortLeaseSha(candidate)} onto ${shortLeaseSha(base)} as ${shortLeaseSha(rebasedTip)}`,
          };
        } finally {
          if (recoveryDir !== null) {
            try {
              await mirrorGit.raw(['worktree', 'remove', '--force', recoveryDir]);
            } catch (cleanupErr) {
              console.error(
                `[hercules] ${taskId}: generated recovery worktree cleanup failed — ` +
                  `${redactDependencyRecoveryText((cleanupErr as Error).message, 300)}`,
              );
            }
            await rm(recoveryDir, { recursive: true, force: true });
          }
        }
      });
    } catch (err) {
      return {
        kind: 'held',
        code: 'recovery_failed',
        detail: `stale-candidate recovery failed closed: ${(err as Error).message}`.slice(0, 700),
        nextAction: 'Inspect the preserved task branch and retry after correcting the reported condition.',
      };
    } finally {
      this.unprotectExactCandidateBranch(mirrorPath, branch);
    }
  }

  async exactCandidateContainsBase(
    repo: RepoConfig,
    taskId: string,
    expectedTip: string,
    baseRevision: string,
  ): Promise<boolean | null> {
    if (
      !isValidIdentifier(repo.key) ||
      !isValidIdentifier(taskId) ||
      !isFullCommitSha(expectedTip) ||
      !isFullCommitSha(baseRevision)
    ) return null;
    const branch = branchFor(taskId);
    const fetchedRef =
      `refs/hercules-fetch/${taskId}-base-${randomBytes(8).toString('hex')}`;
    let result: boolean | null = null;
    try {
      const mirror = await this.ensureMirror(repo, {
        requireFreshDefault: true,
        skipReconcileTaskBranch: branch,
      });
      const git = simpleGit(mirror);
      const originUrl = (await git.raw(['remote', 'get-url', 'origin'])).trim();
      const trustedTip = (
        await git.raw(['rev-parse', `refs/heads/${repo.defaultBranch}^{commit}`])
      ).trim().toLowerCase();
      if (trustedTip !== baseRevision.toLowerCase()) {
        throw new WorkspaceError('trusted base moved during exact-candidate ancestry proof');
      }
      if (await readRemoteTaskBranchTip(git, originUrl, branch) !== expectedTip.toLowerCase()) {
        throw new WorkspaceError('candidate moved during exact-candidate ancestry proof');
      }
      await git.raw([
        'fetch', '--no-tags', originUrl, `refs/heads/${branch}:${fetchedRef}`,
      ]);
      const fetchedTip = (await git.raw(['rev-parse', `${fetchedRef}^{commit}`])).trim().toLowerCase();
      if (fetchedTip !== expectedTip.toLowerCase()) {
        throw new WorkspaceError('candidate fetch moved during exact-candidate ancestry proof');
      }
      try {
        const common = (await git.raw(['merge-base', baseRevision, fetchedRef])).trim().toLowerCase();
        result = common === baseRevision.toLowerCase();
      } catch {
        result = false;
      }
    } catch {
      result = null;
    }
    try {
      const mirror = this.mirrorPath(repo.key);
      await simpleGit(mirror).raw(['update-ref', '-d', fetchedRef]);
    } catch {
      return null;
    }
    return result;
  }

  async rollbackStaleTaskBranchRecovery(
    repo: RepoConfig,
    taskId: string,
    previousLease: TaskBranchLease,
    recoveredLease: TaskBranchLease,
  ): Promise<StaleTaskBranchRecoveryRollbackResult> {
    if (!isValidIdentifier(taskId) || !isValidIdentifier(repo.key)) {
      return {
        kind: 'held',
        code: 'recovery_failed',
        detail: 'unsafe repository or task identifier during recovery rollback',
        nextAction: 'Inspect the task and repository identifiers before retrying.',
      };
    }
    const oldTip = previousLease.expectedRemoteTip?.trim().toLowerCase() ?? null;
    const newTip = recoveredLease.expectedRemoteTip?.trim().toLowerCase() ?? null;
    if (oldTip === null || newTip === null || !isFullCommitSha(oldTip) || !isFullCommitSha(newTip)) {
      return {
        kind: 'held',
        code: 'recovery_failed',
        detail: 'recovery rollback requires full old and new exact task tips',
        nextAction: 'Inspect both recovery refs and explicitly restore a verified exact lease.',
      };
    }

    const branch = branchFor(taskId);
    const branchRef = `refs/heads/${branch}`;
    const mirrorPath = this.mirrorPath(repo.key);
    this.protectExactCandidateBranch(mirrorPath, branch);
    try {
      return await this.withTaskBranchMutation(mirrorPath, branch, async () => {
        const mirror = await this.ensureMirror(repo, { skipReconcileTaskBranch: branch });
        const git = simpleGit(mirror);
        const originUrl = (await git.raw(['remote', 'get-url', 'origin'])).trim();
        await git.raw([
          'update-ref',
          `refs/hercules-recovery/${taskId}-${oldTip.slice(0, 12)}`,
          oldTip,
        ]);
        await git.raw([
          'update-ref',
          `refs/hercules-recovery/${taskId}-rebased-${newTip.slice(0, 12)}`,
          newTip,
        ]);

        try {
          await pushTaskBranchWithExactLease({
            git,
            originUrl,
            branch,
            localTip: oldTip,
            lease: {
              expectedBaseRevision: recoveredLease.expectedBaseRevision,
              expectedRemoteTip: newTip,
            },
            allowOwnedReset: true,
            ...(this.beforeStaleRecoveryRollbackPush
              ? { beforePush: () => this.beforeStaleRecoveryRollbackPush!(branch) }
              : {}),
          });
        } catch (err) {
          const concurrent = err instanceof TaskBranchLeaseError && err.code === 'remote_changed';
          return {
            kind: 'held' as const,
            code: concurrent ? 'concurrent_move' as const : 'recovery_failed' as const,
            detail: concurrent
              ? 'remote task ref moved before exact recovery rollback'
              : 'remote exact recovery rollback failed',
            nextAction: 'Inspect the remote task ref and both recovery refs; no concurrent writer was overwritten.',
          };
        }

        const taskDir = this.confine(join(this.root, repo.key, taskId));
        const existingWorktree = (await pathExists(taskDir)) && (await this.isWorktree(taskDir));
        if (existingWorktree) {
          const worktreeGit = simpleGit(taskDir);
          try {
            await worktreeGit.raw(['checkout', '--detach', newTip]);
          } catch {
            return {
              kind: 'held',
              code: 'recovery_failed',
              detail: 'remote rollback succeeded but the clean recovery worktree could not detach',
              nextAction: 'Inspect the preserved worktree and both recovery refs before retrying.',
            };
          }
        }
        try {
          await git.raw(['update-ref', branchRef, oldTip, newTip]);
        } catch {
          return {
            kind: 'held',
            code: 'concurrent_move',
            detail: 'remote rollback succeeded but the local task ref moved before exact rollback',
            nextAction: 'Inspect the local task ref and both recovery refs; the durable remote lease is back at the old tip.',
          };
        }
        if (existingWorktree) {
          try {
            await simpleGit(taskDir).raw(['checkout', branch]);
          } catch {
            return {
              kind: 'held',
              code: 'recovery_failed',
              detail: 'refs rolled back but the preserved worktree could not reattach to its task branch',
              nextAction: 'Reattach the preserved worktree to the task branch before retrying.',
            };
          }
        }
        return {
          kind: 'rolled_back',
          detail: `restored exact task lease ${shortLeaseSha(oldTip)} after receipt failure`,
        };
      });
    } catch {
      return {
        kind: 'held',
        code: 'recovery_failed',
        detail: 'stale-candidate recovery rollback failed closed',
        nextAction: 'Inspect the local/remote task refs and both recovery refs before retrying.',
      };
    } finally {
      this.unprotectExactCandidateBranch(mirrorPath, branch);
    }
  }

  /**
   * Recovery contract for provision retry / resume (orbit-repo-readiness, 2026-07):
   * 1. Live map hit → return existing workspace (never wipe under a live agent).
   * 2. On-disk worktree at the expected path → reattach (no tip rewrite, no fetch
   *    into the checked-out branch).
   * 3. Mirror refresh force-syncs the default branch only; hercules/* uses the
   *    three-state policy (local ahead → keep; remote ahead → ff; diverge →
   *    follow remote). Never full-heads force-fetch into checked-out tips.
   * 4. Before `worktree add`, free any stray checkout of `hercules/<id>` so
   *    branch -f / worktree add cannot fatal; then rebuild at the task path.
   * 5. cleanWorktree is best-effort (plain leftover dirs are rm'd); partial state
   *    must not leave the task un-dispatchable.
   * Cancel still remove(deleteBranch); switch-now / preserve keep the branch and
   * reattach or rebuild via this path.
   *
   * Paths stay `confine(join(root, repo.key, taskId))` — one path per task id;
   * pin release never remaps task A onto task B's directory.
   */
  async create(repo: RepoConfig, taskId: string, opts?: CreateOptions): Promise<Workspace> {
    if (!isValidIdentifier(taskId)) {
      throw new WorkspaceError(`task id '${taskId}' is not a safe identifier`);
    }
    if (!isValidIdentifier(repo.key)) {
      throw new WorkspaceError(`repo key '${repo.key}' is not a safe identifier`);
    }
    const hasPersistedRemoteLease = Object.prototype.hasOwnProperty.call(
      opts ?? {},
      'expectedRemoteTip',
    );
    const exactCandidate = opts?.expectedRemoteTip?.trim().toLowerCase() ?? null;
    if (opts?.hadPriorWork !== false || !hasPersistedRemoteLease || exactCandidate === null) {
      return this.createUnlocked(repo, taskId, opts);
    }

    const branch = branchFor(taskId);
    const mirror = this.mirrorPath(repo.key);
    this.protectExactCandidateBranch(mirror, branch);
    try {
      return await this.withTaskBranchMutation(mirror, branch, () =>
        this.createUnlocked(repo, taskId, opts),
      );
    } finally {
      this.unprotectExactCandidateBranch(mirror, branch);
    }
  }

  private async createUnlocked(
    repo: RepoConfig,
    taskId: string,
    opts?: CreateOptions,
  ): Promise<Workspace> {
    if (!isValidIdentifier(taskId)) {
      throw new WorkspaceError(`task id '${taskId}' is not a safe identifier`);
    }
    if (!isValidIdentifier(repo.key)) {
      throw new WorkspaceError(`repo key '${repo.key}' is not a safe identifier`);
    }

    const expectedTip = opts?.expectedBaseTip?.trim();
    if (expectedTip && !/^[0-9a-f]{40}$/i.test(expectedTip)) {
      throw new WorkspaceError(
        `invalid expected dependency-gate base tip '${expectedTip}'`,
      );
    }
    const persistedBase = opts?.expectedBaseRevision?.trim().toLowerCase();
    if (persistedBase && !isFullCommitSha(persistedBase)) {
      throw new WorkspaceError(`invalid persisted branch-lease base for '${taskId}'`);
    }
    const hasPersistedRemoteLease = Object.prototype.hasOwnProperty.call(
      opts ?? {},
      'expectedRemoteTip',
    );
    const persistedRemote = opts?.expectedRemoteTip?.trim().toLowerCase() ?? null;
    if (hasPersistedRemoteLease && persistedRemote !== null && !isFullCommitSha(persistedRemote)) {
      throw new WorkspaceError(`invalid persisted branch-lease tip for '${taskId}'`);
    }
    const freshExactCandidate =
      opts?.hadPriorWork === false && hasPersistedRemoteLease ? persistedRemote : null;

    // Same process already owns this task — never wipe under a live agent
    // (double-dispatch / concurrent create used to cleanWorktree the active dir).
    const already = this.live.get(taskId);
    if (already) {
      if (already.repo !== repo.key) {
        throw new WorkspaceError(
          `task '${taskId}' already live under repo '${already.repo}', not '${repo.key}'`,
        );
      }
      if (expectedTip) {
        await this.assertExpectedBaseContained(
          simpleGit(already.dir),
          'HEAD',
          expectedTip,
          `live worktree ${taskId}`,
        );
      }
      const liveLease = already.branchLease ?? this.branchLeases.get(taskId);
      if (!liveLease) {
        throw new WorkspaceError(`live task '${taskId}' has no branch ownership lease`);
      }
      if (
        persistedBase !== undefined &&
        liveLease.expectedBaseRevision !== persistedBase
      ) {
        throw new WorkspaceError(
          `live task branch base lease changed (expected ${shortLeaseSha(persistedBase)}, ` +
            `owned ${shortLeaseSha(liveLease.expectedBaseRevision)})`,
        );
      }
      if (
        hasPersistedRemoteLease &&
        liveLease.expectedRemoteTip !== persistedRemote
      ) {
        throw new WorkspaceError(
          `live task branch lease changed (expected ${shortLeaseSha(persistedRemote)}, ` +
            `owned ${shortLeaseSha(liveLease.expectedRemoteTip)})`,
        );
      }
      const liveMirror = this.mirrorPath(repo.key);
      const liveGit = simpleGit(liveMirror);
      const liveOriginUrl = (await liveGit.raw(['remote', 'get-url', 'origin'])).trim();
      const actualRemoteTip = await readRemoteTaskBranchTip(
        liveGit,
        liveOriginUrl,
        already.branch,
      );
      if (actualRemoteTip !== liveLease.expectedRemoteTip) {
        throw new WorkspaceError(
          `live task branch exact lease changed before dispatch ` +
            `(expected ${shortLeaseSha(liveLease.expectedRemoteTip)}, ` +
            `actual ${shortLeaseSha(actualRemoteTip)})`,
        );
      }
      // Restart / re-dispatch: re-assert provider push boundary on the live tree.
      await this.applyProviderBoundary(already.dir, taskId);
      return already;
    }

    const branch = branchFor(taskId);
    const mirror = await this.ensureMirror(
      repo,
      freshExactCandidate === null ? {} : { skipReconcileTaskBranch: branch },
    );
    const dir = this.confine(join(this.root, repo.key, taskId));
    const scratchDir = this.confine(join(this.root, SCRATCH_DIR, repo.key, taskId));
    const mirrorGit = simpleGit(mirror);
    const originUrl = (await mirrorGit.raw(['remote', 'get-url', 'origin'])).trim();
    const actualRemoteTip = await readRemoteTaskBranchTip(mirrorGit, originUrl, branch);
    if (hasPersistedRemoteLease && persistedRemote !== actualRemoteTip) {
      throw new WorkspaceError(
        `task branch exact lease changed before dispatch ` +
          `(expected ${shortLeaseSha(persistedRemote)}, ` +
          `actual ${shortLeaseSha(actualRemoteTip)})`,
      );
    }
    const resolvedBase = (
      expectedTip ??
      persistedBase ??
      (await mirrorGit.revparse([repo.defaultBranch])).trim()
    ).toLowerCase();
    if (!isFullCommitSha(resolvedBase)) {
      throw new WorkspaceError(`could not resolve a full branch-lease base for '${taskId}'`);
    }
    const branchLease: TaskBranchLease = {
      expectedBaseRevision: resolvedBase,
      expectedRemoteTip: hasPersistedRemoteLease ? persistedRemote : actualRemoteTip,
    };

    // Dependency gate TOCTOU: after ensureMirror fetch, confirm the tip still
    // matches the ancestry proof used for dispatch. Mismatch → refuse before
    // any agent process starts (caller retries on a later tick).
    if (expectedTip) {
      try {
        const tipNow = (await simpleGit(mirror).revparse([repo.defaultBranch])).trim();
        if (!tipNow || tipNow.toLowerCase() !== expectedTip.toLowerCase()) {
          throw new WorkspaceError(
            `default branch tip moved during dependency gate ` +
              `(expected ${expectedTip}, got ${tipNow || 'unknown'})`,
          );
        }
      } catch (err) {
        if (err instanceof WorkspaceError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new WorkspaceError(
          `could not confirm expected base tip ${expectedTip}: ${msg}`,
        );
      }
    }

    let exactFetchRef: string | null = null;
    if (freshExactCandidate !== null) {
      // Prove the exact remote ref before inspecting, detaching, or deleting
      // any existing checkout. A failed fetch or moved ref leaves local work
      // untouched for recovery.
      exactFetchRef =
        `refs/hercules-fetch/${taskId}-` + randomBytes(8).toString('hex');
      let fetched = '';
      try {
        await this.beforeExactCandidateFetch?.(branch);
        await mirrorGit.raw([
          'fetch',
          '--no-tags',
          originUrl,
          `refs/heads/${branch}:${exactFetchRef}`,
        ]);
        fetched = (await mirrorGit.revparse([`${exactFetchRef}^{commit}`])).trim().toLowerCase();
      } catch {
        throw new WorkspaceError(
          `could not materialize exact persisted candidate for '${taskId}'`,
        );
      }
      if (fetched !== freshExactCandidate) {
        throw new WorkspaceError(
          `task branch exact lease changed while materializing '${taskId}' ` +
            `(expected ${shortLeaseSha(freshExactCandidate)}, ` +
            `actual ${shortLeaseSha(fetched || null)})`,
        );
      }
      await this.assertExpectedBaseContained(
        mirrorGit,
        exactFetchRef,
        resolvedBase,
        `exact candidate ${taskId}`,
      );
    }

    // Crash-restart path: worktree left on disk (reclaim kept in_progress ids).
    // Re-attach without cleanWorktree so uncommitted agent work survives.
    const existingTaskWorktree = (await pathExists(dir)) && (await this.isWorktree(dir));
    let reattachExisting = existingTaskWorktree && freshExactCandidate === null;
    if (existingTaskWorktree && freshExactCandidate !== null) {
      const existingGit = simpleGit(dir);
      await this.assertNoExactCandidatePins(mirrorGit, branch, dir, taskId);
      const existing = await this.inspectExactReplacementWorktree(dir, taskId);
      const existingHead = existing.head;
      if (existingHead !== freshExactCandidate) {
        if (existing.dirty) {
          throw new WorkspaceError(
            `exact candidate conflicts with dirty recovered worktree for '${taskId}' ` +
              `(expected ${shortLeaseSha(freshExactCandidate)}, ` +
              `actual ${shortLeaseSha(existingHead || null)})`,
          );
        }
        if (!(await descendsFrom(existingGit, existingHead, freshExactCandidate))) {
          throw new WorkspaceError(
            `exact candidate conflicts with unique recovered HEAD for '${taskId}' ` +
              `(candidate ${shortLeaseSha(freshExactCandidate)}, ` +
              `actual ${shortLeaseSha(existingHead || null)})`,
          );
        }
      }
      const checkedOutBranch = (
        await existingGit.revparse(['--abbrev-ref', 'HEAD'])
      ).trim();
      if (checkedOutBranch !== branch) {
        const branchRef = `refs/heads/${branch}`;
        let namedTip: string | null = null;
        try {
          namedTip = (await mirrorGit.revparse([branchRef])).trim().toLowerCase();
        } catch {
          namedTip = null;
        }
        if (
          namedTip !== null &&
          namedTip !== freshExactCandidate &&
          !(await descendsFrom(mirrorGit, namedTip, freshExactCandidate))
        ) {
          throw new WorkspaceError(
            `exact candidate conflicts with unique named branch tip for '${taskId}'`,
          );
        }
        await this.beforeExactCandidateBranchAttach?.(branch);
        try {
          await mirrorGit.raw([
            'update-ref',
            branchRef,
            existingHead,
            namedTip ?? '0'.repeat(40),
          ]);
        } catch {
          throw new WorkspaceError(
            `exact candidate named branch changed concurrently for '${taskId}'`,
          );
        }
        try {
          await existingGit.raw(['checkout', branch]);
        } catch {
          throw new WorkspaceError(
            `could not attach exact candidate checkout to '${branch}'`,
          );
        }
      }
      if (existingHead !== freshExactCandidate) {
        await this.beforeExactCandidateInPlaceUpdate?.(branch);
        try {
          await existingGit.raw(['merge', '--ff-only', freshExactCandidate]);
        } catch {
          throw new WorkspaceError(
            `could not safely fast-forward exact candidate checkout for '${taskId}'`,
          );
        }
        const after = await this.inspectExactReplacementWorktree(dir, taskId);
        if (after.head !== freshExactCandidate || after.dirty) {
          throw new WorkspaceError(
            `exact candidate checkout changed concurrently for '${taskId}'`,
          );
        }
      }
      reattachExisting = true;
    }
    if (reattachExisting) {
      if (expectedTip) {
        await this.assertExpectedBaseContained(
          simpleGit(dir),
          'HEAD',
          expectedTip,
          `recovered worktree ${taskId}`,
        );
      }
      if (freshExactCandidate !== null && exactFetchRef !== null) {
        await this.finalizeExactCandidateHandoff(
          mirrorGit,
          originUrl,
          branch,
          taskId,
          freshExactCandidate,
          exactFetchRef,
        );
        exactFetchRef = null;
      }
      await mkdir(scratchDir, { recursive: true });
      await this.applyProviderBoundary(dir, taskId);
      const port = await this.ports.acquire();
      const workspace: Workspace = {
        taskId,
        repo: repo.key,
        dir,
        branch,
        allocation: { slug: taskId, port, scratchDir },
        branchLease,
      };
      this.live.set(taskId, workspace);
      this.bases.set(taskId, repo.defaultBranch);
      this.branchLeases.set(taskId, branchLease);
      console.error(
        `[hercules] reattached existing worktree for ${taskId} at ${dir}`,
      );
      return workspace;
    }

    // Drop a stale checkout if present, but KEEP an existing task branch so
    // L3 auto-rework / human reject can continue from preserved commits.
    // A disposable review/agent worktree may still pin hercules/<id> elsewhere
    // ("already checked out" / branch -f fatal). Free it before tip recovery.
    if (freshExactCandidate !== null) {
      if (await pathExists(dir)) {
        throw new WorkspaceError(
          `exact candidate found an unknown directory at the worktree path for '${taskId}'`,
        );
      }
      await this.assertNoExactCandidatePins(mirrorGit, branch, dir, taskId);
    } else {
      await this.cleanWorktree(mirror, dir, branch, /* deleteBranch */ false);
      await this.releaseTaskBranchPins(mirror, repo.key, branch, dir);
    }

    await mkdir(join(this.root, repo.key), { recursive: true });
    const git = simpleGit(mirror);
    const seedSha = opts?.seedFromSha?.trim();
    if (freshExactCandidate !== null) {
      const ref = `refs/heads/${branch}`;
      let localTip: string | null = null;
      try {
        localTip = (await git.revparse([ref])).trim().toLowerCase();
      } catch {
        localTip = null;
      }
      if (
        localTip !== null &&
        localTip !== freshExactCandidate &&
        !(await descendsFrom(git, localTip, freshExactCandidate))
      ) {
        throw new WorkspaceError(
          `exact candidate conflicts with unique local branch tip for '${taskId}'`,
        );
      }
      try {
        await git.raw([
          'update-ref',
          ref,
          freshExactCandidate,
          localTip ?? '0'.repeat(40),
        ]);
      } catch {
        throw new WorkspaceError(
          `exact candidate local branch changed concurrently for '${taskId}'`,
        );
      }
    } else if (expectedTip && opts?.hadPriorWork === false) {
      if (
        seedSha &&
        /^[0-9a-f]{7,40}$/i.test(seedSha) &&
        (await git.revparse([seedSha])).trim().toLowerCase() !== expectedTip.toLowerCase()
      ) {
        throw new WorkspaceError(
          `fresh dependency-gated task ${taskId} cannot seed from ${seedSha}; ` +
            `branch must start exactly at ${expectedTip}`,
        );
      }
      // A never-started code consumer owns no prior work. Cut/reset its branch
      // exactly at the atomically proved base, even if a polluted ref exists.
      await git.raw(['branch', '-f', branch, expectedTip]);
      this.freshReset.add(branch);
    } else if (seedSha && /^[0-9a-f]{7,40}$/i.test(seedSha)) {
      // Explicit clean-salvage: create missing branch at the audited source tip.
      // First dispatch refuses foreign tips; re-provision allows seed or descendant.
      await this.ensureSalvageSeedBranch(git, branch, seedSha, {
        allowDescendant: opts?.hadPriorWork === true,
      });
    } else if (opts?.hadPriorWork === false) {
      // A task that never ran owns nothing: a missing branch is cut fresh from
      // the default branch, and an existing branch pointing at unrelated work
      // is pollution (2026-07-15 incident: recovery adopted other tasks'
      // dangling commits for brand-new tasks). No recovery heuristics here.
      await this.resetForeignFreshBranch(git, branch, taskId, repo.defaultBranch);
    } else {
      // Reuse the task branch when it already exists (L3 auto-rework / reject).
      // If the branch was deleted but commits remain in the mirror (orphan),
      // re-point hercules/<id> at the recovered tip before worktree add.
      await this.recoverTaskBranchIfMissing(git, branch, taskId, repo.defaultBranch);
      // If the branch tip is a git-stash node (WIP on / index on / …), rewind to a
      // real agent commit before checkout — otherwise reject/rework verifies trash.
      await this.sanitizeStashTipIfNeeded(git, branch, taskId, repo.defaultBranch);
      // Even when the branch already exists, prefer the tip with the most work
      // (ahead of main) among origin + local recover candidates. Case study:
      // origin was rewound to an older SHA while the feat tip still lived in the
      // mirror object store — reusing the branch tip alone kept the bad tip.
      await this.preferBestKnownTaskTip(git, branch, taskId, repo.defaultBranch);
    }

    if (expectedTip) {
      await this.assertExpectedBaseContained(
        git,
        `refs/heads/${branch}`,
        expectedTip,
        `task branch ${branch}`,
      );
    }
    try {
      await git.raw(['worktree', 'add', dir, branch]);
    } catch (firstErr) {
      if (freshExactCandidate !== null) {
        throw new WorkspaceError(
          `exact candidate worktree add failed for '${taskId}': ${(firstErr as Error).message}`,
        );
      }
      // Branch may still be pinned (race) or missing — free pins once more, then
      // either re-add existing branch or cut a fresh one from the default.
      // Clean-salvage: never fall back to default-branch tip (would drop seed).
      await this.releaseTaskBranchPins(mirror, repo.key, branch, dir);
      try {
        if (seedSha && /^[0-9a-f]{7,40}$/i.test(seedSha)) {
          await this.ensureSalvageSeedBranch(git, branch, seedSha, {
            allowDescendant: opts?.hadPriorWork === true,
          });
          await git.raw(['worktree', 'add', dir, branch]);
        } else {
          const branches = await git.branch();
          const has =
            branches.all.includes(branch) || branches.all.includes(`refs/heads/${branch}`);
          if (has) {
            await git.raw(['worktree', 'add', dir, branch]);
          } else {
            await git.raw([
              'worktree',
              'add',
              '-b',
              branch,
              dir,
              expectedTip ?? repo.defaultBranch,
            ]);
          }
        }
      } catch (secondErr) {
        const msg1 = (firstErr as Error).message;
        const msg2 = (secondErr as Error).message;
        throw new WorkspaceError(
          `worktree add failed for ${taskId} (${branch}): ${msg2} (earlier: ${msg1})`,
        );
      }
    }
    if (expectedTip) {
      await this.assertExpectedBaseContained(
        simpleGit(dir),
        'HEAD',
        expectedTip,
        `provisioned worktree ${taskId}`,
      );
    }
    if (freshExactCandidate !== null) {
      const checkedOutTip = (await simpleGit(dir).revparse(['HEAD'])).trim().toLowerCase();
      if (checkedOutTip !== freshExactCandidate) {
        throw new WorkspaceError(
          `exact persisted candidate checkout mismatch for '${taskId}' ` +
            `(expected ${shortLeaseSha(freshExactCandidate)}, ` +
            `actual ${shortLeaseSha(checkedOutTip)})`,
        );
      }
    }
    if (freshExactCandidate !== null && exactFetchRef !== null) {
      await this.finalizeExactCandidateHandoff(
        mirrorGit,
        originUrl,
        branch,
        taskId,
        freshExactCandidate,
        exactFetchRef,
      );
      exactFetchRef = null;
    }
    await mkdir(scratchDir, { recursive: true });
    await this.applyProviderBoundary(dir, taskId);

    const port = await this.ports.acquire();
    const workspace: Workspace = {
      taskId,
      repo: repo.key,
      dir,
      branch,
      allocation: { slug: taskId, port, scratchDir },
      branchLease,
    };
    this.live.set(taskId, workspace);
    this.bases.set(taskId, repo.defaultBranch);
    this.branchLeases.set(taskId, branchLease);
    return workspace;
  }

  /** Provider worktrees must not publish remote task refs (exact-CAS only). */
  private async applyProviderBoundary(dir: string, taskId: string): Promise<void> {
    try {
      await applyProviderPushBoundary(dir);
    } catch (err) {
      const detail =
        err instanceof ProviderPushBoundaryError
          ? err.message
          : (err as Error).message;
      throw new WorkspaceError(
        `provider push boundary failed for '${taskId}': ${detail}`.slice(0, 500),
      );
    }
  }

  async workspaceHead(workspace: Workspace): Promise<string | null> {
    const head = (await simpleGit(workspace.dir).revparse(['HEAD'])).trim().toLowerCase();
    return /^[0-9a-f]{40}$/.test(head) ? head : null;
  }

  /**
   * Read-only remote tip observation for live ownership. Never mutates refs
   * and never adopts a foreign tip into durable lease state.
   */
  async readRemoteTaskRefTip(repo: RepoConfig, taskId: string): Promise<string | null> {
    if (!isValidIdentifier(taskId) || !isValidIdentifier(repo.key)) {
      throw new WorkspaceError('task id / repo key is not a safe identifier');
    }
    const mirror = this.mirrorPath(repo.key);
    if (!(await pathExists(mirror))) {
      assertSafeRepoUrl(repo.url);
      return readRemoteTaskBranchTip(simpleGit(this.root), repo.url, branchFor(taskId));
    }
    const git = simpleGit(mirror);
    const originUrl = (await git.raw(['remote', 'get-url', 'origin'])).trim() || repo.url;
    return readRemoteTaskBranchTip(git, originUrl, branchFor(taskId));
  }

  async isCommitAncestor(
    repo: RepoConfig,
    ancestor: string,
    descendant: string,
  ): Promise<boolean | null> {
    if (!isValidIdentifier(repo.key)) return null;
    const a = ancestor.trim().toLowerCase();
    const d = descendant.trim().toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(a) || !/^[0-9a-f]{7,40}$/.test(d)) return null;
    if (a === d) return true;
    try {
      const mirrorPath = this.mirrorPath(repo.key);
      if (!(await pathExists(mirrorPath))) return null;
      const git = simpleGit(mirrorPath);
      // exit 0 ⇒ ancestor; exit 1 ⇒ not; other ⇒ null
      await git.raw(['merge-base', '--is-ancestor', a, d]);
      return true;
    } catch (err) {
      const msg = (err as Error).message ?? '';
      // simple-git throws on non-zero; treat as not-ancestor when exit 1 style
      if (/exit code 1|status code 1|failed with/i.test(msg) || msg.trim() === '') {
        // Distinguish missing objects: still null
        try {
          const mirrorPath = this.mirrorPath(repo.key);
          const git = simpleGit(mirrorPath);
          await git.raw(['cat-file', '-e', `${a}^{commit}`]);
          await git.raw(['cat-file', '-e', `${d}^{commit}`]);
          return false;
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  async remove(taskId: string): Promise<void> {
    await this.dispose(taskId, { deleteBranch: true });
    this.removed.add(taskId);
  }

  async managedDisposition(repoKey: string, taskId: string): Promise<ManagedDisposition> {
    if (!isValidIdentifier(repoKey) || !isValidIdentifier(taskId)) return 'unknown';
    const live = this.live.get(taskId);
    if (live?.repo === repoKey) return 'live';
    try {
      const mirror = this.mirrorPath(repoKey);
      if (await pathExists(mirror)) {
        const ref = (await simpleGit(mirror).raw([
          '--no-optional-locks', 'for-each-ref', '--format=%(objectname)',
          `refs/heads/${branchFor(taskId)}`,
        ])).trim();
        if (isFullCommitSha(ref)) return 'preserved';
      }
    } catch {
      // Absence and unreadability are distinguished below.
      if (await pathExists(this.mirrorPath(repoKey))) return 'unknown';
    }
    return this.removed.has(taskId) ? 'removed' : 'absent';
  }

  /**
   * Delete task artifacts even when not in {@link live} (human Delete cleanup).
   * Idempotent: missing dirs/branches are fine.
   */
  async purgeTask(repoKey: string, taskId: string): Promise<void> {
    if (!isValidIdentifier(taskId) || !isValidIdentifier(repoKey)) return;
    // Live first — frees port correctly.
    if (this.live.has(taskId)) {
      await this.dispose(taskId, { deleteBranch: true });
      return;
    }
    const mirror = this.mirrorPath(repoKey);
    const dir = this.confine(join(this.root, repoKey, taskId));
    const branch = branchFor(taskId);
    const scratchDir = this.confine(join(this.root, SCRATCH_DIR, repoKey, taskId));
    try {
      if (await pathExists(mirror)) {
        await this.cleanWorktree(mirror, dir, branch, true);
      } else if (await pathExists(dir)) {
        await rm(dir, { recursive: true, force: true });
      }
    } catch (err) {
      console.error(`[hercules] purgeTask ${taskId}: ${(err as Error).message}`);
    }
    await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }

  async preserve(taskId: string, message: string): Promise<PreserveResult> {
    const w = this.live.get(taskId);
    if (!w) {
      // Live entry already gone — still try orphan reattach so review keeps a tip.
      console.error(`[hercules] preserve ${taskId}: not live; attempting orphan reattach`);
      return EMPTY_PRESERVE;
    }

    const mirror = this.mirrorPath(w.repo);
    const base = this.bases.get(taskId) ?? 'main';
    const dirOk = await pathExists(w.dir);
    const events: string[] = [];

    if (dirOk) {
      // Commit whatever the agent changed, then **force-pin** hercules/<id> to
      // worktree HEAD. Agents often rebase onto detached HEAD or leave the
      // named branch behind; without pin, push skips and the tip is lost
      // (logout case study: hooks commit existed only as dangling objects).
      try {
        const git = simpleGit(w.dir);
        await git.add(['-A']);
        const status = await git.status();
        if (status.staged.length > 0) {
          await git.raw([
            '-c',
            'user.email=hercules@local',
            '-c',
            'user.name=Hercules',
            'commit',
            '-m',
            message,
          ]);
        }
        await this.withTaskBranchMutation(mirror, w.branch, () =>
          this.pinTaskBranchToHead(mirror, w.dir, w.branch),
        );
      } catch (err) {
        console.error(
          `[hercules] preserve ${taskId}: worktree commit/pin failed — ${(err as Error).message}`,
        );
        // Do not push the stale named branch or dispose the checkout: either can
        // misreport a noop while dropping the detached/unique HEAD.
        throw new WorkspaceError(
          `preserve refused because task branch pinning failed for '${taskId}'`,
        );
      }
    } else {
      // Case study logout: teardown saw missing worktree → simple-git threw →
      // branch never kept. Recover tip from dangling commits before dispose.
      console.error(
        `[hercules] preserve ${taskId}: worktree missing (${w.dir}); recovering branch on mirror`,
      );
      try {
        const mgit = simpleGit(mirror);
        await this.recoverTaskBranchIfMissing(mgit, w.branch, taskId, base);
      } catch (err) {
        console.error(
          `[hercules] preserve ${taskId}: orphan recover failed — ${(err as Error).message}`,
        );
      }
    }

    // Publish branch from the mirror (works even when worktree is gone).
    // Enabled when HERCULES_PUSH=1 so GitHub compare links stay live after review.
    // On failure: explicit 未传播 event — never silent leave-on-mirror-only.
    let notPropagated = false;
    let publishedLease: TaskBranchLease | undefined;
    if (this.push) {
      const pushResult = await this.pushTaskBranch(mirror, w.branch);
      publishedLease = pushResult.branchLease;
      if (pushResult.notPropagated) {
        notPropagated = true;
        const line = formatNotPropagatedEvent(w.branch, pushResult.detail);
        events.push(line);
        this.recordBranchEvent('not_propagated', w.branch, line);
        console.error(`[hercules] preserve ${taskId}: ${line}`);
      }
    }

    try {
      await this.dispose(taskId, { deleteBranch: false });
    } catch (err) {
      console.error(
        `[hercules] preserve ${taskId}: dispose failed — ${(err as Error).message}`,
      );
      // Still drop live tracking so the orchestrator does not wedge.
      this.live.delete(taskId);
      this.bases.delete(taskId);
      this.branchLeases.delete(taskId);
      this.freshReset.delete(w.branch);
    }

    return {
      notPropagated,
      events,
      ...(publishedLease ? { branchLease: publishedLease } : {}),
    };
  }

  /**
   * Read-only clean-salvage resolve: source tip SHA + target branch absence.
   * **Never** creates/moves/deletes the source or target branch. Control
   * write/commit stamps the SHA first; {@link create} with `seedFromSha` builds
   * the target branch on first provision.
   */
  /**
   * Verify-from-ref (C3.43): resolve an origin branch name or a full commit
   * SHA to the exact commit on origin and make sure the mirror holds it.
   * Read-only on origin and on the mirror's branch namespace.
   */
  async resolveOriginRef(repo: RepoConfig, ref: string): Promise<string> {
    if (!isValidIdentifier(repo.key)) {
      throw new WorkspaceError(`repo key '${repo.key}' is not a safe identifier`);
    }
    const trimmed = ref.trim();
    const isSha = /^[0-9a-f]{40}$/i.test(trimmed);
    if (
      !isSha &&
      (trimmed.length === 0 || trimmed.length > 200 || trimmed.startsWith('-') ||
        trimmed.startsWith('/') || trimmed.endsWith('/') || trimmed.endsWith('.lock') ||
        trimmed.includes('..') || trimmed.includes('//') || /[\s~^:?*[\\]/.test(trimmed) ||
        [...trimmed].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) ||
        trimmed.startsWith('refs/'))
    ) {
      throw new WorkspaceError(`seed ref '${ref}' is not a branch name or a full commit SHA`);
    }
    const mirror = await this.ensureMirror(repo);
    const git = simpleGit(mirror);
    const url = (await git.raw(['remote', 'get-url', 'origin'])).trim();
    if (!url) throw new WorkspaceError('mirror has no origin url');
    // Presence on ORIGIN is proven by ls-remote, never by the mirror's object
    // store (a SHA the mirror cached but origin dropped must not seed a task —
    // Claude round 21 N4). A bare SHA therefore has to be a current origin
    // head; anything older is named by its branch instead.
    let sha: string;
    if (isSha) {
      sha = trimmed.toLowerCase();
      const ls = (await git.raw(['ls-remote', '--heads', url])).trim();
      const isHead = ls.split('\n').some((entry) => entry.trim().toLowerCase().startsWith(`${sha}\t`));
      if (!isHead) {
        throw new WorkspaceError(
          `commit ${sha} is not the tip of any branch on origin — pass the branch name`,
        );
      }
    } else {
      const ls = (await git.raw(['ls-remote', '--heads', url, `refs/heads/${trimmed}`])).trim();
      const line = ls.split('\n').find((entry) => entry.trim().endsWith(`\trefs/heads/${trimmed}`));
      const found = (line?.split(/\s+/)[0] ?? '').trim().toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(found)) {
        throw new WorkspaceError(`branch '${trimmed}' does not exist on origin`);
      }
      sha = found;
    }
    try {
      await git.raw(['fetch', '--no-tags', url, sha]);
    } catch {
      /* the object may already be local */
    }
    try {
      await git.raw(['cat-file', '-e', `${sha}^{commit}`]);
    } catch {
      throw new WorkspaceError(`commit ${sha} does not exist on origin`);
    }
    return sha;
  }

  async resolveSalvageSourceTip(
    repo: RepoConfig,
    sourceTaskId: string,
    targetTaskId: string,
  ): Promise<{
    readonly sourceSha: string;
    readonly sourceBranch: string;
    readonly targetBranch: string;
  }> {
    if (!isValidIdentifier(sourceTaskId)) {
      throw new WorkspaceError(`source task id '${sourceTaskId}' is not a safe identifier`);
    }
    if (!isValidIdentifier(targetTaskId)) {
      throw new WorkspaceError(`target task id '${targetTaskId}' is not a safe identifier`);
    }
    if (!isValidIdentifier(repo.key)) {
      throw new WorkspaceError(`repo key '${repo.key}' is not a safe identifier`);
    }
    if (sourceTaskId === targetTaskId) {
      throw new WorkspaceError('source and target task ids must be different');
    }

    const mirror = await this.ensureMirror(repo);
    const git = simpleGit(mirror);
    const sourceBranch = branchFor(sourceTaskId);
    const targetBranch = branchFor(targetTaskId);

    let sourceSha: string | null = null;
    try {
      sourceSha = (await git.raw(['rev-parse', `refs/heads/${sourceBranch}`])).trim();
    } catch {
      sourceSha = null;
    }
    if (!sourceSha) {
      const originSha = await this.resolveOriginTaskTip(git, sourceBranch);
      if (originSha) {
        try {
          await git.raw(['branch', sourceBranch, originSha]);
        } catch {
          await git.raw(['update-ref', `refs/heads/${sourceBranch}`, originSha]);
        }
        sourceSha = originSha;
      }
    }
    if (!sourceSha) {
      throw new WorkspaceError(
        `preserved branch ${sourceBranch} missing on mirror and origin — cannot seed a clean salvage fork`,
      );
    }
    if (!/^[0-9a-f]{7,40}$/i.test(sourceSha)) {
      throw new WorkspaceError(`invalid source tip SHA for ${sourceBranch}`);
    }
    // Normalize to full SHA for durable task metadata.
    sourceSha = (await git.raw(['rev-parse', sourceSha])).trim();
    if (!/^[0-9a-f]{40}$/i.test(sourceSha)) {
      throw new WorkspaceError(`source tip for ${sourceBranch} is not a full SHA`);
    }

    const branches = await git.branch();
    const targetExists =
      branches.all.includes(targetBranch) ||
      branches.all.includes(`refs/heads/${targetBranch}`);
    if (targetExists) {
      throw new WorkspaceError(
        `target branch ${targetBranch} already exists — refuse pre-create collision ` +
          `(resolve is read-only; provision owns branch creation)`,
      );
    }

    // Source tip re-check (immutable; no moves).
    const sourceAfter = (await git.raw(['rev-parse', `refs/heads/${sourceBranch}`])).trim();
    if (sourceAfter.toLowerCase() !== sourceSha.toLowerCase()) {
      throw new WorkspaceError(
        `source branch ${sourceBranch} moved during resolve — refusing (was ${sourceSha}, now ${sourceAfter})`,
      );
    }
    return { sourceSha, sourceBranch, targetBranch };
  }

  /**
   * Ensure salvage target branch exists at the audited seed SHA.
   * - Missing → create at seed.
   * - Existing exact seed → ok.
   * - Existing descendant of seed → ok only when `allowDescendant` (re-provision).
   * - Existing unrelated tip → fail closed (never silent keep).
   * Never rewinds a valid tip.
   */
  private async ensureSalvageSeedBranch(
    git: SimpleGit,
    branch: string,
    seedSha: string,
    opts: { readonly allowDescendant: boolean },
  ): Promise<void> {
    const full = (await git.raw(['rev-parse', seedSha])).trim();
    if (!/^[0-9a-f]{40}$/i.test(full)) {
      throw new WorkspaceError(`salvage seed SHA '${seedSha}' is not resolvable`);
    }
    try {
      const branches = await git.branch();
      const has =
        branches.all.includes(branch) || branches.all.includes(`refs/heads/${branch}`);
      if (!has) {
        await git.raw(['branch', branch, full]);
        console.error(
          `[hercules] salvage seed: created ${branch} at ${full.slice(0, 12)}`,
        );
        return;
      }
      const tip = (await git.raw(['rev-parse', `refs/heads/${branch}`])).trim();
      if (tip.toLowerCase() === full.toLowerCase()) {
        return;
      }
      if (opts.allowDescendant && (await descendsFrom(git, full, tip))) {
        // Re-provision after agent progress on the salvage branch.
        return;
      }
      throw new WorkspaceError(
        `salvage target branch ${branch} exists at unrelated tip ` +
          `${tip.slice(0, 12)} (seed ${full.slice(0, 12)}; ` +
          `${opts.allowDescendant ? 'not a seed descendant' : 'first dispatch requires exact seed'})`,
      );
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      throw new WorkspaceError(
        `failed to seed branch ${branch} at ${full.slice(0, 12)}: ${(err as Error).message}`,
      );
    }
  }

  /** Fail closed unless the actual branch/worktree contains the proved base. */
  private async assertExpectedBaseContained(
    git: SimpleGit,
    ref: string,
    expectedTip: string,
    context: string,
  ): Promise<void> {
    let actual = 'unknown';
    try {
      await git.raw(['cat-file', '-e', `${expectedTip}^{commit}`]);
      actual = (await git.raw(['rev-parse', `${ref}^{commit}`])).trim();
      if (
        actual.toLowerCase() !== expectedTip.toLowerCase() &&
        !(await descendsFrom(git, expectedTip, actual))
      ) {
        throw new Error('expected tip is not an ancestor');
      }
    } catch {
      throw new WorkspaceError(
        `task branch base mismatch during dependency gate: ${context} at ` +
          `${actual} does not contain expected ${expectedTip}`,
      );
    }
  }

  /**
   * Fresh-task branch ownership check: if `hercules/<taskId>` already exists
   * but none of its commits ahead of the default branch mention this task, it
   * is foreign work (cross-task contamination) — reset it to the default
   * branch. The foreign tips stay reachable by SHA on their own branches or
   * as dangling objects; nothing is rewritten, only this task's ref moves.
   */
  private async resetForeignFreshBranch(
    git: SimpleGit,
    branch: string,
    taskId: string,
    defaultBranch: string,
  ): Promise<void> {
    try {
      const branches = await git.branch();
      const has =
        branches.all.includes(branch) || branches.all.includes(`refs/heads/${branch}`);
      if (!has) return; // worktree add -b cuts it from the default branch
      const subjects = (
        await git.raw(['log', '--format=%s', `${defaultBranch}..${branch}`])
      )
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (subjects.length === 0) return; // branch is at (or behind) default — fine
      const needle = `hercules: ${taskId}`.toLowerCase();
      const related = subjects.some(
        (s) => s.toLowerCase().includes(needle) || taskSubjectLooksRelated(taskId, s),
      );
      if (related) return; // human-prepped or genuinely owned tip — keep it
      await git.raw(['branch', '-f', branch, defaultBranch]);
      this.freshReset.add(branch);
      console.error(
        `[hercules] fresh task ${taskId}: ${branch} pointed at ${subjects.length} ` +
          `commit(s) unrelated to this task — reset to ${defaultBranch} (foreign work stays reachable by SHA)`,
      );
    } catch (err) {
      console.error(
        `[hercules] resetForeignFreshBranch ${branch}: ${(err as Error).message}`,
      );
    }
  }

  /** Attach a detached task worktree without force-overwriting its named ref. */
  private async pinTaskBranchToHead(
    mirrorPath: string,
    worktreeDir: string,
    branch: string,
  ): Promise<void> {
    const wt = simpleGit(worktreeDir);
    const head = (await wt.raw(['rev-parse', 'HEAD'])).trim();
    if (!/^[0-9a-f]{7,40}$/i.test(head)) {
      throw new WorkspaceError(`cannot pin ${branch}: invalid HEAD`);
    }
    // Never pin a stash WIP node as the durable tip — walk to first-parent feat.
    let pinTo = head;
    try {
      const subj = (await wt.raw(['log', '-1', '--format=%s', head])).trim();
      if (isStashLikeSubject(subj)) {
        const cleaned = await resolveNonStashTip(wt, head, 'main');
        if (cleaned) {
          console.error(
            `[hercules] pin ${branch}: skipping stash HEAD ${head.slice(0, 12)} → ${cleaned.slice(0, 12)}`,
          );
          pinTo = cleaned;
        } else {
          console.error(
            `[hercules] pin ${branch}: refusing stash-like HEAD (${subj.slice(0, 48)})`,
          );
          throw new WorkspaceError(`cannot pin ${branch}: stash-like HEAD has no safe commit`);
        }
      }
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      /* proceed */
    }
    const abbrev = (await wt.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (abbrev === branch && pinTo === head) {
      // Already on the task branch; commits above advanced the tip.
      return;
    }

    const mirror = simpleGit(mirrorPath);
    const branchRef = `refs/heads/${branch}`;
    let namedTip: string | null = null;
    try {
      namedTip = (await mirror.revparse([branchRef])).trim().toLowerCase();
    } catch {
      namedTip = null;
    }
    if (
      namedTip !== null &&
      namedTip !== pinTo.toLowerCase() &&
      !(await descendsFrom(mirror, namedTip, pinTo))
    ) {
      throw new WorkspaceError(
        `cannot pin ${branch}: named ref has unique or concurrent work at ${namedTip.slice(0, 12)}`,
      );
    }

    const porcelain = await mirror.raw(['worktree', 'list', '--porcelain']);
    for (const entry of porcelain.split(/\n\n+/)) {
      const path = entry.match(/^worktree (.+)$/m)?.[1]?.trim();
      const checkedOut = entry.match(/^branch (.+)$/m)?.[1]?.trim();
      if (checkedOut !== branchRef || !path) continue;
      if (resolve(path) !== resolve(worktreeDir)) {
        throw new WorkspaceError(`cannot pin ${branch}: named ref is checked out elsewhere`);
      }
    }

    // Detached HEAD (rebase leave-behind) or wrong branch: advance the named
    // ref only by CAS, then attach HEAD symbolically without rewriting files.
    await this.beforeTaskBranchPin?.(branch);
    const recoveryRef =
      `refs/hercules-preserve/${taskIdFromHerculesBranch(branch) ?? 'task'}-` +
      randomBytes(8).toString('hex');
    await mirror.raw(['update-ref', recoveryRef, pinTo, '0'.repeat(40)]);
    let attached = false;
    try {
      await mirror.raw([
        'update-ref',
        branchRef,
        pinTo,
        namedTip ?? '0'.repeat(40),
      ]);
    } catch {
      throw new WorkspaceError(`cannot pin ${branch}: named ref changed concurrently`);
    }
    try {
      await wt.raw(['symbolic-ref', 'HEAD', branchRef]);
      const attachedHead = (await wt.revparse(['HEAD'])).trim().toLowerCase();
      const finalNamedTip = (await mirror.revparse([branchRef])).trim().toLowerCase();
      if (attachedHead !== pinTo.toLowerCase() || finalNamedTip !== pinTo.toLowerCase()) {
        throw new WorkspaceError(`cannot pin ${branch}: attached ref changed concurrently`);
      }
      attached = true;
    } finally {
      if (attached) {
        await mirror.raw(['update-ref', '-d', recoveryRef, pinTo]);
      } else {
        console.error(
          `[hercules] pin ${branch}: kept recovery ref ${recoveryRef} at ${pinTo.slice(0, 12)}`,
        );
      }
    }
    console.error(`[hercules] pinned ${branch} → ${pinTo.slice(0, 12)} (was ${abbrev})`);
  }

  /**
   * Push hercules/<id> to origin URL (bare mirrors cannot use refspecs on origin).
   * Returns whether the local tip ended up published — callers must surface
   * notPropagated instead of treating console.error as enough.
   */
  private async pushTaskBranch(
    mirrorPath: string,
    branch: string,
  ): Promise<{
    readonly notPropagated: boolean;
    readonly detail?: string;
    readonly branchLease?: TaskBranchLease;
  }> {
    try {
      const git = simpleGit(mirrorPath);
      const branches = await git.branch();
      const hasBranch =
        branches.all.includes(branch) || branches.all.includes(`refs/heads/${branch}`);
      if (!hasBranch) {
        // Loud: silent skip left origin at stale tips while packet claimed new SHAs.
        const detail =
          'branch ref missing on mirror (work may only exist as dangling objects)';
        console.error(`[hercules] push of ${branch} skipped — ${detail}`);
        return { notPropagated: true, detail };
      }
      const url = (await git.raw(['remote', 'get-url', 'origin'])).trim();
      const local = (await git.raw(['rev-parse', `refs/heads/${branch}`])).trim().toLowerCase();
      const taskId = taskIdFromHerculesBranch(branch);
      if (taskId === null) {
        return { notPropagated: true, detail: 'invalid task branch name' };
      }
      const lease = this.branchLeases.get(taskId);
      if (!lease) {
        return {
          notPropagated: true,
          detail: 'task branch ownership lease missing',
        };
      }
      const nextLease = await pushTaskBranchWithExactLease({
        git,
        originUrl: url,
        branch,
        localTip: local,
        lease,
        allowOwnedReset: this.freshReset.has(branch),
      });
      this.branchLeases.set(taskId, nextLease);
      return { notPropagated: false, branchLease: nextLease };
    } catch (err) {
      const detail =
        err instanceof TaskBranchLeaseError
          ? err.message
          : 'task branch exact-lease publication failed';
      console.error(`[hercules] push of ${branch} failed: ${detail}`);
      return { notPropagated: true, detail };
    }
  }

  async inspect(taskId: string): Promise<WorkspaceImpact | null> {
    const w = this.live.get(taskId);
    if (!w) return null;
    const git = simpleGit(w.dir);
    const status = await git.status();
    const changedFiles = status.files.length;

    const base = this.bases.get(taskId) ?? 'HEAD';
    let localCommits = 0;
    try {
      const out = await git.raw(['rev-list', '--count', `${base}..HEAD`]);
      localCommits = Number(out.trim()) || 0;
    } catch {
      // base branch ref not found (e.g. newly created mirror with no upstream ref);
      // safe default is 0 — the worktree has no known divergence
      localCommits = 0;
    }

    let pushedRemote = false;
    try {
      const url = (await git.raw(['remote', 'get-url', 'origin'])).trim();
      const ls = await git.raw(['ls-remote', '--heads', url, w.branch]);
      pushedRemote = ls.trim().length > 0;
    } catch {
      // remote unreachable or not configured — treat branch as not pushed
      pushedRemote = false;
    }

    return { changedFiles, localCommits, pushedRemote };
  }

  /**
   * Free worktrees/scratch (and optional screenshots) for terminal tasks past
   * retention. Does **not** delete local or remote branches — salvage stays
   * reachable via `hercules/<id>` on the mirror until a human hard-deletes.
   */
  async gcTerminalArtifacts(
    targets: readonly { readonly taskId: string; readonly repoKey: string }[],
    opts: GcTerminalArtifactsOpts,
  ): Promise<GcTerminalArtifactsResult> {
    const worktreesRemoved: string[] = [];
    const screenshotsRemoved: string[] = [];
    const skippedLive: string[] = [];
    const keep = opts.keep ?? new Set<string>();
    const dryRun = opts.dryRun;
    const purgeShots = opts.purgeScreenshots === true;
    const shotsRoot = opts.screenshotsRoot;

    for (const t of targets) {
      if (!isValidIdentifier(t.taskId) || !isValidIdentifier(t.repoKey)) continue;
      if (this.live.has(t.taskId) || keep.has(t.taskId)) {
        skippedLive.push(t.taskId);
        continue;
      }

      const dir = this.confine(join(this.root, t.repoKey, t.taskId));
      const scratchDir = this.confine(join(this.root, SCRATCH_DIR, t.repoKey, t.taskId));
      const hasWt = (await pathExists(dir)) && (await this.isWorktree(dir));
      if (hasWt) {
        if (!dryRun) {
          const mirror = this.mirrorPath(t.repoKey);
          const branch = branchFor(t.taskId);
          try {
            // deleteBranch: false — salvage branch must survive retention GC.
            if (await pathExists(mirror)) {
              await this.cleanWorktree(mirror, dir, branch, /* deleteBranch */ false);
            } else {
              await rm(dir, { recursive: true, force: true });
            }
          } catch (err) {
            console.error(
              `[hercules] worktree-gc ${t.taskId}: ${(err as Error).message}`,
            );
            await rm(dir, { recursive: true, force: true }).catch(() => undefined);
          }
          await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
          // Best-effort mirror hygiene: drop stale worktree metadata only.
          try {
            if (await pathExists(mirror)) {
              await simpleGit(mirror).raw(['worktree', 'prune', '--expire', 'now']);
            }
          } catch (err) {
            console.error(
              `[hercules] worktree-gc prune ${t.repoKey}: ${(err as Error).message}`,
            );
          }
        }
        worktreesRemoved.push(t.taskId);
      } else if (await pathExists(scratchDir)) {
        // Orphan scratch without a worktree (crashed mid-teardown).
        if (!dryRun) {
          await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
        }
        worktreesRemoved.push(t.taskId);
      }

      if (purgeShots && shotsRoot) {
        const shotDir = this.confineScreenshotDir(shotsRoot, t.taskId);
        if (shotDir && (await pathExists(shotDir))) {
          if (!dryRun) {
            await rm(shotDir, { recursive: true, force: true }).catch((err: unknown) => {
              console.error(
                `[hercules] worktree-gc screenshots ${t.taskId}: ${(err as Error).message}`,
              );
            });
          }
          screenshotsRemoved.push(t.taskId);
        }
      }
    }

    const logLine = formatWorktreeGcLogLine({
      dryRun,
      retentionDays: opts.retentionDays ?? 0,
      candidates: targets.length,
      worktrees: worktreesRemoved,
      screenshots: screenshotsRemoved,
      skippedLive,
    });
    console.error(logLine);
    return {
      dryRun,
      worktreesRemoved,
      screenshotsRemoved,
      skippedLive,
      logLine,
    };
  }

  /**
   * Confine a screenshots/<taskId> path under screenshotsRoot. Returns null if
   * the id is unsafe or would escape the root.
   */
  private confineScreenshotDir(screenshotsRoot: string, taskId: string): string | null {
    if (!isValidIdentifier(taskId)) return null;
    const root = resolve(screenshotsRoot);
    const dir = resolve(join(root, taskId));
    if (dir !== root && !dir.startsWith(root + sep)) return null;
    return dir;
  }

  async reclaimOrphans(keep: ReadonlySet<string>): Promise<string[]> {
    const reclaimed: string[] = [];
    // Another LIVE process owns this root → do not touch its worktrees.
    // B-022: composition-root lease is authoritative; this is defense-in-depth.
    const ownership = inspectWorkRootOwnership(
      this.root,
      this.leaseIdentity ? { identity: this.leaseIdentity } : {},
    );
    if (ownership.kind === 'live_foreign') {
      console.error(
        '[hercules] reclaimOrphans skipped - work root ' +
          scopeFingerprint(this.root) +
          ' is owned by live pid ' +
          String(ownership.owner.pid),
      );
      return reclaimed;
    }

    let rootEntries;
    try {
      rootEntries = await readdir(this.root, { withFileTypes: true });
    } catch {
      return reclaimed; // root doesn't exist yet — nothing to reclaim
    }

    for (const entry of rootEntries) {
      if (!entry.isDirectory()) continue;
      const repoKey = entry.name;
      if (repoKey === MIRRORS_DIR || repoKey === SCRATCH_DIR || repoKey === MERGE_DIR) continue;
      if (!isValidIdentifier(repoKey)) continue;

      const repoDir = join(this.root, repoKey);
      let taskEntries;
      try {
        taskEntries = await readdir(repoDir, { withFileTypes: true });
      } catch {
        continue; // can't read this dir — skip it
      }

      for (const taskEntry of taskEntries) {
        if (!taskEntry.isDirectory()) continue;
        const taskId = taskEntry.name;
        if (!isValidIdentifier(taskId)) continue;
        if (keep.has(taskId) || this.live.has(taskId)) continue;

        const dir = this.confine(join(this.root, repoKey, taskId));
        // Only reclaim ACTUAL git worktrees. A worktree has a `.git` gitdir
        // pointer; a plain directory that merely lives under the root (e.g. the
        // screenshots/ evidence store, which shares this root) does not — and
        // must never be deleted. Without this guard, every restart wiped the
        // behavioral screenshots.
        if (!(await this.isWorktree(dir))) continue;

        const mirror = this.mirrorPath(repoKey);
        const branch = branchFor(taskId);

        try {
          // Keep hercules/<id> branch tips across daemon restarts. Case study
          // settings-build: deleteBranch:true wiped the published tip; recover
          // then force-pushed an older dangling SHA and rewound origin.
          await this.cleanWorktree(mirror, dir, branch, /* deleteBranch */ false);
        } catch {
          // Mirror may not exist (e.g. root was cloned elsewhere); still clean up
          // the worktree directory directly so the residue doesn't accumulate.
          await rm(dir, { recursive: true, force: true });
        }

        await rm(join(this.root, SCRATCH_DIR, repoKey, taskId), {
          recursive: true,
          force: true,
        });
        reclaimed.push(taskId);
      }
    }

    return reclaimed;
  }

  /** True if `dir` is a git worktree. A linked worktree's `.git` is always a
   *  FILE (a `gitdir:` pointer) — never a directory (a full clone) or absent. */
  private async isWorktree(dir: string): Promise<boolean> {
    try {
      return (await stat(join(dir, '.git'))).isFile();
    } catch {
      return false; // no `.git` → not a worktree → must not be reclaimed
    }
  }

  /** Remove the worktree + scratch, free the port; optionally delete the branch. */
  private async dispose(taskId: string, opts: { deleteBranch: boolean }): Promise<void> {
    const w = this.live.get(taskId);
    if (!w) return;
    await this.cleanWorktree(this.mirrorPath(w.repo), w.dir, w.branch, opts.deleteBranch);
    await rm(w.allocation.scratchDir, { recursive: true, force: true });
    this.ports.release(w.allocation.port);
    this.live.delete(taskId);
    this.bases.delete(taskId);
    this.branchLeases.delete(taskId);
    this.freshReset.delete(w.branch);
  }

  /**
   * Read the repo's WORKFLOW.md from the trusted mirror default branch — NOT the
   * agent's worktree (SPEC §10), since its gate commands are executed. Returns
   * null if the repo has none. Refreshes the default-branch tip when possible.
   * Pass `maxStaleMs` to reuse a recent successful refresh (protected-path lint).
   */
  async readWorkflow(
    repo: RepoConfig,
    opts?: { readonly maxStaleMs?: number },
  ): Promise<string | null> {
    return this.readTrustedFile(repo, repo.workflow, opts);
  }

  /** @internal test seam — last successful remote refresh time for a repo key. */
  mirrorRefreshedAtForTest(repoKey: string): number | undefined {
    return this.mirrorFreshness.get(repoKey)?.refreshedAt;
  }

  /** @internal test seam — how many times ensureMirror spawned `git fetch origin`. */
  remoteFetchAttemptsForTest(): number {
    return this.remoteFetchAttempts;
  }

  async readTrustedDefaultRevisionSnapshot(
    repo: RepoConfig,
  ): Promise<TrustedDefaultRevisionSnapshot | null> {
    if (!isValidIdentifier(repo.key)) return null;
    const rel = repo.workflow.trim().replace(/^\/+/, '');
    if (rel.length === 0 || rel.includes('..') || rel.includes('\\')) return null;
    try {
      const mirror = await this.ensureMirror(repo, { requireFreshDefault: true });
      const git = simpleGit(mirror);
      const revision = (await git.revparse([repo.defaultBranch])).trim().toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(revision)) return null;
      try {
        const workflowContent = await git.show([`${revision}:${rel}`]);
        return { revision, workflowContent };
      } catch {
        return { revision, workflowContent: null };
      }
    } catch {
      return null;
    }
  }

  /**
   * Disposable worktree of current default-branch tip for human batch Merge.
   * Merges and L1 gates run here; origin is pushed only after success.
   * NEVER force-pushes. Uses a unique temp branch so the mirror default
   * branch is never pinned (would block fetch of main).
   */
  async openMergeWorktree(repo: RepoConfig): Promise<MergeWorktreeHandle> {
    if (!isValidIdentifier(repo.key)) {
      throw new WorkspaceError(`repo key '${repo.key}' is not a safe identifier`);
    }
    const mirror = await this.ensureMirror(repo);
    const stamp = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    // Temp branch name — must not equal defaultBranch (would pin mirror main).
    const tempBranch = `hercules-merge/${repo.key}-${stamp}`;
    const dir = this.confine(join(this.root, MERGE_DIR, repo.key, stamp));
    await mkdir(join(this.root, MERGE_DIR, repo.key), { recursive: true });
    const mirrorGit = simpleGit(mirror);
    try {
      // Cut a unique branch at default tip — leaves refs/heads/<default> free.
      await mirrorGit.raw([
        'worktree',
        'add',
        '-b',
        tempBranch,
        dir,
        repo.defaultBranch,
      ]);
    } catch (err) {
      throw new WorkspaceError(
        `merge worktree add failed for ${repo.key}: ${(err as Error).message}`,
      );
    }
    // Provider worktrees enable extensions.worktreeConfig on the shared bare
    // mirror; linked trees then inherit core.bare=true unless worktree-local
    // config overrides it. Make the merge checkout usable without installing
    // provider-only deny-push controls (merge must still push default after gates).
    try {
      await ensureLinkedWorktreeUsable(dir);
    } catch (err) {
      await safeRemoveMergeWorktree(mirror, dir, tempBranch);
      const detail =
        err instanceof ProviderPushBoundaryError
          ? err.message
          : (err as Error).message;
      throw new WorkspaceError(
        `merge worktree usable failed for ${repo.key}: ${detail}`.slice(0, 500),
      );
    }
    const wt = simpleGit(dir);
    // Identity for merge commits (bare mirrors / CI often lack user.*).
    await wt.addConfig('user.email', 'hercules@local', false, 'local');
    await wt.addConfig('user.name', 'Hercules', false, 'local');

    const dispose = (): Promise<void> =>
      safeRemoveMergeWorktree(mirror, dir, tempBranch);

    return {
      dir,
      async isClean() {
        const status = await wt.raw(['status', '--porcelain', '--untracked-files=all']);
        const ignored = await wt.raw(['ls-files', '--others', '--ignored', '--exclude-standard']);
        return status.trim().length === 0 && ignored.trim().length === 0;
      },
      async isTrackedAndUntrackedClean() {
        const status = await wt.raw(['status', '--porcelain', '--untracked-files=all']);
        return status.trim().length === 0;
      },
      async filesChangedBetween(baseRevision: string, tipRevision: string) {
        if (
          !/^[0-9a-f]{40}$/i.test(baseRevision) ||
          !/^[0-9a-f]{40}$/i.test(tipRevision)
        ) {
          throw new WorkspaceError('merge scope diff requires two full commit SHAs');
        }
        const raw = await wt.raw([
          'diff',
          '--name-only',
          '--no-renames',
          '-z',
          baseRevision,
          tipRevision,
          '--',
        ]);
        return raw.split('\0').filter((path) => path.length > 0);
      },
      async isAncestor(ancestorRevision: string, descendantRevision: string) {
        if (
          !/^[0-9a-f]{40}$/i.test(ancestorRevision) ||
          !/^[0-9a-f]{40}$/i.test(descendantRevision)
        ) return false;
        try {
          // simple-git raw may resolve (rather than reject) for
          // `merge-base --is-ancestor` exit 1. Compare the computed base
          // explicitly so non-ancestry can never become a false positive.
          const base = (await wt.raw([
            'merge-base',
            ancestorRevision,
            descendantRevision,
          ])).trim().toLowerCase();
          return base === ancestorRevision.toLowerCase();
        } catch {
          return false;
        }
      },
      async mergeBase(leftRevision: string, rightRevision: string) {
        if (
          !/^[0-9a-f]{40}$/i.test(leftRevision) ||
          !/^[0-9a-f]{40}$/i.test(rightRevision)
        ) return null;
        try {
          const base = (await wt.raw(['merge-base', leftRevision, rightRevision]))
            .trim()
            .toLowerCase();
          return /^[0-9a-f]{40}$/.test(base) ? base : null;
        } catch {
          return null;
        }
      },
      async readFileAt(revision: string, repoRelativePath: string) {
        const rel = repoRelativePath.trim().replace(/^\/+/, '');
        if (
          !/^[0-9a-f]{40}$/i.test(revision) ||
          rel.length === 0 ||
          rel.includes('..') ||
          rel.includes('\\')
        ) return null;
        try {
          return await wt.show([`${revision}:${rel}`]);
        } catch {
          return null;
        }
      },
      async mergeNoFf(commitSha: string, message: string) {
        const fail = async (reason: string) => {
          try {
            await wt.raw(['merge', '--abort']);
          } catch {
            // already clean or unmerged state cleared below
          }
          try {
            await wt.raw(['reset', '--hard', 'HEAD']);
            await wt.raw(['clean', '-fd']);
          } catch {
            // best-effort
          }
          return { ok: false as const, reason };
        };
        try {
          // Merge the pinned commit object, never a moving branch ref.
          await wt.raw(['merge', '--no-ff', '--no-edit', '-m', message, commitSha]);
        } catch (err) {
          return fail(
            `merge --no-ff ${commitSha.slice(0, 12)} failed: ${(err as Error).message.slice(0, 500)}`,
          );
        }
        // Defense-in-depth: some git/simple-git paths leave conflict markers
        // without a thrown error — unmerged index entries mean conflict.
        let unmerged = '';
        try {
          unmerged = (await wt.raw(['ls-files', '-u'])).trim();
        } catch {
          unmerged = '';
        }
        if (unmerged.length > 0) {
          return fail(
            `merge --no-ff ${commitSha.slice(0, 12)} failed: conflict (unmerged paths)`,
          );
        }
        return { ok: true as const };
      },
      async headSha() {
        return (await wt.raw(['rev-parse', 'HEAD'])).trim();
      },
      async pushDefaultBranch(r: RepoConfig) {
        // Explicit non-force: never pass --force / --force-with-lease.
        const url = r.url;
        const refspec = `HEAD:refs/heads/${r.defaultBranch}`;
        try {
          await wt.raw(['push', url, refspec]);
        } catch (err) {
          throw new WorkspaceError(
            `push ${r.defaultBranch} failed (never force-pushed): ${(err as Error).message}`,
          );
        }
        // Advance bare-mirror default branch to match what we just pushed.
        try {
          const sha = (await wt.raw(['rev-parse', 'HEAD'])).trim();
          await mirrorGit.raw(['update-ref', `refs/heads/${r.defaultBranch}`, sha]);
        } catch (err) {
          console.error(
            `[hercules] mirror update-ref ${r.key}/${r.defaultBranch} after merge push: ${(err as Error).message}`,
          );
        }
      },
      async canonicalDefaultHead(r: RepoConfig) {
        try {
          const raw = (await wt.raw([
            'ls-remote', '--heads', r.url, `refs/heads/${r.defaultBranch}`,
          ])).trim();
          const sha = raw.split(/\s+/)[0] ?? '';
          return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null;
        } catch {
          return null;
        }
      },
      dispose,
    };
  }

  /**
   * Read a path from the trusted mirror default branch. Ensures/refreshes the
   * mirror first so Mark-ready soft-checks see current origin tips.
   */
  async readTrustedFile(
    repo: RepoConfig,
    path: string,
    opts?: { readonly maxStaleMs?: number },
  ): Promise<string | null> {
    const rel = path.trim().replace(/^\/+/, '');
    if (rel.length === 0 || rel.includes('..')) return null;
    try {
      await this.ensureMirror(
        repo,
        opts?.maxStaleMs !== undefined ? { maxStaleMs: opts.maxStaleMs } : {},
      );
      return await simpleGit(this.mirrorPath(repo.key)).show([
        `${repo.defaultBranch}:${rel}`,
      ]);
    } catch {
      return null;
    }
  }

  /**
   * Files a task changed: default branch ... <sha> from the on-disk mirror
   * (offline — no fetch). Serves the phone review "what did it produce"
   * browse list. Empty on bad sha / missing mirror.
   */
  async listTaskFiles(repo: RepoConfig, sha: string): Promise<readonly string[]> {
    if (!/^[0-9a-f]{7,40}$/i.test(sha.trim())) return [];
    try {
      const out = await simpleGit(this.mirrorPath(repo.key)).raw([
        'diff', '--name-only', `${repo.defaultBranch}...${sha.trim()}`,
      ]);
      return out.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    } catch {
      return [];
    }
  }

  /**
   * Read one file at a task's verified sha from the on-disk mirror (offline,
   * read-only — never a live worktree). Same path hygiene as
   * {@link readTrustedFile}; null on traversal, bad sha, or missing file.
   */
  async readTaskFile(repo: RepoConfig, sha: string, path: string): Promise<string | null> {
    const cleanSha = sha.trim();
    if (!/^[0-9a-f]{7,40}$/i.test(cleanSha)) return null;
    const rel = path.trim().replace(/^\/+/, '');
    if (rel.length === 0 || rel.includes('..') || rel.includes('\\') || rel.includes('\0')) {
      return null;
    }
    try {
      return await simpleGit(this.mirrorPath(repo.key)).show([`${cleanSha}:${rel}`]);
    } catch {
      return null;
    }
  }

  /**
   * Materialize the tree of `sha` from the on-disk bare mirror into `destDir`
   * (offline — no fetch, no index, no `.git`): `git archive | tar -x`.
   * Rejects on bad sha / missing mirror / non-zero exit. `destDir` must exist.
   */
  async exportTrustedTree(repo: RepoConfig, sha: string, destDir: string): Promise<void> {
    const cleanSha = sha.trim();
    if (!/^[0-9a-f]{7,40}$/i.test(cleanSha)) {
      throw new Error('invalid sha');
    }
    const mirror = this.mirrorPath(repo.key);
    const stderrLimit = 4 * 1024;
    await new Promise<void>((resolve, reject) => {
      const git = spawn(
        'git',
        ['--git-dir', mirror, 'archive', '--format=tar', cleanSha],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const tar = spawn('tar', ['-x', '-C', destDir], {
        stdio: ['pipe', 'ignore', 'pipe'],
      });

      let gitErr = '';
      let tarErr = '';
      const appendTail = (prev: string, chunk: Buffer): string => {
        const next = prev + chunk.toString('utf8');
        return next.length > stderrLimit ? next.slice(next.length - stderrLimit) : next;
      };
      git.stderr?.on('data', (chunk: Buffer) => {
        gitErr = appendTail(gitErr, chunk);
      });
      tar.stderr?.on('data', (chunk: Buffer) => {
        tarErr = appendTail(tarErr, chunk);
      });

      let gitCode: number | null = null;
      let tarCode: number | null = null;
      let settled = false;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        git.kill('SIGKILL');
        tar.kill('SIGKILL');
        reject(err);
      };

      if (git.stdout && tar.stdin) {
        // An early tar exit turns git's side into EPIPE; an unhandled stream
        // 'error' would take the daemon down, so route both ends to fail().
        tar.stdin.on('error', (err) => {
          fail(new Error(`tar stdin: ${err.message}`));
        });
        git.stdout.on('error', (err) => {
          fail(new Error(`git archive stdout: ${err.message}`));
        });
        git.stdout.pipe(tar.stdin);
      } else {
        fail(new Error('git archive: failed to open stdio pipes'));
        return;
      }
      const maybeDone = (): void => {
        if (settled || gitCode === null || tarCode === null) return;
        settled = true;
        if (gitCode !== 0) {
          reject(
            new Error(
              `git archive: exit ${String(gitCode)}${gitErr.length > 0 ? `: ${gitErr}` : ''}`,
            ),
          );
          return;
        }
        if (tarCode !== 0) {
          reject(
            new Error(
              `tar: exit ${String(tarCode)}${tarErr.length > 0 ? `: ${tarErr}` : ''}`,
            ),
          );
          return;
        }
        resolve();
      };

      git.once('error', (err) => {
        fail(new Error(`git archive: ${err.message}`));
      });
      tar.once('error', (err) => {
        fail(new Error(`tar: ${err.message}`));
      });
      git.once('close', (code) => {
        gitCode = code ?? 1;
        maybeDone();
      });
      tar.once('close', (code) => {
        tarCode = code ?? 1;
        maybeDone();
      });
    });
  }

  /**
   * List documentation paths on the trusted mirror default branch (offline —
   * no fetch). Powers the phone Repos "Browse docs" viewer. Empty when the
   * mirror is missing or the key is invalid.
   */
  async listRepoDocs(repo: RepoConfig): Promise<readonly string[]> {
    if (!isValidIdentifier(repo.key)) return [];
    try {
      const mirror = this.mirrorPath(repo.key);
      if (!(await pathExists(mirror))) return [];
      const out = await simpleGit(mirror).raw([
        'ls-tree',
        '-r',
        '--name-only',
        repo.defaultBranch,
      ]);
      const names = out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      return filterRepoDocPaths(names);
    } catch {
      return [];
    }
  }

  /**
   * Read one documentation file at the mirror default-branch tip (offline,
   * read-only). Same path hygiene as task-file reads; only allows paths that
   * {@link isRepoDocPath} would list so arbitrary source blobs cannot be
   * pulled through the docs endpoint.
   */
  async readRepoDoc(repo: RepoConfig, path: string): Promise<string | null> {
    if (!isValidIdentifier(repo.key)) return null;
    if (!isSafeRepoDocRelPath(path) || !isRepoDocPath(path)) return null;
    const rel = path.trim();
    try {
      const mirror = this.mirrorPath(repo.key);
      if (!(await pathExists(mirror))) return null;
      return await simpleGit(mirror).show([`${repo.defaultBranch}:${rel}`]);
    } catch {
      return null;
    }
  }

  /**
   * Offline WORKFLOW read for UI/API read paths: on-disk mirror only, no
   * ensureMirror (which fetches origin — /api/releases 60s, 2026-07-17).
   * Verification/deploy paths keep the refreshing readWorkflow.
   */
  async readWorkflowOffline(repo: RepoConfig): Promise<string | null> {
    const rel = repo.workflow.trim().replace(/^\/+/, '');
    if (rel.length === 0 || rel.includes('..')) return null;
    if (!isValidIdentifier(repo.key)) return null;
    try {
      const mirror = this.mirrorPath(repo.key);
      if (!(await pathExists(mirror))) return null;
      return await simpleGit(mirror).show([`${repo.defaultBranch}:${rel}`]);
    } catch {
      return null;
    }
  }

  /**
   * Paths in the trusted default-branch tree (`git ls-tree -r --name-only`),
   * capped. Offline — no ensureMirror fetch; empty on any error.
   */
  async listTrustedFiles(
    repo: RepoConfig,
    opts?: { readonly maxEntries?: number },
  ): Promise<readonly string[]> {
    const maxEntries = opts?.maxEntries ?? 5000;
    if (!isValidIdentifier(repo.key)) return [];
    if (!Number.isFinite(maxEntries) || maxEntries <= 0) return [];
    try {
      const mirror = this.mirrorPath(repo.key);
      if (!(await pathExists(mirror))) return [];
      const out = await simpleGit(mirror).raw([
        'ls-tree',
        '-r',
        '--name-only',
        repo.defaultBranch,
      ]);
      const names = out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      return names.slice(0, maxEntries);
    } catch {
      return [];
    }
  }

  /**
   * `git grep -I -n -E <pattern> <default> -- <pathspec…>` on the mirror.
   * Lines as `path:line:text`, capped. Pattern is a single argv element (no
   * shell). Rejects patterns longer than 200 chars. Offline — no fetch.
   */
  async grepTrusted(
    repo: RepoConfig,
    pattern: string,
    opts?: { readonly pathspec?: readonly string[]; readonly maxLines?: number },
  ): Promise<readonly string[]> {
    const maxLines = opts?.maxLines ?? 500;
    if (!isValidIdentifier(repo.key)) return [];
    if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 200) {
      return [];
    }
    if (!Number.isFinite(maxLines) || maxLines <= 0) return [];
    try {
      const mirror = this.mirrorPath(repo.key);
      if (!(await pathExists(mirror))) return [];
      // `-e` so a pattern starting with `-` can never be parsed as a git option.
      const args = ['grep', '-I', '-n', '-E', '-e', pattern, repo.defaultBranch];
      const pathspec = opts?.pathspec;
      if (pathspec && pathspec.length > 0) {
        args.push('--', ...pathspec);
      }
      const out = await simpleGit(mirror).raw(args);
      return out
        .split('\n')
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0)
        .slice(0, maxLines);
    } catch {
      // git grep exits 1 when there are no matches — treat as empty.
      return [];
    }
  }

  /** Tip SHA of the trusted mirror default branch (release reconciler). */
  async defaultBranchHead(repo: RepoConfig): Promise<string | null> {
    if (!isValidIdentifier(repo.key)) return null;
    try {
      // Read path: NO ensureMirror. It fetches origin + rewrites git config on
      // every call — /api/releases took 60s+ and fought the tick loop for the
      // mirror config lock (2026-07-17). The tick loop keeps mirrors fresh;
      // reads use the on-disk mirror as-is (null when it does not exist yet).
      const mirror = this.mirrorPath(repo.key);
      if (!(await pathExists(mirror))) return null;
      const sha = (await simpleGit(mirror).revparse([repo.defaultBranch])).trim();
      return sha.length > 0 ? sha : null;
    } catch {
      return null;
    }
  }

  /** Minimum spacing between targeted default-branch refreshes per repo (C3.51). */
  static readonly DEFAULT_BRANCH_REFRESH_MIN_MS = 60_000;

  /**
   * Refresh ONLY the mirror's default branch from origin (C3.51), then return
   * its tip. One targeted `fetch +refs/heads/<default>:refs/heads/<default>`
   * — no `ensureMirror` (no remote reconfiguration, no task-branch
   * reconciliation, no config lock), rate-limited to once per minute per repo
   * so a tick loop cannot hammer origin. Any fetch failure falls back to the
   * on-disk tip; a missing mirror yields null.
   */
  async refreshDefaultBranchHead(repo: RepoConfig): Promise<string | null> {
    if (!isValidIdentifier(repo.key)) return null;
    const mirror = this.mirrorPath(repo.key);
    if (!(await pathExists(mirror))) return null;
    const now = this.clock();
    const last = this.defaultBranchRefreshedAt.get(repo.key);
    if (last === undefined || now - last >= GitWorkspaces.DEFAULT_BRANCH_REFRESH_MIN_MS) {
      try {
        assertSafeRepoUrl(repo.url);
        const ref = `refs/heads/${repo.defaultBranch}`;
        await simpleGit(mirror).raw(['fetch', '--no-tags', repo.url, `+${ref}:${ref}`]);
        this.defaultBranchRefreshedAt.set(repo.key, now);
      } catch (err) {
        console.error(
          `[hercules] mirror default-branch refresh ${repo.key}: ${(err as Error).message}`,
        );
      }
    }
    return this.defaultBranchHead(repo);
  }

  /**
   * True when `sha` is reachable from the trusted default-branch tip
   * (ancestor-or-equal). Null when the mirror/object store cannot answer.
   * Prefer {@link proveDefaultBranchAncestry} when checking multiple SHAs
   * against one tip (atomic proof for the dependency gate).
   */
  async containsOnDefaultBranch(repo: RepoConfig, sha: string): Promise<boolean | null> {
    const proof = await this.proveDefaultBranchAncestry(repo, [sha]);
    if (!proof.tip) return null;
    return proof.reachable.get(sha) ?? null;
  }

  /**
   * Fetch origin default into the trusted mirror. Used at dispatch-time
   * ancestry proof — not by UI/API read paths.
   */
  async refreshTrustedDefault(repo: RepoConfig): Promise<boolean> {
    if (!isValidIdentifier(repo.key)) return false;
    try {
      await this.ensureMirror(repo, { requireFreshDefault: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Atomic trusted-mirror proof: resolve default tip once, then check each
   * SHA with an exact `rev-list` ancestry comparison against that tip. Missing
   * objects → null (stale), never success. Does not fetch — call
   * {@link refreshTrustedDefault} first when origin may have moved.
   */
  async proveDefaultBranchAncestry(
    repo: RepoConfig,
    shas: readonly string[],
  ): Promise<DefaultBranchAncestryProof> {
    const empty = (): DefaultBranchAncestryProof => ({
      tip: null,
      reachable: new Map(shas.map((s) => [s, null as boolean | null])),
    });
    if (!isValidIdentifier(repo.key)) return empty();
    try {
      const mirror = this.mirrorPath(repo.key);
      if (!(await pathExists(mirror))) return empty();
      const git = simpleGit(mirror);
      const tip = (await git.revparse([repo.defaultBranch])).trim();
      if (!tip) return empty();

      const reachable = new Map<string, boolean | null>();
      for (const raw of shas) {
        const want = raw.trim();
        if (!/^[0-9a-f]{7,40}$/i.test(want)) {
          reachable.set(raw, null);
          continue;
        }
        try {
          await git.raw(['cat-file', '-e', `${want}^{commit}`]);
        } catch {
          // Object missing from mirror — stale, not a hard mismatch.
          reachable.set(raw, null);
          continue;
        }
        if (tip.toLowerCase() === want.toLowerCase()) {
          reachable.set(raw, true);
          continue;
        }
        reachable.set(raw, await descendsFrom(git, want, tip));
      }
      return { tip, reachable };
    } catch {
      return empty();
    }
  }

  /**
   * Cwd for deploy/health shell commands.
   *
   * Prefer a working checkout that contains `scripts/deploy-*.sh` (single-box
   * Hercules: WorkingDirectory / DEPLOY_CWD). Fall back to the bare mirror so
   * git-only deploy commands still have a cwd. Deploy children get scrubbed
   * env — set `DEPLOY_CWD` (not HERCULES_*) on the daemon if the default path
   * does not match the host.
   */
  async deployCwd(repo: RepoConfig): Promise<string> {
    const override = process.env['DEPLOY_CWD']?.trim();
    if (override && (await pathExists(override))) {
      return override;
    }
    // Hercules self-hosting default (docs/deploy.md WorkingDirectory).
    if (repo.key === 'hercules') {
      const candidate = '/home/ubuntu/projects/Hercules';
      if (await pathExists(join(candidate, 'scripts', 'deploy-staging.sh'))) {
        return candidate;
      }
    }
    await this.ensureMirror(repo);
    return this.mirrorPath(repo.key);
  }

  /**
   * SHAs in production..staging for Release packet task selection.
   * When production is null, returns all commits reachable from staging
   * (capped) so stamp filtering still works.
   */
  async rangeShas(
    repo: RepoConfig,
    productionSha: string | null,
    stagingSha: string,
  ): Promise<ReadonlySet<string> | undefined> {
    if (!isValidIdentifier(repo.key)) return undefined;
    try {
      // Read path — no ensureMirror (network per call; see defaultBranchHead).
      const mirrorPath = this.mirrorPath(repo.key);
      if (!(await pathExists(mirrorPath))) return undefined;
      const git = simpleGit(mirrorPath);
      const range =
        productionSha !== null && productionSha !== ''
          ? `${productionSha}..${stagingSha}`
          : stagingSha;
      const out = await git.raw(['log', '--format=%H', range]);
      const set = new Set(
        out
          .split('\n')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      );
      // Include staging tip itself (log of A..B is exclusive of A, inclusive of B).
      set.add(stagingSha);
      return set;
    } catch {
      return undefined;
    }
  }

  /**
   * Ordered commits (newest first) in production..staging with subjects, from
   * the trusted bare mirror — surfaces operator pushes without task stamps.
   * Read path — no ensureMirror. Capped to keep the panel payload small.
   */
  async rangeCommitList(
    repo: RepoConfig,
    productionSha: string | null,
    stagingSha: string,
  ): Promise<readonly { sha: string; subject: string }[] | undefined> {
    if (!isValidIdentifier(repo.key)) return undefined;
    try {
      const mirrorPath = this.mirrorPath(repo.key);
      if (!(await pathExists(mirrorPath))) return undefined;
      const git = simpleGit(mirrorPath);
      const range =
        productionSha !== null && productionSha !== ''
          ? `${productionSha}..${stagingSha}`
          : stagingSha;
      const out = await git.raw(['log', '--max-count=100', '--format=%H%x09%s', range]);
      return out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((l) => {
          const tab = l.indexOf('\t');
          return tab > 0
            ? { sha: l.slice(0, tab), subject: l.slice(tab + 1) }
            : { sha: l, subject: '' };
        });
    } catch {
      return undefined;
    }
  }

  /**
   * `git diff --numstat production..staging` on the trusted bare mirror.
   * Sensitive-path risk is derived only from this name list (anti-spoof).
   */
  async rangeDiff(
    repo: RepoConfig,
    productionSha: string | null,
    stagingSha: string,
  ): Promise<{
    readonly files: readonly string[];
    readonly insertions: number;
    readonly deletions: number;
  } | null> {
    if (!isValidIdentifier(repo.key)) return null;
    if (!stagingSha || !/^[0-9a-f]{7,40}$/i.test(stagingSha)) return null;
    try {
      // Read path — no ensureMirror (see defaultBranchHead).
      const mirrorPath = this.mirrorPath(repo.key);
      if (!(await pathExists(mirrorPath))) return null;
      const git = simpleGit(mirrorPath);
      const range =
        productionSha !== null &&
        productionSha !== '' &&
        /^[0-9a-f]{7,40}$/i.test(productionSha)
          ? `${productionSha}..${stagingSha}`
          : stagingSha;
      const q = ['-c', 'core.quotepath=false'] as const;
      const raw = await git.raw([...q, 'diff', '--numstat', range]);
      const files: string[] = [];
      let insertions = 0;
      let deletions = 0;
      for (const line of raw.split('\n')) {
        const trimmed = line.trimEnd();
        if (trimmed.length === 0) continue;
        const tab1 = trimmed.indexOf('\t');
        if (tab1 < 0) continue;
        const tab2 = trimmed.indexOf('\t', tab1 + 1);
        if (tab2 < 0) continue;
        const addsRaw = trimmed.slice(0, tab1);
        const delsRaw = trimmed.slice(tab1 + 1, tab2);
        const path = trimmed.slice(tab2 + 1).trim().replace(/^"(.*)"$/, '$1');
        if (path.length === 0) continue;
        files.push(path);
        if (addsRaw !== '-') {
          const n = Number(addsRaw);
          if (Number.isFinite(n)) insertions += n;
        }
        if (delsRaw !== '-') {
          const n = Number(delsRaw);
          if (Number.isFinite(n)) deletions += n;
        }
      }
      return { files, insertions, deletions };
    } catch {
      return null;
    }
  }

  /**
   * `git diff --numstat <defaultBranch>...<sha>` (three-dot / merge-base) on
   * the trusted bare mirror — auto-merge size and sensitive-path facts.
   */
  async taskBranchDiff(repo: RepoConfig, sha: string): Promise<AutoMergeDiff | null> {
    if (!isValidIdentifier(repo.key)) return null;
    if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) return null;
    try {
      // Read path — no ensureMirror (see defaultBranchHead / rangeDiff).
      const mirrorPath = this.mirrorPath(repo.key);
      if (!(await pathExists(mirrorPath))) return null;
      const git = simpleGit(mirrorPath);
      const raw = await git.raw([
        '-c',
        'core.quotepath=false',
        'diff',
        '--numstat',
        `${repo.defaultBranch}...${sha}`,
      ]);
      const parsed = parseGitNumstat(raw);
      return {
        files: parsed.files,
        insertions: parsed.insertions,
        deletions: parsed.deletions,
      };
    } catch {
      return null;
    }
  }

  /** Subject + per-file numstat for one commit on the trusted mirror. */
  async commitDiffBrief(
    repo: RepoConfig,
    sha: string,
  ): Promise<{
    readonly subject: string;
    readonly files: readonly string[];
    readonly insertions: number;
    readonly deletions: number;
  } | null> {
    if (!isValidIdentifier(repo.key)) return null;
    if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) return null;
    try {
      // Read path — no ensureMirror (network per call; see defaultBranchHead).
      const mirrorPath = this.mirrorPath(repo.key);
      if (!(await pathExists(mirrorPath))) return null;
      const git = simpleGit(mirrorPath);
      const q = ['-c', 'core.quotepath=false'] as const;
      const subject = (await git.raw(['log', '-1', '--format=%s', sha])).trim();
      const raw = await git.raw([...q, 'show', '--numstat', '--format=', sha]);
      const files: string[] = [];
      let insertions = 0;
      let deletions = 0;
      for (const line of raw.split('\n')) {
        const trimmed = line.trimEnd();
        if (trimmed.length === 0) continue;
        const tab1 = trimmed.indexOf('\t');
        if (tab1 < 0) continue;
        const tab2 = trimmed.indexOf('\t', tab1 + 1);
        if (tab2 < 0) continue;
        const addsRaw = trimmed.slice(0, tab1);
        const delsRaw = trimmed.slice(tab1 + 1, tab2);
        const path = trimmed.slice(tab2 + 1).trim().replace(/^"(.*)"$/, '$1');
        if (path.length === 0) continue;
        // skip commit headers accidentally matched
        if (!/^-?\d+$/.test(addsRaw) && addsRaw !== '-') continue;
        files.push(path);
        if (addsRaw !== '-') {
          const n = Number(addsRaw);
          if (Number.isFinite(n)) insertions += n;
        }
        if (delsRaw !== '-') {
          const n = Number(delsRaw);
          if (Number.isFinite(n)) deletions += n;
        }
      }
      return { subject, files, insertions, deletions };
    } catch {
      return null;
    }
  }

  /**
   * Find `hercules: merge <taskId>` in production..staging (batch merge
   * stamps share the final tip; this recovers the real per-task commit).
   */
  async findTaskMergeCommit(
    repo: RepoConfig,
    taskId: string,
    productionSha: string | null,
    stagingSha: string,
  ): Promise<string | null> {
    if (!isValidIdentifier(repo.key) || !isValidIdentifier(taskId)) return null;
    if (!stagingSha || !/^[0-9a-f]{7,40}$/i.test(stagingSha)) return null;
    try {
      // Read path — no ensureMirror (24 ahead tasks × network fetch made
      // /api/releases take ~48s, 2026-07-17). Tick loop owns freshness.
      const mirrorPath = this.mirrorPath(repo.key);
      if (!(await pathExists(mirrorPath))) return null;
      const git = simpleGit(mirrorPath);
      const range =
        productionSha !== null &&
        productionSha !== '' &&
        /^[0-9a-f]{7,40}$/i.test(productionSha)
          ? `${productionSha}..${stagingSha}`
          : stagingSha;
      // Fixed string match on subject prefix — taskId is an identifier.
      const out = await git.raw([
        'log',
        '--format=%H',
        `--grep=^hercules: merge ${taskId}\\b`,
        range,
      ]);
      const first = out
        .split('\n')
        .map((s) => s.trim())
        .find((s) => s.length > 0);
      return first ?? null;
    } catch {
      return null;
    }
  }

  private mirrorPath(repoKey: string): string {
    return join(this.root, MIRRORS_DIR, `${repoKey}.git`);
  }

  private async ensureMirror(
    repo: RepoConfig,
    opts: {
      readonly requireFreshDefault?: boolean;
      readonly skipReconcileTaskBranch?: string;
      /** When set, skip fetch+reconcile if a successful refresh is this fresh. */
      readonly maxStaleMs?: number;
    } = {},
  ): Promise<string> {
    assertSafeRepoUrl(repo.url);
    const path = this.mirrorPath(repo.key);
    if (await pathExists(path)) {
      // Reconcile origin so an edited repo.url actually takes effect (design §mirror-staleness).
      await simpleGit(path).raw(['remote', 'set-url', 'origin', repo.url]);
      // Refresh **only** the default branch. `git remote update` / full-heads
      // fetch tries to update every remote head, including `hercules/<id>` that
      // is still checked out in a live worktree — git then fails with:
      //   refusing to fetch into branch 'refs/heads/hercules/…' checked out at …
      // Case study: orbit-repo-readiness-onboarding provision (2026-07).
      // Never --prune: pruning can drop local task branches needed for L3 rework.
      // Task-branch tips are reconciled via preferBestKnownTaskTip / ls-remote.
      await this.configureDefaultBranchOnlyFetch(path, repo.defaultBranch);
      await this.ensureExactCandidateFetchRefsPruned(path);

      const prior = this.mirrorFreshness.get(repo.key);
      const now = this.clock();
      const canReuse =
        opts.maxStaleMs !== undefined &&
        opts.requireFreshDefault !== true &&
        prior !== undefined &&
        prior.url === repo.url &&
        prior.defaultBranch === repo.defaultBranch &&
        now - prior.refreshedAt <= opts.maxStaleMs;
      if (canReuse) {
        return path;
      }

      const fetchDefault = async (): Promise<void> => {
        this.remoteFetchAttempts += 1;
        await simpleGit(path).raw(['fetch', '--no-tags', 'origin']);
      };
      let fetchOk = false;
      let fetchedAt = 0;
      try {
        await fetchDefault();
        fetchOk = true;
        fetchedAt = this.clock();
      } catch (err) {
        // Agents sometimes leave disposable review worktrees with the default
        // branch checked out (live incident 2026-07-16: /tmp/hercules-l3-…) —
        // git then refuses this fetch forever and the trusted mirror goes
        // silently stale. Detach the stray pin and retry once.
        const msg = (err as Error).message;
        if (/refusing to fetch into branch/i.test(msg)) {
          await this.unpinDefaultBranchWorktrees(path, repo.key, repo.defaultBranch);
          try {
            await fetchDefault();
            fetchOk = true;
            fetchedAt = this.clock();
          } catch (err2) {
            if (opts.requireFreshDefault) {
              throw new WorkspaceError(
                `trusted default-branch refresh failed for repo ${repo.key}`,
              );
            }
            console.error(
              `[hercules] mirror fetch ${repo.key}/${repo.defaultBranch} (after unpin): ${(err2 as Error).message}`,
            );
          }
        } else {
          if (opts.requireFreshDefault) {
            throw new WorkspaceError(
              `trusted default-branch refresh failed for repo ${repo.key}`,
            );
          }
          console.error(`[hercules] mirror fetch ${repo.key}/${repo.defaultBranch}: ${msg}`);
        }
      }
      // hercules/*: three-state reconcile (never force-clobber local-ahead tips).
      // Default branch above stays +force; task branches are never +refs/heads/*.
      await this.reconcileHerculesBranches(
        path,
        repo.defaultBranch,
        opts.skipReconcileTaskBranch,
      );
      // Freshness window only records a successful default-branch fetch, stamped
      // at the moment the fetch completed (a slow reconcile must not make the
      // tip look fresher than it is). A failed fetch must not stamp refreshedAt
      // (callers keep retrying next time). The task-branch reconcile is
      // best-effort and does not affect the stamp: the window serves policy
      // lint only, never task-tip selection.
      if (fetchOk) {
        this.mirrorFreshness.set(repo.key, {
          refreshedAt: fetchedAt,
          url: repo.url,
          defaultBranch: repo.defaultBranch,
        });
      }
      return path;
    }
    await mkdir(join(this.root, MIRRORS_DIR), { recursive: true });
    await simpleGit(this.root).clone(repo.url, path, ['--mirror']);
    // Drop mirror-mode fetch (`+refs/*:refs/*`) so later refresh never writes
    // into a checked-out hercules/<id> tip.
    await this.configureDefaultBranchOnlyFetch(path, repo.defaultBranch);
    await this.ensureExactCandidateFetchRefsPruned(path);
    // Freshness window never applies to the initial clone (no refreshedAt stamp).
    return path;
  }

  private async ensureExactCandidateFetchRefsPruned(mirror: string): Promise<void> {
    const running = this.exactFetchRefPrunes.get(mirror);
    if (running) return running;
    const prune = this.pruneExactCandidateFetchRefs(mirror);
    this.exactFetchRefPrunes.set(mirror, prune);
    try {
      await prune;
    } catch (err) {
      this.exactFetchRefPrunes.delete(mirror);
      throw err;
    }
  }

  /** Remove exact-candidate temp refs left by a process crash or failed provision. */
  private async pruneExactCandidateFetchRefs(mirror: string): Promise<void> {
    const git = simpleGit(mirror);
    let refs: string[];
    try {
      const raw = await git.raw([
        'for-each-ref',
        '--format=%(refname)',
        'refs/hercules-fetch/',
      ]);
      refs = raw
        .split('\n')
        .map((ref) => ref.trim())
        .filter((ref) => ref.startsWith('refs/hercules-fetch/'));
    } catch {
      throw new WorkspaceError('could not inspect stale exact-candidate fetch refs');
    }
    for (const ref of refs) {
      try {
        await git.raw(['update-ref', '-d', ref]);
      } catch {
        throw new WorkspaceError('could not clean stale exact-candidate fetch refs');
      }
    }
  }

  /**
   * Mirror clones set `remote.origin.mirror=true` and fetch `+refs/*:refs/*`.
   * That both rejects explicit refspecs (`--mirror can't be combined with
   * refspecs` — including worktree `git push origin HEAD:refs/heads/…`) and
   * fatals when any remote head is checked out in a linked worktree.
   * Permanently drop mirror mode and pin fetch to the default branch only.
   * (A one-shot `git -c remote.origin.mirror=false` is unreliable under
   * simple-git for this path; config must stick.)
   */
  private async configureDefaultBranchOnlyFetch(
    path: string,
    defaultBranch: string,
  ): Promise<void> {
    const g = simpleGit(path);
    // Idempotence first: skip ALL writes when already configured. Every write
    // takes the git config lock and concurrent ensureMirror callers (tick loop
    // vs API) hit "could not lock config file" (2026-07-17).
    try {
      const mirrorFlag = (await g.raw(['config', '--get', 'remote.origin.mirror'])).trim();
      const fetchSpecs = (
        await g.raw(['config', '--get-all', 'remote.origin.fetch']).catch(() => '')
      )
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const want = `+refs/heads/${defaultBranch}:refs/heads/${defaultBranch}`;
      if (mirrorFlag === 'false' && fetchSpecs.length === 1 && fetchSpecs[0] === want) {
        return;
      }
    } catch {
      /* fall through to configure */
    }
    // Permanent — not `git -c` — so subsequent push/fetch with refspecs work.
    await g.raw(['config', 'remote.origin.mirror', 'false']);
    try {
      await g.raw(['config', '--unset-all', 'remote.origin.fetch']);
    } catch (err) {
      // unset-all exits non-zero when the key is absent — fine.
      const msg = (err as Error).message;
      if (!/key does not contain a section|unset/i.test(msg) && !/exit code [1-9]/i.test(msg)) {
        console.error(`[hercules] unset remote.origin.fetch: ${msg}`);
      }
    }
    await g.raw([
      'config',
      '--add',
      'remote.origin.fetch',
      `+refs/heads/${defaultBranch}:refs/heads/${defaultBranch}`,
    ]);
  }

  /**
   * Detach any mirror worktree that has the default branch checked out
   * (keeps its files at the same commit), pruning metadata for worktrees
   * whose directory is already gone. The trusted mirror's default branch
   * must always stay fetchable — gates are read from it.
   */
  private async unpinDefaultBranchWorktrees(
    mirror: string,
    repoKey: string,
    defaultBranch: string,
  ): Promise<void> {
    const g = simpleGit(mirror);
    try {
      await g.raw(['worktree', 'prune', '--expire', 'now']);
      const porcelain = await g.raw(['worktree', 'list', '--porcelain']);
      for (const entry of porcelain.split(/\n\n+/)) {
        const dir = entry.match(/^worktree (.+)$/m)?.[1];
        const branch = entry.match(/^branch (.+)$/m)?.[1];
        if (!dir || branch !== `refs/heads/${defaultBranch}`) continue;
        try {
          // Linked trees may inherit core.bare=true once worktreeConfig is on;
          // make them usable before checkout --detach can run.
          await ensureLinkedWorktreeUsable(dir);
          await simpleGit(dir).raw(['checkout', '--detach']);
          console.error(
            `[hercules] mirror ${repoKey}: detached stray worktree ${dir} pinning ${defaultBranch}`,
          );
        } catch (err) {
          console.error(
            `[hercules] mirror ${repoKey}: could not detach ${dir}: ${(err as Error).message}`,
          );
        }
      }
    } catch (err) {
      console.error(
        `[hercules] mirror ${repoKey}: worktree unpin failed: ${(err as Error).message}`,
      );
    }
  }

  private async inspectExactReplacementWorktree(
    dir: string,
    context: string,
  ): Promise<{ readonly head: string; readonly dirty: boolean }> {
    try {
      const git = simpleGit(dir);
      const head = (await git.revparse(['HEAD'])).trim().toLowerCase();
      if (!isFullCommitSha(head)) throw new Error('invalid HEAD');
      const status = await git.raw(['status', '--porcelain', '--untracked-files=all']);
      const ignored = await git.raw([
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
      ]);
      return { head, dirty: status.trim().length > 0 || ignored.trim().length > 0 };
    } catch {
      throw new WorkspaceError(
        `could not safely inspect exact-candidate worktree for '${context}'`,
      );
    }
  }

  private async assertNoExactCandidatePins(
    git: SimpleGit,
    branch: string,
    keepDir: string,
    taskId: string,
  ): Promise<void> {
    let porcelain: string;
    try {
      porcelain = await git.raw(['worktree', 'list', '--porcelain']);
    } catch {
      throw new WorkspaceError(
        `could not inspect exact-candidate worktree pins for '${taskId}'`,
      );
    }
    const keep = resolve(keepDir);
    for (const entry of porcelain.split(/\n\n+/)) {
      const dir = entry.match(/^worktree (.+)$/m)?.[1];
      const pinned = entry.match(/^branch (.+)$/m)?.[1];
      if (!dir || pinned !== `refs/heads/${branch}` || resolve(dir) === keep) continue;
      throw new WorkspaceError(
        `exact candidate blocked by coexisting task-branch pin for '${taskId}'`,
      );
    }
  }

  private async finalizeExactCandidateHandoff(
    git: SimpleGit,
    originUrl: string,
    branch: string,
    taskId: string,
    expectedRemoteTip: string,
    fetchedRef: string,
  ): Promise<void> {
    await this.beforeExactCandidateReturnVerify?.(branch);
    let finalRemoteTip: string | null;
    try {
      finalRemoteTip = await readRemoteTaskBranchTip(git, originUrl, branch);
    } catch {
      throw new WorkspaceError(
        `could not revalidate exact task branch before handoff for '${taskId}'`,
      );
    }
    if (finalRemoteTip !== expectedRemoteTip) {
      throw new WorkspaceError(
        `task branch exact lease changed before workspace handoff ` +
          `(expected ${shortLeaseSha(expectedRemoteTip)}, ` +
          `actual ${shortLeaseSha(finalRemoteTip)})`,
      );
    }
    try {
      await git.raw(['update-ref', '-d', fetchedRef]);
    } catch {
      throw new WorkspaceError(
        `could not clean exact-candidate fetch ref for '${taskId}'`,
      );
    }
  }

  /**
   * Free any worktree (other than `keepDir`) that has `branch` checked out so
   * provision can `worktree add` / `branch -f` without fatals. Prefer force-remove
   * under the isolation root; otherwise detach HEAD so the ref is free.
   * Only acts on checkouts of *this* task branch — never remaps another task's path.
   */
  private async releaseTaskBranchPins(
    mirror: string,
    repoKey: string,
    branch: string,
    keepDir: string,
  ): Promise<void> {
    const g = simpleGit(mirror);
    const keep = resolve(keepDir);
    try {
      await g.raw(['worktree', 'prune', '--expire', 'now']);
      const porcelain = await g.raw(['worktree', 'list', '--porcelain']);
      for (const entry of porcelain.split(/\n\n+/)) {
        const dir = entry.match(/^worktree (.+)$/m)?.[1];
        const br = entry.match(/^branch (.+)$/m)?.[1];
        if (!dir || br !== `refs/heads/${branch}`) continue;
        if (resolve(dir) === keep) continue;
        try {
          // Under isolation root: remove so the expected task path is the sole
          // owner of hercules/<id>. Outside the root (disposable review trees):
          // detach HEAD — frees the ref without deleting the caller's files.
          if (this.isUnderRoot(dir)) {
            await g.raw(['worktree', 'remove', '--force', dir]);
            console.error(
              `[hercules] mirror ${repoKey}: removed stray worktree ${dir} pinning ${branch}`,
            );
          } else {
            await ensureLinkedWorktreeUsable(dir);
            await simpleGit(dir).raw(['checkout', '--detach']);
            console.error(
              `[hercules] mirror ${repoKey}: detached stray worktree ${dir} pinning ${branch}`,
            );
          }
        } catch (err) {
          // Dir may already be gone or not a valid worktree — try force-remove.
          console.error(
            `[hercules] mirror ${repoKey}: could not free ${dir} from ${branch}: ${(err as Error).message}`,
          );
          try {
            await g.raw(['worktree', 'remove', '--force', dir]);
          } catch (rmErr) {
            console.error(
              `[hercules] mirror ${repoKey}: force-remove ${dir} failed: ${(rmErr as Error).message}`,
            );
          }
        }
      }
    } catch (err) {
      console.error(
        `[hercules] mirror ${repoKey}: releaseTaskBranchPins(${branch}): ${(err as Error).message}`,
      );
    }
  }

  /** True when `dir` resolves inside the isolation root (owned worktrees). */
  private isUnderRoot(dir: string): boolean {
    const resolved = resolve(dir);
    return resolved === this.root || resolved.startsWith(this.root + sep);
  }

  /**
   * Remove a worktree (and optionally its branch) if they exist (idempotent).
   * Missing or unregistered paths are success / no-op (bounded log only).
   */
  private async cleanWorktree(
    mirror: string,
    dir: string,
    branch: string,
    deleteBranch = true,
  ): Promise<void> {
    const git: SimpleGit = simpleGit(mirror);
    if (await pathExists(dir)) {
      await this.removeOrClearWorktreePath(git, dir, branch);
    }
    try {
      await git.raw(['worktree', 'prune']);
    } catch (err) {
      console.error(`[hercules] cleanWorktree prune: ${(err as Error).message}`);
    }
    if (deleteBranch) {
      try {
        const branches = await git.branch();
        if (branches.all.includes(branch) || branches.all.includes(`refs/heads/${branch}`)) {
          await git.raw(['branch', '-D', branch]);
        }
      } catch (err) {
        console.error(
          `[hercules] cleanWorktree delete branch ${branch}: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Remove a registered worktree, or clear an unregistered leftover under the
   * isolation root. Unregistered / race-unregistered paths are non-fatal.
   */
  private async removeOrClearWorktreePath(
    git: SimpleGit,
    dir: string,
    branch: string,
  ): Promise<void> {
    const registered = await this.isRegisteredWorktreePath(git, dir);
    if (registered) {
      try {
        await git.raw(['worktree', 'remove', '--force', dir]);
        return;
      } catch (err) {
        const msg = (err as Error).message;
        if (isUnregisteredWorktreeError(msg)) {
          this.emitMirrorLog(
            'clean_unregistered',
            branch,
            `[hercules] cleanWorktree ${dir}: not a registered worktree; treating as clean`,
          );
          if (this.isUnderRoot(dir) && (await pathExists(dir))) {
            await rm(dir, { recursive: true, force: true });
          }
          return;
        }
        if (this.isUnderRoot(dir)) {
          console.error(
            `[hercules] cleanWorktree remove ${dir}: ${msg}; falling back to rm`,
          );
          await rm(dir, { recursive: true, force: true });
          return;
        }
        throw err;
      }
    }

    this.emitMirrorLog(
      'clean_unregistered',
      branch,
      `[hercules] cleanWorktree ${dir}: path not registered; removing leftover`,
    );
    if (this.isUnderRoot(dir)) {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * True when `dir` appears in git worktree list for this mirror.
   * List failure fail-closed: treat as registered so we still attempt remove.
   */
  private async isRegisteredWorktreePath(git: SimpleGit, dir: string): Promise<boolean> {
    try {
      const porcelain = await git.raw(['worktree', 'list', '--porcelain']);
      const resolved = resolve(dir);
      return worktreePorcelainEntries(porcelain).some((entry) => {
        const wtPath = entry.match(/^worktree (.+)$/m)?.[1]?.trim();
        return wtPath !== undefined && resolve(wtPath) === resolved;
      });
    } catch {
      // Unknown list ownership must not skip a real remove attempt.
      return true;
    }
  }

  /**
   * When `hercules/<taskId>` is missing, reattach the best known tip
   * (origin + local recover). Never attaches git-stash WIP nodes.
   */
  private async recoverTaskBranchIfMissing(
    git: SimpleGit,
    branch: string,
    taskId: string,
    defaultBranch: string,
  ): Promise<boolean> {
    try {
      const branches = await git.branch();
      if (branches.all.includes(branch) || branches.all.includes(`refs/heads/${branch}`)) {
        return false;
      }
    } catch {
      /* continue to recovery attempts */
    }

    const best = await this.selectBestTaskTip(git, branch, taskId, defaultBranch, null);
    if (!best) return false;
    try {
      await git.raw(['branch', branch, best.sha]);
      console.error(
        `[hercules] recovered branch ${branch} → ${best.sha.slice(0, 12)} (${best.source})`,
      );
      return true;
    } catch (err) {
      console.error(
        `[hercules] could not recreate ${branch} at ${best.sha.slice(0, 12)}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /**
   * If a better tip than the current branch head is known (origin or local
   * recover candidates with more commits ahead of default), force the branch
   * forward. Does nothing when current is already best.
   *
   * Never rewinds a local tip that is strictly ahead of the candidate (mirror
   * clobber race: origin older, local verified-and-not-yet-pushed).
   */
  private async preferBestKnownTaskTip(
    git: SimpleGit,
    branch: string,
    taskId: string,
    defaultBranch: string,
  ): Promise<void> {
    let current: string | null = null;
    try {
      const branches = await git.branch();
      const has =
        branches.all.includes(branch) || branches.all.includes(`refs/heads/${branch}`);
      if (!has) return;
      current = (await git.raw(['rev-parse', `refs/heads/${branch}`])).trim();
    } catch {
      return;
    }
    if (!current || !/^[0-9a-f]{7,40}$/i.test(current)) return;

    const best = await this.selectBestTaskTip(git, branch, taskId, defaultBranch, current);
    if (!best || best.sha.toLowerCase() === current.toLowerCase()) return;

    // Guard: local strictly ahead of candidate → keep local (no silent rewind).
    try {
      const behind = Number(
        (await git.raw(['rev-list', '--count', `${current}..${best.sha}`])).trim(),
      );
      const ahead = Number(
        (await git.raw(['rev-list', '--count', `${best.sha}..${current}`])).trim(),
      );
      if (mustKeepLocalTaskTip(behind, ahead)) {
        const msg = formatSkipRewindEvent(branch, current, best.sha);
        this.emitMirrorSkip(
          'skip_rewind',
          branch,
          `preferBestKnown ${branch}: ${msg} (candidate ${best.source})`,
          msg,
        );
        return;
      }
    } catch {
      /* ancestry unknown — fall through to upgrade attempt */
    }

    try {
      await git.raw(['branch', '-f', branch, best.sha]);
      console.error(
        `[hercules] upgraded ${branch} tip ${current.slice(0, 12)} → ${best.sha.slice(0, 12)} (${best.source})`,
      );
    } catch (err) {
      console.error(
        `[hercules] preferBestKnownTaskTip ${branch}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * After default-branch force-fetch: reconcile each local hercules/* tip against
   * origin using the three-state policy. Never uses `+refs/heads/*` force-fetch.
   * Checked-out tips are left alone (git would refuse force update anyway).
   * History-less tips (at default) do not adopt foreign origin tips — same
   * ownership rule as selectBestTaskTip (verify-l3-rework-policy, 2026-07-17).
   */
  private async reconcileHerculesBranches(
    mirrorPath: string,
    defaultBranch: string,
    skipBranch?: string,
  ): Promise<void> {
    const git = simpleGit(mirrorPath);
    let originUrl = '';
    try {
      originUrl = (await git.raw(['remote', 'get-url', 'origin'])).trim();
    } catch {
      return;
    }
    if (!originUrl) return;

    let localBranches: string[] = [];
    try {
      const out = await git.raw([
        'for-each-ref',
        '--format=%(refname:short)',
        `refs/heads/${BRANCH_PREFIX}`,
      ]);
      localBranches = out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith(BRANCH_PREFIX));
    } catch {
      return;
    }
    if (localBranches.length === 0) return;

    const remoteTips = new Map<string, string>();
    try {
      const ls = await git.raw([
        'ls-remote',
        '--heads',
        originUrl,
        `refs/heads/${BRANCH_PREFIX}*`,
      ]);
      for (const line of ls.split('\n')) {
        const m = /^([0-9a-f]{7,40})\s+refs\/heads\/(hercules\/\S+)/i.exec(line.trim());
        if (!m) continue;
        remoteTips.set(m[2]!, m[1]!);
      }
    } catch (err) {
      console.error(
        `[hercules] mirror hercules/* ls-remote failed: ${(err as Error).message}`,
      );
      return;
    }

    for (const branch of localBranches) {
      if (branch === skipBranch) continue;
      if (this.isExactCandidateBranchProtected(mirrorPath, branch)) continue;
      await this.withTaskBranchMutation(mirrorPath, branch, async () => {
        if (this.isExactCandidateBranchProtected(mirrorPath, branch)) return;
        const remoteTip = remoteTips.get(branch);
        if (!remoteTip) return; // local-only — nothing to pull
        let localTip = '';
        try {
          localTip = (await git.raw(['rev-parse', `refs/heads/${branch}`])).trim();
        } catch {
          return;
        }
        if (!/^[0-9a-f]{7,40}$/i.test(localTip)) return;
        if (localTip.toLowerCase() === remoteTip.toLowerCase()) return;

        try {
          await git.raw(['fetch', '--no-tags', originUrl, remoteTip]);
        } catch {
          /* object may already be present */
        }

        let behind = -1;
        let ahead = -1;
        try {
          behind = Number(
            (await git.raw(['rev-list', '--count', `${localTip}..${remoteTip}`])).trim(),
          );
          ahead = Number(
            (await git.raw(['rev-list', '--count', `${remoteTip}..${localTip}`])).trim(),
          );
        } catch (err) {
          console.error(
            `[hercules] mirror fetch ${branch}: ancestry failed — ${(err as Error).message}`,
          );
          return;
        }

        const decision = decideTaskBranchFetch(behind, ahead);
        if (decision.action === 'keep') {
          const msg = formatSkipRewindEvent(branch, localTip, remoteTip);
          this.emitMirrorSkip(
            'skip_rewind',
            branch,
            `mirror fetch ${branch}: ${msg}`,
            msg,
          );
          return;
        }
        if (decision.action !== 'update') return;

        const skipCheckedOutUpdate = async (): Promise<boolean> => {
          if (!(await this.isTaskBranchCheckedOut(git, branch))) return false;
          // Live agent owns the tip — never force-update a checked-out ref.
          // Rate-limit console + durable audit together (same fingerprint gate).
          const line =
            `mirror fetch ${branch}: skip ${decision.reason} update (checked out) ` +
            `local=${localTip.slice(0, 12)} remote=${remoteTip.slice(0, 12)}`;
          this.emitMirrorSkip('skip_rewind', branch, line, line);
          return true;
        };
        if (await skipCheckedOutUpdate()) return;

        // Ownership: a branch sitting at the default tip has no task history to
        // continue — do not absorb an origin tip unless the subject names this task.
        const taskId = taskIdFromHerculesBranch(branch);
        if (taskId) {
          const localAheadOfDefault = await commitsAheadOfDefault(
            git,
            localTip,
            defaultBranch,
          );
          if (localAheadOfDefault <= 0) {
            let subject = '';
            try {
              subject = (await git.raw(['log', '-1', '--format=%s', remoteTip])).trim();
            } catch {
              subject = '';
            }
            if (!subject.toLowerCase().includes(taskId.toLowerCase())) {
              const line =
                `mirror fetch ${branch}: skip ${decision.reason} — ` +
                `history-less tip, origin not task-owned ` +
                `local=${localTip.slice(0, 12)} remote=${remoteTip.slice(0, 12)}`;
              this.emitMirrorSkip('skip_rewind', branch, line, line);
              return;
            }
          }
        }

        // An exact-candidate create may have announced intent while this
        // reconciliation was gathering ancestry. Never race its proof/handoff.
        if (this.isExactCandidateBranchProtected(mirrorPath, branch)) return;
        // Preserve may have attached this branch while reconciliation waited
        // for the same mutation lock. Re-read pins at the point of mutation.
        if (await skipCheckedOutUpdate()) return;
        try {
          await git.raw(['update-ref', `refs/heads/${branch}`, remoteTip, localTip]);
          if (decision.reason === 'diverged' && decision.logLine) {
            // Diverged take-remote is an advance, not a skip — always audit.
            this.emitMirrorLog(
              'diverged',
              branch,
              `mirror fetch ${branch}: ${decision.logLine}`,
            );
            this.recordBranchEvent('diverged_take_remote', branch, decision.logLine);
          } else {
            this.emitMirrorLog(
              decision.reason,
              branch,
              `mirror fetch ${branch}: advanced → origin ${remoteTip.slice(0, 12)} (${decision.reason})`,
            );
          }
        } catch (err) {
          console.error(
            `[hercules] mirror fetch ${branch}: update-ref failed — ${(err as Error).message}`,
          );
        }
      });
    }
  }

  private async isTaskBranchCheckedOut(git: SimpleGit, branch: string): Promise<boolean> {
    try {
      const porcelain = await git.raw(['worktree', 'list', '--porcelain']);
      return porcelain.split(/\n\n+/).some((entry) => {
        const checkedOut = entry.match(/^branch (.+)$/m)?.[1]?.trim();
        return checkedOut === branch || checkedOut === `refs/heads/${branch}`;
      });
    } catch {
      // Unknown checkout ownership must not authorize a named-ref rewrite.
      return true;
    }
  }

  /**
   * Pick the tip with the most commits ahead of defaultBranch among:
   * current (if any), origin, and local recover heuristics.
   */
  private async selectBestTaskTip(
    git: SimpleGit,
    branch: string,
    taskId: string,
    defaultBranch: string,
    current: string | null,
  ): Promise<{ sha: string; source: string; ahead: number } | null> {
    type Cand = { sha: string; source: string; ahead: number; ts: number };
    const cands: Cand[] = [];

    const pushCand = async (sha: string, source: string): Promise<void> => {
      if (!/^[0-9a-f]{7,40}$/i.test(sha)) return;
      if (cands.some((c) => c.sha.toLowerCase() === sha.toLowerCase())) return;
      try {
        const subj = (await git.raw(['log', '-1', '--format=%s', sha])).trim();
        if (isStashLikeSubject(subj)) return;
      } catch {
        return;
      }
      const ahead = await commitsAheadOfDefault(git, sha, defaultBranch);
      if (ahead < 0) return;
      let ts = 0;
      try {
        ts = Number((await git.raw(['log', '-1', '--format=%ct', sha])).trim()) || 0;
      } catch {
        ts = 0;
      }
      cands.push({ sha, source, ahead, ts });
    };

    if (current) await pushCand(current, 'current');

    // Adoption rule for candidates that are NOT this branch's own refs:
    // an exact task-id subject stands alone; anything else is only trusted
    // when the branch already has its OWN commits and the candidate descends
    // from them (rewound-tip continuation). A branch sitting at the default
    // tip has no history to continue — adopting an arbitrary "ahead" commit
    // there is how rework rounds re-stole quarantined foreign work (2026-07-17).
    const currentAhead = current
      ? await commitsAheadOfDefault(git, current, defaultBranch)
      : -1;
    const mayAdopt = async (
      sha: string,
      allowWhenBranchMissing: boolean,
    ): Promise<boolean> => {
      try {
        const subj = (await git.raw(['log', '-1', '--format=%s', sha])).trim();
        if (subj.toLowerCase().includes(taskId.toLowerCase())) return true;
      } catch {
        return false;
      }
      // Branch missing → dangling recovery (logout case) may proceed; commits
      // that are still REACHABLE on other refs almost certainly belong to a
      // sibling task and need the exact-id match above.
      if (!current) return allowWhenBranchMissing;
      return currentAhead > 0 && (await descendsFrom(git, current, sha));
    };

    // Same branch NAME on origin is not ownership proof — pre-incident origin
    // refs still carry foreign tips (2026-07-17: verify-l3-rework-policy
    // re-adopted its stale polluted origin ref after a fresh reset). A missing
    // local branch may still recover from origin (ORIG-1 case).
    const originSha = await this.resolveOriginTaskTip(git, branch);
    if (originSha && (await mayAdopt(originSha, /* branch-missing ok */ true))) {
      await pushCand(originSha, 'origin');
    }

    const recovered = await findRecoverableTaskTip(git, branch, taskId, defaultBranch);
    if (recovered && (await mayAdopt(recovered, /* branch-missing ok */ true))) {
      await pushCand(recovered, 'local-recover');
    }

    // Grep reachable history for task-related subjects (e.g. leftover
    // pull/*/head after a force-push rewound origin). A loose token match
    // ("verify", "heavy") stole sibling tasks' commits in the 2026-07-15
    // contamination incident, so a token-matched candidate is only accepted
    // when it DESCENDS from the branch's current tip (a rewound-and-recovered
    // continuation of this task's own history). Exact-id matches stand alone.
    try {
      const greps = new Set<string>([taskId]);
      for (const tok of taskId.toLowerCase().split(/[-_./]+/).filter((t) => t.length >= 4)) {
        greps.add(tok);
      }
      for (const g of greps) {
        try {
          const log = await git.raw([
            'log',
            '--all',
            '--format=%H %s',
            '-n',
            '15',
            '--grep',
            g,
            '-i',
          ]);
          for (const line of log.split('\n')) {
            const m = /^([0-9a-f]{7,40})\s+(.*)$/i.exec(line.trim());
            if (!m) continue;
            const [, sha, subject] = m as unknown as [string, string, string];
            if (isStashLikeSubject(subject)) continue;
            if (!(await mayAdopt(sha, /* reachable elsewhere — exact id only */ false))) {
              continue; // token-only match with no shared history — foreign work
            }
            await pushCand(sha, 'log-all');
          }
        } catch {
          /* next token */
        }
      }
    } catch {
      /* ignore */
    }

    if (cands.length === 0) return null;
    // Prefer more work ahead of default; break ties with task-related subjects.
    cands.sort((a, b) => {
      if (b.ahead !== a.ahead) return b.ahead - a.ahead;
      return b.ts - a.ts;
    });
    const best = cands[0]!;
    return { sha: best.sha, source: best.source, ahead: best.ahead };
  }

  /** Read origin tip for hercules/<id> and ensure the object is local. */
  private async resolveOriginTaskTip(
    git: SimpleGit,
    branch: string,
  ): Promise<string | null> {
    try {
      const url = (await git.raw(['remote', 'get-url', 'origin'])).trim();
      if (!url) return null;
      const ls = (await git.raw(['ls-remote', '--heads', url, branch])).trim();
      const sha = (ls.split(/\s+/)[0] ?? '').trim();
      if (!/^[0-9a-f]{7,40}$/i.test(sha)) return null;
      try {
        await git.raw(['fetch', '--no-tags', url, sha]);
      } catch {
        /* object may already be local */
      }
      return sha;
    } catch {
      return null;
    }
  }

  /**
   * If `hercules/<id>` already exists but points at a stash commit, force it
   * back to the nearest non-stash first-parent (usually the real feat commit).
   */
  private async sanitizeStashTipIfNeeded(
    git: SimpleGit,
    branch: string,
    taskId: string,
    defaultBranch: string,
  ): Promise<void> {
    try {
      const branches = await git.branch();
      const has =
        branches.all.includes(branch) || branches.all.includes(`refs/heads/${branch}`);
      if (!has) return; // nothing to sanitize — recovery may create the ref next

      const tip = (await git.raw(['rev-parse', `refs/heads/${branch}`])).trim();
      if (!/^[0-9a-f]{7,40}$/i.test(tip)) return;
      const subj = (await git.raw(['log', '-1', '--format=%s', tip])).trim();
      if (!isStashLikeSubject(subj)) return;
      const cleaned = await resolveNonStashTip(git, tip, defaultBranch);
      if (!cleaned || cleaned === tip) {
        console.error(
          `[hercules] ${branch} tip is stash-like (${subj.slice(0, 48)}) but no clean parent found`,
        );
        return;
      }
      await git.raw(['branch', '-f', branch, cleaned]);
      console.error(
        `[hercules] sanitized stash tip on ${branch}: ${tip.slice(0, 12)} → ${cleaned.slice(0, 12)} (task ${taskId})`,
      );
    } catch (err) {
      console.error(
        `[hercules] sanitizeStashTip ${branch}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Verified-SHA invariant: the preserved branch tip must still contain the
   * commit verification saw. Tolerates exactly one commit on top only when
   * that tip's tree is identical to the verified commit's tree (empty /
   * tree-identical preserve auto-commit). Content-changing extras are refused.
   * Returns the accepted tip SHA so callers can pin it for merge.
   */
  async preservedTipStatus(
    repoKey: string,
    taskId: string,
    verifiedSha: string,
  ): Promise<{ ok: boolean; tip: string | null; reason: string }> {
    if (!isValidIdentifier(repoKey) || !isValidIdentifier(taskId)) {
      return { ok: false, tip: null, reason: 'unsafe repo key or task id' };
    }
    if (!/^[0-9a-f]{7,40}$/i.test(verifiedSha)) {
      return { ok: false, tip: null, reason: `invalid verified SHA '${verifiedSha}'` };
    }
    const branch = branchFor(taskId);
    const git = simpleGit(this.mirrorPath(repoKey));
    let tip: string;
    try {
      tip = (await git.raw(['rev-parse', `refs/heads/${branch}`])).trim();
    } catch {
      return {
        ok: false,
        tip: null,
        reason: `branch ${branch} is missing from the mirror — verified work is not preserved`,
      };
    }
    if (tip.toLowerCase() === verifiedSha.toLowerCase()) {
      return { ok: true, tip, reason: '' };
    }
    try {
      const behind = Number(
        (await git.raw(['rev-list', '--count', `${tip}..${verifiedSha}`])).trim(),
      );
      const ahead = Number(
        (await git.raw(['rev-list', '--count', `${verifiedSha}..${tip}`])).trim(),
      );
      if (Number.isFinite(behind) && Number.isFinite(ahead) && behind === 0 && ahead === 0) {
        // Same commit (e.g. abbreviated verifiedSha vs full tip) — exact tip OK.
        return { ok: true, tip, reason: '' };
      }
      if (Number.isFinite(behind) && Number.isFinite(ahead) && behind === 0 && ahead === 1) {
        // Single extra commit is OK only when trees match (no content change).
        try {
          const tipTree = (await git.raw(['rev-parse', `${tip}^{tree}`])).trim();
          const verifiedTree = (await git.raw(['rev-parse', `${verifiedSha}^{tree}`])).trim();
          if (tipTree.toLowerCase() === verifiedTree.toLowerCase()) {
            return { ok: true, tip, reason: '' };
          }
          return {
            ok: false,
            tip,
            reason:
              `branch ${branch} tip ${tip.slice(0, 12)} has a content-changing commit after verified ` +
              `${verifiedSha.slice(0, 12)} — only a tree-identical preserve auto-commit is tolerated`,
          };
        } catch (err) {
          return {
            ok: false,
            tip,
            reason:
              `could not compare trees for verified tip ${verifiedSha.slice(0, 12)}: ` +
              `${(err as Error).message}`,
          };
        }
      }
      return {
        ok: false,
        tip,
        reason:
          `branch ${branch} tip ${tip.slice(0, 12)} does not contain the verified commit ` +
          `${verifiedSha.slice(0, 12)} (behind ${behind}, ahead ${ahead}) — ` +
          `the packet describes work that would not ship`,
      };
    } catch (err) {
      return {
        ok: false,
        tip,
        reason: `verified commit ${verifiedSha.slice(0, 12)} is not comparable to ${branch} tip: ${(err as Error).message}`,
      };
    }
  }

  async inspectPreservedCandidate(
    repo: RepoConfig,
    taskId: string,
    expectedTip: string,
    baseRevision: string,
  ): Promise<{
    readonly tip: string;
    readonly filesTouched: readonly string[];
    readonly trustedDefaultRevision: string;
    readonly workflowContentAtTrustedDefault: string | null;
  }> {
    if (!isValidIdentifier(repo.key) || !isValidIdentifier(taskId)) {
      throw new WorkspaceError('preserved candidate proof rejected an unsafe identifier');
    }
    if (!isFullCommitSha(expectedTip) || !isFullCommitSha(baseRevision)) {
      throw new WorkspaceError('preserved candidate proof requires full commit SHAs');
    }
    const branch = branchFor(taskId);
    let mirror: string;
    try {
      mirror = await this.ensureMirror(repo, {
        requireFreshDefault: true,
        skipReconcileTaskBranch: branch,
      });
    } catch {
      throw new WorkspaceError(`trusted default branch for repo '${repo.key}' is unavailable`);
    }
    const git = simpleGit(mirror);
    let originUrl: string;
    try {
      originUrl = (await git.raw(['remote', 'get-url', 'origin'])).trim();
    } catch {
      throw new WorkspaceError(`preserved candidate remote for task '${taskId}' is unavailable`);
    }
    let remoteTip: string | null;
    try {
      remoteTip = await readRemoteTaskBranchTip(git, originUrl, branch);
    } catch {
      throw new WorkspaceError(`preserved candidate remote for task '${taskId}' is unavailable`);
    }
    const expected = expectedTip.toLowerCase();
    if (remoteTip !== expected) {
      throw new WorkspaceError(`preserved candidate for task '${taskId}' moved`);
    }
    const fetchedRef = `refs/hercules-fetch/${taskId}-proof-${randomBytes(8).toString('hex')}`;
    let proof: {
      readonly tip: string;
      readonly filesTouched: readonly string[];
      readonly trustedDefaultRevision: string;
      readonly workflowContentAtTrustedDefault: string | null;
    } | null = null;
    let proofError: unknown = null;
    try {
      await git.raw([
        'fetch',
        '--no-tags',
        originUrl,
        `refs/heads/${branch}:${fetchedRef}`,
      ]);
      const fetchedTip = (
        await git.raw(['rev-parse', `${fetchedRef}^{commit}`])
      ).trim().toLowerCase();
      if (fetchedTip !== expected) {
        throw new WorkspaceError(`preserved candidate for task '${taskId}' moved`);
      }
      let trustedDefaultRevision: string;
      try {
        trustedDefaultRevision = (
          await git.raw(['rev-parse', `refs/heads/${repo.defaultBranch}^{commit}`])
        ).trim().toLowerCase();
      } catch {
        throw new WorkspaceError(
          `trusted default branch for repo '${repo.key}' is unavailable`,
        );
      }
      try {
        const candidateBase = (
          await git.raw(['merge-base', baseRevision, fetchedTip])
        ).trim().toLowerCase();
        if (candidateBase !== baseRevision.toLowerCase()) throw new Error('not ancestor');
      } catch {
        throw new WorkspaceError(
          `preserved candidate for task '${taskId}' does not contain the trusted base`,
        );
      }
      try {
        const defaultBase = (
          await git.raw(['merge-base', baseRevision, trustedDefaultRevision])
        ).trim().toLowerCase();
        if (defaultBase !== baseRevision.toLowerCase()) throw new Error('not ancestor');
      } catch {
        throw new WorkspaceError(
          `candidate base for task '${taskId}' is not an ancestor of the trusted default branch`,
        );
      }
      const workflowPath = repo.workflow.trim().replace(/^\/+/, '');
      if (
        workflowPath.length === 0 ||
        workflowPath.includes('..') ||
        workflowPath.includes('\\')
      ) {
        throw new WorkspaceError(`trusted WORKFLOW path for repo '${repo.key}' is unsafe`);
      }
      let workflowContentAtTrustedDefault: string | null;
      try {
        workflowContentAtTrustedDefault = await git.show([
          `${trustedDefaultRevision}:${workflowPath}`,
        ]);
      } catch {
        workflowContentAtTrustedDefault = null;
      }
      let names: string;
      try {
        names = await git.raw([
          'diff',
          '--name-only',
          '--no-renames',
          '-z',
          baseRevision,
          fetchedTip,
          '--',
        ]);
      } catch {
        throw new WorkspaceError(
          `preserved candidate diff for task '${taskId}' is unavailable`,
        );
      }
      const filesTouched = names.split('\0').filter((path) => path.length > 0);
      await this.beforeExactCandidateReturnVerify?.(branch);
      let finalRemoteTip: string | null;
      try {
        finalRemoteTip = await readRemoteTaskBranchTip(git, originUrl, branch);
      } catch {
        throw new WorkspaceError(`preserved candidate for task '${taskId}' moved`);
      }
      if (finalRemoteTip !== expected) {
        throw new WorkspaceError(`preserved candidate for task '${taskId}' moved`);
      }
      let finalTrustedDefault: string | null;
      try {
        finalTrustedDefault = await readRemoteTaskBranchTip(
          git,
          originUrl,
          repo.defaultBranch,
        );
      } catch {
        throw new WorkspaceError(`trusted default branch for repo '${repo.key}' moved`);
      }
      if (finalTrustedDefault !== trustedDefaultRevision) {
        throw new WorkspaceError(`trusted default branch for repo '${repo.key}' moved`);
      }
      proof = {
        tip: fetchedTip,
        filesTouched,
        trustedDefaultRevision,
        workflowContentAtTrustedDefault,
      };
    } catch (err) {
      proofError = err;
    }
    try {
      await git.raw(['update-ref', '-d', fetchedRef]);
    } catch {
      proofError = new WorkspaceError(
        `could not clean preserved candidate proof ref for task '${taskId}'`,
      );
    }
    if (proofError !== null) throw proofError;
    if (proof === null) {
      throw new WorkspaceError(`preserved candidate proof for task '${taskId}' is unavailable`);
    }
    return proof;
  }

  async proveEmptyTaskLease(
    repo: RepoConfig,
    taskId: string,
    expectedBaseRevision: string,
  ): Promise<EmptyTaskLeaseProofResult> {
    if (!isValidIdentifier(repo.key) || !isValidIdentifier(taskId)) {
      return {
        kind: 'held',
        code: 'ambiguous_git',
        detail: 'empty-lease proof rejected an unsafe identifier',
      };
    }
    const workspaceDir = this.confine(join(this.root, repo.key, taskId));
    return observeEmptyTaskLease({
      mirrorDir: this.mirrorPath(repo.key),
      workspaceDir,
      defaultBranch: repo.defaultBranch,
      taskId,
      expectedBaseRevision,
    });
  }

  /** Assert a path resolves strictly inside the isolation root (§10). */
  private confine(path: string): string {
    const resolved = resolve(path);
    if (resolved !== this.root && !resolved.startsWith(this.root + sep)) {
      throw new WorkspaceError(`path '${path}' resolves outside the isolation root`);
    }
    return resolved;
  }
}

/** Map `hercules/<taskId>` → taskId when the id is a valid identifier. */
export function taskIdFromHerculesBranch(branch: string): string | null {
  const b = branch.trim();
  if (!b.startsWith(BRANCH_PREFIX)) return null;
  const id = b.slice(BRANCH_PREFIX.length);
  return isValidIdentifier(id) ? id : null;
}

/**
 * Git stash creates merge commits titled like:
 *   "WIP on hercules/logout: …"
 *   "index on hercules/logout: …"
 *   "untracked files on hercules/logout: …"
 * Recovering those as the task tip wrecks reject/rework (logout case study).
 */
export function isStashLikeSubject(subject: string): boolean {
  const s = subject.trim();
  return (
    /^WIP on\b/i.test(s) ||
    /^index on\b/i.test(s) ||
    /^untracked files on\b/i.test(s) ||
    /^On [^:]+:\s/i.test(s) // "On hercules/x: …" older stash forms
  );
}

/**
 * Walk first-parent from `tip` until a non-stash subject (max 12 steps).
 * For multi-parent stash merges, first parent is the pre-stash HEAD.
 */
export async function resolveNonStashTip(
  git: SimpleGit,
  tip: string,
  defaultBranch: string,
): Promise<string | null> {
  let sha = tip;
  for (let i = 0; i < 12; i += 1) {
    try {
      const subj = (await git.raw(['log', '-1', '--format=%s', sha])).trim();
      if (!isStashLikeSubject(subj)) {
        // Prefer not to land on defaultBranch tip alone (empty task).
        if (defaultBranch) {
          try {
            const base = (await git.raw(['rev-parse', defaultBranch])).trim();
            if (sha === base) return null;
          } catch {
            /* ignore */
          }
        }
        return sha;
      }
      const parents = (await git.raw(['rev-parse', `${sha}^@`]))
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^[0-9a-f]{7,40}$/i.test(l));
      // Stash merge: first parent is the branch tip before stash.
      const next = parents[0];
      if (!next) return null;
      sha = next;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * True when `descendant` contains `ancestor` in its commit history
 * (rev-list based — merge-base --is-ancestor is unreliable via simple-git on
 * bare mirrors, see findRecoverableTaskTip).
 */
export async function descendsFrom(
  git: SimpleGit,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    const behind = Number(
      (await git.raw(['rev-list', '--count', `${descendant}..${ancestor}`])).trim(),
    );
    const ahead = Number(
      (await git.raw(['rev-list', '--count', `${ancestor}..${descendant}`])).trim(),
    );
    return Number.isFinite(behind) && Number.isFinite(ahead) && behind === 0 && ahead > 0;
  } catch {
    return false;
  }
}

/** Commits on `sha` not reachable from `defaultBranch`. -1 if uncomputable. */
export async function commitsAheadOfDefault(
  git: SimpleGit,
  sha: string,
  defaultBranch: string,
): Promise<number> {
  if (!defaultBranch) return -1;
  for (const base of [defaultBranch, `refs/heads/${defaultBranch}`]) {
    try {
      const n = Number((await git.raw(['rev-list', '--count', `${base}..${sha}`])).trim());
      if (Number.isFinite(n)) return n;
    } catch {
      /* try next form */
    }
  }
  return -1;
}

/**
 * Soft relatedness: full task id, or any hyphen/underscore token ≥4 chars
 * (settings-build → "settings" matches "feat(settings): …").
 */
export function taskSubjectLooksRelated(taskId: string, subject: string): boolean {
  const s = subject.toLowerCase();
  const id = taskId.toLowerCase();
  if (s.includes(id)) return true;
  for (const tok of id.split(/[-_./]+/).filter((t) => t.length >= 4)) {
    if (s.includes(tok)) return true;
  }
  return false;
}

/**
 * Locate a commit SHA to reattach as hercules/<taskId>.
 * Pure-ish helper (git reads only) — exported for unit tests.
 *
 * After `branch -D`, commits are often **dangling** (not on any ref), so
 * `git log --all` alone is not enough — we also scan fsck unreachables.
 * **Never returns git-stash WIP nodes.**
 */
export async function findRecoverableTaskTip(
  git: SimpleGit,
  branch: string,
  taskId: string,
  defaultBranch: string,
): Promise<string | null> {
  const needle = `hercules: ${taskId}`;
  const idToken = taskId.toLowerCase();

  const accept = async (sha: string): Promise<string | null> => {
    try {
      const subj = (await git.raw(['log', '-1', '--format=%s', sha])).trim();
      if (isStashLikeSubject(subj)) {
        return resolveNonStashTip(git, sha, defaultBranch);
      }
      return sha;
    } catch {
      return null;
    }
  };

  // 1) Reflog of the deleted branch name (if still present).
  try {
    const reflog = await git.raw(['reflog', 'show', '--no-abbrev', branch]);
    for (const line of reflog.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const sha = line.split(/\s+/)[0] ?? '';
      if (!/^[0-9a-f]{7,40}$/i.test(sha)) continue;
      const ok = await accept(sha);
      if (ok) return ok;
    }
  } catch {
    /* no reflog */
  }

  // 2) Still-reachable commits (`log --all`) whose subject matches preserve msg.
  try {
    const out = await git.raw([
      'log',
      '--all',
      '--format=%H %s',
      '-n',
      '20',
      `--grep=${needle}`,
    ]);
    for (const line of out.split('\n')) {
      const m = /^([0-9a-f]{7,40})\s+(.*)$/i.exec(line.trim());
      if (!m) continue;
      if (isStashLikeSubject(m[2] ?? '')) continue;
      return m[1]!;
    }
  } catch {
    /* no matching commits */
  }

  // 3) Dangling commits (branch -D orphans) — match preserve subject, then
  //    any agent commit not on defaultBranch (logout: hooks tips used feat()
  //    subjects, not hercules: <id>). Skip stash-like subjects always.
  try {
    const fsck = await git.raw(['fsck', '--unreachable', '--no-reflogs']);
    // Git prints "unreachable commit" and/or "dangling commit" depending on version.
    const dangling = fsck
      .split('\n')
      .map((l) => {
        const m = /(?:dangling|unreachable) commit ([0-9a-f]{7,40})/i.exec(l);
        return m?.[1] ?? null;
      })
      .filter((s): s is string => s !== null)
      .slice(0, 80);

    let baseTip = '';
    try {
      baseTip = (await git.raw(['rev-parse', defaultBranch])).trim();
    } catch {
      try {
        baseTip = (await git.raw(['rev-parse', `refs/heads/${defaultBranch}`])).trim();
      } catch {
        baseTip = '';
      }
    }

    type Cand = { sha: string; ts: number; score: number; ahead: number };
    const cands: Cand[] = [];
    for (const sha of dangling) {
      try {
        const subj = (await git.raw(['log', '-1', '--format=%s', sha])).trim();
        if (isStashLikeSubject(subj)) continue;
        if (subj.includes(needle)) {
          // Exact preserve subject wins immediately.
          return sha;
        }
        // Prefer commits **ahead of** defaultBranch (agent work). `rev-list
        // base..sha` count > 0 means sha has commits not in main. Do not use
        // merge-base --is-ancestor here: simple-git + bare mirrors made that
        // check unreliable and dropped every candidate (logout tip loss).
        let ahead = 0;
        if (baseTip) {
          try {
            ahead = Number(
              (await git.raw(['rev-list', '--count', `${baseTip}..${sha}`])).trim(),
            );
          } catch {
            continue; // no common history / bad object
          }
          if (!Number.isFinite(ahead) || ahead <= 0) continue;
        }
        const tsRaw = (await git.raw(['log', '-1', '--format=%ct', sha])).trim();
        const ts = Number(tsRaw) || 0;
        let score = 1 + ahead;
        if (subj.toLowerCase().includes(idToken)) score += 3;
        else if (taskSubjectLooksRelated(taskId, subj)) score += 2;
        if (/\b(feat|fix|test)\b/i.test(subj)) score += 1;
        // Deprioritize multi-parent merges (stash WIP is a 3-parent merge).
        try {
          const parents = (await git.raw(['rev-parse', `${sha}^@`]))
            .split('\n')
            .filter((l) => l.trim().length > 0);
          if (parents.length > 1) score -= 5;
        } catch {
          /* ignore */
        }
        cands.push({ sha, ts, score, ahead });
      } catch {
        /* skip bad object */
      }
    }
    cands.sort((a, b) => b.score - a.score || b.ahead - a.ahead || b.ts - a.ts);
    if (cands[0]) return cands[0].sha;
  } catch {
    /* fsck unavailable */
  }

  return null;
}

/** Split `git worktree list --porcelain` into entries (blank-line separated). */
function worktreePorcelainEntries(porcelain: string): string[] {
  const nl = String.fromCharCode(10);
  return porcelain.split(new RegExp(`(?:${nl}){2,}`));
}

/** Git errors that mean the path is already not a registered worktree. */
function isUnregisteredWorktreeError(message: string): boolean {
  return (
    /is not a working tree/i.test(message) ||
    /not a valid path/i.test(message) ||
    /does not exist/i.test(message)
  );
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * A no-op workspace provider for running without real target repos (e.g. the
 * Phase-2 fake adapter, which ignores the workspace). Returns a synthetic
 * workspace and touches nothing on disk.
 *
 * Ancestry probes fail closed by default (unknown). Unit tests that need
 * gate-merge reachability must call {@link allowAncestry} with explicit SHAs.
 */
export class NoopWorkspaces implements Workspaces {
  private tip = '0000000000000000000000000000000000000001';
  private trustedWorkflow: string | null = null;
  private readonly ancestryAllow = new Set<string>();

  constructor(private readonly root: string) {}

  /** Mark full SHAs as reachable from the synthetic default tip (tests). */
  allowAncestry(...shas: string[]): this {
    for (const s of shas) {
      const want = s.trim().toLowerCase();
      if (/^[0-9a-f]{40}$/.test(want)) this.ancestryAllow.add(want);
    }
    return this;
  }

  /** Override the synthetic default-branch tip (tests / tip-move races). */
  setDefaultBranchTip(tip: string): this {
    this.tip = tip.trim();
    return this;
  }

  setTrustedWorkflow(content: string | null): this {
    this.trustedWorkflow = content;
    return this;
  }

  async create(repo: RepoConfig, taskId: string, opts?: CreateOptions): Promise<Workspace> {
    const expectedTip = opts?.expectedBaseTip?.trim();
    if (expectedTip && /^[0-9a-f]{7,40}$/i.test(expectedTip)) {
      if (this.tip.toLowerCase() !== expectedTip.toLowerCase()) {
        throw new WorkspaceError(
          `default branch tip moved during dependency gate ` +
            `(expected ${expectedTip}, got ${this.tip})`,
        );
      }
    }
    const dir = join(this.root, repo.key, taskId);
    return {
      taskId,
      repo: repo.key,
      dir,
      branch: branchFor(taskId),
      allocation: { slug: taskId, port: 0, scratchDir: join(dir, '.scratch') },
      branchLease: {
        expectedBaseRevision: (expectedTip ?? opts?.expectedBaseRevision ?? this.tip).toLowerCase(),
        expectedRemoteTip: Object.prototype.hasOwnProperty.call(opts ?? {}, 'expectedRemoteTip')
          ? opts?.expectedRemoteTip ?? null
          : null,
      },
    };
  }

  async workspaceHead(workspace: Workspace): Promise<string | null> {
    return workspace.branchLease.expectedRemoteTip ?? workspace.branchLease.expectedBaseRevision;
  }

  async remove(): Promise<void> {
    // nothing to tear down
  }

  async preserve(): Promise<PreserveResult> {
    // nothing to preserve (the fake adapter produced no real change)
    return EMPTY_PRESERVE;
  }

  async managedDisposition(): Promise<ManagedDisposition> {
    return 'absent';
  }

  drainMirrorEvents(): MirrorBranchEvent[] {
    return [];
  }

  async inspect(): Promise<WorkspaceImpact | null> {
    return null;
  }

  async reclaimOrphans(): Promise<string[]> {
    return [];
  }

  async readWorkflow(): Promise<string | null> {
    return this.trustedWorkflow;
  }

  async readTrustedDefaultRevisionSnapshot(): Promise<TrustedDefaultRevisionSnapshot | null> {
    if (!/^[0-9a-f]{40}$/i.test(this.tip)) return null;
    return { revision: this.tip.toLowerCase(), workflowContent: this.trustedWorkflow };
  }

  async readTrustedFile(): Promise<string | null> {
    return null;
  }

  /**
   * Synthetic tip for unit tests / fake adapter. Real WorktreeManager reads
   * the bare mirror; without a tip the dependency gate would always hold as
   * stale_mirror even when metadata is complete.
   */
  async defaultBranchHead(): Promise<string | null> {
    return this.tip;
  }

  /**
   * Fake mode has no real mirror. Default is fail-closed (unknown). Tests
   * that need reachability inject explicit SHAs via {@link allowAncestry}.
   */
  async containsOnDefaultBranch(_repo: RepoConfig, sha: string): Promise<boolean | null> {
    const want = sha.trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(want)) return null;
    if (this.ancestryAllow.has(want)) return true;
    return null;
  }

  async proveDefaultBranchAncestry(
    _repo: RepoConfig,
    shas: readonly string[],
  ): Promise<DefaultBranchAncestryProof> {
    const reachable = new Map<string, boolean | null>();
    for (const raw of shas) {
      const want = raw.trim().toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(want)) {
        reachable.set(raw, null);
      } else if (this.ancestryAllow.has(want)) {
        reachable.set(raw, true);
      } else {
        reachable.set(raw, null);
      }
    }
    return { tip: this.tip, reachable };
  }

  async deployCwd(): Promise<string> {
    return this.root;
  }

  async rangeShas(): Promise<ReadonlySet<string> | undefined> {
    return undefined;
  }

  async purgeTask(): Promise<void> {
    // nothing on disk in fake mode
  }

  async gcTerminalArtifacts(
    targets: readonly { readonly taskId: string; readonly repoKey: string }[],
    opts: GcTerminalArtifactsOpts,
  ): Promise<GcTerminalArtifactsResult> {
    const logLine = formatWorktreeGcLogLine({
      dryRun: opts.dryRun,
      retentionDays: opts.retentionDays ?? 0,
      candidates: targets.length,
      worktrees: [],
      screenshots: [],
      skippedLive: [],
    });
    return {
      dryRun: opts.dryRun,
      worktreesRemoved: [],
      screenshotsRemoved: [],
      skippedLive: [],
      logLine,
    };
  }
}
