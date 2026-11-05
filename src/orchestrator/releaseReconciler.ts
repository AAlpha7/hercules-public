/**
 * Release reconciler — tick hook for staging deploy + verify + packet
 * (design §3 / release-4).
 *
 * For each repo whose trusted WORKFLOW declares `deploy.staging`:
 *   mirror main ≠ release.staging_sha
 *   → debounce (or deploy-now)
 *   → never while promoting_sha is set
 *   → run staging deploy (injected runner, scrubbed env)
 *   → poll health
 *   → run `deploy.staging.verify` evidence against staging URL
 *   → write releases/<repo>.md + control commit
 *   → staging_status ready | failed
 *
 * All side effects go through injected ports so tests use a fake runner + clock.
 */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { scrubHerculesEnv } from '../adapters/env.js';
import type { ControlSnapshot } from '../control/snapshot.js';
import { parseWorkflow, type DeployStagingConfig } from '../control/workflow.js';
import {
  emptyRelease,
  formatEvidenceStepLine,
  hasStagingDrift,
  renderReleasePacket,
  selectTasksForRelease,
  shouldStartStagingDeploy,
  stagingDeployFailed,
  stagingDeployStarted,
  stagingDeployVerified,
  stagingVerifyStarted,
  type Release,
} from '../domain/release.js';
import {
  DEFAULT_STAGING_STAGE_TIMEOUT_MS,
  DEFAULT_STAGING_VERIFY_TIMEOUT_MS,
  evaluateStuckStaging,
  formatStagingTimeoutFailureReason,
  isStagingBudgetExceeded,
  remainingBudgetMs,
  shouldRetryFailedStaging,
  type StagingVerifyStage,
} from '../domain/stagingVerify.js';
import { isValidIdentifier } from '../domain/task.js';
import type { RepoConfig } from '../domain/repos.js';
import type {
  EvidencePlan,
  EvidenceRunSummary,
  EvidenceStep,
} from '../domain/evidence.js';
import type { ControlPort, TickReport } from './orchestrator.js';
import { mutateControl } from './controlMutation.js';
import {
  cleanupHerculesChromeResiduals,
  killProcessGroup,
} from '../verification/cdp.js';

export class ReleaseReconcilerError extends Error {
  override readonly name = 'ReleaseReconcilerError';
}

export interface DeployCommandResult {
  readonly exitCode: number;
  readonly output: string;
}

export interface StagingVerifyInput {
  readonly repoKey: string;
  readonly url: string;
  readonly steps: readonly EvidenceStep[];
  readonly screenshotDir: string;
  /** Staging UI token for the `unlock` step (from deploy.staging.auth_token_env). */
  readonly authToken?: string;
  readonly authStorageKey?: string;
}

/** Optional cancellation for deploy/health shell (hard-timeout + hung curl). */
export interface DeployRunOpts {
  readonly signal?: AbortSignal;
}

/**
 * Injected deploy surface (same idea as BehavioralRunner / fake transport).
 * Production impl runs shell with {@link scrubHerculesEnv}; tests inject fakes.
 */
export interface DeployRunner {
  /**
   * Run a deploy or health shell command (must scrub HERCULES_* in real impl).
   * When `opts.signal` aborts, production kills the process group.
   */
  run(command: string, cwd: string, opts?: DeployRunOpts): Promise<DeployCommandResult>;
  /** Run release-level evidence against the staging URL. */
  verify(input: StagingVerifyInput): Promise<EvidenceRunSummary>;
}

/**
 * Default deploy command runner: detached shell with scrubbed env so children
 * never inherit production HERCULES_TOKEN / HERCULES_WORK_DIR (2026-07-17).
 * AbortSignal → TERM/KILL process group (timeout must not leave deploy running).
 */
export const scrubbedDeployExec: DeployRunner['run'] = (command, cwd, opts) =>
  new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      cwd,
      env: scrubHerculesEnv(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const finish = (exitCode: number, extra = ''): void => {
      if (finished) return;
      finished = true;
      const output = `${stdout}${stderr}${extra}`;
      resolve({ exitCode, output });
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
      // Cap buffered output (same order as former maxBuffer intent).
      if (stdout.length > 12 * 1024 * 1024) stdout = stdout.slice(-8 * 1024 * 1024);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
      if (stderr.length > 4 * 1024 * 1024) stderr = stderr.slice(-2 * 1024 * 1024);
    });
    child.on('error', (err) => {
      finish(1, err.message);
    });
    child.on('close', (code) => {
      finish(typeof code === 'number' ? code : 1);
    });

    const abort = (): void => {
      if (finished) return;
      const pid = child.pid;
      const note = '\n[hercules] deploy/health command aborted (timeout)\n';
      if (typeof pid === 'number') {
        void killProcessGroup(pid).finally(() => {
          finish(124, note);
        });
      } else {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        finish(124, note);
      }
    };

    if (opts?.signal) {
      if (opts.signal.aborted) abort();
      else opts.signal.addEventListener('abort', abort, { once: true });
    }
  });

/** Workspaces surface required by the reconciler (subset of Workspaces). */
export interface ReleaseWorkspaces {
  readWorkflow(repo: RepoConfig): Promise<string | null>;
  /**
   * Tip SHA of the trusted mirror default branch. Null when unknown
   * (NoopWorkspaces / no mirror).
   */
  defaultBranchHead?(repo: RepoConfig): Promise<string | null>;
  /**
   * Refresh only the mirror's default branch from origin, then return its tip
   * (C3.51). Preferred over `defaultBranchHead` for drift detection: the
   * mirror otherwise moves only when something else touches the repo.
   */
  refreshDefaultBranchHead?(repo: RepoConfig): Promise<string | null>;
  /**
   * Absolute path used as cwd for deploy/health commands (typically the
   * bare-mirror parent work root or a checkout). Defaults to '.'.
   */
  deployCwd?(repo: RepoConfig): Promise<string> | string;
  /**
   * Commit SHAs in production..staging (exclusive of production). Used to
   * select merged tasks for the Release packet.
   */
  rangeShas?(
    repo: RepoConfig,
    productionSha: string | null,
    stagingSha: string,
  ): Promise<ReadonlySet<string> | undefined>;
}

export interface ReleaseReconcilerDeps {
  readonly control: ControlPort;
  readonly workspaces: ReleaseWorkspaces;
  readonly deployRunner: DeployRunner;
  readonly clock: () => number;
  /** Quiet period after main advances (default from config). */
  readonly debounceMs: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly healthTimeoutMs?: number;
  readonly healthIntervalMs?: number;
  /**
   * Overall wall-clock budget for one staging cycle (deploy+health+evidence).
   * Default 15 minutes. Override: `HERCULES_STAGING_VERIFY_TIMEOUT_MS`.
   */
  readonly overallTimeoutMs?: number;
  /** Per-stage budgets (capped by remaining overall). */
  readonly stageTimeoutMs?: Partial<Record<StagingVerifyStage, number>>;
  /** Root for staging evidence screenshots (releases/<repo>/). */
  readonly screenshotsRoot?: string;
  /**
   * Kill residual Chromium from prior evidence runs (process-group).
   * Default: {@link cleanupHerculesChromeResiduals}. Inject no-op in unit tests.
   */
  readonly cleanupChrome?: () => Promise<void> | void;
}

export class ReleaseReconciler {
  /** Last observed mirror main tip per repo → when it last changed. */
  private readonly mainAdvance = new Map<string, { sha: string; atMs: number }>();
  /** Last failed-at ms per repo (enables failed→retry debounce without drift). */
  private readonly failedAt = new Map<string, number>();
  /** Human "Deploy staging now" flags (cleared when deploy starts). */
  private readonly deployNow = new Set<string>();
  /** Repos currently mid deploy/verify (process-local). */
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: ReleaseReconcilerDeps) {}

  private get overallTimeoutMs(): number {
    return this.deps.overallTimeoutMs ?? DEFAULT_STAGING_VERIFY_TIMEOUT_MS;
  }

  private stageBudget(stage: StagingVerifyStage): number {
    return (
      this.deps.stageTimeoutMs?.[stage] ?? DEFAULT_STAGING_STAGE_TIMEOUT_MS[stage]
    );
  }

  private async runChromeCleanup(reason: string): Promise<void> {
    const cleanup = this.deps.cleanupChrome ?? cleanupHerculesChromeResiduals;
    try {
      console.error(`[hercules] release verify chrome cleanup (${reason})`);
      await cleanup();
    } catch (err) {
      console.error(
        `[hercules] release verify chrome cleanup failed: ${(err as Error).message}`,
      );
    }
  }

  /** Bypass debounce for the next reconcile pass on this repo. */
  requestDeployNow(repoKey: string): void {
    if (!isValidIdentifier(repoKey)) return;
    this.deployNow.add(repoKey);
  }

  /**
   * Scan snapshot repos and run staging deploy for each that is due.
   * Mutates `report.stagingReconciled` for completed ready|failed outcomes.
   */
  async reconcile(snapshot: ControlSnapshot, report: TickReport): Promise<void> {
    const { control } = this.deps;
    if (!control.readRelease || !control.writeRelease) {
      return;
    }

    for (const repo of Object.values(snapshot.repos.repos)) {
      try {
        await this.reconcileRepo(repo, snapshot, report);
      } catch (err) {
        console.error(
          `[hercules] release reconciler ${repo.key}: ${(err as Error).message}`,
        );
      }
    }
  }

  private async reconcileRepo(
    repo: RepoConfig,
    snapshot: ControlSnapshot,
    report: TickReport,
  ): Promise<void> {
    if (!isValidIdentifier(repo.key)) return;

    const workflowContent = await this.deps.workspaces.readWorkflow(repo);
    if (!workflowContent) return;

    let staging: DeployStagingConfig | undefined;
    try {
      const wf = parseWorkflow(workflowContent);
      staging = wf.deploy?.staging;
    } catch {
      return; // untrusted/broken WORKFLOW — leave repo untouched
    }
    if (!staging) return; // repos without deploy: untouched

    const mainSha = await this.resolveMainSha(repo);
    if (!mainSha) return;

    // Bookkeep main advance time for debounce.
    const prev = this.mainAdvance.get(repo.key);
    const now = this.deps.clock();
    if (!prev || prev.sha !== mainSha) {
      this.mainAdvance.set(repo.key, { sha: mainSha, atMs: now });
    }
    const advance = this.mainAdvance.get(repo.key)!;

    const control = this.deps.control;
    const existing = (await control.readRelease!(repo.key)) ?? emptyRelease(repo.key);
    let release: Release = { ...existing, repoKey: repo.key };

    // Never run while a promote is in flight.
    if (release.promotingSha !== null && release.promotingSha !== '') {
      return;
    }

    const processInFlight = this.inFlight.has(repo.key);
    const startedAtMs = parseIsoMs(release.stagingStartedAt);

    // Stuck deploying/verifying past overall budget → force-fail (covers
    // hung Chromium + orphaned status after crash). Live pipeline also races
    // its own deadline; this is the tick-level backstop.
    const stuck = evaluateStuckStaging({
      stagingStatus: release.stagingStatus,
      stagingStartedAtMs: startedAtMs,
      nowMs: now,
      overallTimeoutMs: this.overallTimeoutMs,
      processInFlight,
    });
    if (stuck.action === 'fail') {
      if (processInFlight) {
        // Live path is wedged past budget — kill evidence browsers so the
        // next cycle (or this tick's fail write) is not blocked by zombies.
        await this.runChromeCleanup(`stuck ${stuck.stage} ${repo.key}`);
      }
      // Only write failed when we are not inside the live pipeline (it will
      // finishFailed itself). When processInFlight, leave the live path to
      // observe its own race; the cleanup above unblocks Chromium.
      if (!processInFlight) {
        await this.finishFailed({
          repo,
          release,
          mainSha: release.stagingSha ?? mainSha,
          snapshot,
          report,
          startedAt: release.stagingStartedAt ?? new Date(now).toISOString(),
          deployOutput: '',
          healthOutput: '',
          healthOk: false,
          evidence: null,
          reason: stuck.reason,
        });
        this.failedAt.set(repo.key, now);
        return;
      }
    }

    if (processInFlight) return;

    // A persisted deploying/verifying WITHOUT an in-memory inFlight entry is
    // orphaned — its worker died with the previous process (CDP hang wedged
    // staging at 'verifying' across restarts, 2026-07-28). Deploy is
    // idempotent: treat the same-tip orphan as drift so a fresh run overwrites
    // the stale status instead of waiting for the hard-timeout backstop.
    const orphanedInProgress =
      release.stagingSha === mainSha &&
      (release.stagingStatus === 'deploying' || release.stagingStatus === 'verifying');
    const drift = hasStagingDrift(release, mainSha) || orphanedInProgress;
    // Process-local inFlight is the only true "running" signal. Disk status
    // deploying/verifying without processInFlight is either freshly timed-out
    // (handled above) or mid-budget orphan after restart — allow re-entry when
    // drift/retry wants it (do not treat same-tip status as permanent lock).
    const wantDeploy =
      shouldStartStagingDeploy({
        hasDrift: drift,
        promotingSha: release.promotingSha,
        deployNow: this.deployNow.has(repo.key),
        lastMainAdvanceAtMs: advance.atMs,
        nowMs: now,
        debounceMs: this.deps.debounceMs,
        inFlight: false,
      }) ||
      shouldRetryFailedStaging({
        stagingStatus: release.stagingStatus,
        hasDrift: drift,
        promotingSha: release.promotingSha,
        deployNow: this.deployNow.has(repo.key),
        lastFailureOrAdvanceAtMs: this.failedAt.get(repo.key) ?? startedAtMs ?? advance.atMs,
        nowMs: now,
        debounceMs: this.deps.debounceMs,
        inFlight: false,
      });

    if (!wantDeploy) return;

    // Re-read release after possible stuck-fail above is N/A here; start clean.
    release = (await control.readRelease!(repo.key)) ?? release;

    this.deployNow.delete(repo.key);
    this.inFlight.add(repo.key);
    try {
      await this.runStagingPipeline(repo, staging, mainSha, release, snapshot, report);
    } finally {
      this.inFlight.delete(repo.key);
    }
  }

  private async runStagingPipeline(
    repo: RepoConfig,
    staging: DeployStagingConfig,
    mainSha: string,
    prior: Release,
    snapshot: ControlSnapshot,
    report: TickReport,
  ): Promise<void> {
    const { control, deployRunner, clock } = this.deps;
    const cycleStartMs = clock();
    const startedAt = new Date(cycleStartMs).toISOString();
    const overallTimeoutMs = this.overallTimeoutMs;
    const cwd = await this.resolveDeployCwd(repo);

    // Mark deploying + commit so phone UI / restart can see progress.
    // (Chrome residual cleanup runs before evidence / on fail — not here —
    // so concurrent L2 CDP sessions are never swept by a deploy start.)
    let release = stagingDeployStarted(prior, mainSha, startedAt);
    await mutateControl(control, { writeReleases: [release] }, `release: ${repo.key} staging deploying ${shortSha(mainSha)}`);

    const fail = async (
      reason: string,
      extra: {
        deployOutput?: string;
        healthOutput?: string;
        healthOk?: boolean;
        evidence?: EvidenceRunSummary | null;
      } = {},
    ): Promise<void> => {
      this.failedAt.set(repo.key, clock());
      await this.runChromeCleanup(`fail ${repo.key}: ${reason}`);
      await this.finishFailed({
        repo,
        release,
        mainSha,
        snapshot,
        report,
        startedAt,
        deployOutput: extra.deployOutput ?? '',
        healthOutput: extra.healthOutput ?? '',
        healthOk: extra.healthOk ?? false,
        evidence: extra.evidence ?? null,
        reason,
      });
    };

    // 1. Deploy command (stage + overall budget)
    const deployBudget = Math.min(
      this.stageBudget('deploy'),
      remainingBudgetMs({
        startedAtMs: cycleStartMs,
        nowMs: clock(),
        timeoutMs: overallTimeoutMs,
      }),
    );
    if (deployBudget <= 0) {
      await fail(
        formatStagingTimeoutFailureReason({
          stage: 'overall',
          timeoutMs: overallTimeoutMs,
          elapsedMs: clock() - cycleStartMs,
        }),
      );
      return;
    }
    const deployRace = await this.raceStage(
      'deploy',
      deployBudget,
      (signal) => deployRunner.run(staging.command, cwd, { signal }),
      cycleStartMs,
      overallTimeoutMs,
    );
    if (deployRace.kind === 'timeout') {
      await fail(deployRace.reason);
      return;
    }
    const deployResult = deployRace.value;
    const deployOutput = deployResult.output;
    if (deployResult.exitCode !== 0) {
      await fail(`staging deploy command failed (exit ${deployResult.exitCode})`, {
        deployOutput,
      });
      return;
    }

    // 2. Health poll (capped by stage + remaining overall)
    const healthBudget = Math.min(
      this.deps.healthTimeoutMs ?? this.stageBudget('health'),
      remainingBudgetMs({
        startedAtMs: cycleStartMs,
        nowMs: clock(),
        timeoutMs: overallTimeoutMs,
      }),
    );
    if (healthBudget <= 0) {
      await fail(
        formatStagingTimeoutFailureReason({
          stage: 'overall',
          timeoutMs: overallTimeoutMs,
          elapsedMs: clock() - cycleStartMs,
        }),
        { deployOutput },
      );
      return;
    }
    const health = await this.pollHealth(staging.health, cwd, healthBudget);
    if (
      isStagingBudgetExceeded({
        startedAtMs: cycleStartMs,
        nowMs: clock(),
        timeoutMs: overallTimeoutMs,
      })
    ) {
      await fail(
        formatStagingTimeoutFailureReason({
          stage: health.ok ? 'overall' : 'health',
          timeoutMs: overallTimeoutMs,
          elapsedMs: clock() - cycleStartMs,
        }),
        { deployOutput, healthOutput: health.output, healthOk: health.ok },
      );
      return;
    }
    if (!health.ok) {
      // Probe hang: prefer raceStage's stage-attributed reason when present.
      const reason =
        health.timeoutReason ??
        (health.timedOut
          ? formatStagingTimeoutFailureReason({
              stage: 'health',
              timeoutMs: healthBudget,
              elapsedMs: healthBudget,
            })
          : 'staging health check failed');
      await fail(reason, {
        deployOutput,
        healthOutput: health.output,
        healthOk: false,
      });
      return;
    }

    // 3. Evidence verify (optional when no steps / no url)
    const verifyStartedAt = new Date(clock()).toISOString();
    release = stagingVerifyStarted(release, verifyStartedAt);
    // Keep cycle start on disk for overall stuck recovery; also refresh so UI
    // shows verify-phase elapsed. Prefer cycle start for overall attribution:
    // write cycle start as stagingStartedAt for timeout recovery consistency.
    release = { ...release, stagingStartedAt: startedAt };
    await mutateControl(control, { writeReleases: [release] }, `release: ${repo.key} staging verifying ${shortSha(mainSha)}`);

    let evidence: EvidenceRunSummary | null = null;
    if (staging.verify.length > 0 && staging.url) {
      const evidenceBudget = Math.min(
        this.stageBudget('evidence'),
        remainingBudgetMs({
          startedAtMs: cycleStartMs,
          nowMs: clock(),
          timeoutMs: overallTimeoutMs,
        }),
      );
      if (evidenceBudget <= 0) {
        await fail(
          formatStagingTimeoutFailureReason({
            stage: 'overall',
            timeoutMs: overallTimeoutMs,
            elapsedMs: clock() - cycleStartMs,
          }),
          { deployOutput, healthOutput: health.output, healthOk: true },
        );
        return;
      }

      const shotRoot =
        this.deps.screenshotsRoot ?? join(process.cwd(), 'screenshots', 'releases');
      const screenshotDir = join(shotRoot, repo.key);
      await mkdir(screenshotDir, { recursive: true }).catch(() => undefined);
      // Staging unlock token: WORKFLOW names a daemon env var (secrets never
      // live in WORKFLOW itself). Undefined → unlock step skips injection.
      const authToken =
        staging.authTokenEnv !== undefined
          ? process.env[staging.authTokenEnv]
          : undefined;

      // Kill leftovers again right before Chromium launch.
      await this.runChromeCleanup(`pre-evidence ${repo.key}`);

      const evidenceRace = await this.raceStage(
        'evidence',
        evidenceBudget,
        (_signal) =>
          deployRunner.verify({
            repoKey: repo.key,
            url: staging.url!,
            steps: staging.verify,
            screenshotDir,
            ...(authToken ? { authToken, authStorageKey: staging.authStorageKey } : {}),
          }),
        cycleStartMs,
        overallTimeoutMs,
      );
      if (evidenceRace.kind === 'timeout') {
        await fail(evidenceRace.reason, {
          deployOutput,
          healthOutput: health.output,
          healthOk: true,
        });
        return;
      }
      evidence = evidenceRace.value;
      if (!evidence.ok) {
        await fail('staging evidence verify failed', {
          deployOutput,
          healthOutput: health.output,
          healthOk: true,
          evidence,
        });
        return;
      }
    }

    // Success → ready + packet; always clean up browsers.
    await this.runChromeCleanup(`success ${repo.key}`);
    const finishedAt = new Date(clock()).toISOString();
    const body = await this.buildPacketBody({
      repo,
      mainSha,
      productionSha: prior.productionSha,
      snapshot,
      deployOutput,
      healthOutput: health.output,
      healthOk: true,
      evidence,
      startedAt,
      finishedAt,
      outcome: 'ready',
    });
    release = {
      ...stagingDeployVerified(release, finishedAt),
      body,
    };
    await mutateControl(control, { writeReleases: [release] }, `release: ${repo.key} staging ready ${shortSha(mainSha)}`);
    report.stagingReconciled.push(repo.key);
    this.failedAt.delete(repo.key);
  }

  /**
   * Race a stage against stage budget and overall cycle deadline.
   * On timeout, aborts the signal so deploy/health process trees are killed.
   * Uses injected sleep/clock so unit tests advance time without real waits.
   */
  private async raceStage<T>(
    stage: StagingVerifyStage,
    stageTimeoutMs: number,
    work: (signal: AbortSignal) => Promise<T>,
    cycleStartMs: number,
    overallTimeoutMs: number,
  ): Promise<
    | { readonly kind: 'ok'; readonly value: T }
    | { readonly kind: 'timeout'; readonly reason: string }
  > {
    const sleep =
      this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const clock = this.deps.clock;
    const stageStart = clock();
    const controller = new AbortController();
    let settled = false;
    let workError: unknown;

    const workPromise = work(controller.signal).then(
      (value) => {
        settled = true;
        return value;
      },
      (err: unknown) => {
        settled = true;
        workError = err;
        throw err;
      },
    );

    // Poll remaining budget while work runs (fake-clock friendly).
    const pollMs = Math.min(1_000, Math.max(50, stageTimeoutMs));
    while (!settled) {
      const now = clock();
      if (
        isStagingBudgetExceeded({
          startedAtMs: stageStart,
          nowMs: now,
          timeoutMs: stageTimeoutMs,
        })
      ) {
        controller.abort();
        return {
          kind: 'timeout',
          reason: formatStagingTimeoutFailureReason({
            stage,
            timeoutMs: stageTimeoutMs,
            elapsedMs: now - stageStart,
          }),
        };
      }
      if (
        isStagingBudgetExceeded({
          startedAtMs: cycleStartMs,
          nowMs: now,
          timeoutMs: overallTimeoutMs,
        })
      ) {
        controller.abort();
        return {
          kind: 'timeout',
          reason: formatStagingTimeoutFailureReason({
            stage: 'overall',
            timeoutMs: overallTimeoutMs,
            elapsedMs: now - cycleStartMs,
          }),
        };
      }
      // Race one sleep slice against work completion.
      await Promise.race([
        workPromise.then(
          () => undefined,
          () => undefined,
        ),
        sleep(pollMs),
      ]);
    }

    if (workError !== undefined) {
      // Aborted deploy/health resolves with exit 124 rather than throwing;
      // unexpected errors still surface.
      throw workError;
    }
    const value = await workPromise;
    return { kind: 'ok', value };
  }

  private async finishFailed(input: {
    repo: RepoConfig;
    release: Release;
    mainSha: string;
    snapshot: ControlSnapshot;
    report: TickReport;
    startedAt: string;
    deployOutput: string;
    healthOutput: string;
    healthOk: boolean;
    evidence: EvidenceRunSummary | null;
    reason: string;
  }): Promise<void> {
    const { control, clock } = this.deps;
    const finishedAt = new Date(clock()).toISOString();
    const body = await this.buildPacketBody({
      repo: input.repo,
      mainSha: input.mainSha,
      productionSha: input.release.productionSha,
      snapshot: input.snapshot,
      deployOutput: input.deployOutput,
      healthOutput: input.healthOutput,
      healthOk: input.healthOk,
      evidence: input.evidence,
      startedAt: input.startedAt,
      finishedAt,
      outcome: 'failed',
      failureReason: input.reason,
    });
    const failed: Release = {
      ...stagingDeployFailed(input.release),
      body,
    };
    await mutateControl(control, { writeReleases: [failed] },
      `release: ${input.repo.key} staging failed ${shortSha(input.mainSha)}: ${input.reason}`,
    );
    input.report.stagingReconciled.push(input.repo.key);
    this.failedAt.set(input.repo.key, clock());
  }

  private async buildPacketBody(input: {
    repo: RepoConfig;
    mainSha: string;
    productionSha: string | null;
    snapshot: ControlSnapshot;
    deployOutput: string;
    healthOutput: string;
    healthOk: boolean;
    evidence: EvidenceRunSummary | null;
    startedAt: string;
    finishedAt: string;
    outcome: 'ready' | 'failed';
    failureReason?: string;
  }): Promise<string> {
    let rangeShas: ReadonlySet<string> | undefined;
    if (this.deps.workspaces.rangeShas) {
      rangeShas = await this.deps.workspaces.rangeShas(
        input.repo,
        input.productionSha,
        input.mainSha,
      );
    }
    const tasks = selectTasksForRelease(input.snapshot.tasks, {
      repoKey: input.repo.key,
      productionSha: input.productionSha,
      stagingSha: input.mainSha,
      ...(rangeShas !== undefined ? { rangeShas } : {}),
    });
    const evidenceLines =
      input.evidence?.results.map((r) =>
        formatEvidenceStepLine({
          kind: r.step.kind,
          ok: r.ok,
          detail: r.detail,
          ...(r.step.raw !== undefined ? { raw: r.step.raw } : {}),
        }),
      ) ?? [];
    return renderReleasePacket({
      repoKey: input.repo.key,
      stagingSha: input.mainSha,
      productionSha: input.productionSha,
      tasks,
      deployOutput: input.deployOutput,
      healthOutput: input.healthOutput,
      healthOk: input.healthOk,
      evidenceLines,
      evidenceOk: input.evidence ? input.evidence.ok : null,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      outcome: input.outcome,
      ...(input.failureReason !== undefined ? { failureReason: input.failureReason } : {}),
    });
  }

  private async pollHealth(
    command: string,
    cwd: string,
    timeoutMs?: number,
  ): Promise<{
    ok: boolean;
    output: string;
    timedOut: boolean;
    timeoutReason?: string;
  }> {
    const timeout =
      timeoutMs ?? this.deps.healthTimeoutMs ?? this.stageBudget('health');
    const interval = this.deps.healthIntervalMs ?? 1_000;
    const sleep =
      this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const clock = this.deps.clock;
    const healthStart = clock();
    const deadline = healthStart + timeout;
    let lastOutput = '';

    // At least one attempt even if timeout is 0. Each probe is itself raced
    // against the remaining health budget so a hung curl/shell cannot wedge
    // the reconciler (and block the overall tick).
    // `timedOut` is true only when a single probe hung past the race (abort);
    // repeated non-zero exits until the poll window ends stay generic fail.
    for (;;) {
      const remaining = Math.max(0, deadline - clock());
      if (remaining <= 0) {
        return { ok: false, output: lastOutput, timedOut: false };
      }
      const probe = await this.raceStage(
        'health',
        remaining,
        (signal) => this.deps.deployRunner.run(command, cwd, { signal }),
        healthStart,
        timeout,
      );
      if (probe.kind === 'timeout') {
        return {
          ok: false,
          timedOut: true,
          timeoutReason: probe.reason,
          output:
            lastOutput +
            (lastOutput ? '\n' : '') +
            '[hercules] health probe timed out under stage budget',
        };
      }
      lastOutput = probe.value.output;
      if (probe.value.exitCode === 0) {
        return { ok: true, output: lastOutput, timedOut: false };
      }
      if (clock() >= deadline) {
        return { ok: false, output: lastOutput, timedOut: false };
      }
      await sleep(interval);
      if (clock() >= deadline) {
        return { ok: false, output: lastOutput, timedOut: false };
      }
    }
  }

  private async resolveMainSha(repo: RepoConfig): Promise<string | null> {
    const ws = this.deps.workspaces;
    // C3.51: judge drift on a freshly-fetched origin tip when the workspace can
    // provide one. The bare mirror otherwise moves only when a task touches the
    // repo, so a push straight to main (the hercules ship path) never fired the
    // automatic staging deploy — every promote needed a manual mirror fetch.
    const read = ws.refreshDefaultBranchHead ?? ws.defaultBranchHead;
    if (!read) return null;
    try {
      // Invoke WITH the receiver — an extracted unbound call loses `this`, and
      // the TypeError is swallowed inside the impl's own catch → silent null
      // (2026-07-17: first automated staging cycle never fired).
      return await read.call(ws, repo);
    } catch (err) {
      console.error(
        `[hercules] release reconciler: defaultBranchHead ${repo.key}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private async resolveDeployCwd(repo: RepoConfig): Promise<string> {
    const ws = this.deps.workspaces;
    if (!ws.deployCwd) return '.';
    return ws.deployCwd(repo); // receiver-bound (see resolveMainSha)
  }
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

function parseIsoMs(iso: string | null | undefined): number | null {
  if (iso === undefined || iso === null || iso === '') return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Production evidence runner: reuses the L2 CDP evidence engine when Chromium
 * is available. Imported lazily by main wiring — tests inject a fake.
 */
export type EvidenceVerifyFn = (input: StagingVerifyInput) => Promise<EvidenceRunSummary>;

/** Compose a real DeployRunner from scrubbed exec + evidence function. */
export function makeDeployRunner(
  verify: EvidenceVerifyFn,
  run: DeployRunner['run'] = scrubbedDeployExec,
): DeployRunner {
  return {
    run,
    verify: async (input) => {
      if (input.steps.length === 0) {
        const plan: EvidencePlan = { steps: [], source: 'workflow' };
        return { plan, results: [], ok: true, screenshots: [] };
      }
      return verify(input);
    },
  };
}
