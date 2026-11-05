/**
 * Releases phone panel API surface (release-6): list rows for repos with
 * deploy.staging, deploy-now flag, auth. Pure helpers covered in domain/release.
 */
import { describe, it, expect } from 'vitest';
import { ActionError, ActionService } from '../../src/orchestrator/actions.js';
import type { ControlPort } from '../../src/orchestrator/orchestrator.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import type { Task } from '../../src/domain/task.js';
import type { RepoConfig, ReposConfig } from '../../src/domain/repos.js';
import { emptyRelease, type Release } from '../../src/domain/release.js';
import type { RepoProbe } from '../../src/orchestrator/repoProbe.js';
import { createApi } from '../../src/server/api.js';
import type { RuntimeView } from '../../src/orchestrator/orchestrator.js';

const MAIN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PROD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const WORKFLOW_STAGING = `---
gates:
  typecheck: echo ok
deploy:
  staging:
    command: ./scripts/deploy-staging.sh
    health: curl -sf http://localhost:8788/
    url: http://host:8788/
  production:
    command: ./scripts/deploy-production.sh <sha>
    health: curl -sf http://localhost:8787/
---
body
`;

const WORKFLOW_NO_DEPLOY = `---
gates:
  typecheck: echo ok
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

describe('ActionService.listReleases', () => {
  it('returns only repos with deploy.staging and assembles panel fields', async () => {
    const port = new FakePort(
      new Map([
        [
          't-merge',
          task({
            id: 't-merge',
            title: 'Awaiting merge',
            state: 'done',
            mergedSha: null,
            verifiedSha: 'v1',
          }),
        ],
        [
          't-ahead',
          task({
            id: 't-ahead',
            title: 'On staging',
            state: 'done',
            mergedSha: MAIN,
          }),
        ],
      ]),
      {
        repos: {
          app: repo('app'),
          bare: repo('bare'),
        },
      },
    );
    port.releases.set('app', {
      ...emptyRelease('app'),
      productionSha: PROD,
      stagingSha: MAIN,
      stagingStatus: 'ready',
      stagingVerifiedAt: '2026-07-17T00:00:00.000Z',
      body: '## Release packet\n\nready\n',
      history: [{ sha: PROD, at: '2026-07-16T00:00:00.000Z', outcome: 'ok' }],
    });

    const workflows = new Map([
      ['app', WORKFLOW_STAGING],
      ['bare', WORKFLOW_NO_DEPLOY],
    ]);
    const deployNow: string[] = [];
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
          async readWorkflow(r) {
            return workflows.get(r.key) ?? null;
          },
          async defaultBranchHead() {
            return MAIN;
          },
        },
        requestStagingDeployNow: (k) => {
          deployNow.push(k);
        },
      },
    );

    const list = await actions.listReleases();
    expect(list.map((e) => e.repoKey)).toEqual(['app']);
    const row = list[0]!;
    expect(row.stagingStatus).toBe('ready');
    // URL may come from WORKFLOW or STAGING_PUBLIC_URL(_FILE) env override.
    expect(typeof row.stagingUrl).toBe('string');
    expect(row.stagingUrl!.length).toBeGreaterThan(0);
    expect(row.canPromote).toBe(true);
    expect(row.stagingDrift).toBe(false);
    expect(row.hasProductionDeploy).toBe(true);
    expect(row.mergeableTasks.map((t) => t.id)).toEqual(['t-merge']);
    expect(row.aheadTasks.map((t) => t.id)).toEqual(['t-ahead']);
    expect(row.aheadCount).toBe(1);
    expect(row.packetBody).toContain('Release packet');
    // Promote briefing fields always present (even without mirror rangeDiff).
    expect(typeof row.trustChain).toBe('string');
    expect(row.trustChain.length).toBeGreaterThan(0);
    expect(row.rollbackPreview).toEqual({
      hasTarget: true,
      targetSha: PROD,
      deployedAt: null,
    });
    expect(row.stagingScreenshots).toEqual([]);
    expect(row.stagingUiToken).toBeNull();
    expect(row.operatorMergedCount).toBeGreaterThanOrEqual(0);
    // No merged_via stamp → honest operator-merged exception on ahead task.
    expect(row.aheadTasks[0]?.mergedVia).toBe('operator');

    const accepted = actions.requestStagingDeployNow('app');
    expect(accepted).toEqual({ accepted: true });
    expect(deployNow).toEqual(['app']);
  });

  it('includes range risk, screenshots, and staging token when wired', async () => {
    const port = new FakePort(
      new Map([
        [
          't-gate',
          task({
            id: 't-gate',
            title: 'Gated',
            state: 'done',
            mergedSha: MAIN,
            mergedVia: 'gate',
          }),
        ],
      ]),
      { repos: { app: repo('app') } },
    );
    port.releases.set('app', {
      ...emptyRelease('app'),
      productionSha: PROD,
      productionDeployedAt: '2026-07-16T00:00:00.000Z',
      stagingSha: MAIN,
      stagingStatus: 'ready',
      stagingVerifiedAt: '2026-07-17T00:00:00.000Z',
      body: `## Release packet

### Evidence

- **ok:** yes
- ✓ unlock: ok
- ✓ screenshot shell: ok
- ✓ click: ok
- ✓ assert: ok
`,
      history: [{ sha: PROD, at: '2026-07-16T00:00:00.000Z', outcome: 'ok' }],
    });

    const shotRoot = await (async () => {
      const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const root = await mkdtemp(join(tmpdir(), 'hercules-rel-shots-'));
      await mkdir(join(root, 'app'), { recursive: true });
      await writeFile(join(root, 'app', 'shell.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return root;
    })();

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
          async rangeDiff() {
            return {
              files: [
                'src/web/ReleasesPanel.tsx',
                'scripts/deploy-staging.sh',
                'src/orchestrator/actions.ts',
              ],
              insertions: 120,
              deletions: 30,
            };
          },
          async commitDiffBrief() {
            return {
              subject: 'hercules: merge t-gate — Gated',
              files: ['src/web/ReleasesPanel.tsx'],
              insertions: 40,
              deletions: 5,
            };
          },
          async findTaskMergeCommit() {
            return MAIN;
          },
        },
        requestStagingDeployNow: () => {},
        releaseScreenshotsRoot: shotRoot,
        resolveStagingUiToken: () => 'staging-secret-token',
      },
    );

    const list = await actions.listReleases();
    const row = list[0]!;
    expect(row.rangeRisk).not.toBeNull();
    expect(row.rangeRisk!.filesChanged).toBe(3);
    expect(row.rangeRisk!.sensitivePaths).toContain('scripts/deploy-staging.sh');
    expect(row.rangeRisk!.areas.map((a) => a.area)).toEqual(
      expect.arrayContaining(['src/web', 'scripts/', 'src/orchestrator']),
    );
    expect(row.evidenceCoverage?.label).toBe('4/4 steps');
    expect(row.stagingScreenshots).toEqual(['shell.png']);
    expect(row.stagingUiToken).toBe('staging-secret-token');
    expect(row.aheadTasks[0]?.mergedVia).toBe('gate');
    expect(row.aheadTasks[0]?.area).toBe('src/web');
    expect(row.aheadTasks[0]?.size).toBe('S');
    expect(row.operatorMergedCount).toBe(0);
    expect(row.trustChain).not.toMatch(/operator-merged/i);
    expect(row.rollbackPreview.hasTarget).toBe(true);
    expect(row.rollbackPreview.targetSha).toBe(PROD);
  });

  it('throws when deploy-now is not wired', () => {
    const port = new FakePort(new Map(), { repos: { app: repo() } });
    const actions = new ActionService(port, probe);
    expect(() => actions.requestStagingDeployNow('app')).toThrow(ActionError);
  });
});

describe('GET /api/releases + POST deploy-staging', () => {
  it('requires auth and returns release rows', async () => {
    const port = new FakePort(new Map(), { repos: { app: repo() } });
    port.releases.set('app', {
      ...emptyRelease('app'),
      productionSha: PROD,
      stagingSha: MAIN,
      stagingStatus: 'ready',
      body: '## packet\n',
    });
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
        },
        requestStagingDeployNow: () => {},
      },
    );
    const view: RuntimeView = {
      snapshot: { repos: { repos: { app: repo() } }, tasks: [], problems: [] },
      running: [],
      stopping: [],
      activity: {},
      pendingChat: {},
      liveRuns: {},
      lastReport: null,
      agents: { default: 'fake', available: ['fake'] },
    };
    const app = createApi({
      runtime: {
        getState: () => view,
        subscribe: () => () => {},
        forceAbort: () => {},
      },
      actions,
      token: 'secret',
    });

    const unauth = await app.request('/api/releases');
    expect(unauth.status).toBe(401);

    const res = await app.request('/api/releases', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      releases: {
        repoKey: string;
        stagingUrl: string | null;
        trustChain: string;
        rangeRisk: unknown;
        rollbackPreview: { hasTarget: boolean };
        stagingUiToken: string | null;
        stagingScreenshots: string[];
        evidenceCoverage: unknown;
      }[];
    };
    expect(body.releases).toHaveLength(1);
    expect(body.releases[0]!.repoKey).toBe('app');
    expect(body.releases[0]!.stagingUrl).toBeTruthy();
    // Shape: promote briefing fields present; token null when not wired.
    expect(typeof body.releases[0]!.trustChain).toBe('string');
    expect(body.releases[0]!.rollbackPreview).toMatchObject({ hasTarget: true });
    expect(body.releases[0]!.stagingUiToken).toBeNull();
    expect(Array.isArray(body.releases[0]!.stagingScreenshots)).toBe(true);

    const deploy = await app.request('/api/repos/app/deploy-staging', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
    });
    expect(deploy.status).toBe(200);
    expect(await deploy.json()).toEqual({ accepted: true });
  });

  it('serves release screenshots only with Bearer auth (never URL token)', async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const root = await mkdtemp(join(tmpdir(), 'hercules-api-shots-'));
    await mkdir(join(root, 'app'), { recursive: true });
    await writeFile(join(root, 'app', 'shell.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]));

    const port = new FakePort(new Map(), { repos: { app: repo() } });
    const actions = new ActionService(port, probe, undefined, undefined, undefined, undefined, undefined, {
      workspaces: {
        async readWorkflow() {
          return WORKFLOW_STAGING;
        },
        async defaultBranchHead() {
          return MAIN;
        },
      },
      requestStagingDeployNow: () => {},
    });
    const view: RuntimeView = {
      snapshot: { repos: { repos: { app: repo() } }, tasks: [], problems: [] },
      running: [],
      stopping: [],
      activity: {},
      pendingChat: {},
      liveRuns: {},
      lastReport: null,
      agents: { default: 'fake', available: ['fake'] },
    };
    const app = createApi({
      runtime: {
        getState: () => view,
        subscribe: () => () => {},
        forceAbort: () => {},
      },
      actions,
      token: 'secret',
      releaseScreenshotsRoot: root,
    });

    const unauth = await app.request('/api/releases/app/screenshots/shell.png');
    expect(unauth.status).toBe(401);

    const queryLeak = await app.request('/api/releases/app/screenshots/shell.png?token=secret');
    expect(queryLeak.status).toBe(401);

    const ok = await app.request('/api/releases/app/screenshots/shell.png', {
      headers: { authorization: 'Bearer secret' },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('image/png');
  });
});
