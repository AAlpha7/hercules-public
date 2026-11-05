/**
 * Persist free Remote Control sessions under the work dir so a daemon restart
 * does not erase chat history (ACP process still dies — resume is best-effort).
 */
import { mkdir, readdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  isValidSessionId,
  type ChatMessage,
  type PermissionMode,
  type RemoteSession,
  type SessionStatus,
  type SessionUsage,
} from '../domain/session.js';
import type { TaskProposal } from '../domain/taskProposal.js';
import { isAdapterKind } from '../domain/agents.js';
import { neutralizeUntrustedPacketText } from '../domain/packetNeutralize.js';

export class SessionStoreError extends Error {
  override readonly name = 'SessionStoreError';
}

interface StoredSession {
  readonly id: string;
  readonly kind: 'free' | 'task';
  readonly taskId: string | null;
  readonly repo: string;
  readonly title: string;
  readonly status: SessionStatus;
  readonly adapter: string | null;
  readonly agentSession: string | null;
  readonly permissionMode: string;
  readonly messages: readonly ChatMessage[];
  readonly queued: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error: string | null;
  /** Optional link to a task created from this session. */
  readonly linkedTaskId?: string | null;
  readonly pendingProposals?: readonly TaskProposal[];
  readonly pinned?: boolean;
  readonly archived?: boolean;
  readonly usage?: SessionUsage;
}

export class SessionStore {
  /** Per-id save chain — concurrent fire-and-forget saves must land in issue
   *  order or an older payload can overwrite a newer one on disk. */
  private readonly saveChains = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  private dir(): string {
    return join(this.root, 'rc-sessions');
  }

  private pathFor(id: string): string {
    if (!isValidSessionId(id)) throw new SessionStoreError(`unsafe session id '${id}'`);
    return join(this.dir(), `${id}.json`);
  }

  async save(session: RemoteSession & { linkedTaskId?: string | null }): Promise<void> {
    const prev = this.saveChains.get(session.id) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.saveNow(session));
    this.saveChains.set(session.id, next);
    try {
      await next;
    } finally {
      if (this.saveChains.get(session.id) === next) this.saveChains.delete(session.id);
    }
  }

  private async saveNow(
    session: RemoteSession & { linkedTaskId?: string | null },
  ): Promise<void> {
    if (session.status === 'closed') {
      await this.remove(session.id);
      return;
    }
    await mkdir(this.dir(), { recursive: true });
    const body: StoredSession = {
      id: session.id,
      kind: session.kind,
      taskId: session.taskId,
      repo: session.repo,
      title: session.title,
      // Never persist as running — process is gone after restart.
      status: session.status === 'running' ? 'idle' : session.status,
      adapter: session.adapter,
      agentSession: session.agentSession,
      permissionMode: session.permissionMode,
      messages: session.messages,
      queued: [],
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      error: session.error,
      linkedTaskId: session.linkedTaskId ?? null,
      pendingProposals: session.pendingProposals ?? [],
      pinned: session.pinned === true,
      archived: session.archived === true,
      ...(session.usage ? { usage: session.usage } : {}),
    };
    // Atomic: write-then-rename. In-place writeFile truncates first — a
    // restart mid-write left a 0-byte file and the session was lost.
    const path = this.pathFor(session.id);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(body, null, 2), 'utf8');
    await rename(tmp, path);
  }

  async remove(id: string): Promise<void> {
    try {
      await rm(this.pathFor(id), { force: true });
    } catch {
      /* ignore */
    }
  }

  async loadAll(): Promise<RemoteSession[]> {
    let names: string[];
    try {
      names = await readdir(this.dir());
    } catch {
      return [];
    }
    const out: RemoteSession[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(this.dir(), name), 'utf8');
        const s = JSON.parse(raw) as StoredSession;
        if (!isValidSessionId(s.id)) continue;
        out.push(normalizeStored(s));
      } catch {
        /* skip corrupt */
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

function normalizeStored(s: StoredSession): RemoteSession {
  const status: SessionStatus =
    s.status === 'running' || s.status === 'failed' || s.status === 'idle' || s.status === 'closed'
      ? s.status === 'running'
        ? 'idle'
        : s.status
      : 'idle';
  const permissionMode: PermissionMode = isPermissionMode(s.permissionMode)
    ? s.permissionMode
    : DEFAULT_PERMISSION_MODE;
  const adapter =
    s.adapter === null || s.adapter === undefined
      ? null
      : isAdapterKind(s.adapter)
        ? s.adapter
        : null;
  const usage = parseStoredUsage(s.usage);
  return {
    id: s.id,
    kind: s.kind === 'task' ? 'task' : 'free',
    taskId: s.taskId ?? null,
    repo: s.repo,
    title: s.title || s.id,
    status,
    adapter,
    agentSession: s.agentSession ?? null,
    permissionMode,
    pendingPermissions: [],
    pendingProposals: Array.isArray(s.pendingProposals) ? s.pendingProposals : [],
    messages: Array.isArray(s.messages) ? s.messages : [],
    queued: [],
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    error: s.error ?? null,
    linkedTaskId: s.linkedTaskId ?? null,
    pinned: s.pinned === true,
    archived: s.archived === true,
    ...(usage ? { usage } : {}),
  };
}

/** Restore usage only when all four fields are finite non-negative numbers. */
function parseStoredUsage(value: unknown): SessionUsage | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  const inputTokens = o['inputTokens'];
  const outputTokens = o['outputTokens'];
  const costUsd = o['costUsd'];
  const turns = o['turns'];
  if (
    typeof inputTokens !== 'number' ||
    !Number.isFinite(inputTokens) ||
    inputTokens < 0 ||
    typeof outputTokens !== 'number' ||
    !Number.isFinite(outputTokens) ||
    outputTokens < 0 ||
    typeof costUsd !== 'number' ||
    !Number.isFinite(costUsd) ||
    costUsd < 0 ||
    typeof turns !== 'number' ||
    !Number.isFinite(turns) ||
    turns < 0
  ) {
    return undefined;
  }
  return { inputTokens, outputTokens, costUsd, turns };
}

/** Build a task draft from recent chat turns (human-editable before create). */
export function draftTaskFromSession(session: RemoteSession): {
  title: string;
  body: string;
  repo: string;
} {
  const title =
    session.title.length > 0 && session.title !== session.id
      ? session.title.slice(0, 80)
      : `From chat ${session.id}`;

  const lines: string[] = [
    `## From Remote Control`,
    '',
    `Session \`${session.id}\` on repo \`${session.repo}\`.`,
    '',
    '## Conversation excerpt',
    '',
  ];

  const recent = session.messages.slice(-12);
  for (const m of recent) {
    if (m.role === 'system') continue;
    const who = m.role === 'user' ? 'Human' : 'Agent';
    const content = m.content.trim().slice(0, 1200);
    if (!content) continue;
    // Chat content may become the task brief before any packet exists — a
    // forged header fence here would be the only fence. Neutralize at write.
    lines.push(
      `### ${who}`,
      '',
      neutralizeUntrustedPacketText(content, {
        taskId: session.taskId,
      }),
      '',
    );
  }

  lines.push(
    '## Acceptance criteria',
    '- [ ] (mechanical) …',
    '- [ ] (reviewer) …',
    '',
  );

  return { title, body: lines.join('\n'), repo: session.repo };
}
