/**
 * Verification Layer 1 — mechanical gates (SPEC §9.1).
 *
 * Runs the repo's WORKFLOW gate commands (typecheck, lint, test, build) in the
 * task's worktree, in order, fail-fast. The failing gate's output is captured
 * verbatim so it can be fed back to the agent — the engine of self-correction.
 * The command runner is injected so this is tested without spawning processes.
 *
 * Cancel: optional AbortSignal kills the active process group so a human cancel
 * during L1 does not leave cargo/rustc children under the daemon (2026-07-31).
 */
import { spawn } from 'node:child_process';
import type { GateResult } from '../domain/verification.js';
import type { VerificationPhase } from '../domain/verificationRun.js';
import {
  isForceVerificationCancel,
  isVerificationAborted,
  throwIfVerificationAborted,
  VerificationAbortedError,
} from '../domain/verificationRun.js';
import { verificationChildEnv } from '../adapters/policyEnv.js';
import type { EffectiveRepoExecutionPolicy } from '../domain/repoExecutionPolicy.js';
import { killProcessGroup } from './processGroup.js';

export interface Gate {
  readonly name: string;
  readonly command: string;
}

export interface CommandRunOpts {
  readonly signal?: AbortSignal;
  /** Effective repo execution policy for the child env boundary. */
  readonly executionPolicy?: EffectiveRepoExecutionPolicy | null;
}

export type CommandRunner = (
  command: string,
  cwd: string,
  opts?: CommandRunOpts,
) => Promise<{ exitCode: number; output: string }>;

export interface GateRunOpts {
  readonly signal?: AbortSignal;
  /** Propagated into gate child env filtering. */
  readonly executionPolicy?: EffectiveRepoExecutionPolicy | null;
  readonly onProgress?: (update: {
    readonly phase: VerificationPhase;
    readonly stage: string;
    readonly processAlive: boolean;
    readonly completedStage?: string;
  }) => void;
  /**
   * Map gate name → phase for progress (default: setup for name===setup,
   * held-out for held-out-smoke, else l1).
   */
  readonly phaseForGate?: (gate: Gate) => VerificationPhase;
}

function defaultPhaseForGate(gate: Gate): VerificationPhase {
  if (gate.name === 'setup') return 'setup';
  if (gate.name === 'held-out-smoke' || gate.name === 'held-out') return 'held-out';
  return 'l1';
}

/**
 * Default runner: detached shell process group, stdout+stderr merged.
 *
 * Shell execution is intentional — gate commands are repo policy (e.g.
 * `pnpm build && pnpm test`) that need shell operators. SECURITY (SPEC §10):
 * these commands MUST come from a trusted WORKFLOW.md read from the repo's
 * default branch (the mirror), NEVER from the agent's worktree, task files, or
 * any other observed content — otherwise an agent could inject commands here.
 *
 * AbortSignal → TERM/KILL process group (cancel during cargo must not leave
 * orphans under the Hercules daemon).
 */
/**
 * Stable marker in gate output when a command was killed by human cancel.
 * Used as a belt-and-suspenders signal so a cancelled L1 cannot look like a
 * normal failing gate (exit≠0 → auto-rework).
 */
export const GATE_CANCEL_OUTPUT_MARK = '[hercules] gate command aborted (cancel)';

export const execRunner: CommandRunner = (command, cwd, opts) =>
  new Promise((resolve, reject) => {
    const signal = opts?.signal;
    const force = isForceVerificationCancel(signal?.reason);
    // Cancel must reject with VerificationAbortedError — never resolve as a
    // normal non-zero exit (complete() would treat that as gate fail → rework).
    if (signal?.aborted) {
      reject(
        new VerificationAbortedError(
          'verification aborted — gate command cancelled before start',
          force,
        ),
      );
      return;
    }

    const child = spawn('sh', ['-c', command], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Never inherit production secrets / tokens into gate children.
      env: verificationChildEnv({ policy: opts?.executionPolicy ?? null }).env, // policy-aware
    });
    let stdout = '';
    let stderr = '';
    let finished = false;
    /** True once human cancel asked us to kill the process group. */
    let cancelRequested = false;
    let onAbort: (() => void) | null = null;

    const detachAbort = (): void => {
      if (onAbort && signal) {
        signal.removeEventListener('abort', onAbort);
        onAbort = null;
      }
    };

    const finishOk = (exitCode: number, extra = ''): void => {
      if (finished) return;
      finished = true;
      detachAbort();
      const output = `${stdout}${stderr}${extra}`;
      resolve({ exitCode, output });
    };

    const finishCancelled = (detail: string): void => {
      if (finished) return;
      finished = true;
      detachAbort();
      const forced = isForceVerificationCancel(signal?.reason);
      reject(
        new VerificationAbortedError(
          `verification aborted during gate command: ${detail}`,
          forced,
        ),
      );
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
      if (stdout.length > 12 * 1024 * 1024) stdout = stdout.slice(-8 * 1024 * 1024);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
      if (stderr.length > 4 * 1024 * 1024) stderr = stderr.slice(-2 * 1024 * 1024);
    });
    child.on('error', (err) => {
      if (cancelRequested) {
        finishCancelled(err.message);
        return;
      }
      finishOk(1, err.message);
    });
    child.on('close', (code, closeSignal) => {
      // Human cancel path: always abort-error (even if close races with kill).
      if (cancelRequested || signal?.aborted) {
        finishCancelled(closeSignal ? `signal ${closeSignal}` : `exit ${code ?? '?'}`);
        return;
      }
      // Unrelated process signal (not our cancel) — surface as non-zero exit,
      // not VerificationAbortedError (no human cancel intent).
      if (closeSignal) {
        finishOk(130, `\n[hercules] gate command terminated (${closeSignal})\n`);
        return;
      }
      finishOk(typeof code === 'number' ? code : 1);
    });

    const abort = (): void => {
      if (finished) return;
      cancelRequested = true;
      const pid = child.pid;
      const forced = isForceVerificationCancel(signal?.reason);
      if (typeof pid === 'number') {
        void killProcessGroup(pid, {
          label: 'gate process-group',
          force: forced,
          ...(signal?.reason && typeof signal.reason === 'object'
            ? { cancelReason: signal.reason as { force: boolean } }
            : {}),
        }).then(
          () => finishCancelled(GATE_CANCEL_OUTPUT_MARK),
          () => finishCancelled(GATE_CANCEL_OUTPUT_MARK),
        );
      } else {
        try {
          child.kill('SIGKILL');
        } catch {
          /* process already gone */
        }
        finishCancelled(GATE_CANCEL_OUTPUT_MARK);
      }
    };

    if (signal) {
      if (signal.aborted) abort();
      else {
        onAbort = abort;
        signal.addEventListener('abort', abort, { once: true });
      }
    }
  });

export async function runGates(
  gates: readonly Gate[],
  cwd: string,
  run: CommandRunner = execRunner,
  opts: GateRunOpts = {},
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  const phaseFor = opts.phaseForGate ?? defaultPhaseForGate;
  for (const gate of gates) {
    throwIfVerificationAborted(opts.signal);
    const phase = phaseFor(gate);
    opts.onProgress?.({
      phase,
      stage: gate.name,
      processAlive: true,
    });
    let exitCode: number;
    let output: string;
    try {
      const result = await run(gate.command, cwd, {
        ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.executionPolicy !== undefined ? { executionPolicy: opts.executionPolicy } : {}),
      });
      exitCode = result.exitCode;
      output = result.output;
    } catch (err) {
      // execRunner rejects VerificationAbortedError on cancel; also accept
      // AbortError from custom runners so complete() never auto-reworks cancel.
      if (isVerificationAborted(err) || opts.signal?.aborted) {
        throw err instanceof VerificationAbortedError
          ? err
          : new VerificationAbortedError(
              `verification aborted during gate '${gate.name}'`,
            );
      }
      throw err;
    }
    // Cancel after resolve (race): never fold into a normal failing GateResult.
    if (opts.signal?.aborted) {
      throw new VerificationAbortedError(
        `verification aborted during gate '${gate.name}'`,
      );
    }
    // Belt-and-suspenders: cancel marker in output without thrown abort.
    if (output.includes(GATE_CANCEL_OUTPUT_MARK)) {
      throw new VerificationAbortedError(
        `verification aborted during gate '${gate.name}'`,
      );
    }
    const passed = exitCode === 0;
    results.push({
      name: gate.name,
      command: gate.command,
      passed,
      output: output.trim(),
      exitCode,
    });
    opts.onProgress?.({
      phase,
      stage: gate.name,
      processAlive: false,
      completedStage: gate.name,
    });
    if (!passed) break; // fail-fast: later gates can't run meaningfully
  }
  return results;
}

/** True only if every gate ran and passed. */
export function gatesGreen(gates: readonly Gate[], results: readonly GateResult[]): boolean {
  return results.length === gates.length && results.every((r) => r.passed);
}
