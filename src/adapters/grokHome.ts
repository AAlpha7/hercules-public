/**
 * H-owned isolated GROK_HOME for coding Grok runs.
 *
 * - Lives under the task scratch dir (outside the agent git worktree).
 * - Registers only the hercules_workspace MCP server for implement class.
 * - Symlinks operator auth.json for headless auth (never copies into worktree).
 * - Permission-restricted (0700 home, 0600 config).
 * - Uses ${HERCULES_WORKSPACE} / ${HERCULES_WORKSPACE_MCP_SERVER} expansion
 *   so the exact allocated workspace and compiled server path bind at load time.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidIdentifier, IdentifierError } from '../domain/task.js';

export const HERCULES_WORKSPACE_ENV = 'HERCULES_WORKSPACE';
export const HERCULES_WORKSPACE_MCP_SERVER_ENV = 'HERCULES_WORKSPACE_MCP_SERVER';
export const MCP_SERVER_NAME = 'hercules_workspace';

/** MCP tool names as Grok namespaces them (server__tool). */
export const GROK_MCP_APPLY_PATCH = `${MCP_SERVER_NAME}__apply_patch` as const;
export const GROK_MCP_DELETE_FILE = `${MCP_SERVER_NAME}__delete_file` as const;

export class GrokHomeError extends Error {
  override readonly name = 'GrokHomeError';
}

export interface PrepareGrokHomeInput {
  /** Absolute path for the isolated GROK_HOME (must be outside agent worktree). */
  readonly homeDir: string;
  /** When true, register hercules_workspace MCP mutation tools. */
  readonly includeWorkspaceMcp: boolean;
  /**
   * Operator Grok home to borrow auth/session material from (default: ~/.grok).
   * Only auth.json is symlinked — never written into the agent worktree.
   */
  readonly operatorGrokHome?: string;
}

/** Default path to the compiled MCP server entry (next to this module in dist/). */
export function defaultWorkspaceMcpServerPath(
  fromModuleUrl: string = import.meta.url,
): string {
  return join(dirname(fileURLToPath(fromModuleUrl)), '..', 'mcp', 'workspaceServer.js');
}

/**
 * Stable per-task GROK_HOME under the isolation scratch dir (outside worktree).
 * Task id is validated through the path/branch chokepoint.
 */
export function grokHomeForTask(scratchDir: string, taskId: string): string {
  if (!isValidIdentifier(taskId)) {
    throw new IdentifierError(`task id '${taskId}' is not a safe identifier`);
  }
  return join(scratchDir, 'grok-home', taskId);
}

/** Render isolated config.toml. */
export function buildGrokHomeConfigToml(opts: {
  readonly includeWorkspaceMcp: boolean;
}): string {
  const lines: string[] = [
    '# Hercules-owned Grok home for unattended coding runs.',
    '# Do not place credentials or this config inside the agent worktree.',
    '',
    '# Disable foreign MCP discovery (operator Claude/Cursor catalogs).',
    '[compat.claude]',
    'mcps = false',
    '',
    '[compat.cursor]',
    'mcps = false',
    '',
  ];
  if (opts.includeWorkspaceMcp) {
    lines.push(
      `[mcp_servers.${MCP_SERVER_NAME}]`,
      'command = "node"',
      `args = ["\${${HERCULES_WORKSPACE_MCP_SERVER_ENV}}"]`,
      `env = { ${HERCULES_WORKSPACE_ENV} = "\${${HERCULES_WORKSPACE_ENV}}" }`,
      'enabled = true',
      'startup_timeout_sec = 30',
      'tool_timeout_sec = 120',
      '',
    );
  }
  return lines.join('\n');
}

function linkAuth(homeDir: string, operatorGrokHome: string): void {
  const src = join(operatorGrokHome, 'auth.json');
  const dest = join(homeDir, 'auth.json');
  if (!existsSync(src)) return;
  // Force-refresh symlink each prepare so operator re-login is visible.
  if (existsSync(dest)) {
    try {
      unlinkSync(dest);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new GrokHomeError(`failed to replace auth.json symlink: ${msg}`);
    }
  }
  try {
    symlinkSync(src, dest);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new GrokHomeError(`failed to link auth.json into isolated GROK_HOME: ${msg}`);
  }
}

/**
 * Create/update an H-owned GROK_HOME. Sync so {@link GrokAdapter.start} stays sync.
 */
export function prepareGrokHome(input: PrepareGrokHomeInput): void {
  const homeDir = input.homeDir.trim();
  if (homeDir.length === 0 || (!homeDir.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(homeDir))) {
    throw new GrokHomeError('GROK_HOME must be an absolute path');
  }

  try {
    mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    chmodSync(homeDir, 0o700);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new GrokHomeError(`failed to create GROK_HOME: ${msg}`);
  }

  const configPath = join(homeDir, 'config.toml');
  const toml = buildGrokHomeConfigToml({ includeWorkspaceMcp: input.includeWorkspaceMcp });
  try {
    writeFileSync(configPath, toml, { encoding: 'utf8', mode: 0o600 });
    chmodSync(configPath, 0o600);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new GrokHomeError(`failed to write config.toml: ${msg}`);
  }

  const operator =
    input.operatorGrokHome?.trim() ||
    join(process.env['HOME'] ?? '', '.grok');
  if (operator.length > 0 && existsSync(operator)) {
    linkAuth(homeDir, operator);
  }
}

/** Env vars the coding Grok child needs for MCP expansion + isolated home. */
export function grokCodingChildEnv(input: {
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly grokHome: string;
  readonly workspace: string;
  readonly mcpServerPath: string;
  readonly includeWorkspaceMcp: boolean;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...input.baseEnv,
    GROK_HOME: input.grokHome,
    // Defense: do not inherit operator Claude/Cursor MCP catalogs.
    GROK_CLAUDE_MCPS_ENABLED: '0',
    GROK_CURSOR_MCPS_ENABLED: '0',
  };
  if (input.includeWorkspaceMcp) {
    env[HERCULES_WORKSPACE_ENV] = input.workspace;
    env[HERCULES_WORKSPACE_MCP_SERVER_ENV] = input.mcpServerPath;
  }
  return env;
}
