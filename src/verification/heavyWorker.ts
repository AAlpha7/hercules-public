/**
 * Verification Layer 2 — optional remote heavy runner (SPEC §11 escape hatch).
 *
 * Additive {@link BehavioralRunner}: run L2 (boot + browser + evidence) on one
 * operator-configured host over a pluggable transport. **Does not** acquire the
 * local heavy-validation permit — that is the free-tier win.
 *
 * Non-goals (SPEC §17): not a multi-node mesh, not remote agents/L1, not HA.
 * Real SSH/rsync transport is deferred until human accept of the design.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BehavioralRunner } from '../orchestrator/verifier.js';
import {
  remoteJobDir,
  type HeavyJobExecResult,
  type HeavyJobRequest,
  type HeavyRemoteEndpoint,
} from '../domain/heavyWorker.js';
import { IdentifierError } from '../domain/task.js';
import { throwIfVerificationAborted } from '../domain/verificationRun.js';

export type { HeavyJobExecResult };

/**
 * IO boundary for moving worktrees / evidence to a single remote heavy host.
 * Implementations: {@link FakeHeavyTransport} (spike) or future SSH/rsync.
 */
export interface HeavyWorkerTransport {
  /** Push local worktree contents to the remote job directory. */
  syncUp(localWorkspace: string, remoteJobDir: string): Promise<void>;
  /** Run remote L2; return health + screenshot basenames still on remote. */
  execJob(
    remoteJobDir: string,
    request: HeavyJobRequest,
  ): Promise<HeavyJobExecResult>;
  /**
   * Pull screenshot files into the local screenshots dir for the task.
   * Returns basenames that arrived (partial pulls are allowed).
   */
  syncDown(
    remoteJobDir: string,
    localScreenshotDir: string,
  ): Promise<readonly string[]>;
  /** Remove the remote job tree after the run. */
  cleanup(remoteJobDir: string): Promise<void>;
}

export type FakeTransportCall =
  | {
      readonly op: 'syncUp';
      readonly localWorkspace: string;
      readonly remoteJobDir: string;
    }
  | {
      readonly op: 'execJob';
      readonly remoteJobDir: string;
      readonly request: HeavyJobRequest;
    }
  | {
      readonly op: 'syncDown';
      readonly remoteJobDir: string;
      readonly localScreenshotDir: string;
    }
  | { readonly op: 'cleanup'; readonly remoteJobDir: string };

export interface FakeHeavyTransportOptions {
  readonly execResult?: HeavyJobExecResult;
  /** Which step should throw (for failure-path tests). */
  readonly failOn?: 'syncUp' | 'execJob' | 'syncDown' | 'cleanup';
  readonly failMessage?: string;
  /**
   * Bytes written for each pulled screenshot basename (default tiny PNG-ish
   * payload so packet paths are real files).
   */
  readonly screenshotBytes?: Uint8Array;
}

/**
 * In-memory transport for unit tests — no SSH. Records call order.
 */
export class FakeHeavyTransport implements HeavyWorkerTransport {
  readonly calls: FakeTransportCall[] = [];
  private readonly execResult: HeavyJobExecResult;
  private readonly failOn: FakeHeavyTransportOptions['failOn'];
  private readonly failMessage: string;
  private readonly screenshotBytes: Uint8Array;

  constructor(opts: FakeHeavyTransportOptions = {}) {
    this.execResult = opts.execResult ?? {
      healthy: true,
      screenshotBasenames: [],
    };
    this.failOn = opts.failOn;
    this.failMessage = opts.failMessage ?? 'fake transport failure';
    this.screenshotBytes =
      opts.screenshotBytes ?? new TextEncoder().encode('fake-png');
  }

  async syncUp(localWorkspace: string, remoteDir: string): Promise<void> {
    this.calls.push({
      op: 'syncUp',
      localWorkspace,
      remoteJobDir: remoteDir,
    });
    if (this.failOn === 'syncUp') {
      throw new HeavyWorkerTransportError(this.failMessage);
    }
  }

  async execJob(
    remoteDir: string,
    request: HeavyJobRequest,
  ): Promise<HeavyJobExecResult> {
    this.calls.push({ op: 'execJob', remoteJobDir: remoteDir, request });
    if (this.failOn === 'execJob') {
      throw new HeavyWorkerTransportError(this.failMessage);
    }
    return this.execResult;
  }

  async syncDown(
    remoteDir: string,
    localScreenshotDir: string,
  ): Promise<readonly string[]> {
    this.calls.push({
      op: 'syncDown',
      remoteJobDir: remoteDir,
      localScreenshotDir,
    });
    if (this.failOn === 'syncDown') {
      throw new HeavyWorkerTransportError(this.failMessage);
    }
    await mkdir(localScreenshotDir, { recursive: true });
    const names = this.execResult.screenshotBasenames;
    for (const name of names) {
      await writeFile(join(localScreenshotDir, name), this.screenshotBytes);
    }
    return names;
  }

  async cleanup(remoteDir: string): Promise<void> {
    this.calls.push({ op: 'cleanup', remoteJobDir: remoteDir });
    if (this.failOn === 'cleanup') {
      throw new HeavyWorkerTransportError(this.failMessage);
    }
  }
}

/** Typed transport / remote heavy errors at the verification boundary. */
export class HeavyWorkerTransportError extends Error {
  override readonly name = 'HeavyWorkerTransportError';
}

export interface RemoteHeavyDeps {
  readonly endpoint: HeavyRemoteEndpoint;
  readonly transport: HeavyWorkerTransport;
  /** Daemon screenshots root (same as LiveBehavioralRunner). */
  readonly screenshotsRoot: string;
  /**
   * Best-effort cleanup logger. Defaults to console.error so cleanup failures
   * are never silent empty catches (project golden rule).
   */
  readonly logError?: (message: string) => void;
}

type BehavioralRunInput = Parameters<BehavioralRunner['run']>[0];
type BehavioralRunResult = Awaited<ReturnType<BehavioralRunner['run']>> & {
  readonly error?: string;
};

/**
 * L2 on one remote host. Implements {@link BehavioralRunner} without a local
 * heavy permit — capacity is enforced on the remote side (design doc).
 */
export class RemoteHeavyRunner implements BehavioralRunner {
  private readonly logError: (message: string) => void;

  constructor(private readonly deps: RemoteHeavyDeps) {
    this.logError =
      deps.logError ??
      ((message: string) => {
        console.error(message);
      });
  }

  async run(input: BehavioralRunInput): Promise<BehavioralRunResult> {
    // Path chokepoint before any IO — unsafe ids must throw, not map to L2 fail.
    throwIfVerificationAborted(input.signal);
    const jobDir = remoteJobDir(this.deps.endpoint.remoteRoot, input.taskId);

    const request = toHeavyJobRequest(input);
    const localShotDir = join(this.deps.screenshotsRoot, input.taskId);

    let outcome: BehavioralRunResult = {
      screenshots: [],
      healthy: false,
      error: 'remote heavy job did not complete',
    };

    try {
      throwIfVerificationAborted(input.signal);
      await this.deps.transport.syncUp(input.cwd, jobDir);
      throwIfVerificationAborted(input.signal);
      const exec = await this.deps.transport.execJob(jobDir, request);
      throwIfVerificationAborted(input.signal);
      const basenames = await this.deps.transport.syncDown(jobDir, localShotDir);
      throwIfVerificationAborted(input.signal);

      if (!exec.healthy) {
        outcome = {
          screenshots: [...basenames],
          healthy: false,
          ...(exec.error !== undefined ? { error: exec.error } : { error: 'remote L2 unhealthy' }),
        };
      } else {
        outcome = {
          screenshots: [...basenames],
          healthy: true,
        };
      }
    } catch (err) {
      // IdentifierError must not be converted into a soft L2 failure.
      if (err instanceof IdentifierError) {
        throw err;
      }
      const message = errorMessage(err);
      outcome = {
        screenshots: [],
        healthy: false,
        error: message,
      };
    } finally {
      await this.cleanupBestEffort(jobDir);
    }

    return outcome;
  }

  private async cleanupBestEffort(jobDir: string): Promise<void> {
    try {
      await this.deps.transport.cleanup(jobDir);
    } catch (cleanupErr) {
      const msg = errorMessage(cleanupErr);
      this.logError(
        `[hercules] remote heavy cleanup failed for ${jobDir}: ${msg}`,
      );
    }
  }
}

function toHeavyJobRequest(input: BehavioralRunInput): HeavyJobRequest {
  return {
    taskId: input.taskId,
    baseUrl: input.baseUrl,
    bootCommands: input.bootCommands,
    healthCommand: input.healthCommand,
    captures: input.captures,
    ...(input.localStorage !== undefined
      ? { localStorage: input.localStorage }
      : {}),
    ...(input.mobile !== undefined ? { mobile: input.mobile } : {}),
    ...(input.smokeFlows !== undefined ? { smokeFlows: input.smokeFlows } : {}),
    ...(input.taskBody !== undefined ? { taskBody: input.taskBody } : {}),
    ...(input.workflowEvidence !== undefined
      ? { workflowEvidence: input.workflowEvidence }
      : {}),
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
