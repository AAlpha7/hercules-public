/**
 * Coordination layer — the orchestration loop (SPEC §7).
 *
 * Each tick: sync the control repo, rebuild the derived snapshot, reconcile the
 * runs we are tracking against it (complete / retry / detect stalls / tear down
 * terminal work), then select and dispatch eligible tasks within the caps.
 *
 * The loop is idempotent and stateless across restarts: the only durable state
 * is the control repo on disk. Local CLI runs re-dispatch. Cursor Cloud factory
 * runs persist the remote agent id and reattach — a coordinator restart must
 * not launch a second Cloud Agent.
 *
 * All side effects go through {@link ControlPort} and {@link AgentAdapter}, and
 * time comes from an injected clock — so the loop is fully deterministic and
 * testable without git, processes, or real timers.
 */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { hasOpenPr, isTerminalState, isValidIdentifier, type Task } from '../domain/task.js';
import type { TaskBranchLease } from '../domain/taskBranchLease.js';
import {
  appendTaskRefOwnershipPark,
  buildTaskRefOwnershipReceipt,
  observeTaskRefOwnership,
} from '../domain/taskRefPublication.js';
import { assertTransition, canTransition } from '../domain/stateMachine.js';
import {
  explainIneligible,
  formatSchedulingHoldDetail,
  PROVISION_BACKOFF_MAX_MS,
  provisionBackoffMs,
  schedulingHoldEquals,
  selectEligible,
  type ProvisionBackoff,
  type SchedulingHoldReason,
} from '../domain/scheduling.js';
import {
  firstUnsatisfiedDependency,
  resolveDependencyMode,
  toShaAncestryFact,
  type DependencyAncestryFacts,
} from '../domain/dependencyGate.js';
import {
  buildStuckReviewSteerHealSection,
  combinePendingChatMessages,
  extractReviewPacketContent,
  honorPendingSteerOnReview,
  isConcurrentAgentSwitch,
  isStuckReviewWithPendingSteer,
  shouldPreserveHumanRunState,
  STUCK_REVIEW_PENDING_STEER_MS,
  type CombinedPendingChat,
} from '../domain/runFinalize.js';
import {
  decideChatIdempotency,
  dedupeQueuePush,
  extractClientMessageIdsFromBody,
  extractChatDeliveryIdsFromBody,
  foldDrainedChatDelivery,
  formatHumanSteerSection,
  makeChatDeliveryId,
  normalizeClientMessageId,
  rememberDeliveredId,
  type PendingChatEntry,
} from '../domain/chatDelivery.js';

/** Control mutation did not land — pending-chat finalize must not ack. */
export class ControlNotDurableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlNotDurableError';
  }
}

/** Reviewer provider recovery could not safely clear its durable brake. */
export class ReviewerRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewerRecoveryError';
  }
}

/** Public shape of {@link Orchestrator.complete} (and chat-finalize branches). */
export type CompleteOutcome = {
  readonly noChanges: boolean;
  readonly outcome: 'review' | 'rework' | 'failed' | 'cancelled' | 'human' | 'scope_blocked';
};

const PATH_LEASE_SCOPE_BLOCKED_MARKER = '## Path-lease scope blocked';

/** Synthetic terminal run: resumes verification only, never invokes an implementer. */
class ReviewerRecoveryRun implements AgentRun {
  readonly sessionId = '';

  poll(now: number): ReturnType<AgentRun['poll']> {
    return { sessionId: '', status: 'done', lastEventAt: now };
  }

  activityLog(): readonly string[] {
    return ['reviewer provider recovered; resuming verification on exact candidate'];
  }

  finalMessage(): string {
    return '';
  }

  stop(): void {
    // No child process exists.
  }
}

/** Wrapper returned from {@link Orchestrator.withPendingChatFinalize} callbacks. */
type PendingChatFinalizeBag<T> = {
  readonly value: T;
  readonly durable: boolean;
};
import { resolveEffectiveCaps, type CapPair } from '../domain/dynamicCaps.js';
import {
  addUsage,
  buildCostCapFailureSection,
  buildCostCapSummary,
  entriesForTask,
  entriesForUtcDay,
  evaluateCostCaps,
  isDailyHardBlocked,
  isTaskHardBlocked,
  renderCostCapPacketSection,
  sumLedger,
  type CostCapSummary,
  type CostCapVerdict,
  type UsageLedgerEntry,
  type UsageSample,
} from '../domain/costCaps.js';
import {
  appendUsageReceipt,
  emptyCostLedger,
  isValidCostRunKey,
  makeUsageReceiptId,
  memoryCostLedgerDiagnostics,
  pruneCostLedger,
  receiptsToLedgerEntries,
  unavailableCostLedgerDiagnostics,
  type CostLedger,
  type CostLedgerDiagnostics,
  type UsageReceipt,
} from '../domain/costLedger.js';
import { CostLedgerStoreError, type CostLedgerStore } from '../control/costLedgerStore.js';
import { hostCommandTimeoutFromEnv, type OrchestratorConfig } from '../config.js';
import type { ControlSnapshot } from '../control/snapshot.js';
import type { MemAvailableReader } from '../control/meminfo.js';
import type {
  AgentAdapter,
  AgentRun,
  AgentStartInput,
  RunSnapshot,
  TokenUsage,
} from './adapter.js';
import {
  deathEvidenceBlob,
  isTransientAgentError,
  summarizeAgentDeath,
} from '../domain/agentDeath.js';
import { AgentRegistry } from './agentRegistry.js';
import {
  adapterNeedsLocalWorkspace,
  adapterOwnsLocalProcess,
  isAdapterKind,
  resolveAdapterChain,
  type AdapterKind,
} from '../domain/agents.js';
import {
  factoryPrArtifact,
  factoryPrFieldsOnFailure,
  factoryPrFromUrl,
  type FactoryPrArtifact,
} from '../domain/cursorCloud.js';
import {
  acceptObservedFactoryHead,
  buildFactoryObservedHeadSection,
  factoryLaunchNeedsObservedHead,
  resolveFactoryLaunchRef,
} from '../domain/factoryConflict.js';
import { factoryAttachAgentId } from '../domain/factoryAttach.js';
import { fetchBoundPrHeadProbe } from './taskPr.js';
import { defaultGhRunner, type GhRunner } from './openPr.js';
import { classifyProviderInfrastructureFailure } from '../domain/providerFailure.js';
import { ReviewerInfraError } from '../verification/reviewer.js';
import {
  buildReviewerInfrastructureReceipt,
  renderReviewerInfrastructureReceipt,
  redactReviewerInfrastructureDetail,
  reviewerProviderHealth,
  type ReviewerProviderHealth,
} from '../domain/reviewerInfrastructure.js';
import {
  HOST_OP_RECEIPT_HEADING,
  isHostMutatingClass,
  resolveExecutionClass,
} from '../domain/executionClass.js';
import {
  effectiveRepoExecutionPolicy,
  formatPolicyEnforceFailure,
  formatPolicyCapabilityReceipt,
  resolvePolicyAgainstAdapter,
} from '../domain/repoExecutionPolicy.js';
import {
  hasHostExecutionStartMarker,
  HOST_CANCEL_SETTLE_BOUND_MS,
  stampHostExecutionStart,
} from '../domain/hostExecutor.js';
import { redactDependencyRecoveryText } from '../domain/dependencyRecovery.js';
import {
  HostExecutorRun,
  startHostExecution,
} from './hostExecutor.js';
import {
  chooseAdapterWithFailover,
  DEFAULT_FAILOVER_WINDOW_MS,
  formatAdapterFailoverInboxLine,
  pruneExitsOutsideWindow,
  type ChooseAdapterWithFailoverResult,
} from '../domain/adapterFailover.js';
import { renderTeardownReport } from '../verification/teardownReport.js';
import { type Workspaces, NoopWorkspaces } from '../isolation/worktree.js';
import { assemblePrompt, assembleSteerPrompt } from './prompt.js';
import { parseWorkflow } from '../control/workflow.js';
import type { Verifier } from './verifier.js';
import {
  packetStatusLine,
  renderPacketMarkdownWithNonce,
} from '../verification/packet.js';
import { buildL3SteerMessage } from '../domain/reworkPolicy.js';
import {
  CLI_EVIDENCE_PACKET_AUTHORITY,
  neutralizeCliEvidenceStructure,
} from '../domain/cliEvidence.js';
import {
  neutralizeHerculesFenceLines,
  neutralizeUntrustedPacketText,
} from '../domain/packetNeutralize.js';
import { formatAttributedGateReworkRequirement } from '../domain/gateFailAttribution.js';
import type { ReviewPacket } from '../domain/verification.js';
import {
  createVerificationCancelReason,
  isHumanSteerVerificationCancel,
  isVerificationAborted,
  toVerificationRunMeta,
  VerificationAbortedError,
  type VerificationCancelReason,
  type VerificationPhase,
  type VerificationProgress,
  type VerificationRunMeta,
} from '../domain/verificationRun.js';
import { branchFor, remoteFactoryWorkspace, type Workspace } from '../domain/allocation.js';
import {
  appendProvisionDiscardNote,
  PROVISION_DISCARD_NOTE_AFTER,
  untrustedRemoteTipReason,
} from '../domain/provisionNote.js';
import type { RepoConfig, ReposConfig } from '../domain/repos.js';
import type { Release } from '../domain/release.js';
import type { WorkspaceSuccessionLedger } from '../domain/workspaceSuccession.js';
import {
  effectivePathWriterLimit,
  formatPathLeaseBlockMessage,
  pathLeasePolicyFor,
} from '../domain/taskPathLease.js';
import { isFirstTimeWorkflowBootstrap } from '../domain/taskPathLease.js';
import type { TaskPathLeaseStore } from '../isolation/taskPathLeaseStore.js';
import type { GuardianReadinessReceipt } from '../domain/guardianReadiness.js';
import { buildSalvageBrief } from '../domain/salvage.js';
import { pathLeaseDeclarationDigest } from '../control/pathLeaseDigest.js';
import { shouldEmitRateLimitedLog } from '../domain/hostExecutor.js';

/** Re-export for API/UI consumers. */
export type { VerificationRunMeta };
import {
  findProtectedPathMentions,
  formatProtectedPathBlockMessage,
  hasForceProtectedPath,
} from '../domain/protectedPaths.js';
import type { ReleaseReconciler } from './releaseReconciler.js';
import {
  adapterCrashHold,
  adapterCrashHolds,
  isSignalExitCode,
  recordAdapterCrash,
  type AdapterCrashState,
} from '../domain/adapterHealth.js';
import type { PromoteService } from './promoteService.js';
import { mutateControl } from './controlMutation.js';
import { runPermanentPathLeasePark } from './pathLeasePark.js';
import {
  buildAgentCrashSalvage,
  buildReworkAccountingLines,
  buildRunFailureSection,
  type RunFailureKind,
} from '../domain/runFailure.js';
import {
  classifyVerifyFailureKind,
  decideRetry,
  isRunFailureKind,
  type FailureKind,
} from '../domain/retryPolicy.js';
import {
  buildOnboardFailureTimeline,
  buildVerifyTimeline,
  renderRunTimelineSection,
} from '../domain/runTimeline.js';
import { appendMirrorBranchNotes } from '../domain/mirrorFetch.js';
import {
  cpuPctFromSamples,
  formatQuietProgressLine,
  QUIET_LONG_DIGEST_MS,
  shouldShowQuietProgress,
} from '../domain/aliveHint.js';
import { evaluateStall, resolveProcessAlive } from '../domain/stall.js';
import {
  evaluateDiskPressure,
  toDispatchHold,
  type DiskPressure,
  type DispatchHold,
} from '../domain/diskPressure.js';
import {
  formatCargoCachePruneEscalationLogLine,
  formatCargoCachePruneSkipNoDirsLogLine,
  formatCargoPruneBannerNote,
  resolveCargoTargetDirs,
  DEFAULT_CARGO_CACHE_RETAIN_DAYS,
} from '../domain/cargoCachePrune.js';
import {
  pruneCargoCacheTargets,
  type CargoCachePruneResult,
} from '../isolation/cargoCachePrune.js';
import {
  isOsProcessAlive,
  sampleProcessTreeHint,
  sampleProcessTreeStats,
} from '../adapters/processTree.js';
import { simpleGit } from 'simple-git';
import type { DependencyRewireChange } from '../domain/dependencyRewire.js';

/** How often to re-sample /proc for a worker name while a run is quiet. */
const ALIVE_HINT_REFRESH_MS = 5_000;

/** pending_steer text for L3 auto-steer rework (session resume). */
function buildAutoSteerFromPacket(packet: ReviewPacket): string {
  const v = packet.reviewerVerdict;
  if (v) return buildL3SteerMessage(v);
  // Mechanical-only rework should not hit steer path; still provide a fallback.
  const failed = packet.gates.filter((g) => !g.passed).map((g) => g.name);
  return buildL3SteerMessage({
    summary: failed.length > 0 ? `Fix failed gates: ${failed.join(', ')}` : 'Address verification failures',
    comments: [],
  });
}

/** The orchestrator's view of the control repo (dependency inversion). */
export interface ControlPort {
  /** Pull the latest control repo state (SPEC §7.1). */
  sync(): Promise<void>;
  /** Build the derived snapshot from disk (SPEC §7.2). */
  read(): Promise<ControlSnapshot>;
  /** Exact Git-versioned authority read used only by the optional M4 shadow bridge. */
  readVersionedTasks?(): Promise<{
    readonly revision: string;
    readonly tasks: readonly Task[];
  }>;
  /** Apply one ownership-scoped control mutation and audit exactly its paths. */
  mutateCommitted?(
    mutation: ControlMutation,
    message: string,
  ): Promise<{ committed: boolean; hash?: string }>;
  /** Legacy lightweight-port write; real GitControlPort fails closed. */
  writeTask(task: Task): Promise<void>;
  /** Atomically create and audit a previously absent task. */
  createTaskCommitted?(
    task: Task,
    message: string,
  ): Promise<{ committed: boolean; hash?: string }>;
  /** Atomically replace dependency metadata for a validated task batch. */
  rewireDependenciesCommitted?(
    changes: readonly DependencyRewireChange[],
    message: string,
  ): Promise<{ committed: boolean; hash?: string }>;
  /** Atomically validate a task binding, update it, and commit the audit entry. */
  compareAndSetTaskCommitted?(
    id: string,
    expected: {
      readonly state: Task['state'];
      readonly expectedBaseRevision: Task['expectedBaseRevision'] | undefined;
      readonly expectedRemoteTip: Task['expectedRemoteTip'] | undefined;
    },
    to: Task['state'],
    fields: Partial<Task>,
    message: string,
  ): Promise<{ readonly matched: boolean; readonly committed: boolean; readonly hash?: string }>;
  /** Legacy lightweight-port delete; real GitControlPort fails closed. */
  deleteTask(id: string): Promise<void>;
  /** Legacy lightweight-port commit; real GitControlPort fails closed. */
  commit(message: string): Promise<{ committed: boolean }>;
  /** Legacy lightweight-port repo write; real GitControlPort fails closed. */
  writeRepos(config: ReposConfig): Promise<void>;
  /**
   * Read `releases/<repoKey>.md` (null when absent). Optional — only needed
   * when the release reconciler is wired (release-4+).
   */
  readRelease?(repoKey: string): Promise<Release | null>;
  /** Persist a release file. Optional — see {@link readRelease}. */
  writeRelease?(release: Release): Promise<void>;
  /** Read the sealed, bounded post-merge receipt chain. */
  readSuccession?(repoKey: string): Promise<WorkspaceSuccessionLedger | null>;
  /** Legacy lightweight-port write; real GitControlPort requires mutateCommitted. */
  writeSuccession?(ledger: WorkspaceSuccessionLedger): Promise<void>;
}

export interface ControlMutation {
  readonly writeTasks?: readonly {
    /** Exact semantic value observed by the owner; null means must be absent. */
    readonly expected: Task | null;
    readonly next: Task;
  }[];
  readonly deleteTaskIds?: readonly string[];
  readonly repos?: ReposConfig;
  readonly writeReleases?: readonly Release[];
  readonly writeSuccessions?: readonly {
    readonly expected: WorkspaceSuccessionLedger | null;
    readonly next: WorkspaceSuccessionLedger;
  }[];
}

export interface OrchestratorDeps {
  readonly config: OrchestratorConfig;
  readonly control: ControlPort;
  /**
   * Multi-agent registry (preferred). Resolves per-repo `adapter` overrides at
   * dispatch time. When omitted, `adapter` (single) is wrapped via AgentRegistry.of.
   */
  readonly agents?: AgentRegistry;
  /** Single adapter (tests / simple wiring). Ignored when `agents` is set. */
  readonly adapter?: AgentAdapter;
  /** Workspace provisioning (SPEC §8). Defaults to a no-op for the fake adapter. */
  readonly workspaces?: Workspaces;
  /** Enable exact-lease stale candidate recovery before agent start. */
  readonly autoRebase?: boolean;
  /** Verification on done (SPEC §9). Omit to move straight to review (fake mode). */
  readonly verifier?: Verifier;
  /** ms since epoch. */
  readonly clock: () => number;
  /**
   * Optional MemAvailable reader (bytes). When `config.dynamicCaps` is enabled,
   * each dispatch resolves effective global/heavy caps from free memory.
   * Inject a fake in tests; production wires `/proc/meminfo`.
   */
  readonly memReader?: MemAvailableReader;
  /** Free/total bytes of the work filesystem (disk watermark; null = unknown). */
  readonly diskReader?: () => Promise<{ freeBytes: number; totalBytes: number } | null>;
  /**
   * Env `HERCULES_CARGO_TARGET_DIR` (comma/colon-separated absolute cargo
   * target roots). Combined with per-repo `cargo_target_dir` at prune time.
   */
  readonly cargoTargetEnv?: string | null;
  /** Retain window for large debug/deps (default 2). Env: HERCULES_CARGO_CACHE_RETAIN_DAYS. */
  readonly cargoCacheRetainDays?: number;
  /**
   * Injectable cargo-cache prune (tests). Default: isolation pruneCargoCacheTargets.
   * Returns total freed bytes across roots.
   */
  readonly pruneCargoCaches?: (
    dirs: readonly string[],
    opts: {
      readonly trigger: string;
      readonly retainDays: number;
      readonly pressureEscalation?: boolean;
      readonly force?: boolean;
    },
  ) => Promise<{ readonly freedBytes: number; readonly results: readonly CargoCachePruneResult[] }>;
  /**
   * Notified after each effective-cap resolution (for L2 heavy gate / logging).
   * Always receives the pair actually used for scheduling this tick.
   */
  readonly onEffectiveCaps?: (caps: CapPair) => void;
  /**
   * Optional release reconciler (staging deploy + verify + Release packet).
   * When wired, runs once per tick after dispatch for repos with deploy.staging.
   */
  readonly releaseReconciler?: ReleaseReconciler;
  /**
   * Optional production promote service. When wired, first tick finalizes any
   * in-flight `promoting_sha` (restart-safe self-promote, design §4).
   */
  readonly promoteService?: PromoteService;
  /**
   * Adapter provider failover on repeated agent_exit (default on).
   * Kill-switch: HERCULES_ADAPTER_FAILOVER=0.
   */
  readonly adapterFailoverEnabled?: boolean;
  /** Trusted-boundary durable accounting store. Omitted only by thin tests. */
  readonly costLedgerStore?: CostLedgerStore;
  /**
   * Durable repository path/writer leases (Guardian). When wired, dispatch
   * acquires before adapter spawn and teardown releases by run token.
   * Optional so pure unit tests stay free of disk.
   */
  readonly pathLeaseStore?: TaskPathLeaseStore;
  /** Restart/tick fail-closed check for persisted ready Guardian configs. */
  readonly guardianReadinessCheck?: (
    repo: RepoConfig,
  ) => Promise<GuardianReadinessReceipt>;
  /** Provider-specific read-only preflight used by operator recovery. */
  readonly reviewerHealthCheck?: (provider: AdapterKind) => Promise<boolean>;
  /**
   * Identity-bound `gh` for factory head observe at dispatch.
   * Tests inject a fake; production uses the default CLI runner.
   */
  readonly gh?: GhRunner;
  /**
   * Optional C3 verified-evidence intake at the successful-verify → review
   * transition. Staging failure is logged and never blocks the transition.
   */
  readonly verifiedEvidence?: {
    stage(input: {
      readonly task: { readonly id: string; readonly repo: string };
      readonly packet: ReviewPacket;
      readonly verifiedSha: string;
      readonly branch: string;
      readonly capturedAt: string;
    }): Promise<unknown>;
  };
}

/** Active adapter failover notice for phone banner / decision inbox. */
export interface AdapterFailoverNotice {
  readonly unhealthy: readonly string[];
  readonly detail: string;
  /** Substitute used for new dispatches when preferred is unhealthy. */
  readonly substitute?: string;
}

/** What happened during one tick — for logging, tests, and the future UI feed. */
export interface TickReport {
  readonly dispatched: string[];
  readonly completed: string[];
  readonly retried: string[];
  readonly failed: string[];
  readonly stalled: string[];
  readonly tornDown: string[];
  /** in_progress tasks with no live run (orphaned by a restart), re-queued. */
  readonly recovered: string[];
  readonly running: string[];
  /** Tasks parked early by thrash brake this tick (operator digest V5). */
  readonly thrashParked: string[];
  /** Task ids whose provisional workspace was discarded this tick (fail-closed). */
  readonly provisionDiscarded: string[];
  /** Live runs quiet >30m with processAlive (operator digest V5). */
  readonly quietLong: string[];
  /** Cumulative daemon-session counters (not persisted). */
  readonly sessionMetrics: {
    readonly thrashParks: number;
    readonly quietLongSightings: number;
  };
  /**
   * Repo keys whose staging deploy completed this tick (`ready` or `failed`).
   * Empty when the release reconciler is not wired.
   */
  readonly stagingReconciled: string[];
  /**
   * Repo keys whose in-flight promote was finalized this tick (ok or rolled_back).
   * Typically only on the first tick after boot.
   */
  readonly promotesFinalized: string[];
}

interface TrackedRun {
  readonly taskId: string;
  run: AgentRun;
  readonly workspace: Workspace;
  readonly repo: RepoConfig;
  /** Resolved adapter kind for this dispatch (task → repo → daemon → failover). */
  readonly adapterKind: string;
  /**
   * Operator note when this dispatch used failover or a pin-warn
   * (written into the run timeline dispatch detail).
   */
  readonly failoverNote: string | null;
  /** True when this dispatch resumed a prior session (comment-to-steer). */
  readonly isSteerResume: boolean;
  /**
   * pending_steer text consumed into this run's prompt (cleared on disk at
   * dispatch). Used for legacy exact-text idempotency during the live window.
   */
  readonly consumedSteerText: string | null;
  /** Client message ids embedded in the consumed steer / body for this run. */
  readonly consumedClientMessageIds: readonly string[];
  /** ms since epoch when this dispatch started (hard maxRunMs wall clock). */
  startedAtMs: number;
  /** Daemon-owned idempotency key; never a provider session id. */
  readonly costRunKey: string;
  /**
   * Original start input so same-round transient death can re-spawn once
   * without burning an attempt (xAI 502 mid-stream).
   */
  startInput: AgentStartInput;
  /** Full-context, no-resume input for one missing-session recovery. */
  readonly freshStartInput: AgentStartInput;
  /** Original provider id, retained only so terminal diagnostics can redact it. */
  readonly originalResumeSessionId: string | null;
  /** Bounded independently from generic transient retry. */
  sessionRecoveryAttempted: boolean;
  /** True after one same-round soft restart on transient agent death. */
  transientRetried: boolean;
  /** Live HEAD sha (updated on poll); for phone honesty mid-run. */
  branchTip: string | null;
  /** Cached process-tree worker name (throttled sample). */
  aliveHint: string | null;
  /** ms when aliveHint was last refreshed. */
  aliveHintAt: number;
  /** Previous cumulative jiffies sample for CPU% (quiet-period honesty). */
  procPrev: { jiffies: number; atMs: number } | null;
  /** Latest computed worker-tree CPU% (may exceed 100 on multi-core). */
  procCpuPct: number | null;
  /** Latest worker-tree RSS in MB. */
  procRssMb: number | null;
  /**
   * Path-lease run token acquired before adapter spawn. Present only when a
   * durable lease entry was written (not legacy no-op). Release requires match.
   */
  pathLeaseRunToken: string | null;
}

function redactKnownProviderSessions(
  value: string | undefined,
  sessionIds: readonly (string | null | undefined)[],
): string | undefined {
  if (value === undefined) return undefined;
  let redacted = value;
  for (const sessionId of new Set(sessionIds.filter((id): id is string => Boolean(id)))) {
    redacted = redacted.split(sessionId).join('[provider-session-redacted]');
  }
  return redacted;
}

/** Live run metadata overlaid on disk task (disk lags session/last_event). */
export interface LiveRunMeta {
  readonly taskId: string;
  readonly sessionId: string | null;
  readonly lastEventAt: string;
  readonly branchTip: string | null;
  readonly runKind: 'implementer' | 'steer';
  readonly activityLines: number;
  /** True when the agent child is still running (stream may be silent). */
  readonly processAlive: boolean;
  /** ms since last stream event. */
  readonly silenceMs: number;
  /** ms since this dispatch started. */
  readonly runMs: number;
  /** Hard wall-clock limit for this run (config.maxRunMs). */
  readonly maxRunMs: number;
  /** Best-effort child worker name (cargo / rustc / pnpm), when known. */
  readonly aliveHint: string | null;
  /** Worker-tree CPU% between the last two samples (quiet-period honesty). */
  readonly procCpuPct: number | null;
  /** Worker-tree RSS in MB. */
  readonly procRssMb: number | null;
  /**
   * Deterministic host executor overlay (host_operation / deploy only).
   * Never includes command env, full stdout, or secrets.
   */
  readonly hostCommandIndex?: number;
  readonly hostCommandTotal?: number;
  readonly hostCommandName?: string | null;
  readonly hostCommandTimeoutMs?: number;
}

/** Result of {@link Orchestrator.queueTaskChat} (queued vs idempotent duplicate). */
export interface QueueTaskChatResult {
  readonly mode: 'queued' | 'duplicate';
  readonly queued: readonly string[];
  readonly reason?: string;
  readonly priorMode?: 'pending' | 'steer' | 'queued' | 'delivered';
}

/** A consistent view of runtime state, shared with the HTTP server (SPEC §2). */
export interface RuntimeView {
  readonly snapshot: ControlSnapshot | null;
  readonly running: string[];
  /** Cancelled tasks winding down (SIGTERM sent, grace window not yet elapsed). */
  readonly stopping: string[];
  /** Recent activity lines per task id (live log, Task 1/2/3). Omits runs with none. */
  readonly activity: Record<string, readonly string[]>;
  /**
   * Human chat lines queued while a task is running (Remote Control).
   * On complete(), drained atomically into one bounded pending_steer.
   */
  readonly pendingChat: Record<string, readonly string[]>;
  /**
   * Mid-run honesty: session / last event / branch tip from memory (not disk).
   * Disk front matter often stays null until complete — phone must not look stuck.
   */
  readonly liveRuns: Record<string, LiveRunMeta>;
  /**
   * Live verification overlay (after agent exits, before review/rework).
   * Bounded phase/stage only — no command secrets or gate output.
   * Optional on the type for thin test mocks; orchestrator always fills it.
   */
  readonly verificationRuns?: Record<string, VerificationRunMeta>;
  readonly lastReport: TickReport | null;
  /** Wired agents: daemon default + available kinds (for the phone UI). */
  readonly agents: {
    readonly default: string;
    readonly available: readonly string[];
    readonly providerPolicy?: import('./agentRegistry.js').AgentProviderPolicy;
  };
  /** Free Remote Control sessions (optional — wired in main). */
  readonly sessions?: readonly import('../domain/session.js').RemoteSession[];
  /** Live activity for free sessions (session id → lines). */
  readonly sessionActivity?: Record<string, readonly string[]>;
  /**
   * Token/cost cap summary for Settings (daemon-session ledger; not persisted).
   * Orchestrator always fills this; optional on the type for thin test mocks.
   */
  readonly costSummary?: CostCapSummary;
  /**
   * Why dispatch is paused (exact reason from the same tick block that skips
   * dispatch). Null when feeding agents is allowed. Optional for thin mocks.
   */
  readonly dispatchHold?: DispatchHold | null;
  /**
   * Latest disk pressure reading (ok/warn/critical). SPA uses warn for amber
   * hint; critical also appears as {@link dispatchHold}. Optional for mocks.
   */
  readonly diskPressure?: DiskPressure | null;
  /**
   * After disk-warn auto-prune: phone banner fragment
   * (「已自动修剪, 释放 XG」). Null when no prune note this episode.
   */
  readonly diskPruneNote?: string | null;
  /**
   * Provider failover while some adapter is unhealthy in the window.
   * Decision-inbox system item; null when all healthy or failover disabled.
   */
  readonly adapterFailover?: AdapterFailoverNotice | null;
  /** Durable reviewer-provider health derived from task checkpoints. */
  readonly reviewerHealth?: readonly ReviewerProviderHealth[];
  /**
   * Per-task scheduling hold reasons for todo/retrying tasks not admitted
   * this tick. Empty when every queued task is eligible (or none queued).
   */
  readonly holds?: Readonly<Record<string, SchedulingHoldReason>>;
}

export type RuntimeListener = (view: RuntimeView) => void;

export class Orchestrator {
  private readonly tracked = new Map<string, TrackedRun>();
  /**
   * Cancelled runs in graceful wind-down: SIGTERM sent, workspace still held,
   * waiting for the process to exit or the deadline to force a SIGKILL (Plan 2a).
   * A stopping task has left {@link tracked}, so its cap slot is already freed.
   */
  private readonly stoppingRuns = new Map<
    string,
    {
      tracked: TrackedRun;
      deadline: number;
      forced: boolean;
      lastUsage?: TokenUsage;
      /**
       * When true (mid-run agent switch / re-queue), keep the worktree so the
       * next dispatch can continue on the same branch. Cancel discards.
       */
      preserveWorkspace: boolean;
    }
  >();
  /**
   * Active post-agent verification (L1/L2/L3). First-class cancelable phase —
   * human cancel must abort gate process groups, not wait for cargo to finish
   * (production incident 2026-07-31).
   */
  private readonly activeVerifications = new Map<
    string,
    {
      controller: AbortController;
      /** Shared AbortSignal.reason — force-abort flips force without re-abort. */
      cancelReason: VerificationCancelReason;
      startedAtMs: number;
      phase: VerificationPhase;
      stage: string;
      lastCompletedStage: string | null;
      processAlive: boolean;
      cancelRequested: boolean;
      forced: boolean;
    }
  >();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private lastSnapshot: ControlSnapshot | null = null;
  private lastReport: TickReport | null = null;
  private readonly listeners = new Set<RuntimeListener>();
  private readonly workspaces: Workspaces;
  private readonly agents: AgentRegistry;
  /** Orphan reclamation runs exactly once — on the first tick after (re)start. */
  private reclaimedOnce = false;
  /**
   * Rate-limit identical path-lease block diagnostics (soft + permanent park).
   * Fingerprint change emits immediately; same fingerprint only after window.
   */
  private readonly pathLeaseBlockLogRate = new Map<string, number>();
  /**
   * Consecutive provisional-workspace discards per task (same reason). Used to
   * surface a phone-visible note after PROVISION_DISCARD_NOTE_AFTER repeats.
   * Cleared on successful dispatch or when the task leaves todo / disappears.
   */
  private readonly provisionDiscards = new Map<string, { reason: string; count: number }>();
  /**
   * In-flight promote finalization runs once on first tick (restart-safe
   * self-promote, design §4).
   */
  private promotesFinalizedOnce = false;
  /** Last disk pressure level — log only on transitions, not every tick. */
  private lastDiskLevel: 'ok' | 'warn' | 'critical' = 'ok';
  /**
   * Per-task scheduling holds from the latest tick (todo/retrying not admitted).
   * Log lines emit only on appear / change / clear — not every tick.
   */
  private schedulingHolds: ReadonlyMap<string, SchedulingHoldReason> = new Map();
  /**
   * Never-started tasks whose dispatch failed while provisioning (C3.49):
   * held with exponential backoff instead of re-tried (and re-folded into the
   * body with a control commit) every tick. Cleared on a successful provision.
   */
  private readonly provisionBackoff = new Map<string, ProvisionBackoff>();
  /** C3.60: signal deaths per adapter — two distinct tasks open the breaker. */
  private adapterCrashes: AdapterCrashState = new Map();
  /**
   * Latest disk pressure (same tick evaluation that sets diskBlocked).
   * Surfaced on RuntimeView so the phone never sees a silent stuck queue.
   */
  private currentDiskPressure: DiskPressure | null = null;
  /**
   * Phone note after cargo auto-prune at disk warn (cleared when pressure → ok).
   */
  private diskPruneNote: string | null = null;
  /**
   * Once per pressure episode (warn/critical) — avoid readdir every 3s tick
   * after we already pruned. Reset when level returns to ok.
   * Set only after an actual prune attempt (dirs configured); empty config
   * must not latch (2026-07-30: operator add-config mid-episode).
   */
  private cargoPrunedThisPressureEpisode = false;
  /**
   * Skip tip for empty cargo_target_dir config — once per pressure episode
   * so we do not spam stderr every tick while still high.
   */
  private cargoEmptyConfigSkipLoggedThisEpisode = false;
  /**
   * Remote Control: human messages queued while a task is `in_progress`.
   * On *every* run finalization (review / L3 auto-rework / failed), the entire
   * queue is drained into one bounded pending_steer (order preserved) so N
   * messages force one requeue, not N verify cycles — and never vanish when
   * L3 schedules retrying.
   */
  private readonly pendingChat = new Map<string, PendingChatEntry[]>();
  /** Monotonic seq for {@link makeChatDeliveryId} (daemon-local instance keys). */
  private chatDeliverySeq = 0;
  /**
   * Bounded per-task ring of client message ids already accepted (pending,
   * queued, or delivered into a run). Complements durable body markers.
   */
  private readonly deliveredChatIds = new Map<string, string[]>();
  /** Daemon-session operator digest counters (reset on process restart). */
  private sessionThrashParks = 0;
  private sessionQuietLongSightings = 0;
  /** Task ids already counted for quiet-long this session (avoid tick spam). */
  private readonly quietLongSeen = new Set<string>();
  /** Committed adapter usage recovered from the durable receipt ledger. */
  private usageLedger: UsageLedgerEntry[] = [];
  private durableCostLedger: CostLedger = emptyCostLedger();
  private costLedgerDiagnostics: CostLedgerDiagnostics = memoryCostLedgerDiagnostics(0);
  private costLedgerLoaded = false;
  /** Mid-run cumulative usage per task (adapter absolute sample for current run). */
  private readonly liveUsage = new Map<string, UsageSample>();
  /** Soft-warn logged once per task per daemon session. */
  private readonly costSoftWarned = new Set<string>();
  /** Daily hard-block log once per UTC day key. */
  private dailyHardLoggedDay: string | null = null;
  /**
   * In-memory agent_exit timestamps per adapter (daemon session).
   * Sliding window applied at choose/record time; lost on process restart
   * (acceptable — unhealthy streak re-accumulates from live exits).
   */
  private adapterExitStamps: Partial<Record<string, number[]>> = {};
  /** Last substitute chosen while preferred was unhealthy (for inbox). */
  private lastFailoverSubstitute: AdapterKind | null = null;

  constructor(private readonly deps: OrchestratorDeps) {
    this.workspaces = deps.workspaces ?? new NoopWorkspaces(deps.config.controlRepoDir);
    if (deps.agents) {
      this.agents = deps.agents;
    } else if (deps.adapter) {
      this.agents = AgentRegistry.of(deps.adapter);
    } else {
      throw new Error('Orchestrator requires agents or adapter');
    }
  }

  private get adapterFailoverEnabled(): boolean {
    return this.deps.adapterFailoverEnabled !== false;
  }

  /** Record an agent_exit for provider health tracking. */
  private recordAdapterExit(adapter: string | undefined, atMs: number): void {
    if (!adapter || !isAdapterKind(adapter)) return;
    if (adapter === 'fake') return;
    const prev = this.adapterExitStamps[adapter] ?? [];
    this.adapterExitStamps[adapter] = [...prev, atMs];
    this.adapterExitStamps = pruneExitsOutsideWindow(
      this.adapterExitStamps,
      atMs,
      DEFAULT_FAILOVER_WINDOW_MS,
    );
  }

  /**
   * Resolve chain then apply failover for a **new** dispatch.
   * Task-explicit adapter is pinned (warn only).
   */
  private resolveDispatchAdapter(
    task: Task,
    repoAdapter: string | null | undefined,
    nowMs: number,
    repo?: RepoConfig | null,
  ): { kind: AdapterKind; decision: ChooseAdapterWithFailoverResult } {
    const requested = resolveAdapterChain({
      taskAdapter: task.adapter,
      ...(repoAdapter !== undefined ? { repoAdapter } : {}),
      defaultKind: this.agents.defaultKind,
    });
    const pinned =
      task.adapter !== null &&
      task.adapter !== undefined &&
      isAdapterKind(task.adapter);
    const executionPolicy = effectiveRepoExecutionPolicy(repo?.executionPolicy ?? null);
    const decision = chooseAdapterWithFailover({
      requested,
      recentExitsByAdapter: this.adapterExitStamps,
      available: this.agents.available(),
      nowMs,
      enabled: this.adapterFailoverEnabled,
      pinned,
      // Never fail over onto an adapter that cannot enforce the repo policy
      // (Guardian sandbox_unsupported was a silent capability gap, 2026-08).
      isPolicyCompatible: (kind) => resolvePolicyAgainstAdapter(kind, executionPolicy).ok,
    });
    if (decision.failedOver && isAdapterKind(decision.chosen)) {
      this.lastFailoverSubstitute = decision.chosen;
    } else if (decision.unhealthy.length === 0) {
      this.lastFailoverSubstitute = null;
    }
    return { kind: decision.chosen, decision };
  }

  /**
   * Server-side dependency gate immediately before workspace provision.
   * Refreshes the trusted default from origin, then collects one atomic
   * trusted-mirror proof (tip + ancestry) for every gate_merge edge and
   * fails closed on any hold. Factory-only planes never call create(), so
   * this refresh is what absorbs a GitHub-observed merge SHA. Returns the
   * expected workspace base tip for same-repo gate edges so create can
   * confirm it. Does not mutate task state (leave todo/retrying).
   */
  private async recheckDependencyGate(
    task: Task,
    tasks: readonly Task[],
    repos: ReposConfig,
  ): Promise<{
    readonly hold: ReturnType<typeof firstUnsatisfiedDependency>;
    readonly expectedBaseTip: string | null;
  }> {
    if (task.blockedBy.length === 0) {
      return { hold: null, expectedBaseTip: null };
    }

    const byId = new Map(tasks.map((t) => [t.id, t]));
    const ancestryByDepId = new Map<string, DependencyAncestryFacts>();
    const batches = new Map<
      string,
      {
        readonly repo: RepoConfig;
        readonly deps: Array<{
          readonly id: string;
          readonly merged: string;
          readonly verified: string;
        }>;
        readonly shas: Set<string>;
      }
    >();
    let expectedBaseTip: string | null = null;

    for (const depId of task.blockedBy) {
      const dep = byId.get(depId);
      if (!dep || dep.state !== 'done') continue;
      if (resolveDependencyMode(task, dep) !== 'gate_merge') continue;

      const depRepo = repos.repos[dep.repo];
      if (!depRepo) {
        ancestryByDepId.set(depId, {
          defaultBranchTip: null,
          mergedSha: 'unknown',
          verifiedSha: 'unknown',
        });
        continue;
      }

      const merged = typeof dep.mergedSha === 'string' ? dep.mergedSha.trim() : '';
      const verified = typeof dep.verifiedSha === 'string' ? dep.verifiedSha.trim() : '';
      let batch = batches.get(dep.repo);
      if (!batch) {
        batch = { repo: depRepo, deps: [], shas: new Set<string>() };
        batches.set(dep.repo, batch);
      }
      batch.deps.push({ id: depId, merged, verified });
      if (merged) batch.shas.add(merged);
      if (verified) batch.shas.add(verified);
    }

    // One proof per repository covers every gate edge against one exact tip.
    // The authoritative path has no repeated/legacy probe fallback: providers
    // without the atomic API remain unknown and therefore fail closed.
    // Refresh origin first: factory-only planes never call create()/ensureMirror,
    // so a GitHub-observed merge SHA is otherwise permanently unknown.
    for (const [repoKey, batch] of batches) {
      let tip: string | null = null;
      let reachable: ReadonlyMap<string, boolean | null> = new Map();
      if (this.workspaces.proveDefaultBranchAncestry && batch.shas.size > 0) {
        if (this.workspaces.refreshTrustedDefault) {
          try {
            await this.workspaces.refreshTrustedDefault(batch.repo);
          } catch {
            // Proof below fail-closes (unknown / missing tip).
          }
        }
        try {
          const proof = await this.workspaces.proveDefaultBranchAncestry(
            batch.repo,
            [...batch.shas],
          );
          tip = proof.tip;
          reachable = proof.reachable;
        } catch {
          tip = null;
          reachable = new Map();
        }
      }

      for (const dep of batch.deps) {
        ancestryByDepId.set(dep.id, {
          defaultBranchTip: tip,
          mergedSha: dep.merged
            ? toShaAncestryFact(reachable.get(dep.merged) ?? null)
            : 'unknown',
          verifiedSha: dep.verified
            ? toShaAncestryFact(reachable.get(dep.verified) ?? null)
            : 'unknown',
        });
      }

      // There is exactly one same-repo batch, hence one expected workspace tip.
      if (repoKey === task.repo && tip) expectedBaseTip = tip;
    }

    return {
      hold: firstUnsatisfiedDependency(task, tasks, ancestryByDepId),
      expectedBaseTip,
    };
  }

  /** Phone / inbox notice while any adapter is unhealthy in the window. */
  private buildAdapterFailoverNotice(nowMs: number): AdapterFailoverNotice | null {
    if (!this.adapterFailoverEnabled) return null;
    const available = this.agents.available();
    const probe = chooseAdapterWithFailover({
      requested: this.agents.defaultKind,
      recentExitsByAdapter: this.adapterExitStamps,
      available,
      nowMs,
      enabled: true,
      pinned: false,
    });
    if (probe.unhealthy.length === 0) {
      this.lastFailoverSubstitute = null;
      return null;
    }
    const detail = formatAdapterFailoverInboxLine({
      unhealthy: probe.unhealthy,
      preferred: this.agents.defaultKind,
      activeSubstitute: this.lastFailoverSubstitute,
    });
    if (!detail) return null;
    return {
      unhealthy: [...probe.unhealthy],
      detail,
      ...(this.lastFailoverSubstitute
        ? { substitute: this.lastFailoverSubstitute }
        : {}),
    };
  }

  /** Task ids currently being run. */
  get running(): string[] {
    return [...this.tracked.keys()];
  }

  /** Task ids currently winding down after a cancel (Plan 2a). */
  get stopping(): string[] {
    return [...this.stoppingRuns.keys()];
  }

  /** The latest runtime view, for the HTTP server / UI (SPEC §2, §14). */
  getState(): RuntimeView {
    const activity: Record<string, readonly string[]> = {};
    const liveRuns: Record<string, LiveRunMeta> = {};
    const now = this.deps.clock();
    const maxRunMs = this.deps.config.maxRunMs;
    for (const [taskId, t] of this.tracked) {
      const snap = t.run.poll(now);
      const osAlive =
        snap.processPid !== undefined ? isOsProcessAlive(snap.processPid) : null;
      const processAlive = resolveProcessAlive({
        processAlive: snap.processAlive === true,
        osAlive,
      });
      const silenceMs = Math.max(0, now - snap.lastEventAt);
      const runMs = Math.max(0, now - t.startedAtMs);
      const aliveHint = this.refreshAliveHint(t, snap, now, processAlive);

      this.refreshProcStats(t, snap, now, processAlive);

      const baseActivity = snap.recentActivity !== undefined ? [...snap.recentActivity] : [];
      // Synthetic quiet line so the phone does not look stuck during long tools.
      if (shouldShowQuietProgress(silenceMs, processAlive)) {
        baseActivity.push(
          formatQuietProgressLine({
            silenceMs,
            runMs,
            maxRunMs,
            aliveHint,
            cpuPct: t.procCpuPct,
            rssMb: t.procRssMb,
          }),
        );
      }
      if (baseActivity.length > 0) activity[taskId] = baseActivity;

      // During verification the agent child is gone; surface verifier processAlive.
      const verifying = this.activeVerifications.get(taskId);
      const liveProcessAlive = verifying ? verifying.processAlive : processAlive;
      const liveAliveHint = verifying
        ? `verifying:${verifying.stage}`
        : aliveHint;

      const hostLive =
        t.run instanceof HostExecutorRun ? t.run.liveMeta(now) : null;

      liveRuns[taskId] = {
        taskId,
        sessionId: snap.sessionId.trim().length > 0 ? snap.sessionId : null,
        lastEventAt: new Date(snap.lastEventAt).toISOString(),
        branchTip: t.branchTip,
        runKind: t.isSteerResume ? 'steer' : 'implementer',
        activityLines: baseActivity.length,
        processAlive: liveProcessAlive,
        silenceMs,
        runMs,
        maxRunMs,
        aliveHint: hostLive
          ? hostLive.commandName
            ? `host:${hostLive.commandIndex}/${hostLive.commandTotal} ${hostLive.commandName}`
            : liveAliveHint
          : liveAliveHint,
        procCpuPct: t.procCpuPct,
        procRssMb: t.procRssMb,
        ...(hostLive
          ? {
              hostCommandIndex: hostLive.commandIndex,
              hostCommandTotal: hostLive.commandTotal,
              hostCommandName: hostLive.commandName,
              hostCommandTimeoutMs: hostLive.timeoutMs,
            }
          : {}),
      };
    }
    const verificationRuns: Record<string, VerificationRunMeta> = {};
    for (const [taskId, v] of this.activeVerifications) {
      verificationRuns[taskId] = toVerificationRunMeta({
        taskId,
        phase: v.phase,
        stage: v.stage,
        startedAtMs: v.startedAtMs,
        nowMs: now,
        processAlive: v.processAlive,
        cancelRequested: v.cancelRequested,
        lastCompletedStage: v.lastCompletedStage,
      });
    }
    const pendingChat: Record<string, readonly string[]> = {};
    for (const [id, msgs] of this.pendingChat) {
      if (msgs.length > 0) pendingChat[id] = msgs.map((m) => m.text);
    }
    return {
      snapshot: this.lastSnapshot,
      running: this.running,
      stopping: this.stopping,
      activity,
      pendingChat,
      liveRuns,
      verificationRuns,
      lastReport: this.lastReport,
      agents: {
        default: this.agents.defaultKind,
        available: this.agents.available(),
        providerPolicy: this.agents.providerPolicy,
      },
      costSummary: this.buildCostSummary(now),
      dispatchHold: this.deps.config.dispatchEnabled
        ? toDispatchHold(this.currentDiskPressure)
        : {
            reason: 'configured',
            detail: '此实例已禁用任务调度（HERCULES_DISPATCH_ENABLED=0）',
          },
      diskPressure: this.currentDiskPressure,
      diskPruneNote: this.diskPruneNote,
      adapterFailover: this.buildAdapterFailoverNotice(now),
      reviewerHealth: reviewerProviderHealth(
        (this.lastSnapshot?.tasks ?? [])
          .map((task) => task.reviewerInfrastructure)
          .filter((receipt): receipt is NonNullable<typeof receipt> => receipt != null),
      ),
      holds: Object.fromEntries(this.schedulingHolds),
    };
  }

  /** Clear a provider brake only after a successful preflight or explicit operator action. */
  async recoverReviewerProvider(
    provider: AdapterKind,
    input: { readonly mode: 'health_check' | 'operator' },
  ): Promise<{ readonly recovered: number }> {
    if (input.mode === 'health_check') {
      if (!this.deps.reviewerHealthCheck) {
        throw new ReviewerRecoveryError(`reviewer health check is unavailable for ${provider}`);
      }
      if (!(await this.deps.reviewerHealthCheck(provider))) {
        throw new ReviewerRecoveryError(
          `reviewer health check failed for ${provider}; provider remains blocked`,
        );
      }
    }
    const snapshot = await this.deps.control.read();
    let recovered = 0;
    for (const task of snapshot.tasks) {
      const receipt = task.reviewerInfrastructure;
      if (!receipt || receipt.provider !== provider || receipt.state !== 'blocked') continue;
      await this.writeTaskCommitted(
        task,
        { ...task, reviewerInfrastructure: { ...receipt, state: 'ready' } },
        `hercules: reviewer provider ${provider} recovery (${input.mode}) for ${task.id}`,
      );
      recovered += 1;
    }
    this.lastSnapshot = await this.deps.control.read();
    this.emit();
    return { recovered };
  }

  /** Build Settings/API cost summary from ledger + live mid-run samples. */
  private buildCostSummary(nowMs: number = this.deps.clock()): CostCapSummary {
    const liveByTask: Record<string, UsageSample> = {};
    for (const [id, u] of this.liveUsage) liveByTask[id] = u;
    return buildCostCapSummary({
      policy: this.deps.config.costCaps,
      ledger: this.usageLedger,
      nowMs,
      ledgerDiagnostics: this.costLedgerDiagnostics,
      ...(Object.keys(liveByTask).length > 0 ? { liveByTask } : {}),
    });
  }

  /** Task spend = committed ledger + current live run (if any). */
  private taskSpend(taskId: string): UsageSample {
    const committed = sumLedger(entriesForTask(this.usageLedger, taskId));
    const live = this.liveUsage.get(taskId);
    return live ? addUsage(committed, live) : committed;
  }

  /** Day spend = UTC-day ledger + all live runs. */
  private daySpend(nowMs: number = this.deps.clock()): UsageSample {
    let day = sumLedger(entriesForUtcDay(this.usageLedger, nowMs));
    for (const live of this.liveUsage.values()) {
      day = addUsage(day, live);
    }
    return day;
  }

  private async ensureCostLedgerLoaded(): Promise<void> {
    if (this.costLedgerLoaded) return;
    this.costLedgerLoaded = true;
    const store = this.deps.costLedgerStore;
    if (!store) {
      this.costLedgerDiagnostics = memoryCostLedgerDiagnostics(this.usageLedger.length);
      return;
    }
    try {
      const loaded = await store.load();
      this.durableCostLedger = loaded.ledger;
      this.usageLedger = receiptsToLedgerEntries(loaded.ledger.receipts);
      this.costLedgerDiagnostics = loaded.diagnostics;
      console.error(
        `[hercules] cost-ledger recovery: ${loaded.diagnostics.status}; ` +
          `receipts=${loaded.ledger.receipts.length}`,
      );
    } catch (error) {
      this.durableCostLedger = emptyCostLedger();
      this.usageLedger = [];
      this.costLedgerDiagnostics = unavailableCostLedgerDiagnostics(this.deps.clock());
      console.error(
        `[hercules] cost-ledger load failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  /** Append one durable usage receipt (idempotent by runKey). */
  private async appendDurableReceipt(receipt: UsageReceipt): Promise<void> {
    await this.ensureCostLedgerLoaded();
    const store = this.deps.costLedgerStore;
    if (!store) {
      const appended = appendUsageReceipt(this.durableCostLedger, receipt);
      if (!appended.applied) return;
      this.durableCostLedger = appended.ledger;
      this.usageLedger = receiptsToLedgerEntries(appended.ledger.receipts);
      this.costLedgerDiagnostics = memoryCostLedgerDiagnostics(appended.ledger.receipts.length);
      return;
    }
    try {
      const result = await store.appendReceipt(this.durableCostLedger, receipt);
      this.durableCostLedger = result.ledger;
      this.usageLedger = receiptsToLedgerEntries(result.ledger.receipts);
      this.costLedgerDiagnostics = {
        status: 'ok',
        receiptCount: result.ledger.receipts.length,
        retainedDays: this.costLedgerDiagnostics.retainedDays,
        lastPersistedAtMs: result.ledger.lastPersistedAtMs || null,
        recoveredAtMs: this.costLedgerDiagnostics.recoveredAtMs ?? receipt.atMs,
        note: null,
        failClosed: false,
      };
    } catch (error) {
      const appended = appendUsageReceipt(this.durableCostLedger, receipt);
      if (appended.applied) {
        this.durableCostLedger = pruneCostLedger(appended.ledger, {
          nowMs: receipt.atMs,
        }).ledger;
        this.usageLedger = receiptsToLedgerEntries(this.durableCostLedger.receipts);
      }
      const code = error instanceof CostLedgerStoreError ? error.code : 'io';
      this.costLedgerDiagnostics = unavailableCostLedgerDiagnostics(
        receipt.atMs,
        code === 'disk_full'
          ? 'Cost ledger disk is full; current-day caps fail closed.'
          : 'Cost ledger write failed; current-day caps fail closed.',
      );
      console.error(`[hercules] cost-ledger persist failed (${code})`);
    }
  }

  /** Record one terminal cumulative sample, idempotently by daemon run key. */
  private async commitRunUsage(
    taskId: string,
    usage: TokenUsage | undefined,
    atMs: number,
    explicitRunKey?: string,
  ): Promise<void> {
    this.liveUsage.delete(taskId);
    if (!usage) return;
    const runKey = explicitRunKey ?? this.tracked.get(taskId)?.costRunKey;
    if (!runKey) {
      this.costLedgerDiagnostics = unavailableCostLedgerDiagnostics(
        atMs,
        'Stable cost-run identity is unavailable; current-day caps fail closed.',
      );
      console.error(`[hercules] cost-ledger stable run identity missing for ${taskId}`);
      return;
    }
    const receipt: UsageReceipt = {
      runKey,
      taskId,
      atMs,
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: usage.costUsd,
      },
    };
    await this.appendDurableReceipt(receipt);
  }

  /** Charge one Remote Control ACP turn to the ledger (scope = task id or session id). */
  async recordSessionUsage(input: {
    readonly scopeId: string;
    readonly sessionId: string;
    readonly turn: number;
    readonly usage: { inputTokens: number; outputTokens: number; costUsd: number };
    readonly atMs: number;
  }): Promise<void> {
    if (!isValidCostRunKey(input.scopeId) || !isValidCostRunKey(input.sessionId)) {
      console.error(
        `[hercules] session usage skipped: invalid scope/session id ` +
          `(scope=${String(input.scopeId)} session=${String(input.sessionId)})`,
      );
      return;
    }
    const runKey = `rc-${input.sessionId}-t${input.turn}`;
    await this.appendDurableReceipt({
      runKey,
      taskId: input.scopeId,
      atMs: input.atMs,
      usage: {
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        costUsd: input.usage.costUsd,
      },
    });
  }

  private isCostLedgerBlocking(): boolean {
    return this.deps.config.costCaps.enabled && this.costLedgerDiagnostics.failClosed;
  }

  /** Observe mid-run usage; return verdict for soft/hard handling. */
  private observeLiveUsage(
    taskId: string,
    usage: TokenUsage | undefined,
  ): CostCapVerdict {
    if (usage) {
      this.liveUsage.set(taskId, {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: usage.costUsd,
      });
    }
    return evaluateCostCaps({
      policy: this.deps.config.costCaps,
      taskUsage: this.taskSpend(taskId),
      dayUsage: this.daySpend(),
    });
  }

  private maybeLogSoftWarn(taskId: string, verdict: CostCapVerdict): void {
    if (verdict.level !== 'soft' && verdict.level !== 'hard') return;
    if (this.costSoftWarned.has(taskId)) return;
    // Log soft once; hard also logs here if soft was never seen.
    if (verdict.level === 'soft' || !this.costSoftWarned.has(taskId)) {
      this.costSoftWarned.add(taskId);
      console.error(
        `[hercules] cost-cap ${verdict.level} ${taskId}: ${verdict.reasons.join('; ') || 'threshold crossed'}`,
      );
    }
  }

  private costCapPacketSection(
    taskId: string,
    runUsage: TokenUsage | undefined,
  ): string | undefined {
    const policy = this.deps.config.costCaps;
    if (!policy.enabled) return undefined;
    if (runUsage) this.observeLiveUsage(taskId, runUsage);
    const taskU = this.taskSpend(taskId);
    const dayU = this.daySpend();
    const verdict = evaluateCostCaps({
      policy,
      taskUsage: taskU,
      dayUsage: dayU,
    });
    this.maybeLogSoftWarn(taskId, verdict);
    return renderCostCapPacketSection({
      policy,
      ...(runUsage
        ? {
            runUsage: {
              inputTokens: runUsage.inputTokens,
              outputTokens: runUsage.outputTokens,
              costUsd: runUsage.costUsd,
            },
          }
        : {}),
      taskUsage: taskU,
      dayUsage: dayU,
      verdict,
    });
  }

  /**
   * Hard cost/token cap: park as failed with a Cost cap mini-packet.
   * Always failed (not retrying) so retries cannot re-burn the same budget.
   * Mid-run Remote Control queue is folded onto the body (peek→write→ack) so
   * accepted operator notes are not left only in volatile memory.
   */
  private async failCostCap(
    task: Task,
    opts: {
      readonly reasons: readonly string[];
      readonly activityLog?: readonly string[];
      readonly adapter?: string;
      readonly workspaceDir?: string;
      readonly branchTip?: string | null;
      readonly usage?: TokenUsage;
    },
  ): Promise<void> {
    const now = this.deps.clock();
    if (opts.usage) this.observeLiveUsage(task.id, opts.usage);
    // Commit live spend before parking so the ledger reflects the burn.
    await this.commitRunUsage(task.id, opts.usage ?? this.liveUsage.get(task.id), now);
    const attempts = task.attempts + 1;
    const stamp = new Date(now).toISOString();
    const taskUsage = this.taskSpend(task.id);
    const dayUsage = this.daySpend(now);
    const section = buildCostCapFailureSection({
      stamp,
      reasons: opts.reasons,
      taskUsage,
      dayUsage,
      attempt: attempts,
      maxAttempts: this.deps.config.maxAttempts,
    });
    const activityNote =
      opts.activityLog && opts.activityLog.length > 0
        ? `\n### Last agent activity\n\`\`\`\n${opts.activityLog
            .slice(-24)
            .map((l) => l.slice(0, 400))
            .join('\n')}\n\`\`\`\n`
        : '';
    const baseBody = `${task.body.trimEnd()}\n\n${section}${activityNote}\n`;
    // Drain mid-run chat on this terminal too — never leave accepted notes
    // only in memory when parking failed (restart would lose them).
    await this.withPendingChatFinalize<void>(task.id, async (drained) => {
      const folded = this.foldDrainedChat({
        body: baseBody,
        stamp,
        autoPendingSteer: null,
        setPendingSteer: false,
        drained,
        taskId: task.id,
      });
      const durable = await this.transition(task, 'failed', {
        attempts,
        lastEventAt: stamp,
        endedAt: stamp,
        body: folded.body,
        pendingSteer: null,
      });
      return { value: undefined, durable };
    });
    console.error(
      `[hercules] cost-cap hard stop ${task.id}: ${opts.reasons.join('; ') || 'cap exceeded'}`,
    );
  }

  /**
   * Queue a human Remote Control message for a live task. On finalization, all
   * queued lines are combined into one pending_steer (resume with full context).
   * Same clientMessageId / exact-text retries are idempotent (mode=duplicate).
   */
  queueTaskChat(
    taskId: string,
    message: string,
    opts?: { readonly clientMessageId?: string | null },
  ): QueueTaskChatResult {
    const text = message.trim();
    const queuedTexts = (): readonly string[] =>
      (this.pendingChat.get(taskId) ?? []).map((e) => e.text);
    if (text.length === 0) {
      return { mode: 'queued', queued: queuedTexts() };
    }
    const clientMessageId = normalizeClientMessageId(opts?.clientMessageId ?? null);
    const snapTask = this.lastSnapshot?.tasks.find((t) => t.id === taskId);
    const tracked = this.tracked.get(taskId);
    const decision = decideChatIdempotency({
      text,
      clientMessageId,
      deliveredIds: this.deliveredChatIds.get(taskId) ?? [],
      queue: this.pendingChat.get(taskId) ?? [],
      pendingSteer: snapTask?.pendingSteer ?? null,
      body: snapTask?.body ?? '',
      consumedSteerText: tracked?.consumedSteerText ?? null,
      consumedClientMessageIds: tracked?.consumedClientMessageIds ?? [],
      // Live tracked run = immediate dispatch window for legacy text guard.
      legacyTextGuard: tracked !== undefined,
    });
    if (decision.action === 'duplicate') {
      return {
        mode: 'duplicate',
        queued: queuedTexts(),
        reason: decision.reason,
        priorMode: decision.priorMode,
      };
    }
    // Assign a stable internal delivery id at enqueue — body exactly-once is
    // keyed by this instance, not by normalized text (deliberate later identical
    // messages must each get their own durable marker).
    this.chatDeliverySeq += 1;
    const deliveryId = makeChatDeliveryId(this.deps.clock(), this.chatDeliverySeq);
    const pushed = dedupeQueuePush(this.pendingChat.get(taskId) ?? [], {
      text,
      clientMessageId,
      deliveryId,
    });
    if (pushed.duplicate) {
      return {
        mode: 'duplicate',
        queued: queuedTexts(),
        reason: 'identical message already in live queue',
        priorMode: 'queued',
      };
    }
    // Do not mark delivered on enqueue — only after durable finalize ack
    // (persist-before-clear). In-queue retries are deduped via the queue list.
    this.pendingChat.set(taskId, pushed.queue);
    // Chat that lands after the terminal poll but while verification is being
    // registered/started supersedes this tip. Abort before another expensive
    // stage and let complete() persist one continuation at the same boundary.
    const verifying = this.activeVerifications.get(taskId);
    if (verifying) {
      verifying.cancelReason.cause = 'human_steer';
      if (!verifying.controller.signal.aborted) {
        verifying.controller.abort(verifying.cancelReason);
      }
    }
    this.emit();
    return { mode: 'queued', queued: pushed.queue.map((e) => e.text) };
  }

  /** Snapshot of queued chat for one task (empty if none). */
  getTaskChatQueue(taskId: string): readonly string[] {
    return (this.pendingChat.get(taskId) ?? []).map((e) => e.text);
  }

  /** Record a client message id as accepted for this task (bounded ring). */
  rememberChatId(taskId: string, clientMessageId: string): void {
    const id = normalizeClientMessageId(clientMessageId);
    if (!id) return;
    const next = rememberDeliveredId(this.deliveredChatIds.get(taskId) ?? [], id);
    this.deliveredChatIds.set(taskId, next);
  }

  /**
   * Peek the live chat queue without mutating it. Shallow-copies the entry
   * array so concurrent enqueues append new objects after the snapshot.
   */
  private snapshotPendingChat(taskId: string): {
    readonly combined: CombinedPendingChat;
    readonly entries: readonly PendingChatEntry[];
  } {
    const entries = [...(this.pendingChat.get(taskId) ?? [])];
    return {
      combined: combinePendingChatMessages(entries.map((e) => e.text)),
      entries,
    };
  }

  /**
   * After a successful control write+commit, drop only the snapshotted entries
   * (by object identity) and mark their client ids delivered. Concurrent
   * enqueues after the snapshot remain retryable.
   */
  private acknowledgePendingChat(
    taskId: string,
    snapshot: readonly PendingChatEntry[],
  ): void {
    if (snapshot.length === 0) return;
    const snapSet = new Set<PendingChatEntry>(snapshot);
    const current = this.pendingChat.get(taskId) ?? [];
    const remaining = current.filter((e) => !snapSet.has(e));
    if (remaining.length === 0) this.pendingChat.delete(taskId);
    else this.pendingChat.set(taskId, remaining);
    for (const e of snapshot) {
      if (e.clientMessageId) this.rememberChatId(taskId, e.clientMessageId);
    }
    this.emit();
  }

  /**
   * Snapshot → fold/write via `run` → acknowledge only when `run` reports a
   * durable control write (`durable: true`). On throw, `committed:false`, or
   * missing-task no-op the snapshotted messages stay in the queue (retryable)
   * and are not marked delivered. Concurrent enqueues after the snapshot are
   * never part of the ack set.
   *
   * Callers with multi-branch outcomes must pass an explicit type argument
   * (e.g. {@link CompleteOutcome}) so T is not inferred from the first branch.
   */
  private async withPendingChatFinalize<T>(
    taskId: string,
    run: (
      drained: {
        readonly combined: CombinedPendingChat;
        readonly entries: readonly PendingChatEntry[];
      },
    ) => Promise<PendingChatFinalizeBag<T>>,
  ): Promise<T> {
    const drained = this.snapshotPendingChat(taskId);
    try {
      const { value, durable } = await run(drained);
      if (durable) {
        this.acknowledgePendingChat(taskId, drained.entries);
      } else if (drained.entries.length > 0) {
        console.error(
          `[hercules] ${taskId}: pending-chat finalize not durable — queue kept ` +
            `(${drained.entries.length} message(s))`,
        );
      }
      return value;
    } catch (err) {
      console.error(
        `[hercules] ${taskId}: pending-chat finalize failed — queue kept for retry: ` +
          `${(err as Error).message}`,
      );
      throw err;
    }
  }

  /**
   * Persist queued chat to the task body as discarded (cancel/delete/abandon),
   * then ack. Never silently drop accepted mid-run messages.
   */
  private async discardPendingChatWithAudit(
    taskId: string,
    reason: string,
  ): Promise<void> {
    const drained = this.snapshotPendingChat(taskId);
    if (drained.entries.length === 0) {
      this.pendingChat.delete(taskId);
      return;
    }
    try {
      const snap = await this.deps.control.read();
      const task = snap.tasks.find((t) => t.id === taskId);
      if (!task) {
        console.error(
          `[hercules] ${taskId}: cannot audit discarded chat (${reason}) — task gone; ` +
            'keeping queue in memory',
        );
        return;
      }
      const stamp = new Date(this.deps.clock()).toISOString();
      const clientIds = drained.entries
        .map((e) => e.clientMessageId)
        .filter((x): x is string => typeof x === 'string' && x.length > 0);
      const deliveryIds = drained.entries.map((e) => e.deliveryId);
      let section = formatHumanSteerSection({
        stamp,
        text: drained.combined.text,
        note: `_(Remote Control queue discarded — ${reason})_`,
        taskId,
      });
      const markers = [
        ...deliveryIds.map((id) => `<!-- chat-delivery-id: ${id} -->`),
        ...clientIds.map((id) => `<!-- client-message-id: ${id} -->`),
      ].join('\n');
      if (markers.length > 0) {
        section = section.replace(
          `## Human steer (${stamp})`,
          `## Human steer (${stamp})\n\n${markers}`,
        );
      }
      // Persist-before-clear: write+commit first, then acknowledge snapshot only.
      const next = {
        ...task,
        body: `${task.body.trimEnd()}\n\n${section}`,
      };
      const { committed } = await mutateControl(this.deps.control, { writeTasks: [{ expected: task, next }] },
        `hercules: ${taskId} discard mid-run chat (${reason})`,
      );
      if (!committed) {
        throw new ControlNotDurableError(
          `${taskId}: discard-chat commit returned committed:false`,
        );
      }
      this.acknowledgePendingChat(taskId, drained.entries);
    } catch (err) {
      console.error(
        `[hercules] ${taskId}: discard-chat audit failed (${reason}) — queue retained: ` +
          `${(err as Error).message}`,
      );
    }
  }

  /** Persist queue entries accepted after a finalizer took its last snapshot. */
  private async recoverUnownedPendingChat(): Promise<string[]> {
    const candidates = [...this.pendingChat.keys()].filter(
      (taskId) => !this.tracked.has(taskId) && !this.stoppingRuns.has(taskId),
    );
    if (candidates.length === 0) return [];
    const recovered: string[] = [];
    for (const taskId of candidates) {
      const fresh = (await this.deps.control.read()).tasks.find((t) => t.id === taskId);
      if (!fresh) continue;
      if (fresh.state === 'cancelled' || fresh.state === 'deleted') {
        await this.discardPendingChatWithAudit(taskId, `task ${fresh.state}`);
        continue;
      }
      const stamp = new Date(this.deps.clock()).toISOString();
      let durable = false;
      try {
        durable = await this.withPendingChatFinalize<boolean>(taskId, async (drained) => {
          if (drained.entries.length === 0) return { value: false, durable: true };
          const current = (await this.deps.control.read()).tasks.find((t) => t.id === taskId);
          if (!current) {
            return { value: false, durable: false };
          }
          if (current.state === 'cancelled' || current.state === 'deleted') {
            return { value: false, durable: false };
          }
          const folded = this.foldDrainedChat({
            body: current.body,
            stamp,
            autoPendingSteer: current.pendingSteer,
            setPendingSteer: true,
            drained,
            taskId,
          });
          const fields: Partial<Task> = {
            body: folded.body,
            pendingSteer: folded.pendingSteer,
            // The completed packet predates this accepted continuation.
            verifiedSha: null,
            verifiedGatesGreen: null,
            packetNonce: null,
            verifiedPathLeaseDigest: null,
          };
          if (
            current.state === 'review' ||
            current.state === 'done' ||
            current.state === 'failed' ||
            current.state === 'in_progress'
          ) {
            const to = current.state === 'in_progress' ? 'retrying' : 'todo';
            const wrote = await this.transition(current, to, {
              ...fields,
              ...(to === 'todo' ? { endedAt: null, lastEventAt: null } : {}),
              ...(current.state === 'failed' ? { attempts: 0 } : {}),
            });
            return { value: wrote, durable: wrote };
          }
          // retrying/todo may already be human-owned (including switch-now).
          await this.writeTaskCommitted(
            current,
            { ...current, ...fields },
            `hercules: ${taskId} recover late finalize chat (kept ${current.state})`,
          );
          return { value: true, durable: true };
        });
      } catch {
        // withPendingChatFinalize already logged; queue remains retryable.
        continue;
      }
      if (!durable) await this.maybeDiscardTerminalPendingChat(taskId);
      else recovered.push(taskId);
    }
    return recovered;
  }

  private async maybeDiscardTerminalPendingChat(taskId: string): Promise<void> {
    const after = (await this.deps.control.read()).tasks.find((t) => t.id === taskId);
    if (!after) return;
    if (after.state === 'cancelled' || after.state === 'deleted') {
      await this.discardPendingChatWithAudit(taskId, 'task ' + after.state);
    }
  }

  /** writeTask + commit; throws when commit is not durable. */
  private async writeTaskCommitted(expected: Task, task: Task, message: string): Promise<void> {
    const { committed } = await mutateControl(
      this.deps.control,
      { writeTasks: [{ expected, next: task }] },
      message,
    );
    if (!committed) {
      throw new ControlNotDurableError(
        `${task.id}: commit returned committed:false after writeTask (${message})`,
      );
    }
  }

  /**
   * Acquire branch ownership from the latest control record. A failed audit
   * commit restores the prior file so a later tick cannot mistake an
   * uncommitted lease write for durable ownership.
   */
  private async writeTaskBranchLeaseCommitted(
    selected: Task,
    lease: TaskBranchLease,
    message: string = `hercules: ${selected.id} acquire exact task-branch lease`,
  ): Promise<Task> {
    const fresh = (await this.deps.control.read()).tasks.find((t) => t.id === selected.id);
    if (!fresh) {
      throw new ControlNotDurableError(`${selected.id}: task disappeared before lease acquire`);
    }
    if (fresh.state !== selected.state) {
      throw new ControlNotDurableError(
        `${selected.id}: task state changed before lease acquire ` +
          `(${selected.state} -> ${fresh.state})`,
      );
    }
    if (
      fresh.expectedBaseRevision !== selected.expectedBaseRevision ||
      fresh.expectedRemoteTip !== selected.expectedRemoteTip
    ) {
      throw new ControlNotDurableError(
        `${selected.id}: task branch lease changed before acquire; stale dispatch must retry`,
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
      const { committed } = await mutateControl(this.deps.control, { writeTasks: [{ expected: fresh, next: owned }] }, message);
      if (!committed) {
        throw new ControlNotDurableError(
          `${selected.id}: lease commit returned committed:false`,
        );
      }
    } catch (err) {
      if (!this.deps.control.mutateCommitted) await this.deps.control.writeTask(fresh);
      throw err;
    }
    return owned;
  }

  /**
   * Persist drained queue into body (+ optional pending_steer merge) for a
   * finalize transition. Shared by review-complete, L3 rework, and failed.
   * Delegates pure fold rules to {@link foldDrainedChatDelivery}.
   */
  private foldDrainedChat(input: {
    readonly body: string;
    readonly stamp: string;
    readonly autoPendingSteer: string | null;
    readonly setPendingSteer: boolean;
    readonly drained: {
      readonly combined: CombinedPendingChat;
      readonly entries: readonly PendingChatEntry[];
    };
    readonly taskId?: string | null;
  }): {
    readonly body: string;
    readonly pendingSteer: string | null;
    readonly hasFreshBodyContent: boolean;
  } {
    return foldDrainedChatDelivery({
      body: input.body,
      stamp: input.stamp,
      autoPendingSteer: input.autoPendingSteer,
      setPendingSteer: input.setPendingSteer,
      entries: input.drained.entries,
      fullText: input.drained.combined.text,
      fullCount: input.drained.combined.count,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    });
  }

  /**
   * Immediate cancel signal for a live agent or in-flight verification.
   * Called from the API after disk state is written to `cancelled` so we do not
   * wait for the next tick (verify can block the tick for hours on cargo).
   */
  requestCancel(taskId: string): void {
    const verifying = this.activeVerifications.get(taskId);
    if (verifying) {
      // Graceful: TERM then KILL (cancelReason.force stays false).
      verifying.cancelRequested = true;
      if (!verifying.controller.signal.aborted) {
        verifying.controller.abort(verifying.cancelReason);
      }
      this.emit();
      return;
    }
    // Agent still running: begin graceful wind-down without waiting for tick.
    // If the agent already exited and complete() is about to register
    // verification, do nothing here — complete's pre-check / abort path owns it.
    const tracked = this.tracked.get(taskId);
    if (tracked && !this.stoppingRuns.has(taskId)) {
      const snap = tracked.run.poll(this.deps.clock());
      if (snap.status === 'running') {
        this.beginStopping(taskId, { preserveWorkspace: false });
        this.emit();
      }
    }
  }

  /**
   * Escalate a winding-down cancel to an immediate SIGKILL (Plan 2a), or force
   * abort an in-flight verification (immediate process-group KILL — no TERM grace).
   * No-op if the task is neither stopping nor verifying.
   */
  forceAbort(taskId: string): void {
    const verifying = this.activeVerifications.get(taskId);
    if (verifying) {
      verifying.cancelRequested = true;
      verifying.forced = true;
      // Flip shared reason so in-flight graceful TERM wait escalates to KILL now.
      verifying.cancelReason.force = true;
      if (!verifying.controller.signal.aborted) {
        verifying.controller.abort(verifying.cancelReason);
      }
      this.emit();
      return;
    }
    const entry = this.stoppingRuns.get(taskId);
    if (entry) {
      entry.forced = true;
      entry.tracked.run.stop({ force: true });
    }
  }

  /** Subscribe to per-tick runtime updates. Returns an unsubscribe function. */
  subscribe(listener: RuntimeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Re-read the control repo into {@link lastSnapshot} and push SSE/API view.
   * Call after out-of-band mutations (ActionService Approve plan, create, …)
   * so phone UI does not flash stale planPending / state for a full tick.
   */
  async refreshSnapshotFromControl(): Promise<void> {
    await this.deps.control.sync();
    this.lastSnapshot = await this.deps.control.read();
    this.emit();
  }

  private emit(): void {
    const view = this.getState();
    for (const listener of this.listeners) listener(view);
  }

  /** Run one orchestration tick. */
  async tick(): Promise<TickReport> {
    const { config, control, clock } = this.deps;
    const report: TickReport = {
      dispatched: [],
      completed: [],
      retried: [],
      failed: [],
      stalled: [],
      tornDown: [],
      recovered: [],
      running: [],
      thrashParked: [],
      provisionDiscarded: [],
      quietLong: [],
      sessionMetrics: {
        thrashParks: this.sessionThrashParks,
        quietLongSightings: this.sessionQuietLongSightings,
      },
      stagingReconciled: [],
      promotesFinalized: [],
    };

    await control.sync();
    let snapshot = await control.read();
    // Recover durable receipts before any state view or dispatch decision.
    await this.ensureCostLedgerLoaded();

    // Observer/staging mode is deliberately read-only after sync. Returning
    // here prevents orphan recovery, agent starts, release reconciliation, and
    // every other control mutation on a second daemon that sees the same tasks.
    if (!config.dispatchEnabled) {
      this.lastSnapshot = snapshot;
      await this.refreshSchedulingHolds(snapshot);
      this.lastReport = report;
      this.emit();
      return report;
    }

    snapshot = await this.enforcePersistedGuardianReadiness(snapshot);

    const byId = new Map(snapshot.tasks.map((t) => [t.id, t]));

    // Drop discard counters for tasks that left todo or vanished (terminal /
    // removed). Successful dispatch also clears explicitly further below.
    for (const id of this.provisionDiscards.keys()) {
      const t = byId.get(id);
      if (!t || t.state !== 'todo') this.provisionDiscards.delete(id);
    }

    // One-shot startup sweep: reclaim worktrees left on disk by a crashed prior
    // instance. Runs before dispatch so reclaimed slots are never double-counted.
    // CRITICAL: also keep checkouts for tasks still claimed running on disk
    // (in_progress / retrying). Case study settings-build: empty keep wiped the
    // live agent worktree on every restart → preserve saw "worktree missing"
    // and uncommitted work was lost before re-dispatch.
    if (!this.reclaimedOnce) {
      this.reclaimedOnce = true;
      const keep = new Set([...this.tracked.keys(), ...this.stoppingRuns.keys()]);
      for (const t of snapshot.tasks) {
        if (
          t.state === 'in_progress' ||
          t.state === 'retrying' ||
          t.body.includes(PATH_LEASE_SCOPE_BLOCKED_MARKER)
        ) {
          keep.add(t.id);
        }
      }
      const ids = await this.workspaces.reclaimOrphans(keep);
      if (ids.length) report.tornDown.push(...ids);
    }

    // Restart-safe promote finalization (design §4): if a prior process wrote
    // promoting_sha then died mid-deploy (e.g. Hercules deploying itself),
    // health+smoke the tip and record ok or automatic rollback — before any
    // staging reconciler work.
    if (!this.promotesFinalizedOnce) {
      this.promotesFinalizedOnce = true;
      if (this.deps.promoteService) {
        try {
          const results = await this.deps.promoteService.finalizeInFlight();
          for (const r of results) {
            report.promotesFinalized.push(r.repoKey);
            if (r.alert) {
              console.error(`[hercules] promote finalize ${r.repoKey}: ${r.alert}`);
            } else {
              console.error(
                `[hercules] promote finalize ${r.repoKey}: ok → ${r.productionSha?.slice(0, 8) ?? '?'}`,
              );
            }
          }
        } catch (err) {
          console.error(
            `[hercules] promote finalize failed: ${(err as Error).message}`,
          );
        }
      }
    }

    // Runs we owned coming into this tick — anything in_progress that is NOT in
    // this set is an orphan from a previous instance, not work reconcile just
    // finished.
    const trackedAtStart = new Set(this.tracked.keys());
    await this.reconcile(byId, report);
    await this.sweepStopping(byId, report);
    await this.recoverOrphans(snapshot, trackedAtStart, report);
    const lateChatRequeued = await this.recoverUnownedPendingChat();
    for (const taskId of lateChatRequeued) {
      for (const bucket of [report.completed, report.failed]) {
        let at = bucket.indexOf(taskId);
        while (at >= 0) {
          bucket.splice(at, 1);
          at = bucket.indexOf(taskId);
        }
      }
      if (!report.retried.includes(taskId)) report.retried.push(taskId);
    }
    // Path-lease crash/restart recovery before any new acquire can race a ghost.
    await this.reclaimStalePathLeases(snapshot);

    // Self-heal review+pendingSteer dead state (midrun-steer-race) before dispatch.
    const healed = await this.healStuckReviewWithPendingSteer();
    if (healed.length > 0) report.retried.push(...healed);
    // Recovery / heal rewrote task files; re-derive so dispatch sees the new states.
    const dispatchSnapshot =
      report.recovered.length > 0 || healed.length > 0 || lateChatRequeued.length > 0
        ? await control.read()
        : snapshot;
    // Disk watermark (2026-07-22 twice-full incident): warn loudly at 85%
    // used; at 95% stop feeding new agents (running work may finish).
    // Surface the same reason on RuntimeView (2026-07-24 silent-stuck queue).
    // Cargo auto-prune (2026-07-28 fourth blowout): at warn/critical, prune
    // configured cargo targets once per pressure episode, re-measure, and only
    // pause when still critical after prune.
    let diskBlocked = false;
    if (this.deps.diskReader) {
      try {
        let d = await this.deps.diskReader();
        let pressure = evaluateDiskPressure(d?.freeBytes ?? null, d?.totalBytes ?? null);
        if (pressure?.level === 'ok' || pressure === null) {
          this.cargoPrunedThisPressureEpisode = false;
          this.cargoEmptyConfigSkipLoggedThisEpisode = false;
          this.diskPruneNote = null;
        }
        if (
          pressure &&
          (pressure.level === 'warn' || pressure.level === 'critical') &&
          !this.cargoPrunedThisPressureEpisode
        ) {
          const firstPass = await this.runCargoCachePrune('disk-pressure');
          let freedBytes = firstPass.freedBytes;
          const attempted = firstPass.attempted;
          if (attempted) {
            // Latch only after a real prune attempt (freed may be 0).
            this.cargoPrunedThisPressureEpisode = true;
            // Re-measure between passes before deciding pressure escalation.
            d = await this.deps.diskReader();
            pressure = evaluateDiskPressure(d?.freeBytes ?? null, d?.totalBytes ?? null);
            // Still critical after configured retain window → escalate retainDays=0
            // (deps aggression; isolation still honors active-build guard).
            if (pressure?.level === 'critical') {
              console.error(
                formatCargoCachePruneEscalationLogLine({
                  trigger: 'disk-pressure',
                  retainDays: 0,
                }),
              );
              const second = await this.runCargoCachePrune('disk-pressure', undefined, {
                retainDays: 0,
                pressureEscalation: true,
              });
              freedBytes += second.freedBytes;
            }
            if (freedBytes > 0) {
              this.diskPruneNote = formatCargoPruneBannerNote(freedBytes);
            }
          } else if (!this.cargoEmptyConfigSkipLoggedThisEpisode) {
            // No dirs: not an attempt — leave latch clear so a later config works.
            console.error(formatCargoCachePruneSkipNoDirsLogLine());
            this.cargoEmptyConfigSkipLoggedThisEpisode = true;
          }
          // Final df after first pass and optional escalation.
          d = await this.deps.diskReader();
          pressure = evaluateDiskPressure(d?.freeBytes ?? null, d?.totalBytes ?? null);
        }
        this.currentDiskPressure = pressure;
        const hold = toDispatchHold(pressure);
        const level = pressure?.level ?? 'ok';
        if (level !== this.lastDiskLevel) {
          this.lastDiskLevel = level;
          if (level !== 'ok') {
            const pruneBit = this.diskPruneNote ? ` — ${this.diskPruneNote}` : '';
            console.error(
              `[hercules] disk ${level.toUpperCase()}: ${pressure!.usedPct}% used, ` +
                `${Math.round(pressure!.freeBytes / 1024 ** 3)}G free` +
                pruneBit +
                (level === 'critical' ? ' — dispatch PAUSED until space is freed' : ''),
            );
          } else {
            console.error('[hercules] disk pressure cleared — dispatch resumed');
          }
        }
        // Pause decision and hold surface share one pure function (post-prune).
        diskBlocked = hold !== null;
      } catch {
        // unknown reading never blocks; clear stale hold so UI does not lie
        this.currentDiskPressure = null;
      }
    } else {
      this.currentDiskPressure = null;
    }
    if (!diskBlocked) {
      await this.dispatch(dispatchSnapshot, report);
    }

    report.running.push(...this.running);

    // Operator digest: long quiet but alive (cargo/pnpm mid-run honesty).
    const now = clock();
    for (const [taskId, tracked] of this.tracked) {
      const snap = tracked.run.poll(now);
      const osAlive =
        snap.processPid !== undefined ? isOsProcessAlive(snap.processPid) : null;
      const processAlive = resolveProcessAlive({
        processAlive: snap.processAlive === true,
        osAlive,
      });
      if (
        snap.status === 'running' &&
        processAlive &&
        now - snap.lastEventAt >= QUIET_LONG_DIGEST_MS
      ) {
        report.quietLong.push(taskId);
        if (!this.quietLongSeen.has(taskId)) {
          this.quietLongSeen.add(taskId);
          this.sessionQuietLongSightings += 1;
        }
      } else if (snap.status !== 'running') {
        this.quietLongSeen.delete(taskId);
      }
    }
    // Drop counters for tasks no longer tracked.
    for (const id of [...this.quietLongSeen]) {
      if (!this.tracked.has(id)) this.quietLongSeen.delete(id);
    }

    // Freeze session metrics after this tick's thrash/quiet updates.
    (report as { sessionMetrics: TickReport['sessionMetrics'] }).sessionMetrics = {
      thrashParks: this.sessionThrashParks,
      quietLongSightings: this.sessionQuietLongSightings,
    };

    if (report.thrashParked.length > 0 || report.quietLong.length > 0) {
      console.error(
        `[hercules] tick digest: thrashParked=[${report.thrashParked.join(',')}] ` +
          `quiet>30m=[${report.quietLong.join(',')}] running=${report.running.length} ` +
          `session thrash=${this.sessionThrashParks} quietSightings=${this.sessionQuietLongSightings}`,
      );
    }

    // Release reconciler (design §3): staging deploy + verify when main drifts.
    // Runs after task dispatch so merge-stamped tasks are visible in the packet.
    if (this.deps.releaseReconciler) {
      const releaseSnap =
        report.recovered.length > 0 || report.completed.length > 0
          ? await control.read()
          : dispatchSnapshot;
      await this.deps.releaseReconciler.reconcile(releaseSnap, report);
    }

    // Publish post-mutation control state via one final LOCAL read (no second
    // sync). Completions, orphan recovery, heal, dispatch, and release writes
    // must be visible on getState().snapshot / SSE / GET /api/tasks/:id before
    // the next tick. Observer mode returns earlier and keeps its initial snap.
    this.lastSnapshot = await control.read();
    // Per-task holds from the post-mutation snapshot so admitted tasks (now
    // in_progress) are not falsely listed; still runs when disk paused dispatch.
    await this.refreshSchedulingHolds(this.lastSnapshot);
    this.lastReport = report;
    this.emit();

    return report;
  }

  /**
   * A hand-edited repos.yaml or old daemon version may leave an unsafe Guardian
   * repo marked ready. Downgrade before recovery or selection on every restart
   * and whenever config regresses; onboarding/readiness work remains eligible.
   */
  private async enforcePersistedGuardianReadiness(
    snapshot: ControlSnapshot,
  ): Promise<ControlSnapshot> {
    const nextRepos = { ...snapshot.repos.repos };
    const downgraded: string[] = [];
    for (const repo of Object.values(snapshot.repos.repos)) {
      if (
        repo.readiness !== 'ready' ||
        effectiveRepoExecutionPolicy(repo.executionPolicy ?? null).profile !== 'guardian'
      ) continue;
      let receipt: GuardianReadinessReceipt | null = null;
      try {
        receipt = this.deps.guardianReadinessCheck
          ? await this.deps.guardianReadinessCheck(repo)
          : null;
      } catch {
        receipt = null;
      }
      if (receipt?.ok === true) continue;
      nextRepos[repo.key] = { ...repo, readiness: 'incomplete' };
      downgraded.push(repo.key);
      const codes = receipt?.failedCodes.slice(0, 6).join(',') ?? 'preflight_unavailable';
      console.error(`[hercules] guardian readiness fail-closed ${repo.key}: ${codes}`);
    }
    if (downgraded.length === 0) return snapshot;
    await mutateControl(this.deps.control, { repos: { repos: nextRepos } },
      `hercules: guardian readiness fail-closed ${downgraded.sort().join(',')}`,
    );
    return this.deps.control.read();
  }

  /**
   * Human "Deploy staging now" for a repo — bypasses the quiet-period debounce
   * on the next reconciler pass. No-op when the reconciler is not wired.
   */
  requestStagingDeployNow(repoKey: string): void {
    this.deps.releaseReconciler?.requestDeployNow(repoKey);
  }

  private async reconcile(byId: Map<string, Task>, report: TickReport): Promise<void> {
    const { clock, config } = this.deps;
    for (const [taskId, tracked] of this.tracked) {
      let task = byId.get(taskId);

      // Task vanished from disk — nothing to wind down gracefully; tear down now.
      if (!task) {
        await this.teardown(taskId);
        report.tornDown.push(taskId);
        continue;
      }

      // Human cancel: begin a graceful wind-down (SIGTERM, keep the workspace
      // until the agent exits or the deadline forces a kill — Plan 2a).
      if (task.state === 'cancelled') {
        this.beginStopping(taskId, { preserveWorkspace: false });
        report.tornDown.push(taskId);
        continue;
      }

      // Mid-run re-queue (switch-now): disk left in_progress → retrying while the
      // agent is still alive. Stop the process, free the cap slot, keep worktree.
      if (task.state === 'retrying') {
        const live = tracked.run.poll(clock());
        if (live.status === 'running') {
          this.beginStopping(taskId, { preserveWorkspace: true });
          report.tornDown.push(taskId);
          continue;
        }
        // Run already terminal — fall through to normal done/failed handling.
      }

      // Any other terminal state out of band: tear down immediately (unchanged).
      if (isTerminalState(task.state)) {
        await this.teardown(taskId);
        report.tornDown.push(taskId);
        continue;
      }

      const snap = tracked.run.poll(clock());
      if (tracked.adapterKind === 'cursor') {
        const persisted = await this.persistFactoryRunHandles(task, snap);
        if (persisted) {
          task = persisted;
          byId.set(taskId, persisted);
        }
      }
      // Refresh tip for phone liveRuns (best-effort; never fail the tick).
      if (snap.status === 'running') {
        try {
          const tip = (await simpleGit(tracked.workspace.dir).raw(['rev-parse', 'HEAD'])).trim();
          if (tip) tracked.branchTip = tip;
        } catch {
          /* worktree may be mid-rebase */
        }
        // Live-run remote ownership: foreign tip movement parks without burning
        // an implement attempt and without adopting the foreign tip.
        if (await this.parkForeignTaskRefIfMoved(task, tracked, report)) {
          continue;
        }
      }
      if (snap.status === 'done') {
        // Always teardown (untrack) even if complete() throws — otherwise a
        // half-finished complete leaves a done run stuck forever and every later
        // tick dies on illegal retrying→review (task file already rewritten).
        let result: CompleteOutcome = {
          noChanges: false,
          outcome: 'review',
        };
        try {
          result = await this.complete(task, tracked, snap.sessionId);
        } catch (err) {
          console.error(
            `[hercules] ${taskId}: complete failed — ${(err as Error).message}`,
          );
          // Best-effort: park for human if still non-terminal on disk.
          // Fold mid-run queue onto the body first — never leave accepted
          // operator notes only in volatile memory when complete blew up.
          try {
            const fresh = (await this.deps.control.read()).tasks.find((t) => t.id === taskId);
            if (fresh && (fresh.state === 'in_progress' || fresh.state === 'retrying')) {
              const stamp = new Date(this.deps.clock()).toISOString();
              await this.withPendingChatFinalize<void>(taskId, async (drained) => {
                const folded = this.foldDrainedChat({
                  body: fresh.body,
                  stamp,
                  autoPendingSteer: null,
                  setPendingSteer: false,
                  drained,
                  taskId: fresh.id,
                });
                const durable = await this.transition(fresh, 'failed', {
                  endedAt: stamp,
                  lastEventAt: stamp,
                  body: folded.body,
                  pendingSteer: null,
                });
                return { value: undefined, durable };
              });
            }
          } catch (parkErr) {
            console.error(
              `[hercules] ${taskId}: could not park after complete failure — ${(parkErr as Error).message}`,
            );
          }
          result = { noChanges: false, outcome: 'failed' };
        } finally {
          try {
            // Human cancel/delete/missing: discard worktree (cancel teardown).
            // Review/rework/failed/human(todo+steer): preserve the task branch
            // (case study logout: max-attempts deleteBranch wiped a real tip).
            if (result.outcome === 'scope_blocked') {
              await this.teardownRetainingLocalWorkspace(taskId);
            } else if (result.outcome === 'cancelled') {
              await this.teardown(taskId);
            } else {
              await this.teardown(taskId, `hercules: ${task.id} — ${task.title}`);
            }
          } catch (tdErr) {
            console.error(
              `[hercules] ${taskId}: teardown failed — ${(tdErr as Error).message}`,
            );
            this.tracked.delete(taskId); // never leave a zombie track entry
          }
        }
        if (result.outcome === 'review') report.completed.push(taskId);
        else if (result.outcome === 'rework') report.retried.push(taskId);
        else if (result.outcome === 'cancelled') report.tornDown.push(taskId);
        else if (result.outcome === 'human') {
          /* late todo/steer — disk already human-owned; not a verifier failure */
        } else report.failed.push(taskId);
      } else if (snap.status === 'failed') {
        const activityLog = tracked.run.activityLog();
        const finalMessage = tracked.run.finalMessage();
        const deathInput = {
          ...(snap.stderrTail ? { stderrTail: snap.stderrTail } : {}),
          activityTail: activityLog,
          ...(finalMessage ? { finalMessage } : {}),
          ...(snap.exitCode !== undefined ? { exitCode: snap.exitCode } : {}),
          ...(snap.exitSignal !== undefined ? { exitSignal: snap.exitSignal } : {}),
        };
        const deathCause = summarizeAgentDeath(deathInput);
        const evidence = deathEvidenceBlob(deathInput);
        // C3.60: a signal death is the adapter process crashing; two distinct
        // tasks in a row hold that adapter instead of burning the queue.
        if (isSignalExitCode(snap.exitCode) && isAdapterKind(tracked.adapterKind)) {
          const before = adapterCrashHold(this.adapterCrashes, tracked.adapterKind, this.deps.clock());
          this.adapterCrashes = recordAdapterCrash(this.adapterCrashes, {
            adapter: tracked.adapterKind,
            taskId,
            exitCode: snap.exitCode ?? null,
            atMs: this.deps.clock(),
          });
          const opened = adapterCrashHold(this.adapterCrashes, tracked.adapterKind, this.deps.clock());
          if (before === null && opened !== null) {
            console.error(
              `[hercules] adapter ${tracked.adapterKind} HELD until ` +
                `${new Date(opened.untilMs).toISOString()}: ${opened.detail}`,
            );
          }
        }
        let failureActivityLog = activityLog;
        let failureDeathCause = deathCause;
        let failureStderrTail = snap.stderrTail;
        let recoveryStartFailed = false;
        const providerFailure = classifyProviderInfrastructureFailure({
          wasResume: tracked.startInput.resumeSessionId !== undefined,
          evidence: `${evidence}\n${deathCause}`,
        });
        if (
          providerFailure === 'session_missing' &&
          !tracked.sessionRecoveryAttempted &&
          !isHostMutatingClass(resolveExecutionClass(task))
        ) {
          const { adapter } = this.agents.resolve(tracked.adapterKind);
          // Consume the one-shot before provider setup. start() can throw
          // synchronously (home/preflight/spawn); that must not retry forever.
          tracked.sessionRecoveryAttempted = true;
          let run: AgentRun | null = null;
          let recoveryFailure = await this.preparePathLeaseReplacement(tracked);
          try {
            if (recoveryFailure === null) {
              run = adapter.start(tracked.freshStartInput, clock());
            }
          } catch (err) {
            recoveryFailure = err instanceof Error ? err.message : String(err);
          }
          if (run !== null) {
            const bindFailure = await this.bindPathLeaseToReplacement(tracked, run);
            if (bindFailure !== null) {
              run.stop({ force: true });
              run = null;
              recoveryFailure = bindFailure;
            }
          }
          if (recoveryFailure !== null) {
            recoveryStartFailed = true;
            const safe = redactKnownProviderSessions(recoveryFailure, [
              tracked.originalResumeSessionId,
              tracked.run.sessionId,
              task.agentSession,
            ]) ?? 'unknown provider setup error';
            failureActivityLog = [
              ...activityLog,
              `provider session recovery fresh start failed: ${safe}`,
            ];
            failureDeathCause = `provider session recovery fresh start failed: ${safe}`;
            failureStderrTail = [snap.stderrTail, safe].filter(Boolean).join('\n');
            console.error(
              `[hercules] ${taskId}: provider session recovery fresh start failed — normal retry accounting`,
            );
          }
          if (run !== null) {
            tracked.run = run;
            tracked.startInput = tracked.freshStartInput;
            tracked.startedAtMs = clock();
            tracked.aliveHint = null;
            tracked.aliveHintAt = 0;
            tracked.procPrev = null;
            tracked.procCpuPct = null;
            tracked.procRssMb = null;
            const stamp = new Date(clock()).toISOString();
            const note =
              `\n\n## Provider session recovery (${stamp})\n\n` +
              'Provider could not restore the prior session. Started one fresh same-adapter ' +
              'continuation on the preserved branch; functional attempts unchanged.\n';
            await this.transition(task, 'in_progress', {
              agentSession: run.sessionId || null,
              agentSessionAdapter:
                run.sessionId && isAdapterKind(tracked.adapterKind) ? tracked.adapterKind : null,
              lastEventAt: stamp,
              body: `${task.body.trimEnd()}${note}`,
            });
            continue;
          }
        }
        // Same-round soft retry once on transient deaths (5xx / reset / stream
        // interrupt) — does not burn an attempt and does not leave the
        // in_progress→retrying path. Second death falls through to fail().
        // Host/deploy deterministic runs never soft-retry (replay safety).
        if (
          !(tracked.run instanceof HostExecutorRun) &&
          !isHostMutatingClass(resolveExecutionClass(task)) &&
          !recoveryStartFailed &&
          !tracked.transientRetried &&
          isTransientAgentError(evidence || deathCause)
        ) {
          console.error(
            `[hercules] ${taskId}: transient agent death (${deathCause}) — same-round retry (no attempt burn)`,
          );
          const agentKind = tracked.adapterKind;
          const { adapter } = this.agents.resolve(agentKind);
          tracked.transientRetried = true;
          let replacementFailure = await this.preparePathLeaseReplacement(tracked);
          let run: AgentRun | null = null;
          try {
            if (replacementFailure === null) {
              run = adapter.start(tracked.startInput, clock());
            }
          } catch (err) {
            replacementFailure = err instanceof Error ? err.message : String(err);
          }
          if (run !== null) {
            const bindFailure = await this.bindPathLeaseToReplacement(tracked, run);
            if (bindFailure !== null) {
              run.stop({ force: true });
              run = null;
              replacementFailure = bindFailure;
            }
          }
          if (run !== null) {
            tracked.run = run;
            tracked.startedAtMs = clock();
            tracked.aliveHint = null;
            tracked.aliveHintAt = 0;
            tracked.procPrev = null;
            tracked.procCpuPct = null;
            tracked.procRssMb = null;
            // Keep task in_progress; stamp lastEvent so stall clock restarts.
            const stamp = new Date(clock()).toISOString();
            await this.transition(task, 'in_progress', {
              lastEventAt: stamp,
              // Soft retry is a fresh process — drop poisoned session id.
              agentSession: run.sessionId || null,
              agentSessionAdapter:
                run.sessionId && isAdapterKind(tracked.adapterKind)
                  ? tracked.adapterKind
                  : null,
            });
            continue;
          }
          const safeReplacementFailure = replacementFailure ?? 'unknown replacement start failure';
          failureActivityLog = [
            ...failureActivityLog,
            `same-round replacement failed: ${safeReplacementFailure}`,
          ];
          failureDeathCause = `same-round replacement failed: ${safeReplacementFailure}`;
          failureStderrTail = [failureStderrTail, safeReplacementFailure]
            .filter(Boolean)
            .join('\n');
        }
        let thrash = false;
        try {
          thrash = (
            await this.fail(task, {
              kind: 'agent_exit',
              activityLog: failureActivityLog,
              finalMessage,
              deathCause: failureDeathCause,
              ...(snap.exitCode !== undefined ? { exitCode: snap.exitCode } : {}),
              ...(snap.exitSignal !== undefined ? { exitSignal: snap.exitSignal } : {}),
              ...(failureStderrTail ? { stderrTail: failureStderrTail } : {}),
              adapter: tracked.adapterKind,
              workspaceDir: tracked.workspace.dir,
              branchTip: tracked.branchTip,
              factoryPr:
                tracked.adapterKind === 'cursor' ? factoryPrArtifact(snap) : null,
              redactProviderSessionIds: [
                tracked.originalResumeSessionId,
                tracked.run.sessionId,
                snap.sessionId,
                task.agentSession,
              ],
              clearProviderSession: recoveryStartFailed,
              ...(tracked.failoverNote ? { failoverNote: tracked.failoverNote } : {}),
            })
          ).thrashParked;
        } finally {
          await this.commitRunUsage(taskId, snap.usage, clock());
          // Keep branch for retry / human salvage — agent crash mid-work must
          // not delete hercules/<id> (same tip-loss class as logout failed).
          await this.teardown(taskId, `hercules: ${task.id} — ${task.title}`);
        }
        if (thrash) {
          report.thrashParked.push(taskId);
          this.sessionThrashParks += 1;
        }
        const after = (await this.deps.control.read()).tasks.find((t) => t.id === taskId);
        (after?.state === 'failed' ? report.failed : report.retried).push(taskId);
      } else if (snap.status === 'running') {
        // Token/cost hard stop (before stall clocks) when caps are enabled.
        if (config.costCaps.enabled) {
          const verdict = this.observeLiveUsage(taskId, snap.usage);
          this.maybeLogSoftWarn(taskId, verdict);
          if (verdict.level === 'hard') {
            try {
              tracked.run.stop({ force: true });
              await this.failCostCap(task, {
                reasons: verdict.reasons,
                activityLog: [
                  ...tracked.run.activityLog(),
                  `cost-cap hard stop: ${verdict.reasons.join('; ')}`,
                ],
                adapter: tracked.adapterKind,
                workspaceDir: tracked.workspace.dir,
                branchTip: tracked.branchTip,
                ...(snap.usage ? { usage: snap.usage } : {}),
              });
            } finally {
              await this.teardown(taskId, `hercules: ${task.id} — ${task.title}`);
            }
            report.failed.push(taskId);
            continue;
          }
        }

        // Activity sources: stream lastEventAt + processAlive (OS probe when pid
        // known). Long cargo/pnpm silence is not a stall while the child lives;
        // hard maxRunMs still kills deadlocks (domain/stall.ts).
        const osAlive =
          snap.processPid !== undefined ? isOsProcessAlive(snap.processPid) : null;
        const processAlive = resolveProcessAlive({
          processAlive: snap.processAlive === true,
          osAlive,
        });
        const decision = evaluateStall({
          nowMs: clock(),
          lastEventAt: snap.lastEventAt,
          startedAtMs: tracked.startedAtMs,
          processAlive,
          stallTimeoutMs: config.stallTimeoutMs,
          maxRunMs: config.maxRunMs,
        });
        if (decision.action !== 'continue') {
          const force = decision.action === 'hard_max_run';
          let thrash = false;
          try {
            tracked.run.stop({ force });
            // Host executor: wait boundedly for process-group settlement +
            // canonical receipt before fail/teardown (do not race kill).
            if (tracked.run instanceof HostExecutorRun) {
              await Promise.race([
                tracked.run.whenSettled(),
                new Promise<void>((r) => setTimeout(r, HOST_CANCEL_SETTLE_BOUND_MS)),
              ]);
            }
            thrash = (
              await this.fail(task, {
                kind: 'stall',
                activityLog: [...tracked.run.activityLog(), decision.reason],
                finalMessage: tracked.run.finalMessage(),
                ...(snap.exitCode !== undefined ? { exitCode: snap.exitCode } : {}),
                adapter: tracked.adapterKind,
                workspaceDir: tracked.workspace.dir,
                branchTip: tracked.branchTip,
                factoryPr:
                  tracked.adapterKind === 'cursor' ? factoryPrArtifact(snap) : null,
                ...(tracked.failoverNote ? { failoverNote: tracked.failoverNote } : {}),
              })
            ).thrashParked;
          } finally {
            // Stall/fail: still account any reported usage.
            await this.commitRunUsage(taskId, snap.usage, clock());
            await this.teardown(taskId, `hercules: ${task.id} — ${task.title}`);
          }
          if (thrash) {
            report.thrashParked.push(taskId);
            this.sessionThrashParks += 1;
          }
          report.stalled.push(taskId);
        }
      }
    }
  }

  /**
   * Re-queue tasks that are `in_progress` on disk but have no live run here —
   * orphans from a previous daemon instance that crashed or was restarted
   * (SPEC §7: the loop is stateless across restarts). Coding tasks go to
   * `retrying` with cleared timing. **Every** untracked in_progress
   * host_operation / deploy orphan is **replay-blocked** (failed) — including
   * legacy tasks without `host_execution_started_at` — never re-queued to run
   * the approved scope again.
   */
  private async recoverOrphans(
    snapshot: ControlSnapshot,
    trackedAtStart: ReadonlySet<string>,
    report: TickReport,
  ): Promise<void> {
    for (const task of snapshot.tasks) {
      if (task.state === 'in_progress' && !trackedAtStart.has(task.id)) {
        // Orphaned by a crash/restart — the run ended when the daemon died, so
        // stamp endedAt like every other exit from in_progress (startedAt is kept).
        const endedAt = new Date(this.deps.clock()).toISOString();
        if (isHostMutatingClass(resolveExecutionClass(task))) {
          const hadMarker = hasHostExecutionStartMarker(task);
          const body =
            `${task.body.trimEnd()}\n\n## Host operation replay blocked\n\n` +
            (hadMarker
              ? 'Daemon restarted while a deterministic host execution was in progress. '
              : 'Daemon restarted with an untracked in_progress host_operation/deploy task ' +
                '(legacy or pre-marker). ') +
            'Hercules did not retry or resume the approved scope; use the phone approval ' +
            'panel to authorize a fresh run.\n';
          await this.transition(task, 'failed', {
            lastEventAt: endedAt,
            endedAt,
            body,
          });
          report.failed.push(task.id);
          report.recovered.push(task.id);
          continue;
        }
        const attachId = factoryAttachAgentId(task);
        const repo = snapshot.repos.repos[task.repo];
        if (attachId && repo) {
          const attached = await this.reattachRemoteFactory(task, repo, attachId);
          if (attached) {
            report.recovered.push(task.id);
            continue;
          }
        }
        await this.transition(task, 'retrying', { lastEventAt: null, endedAt });
        report.recovered.push(task.id);
      }
    }
  }

  /**
   * The agent reported done. If a verifier is configured (SPEC §9), run it in
   * the worktree, attach the rendered review packet to the task, and move to
   * review. Without a verifier (fake mode), move straight to review.
   *
   * Verify + move to review. `noChanges` is true when the agent changed nothing
   * (caller may discard a worthless branch instead of preserving/pushing it).
   */
  private async complete(
    task: Task,
    tracked: TrackedRun,
    sessionId: string,
  ): Promise<CompleteOutcome> {
    const providerSessionFields: Pick<Task, 'agentSession' | 'agentSessionAdapter'> =
      sessionId.trim().length === 0
        ? { agentSession: null, agentSessionAdapter: null }
        : isAdapterKind(tracked.adapterKind)
          ? { agentSession: sessionId, agentSessionAdapter: tracked.adapterKind }
          : tracked.adapterKind === 'host-executor'
            ? { agentSession: sessionId, agentSessionAdapter: null }
            : { agentSession: null, agentSessionAdapter: null };
    const clearedReviewerRecovery = task.reviewerInfrastructure
      ? { reviewerInfrastructure: null }
      : {};
    if (await this.checkpointSteerBeforeVerification(task, tracked, sessionId)) {
      return { noChanges: false, outcome: 'rework' };
    }
    let body: string | undefined;
    let noChanges = false;
    let verifiedSha: string | null = null;
    let packetNonce: string | null = null;
    let reviewPacket: ReviewPacket | null = null;
    const snapshotPr = factoryPrArtifact(tracked.run.poll(this.deps.clock()));
    const trackedOpen = hasOpenPr(task) ? factoryPrFromUrl(task.prUrl) : null;
    const factoryPr = trackedOpen ?? snapshotPr;
    const skipLocalVerify = tracked.adapterKind === 'cursor';
    if (this.deps.verifier && !skipLocalVerify) {
      // Capture the FULL activity transcript (not the small live tail) + token
      // usage + the agent's final report so the packet records what the agent
      // did, what it cost, and its closing result (the deliverable for a text task).
      const activityLog = tracked.run.activityLog();
      const usage = tracked.run.poll(this.deps.clock()).usage;
      const finalReport = tracked.run.finalMessage();
      // Account spend before packet so cost-cap section sees this run.
      if (usage) this.observeLiveUsage(task.id, usage);
      const costCapSection = this.costCapPacketSection(task.id, usage);
      // First-class cancelable verification phase (not an untracked promise).
      const verifyController = new AbortController();
      const cancelReason = createVerificationCancelReason(false);
      const verifyStartedAt = this.deps.clock();
      this.activeVerifications.set(task.id, {
        controller: verifyController,
        cancelReason,
        startedAtMs: verifyStartedAt,
        phase: 'setup',
        stage: 'starting',
        lastCompletedStage: null,
        processAlive: false,
        cancelRequested: false,
        forced: false,
      });
      this.emit();
      const onVerifyProgress = (update: VerificationProgress): void => {
        const entry = this.activeVerifications.get(task.id);
        if (!entry) return;
        entry.phase = update.phase;
        entry.stage = update.stage;
        if (update.processAlive !== undefined) entry.processAlive = update.processAlive;
        if (update.completedStage !== undefined) {
          entry.lastCompletedStage = update.completedStage;
        }
        this.emit();
      };
      try {
        // Closes the enqueue/check race: the verifier is now registered, so a
        // concurrent queueTaskChat either appears in this checkpoint or aborts
        // the registered controller before any L1 process starts.
        if (await this.checkpointSteerBeforeVerification(task, tracked, sessionId)) {
          return { noChanges: false, outcome: 'rework' };
        }
        // If human already cancelled/deleted (or task vanished) before verify
        // started, abort immediately. todo+pendingSteer still runs verify so the
        // steer race can fold a packet via shouldPreserveHumanRunState.
        const preSnap = await this.deps.control.read();
        const preTask = preSnap.tasks.find((t) => t.id === task.id);
        if (
          !preTask ||
          preTask.state === 'cancelled' ||
          preTask.state === 'deleted'
        ) {
          verifyController.abort(cancelReason);
          throw new VerificationAbortedError(
            `verification skipped — disk is ${preTask?.state ?? 'missing'}`,
          );
        }

        const packet = await this.deps.verifier.verify(task, tracked.repo, tracked.workspace, {
          activityLog,
          ...(usage ? { usage } : {}),
          finalReport,
          runKind: tracked.isSteerResume ? 'steer' : 'implementer',
          signal: verifyController.signal,
          onProgress: onVerifyProgress,
        });
        reviewPacket = packet;

        // A message can arrive after the last gate resolves but before packet
        // finalization observes its abort. Re-check under the same durable
        // snapshot/write/ack boundary and discard this superseded packet.
        if (await this.checkpointSteerBeforeVerification(task, tracked, sessionId)) {
          return { noChanges: packet.noChanges, outcome: 'rework' };
        }

        // Late completion: human may have cancelled/deleted while verify finished.
        const postSnap = await this.deps.control.read();
        const postTask = postSnap.tasks.find((t) => t.id === task.id);
        // Missing or deleted: terminal — discard workspace, never clobber.
        if (!postTask || postTask.state === 'deleted') {
          return {
            noChanges: packet.noChanges,
            outcome: 'cancelled',
          };
        }
        // A completed verifier must not append packets/session metadata after a
        // human cancel. Discard the workspace and leave the cancelled record
        // byte-for-byte under human ownership.
        if (postTask.state === 'cancelled') {
          return {
            noChanges: packet.noChanges,
            outcome: 'cancelled',
          };
        }
        if (
          shouldPreserveHumanRunState({
            currentState: postTask.state,
            expectedFrom: task.state,
            intendedTo: 'review',
            preserveRetrying: isConcurrentAgentSwitch(task.body, postTask),
          })
        ) {
          // Fold packet only; never clobber cancel/steer state. Still fold the
          // mid-run queue into body + pending_steer so operator notes survive.
          const stamp = new Date(this.deps.clock()).toISOString();
          return await this.withPendingChatFinalize<CompleteOutcome>(task.id, async (drained) => {
            const rendered = renderPacketMarkdownWithNonce(packet, {
              ...(costCapSection ? { costCapSection } : {}),
            });
            let durable = await this.writeFinalizePacketOnly(postTask, 'review', {
              body: withReviewPacket(postTask.body, rendered.markdown),
              ...providerSessionFields,
              verifiedSha: packet.verifiedSha,
              verifiedGatesGreen: packet.workflowGatesPassed === true ? true : null,
              packetNonce: rendered.nonce,
              verifiedPathLeaseDigest: pathLeaseDeclarationDigest(task),
            });
            if (drained.combined.text.trim().length > 0) {
              const freshSnap = await this.deps.control.read();
              const fresh = freshSnap.tasks.find((t) => t.id === task.id) ?? postTask;
              const folded = this.foldDrainedChat({
                body: fresh.body,
                stamp,
                autoPendingSteer: fresh.pendingSteer,
                setPendingSteer: true,
                drained,
                taskId: task.id,
              });
              await this.writeTaskCommitted(
                fresh,
                {
                  ...fresh,
                  body: folded.body,
                  pendingSteer: folded.pendingSteer,
                },
                `hercules: ${task.id} fold mid-run chat (kept ${fresh.state})`,
              );
              durable = true;
            }
            return {
              value: {
                noChanges: packet.noChanges,
                // todo/steer/done → preserve, not verifier failure.
                outcome: 'human' as const,
              },
              // Empty queue: ack is a no-op. Non-empty requires a durable fold.
              durable: drained.entries.length === 0 || durable,
            };
          });
        }

        noChanges = packet.noChanges;
        verifiedSha = packet.verifiedSha;
        // Kind-aware policy decides burn / next-eligible / exhaust before banner.
        const verifyKind = packet.autoRework
          ? classifyVerifyFailureKind({ dod: packet.dod, gates: packet.gates })
          : null;
        const reworkDecision = packet.autoRework
          ? decideRetry({
              kind: verifyKind ?? 'verify_l1',
              attempts: task.attempts,
              maxAttempts: this.deps.config.maxAttempts,
              body: task.body,
              nowMs: this.deps.clock(),
              backoffBaseMs: this.deps.config.backoffBaseMs,
            })
          : null;
        const exhausted = reworkDecision?.outcome === 'fail';
        // attemptsExhausted flips the packet banner from "will re-queue" to failed.
        {
          const rendered = renderPacketMarkdownWithNonce(packet, {
            attemptsExhausted: exhausted,
            ...(costCapSection ? { costCapSection } : {}),
          });
          packetNonce = rendered.nonce;
          body = withReviewPacket(task.body, rendered.markdown);
        }
        // Run timeline after packet: L1/L2/L3 + finalize for phone attribution.
        const verifyStamp = new Date(this.deps.clock()).toISOString();
        const timelineSection = renderRunTimelineSection(
          buildVerifyTimeline({
            stamp: verifyStamp,
            startedAt: task.startedAt,
            adapter: tracked.adapterKind,
            activityTail: activityLog,
            gates: packet.gates,
            ...(packet.evidenceRun ? { evidenceRun: { ok: packet.evidenceRun.ok } } : {}),
            reviewerRan: packet.reviewerVerdict !== null,
            reviewerVerdict: packet.reviewerVerdict,
            reviewerSkipReason: packet.reviewerSkipReason,
            green: packet.green,
            autoRework: packet.autoRework,
            ...(tracked.failoverNote ? { failoverNote: tracked.failoverNote } : {}),
          }),
        );
        if (timelineSection) {
          body = `${body.trimEnd()}\n\n${timelineSection}\n`;
        }
        // Commit after packet render so live still counted during section build.
        await this.commitRunUsage(task.id, usage, this.deps.clock());
        // Link steer outcome to the Human steer it answered (trail after packet).
        if (tracked.isSteerResume) {
          body = appendSteerResult(body, {
            completedAt: new Date(this.deps.clock()).toISOString(),
            packet,
          });
        }
        const scopeBlocked = packet.gates.some(
          (gate) => gate.name === 'path-lease-scope' && !gate.passed,
        );
        if (scopeBlocked) {
          const endedAt = new Date(this.deps.clock()).toISOString();
          return await this.withPendingChatFinalize<CompleteOutcome>(task.id, async (drained) => {
            const note =
              `\n\n${PATH_LEASE_SCOPE_BLOCKED_MARKER}\n\n` +
              'Verification stopped before committing or publishing the candidate. ' +
              'The checkout is retained locally for operator recovery; amend the exact ' +
              'path lease only after proving the preserved candidate, then re-verify.\n';
            const folded = this.foldDrainedChat({
              body: `${body}${note}`,
              stamp: endedAt,
              autoPendingSteer: null,
              setPendingSteer: false,
              drained,
              taskId: task.id,
            });
            const durable = await this.transition(task, 'failed', {
              ...providerSessionFields,
              ...clearedReviewerRecovery,
              body: folded.body,
              endedAt,
              lastEventAt: endedAt,
              pendingSteer: null,
              packetNonce,
            });
            return {
              value: { noChanges, outcome: 'scope_blocked' as const },
              durable,
            };
          });
        }
        if (packet.autoRework && reworkDecision) {
          // Verify-only tasks (C3.43 seeded from a ref, read-only agent) judge a
          // tip; a red verdict must not queue an implementer re-dispatch on the
          // same seeded tip — that only burns another full run (C3.50, task 16
          // on 2026-09-12). Terminal with the packet: fix the source branch and
          // verify again from the new tip.
          if (resolveExecutionClass(task) === 'verify') {
            const endedAt = new Date(this.deps.clock()).toISOString();
            return await this.withPendingChatFinalize<CompleteOutcome>(task.id, async (drained) => {
              const folded = this.foldDrainedChat({
                body:
                  `${body}\n\n## Verify-only verdict (${endedAt})\n\n` +
                  'Automated verification failed on the seeded tip. This is a verify-only task ' +
                  '(read-only agent), so Hercules did not queue a rework run; fix the source ' +
                  'branch and create a new verify task from its new tip.\n',
                stamp: endedAt,
                autoPendingSteer: null,
                setPendingSteer: false,
                drained,
                taskId: task.id,
              });
              const durable = await this.transition(task, 'failed', {
                ...providerSessionFields,
                ...clearedReviewerRecovery,
                body: folded.body,
                attempts: reworkDecision.attemptsAfter,
                endedAt,
                lastEventAt: endedAt,
                pendingSteer: null,
                packetNonce,
              });
              return { value: { noChanges, outcome: 'failed' as const }, durable };
            });
          }
          if (isHostMutatingClass(resolveExecutionClass(task))) {
            const endedAt = new Date(this.deps.clock()).toISOString();
            return await this.withPendingChatFinalize<CompleteOutcome>(task.id, async (drained) => {
              const folded = this.foldDrainedChat({
                body:
                  `${body}\n\n## Host operation replay blocked\n\n` +
                  'Automated verification requested rework after a host mutation may have run. ' +
                  'Hercules did not replay it. Use the phone approval panel to authorize a fresh run.\n',
                stamp: endedAt,
                autoPendingSteer: null,
                setPendingSteer: false,
                drained,
                taskId: task.id,
              });
              const durable = await this.transition(task, 'failed', {
                ...providerSessionFields,
                ...clearedReviewerRecovery,
                body: folded.body,
                attempts: reworkDecision.attemptsAfter,
                endedAt,
                lastEventAt: endedAt,
                pendingSteer: null,
                packetNonce,
              });
              return { value: { noChanges, outcome: 'failed' as const }, durable };
            });
          }
          // L3 / L1 / delivery-honesty failed: re-queue with packet as feedback
          // (SPEC §9.3 loop). Prefer cheap steer resume when the packet says so
          // and we still have a session; else full implementer re-dispatch.
          // Preserve branch via caller teardown.
          const attempts = reworkDecision.attemptsAfter;
          const endedAt = new Date(this.deps.clock()).toISOString();
          const deliveryFail = packet.gates.some((g) => g.name === 'delivery' && !g.passed);
          const sessionOk = sessionId.trim().length > 0;
          // Packet chose steer under the assumption a session may exist; without
          // one we must full-dispatch (cannot resume).
          const wantSteer = packet.reworkPath === 'steer' && sessionOk && !exhausted;
          const pathReason =
            wantSteer
              ? (packet.reworkPathReason ?? 'cheap session resume')
              : packet.reworkPath === 'steer' && !sessionOk
                ? 'no agent session to resume — full implementer re-dispatch'
                : (packet.reworkPathReason ?? 'full implementer re-dispatch');
          const accounting = buildReworkAccountingLines({
            kind: reworkDecision.kind,
            accounting: reworkDecision.accounting,
            nextEligibleAt: reworkDecision.nextEligibleAt,
            policySummary: reworkDecision.policySummary,
            attempt: attempts,
            maxAttempts: this.deps.config.maxAttempts,
          });
          // L1 novel/named probe: force into Auto-rework so full re-dispatch sees it last.
          const attributedReq = formatAttributedGateReworkRequirement(
            packet.gateFailAttribution,
          );
          const attributedBlock =
            attributedReq.length > 0
              ? ['', ...attributedReq, ''].join(String.fromCharCode(10))
              : '';
          const reworkNote = exhausted
            ? '\n\n## Attempts exhausted\n\n' +
              `Reached max attempts (${this.deps.config.maxAttempts}). Task is **failed** — ` +
              'branch is preserved for salvage; **Retry** (reset attempts, reuse ' +
              `\`hercules/${task.id}\`) is primary, or use **Clean salvage fork** / raise max attempts.\n\n` +
              accounting +
              '\n'
            : deliveryFail
              ? '\n\n## Auto-rework\n\n**Path: full** — **Delivery check failed** (empty worktree diff and/or false "shipped" claim). ' +
                'Implement the task on the branch so `git diff` vs base is non-empty, or mark the task ' +
                '`hercules:no-diff-ok` / label `analysis` if it is truly Q&A-only. Do not claim 已上线 without files.\n\n' +
                accounting +
                '\n'
              : wantSteer
                ? '\n\n## Auto-rework\n\n' +
                  `**Path: steer** (cheap session resume) — ${pathReason}. ` +
                  'Independent verification failed (see review packet). Fix the L3 notes on resume; ' +
                  'finish with an evidence-only self-assessment.\n\n' +
                  accounting +
                  '\n'
                : '\n\n## Auto-rework\n\n' +
                  `**Path: full** (fresh implementer re-dispatch) — ${pathReason}. ` +
                  'Address the reviewer/gate feedback, then finish again with an evidence-only self-assessment.\n\n' +
                  accounting +
                  '\n';
          // Append attributed L1 probe MUST-fix-first when present.
          const reworkNoteFinal = reworkNote + attributedBlock;
          // Fold mid-run Remote Control queue on EVERY finalize path (including
          // L1/L3 auto-rework / failed). Peek → durable write → ack so a failed
          // commit keeps messages retryable and concurrent enqueues survive.
          return await this.withPendingChatFinalize<CompleteOutcome>(task.id, async (drained) => {
            if (exhausted) {
              const salvage = buildSalvageBrief({
                taskId: task.id,
                maxAttempts: this.deps.config.maxAttempts,
                dimensions: packet.dod,
                cheatFindings: packet.cheatFindings,
                behavioralFailed: packet.gates.some((g) => g.name === 'behavioral' && !g.passed),
                deliveryFailed: deliveryFail,
              });
              const folded = this.foldDrainedChat({
                body: `${body}${reworkNoteFinal}${salvage}`,
                stamp: endedAt,
                autoPendingSteer: null,
                setPendingSteer: false,
                drained,
                taskId: task.id,
              });
              const durable = await this.transition(task, 'failed', {
                ...providerSessionFields,
                ...clearedReviewerRecovery,
                body: folded.body,
                attempts,
                endedAt,
                lastEventAt: endedAt,
                pendingSteer: null,
                packetNonce,
              });
              return { value: { noChanges, outcome: 'failed' as const }, durable };
            }
            const autoSteer = wantSteer ? buildAutoSteerFromPacket(packet) : null;
            // Body always carries the full review packet (incl. L1 gate output)
            // plus drained human chat. Steer-path also merges into pending_steer
            // so the next resume prompt gets L3 notes + operator feedback once.
            const folded = this.foldDrainedChat({
              body: `${body}${reworkNoteFinal}`,
              stamp: endedAt,
              autoPendingSteer: autoSteer,
              setPendingSteer: wantSteer,
              drained,
              taskId: task.id,
            });
            const durable = await this.transition(task, 'retrying', {
              ...providerSessionFields,
              ...clearedReviewerRecovery,
              body: folded.body,
              attempts,
              endedAt,
              lastEventAt: endedAt,
              pendingSteer: folded.pendingSteer,
              packetNonce,
            });
            return { value: { noChanges, outcome: 'rework' as const }, durable };
          });
        }
      } catch (err) {
        // Cancel during verification: never re-queue or clobber human terminal state.
        if (isVerificationAborted(err)) {
          await this.commitRunUsage(task.id, usage, this.deps.clock());
          if (isHumanSteerVerificationCancel(verifyController.signal.reason)) {
            if (await this.checkpointSteerBeforeVerification(task, tracked, sessionId)) {
              return { noChanges: false, outcome: 'rework' };
            }
          }
          const freshSnap = await this.deps.control.read();
          const fresh = freshSnap.tasks.find((t) => t.id === task.id);
          // Missing / deleted / cancelled → cancel teardown (discard workspace).
          if (!fresh || fresh.state === 'deleted' || fresh.state === 'cancelled') {
            await this.discardPendingChatWithAudit(
              task.id,
              fresh?.state === 'deleted' ? 'task deleted' : 'task cancelled',
            );
            console.error(
              `[hercules] ${task.id}: verification aborted — terminal human state ${fresh?.state ?? 'missing'}`,
            );
            return { noChanges: false, outcome: 'cancelled' };
          }
          if (
            shouldPreserveHumanRunState({
              currentState: fresh.state,
              expectedFrom: task.state,
              intendedTo: 'review',
              preserveRetrying: isConcurrentAgentSwitch(task.body, fresh),
            })
          ) {
            // todo+pendingSteer / done — keep human state; still persist mid-run queue.
            return await this.withPendingChatFinalize<CompleteOutcome>(task.id, async (drained) => {
              let durable = false;
              if (drained.combined.text.trim().length > 0) {
                const stamp = new Date(this.deps.clock()).toISOString();
                const folded = this.foldDrainedChat({
                  body: fresh.body,
                  stamp,
                  autoPendingSteer: fresh.pendingSteer,
                  setPendingSteer: true,
                  drained,
                  taskId: task.id,
                });
                await this.writeTaskCommitted(
                  fresh,
                  {
                    ...fresh,
                    body: folded.body,
                    pendingSteer: folded.pendingSteer,
                  },
                  `hercules: ${task.id} fold mid-run chat (kept ${fresh.state})`,
                );
                durable = true;
              }
              console.error(
                `[hercules] ${task.id}: verification aborted — kept human state ${fresh.state}`,
              );
              return {
                value: { noChanges: false, outcome: 'human' as const },
                durable: drained.entries.length === 0 || durable,
              };
            });
          }
          // Abort without human cancel (e.g. internal) — park as failed infra.
          const endedAt = new Date(this.deps.clock()).toISOString();
          return await this.withPendingChatFinalize<CompleteOutcome>(task.id, async (drained) => {
            const folded = this.foldDrainedChat({
              body: withReviewPacket(
                task.body,
                '**❌ Verification aborted**\n\nGate process was cancelled before a review packet.\n',
              ),
              stamp: endedAt,
              autoPendingSteer: null,
              setPendingSteer: false,
              drained,
              taskId: task.id,
            });
            const durable = await this.transition(task, 'failed', {
              ...providerSessionFields,
              body: folded.body,
              endedAt,
              lastEventAt: endedAt,
              pendingSteer: null,
              packetNonce: null,
            });
            return { value: { noChanges: false, outcome: 'failed' as const }, durable };
          });
        }

        if (err instanceof ReviewerInfraError) {
          await this.commitRunUsage(task.id, usage, this.deps.clock());
          const endedAt = new Date(this.deps.clock()).toISOString();
          const fallbackCandidate =
            tracked.branchTip && /^[0-9a-f]{40}$/i.test(tracked.branchTip)
              ? tracked.branchTip
              : null;
          const receipt = err.receipt ?? (fallbackCandidate
            ? buildReviewerInfrastructureReceipt({
                provider: err.provider,
                detail: err.message,
                observedAt: endedAt,
                candidateSha: fallbackCandidate,
                branch: tracked.workspace.branch,
                worktree: tracked.workspace.dir,
                greenEvidence: [],
              })
            : null);
          const receiptMarkdown = receipt
            ? renderReviewerInfrastructureReceipt(receipt)
            : [
                '## Reviewer infrastructure recovery',
                '',
                '**Status:** blocked — infrastructure, not a product verdict',
                `**Provider:** \`${err.provider}\``,
                `**Redacted detail:** ${redactReviewerInfrastructureDetail(err.message)}`,
                `**Next action:** Run reviewer health check or explicitly recover ${err.provider}`,
              ].join('\n');
          return await this.withPendingChatFinalize<CompleteOutcome>(task.id, async (drained) => {
            const folded = this.foldDrainedChat({
              body: `${task.body.trimEnd()}\n\n${receiptMarkdown}\n`,
              stamp: endedAt,
              autoPendingSteer: null,
              setPendingSteer: drained.combined.text.trim().length > 0,
              drained,
              taskId: task.id,
            });
            const durable = await this.transition(task, 'retrying', {
              ...providerSessionFields,
              body: folded.body,
              // Functional attempt accounting is deliberately untouched.
              attempts: task.attempts,
              endedAt,
              lastEventAt: endedAt,
              pendingSteer: folded.pendingSteer,
              ...(receipt
                ? {
                    reviewerInfrastructure: receipt,
                    verifiedSha: receipt.candidateSha,
                  }
                : {}),
            });
            return { value: { noChanges: false, outcome: 'rework' as const }, durable };
          });
        }

        // Infrastructure failure (missing worktree, git crash, …) is NOT a
        // reviewable outcome — parking in human review with a one-line error
        // made Decide look hollow ("not green", no DoD axes). Re-queue so the
        // next dispatch recreates the worktree and re-runs verification.
        await this.commitRunUsage(task.id, usage, this.deps.clock());
        const msg = (err as Error).message;
        const endedAt = new Date(this.deps.clock()).toISOString();

        // Human may have cancelled while infra failed — never clobber.
        {
          const freshSnap = await this.deps.control.read();
          const fresh = freshSnap.tasks.find((t) => t.id === task.id);
          if (
            fresh &&
            shouldPreserveHumanRunState({
              currentState: fresh.state,
              expectedFrom: task.state,
              intendedTo: 'failed',
              preserveRetrying: isConcurrentAgentSwitch(task.body, fresh),
            })
          ) {
            return await this.withPendingChatFinalize<CompleteOutcome>(task.id, async (drained) => {
              let durable = false;
              if (drained.combined.text.trim().length > 0) {
                const folded = this.foldDrainedChat({
                  body: fresh.body,
                  stamp: endedAt,
                  autoPendingSteer: fresh.pendingSteer,
                  setPendingSteer: true,
                  drained,
                  taskId: fresh.id,
                });
                await this.writeTaskCommitted(
                  fresh,
                  {
                    ...fresh,
                    body: folded.body,
                    pendingSteer: folded.pendingSteer,
                  },
                  `hercules: ${task.id} fold mid-run chat (kept ${fresh.state})`,
                );
                durable = true;
              }
              console.error(
                `[hercules] ${task.id}: verify infra fail ignored — kept human state ${fresh.state}`,
              );
              return {
                value: { noChanges: false, outcome: 'failed' as const },
                durable: drained.entries.length === 0 || durable,
              };
            });
          }
        }

        if (isHostMutatingClass(resolveExecutionClass(task))) {
          const hostInfraBody = withReviewPacket(
            task.body,
            '**❌ Verification infrastructure failed after a host operation**\n\n' +
              `\`${msg}\`\n\n` +
              'The command may already have run. Hercules did not replay it; fresh phone approval is required.',
          );
          return await this.withPendingChatFinalize<CompleteOutcome>(task.id, async (drained) => {
            const folded = this.foldDrainedChat({
              body: hostInfraBody,
              stamp: endedAt,
              autoPendingSteer: null,
              setPendingSteer: false,
              drained,
              taskId: task.id,
            });
            const durable = await this.transition(task, 'failed', {
              ...providerSessionFields,
              body: folded.body,
              attempts: task.attempts + 1,
              endedAt,
              lastEventAt: endedAt,
              pendingSteer: null,
              packetNonce: null,
            });
            return { value: { noChanges: false, outcome: 'failed' as const }, durable };
          });
        }
        const decision = decideRetry({
          kind: 'verify_infra',
          attempts: task.attempts,
          maxAttempts: this.deps.config.maxAttempts,
          body: task.body,
          nowMs: this.deps.clock(),
          backoffBaseMs: this.deps.config.backoffBaseMs,
          detail: msg,
        });
        const attempts = decision.attemptsAfter;
        const exhausted = decision.outcome === 'fail';
        const accounting = buildReworkAccountingLines({
          kind: decision.kind,
          accounting: decision.accounting,
          nextEligibleAt: decision.nextEligibleAt,
          policySummary: decision.policySummary,
          attempt: attempts,
          maxAttempts: this.deps.config.maxAttempts,
        });
        const infraBody = withReviewPacket(
          task.body,
          `**❌ Verification infrastructure failed** (not a product verdict)\n\n` +
            `\`${msg}\`\n\n` +
            (exhausted
              ? '_Max attempts / thrash / hard infra — task will fail; branch preserved._'
              : '_Re-queued automatically so the worktree can be recovered and gates re-run._'),
        );
        return await this.withPendingChatFinalize<CompleteOutcome>(task.id, async (drained) => {
          if (exhausted) {
            const folded = this.foldDrainedChat({
              body: `${infraBody}\n\n## Auto-rework\n\n${accounting}\n`,
              stamp: endedAt,
              autoPendingSteer: null,
              setPendingSteer: false,
              drained,
              taskId: task.id,
            });
            const durable = await this.transition(task, 'failed', {
              ...providerSessionFields,
              body: folded.body,
              attempts,
              endedAt,
              lastEventAt: endedAt,
              pendingSteer: null,
              packetNonce: null,
            });
            return { value: { noChanges: false, outcome: 'failed' as const }, durable };
          }
          const folded = this.foldDrainedChat({
            body:
              `${infraBody}\n\n## Auto-rework\n\n` +
              'Verification runner crashed before a review packet. Re-run implementer / verify on recovered branch.\n\n' +
              `${accounting}\n`,
            stamp: endedAt,
            autoPendingSteer: null,
            // Infra rework: surface drained human chat as pending_steer so the
            // next run cannot miss mid-run operator notes.
            setPendingSteer: drained.combined.text.trim().length > 0,
            drained,
            taskId: task.id,
          });
          const durable = await this.transition(task, 'retrying', {
            ...providerSessionFields,
            body: folded.body,
            attempts,
            endedAt,
            lastEventAt: endedAt,
            pendingSteer: folded.pendingSteer,
            packetNonce: null,
          });
          return { value: { noChanges: false, outcome: 'rework' as const }, durable };
        });
      } finally {
        // Clear first-class verification tracking (always — success, rework, abort).
        this.activeVerifications.delete(task.id);
        this.emit();
        // Always prune after verify (green, rework, or infra fail) so cargo
        // deps/incremental from this run cannot accumulate forever.
        await this.runCargoCachePrune('verify-teardown', tracked.repo);
      }
    } else {
      // Fake / no-verifier / Cursor Cloud factory: still account adapter usage.
      const usage = tracked.run.poll(this.deps.clock()).usage;
      await this.commitRunUsage(task.id, usage, this.deps.clock());
      // Deterministic host executor: persist the mechanical receipt even without
      // a verifier so phone/review still see the authoritative outcome.
      // Cursor Cloud / host: finalMessage is provider- or receipt-controlled and
      // is not a rendered review packet — neutralize free text and clear nonce.
      if (isHostMutatingClass(resolveExecutionClass(task)) || skipLocalVerify) {
        const finalReport = tracked.run.finalMessage().trim();
        if (finalReport.length > 0) {
          body = `${task.body.trimEnd()}\n\n${neutralizeUntrustedPacketText(finalReport, { taskId: task.id })}\n`;
        }
        packetNonce = null;
      }
    }
    const endedAt = new Date(this.deps.clock()).toISOString();
    // Remote Control: if the human queued chat mid-run, skip the review wait and
    // re-queue as retrying with pendingSteer (resume session on next dispatch).
    // Peek → durable write → ack so concurrent enqueues and commit failures
    // cannot lose operator notes. in_progress → todo is illegal; retrying is
    // the orchestrator's rework path.
    return await this.withPendingChatFinalize<CompleteOutcome>(task.id, async (drained) => {
      const baseBody = body ?? task.body;
      // Fold first. Requeue only when *fresh* queue content was appended to the
      // body — already-audited delivery instances (partial write or prior fold
      // that failed to ack) must not trigger a redundant later run.
      const folded = this.foldDrainedChat({
        body: baseBody,
        stamp: endedAt,
        autoPendingSteer: null,
        setPendingSteer: true,
        drained,
        taskId: task.id,
      });
      const newChatPersisted = folded.hasFreshBodyContent;
      // Preserve queued chat even when session delivery is unavailable (empty
      // sessionId). Next dispatch uses full assemblePrompt + body audit when
      // resume is impossible; messages must never be dropped on successful fold.
      if (newChatPersisted && !isHostMutatingClass(resolveExecutionClass(task))) {
        const durable = await this.transition(task, 'retrying', {
          ...providerSessionFields,
          ...clearedReviewerRecovery,
          pendingSteer: folded.pendingSteer,
          body: folded.body,
          endedAt,
          // Same control mutation as the fenced packet body (C3.29 review).
          packetNonce,
        });
        return { value: { noChanges, outcome: 'rework' as const }, durable };
      }
      let reviewBody: string | undefined = body;
      if (newChatPersisted && isHostMutatingClass(resolveExecutionClass(task))) {
        const countNote =
          drained.combined.count === 1
            ? '_(recorded after host run; not auto-replayed — fresh host approval required)_'
            : `_(recorded after host run; ${drained.combined.count} messages drained; not auto-replayed — fresh host approval required)_`;
        reviewBody = folded.body.includes('auto from Remote Control queue')
          ? folded.body.replace(
              /_\(auto from Remote Control queue[^)]*\)_/,
              countNote,
            )
          : folded.body;
      } else if (drained.entries.length > 0 && folded.body !== baseBody) {
        reviewBody = folded.body;
      }
      // Already-on-body recovery: still transition (ack queue) without requeue.
      const factoryPrFields = factoryPr
        ? { prUrl: factoryPr.prUrl, prStatus: 'open' as const }
        : {};
      if (verifiedSha !== null && !noChanges && reviewPacket !== null) {
        try {
          await this.deps.verifiedEvidence?.stage({
            task: { id: task.id, repo: task.repo },
            packet: reviewPacket,
            verifiedSha,
            branch: reviewPacket.branch,
            capturedAt: new Date(this.deps.clock()).toISOString(),
          });
        } catch (err) {
          console.error(
            `[hercules] ${task.id}: verified-evidence staging failed — ` +
              `${(err as Error).message} (transition to review continues)`,
          );
        }
      }
      const durable = await this.transition(
        task,
        'review',
        reviewBody === undefined
          ? {
              ...providerSessionFields,
              ...clearedReviewerRecovery,
              ...factoryPrFields,
              endedAt,
              verifiedSha,
              verifiedGatesGreen: reviewPacket?.workflowGatesPassed === true ? true : null,
              packetNonce,
              verifiedPathLeaseDigest: pathLeaseDeclarationDigest(task),
            }
          : {
              ...providerSessionFields,
              ...clearedReviewerRecovery,
              ...factoryPrFields,
              body: reviewBody,
              endedAt,
              verifiedSha,
              verifiedGatesGreen: reviewPacket?.workflowGatesPassed === true ? true : null,
              packetNonce,
              verifiedPathLeaseDigest: pathLeaseDeclarationDigest(task),
            },
      );
      return { value: { noChanges, outcome: 'review' as const }, durable };
    });
  }

  /**
   * The single auditable delivery boundary between implementer completion and
   * verification. Accepted chat is persisted and acknowledged before a fresh
   * continuation can be dispatched; the superseded tip is never verified.
   */
  private async checkpointSteerBeforeVerification(
    task: Task,
    tracked: TrackedRun,
    sessionId: string,
  ): Promise<boolean> {
    if (this.snapshotPendingChat(task.id).entries.length === 0) return false;
    const stamp = new Date(this.deps.clock()).toISOString();
    return this.withPendingChatFinalize<boolean>(task.id, async (drained) => {
      if (drained.entries.length === 0) return { value: false, durable: true };
      const fresh = (await this.deps.control.read()).tasks.find((t) => t.id === task.id);
      if (!fresh || fresh.state === 'cancelled' || fresh.state === 'deleted') {
        return { value: false, durable: false };
      }
      const folded = this.foldDrainedChat({
        body: fresh.body,
        stamp,
        autoPendingSteer: fresh.pendingSteer,
        setPendingSteer: true,
        drained,
        taskId: fresh.id,
      });
      let durable: boolean;
      if (fresh.state === 'in_progress') {
        durable = await this.transition(fresh, 'retrying', {
          agentSession: sessionId.trim().length > 0 ? sessionId : null,
          agentSessionAdapter:
            sessionId.trim().length > 0 && isAdapterKind(tracked.adapterKind)
              ? tracked.adapterKind
              : null,
          pendingSteer: folded.pendingSteer,
          body: folded.body,
          endedAt: stamp,
          lastEventAt: stamp,
        });
      } else {
        // switch-now / human steer already owns state and session fields. Fold
        // only the undelivered messages; never reattach the superseded session.
        await this.writeTaskCommitted(
          fresh,
          { ...fresh, pendingSteer: folded.pendingSteer, body: folded.body },
          `hercules: ${task.id} pre-verify steer checkpoint (kept ${fresh.state})`,
        );
        durable = true;
      }
      return { value: durable, durable };
    });
  }

  /**
   * Resolve cargo target roots (env + optional repo + all repos on disk-pressure)
   * and prune. Never throws into the tick — guard failures are logged inside.
   *
   * `attempted` is false when no dirs are configured (caller must not latch).
   * True after prune runs or throws for configured dirs (freed may be 0).
   */
  private async runCargoCachePrune(
    trigger: 'verify-teardown' | 'disk-pressure',
    repo?: RepoConfig,
    overrides?: {
      readonly retainDays?: number;
      readonly pressureEscalation?: boolean;
      readonly force?: boolean;
    },
  ): Promise<{ freedBytes: number; attempted: boolean }> {
    let attempted = false;
    try {
      const snapshotRepos = this.lastSnapshot?.repos.repos ?? {};
      const repoPaths: (string | null | undefined)[] =
        trigger === 'disk-pressure'
          ? Object.values(snapshotRepos).map((r) => r.cargoTargetDir)
          : [repo?.cargoTargetDir];
      const dirs = resolveCargoTargetDirs({
        envValue: this.deps.cargoTargetEnv,
        repoPaths,
      });
      if (dirs.length === 0) return { freedBytes: 0, attempted: false };
      // Configured roots exist — any further outcome (ok / 0 freed / throw) is an attempt.
      attempted = true;
      const retainDays =
        overrides?.retainDays ??
        this.deps.cargoCacheRetainDays ??
        DEFAULT_CARGO_CACHE_RETAIN_DAYS;
      const pressureEscalation = overrides?.pressureEscalation === true;
      const force = overrides?.force === true;
      const prune =
        this.deps.pruneCargoCaches ??
        ((targetDirs, opts) =>
          pruneCargoCacheTargets(targetDirs, {
            trigger: opts.trigger,
            retainDays: opts.retainDays,
            ...(opts.pressureEscalation === true ? { pressureEscalation: true } : {}),
            ...(opts.force === true ? { force: true } : {}),
          }));
      const { freedBytes } = await prune(dirs, {
        trigger,
        retainDays,
        ...(pressureEscalation ? { pressureEscalation: true } : {}),
        ...(force ? { force: true } : {}),
      });
      return { freedBytes, attempted: true };
    } catch (err) {
      console.error(
        `[hercules] cargo-cache-prune ${trigger} failed: ${(err as Error).message}`,
      );
      // Only latch when dirs were configured (avoid empty-config false latch).
      return { freedBytes: 0, attempted };
    }
  }

  /**
   * Stop a tracked run, release its workspace, and untrack it. Idempotent.
   * With a preserve message, the agent's work is committed and the task branch
   * kept (review + auto-rework paths). Without a message the branch is
   * discarded (hard fail / cancel / stall only — never for empty-diff review).
   * Propagation failures (未传播) and skip-rewind (跳过回卷) are written onto
   * the task timeline — never silent console-only.
   */
  private async teardown(taskId: string, preserveMessage?: string): Promise<void> {
    const tracked = this.tracked.get(taskId);
    try {
      tracked?.run.stop();
      if (preserveMessage !== undefined) {
        const preserveResult = await this.workspaces.preserve(taskId, preserveMessage);
        await this.surfaceMirrorBranchEvents(taskId, preserveResult);
      } else {
        await this.workspaces.remove(taskId);
        // Abandoned work: audit then clear queue (never silent drop of accepted chat).
        await this.discardPendingChatWithAudit(taskId, 'worktree abandoned');
        // Still drain any pending skip-rewind notes from concurrent reconcile.
        await this.surfaceMirrorBranchEvents(taskId, null);
      }
    } finally {
      // Adapter root exit is not process-group exit. The durable store probes
      // the exact bound owner identity atomically with token-checked release.
      if (tracked?.pathLeaseRunToken && this.deps.pathLeaseStore) {
        try {
          const rel = await this.deps.pathLeaseStore.releaseIfOwnerDead(
            tracked.repo.key,
            taskId,
            tracked.pathLeaseRunToken,
          );
          if (!rel.ok && rel.reason !== 'not_found') {
            console.error(
              `[hercules] ${taskId}: path lease release ${rel.reason} — ${rel.detail}`,
            );
          }
        } catch (err) {
          console.error(
            `[hercules] ${taskId}: path lease release failed — ${(err as Error).message}`,
          );
        }
      }
      // Untrack even when preserve/remove throws — zombie tracks wedge the loop.
      this.tracked.delete(taskId);
    }
  }

  /**
   * Scope failures are deliberately neither preserved nor removed: preserve
   * would commit/publish the foreign bytes and remove would destroy recovery
   * evidence. Stop ownership and retain the checkout for an operator.
   */
  private async teardownRetainingLocalWorkspace(taskId: string): Promise<void> {
    const tracked = this.tracked.get(taskId);
    try {
      tracked?.run.stop();
    } finally {
      if (tracked?.pathLeaseRunToken && this.deps.pathLeaseStore) {
        try {
          const rel = await this.deps.pathLeaseStore.releaseIfOwnerDead(
            tracked.repo.key,
            taskId,
            tracked.pathLeaseRunToken,
          );
          if (!rel.ok && rel.reason !== 'not_found') {
            console.error(
              `[hercules] ${taskId}: retained scope-blocked path lease ${rel.reason} — ${rel.detail}`,
            );
          }
        } catch (err) {
          console.error(
            `[hercules] ${taskId}: retained scope-blocked path lease release failed — ${(err as Error).message}`,
          );
        }
      }
      this.tracked.delete(taskId);
    }
  }

  /** Live path-lease run tokens (for stale reclaim after crash/restart). */
  private livePathLeaseTokens(): Set<string> {
    const tokens = new Set<string>();
    for (const t of this.tracked.values()) {
      if (t.pathLeaseRunToken) tokens.add(t.pathLeaseRunToken);
    }
    for (const entry of this.stoppingRuns.values()) {
      if (entry.tracked.pathLeaseRunToken) tokens.add(entry.tracked.pathLeaseRunToken);
    }
    return tokens;
  }

  /**
   * Reclaim path leases whose owners are no longer tracked (daemon restart /
   * crash). Safe no-op when the store is not wired.
   */
  private async reclaimStalePathLeases(snapshot: ControlSnapshot): Promise<void> {
    const store = this.deps.pathLeaseStore;
    if (!store) return;
    const live = this.livePathLeaseTokens();
    const repos = new Set(snapshot.tasks.map((t) => t.repo));
    for (const key of Object.keys(snapshot.repos.repos)) repos.add(key);
    for (const repoKey of repos) {
      try {
        const { reclaimed, uncertain } = await store.reclaimStale(repoKey, live);
        if (reclaimed.length > 0) {
          console.error(
            `[hercules] path lease stale recovery repo=${repoKey}: reclaimed ` +
              reclaimed.map((e) => e.taskId).join(', '),
          );
        }
        if (uncertain.length > 0) {
          console.error(
            `[hercules] path lease recovery held fail-closed repo=${repoKey}: ` +
              `${uncertain.map((e) => e.taskId).join(', ')} owner liveness unknown/live`,
          );
        }
      } catch (err) {
        console.error(
          `[hercules] path lease reclaim failed for ${repoKey}: ${(err as Error).message}`,
        );
      }
    }
  }

  /** Best-effort release when dispatch aborts after acquire but before track. */
  private async releasePathLeaseEarly(
    repoKey: string,
    taskId: string,
    runToken: string | null,
  ): Promise<void> {
    if (!runToken || !this.deps.pathLeaseStore) return;
    try {
      await this.deps.pathLeaseStore.release(repoKey, taskId, runToken);
    } catch (err) {
      console.error(
        `[hercules] ${taskId}: path lease early release failed — ${(err as Error).message}`,
      );
    }
  }

  /** Prove the prior writer dead, then persist the replacement crash window. */
  private async preparePathLeaseReplacement(tracked: TrackedRun): Promise<string | null> {
    if (
      !tracked.pathLeaseRunToken ||
      !this.deps.pathLeaseStore ||
      tracked.adapterKind === 'fake' ||
      tracked.adapterKind === 'host-executor'
    ) return null;
    try {
      const result = await this.deps.pathLeaseStore.prepareReplacement(
        tracked.repo.key,
        tracked.taskId,
        tracked.pathLeaseRunToken,
      );
      return result.ok ? null : result.detail;
    } catch {
      return 'authoritative path-lease replacement preparation failed';
    }
  }

  /** Bind a replacement immediately after start; callers stop it on failure. */
  private async bindPathLeaseToReplacement(
    tracked: TrackedRun,
    run: AgentRun,
  ): Promise<string | null> {
    if (
      !tracked.pathLeaseRunToken ||
      !this.deps.pathLeaseStore ||
      tracked.adapterKind === 'fake' ||
      tracked.adapterKind === 'host-executor'
    ) return null;
    try {
      const pid = run.poll(this.deps.clock()).processPid;
      if (typeof pid !== 'number') return 'replacement adapter did not expose a root process pid';
      const result = await this.deps.pathLeaseStore.bindOwnerProcess(
        tracked.repo.key,
        tracked.taskId,
        tracked.pathLeaseRunToken,
        pid,
      );
      return result.ok ? null : result.reason;
    } catch {
      return 'authoritative path-lease replacement owner bind failed';
    }
  }

  /**
   * Attach mirror-policy events (skip rewind / not propagated) to the relevant
   * task body so the phone packet shows them. Events for other task ids are
   * routed to those tasks when present in the control snapshot.
   */
  private async surfaceMirrorBranchEvents(
    primaryTaskId: string,
    preserveResult:
      | {
          readonly notPropagated: boolean;
          readonly events: readonly string[];
          readonly branchLease?: TaskBranchLease;
        }
      | null
      | void,
  ): Promise<void> {
    const drained =
      typeof this.workspaces.drainMirrorEvents === 'function'
        ? this.workspaces.drainMirrorEvents()
        : [];
    const byTask = new Map<string, string[]>();
    const add = (id: string, msg: string): void => {
      const list = byTask.get(id) ?? [];
      list.push(msg);
      byTask.set(id, list);
    };
    for (const e of drained) {
      const id = e.taskId ?? primaryTaskId;
      add(id, e.message);
    }
    if (preserveResult && preserveResult.events.length > 0) {
      for (const msg of preserveResult.events) {
        // preserve already recorded into drain; avoid duplicate if same text.
        const existing = byTask.get(primaryTaskId) ?? [];
        if (!existing.includes(msg)) add(primaryTaskId, msg);
      }
    }
    if (byTask.size === 0 && !preserveResult?.branchLease) return;

    const stamp = new Date(this.deps.clock()).toISOString();
    let snapshot: ControlSnapshot;
    try {
      snapshot = await this.deps.control.read();
    } catch (err) {
      console.error(
        `[hercules] mirror events: control read failed — ${(err as Error).message}`,
      );
      return;
    }
    const ids = new Set(byTask.keys());
    if (preserveResult?.branchLease) ids.add(primaryTaskId);
    for (const id of ids) {
      const messages = byTask.get(id) ?? [];
      let task = snapshot.tasks.find((t: Task) => t.id === id);
      if (!task) {
        console.error(
          `[hercules] mirror events for unknown task ${id}: ${messages.join('; ')}`,
        );
        continue;
      }
      const lease = id === primaryTaskId ? preserveResult?.branchLease : undefined;
      try {
        if (
          lease &&
          (task.expectedBaseRevision !== lease.expectedBaseRevision ||
            task.expectedRemoteTip !== lease.expectedRemoteTip)
        ) {
          task = await this.writeTaskBranchLeaseCommitted(
            task,
            lease,
            `hercules: ${id} — advance exact task-branch lease`,
          );
        }
        if (messages.length === 0) continue;

        const notProp = messages.some((m) => m.includes('未传播'));
        const body = notProp
          ? appendMirrorBranchNotes(task.body, stamp, messages, { ok: false })
          : appendMirrorBranchNotes(task.body, stamp, messages);
        if (body === task.body) continue;
        const next: Task = { ...task, body };
        await mutateControl(this.deps.control, { writeTasks: [{ expected: task, next }] },
          `hercules: ${id} — mirror branch note (${messages.length})`,
        );
        // Keep snapshot local copy fresh for multi-id loop.
        const idx = snapshot.tasks.findIndex((t: Task) => t.id === id);
        if (idx >= 0) {
          const nextTasks: Task[] = snapshot.tasks.map((t: Task, i: number) =>
            i === idx ? next : t,
          );
          snapshot = { ...snapshot, tasks: nextTasks };
        }
      } catch (err) {
        console.error(
          `[hercules] mirror events write ${id}: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Begin a graceful wind-down of a live run (Plan 2a / switch-now): send
   * SIGTERM, drop it from {@link tracked} (freeing its cap slot at once), and
   * move it into {@link stopping} with a deadline. Workspace removal is deferred
   * to {@link sweepStopping} unless `preserveWorkspace` (mid-run re-queue).
   */
  private beginStopping(
    taskId: string,
    opts: { readonly preserveWorkspace: boolean },
  ): void {
    const tracked = this.tracked.get(taskId);
    if (!tracked) return;
    const usage = tracked.run.poll(this.deps.clock()).usage;
    tracked.run.stop(); // graceful SIGTERM
    this.tracked.delete(taskId);
    this.stoppingRuns.set(taskId, {
      tracked,
      deadline: this.deps.clock() + this.deps.config.gracePeriodMs,
      forced: false,
      preserveWorkspace: opts.preserveWorkspace,
      ...(usage ? { lastUsage: usage } : {}),
    });
  }

  /**
   * Advance each winding-down run (Plan 2a). If the run has exited, finalize:
   * optionally discard the workspace and clear it from {@link stopping}. If the
   * deadline has passed but the run is still alive, escalate to SIGKILL, then
   * finalize. Otherwise keep waiting within the grace window.
   *
   * Host executor: always await {@link HostExecutorRun.whenSettled} boundedly
   * **before** workspace inspect/remove so the canonical receipt is ready and
   * process-group teardown cannot race receipt persistence.
   */
  private async sweepStopping(byId: Map<string, Task>, report: TickReport): Promise<void> {
    const now = this.deps.clock();
    for (const [taskId, entry] of this.stoppingRuns) {
      const snap = entry.tracked.run.poll(now);
      if (snap.usage) entry.lastUsage = snap.usage; // refresh latest spend
      const exited = snap.status !== 'running';
      // Graceful wind-down stays within the grace window. Force-abort (and the
      // deadline path below) must not wait out the full grace before settling —
      // otherwise host receipt persistence races workspace inspect/remove.
      if (!exited && now < entry.deadline && !entry.forced) continue;
      if (!exited) {
        entry.tracked.run.stop({ force: true }); // force-abort or deadline → SIGKILL
        entry.forced = true;
      }

      // Host/deploy: wait for process-tree settlement + final receipt text
      // before any workspace inspect/remove (cancel race fix).
      if (entry.tracked.run instanceof HostExecutorRun) {
        await Promise.race([
          entry.tracked.run.whenSettled(),
          new Promise<void>((resolve) => {
            setTimeout(resolve, HOST_CANCEL_SETTLE_BOUND_MS);
          }),
        ]);
      }

      // Cancellation/switch-now is terminal for this adapter run. Persist its
      // latest cumulative usage before releasing the run key or workspace.
      await this.commitRunUsage(
        taskId,
        entry.lastUsage,
        now,
        entry.tracked.costRunKey,
      );

      // Capture the worktree's git impact BEFORE remove disposes it.
      const impact = await this.workspaces.inspect(taskId);
      if (!entry.preserveWorkspace) {
        await this.workspaces.remove(taskId); // discard the cancelled branch
      }
      // else: switch-now — next dispatch reuses the same worktree/branch.
      this.stoppingRuns.delete(taskId);
      if (entry.tracked.pathLeaseRunToken && this.deps.pathLeaseStore) {
        try {
          await this.deps.pathLeaseStore.releaseIfOwnerDead(
            entry.tracked.repo.key,
            taskId,
            entry.tracked.pathLeaseRunToken,
          );
        } catch (err) {
          console.error(
            `[hercules] ${taskId}: path lease release after stop failed — ${(err as Error).message}`,
          );
        }
      }
      report.tornDown.push(taskId);

      // Append an auditable residue report to the task (a NON-transition write
      // for cancelled; for switch-now the task is already retrying).
      const task = byId.get(taskId);
      if (task && !entry.preserveWorkspace) {
        let body = task.body;
        // Host cancel paths: persist the complete canonical receipt exactly once
        // (full finalMessage — never a truncated generic fail line), then teardown.
        if (entry.tracked.run instanceof HostExecutorRun) {
          const final = entry.tracked.run.finalMessage().trim();
          if (
            final.length > 0 &&
            final.includes(HOST_OP_RECEIPT_HEADING) &&
            !body.includes(HOST_OP_RECEIPT_HEADING)
          ) {
            body = `${body.trimEnd()}\n\n${neutralizeUntrustedPacketText(final, { taskId })}\n`;
          }
        }
        const section = renderTeardownReport({
          method: entry.forced ? 'forced' : 'graceful',
          impact,
          ...(entry.lastUsage ? { usage: entry.lastUsage } : {}),
        });
        const nextBody = `${body.trimEnd()}\n\n${section}`;
        await mutateControl(this.deps.control, { writeTasks: [{ expected: task, next: { ...task, body: nextBody } }] }, `hercules: ${taskId} teardown report`);
        // Keep byId coherent if later logic re-reads the same map entry.
        byId.set(taskId, { ...task, body: nextBody });
        await this.discardPendingChatWithAudit(taskId, 'task cancelled');
      } else if (task && entry.preserveWorkspace) {
        // Light note only — switch-now already wrote an Agent switch section.
        const note =
          `\n\n## Switch stop (${new Date(now).toISOString()})\n\n` +
          `Live agent stopped (${entry.forced ? 'forced' : 'graceful'}); ` +
          `worktree preserved for re-dispatch.\n`;
        await mutateControl(this.deps.control, { writeTasks: [{ expected: task, next: { ...task, body: `${task.body.trimEnd()}${note}` } }] }, `hercules: ${taskId} switch stop`);
      }
    }
  }

  /**
   * Persist Cloud Agent id + PR handle while the factory run is live so a
   * coordinator restart can reattach instead of launching a second agent.
   */
  private async persistFactoryRunHandles(
    task: Task,
    snap: RunSnapshot,
  ): Promise<Task | null> {
    const sessionId = snap.sessionId.trim();
    const sessionChanged =
      sessionId.length > 0 &&
      isValidIdentifier(sessionId) &&
      task.agentSession !== sessionId;
    const pr = factoryPrArtifact(snap);
    const prChanged = pr !== null && !hasOpenPr(task);
    if (!sessionChanged && !prChanged) return null;
    const fields: Partial<Task> = {
      ...(sessionChanged
        ? { agentSession: sessionId, agentSessionAdapter: 'cursor' as const }
        : {}),
      ...(prChanged && pr
        ? { prUrl: pr.prUrl, prStatus: 'open' as const }
        : {}),
    };
    try {
      await this.transition(task, task.state, fields);
    } catch (err) {
      console.error(
        `[hercules] ${task.id}: factory handle persist failed — ${(err as Error).message}`,
      );
      return null;
    }
    const fresh = (await this.deps.control.read()).tasks.find((t) => t.id === task.id);
    return fresh ?? { ...task, ...fields };
  }

  /**
   * Rebuild the in-memory factory run from a persisted Cloud Agent id.
   * GET only — does not POST /v0/agents or /followup.
   */
  private async reattachRemoteFactory(
    task: Task,
    repo: RepoConfig,
    attachId: string,
  ): Promise<boolean> {
    const agentKind = resolveAdapterChain({
      taskAdapter: task.adapter,
      repoAdapter: repo.adapter,
      defaultKind: this.agents.defaultKind,
    });
    if (agentKind !== 'cursor') return false;
    let adapter: AgentAdapter;
    try {
      adapter = this.agents.resolve(agentKind).adapter;
    } catch {
      return false;
    }
    const workspace = remoteFactoryWorkspace({ taskId: task.id, repo: repo.key });
    const executionPolicy = effectiveRepoExecutionPolicy(repo.executionPolicy ?? null);
    const existingFactoryPr = hasOpenPr(task) ? factoryPrFromUrl(task.prUrl) : null;
    const startInput: AgentStartInput = {
      taskId: task.id,
      workspace: workspace.dir,
      prompt: '',
      allocation: workspace.allocation,
      executionPolicy,
      attachFactoryAgentId: attachId,
      ...(repo.url.trim() !== '' ? { repository: repo.url } : {}),
      ...(existingFactoryPr ? { existingFactoryPr } : {}),
    };
    let run: AgentRun;
    try {
      run = adapter.start(startInput, this.deps.clock());
    } catch (err) {
      console.error(
        `[hercules] ${task.id}: factory reattach start failed — ${(err as Error).message}`,
      );
      return false;
    }
    const costRunId = task.costRunId?.trim() || randomUUID();
    this.tracked.set(task.id, {
      taskId: task.id,
      run,
      workspace,
      repo,
      adapterKind: agentKind,
      failoverNote: null,
      isSteerResume: false,
      consumedSteerText: null,
      consumedClientMessageIds: [],
      startedAtMs: this.deps.clock(),
      costRunKey: makeUsageReceiptId(task.id, costRunId),
      startInput,
      freshStartInput: startInput,
      originalResumeSessionId: attachId,
      sessionRecoveryAttempted: false,
      transientRetried: false,
      branchTip: null,
      aliveHint: null,
      aliveHintAt: 0,
      procPrev: null,
      procCpuPct: null,
      procRssMb: null,
      pathLeaseRunToken: null,
    });
    console.error(
      `[hercules] ${task.id}: reattached remote factory Cloud Agent ${attachId} — not a second launch`,
    );
    return true;
  }

  /**
   * Identity-bound Cloud Agent head for an open factory PR.
   * Fail-closed: missing / unsafe / default heads are not launch refs.
   */
  private async observeFactoryPrHead(
    task: Task,
    repo: RepoConfig,
  ): Promise<string | null> {
    const prUrl = task.prUrl?.trim() ?? '';
    if (prUrl.length === 0) return null;
    try {
      const probe = await fetchBoundPrHeadProbe({
        prUrl,
        taskId: task.id,
        repo,
        remoteFactoryPr: true,
        gh: this.deps.gh ?? defaultGhRunner,
      });
      return acceptObservedFactoryHead(probe.headRefName, repo.defaultBranch);
    } catch (err) {
      console.error(
        `[hercules] ${task.id}: factory head observe failed — ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Dispatch a remote Cursor Cloud factory task without local CLI isolation.
   * Launch is independent per task; done still requires a GitHub PR handle.
   */
  private async startRemoteFactoryDispatch(input: {
    readonly task: Task;
    readonly repo: RepoConfig;
    readonly agentKind: AdapterKind;
    readonly failover: ChooseAdapterWithFailoverResult | null;
    readonly failoverNote: string | null;
    readonly workflowBody: string;
    readonly executionPolicy: ReturnType<typeof effectiveRepoExecutionPolicy>;
    readonly report: TickReport;
  }): Promise<void> {
    const { repo, agentKind, failover, failoverNote, workflowBody, executionPolicy, report } =
      input;
    let task = input.task;
    const { clock } = this.deps;
    const workspace = remoteFactoryWorkspace({ taskId: task.id, repo: repo.key });
    const resolvedAgent = this.agents.resolve(agentKind);
    const { adapter } = resolvedAgent;
    const steerComment = task.pendingSteer?.trim() ?? '';
    const resumeId = task.agentSession?.trim() ?? '';
    const sessionOwnedBySelected = task.agentSessionAdapter === agentKind;
    const isSteerResume =
      steerComment.length > 0 && resumeId.length > 0 && sessionOwnedBySelected;
    const consumedClientMessageIds = [
      ...new Set([
        ...extractClientMessageIdsFromBody(steerComment),
        ...extractClientMessageIdsFromBody(task.body),
      ]),
    ];
    for (const id of consumedClientMessageIds) {
      this.rememberChatId(task.id, id);
    }
    const failoverBit =
      failover?.failedOver
        ? ` failover from ${failover.requested}`
        : failover?.note
          ? ' failover-warn'
          : '';
    let durableTask: Task | undefined;
    try {
      durableTask = (await this.deps.control.read()).tasks.find(
        (candidate) => candidate.id === task.id,
      );
    } catch (err) {
      console.error(
        `[hercules] ${task.id}: remote factory binding read failed — ${(err as Error).message}`,
      );
      return;
    }
    if (!durableTask || durableTask.state !== task.state) {
      console.error(
        `[hercules] ${task.id}: durable task changed before remote factory start; retry next tick`,
      );
      return;
    }
    task = durableTask;
    let factoryRef = resolveFactoryLaunchRef({
      defaultBranch: repo.defaultBranch,
      hasOpenPr: hasOpenPr(task),
      pendingSteer: task.pendingSteer,
      body: task.body,
    });
    if (
      factoryLaunchNeedsObservedHead({
        hasOpenPr: hasOpenPr(task),
        pendingSteer: task.pendingSteer,
        body: task.body,
      })
    ) {
      const observed = await this.observeFactoryPrHead(task, repo);
      if (!observed) {
        console.error(
          `[hercules] ${task.id}: skip remote factory dispatch — open PR has no Cloud Agent head`,
        );
        return;
      }
      factoryRef = observed;
      const observedHeadSection = buildFactoryObservedHeadSection({
        stamp: new Date(clock()).toISOString(),
        prUrl: task.prUrl ?? '',
        headRef: observed,
      });
      task = { ...task, body: `${task.body.trimEnd()}\n\n${observedHeadSection}\n` };
    }
    const fullContextTask =
      steerComment.length > 0 && !task.body.includes(steerComment)
        ? {
            ...task,
            body:
              `${task.body.trimEnd()}\n\n## Pending human steer\n\n` +
              `${steerComment}\n`,
          }
        : task;
    const prompt = isSteerResume
      ? assembleSteerPrompt(task, steerComment)
      : assemblePrompt({ workflowBody, task: fullContextTask, allocation: workspace.allocation });
    const existingFactoryPr = hasOpenPr(task) ? factoryPrFromUrl(task.prUrl) : null;
    const startInput: AgentStartInput = {
      taskId: task.id,
      workspace: workspace.dir,
      prompt,
      allocation: workspace.allocation,
      executionPolicy,
      ...(repo.url.trim() !== '' ? { repository: repo.url } : {}),
      ...(factoryRef.trim() !== '' ? { ref: factoryRef } : {}),
      ...(existingFactoryPr ? { existingFactoryPr } : {}),
      ...(isSteerResume ? { resumeSessionId: resumeId } : {}),
      ...(task.fakeBehavior != null ? { fakeBehavior: task.fakeBehavior } : {}),
      ...(task.executionClass != null ? { executionClass: task.executionClass } : {}),
      ...(task.hostCommandScope != null && task.hostCommandScope.length > 0
        ? { hostCommandScope: task.hostCommandScope }
        : {}),
    };
    const freshStartInput: AgentStartInput = {
      ...startInput,
      prompt: assemblePrompt({
        workflowBody,
        task: fullContextTask,
        allocation: workspace.allocation,
      }),
    };
    delete (freshStartInput as { resumeSessionId?: string }).resumeSessionId;
    console.error(
      `[hercules] dispatch ${task.id} → agent=${agentKind} (repo=${repo.key}` +
        `${isSteerResume ? ', resume' : ''}${failoverBit}, remote-factory)`,
    );
    if (failoverNote) {
      console.error(`[hercules] ${task.id}: ${failoverNote}`);
    }
    let run: AgentRun;
    try {
      run = adapter.start(startInput, clock());
    } catch (err) {
      const stamp = new Date(clock()).toISOString();
      const detail = `adapter start failed before remote factory launch: ${(err as Error).message}`;
      await this.transition(task, 'review', {
        body: `${task.body.trimEnd()}\n\n## Adapter start blocked\n\n${detail}\n`,
        endedAt: stamp,
        lastEventAt: stamp,
      });
      report.completed.push(task.id);
      return;
    }
    const dispatchAt = new Date(clock()).toISOString();
    const costRunId = randomUUID();
    const extraBody = [failoverNote ? `## Adapter failover\n\n${failoverNote}` : null]
      .filter((section): section is string => section !== null)
      .join('\n\n');
    const bodyWithExtras =
      extraBody.length > 0 ? `${task.body.trimEnd()}\n\n${extraBody}\n` : task.body;
    try {
      const durable = await this.transition(task, 'in_progress', {
        agentSession: run.sessionId || (isSteerResume ? resumeId : '') || null,
        agentSessionAdapter:
          (run.sessionId || isSteerResume) && isAdapterKind(agentKind) ? agentKind : null,
        pendingSteer: null,
        verifiedSha: null,
        verifiedGatesGreen: null,
        packetNonce: null,
        verifiedPathLeaseDigest: null,
        startedAt: dispatchAt,
        endedAt: null,
        lastEventAt: dispatchAt,
        costRunId,
        body: bodyWithExtras,
      });
      if (!durable) {
        run.stop({ force: true });
        console.error(
          `[hercules] ${task.id}: task disappeared after remote factory start; writer stopped`,
        );
        return;
      }
    } catch (err) {
      run.stop({ force: true });
      console.error(
        `[hercules] ${task.id}: durable in-progress transition failed after remote factory start; ` +
          `writer stopped — ${(err as Error).message}`,
      );
      return;
    }
    this.tracked.set(task.id, {
      taskId: task.id,
      run,
      workspace,
      repo,
      adapterKind: String(agentKind),
      failoverNote,
      isSteerResume,
      consumedSteerText: steerComment.length > 0 ? steerComment : null,
      consumedClientMessageIds,
      startedAtMs: clock(),
      costRunKey: makeUsageReceiptId(task.id, costRunId),
      startInput,
      freshStartInput,
      originalResumeSessionId: startInput.resumeSessionId ?? null,
      sessionRecoveryAttempted: false,
      transientRetried: false,
      branchTip: null,
      aliveHint: null,
      aliveHintAt: 0,
      procPrev: null,
      procCpuPct: null,
      procRssMb: null,
      pathLeaseRunToken: null,
    });
    report.dispatched.push(task.id);
  }

  private async dispatch(snapshot: ControlSnapshot, report: TickReport): Promise<void> {
    const { config, clock } = this.deps;
    const effective = await this.resolveCaps();
    this.deps.onEffectiveCaps?.(effective);

    // Daily hard cap or untrusted durable state: no new dispatches this tick.
    const ledgerBlocked = this.isCostLedgerBlocking();
    const dayHard = isDailyHardBlocked(config.costCaps, this.daySpend(clock()));
    if (config.costCaps.enabled && (ledgerBlocked || dayHard)) {
      const dayKey = new Date(clock()).toISOString().slice(0, 10);
      if (this.dailyHardLoggedDay !== dayKey) {
        this.dailyHardLoggedDay = dayKey;
        if (ledgerBlocked) {
          console.error(
            `[hercules] cost-cap ledger fail-closed: ` +
              `${this.costLedgerDiagnostics.note ?? this.costLedgerDiagnostics.status}; ` +
              'skipping new dispatches',
          );
        } else {
          const day = this.daySpend(clock());
          console.error(
            `[hercules] cost-cap daily hard block: day=$${day.costUsd.toFixed(2)} ` +
              `tokens=${day.inputTokens + day.outputTokens} — skipping new dispatches`,
          );
        }
      }
      return;
    }

    // Every task admitted but not started is excluded for the rest of this
    // tick. Re-selection then fills the unused slot without letting a stale
    // high-priority candidate monopolize each admission wave.
    const considered = new Set<string>();
    const runningForSelect = (): Set<string> => new Set(this.tracked.keys());
    const pickEligible = (): Task[] =>
      selectEligible({
        tasks: snapshot.tasks,
        repos: snapshot.repos,
        runningTaskIds: runningForSelect(),
        excludeTaskIds: considered,
        provisionBackoff: this.provisionBackoff,
        adapterCrashHolds: adapterCrashHolds(this.adapterCrashes, clock()),
        globalCap: effective.globalCap,
        defaultKind: this.agents.defaultKind,
        backoffBaseMs: config.backoffBaseMs,
        now: clock(),
      });

    let eligible = pickEligible();
    // Process admission waves until the cap is full or every eligible task was
    // either started or rejected before start.
    while (eligible.length > 0) {
    for (const selectedTask of eligible) {
      if (considered.has(selectedTask.id)) continue;
      considered.add(selectedTask.id);
      let task = selectedTask;
      const repo = snapshot.repos.repos[task.repo];
      if (!repo) continue; // selectEligible already filtered, but stay defensive

      // Exact candidate is parked behind reviewer health. Repeated ticks and
      // daemon restarts must not turn an infrastructure outage into agent work.
      if (task.reviewerInfrastructure?.state === 'blocked') {
        continue;
      }


      // Per-task hard cap already spent — do not re-dispatch (human Retry after raise).
      if (
        config.costCaps.enabled &&
        isTaskHardBlocked(config.costCaps, this.taskSpend(task.id))
      ) {
        console.error(
          `[hercules] cost-cap skip dispatch ${task.id}: per-task hard cap already reached`,
        );
        continue;
      }

      // Pre-dispatch fail-fast: body explicitly names a protected path and the
      // operator did not force. Park to review with a clear note — never burn
      // an agent + full L1/L3 only to die at L5 (orbit-guard-count-reconcile).
      // WORKFLOW is read from the trusted mirror (same source as L5).
      let workflowBody = '';
      let protectedPaths: readonly string[] = [];
      try {
        const workflowContent = await this.workspaces.readWorkflow(repo);
        if (workflowContent) {
          const wf = parseWorkflow(workflowContent);
          workflowBody = wf.body;
          protectedPaths = wf.protectedPaths;
        }
      } catch (err) {
        console.error(`[hercules] ${task.id}: unreadable WORKFLOW.md — ${(err as Error).message}`);
      }
      if (protectedPaths.length > 0 && !hasForceProtectedPath(task)) {
        const mentions = findProtectedPathMentions(task.body, protectedPaths);
        if (mentions.length > 0) {
          const msg = formatProtectedPathBlockMessage(mentions);
          const stamp = new Date(clock()).toISOString();
          const note =
            `\n\n## Protected path (pre-dispatch)\n\n${msg}\n\n` +
            `_Parked at ${stamp} before any agent run. Human-only change, or ` +
            `re-create with \`force: true\` (audit-stamped) if intentional._\n`;
          console.error(`[hercules] ${task.id}: protected-path fail-fast — ${msg}`);
          await this.transition(task, 'review', {
            body: `${task.body.trimEnd()}${note}`,
            endedAt: stamp,
            lastEventAt: stamp,
          });
          report.completed.push(task.id);
          continue;
        }
      }

      // task.adapter → repo.adapter → daemon default, then provider failover.
      // Host/deploy classes skip LLM adapters entirely (deterministic executor).
      const nowMs = clock();
      const hostOp = isHostMutatingClass(resolveExecutionClass(task));
      let agentKind: AdapterKind = this.agents.defaultKind;
      let failoverNote: string | null = null;
      let failover: ChooseAdapterWithFailoverResult | null = null;
      if (!hostOp) {
        const resolved = this.resolveDispatchAdapter(task, repo.adapter, nowMs, repo);
        agentKind = resolved.kind;
        failover = resolved.decision;
        failoverNote = resolved.decision.note;
        const blockedProviders = new Set(
          reviewerProviderHealth(
            snapshot.tasks
              .map((candidate) => candidate.reviewerInfrastructure)
              .filter((receipt): receipt is NonNullable<typeof receipt> => receipt != null),
          )
            .filter((health) => health.state === 'blocked')
            .map((health) => health.provider),
        );
        if (blockedProviders.size > 0) {
          console.error(
            `[hercules] ${task.id}: reviewer provider ${[...blockedProviders].join(',')} is blocked; no dispatch that would reach known-bad L3`,
          );
          continue;
        }
      }

      // Atomic dependency gate recheck immediately before workspace provision.
      // selectEligible already filtered metadata; this closes the race where
      // Approve lands without Merge Selected, and proves gate-merge ancestry
      // on the trusted default branch. Labels / UI / prose cannot bypass this.
      let expectedBaseTip: string | null = null;
      {
        const recheck = await this.recheckDependencyGate(
          task,
          snapshot.tasks,
          snapshot.repos,
        );
        if (recheck.hold) {
          console.error(
            `[hercules] ${task.id}: dependency gate hold ${recheck.hold.code} ` +
              `(dep=${recheck.hold.id}) — ${recheck.hold.remediation}`,
          );
          continue;
        }
        expectedBaseTip = recheck.expectedBaseTip;
      }

      // Unblocked tasks have no dependency proof from which to inherit a base
      // tip. An amended preserved candidate whose durable plan already names
      // current default still needs exact-tip recovery before create(): obtain
      // the authoritative Git snapshot now, then re-read it after recovery and
      // again at path-lease acquisition to retain the TOCTOU checks. An
      // ordinary stale plan must remain unseeded for stale_base rejection.
      if (
        expectedBaseTip === null &&
        task.startedAt !== null &&
        task.expectedBaseRevision !== undefined &&
        task.expectedRemoteTip != null &&
        this.workspaces.exactCandidateContainsBase
      ) {
        try {
          const trustedSnapshot =
            await this.workspaces.readTrustedDefaultRevisionSnapshot?.(repo);
          const trustedTip = trustedSnapshot?.revision.trim().toLowerCase();
          if (
            trustedTip &&
            task.plannedBaseRevision?.toLowerCase() === trustedTip
          ) {
            expectedBaseTip = trustedTip;
          }
        } catch {
          // The authoritative path-snapshot block below emits the durable
          // diagnosis. Without a proof, recovery remains fail-closed here.
        }
      }

      const parkRecovery = async (
        code: string,
        detail: string,
        nextAction: string,
      ): Promise<void> => {
        const safeDetail = redactDependencyRecoveryText(detail, 700);
        const safeNextAction = redactDependencyRecoveryText(nextAction, 300);
        const stamp = new Date(clock()).toISOString();
        const receipt = withDependencyRecoveryHold(task.body, {
          code,
          trustedTip: expectedBaseTip!,
          candidateTip: task.expectedRemoteTip ?? null,
          detail: safeDetail,
          nextAction: safeNextAction,
          observedAt: stamp,
        });
        console.error(
          `[hercules] ${task.id}: dependency preflight recovery hold ${code} ` +
            `(fingerprint=${receipt.fingerprint.slice(0, 12)}, ` +
            `${receipt.changed ? 'emitted' : 'deduplicated'}) — ${safeDetail}`,
        );
        await this.transition(task, 'review', {
          body: receipt.body,
          endedAt: stamp,
          lastEventAt: stamp,
        });
        report.completed.push(task.id);
      };

      // A crash can land after durable base/null-tip acquisition but before
      // the first adapter byte or candidate publication. Admit only that exact
      // window: authoritative Git must prove the trusted tip, local branch,
      // managed checkout and absent/base-only remote ref remained empty and
      // stable. Undefined means no proof was admitted; null is a proved-absent
      // remote ref and must remain distinguishable.
      let provenEmptyRemoteTip: string | null | undefined;
      const durableEmptyLeaseBase = task.expectedBaseRevision;
      if (
        expectedBaseTip !== null &&
        task.startedAt !== null &&
        task.expectedRemoteTip === null &&
        typeof durableEmptyLeaseBase === 'string' &&
        durableEmptyLeaseBase.toLowerCase() === expectedBaseTip.toLowerCase()
      ) {
        if (!this.workspaces.proveEmptyTaskLease) {
          await parkRecovery(
            'empty_lease_proof_unavailable',
            'the workspace provider cannot prove a read-only empty first-dispatch lease',
            'Restore the bounded Git empty-lease proof capability before retrying.',
          );
          continue;
        }
        const selectedMetadata = task;
        const proof = await this.workspaces.proveEmptyTaskLease(
          repo,
          task.id,
          durableEmptyLeaseBase,
        );
        let freshAfterProof: Task | undefined;
        try {
          freshAfterProof = (await this.deps.control.read()).tasks.find(
            (candidate) => candidate.id === task.id,
          );
        } catch {
          freshAfterProof = undefined;
        }
        if (!freshAfterProof || !isDeepStrictEqual(freshAfterProof, selectedMetadata)) {
          if (freshAfterProof) task = freshAfterProof;
          await parkRecovery(
            'task_metadata_changed',
            'durable task metadata changed during empty-lease observation',
            'Retry only after the durable task record and exact lease stabilize.',
          );
          continue;
        }
        if (proof.kind === 'held') {
          await parkRecovery(
            proof.code,
            proof.detail,
            'Inspect the managed workspace and exact task ref; preserve or salvage unique work explicitly.',
          );
          continue;
        }
        provenEmptyRemoteTip = proof.remoteTip;
      }

      let exactCandidateNeedsRecovery = false;
      if (
        expectedBaseTip !== null &&
        task.startedAt !== null &&
        task.expectedRemoteTip != null &&
        task.expectedBaseRevision?.toLowerCase() === expectedBaseTip.toLowerCase() &&
        this.workspaces.exactCandidateContainsBase
      ) {
        try {
          exactCandidateNeedsRecovery =
            await this.workspaces.exactCandidateContainsBase(
              repo,
              task.id,
              task.expectedRemoteTip,
              expectedBaseTip,
            ) !== true;
        } catch {
          exactCandidateNeedsRecovery = true;
        }
      }

      // A preserved exact candidate may predate a newly gate-merged dependency
      // even after an authenticated amendment has migrated both durable base
      // fields to current. Prove containment from the immutable candidate, not
      // from metadata alone, before deciding whether recovery is required.
      // Recover it before provisioning; create() intentionally refuses a branch
      // that does not contain the exact trusted tip.
      if (
        provenEmptyRemoteTip === undefined &&
        expectedBaseTip !== null &&
        task.startedAt !== null &&
        (
          task.expectedBaseRevision === undefined ||
          task.expectedRemoteTip == null ||
          task.expectedBaseRevision.toLowerCase() !== expectedBaseTip.toLowerCase() ||
          exactCandidateNeedsRecovery
        )
      ) {
        if (task.expectedBaseRevision === undefined || task.expectedRemoteTip == null) {
          await parkRecovery(
            'exact_lease_missing',
            'preserved dependency-gated work has no complete exact task-branch lease',
            'Inspect the preserved local/remote branch and explicitly acquire or salvage an exact lease.',
          );
          continue;
        }

        if (!this.deps.autoRebase) {
          await parkRecovery(
            'auto_rebase_disabled',
            `preserved candidate is based at ${task.expectedBaseRevision.slice(0, 12)}, ` +
              `before trusted tip ${expectedBaseTip.slice(0, 12)}`,
            'Enable HERCULES_AUTO_REBASE=1 or manually rebase the preserved task branch.',
          );
          continue;
        }
        if (!this.workspaces.recoverStaleTaskBranch) {
          await parkRecovery(
            'recovery_unavailable',
            'the workspace provider cannot perform exact-lease stale-candidate recovery',
            'Restore the Git workspace recovery capability before retrying.',
          );
          continue;
        }

        const recovered = await this.workspaces.recoverStaleTaskBranch(
          repo,
          task.id,
          expectedBaseTip,
          {
            expectedBaseRevision: task.expectedBaseRevision,
            expectedRemoteTip: task.expectedRemoteTip,
          },
        );
        if (recovered.kind === 'held') {
          await parkRecovery(recovered.code, recovered.detail, recovered.nextAction);
          continue;
        }
        try {
          task = await this.writeTaskBranchLeaseCommitted(
            task,
            recovered.lease,
            `hercules: ${task.id} recover stale dependency-gated exact lease`,
          );
        } catch (err) {
          const receiptFailure = redactDependencyRecoveryText((err as Error).message, 300);
          const rollback = this.workspaces.rollbackStaleTaskBranchRecovery
            ? await this.workspaces.rollbackStaleTaskBranchRecovery(
                repo,
                task.id,
                {
                  expectedBaseRevision: task.expectedBaseRevision!,
                  expectedRemoteTip: task.expectedRemoteTip!,
                },
                recovered.lease,
              )
            : {
                kind: 'held' as const,
                code: 'recovery_failed' as const,
                detail: 'workspace provider cannot compensate a published recovery',
                nextAction: 'Inspect both task tips and restore an exact durable lease before retrying.',
              };
          const rollbackDetail = redactDependencyRecoveryText(rollback.detail, 300);
          console.error(
            `[hercules] ${task.id}: stale recovery lease receipt failed; ` +
              `rollback=${rollback.kind} — ${receiptFailure}; ${rollbackDetail}`,
          );
          await parkRecovery(
            rollback.kind === 'rolled_back'
              ? 'lease_receipt_failed_rolled_back'
              : 'lease_receipt_failed_rollback_held',
            `Durable lease receipt failed (${receiptFailure}); compensation: ${rollbackDetail}`,
            rollback.kind === 'rolled_back'
              ? 'Retry only after the durable control plane is healthy; both exact task refs were restored.'
              : rollback.nextAction,
          );
          continue;
        }

        // Recovery changes the candidate and consumes time: repeat the complete
        // gate proof and require the default tip to remain identical.
        const reproved = await this.recheckDependencyGate(task, snapshot.tasks, snapshot.repos);
        let reprovedBaseTip = reproved.expectedBaseTip;
        if (!reproved.hold && reprovedBaseTip === null) {
          try {
            const trustedSnapshot =
              await this.workspaces.readTrustedDefaultRevisionSnapshot?.(repo);
            reprovedBaseTip = trustedSnapshot?.revision.trim().toLowerCase() ?? null;
          } catch {
            reprovedBaseTip = null;
          }
        }
        if (
          reproved.hold ||
          reprovedBaseTip === null ||
          reprovedBaseTip.toLowerCase() !== expectedBaseTip.toLowerCase()
        ) {
          await parkRecovery(
            'base_moved_after_recovery',
            reproved.hold
              ? `dependency proof changed after recovery: ${reproved.hold.code} (${reproved.hold.id})`
              : `trusted tip changed after recovery to ${reprovedBaseTip ?? '(unknown)'}`,
            'Retry after dependency ancestry and the trusted default tip stabilize.',
          );
          continue;
        }
        expectedBaseTip = reprovedBaseTip;
      }

      // Path/writer leases: server-side acquire before any adapter (or even
      // worktree provision when possible). Labels/UI cannot bypass this.
      let pathLeaseRunToken: string | null = null;
      const pathLeaseStore = this.deps.pathLeaseStore;
      const executionPolicy = effectiveRepoExecutionPolicy(repo.executionPolicy ?? null);
      // Reject an adapter/policy mismatch before requiring the lease service;
      // both are fail-closed boundaries, but this keeps the policy diagnosis
      // authoritative when the policy itself can never be enforced.
      const policyCheck = hostOp
        ? { ok: true as const }
        : resolvePolicyAgainstAdapter(agentKind, executionPolicy);
      if (!policyCheck.ok) {
        const reason = formatPolicyEnforceFailure(policyCheck);
        console.error(`[hercules] ${task.id}: ${reason}`);
        const stamp = new Date(clock()).toISOString();
        const capabilityReceipt = formatPolicyCapabilityReceipt({
          adapter: agentKind,
          result: policyCheck,
          stamp,
        });
        await this.transition(task, 'review', {
          endedAt: stamp,
          lastEventAt: stamp,
          body:
            `${task.body.trimEnd()}\n\n## Execution policy blocked (pre-dispatch)\n\n` +
            `${reason}\n\n` +
            `${capabilityReceipt}` +
            `_Parked at ${stamp} before any agent run. No agent was started. ` +
            'Choose a compatible adapter or fix the repository execution_policy ' +
            '(Guardian-grade policies fail closed)._\n',
        });
        report.completed.push(task.id);
        continue;
      }
      // Cursor Cloud factory: remote executor owns the Cloud Agent + PR.
      // Do not allocate a local worktree, port, or path-lease writer slot.
      if (!hostOp && !adapterNeedsLocalWorkspace(agentKind)) {
        await this.startRemoteFactoryDispatch({
          task,
          repo,
          agentKind,
          failover,
          failoverNote,
          workflowBody,
          executionPolicy,
          report,
        });
        continue;
      }
      const leasePolicy = pathLeasePolicyFor(executionPolicy);
      const needsPathLeaseSnapshot =
        leasePolicy.requireDeclarations ||
        task.plannedBaseRevision !== undefined ||
        task.affectedPaths !== undefined ||
        task.protectedPathsSnapshot !== undefined;
      if (needsPathLeaseSnapshot && !pathLeaseStore) {
        const detail = 'authoritative path-lease store unavailable';
        await this.parkPermanentPathLeaseBlock(
          task,
          {
            reason: 'store_unavailable',
            detail,
            message: detail + '.',
            footer: '',
          },
          report,
        );
        continue;
      }
      if (pathLeaseStore) {
        const maxWriters = effectivePathWriterLimit(repo.maxConcurrent, leasePolicy);
        let trustedBase =
          expectedBaseTip && expectedBaseTip.trim().length > 0
            ? expectedBaseTip.trim().toLowerCase()
            : '';
        let leaseProtectedPaths = protectedPaths;
        if (needsPathLeaseSnapshot) {
          try {
            const trustedSnapshot =
              await this.workspaces.readTrustedDefaultRevisionSnapshot?.(repo);
            if (!trustedSnapshot) {
              throw new Error('trusted default revision is unavailable');
            }
            const snapshotTip = trustedSnapshot.revision.trim().toLowerCase();
            if (trustedBase && trustedBase !== snapshotTip) {
              console.error(
                `[hercules] ${task.id}: trusted path snapshot moved during dependency proof; retry next tick`,
              );
              continue;
            }
            trustedBase = snapshotTip;
            expectedBaseTip = snapshotTip;
            if (trustedSnapshot.workflowContent === null) {
              // First-time one-file WORKFLOW bootstrap only — otherwise fail closed.
              const bootstrapOk = isFirstTimeWorkflowBootstrap({
                trustedRevision: snapshotTip,
                workflowContent: null,
                repoReadiness: repo.readiness,
                labels: task.labels,
                plannedBaseRevision: task.plannedBaseRevision,
                affectedPaths: task.affectedPaths,
                protectedPathsSnapshot: task.protectedPathsSnapshot,
                configuredWorkflowPath: repo.workflow,
              });
              if (!bootstrapOk) {
                throw new Error('trusted default revision or WORKFLOW is unavailable');
              }
              leaseProtectedPaths = [];
              workflowBody = '';
            } else {
              const trustedWorkflow = parseWorkflow(trustedSnapshot.workflowContent);
              leaseProtectedPaths = trustedWorkflow.protectedPaths;
              workflowBody = trustedWorkflow.body;
            }
          } catch (err) {
            const detail = `trusted path-lease snapshot unavailable: ${(err as Error).message}`;
            await this.parkPermanentPathLeaseBlock(
              task,
              {
                reason: 'protected_path_drift',
                detail,
                message: formatPathLeaseBlockMessage('protected_path_drift', detail),
                footer: '',
              },
              report,
            );
            continue;
          }
        }
        const runToken = randomUUID();
        const acquire = await pathLeaseStore.acquire(repo.key, {
          taskId: task.id,
          runToken,
          declaredBaseRevision: task.plannedBaseRevision,
          declaredPaths: task.affectedPaths,
          declaredProtectedSnapshot: task.protectedPathsSnapshot,
          trustedBaseRevision: trustedBase,
          currentProtectedPaths: leaseProtectedPaths,
          maxWriters,
          requireDeclarations: leasePolicy.requireDeclarations,
          acquiredAtMs: clock(),
        });
        if (!acquire.ok) {
          const msg = formatPathLeaseBlockMessage(acquire.reason, acquire.detail);
          // Transient contention: leave todo/retrying so the next tick can
          // acquire when the writer finishes. Permanent plan defects park.
          if (
            acquire.reason === 'writer_limit' ||
            acquire.reason === 'path_overlap' ||
            acquire.reason === 'prior_run_held'
          ) {
            // Deduped diagnostics: same blocker fingerprint re-emits only after
            // a bounded interval; a changed fingerprint logs immediately.
            const fp = `${task.id}|${acquire.reason}|${acquire.detail}`;
            if (
              shouldEmitRateLimitedLog(
                this.pathLeaseBlockLogRate,
                fp,
                clock(),
              )
            ) {
              console.error(
                `[hercules] ${task.id}: path lease blocked — ${acquire.reason}: ${acquire.detail}`,
              );
            }
            continue;
          }
          // Permanent path-lease defect: park without thrashing the tick.
          await this.parkPermanentPathLeaseBlock(
            task,
            {
              reason: acquire.reason,
              detail: acquire.detail,
              message: msg,
            },
            report,
          );
          continue;
        }
        // Durable entry only when scopes non-empty (legacy no-op leaves none).
        if (acquire.entry.scopes.length > 0) {
          pathLeaseRunToken = runToken;
        }
      }

      let workspace;
      try {
        // A task that never ran owns no prior branch work — provisioning must
        // not "recover" foreign commits for it (2026-07-15 contamination).
        // Explicit clean-salvage forks stamp salvageSourceSha and seed from it;
        // verify-from-ref tasks (C3.43) stamp seedFromSha the same way.
        const salvageSha =
          typeof task.seedFromSha === 'string' && task.seedFromSha.length > 0
            ? task.seedFromSha
            : typeof task.salvageSourceSha === 'string' && task.salvageSourceSha.length > 0
              ? task.salvageSourceSha
              : undefined;
        // hadPriorWork is only real prior runs — not "has salvage stamp".
        // First salvage dispatch uses seedFromSha + hadPriorWork:false so a
        // pre-existing foreign target tip is rejected (not silently kept).
        // expectedBaseTip ties the gate proof to the workspace base (TOCTOU).
        workspace = await this.workspaces.create(repo, task.id, {
          hadPriorWork: task.startedAt !== null,
          ...(salvageSha ? { seedFromSha: salvageSha } : {}),
          ...(expectedBaseTip ? { expectedBaseTip } : {}),
          ...(task.expectedBaseRevision !== undefined
            ? { expectedBaseRevision: task.expectedBaseRevision }
            : {}),
          ...(provenEmptyRemoteTip !== undefined
            ? { expectedRemoteTip: provenEmptyRemoteTip }
            : task.expectedRemoteTip !== undefined
              ? { expectedRemoteTip: task.expectedRemoteTip }
              : {}),
        });
        // ensureMirror may have skipped rewinding another task's local-ahead tip —
        // attach those notes to the owning task's timeline (not silent).
        await this.surfaceMirrorBranchEvents(task.id, null);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Release path lease if we held one — provision never started an agent.
        if (pathLeaseRunToken && pathLeaseStore) {
          try {
            await pathLeaseStore.release(repo.key, task.id, pathLeaseRunToken);
          } catch (relErr) {
            console.error(
              `[hercules] ${task.id}: path lease release after provision fail — ` +
                `${(relErr as Error).message}`,
            );
          }
          pathLeaseRunToken = null;
        }
        // Dependency-gate TOCTOU: main moved between atomic proof and create.
        // Leave todo/retrying untouched (no attempt burn, no adapter) — next
        // tick re-proves against the new tip. State machine forbids todo→retrying.
        if (/during dependency gate/i.test(msg)) {
          console.error(
            `[hercules] ${task.id}: dependency gate tip race — ${msg}; will re-prove next tick`,
          );
          continue;
        }
        // A never-started `todo` task has no run to fail: fail() cannot move a
        // human-owned todo record, so it only folded a stamped note into the
        // body and committed — every tick, forever (C3.49: two a downstream project tasks
        // with exact-head lease conflicts produced 775 control commits in one
        // night). Hold it with exponential backoff instead; the hold carries
        // the provisioning error so the operator sees why it will not start.
        if (task.state === 'todo') {
          const prior = this.provisionBackoff.get(task.id);
          const failures = (prior?.failures ?? 0) + 1;
          const untilMs = this.deps.clock() + provisionBackoffMs(failures);
          const detail = msg.replace(/\s+/g, ' ').trim().slice(0, 300);
          this.provisionBackoff.set(task.id, { untilMs, detail, failures });
          console.error(
            `[hercules] ${task.id}: provisioning failed before any run (attempt ${failures}) — ` +
              `held until ${new Date(untilMs).toISOString()}: ${detail}`,
          );
          continue;
        }
        // Provisioning failed (e.g. clone error) — count it as a failed attempt
        // and let backoff/retry handle it; the task is left for the next tick.
        const { thrashParked } = await this.fail(task, {
          kind: 'provision',
          activityLog: [`provision error: ${msg}`],
          adapter: hostOp ? 'host-executor' : String(agentKind),
          detail: msg,
          ...(failoverNote ? { failoverNote } : {}),
        });
        if (thrashParked) {
          report.thrashParked.push(task.id);
          this.sessionThrashParks += 1;
        }
        const after = (await this.deps.control.read()).tasks.find((t) => t.id === task.id);
        (after?.state === 'failed' ? report.failed : report.retried).push(task.id);
        continue;
      }

      // Provisioning succeeded — any earlier provision-failure hold is over.
      this.provisionBackoff.delete(task.id);
      const acquiredLease = workspace.branchLease;
      const selectedExpectedBase = task.expectedBaseRevision;
      const selectedExpectedRemote = task.expectedRemoteTip;
      const discardProvisionalWorkspace = async (reason: string): Promise<void> => {
        console.error(`[hercules] ${task.id}: ${reason}; rebuilding on next tick`);
        let removed = false;
        try {
          await this.workspaces.remove(task.id);
          removed = true;
        } catch (err) {
          console.error(
            `[hercules] ${task.id}: provisional workspace cleanup failed — ` +
              `${(err as Error).message}`,
          );
        }
        if (removed) {
          await this.releasePathLeaseEarly(repo.key, task.id, pathLeaseRunToken);
          pathLeaseRunToken = null;
        } else if (pathLeaseRunToken) {
          console.error(
            `[hercules] ${task.id}: path lease retained because provisional workspace cleanup failed`,
          );
        }
        report.provisionDiscarded.push(task.id);
        const prev = this.provisionDiscards.get(task.id);
        const count = prev && prev.reason === reason ? prev.count + 1 : 1;
        this.provisionDiscards.set(task.id, { reason, count });
        if (count < PROVISION_DISCARD_NOTE_AFTER) return;
        try {
          const durable = (await this.deps.control.read()).tasks.find(
            (candidate) => candidate.id === task.id,
          );
          if (!durable) return;
          const stamp = new Date(this.deps.clock()).toISOString();
          const body = appendProvisionDiscardNote(durable.body, stamp, reason, count);
          if (body === durable.body) return;
          const next: Task = { ...durable, body };
          await mutateControl(
            this.deps.control,
            { writeTasks: [{ expected: durable, next }] },
            `hercules: ${task.id} — provision blocked (${count})`,
          );
        } catch (err) {
          console.error(
            `[hercules] ${task.id}: could not record provision discard — ` +
              `${(err as Error).message}`,
          );
        }
      };

      // `task` came from the tick snapshot. Task creation or another operator
      // may have pinned/advanced its exact lease while create() was fetching.
      // Never overwrite that newer CAS record and never start from this stale
      // workspace, even when create() happened to report the same tip.
      let freshAfterProvision: Task | undefined;
      try {
        freshAfterProvision = (await this.deps.control.read()).tasks.find(
          (candidate) => candidate.id === task.id,
        );
      } catch (err) {
        await discardProvisionalWorkspace(
          `could not re-read durable task after provision — ${(err as Error).message}`,
        );
        continue;
      }
      if (
        !freshAfterProvision ||
        freshAfterProvision.state !== task.state ||
        freshAfterProvision.expectedBaseRevision !== selectedExpectedBase ||
        freshAfterProvision.expectedRemoteTip !== selectedExpectedRemote
      ) {
        await discardProvisionalWorkspace('durable task or exact lease changed during provision');
        continue;
      }

      // A fresh unpinned task does not trust a pre-existing same-name remote
      // branch. GitWorkspaces normally returns a creation lease after its
      // owned reset; a non-null discovery here is fail-closed, never promoted
      // into durable exact intent by the scheduler.
      if (selectedExpectedRemote === undefined && acquiredLease.expectedRemoteTip !== null) {
        await discardProvisionalWorkspace(
          untrustedRemoteTipReason(branchFor(task.id), acquiredLease.expectedRemoteTip),
        );
        continue;
      }

      if (
        task.expectedBaseRevision !== acquiredLease.expectedBaseRevision ||
        task.expectedRemoteTip !== acquiredLease.expectedRemoteTip
      ) {
        try {
          task = await this.writeTaskBranchLeaseCommitted(task, acquiredLease);
        } catch (err) {
          console.error(
            `[hercules] ${task.id}: could not persist task-branch ownership; ` +
              `agent not started — ${(err as Error).message}`,
          );
          await discardProvisionalWorkspace('task-branch ownership CAS failed after provision');
          continue;
        }
      }

      // Defense in depth above GitWorkspaces' own exact-candidate checks: an
      // adapter may only start a never-started exact task when the actual
      // checkout HEAD equals the durable expected remote tip.
      if (task.startedAt === null && typeof selectedExpectedRemote === 'string') {
        let workspaceHead: string | null = null;
        try {
          workspaceHead = this.workspaces.workspaceHead
            ? await this.workspaces.workspaceHead(workspace)
            : (await simpleGit(workspace.dir).revparse(['HEAD'])).trim().toLowerCase();
        } catch (err) {
          await discardProvisionalWorkspace(
            `exact candidate workspace HEAD unreadable — ${(err as Error).message}`,
          );
          continue;
        }
        if (workspaceHead?.toLowerCase() !== selectedExpectedRemote.toLowerCase()) {
          await discardProvisionalWorkspace(
            `exact candidate workspace HEAD mismatch ` +
              `(expected ${selectedExpectedRemote.slice(0, 12)}, ` +
              `actual ${workspaceHead?.slice(0, 12) ?? '(unavailable)'})`,
          );
          continue;
        }
      }

      const validateFinalDispatchBinding = async (): Promise<boolean> => {
        let durable: Task | undefined;
        try {
          durable = (await this.deps.control.read()).tasks.find(
            (candidate) => candidate.id === task.id,
          );
        } catch (err) {
          await discardProvisionalWorkspace(
            `final dispatch binding read failed — ${(err as Error).message}`,
          );
          return false;
        }
        if (
          !durable ||
          durable.state !== task.state ||
          durable.expectedBaseRevision !== task.expectedBaseRevision ||
          durable.expectedRemoteTip !== task.expectedRemoteTip ||
          acquiredLease.expectedBaseRevision !== task.expectedBaseRevision ||
          acquiredLease.expectedRemoteTip !== task.expectedRemoteTip
        ) {
          await discardProvisionalWorkspace('final durable task/workspace lease binding changed');
          return false;
        }
        task = durable;
        return true;
      };

      // A recovered reviewer checkpoint resumes verification directly on the
      // exact committed candidate. No coding adapter gets a chance to mutate it.
      if (task.reviewerInfrastructure?.state === 'ready') {
        const receipt = task.reviewerInfrastructure;
        let head: string | null = null;
        try {
          head = this.workspaces.workspaceHead
            ? await this.workspaces.workspaceHead(workspace)
            : (await simpleGit(workspace.dir).revparse(['HEAD'])).trim().toLowerCase();
        } catch (err) {
          console.error(
            `[hercules] ${task.id}: reviewer recovery candidate unreadable — ${(err as Error).message}`,
          );
        }
        if (head?.toLowerCase() !== receipt.candidateSha.toLowerCase()) {
          await this.writeTaskCommitted(
            task,
            {
              ...task,
              reviewerInfrastructure: {
                ...receipt,
                state: 'blocked',
                detail: 'Exact candidate checkout is unavailable or does not match the recovery receipt',
                nextAction: `Restore candidate ${receipt.candidateSha.slice(0, 12)} and explicitly recover ${receipt.provider}`,
              },
            },
            `hercules: ${task.id} reviewer recovery candidate mismatch`,
          );
          // Keep the checkout untouched for operator recovery. Do not remove,
          // reset, commit, or push an unproven mismatched tree.
          await this.releasePathLeaseEarly(repo.key, task.id, pathLeaseRunToken);
          continue;
        }
        if (!(await validateFinalDispatchBinding())) continue;
        const stamp = new Date(clock()).toISOString();
        const costRunId = randomUUID();
        const run = new ReviewerRecoveryRun();
        const startInput: AgentStartInput = {
          taskId: task.id,
          workspace: workspace.dir,
          prompt: '',
          allocation: workspace.allocation,
          executionPolicy,
        };
        const durable = await this.transition(task, 'in_progress', {
          agentSession: null,
          agentSessionAdapter: null,
          pendingSteer: null,
          endedAt: null,
          lastEventAt: stamp,
          costRunId,
        });
        if (!durable) {
          await this.workspaces.preserve(
            task.id,
            `hercules: ${task.id} — preserve reviewer recovery candidate`,
          );
          await this.releasePathLeaseEarly(repo.key, task.id, pathLeaseRunToken);
          continue;
        }
        this.tracked.set(task.id, {
          taskId: task.id,
          run,
          workspace,
          repo,
          adapterKind: receipt.provider,
          failoverNote: null,
          isSteerResume: false,
          consumedSteerText: null,
          consumedClientMessageIds: [],
          startedAtMs: clock(),
          costRunKey: makeUsageReceiptId(task.id, costRunId),
          startInput,
          freshStartInput: startInput,
          originalResumeSessionId: null,
          sessionRecoveryAttempted: true,
          transientRetried: true,
          branchTip: receipt.candidateSha,
          aliveHint: null,
          aliveHintAt: 0,
          procPrev: null,
          procCpuPct: null,
          procRssMb: null,
          pathLeaseRunToken,
        });
        console.error(
          `[hercules] ${task.id}: reviewer recovered; verify exact candidate ${receipt.candidateSha.slice(0, 12)} (no agent dispatch)`,
        );
        this.provisionDiscards.delete(task.id);
        report.dispatched.push(task.id);
        continue;
      }

      // ── Deterministic host_operation / deploy path ─────────────────────
      // No Grok/Codex/Claude. Durable start marker is committed before any
      // command can spawn; restart orphans with the marker are replay-blocked.
      if (hostOp) {
        const scope = task.hostCommandScope ?? [];
        const dispatchAt = new Date(clock()).toISOString();
        const costRunId = randomUUID();
        const bodyMarked = stampHostExecutionStart(task.body, {
          startedAt: dispatchAt,
          commandCount: scope.length,
        });
        let branchTip: string | null = null;
        try {
          branchTip = (await simpleGit(workspace.dir).raw(['rev-parse', 'HEAD'])).trim() || null;
        } catch {
          branchTip = null;
        }
        if (!(await validateFinalDispatchBinding())) continue;
        const startInput: AgentStartInput = {
          taskId: task.id,
          workspace: workspace.dir,
          prompt: '',
          allocation: workspace.allocation,
          ...(task.executionClass != null ? { executionClass: task.executionClass } : {}),
          hostCommandScope: scope,
        };
        // Persist marker BEFORE constructing/spawning the executor.
        let markerDurable = false;
        try {
          markerDurable = await this.transition(
            task,
            'in_progress',
            {
              agentSession: null,
              pendingSteer: null,
              startedAt: dispatchAt,
              endedAt: null,
              lastEventAt: dispatchAt,
              hostExecutionStartedAt: dispatchAt,
              costRunId,
              body: bodyMarked,
            },
            {
              state: task.state,
              expectedBaseRevision: task.expectedBaseRevision,
              expectedRemoteTip: task.expectedRemoteTip,
            },
          );
        } catch (err) {
          console.error(
            `[hercules] ${task.id}: host execution marker was not durable — ` +
              `${(err as Error).message}`,
          );
        }
        if (!markerDurable) {
          await discardProvisionalWorkspace(
            'host execution marker was not durably committed',
          );
          console.error(
            `[hercules] ${task.id}: host execution not started because durable marker was not written`,
          );
          continue;
        }
        console.error(
          `[hercules] dispatch ${task.id} → host-executor (repo=${repo.key}, ` +
            `${scope.length} command${scope.length === 1 ? '' : 's'})`,
        );
        let hostRun: HostExecutorRun;
        try {
          hostRun = startHostExecution(startInput, clock(), {
            commandTimeoutMs: hostCommandTimeoutFromEnv(),
            cwd: workspace.dir,
          });
        } catch (err) {
          // Marker is already durable — never retry; park for human re-approval.
          const msg = err instanceof Error ? err.message : String(err);
          const stamp = new Date(clock()).toISOString();
          const fresh = (await this.deps.control.read()).tasks.find((t) => t.id === task.id) ?? task;
          await this.transition(fresh, 'failed', {
            endedAt: stamp,
            lastEventAt: stamp,
            body:
              `${fresh.body.trimEnd()}\n\n## Host operation replay blocked\n\n` +
              `Deterministic host executor refused to start: ${msg}. ` +
              'No command was spawned; re-approve on the phone to retry.\n',
          });
          await this.releasePathLeaseEarly(repo.key, task.id, pathLeaseRunToken);
          pathLeaseRunToken = null;
          report.failed.push(task.id);
          continue;
        }
        this.tracked.set(task.id, {
          taskId: task.id,
          run: hostRun,
          workspace,
          repo,
          adapterKind: 'host-executor',
          failoverNote: null,
          isSteerResume: false,
          consumedSteerText: null,
          consumedClientMessageIds: [],
          startedAtMs: clock(),
          costRunKey: makeUsageReceiptId(task.id, costRunId),
          startInput,
          freshStartInput: startInput,
          originalResumeSessionId: null,
          sessionRecoveryAttempted: true,
          // Host executions never same-round retry.
          transientRetried: true,
          branchTip,
          aliveHint: null,
          aliveHintAt: 0,
          procPrev: null,
          procCpuPct: null,
          procRssMb: null,
          pathLeaseRunToken,
        });
        // Marker is durable on disk — only now may the first command spawn.
        hostRun.begin();
        // Host commands are separate transient process groups. Keep this lease
        // deliberately unbound: the live token protects normal operation and
        // HERCULES_TASK_ID + exact cwd scanning proves survivors after a crash.
        this.provisionDiscards.delete(task.id);
        report.dispatched.push(task.id);
        continue;
      }

      // Comment-to-steer: short prompt + adapter session resume when the human
      // left a pendingSteer and we still have a session id from the prior run.
      const resolvedAgent = this.agents.resolve(agentKind);
      const { adapter } = resolvedAgent;
      const steerComment = task.pendingSteer?.trim() ?? '';
      const resumeId = task.agentSession?.trim() ?? '';
      const sessionOwnedBySelected = task.agentSessionAdapter === agentKind;
      const isSteerResume =
        steerComment.length > 0 && resumeId.length > 0 && sessionOwnedBySelected;
      // Capture ids from the steer being consumed + body audit so a retried
      // POST while in_progress cannot re-queue the same submission.
      const consumedClientMessageIds = [
        ...new Set([
          ...extractClientMessageIdsFromBody(steerComment),
          ...extractClientMessageIdsFromBody(task.body),
        ]),
      ];
      for (const id of consumedClientMessageIds) {
        this.rememberChatId(task.id, id);
      }
      const fullContextTask =
        steerComment.length > 0 && !task.body.includes(steerComment)
          ? {
              ...task,
              body:
                `${task.body.trimEnd()}\n\n## Pending human steer\n\n` +
                `${steerComment}\n`,
            }
          : task;
      const prompt = isSteerResume
        ? assembleSteerPrompt(task, steerComment)
        : assemblePrompt({ workflowBody, task: fullContextTask, allocation: workspace.allocation });

      const failoverBit =
        failover?.failedOver
          ? ` failover from ${failover.requested}`
          : failover?.note
            ? ' failover-warn'
            : '';
      const startInput: AgentStartInput = {
        taskId: task.id,
        workspace: workspace.dir,
        prompt,
        allocation: workspace.allocation,
        executionPolicy,
        ...(repo.url.trim() !== '' ? { repository: repo.url } : {}),
        ...(repo.defaultBranch.trim() !== '' ? { ref: repo.defaultBranch } : {}),
        ...(isSteerResume ? { resumeSessionId: resumeId } : {}),
        // Isolation fault script — only FakeAdapter honors it; real adapters ignore.
        ...(task.fakeBehavior != null ? { fakeBehavior: task.fakeBehavior } : {}),
        // Host-op permission policy for Grok argv (coding deny / scoped allow).
        ...(task.executionClass != null ? { executionClass: task.executionClass } : {}),
        ...(task.hostCommandScope != null && task.hostCommandScope.length > 0
          ? { hostCommandScope: task.hostCommandScope }
          : {}),
      };
      const freshStartInput: AgentStartInput = {
        ...startInput,
        prompt: assemblePrompt({
          workflowBody,
          task: fullContextTask,
          allocation: workspace.allocation,
        }),
      };
      delete (freshStartInput as { resumeSessionId?: string }).resumeSessionId;
      let run: AgentRun;
      if (!(await validateFinalDispatchBinding())) continue;
      console.error(
        `[hercules] dispatch ${task.id} → agent=${agentKind} (repo=${repo.key}` +
          `${isSteerResume ? ', resume' : ''}${failoverBit})`,
      );
      if (failoverNote) {
        console.error(`[hercules] ${task.id}: ${failoverNote}`);
      }
      try {
        run = adapter.start(startInput, clock());
      } catch (err) {
        await this.releasePathLeaseEarly(repo.key, task.id, pathLeaseRunToken);
        pathLeaseRunToken = null;
        const stamp = new Date(clock()).toISOString();
        const detail = `adapter start failed before ownership bind: ${(err as Error).message}`;
        await this.transition(task, 'review', {
          body: `${task.body.trimEnd()}\n\n## Adapter start blocked\n\n${detail}\n`,
          endedAt: stamp,
          lastEventAt: stamp,
        });
        report.completed.push(task.id);
        continue;
      }
      if (pathLeaseRunToken && pathLeaseStore && adapterOwnsLocalProcess(agentKind)) {
        let bound:
          | { readonly ok: true }
          | { readonly ok: false; readonly reason: string };
        try {
          const pid = run.poll(clock()).processPid;
          bound =
            typeof pid === 'number'
              ? await pathLeaseStore.bindOwnerProcess(
                  repo.key,
                  task.id,
                  pathLeaseRunToken,
                  pid,
                )
              : { ok: false as const, reason: 'adapter did not expose a root process pid' };
        } catch {
          bound = {
            ok: false,
            reason: 'authoritative path-lease owner bind failed',
          };
        }
        if (!bound.ok) {
          run.stop({ force: true });
          const stamp = new Date(clock()).toISOString();
          await this.transition(task, 'review', {
            body:
              `${task.body.trimEnd()}\n\n## Path lease owner bind blocked\n\n` +
              `${bound.reason}. The adapter was stopped; the unbound lease remains ` +
              'held fail-closed until ownership can be proven stale.\n',
            endedAt: stamp,
            lastEventAt: stamp,
          });
          report.completed.push(task.id);
          continue;
        }
      }
      // Each dispatch stamps THIS run's start and clears any prior end. "Agent
      // ran" then measures the actual run. (Keeping the first startedAt made a
      // re-run's duration span the human gap between runs — a task rejected and
      // re-run a day later showed "Agent ran: 24h".)
      // Consume pendingSteer so a later fail→retry does not re-send the same
      // follow-up; the steer text remains in the task body for audit.
      // Prefer the live run's session id when already known; otherwise keep the
      // prior resume id so complete() can still record it if the adapter reports
      // late (Grok end event).
      const dispatchAt = new Date(clock()).toISOString();
      const costRunId = randomUUID();
      let branchTip: string | null = null;
      try {
        branchTip = (await simpleGit(workspace.dir).raw(['rev-parse', 'HEAD'])).trim() || null;
      } catch {
        branchTip = null;
      }
      // Durable phone-visible note when we degraded (or pinned-unhealthy warn).
      const bodyWithFailover = failoverNote
        ? `${task.body.trimEnd()}\n\n## Adapter failover\n\n${failoverNote}\n`
        : undefined;
      try {
        const durable = await this.transition(task, 'in_progress', {
          agentSession: run.sessionId || (isSteerResume ? resumeId : '') || null,
          agentSessionAdapter:
            (run.sessionId || isSteerResume) && isAdapterKind(agentKind) ? agentKind : null,
          pendingSteer: null,
          // Prior green packet remains in the body as provenance, but its SHA is
          // not current once another implementer/steer process starts.
          verifiedSha: null,
          packetNonce: null,
          verifiedPathLeaseDigest: null,
          startedAt: dispatchAt,
          endedAt: null,
          // Honest "something started" — stall detection also uses live poll.
          lastEventAt: dispatchAt,
          costRunId,
          ...(bodyWithFailover !== undefined ? { body: bodyWithFailover } : {}),
        });
        if (!durable) {
          run.stop({ force: true });
          console.error(
            `[hercules] ${task.id}: task disappeared after start; writer stopped and lease retained`,
          );
          continue;
        }
      } catch (err) {
        run.stop({ force: true });
        console.error(
          `[hercules] ${task.id}: durable in-progress transition failed after start; ` +
            `writer stopped and lease retained — ${(err as Error).message}`,
        );
        continue;
      }
      this.tracked.set(task.id, {
        taskId: task.id,
        run,
        workspace,
        repo,
        adapterKind: String(agentKind),
        failoverNote,
        isSteerResume,
        consumedSteerText: steerComment.length > 0 ? steerComment : null,
        consumedClientMessageIds,
        startedAtMs: clock(),
        costRunKey: makeUsageReceiptId(task.id, costRunId),
        startInput,
        freshStartInput,
        originalResumeSessionId: startInput.resumeSessionId ?? null,
        sessionRecoveryAttempted: false,
        transientRetried: false,
        branchTip,
        aliveHint: null,
        aliveHintAt: 0,
        procPrev: null,
        procCpuPct: null,
        procRssMb: null,
        pathLeaseRunToken,
      });
      this.provisionDiscards.delete(task.id);
      report.dispatched.push(task.id);
    }
    // Re-select after every admission wave: any pre-start rejection leaves its
    // reserved slot unused, regardless of which preflight produced the hold.
    eligible = pickEligible();
    if (eligible.length === 0) break;
    }
  }

  /**
   * Base caps from config, optionally lowered by MemAvailable pressure.
   * Reader failures / disabled policy leave the configured base unchanged.
   */
  private async resolveCaps(): Promise<CapPair> {
    const { config, memReader } = this.deps;
    const base: CapPair = {
      globalCap: config.globalCap,
      heavyValidationPermits: config.heavyValidationPermits,
    };
    if (!config.dynamicCaps.enabled || !memReader) return base;
    let mem: number | null;
    try {
      mem = await memReader();
    } catch {
      mem = null;
    }
    return resolveEffectiveCaps(base, mem, config.dynamicCaps);
  }

  /**
   * Recompute per-task scheduling holds and log only on transitions.
   * Uses the same SchedulingState shape as the first selectEligible wave.
   */
  private async refreshSchedulingHolds(snapshot: ControlSnapshot): Promise<void> {
    const { config, clock } = this.deps;
    const effective = await this.resolveCaps();
    // Drop provision-failure holds for tasks that are gone or no longer todo
    // (cancelled, edited, dispatched elsewhere) so the map cannot grow.
    for (const [taskId, backoff] of this.provisionBackoff) {
      const current = snapshot.tasks.find((t) => t.id === taskId);
      if (!current || current.state !== 'todo' || backoff.untilMs + PROVISION_BACKOFF_MAX_MS < clock()) {
        this.provisionBackoff.delete(taskId);
      }
    }
    const next = explainIneligible({
      tasks: snapshot.tasks,
      repos: snapshot.repos,
      runningTaskIds: new Set(this.tracked.keys()),
      provisionBackoff: this.provisionBackoff,
      adapterCrashHolds: adapterCrashHolds(this.adapterCrashes, clock()),
      globalCap: effective.globalCap,
      defaultKind: this.agents.defaultKind,
      backoffBaseMs: config.backoffBaseMs,
      now: clock(),
    });
    const prev = this.schedulingHolds;
    for (const [taskId, reason] of next) {
      const prior = prev.get(taskId);
      if (prior && schedulingHoldEquals(prior, reason)) continue;
      console.error(
        `[hercules] hold ${taskId}: ${reason.code} ${formatSchedulingHoldDetail(reason)}`,
      );
    }
    for (const taskId of prev.keys()) {
      if (!next.has(taskId)) {
        console.error(`[hercules] hold cleared ${taskId}`);
      }
    }
    this.schedulingHolds = next;
  }

  /**
   * Throttled process-tree sample (or adapter-supplied hint) for phone honesty.
   * Does not update lastEventAt — stream silence remains visible via silenceMs.
   */
  private refreshAliveHint(
    t: TrackedRun,
    snap: { readonly aliveHint?: string | null; readonly processPid?: number },
    now: number,
    processAlive: boolean,
  ): string | null {
    if (!processAlive) {
      t.aliveHint = null;
      return null;
    }
    // Adapter may supply a fixed hint (fake tests / specialized adapters).
    if (snap.aliveHint !== undefined && snap.aliveHint !== null && snap.aliveHint.trim()) {
      t.aliveHint = snap.aliveHint.trim();
      t.aliveHintAt = now;
      return t.aliveHint;
    }
    if (snap.processPid === undefined) return t.aliveHint;
    if (now - t.aliveHintAt < ALIVE_HINT_REFRESH_MS && t.aliveHintAt > 0) {
      return t.aliveHint;
    }
    try {
      t.aliveHint = sampleProcessTreeHint(snap.processPid);
    } catch {
      // leave previous hint
    }
    t.aliveHintAt = now;
    return t.aliveHint;
  }

  /**
   * Worker-tree CPU% + RSS between polls, so a quiet build visibly "moves"
   * on the phone (CPU fluctuates) instead of looking hung. Best-effort /proc
   * (Linux, USER_HZ=100); silently absent elsewhere.
   */
  private refreshProcStats(
    t: TrackedRun,
    snap: { readonly processPid?: number },
    now: number,
    processAlive: boolean,
  ): void {
    if (!processAlive || snap.processPid === undefined) {
      t.procPrev = null;
      t.procCpuPct = null;
      t.procRssMb = null;
      return;
    }
    let stats: { jiffies: number; rssBytes: number } | null = null;
    try {
      stats = sampleProcessTreeStats(snap.processPid);
    } catch {
      // /proc unavailable — keep previous numbers
    }
    if (stats === null) return;
    t.procRssMb = Math.round(stats.rssBytes / (1024 * 1024));
    if (t.procPrev !== null) {
      const pct = cpuPctFromSamples(t.procPrev, { jiffies: stats.jiffies, atMs: now }, 100);
      if (pct !== null) t.procCpuPct = pct;
    }
    t.procPrev = { jiffies: stats.jiffies, atMs: now };
  }

  /**
   * Apply a failure via kind-aware retry policy: optional attempt burn, backoff,
   * thrash / hard-infra / global ceiling park. Always append a **Run failure**
   * mini-packet so the phone sheet is not blank (orbit onboarding: 3 agent
   * exits, zero packet).
   */
  private async fail(
    task: Task,
    opts: {
      readonly kind?: RunFailureKind | FailureKind;
      readonly activityLog?: readonly string[];
      readonly finalMessage?: string;
      readonly exitCode?: number | null;
      readonly exitSignal?: string | null;
      readonly deathCause?: string;
      readonly stderrTail?: string;
      readonly adapter?: string;
      readonly workspaceDir?: string;
      readonly branchTip?: string | null;
      /** Error detail for hard-infra detection (provision / verify_infra). */
      readonly detail?: string;
      /** Adapter failover note from this run's dispatch (timeline detail). */
      readonly failoverNote?: string;
      /** Exact provider ids that must not enter body/timeline diagnostics. */
      readonly redactProviderSessionIds?: readonly (string | null | undefined)[];
      /** Poisoned/missing provider ownership must not survive recovery setup failure. */
      readonly clearProviderSession?: boolean;
      /**
       * Factory PR already opened by a Cloud Agent that then died. Persist so
       * retry pins (`autoCreatePr: false`) instead of orphaning a second PR.
       */
      readonly factoryPr?: FactoryPrArtifact | null;
    } = {},
  ): Promise<{ thrashParked: boolean }> {
    const redact = (value: string | undefined): string | undefined =>
      redactKnownProviderSessions(value, opts.redactProviderSessionIds ?? []);
    const activityLog = opts.activityLog?.map((line) => redact(line) ?? '');
    const finalMessage = redact(opts.finalMessage);
    const stderrTail = redact(opts.stderrTail);
    const suppliedDeathCause = redact(opts.deathCause);
    const failoverNote = redact(opts.failoverNote);
    const suppliedDetail = redact(opts.detail);
    const rawKind = opts.kind ?? 'agent_exit';
    // Run failure mini-packet only accepts crash kinds; map verify_* if ever passed.
    const kind: RunFailureKind = isRunFailureKind(rawKind) ? rawKind : 'agent_exit';
    const policyKind: FailureKind = isRunFailureKind(rawKind) ? rawKind : rawKind;
    const maxAttempts = this.deps.config.maxAttempts;
    const nowMs = this.deps.clock();
    const stamp = new Date(nowMs).toISOString();
    // Provider health: only agent_exit feeds the failover window (not stall/provision).
    if (kind === 'agent_exit') {
      this.recordAdapterExit(opts.adapter, nowMs);
    }
    const detail =
      suppliedDetail ??
      (activityLog && activityLog.length > 0
        ? activityLog.join('\n')
        : undefined);
    const decision = decideRetry({
      kind: policyKind,
      attempts: task.attempts,
      maxAttempts,
      body: task.body,
      nowMs,
      backoffBaseMs: this.deps.config.backoffBaseMs,
      ...(detail ? { detail } : {}),
    });
    const hostReplayBlocked =
      isHostMutatingClass(resolveExecutionClass(task)) && policyKind !== 'provision';
    const thrashParked = !hostReplayBlocked && decision.parkedReason === 'thrash';
    const exhausted = hostReplayBlocked || decision.outcome === 'fail';
    const deathCause =
      suppliedDeathCause ??
      (kind === 'agent_exit'
        ? summarizeAgentDeath({
            ...(stderrTail ? { stderrTail } : {}),
            ...(activityLog ? { activityTail: activityLog } : {}),
            ...(finalMessage ? { finalMessage } : {}),
            ...(opts.exitCode !== undefined ? { exitCode: opts.exitCode } : {}),
            ...(opts.exitSignal !== undefined ? { exitSignal: opts.exitSignal } : {}),
          })
        : undefined);
    // Host executor receipts must stay complete and untruncated. Generic
    // failure text caps final agent text; host receipts are appended whole.
    const hostReceiptText =
      hostReplayBlocked && (finalMessage?.trim().length ?? 0) > 0
        ? finalMessage!.trim()
        : null;
    const failureSection = buildRunFailureSection({
      stamp,
      kind,
      attempt: decision.attemptsAfter,
      maxAttempts,
      taskId: task.id,
      thrashParked,
      thrashConsecutive: decision.kindStreak,
      accounting: decision.accounting,
      nextEligibleAt: decision.nextEligibleAt,
      policySummary: decision.policySummary,
      parkedReason: decision.parkedReason,
      burnedAttempt: decision.burnedAttempt,
      ...(activityLog ? { activityTail: activityLog } : {}),
      // Non-host only: host receipt is appended in full below.
      ...(hostReceiptText === null && finalMessage
        ? { finalMessage }
        : {}),
      ...(opts.exitCode !== undefined ? { exitCode: opts.exitCode } : {}),
      ...(opts.exitSignal !== undefined ? { exitSignal: opts.exitSignal } : {}),
      ...(deathCause ? { deathCause } : {}),
      ...(stderrTail ? { stderrTail } : {}),
      ...(opts.adapter ? { adapter: opts.adapter } : {}),
      ...(opts.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}),
      ...(opts.branchTip !== undefined ? { branchTip: opts.branchTip } : {}),
      ...(task.expectedBaseRevision !== undefined
        ? { expectedBaseRevision: task.expectedBaseRevision }
        : {}),
      ...(task.expectedRemoteTip !== undefined
        ? { expectedRemoteTip: task.expectedRemoteTip }
        : {}),
    });
    // Structured phone timeline: dispatch → activity → terminal kind.
    const timelineSection = renderRunTimelineSection(
      buildOnboardFailureTimeline({
        stamp,
        kind,
        startedAt: task.startedAt,
        ...(opts.adapter ? { adapter: opts.adapter } : {}),
        ...(activityLog ? { activityTail: activityLog } : {}),
        ...(opts.exitCode !== undefined ? { exitCode: opts.exitCode } : {}),
        ...(opts.exitSignal !== undefined ? { exitSignal: opts.exitSignal } : {}),
        ...(deathCause ? { deathCause } : {}),
        ...(failoverNote ? { failoverNote } : {}),
      }),
    );
    let body = `${task.body.trimEnd()}\n\n${failureSection}\n`;
    if (timelineSection) body += `${timelineSection}\n`;
    if (hostReceiptText) {
      // Exactly one complete canonical receipt — never through truncated fail text.
      // Receipt free text (command tails / evidence) is untrusted — neutralize.
      body += `\n${neutralizeUntrustedPacketText(hostReceiptText, { taskId: task.id })}\n`;
    }
    if (hostReplayBlocked) {
      body +=
        '\n## Host operation replay blocked\n\n' +
        'The approved command may already have run. Hercules did not retry or resume it; ' +
        'use the phone approval panel to authorize a fresh run.\n';
    }
    if (exhausted) {
      body += buildAgentCrashSalvage({
        taskId: task.id,
        maxAttempts,
        kind,
        thrashParked,
        parkedReason: decision.parkedReason,
        ...(opts.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}),
      });
    }
    // Fold mid-run Remote Control queue on agent-death / stall / hard-fail too.
    await this.withPendingChatFinalize<void>(task.id, async (drained) => {
      const folded = this.foldDrainedChat({
        body,
        stamp,
        autoPendingSteer: null,
        setPendingSteer: !exhausted && drained.combined.text.trim().length > 0,
        drained,
        taskId: task.id,
      });
      // The agent's run just ended (whether we retry or park it).
      const factoryPrFields = factoryPrFieldsOnFailure(task, opts.factoryPr);
      const durable = await this.transition(task, exhausted ? 'failed' : 'retrying', {
        attempts: decision.attemptsAfter,
        lastEventAt: stamp,
        endedAt: stamp,
        body: folded.body,
        pendingSteer: folded.pendingSteer,
        ...(factoryPrFields ?? {}),
        ...(opts.clearProviderSession
          ? { agentSession: null, agentSessionAdapter: null }
          : {}),
      });
      return { value: undefined, durable };
    });
    return { thrashParked };
  }


  /**
   * Live-run ownership observe. When a foreign writer moves the remote task
   * ref, park to review without burning attempts and without adopting the tip.
   * Returns true when the run was parked (caller should skip further reconcile).
   */
  private async parkForeignTaskRefIfMoved(
    task: Task,
    tracked: TrackedRun,
    report: TickReport,
  ): Promise<boolean> {
    if (task.expectedRemoteTip === undefined) return false;
    if (!this.workspaces.readRemoteTaskRefTip) return false;
    let actual: string | null;
    try {
      actual = await this.workspaces.readRemoteTaskRefTip(tracked.repo, task.id);
    } catch (err) {
      console.error(
        `[hercules] ${task.id}: task-ref ownership observe failed — ${(err as Error).message}`,
      );
      return false;
    }
    const observation = observeTaskRefOwnership({
      expectedRemoteTip: task.expectedRemoteTip,
      actualRemoteTip: actual,
    });
    if (!observation.parkWithoutAttemptBurn) return false;

    const stamp = new Date(this.deps.clock()).toISOString();
    const receipt = buildTaskRefOwnershipReceipt({
      stamp,
      taskId: task.id,
      branch: tracked.workspace.branch,
      observation,
    });
    const attemptsBefore = task.attempts;
    console.error(
      `[hercules] ${task.id}: foreign remote task-ref movement — parking without attempt burn ` +
        `(${observation.status}; expected ${observation.expectedRemoteTip?.slice(0, 12) ?? '(absent)'}, ` +
        `actual ${observation.actualRemoteTip?.slice(0, 12) ?? '(absent)'})`,
    );
    try {
      tracked.run.stop();
    } catch (err) {
      console.error(
        `[hercules] ${task.id}: stop after foreign tip park failed — ${(err as Error).message}`,
      );
    }
    let baseBody = task.body;
    try {
      const fresh = (await this.deps.control.read()).tasks.find((t) => t.id === task.id);
      if (fresh) baseBody = fresh.body;
    } catch (err) {
      console.error(
        `[hercules] ${task.id}: task-ref park body re-read failed — ${(err as Error).message}`,
      );
    }
    const body = appendTaskRefOwnershipPark(baseBody, receipt);
    await this.transition(task, 'review', {
      body,
      endedAt: stamp,
      lastEventAt: stamp,
      attempts: attemptsBefore,
      ...(task.expectedRemoteTip !== undefined
        ? { expectedRemoteTip: task.expectedRemoteTip }
        : {}),
      ...(task.expectedBaseRevision !== undefined
        ? { expectedBaseRevision: task.expectedBaseRevision }
        : {}),
    });
    await this.teardownRetainingLocalWorkspace(task.id);
    report.completed.push(task.id);
    return true;
  }

  private async parkPermanentPathLeaseBlock(
    task: Task,
    input: {
      readonly reason: string;
      readonly detail: string;
      readonly message: string;
      readonly footer?: string;
    },
    report: TickReport,
  ): Promise<'parked' | 'deferred'> {
    const clock = this.deps.clock;
    const now = clock();
    const fp =
      task.id + '|path_lease_permanent|' + input.reason + '|' + input.detail;
    if (shouldEmitRateLimitedLog(this.pathLeaseBlockLogRate, fp, now)) {
      console.error(
        '[hercules] ' +
          task.id +
          ': path lease blocked — ' +
          input.reason +
          ': ' +
          input.detail,
      );
    }
    const stamp = new Date(now).toISOString();
    const outcome = await runPermanentPathLeasePark(task, input, {
      taskId: task.id,
      stamp,
      shouldLog: (fingerprint) =>
        shouldEmitRateLimitedLog(this.pathLeaseBlockLogRate, fingerprint, clock()),
      log: (line) => {
        console.error(line);
      },
      tryTransition: async (source, body) =>
        this.transition(source, 'review', {
          body,
          endedAt: stamp,
          lastEventAt: stamp,
        }),
      readTask: async () => {
        const snap = await this.deps.control.read();
        return snap.tasks.find((candidate) => candidate.id === task.id);
      },
    });
    if (outcome === 'parked') report.completed.push(task.id);
    return outcome;
  }

  /**
   * Validate, write, and commit a state transition (the unit of mutation).
   *
   * Optimistic concurrency for run finalize (midrun-steer-race): re-read disk
   * before writing. If a human already moved the task to todo/cancel/delete/done
   * while verify was still running, only fold packet content — never clobber
   * their state. If we would park in review while pendingSteer is set, write
   * todo instead so the next tick can dispatch.
   */
  /**
   * @returns true when a durable control write+commit landed; false when the
   * task is missing (no-op). Throws {@link ControlNotDurableError} when
   * writeTask ran but commit returned `{committed:false}`.
   */
  private async transition(
    task: Task,
    to: Task['state'],
    fields: Partial<Task> = {},
    expectedCurrent?: {
      readonly state: Task['state'];
      readonly expectedBaseRevision: Task['expectedBaseRevision'] | undefined;
      readonly expectedRemoteTip: Task['expectedRemoteTip'] | undefined;
    },
  ): Promise<boolean> {
    if (expectedCurrent) {
      if (!this.deps.control.compareAndSetTaskCommitted) {
        console.error(
          `[hercules] ${task.id}: transition skipped — control port lacks atomic task CAS`,
        );
        return false;
      }
      assertTransition(expectedCurrent.state, to);
      const result = await this.deps.control.compareAndSetTaskCommitted(
        task.id,
        expectedCurrent,
        to,
        {
          ...fields,
          ...(fields.agentSession === null ? { agentSessionAdapter: null } : {}),
        },
        `hercules: ${task.id} ${expectedCurrent.state} → ${to}`,
      );
      if (!result.matched) {
        console.error(
          `[hercules] ${task.id}: transition skipped — expected durable task binding changed`,
        );
        return false;
      }
      if (!result.committed) {
        throw new ControlNotDurableError(
          `${task.id}: atomic CAS commit returned committed:false after ` +
            `${expectedCurrent.state} → ${to}`,
        );
      }
      return true;
    }

    const snapshot = await this.deps.control.read();
    const current = snapshot.tasks.find((t) => t.id === task.id);
    if (!current) {
      console.error(`[hercules] ${task.id}: transition skipped — task gone from disk`);
      return false;
    }

    if (
      shouldPreserveHumanRunState({
        currentState: current.state,
        expectedFrom: task.state,
        intendedTo: to,
        preserveRetrying: isConcurrentAgentSwitch(task.body, current),
      })
    ) {
      if (current.state === 'cancelled' || current.state === 'deleted') {
        console.error(
          '[hercules] ' + task.id + ': finalize skipped — disk is ' +
            current.state + ' (wanted ' + to + ')',
        );
        return false;
      }
      return this.writeFinalizePacketOnly(current, to, fields);
    }

    const pendingForHonor =
      fields.pendingSteer !== undefined ? fields.pendingSteer : current.pendingSteer;
    const effectiveTo = honorPendingSteerOnReview({
      intendedTo: to,
      pendingSteer: pendingForHonor,
    });

    // Base on fresh disk so concurrent human field updates (pendingSteer body
    // trail) are not wiped by a stale in-memory task snapshot.
    let next: Task = { ...current, ...fields, state: effectiveTo };
    if (next.agentSession === null && next.agentSessionAdapter != null) {
      next = { ...next, agentSessionAdapter: null };
    }
    if (
      effectiveTo === 'todo' &&
      to === 'review' &&
      (current.pendingSteer?.trim() ?? '').length > 0
    ) {
      // Keep the human steer text; clear backoff so dispatch is immediate.
      next = {
        ...next,
        pendingSteer: current.pendingSteer,
        lastEventAt: null,
      };
    }

    if (canTransition(current.state, effectiveTo)) {
      assertTransition(current.state, effectiveTo);
    } else if (
      effectiveTo === 'todo' &&
      (current.state === 'in_progress' || current.state === 'retrying') &&
      (next.pendingSteer?.trim() ?? '').length > 0
    ) {
      // in_progress/retrying → todo is not on the happy-path table; same outcome
      // as ActionService.steer (review→todo) when honoring a queued pendingSteer.
      console.error(
        `[hercules] ${task.id}: honor pendingSteer — ${current.state} → todo (skip SM edge)`,
      );
    } else {
      if (!canTransition(current.state, effectiveTo)) {
        const humanOwned =
          current.state === 'todo' ||
          current.state === 'cancelled' ||
          current.state === 'deleted' ||
          current.state === 'done' ||
          current.state === 'failed' ||
          current.state === 'review' ||
          current.state === 'retrying';
        if (humanOwned) {
          if (current.state === 'cancelled' || current.state === 'deleted') return false;
          return this.writeFinalizePacketOnly(current, effectiveTo, fields);
        }
      }
      assertTransition(current.state, effectiveTo);
    }

    const { committed } = await mutateControl(this.deps.control, { writeTasks: [{ expected: current, next }] },
      `hercules: ${task.id} ${current.state} → ${effectiveTo}` +
        (effectiveTo !== to ? ` (honor pendingSteer; wanted ${to})` : ''),
    );
    if (!committed) {
      throw new ControlNotDurableError(
        `${task.id}: commit returned committed:false after ${current.state} → ${effectiveTo}`,
      );
    }
    return true;
  }

  /**
   * Human owns the task state (steer/reject/cancel). Fold the finishing run's
   * review packet into the body when present; leave state untouched.
   */
  private async writeFinalizePacketOnly(
    current: Task,
    wantedTo: Task['state'],
    fields: Partial<Task>,
  ): Promise<boolean> {
    let body = current.body;
    if (fields.body !== undefined) {
      const packet = extractReviewPacketContent(fields.body);
      if (packet !== null) {
        body = withReviewPacket(current.body, packet);
      }
      // Preserve mid-run Human steer sections when only folding finalize fields.
      {
        const fieldClientIds = extractClientMessageIdsFromBody(fields.body);
        const bodyClientIds = new Set(extractClientMessageIdsFromBody(body));
        const missingClient = fieldClientIds.filter((id) => !bodyClientIds.has(id));
        const fieldDeliveryIds = extractChatDeliveryIdsFromBody(fields.body);
        const bodyDeliveryIds = new Set(extractChatDeliveryIdsFromBody(body));
        const missingDelivery = fieldDeliveryIds.filter((id) => !bodyDeliveryIds.has(id));
        if (missingClient.length > 0 || missingDelivery.length > 0) {
          let searchFrom = 0;
          const marker = '## Human steer (';
          while (searchFrom < fields.body.length) {
            const at = fields.body.indexOf(marker, searchFrom);
            if (at < 0) break;
            const next = fields.body.indexOf(marker, at + marker.length);
            const section = (
              next < 0 ? fields.body.slice(at) : fields.body.slice(at, next)
            ).trim();
            searchFrom = next < 0 ? fields.body.length : next;
            if (section.length === 0 || body.includes(section)) continue;
            const sClients = extractClientMessageIdsFromBody(section);
            const sDeliveries = extractChatDeliveryIdsFromBody(section);
            const needed =
              sClients.some((id) => missingClient.includes(id)) ||
              sDeliveries.some((id) => missingDelivery.includes(id));
            if (needed) body = [body.trimEnd(), '', section, ''].join(String.fromCharCode(10));
          }
        }
      }
      const stamp = new Date(this.deps.clock()).toISOString();
      const note =
        `\n\n## Finalize skipped state write (${stamp})\n\n` +
        `Run completion wanted **${wantedTo}** but disk is **${current.state}** ` +
        `(human steer/cancel/delete). Packet folded only; state preserved.\n`;
      body = `${body.trimEnd()}${note}`;
    }
    // A human-owned todo/retrying/cancel/done record is authoritative. A late
    // verifier may fold its packet as history, but cannot resurrect the run's
    // provider session or publish its now-superseded green SHA.
    // packetNonce is body provenance (not tip invariant) — apply when a packet
    // was folded so SPA parsers can locate the fence Hercules just wrote.
    const session = current.agentSession;
    const verifiedSha = current.verifiedSha;
    const packetNonce =
      fields.packetNonce !== undefined ? fields.packetNonce : current.packetNonce;
    const pendingSteer =
      fields.pendingSteer !== undefined ? fields.pendingSteer : current.pendingSteer;
    if (
      body === current.body &&
      session === current.agentSession &&
      verifiedSha === current.verifiedSha &&
      packetNonce === current.packetNonce &&
      pendingSteer === current.pendingSteer
    ) {
      console.error(
        `[hercules] ${current.id}: finalize skipped (kept ${current.state}, no body delta)`,
      );
      // No mutation — not a durable fold of new chat content.
      return false;
    }
    const next: Task = {
      ...current,
      body,
      agentSession: session,
      pendingSteer,
      ...(verifiedSha !== undefined ? { verifiedSha } : {}),
      ...(packetNonce !== undefined ? { packetNonce } : {}),
    };
    const { committed } = await mutateControl(this.deps.control, { writeTasks: [{ expected: current, next }] },
      `hercules: ${current.id} finalize packet only (kept ${current.state})`,
    );
    if (!committed) {
      throw new ControlNotDurableError(
        `${current.id}: finalize-packet commit returned committed:false`,
      );
    }
    console.error(
      `[hercules] ${current.id}: finalize packet only — kept human state ${current.state} ` +
        `(wanted ${wantedTo})`,
    );
    return true;
  }

  /**
   * Self-heal: review + non-empty pendingSteer older than 5m → todo + timeline.
   * Returns healed task ids (for tick report / re-read).
   *
   * Optimistic concurrency: after detecting a stuck candidate from a scan
   * snapshot, re-read that task and only write if it is **still** review with
   * non-empty pendingSteer. A concurrent human approve / cancel / delete /
   * steer must not be clobbered from a stale snapshot (L3 midrun-steer-race).
   */
  private async healStuckReviewWithPendingSteer(): Promise<string[]> {
    const snapshot = await this.deps.control.read();
    const now = this.deps.clock();
    const healed: string[] = [];
    for (const task of snapshot.tasks) {
      if (!isStuckReviewWithPendingSteer(task, now, STUCK_REVIEW_PENDING_STEER_MS)) {
        continue;
      }

      // Re-read before write — never heal from the scan snapshot alone.
      const freshSnap = await this.deps.control.read();
      const fresh = freshSnap.tasks.find((t) => t.id === task.id);
      if (!fresh) {
        console.error(
          `[hercules] ${task.id}: self-heal skipped — task gone from disk`,
        );
        continue;
      }
      if (!isStuckReviewWithPendingSteer(fresh, now, STUCK_REVIEW_PENDING_STEER_MS)) {
        const steerHint =
          (fresh.pendingSteer?.trim() ?? '').length > 0
            ? `+pendingSteer`
            : ' (no pendingSteer)';
        console.error(
          `[hercules] ${task.id}: self-heal skipped — disk is ${fresh.state}${steerHint} ` +
            `(human approve/cancel/delete/steer won the race)`,
        );
        continue;
      }

      const stamp = new Date(now).toISOString();
      const anchorIso = fresh.endedAt ?? fresh.lastEventAt ?? fresh.createdAt;
      const anchorMs = anchorIso ? Date.parse(anchorIso) : NaN;
      const stuckForMs = Number.isFinite(anchorMs)
        ? Math.max(0, now - anchorMs)
        : STUCK_REVIEW_PENDING_STEER_MS;
      const section = buildStuckReviewSteerHealSection({
        stamp,
        pendingSteerPreview: fresh.pendingSteer ?? '',
        stuckForMs,
      });
      try {
        assertTransition(fresh.state, 'todo');
      } catch (err) {
        console.error(
          `[hercules] ${task.id}: self-heal skipped — ${(err as Error).message}`,
        );
        continue;
      }
      const next: Task = {
        ...fresh,
        state: 'todo',
        // Eligible immediately; steer text stays for the next resume dispatch.
        lastEventAt: null,
        endedAt: null,
        body: `${fresh.body.trimEnd()}\n\n${section}\n`,
      };
      await mutateControl(this.deps.control, { writeTasks: [{ expected: fresh, next }] },
        `hercules: ${task.id} self-heal review+pendingSteer → todo`,
      );
      console.error(
        `[hercules] ${task.id}: self-heal stuck review+pendingSteer → todo ` +
          `(~${Math.round(stuckForMs / 60_000)}m)`,
      );
      healed.push(task.id);
    }
    return healed;
  }

  /** Start the periodic loop (real timer). Ticks never overlap. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.safeTick();
    }, this.deps.config.tickIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async safeTick(): Promise<void> {
    if (this.ticking) return; // skip if the previous tick is still running
    this.ticking = true;
    try {
      await this.tick();
    } catch (err) {
      // A tick failure (e.g. transient git error) must not kill the daemon;
      // the next tick re-derives everything from disk.
      console.error(`[hercules] tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }
}

const PACKET_MARKER = '## Review packet';

/**
 * Human-owned sections that MUST survive a packet replace (comment-to-steer
 * appends `## Human steer` *after* the packet; graceful cancel appends
 * `## Teardown`). Without this trail, the next complete() wiped audit history.
 */
const PACKET_TRAIL_HEADING = /^## (?:Human steer|Steer result|Teardown)\b/m;
const DEPENDENCY_RECOVERY_START = '<!-- dependency-preflight-recovery:start -->';
const DEPENDENCY_RECOVERY_END = '<!-- dependency-preflight-recovery:end -->';

function withDependencyRecoveryHold(
  body: string,
  input: {
    readonly code: string;
    readonly trustedTip: string;
    readonly candidateTip: string | null;
    readonly detail: string;
    readonly nextAction: string;
    readonly observedAt: string;
  },
): { readonly body: string; readonly changed: boolean; readonly fingerprint: string } {
  const fingerprint = createHash('sha256')
    .update([input.code, input.trustedTip, input.candidateTip ?? 'absent', input.detail].join('\0'))
    .digest('hex');
  const marker = `<!-- dependency-preflight-fingerprint:${fingerprint} -->`;
  if (body.includes(marker)) return { body, changed: false, fingerprint };

  const section =
    `${DEPENDENCY_RECOVERY_START}\n` +
    `## Dependency preflight recovery hold\n\n` +
    `${marker}\n\n` +
    `- Code: \`${input.code}\`\n` +
    `- Trusted tip: \`${input.trustedTip}\`\n` +
    `- Exact candidate: \`${input.candidateTip ?? '(absent)'}\`\n` +
    `- Detail: ${input.detail.slice(0, 700)}\n` +
    `- Next action: ${input.nextAction.slice(0, 300)}\n` +
    `- Observed: ${input.observedAt}\n` +
    `${DEPENDENCY_RECOVERY_END}`;
  const start = body.indexOf(DEPENDENCY_RECOVERY_START);
  const end = body.indexOf(DEPENDENCY_RECOVERY_END, start);
  const nextBody =
    start >= 0 && end >= start
      ? `${body.slice(0, start).trimEnd()}\n\n${section}${body.slice(end + DEPENDENCY_RECOVERY_END.length)}`
      : `${body.trimEnd()}\n\n${section}`;
  return { body: nextBody.trim(), changed: true, fingerprint };
}

/**
 * Replace the review packet section in a task body (SPEC §9.6), or append it if
 * absent. The marker heading is always emitted before the packet content, so the
 * FIRST occurrence is the wrapper — use indexOf, not a `\n`-anchored split: the
 * packet can sit at the very start of the body (no leading newline), and the
 * agent's own report can legitimately contain "## Review packet" (e.g. a task
 * that documents Hercules), both of which broke the old split and stacked packets.
 *
 * Content *after* the packet that is a human trail (steers, teardown) is kept
 * and re-appended after the new packet so multi-turn review history is not lost.
 */
export function withReviewPacket(body: string, packetMarkdown: string): string {
  const safeBody = neutralizeCliEvidenceStructure(body);
  const marker = safeBody.indexOf(PACKET_MARKER);
  // Neutralize forged Hercules fence lines outside the packet we are writing
  // now so a stale forged fence in base/trail can never outlive a rewrite.
  const base = neutralizeHerculesFenceLines(
    (marker >= 0 ? safeBody.slice(0, marker) : safeBody).trimEnd(),
  );

  let trail = '';
  if (marker >= 0) {
    const after = safeBody.slice(marker + PACKET_MARKER.length);
    // When the existing packet carries a packet-end fence, only search for the
    // trail AFTER that fence — an agent line `## Human steer (fake)` inside the
    // old report must not drag the old packet (and its decision-card) into the
    // trail after the new packet.
    const endFenceRe =
      /<!--\s*hercules:packet-end\s+nonce=[0-9a-fA-F]+\s*-->/;
    const endMatch = endFenceRe.exec(after);
    const searchRegion =
      endMatch && endMatch.index !== undefined
        ? after.slice(endMatch.index + endMatch[0].length)
        : after;
    const trailAt = searchRegion.search(PACKET_TRAIL_HEADING);
    if (trailAt >= 0) {
      trail = neutralizeHerculesFenceLines(searchRegion.slice(trailAt).trimEnd());
    }
  }

  const packet = packetMarkdown.trimEnd();
  if (trail.length > 0) {
    return `${base}\n\n${PACKET_MARKER}\n\n${CLI_EVIDENCE_PACKET_AUTHORITY}\n${packet}\n\n${trail}\n`;
  }
  return `${base}\n\n${PACKET_MARKER}\n\n${CLI_EVIDENCE_PACKET_AUTHORITY}\n${packet}\n`;
}

/**
 * Append a durable "Steer result" block after the latest unanswered Human steer
 * so the phone UI can pair "what you asked" with "what the agent did".
 * Pure string transform; trail order becomes: … older steers, Human, Result, …
 */
export function appendSteerResult(
  body: string,
  input: { readonly completedAt: string; readonly packet: ReviewPacket },
): string {
  const replyTo = latestHumanSteerStamp(body);
  const p = input.packet;
  const outcome = packetStatusLine(p).replace(/\*\*/g, '');
  const rawSummary =
    p.selfAssessment.trim().split('\n').find((l) => l.trim().length > 0)?.trim() ||
    p.finalReport.trim().split('\n').find((l) => l.trim().length > 0)?.trim() ||
    '(no summary)';
  // Agent-controlled summary + file names sit after the packet — neutralize
  // fence/heading look-alikes so they cannot re-anchor SPA parsers.
  const neutOpts = { taskId: p.taskId };
  const summary = neutralizeUntrustedPacketText(rawSummary, neutOpts);
  const cost =
    p.usage !== undefined
      ? `$${p.usage.costUsd.toFixed(2)} · ${p.usage.inputTokens} in / ${p.usage.outputTokens} out`
      : '_(adapter did not report usage)_';
  const files =
    p.filesTouched.length === 0
      ? '_(none)_'
      : p.filesTouched
          .map((f) => `\`${neutralizeUntrustedPacketText(f, neutOpts)}\``)
          .join(', ');
  const lines = [
    `## Steer result (${input.completedAt})`,
    '',
    replyTo
      ? `**In reply to:** Human steer (${replyTo})`
      : '**In reply to:** _(prior Human steer — stamp not found)_',
    '**Kind:** steer resume (session continue)',
    `**Outcome:** ${outcome}`,
    `**Cost:** ${cost}`,
    `**Files touched:** ${files}`,
    '',
    '**Summary**',
    summary.length > 400 ? `${summary.slice(0, 397)}…` : summary,
    '',
  ];
  return `${body.trimEnd()}\n\n${lines.join('\n')}\n`;
}

/** Parse the most recent `## Human steer (ISO)` stamp from the task body. */
export function latestHumanSteerStamp(body: string): string | null {
  const re = /^##\s+Human steer\s+\(([^)]+)\)\s*$/gm;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    last = m[1]!.trim();
  }
  return last;
}
