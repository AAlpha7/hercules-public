/**
 * Optional operator smoke for the compiled workspace MCP server.
 * Primary coverage: test/mcp/workspaceServer.test.ts (no build required).
 *
 * Usage (after pnpm build:server):
 *   node scripts/smoke-mcp-workspace.mjs
 */
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = join(root, 'dist/src/mcp/workspaceServer.js');

async function git(cwd, args) {
  await execFileAsync('git', args, { cwd });
}

const dir = await mkdtemp(join(tmpdir(), 'hercules-mcp-smoke-'));
try {
  await git(dir, ['init']);
  await git(dir, ['config', 'user.email', 't@h.local']);
  await git(dir, ['config', 'user.name', 't']);
  await writeFile(join(dir, 'a.txt'), 'a\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 's']);

  const child = spawn(process.execPath, [server, '--workspace', dir], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let out = '';
  child.stdout.on('data', (c) => {
    out += c.toString('utf8');
  });
  const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'apply_patch',
      arguments: {
        patch: [
          'diff --git a/b.txt b/b.txt',
          'new file mode 100644',
          '--- /dev/null',
          '+++ b/b.txt',
          '@@ -0,0 +1 @@',
          '+ok',
          '',
        ].join('\n'),
      },
    },
  });
  child.stdin.end();
  // Wait for `close` (stdio drained), not merely `exit` — exit can fire while
  // stdout still has buffered bytes, which produced empty-output flakes on staging.
  const { code, signal } = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal });
    });
  });
  if (signal) {
    throw new Error(
      `MCP server terminated by signal ${signal} (stdout after close: ${out || '<empty>'})`,
    );
  }
  if (code !== 0) {
    throw new Error(
      `MCP server exited ${code ?? 'null'} (stdout after close: ${out || '<empty>'})`,
    );
  }
  if (!out.includes('"id":2') && !out.includes('"id": 2')) {
    throw new Error(`unexpected MCP output: ${out}`);
  }
  const body = await readFile(join(dir, 'b.txt'), 'utf8');
  if (body !== 'ok\n') throw new Error(`patch not applied: ${body}`);
  console.log('smoke ok');
} finally {
  await rm(dir, { recursive: true, force: true });
}
