import { describe, it, expect } from 'vitest';
import {
  selectEligible,
  explainIneligible,
  costWeight,
  HEAVY_COST_WEIGHT,
  HEAVY_TASK_LABELS,
  brokenDependencies,
  pendingDependencies,
  mergeBlockedDependencies,
  type SchedulingHoldReason,
  type SchedulingState,
} from '../../src/domain/scheduling.js';
import type { Task, TaskState } from '../../src/domain/task.js';
import type { ReposConfig } from '../../src/domain/repos.js';

// Generous per-repo cap so these fixtures isolate the rule under test;
// the dedicated cap tests use reposWithCaps().
function repos(...keys: string[]): ReposConfig {
  const entries = keys.map((key) => [
    key,
    { key, url: 'x', defaultBranch: 'main', workflow: 'WORKFLOW.md', maxConcurrent: 10, adapter: null, readiness: 'ready' },
  ]);
  return { repos: Object.fromEntries(entries) };
}

function reposWithCaps(caps: Record<string, number>): ReposConfig {
  const entries = Object.entries(caps).map(([key, maxConcurrent]) => [
    key,
    {
      key,
      url: 'x',
      defaultBranch: 'main',
      workflow: 'WORKFLOW.md',
      maxConcurrent,
      adapter: null,
      readiness: 'ready' as const,
    },
  ]);
  return { repos: Object.fromEntries(entries) };
}

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
    lastEventAt: null, createdAt: null, startedAt: null, endedAt: null,
    prUrl: null,
    prStatus: null,
    planPending: false,
    body: '',
    ...over,
  };
}

const base = { globalCap: 10, backoffBaseMs: 1000, now: 1_000_000 };

describe('adapter crash hold (C3.60)', () => {
  it('holds a task whose adapter process is crashing, and releases it when the hold lapses', () => {
    const base = {
      tasks: [task('T-CRASH', { state: 'todo', repo: 'app' })],
      repos: repos('app'),
      runningTaskIds: new Set<string>(),
      globalCap: 4,
      defaultKind: 'grok' as const,
      backoffBaseMs: 1000,
      now: 10_000,
    };
    const holds = new Map([['grok' as const, { untilMs: 60_000, detail: 'grok crashed (SIGILL)' }]]);
    expect(explainIneligible({ ...base, adapterCrashHolds: holds }).get('T-CRASH')).toMatchObject({
      code: 'adapter_crashing', adapter: 'grok', untilMs: 60_000,
    });
    expect(selectEligible({ ...base, adapterCrashHolds: holds })).toEqual([]);
    // Expired hold: the task dispatches again without operator action.
    expect(selectEligible({ ...base, now: 60_001, adapterCrashHolds: holds }).map((t) => t.id))
      .toEqual(['T-CRASH']);
    // No hold at all: unchanged behaviour.
    expect(selectEligible(base).map((t) => t.id)).toEqual(['T-CRASH']);
  });
});

describe('selectEligible — plan pending + readiness', () => {
  it('skips planPending drafts (G5)', () => {
    const tasks = [task('A', { planPending: true }), task('B')];
    const got = selectEligible({
      tasks,
      repos: repos('app'),
      runningTaskIds: new Set(),
      ...base,
    });
    expect(got.map((t) => t.id)).toEqual(['B']);
  });

  it('skips host_operation / deploy until human approval + command scope (P0)', () => {
    const tasks = [
      task('H-bare', { executionClass: 'host_operation' }),
      task('H-scope-only', {
        executionClass: 'host_operation',
        hostCommandScope: ['systemctl restart hercules'],
      }),
      task('H-ok', {
        executionClass: 'host_operation',
        hostCommandScope: ['systemctl restart hercules'],
        hostApprovedAt: '2026-07-31T12:00:00.000Z',
      }),
      task('D-bare', { executionClass: 'deploy' }),
      task('CODE', { executionClass: 'implement' }),
      task('LEGACY'),
    ];
    const got = selectEligible({
      tasks,
      repos: repos('app'),
      runningTaskIds: new Set(),
      ...base,
    });
    expect(got.map((t) => t.id).sort()).toEqual(['CODE', 'H-ok', 'LEGACY']);
  });

  it('incomplete repo only admits onboarding labels (G8)', () => {
    const reposCfg: ReposConfig = {
      repos: {
        app: {
          key: 'app',
          url: 'x',
          defaultBranch: 'main',
          workflow: 'WORKFLOW.md',
          maxConcurrent: 10,
          adapter: null,
          readiness: 'incomplete',
        },
      },
    };
    const tasks = [
      task('feat', { labels: ['ui'] }),
      task('onb', { labels: ['onboarding'] }),
    ];
    const got = selectEligible({
      tasks,
      repos: reposCfg,
      runningTaskIds: new Set(),
      ...base,
    });
    expect(got.map((t) => t.id)).toEqual(['onb']);
  });
});

describe('selectEligible — provision-failure backoff (C3.49)', () => {
  it('holds a never-started task whose provisioning failed until its backoff expires, with the error as detail', () => {
    const tasks = [task('A'), task('B')];
    const held = new Map([['A', { untilMs: base.now + 60_000, detail: 'exact candidate conflicts with unique local branch tip', failures: 1 }]]);
    const state: SchedulingState = {
      tasks, repos: repos('app'), runningTaskIds: new Set(), provisionBackoff: held, ...base,
    };
    expect(selectEligible(state).map((t) => t.id)).toEqual(['B']);
    expect(explainIneligible(state).get('A')).toEqual({
      code: 'provision_failed', untilMs: base.now + 60_000, detail: 'exact candidate conflicts with unique local branch tip',
    });
    // Expired hold: eligible again, no hold reported.
    const expired: SchedulingState = { ...state, now: base.now + 60_000 };
    expect(selectEligible(expired).map((t) => t.id)).toEqual(['A', 'B']);
    expect(explainIneligible(expired).has('A')).toBe(false);
  });

  it('backoff grows 5 → 10 → 20 → 40 → 60 min and caps', async () => {
    const { provisionBackoffMs } = await import('../../src/domain/scheduling.js');
    expect([1, 2, 3, 4, 5, 9].map((n) => provisionBackoffMs(n) / 60_000)).toEqual([5, 10, 20, 40, 60, 60]);
  });
});

describe('selectEligible — basic eligibility', () => {
  it('selects todo tasks, ordered by priority then id', () => {
    const tasks = [
      task('C', { priority: 1 }),
      task('A', { priority: 5 }),
      task('B', { priority: 1 }),
    ];
    const out = selectEligible({ ...base, tasks, repos: repos('app'), runningTaskIds: new Set() });
    expect(out.map((t) => t.id)).toEqual(['B', 'C', 'A']);
  });

  it('ignores non-todo/retrying states', () => {
    const tasks = [
      task('A', { state: 'in_progress' }),
      task('B', { state: 'review' }),
      task('C', { state: 'done' }),
      task('D', { state: 'todo' }),
    ];
    const out = selectEligible({ ...base, tasks, repos: repos('app'), runningTaskIds: new Set() });
    expect(out.map((t) => t.id)).toEqual(['D']);
  });

  it('excludes tasks already running', () => {
    const tasks = [task('A'), task('B')];
    const out = selectEligible({
      ...base,
      tasks,
      repos: repos('app'),
      runningTaskIds: new Set(['A']),
    });
    expect(out.map((t) => t.id)).toEqual(['B']);
  });

  it('excludes tasks referencing an unknown repo', () => {
    const tasks = [task('A', { repo: 'ghost' }), task('B', { repo: 'app' })];
    const out = selectEligible({ ...base, tasks, repos: repos('app'), runningTaskIds: new Set() });
    expect(out.map((t) => t.id)).toEqual(['B']);
  });
});

describe('selectEligible — blocked_by (SPEC §3.2)', () => {
  it('blocks while a dependency is non-terminal', () => {
    const tasks = [task('DEP', { state: 'in_progress' }), task('A', { blockedBy: ['DEP'] })];
    const out = selectEligible({ ...base, tasks, repos: repos('app'), runningTaskIds: new Set() });
    expect(out.map((t) => t.id)).toEqual([]);
  });

  it('keeps same-repo implement blocked after Approve-only done (gate-merge barrier)', () => {
    // Approve alone must not unlock code consumers — Merge Selected required.
    const tasks = [task('DEP', { state: 'done' }), task('A', { blockedBy: ['DEP'] })];
    const out = selectEligible({ ...base, tasks, repos: repos('app'), runningTaskIds: new Set() });
    expect(out.map((t) => t.id)).toEqual([]);
  });

  // L5 title preserved: terminal success alone is not enough for same-repo
  // implement — gate merge metadata is required (see gate-merge barrier).
  it('unblocks once every dependency is terminal', () => {
    const tasks = [
      task('DEP', {
        state: 'done',
        mergedSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        mergedVia: 'gate',
        verifiedSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }),
      task('A', { blockedBy: ['DEP'] }),
    ];
    const out = selectEligible({ ...base, tasks, repos: repos('app'), runningTaskIds: new Set() });
    expect(out.map((t) => t.id)).toEqual(['A']);
  });

  it('unblocks completion_only explore dependents on done without merge stamps', () => {
    const tasks = [
      task('DEP', { state: 'done' }),
      task('A', {
        blockedBy: ['DEP'],
        dependencyMode: 'completion_only',
        executionClass: 'explore',
      }),
    ];
    const out = selectEligible({ ...base, tasks, repos: repos('app'), runningTaskIds: new Set() });
    expect(out.map((t) => t.id)).toEqual(['A']);
  });

  it('rejects same-repo implement completion_only override (still needs gate merge)', () => {
    const tasks = [
      task('DEP', { state: 'done' }),
      task('A', {
        blockedBy: ['DEP'],
        dependencyMode: 'completion_only',
        executionClass: 'implement',
      }),
    ];
    const out = selectEligible({ ...base, tasks, repos: repos('app'), runningTaskIds: new Set() });
    expect(out.map((t) => t.id)).toEqual([]);
  });

  it('unblocks cross-repo implement on done (completion_only inference)', () => {
    const tasks = [
      task('DEP', { state: 'done', repo: 'lib' }),
      task('A', { blockedBy: ['DEP'], repo: 'app' }),
    ];
    const out = selectEligible({
      ...base,
      tasks,
      repos: repos('app', 'lib'),
      runningTaskIds: new Set(),
    });
    expect(out.map((t) => t.id)).toEqual(['A']);
  });

  it('holds operator-merged upstream for same-repo implement', () => {
    const tasks = [
      task('DEP', {
        state: 'done',
        mergedSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        mergedVia: 'operator',
        verifiedSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }),
      task('A', { blockedBy: ['DEP'] }),
    ];
    const out = selectEligible({ ...base, tasks, repos: repos('app'), runningTaskIds: new Set() });
    expect(out.map((t) => t.id)).toEqual([]);
  });

  it('unblocks same-repo implement after observed factory PR merge', () => {
    const tasks = [
      task('DEP', {
        state: 'done',
        adapter: 'cursor',
        prStatus: 'merged',
        mergedSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        mergedVia: 'operator',
        verifiedSha: null,
      }),
      task('A', { blockedBy: ['DEP'] }),
    ];
    const out = selectEligible({ ...base, tasks, repos: repos('app'), runningTaskIds: new Set() });
    expect(out.map((t) => t.id)).toEqual(['A']);
  });

  it('blocks when the dependency id is unknown (safe default)', () => {
    const tasks = [task('A', { blockedBy: ['MISSING'] })];
    const out = selectEligible({ ...base, tasks, repos: repos('app'), runningTaskIds: new Set() });
    expect(out.map((t) => t.id)).toEqual([]);
  });

  it('excludeTaskIds soft-blocks without counting as running (admission refill)', () => {
    const tasks = [
      task('BLOCKED', { priority: 1 }),
      task('OTHER', { priority: 50, repo: 'other' }),
    ];
    const first = selectEligible({
      ...base,
      globalCap: 1,
      tasks,
      repos: repos('app', 'other'),
      runningTaskIds: new Set(),
    });
    expect(first.map((t) => t.id)).toEqual(['BLOCKED']);
    const refilled = selectEligible({
      ...base,
      globalCap: 1,
      tasks,
      repos: repos('app', 'other'),
      runningTaskIds: new Set(),
      excludeTaskIds: new Set(['BLOCKED']),
    });
    expect(refilled.map((t) => t.id)).toEqual(['OTHER']);
  });

  it('holds when a dependency FAILED — terminal is not success (R3 incident 2026-07-22)', () => {
    // R2 parked failed → "terminal" vacuously satisfied R3's blocked_by → R3
    // dispatched without R2's merged work and had to cherry-pick a failed
    // task's commits. A failed/cancelled dependency needs a human decision
    // (retry it, or edit blocked_by), never a silent green light.
    for (const state of ['failed', 'cancelled', 'deleted'] as const) {
      const tasks = [task('DEP', { state }), task('A', { blockedBy: ['DEP'] })];
      const out = selectEligible({ ...base, tasks, repos: repos('app'), runningTaskIds: new Set() });
      expect(out.map((t) => t.id), `dep state=${state}`).toEqual([]);
    }
  });

  it('pendingDependencies lists healthy-but-unfinished deps (waiting hint, not alarm)', () => {
    const all = [
      task('DONE1', { state: 'done' }),
      task('REVIEWING', { state: 'review' }),
      task('BROKEN', { state: 'failed' }),
      task('A', { blockedBy: ['DONE1', 'REVIEWING', 'BROKEN'] }),
    ];
    expect(pendingDependencies(all[3]!, all)).toEqual([{ id: 'REVIEWING', state: 'review' }]);
  });

  it('brokenDependencies explains WHY a task is held (phone surfaces it)', () => {
    const all = [
      task('OK', {
        state: 'done',
        mergedSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        mergedVia: 'gate',
        verifiedSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }),
      task('BAD', { state: 'failed' }),
      task('A', { blockedBy: ['OK', 'BAD', 'GONE'] }),
    ];
    const broken = brokenDependencies(all[2]!, all);
    expect(broken).toEqual([
      { id: 'BAD', state: 'failed' },
      { id: 'GONE', state: 'missing' },
    ]);
    expect(brokenDependencies(all[0]!, all)).toEqual([]);
  });

  it('mergeBlockedDependencies surfaces Approve-before-Merge holds', () => {
    const all = [
      task('DEP', { state: 'done' }),
      task('A', { blockedBy: ['DEP'] }),
    ];
    const holds = mergeBlockedDependencies(all[1]!, all);
    expect(holds).toHaveLength(1);
    expect(holds[0]!.code).toBe('dep_awaiting_merge');
    expect(holds[0]!.remediation).toMatch(/Merge Selected/);
  });
});

describe('selectEligible — concurrency caps (SPEC §6)', () => {
  it('honors the global cap, counting running tasks against it', () => {
    const tasks = [task('A'), task('B'), task('C')];
    const out = selectEligible({
      ...base,
      globalCap: 2,
      tasks,
      repos: reposWithCaps({ app: 5 }),
      runningTaskIds: new Set(['A']),
    });
    // 1 already running, global cap 2 ⇒ only 1 more admitted.
    expect(out.map((t) => t.id)).toEqual(['B']);
  });

  it('honors the per-repo cap', () => {
    const tasks = [
      task('A', { repo: 'app' }),
      task('B', { repo: 'app' }),
      task('C', { repo: 'svc' }),
    ];
    const out = selectEligible({
      ...base,
      globalCap: 10,
      tasks,
      repos: reposWithCaps({ app: 1, svc: 1 }),
      runningTaskIds: new Set(),
    });
    // app capped at 1 ⇒ only A from app, plus C from svc.
    expect(out.map((t) => t.id).sort()).toEqual(['A', 'C']);
  });

  it('counts running tasks toward their repo cap', () => {
    const tasks = [task('A', { repo: 'app' }), task('B', { repo: 'app' })];
    const out = selectEligible({
      ...base,
      tasks,
      repos: reposWithCaps({ app: 1 }),
      runningTaskIds: new Set(['A']),
    });
    expect(out.map((t) => t.id)).toEqual([]);
  });
});

describe('selectEligible — cursor factory does not consume local repo slots', () => {
  const cursorRepo = {
    repos: {
      app: {
        key: 'app',
        url: 'x',
        defaultBranch: 'main',
        workflow: 'WORKFLOW.md',
        maxConcurrent: 1,
        adapter: 'cursor' as const,
        readiness: 'ready' as const,
      },
    },
  };

  it('admits two cursor tasks in one cycle when the repo local cap is 1', () => {
    const tasks = [task('A', { adapter: 'cursor' }), task('B', { adapter: 'cursor' })];
    const out = selectEligible({
      ...base,
      globalCap: 2,
      tasks,
      repos: cursorRepo,
      runningTaskIds: new Set(),
    });
    expect(out.map((t) => t.id)).toEqual(['A', 'B']);
  });

  it('still honors the global cap for cursor tasks', () => {
    const tasks = [
      task('A', { adapter: 'cursor' }),
      task('B', { adapter: 'cursor' }),
      task('C', { adapter: 'cursor' }),
    ];
    const out = selectEligible({
      ...base,
      globalCap: 2,
      tasks,
      repos: cursorRepo,
      runningTaskIds: new Set(),
    });
    expect(out.map((t) => t.id)).toEqual(['A', 'B']);
  });

  it('does not let a running cursor task fill the local repo cap for grok', () => {
    const tasks = [
      task('A', { adapter: 'cursor' }),
      task('B', { adapter: 'grok' }),
    ];
    const out = selectEligible({
      ...base,
      globalCap: 2,
      tasks,
      repos: reposWithCaps({ app: 1 }),
      runningTaskIds: new Set(['A']),
    });
    expect(out.map((t) => t.id)).toEqual(['B']);
  });

  it('still serializes two grok tasks at repo maxConcurrent 1', () => {
    const tasks = [task('A', { adapter: 'grok' }), task('B', { adapter: 'grok' })];
    const out = selectEligible({
      ...base,
      globalCap: 10,
      tasks,
      repos: reposWithCaps({ app: 1 }),
      runningTaskIds: new Set(),
    });
    expect(out.map((t) => t.id)).toEqual(['A']);
  });
});

describe('selectEligible — retry backoff (SPEC §7.6)', () => {
  it('holds a retrying task until its backoff elapses', () => {
    const lastEventAt = new Date(base.now - 1500).toISOString(); // 1.5s ago
    const tasks = [task('A', { state: 'retrying', attempts: 2, lastEventAt })];
    // attempts=2 ⇒ delay = base * 2^(2-1) = 2000ms; 1500ms elapsed ⇒ not yet.
    const out = selectEligible({ ...base, tasks, repos: repos('app'), runningTaskIds: new Set() });
    expect(out.map((t) => t.id)).toEqual([]);
  });

  it('releases a retrying task after its backoff elapses', () => {
    const lastEventAt = new Date(base.now - 5000).toISOString();
    const tasks = [task('A', { state: 'retrying', attempts: 2, lastEventAt })];
    const out = selectEligible({ ...base, tasks, repos: repos('app'), runningTaskIds: new Set() });
    expect(out.map((t) => t.id)).toEqual(['A']);
  });

  it('treats a retrying task with no lastEventAt as immediately eligible', () => {
    const tasks = [task('A', { state: 'retrying', attempts: 1, lastEventAt: null })];
    const out = selectEligible({ ...base, tasks, repos: repos('app'), runningTaskIds: new Set() });
    expect(out.map((t) => t.id)).toEqual(['A']);
  });

  it('honors explicit Next eligible from kind-aware retry policy over attempt backoff', () => {
    // attempts=1 would normally wait baseMs=1000; body says eligible further out.
    const lastEventAt = new Date(base.now - 5000).toISOString(); // would clear attempt backoff
    const next = new Date(base.now + 10_000).toISOString();
    const body = `## Run failure (t)\n\n**Kind:** \`stall\`\n**Next eligible:** \`${next}\`\n`;
    const tasks = [task('A', { state: 'retrying', attempts: 1, lastEventAt, body })];
    expect(
      selectEligible({ ...base, tasks, repos: repos('app'), runningTaskIds: new Set() }).map(
        (t) => t.id,
      ),
    ).toEqual([]);
    // After the stamped next-eligible time, admit.
    const later = selectEligible({
      ...base,
      now: base.now + 10_001,
      tasks,
      repos: repos('app'),
      runningTaskIds: new Set(),
    });
    expect(later.map((t) => t.id)).toEqual(['A']);
  });
});

describe('costWeight — heaviness labels', () => {
  it('exports the documented heavy labels', () => {
    expect([...HEAVY_TASK_LABELS].sort()).toEqual(['onboarding', 'readiness']);
    expect(HEAVY_COST_WEIGHT).toBeGreaterThan(0);
  });

  it('returns 0 for ordinary labels', () => {
    expect(costWeight([])).toBe(0);
    expect(costWeight(['backend', 'bug'])).toBe(0);
  });

  it('penalizes onboarding / readiness (case-insensitive)', () => {
    expect(costWeight(['onboarding'])).toBe(HEAVY_COST_WEIGHT);
    expect(costWeight(['readiness'])).toBe(HEAVY_COST_WEIGHT);
    expect(costWeight(['Readiness', 'backend'])).toBe(HEAVY_COST_WEIGHT);
  });

  it('does not stack when both heavy labels are present', () => {
    expect(costWeight(['onboarding', 'readiness'])).toBe(HEAVY_COST_WEIGHT);
  });
});

describe('selectEligible — repo fairness (anti-starvation)', () => {
  it('does not let one repo fill the global cap when others are eligible', () => {
    // Without fairness, all three app tasks (priority 1) would beat svc (priority 5)
    // and starve it under globalCap=2. Fairness admits one per under-served repo.
    const tasks = [
      task('app-a', { repo: 'app', priority: 1 }),
      task('app-b', { repo: 'app', priority: 1 }),
      task('app-c', { repo: 'app', priority: 1 }),
      task('svc-a', { repo: 'svc', priority: 5 }),
    ];
    const out = selectEligible({
      ...base,
      globalCap: 2,
      tasks,
      repos: reposWithCaps({ app: 10, svc: 10 }),
      runningTaskIds: new Set(),
    });
    const ids = out.map((t) => t.id);
    expect(ids).toHaveLength(2);
    expect(ids.some((id) => id.startsWith('app-'))).toBe(true);
    expect(ids).toContain('svc-a');
  });

  it('prefers the least-loaded repo when slots remain (counts running)', () => {
    // app already holds 1 running slot; with globalCap=2 only one new slot.
    // Fairness prefers svc (load 0) over another app task (load 1).
    const tasks = [
      task('app-run', { repo: 'app', state: 'in_progress', priority: 1 }),
      task('app-wait', { repo: 'app', priority: 1 }),
      task('svc-wait', { repo: 'svc', priority: 10 }),
    ];
    const out = selectEligible({
      ...base,
      globalCap: 2,
      tasks,
      repos: reposWithCaps({ app: 10, svc: 10 }),
      runningTaskIds: new Set(['app-run']),
    });
    expect(out.map((t) => t.id)).toEqual(['svc-wait']);
  });

  it('round-robins multiple repos under a tight global cap', () => {
    const tasks = [
      task('a1', { repo: 'alpha', priority: 1 }),
      task('a2', { repo: 'alpha', priority: 1 }),
      task('b1', { repo: 'beta', priority: 1 }),
      task('b2', { repo: 'beta', priority: 1 }),
      task('c1', { repo: 'gamma', priority: 1 }),
    ];
    const out = selectEligible({
      ...base,
      globalCap: 3,
      tasks,
      repos: reposWithCaps({ alpha: 5, beta: 5, gamma: 5 }),
      runningTaskIds: new Set(),
    });
    const byRepo = out.map((t) => t.repo).sort();
    // One slot each — no repo takes two while another has none.
    expect(byRepo).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('still fills remaining slots from the same repo when others are empty', () => {
    const tasks = [
      task('a1', { repo: 'app', priority: 1 }),
      task('a2', { repo: 'app', priority: 2 }),
      task('a3', { repo: 'app', priority: 3 }),
    ];
    const out = selectEligible({
      ...base,
      globalCap: 2,
      tasks,
      repos: reposWithCaps({ app: 10 }),
      runningTaskIds: new Set(),
    });
    expect(out.map((t) => t.id)).toEqual(['a1', 'a2']);
  });

  it('still honors per-repo caps while spreading fairly', () => {
    const tasks = [
      task('a1', { repo: 'app', priority: 1 }),
      task('a2', { repo: 'app', priority: 1 }),
      task('s1', { repo: 'svc', priority: 1 }),
      task('s2', { repo: 'svc', priority: 1 }),
    ];
    const out = selectEligible({
      ...base,
      globalCap: 10,
      tasks,
      repos: reposWithCaps({ app: 1, svc: 1 }),
      runningTaskIds: new Set(),
    });
    expect(out.map((t) => t.id).sort()).toEqual(['a1', 's1']);
  });
});

describe('selectEligible — cost-aware priority', () => {
  it('defers a heavy-labeled task behind an equal-priority light task (same repo)', () => {
    const tasks = [
      task('heavy', { priority: 1, labels: ['readiness'] }),
      task('light', { priority: 1, labels: ['backend'] }),
    ];
    const out = selectEligible({
      ...base,
      tasks,
      repos: repos('app'),
      runningTaskIds: new Set(),
    });
    expect(out.map((t) => t.id)).toEqual(['light', 'heavy']);
  });

  it('defers onboarding behind equal-priority work', () => {
    const tasks = [
      task('onboard', { priority: 5, labels: ['onboarding'] }),
      task('normal', { priority: 5, labels: [] }),
    ];
    const out = selectEligible({
      ...base,
      globalCap: 1,
      tasks,
      repos: repos('app'),
      runningTaskIds: new Set(),
    });
    expect(out.map((t) => t.id)).toEqual(['normal']);
  });

  it('does not let cost weight invert a true priority gap larger than the weight', () => {
    // heavy effective = 1 + HEAVY_COST_WEIGHT; light at priority HEAVY+2 stays lower.
    const tasks = [
      task('heavy', { priority: 1, labels: ['readiness'] }),
      task('light', { priority: HEAVY_COST_WEIGHT + 2, labels: [] }),
    ];
    const out = selectEligible({
      ...base,
      globalCap: 1,
      tasks,
      repos: repos('app'),
      runningTaskIds: new Set(),
    });
    expect(out.map((t) => t.id)).toEqual(['heavy']);
  });

  it('applies cost weight across repos together with fairness', () => {
    // Both repos load 0. Fairness ties → effective priority decides.
    // app heavy readiness vs svc light: svc wins the single global slot.
    const tasks = [
      task('app-heavy', { repo: 'app', priority: 1, labels: ['readiness'] }),
      task('svc-light', { repo: 'svc', priority: 1, labels: [] }),
    ];
    const out = selectEligible({
      ...base,
      globalCap: 1,
      tasks,
      repos: reposWithCaps({ app: 5, svc: 5 }),
      runningTaskIds: new Set(),
    });
    expect(out.map((t) => t.id)).toEqual(['svc-light']);
  });
});

describe('explainIneligible — partitions todo/retrying with selectEligible', () => {
  function incompleteRepos(key: string, maxConcurrent = 10): ReposConfig {
    return {
      repos: {
        [key]: {
          key,
          url: 'x',
          defaultBranch: 'main',
          workflow: 'WORKFLOW.md',
          maxConcurrent,
          adapter: null,
          readiness: 'incomplete',
        },
      },
    };
  }

  it('partitions every reason and keeps selectEligible byte-identical', () => {
    const now = 1_000_000;
    const reposCfg: ReposConfig = {
      repos: {
        app: {
          key: 'app',
          url: 'x',
          defaultBranch: 'main',
          workflow: 'WORKFLOW.md',
          // High enough that cap-global is held by global slots, not repo.
          maxConcurrent: 5,
          adapter: null,
          readiness: 'ready',
        },
        orbit: {
          key: 'orbit',
          url: 'x',
          defaultBranch: 'main',
          workflow: 'WORKFLOW.md',
          maxConcurrent: 2,
          adapter: null,
          readiness: 'incomplete',
        },
        busy: {
          key: 'busy',
          url: 'x',
          defaultBranch: 'main',
          workflow: 'WORKFLOW.md',
          maxConcurrent: 1,
          adapter: null,
          readiness: 'ready',
        },
      },
    };
    const blocker = task('dep-blocker', { state: 'in_progress', repo: 'app' });
    const tasks = [
      task('plan-hold', { planPending: true, priority: 1 }),
      task('host-hold', {
        executionClass: 'host_operation',
        hostCommandScope: ['systemctl restart hercules'],
        priority: 2,
      }),
      task('run-hold', { state: 'todo', priority: 3 }),
      task('excl-hold', { priority: 4 }),
      task('unk-hold', { repo: 'missing-repo', priority: 5 }),
      task('g8-hold', {
        repo: 'orbit',
        labels: ['source=acme', 'docs'],
        priority: 6,
      }),
      task('dep-hold', { blockedBy: ['dep-blocker'], priority: 7 }),
      task('backoff-hold', {
        state: 'retrying',
        attempts: 2,
        lastEventAt: new Date(now - 100).toISOString(),
        priority: 8,
      }),
      // Fills the only app slot — leaves capacity-global peers behind.
      task('admit-app', { priority: 0 }),
      task('cap-global', { priority: 50 }),
      // Repo busy already has a runner; this todo is capacity-repo.
      task('cap-repo', { repo: 'busy', priority: 9 }),
      // Onboarding on incomplete repo is eligible (not held by G8).
      task('onb-ok', { repo: 'orbit', labels: ['onboarding'], priority: 10 }),
      blocker,
    ];
    // busy-runner occupies the busy repo slot while still counting globally.
    const busyRunner = task('busy-runner', {
      state: 'in_progress',
      repo: 'busy',
    });
    // Two running (run-hold, busy-runner); globalCap 4 ⇒ two free slots.
    // admit-app (prio 0) + onb-ok fill them; cap-global stays capacity/global;
    // cap-repo stays capacity/repo (busy maxConcurrent=1).
    const stateWithRunner: SchedulingState = {
      tasks: [...tasks, busyRunner],
      repos: reposCfg,
      runningTaskIds: new Set(['run-hold', 'busy-runner']),
      excludeTaskIds: new Set(['excl-hold']),
      globalCap: 4,
      backoffBaseMs: 1000,
      now,
    };

    const admitted = selectEligible(stateWithRunner);
    const holds = explainIneligible(stateWithRunner);
    const queued = stateWithRunner.tasks.filter(
      (t) => t.state === 'todo' || t.state === 'retrying',
    );
    const admittedSet = new Set(admitted.map((t) => t.id));

    for (const t of queued) {
      const held = holds.has(t.id);
      const isAdmitted = admittedSet.has(t.id);
      expect(held && isAdmitted).toBe(false);
      expect(held || isAdmitted).toBe(true);
    }
    // No explained id outside the todo/retrying set.
    for (const id of holds.keys()) {
      const t = stateWithRunner.tasks.find((x) => x.id === id);
      expect(t?.state === 'todo' || t?.state === 'retrying').toBe(true);
    }

    const codes = new Map<string, SchedulingHoldReason['code']>();
    for (const [id, reason] of holds) codes.set(id, reason.code);

    expect(codes.get('plan-hold')).toBe('plan_pending');
    expect(codes.get('host-hold')).toBe('host_approval_pending');
    expect(codes.get('run-hold')).toBe('already_running');
    expect(codes.get('excl-hold')).toBe('excluded');
    expect(codes.get('unk-hold')).toBe('unknown_repo');
    expect(holds.get('g8-hold')).toEqual({
      code: 'repo_readiness_incomplete',
      repo: 'orbit',
    });
    expect(holds.get('dep-hold')).toEqual({
      code: 'dependency_gate_merge',
      waitingOn: ['dep-blocker'],
    });
    expect(codes.get('backoff-hold')).toBe('retry_backoff');
    expect(holds.get('cap-repo')).toEqual({
      code: 'capacity',
      scope: 'repo',
      repo: 'busy',
    });
    expect(holds.get('cap-global')).toEqual({ code: 'capacity', scope: 'global' });
    expect(holds.has('admit-app')).toBe(false);
    expect(holds.has('onb-ok')).toBe(false);
    expect(admitted.map((t) => t.id).sort()).toEqual(['admit-app', 'onb-ok']);
  });

  it('dependency_gate_merge vs dependency_completion hold codes', () => {
    const blocker = task('dep-up', { state: 'in_progress', repo: 'app' });
    const gateConsumer = task('dep-gate', {
      blockedBy: ['dep-up'],
      executionClass: 'implement',
      repo: 'app',
    });
    const completionConsumer = task('dep-complete', {
      blockedBy: ['dep-up'],
      executionClass: 'explore',
      repo: 'app',
    });
    const readinessConsumer = task('dep-ready', {
      blockedBy: ['dep-up'],
      labels: ['onboarding', 'readiness'],
      repo: 'app',
    });
    const state: SchedulingState = {
      tasks: [blocker, gateConsumer, completionConsumer, readinessConsumer],
      repos: repos('app'),
      runningTaskIds: new Set(),
      globalCap: 10,
      backoffBaseMs: 1000,
      now: 1_000_000,
    };
    const holds = explainIneligible(state);
    expect(holds.get('dep-gate')).toEqual({
      code: 'dependency_gate_merge',
      waitingOn: ['dep-up'],
    });
    expect(holds.get('dep-complete')).toEqual({
      code: 'dependency_completion',
      waitingOn: ['dep-up'],
    });
    expect(holds.get('dep-ready')).toEqual({
      code: 'dependency_completion',
      waitingOn: ['dep-up'],
    });
  });

  it('awaiting_merge hold kind surfaces dependency_gate_merge', () => {
    const blocker = task('merged-up', {
      state: 'done',
      repo: 'app',
      // done without gate merge stamp → awaiting_merge for implement dependents
    });
    const consumer = task('wait-merge', {
      blockedBy: ['merged-up'],
      executionClass: 'implement',
      repo: 'app',
    });
    const state: SchedulingState = {
      tasks: [blocker, consumer],
      repos: repos('app'),
      runningTaskIds: new Set(),
      globalCap: 10,
      backoffBaseMs: 1000,
      now: 1_000_000,
    };
    expect(mergeBlockedDependencies(consumer, state.tasks).length).toBeGreaterThan(0);
    expect(explainIneligible(state).get('wait-merge')).toEqual({
      code: 'dependency_gate_merge',
      waitingOn: ['merged-up'],
    });
  });

  it('production-shaped G8 hold: orbit incomplete + acme docs labels', () => {
    const tasks = [
      task('acme-docs-cleanup-20260905', {
        repo: 'orbit',
        labels: ['source=acme', 'docs'],
        priority: 40,
      }),
    ];
    const state: SchedulingState = {
      tasks,
      repos: incompleteRepos('orbit'),
      runningTaskIds: new Set(),
      globalCap: 10,
      backoffBaseMs: 1000,
      now: 1_000_000,
    };
    expect(selectEligible(state)).toEqual([]);
    expect(explainIneligible(state).get(tasks[0]!.id)).toEqual({
      code: 'repo_readiness_incomplete',
      repo: 'orbit',
    });
  });
});
