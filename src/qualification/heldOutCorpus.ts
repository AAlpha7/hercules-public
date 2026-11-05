/**
 * M13 held-out corpus run — deterministic, engine-driven over the M12 spine.
 *
 * Each corpus case reuses `driveEngineChain` (real M6 → M8-bind → M9? → M10 →
 * M11) and records a sealed `HeldOutCaseResultV1`. Injected `now` only; no
 * wall-clock, no live worker/DB/browser.
 */

import {
  assertHeldOutCaseResultV1,
  computeHeldOutCaseResultHash,
  type HeldOutCaseResultV1,
} from '../domain/qualification.js';
import type { M6OutcomeDecision } from '../domain/reviewPackageV2.js';
import type { CapabilityArchetypeV1 } from '../domain/capabilityProof.js';
import { isCanonicalTimestamp } from '../domain/workerBoundary.js';
import { driveEngineChain } from '../proofs/engineChain.js';

export class QualificationHarnessError extends Error {
  override readonly name = 'QualificationHarnessError';

  constructor(message: string) {
    super(message);
  }
}

interface HeldOutCaseSeed {
  readonly caseId: string;
  readonly archetype: CapabilityArchetypeV1;
  readonly taskId: string;
  readonly finalIterationId: string;
  readonly failIterationId?: string;
  readonly decisionAction: M6OutcomeDecision;
  readonly requiresHumanDecision?: boolean;
}

/**
 * Fixed held-out corpus cases (M0 IDs). At least three; each drives the real
 * engine chain over a distinct spine identity.
 */
const HELD_OUT_CASE_SEEDS: readonly HeldOutCaseSeed[] = [
  {
    // Small repository bug fix — code archetype with repair loop.
    caseId: 'H2V1-HO-001',
    archetype: 'code',
    taskId: 'heldout-ho-001',
    finalIterationId: 'iteration-2',
    failIterationId: 'iteration-1',
    decisionAction: 'approve_outcome',
    requiresHumanDecision: true,
  },
  {
    // Browser/UI behavior change — browser-surface evidence required.
    caseId: 'H2V1-HO-003',
    archetype: 'browser',
    taskId: 'heldout-ho-003',
    finalIterationId: 'iteration-1',
    decisionAction: 'approve_outcome',
    requiresHumanDecision: true,
  },
  {
    // Correct no-file-change / bounded non-code task.
    caseId: 'H2V1-HO-009',
    archetype: 'bounded_non_code',
    taskId: 'heldout-ho-009',
    finalIterationId: 'iteration-1',
    decisionAction: 'request_changes',
  },
];

function assertInjectedNow(now: string): void {
  if (!isCanonicalTimestamp(now)) {
    throw new QualificationHarnessError(
      'injected now must be a canonical UTC-Z timestamp',
    );
  }
}

function runOneCase(seed: HeldOutCaseSeed, now: string): HeldOutCaseResultV1 {
  const chain = driveEngineChain(
    {
      archetype: seed.archetype,
      taskId: seed.taskId,
      finalIterationId: seed.finalIterationId,
      ...(seed.failIterationId !== undefined
        ? { failIterationId: seed.failIterationId }
        : {}),
      decisionAction: seed.decisionAction,
      ...(seed.requiresHumanDecision !== undefined
        ? { requiresHumanDecision: seed.requiresHumanDecision }
        : {}),
    },
    now,
  );

  const decisionPayload = chain.controlDecisionRequest.payload;
  if (
    !('kind' in decisionPayload) ||
    decisionPayload.kind !== 'decision'
  ) {
    throw new QualificationHarnessError(
      `held-out case ${seed.caseId}: M11 decision payload kind must be 'decision'`,
    );
  }
  const outcomeDecision = decisionPayload.action;
  if (!chain.reviewPackage.validDecisions.includes(outcomeDecision)) {
    throw new QualificationHarnessError(
      `held-out case ${seed.caseId}: outcomeDecision '${outcomeDecision}' not in M6 validDecisions`,
    );
  }
  if (chain.controlDecisionVerdict.schema !== 'hercules-control-api-admit-verdict/v2') {
    throw new QualificationHarnessError(
      `held-out case ${seed.caseId}: M11 decision was not admitted`,
    );
  }

  const withoutHash: Omit<HeldOutCaseResultV1, 'resultHash'> = {
    caseId: seed.caseId,
    taskContractHash: chain.contract.contractHash,
    outcomeDecision,
    evidenceManifestHash: chain.evidenceManifest.manifestHash,
  };
  const result: HeldOutCaseResultV1 = {
    ...withoutHash,
    resultHash: computeHeldOutCaseResultHash(withoutHash),
  };
  assertHeldOutCaseResultV1(result);
  return result;
}

/**
 * Run the fixed held-out corpus through the real M2–M12 engines.
 * Deterministic for a fixed injected `now`.
 */
export function runHeldOutCorpus(now: string): readonly HeldOutCaseResultV1[] {
  assertInjectedNow(now);
  const results = HELD_OUT_CASE_SEEDS.map((seed) => runOneCase(seed, now));
  return Object.freeze(results);
}
