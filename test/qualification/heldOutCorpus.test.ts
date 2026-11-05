import { describe, expect, it } from 'vitest';
import { canonicalSerialize } from '../../src/domain/canonicalJson.js';
import {
  assertHeldOutCaseResultV1,
  computeHeldOutCaseResultHash,
} from '../../src/domain/qualification.js';
import { runHeldOutCorpus } from '../../src/qualification/heldOutCorpus.js';

const NOW = '2026-09-01T00:00:00.000Z';
const NOW_AGAIN = '2026-09-01T00:00:00.000Z';

describe('runHeldOutCorpus', () => {
  it('returns valid HeldOutCaseResultV1[] for the fixed corpus', () => {
    const results = runHeldOutCorpus(NOW);
    expect(results.length).toBeGreaterThanOrEqual(3);
    const caseIds = new Set<string>();
    for (const result of results) {
      assertHeldOutCaseResultV1(result);
      expect(result.resultHash).toBe(
        computeHeldOutCaseResultHash({
          caseId: result.caseId,
          taskContractHash: result.taskContractHash,
          outcomeDecision: result.outcomeDecision,
          evidenceManifestHash: result.evidenceManifestHash,
        }),
      );
      expect(caseIds.has(result.caseId)).toBe(false);
      caseIds.add(result.caseId);
    }
    expect(caseIds.has('H2V1-HO-001')).toBe(true);
    expect(caseIds.has('H2V1-HO-003')).toBe(true);
    expect(caseIds.has('H2V1-HO-009')).toBe(true);
  });

  it('is deterministic — identical now yields byte-identical results', () => {
    const first = runHeldOutCorpus(NOW);
    const second = runHeldOutCorpus(NOW_AGAIN);
    expect(canonicalSerialize(second)).toBe(canonicalSerialize(first));
  });

  it('rejects a non-canonical injected now', () => {
    expect(() => runHeldOutCorpus('not-a-timestamp')).toThrow(
      /canonical UTC-Z/,
    );
  });
});
