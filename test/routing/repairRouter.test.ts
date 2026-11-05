import { describe, expect, it } from 'vitest';
import {
  computeAttemptHash,
  computeFailureSignature,
  computeInputHash,
  computeRecordHash,
  computeViewHash,
  type IterationAttemptRecordV1,
  type QualifiedEvaluationReceiptViewV1,
  type RoutingBudgetV1,
  type RoutingDecisionV1,
  type RoutingInputV1,
} from '../../src/domain/repairRouting.js';
import {
  createRepairRouter,
  type TrustedRoutingReceiptReconfirmationV1,
} from '../../src/routing/repairRouter.js';

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
      failureSignature: receipt.failureSignature,
      state:
        receipt.outcome === 'pass'
          ? 'passed'
          : receipt.outcome === 'fail'
            ? 'failed'
            : 'evaluating',
      endedAt: receipt.outcome === 'need_more_evidence' ? null : '2026-08-29T00:00:01.000Z',
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

function identityReconfirm(): TrustedRoutingReceiptReconfirmationV1 {
  return {
    reconfirm(view) {
      return view;
    },
  };
}

function nullReconfirm(): TrustedRoutingReceiptReconfirmationV1 {
  return {
    reconfirm() {
      return null;
    },
  };
}

function mutatedReconfirm(): TrustedRoutingReceiptReconfirmationV1 {
  return {
    reconfirm(view) {
      const { viewHash: _drop, receiptId: _id, ...rest } = view;
      const mutated: Omit<QualifiedEvaluationReceiptViewV1, 'viewHash'> = {
        ...rest,
        receiptId: 'receipt-mutated',
      };
      return {
        ...mutated,
        viewHash: computeViewHash(mutated),
      };
    },
  };
}

function expectDecision(
  outcome: ReturnType<ReturnType<typeof createRepairRouter>['route']>,
): RoutingDecisionV1 {
  expect(outcome.kind).toBe('decision');
  if (outcome.kind !== 'decision') {
    throw new Error('expected decision');
  }
  return outcome.decision;
}

describe('M9 repair router', () => {
  it('pass → complete even at maxAttempts (success short-circuit precedes budget)', () => {
    const router = createRepairRouter(identityReconfirm());
    const input = routingInput({
      receipt: receiptView({
        outcome: 'pass',
        recommendedNextStage: 'complete',
        outcomeReasonCodes: ['all_required_criteria_pass'],
        blockingFindingCodes: [],
      }),
      budget: budget({ attemptsUsed: 99, maxAttempts: 3 }),
    });
    const decision = expectDecision(router.route(input));
    expect(decision.route).toBe('complete');
    expect(decision.failureClass).toBe('none');
    expect(decision.proposedAttempt).toBeNull();
    expect(decision.reasonCodes).toEqual(['all_criteria_pass']);
    expect(decision.escalationRequired).toBe(false);
    expect(router.isTrustedDecision(decision)).toBe(true);
  });

  it('verified_defect → repair with a proposed superseding attempt', () => {
    const router = createRepairRouter(identityReconfirm());
    const input = routingInput();
    const decision = expectDecision(router.route(input));
    expect(decision.route).toBe('repair');
    expect(decision.failureClass).toBe('verified_defect');
    expect(decision.escalationRequired).toBe(false);
    expect(decision.proposedAttempt).not.toBeNull();
    const attempt = decision.proposedAttempt!;
    expect(attempt.ordinal).toBe(2);
    expect(attempt.supersedesIterationId).toBe('iteration-1');
    expect(attempt.baseCandidateCommit).toBe(COMMIT);
    expect(attempt.rationaleCode).toBe('verified_defect_repair');
    const { attemptHash: _hash, ...body } = attempt;
    expect(attempt.attemptHash).toBe(computeAttemptHash(body));
    expect(decision.reasonCodes).toEqual(['verified_defect']);
  });

  it('verified_defect at maxAttempts → escalate_human (budget)', () => {
    const router = createRepairRouter(identityReconfirm());
    const input = routingInput({
      budget: budget({ attemptsUsed: 3, maxAttempts: 3 }),
    });
    const decision = expectDecision(router.route(input));
    expect(decision.route).toBe('escalate_human');
    expect(decision.failureClass).toBe('verified_defect');
    expect(decision.proposedAttempt).toBeNull();
    expect(decision.reasonCodes).toEqual(['budget_or_convergence']);
    expect(decision.escalationRequired).toBe(true);
  });

  it('verified_defect over a non-reversible superseded iteration → escalate', () => {
    const router = createRepairRouter(identityReconfirm());
    // Distinct prior signature so the convergence repeat cap does not fire first.
    const priorSignature = computeFailureSignature(
      'fail',
      ['deterministic_gate_failed'],
      ['finding-prior'],
    );
    const prior = attemptRecord({
      iterationId: 'iteration-0',
      ordinal: 0,
      state: 'failed',
      failureSignature: priorSignature,
      nonReversibleActionTaken: true,
      endedAt: '2026-08-29T00:00:00.500Z',
    });
    const current = attemptRecord({
      iterationId: 'iteration-1',
      ordinal: 1,
      supersedesIterationId: 'iteration-0',
      nonReversibleActionTaken: false,
    });
    const input = routingInput({
      history: [prior, current],
      budget: budget({
        attemptsUsed: 1,
        maxAttempts: 5,
        maxSameSignatureRepeats: 3,
      }),
    });
    const decision = expectDecision(router.route(input));
    expect(decision.route).toBe('escalate_human');
    expect(decision.reasonCodes).toEqual(['non_reversible_action']);
    expect(decision.proposedAttempt).toBeNull();
  });

  it('evidence_gap → reverify', () => {
    const router = createRepairRouter(identityReconfirm());
    const input = routingInput({
      receipt: receiptView({
        outcome: 'need_more_evidence',
        recommendedNextStage: 'reverify',
        outcomeReasonCodes: ['insufficient_evidence'],
        blockingFindingCodes: [],
      }),
    });
    const decision = expectDecision(router.route(input));
    expect(decision.route).toBe('reverify');
    expect(decision.failureClass).toBe('evidence_gap');
    expect(decision.proposedAttempt).toBeNull();
    expect(decision.reasonCodes).toEqual(['evidence_gap']);
  });

  it('infrastructure_failure → platform_remediation', () => {
    const router = createRepairRouter(identityReconfirm());
    const input = routingInput({
      receipt: receiptView({
        outcome: 'fail',
        recommendedNextStage: 'escalate_human',
        outcomeReasonCodes: ['evaluator_unavailable'],
        blockingFindingCodes: [],
        evaluatorInfrastructureFailed: true,
      }),
    });
    const decision = expectDecision(router.route(input));
    expect(decision.route).toBe('platform_remediation');
    expect(decision.failureClass).toBe('infrastructure_failure');
    expect(decision.proposedAttempt).toBeNull();
    expect(decision.reasonCodes).toEqual(['infrastructure_failure']);
  });

  it('human_pending → escalate_human', () => {
    const router = createRepairRouter(identityReconfirm());
    const input = routingInput({
      receipt: receiptView({
        outcome: 'fail',
        recommendedNextStage: 'escalate_human',
        outcomeReasonCodes: ['human_criterion_pending'],
        blockingFindingCodes: [],
        requiredHumanCriterionPending: true,
      }),
    });
    const decision = expectDecision(router.route(input));
    expect(decision.route).toBe('escalate_human');
    expect(decision.failureClass).toBe('human_pending');
    expect(decision.reasonCodes).toEqual(['human_pending']);
    expect(decision.escalationRequired).toBe(true);
  });

  it('unrecognized_failure → escalate_human', () => {
    const router = createRepairRouter(identityReconfirm());
    const input = routingInput({
      receipt: receiptView({
        outcome: 'fail',
        recommendedNextStage: 'escalate_human',
        outcomeReasonCodes: ['novel_unknown_code'],
        blockingFindingCodes: [],
      }),
    });
    const decision = expectDecision(router.route(input));
    expect(decision.route).toBe('escalate_human');
    expect(decision.failureClass).toBe('unrecognized_failure');
    expect(decision.reasonCodes).toEqual(['unrecognized_failure']);
  });

  it('reconfirm() null → gap untrusted_receipt', () => {
    const router = createRepairRouter(nullReconfirm());
    const outcome = router.route(routingInput());
    expect(outcome).toEqual({
      kind: 'gap',
      code: 'untrusted_receipt',
      detail: 'receipt brand could not be reconfirmed',
    });
  });

  it('reconfirm() projection that byte-differs → gap untrusted_receipt', () => {
    const router = createRepairRouter(mutatedReconfirm());
    const outcome = router.route(routingInput());
    expect(outcome.kind).toBe('gap');
    if (outcome.kind !== 'gap') {
      throw new Error('expected gap');
    }
    expect(outcome.code).toBe('untrusted_receipt');
  });

  it('idempotency: same key + same input → identical frozen decision (toBe)', () => {
    const router = createRepairRouter(identityReconfirm());
    const input = routingInput();
    const first = expectDecision(router.route(input));
    const second = expectDecision(router.route(input));
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('idempotency: same decisionRequestId with changed input → conflict', () => {
    const router = createRepairRouter(identityReconfirm());
    const firstInput = routingInput();
    expectDecision(router.route(firstInput));

    const secondInput = routingInput({
      receipt: receiptView({
        outcome: 'fail',
        recommendedNextStage: 'escalate_human',
        outcomeReasonCodes: ['novel_unknown_code'],
        blockingFindingCodes: [],
      }),
    });
    expect(secondInput.decisionRequestId).toBe(firstInput.decisionRequestId);
    expect(secondInput.inputHash).not.toBe(firstInput.inputHash);
    const outcome = router.route(secondInput);
    expect(outcome.kind).toBe('conflict');
    if (outcome.kind !== 'conflict') {
      throw new Error('expected conflict');
    }
    expect(outcome.code).toBe('idempotency_conflict');
  });

  it('brand: JSON-cloned decision is not trusted', () => {
    const router = createRepairRouter(identityReconfirm());
    const decision = expectDecision(router.route(routingInput()));
    expect(router.isTrustedDecision(decision)).toBe(true);
    const cloned = JSON.parse(JSON.stringify(decision)) as RoutingDecisionV1;
    expect(router.isTrustedDecision(cloned)).toBe(false);
  });

  it('derivation fields are input-determined across router instances (derivedAt aside)', () => {
    const routerA = createRepairRouter(identityReconfirm());
    const routerB = createRepairRouter(identityReconfirm());
    const input = routingInput();
    const a = expectDecision(routerA.route(input));
    const b = expectDecision(routerB.route(input));
    expect(a.route).toBe(b.route);
    expect(a.failureClass).toBe(b.failureClass);
    expect(a.reasonCodes).toEqual(b.reasonCodes);
    expect(a.proposedAttempt?.ordinal).toBe(b.proposedAttempt?.ordinal);
    expect(a.proposedAttempt?.supersedesIterationId).toBe(
      b.proposedAttempt?.supersedesIterationId,
    );
    expect(a.proposedAttempt?.attemptHash).toBe(b.proposedAttempt?.attemptHash);
  });

  it('a fixed injected clock makes decisionHash byte-reproducible across instances', () => {
    const clock = { nowUtc: () => '2026-08-31T00:00:00.000Z' };
    const routerA = createRepairRouter(identityReconfirm(), { clock });
    const routerB = createRepairRouter(identityReconfirm(), { clock });
    const input = routingInput();
    const a = expectDecision(routerA.route(input));
    const b = expectDecision(routerB.route(input));
    expect(a.derivedAt).toBe('2026-08-31T00:00:00.000Z');
    expect(a.decisionHash).toBe(b.decisionHash);
  });

  it('invalid input schema → gap (never throws)', () => {
    const router = createRepairRouter(identityReconfirm());
    const bad = {
      ...routingInput(),
      schema: 'wrong',
    } as unknown as RoutingInputV1;
    const outcome = router.route(bad);
    expect(outcome.kind).toBe('gap');
    if (outcome.kind !== 'gap') {
      throw new Error('expected gap');
    }
    expect(outcome.code).toBe('invalid_input_schema');
  });

  it('capacity exhaustion → gap capacity', () => {
    const router = createRepairRouter(identityReconfirm(), {
      maxReservations: 1,
    });
    expectDecision(
      router.route(
        routingInput({ decisionRequestId: 'decision-request-a' }),
      ),
    );
    const outcome = router.route(
      routingInput({ decisionRequestId: 'decision-request-b' }),
    );
    expect(outcome).toEqual({
      kind: 'gap',
      code: 'capacity',
      detail: 'router reservation table is full at 1',
    });
  });

  it('route() never throws across happy and failure paths', () => {
    const cases: Array<{
      reconfirm: TrustedRoutingReceiptReconfirmationV1;
      input: RoutingInputV1;
    }> = [
      { reconfirm: identityReconfirm(), input: routingInput() },
      { reconfirm: nullReconfirm(), input: routingInput() },
      { reconfirm: mutatedReconfirm(), input: routingInput() },
      {
        reconfirm: identityReconfirm(),
        input: routingInput({
          receipt: receiptView({
            outcome: 'pass',
            recommendedNextStage: 'complete',
            outcomeReasonCodes: ['all_required_criteria_pass'],
            blockingFindingCodes: [],
          }),
        }),
      },
    ];
    for (const entry of cases) {
      const router = createRepairRouter(entry.reconfirm);
      expect(() => router.route(entry.input)).not.toThrow();
    }
  });
});
