/**
 * Domain layer — Remote Control sessions (interactive agent chat).
 *
 * Two kinds:
 *   - free  — no task; pair-programming / explore on a repo worktree
 *   - task  — bound to a control-repo task (live activity + human turns)
 *
 * Pure types only. Persistence and process lifecycle live in sessions/.
 */
import { isValidIdentifier } from './task.js';
import type { AdapterKind } from './agents.js';
import type { TaskProposal } from './taskProposal.js';

export const SESSION_STATUSES = ['idle', 'running', 'failed', 'closed'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const SESSION_KINDS = ['free', 'task'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

/**
 * Tool permission policy for free Remote Control sessions (Claude/Grok-style).
 * Hot-switchable mid-session; autonomous tasks use a separate fail-closed policy.
 *
 *   - default     — ask for non-read tools (phone approval card)
 *   - acceptEdits — auto-allow reads + file edits; ask for shell/delete/other
 *   - bypass      — auto-allow everything (deny rules still apply upstream)
 */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'bypass'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Free-session default: edits free, shell still asks (phone-friendly). */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'acceptEdits';

export function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === 'string' && (PERMISSION_MODES as readonly string[]).includes(v);
}

/** ACP tool kind strings (and loose fallbacks). */
export type ToolKindHint =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'other';

export type PermissionDecision = 'allow' | 'deny' | 'ask';

/**
 * Decide how to handle a tool permission request under the current mode.
 * Pure — used by AcpClient and unit-tested without a process.
 */
export function decidePermission(
  mode: PermissionMode,
  toolKind: string | undefined | null,
): PermissionDecision {
  if (mode === 'bypass') return 'allow';
  const k = (toolKind ?? 'other').toLowerCase();
  if (mode === 'acceptEdits') {
    if (k === 'read' || k === 'search' || k === 'think' || k === 'fetch' || k === 'edit') {
      return 'allow';
    }
    return 'ask';
  }
  // default: auto-allow pure reads / search / think; ask for everything else
  if (k === 'read' || k === 'search' || k === 'think') return 'allow';
  return 'ask';
}

export type ChatRole = 'user' | 'assistant' | 'system';

/** File/image attached to a chat turn (stored under session attachments dir). */
export type AttachmentKind = 'image' | 'file';

export interface ChatAttachment {
  readonly id: string;
  readonly kind: AttachmentKind;
  readonly name: string;
  /** Relative path under session attachments root (safe for agent prompt). */
  readonly relPath: string;
  readonly mime: string;
  readonly bytes: number;
}

/** Structured context chip injected into a turn. */
export type MessageRefKind = 'task' | 'file' | 'pr';

export interface MessageRef {
  readonly kind: MessageRefKind;
  /** task id, repo-relative path, or PR url/number label. */
  readonly target: string;
  /** Optional short label for the chip UI. */
  readonly label?: string;
}

/**
 * In-chat navigation affordances (system lifecycle, deep links).
 * UI renders as tappable buttons — not bare “open task detail” prose.
 */
export type MessageActionKind = 'open_task' | 'open_session';

export interface MessageAction {
  readonly kind: MessageActionKind;
  /** task id or session id */
  readonly target: string;
  /** Button label; UI may default from kind + target. */
  readonly label?: string;
}

export function isMessageAction(v: unknown): v is MessageAction {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o['kind'] !== 'open_task' && o['kind'] !== 'open_session') return false;
  if (typeof o['target'] !== 'string' || !isValidIdentifier(o['target'])) return false;
  if (o['label'] !== undefined && typeof o['label'] !== 'string') return false;
  return true;
}

/**
 * Lifecycle finish lines from task-live sessions (see SessionManager.syncTaskSessionStatus).
 * Older transcripts predate `actions` — recover a jump target so the phone UI
 * always shows a button, not only prose.
 */
const FINISHED_TASK_RE =
  /Task\s+`([A-Za-z0-9._-]+)`\s+finished this turn\s*→\s*\*?\*?([A-Za-z0-9._-]+)\*?\*?/i;

export function lifecycleOpenTaskAction(
  content: string,
  fallbackTaskId?: string | null,
): MessageAction | null {
  const m = FINISHED_TASK_RE.exec(content);
  const target = m?.[1] ?? fallbackTaskId ?? null;
  if (!target || !isValidIdentifier(target)) return null;
  const state = (m?.[2] ?? '').toLowerCase();
  const label =
    state === 'review'
      ? 'Open review packet'
      : state === 'failed'
        ? 'Open failed task'
        : `Open task ${target}`;
  return { kind: 'open_task', target, label };
}

/** Attach open_task actions to finished system lines that still lack them. */
export function backfillMessageActions(
  messages: readonly ChatMessage[],
  fallbackTaskId?: string | null,
): readonly ChatMessage[] {
  let changed = false;
  const out = messages.map((msg) => {
    if (msg.role !== 'system') return msg;
    if ((msg.actions?.length ?? 0) > 0) return msg;
    if (!/finished this turn/i.test(msg.content)) return msg;
    const action = lifecycleOpenTaskAction(msg.content, fallbackTaskId);
    if (!action) return msg;
    changed = true;
    return { ...msg, actions: [action] };
  });
  return changed ? out : messages;
}

export interface ChatMessage {
  readonly id: string;
  readonly role: ChatRole;
  readonly content: string;
  /** ISO timestamp. */
  readonly at: string;
  readonly attachments?: readonly ChatAttachment[];
  readonly refs?: readonly MessageRef[];
  /** Optional jump targets (e.g. open review packet after task finishes). */
  readonly actions?: readonly MessageAction[];
}

/** Max attachments per human turn. */
export const SESSION_ATTACHMENT_MAX_COUNT = 6;
/** Max bytes per attachment (8 MiB). */
export const SESSION_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
/** Allowed image MIME types. */
export const SESSION_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);

/**
 * Build the text the agent actually sees: human prose + attachment paths + refs.
 * Pure — IO layers only place files on disk.
 */
export function formatAgentTurnText(input: {
  readonly content: string;
  readonly attachments?: readonly ChatAttachment[];
  readonly refs?: readonly MessageRef[];
}): string {
  const parts: string[] = [];
  const body = input.content.trim();
  if (body.length > 0) parts.push(body);

  if (input.refs && input.refs.length > 0) {
    parts.push('## Context references');
    for (const r of input.refs) {
      const label = r.label?.trim() || r.target;
      parts.push(`- (${r.kind}) ${label}${r.label ? ` → \`${r.target}\`` : ''}`);
    }
  }

  if (input.attachments && input.attachments.length > 0) {
    parts.push('## Attachments (on disk — use tools to read)');
    for (const a of input.attachments) {
      parts.push(`- ${a.kind}: \`${a.relPath}\` (${a.name}, ${a.mime}, ${a.bytes} bytes)`);
    }
  }

  return parts.join('\n\n');
}

/** One tool permission waiting for a human (phone card). */
export interface PendingPermission {
  readonly id: string;
  readonly title: string;
  readonly toolKind: string;
  readonly toolCallId: string | null;
  readonly detail: string | null;
  /** Available optionIds from the agent (allow-once, reject-once, …). */
  readonly options: readonly { optionId: string; name: string; kind: string }[];
  /** ISO deadline; after this the daemon auto-denies. */
  readonly deadlineAt: string;
  readonly createdAt: string;
}

/**
 * A Remote Control session. Free sessions own a worktree under id `rc-*`.
 * Task sessions mirror chat for an existing task id (messages may be ephemeral).
 */
export interface RemoteSession {
  readonly id: string;
  readonly kind: SessionKind;
  /** Set when kind === 'task'. */
  readonly taskId: string | null;
  readonly repo: string;
  readonly title: string;
  readonly status: SessionStatus;
  /** Per-session adapter override; null = daemon default for free sessions. */
  readonly adapter: AdapterKind | null;
  /** Adapter resume id after the first turn. */
  readonly agentSession: string | null;
  /** Hot-switchable tool permission policy. */
  readonly permissionMode: PermissionMode;
  /** Open permission prompts (phone must approve/deny). */
  readonly pendingPermissions: readonly PendingPermission[];
  /**
   * Agent-suggested tasks awaiting human Approve (not yet control-repo tasks).
   * Populated by parsing ```hercules-task-proposal fences in assistant replies.
   */
  readonly pendingProposals: readonly TaskProposal[];
  readonly messages: readonly ChatMessage[];
  /** Human messages waiting for the current turn to finish. */
  readonly queued: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Last error message when status === 'failed'. */
  readonly error: string | null;
  /** Task created from this chat (human-confirmed promote). */
  readonly linkedTaskId: string | null;
  /** Phone pin — stay at top of the active list. */
  readonly pinned: boolean;
  /** Soft-hide from the active list (still on disk until deleted). */
  readonly archived: boolean;
  /** Cumulative ACP turn usage for this session (absent for sessions that never reported usage). */
  readonly usage?: SessionUsage;
}

/** Cumulative token/cost usage across ACP turns that reported usage. */
export interface SessionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  /** Turns that reported usage. */
  readonly turns: number;
}

/** Fold one turn's usage into the session cumulative totals. */
export function addSessionUsage(
  prev: SessionUsage | undefined,
  turn: { inputTokens: number; outputTokens: number; costUsd: number },
): SessionUsage {
  if (!prev) {
    return {
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      costUsd: turn.costUsd,
      turns: 1,
    };
  }
  return {
    inputTokens: prev.inputTokens + turn.inputTokens,
    outputTokens: prev.outputTokens + turn.outputTokens,
    costUsd: prev.costUsd + turn.costUsd,
    turns: prev.turns + 1,
  };
}

/** Free-session ids: rc- + safe identifier chars (worktree/branch safe). */
const FREE_SESSION_PATTERN = /^rc-[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export function isValidSessionId(id: string): boolean {
  if (FREE_SESSION_PATTERN.test(id)) return true;
  // Task-bound session ids reuse the task id.
  return isValidIdentifier(id);
}

/** Short random free-session id (`rc-` + base36). */
export function newFreeSessionId(random = Math.random): string {
  const n = Math.floor(random() * 36 ** 8)
    .toString(36)
    .padStart(8, '0');
  return `rc-${n}`;
}

export function newMessageId(random = Math.random): string {
  return `m-${Math.floor(random() * 36 ** 6).toString(36)}`;
}

export function isSessionStatus(v: unknown): v is SessionStatus {
  return typeof v === 'string' && (SESSION_STATUSES as readonly string[]).includes(v);
}

/** Cap stored messages per session (phone UI + memory). */
export const SESSION_MESSAGE_CAP = 80;

/** Cap a single human message (multiline-friendly). */
export const SESSION_MESSAGE_MAX_CHARS = 8000;

/** How long a phone permission card waits before auto-deny (ms). */
export const PERMISSION_TIMEOUT_MS = 3 * 60_000;

export const PERMISSION_MODE_LABEL: Record<PermissionMode, string> = {
  default: 'Ask',
  acceptEdits: 'Edits auto',
  bypass: 'YOLO',
};
