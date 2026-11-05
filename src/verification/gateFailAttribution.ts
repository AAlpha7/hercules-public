/**
 * Verification — re-run a failed test/held-out item on a clean merge-base
 * checkout to attribute trunk vs branch (gate-fail-attribution).
 *
 * Domain owns pure classification; this module owns checkout + exec + cache.
 * Checkout is always deleted after use (disk hygiene). Cargo/pnpm caches stay
 * shared via the process env (HERCULES_CARGO_TARGET_DIR / CARGO_TARGET_DIR).
 */
import { mkdir, rm, symlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import {
  attributionCacheKey,
  buildMinimalRerunCommand,
  classifyGateFailAttribution,
  extractFailedTestIds,
  isAttributableGate,
  type BaseTestResult,
  type GateFailAttributionReport,
} from '../domain/gateFailAttribution.js';
import type { GateResult } from '../domain/verification.js';
import {
  isVerificationAborted,
  throwIfVerificationAborted,
} from '../domain/verificationRun.js';
import type { CommandRunner } from './gates.js';
import { execRunner } from './gates.js';

/** In-memory cache: key → failed on merge-base (true = reproduced). */
export class GateFailAttributionCache {
  private readonly map = new Map<string, boolean>();

  get(key: string): boolean | undefined {
    return this.map.has(key) ? this.map.get(key) : undefined;
  }

  set(key: string, failedOnBase: boolean): void {
    this.map.set(key, failedOnBase);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/** Default process-wide cache so concurrent tasks share merge-base answers. */
const defaultCache = new GateFailAttributionCache();

export interface AttributeGateFailInput {
  readonly failedGate: GateResult;
  readonly mergeBase: string | null | undefined;
  readonly repoKey: string;
  readonly filesTouched: readonly string[];
  /** Task worktree (used to resolve git + share node_modules when safe). */
  readonly worktreeDir: string;
  /**
   * Parent dir for ephemeral checkouts (deleted after probe). Typically
   * `<isolationRoot>/.scratch/merge-base-probe/<repoKey>`.
   */
  readonly probeRoot: string;
  readonly run?: CommandRunner;
  readonly cache?: GateFailAttributionCache;
  /** Human cancel aborts the merge-base probe command and checkout flow. */
  readonly signal?: AbortSignal;
  /** Repo execution policy for probe child env. */
  readonly executionPolicy?: import('../domain/repoExecutionPolicy.js').EffectiveRepoExecutionPolicy | null;
}

/**
 * When the failed gate is attributable, probe merge-base and classify.
 * Returns null when the gate is not in scope (setup/build/lint/…) or there is
 * no merge-base — caller keeps existing rework behavior.
 */
export async function attributeFailedGate(
  input: AttributeGateFailInput,
): Promise<GateFailAttributionReport | null> {
  throwIfVerificationAborted(input.signal);
  if (!isAttributableGate(input.failedGate.name)) return null;
  if (input.failedGate.passed) return null;

  const mergeBase = (input.mergeBase ?? '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(mergeBase)) {
    return classifyGateFailAttribution({
      gateName: input.failedGate.name,
      originalCommand: input.failedGate.command,
      mergeBase: mergeBase || 'unknown',
      failedTests: extractFailedTestIds(input.failedGate.output),
      baseResults: [],
      filesTouched: input.filesTouched,
      rerunCommand: null,
      probeFailed: true,
      probeError: 'merge-base SHA unavailable',
    });
  }

  const failedTests = extractFailedTestIds(input.failedGate.output);
  const rerunCommand = buildMinimalRerunCommand(input.failedGate.command, failedTests);
  if (!rerunCommand || failedTests.length === 0) {
    return classifyGateFailAttribution({
      gateName: input.failedGate.name,
      originalCommand: input.failedGate.command,
      mergeBase,
      failedTests,
      baseResults: [],
      filesTouched: input.filesTouched,
      rerunCommand,
      probeFailed: true,
      probeError: 'could not build minimal re-run (no test names or unknown runner)',
    });
  }

  const cache = input.cache ?? defaultCache;
  const run = input.run ?? execRunner;
  const baseResults: BaseTestResult[] = [];

  // Resolve cache hits first — only re-run uncached tests.
  const needRun: string[] = [];
  for (const testId of failedTests) {
    const key = attributionCacheKey(input.repoKey, mergeBase, testId);
    const hit = cache.get(key);
    if (hit !== undefined) {
      baseResults.push({ testId, failedOnBase: hit, fromCache: true });
    } else {
      needRun.push(testId);
    }
  }

  if (needRun.length === 0) {
    return classifyGateFailAttribution({
      gateName: input.failedGate.name,
      originalCommand: input.failedGate.command,
      mergeBase,
      failedTests,
      baseResults,
      filesTouched: input.filesTouched,
      rerunCommand,
    });
  }

  // Need a live checkout for remaining tests.
  const probeCmd = buildMinimalRerunCommand(input.failedGate.command, needRun);
  if (!probeCmd) {
    return classifyGateFailAttribution({
      gateName: input.failedGate.name,
      originalCommand: input.failedGate.command,
      mergeBase,
      failedTests,
      baseResults,
      filesTouched: input.filesTouched,
      rerunCommand,
      probeFailed: true,
      probeError: 'could not build probe command for uncached tests',
    });
  }

  const short = mergeBase.slice(0, 12);
  const checkoutDir = join(input.probeRoot, short);
  try {
    throwIfVerificationAborted(input.signal);
    await rm(checkoutDir, { recursive: true, force: true });
    await mkdir(input.probeRoot, { recursive: true });
    await addDetachedWorktree(input.worktreeDir, checkoutDir, mergeBase);
    await maybeLinkNodeModules(input.worktreeDir, checkoutDir);
    throwIfVerificationAborted(input.signal);

    const { exitCode, output } = await run(probeCmd, checkoutDir, {
      ...(input.signal ? { signal: input.signal } : {}), ...(input.executionPolicy !== undefined ? { executionPolicy: input.executionPolicy } : {}),
    });
    throwIfVerificationAborted(input.signal);
    // exit != 0 → at least one failed on base. Map per-test when possible.
    const failedOnBaseSet = new Set(extractFailedTestIds(output));
    const anyFailed = exitCode !== 0;

    for (const testId of needRun) {
      // If we can parse which failed, use that; else treat whole batch as failed
      // when exit != 0 (conservative: prefer trunk_inherited only when sure —
      // but a single-test probe is exact; multi-test without names → all failed
      // when exit != 0, all passed when exit == 0).
      let failedOnBase: boolean;
      if (failedOnBaseSet.size > 0) {
        failedOnBase =
          failedOnBaseSet.has(testId) ||
          [...failedOnBaseSet].some(
            (f) => f.includes(testId) || testId.includes(f),
          );
        // If parser found *other* failures only, this test may have passed.
        if (!failedOnBase && needRun.length === 1) {
          // Single-test probe: exit code is authoritative.
          failedOnBase = anyFailed;
        }
      } else {
        failedOnBase = anyFailed;
      }
      cache.set(attributionCacheKey(input.repoKey, mergeBase, testId), failedOnBase);
      baseResults.push({ testId, failedOnBase, fromCache: false });
    }

    return classifyGateFailAttribution({
      gateName: input.failedGate.name,
      originalCommand: input.failedGate.command,
      mergeBase,
      failedTests,
      baseResults,
      filesTouched: input.filesTouched,
      rerunCommand: probeCmd,
    });
  } catch (err) {
    if (isVerificationAborted(err) || input.signal?.aborted) throw err;
    return classifyGateFailAttribution({
      gateName: input.failedGate.name,
      originalCommand: input.failedGate.command,
      mergeBase,
      failedTests,
      baseResults,
      filesTouched: input.filesTouched,
      rerunCommand: probeCmd,
      probeFailed: true,
      probeError: `merge-base probe error: ${(err as Error).message}`,
    });
  } finally {
    // Disk hygiene: always drop the ephemeral checkout.
    await removeDetachedWorktree(input.worktreeDir, checkoutDir);
  }
}

async function addDetachedWorktree(
  worktreeDir: string,
  checkoutDir: string,
  mergeBase: string,
): Promise<void> {
  const git = simpleGit(worktreeDir);
  // Detached HEAD at merge-base — no branch pollution.
  await git.raw(['worktree', 'add', '--detach', checkoutDir, mergeBase]);
}

async function removeDetachedWorktree(
  worktreeDir: string,
  checkoutDir: string,
): Promise<void> {
  try {
    const git = simpleGit(worktreeDir);
    await git.raw(['worktree', 'remove', '--force', checkoutDir]);
  } catch {
    // Fallback: plain rm + prune so a stuck worktree cannot fill the disk.
    try {
      await rm(checkoutDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    try {
      await simpleGit(worktreeDir).raw(['worktree', 'prune']);
    } catch {
      /* best-effort */
    }
  }
  // Ensure no residue even if remove "succeeded" but left files.
  try {
    await rm(checkoutDir, { recursive: true, force: true });
  } catch {
    /* gone */
  }
}

/**
 * Share node_modules from the task worktree when present (deps almost always
 * match for attribution probes; install on every probe is too expensive).
 * Cargo uses shared CARGO_TARGET_DIR via env — nothing to link.
 */
async function maybeLinkNodeModules(
  taskDir: string,
  checkoutDir: string,
): Promise<void> {
  const src = join(taskDir, 'node_modules');
  const dest = join(checkoutDir, 'node_modules');
  try {
    await access(src);
  } catch {
    return;
  }
  try {
    await symlink(src, dest, 'dir');
  } catch {
    /* already exists or unsupported — probe may still work for cargo */
  }
}

export function getDefaultAttributionCache(): GateFailAttributionCache {
  return defaultCache;
}

/** Test helper — drop cached merge-base answers. */
export function clearDefaultAttributionCache(): void {
  defaultCache.clear();
}
