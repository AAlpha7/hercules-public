/**
 * Domain — execution-class contract for task host-operation safety (P0).
 *
 * Ordinary coding tasks (explore / implement / verify, and legacy tasks that
 * omit the field) may run unattended in the worktree, but **must not**
 * authorize host package/service mutations. Host-mutating classes
 * (`host_operation`, `deploy`) stay ineligible for autonomous dispatch until
 * a human approval record includes a **bounded named command scope**.
 *
 * Pure: no IO. Adapter argv and scheduling consume these helpers.
 */

import type {
  EffectiveRepoExecutionPolicy,
  SandboxMode,
} from './repoExecutionPolicy.js';

/** Front-matter `execution_class` vocabulary. */
export const EXECUTION_CLASSES = [
  'explore',
  'implement',
  'verify',
  'host_operation',
  'deploy',
] as const;

export type ExecutionClass = (typeof EXECUTION_CLASSES)[number];

/** Classes that mutate the host (package/service/deploy). Need human scope. */
export const HOST_MUTATING_EXECUTION_CLASSES = ['host_operation', 'deploy'] as const;

export type HostMutatingExecutionClass = (typeof HOST_MUTATING_EXECUTION_CLASSES)[number];

/** Coding / analysis classes — worktree work only. */
export const CODING_EXECUTION_CLASSES = ['explore', 'implement', 'verify'] as const;

export type CodingExecutionClass = (typeof CODING_EXECUTION_CLASSES)[number];

/**
 * Legacy default when front matter omits `execution_class`.
 * Conservatively treats ordinary tasks as implement (coding).
 */
export const DEFAULT_EXECUTION_CLASS: ExecutionClass = 'implement';

/** Max named commands in one human host-op approval. */
export const MAX_HOST_COMMAND_SCOPE = 16;

/** Max characters per named command. */
export const MAX_HOST_COMMAND_LEN = 256;

/** Body heading for human host-op approval audit. */
export const HOST_OP_APPROVAL_HEADING = '## Host operation approval';

/** Body / packet heading for the completion receipt. */
export const HOST_OP_RECEIPT_HEADING = '## Host operation receipt';

export function isExecutionClass(value: unknown): value is ExecutionClass {
  return (
    typeof value === 'string' &&
    (EXECUTION_CLASSES as readonly string[]).includes(value.trim().toLowerCase())
  );
}

/**
 * Parse a raw front-matter / API value.
 * Unknown / empty → null (caller applies {@link DEFAULT_EXECUTION_CLASS}).
 */
export function parseExecutionClass(raw: unknown): ExecutionClass | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (v.length === 0) return null;
  if (isExecutionClass(v)) return v;
  return null;
}

/** Resolve effective class; legacy / missing → implement. */
export function resolveExecutionClass(task: {
  readonly executionClass?: ExecutionClass | null;
}): ExecutionClass {
  return task.executionClass ?? DEFAULT_EXECUTION_CLASS;
}

export function isHostMutatingClass(klass: ExecutionClass): boolean {
  return (HOST_MUTATING_EXECUTION_CLASSES as readonly string[]).includes(klass);
}

export function isCodingExecutionClass(klass: ExecutionClass): boolean {
  return (CODING_EXECUTION_CLASSES as readonly string[]).includes(klass);
}

/**
 * True when scheduling may dispatch this task w.r.t. host-op policy.
 * Coding classes always pass. host_operation / deploy need a human approval
 * record with a non-empty bounded command scope.
 */
export function isAutonomousHostEligible(task: {
  readonly executionClass?: ExecutionClass | null;
  readonly hostCommandScope?: readonly string[] | null;
  readonly hostApprovedAt?: string | null;
}): boolean {
  const klass = resolveExecutionClass(task);
  if (!isHostMutatingClass(klass)) return true;
  const scope = task.hostCommandScope;
  if (!scope || scope.length === 0) return false;
  const at = task.hostApprovedAt?.trim() ?? '';
  if (!isIsoTimestamp(at)) return false;
  return validateHostCommandScope(scope).ok;
}

export type HostCommandScopeValidation =
  | { readonly ok: true; readonly scope: readonly string[] }
  | { readonly ok: false; readonly reason: string };

const SHELL_METACHARACTERS = "\n\r;&|`$<>{}[]()*?'\"\\";

/**
 * Validate a human-supplied bounded literal command scope.
 *
 * Permission rules wrap each entry as `Bash(<literal>)`, so shell syntax,
 * globs, and pre-wrapped Bash rules are rejected instead of being interpreted
 * as broader policy. This intentionally accepts a small command alphabet.
 */
export function validateHostCommandScope(
  raw: readonly unknown[],
): HostCommandScopeValidation {
  if (raw.length === 0) {
    return { ok: false, reason: 'command scope is empty' };
  }
  if (raw.length > MAX_HOST_COMMAND_SCOPE) {
    return {
      ok: false,
      reason: `command scope exceeds max ${MAX_HOST_COMMAND_SCOPE} entries`,
    };
  }
  const scope: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') {
      return { ok: false, reason: 'command scope entries must be strings' };
    }
    const cmd = item.trim();
    if (cmd.length === 0) {
      return { ok: false, reason: 'command scope contains a blank entry' };
    }
    if (cmd.length > MAX_HOST_COMMAND_LEN) {
      return {
        ok: false,
        reason: `command exceeds max ${MAX_HOST_COMMAND_LEN} characters`,
      };
    }
    if (/^Bash\s*\(/i.test(cmd)) {
      return { ok: false, reason: 'command scope entries must not be Bash(...) rules' };
    }
    if ([...cmd].some((char) => SHELL_METACHARACTERS.includes(char))) {
      return { ok: false, reason: 'command scope entries must not contain shell metacharacters' };
    }
    if (!/^[A-Za-z0-9 /._:=,@%+-]+$/.test(cmd)) {
      return { ok: false, reason: 'command scope entries contain unsupported characters' };
    }
    if (/(?:^|\s)(?:\/(?:usr\/)?bin\/)?(?:ba|z|da|k|c)?sh(?:\s|$)/i.test(cmd)) {
      return { ok: false, reason: 'command scope entries must not invoke a shell wrapper' };
    }
    // Fail-closed: never approve inline credential assignments or secret URIs.
    // Host executor env is a minimal allowlist; secrets must not ride in argv either.
    if (
      /\b(?:[A-Za-z_][A-Za-z0-9_]*?(?:TOKEN|PASSWORD|SECRET|API[_-]?KEY|CREDENTIAL|PRIVATE[_-]?KEY|DATABASE_URL)[A-Za-z0-9_]*)\s*=\s*\S+/i.test(
        cmd,
      )
    ) {
      return {
        ok: false,
        reason: 'command scope entries must not embed credential-like assignments',
      };
    }
    if (
      /:\/\/[^/\s]*:[^/\s]*@/i.test(cmd) ||
      /\b(?:postgres|postgresql|mysql|mongodb|redis|amqp|https?):\/\/[^\s]*:[^\s]*@/i.test(cmd)
    ) {
      return {
        ok: false,
        reason: 'command scope entries must not embed credential-bearing URIs',
      };
    }
    if (seen.has(cmd)) {
      return { ok: false, reason: 'command scope contains a duplicate entry' };
    }
    seen.add(cmd);
    scope.push(cmd);
  }
  return { ok: true, scope };
}

/** Strict enough for an approval audit stamp; rejects arbitrary non-date text. */
export function isIsoTimestamp(value: string): boolean {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(trimmed)) {
    return false;
  }
  return Number.isFinite(Date.parse(trimmed));
}

/** Outcome recorded on the host-operation receipt. */
export type HostOperationOutcome = 'success' | 'failed' | 'skipped' | 'partial';

export interface HostOperationReceipt {
  readonly commandScope: readonly string[];
  readonly outcome: HostOperationOutcome;
  readonly postCheckEvidence: string;
}

export type HostOperationReceiptValidation =
  | { readonly ok: true; readonly receipt: HostOperationReceipt }
  | { readonly ok: false; readonly reason: string };

/** Require a successful current-run receipt matching the approved scope exactly. */
export function validateHostOperationReceipt(
  receipt: HostOperationReceipt | null | undefined,
  approvedScope: readonly string[],
): HostOperationReceiptValidation {
  if (!receipt) {
    return { ok: false, reason: 'current run did not provide a host-operation receipt' };
  }
  const validated = validateHostCommandScope(receipt.commandScope);
  if (!validated.ok) {
    return { ok: false, reason: `receipt command scope is invalid: ${validated.reason}` };
  }
  if (
    validated.scope.length !== approvedScope.length ||
    validated.scope.some((command, index) => command !== approvedScope[index])
  ) {
    return { ok: false, reason: 'receipt command scope does not exactly match human approval' };
  }
  if (receipt.outcome !== 'success') {
    return { ok: false, reason: `receipt outcome is '${receipt.outcome}', not 'success'` };
  }
  const evidence = receipt.postCheckEvidence.trim();
  if (evidence.length === 0 || evidence.toLowerCase() === '(none)') {
    return { ok: false, reason: 'receipt post-check evidence is blank' };
  }
  return { ok: true, receipt: { ...receipt, postCheckEvidence: evidence } };
}

const OUTCOMES: ReadonlySet<string> = new Set(['success', 'failed', 'skipped', 'partial']);

function isHostOperationOutcome(v: string): v is HostOperationOutcome {
  return OUTCOMES.has(v);
}

/** Render the durable receipt section for task body / review packet. */
export function formatHostOperationReceipt(receipt: HostOperationReceipt): string {
  const scope =
    receipt.commandScope.length > 0
      ? receipt.commandScope.map((c) => `\`${c}\``).join(', ')
      : '(none)';
  return [
    HOST_OP_RECEIPT_HEADING,
    '',
    `- **Command scope:** ${scope}`,
    `- **Outcome:** ${receipt.outcome}`,
    `- **Post-check evidence:** ${receipt.postCheckEvidence.trim() || '(none)'}`,
    '',
  ].join('\n');
}

/**
 * Parse a host-operation receipt from task body or packet markdown.
 * Returns null when the section is absent or unparseable.
 */
export function parseHostOperationReceipt(text: string): HostOperationReceipt | null {
  const idx = text.indexOf(HOST_OP_RECEIPT_HEADING);
  if (idx < 0) return null;
  const slice = text.slice(idx + HOST_OP_RECEIPT_HEADING.length);
  const nextH2 = slice.search(/\n##\s/);
  const section = (nextH2 >= 0 ? slice.slice(0, nextH2) : slice).trim();

  const scopeLine = /-\s*\*\*Command scope:\*\*\s*(.+)/i.exec(section);
  const outcomeLine = /-\s*\*\*Outcome:\*\*\s*(\w+)/i.exec(section);
  const evidenceLine = /-\s*\*\*Post-check evidence:\*\*\s*(.+)/i.exec(section);
  if (!scopeLine || !outcomeLine || !evidenceLine) return null;

  const outcomeRaw = outcomeLine[1]!.trim().toLowerCase();
  if (!isHostOperationOutcome(outcomeRaw)) return null;

  const scopeRaw = scopeLine[1]!.trim();
  const commandScope =
    scopeRaw === '(none)'
      ? []
      : [...scopeRaw.matchAll(/`([^`]+)`/g)].map((m) => m[1]!).filter((s) => s.length > 0);

  return {
    commandScope,
    outcome: outcomeRaw,
    postCheckEvidence: evidenceLine[1]!.trim(),
  };
}

/**
 * Remove every `## Host operation receipt` section from agent prose so the
 * review packet can render a single canonical receipt without duplicating the
 * block. Surrounding narrative and other headings are preserved.
 *
 * Validation still uses the raw final report (marker count / parse); this is
 * render-only normalization after a structured receipt is available.
 */
export function stripHostOperationReceiptSections(text: string): string {
  if (!text.includes(HOST_OP_RECEIPT_HEADING)) return text;
  let out = text;
  for (;;) {
    const idx = out.indexOf(HOST_OP_RECEIPT_HEADING);
    if (idx < 0) break;
    const afterHeading = out.slice(idx + HOST_OP_RECEIPT_HEADING.length);
    const nextH2 = afterHeading.search(/\n##\s/);
    const end =
      nextH2 >= 0 ? idx + HOST_OP_RECEIPT_HEADING.length + nextH2 : out.length;
    const before = out.slice(0, idx).replace(/[ \t]+$/u, '').replace(/\n+$/u, '');
    const rest = out.slice(end).replace(/^[ \t]+/u, '').replace(/^\n+/u, '');
    if (before.length === 0) {
      out = rest;
    } else if (rest.length === 0) {
      out = before;
    } else {
      out = `${before}\n\n${rest}`;
    }
  }
  return out.replace(/\n{3,}/g, '\n\n').trimEnd();
}

export interface HostOperationApprovalStamp {
  readonly commandScope: readonly string[];
  readonly approvedAt: string;
}

/** Append an audit section when a human approves a host-op / deploy task. */
export function stampHostOperationApproval(
  body: string,
  stamp: HostOperationApprovalStamp,
): string {
  const listed = stamp.commandScope.map((c) => `\`${c}\``).join(', ');
  const note =
    `\n\n${HOST_OP_APPROVAL_HEADING}\n\n` +
    `${stamp.approvedAt}: human approved host operation with command scope: ${listed}.\n`;
  return `${body.trimEnd()}${note}`;
}

/**
 * Grok CLI `--tools` CSV for implement (and legacy default).
 *
 * Built-ins only: mutation is via H MCP tools `hercules_workspace__apply_patch`
 * and `hercules_workspace__delete_file` (not Grok built-ins). Shell is never
 * on this list; coding runs also pass `--disallowed-tools` for the real shell
 * tool name `run_terminal_command` plus broad `write`.
 */
export const GROK_IMPLEMENT_TOOLS =
  'read_file,grep,list_dir,search_replace' as const;

/** Explore / verify: same safe built-ins; no mutation MCP registration. */
export const GROK_EXPLORE_VERIFY_TOOLS =
  'read_file,grep,list_dir,search_replace' as const;

/**
 * Host/deploy defense-in-depth argv (production uses the host executor;
 * no edit/delete tools here). Real Grok shell tool id is `run_terminal_command`.
 */
export const GROK_HOST_TOOLS = 'read_file,grep,list_dir,run_terminal_command' as const;

/**
 * Coding runs explicitly strip the real shell tool and broad write.
 * (Historical docs sometimes said `run_terminal_cmd` — that name is wrong.)
 */
export const GROK_CODING_DISALLOWED_TOOLS = 'run_terminal_command,write' as const;

/**
 * Read-only sandbox is truly read-only: no built-in mutation tools at all.
 * `--sandbox read-only` alone is not sufficient while search_replace / Edit /
 * H MCP mutation tools remain allowed, so those are stripped too.
 */
export const GROK_READ_ONLY_TOOLS = 'read_file,grep,list_dir' as const;

/** Read-only also disallows the built-in edit surfaces, not just shell/write. */
export const GROK_READ_ONLY_DISALLOWED_TOOLS =
  'run_terminal_command,write,search_replace,edit' as const;

/** Grok-namespaced H MCP mutation tools (implement only). */
export const GROK_MCP_APPLY_PATCH_TOOL = 'hercules_workspace__apply_patch' as const;
export const GROK_MCP_DELETE_FILE_TOOL = 'hercules_workspace__delete_file' as const;

/** Tools CSV for a coding execution class (no host shell). */
export function grokCodingTools(klass: ExecutionClass): string {
  if (klass === 'implement') return GROK_IMPLEMENT_TOOLS;
  if (klass === 'explore' || klass === 'verify') return GROK_EXPLORE_VERIFY_TOOLS;
  // Host-mutating classes are not coding; callers should not reach here.
  return GROK_EXPLORE_VERIFY_TOOLS;
}

/** Grok coding sandbox argv from policy; none → workspace defense-in-depth. */
export function grokSandboxFromPolicy(
  klass: ExecutionClass,
  policy?: EffectiveRepoExecutionPolicy | null,
): SandboxMode {
  if (isHostMutatingClass(klass)) return 'off';
  if (!policy || policy.sandbox === 'none') return 'workspace';
  return policy.sandbox;
}

/** Whether coding Grok should pass --disable-web-search. */
export function grokDisableWebSearchFromPolicy(
  klass: ExecutionClass,
  policy?: EffectiveRepoExecutionPolicy | null,
): boolean {
  if (isHostMutatingClass(klass)) return false;
  const network = policy?.network ?? 'unspecified';
  return network !== 'unrestricted';
}

/**
 * Grok permission argv for one unattended task. `dontAsk` is fail-closed:
 * anything outside the explicit tool allow-list is denied without prompting.
 *
 * Coding: `--sandbox workspace`, `--disallowed-tools run_terminal_command,write`,
 * `--deny Bash`, no web tools. Implement also allows the two H MCP mutation
 * tools; explore/verify do not. Host/deploy: scoped Bash only (defense-in-depth;
 * production uses the deterministic host executor).
 */
export function grokPermissionArgs(task: {
  readonly executionClass?: ExecutionClass | null;
  readonly hostCommandScope?: readonly string[] | null;
  readonly executionPolicy?: EffectiveRepoExecutionPolicy | null;
}): string[] {
  const klass = resolveExecutionClass(task);
  if (!isHostMutatingClass(klass)) {
    // C3.56: `verify` is read-only by contract — the agent judges a seeded tip
    // and must not be able to leave bytes in the worktree. With the policy
    // sandbox it still had `search_replace` + `--allow Edit`, and a downstream project
    // task 24 got two empty probe files committed into its verified state.
    const sandbox: SandboxMode =
      klass === 'verify' ? 'read-only' : grokSandboxFromPolicy(klass, task.executionPolicy ?? null);
    const readOnly = sandbox === 'read-only';
    const args = [
      '--permission-mode',
      'dontAsk',
      '--sandbox',
      sandbox,
      '--tools',
      readOnly ? GROK_READ_ONLY_TOOLS : grokCodingTools(klass),
      '--disallowed-tools',
      readOnly ? GROK_READ_ONLY_DISALLOWED_TOOLS : GROK_CODING_DISALLOWED_TOOLS,
      '--deny',
      'Bash',
      '--allow',
      'Read',
      '--allow',
      'Grep',
      // Edit is a mutation surface — only outside read-only.
      ...(readOnly ? [] : ['--allow', 'Edit']),
    ];
    if (grokDisableWebSearchFromPolicy(klass, task.executionPolicy ?? null)) {
      args.push('--disable-web-search');
    }
    if (klass === 'implement' && !readOnly) {
      args.push(
        '--allow',
        `MCPTool(${GROK_MCP_APPLY_PATCH_TOOL})`,
        '--allow',
        `MCPTool(${GROK_MCP_DELETE_FILE_TOOL})`,
      );
    }
    return args;
  }

  const validated = validateHostCommandScope(task.hostCommandScope ?? []);
  const args = [
    '--permission-mode',
    'dontAsk',
    '--sandbox',
    'off',
    '--tools',
    GROK_HOST_TOOLS,
    '--allow',
    'Read',
    '--allow',
    'Grep',
  ];
  if (!validated.ok) {
    return args;
  }
  for (const command of validated.scope) {
    args.push('--allow', `Bash(${command})`);
  }
  return args;
}
