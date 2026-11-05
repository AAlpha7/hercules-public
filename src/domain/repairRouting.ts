/**
 * M9 repair-routing domain records.
 *
 * Slice 1: closed input/decision records, hashing, and structural validators.
 * Route derivation lives in later slices under src/routing/.
 */

import { canonicalSerialize, hashCanonicalJson } from './canonicalJson.js';
import {
  EVALUATION_OUTCOMES,
  RECOMMENDED_NEXT_STAGES,
} from './evaluationVerdict.js';
import { ITERATION_STATES } from './iteration.js';
import { isValidIdentifier } from './task.js';

// ---------------------------------------------------------------------------
// Fail-closed error classes (full M9 union; this slice throws schema codes)
// ---------------------------------------------------------------------------

export type RepairRoutingErrorCode =
  | 'invalid_input_schema'
  | 'untrusted_receipt'
  | 'stale_binding'
  | 'history_malformed'
  | 'budget_exceeded'
  | 'convergence_exhausted'
  | 'non_reversible_action'
  | 'unrecognized_failure'
  | 'evidence_conflict'
  | 'contract_unsatisfiable'
  | 'infrastructure_failure'
  | 'idempotency_conflict';

export class RepairRoutingError extends Error {
  override readonly name = 'RepairRoutingError';

  constructor(
    readonly code: RepairRoutingErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Closed unions and distinguishing code sets (verbatim M9 contract)
// ---------------------------------------------------------------------------

export type FailureClassV1 =
  | 'none' // outcome pass
  | 'evidence_gap' // need_more_evidence, missing/stale/unavailable
  | 'evidence_conflict' // contradiction among verified evidence
  | 'verified_defect' // fail backed by intact eligible verified premises
  | 'infrastructure_failure' // evaluator/gate/environment infrastructure
  | 'human_pending' // a required human criterion is unresolved
  | 'contract_unsatisfiable' // criterion cannot be satisfied under the contract
  | 'unrecognized_failure'; // fail carrying a code outside the closed sets

export const FAILURE_CLASSES = [
  'none',
  'evidence_gap',
  'evidence_conflict',
  'verified_defect',
  'infrastructure_failure',
  'human_pending',
  'contract_unsatisfiable',
  'unrecognized_failure',
] as const satisfies readonly FailureClassV1[];

export type RouteV1 =
  | 'complete'
  | 'repair'
  | 'reverify'
  | 'request_contract_change'
  | 'platform_remediation'
  | 'escalate_human';

export const ROUTES = [
  'complete',
  'repair',
  'reverify',
  'request_contract_change',
  'platform_remediation',
  'escalate_human',
] as const satisfies readonly RouteV1[];

/** Sorted closed M8 verified-defect outcomeReasonCodes. */
export const VERIFIED_DEFECT_REASON_CODES = [
  'blocking_finding',
  'deterministic_gate_failed',
  'required_criterion_failed',
] as const;

/** Sorted closed M8 evaluator-infrastructure outcomeReasonCodes. */
export const EVALUATOR_INFRASTRUCTURE_REASON_CODES = [
  'evaluator_contract_violation',
  'evaluator_unavailable',
] as const;

/** Reserved; currently empty — M8 emits no conflict outcome reason code. */
export const CONFLICT_REASON_CODES = [] as const;

/** Reserved; currently empty — M8 emits no unsatisfiable outcome reason code. */
export const UNSATISFIABLE_REASON_CODES = [] as const;

// ---------------------------------------------------------------------------
// Records (verbatim from M9 contract TypeScript blocks)
// ---------------------------------------------------------------------------

export interface QualifiedEvaluationReceiptViewV1 {
  readonly schema: 'hercules-qualified-evaluation-receipt-view/v1';
  readonly receiptId: string;
  readonly requestId: string;
  readonly taskId: string;
  readonly taskContractHash: string;
  readonly iterationId: string;
  readonly candidateCommit: string;
  readonly outcome: 'pass' | 'fail' | 'need_more_evidence';
  readonly recommendedNextStage:
    | 'complete'
    | 'repair'
    | 'reverify'
    | 'request_contract_change'
    | 'escalate_human';
  readonly outcomeReasonCodes: readonly string[];
  readonly blockingFindingCodes: readonly string[];
  readonly requiredHumanCriterionPending: boolean;
  readonly evaluatorInfrastructureFailed: boolean;
  readonly failureSignature: string;
  readonly qualifiedAt: string;
  readonly viewHash: string;
}

export interface IterationAttemptRecordV1 {
  readonly iterationId: string;
  readonly ordinal: number;
  readonly state:
    | 'planned'
    | 'executing'
    | 'verifying'
    | 'evaluating'
    | 'passed'
    | 'failed'
    | 'abandoned';
  readonly candidateCommit: string | null;
  readonly finalVerdictId: string | null;
  readonly failureSignature: string | null;
  readonly nonReversibleActionTaken: boolean;
  readonly supersedesIterationId: string | null;
  readonly createdAt: string;
  readonly endedAt: string | null;
  readonly recordHash: string;
}

export interface RoutingBudgetV1 {
  readonly maxAttempts: number;
  readonly maxSameSignatureRepeats: number;
  readonly attemptsUsed: number;
  readonly costExceeded: boolean;
  readonly tokensExceeded: boolean;
  readonly durationExceeded: boolean;
}

export interface RoutingInputV1 {
  readonly schema: 'hercules-routing-input/v1';
  readonly decisionRequestId: string;
  readonly taskId: string;
  readonly receipt: QualifiedEvaluationReceiptViewV1;
  readonly history: readonly IterationAttemptRecordV1[];
  readonly budget: RoutingBudgetV1;
  readonly inputHash: string;
}

export interface ProposedIterationAttemptV1 {
  readonly proposedIterationId: string;
  readonly ordinal: number;
  readonly supersedesIterationId: string;
  readonly baseCandidateCommit: string;
  readonly rationaleCode: string;
  readonly attemptHash: string;
}

export interface RoutingDecisionV1 {
  readonly schema: 'hercules-routing-decision/v1';
  readonly decisionRequestId: string;
  readonly taskId: string;
  readonly inputHash: string;
  readonly receiptId: string;
  readonly failureClass: FailureClassV1;
  readonly route: RouteV1;
  readonly proposedAttempt: ProposedIterationAttemptV1 | null;
  readonly reasonCodes: readonly string[];
  readonly escalationRequired: boolean;
  readonly derivedAt: string;
  readonly decisionHash: string;
}

// ---------------------------------------------------------------------------
// Closed key lists
// ---------------------------------------------------------------------------

const RECEIPT_VIEW_KEYS = [
  'schema',
  'receiptId',
  'requestId',
  'taskId',
  'taskContractHash',
  'iterationId',
  'candidateCommit',
  'outcome',
  'recommendedNextStage',
  'outcomeReasonCodes',
  'blockingFindingCodes',
  'requiredHumanCriterionPending',
  'evaluatorInfrastructureFailed',
  'failureSignature',
  'qualifiedAt',
  'viewHash',
] as const;

const ITERATION_ATTEMPT_KEYS = [
  'iterationId',
  'ordinal',
  'state',
  'candidateCommit',
  'finalVerdictId',
  'failureSignature',
  'nonReversibleActionTaken',
  'supersedesIterationId',
  'createdAt',
  'endedAt',
  'recordHash',
] as const;

const ROUTING_BUDGET_KEYS = [
  'maxAttempts',
  'maxSameSignatureRepeats',
  'attemptsUsed',
  'costExceeded',
  'tokensExceeded',
  'durationExceeded',
] as const;

const ROUTING_INPUT_KEYS = [
  'schema',
  'decisionRequestId',
  'taskId',
  'receipt',
  'history',
  'budget',
  'inputHash',
] as const;

const PROPOSED_ATTEMPT_KEYS = [
  'proposedIterationId',
  'ordinal',
  'supersedesIterationId',
  'baseCandidateCommit',
  'rationaleCode',
  'attemptHash',
] as const;

const ROUTING_DECISION_KEYS = [
  'schema',
  'decisionRequestId',
  'taskId',
  'inputHash',
  'receiptId',
  'failureClass',
  'route',
  'proposedAttempt',
  'reasonCodes',
  'escalationRequired',
  'derivedAt',
  'decisionHash',
] as const;

// ---------------------------------------------------------------------------
// Local helpers (M8 house pattern)
// ---------------------------------------------------------------------------

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_ARRAY_ITEMS = 4_096;

function fail(message: string): never {
  throw new RepairRoutingError('invalid_input_schema', message);
}

function assertExactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Readonly<Record<string, unknown>> {
  try {
    canonicalSerialize(value);
  } catch (error) {
    fail(`${label} must be stable canonical JSON: ${String(error)}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} must use the exact closed schema`);
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isBoundedNfcString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    utf8Bytes(value) >= 1 &&
    utf8Bytes(value) <= MAX_IDENTIFIER_BYTES &&
    value.normalize('NFC') === value
  );
}

function isBoundedIdentifier(value: unknown): value is string {
  return isBoundedNfcString(value) && isValidIdentifier(value);
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_RE.test(value);
}

function isGitSha(value: unknown): value is string {
  return typeof value === 'string' && GIT_SHA_RE.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || utf8Bytes(value) > MAX_IDENTIFIER_BYTES) {
    return false;
  }
  const time = new Date(value);
  return !Number.isNaN(time.valueOf()) && time.toISOString() === value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function omitHash<T extends object>(
  value: T,
  keyToOmit: string,
): Readonly<Record<string, unknown>> {
  const record = value as unknown as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== keyToOmit),
  );
}

function sortedUniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function assertSortedUniqueBoundedStrings(
  value: unknown,
  label: string,
  allowEmpty = true,
): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_ARRAY_ITEMS ||
    (!allowEmpty && value.length === 0)
  ) {
    fail(`${label} must be a bounded${allowEmpty ? '' : ' non-empty'} array`);
  }
  let previous: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || !isBoundedNfcString(value[index])) {
      fail(`${label} must contain bounded non-empty NFC strings`);
    }
    const current = value[index];
    if (previous !== null && previous >= current) {
      fail(`${label} must contain sorted unique strings`);
    }
    previous = current;
  }
}

function assertDenseArray(
  value: unknown,
  label: string,
): asserts value is readonly unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) {
    fail(`${label} must be a bounded array`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) {
      fail(`${label} must not be sparse`);
    }
  }
}

function intersectsInfrastructureCodes(
  outcomeReasonCodes: readonly string[],
): boolean {
  const infra = EVALUATOR_INFRASTRUCTURE_REASON_CODES as readonly string[];
  return outcomeReasonCodes.some((code) => infra.includes(code));
}

function stateConsistentWithOutcome(
  state: IterationAttemptRecordV1['state'],
  outcome: QualifiedEvaluationReceiptViewV1['outcome'],
): boolean {
  if (outcome === 'pass') return state === 'passed';
  if (outcome === 'fail') return state === 'failed';
  return state === 'evaluating' || state === 'verifying';
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function computeFailureSignature(
  outcome: QualifiedEvaluationReceiptViewV1['outcome'],
  outcomeReasonCodes: readonly string[],
  blockingFindingCodes: readonly string[],
): string {
  return hashCanonicalJson({
    outcome,
    outcomeReasonCodes: sortedUniqueStrings(outcomeReasonCodes),
    blockingFindingCodes: sortedUniqueStrings(blockingFindingCodes),
  });
}

export function computeViewHash(
  view: Omit<QualifiedEvaluationReceiptViewV1, 'viewHash'>,
): string {
  return hashCanonicalJson(view);
}

export function computeRecordHash(
  record: Omit<IterationAttemptRecordV1, 'recordHash'>,
): string {
  return hashCanonicalJson(record);
}

export function computeInputHash(
  input: Omit<RoutingInputV1, 'inputHash'>,
): string {
  return hashCanonicalJson(input);
}

export function computeAttemptHash(
  attempt: Omit<ProposedIterationAttemptV1, 'attemptHash'>,
): string {
  return hashCanonicalJson(attempt);
}

export function computeDecisionHash(
  decision: Omit<RoutingDecisionV1, 'decisionHash'>,
): string {
  return hashCanonicalJson(decision);
}

// ---------------------------------------------------------------------------
// Structural validators
// ---------------------------------------------------------------------------

export function assertQualifiedEvaluationReceiptViewV1(
  view: QualifiedEvaluationReceiptViewV1,
): void {
  assertExactRecord(view, RECEIPT_VIEW_KEYS, 'qualified evaluation receipt view');
  if (
    view.schema !== 'hercules-qualified-evaluation-receipt-view/v1' ||
    !isBoundedIdentifier(view.receiptId) ||
    !isBoundedIdentifier(view.requestId) ||
    !isBoundedIdentifier(view.taskId) ||
    !isHash(view.taskContractHash) ||
    !isBoundedIdentifier(view.iterationId) ||
    !isGitSha(view.candidateCommit) ||
    !(EVALUATION_OUTCOMES as readonly unknown[]).includes(view.outcome) ||
    !(RECOMMENDED_NEXT_STAGES as readonly unknown[]).includes(
      view.recommendedNextStage,
    ) ||
    typeof view.requiredHumanCriterionPending !== 'boolean' ||
    typeof view.evaluatorInfrastructureFailed !== 'boolean' ||
    !isHash(view.failureSignature) ||
    !isCanonicalTimestamp(view.qualifiedAt) ||
    !isHash(view.viewHash)
  ) {
    fail(
      'qualified evaluation receipt view identity, enums, timestamps, and hashes must be valid',
    );
  }
  assertSortedUniqueBoundedStrings(
    view.outcomeReasonCodes,
    'qualified evaluation receipt view outcomeReasonCodes',
  );
  assertSortedUniqueBoundedStrings(
    view.blockingFindingCodes,
    'qualified evaluation receipt view blockingFindingCodes',
  );
  const expectedInfra = intersectsInfrastructureCodes(view.outcomeReasonCodes);
  if (view.evaluatorInfrastructureFailed !== expectedInfra) {
    fail(
      'qualified evaluation receipt view evaluatorInfrastructureFailed does not match outcomeReasonCodes',
    );
  }
  const expectedSignature = computeFailureSignature(
    view.outcome,
    view.outcomeReasonCodes,
    view.blockingFindingCodes,
  );
  if (view.failureSignature !== expectedSignature) {
    fail(
      'qualified evaluation receipt view failureSignature does not match the derived signature',
    );
  }
  const expectedHash = hashCanonicalJson(omitHash(view, 'viewHash'));
  if (view.viewHash !== expectedHash) {
    fail('qualified evaluation receipt view hash does not match the exact record');
  }
}

export function assertIterationAttemptRecordV1(
  record: IterationAttemptRecordV1,
): void {
  assertExactRecord(record, ITERATION_ATTEMPT_KEYS, 'iteration attempt record');
  if (
    !isBoundedIdentifier(record.iterationId) ||
    !isNonNegativeSafeInteger(record.ordinal) ||
    !(ITERATION_STATES as readonly unknown[]).includes(record.state) ||
    !(record.candidateCommit === null || isGitSha(record.candidateCommit)) ||
    !(
      record.finalVerdictId === null || isBoundedIdentifier(record.finalVerdictId)
    ) ||
    !(record.failureSignature === null || isHash(record.failureSignature)) ||
    typeof record.nonReversibleActionTaken !== 'boolean' ||
    !(
      record.supersedesIterationId === null ||
      isBoundedIdentifier(record.supersedesIterationId)
    ) ||
    !isCanonicalTimestamp(record.createdAt) ||
    !(record.endedAt === null || isCanonicalTimestamp(record.endedAt)) ||
    !isHash(record.recordHash)
  ) {
    fail(
      'iteration attempt record identity, state, commits, timestamps, and hash must be valid',
    );
  }
  const expectedHash = hashCanonicalJson(omitHash(record, 'recordHash'));
  if (record.recordHash !== expectedHash) {
    fail('iteration attempt record hash does not match the exact record');
  }
}

export function assertRoutingBudgetV1(budget: RoutingBudgetV1): void {
  assertExactRecord(budget, ROUTING_BUDGET_KEYS, 'routing budget');
  if (
    !isPositiveSafeInteger(budget.maxAttempts) ||
    !isPositiveSafeInteger(budget.maxSameSignatureRepeats) ||
    !isNonNegativeSafeInteger(budget.attemptsUsed) ||
    typeof budget.costExceeded !== 'boolean' ||
    typeof budget.tokensExceeded !== 'boolean' ||
    typeof budget.durationExceeded !== 'boolean'
  ) {
    fail(
      'routing budget counts must be safe integers and flags must be booleans',
    );
  }
}

export function assertRoutingInputV1(input: RoutingInputV1): void {
  assertExactRecord(input, ROUTING_INPUT_KEYS, 'routing input');
  if (
    input.schema !== 'hercules-routing-input/v1' ||
    !isBoundedIdentifier(input.decisionRequestId) ||
    !isBoundedIdentifier(input.taskId) ||
    !isHash(input.inputHash)
  ) {
    fail('routing input schema, identities, and hash must be valid');
  }
  assertQualifiedEvaluationReceiptViewV1(input.receipt);
  if (input.receipt.taskId !== input.taskId) {
    fail('routing input taskId must equal receipt.taskId');
  }
  assertRoutingBudgetV1(input.budget);
  assertDenseArray(input.history, 'routing input history');
  if (input.history.length === 0) {
    fail('routing input history must contain the evaluated iteration');
  }
  const iterationIds = new Set<string>();
  for (let index = 0; index < input.history.length; index += 1) {
    const entry = input.history[index];
    if (entry === undefined) {
      fail('routing input history must not be sparse');
    }
    assertIterationAttemptRecordV1(entry);
    if (iterationIds.has(entry.iterationId)) {
      fail('routing input history iteration ids must be unique');
    }
    iterationIds.add(entry.iterationId);
    if (index === 0) {
      if (entry.ordinal !== 0 && entry.ordinal !== 1) {
        fail(
          'routing input history ordinals must start at 0 or 1 (contiguous base)',
        );
      }
    } else {
      const previous = input.history[index - 1];
      if (previous === undefined || entry.ordinal !== previous.ordinal + 1) {
        fail(
          'routing input history ordinals must be strictly increasing with no gaps',
        );
      }
    }
  }
  const last = input.history[input.history.length - 1];
  if (last === undefined) {
    fail('routing input history must contain the evaluated iteration');
  }
  if (last.iterationId !== input.receipt.iterationId) {
    fail(
      'routing input history last entry must be the iteration named by receipt.iterationId',
    );
  }
  if (!stateConsistentWithOutcome(last.state, input.receipt.outcome)) {
    fail(
      'routing input history last entry state must be consistent with receipt.outcome',
    );
  }
  const expectedHash = hashCanonicalJson(omitHash(input, 'inputHash'));
  if (input.inputHash !== expectedHash) {
    fail('routing input hash does not match the exact record');
  }
}

export function assertProposedIterationAttemptV1(
  attempt: ProposedIterationAttemptV1,
): void {
  assertExactRecord(attempt, PROPOSED_ATTEMPT_KEYS, 'proposed iteration attempt');
  if (
    !isBoundedIdentifier(attempt.proposedIterationId) ||
    !isPositiveSafeInteger(attempt.ordinal) ||
    !isBoundedIdentifier(attempt.supersedesIterationId) ||
    !isGitSha(attempt.baseCandidateCommit) ||
    !isBoundedIdentifier(attempt.rationaleCode) ||
    !isHash(attempt.attemptHash)
  ) {
    fail(
      'proposed iteration attempt identity, ordinal, commit, and hash must be valid',
    );
  }
  const expectedHash = hashCanonicalJson(omitHash(attempt, 'attemptHash'));
  if (attempt.attemptHash !== expectedHash) {
    fail('proposed iteration attempt hash does not match the exact record');
  }
}

export function assertRoutingDecisionV1(decision: RoutingDecisionV1): void {
  assertExactRecord(decision, ROUTING_DECISION_KEYS, 'routing decision');
  if (
    decision.schema !== 'hercules-routing-decision/v1' ||
    !isBoundedIdentifier(decision.decisionRequestId) ||
    !isBoundedIdentifier(decision.taskId) ||
    !isHash(decision.inputHash) ||
    !isBoundedIdentifier(decision.receiptId) ||
    !(FAILURE_CLASSES as readonly unknown[]).includes(decision.failureClass) ||
    !(ROUTES as readonly unknown[]).includes(decision.route) ||
    typeof decision.escalationRequired !== 'boolean' ||
    !isCanonicalTimestamp(decision.derivedAt) ||
    !isHash(decision.decisionHash)
  ) {
    fail(
      'routing decision schema, identities, enums, timestamp, and hash must be valid',
    );
  }
  assertSortedUniqueBoundedStrings(
    decision.reasonCodes,
    'routing decision reasonCodes',
    false,
  );
  if (decision.escalationRequired !== (decision.route === 'escalate_human')) {
    fail(
      'routing decision escalationRequired must equal (route === escalate_human)',
    );
  }
  const repairRoute = decision.route === 'repair';
  const attemptPresent = decision.proposedAttempt !== null;
  if (repairRoute !== attemptPresent) {
    fail(
      'routing decision proposedAttempt must be non-null iff route === repair',
    );
  }
  if (decision.proposedAttempt !== null) {
    assertProposedIterationAttemptV1(decision.proposedAttempt);
  }
  const expectedHash = hashCanonicalJson(omitHash(decision, 'decisionHash'));
  if (decision.decisionHash !== expectedHash) {
    fail('routing decision hash does not match the exact record');
  }
}
