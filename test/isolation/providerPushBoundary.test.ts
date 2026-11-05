import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import type { RepoConfig } from '../../src/domain/repos.js';
import {
  applyProviderPushBoundary,
  ensureLinkedWorktreeUsable,
  PROVIDER_DENY_PUSH_URL,
  PROVIDER_PRE_PUSH_MARKER,
} from '../../src/isolation/providerPushBoundary.js';
import {
  pushTaskBranchWithExactLease,
  readRemoteTaskBranchTip,
} from '../../src/isolation/exactLeasePush.js';
import { GitWorkspaces } from '../../src/isolation/worktree.js';
import { PortAllocator } from '../../src/isolation/ports.js';

describe('provider push boundary (real git)', { timeout: 60_000 }, () => {
  let tmp: string;
  let origin: string;
  let seed: string;
  let mainTip: string;
  let repo: RepoConfig;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'hercules-push-boundary-'));
    seed = join(tmp, 'seed');
    await mkdir(seed, { recursive: true });
    const git = simpleGit(seed);
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 'test@hercules.local');
    await git.addConfig('user.name', 'Hercules Test');
    await writeFile(join(seed, 'README.md'), '# seed\n');
    await git.add('.');
    await git.commit('seed');
    mainTip = (await git.revparse(['HEAD'])).trim().toLowerCase();
    origin = join(tmp, 'origin.git');
    await simpleGit(tmp).clone(seed, origin, ['--bare']);
    repo = {
      key: 'app',
      url: origin,
      defaultBranch: 'main',
      workflow: 'WORKFLOW.md',
      maxConcurrent: 1,
      adapter: null,
      readiness: 'ready',
    };
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function workspaces(root = join(tmp, 'work')): GitWorkspaces {
    return new GitWorkspaces({
      root,
      ports: new PortAllocator(4400, 20),
      push: true,
    });
  }

  it('ordinary origin push and pushurl fail closed on provider worktrees', async () => {
    const manager = workspaces();
    const ws = await manager.create(repo, 'PUSH-DENY');
    const git = simpleGit(ws.dir);
    await git.addConfig('user.email', 'agent@hercules.local');
    await git.addConfig('user.name', 'Agent');
    await writeFile(join(ws.dir, 'agent.txt'), 'agent work\n');
    await git.add('.');
    await git.commit('agent: work');

    const pushurl = (await git.raw(['config', '--get', 'remote.origin.pushurl'])).trim();
    expect(pushurl).toBe(PROVIDER_DENY_PUSH_URL);

    const bare = (await git.raw(['config', '--get', 'core.bare'])).trim();
    expect(bare).toBe('false');

    const hooksPath = (await git.raw(['config', '--get', 'core.hooksPath'])).trim();
    expect(hooksPath.length).toBeGreaterThan(0);
    const hookBody = await readFile(join(hooksPath, 'pre-push'), 'utf8');
    expect(hookBody).toContain(PROVIDER_PRE_PUSH_MARKER);

    await expect(git.push(['origin', 'HEAD:refs/heads/hercules/PUSH-DENY'])).rejects.toThrow();
    // pushurl denied — even force cannot publish through origin.
    await expect(
      git.push(['origin', 'HEAD:refs/heads/hercules/PUSH-DENY', '--force']),
    ).rejects.toThrow();

    const remote = await readRemoteTaskBranchTip(simpleGit(origin), origin, 'hercules/PUSH-DENY');
    expect(remote).toBeNull();
  });

  it('Hercules exact CAS publisher still advances the remote task ref', async () => {
    const manager = workspaces();
    const ws = await manager.create(repo, 'CAS-OK', {
      expectedRemoteTip: null,
      expectedBaseRevision: mainTip,
    });
    const git = simpleGit(ws.dir);
    await git.addConfig('user.email', 'agent@hercules.local');
    await git.addConfig('user.name', 'Agent');
    await writeFile(join(ws.dir, 'feat.txt'), 'feature\n');
    await git.add('.');
    await git.commit('feat');
    const localTip = (await git.revparse(['HEAD'])).trim().toLowerCase();

    // Ordinary worktree push still denied.
    await expect(git.push(['origin', 'HEAD:refs/heads/hercules/CAS-OK'])).rejects.toThrow();

    // Hercules CAS from the mirror with explicit URL advances the remote ref.
    const mirror = join(tmp, 'work', '.mirrors', 'app.git');
    const mirrorGit = simpleGit(mirror);
    const published = await pushTaskBranchWithExactLease({
      git: mirrorGit,
      originUrl: origin,
      branch: 'hercules/CAS-OK',
      localTip,
      lease: {
        expectedBaseRevision: mainTip,
        expectedRemoteTip: null,
      },
      allowOwnedReset: false,
    });
    expect(published.expectedRemoteTip).toBe(localTip);
    const remote = await readRemoteTaskBranchTip(mirrorGit, origin, 'hercules/CAS-OK');
    expect(remote).toBe(localTip);

    // preserve path also publishes via CAS.
    const manager2 = workspaces(join(tmp, 'work2'));
    const ws2 = await manager2.create(repo, 'CAS-PRESERVE', {
      expectedRemoteTip: null,
      expectedBaseRevision: mainTip,
    });
    const g2 = simpleGit(ws2.dir);
    await g2.addConfig('user.email', 'agent@hercules.local');
    await g2.addConfig('user.name', 'Agent');
    await writeFile(join(ws2.dir, 'p.txt'), 'p\n');
    await g2.add('.');
    await g2.commit('preserve me');
    const result = await manager2.preserve('CAS-PRESERVE', 'hercules: CAS-PRESERVE');
    expect(result.notPropagated).toBe(false);
    expect(result.branchLease?.expectedRemoteTip).toMatch(/^[0-9a-f]{40}$/);
    const remote2 = await readRemoteTaskBranchTip(
      simpleGit(origin),
      origin,
      'hercules/CAS-PRESERVE',
    );
    expect(remote2).toBe(result.branchLease?.expectedRemoteTip);
  });

  it('restart reattach re-applies boundary and holds ownership', async () => {
    const root = join(tmp, 'work-restart');
    const manager = workspaces(root);
    const ws = await manager.create(repo, 'RESTART-HOLD', {
      expectedRemoteTip: null,
      expectedBaseRevision: mainTip,
    });
    const git0 = simpleGit(ws.dir);
    await git0.addConfig('user.email', 'agent@hercules.local');
    await git0.addConfig('user.name', 'Agent');
    await writeFile(join(ws.dir, 'r.txt'), 'restart\n');
    await git0.add('.');
    await git0.commit('restart work');
    // Publish via Hercules CAS so durable ownership is held on origin.
    const preserved = await manager.preserve('RESTART-HOLD', 'hercules: RESTART-HOLD');
    const tip = preserved.branchLease?.expectedRemoteTip;
    expect(tip).toMatch(/^[0-9a-f]{40}$/);

    // Simulate process restart: new manager, same root, re-create with held lease.
    const restarted = new GitWorkspaces({
      root,
      ports: new PortAllocator(4500, 10),
      push: true,
    });
    const again = await restarted.create(repo, 'RESTART-HOLD', {
      expectedRemoteTip: tip!,
      expectedBaseRevision: mainTip,
      hadPriorWork: true,
    });
    expect(again.branchLease.expectedRemoteTip).toBe(tip);

    const git = simpleGit(again.dir);
    const pushurl = (await git.raw(['config', '--get', 'remote.origin.pushurl'])).trim();
    expect(pushurl).toBe(PROVIDER_DENY_PUSH_URL);
    await expect(git.push(['origin', 'HEAD:refs/heads/hercules/RESTART-HOLD'])).rejects.toThrow();

    // Ownership still held — remote tip unchanged and matches lease.
    const remote = await readRemoteTaskBranchTip(
      simpleGit(origin),
      origin,
      'hercules/RESTART-HOLD',
    );
    expect(remote).toBe(tip);
  });

  it('ensureLinkedWorktreeUsable sets worktree-local core.bare=false', async () => {
    const manager = workspaces(join(tmp, 'work-usable'));
    // Create without relying on full boundary first — use manager create which
    // applies boundary; then re-run ensure to prove idempotence.
    const ws = await manager.create(repo, 'USABLE');
    await ensureLinkedWorktreeUsable(ws.dir);
    await applyProviderPushBoundary(ws.dir);
    const bare = (await simpleGit(ws.dir).raw(['config', '--get', 'core.bare'])).trim();
    expect(bare).toBe('false');
  });

  it('openMergeWorktree is non-bare after worktreeConfig and can merge --no-ff', async () => {
    const manager = workspaces(join(tmp, 'work-merge-bare'));
    // Production B-013: merge worktree inherited core.bare=true once provider
    // boundary enabled extensions.worktreeConfig on the shared bare mirror.
    const provider = await manager.create(repo, 'PROV-BARE');
    const providerGit = simpleGit(provider.dir);
    expect((await providerGit.raw(['config', '--get', 'core.bare'])).trim()).toBe('false');
    expect((await providerGit.raw(['config', '--get', 'remote.origin.pushurl'])).trim()).toBe(
      PROVIDER_DENY_PUSH_URL,
    );

    await providerGit.addConfig('user.email', 'a@h.local');
    await providerGit.addConfig('user.name', 'Agent');
    await writeFile(join(provider.dir, 'feat.txt'), 'feature');
    await providerGit.add(['-A']);
    await providerGit.raw([
      '-c', 'user.email=a@h.local', '-c', 'user.name=Agent',
      'commit', '-m', 'feat: mergeable tip',
    ]);
    const featSha = (await providerGit.revparse(['HEAD'])).trim().toLowerCase();
    expect(featSha).toMatch(/^[0-9a-f]{40}$/);

    await expect(
      providerGit.push(['origin', 'HEAD:refs/heads/hercules/PROV-BARE']),
    ).rejects.toThrow();
    const handle = await manager.openMergeWorktree(repo);
    try {
      const mergeGit = simpleGit(handle.dir);
      expect((await mergeGit.raw(['config', '--get', 'core.bare'])).trim()).toBe('false');
      let mergePushurl = '';
      try {
        mergePushurl = (await mergeGit.raw(['config', '--get', 'remote.origin.pushurl'])).trim();
      } catch {
        mergePushurl = '';
      }
      expect(mergePushurl).not.toBe(PROVIDER_DENY_PUSH_URL);

      const merged = await handle.mergeNoFf(featSha, 'hercules: merge PROV-BARE');
      expect(merged).toEqual({ ok: true });
    } finally {
      const mergeDir = handle.dir;
      await handle.dispose();
      await expect(stat(mergeDir)).rejects.toThrow();
    }

    await expect(
      providerGit.push(['origin', 'HEAD:refs/heads/hercules/PROV-BARE']),
    ).rejects.toThrow();
  });
});
