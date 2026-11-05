import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import type { RepoConfig } from '../../src/domain/repos.js';
import {
  pushTaskBranchWithExactLease,
  readRemoteTaskBranchTip,
  TaskBranchLeaseError,
} from '../../src/isolation/exactLeasePush.js';
import { GitWorkspaces } from '../../src/isolation/worktree.js';
import { PortAllocator } from '../../src/isolation/ports.js';

describe('task branch exact lease (real git)', { timeout: 90_000 }, () => {
  let tmp: string;
  let origin: string;
  let seed: string;
  let mainTip: string;
  let repo: RepoConfig;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'hercules-exact-lease-'));
    seed = join(tmp, 'seed');
    await mkdir(seed, { recursive: true });
    const git = simpleGit(seed);
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 'test@hercules.local');
    await git.addConfig('user.name', 'Hercules Test');
    await writeFile(join(seed, 'README.md'), '# seed\n');
    await writeFile(join(seed, '.gitignore'), 'ignored.tmp\n');
    await git.add('.');
    await git.commit('seed');
    mainTip = (await git.revparse(['HEAD'])).trim();
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
      ports: new PortAllocator(4300, 30),
      push: true,
    });
  }

  async function competingCommit(branch: string, name: string): Promise<string> {
    const dir = join(tmp, `competitor-${name}`);
    await simpleGit(tmp).clone(origin, dir);
    const git = simpleGit(dir);
    await git.addConfig('user.email', 'other@hercules.local');
    await git.addConfig('user.name', 'Other Writer');
    await git.checkout(['-B', `writer-${name}`, 'origin/main']);
    await writeFile(join(dir, `${name}.txt`), `${name}\n`);
    await git.add('.');
    await git.commit(`other: ${name}`);
    const sha = (await git.revparse(['HEAD'])).trim();
    await git.push(['origin', `HEAD:refs/heads/${branch}`, '--force']);
    return sha;
  }

  async function advanceMain(path: string, content: string): Promise<string> {
    const git = simpleGit(seed);
    await writeFile(join(seed, path), content);
    await git.add('.');
    await git.commit(`main: ${path}`);
    const sha = (await git.revparse(['HEAD'])).trim();
    await git.push([origin, 'HEAD:refs/heads/main']);
    return sha;
  }

  it('rebases and CAS-publishes a conflict-free stale exact candidate onto the trusted tip', async () => {
    const branch = 'hercules/STALE-CLEAN';
    const candidate = await competingCommit(branch, 'stale-clean');
    const trustedTip = await advanceMain('dependency.txt', 'gate merged\n');
    const manager = workspaces();

    const result = await manager.recoverStaleTaskBranch(repo, 'STALE-CLEAN', trustedTip, {
      expectedBaseRevision: mainTip,
      expectedRemoteTip: candidate,
    });

    expect(result.kind).toBe('recovered');
    if (result.kind !== 'recovered') throw new Error(result.detail);
    expect(result.lease.expectedBaseRevision).toBe(trustedTip);
    expect(result.lease.expectedRemoteTip).not.toBe(candidate);
    const remote = await readRemoteTaskBranchTip(simpleGit(origin), origin, branch);
    expect(remote).toBe(result.lease.expectedRemoteTip);
    await expect(
      simpleGit(origin).raw(['merge-base', '--is-ancestor', trustedTip, remote!]),
    ).resolves.toBeDefined();
    expect((await simpleGit(origin).revparse(['refs/heads/main'])).trim()).toBe(trustedTip);
  });

  it('local-ref CAS race publishes nothing and preserves old and rebased recovery tips', async () => {
    const taskId = 'STALE-LOCAL-CAS';
    const branch = `hercules/${taskId}`;
    const candidate = await competingCommit(branch, 'stale-local-cas');
    const trustedTip = await advanceMain('dependency-local-cas.txt', 'gate merged\n');
    const root = join(tmp, 'work');
    const manager = new GitWorkspaces({
      root,
      ports: new PortAllocator(4300, 30),
      push: true,
      beforeStaleRecoveryLocalCas: async (hookBranch) => {
        expect(hookBranch).toBe(branch);
        await simpleGit(join(root, '.mirrors', 'app.git')).raw([
          'update-ref', `refs/heads/${branch}`, trustedTip, candidate,
        ]);
      },
    });

    const result = await manager.recoverStaleTaskBranch(repo, taskId, trustedTip, {
      expectedBaseRevision: mainTip,
      expectedRemoteTip: candidate,
    });

    expect(result).toMatchObject({ kind: 'held', code: 'concurrent_move' });
    expect(await readRemoteTaskBranchTip(simpleGit(origin), origin, branch)).toBe(candidate);
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    expect((await mirror.revparse([`refs/heads/${branch}`])).trim()).toBe(trustedTip);
    expect((await mirror.revparse([
      `refs/hercules-recovery/${taskId}-${candidate.slice(0, 12)}`,
    ])).trim()).toBe(candidate);
    const rebasedRefs = (await mirror.raw([
      'for-each-ref', '--format=%(refname) %(objectname)', 'refs/hercules-recovery',
    ])).trim().split('\n').filter((line) => line.includes(`/${taskId}-rebased-`));
    expect(rebasedRefs).toHaveLength(1);
    expect(rebasedRefs[0]).not.toContain(candidate);
  });

  it('exact compensation restores both task refs and retains old and rebased recovery refs', async () => {
    const taskId = 'STALE-RECEIPT-ROLLBACK';
    const branch = `hercules/${taskId}`;
    const candidate = await competingCommit(branch, 'stale-receipt-rollback');
    const trustedTip = await advanceMain('dependency-receipt.txt', 'gate merged\n');
    const root = join(tmp, 'work');
    const manager = workspaces(root);
    const recovered = await manager.recoverStaleTaskBranch(repo, taskId, trustedTip, {
      expectedBaseRevision: mainTip,
      expectedRemoteTip: candidate,
    });
    expect(recovered.kind).toBe('recovered');
    if (recovered.kind !== 'recovered') throw new Error(recovered.detail);
    const rebasedTip = recovered.lease.expectedRemoteTip!;

    const rollback = await manager.rollbackStaleTaskBranchRecovery(
      repo,
      taskId,
      { expectedBaseRevision: mainTip, expectedRemoteTip: candidate },
      recovered.lease,
    );

    expect(rollback.kind).toBe('rolled_back');
    expect(await readRemoteTaskBranchTip(simpleGit(origin), origin, branch)).toBe(candidate);
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    expect((await mirror.revparse([`refs/heads/${branch}`])).trim()).toBe(candidate);
    expect((await mirror.revparse([
      `refs/hercules-recovery/${taskId}-${candidate.slice(0, 12)}`,
    ])).trim()).toBe(candidate);
    expect((await mirror.revparse([
      `refs/hercules-recovery/${taskId}-rebased-${rebasedTip.slice(0, 12)}`,
    ])).trim()).toBe(rebasedTip);
  });

  it('compensation CAS never overwrites a concurrent remote writer and retains both recovery tips', async () => {
    const taskId = 'STALE-ROLLBACK-RACE';
    const branch = `hercules/${taskId}`;
    const candidate = await competingCommit(branch, 'stale-rollback-race');
    const trustedTip = await advanceMain('dependency-rollback-race.txt', 'gate merged\n');
    const root = join(tmp, 'work');
    let winner: string | null = null;
    const manager = new GitWorkspaces({
      root,
      ports: new PortAllocator(4300, 30),
      push: true,
      beforeStaleRecoveryRollbackPush: async (hookBranch) => {
        expect(hookBranch).toBe(branch);
        winner = await competingCommit(branch, 'rollback-winner');
      },
    });
    const recovered = await manager.recoverStaleTaskBranch(repo, taskId, trustedTip, {
      expectedBaseRevision: mainTip,
      expectedRemoteTip: candidate,
    });
    expect(recovered.kind).toBe('recovered');
    if (recovered.kind !== 'recovered') throw new Error(recovered.detail);
    const rebasedTip = recovered.lease.expectedRemoteTip!;

    const rollback = await manager.rollbackStaleTaskBranchRecovery(
      repo,
      taskId,
      { expectedBaseRevision: mainTip, expectedRemoteTip: candidate },
      recovered.lease,
    );

    expect(rollback).toMatchObject({ kind: 'held', code: 'concurrent_move' });
    expect(winner).toMatch(/^[0-9a-f]{40}$/);
    expect(await readRemoteTaskBranchTip(simpleGit(origin), origin, branch)).toBe(winner);
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    expect((await mirror.revparse([`refs/heads/${branch}`])).trim()).toBe(rebasedTip);
    expect((await mirror.revparse([
      `refs/hercules-recovery/${taskId}-${candidate.slice(0, 12)}`,
    ])).trim()).toBe(candidate);
    expect((await mirror.revparse([
      `refs/hercules-recovery/${taskId}-rebased-${rebasedTip.slice(0, 12)}`,
    ])).trim()).toBe(rebasedTip);
  });

  it('parks a conflicting stale candidate and keeps its exact remote tip reachable', async () => {
    const branch = 'hercules/STALE-CONFLICT';
    const writerDir = join(tmp, 'conflict-writer');
    await simpleGit(tmp).clone(origin, writerDir);
    const writer = simpleGit(writerDir);
    await writer.addConfig('user.email', 'other@hercules.local');
    await writer.addConfig('user.name', 'Other Writer');
    await writer.checkout(['-B', 'conflict-task', 'origin/main']);
    await writeFile(join(writerDir, 'README.md'), '# task version\n');
    await writer.add('.');
    await writer.commit('task conflict');
    const candidate = (await writer.revparse(['HEAD'])).trim();
    await writer.push(['origin', `HEAD:refs/heads/${branch}`]);
    const trustedTip = await advanceMain('README.md', '# dependency version\n');
    const manager = workspaces();

    const result = await manager.recoverStaleTaskBranch(repo, 'STALE-CONFLICT', trustedTip, {
      expectedBaseRevision: mainTip,
      expectedRemoteTip: candidate,
    });

    expect(result).toMatchObject({ kind: 'held', code: 'conflict' });
    expect(await readRemoteTaskBranchTip(simpleGit(origin), origin, branch)).toBe(candidate);
    const mirror = simpleGit(join(tmp, 'work', '.mirrors', 'app.git'));
    await expect(
      mirror.raw(['cat-file', '-e', `refs/hercules-recovery/STALE-CONFLICT-${candidate.slice(0, 12)}^{commit}`]),
    ).resolves.toBeDefined();
  });

  it('refuses dirty and concurrently moved candidates without rewriting the remote ref', async () => {
    const dirtyBranch = 'hercules/STALE-DIRTY';
    const dirtyCandidate = await competingCommit(dirtyBranch, 'stale-dirty');
    const manager = workspaces();
    const workspace = await manager.create(repo, 'STALE-DIRTY', {
      hadPriorWork: false,
      expectedBaseTip: mainTip,
      expectedBaseRevision: mainTip,
      expectedRemoteTip: dirtyCandidate,
    });
    await writeFile(join(workspace.dir, 'dirty.txt'), 'uncommitted\n');
    const trustedTip = await advanceMain('dependency-two.txt', 'gate merged again\n');

    const dirty = await manager.recoverStaleTaskBranch(repo, 'STALE-DIRTY', trustedTip, {
      expectedBaseRevision: mainTip,
      expectedRemoteTip: dirtyCandidate,
    });
    expect(dirty).toMatchObject({ kind: 'held', code: 'dirty_worktree' });
    expect(await readRemoteTaskBranchTip(simpleGit(origin), origin, dirtyBranch)).toBe(dirtyCandidate);
    expect(await readFile(join(workspace.dir, 'dirty.txt'), 'utf8')).toBe('uncommitted\n');

    const movedBranch = 'hercules/STALE-MOVED';
    const expected = await competingCommit(movedBranch, 'stale-moved-expected');
    const winner = await competingCommit(movedBranch, 'stale-moved-winner');
    const moved = await manager.recoverStaleTaskBranch(repo, 'STALE-MOVED', trustedTip, {
      expectedBaseRevision: mainTip,
      expectedRemoteTip: expected,
    });
    expect(moved).toMatchObject({ kind: 'held', code: 'concurrent_move' });
    expect(await readRemoteTaskBranchTip(simpleGit(origin), origin, movedBranch)).toBe(winner);
  });

  it('creates, survives restart/retry, advances on match, and rejects deletion', async () => {
    const firstManager = workspaces();
    const first = await firstManager.create(repo, 'LEASE-1', { hadPriorWork: false });
    expect(first.branchLease).toEqual({
      expectedBaseRevision: mainTip,
      expectedRemoteTip: null,
    });
    await writeFile(join(first.dir, 'first.txt'), 'first\n');
    const firstPreserve = await firstManager.preserve('LEASE-1', 'hercules: LEASE-1 first');
    expect(firstPreserve.notPropagated).toBe(false);
    const firstTip = firstPreserve.branchLease?.expectedRemoteTip;
    expect(firstTip).toMatch(/^[0-9a-f]{40}$/);

    const restarted = workspaces();
    const resumed = await restarted.create(repo, 'LEASE-1', {
      hadPriorWork: true,
      expectedBaseRevision: firstPreserve.branchLease!.expectedBaseRevision,
      expectedRemoteTip: firstTip!,
    });
    expect(resumed.branchLease.expectedRemoteTip).toBe(firstTip);
    await writeFile(join(resumed.dir, 'retry.txt'), 'retry\n');
    const secondPreserve = await restarted.preserve(
      'LEASE-1',
      'hercules: LEASE-1 retry',
    );
    const secondTip = secondPreserve.branchLease?.expectedRemoteTip;
    expect(secondTip).toMatch(/^[0-9a-f]{40}$/);
    expect(secondTip).not.toBe(firstTip);

    await simpleGit(origin).raw(['update-ref', '-d', 'refs/heads/hercules/LEASE-1']);
    await expect(
      workspaces().create(repo, 'LEASE-1', {
        hadPriorWork: true,
        expectedBaseRevision: mainTip,
        expectedRemoteTip: secondTip!,
      }),
    ).rejects.toThrow(/exact lease changed before dispatch/i);
  });

  it('rejects a concurrent writer without changing its remote tip', async () => {
    const manager = workspaces();
    const first = await manager.create(repo, 'LEASE-RACE', { hadPriorWork: false });
    await writeFile(join(first.dir, 'owned.txt'), 'owned\n');
    const initial = await manager.preserve('LEASE-RACE', 'hercules: LEASE-RACE initial');

    const retry = await manager.create(repo, 'LEASE-RACE', {
      hadPriorWork: true,
      expectedBaseRevision: initial.branchLease!.expectedBaseRevision,
      expectedRemoteTip: initial.branchLease!.expectedRemoteTip,
    });
    await writeFile(join(retry.dir, 'local.txt'), 'local\n');
    const competitor = await competingCommit('hercules/LEASE-RACE', 'race');
    const result = await manager.preserve('LEASE-RACE', 'hercules: LEASE-RACE local');
    expect(result.notPropagated).toBe(true);
    expect(await readRemoteTaskBranchTip(simpleGit(origin), origin, 'hercules/LEASE-RACE')).toBe(
      competitor,
    );
  });

  it('revalidates a live workspace lease before same-process redispatch', async () => {
    const manager = workspaces();
    const live = await manager.create(repo, 'LEASE-LIVE', { hadPriorWork: false });
    expect(live.branchLease.expectedRemoteTip).toBeNull();
    const competitor = await competingCommit('hercules/LEASE-LIVE', 'live-race');

    await expect(
      manager.create(repo, 'LEASE-LIVE', { hadPriorWork: false }),
    ).rejects.toThrow(/live task branch exact lease changed before dispatch/i);
    expect(await readRemoteTaskBranchTip(simpleGit(origin), origin, 'hercules/LEASE-LIVE')).toBe(
      competitor,
    );
  });

  it('adopts an exact persisted candidate instead of reattaching a fresh managed worktree at base', async () => {
    const manager = workspaces();
    const stale = await manager.create(repo, 'ADOPT-MANAGED', {
      hadPriorWork: false,
      expectedBaseTip: mainTip,
    });
    expect((await simpleGit(stale.dir).revparse(['HEAD'])).trim()).toBe(mainTip);

    const candidate = await competingCommit('hercules/ADOPT-MANAGED', 'managed-candidate');
    (manager as unknown as { live: Map<string, unknown> }).live.clear();

    const adopted = await workspaces().create(repo, 'ADOPT-MANAGED', {
      hadPriorWork: false,
      expectedBaseTip: mainTip,
      expectedBaseRevision: mainTip,
      expectedRemoteTip: candidate,
    });

    expect((await simpleGit(adopted.dir).revparse(['HEAD'])).trim()).toBe(candidate);
    expect(await readFile(join(adopted.dir, 'managed-candidate.txt'), 'utf8')).toBe(
      'managed-candidate\n',
    );
    expect(adopted.branchLease).toEqual({
      expectedBaseRevision: mainTip,
      expectedRemoteTip: candidate,
    });
  });

  it('fast-forwards a clean recovered ancestor to the exact candidate in place', async () => {
    const manager = workspaces();
    const recovered = await manager.create(repo, 'ADOPT-ANCESTOR', {
      hadPriorWork: false,
      expectedBaseTip: mainTip,
    });
    const recoveredGit = simpleGit(recovered.dir);
    await recoveredGit.addConfig('user.email', 'local@hercules.test');
    await recoveredGit.addConfig('user.name', 'Local Recovery');
    await writeFile(join(recovered.dir, 'ancestor.txt'), 'ancestor work\n');
    await recoveredGit.add('.');
    await recoveredGit.commit('local ancestor');
    const ancestor = (await recoveredGit.revparse(['HEAD'])).trim();
    // Provider worktrees deny ordinary push — seed the remote tip via exact-CAS
    // from the shared bare mirror (objects already present via the linked tree).
    const mirror = join(tmp, 'work', '.mirrors', 'app.git');
    await pushTaskBranchWithExactLease({
      git: simpleGit(mirror),
      originUrl: origin,
      branch: 'hercules/ADOPT-ANCESTOR',
      localTip: ancestor.toLowerCase(),
      lease: { expectedBaseRevision: mainTip, expectedRemoteTip: null },
      allowOwnedReset: false,
    });

    const writerDir = join(tmp, 'ancestor-writer');
    await simpleGit(tmp).clone(origin, writerDir);
    const writer = simpleGit(writerDir);
    await writer.addConfig('user.email', 'other@hercules.local');
    await writer.addConfig('user.name', 'Other Writer');
    await writer.checkout(['-B', 'writer-ancestor', 'origin/hercules/ADOPT-ANCESTOR']);
    await writeFile(join(writerDir, 'descendant.txt'), 'descendant work\n');
    await writer.add('.');
    await writer.commit('remote descendant');
    const candidate = (await writer.revparse(['HEAD'])).trim();
    await writer.push(['origin', 'HEAD:refs/heads/hercules/ADOPT-ANCESTOR']);
    (manager as unknown as { live: Map<string, unknown> }).live.clear();

    const adopted = await workspaces().create(repo, 'ADOPT-ANCESTOR', {
      hadPriorWork: false,
      expectedBaseTip: mainTip,
      expectedBaseRevision: mainTip,
      expectedRemoteTip: candidate,
    });

    expect(adopted.dir).toBe(recovered.dir);
    expect((await simpleGit(adopted.dir).revparse(['HEAD'])).trim()).toBe(candidate);
    expect((await simpleGit(adopted.dir).revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe(
      'hercules/ADOPT-ANCESTOR',
    );
    expect(ancestor).not.toBe(candidate);
    expect(await readFile(join(adopted.dir, 'ancestor.txt'), 'utf8')).toBe('ancestor work\n');
    expect(await readFile(join(adopted.dir, 'descendant.txt'), 'utf8')).toBe(
      'descendant work\n',
    );
  });

  it('reattaches an exact candidate worktree without discarding dirty crash state', async () => {
    const manager = workspaces();
    const candidate = await competingCommit('hercules/ADOPT-DIRTY-EXACT', 'dirty-exact');
    const first = await manager.create(repo, 'ADOPT-DIRTY-EXACT', {
      hadPriorWork: false,
      expectedBaseTip: mainTip,
      expectedBaseRevision: mainTip,
      expectedRemoteTip: candidate,
    });
    await writeFile(join(first.dir, 'partial.txt'), 'uncommitted recovery state\n');
    (manager as unknown as { live: Map<string, unknown> }).live.clear();

    const reattached = await workspaces().create(repo, 'ADOPT-DIRTY-EXACT', {
      hadPriorWork: false,
      expectedBaseTip: mainTip,
      expectedBaseRevision: mainTip,
      expectedRemoteTip: candidate,
    });

    expect(reattached.dir).toBe(first.dir);
    expect((await simpleGit(reattached.dir).revparse(['HEAD'])).trim()).toBe(candidate);
    expect(await readFile(join(reattached.dir, 'partial.txt'), 'utf8')).toBe(
      'uncommitted recovery state\n',
    );
    expect((await simpleGit(reattached.dir).status()).files.map((file) => file.path)).toContain(
      'partial.txt',
    );
  });

  it('fails closed without partially detaching a coexisting branch pin', async () => {
    const manager = workspaces();
    const candidate = await competingCommit('hercules/ADOPT-COEXIST', 'coexist-candidate');
    const target = await manager.create(repo, 'ADOPT-COEXIST', {
      hadPriorWork: false,
      expectedBaseTip: mainTip,
      expectedBaseRevision: mainTip,
      expectedRemoteTip: candidate,
    });
    const targetGit = simpleGit(target.dir);
    await targetGit.raw(['checkout', '--detach']);
    await writeFile(join(target.dir, 'partial.txt'), 'target dirty state\n');
    const mirror = simpleGit(join(tmp, 'work', '.mirrors', 'app.git'));
    const outside = join(tmp, 'outside-coexisting-pin');
    await mirror.raw(['worktree', 'add', outside, 'hercules/ADOPT-COEXIST']);
    (manager as unknown as { live: Map<string, unknown> }).live.clear();

    await expect(
      workspaces().create(repo, 'ADOPT-COEXIST', {
        hadPriorWork: false,
        expectedBaseTip: mainTip,
        expectedBaseRevision: mainTip,
        expectedRemoteTip: candidate,
      }),
    ).rejects.toThrow(/coexisting task-branch pin/i);

    expect((await simpleGit(target.dir).revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe(
      'HEAD',
    );
    expect(await readFile(join(target.dir, 'partial.txt'), 'utf8')).toBe(
      'target dirty state\n',
    );
    expect((await simpleGit(outside).revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe(
      'hercules/ADOPT-COEXIST',
    );
  });

  it('fails closed without detaching or deleting dirty worktree state at a different HEAD', async () => {
    const manager = workspaces();
    const stale = await manager.create(repo, 'ADOPT-DIRTY-MISMATCH', {
      hadPriorWork: false,
      expectedBaseTip: mainTip,
    });
    await writeFile(join(stale.dir, 'partial.txt'), 'must survive mismatch\n');
    const candidate = await competingCommit(
      'hercules/ADOPT-DIRTY-MISMATCH',
      'dirty-mismatch-candidate',
    );
    (manager as unknown as { live: Map<string, unknown> }).live.clear();

    await expect(
      workspaces().create(repo, 'ADOPT-DIRTY-MISMATCH', {
        hadPriorWork: false,
        expectedBaseTip: mainTip,
        expectedBaseRevision: mainTip,
        expectedRemoteTip: candidate,
      }),
    ).rejects.toThrow(/dirty recovered worktree/i);

    expect((await simpleGit(stale.dir).revparse(['HEAD'])).trim()).toBe(mainTip);
    expect((await simpleGit(stale.dir).revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe(
      'hercules/ADOPT-DIRTY-MISMATCH',
    );
    expect(await readFile(join(stale.dir, 'partial.txt'), 'utf8')).toBe(
      'must survive mismatch\n',
    );
  });

  it('preserves a concurrent untracked write while failing the exact in-place update', async () => {
    const manager = workspaces();
    const stale = await manager.create(repo, 'ADOPT-TOCTOU', {
      hadPriorWork: false,
      expectedBaseTip: mainTip,
    });
    const candidate = await competingCommit('hercules/ADOPT-TOCTOU', 'toctou-candidate');
    (manager as unknown as { live: Map<string, unknown> }).live.clear();
    const racing = new GitWorkspaces({
      root: join(tmp, 'work'),
      ports: new PortAllocator(4300, 30),
      push: true,
      beforeExactCandidateInPlaceUpdate: async (branch) => {
        expect(branch).toBe('hercules/ADOPT-TOCTOU');
        await writeFile(join(stale.dir, 'late.txt'), 'arrived after inspection\n');
      },
    });

    await expect(
      racing.create(repo, 'ADOPT-TOCTOU', {
        hadPriorWork: false,
        expectedBaseTip: mainTip,
        expectedBaseRevision: mainTip,
        expectedRemoteTip: candidate,
      }),
    ).rejects.toThrow(/changed concurrently/i);

    expect(await readFile(join(stale.dir, 'late.txt'), 'utf8')).toBe(
      'arrived after inspection\n',
    );
    expect((await simpleGit(stale.dir).revparse(['HEAD'])).trim()).toBe(candidate);
  });

  it('treats ignored files as dirty recovery state and never force-removes them', async () => {
    const manager = workspaces();
    const stale = await manager.create(repo, 'ADOPT-IGNORED', {
      hadPriorWork: false,
      expectedBaseTip: mainTip,
    });
    await writeFile(join(stale.dir, 'ignored.tmp'), 'ignored but valuable\n');
    expect((await simpleGit(stale.dir).status()).isClean()).toBe(true);
    const candidate = await competingCommit('hercules/ADOPT-IGNORED', 'ignored-candidate');
    (manager as unknown as { live: Map<string, unknown> }).live.clear();

    await expect(
      workspaces().create(repo, 'ADOPT-IGNORED', {
        hadPriorWork: false,
        expectedBaseTip: mainTip,
        expectedBaseRevision: mainTip,
        expectedRemoteTip: candidate,
      }),
    ).rejects.toThrow(/dirty recovered worktree/i);

    expect(await readFile(join(stale.dir, 'ignored.tmp'), 'utf8')).toBe('ignored but valuable\n');
    expect((await simpleGit(stale.dir).revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe(
      'hercules/ADOPT-IGNORED',
    );
  });

  it('fails closed on a clean recovered HEAD with a unique local commit', async () => {
    const manager = workspaces();
    const stale = await manager.create(repo, 'ADOPT-UNIQUE', {
      hadPriorWork: false,
      expectedBaseTip: mainTip,
    });
    const staleGit = simpleGit(stale.dir);
    await staleGit.addConfig('user.email', 'local@hercules.test');
    await staleGit.addConfig('user.name', 'Local Recovery');
    await writeFile(join(stale.dir, 'unique.txt'), 'unique committed work\n');
    await staleGit.add('.');
    await staleGit.commit('local unique recovery commit');
    const uniqueHead = (await staleGit.revparse(['HEAD'])).trim();
    expect((await staleGit.status()).isClean()).toBe(true);
    const candidate = await competingCommit('hercules/ADOPT-UNIQUE', 'unique-candidate');
    (manager as unknown as { live: Map<string, unknown> }).live.clear();

    await expect(
      workspaces().create(repo, 'ADOPT-UNIQUE', {
        hadPriorWork: false,
        expectedBaseTip: mainTip,
        expectedBaseRevision: mainTip,
        expectedRemoteTip: candidate,
      }),
    ).rejects.toThrow(/unique recovered HEAD/i);

    expect((await simpleGit(stale.dir).revparse(['HEAD'])).trim()).toBe(uniqueHead);
    expect(await readFile(join(stale.dir, 'unique.txt'), 'utf8')).toBe(
      'unique committed work\n',
    );
  });

  it('does not overwrite a unique named ref when reattaching a detached worktree', async () => {
    const manager = workspaces();
    const stale = await manager.create(repo, 'ADOPT-NAMED-UNIQUE', {
      hadPriorWork: false,
      expectedBaseTip: mainTip,
    });
    await simpleGit(stale.dir).raw(['checkout', '--detach']);
    const candidate = await competingCommit(
      'hercules/ADOPT-NAMED-UNIQUE',
      'named-candidate',
    );
    const sourceBranch = 'hercules/NAMED-UNIQUE-SOURCE';
    const uniqueTip = await competingCommit(sourceBranch, 'named-unique');
    const mirror = simpleGit(join(tmp, 'work', '.mirrors', 'app.git'));
    await mirror.raw([
      'fetch',
      '--no-tags',
      origin,
      `refs/heads/${sourceBranch}:refs/hercules-test/named-unique`,
    ]);
    await mirror.raw([
      'update-ref',
      'refs/heads/hercules/ADOPT-NAMED-UNIQUE',
      uniqueTip,
    ]);
    (manager as unknown as { live: Map<string, unknown> }).live.clear();

    await expect(
      workspaces().create(repo, 'ADOPT-NAMED-UNIQUE', {
        hadPriorWork: false,
        expectedBaseTip: mainTip,
        expectedBaseRevision: mainTip,
        expectedRemoteTip: candidate,
      }),
    ).rejects.toThrow(/unique named branch tip/i);

    expect((await simpleGit(stale.dir).revparse(['HEAD'])).trim()).toBe(mainTip);
    expect((await simpleGit(stale.dir).revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe(
      'HEAD',
    );
    expect(
      (await mirror.revparse(['refs/heads/hercules/ADOPT-NAMED-UNIQUE'])).trim(),
    ).toBe(uniqueTip);
  });

  it('preserves a concurrent named-ref advance before detached worktree attach', async () => {
    const manager = workspaces();
    const stale = await manager.create(repo, 'ADOPT-ATTACH-RACE', {
      hadPriorWork: false,
      expectedBaseTip: mainTip,
    });
    await simpleGit(stale.dir).raw(['checkout', '--detach']);
    const candidate = await competingCommit(
      'hercules/ADOPT-ATTACH-RACE',
      'attach-race-candidate',
    );
    (manager as unknown as { live: Map<string, unknown> }).live.clear();
    const mirror = simpleGit(join(tmp, 'work', '.mirrors', 'app.git'));
    const racing = new GitWorkspaces({
      root: join(tmp, 'work'),
      ports: new PortAllocator(4300, 30),
      push: true,
      beforeExactCandidateBranchAttach: async (branch) => {
        expect(branch).toBe('hercules/ADOPT-ATTACH-RACE');
        await mirror.raw(['update-ref', `refs/heads/${branch}`, candidate, mainTip]);
      },
    });

    await expect(
      racing.create(repo, 'ADOPT-ATTACH-RACE', {
        hadPriorWork: false,
        expectedBaseTip: mainTip,
        expectedBaseRevision: mainTip,
        expectedRemoteTip: candidate,
      }),
    ).rejects.toThrow(/named branch changed concurrently/i);

    expect((await simpleGit(stale.dir).revparse(['HEAD'])).trim()).toBe(mainTip);
    expect((await simpleGit(stale.dir).revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe(
      'HEAD',
    );
    expect(
      (await mirror.revparse(['refs/heads/hercules/ADOPT-ATTACH-RACE'])).trim(),
    ).toBe(candidate);
  });

  it('fails closed without detaching a clean outside worktree pin', async () => {
    const manager = workspaces();
    const stale = await manager.create(repo, 'ADOPT-PINNED', {
      hadPriorWork: false,
      expectedBaseTip: mainTip,
    });
    const mirrorPath = join(tmp, 'work', '.mirrors', 'app.git');
    const mirror = simpleGit(mirrorPath);
    await mirror.raw(['worktree', 'remove', '--force', stale.dir]);
    (manager as unknown as { live: Map<string, unknown> }).live.clear();

    const outside = join(tmp, 'outside-pinned-candidate');
    await mirror.raw(['worktree', 'add', outside, 'hercules/ADOPT-PINNED']);
    const candidate = await competingCommit('hercules/ADOPT-PINNED', 'pinned-candidate');

    await expect(
      workspaces().create(repo, 'ADOPT-PINNED', {
        hadPriorWork: false,
        expectedBaseTip: mainTip,
        expectedBaseRevision: mainTip,
        expectedRemoteTip: candidate,
      }),
    ).rejects.toThrow(/coexisting task-branch pin/i);

    expect((await simpleGit(outside).revparse(['HEAD'])).trim()).toBe(mainTip);
    expect((await simpleGit(outside).revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe(
      'hercules/ADOPT-PINNED',
    );
  });

  it('fails closed without detaching a dirty outside worktree pin', async () => {
    const manager = workspaces();
    const stale = await manager.create(repo, 'ADOPT-DIRTY-PIN', {
      hadPriorWork: false,
      expectedBaseTip: mainTip,
    });
    const mirror = simpleGit(join(tmp, 'work', '.mirrors', 'app.git'));
    await mirror.raw(['worktree', 'remove', '--force', stale.dir]);
    (manager as unknown as { live: Map<string, unknown> }).live.clear();

    const outside = join(tmp, 'outside-dirty-pin');
    await mirror.raw(['worktree', 'add', outside, 'hercules/ADOPT-DIRTY-PIN']);
    await writeFile(join(outside, 'partial.txt'), 'must remain pinned\n');
    const candidate = await competingCommit('hercules/ADOPT-DIRTY-PIN', 'dirty-pin-candidate');

    await expect(
      workspaces().create(repo, 'ADOPT-DIRTY-PIN', {
        hadPriorWork: false,
        expectedBaseTip: mainTip,
        expectedBaseRevision: mainTip,
        expectedRemoteTip: candidate,
      }),
    ).rejects.toThrow(/coexisting task-branch pin/i);

    expect((await simpleGit(outside).revparse(['HEAD'])).trim()).toBe(mainTip);
    expect((await simpleGit(outside).revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe(
      'hercules/ADOPT-DIRTY-PIN',
    );
    expect(await readFile(join(outside, 'partial.txt'), 'utf8')).toBe('must remain pinned\n');
  });

  it('materializes a missing exact candidate object before fresh provisioning', async () => {
    const manager = workspaces();
    await manager.create(repo, 'MIRROR-WARMUP', { hadPriorWork: false });
    const candidate = await competingCommit('hercules/ADOPT-MISSING', 'missing-candidate');
    const mirror = simpleGit(join(tmp, 'work', '.mirrors', 'app.git'));
    await expect(mirror.raw(['cat-file', '-e', `${candidate}^{commit}`])).rejects.toThrow();

    const adopted = await manager.create(repo, 'ADOPT-MISSING', {
      hadPriorWork: false,
      expectedBaseTip: mainTip,
      expectedBaseRevision: mainTip,
      expectedRemoteTip: candidate,
    });

    expect((await simpleGit(adopted.dir).revparse(['HEAD'])).trim()).toBe(candidate);
    expect(await readFile(join(adopted.dir, 'missing-candidate.txt'), 'utf8')).toBe(
      'missing-candidate\n',
    );
  });

  it('rejects a bad-base candidate without reconciling a no-worktree local task ref', async () => {
    const manager = workspaces();
    await manager.create(repo, 'BAD-BASE-WARMUP', {
      hadPriorWork: false,
      expectedBaseTip: mainTip,
    });
    const localBranch = 'hercules/BAD-BASE-LOCAL';
    const localTip = await competingCommit(localBranch, 'bad-base-local');
    const mirror = simpleGit(join(tmp, 'work', '.mirrors', 'app.git'));
    await mirror.raw([
      'fetch',
      '--no-tags',
      origin,
      `refs/heads/${localBranch}:refs/hercules-test/bad-base-local`,
    ]);
    await mirror.raw(['update-ref', 'refs/heads/hercules/ADOPT-BAD-BASE', localTip]);

    const writerDir = join(tmp, 'bad-base-writer');
    await simpleGit(tmp).clone(origin, writerDir);
    const writer = simpleGit(writerDir);
    await writer.addConfig('user.email', 'other@hercules.local');
    await writer.addConfig('user.name', 'Other Writer');
    await writer.checkout(['--orphan', 'orphan-candidate']);
    await writer.raw(['rm', '-rf', '.']);
    await writeFile(join(writerDir, 'orphan.txt'), 'unrelated history\n');
    await writer.add('.');
    await writer.commit('unrelated candidate');
    const candidate = (await writer.revparse(['HEAD'])).trim();
    await writer.push(['origin', 'HEAD:refs/heads/hercules/ADOPT-BAD-BASE', '--force']);

    await expect(
      workspaces().create(repo, 'ADOPT-BAD-BASE', {
        hadPriorWork: false,
        expectedBaseTip: mainTip,
        expectedBaseRevision: mainTip,
        expectedRemoteTip: candidate,
      }),
    ).rejects.toThrow(/base mismatch/i);

    expect((await mirror.revparse(['refs/heads/hercules/ADOPT-BAD-BASE'])).trim()).toBe(
      localTip,
    );
    expect(await mirror.raw(['worktree', 'list', '--porcelain'])).not.toContain(
      'branch refs/heads/hercules/ADOPT-BAD-BASE',
    );
  });

  it('fails closed when the remote task ref moves after lease preflight', async () => {
    const manager = workspaces();
    await manager.create(repo, 'RACE-WARMUP', { hadPriorWork: false });
    const candidate = await competingCommit('hercules/ADOPT-DRIFT', 'drift-candidate');
    let winner = '';
    const racing = new GitWorkspaces({
      root: join(tmp, 'work'),
      ports: new PortAllocator(4300, 30),
      push: true,
      beforeExactCandidateFetch: async (branch) => {
        expect(branch).toBe('hercules/ADOPT-DRIFT');
        winner = await competingCommit(branch, 'drift-winner');
      },
    });

    await expect(
      racing.create(repo, 'ADOPT-DRIFT', {
        hadPriorWork: false,
        expectedBaseTip: mainTip,
        expectedBaseRevision: mainTip,
        expectedRemoteTip: candidate,
      }),
    ).rejects.toThrow(/exact lease changed while materializing/i);

    expect(winner).toMatch(/^[0-9a-f]{40}$/);
    expect(await readRemoteTaskBranchTip(simpleGit(origin), origin, 'hercules/ADOPT-DRIFT')).toBe(
      winner,
    );
    await expect(simpleGit(origin).raw(['cat-file', '-e', `${candidate}^{commit}`])).resolves.toBe(
      '',
    );
    const mirror = simpleGit(join(tmp, 'work', '.mirrors', 'app.git'));
    expect((await mirror.raw(['for-each-ref', '--format=%(refname)', 'refs/hercules-fetch'])).trim())
      .toMatch(/^refs\/hercules-fetch\//);
    await racing.readWorkflow(repo);
    expect((await mirror.raw(['for-each-ref', '--format=%(refname)', 'refs/hercules-fetch'])).trim())
      .toMatch(/^refs\/hercules-fetch\//);
    await workspaces().readWorkflow(repo);
    expect((await mirror.raw(['for-each-ref', '--format=%(refname)', 'refs/hercules-fetch'])).trim())
      .toBe('');
  });

  it('revalidates the remote lease after local checkout and before workspace handoff', async () => {
    const candidate = await competingCommit('hercules/ADOPT-POSTFETCH', 'postfetch-candidate');
    let winner = '';
    const racing = new GitWorkspaces({
      root: join(tmp, 'postfetch-work'),
      ports: new PortAllocator(4300, 30),
      push: true,
      beforeExactCandidateReturnVerify: async (branch) => {
        expect(branch).toBe('hercules/ADOPT-POSTFETCH');
        winner = await competingCommit(branch, 'postfetch-winner');
      },
    });

    await expect(
      racing.create(repo, 'ADOPT-POSTFETCH', {
        hadPriorWork: false,
        expectedBaseTip: mainTip,
        expectedBaseRevision: mainTip,
        expectedRemoteTip: candidate,
      }),
    ).rejects.toThrow(/exact lease changed before workspace handoff/i);

    expect(winner).toMatch(/^[0-9a-f]{40}$/);
    const provisioned = join(tmp, 'postfetch-work', 'app', 'ADOPT-POSTFETCH');
    expect((await simpleGit(provisioned).revparse(['HEAD'])).trim()).toBe(candidate);
    expect((await simpleGit(provisioned).revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe(
      'hercules/ADOPT-POSTFETCH',
    );
    const mirror = simpleGit(join(tmp, 'postfetch-work', '.mirrors', 'app.git'));
    expect((await mirror.raw(['for-each-ref', '--format=%(refname)', 'refs/hercules-fetch'])).trim())
      .toMatch(/^refs\/hercules-fetch\//);
    await racing.readWorkflow(repo);
    expect((await mirror.raw(['for-each-ref', '--format=%(refname)', 'refs/hercules-fetch'])).trim())
      .toMatch(/^refs\/hercules-fetch\//);
    await workspaces(join(tmp, 'postfetch-work')).readWorkflow(repo);
    expect((await mirror.raw(['for-each-ref', '--format=%(refname)', 'refs/hercules-fetch'])).trim())
      .toBe('');
  });

  it('preserves dirty worktree and branch pins when exact ref fetch fails after preflight', async () => {
    const manager = workspaces();
    const stale = await manager.create(repo, 'ADOPT-FETCH-FAIL', {
      hadPriorWork: false,
      expectedBaseTip: mainTip,
    });
    await writeFile(join(stale.dir, 'partial.txt'), 'must survive fetch failure\n');
    const candidate = await competingCommit('hercules/ADOPT-FETCH-FAIL', 'fetch-fail-candidate');
    (manager as unknown as { live: Map<string, unknown> }).live.clear();
    const racing = new GitWorkspaces({
      root: join(tmp, 'work'),
      ports: new PortAllocator(4300, 30),
      push: true,
      beforeExactCandidateFetch: async (branch) => {
        expect(branch).toBe('hercules/ADOPT-FETCH-FAIL');
        await simpleGit(origin).raw(['update-ref', '-d', `refs/heads/${branch}`]);
      },
    });

    await expect(
      racing.create(repo, 'ADOPT-FETCH-FAIL', {
        hadPriorWork: false,
        expectedBaseTip: mainTip,
        expectedBaseRevision: mainTip,
        expectedRemoteTip: candidate,
      }),
    ).rejects.toThrow(/could not materialize exact persisted candidate/i);

    expect((await simpleGit(stale.dir).revparse(['HEAD'])).trim()).toBe(mainTip);
    expect((await simpleGit(stale.dir).revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe(
      'hercules/ADOPT-FETCH-FAIL',
    );
    expect(await readFile(join(stale.dir, 'partial.txt'), 'utf8')).toBe(
      'must survive fetch failure\n',
    );
    const mirror = simpleGit(join(tmp, 'work', '.mirrors', 'app.git'));
    const worktrees = await mirror.raw(['worktree', 'list', '--porcelain']);
    expect(worktrees).toContain(`worktree ${stale.dir}`);
    expect(worktrees).toContain('branch refs/heads/hercules/ADOPT-FETCH-FAIL');
  });

  it('preserves a diverged no-worktree local ref when exact candidate fetch fails', async () => {
    const candidate = await competingCommit(
      'hercules/ADOPT-FETCH-REF',
      'fetch-ref-candidate',
    );
    const localBranch = 'hercules/FETCH-REF-LOCAL';
    const localTip = await competingCommit(localBranch, 'fetch-ref-local');
    const manager = workspaces();
    await manager.create(repo, 'FETCH-REF-WARMUP', {
      hadPriorWork: false,
      expectedBaseTip: mainTip,
    });
    const mirror = simpleGit(join(tmp, 'work', '.mirrors', 'app.git'));
    await mirror.raw([
      'update-ref',
      'refs/heads/hercules/ADOPT-FETCH-REF',
      localTip,
    ]);
    const racing = new GitWorkspaces({
      root: join(tmp, 'work'),
      ports: new PortAllocator(4300, 30),
      push: true,
      beforeExactCandidateFetch: async (branch) => {
        expect(branch).toBe('hercules/ADOPT-FETCH-REF');
        await simpleGit(origin).raw(['update-ref', '-d', `refs/heads/${branch}`]);
      },
    });

    await expect(
      racing.create(repo, 'ADOPT-FETCH-REF', {
        hadPriorWork: false,
        expectedBaseTip: mainTip,
        expectedBaseRevision: mainTip,
        expectedRemoteTip: candidate,
      }),
    ).rejects.toThrow(/could not materialize exact persisted candidate/i);

    expect((await mirror.revparse(['refs/heads/hercules/ADOPT-FETCH-REF'])).trim()).toBe(
      localTip,
    );
    expect(await mirror.raw(['worktree', 'list', '--porcelain'])).not.toContain(
      'branch refs/heads/hercules/ADOPT-FETCH-REF',
    );
  });

  it('preserve fails closed instead of pushing when the branch-pin hook fails', async () => {
    let hookCalled = false;
    const manager = new GitWorkspaces({
      root: join(tmp, 'work'),
      ports: new PortAllocator(4300, 30),
      push: true,
      beforeTaskBranchPin: async (branch) => {
        expect(branch).toBe('hercules/PRESERVE-PIN-FAIL');
        hookCalled = true;
        throw new Error('injected branch pin failure');
      },
    });
    const candidate = await competingCommit('hercules/PRESERVE-PIN-FAIL', 'pin-fail-candidate');
    const workspace = await manager.create(repo, 'PRESERVE-PIN-FAIL', {
      hadPriorWork: false,
      expectedBaseTip: mainTip,
      expectedBaseRevision: mainTip,
      expectedRemoteTip: candidate,
    });
    const worktreeGit = simpleGit(workspace.dir);
    await worktreeGit.raw(['checkout', '--detach']);
    await writeFile(join(workspace.dir, 'unique.txt'), 'must not become dangling noop\n');

    await expect(
      manager.preserve('PRESERVE-PIN-FAIL', 'hercules: PRESERVE-PIN-FAIL unique'),
    ).rejects.toThrow(/pinning failed/i);

    const uniqueHead = (await worktreeGit.revparse(['HEAD'])).trim();
    expect(hookCalled).toBe(true);
    expect(uniqueHead).not.toBe(candidate);
    expect(await readFile(join(workspace.dir, 'unique.txt'), 'utf8')).toBe(
      'must not become dangling noop\n',
    );
    expect(
      await readRemoteTaskBranchTip(simpleGit(origin), origin, 'hercules/PRESERVE-PIN-FAIL'),
    ).toBe(candidate);
  });

  it('keeps a diverged local ref while concurrent mirror refresh observes exact-candidate intent', async () => {
    const branch = 'hercules/ADOPT-CONCURRENT-REFRESH';
    const candidate = await competingCommit(branch, 'concurrent-refresh-candidate');
    const localTip = await competingCommit(
      'hercules/ADOPT-CONCURRENT-LOCAL',
      'concurrent-refresh-local',
    );
    const warm = workspaces();
    await warm.readWorkflow(repo);
    const mirror = simpleGit(join(tmp, 'work', '.mirrors', 'app.git'));
    await mirror.raw(['fetch', '--no-tags', origin, localTip]);
    await mirror.raw(['update-ref', `refs/heads/${branch}`, localTip]);

    const racing = new GitWorkspaces({
      root: join(tmp, 'work'),
      ports: new PortAllocator(4300, 30),
      push: true,
      beforeExactCandidateFetch: async (observedBranch) => {
        expect(observedBranch).toBe(branch);
        await racing.readWorkflow(repo);
      },
    });

    await expect(
      racing.create(repo, 'ADOPT-CONCURRENT-REFRESH', {
        hadPriorWork: false,
        expectedBaseTip: mainTip,
        expectedBaseRevision: mainTip,
        expectedRemoteTip: candidate,
      }),
    ).rejects.toThrow(/unique local branch tip/i);
    expect((await mirror.revparse([`refs/heads/${branch}`])).trim()).toBe(localTip);
  });

  it('preserve fast-forwards an ancestor named ref with CAS and removes its recovery ref', async () => {
    const manager = workspaces();
    const branch = 'hercules/PRESERVE-CAS-FF';
    const candidate = await competingCommit(branch, 'preserve-cas-ff');
    const workspace = await manager.create(repo, 'PRESERVE-CAS-FF', {
      hadPriorWork: false,
      expectedBaseTip: mainTip,
      expectedBaseRevision: mainTip,
      expectedRemoteTip: candidate,
    });
    const worktreeGit = simpleGit(workspace.dir);
    await worktreeGit.raw(['checkout', '--detach']);
    await writeFile(join(workspace.dir, 'advanced.txt'), 'safe fast-forward\n');

    const result = await manager.preserve('PRESERVE-CAS-FF', 'hercules: PRESERVE-CAS-FF advance');
    expect(result.notPropagated).toBe(false);
    const advanced = result.branchLease?.expectedRemoteTip ?? '';
    expect(advanced).not.toBe(candidate);
    const mirror = simpleGit(join(tmp, 'work', '.mirrors', 'app.git'));
    expect((await mirror.revparse([`refs/heads/${branch}`])).trim()).toBe(advanced);
    expect(
      (await mirror.raw(['for-each-ref', '--format=%(refname)', 'refs/hercules-preserve/'])).trim(),
    ).toBe('');
  });

  it('preserve refuses a diverged unpinned named ref and keeps both unique tips reachable', async () => {
    const manager = workspaces();
    const branch = 'hercules/PRESERVE-CAS-DIVERGED';
    const candidate = await competingCommit(branch, 'preserve-cas-base');
    const workspace = await manager.create(repo, 'PRESERVE-CAS-DIVERGED', {
      hadPriorWork: false,
      expectedBaseTip: mainTip,
      expectedBaseRevision: mainTip,
      expectedRemoteTip: candidate,
    });
    const worktreeGit = simpleGit(workspace.dir);
    await worktreeGit.raw(['checkout', '--detach']);
    await writeFile(join(workspace.dir, 'detached-unique.txt'), 'detached unique\n');
    const namedWinner = await competingCommit(branch, 'preserve-cas-diverged-winner');
    const mirror = simpleGit(join(tmp, 'work', '.mirrors', 'app.git'));
    await mirror.raw(['fetch', '--no-tags', origin, namedWinner]);
    await mirror.raw(['update-ref', `refs/heads/${branch}`, namedWinner]);

    await expect(
      manager.preserve('PRESERVE-CAS-DIVERGED', 'hercules: PRESERVE-CAS-DIVERGED detached'),
    ).rejects.toThrow(/pinning failed/i);
    const detachedHead = (await worktreeGit.revparse(['HEAD'])).trim();
    expect(detachedHead).not.toBe(candidate);
    expect((await mirror.revparse([`refs/heads/${branch}`])).trim()).toBe(namedWinner);
    await expect(mirror.raw(['cat-file', '-e', `${detachedHead}^{commit}`])).resolves.toBeDefined();
  });

  it('preserve CAS rejects a concurrent named-ref advance and retains a recovery ref', async () => {
    let winner = '';
    const state: { mirror?: SimpleGit } = {};
    const branch = 'hercules/PRESERVE-CAS-RACE';
    const manager = new GitWorkspaces({
      root: join(tmp, 'work'),
      ports: new PortAllocator(4300, 30),
      push: true,
      beforeTaskBranchPin: async (observedBranch) => {
        expect(observedBranch).toBe(branch);
        await state.mirror!.raw(['update-ref', `refs/heads/${branch}`, winner]);
      },
    });
    const candidate = await competingCommit(branch, 'preserve-cas-race-base');
    const workspace = await manager.create(repo, 'PRESERVE-CAS-RACE', {
      hadPriorWork: false,
      expectedBaseTip: mainTip,
      expectedBaseRevision: mainTip,
      expectedRemoteTip: candidate,
    });
    const worktreeGit = simpleGit(workspace.dir);
    await worktreeGit.raw(['checkout', '--detach']);
    await writeFile(join(workspace.dir, 'race-unique.txt'), 'detached race unique\n');
    winner = await competingCommit(
      'hercules/PRESERVE-CAS-RACE-WINNER',
      'preserve-cas-race-winner',
    );
    const mirror = simpleGit(join(tmp, 'work', '.mirrors', 'app.git'));
    state.mirror = mirror;
    await mirror.raw(['fetch', '--no-tags', origin, winner]);

    await expect(
      manager.preserve('PRESERVE-CAS-RACE', 'hercules: PRESERVE-CAS-RACE detached'),
    ).rejects.toThrow(/pinning failed/i);
    const detachedHead = (await worktreeGit.revparse(['HEAD'])).trim();
    expect((await mirror.revparse([`refs/heads/${branch}`])).trim()).toBe(winner);
    const recoveryTips = (
      await mirror.raw(['for-each-ref', '--format=%(objectname)', 'refs/hercules-preserve/'])
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(recoveryTips).toContain(detachedHead);
  });

  it('freshly rechecks checkout pins when mirror reconciliation waits on preserve', async () => {
    const branch = 'hercules/PRESERVE-RECONCILE-RACE';
    let refresh: Promise<string | null> | null = null;
    const manager = new GitWorkspaces({
      root: join(tmp, 'work'),
      ports: new PortAllocator(4300, 30),
      push: true,
      beforeTaskBranchPin: async (observedBranch) => {
        expect(observedBranch).toBe(branch);
        refresh = manager.readWorkflow(repo);
        await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 25));
      },
    });
    const candidate = await competingCommit(branch, 'preserve-reconcile-base');
    const workspace = await manager.create(repo, 'PRESERVE-RECONCILE-RACE', {
      hadPriorWork: false,
      expectedBaseTip: mainTip,
      expectedBaseRevision: mainTip,
      expectedRemoteTip: candidate,
    });
    const worktreeGit = simpleGit(workspace.dir);
    await worktreeGit.raw(['checkout', '--detach']);
    await writeFile(join(workspace.dir, 'preserve-winner.txt'), 'preserve winner\n');
    const remoteWinner = await competingCommit(branch, 'preserve-reconcile-remote');

    const result = await manager.preserve(
      'PRESERVE-RECONCILE-RACE',
      'hercules: PRESERVE-RECONCILE-RACE local winner',
    );
    await refresh;

    expect(result.notPropagated).toBe(true);
    const mirror = simpleGit(join(tmp, 'work', '.mirrors', 'app.git'));
    const preservedTip = (await mirror.revparse([`refs/heads/${branch}`])).trim();
    expect(preservedTip).not.toBe(candidate);
    expect(preservedTip).not.toBe(remoteWinner);
    await expect(mirror.raw(['cat-file', '-e', `${preservedTip}^{commit}`])).resolves.toBeDefined();
    expect(await readRemoteTaskBranchTip(simpleGit(origin), origin, branch)).toBe(remoteWinner);
  });

  it('uses the force-with-lease CAS against a change after preflight', async () => {
    const branch = 'hercules/ATOMIC';
    const expected = await competingCommit(branch, 'expected');
    const localDir = join(tmp, 'atomic-local');
    await simpleGit(tmp).clone(origin, localDir);
    const local = simpleGit(localDir);
    await local.addConfig('user.email', 'local@hercules.local');
    await local.addConfig('user.name', 'Local Writer');
    await local.checkout(['-B', 'local', 'origin/main']);
    await writeFile(join(localDir, 'local.txt'), 'local\n');
    await local.add('.');
    await local.commit('local');
    const localTip = (await local.revparse(['HEAD'])).trim();
    let winner = '';

    await expect(
      pushTaskBranchWithExactLease({
        git: local,
        originUrl: origin,
        branch,
        localTip,
        lease: { expectedBaseRevision: mainTip, expectedRemoteTip: expected },
        allowOwnedReset: false,
        beforePush: async () => {
          winner = await competingCommit(branch, 'winner');
        },
      }),
    ).rejects.toMatchObject({ name: 'TaskBranchLeaseError', code: 'remote_changed' });
    expect(await readRemoteTaskBranchTip(local, origin, branch)).toBe(winner);
  });

  it('permits an exact fresh reset and a branch-absent salvage seed', async () => {
    const polluted = await competingCommit('hercules/FRESH', 'polluted');
    const manager = workspaces();
    const fresh = await manager.create(repo, 'FRESH', { hadPriorWork: false });
    expect(fresh.branchLease.expectedRemoteTip).toBe(polluted);
    await writeFile(join(fresh.dir, 'fresh.txt'), 'fresh\n');
    const reset = await manager.preserve('FRESH', 'hercules: FRESH owned reset');
    expect(reset.notPropagated).toBe(false);
    expect(reset.branchLease?.expectedRemoteTip).not.toBe(polluted);

    const sourceWorkspace = await manager.create(repo, 'SOURCE', { hadPriorWork: false });
    await writeFile(join(sourceWorkspace.dir, 'source.txt'), 'salvage source\n');
    const sourceResult = await manager.preserve('SOURCE', 'hercules: SOURCE work');
    const source = sourceResult.branchLease!.expectedRemoteTip!;
    const salvage = await manager.create(repo, 'SALVAGE', {
      hadPriorWork: false,
      seedFromSha: source,
    });
    expect(salvage.branchLease.expectedRemoteTip).toBeNull();
    const saved = await manager.preserve('SALVAGE', 'hercules: SALVAGE seed');
    expect(saved.notPropagated).toBe(false);
    const target = saved.branchLease?.expectedRemoteTip;
    expect(target).toMatch(/^[0-9a-f]{40}$/);
    expect(
      Number((await simpleGit(origin).raw(['rev-list', '--count', `${source}..${target}`])).trim()),
    ).toBeGreaterThanOrEqual(0);
  });

  it('treats remote transport errors as unavailable, never branch absence', async () => {
    const git: SimpleGit = simpleGit(seed);
    await expect(
      readRemoteTaskBranchTip(git, join(tmp, 'missing.git'), 'hercules/NOPE'),
    ).rejects.toBeInstanceOf(TaskBranchLeaseError);
  });

  it('contains no ordinary force-push in production task-branch publication', async () => {
    const worktree = await readFile(join(process.cwd(), 'src/isolation/worktree.ts'), 'utf8');
    const primitive = await readFile(join(process.cwd(), 'src/isolation/exactLeasePush.ts'), 'utf8');
    const domain = await readFile(join(process.cwd(), 'src/domain/taskBranchLease.ts'), 'utf8');
    const taskPushStart = worktree.indexOf('  private async pushTaskBranch(');
    const taskPushEnd = worktree.indexOf('\n  async inspect(', taskPushStart);
    expect(taskPushStart).toBeGreaterThanOrEqual(0);
    expect(taskPushEnd).toBeGreaterThan(taskPushStart);
    expect(worktree.slice(taskPushStart, taskPushEnd)).not.toMatch(/['"]--force['"]/);
    expect(primitive).not.toMatch(/['"]--force['"]/);
    expect(primitive).toContain('taskBranchLeaseArg(');
    expect(domain).toContain('--force-with-lease=');
  });
});
