/**
 * Remote Control — free interactive agent sessions (no control-repo task).
 *
 * Preferred transport: **ACP** (Grok agent stdio) — persistent process, true
 * multi-turn session/prompt, mid-turn session/cancel. Headless AgentAdapter
 * remains as fallback when no ACP factory is wired (tests / non-grok).
 *
 * Task-bound chat queues still live on the Orchestrator.
 */
import type { AgentRun } from '../orchestrator/adapter.js';
import type { AgentRegistry } from '../orchestrator/agentRegistry.js';
import type { Workspaces } from '../isolation/worktree.js';
import type { RepoConfig, ReposConfig } from '../domain/repos.js';
import type { AdapterKind } from '../domain/agents.js';
import { isAdapterKind } from '../domain/agents.js';
import type { Workspace } from '../domain/allocation.js';
import {
  DEFAULT_PERMISSION_MODE,
  formatAgentTurnText,
  isPermissionMode,
  newFreeSessionId,
  newMessageId,
  SESSION_MESSAGE_CAP,
  SESSION_MESSAGE_MAX_CHARS,
  backfillMessageActions,
  addSessionUsage,
  type ChatAttachment,
  type ChatMessage,
  type MessageRef,
  type PermissionMode,
  type RemoteSession,
  type SessionStatus,
} from '../domain/session.js';
import { assembleChatPrompt, assembleChatContinuePrompt } from '../orchestrator/prompt.js';
import type { AcpClient, AcpTurnUsage } from '../adapters/acpClient.js';
import { draftTaskFromSession, type SessionStore } from './store.js';
import {
  extractTaskProposals,
  proposalIdFrom,
  type TaskProposal,
} from '../domain/taskProposal.js';
import type { TaskSessionBridge } from './taskBridge.js';
import { saveSessionAttachment } from './attachments.js';
import { captureSessionDiff, type SessionDiffResult } from './diff.js';
import type { Task } from '../domain/task.js';
import { isTransientAgentError } from '../domain/agentDeath.js';

/** Pause before the single automatic retry of a transient ACP prompt error. */
const ACP_RETRY_DELAY_MS = 2_000;

export class SessionError extends Error {
  override readonly name = 'SessionError';
}

/** Fired after a successful ACP turn that reported token usage. */
export interface SessionUsageEvent {
  readonly sessionId: string;
  readonly repo: string;
  /** Ledger scope: the bound task id for task sessions, else the session id. */
  readonly scopeId: string;
  /** 1-based count of turns that reported usage in this session. */
  readonly turn: number;
  readonly usage: AcpTurnUsage;
  readonly atMs: number;
}

export interface SessionManagerDeps {
  readonly agents: AgentRegistry;
  readonly workspaces: Workspaces;
  /** Latest repos.yaml (read each start so phone-added repos work). */
  readonly getRepos: () => ReposConfig | Promise<ReposConfig>;
  readonly clock: () => number;
  /** Max concurrent free agent runs (default 1 — phone pair-programming). */
  readonly maxConcurrent?: number;
  /**
   * When set, free sessions use ACP (persistent duplex) instead of headless -p.
   * Factory receives the worktree cwd + initial permission mode.
   */
  readonly createAcp?: (cwd: string, permissionMode: PermissionMode) => Promise<AcpClient>;
  /** Optional disk store so chats survive daemon restart. */
  readonly store?: SessionStore;
  /**
   * Work dir root for attachment files (`rc-sessions/<id>/files`).
   * Defaults to store root or workspaces path when omitted.
   */
  readonly workRoot?: string;
  /** Bridge for kind=task live sessions (orchestrator + actions). */
  readonly taskBridge?: TaskSessionBridge;
  /** Charge one ACP turn to the durable cost ledger (errors must not fail the turn). */
  readonly recordUsage?: (event: SessionUsageEvent) => void | Promise<void>;
}

interface LiveAcp {
  readonly kind: 'acp';
  readonly client: AcpClient;
  readonly workspace: Workspace;
  readonly repo: RepoConfig;
  /** True while session/prompt is in flight. */
  prompting: boolean;
}

interface LiveHeadless {
  readonly kind: 'headless';
  readonly run: AgentRun;
  readonly workspace: Workspace;
  readonly repo: RepoConfig;
}

type LiveFree = LiveAcp | LiveHeadless;

function trimMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= SESSION_MESSAGE_CAP) return messages;
  return messages.slice(messages.length - SESSION_MESSAGE_CAP);
}

/** Ensure lifecycle finish lines always carry open_task jump buttons. */
function withLifecycleActions(session: RemoteSession): RemoteSession {
  const taskId = session.kind === 'task' ? (session.taskId ?? session.id) : session.taskId;
  const messages = backfillMessageActions(session.messages, taskId);
  if (messages === session.messages) return session;
  return { ...session, messages };
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export class SessionManager {
  private readonly sessions = new Map<string, RemoteSession>();
  private readonly live = new Map<string, LiveFree>();
  private readonly maxConcurrent: number;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: SessionManagerDeps) {
    this.maxConcurrent = deps.maxConcurrent ?? 1;
  }

  list(): readonly RemoteSession[] {
    return [...this.sessions.values()].map(withLifecycleActions).sort((a, b) => {
      // Pinned active first, then by recency; archived sinks below active.
      const aArch = a.archived === true ? 1 : 0;
      const bArch = b.archived === true ? 1 : 0;
      if (aArch !== bArch) return aArch - bArch;
      const aPin = a.pinned === true && !a.archived ? 1 : 0;
      const bPin = b.pinned === true && !b.archived ? 1 : 0;
      if (aPin !== bPin) return bPin - aPin;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }

  get(id: string): RemoteSession | undefined {
    const s = this.sessions.get(id);
    return s ? withLifecycleActions(s) : undefined;
  }

  /** Activity lines for live free sessions + task-bridge activity. */
  activity(): Record<string, readonly string[]> {
    const out: Record<string, readonly string[]> = {};
    const now = this.deps.clock();
    for (const [id, live] of this.live) {
      if (live.kind === 'acp') {
        const a = live.client.recentActivity();
        if (a.length > 0) out[id] = a;
      } else {
        const a = live.run.poll(now).recentActivity;
        if (a !== undefined && a.length > 0) out[id] = a;
      }
    }
    const bridge = this.deps.taskBridge;
    if (bridge) {
      for (const s of this.sessions.values()) {
        if (s.kind !== 'task' || !s.taskId) continue;
        if (out[s.id]) continue;
        const a = bridge.activity(s.taskId);
        if (a.length > 0) out[s.id] = a;
      }
    }
    return out;
  }

  private workRoot(): string {
    if (this.deps.workRoot) return this.deps.workRoot;
    // SessionStore keeps files under workRoot/rc-sessions — reuse same parent if possible.
    return '/tmp/hercules-rc';
  }

  /**
   * Open (or reuse) a live session bound to a control-repo task.
   * Session id === task id so UI/SSE can correlate with orchestrator activity.
   *
   * Always re-syncs from the control-repo task + bridge so reopening after
   * leaving the chat shows current status/transcript (not a stale snapshot).
   */
  async openTaskLive(taskId: string): Promise<RemoteSession> {
    const bridge = this.deps.taskBridge;
    if (!bridge) throw new SessionError('task live sessions not configured');
    const task = await bridge.getTask(taskId);
    if (!task) throw new SessionError(`unknown task '${taskId}'`);

    const existing = this.sessions.get(taskId);
    if (existing && existing.status !== 'closed') {
      return this.syncTaskSessionStatus(existing, task, bridge, { force: true });
    }

    const now = this.deps.clock();
    const iso = toIso(now);
    const running =
      bridge.isRunning(taskId) || task.state === 'in_progress' || task.state === 'retrying';
    const session: RemoteSession = {
      id: taskId,
      kind: 'task',
      taskId,
      repo: task.repo,
      title: task.title,
      status: running ? 'running' : task.state === 'failed' ? 'failed' : 'idle',
      adapter: task.adapter,
      agentSession: task.agentSession,
      permissionMode: DEFAULT_PERMISSION_MODE,
      pendingPermissions: [],
      pendingProposals: [],
      messages: [
        {
          id: newMessageId(),
          role: 'system',
          content:
            `Live session for task \`${taskId}\` (${task.state}). ` +
            `Messages steer or queue on the task branch; Session UI shares free-chat features.`,
          at: iso,
        },
      ],
      queued: [],
      createdAt: iso,
      updatedAt: iso,
      error: null,
      linkedTaskId: taskId,
      pinned: false,
      archived: false,
    };
    return this.put(session);
  }

  /**
   * Align a task-live session with the latest task + orchestrator bridge.
   * @param force always write (SSE + updatedAt) so reopen refreshes the phone UI.
   */
  private syncTaskSessionStatus(
    session: RemoteSession,
    task: Task,
    bridge: TaskSessionBridge,
    opts?: { force?: boolean },
  ): RemoteSession {
    const running =
      bridge.isRunning(task.id) || task.state === 'in_progress' || task.state === 'retrying';
    const status: SessionStatus = running
      ? 'running'
      : task.state === 'failed'
        ? 'failed'
        : session.status === 'closed'
          ? 'closed'
          : 'idle';

    const iso = toIso(this.deps.clock());
    let messages = session.messages;
    const prev = session.status;
    // Surface lifecycle transitions so reopening isn't a silent stale transcript.
    if (prev === 'running' && status !== 'running') {
      const stateLabel = task.state === 'review' ? 'review' : task.state;
      const openLabel =
        task.state === 'review'
          ? 'Open review packet'
          : task.state === 'failed'
            ? 'Open failed task'
            : `Open task ${task.id}`;
      messages = trimMessages([
        ...messages,
        {
          id: newMessageId(),
          role: 'system',
          content:
            `Task \`${task.id}\` finished this turn → **${stateLabel}**. ` +
            `Evidence packet is on the task detail (not fully mirrored here).`,
          at: iso,
          actions: [
            {
              kind: 'open_task',
              target: task.id,
              label: openLabel,
            },
          ],
        },
      ]);
    } else if (prev !== 'running' && status === 'running' && opts?.force) {
      // Re-opened while agent is live — stamp so the UI is obviously current.
      const last = messages[messages.length - 1];
      const stamp = `Live — task \`${task.id}\` is **${task.state}** (agent running).`;
      if (!last || last.role !== 'system' || !last.content.includes('agent running')) {
        messages = trimMessages([
          ...messages,
          { id: newMessageId(), role: 'system', content: stamp, at: iso },
        ]);
      }
    } else if (opts?.force && prev === status) {
      // Soft reopen stamp (dedupe if last system line is already a refresh marker).
      const marker = `[refreshed ${iso.slice(11, 19)}Z] task state=${task.state}`;
      const last = messages[messages.length - 1];
      if (!last || last.role !== 'system' || !last.content.startsWith('[refreshed ')) {
        messages = trimMessages([
          ...messages,
          {
            id: newMessageId(),
            role: 'system',
            content: marker,
            at: iso,
          },
        ]);
      } else {
        // Replace previous refresh marker so reopen always looks new without spam growth.
        messages = trimMessages([
          ...messages.slice(0, -1),
          { id: newMessageId(), role: 'system', content: marker, at: iso },
        ]);
      }
    }

    const pendingChat = bridge.pendingChat?.(task.id) ?? [];
    const queued =
      pendingChat.length > 0
        ? [...pendingChat]
        : status === 'running'
          ? session.queued
          : [];

    const metaSame =
      status === session.status &&
      session.title === task.title &&
      session.adapter === task.adapter &&
      (task.agentSession ?? null) === (session.agentSession ?? null) &&
      messages === session.messages &&
      queued.length === session.queued.length &&
      queued.every((q, i) => q === session.queued[i]);

    if (metaSame && !opts?.force) {
      return session;
    }

    return this.put({
      ...session,
      title: task.title,
      adapter: task.adapter,
      agentSession: task.agentSession ?? session.agentSession,
      status,
      messages,
      queued,
      error: task.state === 'failed' ? session.error : null,
      updatedAt: iso,
      archived: false, // reopening surfaces the live task chat
    });
  }

  /** Persist an uploaded file onto the session (and worktree uploads when possible). */
  async attachFile(
    id: string,
    input: { name: string; mime: string; data: Buffer },
  ): Promise<{ session: RemoteSession; attachment: ChatAttachment }> {
    const session = this.sessions.get(id);
    if (!session) throw new SessionError(`unknown session '${id}'`);
    if (session.status === 'closed') throw new SessionError('session is closed');

    let workspaceDir: string | null = null;
    const live = this.live.get(id);
    if (live) workspaceDir = live.workspace.dir;
    else if (session.kind === 'task' && session.taskId && this.deps.taskBridge?.workspaceDir) {
      workspaceDir = this.deps.taskBridge.workspaceDir(session.taskId) ?? null;
    }

    try {
      const attachment = await saveSessionAttachment({
        workRoot: this.workRoot(),
        sessionId: id,
        name: input.name,
        mime: input.mime,
        data: input.data,
        workspaceDir,
      });
      // Note on transcript (not a user turn yet — composer still sends).
      return { session, attachment };
    } catch (err) {
      const msg = (err as Error).message;
      throw new SessionError(msg || 'attachment failed');
    }
  }

  /** Worktree diff for the Diff drawer. */
  async diff(id: string): Promise<SessionDiffResult> {
    const session = this.sessions.get(id);
    if (!session) throw new SessionError(`unknown session '${id}'`);
    let cwd: string | null = null;
    const live = this.live.get(id);
    if (live) cwd = live.workspace.dir;
    else if (session.kind === 'task' && session.taskId && this.deps.taskBridge?.workspaceDir) {
      cwd = this.deps.taskBridge.workspaceDir(session.taskId) ?? null;
    }
    if (!cwd) {
      return {
        available: false,
        summary: '',
        files: [],
        diff: '',
        reason: 'no worktree (start a turn or open a live task run first)',
      };
    }
    return captureSessionDiff(cwd);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  private put(s: RemoteSession): RemoteSession {
    this.sessions.set(s.id, s);
    this.notify();
    const store = this.deps.store;
    if (store) {
      void store.save(s).catch((err: unknown) => {
        console.error(`[hercules] session save ${s.id}: ${(err as Error).message}`);
      });
    }
    return s;
  }

  /** Load sessions from disk after boot (call once before serving). */
  async hydrate(): Promise<number> {
    const store = this.deps.store;
    if (!store) return 0;
    const loaded = await store.loadAll();
    for (const s of loaded) {
      if (!this.sessions.has(s.id)) {
        this.sessions.set(s.id, {
          ...s,
          status: s.status === 'closed' ? 'closed' : 'idle',
          pendingPermissions: [],
          pendingProposals: s.pendingProposals ?? [],
          queued: [],
          linkedTaskId: s.linkedTaskId ?? null,
          pinned: s.pinned === true,
          archived: s.archived === true,
        });
      }
    }
    if (loaded.length > 0) this.notify();
    return loaded.length;
  }

  /** Human-editable draft for creating a control-repo task from this chat. */
  taskDraft(id: string): { title: string; body: string; repo: string } {
    const session = this.sessions.get(id);
    if (!session) throw new SessionError(`unknown session '${id}'`);
    return draftTaskFromSession(session);
  }

  /** Record that a task was created from this session (after human confirm). */
  linkTask(id: string, taskId: string, proposalId?: string): RemoteSession {
    const session = this.sessions.get(id);
    if (!session) throw new SessionError(`unknown session '${id}'`);
    const iso = toIso(this.deps.clock());
    const note: ChatMessage = {
      id: newMessageId(),
      role: 'system',
      content: `Created task \`${taskId}\` from this chat (waiting for agent dispatch).`,
      at: iso,
    };
    const pendingProposals = proposalId
      ? session.pendingProposals.filter((p) => p.id !== proposalId)
      : session.pendingProposals;
    return this.put({
      ...session,
      linkedTaskId: taskId,
      pendingProposals,
      messages: trimMessages([...session.messages, note]),
      updatedAt: iso,
    });
  }

  /** Dismiss an agent task proposal (human reject). */
  dismissProposal(id: string, proposalId: string): RemoteSession {
    const session = this.sessions.get(id);
    if (!session) throw new SessionError(`unknown session '${id}'`);
    const pendingProposals = session.pendingProposals.filter((p) => p.id !== proposalId);
    if (pendingProposals.length === session.pendingProposals.length) {
      throw new SessionError(`unknown proposal '${proposalId}'`);
    }
    return this.put({
      ...session,
      pendingProposals,
      updatedAt: toIso(this.deps.clock()),
    });
  }

  getProposal(id: string, proposalId: string): TaskProposal {
    const session = this.sessions.get(id);
    if (!session) throw new SessionError(`unknown session '${id}'`);
    const p = session.pendingProposals.find((x) => x.id === proposalId);
    if (!p) throw new SessionError(`unknown proposal '${proposalId}'`);
    return p;
  }

  /**
   * Scan assistant text for ```hercules-task-proposal fences and queue them
   * for human Approve. Dedupes by proposal id.
   */
  private mergeProposalsFromAssistant(
    session: RemoteSession,
    assistantText: string,
    messageId: string,
  ): RemoteSession {
    const found = extractTaskProposals(assistantText);
    if (found.length === 0) return session;
    const iso = toIso(this.deps.clock());
    const existing = new Set(session.pendingProposals.map((p) => p.id));
    const added: TaskProposal[] = [];
    for (const f of found) {
      const id = proposalIdFrom(f, messageId);
      if (existing.has(id)) continue;
      existing.add(id);
      added.push({
        id,
        title: f.title,
        repo: f.repo,
        body: f.body,
        priority: f.priority,
        raw: f.raw,
        createdAt: iso,
        sourceMessageId: messageId,
      });
    }
    if (added.length === 0) return session;
    return {
      ...session,
      pendingProposals: [...session.pendingProposals, ...added].slice(-10),
      updatedAt: iso,
    };
  }

  /**
   * Start a free session: provision worktree, first agent turn (ACP or headless).
   */
  async start(input: {
    repo: string;
    message: string;
    title?: string;
    adapter?: AdapterKind | null;
    permissionMode?: PermissionMode;
  }): Promise<RemoteSession> {
    const text = input.message.trim();
    if (text.length === 0) throw new SessionError('message is required');
    if (text.length > SESSION_MESSAGE_MAX_CHARS) {
      throw new SessionError(`message too long (max ${SESSION_MESSAGE_MAX_CHARS} chars)`);
    }
    if (this.live.size >= this.maxConcurrent) {
      throw new SessionError(`free session cap reached (${this.maxConcurrent}); stop one first`);
    }

    const repos = await this.deps.getRepos();
    const repo = repos.repos[input.repo];
    if (!repo) throw new SessionError(`unknown repo '${input.repo}'`);

    const id = newFreeSessionId();
    const now = this.deps.clock();
    const iso = toIso(now);
    const userMsg: ChatMessage = {
      id: newMessageId(),
      role: 'user',
      content: text,
      at: iso,
    };
    const title =
      (input.title?.trim() || text.slice(0, 48).replace(/\s+/g, ' ')) || `Session ${id}`;

    const adapter =
      input.adapter === undefined || input.adapter === null
        ? null
        : isAdapterKind(input.adapter)
          ? input.adapter
          : null;

    const permissionMode =
      input.permissionMode !== undefined && isPermissionMode(input.permissionMode)
        ? input.permissionMode
        : DEFAULT_PERMISSION_MODE;

    // Prefer ACP for grok (or inherit when default is grok) when factory is wired.
    const resolvedKind = this.deps.agents.resolve(adapter).kind;
    const useAcp = Boolean(this.deps.createAcp) && (adapter === null || adapter === 'grok' || resolvedKind === 'grok');

    let session: RemoteSession = {
      id,
      kind: 'free',
      taskId: null,
      repo: repo.key,
      title,
      status: 'running',
      adapter,
      agentSession: null,
      permissionMode,
      pendingPermissions: [],
      pendingProposals: [],
      messages: [userMsg],
      queued: [],
      createdAt: iso,
      updatedAt: iso,
      error: null,
      linkedTaskId: null,
      pinned: false,
      archived: false,
    };
    this.put(session);

    try {
      const workspace = await this.deps.workspaces.create(repo, id);

      if (useAcp && this.deps.createAcp) {
        await this.startAcpTurn(session, workspace, repo, text);
        return this.sessions.get(id)!;
      }

      // Headless fallback
      const { adapter: agent } = this.deps.agents.resolve(adapter);
      const prompt = assembleChatPrompt({
        message: text,
        allocation: workspace.allocation,
        repoKey: repo.key,
      });
      const run = agent.start(
        {
          taskId: id,
          workspace: workspace.dir,
          prompt,
          allocation: workspace.allocation,
        },
        now,
      );
      this.live.set(id, { kind: 'headless', run, workspace, repo });
      return session;
    } catch (err) {
      session = this.put({
        ...session,
        status: 'failed',
        error: (err as Error).message,
        updatedAt: toIso(this.deps.clock()),
      });
      throw new SessionError(`failed to start session: ${(err as Error).message}`);
    }
  }

  /**
   * Send a follow-up.
   * Task sessions → orchestrator bridge (queue / steer).
   * ACP idle → same process session/prompt (true multi-turn).
   * ACP running → queue (or cancel+reprompt if interrupt).
   * Headless → previous resume behavior.
   */
  async send(
    id: string,
    message: string,
    opts?: {
      interrupt?: boolean;
      attachments?: readonly ChatAttachment[];
      refs?: readonly MessageRef[];
    },
  ): Promise<RemoteSession> {
    const text = message.trim();
    const hasMeta =
      (opts?.attachments && opts.attachments.length > 0) ||
      (opts?.refs && opts.refs.length > 0);
    if (text.length === 0 && !hasMeta) throw new SessionError('message is required');
    if (text.length > SESSION_MESSAGE_MAX_CHARS) {
      throw new SessionError(`message too long (max ${SESSION_MESSAGE_MAX_CHARS} chars)`);
    }
    const session = this.sessions.get(id);
    if (!session) throw new SessionError(`unknown session '${id}'`);
    if (session.status === 'closed') throw new SessionError('session is closed');

    const agentText = formatAgentTurnText({
      content: text,
      ...(opts?.attachments ? { attachments: opts.attachments } : {}),
      ...(opts?.refs ? { refs: opts.refs } : {}),
    });

    const now = this.deps.clock();
    const iso = toIso(now);
    const userMsg: ChatMessage = {
      id: newMessageId(),
      role: 'user',
      content: text.length > 0 ? text : agentText,
      at: iso,
      ...(opts?.attachments && opts.attachments.length > 0
        ? { attachments: opts.attachments }
        : {}),
      ...(opts?.refs && opts.refs.length > 0 ? { refs: opts.refs } : {}),
    };

    // ── Task-bound live session ───────────────────────────────────
    if (session.kind === 'task' && session.taskId) {
      return this.sendTaskBound(session, userMsg, agentText, iso);
    }

    const live = this.live.get(id);

    // ── ACP path ──────────────────────────────────────────────────
    if (live?.kind === 'acp') {
      if (live.prompting) {
        if (opts?.interrupt) {
          live.client.cancel();
          // Message will be sent after cancel settles via queue drain in runAcpPrompt finally
        }
        return this.put({
          ...session,
          messages: trimMessages([...session.messages, userMsg]),
          queued: [...session.queued, agentText],
          updatedAt: iso,
          error: null,
        });
      }
      // Idle ACP: process still alive — true multi-turn
      const withMsg = this.put({
        ...session,
        messages: trimMessages([...session.messages, userMsg]),
        status: 'running',
        updatedAt: iso,
        error: null,
      });
      void this.runAcpPrompt(id, live, agentText);
      return withMsg;
    }

    // ── Headless path ─────────────────────────────────────────────
    if (session.status === 'running' || live?.kind === 'headless') {
      return this.put({
        ...session,
        messages: trimMessages([...session.messages, userMsg]),
        queued: [...session.queued, agentText],
        updatedAt: iso,
        error: null,
      });
    }

    if (this.live.size >= this.maxConcurrent && !this.live.has(id)) {
      throw new SessionError(`free session cap reached (${this.maxConcurrent})`);
    }

    const repos = await this.deps.getRepos();
    const repo = repos.repos[session.repo];
    if (!repo) throw new SessionError(`unknown repo '${session.repo}'`);

    const withMsg = this.put({
      ...session,
      messages: trimMessages([...session.messages, userMsg]),
      status: 'running',
      updatedAt: iso,
      error: null,
    });

    try {
      // Prefer reusing ACP if we still had one — already handled above.
      // Fresh ACP reconnect for failed sessions with createAcp.
      if (this.deps.createAcp && (session.adapter === null || session.adapter === 'grok')) {
        const workspace = await this.deps.workspaces.create(repo, id);
        await this.startAcpTurn(withMsg, workspace, repo, agentText);
        return this.sessions.get(id)!;
      }

      const workspace = await this.deps.workspaces.create(repo, id);
      const { adapter: agent } = this.deps.agents.resolve(session.adapter);
      const prompt = assembleChatContinuePrompt(agentText);
      const run = agent.start(
        {
          taskId: id,
          workspace: workspace.dir,
          prompt,
          allocation: workspace.allocation,
          ...(session.agentSession ? { resumeSessionId: session.agentSession } : {}),
        },
        now,
      );
      this.live.set(id, { kind: 'headless', run, workspace, repo });
      return withMsg;
    } catch (err) {
      return this.put({
        ...withMsg,
        status: 'failed',
        error: (err as Error).message,
        updatedAt: toIso(this.deps.clock()),
      });
    }
  }

  private async sendTaskBound(
    session: RemoteSession,
    userMsg: ChatMessage,
    agentText: string,
    iso: string,
  ): Promise<RemoteSession> {
    const bridge = this.deps.taskBridge;
    if (!bridge || !session.taskId) throw new SessionError('task live sessions not configured');
    const task = await bridge.getTask(session.taskId);
    if (!task) throw new SessionError(`unknown task '${session.taskId}'`);

    let withMsg = this.put({
      ...session,
      messages: trimMessages([...session.messages, userMsg]),
      title: task.title,
      adapter: task.adapter,
      updatedAt: iso,
      error: null,
    });

    try {
      const clientMessageId = userMsg.id || newMessageId();
      const result = await bridge.deliverMessage(session.taskId, agentText, {
        clientMessageId,
      });
      const note =
        result.mode === 'queued'
          ? 'Queued for the live agent (sent when this turn ends).'
          : result.mode === 'steer'
            ? 'Steered — task re-queued for the agent.'
            : result.mode === 'duplicate'
              ? `Already delivered — ${result.note ?? 'same submission not re-queued'}.`
              : 'Pending steer stored on the task.';
      const sys: ChatMessage = {
        id: newMessageId(),
        role: 'system',
        content: note,
        at: toIso(this.deps.clock()),
      };
      const running = bridge.isRunning(session.taskId) || task.state === 'in_progress';
      withMsg = this.put({
        ...withMsg,
        messages: trimMessages([...withMsg.messages, sys]),
        queued: result.mode === 'queued' ? [...withMsg.queued, agentText] : withMsg.queued,
        status:
          running || result.mode === 'steer' || result.mode === 'pending'
            ? 'running'
            : 'idle',
        updatedAt: toIso(this.deps.clock()),
      });
      // After steer, task is todo — session can go idle until dispatch.
      if (result.mode === 'steer' || result.mode === 'pending') {
        return this.put({
          ...withMsg,
          status: 'idle',
          queued: [],
          updatedAt: toIso(this.deps.clock()),
        });
      }
      return withMsg;
    } catch (err) {
      return this.put({
        ...withMsg,
        status: 'failed',
        error: (err as Error).message,
        updatedAt: toIso(this.deps.clock()),
      });
    }
  }

  /**
   * Hot-switch permission mode for a free session (applies to next tool calls).
   */
  setPermissionMode(id: string, mode: PermissionMode): RemoteSession {
    if (!isPermissionMode(mode)) throw new SessionError(`invalid permission mode '${String(mode)}'`);
    const session = this.sessions.get(id);
    if (!session) throw new SessionError(`unknown session '${id}'`);
    if (session.status === 'closed') throw new SessionError('session is closed');
    const live = this.live.get(id);
    if (live?.kind === 'acp') live.client.setPermissionMode(mode);
    return this.put({
      ...session,
      permissionMode: mode,
      updatedAt: toIso(this.deps.clock()),
    });
  }

  /** Resolve a phone permission card (allow/deny optionId from the agent). */
  resolvePermission(id: string, permissionId: string, optionId: string): RemoteSession {
    const session = this.sessions.get(id);
    if (!session) throw new SessionError(`unknown session '${id}'`);
    const live = this.live.get(id);
    if (live?.kind !== 'acp') throw new SessionError('no live ACP session for permissions');
    const opt = optionId.trim();
    if (!opt) throw new SessionError('optionId is required');
    try {
      live.client.resolvePermission(permissionId, opt);
    } catch (err) {
      throw new SessionError((err as Error).message);
    }
    return this.syncPermissions(id);
  }

  /** Stop / cancel the live turn (keeps ACP process for more chat when possible). */
  stop(id: string): RemoteSession {
    const session = this.sessions.get(id);
    if (!session) throw new SessionError(`unknown session '${id}'`);
    const live = this.live.get(id);
    if (live?.kind === 'acp') {
      if (live.prompting) live.client.cancel();
      // Keep process + live entry so next send continues same ACP session
      return this.put({
        ...session,
        status: 'idle',
        updatedAt: toIso(this.deps.clock()),
      });
    }
    if (live?.kind === 'headless') {
      live.run.stop({ force: true });
      this.live.delete(id);
      void this.deps.workspaces.preserve(id, `hercules: free session ${id} stop`);
    }
    return this.put({
      ...session,
      status: session.status === 'closed' ? 'closed' : 'idle',
      updatedAt: toIso(this.deps.clock()),
    });
  }

  /** Pin / unpin (active list ordering). */
  setPinned(id: string, pinned: boolean): RemoteSession {
    const session = this.sessions.get(id);
    if (!session) throw new SessionError(`unknown session '${id}'`);
    return this.put({
      ...session,
      pinned,
      // Pinning an archived session re-surfaces it.
      archived: pinned ? false : session.archived,
      updatedAt: toIso(this.deps.clock()),
    });
  }

  /** Archive / unarchive (soft hide from the main list; keeps transcript on disk). */
  setArchived(id: string, archived: boolean): RemoteSession {
    const session = this.sessions.get(id);
    if (!session) throw new SessionError(`unknown session '${id}'`);
    if (archived && session.status === 'running') {
      this.stop(id);
    }
    const fresh = this.sessions.get(id) ?? session;
    return this.put({
      ...fresh,
      archived,
      pinned: archived ? false : fresh.pinned,
      updatedAt: toIso(this.deps.clock()),
    });
  }

  /**
   * Close every open session bound to a control-repo task:
   * - kind=task live (session id / taskId match)
   * - free chat with linkedTaskId
   * Used when the human deletes the task so phone Chat doesn't keep a zombie.
   */
  async closeLinkedToTask(taskId: string): Promise<readonly string[]> {
    const closed: string[] = [];
    for (const s of [...this.sessions.values()]) {
      if (s.status === 'closed') continue;
      const isTaskLive =
        s.kind === 'task' && (s.id === taskId || s.taskId === taskId);
      const isLinkedFree = s.linkedTaskId === taskId;
      if (!isTaskLive && !isLinkedFree) continue;
      try {
        await this.close(s.id);
        closed.push(s.id);
      } catch (err) {
        console.error(
          `[hercules] closeLinkedToTask ${taskId} session ${s.id}: ${(err as Error).message}`,
        );
      }
    }
    return closed;
  }

  /**
   * Close and tear down workspace + ACP process permanently (Delete).
   * Always cleans worktree/branch for free sessions — chat is gone.
   */
  async close(id: string): Promise<{ closed: string; cleaned: boolean }> {
    const session = this.sessions.get(id);
    if (!session) throw new SessionError(`unknown session '${id}'`);
    const live = this.live.get(id);
    if (live?.kind === 'acp') {
      live.client.close();
      this.live.delete(id);
    } else if (live?.kind === 'headless') {
      live.run.stop({ force: true });
      this.live.delete(id);
    }
    let cleaned = false;
    try {
      if (this.deps.workspaces.purgeTask) {
        await this.deps.workspaces.purgeTask(session.repo, id);
      } else {
        await this.deps.workspaces.remove(id);
      }
      cleaned = true;
    } catch (err) {
      console.error(`[hercules] session ${id} workspace cleanup: ${(err as Error).message}`);
      try {
        await this.deps.workspaces.remove(id);
      } catch {
        /* ignore */
      }
    }
    this.sessions.set(id, {
      ...session,
      status: 'closed',
      pendingPermissions: [],
      updatedAt: toIso(this.deps.clock()),
    });
    await this.deps.store?.remove(id);
    this.sessions.delete(id);
    this.notify();
    return { closed: id, cleaned };
  }

  /**
   * Poll live free runs — headless completion + ACP activity notify.
   * ACP prompt completion is event-driven in runAcpPrompt; tick only helps headless.
   */
  async tick(): Promise<void> {
    const now = this.deps.clock();
    // Keep task-live sessions aligned with orchestrator (status / queued / transitions).
    const bridge = this.deps.taskBridge;
    if (bridge) {
      for (const s of [...this.sessions.values()]) {
        if (s.kind !== 'task' || !s.taskId || s.status === 'closed') continue;
        try {
          const task = await bridge.getTask(s.taskId);
          if (!task) continue;
          this.syncTaskSessionStatus(s, task, bridge, { force: false });
        } catch {
          /* ignore per-session tick errors */
        }
      }
    }
    // Emit activity for ACP sessions so SSE stays warm
    for (const [id, live] of this.live) {
      if (live.kind === 'acp') {
        // Soft notify so UI picks up recentActivity
        const s = this.sessions.get(id);
        if (s && s.status === 'running') this.notify();
      }
    }

    for (const [id, live] of [...this.live.entries()]) {
      if (live.kind !== 'headless') continue;
      const snap = live.run.poll(now);
      if (snap.status === 'running') continue;

      const session = this.sessions.get(id);
      if (!session) {
        this.live.delete(id);
        continue;
      }

      const sessionId = snap.sessionId || session.agentSession || '';
      const finalText =
        snap.status === 'done'
          ? live.run.finalMessage().trim() || '(no text reply)'
          : `Agent failed${snap.status === 'failed' ? '' : ` (${snap.status})`}`;

      this.live.delete(id);
      try {
        await this.deps.workspaces.preserve(id, `hercules: free session ${id} turn`);
      } catch {
        /* ignore */
      }

      const iso = toIso(now);
      const assistant: ChatMessage = {
        id: newMessageId(),
        role: 'assistant',
        content: finalText,
        at: iso,
      };
      const nextStatus: SessionStatus = snap.status === 'done' ? 'idle' : 'failed';
      let next: RemoteSession = {
        ...session,
        status: nextStatus,
        agentSession: sessionId || session.agentSession,
        messages: trimMessages([...session.messages, assistant]),
        updatedAt: iso,
        error: snap.status === 'done' ? null : finalText,
      };
      if (nextStatus === 'idle') {
        next = this.mergeProposalsFromAssistant(next, finalText, assistant.id);
      }
      this.put(next);

      if (next.queued.length > 0 && nextStatus === 'idle') {
        const [first, ...rest] = next.queued;
        next = this.put({ ...next, queued: rest });
        if (first !== undefined) await this.continueHeadlessFromQueue(next, first);
      }
    }
  }

  // ── ACP helpers ───────────────────────────────────────────────────

  private syncPermissions(id: string): RemoteSession {
    const session = this.sessions.get(id);
    if (!session) throw new SessionError(`unknown session '${id}'`);
    const live = this.live.get(id);
    const pending =
      live?.kind === 'acp' ? [...live.client.listPendingPermissions()] : session.pendingPermissions;
    const mode = live?.kind === 'acp' ? live.client.getPermissionMode() : session.permissionMode;
    return this.put({
      ...session,
      permissionMode: mode,
      pendingPermissions: pending,
      updatedAt: toIso(this.deps.clock()),
    });
  }

  private async startAcpTurn(
    session: RemoteSession,
    workspace: Workspace,
    repo: RepoConfig,
    text: string,
  ): Promise<void> {
    const create = this.deps.createAcp;
    if (!create) throw new SessionError('ACP factory not configured');

    const client = await create(workspace.dir, session.permissionMode);
    client.setPermissionMode(session.permissionMode);
    client.on('activity', () => this.notify());
    client.on('permissions', () => {
      try {
        this.syncPermissions(session.id);
      } catch {
        /* session may be gone */
      }
    });
    client.on('permission', () => this.notify());
    client.on('exit', () => {
      const live = this.live.get(session.id);
      if (live?.kind === 'acp' && live.client === client) {
        this.live.delete(session.id);
        const s = this.sessions.get(session.id);
        if (s && s.status !== 'closed') {
          this.put({
            ...s,
            status: s.status === 'running' ? 'failed' : s.status,
            pendingPermissions: [],
            error: s.error ?? 'ACP agent process exited',
            updatedAt: toIso(this.deps.clock()),
          });
        }
      }
    });

    const live: LiveAcp = {
      kind: 'acp',
      client,
      workspace,
      repo,
      prompting: false,
    };
    this.live.set(session.id, live);
    this.put({
      ...session,
      agentSession: client.acpSessionId,
      permissionMode: client.getPermissionMode(),
      pendingPermissions: [],
      status: 'running',
      updatedAt: toIso(this.deps.clock()),
    });
    void this.runAcpPrompt(session.id, live, text);
  }

  private async runAcpPrompt(id: string, live: LiveAcp, text: string, attempt = 0): Promise<void> {
    if (live.prompting) return;
    live.prompting = true;
    const session = this.sessions.get(id);
    if (session) {
      this.put({
        ...session,
        status: 'running',
        agentSession: live.client.acpSessionId ?? session.agentSession,
        updatedAt: toIso(this.deps.clock()),
        error: null,
      });
    }

    try {
      const { stopReason, text: reply, usage } = await live.client.prompt(text);
      const iso = toIso(this.deps.clock());
      const s = this.sessions.get(id);
      if (!s || s.status === 'closed') return;

      const cancelled = stopReason === 'cancelled';
      const content =
        reply.trim() ||
        (cancelled ? '(cancelled)' : '(no text reply)');
      const assistant: ChatMessage = {
        id: newMessageId(),
        role: 'assistant',
        content,
        at: iso,
      };
      let next: RemoteSession = {
        ...s,
        status: 'idle',
        agentSession: live.client.acpSessionId ?? s.agentSession,
        messages: trimMessages([...s.messages, assistant]),
        updatedAt: iso,
        error: null,
      };
      if (usage) {
        const sessionUsage = addSessionUsage(s.usage, usage);
        next = { ...next, usage: sessionUsage };
        const record = this.deps.recordUsage;
        if (record) {
          try {
            await record({
              sessionId: s.id,
              repo: s.repo,
              scopeId: s.taskId ?? s.id,
              turn: sessionUsage.turns,
              usage,
              atMs: this.deps.clock(),
            });
          } catch (err) {
            console.error(
              `[hercules] session usage record failed: ${(err as Error).message}`,
            );
          }
        }
      }
      next = this.mergeProposalsFromAssistant(next, content, assistant.id);
      this.put(next);

      // Drain queue on same ACP process (true multi-turn, no respawn)
      while (next.queued.length > 0 && !live.client.isClosed) {
        const [first, ...rest] = next.queued;
        next = this.put({ ...next, queued: rest, status: 'running' });
        if (first === undefined) break;
        live.prompting = false;
        await this.runAcpPrompt(id, live, first);
        next = this.sessions.get(id) ?? next;
        if (next.status !== 'idle') break;
      }
    } catch (err) {
      const message = (err as Error).message;
      // One automatic retry on transient agent errors — a single xAI 500
      // used to kill the whole turn and strand the conversation (2026-07-18).
      // Classification lives in domain/agentDeath (shared with task adapter path).
      if (
        attempt === 0 &&
        isTransientAgentError(message) &&
        !live.client.isClosed
      ) {
        live.prompting = false;
        await new Promise((r) => setTimeout(r, ACP_RETRY_DELAY_MS));
        const still = this.sessions.get(id);
        if (still && still.status !== 'closed') {
          await this.runAcpPrompt(id, live, text, 1);
        }
        return;
      }
      const iso = toIso(this.deps.clock());
      const s = this.sessions.get(id);
      if (!s || s.status === 'closed') return;
      this.put({
        ...s,
        status: 'failed',
        error: message,
        updatedAt: iso,
        messages: trimMessages([
          ...s.messages,
          {
            id: newMessageId(),
            role: 'system',
            content: `Error: ${message}`,
            at: iso,
          },
        ]),
      });
    } finally {
      live.prompting = false;
    }
  }

  private async continueHeadlessFromQueue(session: RemoteSession, text: string): Promise<void> {
    if (this.live.size >= this.maxConcurrent) return;
    const repos = await this.deps.getRepos();
    const repo = repos.repos[session.repo];
    if (!repo) return;
    const now = this.deps.clock();
    try {
      const workspace = await this.deps.workspaces.create(repo, session.id);
      const { adapter: agent } = this.deps.agents.resolve(session.adapter);
      const run = agent.start(
        {
          taskId: session.id,
          workspace: workspace.dir,
          prompt: assembleChatContinuePrompt(text),
          allocation: workspace.allocation,
          ...(session.agentSession ? { resumeSessionId: session.agentSession } : {}),
        },
        now,
      );
      this.live.set(session.id, { kind: 'headless', run, workspace, repo });
      this.put({
        ...session,
        status: 'running',
        updatedAt: toIso(now),
        error: null,
      });
    } catch (err) {
      this.put({
        ...session,
        status: 'failed',
        error: (err as Error).message,
        updatedAt: toIso(this.deps.clock()),
      });
    }
  }
}
