import { describe, expect, it } from 'vitest';
import {
  computeFailureSignature,
  computeViewHash,
  type FailureClassV1,
  type QualifiedEvaluationReceiptViewV1,
} from '../../src/domain/repairRouting.js';
import { classifyFailure } from '../../src/routing/failureTaxonomy.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const HASH_A =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function receiptView(
  overrides: Partial<QualifiedEvaluationReceiptViewV1> = {},
): QualifiedEvaluationReceiptViewV1 {
  const { viewHash: overrideHash, ...fields } = overrides;
  const outcome = fields.outcome ?? 'fail';
  const outcomeReasonCodes = fields.outcomeReasonCodes ?? [
    'blocking_finding',
    'required_criterion_failed',
  ];
  const blockingFindingCodes = fields.blockingFindingCodes ?? ['finding-a'];
  const {
    outcome: _outcome,
    outcomeReasonCodes: _outcomeReasonCodes,
    blockingFindingCodes: _blockingFindingCodes,
    evaluatorInfrastructureFailed: infraOverride,
    failureSignature: signatureOverride,
    ...restFields
  } = fields;
  const withoutHash: Omit<QualifiedEvaluationReceiptViewV1, 'viewHash'> = {
    schema: 'hercules-qualified-evaluation-receipt-view/v1',
    receiptId: 'receipt-1',
    requestId: 'request-1',
    taskId: 'task-1',
    taskContractHash: HASH_A,
    iterationId: 'iteration-1',
    candidateCommit: COMMIT,
    recommendedNextStage: 'repair',
    requiredHumanCriterionPending: false,
    qualifiedAt: '2026-08-29T00:00:00.000Z',
    ...restFields,
    outcome,
    outcomeReasonCodes,
    blockingFindingCodes,
    evaluatorInfrastructureFailed:
      infraOverride ??
      outcomeReasonCodes.some(
        (code) =>
          code === 'evaluator_contract_violation' ||
          code === 'evaluator_unavailable',
      ),
    failureSignature:
      signatureOverride ??
      computeFailureSignature(outcome, outcomeReasonCodes, blockingFindingCodes),
  };
  return {
    ...withoutHash,
    viewHash: overrideHash ?? computeViewHash(withoutHash),
  };
}

describe('M9 failure taxonomy', () => {
  it.each([
    {
      name: 'pass → none',
      view: receiptView({
        outcome: 'pass',
        recommendedNextStage: 'complete',
        outcomeReasonCodes: ['all_required_criteria_pass'],
        blockingFindingCodes: [],
      }),
      expected: 'none' satisfies FailureClassV1,
    },
    {
      name: 'evaluatorInfrastructureFailed flag → infrastructure_failure',
      view: receiptView({
        outcome: 'fail',
        recommendedNextStage: 'escalate_human',
        outcomeReasonCodes: ['evaluator_unavailable'],
        blockingFindingCodes: [],
        evaluatorInfrastructureFailed: true,
      }),
      expected: 'infrastructure_failure',
    },
    {
      name: 'infra codes without relying on other flags → infrastructure_failure',
      view: receiptView({
        outcome: 'need_more_evidence',
        recommendedNextStage: 'reverify',
        outcomeReasonCodes: ['evaluator_contract_violation'],
        blockingFindingCodes: [],
        evaluatorInfrastructureFailed: true,
      }),
      expected: 'infrastructure_failure',
    },
    {
      name: 'requiredHumanCriterionPending → human_pending',
      view: receiptView({
        outcome: 'fail',
        recommendedNextStage: 'escalate_human',
        outcomeReasonCodes: ['human_criterion_pending'],
        blockingFindingCodes: [],
        requiredHumanCriterionPending: true,
      }),
      expected: 'human_pending',
    },
    {
      name: 'need_more_evidence → evidence_gap',
      view: receiptView({
        outcome: 'need_more_evidence',
        recommendedNextStage: 'reverify',
        outcomeReasonCodes: ['insufficient_evidence'],
        blockingFindingCodes: [],
      }),
      expected: 'evidence_gap',
    },
    {
      name: 'fail with verified-defect codes → verified_defect',
      view: receiptView({
        outcome: 'fail',
        recommendedNextStage: 'repair',
        outcomeReasonCodes: [
          'blocking_finding',
          'deterministic_gate_failed',
          'required_criterion_failed',
        ],
        blockingFindingCodes: ['finding-a'],
      }),
      expected: 'verified_defect',
    },
    {
      name: 'fail with novel code → unrecognized_failure',
      view: receiptView({
        outcome: 'fail',
        recommendedNextStage: 'escalate_human',
        outcomeReasonCodes: ['novel_unknown_code'],
        blockingFindingCodes: [],
      }),
      expected: 'unrecognized_failure',
    },
    {
      name: 'fail with empty codes → unrecognized_failure',
      view: receiptView({
        outcome: 'fail',
        recommendedNextStage: 'escalate_human',
        outcomeReasonCodes: [],
        blockingFindingCodes: [],
      }),
      expected: 'unrecognized_failure',
    },
  ])('$name', ({ view, expected }) => {
    expect(classifyFailure(view)).toBe(expected);
  });

  it('first-match: fail + human_pending → human_pending (before verified_defect)', () => {
    const view = receiptView({
      outcome: 'fail',
      recommendedNextStage: 'escalate_human',
      outcomeReasonCodes: ['blocking_finding', 'required_criterion_failed'],
      blockingFindingCodes: ['finding-a'],
      requiredHumanCriterionPending: true,
    });
    expect(classifyFailure(view)).toBe('human_pending');
  });

  it('first-match: need_more_evidence + infra codes → infrastructure_failure', () => {
    const view = receiptView({
      outcome: 'need_more_evidence',
      recommendedNextStage: 'reverify',
      outcomeReasonCodes: ['evaluator_unavailable', 'insufficient_evidence'],
      blockingFindingCodes: [],
      evaluatorInfrastructureFailed: true,
    });
    expect(classifyFailure(view)).toBe('infrastructure_failure');
  });

  it('first-match: pass beats every other flag', () => {
    const view = receiptView({
      outcome: 'pass',
      recommendedNextStage: 'complete',
      outcomeReasonCodes: ['all_required_criteria_pass'],
      blockingFindingCodes: [],
      requiredHumanCriterionPending: true,
      evaluatorInfrastructureFailed: false,
    });
    expect(classifyFailure(view)).toBe('none');
  });

  it('never throws on any closed view shape', () => {
    const views = [
      receiptView({
        outcome: 'pass',
        recommendedNextStage: 'complete',
        outcomeReasonCodes: ['all_required_criteria_pass'],
        blockingFindingCodes: [],
      }),
      receiptView(),
      receiptView({
        outcome: 'need_more_evidence',
        recommendedNextStage: 'reverify',
        outcomeReasonCodes: ['insufficient_evidence'],
        blockingFindingCodes: [],
      }),
      receiptView({
        outcome: 'fail',
        outcomeReasonCodes: [],
        blockingFindingCodes: [],
      }),
    ];
    for (const view of views) {
      expect(() => classifyFailure(view)).not.toThrow();
    }
  });
});
