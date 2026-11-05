import { describe, expect, it } from 'vitest';
import {
  assertReviewDecisionReceiptMatches,
  parseReviewDecisionRequestV1,
  reviewDecisionBindingHash,
  reviewDecisionReceiptHash,
  reviewDecisionRequestHash,
  snapshotReviewDecisionReceiptV1,
  snapshotReviewDecisionResponseV1,
} from '../../src/domain/reviewDecision.js';

const SHA = `sha256:${'a'.repeat(64)}`;
const binding = {
  taskId: 'task-1',
  contractVersion: 1,
  contractHash: SHA,
  iterationId: 'iteration-1',
  candidateRef: {
    kind: 'git' as const,
    repository: 'example-org/acme',
    revision: '0123456789abcdef0123456789abcdef01234567',
  },
  evidenceManifestHash: SHA,
  evaluatorVersion: 'evaluator-v1',
  evaluatorModel: 'model-v1',
  evaluatorRuntime: 'runtime-v1',
  policyVersion: 'policy-v1',
};

function request() {
  return {
    schema: 'hercules-review-decision-request/v1' as const,
    clientRequestId: 'request-1',
    taskId: 'task-1',
    projectionHash: SHA,
    decisionBinding: binding,
    action: 'approve_outcome' as const,
    reason: null,
    acknowledgedRiskCodes: ['risk-a'],
  };
}

describe('review decision closed models', () => {
  it('detaches an exact decision request and computes canonical hashes', () => {
    const source = request();
    const parsed = parseReviewDecisionRequestV1(source);
    source.decisionBinding.candidateRef.repository = 'changed';
    expect(parsed.decisionBinding.candidateRef).toMatchObject({ repository: 'example-org/acme' });
    expect(reviewDecisionRequestHash(parsed)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(reviewDecisionBindingHash(parsed.decisionBinding)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it.each([
    ['unknown field', { ...request(), enabled: true }],
    ['caller actor', { ...request(), actor: { kind: 'human', id: 'owner', issuer: 'web' } }],
    ['unsorted risks', { ...request(), acknowledgedRiskCodes: ['z-risk', 'a-risk'] }],
    ['duplicate risks', { ...request(), acknowledgedRiskCodes: ['risk-a', 'risk-a'] }],
    ['too many risks', {
      ...request(),
      acknowledgedRiskCodes: Array.from(
        { length: 8 * 1024 + 1 },
        (_, index) => `risk-${String(index).padStart(5, '0')}`,
      ),
    }],
    ['non-Git candidate', { ...request(), decisionBinding: { ...binding, candidateRef: { kind: 'artifact', artifactId: 'a', sha256: SHA } } }],
    ['missing iteration', { ...request(), decisionBinding: { ...binding, iterationId: null } }],
    ['empty required reason', { ...request(), reason: '' }],
  ])('rejects %s', (_label, value) => {
    expect(() => parseReviewDecisionRequestV1(value)).toThrow();
  });

  it('validates the immutable receipt hash and canonical timestamp', () => {
    const parsed = parseReviewDecisionRequestV1(request());
    const body = {
      schema: 'hercules-review-decision-receipt/v1' as const,
      clientRequestId: parsed.clientRequestId,
      requestHash: reviewDecisionRequestHash(parsed),
      taskId: parsed.taskId,
      actor: { kind: 'human' as const, id: 'operator-1', issuer: 'fixture-issuer' },
      acceptedProjectionHash: parsed.projectionHash,
      acceptedDecisionBindingHash: reviewDecisionBindingHash(parsed.decisionBinding),
      action: parsed.action,
      humanDecisionId: 'decision-1',
      eventId: 'event-1',
      priorIterationId: 'iteration-1',
      resultingIterationId: 'iteration-1',
      recordedAt: '2026-08-29T10:00:00.000Z',
    };
    const receipt = { ...body, receiptHash: reviewDecisionReceiptHash(body) };
    expect(snapshotReviewDecisionReceiptV1(receipt)).toEqual(receipt);
    expect(snapshotReviewDecisionResponseV1({
      schema: 'hercules-review-decision-response/v1', receipt, duplicate: false,
    }).receipt).toEqual(receipt);
    expect(assertReviewDecisionReceiptMatches({
      request: parsed,
      requestHash: reviewDecisionRequestHash(parsed),
      actor: body.actor,
      receipt,
    })).toEqual(receipt);
    expect(() => snapshotReviewDecisionReceiptV1({ ...receipt, action: 'reject_outcome' })).toThrow();
    expect(() => snapshotReviewDecisionReceiptV1({ ...receipt, recordedAt: '2026-08-29T10:00:00Z' })).toThrow();
    expect(() => assertReviewDecisionReceiptMatches({
      request: parsed,
      requestHash: reviewDecisionRequestHash(parsed),
      actor: { ...body.actor, issuer: 'other-issuer' },
      receipt,
    })).toThrow();
  });
});
