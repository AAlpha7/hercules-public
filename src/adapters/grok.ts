/**
 * Execution layer — the Grok Build adapter.
 *
 * Drives `grok -p` headless with `--output-format streaming-json` (see Grok
 * Build user guide §14). Maps Grok's NDJSON event stream onto the same
 * AgentRun contract used by Claude/Codex:
 *
 *   - `end.sessionId`              ↔ session id
 *   - `end` / process exit 0       ↔ done
 *   - `error` / `max_turns_reached` / non-zero exit ↔ failed
 *   - streamed `text` chunks       ↔ finalMessage() (concatenated)
 *
 * Implement-class mutation is **not** a Grok built-in: H registers an isolated
 * GROK_HOME MCP server (`hercules_workspace__apply_patch` /
 * `hercules_workspace__delete_file`). Coding runs fail closed if the real shell
 * tool `run_terminal_command` (or Bash/shell aliases) appears in
 * `available_commands`.
 *
 * `spawn` and `clock` are injected so the parser is tested against synthetic
 * streams without launching the real CLI.
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
import { hintFromToolLabel } from '../domain/aliveHint.js';
import {
  grokPermissionArgs,
  grokSandboxFromPolicy,
  isCodingExecutionClass,
  resolveExecutionClass,
} from '../domain/executionClass.js';
import { findForbiddenCodingTool } from '../domain/workspaceMutation.js';
import { boundedAppend, MAX_STDERR_TAIL, MAX_STREAM_LINE_BUFFER } from './bounded.js';
import {
  defaultWorkspaceMcpServerPath,
  grokCodingChildEnv,
  grokHomeForTask,
  prepareGrokHome,
} from './grokHome.js';

export interface GrokAdapterOptions {
  readonly spawn?: SpawnFn;
  readonly grokBin?: string;
  /** Optional model id (`-m`). Leave unset to use Grok's configured default. */
  readonly model?: string;
  /** Extra CLI args appended verbatim (e.g. `--max-turns 40`). */
  readonly extraArgs?: readonly string[];
  /** ms since epoch; defaults to Date.now. */
  readonly clock?: () => number;
  /**
   * Override compiled MCP server path (tests). Default: dist sibling of this module.
   */
  readonly workspaceMcpServerPath?: string;
  /**
   * When false, skip preparing GROK_HOME (unit tests that only care about argv).
   * Default true.
   */
  readonly prepareHome?: boolean;
  /** Operator ~/.grok for auth symlink (tests). */
  readonly operatorGrokHome?: string;
}

/** Runtime security policy violation (e.g. shell tool advertised on coding run). */
export class GrokSecurityPolicyError extends Error {
  override readonly name = 'GrokSecurityPolicyError';
  constructor(
    message: string,
    readonly toolName: string,
  ) {
    super(message);
  }
}

const defaultSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, [...args], { cwd: options.cwd, env: options.env, detached: true });

const PERMISSION_EXTRA_ARG_PREFIXES = [
  '--always-approve',
  '--trust',
  '--permission-mode',
  '--allow',
  '--allowedTools',
  '--deny',
  '--disallowedTools',
  '--tools',
  '--disallowed-tools',
  '--sandbox',
  '--fs-read',
  '--fs-write',
  '--agent',
  '--agents',
  '--disable-web-search',
] as const;

/** Internal extra argv may tune effort/turns, never override the safety policy. */
function assertPolicySafeExtraArgs(extraArgs: readonly string[]): void {
  const unsafe = extraArgs.find((arg) =>
    PERMISSION_EXTRA_ARG_PREFIXES.some((prefix) => arg === prefix || arg.startsWith(`${prefix}=`)),
  );
  if (unsafe) {
    throw new Error(`Grok extraArgs must not override execution permission policy: ${unsafe}`);
  }
}

/**
 * Build the headless Grok CLI argv for a single agent turn.
 *
 * Permission policy (P0 host-op safety) — H owns argv:
 * - implement (legacy default): `dontAsk` + workspace sandbox + safe built-ins +
 *   H MCP mutation tools; shell stripped via `--disallowed-tools` + `--deny Bash`.
 * - explore / verify: same sandbox, no mutation MCP allows.
 * - host_operation / deploy: production uses the host executor; argv here is
 *   defense-in-depth only (Read/Grep + exact Bash; real shell tool name
 *   `run_terminal_command`).
 *
 * `--cwd` is passed explicitly in addition to spawn's cwd so project-root
 * discovery matches the worktree even if the process env differs.
 */
export function buildGrokArgs(input: AgentStartInput, opts: GrokAdapterOptions = {}): string[] {
  const permission = grokPermissionArgs({
    ...(input.executionClass !== undefined
      ? { executionClass: input.executionClass }
      : {}),
    ...(input.hostCommandScope !== undefined
      ? { hostCommandScope: input.hostCommandScope }
      : {}),
    ...(input.executionPolicy != null
      ? { executionPolicy: input.executionPolicy }
      : {}),
  });
  const args: string[] = [
    '-p',
    input.prompt,
    '--output-format',
    'streaming-json',
    ...permission,
    '--cwd',
    input.workspace,
  ];
  // Multi-turn resume (comment-to-steer): continue the prior headless session.
  if (input.resumeSessionId && input.resumeSessionId.length > 0) {
    args.push('--resume', input.resumeSessionId);
  }
  if (opts.model) {
    args.push('-m', opts.model);
  }
  if (opts.extraArgs) {
    assertPolicySafeExtraArgs(opts.extraArgs);
    args.push(...opts.extraArgs);
  }
  return args;
}

/** One line of Grok's streaming-json NDJSON surface (non-exhaustive). */
interface GrokEvent {
  type?: string;
  /** String chunk or structured tool payload (ACP-shaped fields often land here). */
  data?: unknown;
  message?: string;
  name?: string;
  tool?: string;
  tool_name?: string;
  toolName?: string;
  title?: string;
  command?: string;
  status?: string;
  rawInput?: unknown;
  raw_input?: unknown;
  arguments?: unknown;
  args?: unknown;
  input?: unknown;
  toolCall?: unknown;
  tool_call?: unknown;
  update?: unknown;
  stopReason?: string;
  sessionId?: string;
  requestId?: string;
  tools?: unknown;
  commands?: unknown;
  /** `end` carries the run total (grok CLI 1.0.5: input/output tokens + total_cost_usd). */
  usage?: { input_tokens?: number; output_tokens?: number };
  total_cost_usd?: number;
  // Allow ACP / future stream keys without losing them at the cast boundary.
  [key: string]: unknown;
}

/** Tool-ish event types we treat as progress + aliveHint sources. */
const TOOL_EVENT_TYPES = new Set([
  'tool',
  'tool_use',
  'tool_call',
  'tool_start',
  'tool_running',
  'tool.called',
  'function_call',
  'function_call_start',
  'shell',
  'shell.command',
  'command',
  'command_execution',
]);

class GrokRun implements AgentRun {
  sessionId = '';
  private status: RunStatus = 'running';
  private lastEventAt: number;
  /** Run-total token usage from the `end` event → cost-ledger receipt. */
  private usage: TokenUsage | undefined;
  private buffer = '';
  private terminal = false;
  private exitCode: number | null | undefined;
  private exitSignal: string | null | undefined;
  private stderrTail = '';
  private readonly activity: string[] = [];
  /** Concatenated agent text (the closing report / self-assessment). */
  private fullText = '';
  /** True once we have published a first-line activity entry for the text. */
  private textActivityPublished = false;
  /**
   * Last tool-derived worker hint (cargo / pnpm / …). Prefer this over /proc
   * when the stream surfaces tool events.
   */
  private toolAliveHint: string | null = null;
  /**
   * Last known tool identity on this run. ACP `tool_call_update` events often
   * carry only `status` (or nothing) after a titled `tool_call` — stick the
   * prior name/detail so Live activity does not regress to bare types.
   */
  private lastToolIdentity: ToolLabelIdentity | null = null;
  /** Coding runs enforce no-shell advertisement fail-closed. */
  private readonly enforceNoShell: boolean;

  constructor(
    private readonly child: ChildLike,
    startedAt: number,
    private readonly clock: () => number,
    opts: { enforceNoShell: boolean },
  ) {
    this.lastEventAt = startedAt;
    this.enforceNoShell = opts.enforceNoShell;
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
      // Stream silence during long tools is normal — do not idle-stall.
      ...(this.status === 'running' && !this.terminal
        ? {
            processAlive: true as const,
            ...(this.child.pid !== undefined ? { processPid: this.child.pid } : {}),
            // Tool stream wins over process-tree sample when present.
            ...(this.toolAliveHint ? { aliveHint: this.toolAliveHint } : {}),
          }
        : {}),
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
    const pid = this.child.pid;
    if (pid !== undefined) {
      try {
        process.kill(-pid, signal);
      } catch {
        this.child.kill(signal);
      }
    } else {
      this.child.kill(signal);
    }
    // Real `exit` event drives status so the orchestrator can wait for teardown.
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
    let event: GrokEvent;
    try {
      event = JSON.parse(line) as GrokEvent;
    } catch {
      return; // ignore non-JSON noise on the stream
    }

    const type = typeof event.type === 'string' ? event.type : '';

    // Runtime fail-closed: never continue a coding run that advertises shell.
    if (this.enforceNoShell && type === 'available_commands') {
      const candidates = collectAdvertisedTools(event);
      this.assertNoForbiddenTools(candidates, 'available_commands');
      return;
    }
    // system/init in streaming-messages-json also lists tools — same guard.
    if (this.enforceNoShell && (type === 'system' || type === 'init')) {
      const candidates = collectAdvertisedTools(event);
      if (candidates.length > 0) {
        this.assertNoForbiddenTools(candidates, type);
      }
    }

    if (TOOL_EVENT_TYPES.has(type) || /^tool[._]/i.test(type) || /^function_call/i.test(type)) {
      this.noteToolEvent(event);
      return;
    }

    switch (type) {
      case 'text':
        if (typeof event.data === 'string' && event.data.length > 0) {
          this.fullText = boundedAppend(this.fullText, event.data);
          this.maybePublishTextActivity();
        }
        break;
      case 'thought':
        // Keep lastEventAt fresh (already updated in onData) so long reasoning
        // turns don't trip stall detection. Thoughts are not surface activity.
        break;
      case 'end':
        if (typeof event.sessionId === 'string' && event.sessionId.length > 0) {
          this.sessionId = event.sessionId;
        }
        if (event.usage && typeof event.usage === 'object') {
          this.usage = {
            inputTokens: asNonNegativeNumber(event.usage.input_tokens),
            outputTokens: asNonNegativeNumber(event.usage.output_tokens),
            costUsd: asNonNegativeNumber(event.total_cost_usd),
          };
        }
        this.maybePublishTextActivity(/* force */ true);
        this.markTerminal('done', 0);
        break;
      case 'error':
        if (typeof event.message === 'string' && event.message.length > 0) {
          appendActivity(this.activity, `error: ${event.message}`);
        }
        this.markTerminal('failed', null);
        break;
      case 'max_turns_reached':
        appendActivity(this.activity, 'max turns reached');
        this.markTerminal('failed', null);
        break;
      default:
        // Non-exhaustive stream: ignore unknown types, stay running.
        break;
    }
  }

  private assertNoForbiddenTools(tools: unknown, source: string): void {
    const forbidden = findForbiddenCodingTool(tools);
    if (!forbidden) return;
    const err = new GrokSecurityPolicyError(
      `coding run advertised forbidden tool '${forbidden}' in ${source} — aborting (no shell policy)`,
      forbidden,
    );
    appendActivity(this.activity, `security: ${err.message}`);
    this.stderrTail = boundedAppend(
      this.stderrTail,
      `\n[hercules] ${err.message}\n`,
      MAX_STDERR_TAIL,
    );
    this.stop({ force: true });
    this.markTerminal('failed', null);
  }

  /** Surface tool progress for activity feed + processAlive honesty. */
  private noteToolEvent(event: GrokEvent): void {
    const resolved = resolveToolActivityLabel(
      event as Parameters<typeof resolveToolActivityLabel>[0],
      this.lastToolIdentity,
    );
    this.lastToolIdentity = resolved.prior;
    const label = resolved.label;
    if (label) {
      appendActivity(this.activity, label.length > 200 ? `${label.slice(0, 200)}…` : label);
      const hint = hintFromToolLabel(label);
      if (hint) this.toolAliveHint = hint;
    }
  }

  /**
   * Publish the first non-empty line of the assembled text once we have a
   * complete line (or force=true at end). Streaming-json emits one token per
   * event, so we wait for a newline (or the terminal end event) rather than
   * spamming the activity buffer with single characters.
   */
  private maybePublishTextActivity(force = false): void {
    if (this.textActivityPublished) return;
    const firstLine = this.fullText.split('\n').find((l) => l.trim().length > 0);
    if (!firstLine) return;
    // Wait until we know the first line is complete, unless forced at end.
    if (!force && !this.fullText.includes('\n')) return;
    appendActivity(this.activity, firstLine);
    this.textActivityPublished = true;
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (signal) this.exitSignal = signal;
    if (this.terminal) {
      // Prefer real process exit code when stream ended first.
      if (this.exitCode === undefined || this.exitCode === null) {
        this.exitCode = code;
      }
      return;
    }
    // Flush any leftover text activity before deciding the outcome.
    this.maybePublishTextActivity(/* force */ true);
    this.markTerminal(code === 0 && !signal ? 'done' : 'failed', code);
  }

  private markTerminal(status: RunStatus, exitCode: number | null): void {
    if (this.terminal) return;
    this.terminal = true;
    this.status = status;
    this.exitCode = exitCode;
  }
}

export class GrokAdapter implements AgentAdapter {
  readonly name = 'grok';
  private readonly spawn: SpawnFn;
  private readonly clock: () => number;

  constructor(private readonly opts: GrokAdapterOptions = {}) {
    this.spawn = opts.spawn ?? defaultSpawn;
    this.clock = opts.clock ?? Date.now;
  }

  start(input: AgentStartInput, now: number): AgentRun {
    const bin = this.opts.grokBin ?? 'grok';
    const klass = resolveExecutionClass({
      executionClass: input.executionClass ?? null,
    });
    const coding = isCodingExecutionClass(klass);
    // Read-only policy gets no mutation MCP server at all — `--sandbox
    // read-only` alone would still leave apply_patch/delete registered.
    const includeWorkspaceMcp =
      klass === 'implement' &&
      grokSandboxFromPolicy(klass, input.executionPolicy ?? null) !== 'read-only';

    // Provider auth for Grok is via the isolated GROK_HOME auth.json symlink,
    // not env inheritance: modelAuthNames is empty, so no provider API key
    // reaches this child. Production secrets stay filtered by policy.
    let env: NodeJS.ProcessEnv = codingChildEnv({
      policy: input.executionPolicy ?? null,
      modelAuthNames: [],
      extras: {
        HERCULES_SLUG: input.allocation.slug,
        HERCULES_TASK_ID: input.taskId,
        PORT: String(input.allocation.port),
      },
    }).env;

    if (coding && this.opts.prepareHome !== false) {
      const homeDir = grokHomeForTask(input.allocation.scratchDir, input.taskId);
      prepareGrokHome({
        homeDir,
        includeWorkspaceMcp,
        ...(this.opts.operatorGrokHome !== undefined
          ? { operatorGrokHome: this.opts.operatorGrokHome }
          : {}),
      });
      const mcpPath =
        this.opts.workspaceMcpServerPath ?? defaultWorkspaceMcpServerPath();
      env = grokCodingChildEnv({
        baseEnv: env,
        grokHome: homeDir,
        workspace: input.workspace,
        mcpServerPath: mcpPath,
        includeWorkspaceMcp,
      });
    }

    const child = this.spawn(bin, buildGrokArgs(input, this.opts), {
      cwd: input.workspace,
      env,
    });
    return new GrokRun(child, now, this.clock, { enforceNoShell: coding });
  }
}

/**
 * Collect tool/command names from stream events that advertise the surface
 * (`available_commands`, system/init). Accepts tools/commands arrays and nested data.
 */
function collectAdvertisedTools(event: GrokEvent): unknown[] {
  const out: unknown[] = [];
  const push = (v: unknown): void => {
    if (Array.isArray(v)) {
      out.push(...v);
    } else if (typeof v === 'string' && v.length > 0) {
      out.push(v);
    }
  };
  push(event.tools);
  push(event.commands);
  if (Array.isArray(event.data)) {
    push(event.data);
  } else if (event.data && typeof event.data === 'object') {
    const d = event.data as { tools?: unknown; commands?: unknown };
    push(d.tools);
    push(d.commands);
  }
  return out;
}

/** Max length of a single semantic fragment in a tool activity label. */
const TOOL_LABEL_PART_MAX = 120;

const BARE_TOOL_TYPES = new Set(['tool_call', 'tool_call_update', 'tool', 'tool_use', 'tool_start']);

/** Usage fields are trusted only as finite non-negative numbers; anything else → 0. */
function asNonNegativeNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function clipLabelPart(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= TOOL_LABEL_PART_MAX) return t;
  return `${t.slice(0, TOOL_LABEL_PART_MAX - 1)}…`;
}

/**
 * Prefer path/command-like fields from tool args (ACP rawInput, OpenAI arguments,
 * Grok data payloads). Avoid dumping large blobs.
 */
function summarizeToolArgs(raw: unknown, depth = 0): string | null {
  if (raw == null || depth > 3) return null;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return null;
    // JSON-encoded object?
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        return summarizeToolArgs(JSON.parse(t) as unknown, depth + 1);
      } catch {
        return clipLabelPart(t);
      }
    }
    return clipLabelPart(t);
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const preferKeys = [
    'command',
    'cmd',
    'path',
    'target_file',
    'file_path',
    'filePath',
    'file',
    'filename',
    'glob',
    'pattern',
    'query',
    'url',
    'old_string',
    'new_string',
  ];
  for (const k of preferKeys) {
    const s = asNonEmptyString(o[k]);
    if (s) return clipLabelPart(s);
  }
  // Nested common wrappers
  for (const k of ['input', 'arguments', 'args', 'params', 'rawInput', 'raw_input', 'data']) {
    if (k in o) {
      const inner = summarizeToolArgs(o[k], depth + 1);
      if (inner) return inner;
    }
  }
  // First short string field as last resort
  for (const v of Object.values(o)) {
    const s = asNonEmptyString(v);
    if (s && s.length <= TOOL_LABEL_PART_MAX) return clipLabelPart(s);
  }
  return null;
}

function pickToolName(event: Record<string, unknown>): string | null {
  for (const k of [
    'title',
    'name',
    'tool',
    'tool_name',
    'toolName',
    'function',
    'function_name',
    'functionName',
  ]) {
    const s = asNonEmptyString(event[k]);
    if (s && !BARE_TOOL_TYPES.has(s.toLowerCase())) return clipLabelPart(s);
  }
  const data = event['data'];
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    for (const k of ['title', 'name', 'tool', 'tool_name', 'toolName']) {
      const s = asNonEmptyString(d[k]);
      if (s && !BARE_TOOL_TYPES.has(s.toLowerCase())) return clipLabelPart(s);
    }
  }
  const toolCall = event['toolCall'] ?? event['tool_call'];
  if (toolCall && typeof toolCall === 'object' && !Array.isArray(toolCall)) {
    const tc = toolCall as Record<string, unknown>;
    for (const k of ['title', 'name', 'tool', 'kind']) {
      const s = asNonEmptyString(tc[k]);
      if (s && !BARE_TOOL_TYPES.has(s.toLowerCase())) return clipLabelPart(s);
    }
  }
  return null;
}

function pickToolStatus(event: Record<string, unknown>): string | null {
  for (const k of ['status', 'state', 'phase']) {
    const s = asNonEmptyString(event[k]);
    if (s) return clipLabelPart(s);
  }
  const data = event['data'];
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const s = asNonEmptyString((data as Record<string, unknown>)['status']);
    if (s) return clipLabelPart(s);
  }
  const update = event['update'];
  if (update && typeof update === 'object' && !Array.isArray(update)) {
    const s = asNonEmptyString((update as Record<string, unknown>)['status']);
    if (s) return clipLabelPart(s);
  }
  return null;
}

function pickToolDetail(event: Record<string, unknown>): string | null {
  for (const k of ['command', 'cmd', 'detail', 'message', 'input', 'content']) {
    if (k === 'content') {
      const c = event[k];
      if (typeof c === 'string' && c.trim()) return clipLabelPart(c);
      continue;
    }
    const s = asNonEmptyString(event[k]);
    if (s && s.length < 500) return clipLabelPart(s);
  }
  for (const k of [
    'rawInput',
    'raw_input',
    'arguments',
    'args',
    'params',
    'input',
    'data',
    'toolCall',
    'tool_call',
  ]) {
    if (!(k in event)) continue;
    const sum = summarizeToolArgs(event[k]);
    if (sum) return sum;
  }
  return null;
}

/** Per-run tool identity retained across ACP tool_call → tool_call_update. */
export interface ToolLabelIdentity {
  readonly name: string;
  readonly detail: string | null;
}

/** Status-ish tokens that are not tool names (updates often send only these). */
const TOOL_STATUS_TOKENS = new Set([
  'completed',
  'complete',
  'failed',
  'failure',
  'error',
  'success',
  'ok',
  'pending',
  'in_progress',
  'in-progress',
  'running',
  'started',
  'cancelled',
  'canceled',
  'aborted',
]);

export type ToolLabelEvent = {
  type?: string;
  data?: unknown;
  message?: string;
  name?: string;
  tool?: string;
  tool_name?: string;
  toolName?: string;
  title?: string;
  command?: string;
  status?: string;
  rawInput?: unknown;
  raw_input?: unknown;
  arguments?: unknown;
  args?: unknown;
  input?: unknown;
  toolCall?: unknown;
  tool_call?: unknown;
  update?: unknown;
  [key: string]: unknown;
};

function joinToolLabelParts(parts: readonly string[]): string {
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const p of parts) {
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(p);
  }
  return uniq.join(': ');
}

/**
 * Best-effort human label from a tool-ish stream event.
 *
 * Prefer semantic fields (title/name/command/path/status) over bare event
 * types. ACP-shaped payloads often put the useful bits under `title`,
 * `status`, `rawInput`, or nested `data` — without those, Live activity only
 * showed `tool_call` / `tool_call_update` (2026-08-07 dogfood).
 *
 * Stateless: does not consult prior identity. Prefer
 * {@link resolveToolActivityLabel} for Live activity so status-only updates
 * stay attached to the open tool.
 */
export function extractToolLabel(event: ToolLabelEvent): string | null {
  const rec = event as Record<string, unknown>;
  const parts: string[] = [];

  const name = pickToolName(rec);
  if (name) parts.push(name);

  const detail = pickToolDetail(rec);
  if (detail && detail.toLowerCase() !== (name ?? '').toLowerCase()) {
    parts.push(detail);
  }

  const status = pickToolStatus(rec);
  if (status && status.toLowerCase() !== (name ?? '').toLowerCase()) {
    if (!parts.some((p) => p.toLowerCase() === status.toLowerCase())) {
      parts.push(status);
    }
  }

  if (parts.length > 0) {
    return joinToolLabelParts(parts);
  }

  // Bare type fallback only when nothing semantic is available.
  return asNonEmptyString(event.type);
}

/**
 * Resolve a Live-activity label and the next retained tool identity.
 *
 * When the event has no tool name but a prior identity exists (typical ACP
 * `tool_call_update` with only `status` or an empty update), attach status to
 * the prior name/detail instead of emitting bare `tool_call_update` /
 * status-only lines.
 */
export function resolveToolActivityLabel(
  event: ToolLabelEvent,
  prior: ToolLabelIdentity | null,
): { label: string | null; prior: ToolLabelIdentity | null } {
  const rec = event as Record<string, unknown>;
  const name = pickToolName(rec);
  const detail = pickToolDetail(rec);
  const status = pickToolStatus(rec);
  const bareType = asNonEmptyString(event.type);

  let nextPrior: ToolLabelIdentity | null = prior;
  if (name) {
    nextPrior = {
      name,
      detail: detail ?? (prior?.name === name ? prior.detail : null),
    };
  } else if (prior && detail) {
    nextPrior = { name: prior.name, detail };
  }

  const parts: string[] = [];
  const useName = name ?? prior?.name ?? null;
  // Prefer event detail; else keep prior detail only when reusing prior name.
  const useDetail =
    detail ?? (name ? null : prior?.detail ?? null);

  if (useName) parts.push(useName);
  if (useDetail && useDetail.toLowerCase() !== (useName ?? '').toLowerCase()) {
    parts.push(useDetail);
  }
  if (status && status.toLowerCase() !== (useName ?? '').toLowerCase()) {
    if (!parts.some((p) => p.toLowerCase() === status.toLowerCase())) {
      parts.push(status);
    }
  }

  if (parts.length > 0) {
    // Status-only without any name (no prior): keep as status token.
    // With name from prior or event: always semantic.
    return { label: joinToolLabelParts(parts), prior: nextPrior };
  }

  // Nothing on the event — if prior identity exists, restate it rather than
  // bare tool_call_update (dogfood 2026-08-07 residual).
  if (prior) {
    const restated = prior.detail
      ? joinToolLabelParts([prior.name, prior.detail])
      : prior.name;
    return { label: restated, prior };
  }

  // Truly empty: bare type only when it is not a pure status token alone
  // without identity (status already handled above via pickToolStatus).
  if (bareType && !TOOL_STATUS_TOKENS.has(bareType.toLowerCase())) {
    return { label: bareType, prior: null };
  }
  return { label: bareType, prior: null };
}
