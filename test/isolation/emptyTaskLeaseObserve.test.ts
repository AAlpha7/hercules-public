import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Real-git suite: 5 s per test flakes under host load (parallel reviewers /
// check:full); the assertions are not timing-sensitive.
vi.setConfig({ testTimeout: 20_000 });
import { observeEmptyTaskLease } from '../../src/isolation/emptyTaskLeaseObserve.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  root: string;
  origin: string;
  mirror: string;
  worktree: string;
  base: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'hercules-empty-lease-'));
  roots.push(root);
  const source = join(root, 'source');
  const origin = join(root, 'origin.git');
  const mirror = join(root, 'mirror.git');
  const worktree = join(root, 'worktree');
  await mkdir(source);
  const sourceGit = simpleGit(source);
  await sourceGit.init(['-b', 'main']);
  await sourceGit.addConfig('user.name', 'Hercules Test');
  await sourceGit.addConfig('user.email', 'test@invalid.example');
  await writeFile(join(source, 'tracked.txt'), 'base\n');
  await sourceGit.add('tracked.txt');
  await sourceGit.commit('base');
  const base = (await sourceGit.revparse(['HEAD'])).trim().toLowerCase();
  await simpleGit().clone(source, origin, ['--bare']);
  await simpleGit().clone(origin, mirror, ['--bare']);
  await simpleGit(mirror).raw(['worktree', 'add', '-b', 'hercules/EMPTY', worktree, base]);
  // Linked worktrees share the mirror gitdir; set identity there so commits in
  // reject/stale lanes do not depend on a host-global git user (CI has none).
  const worktreeGit = simpleGit(worktree);
  await worktreeGit.addConfig('user.name', 'Hercules Test');
  await worktreeGit.addConfig('user.email', 'test@invalid.example');
  return { root, origin, mirror, worktree, base };
}

async function rawSnapshot(item: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const gitDirRaw = (await simpleGit(item.worktree).revparse(['--git-dir'])).trim();
  const gitDir = gitDirRaw.startsWith('/') ? gitDirRaw : join(item.worktree, gitDirRaw);
  const indexPath = join(gitDir, 'index');
  const index = await readFile(indexPath);
  const indexStat = await stat(indexPath, { bigint: true });
  const refs = await simpleGit(item.mirror).raw(['show-ref']);
  const tracked = await readFile(join(item.worktree, 'tracked.txt'));
  const trackedStat = await stat(join(item.worktree, 'tracked.txt'), { bigint: true });
  return JSON.stringify({
    index: index.toString('base64'),
    indexStat: [indexStat.mode, indexStat.size, indexStat.mtimeNs, indexStat.ctimeNs].map(String),
    refs,
    tracked: tracked.toString('base64'),
    trackedStat: [trackedStat.mode, trackedStat.size, trackedStat.mtimeNs, trackedStat.ctimeNs].map(String),
  });
}

describe('read-only empty task lease observation (real Git)', () => {
  it('accepts an absent remote ref and an exact-base empty ref without mutation', async () => {
    for (const publishBase of [false, true]) {
      const item = await fixture();
      if (publishBase) {
        await simpleGit(item.mirror).raw([
          'push', item.origin, `${item.base}:refs/heads/hercules/EMPTY`,
        ]);
      }
      const before = await rawSnapshot(item);
      await expect(observeEmptyTaskLease({
        mirrorDir: item.mirror,
        workspaceDir: item.worktree,
        defaultBranch: 'main',
        taskId: 'EMPTY',
        expectedBaseRevision: item.base,
      })).resolves.toEqual({ kind: 'empty', remoteTip: publishBase ? item.base : null });
      expect(await rawSnapshot(item)).toBe(before);
    }
  });

  it('rejects candidate/ref movement, dirty and unique work without mutation', async () => {
    const remoteCandidate = await fixture();
    const remoteWriter = join(remoteCandidate.root, 'remote-writer');
    await simpleGit().clone(remoteCandidate.origin, remoteWriter);
    await simpleGit(remoteWriter).addConfig('user.name', 'Hercules Test');
    await simpleGit(remoteWriter).addConfig('user.email', 'test@invalid.example');
    await writeFile(join(remoteWriter, 'remote.txt'), 'candidate\n');
    await simpleGit(remoteWriter).add('remote.txt');
    await simpleGit(remoteWriter).commit('remote candidate');
    await simpleGit(remoteWriter).raw(['push', 'origin', 'HEAD:refs/heads/hercules/EMPTY']);
    const remoteBefore = await rawSnapshot(remoteCandidate);
    await expect(observeEmptyTaskLease({
      mirrorDir: remoteCandidate.mirror, workspaceDir: remoteCandidate.worktree,
      defaultBranch: 'main', taskId: 'EMPTY', expectedBaseRevision: remoteCandidate.base,
    })).resolves.toMatchObject({ kind: 'held', code: 'remote_candidate' });
    expect(await rawSnapshot(remoteCandidate)).toBe(remoteBefore);

    const candidate = await fixture();
    const writer = simpleGit(candidate.worktree);
    await writeFile(join(candidate.worktree, 'candidate.txt'), 'candidate\n');
    await writer.add('candidate.txt');
    await writer.commit('candidate');
    await writer.raw(['push', candidate.origin, 'HEAD:refs/heads/hercules/EMPTY']);
    const candidateBefore = await rawSnapshot(candidate);
    await expect(observeEmptyTaskLease({
      mirrorDir: candidate.mirror, workspaceDir: candidate.worktree,
      defaultBranch: 'main', taskId: 'EMPTY', expectedBaseRevision: candidate.base,
    })).resolves.toMatchObject({ kind: 'held', code: 'unique_work' });
    expect(await rawSnapshot(candidate)).toBe(candidateBefore);

    const dirty = await fixture();
    await writeFile(join(dirty.worktree, 'tracked.txt'), 'dirty\n');
    const dirtyBefore = await rawSnapshot(dirty);
    await expect(observeEmptyTaskLease({
      mirrorDir: dirty.mirror, workspaceDir: dirty.worktree,
      defaultBranch: 'main', taskId: 'EMPTY', expectedBaseRevision: dirty.base,
    })).resolves.toMatchObject({ kind: 'held', code: 'dirty_worktree' });
    expect(await rawSnapshot(dirty)).toBe(dirtyBefore);

    const moved = await fixture();
    const movedWriter = join(moved.root, 'moved-writer');
    await simpleGit().clone(moved.origin, movedWriter);
    await simpleGit(movedWriter).addConfig('user.name', 'Hercules Test');
    await simpleGit(movedWriter).addConfig('user.email', 'test@invalid.example');
    await writeFile(join(movedWriter, 'remote-race.txt'), 'race\n');
    await simpleGit(movedWriter).add('remote-race.txt');
    await simpleGit(movedWriter).commit('remote race');
    const movedTip = (await simpleGit(movedWriter).revparse(['HEAD'])).trim();
    const movedBefore = await rawSnapshot(moved);
    await expect(observeEmptyTaskLease({
      mirrorDir: moved.mirror, workspaceDir: moved.worktree,
      defaultBranch: 'main', taskId: 'EMPTY', expectedBaseRevision: moved.base,
      beforeFinalObservation: async () => {
        await simpleGit(movedWriter).raw([
          'push', 'origin', `${movedTip}:refs/heads/hercules/EMPTY`,
        ]);
      },
    })).resolves.toMatchObject({ kind: 'held', code: 'concurrent_change' });
    expect(await rawSnapshot(moved)).toBe(movedBefore);
  });

  it('fails closed on stale base, timeout, malformed output, and hostile fsmonitor', async () => {
    const stale = await fixture();
    await simpleGit(stale.mirror).raw(['update-ref', 'refs/heads/main', `${stale.base}^{}`]);
    const source = simpleGit(stale.worktree);
    await writeFile(join(stale.worktree, 'next.txt'), 'next\n');
    await source.add('next.txt');
    await source.commit('next');
    const next = (await source.revparse(['HEAD'])).trim();
    await simpleGit(stale.mirror).raw(['update-ref', 'refs/heads/main', next]);
    await expect(observeEmptyTaskLease({
      mirrorDir: stale.mirror, workspaceDir: stale.worktree,
      defaultBranch: 'main', taskId: 'EMPTY', expectedBaseRevision: stale.base,
    })).resolves.toMatchObject({ kind: 'held', code: 'base_moved' });

    const timeout = await fixture();
    const blocker = join(timeout.root, 'blocked-git.sh');
    await writeFile(blocker, '#!/bin/sh\nsleep 30\n');
    await chmod(blocker, 0o755);
    const started = Date.now();
    await expect(observeEmptyTaskLease({
      mirrorDir: timeout.mirror, workspaceDir: timeout.worktree,
      defaultBranch: 'main', taskId: 'EMPTY', expectedBaseRevision: timeout.base,
      gitBinary: blocker, commandTimeoutMs: 50,
    })).resolves.toMatchObject({ kind: 'held', code: 'proof_unavailable' });
    expect(Date.now() - started).toBeLessThan(2_000);

    const malformed = await fixture();
    const badGit = join(malformed.root, 'bad-git.sh');
    await writeFile(badGit, '#!/bin/sh\nprintf malformed\n');
    await chmod(badGit, 0o755);
    await expect(observeEmptyTaskLease({
      mirrorDir: malformed.mirror, workspaceDir: malformed.worktree,
      defaultBranch: 'main', taskId: 'EMPTY', expectedBaseRevision: malformed.base,
      gitBinary: badGit,
    })).resolves.toMatchObject({ kind: 'held', code: 'ambiguous_git' });

    const hostile = await fixture();
    const sentinel = join(hostile.root, 'fsmonitor-ran');
    const hook = join(hostile.root, 'fsmonitor.sh');
    await writeFile(hook, `#!/bin/sh\ntouch "${sentinel}"\n`);
    await chmod(hook, 0o755);
    await simpleGit({ baseDir: hostile.worktree, unsafe: { allowUnsafeFsMonitor: true } })
      .addConfig('core.fsmonitor', hook);
    const tracked = join(hostile.worktree, 'tracked.txt');
    const trackedStat = await stat(tracked);
    await utimes(tracked, trackedStat.atime, trackedStat.mtime);
    await observeEmptyTaskLease({
      mirrorDir: hostile.mirror, workspaceDir: hostile.worktree,
      defaultBranch: 'main', taskId: 'EMPTY', expectedBaseRevision: hostile.base,
    });
    await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
