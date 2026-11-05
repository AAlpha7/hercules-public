import { describe, expect, it } from 'vitest';
import {
  PR_BEHIND_REQUEUE_CAP,
  buildFactoryBehindSteer,
  buildFactoryBehindThrashSection,
  buildFactoryRebasedAuditSection,
  countPrBehindSteers,
  isFactoryBehind,
  shouldCapPrBehindRequeue,
  shouldRebaseFactoryBehind,
  shouldRequeueFactoryBehind,
} from '../../src/domain/factoryBehind.js';
import { extractFactoryPrHeadRef, resolveFactoryLaunchRef } from '../../src/domain/factoryConflict.js';

describe('isFactoryBehind', () => {
  it('treats only GitHub mergeStateStatus BEHIND as actionable', () => {
    expect(isFactoryBehind('BEHIND')).toBe(true);
    expect(isFactoryBehind('behind')).toBe(true);
    expect(isFactoryBehind('CLEAN')).toBe(false);
    expect(isFactoryBehind('DIRTY')).toBe(false);
    expect(isFactoryBehind('BLOCKED')).toBe(false);
    expect(isFactoryBehind('UNSTABLE')).toBe(false);
    expect(isFactoryBehind('UNKNOWN')).toBe(false);
    expect(isFactoryBehind('')).toBe(false);
  });
});

describe('shouldRebaseFactoryBehind', () => {
  it('rebases BEHIND when checks are green, pending, empty, or unknown', () => {
    expect(
      shouldRebaseFactoryBehind({ mergeStateStatus: 'BEHIND', ciStatus: 'success' }),
    ).toBe(true);
    expect(
      shouldRebaseFactoryBehind({ mergeStateStatus: 'BEHIND', ciStatus: 'pending' }),
    ).toBe(true);
    expect(
      shouldRebaseFactoryBehind({ mergeStateStatus: 'BEHIND', ciStatus: 'neutral' }),
    ).toBe(true);
    expect(
      shouldRebaseFactoryBehind({ mergeStateStatus: 'BEHIND', ciStatus: 'unknown' }),
    ).toBe(true);
    expect(
      shouldRebaseFactoryBehind({ mergeStateStatus: 'BEHIND', ciStatus: '' }),
    ).toBe(true);
  });

  it('leaves red checks and non-behind states to the existing observe paths', () => {
    expect(
      shouldRebaseFactoryBehind({ mergeStateStatus: 'BEHIND', ciStatus: 'failure' }),
    ).toBe(false);
    expect(
      shouldRebaseFactoryBehind({ mergeStateStatus: 'CLEAN', ciStatus: 'success' }),
    ).toBe(false);
    expect(
      shouldRebaseFactoryBehind({ mergeStateStatus: 'DIRTY', ciStatus: 'success' }),
    ).toBe(false);
  });
});

describe('buildFactoryRebasedAuditSection', () => {
  it('names the GitHub rebase and is not a skip for a later sibling merge', () => {
    const md = buildFactoryRebasedAuditSection({
      stamp: 't',
      prUrl: 'https://github.com/example-org/acme/pull/41',
    });
    expect(md).toMatch(/Factory PR rebased via GitHub/);
    expect(md).toContain('https://github.com/example-org/acme/pull/41');
    expect(md).toMatch(/Not a Cloud Agent relaunch/);
    expect(md).toMatch(/Not an Approve/);
    expect(md).toMatch(/Not MergeService/);
    expect(
      shouldRebaseFactoryBehind({ mergeStateStatus: 'BEHIND', ciStatus: 'success' }),
    ).toBe(true);
  });
});

describe('shouldRequeueFactoryBehind', () => {
  it('rebases BEHIND when checks are green, empty, or unknown', () => {
    expect(
      shouldRequeueFactoryBehind({ mergeStateStatus: 'BEHIND', ciStatus: 'success' }),
    ).toBe(true);
    expect(
      shouldRequeueFactoryBehind({ mergeStateStatus: 'BEHIND', ciStatus: 'neutral' }),
    ).toBe(true);
    expect(
      shouldRequeueFactoryBehind({ mergeStateStatus: 'BEHIND', ciStatus: 'unknown' }),
    ).toBe(true);
    expect(
      shouldRequeueFactoryBehind({ mergeStateStatus: 'BEHIND', ciStatus: '' }),
    ).toBe(true);
  });

  it('leaves pending or red checks to the existing observe paths', () => {
    expect(
      shouldRequeueFactoryBehind({ mergeStateStatus: 'BEHIND', ciStatus: 'pending' }),
    ).toBe(false);
    expect(
      shouldRequeueFactoryBehind({ mergeStateStatus: 'BEHIND', ciStatus: 'failure' }),
    ).toBe(false);
    expect(
      shouldRequeueFactoryBehind({ mergeStateStatus: 'CLEAN', ciStatus: 'success' }),
    ).toBe(false);
  });
});

describe('buildFactoryBehindSteer', () => {
  const steer = buildFactoryBehindSteer({
    prUrl: 'https://github.com/example-org/acme/pull/41',
    headRef: 'cursor/cloud-T-factory-abc',
    defaultBranch: 'main',
    taskId: 'T-factory',
  });

  it('names the Cloud Agent head, not hercules/<id>', () => {
    expect(steer).toMatch(/BEHIND/i);
    expect(steer).toContain('https://github.com/example-org/acme/pull/41');
    expect(steer).toContain('cursor/cloud-T-factory-abc');
    expect(steer).toContain('main');
    expect(steer).not.toMatch(/work \*\*only\*\* on branch `hercules\/T-factory`/i);
    expect(steer).toMatch(/Do \*\*not\*\* create `hercules\/T-factory`/);
    expect(steer).toMatch(/Do not open a second PR/);
    expect(steer).toMatch(/no longer BEHIND/);
  });

  it('is extractable as a factory launch ref on an open PR', () => {
    expect(extractFactoryPrHeadRef(steer)).toBe('cursor/cloud-T-factory-abc');
    expect(
      resolveFactoryLaunchRef({
        defaultBranch: 'main',
        hasOpenPr: true,
        pendingSteer: steer,
      }),
    ).toBe('cursor/cloud-T-factory-abc');
  });
});

describe('pr-behind thrash cap', () => {
  it('caps after PR_BEHIND_REQUEUE_CAP steers and after an existing brake', () => {
    const body = [
      '## System steer (pr-behind) (t1)',
      '',
      'first',
      '',
      '## System steer (pr-behind) (t2)',
      '',
      'second',
    ].join('\n');
    expect(countPrBehindSteers(body)).toBe(PR_BEHIND_REQUEUE_CAP);
    expect(shouldCapPrBehindRequeue(body)).toBe(true);
    expect(shouldCapPrBehindRequeue('## Task\nno steers')).toBe(false);
    expect(shouldCapPrBehindRequeue('## Thrash brake (pr-behind) (t)\nparked')).toBe(true);
  });

  it('does not share the CONFLICTING or CI caps', () => {
    const other = [
      '## System steer (pr-mergeable) (t1)',
      '',
      'first',
      '',
      '## System steer (pr-mergeable) (t2)',
      '',
      'second',
      '',
      '## System steer (pr-ci) (t1)',
      '',
      'ci',
      '',
      '## System steer (pr-ci) (t2)',
      '',
      'ci2',
    ].join('\n');
    expect(countPrBehindSteers(other)).toBe(0);
    expect(shouldCapPrBehindRequeue(other)).toBe(false);
  });

  it('factory thrash section keeps the Cloud Agent head as the source of truth', () => {
    const md = buildFactoryBehindThrashSection({
      stamp: 't',
      prUrl: 'https://github.com/example-org/acme/pull/41',
      headRef: 'cursor/cloud-T-factory-abc',
      taskId: 'T-factory',
    });
    expect(md).toMatch(/Thrash brake \(pr-behind\)/);
    expect(md).toContain('cursor/cloud-T-factory-abc');
    expect(md).not.toMatch(/Work \*\*only\*\* on branch `hercules\/T-factory`/);
  });
});
