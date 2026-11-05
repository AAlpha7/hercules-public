/**
 * Isolated GROK_HOME: config/auth outside worktree, MCP only for implement.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  mkdir,
  lstat,
  realpath,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildGrokHomeConfigToml,
  grokCodingChildEnv,
  grokHomeForTask,
  prepareGrokHome,
  GROK_MCP_APPLY_PATCH,
  GROK_MCP_DELETE_FILE,
  HERCULES_WORKSPACE_ENV,
  HERCULES_WORKSPACE_MCP_SERVER_ENV,
  MCP_SERVER_NAME,
} from '../../src/adapters/grokHome.js';

describe('buildGrokHomeConfigToml', () => {
  it('registers only hercules_workspace MCP when includeWorkspaceMcp', () => {
    const withMcp = buildGrokHomeConfigToml({ includeWorkspaceMcp: true });
    expect(withMcp).toMatch(new RegExp(`\\[mcp_servers\\.${MCP_SERVER_NAME}\\]`));
    expect(withMcp).toContain(`\${${HERCULES_WORKSPACE_MCP_SERVER_ENV}}`);
    expect(withMcp).toContain(`\${${HERCULES_WORKSPACE_ENV}}`);
    expect(withMcp).toMatch(/compat\.claude[\s\S]*mcps = false/);
    expect(withMcp).toMatch(/compat\.cursor[\s\S]*mcps = false/);

    const without = buildGrokHomeConfigToml({ includeWorkspaceMcp: false });
    expect(without).not.toMatch(/mcp_servers/);
    expect(without).toMatch(/mcps = false/);
  });

  it('namespaced MCP tool ids match Grok convention', () => {
    expect(GROK_MCP_APPLY_PATCH).toBe('hercules_workspace__apply_patch');
    expect(GROK_MCP_DELETE_FILE).toBe('hercules_workspace__delete_file');
  });
});

describe('prepareGrokHome', () => {
  let root: string;
  let worktree: string;
  let scratch: string;
  let operatorHome: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hercules-grok-home-'));
    worktree = join(root, 'worktree');
    scratch = join(root, 'scratch');
    operatorHome = join(root, 'operator-grok');
    await mkdir(worktree, { recursive: true });
    await mkdir(scratch, { recursive: true });
    await mkdir(operatorHome, { recursive: true });
    await writeFile(join(operatorHome, 'auth.json'), '{"token":"test"}\n', 'utf8');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes restricted home outside worktree and symlinks auth', async () => {
    const homeDir = grokHomeForTask(scratch, 'T-1');
    expect(homeDir.startsWith(worktree)).toBe(false);

    prepareGrokHome({
      homeDir,
      includeWorkspaceMcp: true,
      operatorGrokHome: operatorHome,
    });

    const st = await lstat(homeDir);
    expect(st.isDirectory()).toBe(true);
    // Prefer 0700; accept umask-softened owner-only dirs (no group/other write).
    expect(st.mode & 0o022).toBe(0);

    const config = await readFile(join(homeDir, 'config.toml'), 'utf8');
    expect(config).toContain('hercules_workspace');
    expect(config).toContain(HERCULES_WORKSPACE_ENV);

    const authLink = await lstat(join(homeDir, 'auth.json'));
    expect(authLink.isSymbolicLink()).toBe(true);
    expect(await realpath(join(homeDir, 'auth.json'))).toBe(
      await realpath(join(operatorHome, 'auth.json')),
    );

    // Must not create config inside the agent worktree.
    await expect(readFile(join(worktree, 'config.toml'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(worktree, '.grok', 'config.toml'), 'utf8')).rejects.toThrow();
  });

  it('explore-style home omits mutation MCP server', async () => {
    const homeDir = grokHomeForTask(scratch, 'T-explore');
    prepareGrokHome({
      homeDir,
      includeWorkspaceMcp: false,
      operatorGrokHome: operatorHome,
    });
    const config = await readFile(join(homeDir, 'config.toml'), 'utf8');
    expect(config).not.toContain('mcp_servers');
  });

  it('grokCodingChildEnv sets GROK_HOME + expansion vars only when MCP enabled', () => {
    const withMcp = grokCodingChildEnv({
      baseEnv: { PATH: '/bin' },
      grokHome: '/tmp/gh',
      workspace: '/ws',
      mcpServerPath: '/opt/server.js',
      includeWorkspaceMcp: true,
    });
    expect(withMcp['GROK_HOME']).toBe('/tmp/gh');
    expect(withMcp[HERCULES_WORKSPACE_ENV]).toBe('/ws');
    expect(withMcp[HERCULES_WORKSPACE_MCP_SERVER_ENV]).toBe('/opt/server.js');
    expect(withMcp['GROK_CLAUDE_MCPS_ENABLED']).toBe('0');

    const noMcp = grokCodingChildEnv({
      baseEnv: { PATH: '/bin' },
      grokHome: '/tmp/gh',
      workspace: '/ws',
      mcpServerPath: '/opt/server.js',
      includeWorkspaceMcp: false,
    });
    expect(noMcp['GROK_HOME']).toBe('/tmp/gh');
    expect(noMcp[HERCULES_WORKSPACE_ENV]).toBeUndefined();
    expect(noMcp[HERCULES_WORKSPACE_MCP_SERVER_ENV]).toBeUndefined();
  });
});
