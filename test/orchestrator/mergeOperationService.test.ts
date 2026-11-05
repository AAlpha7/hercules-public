/**
 * Merge Selected long-running operation: accept, poll, idempotency, single-flight,
 * delayed gates, restart reconciliation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { GitWorkspaces } from '../../src/isolation/worktree.js';
import { PortAllocator } from '../../src/isolation/ports.js';
import type { RepoConfig } from '../../src/domain/repos.js';
import type { Task } from '../../src/domain/task.js';
import type { ControlPort } from '../../src/orchestrator/orchestrator.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import type { ReposConfig } from '../../src/domain/repos.js';
import { MergeOperationStore } from '../../src/isolation/mergeOperationStore.js';
import { MergeOperationService } from '../../src/orchestrator/mergeOperationService.js';
import { mergeWorkspacesFrom } from '../../src/orchestrator/mergeService.js';

let tmp: string;
let root: string;
let targetUrl: string;
let repo: RepoConfig;

function makeTask(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    repo: 'app',
    state: 'done',
    priority: 100,
    blockedBy: [],
    labels: [],
    adapter: null,
    agentSession: null,
    pendingSteer: null,
    attempts: 1,
    lastEventAt: null,
    createdAt: null,
    startedAt: null,
    endedAt: null,
    prUrl: null,
    prStatus: null,
    planPending: false,
    verifiedSha: null,
    mergedSha: null,
    body: `## Task\n\n${id}\n`,
    ...over,
  };
}

class FakePort implements ControlPort {
  readonly commits: string[] = [];
  repos: ReposConfig;
  constructor(readonly tasks: Map<string, Task>, target: string) {
    this.repos = {
      repos: {
        app: {
          key: 'app',
          url: target,
          defaultBranch: 'main',
          workflow: 'WORKFLOW.md',
          maxConcurrent: 1,
          adapter: null,
          readiness: 'ready',
        },
      },
    };
  }
  async sync(): Promise<void> {}
  async read(): Promise<ControlSnapshot> {
    return { repos: this.repos, tasks: [...this.tasks.values()], problems: [] };
  }
  async writeTask(t: Task): Promise<void> {
    this.tasks.set(t.id, t);
  }
  async deleteTask(id: string): Promise<void> {
    this.tasks.delete(id);
  }
  async commit(message: string): Promise<{ committed: boolean }> {
    this.commits.push(message);
    return { committed: true };
  }
  async writeRepos(config: ReposConfig): Promise<void> {
    this.repos = config;
  }
}

async function setupOrigin(): Promise<void> {
  await mkdir(targetUrl, { recursive: true });
  const g = simpleGit(targetUrl);
  await g.init(['-b', 'main']);
  await g.addConfig('user.email', 't@h.local');
  await g.addConfig('user.name', 'T');
  await g.addConfig('receive.denyCurrentBranch', 'updateInstead');
  await writeFile(join(targetUrl, 'README.md'), '# target\n');
  await writeFile(
    join(targetUrl, 'WORKFLOW.md'),
    '---\ngates:\n  test: "true"\n---\nbe careful\n',
  );
  await g.add('.');
  await g.commit('initial');
}

async function plantBranch(
  ws: GitWorkspaces,
  taskId: string,
  files: Record<string, string>,
): Promise<string> {
  const w = await ws.create(repo, taskId, { hadPriorWork: false });
  const g = simpleGit(w.dir);
  await g.addConfig('user.email', 't@h.local');
  await g.addConfig('user.name', 'T');
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(w.dir, name), content);
  }
  await g.add('.');
  await g.commit('work ' + taskId);
  const tip = (await g.revparse(['HEAD'])).trim();
  await ws.preserve(taskId, 'pin');
  return tip;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'h-mop-'));
  root = join(tmp, 'work');
  targetUrl = join(tmp, 'origin');
  repo = {
    key: 'app',
    url: targetUrl,
    defaultBranch: 'main',
    workflow: 'WORKFLOW.md',
    maxConcurrent: 1,
    adapter: null,
    readiness: 'ready',
  };
  await mkdir(root, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('MergeOperationService', { timeout: 60_000 }, () => {
  it('does not terminalize the operation when exactly one progress write fails', async () => {
    class FaultStore extends MergeOperationStore {
      progressFailures = 0;

      override async put(record: import('../../src/domain/mergeOperation.js').MergeOperationRecord) {
        if (record.phase === 'gating' && this.progressFailures === 0) {
          this.progressFailures += 1;
          throw new Error('injected progress write failure');
        }
        return super.put(record);
      }
    }

    await setupOrigin();
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(6090, 4) });
    const tip = await plantBranch(ws, 'T-PROGRESS', { 'progress.txt': 'complete\n' });
    await plantBranch(ws, 'T-AFTER-PROGRESS', { 'after.txt': 'accepted\n' });
    const port = new FakePort(new Map([
      ['T-PROGRESS', makeTask('T-PROGRESS', { verifiedSha: tip })],
      ['T-AFTER-PROGRESS', makeTask('T-AFTER-PROGRESS')],
    ]), targetUrl);
    const store = new FaultStore(root);
    let gateRuns = 0;
    let pushRuns = 0;
    const baseWorkspaces = mergeWorkspacesFrom(ws);
    const svc = new MergeOperationService({
      store,
      mergeDeps: {
        control: port,
        workspaces: {
          ...baseWorkspaces,
          openMergeWorktree: async (repoConfig) => {
            const handle = await baseWorkspaces.openMergeWorktree(repoConfig);
            return new Proxy(handle, {
              get(target, property, receiver) {
                if (property === 'pushDefaultBranch') {
                  return async (pushRepo: RepoConfig): Promise<void> => {
                    pushRuns += 1;
                    await target.pushDefaultBranch(pushRepo);
                  };
                }
                return Reflect.get(target, property, receiver) as unknown;
              },
            });
          },
        },
        commandRunner: async () => {
          gateRuns += 1;
          return { exitCode: 0, output: 'ok' };
        },
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const accepted = await svc.start({
        repoKey: 'app',
        taskIds: ['T-PROGRESS'],
        idempotencyKey: 'progress-fault',
      });
      const final = await svc.waitFor(accepted.operationId);
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
      expect(store.progressFailures).toBe(1);
      expect(final).toMatchObject({
        status: 'succeeded',
        phase: 'stamped',
        mergedSha: port.tasks.get('T-PROGRESS')?.mergedSha,
      });
      expect(final?.mergedSha).toMatch(/^[0-9a-f]{40}$/i);
      expect(gateRuns).toBe(1);
      expect(pushRuns).toBe(1);
      expect(port.commits.filter((message) => message.includes('merge app [T-PROGRESS]'))).toHaveLength(1);

      const next = await svc.start({
        repoKey: 'app',
        taskIds: ['T-AFTER-PROGRESS'],
        idempotencyKey: 'after-progress-fault',
      });
      expect(next).toMatchObject({ repoKey: 'app', status: 'accepted' });
      await svc.waitFor(next.operationId);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('recovers a readable accepted record when its initial put throws', async () => {
    class AcceptanceFaultStore extends MergeOperationStore {
      acceptanceFailures = 0;

      override async put(record: import('../../src/domain/mergeOperation.js').MergeOperationRecord) {
        if (record.status === 'accepted' && this.acceptanceFailures === 0) {
          await super.put(record);
          const digest = createHash('sha256')
            .update(`${record.repoKey}\0${record.idempotencyKey ?? ''}`, 'utf8')
            .digest('hex')
            .slice(0, 32);
          await rm(
            join(root, '.hercules-merge-ops', 'by-key', `${record.repoKey}.${digest}.json`),
            { force: true },
          );
          this.acceptanceFailures += 1;
          throw new Error('injected post-rename acceptance failure');
        }
        return super.put(record);
      }
    }

    await setupOrigin();
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(6095, 4) });
    const tip = await plantBranch(ws, 'T-ACCEPT-FAULT', { 'accept.txt': 'complete\n' });
    const port = new FakePort(
      new Map([['T-ACCEPT-FAULT', makeTask('T-ACCEPT-FAULT', { verifiedSha: tip })]]),
      targetUrl,
    );
    const store = new AcceptanceFaultStore(root);
    let gateRuns = 0;
    let pushRuns = 0;
    const baseWorkspaces = mergeWorkspacesFrom(ws);
    const svc = new MergeOperationService({
      store,
      mergeDeps: {
        control: port,
        workspaces: {
          ...baseWorkspaces,
          openMergeWorktree: async (repoConfig) => {
            const handle = await baseWorkspaces.openMergeWorktree(repoConfig);
            return new Proxy(handle, {
              get(target, property, receiver) {
                if (property === 'pushDefaultBranch') {
                  return async (pushRepo: RepoConfig): Promise<void> => {
                    pushRuns += 1;
                    await target.pushDefaultBranch(pushRepo);
                  };
                }
                return Reflect.get(target, property, receiver) as unknown;
              },
            });
          },
        },
        commandRunner: async () => {
          gateRuns += 1;
          return { exitCode: 0, output: 'ok' };
        },
      },
    });

    const first = await svc.start({
      repoKey: 'app',
      taskIds: ['T-ACCEPT-FAULT'],
      idempotencyKey: 'accepted-then-throw',
    });
    const retry = await svc.start({
      repoKey: 'app',
      taskIds: ['T-ACCEPT-FAULT'],
      idempotencyKey: 'accepted-then-throw',
    });
    expect(store.acceptanceFailures).toBe(1);
    expect(retry.operationId).toBe(first.operationId);
    expect((await store.listAll()).filter((record) =>
      record.idempotencyKey === 'accepted-then-throw')).toHaveLength(1);

    const final = await svc.waitFor(first.operationId);
    expect(final).toMatchObject({ status: 'succeeded', phase: 'stamped' });
    expect(final?.mergedSha).toMatch(/^[0-9a-f]{40}$/i);
    expect(gateRuns).toBe(1);
    expect(pushRuns).toBe(1);
    expect(port.commits.filter((message) => message.includes('merge app [T-ACCEPT-FAULT]'))).toHaveLength(1);
  });

  it('adopts a same-process accepted ghost after the acceptance write and recovery read fail', async () => {
    class AcceptanceGhostStore extends MergeOperationStore {
      acceptanceFailures = 0;
      recoveryReadFailures = 0;

      override async put(record: import('../../src/domain/mergeOperation.js').MergeOperationRecord) {
        if (record.status === 'accepted' && this.acceptanceFailures === 0) {
          await super.put(record);
          this.acceptanceFailures += 1;
          throw new Error('injected persisted acceptance failure');
        }
        return super.put(record);
      }

      override async get(operationId: string) {
        if (this.acceptanceFailures === 1 && this.recoveryReadFailures === 0) {
          this.recoveryReadFailures += 1;
          throw new Error('injected immediate recovery read failure');
        }
        return super.get(operationId);
      }
    }

    await setupOrigin();
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(6097, 4) });
    const tip = await plantBranch(ws, 'T-ACCEPT-GHOST', { 'ghost.txt': 'complete\n' });
    const port = new FakePort(
      new Map([['T-ACCEPT-GHOST', makeTask('T-ACCEPT-GHOST', { verifiedSha: tip })]]),
      targetUrl,
    );
    const store = new AcceptanceGhostStore(root);
    let gateRuns = 0;
    let pushRuns = 0;
    const baseWorkspaces = mergeWorkspacesFrom(ws);
    const svc = new MergeOperationService({
      store,
      mergeDeps: {
        control: port,
        workspaces: {
          ...baseWorkspaces,
          openMergeWorktree: async (repoConfig) => {
            const handle = await baseWorkspaces.openMergeWorktree(repoConfig);
            return new Proxy(handle, {
              get(target, property, receiver) {
                if (property === 'pushDefaultBranch') {
                  return async (pushRepo: RepoConfig): Promise<void> => {
                    pushRuns += 1;
                    await target.pushDefaultBranch(pushRepo);
                  };
                }
                return Reflect.get(target, property, receiver) as unknown;
              },
            });
          },
        },
        commandRunner: async () => {
          gateRuns += 1;
          return { exitCode: 0, output: 'ok' };
        },
      },
    });
    const request = {
      repoKey: 'app',
      taskIds: ['T-ACCEPT-GHOST'],
      idempotencyKey: 'accepted-ghost-retry',
    } as const;

    await expect(svc.start(request)).rejects.toThrow(
      'injected persisted acceptance failure',
    );
    const durable = (await store.listAll()).find(
      (record) => record.idempotencyKey === request.idempotencyKey,
    );
    expect(durable).toMatchObject({ status: 'accepted', phase: 'accepted' });

    const retry = await svc.start(request);
    expect(retry.operationId).toBe(durable?.operationId);
    const final = await svc.waitFor(retry.operationId);
    expect(final).toMatchObject({ status: 'succeeded', phase: 'stamped' });
    expect(final?.mergedSha).toMatch(/^[0-9a-f]{40}$/i);
    expect(store.acceptanceFailures).toBe(1);
    expect(store.recoveryReadFailures).toBe(1);
    expect(gateRuns).toBe(1);
    expect(pushRuns).toBe(1);
    expect(port.commits.filter((message) =>
      message.includes('merge app [T-ACCEPT-GHOST]'))).toHaveLength(1);
  });

  it('does not adopt an uncertain acceptance when another durable repo operation is active', async () => {
    class AmbiguousAcceptanceStore extends MergeOperationStore {
      acceptanceFailures = 0;
      recoveryReadFailures = 0;

      override async put(record: import('../../src/domain/mergeOperation.js').MergeOperationRecord) {
        if (record.status === 'accepted' && this.acceptanceFailures === 0) {
          await super.put(record);
          this.acceptanceFailures += 1;
          throw new Error('injected persisted acceptance failure');
        }
        return super.put(record);
      }

      override async get(operationId: string) {
        if (this.acceptanceFailures === 1 && this.recoveryReadFailures === 0) {
          this.recoveryReadFailures += 1;
          throw new Error('injected immediate recovery read failure');
        }
        return super.get(operationId);
      }
    }

    await setupOrigin();
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(6099, 4) });
    const tip = await plantBranch(ws, 'T-AMBIGUOUS-GHOST', { 'ambiguous.txt': 'complete\n' });
    const port = new FakePort(
      new Map([['T-AMBIGUOUS-GHOST', makeTask('T-AMBIGUOUS-GHOST', { verifiedSha: tip })]]),
      targetUrl,
    );
    const store = new AmbiguousAcceptanceStore(root);
    let gateRuns = 0;
    let pushRuns = 0;
    const baseWorkspaces = mergeWorkspacesFrom(ws);
    const svc = new MergeOperationService({
      store,
      pid: 42_424,
      mergeDeps: {
        control: port,
        workspaces: {
          ...baseWorkspaces,
          openMergeWorktree: async (repoConfig) => {
            const handle = await baseWorkspaces.openMergeWorktree(repoConfig);
            return new Proxy(handle, {
              get(target, property, receiver) {
                if (property === 'pushDefaultBranch') {
                  return async (pushRepo: RepoConfig): Promise<void> => {
                    pushRuns += 1;
                    await target.pushDefaultBranch(pushRepo);
                  };
                }
                return Reflect.get(target, property, receiver) as unknown;
              },
            });
          },
        },
        commandRunner: async () => {
          gateRuns += 1;
          return { exitCode: 0, output: 'unexpected' };
        },
      },
    });
    const request = {
      repoKey: 'app',
      taskIds: ['T-AMBIGUOUS-GHOST'],
      idempotencyKey: 'ambiguous-ghost-retry',
    } as const;

    await expect(svc.start(request)).rejects.toThrow(
      'injected persisted acceptance failure',
    );
    const uncertain = (await store.listAll()).find(
      (record) => record.idempotencyKey === request.idempotencyKey,
    );
    expect(uncertain).toMatchObject({ status: 'accepted', phase: 'accepted' });
    const competing = {
      version: 1,
      operationId: 'mop-competing-active',
      repoKey: 'app',
      taskIds: ['T-COMPETING'],
      idempotencyKey: 'competing-active',
      status: 'running',
      phase: 'gating',
      mergedSha: null,
      failures: [],
      createdAtMs: 2,
      updatedAtMs: 2,
      gateProgress: null,
      failureKind: null,
      ownerPid: 42_424,
    } as const;
    await store.put(competing);

    const retry = await svc.start(request);
    expect(retry.operationId).toBe(uncertain?.operationId);
    await new Promise((resolve) => setImmediate(resolve));
    expect(gateRuns).toBe(0);
    expect(pushRuns).toBe(0);
    expect(port.commits).toEqual([]);
    expect((await store.get(retry.operationId))?.status).toBe('accepted');

    await store.put({
      ...competing,
      status: 'failed',
      phase: 'failed',
      failures: [{ taskId: 'T-COMPETING', reason: 'stopped', kind: 'precheck' }],
      failureKind: 'precheck',
    });
    const retryAfterMarkerConsumption = await svc.start(request);
    expect(retryAfterMarkerConsumption.operationId).toBe(retry.operationId);
    await new Promise((resolve) => setImmediate(resolve));
    expect(gateRuns).toBe(0);
    expect(pushRuns).toBe(0);

    const reconciled = await svc.reconcileInterrupted();
    expect(reconciled).toHaveLength(1);
    expect((await store.get(retry.operationId))?.status).toBe('interrupted');
    expect(gateRuns).toBe(0);
    expect(pushRuns).toBe(0);
    expect(port.commits).toEqual([]);
  });

  it.each([
    ['running', 'running', 'gating', 42_424],
    ['terminal', 'failed', 'failed', 42_424],
    ['arbitrary-accepted', 'accepted', 'accepted', 42_424],
    ['foreign-owner', 'accepted', 'accepted', 42_425],
  ] as const)('never adopts a %s existing record', async (
    scenario,
    status,
    phase,
    ownerPid,
  ) => {
    const scenarioRoot = join(root, scenario);
    const store = new MergeOperationStore(scenarioRoot);
    const operationId = `mop-no-adopt-${scenario}`;
    const failure = status === 'failed'
      ? [{ taskId: 'T-NO-ADOPT', reason: 'merge precheck failed', kind: 'precheck' as const }]
      : [];
    await store.put({
      version: 1,
      operationId,
      repoKey: 'app',
      taskIds: ['T-NO-ADOPT'],
      idempotencyKey: `no-adopt-${scenario}`,
      status,
      phase,
      mergedSha: null,
      failures: failure,
      createdAtMs: 1,
      updatedAtMs: 1,
      gateProgress: null,
      failureKind: status === 'failed' ? 'precheck' : null,
      ownerPid,
    });
    let gateRuns = 0;
    const svc = new MergeOperationService({
      store,
      pid: 42_424,
      mergeDeps: {
        control: new FakePort(new Map(), targetUrl),
        workspaces: mergeWorkspacesFrom(
          new GitWorkspaces({ root: scenarioRoot, ports: new PortAllocator(6098, 4) }),
        ),
        commandRunner: async () => {
          gateRuns += 1;
          return { exitCode: 0, output: 'unexpected' };
        },
      },
    });

    const receipt = await svc.start({
      repoKey: 'app',
      taskIds: ['T-NO-ADOPT'],
      idempotencyKey: `no-adopt-${scenario}`,
    });
    expect(receipt.operationId).toBe(operationId);
    await new Promise((resolve) => setImmediate(resolve));
    expect(gateRuns).toBe(0);
    expect((await store.get(operationId))?.status).toBe(status);
  });

  it('accepts promptly; same key returns same op; delayed gates still succeed', async () => {
    await setupOrigin();
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(6100, 4) });
    const tip = await plantBranch(ws, 'T-MOP', { 'mop.txt': 'yes\n' });
    const port = new FakePort(
      new Map([['T-MOP', makeTask('T-MOP', { verifiedSha: tip })]]),
      targetUrl,
    );
    let releaseHold!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let gateRuns = 0;
    const store = new MergeOperationStore(root);
    const svc = new MergeOperationService({
      store,
      mergeDeps: {
        control: port,
        workspaces: mergeWorkspacesFrom(ws),
        commandRunner: async () => {
          gateRuns += 1;
          await hold;
          return { exitCode: 0, output: 'ok' };
        },
      },
    });
    const t0 = Date.now();
    const receipt = await svc.start({
      repoKey: 'app',
      taskIds: ['T-MOP'],
      idempotencyKey: 'key-1',
    });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(receipt.status).toMatch(/accepted|running/);
    expect(receipt.operationId).toMatch(/^mop-/);
    expect(receipt.taskIds).toEqual(['T-MOP']);
    expect(receipt.mergedSha).toBeNull();

    const retry = await svc.start({
      repoKey: 'app',
      taskIds: ['T-MOP'],
      idempotencyKey: 'key-1',
    });
    expect(retry.operationId).toBe(receipt.operationId);
    expect(retry.taskIds).toEqual(['T-MOP']);

    await expect(
      svc.start({ repoKey: 'app', taskIds: ['T-MOP'], idempotencyKey: 'key-2' }),
    ).rejects.toThrow(/already in flight/);

    const deadline = Date.now() + 15_000;
    while (gateRuns === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(gateRuns).toBe(1);
    releaseHold();
    const final = await svc.waitFor(receipt.operationId);
    expect(final?.status).toBe('succeeded');
    expect(final?.mergedSha).toMatch(/^[0-9a-f]{40}$/i);
    expect(port.tasks.get('T-MOP')!.mergedSha).toBe(final!.mergedSha);
    expect(port.tasks.get('T-MOP')!.mergedVia).toBe('gate');
    expect(gateRuns).toBe(1);
  });

  it('reconcileInterrupted marks non-live ops as interrupted', async () => {
    const store = new MergeOperationStore(root);
    const now = Date.now();
    await store.put({
      version: 1,
      operationId: 'mop-restart-1',
      repoKey: 'app',
      taskIds: ['T-X'],
      idempotencyKey: null,
      status: 'running',
      phase: 'gating',
      mergedSha: null,
      failures: [],
      createdAtMs: now,
      updatedAtMs: now,
      gateProgress: null,
      failureKind: null,
      ownerPid: 999_999,
    });
    const svc = new MergeOperationService({
      store,
      mergeDeps: {
        control: new FakePort(new Map(), targetUrl),
        workspaces: mergeWorkspacesFrom(
          new GitWorkspaces({ root, ports: new PortAllocator(6200, 4) }),
        ),
      },
    });
    const reconciled = await svc.reconcileInterrupted();
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.status).toBe('interrupted');
    expect(reconciled[0]?.failureKind).toBe('interrupted');
    expect((await svc.get('mop-restart-1'))?.status).toBe('interrupted');
  });

  it('reconciles a crash after push and all provenance stamps to exact success', async () => {
    await setupOrigin();
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(6250, 4) });
    const tip = await plantBranch(ws, 'T-CRASH', { 'crash.txt': 'pushed\n' });
    const port = new FakePort(
      new Map([['T-CRASH', makeTask('T-CRASH', { verifiedSha: tip })]]),
      targetUrl,
    );
    const store = new MergeOperationStore(root);
    const neverFinalize = new Promise<void>(() => {});
    const crashed = new MergeOperationService({
      store,
      mergeDeps: {
        control: port,
        workspaces: mergeWorkspacesFrom(ws),
        commandRunner: async () => ({ exitCode: 0, output: 'ok' }),
      },
      afterMergeBeforeSuccessPatch: () => neverFinalize,
    });
    const accepted = await crashed.start({
      repoKey: 'app',
      taskIds: ['T-CRASH'],
      idempotencyKey: 'crash-after-stamp',
    });
    const deadline = Date.now() + 15_000;
    while (
      (
        port.tasks.get('T-CRASH')?.mergedVia !== 'gate' ||
        (await store.get(accepted.operationId))?.phase !== 'stamped'
      ) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const stampedSha = port.tasks.get('T-CRASH')?.mergedSha;
    expect(stampedSha).toMatch(/^[0-9a-f]{40}$/i);
    expect(await store.get(accepted.operationId)).toMatchObject({
      status: 'running',
      phase: 'stamped',
    });

    const restarted = new MergeOperationService({
      store,
      mergeDeps: { control: port, workspaces: mergeWorkspacesFrom(ws) },
    });
    const [receipt] = await restarted.reconcileInterrupted();
    expect(receipt).toMatchObject({
      operationId: accepted.operationId,
      status: 'succeeded',
      phase: 'stamped',
      mergedSha: stampedSha,
      failures: [],
    });
  });

  it('does not attribute historical gate provenance to an operation accepted before precheck', async () => {
    const historicalSha = 'a'.repeat(40);
    const port = new FakePort(new Map([
      ['T-OLD', makeTask('T-OLD', { mergedVia: 'gate', mergedSha: historicalSha })],
    ]), targetUrl);
    const store = new MergeOperationStore(root);
    const now = Date.now();
    await store.put({
      version: 1,
      operationId: 'mop-accepted-old-provenance-1',
      repoKey: 'app',
      taskIds: ['T-OLD'],
      idempotencyKey: 'accepted-old-provenance',
      status: 'accepted',
      phase: 'accepted',
      mergedSha: null,
      failures: [],
      createdAtMs: now,
      updatedAtMs: now,
      gateProgress: null,
      failureKind: null,
      ownerPid: 999_999,
    });

    const restarted = new MergeOperationService({
      store,
      mergeDeps: {
        control: port,
        workspaces: mergeWorkspacesFrom(
          new GitWorkspaces({ root, ports: new PortAllocator(6255, 4) }),
        ),
      },
    });
    const [receipt] = await restarted.reconcileInterrupted();
    expect(receipt).toMatchObject({
      operationId: 'mop-accepted-old-provenance-1',
      status: 'interrupted',
      phase: 'interrupted',
      mergedSha: null,
      failureKind: 'interrupted',
    });
  });

  it('does not invent restart success when selected provenance is partial or differs', async () => {
    const shared = 'a'.repeat(40);
    const port = new FakePort(new Map([
      ['T-A', makeTask('T-A', { mergedVia: 'gate', mergedSha: shared })],
      ['T-B', makeTask('T-B', { mergedVia: 'gate', mergedSha: 'b'.repeat(40) })],
    ]), targetUrl);
    const store = new MergeOperationStore(root);
    const now = Date.now();
    await store.put({
      version: 1,
      operationId: 'mop-partial-stamp-1',
      repoKey: 'app',
      taskIds: ['T-A', 'T-B'],
      idempotencyKey: 'partial-stamp',
      status: 'running',
      phase: 'stamping',
      mergedSha: null,
      failures: [],
      createdAtMs: now,
      updatedAtMs: now,
      gateProgress: null,
      failureKind: null,
      ownerPid: 999_999,
    });
    const restarted = new MergeOperationService({
      store,
      mergeDeps: {
        control: port,
        workspaces: mergeWorkspacesFrom(
          new GitWorkspaces({ root, ports: new PortAllocator(6260, 4) }),
        ),
      },
    });
    const [receipt] = await restarted.reconcileInterrupted();
    expect(receipt).toMatchObject({
      status: 'interrupted',
      phase: 'interrupted',
      mergedSha: null,
      failureKind: 'interrupted',
    });
  });

  it('serializes concurrent acceptance by repository and idempotency key', async () => {
    await setupOrigin();
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(6300, 4) });
    const tip = await plantBranch(ws, 'T-RACE', { 'race.txt': 'yes\n' });
    const port = new FakePort(
      new Map([['T-RACE', makeTask('T-RACE', { verifiedSha: tip })]]),
      targetUrl,
    );
    let releaseHold!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let gateRuns = 0;
    const svc = new MergeOperationService({
      store: new MergeOperationStore(root),
      mergeDeps: {
        control: port,
        workspaces: mergeWorkspacesFrom(ws),
        commandRunner: async () => {
          gateRuns += 1;
          await hold;
          return { exitCode: 0, output: 'ok' };
        },
      },
    });

    const same = await Promise.all([
      svc.start({ repoKey: 'app', taskIds: ['T-RACE'], idempotencyKey: 'same' }),
      svc.start({ repoKey: 'app', taskIds: ['T-RACE'], idempotencyKey: 'same' }),
    ]);
    expect(same[0].operationId).toBe(same[1].operationId);

    const different = await Promise.allSettled([
      svc.start({ repoKey: 'app', taskIds: ['T-RACE'], idempotencyKey: 'other-a' }),
      svc.start({ repoKey: 'app', taskIds: ['T-RACE'], idempotencyKey: 'other-b' }),
    ]);
    expect(different.every((result) => result.status === 'rejected')).toBe(true);
    releaseHold();
    await svc.waitFor(same[0].operationId);
    expect(gateRuns).toBe(1);
  });
});
