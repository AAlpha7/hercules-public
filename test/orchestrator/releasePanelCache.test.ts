/**
 * /api/releases latency (phone report 2026-07-17): every open re-derived
 * per-task git facts (~50 git subprocesses). Those facts are pure functions of
 * (production, staging, merged SHAs) — the service must memoize them and only
 * recompute when the range or the merged-task set changes.
 *
 * 2026-09-02: cold-path also scoped ahead-task briefs and gate ancestry to
 * production..staging, and memoized gateCoveredShas in the same cache entry.
 */
import { describe, it, expect } from 'vitest';
import { ActionService } from '../../src/orchestrator/actions.js';
import type { ControlPort } from '../../src/orchestrator/orchestrator.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import type { Task } from '../../src/domain/task.js';
import type { RepoConfig, ReposConfig } from '../../src/domain/repos.js';
import { emptyRelease, type Release } from '../../src/domain/release.js';
import type { RepoProbe } from '../../src/orchestrator/repoProbe.js';

const MAIN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PROD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OUT1 = 'cccccccccccccccccccccccccccccccccccccccc';
const OUT2 = 'dddddddddddddddddddddddddddddddddddddddd';
const C1 = '1111111111111111111111111111111111111111';
const C2 = '2222222222222222222222222222222222222222';
const GATE_IN = '3333333333333333333333333333333333333333';
const GATE_OUT = '4444444444444444444444444444444444444444';
const TIP_IN = '5555555555555555555555555555555555555555';
const TIP_OUT = '6666666666666666666666666666666666666666';

const WORKFLOW_STAGING = `---
gates:
  typecheck: echo ok
deploy:
  staging:
    command: ./scripts/deploy-staging.sh
    health: curl -sf http://localhost:8788/
    url: http://host:8788/
---
body
`;

function repo(key = 'app'): RepoConfig {
  return {
    key,
    url: 'https://example.com/app.git',
    defaultBranch: 'main',
    workflow: 'WORKFLOW.md',
    maxConcurrent: 1,
    adapter: null,
    readiness: 'ready',
  };
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'One',
    repo: 'app',
    state: 'done',
    priority: 1,
    blockedBy: [],
    labels: [],
    adapter: null,
    agentSession: null,
    pendingSteer: null,
    attempts: 0,
    lastEventAt: null,
    createdAt: null,
    startedAt: null,
    endedAt: null,
    prUrl: null,
    prStatus: null,
    planPending: false,
    body: '',
    ...over,
  };
}

class FakePort implements ControlPort {
  readonly releases = new Map<string, Release>();
  constructor(
    readonly tasks: Map<string, Task>,
    private readonly repos: ReposConfig,
  ) {}
  async sync(): Promise<void> {}
  async read(): Promise<ControlSnapshot> {
    return {
      repos: this.repos,
      tasks: [...this.tasks.values()],
      problems: [],
    };
  }
  async writeTask(t: Task): Promise<void> {
    this.tasks.set(t.id, t);
  }
  async deleteTask(id: string): Promise<void> {
    this.tasks.delete(id);
  }
  async commit(): Promise<{ committed: boolean }> {
    return { committed: true };
  }
  async writeRepos(): Promise<void> {}
  async readRelease(repoKey: string): Promise<Release | null> {
    return this.releases.get(repoKey) ?? null;
  }
  async writeRelease(release: Release): Promise<void> {
    this.releases.set(release.repoKey, release);
  }
}

const probe: RepoProbe = {
  async probe() {
    return { branches: ['main'] };
  },
};

type Counters = {
  brief: number;
  range: number;
  ancestor: number;
};

function build(
  port: FakePort,
  counters: Counters,
  opts: {
    readonly rangeShaSet?: ReadonlySet<string>;
    readonly rangeCommits?: readonly { sha: string; subject: string }[];
  } = {},
) {
  const rangeShaSet = opts.rangeShaSet ?? new Set([MAIN]);
  const rangeCommits = opts.rangeCommits;
  return new ActionService(port, probe, undefined, undefined, undefined, undefined, undefined, {
    workspaces: {
      async readWorkflow() {
        return WORKFLOW_STAGING;
      },
      async defaultBranchHead() {
        return MAIN;
      },
      async rangeShas() {
        counters.range += 1;
        return rangeShaSet;
      },
      async rangeDiff() {
        return { files: ['src/a.ts'], insertions: 1, deletions: 1 };
      },
      async commitDiffBrief() {
        counters.brief += 1;
        return { files: ['src/a.ts'], insertions: 1, deletions: 1, subject: 'feat: a' };
      },
      ...(rangeCommits !== undefined
        ? {
            async rangeCommitList() {
              return rangeCommits;
            },
            async isCommitAncestor(
              _repo: RepoConfig,
              ancestor: string,
              descendant: string,
            ): Promise<boolean | null> {
              counters.ancestor += 1;
              // Cover C1 under the in-range gate tip only.
              return (
                descendant.toLowerCase() === TIP_IN &&
                ancestor.toLowerCase() === C1
              );
            },
          }
        : {}),
    },
    requestStagingDeployNow: () => {},
  });
}

describe('listReleases git-facts memoization', () => {
  it('does not re-run per-task git derivation when range and merged set are unchanged', async () => {
    const port = new FakePort(
      new Map([
        ['t-ahead', task({ id: 't-ahead', title: 'On staging', mergedSha: MAIN })],
      ]),
      { repos: { app: repo('app') } },
    );
    port.releases.set('app', {
      ...emptyRelease('app'),
      productionSha: PROD,
      stagingSha: MAIN,
      stagingStatus: 'ready',
    });
    const counters: Counters = { brief: 0, range: 0, ancestor: 0 };
    const actions = build(port, counters);

    const first = await actions.listReleases();
    expect(first[0]?.aheadTasks.map((t) => t.id)).toEqual(['t-ahead']);
    const afterFirst = { ...counters };
    expect(afterFirst.brief).toBeGreaterThan(0);

    const second = await actions.listReleases();
    expect(second[0]?.aheadTasks.map((t) => t.id)).toEqual(['t-ahead']);
    expect(counters).toEqual(afterFirst);
  });

  it('recomputes when the staging range moves', async () => {
    const port = new FakePort(
      new Map([
        ['t-ahead', task({ id: 't-ahead', title: 'On staging', mergedSha: MAIN })],
      ]),
      { repos: { app: repo('app') } },
    );
    port.releases.set('app', {
      ...emptyRelease('app'),
      productionSha: PROD,
      stagingSha: MAIN,
      stagingStatus: 'ready',
    });
    const counters: Counters = { brief: 0, range: 0, ancestor: 0 };
    const actions = build(port, counters);

    await actions.listReleases();
    const afterFirst = { ...counters };

    const next = 'c'.repeat(40);
    port.releases.set('app', {
      ...emptyRelease('app'),
      productionSha: PROD,
      stagingSha: next,
      stagingStatus: 'ready',
    });
    await actions.listReleases();
    expect(counters.brief).toBeGreaterThan(afterFirst.brief);
  });

  it('scopes commitDiffBrief to tasks whose mergedSha is in rangeShas', async () => {
    const port = new FakePort(
      new Map([
        ['in-range', task({ id: 'in-range', title: 'In range', mergedSha: MAIN })],
        ['out-1', task({ id: 'out-1', title: 'Out 1', mergedSha: OUT1 })],
        ['out-2', task({ id: 'out-2', title: 'Out 2', mergedSha: OUT2 })],
      ]),
      { repos: { app: repo('app') } },
    );
    port.releases.set('app', {
      ...emptyRelease('app'),
      productionSha: PROD,
      stagingSha: MAIN,
      stagingStatus: 'ready',
    });
    const counters: Counters = { brief: 0, range: 0, ancestor: 0 };
    const actions = build(port, counters, { rangeShaSet: new Set([MAIN]) });

    await actions.listReleases();
    expect(counters.brief).toBe(1);
  });

  it('memoizes gateCoveredShas and scopes isCommitAncestor to in-range gate tasks', async () => {
    const port = new FakePort(
      new Map([
        [
          'gate-in',
          task({
            id: 'gate-in',
            title: 'Gate in range',
            mergedSha: GATE_IN,
            verifiedSha: TIP_IN,
            mergedVia: 'gate',
          }),
        ],
        [
          'gate-out',
          task({
            id: 'gate-out',
            title: 'Gate out of range',
            mergedSha: GATE_OUT,
            verifiedSha: TIP_OUT,
            mergedVia: 'gate',
          }),
        ],
      ]),
      { repos: { app: repo('app') } },
    );
    port.releases.set('app', {
      ...emptyRelease('app'),
      productionSha: PROD,
      stagingSha: MAIN,
      stagingStatus: 'ready',
    });
    const counters: Counters = { brief: 0, range: 0, ancestor: 0 };
    const rangeCommits = [
      { sha: C1, subject: 'feat: covered by gate tip' },
      { sha: C2, subject: 'chore: direct operator push' },
    ];
    const actions = build(port, counters, {
      rangeShaSet: new Set([MAIN, C1, C2, GATE_IN]),
      rangeCommits,
    });

    const first = await actions.listReleases();
    expect(counters.ancestor).toBe(2);
    expect(first[0]?.directCommits.map((c) => c.sha)).toEqual([C2]);

    const second = await actions.listReleases();
    expect(counters.ancestor).toBe(2);
    expect(second[0]?.directCommits.map((c) => c.sha)).toEqual(
      first[0]?.directCommits.map((c) => c.sha),
    );
  });

  it('derives afterDeployChecks from previousProduction..production and memoizes live rangeShas', async () => {
    const PROD_PREV = '7777777777777777777777777777777777777777';
    const LIVE = '8888888888888888888888888888888888888888';
    const port = new FakePort(
      new Map([
        [
          't-live',
          task({
            id: 't-live',
            title: 'Live check task',
            mergedSha: LIVE,
            body: `## Definition of Done
- [ ] (human, after deploy) Open /x on the phone
`,
          }),
        ],
      ]),
      { repos: { app: repo('app') } },
    );
    port.releases.set('app', {
      ...emptyRelease('app'),
      productionSha: PROD,
      stagingSha: MAIN,
      stagingStatus: 'ready',
      history: [
        { sha: PROD_PREV, at: '2026-07-16T00:00:00.000Z', outcome: 'ok' },
        { sha: PROD, at: '2026-07-17T00:00:00.000Z', outcome: 'ok' },
      ],
    });

    const rangeCalls: { from: string | null; to: string }[] = [];
    const actions = new ActionService(
      port,
      probe,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        workspaces: {
          async readWorkflow() {
            return WORKFLOW_STAGING;
          },
          async defaultBranchHead() {
            return MAIN;
          },
          async rangeShas(
            _repo: RepoConfig,
            from: string | null,
            to: string,
          ): Promise<ReadonlySet<string> | undefined> {
            rangeCalls.push({ from, to });
            if (from === PROD_PREV && to === PROD) {
              return new Set([LIVE, PROD]);
            }
            return new Set([MAIN]);
          },
          async rangeDiff() {
            return { files: ['src/a.ts'], insertions: 1, deletions: 1 };
          },
          async commitDiffBrief() {
            return {
              files: ['src/a.ts'],
              insertions: 1,
              deletions: 1,
              subject: 'feat: a',
            };
          },
        },
        requestStagingDeployNow: () => {},
      },
    );

    const first = await actions.listReleases();
    expect(first[0]?.afterDeployChecks).toEqual([
      {
        taskId: 't-live',
        title: 'Live check task',
        text: 'Open /x on the phone',
      },
    ]);
    const liveCalls = rangeCalls.filter((c) => c.from === PROD_PREV && c.to === PROD);
    expect(liveCalls).toHaveLength(1);

    const second = await actions.listReleases();
    expect(second[0]?.afterDeployChecks).toEqual(first[0]?.afterDeployChecks);
    const liveCallsAfter = rangeCalls.filter(
      (c) => c.from === PROD_PREV && c.to === PROD,
    );
    expect(liveCallsAfter).toHaveLength(1);
  });
});
