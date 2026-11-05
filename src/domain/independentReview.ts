/**
 * M8 independent PR review receipt + publication-gate domain records.
 *
 * Slice 5: durable review receipt validators and host/GitHub gate receipts.
 * Types are verbatim from the M8 contract except the CTO-fixed GitHub
 * bound-resources document shape.
 */

import { hashCanonicalJson, canonicalSerialize } from './canonicalJson.js';
import { isValidIdentifier } from './task.js';

// ---------------------------------------------------------------------------
// Fail-closed error class
// ---------------------------------------------------------------------------

export type IndependentReviewErrorCode =
  | 'invalid_input_schema'
  | 'stale_binding'
  | 'artifact_integrity'
  | 'verification_incomplete'
  | 'claim_ineligible'
  | 'claim_contradiction'
  | 'policy_denial'
  | 'role_conflict'
  | 'deterministic_gate_failed'
  | 'real_surface_missing'
  | 'evaluator_unavailable'
  | 'evaluator_contract_violation'
  | 'idempotency_conflict';

export class IndependentReviewError extends Error {
  override readonly name = 'IndependentReviewError';

  constructor(
    readonly code: IndependentReviewErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Types (verbatim from M8 contract)
// ---------------------------------------------------------------------------

export type IndependentReviewAxisV1 =
  | 'scope_and_non_expansion'
  | 'claim_authority'
  | 'source_authentication'
  | 'fail_closed_semantics'
  | 'schema_and_hash_determinism'
  | 'replay_concurrency_freshness'
  | 'timeout_and_cancellation'
  | 'publication_self_reference'
  | 'compatibility_and_gates'
  | 'implementation_feasibility';

export type IndependentReviewEvidenceKindV1 =
  | 'rubric_source'
  | 'candidate_diff'
  | 'contract'
  | 'gate_receipt'
  | 'gate_log'
  | 'real_surface_receipt'
  | 'primary_artifact'
  | 'assertion'
  | 'verification_receipt'
  | 'finding_resolution'
  | 'github_gate_run'
  | 'continuity_carrier_commit'
  | 'claim_text';

export interface ReviewEvidenceObjectV1 {
  readonly evidenceId: string;
  readonly kind: IndependentReviewEvidenceKindV1;
  readonly repository: string | null;
  readonly commit: string | null;
  readonly path: string | null;
  readonly gitObjectSha: string | null;
  readonly contentLocator: string | null;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface IndependentReviewEvidenceManifestV1 {
  readonly schema: 'hercules-independent-review-evidence-manifest/v1';
  readonly baseCommit: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly contractBlob: string;
  readonly changedPaths: readonly string[];
  readonly objects: readonly ReviewEvidenceObjectV1[];
  readonly manifestHash: string;
}

export interface IndependentReviewRubricCriterionV1 {
  readonly criterionId: string;
  readonly axis: IndependentReviewAxisV1;
  readonly statementHash: string;
  readonly required: boolean;
}

export interface IndependentReviewRubricV1 {
  readonly schema: 'hercules-independent-review-rubric/v1';
  readonly policyId: 'hercules-independent-review-policy';
  readonly version: number;
  readonly carrierRepository: 'example-org/review-ledger';
  readonly carrierCommit: string;
  readonly policyBlob: string;
  readonly criteria: readonly IndependentReviewRubricCriterionV1[];
  readonly rubricHash: string;
}

export interface ReviewPremiseV1 {
  readonly premiseId: string;
  readonly classification:
    | 'factual_assertion'
    | 'inference'
    | 'unverified_pending'
    | 'opinion';
  readonly claimTextHash: string;
  readonly evidenceObjectIds: readonly string[];
  readonly verificationReceiptIds: readonly string[];
  readonly contradictsPremiseIds: readonly string[];
  readonly decisionEligible: boolean;
  readonly usedByFindingIds: readonly string[];
  readonly usedByCriterionIds: readonly string[];
  readonly premiseHash: string;
}

export interface ReviewFindingV1 {
  readonly findingId: string;
  readonly severity: 'blocking' | 'high' | 'advisory';
  readonly code: string;
  readonly location: string;
  readonly premiseIds: readonly string[];
  readonly disposition: 'open' | 'repaired' | 'withdrawn';
  readonly findingHash: string;
}

export interface IndependentReviewCriterionVerificationV1 {
  readonly criterionId: string;
  readonly status: 'satisfied' | 'violated' | 'insufficient_evidence';
  readonly premiseIds: readonly string[];
  readonly evidenceObjectIds: readonly string[];
  readonly verificationHash: string;
}

export interface IndependentReviewAxisConclusionV1 {
  readonly axis: IndependentReviewAxisV1;
  readonly status: 'clear' | 'blocked' | 'insufficient_evidence';
  readonly criterionIds: readonly string[];
  readonly conclusionHash: string;
}

export interface IndependentReviewWorkBindingV1 {
  readonly schema: 'hercules-independent-review-work-binding/v1';
  readonly issuer: 'hercules-program-control';
  readonly milestone: string;
  readonly reviewTaskId: string;
  readonly reviewIterationId: string;
  readonly reviewContractVersion: number;
  readonly reviewContractHash: string;
  readonly baseCommit: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly milestoneContractPath: string;
  readonly milestoneContractBlob: string;
  readonly bindingHash: string;
}

export interface IndependentReviewReceiptV1 {
  readonly schema: 'hercules-independent-review-receipt/v1';
  readonly issuer: 'hercules-program-control';
  readonly receiptId: string;
  readonly repository: 'example-org/acme';
  readonly reviewTaskId: string;
  readonly reviewIterationId: string;
  readonly workBinding: IndependentReviewWorkBindingV1;
  readonly workBindingHash: string;
  readonly baseCommit: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly contractPath: string;
  readonly contractBlob: string;
  readonly rubric: IndependentReviewRubricV1;
  readonly evidenceManifest: IndependentReviewEvidenceManifestV1;
  readonly reviewerRunId: string;
  readonly reviewerImplementation: string;
  readonly freshContext: true;
  readonly implementerRunIds: readonly string[];
  readonly reviewerRecommendation:
    | 'blockers_no'
    | 'blockers_yes'
    | 'need_more_evidence';
  readonly premises: readonly ReviewPremiseV1[];
  readonly premiseSetHash: string;
  readonly findings: readonly ReviewFindingV1[];
  readonly findingSetHash: string;
  readonly criterionVerifications: readonly IndependentReviewCriterionVerificationV1[];
  readonly criterionVerificationSetHash: string;
  readonly axisConclusions: readonly IndependentReviewAxisConclusionV1[];
  readonly axisConclusionSetHash: string;
  readonly coordinatorDerivedResult:
    | 'blockers_no'
    | 'blockers_yes'
    | 'need_more_evidence';
  readonly reviewedAt: string;
  readonly receiptHash: string;
}

export interface HostFullGateReceiptV1 {
  readonly schema: 'hercules-host-full-gate-receipt/v1';
  readonly issuer: 'hercules-program-control';
  readonly command: 'pnpm check:full';
  readonly candidateCommit: string;
  readonly worktreeHeadBefore: string;
  readonly worktreeHeadAfter: string;
  readonly statusCleanBefore: true;
  readonly statusCleanAfter: true;
  readonly exitCode: 0;
  readonly conclusion: 'passed';
  readonly testFilesPassed: number;
  readonly testsPassed: number;
  readonly testsSkipped: number;
  readonly spaSmokePassed: true;
  readonly logPath: string;
  readonly logSha256: string;
  readonly logByteLength: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly receiptHash: string;
}

export interface GithubGateReceiptV1 {
  readonly schema: 'hercules-github-gate-receipt/v1';
  readonly repository: 'example-org/acme';
  readonly workflowPath: '.github/workflows/ci.yml';
  readonly event: 'pull_request';
  readonly scopeClassification: 'full' | 'docs_only';
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly runId: number;
  readonly runUrl: string;
  readonly conclusion: 'success';
  readonly boundResourcesPath: string;
  readonly boundResourcesSha256: string;
  readonly boundResourcesByteLength: number;
  readonly observedAt: string;
  readonly receiptHash: string;
}

// ---------------------------------------------------------------------------
// CTO-fixed GitHub bound-resources document
// ---------------------------------------------------------------------------

export interface GithubBoundRunProjectionV1 {
  readonly runId: number;
  readonly headSha: string;
  readonly event: string;
  readonly workflowPath: string;
  readonly status: string;
  readonly conclusion: string;
}

export interface GithubBoundJobProjectionV1 {
  readonly jobId: number;
  readonly jobName: string;
  readonly runId: number;
  readonly conclusion: string;
  readonly steps: readonly { readonly name: string; readonly conclusion: string }[];
}

export interface GithubBoundResourcesV1 {
  readonly changedPaths: readonly string[];
  readonly jobs: readonly GithubBoundJobProjectionV1[];
  readonly run: GithubBoundRunProjectionV1;
}

// ---------------------------------------------------------------------------
// Closed literal sets / keys
// ---------------------------------------------------------------------------

export const INDEPENDENT_REVIEW_AXES_V1: readonly IndependentReviewAxisV1[] = [
  'scope_and_non_expansion',
  'claim_authority',
  'source_authentication',
  'fail_closed_semantics',
  'schema_and_hash_determinism',
  'replay_concurrency_freshness',
  'timeout_and_cancellation',
  'publication_self_reference',
  'compatibility_and_gates',
  'implementation_feasibility',
] as const;

export const INDEPENDENT_REVIEW_EVIDENCE_KINDS_V1: readonly IndependentReviewEvidenceKindV1[] =
  [
    'rubric_source',
    'candidate_diff',
    'contract',
    'gate_receipt',
    'gate_log',
    'real_surface_receipt',
    'primary_artifact',
    'assertion',
    'verification_receipt',
    'finding_resolution',
    'github_gate_run',
    'continuity_carrier_commit',
    'claim_text',
  ] as const;

/** Always-required evidence kinds for the used rule. */
export const ALWAYS_REQUIRED_EVIDENCE_KINDS_V1: ReadonlySet<IndependentReviewEvidenceKindV1> =
  new Set([
    'candidate_diff',
    'contract',
    'rubric_source',
    'gate_receipt',
    'github_gate_run',
    'continuity_carrier_commit',
  ]);

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const DOCS_ONLY_PATH_RE = /^(docs\/.*|README\.md)$/;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_ARRAY_ITEMS = 4_096;
const MAX_LOCATOR_BYTES = 1_024;
const MAX_PATH_BYTES = 1_024;

const PREMISE_CLASSIFICATIONS = [
  'factual_assertion',
  'inference',
  'unverified_pending',
  'opinion',
] as const;
const FINDING_SEVERITIES = ['blocking', 'high', 'advisory'] as const;
const FINDING_DISPOSITIONS = ['open', 'repaired', 'withdrawn'] as const;
const CRITERION_STATUSES = ['satisfied', 'violated', 'insufficient_evidence'] as const;
const AXIS_STATUSES = ['clear', 'blocked', 'insufficient_evidence'] as const;
const REVIEW_RESULTS = ['blockers_no', 'blockers_yes', 'need_more_evidence'] as const;
const SCOPE_CLASSIFICATIONS = ['full', 'docs_only'] as const;

const EVIDENCE_OBJECT_KEYS = [
  'evidenceId',
  'kind',
  'repository',
  'commit',
  'path',
  'gitObjectSha',
  'contentLocator',
  'byteLength',
  'sha256',
] as const;

const EVIDENCE_MANIFEST_KEYS = [
  'schema',
  'baseCommit',
  'candidateCommit',
  'candidateTree',
  'contractBlob',
  'changedPaths',
  'objects',
  'manifestHash',
] as const;

const RUBRIC_CRITERION_KEYS = [
  'criterionId',
  'axis',
  'statementHash',
  'required',
] as const;

const RUBRIC_KEYS = [
  'schema',
  'policyId',
  'version',
  'carrierRepository',
  'carrierCommit',
  'policyBlob',
  'criteria',
  'rubricHash',
] as const;

const PREMISE_KEYS = [
  'premiseId',
  'classification',
  'claimTextHash',
  'evidenceObjectIds',
  'verificationReceiptIds',
  'contradictsPremiseIds',
  'decisionEligible',
  'usedByFindingIds',
  'usedByCriterionIds',
  'premiseHash',
] as const;

const FINDING_KEYS = [
  'findingId',
  'severity',
  'code',
  'location',
  'premiseIds',
  'disposition',
  'findingHash',
] as const;

const CRITERION_VERIFICATION_KEYS = [
  'criterionId',
  'status',
  'premiseIds',
  'evidenceObjectIds',
  'verificationHash',
] as const;

const AXIS_CONCLUSION_KEYS = [
  'axis',
  'status',
  'criterionIds',
  'conclusionHash',
] as const;

const WORK_BINDING_KEYS = [
  'schema',
  'issuer',
  'milestone',
  'reviewTaskId',
  'reviewIterationId',
  'reviewContractVersion',
  'reviewContractHash',
  'baseCommit',
  'candidateCommit',
  'candidateTree',
  'milestoneContractPath',
  'milestoneContractBlob',
  'bindingHash',
] as const;

const REVIEW_RECEIPT_KEYS = [
  'schema',
  'issuer',
  'receiptId',
  'repository',
  'reviewTaskId',
  'reviewIterationId',
  'workBinding',
  'workBindingHash',
  'baseCommit',
  'candidateCommit',
  'candidateTree',
  'contractPath',
  'contractBlob',
  'rubric',
  'evidenceManifest',
  'reviewerRunId',
  'reviewerImplementation',
  'freshContext',
  'implementerRunIds',
  'reviewerRecommendation',
  'premises',
  'premiseSetHash',
  'findings',
  'findingSetHash',
  'criterionVerifications',
  'criterionVerificationSetHash',
  'axisConclusions',
  'axisConclusionSetHash',
  'coordinatorDerivedResult',
  'reviewedAt',
  'receiptHash',
] as const;

const HOST_GATE_RECEIPT_KEYS = [
  'schema',
  'issuer',
  'command',
  'candidateCommit',
  'worktreeHeadBefore',
  'worktreeHeadAfter',
  'statusCleanBefore',
  'statusCleanAfter',
  'exitCode',
  'conclusion',
  'testFilesPassed',
  'testsPassed',
  'testsSkipped',
  'spaSmokePassed',
  'logPath',
  'logSha256',
  'logByteLength',
  'startedAt',
  'completedAt',
  'receiptHash',
] as const;

const GITHUB_GATE_RECEIPT_KEYS = [
  'schema',
  'repository',
  'workflowPath',
  'event',
  'scopeClassification',
  'pullRequestNumber',
  'headSha',
  'runId',
  'runUrl',
  'conclusion',
  'boundResourcesPath',
  'boundResourcesSha256',
  'boundResourcesByteLength',
  'observedAt',
  'receiptHash',
] as const;

const GITHUB_BOUND_RUN_KEYS = [
  'runId',
  'headSha',
  'event',
  'workflowPath',
  'status',
  'conclusion',
] as const;

const GITHUB_BOUND_JOB_KEYS = [
  'jobId',
  'jobName',
  'runId',
  'conclusion',
  'steps',
] as const;

const GITHUB_BOUND_STEP_KEYS = ['name', 'conclusion'] as const;

const GITHUB_BOUND_RESOURCES_KEYS = ['changedPaths', 'jobs', 'run'] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(message: string): never {
  throw new IndependentReviewError('invalid_input_schema', message);
}

function assertExactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Readonly<Record<string, unknown>> {
  try {
    canonicalSerialize(value);
  } catch (error) {
    fail(`${label} must be stable canonical JSON: ${String(error)}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} must use the exact closed schema`);
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isBoundedNfcString(value: unknown, maxBytes = MAX_IDENTIFIER_BYTES): value is string {
  return (
    typeof value === 'string' &&
    utf8Bytes(value) >= 1 &&
    utf8Bytes(value) <= maxBytes &&
    value.normalize('NFC') === value
  );
}

function isBoundedIdentifier(value: unknown): value is string {
  return isBoundedNfcString(value) && isValidIdentifier(value);
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_RE.test(value);
}

function isGitSha(value: unknown): value is string {
  return typeof value === 'string' && GIT_SHA_RE.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || utf8Bytes(value) > MAX_IDENTIFIER_BYTES) {
    return false;
  }
  const time = new Date(value);
  return !Number.isNaN(time.valueOf()) && time.toISOString() === value;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function omitHash<T extends object>(
  value: T,
  keyToOmit: string,
): Readonly<Record<string, unknown>> {
  const record = value as unknown as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== keyToOmit),
  );
}

function assertDenseArray(
  value: unknown,
  label: string,
): asserts value is readonly unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) {
    fail(`${label} must be a bounded array`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) {
      fail(`${label} must not be sparse`);
    }
  }
}

function assertSortedUniqueIdentifiers(
  value: unknown,
  label: string,
  allowEmpty = true,
): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_ARRAY_ITEMS ||
    (!allowEmpty && value.length === 0)
  ) {
    fail(`${label} must be a bounded${allowEmpty ? '' : ' non-empty'} array`);
  }
  let previous: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || !isBoundedIdentifier(value[index])) {
      fail(`${label} must contain bounded UTF-8 identities`);
    }
    const current = value[index] as string;
    if (previous !== null && previous >= current) {
      fail(`${label} must contain sorted unique identities`);
    }
    previous = current;
  }
}

/** Sorted-unique path / locator strings (slashes allowed; not task identifiers). */
function assertSortedUniqueStrings(
  value: unknown,
  label: string,
  maxBytes: number,
  allowEmpty = true,
): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_ARRAY_ITEMS ||
    (!allowEmpty && value.length === 0)
  ) {
    fail(`${label} must be a bounded${allowEmpty ? '' : ' non-empty'} array`);
  }
  let previous: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || !isBoundedNfcString(value[index], maxBytes)) {
      fail(`${label} must contain bounded non-empty NFC strings`);
    }
    const current = value[index] as string;
    if (previous !== null && previous >= current) {
      fail(`${label} must contain sorted unique strings`);
    }
    previous = current;
  }
}

function assertTimestampAfter(later: string, earlier: string, label: string): void {
  if (Date.parse(later) <= Date.parse(earlier)) {
    fail(`${label} must be strictly after its earlier timestamp`);
  }
}

function computeMemberSetHash(memberHashes: readonly string[]): string {
  return hashCanonicalJson([...memberHashes].sort());
}

export function isReviewEvidenceSourceObject(object: ReviewEvidenceObjectV1): boolean {
  return (
    object.repository !== null &&
    object.commit !== null &&
    object.path !== null &&
    object.gitObjectSha !== null &&
    object.contentLocator === null
  );
}

export function isReviewEvidenceRuntimeArtifact(object: ReviewEvidenceObjectV1): boolean {
  return (
    object.repository === null &&
    object.commit === null &&
    object.path === null &&
    object.gitObjectSha === null &&
    object.contentLocator !== null
  );
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function computeReviewEvidenceObjectContentDigestGrammar(sha256: string): boolean {
  return isHash(sha256);
}

export function computeEvidenceManifestHash(
  manifest: Omit<IndependentReviewEvidenceManifestV1, 'manifestHash'>,
): string {
  return hashCanonicalJson(manifest);
}

export function computeRubricCriterionStatementGrammar(statementHash: string): boolean {
  return isHash(statementHash);
}

export function computeRubricHash(
  rubric: Omit<IndependentReviewRubricV1, 'rubricHash'>,
): string {
  return hashCanonicalJson(rubric);
}

export function computePremiseHash(premise: Omit<ReviewPremiseV1, 'premiseHash'>): string {
  return hashCanonicalJson(premise);
}

export function computeFindingHash(finding: Omit<ReviewFindingV1, 'findingHash'>): string {
  return hashCanonicalJson(finding);
}

export function computeCriterionVerificationHash(
  verification: Omit<IndependentReviewCriterionVerificationV1, 'verificationHash'>,
): string {
  return hashCanonicalJson(verification);
}

export function computeAxisConclusionHash(
  conclusion: Omit<IndependentReviewAxisConclusionV1, 'conclusionHash'>,
): string {
  return hashCanonicalJson(conclusion);
}

export function computeWorkBindingHash(
  binding: Omit<IndependentReviewWorkBindingV1, 'bindingHash'>,
): string {
  return hashCanonicalJson(binding);
}

export function computePremiseSetHash(premises: readonly ReviewPremiseV1[]): string {
  return computeMemberSetHash(premises.map((premise) => premise.premiseHash));
}

export function computeFindingSetHash(findings: readonly ReviewFindingV1[]): string {
  return computeMemberSetHash(findings.map((finding) => finding.findingHash));
}

export function computeCriterionVerificationSetHash(
  verifications: readonly IndependentReviewCriterionVerificationV1[],
): string {
  return computeMemberSetHash(verifications.map((item) => item.verificationHash));
}

export function computeAxisConclusionSetHash(
  conclusions: readonly IndependentReviewAxisConclusionV1[],
): string {
  return computeMemberSetHash(conclusions.map((item) => item.conclusionHash));
}

export function computeIndependentReviewReceiptHash(
  receipt: Omit<IndependentReviewReceiptV1, 'receiptHash'>,
): string {
  return hashCanonicalJson(receipt);
}

export function computeHostFullGateReceiptHash(
  receipt: Omit<HostFullGateReceiptV1, 'receiptHash'>,
): string {
  return hashCanonicalJson(receipt);
}

export function computeGithubGateReceiptHash(
  receipt: Omit<GithubGateReceiptV1, 'receiptHash'>,
): string {
  return hashCanonicalJson(receipt);
}

export function computeGithubBoundResourcesSha256(
  document: GithubBoundResourcesV1,
): string {
  return hashCanonicalJson(document);
}

export function computeGithubBoundResourcesByteLength(
  document: GithubBoundResourcesV1,
): number {
  return utf8Bytes(canonicalSerialize(document));
}

// ---------------------------------------------------------------------------
// Scope classification
// ---------------------------------------------------------------------------

/**
 * Recompute docs-only vs full from changed paths only.
 * Vacuous empty set → docs_only.
 */
export function recomputeScopeClassification(
  document: GithubBoundResourcesV1,
): 'docs_only' | 'full' {
  for (const path of document.changedPaths) {
    if (!DOCS_ONLY_PATH_RE.test(path)) {
      return 'full';
    }
  }
  return 'docs_only';
}

/**
 * Assert stored scopeClassification equals path recomputation.
 *
 * For `'full'`, step guards are not present in the bound document, so this
 * uses the closed conservative reading: among the `gates` job's steps there
 * must be no step with conclusion `'skipped'` and at least one step with
 * conclusion `'success'`.
 */
export function assertScopeClassification(
  receipt: GithubGateReceiptV1,
  document: GithubBoundResourcesV1,
): void {
  const recomputed = recomputeScopeClassification(document);
  if (receipt.scopeClassification !== recomputed) {
    fail(
      `github gate scopeClassification must equal recomputation (stored ${receipt.scopeClassification}, recomputed ${recomputed})`,
    );
  }
  if (recomputed === 'full') {
    const gatesJob = document.jobs.find((job) => job.jobName === 'gates');
    if (gatesJob === undefined) {
      fail("full scopeClassification requires a gates job in the bound document");
    }
    let sawSuccess = false;
    for (const step of gatesJob.steps) {
      if (step.conclusion === 'skipped') {
        fail(
          "full scopeClassification forbids skipped steps among the gates job (conservative docs-only-guard reading)",
        );
      }
      if (step.conclusion === 'success') {
        sawSuccess = true;
      }
    }
    if (!sawSuccess) {
      fail(
        "full scopeClassification requires at least one gates job step with conclusion success",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Structural validators
// ---------------------------------------------------------------------------

export function assertReviewEvidenceObjectV1(object: ReviewEvidenceObjectV1): void {
  assertExactRecord(object, EVIDENCE_OBJECT_KEYS, 'review evidence object');
  if (
    !isBoundedIdentifier(object.evidenceId) ||
    !(INDEPENDENT_REVIEW_EVIDENCE_KINDS_V1 as readonly string[]).includes(object.kind) ||
    !isNonNegativeSafeInteger(object.byteLength) ||
    !isHash(object.sha256)
  ) {
    fail('review evidence object identity, kind, byteLength, and sha256 must be valid');
  }

  const sourceShape =
    object.repository !== null &&
    object.commit !== null &&
    object.path !== null &&
    object.gitObjectSha !== null &&
    object.contentLocator === null;
  const runtimeShape =
    object.repository === null &&
    object.commit === null &&
    object.path === null &&
    object.gitObjectSha === null &&
    object.contentLocator !== null;

  if (sourceShape === runtimeShape) {
    fail(
      'review evidence object must be either a source object or a runtime artifact (exclusive nullability)',
    );
  }

  if (sourceShape) {
    if (
      !isBoundedNfcString(object.repository, MAX_PATH_BYTES) ||
      !isGitSha(object.commit) ||
      !isBoundedNfcString(object.path, MAX_PATH_BYTES) ||
      !isGitSha(object.gitObjectSha)
    ) {
      fail('source evidence object repository/commit/path/gitObjectSha must be valid');
    }
  } else if (
    object.contentLocator === null ||
    !isBoundedNfcString(object.contentLocator, MAX_LOCATOR_BYTES)
  ) {
    fail('runtime evidence object contentLocator must be a bounded non-empty string');
  }
}

export function assertIndependentReviewEvidenceManifestV1(
  manifest: IndependentReviewEvidenceManifestV1,
): void {
  assertExactRecord(manifest, EVIDENCE_MANIFEST_KEYS, 'independent review evidence manifest');
  if (
    manifest.schema !== 'hercules-independent-review-evidence-manifest/v1' ||
    !isGitSha(manifest.baseCommit) ||
    !isGitSha(manifest.candidateCommit) ||
    !isGitSha(manifest.candidateTree) ||
    !isGitSha(manifest.contractBlob) ||
    !isHash(manifest.manifestHash)
  ) {
    fail('evidence manifest schema, commits, contract blob, and hash must be valid');
  }
  assertSortedUniqueStrings(manifest.changedPaths, 'evidence manifest changedPaths', MAX_PATH_BYTES);
  assertDenseArray(manifest.objects, 'evidence manifest objects');
  const evidenceIds = new Set<string>();
  for (const object of manifest.objects) {
    assertReviewEvidenceObjectV1(object);
    if (evidenceIds.has(object.evidenceId)) {
      fail('evidence manifest object ids must be unique');
    }
    evidenceIds.add(object.evidenceId);
  }
  const expected = hashCanonicalJson(omitHash(manifest, 'manifestHash'));
  if (manifest.manifestHash !== expected) {
    fail('evidence manifest hash does not match the exact record');
  }
}

export function assertIndependentReviewRubricCriterionV1(
  criterion: IndependentReviewRubricCriterionV1,
): void {
  assertExactRecord(criterion, RUBRIC_CRITERION_KEYS, 'independent review rubric criterion');
  if (
    !isBoundedIdentifier(criterion.criterionId) ||
    !(INDEPENDENT_REVIEW_AXES_V1 as readonly string[]).includes(criterion.axis) ||
    !isHash(criterion.statementHash) ||
    typeof criterion.required !== 'boolean'
  ) {
    fail('rubric criterion identity, axis, statementHash, and required must be valid');
  }
}

export function assertIndependentReviewRubricV1(rubric: IndependentReviewRubricV1): void {
  assertExactRecord(rubric, RUBRIC_KEYS, 'independent review rubric');
  if (
    rubric.schema !== 'hercules-independent-review-rubric/v1' ||
    rubric.policyId !== 'hercules-independent-review-policy' ||
    !isPositiveSafeInteger(rubric.version) ||
    rubric.carrierRepository !== 'example-org/review-ledger' ||
    !isGitSha(rubric.carrierCommit) ||
    !isGitSha(rubric.policyBlob) ||
    !isHash(rubric.rubricHash)
  ) {
    fail('rubric schema, policy, carrier, and hash must be valid');
  }
  assertDenseArray(rubric.criteria, 'rubric criteria');
  if (rubric.criteria.length === 0) {
    fail('rubric criteria must be non-empty');
  }
  const criterionIds = new Set<string>();
  const requiredAxes = new Set<IndependentReviewAxisV1>();
  for (const criterion of rubric.criteria) {
    assertIndependentReviewRubricCriterionV1(criterion);
    if (criterionIds.has(criterion.criterionId)) {
      fail('rubric criterion ids must be unique');
    }
    criterionIds.add(criterion.criterionId);
    if (criterion.required) {
      requiredAxes.add(criterion.axis);
    }
  }
  for (const axis of INDEPENDENT_REVIEW_AXES_V1) {
    if (!requiredAxes.has(axis)) {
      fail(`rubric must include at least one required criterion for axis ${axis}`);
    }
  }
  const expected = hashCanonicalJson(omitHash(rubric, 'rubricHash'));
  if (rubric.rubricHash !== expected) {
    fail('rubric hash does not match the exact record');
  }
}

export function assertReviewPremiseV1(premise: ReviewPremiseV1): void {
  assertExactRecord(premise, PREMISE_KEYS, 'review premise');
  if (
    !isBoundedIdentifier(premise.premiseId) ||
    !(PREMISE_CLASSIFICATIONS as readonly string[]).includes(premise.classification) ||
    !isHash(premise.claimTextHash) ||
    typeof premise.decisionEligible !== 'boolean' ||
    !isHash(premise.premiseHash)
  ) {
    fail('premise identity, classification, claimTextHash, eligibility, and hash must be valid');
  }
  assertSortedUniqueIdentifiers(premise.evidenceObjectIds, 'premise evidenceObjectIds');
  assertSortedUniqueIdentifiers(
    premise.verificationReceiptIds,
    'premise verificationReceiptIds',
  );
  assertSortedUniqueIdentifiers(
    premise.contradictsPremiseIds,
    'premise contradictsPremiseIds',
  );
  assertSortedUniqueIdentifiers(premise.usedByFindingIds, 'premise usedByFindingIds');
  assertSortedUniqueIdentifiers(premise.usedByCriterionIds, 'premise usedByCriterionIds');
  const expected = hashCanonicalJson(omitHash(premise, 'premiseHash'));
  if (premise.premiseHash !== expected) {
    fail('premise hash does not match the exact record');
  }
}

export function assertReviewFindingV1(finding: ReviewFindingV1): void {
  assertExactRecord(finding, FINDING_KEYS, 'review finding');
  if (
    !isBoundedIdentifier(finding.findingId) ||
    !(FINDING_SEVERITIES as readonly string[]).includes(finding.severity) ||
    !isBoundedIdentifier(finding.code) ||
    !isBoundedNfcString(finding.location, MAX_PATH_BYTES) ||
    !(FINDING_DISPOSITIONS as readonly string[]).includes(finding.disposition) ||
    !isHash(finding.findingHash)
  ) {
    fail('finding identity, severity, code, location, disposition, and hash must be valid');
  }
  assertSortedUniqueIdentifiers(finding.premiseIds, 'finding premiseIds', false);
  const expected = hashCanonicalJson(omitHash(finding, 'findingHash'));
  if (finding.findingHash !== expected) {
    fail('finding hash does not match the exact record');
  }
}

export function assertIndependentReviewCriterionVerificationV1(
  verification: IndependentReviewCriterionVerificationV1,
): void {
  assertExactRecord(
    verification,
    CRITERION_VERIFICATION_KEYS,
    'independent review criterion verification',
  );
  if (
    !isBoundedIdentifier(verification.criterionId) ||
    !(CRITERION_STATUSES as readonly string[]).includes(verification.status) ||
    !isHash(verification.verificationHash)
  ) {
    fail('criterion verification identity, status, and hash must be valid');
  }
  assertSortedUniqueIdentifiers(verification.premiseIds, 'criterion verification premiseIds');
  assertSortedUniqueIdentifiers(
    verification.evidenceObjectIds,
    'criterion verification evidenceObjectIds',
  );
  const expected = hashCanonicalJson(omitHash(verification, 'verificationHash'));
  if (verification.verificationHash !== expected) {
    fail('criterion verification hash does not match the exact record');
  }
}

export function assertIndependentReviewAxisConclusionV1(
  conclusion: IndependentReviewAxisConclusionV1,
): void {
  assertExactRecord(conclusion, AXIS_CONCLUSION_KEYS, 'independent review axis conclusion');
  if (
    !(INDEPENDENT_REVIEW_AXES_V1 as readonly string[]).includes(conclusion.axis) ||
    !(AXIS_STATUSES as readonly string[]).includes(conclusion.status) ||
    !isHash(conclusion.conclusionHash)
  ) {
    fail('axis conclusion axis, status, and hash must be valid');
  }
  assertSortedUniqueIdentifiers(conclusion.criterionIds, 'axis conclusion criterionIds', false);
  const expected = hashCanonicalJson(omitHash(conclusion, 'conclusionHash'));
  if (conclusion.conclusionHash !== expected) {
    fail('axis conclusion hash does not match the exact record');
  }
}

export function assertIndependentReviewWorkBindingV1(
  binding: IndependentReviewWorkBindingV1,
): void {
  assertExactRecord(binding, WORK_BINDING_KEYS, 'independent review work binding');
  if (
    binding.schema !== 'hercules-independent-review-work-binding/v1' ||
    binding.issuer !== 'hercules-program-control' ||
    !isBoundedIdentifier(binding.milestone) ||
    !isBoundedIdentifier(binding.reviewTaskId) ||
    !isBoundedIdentifier(binding.reviewIterationId) ||
    !isPositiveSafeInteger(binding.reviewContractVersion) ||
    !isHash(binding.reviewContractHash) ||
    !isGitSha(binding.baseCommit) ||
    !isGitSha(binding.candidateCommit) ||
    !isGitSha(binding.candidateTree) ||
    !isBoundedNfcString(binding.milestoneContractPath, MAX_PATH_BYTES) ||
    !isGitSha(binding.milestoneContractBlob) ||
    !isHash(binding.bindingHash)
  ) {
    fail('work binding schema, issuer, identities, commits, and hash must be valid');
  }
  const expected = hashCanonicalJson(omitHash(binding, 'bindingHash'));
  if (binding.bindingHash !== expected) {
    fail('work binding hash does not match the exact record');
  }
}

export function assertIndependentReviewReceiptV1(
  receipt: IndependentReviewReceiptV1,
): void {
  assertExactRecord(receipt, REVIEW_RECEIPT_KEYS, 'independent review receipt');
  if (
    receipt.schema !== 'hercules-independent-review-receipt/v1' ||
    receipt.issuer !== 'hercules-program-control' ||
    !isBoundedIdentifier(receipt.receiptId) ||
    receipt.repository !== 'example-org/acme' ||
    !isBoundedIdentifier(receipt.reviewTaskId) ||
    !isBoundedIdentifier(receipt.reviewIterationId) ||
    !isHash(receipt.workBindingHash) ||
    !isGitSha(receipt.baseCommit) ||
    !isGitSha(receipt.candidateCommit) ||
    !isGitSha(receipt.candidateTree) ||
    !isBoundedNfcString(receipt.contractPath, MAX_PATH_BYTES) ||
    !isGitSha(receipt.contractBlob) ||
    !isBoundedIdentifier(receipt.reviewerRunId) ||
    !isBoundedIdentifier(receipt.reviewerImplementation) ||
    receipt.freshContext !== true ||
    !(REVIEW_RESULTS as readonly string[]).includes(receipt.reviewerRecommendation) ||
    !isHash(receipt.premiseSetHash) ||
    !isHash(receipt.findingSetHash) ||
    !isHash(receipt.criterionVerificationSetHash) ||
    !isHash(receipt.axisConclusionSetHash) ||
    !(REVIEW_RESULTS as readonly string[]).includes(receipt.coordinatorDerivedResult) ||
    !isCanonicalTimestamp(receipt.reviewedAt) ||
    !isHash(receipt.receiptHash)
  ) {
    fail('independent review receipt identity, literals, and hashes must be valid');
  }

  assertIndependentReviewWorkBindingV1(receipt.workBinding);
  assertIndependentReviewRubricV1(receipt.rubric);
  assertIndependentReviewEvidenceManifestV1(receipt.evidenceManifest);

  if (receipt.workBindingHash !== receipt.workBinding.bindingHash) {
    fail('workBindingHash must equal workBinding.bindingHash');
  }

  if (
    receipt.baseCommit !== receipt.workBinding.baseCommit ||
    receipt.baseCommit !== receipt.evidenceManifest.baseCommit ||
    receipt.candidateCommit !== receipt.workBinding.candidateCommit ||
    receipt.candidateCommit !== receipt.evidenceManifest.candidateCommit ||
    receipt.candidateTree !== receipt.workBinding.candidateTree ||
    receipt.candidateTree !== receipt.evidenceManifest.candidateTree ||
    receipt.contractPath !== receipt.workBinding.milestoneContractPath ||
    receipt.contractBlob !== receipt.workBinding.milestoneContractBlob ||
    receipt.contractBlob !== receipt.evidenceManifest.contractBlob ||
    receipt.reviewTaskId !== receipt.workBinding.reviewTaskId ||
    receipt.reviewIterationId !== receipt.workBinding.reviewIterationId
  ) {
    fail(
      'receipt outer fields must equal corresponding workBinding and evidenceManifest fields',
    );
  }

  assertSortedUniqueIdentifiers(receipt.implementerRunIds, 'implementerRunIds');
  if (receipt.implementerRunIds.includes(receipt.reviewerRunId)) {
    fail('reviewerRunId must not be a member of implementerRunIds');
  }

  assertDenseArray(receipt.premises, 'receipt premises');
  assertDenseArray(receipt.findings, 'receipt findings');
  assertDenseArray(receipt.criterionVerifications, 'receipt criterionVerifications');
  assertDenseArray(receipt.axisConclusions, 'receipt axisConclusions');

  const premiseIds = new Set<string>();
  for (const premise of receipt.premises) {
    assertReviewPremiseV1(premise);
    if (premiseIds.has(premise.premiseId)) {
      fail('premise ids must be unique');
    }
    premiseIds.add(premise.premiseId);
  }

  const findingIds = new Set<string>();
  for (const finding of receipt.findings) {
    assertReviewFindingV1(finding);
    if (findingIds.has(finding.findingId)) {
      fail('finding ids must be unique');
    }
    findingIds.add(finding.findingId);
    for (const premiseId of finding.premiseIds) {
      if (!premiseIds.has(premiseId)) {
        fail(`finding ${finding.findingId} names unknown premise ${premiseId}`);
      }
    }
  }

  const rubricCriterionIds = new Set(
    receipt.rubric.criteria.map((criterion) => criterion.criterionId),
  );
  const verificationCriterionIds = new Set<string>();
  for (const verification of receipt.criterionVerifications) {
    assertIndependentReviewCriterionVerificationV1(verification);
    if (!rubricCriterionIds.has(verification.criterionId)) {
      fail(`criterion verification names unknown rubric criterion ${verification.criterionId}`);
    }
    if (verificationCriterionIds.has(verification.criterionId)) {
      fail('exactly one criterion verification is required per rubric criterion');
    }
    verificationCriterionIds.add(verification.criterionId);
    for (const premiseId of verification.premiseIds) {
      if (!premiseIds.has(premiseId)) {
        fail(
          `criterion verification ${verification.criterionId} names unknown premise ${premiseId}`,
        );
      }
    }
  }
  if (verificationCriterionIds.size !== rubricCriterionIds.size) {
    fail('exactly one criterion verification is required per rubric criterion');
  }

  const axisConclusionsSeen = new Set<IndependentReviewAxisV1>();
  for (const conclusion of receipt.axisConclusions) {
    assertIndependentReviewAxisConclusionV1(conclusion);
    if (axisConclusionsSeen.has(conclusion.axis)) {
      fail('exactly one axis conclusion is required per axis');
    }
    axisConclusionsSeen.add(conclusion.axis);
    const expectedCriterionIds = receipt.rubric.criteria
      .filter((criterion) => criterion.axis === conclusion.axis)
      .map((criterion) => criterion.criterionId)
      .sort();
    if (
      conclusion.criterionIds.length !== expectedCriterionIds.length ||
      conclusion.criterionIds.some((id, index) => id !== expectedCriterionIds[index])
    ) {
      fail(
        `axis conclusion ${conclusion.axis} criterionIds must equal that axis's sorted rubric criteria`,
      );
    }
  }
  for (const axis of INDEPENDENT_REVIEW_AXES_V1) {
    if (!axisConclusionsSeen.has(axis)) {
      fail(`exactly one axis conclusion is required for axis ${axis}`);
    }
  }

  if (receipt.premiseSetHash !== computePremiseSetHash(receipt.premises)) {
    fail('premiseSetHash does not match the sorted member hash list');
  }
  if (receipt.findingSetHash !== computeFindingSetHash(receipt.findings)) {
    fail('findingSetHash does not match the sorted member hash list');
  }
  if (
    receipt.criterionVerificationSetHash !==
    computeCriterionVerificationSetHash(receipt.criterionVerifications)
  ) {
    fail('criterionVerificationSetHash does not match the sorted member hash list');
  }
  if (
    receipt.axisConclusionSetHash !==
    computeAxisConclusionSetHash(receipt.axisConclusions)
  ) {
    fail('axisConclusionSetHash does not match the sorted member hash list');
  }

  const expected = hashCanonicalJson(omitHash(receipt, 'receiptHash'));
  if (receipt.receiptHash !== expected) {
    fail('independent review receipt hash does not match the exact record');
  }
}

export function assertHostFullGateReceiptV1(receipt: HostFullGateReceiptV1): void {
  assertExactRecord(receipt, HOST_GATE_RECEIPT_KEYS, 'host full gate receipt');
  if (
    receipt.schema !== 'hercules-host-full-gate-receipt/v1' ||
    receipt.issuer !== 'hercules-program-control' ||
    receipt.command !== 'pnpm check:full' ||
    !isGitSha(receipt.candidateCommit) ||
    !isGitSha(receipt.worktreeHeadBefore) ||
    !isGitSha(receipt.worktreeHeadAfter) ||
    receipt.statusCleanBefore !== true ||
    receipt.statusCleanAfter !== true ||
    receipt.exitCode !== 0 ||
    receipt.conclusion !== 'passed' ||
    !isNonNegativeSafeInteger(receipt.testFilesPassed) ||
    !isNonNegativeSafeInteger(receipt.testsPassed) ||
    !isNonNegativeSafeInteger(receipt.testsSkipped) ||
    receipt.spaSmokePassed !== true ||
    !isBoundedNfcString(receipt.logPath, MAX_PATH_BYTES) ||
    !isHash(receipt.logSha256) ||
    !isNonNegativeSafeInteger(receipt.logByteLength) ||
    !isCanonicalTimestamp(receipt.startedAt) ||
    !isCanonicalTimestamp(receipt.completedAt) ||
    !isHash(receipt.receiptHash)
  ) {
    fail('host full gate receipt literals, counts, log binding, and hash must be valid');
  }
  if (
    receipt.worktreeHeadBefore !== receipt.candidateCommit ||
    receipt.worktreeHeadAfter !== receipt.candidateCommit
  ) {
    fail('host full gate receipt heads must equal candidateCommit');
  }
  assertTimestampAfter(receipt.completedAt, receipt.startedAt, 'host full gate completedAt');
  const expected = hashCanonicalJson(omitHash(receipt, 'receiptHash'));
  if (receipt.receiptHash !== expected) {
    fail('host full gate receipt hash does not match the exact record');
  }
}

export function assertGithubGateReceiptV1(receipt: GithubGateReceiptV1): void {
  assertExactRecord(receipt, GITHUB_GATE_RECEIPT_KEYS, 'github gate receipt');
  if (
    receipt.schema !== 'hercules-github-gate-receipt/v1' ||
    receipt.repository !== 'example-org/acme' ||
    receipt.workflowPath !== '.github/workflows/ci.yml' ||
    receipt.event !== 'pull_request' ||
    !(SCOPE_CLASSIFICATIONS as readonly string[]).includes(receipt.scopeClassification) ||
    !isPositiveSafeInteger(receipt.pullRequestNumber) ||
    !isGitSha(receipt.headSha) ||
    !isPositiveSafeInteger(receipt.runId) ||
    !isBoundedNfcString(receipt.runUrl, MAX_LOCATOR_BYTES) ||
    receipt.conclusion !== 'success' ||
    !isBoundedNfcString(receipt.boundResourcesPath, MAX_PATH_BYTES) ||
    !isHash(receipt.boundResourcesSha256) ||
    !isNonNegativeSafeInteger(receipt.boundResourcesByteLength) ||
    !isCanonicalTimestamp(receipt.observedAt) ||
    !isHash(receipt.receiptHash)
  ) {
    fail('github gate receipt literals, identity, and hash must be valid');
  }
  const expected = hashCanonicalJson(omitHash(receipt, 'receiptHash'));
  if (receipt.receiptHash !== expected) {
    fail('github gate receipt hash does not match the exact record');
  }
}

export function assertGithubGateReceiptBindsCandidate(
  receipt: GithubGateReceiptV1,
  candidateCommit: string,
): void {
  if (!isGitSha(candidateCommit)) {
    fail('candidateCommit must be a bare 40-hex git SHA');
  }
  if (receipt.headSha !== candidateCommit) {
    fail('github gate receipt headSha must equal candidateCommit');
  }
}

function assertGithubBoundStep(
  step: { readonly name: string; readonly conclusion: string },
  label: string,
): void {
  assertExactRecord(step, GITHUB_BOUND_STEP_KEYS, label);
  if (
    !isBoundedNfcString(step.name, MAX_IDENTIFIER_BYTES) ||
    !isBoundedNfcString(step.conclusion, MAX_IDENTIFIER_BYTES)
  ) {
    fail(`${label} name and conclusion must be bounded strings`);
  }
}

function assertGithubBoundJobProjectionV1(
  job: GithubBoundJobProjectionV1,
  label: string,
): void {
  assertExactRecord(job, GITHUB_BOUND_JOB_KEYS, label);
  if (
    !isPositiveSafeInteger(job.jobId) ||
    !isBoundedNfcString(job.jobName, MAX_IDENTIFIER_BYTES) ||
    !isPositiveSafeInteger(job.runId) ||
    !isBoundedNfcString(job.conclusion, MAX_IDENTIFIER_BYTES)
  ) {
    fail(`${label} identity and conclusion must be valid`);
  }
  assertDenseArray(job.steps, `${label} steps`);
  for (let index = 0; index < job.steps.length; index += 1) {
    const step = job.steps[index];
    if (step === undefined) {
      fail(`${label} steps must not be sparse`);
    }
    assertGithubBoundStep(step, `${label} step[${index}]`);
  }
}

function assertGithubBoundRunProjectionV1(run: GithubBoundRunProjectionV1): void {
  assertExactRecord(run, GITHUB_BOUND_RUN_KEYS, 'github bound run projection');
  if (
    !isPositiveSafeInteger(run.runId) ||
    !isGitSha(run.headSha) ||
    !isBoundedNfcString(run.event, MAX_IDENTIFIER_BYTES) ||
    !isBoundedNfcString(run.workflowPath, MAX_PATH_BYTES) ||
    !isBoundedNfcString(run.status, MAX_IDENTIFIER_BYTES) ||
    !isBoundedNfcString(run.conclusion, MAX_IDENTIFIER_BYTES)
  ) {
    fail('github bound run projection fields must be valid');
  }
}

export function assertGithubBoundResourcesDocumentV1(
  document: GithubBoundResourcesV1,
): void {
  assertExactRecord(document, GITHUB_BOUND_RESOURCES_KEYS, 'github bound resources');
  assertSortedUniqueStrings(
    document.changedPaths,
    'github bound resources changedPaths',
    MAX_PATH_BYTES,
  );
  assertDenseArray(document.jobs, 'github bound resources jobs');
  let previousJobId: number | null = null;
  for (let index = 0; index < document.jobs.length; index += 1) {
    const job = document.jobs[index];
    if (job === undefined) {
      fail('github bound resources jobs must not be sparse');
    }
    assertGithubBoundJobProjectionV1(job, `github bound job[${index}]`);
    if (previousJobId !== null && previousJobId >= job.jobId) {
      fail('github bound resources jobs must be sorted by jobId');
    }
    previousJobId = job.jobId;
  }
  assertGithubBoundRunProjectionV1(document.run);
}

export function assertGithubBoundResourcesV1(
  document: GithubBoundResourcesV1,
  receipt: GithubGateReceiptV1,
): void {
  assertGithubBoundResourcesDocumentV1(document);
  assertGithubGateReceiptV1(receipt);

  if (document.run.runId !== receipt.runId) {
    fail('bound document run.runId must equal receipt.runId');
  }
  if (document.run.headSha !== receipt.headSha) {
    fail('bound document run.headSha must equal receipt.headSha');
  }
  if (document.run.event !== 'pull_request') {
    fail("bound document run.event must be 'pull_request'");
  }
  if (document.run.event !== receipt.event) {
    fail('bound document run.event must equal receipt.event');
  }
  if (document.run.workflowPath !== receipt.workflowPath) {
    fail('bound document run.workflowPath must equal receipt.workflowPath');
  }
  if (document.run.conclusion !== 'success') {
    fail("bound document run.conclusion must be 'success'");
  }
  if (document.run.conclusion !== receipt.conclusion) {
    fail('bound document run.conclusion must equal receipt.conclusion');
  }
  if (document.run.status !== 'completed') {
    fail("bound document run.status must be 'completed'");
  }
  for (const job of document.jobs) {
    if (job.runId !== receipt.runId) {
      fail('every bound job.runId must equal receipt.runId');
    }
  }

  const digest = computeGithubBoundResourcesSha256(document);
  if (digest !== receipt.boundResourcesSha256) {
    fail('boundResourcesSha256 must equal the canonical digest of the bound document');
  }
  const byteLength = computeGithubBoundResourcesByteLength(document);
  if (byteLength !== receipt.boundResourcesByteLength) {
    fail(
      'boundResourcesByteLength must equal the canonical UTF-8 byte length of the bound document',
    );
  }

  assertScopeClassification(receipt, document);
}
