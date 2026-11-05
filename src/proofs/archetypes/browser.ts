/**
 * Browser / user-surface capability-proof archetype.
 *
 * Same real M6/M9/M10/M11 engine chain as the other archetypes, without repair;
 * distinct taskId; binds a self-seeded genuine browser-surface artifact (a DOM
 * snapshot, distinct mediaType/surface/digest from the code/non-code evidence)
 * through the M6 evidence projection (browserEvidenceRef non-null, a member of
 * the spine-bound M5 manifest whose digest matches the projection). Owner
 * decision m12-browser-evidence-seeding — the L2-gated M7 provider is not wired.
 */

import {
  assembleCapabilityProof,
  type CapabilityProofV1,
} from '../../domain/capabilityProof.js';
import { driveEngineChain } from '../engineChain.js';

export const BROWSER_ARCHETYPE_TASK_ID = 'task-3';
export const BROWSER_ITERATION_ID = 'iteration-1';

/**
 * Build the browser archetype proof: no repair, `browserEvidenceRef` non-null,
 * distinct taskId from the code and bounded-non-code archetypes.
 */
export function buildBrowserCapabilityProof(now: string): CapabilityProofV1 {
  return assembleCapabilityProof(buildBrowserCapabilityProofInputs(now), now);
}

/** Expose the raw assembler inputs for engine-driven / determinism tests. */
export function buildBrowserCapabilityProofInputs(now: string) {
  return driveEngineChain(
    {
      archetype: 'browser',
      taskId: BROWSER_ARCHETYPE_TASK_ID,
      finalIterationId: BROWSER_ITERATION_ID,
      decisionAction: 'approve_outcome',
      requiresHumanDecision: true,
    },
    now,
  );
}
