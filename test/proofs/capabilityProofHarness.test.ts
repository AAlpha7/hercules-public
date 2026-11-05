/**
 * M12 slice 2 — engine-driven archetype harnesses, determinism, anti-forgery.
 */

import { describe, expect, it } from 'vitest';
import { canonicalSerialize } from '../../src/domain/canonicalJson.js';
import {
  CapabilityProofError,
  assembleCapabilityProof,
  assertCapabilityProofV1,
  type AssembleCapabilityProofInputsV1,
} from '../../src/domain/capabilityProof.js';
import {
  computeEvaluationReceiptHash,
  computeVerdictHash,
  type IndependentEvaluationReceiptV1,
} from '../../src/domain/independentEvaluation.js';
import type { EvaluationVerdict } from '../../src/domain/evaluationVerdict.js';
import { computeJobSpecHash } from '../../src/domain/workerBoundary.js';
import {
  buildBoundedNonCodeCapabilityProof,
  buildBoundedNonCodeCapabilityProofInputs,
} from '../../src/proofs/archetypes/boundedNonCode.js';
import {
  buildCodeCapabilityProof,
  buildCodeCapabilityProofInputs,
} from '../../src/proofs/archetypes/code.js';

const NOW = '2026-09-01T00:00:00.000Z';
const NOW_AGAIN = '2026-09-01T00:00:00.000Z';
const FOREIGN_HASH =
  'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

function expectProofError(
  run: () => unknown,
  code: CapabilityProofError['code'],
): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CapabilityProofError);
  expect((caught as CapabilityProofError).code).toBe(code);
}

function rehashReceipt(
  receipt: IndependentEvaluationReceiptV1,
  mutate: (
    draft: Omit<IndependentEvaluationReceiptV1, 'receiptHash'>,
  ) => Omit<IndependentEvaluationReceiptV1, 'receiptHash'>,
): IndependentEvaluationReceiptV1 {
  const { receiptHash: _drop, ...rest } = receipt;
  const withoutHash = mutate(rest);
  return {
    ...withoutHash,
    receiptHash: computeEvaluationReceiptHash(withoutHash),
  };
}

/**
 * Mutate the receipt's verdict and re-seal BOTH the verdictHash and the
 * receiptHash so the receipt stays internally valid (passes
 * assertIndependentEvaluationReceiptV1) — the cross-layer binding is what the
 * assembler must reject.
 */
function rehashReceiptDeep(
  receipt: IndependentEvaluationReceiptV1,
  mutateVerdict: (verdict: EvaluationVerdict) => EvaluationVerdict,
): IndependentEvaluationReceiptV1 {
  const newVerdict = mutateVerdict(receipt.verdict);
  const { receiptHash: _drop, ...rest } = receipt;
  const withoutHash = {
    ...rest,
    verdict: newVerdict,
    verdictHash: computeVerdictHash(newVerdict),
  };
  return {
    ...withoutHash,
    receiptHash: computeEvaluationReceiptHash(withoutHash),
  };
}

describe('M12 proofs — engine-driven archetype chains', () => {
  it('code archetype: real engines + repair loop → valid CapabilityProofV1', () => {
    const inputs = buildCodeCapabilityProofInputs(NOW);
    expect(inputs.archetype).toBe('code');
    expect(inputs.browserEvidenceRef).toBeNull();
    expect(inputs.routingDecision).not.toBeNull();
    expect(inputs.routedEvaluationReceipt).not.toBeNull();
    expect(inputs.routingDecision?.route).toBe('repair');
    expect(inputs.routingDecision?.receiptId).toBe(
      inputs.routedEvaluationReceipt?.receiptId,
    );
    expect(inputs.routingDecision?.taskId).toBe(
      inputs.routedEvaluationReceipt?.taskId,
    );
    expect(inputs.routedEvaluationReceipt?.taskId).toBe(
      inputs.evaluationReceipt.taskId,
    );
    expect(inputs.routedEvaluationReceipt?.iterationId).not.toBe(
      inputs.evaluationReceipt.iterationId,
    );
    expect(inputs.evaluationReceipt.verdict.outcome).toBe('pass');
    expect(inputs.routedEvaluationReceipt?.verdict.outcome).toBe('fail');
    expect(inputs.reviewPackage.schema).toBe('hercules-review-package/v2');
    expect(inputs.resultAdmission.outcome).toBe('admitted');
    expect(inputs.controlCreateVerdict.schema).toBe(
      'hercules-control-api-admit-verdict/v2',
    );
    expect(inputs.controlDecisionVerdict.schema).toBe(
      'hercules-control-api-admit-verdict/v2',
    );

    const proof = assembleCapabilityProof(inputs, NOW);
    expect(() => assertCapabilityProofV1(proof)).not.toThrow();
    expect(proof.archetype).toBe('code');
    expect(proof.repairExercised).toBe(true);
    expect(proof.routingDecisionHash).not.toBeNull();
    expect(proof.routedEvaluationReceiptHash).not.toBeNull();
    expect(proof.browserEvidenceRef).toBeNull();
    expect(proof.outcomeDecision).toBe('approve_outcome');
    expect(proof.criterionVerdicts.some((v) => v.status === 'pass')).toBe(true);
  });

  it('bounded-non-code archetype: real engines, no repair → valid proof', () => {
    const inputs = buildBoundedNonCodeCapabilityProofInputs(NOW);
    expect(inputs.archetype).toBe('bounded_non_code');
    expect(inputs.browserEvidenceRef).toBeNull();
    expect(inputs.routingDecision).toBeNull();
    expect(inputs.routedEvaluationReceipt).toBeNull();
    expect(inputs.contract.taskId).toBe('task-2');
    expect(inputs.contract.taskId).not.toBe(
      buildCodeCapabilityProofInputs(NOW).contract.taskId,
    );

    const proof = assembleCapabilityProof(inputs, NOW);
    expect(() => assertCapabilityProofV1(proof)).not.toThrow();
    expect(proof.archetype).toBe('bounded_non_code');
    expect(proof.repairExercised).toBe(false);
    expect(proof.routingDecisionHash).toBeNull();
    expect(proof.routedEvaluationReceiptHash).toBeNull();
    expect(proof.browserEvidenceRef).toBeNull();
  });

});

describe('M12 proofs — determinism', () => {
  it('same seed + injected now → byte-identical code proof', () => {
    const a = buildCodeCapabilityProof(NOW);
    const b = buildCodeCapabilityProof(NOW_AGAIN);
    expect(canonicalSerialize(a)).toBe(canonicalSerialize(b));
    expect(a.proofHash).toBe(b.proofHash);
  });

  it('same seed + injected now → byte-identical bounded-non-code proof', () => {
    const a = buildBoundedNonCodeCapabilityProof(NOW);
    const b = buildBoundedNonCodeCapabilityProof(NOW_AGAIN);
    expect(canonicalSerialize(a)).toBe(canonicalSerialize(b));
    expect(a.proofHash).toBe(b.proofHash);
  });
});

describe('M12 proofs — anti-forgery', () => {
  it('foreign-task R1 → repair_binding_mismatch', () => {
    const inputs = buildCodeCapabilityProofInputs(NOW);
    const foreignR1 = rehashReceipt(inputs.routedEvaluationReceipt!, (draft) => ({
      ...draft,
      taskId: 'task-foreign',
    }));
    const forged: AssembleCapabilityProofInputsV1 = {
      ...inputs,
      routedEvaluationReceipt: foreignR1,
    };
    expectProofError(
      () => assembleCapabilityProof(forged, NOW),
      'repair_binding_mismatch',
    );
  });

  it('job spec with foreign contract hash → inconsistent_contract_binding', () => {
    const inputs = buildCodeCapabilityProofInputs(NOW);
    const { jobSpecHash: _drop, ...rest } = inputs.jobSpec;
    const withoutHash = {
      ...rest,
      taskContractHash: FOREIGN_HASH,
    };
    const forged: AssembleCapabilityProofInputsV1 = {
      ...inputs,
      jobSpec: {
        ...withoutHash,
        jobSpecHash: computeJobSpecHash(withoutHash),
      },
    };
    expectProofError(
      () => assembleCapabilityProof(forged, NOW),
      'inconsistent_contract_binding',
    );
  });

  it('decision verdict not binding its request → outcome_binding_mismatch', () => {
    const inputs = buildCodeCapabilityProofInputs(NOW);
    // Swap in the create verdict (valid seal, wrong requestHash binding).
    const forged: AssembleCapabilityProofInputsV1 = {
      ...inputs,
      controlDecisionVerdict: inputs.controlCreateVerdict,
    };
    expectProofError(
      () => assembleCapabilityProof(forged, NOW),
      'outcome_binding_mismatch',
    );
  });

  it('M8 verdict over a foreign criterion → criterion_coverage_mismatch', () => {
    const inputs = buildCodeCapabilityProofInputs(NOW);
    const forgedReceipt = rehashReceiptDeep(inputs.evaluationReceipt, (verdict) => ({
      ...verdict,
      criterionResults: verdict.criterionResults.map((result) => ({
        ...result,
        criterionId: 'criterion-foreign',
      })),
    }));
    expectProofError(
      () =>
        assembleCapabilityProof(
          { ...inputs, evaluationReceipt: forgedReceipt },
          NOW,
        ),
      'criterion_coverage_mismatch',
    );
  });

  it('M8 verdict citing evidence absent from the manifest → dangling_evidence_ref', () => {
    const inputs = buildCodeCapabilityProofInputs(NOW);
    const forgedReceipt = rehashReceiptDeep(inputs.evaluationReceipt, (verdict) => ({
      ...verdict,
      criterionResults: verdict.criterionResults.map((result) => ({
        ...result,
        evidenceRefs: ['artifact-nonexistent'],
      })),
    }));
    expectProofError(
      () =>
        assembleCapabilityProof(
          { ...inputs, evaluationReceipt: forgedReceipt },
          NOW,
        ),
      'dangling_evidence_ref',
    );
  });

  it('browser evidence ref on a non-browser archetype → archetype_evidence_mismatch', () => {
    const inputs = buildCodeCapabilityProofInputs(NOW);
    const forged: AssembleCapabilityProofInputsV1 = {
      ...inputs,
      browserEvidenceRef: { artifactRefId: 'artifact-1', sha256: FOREIGN_HASH },
    };
    expectProofError(
      () => assembleCapabilityProof(forged, NOW),
      'archetype_evidence_mismatch',
    );
  });
});
