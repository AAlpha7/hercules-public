/**
 * M8 evaluator port: sanitized request derivation and bounded deadline race.
 *
 * May import only from `src/domain/`. No Node builtins, no timers, no clock
 * reads — bounded waiting comes only from the injected deadline port.
 */

import type { DecisionAssertion } from '../domain/claimAuthorityV2.js';
import {
  IndependentEvaluationError,
  assertEvaluatorProposalV1,
  computeSanitizedEvaluationRequestHash,
  type EvaluationCancellationAttemptV1,
  type EvaluationCancellationControllerV1,
  type EvaluationCancellationDispatchV1,
  type EvaluationDeadlinePortV1,
  type EvaluationPolicyV1,
  type EvaluationRubricV1,
  type EvaluationRunAuthorityV1,
  type EvaluatorProposalV1,
  type IndependentEvaluationInputV1,
  type IndependentEvaluatorPortV1,
  type DeterministicPreflightResultV1,
  type SanitizedAssertionViewV1,
  type SanitizedCriterionViewV1,
  type SanitizedEvaluationRequestV1,
  type TrustedEvaluationCancellationFactoryV1,
  type TrustedEvaluationControlSnapshotV1,
} from '../domain/independentEvaluation.js';

export function buildSanitizedEvaluationRequest(args: {
  readonly input: IndependentEvaluationInputV1;
  readonly control: TrustedEvaluationControlSnapshotV1;
  readonly preflight: DeterministicPreflightResultV1;
}): SanitizedEvaluationRequestV1 {
  const { input, control, preflight } = args;
  if (preflight.classification !== 'model_judgment_required') {
    throw new IndependentEvaluationError(
      'invalid_input_schema',
      'sanitized evaluation request requires preflight classification model_judgment_required',
    );
  }

  const criteria: SanitizedCriterionViewV1[] = control.rubric.criteria.map(
    (criterion) => ({
      criterionId: criterion.criterionId,
      required: criterion.required,
      authority: criterion.authority,
      allowedAdvisoryClasses: criterion.allowedAdvisoryClasses,
      evaluatorInstructionArtifactId: criterion.evaluatorInstructionArtifactId,
      evaluatorInstructionArtifactHash: criterion.evaluatorInstructionArtifactHash,
    }),
  );

  const allowedAdvisory = new Set<'inference' | 'opinion'>();
  for (const criterion of criteria) {
    for (const advisoryClass of criterion.allowedAdvisoryClasses) {
      allowedAdvisory.add(advisoryClass);
    }
  }

  const assertionsById = new Map<string, DecisionAssertion>();
  for (const assertion of input.assertions) {
    assertionsById.set(assertion.id, assertion);
  }

  const eligibleIds = [...new Set(preflight.eligibleAssertionIds)].sort();
  const eligibleAssertions: SanitizedAssertionViewV1[] = [];
  for (const assertionId of eligibleIds) {
    const assertion = assertionsById.get(assertionId);
    if (assertion === undefined) {
      throw new IndependentEvaluationError(
        'invalid_input_schema',
        `eligible assertion id ${assertionId} is missing from input assertions`,
      );
    }
    eligibleAssertions.push({
      assertionId: assertion.id,
      subjectKey: assertion.subjectKey,
      classification: 'eligible_fact',
      canonicalPayload: assertion.canonicalPayload,
      payloadHash: assertion.payloadHash,
    });
  }

  const advisoryAssertions: SanitizedAssertionViewV1[] = [];
  if (allowedAdvisory.size > 0) {
    const advisoryViews: SanitizedAssertionViewV1[] = [];
    for (const assertion of input.assertions) {
      if (assertion.kind === 'inference' && allowedAdvisory.has('inference')) {
        advisoryViews.push({
          assertionId: assertion.id,
          subjectKey: assertion.subjectKey,
          classification: 'advisory_inference',
          canonicalPayload: assertion.canonicalPayload,
          payloadHash: assertion.payloadHash,
        });
      } else if (assertion.kind === 'opinion' && allowedAdvisory.has('opinion')) {
        advisoryViews.push({
          assertionId: assertion.id,
          subjectKey: assertion.subjectKey,
          classification: 'advisory_opinion',
          canonicalPayload: assertion.canonicalPayload,
          payloadHash: assertion.payloadHash,
        });
      }
    }
    advisoryViews.sort((left, right) =>
      left.assertionId < right.assertionId
        ? -1
        : left.assertionId > right.assertionId
          ? 1
          : 0,
    );
    const seen = new Set<string>();
    for (const view of advisoryViews) {
      if (seen.has(view.assertionId)) {
        continue;
      }
      seen.add(view.assertionId);
      advisoryAssertions.push(view);
    }
  }

  const withoutHash = {
    schema: 'hercules-sanitized-evaluation-request/v1' as const,
    requestId: input.requestId,
    inputHash: input.inputHash,
    taskContractId: control.rubric.taskContractId,
    taskContractVersion: control.rubric.taskContractVersion,
    taskContractHash: control.rubric.taskContractHash,
    policyVersion: control.policy.version,
    policyHash: control.policy.policyHash,
    rubricId: control.rubric.rubricId,
    rubricVersion: control.rubric.version,
    rubricHash: control.rubric.rubricHash,
    criteria,
    preflight,
    eligibleAssertions,
    advisoryAssertions,
  };
  return {
    ...withoutHash,
    requestHash: computeSanitizedEvaluationRequestHash(withoutHash),
  };
}

export type EvaluatorAttemptOutcomeV1 =
  | {
      readonly kind: 'proposal';
      readonly proposal: EvaluatorProposalV1;
      readonly dispatches: readonly EvaluationCancellationDispatchV1[];
    }
  | {
      readonly kind: 'infrastructure_gap';
      readonly code: 'evaluator_unavailable' | 'evaluator_contract_violation';
      readonly evaluatorWasInvoked: boolean;
      readonly advisoryDetail: string;
      readonly dispatches: readonly EvaluationCancellationDispatchV1[];
    };

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function gap(
  code: 'evaluator_unavailable' | 'evaluator_contract_violation',
  evaluatorWasInvoked: boolean,
  advisoryDetail: string,
  dispatches: readonly EvaluationCancellationDispatchV1[],
): EvaluatorAttemptOutcomeV1 {
  return {
    kind: 'infrastructure_gap',
    code,
    evaluatorWasInvoked,
    advisoryDetail,
    dispatches,
  };
}

function isMalformedAttempt(
  attempt: EvaluationCancellationAttemptV1,
): string | null {
  if (
    attempt === null ||
    typeof attempt !== 'object' ||
    typeof attempt.attemptId !== 'string' ||
    attempt.evaluatorController == null ||
    typeof attempt.evaluatorController !== 'object' ||
    attempt.deadlineController == null ||
    typeof attempt.deadlineController !== 'object'
  ) {
    return 'cancellation factory returned a malformed attempt (missing controllers)';
  }
  const evaluatorSignal = attempt.evaluatorController.signal;
  const deadlineSignal = attempt.deadlineController.signal;
  if (
    evaluatorSignal == null ||
    typeof evaluatorSignal !== 'object' ||
    deadlineSignal == null ||
    typeof deadlineSignal !== 'object' ||
    typeof evaluatorSignal.signalId !== 'string' ||
    typeof deadlineSignal.signalId !== 'string' ||
    typeof evaluatorSignal.attemptId !== 'string' ||
    typeof deadlineSignal.attemptId !== 'string'
  ) {
    return 'cancellation factory returned a malformed attempt (missing signals)';
  }
  if (evaluatorSignal.signalId === deadlineSignal.signalId) {
    return 'cancellation factory returned controllers sharing a signalId';
  }
  if (
    evaluatorSignal.attemptId !== attempt.attemptId ||
    deadlineSignal.attemptId !== attempt.attemptId ||
    evaluatorSignal.attemptId !== deadlineSignal.attemptId
  ) {
    return 'cancellation factory returned mismatched attemptIds between controllers';
  }
  return null;
}

function dispatchCancel(
  controller: EvaluationCancellationControllerV1,
  reason: EvaluationCancellationDispatchV1['reason'],
  dispatches: EvaluationCancellationDispatchV1[],
): EvaluatorAttemptOutcomeV1 | null {
  try {
    const dispatch = controller.cancel(reason);
    dispatches.push(dispatch);
    return null;
  } catch (error) {
    return gap(
      'evaluator_unavailable',
      true,
      `cancellation dispatch threw: ${String(error)}`,
      dispatches,
    );
  }
}

function validateProposalAgainstRequest(
  proposal: EvaluatorProposalV1,
  request: SanitizedEvaluationRequestV1,
  policy: EvaluationPolicyV1,
  rubric: EvaluationRubricV1,
  roles: EvaluationRunAuthorityV1,
): string | null {
  try {
    assertEvaluatorProposalV1(proposal, policy, rubric);
  } catch (error) {
    return `malformed evaluator proposal: ${String(error)}`;
  }
  if (proposal.requestId !== request.requestId) {
    return 'evaluator proposal requestId does not match the sanitized request';
  }
  if (proposal.inputHash !== request.inputHash) {
    return 'evaluator proposal inputHash does not match the sanitized request';
  }
  if (proposal.evaluatorRunId !== roles.evaluatorRunId) {
    return 'evaluator proposal evaluatorRunId does not match run authority';
  }
  if (proposal.evaluatorImplementationId !== roles.evaluatorImplementationId) {
    return 'evaluator proposal evaluatorImplementationId does not match run authority';
  }
  const eligibleIds = new Set(
    request.eligibleAssertions.map((view) => view.assertionId),
  );
  for (const criterionProposal of proposal.criterionProposals) {
    for (const assertionId of criterionProposal.premiseAssertionIds) {
      if (!eligibleIds.has(assertionId)) {
        return `evaluator proposal premiseAssertionIds cites non-eligible id ${assertionId}`;
      }
    }
  }
  for (const finding of proposal.findings) {
    for (const assertionId of finding.assertionIds) {
      if (!eligibleIds.has(assertionId)) {
        return `evaluator proposal finding assertionIds cites non-eligible id ${assertionId}`;
      }
    }
  }
  return null;
}

type RaceWinner =
  | {
      readonly source: 'deadline';
      readonly status: 'fulfilled';
      readonly value: unknown;
    }
  | {
      readonly source: 'deadline';
      readonly status: 'rejected';
      readonly reason: unknown;
    }
  | {
      readonly source: 'evaluator';
      readonly status: 'fulfilled';
      readonly value: EvaluatorProposalV1;
    }
  | {
      readonly source: 'evaluator';
      readonly status: 'rejected';
      readonly reason: unknown;
    };

export async function runEvaluatorAttempt(args: {
  readonly request: SanitizedEvaluationRequestV1;
  readonly evaluatorPort: IndependentEvaluatorPortV1;
  readonly deadline: EvaluationDeadlinePortV1;
  readonly cancellationFactory: TrustedEvaluationCancellationFactoryV1;
  readonly policy: EvaluationPolicyV1;
  readonly rubric: EvaluationRubricV1;
  readonly roles: EvaluationRunAuthorityV1;
}): Promise<EvaluatorAttemptOutcomeV1> {
  const {
    request,
    evaluatorPort,
    deadline,
    cancellationFactory,
    policy,
    rubric,
    roles,
  } = args;

  let attempt: EvaluationCancellationAttemptV1;
  try {
    attempt = cancellationFactory.createAttempt();
  } catch (error) {
    return gap(
      'evaluator_unavailable',
      false,
      `cancellation factory createAttempt threw: ${String(error)}`,
      [],
    );
  }

  const malformed = isMalformedAttempt(attempt);
  if (malformed !== null) {
    return gap('evaluator_unavailable', false, malformed, []);
  }

  let deadlinePromise: Promise<'deadline_expired'>;
  try {
    const deadlineReturn = deadline.expireAfter(
      policy.evaluatorDeadlineMs,
      attempt.deadlineController.signal,
    );
    if (!isPromiseLike(deadlineReturn)) {
      return gap(
        'evaluator_unavailable',
        false,
        'deadline.expireAfter returned a non-Promise',
        [],
      );
    }
    deadlinePromise = deadlineReturn as Promise<'deadline_expired'>;
  } catch (error) {
    return gap(
      'evaluator_unavailable',
      false,
      `deadline.expireAfter threw synchronously: ${String(error)}`,
      [],
    );
  }

  let evaluatorPromise: Promise<EvaluatorProposalV1>;
  try {
    const evaluatorReturn = evaluatorPort.evaluate(
      request,
      attempt.evaluatorController.signal,
    );
    if (!isPromiseLike(evaluatorReturn)) {
      const dispatches: EvaluationCancellationDispatchV1[] = [];
      const cancelGap = dispatchCancel(
        attempt.deadlineController,
        'peer_settled',
        dispatches,
      );
      if (cancelGap !== null) {
        return cancelGap;
      }
      return gap(
        'evaluator_unavailable',
        true,
        'evaluatorPort.evaluate returned a non-Promise',
        dispatches,
      );
    }
    evaluatorPromise = evaluatorReturn as Promise<EvaluatorProposalV1>;
  } catch (error) {
    const dispatches: EvaluationCancellationDispatchV1[] = [];
    const cancelGap = dispatchCancel(
      attempt.deadlineController,
      'peer_settled',
      dispatches,
    );
    if (cancelGap !== null) {
      return cancelGap;
    }
    return gap(
      'evaluator_unavailable',
      true,
      `evaluatorPort.evaluate threw synchronously: ${String(error)}`,
      dispatches,
    );
  }

  const deadlineTagged: Promise<RaceWinner> = deadlinePromise.then(
    (value): RaceWinner => ({
      source: 'deadline',
      status: 'fulfilled',
      value,
    }),
    (reason: unknown): RaceWinner => ({
      source: 'deadline',
      status: 'rejected',
      reason,
    }),
  );
  const evaluatorTagged: Promise<RaceWinner> = evaluatorPromise.then(
    (value): RaceWinner => ({
      source: 'evaluator',
      status: 'fulfilled',
      value,
    }),
    (reason: unknown): RaceWinner => ({
      source: 'evaluator',
      status: 'rejected',
      reason,
    }),
  );

  const winner = await Promise.race([deadlineTagged, evaluatorTagged]);
  const dispatches: EvaluationCancellationDispatchV1[] = [];

  if (winner.source === 'deadline') {
    const cancelGap = dispatchCancel(
      attempt.evaluatorController,
      'deadline',
      dispatches,
    );
    if (cancelGap !== null) {
      return cancelGap;
    }
    if (winner.status === 'fulfilled' && winner.value === 'deadline_expired') {
      return gap(
        'evaluator_unavailable',
        true,
        'evaluator deadline expired before proposal settlement',
        dispatches,
      );
    }
    const detail =
      winner.status === 'rejected'
        ? `deadline promise rejected before evaluator settled: ${String(winner.reason)}`
        : `deadline promise resolved a malformed value before evaluator settled: ${String(winner.value)}`;
    return gap('evaluator_unavailable', true, detail, dispatches);
  }

  // Evaluator settled first.
  const peerGap = dispatchCancel(
    attempt.deadlineController,
    'peer_settled',
    dispatches,
  );
  if (peerGap !== null) {
    return peerGap;
  }

  if (winner.status === 'rejected') {
    return gap(
      'evaluator_unavailable',
      true,
      `evaluator promise rejected: ${String(winner.reason)}`,
      dispatches,
    );
  }

  const violation = validateProposalAgainstRequest(
    winner.value,
    request,
    policy,
    rubric,
    roles,
  );
  if (violation !== null) {
    return gap('evaluator_contract_violation', true, violation, dispatches);
  }

  return {
    kind: 'proposal',
    proposal: winner.value,
    dispatches,
  };
}
