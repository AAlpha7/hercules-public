import {
  isNonEmptyString,
  isNullableNonEmptyString,
  isRecord,
  isUniqueStringArray,
  V2InvariantError,
} from './v2Invariant.js';

export const STAGE_TYPES = [
  'recon',
  'plan',
  'design_review',
  'implement',
  'verify',
  'evaluate',
  'deploy',
  'learn',
] as const;

export type StageType = (typeof STAGE_TYPES)[number];

export const STAGE_RUN_STATES = [
  'queued',
  'leased',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export type StageRunState = (typeof STAGE_RUN_STATES)[number];

export const FAILURE_CLASSES = [
  'implementation_defect',
  'design_defect',
  'contract_ambiguity',
  'missing_evidence',
  'verification_environment',
  'verification_flake',
  'evaluator_infrastructure',
  'policy_denial',
  'permission_missing',
  'external_dependency',
  'budget_exceeded',
  'stale_candidate',
  'artifact_integrity',
  'platform_bug',
  'platform_capability_gap',
  'platform_limit',
  'human_rejection',
  'cancelled',
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

export interface StageRun {
  readonly id: string;
  readonly iterationId: string;
  readonly type: StageType;
  readonly attempt: number;
  readonly state: StageRunState;
  readonly jobSpecHash: string;
  readonly workerId: string | null;
  readonly agentRunIds: readonly string[];
  readonly inputArtifactRefs: readonly string[];
  readonly outputArtifactRefs: readonly string[];
  readonly structuredResult: unknown;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly failureClass: FailureClass | null;
}

export interface StageExecutionFacts {
  readonly agentRunIds: readonly string[];
  readonly outputArtifactRefs: readonly string[];
  readonly structuredResult: unknown;
}

const ALLOWED_STAGE_TRANSITIONS: Readonly<Record<StageRunState, readonly StageRunState[]>> = {
  queued: ['leased', 'cancelled'],
  leased: ['running', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

function stageTimingIssue(
  run: Pick<StageRun, 'state' | 'startedAt' | 'endedAt' | 'failureClass'>,
): string | null {
  if (
    !isNullableNonEmptyString(run.startedAt) ||
    !isNullableNonEmptyString(run.endedAt)
  ) {
    return 'stage timestamps must be null or non-empty strings';
  }
  const terminal = run.state === 'succeeded' || run.state === 'failed' || run.state === 'cancelled';
  if (terminal !== (run.endedAt !== null)) {
    return 'stage state and endedAt are inconsistent';
  }
  if ((run.state === 'queued' || run.state === 'leased') && run.startedAt !== null) {
    return `${run.state} stage cannot have startedAt`;
  }
  if (
    (run.state === 'running' || run.state === 'succeeded' || run.state === 'failed') &&
    run.startedAt === null
  ) {
    return `${run.state} stage requires startedAt`;
  }
  if (run.state === 'failed' && run.failureClass === null) {
    return 'failed stage requires failureClass';
  }
  if (run.state !== 'failed' && run.failureClass !== null) {
    return 'only a failed stage can carry failureClass';
  }
  return null;
}

function stageRecordIssue(run: StageRun): string | null {
  if (!isRecord(run)) {
    return 'stage record must be an object';
  }
  if (
    !(STAGE_TYPES as readonly unknown[]).includes(run.type) ||
    !(STAGE_RUN_STATES as readonly unknown[]).includes(run.state) ||
    !isNonEmptyString(run.id) ||
    !isNonEmptyString(run.iterationId) ||
    !isNonEmptyString(run.jobSpecHash) ||
    !isNullableNonEmptyString(run.workerId) ||
    !isUniqueStringArray(run.agentRunIds) ||
    !isUniqueStringArray(run.inputArtifactRefs) ||
    !isUniqueStringArray(run.outputArtifactRefs) ||
    !Number.isSafeInteger(run.attempt) ||
    run.attempt < 1
  ) {
    return 'stage identity and attempt must be valid';
  }
  if (
    run.failureClass !== null &&
    !(FAILURE_CLASSES as readonly unknown[]).includes(run.failureClass)
  ) {
    return 'stage failureClass must use the closed failure taxonomy';
  }
  const timingIssue = stageTimingIssue(run);
  if (timingIssue !== null) return timingIssue;
  if (run.state === 'queued' && run.workerId !== null) {
    return 'queued stage cannot carry worker identity';
  }
  if (
    (run.state === 'leased' ||
      run.state === 'running' ||
      run.state === 'succeeded' ||
      run.state === 'failed') &&
    run.workerId === null
  ) {
    return `${run.state} stage requires worker identity`;
  }
  if (
    (run.state === 'queued' || run.state === 'leased') &&
    (run.agentRunIds.length > 0 ||
      run.outputArtifactRefs.length > 0 ||
      run.structuredResult !== null)
  ) {
    return `${run.state} stage cannot carry future execution or result facts`;
  }
  if (
    run.state === 'running' &&
    (run.outputArtifactRefs.length > 0 || run.structuredResult !== null)
  ) {
    return 'running stage cannot carry terminal result facts';
  }
  if (run.state === 'cancelled') {
    const hasExecutionOrResult =
      run.agentRunIds.length > 0 ||
      run.outputArtifactRefs.length > 0 ||
      run.structuredResult !== null;
    if (
      run.workerId === null &&
      (run.startedAt !== null || hasExecutionOrResult)
    ) {
      return 'cancelled stage without a worker cannot carry start, execution, or result facts';
    }
    if (run.startedAt === null && hasExecutionOrResult) {
      return 'cancelled unstarted stage cannot carry execution or result facts';
    }
  }
  return null;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function extendsStringArray(previous: readonly string[], next: readonly string[]): boolean {
  return (
    next.length >= previous.length &&
    previous.every((value, index) => value === next[index])
  );
}

export function canTransitionStageRun(from: StageRunState, to: StageRunState): boolean {
  if (
    !(STAGE_RUN_STATES as readonly unknown[]).includes(from) ||
    !(STAGE_RUN_STATES as readonly unknown[]).includes(to)
  ) {
    return false;
  }
  const allowed = ALLOWED_STAGE_TRANSITIONS[from] as readonly StageRunState[] | undefined;
  return from === to || allowed?.includes(to) === true;
}

export function transitionStageRun(
  run: StageRun,
  state: StageRunState,
  timing: { readonly startedAt: string | null; readonly endedAt: string | null },
  failureClass: FailureClass | null,
  workerId: string | null =
    isRecord(run) && isNullableNonEmptyString(run.workerId) ? run.workerId : null,
  executionFacts: StageExecutionFacts = isRecord(run)
    ? {
        agentRunIds: run.agentRunIds,
        outputArtifactRefs: run.outputArtifactRefs,
        structuredResult: run.structuredResult,
      }
    : { agentRunIds: [], outputArtifactRefs: [], structuredResult: null },
): StageRun {
  const sourceIssue = stageRecordIssue(run);
  if (sourceIssue !== null) {
    throw new V2InvariantError(
      'invalid_stage_transition',
      `source stage record is invalid: ${sourceIssue}`,
    );
  }
  if (!isRecord(timing)) {
    throw new V2InvariantError(
      'invalid_stage_transition',
      'stage transition timing must be an object',
    );
  }
  if (!isRecord(executionFacts)) {
    throw new V2InvariantError(
      'invalid_stage_transition',
      'stage transition execution facts must be an object',
    );
  }
  if (
    !isUniqueStringArray(executionFacts.agentRunIds) ||
    !isUniqueStringArray(executionFacts.outputArtifactRefs)
  ) {
    throw new V2InvariantError(
      'invalid_stage_transition',
      'stage transition execution references must be unique non-empty strings',
    );
  }
  if (!canTransitionStageRun(run.state, state)) {
    throw new V2InvariantError(
      'invalid_stage_transition',
      `illegal stage transition: ${run.state} -> ${state}`,
    );
  }
  if (
    failureClass !== null &&
    !(FAILURE_CLASSES as readonly unknown[]).includes(failureClass)
  ) {
    throw new V2InvariantError(
      'invalid_stage_transition',
      'failureClass must use the closed failure taxonomy',
    );
  }
  if (state === run.state) {
    if (
      timing.startedAt !== run.startedAt ||
      timing.endedAt !== run.endedAt ||
      failureClass !== run.failureClass ||
      workerId !== run.workerId ||
      !sameStringArray(executionFacts.agentRunIds, run.agentRunIds) ||
      !sameStringArray(executionFacts.outputArtifactRefs, run.outputArtifactRefs) ||
      executionFacts.structuredResult !== run.structuredResult
    ) {
      throw new V2InvariantError(
        'invalid_stage_transition',
        'an idempotent stage transition cannot rewrite timing or failure facts',
      );
    }
    return run;
  }
  if (run.workerId !== null && workerId !== run.workerId) {
    throw new V2InvariantError(
      'invalid_stage_transition',
      'a stage transition cannot rewrite worker identity',
    );
  }
  if (
    run.workerId === null &&
    workerId !== null &&
    !(run.state === 'queued' && state === 'leased')
  ) {
    throw new V2InvariantError(
      'invalid_stage_transition',
      'only a queued-to-leased transition can establish worker identity',
    );
  }
  const terminal = state === 'succeeded' || state === 'failed' || state === 'cancelled';
  const agentRunsChanged = !sameStringArray(executionFacts.agentRunIds, run.agentRunIds);
  const agentChangeAllowed =
    (run.state === 'leased' && state === 'running') ||
    (run.state === 'running' && terminal);
  const resultChanged =
    !sameStringArray(executionFacts.outputArtifactRefs, run.outputArtifactRefs) ||
    executionFacts.structuredResult !== run.structuredResult;
  if (
    agentRunsChanged &&
    (!agentChangeAllowed ||
      !extendsStringArray(run.agentRunIds, executionFacts.agentRunIds))
  ) {
    throw new V2InvariantError(
      'invalid_stage_transition',
      'agent run identities can only append when execution starts or terminates',
    );
  }
  if (resultChanged && !(run.state === 'running' && terminal)) {
    throw new V2InvariantError(
      'invalid_stage_transition',
      'only a running-to-terminal transition can introduce result facts',
    );
  }
  const target = {
    ...run,
    state,
    ...timing,
    failureClass,
    workerId,
    ...executionFacts,
  };
  const targetIssue = stageRecordIssue(target);
  if (targetIssue !== null) {
    throw new V2InvariantError('invalid_stage_transition', targetIssue);
  }
  if (run.state === 'running' && timing.startedAt !== run.startedAt) {
    throw new V2InvariantError(
      'invalid_stage_transition',
      'a terminal transition cannot rewrite the running stage startedAt',
    );
  }
  if (
    run.state !== 'running' &&
    state !== 'running' &&
    timing.startedAt !== run.startedAt
  ) {
    throw new V2InvariantError(
      'invalid_stage_transition',
      'a non-running transition cannot introduce or rewrite startedAt',
    );
  }
  return target;
}

function failStageHistory(message: string): never {
  throw new V2InvariantError('invalid_stage_history', message);
}

function assertStageHistory(history: readonly StageRun[]): void {
  if (!Array.isArray(history)) {
    failStageHistory('stage history must be an array');
  }
  const ids = new Set<string>();
  const latestByStage = new Map<string, StageRun>();
  for (const run of history) {
    const recordIssue = stageRecordIssue(run);
    if (recordIssue !== null) failStageHistory(`stage history is invalid: ${recordIssue}`);
    if (ids.has(run.id)) failStageHistory(`stage id ${run.id} already exists`);

    const key = `${run.iterationId}\u0000${run.type}`;
    const previous = latestByStage.get(key);
    const expectedAttempt = previous === undefined ? 1 : previous.attempt + 1;
    if (run.attempt !== expectedAttempt) {
      failStageHistory(`stage history must be contiguous at attempt ${expectedAttempt}`);
    }
    if (
      previous !== undefined &&
      previous.state !== 'failed' &&
      previous.state !== 'cancelled'
    ) {
      failStageHistory('only a failed or cancelled stage can have another attempt');
    }
    ids.add(run.id);
    latestByStage.set(key, run);
  }
}

/** Append a stage attempt without replacing any prior attempt record. */
export function appendStageAttempt(
  history: readonly StageRun[],
  next: StageRun,
): readonly StageRun[] {
  assertStageHistory(history);
  const nextIssue = stageRecordIssue(next);
  if (nextIssue !== null) failStageHistory(`new stage attempt is invalid: ${nextIssue}`);
  if (next.id.length === 0 || next.iterationId.length === 0 || next.jobSpecHash.length === 0) {
    failStageHistory('stage id, iterationId, and jobSpecHash must be non-empty');
  }
  if (!Number.isSafeInteger(next.attempt) || next.attempt < 1) {
    failStageHistory(`stage attempt must be a positive integer: ${next.attempt}`);
  }
  if (
    next.state !== 'queued' ||
    next.workerId !== null ||
    next.agentRunIds.length > 0 ||
    next.outputArtifactRefs.length > 0 ||
    next.structuredResult !== null ||
    next.startedAt !== null ||
    next.endedAt !== null ||
    next.failureClass !== null
  ) {
    failStageHistory('a newly appended stage attempt must be an unstarted queued record');
  }
  if (history.some((run) => run.id === next.id)) {
    failStageHistory(`stage id ${next.id} already exists`);
  }

  const sameStage = history.filter(
    (run) => run.iterationId === next.iterationId && run.type === next.type,
  );
  if (sameStage.length === 0) {
    if (next.attempt !== 1) failStageHistory('the first stage attempt must be attempt 1');
    return [...history, next];
  }

  const latest = sameStage[sameStage.length - 1]!;
  if (sameStage.some((run) => run.attempt === next.attempt)) {
    failStageHistory(`stage attempt ${next.attempt} already exists`);
  }
  if (next.attempt !== latest.attempt + 1) {
    failStageHistory(`stage attempt must advance exactly to ${latest.attempt + 1}`);
  }
  if (latest.state !== 'failed' && latest.state !== 'cancelled') {
    failStageHistory('only a failed or cancelled stage can have another attempt');
  }
  return [...history, next];
}
