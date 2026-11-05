/**
 * Adapter contract for implement-class mutation tools + honest git fixture.
 *
 * H owns: buildGrokArgs tool CSV, dontAsk, workspace sandbox, --cwd,
 * disallowed run_terminal_command/write, --deny Bash, MCP mutation allows,
 * extraArgs policy rejection. Mutation tools are H MCP — not Grok built-ins.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildGrokArgs } from '../../src/adapters/grok.js';
import {
  GROK_CODING_DISALLOWED_TOOLS,
  GROK_EXPLORE_VERIFY_TOOLS,
  GROK_IMPLEMENT_TOOLS,
  GROK_MCP_APPLY_PATCH_TOOL,
  GROK_MCP_DELETE_FILE_TOOL,
} from '../../src/domain/executionClass.js';
import type { AgentStartInput } from '../../src/orchestrator/adapter.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

const baseInput: AgentStartInput = {
  taskId: 'T-del',
  workspace: '/ws/app/T-del',
  prompt: 'remove dead fixture',
  allocation: { slug: 'T-del', port: 4100, scratchDir: '/ws/app/T-del/.scratch' },
};

describe('buildGrokArgs — implement mutation tools (H-owned controls)', () => {
  it('implement: exact tools CSV, dontAsk, workspace sandbox, cwd; shell stripped; MCP allows', () => {
    const args = buildGrokArgs({ ...baseInput, executionClass: 'implement' }, {});
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace');
    expect(args[args.indexOf('--tools') + 1]).toBe(GROK_IMPLEMENT_TOOLS);
    expect(args[args.indexOf('--disallowed-tools') + 1]).toBe(GROK_CODING_DISALLOWED_TOOLS);
    expect(args).toContain('--deny');
    expect(args).toContain('Bash');
    expect(args[args.indexOf('--cwd') + 1]).toBe('/ws/app/T-del');
    expect(args).toContain(`MCPTool(${GROK_MCP_APPLY_PATCH_TOOL})`);
    expect(args).toContain(`MCPTool(${GROK_MCP_DELETE_FILE_TOOL})`);
    expect(args).toContain('--disable-web-search');
    // Must not grant shell via tools allowlist.
    expect(args[args.indexOf('--tools') + 1]).not.toMatch(/run_terminal_command|run_terminal_cmd/);
  });

  it('default (legacy) matches implement tools', () => {
    const args = buildGrokArgs(baseInput, {});
    expect(args[args.indexOf('--tools') + 1]).toBe(GROK_IMPLEMENT_TOOLS);
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace');
    expect(args).toContain(`MCPTool(${GROK_MCP_APPLY_PATCH_TOOL})`);
  });

  it('explore keeps constrained CSV under workspace sandbox without mutation MCP', () => {
    const args = buildGrokArgs({ ...baseInput, executionClass: 'explore' }, {});
    expect(args[args.indexOf('--tools') + 1]).toBe(GROK_EXPLORE_VERIFY_TOOLS);
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args).toContain(GROK_CODING_DISALLOWED_TOOLS);
    expect(args.join(' ')).not.toMatch(/MCPTool\(hercules_workspace__/);
  });

  it('verify is read-only regardless of policy: no edit surface, no mutation MCP (C3.56)', () => {
    const args = buildGrokArgs({ ...baseInput, executionClass: 'verify' }, {});
    expect(args[args.indexOf('--tools') + 1]).toBe('read_file,grep,list_dir');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args).not.toContain('Edit');
    expect(args.join(' ')).not.toMatch(/MCPTool\(hercules_workspace__/);
  });

  it('rejects extraArgs that override permission policy (including tools)', () => {
    expect(() =>
      buildGrokArgs(baseInput, { extraArgs: ['--tools', 'run_terminal_command'] }),
    ).toThrow(/must not override execution permission policy/);
    expect(() => buildGrokArgs(baseInput, { extraArgs: ['--sandbox', 'off'] })).toThrow(
      /must not override execution permission policy/,
    );
    expect(() => buildGrokArgs(baseInput, { extraArgs: ['--always-approve'] })).toThrow(
      /must not override execution permission policy/,
    );
    expect(() => buildGrokArgs(baseInput, { extraArgs: ['--disallowed-tools', 'x'] })).toThrow(
      /must not override execution permission policy/,
    );
  });
});

describe('representation/commit semantics only (not MCP path enforcement)', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'hercules-grok-del-'));
    await git(workspace, ['init']);
    await git(workspace, ['config', 'user.email', 'test@hercules.local']);
    await git(workspace, ['config', 'user.name', 'Hercules Test']);
    await mkdir(join(workspace, 'fixtures'), { recursive: true });
    await writeFile(join(workspace, 'fixtures', 'throwaway-delete-me.txt'), 'scratch\n', 'utf8');
    await git(workspace, ['add', '-A']);
    await git(workspace, ['commit', '-m', 'seed tracked fixture']);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('a tracked in-worktree delete can be staged and committed (git representation)', async () => {
    // Plain fs unlink — not MCP delete_file. Proves only that a worktree
    // deletion is representable in git history for review/diff.
    const target = join(workspace, 'fixtures', 'throwaway-delete-me.txt');
    await rm(target);
    await expect(access(target)).rejects.toThrow();
    await git(workspace, ['add', '-A']);
    await git(workspace, ['commit', '-m', 'delete throwaway fixture']);
    const log = await git(workspace, ['log', '--name-status', '-1', '--pretty=format:']);
    expect(log).toMatch(/D\s+fixtures\/throwaway-delete-me\.txt/);
    expect(await git(workspace, ['status', '--porcelain'])).toBe('');
  });
});

describe('guidance: H MCP tools, not Grok built-ins; fail-closed shell', () => {
  it('WORKFLOW documents H MCP apply_patch/delete_file and shell fail-closed', async () => {
    const workflow = await readFile(join(REPO_ROOT, 'WORKFLOW.md'), 'utf8');
    expect(workflow).toMatch(/apply_patch|hercules_workspace__/);
    expect(workflow).toMatch(/delete_file|hercules_workspace__/);
    expect(workflow).toMatch(/run_terminal_command|fail-closed|no shell/i);
    expect(workflow).toMatch(/post-test Git|mutate repository source/i);
    // Must not claim they are Grok CLI built-ins.
    expect(workflow).not.toMatch(/Grok (CLI )?built-in.*apply_patch/i);
  });
});
