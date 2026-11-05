/**
 * Minimal ACP (Agent Client Protocol) JSON-RPC client over stdio.
 *
 * Used for Remote Control free sessions: persistent process, multi-turn
 * session/prompt, mid-turn session/cancel, streaming session/update.
 *
 * Tool permissions are client-side and hot-switchable via {@link setPermissionMode}
 * (default / acceptEdits / bypass) — no process restart needed.
 *
 * Spec: https://agentclientprotocol.com
 * Spawn is injected so tests can drive a fake peer without launching grok.
 */
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  decidePermission,
  DEFAULT_PERMISSION_MODE,
  PERMISSION_TIMEOUT_MS,
  type PermissionMode,
  type PendingPermission,
} from '../domain/session.js';
import { StreamActivity } from './streamActivity.js';
import { codingChildEnv } from './policyEnv.js';
import {
  modelAuthNamesFor,
  type ModelAuthProvider,
} from '../domain/repoExecutionPolicy.js';

/** Hard cap on one turn's streamed draft — a runaway stream OOM'd the daemon
 *  (4GB heap, SIGABRT, 2026-07-18). No legitimate answer approaches this. */
const MAX_TURN_TEXT = 2 * 1024 * 1024;
/** Hard cap on a single buffered stdout line from the agent child. */
const MAX_STDOUT_BUFFER = 32 * 1024 * 1024;

/** Token usage for one ACP prompt turn (costUsd already converted from ticks). */
export interface AcpTurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

/**
 * Parse a `turn_completed` update's usage. Accepts camelCase (`inputTokens`,
 * `outputTokens`, `costUsd`, `costUsdTicks`) and snake_case
 * (`input_tokens`, `output_tokens`, `cost_usd`, `cost_usd_ticks`). Cost prefers a
 * finite `costUsd`, else `costUsdTicks / 1e10`. Every field is clamped to a finite,
 * non-negative number (else 0). Returns null when `usage` is not an object.
 */
export function parseAcpTurnUsage(usage: unknown): AcpTurnUsage | null {
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const o = usage as Record<string, unknown>;
  const clamp = (v: unknown): number => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0;
    return v;
  };
  const inputTokens = clamp(o['inputTokens'] ?? o['input_tokens']);
  const outputTokens = clamp(o['outputTokens'] ?? o['output_tokens']);

  const costUsdRaw = o['costUsd'] ?? o['cost_usd'];
  let costUsd: number;
  if (typeof costUsdRaw === 'number' && Number.isFinite(costUsdRaw)) {
    costUsd = costUsdRaw < 0 ? 0 : costUsdRaw;
  } else {
    const ticks = o['costUsdTicks'] ?? o['cost_usd_ticks'];
    costUsd =
      typeof ticks === 'number' && Number.isFinite(ticks) && ticks >= 0 ? ticks / 1e10 : 0;
  }

  return { inputTokens, outputTokens, costUsd };
}

export class AcpError extends Error {
  override readonly name = 'AcpError';
  constructor(
    message: string,
    readonly code?: number | string,
  ) {
    super(message);
  }
}

export type AcpSpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

/** One ACP session/update payload (shape varies by sessionUpdate type). */
export interface AcpSessionUpdate {
  readonly sessionUpdate?: string;
  readonly content?: { type?: string; text?: string } | unknown;
  readonly title?: string;
  readonly toolCallId?: string;
  readonly kind?: string;
  readonly status?: string;
  readonly messageId?: string;
  readonly [key: string]: unknown;
}

export interface AcpClientOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly spawn: AcpSpawnFn;
  /**
   * Explicit provider auth selection for the child env — never all-provider
   * inheritance. 'none' means the agent authenticates via its own HOME config
   * (e.g. ~/.grok/auth.json); names are intersected with the canonical
   * model-auth set by the filter.
   */
  readonly authProvider: ModelAuthProvider | 'none';
  /** Optional source environment; always filtered before the child is spawned. */
  readonly env?: NodeJS.ProcessEnv;
  /** Initial permission mode. Default acceptEdits. */
  readonly permissionMode?: PermissionMode;
  /** ms before unanswered phone permission auto-denies. */
  readonly permissionTimeoutMs?: number;
  /** ms for initialize / session setup. Default 30s. */
  readonly setupTimeoutMs?: number;
  /** ms for a single prompt turn. Default 30m. */
  readonly promptTimeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface OpenPermission {
  readonly rpcId: unknown;
  readonly public: PendingPermission;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly options: readonly { optionId: string; name: string; kind: string }[];
}

/**
 * One ACP connection (one child process). Create a session with {@link newSession}
 * then call {@link prompt} repeatedly.
 */
export class AcpClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private sessionId: string | null = null;
  private prompting = false;
  private permissionMode: PermissionMode;
  private readonly permissionTimeoutMs: number;
  private readonly setupTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  /** Live activity lines for the phone UI. */
  private readonly activity: string[] = [];
  /** Accumulated agent text for the current prompt turn. */
  private turnText = '';
  /** Usage from a `turn_completed` update during the current prompt, if any. */
  private turnUsage: AcpTurnUsage | null = null;
  private loopCancelIssued = false;
  private lastLoopScanLen = 0;
  /** Open permission prompts keyed by public id. */
  private readonly openPermissions = new Map<string, OpenPermission>();
  /** Session-scoped allow-always keys (toolKind:title). */
  private readonly alwaysAllow = new Set<string>();
  private permSeq = 0;
  /** Coalesces token streams + tool spam into readable lines. */
  private readonly stream: StreamActivity;

  constructor(private readonly opts: AcpClientOptions) {
    super();
    this.permissionMode = opts.permissionMode ?? DEFAULT_PERMISSION_MODE;
    this.permissionTimeoutMs = opts.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS;
    this.setupTimeoutMs = opts.setupTimeoutMs ?? 30_000;
    this.promptTimeoutMs = opts.promptTimeoutMs ?? 30 * 60_000;
    this.stream = new StreamActivity({
      onLine: (line) => this.pushActivity(line),
      onDraft: () => this.emit('activity'),
    });
  }

  get acpSessionId(): string | null {
    return this.sessionId;
  }

  get isPrompting(): boolean {
    return this.prompting;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  /** Hot-switch; applies to subsequent request_permission calls. */
  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
    this.pushActivity(`permission mode → ${mode}`);
    this.emit('permissionMode', mode);
  }

  listPendingPermissions(): readonly PendingPermission[] {
    return [...this.openPermissions.values()].map((p) => p.public);
  }

  recentActivity(limit = 40): readonly string[] {
    const lines = this.activity.slice(-limit);
    const draft = this.stream.draftLine();
    // Live draft as a trailing soft line (updates in place each poll).
    if (draft) return [...lines, `… ${draft}`];
    return lines;
  }

  /**
   * Spawn the agent, initialize, authenticate (cached_token), create session.
   */
  async connect(): Promise<{ sessionId: string }> {
    if (this.child) throw new AcpError('already connected');
    const child = this.opts.spawn(this.opts.command, [...this.opts.args], {
      cwd: this.opts.cwd,
      // Policy allowlist + the explicitly selected provider's auth names only;
      // never broad host inheritance.
      env: codingChildEnv({
        source: this.opts.env ?? process.env,
        modelAuthNames: modelAuthNamesFor(this.opts.authProvider),
      }).env,
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      const line = chunk.trim().slice(0, 200);
      if (line) this.pushActivity(`stderr: ${line}`);
    });
    child.on('exit', (code) => {
      this.closed = true;
      this.failAll(new AcpError(`agent process exited (${code ?? '?'})`));
      this.emit('exit', code);
    });
    child.on('error', (err) => {
      this.closed = true;
      this.failAll(err instanceof Error ? err : new AcpError(String(err)));
    });

    await this.request(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'hercules', title: 'Hercules Remote Control', version: '0' },
      },
      this.setupTimeoutMs,
    );

    // Grok requires auth before session/new when authMethods are advertised.
    try {
      await this.request('authenticate', { methodId: 'cached_token' }, this.setupTimeoutMs);
    } catch (err) {
      // Some agents may not need / support authenticate — continue if session/new works.
      this.pushActivity(`auth: ${(err as Error).message}`);
    }

    const result = (await this.request(
      'session/new',
      { cwd: this.opts.cwd, mcpServers: [] },
      this.setupTimeoutMs,
    )) as { sessionId?: string };

    if (!result.sessionId) throw new AcpError('session/new returned no sessionId');
    this.sessionId = result.sessionId;
    this.pushActivity(`acp session ${result.sessionId.slice(0, 8)}…`);
    return { sessionId: result.sessionId };
  }

  /**
   * Load an existing ACP session (resume after reconnect). Process must still be ours.
   */
  async loadSession(sessionId: string): Promise<void> {
    await this.request(
      'session/load',
      { sessionId, cwd: this.opts.cwd, mcpServers: [] },
      this.setupTimeoutMs,
    );
    this.sessionId = sessionId;
  }

  /**
   * Send a user prompt and wait for the turn to complete (or cancel).
   * Streams session/update via 'update' events; accumulates assistant text.
   * `usage` is present only when a `turn_completed` update with parseable usage
   * arrived during this turn.
   */
  async prompt(
    text: string,
  ): Promise<{ stopReason: string; text: string; usage?: AcpTurnUsage }> {
    if (!this.sessionId) throw new AcpError('not connected');
    if (this.prompting) throw new AcpError('prompt already in flight');
    this.prompting = true;
    this.turnText = '';
    this.turnUsage = null;
    this.loopCancelIssued = false;
    this.lastLoopScanLen = 0;
    this.stream.resetTurn();
    this.pushActivity(`you · ${text.slice(0, 100)}`);
    try {
      const result = (await this.request(
        'session/prompt',
        {
          sessionId: this.sessionId,
          prompt: [{ type: 'text', text }],
        },
        this.promptTimeoutMs,
      )) as { stopReason?: string };
      const stopReason = result.stopReason ?? 'end_turn';
      this.stream.flushAll();
      return {
        stopReason,
        text: this.turnText,
        ...(this.turnUsage ? { usage: this.turnUsage } : {}),
      };
    } finally {
      this.prompting = false;
      this.stream.flushAll();
    }
  }

  /**
   * Circuit breaker: a looping model re-emits the same phone-tool line for
   * minutes and eventually draws an API 500 (2026-07-18). Once any exact
   * <<HERCULES_TOOL …>> line appears 3 times in this turn's draft, cancel the
   * turn — the partial draft still carries the calls, the phone loop dedupes
   * and executes them, and the conversation continues.
   */
  private checkToolLoop(): void {
    if (this.loopCancelIssued || !this.prompting) return;
    // Hard size cap first: a runaway stream drove the daemon to a 4GB heap
    // OOM (SIGABRT, 2026-07-18). A 2MB draft is never a legitimate answer.
    if (this.turnText.length > MAX_TURN_TEXT) {
      this.loopCancelIssued = true;
      this.pushActivity('draft over size cap → cancel turn');
      this.cancel();
      return;
    }
    // Big drafts: throttle the full-draft regex scan (O(n) per chunk adds
    // up) — rerun only after ≥4KB of new text. Small drafts scan every chunk
    // so tight loops are caught at the third repeat.
    if (this.turnText.length > 65_536 && this.turnText.length - this.lastLoopScanLen < 4096) {
      return;
    }
    this.lastLoopScanLen = this.turnText.length;
    const lines = this.turnText.match(/<<HERCULES_TOOL [^\n]*?>>/g);
    if (!lines || lines.length < 3) return;
    const counts = new Map<string, number>();
    for (const l of lines) {
      const n = (counts.get(l) ?? 0) + 1;
      if (n >= 3) {
        this.loopCancelIssued = true;
        this.pushActivity('loop breaker: same tool batch ×3 → cancel turn');
        this.cancel();
        return;
      }
      counts.set(l, n);
    }
  }

  /** Cancel the in-flight prompt turn (ACP session/cancel). */
  cancel(): void {
    if (!this.sessionId || !this.prompting) return;
    this.notify('session/cancel', { sessionId: this.sessionId });
    this.pushActivity('cancel requested');
    // Spec: cancel open permission requests with cancelled outcome
    for (const [pid, open] of [...this.openPermissions.entries()]) {
      clearTimeout(open.timer);
      this.openPermissions.delete(pid);
      this.respond(open.rpcId, { outcome: { outcome: 'cancelled' } });
    }
    this.emit('permissions', this.listPendingPermissions());
  }

  /**
   * Resolve a phone permission card. optionId must match one offered by the agent
   * (typically allow-once / reject-once / allow-always / reject-always).
   */
  resolvePermission(permissionId: string, optionId: string): void {
    const open = this.openPermissions.get(permissionId);
    if (!open) throw new AcpError(`unknown permission '${permissionId}'`);
    clearTimeout(open.timer);
    this.openPermissions.delete(permissionId);

    const opt = open.options.find((o) => o.optionId === optionId);
    if (opt?.kind === 'allow_always' || optionId === 'allow-always') {
      this.alwaysAllow.add(alwaysKey(open.public.toolKind, open.public.title));
    }

    this.respond(open.rpcId, {
      outcome: { outcome: 'selected', optionId },
    });
    this.pushActivity(`perm ${optionId}: ${open.public.title.slice(0, 60)}`);
    this.emit('permissions', this.listPendingPermissions());
  }

  /** Kill the agent process and reject pending requests. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const open of this.openPermissions.values()) clearTimeout(open.timer);
    this.openPermissions.clear();
    this.failAll(new AcpError('client closed'));
    const child = this.child;
    if (child?.pid !== undefined) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already dead */
      }
    }
    this.child = null;
  }

  private pushActivity(line: string): void {
    const clean = line.trim().slice(0, 140);
    if (!clean) return;
    this.activity.push(clean);
    if (this.activity.length > 200) this.activity.splice(0, this.activity.length - 200);
    this.emit('activity', clean);
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length > 0) this.handleLine(line);
    }
    // A single line larger than this is not a protocol message — it's a
    // runaway child. Kill it before it OOMs the whole daemon.
    if (this.buffer.length > MAX_STDOUT_BUFFER) {
      this.pushActivity('stdout line over hard cap → closing agent');
      this.close();
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    // Response to our request
    if ('id' in msg && (msg['result'] !== undefined || msg['error'] !== undefined)) {
      const id = msg['id'];
      if (typeof id === 'number') {
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          if (msg['error']) {
            const err = msg['error'] as { message?: string; code?: number };
            pending.reject(new AcpError(err.message ?? 'ACP error', err.code));
          } else {
            pending.resolve(msg['result']);
          }
        }
      }
      // Agent-side synthetic ids (e.g. "skills-reload") — ignore
      return;
    }

    // Notification or request from agent
    const method = typeof msg['method'] === 'string' ? msg['method'] : '';
    if (!method) return;

    // Agent → client request (needs response)
    if ('id' in msg && msg['id'] !== undefined && msg['id'] !== null) {
      void this.handleAgentRequest(method, msg['params'], msg['id']);
      return;
    }

    // Notification
    // grok CLI 1.0.5 emits its extension notifications as `_x.ai/session/update`
    // (leading underscore) — turn_completed with usage arrives on that method.
    if (
      method === 'session/update' ||
      method === 'x.ai/session/update' ||
      method === '_x.ai/session/update'
    ) {
      const params = msg['params'] as
        | { sessionId?: string; update?: AcpSessionUpdate }
        | undefined;
      const update = params?.update;
      if (update) this.onSessionUpdate(update);
      return;
    }
  }

  private onSessionUpdate(update: AcpSessionUpdate): void {
    this.emit('update', update);
    const kind = update.sessionUpdate ?? '';
    if (kind === 'agent_message_chunk') {
      const text = extractText(update.content);
      if (text) {
        this.turnText += text;
        this.stream.appendAgent(text);
        this.checkToolLoop();
      }
    } else if (kind === 'agent_thought_chunk') {
      const text = extractText(update.content);
      if (text) this.stream.appendThought(text);
    } else if (kind === 'tool_call') {
      const title = typeof update.title === 'string' ? update.title : 'tool';
      const id = typeof update.toolCallId === 'string' ? update.toolCallId : null;
      this.stream.toolStart(title, id);
    } else if (kind === 'tool_call_update') {
      const status = typeof update.status === 'string' ? update.status : '';
      if (!status) return;
      const id = typeof update.toolCallId === 'string' ? update.toolCallId : null;
      const title = typeof update.title === 'string' ? update.title : null;
      this.stream.toolStatusUpdate(status, id, title);
    } else if (kind === 'turn_completed') {
      this.turnUsage = parseAcpTurnUsage(update['usage']);
    }
  }

  private async handleAgentRequest(method: string, params: unknown, id: unknown): Promise<void> {
    if (
      method === 'session/request_permission' ||
      method.endsWith('/request_permission')
    ) {
      this.handlePermissionRequest(params, id);
      return;
    }

    // We claim no fs/terminal client caps — if agent still asks, return empty/error
    if (method.startsWith('fs/') || method.startsWith('terminal/')) {
      this.respondError(id, -32601, `client capability not implemented: ${method}`);
      return;
    }

    // Unknown agent requests: empty result to avoid hanging the turn
    this.respond(id, {});
  }

  private handlePermissionRequest(params: unknown, rpcId: unknown): void {
    const p = (params ?? {}) as {
      toolCall?: {
        toolCallId?: string;
        title?: string;
        kind?: string;
        rawInput?: unknown;
        status?: string;
      };
      options?: Array<{ optionId?: string; name?: string; kind?: string }>;
    };

    const toolCall = p.toolCall ?? {};
    const toolKind = typeof toolCall.kind === 'string' ? toolCall.kind : 'other';
    const title =
      typeof toolCall.title === 'string' && toolCall.title.length > 0
        ? toolCall.title
        : `tool (${toolKind})`;
    const toolCallId = typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : null;
    const detail = summarizeRawInput(toolCall.rawInput);

    const options = (p.options ?? [])
      .filter((o) => typeof o.optionId === 'string')
      .map((o) => ({
        optionId: o.optionId as string,
        name: typeof o.name === 'string' ? o.name : (o.optionId as string),
        kind: typeof o.kind === 'string' ? o.kind : 'allow_once',
      }));

    // Fallbacks when agent sends no options
    const opts =
      options.length > 0
        ? options
        : [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ];

    const allowId =
      opts.find((o) => o.kind === 'allow_once' || o.optionId === 'allow-once')?.optionId ??
      opts.find((o) => o.kind === 'allow_always')?.optionId ??
      opts[0]!.optionId;
    const rejectId =
      opts.find((o) => o.kind === 'reject_once' || o.optionId === 'reject-once')?.optionId ??
      opts.find((o) => o.kind === 'reject_always')?.optionId ??
      opts[opts.length - 1]!.optionId;

    // Session allow-always memory
    if (this.alwaysAllow.has(alwaysKey(toolKind, title))) {
      this.respond(rpcId, { outcome: { outcome: 'selected', optionId: allowId } });
      this.pushActivity(`perm auto(always): ${title.slice(0, 60)}`);
      return;
    }

    const decision = decidePermission(this.permissionMode, toolKind);
    if (decision === 'allow') {
      this.respond(rpcId, { outcome: { outcome: 'selected', optionId: allowId } });
      this.pushActivity(`perm auto: ${title.slice(0, 60)}`);
      return;
    }
    if (decision === 'deny') {
      this.respond(rpcId, { outcome: { outcome: 'selected', optionId: rejectId } });
      this.pushActivity(`perm deny: ${title.slice(0, 60)}`);
      return;
    }

    // ask — surface to phone
    const permId = `perm-${++this.permSeq}`;
    const now = Date.now();
    const publicPerm: PendingPermission = {
      id: permId,
      title,
      toolKind,
      toolCallId,
      detail,
      options: opts,
      deadlineAt: new Date(now + this.permissionTimeoutMs).toISOString(),
      createdAt: new Date(now).toISOString(),
    };
    const timer = setTimeout(() => {
      if (!this.openPermissions.has(permId)) return;
      this.openPermissions.delete(permId);
      this.respond(rpcId, { outcome: { outcome: 'selected', optionId: rejectId } });
      this.pushActivity(`perm timeout→deny: ${title.slice(0, 60)}`);
      this.emit('permissions', this.listPendingPermissions());
    }, this.permissionTimeoutMs);

    this.openPermissions.set(permId, { rpcId, public: publicPerm, timer, options: opts });
    this.pushActivity(`perm ask: ${title.slice(0, 60)}`);
    this.emit('permission', publicPerm);
    this.emit('permissions', this.listPendingPermissions());
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed || !this.child?.stdin) {
      return Promise.reject(new AcpError('not connected'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpError(`ACP request timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      try {
        this.child!.stdin.write(msg + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new AcpError(String(err)));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.child?.stdin || this.closed) return;
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
    try {
      this.child.stdin.write(msg + '\n');
    } catch {
      /* ignore */
    }
  }

  private respond(id: unknown, result: unknown): void {
    if (!this.child?.stdin || this.closed) return;
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
    } catch {
      /* ignore */
    }
  }

  private respondError(id: unknown, code: number, message: string): void {
    if (!this.child?.stdin || this.closed) return;
    try {
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n',
      );
    } catch {
      /* ignore */
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

function extractText(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'object' && content !== null) {
    const c = content as { text?: unknown; type?: unknown };
    if (typeof c.text === 'string') return c.text;
  }
  return '';
}

function alwaysKey(toolKind: string, title: string): string {
  return `${toolKind.toLowerCase()}::${title}`;
}

function summarizeRawInput(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  try {
    const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
    return s.length > 240 ? `${s.slice(0, 240)}…` : s;
  } catch {
    return null;
  }
}
