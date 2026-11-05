import {
  assertArtifactRef,
  assertCandidateRef,
  assertEvidenceManifest,
  assertEvidenceManifestArtifacts,
  candidateRefsEqual,
  type ArtifactRef,
  type EvidenceManifest,
} from '../../domain/artifact.js';
import {
  assertAssertionVerificationReceipt,
  assertDecisionAssertion,
  assertEvidenceIntegrityAttestation,
  type AssertionVerificationReceipt,
  type DecisionAssertion,
  type EvidenceIntegrityAttestation,
} from '../../domain/claimAuthorityV2.js';
import { canonicalClone, canonicalSerialize, hashCanonicalJson } from '../../domain/canonicalJson.js';
import {
  assertContractChangeRequest,
  type ContractChangeRequest,
  type ContractChangeProvenance,
  type TrustedContractChangeAuthority,
} from '../../domain/contractChange.js';
import { assertControlEventMetadata } from '../../domain/controlEvent.js';
import {
  assertDecisionBindingIdentity,
  type EvaluationVerdict,
} from '../../domain/evaluationVerdict.js';
import {
  assertIndependentEvaluationReceiptV1,
  type IndependentEvaluationReceiptV1,
} from '../../domain/independentEvaluation.js';
import type { Iteration } from '../../domain/iteration.js';
import type { EvaluationDecisionRecordV2 } from '../../domain/reviewPackageV2.js';
import type { StageRun } from '../../domain/stageRun.js';
import {
  ACTOR_KINDS,
  appendContractVersion,
  type ActorRef,
  type TaskContract,
} from '../../domain/taskContract.js';
import { isNonEmptyString, isNullableNonEmptyString, isRecord } from '../../domain/v2Invariant.js';
import {
  StateStoreError,
  type ShadowCommitCommand,
  type ShadowMutation,
  type V2BoundEvaluationV1,
  type V2BoundEvidenceV1,
} from './stateStore.js';

export const MAX_STATE_COMMAND_BYTES = 1024 * 1024;
export const MAX_STATE_TEXT_BYTES = 512;
export const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
export const EXACT_GIT_REVISION_RE = /^[0-9a-f]{40}$/;

function fail(message: string): never {
  throw new StateStoreError('invalid_input', message);
}

function exactKeys(value: Readonly<Record<PropertyKey, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function boundedText(value: unknown, name: string): asserts value is string {
  if (!isNonEmptyString(value) || Buffer.byteLength(value, 'utf8') > MAX_STATE_TEXT_BYTES) {
    fail(`${name} must be a bounded non-empty string`);
  }
}

export function exactGitRevision(value: unknown, name: string): asserts value is string {
  boundedText(value, name);
  if (!EXACT_GIT_REVISION_RE.test(value)) fail(`${name} must be an exact Git commit hash`);
}

function assertActor(value: unknown, label: string): asserts value is ActorRef {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['kind', 'id']) ||
    !(ACTOR_KINDS as readonly unknown[]).includes(value['kind']) ||
    !isNonEmptyString(value['id'])
  ) {
    fail(`${label} actor must use the exact schema`);
  }
}

function assertContractSchema(value: unknown): asserts value is TaskContract {
  if (!isRecord(value) || !exactKeys(value, [
    'taskId',
    'version',
    'contractHash',
    'objective',
    'context',
    'acceptanceCriteria',
    'constraints',
    'forbiddenActions',
    'capabilityPolicy',
    'verificationPolicy',
    'approvalPolicy',
    'budgetPolicy',
    'createdBy',
    'createdAt',
    'supersedesVersion',
  ])) {
    fail('contract must use the exact schema');
  }
  if (!Array.isArray(value['context']) || value['context'].some(
    (item) => !isRecord(item) || !exactKeys(item, ['kind', 'uri', 'digest']),
  )) {
    fail('contract context must use the exact schema');
  }
  if (!Array.isArray(value['acceptanceCriteria']) || value['acceptanceCriteria'].some((item) => {
    if (!isRecord(item) || !exactKeys(item, ['id', 'text', 'authority', 'required', 'proofBinding'])) {
      return true;
    }
    const binding = item['proofBinding'];
    return binding !== null && (!isRecord(binding) || !exactKeys(binding, ['proofType', 'requirement']));
  })) {
    fail('contract criteria must use the exact schema');
  }
  for (const [field, keys] of [
    ['capabilityPolicy', ['version', 'grants']],
    ['verificationPolicy', ['version', 'requiredEvidence', 'independentEvaluatorRequired']],
    ['approvalPolicy', ['version', 'requiredDecisions']],
    ['budgetPolicy', ['version', 'maxCostUsd', 'maxTokens', 'maxDurationMs']],
  ] as const) {
    const nested = value[field];
    if (!isRecord(nested) || !exactKeys(nested, keys)) {
      fail(`contract ${field} must use the exact schema`);
    }
  }
  assertActor(value['createdBy'], 'contract creator');
}

function assertRequestSchema(value: unknown): asserts value is ContractChangeRequest {
  if (!isRecord(value) || !exactKeys(value, [
    'id',
    'taskId',
    'baseContractVersion',
    'requestedBy',
    'reason',
    'proposedPatch',
    'meaningChange',
    'riskChange',
    'status',
    'policyDecisionId',
    'humanDecisionId',
  ])) {
    fail('contract change request must use the exact schema');
  }
  assertActor(value['requestedBy'], 'contract requester');
  if (!Array.isArray(value['proposedPatch']) || value['proposedPatch'].some(
    (operation) => !isRecord(operation) || !exactKeys(operation, ['op', 'path', 'value']),
  )) {
    fail('contract change patches must use the exact schema');
  }
  assertContractChangeRequest(value as unknown as ContractChangeRequest);
}

function assertProvenance(value: unknown): asserts value is ContractChangeProvenance {
  if (!isRecord(value) || !exactKeys(value, ['createdBy', 'createdAt'])) {
    fail('contract change provenance must use the exact schema');
  }
  assertActor(value['createdBy'], 'contract change provenance');
  if (!isNonEmptyString(value['createdAt'])) fail('contract change provenance time is invalid');
  canonicalSerialize(value);
}

function assertTrustedAuthority(value: unknown): asserts value is TrustedContractChangeAuthority {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['approvedRequestId', 'policyDecisionId', 'humanDecisionId'])
  ) {
    fail('trusted contract authority must use the exact schema');
  }
  if (
    !isNonEmptyString(value['approvedRequestId']) ||
    !isNullableNonEmptyString(value['policyDecisionId']) ||
    !isNullableNonEmptyString(value['humanDecisionId'])
  ) {
    fail('trusted contract authority values are invalid');
  }
  canonicalSerialize(value);
}

function assertMutation(value: unknown): asserts value is ShadowMutation {
  if (!isRecord(value) || typeof value['kind'] !== 'string') fail('mutation is invalid');
  switch (value['kind']) {
    case 'insert_contract_root': {
      if (!exactKeys(value, ['kind', 'contract'])) fail('root mutation has unknown fields');
      assertContractSchema(value['contract']);
      appendContractVersion([], value['contract'] as TaskContract);
      return;
    }
    case 'append_contract_successor': {
      if (!exactKeys(value, ['kind', 'request', 'provenance', 'trustedAuthority'])) {
        fail('contract successor mutation has unknown fields');
      }
      assertRequestSchema(value['request']);
      assertProvenance(value['provenance']);
      assertTrustedAuthority(value['trustedAuthority']);
      return;
    }
    case 'put_iteration': {
      if (!exactKeys(value, ['kind', 'iteration'])) fail('iteration mutation has unknown fields');
      if (!isRecord(value['iteration']) || !exactKeys(value['iteration'], [
        'id',
        'taskId',
        'contractVersion',
        'ordinal',
        'state',
        'candidateRef',
        'evidenceManifestId',
        'finalVerdictId',
        'createdAt',
        'endedAt',
        'supersedesIterationId',
      ])) fail('iteration record must use the exact schema');
      const candidate = value['iteration']['candidateRef'];
      if (candidate !== null) {
        if (!isRecord(candidate) || typeof candidate['kind'] !== 'string') {
          fail('iteration candidate must use the exact schema');
        }
        const keys = candidate['kind'] === 'git'
          ? ['kind', 'repository', 'revision']
          : candidate['kind'] === 'artifact'
            ? ['kind', 'artifactId', 'sha256']
            : candidate['kind'] === 'external'
              ? ['kind', 'system', 'version', 'digest']
              : [];
        if (keys.length === 0 || !exactKeys(candidate, keys)) {
          fail('iteration candidate must use the exact schema');
        }
      }
      canonicalSerialize(value['iteration'] as unknown as Iteration);
      return;
    }
    case 'put_stage_run': {
      if (!exactKeys(value, ['kind', 'stageRun'])) fail('stage mutation has unknown fields');
      if (!isRecord(value['stageRun']) || !exactKeys(value['stageRun'], [
        'id',
        'iterationId',
        'type',
        'attempt',
        'state',
        'jobSpecHash',
        'workerId',
        'agentRunIds',
        'inputArtifactRefs',
        'outputArtifactRefs',
        'structuredResult',
        'startedAt',
        'endedAt',
        'failureClass',
      ])) fail('stage record must use the exact schema');
      canonicalSerialize(value['stageRun'] as unknown as StageRun);
      return;
    }
    case 'retire_task': {
      if (!exactKeys(value, ['kind', 'taskId', 'revision'])) {
        fail('retirement mutation has unknown fields');
      }
      boundedText(value['taskId'], 'retirement task id');
      exactGitRevision(value['revision'], 'retirement revision');
      return;
    }
    default:
      fail('mutation kind is invalid');
  }
}

export function validateShadowCommitCommand(value: unknown): ShadowCommitCommand {
  try {
    canonicalSerialize(value);
  } catch (error) {
    throw new StateStoreError('invalid_input', 'command is not canonical JSON', error);
  }
  try {
    if (!isRecord(value) || !exactKeys(value, ['idempotencyKey', 'event', 'mutation'])) {
      fail('command must use the exact public schema');
    }
    boundedText(value['idempotencyKey'], 'idempotency key');
    assertControlEventMetadata(value['event']);
    assertMutation(value['mutation']);
  } catch (error) {
    if (error instanceof StateStoreError) throw error;
    throw new StateStoreError('invalid_input', 'command violates the shadow-store contract', error);
  }
  const canonical = canonicalSerialize(value);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_STATE_COMMAND_BYTES) {
    fail('command exceeds the persistence size limit');
  }
  return canonicalClone(value) as unknown as ShadowCommitCommand;
}

export function commandDigest(command: ShadowCommitCommand): string {
  return hashCanonicalJson(command);
}

const V2_BOUND_EVIDENCE_KEYS = [
  'schema',
  'aggregateId',
  'iterationId',
  'candidateRef',
  'evidenceManifest',
  'artifacts',
  'assertions',
  'verificationReceipts',
  'evidenceIntegrity',
  'producer',
  'recordedAt',
  'evidenceHash',
] as const;

const V2_BOUND_EVALUATION_KEYS = [
  'schema',
  'aggregateId',
  'iterationId',
  'evidenceHash',
  'receipt',
  'evaluation',
  'evaluator',
  'recordedAt',
  'evaluationHash',
] as const;

const EVALUATION_DECISION_RECORD_KEYS = [
  'schema',
  'verdict',
  'criterionPremises',
  'findingPremises',
  'outcomeAssertionIds',
  'nextStageAssertionIds',
] as const;

const EVALUATION_VERDICT_KEYS = [
  'id',
  'binding',
  'outcome',
  'criterionResults',
  'blockingFindings',
  'nonBlockingRisks',
  'recommendedNextStage',
  'evaluatorAgentRunId',
  'createdAt',
] as const;

function assertEvaluationDecisionRecordV2(
  value: unknown,
): asserts value is EvaluationDecisionRecordV2 {
  if (!isRecord(value) || !exactKeys(value, EVALUATION_DECISION_RECORD_KEYS)) {
    fail('evaluation decision record must use the exact schema');
  }
  if (value['schema'] !== 'hercules-evaluation-decision/v2') {
    fail('evaluation decision record schema must be hercules-evaluation-decision/v2');
  }
  if (
    !Array.isArray(value['criterionPremises']) ||
    !Array.isArray(value['findingPremises']) ||
    !Array.isArray(value['outcomeAssertionIds']) ||
    !Array.isArray(value['nextStageAssertionIds'])
  ) {
    fail('evaluation decision record premise and assertion arrays are invalid');
  }
  const verdict = value['verdict'];
  if (!isRecord(verdict) || !exactKeys(verdict, EVALUATION_VERDICT_KEYS)) {
    fail('evaluation verdict must use the exact schema');
  }
  assertDecisionBindingIdentity(verdict['binding'] as never);
  if (
    !isNonEmptyString(verdict['id']) ||
    !isNonEmptyString(verdict['createdAt']) ||
    !(['pass', 'fail', 'need_more_evidence'] as const).includes(
      verdict['outcome'] as 'pass' | 'fail' | 'need_more_evidence',
    ) ||
    !Array.isArray(verdict['criterionResults']) ||
    !Array.isArray(verdict['blockingFindings']) ||
    !Array.isArray(verdict['nonBlockingRisks'])
  ) {
    fail('evaluation verdict identity, outcome, and collections are invalid');
  }
}

export function computeV2BoundEvidenceHash(
  record: Omit<V2BoundEvidenceV1, 'evidenceHash'>,
): string {
  return hashCanonicalJson(record);
}

export function computeV2BoundEvaluationHash(
  record: Omit<V2BoundEvaluationV1, 'evaluationHash'>,
): string {
  return hashCanonicalJson(record);
}

function wrapDomainValidation(label: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    if (error instanceof StateStoreError) throw error;
    fail(
      error instanceof Error
        ? `${label}: ${error.message}`
        : `${label} failed domain validation`,
    );
  }
}

function assertReceiptBindsRecord(
  receipt: AssertionVerificationReceipt,
  record: {
    readonly aggregateId: string;
    readonly iterationId: string;
    readonly candidateRef: V2BoundEvidenceV1['candidateRef'];
    readonly evidenceManifest: EvidenceManifest;
    readonly artifacts: readonly ArtifactRef[];
    readonly assertions: readonly DecisionAssertion[];
    readonly producer: V2BoundEvidenceV1['producer'];
  },
): void {
  if (receipt.taskId !== record.aggregateId) {
    fail('bound evidence receipt taskId must equal the record aggregateId');
  }
  if (receipt.contractVersion !== record.evidenceManifest.contractVersion) {
    fail('bound evidence receipt contractVersion must equal the manifest contractVersion');
  }
  if (receipt.iterationId !== record.iterationId) {
    fail('bound evidence receipt iterationId must equal the record iterationId');
  }
  if (!candidateRefsEqual(receipt.candidateRef, record.candidateRef)) {
    fail('bound evidence receipt candidateRef must deep-equal the record candidateRef');
  }
  if (receipt.evidenceManifestId !== record.evidenceManifest.id) {
    fail('bound evidence receipt evidenceManifestId must equal the record manifest id');
  }
  if (receipt.evidenceManifestHash !== record.evidenceManifest.manifestHash) {
    fail('bound evidence receipt evidenceManifestHash must equal the record manifest hash');
  }
  if (receipt.verifierRunId !== record.producer.verifierRunId) {
    fail('bound evidence receipt verifierRunId must equal the record producer.verifierRunId');
  }
  const assertion = record.assertions.find((entry) => entry.id === receipt.assertionId);
  if (assertion === undefined) {
    fail(`bound evidence receipt assertionId ${receipt.assertionId} is not in the record`);
  }
  if (receipt.assertionPayloadHash !== assertion.payloadHash) {
    fail('bound evidence receipt assertionPayloadHash must equal the assertion payloadHash');
  }
  if (receipt.subjectKey !== assertion.subjectKey) {
    fail('bound evidence receipt subjectKey must equal the assertion subjectKey');
  }
  const artifactIds = new Set(record.artifacts.map((artifact) => artifact.id));
  const manifestArtifactIds = new Set(
    record.evidenceManifest.entries.map((entry) => entry.artifactRefId),
  );
  for (const artifactId of receipt.evidenceEntryArtifactIds) {
    if (!manifestArtifactIds.has(artifactId)) {
      fail(
        `bound evidence receipt evidenceEntryArtifactIds must be a subset of manifest entry artifact ids (${artifactId})`,
      );
    }
    if (!artifactIds.has(artifactId)) {
      fail(
        `bound evidence receipt evidenceEntryArtifactIds must cite artifacts present on the record (${artifactId})`,
      );
    }
  }
}

function assertAttestationBindsRecord(
  attestation: EvidenceIntegrityAttestation,
  record: {
    readonly candidateRef: V2BoundEvidenceV1['candidateRef'];
    readonly evidenceManifest: EvidenceManifest;
    readonly artifacts: readonly ArtifactRef[];
  },
): void {
  if (attestation.evidenceManifestId !== record.evidenceManifest.id) {
    fail('bound evidence attestation evidenceManifestId must equal the record manifest id');
  }
  if (attestation.evidenceManifestHash !== record.evidenceManifest.manifestHash) {
    fail('bound evidence attestation evidenceManifestHash must equal the record manifest hash');
  }
  if (
    attestation.candidateRef === null ||
    !candidateRefsEqual(attestation.candidateRef, record.candidateRef)
  ) {
    fail('bound evidence attestation candidateRef must deep-equal the record candidateRef');
  }
  const expectedChecked = record.evidenceManifest.entries.map((entry) => {
    const artifact = record.artifacts.find((item) => item.id === entry.artifactRefId);
    if (artifact === undefined) {
      fail(`bound evidence manifest entry ${entry.artifactRefId} missing from artifacts`);
    }
    return { artifactRefId: artifact.id, sha256: artifact.sha256 };
  });
  if (hashCanonicalJson(attestation.checkedArtifacts) !== hashCanonicalJson(expectedChecked)) {
    fail(
      'bound evidence attestation checkedArtifacts must equal {id, sha256} of every manifest-entry artifact',
    );
  }
}

function assertManifestArtifactBijection(
  manifest: EvidenceManifest,
  artifacts: readonly ArtifactRef[],
): void {
  const manifestIds = new Set(manifest.entries.map((entry) => entry.artifactRefId));
  const artifactIds = new Set(artifacts.map((artifact) => artifact.id));
  for (const id of artifactIds) {
    if (!manifestIds.has(id)) {
      fail(`bound evidence artifact ${id} is not referenced by any manifest entry`);
    }
  }
  for (const id of manifestIds) {
    if (!artifactIds.has(id)) {
      fail(`bound evidence manifest entry ${id} is not present in artifacts`);
    }
  }
}

export function assertV2BoundEvidenceV1(
  value: unknown,
): asserts value is V2BoundEvidenceV1 {
  canonicalSerialize(value);
  if (!isRecord(value) || !exactKeys(value, V2_BOUND_EVIDENCE_KEYS)) {
    fail('V2 bound evidence must use the exact schema');
  }
  if (value['schema'] !== 'hercules-v2-bound-evidence/v1') {
    fail('V2 bound evidence schema must be hercules-v2-bound-evidence/v1');
  }
  boundedText(value['aggregateId'], 'bound evidence aggregateId');
  boundedText(value['iterationId'], 'bound evidence iterationId');
  boundedText(value['recordedAt'], 'bound evidence recordedAt');
  wrapDomainValidation('bound evidence candidateRef', () => {
    assertCandidateRef(value['candidateRef'] as never);
  });
  wrapDomainValidation('bound evidence manifest', () => {
    assertEvidenceManifest(value['evidenceManifest'] as never);
  });
  if (!Array.isArray(value['artifacts'])) {
    fail('V2 bound evidence artifacts must be an array');
  }
  for (const artifact of value['artifacts']) {
    wrapDomainValidation('bound evidence artifact', () => {
      assertArtifactRef(artifact as never);
    });
  }
  wrapDomainValidation('bound evidence manifest artifacts', () => {
    assertEvidenceManifestArtifacts(
      value['evidenceManifest'] as never,
      value['artifacts'] as never,
    );
  });
  assertManifestArtifactBijection(
    value['evidenceManifest'] as EvidenceManifest,
    value['artifacts'] as ArtifactRef[],
  );
  if (!Array.isArray(value['assertions']) || !Array.isArray(value['verificationReceipts'])) {
    fail('V2 bound evidence assertions and verificationReceipts must be arrays');
  }
  for (const assertion of value['assertions']) {
    wrapDomainValidation('bound evidence assertion', () => {
      assertDecisionAssertion(assertion as never);
    });
  }
  for (const receipt of value['verificationReceipts']) {
    wrapDomainValidation('bound evidence verification receipt', () => {
      assertAssertionVerificationReceipt(receipt as never);
    });
  }
  wrapDomainValidation('bound evidence integrity', () => {
    assertEvidenceIntegrityAttestation(value['evidenceIntegrity'] as never);
  });
  const producer = value['producer'];
  if (
    !isRecord(producer) ||
    !exactKeys(producer, ['implementation', 'verifierRunId']) ||
    !isNonEmptyString(producer['implementation']) ||
    !isNonEmptyString(producer['verifierRunId'])
  ) {
    fail('V2 bound evidence producer must use the exact schema');
  }
  const recordView = {
    aggregateId: value['aggregateId'] as string,
    iterationId: value['iterationId'] as string,
    candidateRef: value['candidateRef'] as V2BoundEvidenceV1['candidateRef'],
    evidenceManifest: value['evidenceManifest'] as EvidenceManifest,
    artifacts: value['artifacts'] as ArtifactRef[],
    assertions: value['assertions'] as DecisionAssertion[],
    producer: producer as V2BoundEvidenceV1['producer'],
  };
  for (const receipt of value['verificationReceipts'] as AssertionVerificationReceipt[]) {
    assertReceiptBindsRecord(receipt, recordView);
  }
  assertAttestationBindsRecord(
    value['evidenceIntegrity'] as EvidenceIntegrityAttestation,
    recordView,
  );
  const evidenceHash = value['evidenceHash'];
  if (typeof evidenceHash !== 'string' || !SHA256_RE.test(evidenceHash)) {
    fail('V2 bound evidence evidenceHash is invalid');
  }
  const { evidenceHash: _ignored, ...withoutHash } = value as unknown as V2BoundEvidenceV1;
  if (computeV2BoundEvidenceHash(withoutHash) !== evidenceHash) {
    fail('V2 bound evidence evidenceHash does not match the record');
  }
}

/**
 * Criterion ids justified by bound evidence: union of `criterionIds` on
 * verification receipts whose paired assertion is a gate fact
 * (`subjectKey` starts with `gate:`) with `canonicalPayload.passed === false`.
 */
export function justifiedGateFailureCriterionIds(
  evidence: Pick<V2BoundEvidenceV1, 'assertions' | 'verificationReceipts'>,
): ReadonlySet<string> {
  const assertionsById = new Map(
    evidence.assertions.map((assertion) => [assertion.id, assertion] as const),
  );
  const justified = new Set<string>();
  for (const receipt of evidence.verificationReceipts) {
    const assertion = assertionsById.get(receipt.assertionId);
    if (assertion === undefined) continue;
    if (!assertion.subjectKey.startsWith('gate:')) continue;
    if (assertion.kind !== 'fact') continue;
    if (!isRecord(assertion.canonicalPayload)) continue;
    if (assertion.canonicalPayload['passed'] !== false) continue;
    for (const criterionId of receipt.criterionIds) {
      justified.add(criterionId);
    }
  }
  return justified;
}

/**
 * `evaluation.verdict` must equal `receipt.verdict` on every field EXCEPT
 * `criterionResults[].status/explanation` and `blockingFindings[].criterionIds`
 * — and only for findings whose `code === 'deterministic_gate_failed'` and
 * whose receipt-side `criterionIds` were empty (C3.3 gate-failure attribution).
 *
 * When `justifiedCriterionIds` is provided (bind path), every attributed id
 * must be justified by a failing gate fact on the bound evidence; attribution
 * is refused when the justified set is empty; attributed criterion status may
 * differ from the receipt only as `fail`.
 */
export function assertBoundEvaluationVerdictAttribution(
  evaluationVerdict: EvaluationVerdict,
  receiptVerdict: EvaluationVerdict,
  justifiedCriterionIds?: ReadonlySet<string>,
): void {
  if (evaluationVerdict.id !== receiptVerdict.id) {
    fail('bound evaluation evaluation.verdict.id must equal receipt.verdict.id');
  }
  if (
    hashCanonicalJson(evaluationVerdict.binding) !==
    hashCanonicalJson(receiptVerdict.binding)
  ) {
    fail('bound evaluation evaluation.verdict.binding must equal receipt.verdict.binding');
  }
  if (evaluationVerdict.outcome !== receiptVerdict.outcome) {
    fail('bound evaluation evaluation.verdict.outcome must equal receipt.verdict.outcome');
  }
  if (evaluationVerdict.recommendedNextStage !== receiptVerdict.recommendedNextStage) {
    fail(
      'bound evaluation evaluation.verdict.recommendedNextStage must equal receipt.verdict.recommendedNextStage',
    );
  }
  if (evaluationVerdict.evaluatorAgentRunId !== receiptVerdict.evaluatorAgentRunId) {
    fail(
      'bound evaluation evaluation.verdict.evaluatorAgentRunId must equal receipt.verdict.evaluatorAgentRunId',
    );
  }
  if (evaluationVerdict.createdAt !== receiptVerdict.createdAt) {
    fail('bound evaluation evaluation.verdict.createdAt must equal receipt.verdict.createdAt');
  }
  if (
    hashCanonicalJson(evaluationVerdict.nonBlockingRisks) !==
    hashCanonicalJson(receiptVerdict.nonBlockingRisks)
  ) {
    fail(
      'bound evaluation evaluation.verdict.nonBlockingRisks must equal receipt.verdict.nonBlockingRisks',
    );
  }

  const evalCodes = [...evaluationVerdict.blockingFindings.map((finding) => finding.code)].sort();
  const receiptCodes = [...receiptVerdict.blockingFindings.map((finding) => finding.code)].sort();
  if (hashCanonicalJson(evalCodes) !== hashCanonicalJson(receiptCodes)) {
    fail('bound evaluation blocking finding codes must equal receipt finding codes');
  }

  const attributedCriterionIds = new Set<string>();
  for (const receiptFinding of receiptVerdict.blockingFindings) {
    const evalFinding = evaluationVerdict.blockingFindings.find(
      (finding) => finding.code === receiptFinding.code,
    );
    if (evalFinding === undefined) {
      fail(`bound evaluation missing blocking finding ${receiptFinding.code}`);
    }
    if (evalFinding.summary !== receiptFinding.summary) {
      fail(
        `bound evaluation blocking finding ${receiptFinding.code} summary must equal the receipt`,
      );
    }
    const attributionAllowed =
      receiptFinding.code === 'deterministic_gate_failed' &&
      receiptFinding.criterionIds.length === 0;
    if (attributionAllowed) {
      if (
        justifiedCriterionIds !== undefined &&
        evalFinding.criterionIds.length > 0 &&
        justifiedCriterionIds.size === 0
      ) {
        fail(
          'bound evaluation cannot attribute deterministic_gate_failed when no failing gate evidence justifies it',
        );
      }
      for (const criterionId of evalFinding.criterionIds) {
        if (
          justifiedCriterionIds !== undefined &&
          !justifiedCriterionIds.has(criterionId)
        ) {
          fail(
            `bound evaluation attributed criterion ${criterionId} is not justified by failing gate evidence`,
          );
        }
        attributedCriterionIds.add(criterionId);
      }
    } else if (
      hashCanonicalJson(evalFinding.criterionIds) !==
      hashCanonicalJson(receiptFinding.criterionIds)
    ) {
      fail(
        `bound evaluation blocking finding ${receiptFinding.code} criterionIds must equal the receipt`,
      );
    }
  }

  if (
    evaluationVerdict.criterionResults.length !== receiptVerdict.criterionResults.length
  ) {
    fail('bound evaluation criterionResults length must equal the receipt');
  }
  for (const receiptResult of receiptVerdict.criterionResults) {
    const evalResult = evaluationVerdict.criterionResults.find(
      (result) => result.criterionId === receiptResult.criterionId,
    );
    if (evalResult === undefined) {
      fail(
        `bound evaluation missing criterionResult ${receiptResult.criterionId}`,
      );
    }
    if (evalResult.authority !== receiptResult.authority) {
      fail(
        `bound evaluation criterion ${receiptResult.criterionId} authority must equal the receipt`,
      );
    }
    if (
      hashCanonicalJson(evalResult.evidenceRefs) !==
      hashCanonicalJson(receiptResult.evidenceRefs)
    ) {
      fail(
        `bound evaluation criterion ${receiptResult.criterionId} evidenceRefs must equal the receipt`,
      );
    }
    if (evalResult.observedAt !== receiptResult.observedAt) {
      fail(
        `bound evaluation criterion ${receiptResult.criterionId} observedAt must equal the receipt`,
      );
    }
    if (evalResult.candidateBinding !== receiptResult.candidateBinding) {
      fail(
        `bound evaluation criterion ${receiptResult.criterionId} candidateBinding must equal the receipt`,
      );
    }
    if (attributedCriterionIds.has(receiptResult.criterionId)) {
      if (evalResult.status !== 'fail') {
        fail(
          `bound evaluation attributed criterion ${receiptResult.criterionId} status may only rewrite to fail`,
        );
      }
    } else if (
      evalResult.status !== receiptResult.status ||
      evalResult.explanation !== receiptResult.explanation
    ) {
      fail(
        `bound evaluation criterion ${receiptResult.criterionId} status/explanation must equal the receipt`,
      );
    }
  }
}

export function assertV2BoundEvaluationV1(
  value: unknown,
): asserts value is V2BoundEvaluationV1 {
  canonicalSerialize(value);
  if (!isRecord(value) || !exactKeys(value, V2_BOUND_EVALUATION_KEYS)) {
    fail('V2 bound evaluation must use the exact schema');
  }
  if (value['schema'] !== 'hercules-v2-bound-evaluation/v1') {
    fail('V2 bound evaluation schema must be hercules-v2-bound-evaluation/v1');
  }
  boundedText(value['aggregateId'], 'bound evaluation aggregateId');
  boundedText(value['iterationId'], 'bound evaluation iterationId');
  boundedText(value['recordedAt'], 'bound evaluation recordedAt');
  const evidenceHash = value['evidenceHash'];
  if (typeof evidenceHash !== 'string' || !SHA256_RE.test(evidenceHash)) {
    fail('V2 bound evaluation evidenceHash is invalid');
  }
  wrapDomainValidation('bound evaluation receipt', () => {
    assertIndependentEvaluationReceiptV1(value['receipt'] as IndependentEvaluationReceiptV1);
  });
  assertEvaluationDecisionRecordV2(value['evaluation']);
  const record = value as unknown as V2BoundEvaluationV1;
  assertBoundEvaluationVerdictAttribution(
    record.evaluation.verdict,
    record.receipt.verdict,
  );
  const evaluator = value['evaluator'];
  if (
    !isRecord(evaluator) ||
    !exactKeys(evaluator, ['runId', 'implementationId', 'version', 'model', 'runtime']) ||
    !isNonEmptyString(evaluator['runId']) ||
    !isNonEmptyString(evaluator['implementationId']) ||
    !isNonEmptyString(evaluator['version']) ||
    !isNonEmptyString(evaluator['runtime']) ||
    !(evaluator['model'] === null || isNonEmptyString(evaluator['model']))
  ) {
    fail('V2 bound evaluation evaluator must use the exact schema');
  }
  const evaluationHash = value['evaluationHash'];
  if (typeof evaluationHash !== 'string' || !SHA256_RE.test(evaluationHash)) {
    fail('V2 bound evaluation evaluationHash is invalid');
  }
  const { evaluationHash: _ignored, ...withoutHash } = value as unknown as V2BoundEvaluationV1;
  if (computeV2BoundEvaluationHash(withoutHash) !== evaluationHash) {
    fail('V2 bound evaluation evaluationHash does not match the record');
  }
}
