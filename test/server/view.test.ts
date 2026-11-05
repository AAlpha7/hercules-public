import { describe, it, expect } from 'vitest';
import { serializeState } from '../../src/server/view.js';
import type { RuntimeView } from '../../src/orchestrator/orchestrator.js';
import type { Task, TaskState } from '../../src/domain/task.js';
import type { ReposConfig } from '../../src/domain/repos.js';

const agents = { default: 'grok', available: ['grok', 'codex', 'claude', 'fake'] as const };

const repos: ReposConfig = {
  repos: {
    app: { key: 'app', url: 'x', defaultBranch: 'main', workflow: 'WORKFLOW.md', maxConcurrent: 1, adapter: null, readiness: 'ready' },
  },
};

const reposWithCreds: ReposConfig = {
  repos: {
    app: {
      key: 'app',
      url: 'https://u:p@host/x.git',
      defaultBranch: 'main',
      workflow: 'WORKFLOW.md',
      maxConcurrent: 1,
      adapter: 'codex', readiness: 'ready',
    },
  },
};

function task(id: string, state: TaskState): Task {
  return {
    id,
    title: id,
    repo: 'app',
    state,
    priority: 100,
    blockedBy: [],
    labels: [],
    adapter: null,
    agentSession: 'provider-session-must-not-leak',
    agentSessionAdapter: 'grok',
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
  };
}

function baseView(over: Partial<RuntimeView> = {}): RuntimeView {
  return {
    snapshot: null,
    running: [],
    stopping: [],
    lastReport: null,
    activity: {},
    pendingChat: {},
    liveRuns: {},
    verificationRuns: {},
    agents: { default: agents.default, available: [...agents.available] },
    ...over,
  };
}

describe('serializeState', () => {
  it('exposes bounded provider-aware reviewer health without worktree paths', () => {
    const dto = serializeState(baseView({
      reviewerHealth: [{
        provider: 'grok', state: 'blocked', failureKind: 'authentication',
        observedAt: '2026-08-03T16:00:00.000Z', blockedCandidates: 1,
        detail: 'Not signed in',
        nextAction: 'Run reviewer health check or explicitly recover grok',
      }],
    }));
    expect(dto.reviewerHealth).toEqual([expect.objectContaining({
      provider: 'grok', state: 'blocked', blockedCandidates: 1,
    })]);
    expect(JSON.stringify(dto.reviewerHealth)).not.toMatch(/\/work\/|worktree/i);
  });

  it('redacts the durable local worktree from task DTOs', () => {
    const owned = {
      ...task('A', 'retrying'),
      reviewerInfrastructure: {
        version: 1 as const, provider: 'grok' as const, state: 'blocked' as const,
        failureKind: 'authentication' as const, observedAt: '2026-08-03T16:00:00.000Z',
        detail: 'Not signed in', nextAction: 'Run health check', candidateSha: 'a'.repeat(40),
        branch: 'hercules/A', worktree: '/private/work/app/A', greenEvidence: ['test'],
      },
    };
    const dto = serializeState(baseView({ snapshot: { repos, tasks: [owned], problems: [] } }));
    expect(dto.byState.retrying[0]!.reviewerInfrastructure?.worktree).toBe(
      '[redacted-local-worktree]',
    );
    expect(JSON.stringify(dto.byState.retrying[0])).not.toContain('/private/work');
  });

  it('redacts persisted and live provider session ids from phone state', () => {
    const owned = {
      ...task('A', 'in_progress'),
      body:
        'Current provider-session-must-not-leak.\n\n' +
        'Prior `agent_session`: `legacy-provider-session-id`\n' +
        'Session "019f1234-abcd-7890-abcd-1234567890ab" not found locally, restoring from remote...\n',
    };
    const dto = serializeState(baseView({
      snapshot: { repos, tasks: [owned], problems: [] },
      liveRuns: {
        A: {
          taskId: 'A', sessionId: 'live-provider-session', lastEventAt: new Date(0).toISOString(),
          branchTip: null, runKind: 'implementer', activityLines: 0, processAlive: true,
          silenceMs: 0, runMs: 0, maxRunMs: 1000, aliveHint: null,
          procCpuPct: null, procRssMb: null,
        },
      },
    }));
    expect(dto.byState.in_progress[0]!.agentSession).toBeNull();
    expect(dto.byState.in_progress[0]!.agentSessionAdapter).toBeNull();
    expect(dto.liveRuns['A']!.sessionId).toBeNull();
    expect(JSON.stringify(dto)).not.toContain('provider-session');
    expect(dto.byState.in_progress[0]!.body).toContain('[session-redacted]');
    expect(dto.byState.in_progress[0]!.body).not.toContain('legacy-provider-session-id');
    expect(dto.byState.in_progress[0]!.body).not.toContain(
      '019f1234-abcd-7890-abcd-1234567890ab',
    );
    expect(dto.byState.in_progress[0]!.body).toContain(
      'Session "[session-redacted]" not found locally, restoring from remote...',
    );
  });

  it('stamps a strictly increasing seq so clients can drop stale snapshots', () => {
    // A slow GET /api/state started before a mutation can resolve after the
    // client's optimistic update and shove the list back to pre-action state
    // (Retry-shows-failed-for-seconds, 2026-07-18). seq gives full snapshots
    // a total order; it must survive daemon restarts (clock-based).
    const a = serializeState(baseView());
    const b = serializeState(baseView());
    expect(typeof a.seq).toBe('number');
    expect(b.seq).toBeGreaterThan(a.seq);
  });

  it('reports not-ready when no snapshot has been built yet', () => {
    const dto = serializeState(baseView());
    expect(dto.ready).toBe(false);
    expect(dto.byState.todo).toEqual([]);
    expect(dto.repos).toEqual([]);
    expect(dto.agents.default).toBe('grok');
    expect(dto.build.version).toMatch(/^v\d{8}\.\d{1,3}$/);
    expect(dto.build.gitSha.length).toBeGreaterThan(0);
  });

  it('surfaces effective public provider policy without credentials', () => {
    const dto = serializeState(baseView({
      agents: {
        default: 'grok',
        available: ['grok', 'codex', 'fake'],
        providerPolicy: {
          codex: { model: 'gpt-5.6-sol', reasoningEffort: 'medium' },
          claudeEnabled: false,
        },
      },
    }));
    expect(dto.agents.providerPolicy).toEqual({
      codex: { model: 'gpt-5.6-sol', reasoningEffort: 'medium' },
      claudeEnabled: false,
    });
    expect(JSON.stringify(dto.agents.providerPolicy)).not.toMatch(/token|key|secret/i);
  });

  it('omits providerPolicy for older daemons that never set it', () => {
    const dto = serializeState(baseView());
    expect(dto.agents.default).toBe('grok');
    expect(dto.agents.available).toEqual(['grok', 'codex', 'claude', 'fake']);
    expect(dto.agents.providerPolicy).toBeUndefined();
  });

  it('includes a disabled costSummary by default', () => {
    const dto = serializeState(baseView());
    expect(dto.costSummary.enabled).toBe(false);
    expect(dto.costSummary.level).toBe('ok');
    expect(dto.costSummary.day.costUsd).toBe(0);
    expect(dto.costSummary.billingMode).toBe('metered');
    expect(dto.costSummary.costMeaning).toMatch(/metered/i);
  });

  it('surfaces billing mode, thresholds, and subscription estimate wording', () => {
    const dto = serializeState(
      baseView({
        costSummary: {
          enabled: true,
          level: 'ok',
          day: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
          taskTotals: {},
          breaches: [],
          reasons: [],
          billingMode: 'subscription',
          billingModeNote: null,
          costMeaning:
            'USD figures are an internal estimate under a flat subscription — not an invoice or charged spend.',
          policy: {
            enabled: true,
            billingMode: 'subscription',
            billingModeNote: null,
            perTask: {
              softUsd: 40,
              hardUsd: 50,
              softTokens: null,
              hardTokens: null,
            },
            daily: {
              softUsd: 80,
              hardUsd: 100,
              softTokens: null,
              hardTokens: null,
            },
          },
          ledger: {
            status: 'ok',
            receiptCount: 7,
            retainedDays: 14,
            lastPersistedAtMs: 1_786_000_000_000,
            recoveredAtMs: 1_786_000_001_000,
            note: null,
            failClosed: false,
          },
        },
      }),
    );
    expect(dto.costSummary.enabled).toBe(true);
    expect(dto.costSummary.billingMode).toBe('subscription');
    expect(dto.costSummary.costMeaning).toMatch(/internal estimate/i);
    expect(dto.costSummary.costMeaning).toMatch(/not an invoice/i);
    expect(dto.costSummary.policy.perTask.hardUsd).toBe(50);
    expect(dto.costSummary.policy.daily.hardUsd).toBe(100);
    expect(dto.costSummary.policy.perTask.hardTokens).toBeNull();
    expect(dto.costSummary.policy.daily.hardTokens).toBeNull();
    expect(dto.costSummary.ledger).toEqual({
      status: 'ok',
      receiptCount: 7,
      retainedDays: 14,
      lastPersistedAtMs: 1_786_000_000_000,
      recoveredAtMs: 1_786_000_001_000,
      note: null,
      failClosed: false,
    });
    expect(JSON.stringify(dto.costSummary.ledger)).not.toMatch(
      /prompt|credential|provider.*payload|session.?id/i,
    );
  });

  it('exposes adapterFailover from RuntimeView (null by default)', () => {
    const empty = serializeState(baseView());
    expect(empty.adapterFailover).toBeNull();
    const active = serializeState(
      baseView({
        adapterFailover: {
          unhealthy: ['grok'],
          detail: '⚠️ adapter 降级 — grok 不健康, 新派发使用 claude',
          substitute: 'claude',
        },
      }),
    );
    expect(active.adapterFailover?.unhealthy).toEqual(['grok']);
    expect(active.adapterFailover?.substitute).toBe('claude');
    expect(active.adapterFailover?.detail).toMatch(/降级/);
  });

  it('exposes per-task scheduling holds from RuntimeView (empty by default)', () => {
    const empty = serializeState(baseView());
    expect(empty.holds).toEqual({});
    const withHold = serializeState(
      baseView({
        holds: {
          'acme-docs': { code: 'repo_readiness_incomplete', repo: 'orbit' },
        },
      }),
    );
    expect(withHold.holds).toEqual({
      'acme-docs': { code: 'repo_readiness_incomplete', repo: 'orbit' },
    });
  });

  it('exposes dispatchHold + diskWarn from RuntimeView (null by default)', () => {
    const empty = serializeState(baseView());
    expect(empty.dispatchHold).toBeNull();
    expect(empty.diskWarn).toBeNull();
    expect(empty.diskPressure).toBeNull();

    const GB = 1024 ** 3;
    const critical = serializeState(
      baseView({
        dispatchHold: {
          reason: 'disk',
          detail: '磁盘 98% (剩 2.0G) — 清出空间后自动恢复',
        },
        diskPressure: { level: 'critical', usedPct: 98, freeBytes: 2 * GB },
      }),
    );
    expect(critical.dispatchHold?.reason).toBe('disk');
    expect(critical.dispatchHold?.detail).toMatch(/98%/);
    expect(critical.diskWarn).toBeNull(); // critical is not warn
    expect(critical.diskPressure?.level).toBe('critical');

    const warn = serializeState(
      baseView({
        dispatchHold: null,
        diskPressure: { level: 'warn', usedPct: 88, freeBytes: 12 * GB },
      }),
    );
    expect(warn.dispatchHold).toBeNull();
    expect(warn.diskWarn).toMatch(/88%/);
    expect(warn.diskWarn).toMatch(/磁盘/);

    const warnPruned = serializeState(
      baseView({
        dispatchHold: null,
        diskPressure: { level: 'warn', usedPct: 88, freeBytes: 12 * GB },
        diskPruneNote: '已自动修剪, 释放 5.2G',
      }),
    );
    expect(warnPruned.diskWarn).toMatch(/已自动修剪, 释放 5\.2G/);
  });

  it('groups tasks by state and surfaces running, repos, and problems', () => {
    const dto = serializeState(
      baseView({
        snapshot: {
          repos,
          tasks: [task('A', 'todo'), task('B', 'review'), task('C', 'review')],
          problems: [{ stem: 'BAD', error: 'boom' }],
        },
        running: ['Z'],
      }),
    );
    expect(dto.ready).toBe(true);
    expect(dto.byState.review.map((t) => t.id).sort()).toEqual(['B', 'C']);
    expect(dto.byState.todo.map((t) => t.id)).toEqual(['A']);
    expect(dto.running).toEqual(['Z']);
    expect(dto.repos).toEqual([
      {
        key: 'app',
        url: 'x',
        defaultBranch: 'main',
        workflow: 'WORKFLOW.md',
        maxConcurrent: 1,
        adapter: null, readiness: 'ready',
        effectiveAdapter: 'grok',
        executionPolicy: expect.objectContaining({ profile: 'compatible', sandbox: 'none', explicit: false }),
        autoMerge: null,
      },
    ]);
    expect(dto.problems).toEqual([{ stem: 'BAD', error: 'boom' }]);
  });

  it('surfaces the stopping set (in both the ready and not-ready branches)', () => {
    expect(serializeState(baseView({ stopping: ['A'] })).stopping).toEqual(['A']);
    expect(
      serializeState(
        baseView({
          snapshot: { repos, tasks: [], problems: [] },
          stopping: ['B'],
        }),
      ).stopping,
    ).toEqual(['B']);
  });

  it('carries activity map in the not-ready branch', () => {
    const dto = serializeState(baseView({ activity: { A: ['x'] } }));
    expect(dto.activity).toEqual({ A: ['x'] });
  });

  it('redacts credentials from repo URLs in the DTO', () => {
    const dto = serializeState(
      baseView({
        snapshot: { repos: reposWithCreds, tasks: [], problems: [] },
      }),
    );
    expect(dto.repos[0]!.url).toBe('https://***@host/x.git');
    expect(dto.repos[0]!.adapter).toBe('codex');
    expect(dto.repos[0]!.effectiveAdapter).toBe('codex');
    // Effective policy is always present (compatible defaults when omitted).
    expect(dto.repos[0]!.executionPolicy.profile).toBe('compatible');
    expect(dto.repos[0]!.executionPolicy.explicit).toBe(false);
    expect(dto.repos[0]!.executionPolicy.sandbox).toBe('none');
    expect(dto.repos[0]!.autoMerge).toBeNull();
  });

  it('leaves plain repo URLs (no credentials) unchanged in the DTO', () => {
    const dto = serializeState(
      baseView({
        snapshot: { repos, tasks: [], problems: [] },
      }),
    );
    expect(dto.repos[0]!.url).toBe('x');
  });

  it('carries activity map in the ready branch', () => {
    const dto = serializeState(
      baseView({
        snapshot: { repos, tasks: [], problems: [] },
        activity: { A: ['x', 'y'] },
      }),
    );
    expect(dto.activity).toEqual({ A: ['x', 'y'] });
  });
});
