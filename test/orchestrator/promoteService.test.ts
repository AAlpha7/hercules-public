/**
 * Promote / rollback / restart-safe finalization (design §3–§4 / release-5).
 *
 * Covers: promote ok, deploy fail → auto-rollback, boot finalization ok+fail,
 * manual rollback. Fake runner + fake clock only — no real deploys.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  PromoteService,
  PromoteServiceError,
  substituteProductionSha,
  type PromoteWorkspaces,
} from '../../src/orchestrator/promoteService.js';
import {
  type DeployRunner,
  type StagingVerifyInput,
} from '../../src/orchestrator/releaseReconciler.js';
import type { ControlPort } from '../../src/orchestrator/orchestrator.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import type { Task } from '../../src/domain/task.js';
import type { RepoConfig, ReposConfig } from '../../src/domain/repos.js';
import {
  emptyRelease,
  promoteStarted,
  type Release,
} from '../../src/domain/release.js';
import type { EvidenceRunSummary } from '../../src/domain/evidence.js';
import { ActionError, ActionService } from '../../src/orchestrator/actions.js';
import type { RepoProbe } from '../../src/orchestrator/repoProbe.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { FakeAdapter } from '../../src/orchestrator/fakeAdapter.js';
import { createApi } from '../../src/server/api.js';
import type { RuntimeView } from '../../src/orchestrator/orchestrator.js';
import { makeConfig } from '../../src/config.js';
import { AgentRegistry } from '../../src/orchestrator/agentRegistry.js';

const MAIN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PROD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OLD = 'cccccccccccccccccccccccccccccccccccccccc';

const WORKFLOW_WITH_PROD = `---
gates:
  typecheck: echo ok
deploy:
  staging:
    command: ./scripts/deploy-staging.sh
    health: curl -sf http://localhost:8788/
  production:
    command: ./scripts/deploy-production.sh <sha>
    health: curl -sf http://localhost:8787/
    smoke: ./scripts/smoke-production.sh
---
body
`;

const WORKFLOW_NO_SMOKE = `---
gates:
  typecheck: echo ok
deploy:
  production:
    command: ./scripts/deploy-production.sh <sha>
    health: curl -sf http://localhost:8787/
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

function readyRelease(over: Partial<Release> = {}): Release {
  return {
    ...emptyRelease('app'),
    productionSha: PROD,
    productionDeployedAt: '2026-07-16T00:00:00.000Z',
    stagingSha: MAIN,
    stagingStatus: 'ready',
    stagingVerifiedAt: '2026-07-17T00:00:00.000Z',
    history: [{ sha: PROD, at: '2026-07-16T00:00:00.000Z', outcome: 'ok' }],
    body: '## Prior packet\n',
    ...over,
  };
}

class FakePort implements ControlPort {
  readonly commits: string[] = [];
  readonly releases = new Map<string, Release>();
  constructor(
    readonly tasks: Map<string, Task>,
    private readonly repos: ReposConfig,
  ) {}
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
  async writeRepos(): Promise<void> {}
  async readRelease(repoKey: string): Promise<Release | null> {
    return this.releases.get(repoKey) ?? null;
  }
  async writeRelease(release: Release): Promise<void> {
    this.releases.set(release.repoKey, release);
  }
}

class FakeDeployRunner implements DeployRunner {
  readonly commands: { command: string; cwd: string }[] = [];
  /** exit codes keyed by command substring match */
  exitFor: Record<string, number> = {};
  outputFor: Record<string, string> = {};
  defaultExit = 0;
  defaultOutput = 'ok';

  async run(command: string, cwd: string) {
    this.commands.push({ command, cwd });
    for (const [needle, code] of Object.entries(this.exitFor)) {
      if (command.includes(needle)) {
        return {
          exitCode: code,
          output: this.outputFor[needle] ?? this.defaultOutput,
        };
      }
    }
    return { exitCode: this.defaultExit, output: this.defaultOutput };
  }

  async verify(_input: StagingVerifyInput): Promise<EvidenceRunSummary> {
    return {
      plan: { steps: [], source: 'workflow' },
      results: [],
      ok: true,
      screenshots: [],
    };
  }
}

function makeWs(opts: {
  workflow?: string | null;
  mainSha?: string | null;
} = {}): PromoteWorkspaces {
  return {
    async readWorkflow() {
      return opts.workflow === undefined ? WORKFLOW_WITH_PROD : opts.workflow;
    },
    async defaultBranchHead() {
      return opts.mainSha === undefined ? MAIN : opts.mainSha;
    },
    deployCwd() {
      return '/tmp/fake-prod-mirror';
    },
  };
}

describe('substituteProductionSha', () => {
  it('replaces <sha> placeholder', () => {
    expect(substituteProductionSha('./scripts/deploy-production.sh <sha>', MAIN)).toBe(
      `./scripts/deploy-production.sh ${MAIN}`,
    );
  });

  it('appends sha when no placeholder', () => {
    expect(substituteProductionSha('./scripts/deploy-production.sh', MAIN)).toBe(
      `./scripts/deploy-production.sh ${MAIN}`,
    );
  });
});

describe('PromoteService.promote', () => {
  let clock: { now: number };
  let port: FakePort;
  let runner: FakeDeployRunner;
  let service: PromoteService;

  beforeEach(() => {
    clock = { now: 1_000_000 };
    port = new FakePort(new Map(), { repos: { app: repo() } });
    port.releases.set('app', readyRelease());
    runner = new FakeDeployRunner();
    service = new PromoteService({
      control: port,
      workspaces: makeWs(),
      deployRunner: runner,
      clock: () => clock.now,
      healthTimeoutMs: 5_000,
      healthIntervalMs: 1_000,
      sleep: async () => {
        clock.now += 1_000;
      },
    });
  });

  it('promote ok: write promoting_sha first, deploy, health+smoke, finalize', async () => {
    const result = await service.promote('app');
    expect(result.outcome).toBe('ok');
    expect(result.alert).toBeNull();

    const rel = port.releases.get('app')!;
    expect(rel.promotingSha).toBeNull();
    expect(rel.productionSha).toBe(MAIN);
    expect(rel.productionDeployedAt).toBe(new Date(1_000_000).toISOString());
    expect(rel.history[rel.history.length - 1]).toEqual({
      sha: MAIN,
      at: new Date(1_000_000).toISOString(),
      outcome: 'ok',
    });

    // promoting_sha was committed before deploy
    expect(port.commits[0]).toMatch(/promoting/);
    expect(port.commits.some((c) => /promote ok|production ok|promoted/.test(c))).toBe(true);

    const cmds = runner.commands.map((c) => c.command);
    expect(cmds[0]).toBe(`./scripts/deploy-production.sh ${MAIN}`);
    expect(cmds.some((c) => c.includes('8787'))).toBe(true);
    expect(cmds.some((c) => c.includes('smoke-production'))).toBe(true);
  });

  it('blocks when staging not ready', async () => {
    port.releases.set('app', readyRelease({ stagingStatus: 'failed' }));
    await expect(service.promote('app')).rejects.toThrow(/staging_status|ready/i);
  });

  it('blocks when staging drifts from main (re-verify message)', async () => {
    port.releases.set('app', readyRelease({ stagingSha: OLD }));
    await expect(service.promote('app')).rejects.toThrow(/re-verify|drift/i);
  });

  it('deploy fail → automatic rollback to known-good + alert', async () => {
    runner.exitFor['deploy-production'] = 1;
    runner.outputFor['deploy-production'] = 'deploy exploded';

    const result = await service.promote('app');
    expect(result.outcome).toBe('rolled_back');
    expect(result.alert).toMatch(/rollback|deploy/i);

    const rel = port.releases.get('app')!;
    expect(rel.promotingSha).toBeNull();
    expect(rel.productionSha).toBe(PROD);
    const last = rel.history[rel.history.length - 1]!;
    expect(last.outcome).toBe('rolled_back');
    expect(last.rollbackOf).toBe(MAIN);
    expect(last.sha).toBe(PROD);
    expect(rel.body).toMatch(/ALERT|rollback/i);

    // Deploy of failed tip + deploy of known-good
    const deploys = runner.commands.filter((c) => c.command.includes('deploy-production'));
    expect(deploys.length).toBeGreaterThanOrEqual(2);
    expect(deploys[0]!.command).toContain(MAIN);
    expect(deploys.some((c) => c.command.includes(PROD))).toBe(true);
  });

  it('health fail after deploy → auto-rollback', async () => {
    runner.exitFor['8787'] = 1;
    runner.outputFor['8787'] = 'connection refused';

    const result = await service.promote('app');
    expect(result.outcome).toBe('rolled_back');
    expect(result.alert).toMatch(/health|rollback/i);

    const rel = port.releases.get('app')!;
    expect(rel.productionSha).toBe(PROD);
    expect(rel.promotingSha).toBeNull();
    expect(rel.history[rel.history.length - 1]!.outcome).toBe('rolled_back');
  });

  it('smoke fail → auto-rollback', async () => {
    runner.exitFor['smoke-production'] = 1;
    runner.outputFor['smoke-production'] = 'smoke red';

    const result = await service.promote('app');
    expect(result.outcome).toBe('rolled_back');
    expect(result.alert).toMatch(/smoke|rollback/i);
    expect(port.releases.get('app')!.productionSha).toBe(PROD);
  });

  it('works without smoke command', async () => {
    service = new PromoteService({
      control: port,
      workspaces: makeWs({ workflow: WORKFLOW_NO_SMOKE }),
      deployRunner: runner,
      clock: () => clock.now,
      healthTimeoutMs: 5_000,
      healthIntervalMs: 1_000,
      sleep: async () => {
        clock.now += 1_000;
      },
    });
    const result = await service.promote('app');
    expect(result.outcome).toBe('ok');
    expect(runner.commands.some((c) => c.command.includes('smoke'))).toBe(false);
  });
});

describe('PromoteService.rollbackProduction (manual)', () => {
  let port: FakePort;
  let runner: FakeDeployRunner;
  let service: PromoteService;
  let clock: { now: number };

  beforeEach(() => {
    clock = { now: 2_000_000 };
    port = new FakePort(new Map(), { repos: { app: repo() } });
    // Production already at MAIN (successful prior promote); history has PROD then MAIN.
    port.releases.set(
      'app',
      readyRelease({
        productionSha: MAIN,
        productionDeployedAt: '2026-07-17T01:00:00.000Z',
        stagingSha: MAIN,
        history: [
          { sha: PROD, at: '2026-07-16T00:00:00.000Z', outcome: 'ok' },
          { sha: MAIN, at: '2026-07-17T01:00:00.000Z', outcome: 'ok' },
        ],
      }),
    );
    runner = new FakeDeployRunner();
    service = new PromoteService({
      control: port,
      workspaces: makeWs(),
      deployRunner: runner,
      clock: () => clock.now,
      healthTimeoutMs: 5_000,
      healthIntervalMs: 1_000,
      sleep: async () => {
        clock.now += 1_000;
      },
    });
  });

  it('rolls back to previous known-good (not current production)', async () => {
    const result = await service.rollbackProduction('app');
    expect(result.outcome).toBe('rolled_back');
    expect(result.alert).toMatch(/manual|rollback/i);

    const rel = port.releases.get('app')!;
    expect(rel.productionSha).toBe(PROD);
    expect(rel.promotingSha).toBeNull();
    const last = rel.history[rel.history.length - 1]!;
    expect(last).toMatchObject({
      sha: PROD,
      outcome: 'rolled_back',
      rollbackOf: MAIN,
    });

    const deploy = runner.commands.find((c) => c.command.includes('deploy-production'));
    expect(deploy?.command).toContain(PROD);
  });

  it('errors when no earlier known-good exists', async () => {
    port.releases.set(
      'app',
      readyRelease({
        productionSha: MAIN,
        history: [{ sha: MAIN, at: '2026-07-17T01:00:00.000Z', outcome: 'ok' }],
      }),
    );
    // Only one ok entry matching production — nothing older.
    await expect(service.rollbackProduction('app')).rejects.toThrow(/no|known-good|rollback/i);
  });
});

describe('PromoteService.finalizeInFlight (boot)', () => {
  let clock: { now: number };
  let port: FakePort;
  let runner: FakeDeployRunner;
  let service: PromoteService;
  let errorSpy: { calls: string[] };

  beforeEach(() => {
    clock = { now: 3_000_000 };
    port = new FakePort(new Map(), { repos: { app: repo() } });
    runner = new FakeDeployRunner();
    errorSpy = { calls: [] };
    service = new PromoteService({
      control: port,
      workspaces: makeWs(),
      deployRunner: runner,
      clock: () => clock.now,
      healthTimeoutMs: 5_000,
      healthIntervalMs: 1_000,
      sleep: async () => {
        clock.now += 1_000;
      },
      // Booted daemon is the promoting tip (MAIN after promoteStarted).
      bootedBuildSha: MAIN,
    });
  });

  it('health+smoke ok → record production without re-deploying promoting sha', async () => {
    // Simulate mid-promote restart: promoting_sha set, production still old.
    port.releases.set(
      'app',
      promoteStarted(
        readyRelease({
          productionSha: PROD,
          stagingSha: MAIN,
        }),
      ),
    );

    const results = await service.finalizeInFlight();
    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe('ok');

    const rel = port.releases.get('app')!;
    expect(rel.productionSha).toBe(MAIN);
    expect(rel.promotingSha).toBeNull();
    expect(rel.lastPromoteFailure).toBeNull();
    expect(rel.history[rel.history.length - 1]!.outcome).toBe('ok');

    // Boot path must NOT re-run production deploy of promoting sha — only health+smoke.
    const deploys = runner.commands.filter((c) => c.command.includes('deploy-production'));
    expect(deploys).toHaveLength(0);
    expect(runner.commands.some((c) => c.command.includes('8787'))).toBe(true);
    expect(runner.commands.some((c) => c.command.includes('smoke'))).toBe(true);
  });

  it('short booted sha prefix-matches full promoting sha → finalize', async () => {
    port.releases.set(
      'app',
      promoteStarted(readyRelease({ productionSha: PROD, stagingSha: MAIN })),
    );
    const shortService = new PromoteService({
      control: port,
      workspaces: makeWs(),
      deployRunner: runner,
      clock: () => clock.now,
      healthTimeoutMs: 5_000,
      healthIntervalMs: 1_000,
      sleep: async () => {
        clock.now += 1_000;
      },
      bootedBuildSha: MAIN.slice(0, 7),
    });
    const results = await shortService.finalizeInFlight();
    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe('ok');
    expect(port.releases.get('app')!.productionSha).toBe(MAIN);
  });

  it('health fail on boot → rollback deploy known-good + alert', async () => {
    port.releases.set(
      'app',
      promoteStarted(
        readyRelease({
          productionSha: PROD,
          stagingSha: MAIN,
        }),
      ),
    );
    runner.exitFor['8787'] = 1;
    runner.outputFor['8787'] = 'dead';

    const results = await service.finalizeInFlight();
    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe('rolled_back');
    expect(results[0]!.alert).toMatch(/rollback|health/i);

    const rel = port.releases.get('app')!;
    expect(rel.productionSha).toBe(PROD);
    expect(rel.promotingSha).toBeNull();
    expect(rel.history[rel.history.length - 1]!.outcome).toBe('rolled_back');
    expect(rel.body).toMatch(/ALERT/i);

    // Rollback deploys known-good
    expect(
      runner.commands.some(
        (c) => c.command.includes('deploy-production') && c.command.includes(PROD),
      ),
    ).toBe(true);
  });

  it('booted sha != promoting sha → record preserved, no deploy, failure note', async () => {
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errorSpy.calls.push(args.map(String).join(' '));
    };
    try {
      port.releases.set(
        'app',
        promoteStarted(readyRelease({ productionSha: PROD, stagingSha: MAIN })),
      );
      const mismatch = new PromoteService({
        control: port,
        workspaces: makeWs(),
        deployRunner: runner,
        clock: () => clock.now,
        // Running daemon is the old known-good, not the promoting tip.
        bootedBuildSha: PROD,
      });

      const results = await mismatch.finalizeInFlight();
      expect(results).toHaveLength(1);
      expect(results[0]!.outcome).toBe('failed');

      const rel = port.releases.get('app')!;
      expect(rel.productionSha).toBe(PROD);
      expect(rel.promotingSha).toBeNull();
      expect(rel.lastPromoteFailure).toEqual({
        sha: MAIN,
        bootedSha: PROD,
        reason: 'booted_build_mismatch',
        at: new Date(3_000_000).toISOString(),
      });
      expect(rel.history).toEqual([
        { sha: PROD, at: '2026-07-16T00:00:00.000Z', outcome: 'ok' },
      ]);
      expect(runner.commands).toHaveLength(0);
      expect(
        errorSpy.calls.some((line) =>
          /promote finalize app: FAILED booted bbbbbbbb != promoting aaaaaaaa — record preserved/.test(
            line,
          ),
        ),
      ).toBe(true);
    } finally {
      console.error = origError;
    }
  });

  it('unknown booted sha → same fail-closed with booted_build_unknown', async () => {
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errorSpy.calls.push(args.map(String).join(' '));
    };
    try {
      port.releases.set(
        'app',
        promoteStarted(readyRelease({ productionSha: PROD, stagingSha: MAIN })),
      );
      const unknown = new PromoteService({
        control: port,
        workspaces: makeWs(),
        deployRunner: runner,
        clock: () => clock.now,
        bootedBuildSha: null,
      });

      const results = await unknown.finalizeInFlight();
      expect(results).toHaveLength(1);
      expect(results[0]!.outcome).toBe('failed');

      const rel = port.releases.get('app')!;
      expect(rel.productionSha).toBe(PROD);
      expect(rel.promotingSha).toBeNull();
      expect(rel.lastPromoteFailure).toEqual({
        sha: MAIN,
        bootedSha: null,
        reason: 'booted_build_unknown',
        at: new Date(3_000_000).toISOString(),
      });
      expect(runner.commands).toHaveLength(0);
      expect(
        errorSpy.calls.some((line) =>
          /promote finalize app: FAILED booted unknown != promoting aaaaaaaa — record preserved/.test(
            line,
          ),
        ),
      ).toBe(true);
    } finally {
      console.error = origError;
    }
  });

  it('no-op when no promoting_sha', async () => {
    port.releases.set('app', readyRelease());
    const results = await service.finalizeInFlight();
    expect(results).toHaveLength(0);
    expect(runner.commands).toHaveLength(0);
  });
});

describe('boot finalization via Orchestrator first tick', () => {
  it('tick once finalizes in-flight promote (ok path)', async () => {
    const clock = { now: 4_000_000 };
    const port = new FakePort(new Map(), { repos: { app: repo() } });
    port.releases.set(
      'app',
      promoteStarted(readyRelease({ productionSha: PROD, stagingSha: MAIN })),
    );
    const runner = new FakeDeployRunner();
    const promoteService = new PromoteService({
      control: port,
      workspaces: makeWs(),
      deployRunner: runner,
      clock: () => clock.now,
      healthTimeoutMs: 5_000,
      healthIntervalMs: 1_000,
      sleep: async () => {
        clock.now += 1_000;
      },
      bootedBuildSha: MAIN,
    });

    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      agents: AgentRegistry.of(new FakeAdapter({ durationMs: 100 })),
      clock: () => clock.now,
      promoteService,
    });

    const report = await orch.tick();
    expect(report.promotesFinalized).toContain('app');
    expect(port.releases.get('app')!.productionSha).toBe(MAIN);
    expect(port.releases.get('app')!.promotingSha).toBeNull();

    // Second tick does not re-finalize
    runner.commands.length = 0;
    const report2 = await orch.tick();
    expect(report2.promotesFinalized).toEqual([]);
    expect(runner.commands).toHaveLength(0);
  });

  it('tick once rolls back when boot health fails', async () => {
    const clock = { now: 5_000_000 };
    const port = new FakePort(new Map(), { repos: { app: repo() } });
    port.releases.set(
      'app',
      promoteStarted(readyRelease({ productionSha: PROD, stagingSha: MAIN })),
    );
    const runner = new FakeDeployRunner();
    runner.exitFor['8787'] = 1;
    const promoteService = new PromoteService({
      control: port,
      workspaces: makeWs(),
      deployRunner: runner,
      clock: () => clock.now,
      healthTimeoutMs: 2_000,
      healthIntervalMs: 500,
      sleep: async () => {
        clock.now += 500;
      },
      bootedBuildSha: MAIN,
    });

    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      agents: AgentRegistry.of(new FakeAdapter({ durationMs: 100 })),
      clock: () => clock.now,
      promoteService,
    });

    const report = await orch.tick();
    expect(report.promotesFinalized).toContain('app');
    expect(port.releases.get('app')!.productionSha).toBe(PROD);
    expect(port.releases.get('app')!.history.at(-1)?.outcome).toBe('rolled_back');
  });
});

describe('ActionService + API promote/rollback', () => {
  it('ActionService.promote delegates and enforces preconditions', async () => {
    const port = new FakePort(new Map(), { repos: { app: repo() } });
    port.releases.set('app', readyRelease());
    const runner = new FakeDeployRunner();
    const clock = { now: 6_000_000 };
    const promoteService = new PromoteService({
      control: port,
      workspaces: makeWs(),
      deployRunner: runner,
      clock: () => clock.now,
      sleep: async () => {
        clock.now += 1_000;
      },
    });
    const probe: RepoProbe = {
      async probe() {
        return { branches: ['main'] };
      },
    };
    const actions = new ActionService(
      port,
      probe,
      undefined,
      undefined,
      undefined,
      undefined,
      promoteService,
    );

    const result = await actions.promote('app');
    expect(result.outcome).toBe('ok');
    expect(port.releases.get('app')!.productionSha).toBe(MAIN);

    // Drift → ActionError
    port.releases.set('app', readyRelease({ stagingSha: OLD, stagingStatus: 'ready' }));
    await expect(actions.promote('app')).rejects.toBeInstanceOf(ActionError);
  });

  it('POST /api/repos/:key/promote and /rollback require auth and delegate', async () => {
    const port = new FakePort(new Map(), { repos: { app: repo() } });
    port.releases.set(
      'app',
      readyRelease({
        productionSha: MAIN,
        history: [
          { sha: PROD, at: '2026-07-16T00:00:00.000Z', outcome: 'ok' },
          { sha: MAIN, at: '2026-07-17T01:00:00.000Z', outcome: 'ok' },
        ],
      }),
    );
    // For promote test: need ready + matching main; reset production to PROD for promote path.
    const promotePort = new FakePort(new Map(), { repos: { app: repo() } });
    promotePort.releases.set('app', readyRelease());
    const runner = new FakeDeployRunner();
    const clock = { now: 7_000_000 };
    const promoteService = new PromoteService({
      control: promotePort,
      workspaces: makeWs(),
      deployRunner: runner,
      clock: () => clock.now,
      sleep: async () => {
        clock.now += 1_000;
      },
    });
    const probe: RepoProbe = {
      async probe() {
        return { branches: ['main'] };
      },
    };
    const actions = new ActionService(
      promotePort,
      probe,
      undefined,
      undefined,
      undefined,
      undefined,
      promoteService,
    );

    const view: RuntimeView = {
      snapshot: {
        repos: { repos: { app: repo() } },
        tasks: [],
        problems: [],
      },
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

    const unauth = await app.request('/api/repos/app/promote', { method: 'POST' });
    expect(unauth.status).toBe(401);

    const res = await app.request('/api/repos/app/promote', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string; productionSha: string };
    expect(body.outcome).toBe('ok');
    expect(body.productionSha).toBe(MAIN);

    // Rollback API on a separate service with current prod = MAIN
    const rbPort = new FakePort(new Map(), { repos: { app: repo() } });
    rbPort.releases.set(
      'app',
      readyRelease({
        productionSha: MAIN,
        stagingSha: MAIN,
        history: [
          { sha: PROD, at: '2026-07-16T00:00:00.000Z', outcome: 'ok' },
          { sha: MAIN, at: '2026-07-17T01:00:00.000Z', outcome: 'ok' },
        ],
      }),
    );
    const rbRunner = new FakeDeployRunner();
    const rbService = new PromoteService({
      control: rbPort,
      workspaces: makeWs(),
      deployRunner: rbRunner,
      clock: () => clock.now,
      sleep: async () => {
        clock.now += 1_000;
      },
    });
    const rbActions = new ActionService(
      rbPort,
      probe,
      undefined,
      undefined,
      undefined,
      undefined,
      rbService,
    );
    const rbApp = createApi({
      runtime: {
        getState: () => view,
        subscribe: () => () => {},
        forceAbort: () => {},
      },
      actions: rbActions,
      token: 'secret',
    });
    const rbRes = await rbApp.request('/api/repos/app/rollback', {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
    });
    expect(rbRes.status).toBe(200);
    const rbBody = (await rbRes.json()) as { outcome: string; productionSha: string };
    expect(rbBody.outcome).toBe('rolled_back');
    expect(rbBody.productionSha).toBe(PROD);
  });
});

describe('PromoteService release-operation single-flight', () => {
  function makeDeferred(hangNeedle = 'deploy-production') {
    const commands: { command: string; cwd: string }[] = [];
    let releaseDeploy:
      | ((v: { exitCode: number; output: string }) => void)
      | undefined;
    let enteredResolve!: () => void;
    const enteredP = new Promise<void>((r) => {
      enteredResolve = r;
    });
    const runner: DeployRunner = {
      async run(command, cwd) {
        commands.push({ command, cwd });
        if (command.includes(hangNeedle)) {
          if (!releaseDeploy) {
            enteredResolve();
            return new Promise((resolve) => {
              releaseDeploy = resolve;
            });
          }
        }
        return { exitCode: 0, output: 'ok' };
      },
      async verify() {
        return {
          plan: { steps: [], source: 'workflow' as const },
          results: [],
          ok: true,
          screenshots: [],
        };
      },
    };
    return {
      commands,
      runner,
      enteredP,
      release: () => {
        if (releaseDeploy) {
          releaseDeploy({ exitCode: 0, output: 'ok' });
        }
      },
    };
  }

  it('two concurrent promotes serialize per repo', async () => {
    const clock = { now: 10_000_000 };
    const port = new FakePort(new Map(), { repos: { app: repo() } });
    port.releases.set('app', readyRelease());
    const commands: { command: string; cwd: string }[] = [];
    let releaseDeploy!: (v: { exitCode: number; output: string }) => void;
    let enteredResolve!: () => void;
    const enteredP = new Promise<void>((r) => {
      enteredResolve = r;
    });
    const runner: DeployRunner = {
      async run(command, cwd) {
        commands.push({ command, cwd });
        if (command.includes('deploy-production')) {
          enteredResolve();
          return new Promise((resolve) => {
            releaseDeploy = resolve;
          });
        }
        return { exitCode: 0, output: 'ok' };
      },
      async verify() {
        return {
          plan: { steps: [], source: 'workflow' as const },
          results: [],
          ok: true,
          screenshots: [],
        };
      },
    };
    const service = new PromoteService({
      control: port,
      workspaces: makeWs(),
      deployRunner: runner,
      clock: () => clock.now,
      healthTimeoutMs: 5000,
      healthIntervalMs: 1000,
      sleep: async () => {
        clock.now += 1000;
      },
    });
    const winner = service.promote('app');
    try {
      await enteredP;
      expect(port.commits.some((c) => /promoting/.test(c))).toBe(true);
      expect(
        commands.filter((c) => c.command.includes('deploy-production')),
      ).toHaveLength(1);
      let loser: unknown;
      try {
        await service.promote('app');
      } catch (err) {
        loser = err;
      }
      expect(loser).toBeInstanceOf(PromoteServiceError);
      expect((loser as Error).message).toMatch(/already in flight/i);
      expect(
        commands.filter((c) => c.command.includes('deploy-production')),
      ).toHaveLength(1);
    } finally {
      releaseDeploy({ exitCode: 0, output: 'ok' });
    }
    const result = await winner;
    expect(result.outcome).toBe('ok');
    expect(port.releases.get('app')!.productionSha).toBe(MAIN);
  });

  it('thrown failure releases lock for later op', async () => {
    const clock = { now: 13_000_000 };
    const port = new FakePort(new Map(), { repos: { app: repo() } });
    port.releases.set('app', readyRelease());
    const runner = new FakeDeployRunner();
    const service = new PromoteService({
      control: port,
      workspaces: makeWs(),
      deployRunner: runner,
      clock: () => clock.now,
      sleep: async () => {
        clock.now += 1000;
      },
    });
    const originalWrite = port.writeRelease.bind(port);
    let failOnce = true;
    port.writeRelease = async (release: Release) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('simulated write failure');
      }
      return originalWrite(release);
    };
    await expect(service.promote('app')).rejects.toThrow(/simulated write failure/);
    const result = await service.promote('app');
    expect(result.outcome).toBe('ok');
    expect(port.releases.get('app')!.productionSha).toBe(MAIN);
  });

  it('promote vs rollback mutually exclusive same repo', async () => {
    const d = makeDeferred();
    const clock = { now: 11_000_000 };
    const port = new FakePort(new Map(), { repos: { app: repo() } });
    port.releases.set(
      'app',
      readyRelease({
        productionSha: MAIN,
        stagingSha: MAIN,
        history: [
          { sha: PROD, at: '2026-07-16T00:00:00.000Z', outcome: 'ok' },
          { sha: MAIN, at: '2026-07-17T01:00:00.000Z', outcome: 'ok' },
        ],
      }),
    );
    const service = new PromoteService({
      control: port,
      workspaces: makeWs(),
      deployRunner: d.runner,
      clock: () => clock.now,
      sleep: async () => {
        clock.now += 1000;
      },
    });
    const rb = service.rollbackProduction('app');
    try {
      await d.enteredP;
      await expect(service.promote('app')).rejects.toBeInstanceOf(PromoteServiceError);
      await expect(service.promote('app')).rejects.toThrow(/already in flight/i);
      expect(d.commands.filter((c) => c.command.includes('deploy-production'))).toHaveLength(1);
    } finally {
      d.release();
    }
    expect((await rb).outcome).toBe('rolled_back');
  });

  it('phone promote vs boot finalize mutually exclusive', async () => {
    const clock = { now: 12_000_000 };
    const port = new FakePort(new Map(), { repos: { app: repo() } });
    port.releases.set(
      'app',
      promoteStarted(readyRelease({ productionSha: PROD, stagingSha: MAIN })),
    );
    const d = makeDeferred('8787');
    const service = new PromoteService({
      control: port,
      workspaces: makeWs(),
      deployRunner: d.runner,
      clock: () => clock.now,
      sleep: async () => {
        clock.now += 1000;
      },
      bootedBuildSha: MAIN,
    });
    const finalizeP = service.finalizeInFlight();
    try {
      await d.enteredP;
      await expect(service.promote('app')).rejects.toBeInstanceOf(PromoteServiceError);
      await expect(service.promote('app')).rejects.toThrow(/already in flight/i);
      expect(port.commits.filter((c) => /promoting/.test(c))).toHaveLength(0);
    } finally {
      d.release();
    }
    const results = await finalizeP;
    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe('ok');
  });

  it('different repos are not globally serialized', async () => {
    const clock = { now: 14_000_000 };
    const port = new FakePort(new Map(), {
      repos: { app: repo('app'), other: repo('other') },
    });
    port.releases.set('app', readyRelease({ repoKey: 'app' }));
    port.releases.set('other', readyRelease({ repoKey: 'other' }));
    const d = makeDeferred();
    const service = new PromoteService({
      control: port,
      workspaces: makeWs(),
      deployRunner: d.runner,
      clock: () => clock.now,
      sleep: async () => {
        clock.now += 1000;
      },
    });
    const pApp = service.promote('app');
    try {
      await d.enteredP;
      // Per-repo lock: other completes while app is still mid-deploy.
      const other = await service.promote('other');
      expect(other.outcome).toBe('ok');
    } finally {
      d.release();
    }
    expect((await pApp).outcome).toBe('ok');
    expect(d.commands.filter((c) => c.command.includes('deploy-production')).length).toBeGreaterThanOrEqual(2);
  });

  it('POST promote concurrent maps already-in-flight to 400', async () => {
    const clock = { now: 15_000_000 };
    const port = new FakePort(new Map(), { repos: { app: repo() } });
    port.releases.set('app', readyRelease());
    const d = makeDeferred();
    const promoteService = new PromoteService({
      control: port,
      workspaces: makeWs(),
      deployRunner: d.runner,
      clock: () => clock.now,
      sleep: async () => {
        clock.now += 1000;
      },
    });
    const probe: RepoProbe = {
      async probe() {
        return { branches: ['main'] };
      },
    };
    const actions = new ActionService(
      port,
      probe,
      undefined,
      undefined,
      undefined,
      undefined,
      promoteService,
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
      runtime: { getState: () => view, subscribe: () => () => {}, forceAbort: () => {} },
      actions,
      token: 'secret',
    });
    const headers = { authorization: 'Bearer secret' };
    const first = app.request('/api/repos/app/promote', { method: 'POST', headers });
    try {
      await d.enteredP;
      const second = await app.request('/api/repos/app/promote', { method: 'POST', headers });
      expect(second.status).toBe(400);
      const body = (await second.json()) as { error: string };
      expect(body.error).toMatch(/already in flight/i);
    } finally {
      d.release();
    }
    expect((await first).status).toBe(200);
  });

  it('POST rollback blocked while promote in flight returns 400', async () => {
    const clock = { now: 16_000_000 };
    const port = new FakePort(new Map(), { repos: { app: repo() } });
    port.releases.set('app', readyRelease());
    const d = makeDeferred();
    const promoteService = new PromoteService({
      control: port,
      workspaces: makeWs(),
      deployRunner: d.runner,
      clock: () => clock.now,
      sleep: async () => {
        clock.now += 1000;
      },
    });
    const probe: RepoProbe = {
      async probe() {
        return { branches: ['main'] };
      },
    };
    const actions = new ActionService(
      port,
      probe,
      undefined,
      undefined,
      undefined,
      undefined,
      promoteService,
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
    const appApi = createApi({
      runtime: { getState: () => view, subscribe: () => () => {}, forceAbort: () => {} },
      actions,
      token: 'secret',
    });
    const headers = { authorization: 'Bearer secret' };
    const promoteReq = appApi.request('/api/repos/app/promote', {
      method: 'POST',
      headers,
    });
    try {
      await d.enteredP;
      const rbRes = await appApi.request('/api/repos/app/rollback', {
        method: 'POST',
        headers,
      });
      expect(rbRes.status).toBe(400);
      const rbBody = (await rbRes.json()) as { error: string };
      expect(rbBody.error).toMatch(/already in flight/i);
    } finally {
      d.release();
    }
    expect((await promoteReq).status).toBe(200);
  });

  it('cross-instance lock: phone promote vs boot finalize share registry', async () => {
    const clock = { now: 17_000_000 };
    const port = new FakePort(new Map(), { repos: { app: repo() } });
    port.releases.set(
      'app',
      promoteStarted(readyRelease({ productionSha: PROD, stagingSha: MAIN })),
    );
    const d = makeDeferred('8787');
    const bootService = new PromoteService({
      control: port,
      workspaces: makeWs(),
      deployRunner: d.runner,
      clock: () => clock.now,
      sleep: async () => {
        clock.now += 1000;
      },
      bootedBuildSha: MAIN,
    });
    const phoneService = new PromoteService({
      control: port,
      workspaces: makeWs(),
      deployRunner: d.runner,
      clock: () => clock.now,
      sleep: async () => {
        clock.now += 1000;
      },
      bootedBuildSha: MAIN,
    });
    const finalizeP = bootService.finalizeInFlight();
    try {
      await d.enteredP;
      const commitsBefore = port.commits.length;
      await expect(phoneService.promote('app')).rejects.toBeInstanceOf(PromoteServiceError);
      await expect(phoneService.promote('app')).rejects.toThrow(/already in flight/i);
      await expect(phoneService.rollbackProduction('app')).rejects.toThrow(/already in flight/i);
      expect(port.commits.length).toBe(commitsBefore);
    } finally {
      d.release();
    }
    const results = await finalizeP;
    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe('ok');
  });

  it('cross-instance lock: different repos not globally serialized', async () => {
    const clock = { now: 18_000_000 };
    const port = new FakePort(new Map(), {
      repos: { app: repo('app'), other: repo('other') },
    });
    port.releases.set('app', readyRelease({ repoKey: 'app' }));
    port.releases.set('other', readyRelease({ repoKey: 'other' }));
    const d = makeDeferred();
    const serviceA = new PromoteService({
      control: port,
      workspaces: makeWs(),
      deployRunner: d.runner,
      clock: () => clock.now,
      sleep: async () => {
        clock.now += 1000;
      },
    });
    const serviceB = new PromoteService({
      control: port,
      workspaces: makeWs(),
      deployRunner: d.runner,
      clock: () => clock.now,
      sleep: async () => {
        clock.now += 1000;
      },
    });
    const pApp = serviceA.promote('app');
    try {
      await d.enteredP;
      const other = await serviceB.promote('other');
      expect(other.outcome).toBe('ok');
    } finally {
      d.release();
    }
    expect((await pApp).outcome).toBe('ok');
  });
});
