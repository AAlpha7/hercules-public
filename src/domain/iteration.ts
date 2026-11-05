import {
  assertCandidateRef,
  candidateRefsEqual,
  type CandidateRef,
} from './artifact.js';
import {
  isNonEmptyString,
  isNullableNonEmptyString,
  isRecord,
  V2InvariantError,
} from './v2Invariant.js';

export const ITERATION_STATES = [
  'planned',
  'executing',
  'verifying',
  'evaluating',
  'passed',
  'failed',
  'abandoned',
] as const;

export type IterationState = (typeof ITERATION_STATES)[number];

export interface Iteration {
  readonly id: string;
  readonly taskId: string;
  readonly contractVersion: number;
  readonly ordinal: number;
  readonly state: IterationState;
  readonly candidateRef: CandidateRef | null;
  readonly evidenceManifestId: string | null;
  readonly finalVerdictId: string | null;
  readonly createdAt: string;
  readonly endedAt: string | null;
  readonly supersedesIterationId: string | null;
}

export interface IterationFacts {
  readonly candidateRef: CandidateRef | null;
  readonly evidenceManifestId: string | null;
  readonly finalVerdictId: string | null;
}

const ALLOWED_ITERATION_TRANSITIONS: Readonly<
  Record<IterationState, readonly IterationState[]>
> = {
  planned: ['executing', 'abandoned'],
  executing: ['verifying', 'failed', 'abandoned'],
  verifying: ['evaluating', 'failed', 'abandoned'],
  evaluating: ['verifying', 'passed', 'failed', 'abandoned'],
  passed: [],
  failed: [],
  abandoned: [],
};

function iterationTimingIssue(
  iteration: Pick<Iteration, 'state' | 'endedAt'>,
): string | null {
  if (!isNullableNonEmptyString(iteration.endedAt)) {
    return 'iteration endedAt must be null or a non-empty string';
  }
  const terminal =
    iteration.state === 'passed' ||
    iteration.state === 'failed' ||
    iteration.state === 'abandoned';
  if (terminal !== (iteration.endedAt !== null)) {
    return terminal
      ? 'terminal iteration state requires endedAt'
      : 'active iteration cannot have endedAt';
  }
  return null;
}

function iterationRecordIssue(iteration: Iteration): string | null {
  if (!isRecord(iteration)) {
    return 'iteration record must be an object';
  }
  if (
    !(ITERATION_STATES as readonly unknown[]).includes(iteration.state) ||
    !isNonEmptyString(iteration.id) ||
    !isNonEmptyString(iteration.taskId) ||
    !isNonEmptyString(iteration.createdAt) ||
    !isNullableNonEmptyString(iteration.evidenceManifestId) ||
    !isNullableNonEmptyString(iteration.finalVerdictId) ||
    !isNullableNonEmptyString(iteration.supersedesIterationId) ||
    !Number.isSafeInteger(iteration.contractVersion) ||
    iteration.contractVersion < 1 ||
    !Number.isSafeInteger(iteration.ordinal) ||
    iteration.ordinal < 1
  ) {
    return 'iteration identity, contractVersion, and ordinal must be valid';
  }
  const timingIssue = iterationTimingIssue(iteration);
  if (timingIssue !== null) return timingIssue;

  const hasCandidate = iteration.candidateRef !== null;
  const hasEvidence = iteration.evidenceManifestId !== null;
  const hasVerdict = iteration.finalVerdictId !== null;
  if (hasEvidence && !hasCandidate) {
    return 'iteration evidence requires an exact candidate';
  }
  if (hasVerdict && (!hasCandidate || !hasEvidence)) {
    return 'iteration final verdict requires exact candidate and evidence identities';
  }
  if (iteration.state === 'planned' && (hasCandidate || hasEvidence || hasVerdict)) {
    return 'planned iteration cannot carry future candidate, evidence, or verdict facts';
  }
  if (iteration.state === 'executing' && (hasCandidate || hasEvidence || hasVerdict)) {
    return 'executing iteration cannot carry future candidate, evidence, or verdict facts';
  }
  if (iteration.state === 'verifying' && (!hasCandidate || hasVerdict)) {
    return 'verifying iteration requires a candidate and cannot carry a final verdict';
  }
  if (iteration.state === 'evaluating' && (!hasCandidate || !hasEvidence)) {
    return 'evaluating iteration requires exact candidate and evidence identities';
  }
  if (iteration.state === 'evaluating' && hasVerdict) {
    return 'evaluating iteration cannot carry a future final verdict';
  }
  if (iteration.state === 'passed' && (!hasCandidate || !hasEvidence || !hasVerdict)) {
    return 'passed iteration requires exact candidate, evidence, and final verdict identities';
  }
  if (iteration.state === 'abandoned' && hasVerdict) {
    return 'abandoned iteration cannot carry a final verdict identity';
  }
  return null;
}

function assertIterationRecord(iteration: Iteration, context: string): void {
  const issue = iterationRecordIssue(iteration);
  if (issue !== null) {
    throw new V2InvariantError('invalid_iteration_history', `${context}: ${issue}`);
  }
  if (iteration.candidateRef !== null) assertCandidateRef(iteration.candidateRef);
}

export function canTransitionIteration(from: IterationState, to: IterationState): boolean {
  if (
    !(ITERATION_STATES as readonly unknown[]).includes(from) ||
    !(ITERATION_STATES as readonly unknown[]).includes(to)
  ) {
    return false;
  }
  const allowed = ALLOWED_ITERATION_TRANSITIONS[from] as readonly IterationState[] | undefined;
  return from === to || allowed?.includes(to) === true;
}

export function transitionIteration(
  iteration: Iteration,
  state: IterationState,
  endedAt: string | null,
  facts: IterationFacts = isRecord(iteration)
    ? {
        candidateRef: iteration.candidateRef,
        evidenceManifestId: iteration.evidenceManifestId,
        finalVerdictId: iteration.finalVerdictId,
      }
    : { candidateRef: null, evidenceManifestId: null, finalVerdictId: null },
): Iteration {
  const sourceIssue = iterationRecordIssue(iteration);
  if (sourceIssue !== null) {
    throw new V2InvariantError(
      'invalid_iteration_transition',
      `source iteration record is invalid: ${sourceIssue}`,
    );
  }
  if (iteration.candidateRef !== null) assertCandidateRef(iteration.candidateRef);
  if (
    !isRecord(facts) ||
    !isNullableNonEmptyString(facts.evidenceManifestId) ||
    !isNullableNonEmptyString(facts.finalVerdictId)
  ) {
    throw new V2InvariantError(
      'invalid_iteration_transition',
      'iteration transition facts must carry valid candidate, evidence, and verdict identities',
    );
  }
  if (facts.candidateRef !== null) assertCandidateRef(facts.candidateRef);
  if (!canTransitionIteration(iteration.state, state)) {
    throw new V2InvariantError(
      'invalid_iteration_transition',
      `illegal iteration transition: ${iteration.state} -> ${state}`,
    );
  }
  if (state === iteration.state) {
    if (
      endedAt !== iteration.endedAt ||
      ((facts.candidateRef === null) !== (iteration.candidateRef === null)) ||
      (facts.candidateRef !== null &&
        iteration.candidateRef !== null &&
        !candidateRefsEqual(facts.candidateRef, iteration.candidateRef)) ||
      facts.evidenceManifestId !== iteration.evidenceManifestId ||
      facts.finalVerdictId !== iteration.finalVerdictId
    ) {
      throw new V2InvariantError(
        'invalid_iteration_transition',
        'an idempotent iteration transition cannot rewrite timing or lifecycle facts',
      );
    }
    return iteration;
  }
  const candidateChanged =
    (facts.candidateRef === null) !== (iteration.candidateRef === null) ||
    (facts.candidateRef !== null &&
      iteration.candidateRef !== null &&
      !candidateRefsEqual(facts.candidateRef, iteration.candidateRef));
  const evidenceChanged = facts.evidenceManifestId !== iteration.evidenceManifestId;
  const verdictChanged = facts.finalVerdictId !== iteration.finalVerdictId;
  if (
    candidateChanged &&
    !(
      iteration.state === 'executing' &&
      state === 'verifying' &&
      iteration.candidateRef === null &&
      facts.candidateRef !== null
    )
  ) {
    throw new V2InvariantError(
      'invalid_iteration_transition',
      'only an executing-to-verifying transition can establish candidate identity',
    );
  }
  if (
    iteration.state === 'executing' &&
    state === 'verifying' &&
    facts.candidateRef === null
  ) {
    throw new V2InvariantError(
      'invalid_iteration_transition',
      'executing-to-verifying transition requires an exact candidate identity',
    );
  }
  if (
    evidenceChanged &&
    !(iteration.state === 'verifying' && state === 'evaluating')
  ) {
    throw new V2InvariantError(
      'invalid_iteration_transition',
      'only a verifying-to-evaluating transition can establish evidence identity',
    );
  }
  if (
    iteration.state === 'verifying' &&
    state === 'evaluating' &&
    (!evidenceChanged || facts.evidenceManifestId === null)
  ) {
    throw new V2InvariantError(
      'invalid_iteration_transition',
      'verifying-to-evaluating transition requires a new evidence manifest identity',
    );
  }
  if (
    verdictChanged &&
    !(
      iteration.state === 'evaluating' &&
      (state === 'passed' || state === 'failed') &&
      iteration.finalVerdictId === null &&
      facts.finalVerdictId !== null
    )
  ) {
    throw new V2InvariantError(
      'invalid_iteration_transition',
      'only an evaluating terminal transition can establish final verdict identity',
    );
  }
  if (
    iteration.state === 'evaluating' &&
    (state === 'passed' || state === 'failed') &&
    facts.finalVerdictId === null
  ) {
    throw new V2InvariantError(
      'invalid_iteration_transition',
      'an evaluating verdict-driven terminal transition requires a final verdict identity',
    );
  }
  const target = { ...iteration, state, endedAt, ...facts };
  const targetIssue = iterationRecordIssue(target);
  if (targetIssue !== null) {
    throw new V2InvariantError(
      'invalid_iteration_transition',
      targetIssue,
    );
  }
  return target;
}

function failIterationHistory(message: string): never {
  throw new V2InvariantError('invalid_iteration_history', message);
}

function assertIterationHistory(history: readonly Iteration[]): void {
  if (!Array.isArray(history)) {
    failIterationHistory('iteration history must be an array');
  }
  const ids = new Set<string>();
  let taskId: string | null = null;
  let previous: Iteration | null = null;
  for (const iteration of history) {
    assertIterationRecord(iteration, 'iteration history is invalid');
    if (ids.has(iteration.id)) {
      failIterationHistory(`iteration id ${iteration.id} already exists`);
    }
    taskId ??= iteration.taskId;
    if (iteration.taskId !== taskId) {
      failIterationHistory('iteration history contains more than one task identity');
    }
    const expectedOrdinal = previous === null ? 1 : previous.ordinal + 1;
    const expectedSupersedes = previous?.id ?? null;
    if (
      iteration.ordinal !== expectedOrdinal ||
      iteration.supersedesIterationId !== expectedSupersedes
    ) {
      failIterationHistory(
        `iteration history must be contiguous at ordinal ${expectedOrdinal}`,
      );
    }
    if (previous !== null) {
      if (previous.state !== 'failed') {
        failIterationHistory('only a failed iteration can be superseded');
      }
      if (iteration.contractVersion < previous.contractVersion) {
        failIterationHistory('iteration contract version cannot move backwards');
      }
    }
    ids.add(iteration.id);
    previous = iteration;
  }
}

/** Append a new complete attempt; failed/superseded attempts remain addressable. */
export function appendIteration(
  history: readonly Iteration[],
  next: Iteration,
): readonly Iteration[] {
  assertIterationHistory(history);
  assertIterationRecord(next, 'new iteration is invalid');
  if (next.id.length === 0 || next.taskId.length === 0) {
    failIterationHistory('iteration id and taskId must be non-empty');
  }
  if (!Number.isSafeInteger(next.contractVersion) || next.contractVersion < 1) {
    failIterationHistory(
      `iteration contractVersion must be a positive integer: ${next.contractVersion}`,
    );
  }
  if (!Number.isSafeInteger(next.ordinal) || next.ordinal < 1) {
    failIterationHistory(`iteration ordinal must be a positive integer: ${next.ordinal}`);
  }
  if (next.state !== 'planned' || next.endedAt !== null) {
    failIterationHistory('a newly appended iteration must be active in planned state');
  }
  if (history.some((iteration) => iteration.id === next.id)) {
    failIterationHistory(`iteration id ${next.id} already exists`);
  }

  if (history.length === 0) {
    if (next.ordinal !== 1 || next.supersedesIterationId !== null) {
      failIterationHistory('the first iteration must be ordinal 1 and supersede nothing');
    }
    return [next];
  }

  const latest = history[history.length - 1]!;
  if (next.taskId !== latest.taskId) {
    failIterationHistory('an iteration cannot change task identity');
  }
  if (next.ordinal !== latest.ordinal + 1) {
    failIterationHistory(`iteration ordinal must advance exactly to ${latest.ordinal + 1}`);
  }
  if (next.supersedesIterationId !== latest.id) {
    failIterationHistory(`iteration must supersede ${latest.id}`);
  }
  if (latest.state !== 'failed') {
    failIterationHistory('only a failed iteration can be superseded');
  }
  if (next.contractVersion < latest.contractVersion) {
    failIterationHistory('iteration contract version cannot move backwards');
  }
  return [...history, next];
}
