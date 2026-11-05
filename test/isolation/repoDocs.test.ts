/**
 * Repo docs browser: list/read markdown docs from the trusted mirror at the
 * default branch (offline — phone Repos panel, no live worktree).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { GitWorkspaces } from '../../src/isolation/worktree.js';
import { PortAllocator } from '../../src/isolation/ports.js';
import type { RepoConfig } from '../../src/domain/repos.js';

let tmp: string;
let root: string;
let repo: RepoConfig;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'hercules-rd-'));
  root = join(tmp, 'root');
  await mkdir(root, { recursive: true });

  const targetUrl = join(tmp, 'target');
  await mkdir(targetUrl, { recursive: true });
  const g = simpleGit(targetUrl);
  await g.init(['-b', 'main']);
  await g.addConfig('user.email', 't@h.local');
  await g.addConfig('user.name', 'T');
  await writeFile(join(targetUrl, 'README.md'), '# Hello\n');
  await writeFile(join(targetUrl, 'AGENTS.md'), '# Map\n');
  await writeFile(join(targetUrl, 'src-main.ts'), 'export {}\n');
  await mkdir(join(targetUrl, 'docs'), { recursive: true });
  await writeFile(join(targetUrl, 'docs', 'guide.md'), '# Guide\nbody\n');
  await writeFile(join(targetUrl, 'docs', 'logo.png'), 'png');
  await g.add('.');
  await g.commit('initial');

  repo = {
    key: 'app',
    url: targetUrl,
    defaultBranch: 'main',
    workflow: 'WORKFLOW.md',
    maxConcurrent: 1,
    adapter: null,
    readiness: 'ready',
  };
  // Provision so the bare mirror exists with default branch tips.
  const ws = new GitWorkspaces({ root, ports: new PortAllocator(4400, 4) });
  await ws.create(repo, 'seed-task');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function ws(): GitWorkspaces {
  return new GitWorkspaces({ root, ports: new PortAllocator(4410, 4) });
}

describe('listRepoDocs / readRepoDoc (trusted mirror, offline)', () => {
  it('lists only documentation paths on the default branch', async () => {
    const files = await ws().listRepoDocs(repo);
    expect(files).toContain('README.md');
    expect(files).toContain('AGENTS.md');
    expect(files).toContain('docs/guide.md');
    expect(files).not.toContain('src-main.ts');
    expect(files).not.toContain('docs/logo.png');
  });

  it('reads a doc at the default branch tip', async () => {
    const content = await ws().readRepoDoc(repo, 'docs/guide.md');
    expect(content).toContain('body');
  });

  it('rejects traversal / absolute / bad keys and missing files', async () => {
    const w = ws();
    expect(await w.readRepoDoc(repo, '../etc/passwd')).toBeNull();
    expect(await w.readRepoDoc(repo, '/etc/passwd')).toBeNull();
    expect(await w.readRepoDoc(repo, 'nope.md')).toBeNull();
    expect(await w.listRepoDocs({ ...repo, key: '../evil' })).toEqual([]);
  });
});
