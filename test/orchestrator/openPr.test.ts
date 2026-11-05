import { describe, it, expect, vi } from 'vitest';
import {
  openPullRequest,
  OpenPrError,
  parsePrLifecyclePayload,
  type GhRunner,
} from '../../src/orchestrator/openPr.js';
import {
  githubPrStateToStatus,
  parseGithubMergeCommitSha,
  type Task,
} from '../../src/domain/task.js';
import type { RepoConfig } from '../../src/domain/repos.js';
import { fetchBoundPrLifecycle } from '../../src/orchestrator/taskPr.js';

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'ONBOARD-1',
    title: 'Proof onboarding',
    repo: 'hercules',
    state: 'review',
    priority: 100,
    blockedBy: [],
    labels: [],
    adapter: null,
    agentSession: 's',
    pendingSteer: null,
    attempts: 0,
    lastEventAt: null,
    createdAt: null,
    startedAt: null,
    endedAt: null,
    prUrl: null,
    prStatus: null,
    planPending: false,
    body: '## Review packet\n**Files touched**\n- `docs/x.md`\n',
    ...over,
  };
}

const repo: RepoConfig = {
  key: 'hercules',
  url: 'https://github.com/example-org/acme.git',
  defaultBranch: 'main',
  workflow: 'WORKFLOW.md',
  maxConcurrent: 1,
  adapter: null, readiness: 'ready',
};

function scriptedGh(script: (args: readonly string[]) => { exitCode: number; stdout: string; stderr: string }): GhRunner {
  return async (args) => script(args);
}

describe('openPullRequest', () => {
  it('returns an existing open PR without creating', async () => {
    const gh = scriptedGh((args) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        return {
          exitCode: 0,
          stdout: JSON.stringify([{ url: 'https://github.com/example-org/acme/pull/9' }]),
          stderr: '',
        };
      }
      throw new Error(`unexpected gh ${args.join(' ')}`);
    });
    const r = await openPullRequest({ task: task(), repo, gh });
    expect(r.mode).toBe('existing');
    expect(r.url).toBe('https://github.com/example-org/acme/pull/9');
    expect(r.openUrl).toContain('login?return_to=');
    expect(r.openUrl).toContain(encodeURIComponent(r.url));
    expect(r.branch).toBe('hercules/ONBOARD-1');
  });

  it('creates a PR when none exists', async () => {
    const calls: string[][] = [];
    const gh = scriptedGh((args) => {
      calls.push([...args]);
      if (args[1] === 'list') return { exitCode: 0, stdout: '[]', stderr: '' };
      if (args[1] === 'create') {
        return {
          exitCode: 0,
          stdout: 'https://github.com/example-org/acme/pull/12\n',
          stderr: '',
        };
      }
      throw new Error(`unexpected ${args.join(' ')}`);
    });
    const r = await openPullRequest({ task: task(), repo, gh });
    expect(r.mode).toBe('created');
    expect(r.url).toContain('/pull/12');
    expect(calls.some((c) => c[1] === 'create')).toBe(true);
  });

  it('falls back to a compare URL when create fails but branch is on remote', async () => {
    const gh = scriptedGh((args) => {
      if (args[1] === 'list') return { exitCode: 0, stdout: '[]', stderr: '' };
      if (args[0] === 'api') {
        return { exitCode: 0, stdout: 'refs/heads/hercules/ONBOARD-1\n', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: 'GraphQL: something else' };
    });
    const r = await openPullRequest({ task: task(), repo, gh });
    expect(r.mode).toBe('compare');
    expect(r.url).toContain('compare/main...hercules%2FONBOARD-1');
  });

  it('errors instead of a 404 compare URL when the head branch is missing on GitHub', async () => {
    const gh = scriptedGh((args) => {
      if (args[1] === 'list') return { exitCode: 0, stdout: '[]', stderr: '' };
      if (args[0] === 'api') return { exitCode: 1, stdout: '', stderr: 'Not Found' };
      return { exitCode: 1, stdout: '', stderr: 'GraphQL: Head not found' };
    });
    await expect(openPullRequest({ task: task(), repo, gh })).rejects.toThrow(/not on GitHub/);
  });

  it('rejects no-change packets and non-GitHub remotes', async () => {
    await expect(
      openPullRequest({
        task: task({ body: '**ℹ️ No file changes.** nothing to do' }),
        repo,
        gh: scriptedGh(() => ({ exitCode: 0, stdout: '[]', stderr: '' })),
      }),
    ).rejects.toThrow(OpenPrError);

    await expect(
      openPullRequest({
        task: task(),
        repo: { ...repo, url: 'https://gitlab.com/x/y' },
        gh: scriptedGh(() => ({ exitCode: 0, stdout: '[]', stderr: '' })),
      }),
    ).rejects.toThrow(/not GitHub/);
  });

  it('only allows review or done', async () => {
    await expect(
      openPullRequest({
        task: task({ state: 'todo' }),
        repo,
        gh: scriptedGh(() => ({ exitCode: 0, stdout: '[]', stderr: '' })),
      }),
    ).rejects.toThrow(/review or done/);
  });
});

describe('githubPrStateToStatus / parsePrLifecyclePayload', () => {
  const INCIDENT_SHA = '49e8150346e532312c129a14c1a66c9afecb462b';

  it('maps GitHub state strings', () => {
    expect(githubPrStateToStatus('OPEN')).toBe('open');
    expect(githubPrStateToStatus('merged')).toBe('merged');
    expect(githubPrStateToStatus('Closed')).toBe('closed');
    expect(githubPrStateToStatus('unknown')).toBeNull();
  });

  it('parseGithubMergeCommitSha accepts full oid object and bare string', () => {
    expect(parseGithubMergeCommitSha({ oid: INCIDENT_SHA })).toBe(INCIDENT_SHA);
    expect(parseGithubMergeCommitSha(INCIDENT_SHA)).toBe(INCIDENT_SHA);
  });

  it('parseGithubMergeCommitSha rejects short / malformed / missing', () => {
    expect(parseGithubMergeCommitSha(null)).toBeNull();
    expect(parseGithubMergeCommitSha(undefined)).toBeNull();
    expect(parseGithubMergeCommitSha({ oid: 'abc' })).toBeNull();
    expect(parseGithubMergeCommitSha({ oid: 'g'.repeat(40) })).toBeNull();
    expect(parseGithubMergeCommitSha({ oid: INCIDENT_SHA.slice(0, 7) })).toBeNull();
    expect(parseGithubMergeCommitSha({})).toBeNull();
    expect(parseGithubMergeCommitSha('not-a-sha')).toBeNull();
  });

  it('parsePrLifecyclePayload returns validated merge commit for MERGED', () => {
    expect(
      parsePrLifecyclePayload({
        state: 'MERGED',
        mergeCommit: { oid: INCIDENT_SHA },
      }),
    ).toEqual({ status: 'merged', mergeCommitSha: INCIDENT_SHA });
  });

  it('parsePrLifecyclePayload keeps merged status but null sha when mergeCommit malformed', () => {
    expect(parsePrLifecyclePayload({ state: 'MERGED' })).toEqual({
      status: 'merged',
      mergeCommitSha: null,
    });
    expect(
      parsePrLifecyclePayload({
        state: 'MERGED',
        mergeCommit: { oid: 'deadbeef' },
      }),
    ).toEqual({ status: 'merged', mergeCommitSha: null });
  });

  it('parsePrLifecyclePayload does not attach sha for OPEN/CLOSED', () => {
    expect(
      parsePrLifecyclePayload({
        state: 'OPEN',
        mergeCommit: { oid: INCIDENT_SHA },
      }),
    ).toEqual({ status: 'open', mergeCommitSha: null });
    expect(parsePrLifecyclePayload({ state: 'CLOSED' })).toEqual({
      status: 'closed',
      mergeCommitSha: null,
    });
    expect(parsePrLifecyclePayload({ state: 'unknown' })).toBeNull();
  });

  it('reads lifecycle + mergeCommit from gh pr view', async () => {
    const mergeSha = INCIDENT_SHA;
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push([...args]);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          url: 'https://github.com/example-org/acme/pull/9',
          baseRefName: 'main',
          headRefName: 'hercules/ONBOARD-1',
          state: 'MERGED',
          mergeCommit: { oid: mergeSha },
        }),
        stderr: '',
      };
    };
    const lifecycle = await fetchBoundPrLifecycle({
      prUrl: 'https://github.com/example-org/acme/pull/9',
      taskId: 'ONBOARD-1',
      repo,
      gh,
    });
    expect(lifecycle).toEqual({ status: 'merged', mergeCommitSha: mergeSha });
    expect(calls).toHaveLength(1);
    const firstCall = calls.at(0);
    expect(firstCall).toBeDefined();
    expect(firstCall?.slice(0, 2)).toEqual(['pr', 'view']);
    expect(firstCall).toContain('--json');
    const fields = String(firstCall?.at(-1) ?? '');
    expect(fields).toContain('url,baseRefName,headRefName');
    expect(fields).toContain('state,mergeCommit');
  });

  it('returns null when gh fails (do not clobber status)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push([...args]);
      return { exitCode: 1, stdout: '', stderr: 'gh: Not Found' };
    };
    const lifecycle = await fetchBoundPrLifecycle({
      prUrl: 'https://github.com/example-org/acme/pull/9',
      taskId: 'ONBOARD-1',
      repo,
      gh,
    });
    expect(lifecycle).toBeNull();
    expect(calls).toHaveLength(1);
    const firstCall = calls.at(0);
    expect(firstCall?.slice(0, 2)).toEqual(['pr', 'view']);
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/lifecycle skipped/i),
    );
    log.mockRestore();
  });
});
