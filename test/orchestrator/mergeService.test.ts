/**
 * Safe batch Merge — real temp-repo integration tests (design §3 / §7).
 *
 * Four scenarios:
 * 1. Clean batch → push main + stamp merged_sha
 * 2. Conflicting branch → affected task back to review; origin main untouched
 * 3. verified-SHA mismatch → refused (review); origin main untouched
 * 4. Gate failure on merged result → no push; tasks back to review
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
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
import {
  MergeService,
  MergeError,
  mergeWorkspacesFrom,
  type MergeWorkspaces,
} from '../../src/orchestrator/mergeService.js';
import { ActionService, ActionError } from '../../src/orchestrator/actions.js';
import { MergeOperationService } from '../../src/orchestrator/mergeOperationService.js';
import { MergeOperationStore } from '../../src/isolation/mergeOperationStore.js';
import type { RepoProbe } from '../../src/orchestrator/repoProbe.js';
import { createApi } from '../../src/server/api.js';
import type { RuntimeView } from '../../src/orchestrator/orchestrator.js';
import { pathLeaseDeclarationDigest } from '../../src/control/pathLeaseDigest.js';
import type { WorkspaceSuccessionLedger } from '../../src/domain/workspaceSuccession.js';
import type { MergeOperationPhase } from '../../src/domain/mergeOperation.js';
import { MergeFailureReceiptStore } from '../../src/isolation/mergeFailureReceiptStore.js';
import {
  bodyHasMergeGateFailure,
  parseMergeFailureReceipt,
} from '../../src/domain/mergeFailureReceipt.js';

let tmp: string;
let root: string;
let targetUrl: string;
let repo: RepoConfig;
let mainAtStart: string;

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

function scopedTask(
  id: string,
  tip: string,
  plannedBaseRevision: string,
  affectedPaths: readonly string[],
  protectedPathsSnapshot: readonly string[] = [],
): Task {
  const task = makeTask(id, {
    verifiedSha: tip,
    plannedBaseRevision,
    affectedPaths,
    protectedPathsSnapshot,
  });
  return { ...task, verifiedPathLeaseDigest: pathLeaseDeclarationDigest(task) };
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

class SuccessionFakePort extends FakePort {
  succession: WorkspaceSuccessionLedger | null = null;

  async readSuccession(): Promise<WorkspaceSuccessionLedger | null> {
    return this.succession;
  }

  async writeSuccession(ledger: WorkspaceSuccessionLedger): Promise<void> {
    this.succession = ledger;
  }
}

class PostPushFailurePort extends FakePort {
  async mutateCommitted(): Promise<never> {
    throw new Error('injected durable control failure');
  }
}

async function originMainSha(): Promise<string> {
  return (await simpleGit(targetUrl).revparse(['HEAD'])).trim();
}

async function setupOrigin(workflowGates: string, setupBlock = ''): Promise<void> {
  // Non-bare working tree for easy file assertions, but allow push into the
  // checked-out main (simulates a bare/GitHub remote for the merge service).
  await mkdir(targetUrl, { recursive: true });
  const g = simpleGit(targetUrl);
  await g.init(['-b', 'main']);
  await g.addConfig('user.email', 't@h.local');
  await g.addConfig('user.name', 'T');
  await g.addConfig('receive.denyCurrentBranch', 'updateInstead');
  await writeFile(join(targetUrl, 'README.md'), '# target\n');
  await writeFile(join(targetUrl, 'shared.txt'), 'base\n');
  await writeFile(
    join(targetUrl, 'WORKFLOW.md'),
    `---\n${setupBlock}gates:\n${workflowGates}---\nbe careful\n`,
  );
  await g.add('.');
  await g.commit('initial');
  mainAtStart = (await g.revparse(['HEAD'])).trim();
}

/**
 * Cut hercules/<id> from main, write files, commit, preserve on mirror.
 * Returns the verified tip SHA.
 */
async function plantBranch(
  ws: GitWorkspaces,
  taskId: string,
  files: Record<string, string>,
): Promise<string> {
  const w = await ws.create(repo, taskId, { hadPriorWork: false });
  const g = simpleGit(w.dir);
  await g.addConfig('user.email', 't@h.local');
  await g.addConfig('user.name', 'T');
  for (const [rel, content] of Object.entries(files)) {
    const path = join(w.dir, rel);
    await mkdir(join(path, '..'), { recursive: true }).catch(() => undefined);
    await writeFile(path, content);
  }
  await g.add('.');
  await g.commit(`work ${taskId}`);
  const tip = (await g.revparse(['HEAD'])).trim();
  await ws.preserve(taskId, `preserve ${taskId}`);
  return tip;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'hercules-merge-'));
  root = join(tmp, 'root');
  await mkdir(root, { recursive: true });
  targetUrl = join(tmp, 'target');
  repo = {
    key: 'app',
    url: targetUrl,
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

describe('MergeService (real temp repos)', { timeout: 60_000 }, () => {
  it('reports truthful path-free managed workspace dispositions', async () => {
    await setupOrigin('  test: "true"\n');
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5199, 4) });
    await ws.create(repo, 'T-LIVE', { hadPriorWork: false });
    expect(await ws.managedDisposition('app', 'T-LIVE')).toBe('live');
    await ws.preserve('T-LIVE', 'preserve live');
    expect(await ws.managedDisposition('app', 'T-LIVE')).toBe('preserved');
    await ws.create(repo, 'T-REMOVE', { hadPriorWork: false });
    await ws.remove('T-REMOVE');
    expect(await ws.managedDisposition('app', 'T-REMOVE')).toBe('removed');
    expect(await ws.managedDisposition('app', 'T-NEVER')).toBe('absent');
  });

  it('accepts first-time one-file WORKFLOW bootstrap without executing candidate gates', async () => {
    // Origin has no WORKFLOW — incomplete Guardian onboarding bootstrap.
    await mkdir(targetUrl, { recursive: true });
    const g = simpleGit(targetUrl);
    await g.init(['-b', 'main']);
    await g.addConfig('user.email', 't@h.local');
    await g.addConfig('user.name', 'T');
    await g.addConfig('receive.denyCurrentBranch', 'updateInstead');
    await writeFile(join(targetUrl, 'README.md'), '# bare\n');
    await g.add('.');
    await g.commit('initial without workflow');
    mainAtStart = (await g.revparse(['HEAD'])).trim();

    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5310, 4) });
    const workflowBody =
      '---\ngates:\n  test: "echo should-not-run"\nsetup:\n  install:\n    - "echo install-should-not-run"\n---\nprinciples\n';
    const tip = await plantBranch(ws, 'BOOT-WF', { 'WORKFLOW.md': workflowBody });
    const bootTask = scopedTask('BOOT-WF', tip, mainAtStart, ['WORKFLOW.md'], []);
    const port = new SuccessionFakePort(
      new Map([
        [
          'BOOT-WF',
          {
            ...bootTask,
            labels: ['onboarding', 'readiness'],
          },
        ],
      ]),
      targetUrl,
    );
    port.repos = {
      repos: {
        app: {
          key: 'app',
          url: targetUrl,
          defaultBranch: 'main',
          workflow: 'WORKFLOW.md',
          maxConcurrent: 1,
          adapter: null,
          readiness: 'incomplete',
        },
      },
    };
    const ran: string[] = [];
    const merge = new MergeService({
      control: port,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async (command: string) => {
        ran.push(command);
        return { exitCode: 0, output: 'ok' };
      },
    });
    const result = await merge.mergeBatch('app', ['BOOT-WF']);
    expect(result.ok).toBe(true);
    expect(result.mergedSha).toMatch(/^[0-9a-f]{40}$/i);
    expect(await readFile(join(targetUrl, 'WORKFLOW.md'), 'utf8')).toContain('principles');
    // Candidate-defined commands must not execute on bootstrap merge.
    expect(ran).toEqual([]);
    expect(port.tasks.get('BOOT-WF')!.mergedSha).toBe(result.mergedSha);
  });

  it('inherits L1 for a single verified-green task whose merge-base is the default tip (C3.57)', async () => {
    await setupOrigin('  test: "echo gate-ran"\n');
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5320, 4) });
    const tip = await plantBranch(ws, 'INH-1', { 'feature.txt': 'x\n' });
    const t = makeTask('INH-1', { verifiedSha: tip, verifiedGatesGreen: true });
    const port = new FakePort(new Map([['INH-1', t]]), targetUrl);
    port.repos = { repos: { app: repo } };
    const ran: string[] = [];
    const merge = new MergeService({
      control: port,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async (command) => {
        ran.push(command);
        return { exitCode: 0, output: 'ok' };
      },
    });
    const result = await merge.mergeBatch('app', ['INH-1']);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(ran).toEqual([]);
    expect(result.gatesInheritedFromSha).toBe(tip.toLowerCase());
    const merged = result.tasks.find((x) => x.id === 'INH-1');
    expect(merged?.mergedSha).toBe(result.mergedSha);
    // Merged tree is byte-identical to the verified tip's tree.
    const origin = simpleGit(targetUrl);
    expect((await origin.raw(['rev-parse', 'HEAD^{tree}'])).trim()).toBe(
      (await origin.raw(['rev-parse', `${tip}^{tree}`])).trim(),
    );
  });

  it('re-runs gates when main moved after verification, or when L1 was not recorded green (C3.57)', async () => {
    await setupOrigin('  test: "echo gate-ran"\n');
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5324, 4) });
    const tipA = await plantBranch(ws, 'INH-A', { 'a.txt': 'a\n' });
    const tipB = await plantBranch(ws, 'INH-B', { 'b.txt': 'b\n' });
    // main moves after both verifications (unrelated file → no conflict).
    const origin = simpleGit(targetUrl);
    await writeFile(join(targetUrl, 'moved.txt'), 'main moved\n');
    await origin.add('.');
    await origin.commit('main advanced');
    const tasks = new Map<string, Task>([
      ['INH-A', makeTask('INH-A', { verifiedSha: tipA, verifiedGatesGreen: true })],
      ['INH-B', makeTask('INH-B', { verifiedSha: tipB })], // no verified_gates_green
    ]);
    const port = new FakePort(tasks, targetUrl);
    port.repos = { repos: { app: repo } };
    const ran: string[] = [];
    const merge = new MergeService({
      control: port,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async (command) => {
        ran.push(command);
        return { exitCode: 0, output: 'ok' };
      },
    });
    const moved = await merge.mergeBatch('app', ['INH-A']);
    expect(moved.failures).toEqual([]);
    expect(moved.ok).toBe(true);
    expect(moved.gatesInheritedFromSha ?? null).toBeNull();
    expect(ran).toEqual(['echo gate-ran']);

    // INH-B: main advanced past its base as well AND no verified_gates_green → gates run.
    const notGreen = await merge.mergeBatch('app', ['INH-B']);
    expect(notGreen.ok).toBe(true);
    expect(notGreen.gatesInheritedFromSha ?? null).toBeNull();
    expect(ran).toEqual(['echo gate-ran', 'echo gate-ran']);
  });

  it('preserves normal trusted gates when onboarding work edits an existing workflow', async () => {
    await setupOrigin('  test: "echo trusted-existing-gate"\n');
    repo = { ...repo, readiness: 'incomplete' };
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5312, 4) });
    const tip = await plantBranch(ws, 'EDIT-WF', {
      'WORKFLOW.md':
        '---\ngates:\n  test: "echo candidate-command"\n---\nupdated principles\n',
    });
    const editTask = {
      ...scopedTask('EDIT-WF', tip, mainAtStart, ['WORKFLOW.md'], []),
      labels: ['onboarding', 'readiness'],
    };
    const port = new FakePort(new Map([['EDIT-WF', editTask]]), targetUrl);
    port.repos = { repos: { app: repo } };
    const ran: string[] = [];
    const merge = new MergeService({
      control: port,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async (command) => {
        ran.push(command);
        return { exitCode: 0, output: 'ok' };
      },
    });

    const result = await merge.mergeBatch('app', ['EDIT-WF']);
    expect(result.ok).toBe(true);
    expect(ran).toEqual(['echo trusted-existing-gate']);
  });

  it('refuses bootstrap merge when candidate changes more than WORKFLOW', async () => {
    await mkdir(targetUrl, { recursive: true });
    const g = simpleGit(targetUrl);
    await g.init(['-b', 'main']);
    await g.addConfig('user.email', 't@h.local');
    await g.addConfig('user.name', 'T');
    await g.addConfig('receive.denyCurrentBranch', 'updateInstead');
    await writeFile(join(targetUrl, 'README.md'), '# bare\n');
    await g.add('.');
    await g.commit('initial without workflow');
    mainAtStart = (await g.revparse(['HEAD'])).trim();

    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5311, 4) });
    const tip = await plantBranch(ws, 'BOOT-BAD', {
      'WORKFLOW.md': '---\ngates: {}\n---\n',
      'extra.txt': 'nope\n',
    });
    // Declaration claims only WORKFLOW but tip also has extra.txt — merge path-scope fails.
    const bootTask = {
      ...scopedTask('BOOT-BAD', tip, mainAtStart, ['WORKFLOW.md'], []),
      expectedBaseRevision: mainAtStart,
      expectedRemoteTip: tip,
    };
    const port = new FakePort(
      new Map([
        [
          'BOOT-BAD',
          {
            ...bootTask,
            labels: ['onboarding'],
          },
        ],
      ]),
      targetUrl,
    );
    port.repos = {
      repos: {
        app: {
          key: 'app',
          url: targetUrl,
          defaultBranch: 'main',
          workflow: 'WORKFLOW.md',
          maxConcurrent: 1,
          adapter: null,
          readiness: 'incomplete',
        },
      },
    };
    const merge = new MergeService({
      control: port,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async () => ({ exitCode: 0, output: 'ok' }),
      succession: { clock: () => new Date('2026-08-04T12:00:00.000Z') },
    });
    const result = await merge.mergeBatch('app', ['BOOT-BAD']);
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.reason).toMatch(/outside affected_paths|bootstrap/i);
  });

  it('runs setup.install before post-merge gates (fresh workspace has no deps)', async () => {
    // Real incident 2026-07-24: post-merge typecheck ran in a fresh .merge
    // workspace with no node_modules — mergeService never ran setup.install.
    await setupOrigin(
      '  typecheck: "pnpm typecheck"\n',
      'setup:\n  install:\n    - pnpm install --frozen-lockfile\n',
    );
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5300, 4) });
    const tip = await plantBranch(ws, 'T-S', { 's.txt': 'setup\n' });
    const port = new FakePort(new Map([['T-S', makeTask('T-S', { verifiedSha: tip })]]), targetUrl);
    const ran: string[] = [];
    const merge = new MergeService({
      control: port,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async (command: string) => {
        ran.push(command);
        return { exitCode: 0, output: 'ok' };
      },
    });
    const result = await merge.mergeBatch('app', ['T-S']);
    expect(result.ok).toBe(true);
    const install = ran.indexOf('pnpm install --frozen-lockfile');
    const gate = ran.indexOf('pnpm typecheck');
    expect(install).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(install).toBeLessThan(gate);
  });

  it('clean batch: merges, re-runs gates, pushes main, stamps merged_sha', async () => {
    await setupOrigin('  test: "true"\n');
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5200, 4) });
    const tipA = await plantBranch(ws, 'T-A', { 'a.txt': 'alpha\n' });
    const tipB = await plantBranch(ws, 'T-B', { 'b.txt': 'beta\n' });

    const port = new SuccessionFakePort(
      new Map([
        ['T-A', makeTask('T-A', { verifiedSha: tipA,
          expectedBaseRevision: mainAtStart, expectedRemoteTip: tipA })],
        ['T-B', makeTask('T-B', { verifiedSha: tipB,
          expectedBaseRevision: mainAtStart, expectedRemoteTip: tipB })],
      ]),
      targetUrl,
    );
    const merge = new MergeService({
      control: port,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async () => ({ exitCode: 0, output: 'ok' }),
      succession: { clock: () => new Date('2026-08-04T12:00:00.000Z') },
    });

    const before = await originMainSha();
    expect(before).toBe(mainAtStart);

    const result = await merge.mergeBatch('app', ['T-A', 'T-B']);
    expect(result.ok).toBe(true);
    expect(result.mergedSha).toMatch(/^[0-9a-f]{40}$/i);
    expect(result.failures).toHaveLength(0);

    const after = await originMainSha();
    expect(after).toBe(result.mergedSha);
    expect(after).not.toBe(before);

    // Both feature files landed on main.
    expect(await readFile(join(targetUrl, 'a.txt'), 'utf8')).toBe('alpha\n');
    expect(await readFile(join(targetUrl, 'b.txt'), 'utf8')).toBe('beta\n');

    const ta = port.tasks.get('T-A')!;
    const tb = port.tasks.get('T-B')!;
    expect(ta.state).toBe('done');
    expect(tb.state).toBe('done');
    expect(ta.mergedSha).toBe(result.mergedSha);
    expect(tb.mergedSha).toBe(result.mergedSha);
    expect(ta.mergedVia).toBe('gate');
    expect(tb.mergedVia).toBe('gate');
    expect(port.commits.some((c) => c.includes('merge app'))).toBe(true);
    expect(port.succession?.receipts).toHaveLength(1);
    expect(port.succession?.receipts[0]).toMatchObject({
      priorDefaultRevision: before,
      gateMergeSha: result.mergedSha,
      canonicalDefaultRevision: result.mergedSha,
      candidates: [
        { taskId: 'T-A', verifiedSha: tipA, lease: { branch: 'hercules/T-A' } },
        { taskId: 'T-B', verifiedSha: tipB, lease: { branch: 'hercules/T-B' } },
      ],
      managed: [
        { taskId: 'T-A', disposition: 'preserved' },
        { taskId: 'T-B', disposition: 'preserved' },
      ],
    });
  });

  it('heals a null remote-tip lease when origin holds exactly the verified tip (C3.55, verify-only run that pushed nothing)', async () => {
    await setupOrigin('  test: "true"\n');
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5207, 4) });
    const tipN = await plantBranch(ws, 'T-N', { 'n.txt': 'seeded\n' });
    const port = new SuccessionFakePort(
      new Map([['T-N', makeTask('T-N', {
        verifiedSha: tipN, expectedBaseRevision: mainAtStart, expectedRemoteTip: null,
      })]]),
      targetUrl,
    );
    const merge = new MergeService({
      control: port,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async () => ({ exitCode: 0, output: 'ok' }),
      succession: { clock: () => new Date('2026-08-04T12:00:00.000Z') },
    });
    const result = await merge.mergeBatch('app', ['T-N']);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    const tn = port.tasks.get('T-N')!;
    expect(tn.mergedSha).toBe(result.mergedSha);
    // The merged record carries the lease the merge proved.
    expect(tn.expectedRemoteTip).toBe(tipN);
    expect(port.succession?.receipts[0]?.candidates[0]).toMatchObject({
      taskId: 'T-N',
      verifiedSha: tipN,
      lease: { branch: 'hercules/T-N', expectedRemoteTip: tipN },
    });
  });

  it.each(['missing', 'invalid-tip', 'invalid-verified'] as const)(
    'fails in precheck without mutation for %s exact succession lease metadata',
    async (kind) => {
      await setupOrigin('  test: "true"\n');
      const ws = new GitWorkspaces({ root, ports: new PortAllocator(5205, 4) });
      const tip = await plantBranch(ws, `T-LEASE-${kind}`, { [`${kind}.txt`]: 'candidate\n' });
      const task = makeTask(`T-LEASE-${kind}`, {
        verifiedSha: kind === 'invalid-verified' ? 'short' : tip,
        ...(kind === 'invalid-tip'
          ? { expectedBaseRevision: mainAtStart, expectedRemoteTip: 'short' }
          : kind === 'invalid-verified'
            ? { expectedBaseRevision: mainAtStart, expectedRemoteTip: tip }
          : {}),
      });
      const port = new SuccessionFakePort(new Map([[task.id, task]]), targetUrl);
      const phases: MergeOperationPhase[] = [];
      const taskBefore = structuredClone(task);
      const commitsBefore = [...port.commits];
      const merge = new MergeService({
        control: port,
        workspaces: mergeWorkspacesFrom(ws),
        commandRunner: async () => ({ exitCode: 0, output: 'ok' }),
        succession: { clock: () => new Date('2026-08-04T12:00:00.000Z') },
        onProgress: ({ phase }) => phases.push(phase),
      });

      const result = await merge.mergeBatch('app', [task.id]);
      expect(result).toMatchObject({ ok: false, mergedSha: null, tasks: [] });
      expect(result.failures[0]?.reason).toMatch(/verified|remote.?tip|lease|candidate/i);
      expect(await originMainSha()).toBe(mainAtStart);
      expect(port.tasks.get(task.id)).toEqual(taskBefore);
      expect(port.succession).toBeNull();
      expect(port.commits).toEqual(commitsBefore);
      expect(phases).toEqual(['precheck']);
    },
  );

  it('succession receipt binds verified SHA separately from an exact tree-identical leased tip', async () => {
    await setupOrigin('  test: "true"\n');
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5206, 4) });
    const workspace = await ws.create(repo, 'T-EMPTY-LEASE', { hadPriorWork: false });
    const git = simpleGit(workspace.dir);
    await git.addConfig('user.email', 't@h.local');
    await git.addConfig('user.name', 'T');
    await writeFile(join(workspace.dir, 'verified.txt'), 'verified\n');
    await git.add('.');
    await git.commit('verified candidate');
    const verifiedSha = (await git.revparse(['HEAD'])).trim();
    await git.raw(['commit', '--allow-empty', '-m', 'preserved empty descendant']);
    const leasedTip = (await git.revparse(['HEAD'])).trim();
    expect(leasedTip).not.toBe(verifiedSha);
    await ws.preserve('T-EMPTY-LEASE', 'preserve exact empty descendant');

    const task = makeTask('T-EMPTY-LEASE', {
      verifiedSha,
      expectedBaseRevision: mainAtStart,
      expectedRemoteTip: leasedTip,
    });
    const port = new SuccessionFakePort(new Map([[task.id, task]]), targetUrl);
    const merge = new MergeService({
      control: port,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async () => ({ exitCode: 0, output: 'ok' }),
      succession: { clock: () => new Date('2026-08-04T12:00:00.000Z') },
    });

    const result = await merge.mergeBatch('app', [task.id]);
    expect(result.ok).toBe(true);
    expect(port.succession?.receipts[0]?.candidates).toEqual([{
      taskId: task.id,
      verifiedSha,
      lease: {
        branch: `hercules/${task.id}`,
        expectedBaseRevision: mainAtStart,
        expectedRemoteTip: leasedTip,
      },
    }]);
  });

  it('succession precheck rejects a content-changing exact leased descendant before push', async () => {
    await setupOrigin('  test: "true"\n');
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5207, 4) });
    const workspace = await ws.create(repo, 'T-CHANGED-LEASE', { hadPriorWork: false });
    const git = simpleGit(workspace.dir);
    await git.addConfig('user.email', 't@h.local');
    await git.addConfig('user.name', 'T');
    await writeFile(join(workspace.dir, 'verified.txt'), 'verified\n');
    await git.add('.');
    await git.commit('verified candidate');
    const verifiedSha = (await git.revparse(['HEAD'])).trim();
    await writeFile(join(workspace.dir, 'changed.txt'), 'changed after verification\n');
    await git.add('.');
    await git.commit('content-changing descendant');
    const leasedTip = (await git.revparse(['HEAD'])).trim();
    await ws.preserve('T-CHANGED-LEASE', 'preserve changed descendant');

    const task = makeTask('T-CHANGED-LEASE', {
      verifiedSha,
      expectedBaseRevision: mainAtStart,
      expectedRemoteTip: leasedTip,
    });
    const port = new SuccessionFakePort(new Map([[task.id, task]]), targetUrl);
    const merge = new MergeService({
      control: port,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async () => ({ exitCode: 0, output: 'ok' }),
      succession: { clock: () => new Date('2026-08-04T12:00:00.000Z') },
    });

    const result = await merge.mergeBatch('app', [task.id]);
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.reason).toMatch(/content-changing|tree-identical/i);
    expect(await originMainSha()).toBe(mainAtStart);
    expect(port.succession).toBeNull();
  });

  it('keeps the unavoidable post-push control failure on the uncertainty path', async () => {
    await setupOrigin('  test: "true"\n');
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5209, 4) });
    const tip = await plantBranch(ws, 'T-POST-PUSH', { 'post-push.txt': 'candidate\n' });
    const task = makeTask('T-POST-PUSH', { verifiedSha: tip });
    const port = new PostPushFailurePort(new Map([[task.id, task]]), targetUrl);
    const merge = new MergeService({
      control: port,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async () => ({ exitCode: 0, output: 'ok' }),
    });

    await expect(merge.mergeBatch('app', [task.id])).rejects.toThrow(/provenance stamp failed/);
    expect(await originMainSha()).not.toBe(mainAtStart);
    expect(port.tasks.get(task.id)).toEqual(task);
    expect(port.commits).toEqual([]);
  });

  it('conflicting branch → task back to review; origin main untouched', async () => {
    await setupOrigin('  test: "true"\n');
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5210, 4) });
    // Same shared line, different edits → second merge conflicts.
    const tipA = await plantBranch(ws, 'T-C1', { 'shared.txt': 'from-A\n' });
    const tipB = await plantBranch(ws, 'T-C2', { 'shared.txt': 'from-B\n' });

    const port = new FakePort(
      new Map([
        ['T-C1', makeTask('T-C1', { verifiedSha: tipA })],
        ['T-C2', makeTask('T-C2', { verifiedSha: tipB })],
      ]),
      targetUrl,
    );
    const merge = new MergeService({
      control: port,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async () => ({ exitCode: 0, output: 'ok' }),
    });

    const before = await originMainSha();
    const result = await merge.mergeBatch('app', ['T-C1', 'T-C2']);

    expect(result.ok).toBe(false);
    expect(result.mergedSha).toBeNull();
    expect(await originMainSha()).toBe(before);

    // Second task hit the conflict (first merged cleanly into temp only).
    const failed = result.failures.find((f) => f.taskId === 'T-C2');
    expect(failed).toBeDefined();
    expect(failed!.reason).toMatch(/merge/i);

    const t2 = port.tasks.get('T-C2')!;
    expect(t2.state).toBe('review');
    expect(t2.body).toMatch(/Merge failure/);
    expect(t2.mergedSha ?? null).toBeNull();

    // First task was not pushed — still done, unmerged (retryable).
    const t1 = port.tasks.get('T-C1')!;
    expect(t1.state).toBe('done');
    expect(t1.mergedSha ?? null).toBeNull();
  });

  it('verified-SHA mismatch refused → review; origin main untouched', async () => {
    await setupOrigin('  test: "true"\n');
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5220, 4) });
    const tip = await plantBranch(ws, 'T-V', { 'v.txt': 'ok\n' });
    const wrong = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    expect(tip.toLowerCase()).not.toBe(wrong);

    const port = new FakePort(
      new Map([['T-V', makeTask('T-V', { verifiedSha: wrong })]]),
      targetUrl,
    );
    const merge = new MergeService({
      control: port,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async () => ({ exitCode: 0, output: 'ok' }),
    });

    const before = await originMainSha();
    const result = await merge.mergeBatch('app', ['T-V']);

    expect(result.ok).toBe(false);
    expect(result.mergedSha).toBeNull();
    expect(await originMainSha()).toBe(before);
    expect(result.failures[0]?.reason).toMatch(/verified-SHA/i);

    const t = port.tasks.get('T-V')!;
    expect(t.state).toBe('review');
    expect(t.body).toMatch(/Merge failure/);
    expect(t.mergedSha ?? null).toBeNull();
  });

  it('gate failure on merged result → no push; tasks back to review', async () => {
    await setupOrigin('  test: "true"\n');
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5230, 4) });
    const tip = await plantBranch(ws, 'T-G', { 'g.txt': 'gates\n' });

    const port = new FakePort(
      new Map([['T-G', makeTask('T-G', { verifiedSha: tip })]]),
      targetUrl,
    );
    const receiptStore = new MergeFailureReceiptStore(root);
    const merge = new MergeService({
      control: port,
      workspaces: mergeWorkspacesFrom(ws),
      receiptStore,
      // Simulate post-merge L1 failure with secret material.
      commandRunner: async () => ({
        exitCode: 1,
        output:
          'TOKEN=fixture-merge-token-value\n' +
          'x'.repeat(5000) +
          '\nFAIL: unit test exploded\n',
      }),
    });

    const before = await originMainSha();
    const result = await merge.mergeBatch('app', ['T-G']);

    expect(result.ok).toBe(false);
    expect(result.mergedSha).toBeNull();
    expect(await originMainSha()).toBe(before);
    expect(result.operationStatus).toBe('merge_gate_failed');
    expect(result.failures[0]?.reason).toMatch(/L1 gates failed/i);

    const t = port.tasks.get('T-G')!;
    expect(t.state).toBe('review');
    expect(t.body).toMatch(/Merge failure/);
    expect(bodyHasMergeGateFailure(t.body)).toBe(true);
    expect(t.body).not.toMatch(/fixture-merge-token-value/);
    expect(t.mergedSha ?? null).toBeNull();
    expect(result.mergeGateReceipt?.exitStatus).toBe(1);
    expect(result.mergeGateReceipt?.remoteDefaultBranchChanged).toBe(false);
    expect((await receiptStore.loadByTaskId('T-G'))?.operationId).toBe(
      result.mergeGateReceipt?.operationId,
    );
    const fromBody = parseMergeFailureReceipt(t.body);
    expect(fromBody).not.toBeNull();
    expect(fromBody!.operationStatus).toBe('merge_gate_failed');
    expect(fromBody!.failedGate.length).toBeGreaterThan(0);
    expect(fromBody!.exitStatus).toBe(1);
    expect(fromBody!.verificationSucceeded).toBe(true);
    expect(fromBody!.failureSummary).toMatch(/FAIL|exploded/i);
    expect(fromBody!.failureSummary).not.toMatch(/fixture-merge-token-value/);
    expect(fromBody!.nextAction.length).toBeGreaterThan(10);

    // Feature file must NOT be on origin main.
    await expect(readFile(join(targetUrl, 'g.txt'), 'utf8')).rejects.toThrow();
  });
});

describe('ActionService.mergeRepo + API', { timeout: 60_000 }, () => {
  function makeActions(
    port: FakePort,
    ws: GitWorkspaces,
    commandRunner?: (command: string) => Promise<{ exitCode: number; output: string }>,
  ): ActionService {
    const probe: RepoProbe = {
      async probe() {
        return { branches: ['main'] };
      },
    };
    return new ActionService(port, probe, undefined, undefined, {
      workspaces: ws,
      verifier: {
        async verify() {
          throw new Error('not used');
        },
      },
      commandRunner: commandRunner ?? (async () => ({ exitCode: 0, output: 'ok' })),
    }, undefined, undefined, undefined, new MergeOperationService({
      store: new MergeOperationStore(root),
      mergeDeps: {
        control: port,
        workspaces: mergeWorkspacesFrom(ws),
        commandRunner: commandRunner ?? (async () => ({ exitCode: 0, output: 'ok' })),
      },
    }));
  }

  function makeApi(port: FakePort, actions: ActionService) {
    const view: RuntimeView = {
      snapshot: { repos: port.repos, tasks: [...port.tasks.values()], problems: [] },
      running: [],
      stopping: [],
      activity: {},
      pendingChat: {},
      liveRuns: {},
      lastReport: null,
      agents: { default: 'fake', available: ['fake'] },
    };
    return createApi({
      runtime: {
        getState: () => view,
        subscribe: () => () => {},
        forceAbort: () => {},
      },
      actions,
      token: 'secret',
    });
  }

  type MergeFailureReceipt = {
    status: string;
    phase: string;
    mergedSha: string | null;
    failureKind: string | null;
    failures: { taskId: string; reason: string; kind?: string }[];
  };

  async function waitForFailedPrecheck(
    app: ReturnType<typeof makeApi>,
    operationId: string,
  ): Promise<MergeFailureReceipt> {
    const deadline = Date.now() + 15_000;
    let receipt: MergeFailureReceipt | null = null;
    while (Date.now() < deadline) {
      const response = await app.request(`/api/merge-operations/${operationId}`, {
        headers: { authorization: 'Bearer secret' },
      });
      expect(response.status).toBe(200);
      receipt = (await response.json()) as MergeFailureReceipt;
      if (
        receipt.status === 'failed' ||
        receipt.status === 'succeeded' ||
        receipt.status === 'interrupted'
      ) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(receipt).not.toBeNull();
    expect(receipt).toMatchObject({
      status: 'failed',
      phase: 'failed',
      mergedSha: null,
      failureKind: 'precheck',
    });
    expect(receipt!.failures.length).toBeGreaterThan(0);
    for (const failure of receipt!.failures) {
      expect(failure.kind).toBe('precheck');
      // C3.55: precheck reasons stay readable (sanitized, bounded) so the
      // operator learns which rule refused.
      expect(failure.reason).toMatch(/^merge precheck failed: /);
      expect(failure.reason.length).toBeLessThanOrEqual(270);
      expect(failure.reason).not.toContain(root);
      expect(failure.reason).not.toContain(targetUrl);
      expect(failure.reason).not.toContain('secret');
    }
    return receipt!;
  }

  it('POST /api/repos/:key/merge requires auth and delegates', async () => {
    await setupOrigin('  test: "true"\n');
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5240, 4) });
    const tip = await plantBranch(ws, 'T-API', { 'api.txt': 'yes\n' });
    const port = new FakePort(
      new Map([['T-API', makeTask('T-API', { verifiedSha: tip })]]),
      targetUrl,
    );
    const actions = makeActions(port, ws);
    const app = makeApi(port, actions);

    const unauth = await app.request('/api/repos/app/merge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskIds: ['T-API'] }),
    });
    expect(unauth.status).toBe(401);

    const res = await app.request('/api/repos/app/merge', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ taskIds: ['T-API'], idempotencyKey: 'api-retry-1' }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      operationId: string;
      status: string;
      mergedSha: string | null;
      taskIds: string[];
    };
    expect([202, 200]).toContain(res.status);
    expect(body.operationId).toMatch(/^mop-/);
    expect(body.taskIds).toEqual(['T-API']);
    const retryRes = await app.request('/api/repos/app/merge', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ taskIds: ['T-API'], idempotencyKey: 'api-retry-1' }),
    });
    expect(retryRes.status).toBe(202);
    const retried = (await retryRes.json()) as typeof body;
    expect(retried.operationId).toBe(body.operationId);
    expect(retried.taskIds).toEqual(body.taskIds);
    const unauthStatus = await app.request(
      '/api/merge-operations/' + body.operationId,
    );
    expect(unauthStatus.status).toBe(401);
    let cur = body;
    const deadline = Date.now() + 30_000;
    while (
      cur.status !== 'succeeded' &&
      cur.status !== 'failed' &&
      cur.status !== 'interrupted' &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 50));
      const polled = await app.request(
        '/api/merge-operations/' + body.operationId,
        { headers: { authorization: 'Bearer secret' } },
      );
      cur = (await polled.json()) as typeof cur;
    }
    expect(cur.status).toBe('succeeded');
    expect(cur.mergedSha).toMatch(/^[0-9a-f]{40}$/i);
    expect(port.tasks.get('T-API')!.mergedSha).toBe(cur.mergedSha);
  });

  it('aborted API client retries the same key during held gates without duplicating work', async () => {
    await setupOrigin('  test: "true"\n');
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5239, 4) });
    const tip = await plantBranch(ws, 'T-ABORT', { 'abort.txt': 'still runs\n' });
    const port = new FakePort(
      new Map([['T-ABORT', makeTask('T-ABORT', { verifiedSha: tip })]]),
      targetUrl,
    );
    let releaseGate!: () => void;
    const heldGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let gateRuns = 0;
    const actions = makeActions(port, ws, async () => {
      gateRuns += 1;
      await heldGate;
      return { exitCode: 0, output: 'ignored command output' };
    });
    const app = makeApi(port, actions);
    const originalStart = actions.startMergeOperation.bind(actions);
    let acceptedOperationId: string | null = null;
    let releaseResponse!: () => void;
    const responseBoundary = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    let signalAccepted!: () => void;
    const accepted = new Promise<void>((resolve) => {
      signalAccepted = resolve;
    });
    vi.spyOn(actions, 'startMergeOperation').mockImplementationOnce(async (...args) => {
      const receipt = await originalStart(...args);
      acceptedOperationId = receipt.operationId;
      signalAccepted();
      // Explicit response-boundary fault seam: the operation record is durable
      // and background work is live, but the HTTP response cannot leave yet.
      await responseBoundary;
      return receipt;
    });
    const headers = {
      authorization: 'Bearer secret',
      'content-type': 'application/json',
    };
    const request = new AbortController();
    const disconnected = app.request('/api/repos/app/merge', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        taskIds: ['T-ABORT'],
        idempotencyKey: 'abort-retry-1',
      }),
      signal: request.signal,
    });
    await accepted;
    const gateDeadline = Date.now() + 15_000;
    while (gateRuns === 0 && Date.now() < gateDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(acceptedOperationId).toMatch(/^mop-/);
    expect(gateRuns).toBe(1);
    request.abort();
    releaseResponse();
    void Promise.resolve(disconnected).catch(() => undefined);

    const retry = await app.request('/api/repos/app/merge', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        taskIds: ['T-ABORT'],
        idempotencyKey: 'abort-retry-1',
      }),
    });
    expect(retry.status).toBe(202);
    const receipt = (await retry.json()) as {
      operationId: string;
      taskIds: string[];
      status: string;
    };
    expect(receipt.operationId).toBe(acceptedOperationId);
    expect(receipt.taskIds).toEqual(['T-ABORT']);

    const deadline = Date.now() + 15_000;
    expect(gateRuns).toBe(1);
    releaseGate();

    let status = receipt.status;
    while (status !== 'succeeded' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const polled = await app.request(
        `/api/merge-operations/${receipt.operationId}`,
        { headers: { authorization: 'Bearer secret' } },
      );
      status = ((await polled.json()) as { status: string }).status;
    }
    expect(status).toBe('succeeded');
    expect(gateRuns).toBe(1);
    const originLog = await simpleGit(targetUrl).log();
    expect(originLog.all.filter((entry) => entry.message.startsWith('hercules: merge T-ABORT'))).toHaveLength(1);
    expect(port.commits.filter((message) => message.includes('merge app [T-ABORT]'))).toHaveLength(1);
  });

  it('POST merge refuses missing verified_sha (direct API; never merges)', async () => {
    await setupOrigin('  test: "true"\n');
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5241, 4) });
    // Plant a real branch so only the missing verified_sha is the defect.
    await plantBranch(ws, 'T-NOV', { 'nov.txt': 'no verified\n' });
    const beforeTask = makeTask('T-NOV', { verifiedSha: null });
    const port = new FakePort(new Map([['T-NOV', beforeTask]]), targetUrl);
    const actions = makeActions(port, ws);
    const app = makeApi(port, actions);
    const before = await originMainSha();
    const commitsBefore = port.commits.length;

    const res = await app.request('/api/repos/app/merge', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ taskIds: ['T-NOV'] }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      operationId: string;
      mergedSha: string | null;
    };
    await waitForFailedPrecheck(app, body.operationId);
    expect(await originMainSha()).toBe(before);
    // Static ineligibility is non-mutating: state/provenance byte-identical.
    const t = port.tasks.get('T-NOV')!;
    expect(t).toEqual(beforeTask);
    expect(t.state).toBe('done');
    expect(t.mergedSha ?? null).toBeNull();
    expect(t.mergedVia ?? null).toBeNull();
    expect(port.commits.length).toBe(commitsBefore);
  });

  it('POST merge refuses pr_status=merged without stamping merged_via gate', async () => {
    await setupOrigin('  test: "true"\n');
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5242, 4) });
    const tip = await plantBranch(ws, 'T-PRM', { 'prm.txt': 'already on main via PR\n' });
    const beforeTask = makeTask('T-PRM', {
      verifiedSha: tip,
      prStatus: 'merged',
      prUrl: 'https://github.com/example/app/pull/9',
    });
    const port = new FakePort(new Map([['T-PRM', beforeTask]]), targetUrl);
    const actions = makeActions(port, ws);
    const app = makeApi(port, actions);
    const before = await originMainSha();
    const commitsBefore = port.commits.length;

    const res = await app.request('/api/repos/app/merge', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ taskIds: ['T-PRM'] }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { operationId: string };
    await waitForFailedPrecheck(app, body.operationId);
    expect(await originMainSha()).toBe(before);
    // External PR provenance and state remain byte-for-byte unchanged.
    const t = port.tasks.get('T-PRM')!;
    expect(t).toEqual(beforeTask);
    expect(t.state).toBe('done');
    expect(t.mergedSha ?? null).toBeNull();
    expect(t.mergedVia ?? null).toBeNull();
    expect(t.prStatus).toBe('merged');
    expect(t.prUrl).toBe('https://github.com/example/app/pull/9');
    expect(port.commits.length).toBe(commitsBefore);
  });

  it('POST merge refuses existing merged_sha without mutating provenance', async () => {
    await setupOrigin('  test: "true"\n');
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5247, 4) });
    const tip = await plantBranch(ws, 'T-ALREADY', { 'al.txt': 'already\n' });
    const priorMain = 'abcd'.repeat(10);
    const beforeTask = makeTask('T-ALREADY', {
      verifiedSha: tip,
      mergedSha: priorMain,
      mergedVia: 'operator',
      // No pr_status=merged — isolate the merged_sha static refusal path.
      prStatus: null,
      prUrl: null,
    });
    const port = new FakePort(new Map([['T-ALREADY', beforeTask]]), targetUrl);
    const actions = makeActions(port, ws);
    const app = makeApi(port, actions);
    const before = await originMainSha();
    const commitsBefore = port.commits.length;

    const res = await app.request('/api/repos/app/merge', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ taskIds: ['T-ALREADY'] }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { operationId: string };
    await waitForFailedPrecheck(app, body.operationId);
    expect(await originMainSha()).toBe(before);
    expect(port.tasks.get('T-ALREADY')).toEqual(beforeTask);
    expect(port.commits.length).toBe(commitsBefore);
  });

  it('merges the pinned accepted SHA, not a branch ref moved after the tip check', async () => {
    await setupOrigin('  test: "true"\n');
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5243, 4) });
    const tip = await plantBranch(ws, 'T-PIN', { 'good.txt': 'good\n' });
    const port = new FakePort(
      new Map([['T-PIN', makeTask('T-PIN', { verifiedSha: tip })]]),
      targetUrl,
    );

    const real = mergeWorkspacesFrom(ws);
    let acceptedTip: string | null = null;
    const workspaces: MergeWorkspaces = {
      preservedTipStatus: async (rk, tid, sha) => {
        const status = await real.preservedTipStatus(rk, tid, sha);
        acceptedTip = status.tip;
        // Race: after check, advance hercules/<task> on the mirror to different
        // content. preserve() disposes the live worktree, so re-create first.
        const w = await ws.create(repo, tid);
        const g = simpleGit(w.dir);
        await g.addConfig('user.email', 't@h.local');
        await g.addConfig('user.name', 'T');
        await writeFile(join(w.dir, 'evil.txt'), 'should not ship\n');
        await g.add('.');
        await g.commit('evil post-check move');
        await ws.preserve(tid, 'evil move');
        return status;
      },
      readWorkflow: (repoCfg) => real.readWorkflow(repoCfg),
      openMergeWorktree: (repoCfg) => real.openMergeWorktree(repoCfg),
    };

    const merge = new MergeService({
      control: port,
      workspaces,
      commandRunner: async () => ({ exitCode: 0, output: 'ok' }),
    });
    const result = await merge.mergeBatch('app', ['T-PIN']);
    expect(result.ok).toBe(true);
    expect(acceptedTip).toBe(tip);
    expect(await readFile(join(targetUrl, 'good.txt'), 'utf8')).toBe('good\n');
    // Moved content must not be on main — we merged the pinned SHA only.
    await expect(readFile(join(targetUrl, 'evil.txt'), 'utf8')).rejects.toThrow();
  });

  it('accepts tree-identical empty preserve commit; rejects content-changing extra', async () => {
    await setupOrigin('  test: "true"\n');
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5244, 4) });

    // Empty preserve on top of verified → mergeable.
    // plantBranch preserves+disposes; build the empty tip before dispose.
    const wOk = await ws.create(repo, 'T-EMPTY', { hadPriorWork: false });
    const gOk = simpleGit(wOk.dir);
    await gOk.addConfig('user.email', 't@h.local');
    await gOk.addConfig('user.name', 'T');
    await writeFile(join(wOk.dir, 'empty-ok.txt'), 'ok\n');
    await gOk.add('.');
    await gOk.commit('work T-EMPTY');
    const tipOk = (await gOk.revparse(['HEAD'])).trim();
    await gOk.raw([
      '-c',
      'user.email=t@h.local',
      '-c',
      'user.name=T',
      'commit',
      '--allow-empty',
      '-m',
      'empty preserve',
    ]);
    await ws.preserve('T-EMPTY', 'pin empty');

    const portOk = new FakePort(
      new Map([['T-EMPTY', makeTask('T-EMPTY', { verifiedSha: tipOk })]]),
      targetUrl,
    );
    const mergeOk = new MergeService({
      control: portOk,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async () => ({ exitCode: 0, output: 'ok' }),
    });
    const rOk = await mergeOk.mergeBatch('app', ['T-EMPTY']);
    expect(rOk.ok).toBe(true);
    expect(portOk.tasks.get('T-EMPTY')!.mergedVia).toBe('gate');

    // Content-changing commit after verified → refused (dynamic → review).
    const wBad = await ws.create(repo, 'T-DIRTY', { hadPriorWork: false });
    const gBad = simpleGit(wBad.dir);
    await gBad.addConfig('user.email', 't@h.local');
    await gBad.addConfig('user.name', 'T');
    await writeFile(join(wBad.dir, 'dirty.txt'), 'base\n');
    await gBad.add('.');
    await gBad.commit('work T-DIRTY');
    const tipBad = (await gBad.revparse(['HEAD'])).trim();
    await writeFile(join(wBad.dir, 'extra.txt'), 'content change\n');
    await gBad.add('.');
    await gBad.commit('arbitrary post-verify content');
    await ws.preserve('T-DIRTY', 'pin dirty');

    const portBad = new FakePort(
      new Map([['T-DIRTY', makeTask('T-DIRTY', { verifiedSha: tipBad })]]),
      targetUrl,
    );
    const before = await originMainSha();
    const mergeBad = new MergeService({
      control: portBad,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async () => ({ exitCode: 0, output: 'ok' }),
    });
    const rBad = await mergeBad.mergeBatch('app', ['T-DIRTY']);
    expect(rBad.ok).toBe(false);
    expect(rBad.failures[0]?.reason).toMatch(/verified-SHA|content-changing|tree-identical/i);
    expect(await originMainSha()).toBe(before);
    expect(portBad.tasks.get('T-DIRTY')!.mergedSha ?? null).toBeNull();
    // Dynamic tip mismatch may audit back to review.
    expect(portBad.tasks.get('T-DIRTY')!.state).toBe('review');
  });

  it('concurrent mergeRepo: second fails with typed ActionError; gates/push once', async () => {
    await setupOrigin('  test: "true"\n');
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5245, 4) });
    const tip = await plantBranch(ws, 'T-SF', { 'sf.txt': 'single-flight\n' });
    const port = new FakePort(
      new Map([['T-SF', makeTask('T-SF', { verifiedSha: tip })]]),
      targetUrl,
    );

    let releaseHold!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let gateRuns = 0;
    const actions = makeActions(port, ws, async () => {
      gateRuns += 1;
      await hold;
      return { exitCode: 0, output: 'ok' };
    });

    const first = actions.mergeRepo('app', ['T-SF']);
    // Wait until the first call is inside post-merge gates.
    const deadline = Date.now() + 15_000;
    while (gateRuns === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(gateRuns).toBe(1);

    let secondErr: unknown;
    try {
      await actions.mergeRepo('app', ['T-SF']);
    } catch (err) {
      secondErr = err;
    }
    expect(secondErr).toBeInstanceOf(ActionError);
    expect((secondErr as ActionError).message).toMatch(
      /merge already in flight for repo 'app'/,
    );

    // Still only one gate run while first is held.
    expect(gateRuns).toBe(1);
    releaseHold();
    const result = await first;
    expect(result.ok).toBe(true);
    expect(gateRuns).toBe(1);
    expect(port.tasks.get('T-SF')!.mergedSha).toBe(result.mergedSha);
  });

  it('MergeService concurrent mergeBatch throws MergeError without second push', async () => {
    await setupOrigin('  test: "true"\n');
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5246, 4) });
    const tip = await plantBranch(ws, 'T-SF2', { 'sf2.txt': 'lock\n' });
    const port = new FakePort(
      new Map([['T-SF2', makeTask('T-SF2', { verifiedSha: tip })]]),
      targetUrl,
    );
    let releaseHold!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let gateRuns = 0;
    const merge = new MergeService({
      control: port,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async () => {
        gateRuns += 1;
        await hold;
        return { exitCode: 0, output: 'ok' };
      },
    });
    const first = merge.mergeBatch('app', ['T-SF2']);
    const deadline = Date.now() + 15_000;
    while (gateRuns === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    let secondErr: unknown;
    try {
      await merge.mergeBatch('app', ['T-SF2']);
    } catch (err) {
      secondErr = err;
    }
    expect(secondErr).toBeInstanceOf(MergeError);
    expect((secondErr as MergeError).message).toMatch(
      /merge already in flight for repo 'app'/,
    );
    releaseHold();
    expect((await first).ok).toBe(true);
    expect(gateRuns).toBe(1);
  });

  it('rejects an accepted tip whose actual diff escapes affected_paths', async () => {
    await setupOrigin('  test: "true"\n');
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5260, 4) });
    const tip = await plantBranch(ws, 'T-SCOPE-BAD', { 'README.md': '# escaped\n' });
    const task = scopedTask('T-SCOPE-BAD', tip, mainAtStart, ['src/']);
    const port = new FakePort(new Map([[task.id, task]]), targetUrl);
    const merge = new MergeService({
      control: port,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async () => ({ exitCode: 0, output: 'ok' }),
    });
    const result = await merge.mergeBatch('app', [task.id]);
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.reason).toMatch(/outside affected_paths/);
    expect(await originMainSha()).toBe(mainAtStart);
  });

  it('escapes newline filenames in merge path-scope diagnostics', async () => {
    await setupOrigin('  test: "true"\n');
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5265, 4) });
    const hostilePath = 'evil\n## injected.md';
    const tip = await plantBranch(ws, 'T-SCOPE-CTRL', { [hostilePath]: 'escaped\n' });
    const task = scopedTask('T-SCOPE-CTRL', tip, mainAtStart, ['src/']);
    const port = new FakePort(new Map([[task.id, task]]), targetUrl);
    const result = await new MergeService({
      control: port,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async () => ({ exitCode: 0, output: 'ok' }),
    }).mergeBatch('app', [task.id]);

    expect(result.ok).toBe(false);
    const reason = result.failures[0]?.reason ?? '';
    expect(reason).toContain('"evil\\n## injected.md"');
    expect(reason).not.toContain('\n');
    expect(await originMainSha()).toBe(mainAtStart);
  });

  it('rejects overlapping main drift after planning', async () => {
    await setupOrigin('  test: "true"\n');
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5270, 4) });
    const tip = await plantBranch(ws, 'T-DRIFT-BAD', { 'src/a.ts': 'candidate\n' });
    const target = simpleGit(targetUrl);
    await mkdir(join(targetUrl, 'src'), { recursive: true });
    await writeFile(join(targetUrl, 'src/a.ts'), 'main drift\n');
    await target.add('.');
    await target.commit('overlapping main drift');
    const task = scopedTask('T-DRIFT-BAD', tip, mainAtStart, ['src/a.ts']);
    const port = new FakePort(new Map([[task.id, task]]), targetUrl);
    const result = await new MergeService({
      control: port,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async () => ({ exitCode: 0, output: 'ok' }),
    }).mergeBatch('app', [task.id]);
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.reason).toMatch(/current main changed leased paths/);
  });

  it('allows disjoint main drift when the accepted candidate was rebased onto it', async () => {
    await setupOrigin('  test: "true"\n');
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5280, 4) });
    const workspace = await ws.create(repo, 'T-REBASED', { hadPriorWork: false });
    const branchGit = simpleGit(workspace.dir);
    await branchGit.addConfig('user.email', 't@h.local');
    await branchGit.addConfig('user.name', 'T');
    await mkdir(join(workspace.dir, 'src'), { recursive: true });
    await writeFile(join(workspace.dir, 'src/a.ts'), 'candidate\n');
    await branchGit.add('.');
    await branchGit.commit('candidate before main drift');

    const target = simpleGit(targetUrl);
    await mkdir(join(targetUrl, 'docs'), { recursive: true });
    await writeFile(join(targetUrl, 'docs/main.md'), 'disjoint drift\n');
    await target.add('.');
    await target.commit('disjoint main drift');
    await branchGit.raw(['fetch', targetUrl, 'main']);
    await branchGit.raw(['rebase', 'FETCH_HEAD']);
    const tip = (await branchGit.revparse(['HEAD'])).trim();
    await ws.preserve('T-REBASED', 'preserve rebased');

    const task = scopedTask('T-REBASED', tip, mainAtStart, ['src/a.ts']);
    const port = new FakePort(new Map([[task.id, task]]), targetUrl);
    const result = await new MergeService({
      control: port,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async () => ({ exitCode: 0, output: 'ok' }),
    }).mergeBatch('app', [task.id]);
    expect(result.ok).toBe(true);
    expect(await readFile(join(targetUrl, 'src/a.ts'), 'utf8')).toBe('candidate\n');
    expect(await readFile(join(targetUrl, 'docs/main.md'), 'utf8')).toBe('disjoint drift\n');
  });

  it('rejects protected_paths drift during review', async () => {
    await setupOrigin('  test: "true"\n');
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5290, 4) });
    const tip = await plantBranch(ws, 'T-PROTECTED-DRIFT', { 'src/a.ts': 'candidate\n' });
    const target = simpleGit(targetUrl);
    await writeFile(
      join(targetUrl, 'WORKFLOW.md'),
      '---\nprotected_paths:\n  - secrets/**\ngates:\n  test: "true"\n---\nchanged\n',
    );
    await target.add('.');
    await target.commit('protected policy drift');
    const task = scopedTask('T-PROTECTED-DRIFT', tip, mainAtStart, ['src/a.ts'], []);
    const port = new FakePort(new Map([[task.id, task]]), targetUrl);
    const result = await new MergeService({
      control: port,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async () => ({ exitCode: 0, output: 'ok' }),
    }).mergeBatch('app', [task.id]);
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.reason).toMatch(/protected_paths changed/);
  });

  it('rejects path declaration mutation after verification', async () => {
    await setupOrigin('  test: "true"\n');
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5310, 4) });
    const tip = await plantBranch(ws, 'T-MUTATED', { 'src/a.ts': 'candidate\n' });
    const verified = scopedTask('T-MUTATED', tip, mainAtStart, ['src/a.ts']);
    const mutated = { ...verified, affectedPaths: ['src/'] };
    const port = new FakePort(new Map([[mutated.id, mutated]]), targetUrl);
    const before = await originMainSha();

    const result = await new MergeService({
      control: port,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async () => ({ exitCode: 0, output: 'ok' }),
    }).mergeBatch('app', [mutated.id]);

    expect(result.ok).toBe(false);
    expect(result.failures[0]?.reason).toMatch(/declaration changed after verification/);
    expect(await originMainSha()).toBe(before);
  });

  it('rejects overlapping declarations within one selected batch', async () => {
    await setupOrigin('  test: "true"\n');
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5320, 4) });
    const tipA = await plantBranch(ws, 'T-BATCH-A', { 'src/a.ts': 'a\n' });
    const tipB = await plantBranch(ws, 'T-BATCH-B', { 'src/b.ts': 'b\n' });
    const taskA = scopedTask('T-BATCH-A', tipA, mainAtStart, ['src/']);
    const taskB = scopedTask('T-BATCH-B', tipB, mainAtStart, ['src/b.ts']);
    const port = new FakePort(
      new Map([[taskA.id, taskA], [taskB.id, taskB]]),
      targetUrl,
    );
    const before = await originMainSha();

    const result = await new MergeService({
      control: port,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async () => ({ exitCode: 0, output: 'ok' }),
    }).mergeBatch('app', [taskA.id, taskB.id]);

    expect(result.ok).toBe(false);
    expect(result.failures.some((failure) => /overlap/i.test(failure.reason))).toBe(true);
    expect(await originMainSha()).toBe(before);
  });

  it('rejects a planned base outside current main ancestry', async () => {
    await setupOrigin('  test: "true"\n');
    const target = simpleGit(targetUrl);
    await target.checkoutLocalBranch('unrelated-plan');
    await writeFile(join(targetUrl, 'plan-only.txt'), 'not on main\n');
    await target.add('.');
    await target.commit('unrelated plan base');
    const unrelatedBase = (await target.revparse(['HEAD'])).trim();
    await target.checkout('main');

    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5330, 4) });
    const tip = await plantBranch(ws, 'T-NON-ANCESTOR', { 'src/a.ts': 'candidate\n' });
    const task = scopedTask('T-NON-ANCESTOR', tip, unrelatedBase, ['src/a.ts']);
    const port = new FakePort(new Map([[task.id, task]]), targetUrl);
    const before = await originMainSha();

    const result = await new MergeService({
      control: port,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async () => ({ exitCode: 0, output: 'ok' }),
    }).mergeBatch('app', [task.id]);

    expect(result.ok).toBe(false);
    expect(result.failures[0]?.reason).toMatch(/not an ancestor of current trusted main/);
    expect(await originMainSha()).toBe(before);
  });

  const CLOSURE_WORKFLOW = `project_state_closure:
  surfaces:
    status: PROJECT_STATUS.md
    backlog: docs/roadmap.md
  rules:
    - id: close-onboarding
      when:
        labels_any: [onboarding]
      surfaces: [status, backlog]
      forbid_patterns:
        - "onboarding incomplete"
      require_patterns:
        - "onboarding complete"
      required_update: Mark Status and Backlog as onboarding complete
`;

  it('blocks push when opt-in project-state is stale; passes after surfaces update', async () => {
    // Origin: WORKFLOW with closure contract + stale project-state surfaces.
    await mkdir(targetUrl, { recursive: true });
    const g = simpleGit(targetUrl);
    await g.init(['-b', 'main']);
    await g.addConfig('user.email', 't@h.local');
    await g.addConfig('user.name', 'T');
    await g.addConfig('receive.denyCurrentBranch', 'updateInstead');
    await writeFile(join(targetUrl, 'README.md'), '# target\n');
    await writeFile(
      join(targetUrl, 'WORKFLOW.md'),
      `---\ngates:\n  test: "true"\n${CLOSURE_WORKFLOW}---\nbe careful\n`,
    );
    await writeFile(join(targetUrl, 'PROJECT_STATUS.md'), 'onboarding incomplete\n');
    await mkdir(join(targetUrl, 'docs'), { recursive: true });
    await writeFile(join(targetUrl, 'docs/roadmap.md'), 'onboarding incomplete\n');
    await g.add('.');
    await g.commit('initial with stale project state');
    mainAtStart = (await g.revparse(['HEAD'])).trim();

    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5340, 4) });
    // Candidate only changes code — leaves project state stale.
    const tipStale = await plantBranch(ws, 'T-CLOSE-STALE', {
      'feature.txt': 'code change\n',
    });
    const portStale = new FakePort(
      new Map([
        [
          'T-CLOSE-STALE',
          makeTask('T-CLOSE-STALE', {
            verifiedSha: tipStale,
            labels: ['onboarding'],
          }),
        ],
      ]),
      targetUrl,
    );
    const before = await originMainSha();
    const mergeStale = new MergeService({
      control: portStale,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async () => ({ exitCode: 0, output: 'ok' }),
    });
    const rStale = await mergeStale.mergeBatch('app', ['T-CLOSE-STALE']);
    expect(rStale.ok).toBe(false);
    expect(rStale.failures[0]?.reason).toMatch(/project-state closure blocked before push/);
    expect(rStale.failures[0]?.reason).toMatch(/PROJECT_STATUS\.md|status/);
    expect(rStale.failures[0]?.reason).toMatch(/Mark Status and Backlog/);
    expect(rStale.failures[0]?.reason).not.toMatch(/\/home\//);
    expect(await originMainSha()).toBe(before);
    const failedTask = portStale.tasks.get('T-CLOSE-STALE')!;
    expect(failedTask.state).toBe('review');
    expect(failedTask.projectStateClosureStatus).toBe('failed');
    expect(failedTask.projectStateClosureDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(failedTask.body).toMatch(/Project-state closure/);
    expect(failedTask.body).toMatch(/hercules-project-state-closure:v1/);

    // Same merge path after updating declared surfaces on the candidate.
    const tipOk = await plantBranch(ws, 'T-CLOSE-OK', {
      'feature2.txt': 'code change\n',
      'PROJECT_STATUS.md': 'onboarding complete\n',
      'docs/roadmap.md': 'onboarding complete\n',
    });
    const portOk = new FakePort(
      new Map([
        [
          'T-CLOSE-OK',
          makeTask('T-CLOSE-OK', {
            verifiedSha: tipOk,
            labels: ['onboarding'],
          }),
        ],
      ]),
      targetUrl,
    );
    const mergeOk = new MergeService({
      control: portOk,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async () => ({ exitCode: 0, output: 'ok' }),
    });
    const rOk = await mergeOk.mergeBatch('app', ['T-CLOSE-OK']);
    expect(rOk.ok).toBe(true);
    expect(rOk.mergedSha).toMatch(/^[0-9a-f]{40}$/i);
    expect(await originMainSha()).toBe(rOk.mergedSha);
    const okTask = portOk.tasks.get('T-CLOSE-OK')!;
    expect(okTask.mergedVia).toBe('gate');
    expect(okTask.projectStateClosureStatus).toBe('passed');
    expect(okTask.projectStateClosureDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(join(targetUrl, 'PROJECT_STATUS.md'), 'utf8')).toContain(
      'onboarding complete',
    );
  });

  it('preserves ordinary merges when project_state_closure is absent', async () => {
    await setupOrigin('  test: "true"\n');
    // Stale-looking status file exists but is not declared — must not block.
    await writeFile(join(targetUrl, 'PROJECT_STATUS.md'), 'onboarding incomplete\n');
    await simpleGit(targetUrl).add('.');
    await simpleGit(targetUrl).commit('status noise without contract');
    mainAtStart = await originMainSha();

    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5345, 4) });
    const tip = await plantBranch(ws, 'T-NO-CONTRACT', { 'x.txt': 'ok\n' });
    const port = new FakePort(
      new Map([
        [
          'T-NO-CONTRACT',
          makeTask('T-NO-CONTRACT', {
            verifiedSha: tip,
            labels: ['onboarding'],
          }),
        ],
      ]),
      targetUrl,
    );
    const result = await new MergeService({
      control: port,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async () => ({ exitCode: 0, output: 'ok' }),
    }).mergeBatch('app', ['T-NO-CONTRACT']);
    expect(result.ok).toBe(true);
    expect(port.tasks.get('T-NO-CONTRACT')!.mergedSha).toBe(result.mergedSha);
    expect(port.tasks.get('T-NO-CONTRACT')!.projectStateClosureStatus ?? null).toBeNull();
  });

  it('skips closure rules for tasks outside applicability labels', async () => {
    await mkdir(targetUrl, { recursive: true });
    const g = simpleGit(targetUrl);
    await g.init(['-b', 'main']);
    await g.addConfig('user.email', 't@h.local');
    await g.addConfig('user.name', 'T');
    await g.addConfig('receive.denyCurrentBranch', 'updateInstead');
    await writeFile(join(targetUrl, 'README.md'), '# target\n');
    await writeFile(
      join(targetUrl, 'WORKFLOW.md'),
      `---\ngates:\n  test: "true"\n${CLOSURE_WORKFLOW}---\nbe careful\n`,
    );
    await writeFile(join(targetUrl, 'PROJECT_STATUS.md'), 'onboarding incomplete\n');
    await mkdir(join(targetUrl, 'docs'), { recursive: true });
    await writeFile(join(targetUrl, 'docs/roadmap.md'), 'onboarding incomplete\n');
    await g.add('.');
    await g.commit('contract with stale state');
    mainAtStart = (await g.revparse(['HEAD'])).trim();

    const ws = new GitWorkspaces({ root, ports: new PortAllocator(5350, 4) });
    const tip = await plantBranch(ws, 'T-OTHER', { 'y.txt': 'other\n' });
    // No onboarding label → rule not applicable.
    const port = new FakePort(
      new Map([
        ['T-OTHER', makeTask('T-OTHER', { verifiedSha: tip, labels: ['docs'] })],
      ]),
      targetUrl,
    );
    const result = await new MergeService({
      control: port,
      workspaces: mergeWorkspacesFrom(ws),
      commandRunner: async () => ({ exitCode: 0, output: 'ok' }),
    }).mergeBatch('app', ['T-OTHER']);
    expect(result.ok).toBe(true);
    expect(port.tasks.get('T-OTHER')!.projectStateClosureStatus).toBe('not_applicable');
  });
});
