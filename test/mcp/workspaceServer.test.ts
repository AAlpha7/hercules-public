/**
 * Direct MCP protocol tests for hercules_workspace apply_patch / delete_file.
 *
 * Uses a real temp git repo (never the Hercules source tree under test).
 * Speaks NDJSON JSON-RPC over stdio to the in-process server loop.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, access, mkdir, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PassThrough } from 'node:stream';
import { runWorkspaceMcpServer } from '../../src/mcp/workspaceServer.js';
import {
  applyWorkspacePatch,
  deleteWorkspaceFile,
  resolveConfinedTarget,
} from '../../src/mcp/workspaceTools.js';
import { normalizeWorkspaceRelativePath } from '../../src/domain/workspaceMutation.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function seedRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hercules-mcp-ws-'));
  await git(dir, ['init']);
  await git(dir, ['config', 'user.email', 'test@hercules.local']);
  await git(dir, ['config', 'user.name', 'Hercules Test']);
  await writeFile(join(dir, 'hello.txt'), 'hello\n', 'utf8');
  await mkdir(join(dir, 'sub'), { recursive: true });
  await writeFile(join(dir, 'sub', 'nested.txt'), 'nested\n', 'utf8');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 'seed']);
  return dir;
}

/** Drive MCP NDJSON handshake + one tools/call. */
async function mcpCall(
  workspaceRoot: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; content?: { type: string; text: string }[] }> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let out = '';
  stdout.on('data', (c: Buffer) => {
    out += c.toString('utf8');
  });

  const serverDone = runWorkspaceMcpServer({ workspaceRoot, stdin, stdout });

  const send = (obj: unknown): void => {
    stdin.write(JSON.stringify(obj) + '\n');
  };

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  });
  stdin.end();

  await serverDone;

  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { id?: number; result?: { tools?: unknown; isError?: boolean; content?: { type: string; text: string }[] } });

  const init = lines.find((l) => l.id === 1);
  expect(init?.result).toBeDefined();

  const list = lines.find((l) => l.id === 2);
  const tools = (list?.result?.tools ?? []) as { name: string }[];
  expect(tools.map((t) => t.name).sort()).toEqual(['apply_patch', 'delete_file']);

  const call = lines.find((l) => l.id === 3);
  expect(call?.result).toBeDefined();
  return call!.result as { isError?: boolean; content?: { type: string; text: string }[] };
}

describe('normalizeWorkspaceRelativePath', () => {
  it('accepts relative paths and rejects absolute/traversal/null/root', () => {
    expect(normalizeWorkspaceRelativePath('a/b.txt')).toBe('a/b.txt');
    expect(normalizeWorkspaceRelativePath('./a/b.txt')).toBe('a/b.txt');
    expect(() => normalizeWorkspaceRelativePath('/etc/passwd')).toThrow(/absolute/);
    expect(() => normalizeWorkspaceRelativePath('../x')).toThrow(/traversal/);
    expect(() => normalizeWorkspaceRelativePath('a/../../x')).toThrow(/traversal/);
    expect(() => normalizeWorkspaceRelativePath('a\0b')).toThrow(/null/);
    expect(() => normalizeWorkspaceRelativePath('')).toThrow(/empty/);
    expect(() => normalizeWorkspaceRelativePath('.')).toThrow(/root/);
  });
});

describe('workspace tools (direct, temp git repo)', () => {
  let workspace: string;
  let outside: string;

  beforeEach(async () => {
    workspace = await seedRepo();
    outside = await mkdtemp(join(tmpdir(), 'hercules-mcp-outside-'));
    await writeFile(join(outside, 'sentinel.txt'), 'keep-me\n', 'utf8');
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('apply_patch creates and updates files', async () => {
    const createPatch = [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+created',
      '',
    ].join('\n');
    await applyWorkspacePatch({ workspaceRoot: workspace }, createPatch);
    expect(await readFile(join(workspace, 'new.txt'), 'utf8')).toBe('created\n');

    const updatePatch = [
      'diff --git a/hello.txt b/hello.txt',
      '--- a/hello.txt',
      '+++ b/hello.txt',
      '@@ -1 +1 @@',
      '-hello',
      '+hello-updated',
      '',
    ].join('\n');
    await applyWorkspacePatch({ workspaceRoot: workspace }, updatePatch);
    expect(await readFile(join(workspace, 'hello.txt'), 'utf8')).toBe('hello-updated\n');
  });

  it('apply_patch can delete via unified diff; tracked delete works', async () => {
    const delPatch = [
      'diff --git a/sub/nested.txt b/sub/nested.txt',
      'deleted file mode 100644',
      '--- a/sub/nested.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-nested',
      '',
    ].join('\n');
    await applyWorkspacePatch({ workspaceRoot: workspace }, delPatch);
    await expect(access(join(workspace, 'sub', 'nested.txt'))).rejects.toThrow();
  });

  it('apply_patch rejects absolute and traversal paths in diff headers', async () => {
    const absPatch = [
      'diff --git a/../../etc/passwd b/../../etc/passwd',
      '--- a/../../etc/passwd',
      '+++ b/../../etc/passwd',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      '',
    ].join('\n');
    await expect(
      applyWorkspacePatch({ workspaceRoot: workspace }, absPatch),
    ).rejects.toThrow(/traversal|absolute/i);

    const absOnly = [
      'diff --git a//etc/passwd b//etc/passwd',
      '--- a//etc/passwd',
      '+++ b//etc/passwd',
      '@@ -0,0 +1 @@',
      '+x',
      '',
    ].join('\n');
    // After stripping a/ prefix we still see absolute /etc/passwd.
    await expect(
      applyWorkspacePatch({ workspaceRoot: workspace }, absOnly),
    ).rejects.toThrow(/absolute|traversal/i);
  });

  it('delete_file removes in-worktree files and tracked paths', async () => {
    await deleteWorkspaceFile({ workspaceRoot: workspace }, 'hello.txt');
    await expect(access(join(workspace, 'hello.txt'))).rejects.toThrow();
  });

  it('denies absolute, traversal, directory, and symlink-ancestor escape; outside sentinel survives', async () => {
    const sentinel = join(outside, 'sentinel.txt');

    await expect(
      deleteWorkspaceFile({ workspaceRoot: workspace }, sentinel),
    ).rejects.toThrow(/absolute|workspace-relative/i);

    await expect(
      deleteWorkspaceFile({ workspaceRoot: workspace }, '../escape.txt'),
    ).rejects.toThrow(/traversal/i);

    await expect(
      deleteWorkspaceFile({ workspaceRoot: workspace }, 'sub'),
    ).rejects.toThrow(/directory/i);

    // Symlink ancestor: link inside workspace pointing at outside dir.
    const linkDir = join(workspace, 'escape-link');
    await symlink(outside, linkDir);
    await expect(
      deleteWorkspaceFile({ workspaceRoot: workspace }, 'escape-link/sentinel.txt'),
    ).rejects.toThrow(/symlink ancestor|escape/i);

    // Outside sentinel must survive all denial attempts.
    expect(await readFile(sentinel, 'utf8')).toBe('keep-me\n');
    expect(await realpath(outside)).toBeTruthy();
  });

  it('resolveConfinedTarget rejects root-escape candidates', async () => {
    await expect(resolveConfinedTarget(workspace, '/tmp/x')).rejects.toThrow();
    const ok = await resolveConfinedTarget(workspace, 'hello.txt');
    expect(ok.relPath).toBe('hello.txt');
  });
});

describe('MCP protocol handshake + tools/call', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await seedRepo();
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('initialize → tools/list → tools/call apply_patch + delete_file', async () => {
    const patch = [
      'diff --git a/via-mcp.txt b/via-mcp.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/via-mcp.txt',
      '@@ -0,0 +1 @@',
      '+from-mcp',
      '',
    ].join('\n');

    const create = await mcpCall(workspace, 'apply_patch', { patch });
    expect(create.isError).toBeFalsy();
    expect(await readFile(join(workspace, 'via-mcp.txt'), 'utf8')).toBe('from-mcp\n');

    const del = await mcpCall(workspace, 'delete_file', { path: 'via-mcp.txt' });
    expect(del.isError).toBeFalsy();
    await expect(access(join(workspace, 'via-mcp.txt'))).rejects.toThrow();
  });

  it('tools/call returns typed isError on path escape', async () => {
    const result = await mcpCall(workspace, 'delete_file', { path: '/etc/passwd' });
    expect(result.isError).toBe(true);
    const text = result.content?.[0]?.text ?? '';
    expect(text).toMatch(/absolute|workspace-relative|error/i);
  });
});
