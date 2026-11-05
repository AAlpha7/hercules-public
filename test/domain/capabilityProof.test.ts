import { describe, expect, it } from 'vitest';

import {
  CRITERION_RESULT_STATUSES,
  type CriterionResultStatus,
} from '../../src/domain/evaluationVerdict.js';
import {
  CAPABILITY_ARCHETYPES,
  CapabilityProofError,
  MAX_OPERATOR_REVIEW_MS,
  MAX_PROOF_WALLCLOCK_MS,
  assembleCapabilityProof,
  assembleCapabilityProofSuite,
  assertBrowserEvidenceRefV1,
  assertCapabilityCostV1,
  assertCapabilityOperatorReviewV1,
  assertCapabilityProofSummaryV1,
  assertCapabilityProofSuiteV1,
  assertCapabilityProofV1,
  assertCriterionVerdictRefV1,
  computeCapabilityCostHash,
  computeCapabilityProofHash,
  summarizeCapabilityProofSuite,
  type CapabilityArchetypeV1,
  type CapabilityCostV1,
  type CapabilityProofV1,
  type CapabilityCriterionStatusV1,
} from '../../src/domain/capabilityProof.js';

// A valid sha256:<64hex> digest, distinct per seed (values are irrelevant to
// record validation — only the format and the sealed own-hash are checked).
const hash = (seed: number): string =>
  `sha256:${seed.toString(16).padStart(64, '0')}`;

const CANONICAL_NOW = '2026-09-01T00:00:00.000Z';

function validCost(
  over: Partial<Omit<CapabilityCostV1, 'costHash'>> = {},
): CapabilityCostV1 {
  const base = {
    inputTokens: 100,
    outputTokens: 50,
    wallClockMillis: 1_000,
    provenance: 'fixture_declared' as const,
    ...over,
  };
  return { ...base, costHash: computeCapabilityCostHash(base) };
}

function proofWithoutHash(
  over: Partial<Omit<CapabilityProofV1, 'proofHash'>> = {},
): Omit<CapabilityProofV1, 'proofHash'> {
  return {
    schema: 'hercules-capability-proof/v1',
    archetype: 'code',
    taskContractHash: hash(1),
    evidenceManifestId: 'manifest-1',
    evidenceManifestHash: hash(2),
    reviewProjectionHash: hash(3),
    browserEvidenceRef: null,
    evaluationReceiptHash: hash(4),
    criterionVerdicts: [
      { criterionId: 'criterion-1', status: 'pass', evidenceRefs: ['artifact-1'] },
    ],
    repairExercised: false,
    routingDecisionHash: null,
    routedEvaluationReceiptHash: null,
    workerJobSpecHash: hash(5),
    workerResultAdmissionHash: hash(6),
    controlCreateVerdictHash: hash(7),
    controlDecisionVerdictHash: hash(8),
    outcomeDecision: 'approve_outcome',
    cost: validCost(),
    operatorReview: { millis: 5_000, provenance: 'fixture_declared' },
    ...over,
  };
}

function validProof(
  over: Partial<Omit<CapabilityProofV1, 'proofHash'>> = {},
): CapabilityProofV1 {
  const withoutHash = proofWithoutHash(over);
  return { ...withoutHash, proofHash: computeCapabilityProofHash(withoutHash) };
}

function proofForArchetype(archetype: CapabilityArchetypeV1): CapabilityProofV1 {
  if (archetype === 'browser') {
    return validProof({
      archetype,
      browserEvidenceRef: { artifactRefId: 'artifact-1', sha256: hash(9) },
    });
  }
  return validProof({ archetype });
}

describe('capability proof — criterion verdict vocabulary', () => {
  it('CapabilityCriterionStatusV1 is exactly M8 CRITERION_RESULT_STATUSES (no minting)', () => {
    // Type-level: the alias is assignable both ways to CriterionResultStatus.
    const roundTrip = (value: CapabilityCriterionStatusV1): CriterionResultStatus =>
      value;
    const back = (value: CriterionResultStatus): CapabilityCriterionStatusV1 => value;
    expect(typeof roundTrip).toBe('function');
    expect(typeof back).toBe('function');

    // Runtime: every M8 status is accepted verbatim, and no other value is.
    for (const status of CRITERION_RESULT_STATUSES) {
      expect(() =>
        assertCriterionVerdictRefV1({
          criterionId: 'criterion-1',
          status,
          evidenceRefs: [],
        }),
      ).not.toThrow();
    }
    expect(CRITERION_RESULT_STATUSES).toEqual([
      'pass',
      'fail',
      'pending',
      'not_applicable',
      'insufficient_evidence',
    ]);
    for (const bogus of ['satisfied', 'not_satisfied', 'ok', '']) {
      expect(() =>
        assertCriterionVerdictRefV1({
          criterionId: 'criterion-1',
          status: bogus,
          evidenceRefs: [],
        }),
      ).toThrow(CapabilityProofError);
    }
  });
});

describe('capability proof — leaf record validators', () => {
  it('accepts a valid criterion verdict ref and rejects extras / unsorted refs', () => {
    expect(() =>
      assertCriterionVerdictRefV1({
        criterionId: 'criterion-1',
        status: 'pass',
        evidenceRefs: ['artifact-1', 'artifact-2'],
      }),
    ).not.toThrow();
    expect(() =>
      assertCriterionVerdictRefV1({
        criterionId: 'criterion-1',
        status: 'pass',
        evidenceRefs: ['artifact-2', 'artifact-1'],
      }),
    ).toThrow(CapabilityProofError);
    expect(() =>
      assertCriterionVerdictRefV1({
        criterionId: 'criterion-1',
        status: 'pass',
        evidenceRefs: [],
        extra: 1,
      }),
    ).toThrow(CapabilityProofError);
  });

  it('validates cost bounds, provenance, and the sealed cost hash', () => {
    const cost = validCost();
    expect(() => assertCapabilityCostV1(cost)).not.toThrow();
    expect(Object.isFrozen(cost)).toBe(true);
    expect(() =>
      assertCapabilityCostV1({ ...cost, wallClockMillis: MAX_PROOF_WALLCLOCK_MS + 1 }),
    ).toThrow(CapabilityProofError);
    expect(() =>
      assertCapabilityCostV1({ ...cost, inputTokens: -1 }),
    ).toThrow(CapabilityProofError);
    expect(() =>
      assertCapabilityCostV1({ ...cost, provenance: 'guessed' }),
    ).toThrow(CapabilityProofError);
    expect(() =>
      assertCapabilityCostV1({ ...cost, costHash: hash(999) }),
    ).toThrow(CapabilityProofError);
  });

  it('validates operator review bounds and browser evidence ref grammar', () => {
    expect(() =>
      assertCapabilityOperatorReviewV1({ millis: 10, provenance: 'fixture_declared' }),
    ).not.toThrow();
    expect(() =>
      assertCapabilityOperatorReviewV1({
        millis: MAX_OPERATOR_REVIEW_MS + 1,
        provenance: 'fixture_declared',
      }),
    ).toThrow(CapabilityProofError);
    expect(() =>
      assertBrowserEvidenceRefV1({ artifactRefId: 'artifact-1', sha256: hash(1) }),
    ).not.toThrow();
    expect(() =>
      assertBrowserEvidenceRefV1({ artifactRefId: 'artifact-1', sha256: 'nope' }),
    ).toThrow(CapabilityProofError);
  });
});

describe('capability proof — CapabilityProofV1 record', () => {
  it('accepts a valid proof and deep-freezes it', () => {
    const proof = validProof();
    expect(() => assertCapabilityProofV1(proof)).not.toThrow();
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.isFrozen(proof.criterionVerdicts[0])).toBe(true);
  });

  it('rejects extra keys, wrong schema, and a tampered proof hash', () => {
    expect(() =>
      assertCapabilityProofV1({ ...validProof(), extra: 1 }),
    ).toThrow(CapabilityProofError);
    expect(() =>
      assertCapabilityProofV1({ ...proofWithoutHash(), proofHash: hash(123) }),
    ).toThrow(CapabilityProofError);
  });

  it('enforces the browserEvidenceRef IFF-browser invariant', () => {
    // non-browser archetype must NOT carry a browser ref
    expect(() =>
      assertCapabilityProofV1(
        validProof({
          archetype: 'code',
          browserEvidenceRef: { artifactRefId: 'artifact-1', sha256: hash(9) },
        }),
      ),
    ).toThrow(CapabilityProofError);
    // browser archetype MUST carry a browser ref
    expect(() =>
      assertCapabilityProofV1(validProof({ archetype: 'browser', browserEvidenceRef: null })),
    ).toThrow(CapabilityProofError);
    // browser archetype with a ref is valid
    expect(() => assertCapabilityProofV1(proofForArchetype('browser'))).not.toThrow();
  });

  it('enforces the three-way repair null/non-null invariant', () => {
    // routingDecisionHash present but repairExercised false
    expect(() =>
      assertCapabilityProofV1(validProof({ routingDecisionHash: hash(11) })),
    ).toThrow(CapabilityProofError);
    // repairExercised true but hashes null
    expect(() =>
      assertCapabilityProofV1(validProof({ repairExercised: true })),
    ).toThrow(CapabilityProofError);
    // consistent repair record is valid
    expect(() =>
      assertCapabilityProofV1(
        validProof({
          repairExercised: true,
          routingDecisionHash: hash(11),
          routedEvaluationReceiptHash: hash(12),
        }),
      ),
    ).not.toThrow();
  });

  it('rejects an empty or unsorted criterionVerdicts list', () => {
    expect(() =>
      assertCapabilityProofV1(validProof({ criterionVerdicts: [] })),
    ).toThrow(CapabilityProofError);
    expect(() =>
      assertCapabilityProofV1(
        validProof({
          criterionVerdicts: [
            { criterionId: 'criterion-2', status: 'pass', evidenceRefs: [] },
            { criterionId: 'criterion-1', status: 'fail', evidenceRefs: [] },
          ],
        }),
      ),
    ).toThrow(CapabilityProofError);
  });
});

describe('capability proof — suite and summary', () => {
  const proofs = CAPABILITY_ARCHETYPES.map((archetype) =>
    proofForArchetype(archetype),
  );
  const mainSha = 'a'.repeat(40);

  it('assembles a suite of exactly one proof per archetype, sorted', () => {
    const suite = assembleCapabilityProofSuite(proofs, mainSha, CANONICAL_NOW);
    expect(() => assertCapabilityProofSuiteV1(suite)).not.toThrow();
    expect(suite.proofs.map((proof) => proof.archetype)).toEqual([
      ...CAPABILITY_ARCHETYPES,
    ]);
    expect(suite.archetypeCoverage).toEqual([...CAPABILITY_ARCHETYPES]);
    expect(Object.isFrozen(suite)).toBe(true);
    // determinism: same inputs → byte-identical suite hash
    const again = assembleCapabilityProofSuite(proofs, mainSha, CANONICAL_NOW);
    expect(again.suiteHash).toBe(suite.suiteHash);
  });

  it('rejects a suite that is not exactly one proof per archetype', () => {
    expect(() =>
      assembleCapabilityProofSuite(
        [proofForArchetype('code'), proofForArchetype('browser')],
        mainSha,
        CANONICAL_NOW,
      ),
    ).toThrow(CapabilityProofError);
    expect(() =>
      assembleCapabilityProofSuite(
        [
          proofForArchetype('code'),
          proofForArchetype('code'),
          proofForArchetype('browser'),
        ],
        mainSha,
        CANONICAL_NOW,
      ),
    ).toThrow(CapabilityProofError);
  });

  it('rejects a non-git-sha builtAgainstMainSha', () => {
    expect(() =>
      assembleCapabilityProofSuite(proofs, 'not-a-sha', CANONICAL_NOW),
    ).toThrow(CapabilityProofError);
  });

  it('summarizes a suite as a faithful pure projection', () => {
    const suite = assembleCapabilityProofSuite(proofs, mainSha, CANONICAL_NOW);
    const summary = summarizeCapabilityProofSuite(suite);
    expect(() => assertCapabilityProofSummaryV1(summary)).not.toThrow();
    expect(summary.suiteHash).toBe(suite.suiteHash);
    expect(summary.rows).toHaveLength(suite.proofs.length);
    for (let index = 0; index < suite.proofs.length; index += 1) {
      const proof = suite.proofs[index]!;
      const row = summary.rows[index]!;
      expect(row.archetype).toBe(proof.archetype);
      expect(row.outcomeDecision).toBe(proof.outcomeDecision);
      expect(row.totalCriteria).toBe(proof.criterionVerdicts.length);
      expect(row.passCriteria).toBe(
        proof.criterionVerdicts.filter((verdict) => verdict.status === 'pass').length,
      );
      expect(row.metricsProvenance).toBe(proof.cost.provenance);
      expect(row.operatorReviewMillis).toBe(proof.operatorReview.millis);
    }
    // determinism
    expect(summarizeCapabilityProofSuite(suite).summaryHash).toBe(summary.summaryHash);
  });
});

describe('capability proof — assembler input guard', () => {
  // The engine-driven happy path and the seven binding-precondition (anti-forgery)
  // tests require a real, mutually-consistent M2→M11 chain and are exercised in
  // slice 2 (the archetype harnesses that drive the real engines). Slice 1 proves
  // the assembler is total on its own input contract: a non-canonical clock or a
  // structurally-invalid inputs bundle fails closed with a typed error.
  it('rejects a non-canonical injected clock', () => {
    expect(() =>
      assembleCapabilityProof(
        {} as unknown as Parameters<typeof assembleCapabilityProof>[0],
        'not-a-timestamp',
      ),
    ).toThrow(CapabilityProofError);
  });

  it('rejects a structurally-invalid inputs bundle', () => {
    let error: unknown;
    try {
      assembleCapabilityProof(
        {} as unknown as Parameters<typeof assembleCapabilityProof>[0],
        CANONICAL_NOW,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CapabilityProofError);
    expect((error as CapabilityProofError).code).toBe('invalid_input_schema');
  });
});
