import { describe, it, expect } from 'vitest';
import {
  emptyRelease,
  hasStagingDrift,
  canPromote,
  assertCanPromote,
  PromoteError,
  rollbackTarget,
  mergeAdvancesMain,
  stagingDeployStarted,
  stagingVerifyStarted,
  stagingDeployVerified,
  stagingDeployFailed,
  promoteStarted,
  promoteFinalized,
  promoteFailedBootMismatch,
  promoteRolledBack,
  isStagingStatus,
  isPromoteOutcome,
  shouldStartStagingDeploy,
  selectTasksForRelease,
  renderReleasePacket,
  formatEvidenceStepLine,
  selectMergeableTasks,
  staticMergeBlockReason,
  isStaticallyMergeable,
  extractReleaseFailureReason,
  canManualRollback,
  buildReleasePanelEntry,
  previousProductionSha,
  DEFAULT_STAGING_DEPLOY_DEBOUNCE_MS,
  type Release,
  type StaticMergeEligibilityInput,
} from '../../src/domain/release.js';

const MAIN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const STAGING = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PROD = 'cccccccccccccccccccccccccccccccccccccccc';
const AT = '2026-07-17T12:00:00.000Z';
const AT2 = '2026-07-17T13:00:00.000Z';

function readyRelease(overrides: Partial<Release> = {}): Release {
  return {
    ...emptyRelease('hercules'),
    productionSha: PROD,
    productionDeployedAt: '2026-07-16T00:00:00.000Z',
    stagingSha: STAGING,
    stagingStatus: 'ready',
    stagingVerifiedAt: AT,
    history: [{ sha: PROD, at: '2026-07-16T00:00:00.000Z', outcome: 'ok' }],
    body: '## Release packet\n',
    ...overrides,
  };
}

describe('isStagingStatus / isPromoteOutcome', () => {
  it('accepts the four staging statuses', () => {
    for (const s of ['deploying', 'verifying', 'ready', 'failed'] as const) {
      expect(isStagingStatus(s)).toBe(true);
    }
    expect(isStagingStatus('stale')).toBe(false);
    expect(isStagingStatus(null)).toBe(false);
  });

  it('accepts promote outcomes', () => {
    expect(isPromoteOutcome('ok')).toBe(true);
    expect(isPromoteOutcome('rolled_back')).toBe(true);
    expect(isPromoteOutcome('failed')).toBe(false);
  });
});

describe('emptyRelease', () => {
  it('bootstraps a blank release for a repo key', () => {
    const r = emptyRelease('my-app');
    expect(r.repoKey).toBe('my-app');
    expect(r.productionSha).toBeNull();
    expect(r.stagingSha).toBeNull();
    expect(r.stagingStatus).toBeNull();
    expect(r.promotingSha).toBeNull();
    expect(r.history).toEqual([]);
    expect(r.body).toBe('');
  });
});

describe('staging deploy transitions', () => {
  it('stagingDeployStarted records sha and marks deploying', () => {
    const r = stagingDeployStarted(emptyRelease('hercules'), STAGING, AT);
    expect(r.stagingSha).toBe(STAGING);
    expect(r.stagingStatus).toBe('deploying');
    expect(r.stagingVerifiedAt).toBeNull();
    expect(r.stagingStartedAt).toBe(AT);
  });

  it('stagingDeployStarted clears a prior verified_at', () => {
    const prior = readyRelease();
    const r = stagingDeployStarted(prior, MAIN, AT2);
    expect(r.stagingSha).toBe(MAIN);
    expect(r.stagingStatus).toBe('deploying');
    expect(r.stagingVerifiedAt).toBeNull();
    expect(r.stagingStartedAt).toBe(AT2);
  });

  it('stagingVerifyStarted marks verifying', () => {
    const r = stagingVerifyStarted(
      stagingDeployStarted(emptyRelease('h'), STAGING, AT),
      AT2,
    );
    expect(r.stagingStatus).toBe('verifying');
    expect(r.stagingSha).toBe(STAGING);
    expect(r.stagingStartedAt).toBe(AT2);
  });

  it('stagingDeployVerified marks ready and stamps verified_at', () => {
    const r = stagingDeployVerified(
      stagingVerifyStarted(stagingDeployStarted(emptyRelease('h'), STAGING, AT)),
      AT,
    );
    expect(r.stagingStatus).toBe('ready');
    expect(r.stagingVerifiedAt).toBe(AT);
    expect(r.stagingSha).toBe(STAGING);
    expect(r.stagingStartedAt).toBeNull();
  });

  it('stagingDeployFailed marks failed and clears verified_at + started_at', () => {
    const mid = stagingVerifyStarted(stagingDeployStarted(emptyRelease('h'), STAGING, AT));
    const r = stagingDeployFailed(mid);
    expect(r.stagingStatus).toBe('failed');
    expect(r.stagingVerifiedAt).toBeNull();
    expect(r.stagingStartedAt).toBeNull();
    expect(r.stagingSha).toBe(STAGING); // still what was attempted
  });
});

describe('mergeAdvancesMain → staging stale (drift)', () => {
  it('does not rewrite staging_sha (still what is running)', () => {
    const r = readyRelease({ stagingSha: STAGING });
    const next = mergeAdvancesMain(r);
    expect(next.stagingSha).toBe(STAGING);
  });

  it('after main advances past staging_sha, drift is true and promote is blocked', () => {
    const r = readyRelease({ stagingSha: STAGING });
    // main is now MAIN, staging still STAGING
    expect(hasStagingDrift(r, MAIN)).toBe(true);
    expect(canPromote(r, MAIN)).toBe(false);
    // even after mergeAdvancesMain bookkeeping
    const next = mergeAdvancesMain(r);
    expect(hasStagingDrift(next, MAIN)).toBe(true);
    expect(canPromote(next, MAIN)).toBe(false);
  });

  it('no drift when staging tracks main', () => {
    const r = readyRelease({ stagingSha: MAIN });
    expect(hasStagingDrift(r, MAIN)).toBe(false);
  });

  it('treats missing staging_sha as drift when main is known', () => {
    const r = emptyRelease('h');
    expect(hasStagingDrift(r, MAIN)).toBe(true);
  });
});

describe('promote preconditions', () => {
  it('allows promote when ready AND staging_sha == main', () => {
    const r = readyRelease({ stagingSha: MAIN });
    expect(canPromote(r, MAIN)).toBe(true);
    expect(() => assertCanPromote(r, MAIN)).not.toThrow();
  });

  it('blocks promote when status is not ready', () => {
    for (const status of ['deploying', 'verifying', 'failed'] as const) {
      const r = readyRelease({ stagingSha: MAIN, stagingStatus: status });
      expect(canPromote(r, MAIN)).toBe(false);
    }
    expect(canPromote(emptyRelease('h'), MAIN)).toBe(false);
  });

  it('blocks promote when staging drifts from main even if ready', () => {
    const r = readyRelease({ stagingSha: STAGING, stagingStatus: 'ready' });
    expect(canPromote(r, MAIN)).toBe(false);
  });

  it('assertCanPromote throws PromoteError when blocked', () => {
    const r = readyRelease({ stagingSha: STAGING });
    expect(() => assertCanPromote(r, MAIN)).toThrow(PromoteError);
  });

  it('blocks promote when production already runs the staging sha (first promote 2026-07-17)', () => {
    // Re-promoting the same SHA is a no-op that still restarts production —
    // after a successful promote the button must go quiet until main moves.
    const r = readyRelease({ stagingSha: MAIN, productionSha: MAIN });
    expect(canPromote(r, MAIN)).toBe(false);
    expect(() => assertCanPromote(r, MAIN)).toThrow(/already/i);
    // A later main advance re-arms promote once staging re-verifies.
    const r2 = readyRelease({ stagingSha: MAIN, productionSha: STAGING });
    expect(canPromote(r2, MAIN)).toBe(true);
  });
});

describe('promote transitions', () => {
  it('promoteStarted sets promoting_sha from staging_sha', () => {
    const r = readyRelease({ stagingSha: MAIN });
    const next = promoteStarted(r);
    expect(next.promotingSha).toBe(MAIN);
    expect(next.stagingSha).toBe(MAIN);
    expect(next.productionSha).toBe(PROD); // unchanged until finalize
  });

  it('promoteFinalized promotes staging to production and appends ok history', () => {
    const r = promoteStarted(readyRelease({ stagingSha: MAIN }));
    const next = promoteFinalized(r, AT2);
    expect(next.productionSha).toBe(MAIN);
    expect(next.productionDeployedAt).toBe(AT2);
    expect(next.promotingSha).toBeNull();
    expect(next.history).toEqual([
      { sha: PROD, at: '2026-07-16T00:00:00.000Z', outcome: 'ok' },
      { sha: MAIN, at: AT2, outcome: 'ok' },
    ]);
  });

  it('promoteRolledBack restores rollback target and appends rolled_back history', () => {
    const r = promoteStarted(readyRelease({ stagingSha: MAIN }));
    const next = promoteRolledBack(r, AT2);
    // last ok history entry is PROD
    expect(next.productionSha).toBe(PROD);
    expect(next.productionDeployedAt).toBe(AT2);
    expect(next.promotingSha).toBeNull();
    const last = next.history[next.history.length - 1];
    expect(last).toEqual({
      sha: PROD,
      at: AT2,
      outcome: 'rolled_back',
      rollbackOf: MAIN,
    });
  });

  it('promoteFailedBootMismatch clears promoting_sha, keeps production, sets failure note', () => {
    const r = promoteStarted(readyRelease({ stagingSha: MAIN, productionSha: PROD }));
    const next = promoteFailedBootMismatch(r, {
      sha: MAIN,
      bootedSha: PROD,
      reason: 'booted_build_mismatch',
      at: AT2,
    });
    expect(next.productionSha).toBe(PROD);
    expect(next.promotingSha).toBeNull();
    expect(next.lastPromoteFailure).toEqual({
      sha: MAIN,
      bootedSha: PROD,
      reason: 'booted_build_mismatch',
      at: AT2,
    });
    expect(next.history).toEqual(r.history);
  });

  it('promoteFinalized clears lastPromoteFailure', () => {
    const failed = promoteFailedBootMismatch(
      promoteStarted(readyRelease({ stagingSha: MAIN })),
      { sha: MAIN, bootedSha: null, reason: 'booted_build_unknown', at: AT },
    );
    const next = promoteFinalized(
      promoteStarted({ ...failed, stagingSha: MAIN, stagingStatus: 'ready' }),
      AT2,
    );
    expect(next.lastPromoteFailure).toBeNull();
  });
});

describe('rollbackTarget', () => {
  it('selects the last history entry with outcome ok', () => {
    const r = readyRelease({
      productionSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      history: [
        { sha: PROD, at: '2026-07-10T00:00:00.000Z', outcome: 'ok' },
        {
          sha: PROD,
          at: '2026-07-12T00:00:00.000Z',
          outcome: 'rolled_back',
          rollbackOf: STAGING,
        },
        { sha: MAIN, at: '2026-07-14T00:00:00.000Z', outcome: 'ok' },
        {
          sha: MAIN,
          at: '2026-07-15T00:00:00.000Z',
          outcome: 'rolled_back',
          rollbackOf: STAGING,
        },
      ],
    });
    expect(rollbackTarget(r)).toBe(MAIN);
  });

  it('falls back to production_sha when no ok history entry exists', () => {
    const r = readyRelease({
      productionSha: PROD,
      history: [
        {
          sha: PROD,
          at: AT,
          outcome: 'rolled_back',
          rollbackOf: STAGING,
        },
      ],
    });
    expect(rollbackTarget(r)).toBe(PROD);
  });

  it('returns null when neither history nor production_sha is available', () => {
    expect(rollbackTarget(emptyRelease('h'))).toBeNull();
  });

  it('falls back to production_sha when history is empty', () => {
    const r = readyRelease({ history: [] });
    expect(rollbackTarget(r)).toBe(PROD);
  });

  it('skips ok history matching promoting_sha (manual rollback of current tip)', () => {
    const r = readyRelease({
      productionSha: MAIN,
      promotingSha: MAIN,
      history: [
        { sha: PROD, at: '2026-07-16T00:00:00.000Z', outcome: 'ok' },
        { sha: MAIN, at: '2026-07-17T01:00:00.000Z', outcome: 'ok' },
      ],
    });
    expect(rollbackTarget(r)).toBe(PROD);
  });

  it('returns null when only known-good is the promoting tip', () => {
    const r = readyRelease({
      productionSha: MAIN,
      promotingSha: MAIN,
      history: [{ sha: MAIN, at: AT, outcome: 'ok' }],
    });
    expect(rollbackTarget(r)).toBeNull();
  });
});

describe('shouldStartStagingDeploy', () => {
  const base = {
    hasDrift: true,
    promotingSha: null as string | null,
    deployNow: false,
    lastMainAdvanceAtMs: 0,
    nowMs: DEFAULT_STAGING_DEPLOY_DEBOUNCE_MS,
    debounceMs: DEFAULT_STAGING_DEPLOY_DEBOUNCE_MS,
    inFlight: false,
  };

  it('returns false without drift', () => {
    expect(shouldStartStagingDeploy({ ...base, hasDrift: false })).toBe(false);
  });

  it('returns false while promoting_sha is set', () => {
    expect(shouldStartStagingDeploy({ ...base, promotingSha: MAIN })).toBe(false);
  });

  it('returns false while in flight', () => {
    expect(shouldStartStagingDeploy({ ...base, inFlight: true })).toBe(false);
  });

  it('returns false before debounce elapses', () => {
    expect(
      shouldStartStagingDeploy({
        ...base,
        lastMainAdvanceAtMs: 0,
        nowMs: DEFAULT_STAGING_DEPLOY_DEBOUNCE_MS - 1,
      }),
    ).toBe(false);
  });

  it('returns true after debounce elapses', () => {
    expect(shouldStartStagingDeploy(base)).toBe(true);
  });

  it('deployNow bypasses debounce', () => {
    expect(
      shouldStartStagingDeploy({
        ...base,
        deployNow: true,
        nowMs: 0,
        lastMainAdvanceAtMs: 0,
      }),
    ).toBe(true);
  });

  it('returns false when main advance time is unknown (no deployNow)', () => {
    expect(shouldStartStagingDeploy({ ...base, lastMainAdvanceAtMs: null })).toBe(false);
  });
});

describe('selectTasksForRelease', () => {
  const tasks = [
    { id: 't-a', title: 'Alpha', repo: 'app', mergedSha: 'sha-a' },
    { id: 't-b', title: 'Beta', repo: 'app', mergedSha: 'sha-b' },
    { id: 't-c', title: 'Other', repo: 'other', mergedSha: 'sha-b' },
    { id: 't-d', title: 'Prod stamp', repo: 'app', mergedSha: PROD },
    { id: 't-e', title: 'Unmerged', repo: 'app', mergedSha: null },
  ];

  it('includes only same-repo tasks with merged_sha not equal to production', () => {
    const selected = selectTasksForRelease(tasks, {
      repoKey: 'app',
      productionSha: PROD,
      stagingSha: MAIN,
    });
    expect(selected.map((t) => t.id)).toEqual(['t-a', 't-b']);
  });

  it('filters by git range shas when provided', () => {
    const selected = selectTasksForRelease(tasks, {
      repoKey: 'app',
      productionSha: PROD,
      stagingSha: MAIN,
      rangeShas: new Set(['sha-b', MAIN]),
    });
    expect(selected.map((t) => t.id)).toEqual(['t-b']);
  });

  it('lists exactly the tasks between production and staging via range', () => {
    const selected = selectTasksForRelease(tasks, {
      repoKey: 'app',
      productionSha: PROD,
      stagingSha: 'sha-a',
      rangeShas: new Set(['sha-a']),
    });
    expect(selected).toEqual([{ id: 't-a', title: 'Alpha', mergedSha: 'sha-a' }]);
  });
});

describe('renderReleasePacket', () => {
  it('renders tasks, health, evidence, timestamps', () => {
    const md = renderReleasePacket({
      repoKey: 'app',
      stagingSha: MAIN,
      productionSha: PROD,
      tasks: [{ id: 't-a', title: 'Alpha', mergedSha: 'sha-a' }],
      deployOutput: 'deployed ok',
      healthOutput: 'HTTP 200',
      healthOk: true,
      evidenceLines: [formatEvidenceStepLine({ kind: 'assert', ok: true, detail: 'found' })],
      evidenceOk: true,
      startedAt: AT,
      finishedAt: AT2,
      outcome: 'ready',
    });
    expect(md).toContain('## Release packet');
    expect(md).toContain('`t-a`: Alpha');
    expect(md).toContain(MAIN);
    expect(md).toContain(PROD);
    expect(md).toContain('deployed ok');
    expect(md).toContain('HTTP 200');
    expect(md).toContain('✓');
    expect(md).toContain('ready');
  });

  it('records failure reason on failed outcome', () => {
    const md = renderReleasePacket({
      repoKey: 'app',
      stagingSha: MAIN,
      productionSha: null,
      tasks: [],
      deployOutput: '',
      healthOutput: 'connection refused',
      healthOk: false,
      evidenceLines: [],
      evidenceOk: null,
      startedAt: AT,
      finishedAt: AT2,
      outcome: 'failed',
      failureReason: 'health check failed',
    });
    expect(md).toContain('health check failed');
    expect(md).toContain('failed');
    expect(md).toContain('_Evidence not run._');
  });
});

describe('selectMergeableTasks', () => {
  const tasks = [
    {
      id: 'm-1',
      title: 'Merge me',
      repo: 'app',
      state: 'done',
      mergedSha: null,
      verifiedSha: 'v1',
    },
    {
      id: 'm-2',
      title: 'Already merged',
      repo: 'app',
      state: 'done',
      mergedSha: MAIN,
      verifiedSha: 'v2',
    },
    {
      id: 'm-3',
      title: 'Still review',
      repo: 'app',
      state: 'review',
      mergedSha: null,
      verifiedSha: null,
    },
    {
      id: 'm-4',
      title: 'Other repo',
      repo: 'other',
      state: 'done',
      mergedSha: null,
      verifiedSha: null,
    },
    {
      id: 'm-0',
      title: 'Also mergeable',
      repo: 'app',
      state: 'done',
      mergedSha: '',
      verifiedSha: 'v0',
    },
  ];

  it('returns done + unmerged tasks for the repo, sorted by id', () => {
    const selected = selectMergeableTasks(tasks, 'app');
    expect(selected.map((t) => t.id)).toEqual(['m-0', 'm-1']);
    expect(selected[1]).toEqual({
      id: 'm-1',
      title: 'Merge me',
      verifiedSha: 'v1',
    });
  });
});

describe('extractReleaseFailureReason', () => {
  it('reads **failure:** line from packet body', () => {
    const body = '## Release packet\n\n- **failure:** health check failed\n';
    expect(extractReleaseFailureReason(body, 'failed')).toBe('health check failed');
  });

  it('reads ALERT lines from promote rollback packet', () => {
    const body = 'ALERT: production auto-rollback deploy failed\n\n## prior\n';
    expect(extractReleaseFailureReason(body, 'ready')).toBe(
      'production auto-rollback deploy failed',
    );
  });

  it('falls back when staging_status is failed without a reason line', () => {
    expect(extractReleaseFailureReason('', 'failed')).toMatch(/staging/i);
  });

  it('returns null when healthy', () => {
    expect(extractReleaseFailureReason('## Release packet\n', 'ready')).toBeNull();
  });
});

describe('canManualRollback', () => {
  it('is true mid-promote', () => {
    const r: Release = {
      ...emptyRelease('app'),
      productionSha: PROD,
      promotingSha: MAIN,
      history: [{ sha: PROD, at: AT, outcome: 'ok' }],
    };
    expect(canManualRollback(r)).toBe(true);
  });

  it('is true when production has an earlier known-good history entry', () => {
    const r: Release = {
      ...emptyRelease('app'),
      productionSha: MAIN,
      history: [
        { sha: PROD, at: AT, outcome: 'ok' },
        { sha: MAIN, at: AT2, outcome: 'ok' },
      ],
    };
    expect(canManualRollback(r)).toBe(true);
  });

  it('is false with no production and no promoting', () => {
    expect(canManualRollback(emptyRelease('app'))).toBe(false);
  });

  it('is false when only one production tip and no prior history', () => {
    const r: Release = {
      ...emptyRelease('app'),
      productionSha: MAIN,
      history: [{ sha: MAIN, at: AT, outcome: 'ok' }],
    };
    expect(canManualRollback(r)).toBe(false);
  });
});

describe('buildReleasePanelEntry', () => {
  it('assembles drift, ahead tasks, mergeable, promote flags, failure', () => {
    const OLD = 'dddddddddddddddddddddddddddddddddddddddd';
    const release: Release = {
      ...emptyRelease('app'),
      productionSha: PROD,
      productionDeployedAt: AT,
      stagingSha: STAGING,
      stagingStatus: 'failed',
      stagingVerifiedAt: null,
      body: '## Release packet\n\n- **failure:** evidence assert failed\n',
      history: [
        { sha: OLD, at: AT, outcome: 'ok' },
        { sha: PROD, at: AT2, outcome: 'ok' },
      ],
    };
    const entry = buildReleasePanelEntry({
      release,
      mainSha: MAIN,
      stagingUrl: 'http://host:8788/',
      hasProductionDeploy: true,
      tasks: [
        {
          id: 't-a',
          title: 'Alpha',
          repo: 'app',
          state: 'done',
          mergedSha: STAGING,
          verifiedSha: 'v',
        },
        {
          id: 't-b',
          title: 'Pending merge',
          repo: 'app',
          state: 'done',
          mergedSha: null,
          verifiedSha: 'v2',
        },
      ],
    });
    expect(entry.repoKey).toBe('app');
    expect(entry.stagingDrift).toBe(true); // STAGING ≠ MAIN
    expect(entry.canPromote).toBe(false);
    expect(entry.aheadCount).toBe(1);
    expect(entry.aheadTasks[0]?.id).toBe('t-a');
    expect(entry.mergeableTasks.map((t) => t.id)).toEqual(['t-b']);
    expect(entry.stagingUrl).toBe('http://host:8788/');
    expect(entry.lastPromoteFailure).toBeNull();
    expect(entry.failureReason).toBe('evidence assert failed');
    expect(entry.canRollback).toBe(true);
    expect(entry.hasProductionDeploy).toBe(true);
    expect(entry.stagingStartedAt).toBeNull();
    expect(entry.stagingVerifyTimeoutMs).toBe(15 * 60 * 1000);
  });

  it('canPromote when ready and main matches staging', () => {
    const release: Release = {
      ...emptyRelease('app'),
      productionSha: PROD,
      stagingSha: MAIN,
      stagingStatus: 'ready',
      stagingVerifiedAt: AT,
      body: '## packet\n',
      history: [{ sha: PROD, at: AT, outcome: 'ok' }],
    };
    const entry = buildReleasePanelEntry({
      release,
      mainSha: MAIN,
      stagingUrl: null,
      hasProductionDeploy: true,
      tasks: [],
    });
    expect(entry.stagingDrift).toBe(false);
    expect(entry.canPromote).toBe(true);
    expect(entry.failureReason).toBeNull();
  });

  it('exposes lastPromoteFailure (sha + reason + at) when present', () => {
    const release: Release = {
      ...emptyRelease('app'),
      productionSha: PROD,
      stagingSha: MAIN,
      stagingStatus: 'ready',
      lastPromoteFailure: {
        sha: MAIN,
        bootedSha: PROD,
        reason: 'booted_build_mismatch',
        at: AT2,
      },
      body: '## packet\n',
      history: [{ sha: PROD, at: AT, outcome: 'ok' }],
    };
    const entry = buildReleasePanelEntry({
      release,
      mainSha: MAIN,
      stagingUrl: null,
      hasProductionDeploy: true,
      tasks: [],
    });
    expect(entry.lastPromoteFailure).toEqual({
      sha: MAIN,
      reason: 'booted_build_mismatch',
      at: AT2,
      bootedSha: PROD,
    });
  });
});

describe('selectMergeableTasks requires the verified-SHA anchor', () => {
  it('excludes legacy/manual tasks without verifiedSha (phone Releases incident)', async () => {
    const { selectMergeableTasks } = await import('../../src/domain/release.js');
    const tasks = [
      // Modern verified flow, unmerged → offered.
      { id: 'a', title: 'A', repo: 'app', state: 'done', verifiedSha: 'cafe'.repeat(10), mergedSha: null },
      // Legacy done task (pre-invariant, e.g. logout) → machine merge would push
      // a stale branch; must NOT be offered.
      { id: 'legacy', title: 'L', repo: 'app', state: 'done', verifiedSha: null, mergedSha: null },
      // Already merged → not offered.
      { id: 'm', title: 'M', repo: 'app', state: 'done', verifiedSha: 'beef'.repeat(10), mergedSha: 'dead'.repeat(10) },
      // Other repo / non-done → not offered.
      { id: 'x', title: 'X', repo: 'other', state: 'done', verifiedSha: 'aa'.repeat(20), mergedSha: null },
      { id: 'r', title: 'R', repo: 'app', state: 'review', verifiedSha: 'bb'.repeat(20), mergedSha: null },
    ];
    expect(selectMergeableTasks(tasks, 'app').map((t) => t.id)).toEqual(['a']);
  });

  it('excludes pr_status=merged even when merged_sha is still missing', async () => {
    // release-verify-timeout: external GH merge stamped pr_status only.
    // Merge selected must not re-offer that task (verified-SHA mismatch).
    const { selectMergeableTasks } = await import('../../src/domain/release.js');
    const tasks = [
      {
        id: 'ordinary',
        title: 'Ordinary mergeable',
        repo: 'app',
        state: 'done',
        verifiedSha: 'cafe'.repeat(10),
        mergedSha: null,
        prStatus: 'open',
      },
      {
        id: 'release-verify-timeout',
        title: 'Already on main via PR',
        repo: 'app',
        state: 'done',
        verifiedSha: 'beef'.repeat(10),
        mergedSha: null,
        prStatus: 'merged',
      },
      {
        id: 'no-pr-status',
        title: 'No PR metadata',
        repo: 'app',
        state: 'done',
        verifiedSha: 'abcd'.repeat(10),
        mergedSha: null,
      },
    ];
    expect(selectMergeableTasks(tasks, 'app').map((t) => t.id)).toEqual([
      'no-pr-status',
      'ordinary',
    ]);
  });
});

describe('static merge-eligibility contract (UI + server parity)', () => {
  const base: StaticMergeEligibilityInput = {
    id: 't1',
    title: 'T1',
    repo: 'app',
    state: 'done',
    verifiedSha: 'cafe'.repeat(10),
    mergedSha: null,
    prStatus: null,
  };

  it('isStaticallyMergeable matches selectMergeableTasks for every fixture', () => {
    const fixtures: StaticMergeEligibilityInput[] = [
      base,
      { ...base, id: 'no-v', verifiedSha: null },
      { ...base, id: 'empty-v', verifiedSha: '' },
      { ...base, id: 'merged', mergedSha: MAIN },
      { ...base, id: 'pr-merged', prStatus: 'merged' },
      { ...base, id: 'review', state: 'review' },
      { ...base, id: 'other', repo: 'other' },
      { ...base, id: 'open-pr', prStatus: 'open' },
    ];
    for (const t of fixtures) {
      const uiOffers = selectMergeableTasks([t], 'app').some((m) => m.id === t.id);
      const serverOk = isStaticallyMergeable(t, 'app');
      expect(uiOffers, `parity for ${t.id}`).toBe(serverOk);
      expect(staticMergeBlockReason(t, 'app') === null).toBe(serverOk);
    }
  });

  it('staticMergeBlockReason names missing verified_sha and external PR merge', () => {
    expect(staticMergeBlockReason({ ...base, verifiedSha: null }, 'app')).toMatch(
      /missing verified_sha/i,
    );
    expect(staticMergeBlockReason({ ...base, prStatus: 'merged' }, 'app')).toMatch(
      /pr_status=merged/i,
    );
    expect(staticMergeBlockReason(base, 'app')).toBeNull();
  });
});

describe('resolveStagingPublicUrl (phone-reachable staging link)', () => {
  it('prefers the URL file, then env var, then the WORKFLOW url', async () => {
    const { resolveStagingPublicUrl } = await import('../../src/domain/release.js');
    // File wins (quick-tunnel URLs rotate; file is refreshed by the unit).
    expect(
      resolveStagingPublicUrl({
        env: { STAGING_PUBLIC_URL_FILE: '/x/url', STAGING_PUBLIC_URL: 'https://env.example' },
        readFile: () => 'https://tunnel.trycloudflare.com\n',
        workflowUrl: 'http://localhost:8788/',
      }),
    ).toBe('https://tunnel.trycloudflare.com');
    // File unreadable → env var.
    expect(
      resolveStagingPublicUrl({
        env: { STAGING_PUBLIC_URL_FILE: '/x/url', STAGING_PUBLIC_URL: 'https://env.example' },
        readFile: () => {
          throw new Error('missing');
        },
        workflowUrl: 'http://localhost:8788/',
      }),
    ).toBe('https://env.example');
    // Nothing configured → WORKFLOW url (may be localhost — better than nothing).
    expect(
      resolveStagingPublicUrl({
        env: {},
        readFile: () => {
          throw new Error('unused');
        },
        workflowUrl: 'http://localhost:8788/',
      }),
    ).toBe('http://localhost:8788/');
    // Empty file content → fall through.
    expect(
      resolveStagingPublicUrl({
        env: { STAGING_PUBLIC_URL_FILE: '/x/url' },
        readFile: () => '  \n',
        workflowUrl: null,
      }),
    ).toBeNull();
  });
});

describe('direct commits without task provenance (operator pushes, 2026-07-17)', () => {
  it('lists range commits not accounted for by any ahead task', () => {
    const release: Release = {
      ...emptyRelease('app'),
      productionSha: PROD,
      stagingSha: STAGING,
      stagingStatus: 'ready',
    };
    const taskSha = 'e'.repeat(40);
    const direct1 = 'a1'.padEnd(40, '0');
    const direct2 = 'b2'.padEnd(40, '0');
    const entry = buildReleasePanelEntry({
      release,
      mainSha: STAGING,
      stagingUrl: null,
      hasProductionDeploy: true,
      tasks: [
        {
          id: 't1',
          title: 'Tasked change',
          repo: 'app',
          state: 'done',
          mergedSha: taskSha,
        },
      ],
      rangeShas: new Set([taskSha, direct1, direct2, STAGING]),
      rangeCommits: [
        { sha: STAGING, subject: 'fix: promote quiet' },
        { sha: direct1, subject: 'fix: hooks order' },
        { sha: direct2, subject: 'chore: ops tweak' },
        { sha: taskSha, subject: 'hercules: merge t1 — Tasked change' },
      ],
    });
    expect(entry.aheadTasks.map((t) => t.id)).toEqual(['t1']);
    expect(entry.directCommits.map((c) => c.subject)).toEqual([
      'fix: promote quiet',
      'fix: hooks order',
      'chore: ops tweak',
    ]);
    // The trust chain must not claim "0 changes" — it counts direct commits.
    expect(entry.trustChain).toMatch(/direct commit/i);
    expect(entry.trustChain).not.toMatch(/^0 changes — every one passed/);
  });

  it('stays empty when every range commit maps to a task', () => {
    const taskSha = 'e'.repeat(40);
    const entry = buildReleasePanelEntry({
      release: {
        ...emptyRelease('app'),
        productionSha: PROD,
        stagingSha: taskSha,
        stagingStatus: 'ready',
      },
      mainSha: taskSha,
      stagingUrl: null,
      hasProductionDeploy: true,
      tasks: [
        { id: 't1', title: 'T', repo: 'app', state: 'done', mergedSha: taskSha },
      ],
      rangeShas: new Set([taskSha]),
      rangeCommits: [{ sha: taskSha, subject: 'hercules: merge t1 — T' }],
    });
    expect(entry.directCommits).toEqual([]);
    expect(entry.trustChain).not.toMatch(/direct commit/i);
  });

  it('covers gate-merged candidate intermediate commits (not false direct)', () => {
    const mergeSha = '1'.repeat(40);
    const verified = '2'.repeat(40);
    const intermediate1 = '3'.repeat(40);
    const intermediate2 = '4'.repeat(40);
    const trueDirect = '5'.repeat(40);
    const entry = buildReleasePanelEntry({
      release: {
        ...emptyRelease('app'),
        productionSha: PROD,
        stagingSha: mergeSha,
        stagingStatus: 'ready',
      },
      mainSha: mergeSha,
      stagingUrl: null,
      hasProductionDeploy: true,
      tasks: [
        {
          id: 't1',
          title: 'Gate task',
          repo: 'app',
          state: 'done',
          mergedSha: mergeSha,
          verifiedSha: verified,
          mergedVia: 'gate',
        },
      ],
      rangeCommits: [
        { sha: mergeSha, subject: 'hercules: merge t1 — Gate task' },
        { sha: intermediate2, subject: 'hercules: t1 — fix lint' },
        { sha: intermediate1, subject: 'hercules: t1 — implement' },
        { sha: verified, subject: 'hercules: t1 — verified tip' },
        { sha: trueDirect, subject: 'ops: manual hotfix' },
      ],
      // Caller-proved ancestry of verified tip (includes intermediate + verified).
      gateCoveredShas: new Set([verified, intermediate1, intermediate2]),
    });
    expect(entry.directCommits.map((c) => c.sha)).toEqual([trueDirect]);
    expect(entry.directCommits.map((c) => c.subject)).toEqual(['ops: manual hotfix']);
    expect(entry.trustChain).toMatch(/1 direct commit/i);
  });

  it('does not over-attribute side commits without gateCoveredShas', () => {
    const mergeSha = 'a'.repeat(40);
    const side = 'b'.repeat(40);
    const entry = buildReleasePanelEntry({
      release: {
        ...emptyRelease('app'),
        productionSha: PROD,
        stagingSha: mergeSha,
        stagingStatus: 'ready',
      },
      mainSha: mergeSha,
      stagingUrl: null,
      hasProductionDeploy: true,
      tasks: [
        {
          id: 't1',
          title: 'T',
          repo: 'app',
          state: 'done',
          mergedSha: mergeSha,
          verifiedSha: 'c'.repeat(40),
          mergedVia: 'gate',
        },
      ],
      rangeCommits: [
        { sha: mergeSha, subject: 'hercules: merge t1 — T' },
        { sha: side, subject: 'fix: unrelated' },
      ],
      // no gateCoveredShas → only exact merged_sha + merge subject covered
    });
    expect(entry.directCommits.map((c) => c.sha)).toEqual([side]);
  });
});

describe('previousProductionSha', () => {
  it('returns null for empty history', () => {
    expect(previousProductionSha(emptyRelease('app'))).toBeNull();
  });

  it('returns null when latest entry is rolled_back', () => {
    const release: Release = {
      ...emptyRelease('app'),
      productionSha: PROD,
      history: [
        { sha: MAIN, at: AT, outcome: 'ok' },
        { sha: PROD, at: AT2, outcome: 'rolled_back', rollbackOf: STAGING },
      ],
    };
    expect(previousProductionSha(release)).toBeNull();
  });

  it('returns null when only one ok entry (first promote)', () => {
    const release: Release = {
      ...emptyRelease('app'),
      productionSha: PROD,
      history: [{ sha: PROD, at: AT, outcome: 'ok' }],
    };
    expect(previousProductionSha(release)).toBeNull();
  });

  it('returns the earlier ok sha for [ok A, ok B] with production B', () => {
    const release: Release = {
      ...emptyRelease('app'),
      productionSha: PROD,
      history: [
        { sha: MAIN, at: AT, outcome: 'ok' },
        { sha: PROD, at: AT2, outcome: 'ok' },
      ],
    };
    expect(previousProductionSha(release)).toBe(MAIN);
  });

  it('skips a rolled_back entry between ok tips', () => {
    const release: Release = {
      ...emptyRelease('app'),
      productionSha: PROD,
      history: [
        { sha: MAIN, at: AT, outcome: 'ok' },
        {
          sha: MAIN,
          at: AT2,
          outcome: 'rolled_back',
          rollbackOf: STAGING,
        },
        { sha: PROD, at: '2026-07-17T14:00:00.000Z', outcome: 'ok' },
      ],
    };
    expect(previousProductionSha(release)).toBe(MAIN);
  });
});

describe('buildReleasePanelEntry afterDeployChecks', () => {
  const LIVE = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const OTHER = 'ffffffffffffffffffffffffffffffffffffffff';
  const afterDeployBody = `## Definition of Done
- [ ] (human, after deploy) Open /x on the phone
- [ ] (human) Confirm on staging
- [ ] (mechanical) gates @gate:test
`;

  function releaseWithPromoteHistory(): Release {
    return {
      ...emptyRelease('app'),
      productionSha: PROD,
      stagingSha: STAGING,
      stagingStatus: 'ready',
      history: [
        { sha: MAIN, at: AT, outcome: 'ok' },
        { sha: PROD, at: AT2, outcome: 'ok' },
      ],
    };
  }

  it('lists after-deploy checks only for tasks in the live promote range', () => {
    const entry = buildReleasePanelEntry({
      release: releaseWithPromoteHistory(),
      mainSha: STAGING,
      stagingUrl: null,
      hasProductionDeploy: true,
      liveRangeShas: new Set([LIVE, PROD]),
      tasks: [
        {
          id: 't1',
          title: 'Ship /x',
          repo: 'app',
          state: 'done',
          mergedSha: LIVE,
          body: afterDeployBody,
        },
        {
          id: 't2',
          title: 'Other',
          repo: 'app',
          state: 'done',
          mergedSha: OTHER,
          body: `## Definition of Done
- [ ] (human, after deploy) Should not appear
`,
        },
      ],
    });
    expect(entry.afterDeployChecks).toEqual([
      { taskId: 't1', title: 'Ship /x', text: 'Open /x on the phone' },
    ]);
  });

  it('returns [] when liveRangeShas is omitted', () => {
    const entry = buildReleasePanelEntry({
      release: releaseWithPromoteHistory(),
      mainSha: STAGING,
      stagingUrl: null,
      hasProductionDeploy: true,
      tasks: [
        {
          id: 't1',
          title: 'Ship /x',
          repo: 'app',
          state: 'done',
          mergedSha: LIVE,
          body: afterDeployBody,
        },
      ],
    });
    expect(entry.afterDeployChecks).toEqual([]);
  });

  it('returns [] when history is empty (no previous production)', () => {
    const entry = buildReleasePanelEntry({
      release: {
        ...emptyRelease('app'),
        productionSha: PROD,
        stagingSha: STAGING,
        stagingStatus: 'ready',
        history: [],
      },
      mainSha: STAGING,
      stagingUrl: null,
      hasProductionDeploy: true,
      liveRangeShas: new Set([LIVE, PROD]),
      tasks: [
        {
          id: 't1',
          title: 'Ship /x',
          repo: 'app',
          state: 'done',
          mergedSha: LIVE,
          body: afterDeployBody,
        },
      ],
    });
    expect(entry.afterDeployChecks).toEqual([]);
  });
});
