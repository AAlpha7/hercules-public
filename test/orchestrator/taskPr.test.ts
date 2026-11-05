import { describe, expect, it, vi } from 'vitest';
import type { RepoConfig } from '../../src/domain/repos.js';
import type { GhRunner } from '../../src/orchestrator/openPr.js';
import {
  closeBoundGithubPr,
  fetchBoundPrBehindProbe,
  fetchBoundPrCiProbe,
  fetchBoundPrComments,
  fetchBoundPrConflictProbe,
  fetchBoundPrDraftProbe,
  fetchBoundPrHeadProbe,
  fetchBoundPrLifecycle,
  fetchBoundPrMergeProbe,
  fetchBoundPrSummary,
  markBoundPrReady,
  mergeBoundFactoryPr,
  rebaseBoundFactoryPr,
  TaskPrIdentityError,
  type TaskPrInput,
} from '../../src/orchestrator/taskPr.js';

const repo: RepoConfig = {
  key: 'app',
  url: 'https://github.com/example-org/acme.git',
  defaultBranch: 'main',
  workflow: 'WORKFLOW.md',
  maxConcurrent: 1,
  adapter: null,
  readiness: 'ready',
};

function input(gh: GhRunner, prUrl = 'https://github.com/example-org/acme/pull/9'): TaskPrInput {
  return { prUrl, taskId: 'T-1', repo, gh };
}

function identity(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: 'https://github.com/example-org/acme/pull/9',
    baseRefName: 'main',
    headRefName: 'hercules/T-1',
    ...over,
  };
}

function trackingGh(
  reply: (args: readonly string[]) => {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  },
): { readonly gh: GhRunner; readonly calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    gh: async (args) => {
      calls.push([...args]);
      return reply(args);
    },
  };
}

describe('task PR identity chokepoint', () => {
  it('rejects wrong-repository URLs before gh on every operation', async () => {
    const tracked = trackingGh(() => ({
      exitCode: 0,
      stdout: JSON.stringify(identity()),
      stderr: '',
    }));
    const wrong = input(tracked.gh, 'https://github.com/evil/other/pull/9');

    await expect(fetchBoundPrSummary(wrong)).rejects.toMatchObject({
      name: 'TaskPrIdentityError',
      reason: 'wrong_repository',
    });
    await expect(fetchBoundPrComments(wrong)).rejects.toBeInstanceOf(TaskPrIdentityError);
    await expect(closeBoundGithubPr(wrong)).rejects.toBeInstanceOf(TaskPrIdentityError);
    await expect(markBoundPrReady(wrong)).rejects.toBeInstanceOf(TaskPrIdentityError);
    await expect(fetchBoundPrMergeProbe(wrong)).rejects.toBeInstanceOf(TaskPrIdentityError);
    await expect(fetchBoundPrHeadProbe(wrong)).rejects.toBeInstanceOf(TaskPrIdentityError);
    await expect(mergeBoundFactoryPr(wrong)).rejects.toBeInstanceOf(TaskPrIdentityError);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(fetchBoundPrLifecycle(wrong)).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/lifecycle skipped.*repository/i));
    log.mockRestore();
    expect(tracked.calls).toEqual([]);
  });

  it.each([
    ['canonical URL', { url: 'https://github.com/example-org/acme/pull/8' }],
    ['default base', { baseRefName: 'release' }],
    ['task head', { headRefName: 'hercules/OTHER' }],
  ])('blocks comment REST and close when %s is wrong', async (_label, over) => {
    const tracked = trackingGh(() => ({
      exitCode: 0,
      stdout: JSON.stringify(identity(over)),
      stderr: '',
    }));

    await expect(fetchBoundPrComments(input(tracked.gh))).rejects.toBeInstanceOf(
      TaskPrIdentityError,
    );
    expect(tracked.calls).toHaveLength(1);
    expect(tracked.calls[0]!.slice(0, 2)).toEqual(['pr', 'view']);
    expect(tracked.calls.some((args) => args[0] === 'api')).toBe(false);

    tracked.calls.length = 0;
    await expect(closeBoundGithubPr(input(tracked.gh))).rejects.toBeInstanceOf(
      TaskPrIdentityError,
    );
    expect(tracked.calls).toHaveLength(1);
    expect(tracked.calls[0]!.slice(0, 2)).toEqual(['pr', 'view']);
    expect(tracked.calls.some((args) => args.includes('close'))).toBe(false);
  });

  it('validates identity and lifecycle in one gh view', async () => {
    const mergeSha = '49e8150346e532312c129a14c1a66c9afecb462b';
    const tracked = trackingGh(() => ({
      exitCode: 0,
      stdout: JSON.stringify(
        identity({ state: 'MERGED', mergeCommit: { oid: mergeSha } }),
      ),
      stderr: '',
    }));

    await expect(fetchBoundPrLifecycle(input(tracked.gh))).resolves.toEqual({
      status: 'merged',
      mergeCommitSha: mergeSha,
    });
    expect(tracked.calls).toHaveLength(1);
    expect(tracked.calls[0]).toContain('url,baseRefName,headRefName,state,mergeCommit');
  });

  it('uses one identity-bearing view for explicit summary', async () => {
    const tracked = trackingGh(() => ({
      exitCode: 0,
      stdout: JSON.stringify(
        identity({
          state: 'OPEN',
          mergeable: 'MERGEABLE',
          reviewDecision: 'APPROVED',
          title: 'safe PR',
          comments: [{ id: 1 }],
          reviews: [{ id: 2 }],
          statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }],
        }),
      ),
      stderr: '',
    }));

    const summary = await fetchBoundPrSummary(input(tracked.gh));
    expect(summary).toMatchObject({
      prUrl: 'https://github.com/example-org/acme/pull/9',
      state: 'OPEN',
      mergeable: 'MERGEABLE',
      commentCount: 1,
      reviewCount: 1,
      ciStatus: 'success',
    });
    expect(tracked.calls).toHaveLength(1);
    expect(tracked.calls[0]!.at(-1)).toContain('url,baseRefName,headRefName');
    expect(tracked.calls[0]!.at(-1)).toContain('statusCheckRollup');
  });

  it('preflights before comment REST calls and before close', async () => {
    const comments = trackingGh((args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return { exitCode: 0, stdout: JSON.stringify(identity()), stderr: '' };
      }
      return { exitCode: 0, stdout: '[]', stderr: '' };
    });
    await fetchBoundPrComments(input(comments.gh));
    expect(comments.calls.map((args) => args.slice(0, 2))).toEqual([
      ['pr', 'view'],
      ['api', 'repos/example-org/acme/issues/9/comments'],
      ['api', 'repos/example-org/acme/pulls/9/reviews'],
      ['api', 'repos/example-org/acme/pulls/9/comments'],
    ]);

    const close = trackingGh((args) => {
      if (args[1] === 'view') {
        return { exitCode: 0, stdout: JSON.stringify(identity()), stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    await expect(closeBoundGithubPr(input(close.gh))).resolves.toMatch(/PR #9 closed/);
    expect(close.calls[0]!.slice(0, 2)).toEqual(['pr', 'view']);
    expect(close.calls[1]!.slice(0, 3)).toEqual(['pr', 'close', '9']);
    expect(close.calls[1]).toContain('--delete-branch');
  });

  it('falls back to close without branch deletion after identity preflight', async () => {
    const close = trackingGh((args) => {
      if (args[1] === 'view') {
        return { exitCode: 0, stdout: JSON.stringify(identity()), stderr: '' };
      }
      if (args.includes('--delete-branch')) {
        return { exitCode: 1, stdout: '', stderr: 'branch deletion denied' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await expect(closeBoundGithubPr(input(close.gh))).resolves.toContain(
      'branch kept: branch deletion denied',
    );
    expect(close.calls.map((args) => args.slice(0, 3))).toEqual([
      ['pr', 'view', '9'],
      ['pr', 'close', '9'],
      ['pr', 'close', '9'],
    ]);
    expect(close.calls[1]).toContain('--delete-branch');
    expect(close.calls[2]).not.toContain('--delete-branch');
  });

  it('lifecycle and summary converge on the same identity-validated merge provenance', async () => {
    const mergeSha = '49e8150346e532312c129a14c1a66c9afecb462b';
    const payload = identity({
      state: 'MERGED',
      mergeable: 'UNKNOWN',
      reviewDecision: null,
      title: 'done',
      comments: [],
      reviews: [],
      statusCheckRollup: [],
      mergeCommit: { oid: mergeSha },
    });
    const tracked = trackingGh(() => ({
      exitCode: 0,
      stdout: JSON.stringify(payload),
      stderr: '',
    }));

    const lifecycle = await fetchBoundPrLifecycle(input(tracked.gh));
    const summary = await fetchBoundPrSummary(input(tracked.gh));

    expect(lifecycle).toEqual({ status: 'merged', mergeCommitSha: mergeSha });
    expect(summary.state.toUpperCase()).toBe('MERGED');
    expect(summary.mergeCommitSha).toBe(mergeSha);
    expect(summary.prUrl).toBe('https://github.com/example-org/acme/pull/9');
    expect(tracked.calls).toHaveLength(2);
    expect(tracked.calls.every((args) => String(args.at(-1)).includes('url,baseRefName,headRefName'))).toBe(
      true,
    );
  });

  it('rejects a gh payload with wrong head before stamping merge provenance', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const tracked = trackingGh(() => ({
      exitCode: 0,
      stdout: JSON.stringify(
        identity({
          headRefName: 'hercules/OTHER',
          state: 'MERGED',
          mergeCommit: { oid: 'a'.repeat(40) },
        }),
      ),
      stderr: '',
    }));

    await expect(fetchBoundPrLifecycle(input(tracked.gh))).resolves.toBeNull();
    await expect(fetchBoundPrSummary(input(tracked.gh))).rejects.toBeInstanceOf(
      TaskPrIdentityError,
    );
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('factory lifecycle accepts a Cursor Cloud head and still rejects wrong repo/base', async () => {
    const mergeSha = '49e8150346e532312c129a14c1a66c9afecb462b';
    const factory = {
      ...input(
        async () => ({
          exitCode: 0,
          stdout: JSON.stringify(
            identity({
              url: 'https://github.com/example-org/acme/pull/41',
              headRefName: 'cursor/cloud-T-factory-abc',
              state: 'MERGED',
              mergeCommit: { oid: mergeSha },
            }),
          ),
          stderr: '',
        }),
        'https://github.com/example-org/acme/pull/41',
      ),
      taskId: 'T-factory',
      remoteFactoryPr: true as const,
    };

    await expect(fetchBoundPrLifecycle(factory)).resolves.toEqual({
      status: 'merged',
      mergeCommitSha: mergeSha,
    });

    const local: TaskPrInput = {
      prUrl: factory.prUrl,
      taskId: factory.taskId,
      repo: factory.repo,
      ...(factory.gh ? { gh: factory.gh } : {}),
    };
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(fetchBoundPrLifecycle(local)).resolves.toBeNull();
    log.mockRestore();

    const wrongRepo = {
      ...factory,
      prUrl: 'https://github.com/evil/other/pull/41',
    };
    await expect(fetchBoundPrLifecycle(wrongRepo)).resolves.toBeNull();
  });

  it('factory conflict probe returns mergeable + Cloud Agent head', async () => {
    const factory = {
      ...input(
        async () => ({
          exitCode: 0,
          stdout: JSON.stringify(
            identity({
              url: 'https://github.com/example-org/acme/pull/41',
              headRefName: 'cursor/cloud-T-factory-abc',
              mergeable: 'CONFLICTING',
            }),
          ),
          stderr: '',
        }),
        'https://github.com/example-org/acme/pull/41',
      ),
      taskId: 'T-factory',
      remoteFactoryPr: true as const,
    };
    await expect(fetchBoundPrConflictProbe(factory)).resolves.toEqual({
      mergeable: 'CONFLICTING',
      headRefName: 'cursor/cloud-T-factory-abc',
    });
  });

  it('factory head probe returns the identity-bound Cloud Agent branch', async () => {
    const factory = {
      ...input(
        async () => ({
          exitCode: 0,
          stdout: JSON.stringify(
            identity({
              url: 'https://github.com/example-org/acme/pull/41',
              headRefName: 'cursor/cloud-T-factory-abc',
            }),
          ),
          stderr: '',
        }),
        'https://github.com/example-org/acme/pull/41',
      ),
      taskId: 'T-factory',
      remoteFactoryPr: true as const,
    };
    await expect(fetchBoundPrHeadProbe(factory)).resolves.toEqual({
      headRefName: 'cursor/cloud-T-factory-abc',
    });
  });

  it('factory CI probe returns red rollup + Cloud Agent head', async () => {
    const factory = {
      ...input(
        async () => ({
          exitCode: 0,
          stdout: JSON.stringify(
            identity({
              url: 'https://github.com/example-org/acme/pull/41',
              headRefName: 'cursor/cloud-T-factory-abc',
              statusCheckRollup: [
                { name: 'CI / gates', conclusion: 'FAILURE', status: 'COMPLETED' },
                { name: 'lint', conclusion: 'SUCCESS', status: 'COMPLETED' },
              ],
            }),
          ),
          stderr: '',
        }),
        'https://github.com/example-org/acme/pull/41',
      ),
      taskId: 'T-factory',
      remoteFactoryPr: true as const,
    };
    await expect(fetchBoundPrCiProbe(factory)).resolves.toEqual({
      ciStatus: 'failure',
      ciSummary: '1 ok · 1 fail · 0 pending (2 checks)',
      failingChecks: ['CI / gates'],
      headRefName: 'cursor/cloud-T-factory-abc',
    });
  });

  it('factory behind probe returns BEHIND + Cloud Agent head + check rollup', async () => {
    const factory = {
      ...input(
        async () => ({
          exitCode: 0,
          stdout: JSON.stringify(
            identity({
              url: 'https://github.com/example-org/acme/pull/41',
              headRefName: 'cursor/cloud-T-factory-abc',
              mergeStateStatus: 'BEHIND',
              statusCheckRollup: [
                { name: 'CI / gates', conclusion: 'SUCCESS', status: 'COMPLETED' },
              ],
            }),
          ),
          stderr: '',
        }),
        'https://github.com/example-org/acme/pull/41',
      ),
      taskId: 'T-factory',
      remoteFactoryPr: true as const,
    };
    await expect(fetchBoundPrBehindProbe(factory)).resolves.toEqual({
      mergeStateStatus: 'BEHIND',
      ciStatus: 'success',
      headRefName: 'cursor/cloud-T-factory-abc',
    });
  });

  it('factory draft probe returns isDraft + mergeStateStatus', async () => {
    const factory = {
      ...input(
        async () => ({
          exitCode: 0,
          stdout: JSON.stringify(
            identity({
              url: 'https://github.com/example-org/acme/pull/41',
              headRefName: 'cursor/cloud-T-factory-abc',
              isDraft: true,
              mergeStateStatus: 'DRAFT',
            }),
          ),
          stderr: '',
        }),
        'https://github.com/example-org/acme/pull/41',
      ),
      taskId: 'T-factory',
      remoteFactoryPr: true as const,
    };
    await expect(fetchBoundPrDraftProbe(factory)).resolves.toEqual({
      isDraft: true,
      mergeStateStatus: 'DRAFT',
    });
  });

  it('markBoundPrReady identity-binds then calls gh pr ready', async () => {
    const tracked = trackingGh((args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            identity({
              url: 'https://github.com/example-org/acme/pull/41',
              headRefName: 'cursor/cloud-T-factory-abc',
              isDraft: true,
            }),
          ),
          stderr: '',
        };
      }
      if (args[0] === 'pr' && args[1] === 'ready') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: 'nope' };
    });
    const factory = {
      ...input(tracked.gh, 'https://github.com/example-org/acme/pull/41'),
      taskId: 'T-factory',
      remoteFactoryPr: true as const,
    };
    await expect(markBoundPrReady(factory)).resolves.toBeUndefined();
    expect(tracked.calls.some((args) => args[0] === 'pr' && args[1] === 'ready')).toBe(true);
    expect(tracked.calls.find((args) => args[0] === 'pr' && args[1] === 'ready')).toEqual([
      'pr',
      'ready',
      '41',
      '--repo',
      'example-org/acme',
    ]);
  });

  it('markBoundPrReady treats already-ready as success', async () => {
    const factory = {
      ...input(
        async (args) => {
          if (args[0] === 'pr' && args[1] === 'view') {
            return {
              exitCode: 0,
              stdout: JSON.stringify(
                identity({
                  url: 'https://github.com/example-org/acme/pull/41',
                  headRefName: 'cursor/cloud-T-factory-abc',
                  isDraft: false,
                }),
              ),
              stderr: '',
            };
          }
          return { exitCode: 1, stdout: '', stderr: 'pull request is not a draft' };
        },
        'https://github.com/example-org/acme/pull/41',
      ),
      taskId: 'T-factory',
      remoteFactoryPr: true as const,
    };
    await expect(markBoundPrReady(factory)).resolves.toBeUndefined();
  });

  it('rebaseBoundFactoryPr identity-binds then calls gh pr rebase', async () => {
    const tracked = trackingGh((args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            identity({
              url: 'https://github.com/example-org/acme/pull/41',
              headRefName: 'cursor/cloud-T-factory-abc',
              mergeable: 'MERGEABLE',
              mergeStateStatus: 'BEHIND',
            }),
          ),
          stderr: '',
        };
      }
      if (args[0] === 'pr' && args[1] === 'rebase') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: 'nope' };
    });
    const factory = {
      ...input(tracked.gh, 'https://github.com/example-org/acme/pull/41'),
      taskId: 'T-factory',
      remoteFactoryPr: true as const,
    };
    await expect(rebaseBoundFactoryPr(factory)).resolves.toBeUndefined();
    expect(tracked.calls.find((args) => args[0] === 'pr' && args[1] === 'rebase')).toEqual([
      'pr',
      'rebase',
      '41',
      '--repo',
      'example-org/acme',
    ]);
    expect(tracked.calls[0]?.[0]).toBe('pr');
    expect(tracked.calls[0]?.[1]).toBe('view');
  });

  it('rebaseBoundFactoryPr treats already-up-to-date as success', async () => {
    const factory = {
      ...input(
        async (args) => {
          if (args[0] === 'pr' && args[1] === 'view') {
            return {
              exitCode: 0,
              stdout: JSON.stringify(
                identity({
                  url: 'https://github.com/example-org/acme/pull/41',
                  headRefName: 'cursor/cloud-T-factory-abc',
                  mergeable: 'MERGEABLE',
                  mergeStateStatus: 'BEHIND',
                }),
              ),
              stderr: '',
            };
          }
          return { exitCode: 1, stdout: '', stderr: 'This pull request is already up-to-date' };
        },
        'https://github.com/example-org/acme/pull/41',
      ),
      taskId: 'T-factory',
      remoteFactoryPr: true as const,
    };
    await expect(rebaseBoundFactoryPr(factory)).resolves.toBeUndefined();
  });

  it('rebaseBoundFactoryPr rejects a wrong-repo URL before gh', async () => {
    const tracked = trackingGh(() => ({ exitCode: 0, stdout: '', stderr: '' }));
    const factory = {
      ...input(tracked.gh, 'https://github.com/evil/other/pull/41'),
      taskId: 'T-factory',
      remoteFactoryPr: true as const,
    };
    await expect(rebaseBoundFactoryPr(factory)).rejects.toBeInstanceOf(TaskPrIdentityError);
    expect(tracked.calls).toEqual([]);
  });

  it('factory merge probe returns draft + mergeable + CLEAN + green rollup', async () => {
    const factory = {
      ...input(
        async () => ({
          exitCode: 0,
          stdout: JSON.stringify(
            identity({
              url: 'https://github.com/example-org/acme/pull/41',
              headRefName: 'cursor/cloud-T-factory-abc',
              isDraft: false,
              mergeable: 'MERGEABLE',
              mergeStateStatus: 'CLEAN',
              statusCheckRollup: [
                { name: 'CI / gates', conclusion: 'SUCCESS', status: 'COMPLETED' },
              ],
            }),
          ),
          stderr: '',
        }),
        'https://github.com/example-org/acme/pull/41',
      ),
      taskId: 'T-factory',
      remoteFactoryPr: true as const,
    };
    await expect(fetchBoundPrMergeProbe(factory)).resolves.toEqual({
      isDraft: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      ciStatus: 'success',
    });
  });

  it('mergeBoundFactoryPr identity-binds then calls gh pr merge --squash', async () => {
    const tracked = trackingGh((args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            identity({
              url: 'https://github.com/example-org/acme/pull/41',
              headRefName: 'cursor/cloud-T-factory-abc',
              isDraft: false,
              mergeable: 'MERGEABLE',
            }),
          ),
          stderr: '',
        };
      }
      if (args[0] === 'pr' && args[1] === 'merge') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: 'nope' };
    });
    const factory = {
      ...input(tracked.gh, 'https://github.com/example-org/acme/pull/41'),
      taskId: 'T-factory',
      remoteFactoryPr: true as const,
    };
    await expect(mergeBoundFactoryPr(factory)).resolves.toBeUndefined();
    expect(tracked.calls.find((args) => args[0] === 'pr' && args[1] === 'merge')).toEqual([
      'pr',
      'merge',
      '41',
      '--repo',
      'example-org/acme',
      '--squash',
    ]);
  });

  it('mergeBoundFactoryPr treats already-merged as success', async () => {
    const factory = {
      ...input(
        async (args) => {
          if (args[0] === 'pr' && args[1] === 'view') {
            return {
              exitCode: 0,
              stdout: JSON.stringify(
                identity({
                  url: 'https://github.com/example-org/acme/pull/41',
                  headRefName: 'cursor/cloud-T-factory-abc',
                  isDraft: false,
                  mergeable: 'MERGEABLE',
                }),
              ),
              stderr: '',
            };
          }
          return { exitCode: 1, stdout: '', stderr: 'Pull request is already merged' };
        },
        'https://github.com/example-org/acme/pull/41',
      ),
      taskId: 'T-factory',
      remoteFactoryPr: true as const,
    };
    await expect(mergeBoundFactoryPr(factory)).resolves.toBeUndefined();
  });
});
