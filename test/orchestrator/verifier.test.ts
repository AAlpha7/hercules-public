import { describe, it, expect, vi } from 'vitest';
import { WorktreeVerifier } from '../../src/orchestrator/verifier.js';
import { Reviewer, ReviewerInfraError } from '../../src/verification/reviewer.js';
import type { CommandRunner } from '../../src/verification/gates.js';
import type { WorktreeDiff } from '../../src/isolation/diff.js';
import type { Task } from '../../src/domain/task.js';
import type { RepoConfig } from '../../src/domain/repos.js';
import type { Workspace } from '../../src/domain/allocation.js';
import type { TaskPrInput } from '../../src/orchestrator/taskPr.js';
import type { GhRunner } from '../../src/orchestrator/openPr.js';

const task: Task = {
  id: 'T-1', title: 'Fix it', repo: 'app', state: 'in_progress', priority: 1,
  blockedBy: [], labels: [], adapter: null, agentSession: 's', pendingSteer: null, attempts: 0, lastEventAt: null, createdAt: null, startedAt: null, endedAt: null,
  prUrl: null,
  prStatus: null,
  planPending: false,
  body: '## Acceptance criteria\n- [ ] works',
};

const scopedTask: Task = {
  ...task,
  affectedPaths: ['src/domain/'],
};
const repo: RepoConfig = { key: 'app', url: 'x', defaultBranch: 'main', workflow: 'WORKFLOW.md', maxConcurrent: 1, adapter: null, readiness: 'ready' };
const workspace: Workspace = {
  taskId: 'T-1', repo: 'app', dir: '/ws/app/T-1', branch: 'hercules/T-1',
  allocation: { slug: 'T-1', port: 4000, scratchDir: '/ws/app/T-1/.scratch' },
  branchLease: { expectedBaseRevision: '0'.repeat(40), expectedRemoteTip: null },
};

const WORKFLOW = '---\ngates:\n  test: pnpm test\nprotected_paths:\n  - test/smoke/**\n---\nbe careful';
const diff: WorktreeDiff = {
  diff: 'diff --git a/src/x.ts b/src/x.ts\n+const a = 1;',
  filesTouched: ['src/x.ts'],
  diffSummary: '1 file changed',
  compareBase: 'main',
};

function makeVerifier(opts: {
  runner: CommandRunner;
  reviewer?: Reviewer;
  workflow?: string | null;
  fetchPrSummary?: (input: TaskPrInput) => Promise<{
    prUrl: string;
    state: string;
    mergeable: string | null;
    reviewDecision: string | null;
    ciStatus: 'success' | 'failure' | 'pending' | 'neutral' | 'unknown';
    ciSummary: string;
    commentCount: number;
    reviewCount: number;
    title: string | null;
    mergeCommitSha: string | null;
  }>;
  gh?: GhRunner;
  captureDiff?: () => Promise<WorktreeDiff>;
  auditCliEvidenceWorkspace?: () => Promise<{ readonly mutated: boolean }>;
  commitState?: () => Promise<string | null>;
  resolveHead?: () => Promise<string | null>;
  discardWorktreeChanges?: (dir: string) => Promise<readonly string[]>;
}) {
  return new WorktreeVerifier({
    workspaces: { readWorkflow: async () => (opts.workflow === undefined ? WORKFLOW : opts.workflow) },
    captureDiff: opts.captureDiff ?? (async () => diff),
    commandRunner: opts.runner,
    ...(opts.reviewer ? { reviewer: opts.reviewer } : {}),
    ...(opts.fetchPrSummary ? { fetchPrSummary: opts.fetchPrSummary } : {}),
    ...(opts.gh ? { gh: opts.gh } : {}),
    ...(opts.auditCliEvidenceWorkspace
      ? { auditCliEvidenceWorkspace: opts.auditCliEvidenceWorkspace }
      : {}),
    ...(opts.commitState ? { commitState: opts.commitState } : {}),
    ...(opts.resolveHead ? { resolveHead: opts.resolveHead } : {}),
    ...(opts.discardWorktreeChanges
      ? { discardWorktreeChanges: opts.discardWorktreeChanges }
      : {}),
  });
}

describe('verify-only runs never publish agent bytes (C3.56)', () => {
  const SEED = 'b'.repeat(40);
  const verifyTask: Task = { ...task, executionClass: 'verify', seedFromSha: SEED };

  it('discards uncommitted paths, never auto-commits, and reports the discard', async () => {
    const commitState = vi.fn(async () => 'c'.repeat(40));
    const discard = vi.fn(async () => ['.verify-probe.txt', '.verify-run-gates.sh']);
    const verifier = makeVerifier({
      runner: pass,
      commitState,
      resolveHead: async () => SEED,
      discardWorktreeChanges: discard,
    });
    const packet = await verifier.verify(verifyTask, repo, workspace);
    expect(discard).toHaveBeenCalledWith('/ws/app/T-1');
    expect(commitState).not.toHaveBeenCalled();
    expect(packet.verifiedSha).toBe(SEED);
    expect(packet.verifyOnlyDiscardedPaths).toEqual(['.verify-probe.txt', '.verify-run-gates.sh']);
    expect(packet.gates.some((g) => g.name === 'verify-only-tip')).toBe(false);
    const { renderPacketMarkdown } = await import('../../src/verification/packet.js');
    const md = renderPacketMarkdown(packet);
    expect(md).toContain('**Verify-only run:** 2 uncommitted path(s)');
    expect(md).toContain('.verify-probe.txt');
  });

  it('fails closed when the worktree tip is not the seed', async () => {
    const verifier = makeVerifier({
      runner: pass,
      commitState: vi.fn(async () => 'c'.repeat(40)),
      resolveHead: async () => 'd'.repeat(40),
      discardWorktreeChanges: async () => [],
    });
    const packet = await verifier.verify(verifyTask, repo, workspace);
    const gate = packet.gates.find((g) => g.name === 'verify-only-tip');
    expect(gate?.passed).toBe(false);
    expect(gate?.output).toContain(SEED);
    expect(packet.green).toBe(false);
    expect(packet.autoRework).toBe(true);
    expect(packet.verifyOnlyDiscardedPaths).toBeUndefined();
  });

  it('implement tasks still auto-commit and never discard', async () => {
    const commitState = vi.fn(async () => 'c'.repeat(40));
    const discard = vi.fn(async () => ['x']);
    const verifier = makeVerifier({ runner: pass, commitState, discardWorktreeChanges: discard });
    const packet = await verifier.verify(task, repo, workspace);
    expect(discard).not.toHaveBeenCalled();
    expect(commitState).toHaveBeenCalledOnce();
    expect(packet.verifiedSha).toBe('c'.repeat(40));
  });

  it('discardUncommittedWorktreeChanges drops tracked edits + untracked files, keeps ignored', async () => {
    const { access, mkdtemp, readFile, writeFile, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { simpleGit } = await import('simple-git');
    const { discardUncommittedWorktreeChanges } = await import('../../src/orchestrator/verifier.js');
    const dir = await mkdtemp(join(tmpdir(), 'verifier-verify-only-'));
    const git = simpleGit(dir);
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 't@h.local');
    await git.addConfig('user.name', 'T');
    await writeFile(join(dir, 'source.txt'), 'seed\n');
    await writeFile(join(dir, '.gitignore'), 'cache/\n');
    await git.add('.');
    await git.commit('seed');
    const seed = (await git.raw(['rev-parse', 'HEAD'])).trim();
    await writeFile(join(dir, 'source.txt'), 'agent edit\n');
    await writeFile(join(dir, '.verify-probe.txt'), '');
    await mkdir(join(dir, 'cache'));
    await writeFile(join(dir, 'cache', 'keep'), 'ignored\n');

    const dropped = await discardUncommittedWorktreeChanges(dir);
    expect(dropped.sort()).toEqual(['.verify-probe.txt', 'source.txt']);
    expect(await readFile(join(dir, 'source.txt'), 'utf8')).toBe('seed\n');
    await expect(access(join(dir, '.verify-probe.txt'))).rejects.toThrow();
    expect(await readFile(join(dir, 'cache', 'keep'), 'utf8')).toBe('ignored\n');
    expect((await git.status()).files).toEqual([]);
    expect((await git.raw(['rev-parse', 'HEAD'])).trim()).toBe(seed);
    expect(await discardUncommittedWorktreeChanges(dir)).toEqual([]);
  });
});

const pass: CommandRunner = async () => ({ exitCode: 0, output: 'ok' });
const fail: CommandRunner = async () => ({ exitCode: 1, output: 'boom' });

describe('reviewer infrastructure checkpoint', () => {
  it('attaches exact candidate, branch, worktree, and prior green evidence', async () => {
    const candidate = 'a'.repeat(40);
    const verifier = makeVerifier({
      runner: pass,
      commitState: async () => candidate,
      reviewer: new Reviewer(async () => {
        throw new ReviewerInfraError('Not signed in; run grok login');
      }),
    });

    const pending = verifier.verify(task, repo, workspace);
    await expect(pending).rejects.toMatchObject({
      code: 'reviewer_infra',
      receipt: {
        provider: 'grok',
        state: 'blocked',
        failureKind: 'authentication',
        candidateSha: candidate,
        branch: 'hercules/T-1',
        worktree: '/ws/app/T-1',
        greenEvidence: ['test'],
      },
    });
  });
});

describe('commitVerifiedState (durability point at L1)', () => {
  it('bypasses candidate pre-commit hooks at the verifier-owned commit boundary', async () => {
    const { access, chmod, mkdir, mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { simpleGit } = await import('simple-git');
    const { commitVerifiedState } = await import('../../src/orchestrator/verifier.js');
    const dir = await mkdtemp(join(tmpdir(), 'verifier-no-hooks-'));
    const git = simpleGit({ baseDir: dir, unsafe: { allowUnsafeHooksPath: true } });
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 't@h.local');
    await git.addConfig('user.name', 'T');
    const noHooks = join(dir, '.no-hooks');
    await mkdir(noHooks);
    await git.addConfig('core.hooksPath', noHooks);
    await writeFile(join(dir, 'base.txt'), 'base\n');
    await git.add('.');
    await git.commit('base');
    const hooks = join(dir, '.hooks');
    await mkdir(hooks);
    const hook = join(hooks, 'pre-commit');
    await writeFile(hook, '#!/bin/sh\ntouch hook-stray.txt\ngit add hook-stray.txt\n');
    await chmod(hook, 0o755);
    await git.addConfig('core.hooksPath', hooks);
    await writeFile(join(dir, 'owned.txt'), 'owned\n');

    const sha = await commitVerifiedState(dir, 'hercules: hook-safe');

    expect(sha).not.toBeNull();
    await expect(access(join(dir, 'hook-stray.txt'))).rejects.toThrow();
    expect(await git.raw(['show', '--format=', '--name-only', sha!])).not.toContain(
      'hook-stray.txt',
    );
  });

  it('commits staged+untracked work so the verified SHA survives worktree loss', async () => {
    // 2026-07-17: onboard-verify-2's 745-line diff existed only UNCOMMITTED in
    // the worktree at verify time; the worktree was wiped before preserve and
    // the work was unrecoverable. Verify must make the state durable first.
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { simpleGit } = await import('simple-git');
    const { commitVerifiedState } = await import('../../src/orchestrator/verifier.js');

    const dir = await mkdtemp(join(tmpdir(), 'hercules-vstate-'));
    const git = simpleGit(dir);
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 't@h.local');
    await git.addConfig('user.name', 'T');
    await writeFile(join(dir, 'base.txt'), 'base\n');
    await git.add('.');
    await git.commit('base');
    const base = (await git.raw(['rev-parse', 'HEAD'])).trim();

    await writeFile(join(dir, 'uncommitted.txt'), 'agent work\n');
    const sha = await commitVerifiedState(dir, 'hercules: T-9 — verified state');
    expect(sha).not.toBeNull();
    expect(sha).not.toBe(base);
    const subj = (await git.raw(['log', '-1', '--format=%s'])).trim();
    expect(subj).toBe('hercules: T-9 — verified state');

    // Clean worktree → returns the existing HEAD unchanged.
    expect(await commitVerifiedState(dir, 'hercules: T-9 — again')).toBe(sha);
    // Non-git dir → null, never throws.
    expect(await commitVerifiedState(tmpdir(), 'x')).toBeNull();
  });

  it('verify() records the durably committed SHA as verifiedSha', async () => {
    const commits: string[] = [];
    const verifier = new WorktreeVerifier({
      workspaces: { readWorkflow: async () => WORKFLOW },
      captureDiff: async () => diff,
      commandRunner: pass,
      commitState: async (_dir: string, message: string) => {
        commits.push(message);
        return 'feedf00dfeedf00dfeedf00dfeedf00dfeedf00d';
      },
    });
    const packet = await verifier.verify(task, repo, workspace);
    expect(packet.verifiedSha).toBe('feedf00dfeedf00dfeedf00dfeedf00dfeedf00d');
    expect(commits[0]).toContain('T-1');
  });
});

describe('WorktreeVerifier verified SHA', () => {
  it('records the worktree HEAD it verified so approve can hold the tip to it', async () => {
    const verifier = new WorktreeVerifier({
      workspaces: { readWorkflow: async () => WORKFLOW },
      captureDiff: async () => diff,
      commandRunner: pass,
      resolveHead: async () => 'cafe1234cafe1234cafe1234cafe1234cafe1234',
      detectBaseDrift: async () => ({
        defaultBranch: 'main',
        mergeBase: null,
        headSha: 'cafe1234cafe1234cafe1234cafe1234cafe1234',
        baseSha: null,
        behind: 0,
        ahead: 0,
        status: 'current' as const,
        conflictRisk: 'none' as const,
        conflictDetail: null,
        rebaseAttempted: false,
        rebaseOk: null,
        rebaseDetail: null,
      }),
    });
    const packet = await verifier.verify(task, repo, workspace);
    expect(packet.verifiedSha).toBe('cafe1234cafe1234cafe1234cafe1234cafe1234');
  });

  it('degrades to null when HEAD cannot be resolved (fake/non-git worktree)', async () => {
    const packet = await makeVerifier({ runner: pass }).verify(task, repo, workspace);
    expect(packet.verifiedSha).toBeNull();
  });
});

describe('WorktreeVerifier trusted CLI evidence integration', () => {
  it('uses only the trusted mirror plan and ignores task-body/candidate WORKFLOW commands', async () => {
    const { mkdir, mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'verifier-cli-trusted-'));
    await mkdir(join(dir, 'scripts'));
    await writeFile(join(dir, 'scripts', 'trusted.py'), 'print("trusted-plan")\n');
    await writeFile(join(dir, 'WORKFLOW.md'), 'cli_evidence: evil candidate text\n');
    const trustedWorkflow = `---
gates:
  test: pnpm test
cli_evidence:
  version: 1
  steps:
    - id: trusted
      argv: [python3, scripts/trusted.py]
      expect: { stdout_contains: trusted-plan }
---
trusted mirror`;
    const localWorkspace: Workspace = { ...workspace, dir };
    const injectedTask: Task = {
      ...task,
      body: task.body + '\ncli_evidence:\n  steps:\n    - argv: [python3, scripts/evil.py]\n',
    };
    const packet = await makeVerifier({
      runner: pass,
      workflow: trustedWorkflow,
      auditCliEvidenceWorkspace: async () => ({ mutated: false }),
    })
      .verify(injectedTask, repo, localWorkspace);
    expect(packet.cliEvidence?.status).toBe('passed');
    expect(packet.cliEvidence?.steps[0]?.id).toBe('trusted');
    expect(packet.cliEvidence?.steps[0]?.argv).toEqual(['python3', 'scripts/trusted.py']);
  });

  it('makes a required mismatch non-green, requests rework, and does not continue to L3', async () => {
    const { mkdir, mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'verifier-cli-fail-'));
    await mkdir(join(dir, 'scripts'));
    await writeFile(join(dir, 'scripts', 'actual.py'), 'print("actual")\n');
    const trustedWorkflow = `---
gates:
  test: pnpm test
cli_evidence:
  version: 1
  steps:
    - id: mismatch
      argv: [python3, scripts/actual.py]
      expect: { stdout_contains: expected }
---
trusted mirror`;
    const reviewRun = vi.fn(async () => 'VERDICT: approved\nSUMMARY: should not run');
    const verifier = makeVerifier({
      runner: pass,
      workflow: trustedWorkflow,
      reviewer: new Reviewer(reviewRun),
      auditCliEvidenceWorkspace: async () => ({ mutated: false }),
    });
    const packet = await verifier.verify(task, repo, { ...workspace, dir });
    expect(packet.cliEvidence?.status).toBe('failed');
    expect(packet.green).toBe(false);
    expect(packet.autoRework).toBe(true);
    expect(reviewRun).not.toHaveBeenCalled();
  });

  it('propagates CLI evidence cancellation as verification abort before L3', async () => {
    const { mkdir, mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'verifier-cli-cancel-'));
    await mkdir(join(dir, 'scripts'));
    await writeFile(join(dir, 'scripts', 'slow.py'), 'import time\ntime.sleep(3)\n');
    const trustedWorkflow = `---
gates:
  test: pnpm test
cli_evidence:
  version: 1
  steps:
    - id: slow
      argv: [python3, scripts/slow.py]
---
trusted mirror`;
    const reviewRun = vi.fn(async () => 'VERDICT: approved\nSUMMARY: should not run');
    const verifier = makeVerifier({
      runner: pass,
      workflow: trustedWorkflow,
      reviewer: new Reviewer(reviewRun),
      auditCliEvidenceWorkspace: async () => ({ mutated: false }),
    });
    const controller = new AbortController();
    const verifying = verifier.verify(task, repo, { ...workspace, dir }, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 80);
    await expect(verifying).rejects.toMatchObject({ code: 'verification_aborted' });
    expect(reviewRun).not.toHaveBeenCalled();
  });

  it('audits before propagating an abort that arrives as the CLI runner resolves', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'verifier-cli-abort-race-'));
    await writeFile(join(dir, 'ok.py'), 'print("ok")\n');
    const trustedWorkflow = `---
gates:
  test: pnpm test
cli_evidence:
  version: 1
  steps:
    - id: quick
      argv: [python3, ok.py]
---
trusted mirror`;
    const controller = new AbortController();
    const audit = vi.fn(async () => {
      controller.abort();
      return { mutated: false } as const;
    });
    const verifier = makeVerifier({
      runner: pass,
      workflow: trustedWorkflow,
      auditCliEvidenceWorkspace: audit,
    });
    await expect(
      verifier.verify(task, repo, { ...workspace, dir }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'verification_aborted' });
    expect(audit).toHaveBeenCalledOnce();
  });

  it('fails and restores the verified tree when CLI evidence mutates source after L1', async () => {
    const { access, mkdtemp, readFile, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { simpleGit } = await import('simple-git');
    const dir = await mkdtemp(join(tmpdir(), 'verifier-cli-mutation-'));
    const git = simpleGit(dir);
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 't@h.local');
    await git.addConfig('user.name', 'T');
    await writeFile(join(dir, 'source.txt'), 'authoritative\n');
    await writeFile(join(dir, '.gitignore'), 'cache/\n');
    await writeFile(
      join(dir, 'mutate.py'),
      "from pathlib import Path\nPath('source.txt').write_text('post-l1 mutation\\n')\nPath('cache').mkdir()\nPath('cache/poison').write_text('persist')\nprint('looks-good')\n",
    );
    await writeFile(join(dir, 'feature.txt'), 'base\n');
    await git.add('.');
    await git.commit('base');
    await git.checkoutLocalBranch('hercules/T-1');
    await writeFile(join(dir, 'feature.txt'), 'agent change\n');
    const trustedWorkflow = `---
gates:
  test: pnpm test
cli_evidence:
  version: 1
  steps:
    - id: mutator
      argv: [python3, mutate.py]
      expect: { stdout_contains: looks-good }
---
trusted mirror`;
    const verifier = new WorktreeVerifier({
      workspaces: { readWorkflow: async () => trustedWorkflow },
      commandRunner: pass,
    });
    const packet = await verifier.verify(task, repo, { ...workspace, dir });
    expect(packet.cliEvidence?.status).toBe('failed');
    expect(packet.cliEvidence?.steps.at(-1)?.status).toBe('workspace_mutation');
    expect(packet.green).toBe(false);
    expect(packet.autoRework).toBe(true);
    expect(await readFile(join(dir, 'source.txt'), 'utf8')).toBe('authoritative\n');
    await expect(access(join(dir, 'cache', 'poison'))).rejects.toThrow();
    expect((await git.raw(['rev-parse', 'HEAD'])).trim()).toBe(packet.verifiedSha);
    expect((await git.status()).files).toEqual([]);
  });
});

describe('WorktreeVerifier first-time WORKFLOW bootstrap', () => {
  const BASE = 'a'.repeat(40);
  const bootstrapTask: Task = {
    ...task,
    plannedBaseRevision: BASE,
    affectedPaths: ['WORKFLOW.md'],
    protectedPathsSnapshot: [],
    labels: ['onboarding', 'readiness'],
  };
  const incompleteRepo: RepoConfig = {
    ...repo,
    readiness: 'incomplete',
  };
  const validWorkflow =
    '---\ngates:\n  test: pnpm test\nsetup:\n  install:\n    - echo install\n---\nprinciples\n';

  it('verifies exact one-path parse without executing candidate commands', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'hercules-bootstrap-verify-'));
    await writeFile(join(dir, 'WORKFLOW.md'), validWorkflow);
    const ran: string[] = [];
    const runner: CommandRunner = async (command) => {
      ran.push(command);
      return { exitCode: 0, output: 'ok' };
    };
    const verifier = new WorktreeVerifier({
      workspaces: {
        readWorkflow: async () => null,
        readTrustedDefaultRevisionSnapshot: async () => ({
          revision: BASE,
          workflowContent: null,
        }),
      },
      captureDiff: async () => ({
        diff: 'diff --git a/WORKFLOW.md b/WORKFLOW.md\n+x',
        filesTouched: ['WORKFLOW.md'],
        diffSummary: '1 file changed',
        compareBase: 'main',
      }),
      commandRunner: runner,
      commitState: async () => BASE,
      resolveHead: async () => BASE,
      readCandidateFileAt: async (_dir, _revision, path) => {
        expect(path).toBe('WORKFLOW.md');
        return validWorkflow;
      },
    });
    const packet = await verifier.verify(
      bootstrapTask,
      { ...incompleteRepo, workflow: '/WORKFLOW.md' },
      {
      ...workspace,
      dir,
      },
    );
    const gate = packet.gates.find((g) => g.name === 'workflow-bootstrap');
    expect(gate?.passed).toBe(true);
    expect(gate?.output).toMatch(/not executed/);
    // Candidate-defined install/gates must never run while untrusted.
    expect(ran).toEqual([]);
    expect(packet.gates.some((g) => g.command.includes('pnpm') || g.command.includes('echo'))).toBe(
      false,
    );
  });

  it('fails broader diffs and malformed candidates without running commands', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'hercules-bootstrap-bad-'));
    await writeFile(join(dir, 'WORKFLOW.md'), 'not a workflow');
    const ran: string[] = [];
    const verifier = new WorktreeVerifier({
      workspaces: {
        readWorkflow: async () => null,
        readTrustedDefaultRevisionSnapshot: async () => ({
          revision: BASE,
          workflowContent: null,
        }),
      },
      captureDiff: async () => ({
        diff: 'x',
        filesTouched: ['WORKFLOW.md', 'src/a.ts'],
        diffSummary: '2 files',
        compareBase: 'main',
      }),
      commandRunner: async (c) => {
        ran.push(c);
        return { exitCode: 0, output: 'ok' };
      },
      commitState: async () => BASE,
      resolveHead: async () => BASE,
      readCandidateFileAt: async () => 'not a workflow',
    });
    const packet = await verifier.verify(bootstrapTask, incompleteRepo, {
      ...workspace,
      dir,
    });
    expect(packet.gates.find((g) => g.name === 'workflow-bootstrap')?.passed).toBe(false);
    expect(ran).toEqual([]);
  });

  it('fails closed when the exact trusted revision cannot be re-proven', async () => {
    const ran: string[] = [];
    const verifier = new WorktreeVerifier({
      workspaces: {
        readWorkflow: async () => null,
        readTrustedDefaultRevisionSnapshot: async () => ({
          revision: 'b'.repeat(40),
          workflowContent: null,
        }),
      },
      captureDiff: async () => ({
        diff: 'x',
        filesTouched: ['WORKFLOW.md'],
        diffSummary: '1 file',
        compareBase: 'main',
      }),
      commandRunner: async (command) => {
        ran.push(command);
        return { exitCode: 0, output: 'ok' };
      },
      commitState: async () => BASE,
      resolveHead: async () => BASE,
      readCandidateFileAt: async () => validWorkflow,
    });
    const packet = await verifier.verify(bootstrapTask, incompleteRepo, workspace);
    expect(packet.gates.find((g) => g.name === 'workflow-bootstrap')).toMatchObject({
      passed: false,
    });
    expect(packet.green).toBe(false);
    expect(ran).toEqual([]);
  });

  it('fails an eligible bootstrap with no workflow diff', async () => {
    const verifier = new WorktreeVerifier({
      workspaces: {
        readWorkflow: async () => null,
        readTrustedDefaultRevisionSnapshot: async () => ({
          revision: BASE,
          workflowContent: null,
        }),
      },
      captureDiff: async () => ({
        diff: '',
        filesTouched: [],
        diffSummary: 'no changes',
        compareBase: 'main',
      }),
      commandRunner: pass,
      commitState: async () => BASE,
      resolveHead: async () => BASE,
      readCandidateFileAt: async () => validWorkflow,
    });
    const packet = await verifier.verify(bootstrapTask, incompleteRepo, workspace);
    expect(packet.gates.find((g) => g.name === 'workflow-bootstrap')).toMatchObject({
      passed: false,
      output: expect.stringMatching(/did not add/),
    });
    expect(packet.green).toBe(false);
  });
});

describe('WorktreeVerifier path-lease scope', () => {
  it('real-git: staged and untracked foreign paths never become a commit or published task ref', async () => {
    const { mkdir, mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { simpleGit } = await import('simple-git');
    const root = await mkdtemp(join(tmpdir(), 'verifier-precommit-scope-'));
    const remote = join(root, 'remote.git');
    const dir = join(root, 'work');
    await mkdir(remote);
    await simpleGit(remote).init(true, { '--initial-branch': 'main' });
    await simpleGit().clone(remote, dir);
    const git = simpleGit(dir);
    await git.addConfig('user.email', 't@h.local');
    await git.addConfig('user.name', 'T');
    await writeFile(join(dir, 'base.txt'), 'base\n');
    await git.add('.');
    await git.commit('base');
    await git.push('origin', 'main');
    const base = (await git.revparse(['HEAD'])).trim();
    await git.checkoutLocalBranch('hercules/T-1');
    await git.push('origin', 'hercules/T-1');
    await writeFile(join(dir, 'src-domain.ts'), 'owned\n');
    await git.add('src-domain.ts');
    await writeFile(join(dir, 'hook-stray.txt'), 'foreign\n');
    const verifier = new WorktreeVerifier({
      workspaces: { readWorkflow: async () => WORKFLOW },
      commandRunner: pass,
    });
    const packet = await verifier.verify(
      { ...scopedTask, affectedPaths: ['src-domain.ts'] },
      repo,
      { ...workspace, dir },
    );
    expect(packet.gates).toContainEqual(expect.objectContaining({
      name: 'path-lease-scope', passed: false,
    }));
    expect((await git.revparse(['HEAD'])).trim()).toBe(base);
    expect((await simpleGit(remote).revparse(['refs/heads/hercules/T-1'])).trim()).toBe(base);
  });

  it('checks the full staged and untracked diff before the initial verified-state commit', async () => {
    const events: string[] = [];
    const verifier = makeVerifier({
      runner: pass,
      captureDiff: async () => {
        events.push('capture');
        return {
          diff: 'foreign staged and untracked bytes',
          filesTouched: ['src/domain/x.ts', 'hook-stray.txt'],
          diffSummary: '2 files changed',
          compareBase: 'main',
        };
      },
      commitState: async () => {
        events.push('commit');
        return 'c'.repeat(40);
      },
    });

    const packet = await verifier.verify(scopedTask, repo, workspace);

    expect(events).toContain('capture');
    expect(events).not.toContain('commit');
    expect(packet.gates).toContainEqual(expect.objectContaining({
      name: 'path-lease-scope',
      passed: false,
    }));
  });

  it('checks the post-auto-rebase diff before the second verified-state commit', async () => {
    const events: string[] = [];
    let captures = 0;
    let driftCalls = 0;
    const verifier = new WorktreeVerifier({
      workspaces: { readWorkflow: async () => WORKFLOW },
      commandRunner: pass,
      autoRebase: true,
      captureDiff: async () => {
        captures += 1;
        events.push(`capture-${captures}`);
        return captures <= 2
          ? { ...diff, filesTouched: ['src/domain/x.ts'] }
          : { ...diff, filesTouched: ['src/domain/x.ts', 'hook-stray.txt'] };
      },
      commitState: async () => {
        events.push('commit');
        return 'c'.repeat(40);
      },
      resolveHead: async () => 'd'.repeat(40),
      detectBaseDrift: async () => {
        driftCalls += 1;
        return {
          defaultBranch: 'main',
          mergeBase: 'a'.repeat(40),
          headSha: 'b'.repeat(40),
          baseSha: 'a'.repeat(40),
          behind: 0,
          ahead: 1,
          status: 'ahead' as const,
          conflictRisk: 'none' as const,
          conflictDetail: null,
          rebaseAttempted: driftCalls === 1,
          rebaseOk: driftCalls === 1 ? true : null,
          rebaseDetail: driftCalls === 1 ? 'rebased' : null,
        };
      },
    });

    const packet = await verifier.verify(scopedTask, repo, workspace);

    expect(events).toEqual(['capture-1', 'commit', 'capture-2', 'capture-3']);
    expect(packet.gates).toContainEqual(expect.objectContaining({
      name: 'path-lease-scope',
      passed: false,
    }));
  });

  it('real-git: a post-rebase hook foreign path blocks the second commit and task ref publication', async () => {
    const { mkdir, mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { simpleGit } = await import('simple-git');
    const root = await mkdtemp(join(tmpdir(), 'verifier-rebase-scope-'));
    const remote = join(root, 'remote.git');
    const seed = join(root, 'seed');
    const dir = join(root, 'work');
    await mkdir(remote);
    await simpleGit(remote).init(true, { '--initial-branch': 'main' });
    await simpleGit().clone(remote, seed);
    const seedGit = simpleGit(seed);
    await seedGit.addConfig('user.email', 't@h.local');
    await seedGit.addConfig('user.name', 'T');
    await writeFile(join(seed, 'base.txt'), 'base\n');
    await seedGit.add('.');
    await seedGit.commit('base');
    await seedGit.push('origin', 'main');
    const base = (await seedGit.revparse(['HEAD'])).trim();
    await simpleGit().clone(remote, dir);
    const git = simpleGit(dir);
    await git.addConfig('user.email', 't@h.local');
    await git.addConfig('user.name', 'T');
    await git.checkoutLocalBranch('hercules/T-1');
    await git.push('origin', 'hercules/T-1');
    await writeFile(join(dir, 'src-domain.ts'), 'owned\n');
    await writeFile(join(seed, 'main-only.txt'), 'advance\n');
    await seedGit.add('.');
    await seedGit.commit('advance main');
    await seedGit.push('origin', 'main');
    await git.fetch('origin', 'main:main');
    let driftCalls = 0;
    const verifier = new WorktreeVerifier({
      workspaces: { readWorkflow: async () => WORKFLOW },
      commandRunner: pass,
      autoRebase: true,
      detectBaseDrift: async (_worktree, _branch, opts) => {
        driftCalls += 1;
        if (opts.autoRebase) {
          await git.raw(['rebase', 'main']);
          // Fault-injection seam: model a post-rewrite hook/filter that leaves
          // foreign bytes only after the real rebase completed.
          await writeFile(join(dir, 'hook-stray.txt'), 'foreign\n');
        }
        return {
          defaultBranch: 'main',
          mergeBase: (await git.raw(['merge-base', 'main', 'HEAD'])).trim(),
          headSha: (await git.revparse(['HEAD'])).trim(),
          baseSha: (await git.revparse(['main'])).trim(),
          behind: 0,
          ahead: 1,
          status: 'ahead' as const,
          conflictRisk: 'none' as const,
          conflictDetail: null,
          rebaseAttempted: driftCalls === 1,
          rebaseOk: driftCalls === 1 ? true : null,
          rebaseDetail: driftCalls === 1 ? 'rebased with injected foreign path' : null,
        };
      },
    });
    const packet = await verifier.verify(
      { ...scopedTask, affectedPaths: ['src-domain.ts'] },
      repo,
      { ...workspace, dir },
    );
    expect(packet.gates).toContainEqual(expect.objectContaining({
      name: 'path-lease-scope', passed: false,
    }));
    expect((await git.raw(['log', '-1', '--format=%s'])).trim()).toContain('auto-commit at L1');
    expect(Number((await git.raw(['rev-list', '--count', 'main..HEAD'])).trim())).toBe(1);
    expect((await simpleGit(remote).revparse(['refs/heads/hercules/T-1'])).trim()).toBe(base);
  });

  it('fails when actual diff escapes declared affected_paths', async () => {
    const outOfScopeDiff: WorktreeDiff = {
      diff: 'diff --git a/README.md b/README.md\n+x',
      filesTouched: ['src/domain/x.ts', 'README.md'],
      diffSummary: '2 files changed',
      compareBase: 'main',
    };
    const verifier = makeVerifier({
      runner: pass,
      captureDiff: async () => outOfScopeDiff,
    });
    const packet = await verifier.verify(scopedTask, repo, workspace);
    const gate = packet.gates.find((g) => g.name === 'path-lease-scope');
    expect(gate?.passed).toBe(false);
    expect(gate?.output).toMatch(/README\.md/);
    expect(packet.green).toBe(false);
  });

  it('escapes newline filenames in verifier gate evidence', async () => {
    const verifier = makeVerifier({
      runner: pass,
      captureDiff: async () => ({
        diff: 'hostile filename',
        filesTouched: ['evil\n## injected.md'],
        diffSummary: '1 file changed',
        compareBase: 'main',
      }),
    });
    const packet = await verifier.verify(scopedTask, repo, workspace);
    const output = packet.gates.find((gate) => gate.name === 'path-lease-scope')?.output ?? '';
    expect(output).toContain('"evil\\n## injected.md"');
    expect(output).not.toContain('\n');
  });

  it('passes when all touched files stay inside declared scopes', async () => {
    const inScope: WorktreeDiff = {
      diff: 'diff --git a/src/domain/x.ts b/src/domain/x.ts\n+x',
      filesTouched: ['src/domain/x.ts'],
      diffSummary: '1 file changed',
      compareBase: 'main',
    };
    const verifier = makeVerifier({
      runner: pass,
      captureDiff: async () => inScope,
    });
    const packet = await verifier.verify(scopedTask, repo, workspace);
    expect(packet.gates.find((g) => g.name === 'path-lease-scope')).toBeUndefined();
  });
});

describe('WorktreeVerifier base drift', () => {
  const currentDrift = {
    defaultBranch: 'main',
    mergeBase: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    behind: 0,
    ahead: 1,
    status: 'ahead' as const,
    conflictRisk: 'none' as const,
    conflictDetail: null,
    rebaseAttempted: false,
    rebaseOk: null as boolean | null,
    rebaseDetail: null as string | null,
  };

  it('attaches a base-drift report to the packet when the branch is behind', async () => {
    const behind = {
      ...currentDrift,
      behind: 2,
      ahead: 1,
      status: 'diverged' as const,
      baseSha: 'cccccccccccccccccccccccccccccccccccccccc',
    };
    const verifier = new WorktreeVerifier({
      workspaces: { readWorkflow: async () => WORKFLOW },
      captureDiff: async () => diff,
      commandRunner: pass,
      detectBaseDrift: async () => behind,
    });
    const packet = await verifier.verify(task, repo, workspace);
    expect(packet.baseDrift?.behind).toBe(2);
    expect(packet.baseDrift?.conflictRisk).toBe('none');
    expect(packet.gates.some((g) => g.name === 'base-drift')).toBe(false);
  });

  it('adds a failing base-drift gate when conflict risk is hard', async () => {
    const conflict = {
      ...currentDrift,
      behind: 1,
      ahead: 1,
      status: 'diverged' as const,
      conflictRisk: 'conflict' as const,
      conflictDetail: 'CONFLICT (content): Merge conflict in a.txt',
    };
    const verifier = new WorktreeVerifier({
      workspaces: { readWorkflow: async () => WORKFLOW },
      captureDiff: async () => diff,
      commandRunner: pass,
      detectBaseDrift: async () => conflict,
    });
    const packet = await verifier.verify(task, repo, workspace);
    expect(packet.gates.some((g) => g.name === 'base-drift' && !g.passed)).toBe(true);
    expect(packet.green).toBe(false);
    expect(packet.autoRework).toBe(true);
  });

  it('optional auto-rebase path re-runs L1 after a successful rebase', async () => {
    let gateRuns = 0;
    const runner: CommandRunner = async () => {
      gateRuns += 1;
      return { exitCode: 0, output: 'ok' };
    };
    let driftCalls = 0;
    const verifier = new WorktreeVerifier({
      workspaces: { readWorkflow: async () => WORKFLOW },
      captureDiff: async () => diff,
      commandRunner: runner,
      autoRebase: true,
      detectBaseDrift: async (_dir, _branch, opts) => {
        driftCalls += 1;
        if (opts.autoRebase) {
          // First call: behind, rebase succeeds → re-detect with autoRebase false.
          return {
            ...currentDrift,
            behind: 0,
            ahead: 1,
            status: 'ahead' as const,
            rebaseAttempted: true,
            rebaseOk: true,
            rebaseDetail: 'rebased onto main (deadbeef)',
          };
        }
        return {
          ...currentDrift,
          behind: 0,
          ahead: 1,
          status: 'ahead' as const,
          rebaseAttempted: false,
          rebaseOk: null,
          rebaseDetail: null,
        };
      },
    });
    const packet = await verifier.verify(task, repo, workspace);
    expect(driftCalls).toBeGreaterThanOrEqual(2);
    expect(gateRuns).toBeGreaterThanOrEqual(1); // L1 after rebase
    expect(packet.baseDrift?.rebaseAttempted).toBe(true);
    expect(packet.baseDrift?.rebaseOk).toBe(true);
    expect(packet.baseDrift?.rebaseDetail).toMatch(/rebased onto main/);
  });
});

describe('WorktreeVerifier', () => {
  it('reads WORKFLOW, runs gates, scans the diff, and builds a packet', async () => {
    const packet = await makeVerifier({ runner: pass }).verify(task, repo, workspace);
    // Repo never declared L2 → a warning, NOT a phantom passing gate row
    // (a green ✅ behavioral meaning "nothing verified" — fixed 2026-07-25).
    expect(packet.gates.map((g) => g.name)).toEqual(['test']);
    expect(packet.dod.warnings.join(' ')).toMatch(/未声明|not declared/i);
    expect(packet.gates[0]!.passed).toBe(true);
    expect(packet.filesTouched).toEqual(['src/x.ts']);
    expect(packet.branch).toBe('hercules/T-1');
  });

  it('runs held_out_smoke as an L1 gate (G2)', async () => {
    const WF = `---
gates:
  test: pnpm test
held_out_smoke: pnpm test:smoke
protected_paths:
  - test/smoke/**
---
x`;
    const ran: string[] = [];
    const runner: CommandRunner = async (cmd) => {
      ran.push(cmd);
      return { exitCode: 0, output: 'ok' };
    };
    const verifier = new WorktreeVerifier({
      workspaces: { readWorkflow: async () => WF },
      captureDiff: async () => diff,
      commandRunner: runner,
    });
    const packet = await verifier.verify(task, repo, workspace);
    expect(ran).toContain('pnpm test:smoke');
    expect(packet.gates.map((g) => g.name)).toEqual(['test', 'held-out-smoke']);
    expect(packet.dod.warnings.join(' ')).toMatch(/未声明|not declared/i);
    expect(packet.gates.every((g) => g.passed)).toBe(true);
  });

  it('carries the agent activity log into the packet', async () => {
    const activity = ['Edit src/x.ts', 'Bash: pnpm test'];
    const packet = await makeVerifier({ runner: pass }).verify(task, repo, workspace, activity);
    expect(packet.activityLog).toEqual(activity);
  });

  it("sources the self-assessment from the agent's final report, not the task file", async () => {
    const finalReport = '# Result\n\nAdded the helper.\n\n## Self-assessment\n- [x] works — test/x\nResult: PASS';
    const packet = await makeVerifier({ runner: pass }).verify(
      task,
      repo,
      workspace,
      [],
      undefined,
      finalReport,
    );
    // The assessment fills the dedicated slot; the report keeps only the narrative.
    expect(packet.selfAssessment).toContain('Result: PASS');
    expect(packet.finalReport).toBe('# Result\n\nAdded the helper.');
    expect(packet.finalReport).not.toContain('Self-assessment');
  });

  it('marks the self-assessment absent when the agent gave no final report', async () => {
    const packet = await makeVerifier({ runner: pass }).verify(task, repo, workspace);
    expect(packet.selfAssessment).toBe('(agent provided none)');
    expect(packet.finalReport).toBe('');
  });

  it('is green only when gates pass AND a reviewer approves', async () => {
    const reviewer = new Reviewer(async () => 'VERDICT: approved\nSUMMARY: ok');
    const packet = await makeVerifier({ runner: pass, reviewer }).verify(task, repo, workspace);
    expect(packet.green).toBe(true);
  });

  it('skips the reviewer when a gate fails', async () => {
    let reviewed = false;
    const reviewer = new Reviewer(async () => {
      reviewed = true;
      return 'VERDICT: approved';
    });
    const packet = await makeVerifier({ runner: fail, reviewer }).verify(task, repo, workspace);
    expect(reviewed).toBe(false);
    expect(packet.green).toBe(false);
  });

  it('trunk-inherited held-out fail → no auto-rework (merge-base attribution)', async () => {
    const { classifyGateFailAttribution } = await import(
      '../../src/domain/gateFailAttribution.js'
    );
    const heldOutFail: CommandRunner = async () => ({
      exitCode: 1,
      output: `
failures:
    structural_guards::expected_mcp_pseudo_tool_count

test result: FAILED.
`,
    });
    const workflow = `---
gates:
  test: pnpm test
held_out_smoke: cargo test -p guards
---
principles
`;
    // Fail-fast: setup none, test passes, held-out fails — order is install + gates + held-out.
    // With only test + held_out, first gate is test; make test pass then held-out fail.
    let n = 0;
    const runner: CommandRunner = async (cmd) => {
      n += 1;
      if (cmd.includes('cargo') || cmd.includes('guards') || n > 1) {
        return heldOutFail(cmd, '/tmp');
      }
      return { exitCode: 0, output: 'ok' };
    };
    const attr = classifyGateFailAttribution({
      gateName: 'held-out-smoke',
      originalCommand: 'cargo test -p guards',
      mergeBase: '7dbb9a39aabb',
      failedTests: ['structural_guards::expected_mcp_pseudo_tool_count'],
      baseResults: [
        {
          testId: 'structural_guards::expected_mcp_pseudo_tool_count',
          failedOnBase: true,
          fromCache: false,
        },
      ],
      filesTouched: ['src/web/App.tsx'],
      rerunCommand: 'cargo test structural_guards::expected_mcp_pseudo_tool_count -- --exact',
    });
    const verifier = new WorktreeVerifier({
      workspaces: { readWorkflow: async () => workflow },
      captureDiff: async () => diff,
      commandRunner: runner,
      detectBaseDrift: async () => ({
        defaultBranch: 'main',
        mergeBase: '7dbb9a39aabb',
        headSha: 'bbbbbbbbbbbb',
        baseSha: '7dbb9a39aabb',
        behind: 0,
        ahead: 1,
        status: 'ahead',
        conflictRisk: 'none',
        conflictDetail: null,
        rebaseAttempted: false,
        rebaseOk: null,
        rebaseDetail: null,
      }),
      attributeGateFail: async () => attr,
    });
    const packet = await verifier.verify(task, repo, workspace);
    expect(packet.gateFailAttribution?.outcome).toBe('trunk_inherited');
    expect(packet.autoRework).toBe(false);
    expect(packet.dod.mechanical).toBe('skipped');
    expect(packet.green).toBe(false);
  });


  it('fails pr-mergeable + auto-reworks when open PR is still CONFLICTING', async () => {
    const openPrTask: Task = {
      ...task,
      prUrl: 'https://github.com/example-org/acme/pull/6',
      prStatus: 'open',
    };
    const emptyDiff: WorktreeDiff = {
      diff: '',
      filesTouched: [],
      diffSummary: 'no changes',
      compareBase: 'main',
    };
    const packet = await makeVerifier({
      runner: pass,
      captureDiff: async () => emptyDiff,
      fetchPrSummary: async () => ({
        prUrl: openPrTask.prUrl!,
        state: 'OPEN',
        mergeable: 'CONFLICTING',
        reviewDecision: null,
        ciStatus: 'unknown',
        ciSummary: '',
        commentCount: 0,
        reviewCount: 0,
        title: 'settings-build',
        mergeCommitSha: null,
      }),
    }).verify(openPrTask, repo, workspace);

    const gate = packet.gates.find((g) => g.name === 'pr-mergeable');
    expect(gate?.passed).toBe(false);
    expect(packet.green).toBe(false);
    expect(packet.autoRework).toBe(true);
  });

  it('records pr-mergeable pass when open PR is MERGEABLE', async () => {
    const openPrTask: Task = {
      ...task,
      prUrl: 'https://github.com/example-org/acme/pull/6',
      prStatus: 'open',
    };
    const packet = await makeVerifier({
      runner: pass,
      fetchPrSummary: async () => ({
        prUrl: openPrTask.prUrl!,
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        reviewDecision: null,
        ciStatus: 'success',
        ciSummary: 'ok',
        commentCount: 0,
        reviewCount: 0,
        title: 'settings-build',
        mergeCommitSha: null,
      }),
    }).verify(openPrTask, repo, workspace);

    const gate = packet.gates.find((g) => g.name === 'pr-mergeable');
    expect(gate?.passed).toBe(true);
  });

  it('rejects a wrong-repository task PR before verifier gh invocation', async () => {
    const wrong: Task = {
      ...task,
      prUrl: 'https://github.com/evil/other/pull/6',
      prStatus: 'open',
    };
    const githubRepo: RepoConfig = {
      ...repo,
      url: 'https://github.com/example-org/acme.git',
    };
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push([...args]);
      return { exitCode: 1, stdout: '', stderr: 'must not run' };
    };

    const packet = await makeVerifier({ runner: pass, gh }).verify(
      wrong,
      githubRepo,
      workspace,
    );

    expect(calls).toEqual([]);
    expect(packet.gates.some((gate) => gate.name === 'pr-mergeable')).toBe(false);
  });

  it('uses the bound identity validator on the verifier mergeability path', async () => {
    const openPrTask: Task = {
      ...task,
      prUrl: 'https://github.com/example-org/acme/pull/6',
      prStatus: 'open',
    };
    const githubRepo: RepoConfig = {
      ...repo,
      url: 'https://github.com/example-org/acme.git',
    };
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push([...args]);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          url: openPrTask.prUrl,
          baseRefName: 'main',
          headRefName: 'hercules/T-1',
          state: 'OPEN',
          mergeable: 'MERGEABLE',
          comments: [],
          reviews: [],
          statusCheckRollup: [],
        }),
        stderr: '',
      };
    };

    const packet = await makeVerifier({ runner: pass, gh }).verify(
      openPrTask,
      githubRepo,
      workspace,
    );

    expect(packet.gates.find((gate) => gate.name === 'pr-mergeable')?.passed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.at(-1)).toContain('url,baseRefName,headRefName');
  });

  it('soft-skips pr-mergeable when identity preflight rejects wrong head (no false gate)', async () => {
    const openPrTask: Task = {
      ...task,
      prUrl: 'https://github.com/example-org/acme/pull/6',
      prStatus: 'open',
    };
    const githubRepo: RepoConfig = {
      ...repo,
      url: 'https://github.com/example-org/acme.git',
    };
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push([...args]);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          url: openPrTask.prUrl,
          baseRefName: 'main',
          headRefName: 'hercules/OTHER',
          state: 'OPEN',
          mergeable: 'CONFLICTING',
          comments: [],
          reviews: [],
          statusCheckRollup: [],
        }),
        stderr: '',
      };
    };
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const packet = await makeVerifier({ runner: pass, gh }).verify(
      openPrTask,
      githubRepo,
      workspace,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 2)).toEqual(['pr', 'view']);
    expect(packet.gates.some((gate) => gate.name === 'pr-mergeable')).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/pr-mergeable probe failed/i));
    log.mockRestore();
  });

  it('handles a repo with no WORKFLOW.md (no gates — only the soft L2-not-declared WARN)', async () => {
    const packet = await makeVerifier({ runner: pass, workflow: null }).verify(task, repo, workspace);
    expect(packet.gates.map((g) => `${g.name}:${g.passed}`)).toEqual([]);
    expect(packet.dod.warnings.join(' ')).toMatch(/未声明|not declared/i);
    // No L1 gates ⇒ mechanical can pass; no L3 runner with a real diff ⇒ reviewer skipped.
    expect(packet.dod.mechanical).toBe('pass');
    expect(packet.dod.reviewer).toBe('skipped');
    expect(packet.dod.human).toBe('pending');
    expect(packet.green).toBe(false);
  });

  it('runs behavioral verification when configured and gates pass, attaching screenshots', async () => {
    const WF = `---
behavioral:
  base_url: http://localhost:{port}
  capture:
    - screenshot
setup:
  boot:
    - pnpm dev --port {port}
gates:
  test: pnpm test
---
be careful`;
    const seen: { baseUrl: string; bootCommands: readonly string[]; captures: number }[] = [];
    const verifier = new WorktreeVerifier({
      workspaces: { readWorkflow: async () => WF },
      captureDiff: async () => diff,
      commandRunner: pass,
      behavioral: {
        run: async (i) => {
          seen.push({ baseUrl: i.baseUrl, bootCommands: i.bootCommands, captures: i.captures });
          return { screenshots: ['/ws/T-1/.scratch/evidence-0.png'], healthy: true };
        },
      },
    });
    const packet = await verifier.verify(task, repo, workspace);

    expect(seen[0]!.baseUrl).toBe('http://localhost:4000'); // {port} substituted
    expect(seen[0]!.bootCommands).toEqual(['pnpm dev --port 4000']);
    expect(packet.screenshots).toEqual(['/ws/T-1/.scratch/evidence-0.png']);
  });

  it('flags cross-task commits as a review-severity finding (provenance, not just content)', async () => {
    // R3 carried failed R2's cherry-picked commits and nothing surfaced it —
    // the operator found out via git archaeology (2026-07-22). The packet must
    // say so; reviewer scrutinizes; not auto-rework (a re-dispatch cannot
    // un-need the dependency).
    const foreignDiff: WorktreeDiff = { ...diff, foreignTaskIds: ['R2'] };
    const reviewer = new Reviewer(async () => 'VERDICT: approved\nSUMMARY: ok');
    const packet = await makeVerifier({
      runner: pass, reviewer, captureDiff: async () => foreignDiff,
    }).verify(task, repo, workspace);
    const finding = packet.cheatFindings.find((f) => f.kind === 'cross-task-commits');
    expect(finding).toBeDefined();
    expect(finding!.detail).toContain('R2');
    expect(packet.autoRework).toBe(false);
    expect(packet.green).toBe(true); // amber scrutiny, not a hard fail
  });

  it('is NOT green when WORKFLOW declares behavioral but no runner is available (fail-open fix)', async () => {
    // The "no Chromium on the box" case: workflow.behavioral is declared, gates
    // green, reviewer approves — but deps.behavioral is undefined so L2 never
    // runs. Must be non-green + carry a behavioral gate row, not a false green.
    const WF = `---\nbehavioral:\n  base_url: http://x\n  capture: [screenshot]\ngates:\n  test: pnpm test\n---\nx`;
    const reviewer = new Reviewer(async () => 'VERDICT: approved\nSUMMARY: ok');
    const verifier = new WorktreeVerifier({
      workspaces: { readWorkflow: async () => WF },
      captureDiff: async () => diff,
      commandRunner: pass,
      reviewer,
      // no behavioral runner → L2 cannot run
    });
    const packet = await verifier.verify(task, repo, workspace);
    expect(packet.green).toBe(false);
    expect(packet.autoRework).toBe(false); // env/config, not agent-fixable
    expect(packet.gates.some((g) => g.name === 'behavioral' && !g.passed)).toBe(true);
  });

  it('skips behavioral when a gate fails', async () => {
    const WF = `---\nbehavioral:\n  base_url: http://x\n  capture: [screenshot]\ngates:\n  test: pnpm test\n---\nx`;
    let ran = false;
    const verifier = new WorktreeVerifier({
      workspaces: { readWorkflow: async () => WF },
      captureDiff: async () => diff,
      commandRunner: fail,
      behavioral: { run: async () => { ran = true; return { screenshots: [], healthy: false }; } },
    });
    const packet = await verifier.verify(task, repo, workspace);
    expect(ran).toBe(false);
    expect(packet.screenshots).toEqual([]);
  });

  it('skips behavioral when the agent changed nothing (empty diff)', async () => {
    const WF = `---\nbehavioral:\n  base_url: http://x\n  capture: [screenshot]\ngates:\n  test: pnpm test\n---\nx`;
    const emptyDiff: WorktreeDiff = { diff: '', filesTouched: [], diffSummary: 'no changes' , compareBase: 'main' };
    let ran = false;
    const verifier = new WorktreeVerifier({
      workspaces: { readWorkflow: async () => WF },
      captureDiff: async () => emptyDiff,
      commandRunner: pass, // gates pass, but there is nothing to verify
      behavioral: { run: async () => { ran = true; return { screenshots: [], healthy: false }; } },
    });
    // Mark no-diff-ok so this test isolates behavioral skip, not delivery fail.
    const t = { ...task, body: `${task.body}\n\n<!-- hercules:no-diff-ok -->` };
    const packet = await verifier.verify(t, repo, workspace);
    expect(ran).toBe(false);
    expect(packet.noChanges).toBe(true);
    expect(packet.screenshots).toEqual([]);
  });

  it('short-circuits L1 gates when the agent changed no files (read-only / Q&A)', async () => {
    const emptyDiff: WorktreeDiff = { diff: '', filesTouched: [], diffSummary: 'no changes' , compareBase: 'main' };
    let ran = 0;
    const runner: CommandRunner = async () => {
      ran += 1;
      return { exitCode: 0, output: 'ok' };
    };
    const verifier = new WorktreeVerifier({
      workspaces: { readWorkflow: async () => WORKFLOW },
      captureDiff: async () => emptyDiff,
      commandRunner: runner,
    });
    const t = {
      ...task,
      title: '分析一下',
      body: '调研 only <!-- hercules:no-diff-ok -->',
    };
    const packet = await verifier.verify(t, repo, workspace);
    expect(ran).toBe(0); // no shell gates
    expect(packet.noChanges).toBe(true);
    // skipped structure gates + no delivery fail for no-diff-ok
    expect(packet.gates.every((g) => g.passed || g.name === 'delivery')).toBe(true);
    expect(packet.gates.some((g) => /skipped: no file changes/i.test(g.output))).toBe(true);
    expect(
      packet.gates.filter((g) => g.name !== 'delivery').every((g) => g.outcome === 'skipped'),
    ).toBe(true);
    expect(packet.autoRework).toBe(false);
  });

  it('delivery-fails implementer empty-diff feature tasks (system honesty)', async () => {
    const emptyDiff: WorktreeDiff = { diff: '', filesTouched: [], diffSummary: 'no changes' , compareBase: 'main' };
    const verifier = new WorktreeVerifier({
      workspaces: { readWorkflow: async () => WORKFLOW },
      captureDiff: async () => emptyDiff,
      commandRunner: pass,
    });
    const t = {
      ...task,
      title: 'Logout页面改成设置页面',
      body: '页面里面加几个功能：语言（中/英）、默认agent、Logout',
    };
    const packet = await verifier.verify(t, repo, workspace, {
      finalReport: '设置页已上线：底部设置可切换语言',
      runKind: 'implementer',
    });
    expect(packet.noChanges).toBe(true);
    expect(packet.autoRework).toBe(true);
    expect(packet.dod.mechanical).toBe('fail');
    expect(packet.gates.some((g) => g.name === 'delivery' && !g.passed)).toBe(true);
  });
});

describe('WorktreeVerifier C3.38 evidence wiring', () => {
  const HASH_A =
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const HASH_B =
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const BEHAVIORAL_WF = `---
behavioral:
  base_url: http://localhost:{port}
  capture:
    - screenshot
setup:
  boot:
    - echo boot
gates:
  test: pnpm test
---
principles`;

  function screenshotEvidenceRun(
    shots: readonly {
      readonly name: string;
      readonly sha256?: string;
    }[],
  ) {
    return {
      plan: {
        source: 'workflow' as const,
        steps: shots.map((s) => ({
          kind: 'screenshot' as const,
          name: s.name,
          raw: `screenshot ${s.name}`,
        })),
      },
      results: shots.map((s) => ({
        step: {
          kind: 'screenshot' as const,
          name: s.name,
          raw: `screenshot ${s.name}`,
        },
        ok: true,
        detail: `wrote ${s.name}.png`,
        screenshot: `${s.name}.png`,
        ...(s.sha256 !== undefined ? { screenshotSha256: s.sha256 } : {}),
      })),
      ok: true,
      screenshots: shots.map((s) => `${s.name}.png`),
    };
  }

  it('maps screenshotSha256 into packet steps; identical digests fail behavioural via hollow-evidence', async () => {
    const verifier = new WorktreeVerifier({
      workspaces: { readWorkflow: async () => BEHAVIORAL_WF },
      captureDiff: async () => diff,
      commandRunner: pass,
      behavioral: {
        run: async () => ({
          screenshots: ['login.png', 'settings.png'],
          healthy: true,
          evidenceRun: screenshotEvidenceRun([
            { name: 'login', sha256: HASH_A },
            { name: 'settings', sha256: HASH_A },
          ]),
        }),
      },
    });
    const packet = await verifier.verify(task, repo, workspace);

    expect(packet.evidenceRun?.steps.map((s) => s.screenshotSha256)).toEqual([
      HASH_A,
      HASH_A,
    ]);
    expect(packet.cheatFindings.some((f) => f.kind === 'hollow-evidence')).toBe(true);
    expect(packet.evidenceRun?.ok).toBe(false);
    expect(packet.dod.mechanical).toBe('fail');
    expect(packet.autoRework).toBe(true);
  });

  it('distinct screenshot digests leave behavioural axis unchanged (no hollow-evidence)', async () => {
    const verifier = new WorktreeVerifier({
      workspaces: { readWorkflow: async () => BEHAVIORAL_WF },
      captureDiff: async () => diff,
      commandRunner: pass,
      behavioral: {
        run: async () => ({
          screenshots: ['login.png', 'settings.png'],
          healthy: true,
          evidenceRun: screenshotEvidenceRun([
            { name: 'login', sha256: HASH_A },
            { name: 'settings', sha256: HASH_B },
          ]),
        }),
      },
    });
    const packet = await verifier.verify(task, repo, workspace);

    expect(packet.evidenceRun?.steps.map((s) => s.screenshotSha256)).toEqual([
      HASH_A,
      HASH_B,
    ]);
    expect(packet.cheatFindings.some((f) => f.kind === 'hollow-evidence')).toBe(false);
    expect(packet.evidenceRun?.ok).toBe(true);
    expect(packet.dod.mechanical).not.toBe('fail');
  });

  it('drops non-64-hex screenshotSha256 from packet steps', async () => {
    const verifier = new WorktreeVerifier({
      workspaces: { readWorkflow: async () => BEHAVIORAL_WF },
      captureDiff: async () => diff,
      commandRunner: pass,
      behavioral: {
        run: async () => ({
          screenshots: ['login.png'],
          healthy: true,
          evidenceRun: screenshotEvidenceRun([
            { name: 'login', sha256: 'not-a-digest' },
          ]),
        }),
      },
    });
    const packet = await verifier.verify(task, repo, workspace);
    expect(packet.evidenceRun?.steps[0]?.screenshotSha256).toBeUndefined();
  });

  it('observes @test:path#title via worktree package.json scripts when gate output omits the path', async () => {
    const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'hercules-pkg-scripts-'));
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'app',
        scripts: {
          test: 'node --test webapp/tests/x.test.mjs',
        },
      }),
    );
    await mkdir(join(dir, 'webapp', 'tests'), { recursive: true });
    const testSrc = 'test("covers the unit", () => {});\n';
    await writeFile(join(dir, 'webapp', 'tests', 'x.test.mjs'), testSrc);

    const SHA = 'c'.repeat(40);
    const mechTask: Task = {
      ...task,
      body:
        '## Definition of Done\n' +
        '- [ ] (mechanical) unit coverage @test:webapp/tests/x.test.mjs#covers the unit\n',
    };
    const testDiff: WorktreeDiff = {
      diff:
        'diff --git a/webapp/tests/x.test.mjs b/webapp/tests/x.test.mjs\n' +
        '--- a/webapp/tests/x.test.mjs\n' +
        '+++ b/webapp/tests/x.test.mjs\n' +
        '@@ -0,0 +1 @@\n' +
        '+test("covers the unit", () => {});\n',
      filesTouched: ['webapp/tests/x.test.mjs'],
      diffSummary: '1 file changed',
      compareBase: 'main',
    };
    const verifier = new WorktreeVerifier({
      workspaces: { readWorkflow: async () => WORKFLOW },
      captureDiff: async () => testDiff,
      commandRunner: async () => ({ exitCode: 0, output: 'ok\n' }),
      commitState: async () => SHA,
      resolveHead: async () => SHA,
      readCandidateFileAt: async (_d, _rev, path) => {
        if (path === 'webapp/tests/x.test.mjs') return testSrc;
        if (path === 'package.json') {
          return JSON.stringify({
            scripts: { test: 'node --test webapp/tests/x.test.mjs' },
          });
        }
        return null;
      },
    });
    const packet = await verifier.verify(mechTask, repo, { ...workspace, dir });
    const row = packet.dod.criteria.find((c) => c.kind === 'mechanical');
    expect(row?.status).toBe('pass');
    expect(row?.proof).toMatch(/webapp\/tests\/x\.test\.mjs/);
    expect(packet.dod.unverifiedCriteria ?? []).toEqual([]);
  });

  it('leaves @test:path#title unverified when package.json scripts do not name the file', async () => {
    const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'hercules-pkg-scripts-miss-'));
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'app',
        scripts: {
          test: 'node --test webapp/tests/other.test.mjs',
        },
      }),
    );
    await mkdir(join(dir, 'webapp', 'tests'), { recursive: true });
    const testSrc = 'test("covers the unit", () => {});\n';
    await writeFile(join(dir, 'webapp', 'tests', 'x.test.mjs'), testSrc);

    const SHA = 'd'.repeat(40);
    const mechTask: Task = {
      ...task,
      body:
        '## Definition of Done\n' +
        '- [ ] (mechanical) unit coverage @test:webapp/tests/x.test.mjs#covers the unit\n',
    };
    const testDiff: WorktreeDiff = {
      diff:
        'diff --git a/webapp/tests/x.test.mjs b/webapp/tests/x.test.mjs\n' +
        '--- a/webapp/tests/x.test.mjs\n' +
        '+++ b/webapp/tests/x.test.mjs\n' +
        '@@ -0,0 +1 @@\n' +
        '+test("covers the unit", () => {});\n',
      filesTouched: ['webapp/tests/x.test.mjs'],
      diffSummary: '1 file changed',
      compareBase: 'main',
    };
    const verifier = new WorktreeVerifier({
      workspaces: { readWorkflow: async () => WORKFLOW },
      captureDiff: async () => testDiff,
      commandRunner: async () => ({ exitCode: 0, output: 'ok\n' }),
      commitState: async () => SHA,
      resolveHead: async () => SHA,
      readCandidateFileAt: async (_d, _rev, path) => {
        if (path === 'webapp/tests/x.test.mjs') return testSrc;
        return null;
      },
    });
    const packet = await verifier.verify(mechTask, repo, { ...workspace, dir });
    const row = packet.dod.criteria.find((c) => c.kind === 'mechanical');
    expect(row?.status).toBe('unverified');
    expect(packet.dod.unverifiedCriteria?.length).toBe(1);
  });
});
