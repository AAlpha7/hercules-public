export type OutcomeReviewPreference = 'legacy' | 'outcome_v2' | 'control_v2';

export interface ReviewExperienceCapabilitiesV1 {
  readonly schema: 'hercules-review-experience-capabilities/v1';
  readonly outcomeReviewRead: boolean;
  readonly boundDecisions: boolean;
  readonly evidenceContent: boolean;
  readonly learningProposals: boolean;
  readonly controlApiV2: boolean;
}

export type OutcomeReviewLoadState =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'loading'; readonly taskId: string; readonly requestId: number }
  | {
      readonly kind: 'available';
      readonly taskId: string;
      readonly package: ReviewPackageV2Dto;
      /** 'legacy' = legacy read route; 'control_v2' = Control API review view; 'control_v2_fallback' = control returned 404 unknown_aggregate and the legacy package is shown. */
      readonly source: 'legacy' | 'control_v2' | 'control_v2_fallback';
      readonly stateVersion: number | null;
    }
  | { readonly kind: 'unavailable'; readonly taskId: string; readonly reason: string }
  | { readonly kind: 'stale'; readonly taskId: string; readonly message: string };

export type AssertionClassification =
  | 'verified'
  | 'inference'
  | 'unverified_pending'
  | 'opinion';
export type ReviewAxisStatus =
  | 'verified'
  | 'failed'
  | 'need_more_evidence'
  | 'needs_human'
  | 'not_applicable';
export type CriterionStatus =
  | 'pass'
  | 'fail'
  | 'need_more_evidence'
  | 'needs_human'
  | 'not_applicable';
export type OutcomeStatus = 'pass' | 'fail' | 'need_more_evidence' | 'needs_human';
export type OutcomeDecision = 'approve_outcome' | 'reject_outcome' | 'request_changes';
export type ReviewReasonCode = (typeof REVIEW_REASON_CODES)[number];

export type CandidateRefDto =
  | { readonly kind: 'git'; readonly repository: string; readonly revision: string }
  | { readonly kind: 'artifact'; readonly artifactId: string; readonly sha256: string }
  | {
      readonly kind: 'external';
      readonly system: string;
      readonly version: string;
      readonly digest: string;
    };

export interface DecisionBindingDto {
  readonly taskId: string;
  readonly contractVersion: number;
  readonly contractHash: string;
  readonly iterationId: string | null;
  readonly candidateRef: CandidateRefDto | null;
  readonly evidenceManifestHash: string | null;
  readonly evaluatorVersion: string;
  readonly evaluatorModel: string | null;
  readonly evaluatorRuntime: string;
  readonly policyVersion: string;
}

export interface ReviewBindingDto extends DecisionBindingDto {
  readonly iterationId: string;
  readonly evidenceManifestId: string | null;
}

export interface AssertionProjectionDto {
  readonly id: string;
  readonly subjectKey: string;
  readonly payloadHash: string;
  readonly classification: AssertionClassification;
  readonly decisionEligible: boolean;
  readonly usedByCriterionIds: readonly string[];
  readonly evidenceArtifactIds: readonly string[];
  readonly receiptIds: readonly string[];
  readonly reasonCodes: readonly ReviewReasonCode[];
  readonly advisoryText: string | null;
}

export interface ReviewTrustAxisDto {
  readonly status: ReviewAxisStatus;
  readonly assertionIds: readonly string[];
  readonly evidenceArtifactIds: readonly string[];
  readonly reasonCodes: readonly ReviewReasonCode[];
}

export interface CriterionResultDto {
  readonly criterionId: string;
  readonly authority: 'mechanical' | 'verifier' | 'evaluator' | 'human';
  readonly required: boolean;
  readonly status: CriterionStatus;
  readonly assertionIds: readonly string[];
  readonly evidenceArtifactIds: readonly string[];
  readonly reasonCodes: readonly ReviewReasonCode[];
  readonly advisoryExplanation: string;
}

export interface EvidenceSummaryDto {
  readonly artifactRefId: string;
  readonly sha256: string;
  readonly trustClass: 'primary' | 'derived' | 'agent_claim';
  readonly redactionState: 'none' | 'redacted' | 'restricted';
  readonly criterionIds: readonly string[];
  readonly surface: string;
  readonly supportsAssertionIds: readonly string[];
}

export interface FindingDto {
  readonly code: string;
  readonly criterionIds: readonly string[];
  readonly assertionIds: readonly string[];
  readonly classification: 'verified' | 'unverified_pending';
  readonly reasonCodes: readonly ReviewReasonCode[];
  readonly advisorySummary: string;
}

export interface IterationSummaryDto {
  readonly id: string;
  readonly ordinal: number;
  readonly state: 'planned' | 'executing' | 'verifying' | 'evaluating' | 'passed' | 'failed' | 'abandoned';
  readonly candidateRef: CandidateRefDto | null;
  readonly evidenceManifestId: string | null;
  readonly finalVerdictId: string | null;
  readonly createdAt: string;
  readonly endedAt: string | null;
}

export interface RequiredDecisionDto {
  readonly kinds: readonly OutcomeDecision[];
  readonly policyDecisionIds: readonly string[];
  readonly reasonCodes: readonly ReviewReasonCode[];
}

export interface ReviewPackageV2Dto {
  readonly schema: 'hercules-review-package/v2';
  readonly projectionHash: string;
  readonly projectedAt: string;
  readonly task: {
    readonly id: string;
    readonly title: string;
    readonly objective: string;
    readonly state: string;
    readonly advisoryTextAuthority: 'advisory';
  };
  readonly binding: ReviewBindingDto;
  readonly outcome: {
    readonly status: OutcomeStatus;
    readonly evaluatorOutcome: 'pass' | 'fail' | 'need_more_evidence' | null;
    readonly decisionEligible: boolean;
    readonly reasonCodes: readonly ReviewReasonCode[];
    readonly advisorySummary: string;
  };
  readonly assertions: readonly AssertionProjectionDto[];
  readonly trustAxes: {
    readonly contractBinding: ReviewTrustAxisDto;
    readonly mechanical: ReviewTrustAxisDto;
    readonly realSurface: ReviewTrustAxisDto;
    readonly independentReview: ReviewTrustAxisDto;
    readonly independentEvaluation: ReviewTrustAxisDto;
    readonly human: ReviewTrustAxisDto;
  };
  readonly criteria: readonly CriterionResultDto[];
  readonly evidence: readonly EvidenceSummaryDto[];
  readonly blockingFindings: readonly FindingDto[];
  readonly remainingRisks: readonly FindingDto[];
  readonly iterations: readonly IterationSummaryDto[];
  readonly requiredDecision: RequiredDecisionDto | null;
  readonly validDecisions: readonly OutcomeDecision[];
  readonly decisionBinding: DecisionBindingDto | null;
  readonly decisionToken: null;
  readonly usage: {
    readonly durationMs: number;
    readonly tokens: number;
    readonly costUsd: number;
  } | null;
}

export class ReviewDtoDecodeError extends Error {
  override readonly name = 'ReviewDtoDecodeError';
}

const MAX_IDENTIFIER_BYTES = 256;
const MAX_TEXT_BYTES = 8 * 1024;
const MAX_ARRAY_ITEMS = 4_096;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const encoder = new TextEncoder();

const REVIEW_REASON_CODES = [
  'integrity_unavailable',
  'evidence_missing',
  'evidence_tampered',
  'non_primary_evidence',
  'self_report',
  'receipt_missing',
  'receipt_stale',
  'receipt_hash_mismatch',
  'assertion_binding_mismatch',
  'receipt_coverage_mismatch',
  'observation_mismatch',
  'value_mismatch',
  'structured_contradiction',
  'evaluation_missing',
  'evaluation_stale',
  'evaluation_incomplete',
  'evaluation_premise_ineligible',
  'criterion_failed',
  'blocking_finding',
  'human_decision_required',
  'human_decision_stale',
  'human_decision_conflict',
  'human_rejected',
  'unsupported_policy_decision',
  'review_axis_deferred',
] as const;

const DECISION_BLOCKING_REASONS: readonly ReviewReasonCode[] = [
  'integrity_unavailable',
  'evidence_missing',
  'evidence_tampered',
  'non_primary_evidence',
  'self_report',
  'receipt_missing',
  'receipt_stale',
  'receipt_hash_mismatch',
  'assertion_binding_mismatch',
  'receipt_coverage_mismatch',
  'observation_mismatch',
  'value_mismatch',
  'structured_contradiction',
  'evaluation_missing',
  'evaluation_stale',
  'evaluation_incomplete',
  'evaluation_premise_ineligible',
  'human_decision_conflict',
  'unsupported_policy_decision',
];

const ACTIONABLE_FAIL_REASONS: readonly ReviewReasonCode[] = [
  'criterion_failed',
  'blocking_finding',
  'human_rejected',
];

function reject(message: string): never {
  throw new ReviewDtoDecodeError(message);
}

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    reject(`${label} must be an object`);
  }
  const actual = Object.getOwnPropertyNames(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    reject(`${label} must use the exact closed schema`);
  }
  return value as Record<string, unknown>;
}

function bytes(value: string): number {
  return encoder.encode(value).length;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || bytes(value) < 1 || bytes(value) > MAX_IDENTIFIER_BYTES) {
    reject(`${label} must be a bounded identity`);
  }
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || bytes(value) > MAX_TEXT_BYTES) {
    reject(`${label} must be bounded text`);
  }
  return value;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') reject(`${label} must be boolean`);
  return value;
}

function finiteNonNegative(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    reject(`${label} must be finite and non-negative`);
  }
  return value;
}

function member<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    reject(`${label} is invalid`);
  }
  return value as T;
}

function denseArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) reject(`${label} must be bounded`);
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) reject(`${label} cannot be sparse`);
  }
  return value;
}

function ids(value: unknown, label: string, sortedUnique = true): string[] {
  const result = denseArray(value, label).map((item) => identifier(item, label));
  if (sortedUnique && result.some((item, index) => index > 0 && result[index - 1]! >= item)) {
    reject(`${label} must be sorted and unique`);
  }
  return result;
}

function reasons(value: unknown, label: string): ReviewReasonCode[] {
  const input = denseArray(value, label);
  const result = input.map((item) => member(item, REVIEW_REASON_CODES, label));
  const expected = REVIEW_REASON_CODES.filter((reason) => result.includes(reason));
  if (result.length !== expected.length || result.some((reason, index) => reason !== expected[index])) {
    reject(`${label} must use declared unique order`);
  }
  return result;
}

function timestamp(value: unknown, label: string): string {
  const result = identifier(value, label);
  const parsed = new Date(result);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== result) reject(`${label} is invalid`);
  return result;
}

function nullableIdentifier(value: unknown, label: string): string | null {
  return value === null ? null : identifier(value, label);
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function decodeCandidate(value: unknown, label: string): CandidateRefDto {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject(`${label} is invalid`);
  const kind = member((value as Record<string, unknown>)['kind'], ['git', 'artifact', 'external'], `${label} kind`);
  if (kind === 'git') {
    const row = record(value, ['kind', 'repository', 'revision'], label);
    return { kind, repository: identifier(row['repository'], label), revision: identifier(row['revision'], label) };
  }
  if (kind === 'artifact') {
    const row = record(value, ['kind', 'artifactId', 'sha256'], label);
    return { kind, artifactId: identifier(row['artifactId'], label), sha256: identifier(row['sha256'], label) };
  }
  const row = record(value, ['kind', 'system', 'version', 'digest'], label);
  return {
    kind,
    system: identifier(row['system'], label),
    version: identifier(row['version'], label),
    digest: identifier(row['digest'], label),
  };
}

const BINDING_KEYS = [
  'taskId', 'contractVersion', 'contractHash', 'iterationId', 'candidateRef',
  'evidenceManifestHash', 'evaluatorVersion', 'evaluatorModel', 'evaluatorRuntime', 'policyVersion',
] as const;

function decodeBinding(value: unknown, label: string): DecisionBindingDto {
  const row = record(value, BINDING_KEYS, label);
  const contractVersion = row['contractVersion'];
  if (!Number.isSafeInteger(contractVersion) || (contractVersion as number) < 1) {
    reject(`${label} contractVersion is invalid`);
  }
  return {
    taskId: identifier(row['taskId'], label),
    contractVersion: contractVersion as number,
    contractHash: identifier(row['contractHash'], label),
    iterationId: nullableIdentifier(row['iterationId'], label),
    candidateRef: row['candidateRef'] === null ? null : decodeCandidate(row['candidateRef'], `${label} candidate`),
    evidenceManifestHash: nullableIdentifier(row['evidenceManifestHash'], label),
    evaluatorVersion: identifier(row['evaluatorVersion'], label),
    evaluatorModel: nullableIdentifier(row['evaluatorModel'], label),
    evaluatorRuntime: identifier(row['evaluatorRuntime'], label),
    policyVersion: identifier(row['policyVersion'], label),
  };
}

function decodeAxis(value: unknown, label: string): ReviewTrustAxisDto {
  const row = record(value, ['status', 'assertionIds', 'evidenceArtifactIds', 'reasonCodes'], label);
  return {
    status: member(row['status'], ['verified', 'failed', 'need_more_evidence', 'needs_human', 'not_applicable'], label),
    assertionIds: ids(row['assertionIds'], label),
    evidenceArtifactIds: ids(row['evidenceArtifactIds'], label),
    reasonCodes: reasons(row['reasonCodes'], label),
  };
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function bindingIdentity(binding: ReviewBindingDto): DecisionBindingDto {
  const { evidenceManifestId: _evidenceManifestId, ...identity } = binding;
  return identity;
}

export function isOutcomeReviewPreference(value: unknown): value is OutcomeReviewPreference {
  return value === 'legacy' || value === 'outcome_v2' || value === 'control_v2';
}

export function decodeReviewExperienceCapabilitiesV1(value: unknown): ReviewExperienceCapabilitiesV1 {
  const row = record(
    value,
    ['schema', 'outcomeReviewRead', 'boundDecisions', 'evidenceContent', 'learningProposals', 'controlApiV2'],
    'review capabilities',
  );
  if (row['schema'] !== 'hercules-review-experience-capabilities/v1') reject('review capabilities schema is invalid');
  return {
    schema: 'hercules-review-experience-capabilities/v1',
    outcomeReviewRead: bool(row['outcomeReviewRead'], 'outcomeReviewRead'),
    boundDecisions: bool(row['boundDecisions'], 'boundDecisions'),
    evidenceContent: bool(row['evidenceContent'], 'evidenceContent'),
    learningProposals: bool(row['learningProposals'], 'learningProposals'),
    controlApiV2: bool(row['controlApiV2'], 'controlApiV2'),
  };
}

export function decodeReviewPackageV2(value: unknown): ReviewPackageV2Dto {
  const root = record(value, [
    'schema', 'projectionHash', 'projectedAt', 'task', 'binding', 'outcome', 'assertions',
    'trustAxes', 'criteria', 'evidence', 'blockingFindings', 'remainingRisks', 'iterations',
    'requiredDecision', 'validDecisions', 'decisionBinding', 'decisionToken', 'usage',
  ], 'review package');
  if (root['schema'] !== 'hercules-review-package/v2' || typeof root['projectionHash'] !== 'string' || !SHA256.test(root['projectionHash'])) {
    reject('review package schema or projection hash is invalid');
  }
  timestamp(root['projectedAt'], 'projectedAt');

  const task = record(root['task'], ['id', 'title', 'objective', 'state', 'advisoryTextAuthority'], 'task');
  identifier(task['id'], 'task id');
  text(task['title'], 'task title');
  text(task['objective'], 'task objective');
  identifier(task['state'], 'task state');
  if (task['advisoryTextAuthority'] !== 'advisory') reject('task text authority is invalid');

  const bindingRow = record(root['binding'], [...BINDING_KEYS, 'evidenceManifestId'], 'review binding');
  const binding = decodeBinding(
    Object.fromEntries(BINDING_KEYS.map((key) => [key, bindingRow[key]])),
    'review binding',
  ) as ReviewBindingDto;
  if (binding.iterationId === null) reject('review binding requires an iteration');
  const reviewBinding: ReviewBindingDto = {
    ...binding,
    iterationId: binding.iterationId,
    evidenceManifestId: nullableIdentifier(bindingRow['evidenceManifestId'], 'manifest id'),
  };
  if ((reviewBinding.evidenceManifestId === null) !== (reviewBinding.evidenceManifestHash === null)) {
    reject('manifest identity and hash must agree');
  }
  if (task['id'] !== reviewBinding.taskId) {
    reject('review task and binding must agree');
  }

  const outcome = record(root['outcome'], ['status', 'evaluatorOutcome', 'decisionEligible', 'reasonCodes', 'advisorySummary'], 'outcome');
  const outcomeStatus = member(outcome['status'], ['pass', 'fail', 'need_more_evidence', 'needs_human'], 'outcome status');
  const evaluatorOutcome = outcome['evaluatorOutcome'] === null
    ? null
    : member(outcome['evaluatorOutcome'], ['pass', 'fail', 'need_more_evidence'], 'evaluator outcome');
  const decisionEligible = bool(outcome['decisionEligible'], 'decision eligibility');
  const outcomeReasons = reasons(outcome['reasonCodes'], 'outcome reasons');
  if (outcome['advisorySummary'] !== outcomeStatus) reject('outcome advisory summary is invalid');

  const assertionRows = denseArray(root['assertions'], 'assertions');
  const assertions: AssertionProjectionDto[] = assertionRows.map((item, index) => {
    const row = record(item, ['id', 'subjectKey', 'payloadHash', 'classification', 'decisionEligible', 'usedByCriterionIds', 'evidenceArtifactIds', 'receiptIds', 'reasonCodes', 'advisoryText'], `assertion ${index}`);
    const classification = member(row['classification'], ['verified', 'inference', 'unverified_pending', 'opinion'], `assertion ${index}`);
    const eligible = bool(row['decisionEligible'], `assertion ${index}`);
    if (eligible !== (classification === 'verified')) reject(`assertion ${index} eligibility is invalid`);
    const evidenceArtifactIds = ids(row['evidenceArtifactIds'], `assertion ${index} evidence`);
    const receiptIds = ids(row['receiptIds'], `assertion ${index} receipts`);
    if (classification === 'verified' ? evidenceArtifactIds.length === 0 || receiptIds.length === 0 : evidenceArtifactIds.length > 0 || receiptIds.length > 0) {
      reject(`assertion ${index} support is invalid`);
    }
    if (typeof row['payloadHash'] !== 'string' || !SHA256.test(row['payloadHash'])) reject(`assertion ${index} payload hash is invalid`);
    return {
      id: identifier(row['id'], `assertion ${index} id`),
      subjectKey: identifier(row['subjectKey'], `assertion ${index} subject`),
      payloadHash: row['payloadHash'],
      classification,
      decisionEligible: eligible,
      usedByCriterionIds: ids(row['usedByCriterionIds'], `assertion ${index} criteria`),
      evidenceArtifactIds,
      receiptIds,
      reasonCodes: reasons(row['reasonCodes'], `assertion ${index} reasons`),
      advisoryText: row['advisoryText'] === null ? null : text(row['advisoryText'], `assertion ${index} text`),
    };
  });
  if (assertions.some((item, index) => index > 0 && assertions[index - 1]!.id >= item.id)) reject('assertions must be sorted and unique');

  const axesRow = record(root['trustAxes'], ['contractBinding', 'mechanical', 'realSurface', 'independentReview', 'independentEvaluation', 'human'], 'trust axes');
  const trustAxes = {
    contractBinding: decodeAxis(axesRow['contractBinding'], 'contract binding axis'),
    mechanical: decodeAxis(axesRow['mechanical'], 'mechanical axis'),
    realSurface: decodeAxis(axesRow['realSurface'], 'real surface axis'),
    independentReview: decodeAxis(axesRow['independentReview'], 'independent review axis'),
    independentEvaluation: decodeAxis(axesRow['independentEvaluation'], 'independent evaluation axis'),
    human: decodeAxis(axesRow['human'], 'human axis'),
  };

  const criteria = denseArray(root['criteria'], 'criteria').map((item, index): CriterionResultDto => {
    const row = record(item, ['criterionId', 'authority', 'required', 'status', 'assertionIds', 'evidenceArtifactIds', 'reasonCodes', 'advisoryExplanation'], `criterion ${index}`);
    return {
      criterionId: identifier(row['criterionId'], `criterion ${index} id`),
      authority: member(row['authority'], ['mechanical', 'verifier', 'evaluator', 'human'], `criterion ${index} authority`),
      required: bool(row['required'], `criterion ${index} required`),
      status: member(row['status'], ['pass', 'fail', 'need_more_evidence', 'needs_human', 'not_applicable'], `criterion ${index} status`),
      assertionIds: ids(row['assertionIds'], `criterion ${index} assertions`),
      evidenceArtifactIds: ids(row['evidenceArtifactIds'], `criterion ${index} evidence`),
      reasonCodes: reasons(row['reasonCodes'], `criterion ${index} reasons`),
      advisoryExplanation: text(row['advisoryExplanation'], `criterion ${index} explanation`),
    };
  });
  if (new Set(criteria.map((item) => item.criterionId)).size !== criteria.length) reject('criterion ids must be unique');

  const evidence = denseArray(root['evidence'], 'evidence').map((item, index): EvidenceSummaryDto => {
    const row = record(item, ['artifactRefId', 'sha256', 'trustClass', 'redactionState', 'criterionIds', 'surface', 'supportsAssertionIds'], `evidence ${index}`);
    if (typeof row['sha256'] !== 'string' || !SHA256.test(row['sha256'])) reject(`evidence ${index} hash is invalid`);
    return {
      artifactRefId: identifier(row['artifactRefId'], `evidence ${index} id`),
      sha256: row['sha256'],
      trustClass: member(row['trustClass'], ['primary', 'derived', 'agent_claim'], `evidence ${index} trust`),
      redactionState: member(row['redactionState'], ['none', 'redacted', 'restricted'], `evidence ${index} redaction`),
      criterionIds: ids(row['criterionIds'], `evidence ${index} criteria`),
      surface: identifier(row['surface'], `evidence ${index} surface`),
      supportsAssertionIds: ids(row['supportsAssertionIds'], `evidence ${index} assertions`),
    };
  });
  if (evidence.some((item, index) => index > 0 && evidence[index - 1]!.artifactRefId >= item.artifactRefId)) reject('evidence must be sorted and unique');

  const decodeFindings = (value: unknown, label: string): FindingDto[] => {
    const result = denseArray(value, label).map((item, index): FindingDto => {
      const row = record(item, ['code', 'criterionIds', 'assertionIds', 'classification', 'reasonCodes', 'advisorySummary'], `${label} ${index}`);
      return {
        code: identifier(row['code'], `${label} ${index} code`),
        criterionIds: ids(row['criterionIds'], `${label} ${index} criteria`),
        assertionIds: ids(row['assertionIds'], `${label} ${index} assertions`),
        classification: member(row['classification'], ['verified', 'unverified_pending'], `${label} ${index} classification`),
        reasonCodes: reasons(row['reasonCodes'], `${label} ${index} reasons`),
        advisorySummary: text(row['advisorySummary'], `${label} ${index} summary`),
      };
    });
    if (result.some((item, index) => index > 0 && result[index - 1]!.code >= item.code)) reject(`${label} must be sorted and unique`);
    return result;
  };
  const blockingFindings = decodeFindings(root['blockingFindings'], 'blocking findings');
  const remainingRisks = decodeFindings(root['remainingRisks'], 'remaining risks');
  const findingCodes = [...blockingFindings, ...remainingRisks].map((item) => item.code);
  if (new Set(findingCodes).size !== findingCodes.length) reject('finding codes must be unique');

  const iterations = denseArray(root['iterations'], 'iterations').map((item, index): IterationSummaryDto => {
    const row = record(item, ['id', 'ordinal', 'state', 'candidateRef', 'evidenceManifestId', 'finalVerdictId', 'createdAt', 'endedAt'], `iteration ${index}`);
    if (!Number.isSafeInteger(row['ordinal']) || row['ordinal'] !== index + 1) reject(`iteration ${index} ordinal is invalid`);
    return {
      id: identifier(row['id'], `iteration ${index} id`),
      ordinal: row['ordinal'] as number,
      state: member(row['state'], ['planned', 'executing', 'verifying', 'evaluating', 'passed', 'failed', 'abandoned'], `iteration ${index} state`),
      candidateRef: row['candidateRef'] === null ? null : decodeCandidate(row['candidateRef'], `iteration ${index} candidate`),
      evidenceManifestId: nullableIdentifier(row['evidenceManifestId'], `iteration ${index} manifest`),
      finalVerdictId: nullableIdentifier(row['finalVerdictId'], `iteration ${index} verdict`),
      createdAt: timestamp(row['createdAt'], `iteration ${index} createdAt`),
      endedAt: nullableTimestamp(row['endedAt'], `iteration ${index} endedAt`),
    };
  });
  if (iterations.length === 0 || new Set(iterations.map((item) => item.id)).size !== iterations.length) reject('iterations must be non-empty and unique');

  const requiredDecision = root['requiredDecision'] === null ? null : (() => {
    const row = record(root['requiredDecision'], ['kinds', 'policyDecisionIds', 'reasonCodes'], 'required decision');
    return {
      kinds: denseArray(row['kinds'], 'required decision kinds').map((item) => member(item, ['approve_outcome', 'reject_outcome', 'request_changes'], 'required decision kind')),
      policyDecisionIds: ids(row['policyDecisionIds'], 'required policy ids', false),
      reasonCodes: reasons(row['reasonCodes'], 'required decision reasons'),
    } satisfies RequiredDecisionDto;
  })();
  const validDecisions: OutcomeDecision[] = denseArray(
    root['validDecisions'],
    'valid decisions',
  ).map((item) =>
    member(
      item,
      ['approve_outcome', 'reject_outcome', 'request_changes'] as const,
      'valid decision',
    ),
  );
  const decisionBinding = root['decisionBinding'] === null ? null : decodeBinding(root['decisionBinding'], 'decision binding');
  if (root['decisionToken'] !== null) reject('decision token must be null');
  const usage = root['usage'] === null ? null : (() => {
    const row = record(root['usage'], ['durationMs', 'tokens', 'costUsd'], 'usage');
    return {
      durationMs: finiteNonNegative(row['durationMs'], 'usage duration'),
      tokens: finiteNonNegative(row['tokens'], 'usage tokens'),
      costUsd: finiteNonNegative(row['costUsd'], 'usage cost'),
    };
  })();

  const assertionIds = new Set(assertions.map((item) => item.id));
  const criterionIds = new Set(criteria.map((item) => item.criterionId));
  const evidenceIds = new Set(evidence.map((item) => item.artifactRefId));
  const known = (values: readonly string[], set: ReadonlySet<string>, label: string) => {
    if (values.some((item) => !set.has(item))) reject(`${label} contains an unknown id`);
  };
  for (const assertion of assertions) {
    known(assertion.usedByCriterionIds, criterionIds, 'assertion criteria');
    known(assertion.evidenceArtifactIds, evidenceIds, 'assertion evidence');
  }
  for (const criterion of criteria) {
    known(criterion.assertionIds, assertionIds, 'criterion assertions');
    known(criterion.evidenceArtifactIds, evidenceIds, 'criterion evidence');
  }
  for (const item of evidence) {
    known(item.criterionIds, criterionIds, 'evidence criteria');
    known(item.supportsAssertionIds, assertionIds, 'evidence assertions');
    const inverse = assertions.filter((assertion) => assertion.evidenceArtifactIds.includes(item.artifactRefId)).map((assertion) => assertion.id);
    if (!equalJson(item.supportsAssertionIds, inverse)) reject('evidence support inverse is invalid');
  }
  for (const finding of [...blockingFindings, ...remainingRisks]) {
    known(finding.criterionIds, criterionIds, 'finding criteria');
    known(finding.assertionIds, assertionIds, 'finding assertions');
  }
  for (const axis of Object.values(trustAxes)) {
    known(axis.assertionIds, assertionIds, 'axis assertions');
    known(axis.evidenceArtifactIds, evidenceIds, 'axis evidence');
  }

  const current = iterations.at(-1)!;
  if (current.id !== reviewBinding.iterationId || current.evidenceManifestId !== reviewBinding.evidenceManifestId || !equalJson(current.candidateRef, reviewBinding.candidateRef)) {
    reject('current iteration and binding must agree');
  }
  const expectedDecisions: readonly OutcomeDecision[] = outcomeStatus === 'needs_human'
    ? ['approve_outcome', 'reject_outcome', 'request_changes']
    : outcomeStatus === 'pass' || outcomeStatus === 'fail'
      ? ['request_changes']
      : [];
  if (decisionEligible !== (validDecisions.length > 0) || !equalJson(validDecisions, decisionEligible ? expectedDecisions : [])) {
    reject('outcome eligibility and actions are inconsistent');
  }
  if ((decisionBinding !== null) !== decisionEligible || (decisionBinding !== null && !equalJson(decisionBinding, bindingIdentity(reviewBinding)))) {
    reject('decision binding and eligibility are inconsistent');
  }
  if (outcomeStatus === 'pass' && (outcomeReasons.length > 0 || criteria.some((item) => item.required && item.status !== 'pass'))) {
    reject('pass outcome contains a required failure or gap');
  }
  if (outcomeStatus === 'need_more_evidence' && decisionEligible) reject('need-more-evidence cannot be actionable');
  if (outcomeStatus === 'needs_human' && (requiredDecision === null || !equalJson(requiredDecision.kinds, expectedDecisions))) {
    reject('needs-human requires the exact decision table');
  }
  if (decisionEligible && outcomeStatus !== 'needs_human' && requiredDecision !== null) reject('non-human actionable outcome cannot require a decision');

  if (decisionEligible) {
    const candidate = reviewBinding.candidateRef;
    if (
      candidate?.kind !== 'git' ||
      !/^[0-9a-f]{40}$/.test(candidate.revision) ||
      reviewBinding.evidenceManifestId === null ||
      reviewBinding.evidenceManifestHash === null ||
      evaluatorOutcome === null ||
      trustAxes.contractBinding.status !== 'verified'
    ) {
      reject('actionable package requires one exact verified Git binding');
    }
    const requiredCriteria = criteria.filter((criterion) => criterion.required);
    const authorityAxes = Object.entries(trustAxes).filter(
      ([name]) => name !== 'independentReview',
    );
    const decisionReasons = [
      ...outcomeReasons,
      ...requiredCriteria.flatMap((criterion) => criterion.reasonCodes),
      ...blockingFindings.flatMap((finding) => finding.reasonCodes),
      ...authorityAxes.flatMap(([, axis]) => axis.reasonCodes),
    ];
    if (decisionReasons.some((reason) => DECISION_BLOCKING_REASONS.includes(reason))) {
      reject('actionable package contains a decision-blocking reason');
    }
    const assertionsById = new Map(assertions.map((assertion) => [assertion.id, assertion]));
    const decisionAssertionIds = new Set([
      ...requiredCriteria.flatMap((criterion) => criterion.assertionIds),
      ...blockingFindings.flatMap((finding) => finding.assertionIds),
      ...trustAxes.independentEvaluation.assertionIds,
    ]);
    if (
      [...decisionAssertionIds].some(
        (id) => assertionsById.get(id)?.classification !== 'verified',
      )
    ) {
      reject('actionable package contains an unverified premise');
    }
    const humanDecisionPending =
      requiredCriteria.some(
        (criterion) => criterion.authority === 'human' && criterion.status === 'needs_human',
      ) || requiredDecision?.policyDecisionIds.includes('approve_outcome') === true;
    const criterionFailure = requiredCriteria.some(
      (criterion) =>
        criterion.status === 'fail' && criterion.reasonCodes.includes('criterion_failed'),
    );
    const blockingFailure = blockingFindings.length > 0;
    const humanRejection =
      trustAxes.human.status === 'failed' &&
      trustAxes.human.reasonCodes.includes('human_rejected');
    const structuralFailReasonSet = new Set<ReviewReasonCode>([
      ...(criterionFailure ? (['criterion_failed'] as const) : []),
      ...(blockingFailure ? (['blocking_finding'] as const) : []),
      ...(humanRejection ? (['human_rejected'] as const) : []),
    ]);
    const structuralFailReasons = REVIEW_REASON_CODES.filter((reason) =>
      structuralFailReasonSet.has(reason),
    );
    const malformedBlockingFailure = blockingFindings.some(
      (finding) =>
        finding.classification !== 'verified' ||
        !equalJson(finding.reasonCodes, ['blocking_finding']),
    );
    const malformedRequiredFailure = requiredCriteria.some(
      (criterion) =>
        criterion.status === 'fail' &&
        !criterion.reasonCodes.some((reason) => ACTIONABLE_FAIL_REASONS.includes(reason)),
    );
    const machineFailure = criterionFailure || blockingFailure;
    if (
      authorityAxes.some(([, axis]) => axis.status === 'need_more_evidence') ||
      (evaluatorOutcome === 'fail') !== machineFailure ||
      (outcomeStatus === 'pass' &&
        (outcomeReasons.length > 0 ||
          requiredCriteria.some((criterion) => criterion.status !== 'pass') ||
          authorityAxes.some(
            ([, axis]) => axis.status === 'failed' || axis.status === 'needs_human',
          ))) ||
      (outcomeStatus === 'needs_human' &&
        (!equalJson(outcomeReasons, ['human_decision_required']) ||
          !humanDecisionPending ||
          requiredCriteria.some((criterion) =>
            criterion.authority === 'human'
              ? criterion.status !== 'pass' && criterion.status !== 'needs_human'
              : criterion.status !== 'pass',
          ) ||
          trustAxes.human.status !== 'needs_human' ||
          authorityAxes.some(([, axis]) => axis.status === 'failed'))) ||
      (outcomeStatus === 'fail' &&
        (!equalJson(outcomeReasons, structuralFailReasons) ||
          structuralFailReasons.length === 0 ||
          malformedBlockingFailure ||
          malformedRequiredFailure ||
          requiredCriteria.some(
            (criterion) =>
              criterion.status === 'need_more_evidence' ||
              criterion.status === 'not_applicable',
          )))
    ) {
      reject('actionable package surfaces are not authority-consistent');
    }
  }

  return {
    schema: 'hercules-review-package/v2',
    projectionHash: root['projectionHash'],
    projectedAt: root['projectedAt'] as string,
    task: task as unknown as ReviewPackageV2Dto['task'],
    binding: reviewBinding,
    outcome: {
      status: outcomeStatus,
      evaluatorOutcome,
      decisionEligible,
      reasonCodes: outcomeReasons,
      advisorySummary: outcomeStatus,
    },
    assertions,
    trustAxes,
    criteria,
    evidence,
    blockingFindings,
    remainingRisks,
    iterations,
    requiredDecision,
    validDecisions,
    decisionBinding,
    decisionToken: null,
    usage,
  };
}
