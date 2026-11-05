import { describe, expect, it } from 'vitest';
import {
  RepairRoutingError,
  assertIterationAttemptRecordV1,
  assertProposedIterationAttemptV1,
  assertQualifiedEvaluationReceiptViewV1,
  assertRoutingBudgetV1,
  assertRoutingDecisionV1,
  assertRoutingInputV1,
  computeAttemptHash,
  computeDecisionHash,
  computeFailureSignature,
  computeInputHash,
  computeRecordHash,
  computeViewHash,
  type IterationAttemptRecordV1,
  type ProposedIterationAttemptV1,
  type QualifiedEvaluationReceiptViewV1,
  type RoutingBudgetV1,
  type RoutingDecisionV1,
  type RoutingInputV1,
} from '../../src/domain/repairRouting.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const HASH_A =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_ZERO =
  'sha256:0000000000000000000000000000000000000000000000000000000000000000';

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

function attemptRecord(
  overrides: Partial<IterationAttemptRecordV1> = {},
): IterationAttemptRecordV1 {
  const { recordHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    iterationId: 'iteration-1',
    ordinal: 1,
    state: 'failed' as const,
    candidateCommit: COMMIT,
    finalVerdictId: 'verdict-1',
    failureSignature: computeFailureSignature(
      'fail',
      ['blocking_finding', 'required_criterion_failed'],
      ['finding-a'],
    ),
    nonReversibleActionTaken: false,
    supersedesIterationId: null,
    createdAt: '2026-08-29T00:00:00.000Z',
    endedAt: '2026-08-29T00:00:01.000Z',
    ...fields,
  };
  return {
    ...withoutHash,
    recordHash: overrideHash ?? computeRecordHash(withoutHash),
  };
}

function budget(overrides: Partial<RoutingBudgetV1> = {}): RoutingBudgetV1 {
  return {
    maxAttempts: 3,
    maxSameSignatureRepeats: 2,
    attemptsUsed: 1,
    costExceeded: false,
    tokensExceeded: false,
    durationExceeded: false,
    ...overrides,
  };
}

function routingInput(
  overrides: Partial<RoutingInputV1> = {},
): RoutingInputV1 {
  const { inputHash: overrideHash, ...fields } = overrides;
  const receipt = fields.receipt ?? receiptView();
  const history = fields.history ?? [
    attemptRecord({
      iterationId: receipt.iterationId,
      state:
        receipt.outcome === 'pass'
          ? 'passed'
          : receipt.outcome === 'fail'
            ? 'failed'
            : 'evaluating',
    }),
  ];
  const {
    receipt: _receipt,
    history: _history,
    budget: budgetOverride,
    ...restFields
  } = fields;
  const withoutHash: Omit<RoutingInputV1, 'inputHash'> = {
    schema: 'hercules-routing-input/v1',
    decisionRequestId: 'decision-request-1',
    taskId: receipt.taskId,
    ...restFields,
    receipt,
    history,
    budget: budgetOverride ?? budget(),
  };
  return {
    ...withoutHash,
    inputHash: overrideHash ?? computeInputHash(withoutHash),
  };
}

function proposedAttempt(
  overrides: Partial<ProposedIterationAttemptV1> = {},
): ProposedIterationAttemptV1 {
  const { attemptHash: overrideHash, ...fields } = overrides;
  const withoutHash = {
    proposedIterationId: 'iteration-2',
    ordinal: 2,
    supersedesIterationId: 'iteration-1',
    baseCandidateCommit: COMMIT,
    rationaleCode: 'verified_defect_repair',
    ...fields,
  };
  return {
    ...withoutHash,
    attemptHash: overrideHash ?? computeAttemptHash(withoutHash),
  };
}

function routingDecision(
  overrides: Partial<RoutingDecisionV1> = {},
): RoutingDecisionV1 {
  const { decisionHash: overrideHash, ...fields } = overrides;
  const route = fields.route ?? 'repair';
  const {
    route: _route,
    proposedAttempt: attemptOverride,
    escalationRequired: escalationOverride,
    failureClass: failureClassOverride,
    reasonCodes: reasonCodesOverride,
    ...restFields
  } = fields;
  const withoutHash: Omit<RoutingDecisionV1, 'decisionHash'> = {
    schema: 'hercules-routing-decision/v1',
    decisionRequestId: 'decision-request-1',
    taskId: 'task-1',
    inputHash: HASH_A,
    receiptId: 'receipt-1',
    derivedAt: '2026-08-29T00:00:02.000Z',
    ...restFields,
    failureClass: failureClassOverride ?? 'verified_defect',
    route,
    proposedAttempt:
      attemptOverride === undefined
        ? route === 'repair'
          ? proposedAttempt()
          : null
        : attemptOverride,
    reasonCodes: reasonCodesOverride ?? ['verified_defect'],
    escalationRequired: escalationOverride ?? route === 'escalate_human',
  };
  return {
    ...withoutHash,
    decisionHash: overrideHash ?? computeDecisionHash(withoutHash),
  };
}

function expectSchemaError(run: () => void): void {
  expect(run).toThrow(RepairRoutingError);
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RepairRoutingError);
    expect((error as RepairRoutingError).code).toBe('invalid_input_schema');
  }
}

describe('M9 repair-routing domain records', () => {
  it('accepts happy-path fixtures for every record with matching hashes', () => {
    const view = receiptView();
    const record = attemptRecord();
    const budgetRecord = budget();
    const input = routingInput();
    const attempt = proposedAttempt();
    const decision = routingDecision();
    const completeDecision = routingDecision({
      route: 'complete',
      failureClass: 'none',
      proposedAttempt: null,
      reasonCodes: ['all_criteria_pass'],
      escalationRequired: false,
    });
    const escalateDecision = routingDecision({
      route: 'escalate_human',
      failureClass: 'human_pending',
      proposedAttempt: null,
      reasonCodes: ['human_pending'],
      escalationRequired: true,
    });

    expect(() => assertQualifiedEvaluationReceiptViewV1(view)).not.toThrow();
    expect(() => assertIterationAttemptRecordV1(record)).not.toThrow();
    expect(() => assertRoutingBudgetV1(budgetRecord)).not.toThrow();
    expect(() => assertRoutingInputV1(input)).not.toThrow();
    expect(() => assertProposedIterationAttemptV1(attempt)).not.toThrow();
    expect(() => assertRoutingDecisionV1(decision)).not.toThrow();
    expect(() => assertRoutingDecisionV1(completeDecision)).not.toThrow();
    expect(() => assertRoutingDecisionV1(escalateDecision)).not.toThrow();

    const passInput = routingInput({
      receipt: receiptView({
        outcome: 'pass',
        recommendedNextStage: 'complete',
        outcomeReasonCodes: ['all_required_criteria_pass'],
        blockingFindingCodes: [],
      }),
    });
    expect(() => assertRoutingInputV1(passInput)).not.toThrow();

    const evidenceInput = routingInput({
      receipt: receiptView({
        outcome: 'need_more_evidence',
        recommendedNextStage: 'reverify',
        outcomeReasonCodes: ['insufficient_evidence'],
        blockingFindingCodes: [],
      }),
    });
    expect(() => assertRoutingInputV1(evidenceInput)).not.toThrow();

    const zeroBased = routingInput({
      history: [
        attemptRecord({
          iterationId: 'iteration-0',
          ordinal: 0,
          state: 'failed',
        }),
        attemptRecord({
          iterationId: 'iteration-1',
          ordinal: 1,
          state: 'failed',
          supersedesIterationId: 'iteration-0',
        }),
      ],
    });
    expect(() => assertRoutingInputV1(zeroBased)).not.toThrow();
  });

  it('hash helpers are deterministic for the same logical record', () => {
    const viewA = receiptView();
    const viewB = receiptView();
    expect(viewA.viewHash).toBe(viewB.viewHash);
    const { viewHash: _viewHash, ...viewBody } = viewA;
    expect(computeViewHash(viewBody)).toBe(viewA.viewHash);

    const recordA = attemptRecord();
    const recordB = attemptRecord();
    expect(recordA.recordHash).toBe(recordB.recordHash);
    const { recordHash: _recordHash, ...recordBody } = recordA;
    expect(computeRecordHash(recordBody)).toBe(recordA.recordHash);

    const inputA = routingInput();
    const inputB = routingInput();
    expect(inputA.inputHash).toBe(inputB.inputHash);
    const { inputHash: _inputHash, ...inputBody } = inputA;
    expect(computeInputHash(inputBody)).toBe(inputA.inputHash);

    const attemptA = proposedAttempt();
    const attemptB = proposedAttempt();
    expect(attemptA.attemptHash).toBe(attemptB.attemptHash);
    const { attemptHash: _attemptHash, ...attemptBody } = attemptA;
    expect(computeAttemptHash(attemptBody)).toBe(attemptA.attemptHash);

    const decisionA = routingDecision();
    const decisionB = routingDecision();
    expect(decisionA.decisionHash).toBe(decisionB.decisionHash);
    const { decisionHash: _decisionHash, ...decisionBody } = decisionA;
    expect(computeDecisionHash(decisionBody)).toBe(decisionA.decisionHash);

    const signatureA = computeFailureSignature(
      'fail',
      ['required_criterion_failed', 'blocking_finding'],
      ['finding-b', 'finding-a'],
    );
    const signatureB = computeFailureSignature(
      'fail',
      ['blocking_finding', 'required_criterion_failed'],
      ['finding-a', 'finding-b'],
    );
    expect(signatureA).toBe(signatureB);
  });

  it.each([
    {
      name: 'receipt view unknown field',
      run: () =>
        assertQualifiedEvaluationReceiptViewV1({
          ...receiptView(),
          extra: true,
        } as unknown as QualifiedEvaluationReceiptViewV1),
    },
    {
      name: 'receipt view missing field',
      run: () => {
        const { receiptId: _drop, ...rest } = receiptView();
        assertQualifiedEvaluationReceiptViewV1(
          rest as unknown as QualifiedEvaluationReceiptViewV1,
        );
      },
    },
    {
      name: 'receipt view wrong outcome enum',
      run: () =>
        assertQualifiedEvaluationReceiptViewV1(
          receiptView({
            outcome: 'maybe' as QualifiedEvaluationReceiptViewV1['outcome'],
          }),
        ),
    },
    {
      name: 'receipt view wrong recommendedNextStage',
      run: () =>
        assertQualifiedEvaluationReceiptViewV1(
          receiptView({
            recommendedNextStage:
              'platform_remediation' as QualifiedEvaluationReceiptViewV1['recommendedNextStage'],
          }),
        ),
    },
    {
      name: 'receipt view unsorted outcomeReasonCodes',
      run: () =>
        assertQualifiedEvaluationReceiptViewV1(
          receiptView({
            outcomeReasonCodes: [
              'required_criterion_failed',
              'blocking_finding',
            ],
          }),
        ),
    },
    {
      name: 'receipt view duplicate blockingFindingCodes',
      run: () =>
        assertQualifiedEvaluationReceiptViewV1(
          receiptView({
            blockingFindingCodes: ['finding-a', 'finding-a'],
          }),
        ),
    },
    {
      name: 'receipt view bad git sha',
      run: () =>
        assertQualifiedEvaluationReceiptViewV1(
          receiptView({ candidateCommit: 'abc123' }),
        ),
    },
    {
      name: 'receipt view uppercase git sha',
      run: () =>
        assertQualifiedEvaluationReceiptViewV1(
          receiptView({
            candidateCommit: '0123456789ABCDEF0123456789ABCDEF01234567',
          }),
        ),
    },
    {
      name: 'receipt view non-canonical timestamp',
      run: () =>
        assertQualifiedEvaluationReceiptViewV1(
          receiptView({ qualifiedAt: '2026-08-29T00:00:00Z' }),
        ),
    },
    {
      name: 'receipt view wrong viewHash',
      run: () =>
        assertQualifiedEvaluationReceiptViewV1(
          receiptView({ viewHash: HASH_ZERO }),
        ),
    },
    {
      name: 'receipt view evaluatorInfrastructureFailed mismatch',
      run: () =>
        assertQualifiedEvaluationReceiptViewV1(
          receiptView({
            outcomeReasonCodes: ['blocking_finding'],
            evaluatorInfrastructureFailed: true,
            failureSignature: computeFailureSignature(
              'fail',
              ['blocking_finding'],
              ['finding-a'],
            ),
          }),
        ),
    },
    {
      name: 'receipt view failureSignature mismatch',
      run: () =>
        assertQualifiedEvaluationReceiptViewV1(
          receiptView({ failureSignature: HASH_ZERO }),
        ),
    },
    {
      name: 'iteration attempt unknown field',
      run: () =>
        assertIterationAttemptRecordV1({
          ...attemptRecord(),
          extra: true,
        } as unknown as IterationAttemptRecordV1),
    },
    {
      name: 'iteration attempt missing field',
      run: () => {
        const { iterationId: _drop, ...rest } = attemptRecord();
        assertIterationAttemptRecordV1(
          rest as unknown as IterationAttemptRecordV1,
        );
      },
    },
    {
      name: 'iteration attempt wrong state enum',
      run: () =>
        assertIterationAttemptRecordV1(
          attemptRecord({
            state: 'running' as IterationAttemptRecordV1['state'],
          }),
        ),
    },
    {
      name: 'iteration attempt bad git sha',
      run: () =>
        assertIterationAttemptRecordV1(
          attemptRecord({ candidateCommit: 'not-a-sha' }),
        ),
    },
    {
      name: 'iteration attempt non-canonical endedAt',
      run: () =>
        assertIterationAttemptRecordV1(
          attemptRecord({ endedAt: '2026-08-29T00:00:01Z' }),
        ),
    },
    {
      name: 'iteration attempt wrong recordHash',
      run: () =>
        assertIterationAttemptRecordV1(attemptRecord({ recordHash: HASH_ZERO })),
    },
    {
      name: 'routing budget unknown field',
      run: () =>
        assertRoutingBudgetV1({
          ...budget(),
          extra: true,
        } as unknown as RoutingBudgetV1),
    },
    {
      name: 'routing budget missing field',
      run: () => {
        const { maxAttempts: _drop, ...rest } = budget();
        assertRoutingBudgetV1(rest as unknown as RoutingBudgetV1);
      },
    },
    {
      name: 'routing budget non-positive maxAttempts',
      run: () => assertRoutingBudgetV1(budget({ maxAttempts: 0 })),
    },
    {
      name: 'routing budget negative attemptsUsed',
      run: () => assertRoutingBudgetV1(budget({ attemptsUsed: -1 })),
    },
    {
      name: 'routing budget non-boolean flag',
      run: () =>
        assertRoutingBudgetV1(
          budget({ costExceeded: 'yes' as unknown as boolean }),
        ),
    },
    {
      name: 'routing input unknown field',
      run: () =>
        assertRoutingInputV1({
          ...routingInput(),
          extra: true,
        } as unknown as RoutingInputV1),
    },
    {
      name: 'routing input missing field',
      run: () => {
        const { decisionRequestId: _drop, ...rest } = routingInput();
        assertRoutingInputV1(rest as unknown as RoutingInputV1);
      },
    },
    {
      name: 'routing input wrong inputHash',
      run: () => assertRoutingInputV1(routingInput({ inputHash: HASH_ZERO })),
    },
    {
      name: 'routing input history ordinal gap',
      run: () =>
        assertRoutingInputV1(
          routingInput({
            history: [
              attemptRecord({
                iterationId: 'iteration-1',
                ordinal: 1,
                state: 'failed',
              }),
              attemptRecord({
                iterationId: 'iteration-2',
                ordinal: 3,
                state: 'failed',
              }),
            ],
          }),
        ),
    },
    {
      name: 'routing input history duplicate iteration id',
      run: () =>
        assertRoutingInputV1(
          routingInput({
            history: [
              attemptRecord({
                iterationId: 'iteration-1',
                ordinal: 1,
                state: 'failed',
              }),
              attemptRecord({
                iterationId: 'iteration-1',
                ordinal: 2,
                state: 'failed',
              }),
            ],
          }),
        ),
    },
    {
      name: 'routing input history wrong last iterationId',
      run: () =>
        assertRoutingInputV1(
          routingInput({
            receipt: receiptView({ iterationId: 'iteration-9' }),
            history: [
              attemptRecord({
                iterationId: 'iteration-1',
                ordinal: 1,
                state: 'failed',
              }),
            ],
          }),
        ),
    },
    {
      name: 'routing input history state-outcome inconsistency',
      run: () =>
        assertRoutingInputV1(
          routingInput({
            receipt: receiptView({ outcome: 'pass' }),
            history: [
              attemptRecord({
                iterationId: 'iteration-1',
                ordinal: 1,
                state: 'failed',
              }),
            ],
          }),
        ),
    },
    {
      name: 'proposed attempt unknown field',
      run: () =>
        assertProposedIterationAttemptV1({
          ...proposedAttempt(),
          extra: true,
        } as unknown as ProposedIterationAttemptV1),
    },
    {
      name: 'proposed attempt missing field',
      run: () => {
        const { proposedIterationId: _drop, ...rest } = proposedAttempt();
        assertProposedIterationAttemptV1(
          rest as unknown as ProposedIterationAttemptV1,
        );
      },
    },
    {
      name: 'proposed attempt bad git sha',
      run: () =>
        assertProposedIterationAttemptV1(
          proposedAttempt({ baseCandidateCommit: 'ABC' }),
        ),
    },
    {
      name: 'proposed attempt wrong attemptHash',
      run: () =>
        assertProposedIterationAttemptV1(
          proposedAttempt({ attemptHash: HASH_ZERO }),
        ),
    },
    {
      name: 'routing decision unknown field',
      run: () =>
        assertRoutingDecisionV1({
          ...routingDecision(),
          extra: true,
        } as unknown as RoutingDecisionV1),
    },
    {
      name: 'routing decision missing field',
      run: () => {
        const { decisionRequestId: _drop, ...rest } = routingDecision();
        assertRoutingDecisionV1(rest as unknown as RoutingDecisionV1);
      },
    },
    {
      name: 'routing decision wrong failureClass',
      run: () =>
        assertRoutingDecisionV1(
          routingDecision({
            failureClass: 'other' as RoutingDecisionV1['failureClass'],
          }),
        ),
    },
    {
      name: 'routing decision wrong route',
      run: () =>
        assertRoutingDecisionV1(
          routingDecision({
            route: 'merge' as RoutingDecisionV1['route'],
            proposedAttempt: null,
            escalationRequired: false,
          }),
        ),
    },
    {
      name: 'routing decision unsorted reasonCodes',
      run: () =>
        assertRoutingDecisionV1(
          routingDecision({
            reasonCodes: ['zulu', 'alpha'],
          }),
        ),
    },
    {
      name: 'routing decision empty reasonCodes',
      run: () =>
        assertRoutingDecisionV1(routingDecision({ reasonCodes: [] })),
    },
    {
      name: 'routing decision duplicate reasonCodes',
      run: () =>
        assertRoutingDecisionV1(
          routingDecision({
            reasonCodes: ['verified_defect', 'verified_defect'],
          }),
        ),
    },
    {
      name: 'routing decision non-canonical derivedAt',
      run: () =>
        assertRoutingDecisionV1(
          routingDecision({ derivedAt: '2026-08-29T00:00:02Z' }),
        ),
    },
    {
      name: 'routing decision wrong decisionHash',
      run: () =>
        assertRoutingDecisionV1(routingDecision({ decisionHash: HASH_ZERO })),
    },
    {
      name: 'routing decision escalationRequired false on escalate_human',
      run: () =>
        assertRoutingDecisionV1(
          routingDecision({
            route: 'escalate_human',
            proposedAttempt: null,
            reasonCodes: ['human_pending'],
            escalationRequired: false,
          }),
        ),
    },
    {
      name: 'routing decision escalationRequired true on repair',
      run: () =>
        assertRoutingDecisionV1(
          routingDecision({
            route: 'repair',
            escalationRequired: true,
          }),
        ),
    },
    {
      name: 'routing decision proposedAttempt present on non-repair',
      run: () =>
        assertRoutingDecisionV1(
          routingDecision({
            route: 'reverify',
            failureClass: 'evidence_gap',
            proposedAttempt: proposedAttempt(),
            reasonCodes: ['evidence_gap'],
            escalationRequired: false,
          }),
        ),
    },
    {
      name: 'routing decision proposedAttempt null on repair',
      run: () =>
        assertRoutingDecisionV1(
          routingDecision({
            route: 'repair',
            proposedAttempt: null,
            reasonCodes: ['verified_defect'],
            escalationRequired: false,
          }),
        ),
    },
  ])('rejects $name', ({ run }) => {
    expectSchemaError(run);
  });
});
