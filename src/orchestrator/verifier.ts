/**
 * Coordination layer — the worktree verifier (SPEC §9).
 *
 * Runs after the agent reports done, in the task's worktree: read the trusted
 * WORKFLOW (gates, protected paths, principles), capture the diff, run the
 * mechanical gates (L1) + anti-cheating scan (L5), optionally a fresh reviewer
 * (L3), and assemble the review packet (§9.6). All side effects are injected.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import type { Task } from '../domain/task.js';
import type { RepoConfig } from '../domain/repos.js';
import type { Workspace } from '../domain/allocation.js';
import { effectiveRepoExecutionPolicy } from '../domain/repoExecutionPolicy.js';
import {
  parseDefinitionOfDone,
  reviewerSkipReason,
  shouldRunReviewer,
} from '../domain/acceptance.js';
import { parseMechProofBinding } from '../domain/mechProof.js';
import {
  collectAddedTestTitles,
  extractTestCaseTitles,
} from '../verification/testIntegrity.js';
import {
  assessReportHygiene,
  reportHygieneGateOutput,
} from '../domain/reportHygiene.js';
import { parseGithubRepo, githubCompareUrl } from '../domain/github.js';
import { hasOpenPr } from '../domain/task.js';
import {
  baseDriftConflictGate,
  isBaseDriftBlocking,
  type BaseDriftReport,
} from '../domain/baseDrift.js';
import {
  splitFinalReport,
  type PacketRunKind,
  type PacketUsage,
  type ReviewPacket,
  type GateResult,
} from '../domain/verification.js';
import {
  isVerificationAborted,
  throwIfVerificationAborted,
  type VerificationProgress,
} from '../domain/verificationRun.js';
import { parseWorkflow, substituteAllocation } from '../control/workflow.js';
import { runGates, execRunner, type CommandRunner } from '../verification/gates.js';
import { scanDiff } from '../verification/antiCheat.js';
import { scanGateToolchain } from '../verification/gateToolchain.js';
import { assembleReviewPacket } from '../verification/packet.js';
import { ReviewerInfraError, type Reviewer } from '../verification/reviewer.js';
import { buildReviewerInfrastructureReceipt } from '../domain/reviewerInfrastructure.js';
import { runCliEvidence } from '../verification/cliEvidence.js';
import {
  cliEvidenceWorkspaceMutationReceipt,
  omittedCliEvidenceReceipt,
} from '../domain/cliEvidence.js';
import {
  attributeFailedGate,
  type GateFailAttributionCache,
} from '../verification/gateFailAttribution.js';
import type { GateFailAttributionReport } from '../domain/gateFailAttribution.js';
import { captureWorktreeDiff, type WorktreeDiff } from '../isolation/diff.js';
import { detectBaseDriftWithOptionalRebase } from '../isolation/baseDrift.js';
import {
  normalizeAffectedPaths,
  normalizeConfiguredWorkflowPath,
  outOfScopeDiffGate,
  validateDiffAgainstScopes,
  isFirstTimeWorkflowBootstrap,
  verifyWorkflowBootstrapCandidate,
  workflowBootstrapGate,
} from '../domain/taskPathLease.js';
import {
  fetchBoundPrSummary,
  type PrSummary,
  type TaskPrInput,
} from './taskPr.js';
import type { GhRunner } from './openPr.js';

/** Cap for worktree package.json when extracting scripts for @test observation. */
const PACKAGE_JSON_SCRIPTS_MAX_BYTES = 64 * 1024;

/**
 * Read worktree root package.json `scripts` for mechanical @test observation.
 * Missing / oversized / invalid → undefined (caller omits the field).
 */
export async function readWorktreePackageJsonScripts(
  worktreeDir: string,
): Promise<Readonly<Record<string, string>> | undefined> {
  try {
    const path = join(worktreeDir, 'package.json');
    const st = await stat(path);
    if (st.size > PACKAGE_JSON_SCRIPTS_MAX_BYTES) return undefined;
    const raw = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const scriptsVal = (parsed as Record<string, unknown>)['scripts'];
    if (
      scriptsVal === undefined ||
      scriptsVal === null ||
      typeof scriptsVal !== 'object' ||
      Array.isArray(scriptsVal)
    ) {
      return undefined;
    }
    const out: Record<string, string> = {};
    let n = 0;
    for (const [k, v] of Object.entries(scriptsVal as Record<string, unknown>)) {
      if (typeof v === 'string') {
        out[k] = v;
        n += 1;
      }
    }
    return n > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Keep only lowercase 64-hex screenshot digests for packet hollow-evidence. */
function packetScreenshotSha256(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const sha = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(sha) ? sha : undefined;
}

function pathLeaseScopeGate(task: Task, change: WorktreeDiff): GateResult | null {
  if (change.filesTouched.length === 0 || task.affectedPaths === undefined) return null;
  const declared = normalizeAffectedPaths(task.affectedPaths);
  if (!declared.ok) {
    return {
      name: 'path-lease-scope',
      command: 'hercules:path-lease-scope',
      passed: false,
      output: `invalid affected_paths on task: ${declared.reason}`,
    };
  }
  const scopeCheck = validateDiffAgainstScopes(change.filesTouched, declared.scopes);
  return scopeCheck.ok ? null : outOfScopeDiffGate(scopeCheck.outOfScope);
}

export interface VerifyOptions {
  readonly activityLog?: readonly string[];
  readonly usage?: PacketUsage;
  readonly finalReport?: string;
  /** Full implementer vs session-resume steer (cost labeling). */
  readonly runKind?: PacketRunKind;
  /** Human cancel / force-abort aborts gate process groups mid-flight. */
  readonly signal?: AbortSignal;
  /** Bounded progress for live API/UI (phase/stage only — no command secrets). */
  readonly onProgress?: (update: VerificationProgress) => void;
}

function isActivityLogArg(
  v: readonly string[] | VerifyOptions,
): v is readonly string[] {
  return Array.isArray(v);
}

export interface Verifier {
  verify(
    task: Task,
    repo: RepoConfig,
    workspace: Workspace,
    activityLogOrOpts?: readonly string[] | VerifyOptions,
    usage?: PacketUsage,
    finalReport?: string,
  ): Promise<ReviewPacket>;
}

/** Boots the app and drives a browser for evidence (Layer 2). Composed in main. */
export interface BehavioralRunner {
  run(input: {
    readonly taskId: string;
    readonly baseUrl: string;
    readonly bootCommands: readonly string[];
    readonly healthCommand: string | undefined;
    readonly captures: number;
    readonly cwd: string;
    readonly localStorage?: Readonly<Record<string, string>>;
    readonly mobile?: boolean;
    readonly smokeFlows?: readonly string[];
    readonly taskBody?: string;
    readonly workflowEvidence?: import('../domain/evidence.js').EvidenceStep[];
    /** Human cancel — must abort boot/browser mid-phase, not only after await. */
    readonly signal?: AbortSignal;
    /** Repo policy for the L2 boot/health child env boundary. */
    readonly executionPolicy?: import('../domain/repoExecutionPolicy.js').EffectiveRepoExecutionPolicy | null;
  }): Promise<{
    screenshots: string[];
    healthy: boolean;
    evidenceRun?: import('../domain/evidence.js').EvidenceRunSummary;
    /** EXACT reason evidence did not run (never let the packet guess). */
    evidenceSkipReason?: string;
    /** Optional transport / boot error string (remote heavy runner surfaces this). */
    error?: string;
  }>;
}

export interface VerifierDeps {
  readonly workspaces: {
    readWorkflow(repo: RepoConfig): Promise<string | null>;
    readTrustedDefaultRevisionSnapshot?(repo: RepoConfig): Promise<{
      readonly revision: string;
      readonly workflowContent: string | null;
    } | null>;
    /** Root package.json (and peers) from the trusted mirror default branch. */
    readTrustedFile?(repo: RepoConfig, path: string): Promise<string | null>;
  };
  /** Static candidate blob read at an exact revision (test seam). */
  readonly readCandidateFileAt?: (
    worktreeDir: string,
    revision: string,
    path: string,
  ) => Promise<string | null>;
  readonly captureDiff?: (worktreeDir: string, baseRef: string) => Promise<WorktreeDiff>;
  readonly commandRunner?: CommandRunner;
  readonly auditCliEvidenceWorkspace?: (
    dir: string,
    expectedSha: string | null,
  ) => Promise<{ readonly mutated: boolean }>;
  /** Optional fresh-context reviewer (Layer 3). Omit to skip the costly review. */
  readonly reviewer?: Reviewer;
  /**
   * When true, L3 never runs (HERCULES_REVIEWER=0). Default false: L3 runs when
   * DoD needs a reviewer or the diff is non-trivial without a typed DoD.
   */
  readonly reviewerDisabled?: boolean;
  /** Optional behavioral runner (Layer 2). Omit to skip booting + screenshots. */
  readonly behavioral?: BehavioralRunner;
  /**
   * Root for task evidence media (`<screenshotsRoot>/<taskId>/…`). When set,
   * CLI evidence steps with `artifacts_dir` copy collected media here.
   */
  readonly screenshotsRoot?: string;
  /**
   * Resolve the worktree HEAD SHA (injectable for tests). Default: git
   * rev-parse; null when the dir is not a git worktree (fake mode).
   */
  readonly resolveHead?: (dir: string) => Promise<string | null>;
  /**
   * Durability point: commit staged+untracked worktree state before capturing
   * the verified SHA (injectable for tests). Default: commitVerifiedState.
   */
  readonly commitState?: (dir: string, message: string) => Promise<string | null>;
  /**
   * C3.56: drop every uncommitted change in a verify-only worktree (tracked +
   * untracked, ignored files untouched) and return the discarded paths.
   * Injectable for tests; defaults to {@link discardUncommittedWorktreeChanges}.
   */
  readonly discardWorktreeChanges?: (dir: string) => Promise<readonly string[]>;
  /**
   * Open-PR mergeability probe (injectable for tests). Default: `gh pr view`.
   * Used so agents cannot claim "conflicts fixed" while GitHub still says CONFLICTING.
   */
  readonly fetchPrSummary?: (input: TaskPrInput) => Promise<PrSummary>;
  /** Optional gh runner for the real bound PR path (tests). */
  readonly gh?: GhRunner;
  /**
   * Pre-review base-drift probe (injectable for tests). Default: real git
   * merge-base / rev-list / merge-tree in the worktree.
   */
  readonly detectBaseDrift?: (
    worktreeDir: string,
    defaultBranch: string,
    opts: { readonly autoRebase: boolean },
  ) => Promise<BaseDriftReport>;
  /**
   * When true, verify may locally rebase the task branch onto default and
   * re-run L1 (HERCULES_AUTO_REBASE). Default false — never force-pushes,
   * never merges to main.
   */
  readonly autoRebase?: boolean;
  /**
   * Cache for merge-base gate-fail reproduction probes (per repo/merge-base/test).
   * Default: process-wide in-memory cache.
   */
  readonly gateFailAttributionCache?: GateFailAttributionCache;
  /**
   * Optional override for the attribution probe (tests). When provided, skips
   * real checkout + re-run.
   */
  readonly attributeGateFail?: (
    input: Parameters<typeof attributeFailedGate>[0],
  ) => Promise<GateFailAttributionReport | null>;
}

export class WorktreeVerifier implements Verifier {
  constructor(private readonly deps: VerifierDeps) {}

  /**
   * Mechanical PR mergeability gate. CONFLICTING → fail (auto-rework).
   * MERGEABLE → pass. UNKNOWN / fetch errors → soft skip (no gate row) so
   * GitHub race / offline does not brick verification.
   */
  private async prMergeableGate(
    task: Task,
    repo: RepoConfig,
  ): Promise<readonly GateResult[]> {
    const prUrl = task.prUrl;
    if (!prUrl) return [];
    const fetch =
      this.deps.fetchPrSummary ??
      ((input: TaskPrInput) =>
        fetchBoundPrSummary({
          ...input,
          ...(this.deps.gh ? { gh: this.deps.gh } : {}),
        }));
    try {
      const summary = await fetch({
        prUrl,
        taskId: task.id,
        repo,
      });
      const m = (summary.mergeable ?? '').toUpperCase();
      if (m === 'CONFLICTING') {
        return [
          {
            name: 'pr-mergeable',
            command: 'hercules:pr-mergeable',
            passed: false,
            output:
              `GitHub reports PR mergeable=CONFLICTING (${prUrl}). ` +
              `Merge/rebase the default branch, resolve conflicts, push, then re-run.`,
          },
        ];
      }
      if (m === 'MERGEABLE') {
        return [
          {
            name: 'pr-mergeable',
            command: 'hercules:pr-mergeable',
            passed: true,
            output: `PR is MERGEABLE (${prUrl})`,
          },
        ];
      }
      // UNKNOWN / null — do not fail the turn on GitHub lag.
      return [];
    } catch (err) {
      console.error(
        `[hercules] pr-mergeable probe failed for ${prUrl}: ${(err as Error).message}`,
      );
      return [];
    }
  }

  async verify(
    task: Task,
    repo: RepoConfig,
    workspace: Workspace,
    activityLogOrOpts: readonly string[] | VerifyOptions = [],
    usageArg?: PacketUsage,
    finalReportArg = '',
  ): Promise<ReviewPacket> {
    // Back-compat: verify(task, repo, ws, activity, usage, report) or opts bag.
    let activityLog: readonly string[] = [];
    let usage: PacketUsage | undefined;
    let finalReport = '';
    let runKind: PacketRunKind = 'implementer';
    let signal: AbortSignal | undefined;
    let onProgress: ((update: VerificationProgress) => void) | undefined;
    if (isActivityLogArg(activityLogOrOpts)) {
      activityLog = activityLogOrOpts;
      usage = usageArg;
      finalReport = finalReportArg;
    } else {
      activityLog = activityLogOrOpts.activityLog ?? [];
      usage = activityLogOrOpts.usage;
      finalReport = activityLogOrOpts.finalReport ?? '';
      runKind = activityLogOrOpts.runKind === 'steer' ? 'steer' : 'implementer';
      signal = activityLogOrOpts.signal;
      onProgress = activityLogOrOpts.onProgress;
    }
    const reportProgress = (update: VerificationProgress): void => {
      onProgress?.(update);
    };
    throwIfVerificationAborted(signal);

    const workflowContent = await this.deps.workspaces.readWorkflow(repo);
    // Detect bootstrap intent without executing any candidate commands, then
    // independently re-prove it against one exact trusted default snapshot.
    // Dispatch-time proof is insufficient because main can move before L1.
    const bootstrapIntent = isFirstTimeWorkflowBootstrap({
      trustedRevision: task.plannedBaseRevision ?? '',
      workflowContent: workflowContent,
      repoReadiness: repo.readiness,
      labels: task.labels,
      plannedBaseRevision: task.plannedBaseRevision,
      affectedPaths: task.affectedPaths,
      protectedPathsSnapshot: task.protectedPathsSnapshot,
      configuredWorkflowPath: repo.workflow,
    });
    const trustedBootstrapSnapshot = bootstrapIntent
      ? await this.deps.workspaces.readTrustedDefaultRevisionSnapshot?.(repo)
      : null;
    const bootstrapEligible =
      bootstrapIntent &&
      trustedBootstrapSnapshot !== null &&
      trustedBootstrapSnapshot !== undefined &&
      isFirstTimeWorkflowBootstrap({
        trustedRevision: trustedBootstrapSnapshot.revision,
        workflowContent: trustedBootstrapSnapshot.workflowContent,
        repoReadiness: repo.readiness,
        labels: task.labels,
        plannedBaseRevision: task.plannedBaseRevision,
        affectedPaths: task.affectedPaths,
        protectedPathsSnapshot: task.protectedPathsSnapshot,
        configuredWorkflowPath: repo.workflow,
      });
    const workflow = workflowContent
      ? parseWorkflow(workflowContent)
      : {
          setup: { install: [], boot: [] },
          healthCheck: undefined,
          behavioral: undefined,
          cliEvidence: undefined,
          gates: [],
          protectedPaths: [],
          heldOutSmoke: undefined,
          body: '',
        };

    const captureDiff = this.deps.captureDiff ?? captureWorktreeDiff;
    const commitState = this.deps.commitState ?? commitVerifiedState;
    const resolveHead = this.deps.resolveHead ?? defaultResolveHead;
    const autoRebase = this.deps.autoRebase === true;
    const detectDrift =
      this.deps.detectBaseDrift ??
      ((dir: string, defaultBranch: string, opts: { readonly autoRebase: boolean }) =>
        detectBaseDriftWithOptionalRebase(dir, defaultBranch, opts));

    // Capture and scope-check the complete staged + untracked tree before the
    // durability commit. A scope-blocked tree stays only in the local checkout:
    // it must never become a verified commit or reach the task ref.
    // (2026-07-17: onboard-verify-2's uncommitted 745-line diff was wiped
    // between verify and preserve and could not be recovered.)
    // C3.56: a verify-only run judges the exact seeded tip. The agent is
    // read-only by policy, but any bytes that still reach the worktree must
    // never become the verified state (a downstream project task 24: two empty probe
    // files from the verify agent were auto-committed at L1 and merged).
    // Discard them, never auto-commit, and fail closed if HEAD is not the seed.
    const verifyOnly = task.executionClass === 'verify';
    let verifyOnlyDiscardedPaths: readonly string[] = [];
    if (verifyOnly) {
      const discard = this.deps.discardWorktreeChanges ?? discardUncommittedWorktreeChanges;
      verifyOnlyDiscardedPaths = await discard(workspace.dir);
      if (verifyOnlyDiscardedPaths.length > 0) {
        console.error(
          `[hercules] verify-only run ${task.id}: discarded ${verifyOnlyDiscardedPaths.length} ` +
            `uncommitted path(s) before L1 (never committed): ${verifyOnlyDiscardedPaths.join(', ')}`,
        );
      }
    }
    let change = await captureDiff(workspace.dir, repo.defaultBranch);
    let scopeGate = pathLeaseScopeGate(task, change);
    let verifiedSha =
      scopeGate || verifyOnly
        ? await resolveHead(workspace.dir)
        : ((await commitState(
            workspace.dir,
            `hercules: ${task.id} — verified state (auto-commit at L1)`,
          )) ?? (await resolveHead(workspace.dir)));
    const verifyOnlySeed =
      verifyOnly && typeof task.seedFromSha === 'string' && /^[0-9a-f]{40}$/i.test(task.seedFromSha)
        ? task.seedFromSha.toLowerCase()
        : null;
    const verifyOnlyTipMismatch =
      verifyOnlySeed !== null && (verifiedSha ?? '').toLowerCase() !== verifyOnlySeed
        ? { seed: verifyOnlySeed, head: verifiedSha }
        : undefined;
    if (verifyOnlyTipMismatch) {
      console.error(
        `[hercules] verify-only run ${task.id}: worktree tip ${verifiedSha ?? '(unknown)'} ` +
          `is not the seed ${verifyOnlySeed} — failing closed`,
      );
    }
    if (scopeGate === null) {
      // A post-commit hook may leave new bytes even though verifier-owned
      // commits bypass pre-commit/commit-msg hooks. Re-read before drift or
      // publication so those bytes remain local and scope-block teardown wins.
      change = await captureDiff(workspace.dir, repo.defaultBranch);
      scopeGate = pathLeaseScopeGate(task, change);
    }

    // Pre-review base drift: merge-base vs default branch + conflict risk.
    // Optional HERCULES_AUTO_REBASE rebases the *task* branch only, then we
    // re-capture the diff and re-commit so L1 sees the rebased tree.
    // Never force-pushes; never merges to main.
    let baseDrift = await detectDrift(workspace.dir, repo.defaultBranch, {
      // Verify-only runs judge the seeded tip as-is — never rebase it.
      autoRebase: scopeGate === null && autoRebase && !verifyOnly,
    });
    if (baseDrift.rebaseAttempted && baseDrift.rebaseOk === true) {
      const rebaseDetail =
        baseDrift.rebaseDetail ?? 'rebased onto default; L1 will run on rebased tip';
      // Rebase hooks and filters may have created new staged/untracked bytes.
      // Re-capture and re-check before the second durability commit.
      change = await captureDiff(workspace.dir, repo.defaultBranch);
      scopeGate = pathLeaseScopeGate(task, change);
      verifiedSha = scopeGate
        ? await resolveHead(workspace.dir)
        : (await commitState(
            workspace.dir,
            `hercules: ${task.id} — verified state after auto-rebase`,
          )) ?? (await resolveHead(workspace.dir));
      if (scopeGate === null) {
        change = await captureDiff(workspace.dir, repo.defaultBranch);
        scopeGate = pathLeaseScopeGate(task, change);
      }
      // Re-probe after rebase so the packet shows post-rebase lag (usually 0).
      baseDrift = await detectDrift(workspace.dir, repo.defaultBranch, { autoRebase: false });
      baseDrift = {
        ...baseDrift,
        rebaseAttempted: true,
        rebaseOk: true,
        rebaseDetail,
      };
    }

    // Install deps first (so the gates can run), then the gates — fail-fast.
    // Read-only / Q&A runs (no file changes): skip install + gates. Re-running
    // typecheck/lint/test would burn time and tokens for zero signal when the
    // agent never mutated the worktree (comment-to-steer follow-ups, summaries).
    // First-time WORKFLOW bootstrap: never execute untrusted candidate-defined
    // commands (trusted tip has no workflow yet). Ordinary tasks still run
    // trusted gates from the default-branch WORKFLOW only.
    const installGates = bootstrapIntent
      ? []
      : workflow.setup.install.map((command) => ({ name: 'setup', command }));
    // G2: held-out smoke is a real L1 gate the agent may RUN but must not edit
    // (paths listed under protected_paths). Appended after install + structure gates.
    const heldOutGates =
      !bootstrapIntent && workflow.heldOutSmoke && workflow.heldOutSmoke.trim().length > 0
        ? [{ name: 'held-out-smoke', command: workflow.heldOutSmoke.trim() }]
        : [];
    const allGates = bootstrapIntent
      ? []
      : [...installGates, ...workflow.gates, ...heldOutGates];
    const noFileChanges = change.filesTouched.length === 0;
    throwIfVerificationAborted(signal);
    let gates: GateResult[] = scopeGate
      ? [scopeGate]
      : noFileChanges
        ? allGates.map((g) => ({
          name: g.name,
          command: g.command,
          passed: true,
          output: 'skipped: no file changes (read-only / Q&A run)',
          outcome: 'skipped' as const,
        }))
        : await runGates(allGates, workspace.dir, this.deps.commandRunner ?? execRunner, {
          ...(signal ? { signal } : {}), executionPolicy: effectiveRepoExecutionPolicy(repo.executionPolicy ?? null),
          ...(onProgress
            ? {
                onProgress: (p) => {
                  reportProgress({
                    phase: p.phase,
                    stage: p.stage,
                    ...(p.processAlive !== undefined ? { processAlive: p.processAlive } : {}),
                    ...(p.completedStage !== undefined
                      ? { completedStage: p.completedStage }
                      : {}),
                  });
                },
              }
            : {}),
        });
    throwIfVerificationAborted(signal);

    // Bootstrap verifier: exact one-path + parse candidate; never run its gates.
    if (bootstrapIntent) {
      let candidateContent: string | null = null;
      const workflowPath = normalizeConfiguredWorkflowPath(repo.workflow);
      if (verifiedSha !== null && workflowPath !== null) {
        try {
          candidateContent = this.deps.readCandidateFileAt
            ? await this.deps.readCandidateFileAt(
                workspace.dir,
                verifiedSha,
                workflowPath,
              )
            : await simpleGit(workspace.dir).show([`${verifiedSha}:${workflowPath}`]);
        } catch {
          candidateContent = null;
        }
      }
      const bootstrapVerdict = verifyWorkflowBootstrapCandidate({
        eligible: bootstrapEligible,
        configuredWorkflowPath: workflowPath ?? repo.workflow,
        filesTouched: change.filesTouched,
        candidateContent,
        parseCandidate: (content) => {
          try {
            parseWorkflow(content);
            return null;
          } catch (err) {
            return err instanceof Error ? err.message : String(err);
          }
        },
      });
      gates = [...gates, workflowBootstrapGate(bootstrapVerdict)];
    }

    // Hard base-drift conflict → synthetic gate (auto-rework; not green).
    if (isBaseDriftBlocking(baseDrift)) {
      gates = [...gates, baseDriftConflictGate(baseDrift)];
    }

    // Open PR still on the task: always probe mergeability (even empty-diff steers).
    // settings-build: agent reported conflicts fixed; GitHub stayed CONFLICTING.
    if (hasOpenPr(task) && task.prUrl) {
      gates = [...gates, ...(await this.prMergeableGate(task, repo))];
    }

    // Gate-fail attribution: when test/held-out fails, re-run the same item on
    // pure merge-base. Reproduced → trunk debt (no auto-rework). Not setup/build.
    let gateFailAttribution: GateFailAttributionReport | undefined;
    if (!noFileChanges) {
      const failedGate = gates.find((g) => !g.passed);
      if (failedGate) {
        const probeRoot = join(
          workspace.allocation.scratchDir,
          'merge-base-probe',
          repo.key,
        );
        const attrFn = this.deps.attributeGateFail ?? attributeFailedGate;
        try {
          const report = await attrFn({
            failedGate,
            mergeBase: baseDrift.mergeBase ?? change.compareBase,
            repoKey: repo.key,
            filesTouched: change.filesTouched,
            worktreeDir: workspace.dir,
            probeRoot,
            run: this.deps.commandRunner ?? execRunner,
            ...(signal ? { signal } : {}), executionPolicy: effectiveRepoExecutionPolicy(repo.executionPolicy ?? null),
            ...(this.deps.gateFailAttributionCache
              ? { cache: this.deps.gateFailAttributionCache }
              : {}),
          });
          if (report) gateFailAttribution = report;
        } catch (err) {
          if (isVerificationAborted(err) || signal?.aborted) throw err;
          console.error(
            `[hercules] gate-fail attribution probe failed for ${task.id}: ${(err as Error).message}`,
          );
        }
      }
    }

    const cheatFindings = [
      ...scanDiff(change.diff, { protectedPaths: workflow.protectedPaths }),
      // Provenance flag: commits attributed to other tasks aboard this branch
      // (cherry-picks). Review-severity — visible in packet + reviewer prompt.
      ...(change.foreignTaskIds && change.foreignTaskIds.length > 0
        ? [
            {
              kind: 'cross-task-commits' as const,
              file: '(branch history)',
              detail:
                `commits attributed to other tasks aboard: ${change.foreignTaskIds.join(', ')} — ` +
                `lineage crosses task boundaries (cherry-pick); confirm the source task's ` +
                `status and expect merge overlap`,
            },
          ]
        : []),
    ];

    // S2: gate-toolchain edits (package scripts / configs the trusted gates
    // resolve from the worktree). Skip when there is no diff to scan.
    if (change.filesTouched.length > 0) {
      let trustedPackageJson: string | null = null;
      let candidatePackageJson: string | null = null;
      try {
        trustedPackageJson = this.deps.workspaces.readTrustedFile
          ? await this.deps.workspaces.readTrustedFile(repo, 'package.json')
          : null;
      } catch {
        trustedPackageJson = null;
      }
      if (verifiedSha !== null) {
        try {
          candidatePackageJson = this.deps.readCandidateFileAt
            ? await this.deps.readCandidateFileAt(
                workspace.dir,
                verifiedSha,
                'package.json',
              )
            : await simpleGit(workspace.dir).show([`${verifiedSha}:package.json`]);
        } catch {
          candidatePackageJson = null;
        }
      }
      const gateCommands = allGates.map((g) => g.command);
      const toolchain = scanGateToolchain({
        diff: change.diff,
        gateCommands,
        trustedPackageJson,
        candidatePackageJson,
      });
      for (const f of toolchain.findings) cheatFindings.push(f);
    }

    // Synthetic "all passed" for empty gate lists must not look green when we
    // short-circuited; packet.noChanges already forces not-green. gatesPassed is
    // still used to decide whether L2/L3 are worth running (they require diffs).
    // Empty gate list (no WORKFLOW gates) is not a failure — unless pr-mergeable failed.
    const gatesPassed =
      gates.length === 0 ? allGates.length === 0 : gates.every((g) => g.passed);
    const dod = parseDefinitionOfDone(task.body);

    // Layer 2 — boot + drive a browser (only worth it once the gates are green
    // AND the agent actually changed something — no point verifying a non-result).
    let screenshots: string[] = [];
    let evidenceRun: import('../domain/evidence.js').EvidenceRunSummary | undefined;
    let behavioralSkipDetail: string | undefined;
    if (gatesPassed && change.filesTouched.length > 0 && workflow.behavioral && this.deps.behavioral) {
      throwIfVerificationAborted(signal);
      reportProgress({ phase: 'l2', stage: 'behavioral', processAlive: true });
      const alloc = workspace.allocation;
      const sub = (c: string): string => substituteAllocation(c, alloc);
      const authToken = workflow.behavioral.authToken?.trim();
      const localStorage =
        authToken && authToken.length > 0
          ? { [workflow.behavioral.authStorageKey]: authToken }
          : undefined;
      const captureCount = Math.max(1, workflow.behavioral.capture.length);
      // Boot is trusted WORKFLOW only (SPEC §10). Docs browser evidence relies
      // on scripts/l2-seed-control-fixture.mjs (setup.boot) seeding a real
      // registry entry + bare mirror — never client-side fixture content.
      const behavioral = await this.deps.behavioral.run({
        taskId: task.id,
        baseUrl: sub(workflow.behavioral.baseUrl),
        bootCommands: workflow.setup.boot.map(sub),
        healthCommand: workflow.healthCheck ? sub(workflow.healthCheck) : undefined,
        captures: captureCount,
        cwd: workspace.dir,
        smokeFlows: workflow.behavioral.smokeFlows,
        taskBody: task.body,
        workflowEvidence: [...workflow.behavioral.evidence],
        ...(localStorage ? { localStorage, mobile: true } : {}),
        ...(signal ? { signal } : {}),
        executionPolicy: effectiveRepoExecutionPolicy(repo.executionPolicy ?? null),
      });
      throwIfVerificationAborted(signal);
      screenshots = behavioral.screenshots;
      evidenceRun = behavioral.evidenceRun;
      behavioralSkipDetail = behavioral.evidenceSkipReason;
      reportProgress({
        phase: 'l2',
        stage: 'behavioral',
        processAlive: false,
        completedStage: 'behavioral',
      });
    } else if (
      gatesPassed &&
      change.filesTouched.length > 0 &&
      workflow.behavioral &&
      !this.deps.behavioral
    ) {
      behavioralSkipDetail = 'Chromium 未安装(daemon 主机无浏览器)— L2 无法运行';
    }
    // Fail-open guard (SPEC §9.2): WORKFLOW declared behavioral: (L2 REQUIRED
    // for this repo) and this run was at the point L2 should have executed
    // (gates green + files changed), yet no evidence was produced — no runner
    // (no Chromium), boot failed, or an empty plan. Surface it as non-green so
    // the task cannot reach the human as a false "verified" green.
    const behavioralExpectedButMissing =
      gatesPassed &&
      change.filesTouched.length > 0 &&
      workflow.behavioral !== undefined &&
      evidenceRun === undefined;

    let cliEvidence: import('../domain/cliEvidence.js').CliEvidenceReceipt | undefined;
    const cliEvidenceEligible = gatesPassed && change.filesTouched.length > 0;
    if (workflow.cliEvidence && cliEvidenceEligible) {
      throwIfVerificationAborted(signal);
      reportProgress({ phase: 'l2', stage: 'cli-evidence', processAlive: true });
      const auditCliWorkspace =
        this.deps.auditCliEvidenceWorkspace ?? auditAndRestoreCliEvidenceWorkspace;
      let cliRunError: unknown;
      try {
        const evidenceDir = this.deps.screenshotsRoot
          ? join(this.deps.screenshotsRoot, task.id)
          : undefined;
        cliEvidence = await runCliEvidence({
          plan: workflow.cliEvidence,
          workspaceDir: workspace.dir,
          executionPolicy: effectiveRepoExecutionPolicy(repo.executionPolicy ?? null),
          ...(signal ? { signal } : {}),
          ...(evidenceDir !== undefined ? { evidenceDir, taskId: task.id } : {}),
        });
      } catch (err) {
        cliRunError = err;
      } finally {
        // This is a Hercules-owned isolated verification worktree. Always
        // restore the committed L1 tree, including ignored build/cache output,
        // before it can be reused for rework or cancellation recovery.
        const integrity = await auditCliWorkspace(workspace.dir, verifiedSha);
        if (integrity.mutated && cliEvidence) {
          cliEvidence = cliEvidenceWorkspaceMutationReceipt(cliEvidence);
        }
      }
      if (cliRunError) throw cliRunError;
      throwIfVerificationAborted(signal);
      reportProgress({ phase: 'l2', stage: 'cli-evidence', processAlive: false, completedStage: 'cli-evidence' });
    } else if (workflow.cliEvidence) {
      cliEvidence = omittedCliEvidenceReceipt(
        workflow.cliEvidence,
        gatesPassed ? 'no changed files to verify' : 'L1 gates failed',
      );
    }
    const cliEvidenceExpectedButMissing =
      workflow.cliEvidence !== undefined && cliEvidenceEligible && cliEvidence === undefined;
    const cliEvidencePassed =
      workflow.cliEvidence === undefined || cliEvidence?.status === 'passed';

    const l3Input = {
      dod,
      noFileChanges,
      gatesPassed: gatesPassed && cliEvidencePassed,
      reviewerAvailable: this.deps.reviewer !== undefined,
      ...(this.deps.reviewerDisabled !== undefined
        ? { reviewerDisabled: this.deps.reviewerDisabled }
        : {}),
    };
    const skipReason = reviewerSkipReason(l3Input);
    const runL3 = shouldRunReviewer(l3Input);

    let reviewerVerdict = null;
    let reviewerRan = false;
    if (runL3 && this.deps.reviewer) {
      throwIfVerificationAborted(signal);
      reportProgress({ phase: 'l3', stage: 'reviewer', processAlive: true });
      reviewerRan = true;
      try {
        reviewerVerdict = await this.deps.reviewer.review({
          task,
          diff: change.diff,
          cheatFindings,
          principles: workflow.body,
          dod,
          // L1/L2 ran the trusted config; don't let L3 demand the impossible.
          workflowSelfChanged: change.filesTouched.some((f) => f === repo.workflow),
          ...(signal ? { signal } : {}),
          executionPolicy: effectiveRepoExecutionPolicy(repo.executionPolicy ?? null),
        });
      } catch (err) {
        if (err instanceof ReviewerInfraError && verifiedSha && /^[0-9a-f]{40}$/i.test(verifiedSha)) {
          const greenEvidence = [
            ...gates.filter((gate) => gate.passed).map((gate) => gate.name),
            ...(evidenceRun?.ok ? ['behavioral'] : []),
            ...(cliEvidence?.status === 'passed' ? ['cli-evidence'] : []),
          ];
          const receipt = buildReviewerInfrastructureReceipt({
            provider: err.provider,
            detail: err.message,
            observedAt: new Date().toISOString(),
            candidateSha: verifiedSha,
            branch: workspace.branch,
            worktree: workspace.dir,
            greenEvidence,
          });
          throw new ReviewerInfraError(err.message, {
            provider: err.provider,
            receipt,
          });
        }
        throw err;
      }
      throwIfVerificationAborted(signal);
      reportProgress({
        phase: 'l3',
        stage: 'reviewer',
        processAlive: false,
        completedStage: 'reviewer',
      });
    }

    throwIfVerificationAborted(signal);
    reportProgress({ phase: 'packet', stage: 'assemble', processAlive: false });

    const gh = parseGithubRepo(repo.url);
    const diffUrl = gh
      ? githubCompareUrl(gh, repo.defaultBranch, workspace.branch)
      : null;

    // The self-assessment comes from the agent's OWN final message (which the
    // prompt requires it to end with) — not the control-repo task file, which the
    // agent cannot write. Split it out so the report and the assessment are
    // distinct packet sections rather than duplicated.
    const { report, selfAssessment } = splitFinalReport(finalReport);
    const hygiene = assessReportHygiene(report, selfAssessment);

    // Soft hygiene: never fail L1 / never auto-rework solely because the final
    // message is a multi-stream dump. Clean the packet for the human, warn, and
    // still park in review when structure gates + L3 are fine (operator-first).
    // Hard auto-rework remains for real gate failures and L3 changes_requested.
    const gatesWithHygiene = hygiene.polluted
      ? [
          ...gates,
          {
            name: 'report-hygiene',
            command: 'hercules:report-hygiene',
            passed: true, // soft — informational only
            output: `WARN (soft): ${reportHygieneGateOutput(hygiene.reasons)}`,
            outcome: 'info' as const,
          },
        ]
      : gates;

    const evidencePacket = evidenceRun
      ? {
          source: evidenceRun.plan.source,
          ok: evidenceRun.ok,
          steps: evidenceRun.results.map((r) => {
            const screenshotSha256 = packetScreenshotSha256(r.screenshotSha256);
            return {
              kind: r.step.kind,
              ok: r.ok,
              detail: r.detail,
              ...(r.step.optional ? { optional: true as const } : {}),
              ...(r.screenshot ? { screenshot: r.screenshot } : {}),
              ...(screenshotSha256 !== undefined
                ? { screenshotSha256 }
                : {}),
              ...(r.step.raw ? { raw: r.step.raw } : {}),
            };
          }),
        }
      : undefined;

    // Trusted proof inputs for mechanical @test: bindings (S1b).
    const testGateRow = gatesWithHygiene.find(
      (g) => g.name === 'test' || /^test\b/.test(g.name),
    );
    const testGate = testGateRow
      ? {
          passed: testGateRow.passed,
          output: testGateRow.output,
          command: testGateRow.command,
        }
      : null;
    const addedTestTitles = collectAddedTestTitles(change.diff);
    let testCaseIndex: ReadonlyMap<string, readonly string[]> | undefined;
    if (verifiedSha !== null && /^[0-9a-f]{40}$/i.test(verifiedSha)) {
      const index = new Map<string, readonly string[]>();
      for (const c of dod.criteria) {
        if (c.kind !== 'mechanical') continue;
        const binding = parseMechProofBinding(c.text);
        if (binding.kind !== 'test-case' && binding.kind !== 'test-path') continue;
        const path = binding.ref.replace(/^\.\//, '');
        if (index.has(path)) continue;
        try {
          const content = this.deps.readCandidateFileAt
            ? await this.deps.readCandidateFileAt(workspace.dir, verifiedSha, path)
            : await simpleGit(workspace.dir).show([`${verifiedSha}:${path}`]);
          // The path hint picks the Rust vs JS extractor by extension; without
          // it a .rs file containing `test(` (e.g. `#[tokio::test(flavor = …)]`)
          // was lexed as JavaScript and every fn went "not found"
          // (a downstream project, 2026-09-12).
          index.set(path, extractTestCaseTitles(content ?? '', path));
        } catch {
          // Unreadable at the verified revision ≠ absent: leave the path out
          // so the binding reports "could not be read" (pending) instead of a
          // false "contracted test not found" failure.
        }
      }
      testCaseIndex = index;
    }

    const packageJsonScripts = await readWorktreePackageJsonScripts(workspace.dir);

    return assembleReviewPacket({
      taskId: task.id,
      branch: workspace.branch,
      filesTouched: change.filesTouched,
      // Verification uses the trusted-mirror WORKFLOW; a task that edits it
      // cannot exercise its own new boot/gates this run (see packet.ts).
      workflowPath: repo.workflow,
      diffSummary: change.diffSummary,
      diff: change.diff,
      gates: gatesWithHygiene,
      cheatFindings,
      screenshots,
      reviewerVerdict,
      reviewerRan,
      reviewerSkipReason: reviewerRan ? null : skipReason,
      selfAssessment: hygiene.selfAssessment || '(agent provided none)',
      finalReport: hygiene.cleanedReport,
      reportPolluted: hygiene.polluted,
      activityLog,
      dod,
      runKind,
      diffUrl,
      taskTitle: task.title,
      taskBody: task.body,
      taskLabels: task.labels,
      testGate,
      addedTestTitles,
      ...(testCaseIndex !== undefined ? { testCaseIndex } : {}),
      ...(packageJsonScripts !== undefined ? { packageJsonScripts } : {}),
      ...(task.executionClass !== undefined ? { executionClass: task.executionClass } : {}),
      ...(task.hostCommandScope !== undefined
        ? { hostCommandScope: task.hostCommandScope }
        : {}),
      verifiedSha,
      baseDrift,
      ...(verifyOnlyDiscardedPaths.length > 0 ? { verifyOnlyDiscardedPaths } : {}),
      ...(verifyOnlyTipMismatch ? { verifyOnlyTipMismatch } : {}),
      behavioralExpectedButMissing,
      behavioralNotDeclared: workflow.behavioral === undefined,
      ...(behavioralSkipDetail ? { behavioralSkipDetail } : {}),
      ...(evidencePacket ? { evidenceRun: evidencePacket } : {}),
      ...(usage ? { usage } : {}),
      ...(cliEvidence ? { cliEvidence } : {}),
      ...(cliEvidenceExpectedButMissing ? { cliEvidenceExpectedButMissing: true } : {}),
      ...(gateFailAttribution ? { gateFailAttribution } : {}),
      // Cross-task commit evidence for DecisionCard badges (from same detection loop).
      ...(change.foreignCommits && change.foreignCommits.length > 0
        ? { crossTaskCommits: change.foreignCommits }
        : {}),
    });
  }
}

export class CliEvidenceWorkspaceIntegrityError extends Error {
  override readonly name = 'CliEvidenceWorkspaceIntegrityError';
  readonly code = 'cli_evidence_workspace_integrity' as const;
}

export async function auditAndRestoreCliEvidenceWorkspace(
  dir: string,
  expectedSha: string | null,
): Promise<{ readonly mutated: boolean }> {
  if (!expectedSha || !/^[0-9a-f]{7,40}$/i.test(expectedSha)) {
    throw new CliEvidenceWorkspaceIntegrityError(
      'CLI evidence workspace baseline unavailable; integrity cannot be proven',
    );
  }
  const git = simpleGit(dir);
  try {
    const head = (await git.raw(['rev-parse', 'HEAD'])).trim();
    const status = await git.status();
    const mutated = head !== expectedSha || status.files.length > 0;
    // Cleanup is unconditional: ignored artifacts are invisible to status but
    // may contain executable/build poison left by a candidate command.
    await git.raw(['reset', '--hard', expectedSha]);
    await git.raw(['clean', '-fdx']);
    const restoredHead = (await git.raw(['rev-parse', 'HEAD'])).trim();
    const restoredStatus = await git.status();
    if (restoredHead !== expectedSha || restoredStatus.files.length > 0) {
      throw new CliEvidenceWorkspaceIntegrityError(
        'CLI evidence mutated the verified worktree and exact restoration failed',
      );
    }
    return { mutated };
  } catch (err) {
    if (err instanceof CliEvidenceWorkspaceIntegrityError) throw err;
    throw new CliEvidenceWorkspaceIntegrityError(
      'CLI evidence workspace integrity audit failed closed',
    );
  }
}

/** Worktree HEAD via git rev-parse; null for non-git dirs (fake mode). */
async function defaultResolveHead(dir: string): Promise<string | null> {
  try {
    const head = (await simpleGit(dir).raw(['rev-parse', 'HEAD'])).trim();
    return /^[0-9a-f]{7,40}$/i.test(head) ? head : null;
  } catch {
    return null;
  }
}

/**
 * Commit staged + untracked worktree state (the exact tree verification sees)
 * and return the resulting HEAD. Clean tree → current HEAD; non-git dir → null.
 * Exported for tests; the default `commitState` dep of WorktreeVerifier.
 */
/**
 * C3.56: discard every uncommitted change in a worktree (tracked modifications
 * and untracked files; ignored files untouched) and return the paths that were
 * dropped. Used for verify-only runs, whose verified state must be the seeded
 * tip and nothing else.
 */
export async function discardUncommittedWorktreeChanges(dir: string): Promise<string[]> {
  const git = simpleGit(dir);
  const status = await git.status();
  const paths = status.files.map((f) => f.path).filter((p) => p.length > 0);
  if (paths.length === 0) return [];
  await git.raw(['reset', '-q', '--hard', 'HEAD']);
  await git.raw(['clean', '-fdq']);
  return paths;
}

export async function commitVerifiedState(
  dir: string,
  message: string,
): Promise<string | null> {
  try {
    const git = simpleGit(dir);
    await git.add(['-A']);
    const status = await git.status();
    if (status.staged.length > 0 || status.files.length > 0) {
      // status.files covers staged-by-add untracked entries across git versions.
      const anyStaged =
        status.staged.length > 0 ||
        status.files.some((f) => f.index && f.index !== ' ' && f.index !== '?');
      if (anyStaged) {
        await git.raw([
          '-c',
          'user.email=hercules@local',
          '-c',
          'user.name=Hercules',
          'commit',
          '--no-verify',
          '-m',
          message,
        ]);
      }
    }
    const head = (await git.raw(['rev-parse', 'HEAD'])).trim();
    return /^[0-9a-f]{7,40}$/i.test(head) ? head : null;
  } catch {
    return null;
  }
}
