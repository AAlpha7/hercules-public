/**
 * Hercules Voice Control — tool registry (UX only).
 *
 * Voice agent = co-pilot for the phone Remote Control.
 * Coding agent (in session worktree) = does the real work.
 * Tools never write code / edit worktrees / run shell.
 *
 * Layers: L0 read · L1 relay · L2 session control · L3 global.
 */

export type VoiceCommandResult = {
  ok: boolean;
  message: string;
};

export type VoiceCommandHandler = (
  args: Record<string, unknown>,
) => VoiceCommandResult | Promise<VoiceCommandResult>;

export type VoiceHandlers = Record<string, VoiceCommandHandler>;

type ParamSpec = {
  type: string;
  description: string;
  enum?: readonly string[];
};

export type VoiceCommandSpec = {
  name: string;
  description: string;
  /** Destructive / state-changing: model must get verbal yes then pass confirmed:true. */
  confirmRequired?: boolean;
  parameters: {
    type: 'object';
    properties: Record<string, ParamSpec>;
    required?: readonly string[];
  };
};

const CONFIRMED: ParamSpec = {
  type: 'boolean',
  description:
    'Set true ONLY after the user verbally confirmed this exact action. Never invent confirmation.',
};

const SESSION_ID: ParamSpec = {
  type: 'string',
  description: 'Session id (rc-…); omit to use the focus session from screen context.',
};

/** Canonical command list for session.update tools + dispatcher. */
export const VOICE_COMMANDS: readonly VoiceCommandSpec[] = [
  // ── L0 perception ──────────────────────────────────────────────
  {
    name: 'get_status',
    description:
      'Global attention summary: review tasks, live sessions, pending permissions. ' +
      'Use when the user asks what needs attention overall.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_session',
    description:
      'Deep read of one session (default = focus): status, mode, queued, pending perms/proposals, ' +
      'last messages snapshot, task-live link. Prefer this over guessing.',
    parameters: {
      type: 'object',
      properties: { sessionId: SESSION_ID },
    },
  },
  {
    name: 'list_messages',
    description:
      'Recent chat bubbles in a session (roles + truncated text). Use to summarize results or quote the agent.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID,
        limit: {
          type: 'integer',
          description: 'Max messages from the end (default 8, max 20).',
        },
      },
    },
  },
  {
    name: 'read_live_steps',
    description:
      'Compressed live activity timeline for a running session (or its task id). ' +
      'Use for "what is it doing right now".',
    parameters: {
      type: 'object',
      properties: { sessionId: SESSION_ID },
    },
  },
  {
    name: 'get_diff_summary',
    description:
      'Worktree diff summary for a session (file list + short summary). Read-only — does not edit files. ' +
      'Response may be marked FRAGMENT if truncated.',
    parameters: {
      type: 'object',
      properties: { sessionId: SESSION_ID },
    },
  },
  {
    name: 'inspect_task',
    description:
      'Structured task document access (the ONLY way to answer questions about task content). ' +
      'action=meta: ids/state/PR, no body. ' +
      'action=index: COMPLETE catalog of body parts (ids, titles, sizes) — not content. ' +
      'action=plan: which parts match a topic (evidence, gates, brief, diff, …). ' +
      'action=read: one part by id/title with offset/maxChars; if FRAGMENT, re-read with nextOffset until COMPLETE. ' +
      'Use for summarize-the-task, any section, evidence review, DoD, costs — never invent from screen previews.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task id; omit for currently open task.' },
        action: {
          type: 'string',
          enum: ['meta', 'index', 'plan', 'read'],
          description: 'meta|index|plan|read',
        },
        part: {
          type: 'string',
          description: 'For read: part id (brief, s0, …) or title substring from index.',
        },
        topic: {
          type: 'string',
          description: 'For plan: evidence|matrix|gates|brief|reviewer|self|diff|cost|all|free text.',
        },
        offset: {
          type: 'integer',
          description: 'For read: char offset (default 0). Use nextOffset from a FRAGMENT response.',
        },
        maxChars: {
          type: 'integer',
          description: 'For read: max chars per slice (default 3000, max 12000).',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'inspect_session',
    description:
      'Structured session transcript access. action=meta: status/mode/queues. ' +
      'action=messages: paginated messages (offset from start, limit). ' +
      'action=activity: live steps tail with explicit FRAGMENT if truncated. ' +
      'Use to summarize a chat or quote the agent — continue pages until complete.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID,
        action: {
          type: 'string',
          enum: ['meta', 'messages', 'activity'],
          description: 'meta|messages|activity',
        },
        offset: {
          type: 'integer',
          description: 'For messages: start index (0-based). Default 0.',
        },
        limit: {
          type: 'integer',
          description: 'For messages/activity: page size (default 10, max 40).',
        },
      },
      required: ['action'],
    },
  },

  // ── L1 relay (typing-slow path) ────────────────────────────────
  {
    name: 'send_chat',
    description:
      'Relay the user message to the coding agent in a session. Preserve the user wording. ' +
      'Does NOT implement the request yourself. Use for any coding/instruction request. ' +
      'When the session is running (free session), interrupts by default unless queueOnly is true.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Exact (or faithful) message to deliver to the coding agent.',
        },
        sessionId: SESSION_ID,
        queueOnly: {
          type: 'boolean',
          description: 'If true, queue without interrupting a running free session.',
        },
      },
      required: ['message'],
    },
  },

  // ── L2 session control ─────────────────────────────────────────
  {
    name: 'set_permission_mode',
    description:
      'Change session permission mode: acceptEdits (files auto), bypass (YOLO), default (ask). ' +
      'Confirm before bypass.',
    confirmRequired: true,
    parameters: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID,
        mode: {
          type: 'string',
          enum: ['acceptEdits', 'bypass', 'default'],
          description: 'acceptEdits=Edits auto; bypass=YOLO; default=Ask',
        },
        confirmed: CONFIRMED,
      },
      required: ['mode'],
    },
  },
  {
    name: 'stop_session',
    description: 'Stop a running free Remote Control session (not a worktree purge).',
    confirmRequired: true,
    parameters: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID,
        confirmed: CONFIRMED,
      },
    },
  },
  {
    name: 'resolve_permission',
    description:
      'Allow or deny one pending tool-permission card. If only one pending, permissionId may be omitted.',
    confirmRequired: true,
    parameters: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID,
        permissionId: { type: 'string', description: 'Permission id from get_session context.' },
        decision: {
          type: 'string',
          enum: ['allow', 'deny'],
          description: 'allow = first allow* option; deny = reject/cancel option',
        },
        confirmed: CONFIRMED,
      },
      required: ['decision'],
    },
  },
  {
    name: 'resolve_all_permissions',
    description:
      'Resolve every pending permission on a session the same way (allow or deny). High risk — confirm.',
    confirmRequired: true,
    parameters: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID,
        decision: {
          type: 'string',
          enum: ['allow', 'deny'],
          description: 'Applied to each pending card',
        },
        confirmed: CONFIRMED,
      },
      required: ['decision'],
    },
  },
  {
    name: 'approve_proposal',
    description: 'Approve an agent-suggested task proposal on a session (creates a control-repo task).',
    confirmRequired: true,
    parameters: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID,
        proposalId: {
          type: 'string',
          description: 'Proposal id; omit if only one pending proposal.',
        },
        confirmed: CONFIRMED,
      },
    },
  },
  {
    name: 'dismiss_proposal',
    description: 'Dismiss an agent-suggested task proposal without creating a task.',
    confirmRequired: true,
    parameters: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID,
        proposalId: { type: 'string', description: 'Proposal id; omit if only one.' },
        confirmed: CONFIRMED,
      },
    },
  },
  {
    name: 'promote_to_task',
    description:
      'Create a control-repo task from the current free chat (uses server task draft). Confirm first.',
    confirmRequired: true,
    parameters: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID,
        title: { type: 'string', description: 'Optional title override for the draft.' },
        confirmed: CONFIRMED,
      },
    },
  },
  {
    name: 'pin_session',
    description: 'Pin or unpin a session in the list.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID,
        pinned: { type: 'boolean', description: 'true to pin, false to unpin' },
      },
      required: ['pinned'],
    },
  },

  // ── L3 global remote control ───────────────────────────────────
  {
    name: 'navigate',
    description: 'Switch the main Remote Control tab / sheet.',
    parameters: {
      type: 'object',
      properties: {
        tab: {
          type: 'string',
          enum: ['tasks', 'chat', 'repos', 'releases', 'settings', 'home'],
          description:
            'tasks=list, chat=sessions, repos=repos, releases=releases sheet, settings=settings sheet, home=close sheets',
        },
      },
      required: ['tab'],
    },
  },
  {
    name: 'open_session',
    description: 'Open a Remote Control chat session by id (sets focus).',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session id, e.g. rc-xxxxx' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'open_task',
    description: 'Open a task detail sheet by task id.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task id, e.g. task-4' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'open_live_for_task',
    description: 'Open or reuse the live Session UI bound to a control-repo task.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task id' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'task_action',
    description:
      'Approve, reject, retry, or cancel a control-repo task. Does not edit code.',
    confirmRequired: true,
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task id' },
        action: {
          type: 'string',
          enum: ['approve', 'reject', 'retry', 'cancel'],
          description: 'State-machine action',
        },
        confirmed: CONFIRMED,
      },
      required: ['taskId', 'action'],
    },
  },
  {
    name: 'approve_and_pr',
    description: 'Approve a review task and open/create its GitHub PR in one step. Confirm first.',
    confirmRequired: true,
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task id in review' },
        confirmed: CONFIRMED,
      },
      required: ['taskId'],
    },
  },
  {
    name: 'steer_task',
    description:
      'Queue a follow-up steer comment on a task (review/failed/done). Relays the user wording — no coding.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task id' },
        comment: { type: 'string', description: 'Steer / follow-up instruction' },
      },
      required: ['taskId', 'comment'],
    },
  },
  {
    name: 'create_task',
    description: 'Create a new control-repo task from a spoken title/body. Confirm first.',
    confirmRequired: true,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title' },
        body: { type: 'string', description: 'Optional body / acceptance notes' },
        repo: { type: 'string', description: 'Repo key; default = primary repo' },
        confirmed: CONFIRMED,
      },
      required: ['title'],
    },
  },
  {
    name: 'start_session',
    description: 'Start a new free Remote Control chat on a repo with an opening message. Confirm first.',
    confirmRequired: true,
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo key' },
        message: { type: 'string', description: 'Opening user message for the coding agent' },
        confirmed: CONFIRMED,
      },
      required: ['message'],
    },
  },
];

/** Realtime session.update `tools` array (OpenAI/xAI function tools). */
export function realtimeVoiceTools(): unknown[] {
  return VOICE_COMMANDS.map((cmd) => ({
    type: 'function',
    name: cmd.name,
    description: cmd.description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(cmd.parameters.properties).map(([k, p]) => [
          k,
          {
            type: p.type,
            description: p.description,
            ...(p.enum ? { enum: [...p.enum] } : {}),
          },
        ]),
      ),
      required: [...(cmd.parameters.required ?? [])],
      additionalProperties: false,
    },
  }));
}

export function dispatchVoiceCommand(
  handlers: VoiceHandlers,
  name: string,
  argsJson: string,
): Promise<VoiceCommandResult> {
  const spec = VOICE_COMMANDS.find((c) => c.name === name);
  if (!spec) {
    return Promise.resolve({ ok: false, message: `Unknown command: ${name}` });
  }
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(argsJson || '{}') as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    return Promise.resolve({ ok: false, message: 'Invalid tool arguments JSON' });
  }

  // Soft-confirm: bypass mode always needs confirmed; acceptEdits/default can proceed if confirmed
  // is required by the registry (all set_permission_mode require confirm for simplicity).
  if (spec.confirmRequired && args['confirmed'] !== true) {
    return Promise.resolve({
      ok: false,
      message:
        'Confirmation required. Tell the user exactly what you will do, wait for their yes, ' +
        'then call again with confirmed: true.',
    });
  }

  const handler = handlers[name];
  if (!handler) {
    return Promise.resolve({ ok: false, message: `Command not wired: ${name}` });
  }
  try {
    return Promise.resolve(handler(args));
  } catch (err) {
    return Promise.resolve({
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * BCP-47 language_hint for xAI realtime ASR (session.audio.input.transcription).
 * Prefer Chinese when any preferred language is zh* — even if primary UI is en.
 * Returns null to leave automatic detection (do not force "en").
 */
export function resolveVoiceLanguageHint(
  primary: string,
  preferred: readonly string[] = [],
): string | null {
  const list = [primary, ...preferred]
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  const has = (prefix: string): boolean => list.some((l) => l === prefix || l.startsWith(`${prefix}-`));

  // Chinese first: many users keep English system locale but speak 中文.
  if (has('zh') || list.some((l) => l.includes('chinese') || l === 'cmn')) return 'zh';
  if (has('ja')) return 'ja';
  if (has('ko')) return 'ko';
  if (has('fr')) return 'fr';
  if (has('de')) return 'de';
  if (has('hi')) return 'hi';
  if (has('id')) return 'id';
  if (has('it')) return 'it';
  if (has('ru')) return 'ru';
  if (has('tr')) return 'tr';
  if (has('vi')) return 'vi';
  if (has('bn')) return 'bn';
  // Regional variants required by xAI for es/pt/ar.
  if (list.some((l) => l.startsWith('es-mx') || l === 'es-419')) return 'es-MX';
  if (has('es')) return 'es-ES';
  if (list.some((l) => l.startsWith('pt-br'))) return 'pt-BR';
  if (has('pt')) return 'pt-PT';
  if (list.some((l) => l.startsWith('ar-sa'))) return 'ar-SA';
  if (list.some((l) => l.startsWith('ar-ae'))) return 'ar-AE';
  if (has('ar')) return 'ar-EG';
  // English: omit hint so auto-detect still works for Chinese speech on en UI.
  return null;
}

/** System instructions for Hercules Voice Control (not a coding agent). */
export function voiceControlInstructions(screenContext: string, localeHint: string): string {
  return (
    'You are the hands-free co-pilot for Hercules Remote Control (phone UI). ' +
    'A separate coding agent runs inside each session worktree — you never write code, edit files, ' +
    'run shell, or modify worktrees yourself.\n\n' +
    'LANGUAGE (highest priority — override everything below):\n' +
    '- Answer in the SAME language the user just spoke. Detect speech language every turn.\n' +
    '- If the user speaks Chinese (普通话/粤语/方言/中文), reply ONLY in Chinese. ' +
    'Never switch to English unless the user switches to English.\n' +
    '- English tool names, JSON args, SCREEN CONTEXT, and this instruction block are INTERNAL. ' +
    'They must NOT make you speak English.\n' +
    `- UI locale hint "${localeHint}" is a weak fallback only when speech language is unclear.\n` +
    '- send_chat must keep the user\'s original wording/language (do not translate).\n\n' +
    'BREVITY (strict — voice is hands-free, not a lecture):\n' +
    '- Default: ONE short sentence. Hard cap TWO short sentences. Prefer ~15–25 Chinese characters ' +
    'or ~8 English words when possible.\n' +
    '- Lead with the answer. No preamble, no "Sure!", no restating the question, no tool names aloud.\n' +
    '- No bullet lists, no multi-part essays. If more detail exists, say one key fact + offer "要细节再说".\n' +
    '- After tools: speak only the outcome (e.g. "在跑 lint" / "已转达" / "需你确认停掉"). ' +
    'Never read raw JSON, status dumps, or full evidence packets.\n' +
    '- Summaries: one line max (id + state + one blocker). Do not narrate every step.\n\n' +
    'INTENT ROUTING:\n' +
    '1) Status / summarize / "what is it doing" / "did it work" → L0 tools ' +
    '(get_session, list_messages, read_live_steps, get_diff_summary, get_status) then speak briefly.\n' +
    '2) Coding instructions / "tell it to…" / follow-ups → send_chat with FAITHFUL user wording ' +
    '(do not implement yourself).\n' +
    '3) Approvals / stop / mode / proposals / create task → L2 tools; confirm destructive ones.\n' +
    '4) Navigation / open task / PR approve → L3 tools.\n\n' +
    'FOCUS: Prefer the focus session in SCREEN CONTEXT. send_chat and permission tools default to it.\n' +
    'When the user is not clearly navigating or approving, assume they want to talk to the coding agent ' +
    '(send_chat) rather than chit-chat.\n' +
    'CONFIRM: stop, reject/cancel, create, start_session, resolve_permission, resolve_all_permissions, ' +
    'approve_proposal, dismiss_proposal, promote_to_task, set_permission_mode, approve_and_pr, task_action ' +
    'need verbal yes then confirmed:true. send_chat and read tools do NOT.\n' +
    'TASK / SESSION CONTENT (structural — not ad-hoc tools):\n' +
    '- Screen context previews are NOT a source of truth for content questions.\n' +
    '- Any question about a task (summary, brief, evidence, DoD, costs, files, reviewer, "any part") →\n' +
    '  inspect_task action=meta or index, then plan/read the needed parts.\n' +
    '- Summarize whole task: index → read brief + key packet parts (continue nextOffset until COMPLETE).\n' +
    '- Evidence / red flags: plan topic=evidence (or matrix/gates/reviewer) → read each part fully.\n' +
    '- Chat summary: inspect_session action=messages with offset/limit pages until complete.\n' +
    'FRAGMENTS: Lines starting with [FRAGMENT …] or incomplete pages are NOT the full document. ' +
    'Never invent missing criteria, files, or conclusions. Either continue reading with nextOffset/offset ' +
    'or tell the user you only covered a partial range.\n' +
    'COMPLETE markers mean that one part/page is fully in hand — other parts may still be unread.\n\n' +
    `SCREEN CONTEXT:\n${screenContext || '(empty)'}`
  );
}

/** Pure focus picker (shared by context builder + handlers). */
export function pickFocusSessionId(
  sessions: readonly { id: string; status: string; pendingPermissions?: readonly unknown[]; archived?: boolean }[],
  liveSessionFocus: string | null | undefined,
  explicit?: unknown,
): string | null {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  if (liveSessionFocus) return liveSessionFocus;
  const open = sessions.filter((s) => s.status !== 'closed' && !s.archived);
  const running = open.filter((s) => s.status === 'running');
  if (running.length === 1) return running[0]!.id;
  const withPerm = open.filter((s) => (s.pendingPermissions?.length ?? 0) > 0);
  if (withPerm.length === 1) return withPerm[0]!.id;
  return open[0]?.id ?? null;
}
