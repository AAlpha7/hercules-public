import { describe, expect, it } from 'vitest';
import {
  buildReviewerInfrastructureReceipt,
  classifyReviewerInfrastructureFailure,
  reviewerProviderHealth,
} from '../../src/domain/reviewerInfrastructure.js';

describe('reviewer infrastructure recovery receipt', () => {
  it('classifies authentication separately and bounds/redacts durable detail', () => {
    const receipt = buildReviewerInfrastructureReceipt({
      provider: 'grok',
      detail: `Not signed in; Authorization: Bearer secret-token ${'x'.repeat(800)}`,
      observedAt: '2026-08-03T16:00:00.000Z',
      candidateSha: 'a'.repeat(40),
      branch: 'hercules/task-a',
      worktree: '/work/app/task-a',
      greenEvidence: ['typecheck', 'lint', 'test', 'behavioral'],
    });

    expect(receipt.failureKind).toBe('authentication');
    expect(receipt.state).toBe('blocked');
    expect(receipt.detail).not.toContain('secret-token');
    expect(receipt.detail.length).toBeLessThanOrEqual(320);
    expect(receipt.nextAction).toBe('Run reviewer health check or explicitly recover grok');
  });

  it('classifies transient provider failures without treating them as verdicts', () => {
    expect(classifyReviewerInfrastructureFailure('upstream 502 connection reset')).toBe(
      'transient',
    );
    expect(classifyReviewerInfrastructureFailure('Not signed in; run grok login')).toBe(
      'authentication',
    );
  });

  it('aggregates persisted blocked/ready receipts into provider health', () => {
    const base = buildReviewerInfrastructureReceipt({
      provider: 'grok',
      detail: 'Not signed in',
      observedAt: '2026-08-03T16:00:00.000Z',
      candidateSha: 'a'.repeat(40),
      branch: 'hercules/task-a',
      worktree: '/work/app/task-a',
      greenEvidence: ['typecheck'],
    });
    expect(reviewerProviderHealth([base])).toMatchObject([
      { provider: 'grok', state: 'blocked', blockedCandidates: 1 },
    ]);
    expect(reviewerProviderHealth([{ ...base, state: 'ready' }])).toMatchObject([
      { provider: 'grok', state: 'recovering', blockedCandidates: 0 },
    ]);
  });
});
