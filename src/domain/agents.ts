/**
 * Domain layer — adapter kind names + selection chain (SPEC §13).
 *
 * Pure: no IO. Overrides live on the task file and/or repos.yaml; the daemon
 * default comes from HERCULES_ADAPTER. Resolution never throws on unknown
 * strings — a bad override falls through so a tick cannot crash.
 *
 * Precedence (highest wins):
 *   1. task.adapter   — this task only (changeable mid-lifecycle; next run)
 *   2. repo.adapter   — all tasks in that repo
 *   3. daemon default — HERCULES_ADAPTER / registry default
 *
 * Mid-run changes update the task file only; the live process keeps its agent
 * until cancel/retry/reject re-dispatches. Future multi-step pipelines =
 * multiple tasks (blocked_by) each with their own adapter, not one hot-swap.
 */

/** Supported agent backends (local CLI + remote Cursor Cloud). */
export const ADAPTER_KINDS = ['grok', 'codex', 'claude', 'cursor', 'fake'] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number];

/** Local process adapters that own a pid for path-lease bind. */
export const LOCAL_PROCESS_ADAPTER_KINDS = ['grok', 'codex', 'claude'] as const;

/**
 * Adapters that need a local git worktree / port / path-lease writer slot.
 * `cursor` is a remote Cloud Agent — it must not consume CLI isolation.
 * `fake` still needs a workspace (L2 isolation / dry-run).
 */
export const LOCAL_WORKSPACE_ADAPTER_KINDS = ['grok', 'codex', 'claude', 'fake'] as const;

export function adapterOwnsLocalProcess(kind: string): boolean {
  return (LOCAL_PROCESS_ADAPTER_KINDS as readonly string[]).includes(kind);
}

export function adapterNeedsLocalWorkspace(kind: string): boolean {
  return (LOCAL_WORKSPACE_ADAPTER_KINDS as readonly string[]).includes(kind);
}

/** Cursor Cloud is the remote factory executor — no local hercules/<id> branch. */
export function isRemoteFactoryAdapter(kind: string): boolean {
  return kind === 'cursor';
}

/**
 * PR identity for a stored factory handle uses task → repo adapter (daemon
 * default stays grok). A grok override on a cursor repo keeps local-head identity.
 */
export function isRemoteFactoryPrIdentity(input: {
  readonly taskAdapter?: string | null;
  readonly repoAdapter?: string | null;
}): boolean {
  return isRemoteFactoryAdapter(
    resolveAdapterKind(input.taskAdapter, resolveAdapterKind(input.repoAdapter, 'grok')),
  );
}

const KIND_SET: ReadonlySet<string> = new Set(ADAPTER_KINDS);

export function isAdapterKind(value: string): value is AdapterKind {
  return KIND_SET.has(value);
}

/**
 * Single-level pick: requested if valid, else fallback.
 */
export function resolveAdapterKind(
  requested: string | null | undefined,
  fallback: AdapterKind,
): AdapterKind {
  if (requested && isAdapterKind(requested)) return requested;
  return fallback;
}

/**
 * Full chain for a dispatch: task → repo → daemon default.
 */
export function resolveAdapterChain(input: {
  readonly taskAdapter?: string | null;
  readonly repoAdapter?: string | null;
  readonly defaultKind: AdapterKind;
}): AdapterKind {
  return resolveAdapterKind(
    input.taskAdapter,
    resolveAdapterKind(input.repoAdapter, input.defaultKind),
  );
}

/** Short labels for UI / DTO (not marketing copy). */
export const ADAPTER_LABELS: Readonly<Record<AdapterKind, string>> = {
  grok: 'Grok Build (default headless)',
  codex: 'Codex CLI',
  claude: 'Claude Code (opt-in / Agent SDK)',
  cursor: 'Cursor Cloud Agent',
  fake: 'Fake (no cost dry-run)',
};
