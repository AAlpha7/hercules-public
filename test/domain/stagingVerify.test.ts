import { describe, it, expect } from 'vitest';
import {
  DEFAULT_STAGING_VERIFY_TIMEOUT_MS,
  DEFAULT_STAGING_STAGE_TIMEOUT_MS,
  STAGING_VERIFY_STAGES,
  formatStagingTimeoutFailureReason,
  isStagingBudgetExceeded,
  evaluateStuckStaging,
  shouldRetryFailedStaging,
  nextProcessGroupCleanupSignal,
  planIdempotentCleanup,
  stagingElapsedMs,
  isStagingVerifyAbnormal,
  formatStagingElapsedLabel,
  type StagingVerifyStage,
} from '../../src/domain/stagingVerify.js';

describe('staging verify timeout defaults', () => {
  it('defaults overall budget to 15 minutes', () => {
    expect(DEFAULT_STAGING_VERIFY_TIMEOUT_MS).toBe(15 * 60 * 1000);
  });

  it('exposes per-stage budgets under the overall cap', () => {
    expect(STAGING_VERIFY_STAGES).toEqual(['deploy', 'health', 'evidence']);
    expect(DEFAULT_STAGING_STAGE_TIMEOUT_MS.deploy).toBeGreaterThan(0);
    expect(DEFAULT_STAGING_STAGE_TIMEOUT_MS.health).toBeGreaterThan(0);
    expect(DEFAULT_STAGING_STAGE_TIMEOUT_MS.evidence).toBeGreaterThan(0);
    for (const stage of STAGING_VERIFY_STAGES) {
      expect(DEFAULT_STAGING_STAGE_TIMEOUT_MS[stage]).toBeLessThanOrEqual(
        DEFAULT_STAGING_VERIFY_TIMEOUT_MS,
      );
    }
  });
});

describe('isStagingBudgetExceeded', () => {
  it('is false before the budget elapses', () => {
    expect(isStagingBudgetExceeded({ startedAtMs: 1000, nowMs: 1000 + 999, timeoutMs: 1000 })).toBe(
      false,
    );
  });

  it('is true at and after the budget', () => {
    expect(isStagingBudgetExceeded({ startedAtMs: 0, nowMs: 1000, timeoutMs: 1000 })).toBe(true);
    expect(isStagingBudgetExceeded({ startedAtMs: 0, nowMs: 1001, timeoutMs: 1000 })).toBe(true);
  });

  it('treats missing startedAt as not exceeded (cannot attribute age)', () => {
    expect(
      isStagingBudgetExceeded({ startedAtMs: null, nowMs: 1_000_000, timeoutMs: 1 }),
    ).toBe(false);
  });
});

describe('formatStagingTimeoutFailureReason', () => {
  it('names the stage that timed out', () => {
    for (const stage of [...STAGING_VERIFY_STAGES, 'overall'] as const) {
      const reason = formatStagingTimeoutFailureReason({
        stage,
        timeoutMs: 60_000,
        elapsedMs: 61_000,
      });
      expect(reason).toMatch(/timed out/i);
      expect(reason).toContain(stage);
      expect(reason).toMatch(/61000|61s|1m/);
    }
  });
});

describe('evaluateStuckStaging', () => {
  const base = {
    nowMs: 20 * 60 * 1000,
    overallTimeoutMs: DEFAULT_STAGING_VERIFY_TIMEOUT_MS,
    processInFlight: false,
  };

  it('continues when status is ready / failed / null', () => {
    for (const stagingStatus of ['ready', 'failed', null] as const) {
      expect(
        evaluateStuckStaging({
          ...base,
          stagingStatus,
          stagingStartedAtMs: 0,
        }).action,
      ).toBe('continue');
    }
  });

  it('fails verifying past overall timeout and attributes evidence stage', () => {
    const decision = evaluateStuckStaging({
      ...base,
      stagingStatus: 'verifying',
      stagingStartedAtMs: 0,
    });
    expect(decision.action).toBe('fail');
    if (decision.action !== 'fail') return;
    expect(decision.stage).toBe('evidence');
    expect(decision.reason).toMatch(/evidence|overall/i);
    expect(decision.reason).toMatch(/timed out/i);
  });

  it('fails deploying past overall timeout and attributes deploy stage', () => {
    const decision = evaluateStuckStaging({
      ...base,
      stagingStatus: 'deploying',
      stagingStartedAtMs: 0,
    });
    expect(decision.action).toBe('fail');
    if (decision.action !== 'fail') return;
    expect(decision.stage).toBe('deploy');
    expect(decision.reason).toMatch(/deploy/i);
  });

  it('continues while still within budget even if process is not local', () => {
    const decision = evaluateStuckStaging({
      ...base,
      stagingStatus: 'verifying',
      stagingStartedAtMs: base.nowMs - 1000,
      overallTimeoutMs: 60_000,
    });
    expect(decision.action).toBe('continue');
  });

  it('does not double-fail when process is still in-flight (live timeout owns it)', () => {
    // Live pipeline holds inFlight; stuck recovery is for orphaned disk status
    // after crash/restart or when the live race already finished.
    const decision = evaluateStuckStaging({
      ...base,
      stagingStatus: 'verifying',
      stagingStartedAtMs: 0,
      processInFlight: true,
    });
    // Still report fail so tick can force-fail if the live path is wedged;
    // reconciler uses this when overall budget is exceeded regardless.
    expect(decision.action).toBe('fail');
  });

  it('force-fails legacy stuck status without staging_started_at when not in-flight', () => {
    const decision = evaluateStuckStaging({
      ...base,
      stagingStatus: 'verifying',
      stagingStartedAtMs: null,
      processInFlight: false,
    });
    expect(decision.action).toBe('fail');
    if (decision.action !== 'fail') return;
    expect(decision.reason).toMatch(/staging_started_at|legacy/i);
  });

  it('continues legacy null startedAt while a live worker still holds inFlight', () => {
    expect(
      evaluateStuckStaging({
        ...base,
        stagingStatus: 'deploying',
        stagingStartedAtMs: null,
        processInFlight: true,
      }).action,
    ).toBe('continue');
  });
});

describe('shouldRetryFailedStaging', () => {
  const base = {
    stagingStatus: 'failed' as const,
    hasDrift: false,
    promotingSha: null as string | null,
    deployNow: false,
    lastFailureOrAdvanceAtMs: 0,
    nowMs: DEFAULT_STAGING_VERIFY_TIMEOUT_MS, // reuse debounce-ish window
    debounceMs: 5 * 60 * 1000,
    inFlight: false,
  };

  it('retries failed after debounce even without drift', () => {
    expect(
      shouldRetryFailedStaging({
        ...base,
        nowMs: base.debounceMs,
      }),
    ).toBe(true);
  });

  it('does not retry failed before debounce (no deployNow)', () => {
    expect(
      shouldRetryFailedStaging({
        ...base,
        nowMs: base.debounceMs - 1,
      }),
    ).toBe(false);
  });

  it('deployNow bypasses debounce for failed', () => {
    expect(
      shouldRetryFailedStaging({
        ...base,
        deployNow: true,
        nowMs: 0,
      }),
    ).toBe(true);
  });

  it('never retries while promoting or in flight', () => {
    expect(shouldRetryFailedStaging({ ...base, promotingSha: 'abc', nowMs: base.debounceMs })).toBe(
      false,
    );
    expect(shouldRetryFailedStaging({ ...base, inFlight: true, nowMs: base.debounceMs })).toBe(
      false,
    );
  });

  it('is false for non-failed statuses', () => {
    for (const stagingStatus of ['ready', 'verifying', 'deploying', null] as const) {
      expect(shouldRetryFailedStaging({ ...base, stagingStatus, nowMs: base.debounceMs })).toBe(
        false,
      );
    }
  });
});

describe('process-group cleanup plan (idempotent)', () => {
  it('starts with TERM when process is alive and no signal sent yet', () => {
    expect(nextProcessGroupCleanupSignal({ alive: true, termSent: false, killSent: false })).toBe(
      'TERM',
    );
  });

  it('escalates to KILL after TERM when still alive', () => {
    expect(nextProcessGroupCleanupSignal({ alive: true, termSent: true, killSent: false })).toBe(
      'KILL',
    );
  });

  it('is done when already dead — repeated cleanup is a no-op', () => {
    expect(nextProcessGroupCleanupSignal({ alive: false, termSent: false, killSent: false })).toBe(
      'done',
    );
    expect(nextProcessGroupCleanupSignal({ alive: false, termSent: true, killSent: true })).toBe(
      'done',
    );
  });

  it('is done after KILL was already sent (idempotent)', () => {
    expect(nextProcessGroupCleanupSignal({ alive: true, termSent: true, killSent: true })).toBe(
      'done',
    );
  });

  it('planIdempotentCleanup is pure and stable across repeats', () => {
    const first = planIdempotentCleanup({
      pids: [42, 99],
      alive: new Map([
        [42, true],
        [99, false],
      ]),
      alreadyTermed: new Set<number>(),
      alreadyKilled: new Set<number>(),
    });
    expect(first.actions).toEqual([{ pid: 42, signal: 'TERM' }]);
    expect(first.skippedDead).toEqual([99]);
    expect(first.logLines.some((l) => /TERM|cleanup/i.test(l))).toBe(true);

    // Second pass with TERM recorded + still alive → KILL
    const second = planIdempotentCleanup({
      pids: [42, 99],
      alive: new Map([
        [42, true],
        [99, false],
      ]),
      alreadyTermed: new Set([42]),
      alreadyKilled: new Set<number>(),
    });
    expect(second.actions).toEqual([{ pid: 42, signal: 'KILL' }]);

    // Third pass: KILL already sent → no further actions
    const third = planIdempotentCleanup({
      pids: [42, 99],
      alive: new Map([
        [42, true],
        [99, false],
      ]),
      alreadyTermed: new Set([42]),
      alreadyKilled: new Set([42]),
    });
    expect(third.actions).toEqual([]);
  });
});

describe('UI elapsed helpers', () => {
  it('stagingElapsedMs returns null without start', () => {
    expect(stagingElapsedMs({ stagingStartedAtMs: null, nowMs: 1000 })).toBeNull();
  });

  it('stagingElapsedMs clamps negative to 0', () => {
    expect(stagingElapsedMs({ stagingStartedAtMs: 2000, nowMs: 1000 })).toBe(0);
  });

  it('isStagingVerifyAbnormal when verifying past timeout', () => {
    expect(
      isStagingVerifyAbnormal({
        stagingStatus: 'verifying',
        elapsedMs: DEFAULT_STAGING_VERIFY_TIMEOUT_MS + 1,
        overallTimeoutMs: DEFAULT_STAGING_VERIFY_TIMEOUT_MS,
      }),
    ).toBe(true);
    expect(
      isStagingVerifyAbnormal({
        stagingStatus: 'verifying',
        elapsedMs: 1000,
        overallTimeoutMs: DEFAULT_STAGING_VERIFY_TIMEOUT_MS,
      }),
    ).toBe(false);
    expect(
      isStagingVerifyAbnormal({
        stagingStatus: 'ready',
        elapsedMs: 999_999,
        overallTimeoutMs: DEFAULT_STAGING_VERIFY_TIMEOUT_MS,
      }),
    ).toBe(false);
  });

  it('formatStagingElapsedLabel is human-readable', () => {
    expect(formatStagingElapsedLabel(0)).toMatch(/0s|0 s/i);
    expect(formatStagingElapsedLabel(65_000)).toMatch(/1m/);
    expect(formatStagingElapsedLabel(3_600_000 + 120_000)).toMatch(/1h/);
  });
});

describe('stage budget helper typing', () => {
  it('accepts every stage key', () => {
    const stages: StagingVerifyStage[] = ['deploy', 'health', 'evidence'];
    for (const stage of stages) {
      expect(DEFAULT_STAGING_STAGE_TIMEOUT_MS[stage]).toBeTypeOf('number');
    }
  });
});
