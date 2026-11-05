import { describe, it, expect } from 'vitest';
import {
  trailingRunFailureStreak,
  shouldParkForThrash,
  countPrMergeableSteers,
  shouldCapPrConflictRequeue,
  buildPrConflictThrashSection,
  THRASH_CONSECUTIVE_LIMIT,
  PR_CONFLICT_REQUEUE_CAP,
} from '../../src/domain/thrash.js';
import { buildRunFailureSection } from '../../src/domain/runFailure.js';

describe('trailingRunFailureStreak', () => {
  it('counts consecutive same kind from the end', () => {
    const a = buildRunFailureSection({
      stamp: 't1',
      kind: 'agent_exit',
      attempt: 1,
      maxAttempts: 3,
    });
    const b = buildRunFailureSection({
      stamp: 't2',
      kind: 'agent_exit',
      attempt: 2,
      maxAttempts: 3,
    });
    const body = `## Task\nok\n\n${a}\n${b}`;
    const streak = trailingRunFailureStreak(body);
    expect(streak).toEqual({ kind: 'agent_exit', count: 2 });
  });

  it('resets when kind changes', () => {
    const a = buildRunFailureSection({
      stamp: 't1',
      kind: 'agent_exit',
      attempt: 1,
      maxAttempts: 3,
    });
    const b = buildRunFailureSection({
      stamp: 't2',
      kind: 'stall',
      attempt: 2,
      maxAttempts: 3,
    });
    expect(trailingRunFailureStreak(`${a}\n${b}`)).toEqual({ kind: 'stall', count: 1 });
  });
});

describe('shouldParkForThrash', () => {
  it('parks when next failure would hit consecutive limit', () => {
    const prior = buildRunFailureSection({
      stamp: 't1',
      kind: 'agent_exit',
      attempt: 1,
      maxAttempts: 5,
    });
    expect(
      shouldParkForThrash({
        body: prior,
        nextKind: 'agent_exit',
        attemptsAfter: 2,
        maxAttempts: 5,
      }),
    ).toBe(true);
    expect(THRASH_CONSECUTIVE_LIMIT).toBe(2);
  });

  it('does not thrash-park when max attempts already decides', () => {
    expect(
      shouldParkForThrash({
        body: '',
        nextKind: 'agent_exit',
        attemptsAfter: 3,
        maxAttempts: 3,
      }),
    ).toBe(false);
  });
});

describe('pr conflict requeue cap', () => {
  it('counts system steers and caps', () => {
    const body = [
      '## System steer (pr-mergeable) (t1)',
      'x',
      '## System steer (pr-mergeable) (t2)',
      'y',
    ].join('\n');
    expect(countPrMergeableSteers(body)).toBe(PR_CONFLICT_REQUEUE_CAP);
    expect(shouldCapPrConflictRequeue(body)).toBe(true);
    expect(shouldCapPrConflictRequeue('## Task\nno steers')).toBe(false);
  });

  it('buildPrConflictThrashSection states single source of truth', () => {
    const md = buildPrConflictThrashSection({
      stamp: 't',
      prUrl: 'https://github.com/x/y/pull/1',
      taskId: 'settings-build',
    });
    expect(md).toMatch(/Thrash brake \(pr-mergeable\)/);
    expect(md).toMatch(/hercules\/settings-build/);
    expect(md).toMatch(/dual-write/i);
  });
});
