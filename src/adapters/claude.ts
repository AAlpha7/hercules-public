/**
 * Execution layer — the Claude Code adapter (SPEC §13.1).
 *
 * Drives `claude -p` headless with `--output-format stream-json`, parsing the
 * newline-delimited event stream for the session id, completion state, and token
 * usage. Fits the poll-based AgentRun contract: the child runs asynchronously
 * and updates internal state on each event; `poll()` reads the latest snapshot,
 * so the orchestrator detects completion and stalls without callbacks.
 *
 * `spawn` and `clock` are injected so the parser is tested against synthetic
 * stream-json without ever launching the real CLI (no cost, deterministic).
 */
import { spawn as nodeSpawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type {
  AgentAdapter,
  AgentRun,
  AgentStartInput,
  RunSnapshot,
  RunStatus,
  TokenUsage,
} from '../orchestrator/adapter.js';
import { appendActivity, ACTIVITY_TAIL } from './activity.js';
import { codingChildEnv } from './policyEnv.js';
import { boundedAppend, MAX_STDERR_TAIL, MAX_STREAM_LINE_BUFFER } from './bounded.js';
import { modelAuthNamesFor } from '../domain/repoExecutionPolicy.js';

/** The slice of a child process this adapter needs (so tests can fake it). */
export interface ChildLike {
  /** Optional because stream-json adapters never write to their child. */
  readonly stdin?: Writable | null;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** The OS process id, when available. Present on a real ChildProcess. */
  readonly pid?: number | undefined;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) => ChildLike;

export interface ClaudeAdapterOptions {
  readonly spawn?: SpawnFn;
  readonly claudeBin?: string;
  readonly allowedTools?: readonly string[];
  readonly permissionMode?: string;
  /** Extra CLI args appended verbatim. */
  readonly extraArgs?: readonly string[];
  /** ms since epoch; defaults to Date.now. */
  readonly clock?: () => number;
}

const DEFAULT_ALLOWED_TOOLS = ['Edit', 'Write', 'Read', 'Bash', 'Glob', 'Grep'];

const defaultSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, [...args], { cwd: options.cwd, env: options.env, detached: true });

export function buildClaudeArgs(input: AgentStartInput, opts: ClaudeAdapterOptions): string[] {
  const allowedTools = opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
  const args = [
    '-p',
    input.prompt,
    '--output-format',
    'stream-json',
    // stream-json over -p requires --verbose to emit the full event stream.
    '--verbose',
    '--permission-mode',
    opts.permissionMode ?? 'acceptEdits',
    '--allowedTools',
    allowedTools.join(','),
    // Hermetic run: the operator's user-level hooks must not reach task
    // agents. A grok-cto SessionStart hook injected "delegate to Grok" into
    // an agent, which then shipped an empty diff twice (2026-07-24). OAuth
    // and repo CLAUDE.md still apply — only hook injection is cut.
    '--settings',
    JSON.stringify({ disableAllHooks: true }),
  ];
  // Multi-turn resume (comment-to-steer).
  if (input.resumeSessionId && input.resumeSessionId.length > 0) {
    args.push('--resume', input.resumeSessionId);
  }
  if (opts.extraArgs) args.push(...opts.extraArgs);
  return args;
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
}

function toolArg(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const i = input as Record<string, unknown>;
  if (typeof i['file_path'] === 'string') return ` ${i['file_path']}`;
  if (typeof i['command'] === 'string') return `: ${i['command']}`;
  if (typeof i['pattern'] === 'string') return `: ${i['pattern']}`;
  return '';
}

class ClaudeRun implements AgentRun {
  sessionId = '';
  private status: RunStatus = 'running';
  private lastEventAt: number;
  private usage: TokenUsage | undefined;
  private buffer = '';
  private terminal = false;
  private exitCode: number | null | undefined;
  private exitSignal: string | null | undefined;
  private stderrTail = '';
  private readonly activity: string[] = [];
  /** Full text of the agent's last non-empty text block (its closing report). */
  private lastText = '';

  constructor(
    private readonly child: ChildLike,
    startedAt: number,
    private readonly clock: () => number,
  ) {
    this.lastEventAt = startedAt;
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.stderrTail = boundedAppend(this.stderrTail, text, MAX_STDERR_TAIL);
    });
    child.on('exit', (code, signal) => this.onExit(code, signal));
    child.on('error', () => this.markTerminal('failed', null));
  }

  poll(): RunSnapshot {
    return {
      sessionId: this.sessionId,
      status: this.status,
      lastEventAt: this.lastEventAt,
      ...(this.usage ? { usage: this.usage } : {}),
      ...(this.exitCode !== undefined ? { exitCode: this.exitCode } : {}),
      ...(this.exitSignal !== undefined ? { exitSignal: this.exitSignal } : {}),
      ...(this.stderrTail.length > 0 ? { stderrTail: this.stderrTail } : {}),
      ...(this.status === 'running' && !this.terminal
        ? {
            processAlive: true as const,
            ...(this.child.pid !== undefined ? { processPid: this.child.pid } : {}),
          }
        : {}),
      // Live stream carries only the recent tail; the full log goes to the packet.
      ...(this.activity.length > 0 ? { recentActivity: this.activity.slice(-ACTIVITY_TAIL) } : {}),
    };
  }

  activityLog(): readonly string[] {
    return [...this.activity];
  }

  finalMessage(): string {
    return this.lastText;
  }

  stop(opts?: { force?: boolean }): void {
    const signal: NodeJS.Signals = opts?.force === true ? 'SIGKILL' : 'SIGTERM';
    // Kill the whole process group (the agent may have spawned children) when we
    // have a pid; fall back to the direct child otherwise.
    const pid = this.child.pid;
    if (pid !== undefined) {
      try { process.kill(-pid, signal); } catch { this.child.kill(signal); }
    } else {
      this.child.kill(signal);
    }
    // No synchronous markTerminal — the real `exit` event drives status, so the
    // orchestrator can wait for the process to actually exit.
  }

  private onData(text: string): void {
    this.lastEventAt = this.clock();
    this.buffer += text;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length > 0) this.handleLine(line);
    }
    // Pathological newline-less line — drop it rather than OOM the daemon.
    if (this.buffer.length > MAX_STREAM_LINE_BUFFER) {
      appendActivity(this.activity, 'stream line over hard cap — dropped');
      this.buffer = '';
    }
  }

  private handleLine(line: string): void {
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      return; // ignore non-JSON noise on the stream
    }
    if (typeof event.session_id === 'string' && event.session_id.length > 0) {
      this.sessionId = event.session_id;
    }
    if (event.type === 'result') {
      if (event.usage) {
        this.usage = {
          inputTokens: event.usage.input_tokens ?? 0,
          outputTokens: event.usage.output_tokens ?? 0,
          costUsd: event.total_cost_usd ?? 0,
        };
      }
      this.markTerminal(event.is_error ? 'failed' : 'done', event.is_error ? null : 0);
    }
    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          const firstLine = block.text.split('\n').find((l) => l.trim().length > 0);
          if (firstLine) appendActivity(this.activity, firstLine);
          // Keep the FULL text of the last non-empty block — the agent's closing
          // report / a text task's whole deliverable (the activity feed above
          // keeps only its first line, which would discard the result).
          if (block.text.trim().length > 0) this.lastText = block.text;
        } else if (block.type === 'tool_use' && typeof block.name === 'string') {
          appendActivity(this.activity, `${block.name}${toolArg(block.input)}`);
        }
      }
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (signal) this.exitSignal = signal;
    if (this.terminal) {
      if (this.exitCode === undefined || this.exitCode === null) this.exitCode = code;
      return;
    }
    this.markTerminal(code === 0 && !signal ? 'done' : 'failed', code);
  }

  private markTerminal(status: RunStatus, exitCode: number | null): void {
    if (this.terminal) return;
    this.terminal = true;
    this.status = status;
    this.exitCode = exitCode;
  }
}

export class ClaudeAdapter implements AgentAdapter {
  readonly name = 'claude';
  private readonly spawn: SpawnFn;
  private readonly clock: () => number;

  constructor(private readonly opts: ClaudeAdapterOptions = {}) {
    this.spawn = opts.spawn ?? defaultSpawn;
    this.clock = opts.clock ?? Date.now;
  }

  start(input: AgentStartInput, now: number): AgentRun {
    const bin = this.opts.claudeBin ?? 'claude';
    const env = codingChildEnv({
      policy: input.executionPolicy ?? null,
      modelAuthNames: modelAuthNamesFor('anthropic'),
      extras: {
        HERCULES_SLUG: input.allocation.slug,
        HERCULES_TASK_ID: input.taskId,
        PORT: String(input.allocation.port),
      },
    }).env;
    const child = this.spawn(bin, buildClaudeArgs(input, this.opts), {
      cwd: input.workspace,
      env,
    });
    return new ClaudeRun(child, now, this.clock);
  }
}
