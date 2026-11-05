/**
 * Domain — pure workspace path confinement for H-owned Grok mutation tools.
 *
 * IO (realpath, unlink, git apply) lives in the MCP server module. This file
 * only validates relative path *syntax* so callers share one chokepoint.
 */

/** Relative path failed workspace confinement syntax checks. */
export class WorkspacePathError extends Error {
  override readonly name = 'WorkspacePathError';
  constructor(
    message: string,
    readonly code:
      | 'empty'
      | 'null_byte'
      | 'absolute'
      | 'traversal'
      | 'root'
      | 'invalid' = 'invalid',
  ) {
    super(message);
  }
}

/**
 * Normalize and validate a workspace-relative path *string* (no FS).
 *
 * Rejects empty, null bytes, absolute (POSIX/Windows), root-only, and any
 * `..` segment. Returns a normalized relative path using `/` separators
 * without a leading `./`.
 */
export function normalizeWorkspaceRelativePath(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new WorkspacePathError('path must be a string', 'invalid');
  }
  if (raw.length === 0 || raw.trim().length === 0) {
    throw new WorkspacePathError('path must not be empty', 'empty');
  }
  if (raw.includes('\0')) {
    throw new WorkspacePathError('path must not contain null bytes', 'null_byte');
  }
  // Absolute POSIX or Windows (C:\… / \\server\…)
  if (
    raw.startsWith('/') ||
    raw.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(raw)
  ) {
    throw new WorkspacePathError('path must be workspace-relative (not absolute)', 'absolute');
  }
  // Normalize separators then split.
  const normalized = raw.replace(/\\/g, '/');
  if (normalized === '/' || normalized === '.') {
    throw new WorkspacePathError('path must not target the workspace root', 'root');
  }
  const parts = normalized.split('/').filter((p) => p.length > 0 && p !== '.');
  if (parts.length === 0) {
    throw new WorkspacePathError('path must not target the workspace root', 'root');
  }
  if (parts.some((p) => p === '..')) {
    throw new WorkspacePathError('path must not contain .. traversal segments', 'traversal');
  }
  return parts.join('/');
}

/**
 * Extract workspace-relative file paths from a unified git diff and validate
 * each with {@link normalizeWorkspaceRelativePath}. Rejects absolute / `..`
 * targets so `git apply` cannot be pointed outside the workspace via path headers.
 *
 * Ignores `/dev/null` (create/delete markers). Returns the normalized relative paths.
 */
export function assertPatchPathsConfined(patch: string): readonly string[] {
  if (patch.includes('\0')) {
    throw new WorkspacePathError('path must not contain null bytes', 'null_byte');
  }
  const found: string[] = [];
  const seen = new Set<string>();
  for (const line of patch.split('\n')) {
    const gitHeader = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (gitHeader) {
      // Validate both sides (rename support).
      for (const side of [gitHeader[1], gitHeader[2]]) {
        if (!side || side === '/dev/null') continue;
        const rel = normalizeWorkspaceRelativePath(side);
        if (!seen.has(rel)) {
          seen.add(rel);
          found.push(rel);
        }
      }
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const rest = line.slice(4).trim();
      // Strip optional timestamp tab suffix: "path\t2024-01-01 ..."
      const pathPart = rest.split('\t')[0]?.trim() ?? '';
      if (pathPart === '/dev/null' || pathPart.length === 0) continue;
      // "a/foo" / "b/foo" prefixes from git; also bare paths.
      const raw =
        pathPart.startsWith('a/') || pathPart.startsWith('b/')
          ? pathPart.slice(2)
          : pathPart;
      if (raw === '/dev/null' || raw.length === 0) continue;
      const rel = normalizeWorkspaceRelativePath(raw);
      if (!seen.has(rel)) {
        seen.add(rel);
        found.push(rel);
      }
    }
  }
  return found;
}

/**
 * Built-in Grok tool names that must never appear on a coding run's advertised
 * tool surface (shell / broad write). Used by the runtime fail-closed guard.
 */
export const GROK_CODING_FORBIDDEN_TOOLS = [
  'run_terminal_command',
  'run_terminal_cmd',
  'bash',
  'Bash',
  'shell',
  'write',
] as const;

const FORBIDDEN_TOOL_SET = new Set(
  GROK_CODING_FORBIDDEN_TOOLS.map((t) => t.toLowerCase()),
);

/** True when a tool name is shell/write tooling forbidden on coding runs. */
export function isForbiddenCodingToolName(name: string): boolean {
  const n = name.trim().toLowerCase();
  if (n.length === 0) return false;
  if (FORBIDDEN_TOOL_SET.has(n)) return true;
  // Bare aliases sometimes appear as "Shell" / "terminal".
  if (n === 'terminal' || n === 'run_shell' || n === 'shell.command') return true;
  return false;
}

/**
 * Scan an available_commands / tools advertisement for forbidden shell tools.
 * Accepts string arrays or objects with name/tool/id fields.
 */
export function findForbiddenCodingTool(tools: unknown): string | null {
  if (!Array.isArray(tools)) return null;
  for (const item of tools) {
    if (typeof item === 'string') {
      if (isForbiddenCodingToolName(item)) return item;
      continue;
    }
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      for (const key of ['name', 'tool', 'tool_name', 'id', 'command'] as const) {
        const v = o[key];
        if (typeof v === 'string' && isForbiddenCodingToolName(v)) return v;
      }
    }
  }
  return null;
}
