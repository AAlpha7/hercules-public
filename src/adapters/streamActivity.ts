/**
 * Coalesce token-level ACP streams into human-readable activity lines.
 *
 * Without this, agent_thought_chunk / agent_message_chunk arrive one character
 * at a time and flood the phone live log. Tool status updates also re-fire
 * "completed" repeatedly for the same call id.
 */
export type StreamChannel = 'think' | 'agent';

export interface StreamActivityOptions {
  /** Max chars per flushed line. Default 120. */
  readonly lineMax?: number;
  /** Idle ms before flushing a partial buffer. Default 280. */
  readonly idleMs?: number;
  /** Emit a committed activity line. */
  readonly onLine: (line: string) => void;
  /** Soft draft changed (unflushed stream); optional for live ellipsis UI. */
  readonly onDraft?: (draft: string | null) => void;
  readonly clock?: () => number;
  readonly schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearSchedule?: (id: ReturnType<typeof setTimeout>) => void;
}

export class StreamActivity {
  private readonly lineMax: number;
  private readonly idleMs: number;
  private readonly onLine: (line: string) => void;
  private readonly onDraft?: (draft: string | null) => void;
  private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearSchedule: (id: ReturnType<typeof setTimeout>) => void;

  private think = '';
  private agent = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Last status seen per toolCallId (dedupe). */
  private readonly toolStatus = new Map<string, string>();
  /** Titles for tool ids when known. */
  private readonly toolTitle = new Map<string, string>();

  constructor(opts: StreamActivityOptions) {
    this.lineMax = opts.lineMax ?? 120;
    this.idleMs = opts.idleMs ?? 280;
    this.onLine = opts.onLine;
    if (opts.onDraft) this.onDraft = opts.onDraft;
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearSchedule = opts.clearSchedule ?? ((id) => clearTimeout(id));
  }

  /** Soft live line for the phone (not yet committed to the ring). */
  draftLine(): string | null {
    if (this.agent.length > 0) return `agent · ${ellipsis(collapseWs(this.agent), this.lineMax)}`;
    if (this.think.length > 0) return `think · ${ellipsis(collapseWs(this.think), this.lineMax)}`;
    return null;
  }

  appendThought(chunk: string): void {
    if (!chunk) return;
    this.think += chunk;
    this.emitDraft();
    this.maybeFlushChannel('think', false);
    this.armIdle();
  }

  appendAgent(chunk: string): void {
    if (!chunk) return;
    this.agent += chunk;
    this.emitDraft();
    this.maybeFlushChannel('agent', false);
    this.armIdle();
  }

  /** New tool invocation — flush text first, then one clean line. */
  toolStart(title: string, toolCallId?: string | null): void {
    this.flushAll();
    const name = title.trim() || 'tool';
    if (toolCallId) this.toolTitle.set(toolCallId, name);
    this.onLine(`→ ${ellipsis(name, this.lineMax)}`);
  }

  /**
   * Tool status update. Only emits on meaningful transitions:
   * completed / failed once per id. Ignores in_progress and duplicates.
   */
  toolStatusUpdate(
    status: string,
    toolCallId?: string | null,
    title?: string | null,
  ): void {
    const st = status.toLowerCase();
    if (st === 'in_progress' || st === 'pending') return;

    const id = toolCallId?.trim() || title?.trim() || '_';
    if (title?.trim()) this.toolTitle.set(id, title.trim());

    const prev = this.toolStatus.get(id);
    if (prev === st) return;
    this.toolStatus.set(id, st);

    const label = this.toolTitle.get(id) ?? (toolCallId ? shortId(toolCallId) : 'tool');
    if (st === 'completed' || st === 'complete' || st === 'success') {
      this.flushAll();
      this.onLine(`✓ ${ellipsis(label, this.lineMax)}`);
      return;
    }
    if (st === 'failed' || st === 'error') {
      this.flushAll();
      this.onLine(`✗ ${ellipsis(label, this.lineMax)}`);
      return;
    }
    // unknown status — skip noise
  }

  /** Force-commit all buffers (tool boundary, turn end, cancel). */
  flushAll(): void {
    this.clearIdle();
    this.maybeFlushChannel('think', true);
    this.maybeFlushChannel('agent', true);
    this.emitDraft();
  }

  resetTurn(): void {
    this.flushAll();
    this.think = '';
    this.agent = '';
    this.toolStatus.clear();
    this.toolTitle.clear();
    this.emitDraft();
  }

  private armIdle(): void {
    this.clearIdle();
    this.timer = this.schedule(() => {
      this.timer = null;
      this.maybeFlushChannel('think', true);
      this.maybeFlushChannel('agent', true);
      this.emitDraft();
    }, this.idleMs);
  }

  private clearIdle(): void {
    if (this.timer !== null) {
      this.clearSchedule(this.timer);
      this.timer = null;
    }
  }

  /**
   * Flush when we have a natural break (newline / sentence) or force,
   * or when buffer exceeds lineMax (split at last space).
   */
  private maybeFlushChannel(channel: StreamChannel, force: boolean): void {
    const buf = channel === 'think' ? this.think : this.agent;
    if (buf.length === 0) return;

    const prefix = channel === 'think' ? 'think' : 'agent';

    // Prefer flush on newline
    const nl = buf.indexOf('\n');
    if (nl >= 0) {
      const head = buf.slice(0, nl);
      const rest = buf.slice(nl + 1);
      if (channel === 'think') this.think = rest;
      else this.agent = rest;
      const line = collapseWs(head);
      if (line) this.onLine(`${prefix} · ${ellipsis(line, this.lineMax)}`);
      // continue if more content
      if ((channel === 'think' ? this.think : this.agent).length > 0) {
        this.maybeFlushChannel(channel, force);
      }
      return;
    }

    // Flush at sentence boundary when long enough
    if (buf.length >= 40) {
      const m = buf.match(/^([\s\S]+?[.!?。！？…])(\s|$)/);
      if (m && m[1] && m[1].length >= 24) {
        const head = m[1];
        const rest = buf.slice(head.length);
        if (channel === 'think') this.think = rest;
        else this.agent = rest;
        this.onLine(`${prefix} · ${ellipsis(collapseWs(head), this.lineMax)}`);
        if ((channel === 'think' ? this.think : this.agent).length > 0) {
          this.maybeFlushChannel(channel, force);
        }
        return;
      }
    }

    // Hard wrap at lineMax
    if (buf.length >= this.lineMax) {
      let cut = buf.lastIndexOf(' ', this.lineMax);
      if (cut < this.lineMax * 0.4) cut = this.lineMax;
      const head = buf.slice(0, cut);
      const rest = buf.slice(cut).replace(/^\s+/, '');
      if (channel === 'think') this.think = rest;
      else this.agent = rest;
      const line = collapseWs(head);
      if (line) this.onLine(`${prefix} · ${ellipsis(line, this.lineMax)}`);
      return;
    }

    if (force) {
      const line = collapseWs(buf);
      if (channel === 'think') this.think = '';
      else this.agent = '';
      if (line) this.onLine(`${prefix} · ${ellipsis(line, this.lineMax)}`);
    }
  }

  private emitDraft(): void {
    this.onDraft?.(this.draftLine());
  }
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function ellipsis(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return id.slice(0, 8) + '…';
}
