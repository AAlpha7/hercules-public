import { describe, expect, it } from 'vitest';
import {
  parseReviewEvidenceReadRequestV1,
  snapshotReviewEvidencePortResultV1,
} from '../../src/domain/reviewEvidence.js';
import { snapshotLearningProposalViewsV1 } from '../../src/domain/learningProposalView.js';

const SHA = `sha256:${'a'.repeat(64)}`;

describe('M7 review read models', () => {
  it('accepts only an exact evidence request and copies provider bytes', () => {
    expect(parseReviewEvidenceReadRequestV1({
      schema: 'hercules-review-evidence-read/v1',
      taskId: 'task-1', projectionHash: SHA, artifactRefId: 'artifact-1',
    })).toMatchObject({ taskId: 'task-1', artifactRefId: 'artifact-1' });
    expect(() => parseReviewEvidenceReadRequestV1({
      schema: 'hercules-review-evidence-read/v1',
      taskId: 'task-1', projectionHash: SHA, artifactRefId: 'artifact-1', extra: true,
    })).toThrow('invalid schema');
    const bytes = Uint8Array.from([1, 2]);
    const result = snapshotReviewEvidencePortResultV1({
      status: 'available', sha256: SHA, mediaType: 'image/png',
      redactionState: 'none', bytes,
    });
    bytes[0] = 9;
    expect(result.status === 'available' ? result.bytes : null).toEqual(Uint8Array.from([1, 2]));
  });

  it('keeps learning proposals exact, bounded, sorted, and evidence arrays unique', () => {
    const proposal = {
      schema: 'hercules-learning-proposal-view/v1',
      id: 'proposal-1', taskId: 'task-1', projectionHash: SHA,
      title: 'Retain the gate', advisorySummary: 'Advisory only.',
      status: 'proposed', evidenceArtifactIds: ['artifact-1'],
    };
    expect(snapshotLearningProposalViewsV1([proposal])).toEqual([proposal]);
    expect(() => snapshotLearningProposalViewsV1([
      { ...proposal, evidenceArtifactIds: ['artifact-1', 'artifact-1'] },
    ])).toThrow('sorted and unique');
    expect(() => snapshotLearningProposalViewsV1([
      { ...proposal, status: 'implemented' },
    ])).toThrow('invalid');
    expect(() => snapshotLearningProposalViewsV1([
      { ...proposal, extra: true },
    ])).toThrow('invalid schema');
    const sparse = Array<unknown>(1);
    expect(() => snapshotLearningProposalViewsV1(sparse)).toThrow('bounded array');
    const sparseEvidence = { ...proposal, evidenceArtifactIds: Array<string>(1) };
    expect(() => snapshotLearningProposalViewsV1([sparseEvidence]))
      .toThrow('bounded array');
  });
});
