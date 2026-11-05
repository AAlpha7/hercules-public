/**
 * Verification Layer 2 — booting the app under test (SPEC §9.2, §12).
 *
 * Runs the WORKFLOW setup.boot commands as detached background processes in the
 * worktree, polls the health check until ready, and on teardown kills each
 * process group. Spawn / exec / sleep / clock / kill are injected so the control
 * flow is tested without launching real servers.
 *
 * SECURITY (§10): boot/health commands are repo policy from a trusted
 * WORKFLOW.md (never the agent's worktree); shell execution is intentional.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { bootChildEnv } from '../adapters/policyEnv.js';
import type { EffectiveRepoExecutionPolicy } from '../domain/repoExecutionPolicy.js';
import {
  isForceVerificationCancel,
  throwIfVerificationAborted,
} from '../domain/verificationRun.js';
import { execRunner, type CommandRunner } from './gates.js';
import { killProcessGroup } from './processGroup.js';
import type { BootController } from './behavioral.js';

interface SpawnedProc {
  readonly pid: number | undefined;
  unref(): void;
}

type BootSpawn = (
  command: string,
  args: readonly string[],
  opts: { cwd: string; detached: boolean; stdio: 'ignore'; env?: NodeJS.ProcessEnv },
) => SpawnedProc;

export interface CommandBootOptions {
  readonly bootCommands: readonly string[];
  readonly healthCommand: string | undefined;
  readonly cwd: string;
  readonly spawn?: BootSpawn;
  readonly exec?: CommandRunner;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly clock?: () => number;
  readonly kill?: (pid: number) => void;
  readonly healthTimeoutMs?: number;
  readonly healthIntervalMs?: number;
  /** Human cancel — abort health polling and tear down boot process groups. */
  readonly signal?: AbortSignal;
  /**
   * Effective repo policy for boot/health child env. Omitted → compatible
   * defaults; an explicit env allowlist is authoritative (never widened).
   */
  readonly executionPolicy?: EffectiveRepoExecutionPolicy | null;
}

const defaultSpawn: BootSpawn = (command, args, opts) => {
  const cp = nodeSpawn(command, [...args], {
    cwd: opts.cwd,
    detached: opts.detached,
    stdio: opts.stdio,
    ...(opts.env ? { env: opts.env } : {}),
  });
  return { pid: cp.pid, unref: () => cp.unref() };
};

export class CommandBootController implements BootController {
  private readonly pids: number[] = [];
  private abortHook: (() => void) | null = null;

  constructor(private readonly opts: CommandBootOptions) {
    const signal = opts.signal;
    if (signal) {
      const onAbort = (): void => {
        void this.teardown();
      };
      if (signal.aborted) onAbort();
      else {
        this.abortHook = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  }

  async boot(): Promise<void> {
    throwIfVerificationAborted(this.opts.signal);
    const spawn = this.opts.spawn ?? defaultSpawn;
    for (const command of this.opts.bootCommands) {
      throwIfVerificationAborted(this.opts.signal);
      const child = spawn('sh', ['-c', command], {
        cwd: this.opts.cwd,
        detached: true,
        stdio: 'ignore',
        // Policy-filtered allowlist env (SPEC §10): the app under test gets only
        // infra/runtime vars — never the daemon's HERCULES_* config (work root /
        // token; an inherited HERCULES_WORK_DIR once deleted every production
        // worktree, 2026-07-17) NOR any host secret (model keys, cloud/DB
        // creds). An explicit repo env allowlist is authoritative here; WORKFLOW
        // boot sets whatever the app needs inline in the command string.
        env: bootChildEnv({ policy: this.opts.executionPolicy ?? null }).env,
      });
      child.unref();
      if (typeof child.pid === 'number') this.pids.push(child.pid);
    }
  }

  async waitHealthy(): Promise<boolean> {
    const health = this.opts.healthCommand;
    if (!health) return true;
    const exec = this.opts.exec ?? execRunner;
    const sleep = this.opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const clock = this.opts.clock ?? Date.now;
    const interval = this.opts.healthIntervalMs ?? 1000;
    const deadline = clock() + (this.opts.healthTimeoutMs ?? 60_000);
    const signal = this.opts.signal;

    while (clock() < deadline) {
      throwIfVerificationAborted(signal);
      const { exitCode } = await exec(health, this.opts.cwd, {
        ...(signal ? { signal } : {}),
        ...(this.opts.executionPolicy !== undefined
          ? { executionPolicy: this.opts.executionPolicy }
          : {}),
      });
      if (exitCode === 0) return true;
      throwIfVerificationAborted(signal);
      await sleep(interval);
    }
    return false;
  }

  async teardown(): Promise<void> {
    if (this.abortHook && this.opts.signal) {
      this.opts.signal.removeEventListener('abort', this.abortHook);
      this.abortHook = null;
    }
    const force = isForceVerificationCancel(this.opts.signal?.reason);
    const kill = this.opts.kill;
    for (const pid of this.pids) {
      try {
        if (kill) {
          kill(pid);
        } else {
          await killProcessGroup(pid, {
            label: 'boot process-group',
            force,
            graceMs: force ? 0 : 400,
            ...(this.opts.signal?.reason && typeof this.opts.signal.reason === 'object'
              ? { cancelReason: this.opts.signal.reason as { force: boolean } }
              : {}),
          });
        }
      } catch {
        // already gone
      }
    }
    this.pids.length = 0;
  }
}
