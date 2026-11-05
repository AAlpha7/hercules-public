/**
 * Execution layer — the Codex adapter (SPEC §13.2, §16.9).
 *
 * Drives `codex exec --json` (non-interactive, JSONL events) — the Codex analog
 * of `claude -p --output-format stream-json`. Maps Codex's logical fields onto
 * the same AgentRun contract: `thread.started.thread_id` ↔ session id,
 * `turn.completed`/`turn.failed` ↔ completion, `turn.completed.usage` ↔ token
 * usage, `item.completed` agent_message ↔ finalMessage() / activity text.
 *
 * Event shape follows the codex-cli `exec --json` ThreadEvent surface
 * (item.started / item.completed with agent_message, command_execution, …).
 * Spawn + clock are injected so the parser is tested without invoking the CLI.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import type {
  AgentAdapter,
  AgentRun,
  AgentStartInput,
  RunSnapshot,
  RunStatus,
  TokenUsage,
} from '../orchestrator/adapter.js';
import type { ChildLike, SpawnFn } from './claude.js';
import { appendActivity, ACTIVITY_TAIL } from './activity.js';
import { codingChildEnv } from './policyEnv.js';
import { modelAuthNamesFor } from '../domain/repoExecutionPolicy.js';
import { boundedAppend, MAX_STDERR_TAIL, MAX_STREAM_LINE_BUFFER } from './bounded.js';

export interface CodexAdapterOptions {
  readonly spawn?: SpawnFn;
  readonly codexBin?: string;
  readonly extraArgs?: readonly string[];
  readonly model?: string;
  /** Validated at the CLI boundary; invalid values fall back conservatively. */
  readonly reasoningEffort?: string;
  readonly clock?: () => number;
}

export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';
export const DEFAULT_CODEX_REASONING_EFFORT = 'medium' as const;
export const CODEX_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

export interface CodexPolicy {
  readonly model: string;
  readonly reasoningEffort: CodexReasoningEffort;
  /** True when an invalid operator value was replaced without retaining it. */
  readonly usedConservativeFallback: boolean;
}

function validModel(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trimmed) ? trimmed : null;
}

function validReasoningEffort(value: string | undefined): CodexReasoningEffort | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  return CODEX_REASONING_EFFORTS.find((effort) => effort === normalized) ?? null;
}

/** Resolve public, non-secret Codex execution policy from daemon env. */
export function resolveCodexPolicy(
  env: Readonly<Record<string, string | undefined>> = {},
): CodexPolicy {
  const rawModel = env['HERCULES_CODEX_MODEL'];
  const rawReasoning = env['HERCULES_CODEX_REASONING_EFFORT'];
  const model = rawModel === undefined ? DEFAULT_CODEX_MODEL : validModel(rawModel);
  const reasoningEffort = rawReasoning === undefined
    ? DEFAULT_CODEX_REASONING_EFFORT
    : validReasoningEffort(rawReasoning);
  return {
    model: model ?? DEFAULT_CODEX_MODEL,
    reasoningEffort: reasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT,
    usedConservativeFallback: model === null || reasoningEffort === null,
  };
}

const defaultSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, [...args], { cwd: options.cwd, env: options.env, detached: true });

export function buildCodexArgs(input: AgentStartInput, opts: CodexAdapterOptions = {}): string[] {
  // codex exec has no stable session-resume flag in this adapter surface yet;
  // resumeSessionId is accepted on AgentStartInput but intentionally unused.
  void input.resumeSessionId;
  const model = validModel(opts.model) ?? DEFAULT_CODEX_MODEL;
  const reasoningEffort = validReasoningEffort(opts.reasoningEffort) ?? DEFAULT_CODEX_REASONING_EFFORT;
  return [
    'exec',
    '--json',
    ...(opts.extraArgs ?? []),
    '--model',
    model,
    '-c',
    `model_reasoning_effort="${reasoningEffort}"`,
    input.prompt,
  ];
}

/** One line of Codex exec --json (non-exhaustive ThreadEvent surface). */
interface CodexEvent {
  type?: string;
  thread_id?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: string;
  /** Legacy / alternate tool name fields (older CLI builds). */
  tool_name?: string;
  command?: string;
  item?: CodexItem;
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  status?: string;
  exit_code?: number | null;
  server?: string;
  tool?: string;
  query?: string;
  message?: string;
  changes?: readonly { path?: string; kind?: string }[];
}

class CodexRun implements AgentRun {
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
  /** Concatenated agent_message texts (the closing report / self-assessment). */
  private fullText = '';

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
    return this.fullText;
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
    let event: CodexEvent;
    try {
      event = JSON.parse(line) as CodexEvent;
    } catch {
      return; // non-JSON noise on the stream
    }
    if (typeof event.thread_id === 'string' && event.thread_id.length > 0) {
      this.sessionId = event.thread_id;
    }

    // Legacy flat events (older captures / alternate builds).
    if (event.type === 'tool.called' && typeof event.tool_name === 'string') {
      appendActivity(this.activity, event.tool_name);
      return;
    }
    if (event.type === 'shell.command' && typeof event.command === 'string') {
      appendActivity(this.activity, event.command);
      return;
    }

    if (event.type === 'item.started' || event.type === 'item.completed' || event.type === 'item.updated') {
      this.handleItem(event.type, event.item);
      return;
    }

    if (event.type === 'turn.completed') {
      if (event.usage) {
        this.usage = {
          inputTokens: event.usage.input_tokens ?? 0,
          outputTokens: event.usage.output_tokens ?? 0,
          costUsd: 0, // codex JSONL does not report a cost
        };
      }
      this.markTerminal('done', 0);
      return;
    }
    if (event.type === 'turn.failed') {
      this.markTerminal('failed', null);
      return;
    }
    if (event.type === 'error') {
      // Transient reconnect notices are non-fatal progress; keep running.
      const msg = typeof event.message === 'string' ? event.message : '';
      if (/^Reconnecting\.\.\./i.test(msg)) {
        appendActivity(this.activity, msg);
        return;
      }
      if (msg.length > 0) appendActivity(this.activity, `error: ${msg}`);
      this.markTerminal('failed', null);
    }
  }

  private handleItem(eventType: string, item: CodexItem | undefined): void {
    if (!item || typeof item.type !== 'string') return;
    const kind = item.type;

    if (kind === 'agent_message') {
      if (eventType === 'item.completed' && typeof item.text === 'string' && item.text.length > 0) {
        if (this.fullText.length > 0) this.fullText = boundedAppend(this.fullText, '\n\n');
        this.fullText = boundedAppend(this.fullText, item.text);
        // First non-empty line as activity breadcrumb (mirrors Grok text activity).
        const firstLine = item.text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
        if (firstLine.length > 0) {
          appendActivity(this.activity, firstLine.slice(0, 200));
        }
      }
      return;
    }

    if (kind === 'command_execution') {
      if (typeof item.command === 'string' && item.command.length > 0) {
        if (eventType === 'item.started') {
          appendActivity(this.activity, `$ ${item.command}`);
        } else if (eventType === 'item.completed') {
          const code = item.exit_code;
          const status = item.status ?? (code === 0 || code == null ? 'ok' : `exit ${code}`);
          appendActivity(this.activity, `$ ${item.command} → ${status}`);
        }
      }
      return;
    }

    if (kind === 'file_change' && eventType === 'item.completed') {
      const n = item.changes?.length ?? 0;
      if (n > 0) {
        const sample = item.changes!
          .slice(0, 3)
          .map((c) => c.path ?? '?')
          .join(', ');
        appendActivity(this.activity, `files: ${sample}${n > 3 ? ` (+${n - 3})` : ''}`);
      }
      return;
    }

    if (kind === 'mcp_tool_call') {
      const label = [item.server, item.tool].filter(Boolean).join('/');
      if (label.length > 0) {
        appendActivity(
          this.activity,
          eventType === 'item.started' ? `mcp: ${label}` : `mcp: ${label} → ${item.status ?? 'done'}`,
        );
      }
      return;
    }

    if (kind === 'web_search' && eventType === 'item.completed' && typeof item.query === 'string') {
      appendActivity(this.activity, `search: ${item.query.slice(0, 120)}`);
      return;
    }

    if (kind === 'error' && eventType === 'item.completed' && typeof item.message === 'string') {
      appendActivity(this.activity, `warn: ${item.message.slice(0, 160)}`);
    }
    // reasoning / todo_list: keep lastEventAt fresh via onData; no surface spam.
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

export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex';
  private readonly spawn: SpawnFn;
  private readonly clock: () => number;

  constructor(private readonly opts: CodexAdapterOptions = {}) {
    this.spawn = opts.spawn ?? defaultSpawn;
    this.clock = opts.clock ?? Date.now;
  }

  start(input: AgentStartInput, now: number): AgentRun {
    const bin = this.opts.codexBin ?? 'codex';
    const env = this.childEnv(input);
    const child = this.spawn(bin, buildCodexArgs(input, this.opts), {
      cwd: input.workspace,
      env,
    });
    // `codex exec` accepts additional prompt input from a piped stdin. Node's
    // default spawn keeps that pipe open, so the CLI waits forever for EOF
    // before starting the turn unless the adapter closes it explicitly.
    child.stdin?.end();
    return new CodexRun(child, now, this.clock);
  }

  private childEnv(input: AgentStartInput): NodeJS.ProcessEnv {
    return codingChildEnv({
      policy: input.executionPolicy ?? null,
      modelAuthNames: modelAuthNamesFor('openai'),
      extras: {
        HERCULES_SLUG: input.allocation.slug,
        HERCULES_TASK_ID: input.taskId,
        PORT: String(input.allocation.port),
      },
    }).env;
  }
}
