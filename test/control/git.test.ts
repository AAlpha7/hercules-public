import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmod, mkdtemp, mkdir, writeFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { ControlConflictError, ControlDurabilityError, ControlGit } from '../../src/control/git.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hercules-git-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Init a git repo with an initial commit and a deterministic identity. */
async function initRepo(dir: string): Promise<ReturnType<typeof simpleGit>> {
  await mkdir(dir, { recursive: true });
  const git = simpleGit({ baseDir: dir, unsafe: { allowUnsafeHooksPath: true } });
  await git.init(['-b', 'main']);
  await git.addConfig('core.hooksPath', join(dir, '.git', 'no-hooks'));
  await git.addConfig('user.email', 'test@hercules.local');
  await git.addConfig('user.name', 'Hercules Test');
  await writeFile(join(dir, 'README'), 'seed');
  await git.add('.');
  await git.commit('seed');
  return git;
}

describe('ControlGit.commitAll', () => {
  it('stages and commits working-tree changes and reports the hash', async () => {
    await initRepo(root);
    const cg = new ControlGit(root);

    await writeFile(join(root, 'a.md'), 'hello');
    const result = await cg.commitAll('add a');

    expect(result.committed).toBe(true);
    expect(result.hash).toMatch(/^[0-9a-f]{7,40}$/);

    const log = await simpleGit(root).log();
    expect(log.latest?.message).toBe('add a');
  });

  it('reports committed:false when there is nothing to commit', async () => {
    await initRepo(root);
    const cg = new ControlGit(root);
    const result = await cg.commitAll('noop');
    expect(result.committed).toBe(false);
    expect(result.hash).toBeUndefined();
  });

  it('supports the first commit in an explicitly unborn repository', async () => {
    const git = simpleGit({ baseDir: root, unsafe: { allowUnsafeHooksPath: true } });
    await git.init(['-b', 'main']);
    await git.addConfig('core.hooksPath', join(root, '.git', 'no-hooks'));
    await git.addConfig('user.email', 'test@hercules.local');
    await git.addConfig('user.name', 'Hercules Test');
    await writeFile(join(root, 'README'), 'seed');

    const result = await new ControlGit(root).commitAll('first');
    expect(result).toMatchObject({ committed: true });
    expect(result.hash).toMatch(/^[0-9a-f]{40}$/);
    expect((await git.revparse(['HEAD'])).trim()).toBe(result.hash);
  });

  it('throws a typed durability error when a pre-commit hook leaves HEAD unchanged', async () => {
    const git = await initRepo(root);
    const before = (await git.revparse(['HEAD'])).trim();
    const hookDir = join(root, '.git', 'failing-hooks');
    await mkdir(hookDir, { recursive: true });
    const hook = join(hookDir, 'pre-commit');
    await writeFile(hook, '#!/bin/sh\nexit 1\n');
    await chmod(hook, 0o755);
    await git.addConfig('core.hooksPath', hookDir);
    await writeFile(join(root, 'blocked.md'), 'not durable');

    await expect(new ControlGit(root).commitAll('blocked')).rejects.toBeInstanceOf(
      ControlDurabilityError,
    );
    expect((await git.revparse(['HEAD'])).trim()).toBe(before);
  });
});

describe('ControlGit.commitPaths', () => {
  it('commits only the declared paths', async () => {
    await initRepo(root);
    await writeFile(join(root, 'selected.md'), 'selected');
    const result = await new ControlGit(root).commitPaths(['selected.md'], 'selected only');
    expect(result.committed).toBe(true);
    expect((await simpleGit(root).show(['--name-only', '--format=', 'HEAD'])).trim()).toBe('selected.md');
  });

  it('returns a typed bounded conflict instead of sweeping unrelated dirt', async () => {
    await initRepo(root);
    await writeFile(join(root, 'selected.md'), 'selected');
    await writeFile(join(root, 'unrelated.md'), 'external');
    await expect(new ControlGit(root).commitPaths(['selected.md'], 'selected only'))
      .rejects.toBeInstanceOf(ControlConflictError);
    expect((await simpleGit(root).log()).latest?.message).toBe('seed');
  });
});

describe('ControlGit exact reads', () => {
  it('fails closed when a present staged blob cannot be read', async () => {
    const git = await initRepo(root);
    const path = 'staged.md';
    await writeFile(join(root, path), 'staged bytes');
    await git.add(path);
    const object = (await git.raw(['rev-parse', `:${path}`])).trim();
    await unlink(join(root, '.git', 'objects', object.slice(0, 2), object.slice(2)));

    await expect(new ControlGit(root).readPathAtIndex(path)).rejects.toThrow();
  });

  it('reports both source and destination paths for a staged rename', async () => {
    const git = await initRepo(root);
    await writeFile(join(root, 'source.md'), 'rename bytes');
    await git.add('source.md');
    await git.commit('add rename source');
    await git.mv('source.md', 'destination.md');

    await expect(new ControlGit(root).statusPaths()).resolves.toEqual([
      'destination.md',
      'source.md',
    ]);
  });

  it('lists regular task blobs of an exact revision in one call and reads them by oid', async () => {
    const git = await initRepo(root);
    await mkdir(join(root, 'tasks'), { recursive: true });
    await writeFile(join(root, 'tasks', 'b.md'), 'task b');
    await writeFile(join(root, 'tasks', 'a.md'), 'task a');
    await writeFile(join(root, 'tasks', 'link.md'), 'ignored');
    await git.add('.');
    await git.commit('tasks');
    // A symlink entry (mode 120000) is a blob to git but never a task file.
    const { symlink } = await import('node:fs/promises');
    await unlink(join(root, 'tasks', 'link.md'));
    await symlink('a.md', join(root, 'tasks', 'link.md'));
    await git.add('.');
    await git.commit('link');
    const revision = (await git.revparse(['HEAD'])).trim();
    const cg = new ControlGit(root);

    const blobs = await cg.listBlobsAtRevision(revision, 'tasks');
    expect(blobs.map((blob) => blob.path)).toEqual(['tasks/a.md', 'tasks/b.md']);
    expect(blobs.every((blob) => /^[0-9a-f]{40}$/.test(blob.oid))).toBe(true);
    await expect(cg.readBlob(blobs[0]!.oid)).resolves.toBe('task a');
    await expect(cg.readBlob(blobs[1]!.oid)).resolves.toBe('task b');
    // Agrees with the per-path exact read.
    await expect(cg.readPathAtRevision(revision, 'tasks/b.md')).resolves.toBe('task b');
    await expect(cg.listBlobsAtRevision(revision, 'nope')).resolves.toEqual([]);
    await expect(cg.listBlobsAtRevision('HEAD', 'tasks')).rejects.toThrow(ControlDurabilityError);
    await expect(cg.readBlob('HEAD')).rejects.toThrow(ControlDurabilityError);
  });
});

describe('ControlGit.pull', () => {
  it('fast-forwards from a remote', async () => {
    // Set up an "origin" working repo, clone it, then advance origin and pull.
    const originWork = join(root, 'origin-work');
    const bare = join(root, 'origin.git');
    const clone = join(root, 'clone');

    const originGit = await initRepo(originWork);
    await simpleGit(root).clone(originWork, bare, ['--bare']);
    await originGit.addRemote('origin', bare);
    await originGit.push('origin', 'main');

    await simpleGit(root).clone(bare, clone);
    const cloneGit = simpleGit(clone);
    await cloneGit.addConfig('user.email', 'c@hercules.local');
    await cloneGit.addConfig('user.name', 'Clone');

    // Advance origin.
    await writeFile(join(originWork, 'new.md'), 'fresh');
    await originGit.add('.');
    await originGit.commit('advance');
    await originGit.push('origin', 'main');

    const cg = new ControlGit(clone);
    await cg.pull();

    const log = await cloneGit.log();
    expect(log.latest?.message).toBe('advance');
  });
});
