/**
 * The analyst grok session must run inside a plain tree export of the trusted
 * mirror — no `.git`, no index side effects on the bare mirror, offline.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { GitWorkspaces } from '../../src/isolation/worktree.js';
import { PortAllocator } from '../../src/isolation/ports.js';
import type { RepoConfig } from '../../src/domain/repos.js';

let tmp: string;
let root: string;
let repo: RepoConfig;
let mainSha: string;
let branchSha: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'hercules-xt-'));
  root = join(tmp, 'root');
  await mkdir(root, { recursive: true });

  const targetUrl = join(tmp, 'target');
  await mkdir(targetUrl, { recursive: true });
  const g = simpleGit(targetUrl);
  await g.init(['-b', 'main']);
  await g.addConfig('user.email', 't@h.local');
  await g.addConfig('user.name', 'T');
  await writeFile(join(targetUrl, 'README.md'), '# target\n');
  await mkdir(join(targetUrl, 'src'), { recursive: true });
  await writeFile(join(targetUrl, 'src', 'a.ts'), 'export const a = 1;\n');
  await g.add('.');
  await g.commit('initial');
  mainSha = (await g.revparse(['HEAD'])).trim();
  await g.checkoutLocalBranch('hercules/T-1');
  await mkdir(join(targetUrl, 'docs'), { recursive: true });
  await writeFile(join(targetUrl, 'docs', 'GUIDE.md'), '# Guide\n');
  await g.add('.');
  await g.commit('docs');
  branchSha = (await g.revparse(['HEAD'])).trim();
  await g.checkout('main');

  repo = {
    key: 'app', url: targetUrl, defaultBranch: 'main', workflow: 'WORKFLOW.md',
    maxConcurrent: 1, adapter: null, readiness: 'ready',
  };
  const ws = new GitWorkspaces({ root, ports: new PortAllocator(4320, 4) });
  await ws.create(repo, 'T-1');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function ws(): GitWorkspaces {
  return new GitWorkspaces({ root, ports: new PortAllocator(4330, 4) });
}

describe('exportTrustedTree (bare mirror → plain directory, offline)', () => {
  it('materializes the default tip with content, no .git, and leaves the mirror bare', async () => {
    const dest = join(tmp, 'snap');
    await mkdir(dest, { recursive: true });
    await ws().exportTrustedTree(repo, mainSha, dest);
    expect(await readFile(join(dest, 'README.md'), 'utf8')).toBe('# target\n');
    expect(await readFile(join(dest, 'src', 'a.ts'), 'utf8')).toContain('a = 1');
    expect(existsSync(join(dest, '.git'))).toBe(false);
    expect(existsSync(join(dest, 'docs'))).toBe(false);
    const mirror = join(root, '.mirrors', 'app.git');
    expect(existsSync(join(mirror, 'index'))).toBe(false);
  });

  it('exports a task-branch sha tree', async () => {
    const dest = join(tmp, 'snap2');
    await mkdir(dest, { recursive: true });
    await ws().exportTrustedTree(repo, branchSha, dest);
    expect(await readFile(join(dest, 'docs', 'GUIDE.md'), 'utf8')).toContain('Guide');
  });

  it('rejects malformed and unknown shas without writing anything', async () => {
    const dest = join(tmp, 'snap3');
    await mkdir(dest, { recursive: true });
    await expect(ws().exportTrustedTree(repo, 'nope', dest)).rejects.toThrow('invalid sha');
    await expect(ws().exportTrustedTree(repo, 'deadbeef', dest)).rejects.toThrow(/git archive/);
    expect(await readdir(dest)).toEqual([]);
  });
});
