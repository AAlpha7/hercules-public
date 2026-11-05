/**
 * Regression pack — onboard failure modes that burned
 * `orbit-repo-readiness-onboarding` (2026-07).
 *
 * Three orbit-class holes, locked so they cannot regress silently:
 * 1. Provision checkout race — re-create with existing worktree/branch must
 *    reattach (never full-heads fetch into a checked-out hercules tip).
 * 2. Stall-during-long-gate — stream silence while processAlive must not kill
 *    cargo/pnpm runs; hard maxRunMs remains the deadlock backstop.
 * 3. Attempt-burn policy — failure-kind counters: stall soft (no burn),
 *    provision/agent_exit burn, thrash/hard-infra park early.
 *
 * Hermetic: real temp git for provision, fake clock + FakeAdapter for stall
 * and retry accounting. No live network.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import {
  DEFAULT_KIND_POLICY,
  decideRetry,
  kindBackoffMs,
  type DecideRetryInput,
} from '../../src/domain/retryPolicy.js';
import { evaluateStall } from '../../src/domain/stall.js';
import { buildRunFailureSection } from '../../src/domain/runFailure.js';
import type { Task, TaskState } from '../../src/domain/task.js';
import type { ReposConfig, RepoConfig } from '../../src/domain/repos.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import { makeConfig } from '../../src/config.js';
import { AgentRegistry } from '../../src/orchestrator/agentRegistry.js';
import { FakeAdapter } from '../../src/orchestrator/fakeAdapter.js';
import {
  Orchestrator,
  type ControlPort,
} from '../../src/orchestrator/orchestrator.js';
import { GitWorkspaces } from '../../src/isolation/worktree.js';
import { PortAllocator } from '../../src/isolation/ports.js';

// ── shared harness ──────────────────────────────────────────────────────────

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    repo: 'app',
    state: 'todo' as TaskState,
    priority: 100,
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
    body: 'body',
    ...over,
  };
}

class FakePort implements ControlPort {
  readonly commits: string[] = [];
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
}

function setupOrch(
  tasks: Task[],
  opts: {
    adapter?: FakeAdapter;
    config?: Parameters<typeof makeConfig>[1];
  } = {},
): {
  orch: Orchestrator;
  port: FakePort;
  adapter: FakeAdapter;
  clock: { now: number };
} {
  const repos: ReposConfig = {
    repos: {
      app: {
        key: 'app',
        url: 'x',
        defaultBranch: 'main',
        workflow: 'WORKFLOW.md',
        maxConcurrent: 1,
        adapter: null,
        readiness: 'ready',
      },
    },
  };
  const port = new FakePort(new Map(tasks.map((t) => [t.id, t])), repos);
  const adapter = opts.adapter ?? new FakeAdapter({ durationMs: 100 });
  const clock = { now: 0 };
  const orch = new Orchestrator({
    config: makeConfig('/ctrl', opts.config),
    control: port,
    agents: AgentRegistry.of(adapter),
    clock: () => clock.now,
  });
  return { orch, port, adapter, clock };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ── 1. Provision checkout race ──────────────────────────────────────────────

describe('onboard reliability — provision retry with existing worktree/branch', () => {
  let tmp: string;
  let root: string;
  let repo: RepoConfig;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'hercules-onboard-rel-'));
    root = join(tmp, 'root');
    await mkdir(root, { recursive: true });

    const targetUrl = join(tmp, 'target');
    await mkdir(targetUrl, { recursive: true });
    const g = simpleGit(targetUrl);
    await g.init(['-b', 'main']);
    await g.addConfig('user.email', 't@h.local');
    await g.addConfig('user.name', 'T');
    await writeFile(join(targetUrl, 'README.md'), '# target\n');
    await writeFile(
      join(targetUrl, 'WORKFLOW.md'),
      '---\ngates:\n  test: pnpm test\n---\nbe careful\n',
    );
    await g.add('.');
    await g.commit('initial');

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

  it('re-create with live worktree still on disk reattaches without fetch fatal', async () => {
    // orbit-repo-readiness-onboarding: crash left worktree + hercules branch;
    // next provision must reattach, not `fetch` into the checked-out tip.
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(4100, 4) });
    const first = await ws.create(repo, 'orbit-repo-readiness-onboarding');
    await writeFile(join(first.dir, 'partial.txt'), 'agent mid-work\n');

    const mirrorPath = join(root, '.mirrors', 'app.git');
    const mirror = simpleGit(mirrorPath);
    // Document the pre-fix hole: writing into a checked-out hercules tip fatals.
    let controlFatal = '';
    try {
      await mirror.raw([
        'fetch',
        'origin',
        '+refs/heads/main:refs/heads/hercules/orbit-repo-readiness-onboarding',
      ]);
    } catch (err) {
      controlFatal = (err as Error).message;
    }
    expect(controlFatal).toMatch(/refusing to fetch into branch|checked out/i);

    // Simulate daemon crash: drop live map, leave worktree on disk.
    (ws as unknown as { live: Map<string, unknown> }).live.clear();

    const again = await ws.create(repo, 'orbit-repo-readiness-onboarding');
    expect(again.dir).toBe(first.dir);
    expect(again.branch).toBe('hercules/orbit-repo-readiness-onboarding');
    expect(await pathExists(join(again.dir, 'partial.txt'))).toBe(true);
    expect(await pathExists(join(again.dir, 'README.md'))).toBe(true);
  }, 20_000);

  it('preserve then re-create reuses origin task branch without fatal', async () => {
    const seed = join(tmp, 'seed');
    const bare = join(tmp, 'bare.git');
    await mkdir(seed, { recursive: true });
    const sg = simpleGit(seed);
    await sg.init(['-b', 'main']);
    await sg.addConfig('user.email', 't@h.local');
    await sg.addConfig('user.name', 'T');
    await writeFile(join(seed, 'README.md'), '# seed\n');
    await sg.add('.');
    await sg.commit('seed');
    await simpleGit(tmp).clone(seed, bare, ['--bare']);

    const remoteRepo: RepoConfig = { ...repo, url: bare };
    const ws = new GitWorkspaces({
      root,
      ports: new PortAllocator(4100, 4),
      push: true,
    });
    const w = await ws.create(remoteRepo, 'ONBOARD-PROV');
    const git = simpleGit(w.dir);
    await git.addConfig('user.email', 'a@h.local');
    await git.addConfig('user.name', 'Agent');
    await writeFile(join(w.dir, 'salvage.txt'), 'kept\n');
    await git.add(['-A']);
    await git.raw([
      '-c',
      'user.email=a@h.local',
      '-c',
      'user.name=Agent',
      'commit',
      '-m',
      'hercules: ONBOARD-PROV — salvage',
    ]);
    await ws.preserve('ONBOARD-PROV', 'hercules: ONBOARD-PROV — pin');

    const again = await ws.create(remoteRepo, 'ONBOARD-PROV');
    expect(again.branch).toBe('hercules/ONBOARD-PROV');
    expect(await pathExists(join(again.dir, 'salvage.txt'))).toBe(true);
  }, 20_000);
});

// ── 2. Stall policy (silent-but-alive) ──────────────────────────────────────

describe('onboard reliability — stall does not kill silent-alive runs', () => {
  it('domain: processAlive skips idle stall past timeout (cargo/pnpm silence)', () => {
    // Pure policy lock — if someone reverts evaluateStall to stall on silence
    // alone, this fails even before orchestrator wiring.
    const d = evaluateStall({
      nowMs: 15 * 60_000,
      lastEventAt: 0,
      startedAtMs: 0,
      processAlive: true,
      stallTimeoutMs: 10 * 60_000,
      maxRunMs: 2 * 60 * 60_000,
    });
    expect(d.action).toBe('continue');
    expect(d.reason).toMatch(/process alive/i);
  });

  it('domain: truly dead process idle-stalls; hard max still kills alive deadlocks', () => {
    const idle = evaluateStall({
      nowMs: 15 * 60_000,
      lastEventAt: 0,
      startedAtMs: 0,
      processAlive: false,
      stallTimeoutMs: 10 * 60_000,
      maxRunMs: 2 * 60 * 60_000,
    });
    expect(idle.action).toBe('idle_stall');

    const hard = evaluateStall({
      nowMs: 3 * 60 * 60_000,
      lastEventAt: 0,
      startedAtMs: 0,
      processAlive: true,
      stallTimeoutMs: 10 * 60_000,
      maxRunMs: 2 * 60 * 60_000,
    });
    expect(hard.action).toBe('hard_max_run');
  });

  it('orchestrator + fake clock: hang + processAlive stays in_progress past stallTimeout', async () => {
    const adapter = new FakeAdapter({
      durationMs: 100_000,
      hang: true,
      processAlive: true,
      aliveHint: 'pnpm',
    });
    const { orch, port, clock } = setupOrch([task('A')], {
      adapter,
      config: { stallTimeoutMs: 1_000, maxRunMs: 60_000 },
    });
    await orch.tick();
    expect(port.tasks.get('A')!.state).toBe('in_progress');

    // Past stall timeout, under hard max — long gate with zero stream events.
    clock.now = 5_000;
    const report = await orch.tick();
    expect(report.stalled).toEqual([]);
    expect(port.tasks.get('A')!.state).toBe('in_progress');
    expect(adapter.stopped).toEqual([]);
  });

  it('orchestrator + fake clock: hang without processAlive is stalled and stopped', async () => {
    const adapter = new FakeAdapter({ durationMs: 100_000, hang: true });
    const { orch, port, clock } = setupOrch([task('A')], {
      adapter,
      config: { stallTimeoutMs: 1_000, maxRunMs: 60_000 },
    });
    await orch.tick();
    clock.now = 5_000;
    const report = await orch.tick();
    expect(report.stalled).toEqual(['A']);
    expect(port.tasks.get('A')!.state).toBe('retrying');
    expect(adapter.stopped).toContainEqual({ id: 'A', force: false });
  });

  it('orchestrator + fake clock: maxRunMs force-kills even when processAlive', async () => {
    const adapter = new FakeAdapter({
      durationMs: 100_000,
      hang: true,
      processAlive: true,
    });
    const { orch, port, clock } = setupOrch([task('A')], {
      adapter,
      config: { stallTimeoutMs: 1_000, maxRunMs: 2_000 },
    });
    await orch.tick();
    clock.now = 2_500;
    const report = await orch.tick();
    expect(report.stalled).toEqual(['A']);
    expect(port.tasks.get('A')!.body).toMatch(/hard max run/i);
    expect(adapter.stopped.some((s) => s.id === 'A' && s.force === true)).toBe(
      true,
    );
  });
});

// ── 3. Failure-kind retry counters (attempt burn) ───────────────────────────

describe('onboard reliability — failure-kind retry counters', () => {
  const base: DecideRetryInput = {
    kind: 'agent_exit',
    attempts: 0,
    maxAttempts: 3,
    body: '',
    nowMs: 1_000_000,
    backoffBaseMs: 30_000,
  };

  it('policy table encodes orbit-class burn modes (lock against silent revert)', () => {
    // If someone "simplifies" to always-burn, soft stall resume dies again.
    expect(DEFAULT_KIND_POLICY.stall.burnMode).toBe('after_soft');
    expect(DEFAULT_KIND_POLICY.stall.softLimit).toBe(2);
    expect(DEFAULT_KIND_POLICY.stall.thrashLimit).toBe(0);
    expect(DEFAULT_KIND_POLICY.provision.burnMode).toBe('always');
    expect(DEFAULT_KIND_POLICY.provision.thrashLimit).toBe(2);
    expect(DEFAULT_KIND_POLICY.agent_exit.burnMode).toBe('always');
    expect(DEFAULT_KIND_POLICY.agent_exit.thrashLimit).toBe(2);
  });

  it('stall soft retries do not burn attempts; provision and agent_exit do', () => {
    const stall = decideRetry({ ...base, kind: 'stall', attempts: 1 });
    expect(stall.outcome).toBe('retry');
    expect(stall.burnedAttempt).toBe(false);
    expect(stall.attemptsAfter).toBe(1);
    expect(stall.accounting).toMatch(/soft|no burn/i);

    const provision = decideRetry({ ...base, kind: 'provision', attempts: 0 });
    expect(provision.burnedAttempt).toBe(true);
    expect(provision.attemptsAfter).toBe(1);
    expect(provision.backoffMs).toBeLessThan(
      kindBackoffMs('agent_exit', 1, base.backoffBaseMs),
    );

    const exit = decideRetry({ ...base, kind: 'agent_exit', attempts: 0 });
    expect(exit.burnedAttempt).toBe(true);
    expect(exit.attemptsAfter).toBe(1);
  });

  it('stall burns only after softLimit consecutive stalls', () => {
    const softLimit = DEFAULT_KIND_POLICY.stall.softLimit;
    expect(softLimit).toBe(2);
    const prior = [1, 2]
      .map((i) =>
        buildRunFailureSection({
          stamp: `t${i}`,
          kind: 'stall',
          attempt: 1,
          maxAttempts: 3,
        }),
      )
      .join('\n');
    const d = decideRetry({
      ...base,
      kind: 'stall',
      attempts: 1,
      maxAttempts: 3,
      body: prior,
    });
    expect(d.kindStreak).toBe(3);
    expect(d.burnedAttempt).toBe(true);
    expect(d.attemptsAfter).toBe(2);
  });

  it('provision thrash parks at consecutive limit without burning full budget', () => {
    const prior = buildRunFailureSection({
      stamp: 't1',
      kind: 'provision',
      attempt: 1,
      maxAttempts: 5,
    });
    const d = decideRetry({
      ...base,
      kind: 'provision',
      attempts: 1,
      maxAttempts: 5,
      body: prior,
    });
    expect(d.outcome).toBe('fail');
    expect(d.parkedReason).toBe('thrash');
    expect(d.kindStreak).toBe(2);
    expect(d.attemptsAfter).toBe(2);
  });

  it('hard infra provision parks immediately (no retry loop on ENOSPC)', () => {
    const d = decideRetry({
      ...base,
      kind: 'provision',
      attempts: 0,
      maxAttempts: 3,
      detail: 'ENOSPC: no space left on device',
    });
    expect(d.outcome).toBe('fail');
    expect(d.parkedReason).toBe('hard_infra');
    expect(d.nextEligibleAt).toBeNull();
  });

  it('orchestrator: first stall soft-retry keeps attempts at 0', async () => {
    const adapter = new FakeAdapter({ durationMs: 100, hang: true });
    const { orch, port, clock } = setupOrch([task('A')], {
      adapter,
      config: { stallTimeoutMs: 1_000, maxAttempts: 3 },
    });
    await orch.tick();
    clock.now = 1_500;
    await orch.tick();
    const a = port.tasks.get('A')!;
    expect(a.state).toBe('retrying');
    expect(a.attempts).toBe(0);
    expect(a.body).toMatch(/Kind:\*\* `stall`/);
    expect(a.body).toMatch(/Attempt accounting:.*soft|no burn/i);
    expect(a.body).toMatch(/Next eligible:/);
  });

  it('orchestrator: agent_exit burns an attempt and records accounting', async () => {
    const adapter = new FakeAdapter({ durationMs: 10, fail: true });
    const { orch, port, clock } = setupOrch([task('A')], {
      adapter,
      config: { maxAttempts: 3, backoffBaseMs: 1 },
    });
    await orch.tick();
    clock.now = 10;
    await orch.tick();
    const a = port.tasks.get('A')!;
    expect(a.state).toBe('retrying');
    expect(a.attempts).toBe(1);
    expect(a.body).toMatch(/Kind:\*\* `agent_exit`/);
    expect(a.body).toMatch(/Attempt accounting:.*burn/i);
  });
});
