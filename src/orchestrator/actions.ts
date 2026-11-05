/**
 * Coordination layer — human actions on the control repo (SPEC §10, §14).
 *
 * The daemon acts on its own logic plus *explicit human actions in the UI*. Each
 * action is a control-repo mutation (write task file + commit); the next tick
 * picks it up — so e.g. "cancel" needs no special teardown path, the loop's
 * reconcile sees the terminal state and stops the run.
 *
 * Instruction-source boundary (SPEC §10): inputs here come from authenticated UI
 * actions, never from observed content (task bodies, web pages, agent output).
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  isValidIdentifier,
  isTaskState,
  isDeletableState,
  canSoftDelete,
  isDueForAutoDelete,
  DEFAULT_AUTO_DELETE_DAYS,
  githubPrStateToStatus,
  hasOpenPr,
  type Task,
  type TaskState,
  type PrStatus,
} from '../domain/task.js';
import {
  TASK_SLUG_MAX,
  isValidTaskSlug,
  nextTaskNumber,
  shortSlug,
} from '../domain/taskSlug.js';
import { stampCancellationFields } from '../domain/cancellationStamp.js';
import type { TaskBranchLease } from '../domain/taskBranchLease.js';
import {
  decideChatIdempotency,
  formatHumanSteerSection,
  normalizeClientMessageId,
  type ChatPriorMode,
} from '../domain/chatDelivery.js';
import {
  DEFAULT_WORKTREE_GC_DAYS,
  selectWorktreeGcTargets,
} from '../domain/worktreeGc.js';
import type {
  GcTerminalArtifactsOpts,
  GcTerminalArtifactsResult,
} from '../isolation/worktree.js';
import { WorkspaceError } from '../isolation/worktree.js';
import { assertTransition, TransitionError } from '../domain/stateMachine.js';
import {
  ADAPTER_KINDS,
  isAdapterKind,
  isRemoteFactoryPrIdentity,
  resolveAdapterKind,
  type AdapterKind,
} from '../domain/agents.js';
import {
  buildFactoryConflictSteer,
  buildFactoryConflictThrashSection,
  isFactoryConflictRework,
  isSafeFactoryGitRef,
} from '../domain/factoryConflict.js';
import {
  buildFactoryCiSteer,
  buildFactoryCiThrashSection,
  isFactoryCiFailure,
  shouldCapPrCiRequeue,
} from '../domain/factoryCi.js';
import {
  buildFactoryBehindSteer,
  buildFactoryBehindThrashSection,
  buildFactoryRebasedAuditSection,
  shouldCapPrBehindRequeue,
  shouldRebaseFactoryBehind,
  shouldRequeueFactoryBehind,
} from '../domain/factoryBehind.js';
import {
  buildFactoryReadyAuditSection,
  shouldMarkFactoryPrReady,
} from '../domain/factoryDraft.js';
import {
  buildFactoryMergedAuditSection,
  buildFactoryMergeWithheldAuditSection,
  shouldMergeFactoryPr,
} from '../domain/factoryMerge.js';
import {
  formatAbandonSessionNote,
  shouldAbandonSessionOnRetry,
} from '../domain/agentDeath.js';
import {
  DEFAULT_EXECUTION_CLASS,
  isExecutionClass,
  isHostMutatingClass,
  resolveExecutionClass,
  stampHostOperationApproval,
  validateHostCommandScope,
  type ExecutionClass,
} from '../domain/executionClass.js';
import type { ControlPort } from './orchestrator.js';
import { RepoProbeError, type RepoProbe } from './repoProbe.js';
import { assertSafeRepoUrl, RepoUrlError } from '../control/reposConfig.js';
import { executionPolicySchema } from '../control/executionPolicyYaml.js';
import {
  openPullRequest,
  OpenPrError,
  type GhRunner,
  type OpenPrResult,
} from './openPr.js';
import * as taskPr from './taskPr.js';
import type { PrSummary } from './taskPr.js';
import {
  aggregateRangeRisk,
  buildReleasePanelEntry,
  emptyRelease,
  previousProductionSha,
  type AheadTaskGitFacts,
  type ReleasePanelEntry,
  resolveStagingPublicUrl,
} from '../domain/release.js';
import { parseWorkflow, WorkflowError } from '../control/workflow.js';
import { readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildPrConflictThrashSection,
  shouldCapPrConflictRequeue,
} from '../domain/thrash.js';
import type { RepoConfig } from '../domain/repos.js';
import {
  toWorkspaceSuccessionPublicDto,
  type WorkspaceSuccessionPublicDto,
} from '../domain/workspaceSuccession.js';
import type { Workspace } from '../domain/allocation.js';
import type { Verifier } from './verifier.js';
import { renderPacketMarkdownWithNonce } from '../verification/packet.js';
import { withReviewPacket } from './orchestrator.js';
import { mutateControl } from './controlMutation.js';
import {
  evaluateReadinessAssist,
  type ReadinessAssistResult,
} from '../domain/readinessAssist.js';
import {
  evaluateGuardianReadiness,
  formatGuardianReadinessFailure,
  UNVERIFIED_B022_CAPABILITIES,
  type DaemonLeaseReadinessStatus,
  type GuardianHarnessCapabilities,
  type GuardianReadinessReceipt,
  type WorkflowCliEvidenceStatus,
} from '../domain/guardianReadiness.js';
import type { Gate } from '../verification/gates.js';
import { isVerificationAborted } from '../domain/verificationRun.js';
import {
  missingHumanAcknowledgements,
  hasCheckableCriteria,
  PLAN_PENDING_REASON,
} from '../domain/acceptance.js';
import {
  findProtectedPathMentions,
  formatProtectedPathBlockMessage,
  FORCE_PROTECTED_PATH_LABEL,
  stampForceProtectedPath,
} from '../domain/protectedPaths.js';
import {
  effectivePathWriterLimit,
  normalizeAffectedPaths,
  normalizeProtectedPathsSnapshot,
  pathLeasePolicyFor,
  protectedPathsSnapshotsEqual,
  validateDiffAgainstScopes,
} from '../domain/taskPathLease.js';
import { isFirstTimeWorkflowBootstrap } from '../domain/taskPathLease.js';
import { isFullCommitSha } from '../domain/taskBranchLease.js';
import { effectiveRepoExecutionPolicy } from '../domain/repoExecutionPolicy.js';
import type { RepoExecutionPolicyInput } from '../domain/repoExecutionPolicy.js';
import {
  AUTO_MERGE_LABEL,
  appendAutoMergeNote,
  evaluateAutoMerge,
  resolveAutoMergePolicy,
  type AutoMergeDiff,
  type AutoMergePolicy,
} from '../domain/autoMerge.js';
import {
  validateDependencyRewire,
  type DependencyRewireChange,
} from '../domain/dependencyRewire.js';
import type { CliEvidencePlan } from '../domain/cliEvidence.js';
import type { TaskPathLeaseStore } from '../isolation/taskPathLeaseStore.js';
import { pathLeaseDeclarationDigest } from '../control/pathLeaseDigest.js';
import {
  buildSalvageForkBody,
  validateSalvageForkRequest,
  type SalvageForkInput,
} from '../domain/salvage.js';
import {
  buildBootstrapEscalationSection,
  buildDefaultRemediationBody,
  buildPlatformRemediationSection,
  isPlatformRemediationOriginal,
  isPlatformRemediationTask,
  planResumedOutcomeUpdate,
  stampBootstrapEscalation,
  stampOpenChain,
  validatePlatformRemediationRequest,
  type PlatformRemediationKind,
  type PlatformRemediationRequestInput,
} from '../domain/platformRemediation.js';
export type { PlatformRemediationRequestInput } from '../domain/platformRemediation.js';
import { computeQueueFrontPriority, isQueueState } from '../domain/queueFront.js';
export type { SalvageForkInput } from '../domain/salvage.js';
import {
  MergeError,
  MergeService,
  type MergeBatchResult,
} from './mergeService.js';
import {
  MergeOperationError,
  MergeOperationService,
} from './mergeOperationService.js';
import type { MergeOperationReceipt } from '../domain/mergeOperation.js';
import {
  PromoteService,
  PromoteServiceError,
  type PromoteResult,
} from './promoteService.js';

export class ActionError extends Error {
  override readonly name = 'ActionError';
  readonly code?: string;
  readonly paths?: readonly string[];
  readonly rule?: string;

  constructor(
    message: string,
    opts?: {
      readonly code?: string;
      readonly paths?: readonly string[];
      readonly rule?: string;
    },
  ) {
    super(message);
    if (opts?.code !== undefined) this.code = opts.code;
    if (opts?.paths !== undefined) this.paths = opts.paths;
    if (opts?.rule !== undefined) this.rule = opts.rule;
  }
}

/** Bilingual one-liner: naming a WORKFLOW protected_paths token is edit intent. */
export const PROTECTED_PATH_CREATE_RULE =
  'Naming a WORKFLOW protected_paths token is treated as edit intent unless force:true / 在任务正文点名 WORKFLOW protected_paths 路径视为编辑意图，除非 force:true';

/** Exact caller expectations no longer match the durable task lease. */
export class ActionConflictError extends ActionError {}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function policyDigest(repo: RepoConfig): string {
  const p = effectiveRepoExecutionPolicy(repo.executionPolicy ?? null);
  return sha256(JSON.stringify({
    profile: p.profile,
    sandbox: p.sandbox,
    network: p.network,
    envAllowlist: [...p.envAllowlist],
    forbidProductionSecrets: p.forbidProductionSecrets,
    forbidConnectorCredentials: p.forbidConnectorCredentials,
    forbidLivePersonalData: p.forbidLivePersonalData,
    workspaceWrite: p.workspaceWrite,
  }));
}

function validatedExecutionPolicy(
  value: RepoExecutionPolicyInput | null,
): RepoExecutionPolicyInput | null {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ActionError('executionPolicy must be an object or null');
  }
  const allowed = new Set([
    'profile', 'sandbox', 'network', 'envAllowlist', 'forbidProductionSecrets',
    'forbidConnectorCredentials', 'forbidLivePersonalData', 'workspaceWrite',
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ActionError(`unknown executionPolicy field '${key}'`);
  }
  const raw = {
    ...(value.profile !== undefined ? { profile: value.profile } : {}),
    ...(value.sandbox !== undefined ? { sandbox: value.sandbox } : {}),
    ...(value.network !== undefined ? { network: value.network } : {}),
    ...(value.envAllowlist !== undefined ? { env_allowlist: value.envAllowlist } : {}),
    ...(value.forbidProductionSecrets !== undefined
      ? { forbid_production_secrets: value.forbidProductionSecrets } : {}),
    ...(value.forbidConnectorCredentials !== undefined
      ? { forbid_connector_credentials: value.forbidConnectorCredentials } : {}),
    ...(value.forbidLivePersonalData !== undefined
      ? { forbid_live_personal_data: value.forbidLivePersonalData } : {}),
    ...(value.workspaceWrite !== undefined ? { workspace_write: value.workspaceWrite } : {}),
  };
  const parsed = executionPolicySchema.safeParse(raw);
  if (!parsed.success || parsed.data === null) {
    const detail = parsed.success
      ? 'empty policy'
      : parsed.error.issues.map((i) => i.message).join('; ');
    throw new ActionError(`invalid executionPolicy: ${detail}`);
  }
  return parsed.data;
}

function validatedAutoMergePolicy(raw: unknown): AutoMergePolicy {
  try {
    return resolveAutoMergePolicy(raw);
  } catch (err) {
    throw new ActionError(`invalid autoMerge: ${(err as Error).message}`);
  }
}

/**
 * Phone checklist texts for human-axis DoD items. Required on approve when the
 * task body lists `(human)` (or untyped) criteria.
 */
export interface ApproveOpts {
  readonly humanAcknowledged?: readonly string[];
  /**
   * Operator override: approve WITHOUT a green automated packet (verify
   * crashed / flaky gates). The note is stamped into the task body as an
   * `## Operator override` section — trust chain must show a human took
   * responsibility, never a silent green. UI still hard-blocks on critical
   * anti-cheat findings.
   */
  readonly overrideNote?: string;
  /**
   * Auto-merge pilot approval (daemon, not a human). Stamps AUTO_MERGE_LABEL and an
   * `## Auto-merge (<ISO>)` section with `detail`; commit actor `auto-merge`.
   * Cannot be combined with overrideNote.
   */
  readonly autoMerge?: { readonly detail: string };
}

export interface AutoMergePilotReport {
  /** Task ids the sweep approved this pass. */
  readonly approved: readonly string[];
  /** Merge operation ids started, with their task ids. */
  readonly merges: readonly { readonly operationId: string; readonly taskIds: readonly string[] }[];
  /** Review tasks in opted-in repos that were NOT approved, with the evaluator's reason. */
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
}

export interface CreateTaskInput {
  readonly title: string;
  readonly repo: string;
  /** Optional; a safe id is generated from the title when omitted. */
  readonly id?: string;
  /**
   * Short English slug for the generated id (`<n>-<slug>`); ignored when `id`
   * is given. Must satisfy isValidTaskSlug. Typically supplied by the analyst
   * draft for titles that carry no ASCII words (CJK).
   */
  readonly slug?: string;
  readonly body?: string;
  readonly priority?: number;
  readonly blockedBy?: readonly string[];
  /**
   * How blocked_by edges are satisfied. Omit for legacy inference
   * (same-repo implement → gate_merge). Use `completion_only` for
   * analysis / cross-repo orchestration.
   */
  readonly dependencyMode?: 'gate_merge' | 'completion_only' | null;
  readonly labels?: readonly string[];
  /** Per-task agent; omit/null = repo then daemon default. */
  readonly adapter?: AdapterKind | null;
  /**
   * When true, task waits for human "Approve plan" before dispatch (G5).
   * Intent drafts default to true.
   */
  readonly planPending?: boolean;
  /**
   * Execution class (explore/implement/verify/host_operation/deploy).
   * Omit → implement (legacy coding default). host_operation/deploy stay
   * ineligible until {@link ActionService.approveHostOperation}.
   */
  readonly executionClass?: ExecutionClass | null;
  /**
   * Operator override: allow create even when the body explicitly names a
   * protected path. Stamps an audit section + label; without this, create
   * rejects so agents never burn a full run only to die at L5.
   */
  readonly force?: boolean;
  /**
   * Verify-from-ref (C3.43): an origin branch name or full commit SHA whose
   * exact commit seeds the task branch at first provision, so the verifier
   * judges an existing tip without an agent re-creating files. Requires
   * `executionClass: 'verify'` (read-only agent). Resolved against origin at
   * create time; unknown refs are refused.
   */
  readonly seedFromRef?: string;
  /**
   * Trusted default-branch tip for adopting an already-reviewed exact
   * candidate. Must be supplied with expectedRemoteTip and the complete path
   * lease declaration below.
   */
  readonly expectedBaseRevision?: string;
  /**
   * Exact existing remote task-branch tip to adopt. Creation through this API
   * does not accept a null/absent-branch lease: both exact SHAs are required.
   */
  readonly expectedRemoteTip?: string;
  /**
   * Declared base revision for path/writer leases (full 40-char SHA).
   * Required with affectedPaths under Guardian-grade path lease policy.
   */
  readonly plannedBaseRevision?: string;
  /**
   * Declared affected paths (exact file or directory subtree with trailing /).
   * Validated via task-file canonical rules on create.
   */
  readonly affectedPaths?: readonly string[];
  /**
   * WORKFLOW protected_paths snapshot at plan time (drift detection).
   * Empty array is valid; omit when unset.
   */
  readonly protectedPathsSnapshot?: readonly string[];
}

export interface RewireDependenciesInput {
  readonly changes: readonly DependencyRewireChange[];
}

export interface DependencyRewireReceipt {
  readonly committed: boolean;
  readonly hash?: string;
  readonly taskIds: readonly string[];
}

/** Human approves a host_operation / deploy task with bounded command scope. */
export interface ApproveHostOperationInput {
  readonly commandScope: readonly string[];
}

export interface AmendPathLeaseInput {
  readonly expected: {
    readonly state: 'review' | 'failed' | 'cancelled';
    readonly plannedBaseRevision: string;
    readonly expectedBaseRevision: string;
    readonly affectedPaths: readonly string[];
    readonly protectedPathsSnapshot: readonly string[];
    readonly expectedRemoteTip: string;
    readonly verifiedSha: string | null;
    readonly lastEventAt: string | null;
  };
  readonly replacement: {
    readonly plannedBaseRevision: string;
    readonly affectedPaths: readonly string[];
    readonly protectedPathsSnapshot: readonly string[];
  };
}

/** One stage in a multi-agent pipeline (creates a task + blocked_by edge). */
export interface PipelineStageInput {
  readonly title: string;
  readonly body?: string;
  /** Per-stage agent; omit/null = repo then daemon default. */
  readonly adapter?: AdapterKind | null;
  readonly labels?: readonly string[];
}

/**
 * Multi-step agent pipeline: N tasks with a linear blocked_by chain.
 * Stage 1 is eligible immediately; stage k waits until stage k-1 is terminal.
 * Each stage may pin a different adapter (implementer → reviewer → …).
 */
export interface CreatePipelineInput {
  readonly repo: string;
  /** Shared title prefix / base id seed (e.g. "act1-polish"). */
  readonly title: string;
  readonly stages: readonly PipelineStageInput[];
  readonly priority?: number;
  /** Optional id prefix; stages become `<prefix>-1`, `<prefix>-2`, … */
  readonly idPrefix?: string;
  /**
   * Same as {@link CreateTaskInput.force} — applies to every stage body
   * when protected paths are named.
   */
  readonly force?: boolean;
}

export interface AddRepoInput {
  readonly key: string;
  readonly url: string;
  readonly defaultBranch: string;
  readonly workflow?: string;
  readonly maxConcurrent?: number;
  /** Per-repo agent override; omit/null = daemon default. */
  readonly adapter?: AdapterKind | null;
  /** ready | incomplete (default incomplete for new repos). */
  readonly readiness?: 'ready' | 'incomplete';
  /** Explicit per-repo execution policy; Guardian registration requires it. */
  readonly executionPolicy?: RepoExecutionPolicyInput | null;
  /** Per-repo auto-merge pilot; omit/null = off for new repos. */
  readonly autoMerge?: Partial<AutoMergePolicy> | null;
}

export interface EditRepoPatch {
  readonly url?: string;
  readonly defaultBranch?: string;
  readonly workflow?: string;
  readonly maxConcurrent?: number;
  /**
   * Set to a kind to override, or `null` to clear back to the daemon default.
   * Omit the field entirely to leave the current override unchanged.
   */
  readonly adapter?: AdapterKind | null;
  readonly readiness?: 'ready' | 'incomplete';
  /** Set a policy block, null to clear, omit to preserve. */
  readonly executionPolicy?: RepoExecutionPolicyInput | null;
  /**
   * Set auto-merge policy, null to clear, omit to preserve.
   */
  readonly autoMerge?: Partial<AutoMergePolicy> | null;
  /**
   * When flipping incomplete→ready, skip the soft WORKFLOW/AGENTS check
   * (human explicitly overrides after seeing the checklist).
   */
  readonly forceReady?: boolean;
}

/** Combined soft SPEC checklist + hard Guardian B-022 receipt. */
export interface RepoReadinessReport extends ReadinessAssistResult {
  /** Soft checklist only (forceReady may override when guardian allows). */
  readonly softOk: boolean;
  /** Guardian B-022 receipt (applicable:false for non-guardian repos). */
  readonly guardian: GuardianReadinessReceipt;
}

/** In-memory per-repo readiness job (POST start + GET poll). */
export type RepoReadinessJobStatus = 'idle' | 'running' | 'done' | 'error';

export interface RepoReadinessJobStart {
  readonly key: string;
  readonly status: 'running';
  readonly startedAt: string;
}

export interface RepoReadinessJobState {
  readonly key: string;
  readonly status: RepoReadinessJobStatus;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly result?: RepoReadinessReport;
  readonly error?: string;
}

const READINESS_JOB_ERROR_MAX = 300;

function capReadinessJobError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length <= READINESS_JOB_ERROR_MAX
    ? msg
    : msg.slice(0, READINESS_JOB_ERROR_MAX);
}

/** Optional deps for Mark-ready checks against the trusted mirror + B-022. */
export interface ReadinessDeps {
  readonly workspaces: {
    readWorkflow(
      repo: RepoConfig,
      opts?: { readonly maxStaleMs?: number },
    ): Promise<string | null>;
    readTrustedFile?(repo: RepoConfig, path: string): Promise<string | null>;
    readTrustedDefaultRevisionSnapshot?(repo: RepoConfig): Promise<{
      readonly revision: string;
      readonly workflowContent: string | null;
    } | null>;
  };
  /** Current exclusive daemon lease status (defaults to unknown when omitted). */
  readonly daemonLeaseStatus?: () => DaemonLeaseReadinessStatus;
  /** Harness B-022 capabilities from an audited runtime-build boundary. */
  readonly capabilities?: GuardianHarnessCapabilities;
  /** Daemon default adapter for effective-adapter resolution. */
  readonly defaultAdapter?: AdapterKind;
  /** Execute the trusted plan on an isolated checkout of the exact revision. */
  readonly verifyCliEvidence?: (input: {
    readonly repo: RepoConfig;
    readonly revision: string;
    readonly plan: CliEvidencePlan;
    readonly buildGate: Gate | undefined;
  }) => Promise<WorkflowCliEvidenceStatus>;
}

/**
 * Optional deps for the phone Releases panel (list + deploy-staging-now).
 * Production wires trusted-mirror WORKFLOW/main tip + reconciler deploy-now.
 */
export interface ReleasePanelDeps {
  readonly workspaces: {
    readWorkflow(
      repo: RepoConfig,
      opts?: { readonly maxStaleMs?: number },
    ): Promise<string | null>;
    defaultBranchHead?(repo: RepoConfig): Promise<string | null>;
    rangeShas?(
      repo: RepoConfig,
      productionSha: string | null,
      stagingSha: string,
    ): Promise<ReadonlySet<string> | undefined>;
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
    commitDiffBrief?(
      repo: RepoConfig,
      sha: string,
    ): Promise<{
      readonly subject: string;
      readonly files: readonly string[];
      readonly insertions: number;
      readonly deletions: number;
    } | null>;
    findTaskMergeCommit?(
      repo: RepoConfig,
      taskId: string,
      productionSha: string | null,
      stagingSha: string,
    ): Promise<string | null>;
    rangeCommitList?(
      repo: RepoConfig,
      productionSha: string | null,
      stagingSha: string,
    ): Promise<readonly { sha: string; subject: string }[] | undefined>;
    /** Proven ancestry for gate-covered intermediate commits (release trust chain). */
    isCommitAncestor?(
      repo: RepoConfig,
      ancestor: string,
      descendant: string,
    ): Promise<boolean | null>;
  };
  /** Flags the release reconciler to bypass debounce on the next tick. */
  readonly requestStagingDeployNow?: (repoKey: string) => void;
  /**
   * Overall staging verify budget (ms) for the Releases panel elapsed/abnormal
   * UI. Defaults to 15 min when unset.
   */
  readonly stagingVerifyTimeoutMs?: number;
  /**
   * Root for staging evidence screenshots (`…/screenshots/releases`).
   * Listed basenames are returned in the panel payload; images served via
   * authenticated `/api/releases/:repo/screenshots/:name`.
   */
  readonly releaseScreenshotsRoot?: string;
  /**
   * Read staging UI token for copy-to-clipboard (value of STAGING_UI_TOKEN
   * or WORKFLOW auth_token_env). Never logged; only returned over Bearer auth.
   */
  readonly resolveStagingUiToken?: (authTokenEnv: string | undefined) => string | null;
}

/** Optional hooks so Delete can close PRs and wipe worktrees/screenshots. */
export interface TaskCleanupDeps {
  readonly workspaces?: {
    remove(taskId: string): Promise<void>;
    purgeTask?(repoKey: string, taskId: string): Promise<void>;
    /**
     * Disk hygiene GC: worktrees + optional screenshots for terminal tasks.
     * Must never delete remote branches or control-repo history.
     */
    gcTerminalArtifacts?(
      targets: readonly { readonly taskId: string; readonly repoKey: string }[],
      opts: GcTerminalArtifactsOpts,
    ): Promise<GcTerminalArtifactsResult>;
  };
  readonly screenshotsRoot?: string;
  /**
   * Close Remote Control sessions bound to this task (task-live id match,
   * or free chat with linkedTaskId). Always runs on delete — not only cleanup.
   */
  readonly closeSessionsForTask?: (taskId: string) => Promise<readonly string[]>;
  /**
   * Retention for terminal auto-delete (done/cancelled/failed), ms.
   * Each task uses its own endedAt (then lastEventAt / createdAt). 0 = off.
   * Default 30 days when unset.
   */
  readonly autoDeleteRetentionMs?: number;
  /**
   * Worktree / screenshot GC retention (ms). 0 = disabled.
   * Default 7 days when unset via {@link DEFAULT_WORKTREE_GC_DAYS}.
   */
  readonly worktreeGcRetentionMs?: number;
  /** When true, GC only logs candidates (safe default for first enable). */
  readonly worktreeGcDryRun?: boolean;
  /** When true, also purge screenshots/<taskId> for due terminal tasks. */
  readonly worktreeGcPurgeScreenshots?: boolean;
  /**
   * Ids to never GC this process (in_progress / stopping). Optional; usually
   * empty because those states are already excluded by domain policy.
   */
  readonly worktreeGcKeep?: () => ReadonlySet<string>;
}

/** Optional deps for re-verify (G6) — worktree + verifier without an agent. */
export interface ReverifyDeps {
  readonly workspaces: {
    create(
      repo: RepoConfig,
      taskId: string,
      opts?: {
        readonly hadPriorWork?: boolean;
        readonly seedFromSha?: string;
        readonly expectedBaseRevision?: string;
        readonly expectedRemoteTip?: string | null;
        readonly expectedBaseTip?: string;
      },
    ): Promise<Workspace>;
    preserve(
      taskId: string,
      message: string,
    ): Promise<import('../isolation/worktree.js').PreserveResult | void>;
    /** Remove only the disposable re-verify allocation; never moves a remote ref. */
    remove?(taskId: string): Promise<void>;
    /** Resolve one immutable preserved candidate and its base-to-tip file set. */
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
    /** Verified-SHA invariant probe (approve gate). Optional in fake mode. */
    preservedTipStatus?(
      repoKey: string,
      taskId: string,
      verifiedSha: string,
    ): Promise<{ ok: boolean; tip: string | null; reason: string }>;
    /** Trusted WORKFLOW read (merge L1 gates). Optional. */
    readWorkflow?(
      repo: RepoConfig,
      opts?: { readonly maxStaleMs?: number },
    ): Promise<string | null>;
    readTrustedDefaultRevisionSnapshot?(
      repo: RepoConfig,
    ): Promise<import('../isolation/worktree.js').TrustedDefaultRevisionSnapshot | null>;
    /**
     * Disposable main worktree for human batch Merge (design §3).
     * Required for {@link ActionService.mergeRepo}.
     */
    openMergeWorktree?(
      repo: RepoConfig,
    ): Promise<import('../isolation/worktree.js').MergeWorktreeHandle>;
    /**
     * Explicit clean-salvage: read-only source tip + target branch absence.
     * Must not create branches (audit-before-mutation).
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
    /** Verify-from-ref (C3.43): origin branch name or full SHA → exact commit on origin. */
    resolveOriginRef?(repo: RepoConfig, ref: string): Promise<string>;
  };
  readonly verifier: Verifier;
  /** Optional gate runner override (tests). */
  readonly commandRunner?: import('../verification/gates.js').CommandRunner;
  /** Same authoritative writer/path store used by autonomous dispatch. */
  readonly pathLeaseStore?: TaskPathLeaseStore;
  /** Durable redacted merge-gate failure receipts (optional). */
  readonly mergeReceiptStore?: import('../isolation/mergeFailureReceiptStore.js').MergeFailureReceiptStore;
}

export class ActionService {
  constructor(
    private readonly control: ControlPort,
    private readonly probe: RepoProbe,
    /** Optional injected `gh` runner (tests). Defaults to real CLI. */
    private readonly gh?: GhRunner,
    private readonly cleanupDeps?: TaskCleanupDeps,
    private readonly reverifyDeps?: ReverifyDeps,
    private readonly readinessDeps?: ReadinessDeps,
    /**
     * Production promote / rollback (design §3). Optional so pure action
     * tests stay free of deploy wiring; production wires PromoteService.
     */
    private readonly promoteService?: PromoteService,
    /**
     * Releases panel list + deploy-staging-now (design §3/§6). Optional —
     * without it GET /api/releases returns [] and deploy-now is unavailable.
     */
    private readonly releasePanelDeps?: ReleasePanelDeps,
    private readonly mergeOperationService?: MergeOperationService,
  ) {}

  /**
   * Per-repo memo of git-derived release facts (immutable per key: they are
   * pure functions of the production..staging range and the merged-SHA set).
   * Keeps /api/releases from re-spawning git per ahead task on every open.
   */
  private readonly releaseGitFactsCache = new Map<
    string,
    {
      key: string;
      rangeRisk: ReturnType<typeof aggregateRangeRisk> | null;
      rangeShas?: ReadonlySet<string>;
      liveRangeShas?: ReadonlySet<string>;
      rangeCommits?: readonly { sha: string; subject: string }[];
      taskGitFacts: Map<string, AheadTaskGitFacts>;
      /** Proven gate-merged ancestry coverage for production..staging commits. */
      gateCoveredShas?: ReadonlySet<string>;
    }
  >();

  /**
   * CLI evidence is expensive and may boot a real app. Cache only that execution
   * result; the surrounding readiness receipt (lease/build/path facts) is always
   * rebuilt. Promise values also collapse concurrent tick + UI checks.
   */
  private readonly readinessCliCache = new Map<
    string,
    Promise<WorkflowCliEvidenceStatus>
  >();
  private static readonly READINESS_CLI_CACHE_MAX = 64;

  /**
   * Per-repo async readiness job + last completed result (process memory only).
   * One entry per key; concurrent POSTs attach to the running job.
   */
  private readonly readinessJobs = new Map<
    string,
    {
      status: 'running' | 'done' | 'error';
      startedAt: string;
      finishedAt: string | null;
      result: RepoReadinessReport | null;
      error: string | null;
    }
  >();

  /**
   * Soft readiness checklist against the trusted default branch (V5).
   * Does not mutate repos.yaml — human still decides via Mark ready / force.
   * Guardian-grade repos also get a hard B-022 receipt (forceReady cannot bypass).
   */
  async checkRepoReadiness(
    key: string,
    opts: { readonly retryCliEvidence?: boolean } = {},
  ): Promise<RepoReadinessReport> {
    if (!isValidIdentifier(key)) throw new ActionError(`unsafe repo key '${key}'`);
    const snapshot = await this.control.read();
    const repo = snapshot.repos.repos[key];
    if (!repo) throw new ActionError(`unknown repo '${key}'`);

    return this.checkRepoConfigReadiness(repo, opts);
  }

  /**
   * Start (or attach to) a background readiness check for a repo.
   * Returns immediately; poll {@link getRepoReadinessJob} for status/result.
   */
  async startRepoReadinessCheck(
    key: string,
    opts: { readonly retryCliEvidence?: boolean } = {},
  ): Promise<RepoReadinessJobStart> {
    if (!isValidIdentifier(key)) throw new ActionError(`unsafe repo key '${key}'`);
    const snapshot = await this.control.read();
    if (!snapshot.repos.repos[key]) throw new ActionError(`unknown repo '${key}'`);

    // Drop jobs for keys no longer in repos.yaml (defence if remove missed one).
    const known = new Set(Object.keys(snapshot.repos.repos));
    for (const jobKey of this.readinessJobs.keys()) {
      if (!known.has(jobKey)) this.readinessJobs.delete(jobKey);
    }

    const existing = this.readinessJobs.get(key);
    if (existing?.status === 'running') {
      return { key, status: 'running', startedAt: existing.startedAt };
    }

    const startedAt = new Date().toISOString();
    this.readinessJobs.set(key, {
      status: 'running',
      startedAt,
      finishedAt: existing?.finishedAt ?? null,
      result: existing?.result ?? null,
      error: null,
    });

    void this.checkRepoReadiness(key, opts)
      .then((result) => {
        const cur = this.readinessJobs.get(key);
        if (!cur || cur.startedAt !== startedAt) return;
        this.readinessJobs.set(key, {
          status: 'done',
          startedAt,
          finishedAt: new Date().toISOString(),
          result,
          error: null,
        });
      })
      .catch((err: unknown) => {
        const cur = this.readinessJobs.get(key);
        if (!cur || cur.startedAt !== startedAt) return;
        this.readinessJobs.set(key, {
          status: 'error',
          startedAt,
          finishedAt: new Date().toISOString(),
          result: cur.result,
          error: capReadinessJobError(err),
        });
      });

    return { key, status: 'running', startedAt };
  }

  /**
   * Poll readiness job state. `result` is the last completed checklist for
   * this repo (may predate the current run). Never blocks on the check.
   */
  async getRepoReadinessJob(key: string): Promise<RepoReadinessJobState> {
    if (!isValidIdentifier(key)) throw new ActionError(`unsafe repo key '${key}'`);
    const snapshot = await this.control.read();
    if (!snapshot.repos.repos[key]) throw new ActionError(`unknown repo '${key}'`);

    const entry = this.readinessJobs.get(key);
    if (!entry) {
      return { key, status: 'idle' };
    }
    const out: {
      key: string;
      status: RepoReadinessJobStatus;
      startedAt?: string;
      finishedAt?: string;
      result?: RepoReadinessReport;
      error?: string;
    } = { key, status: entry.status };
    out.startedAt = entry.startedAt;
    if (entry.finishedAt !== null) out.finishedAt = entry.finishedAt;
    if (entry.result !== null) out.result = entry.result;
    if (entry.error !== null) out.error = entry.error;
    return out;
  }

  /**
   * Evaluate a projected config, not the persisted snapshot. This is the
   * registration/edit/restart chokepoint and closes old-config TOCTOU bypasses.
   */
  async checkRepoConfigReadiness(
    repo: RepoConfig,
    opts: { readonly retryCliEvidence?: boolean } = {},
  ): Promise<RepoReadinessReport> {

    if (!this.readinessDeps) {
      const soft = evaluateReadinessAssist({
        workflowPath: repo.workflow,
        workflowContent: null,
        agentsContent: null,
        agentsPath: null,
        workflowParseError: 'No mirror probe wired — run onboarding or force-ready',
      });
      return this.withGuardianReceipt(repo, soft, 'unknown', {
        defaultRevision: null,
        workflowSha256: null,
        policySha256: policyDigest(repo),
      });
    }

    const ws = this.readinessDeps.workspaces;
    const trustedSnapshot = ws.readTrustedDefaultRevisionSnapshot
      ? await ws.readTrustedDefaultRevisionSnapshot(repo)
      : null;
    const workflowContent = trustedSnapshot
      ? trustedSnapshot.workflowContent
      : await ws.readWorkflow(repo);
    let agentsContent: string | null = null;
    let agentsPath: string | null = null;
    for (const candidate of ['AGENTS.md', 'CLAUDE.md'] as const) {
      const content = ws.readTrustedFile
        ? await ws.readTrustedFile(repo, candidate)
        : null;
      if (content !== null && content.trim().length > 0) {
        agentsContent = content;
        agentsPath = candidate;
        break;
      }
    }

    let workflowParseError: string | null = null;
    let workflowFacts:
      | {
          readonly gateNames: readonly string[];
          readonly hasInstall: boolean;
          readonly hasBoot: boolean;
          readonly hasHealthCheck: boolean;
          readonly hasBehavioral?: boolean;
          readonly hasCliEvidence?: boolean;
        }
      | null
      | undefined;
    let workflowCliEvidence: WorkflowCliEvidenceStatus = 'unknown';
    let cliPlan: CliEvidencePlan | null = null;
    let cliBuildGate: Gate | undefined;
    if (workflowContent && workflowContent.trim().length > 0) {
      try {
        const wf = parseWorkflow(workflowContent);
        workflowFacts = {
          gateNames: wf.gates
            .map((g) => g.name)
            .filter((n) => n.trim().length > 0),
          hasInstall: wf.setup.install.length > 0,
          hasBoot: wf.setup.boot.length > 0,
          hasHealthCheck:
            typeof wf.healthCheck === 'string' && wf.healthCheck.trim().length > 0,
          hasBehavioral: wf.behavioral !== undefined,
          hasCliEvidence: wf.cliEvidence !== undefined,
        };
        cliPlan = wf.cliEvidence ?? null;
        cliBuildGate = wf.gates.find((gate) => gate.name === 'build');
        workflowCliEvidence = cliPlan ? 'unverified' : 'absent';
      } catch (err) {
        workflowParseError =
          err instanceof WorkflowError ? err.message : (err as Error).message;
        workflowFacts = null;
        workflowCliEvidence =
          err instanceof WorkflowError && err.message.includes('cli_evidence')
            ? 'invalid'
            : 'unknown';
      }
    } else if (trustedSnapshot !== null) {
      // Trusted default revision reachable: missing/empty WORKFLOW is known absence.
      workflowCliEvidence = 'absent';
    }

    const soft = evaluateReadinessAssist({
      workflowPath: repo.workflow,
      workflowContent,
      agentsContent,
      agentsPath,
      ...(workflowFacts !== undefined ? { workflowFacts } : {}),
      workflowParseError,
    });
    const provenance = {
      defaultRevision: trustedSnapshot?.revision ?? null,
      workflowSha256: workflowContent === null ? null : sha256(workflowContent),
      policySha256: policyDigest(repo),
    };
    if (cliPlan && trustedSnapshot && this.readinessDeps.verifyCliEvidence) {
      const planSha256 = sha256(JSON.stringify(cliPlan));
      const cacheKey = JSON.stringify({
        repoKey: repo.key,
        repoUrl: repo.url,
        defaultBranch: repo.defaultBranch,
        defaultRevision: trustedSnapshot.revision,
        workflowSha256: provenance.workflowSha256,
        planSha256,
        buildCommandSha256: cliBuildGate ? sha256(cliBuildGate.command) : null,
        policySha256: provenance.policySha256,
      });
      if (opts.retryCliEvidence) this.readinessCliCache.delete(cacheKey);
      let execution = this.readinessCliCache.get(cacheKey);
      if (execution) {
        // Refresh insertion order for strict LRU eviction.
        this.readinessCliCache.delete(cacheKey);
        this.readinessCliCache.set(cacheKey, execution);
      } else {
        execution = this.readinessDeps.verifyCliEvidence({
          repo,
          revision: trustedSnapshot.revision,
          plan: cliPlan,
          buildGate: cliBuildGate,
        }).catch((err: unknown) => {
          if (isVerificationAborted(err)) {
            this.readinessCliCache.delete(cacheKey);
            throw err;
          }
          return 'unknown' as const;
        });
        this.readinessCliCache.set(cacheKey, execution);
        while (this.readinessCliCache.size > ActionService.READINESS_CLI_CACHE_MAX) {
          const oldest = this.readinessCliCache.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.readinessCliCache.delete(oldest);
        }
      }
      workflowCliEvidence = await execution;
    }
    return this.withGuardianReceipt(repo, soft, workflowCliEvidence, provenance);
  }

  /** Attach Guardian B-022 hard-gate receipt to a soft checklist result. */
  private withGuardianReceipt(
    repo: RepoConfig,
    soft: ReadinessAssistResult,
    workflowCliEvidence: WorkflowCliEvidenceStatus,
    provenance: import('../domain/guardianReadiness.js').GuardianReadinessProvenance,
  ): RepoReadinessReport {

    const policy = effectiveRepoExecutionPolicy(repo.executionPolicy ?? null);
    const defaultAdapter = this.readinessDeps?.defaultAdapter ?? 'grok';
    const adapterKind = resolveAdapterKind(repo.adapter, defaultAdapter);
    const caps = this.readinessDeps?.capabilities ?? UNVERIFIED_B022_CAPABILITIES;
    const leaseStatus: DaemonLeaseReadinessStatus =
      this.readinessDeps?.daemonLeaseStatus?.() ?? 'unknown';
    const guardian = evaluateGuardianReadiness({
      policy,
      adapterKind,
      maxConcurrent: repo.maxConcurrent,
      daemonLease: { status: leaseStatus },
      capabilities: caps,
      workflowCliEvidence,
      provenance,
    });
    const softOk = soft.ok;
    const ok = softOk && guardian.ok;
    const summary =
      guardian.applicable && !guardian.ok
        ? guardian.summary + (softOk ? '' : '; also soft: ' + soft.summary)
        : soft.summary +
          (guardian.applicable ? ' | ' + guardian.summary : '');
    return {
      ...soft,
      ok,
      softOk,
      summary,
      guardian,
    };
  }

  /** Fail closed when a ready repo would violate Guardian B-022. */
  private async assertGuardianReadyAllowed(
    repo: RepoConfig,
  ): Promise<RepoReadinessReport | null> {

    const policy = effectiveRepoExecutionPolicy(repo.executionPolicy ?? null);
    if (policy.profile !== 'guardian') return null;
    const check = await this.checkRepoConfigReadiness(repo);
    if (!check.guardian.ok) {
      throw new ActionError(
        formatGuardianReadinessFailure(check.guardian) +
          ' (repo ' + repo.key + '; ready config rejected)',
      );
    }
    return check;
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const title = input.title.trim();
    if (title.length === 0) throw new ActionError('title is required');
    if (input.slug !== undefined && !isValidTaskSlug(input.slug)) {
      throw new ActionError(
        `invalid task slug '${input.slug}' (want lowercase words joined by '-', ≤ ${TASK_SLUG_MAX} chars)`,
      );
    }

    const snapshot = await this.control.read();
    const repoCfg = snapshot.repos.repos[input.repo];
    if (!repoCfg) {
      throw new ActionError(`unknown repo '${input.repo}'`);
    }
    const existing = new Set(snapshot.tasks.map((t) => t.id));

    let id: string;
    if (input.id !== undefined) {
      if (!isValidIdentifier(input.id)) throw new ActionError(`unsafe task id '${input.id}'`);
      if (existing.has(input.id)) throw new ActionError(`task '${input.id}' already exists`);
      id = input.id;
    } else {
      id = generatedTaskId(title, input.slug, existing);
    }

    // SPEC §9.4 server-side plan-first: a task with no checkable acceptance
    // criteria is held planPending regardless of which client created it (the
    // create-form vagueness heuristic is advisory; API callers bypass it).
    // Explicit planPending:false is a deliberate operator override.
    const body = input.body ?? '';
    const createdAt = new Date().toISOString();

    // Fail-fast: body names a protected path → reject unless operator force.
    // Prefer zero FP (explicit mentions only); L5 still catches real edits.
    const protectedPaths = await this.loadProtectedPaths(repoCfg);
    const protectedMentions = findProtectedPathMentions(body, protectedPaths);
    if (protectedMentions.length > 0 && input.force !== true) {
      throw new ActionError(formatProtectedPathBlockMessage(protectedMentions), {
        code: 'protected_path',
        paths: protectedMentions,
        rule: PROTECTED_PATH_CREATE_RULE,
      });
    }

    const autoPlanGate =
      input.planPending === undefined && !hasCheckableCriteria(body);
    const planPending = input.planPending === true || autoPlanGate;
    const labels = [...(input.labels ?? [])];
    if (planPending && !labels.some((l) => l.toLowerCase() === 'needs-plan')) {
      labels.push('needs-plan');
    }
    let finalBody = body;
    if (protectedMentions.length > 0 && input.force === true) {
      if (!labels.some((l) => l.toLowerCase() === FORCE_PROTECTED_PATH_LABEL)) {
        labels.push(FORCE_PROTECTED_PATH_LABEL);
      }
      finalBody = stampForceProtectedPath(finalBody, protectedMentions, createdAt);
    }
    const gateNote = autoPlanGate
      ? '\n\n## Plan gate (auto)\n' +
        'No checkable acceptance criteria found (SPEC §9.4) — held for human ' +
        'sign-off before any agent runs. Add an `## Acceptance criteria` ' +
        'section (typed bullets: `(mechanical)` / `(reviewer)` / `(human)`) ' +
        'and then **Approve plan**, or Approve plan as-is to dispatch without ' +
        'a machine-checkable DoD.\n'
      : '';

    const executionClass = resolveCreateExecutionClass(input.executionClass);
    const requestedAdapter = parseAdapterField(input.adapter, true);
    const dependencyMode =
      input.dependencyMode === 'gate_merge' || input.dependencyMode === 'completion_only'
        ? input.dependencyMode
        : null;

    // Path-lease declarations (optional on create; Guardian enforces at dispatch).
    let plannedBaseRevision: string | undefined;
    if (input.plannedBaseRevision !== undefined) {
      const base = input.plannedBaseRevision.trim().toLowerCase();
      if (!isFullCommitSha(base)) {
        throw new ActionError('plannedBaseRevision must be a full 40-char commit SHA');
      }
      plannedBaseRevision = base;
    }
    let affectedPaths: readonly string[] | undefined;
    if (input.affectedPaths !== undefined) {
      const norm = normalizeAffectedPaths(input.affectedPaths);
      if (!norm.ok) throw new ActionError(`invalid affectedPaths: ${norm.reason}`);
      affectedPaths = norm.scopes.map((s) => (s.kind === 'subtree' ? `${s.path}/` : s.path));
    }
    let protectedPathsSnapshot: readonly string[] | undefined;
    if (input.protectedPathsSnapshot !== undefined) {
      const normalized = normalizeProtectedPathsSnapshot(input.protectedPathsSnapshot);
      if (!normalized.ok) {
        throw new ActionError(`invalid protectedPathsSnapshot: ${normalized.reason}`);
      }
      protectedPathsSnapshot = normalized.paths;
    }
    const pathLeaseDeclarationCount = [
      plannedBaseRevision,
      affectedPaths,
      protectedPathsSnapshot,
    ].filter((value) => value !== undefined).length;
    if (pathLeaseDeclarationCount !== 0 && pathLeaseDeclarationCount !== 3) {
      throw new ActionError(
        'plannedBaseRevision, affectedPaths, and protectedPathsSnapshot must all be set or all be absent',
      );
    }

    // Existing remote candidates must arrive as one atomic ownership record.
    // Otherwise the scheduler can observe a task before its exact branch lease
    // or reviewed path scope is durable and provision from the default branch.
    const hasExpectedBase = input.expectedBaseRevision !== undefined;
    const hasExpectedRemoteTip = input.expectedRemoteTip !== undefined;
    if (hasExpectedBase !== hasExpectedRemoteTip) {
      throw new ActionError(
        'expectedBaseRevision and expectedRemoteTip must both be set or both be absent',
      );
    }
    let expectedBaseRevision: string | undefined;
    let expectedRemoteTip: string | undefined;
    if (hasExpectedBase && hasExpectedRemoteTip) {
      if (
        typeof input.expectedBaseRevision !== 'string' ||
        !isFullCommitSha(input.expectedBaseRevision)
      ) {
        throw new ActionError('expectedBaseRevision must be a full 40-char commit SHA');
      }
      if (
        typeof input.expectedRemoteTip !== 'string' ||
        !isFullCommitSha(input.expectedRemoteTip)
      ) {
        throw new ActionError('expectedRemoteTip must be a full 40-char commit SHA');
      }
      if (pathLeaseDeclarationCount !== 3) {
        throw new ActionError(
          'exact candidate create requires plannedBaseRevision, affectedPaths, and protectedPathsSnapshot',
        );
      }
      expectedBaseRevision = input.expectedBaseRevision.trim().toLowerCase();
      expectedRemoteTip = input.expectedRemoteTip.trim().toLowerCase();
      if (expectedBaseRevision !== plannedBaseRevision) {
        throw new ActionError(
          'expectedBaseRevision must match plannedBaseRevision for exact candidate create',
        );
      }
    }

    // Verify-from-ref (C3.43): seed the task branch from an existing origin
    // commit and let a read-only agent + the full verifier judge it. The ref
    // is resolved on origin BEFORE any control write (audit-before-mutation).
    let seedFromSha: string | undefined;
    if (input.seedFromRef !== undefined) {
      if (typeof input.seedFromRef !== 'string' || input.seedFromRef.trim().length === 0) {
        throw new ActionError('seedFromRef must be an origin branch name or a full commit SHA');
      }
      if (executionClass !== 'verify') {
        throw new ActionError(
          "seedFromRef requires execution_class 'verify' (the agent must not write; the verifier judges the seeded tip)",
        );
      }
      if (hasExpectedBase || hasExpectedRemoteTip) {
        throw new ActionError('seedFromRef cannot be combined with an exact candidate lease');
      }
      if ((input.blockedBy ?? []).length > 0) {
        // A same-repo dependency forces gate_merge, and a gated task must start
        // exactly at the main tip — a seeded branch can never satisfy that
        // (worktree "cannot seed … must start exactly at main tip"), so it
        // would burn attempts per tick instead of failing here.
        throw new ActionError('seedFromRef cannot be combined with blockedBy');
      }
      const ws = this.reverifyDeps?.workspaces;
      if (!ws?.resolveOriginRef) {
        throw new ActionError('verify-from-ref requires workspace ref resolve (not available)');
      }
      try {
        seedFromSha = (await ws.resolveOriginRef(repoCfg, input.seedFromRef)).toLowerCase();
      } catch (err) {
        throw new ActionError(err instanceof Error ? err.message : String(err));
      }
      if (!isFullCommitSha(seedFromSha)) {
        throw new ActionError(`seed ref '${input.seedFromRef}' did not resolve to a full commit SHA`);
      }
    }

    const task: Task = {
      id,
      title,
      repo: input.repo,
      state: 'todo',
      priority: input.priority ?? 100,
      blockedBy: input.blockedBy ?? [],
      dependencyMode,
      labels,
      // Host/deploy runs use the deterministic host executor (not an LLM).
      // Still pin adapter metadata for UI consistency; dispatch ignores it.
      adapter: isHostMutatingClass(executionClass) ? 'grok' : requestedAdapter,
      agentSession: null,
      pendingSteer: null,
      attempts: 0,
      lastEventAt: null,
      createdAt,
      startedAt: null,
      endedAt: null,
      prUrl: null,
      prStatus: null,
      planPending,
      ...(planPending ? { planPendingReason: PLAN_PENDING_REASON } : {}),
      executionClass,
      hostCommandScope: null,
      hostApprovedAt: null,
      hostExecutionStartedAt: null,
      ...(seedFromSha !== undefined ? { seedFromSha } : {}),
      ...(expectedBaseRevision !== undefined ? { expectedBaseRevision } : {}),
      ...(expectedRemoteTip !== undefined ? { expectedRemoteTip } : {}),
      ...(plannedBaseRevision !== undefined ? { plannedBaseRevision } : {}),
      ...(affectedPaths !== undefined ? { affectedPaths } : {}),
      ...(protectedPathsSnapshot !== undefined ? { protectedPathsSnapshot } : {}),
      body: `${finalBody}${gateNote}`,
    };

    if (!this.control.createTaskCommitted) {
      throw new Error('atomic task creation is unavailable on this control port');
    }
    const result = await this.control.createTaskCommitted(
      task,
      protectedMentions.length > 0 && input.force === true
        ? `hercules: create ${id} (force protected-path)`
        : `hercules: create ${id}`,
    );
    if (!result.committed) {
      throw new Error(`task '${id}' create commit was not durable`);
    }
    return task;
  }

  /**
   * Trusted-mirror WORKFLOW `protected_paths` for a repo, or [] when the
   * mirror is unavailable / unreadable (fail-open; L5 still enforces).
   */
  private async loadProtectedPaths(
    repo: RepoConfig,
  ): Promise<readonly string[]> {
    const ws =
      this.readinessDeps?.workspaces ??
      this.reverifyDeps?.workspaces ??
      this.releasePanelDeps?.workspaces;
    if (!ws?.readWorkflow) return [];
    try {
      // Protected-path lint tolerates a WORKFLOW tip ≤60s stale: this is an
      // early, advisory refusal. The authoritative checks come later — dispatch
      // refreshes the mirror again, verification scans the actual diff against
      // the WORKFLOW it reads then, and merge compares protected-path snapshots
      // for tasks that declare affected paths.
      const content = await ws.readWorkflow(repo, { maxStaleMs: 60_000 });
      if (!content || content.trim().length === 0) return [];
      return parseWorkflow(content).protectedPaths;
    } catch {
      return [];
    }
  }

  /**
   * Human authorizes a host_operation / deploy task with a bounded named
   * command scope. Until this record exists, scheduling skips the task.
   * Idempotent when the same scope is re-approved (safe multi-tap).
   */
  async approveHostOperation(
    id: string,
    input: ApproveHostOperationInput,
  ): Promise<Task> {
    if (!isValidIdentifier(id)) throw new ActionError(`unsafe task id '${id}'`);
    const snapshot = await this.control.read();
    const task = snapshot.tasks.find((t) => t.id === id);
    if (!task) throw new ActionError(`unknown task '${id}'`);

    const klass = resolveExecutionClass(task);
    if (!isHostMutatingClass(klass)) {
      throw new ActionError(
        `task '${id}' execution_class is '${klass}' — host approval only applies to host_operation / deploy`,
      );
    }
    if (task.state !== 'todo' && task.state !== 'failed' && task.state !== 'retrying') {
      throw new ActionError(
        `task '${id}' host operation can only be approved from todo/retrying/failed`,
      );
    }

    const validated = validateHostCommandScope(input.commandScope);
    if (!validated.ok) {
      throw new ActionError(`invalid command scope: ${validated.reason}`);
    }

    // Idempotent multi-tap while already queued. A failed/retrying operation
    // must receive a fresh approval stamp even when the command text is the
    // same, otherwise an ambiguous host mutation could be replayed silently.
    const existingScope = task.hostCommandScope ?? [];
    const sameScope =
      existingScope.length === validated.scope.length &&
      existingScope.every((c, i) => c === validated.scope[i]);
    if (task.state === 'todo' && task.hostApprovedAt && sameScope) {
      return task;
    }

    const approvedAt = new Date().toISOString();
    const next: Task = {
      ...task,
      state: 'todo',
      hostCommandScope: validated.scope,
      hostApprovedAt: approvedAt,
      // Fresh approval clears any prior execution-start marker so a human can
      // authorize another deterministic run after replay-block / failure.
      hostExecutionStartedAt: null,
      lastEventAt: approvedAt,
      body: stampHostOperationApproval(task.body, {
        commandScope: validated.scope,
        approvedAt,
      }),
    };
    await mutateControl(this.control, { writeTasks: [{ expected: task, next }] }, `hercules: approve host operation ${id}`);
    return next;
  }

  /**
   * Human signs off on a plan draft so the task becomes dispatchable (G5).
   * Clears `planPending` and drops the `needs-plan` label.
   * Idempotent: already-approved tasks return as-is (safe multi-tap on phone).
   */
  async approvePlan(id: string): Promise<Task> {
    if (!isValidIdentifier(id)) throw new ActionError(`unsafe task id '${id}'`);
    const snapshot = await this.control.read();
    const task = snapshot.tasks.find((t) => t.id === id);
    if (!task) throw new ActionError(`unknown task '${id}'`);
    // Already signed off — multi-tap / SSE lag must not error or re-open the panel.
    if (!task.planPending) {
      if (task.state === 'todo' || task.state === 'in_progress' || task.state === 'retrying') {
        return task;
      }
      throw new ActionError(`task '${id}' is not awaiting plan approval`);
    }
    if (task.state !== 'todo' && task.state !== 'failed') {
      throw new ActionError(`task '${id}' plan can only be approved from todo/failed`);
    }
    const labels = task.labels.filter((l) => l.toLowerCase() !== 'needs-plan');
    const stamp = new Date().toISOString();
    const next: Task = {
      ...task,
      planPending: false,
      labels,
      state: 'todo',
      lastEventAt: stamp,
    };
    await mutateControl(this.control, { writeTasks: [{ expected: task, next }] }, `hercules: approve plan ${id}`);
    return next;
  }

  private async persistTaskBranchLease(
    selected: Task,
    lease: TaskBranchLease,
    message: string,
  ): Promise<Task> {
    const fresh = (await this.control.read()).tasks.find((t) => t.id === selected.id);
    if (!fresh) throw new ActionError(`task '${selected.id}' disappeared during lease update`);
    if (fresh.state !== selected.state) {
      throw new ActionError(
        `task '${selected.id}' changed state during lease update ` +
          `(${selected.state} -> ${fresh.state})`,
      );
    }
    if (
      fresh.expectedBaseRevision === lease.expectedBaseRevision &&
      fresh.expectedRemoteTip === lease.expectedRemoteTip
    ) {
      return fresh;
    }
    const owned: Task = {
      ...fresh,
      expectedBaseRevision: lease.expectedBaseRevision,
      expectedRemoteTip: lease.expectedRemoteTip,
    };
    try {
      const { committed } = await mutateControl(this.control, { writeTasks: [{ expected: fresh, next: owned }] }, message);
      if (!committed) throw new ActionError(`lease commit returned committed:false`);
    } catch (err) {
      if (!this.control.mutateCommitted) await this.control.writeTask(fresh);
      const detail = err instanceof Error ? err.message : String(err);
      throw new ActionError(`lease update failed for '${selected.id}': ${detail}`);
    }
    return owned;
  }

  /**
   * Re-run verification only on the preserved branch (no implementer agent).
   * For review/failed tasks when WORKFLOW/gates/L2 policy changed (G6/P2).
   */
  async reverify(id: string): Promise<Task> {
    if (!isValidIdentifier(id)) throw new ActionError(`unsafe task id '${id}'`);
    if (!this.reverifyDeps) {
      throw new ActionError('re-verify is not configured on this daemon');
    }
    const snapshot = await this.control.read();
    let task = snapshot.tasks.find((t) => t.id === id);
    if (!task) throw new ActionError(`unknown task '${id}'`);
    if (task.state !== 'review' && task.state !== 'failed') {
      throw new ActionError(`re-verify only from review/failed (got ${task.state})`);
    }
    const repo = snapshot.repos.repos[task.repo];
    if (!repo) throw new ActionError(`unknown repo '${task.repo}'`);

    let pathLeaseRunToken: string | null = null;
    const pathLeaseStore = this.reverifyDeps.pathLeaseStore;
    let trustedBaseRevision = '';
    let trustedProtectedPaths: readonly string[] = [];
    const leasePolicy = pathLeasePolicyFor(
      effectiveRepoExecutionPolicy(repo.executionPolicy ?? null),
    );
    const hasPathDeclaration =
      task.plannedBaseRevision !== undefined ||
      task.affectedPaths !== undefined ||
      task.protectedPathsSnapshot !== undefined;
    if ((leasePolicy.requireDeclarations || hasPathDeclaration) && !pathLeaseStore) {
      throw new ActionError('re-verify refused: authoritative path-lease store unavailable');
    }
    if (pathLeaseStore && hasPathDeclaration) {
      const trusted =
        await this.reverifyDeps.workspaces.readTrustedDefaultRevisionSnapshot?.(repo);
      if (!trusted) {
        throw new ActionError('re-verify refused: trusted base/WORKFLOW snapshot unavailable');
      }
      trustedBaseRevision = trusted.revision;
      if (trusted.workflowContent === null) {
        const bootstrapOk = isFirstTimeWorkflowBootstrap({
          trustedRevision: trusted.revision,
          workflowContent: null,
          repoReadiness: repo.readiness,
          labels: task.labels,
          plannedBaseRevision: task.plannedBaseRevision,
          affectedPaths: task.affectedPaths,
          protectedPathsSnapshot: task.protectedPathsSnapshot,
          configuredWorkflowPath: repo.workflow,
        });
        if (!bootstrapOk) {
          throw new ActionError('re-verify refused: trusted base/WORKFLOW snapshot unavailable');
        }
        trustedProtectedPaths = [];
      } else {
        let workflow;
        try {
          workflow = parseWorkflow(trusted.workflowContent);
        } catch (err) {
          throw new ActionError(
            `re-verify refused: trusted WORKFLOW invalid: ${(err as Error).message}`,
          );
        }
        trustedProtectedPaths = workflow.protectedPaths;
      }
    }
    if (pathLeaseStore && (leasePolicy.requireDeclarations || hasPathDeclaration)) {
      const token = randomUUID();
      const acquired = await pathLeaseStore.acquire(repo.key, {
        taskId: task.id,
        runToken: token,
        declaredBaseRevision: task.plannedBaseRevision,
        declaredPaths: task.affectedPaths,
        declaredProtectedSnapshot: task.protectedPathsSnapshot,
        trustedBaseRevision,
        currentProtectedPaths: trustedProtectedPaths,
        maxWriters: effectivePathWriterLimit(repo.maxConcurrent, leasePolicy),
        requireDeclarations: leasePolicy.requireDeclarations,
        acquiredAtMs: Date.now(),
      });
      if (!acquired.ok) {
        throw new ActionError(
          `re-verify path lease blocked (${acquired.reason}): ${acquired.detail}`,
        );
      }
      if (acquired.entry.scopes.length > 0) pathLeaseRunToken = token;
    }

    try {
    // Re-verify targets prior work by definition — recovery heuristics allowed.
    // Clean-salvage targets also stamp seedFromSha so a reclaimed worktree can
    // reattach even when the branch tip is missing from ownership recovery.
    // Verify-from-ref tasks (C3.43) carry their own exact seed the same way.
    const salvageSha =
      typeof task.seedFromSha === 'string' && task.seedFromSha.length > 0
        ? task.seedFromSha
        : typeof task.salvageSourceSha === 'string' && task.salvageSourceSha.length > 0
          ? task.salvageSourceSha
          : undefined;
    let workspace;
    try {
      workspace = await this.reverifyDeps.workspaces.create(repo, task.id, {
        hadPriorWork: true,
        ...(salvageSha ? { seedFromSha: salvageSha } : {}),
        ...(trustedBaseRevision ? { expectedBaseTip: trustedBaseRevision } : {}),
        ...(task.expectedBaseRevision !== undefined
          ? { expectedBaseRevision: task.expectedBaseRevision }
          : {}),
        ...(task.expectedRemoteTip !== undefined
          ? { expectedRemoteTip: task.expectedRemoteTip }
          : {}),
      });
    } catch (err) {
      if (err instanceof WorkspaceError) {
        throw new ActionConflictError(`re-verify refused: ${err.message}`);
      }
      throw err;
    }
    if (
      task.expectedBaseRevision !== workspace.branchLease.expectedBaseRevision ||
      task.expectedRemoteTip !== workspace.branchLease.expectedRemoteTip
    ) {
      task = await this.persistTaskBranchLease(
        task,
        workspace.branchLease,
        `hercules: ${task.id} acquire exact task-branch lease for re-verify`,
      );
    }
    let result: Task | null = null;
    let scopeBlocked = false;
    let scopeCleanupError: ActionError | null = null;
    try {
      const packet = await this.reverifyDeps.verifier.verify(task, repo, workspace, {
        activityLog: ['(re-verify only — no implementer turn)'],
        finalReport:
          '## Re-verify\n\nSystem re-ran L1/L2/L3/L5 without a new implementer turn.\n\n' +
          '## Self-assessment\n- re-verify: system packet (no agent narrative)',
        runKind: 'implementer',
      });
      const rendered = renderPacketMarkdownWithNonce(packet);
      const body = withReviewPacket(task.body, rendered.markdown);
      const stamp = new Date().toISOString();
      scopeBlocked = packet.gates.some(
        (gate) => gate.name === 'path-lease-scope' && !gate.passed,
      );
      // Case study task-5: re-verify wrote auto-rework packet but left state=review
      // ("implementer will be re-queued") — task stuck forever. Legal path is
      // review → todo (same as reject/CONFLICTING requeue); next tick dispatches.
      if (scopeBlocked) {
        const note =
          `\n\n## Re-verify (${stamp})\n\n` +
          'Path-lease scope proof failed before any candidate commit or publication. ' +
          'The disposable checkout was removed; the exact preserved task ref was not moved.\n';
        const next: Task = {
          ...task,
          body: `${body.trim()}${note}`,
          endedAt: stamp,
          lastEventAt: stamp,
          packetNonce: rendered.nonce,
        };
        await mutateControl(
          this.control,
          { writeTasks: [{ expected: task, next }] },
          `hercules: re-verify ${id} path-lease scope blocked`,
        );
        result = next;
      } else if (packet.autoRework && task.state === 'review') {
        assertTransition(task.state, 'todo');
        const note =
          `\n\n## Re-verify (${stamp})\n\n` +
          'Automated proof failing — re-queued implementer (review → todo).\n';
        const next: Task = {
          ...task,
          state: 'todo',
          body: `${body.trim()}${note}`,
          endedAt: null,
          lastEventAt: stamp,
          packetNonce: rendered.nonce,
          // Keep session so the next run can resume if the adapter supports it.
        };
        await mutateControl(this.control, { writeTasks: [{ expected: task, next }] }, `hercules: re-verify ${id} → todo (auto-rework)`);
        console.error(`[hercules] re-verify ${id}: auto-rework → todo`);
        result = next;
      } else {
        const note =
          `\n\n## Re-verify (${stamp})\n\n` +
          (packet.autoRework
            ? 'Automated proof still failing — use Retry/Steer to rework.\n'
            : packet.green
              ? 'Automated proof complete after re-verify — human Approve still required if human ACs exist.\n'
              : 'Re-verify finished; see DoD axes.\n');
        const next: Task = {
          ...task,
          body: `${body.trim()}${note}`,
          endedAt: stamp,
          verifiedSha: packet.verifiedSha,
          packetNonce: rendered.nonce,
          verifiedPathLeaseDigest: pathLeaseDeclarationDigest(task),
        };
        await mutateControl(this.control, { writeTasks: [{ expected: task, next }] }, `hercules: re-verify ${id}`);
        result = next;
      }
    } finally {
      if (scopeBlocked) {
        if (!this.reverifyDeps.workspaces.remove) {
          scopeCleanupError = new ActionError('re-verify scope cleanup is not configured');
        } else {
          try {
            await this.reverifyDeps.workspaces.remove(id);
          } catch (err) {
            scopeCleanupError = new ActionError(
              `re-verify scope cleanup failed: ${(err as Error).message}`,
            );
          }
        }
      } else {
        const preserveResult = await this.reverifyDeps.workspaces.preserve(
          id,
          `hercules: re-verify ${id}`,
        );
        if (preserveResult?.branchLease) {
          const fresh = (await this.control.read()).tasks.find((t) => t.id === id);
          if (fresh) {
            const lease = preserveResult.branchLease;
            if (
              lease.expectedBaseRevision !== fresh.expectedBaseRevision ||
              lease.expectedRemoteTip !== fresh.expectedRemoteTip
            ) {
              const advanced = await this.persistTaskBranchLease(
                fresh,
                lease,
                `hercules: ${id} — advance exact task-branch lease`,
              );
              if (result !== null) result = advanced;
            }
          }
        }
      }
    }
    if (scopeCleanupError !== null) throw scopeCleanupError;
    if (result === null) {
      throw new ActionError(`re-verify '${id}' completed without a task result`);
    }
    return result;
    } finally {
      if (pathLeaseRunToken && pathLeaseStore) {
        await pathLeaseStore.release(repo.key, id, pathLeaseRunToken);
      }
    }
  }

  /**
   * Narrow owner repair for a stale path declaration. This is intentionally
   * not a generic task patch: the candidate and trusted policy are proved
   * before one exact full-task CAS changes only the complete lease declaration.
   */
  async amendPathLease(id: string, input: AmendPathLeaseInput): Promise<Task> {
    if (!isValidIdentifier(id)) throw new ActionError(`unsafe task id '${id}'`);
    if (!this.reverifyDeps?.workspaces.inspectPreservedCandidate) {
      throw new ActionError('path-lease amendment is not configured on this daemon');
    }
    if (!this.control.mutateCommitted) {
      throw new ActionError('path-lease amendment requires atomic control CAS support');
    }
    const snapshot = await this.control.read();
    const task = snapshot.tasks.find((candidate) => candidate.id === id);
    if (!task) throw new ActionError(`unknown task '${id}'`);
    if (task.state !== 'review' && task.state !== 'failed' && task.state !== 'cancelled') {
      throw new ActionError(`path-lease amendment requires an inactive review/failed/cancelled task`);
    }
    const expected = input.expected;
    if (
      task.state !== expected.state ||
      task.plannedBaseRevision !== expected.plannedBaseRevision ||
      task.expectedBaseRevision !== expected.expectedBaseRevision ||
      JSON.stringify(task.affectedPaths) !== JSON.stringify(expected.affectedPaths) ||
      JSON.stringify(task.protectedPathsSnapshot) !== JSON.stringify(expected.protectedPathsSnapshot) ||
      task.expectedRemoteTip !== expected.expectedRemoteTip ||
      (task.verifiedSha ?? null) !== expected.verifiedSha ||
      task.lastEventAt !== expected.lastEventAt
    ) {
      throw new ActionConflictError('stale expected task or path-lease declaration');
    }
    if (!isFullCommitSha(expected.expectedRemoteTip)) {
      throw new ActionError('expectedRemoteTip must be a full preserved candidate SHA');
    }

    const replacementBase = input.replacement.plannedBaseRevision.trim().toLowerCase();
    if (!isFullCommitSha(replacementBase)) {
      throw new ActionError('replacement plannedBaseRevision must be a full commit SHA');
    }
    if (
      !isFullCommitSha(task.plannedBaseRevision ?? '') ||
      !isFullCommitSha(task.expectedBaseRevision ?? '') ||
      task.plannedBaseRevision?.toLowerCase() !== task.expectedBaseRevision?.toLowerCase()
    ) {
      throw new ActionError(
        'task plannedBaseRevision and expectedBaseRevision must name the same exact old base',
      );
    }
    const affected = normalizeAffectedPaths(input.replacement.affectedPaths);
    if (!affected.ok) throw new ActionError(`invalid replacement affectedPaths: ${affected.reason}`);
    const replacementAffected = affected.scopes.map((scope) =>
      scope.kind === 'subtree' ? `${scope.path}/` : scope.path,
    );
    if (JSON.stringify(replacementAffected) !== JSON.stringify(input.replacement.affectedPaths)) {
      throw new ActionError('replacement affectedPaths must already be normalized and sorted');
    }
    const protectedPaths = normalizeProtectedPathsSnapshot(
      input.replacement.protectedPathsSnapshot,
    );
    if (!protectedPaths.ok) {
      throw new ActionError(`invalid replacement protectedPathsSnapshot: ${protectedPaths.reason}`);
    }
    if (
      JSON.stringify(protectedPaths.paths) !==
      JSON.stringify(input.replacement.protectedPathsSnapshot)
    ) {
      throw new ActionError('replacement protectedPathsSnapshot must already be normalized and sorted');
    }

    const repo = snapshot.repos.repos[task.repo];
    if (!repo) throw new ActionError(`unknown repo '${task.repo}'`);
    const exactOldBase = expected.plannedBaseRevision;
    const candidate = await this.reverifyDeps.workspaces.inspectPreservedCandidate(
      repo,
      task.id,
      expected.expectedRemoteTip,
      exactOldBase,
    );
    if (!isFullCommitSha(candidate.trustedDefaultRevision)) {
      throw new ActionError('trusted default ancestry proof is invalid');
    }
    if (candidate.trustedDefaultRevision.toLowerCase() !== replacementBase) {
      throw new ActionConflictError(
        'replacement plannedBaseRevision must equal the exact trusted default observed during proof',
      );
    }
    if (candidate.workflowContentAtTrustedDefault === null) {
      throw new ActionError('trusted WORKFLOW is unavailable for protected-path proof');
    }
    let workflow;
    try {
      workflow = parseWorkflow(candidate.workflowContentAtTrustedDefault);
    } catch (err) {
      throw new ActionError(`trusted WORKFLOW is invalid: ${(err as Error).message}`);
    }
    if (!protectedPathsSnapshotsEqual(protectedPaths.paths, workflow.protectedPaths)) {
      throw new ActionError('protected_paths_snapshot drifted from trusted policy');
    }
    if (candidate.tip.toLowerCase() !== expected.expectedRemoteTip.toLowerCase()) {
      throw new ActionError('preserved candidate moved during path-lease proof');
    }
    if (!validateDiffAgainstScopes(candidate.filesTouched, affected.scopes).ok) {
      throw new ActionError('preserved candidate diff is not contained in replacement affectedPaths');
    }

    const next: Task = {
      ...task,
      plannedBaseRevision: replacementBase,
      expectedBaseRevision: replacementBase,
      affectedPaths: replacementAffected,
      protectedPathsSnapshot: protectedPaths.paths,
    };
    const committed = await mutateControl(
      this.control,
      { writeTasks: [{ expected: task, next }] },
      `hercules: amend path lease ${id}`,
    );
    if (!committed.committed) {
      throw new ActionError(`path-lease amendment commit was not created`);
    }
    return next;
  }

  /**
   * Create a linear multi-agent pipeline (first-class multi-step beyond a
   * single hot-swap): stages become separate tasks linked by `blocked_by`.
   * Returns the created tasks in stage order.
   */
  async createPipeline(input: CreatePipelineInput): Promise<readonly Task[]> {
    const titleBase = input.title.trim();
    if (titleBase.length === 0) throw new ActionError('title is required');
    if (!input.stages || input.stages.length < 2) {
      throw new ActionError('pipeline needs at least 2 stages');
    }
    if (input.stages.length > 12) {
      throw new ActionError('pipeline supports at most 12 stages');
    }
    for (const [i, stage] of input.stages.entries()) {
      if (!stage.title.trim()) throw new ActionError(`stage ${i + 1}: title is required`);
    }

    const snapshot = await this.control.read();
    const repoCfg = snapshot.repos.repos[input.repo];
    if (!repoCfg) {
      throw new ActionError(`unknown repo '${input.repo}'`);
    }

    // Fail-fast across all stages before writing any task files.
    const protectedPaths = await this.loadProtectedPaths(repoCfg);
    if (protectedPaths.length > 0 && input.force !== true) {
      for (const [i, stage] of input.stages.entries()) {
        const mentions = findProtectedPathMentions(stage.body ?? '', protectedPaths);
        if (mentions.length > 0) {
          throw new ActionError(
            `stage ${i + 1}: ${formatProtectedPathBlockMessage(mentions)}`,
          );
        }
      }
    }

    const existing = new Set(snapshot.tasks.map((t) => t.id));
    const prefix = input.idPrefix?.trim()
      ? (() => {
          if (!isValidIdentifier(input.idPrefix!.trim())) {
            throw new ActionError(`unsafe id prefix '${input.idPrefix}'`);
          }
          return input.idPrefix!.trim();
        })()
      : uniqueId(slugify(titleBase), existing);

    const created: Task[] = [];
    let prevId: string | null = null;
    const stamp = new Date().toISOString();

    for (let i = 0; i < input.stages.length; i++) {
      const stage = input.stages[i]!;
      const stageNum = i + 1;
      let id = `${prefix}-${stageNum}`;
      if (existing.has(id) || created.some((t) => t.id === id)) {
        id = uniqueId(`${prefix}-${stageNum}`, new Set([...existing, ...created.map((t) => t.id)]));
      }
      if (!isValidIdentifier(id)) {
        throw new ActionError(`could not allocate safe id for stage ${stageNum}`);
      }

      const stageTitle = stage.title.trim();
      const title =
        input.stages.length > 1
          ? `[${stageNum}/${input.stages.length}] ${stageTitle}`
          : stageTitle;
      const bodyHeader =
        `## Pipeline\n\n` +
        `Stage **${stageNum}** of **${input.stages.length}** ` +
        `(\`${prefix}\`). ` +
        (prevId
          ? `Blocked by \`${prevId}\` until that stage is terminal.\n\n`
          : `First stage — eligible immediately.\n\n`);
      const stageMentions = findProtectedPathMentions(stage.body ?? '', protectedPaths);
      const stageLabels = [
        'pipeline',
        `pipeline:${prefix}`,
        `stage:${stageNum}`,
        ...(stage.labels ?? []),
        ...(!hasCheckableCriteria(stage.body ?? '') &&
        !(stage.labels ?? []).some((l) => l.toLowerCase() === 'needs-plan')
          ? ['needs-plan']
          : []),
      ];
      let stageBody = stage.body?.trim() ?? '';
      if (stageMentions.length > 0 && input.force === true) {
        if (!stageLabels.some((l) => l.toLowerCase() === FORCE_PROTECTED_PATH_LABEL)) {
          stageLabels.push(FORCE_PROTECTED_PATH_LABEL);
        }
        stageBody = stampForceProtectedPath(stageBody, stageMentions, stamp);
      }
      const task: Task = {
        id,
        title,
        repo: input.repo,
        state: 'todo',
        priority: input.priority ?? 100,
        blockedBy: prevId ? [prevId] : [],
        labels: stageLabels,
        adapter: parseAdapterField(stage.adapter, true),
        agentSession: null,
        pendingSteer: null,
        attempts: 0,
        lastEventAt: null,
        createdAt: stamp,
        startedAt: null,
        endedAt: null,
        prUrl: null,
        prStatus: null,
        // Same §9.4 rule as createTask — pipelines are not a bypass lane. A
        // criteria-less stage holds for human plan sign-off; later stages
        // stay blocked_by-chained behind it anyway.
        planPending: !hasCheckableCriteria(stage.body ?? ''),
        body: `${bodyHeader}${stageBody}`.trim() + '\n',
      };
      created.push(task);
      existing.add(id);
      prevId = id;
    }

    await mutateControl(this.control, { writeTasks: created.map((next) => ({ expected: null, next })) },
      `hercules: create pipeline ${prefix} (${created.length} stages)`,
    );
    return created;
  }

  /**
   * Human: push a queued task to the front of the dispatch queue by lowering
   * its priority below every other todo/retrying peer (cost-weight aware).
   * Idempotent when already strictly first. Only todo/retrying.
   */
  async moveToQueueFront(id: string): Promise<Task> {
    if (!isValidIdentifier(id)) throw new ActionError(`unsafe task id '${id}'`);
    const snapshot = await this.control.read();
    const task = snapshot.tasks.find((t) => t.id === id);
    if (!task) throw new ActionError(`unknown task '${id}'`);
    if (!isQueueState(task.state)) {
      throw new ActionError(
        `queue-front only for todo/retrying (got ${task.state})`,
      );
    }
    const { nextPriority, alreadyFront } = computeQueueFrontPriority(
      task,
      snapshot.tasks,
    );
    if (alreadyFront) return task;
    const next: Task = { ...task, priority: nextPriority };
    await mutateControl(
      this.control,
      { writeTasks: [{ expected: task, next }] },
      `hercules: ${id} queue-front priority ${task.priority} -> ${nextPriority} (human)`,
    );
    return next;
  }

  /**
   * Set or clear this task's agent override.
   *
   * Default (`switchNow: false`): does not stop a live run — the new choice
   * applies on the next dispatch (after cancel/retry/reject→todo).
   *
   * `switchNow: true` while `in_progress`: stop the live agent, clear its
   * session (new agent cannot resume the old one), re-queue as `retrying` so
   * the next tick dispatches with the new adapter on the same branch/worktree.
   * Pass `null` adapter to clear (fall back to repo/daemon default).
   */
  async setTaskAdapter(
    id: string,
    adapter: AdapterKind | null,
    opts?: { readonly switchNow?: boolean },
  ): Promise<Task> {
    if (!isValidIdentifier(id)) throw new ActionError(`unsafe task id '${id}'`);
    const snapshot = await this.control.read();
    const task = snapshot.tasks.find((t) => t.id === id);
    if (!task) throw new ActionError(`unknown task '${id}'`);
    const nextAdapter = parseAdapterField(adapter, true);
    if (isHostMutatingClass(resolveExecutionClass(task)) && nextAdapter !== 'grok') {
      throw new ActionError(
        `task '${id}' is '${resolveExecutionClass(task)}' and must stay pinned to grok for scoped host permissions`,
      );
    }
    const switchNow = opts?.switchNow === true;

    if (!switchNow) {
      if (task.adapter === nextAdapter) return task;
      const next: Task = {
        ...task,
        adapter: nextAdapter,
        // Resolution is finalized by the orchestrator (task → repo → daemon +
        // failover). A changed override cannot prove compatibility here.
        agentSession: null,
        agentSessionAdapter: null,
      };
      await mutateControl(this.control, { writeTasks: [{ expected: task, next }] },
        `hercules: ${id} adapter → ${nextAdapter ?? 'default'} (human)`,
      );
      return next;
    }

    // Switch now: always write adapter + re-queue when live.
    if (task.state === 'in_progress') {
      try {
        assertTransition(task.state, 'retrying');
      } catch (err) {
        if (err instanceof TransitionError) throw new ActionError(err.message);
        throw err;
      }
      const stamp = new Date().toISOString();
      const section =
        `## Agent switch (${stamp})\n\n` +
        `Human switched agent mid-run → \`${nextAdapter ?? 'default'}\`. ` +
        `Live process stopped; re-queued (session cleared).\n`;
      const next: Task = {
        ...task,
        adapter: nextAdapter,
        state: 'retrying',
        agentSession: null,
        agentSessionAdapter: null,
        // An undelivered steer is work, not session state.
        pendingSteer: task.pendingSteer,
        endedAt: stamp,
        body: `${task.body.trim()}\n\n${section}\n`,
      };
      await mutateControl(this.control, { writeTasks: [{ expected: task, next }] },
        `hercules: ${id} switch-now → ${nextAdapter ?? 'default'} (human)`,
      );
      return next;
    }

    // Not live: just store the override (same as soft set).
    if (task.adapter === nextAdapter) return task;
    const next: Task = {
      ...task,
      adapter: nextAdapter,
      agentSession: null,
      agentSessionAdapter: null,
    };
    await mutateControl(this.control, { writeTasks: [{ expected: task, next }] },
      `hercules: ${id} adapter → ${nextAdapter ?? 'default'} (human)`,
    );
    return next;
  }

  /** Authenticated human dependency-only batch mutation with exact old-set leases. */
  async rewireDependencies(input: RewireDependenciesInput): Promise<DependencyRewireReceipt> {
    if (!this.control.rewireDependenciesCommitted) {
      throw new ActionError('control port does not support atomic dependency rewiring');
    }
    const snapshot = await this.control.read();
    const validated = validateDependencyRewire(snapshot.tasks, input.changes);
    if (!validated.ok) throw new ActionError(validated.reason);
    const taskIds = validated.tasks.map((task) => task.id);
    const result = await this.control.rewireDependenciesCommitted(
      input.changes,
      `hercules: dependency rewire ${taskIds.join(', ')} (human)`,
    );
    if (!result.committed) throw new ActionError('dependency rewire was not committed');
    return { ...result, taskIds };
  }

  /**
   * Human batch Merge (design §3): merge ordered done/unmerged tasks into
   * main via temp worktree + single L1 re-run + non-force push. Machine only
   * executes this after an explicit phone/API Merge action.
   */
  async mergeRepo(
    repoKey: string,
    taskIds: readonly string[],
  ): Promise<MergeBatchResult> {
    if (!isValidIdentifier(repoKey)) {
      throw new ActionError(`unsafe repo key '${repoKey}'`);
    }
    const ws = this.reverifyDeps?.workspaces;
    if (!ws?.preservedTipStatus || !ws.openMergeWorktree || !ws.readWorkflow) {
      throw new ActionError(
        'merge not available: isolation workspaces missing merge hooks',
      );
    }
    const merge = new MergeService({
      control: this.control,
      workspaces: {
        preservedTipStatus: (rk, tid, sha) => ws.preservedTipStatus!(rk, tid, sha),
        readWorkflow: (repo) => ws.readWorkflow!(repo),
        openMergeWorktree: (repo) => ws.openMergeWorktree!(repo),
      },
      ...(this.reverifyDeps?.commandRunner
        ? { commandRunner: this.reverifyDeps.commandRunner }
        : {}),
      ...(this.reverifyDeps?.mergeReceiptStore
        ? { receiptStore: this.reverifyDeps.mergeReceiptStore }
        : {}),
    });
    try {
      return await merge.mergeBatch(repoKey, taskIds);
    } catch (err) {
      if (err instanceof MergeError) throw new ActionError(err.message);
      throw err;
    }
  }

  async getMergeOperation(operationId: string): Promise<MergeOperationReceipt | null> {
    if (!this.mergeOperationService) {
      throw new ActionError('merge operations are not configured on this daemon');
    }
    try {
      return await this.mergeOperationService.get(operationId);
    } catch (err) {
      if (err instanceof MergeOperationError) throw new ActionError(err.message);
      throw err;
    }
  }

  /**
   * Human Promote (design §3): staging ready + no drift → write promoting_sha
   * → production deploy → health+smoke → finalize, or automatic rollback to
   * known-good. Server-side preconditions only — UI disable is not enough.
   */
  async promote(repoKey: string): Promise<PromoteResult> {
    if (!this.promoteService) {
      throw new ActionError('promote is not configured on this daemon');
    }
    try {
      return await this.promoteService.promote(repoKey);
    } catch (err) {
      if (err instanceof PromoteServiceError) throw new ActionError(err.message);
      throw err;
    }
  }

  /**
   * Manual production rollback to the previous known-good sha (design §3).
   * Same rollback path as automatic post-promote failure recovery.
   */
  async rollbackProduction(repoKey: string): Promise<PromoteResult> {
    if (!this.promoteService) {
      throw new ActionError('rollback is not configured on this daemon');
    }
    try {
      return await this.promoteService.rollbackProduction(repoKey);
    } catch (err) {
      if (err instanceof PromoteServiceError) throw new ActionError(err.message);
      throw err;
    }
  }

  /**
   * Phone Releases panel state: one row per repo whose trusted WORKFLOW
   * declares `deploy.staging`. Pure assembly via {@link buildReleasePanelEntry}.
   * Range risk + per-task area/size come from the trusted mirror only.
   */
  async listReleases(): Promise<ReleasePanelEntry[]> {
    const snapshot = await this.control.read();
    const entries: ReleasePanelEntry[] = [];
    const repos = Object.values(snapshot.repos.repos).sort((a, b) =>
      a.key.localeCompare(b.key),
    );

    const panelWs = this.releasePanelDeps?.workspaces;
    const ws =
      panelWs ?? this.reverifyDeps?.workspaces ?? this.readinessDeps?.workspaces;
    if (!ws?.readWorkflow) return entries;

    // Keep the RECEIVER with the method — an extracted unbound call loses
    // `this` and the impl's own catch yields a silent null (2026-07-17).
    const headWs =
      panelWs?.defaultBranchHead !== undefined
        ? panelWs
        : (this.reverifyDeps?.workspaces as
            | { defaultBranchHead?: (r: RepoConfig) => Promise<string | null> }
            | undefined);
    const headFn =
      headWs?.defaultBranchHead !== undefined
        ? (r: RepoConfig) => headWs.defaultBranchHead!(r)
        : undefined;

    for (const repo of repos) {
      let workflowContent: string | null;
      try {
        // Read path: prefer the offline variant — readWorkflow fetches origin
        // per repo and made this endpoint take ~a minute (2026-07-17).
        const offline = (
          ws as { readWorkflowOffline?: (r: RepoConfig) => Promise<string | null> }
        ).readWorkflowOffline;
        workflowContent = offline ? await offline.call(ws, repo) : await ws.readWorkflow(repo);
      } catch {
        continue;
      }
      if (workflowContent === null || workflowContent.trim() === '') continue;

      let stagingUrl: string | null = null;
      let hasStaging = false;
      let hasProductionDeploy = false;
      let hasProjectStateClosure = false;
      let authTokenEnv: string | undefined;
      try {
        const wf = parseWorkflow(workflowContent);
        hasStaging = wf.deploy?.staging !== undefined;
        hasProductionDeploy = wf.deploy?.production !== undefined;
        hasProjectStateClosure = wf.projectStateClosure !== undefined;
        authTokenEnv = wf.deploy?.staging?.authTokenEnv;
        // Phone-reachable link: tunnel URL file / env override beats the
        // WORKFLOW url (often localhost, useless off-box).
        stagingUrl = resolveStagingPublicUrl({
          env: process.env,
          readFile: (path) => readFileSync(path, 'utf8'),
          workflowUrl: wf.deploy?.staging?.url ?? null,
        });
      } catch (err) {
        if (!(err instanceof WorkflowError)) throw err;
        continue;
      }
      if (!hasStaging) continue;

      const existing =
        this.control.readRelease !== undefined
          ? await this.control.readRelease(repo.key)
          : null;
      const release = existing ?? emptyRelease(repo.key);

      let mainSha: string | null = null;
      if (headFn) {
        try {
          mainSha = await headFn(repo);
        } catch {
          mainSha = null;
        }
      }

      // Staging tip for range: prefer recorded staging_sha, else main.
      const rangeStaging =
        release.stagingSha !== null && release.stagingSha !== ''
          ? release.stagingSha
          : mainSha;

      let rangeRisk = null as ReturnType<typeof aggregateRangeRisk> | null;
      let rangeShas: ReadonlySet<string> | undefined;
      let liveRangeShas: ReadonlySet<string> | undefined;
      let rangeCommits: readonly { sha: string; subject: string }[] | undefined;
      let taskGitFacts = new Map<string, AheadTaskGitFacts>();
      let gateCoveredShas: ReadonlySet<string> | undefined;

      // Git-derived facts are pure functions of (production..staging, merged
      // SHAs + gate provenance) — memoize per repo so reopening the panel
      // doesn't re-spawn git subprocesses per ahead/gate task.
      const mergedPairs = snapshot.tasks
        .filter(
          (t) =>
            t.repo === repo.key &&
            t.mergedSha !== undefined &&
            t.mergedSha !== null &&
            t.mergedSha !== '',
        )
        .map(
          (t) =>
            `${t.id}:${t.mergedSha}:${t.mergedVia ?? ''}:${t.verifiedSha ?? ''}`,
        )
        .sort()
        .join(',');
      const prev = previousProductionSha(release);
      const factsKey = `${release.productionSha ?? ''}..${rangeStaging ?? ''}|${mergedPairs}|live:${prev ?? ''}`;
      const cachedFacts = this.releaseGitFactsCache.get(repo.key);
      if (cachedFacts && cachedFacts.key === factsKey) {
        rangeRisk = cachedFacts.rangeRisk;
        rangeShas = cachedFacts.rangeShas;
        liveRangeShas = cachedFacts.liveRangeShas;
        rangeCommits = cachedFacts.rangeCommits;
        taskGitFacts = cachedFacts.taskGitFacts;
        gateCoveredShas = cachedFacts.gateCoveredShas;
      } else if (panelWs) {
        if (rangeStaging) {
          if (panelWs.rangeShas) {
            try {
              rangeShas = await panelWs.rangeShas(
                repo,
                release.productionSha,
                rangeStaging,
              );
            } catch {
              rangeShas = undefined;
            }
          }
          if (panelWs.rangeCommitList) {
            try {
              rangeCommits = await panelWs.rangeCommitList(
                repo,
                release.productionSha,
                rangeStaging,
              );
            } catch {
              rangeCommits = undefined;
            }
          }
          if (panelWs.rangeDiff) {
            try {
              const diff = await panelWs.rangeDiff(
                repo,
                release.productionSha,
                rangeStaging,
              );
              if (diff) {
                rangeRisk = aggregateRangeRisk({
                  files: diff.files,
                  insertions: diff.insertions,
                  deletions: diff.deletions,
                });
              }
            } catch {
              rangeRisk = null;
            }
          }

          // Per-task area/size from the merge commit (prefer subject match).
          // Only tasks whose mergedSha is in production..staging can be ahead —
          // skip out-of-range merged tasks when rangeShas is known.
          if (panelWs.commitDiffBrief) {
            const aheadIds = snapshot.tasks.filter((t) => {
              if (t.repo !== repo.key) return false;
              if (t.mergedSha === undefined || t.mergedSha === null || t.mergedSha === '') {
                return false;
              }
              if (rangeShas !== undefined && !rangeShas.has(t.mergedSha.toLowerCase())) {
                return false;
              }
              return true;
            });
            for (const t of aheadIds) {
              const mergedSha = t.mergedSha!;
              let sha = mergedSha;
              if (panelWs.findTaskMergeCommit) {
                try {
                  const found = await panelWs.findTaskMergeCommit(
                    repo,
                    t.id,
                    release.productionSha,
                    rangeStaging,
                  );
                  if (found) sha = found;
                } catch {
                  /* keep mergedSha */
                }
              }
              try {
                const brief = await panelWs.commitDiffBrief(repo, sha);
                if (brief) {
                  taskGitFacts.set(t.id, {
                    files: brief.files,
                    insertions: brief.insertions,
                    deletions: brief.deletions,
                    commitSubject: brief.subject,
                  });
                }
              } catch {
                /* skip task facts */
              }
            }
          }

          // Gate-merged candidate ancestry: intermediate commits on the verified
          // tip path are task-covered, not "direct operator pushes".
          // A gate task merged before production has its whole candidate path
          // already in production, and one merged after staging is outside the
          // range — neither can cover a production..staging commit.
          if (rangeCommits && panelWs.isCommitAncestor) {
            const covered = new Set<string>();
            for (const t of snapshot.tasks) {
              if (t.repo !== repo.key) continue;
              if (t.mergedVia !== 'gate') continue;
              if (
                rangeShas !== undefined &&
                (t.mergedSha === undefined ||
                  t.mergedSha === null ||
                  t.mergedSha === '' ||
                  !rangeShas.has(t.mergedSha.toLowerCase()))
              ) {
                continue;
              }
              const tip = (t.verifiedSha ?? t.mergedSha ?? '').trim().toLowerCase();
              if (!/^[0-9a-f]{40}$/.test(tip)) continue;
              covered.add(tip);
              if (t.mergedSha) covered.add(t.mergedSha.toLowerCase());
              for (const c of rangeCommits) {
                try {
                  const ok = await panelWs.isCommitAncestor(repo, c.sha, tip);
                  if (ok === true) covered.add(c.sha.toLowerCase());
                } catch {
                  /* leave uncovered */
                }
              }
            }
            gateCoveredShas = covered;
          }
        }

        // Live range (previousProduction..production) — independent of staging tip.
        if (
          panelWs.rangeShas &&
          prev !== null &&
          release.productionSha !== null &&
          release.productionSha !== ''
        ) {
          try {
            liveRangeShas = await panelWs.rangeShas(
              repo,
              prev,
              release.productionSha,
            );
          } catch {
            liveRangeShas = undefined;
          }
        }

        this.releaseGitFactsCache.set(repo.key, {
          key: factsKey,
          rangeRisk,
          ...(rangeShas !== undefined ? { rangeShas } : {}),
          ...(liveRangeShas !== undefined ? { liveRangeShas } : {}),
          ...(rangeCommits !== undefined ? { rangeCommits } : {}),
          taskGitFacts,
          ...(gateCoveredShas !== undefined ? { gateCoveredShas } : {}),
        });
      }

      const stagingScreenshots = await this.listReleaseScreenshots(repo.key);
      const stagingUiToken =
        this.releasePanelDeps?.resolveStagingUiToken?.(authTokenEnv) ?? null;

      entries.push(
        buildReleasePanelEntry({
          release,
          mainSha,
          stagingUrl,
          hasProductionDeploy,
          hasProjectStateClosure,
          tasks: snapshot.tasks,
          ...(rangeShas !== undefined ? { rangeShas } : {}),
          ...(liveRangeShas !== undefined ? { liveRangeShas } : {}),
          ...(rangeCommits !== undefined ? { rangeCommits } : {}),
          ...(gateCoveredShas !== undefined ? { gateCoveredShas } : {}),
          rangeRisk,
          taskGitFacts,
          stagingScreenshots,
          stagingUiToken,
          ...(this.releasePanelDeps?.stagingVerifyTimeoutMs !== undefined
            ? { stagingVerifyTimeoutMs: this.releasePanelDeps.stagingVerifyTimeoutMs }
            : {}),
        }),
      );
    }
    return entries;
  }

  /** Safe post-merge facts; source-owner registration paths never enter this DTO. */
  async getWorkspaceSuccession(repoKey: string): Promise<WorkspaceSuccessionPublicDto | null> {
    if (!isValidIdentifier(repoKey)) throw new ActionError(`unsafe repo key '${repoKey}'`);
    const snapshot = await this.control.read();
    if (!snapshot.repos.repos[repoKey]) throw new ActionError(`unknown repo '${repoKey}'`);
    if (!this.control.readSuccession) return null;
    const ledger = await this.control.readSuccession(repoKey);
    return ledger ? toWorkspaceSuccessionPublicDto(ledger) : null;
  }

  /**
   * Basenames of staging evidence PNGs for a repo (path-confined). Empty when
   * the release screenshots root is unset or the dir is missing.
   */
  private async listReleaseScreenshots(repoKey: string): Promise<string[]> {
    if (!isValidIdentifier(repoKey)) return [];
    const root = this.releasePanelDeps?.releaseScreenshotsRoot;
    if (!root) return [];
    try {
      const dir = join(root, repoKey);
      const names = await readdir(dir);
      return names
        .filter((n) => /^[A-Za-z0-9._-]+\.png$/.test(n))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  /**
   * Human "Deploy staging now" — flags the release reconciler to bypass the
   * quiet-period debounce on the next tick (design §3).
   */
  requestStagingDeployNow(repoKey: string): { accepted: true } {
    if (!isValidIdentifier(repoKey)) {
      throw new ActionError(`unsafe repo key '${repoKey}'`);
    }
    const fn = this.releasePanelDeps?.requestStagingDeployNow;
    if (!fn) {
      throw new ActionError('deploy staging now is not configured on this daemon');
    }
    fn(repoKey);
    return { accepted: true };
  }
  async startMergeOperation(
    repoKey: string,
    taskIds: readonly string[],
    idempotencyKey?: string | null,
  ): Promise<MergeOperationReceipt> {
    if (!this.mergeOperationService) {
      throw new ActionError('merge operations are not configured on this daemon');
    }
    try {
      return await this.mergeOperationService.start({
        repoKey,
        taskIds,
        idempotencyKey: idempotencyKey ?? null,
      });
    } catch (err) {
      if (err instanceof MergeOperationError) throw new ActionError(err.message);
      throw err;
    }
  }

  /**
   * review → done. Holds the branch tip to the verified SHA when known.
   * When the task DoD has human-axis criteria, every text must appear in
   * {@link ApproveOpts.humanAcknowledged} (phone checklist) — UI disable is
   * not enough; curl/voice must not bypass.
   */
  async approve(id: string, opts?: ApproveOpts): Promise<Task> {
    if (!isValidIdentifier(id)) throw new ActionError(`unsafe task id '${id}'`);
    const snapshot = await this.control.read();
    const task = snapshot.tasks.find((t) => t.id === id);
    // Verified-SHA invariant (fake-green incident 2026-07-15): what the human
    // approves must be what verification actually saw on the branch.
    const check = this.reverifyDeps?.workspaces.preservedTipStatus;
    if (task?.verifiedSha && check) {
      const status = await check.call(
        this.reverifyDeps!.workspaces,
        task.repo,
        id,
        task.verifiedSha,
      );
      if (!status.ok) {
        throw new ActionError(
          `refusing approve: ${status.reason}. ` +
            `Re-verify (or re-run) the task so the packet matches the preserved branch.`,
        );
      }
    }
    if (task) {
      const missing = missingHumanAcknowledgements(
        task.body,
        opts?.humanAcknowledged ?? [],
      );
      if (missing.length > 0) {
        const preview = missing
          .slice(0, 3)
          .map((t) => (t.length > 80 ? `${t.slice(0, 80)}…` : t))
          .join('; ');
        throw new ActionError(
          `refusing approve: human acceptance criteria unchecked (${missing.length}): ${preview}. ` +
            `Check each (human) item on the phone first.`,
        );
      }
    }
    if (opts?.autoMerge) {
      if (opts.overrideNote !== undefined) {
        throw new ActionError('autoMerge cannot carry an operator override');
      }
      if (!task) throw new ActionError(`unknown task '${id}'`);
      return this.transition(
        id,
        'done',
        {
          pendingSteer: null,
          labels: [...new Set([...task.labels, AUTO_MERGE_LABEL])],
          body: appendAutoMergeNote(
            task.body,
            new Date().toISOString(),
            opts.autoMerge.detail,
          ),
        },
        'auto-merge',
      );
    }
    const note = opts?.overrideNote?.trim();
    if (note && task) {
      const stamp = new Date().toISOString();
      const section =
        `\n\n## Operator override (${stamp})\n\n` +
        `Approved by the operator WITHOUT a green automated packet.\n` +
        `Reason: ${note.slice(0, 500)}\n`;
      return this.transition(id, 'done', {
        pendingSteer: null,
        body: `${task.body.trimEnd()}${section}`,
      });
    }
    return this.transition(id, 'done', { pendingSteer: null });
  }

  /**
   * Auto-merge pilot sweep (timer in main.ts, HERCULES_AUTO_MERGE=1 only).
   * For each repo with `autoMerge.enabled`: approve every review task that
   * evaluateAutoMerge accepts, then start ONE merge operation per repo for all
   * done tasks carrying AUTO_MERGE_LABEL that have no mergedSha yet
   * (newly approved + earlier ones whose merge could not start). Never throws
   * for a single task — per-task errors become `skipped` reasons.
   */
  async runAutoMergePilot(now: Date = new Date()): Promise<AutoMergePilotReport> {
    const approved: string[] = [];
    const merges: { operationId: string; taskIds: readonly string[] }[] = [];
    const skipped: { id: string; reason: string }[] = [];

    const snapshot = await this.control.read();
    const enabledRepos = Object.values(snapshot.repos.repos).filter(
      (r) => r.autoMerge?.enabled === true,
    );
    if (enabledRepos.length === 0) {
      return { approved, merges, skipped };
    }
    const enabledKeys = new Set(enabledRepos.map((r) => r.key));

    for (const task of snapshot.tasks) {
      if (!enabledKeys.has(task.repo)) continue;
      if (task.state !== 'review') continue;
      const repo = snapshot.repos.repos[task.repo];
      if (!repo?.autoMerge?.enabled) continue;
      const policy = repo.autoMerge;

      let diff: AutoMergeDiff | null = null;
      if (task.verifiedSha) {
        const ws = this.releasePanelDeps?.workspaces;
        if (ws?.taskBranchDiff) {
          try {
            diff = await ws.taskBranchDiff(repo, task.verifiedSha);
          } catch {
            diff = null;
          }
        }
      }

      const verdict = evaluateAutoMerge({ task, policy, diff, now });
      if (!verdict.eligible) {
        skipped.push({ id: task.id, reason: verdict.reason });
        continue;
      }

      const { linesChanged, size, dwellMinutes } = verdict;
      const detail =
        `Approved by the auto-merge pilot: packet green (L1/L2/L3), no human criteria, ` +
        `${diff!.files.length} files / ${linesChanged} lines (${size} ≤ ${policy.maxSize}), ` +
        `${dwellMinutes} min in review (≥ ${policy.dwellMinutes}).`;
      try {
        await this.approve(task.id, { autoMerge: { detail } });
        approved.push(task.id);
        console.error(
          `[hercules] auto-merge: approved ${task.id} (${size}, ${linesChanged} lines, dwell ${dwellMinutes}m)`,
        );
      } catch (err) {
        const message = (err as Error).message;
        skipped.push({ id: task.id, reason: `approve failed: ${message}` });
        console.error(`[hercules] auto-merge: approve failed for ${task.id}: ${message}`);
      }
    }

    const after = await this.control.read();
    for (const repo of enabledRepos) {
      const ids = after.tasks
        .filter(
          (t) =>
            t.repo === repo.key &&
            t.state === 'done' &&
            t.labels.includes(AUTO_MERGE_LABEL) &&
            !t.mergedSha &&
            t.prStatus !== 'merged',
        )
        .map((t) => t.id);
      if (ids.length === 0) continue;
      if (!this.mergeOperationService) continue;
      try {
        const receipt = await this.startMergeOperation(
          repo.key,
          ids,
          `auto-merge:${ids.join(',')}`,
        );
        merges.push({ operationId: receipt.operationId, taskIds: ids });
        console.error(
          `[hercules] auto-merge: merge ${receipt.operationId} started for [${ids.join(', ')}]`,
        );
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes('merge already in flight')) {
          continue;
        }
        console.error(`[hercules] auto-merge: merge failed for ${repo.key}: ${message}`);
      }
    }

    return { approved, merges, skipped };
  }

  /**
   * Open (or find) a GitHub PR for `hercules/<id>` (SPEC backlog: Approve → PR).
   * Allowed from review or done. Persists pr_url + pr_status=open on success so
   * the phone UI can highlight active PRs among done tasks.
   */
  async openPr(id: string): Promise<OpenPrResult> {
    if (!isValidIdentifier(id)) throw new ActionError(`unsafe task id '${id}'`);
    const snapshot = await this.control.read();
    const task = snapshot.tasks.find((t) => t.id === id);
    if (!task) throw new ActionError(`unknown task '${id}'`);
    const repo = snapshot.repos.repos[task.repo];
    if (!repo) throw new ActionError(`unknown repo '${task.repo}'`);
    try {
      const pr = await openPullRequest({
        task,
        repo,
        ...(this.gh ? { gh: this.gh } : {}),
      });
      // created | existing | compare-with-branch-on-remote → treat as active PR trail.
      const status = pr.mode === 'compare' ? task.prStatus : 'open';
      const next: Task = {
        ...task,
        prUrl: pr.url,
        prStatus: pr.mode === 'compare' ? (status ?? 'open') : 'open',
      };
      if (next.prUrl !== task.prUrl || next.prStatus !== task.prStatus) {
        await mutateControl(this.control, { writeTasks: [{ expected: task, next }] }, `hercules: ${id} pr → ${next.prStatus ?? 'linked'}`);
      }
      return pr;
    } catch (err) {
      if (err instanceof OpenPrError) throw new ActionError(err.message);
      throw err;
    }
  }

  /**
   * review → done, then open/find a PR. On PR failure the task is still approved
   * (human can retry Open PR); the error is rethrown.
   */
  async approveAndOpenPr(
    id: string,
    opts?: ApproveOpts,
  ): Promise<{ task: Task; pr: OpenPrResult }> {
    await this.approve(id, opts);
    // Re-read after approve so openPr sees state=done + can persist PR fields.
    const pr = await this.openPr(id);
    const snapshot = await this.control.read();
    const task = snapshot.tasks.find((t) => t.id === id);
    if (!task) throw new ActionError(`unknown task '${id}'`);
    return { task, pr };
  }

  /**
   * review → todo (reject for rework). Clears session so the next dispatch is a
   * fresh agent run, not a resumed steer turn.
   */
  reject(id: string): Promise<Task> {
    return this.transition(id, 'todo', { agentSession: null, pendingSteer: null });
  }

  /**
   * Comment-to-steer (SPEC §14): append the human note, queue the task for
   * re-dispatch, and keep {@link Task.agentSession} so the next start can resume
   * the prior adapter session with a short prompt.
   *
   * Allowed from:
   *   - review / failed (classic rework)
   *   - done (post-Approve&PR: same hercules/<id> branch force-pushes into the open PR)
   */
  async steer(
    id: string,
    comment: string,
    opts?: { readonly clientMessageId?: string | null },
  ): Promise<Task> {
    if (!isValidIdentifier(id)) throw new ActionError(`unsafe task id '${id}'`);
    const text = comment.trim();
    if (text.length === 0) throw new ActionError('steer comment is required');
    // Cap so a phone paste cannot bloat the control-repo file unboundedly.
    if (text.length > 4000) throw new ActionError('steer comment too long (max 4000 chars)');
    const clientMessageId = normalizeClientMessageId(opts?.clientMessageId ?? null);

    const snapshot = await this.control.read();
    const task = snapshot.tasks.find((t) => t.id === id);
    if (!task) throw new ActionError(`unknown task '${id}'`);
    if (task.state !== 'review' && task.state !== 'failed' && task.state !== 'done') {
      throw new ActionError(
        `can only steer a task in review, failed, or done (got '${task.state}')`,
      );
    }

    try {
      assertTransition(task.state, 'todo');
    } catch (err) {
      if (err instanceof TransitionError) throw new ActionError(err.message);
      throw err;
    }

    const stamp = new Date().toISOString();
    const section = formatHumanSteerSection({
      stamp,
      text,
      clientMessageId,
      taskId: id,
    });
    const fromFailed = task.state === 'failed';
    // Deliberate human continuation after attempts-exhausted / thrash park:
    // reset attempts to 0 (same model as Retry — not "bump past maxAttempts").
    // Failure accounting also restarts at this Human steer (retryPolicy).
    // Poisoned agent_exit sessions are abandoned like Retry so resume cannot
    // instant-repark before a real new attempt.
    const abandon =
      fromFailed &&
      shouldAbandonSessionOnRetry({
        agentSession: task.agentSession,
        body: task.body,
      });
    let body = `${task.body.trim()}\n\n${section}`;
    let agentSession = task.agentSession;
    if (abandon) {
      const prior = (task.agentSession ?? '').trim();
      body = `${body.trimEnd()}\n\n${formatAbandonSessionNote(prior, stamp)}`;
      agentSession = null;
    }
    const next: Task = {
      ...task,
      state: 'todo',
      pendingSteer: text,
      agentSession,
      // Keep agentSession for resume when not abandoning. Fresh timing for the
      // next run display.
      endedAt: null,
      ...(fromFailed ? { attempts: 0, lastEventAt: null } : {}),
      ...(abandon ? { agentSessionAdapter: null } : {}),
      ...(fromFailed && task.reviewerInfrastructure
        ? { reviewerInfrastructure: null }
        : {}),
      // Keep pr_url / pr_status=open so Awaiting merge UI survives steer.
      body,
    };
    await mutateControl(this.control, { writeTasks: [{ expected: task, next }] }, `hercules: ${id} ${task.state} → todo (steer)`);
    return next;
  }

  /**
   * Pull review/issue comments from the task's open GitHub PR and queue them as
   * a steer turn (done/review/failed → todo). Human must call this explicitly.
   */
  async steerFromPrComments(id: string): Promise<{ task: Task; commentCount: number; draft: string }> {
    if (!isValidIdentifier(id)) throw new ActionError(`unsafe task id '${id}'`);
    const snapshot = await this.control.read();
    const task = snapshot.tasks.find((t) => t.id === id);
    if (!task) throw new ActionError(`unknown task '${id}'`);
    if (!task.prUrl) {
      throw new ActionError('task has no pr_url — open a PR first');
    }
    const repo = snapshot.repos.repos[task.repo];
    if (!repo) throw new ActionError(`unknown repo '${task.repo}'`);

    try {
      const { draft, commentCount } = await taskPr.fetchBoundPrComments(
        this.taskPrInput(task, repo, task.prUrl),
      );
      if (commentCount === 0) {
        throw new ActionError('no PR comments/reviews found to steer from');
      }
      const steered = await this.steer(id, draft);
      return { task: steered, commentCount, draft };
    } catch (err) {
      if (err instanceof OpenPrError) throw new ActionError(err.message);
      if (err instanceof ActionError) throw err;
      throw err;
    }
  }

  /**
   * Preview PR comments as a steer draft without mutating the task.
   */
  async previewPrComments(id: string): Promise<{ draft: string; commentCount: number }> {
    if (!isValidIdentifier(id)) throw new ActionError(`unsafe task id '${id}'`);
    const snapshot = await this.control.read();
    const task = snapshot.tasks.find((t) => t.id === id);
    if (!task) throw new ActionError(`unknown task '${id}'`);
    if (!task.prUrl) throw new ActionError('task has no pr_url — open a PR first');
    try {
      const repo = snapshot.repos.repos[task.repo];
      if (!repo) throw new ActionError('unknown repo for task');
      return await taskPr.fetchBoundPrComments(this.taskPrInput(task, repo, task.prUrl));
    } catch (err) {
      if (err instanceof OpenPrError) throw new ActionError(err.message);
      throw err;
    }
  }

  /** Live CI + review/comment counts for the task's GitHub PR (phone review). */
  async prSummary(id: string): Promise<PrSummary> {
    if (!isValidIdentifier(id)) throw new ActionError(`unsafe task id '${id}'`);
    const snapshot = await this.control.read();
    const task = snapshot.tasks.find((t) => t.id === id);
    if (!task) throw new ActionError(`unknown task '${id}'`);
    if (!task.prUrl) throw new ActionError('task has no pr_url — open a PR first');
    try {
      const repo = snapshot.repos.repos[task.repo];
      if (!repo) throw new ActionError('unknown repo for task');
      const summary = await taskPr.fetchBoundPrSummary(this.taskPrInput(task, repo, task.prUrl));
      // Opening the detail sheet is a free chance to clear stale "Awaiting merge".
      await this.applyPrStatusIfChanged(task, githubPrStateToStatus(summary.state), summary.mergeCommitSha);
      return summary;
    } catch (err) {
      if (err instanceof OpenPrError) throw new ActionError(err.message);
      throw err;
    }
  }

  /**
   * Reconcile control-repo `pr_status` for every task still marked open against
   * GitHub. Best-effort: gh failures skip that task (never wipe status).
   * Called on a slow interval so Awaiting merge drops after website merges.
   *
   * Also: if an open PR is still CONFLICTING while the task sits in review/done
   * (agent claimed green without fixing), re-queue a system steer so the next
   * tick reworks under pr-mergeable — settings-build false-green case study.
   * Factory PRs (no local L1/L2) also requeue when GitHub checks are red
   * or when a MERGEABLE PR is BEHIND the default branch. A finished factory
   * draft is marked ready (not Approve). A CLEAN + green factory PR is
   * squash-merged via identity-bound `gh` so ring 4 can fire without a
   * human click. Not MergeService.
   */
  async syncOpenPrStatuses(): Promise<{ readonly updated: readonly string[] }> {
    const snapshot = await this.control.read();
    // Open PRs need lifecycle/mergeability checks. Also include:
    // - review tasks whose pr_status is already terminal (merged/closed) so we
    //   heal the settings-build case (status stamped, state stuck in review)
    // - done + pr_status=merged + missing merged_sha (release-verify-timeout:
    //   external GH merge synced status only — backfill provenance)
    const candidates = snapshot.tasks.filter((t) => {
      if (!t.prUrl) return false;
      if (hasOpenPr(t)) return true;
      if (
        t.state === 'review' &&
        (t.prStatus === 'merged' || t.prStatus === 'closed')
      ) {
        return true;
      }
      const hasSha = typeof t.mergedSha === 'string' && t.mergedSha.length > 0;
      if (t.state === 'done' && t.prStatus === 'merged' && !hasSha) {
        return true;
      }
      return false;
    });
    if (candidates.length === 0) return { updated: [] };

    const updated: string[] = [];
    for (const task of candidates) {
      const prUrl = task.prUrl;
      if (!prUrl) continue;

      if (task.state === 'review' && task.prStatus === 'closed') {
        // Closed without merge — leave review for human reject/cancel.
        continue;
      }

      const hasSha = typeof task.mergedSha === 'string' && task.mergedSha.length > 0;
      const needsProvenanceBackfill = task.prStatus === 'merged' && !hasSha;

      // Fast path: review already merged with complete provenance — no network.
      if (task.state === 'review' && task.prStatus === 'merged' && !needsProvenanceBackfill) {
        const healed = await this.applyPrLifecycleUpdate(task, 'merged', null);
        if (healed) updated.push(task.id);
        continue;
      }

      let lifecycle: Awaited<ReturnType<typeof taskPr.fetchBoundPrLifecycle>> = null;
      try {
        const repoCfg = snapshot.repos.repos[task.repo];
        if (!repoCfg) continue;
        lifecycle = await taskPr.fetchBoundPrLifecycle(
          this.taskPrInput(task, repoCfg, prUrl),
        );
      } catch {
        // fall through to offline heal
      }

      if (!lifecycle) {
        // Network failed: still heal review→done when we already know merged
        // (without inventing a merge SHA).
        if (task.state === 'review' && task.prStatus === 'merged') {
          const healed = await this.applyPrLifecycleUpdate(task, 'merged', null);
          if (healed) updated.push(task.id);
        }
        continue;
      }

      const applied = await this.applyPrLifecycleUpdate(
        task,
        lifecycle.status,
        lifecycle.mergeCommitSha,
      );
      if (applied) {
        updated.push(task.id);
        continue;
      }

      // Already open on both sides — check mergeability for parked review/done.
      if (lifecycle.status === 'open' || task.prStatus === 'open') {
        if (task.state === 'review' || task.state === 'done') {
          const repo = snapshot.repos.repos[task.repo];
          if (!repo) continue;
          const requeued = await this.requeueIfPrConflicting(task, repo);
          if (requeued) {
            updated.push(task.id);
            continue;
          }
          const ciRequeued = await this.requeueIfFactoryCiFailed(task, repo);
          if (ciRequeued) {
            updated.push(task.id);
            continue;
          }
          const rebased = await this.rebaseFactoryPrIfBehind(task, repo);
          if (rebased) {
            updated.push(task.id);
            continue;
          }
          const behindRequeued = await this.requeueIfFactoryBehind(task, repo);
          if (behindRequeued) {
            updated.push(task.id);
            continue;
          }
          const markedReady = await this.markFactoryPrReadyIfDraft(task, repo);
          if (markedReady) {
            updated.push(task.id);
            continue;
          }
          const merged = await this.mergeFactoryPrIfClean(task, repo);
          if (merged) updated.push(task.id);
        }
      }
    }
    return { updated };
  }

  /**
   * When GitHub says CONFLICTING and the human is waiting on review/merge,
   * inject a system steer and move to todo (same path as human steer) so the
   * agent reworks. Skips if a pendingSteer is already queued.
   */
  private async requeueIfPrConflicting(
    task: Task,
    repo: RepoConfig,
  ): Promise<boolean> {
    if (!task.prUrl) return false;
    if (task.pendingSteer && task.pendingSteer.trim().length > 0) return false;
    if (task.state !== 'review' && task.state !== 'done') return false;
    const factory = isRemoteFactoryPrIdentity({
      taskAdapter: task.adapter,
      repoAdapter: repo.adapter,
    }) || isFactoryConflictRework(task);

    let probe: taskPr.PrConflictProbe;
    try {
      probe = await taskPr.fetchBoundPrConflictProbe(this.taskPrInput(task, repo, task.prUrl));
    } catch {
      return false;
    }
    const m = (probe.mergeable ?? '').toUpperCase();
    if (m !== 'CONFLICTING') return false;

    const factoryHead = probe.headRefName.trim();
    if (factory && !isSafeFactoryGitRef(factoryHead)) {
      // Fail closed: cannot name a Cloud Agent branch for the next launch.
      return false;
    }
    if (factory && factoryHead === repo.defaultBranch.trim()) {
      return false;
    }

    const stamp = new Date().toISOString();

    // Thrash brake: stop auto re-queue after N CONFLICTING steers (leave human).
    if (shouldCapPrConflictRequeue(task.body)) {
      if (/##\s+Thrash brake \(pr-mergeable\)\b/i.test(task.body)) return false;
      const thrash = factory
        ? buildFactoryConflictThrashSection({
            stamp,
            prUrl: task.prUrl,
            headRef: factoryHead,
            taskId: task.id,
          })
        : buildPrConflictThrashSection({
            stamp,
            prUrl: task.prUrl,
            taskId: task.id,
          });
      const body = `${task.body.trimEnd()}\n\n${thrash}\n`;
      await mutateControl(this.control, { writeTasks: [{ expected: task, next: {
        ...task, body, lastEventAt: stamp,
      } }] }, `hercules: ${task.id} pr conflict thrash brake`);
      console.error(
        `[hercules] pr-mergeable: thrash brake on ${task.id} — no more auto re-queue`,
      );
      return true; // counted as updated
    }

    const steer = factory
      ? buildFactoryConflictSteer({
          prUrl: task.prUrl,
          headRef: factoryHead,
          defaultBranch: repo.defaultBranch,
          taskId: task.id,
        })
      : `Open PR is still CONFLICTING on GitHub (${task.prUrl}). ` +
        `Single source of truth: work **only** on branch \`hercules/${task.id}\` ` +
        `(the open PR tip). Do **not** dual-write main while the PR is open. ` +
        `In the task worktree: fetch origin, merge or rebase the default branch into ` +
        `hercules/${task.id}, resolve every conflict, commit, and push that same branch. ` +
        `Do not claim success until mergeable is MERGEABLE.`;
    const section =
      `## System steer (pr-mergeable) (${stamp})\n\n${steer}\n`;
    const body = `${task.body.trimEnd()}\n\n${section}\n`;
    // review|done → todo (legal; mirrors human steer).
    // Local CLI keeps agentSession for resume. Factory Cloud Agents cannot
    // resume — clear the session so the next tick is a full launch on the PR head.
    try {
      assertTransition(task.state, 'todo');
    } catch {
      return false;
    }
    const sessionFields = factory
      ? { agentSession: null, agentSessionAdapter: null }
      : {};
    await mutateControl(this.control, { writeTasks: [{ expected: task, next: {
      ...task, ...sessionFields, state: 'todo', pendingSteer: steer, body, lastEventAt: stamp, endedAt: null,
    } }] }, `hercules: ${task.id} pr conflict → todo`);
    console.error(
      `[hercules] pr-mergeable: re-queued ${task.id} (${task.state} → todo) — PR CONFLICTING`,
    );
    return true;
  }

  /**
   * Factory-only: when GitHub checks are red and the human is waiting on
   * review/merge, inject a system steer and move to todo so the next Cloud
   * Agent fixes CI on the existing PR head. Local CLI already ran L1.
   */
  private async requeueIfFactoryCiFailed(
    task: Task,
    repo: RepoConfig,
  ): Promise<boolean> {
    if (!task.prUrl) return false;
    if (task.pendingSteer && task.pendingSteer.trim().length > 0) return false;
    if (task.state !== 'review' && task.state !== 'done') return false;
    const factory = isRemoteFactoryPrIdentity({
      taskAdapter: task.adapter,
      repoAdapter: repo.adapter,
    }) || isFactoryConflictRework(task);
    if (!factory) return false;

    let probe: taskPr.PrCiProbe;
    try {
      probe = await taskPr.fetchBoundPrCiProbe(this.taskPrInput(task, repo, task.prUrl));
    } catch {
      return false;
    }
    if (!isFactoryCiFailure(probe.ciStatus)) return false;

    const factoryHead = probe.headRefName.trim();
    if (!isSafeFactoryGitRef(factoryHead)) {
      return false;
    }
    if (factoryHead === repo.defaultBranch.trim()) {
      return false;
    }

    const stamp = new Date().toISOString();

    if (shouldCapPrCiRequeue(task.body)) {
      if (/##\s+Thrash brake \(pr-ci\)\b/i.test(task.body)) return false;
      const thrash = buildFactoryCiThrashSection({
        stamp,
        prUrl: task.prUrl,
        headRef: factoryHead,
        taskId: task.id,
        ciSummary: probe.ciSummary,
      });
      const body = `${task.body.trimEnd()}\n\n${thrash}\n`;
      await mutateControl(this.control, { writeTasks: [{ expected: task, next: {
        ...task, body, lastEventAt: stamp,
      } }] }, `hercules: ${task.id} pr ci thrash brake`);
      console.error(
        `[hercules] pr-ci: thrash brake on ${task.id} — no more auto re-queue`,
      );
      return true;
    }

    const steer = buildFactoryCiSteer({
      prUrl: task.prUrl,
      headRef: factoryHead,
      defaultBranch: repo.defaultBranch,
      taskId: task.id,
      ciSummary: probe.ciSummary,
      failingChecks: probe.failingChecks,
    });
    const section =
      `## System steer (pr-ci) (${stamp})\n\n${steer}\n`;
    const body = `${task.body.trimEnd()}\n\n${section}\n`;
    try {
      assertTransition(task.state, 'todo');
    } catch {
      return false;
    }
    await mutateControl(this.control, { writeTasks: [{ expected: task, next: {
      ...task,
      agentSession: null,
      agentSessionAdapter: null,
      state: 'todo',
      pendingSteer: steer,
      body,
      lastEventAt: stamp,
      endedAt: null,
    } }] }, `hercules: ${task.id} pr ci → todo`);
    console.error(
      `[hercules] pr-ci: re-queued ${task.id} (${task.state} → todo) — GitHub CI failing`,
    );
    return true;
  }

  /**
   * Factory-only: rebase a BEHIND PR via identity-bound `gh pr rebase`
   * so a sibling merge does not consume a Cloud Agent slot. Red CI and
   * CONFLICTING still win. Rebase failure falls through to ring 9 requeue.
   * Not Approve. Not MergeService. Local CLI is not auto-rebased.
   */
  private async rebaseFactoryPrIfBehind(
    task: Task,
    repo: RepoConfig,
  ): Promise<boolean> {
    if (!task.prUrl) return false;
    if (task.pendingSteer && task.pendingSteer.trim().length > 0) return false;
    if (task.state !== 'review' && task.state !== 'done') return false;
    const factory = isRemoteFactoryPrIdentity({
      taskAdapter: task.adapter,
      repoAdapter: repo.adapter,
    }) || isFactoryConflictRework(task);
    if (!factory) return false;

    let probe: taskPr.PrBehindProbe;
    try {
      probe = await taskPr.fetchBoundPrBehindProbe(this.taskPrInput(task, repo, task.prUrl));
    } catch {
      return false;
    }
    if (
      !shouldRebaseFactoryBehind({
        mergeStateStatus: probe.mergeStateStatus ?? '',
        ciStatus: probe.ciStatus,
      })
    ) {
      return false;
    }

    try {
      await taskPr.rebaseBoundFactoryPr(this.taskPrInput(task, repo, task.prUrl));
    } catch {
      return false;
    }

    const stamp = new Date().toISOString();
    const audit = buildFactoryRebasedAuditSection({
      stamp,
      prUrl: task.prUrl,
    });
    const body = `${task.body.trimEnd()}\n\n${audit}\n`;
    await mutateControl(this.control, { writeTasks: [{ expected: task, next: {
      ...task, body, lastEventAt: stamp,
    } }] }, `hercules: ${task.id} factory PR rebase`);
    console.error(
      `[hercules] pr-behind: rebased ${task.id} factory PR via GitHub — not a Cloud Agent relaunch`,
    );
    return true;
  }

  /**
   * Factory-only: when GitHub says BEHIND and checks are not red/pending,
   * rebase the existing Cloud Agent head onto default. Local CLI already
   * has base-drift at verify time. CONFLICTING and red CI still win.
   * Runs only when {@link rebaseFactoryPrIfBehind} could not land.
   */
  private async requeueIfFactoryBehind(
    task: Task,
    repo: RepoConfig,
  ): Promise<boolean> {
    if (!task.prUrl) return false;
    if (task.pendingSteer && task.pendingSteer.trim().length > 0) return false;
    if (task.state !== 'review' && task.state !== 'done') return false;
    const factory = isRemoteFactoryPrIdentity({
      taskAdapter: task.adapter,
      repoAdapter: repo.adapter,
    }) || isFactoryConflictRework(task);
    if (!factory) return false;

    let probe: taskPr.PrBehindProbe;
    try {
      probe = await taskPr.fetchBoundPrBehindProbe(this.taskPrInput(task, repo, task.prUrl));
    } catch {
      return false;
    }
    if (
      !shouldRequeueFactoryBehind({
        mergeStateStatus: probe.mergeStateStatus ?? '',
        ciStatus: probe.ciStatus,
      })
    ) {
      return false;
    }

    const factoryHead = probe.headRefName.trim();
    if (!isSafeFactoryGitRef(factoryHead)) {
      return false;
    }
    if (factoryHead === repo.defaultBranch.trim()) {
      return false;
    }

    const stamp = new Date().toISOString();

    if (shouldCapPrBehindRequeue(task.body)) {
      if (/##\s+Thrash brake \(pr-behind\)\b/i.test(task.body)) return false;
      const thrash = buildFactoryBehindThrashSection({
        stamp,
        prUrl: task.prUrl,
        headRef: factoryHead,
        taskId: task.id,
      });
      const body = `${task.body.trimEnd()}\n\n${thrash}\n`;
      await mutateControl(this.control, { writeTasks: [{ expected: task, next: {
        ...task, body, lastEventAt: stamp,
      } }] }, `hercules: ${task.id} pr behind thrash brake`);
      console.error(
        `[hercules] pr-behind: thrash brake on ${task.id} — no more auto re-queue`,
      );
      return true;
    }

    const steer = buildFactoryBehindSteer({
      prUrl: task.prUrl,
      headRef: factoryHead,
      defaultBranch: repo.defaultBranch,
      taskId: task.id,
    });
    const section =
      `## System steer (pr-behind) (${stamp})\n\n${steer}\n`;
    const body = `${task.body.trimEnd()}\n\n${section}\n`;
    try {
      assertTransition(task.state, 'todo');
    } catch {
      return false;
    }
    await mutateControl(this.control, { writeTasks: [{ expected: task, next: {
      ...task,
      agentSession: null,
      agentSessionAdapter: null,
      state: 'todo',
      pendingSteer: steer,
      body,
      lastEventAt: stamp,
      endedAt: null,
    } }] }, `hercules: ${task.id} pr behind → todo`);
    console.error(
      `[hercules] pr-behind: re-queued ${task.id} (${task.state} → todo) — PR BEHIND`,
    );
    return true;
  }

  /**
   * Factory-only: convert a finished draft PR to ready for review.
   * Drafts cannot merge, so ring 4 close-out never fires. Not Approve.
   * CONFLICTING / red CI / BEHIND still win (those requeue first).
   */
  private async markFactoryPrReadyIfDraft(
    task: Task,
    repo: RepoConfig,
  ): Promise<boolean> {
    if (!task.prUrl) return false;
    if (task.pendingSteer && task.pendingSteer.trim().length > 0) return false;
    if (task.state !== 'review' && task.state !== 'done') return false;
    const factory = isRemoteFactoryPrIdentity({
      taskAdapter: task.adapter,
      repoAdapter: repo.adapter,
    }) || isFactoryConflictRework(task);
    if (!factory) return false;

    let probe: taskPr.PrDraftProbe;
    try {
      probe = await taskPr.fetchBoundPrDraftProbe(this.taskPrInput(task, repo, task.prUrl));
    } catch {
      return false;
    }
    if (
      !shouldMarkFactoryPrReady({
        isDraft: probe.isDraft,
        mergeStateStatus: probe.mergeStateStatus,
        body: task.body,
      })
    ) {
      return false;
    }

    try {
      await taskPr.markBoundPrReady(this.taskPrInput(task, repo, task.prUrl));
    } catch {
      return false;
    }

    const stamp = new Date().toISOString();
    const audit = buildFactoryReadyAuditSection({
      stamp,
      prUrl: task.prUrl,
    });
    const body = `${task.body.trimEnd()}\n\n${audit}\n`;
    await mutateControl(this.control, { writeTasks: [{ expected: task, next: {
      ...task, body, lastEventAt: stamp,
    } }] }, `hercules: ${task.id} factory PR ready`);
    console.error(
      `[hercules] pr-draft: marked ${task.id} factory PR ready for review — not a merge`,
    );
    return true;
  }

  /**
   * Factory-only: squash-merge a CLEAN + green ready PR so ring 4 close-out
   * can fire. Not Approve. Not MergeService. CONFLICTING / red CI / BEHIND /
   * draft still win (those run first).
   */
  private async mergeFactoryPrIfClean(
    task: Task,
    repo: RepoConfig,
  ): Promise<boolean> {
    if (!task.prUrl) return false;
    if (task.pendingSteer && task.pendingSteer.trim().length > 0) return false;
    if (task.state !== 'review' && task.state !== 'done') return false;
    const factory = isRemoteFactoryPrIdentity({
      taskAdapter: task.adapter,
      repoAdapter: repo.adapter,
    }) || isFactoryConflictRework(task);
    if (!factory) return false;

    let probe: taskPr.PrMergeProbe;
    try {
      probe = await taskPr.fetchBoundPrMergeProbe(this.taskPrInput(task, repo, task.prUrl));
    } catch {
      return false;
    }
    if (
      !shouldMergeFactoryPr({
        isDraft: probe.isDraft,
        mergeable: probe.mergeable,
        mergeStateStatus: probe.mergeStateStatus,
        ciStatus: probe.ciStatus,
        body: task.body,
      })
    ) {
      return false;
    }

    const stamp = new Date().toISOString();
    let withheldDetail: string | null = null;
    try {
      await taskPr.mergeBoundFactoryPr(this.taskPrInput(task, repo, task.prUrl));
    } catch (err) {
      withheldDetail = err instanceof Error ? err.message : String(err);
    }

    const audit = withheldDetail
      ? buildFactoryMergeWithheldAuditSection({
          stamp,
          prUrl: task.prUrl,
          detail: withheldDetail,
        })
      : buildFactoryMergedAuditSection({
          stamp,
          prUrl: task.prUrl,
        });
    const body = `${task.body.trimEnd()}\n\n${audit}\n`;
    let next: Task = { ...task, body, lastEventAt: stamp };

    if (withheldDetail) {
      await mutateControl(this.control, { writeTasks: [{ expected: task, next }] },
        `hercules: ${task.id} factory PR merge withheld`);
      console.error(
        `[hercules] pr-merge: withheld ${task.id} factory squash-merge — left in review`,
      );
      return true;
    }

    let lifecycle: Awaited<ReturnType<typeof taskPr.fetchBoundPrLifecycle>> = null;
    try {
      lifecycle = await taskPr.fetchBoundPrLifecycle(
        this.taskPrInput(task, repo, task.prUrl),
      );
    } catch {
      lifecycle = null;
    }

    if (lifecycle?.status === 'merged') {
      next = { ...next, prStatus: 'merged' };
      const hasSha = typeof task.mergedSha === 'string' && task.mergedSha.length > 0;
      if (!hasSha && lifecycle.mergeCommitSha) {
        next = { ...next, mergedSha: lifecycle.mergeCommitSha, mergedVia: 'operator' };
      }
      if (task.state === 'review') {
        try {
          assertTransition(task.state, 'done');
          next = {
            ...next,
            state: 'done',
            endedAt: next.endedAt ?? stamp,
          };
        } catch {
          // leave review; ring 4 observe still closes
        }
      }
    }

    await mutateControl(this.control, { writeTasks: [{ expected: task, next }] },
      `hercules: ${task.id} factory PR squash-merge`);
    console.error(
      lifecycle?.status === 'merged'
        ? `[hercules] pr-merge: squash-merged ${task.id} factory PR on GitHub — not MergeService`
        : `[hercules] pr-merge: squash-merged ${task.id} factory PR on GitHub — awaiting observe`,
    );
    return true;
  }

  /** Bind a stored PR URL; factory tasks skip the hercules/<id> head check. */
  private taskPrInput(task: Task, repo: RepoConfig, prUrl: string): taskPr.TaskPrInput {
    return {
      prUrl,
      taskId: task.id,
      repo,
      ...(this.gh ? { gh: this.gh } : {}),
      ...(isRemoteFactoryPrIdentity({
        taskAdapter: task.adapter,
        repoAdapter: repo.adapter,
      })
        ? { remoteFactoryPr: true }
        : {}),
    };
  }

  /** Persist pr_status when GitHub reports a terminal lifecycle change. */
  private async applyPrStatusIfChanged(
    task: Task,
    status: PrStatus | null,
    mergeCommitSha: string | null = null,
  ): Promise<boolean> {
    if (!status) return false;
    // Never reopen a terminal status from a flaky summary.
    if ((task.prStatus === 'merged' || task.prStatus === 'closed') && status === 'open') {
      return false;
    }
    return this.applyPrLifecycleUpdate(
      task,
      status,
      mergeCommitSha,
      `hercules: ${task.id} pr → ${status}`,
    );
  }

  /**
   * Idempotent PR lifecycle + merge provenance (syncOpenPrStatuses + prSummary).
   * Never invents a merge SHA; never overwrites an existing merged_sha.
   * When status is merged + review, advances to done (endedAt preserved if set).
   */
  private async applyPrLifecycleUpdate(
    task: Task,
    status: PrStatus | null,
    mergeCommitSha: string | null = null,
    message = `hercules: pr status sync (${task.id})`,
  ): Promise<boolean> {
    if (!status) return false;
    // Never reopen a terminal status from a flaky summary.
    if ((task.prStatus === 'merged' || task.prStatus === 'closed') && status === 'open') {
      return false;
    }

    let next: Task = { ...task };
    let changed = false;

    if (status !== task.prStatus) {
      next = { ...next, prStatus: status };
      changed = true;
    }

    if (status === 'merged') {
      const hasSha = typeof task.mergedSha === 'string' && task.mergedSha.length > 0;
      if (!hasSha && mergeCommitSha) {
        next = { ...next, mergedSha: mergeCommitSha, mergedVia: 'operator' };
        changed = true;
      }

      if (next.state === 'review') {
        let canDone = true;
        try {
          assertTransition(next.state, 'done');
        } catch {
          canDone = false;
        }
        if (canDone) {
          const stamp = new Date().toISOString();
          next = {
            ...next,
            state: 'done',
            prStatus: 'merged',
            endedAt: next.endedAt ?? stamp,
            lastEventAt: stamp,
          };
          changed = true;
          console.error(
            `[hercules] pr-merged: ${task.id} review → done (PR merged on GitHub)`,
          );
        }
      }
    }

    if (!changed) return false;
    await mutateControl(this.control, { writeTasks: [{ expected: task, next }] }, message);
    return true;
  }

  /**
   * Remote Control chat for a task:
   *   - review / failed / done → steer (resume session; done updates open PR branch)
   *   - todo / retrying → set pendingSteer (dispatches on next tick; resumes if session)
   *   - in_progress → not handled here (runtime queues via Orchestrator.queueTaskChat)
   *
   * Optional `clientMessageId` makes retries of the same submission idempotent
   * (no second Human steer section / pending_steer overwrite).
   */
  async chat(
    id: string,
    message: string,
    opts?: { readonly clientMessageId?: string | null },
  ): Promise<{
    task: Task;
    mode: 'steer' | 'pending' | 'duplicate';
    reason?: string;
    priorMode?: ChatPriorMode;
  }> {
    if (!isValidIdentifier(id)) throw new ActionError(`unsafe task id '${id}'`);
    const text = message.trim();
    if (text.length === 0) throw new ActionError('message is required');
    if (text.length > 8000) throw new ActionError('message too long (max 8000 chars)');
    const clientMessageId = normalizeClientMessageId(opts?.clientMessageId ?? null);

    const snapshot = await this.control.read();
    const task = snapshot.tasks.find((t) => t.id === id);
    if (!task) throw new ActionError(`unknown task '${id}'`);

    const idem = decideChatIdempotency({
      text,
      clientMessageId,
      deliveredIds: [],
      queue: [],
      pendingSteer: task.pendingSteer,
      body: task.body,
      // Actions path is never inside a live run (API routes in_progress to queue).
      legacyTextGuard: false,
    });
    if (idem.action === 'duplicate') {
      return {
        task,
        mode: 'duplicate',
        reason: idem.reason,
        priorMode: idem.priorMode,
      };
    }

    if (task.state === 'review' || task.state === 'failed' || task.state === 'done') {
      const steered = await this.steer(id, text, { clientMessageId });
      return { task: steered, mode: 'steer' };
    }
    if (task.state === 'todo' || task.state === 'retrying') {
      const stamp = new Date().toISOString();
      const section = formatHumanSteerSection({
        stamp,
        text,
        clientMessageId,
        taskId: id,
      });
      const next: Task = {
        ...task,
        pendingSteer: text,
        body: `${task.body.trim()}\n\n${section}`,
      };
      await mutateControl(this.control, { writeTasks: [{ expected: task, next }] }, `hercules: ${id} chat pending`);
      return { task: next, mode: 'pending' };
    }
    throw new ActionError(
      `chat not available in state '${task.state}' (use live queue while running)`,
    );
  }

  /** any active state → cancelled (the loop tears down a running agent). */
  async cancel(id: string, opts?: {
    readonly source?: 'human_ui' | 'human_api' | 'agent' | 'daemon_safety' | 'external_state' | 'unknown';
    readonly reasonCode?: string;
    readonly message?: string;
  }): Promise<Task> {
    const snapshot = await this.control.read();
    const task = snapshot.tasks.find((t) => t.id === id);
    if (!task) throw new ActionError(`unknown task '${id}'`);
    const endedAt = task.state === 'in_progress' ? new Date().toISOString() : task.endedAt;
    const stamped = stampCancellationFields(task, 'cancel', {
      source: opts?.source ?? 'human_api',
      hadActiveSession: task.state === 'in_progress' || Boolean(task.agentSession),
      lifecyclePhase: task.state === 'in_progress' ? 'agent_running' : 'unknown',
      message: opts?.message ?? 'Operator cancel',
      reasonCode: opts?.reasonCode ?? 'human_cancel',
    });
    return this.transition(id, 'cancelled', {
      body: stamped.body,
      ...(endedAt ? { endedAt } : {}),
    });
  }

  /**
   * Explicit clean-salvage fork: create a new task stamped from a terminal
   * failed or cancelled task's preserved branch tip. No automatic cross-task adoption —
   * operator must call this action. Source branch is never moved/deleted.
   *
   * Order (audit-before-mutation): pure validate → read-only tip resolve →
   * build/validate body (protected paths) → control write+commit with
   * durable salvageSourceSha. Target branch is **not** created here; first
   * orchestrator provision uses seedFromSha.
   */
  async salvageFork(sourceId: string, input: SalvageForkInput = {}): Promise<Task> {
    if (!isValidIdentifier(sourceId)) {
      throw new ActionError(`unsafe source task id '${sourceId}'`);
    }
    const snapshot = await this.control.read();
    const source = snapshot.tasks.find((t) => t.id === sourceId);
    if (!source) throw new ActionError(`unknown source task '${sourceId}'`);

    const existing = new Set(snapshot.tasks.map((t) => t.id));
    const title =
      (input.title?.trim() && input.title.trim().length > 0
        ? input.title.trim()
        : `Salvage: ${source.title}`) || `Salvage ${sourceId}`;

    let targetId: string;
    if (input.id !== undefined) {
      if (!isValidIdentifier(input.id)) {
        throw new ActionError(`unsafe target task id '${input.id}'`);
      }
      targetId = input.id;
    } else {
      targetId = uniqueId(slugify(title), existing);
    }

    // Pre-IO pure checks (ids / state / task-file collision) — no branch fiction.
    const pure = validateSalvageForkRequest({
      sourceId,
      targetId,
      sourceRepo: source.repo,
      targetRepo: source.repo,
      sourceState: source.state,
      targetExists: existing.has(targetId),
    });
    if (!pure.ok) throw new ActionError(pure.reason);

    const repoCfg = snapshot.repos.repos[source.repo];
    if (!repoCfg) throw new ActionError(`unknown repo '${source.repo}'`);

    // Keep the workspaces receiver — do not extract then call unbound
    // (same pattern as preservedTipStatus / merge hooks).
    const ws = this.reverifyDeps?.workspaces;
    if (!ws?.resolveSalvageSourceTip) {
      throw new ActionError(
        'clean salvage fork requires workspace tip resolve (not available)',
      );
    }

    // Successful read-only resolve + full SHA is the branch-presence evidence.
    // Never invent branch presence without a real probe/resolve result.
    let sourceSha: string;
    try {
      const result = await ws.resolveSalvageSourceTip(repoCfg, sourceId, targetId);
      sourceSha = result.sourceSha;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ActionError(msg);
    }
    if (!/^[0-9a-f]{40}$/i.test(sourceSha)) {
      throw new ActionError(`resolve returned non-full SHA '${sourceSha}'`);
    }

    const stampedAt = new Date().toISOString();
    const body = buildSalvageForkBody({
      sourceTaskId: sourceId,
      sourceSha,
      stampedAt,
      sourceBody: source.body,
      ...(input.body !== undefined ? { operatorBody: input.body } : {}),
    });

    // Protected-path fail-fast on the product brief (same as createTask).
    // Must run before control write — and resolve never created a branch.
    const protectedPaths = await this.loadProtectedPaths(repoCfg);
    const protectedMentions = findProtectedPathMentions(body, protectedPaths);
    if (protectedMentions.length > 0) {
      throw new ActionError(formatProtectedPathBlockMessage(protectedMentions), {
        code: 'protected_path',
        paths: protectedMentions,
        rule: PROTECTED_PATH_CREATE_RULE,
      });
    }

    const autoPlanGate = !hasCheckableCriteria(body);
    const planPending = autoPlanGate;
    const labels = [...(input.labels ?? [])];
    if (planPending && !labels.some((l) => l.toLowerCase() === 'needs-plan')) {
      labels.push('needs-plan');
    }
    if (!labels.some((l) => l.toLowerCase() === 'salvage-fork')) {
      labels.push('salvage-fork');
    }

    const gateNote = autoPlanGate
      ? '\n\n## Plan gate (auto)\n' +
        'No checkable acceptance criteria found (SPEC §9.4) — held for human ' +
        'sign-off before any agent runs. Add an `## Acceptance criteria` ' +
        'section and then **Approve plan**.\n'
      : '';

    const task: Task = {
      id: targetId,
      title,
      repo: source.repo,
      state: 'todo',
      priority: input.priority ?? source.priority,
      blockedBy: [],
      labels,
      adapter: parseAdapterField(input.adapter, true),
      agentSession: null,
      pendingSteer: null,
      attempts: 0,
      lastEventAt: null,
      createdAt: stampedAt,
      startedAt: null,
      endedAt: null,
      prUrl: null,
      prStatus: null,
      planPending,
      ...(planPending ? { planPendingReason: PLAN_PENDING_REASON } : {}),
      // Coding default — host/deploy salvage is out of scope for this path.
      executionClass: DEFAULT_EXECUTION_CLASS,
      hostCommandScope: null,
      hostApprovedAt: null,
      hostExecutionStartedAt: null,
      salvageSourceTask: sourceId,
      salvageSourceSha: sourceSha.toLowerCase(),
      body: `${body}${gateNote}`,
    };

    // Durable audit first — branch creation is deferred to provision.
    // If commit throws or returns committed:false after write, roll back the
    // uncommitted target file so the daemon cannot dispatch unaudited metadata.
    try {
      const result = await mutateControl(this.control, { writeTasks: [{ expected: null, next: task }] },
        `hercules: salvage-fork ${targetId} from ${sourceId} @ ${sourceSha.slice(0, 12)}`,
      );
      if (!result.committed) {
        throw new ActionError(
          `salvage-fork commit returned committed:false for '${targetId}'`,
        );
      }
    } catch (err) {
      if (!this.control.mutateCommitted) await this.control.deleteTask(targetId);
      const commitMsg = err instanceof Error ? err.message : String(err);
      throw new ActionError(
        `salvage-fork commit failed; atomic mutation rolled back '${targetId}': ${commitMsg}`,
      );
    }
    return task;
  }

  /**
   * Open a platform-remediation causal chain for a terminal-failed task, or
   * record bootstrap escalation when the source is already a remediation task
   * (recursive self-remediation is refused). Causal link is **not** blocked_by.
   */
  async requestPlatformRemediation(
    sourceId: string,
    input: PlatformRemediationRequestInput,
  ): Promise<{
    readonly mode: 'open_chain' | 'bootstrap_escalation';
    readonly original: Task;
    readonly remediation: Task | null;
  }> {
    if (!isValidIdentifier(sourceId)) {
      throw new ActionError(`unsafe source task id '${sourceId}'`);
    }
    const snapshot = await this.control.read();
    const source = snapshot.tasks.find((t) => t.id === sourceId);
    if (!source) throw new ActionError(`unknown source task '${sourceId}'`);

    const existing = new Set(snapshot.tasks.map((t) => t.id));
    const kind: PlatformRemediationKind = input.kind;
    const stampedAt = new Date().toISOString();

    const preferredRepo =
      input.repo ??
      (snapshot.repos.repos['hercules'] ? 'hercules' : source.repo);
    if (!isValidIdentifier(preferredRepo)) {
      throw new ActionError(`unsafe remediation repo '${preferredRepo}'`);
    }
    const remediationRepoKnown = snapshot.repos.repos[preferredRepo] !== undefined;

    let remediationId: string;
    if (input.id !== undefined) {
      if (!isValidIdentifier(input.id)) {
        throw new ActionError(`unsafe remediation task id '${input.id}'`);
      }
      remediationId = input.id;
    } else {
      remediationId = uniqueId(slugify(`platform-${kind}-${sourceId}`), existing);
    }

    const pure = validatePlatformRemediationRequest({
      sourceId,
      remediationId,
      kind,
      sourceState: source.state,
      remediationExists: existing.has(remediationId),
      sourceAlreadyLinked: isPlatformRemediationOriginal(source),
      sourceIsRemediation: isPlatformRemediationTask(source),
      sourceAlreadyEscalated: source.bootstrapEscalation === true,
      remediationRepoKnown,
    });
    if (!pure.ok) throw new ActionError(pure.reason);

    if (pure.mode === 'bootstrap_escalation') {
      const originalId = source.platformRemediationOf!;
      const original = snapshot.tasks.find((t) => t.id === originalId);
      if (!original) {
        throw new ActionError(
          `bootstrap escalation: original task '${originalId}' is missing`,
        );
      }
      if (original.platformRemediationTask !== sourceId) {
        throw new ActionError(
          `bootstrap escalation: causal link mismatch (original points at '${original.platformRemediationTask ?? 'none'}')`,
        );
      }
      const stamp = stampBootstrapEscalation({
        externalAction: input.externalAction ?? '',
        recordedAt: stampedAt,
      });
      const section = buildBootstrapEscalationSection({
        originalTaskId: originalId,
        remediationTaskId: sourceId,
        kind: source.platformRemediationKind ?? kind,
        externalAction: stamp.remediation.bootstrapEscalationAction,
        recordedAt: stampedAt,
      });
      const nextRem: Task = {
        ...source,
        ...stamp.remediation,
        body: `${source.body.trimEnd()}\n\n${section}`,
      };
      const nextOrig: Task = {
        ...original,
        ...stamp.original,
        body: `${original.body.trimEnd()}\n\n${section}`,
      };
      // Production GitControlPort rejects bare writeTask/commit — atomic mutate only.
      const result = await mutateControl(
        this.control,
        {
          writeTasks: [
            { expected: source, next: nextRem },
            { expected: original, next: nextOrig },
          ],
        },
        `hercules: bootstrap-escalation ${sourceId} (of ${originalId})`,
      );
      if (!result.committed) {
        throw new ActionError(
          `bootstrap-escalation commit returned committed:false for '${sourceId}'`,
        );
      }
      return { mode: 'bootstrap_escalation', original: nextOrig, remediation: nextRem };
    }

    const chain = stampOpenChain({
      originalId: sourceId,
      remediationId,
      kind,
      recordedAt: stampedAt,
    });
    const title =
      (input.title?.trim() && input.title.trim().length > 0
        ? input.title.trim()
        : `Platform remediation (${kind}): ${source.title}`) ||
      `Platform remediation ${sourceId}`;
    const bodyCore =
      input.body !== undefined && input.body.trim().length > 0
        ? input.body.trim()
        : buildDefaultRemediationBody({
            originalId: sourceId,
            originalTitle: source.title,
            kind,
          });
    const remSection = buildPlatformRemediationSection({
      kind,
      remediationTaskId: remediationId,
      recordedAt: stampedAt,
      role: 'remediation',
      peerTaskId: sourceId,
    });
    const origSection = buildPlatformRemediationSection({
      kind,
      remediationTaskId: remediationId,
      recordedAt: stampedAt,
      role: 'original',
      peerTaskId: remediationId,
    });

    const repoCfg = snapshot.repos.repos[preferredRepo]!;
    const protectedPaths = await this.loadProtectedPaths(repoCfg);
    const protectedMentions = findProtectedPathMentions(bodyCore, protectedPaths);
    if (protectedMentions.length > 0) {
      throw new ActionError(formatProtectedPathBlockMessage(protectedMentions));
    }

    const labels = ['platform-remediation', kind];
    const remediationTask: Task = {
      id: remediationId,
      title,
      repo: preferredRepo,
      state: 'todo',
      priority: Math.max(0, (source.priority ?? 100) - 10),
      blockedBy: [],
      labels,
      adapter: null,
      agentSession: null,
      pendingSteer: null,
      attempts: 0,
      lastEventAt: null,
      createdAt: stampedAt,
      startedAt: null,
      endedAt: null,
      prUrl: null,
      prStatus: null,
      planPending: false,
      executionClass: DEFAULT_EXECUTION_CLASS,
      hostCommandScope: null,
      hostApprovedAt: null,
      hostExecutionStartedAt: null,
      ...chain.remediation,
      body: `${bodyCore}\n\n${remSection}`,
    };

    const nextOriginal: Task = {
      ...source,
      ...chain.original,
      body: `${source.body.trimEnd()}\n\n${origSection}`,
    };

    // Production GitControlPort rejects bare writeTask/commit — atomic mutate only
    // (same boundary as salvage-fork). mutateCommitted rolls back on failure.
    try {
      const result = await mutateControl(
        this.control,
        {
          writeTasks: [
            { expected: null, next: remediationTask },
            { expected: source, next: nextOriginal },
          ],
        },
        `hercules: platform-remediation ${remediationId} for ${sourceId} (${kind})`,
      );
      if (!result.committed) {
        throw new ActionError(
          `platform-remediation commit returned committed:false for '${remediationId}'`,
        );
      }
    } catch (err) {
      // Lightweight test ports without mutateCommitted: best-effort cleanup of
      // a half-applied fallback path. Production never reaches here mid-write.
      if (!this.control.mutateCommitted) {
        try {
          await this.control.deleteTask(remediationId);
        } catch {
          /* ignore */
        }
        try {
          await this.control.writeTask(source);
        } catch {
          /* ignore */
        }
      }
      const commitMsg = err instanceof Error ? err.message : String(err);
      if (err instanceof ActionError) throw err;
      throw new ActionError(
        `platform-remediation commit failed for '${remediationId}': ${commitMsg}`,
      );
    }
    return {
      mode: 'open_chain',
      original: nextOriginal,
      remediation: remediationTask,
    };
  }

  /**
   * After a remediation task reaches a terminal state, stamp the original's
   * resumed outcome. Idempotent; refuses mismatched causal links.
   */
  async syncPlatformRemediationOutcome(remediationId: string): Promise<Task | null> {
    if (!isValidIdentifier(remediationId)) {
      throw new ActionError(`unsafe task id '${remediationId}'`);
    }
    const snapshot = await this.control.read();
    const rem = snapshot.tasks.find((t) => t.id === remediationId);
    if (!rem || !isPlatformRemediationTask(rem)) return null;
    const original = snapshot.tasks.find((t) => t.id === rem.platformRemediationOf!) ?? null;
    if (rem.bootstrapEscalation === true && original) {
      if (original.platformRemediationResumedOutcome === 'bootstrap_escalation') {
        return original;
      }
      if (original.platformRemediationTask !== rem.id) return null;
      const next: Task = {
        ...original,
        platformRemediationResumedOutcome: 'bootstrap_escalation',
      };
      const result = await mutateControl(
        this.control,
        { writeTasks: [{ expected: original, next }] },
        `hercules: ${original.id} platform-remediation → bootstrap_escalation`,
      );
      if (!result.committed) {
        throw new ActionError(
          `platform-remediation outcome commit returned committed:false for '${original.id}'`,
        );
      }
      return next;
    }
    const plan = planResumedOutcomeUpdate({ remediation: rem, original });
    if (!plan || !original) return null;
    const next: Task = {
      ...original,
      platformRemediationResumedOutcome: plan.resumedOutcome,
    };
    const result = await mutateControl(
      this.control,
      { writeTasks: [{ expected: original, next }] },
      `hercules: ${original.id} platform-remediation → ${plan.resumedOutcome}`,
    );
    if (!result.committed) {
      throw new ActionError(
        `platform-remediation outcome commit returned committed:false for '${original.id}'`,
      );
    }
    return next;
  }

  /**
   * failed / retrying / cancelled → todo, resetting attempts for a clean retry.
   * Preserves task branch + body audit history. Never resurrects deleted tasks
   * (deleted→todo is restore, not Retry). After `agent_exit` with a retained
   * `agent_session`, clear the session so the next dispatch is fresh (poisoned
   * grok `--resume` thrashed otherwise).
   */
  async retry(id: string): Promise<Task> {
    if (!isValidIdentifier(id)) throw new ActionError(`unsafe task id '${id}'`);
    const snapshot = await this.control.read();
    const task = snapshot.tasks.find((t) => t.id === id);
    if (!task) throw new ActionError(`unknown task '${id}'`);
    if (task.state === 'deleted') {
      throw new ActionError(
        `task '${id}' is deleted; use restore, not Retry`,
      );
    }
    if (
      task.state !== 'failed' &&
      task.state !== 'retrying' &&
      task.state !== 'cancelled'
    ) {
      throw new ActionError(
        `task '${id}' Retry only from failed/retrying/cancelled (got ${task.state})`,
      );
    }
    const abandon = shouldAbandonSessionOnRetry({
      agentSession: task.agentSession,
      body: task.body,
    });
    if (!abandon) {
      return this.transition(id, 'todo', { attempts: 0, lastEventAt: null });
    }
    const prior = (task.agentSession ?? '').trim();
    const stamp = new Date().toISOString();
    const note = formatAbandonSessionNote(prior, stamp);
    return this.transition(id, 'todo', {
      attempts: 0,
      lastEventAt: null,
      agentSession: null,
      body: `${task.body.trimEnd()}\n\n${note}`,
    });
  }

  /**
   * Soft-delete → `deleted` trash (default), or hard-purge when already deleted
   * / `hard: true`. Cleanup closes sessions + worktree/PR/screenshots.
   * Trash is hard-purged after HERCULES_AUTO_DELETE_DAYS (default 30), each
   * task from its own soft-delete `endedAt`.
   */
  async deleteTask(
    id: string,
    opts?: {
      readonly cleanup?: boolean;
      readonly reason?: 'human' | 'auto';
      /** Force remove file immediately (default: soft-delete to `deleted`). */
      readonly hard?: boolean;
    },
  ): Promise<{ deleted: string; cleanup: boolean; notes: readonly string[]; soft?: boolean }> {
    if (!isValidIdentifier(id)) throw new ActionError(`unsafe task id '${id}'`);
    const snapshot = await this.control.read();
    const task = snapshot.tasks.find((t) => t.id === id);
    if (!task) throw new ActionError(`unknown task '${id}'`);
    if (!isDeletableState(task.state)) {
      throw new ActionError('cancel the running task first');
    }
    const cleanup = opts?.cleanup !== false;
    const hard = opts?.hard === true || task.state === 'deleted' || opts?.reason === 'auto';
    const notes: string[] = [];
    // Sessions first — stop ACP / free chat before wiping the worktree they use.
    const closer = this.cleanupDeps?.closeSessionsForTask;
    if (closer) {
      try {
        const closed = await closer(id);
        if (closed.length > 0) {
          notes.push(`sessions closed: ${closed.join(', ')}`);
        }
      } catch (err) {
        notes.push(`session close failed: ${(err as Error).message.slice(0, 80)}`);
      }
    }
    if (cleanup) {
      notes.push(
        ...(await this.cleanupTaskArtifacts(
          task,
          snapshot.repos.repos[task.repo] ?? null,
        )),
      );
    }

    if (!hard && canSoftDelete(task.state)) {
      const stamp = new Date().toISOString();
      await this.transition(id, 'deleted', {
        endedAt: stamp,
        lastEventAt: stamp,
        agentSession: null,
        pendingSteer: null,
      });
      notes.push('moved to Deleted (soft)');
      return { deleted: id, cleanup, notes, soft: true };
    }

    const who = opts?.reason === 'auto' ? 'auto-retention' : 'human';
    await mutateControl(this.control, { deleteTaskIds: [id] },
      `hercules: delete ${id} (${who}${cleanup ? ', cleanup' : ''})`,
    );
    return { deleted: id, cleanup, notes, soft: false };
  }

  /** Restore a soft-deleted task back to the queue. */
  async restoreTask(id: string): Promise<Task> {
    return this.transition(id, 'todo', {
      attempts: 0,
      lastEventAt: null,
      endedAt: null,
      agentSession: null,
      pendingSteer: null,
    });
  }

  /**
   * Hard-purge tasks in **Deleted** past retention, each from its own soft-delete time.
   */
  async purgeExpiredTerminal(opts?: {
    readonly nowMs?: number;
    readonly retentionMs?: number;
  }): Promise<{ readonly purged: readonly string[]; readonly retentionMs: number }> {
    const retentionMs =
      opts?.retentionMs ??
      this.cleanupDeps?.autoDeleteRetentionMs ??
      DEFAULT_AUTO_DELETE_DAYS * 24 * 60 * 60 * 1000;
    if (retentionMs <= 0) return { purged: [], retentionMs };
    const nowMs = opts?.nowMs ?? Date.now();
    const snapshot = await this.control.read();
    const due = snapshot.tasks.filter((t) => isDueForAutoDelete(t, nowMs, retentionMs));
    const purged: string[] = [];
    for (const t of due) {
      try {
        await this.deleteTask(t.id, { cleanup: true, reason: 'auto', hard: true });
        purged.push(t.id);
      } catch (err) {
        console.error(
          `[hercules] auto-delete ${t.id} failed: ${(err as Error).message.slice(0, 120)}`,
        );
      }
    }
    if (purged.length > 0) {
      console.error(
        `[hercules] auto-purge Deleted (${Math.round(retentionMs / 86_400_000)}d): ${purged.join(', ')}`,
      );
    }
    return { purged, retentionMs };
  }

  /**
   * Worktree / optional-screenshot GC for terminal tasks past retention.
   * Safe: never deletes remote branches, local salvage branches, or control-repo
   * history. Always emits one operator log line (dry-run or apply).
   */
  async runWorktreeGc(opts?: {
    readonly nowMs?: number;
    readonly retentionMs?: number;
    readonly dryRun?: boolean;
    readonly purgeScreenshots?: boolean;
    readonly keep?: ReadonlySet<string>;
  }): Promise<GcTerminalArtifactsResult | { readonly disabled: true; readonly logLine: string }> {
    const retentionMs =
      opts?.retentionMs ??
      this.cleanupDeps?.worktreeGcRetentionMs ??
      DEFAULT_WORKTREE_GC_DAYS * 24 * 60 * 60 * 1000;
    const dryRun = opts?.dryRun ?? this.cleanupDeps?.worktreeGcDryRun ?? false;
    const purgeScreenshots =
      opts?.purgeScreenshots ?? this.cleanupDeps?.worktreeGcPurgeScreenshots ?? false;
    const retentionDays = retentionMs > 0 ? Math.round(retentionMs / 86_400_000) : 0;

    if (retentionMs <= 0) {
      const logLine = `[hercules] worktree-gc disabled retention=0d`;
      console.error(logLine);
      return { disabled: true, logLine };
    }

    const nowMs = opts?.nowMs ?? Date.now();
    const snapshot = await this.control.read();
    const targets = selectWorktreeGcTargets(snapshot.tasks, nowMs, retentionMs);
    const keep =
      opts?.keep ?? this.cleanupDeps?.worktreeGcKeep?.() ?? new Set<string>();

    // Keep the receiver — extracting the method loses `this` (real
    // GitWorkspaces reads this.live; production sweeps threw for days, 2026-07-24).
    const gcHost = this.cleanupDeps?.workspaces;
    if (!gcHost?.gcTerminalArtifacts) {
      // No isolation layer (fake mode): still log a dry-run-style digest of
      // policy candidates so ops sees the would-be set.
      const ids = targets.map((t) => t.taskId);
      const logLine =
        `[hercules] worktree-gc ${dryRun ? 'dry-run' : 'apply'} retention=${retentionDays}d ` +
        `candidates=${targets.length} worktrees=[${ids.length ? ids.join(',') : '(none)'}] ` +
        `screenshots=[(none)] (no workspace GC hook)`;
      console.error(logLine);
      return {
        dryRun,
        worktreesRemoved: dryRun ? ids : [],
        screenshotsRemoved: [],
        skippedLive: [],
        logLine,
      };
    }

    return gcHost.gcTerminalArtifacts(targets, {
      dryRun,
      purgeScreenshots,
      ...(this.cleanupDeps?.screenshotsRoot
        ? { screenshotsRoot: this.cleanupDeps.screenshotsRoot }
        : {}),
      keep,
      retentionDays,
    });
  }

  /** Best-effort PR close + branch/worktree/screenshot wipe (never throws). */
  private async cleanupTaskArtifacts(
    task: Task,
    repo: RepoConfig | null,
  ): Promise<string[]> {
    const notes: string[] = [];
    // 1) Close open PR + prefer --delete-branch
    if (task.prUrl && task.prStatus === 'open') {
      if (!repo) {
        notes.push(`pr close failed: unknown repo '${task.repo}'`);
      } else {
        try {
          const closed = await taskPr.closeBoundGithubPr(
            this.taskPrInput(task, repo, task.prUrl),
          );
          notes.push(closed);
        } catch (err) {
          notes.push(`pr close failed: ${(err as Error).message.slice(0, 120)}`);
        }
      }
    } else if (task.prUrl) {
      notes.push(`pr left as ${task.prStatus ?? 'linked'} (not open)`);
    }
    // 2) Local worktree + branch
    const ws = this.cleanupDeps?.workspaces;
    if (ws) {
      try {
        if (ws.purgeTask) await ws.purgeTask(task.repo, task.id);
        else await ws.remove(task.id);
        notes.push('worktree/branch purged');
      } catch (err) {
        notes.push(`workspace purge failed: ${(err as Error).message.slice(0, 80)}`);
      }
    }
    // 3) Screenshots evidence store
    const shotsRoot = this.cleanupDeps?.screenshotsRoot;
    if (shotsRoot) {
      try {
        const { rm } = await import('node:fs/promises');
        const { join } = await import('node:path');
        await rm(join(shotsRoot, task.id), { recursive: true, force: true });
        notes.push('screenshots removed');
      } catch (err) {
        notes.push(`screenshots: ${(err as Error).message.slice(0, 60)}`);
      }
    }
    return notes;
  }

  /** Apply and persist a validated, human-driven state transition. */
  async transition(
    id: string,
    to: TaskState,
    fields: Partial<Task> = {},
    actor: 'human' | 'auto-merge' = 'human',
  ): Promise<Task> {
    if (!isTaskState(to)) throw new ActionError(`invalid target state '${to}'`);
    const snapshot = await this.control.read();
    const task = snapshot.tasks.find((t) => t.id === id);
    if (!task) throw new ActionError(`unknown task '${id}'`);

    try {
      assertTransition(task.state, to);
    } catch (err) {
      if (err instanceof TransitionError) throw new ActionError(err.message);
      throw err;
    }

    const clearHostApproval =
      to === 'todo' && isHostMutatingClass(resolveExecutionClass(task));
    let next: Task = {
      ...task,
      ...fields,
      state: to,
      // Retry/reject/steer are not command approvals. Make the next host run
      // wait for an explicit fresh approval even when the scope is unchanged.
      ...(clearHostApproval
        ? {
            hostCommandScope: null,
            hostApprovedAt: null,
            hostExecutionStartedAt: null,
          }
        : {}),
    };
    if (next.agentSession === null && next.agentSessionAdapter != null) {
      next = { ...next, agentSessionAdapter: null };
    }
    await mutateControl(
      this.control,
      { writeTasks: [{ expected: task, next }] },
      `hercules: ${id} ${task.state} → ${to} (${actor})`,
    );
    return next;
  }

  /** Validate a URL is safe to hand to git; throws ActionError for unsafe input. */
  private safeUrl(url: string): void {
    try {
      assertSafeRepoUrl(url);
    } catch (err) {
      if (err instanceof RepoUrlError) throw new ActionError(err.message);
      throw err;
    }
  }

  /** Reachability check: repo is reachable, and if the remote has heads,
   *  the chosen default branch must be one of them (empty repo → accept). */
  private async checkReachable(url: string, defaultBranch: string): Promise<void> {
    let branches: string[];
    try {
      ({ branches } = await this.probe.probe(url));
    } catch (err) {
      if (err instanceof RepoProbeError) throw new ActionError(`repo not reachable: ${err.message}`);
      throw err;
    }
    if (branches.length > 0 && !branches.includes(defaultBranch)) {
      throw new ActionError(`default branch '${defaultBranch}' not found on ${url}`);
    }
  }

  async addRepo(input: AddRepoInput): Promise<RepoConfig> {
    const key = input.key.trim();
    if (!isValidIdentifier(key)) throw new ActionError(`unsafe repo key '${input.key}'`);
    const url = input.url.trim();
    const defaultBranch = input.defaultBranch.trim();
    if (url.length === 0) throw new ActionError('url is required');
    if (defaultBranch.length === 0) throw new ActionError('defaultBranch is required');

    const snapshot = await this.control.read();
    if (key in snapshot.repos.repos) throw new ActionError(`repo '${key}' already exists`);

    this.safeUrl(url);
    await this.checkReachable(url, defaultBranch);

    const repo: RepoConfig = {
      key,
      url,
      defaultBranch,
      workflow: input.workflow?.trim() || 'WORKFLOW.md',
      maxConcurrent: input.maxConcurrent ?? 1,
      adapter: parseAdapterField(input.adapter, /* required when present */ true),
      // New repos default to incomplete until WORKFLOW/gates are proven (SPEC §15).
      readiness: input.readiness === 'ready' ? 'ready' : 'incomplete',
      ...(input.executionPolicy !== undefined && input.executionPolicy !== null
        ? { executionPolicy: validatedExecutionPolicy(input.executionPolicy)! }
        : {}),
      ...(input.autoMerge !== undefined && input.autoMerge !== null
        ? { autoMerge: validatedAutoMergePolicy(input.autoMerge) }
        : {}),
    };
    if (repo.readiness === 'ready') {
      await this.assertGuardianReadyAllowed(repo);
    }
    await mutateControl(this.control, { repos: { repos: { ...snapshot.repos.repos, [key]: repo } } }, `hercules: add repo ${key} (human)`);
    return repo;
  }

  async editRepo(key: string, patch: EditRepoPatch): Promise<RepoConfig> {
    if (!isValidIdentifier(key)) throw new ActionError(`unsafe repo key '${key}'`);
    const snapshot = await this.control.read();
    const current = snapshot.repos.repos[key];
    if (!current) throw new ActionError(`unknown repo '${key}'`);

    const url = patch.url?.trim() ?? current.url;
    const defaultBranch = patch.defaultBranch?.trim() ?? current.defaultBranch;
    if (url.length === 0) throw new ActionError('url is required');
    if (defaultBranch.length === 0) throw new ActionError('defaultBranch is required');

    // Validate URL safety before any probe or write.
    this.safeUrl(url);

    // Re-probe only when the thing being verified changed.
    if (url !== current.url || defaultBranch !== current.defaultBranch) {
      await this.checkReachable(url, defaultBranch);
    }

    // adapter: omit → keep; null → clear override; string → set override.
    const adapter =
      patch.adapter === undefined
        ? current.adapter
        : parseAdapterField(patch.adapter, true);

    const readiness =
      patch.readiness === undefined
        ? current.readiness
        : patch.readiness === 'incomplete'
          ? 'incomplete'
          : 'ready';

    const repo: RepoConfig = {
      key, // immutable — changing the key would orphan its mirror/worktrees
      url,
      defaultBranch,
      workflow: patch.workflow?.trim() || current.workflow,
      maxConcurrent: patch.maxConcurrent ?? current.maxConcurrent,
      adapter,
      readiness,
      ...(current.cargoTargetDir ? { cargoTargetDir: current.cargoTargetDir } : {}),
      ...(current.ownerCheckouts ? { ownerCheckouts: current.ownerCheckouts } : {}),
      ...(patch.executionPolicy === undefined
        ? current.executionPolicy
          ? { executionPolicy: current.executionPolicy }
          : {}
        : patch.executionPolicy
          ? { executionPolicy: validatedExecutionPolicy(patch.executionPolicy)! }
          : {}),
      ...(patch.autoMerge === undefined
        ? current.autoMerge
          ? { autoMerge: current.autoMerge }
          : {}
        : patch.autoMerge
          ? { autoMerge: validatedAutoMergePolicy(patch.autoMerge) }
          : {}),
    };
    const currentGuardian =
      effectiveRepoExecutionPolicy(current.executionPolicy ?? null).profile === 'guardian';
    const projectedGuardian =
      effectiveRepoExecutionPolicy(repo.executionPolicy ?? null).profile === 'guardian';
    if (currentGuardian && !projectedGuardian && readiness === 'ready') {
      throw new ActionError(
        `Guardian policy cannot be removed while '${key}' remains ready; set readiness:incomplete in the same patch`,
      );
    }
    if (readiness === 'ready') {
      let check = await this.assertGuardianReadyAllowed(repo);
      if (current.readiness === 'incomplete' && check === null) {
        check = await this.checkRepoConfigReadiness(repo);
      }
      if (
        current.readiness === 'incomplete' &&
        check !== null &&
        !check.softOk &&
        patch.forceReady !== true
      ) {
        const failed = check.checks
          .filter((c) => !c.ok)
          .map((c) => `${c.id}: ${c.detail}`)
          .join('; ');
        throw new ActionError(
          `readiness soft-check failed for '${key}': ${failed}. Fix onboarding or pass forceReady:true to override.`,
        );
      }
    }
    await mutateControl(this.control, { repos: { repos: { ...snapshot.repos.repos, [key]: repo } } }, `hercules: edit repo ${key} (human)`);
    return repo;
  }

  async removeRepo(key: string): Promise<{ removed: string }> {
    if (!isValidIdentifier(key)) throw new ActionError(`unsafe repo key '${key}'`);
    const snapshot = await this.control.read();
    if (!(key in snapshot.repos.repos)) throw new ActionError(`unknown repo '${key}'`);
    const referencing = snapshot.tasks.filter((t) => t.repo === key);
    if (referencing.length > 0) {
      throw new ActionError(`${referencing.length} task(s) reference '${key}'; delete them first`);
    }
    const { [key]: _removed, ...rest } = snapshot.repos.repos;
    await mutateControl(this.control, { repos: { repos: rest } }, `hercules: remove repo ${key} (human)`);
    this.readinessJobs.delete(key);
    return { removed: key };
  }
}

/** Normalize optional adapter input; throws ActionError on unknown kind. */
function parseAdapterField(
  value: AdapterKind | null | undefined,
  _allowNull: boolean,
): AdapterKind | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && isAdapterKind(value)) return value;
  throw new ActionError(
    `unknown adapter '${String(value)}' (want ${ADAPTER_KINDS.join('|')})`,
  );
}

/** Create-time execution_class: omit/null → implement; unknown → error. */
function resolveCreateExecutionClass(
  value: ExecutionClass | null | undefined,
): ExecutionClass {
  if (value === undefined || value === null) return DEFAULT_EXECUTION_CLASS;
  if (typeof value === 'string' && isExecutionClass(value)) return value;
  throw new ActionError(
    `unknown execution_class '${String(value)}' (want explore|implement|verify|host_operation|deploy)`,
  );
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug.length > 0 ? slug : 'task';
}

/** `<n>-<slug>` (or bare `<n>`): monotonic number + short English slug. */
function generatedTaskId(
  title: string,
  slug: string | undefined,
  existing: ReadonlySet<string>,
): string {
  const n = nextTaskNumber(existing);
  const s = slug ?? shortSlug(title);
  return uniqueId(s.length > 0 ? `${n}-${s}` : String(n), existing);
}

function uniqueId(base: string, existing: ReadonlySet<string>): string {
  if (!existing.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!existing.has(candidate)) return candidate;
  }
}
