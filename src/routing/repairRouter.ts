/**
 * M9 repair router — ordered total route derivation.
 *
 * Deterministic given its inputs and the injected clock. Imports only from
 * `src/domain/` and local `src/routing/` peers. Never throws: every failure
 * yields a gap, conflict, or branded decision. The only non-input value that
 * enters a decision is `derivedAt`, sourced from the injected clock (default
 * wall-clock); inject a fixed clock for byte-reproducible `decisionHash`.
 */

import { hashCanonicalJson } from '../domain/canonicalJson.js';
import {
  RepairRoutingError,
  assertRoutingDecisionV1,
  assertRoutingInputV1,
  computeAttemptHash,
  computeDecisionHash,
  type FailureClassV1,
  type IterationAttemptRecordV1,
  type ProposedIterationAttemptV1,
  type QualifiedEvaluationReceiptViewV1,
  type RepairRoutingErrorCode,
  type RoutingDecisionV1,
  type RoutingInputV1,
} from '../domain/repairRouting.js';
import { classifyFailure } from './failureTaxonomy.js';
import {
  REPAIR_RATIONALE_CODE,
  ROUTE_REASON_ALL_CRITERIA_PASS,
  ROUTE_REASON_BUDGET_OR_CONVERGENCE,
  ROUTE_REASON_NON_REVERSIBLE_ACTION,
  reasonCodesForClass,
  routeForClass,
} from './routePolicy.js';

const DEFAULT_MAX_RESERVATIONS = 1024;
const ABSOLUTE_MAX_RESERVATIONS = 4096;

/**
 * Injected seam: reconfirm the caller-supplied view against a live branded M8
 * receipt (or source-bound restore). Returns the trusted projection, or null
 * when the brand cannot be reconfirmed. Concrete impl lives outside this module.
 */
export interface TrustedRoutingReceiptReconfirmationV1 {
  reconfirm(
    view: QualifiedEvaluationReceiptViewV1,
  ): QualifiedEvaluationReceiptViewV1 | null;
}

export type RepairRoutingGapCode = RepairRoutingErrorCode | 'capacity';

export type RepairRoutingOutcomeV1 =
  | { readonly kind: 'decision'; readonly decision: RoutingDecisionV1 }
  | {
      readonly kind: 'gap';
      readonly code: RepairRoutingGapCode;
      readonly detail: string;
    }
  | {
      readonly kind: 'conflict';
      readonly code: 'idempotency_conflict';
      readonly detail: string;
    };

export interface RepairRouterV1 {
  route(input: RoutingInputV1): RepairRoutingOutcomeV1;
  isTrustedDecision(decision: RoutingDecisionV1): boolean;
}

/** Injected clock seam; a fixed clock makes `decisionHash` reproducible. */
export interface RoutingClockV1 {
  nowUtc(): string;
}

const WALL_CLOCK: RoutingClockV1 = { nowUtc: () => new Date().toISOString() };

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  if (!Object.isFrozen(value)) {
    Object.freeze(value);
  }
  return value;
}

function freezeOutcome(outcome: RepairRoutingOutcomeV1): RepairRoutingOutcomeV1 {
  return deepFreeze(outcome);
}

function gap(
  code: RepairRoutingGapCode,
  detail: string,
): RepairRoutingOutcomeV1 {
  return freezeOutcome({ kind: 'gap', code, detail });
}

function conflict(detail: string): RepairRoutingOutcomeV1 {
  return freezeOutcome({
    kind: 'conflict',
    code: 'idempotency_conflict',
    detail,
  });
}

function mapAssertError(error: unknown): RepairRoutingOutcomeV1 {
  if (error instanceof RepairRoutingError) {
    if (
      error.code === 'invalid_input_schema' &&
      /history/i.test(error.message)
    ) {
      return gap('history_malformed', error.message);
    }
    return gap(error.code, error.message);
  }
  if (error instanceof Error) {
    return gap('invalid_input_schema', error.message);
  }
  return gap('invalid_input_schema', String(error));
}

function viewsByteEqual(
  left: QualifiedEvaluationReceiptViewV1,
  right: QualifiedEvaluationReceiptViewV1,
): boolean {
  try {
    return hashCanonicalJson(left) === hashCanonicalJson(right);
  } catch {
    return false;
  }
}

/**
 * Walk the superseded iteration and its supersedesIterationId chain.
 * Returns true if any reachable entry took a non-reversible action.
 */
function chainHasNonReversibleAction(
  history: readonly IterationAttemptRecordV1[],
): boolean {
  const last = history[history.length - 1];
  if (last === undefined) {
    return false;
  }
  const byId = new Map<string, IterationAttemptRecordV1>();
  for (const entry of history) {
    byId.set(entry.iterationId, entry);
  }
  const seen = new Set<string>();
  let current: IterationAttemptRecordV1 | undefined = last;
  while (current !== undefined) {
    if (current.nonReversibleActionTaken) {
      return true;
    }
    if (seen.has(current.iterationId)) {
      break;
    }
    seen.add(current.iterationId);
    if (current.supersedesIterationId === null) {
      break;
    }
    current = byId.get(current.supersedesIterationId);
  }
  return false;
}

function signatureRepeatCount(
  history: readonly IterationAttemptRecordV1[],
  failureSignature: string,
): number {
  let count = 0;
  for (const entry of history) {
    if (entry.failureSignature === failureSignature) {
      count += 1;
    }
  }
  return count;
}

function budgetOrConvergenceExceeded(input: RoutingInputV1): boolean {
  const { budget, receipt, history } = input;
  if (budget.attemptsUsed >= budget.maxAttempts) {
    return true;
  }
  if (budget.costExceeded || budget.tokensExceeded || budget.durationExceeded) {
    return true;
  }
  return (
    signatureRepeatCount(history, receipt.failureSignature) >=
    budget.maxSameSignatureRepeats
  );
}

function buildProposedAttempt(
  input: RoutingInputV1,
): ProposedIterationAttemptV1 {
  const last = input.history[input.history.length - 1]!;
  const ordinal = last.ordinal + 1;
  const baseCandidateCommit = input.receipt.candidateCommit;
  const supersedesIterationId = last.iterationId;
  // Deterministic id: hash seed without the `sha256:` prefix (colon is not a
  // valid identifier character).
  const idSeed = hashCanonicalJson({
    decisionRequestId: input.decisionRequestId,
    ordinal,
    supersedesIterationId,
    baseCandidateCommit,
  });
  const proposedIterationId = `repair-${idSeed.slice('sha256:'.length, 'sha256:'.length + 32)}`;
  const withoutHash: Omit<ProposedIterationAttemptV1, 'attemptHash'> = {
    proposedIterationId,
    ordinal,
    supersedesIterationId,
    baseCandidateCommit,
    rationaleCode: REPAIR_RATIONALE_CODE,
  };
  return {
    ...withoutHash,
    attemptHash: computeAttemptHash(withoutHash),
  };
}

function buildDecision(
  input: RoutingInputV1,
  failureClass: FailureClassV1,
  route: RoutingDecisionV1['route'],
  reasonCodes: readonly string[],
  proposedAttempt: ProposedIterationAttemptV1 | null,
  derivedAt: string,
): RoutingDecisionV1 {
  const withoutHash: Omit<RoutingDecisionV1, 'decisionHash'> = {
    schema: 'hercules-routing-decision/v1',
    decisionRequestId: input.decisionRequestId,
    taskId: input.taskId,
    inputHash: input.inputHash,
    receiptId: input.receipt.receiptId,
    failureClass,
    route,
    proposedAttempt,
    reasonCodes: [...new Set(reasonCodes)].sort(),
    escalationRequired: route === 'escalate_human',
    derivedAt,
  };
  const decision: RoutingDecisionV1 = {
    ...withoutHash,
    decisionHash: computeDecisionHash(withoutHash),
  };
  assertRoutingDecisionV1(decision);
  return deepFreeze(decision);
}

export function createRepairRouter(
  reconfirmation: TrustedRoutingReceiptReconfirmationV1,
  options?: { readonly maxReservations?: number; readonly clock?: RoutingClockV1 },
): RepairRouterV1 {
  const maxReservations = Math.min(
    options?.maxReservations ?? DEFAULT_MAX_RESERVATIONS,
    ABSOLUTE_MAX_RESERVATIONS,
  );
  const clock = options?.clock ?? WALL_CLOCK;

  const trustedDecisions = new WeakSet<RoutingDecisionV1>();
  /** Settled decisions keyed by decisionRequestId + inputHash. No eviction. */
  const reservations = new Map<string, RoutingDecisionV1>();
  /** First-seen inputHash per decisionRequestId (idempotency conflict detector). */
  const requestIdToInputHash = new Map<string, string>();

  function reservationKey(decisionRequestId: string, inputHash: string): string {
    return `${decisionRequestId}\u0000${inputHash}`;
  }

  function route(input: RoutingInputV1): RepairRoutingOutcomeV1 {
    // --- Rule 1: Trust and structure ---
    try {
      assertRoutingInputV1(input);
    } catch (error) {
      return mapAssertError(error);
    }

    let trustedView: QualifiedEvaluationReceiptViewV1 | null;
    try {
      trustedView = reconfirmation.reconfirm(input.receipt);
    } catch (error) {
      return gap(
        'untrusted_receipt',
        error instanceof Error ? error.message : String(error),
      );
    }
    if (trustedView === null) {
      return gap(
        'untrusted_receipt',
        'receipt brand could not be reconfirmed',
      );
    }
    if (!viewsByteEqual(trustedView, input.receipt)) {
      return gap(
        'untrusted_receipt',
        'caller receipt view does not byte-equal the trusted projection',
      );
    }

    // Idempotency: same decisionRequestId with a different inputHash → conflict.
    const priorHash = requestIdToInputHash.get(input.decisionRequestId);
    if (priorHash !== undefined && priorHash !== input.inputHash) {
      return conflict(
        `decisionRequestId ${input.decisionRequestId} is reserved against a different inputHash`,
      );
    }

    const key = reservationKey(input.decisionRequestId, input.inputHash);
    const memoized = reservations.get(key);
    if (memoized !== undefined) {
      // Fresh reconfirm already succeeded; return the byte-identical decision.
      return freezeOutcome({ kind: 'decision', decision: memoized });
    }

    if (reservations.size >= maxReservations) {
      return gap(
        'capacity',
        `router reservation table is full at ${maxReservations}`,
      );
    }

    try {
      // --- Rule 2: Classification ---
      const failureClass = classifyFailure(trustedView);

      // --- Rule 3: Success short-circuit (precedes budget / non-reversible) ---
      if (failureClass === 'none') {
        const decision = buildDecision(
          input,
          failureClass,
          'complete',
          [ROUTE_REASON_ALL_CRITERIA_PASS],
          null,
          clock.nowUtc(),
        );
        trustedDecisions.add(decision);
        reservations.set(key, decision);
        requestIdToInputHash.set(input.decisionRequestId, input.inputHash);
        return freezeOutcome({ kind: 'decision', decision });
      }

      // --- Rule 4: Budget / convergence (failure classes only) ---
      if (budgetOrConvergenceExceeded(input)) {
        const decision = buildDecision(
          input,
          failureClass,
          'escalate_human',
          [ROUTE_REASON_BUDGET_OR_CONVERGENCE],
          null,
          clock.nowUtc(),
        );
        trustedDecisions.add(decision);
        reservations.set(key, decision);
        requestIdToInputHash.set(input.decisionRequestId, input.inputHash);
        return freezeOutcome({ kind: 'decision', decision });
      }

      // --- Rule 5: Non-reversible guard (verified_defect only) ---
      if (
        failureClass === 'verified_defect' &&
        chainHasNonReversibleAction(input.history)
      ) {
        const decision = buildDecision(
          input,
          failureClass,
          'escalate_human',
          [ROUTE_REASON_NON_REVERSIBLE_ACTION],
          null,
          clock.nowUtc(),
        );
        trustedDecisions.add(decision);
        reservations.set(key, decision);
        requestIdToInputHash.set(input.decisionRequestId, input.inputHash);
        return freezeOutcome({ kind: 'decision', decision });
      }

      // --- Rule 6: Class routing ---
      const routeName = routeForClass(failureClass);
      const proposedAttempt =
        routeName === 'repair' ? buildProposedAttempt(input) : null;
      const reasonCodes = reasonCodesForClass(failureClass);

      // --- Rule 7: Assemble + brand ---
      const decision = buildDecision(
        input,
        failureClass,
        routeName,
        reasonCodes,
        proposedAttempt,
        clock.nowUtc(),
      );
      trustedDecisions.add(decision);
      reservations.set(key, decision);
      requestIdToInputHash.set(input.decisionRequestId, input.inputHash);
      return freezeOutcome({ kind: 'decision', decision });
    } catch (error) {
      return mapAssertError(error);
    }
  }

  function isTrustedDecision(decision: RoutingDecisionV1): boolean {
    return trustedDecisions.has(decision);
  }

  return { route, isTrustedDecision };
}
