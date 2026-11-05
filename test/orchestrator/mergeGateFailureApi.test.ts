import { describe, it, expect } from 'vitest';
import { buildMergeGateFailureReceipt, publicMergeFailureReceipt } from '../../src/domain/mergeFailureReceipt.js';

describe('merge gate failure API DTO', () => {
  it('exposes merge_gate_failed distinctly with redacted public fields', () => {
    const receipt = buildMergeGateFailureReceipt({
      operationId: 'mf-api-1',
      createdAt: '2026-08-03T12:00:00.000Z',
      repoKey: 'app',
      taskIds: ['T-1'],
      failedGate: 'test',
      exitStatus: 1,
      rawOutput: 'Authorization: Bearer eyJ-secret-token FAIL boom',
    });
    const pub = publicMergeFailureReceipt(receipt);
    expect(pub.operationStatus).toBe('merge_gate_failed');
    expect(pub.verificationSucceeded).toBe(true);
    expect(pub.remoteDefaultBranchChanged).toBe(false);
    expect(pub.failureSummary).not.toMatch(/eyJ-secret-token/);
    expect(JSON.stringify(pub)).not.toMatch(/eyJ-secret-token/);
  });
});
