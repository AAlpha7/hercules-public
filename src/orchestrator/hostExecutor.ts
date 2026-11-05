/**
 * Deterministic host-operation / deploy executor.
 *
 * Runs validateHostCommandScope-approved commands sequentially in process
 * groups — no LLM adapter, no automatic retry. Implements {@link AgentRun}
 * so the orchestrator tick loop can track progress, cancel, and finalize.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { hostTaskChildEnv } from '../adapters/env.js';
import { boundedAppend } from '../adapters/bounded.js';
import {
  buildHostExecutionSummary,
  formatHostExecutorFinalMessage,
  hostCommandPublicName,
  HOST_EXECUTOR_SESSION_PREFIX,
  HOST_OUTPUT_TAIL_MAX,
  redactHostOutput,
  resolveHostCommandTimeoutMs,
  splitHostCommandArgv,
  toHostRunLiveMeta,
  type HostCommandResult,
  type HostCommandTerminalKind,
  type HostRunLiveMeta,
} from '../domain/hostExecutor.js';
import { validateHostCommandScope } from '../domain/executionClass.js';
import {
  isProcessGroupAlive,
  killProcessGroup,
} from '../verification/processGroup.js';
import type {
  AgentAdapter,
  AgentRun,
  AgentStartInput,
  RunSnapshot,
} from './adapter.js';

/** Bounded wait for process-group members to exit after the leader closes. */
const PROCESS_GROUP_SETTLE_MS = 2_000;
const PROCESS_GROUP_SETTLE_SLICE_MS = 50;

export class HostExecutorError extends Error {
  override readonly name = 'HostExecutorError';
}

/**
 * Narrow spawn contract used by the host executor (detached process groups +
 * piped stdio). Avoids Node's overloaded `typeof spawn`, which is hostile to
 * typed test doubles.
 */
export type HostSpawnFn = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly detached: boolean;
    readonly stdio: ['ignore', 'pipe', 'pipe'];
  },
) => ChildProcess;

export interface HostExecutorOptions {
  /** Per-command wall-clock timeout (ms). Default ≥ 30m. */
  readonly commandTimeoutMs?: number;
  /**
   * Test-only: allow timeouts below the production minimum so unit tests can
   * exercise the timeout kill path without waiting a full minute.
   */
  readonly allowShortTimeout?: boolean;
  /** Override spawn for tests. */
  readonly spawn?: HostSpawnFn;
  /** Override process-group kill for tests. */
  readonly killProcessGroup?: typeof killProcessGroup;
  /** Clock for duration stamps (tests). */
  readonly clock?: () => number;
  /** Working directory override (default: input.workspace). */
  readonly cwd?: string;
  /**
   * Source env for children (default: process.env). Always passed through the
   * strict host allowlist before task ownership markers are added.
   */
  readonly env?: NodeJS.ProcessEnv;
  /** Override process-group liveness probe (tests). */
  readonly isProcessGroupAlive?: typeof isProcessGroupAlive;
  /** Override sleep used while waiting for process-group settlement (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Adapter-shaped entry so dispatch can treat host runs like other AgentRuns.
 * Never registered as a selectable coding adapter.
 */
export class HostExecutorAdapter implements AgentAdapter {
  readonly name = 'host-executor';

  constructor(private readonly opts: HostExecutorOptions = {}) {}

  start(input: AgentStartInput, now: number): AgentRun {
    return startHostExecution(input, now, this.opts);
  }
}

export function startHostExecution(
  input: AgentStartInput,
  now: number,
  opts: HostExecutorOptions = {},
): HostExecutorRun {
  const scopeRaw = input.hostCommandScope ?? [];
  const validated = validateHostCommandScope(scopeRaw);
  if (!validated.ok) {
    throw new HostExecutorError(`invalid host command scope: ${validated.reason}`);
  }
  return new HostExecutorRun(input, validated.scope, now, opts);
}

export class HostExecutorRun implements AgentRun {
  readonly sessionId: string;
  private readonly commandTimeoutMs: number;
  private readonly spawnFn: HostSpawnFn;
  private readonly killPg: typeof killProcessGroup;
  private readonly isPgAlive: typeof isProcessGroupAlive;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly clock: () => number;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly scope: readonly string[];
  private readonly taskId: string;
  private readonly startedAtMs: number;

  private status: 'running' | 'done' | 'failed' = 'running';
  private lastEventAt: number;
  private readonly activity: string[] = [];
  private finalText = '';
  private readonly results: HostCommandResult[] = [];
  private currentIndex = 0;
  private currentCommand: string | null = null;
  private processAlive = false;
  private processPid: number | undefined;
  private cancelRequested = false;
  private forceCancel = false;
  private started = false;
  private chain: Promise<void>;
  private activeChild: ChildProcess | null = null;
  private activeKill: (() => Promise<void>) | null = null;
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private stderrTail = '';

  constructor(
    input: AgentStartInput,
    scope: readonly string[],
    now: number,
    opts: HostExecutorOptions,
  ) {
    this.taskId = input.taskId;
    this.scope = scope;
    this.startedAtMs = now;
    this.lastEventAt = now;
    this.sessionId = `${HOST_EXECUTOR_SESSION_PREFIX}${input.taskId}:${now}`;
    this.commandTimeoutMs =
      opts.allowShortTimeout === true &&
      typeof opts.commandTimeoutMs === 'number' &&
      Number.isFinite(opts.commandTimeoutMs)
        ? Math.max(1, Math.floor(opts.commandTimeoutMs))
        : resolveHostCommandTimeoutMs(opts.commandTimeoutMs);
    this.spawnFn =
      opts.spawn ??
      ((command, args, options) =>
        spawn(command, [...args], {
          cwd: options.cwd,
          env: options.env,
          detached: options.detached,
          stdio: options.stdio,
        }) as ChildProcess);
    this.killPg = opts.killProcessGroup ?? killProcessGroup;
    this.isPgAlive = opts.isProcessGroupAlive ?? isProcessGroupAlive;
    this.sleepFn = opts.sleep ?? ((ms: number) => sleep(ms));
    this.clock = opts.clock ?? (() => Date.now());
    this.cwd = opts.cwd ?? input.workspace;
    this.env = hostTaskChildEnv(
      input.taskId,
      input.allocation.slug,
      opts.env ?? process.env,
    );
    this.chain = Promise.resolve();
  }

  /**
   * Begin sequential execution. Called by the orchestrator after the durable
   * start marker is committed — never from the constructor.
   *
   * Idempotent: a second begin() is a no-op. Cancel/stop before begin never
   * spawns (closes the durable-marker/cancel/begin race).
   */
  begin(): void {
    if (this.started) return;
    this.started = true;
    // Pre-begin stop: durable marker may exist, but no process may spawn.
    if (this.cancelRequested || this.status !== 'running') {
      if (this.finalText.length === 0) {
        const summary = buildHostExecutionSummary(this.scope, []);
        this.finalText = formatHostExecutorFinalMessage({
          ...summary,
          outcome: 'skipped',
          stopReason: 'cancelled before start',
        });
      }
      this.status = 'failed';
      this.chain = Promise.resolve();
      return;
    }
    this.chain = this.runAll();
  }

  /** Test / await helper: resolve when the chain finishes. */
  whenSettled(): Promise<void> {
    return this.chain;
  }

  liveMeta(nowMs: number = this.clock()): HostRunLiveMeta {
    return toHostRunLiveMeta({
      taskId: this.taskId,
      commandIndex: this.currentCommand ? this.currentIndex + 1 : this.currentIndex,
      commandTotal: this.scope.length,
      commandName: this.currentCommand,
      startedAtMs: this.startedAtMs,
      nowMs,
      processAlive: this.processAlive,
      timeoutMs: this.commandTimeoutMs,
      cancelRequested: this.cancelRequested,
    });
  }

  poll(_now: number): RunSnapshot {
    // Do not bump lastEventAt on poll — only real command activity does (stall honesty).
    const recent = this.activity.slice(-8);
    return {
      sessionId: this.sessionId,
      status: this.status,
      lastEventAt: this.lastEventAt,
      ...(recent.length > 0 ? { recentActivity: recent } : {}),
      ...(this.status !== 'running'
        ? {
            exitCode: this.exitCode,
            exitSignal: this.exitSignal,
            ...(this.stderrTail.length > 0 ? { stderrTail: this.stderrTail } : {}),
          }
        : {
            processAlive: this.processAlive,
            ...(this.processPid !== undefined ? { processPid: this.processPid } : {}),
            aliveHint: this.currentCommand
              ? `host:${hostCommandPublicName(this.currentCommand, 40)}`
              : 'host:idle',
          }),
    };
  }

  activityLog(): readonly string[] {
    return [...this.activity];
  }

  finalMessage(): string {
    return this.finalText;
  }

  stop(opts?: { force?: boolean }): void {
    if (this.status !== 'running') return;
    this.cancelRequested = true;
    if (opts?.force === true) this.forceCancel = true;
    this.pushActivity(
      opts?.force === true
        ? 'host-executor: force cancel requested'
        : 'host-executor: cancel requested',
    );
    // Cancel before begin(): no process was spawned — finish immediately.
    if (!this.started) {
      this.status = 'failed';
      this.exitCode = null;
      this.exitSignal = opts?.force === true ? 'SIGKILL' : 'SIGTERM';
      const summary = buildHostExecutionSummary(this.scope, []);
      this.finalText = formatHostExecutorFinalMessage({
        ...summary,
        outcome: 'skipped',
        stopReason: 'cancelled before start',
      });
      this.lastEventAt = this.clock();
      return;
    }
    const kill = this.activeKill;
    if (kill) {
      void kill();
    }
  }

  private pushActivity(line: string): void {
    const clean = redactHostOutput(line, 500).replace(/\s+/g, ' ').trim();
    if (clean.length === 0) return;
    this.activity.push(clean);
    if (this.activity.length > 200) this.activity.splice(0, this.activity.length - 200);
    this.lastEventAt = this.clock();
  }

  private async runAll(): Promise<void> {
    try {
      for (let i = 0; i < this.scope.length; i += 1) {
        if (this.cancelRequested) {
          this.results.push(
            this.syntheticResult(i, this.scope[i]!, 'cancel', {
              ok: false,
              exitCode: null,
              exitSignal: this.forceCancel ? 'SIGKILL' : 'SIGTERM',
              durationMs: 0,
              stdoutTail: '',
              stderrTail: 'cancelled before start',
            }),
          );
          break;
        }
        const command = this.scope[i]!;
        this.currentIndex = i;
        this.currentCommand = command;
        this.pushActivity(
          `host-executor: [${i + 1}/${this.scope.length}] start \`${hostCommandPublicName(command)}\``,
        );
        const result = await this.runOne(i, command);
        this.results.push(result);
        this.processAlive = false;
        this.processPid = undefined;
        this.activeChild = null;
        this.activeKill = null;
        this.pushActivity(
          `host-executor: [${i + 1}/${this.scope.length}] ${result.ok ? 'ok' : 'FAIL'} ` +
            `(${result.kind}${result.exitCode !== null ? ` exit=${result.exitCode}` : ''}` +
            `${result.exitSignal ? ` signal=${result.exitSignal}` : ''}, ${result.durationMs}ms)`,
        );
        if (!result.ok) {
          // Never continue / never retry after first failure.
          break;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.pushActivity(`host-executor: internal error: ${msg}`);
      if (this.results.length < this.scope.length) {
        const i = this.results.length;
        this.results.push(
          this.syntheticResult(i, this.scope[i] ?? '(unknown)', 'spawn_error', {
            ok: false,
            exitCode: null,
            exitSignal: null,
            durationMs: 0,
            stdoutTail: '',
            stderrTail: msg,
          }),
        );
      }
    }

    this.currentCommand = null;
    this.processAlive = false;
    this.processPid = undefined;

    const summary = buildHostExecutionSummary(this.scope, this.results);
    this.finalText = formatHostExecutorFinalMessage(summary);
    this.stderrTail = redactHostOutput(
      this.results
        .map((r) => r.stderrTail)
        .filter((s) => s.length > 0)
        .join('\n')
        .slice(-HOST_OUTPUT_TAIL_MAX),
    );

    if (summary.outcome === 'success') {
      this.status = 'done';
      this.exitCode = 0;
      this.exitSignal = null;
    } else {
      this.status = 'failed';
      const last = this.results[this.results.length - 1];
      this.exitCode = last?.exitCode ?? 1;
      this.exitSignal = last?.exitSignal ?? null;
    }
    this.lastEventAt = this.clock();
    this.pushActivity(`host-executor: finished outcome=${summary.outcome}`);
  }

  private syntheticResult(
    index: number,
    command: string,
    kind: HostCommandTerminalKind,
    fields: Omit<HostCommandResult, 'command' | 'index' | 'kind'>,
  ): HostCommandResult {
    return { command, index, kind, ...fields };
  }

  private runOne(index: number, command: string): Promise<HostCommandResult> {
    const started = this.clock();
    const split = splitHostCommandArgv(command);
    if (!split.ok) {
      return Promise.resolve(
        this.syntheticResult(index, command, 'spawn_error', {
          ok: false,
          exitCode: null,
          exitSignal: null,
          durationMs: 0,
          stdoutTail: '',
          stderrTail: split.reason,
        }),
      );
    }
    const [file, ...args] = split.argv;
    if (!file) {
      return Promise.resolve(
        this.syntheticResult(index, command, 'spawn_error', {
          ok: false,
          exitCode: null,
          exitSignal: null,
          durationMs: 0,
          stdoutTail: '',
          stderrTail: 'empty argv',
        }),
      );
    }

    return new Promise((resolve) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const finish = (result: HostCommandResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.activeChild = null;
        this.activeKill = null;
        this.processAlive = false;
        this.processPid = undefined;
        resolve(result);
      };

      let child: ChildProcess;
      try {
        child = this.spawnFn(file, args, {
          cwd: this.cwd,
          env: this.env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        finish(
          this.syntheticResult(index, command, 'spawn_error', {
            ok: false,
            exitCode: null,
            exitSignal: null,
            durationMs: Math.max(0, this.clock() - started),
            stdoutTail: '',
            stderrTail: msg,
          }),
        );
        return;
      }

      this.activeChild = child;
      const pid = child.pid;
      if (typeof pid === 'number' && pid > 0) {
        this.processPid = pid;
        this.processAlive = true;
      }

      const killActive = async (force: boolean): Promise<void> => {
        if (typeof pid !== 'number' || pid <= 0) return;
        await this.killPg(pid, {
          force,
          graceMs: force ? 0 : 400,
          label: 'host-executor',
          log: (line) => this.pushActivity(line),
        });
      };
      this.activeKill = async () => {
        cancelled = true;
        await killActive(this.forceCancel);
      };

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout = boundedAppend(stdout, String(chunk), HOST_OUTPUT_TAIL_MAX);
        this.lastEventAt = this.clock();
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr = boundedAppend(stderr, String(chunk), HOST_OUTPUT_TAIL_MAX);
        this.lastEventAt = this.clock();
      });

      timer = setTimeout(() => {
        timedOut = true;
        this.pushActivity(
          `host-executor: timeout after ${this.commandTimeoutMs}ms on command ${index + 1}`,
        );
        void killActive(true);
      }, this.commandTimeoutMs);

      // If cancel arrived between loop check and spawn.
      if (this.cancelRequested) {
        cancelled = true;
        void killActive(this.forceCancel);
      }

      child.on('error', (err) => {
        finish(
          this.syntheticResult(index, command, 'spawn_error', {
            ok: false,
            exitCode: null,
            exitSignal: null,
            durationMs: Math.max(0, this.clock() - started),
            stdoutTail: redactHostOutput(stdout),
            stderrTail: redactHostOutput(err.message),
          }),
        );
      });

      child.on('close', (code, signal) => {
        void (async () => {
          // Wait boundedly for the whole process group to settle before
          // recording the result / tearing down to the next command.
          if (typeof pid === 'number' && pid > 0) {
            await this.waitProcessGroupSettled(pid);
          }
          const durationMs = Math.max(0, this.clock() - started);
          const stdoutTail = redactHostOutput(stdout);
          const stderrTail = redactHostOutput(stderr);

          if (timedOut) {
            finish(
              this.syntheticResult(index, command, 'timeout', {
                ok: false,
                exitCode: code,
                exitSignal: signal ?? 'SIGKILL',
                durationMs,
                stdoutTail,
                stderrTail,
              }),
            );
            return;
          }
          if (cancelled || this.cancelRequested) {
            finish(
              this.syntheticResult(index, command, 'cancel', {
                ok: false,
                exitCode: code,
                exitSignal: signal ?? (this.forceCancel ? 'SIGKILL' : 'SIGTERM'),
                durationMs,
                stdoutTail,
                stderrTail,
              }),
            );
            return;
          }
          if (signal) {
            finish(
              this.syntheticResult(index, command, 'signal', {
                ok: false,
                exitCode: code,
                exitSignal: signal,
                durationMs,
                stdoutTail,
                stderrTail,
              }),
            );
            return;
          }
          const exitCode = code ?? 1;
          finish(
            this.syntheticResult(index, command, 'exit', {
              ok: exitCode === 0,
              exitCode,
              exitSignal: null,
              durationMs,
              stdoutTail,
              stderrTail,
            }),
          );
        })();
      });
    });
  }

  /** Poll until the process group is dead or the settle budget elapses. */
  private async waitProcessGroupSettled(pid: number): Promise<void> {
    let waited = 0;
    while (waited < PROCESS_GROUP_SETTLE_MS) {
      if (!this.isPgAlive(pid)) return;
      await this.sleepFn(PROCESS_GROUP_SETTLE_SLICE_MS);
      waited += PROCESS_GROUP_SETTLE_SLICE_MS;
    }
    // Last-resort force kill so teardown never leaves descendants behind.
    if (this.isPgAlive(pid)) {
      await this.killPg(pid, {
        force: true,
        graceMs: 0,
        label: 'host-executor-settle',
        log: (line) => this.pushActivity(line),
      });
    }
  }
}

/** True when a poll snapshot belongs to the deterministic host executor. */
export function isHostExecutorSession(sessionId: string | null | undefined): boolean {
  return typeof sessionId === 'string' && sessionId.startsWith(HOST_EXECUTOR_SESSION_PREFIX);
}

export { isProcessGroupAlive };
