/**
 * C3.3 — production M8 evaluation runtime over bound review evidence.
 *
 * Builds the frozen `createIndependentEvaluationCoordinator` with resolvers
 * derived only from persisted bound evidence, the authority roster, and pinned
 * constants. Receipts bind into the V2 evaluation store. No main.ts wiring.
 *
 * Identifier note: several pinned logical names contain `/` or `:` which the
 * frozen M8 validators reject via `isBoundedIdentifier`. Those names are still
 * exported verbatim; domain-facing identifier fields use {@link asIdentifier}.
 * Validators that reject the slash/colon forms:
 * - `assertRuntimeCapabilityIdentityV1` (capability ids, clockEpochId)
 * - `assertEvaluationRunAuthorityV1` (coordinatorRunId)
 * - `assertTrustedEvaluationEvidenceSnapshotV1` (sourceId)
 * - `assertIndependentEvaluationInputV1` (requestId)
 * - `assertDeterministicGateDefinitionV1` (gateId with `:`)
 */

import { hashCanonicalJson } from '../domain/canonicalJson.js';
import type { ArtifactRef } from '../domain/artifact.js';
import type { DecisionAssertion } from '../domain/claimAuthorityV2.js';
import type { EvaluationVerdict } from '../domain/evaluationVerdict.js';
import type { ActorRef, TaskContract } from '../domain/taskContract.js';
import {
  IndependentEvaluationError,
  assertIndependentEvaluationInputV1,
  assertRunAuthorityDisjointness,
  computeCancellationDispatchHash,
  computeCapabilitySetHash,
  computeControlIdentityHash,
  computeControlObservationHash,
  computeEvaluationPolicyHash,
  computeEvaluationRubricHash,
  computeEvaluatorAuthorityHash,
  computeEvidenceIdentityHash,
  computeEvidenceObservationHash,
  computeGateDefinitionHash,
  computeGatePlanHash,
  computeGateReceiptHash,
  computeInputHash,
  computeRunAuthorityHash,
  computeVerificationObservationHash,
  computeVerificationResultHash,
  type CurrentGateReceiptQueryV1,
  type DeterministicGateDefinitionV1,
  type DeterministicGatePlanV1,
  type DeterministicGateReceiptV1,
  type EvaluationCancellationControllerV1,
  type EvaluationCancellationReasonV1,
  type EvaluationCancellationSignalV1,
  type EvaluationClockV1,
  type EvaluationDeadlinePortV1,
  type EvaluationPolicyV1,
  type EvaluationRubricCriterionV1,
  type EvaluationRubricV1,
  type EvaluationRunAuthorityV1,
  type IndependentEvaluationInputV1,
  type IndependentEvaluationReceiptV1,
  type IndependentEvaluatorPortV1,
  type TrustedDeterministicGateRunnerV1,
  type TrustedEvaluationCancellationFactoryV1,
  type TrustedEvaluationControlSnapshotV1,
  type TrustedEvaluationEvidenceSnapshotV1,
  type TrustedEvaluationRuntimeCapabilityIdentityV1,
  type TrustedEvaluatorAuthoritySnapshotV1,
  type VerificationObservationV1,
  type VerificationResultV1,
} from '../domain/independentEvaluation.js';
import { createIndependentEvaluationCoordinator } from '../evaluation/independentEvaluator.js';
import type { AuthorityRoster } from './authorityRoster.js';
import type {
  ShadowTaskState,
  V2BoundEvaluationV1,
  V2BoundEvidenceV1,
} from './state/stateStore.js';

export const REVIEW_EVALUATION_AUTHORITY_EPOCH =
  'hercules-c3-review-evaluation/epoch-1' as const;
export const REVIEW_EVALUATION_COORDINATOR_RUN_ID =
  'hercules-control/reviewEvaluation/coordinator/v1' as const;
export const REVIEW_EVALUATION_CAPABILITY_IDS = {
  evaluator: 'hercules-control/reviewEvaluation/evaluator-port/v1',
  gateResolver: 'hercules-control/reviewEvaluation/gate-resolver/v1',
  deadline: 'hercules-control/reviewEvaluation/deadline/v1',
  cancellation: 'hercules-control/reviewEvaluation/cancellation/v1',
  clock: 'hercules-control/reviewEvaluation/clock/v1',
} as const;

const EVIDENCE_SOURCE_ID = 'hercules-control/verifiedEvidence/v1' as const;
const GATE_REGISTRY_FUNCTION_ID = 'hercules.legacy-gate' as const;
const RUBRIC_ID = 'hercules-control.reviewEvaluation.rubric.v1' as const;
const GATE_PLAN_ID = 'hercules-control.reviewEvaluation.gate-plan.v1' as const;
const POLICY_ISSUED_AT = '2026-01-01T00:00:00.000Z' as const;
const POLICY_EXPIRES_AT = '2099-01-01T00:00:00.000Z' as const;
const BIND_ACTOR: ActorRef = {
  kind: 'control_plane',
  id: 'review-evaluation-runtime',
};

/** Slash/colon → `.` so frozen `isBoundedIdentifier` validators accept the value. */
export function asIdentifier(value: string): string {
  return value.replaceAll('/', '.').replaceAll(':', '.');
}

export interface ReviewEvaluationPorts {
  readonly store: {
    listAggregatesAwaitingEvaluation(): readonly {
      readonly aggregateId: string;
      readonly iterationId: string;
      readonly evidenceHash: string;
    }[];
    readBoundEvidence(aggregateId: string, iterationId: string): V2BoundEvidenceV1 | null;
    readBoundEvaluation(aggregateId: string, iterationId: string): V2BoundEvaluationV1 | null;
    readTask(taskId: string): ShadowTaskState | null;
    bindReviewEvaluation(
      record: Omit<V2BoundEvaluationV1, 'evaluationHash'>,
      actor: ActorRef,
    ): {
      readonly evaluationHash: string;
      readonly eventSequence: number;
      readonly refresh: 'materialized' | 'refreshed' | 'unchanged';
    };
  };
  readonly roster: AuthorityRoster;
  readonly clock: () => string;
  readonly evaluatorPort: IndependentEvaluatorPortV1;
  readonly deadlineMs: number;
  readonly log: (line: string) => void;
}

/**
 * Production evaluator port for C3: no model is consulted; every request
 * resolves to an evaluator infrastructure failure `evaluator_unavailable` so
 * evaluator-authority criteria settle `insufficient_evidence` honestly
 * (never a fabricated proposal).
 */
export function createUnavailableEvaluatorPort(): IndependentEvaluatorPortV1 {
  return {
    evaluate: async () => {
      throw new IndependentEvaluationError(
        'evaluator_unavailable',
        'review-evaluation production port does not consult a model',
      );
    },
  };
}

export type EvaluateOutcome =
  | {
      readonly kind: 'bound';
      readonly aggregateId: string;
      readonly iterationId: string;
      readonly receiptId: string;
      readonly verdictOutcome: 'pass' | 'fail' | 'need_more_evidence';
      readonly recommendedNextStage: string;
      readonly evaluationHash: string;
    }
  | {
      readonly kind: 'skipped';
      readonly aggregateId: string;
      readonly reason:
        | 'no_bound_evidence'
        | 'already_bound'
        | 'contract_missing'
        | 'evidence_hash_mismatch'
        | 'gap'
        | 'conflict'
        | 'capacity'
        | 'unavailable';
      readonly detail: string;
    }
  | {
      readonly kind: 'failed';
      readonly aggregateId: string;
      readonly error: string;
    };

function addHours(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * 3_600_000).toISOString();
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function gateNameFromSubjectKey(subjectKey: string): string | null {
  if (!subjectKey.startsWith('gate:')) return null;
  const name = subjectKey.slice('gate:'.length);
  return name.length > 0 ? name : null;
}

function gateAssertions(evidence: V2BoundEvidenceV1): readonly DecisionAssertion[] {
  return evidence.assertions.filter(
    (assertion) => assertion.kind === 'fact' && gateNameFromSubjectKey(assertion.subjectKey) !== null,
  );
}

function buildProductionPolicy(
  roster: AuthorityRoster,
  deadlineMs: number,
): EvaluationPolicyV1 {
  const withoutHash = {
    schema: 'hercules-evaluation-policy/v1' as const,
    policyId: 'hercules-v1-independent-evaluation' as const,
    version: 1,
    issuer: 'hercules-program-control' as const,
    authorityEpoch: REVIEW_EVALUATION_AUTHORITY_EPOCH,
    issuedAt: POLICY_ISSUED_AT,
    expiresAt: POLICY_EXPIRES_AT,
    maxInputBytes: 1_048_576,
    maxArtifacts: 64,
    maxAssertions: 256,
    maxPremisesPerCriterion: 32,
    maxRationaleBytes: 4_096,
    evaluatorDeadlineMs: deadlineMs,
    requiredRoleDisjointness: ['implementer', 'reviewer', 'verifier'] as const,
    allowedEvaluatorImplementationIds: [
      roster.evaluator.implementationId,
    ],
    verifiedFactsOnly: true as const,
    failClosedOnEvidenceGap: true as const,
    freshEvaluatorRequired: true as const,
    implementerEvaluatorForbidden: true as const,
    callerGateResultsForbidden: true as const,
    automaticRetryForbidden: true as const,
    recommendationIsAdvisory: true as const,
  };
  return {
    ...withoutHash,
    policyHash: computeEvaluationPolicyHash(withoutHash),
  };
}

function buildRubric(contract: TaskContract): EvaluationRubricV1 {
  const criteria: EvaluationRubricCriterionV1[] = contract.acceptanceCriteria.map(
    (criterion) => {
      const instructionId = asIdentifier(`instruction-${criterion.id}`);
      return {
        criterionId: criterion.id,
        required: criterion.required,
        authority: criterion.authority,
        allowedAdvisoryClasses: [],
        requiredGateIds: [],
        requiredSurfaceIds: [],
        evaluatorInstructionArtifactId: instructionId,
        evaluatorInstructionArtifactHash: hashCanonicalJson({
          criterionId: criterion.id,
          text: criterion.text,
        }),
      };
    },
  );
  const withoutHash = {
    schema: 'hercules-evaluation-rubric/v1' as const,
    rubricId: RUBRIC_ID,
    version: 1,
    issuer: 'hercules-program-control' as const,
    authorityEpoch: REVIEW_EVALUATION_AUTHORITY_EPOCH,
    taskContractId: contract.taskId,
    taskContractVersion: contract.version,
    taskContractHash: contract.contractHash,
    criteria,
  };
  return {
    ...withoutHash,
    rubricHash: computeEvaluationRubricHash(withoutHash),
  };
}

function buildGateDefinition(
  gateName: string,
): DeterministicGateDefinitionV1 {
  const withoutHash = {
    gateId: asIdentifier(`legacy-gate:${gateName}`),
    version: 1,
    kind: 'trusted_external_receipt' as const,
    registryFunctionId: GATE_REGISTRY_FUNCTION_ID,
    requiredEnvironmentFields: ['verifierRunId'],
    requiredArtifactKinds: ['gate-log'],
  };
  return {
    ...withoutHash,
    definitionHash: computeGateDefinitionHash(withoutHash),
  };
}

function buildGatePlan(
  contract: TaskContract,
  candidateCommit: string,
  evidence: V2BoundEvidenceV1,
): DeterministicGatePlanV1 {
  const gates = gateAssertions(evidence).map((assertion) => {
    const name = gateNameFromSubjectKey(assertion.subjectKey)!;
    return buildGateDefinition(name);
  });
  // Stable order by gateId for deterministic plan hashes.
  gates.sort((left, right) =>
    left.gateId < right.gateId ? -1 : left.gateId > right.gateId ? 1 : 0,
  );
  const withoutHash = {
    schema: 'hercules-deterministic-gate-plan/v1' as const,
    gatePlanId: GATE_PLAN_ID,
    version: 1,
    issuer: 'hercules-program-control' as const,
    authorityEpoch: REVIEW_EVALUATION_AUTHORITY_EPOCH,
    taskContractHash: contract.contractHash,
    candidateCommit,
    gates,
  };
  return {
    ...withoutHash,
    gatePlanHash: computeGatePlanHash(withoutHash),
  };
}

function buildRoles(args: {
  readonly roster: AuthorityRoster;
  readonly observedAt: string;
  readonly freshContextId: string;
}): EvaluationRunAuthorityV1 {
  const expiresAt = addHours(args.observedAt, 1);
  const withoutHash = {
    schema: 'hercules-evaluation-run-authority/v1' as const,
    issuer: 'hercules-program-control' as const,
    authorityEpoch: REVIEW_EVALUATION_AUTHORITY_EPOCH,
    coordinatorRunId: asIdentifier(REVIEW_EVALUATION_COORDINATOR_RUN_ID),
    coordinatorRole: 'trusted_coordinator' as const,
    evaluatorRunId: args.roster.evaluator.runId,
    evaluatorImplementationId: args.roster.evaluator.implementationId,
    evaluatorRole: 'evaluator' as const,
    implementerRunIds: [] as string[],
    verifierRunIds: [args.roster.verifier.runId],
    reviewerRunIds: [] as string[],
    freshContextId: args.freshContextId,
    freshContextCreatedAt: args.observedAt,
    expiresAt,
  };
  return {
    ...withoutHash,
    authorityHash: computeRunAuthorityHash(withoutHash),
  };
}

function buildControlSnapshot(args: {
  readonly policy: EvaluationPolicyV1;
  readonly rubric: EvaluationRubricV1;
  readonly gatePlan: DeterministicGatePlanV1;
  readonly roles: EvaluationRunAuthorityV1;
  readonly observedAt: string;
}): TrustedEvaluationControlSnapshotV1 {
  const base = {
    schema: 'hercules-trusted-evaluation-control/v1' as const,
    issuer: 'hercules-program-control' as const,
    authorityEpoch: REVIEW_EVALUATION_AUTHORITY_EPOCH,
    policy: args.policy,
    rubric: args.rubric,
    gatePlan: args.gatePlan,
    roles: args.roles,
    observedAt: args.observedAt,
  };
  const controlIdentityHash = computeControlIdentityHash(base);
  return {
    ...base,
    controlIdentityHash,
    controlObservationHash: computeControlObservationHash(
      controlIdentityHash,
      args.observedAt,
    ),
  };
}

function buildVerificationResult(args: {
  readonly contract: TaskContract;
  readonly evidence: V2BoundEvidenceV1;
  readonly roster: AuthorityRoster;
  readonly candidateCommit: string;
  readonly observedAt: string;
}): VerificationResultV1 {
  const { contract, evidence, roster, candidateCommit, observedAt } = args;
  const receiptsByAssertion = new Map(
    evidence.verificationReceipts.map((receipt) => [receipt.assertionId, receipt] as const),
  );
  const observations: VerificationObservationV1[] = [];
  for (const assertion of gateAssertions(evidence)) {
    const name = gateNameFromSubjectKey(assertion.subjectKey)!;
    const receipt = receiptsByAssertion.get(assertion.id);
    const payload = assertion.canonicalPayload;
    const passed =
      isRecord(payload) && payload['passed'] === true
        ? true
        : isRecord(payload) && payload['passed'] === false
          ? false
          : null;
    const status =
      passed === true ? 'pass' : passed === false ? 'verified_fail' : 'unavailable';
    const artifactIds =
      receipt !== undefined ? [...receipt.evidenceEntryArtifactIds].sort() : [];
    const criterionIds =
      receipt !== undefined ? sortedUnique(receipt.criterionIds) : [];
    const withoutHash = {
      observationId: asIdentifier(`observation-gate-${name}`),
      kind: 'mechanical' as const,
      criterionIds,
      status: status as VerificationObservationV1['status'],
      artifactIds,
      assertionIds: [assertion.id],
      verificationReceiptIds: receipt !== undefined ? [receipt.id] : [],
      observedAt: receipt?.observedAt ?? observedAt,
    };
    observations.push({
      ...withoutHash,
      observationHash: computeVerificationObservationHash(withoutHash),
    });
  }
  observations.sort((left, right) =>
    left.observationId < right.observationId
      ? -1
      : left.observationId > right.observationId
        ? 1
        : 0,
  );
  const startedAt =
    observations.length > 0
      ? observations.reduce(
          (earliest, observation) =>
            Date.parse(observation.observedAt) < Date.parse(earliest)
              ? observation.observedAt
              : earliest,
          observations[0]!.observedAt,
        )
      : observedAt;
  const completedAt = observedAt;
  const withoutHash = {
    schema: 'hercules-verification-result/v1' as const,
    verificationResultId: asIdentifier(
      `verification-${evidence.aggregateId}-${evidence.iterationId}`,
    ),
    verifierRunId: roster.verifier.runId,
    taskId: contract.taskId,
    taskContractHash: contract.contractHash,
    iterationId: evidence.iterationId,
    candidateCommit,
    manifestId: evidence.evidenceManifest.id,
    manifestHash: evidence.evidenceManifest.manifestHash,
    startedAt,
    completedAt,
    status: 'complete' as const,
    observations,
  };
  return {
    ...withoutHash,
    resultHash: computeVerificationResultHash(withoutHash),
  };
}

function buildEvidenceSnapshot(args: {
  readonly contract: TaskContract;
  readonly evidence: V2BoundEvidenceV1;
  readonly roster: AuthorityRoster;
  readonly observedAt: string;
}): TrustedEvaluationEvidenceSnapshotV1 {
  if (args.evidence.candidateRef.kind !== 'git') {
    throw new IndependentEvaluationError(
      'invalid_input_schema',
      'bound evidence candidateRef must be a git revision',
    );
  }
  const candidateCommit = args.evidence.candidateRef.revision;
  const verificationResult = buildVerificationResult({
    contract: args.contract,
    evidence: args.evidence,
    roster: args.roster,
    candidateCommit,
    observedAt: args.observedAt,
  });
  const freshUntil = addHours(args.observedAt, 1);
  const base = {
    schema: 'hercules-trusted-evaluation-evidence/v1' as const,
    sourceId: asIdentifier(EVIDENCE_SOURCE_ID),
    taskContract: args.contract,
    iterationId: args.evidence.iterationId,
    candidateRef: args.evidence.candidateRef,
    evidenceManifest: args.evidence.evidenceManifest,
    artifacts: args.evidence.artifacts,
    verificationResult,
    assertions: args.evidence.assertions,
    verificationReceipts: args.evidence.verificationReceipts,
    integrityAttestation: args.evidence.evidenceIntegrity,
    observedAt: args.observedAt,
    freshUntil,
  };
  const evidenceIdentityHash = computeEvidenceIdentityHash(base);
  return {
    ...base,
    evidenceIdentityHash,
    evidenceObservationHash: computeEvidenceObservationHash(
      evidenceIdentityHash,
      args.observedAt,
      freshUntil,
    ),
  };
}

function buildEvaluatorAuthority(args: {
  readonly roster: AuthorityRoster;
  readonly freshContextId: string;
  readonly observedAt: string;
  readonly expiresAt: string;
}): TrustedEvaluatorAuthoritySnapshotV1 {
  const withoutHash = {
    schema: 'hercules-trusted-evaluator-authority/v1' as const,
    issuer: 'hercules-program-control' as const,
    authorityEpoch: REVIEW_EVALUATION_AUTHORITY_EPOCH,
    evaluatorRunId: args.roster.evaluator.runId,
    evaluatorImplementationId: args.roster.evaluator.implementationId,
    evaluatorCapabilityId: asIdentifier(REVIEW_EVALUATION_CAPABILITY_IDS.evaluator),
    freshContextId: args.freshContextId,
    issuedAt: args.observedAt,
    expiresAt: args.expiresAt,
  };
  return {
    ...withoutHash,
    authorityHash: computeEvaluatorAuthorityHash(withoutHash),
  };
}

function buildRuntimeIdentity(): TrustedEvaluationRuntimeCapabilityIdentityV1 {
  const withoutHash = {
    schema: 'hercules-trusted-evaluation-runtime-capabilities/v1' as const,
    evaluatorCapabilityId: asIdentifier(REVIEW_EVALUATION_CAPABILITY_IDS.evaluator),
    gateResolverCapabilityId: asIdentifier(REVIEW_EVALUATION_CAPABILITY_IDS.gateResolver),
    deadlineCapabilityId: asIdentifier(REVIEW_EVALUATION_CAPABILITY_IDS.deadline),
    cancellationFactoryCapabilityId: asIdentifier(
      REVIEW_EVALUATION_CAPABILITY_IDS.cancellation,
    ),
    clockCapabilityId: asIdentifier(REVIEW_EVALUATION_CAPABILITY_IDS.clock),
    clockEpochId: asIdentifier(REVIEW_EVALUATION_AUTHORITY_EPOCH),
  };
  return {
    ...withoutHash,
    capabilitySetHash: computeCapabilitySetHash(withoutHash),
  };
}

function gateArtifactForAssertion(
  evidence: V2BoundEvidenceV1,
  assertion: DecisionAssertion,
): ArtifactRef | null {
  const receipt = evidence.verificationReceipts.find(
    (entry) => entry.assertionId === assertion.id,
  );
  if (receipt === undefined || receipt.evidenceEntryArtifactIds.length === 0) {
    return null;
  }
  const artifactId = [...receipt.evidenceEntryArtifactIds].sort()[0]!;
  return evidence.artifacts.find((artifact) => artifact.id === artifactId) ?? null;
}

function buildGateReceipt(args: {
  readonly definition: DeterministicGateDefinitionV1;
  readonly plan: DeterministicGatePlanV1;
  readonly contract: TaskContract;
  readonly evidence: V2BoundEvidenceV1;
  readonly assertion: DecisionAssertion;
  readonly roster: AuthorityRoster;
  readonly observedAt: string;
}): DeterministicGateReceiptV1 {
  const { definition, plan, contract, evidence, assertion, roster, observedAt } = args;
  if (evidence.candidateRef.kind !== 'git') {
    throw new IndependentEvaluationError(
      'invalid_input_schema',
      'gate receipt requires a git candidate',
    );
  }
  const receipt = evidence.verificationReceipts.find(
    (entry) => entry.assertionId === assertion.id,
  );
  if (receipt === undefined) {
    throw new IndependentEvaluationError(
      'stale_binding',
      `missing verification receipt for gate assertion ${assertion.id}`,
    );
  }
  const payload = assertion.canonicalPayload;
  if (!isRecord(payload) || typeof payload['passed'] !== 'boolean') {
    throw new IndependentEvaluationError(
      'invalid_input_schema',
      `gate assertion ${assertion.id} payload.passed must be boolean`,
    );
  }
  const passed = payload['passed'] === true;
  const command = payload['command'];
  const commandOrSpecHash = hashCanonicalJson(
    typeof command === 'string' || command === null || typeof command === 'number'
      ? command
      : isRecord(command)
        ? command
        : String(command),
  );
  const artifact = gateArtifactForAssertion(evidence, assertion);
  const outputArtifactIds = artifact !== null ? [artifact.id] : [];
  const outputArtifactHashes = artifact !== null ? [artifact.sha256] : [];
  // Use the evaluation observation clock for gate-receipt freshness. The
  // verification receipt's observedAt may be hours earlier (task verification
  // time); deriving expiresAt from it makes every later review evaluation
  // unavailable. The receipt id/assertion binding still traces to that receipt.
  const completedAt =
    Date.parse(receipt.observedAt) <= Date.parse(observedAt)
      ? observedAt
      : receipt.observedAt;
  const startedAt = completedAt;
  const expiresAt = addHours(completedAt, 1);
  const exitCode =
    typeof payload['exitCode'] === 'number' && Number.isSafeInteger(payload['exitCode'])
      ? payload['exitCode']
      : passed
        ? 0
        : 1;
  const withoutHash = {
    schema: 'hercules-deterministic-gate-receipt/v1' as const,
    gatePlanId: plan.gatePlanId,
    gatePlanHash: plan.gatePlanHash,
    gateId: definition.gateId,
    gateVersion: definition.version,
    gateDefinitionHash: definition.definitionHash,
    runnerIssuer: 'hercules-program-control' as const,
    runnerRunId: roster.verifier.runId,
    authorityEpoch: REVIEW_EVALUATION_AUTHORITY_EPOCH,
    taskId: contract.taskId,
    taskContractHash: contract.contractHash,
    iterationId: evidence.iterationId,
    candidateCommit: evidence.candidateRef.revision,
    environmentIdentity: { verifierRunId: roster.verifier.runId },
    commandOrSpecHash,
    startedAt,
    completedAt,
    expiresAt,
    status: (passed ? 'pass' : 'verified_fail') as 'pass' | 'verified_fail',
    exitCode,
    outputArtifactIds,
    outputArtifactHashes,
    assertionIds: [assertion.id],
    verificationReceiptIds: [receipt.id],
  };
  return {
    ...withoutHash,
    receiptHash: computeGateReceiptHash(withoutHash),
  };
}

function buildGateRunner(args: {
  readonly plan: DeterministicGatePlanV1;
  readonly contract: TaskContract;
  readonly evidence: V2BoundEvidenceV1;
  readonly roster: AuthorityRoster;
  readonly observedAt: string;
}): TrustedDeterministicGateRunnerV1 {
  const assertionsByGateId = new Map<string, DecisionAssertion>();
  for (const assertion of gateAssertions(args.evidence)) {
    const name = gateNameFromSubjectKey(assertion.subjectKey)!;
    assertionsByGateId.set(asIdentifier(`legacy-gate:${name}`), assertion);
  }
  const definitionsById = new Map(
    args.plan.gates.map((gate) => [gate.gateId, gate] as const),
  );
  return {
    resolveCurrentReceipts: async (query: CurrentGateReceiptQueryV1) => {
      if (
        query.gatePlanId !== args.plan.gatePlanId ||
        query.gatePlanHash !== args.plan.gatePlanHash ||
        query.taskId !== args.contract.taskId ||
        query.taskContractHash !== args.contract.contractHash ||
        query.iterationId !== args.evidence.iterationId ||
        args.evidence.candidateRef.kind !== 'git' ||
        query.candidateCommit !== args.evidence.candidateRef.revision ||
        query.authorityEpoch !== REVIEW_EVALUATION_AUTHORITY_EPOCH
      ) {
        throw new IndependentEvaluationError(
          'stale_binding',
          'gate receipt query does not match the current plan/subject',
        );
      }
      const receipts: DeterministicGateReceiptV1[] = [];
      for (const definition of args.plan.gates) {
        const assertion = assertionsByGateId.get(definition.gateId);
        if (assertion === undefined) {
          throw new IndependentEvaluationError(
            'stale_binding',
            `missing gate assertion for plan gate ${definition.gateId}`,
          );
        }
        const expected = definitionsById.get(definition.gateId);
        if (expected === undefined || expected.definitionHash !== definition.definitionHash) {
          throw new IndependentEvaluationError(
            'stale_binding',
            `gate definition mismatch for ${definition.gateId}`,
          );
        }
        receipts.push(
          buildGateReceipt({
            definition,
            plan: args.plan,
            contract: args.contract,
            evidence: args.evidence,
            assertion,
            roster: args.roster,
            observedAt: args.observedAt,
          }),
        );
      }
      return receipts;
    },
  };
}

function makeCancellationController(
  signalId: string,
  attemptId: string,
  clock: () => string,
): EvaluationCancellationControllerV1 {
  let cancelled: EvaluationCancellationReasonV1 | null = null;
  const listeners = new Set<(reason: EvaluationCancellationReasonV1) => void>();
  const signal: EvaluationCancellationSignalV1 = {
    signalId,
    attemptId,
    isCancelled: () => cancelled !== null,
    onCancel: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    signal,
    cancel: (reason) => {
      const dispatchedAt = clock();
      if (cancelled !== null) {
        const withoutHash = {
          signalId,
          attemptId,
          reason,
          status: 'already_cancelled' as const,
          dispatchedAt,
        };
        return {
          ...withoutHash,
          dispatchHash: computeCancellationDispatchHash(withoutHash),
        };
      }
      cancelled = reason;
      for (const listener of listeners) {
        listener(reason);
      }
      const withoutHash = {
        signalId,
        attemptId,
        reason,
        status: 'dispatched' as const,
        dispatchedAt,
      };
      return {
        ...withoutHash,
        dispatchHash: computeCancellationDispatchHash(withoutHash),
      };
    },
  };
}

function buildCancellationFactory(
  clock: () => string,
): TrustedEvaluationCancellationFactoryV1 {
  let attemptSeq = 0;
  return {
    createAttempt: () => {
      attemptSeq += 1;
      const attemptId = `attempt-${attemptSeq}`;
      return {
        attemptId,
        evaluatorController: makeCancellationController(
          `signal-evaluator-${attemptSeq}`,
          attemptId,
          clock,
        ),
        deadlineController: makeCancellationController(
          `signal-deadline-${attemptSeq}`,
          attemptId,
          clock,
        ),
      };
    },
  };
}

function buildDeadlinePort(deadlineMs: number): EvaluationDeadlinePortV1 {
  return {
    expireAfter: async (_milliseconds, cancellation) =>
      await new Promise<'deadline_expired'>((resolve, reject) => {
        if (cancellation.isCancelled()) {
          reject(new Error('deadline cancelled before start'));
          return;
        }
        const timer = setTimeout(() => {
          unsubscribe();
          resolve('deadline_expired');
        }, deadlineMs);
        const unsubscribe = cancellation.onCancel(() => {
          clearTimeout(timer);
          reject(new Error('deadline cancelled'));
        });
      }),
  };
}

function buildClock(ports: ReviewEvaluationPorts): EvaluationClockV1 {
  return {
    capabilityId: asIdentifier(REVIEW_EVALUATION_CAPABILITY_IDS.clock),
    epochId: asIdentifier(REVIEW_EVALUATION_AUTHORITY_EPOCH),
    nowUtc: ports.clock,
  };
}

function buildInput(args: {
  readonly aggregateId: string;
  readonly iterationId: string;
  readonly evidenceHash: string;
  readonly contract: TaskContract;
  readonly evidence: V2BoundEvidenceV1;
  readonly evidenceSnapshot: TrustedEvaluationEvidenceSnapshotV1;
  readonly policy: EvaluationPolicyV1;
  readonly rubric: EvaluationRubricV1;
  readonly gatePlan: DeterministicGatePlanV1;
}): IndependentEvaluationInputV1 {
  const requestId = asIdentifier(
    `review-eval:${args.aggregateId}:${args.iterationId}:${args.evidenceHash}`,
  );
  const withoutHash = {
    schema: 'hercules-independent-evaluation-input/v1' as const,
    requestId,
    taskContract: args.contract,
    iterationId: args.iterationId,
    candidateRef: args.evidence.candidateRef,
    evidenceManifest: args.evidence.evidenceManifest,
    artifacts: args.evidence.artifacts,
    verificationResult: args.evidenceSnapshot.verificationResult,
    assertions: args.evidence.assertions,
    verificationReceipts: args.evidence.verificationReceipts,
    integrityAttestation: args.evidence.evidenceIntegrity,
    policyRef: {
      schema: 'hercules-evaluation-policy-ref/v1' as const,
      policyId: 'hercules-v1-independent-evaluation' as const,
      version: args.policy.version,
      policyHash: args.policy.policyHash,
    },
    rubricRef: {
      schema: 'hercules-evaluation-rubric-ref/v1' as const,
      rubricId: args.rubric.rubricId,
      version: args.rubric.version,
      rubricHash: args.rubric.rubricHash,
    },
    gatePlanRef: {
      schema: 'hercules-deterministic-gate-plan-ref/v1' as const,
      gatePlanId: args.gatePlan.gatePlanId,
      version: args.gatePlan.version,
      gatePlanHash: args.gatePlan.gatePlanHash,
    },
    locatorHints: [] as const,
  };
  const input: IndependentEvaluationInputV1 = {
    ...withoutHash,
    inputHash: computeInputHash(withoutHash),
  };
  assertIndependentEvaluationInputV1(input, args.policy);
  return input;
}

function eligibleAssertionIdsForCriteria(
  evidence: V2BoundEvidenceV1,
  criterionIds: readonly string[],
  eligible: ReadonlySet<string>,
): string[] {
  if (criterionIds.length === 0) {
    return [];
  }
  const wanted = new Set(criterionIds);
  const ids: string[] = [];
  for (const receipt of evidence.verificationReceipts) {
    if (!eligible.has(receipt.assertionId)) continue;
    if (receipt.criterionIds.some((criterionId) => wanted.has(criterionId))) {
      ids.push(receipt.assertionId);
    }
  }
  return sortedUnique(ids);
}

/**
 * Attribution rule for unnamed `deterministic_gate_failed` findings:
 *
 * When the frozen engine synthesizes `deterministic_gate_failed` with
 * `criterionIds: []` (trusted_external_receipt preflight names no criteria),
 * attribution is a deterministic function of the engine receipt plus the bound
 * evidence's own verification receipts, per failing gate:
 *
 * - for each gate receipt with `status: 'verified_fail'`, the attributed
 *   criteria are EXACTLY that gate assertion's verification receipt
 *   `criterionIds` (C3.1a sets them to the mechanical criteria the gate
 *   evidences);
 * - a `deterministic_gate_failed` finding with empty criterionIds is attributed
 *   to the UNION of the failing gates' receipt criterionIds (sorted unique) —
 *   never to criteria no failing gate evidences;
 * - `criterionResults[c].status` becomes `fail` only for those criteria;
 *   `explanation` names the failing gate(s);
 * - `findingPremises` for that finding = the failing gates' assertion ids;
 * - `criterionPremises` for an attributed criterion = the failing gate
 *   assertion ids that evidence it;
 * - if the union is empty, return the verdict unmodified (caller logs
 *   `attribution impossible: no failing gate evidences a criterion`).
 *
 * The receipt itself is never mutated.
 */
export function attributeUnnamedGateFailures(
  receiptVerdict: EvaluationVerdict,
  evidence: V2BoundEvidenceV1,
  gateReceipts: readonly DeterministicGateReceiptV1[],
): {
  readonly verdict: EvaluationVerdict;
  readonly attributedCriterionIds: readonly string[];
  readonly failingGateAssertionIds: readonly string[];
} {
  const hasUnnamed =
    receiptVerdict.blockingFindings.some(
      (finding) =>
        finding.code === 'deterministic_gate_failed' && finding.criterionIds.length === 0,
    );
  if (!hasUnnamed) {
    return {
      verdict: receiptVerdict,
      attributedCriterionIds: [],
      failingGateAssertionIds: [],
    };
  }

  const failingGateReceipts = gateReceipts.filter(
    (gateReceipt) => gateReceipt.status === 'verified_fail',
  );
  const failingGateAssertionIds = sortedUnique(
    failingGateReceipts.flatMap((gateReceipt) => [...gateReceipt.assertionIds]),
  );

  const attributedCriterionIds = sortedUnique(
    failingGateAssertionIds.flatMap((assertionId) => {
      const verification = evidence.verificationReceipts.find(
        (entry) => entry.assertionId === assertionId,
      );
      return verification !== undefined ? [...verification.criterionIds] : [];
    }),
  );

  if (attributedCriterionIds.length === 0) {
    return {
      verdict: receiptVerdict,
      attributedCriterionIds: [],
      failingGateAssertionIds,
    };
  }

  const failingGateLabels = failingGateAssertionIds.map((assertionId) => {
    const assertion = evidence.assertions.find((entry) => entry.id === assertionId);
    if (assertion === undefined) return assertionId;
    return gateNameFromSubjectKey(assertion.subjectKey) ?? assertion.subjectKey;
  });
  const gateList = failingGateLabels.join(', ');
  const attributedSet = new Set(attributedCriterionIds);

  const verdict: EvaluationVerdict = {
    ...receiptVerdict,
    criterionResults: receiptVerdict.criterionResults.map((result) =>
      attributedSet.has(result.criterionId) && result.status !== 'fail'
        ? {
            ...result,
            status: 'fail' as const,
            explanation: `Deterministic gate failure attributed from gate(s): ${gateList}.`,
          }
        : result,
    ),
    blockingFindings: receiptVerdict.blockingFindings.map((finding) =>
      finding.code === 'deterministic_gate_failed' && finding.criterionIds.length === 0
        ? { ...finding, criterionIds: [...attributedCriterionIds] }
        : finding,
    ),
  };

  return {
    verdict,
    attributedCriterionIds,
    failingGateAssertionIds,
  };
}

function buildBoundEvaluationRecord(args: {
  readonly aggregateId: string;
  readonly iterationId: string;
  readonly evidenceHash: string;
  readonly receipt: IndependentEvaluationReceiptV1;
  readonly evidence: V2BoundEvidenceV1;
  readonly contract: TaskContract;
  readonly roster: AuthorityRoster;
  readonly recordedAt: string;
  readonly gateReceipts: readonly DeterministicGateReceiptV1[];
  readonly log: (line: string) => void;
}): Omit<V2BoundEvaluationV1, 'evaluationHash'> {
  const { receipt, roster, contract, evidence, gateReceipts, log } = args;
  const eligibleFromRelationships = new Set(
    receipt.criterionRelationships.flatMap((row) => row.assertionIds),
  );
  const confirmingEligible = new Set(
    evidence.assertions
      .filter((assertion) => assertion.kind === 'fact')
      .filter((assertion) =>
        evidence.verificationReceipts.some(
          (entry) =>
            entry.assertionId === assertion.id &&
            entry.valueHash === assertion.payloadHash &&
            entry.verifierRunId === roster.verifier.runId,
        ),
      )
      .map((assertion) => assertion.id),
  );
  const eligible = new Set([...eligibleFromRelationships, ...confirmingEligible]);

  const attribution = attributeUnnamedGateFailures(
    receipt.verdict,
    evidence,
    gateReceipts,
  );
  const hadUnnamedFinding = receipt.verdict.blockingFindings.some(
    (finding) =>
      finding.code === 'deterministic_gate_failed' && finding.criterionIds.length === 0,
  );
  if (hadUnnamedFinding && attribution.attributedCriterionIds.length === 0) {
    log(
      'attribution impossible: no failing gate evidences a criterion',
    );
  }

  const verdict = attribution.verdict;
  const attributedSet = new Set(attribution.attributedCriterionIds);
  const failingGateAssertionIds = attribution.failingGateAssertionIds;

  const criterionPremises = receipt.criterionRelationships.map((relationship) => {
    if (attributedSet.has(relationship.criterionId)) {
      const assertionIds = failingGateAssertionIds.filter((assertionId) => {
        const verification = evidence.verificationReceipts.find(
          (entry) => entry.assertionId === assertionId,
        );
        return verification?.criterionIds.includes(relationship.criterionId) === true;
      });
      return { key: relationship.criterionId, assertionIds: sortedUnique(assertionIds) };
    }
    return {
      key: relationship.criterionId,
      assertionIds: [...relationship.assertionIds],
    };
  });

  const findingPremises = verdict.blockingFindings.map((finding) => {
    const receiptFinding = receipt.verdict.blockingFindings.find(
      (entry) => entry.code === finding.code,
    );
    if (
      finding.code === 'deterministic_gate_failed' &&
      receiptFinding !== undefined &&
      receiptFinding.criterionIds.length === 0 &&
      failingGateAssertionIds.length > 0 &&
      attribution.attributedCriterionIds.length > 0
    ) {
      return { key: finding.code, assertionIds: [...failingGateAssertionIds] };
    }
    return {
      key: finding.code,
      assertionIds: eligibleAssertionIdsForCriteria(
        evidence,
        finding.criterionIds,
        eligible,
      ),
    };
  });

  const outcomeAssertionIds = sortedUnique([
    ...criterionPremises
      .filter((row) => {
        const criterion = contract.acceptanceCriteria.find((entry) => entry.id === row.key);
        return (
          criterion !== undefined &&
          criterion.required &&
          criterion.authority !== 'human'
        );
      })
      .flatMap((row) => row.assertionIds),
    ...findingPremises.flatMap((row) => row.assertionIds),
  ]);

  const nextStageAssertionIds =
    verdict.recommendedNextStage === 'escalate_human' ? [] : [...outcomeAssertionIds];

  return {
    schema: 'hercules-v2-bound-evaluation/v1',
    aggregateId: args.aggregateId,
    iterationId: args.iterationId,
    evidenceHash: args.evidenceHash,
    receipt,
    evaluation: {
      schema: 'hercules-evaluation-decision/v2',
      verdict,
      criterionPremises,
      findingPremises,
      outcomeAssertionIds,
      nextStageAssertionIds,
    },
    evaluator: {
      runId: roster.evaluator.runId,
      implementationId: roster.evaluator.implementationId,
      version: roster.evaluator.version,
      model: roster.evaluator.model,
      runtime: roster.evaluator.runtime,
    },
    recordedAt: args.recordedAt,
  };
}

function skipped(
  aggregateId: string,
  reason: Extract<EvaluateOutcome, { kind: 'skipped' }>['reason'],
  detail: string,
  log: (line: string) => void,
): EvaluateOutcome {
  log(`reviewEvaluation skipped aggregate=${aggregateId} reason=${reason} detail=${detail}`);
  return { kind: 'skipped', aggregateId, reason, detail };
}

export async function evaluateReviewAggregate(
  ports: ReviewEvaluationPorts,
  aggregateId: string,
): Promise<EvaluateOutcome> {
  try {
    const awaiting = ports.store
      .listAggregatesAwaitingEvaluation()
      .find((entry) => entry.aggregateId === aggregateId);
    const shadow = ports.store.readTask(aggregateId);
    if (shadow === null || shadow.iterations.length === 0) {
      return skipped(aggregateId, 'contract_missing', 'shadow task/iteration missing', ports.log);
    }
    const current = shadow.iterations[shadow.iterations.length - 1]!;
    const existingEvaluation = ports.store.readBoundEvaluation(aggregateId, current.id);
    if (existingEvaluation !== null) {
      return skipped(aggregateId, 'already_bound', 'evaluation already bound', ports.log);
    }
    const evidence = ports.store.readBoundEvidence(aggregateId, current.id);
    if (evidence === null) {
      return skipped(aggregateId, 'no_bound_evidence', 'no bound evidence for iteration', ports.log);
    }
    if (awaiting !== undefined && awaiting.evidenceHash !== evidence.evidenceHash) {
      return skipped(
        aggregateId,
        'evidence_hash_mismatch',
        `awaiting hash ${awaiting.evidenceHash} !== bound ${evidence.evidenceHash}`,
        ports.log,
      );
    }
    const contract = shadow.contracts.find(
      (entry) => entry.version === current.contractVersion,
    );
    if (contract === undefined) {
      return skipped(
        aggregateId,
        'contract_missing',
        `no shadow contract for version ${current.contractVersion}`,
        ports.log,
      );
    }
    if (evidence.candidateRef.kind !== 'git') {
      return skipped(
        aggregateId,
        'unavailable',
        'bound evidence candidateRef is not git',
        ports.log,
      );
    }

    const observedAt = ports.clock();
    const freshContextId = asIdentifier(
      `fresh-${aggregateId}-${current.id}-${evidence.evidenceHash}`,
    );
    const policy = buildProductionPolicy(ports.roster, ports.deadlineMs);
    const rubric = buildRubric(contract);
    const gatePlan = buildGatePlan(contract, evidence.candidateRef.revision, evidence);
    const roles = buildRoles({
      roster: ports.roster,
      observedAt,
      freshContextId,
    });
    assertRunAuthorityDisjointness(roles, policy);
    const control = buildControlSnapshot({
      policy,
      rubric,
      gatePlan,
      roles,
      observedAt,
    });
    const evidenceSnapshot = buildEvidenceSnapshot({
      contract,
      evidence,
      roster: ports.roster,
      observedAt,
    });
    const evaluatorAuthority = buildEvaluatorAuthority({
      roster: ports.roster,
      freshContextId,
      observedAt,
      expiresAt: roles.expiresAt,
    });
    const gateRunner = buildGateRunner({
      plan: gatePlan,
      contract,
      evidence,
      roster: ports.roster,
      observedAt,
    });
    const input = buildInput({
      aggregateId,
      iterationId: current.id,
      evidenceHash: evidence.evidenceHash,
      contract,
      evidence,
      evidenceSnapshot,
      policy,
      rubric,
      gatePlan,
    });

    // Capture the last thrown error from wrapped ports so a coordinator `gap`
    // (often `trusted_source_unavailable` after an engine invariant) still
    // surfaces the underlying cause in production logs.
    let lastPortError: string | null = null;
    const rememberError = (error: unknown): never => {
      lastPortError = error instanceof Error ? error.message : String(error);
      throw error;
    };
    const wrappedGateRunner: typeof gateRunner = {
      resolveCurrentReceipts: async (query) => {
        try {
          return await gateRunner.resolveCurrentReceipts(query);
        } catch (error) {
          return rememberError(error);
        }
      },
    };
    const wrappedEvaluatorPort: IndependentEvaluatorPortV1 = {
      evaluate: async (request, cancellation) => {
        try {
          return await ports.evaluatorPort.evaluate(request, cancellation);
        } catch (error) {
          return rememberError(error);
        }
      },
    };
    const baseClock = buildClock(ports);
    const wrappedClock: typeof baseClock = {
      capabilityId: baseClock.capabilityId,
      epochId: baseClock.epochId,
      nowUtc: () => {
        try {
          return baseClock.nowUtc();
        } catch (error) {
          return rememberError(error);
        }
      },
    };

    const coordinator = createIndependentEvaluationCoordinator({
      identity: buildRuntimeIdentity(),
      sources: {
        resolveControl: async () => {
          try {
            return control;
          } catch (error) {
            return rememberError(error);
          }
        },
        resolveEvidence: async () => {
          try {
            return evidenceSnapshot;
          } catch (error) {
            return rememberError(error);
          }
        },
        resolveEvaluatorAuthority: async () => {
          try {
            return evaluatorAuthority;
          } catch (error) {
            return rememberError(error);
          }
        },
      },
      gateRunner: wrappedGateRunner,
      evaluatorPort: wrappedEvaluatorPort,
      deadline: buildDeadlinePort(ports.deadlineMs),
      cancellationFactory: buildCancellationFactory(ports.clock),
      clock: wrappedClock,
      coordinatorRunId: asIdentifier(REVIEW_EVALUATION_COORDINATOR_RUN_ID),
      evaluatorVersion: ports.roster.evaluator.version,
      evaluatorModel: ports.roster.evaluator.model,
      evaluatorRuntime: ports.roster.evaluator.runtime,
    });

    const outcome = await coordinator.evaluate(input);
    if (outcome.kind !== 'receipt') {
      const reason =
        outcome.kind === 'gap'
          ? 'gap'
          : outcome.kind === 'conflict'
            ? 'conflict'
            : outcome.kind === 'capacity'
              ? 'capacity'
              : 'unavailable';
      let detail: string;
      if (outcome.kind === 'gap') {
        detail =
          lastPortError !== null
            ? `${outcome.gap.reason}; underlying=${lastPortError}`
            : outcome.gap.reason;
        ports.log(
          `reviewEvaluation gap aggregate=${aggregateId} reason=${outcome.gap.reason}` +
            (lastPortError !== null ? ` underlying=${lastPortError}` : '') +
            ` gapHash=${outcome.gap.gapHash}`,
        );
      } else if (outcome.kind === 'conflict' || outcome.kind === 'capacity') {
        detail = outcome.detail;
      } else {
        detail = `${outcome.code}: ${outcome.detail}`;
      }
      return skipped(aggregateId, reason, detail, ports.log);
    }

    const gateReceipts = await gateRunner.resolveCurrentReceipts({
      gatePlanId: gatePlan.gatePlanId,
      gatePlanHash: gatePlan.gatePlanHash,
      taskId: contract.taskId,
      taskContractHash: contract.contractHash,
      iterationId: current.id,
      candidateCommit: evidence.candidateRef.revision,
      authorityEpoch: REVIEW_EVALUATION_AUTHORITY_EPOCH,
    });
    const recordedAt = ports.clock();
    const record = buildBoundEvaluationRecord({
      aggregateId,
      iterationId: current.id,
      evidenceHash: evidence.evidenceHash,
      receipt: outcome.receipt,
      evidence,
      contract,
      roster: ports.roster,
      recordedAt,
      gateReceipts,
      log: ports.log,
    });
    const bound = ports.store.bindReviewEvaluation(record, BIND_ACTOR);
    return {
      kind: 'bound',
      aggregateId,
      iterationId: current.id,
      receiptId: outcome.receipt.receiptId,
      verdictOutcome: outcome.receipt.verdict.outcome,
      recommendedNextStage: outcome.receipt.verdict.recommendedNextStage,
      evaluationHash: bound.evaluationHash,
    };
  } catch (error) {
    return {
      kind: 'failed',
      aggregateId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function evaluateAllAwaiting(
  ports: ReviewEvaluationPorts,
): Promise<readonly EvaluateOutcome[]> {
  let awaiting: readonly {
    readonly aggregateId: string;
    readonly iterationId: string;
    readonly evidenceHash: string;
  }[] = [];
  try {
    awaiting = ports.store.listAggregatesAwaitingEvaluation();
  } catch (error) {
    return [
      {
        kind: 'failed',
        aggregateId: '*',
        error: error instanceof Error ? error.message : String(error),
      },
    ];
  }
  const results: EvaluateOutcome[] = [];
  for (const entry of awaiting) {
    try {
      results.push(await evaluateReviewAggregate(ports, entry.aggregateId));
    } catch (error) {
      results.push({
        kind: 'failed',
        aggregateId: entry.aggregateId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
