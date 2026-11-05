import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Real-git suite: 5 s per test flakes under host load (parallel reviewers /
// check:full); the assertions are not timing-sensitive.
vi.setConfig({ testTimeout: 20_000 });
import { simpleGit } from 'simple-git';
import { observeRegisteredCheckouts } from '../../src/isolation/checkoutObserve.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repo(): Promise<{ dir: string; base: string; canonical: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'hercules-succession-observe-'));
  roots.push(dir);
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig('user.name', 'Hercules Test');
  await git.addConfig('user.email', 'test@invalid.example');
  await writeFile(join(dir, 'tracked.txt'), 'base\n');
  await git.add('tracked.txt');
  await git.commit('base');
  const base = await git.revparse(['HEAD']);
  await writeFile(join(dir, 'tracked.txt'), 'canonical\n');
  await git.add('tracked.txt');
  await git.commit('canonical');
  return { dir, base: base.trim(), canonical: (await git.revparse(['HEAD'])).trim() };
}

async function immutableSnapshot(dir: string): Promise<string> {
  const git = simpleGit(dir);
  const head = (await git.revparse(['HEAD'])).trim();
  const status = await git.raw(['status', '--porcelain=v1', '-uall']);
  const refs = await git.raw(['show-ref']);
  const tracked = await readFile(join(dir, 'tracked.txt'), 'utf8');
  return JSON.stringify({ head, status, refs, tracked });
}

async function rawCheckoutSnapshot(dir: string): Promise<string> {
  const gitDir = (await simpleGit(dir).revparse(['--git-dir'])).trim();
  const absoluteGitDir = gitDir.startsWith('/') ? gitDir : join(dir, gitDir);
  const indexPath = join(absoluteGitDir, 'index');
  const indexBytes = await readFile(indexPath);
  const indexStat = await stat(indexPath, { bigint: true });
  const headBytes = await readFile(join(absoluteGitDir, 'HEAD'));
  const trackedBytes = await readFile(join(dir, 'tracked.txt'));
  const trackedStat = await stat(join(dir, 'tracked.txt'), { bigint: true });
  const refs = await simpleGit(dir).raw(['show-ref']);
  return JSON.stringify({
    index: indexBytes.toString('base64'),
    indexStat: [indexStat.mode, indexStat.size, indexStat.mtimeNs, indexStat.ctimeNs].map(String),
    head: headBytes.toString('base64'),
    refs,
    tracked: trackedBytes.toString('base64'),
    trackedStat: [trackedStat.mode, trackedStat.size, trackedStat.mtimeNs, trackedStat.ctimeNs].map(String),
  });
}

describe('read-only registered checkout observation (real git)', () => {
  it('classifies current, behind, ahead, diverged, dirty and missing without mutation', async () => {
    const current = await repo();
    const behind = await repo();
    await simpleGit(behind.dir).checkout(behind.base);

    const ahead = await repo();
    await writeFile(join(ahead.dir, 'ahead.txt'), 'local\n');
    await simpleGit(ahead.dir).add('ahead.txt');
    await simpleGit(ahead.dir).commit('ahead');
    const aheadCanonical = ahead.canonical;

    const diverged = await repo();
    await simpleGit(diverged.dir).checkout(diverged.base);
    await writeFile(join(diverged.dir, 'side.txt'), 'side\n');
    await simpleGit(diverged.dir).add('side.txt');
    await simpleGit(diverged.dir).commit('side');

    const dirty = await repo();
    await writeFile(join(dirty.dir, 'tracked.txt'), 'dirty\n');

    const cases = [
      { id: 'current', path: current.dir, canonical: current.canonical, expected: 'current' },
      { id: 'behind', path: behind.dir, canonical: behind.canonical, expected: 'clean-behind' },
      { id: 'ahead', path: ahead.dir, canonical: aheadCanonical, expected: 'local-ahead' },
      { id: 'diverged', path: diverged.dir, canonical: diverged.canonical, expected: 'diverged' },
      { id: 'dirty', path: dirty.dir, canonical: dirty.canonical, expected: 'dirty' },
    ] as const;
    for (const item of cases) {
      const before = await immutableSnapshot(item.path);
      const [observed] = await observeRegisteredCheckouts(
        [{ id: item.id, path: item.path }], item.canonical,
      );
      expect(observed?.classification).toBe(item.expected);
      expect(await immutableSnapshot(item.path)).toBe(before);
      expect(JSON.stringify(observed)).not.toContain(item.path);
    }
    const [missing] = await observeRegisteredCheckouts(
      [{ id: 'missing', path: join(current.dir, 'not-there') }], current.canonical,
    );
    expect(missing?.classification).toBe('unavailable');
  });

  it('marks a concurrent HEAD move unknown and never rewrites the checkout', async () => {
    const target = await repo();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let observedInitial!: () => void;
    const initialRead = new Promise<void>((resolve) => { observedInitial = resolve; });
    const observing = observeRegisteredCheckouts(
      [{ id: 'owner-main', path: target.dir }], target.canonical,
      { beforeFinalHeadRead: async () => {
        observedInitial();
        await barrier;
      } },
    );
    await initialRead;
    await writeFile(join(target.dir, 'concurrent.txt'), 'owner\n');
    await simpleGit(target.dir).add('concurrent.txt');
    await simpleGit(target.dir).commit('owner concurrent commit');
    const ownerHead = (await simpleGit(target.dir).revparse(['HEAD'])).trim();
    release();
    const [observed] = await observing;
    expect(observed).toMatchObject({ classification: 'unknown', concurrentChange: true });
    expect((await simpleGit(target.dir).revparse(['HEAD'])).trim()).toBe(ownerHead);
  });

  it('leaves stale index bytes/stat, refs, and worktree bytes/metadata exactly unchanged', async () => {
    const target = await repo();
    const tracked = join(target.dir, 'tracked.txt');
    const beforeDirty = await stat(tracked);
    await writeFile(tracked, 'stale-stat\n');
    await utimes(tracked, beforeDirty.atime, beforeDirty.mtime);
    const before = await rawCheckoutSnapshot(target.dir);
    const [observed] = await observeRegisteredCheckouts(
      [{ id: 'stale-index', path: target.dir }], target.canonical,
    );
    expect(observed?.classification).toBe('dirty');
    expect(await rawCheckoutSnapshot(target.dir)).toBe(before);
  });

  it('disables a hostile configured fsmonitor without executing its sentinel', async () => {
    const target = await repo();
    const sentinel = join(target.dir, 'fsmonitor-ran');
    const hook = join(target.dir, 'hostile-fsmonitor.sh');
    await writeFile(hook, `#!/bin/sh\ntouch "${sentinel}"\nexit 0\n`);
    await chmod(hook, 0o755);
    await mkdir(join(target.dir, '.git', 'info'), { recursive: true });
    await writeFile(join(target.dir, '.git', 'info', 'exclude'), 'hostile-fsmonitor.sh\n');
    await simpleGit({
      baseDir: target.dir,
      unsafe: { allowUnsafeFsMonitor: true },
    }).addConfig('core.fsmonitor', hook);
    const [observed] = await observeRegisteredCheckouts(
      [{ id: 'hostile-monitor', path: target.dir }], target.canonical,
    );
    expect(observed?.classification).toBe('current');
    await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('marks a dirty-only concurrent byte change unknown', async () => {
    const target = await repo();
    await writeFile(join(target.dir, 'tracked.txt'), 'dirty-one\n');
    const [observed] = await observeRegisteredCheckouts(
      [{ id: 'dirty-race', path: target.dir }], target.canonical,
      { beforeFinalHeadRead: async () => {
        await writeFile(join(target.dir, 'tracked.txt'), 'dirty-two\n');
      } },
    );
    expect(observed).toMatchObject({ classification: 'unknown', concurrentChange: true });
  });

  it('bounds a blocked git command and degrades to unknown', async () => {
    const target = await repo();
    const blocker = join(target.dir, 'blocked-git.sh');
    await writeFile(blocker, '#!/bin/sh\nsleep 30\n');
    await chmod(blocker, 0o755);
    const started = Date.now();
    const [observed] = await observeRegisteredCheckouts(
      [{ id: 'blocked', path: target.dir }], target.canonical,
      { gitBinary: blocker, commandTimeoutMs: 50 },
    );
    expect(observed?.classification).toBe('unknown');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
