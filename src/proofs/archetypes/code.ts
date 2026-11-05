/**
 * Code / repository capability-proof archetype.
 *
 * Drives the shared engine chain with a two-receipt repair loop
 * (R1 fail → M9 repair → R2 pass), then assembles a CapabilityProofV1.
 */

import {
  assembleCapabilityProof,
  type CapabilityProofV1,
} from '../../domain/capabilityProof.js';
import { driveEngineChain } from '../engineChain.js';

export const CODE_ARCHETYPE_TASK_ID = 'task-1';
export const CODE_FAIL_ITERATION_ID = 'iteration-1';
export const CODE_FINAL_ITERATION_ID = 'iteration-2';

/**
 * Build the code-archetype proof: fail → route → repair → succeed,
 * `repairExercised: true`, `browserEvidenceRef: null`.
 */
export function buildCodeCapabilityProof(now: string): CapabilityProofV1 {
  const inputs = driveEngineChain(
    {
      archetype: 'code',
      taskId: CODE_ARCHETYPE_TASK_ID,
      finalIterationId: CODE_FINAL_ITERATION_ID,
      failIterationId: CODE_FAIL_ITERATION_ID,
      decisionAction: 'approve_outcome',
      requiresHumanDecision: true,
    },
    now,
  );
  return assembleCapabilityProof(inputs, now);
}

/** Expose the raw assembler inputs for anti-forgery / engine-driven tests. */
export function buildCodeCapabilityProofInputs(now: string) {
  return driveEngineChain(
    {
      archetype: 'code',
      taskId: CODE_ARCHETYPE_TASK_ID,
      finalIterationId: CODE_FINAL_ITERATION_ID,
      failIterationId: CODE_FAIL_ITERATION_ID,
      decisionAction: 'approve_outcome',
      requiresHumanDecision: true,
    },
    now,
  );
}
