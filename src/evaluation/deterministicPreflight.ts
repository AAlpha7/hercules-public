/**
 * M8 deterministic preflight coordinator (pure).
 *
 * May import only from `src/domain/`. No Node builtins, no Buffer, no other
 * `src/` subtrees. Built-in gate registry is a documented seam — only
 * `m8-noop-always-pass` ships in this slice.
 */

import { canonicalSerialize } from '../domain/canonicalJson.js';
import type { CandidateRef } from '../domain/artifact.js';
import type { AssertionVerificationReceipt } from '../domain/claimAuthorityV2.js';
import {
  IndependentEvaluationError,
  assertDeterministicGateReceiptShapeV1,
  assertDeterministicGateReceiptV1,
  assertIndependentEvaluationInputV1,
  assertRunAuthorityDisjointness,
  assertTrustedEvaluationControlSnapshotV1,
  assertTrustedEvaluationEvidenceSnapshotV1,
  computeGateReceiptSetHash,
  computePreflightCheckHash,
  computePreflightResultHash,
  type DeterministicGateReceiptV1,
  type DeterministicPreflightCheckV1,
  type DeterministicPreflightResultV1,
  type IndependentEvaluationErrorCode,
  type IndependentEvaluationInputV1,
  type PreflightCheckIdV1,
  type PreflightCheckStatusV1,
  type TrustedEvaluationControlSnapshotV1,
  type TrustedEvaluationEvidenceSnapshotV1,
} from '../domain/independentEvaluation.js';
import type { CriterionAuthority } from '../domain/taskContract.js';

export interface PreflightSubjectV1 {
  readonly input: IndependentEvaluationInputV1;
  readonly control: TrustedEvaluationControlSnapshotV1;
  readonly evidence: TrustedEvaluationEvidenceSnapshotV1;
  readonly gateReceipts: readonly DeterministicGateReceiptV1[];
}

type PreflightCheckCode = DeterministicPreflightCheckV1['code'];

interface CheckOutcome {
  readonly status: PreflightCheckStatusV1;
  readonly code: PreflightCheckCode;
  readonly criterionIds: readonly string[];
  readonly assertionIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly advisoryDetail: string;
  /** Populated by claim_eligibility on success; otherwise ignored. */
  readonly eligibleAssertionIds?: readonly string[];
  /** Subject keys with confirming-track valueHash contradictions (step 5). */
  readonly contradictedSubjectKeys?: ReadonlySet<string>;
}

type BuiltinGateFn = (subject: PreflightSubjectV1) => PreflightCheckStatusV1;

/**
 * Closed built-in gate registry seam. Real builtins arrive with later wiring.
 * Unknown registryFunctionId → need_more_evidence at the deterministic_gates check.
 */
const BUILTIN_GATE_REGISTRY: ReadonlyMap<string, BuiltinGateFn> = new Map([
  ['m8-noop-always-pass', (_subject) => 'pass'],
]);

/** Mechanical/verifier authorities are deterministic; evaluator requires model judgment; human is pending-only. */
const DETERMINISTIC_CRITERION_AUTHORITIES: ReadonlySet<CriterionAuthority> = new Set([
  'mechanical',
  'verifier',
]);
const MODEL_JUDGMENT_CRITERION_AUTHORITIES: ReadonlySet<CriterionAuthority> = new Set([
  'evaluator',
]);
// 'human' is intentionally neither — human-only criteria never force model judgment.

function sortedUnique(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)].sort();
}

function makeCheck(
  checkId: PreflightCheckIdV1,
  outcome: CheckOutcome,
): DeterministicPreflightCheckV1 {
  const withoutHash = {
    checkId,
    status: outcome.status,
    code: outcome.code,
    criterionIds: sortedUnique(outcome.criterionIds),
    assertionIds: sortedUnique(outcome.assertionIds),
    evidenceIds: sortedUnique(outcome.evidenceIds),
    advisoryDetail: outcome.advisoryDetail,
  };
  return {
    ...withoutHash,
    checkHash: computePreflightCheckHash(withoutHash),
  };
}

function thrownCode(error: unknown): IndependentEvaluationErrorCode {
  if (error instanceof IndependentEvaluationError) {
    return error.code;
  }
  return 'invalid_input_schema';
}

function thrownMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalSerialize(left) === canonicalSerialize(right);
  } catch {
    return false;
  }
}

function candidateCommit(ref: CandidateRef): string | null {
  if (ref.kind === 'git') {
    return ref.revision;
  }
  return null;
}

function passOutcome(detail = ''): CheckOutcome {
  return {
    status: 'pass',
    code: 'ok',
    criterionIds: [],
    assertionIds: [],
    evidenceIds: [],
    advisoryDetail: detail,
  };
}

function evidenceGap(
  code: IndependentEvaluationErrorCode,
  detail: string,
  extras: Partial<CheckOutcome> = {},
): CheckOutcome {
  return {
    status: 'need_more_evidence',
    code,
    criterionIds: extras.criterionIds ?? [],
    assertionIds: extras.assertionIds ?? [],
    evidenceIds: extras.evidenceIds ?? [],
    advisoryDetail: detail,
  };
}

function checkStructuralInput(subject: PreflightSubjectV1): CheckOutcome {
  try {
    assertTrustedEvaluationControlSnapshotV1(subject.control);
    assertTrustedEvaluationEvidenceSnapshotV1(subject.evidence);
    assertIndependentEvaluationInputV1(subject.input, subject.control.policy);
    for (const receipt of subject.gateReceipts) {
      assertDeterministicGateReceiptShapeV1(receipt);
    }
    return passOutcome();
  } catch (error) {
    return evidenceGap(thrownCode(error), thrownMessage(error));
  }
}

function checkSubjectRelationships(subject: PreflightSubjectV1): CheckOutcome {
  const { input, control, evidence } = subject;
  const pairs: readonly { label: string; ok: boolean }[] = [
    {
      label: 'taskContract',
      ok: canonicalEqual(input.taskContract, evidence.taskContract),
    },
    { label: 'iterationId', ok: input.iterationId === evidence.iterationId },
    {
      label: 'candidateRef',
      ok: canonicalEqual(input.candidateRef, evidence.candidateRef),
    },
    {
      label: 'evidenceManifest',
      ok: canonicalEqual(input.evidenceManifest, evidence.evidenceManifest),
    },
    { label: 'artifacts', ok: canonicalEqual(input.artifacts, evidence.artifacts) },
    {
      label: 'verificationResult',
      ok: canonicalEqual(input.verificationResult, evidence.verificationResult),
    },
    {
      label: 'assertions',
      ok: canonicalEqual(input.assertions, evidence.assertions),
    },
    {
      label: 'verificationReceipts',
      ok: canonicalEqual(input.verificationReceipts, evidence.verificationReceipts),
    },
    {
      label: 'integrityAttestation',
      ok: canonicalEqual(input.integrityAttestation, evidence.integrityAttestation),
    },
    {
      label: 'policyRef',
      ok:
        input.policyRef.version === control.policy.version &&
        input.policyRef.policyHash === control.policy.policyHash,
    },
    {
      label: 'rubricRef',
      ok:
        input.rubricRef.version === control.rubric.version &&
        input.rubricRef.rubricHash === control.rubric.rubricHash &&
        input.rubricRef.rubricId === control.rubric.rubricId,
    },
    {
      label: 'gatePlanRef',
      ok:
        input.gatePlanRef.version === control.gatePlan.version &&
        input.gatePlanRef.gatePlanHash === control.gatePlan.gatePlanHash &&
        input.gatePlanRef.gatePlanId === control.gatePlan.gatePlanId,
    },
    {
      label: 'gatePlan.taskContractHash',
      ok: control.gatePlan.taskContractHash === evidence.taskContract.contractHash,
    },
    {
      label: 'gatePlan.candidateCommit',
      ok: control.gatePlan.candidateCommit === candidateCommit(evidence.candidateRef),
    },
    {
      label: 'rubric.taskContractHash',
      ok: control.rubric.taskContractHash === evidence.taskContract.contractHash,
    },
  ];
  for (const pair of pairs) {
    if (!pair.ok) {
      return evidenceGap('stale_binding', `subject relationship mismatch: ${pair.label}`);
    }
  }
  return passOutcome();
}

function checkArtifactIntegrity(subject: PreflightSubjectV1): CheckOutcome {
  const { evidence } = subject;
  const attestation = evidence.integrityAttestation;
  if (attestation.result !== 'intact') {
    return evidenceGap(
      'artifact_integrity',
      `integrity attestation result is ${attestation.result}`,
    );
  }
  if (attestation.evidenceManifestId !== evidence.evidenceManifest.id) {
    return evidenceGap(
      'artifact_integrity',
      'integrity attestation evidenceManifestId does not match evidence snapshot',
    );
  }
  if (attestation.evidenceManifestHash !== evidence.evidenceManifest.manifestHash) {
    return evidenceGap(
      'artifact_integrity',
      'integrity attestation evidenceManifestHash does not match evidence snapshot',
    );
  }
  if (!canonicalEqual(attestation.candidateRef, evidence.candidateRef)) {
    return evidenceGap(
      'artifact_integrity',
      'integrity attestation candidateRef does not match evidence snapshot',
    );
  }
  const checkedById = new Map(
    attestation.checkedArtifacts.map((entry) => [entry.artifactRefId, entry] as const),
  );
  // ArtifactRef digest field is `sha256`.
  for (const artifact of evidence.artifacts) {
    const checked = checkedById.get(artifact.id);
    if (checked === undefined) {
      return evidenceGap(
        'artifact_integrity',
        `artifact ${artifact.id} missing from integrity attestation checkedArtifacts`,
        { evidenceIds: [artifact.id] },
      );
    }
    if (checked.sha256 !== artifact.sha256) {
      return evidenceGap(
        'artifact_integrity',
        `artifact ${artifact.id} sha256 does not match integrity attestation`,
        { evidenceIds: [artifact.id] },
      );
    }
  }
  return passOutcome();
}

function checkVerificationResult(subject: PreflightSubjectV1): CheckOutcome {
  const { control, evidence } = subject;
  const result = evidence.verificationResult;
  if (result.status !== 'complete') {
    return evidenceGap(
      'verification_incomplete',
      `verification result status is ${result.status}`,
    );
  }
  const assertionIds = new Set(evidence.assertions.map((assertion) => assertion.id));
  const receiptIds = new Set(evidence.verificationReceipts.map((receipt) => receipt.id));
  const artifactIds = new Set(evidence.artifacts.map((artifact) => artifact.id));
  const coveredCriteria = new Set<string>();
  for (const observation of result.observations) {
    for (const criterionId of observation.criterionIds) {
      coveredCriteria.add(criterionId);
    }
    for (const assertionId of observation.assertionIds) {
      if (!assertionIds.has(assertionId)) {
        return evidenceGap(
          'verification_incomplete',
          `observation ${observation.observationId} references unknown assertion ${assertionId}`,
          { assertionIds: [assertionId], evidenceIds: [observation.observationId] },
        );
      }
    }
    for (const receiptId of observation.verificationReceiptIds) {
      if (!receiptIds.has(receiptId)) {
        return evidenceGap(
          'verification_incomplete',
          `observation ${observation.observationId} references unknown verification receipt ${receiptId}`,
          { evidenceIds: [observation.observationId, receiptId] },
        );
      }
    }
    for (const artifactId of observation.artifactIds) {
      if (!artifactIds.has(artifactId)) {
        return evidenceGap(
          'verification_incomplete',
          `observation ${observation.observationId} references unknown artifact ${artifactId}`,
          { evidenceIds: [observation.observationId, artifactId] },
        );
      }
    }
  }
  const uncovered: string[] = [];
  for (const criterion of control.rubric.criteria) {
    const needsCoverage =
      criterion.requiredSurfaceIds.length > 0 || criterion.requiredGateIds.length > 0;
    if (needsCoverage && !coveredCriteria.has(criterion.criterionId)) {
      uncovered.push(criterion.criterionId);
    }
  }
  if (uncovered.length > 0) {
    return evidenceGap(
      'verification_incomplete',
      `rubric criteria lacking observation coverage: ${uncovered.join(',')}`,
      { criterionIds: uncovered },
    );
  }
  return passOutcome();
}

interface ClaimEligibilityState {
  readonly outcome: CheckOutcome;
  readonly eligibleAssertionIds: readonly string[];
  readonly contradictedSubjectKeys: ReadonlySet<string>;
}

function deriveClaimEligibility(subject: PreflightSubjectV1): ClaimEligibilityState {
  const { control, evidence } = subject;
  const assertionsById = new Map(
    evidence.assertions.map((assertion) => [assertion.id, assertion] as const),
  );
  const commit = candidateCommit(evidence.candidateRef);
  const subjectTaskId = evidence.taskContract.taskId;
  const subjectContractHash = evidence.taskContract.contractHash;
  const subjectIterationId = evidence.iterationId;
  const subjectManifestId = evidence.evidenceManifest.id;
  const subjectManifestHash = evidence.evidenceManifest.manifestHash;
  const verifierRunIds = new Set(control.roles.verifierRunIds);
  const implementerRunIds = new Set(control.roles.implementerRunIds);

  // Confirming-track receipts: valueHash === assertionPayloadHash (and matches assertion).
  const confirmingBySubject = new Map<string, Set<string>>();
  for (const receipt of evidence.verificationReceipts) {
    if (!assertionsById.has(receipt.assertionId)) {
      return {
        outcome: evidenceGap(
          'claim_ineligible',
          `verification receipt ${receipt.id} references unknown assertion ${receipt.assertionId}`,
          { assertionIds: [receipt.assertionId], evidenceIds: [receipt.id] },
        ),
        eligibleAssertionIds: [],
        contradictedSubjectKeys: new Set(),
      };
    }
    if (receipt.valueHash !== receipt.assertionPayloadHash) {
      continue;
    }
    const existing = confirmingBySubject.get(receipt.subjectKey);
    if (existing === undefined) {
      confirmingBySubject.set(receipt.subjectKey, new Set([receipt.valueHash]));
    } else {
      existing.add(receipt.valueHash);
    }
  }
  const contradictedSubjectKeys = new Set<string>();
  for (const [subjectKey, hashes] of confirmingBySubject) {
    if (hashes.size > 1) {
      contradictedSubjectKeys.add(subjectKey);
    }
  }

  function receiptBindsCurrentSubject(receipt: AssertionVerificationReceipt): boolean {
    return (
      receipt.taskId === subjectTaskId &&
      receipt.contractHash === subjectContractHash &&
      receipt.iterationId === subjectIterationId &&
      canonicalEqual(receipt.candidateRef, evidence.candidateRef) &&
      receipt.evidenceManifestId === subjectManifestId &&
      receipt.evidenceManifestHash === subjectManifestHash &&
      commit !== null
    );
  }

  const eligible: string[] = [];
  for (const assertion of evidence.assertions) {
    if (assertion.kind !== 'fact') {
      continue;
    }
    if (contradictedSubjectKeys.has(assertion.subjectKey)) {
      continue;
    }
    const confirming = evidence.verificationReceipts.some((receipt) => {
      return (
        receipt.assertionId === assertion.id &&
        receipt.subjectKey === assertion.subjectKey &&
        receipt.assertionPayloadHash === assertion.payloadHash &&
        receipt.valueHash === assertion.payloadHash &&
        receiptBindsCurrentSubject(receipt) &&
        verifierRunIds.has(receipt.verifierRunId) &&
        !implementerRunIds.has(receipt.verifierRunId)
      );
    });
    if (confirming) {
      eligible.push(assertion.id);
    }
  }
  const eligibleAssertionIds = sortedUnique(eligible);
  return {
    outcome: {
      ...passOutcome('claim eligibility derived'),
      eligibleAssertionIds,
      contradictedSubjectKeys,
    },
    eligibleAssertionIds,
    contradictedSubjectKeys,
  };
}

function checkControlAuthority(subject: PreflightSubjectV1): CheckOutcome {
  const { control } = subject;
  try {
    assertRunAuthorityDisjointness(control.roles, control.policy);
  } catch (error) {
    return evidenceGap('role_conflict', thrownMessage(error));
  }
  if (
    !control.policy.allowedEvaluatorImplementationIds.includes(
      control.roles.evaluatorImplementationId,
    )
  ) {
    return evidenceGap(
      'policy_denial',
      `evaluator implementation ${control.roles.evaluatorImplementationId} is not allowed by policy`,
    );
  }
  const epochs = [
    control.authorityEpoch,
    control.policy.authorityEpoch,
    control.rubric.authorityEpoch,
    control.gatePlan.authorityEpoch,
    control.roles.authorityEpoch,
  ];
  const first = epochs[0];
  if (first === undefined || epochs.some((epoch) => epoch !== first)) {
    return evidenceGap('role_conflict', 'authorityEpoch mismatch across control records');
  }
  return passOutcome();
}

function checkDeterministicGates(
  subject: PreflightSubjectV1,
  eligibleAssertionIds: ReadonlySet<string>,
): CheckOutcome {
  const { control, evidence, gateReceipts } = subject;
  const plan = control.gatePlan;
  const planGateIds = new Set(plan.gates.map((gate) => gate.gateId));
  for (const receipt of gateReceipts) {
    if (!planGateIds.has(receipt.gateId)) {
      return evidenceGap(
        'stale_binding',
        `gate receipt ${receipt.gateId} matches no plan gate`,
        { evidenceIds: [receipt.receiptHash] },
      );
    }
  }
  const commit = candidateCommit(evidence.candidateRef);
  if (commit === null) {
    return evidenceGap(
      'stale_binding',
      'evidence candidateRef has no git revision for gate subject binding',
    );
  }
  for (const definition of plan.gates) {
    if (definition.kind === 'coordinator_builtin') {
      const builtin = BUILTIN_GATE_REGISTRY.get(definition.registryFunctionId);
      if (builtin === undefined) {
        return evidenceGap(
          'stale_binding',
          `unknown builtin gate registryFunctionId ${definition.registryFunctionId}`,
          { criterionIds: [] },
        );
      }
      const builtinStatus = builtin(subject);
      if (builtinStatus !== 'pass') {
        return {
          status: builtinStatus,
          code:
            builtinStatus === 'verified_fail'
              ? 'deterministic_gate_failed'
              : 'stale_binding',
          criterionIds: [],
          assertionIds: [],
          evidenceIds: [],
          advisoryDetail: `builtin gate ${definition.gateId} returned ${builtinStatus}`,
        };
      }
      continue;
    }
    // trusted_external_receipt
    const matching = gateReceipts.filter((receipt) => receipt.gateId === definition.gateId);
    if (matching.length !== 1) {
      return evidenceGap(
        'stale_binding',
        matching.length === 0
          ? `missing gate receipt for ${definition.gateId}`
          : `duplicate gate receipts for ${definition.gateId}`,
      );
    }
    const receipt = matching[0];
    if (receipt === undefined) {
      return evidenceGap('stale_binding', `missing gate receipt for ${definition.gateId}`);
    }
    if (
      receipt.gateVersion !== definition.version ||
      receipt.gateDefinitionHash !== definition.definitionHash ||
      receipt.gatePlanId !== plan.gatePlanId ||
      receipt.gatePlanHash !== plan.gatePlanHash
    ) {
      return evidenceGap(
        'stale_binding',
        `gate receipt binding mismatch for ${definition.gateId}`,
      );
    }
    if (
      receipt.taskId !== evidence.taskContract.taskId ||
      receipt.taskContractHash !== evidence.taskContract.contractHash ||
      receipt.iterationId !== evidence.iterationId ||
      receipt.candidateCommit !== commit
    ) {
      return evidenceGap(
        'stale_binding',
        `gate receipt subject binding mismatch for ${definition.gateId}`,
      );
    }
    try {
      assertDeterministicGateReceiptV1(receipt, definition);
    } catch (error) {
      return evidenceGap(thrownCode(error), thrownMessage(error));
    }
    if (receipt.status === 'pass') {
      continue;
    }
    if (receipt.status === 'unavailable') {
      return evidenceGap(
        'stale_binding',
        `gate receipt ${definition.gateId} is unavailable`,
        { assertionIds: [...receipt.assertionIds] },
      );
    }
    // verified_fail
    const unknownOrIneligible = receipt.assertionIds.filter(
      (assertionId) => !eligibleAssertionIds.has(assertionId),
    );
    if (unknownOrIneligible.length > 0 || receipt.assertionIds.length === 0) {
      return evidenceGap(
        'claim_ineligible',
        `verified_fail gate ${definition.gateId} has ineligible or unknown assertions`,
        { assertionIds: receipt.assertionIds },
      );
    }
    return {
      status: 'verified_fail',
      code: 'deterministic_gate_failed',
      criterionIds: [],
      assertionIds: [...receipt.assertionIds],
      evidenceIds: [receipt.receiptHash],
      advisoryDetail: `deterministic gate ${definition.gateId} verified_fail`,
    };
  }
  return passOutcome();
}

function checkRealSurfaceCoverage(
  subject: PreflightSubjectV1,
  eligibleAssertionIds: ReadonlySet<string>,
): CheckOutcome {
  const { control, evidence } = subject;
  const observations = evidence.verificationResult.observations;
  for (const criterion of control.rubric.criteria) {
    if (criterion.requiredSurfaceIds.length === 0) {
      continue;
    }
    for (const surfaceId of criterion.requiredSurfaceIds) {
      // Closed reading: the required surface id must appear in observation.artifactIds.
      const coveringPass = observations.find(
        (observation) =>
          observation.kind === 'real_surface' &&
          observation.status === 'pass' &&
          observation.criterionIds.includes(criterion.criterionId) &&
          observation.artifactIds.includes(surfaceId),
      );
      if (coveringPass !== undefined) {
        continue;
      }
      const coveringFail = observations.find(
        (observation) =>
          observation.kind === 'real_surface' &&
          observation.status === 'verified_fail' &&
          observation.criterionIds.includes(criterion.criterionId) &&
          observation.artifactIds.includes(surfaceId) &&
          observation.assertionIds.some((id) => eligibleAssertionIds.has(id)),
      );
      if (coveringFail !== undefined) {
        return {
          status: 'verified_fail',
          code: 'deterministic_gate_failed',
          criterionIds: [criterion.criterionId],
          assertionIds: [...coveringFail.assertionIds],
          evidenceIds: [coveringFail.observationId, surfaceId],
          advisoryDetail: `real surface ${surfaceId} verified_fail for ${criterion.criterionId}`,
        };
      }
      return evidenceGap(
        'real_surface_missing',
        `missing real_surface pass observation for surface ${surfaceId} on ${criterion.criterionId}`,
        {
          criterionIds: [criterion.criterionId],
          evidenceIds: [surfaceId],
        },
      );
    }
  }
  return passOutcome();
}

function checkContradictionAndSufficiency(
  subject: PreflightSubjectV1,
  eligibleAssertionIds: ReadonlySet<string>,
  contradictedSubjectKeys: ReadonlySet<string>,
): CheckOutcome {
  const { control, evidence } = subject;
  const eligibleSet = eligibleAssertionIds;
  const assertionsById = new Map(
    evidence.assertions.map((assertion) => [assertion.id, assertion] as const),
  );
  const receiptsById = new Map(
    evidence.verificationReceipts.map((receipt) => [receipt.id, receipt] as const),
  );

  for (const criterion of control.rubric.criteria) {
    if (!criterion.required) {
      continue;
    }
    const premiseAssertionIds = new Set<string>();
    for (const observation of evidence.verificationResult.observations) {
      if (observation.criterionIds.includes(criterion.criterionId)) {
        for (const assertionId of observation.assertionIds) {
          premiseAssertionIds.add(assertionId);
        }
      }
    }
    for (const receipt of evidence.verificationReceipts) {
      if (receipt.criterionIds.includes(criterion.criterionId)) {
        premiseAssertionIds.add(receipt.assertionId);
      }
    }
    // Contradictions outrank bare insufficiency when they touch required premises.
    for (const assertionId of premiseAssertionIds) {
      const assertion = assertionsById.get(assertionId);
      if (assertion !== undefined && contradictedSubjectKeys.has(assertion.subjectKey)) {
        return evidenceGap(
          'claim_contradiction',
          `required criterion ${criterion.criterionId} premises include contradicted subjectKey ${assertion.subjectKey}`,
          {
            criterionIds: [criterion.criterionId],
            assertionIds: [assertionId],
          },
        );
      }
      const receipt = [...receiptsById.values()].find((entry) => entry.assertionId === assertionId);
      if (receipt !== undefined && contradictedSubjectKeys.has(receipt.subjectKey)) {
        return evidenceGap(
          'claim_contradiction',
          `required criterion ${criterion.criterionId} premises touch contradicted subjectKey ${receipt.subjectKey}`,
          {
            criterionIds: [criterion.criterionId],
            assertionIds: [assertionId],
          },
        );
      }
    }
    const eligiblePremises = [...premiseAssertionIds].filter((id) => eligibleSet.has(id));
    if (eligiblePremises.length === 0) {
      return evidenceGap(
        'claim_ineligible',
        `required criterion ${criterion.criterionId} has zero eligible premises`,
        { criterionIds: [criterion.criterionId] },
      );
    }
  }
  return passOutcome();
}

function checkModelJudgmentNecessity(subject: PreflightSubjectV1): CheckOutcome {
  const { control } = subject;
  let requiresModel = false;
  for (const criterion of control.rubric.criteria) {
    if (MODEL_JUDGMENT_CRITERION_AUTHORITIES.has(criterion.authority)) {
      requiresModel = true;
      break;
    }
    if (
      !DETERMINISTIC_CRITERION_AUTHORITIES.has(criterion.authority) &&
      criterion.authority !== 'human'
    ) {
      // Unknown / future authority values are treated as requiring model judgment.
      requiresModel = true;
      break;
    }
  }
  if (requiresModel) {
    return {
      status: 'model_judgment_required',
      code: 'model_judgment_required',
      criterionIds: control.rubric.criteria
        .filter((criterion) => MODEL_JUDGMENT_CRITERION_AUTHORITIES.has(criterion.authority))
        .map((criterion) => criterion.criterionId),
      assertionIds: [],
      evidenceIds: [],
      advisoryDetail: 'rubric requires independent model/agent judgment',
    };
  }
  return passOutcome('all rubric criteria are deterministic or human-pending');
}

/**
 * Pure total preflight: never throws. Evaluates the ten checks in declared
 * order and stops at the first non-pass status.
 */
export function runDeterministicPreflight(
  subject: PreflightSubjectV1,
): DeterministicPreflightResultV1 {
  const checks: DeterministicPreflightCheckV1[] = [];
  let eligibleAssertionIds: readonly string[] = [];
  let contradictedSubjectKeys: ReadonlySet<string> = new Set();

  const finish = (
    last: DeterministicPreflightCheckV1,
    prior: readonly DeterministicPreflightCheckV1[],
  ): DeterministicPreflightResultV1 => {
    const allChecks = [...prior, last];
    let inputHash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    let controlIdentityHash = inputHash;
    let evidenceIdentityHash = inputHash;
    let gateReceiptSetHash = inputHash;
    try {
      inputHash =
        typeof subject.input?.inputHash === 'string' && subject.input.inputHash.length > 0
          ? subject.input.inputHash
          : inputHash;
      controlIdentityHash =
        typeof subject.control?.controlIdentityHash === 'string' &&
        subject.control.controlIdentityHash.length > 0
          ? subject.control.controlIdentityHash
          : controlIdentityHash;
      evidenceIdentityHash =
        typeof subject.evidence?.evidenceIdentityHash === 'string' &&
        subject.evidence.evidenceIdentityHash.length > 0
          ? subject.evidence.evidenceIdentityHash
          : evidenceIdentityHash;
      if (Array.isArray(subject.gateReceipts)) {
        gateReceiptSetHash = computeGateReceiptSetHash(subject.gateReceipts);
      }
    } catch {
      // Keep zero hashes when subject fields are unusable.
    }
    const withoutHash = {
      schema: 'hercules-deterministic-preflight/v1' as const,
      inputHash,
      controlIdentityHash,
      evidenceIdentityHash,
      gateReceiptSetHash,
      checks: allChecks,
      classification: last.status,
      eligibleAssertionIds: sortedUnique(eligibleAssertionIds),
    };
    return {
      ...withoutHash,
      preflightHash: computePreflightResultHash(withoutHash),
    };
  };

  try {
    // 1. structural_input
    {
      const outcome = checkStructuralInput(subject);
      const check = makeCheck('structural_input', outcome);
      if (outcome.status !== 'pass') {
        return finish(check, checks);
      }
      checks.push(check);
    }

    // After structural pass, snapshot hashes are trustworthy.
    // 2. subject_relationships
    {
      const outcome = checkSubjectRelationships(subject);
      const check = makeCheck('subject_relationships', outcome);
      if (outcome.status !== 'pass') {
        return finish(check, checks);
      }
      checks.push(check);
    }

    // 3. artifact_integrity
    {
      const outcome = checkArtifactIntegrity(subject);
      const check = makeCheck('artifact_integrity', outcome);
      if (outcome.status !== 'pass') {
        return finish(check, checks);
      }
      checks.push(check);
    }

    // 4. verification_result
    {
      const outcome = checkVerificationResult(subject);
      const check = makeCheck('verification_result', outcome);
      if (outcome.status !== 'pass') {
        return finish(check, checks);
      }
      checks.push(check);
    }

    // 5. claim_eligibility
    {
      const derived = deriveClaimEligibility(subject);
      const check = makeCheck('claim_eligibility', derived.outcome);
      if (derived.outcome.status !== 'pass') {
        return finish(check, checks);
      }
      eligibleAssertionIds = derived.eligibleAssertionIds;
      contradictedSubjectKeys = derived.contradictedSubjectKeys;
      checks.push(check);
    }

    const eligibleSet = new Set(eligibleAssertionIds);

    // 6. control_authority
    {
      const outcome = checkControlAuthority(subject);
      const check = makeCheck('control_authority', outcome);
      if (outcome.status !== 'pass') {
        return finish(check, checks);
      }
      checks.push(check);
    }

    // 7. deterministic_gates
    {
      const outcome = checkDeterministicGates(subject, eligibleSet);
      const check = makeCheck('deterministic_gates', outcome);
      if (outcome.status !== 'pass') {
        return finish(check, checks);
      }
      checks.push(check);
    }

    // 8. real_surface_coverage
    {
      const outcome = checkRealSurfaceCoverage(subject, eligibleSet);
      const check = makeCheck('real_surface_coverage', outcome);
      if (outcome.status !== 'pass') {
        return finish(check, checks);
      }
      checks.push(check);
    }

    // 9. contradiction_and_sufficiency
    {
      const outcome = checkContradictionAndSufficiency(
        subject,
        eligibleSet,
        contradictedSubjectKeys,
      );
      const check = makeCheck('contradiction_and_sufficiency', outcome);
      if (outcome.status !== 'pass') {
        return finish(check, checks);
      }
      checks.push(check);
    }

    // 10. model_judgment_necessity
    {
      const outcome = checkModelJudgmentNecessity(subject);
      const check = makeCheck('model_judgment_necessity', outcome);
      return finish(check, checks);
    }
  } catch (error) {
    // Total function: any unexpected throw becomes a structural need_more_evidence.
    const check = makeCheck('structural_input', {
      status: 'need_more_evidence',
      code: thrownCode(error),
      criterionIds: [],
      assertionIds: [],
      evidenceIds: [],
      advisoryDetail: thrownMessage(error),
    });
    return finish(check, []);
  }
}
