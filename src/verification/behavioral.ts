/**
 * Verification Layer 2 — behavioral verification (SPEC §9.2, §6.3).
 *
 * Boots the app in its worktree and drives it with a real browser, capturing
 * screenshots for the review packet. This is the RAM/CPU-hungry phase, so it
 * MUST acquire the heavy-validation permit first — only one browser runs at a
 * time on the target box. Boot is injected (a BootController) so the
 * orchestration is tested without managing real servers.
 *
 * Cancel: optional AbortSignal aborts permit wait / boot / browser mid-phase
 * and always tears down boot resources (2026-07-31 cancel-while-verifying).
 */
import { join } from 'node:path';
import type { Semaphore } from '../orchestrator/semaphore.js';
import {
  isVerificationAborted,
  throwIfVerificationAborted,
  VerificationAbortedError,
} from '../domain/verificationRun.js';
import type { BrowserDriver } from './browser.js';
import type { EffectiveRepoExecutionPolicy } from '../domain/repoExecutionPolicy.js';

/** Stands up (and tears down) the app under test in its worktree. */
export interface BootController {
  /** Start the app (e.g. run WORKFLOW setup.boot in the background). */
  boot(): Promise<void>;
  /** Poll the health check until the app is ready (or a timeout). */
  waitHealthy(): Promise<boolean>;
  /** Stop the app and clean up. Always called. */
  teardown(): Promise<void>;
}

export interface BehavioralInput {
  readonly boot: BootController;
  readonly baseUrl: string;
  /** Where to write evidence screenshots. */
  readonly screenshotDir: string;
  /** How many screenshots to capture (0 to skip). Prefer ≥2 for post-auth chrome. */
  readonly captures: number;
  /**
   * SPA auth: written to localStorage before capture so evidence is the
   * post-login UI (not the token gate). See WORKFLOW `behavioral.auth_token`.
   */
  readonly localStorage?: Readonly<Record<string, string>>;
  /** Prefer phone viewport when capturing authenticated SPA chrome. */
  readonly mobile?: boolean;
  /** Smoke-flow strings → click hints (Settings sheet, etc.). */
  readonly smokeFlows?: readonly string[];
  /** Human cancel — abort permit wait / boot / browser; always teardown. */
  readonly signal?: AbortSignal;
  /** Repository policy for the browser verification child. */
  readonly executionPolicy?: EffectiveRepoExecutionPolicy | null;
}

export interface BehavioralResult {
  readonly healthy: boolean;
  readonly screenshots: string[];
  readonly error?: string;
}

export interface BehavioralDeps {
  /** The heavy-validation semaphore (capacity 1 on the target box). */
  readonly permit: Semaphore;
  readonly browser: BrowserDriver;
  /**
   * Dynamic heavy cap gate (memory pressure). When false, wait before taking
   * the permit so no new browser starts. Defaults to always allowed.
   */
  readonly isHeavyAllowed?: () => boolean;
  /** Poll interval while heavy is paused (default 500ms). Injectable for tests. */
  readonly heavyWaitMs?: number;
  /** Optional sleep (defaults to setTimeout). */
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function sleepCancelable(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfVerificationAborted(signal);
  if (!signal) {
    await sleep(ms);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (err !== undefined) reject(err);
      else resolve();
    };
    const onAbort = (): void => {
      finish(new VerificationAbortedError('verification aborted while waiting for L2 permit'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void sleep(ms).then(() => finish(), (err: unknown) => finish(err));
    if (signal.aborted) onAbort();
  });
}

export class BehavioralVerifier {
  constructor(private readonly deps: BehavioralDeps) {}

  async verify(input: BehavioralInput): Promise<BehavioralResult> {
    throwIfVerificationAborted(input.signal);
    const release = await this.acquireHeavy(input.signal);
    try {
      throwIfVerificationAborted(input.signal);
      await input.boot.boot();
      throwIfVerificationAborted(input.signal);
      const healthy = await input.boot.waitHealthy();
      throwIfVerificationAborted(input.signal);
      if (!healthy) return { healthy: false, screenshots: [] };

      // One CDP session can produce shell + Settings sheet shots when captures≥2.
      const path = join(input.screenshotDir, `evidence-0.png`);
      const written = await this.deps.browser.screenshot(input.baseUrl, path, {
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
      // Normalize names evidence-0.png, evidence-1.png for the packet.
      const screenshots: string[] = [];
      for (let i = 0; i < written.length; i += 1) {
        const src = written[i]!;
        const dest = join(input.screenshotDir, `evidence-${i}.png`);
        if (src !== dest) {
          const { rename } = await import('node:fs/promises');
          await rename(src, dest).catch(async () => {
            const { copyFile } = await import('node:fs/promises');
            await copyFile(src, dest);
          });
        }
        screenshots.push(dest);
      }
      return { healthy: true, screenshots };
    } catch (err) {
      // Never fold cancel into a soft L2 fail — complete() must see abort.
      if (isVerificationAborted(err) || input.signal?.aborted) {
        throw err instanceof VerificationAbortedError
          ? err
          : new VerificationAbortedError('verification aborted during behavioral verify');
      }
      return { healthy: false, screenshots: [], error: (err as Error).message };
    } finally {
      try {
        await input.boot.teardown();
      } finally {
        release();
      }
    }
  }

  /**
   * Wait until memory pressure allows heavy work, then take the semaphore.
   * Under critical free-mem the orchestrator sets heavyValidationPermits to 0;
   * we poll until it recovers so onboard cargo + browser do not OOM the box.
   * Cancel aborts the wait so a human cancel does not hang on the permit.
   */
  private async acquireHeavy(signal?: AbortSignal): Promise<() => void> {
    const sleep = this.deps.sleep ?? defaultSleep;
    const waitMs = this.deps.heavyWaitMs ?? 500;
    const allowed = this.deps.isHeavyAllowed;
    for (;;) {
      throwIfVerificationAborted(signal);
      if (!allowed || allowed()) {
        const release = this.deps.permit.tryAcquire();
        if (release) return release;
      }
      await sleepCancelable(sleep, waitMs, signal);
    }
  }
}
