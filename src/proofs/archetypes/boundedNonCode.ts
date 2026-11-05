/**
 * Bounded non-code / file-information capability-proof archetype.
 *
 * Same engine chain as code, without repair; distinct taskId; no browser evidence.
 */

import {
  assembleCapabilityProof,
  type CapabilityProofV1,
} from '../../domain/capabilityProof.js';
import { driveEngineChain } from '../engineChain.js';

export const BOUNDED_NON_CODE_TASK_ID = 'task-2';
export const BOUNDED_NON_CODE_ITERATION_ID = 'iteration-1';

/**
 * Build the bounded-non-code archetype proof: no repair,
 * `browserEvidenceRef: null`, distinct taskId from the code archetype.
 */
export function buildBoundedNonCodeCapabilityProof(
  now: string,
): CapabilityProofV1 {
  const inputs = driveEngineChain(
    {
      archetype: 'bounded_non_code',
      taskId: BOUNDED_NON_CODE_TASK_ID,
      finalIterationId: BOUNDED_NON_CODE_ITERATION_ID,
      decisionAction: 'approve_outcome',
      requiresHumanDecision: true,
    },
    now,
  );
  return assembleCapabilityProof(inputs, now);
}

/** Expose the raw assembler inputs for engine-driven / determinism tests. */
export function buildBoundedNonCodeCapabilityProofInputs(now: string) {
  return driveEngineChain(
    {
      archetype: 'bounded_non_code',
      taskId: BOUNDED_NON_CODE_TASK_ID,
      finalIterationId: BOUNDED_NON_CODE_ITERATION_ID,
      decisionAction: 'approve_outcome',
      requiresHumanDecision: true,
    },
    now,
  );
}
