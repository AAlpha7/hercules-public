/**
 * Release reconciler — fake deploy runner + fake clock (design §3 / release-4).
 *
 * Covers: debounce, promote-in-flight skip, health fail → failed, verify fail
 * → failed + evidence, success → ready + packet content, repos without deploy
 * untouched, scrubbed-env real runner wiring contract.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ReleaseReconciler,
  scrubbedDeployExec,
  makeDeployRunner,
  type DeployRunner,
  type StagingVerifyInput,
  type ReleaseWorkspaces,
} from '../../src/orchestrator/releaseReconciler.js';
import type { ControlPort, TickReport } from '../../src/orchestrator/orchestrator.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import type { Task } from '../../src/domain/task.js';
import type { RepoConfig, ReposConfig } from '../../src/domain/repos.js';
import {
  emptyRelease,
  type Release,
} from '../../src/domain/release.js';
import type { EvidenceRunSummary } from '../../src/domain/evidence.js';
import { scrubHerculesEnv } from '../../src/adapters/env.js';

const MAIN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PROD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OLD = 'cccccccccccccccccccccccccccccccccccccccc';

const WORKFLOW_WITH_STAGING = `---
gates:
  typecheck: echo ok
deploy:
  staging:
    command: ./scripts/deploy-staging.sh
    health: curl -sf http://localhost:8788/
    url: http://localhost:8788/
    verify:
      - unlock
      - assert: { selector: "[data-evidence=settings-panel]" }
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

function task(id: string, over: Partial<Task> = {}): Task {
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

function emptyReport(): TickReport {
  return {
    dispatched: [],
    completed: [],
    retried: [],
    failed: [],
    stalled: [],
    tornDown: [],
    recovered: [],
    running: [],
    thrashParked: [],
    provisionDiscarded: [],
    quietLong: [],
    sessionMetrics: { thrashParks: 0, quietLongSightings: 0 },
    stagingReconciled: [],
    promotesFinalized: [],
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
  deployExit = 0;
  deployOutput = 'deploy ok';
  healthExit = 0;
  healthOutput = 'HTTP 200';
  /** Number of health failures before success (for poll tests). */
  healthFailsBeforeOk = 0;
  private healthAttempts = 0;
  verifyResult: EvidenceRunSummary = {
    plan: { steps: [], source: 'workflow' },
    results: [],
    ok: true,
    screenshots: [],
  };
  /** When set, overrides verifyResult (for hang/timeout tests). */
  verifyImpl: ((input: StagingVerifyInput) => Promise<EvidenceRunSummary>) | null = null;
  verifyCalls: StagingVerifyInput[] = [];

  /** When set, hang until AbortSignal fires (deploy/health timeout tests). */
  hangUntilAbort = false;
  abortsSeen = 0;
  /** Optional override for run (receives signal). */
  runImpl: ((command: string, cwd: string, signal?: AbortSignal) => Promise<{ exitCode: number; output: string }>) | null =
    null;

  async run(command: string, cwd: string, opts?: { signal?: AbortSignal }) {
    this.commands.push({ command, cwd });
    if (this.runImpl) return this.runImpl(command, cwd, opts?.signal);

    if (this.hangUntilAbort) {
      return new Promise<{ exitCode: number; output: string }>((resolve) => {
        const signal = opts?.signal;
        if (!signal) {
          // Would hang forever in production without a signal — resolve to fail the test loudly.
          resolve({ exitCode: 1, output: 'hangUntilAbort without signal' });
          return;
        }
        if (signal.aborted) {
          this.abortsSeen += 1;
          resolve({ exitCode: 124, output: 'aborted' });
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            this.abortsSeen += 1;
            resolve({ exitCode: 124, output: 'aborted' });
          },
          { once: true },
        );
      });
    }

    if (command.includes('deploy-staging')) {
      return { exitCode: this.deployExit, output: this.deployOutput };
    }
    // health
    this.healthAttempts += 1;
    if (this.healthAttempts <= this.healthFailsBeforeOk) {
      return { exitCode: 1, output: 'not ready' };
    }
    return { exitCode: this.healthExit, output: this.healthOutput };
  }

  async verify(input: StagingVerifyInput): Promise<EvidenceRunSummary> {
    this.verifyCalls.push(input);
    if (this.verifyImpl) return this.verifyImpl(input);
    return this.verifyResult;
  }
}

function makeWs(opts: {
  workflow?: string | null;
  mainSha?: string | null;
  /** When set, the fake exposes a C3.51 refresh path that returns this tip. */
  refreshedMainSha?: string | null;
  rangeShas?: ReadonlySet<string>;
} = {}): ReleaseWorkspaces {
  return {
    async readWorkflow() {
      return opts.workflow === undefined ? WORKFLOW_WITH_STAGING : opts.workflow;
    },
    async defaultBranchHead() {
      return opts.mainSha === undefined ? MAIN : opts.mainSha;
    },
    ...(opts.refreshedMainSha !== undefined
      ? {
          async refreshDefaultBranchHead(this: ReleaseWorkspaces) {
            // Receiver-bound like the real GitWorkspaces method: an unbound
            // call would throw here and the reconciler must not swallow it.
            if (this === undefined) throw new Error('unbound refreshDefaultBranchHead');
            return opts.refreshedMainSha ?? null;
          },
        }
      : {}),
    deployCwd() {
      return '/tmp/fake-mirror';
    },
    async rangeShas() {
      return opts.rangeShas;
    },
  };
}

describe('ReleaseReconciler', () => {
  let clock: { now: number };
  let port: FakePort;
  let runner: FakeDeployRunner;
  let reconciler: ReleaseReconciler;
  const DEBOUNCE = 5 * 60 * 1000;

  beforeEach(() => {
    clock = { now: 0 };
    port = new FakePort(
      new Map([
        [
          't-a',
          task('t-a', {
            title: 'Alpha',
            mergedSha: 'sha-a-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          }),
        ],
        [
          't-b',
          task('t-b', {
            title: 'Beta',
            mergedSha: MAIN,
          }),
        ],
        [
          't-prod',
          task('t-prod', {
            title: 'Already in prod',
            mergedSha: PROD,
          }),
        ],
        [
          't-other',
          task('t-other', {
            title: 'Other repo',
            repo: 'other',
            mergedSha: MAIN,
          }),
        ],
      ]),
      { repos: { app: repo() } },
    );
    // Prior production only; staging stale.
    port.releases.set('app', {
      ...emptyRelease('app'),
      productionSha: PROD,
      productionDeployedAt: '2026-07-16T00:00:00.000Z',
      stagingSha: OLD,
      stagingStatus: 'ready',
      stagingVerifiedAt: '2026-07-16T12:00:00.000Z',
    });
    runner = new FakeDeployRunner();
    runner.verifyResult = {
      plan: {
        steps: [
          { kind: 'unlock' },
          { kind: 'assert', selector: '[data-evidence=settings-panel]' },
        ],
        source: 'workflow',
      },
      results: [
        { step: { kind: 'unlock' }, ok: true, detail: 'token injected' },
        {
          step: { kind: 'assert', selector: '[data-evidence=settings-panel]' },
          ok: true,
          detail: 'found',
        },
      ],
      ok: true,
      screenshots: [],
    };
    reconciler = new ReleaseReconciler({
      control: port,
      workspaces: makeWs({
        rangeShas: new Set([MAIN, 'sha-a-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']),
      }),
      deployRunner: runner,
      clock: () => clock.now,
      debounceMs: DEBOUNCE,
      sleep: async () => {
        // advance fake clock on each sleep so health timeout can elapse
        clock.now += 1_000;
      },
      healthTimeoutMs: 5_000,
      healthIntervalMs: 1_000,
      overallTimeoutMs: 15 * 60 * 1000,
      screenshotsRoot: '/tmp/hercules-release-shots',
      cleanupChrome: async () => {
        /* unit tests: no process scan */
      },
    });
  });

  async function snapshot(): Promise<ControlSnapshot> {
    return port.read();
  }

  it('does not deploy before debounce elapses', async () => {
    // First tick observes main advance at t=0
    const report1 = emptyReport();
    await reconciler.reconcile(await snapshot(), report1);
    expect(report1.stagingReconciled).toEqual([]);
    expect(runner.commands).toHaveLength(0);
    expect(port.releases.get('app')?.stagingStatus).toBe('ready');
    expect(port.releases.get('app')?.stagingSha).toBe(OLD);

    // Still inside debounce
    clock.now = DEBOUNCE - 1;
    const report2 = emptyReport();
    await reconciler.reconcile(await snapshot(), report2);
    expect(report2.stagingReconciled).toEqual([]);
    expect(runner.commands).toHaveLength(0);
  });

  it('deploys after debounce; success → ready + packet lists range tasks', async () => {
    // Observe main
    await reconciler.reconcile(await snapshot(), emptyReport());
    clock.now = DEBOUNCE;
    const report = emptyReport();
    await reconciler.reconcile(await snapshot(), report);

    expect(report.stagingReconciled).toEqual(['app']);
    const rel = port.releases.get('app')!;
    expect(rel.stagingStatus).toBe('ready');
    expect(rel.stagingSha).toBe(MAIN);
    expect(rel.stagingVerifiedAt).toBeTruthy();
    expect(rel.body).toContain('## Release packet');
    expect(rel.body).toContain('`t-a`: Alpha');
    expect(rel.body).toContain('`t-b`: Beta');
    // Must NOT list production-only stamp or other-repo tasks
    expect(rel.body).not.toContain('`t-prod`');
    expect(rel.body).not.toContain('`t-other`');
    expect(rel.body).toContain('deploy ok');
    expect(rel.body).toContain('HTTP 200');
    expect(rel.body).toContain('ready');
    expect(runner.verifyCalls).toHaveLength(1);
    expect(runner.verifyCalls[0]!.url).toBe('http://localhost:8788/');
    // Deploy then health
    expect(runner.commands.some((c) => c.command.includes('deploy-staging'))).toBe(true);
    expect(runner.commands.some((c) => c.command.includes('curl'))).toBe(true);
    expect(port.commits.some((m) => m.includes('staging ready'))).toBe(true);
  });

  it('orphaned persisted verifying (no in-flight worker) does not block a fresh run', async () => {
    // 2026-07-28: CDP hang left stagingStatus=verifying persisted; after the
    // daemon restarted, sameTipInProgress saw the stale status and skipped the
    // pipeline forever. Orphaned in-progress status must not survive restarts.
    port.releases.set('app', {
      ...emptyRelease('app'),
      stagingSha: MAIN,
      stagingStatus: 'verifying',
    });
    await reconciler.reconcile(await snapshot(), emptyReport());
    clock.now = DEBOUNCE;
    const report = emptyReport();
    await reconciler.reconcile(await snapshot(), report);
    expect(report.stagingReconciled).toEqual(['app']);
    expect(port.releases.get('app')?.stagingStatus).toBe('ready');
  });

  it('deployNow bypasses debounce', async () => {
    await reconciler.reconcile(await snapshot(), emptyReport());
    // still at t=0 — debounce would block
    reconciler.requestDeployNow('app');
    const report = emptyReport();
    await reconciler.reconcile(await snapshot(), report);
    expect(report.stagingReconciled).toEqual(['app']);
    expect(port.releases.get('app')?.stagingStatus).toBe('ready');
  });

  it('never runs while promoting_sha is set', async () => {
    port.releases.set('app', {
      ...port.releases.get('app')!,
      promotingSha: MAIN,
    });
    await reconciler.reconcile(await snapshot(), emptyReport());
    reconciler.requestDeployNow('app');
    clock.now = DEBOUNCE * 10;
    const report = emptyReport();
    await reconciler.reconcile(await snapshot(), report);
    expect(report.stagingReconciled).toEqual([]);
    expect(runner.commands).toHaveLength(0);
    expect(port.releases.get('app')?.stagingStatus).toBe('ready');
    expect(port.releases.get('app')?.stagingSha).toBe(OLD);
  });

  it('health fail → staging_status failed + packet', async () => {
    runner.healthExit = 1;
    runner.healthOutput = 'connection refused';
    await reconciler.reconcile(await snapshot(), emptyReport());
    clock.now = DEBOUNCE;
    // Keep clock advancing during health polls without overflowing absurdly
    const report = emptyReport();
    await reconciler.reconcile(await snapshot(), report);
    expect(report.stagingReconciled).toEqual(['app']);
    const rel = port.releases.get('app')!;
    expect(rel.stagingStatus).toBe('failed');
    expect(rel.stagingSha).toBe(MAIN);
    expect(rel.stagingVerifiedAt).toBeNull();
    expect(rel.body).toContain('failed');
    expect(rel.body).toContain('health check failed');
    expect(rel.body).toContain('connection refused');
    expect(runner.verifyCalls).toHaveLength(0);
  });

  it('verify fail → failed + evidence in packet', async () => {
    runner.verifyResult = {
      plan: {
        steps: [{ kind: 'assert', selector: '[data-evidence=settings-panel]' }],
        source: 'workflow',
      },
      results: [
        {
          step: {
            kind: 'assert',
            selector: '[data-evidence=settings-panel]',
            raw: 'assert sel=[data-evidence=settings-panel]',
          },
          ok: false,
          detail: 'element not found',
        },
      ],
      ok: false,
      screenshots: [],
    };
    await reconciler.reconcile(await snapshot(), emptyReport());
    clock.now = DEBOUNCE;
    const report = emptyReport();
    await reconciler.reconcile(await snapshot(), report);
    expect(report.stagingReconciled).toEqual(['app']);
    const rel = port.releases.get('app')!;
    expect(rel.stagingStatus).toBe('failed');
    expect(rel.body).toContain('staging evidence verify failed');
    expect(rel.body).toContain('element not found');
    expect(rel.body).toContain('✗');
    expect(runner.verifyCalls).toHaveLength(1);
  });

  it('deploy command fail → failed without health/verify', async () => {
    runner.deployExit = 1;
    runner.deployOutput = 'script exploded';
    await reconciler.reconcile(await snapshot(), emptyReport());
    clock.now = DEBOUNCE;
    const report = emptyReport();
    await reconciler.reconcile(await snapshot(), report);
    expect(port.releases.get('app')?.stagingStatus).toBe('failed');
    expect(port.releases.get('app')?.body).toContain('script exploded');
    // Only deploy command, no health
    expect(runner.commands).toHaveLength(1);
    expect(runner.verifyCalls).toHaveLength(0);
  });

  it('repos without deploy.staging are untouched', async () => {
    const noDeploy = new ReleaseReconciler({
      control: port,
      workspaces: makeWs({ workflow: WORKFLOW_NO_DEPLOY }),
      deployRunner: runner,
      clock: () => clock.now,
      debounceMs: DEBOUNCE,
    });
    // Seed empty so we can see no write
    port.releases.delete('app');
    await noDeploy.reconcile(await snapshot(), emptyReport());
    clock.now = DEBOUNCE;
    noDeploy.requestDeployNow('app');
    const report = emptyReport();
    await noDeploy.reconcile(await snapshot(), report);
    expect(report.stagingReconciled).toEqual([]);
    expect(port.releases.has('app')).toBe(false);
    expect(runner.commands).toHaveLength(0);
    expect(port.commits).toHaveLength(0);
  });

  it('skips when main tip is unavailable', async () => {
    const r = new ReleaseReconciler({
      control: port,
      workspaces: makeWs({ mainSha: null }),
      deployRunner: runner,
      clock: () => clock.now,
      debounceMs: DEBOUNCE,
    });
    r.requestDeployNow('app');
    await r.reconcile(await snapshot(), emptyReport());
    expect(runner.commands).toHaveLength(0);
  });

  it('judges drift on the refreshed origin tip, not the stale mirror tip (C3.51)', async () => {
    // Mirror says main == staging (no drift); origin has moved on to FRESH.
    const FRESH = 'f'.repeat(40);
    port.releases.set('app', {
      ...emptyRelease('app'),
      stagingSha: MAIN,
      stagingStatus: 'ready',
      productionSha: PROD,
    });
    const r = new ReleaseReconciler({
      control: port,
      workspaces: makeWs({ mainSha: MAIN, refreshedMainSha: FRESH, rangeShas: new Set() }),
      deployRunner: runner,
      clock: () => clock.now,
      debounceMs: DEBOUNCE,
    });
    r.requestDeployNow('app');
    await r.reconcile(await snapshot(), emptyReport());
    expect(runner.commands.length).toBeGreaterThan(0);
    expect(port.releases.get('app')?.stagingSha).toBe(FRESH);
  });

  it('refresh path returning null skips like an unavailable tip', async () => {
    const r = new ReleaseReconciler({
      control: port,
      workspaces: makeWs({ mainSha: MAIN, refreshedMainSha: null }),
      deployRunner: runner,
      clock: () => clock.now,
      debounceMs: DEBOUNCE,
    });
    r.requestDeployNow('app');
    await r.reconcile(await snapshot(), emptyReport());
    expect(runner.commands).toHaveLength(0);
  });

  it('skips when no drift (staging already at main)', async () => {
    port.releases.set('app', {
      ...emptyRelease('app'),
      stagingSha: MAIN,
      stagingStatus: 'ready',
      productionSha: PROD,
    });
    reconciler.requestDeployNow('app');
    clock.now = DEBOUNCE;
    const report = emptyReport();
    await reconciler.reconcile(await snapshot(), report);
    expect(report.stagingReconciled).toEqual([]);
    expect(runner.commands).toHaveLength(0);
  });

  it('stuck verifying past overall timeout → failed with stage attribution (no daemon restart)', async () => {
    const OVERALL = 60_000;
    const startedIso = new Date(0).toISOString();
    port.releases.set('app', {
      ...emptyRelease('app'),
      productionSha: PROD,
      stagingSha: MAIN,
      stagingStatus: 'verifying',
      stagingStartedAt: startedIso,
    });
    const stuckRec = new ReleaseReconciler({
      control: port,
      workspaces: makeWs(),
      deployRunner: runner,
      clock: () => clock.now,
      debounceMs: DEBOUNCE,
      overallTimeoutMs: OVERALL,
      cleanupChrome: async () => undefined,
    });
    clock.now = OVERALL; // exactly at budget
    const report = emptyReport();
    await stuckRec.reconcile(await snapshot(), report);
    expect(report.stagingReconciled).toEqual(['app']);
    const rel = port.releases.get('app')!;
    expect(rel.stagingStatus).toBe('failed');
    expect(rel.stagingStartedAt).toBeNull();
    expect(rel.body).toMatch(/timed out/i);
    expect(rel.body).toMatch(/evidence/i);
    // No new deploy attempted on the stuck-fail tick
    expect(runner.commands).toHaveLength(0);
  });

  it('failed status retries after debounce without tip drift', async () => {
    port.releases.set('app', {
      ...emptyRelease('app'),
      productionSha: PROD,
      stagingSha: MAIN,
      stagingStatus: 'failed',
      body: '## Release packet\n\n- **failure:** prior\n',
    });
    // Seed failedAt via a stuck-fail path is process-local; inject by running
    // deployNow which shouldRetryFailedStaging honors immediately.
    reconciler.requestDeployNow('app');
    const report = emptyReport();
    await reconciler.reconcile(await snapshot(), report);
    expect(report.stagingReconciled).toEqual(['app']);
    expect(port.releases.get('app')?.stagingStatus).toBe('ready');
    expect(runner.commands.length).toBeGreaterThan(0);
  });

  it('legacy verifying without staging_started_at force-fails then retries to ready', async () => {
    // Pre-upgrade stuck state: no started_at, same tip — must not sit forever.
    port.releases.set('app', {
      ...emptyRelease('app'),
      productionSha: PROD,
      stagingSha: MAIN,
      stagingStatus: 'verifying',
      stagingStartedAt: null,
    });
    const report1 = emptyReport();
    await reconciler.reconcile(await snapshot(), report1);
    expect(port.releases.get('app')?.stagingStatus).toBe('failed');
    expect(port.releases.get('app')?.body).toMatch(/staging_started_at|legacy/i);

    clock.now = DEBOUNCE;
    const report2 = emptyReport();
    await reconciler.reconcile(await snapshot(), report2);
    expect(report2.stagingReconciled).toEqual(['app']);
    expect(port.releases.get('app')?.stagingStatus).toBe('ready');
  });

  it('hung health probe is aborted under stage budget (does not wedge forever)', async () => {
    runner.hangUntilAbort = true;
    // Only hang health, not deploy — intercept runImpl.
    runner.hangUntilAbort = false;
    runner.runImpl = async (command, _cwd, signal) => {
      if (command.includes('deploy-staging')) {
        return { exitCode: 0, output: 'deploy ok' };
      }
      return new Promise((resolve) => {
        if (!signal) {
          resolve({ exitCode: 1, output: 'no signal' });
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            runner.abortsSeen += 1;
            resolve({ exitCode: 124, output: 'health aborted' });
          },
          { once: true },
        );
      });
    };

    await reconciler.reconcile(await snapshot(), emptyReport());
    clock.now = DEBOUNCE;
    const report = emptyReport();
    await reconciler.reconcile(await snapshot(), report);

    expect(report.stagingReconciled).toEqual(['app']);
    expect(port.releases.get('app')?.stagingStatus).toBe('failed');
    expect(runner.abortsSeen).toBeGreaterThan(0);
    // failureReason must attribute the health stage (not a generic fail).
    expect(port.releases.get('app')?.body).toMatch(/staging health timed out/i);
  });

  it('deploy timeout aborts the deploy command signal', async () => {
    runner.runImpl = async (command, _cwd, signal) => {
      if (!command.includes('deploy-staging')) {
        return { exitCode: 0, output: 'ok' };
      }
      return new Promise((resolve) => {
        if (!signal) {
          resolve({ exitCode: 1, output: 'no signal' });
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            runner.abortsSeen += 1;
            resolve({ exitCode: 124, output: 'deploy aborted' });
          },
          { once: true },
        );
      });
    };

    const rec = new ReleaseReconciler({
      control: port,
      workspaces: makeWs(),
      deployRunner: runner,
      clock: () => clock.now,
      debounceMs: DEBOUNCE,
      sleep: async () => {
        clock.now += 1_000;
      },
      overallTimeoutMs: 3_000,
      stageTimeoutMs: { deploy: 2_000, health: 60_000, evidence: 60_000 },
      cleanupChrome: async () => undefined,
    });
    await rec.reconcile(await snapshot(), emptyReport());
    clock.now = DEBOUNCE;
    const report = emptyReport();
    await rec.reconcile(await snapshot(), report);
    expect(port.releases.get('app')?.stagingStatus).toBe('failed');
    expect(runner.abortsSeen).toBeGreaterThan(0);
    expect(port.releases.get('app')?.body).toMatch(/deploy|timed out/i);
  });

  it('evidence stage timeout → failed with evidence attribution + chrome cleanup', async () => {
    const cleanups: string[] = [];
    const gate: { resolve: ((v: EvidenceRunSummary) => void) | undefined } = {
      resolve: undefined,
    };
    runner.verifyImpl = () =>
      new Promise<EvidenceRunSummary>((resolve) => {
        gate.resolve = resolve;
      });

    const OVERALL = 5_000;
    const rec = new ReleaseReconciler({
      control: port,
      workspaces: makeWs({
        rangeShas: new Set([MAIN, 'sha-a-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']),
      }),
      deployRunner: runner,
      clock: () => clock.now,
      debounceMs: DEBOUNCE,
      sleep: async () => {
        clock.now += 1_000;
      },
      healthTimeoutMs: 2_000,
      overallTimeoutMs: OVERALL,
      stageTimeoutMs: { evidence: 3_000, deploy: 60_000, health: 2_000 },
      cleanupChrome: async () => {
        cleanups.push(`t=${clock.now}`);
      },
      screenshotsRoot: '/tmp/hercules-release-shots',
    });

    await rec.reconcile(await snapshot(), emptyReport());
    clock.now = DEBOUNCE;
    const report = emptyReport();
    const done = rec.reconcile(await snapshot(), report);
    // Hang verify until raceStage advances past evidence budget
    await done;
    // Don't leave the hanging promise forever
    gate.resolve?.({
      plan: { steps: [], source: 'workflow' },
      results: [],
      ok: true,
      screenshots: [],
    });

    expect(report.stagingReconciled).toEqual(['app']);
    const rel = port.releases.get('app')!;
    expect(rel.stagingStatus).toBe('failed');
    expect(rel.body).toMatch(/timed out/i);
    expect(rel.body).toMatch(/evidence|overall/i);
    expect(cleanups.length).toBeGreaterThan(0);
  });
});

describe('scrubbedDeployExec / makeDeployRunner', () => {
  it('scrubHerculesEnv strips HERCULES_* keys (contract for real children)', () => {
    const scrubbed = scrubHerculesEnv({
      HERCULES_TOKEN: 'secret',
      HERCULES_WORK_DIR: '/prod',
      PATH: '/usr/bin',
      HOME: '/home/u',
    });
    expect(scrubbed['HERCULES_TOKEN']).toBeUndefined();
    expect(scrubbed['HERCULES_WORK_DIR']).toBeUndefined();
    expect(scrubbed['PATH']).toBe('/usr/bin');
    expect(scrubbed['HOME']).toBe('/home/u');
  });

  it('makeDeployRunner wires verify; empty steps short-circuit ok', async () => {
    let verifyCalled = false;
    const runner = makeDeployRunner(async () => {
      verifyCalled = true;
      return {
        plan: { steps: [], source: 'workflow' },
        results: [],
        ok: false,
        screenshots: [],
      };
    });
    const empty = await runner.verify({
      repoKey: 'app',
      url: 'http://x',
      steps: [],
      screenshotDir: '/tmp',
    });
    expect(empty.ok).toBe(true);
    expect(verifyCalled).toBe(false);
  });

  it('exports scrubbedDeployExec as a function (no real deploy in unit tests)', () => {
    expect(typeof scrubbedDeployExec).toBe('function');
  });
});

