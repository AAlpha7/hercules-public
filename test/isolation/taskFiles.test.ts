/**
 * Phone review needs to READ what a task produced — "Spot-check docs quality"
 * was unactionable from the phone (2026-07-22): the packet lists files touched
 * but nothing could show their content. These readers serve that, offline,
 * from the trusted mirror at the task's verified SHA (never a live worktree).
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
let branchSha: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'hercules-tf-'));
  root = join(tmp, 'root');
  await mkdir(root, { recursive: true });

  const targetUrl = join(tmp, 'target');
  await mkdir(targetUrl, { recursive: true });
  const g = simpleGit(targetUrl);
  await g.init(['-b', 'main']);
  await g.addConfig('user.email', 't@h.local');
  await g.addConfig('user.name', 'T');
  await writeFile(join(targetUrl, 'README.md'), '# target\n');
  await g.add('.');
  await g.commit('initial');
  // Task branch adds a doc — the thing the human wants to read.
  await g.checkoutLocalBranch('hercules/T-1');
  await mkdir(join(targetUrl, 'docs'), { recursive: true });
  await writeFile(join(targetUrl, 'docs', 'GUIDE.md'), '# Guide\nreal content\n');
  await writeFile(join(targetUrl, 'README.md'), '# target v2\n');
  await g.add('.');
  await g.commit('docs');
  branchSha = (await g.revparse(['HEAD'])).trim();
  await g.checkout('main');

  repo = {
    key: 'app', url: targetUrl, defaultBranch: 'main', workflow: 'WORKFLOW.md',
    maxConcurrent: 1, adapter: null, readiness: 'ready',
  };
  // Provision once so the mirror exists and carries the branch.
  const ws = new GitWorkspaces({ root, ports: new PortAllocator(4300, 4) });
  await ws.create(repo, 'T-1');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function ws(): GitWorkspaces {
  return new GitWorkspaces({ root, ports: new PortAllocator(4310, 4) });
}

describe('listTaskFiles / readTaskFile (trusted mirror, offline)', () => {
  it('lists files changed between default branch and the verified sha', async () => {
    const files = await ws().listTaskFiles(repo, branchSha);
    expect(files).toContain('docs/GUIDE.md');
    expect(files).toContain('README.md');
  });

  it('reads a file at the verified sha', async () => {
    const content = await ws().readTaskFile(repo, branchSha, 'docs/GUIDE.md');
    expect(content).toContain('real content');
  });

  it('rejects traversal, absolute paths, and bad shas', async () => {
    const w = ws();
    expect(await w.readTaskFile(repo, branchSha, '../etc/passwd')).toBeNull();
    expect(await w.readTaskFile(repo, branchSha, '/etc/passwd')).toBeNull();
    expect(await w.readTaskFile(repo, 'main; rm -rf /', 'README.md')).toBeNull();
    expect(await w.listTaskFiles(repo, 'not-a-sha!')).toEqual([]);
  });

  it('returns null for a file that does not exist at that sha', async () => {
    expect(await ws().readTaskFile(repo, branchSha, 'nope.md')).toBeNull();
  });
});
