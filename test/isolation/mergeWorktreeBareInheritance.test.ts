/**
 * Regression: disposable merge worktrees must not inherit bare-mirror state
 * after provider worktrees enable extensions.worktreeConfig on the shared
 * bare mirror (production B-013 / Guardian Merge Selected failure).
 *
 * Proves:
 * - provider setup enables shared worktreeConfig
 * - merge worktree reports core.bare=false
 * - merge worktree does not inherit provider deny-push URL/hooks
 * - mergeNoFf succeeds on the disposable handle
 * - dispose removes the worktree
 * - provider push remains denied afterward
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import type { RepoConfig } from '../../src/domain/repos.js';
import {
  PROVIDER_DENY_PUSH_URL,
  PROVIDER_PRE_PUSH_MARKER,
} from '../../src/isolation/providerPushBoundary.js';
import { GitWorkspaces } from '../../src/isolation/worktree.js';
import { PortAllocator } from '../../src/isolation/ports.js';

describe('merge worktree bare inheritance (real git)', { timeout: 60_000 }, () => {
  let tmp: string;
  let origin: string;
  let seed: string;
  let repo: RepoConfig;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'hercules-merge-bare-inherit-'));
    seed = join(tmp, 'seed');
    await mkdir(seed, { recursive: true });
    const git = simpleGit(seed);
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 'test@hercules.local');
    await git.addConfig('user.name', 'Hercules Test');
    await writeFile(join(seed, 'README.md'), '# seed\n');
    await git.add('.');
    await git.commit('seed');
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
      ports: new PortAllocator(4600, 20),
      push: true,
    });
  }

  it('merge worktree is non-bare after provider worktreeConfig and can merge --no-ff', async () => {
    const manager = workspaces();

    // Provider worktree enables extensions.worktreeConfig on the shared bare
    // mirror and installs deny-push controls on the provider tree only.
    const provider = await manager.create(repo, 'BARE-INHERIT');
    const providerGit = simpleGit(provider.dir);

    const worktreeConfig = (
      await providerGit.raw(['config', '--get', 'extensions.worktreeConfig'])
    ).trim();
    expect(worktreeConfig).toBe('true');

    expect((await providerGit.raw(['config', '--get', 'core.bare'])).trim()).toBe(
      'false',
    );
    expect(
      (await providerGit.raw(['config', '--get', 'remote.origin.pushurl'])).trim(),
    ).toBe(PROVIDER_DENY_PUSH_URL);

    const providerHooksPath = (
      await providerGit.raw(['config', '--get', 'core.hooksPath'])
    ).trim();
    expect(providerHooksPath.length).toBeGreaterThan(0);
    expect(providerHooksPath).toContain('hercules-provider-hooks');

    // Commit a feature tip that merge --no-ff can absorb (object already in
    // the shared mirror via the linked worktree).
    await providerGit.addConfig('user.email', 'a@h.local');
    await providerGit.addConfig('user.name', 'Agent');
    await writeFile(join(provider.dir, 'feat.txt'), 'feature\n');
    await providerGit.add(['-A']);
    await providerGit.raw([
      '-c', 'user.email=a@h.local', '-c', 'user.name=Agent',
      'commit', '-m', 'feat: bare-inherit merge tip',
    ]);
    const featSha = (await providerGit.revparse(['HEAD'])).trim().toLowerCase();
    expect(featSha).toMatch(/^[0-9a-f]{40}$/);

    // Provider push stays denied before and after the merge handle lifecycle.
    await expect(
      providerGit.push(['origin', 'HEAD:refs/heads/hercules/BARE-INHERIT']),
    ).rejects.toThrow();

    const handle = await manager.openMergeWorktree(repo);
    try {
      const mergeGit = simpleGit(handle.dir);

      // Critical: without ensureLinkedWorktreeUsable, linked trees inherit
      // core.bare=true from the bare common dir once worktreeConfig is on.
      expect((await mergeGit.raw(['config', '--get', 'core.bare'])).trim()).toBe(
        'false',
      );

      // Merge worktrees must NOT install provider deny-push controls —
      // Hercules still needs to push default after gates succeed.
      let mergePushurl = '';
      try {
        mergePushurl = (
          await mergeGit.raw(['config', '--get', 'remote.origin.pushurl'])
        ).trim();
      } catch {
        mergePushurl = '';
      }
      expect(mergePushurl).not.toBe(PROVIDER_DENY_PUSH_URL);

      let mergeHooksPath = '';
      try {
        mergeHooksPath = (
          await mergeGit.raw(['config', '--get', 'core.hooksPath'])
        ).trim();
      } catch {
        mergeHooksPath = '';
      }
      expect(mergeHooksPath).not.toContain('hercules-provider-hooks');
      expect(mergeHooksPath).not.toContain(PROVIDER_PRE_PUSH_MARKER);

      // The production failure mode: git merge --no-ff refused with
      // "this operation must be run in a work tree".
      const merged = await handle.mergeNoFf(
        featSha,
        'hercules: merge BARE-INHERIT',
      );
      expect(merged).toEqual({ ok: true });
    } finally {
      const mergeDir = handle.dir;
      await handle.dispose();
      await expect(stat(mergeDir)).rejects.toThrow();
    }

    await expect(
      providerGit.push(['origin', 'HEAD:refs/heads/hercules/BARE-INHERIT']),
    ).rejects.toThrow();
  });
});
