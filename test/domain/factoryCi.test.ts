import { describe, expect, it } from 'vitest';
import {
  PR_CI_REQUEUE_CAP,
  buildFactoryCiSteer,
  buildFactoryCiThrashSection,
  countPrCiSteers,
  isFactoryCiFailure,
  shouldCapPrCiRequeue,
} from '../../src/domain/factoryCi.js';
import { extractFactoryPrHeadRef, resolveFactoryLaunchRef } from '../../src/domain/factoryConflict.js';

describe('isFactoryCiFailure', () => {
  it('treats only a finished red rollup as actionable', () => {
    expect(isFactoryCiFailure('failure')).toBe(true);
    expect(isFactoryCiFailure('FAILURE')).toBe(true);
    expect(isFactoryCiFailure('pending')).toBe(false);
    expect(isFactoryCiFailure('success')).toBe(false);
    expect(isFactoryCiFailure('neutral')).toBe(false);
    expect(isFactoryCiFailure('unknown')).toBe(false);
    expect(isFactoryCiFailure('')).toBe(false);
  });
});

describe('buildFactoryCiSteer', () => {
  const steer = buildFactoryCiSteer({
    prUrl: 'https://github.com/example-org/acme/pull/41',
    headRef: 'cursor/cloud-T-factory-abc',
    defaultBranch: 'main',
    taskId: 'T-factory',
    ciSummary: '0 ok · 1 fail · 0 pending (1 checks)',
    failingChecks: ['CI / gates', '  ', 'lint'],
  });

  it('names the Cloud Agent head and failing checks, not hercules/<id>', () => {
    expect(steer).toMatch(/GitHub CI is failing/i);
    expect(steer).toContain('https://github.com/example-org/acme/pull/41');
    expect(steer).toContain('0 ok · 1 fail · 0 pending (1 checks)');
    expect(steer).toContain('Failing checks: CI / gates, lint');
    expect(steer).toContain('cursor/cloud-T-factory-abc');
    expect(steer).not.toMatch(/work \*\*only\*\* on branch `hercules\/T-factory`/i);
    expect(steer).toMatch(/Do \*\*not\*\* create `hercules\/T-factory`/);
    expect(steer).toMatch(/Do not open a second PR/);
    expect(steer).toMatch(/failing checks are green/);
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

describe('pr-ci thrash cap', () => {
  it('caps after PR_CI_REQUEUE_CAP steers and after an existing brake', () => {
    const body = [
      '## System steer (pr-ci) (t1)',
      '',
      'first',
      '',
      '## System steer (pr-ci) (t2)',
      '',
      'second',
    ].join('\n');
    expect(countPrCiSteers(body)).toBe(PR_CI_REQUEUE_CAP);
    expect(shouldCapPrCiRequeue(body)).toBe(true);
    expect(shouldCapPrCiRequeue('## Task\nno steers')).toBe(false);
    expect(shouldCapPrCiRequeue('## Thrash brake (pr-ci) (t)\nparked')).toBe(true);
  });

  it('does not share the CONFLICTING pr-mergeable cap', () => {
    const conflictOnly = [
      '## System steer (pr-mergeable) (t1)',
      '',
      'first',
      '',
      '## System steer (pr-mergeable) (t2)',
      '',
      'second',
    ].join('\n');
    expect(countPrCiSteers(conflictOnly)).toBe(0);
    expect(shouldCapPrCiRequeue(conflictOnly)).toBe(false);
  });

  it('factory thrash section keeps the Cloud Agent head as the source of truth', () => {
    const md = buildFactoryCiThrashSection({
      stamp: 't',
      prUrl: 'https://github.com/example-org/acme/pull/41',
      headRef: 'cursor/cloud-T-factory-abc',
      taskId: 'T-factory',
      ciSummary: '0 ok · 1 fail · 0 pending (1 checks)',
    });
    expect(md).toMatch(/Thrash brake \(pr-ci\)/);
    expect(md).toContain('cursor/cloud-T-factory-abc');
    expect(md).toContain('0 ok · 1 fail · 0 pending (1 checks)');
    expect(md).not.toMatch(/Work \*\*only\*\* on branch `hercules\/T-factory`/);
  });
});
