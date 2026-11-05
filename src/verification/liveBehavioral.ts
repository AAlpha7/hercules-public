/**
 * Verification Layer 2 — the live behavioral runner (SPEC §9.2).
 *
 * Boots an isolated app from the task worktree, then runs a **declarative
 * evidence plan** (WORKFLOW `behavioral.evidence` or task `## Evidence`) over
 * CDP. No UI-label heuristics.
 */
import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Semaphore } from '../orchestrator/semaphore.js';
import type { BehavioralRunner } from '../orchestrator/verifier.js';
import type { BrowserDriver } from './browser.js';
import { BehavioralVerifier, type BootController } from './behavioral.js';
import { CommandBootController } from './boot.js';
import { findChromium, formatChromiumMiss, scanChromium } from './browser.js';
import { runEvidencePlan } from './evidenceDrive.js';
import {
  resolveEvidencePlan,
  type EvidencePlan,
  type EvidenceRunSummary,
} from '../domain/evidence.js';
import {
  isVerificationAborted,
  throwIfVerificationAborted,
  VerificationAbortedError,
} from '../domain/verificationRun.js';

export interface LiveBehavioralDeps {
  /** The heavy-validation semaphore (§6.3). */
  readonly permit: Semaphore;
  readonly browser: BrowserDriver;
  /** Persistent root for evidence screenshots (NOT the scratch dir — that is
   *  deleted on teardown). Served by the daemon at /api/tasks/:id/screenshots. */
  readonly screenshotsRoot: string;
  /** Dynamic heavy cap from memory pressure (see domain/dynamicCaps). */
  readonly isHeavyAllowed?: () => boolean;
  /** Build a boot controller for one run (defaults to CommandBootController). */
  readonly bootFactory?: (input: {
    bootCommands: readonly string[];
    healthCommand: string | undefined;
    cwd: string;
    signal?: AbortSignal;
    executionPolicy?: import('../domain/repoExecutionPolicy.js').EffectiveRepoExecutionPolicy | null;
  }) => BootController;
}

/** Poll tryAcquire so cancel can interrupt a full heavy-permit queue. */
async function acquirePermitCancelable(
  permit: Semaphore,
  signal: AbortSignal | undefined,
): Promise<() => void> {
  throwIfVerificationAborted(signal);
  const immediate = permit.tryAcquire();
  if (immediate) return immediate;
  for (;;) {
    throwIfVerificationAborted(signal);
    const got = permit.tryAcquire();
    if (got) return got;
    await new Promise<void>((r) => setTimeout(r, 50));
  }
}

export class LiveBehavioralRunner implements BehavioralRunner {
  private readonly verifier: BehavioralVerifier;

  constructor(private readonly deps: LiveBehavioralDeps) {
    this.verifier = new BehavioralVerifier({
      permit: deps.permit,
      browser: deps.browser,
      ...(deps.isHeavyAllowed ? { isHeavyAllowed: deps.isHeavyAllowed } : {}),
    });
  }

  async run(input: {
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
    readonly workflowEvidence?: EvidencePlan['steps'];
    readonly signal?: AbortSignal;
    /** Repo policy for L2 boot/health child env (explicit allowlist honored). */
    readonly executionPolicy?: import('../domain/repoExecutionPolicy.js').EffectiveRepoExecutionPolicy | null;
  }): Promise<{
    screenshots: string[];
    healthy: boolean;
    evidenceRun?: EvidenceRunSummary;
    /** EXACT reason no evidence ran — the packet must never guess (2026-07-23). */
    evidenceSkipReason?: string;
  }> {
    throwIfVerificationAborted(input.signal);
    const factory =
      this.deps.bootFactory ??
      ((i: {
        bootCommands: readonly string[];
        healthCommand: string | undefined;
        cwd: string;
        signal?: AbortSignal;
        executionPolicy?: import('../domain/repoExecutionPolicy.js').EffectiveRepoExecutionPolicy | null;
      }): BootController =>
        new CommandBootController({
          bootCommands: i.bootCommands,
          healthCommand: i.healthCommand,
          cwd: i.cwd,
          ...(i.signal ? { signal: i.signal } : {}),
          ...(i.executionPolicy !== undefined
            ? { executionPolicy: i.executionPolicy }
            : {}),
        }));
    const boot = factory({
      bootCommands: input.bootCommands,
      healthCommand: input.healthCommand,
      cwd: input.cwd,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.executionPolicy !== undefined
        ? { executionPolicy: input.executionPolicy }
        : {}),
    });
    const dir = join(this.deps.screenshotsRoot, input.taskId);
    await mkdir(dir, { recursive: true });

    const plan = resolveEvidencePlan({
      ...(input.taskBody !== undefined ? { taskBody: input.taskBody } : {}),
      ...(input.workflowEvidence !== undefined
        ? { workflowEvidence: input.workflowEvidence }
        : {}),
    });

    // Prefer declarative CDP plan when we have auth + chromium.
    const token = input.localStorage
      ? Object.values(input.localStorage)[0]
      : undefined;
    const authKey = input.localStorage
      ? Object.keys(input.localStorage)[0]
      : undefined;
    const bin = findChromium();

    // Name every missing precondition precisely — the old packet printed a
    // guess-list ("no browser / boot failed / missing auth / empty plan")
    // while the code here knew exactly which one it was.
    const missing: string[] = [];
    if (!bin) {
      // Exact-reason: list scanned cache dir + candidates (not a vague「未安装」).
      missing.push(`Chromium 不可用: ${formatChromiumMiss(scanChromium())}`);
    }
    if (!token) missing.push('behavioral 块缺 auth_token(无法解锁应用界面)');
    if (plan.steps.length === 0) {
      missing.push('无可执行 evidence 步骤(WORKFLOW 未声明 evidence: 且任务体无 ## Evidence)');
    }
    let cdpFailure: string | undefined;

    if (bin && token && plan.steps.length > 0) {
      // Cancel-aware permit wait (do not hang on heavy semaphore after human cancel).
      const release = await acquirePermitCancelable(this.deps.permit, input.signal);
      try {
        throwIfVerificationAborted(input.signal);
        await boot.boot();
        throwIfVerificationAborted(input.signal);
        const healthy = await boot.waitHealthy();
        throwIfVerificationAborted(input.signal);
        if (!healthy) {
          return {
            screenshots: [],
            healthy: false,
            evidenceSkipReason: '应用启动/健康检查未通过(boot/health failed)',
          };
        }
        const summary = await runEvidencePlan({
          bin,
          url: input.baseUrl,
          plan,
          screenshotDir: dir,
          authToken: token,
          authStorageKey: authKey ?? 'hercules_token',
          width: 390,
          height: 844,
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.executionPolicy !== undefined
            ? { executionPolicy: input.executionPolicy }
            : {}),
        });
        throwIfVerificationAborted(input.signal);
        return {
          screenshots: summary.screenshots.map((p) => basename(p)),
          healthy: true,
          evidenceRun: summary,
        };
      } catch (err) {
        if (isVerificationAborted(err) || input.signal?.aborted) {
          throw err instanceof VerificationAbortedError
            ? err
            : new VerificationAbortedError('verification aborted during L2 behavioral');
        }
        cdpFailure = `evidence 执行异常:${(err as Error).message}`;
        console.error(
          `[hercules] evidence plan failed: ${(err as Error).message}; falling back to single shot`,
        );
      } finally {
        try {
          await boot.teardown();
        } finally {
          release();
        }
      }
    }

    throwIfVerificationAborted(input.signal);

    // Fallback: legacy single/multi shell capture (no plan / no chromium).
    // Signal is first-class: permit wait / boot / browser abort mid-phase.
    const result = await this.verifier.verify({
      boot,
      baseUrl: input.baseUrl,
      screenshotDir: dir,
      captures: Math.max(1, input.captures),
      ...(input.localStorage ? { localStorage: input.localStorage } : {}),
      ...(input.mobile !== undefined ? { mobile: input.mobile } : {}),
      ...(input.smokeFlows ? { smokeFlows: input.smokeFlows } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.executionPolicy !== undefined
        ? { executionPolicy: input.executionPolicy }
        : {}),
    });
    throwIfVerificationAborted(input.signal);
    const skipReason = cdpFailure ?? (missing.length > 0 ? missing.join(';') : undefined);
    return {
      screenshots: result.screenshots.map((p) => basename(p)),
      healthy: result.healthy,
      ...(skipReason ? { evidenceSkipReason: skipReason } : {}),
    };
  }
}
