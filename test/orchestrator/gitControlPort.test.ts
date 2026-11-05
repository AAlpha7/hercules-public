import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  access, chmod, mkdtemp, mkdir, readFile, readdir, rename, symlink, writeFile, rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import {
  ControlRecoveryError,
  GitControlPort,
  SimulatedControlInterruption,
  removeDurableFile,
} from '../../src/orchestrator/gitControlPort.js';
import type { Task } from '../../src/domain/task.js';
import { parseReposConfig } from '../../src/control/reposConfig.js';
import { serializeTask } from '../../src/control/taskFile.js';
import type { ReposConfig } from '../../src/domain/repos.js';
import { ControlDurabilityError } from '../../src/control/git.js';
import type { WorkspaceSuccessionLedger } from '../../src/domain/workspaceSuccession.js';
import { appendSuccessionReceipt, buildSuccessionReceipt } from '../../src/domain/workspaceSuccession.js';
import { ShadowOutboxError } from '../../src/orchestrator/shadowDeliveryOutbox.js';

let dir: string;
const extraRoots: string[] = [];

const REPOS = `repos:
  app:
    url: git@github.com:me/app.git
    default_branch: main
`;

const TASK: Task = {
  id: 'ABC-1',
  title: 'Seeded task',
  repo: 'app',
  state: 'todo',
  priority: 1,
  blockedBy: [],
  labels: [],
  adapter: null,
  agentSession: null,
    pendingSteer: null,
  attempts: 0,
  lastEventAt: null, createdAt: null, startedAt: null, endedAt: null,
  prUrl: null,
  prStatus: null,
  planPending: false,
  body: 'do it',
};

const SUCCESSION: WorkspaceSuccessionLedger = {
  version: 2,
  repoKey: 'app',
  receipts: [{
    id: `succ-app-${'3'.repeat(40)}`,
    repoKey: 'app',
    createdAt: '2026-08-04T12:00:00.000Z',
    priorDefaultRevision: '1'.repeat(40),
    gateMergeSha: '3'.repeat(40),
    canonicalDefaultRevision: '3'.repeat(40),
    candidates: [{ taskId: 'ABC-1', verifiedSha: '2'.repeat(40), lease: {
      branch: 'hercules/ABC-1',
      expectedBaseRevision: '1'.repeat(40),
      expectedRemoteTip: '2'.repeat(40),
    } }],
    managed: [{ taskId: 'ABC-1', disposition: 'preserved' }],
    external: [],
    supersedesReceiptId: null,
  }],
};

const SUCCESSION_NEXT: WorkspaceSuccessionLedger = {
  ...SUCCESSION,
  receipts: [...SUCCESSION.receipts, {
    ...SUCCESSION.receipts[0]!,
    id: `succ-app-${'6'.repeat(40)}`,
    createdAt: '2026-08-04T13:00:00.000Z',
    priorDefaultRevision: '3'.repeat(40),
    gateMergeSha: '6'.repeat(40),
    canonicalDefaultRevision: '6'.repeat(40),
    supersedesReceiptId: SUCCESSION.receipts[0]!.id,
  }],
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hercules-port-'));
  const git = simpleGit({ baseDir: dir, unsafe: { allowUnsafeHooksPath: true } });
  await git.init(['-b', 'main']);
  await git.addConfig('core.hooksPath', join(dir, '.git', 'no-hooks'));
  await git.addConfig('user.email', 't@hercules.local');
  await git.addConfig('user.name', 'T');
  await writeFile(join(dir, 'repos.yaml'), REPOS);
  await mkdir(join(dir, 'tasks'), { recursive: true });
  await writeFile(
    join(dir, 'tasks', 'ABC-1.md'),
    `---\ntitle: Seeded task\nrepo: app\nstate: todo\npriority: 1\n---\ndo it\n`,
  );
  await git.add('.');
  await git.commit('seed');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  for (const root of extraRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('GitControlPort', () => {
  it('does not construct a shadow outbox when explicit shadow mode is absent', async () => {
    const port = new GitControlPort(dir);
    await port.read();
    await expect(access(join(dir, '.git', 'hercules-shadow-delivery'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('restores an interrupted create before commit from the common shadow outbox', async () => {
    const before = await simpleGit(dir).revparse(['HEAD']);
    const created = { ...TASK, id: 'SHADOW-CREATE' };
    const crashing = new GitControlPort(dir, {
      authoritativeTaskCommit: async () => {},
      afterCreateWrites: async () => 'interrupt',
    });
    await expect(crashing.createTaskCommitted(created, 'create shadow task'))
      .rejects.toBeInstanceOf(SimulatedControlInterruption);
    expect(await readFile(join(dir, 'tasks', 'SHADOW-CREATE.md'), 'utf8')).toContain('Seeded task');

    const recovered = new GitControlPort(dir, { authoritativeTaskCommit: async () => {} });
    expect((await recovered.read()).tasks.some((item) => item.id === 'SHADOW-CREATE')).toBe(false);
    expect(await simpleGit(dir).revparse(['HEAD'])).toBe(before);
    expect((await simpleGit(dir).status()).isClean()).toBe(true);
  });

  it('retains recovery evidence when interrupted after file, directory, and index fsync', async () => {
    const crashing = new GitControlPort(dir, {
      authoritativeTaskCommit: async () => {},
      afterCompareAndSetWrites: async () => 'interrupt',
    });
    await expect(crashing.compareAndSetTaskCommitted(
      'ABC-1',
      { state: 'todo', expectedBaseRevision: undefined, expectedRemoteTip: undefined },
      'cancelled',
      {},
      'update durable restore task',
    ))
      .rejects.toBeInstanceOf(SimulatedControlInterruption);

    const outbox = join(dir, '.git', 'hercules-shadow-delivery');
    const synced: string[] = [];
    const interruptedRecovery = new GitControlPort(dir, {
      authoritativeTaskCommit: async () => {},
      afterShadowRecoveryDurability: async (paths) => {
        synced.push(...paths);
        throw new SimulatedControlInterruption('interrupted after durable shadow restore');
      },
    });
    await expect(interruptedRecovery.read()).rejects.toBeInstanceOf(SimulatedControlInterruption);
    expect(synced).toEqual(expect.arrayContaining([
      join(dir, 'tasks', 'ABC-1.md'),
      join(dir, 'tasks'),
      dir,
      join(dir, '.git', 'index'),
      join(dir, '.git'),
    ]));
    expect((await readdir(outbox)).filter((name) => name.endsWith('.json'))).toHaveLength(1);
    expect(await readFile(join(dir, 'tasks', 'ABC-1.md'), 'utf8')).toContain('state: todo');
    expect((await simpleGit(dir).status()).isClean()).toBe(true);

    const recovered = new GitControlPort(dir, { authoritativeTaskCommit: async () => {} });
    expect((await recovered.read()).tasks.find((task) => task.id === 'ABC-1')?.state).toBe('todo');
    expect((await readdir(outbox)).filter((name) => name.endsWith('.json'))).toHaveLength(0);
  });

  it('retains no-op discard evidence until the restored authority and index are durable', async () => {
    const taskId = 'SHADOW-DISCARD-NOOP';
    await new GitControlPort(dir).createTaskCommitted(
      { ...TASK, id: taskId },
      'seed canonical no-op task',
    );
    const outbox = join(dir, '.git', 'hercules-shadow-delivery');
    const interrupted = new GitControlPort(dir, {
      authoritativeTaskCommit: async () => {},
      afterShadowRecoveryDurability: async () => {
        throw new SimulatedControlInterruption('interrupted before no-op outbox discard');
      },
    });
    await expect(interrupted.compareAndSetTaskCommitted(
      taskId,
      { state: 'todo', expectedBaseRevision: undefined, expectedRemoteTip: undefined },
      'todo',
      {},
      'no-op shadow mutation',
    )).rejects.toBeInstanceOf(SimulatedControlInterruption);
    expect((await readdir(outbox)).filter((name) => name.endsWith('.json'))).toHaveLength(1);
    expect((await simpleGit(dir).status()).isClean()).toBe(true);

    const recovered = new GitControlPort(dir, { authoritativeTaskCommit: async () => {} });
    expect((await recovered.read()).tasks.find((task) => task.id === taskId)?.state).toBe('todo');
    expect((await readdir(outbox)).filter((name) => name.endsWith('.json'))).toHaveLength(0);
  });

  it('preserves third-value and undeclared dirt while common outbox recovery fails closed', async () => {
    const created = { ...TASK, id: 'SHADOW-CONFLICT' };
    const crashing = new GitControlPort(dir, {
      authoritativeTaskCommit: async () => {},
      afterCreateWrites: async () => 'interrupt',
    });
    await expect(crashing.createTaskCommitted(created, 'create shadow conflict'))
      .rejects.toBeInstanceOf(SimulatedControlInterruption);
    await writeFile(join(dir, 'tasks', 'SHADOW-CONFLICT.md'), 'third value\n');
    const thirdValue = new GitControlPort(dir, { authoritativeTaskCommit: async () => {} });
    await expect(thirdValue.read()).rejects.toBeInstanceOf(ShadowOutboxError);
    expect(await readFile(join(dir, 'tasks', 'SHADOW-CONFLICT.md'), 'utf8')).toBe('third value\n');

    await rm(join(dir, 'tasks', 'SHADOW-CONFLICT.md'));
    await writeFile(join(dir, 'unrelated.txt'), 'owner dirt\n');
    const unrelated = new GitControlPort(dir, { authoritativeTaskCommit: async () => {} });
    await expect(unrelated.read()).rejects.toBeInstanceOf(ShadowOutboxError);
    expect(await readFile(join(dir, 'unrelated.txt'), 'utf8')).toBe('owner dirt\n');
  });

  it('preserves both sides of an undeclared staged rename before shadow recovery writes', async () => {
    const created = { ...TASK, id: 'SHADOW-RENAME' };
    const proposed = serializeTask(created);
    const source = join(dir, 'unrelated.txt');
    const target = join(dir, 'tasks', 'SHADOW-RENAME.md');
    const git = simpleGit(dir);
    await writeFile(source, proposed);
    await git.add('unrelated.txt');
    await git.commit('seed unrelated rename source');

    const crashing = new GitControlPort(dir, {
      authoritativeTaskCommit: async () => {},
      afterCreateWrites: async () => 'interrupt',
    });
    await expect(crashing.createTaskCommitted(created, 'prepare rename-conflict task'))
      .rejects.toBeInstanceOf(SimulatedControlInterruption);
    await rm(target);
    await git.mv('unrelated.txt', 'tasks/SHADOW-RENAME.md');
    const before = await git.raw(['status', '--porcelain=v1', '-z']);
    const outbox = join(dir, '.git', 'hercules-shadow-delivery');

    await expect(new GitControlPort(dir, { authoritativeTaskCommit: async () => {} }).read())
      .rejects.toBeInstanceOf(ShadowOutboxError);
    expect(await readFile(target, 'utf8')).toBe(proposed);
    await expect(access(source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await git.raw(['status', '--porcelain=v1', '-z'])).toBe(before);
    expect((await readdir(outbox)).filter((name) => name.endsWith('.json'))).toHaveLength(1);
  });

  it('adopts an interrupted post-create commit and delivers it exactly once', async () => {
    const deliveries: Array<{ readonly revision: string; readonly ids: readonly string[] }> = [];
    const created = { ...TASK, id: 'SHADOW-COMMITTED' };
    const crashing = new GitControlPort(dir, {
      authoritativeTaskCommit: async (delivery) => {
        deliveries.push({ revision: delivery.revision, ids: delivery.writes.map((item) => item.id) });
      },
      afterCreateCommit: async () => 'interrupt',
    });
    await expect(crashing.createTaskCommitted(created, 'create committed shadow task'))
      .rejects.toBeInstanceOf(SimulatedControlInterruption);
    expect(deliveries).toEqual([]);
    const committedHead = (await simpleGit(dir).revparse(['HEAD'])).trim();

    const recovered = new GitControlPort(dir, {
      authoritativeTaskCommit: async (delivery) => {
        deliveries.push({ revision: delivery.revision, ids: delivery.writes.map((item) => item.id) });
      },
    });
    expect((await recovered.read()).tasks.some((item) => item.id === 'SHADOW-COMMITTED')).toBe(true);
    expect(deliveries).toEqual([{ revision: committedHead, ids: ['SHADOW-COMMITTED'] }]);
    await recovered.read();
    expect(deliveries).toHaveLength(1);
  });

  it('restores CAS writes before commit and adopts the exact commit after later HEAD advancement', async () => {
    const crashingWrite = new GitControlPort(dir, {
      authoritativeTaskCommit: async () => {},
      afterCompareAndSetWrites: async () => 'interrupt',
    });
    await expect(crashingWrite.compareAndSetTaskCommitted(
      'ABC-1',
      { state: 'todo', expectedBaseRevision: undefined, expectedRemoteTip: undefined },
      'cancelled',
      {},
      'cas interrupted before commit',
    )).rejects.toBeInstanceOf(SimulatedControlInterruption);
    const restored = new GitControlPort(dir, { authoritativeTaskCommit: async () => {} });
    expect((await restored.read()).tasks[0]?.state).toBe('todo');

    const deliveries: string[] = [];
    const crashingCommit = new GitControlPort(dir, {
      authoritativeTaskCommit: async (delivery) => { deliveries.push(delivery.revision); },
      afterCompareAndSetCommit: async () => 'interrupt',
    });
    await expect(crashingCommit.compareAndSetTaskCommitted(
      'ABC-1',
      { state: 'todo', expectedBaseRevision: undefined, expectedRemoteTip: undefined },
      'cancelled',
      {},
      'cas interrupted after commit',
    )).rejects.toBeInstanceOf(SimulatedControlInterruption);
    const casRevision = (await simpleGit(dir).revparse(['HEAD'])).trim();
    await writeFile(join(dir, 'later.txt'), 'later head\n');
    await simpleGit(dir).add('.');
    await simpleGit(dir).commit('later unrelated commit');

    const adopted = new GitControlPort(dir, {
      authoritativeTaskCommit: async (delivery) => { deliveries.push(delivery.revision); },
    });
    expect((await adopted.read()).tasks[0]?.state).toBe('cancelled');
    expect(deliveries).toEqual([casRevision]);
  });

  it('recovers a hard deletion after later HEAD advancement and reports retirement', async () => {
    const deliveries: Array<{ readonly revision: string; readonly retired: readonly string[] }> = [];
    const crashing = new GitControlPort(dir, {
      authoritativeTaskCommit: async (delivery) => {
        deliveries.push({ revision: delivery.revision, retired: delivery.retiredTaskIds });
      },
      afterMutationCommit: async () => 'interrupt',
    });
    await expect(crashing.mutateCommitted(
      { deleteTaskIds: ['ABC-1'] },
      'hard delete authority task',
    )).rejects.toBeInstanceOf(SimulatedControlInterruption);
    const deleteRevision = (await simpleGit(dir).revparse(['HEAD'])).trim();
    await writeFile(join(dir, 'later.txt'), 'later head\n');
    await simpleGit(dir).add('.');
    await simpleGit(dir).commit('later unrelated commit');

    const recovered = new GitControlPort(dir, {
      authoritativeTaskCommit: async (delivery) => {
        deliveries.push({ revision: delivery.revision, retired: delivery.retiredTaskIds });
      },
    });
    expect((await recovered.read()).tasks).toEqual([]);
    expect(deliveries).toEqual([{ revision: deleteRevision, retired: ['ABC-1'] }]);
    expect((await simpleGit(dir).status()).isClean()).toBe(true);
  });

  it('keeps a successful authority commit caller-visible when shadow delivery fails', async () => {
    let attempts = 0;
    const port = new GitControlPort(dir, {
      authoritativeTaskCommit: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('shadow unavailable');
      },
    });
    const created = { ...TASK, id: 'SHADOW-RETRY' };
    const result = await port.createTaskCommitted(created, 'create shadow retry');
    expect(result.committed).toBe(true);
    const head = (await simpleGit(dir).revparse(['HEAD'])).trim();
    expect(attempts).toBe(1);
    expect((await port.read()).tasks.some((item) => item.id === 'SHADOW-RETRY')).toBe(true);
    expect(attempts).toBe(2);
    expect((await simpleGit(dir).revparse(['HEAD'])).trim()).toBe(head);
  });

  it('drains multiple retained deliveries in exact authority order and stops at the first failure', async () => {
    let firstAvailable = false;
    const delivered: string[] = [];
    const port = new GitControlPort(dir, {
      authoritativeTaskCommit: async (delivery) => {
        const id = delivery.writes[0]?.id ?? delivery.retiredTaskIds[0]!;
        if (id === 'SHADOW-FIRST' && !firstAvailable) throw new Error('shadow unavailable');
        delivered.push(id);
      },
    });
    await port.createTaskCommitted({ ...TASK, id: 'SHADOW-FIRST' }, 'create first shadow task');
    await port.createTaskCommitted({ ...TASK, id: 'SHADOW-SECOND' }, 'create second shadow task');
    expect(delivered).toEqual([]);

    firstAvailable = true;
    await port.read();
    expect(delivered).toEqual(['SHADOW-FIRST', 'SHADOW-SECOND']);
  });

  it('restores a latest uncommitted write without discarding an earlier committed delivery', async () => {
    let available = false;
    const delivered: string[] = [];
    const deliver = async (delivery: { readonly writes: readonly Task[] }): Promise<void> => {
      if (!available) throw new Error('shadow unavailable');
      delivered.push(...delivery.writes.map((task) => task.id));
    };
    const first = new GitControlPort(dir, { authoritativeTaskCommit: deliver });
    await first.createTaskCommitted({ ...TASK, id: 'SHADOW-EARLIER' }, 'create earlier authority');

    const interrupted = new GitControlPort(dir, {
      authoritativeTaskCommit: deliver,
      afterCreateWrites: async () => 'interrupt',
    });
    await expect(interrupted.createTaskCommitted(
      { ...TASK, id: 'SHADOW-UNCOMMITTED' },
      'prepare later uncommitted task',
    )).rejects.toBeInstanceOf(SimulatedControlInterruption);

    available = true;
    const restarted = new GitControlPort(dir, { authoritativeTaskCommit: deliver });
    const snapshot = await restarted.read();
    expect(snapshot.tasks.some((task) => task.id === 'SHADOW-UNCOMMITTED')).toBe(false);
    expect(delivered).toEqual(['SHADOW-EARLIER']);
  });

  it('proves post-commit create and CAS errors before returning the durable authority result', async () => {
    const createPort = new GitControlPort(dir, {
      authoritativeTaskCommit: async () => {},
      afterCreateCommit: async () => { throw new Error('post-commit create failure'); },
    });
    await expect(createPort.createTaskCommitted(
      { ...TASK, id: 'SHADOW-POST-CREATE' },
      'create with post-commit failure',
    )).resolves.toMatchObject({ committed: true, hash: expect.stringMatching(/^[0-9a-f]{40}$/) });

    const casPort = new GitControlPort(dir, {
      authoritativeTaskCommit: async () => {},
      afterCompareAndSetCommit: async () => { throw new Error('post-commit CAS failure'); },
    });
    await expect(casPort.compareAndSetTaskCommitted(
      'ABC-1',
      { state: 'todo', expectedBaseRevision: undefined, expectedRemoteTip: undefined },
      'cancelled',
      {},
      'CAS with post-commit failure',
    )).resolves.toMatchObject({ matched: true, committed: true, hash: expect.stringMatching(/^[0-9a-f]{40}$/) });
  });

  it('accepts declared no-op paths while proving only paths actually changed by Git', async () => {
    const seed = new GitControlPort(dir);
    await seed.createTaskCommitted({ ...TASK, id: 'SHADOW-NOOP' }, 'seed canonical no-op task');
    const observed: string[] = [];
    const port = new GitControlPort(dir, {
      authoritativeTaskCommit: async (delivery) => {
        observed.push(...delivery.writes.map((task) => task.id));
      },
    });
    const tasks = (await port.read()).tasks;
    const current = tasks.find((task) => task.id === 'ABC-1')!;
    const noOp = tasks.find((task) => task.id === 'SHADOW-NOOP')!;
    const result = await port.mutateCommitted({
      writeTasks: [
        { expected: current, next: { ...current, title: 'Actually changed' } },
        { expected: noOp, next: noOp },
      ],
    }, 'mixed changed and no-op tasks');
    expect(result.committed).toBe(true);
    expect((await simpleGit(dir).show(['--name-only', '--format=', 'HEAD'])).trim())
      .toBe('tasks/ABC-1.md');
    expect(observed.sort()).toEqual(['ABC-1', 'SHADOW-NOOP']);
  });

  it('rejects permissive and symlinked durable outbox records before reading them', async () => {
    const crashing = new GitControlPort(dir, {
      authoritativeTaskCommit: async () => {},
      afterCreateWrites: async () => 'interrupt',
    });
    await expect(crashing.createTaskCommitted(
      { ...TASK, id: 'SHADOW-PRIVATE' },
      'create private outbox task',
    )).rejects.toBeInstanceOf(SimulatedControlInterruption);
    const outbox = join(dir, '.git', 'hercules-shadow-delivery');
    const name = (await readdir(outbox)).find((entry) => entry.endsWith('.json'))!;
    const record = join(outbox, name);
    await chmod(record, 0o644);
    await expect(new GitControlPort(dir, { authoritativeTaskCommit: async () => {} }).read())
      .rejects.toBeInstanceOf(ShadowOutboxError);

    await chmod(record, 0o600);
    const target = join(dir, '.git', 'shadow-record-target.json');
    await rename(record, target);
    await symlink(target, record);
    await expect(new GitControlPort(dir, { authoritativeTaskCommit: async () => {} }).read())
      .rejects.toBeInstanceOf(ShadowOutboxError);
  });

  it('observes create, compare-and-set, ordinary mutation, and rewire commits', async () => {
    const observed: Array<{ readonly writes: readonly string[]; readonly retired: readonly string[] }> = [];
    const port = new GitControlPort(dir, {
      authoritativeTaskCommit: async (delivery) => {
        observed.push({
          writes: delivery.writes.map((item) => item.id).sort(),
          retired: [...delivery.retiredTaskIds].sort(),
        });
      },
    });
    const created = { ...TASK, id: 'SHADOW-ALL' };
    await port.createTaskCommitted(created, 'shadow create');
    await port.compareAndSetTaskCommitted(
      'SHADOW-ALL',
      { state: 'todo', expectedBaseRevision: undefined, expectedRemoteTip: undefined },
      'cancelled',
      {},
      'shadow cas',
    );
    const current = (await port.read()).tasks.find((item) => item.id === 'SHADOW-ALL')!;
    await port.mutateCommitted({
      writeTasks: [{ expected: current, next: { ...current, title: 'ordinary observed' } }],
    }, 'shadow ordinary');

    const git = simpleGit(dir);
    await writeFile(join(dir, 'tasks', 'SHADOW-SECOND.md'),
      `---\ntitle: Second\nrepo: app\nstate: todo\npriority: 1\nblocked_by: [ABC-1]\n---\nbody\n`);
    await git.add('.');
    await git.commit('seed second shadow task');
    await port.rewireDependenciesCommitted([
      {
        id: 'SHADOW-SECOND',
        blockedBy: [],
        dependencyMode: 'completion_only',
        expectedBlockedBy: ['ABC-1'],
      },
    ], 'shadow rewire');

    expect(observed).toEqual([
      { writes: ['SHADOW-ALL'], retired: [] },
      { writes: ['SHADOW-ALL'], retired: [] },
      { writes: ['SHADOW-ALL'], retired: [] },
      { writes: ['SHADOW-SECOND'], retired: [] },
    ]);
  });
  it('fsyncs an existing parent when durable removal is retried after ENOENT', async () => {
    const calls: string[] = [];
    await removeDurableFile('/control/.git/journal', {
      unlink: async () => {
        const error = new Error('already absent') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      },
      openDirectory: async (path) => {
        calls.push(`open:${path}`);
        return {
          sync: async () => { calls.push('sync'); },
          close: async () => { calls.push('close'); },
        };
      },
    });
    expect(calls).toEqual(['open:/control/.git', 'sync', 'close']);
  });

  it('handles a missing parent during repeated durable removal', async () => {
    const missing = (): NodeJS.ErrnoException => {
      const error = new Error('absent') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      return error;
    };
    await expect(removeDurableFile('/gone/journal', {
      unlink: async () => { throw missing(); },
      openDirectory: async () => { throw missing(); },
    })).resolves.toBeUndefined();
  });

  async function installFailingCommitHook(): Promise<void> {
    const hookDir = join(dir, '.git', 'failing-hooks');
    await mkdir(hookDir, { recursive: true });
    const hook = join(hookDir, 'pre-commit');
    await writeFile(hook, '#!/bin/sh\nexit 1\n');
    await chmod(hook, 0o755);
    await simpleGit({ baseDir: dir, unsafe: { allowUnsafeHooksPath: true } }).addConfig(
      'core.hooksPath',
      hookDir,
    );
  }

  it('reads the snapshot from disk', async () => {
    const port = new GitControlPort(dir);
    const snap = await port.read();
    expect(Object.keys(snap.repos.repos)).toEqual(['app']);
    expect(snap.tasks.map((t) => t.id)).toEqual(['ABC-1']);
  });

  it('rewires multiple task files in one dependency-only commit', async () => {
    const git = simpleGit(dir);
    await writeFile(join(dir, 'tasks', 'ABC-2.md'),
      `---\ntitle: Second\nrepo: app\nstate: todo\npriority: 1\nblocked_by: [ABC-1]\n---\nbody two\n`);
    await writeFile(join(dir, 'tasks', 'ABC-3.md'),
      `---\ntitle: Third\nrepo: app\nstate: todo\npriority: 1\nblocked_by: [ABC-2]\n---\nbody three\n`);
    await git.add('.');
    await git.commit('more tasks');
    const port = new GitControlPort(dir);
    const snap = await port.read();
    const second = snap.tasks.find((entry) => entry.id === 'ABC-2')!;
    const third = snap.tasks.find((entry) => entry.id === 'ABC-3')!;

    const result = await port.rewireDependenciesCommitted!([
      { id: second.id, blockedBy: [], dependencyMode: 'completion_only', expectedBlockedBy: ['ABC-1'] },
      { id: third.id, blockedBy: ['ABC-1'], dependencyMode: 'gate_merge', expectedBlockedBy: ['ABC-2'] },
    ], 'hercules: dependency rewire ABC-2, ABC-3 (human)');

    expect(result.committed).toBe(true);
    expect((await git.show(['--name-only', '--format=', 'HEAD'])).trim().split('\n').sort())
      .toEqual(['tasks/ABC-2.md', 'tasks/ABC-3.md']);
    expect((await port.read()).tasks.find((entry) => entry.id === 'ABC-3'))
      .toMatchObject({ blockedBy: ['ABC-1'], body: 'body three' });
  });

  it('rejects a stale dependency lease before any rewire mutation', async () => {
    const port = new GitControlPort(dir);
    const original = (await port.read()).tasks[0]!;
    await expect(port.rewireDependenciesCommitted!([
      { id: original.id, blockedBy: [], dependencyMode: 'gate_merge', expectedBlockedBy: ['STALE'] },
    ], 'rewire')).rejects.toThrow(/stale expected dependency set/);
    expect((await simpleGit(dir).log()).latest?.message).toBe('seed');
    expect((await readFile(join(dir, 'tasks', 'ABC-1.md'), 'utf8')))
      .not.toContain('dependency_mode');
  });

  it('rejects a valid-lease rewire on unrelated dirt without changing task bytes or history', async () => {
    const port = new GitControlPort(dir);
    const original = (await port.read()).tasks[0]!;
    const taskBytes = await readFile(join(dir, 'tasks', 'ABC-1.md'));
    const beforeHead = await simpleGit(dir).revparse(['HEAD']);
    await writeFile(join(dir, 'external.txt'), 'do not attribute me');
    await expect(port.rewireDependenciesCommitted!([
      { id: original.id, blockedBy: [], dependencyMode: 'completion_only', expectedBlockedBy: [] },
    ], 'rewire')).rejects.toThrow(/dirty before atomic dependency rewire/);
    expect(await readFile(join(dir, 'tasks', 'ABC-1.md'))).toEqual(taskBytes);
    expect(await simpleGit(dir).revparse(['HEAD'])).toBe(beforeHead);
    expect((await readFile(join(dir, 'external.txt'), 'utf8'))).toBe('do not attribute me');
  });

  it('keeps concurrent ordinary mutations in separate exact-path audit commits', async () => {
    const git = simpleGit(dir);
    await writeFile(join(dir, 'tasks', 'ABC-2.md'),
      `---\ntitle: Second\nrepo: app\nstate: todo\npriority: 1\n---\nsecond\n`);
    await git.add('.');
    await git.commit('add second task');
    let firstAtBarrier!: () => void;
    const atBarrier = new Promise<void>((resolve) => { firstAtBarrier = resolve; });
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const entered: string[] = [];
    const port = new GitControlPort(dir, {
      beforeMutationCommit: async (message) => {
        entered.push(message);
        if (message === 'mutation A') {
          firstAtBarrier();
          await firstRelease;
        }
      },
    });
    const tasks = (await port.read()).tasks;
    const a = tasks.find((task) => task.id === 'ABC-1')!;
    const b = tasks.find((task) => task.id === 'ABC-2')!;
    const first = port.mutateCommitted(
      { writeTasks: [{ expected: a, next: { ...a, state: 'in_progress' } }] },
      'mutation A',
    );
    await atBarrier;
    const second = port.mutateCommitted(
      { writeTasks: [{ expected: b, next: { ...b, state: 'in_progress' } }] },
      'mutation B',
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(entered).toEqual(['mutation A']);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ committed: true }),
      expect.objectContaining({ committed: true }),
    ]);
    expect(entered).toEqual(['mutation A', 'mutation B']);
    const log = await git.log();
    const aCommit = log.all.find((entry) => entry.message === 'mutation A')!;
    const bCommit = log.all.find((entry) => entry.message === 'mutation B')!;
    expect((await git.show(['--name-only', '--format=', aCommit.hash])).trim())
      .toBe('tasks/ABC-1.md');
    expect((await git.show(['--name-only', '--format=', bCommit.hash])).trim())
      .toBe('tasks/ABC-2.md');
  });

  it('gives the loser a bounded conflict when concurrent owners mutate the same task', async () => {
    let firstAtBarrier!: () => void;
    const atBarrier = new Promise<void>((resolve) => { firstAtBarrier = resolve; });
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const port = new GitControlPort(dir, {
      beforeMutationCommit: async (message) => {
        if (message === 'same-task A') {
          firstAtBarrier();
          await firstRelease;
        }
      },
    });
    const original = (await port.read()).tasks.find((task) => task.id === TASK.id)!;
    const first = port.mutateCommitted({ writeTasks: [{
      expected: original,
      next: { ...original, state: 'in_progress' },
    }] }, 'same-task A');
    await atBarrier;
    const second = port.mutateCommitted({ writeTasks: [{
      expected: original,
      next: { ...original, priority: 2 },
    }] }, 'same-task B');
    releaseFirst();

    await expect(first).resolves.toMatchObject({ committed: true });
    await expect(second).rejects.toThrow(/changed before atomic mutation/);
    const git = simpleGit(dir);
    expect((await git.log()).all.filter((entry) => entry.message.startsWith('same-task')))
      .toHaveLength(1);
    expect((await port.read()).tasks.find((task) => task.id === TASK.id))
      .toMatchObject({ state: 'in_progress', priority: 1 });
  });

  it('serializes concurrent rewires so the loser receives a stale conflict', async () => {
    const git = simpleGit(dir);
    await writeFile(join(dir, 'tasks', 'OTHER.md'),
      `---\ntitle: Other\nrepo: app\nstate: todo\npriority: 1\n---\nother\n`);
    await git.add('.');
    await git.commit('add dependency target');
    const port = new GitControlPort(dir);
    const original = (await port.read()).tasks[0]!;
    const first = port.rewireDependenciesCommitted!([
      { id: original.id, blockedBy: ['OTHER'], dependencyMode: 'gate_merge', expectedBlockedBy: [] },
    ], 'first rewire');
    const second = port.rewireDependenciesCommitted!([
      { id: original.id, blockedBy: [], dependencyMode: 'completion_only', expectedBlockedBy: [] },
    ], 'second rewire');
    await expect(first).resolves.toMatchObject({ committed: true });
    await expect(second).rejects.toThrow(/stale expected dependency set/);
    const log = await simpleGit(dir).log();
    expect(log.all.filter((entry) => entry.message.includes('rewire'))).toHaveLength(1);
  });

  it('restart-recovers an interrupted pre-commit batch by rolling every task back', async () => {
    const git = simpleGit(dir);
    await writeFile(join(dir, 'tasks', 'ABC-2.md'),
      `---\ntitle: Second\nrepo: app\nstate: todo\npriority: 1\n---\nsecond\n`);
    await git.add('.');
    await git.commit('add second crash participant');
    const originals = (await new GitControlPort(dir).read()).tasks;
    const crashing = new GitControlPort(dir, { afterRewireWrites: async () => 'interrupt' });
    await expect(crashing.rewireDependenciesCommitted!([
      { id: 'ABC-1', blockedBy: ['ABC-2'], dependencyMode: 'gate_merge', expectedBlockedBy: [] },
      { id: 'ABC-2', blockedBy: [], dependencyMode: 'completion_only', expectedBlockedBy: [] },
    ], 'never durable')).rejects.toBeInstanceOf(SimulatedControlInterruption);

    const restarted = new GitControlPort(dir);
    expect((await restarted.read()).tasks.map(({ id, blockedBy, dependencyMode }) => ({
      id, blockedBy, dependencyMode,
    }))).toEqual(originals.map(({ id, blockedBy, dependencyMode }) => ({
      id, blockedBy, dependencyMode,
    })));
    expect((await git.log()).latest?.message).toBe('add second crash participant');
    expect((await git.status()).isClean()).toBe(true);
  });

  it('restart-recovers an interrupted post-commit batch from durable audit provenance', async () => {
    const original = (await new GitControlPort(dir).read()).tasks[0]!;
    const crashing = new GitControlPort(dir, { afterRewireCommit: async () => 'interrupt' });
    await expect(crashing.rewireDependenciesCommitted!([
      { id: original.id, blockedBy: [], dependencyMode: 'completion_only', expectedBlockedBy: [] },
    ], 'durable dependency audit')).rejects.toBeInstanceOf(SimulatedControlInterruption);

    const restarted = new GitControlPort(dir);
    expect((await restarted.read()).tasks[0]).toMatchObject({
      blockedBy: [], dependencyMode: 'completion_only',
    });
    const git = simpleGit(dir);
    expect((await git.log()).latest?.message).toBe('durable dependency audit');
    expect((await git.show(['--name-only', '--format=', 'HEAD'])).trim()).toBe('tasks/ABC-1.md');
    expect((await git.status()).isClean()).toBe(true);
  });

  it('never restores old bytes when cleanup fails after the rewire commit is durable', async () => {
    const original = (await new GitControlPort(dir).read()).tasks[0]!;
    const failing = new GitControlPort(dir, {
      afterRewireCommit: async () => {
        throw new TypeError('injected post-commit cleanup failure');
      },
    });
    await expect(failing.rewireDependenciesCommitted!([
      { id: original.id, blockedBy: [], dependencyMode: 'completion_only', expectedBlockedBy: [] },
    ], 'durable before cleanup failure')).rejects.toBeInstanceOf(ControlRecoveryError);

    const git = simpleGit(dir);
    expect((await git.log()).latest?.message).toBe('durable before cleanup failure');
    expect((await new GitControlPort(dir).read()).tasks[0]).toMatchObject({
      dependencyMode: 'completion_only',
    });
    expect((await git.status()).isClean()).toBe(true);
  });

  it('writes a task and commits it as a real git commit', async () => {
    const port = new GitControlPort(dir);
    const result = await port.mutateCommitted(
      { writeTasks: [{ expected: TASK, next: { ...TASK, state: 'in_progress' } }] },
      'hercules: ABC-1 todo → in_progress',
    );
    expect(result.committed).toBe(true);

    const log = await simpleGit(dir).log();
    expect(log.latest?.message).toBe('hercules: ABC-1 todo → in_progress');

    // The change is observable on a fresh read.
    const snap = await port.read();
    expect(snap.tasks.find((t) => t.id === 'ABC-1')!.state).toBe('in_progress');
  });

  it('keeps atomic task creation invisible to concurrent reads until commit', async () => {
    let enteredCommit!: () => void;
    const commitEntered = new Promise<void>((resolve) => { enteredCommit = resolve; });
    let releaseCommit!: () => void;
    const commitRelease = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const port = new GitControlPort(dir, {
      beforeCreateCommit: async () => {
        enteredCommit();
        await commitRelease;
      },
    });
    const created = { ...TASK, id: 'ATOMIC-1', title: 'Atomic' };

    const mutation = port.createTaskCommitted(created, 'hercules: create ATOMIC-1');
    await commitEntered;
    let readSettled = false;
    const concurrentRead = port.read().then((snapshot) => {
      readSettled = true;
      return snapshot;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readSettled).toBe(false);

    releaseCommit();
    await expect(mutation).resolves.toMatchObject({ committed: true });
    const visible = await concurrentRead;
    expect(visible.tasks.some((task) => task.id === 'ATOMIC-1')).toBe(true);
  });

  it('rolls back an atomic task file when create commit throws', async () => {
    const port = new GitControlPort(dir, {
      beforeCreateCommit: async () => { throw new Error('injected atomic commit throw'); },
    });
    await expect(port.createTaskCommitted(
      { ...TASK, id: 'ATOMIC-FAIL', title: 'Atomic fail' },
      'hercules: create ATOMIC-FAIL',
    )).rejects.toThrow(/injected atomic commit throw/);

    expect((await port.read()).tasks.some((task) => task.id === 'ATOMIC-FAIL')).toBe(false);
    expect((await simpleGit(dir).status()).isClean()).toBe(true);
  });

  it('rolls back a create byte-clean when a real pre-commit hook rejects it', async () => {
    await installFailingCommitHook();
    const port = new GitControlPort(dir);
    await expect(port.createTaskCommitted(
      { ...TASK, id: 'HOOK-CREATE', title: 'Hook create' },
      'hercules: create HOOK-CREATE',
    )).rejects.toBeInstanceOf(ControlDurabilityError);

    await expect(readFile(join(dir, 'tasks', 'HOOK-CREATE.md'))).rejects.toThrow();
    expect((await simpleGit(dir).status()).isClean()).toBe(true);
  });

  it('cleans the index when the first create commit in an unborn repo is rejected', async () => {
    const unbornDir = await mkdtemp(join(tmpdir(), 'hercules-port-unborn-'));
    try {
      const git = simpleGit({ baseDir: unbornDir, unsafe: { allowUnsafeHooksPath: true } });
      await git.init(['-b', 'main']);
      await git.addConfig('user.email', 't@hercules.local');
      await git.addConfig('user.name', 'T');
      const hookDir = join(unbornDir, '.git', 'failing-hooks');
      await mkdir(hookDir, { recursive: true });
      const hook = join(hookDir, 'pre-commit');
      await writeFile(hook, '#!/bin/sh\nexit 1\n');
      await chmod(hook, 0o755);
      await git.addConfig('core.hooksPath', hookDir);

      const port = new GitControlPort(unbornDir);
      await expect(port.createTaskCommitted(
        { ...TASK, id: 'UNBORN-CREATE', title: 'Unborn create' },
        'hercules: create UNBORN-CREATE',
      )).rejects.toBeInstanceOf(ControlDurabilityError);

      await expect(readFile(join(unbornDir, 'tasks', 'UNBORN-CREATE.md'))).rejects.toThrow();
      expect((await git.status()).isClean()).toBe(true);
      expect(await git.raw(['ls-files', '--stage'])).toBe('');
      await expect(git.revparse(['--verify', 'HEAD'])).rejects.toThrow();
    } finally {
      await rm(unbornDir, { recursive: true, force: true });
    }
  });

  it('restores noncanonical task bytes after a real CAS commit hook failure', async () => {
    const path = join(dir, 'tasks', 'ABC-1.md');
    const original = [
      '---',
      'title: Seeded task',
      'repo: app',
      'state: todo',
      'priority: 1',
      'labels: []',
      '---',
      'noncanonical body without serializer defaults',
      '',
    ].join('\n');
    await writeFile(path, original);
    const git = simpleGit(dir);
    await git.add(path);
    await git.commit('seed noncanonical bytes');
    await installFailingCommitHook();
    const port = new GitControlPort(dir);

    await expect(port.compareAndSetTaskCommitted(
      'ABC-1',
      { state: 'todo', expectedBaseRevision: undefined, expectedRemoteTip: undefined },
      'in_progress',
      { startedAt: '2026-08-03T00:00:00.000Z' },
      'hercules: ABC-1 todo → in_progress',
    )).rejects.toBeInstanceOf(ControlDurabilityError);

    expect(await readFile(path, 'utf8')).toBe(original);
    expect((await git.status()).isClean()).toBe(true);
  });

  it('serializes concurrent same-id creates and commits exactly one task', async () => {
    let enteredCommit!: () => void;
    const commitEntered = new Promise<void>((resolve) => { enteredCommit = resolve; });
    let releaseCommit!: () => void;
    const commitRelease = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const port = new GitControlPort(dir, {
      beforeCreateCommit: async () => {
        enteredCommit();
        await commitRelease;
      },
    });
    const first = port.createTaskCommitted(
      { ...TASK, id: 'ATOMIC-RACE', title: 'First writer' },
      'hercules: create ATOMIC-RACE first',
    );
    await commitEntered;
    const second = port.createTaskCommitted(
      { ...TASK, id: 'ATOMIC-RACE', title: 'Second writer' },
      'hercules: create ATOMIC-RACE second',
    );

    releaseCommit();
    await expect(first).resolves.toMatchObject({ committed: true });
    await expect(second).rejects.toThrow(/already exists during atomic create/);

    const created = (await port.read()).tasks.filter((task) => task.id === 'ATOMIC-RACE');
    expect(created).toHaveLength(1);
    expect(created[0]!.title).toBe('First writer');
    const log = await simpleGit(dir).log();
    expect(log.all.filter((entry) => entry.message.includes('ATOMIC-RACE'))).toHaveLength(1);
  });

  it('keeps a concurrent task mutation outside the CAS read-write critical section', async () => {
    let casRead!: () => void;
    const casReadComplete = new Promise<void>((resolve) => { casRead = resolve; });
    let releaseCas!: () => void;
    const casRelease = new Promise<void>((resolve) => { releaseCas = resolve; });
    const port = new GitControlPort(dir, {
      beforeCompareAndSetWrite: async () => {
        casRead();
        await casRelease;
      },
    });
    const expected = {
      state: TASK.state,
      expectedBaseRevision: TASK.expectedBaseRevision,
      expectedRemoteTip: TASK.expectedRemoteTip,
    };
    const cas = port.compareAndSetTaskCommitted(
      TASK.id,
      expected,
      'in_progress',
      { startedAt: '2026-08-03T00:00:00.000Z' },
      'hercules: ABC-1 todo → in_progress',
    );
    await casReadComplete;

    let mutationSettled = false;
    const concurrentMutation = port.mutateCommitted({ writeTasks: [{
      expected: TASK,
      next: { ...TASK, expectedRemoteTip: 'f'.repeat(40) },
    }] }, 'concurrent exact mutation').finally(() => { mutationSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mutationSettled).toBe(false);

    releaseCas();
    await expect(cas).resolves.toMatchObject({ matched: true, committed: true });
    await expect(concurrentMutation).rejects.toThrow(/changed before atomic mutation/);
    const durable = (await port.read()).tasks.find((task) => task.id === TASK.id)!;
    expect(durable.state).toBe('in_progress');
    expect(durable.expectedRemoteTip).not.toBe('f'.repeat(40));
  });

  it('fails closed when callers try the split write/commit boundary', async () => {
    const port = new GitControlPort(dir);
    await expect(port.writeTask(TASK)).rejects.toThrow(/require mutateCommitted/);
    await expect(port.commit('noop')).rejects.toThrow(/ownership-scoped atomic operation/);
  });

  it('reports committed:false when nothing changed', async () => {
    const port = new GitControlPort(dir);
    const beforeHead = await simpleGit(dir).revparse(['HEAD']);

    const result = await port.mutateCommitted({}, 'noop');

    expect(result.committed).toBe(false);
    expect(await simpleGit(dir).revparse(['HEAD'])).toBe(beforeHead);
    expect((await simpleGit(dir).status()).isClean()).toBe(true);
  });

  it('sync is a no-op (does not throw) for a remote-less local control repo', async () => {
    const port = new GitControlPort(dir);
    await expect(port.sync()).resolves.toBeUndefined();
  });

  it('rejects dirty worktree task bytes as an exact versioned snapshot', async () => {
    const before = await simpleGit(dir).revparse(['HEAD']);
    await writeFile(join(dir, 'tasks', 'ABC-1.md'),
      `---\ntitle: Dirty authority\nrepo: app\nstate: todo\npriority: 1\n---\ndo it\n`);
    const port = new GitControlPort(dir);
    await expect(port.readVersionedTasks()).rejects.toThrow(
      'versioned task read requires exact clean authority bytes',
    );
    expect(await simpleGit(dir).revparse(['HEAD'])).toBe(before);
  });

  it('observes an exact post-pull snapshot after a remote authority update', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hercules-port-remote-'));
    extraRoots.push(root);
    const remote = join(root, 'control.git');
    const writer = join(root, 'writer');
    await simpleGit().raw(['init', '--bare', '--initial-branch=main', remote]);
    const local = simpleGit(dir);
    await local.addRemote('origin', remote);
    await local.push(['--set-upstream', 'origin', 'main']);
    await simpleGit().clone(remote, writer);
    const writerGit = simpleGit(writer);
    await writerGit.addConfig('user.email', 'writer@hercules.local');
    await writerGit.addConfig('user.name', 'Writer');
    await writeFile(join(writer, 'tasks', 'ABC-1.md'),
      `---\ntitle: Pulled authority\nrepo: app\nstate: todo\npriority: 1\n---\ndo it\n`);
    await writerGit.add('.');
    await writerGit.commit('remote task update');
    await writerGit.push('origin', 'main');

    const observed: Array<{ readonly revision: string; readonly title: string }> = [];
    const port = new GitControlPort(dir, {
      authoritativeSnapshotObserved: async (snapshot) => {
        observed.push({ revision: snapshot.revision, title: snapshot.tasks[0]!.title });
      },
    });
    await port.sync();
    expect(observed).toEqual([{
      revision: await local.revparse(['HEAD']),
      title: 'Pulled authority',
    }]);
  });

  it('deleteTask removes the file and the next commit records it', async () => {
    const port = new GitControlPort(dir);
    await port.mutateCommitted(
      { writeTasks: [{ expected: null, next: { ...TASK, id: 'T-9', title: 'T-9' } }] },
      'add T-9',
    );
    await port.mutateCommitted({ deleteTaskIds: ['T-9'] }, 'hercules: delete T-9 (human)');
    const snap = await port.read();
    expect(snap.tasks.find((t) => t.id === 'T-9')).toBeUndefined();
  });

  it('writeRepos persists repos.yaml so commit records it', async () => {
    const port = new GitControlPort(dir);
    const config: ReposConfig = {
      repos: { svc: { key: 'svc', url: 'git@h:svc.git', defaultBranch: 'main', workflow: 'WORKFLOW.md', maxConcurrent: 1, adapter: null, readiness: 'ready' } },
    };
    const { committed } = await port.mutateCommitted(
      { repos: config },
      'hercules: add repo svc (human)',
    );
    expect(committed).toBe(true);
    const onDisk = parseReposConfig(await readFile(join(dir, 'repos.yaml'), 'utf8'));
    expect(onDisk).toEqual(config);
  });

  it('atomically commits gate stamps with a sealed receipt and survives restart', async () => {
    const port = new GitControlPort(dir);
    const stamped: Task = { ...TASK, mergedVia: 'gate', mergedSha: '3'.repeat(40) };
    await expect(port.mutateCommitted({
      writeTasks: [{ expected: TASK, next: stamped }],
      writeSuccessions: [{ expected: null, next: SUCCESSION }],
    }, 'merge stamp and succession')).resolves.toMatchObject({ committed: true });

    const restarted = new GitControlPort(dir);
    expect((await restarted.read()).tasks[0]).toMatchObject({
      mergedVia: 'gate', mergedSha: '3'.repeat(40),
    });
    expect(await restarted.readSuccession('app')).toEqual(SUCCESSION);
    expect((await simpleGit(dir).status()).isClean()).toBe(true);
  });

  it('rolls back both gate stamps and receipt when the durable write fails', async () => {
    const port = new GitControlPort(dir, {
      beforeMutationCommit: async (message) => {
        if (message === 'fail succession write') throw new Error('simulated disk failure');
      },
    });
    await expect(port.mutateCommitted({
      writeTasks: [{ expected: TASK, next: { ...TASK, mergedVia: 'gate', mergedSha: '3'.repeat(40) } }],
      writeSuccessions: [{ expected: null, next: SUCCESSION }],
    }, 'fail succession write')).rejects.toThrow('simulated disk failure');
    expect((await port.read()).tasks[0]?.mergedSha ?? null).toBeNull();
    expect(await port.readSuccession('app')).toBeNull();
    expect((await simpleGit(dir).status()).isClean()).toBe(true);
  });

  it.each(['before-rename', 'after-rename', 'before-commit'] as const)(
    'preserves the last seal, exact task bytes and control HEAD on %s failure',
    async (phase) => {
      const seed = new GitControlPort(dir);
      await seed.mutateCommitted({ writeSuccessions: [{ expected: null, next: SUCCESSION }] }, 'seed seal');
      const taskPath = join(dir, 'tasks', 'ABC-1.md');
      const ledgerPath = join(dir, 'successions', 'app.json');
      const taskBefore = await readFile(taskPath);
      const ledgerBefore = await readFile(ledgerPath);
      const headBefore = (await simpleGit(dir).revparse(['HEAD'])).trim();
      const fail = async (): Promise<void> => { throw new Error(`fault ${phase}`); };
      const port = new GitControlPort(dir, {
        ...(phase === 'before-rename' ? { beforeSuccessionRename: fail } : {}),
        ...(phase === 'after-rename' ? { afterSuccessionRename: fail } : {}),
        ...(phase === 'before-commit' ? { beforeMutationCommit: fail } : {}),
      });
      const stamped = { ...TASK, mergedVia: 'gate' as const, mergedSha: '6'.repeat(40) };
      await expect(port.mutateCommitted({
        writeTasks: [{ expected: TASK, next: stamped }],
        writeSuccessions: [{ expected: SUCCESSION, next: SUCCESSION_NEXT }],
      }, 'stamp with fault')).rejects.toThrow(`fault ${phase}`);
      expect(await readFile(taskPath)).toEqual(taskBefore);
      expect(await readFile(ledgerPath)).toEqual(ledgerBefore);
      expect((await simpleGit(dir).revparse(['HEAD'])).trim()).toBe(headBefore);
      expect((await simpleGit(dir).status()).isClean()).toBe(true);
      expect((await readdir(join(dir, 'successions'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      expect((await port.read()).tasks[0]).not.toMatchObject({ mergedVia: 'gate', mergedSha: '6'.repeat(40) });
    },
  );

  it.each(['task-write', 'succession-rename', 'post-commit'] as const)(
    'recovers a process interruption at %s with receipt and stamp all-or-none',
    async (phase) => {
      const headBefore = (await simpleGit(dir).revparse(['HEAD'])).trim();
      const port = new GitControlPort(dir, {
        ...(phase === 'task-write' ? {
          afterMutationWrites: async () => 'interrupt' as const,
        } : {}),
        ...(phase === 'succession-rename' ? {
          afterSuccessionRename: async () => {
            throw new SimulatedControlInterruption('process died after succession rename');
          },
        } : {}),
        ...(phase === 'post-commit' ? {
          afterMutationCommit: async () => 'interrupt' as const,
        } : {}),
      });
      const stamped: Task = { ...TASK, mergedVia: 'gate', mergedSha: '3'.repeat(40) };
      await expect(port.mutateCommitted({
        writeTasks: [{ expected: TASK, next: stamped }],
        writeSuccessions: [{ expected: null, next: SUCCESSION }],
      }, 'audited merge stamp')).rejects.toThrow(SimulatedControlInterruption);
      const restarted = new GitControlPort(dir);
      const snapshot = await restarted.read();
      const committed = phase === 'post-commit';
      expect(snapshot.tasks[0]?.mergedSha ?? null).toBe(committed ? '3'.repeat(40) : null);
      expect(await restarted.readSuccession('app')).toEqual(committed ? SUCCESSION : null);
      const headAfter = (await simpleGit(dir).revparse(['HEAD'])).trim();
      if (committed) expect(headAfter).not.toBe(headBefore);
      else expect(headAfter).toBe(headBefore);
      expect((await simpleGit(dir).status()).isClean()).toBe(true);
      expect((await readdir(join(dir, '.git'))).filter((name) =>
        name.startsWith('hercules-control-mutation'))).toEqual([]);
      const successionFiles = await readdir(join(dir, 'successions')).catch(() => [] as string[]);
      expect(successionFiles.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    },
  );

  it('resumes an interrupted multi-path rollback and durably restores every original', async () => {
    const taskPath = join(dir, 'tasks', 'ABC-1.md');
    const taskBefore = await readFile(taskPath);
    const headBefore = (await simpleGit(dir).revparse(['HEAD'])).trim();
    const interrupted = new GitControlPort(dir, {
      afterMutationWrites: async () => 'interrupt',
    });
    await expect(interrupted.mutateCommitted({
      writeTasks: [{ expected: TASK, next: { ...TASK, mergedVia: 'gate', mergedSha: '3'.repeat(40) } }],
      writeSuccessions: [{ expected: null, next: SUCCESSION }],
    }, 'recover two owned paths')).rejects.toThrow(SimulatedControlInterruption);

    const firstRecovery = new GitControlPort(dir, {
      afterMutationRecoveryRestore: async (_path, count) => count === 1 ? 'interrupt' : 'continue',
    });
    await expect(firstRecovery.read()).rejects.toThrow(/interrupted during ordinary mutation recovery/);
    expect(await readFile(join(dir, '.git', 'hercules-control-mutation.json'), 'utf8'))
      .toContain('recover two owned paths');

    const finalRecovery = new GitControlPort(dir);
    expect((await finalRecovery.read()).tasks[0]).toMatchObject({
      id: TASK.id,
      title: TASK.title,
      mergedSha: null,
      mergedVia: null,
    });
    expect(await finalRecovery.readSuccession('app')).toBeNull();
    expect(await readFile(taskPath)).toEqual(taskBefore);
    expect((await simpleGit(dir).revparse(['HEAD'])).trim()).toBe(headBefore);
    expect((await simpleGit(dir).status()).isClean()).toBe(true);
    expect((await readdir(join(dir, '.git'))).filter((name) =>
      name.startsWith('hercules-control-mutation'))).toEqual([]);
    expect((await readdir(join(dir, 'tasks'))).filter((name) =>
      name.endsWith('.hercules-restore.tmp'))).toEqual([]);
  });

  it('fails closed on valid-JSON corruption of journaled original bytes', async () => {
    const interrupted = new GitControlPort(dir, {
      afterMutationWrites: async () => 'interrupt',
    });
    await expect(interrupted.mutateCommitted({
      writeTasks: [{ expected: TASK, next: { ...TASK, title: 'proposed' } }],
    }, 'corrupt original binding')).rejects.toThrow(SimulatedControlInterruption);
    const journalPath = join(dir, '.git', 'hercules-control-mutation.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      entries: { originalBase64: string | null }[];
    };
    journal.entries[0]!.originalBase64 = Buffer.from('corrupted original\n').toString('base64');
    await writeFile(journalPath, JSON.stringify(journal));

    const restarted = new GitControlPort(dir);
    await expect(restarted.read()).rejects.toThrow(/original hash mismatch|journal integrity mismatch/);
    expect(await readFile(join(dir, 'tasks', 'ABC-1.md'), 'utf8')).toContain('title: proposed');
    const preserved = JSON.parse(await readFile(journalPath, 'utf8')) as {
      entries: { originalBase64: string }[];
    };
    expect(Buffer.from(preserved.entries[0]!.originalBase64, 'base64').toString('utf8'))
      .toBe('corrupted original\n');
  });

  it('never overwrites unrelated dirty work and keeps recovery and later mutation closed', async () => {
    const interrupted = new GitControlPort(dir, {
      afterMutationWrites: async () => 'interrupt',
    });
    await expect(interrupted.mutateCommitted({
      writeTasks: [{ expected: TASK, next: { ...TASK, title: 'proposed' } }],
    }, 'rollback with foreign dirt')).rejects.toThrow(SimulatedControlInterruption);
    const foreignPath = join(dir, 'operator-note.txt');
    await writeFile(foreignPath, 'operator-owned\n');

    const restarted = new GitControlPort(dir);
    await expect(restarted.read()).rejects.toThrow(/dirty control tree/);
    expect(await readFile(foreignPath, 'utf8')).toBe('operator-owned\n');
    await expect(restarted.mutateCommitted({}, 'must stay closed')).rejects.toThrow(/dirty control tree/);
    expect(await readFile(foreignPath, 'utf8')).toBe('operator-owned\n');
    expect(await readFile(join(dir, '.git', 'hercules-control-mutation.json'), 'utf8'))
      .toContain('rollback with foreign dirt');
  });

  it.each(['declared-worktree', 'unrelated-staged'] as const)(
    'does not report success or delete recovery evidence when a commit hook adds %s bytes, then cleans the hook',
    async (kind) => {
      const hookDir = join(dir, '.git', 'mutation-hooks');
      await mkdir(hookDir, { recursive: true });
      const hookPath = join(hookDir, 'pre-commit');
      const foreignPath = join(dir, 'hook-stray.txt');
      const hook = kind === 'declared-worktree'
        ? '#!/bin/sh\nprintf "hook-owned\\n" > tasks/ABC-1.md\n'
        : '#!/bin/sh\nprintf "hook-owned\\n" > hook-stray.txt\ngit add hook-stray.txt\n';
      await writeFile(hookPath, hook);
      await chmod(hookPath, 0o755);
      const git = simpleGit({ baseDir: dir, unsafe: { allowUnsafeHooksPath: true } });
      const originalHooksPath = (await git.getConfig('core.hooksPath')).value;
      if (originalHooksPath === null) throw new Error('test repository must start with hooks disabled');
      try {
        await git.addConfig('core.hooksPath', hookDir);
        const port = new GitControlPort(dir);
        await expect(port.mutateCommitted({
          writeTasks: [{ expected: TASK, next: { ...TASK, mergedVia: 'gate', mergedSha: '3'.repeat(40) } }],
        }, `hook conflict ${kind}`)).rejects.toThrow(ControlRecoveryError);

        expect(await readFile(join(dir, '.git', 'hercules-control-mutation.json'), 'utf8'))
          .toContain(`hook conflict ${kind}`);
        if (kind === 'declared-worktree') {
          expect(await readFile(join(dir, 'tasks', 'ABC-1.md'), 'utf8')).toBe('hook-owned\n');
        } else {
          expect(await readFile(foreignPath, 'utf8')).toBe('hook-owned\n');
        }
        const recovery = new GitControlPort(dir);
        await expect(recovery.read()).rejects.toThrow(/concurrent declared-path work|ambiguous/);
        if (kind === 'declared-worktree') {
          expect(await readFile(join(dir, 'tasks', 'ABC-1.md'), 'utf8')).toBe('hook-owned\n');
        } else {
          expect(await readFile(foreignPath, 'utf8')).toBe('hook-owned\n');
        }
      } finally {
        await git.addConfig('core.hooksPath', originalHooksPath);
        await rm(hookPath, { force: true });
      }
      expect((await git.getConfig('core.hooksPath')).value).toBe(originalHooksPath);
      await expect(access(hookPath)).rejects.toThrow();
    },
  );

  it('fails closed on an advanced unrelated HEAD without overwriting either side', async () => {
    const stamped: Task = { ...TASK, mergedVia: 'gate', mergedSha: '3'.repeat(40) };
    const interrupted = new GitControlPort(dir, {
      afterMutationWrites: async () => 'interrupt',
    });
    await expect(interrupted.mutateCommitted({
      writeTasks: [{ expected: TASK, next: stamped }],
    }, 'pending stamp')).rejects.toThrow(SimulatedControlInterruption);
    const unrelated = join(dir, 'concurrent.txt');
    await writeFile(unrelated, 'concurrent owner\n');
    const git = simpleGit(dir);
    await git.add('concurrent.txt');
    await git.commit('concurrent owner commit');

    const restarted = new GitControlPort(dir);
    await expect(restarted.read()).rejects.toThrow(/HEAD or declared bytes are ambiguous/);
    expect((await readFile(join(dir, 'tasks', 'ABC-1.md'), 'utf8'))).toContain('merged_sha');
    expect(await readFile(unrelated, 'utf8')).toBe('concurrent owner\n');
    expect(await readFile(join(dir, '.git', 'hercules-control-mutation.json'), 'utf8'))
      .toContain('pending stamp');
  });

  it('recovers an ordinary interruption before running the separate rewire journal path', async () => {
    const seed = new GitControlPort(dir);
    const dependency: Task = { ...TASK, id: 'ABC-2', title: 'Dependency' };
    await seed.mutateCommitted({ writeTasks: [{ expected: null, next: dependency }] }, 'add dependency');
    const interrupted = new GitControlPort(dir, {
      afterMutationWrites: async () => 'interrupt',
    });
    await expect(interrupted.mutateCommitted({
      writeTasks: [{ expected: TASK, next: { ...TASK, mergedVia: 'gate', mergedSha: '3'.repeat(40) } }],
    }, 'interrupted ordinary stamp')).rejects.toThrow(SimulatedControlInterruption);

    const restarted = new GitControlPort(dir);
    await expect(restarted.rewireDependenciesCommitted!([{
      id: 'ABC-1', expectedBlockedBy: [], blockedBy: ['ABC-2'], dependencyMode: 'completion_only',
    }], 'dependency rewire after ordinary recovery')).resolves.toMatchObject({ committed: true });
    expect((await restarted.read()).tasks.find((task) => task.id === 'ABC-1'))
      .toMatchObject({ blockedBy: ['ABC-2'], mergedSha: null });
    expect((await readdir(join(dir, '.git'))).filter((name) =>
      name.includes('hercules-control-mutation') || name.includes('hercules-dependency-rewire')))
      .toEqual([]);
  });

  it('keeps an exact duplicate succession replay idempotent', async () => {
    const port = new GitControlPort(dir);
    await port.mutateCommitted({ writeSuccessions: [{ expected: null, next: SUCCESSION }] }, 'seed seal');
    const head = (await simpleGit(dir).revparse(['HEAD'])).trim();
    const bytes = await readFile(join(dir, 'successions', 'app.json'));
    await expect(port.mutateCommitted({
      writeSuccessions: [{ expected: SUCCESSION, next: SUCCESSION }],
    }, 'duplicate replay')).resolves.toMatchObject({ committed: false });
    expect((await simpleGit(dir).revparse(['HEAD'])).trim()).toBe(head);
    expect(await readFile(join(dir, 'successions', 'app.json'))).toEqual(bytes);
    expect((await simpleGit(dir).status()).isClean()).toBe(true);
  });

  it('keeps real ledger bytes and HEAD unchanged when a later replay reobserves mutable state', async () => {
    const port = new GitControlPort(dir);
    await port.mutateCommitted({ writeSuccessions: [{ expected: null, next: SUCCESSION }] }, 'seed seal');
    const head = (await simpleGit(dir).revparse(['HEAD'])).trim();
    const ledgerPath = join(dir, 'successions', 'app.json');
    const bytes = await readFile(ledgerPath);
    const replay = buildSuccessionReceipt({
      ...SUCCESSION.receipts[0]!,
      createdAt: '2026-08-04T15:00:00.000Z',
      managed: [{ taskId: 'ABC-1', disposition: 'removed' }],
      external: [{
        registrationId: 'owner-main',
        classification: 'dirty',
        headSha: '1'.repeat(40),
        dirty: true,
        ahead: 0,
        behind: 1,
        concurrentChange: true,
        guidance: [{
          code: 'stash_or_commit_dirty',
          text: 'Preserve this later observation.',
          destructive: false,
        }],
      }],
    });
    const replayed = appendSuccessionReceipt(SUCCESSION, replay);
    expect(replayed).toBe(SUCCESSION);
    await expect(port.mutateCommitted({
      writeSuccessions: [{ expected: SUCCESSION, next: replayed }],
    }, 'later observed duplicate replay')).resolves.toMatchObject({ committed: false });
    expect((await simpleGit(dir).revparse(['HEAD'])).trim()).toBe(head);
    expect(await readFile(ledgerPath)).toEqual(bytes);
  });
});
