/**
 * M10 worker-boundary domain records.
 *
 * Slice 1: closed input/admission records, hashing, and structural validators.
 * Lease admission, result validation, and capability broker live in later slices.
 */

import {
  canonicalClone,
  canonicalSerialize,
  hashCanonicalJson,
} from './canonicalJson.js';
import { STAGE_TYPES, type StageType } from './stageRun.js';
import { isValidIdentifier } from './task.js';

// ---------------------------------------------------------------------------
// Fail-closed error classes (full M10 union; this slice throws schema codes)
// ---------------------------------------------------------------------------

export type WorkerBoundaryErrorCode =
  | 'invalid_input_schema'
  | 'lease_held'
  | 'stale_lease'
  | 'lease_expired'
  | 'duplicate_result'
  | 'policy_denial'
  | 'capability_denied'
  | 'output_exceeded'
  | 'binding_mismatch'
  | 'idempotency_conflict';

export class WorkerBoundaryError extends Error {
  override readonly name = 'WorkerBoundaryError';

  constructor(
    readonly code: WorkerBoundaryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Closed unions (verbatim M10 contract)
// ---------------------------------------------------------------------------

export type CompletionStatusV1 = 'completed' | 'failed' | 'aborted';

export const COMPLETION_STATUSES = [
  'completed',
  'failed',
  'aborted',
] as const satisfies readonly CompletionStatusV1[];

export type CleanPolicyV1 = 'clean' | 'preserve';

export const CLEAN_POLICIES = [
  'clean',
  'preserve',
] as const satisfies readonly CleanPolicyV1[];

export type ResultAdmissionOutcomeV1 = 'admitted' | 'rejected';

export const RESULT_ADMISSION_OUTCOMES = [
  'admitted',
  'rejected',
] as const satisfies readonly ResultAdmissionOutcomeV1[];

export type LeaseAdmissionOutcomeV1 = 'admitted' | 'refused';

export const LEASE_ADMISSION_OUTCOMES = [
  'admitted',
  'refused',
] as const satisfies readonly LeaseAdmissionOutcomeV1[];

export type ResultAdmissionReasonV1 =
  | 'invalid_input_schema'
  | 'idempotency_conflict'
  | 'duplicate_result'
  | 'binding_mismatch'
  | 'stale_lease'
  | 'lease_expired'
  | 'output_exceeded'
  | 'duration_exceeded';

export const RESULT_ADMISSION_REASONS = [
  'invalid_input_schema',
  'idempotency_conflict',
  'duplicate_result',
  'binding_mismatch',
  'stale_lease',
  'lease_expired',
  'output_exceeded',
  'duration_exceeded',
] as const satisfies readonly ResultAdmissionReasonV1[];

export type LeaseAdmissionReasonV1 = 'policy_denial' | 'lease_held';

export const LEASE_ADMISSION_REASONS = [
  'policy_denial',
  'lease_held',
] as const satisfies readonly LeaseAdmissionReasonV1[];

export type CapabilityBrokerReasonV1 = 'capability_denied';

export const CAPABILITY_BROKER_REASONS = [
  'capability_denied',
] as const satisfies readonly CapabilityBrokerReasonV1[];

export type CapabilityBrokerOutcomeV1 = 'granted' | 'denied';

export const CAPABILITY_BROKER_OUTCOMES = [
  'granted',
  'denied',
] as const satisfies readonly CapabilityBrokerOutcomeV1[];

// ---------------------------------------------------------------------------
// Records (verbatim from M10 contract TypeScript blocks)
// ---------------------------------------------------------------------------

export interface CapabilityGrantV1 {
  readonly grantId: string;
  readonly capabilityId: string;
  readonly operation: string;
  readonly scope: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly grantHash: string;
}

export interface ResultArtifactRefV1 {
  readonly artifactId: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface JobExecutionPayloadV1 {
  readonly workspaceRef: string;
  readonly inputArtifacts: readonly ResultArtifactRefV1[];
  readonly agentRole: string;
  readonly commandOrSpecHash: string;
  readonly outputSchemaRef: string;
  readonly payloadHash: string;
}

export interface JobSpecEnvironmentPolicyV1 {
  readonly cleanPolicy: CleanPolicyV1;
  readonly maxDurationMs: number;
  readonly maxOutputBytes: number;
  readonly allowedCapabilityIds: readonly string[];
  readonly policyHash: string;
}

export interface WorkerLeasePolicyV1 {
  readonly heartbeatIntervalMs: number;
  readonly leaseDurationMs: number;
  readonly maxLeaseLifetimeMs: number;
  readonly leasePolicyHash: string;
}

export interface JobSpecV1 {
  readonly schema: 'hercules-job-spec/v1';
  readonly issuer: 'hercules-program-control';
  readonly jobId: string;
  readonly taskId: string;
  readonly taskContractHash: string;
  readonly iterationId: string;
  readonly candidateCommit: string;
  readonly stageType: StageType;
  readonly executionPayload: JobExecutionPayloadV1;
  readonly capabilityGrants: readonly CapabilityGrantV1[];
  readonly environmentPolicy: JobSpecEnvironmentPolicyV1;
  readonly leasePolicy: WorkerLeasePolicyV1;
  readonly authorityEpoch: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly jobSpecHash: string;
}

export interface WorkerLeaseV1 {
  readonly schema: 'hercules-worker-lease/v1';
  readonly leaseId: string;
  readonly jobId: string;
  readonly jobSpecHash: string;
  readonly workerId: string;
  readonly leaseEpoch: number;
  readonly leasedAt: string;
  readonly lastHeartbeatAt: string;
  readonly expiresAt: string;
  readonly leaseHash: string;
}

export interface ResultPackageV1 {
  readonly schema: 'hercules-result-package/v1';
  readonly resultId: string;
  readonly jobId: string;
  readonly jobSpecHash: string;
  readonly leaseId: string;
  readonly leaseEpoch: number;
  readonly workerId: string;
  readonly completionStatus: CompletionStatusV1;
  readonly exitCode: number | null;
  readonly artifacts: readonly ResultArtifactRefV1[];
  readonly totalOutputBytes: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly resultHash: string;
}

export interface ResultAdmissionV1 {
  readonly schema: 'hercules-result-admission/v1';
  readonly outcome: ResultAdmissionOutcomeV1;
  readonly jobId: string;
  readonly resultId: string;
  readonly resultHash: string;
  readonly leaseEpoch: number;
  readonly reason: ResultAdmissionReasonV1 | null;
  readonly admittedAt: string;
  readonly admissionHash: string;
}

export interface LeaseAdmissionV1 {
  readonly schema: 'hercules-lease-admission/v1';
  readonly outcome: LeaseAdmissionOutcomeV1;
  readonly jobId: string;
  readonly workerId: string;
  readonly lease: WorkerLeaseV1 | null;
  readonly reason: LeaseAdmissionReasonV1 | null;
  readonly decidedAt: string;
  readonly admissionHash: string;
}

export interface CapabilityBrokerDecisionV1 {
  readonly schema: 'hercules-capability-broker-decision/v1';
  readonly outcome: CapabilityBrokerOutcomeV1;
  readonly jobId: string;
  readonly operation: string;
  readonly grant: CapabilityGrantV1 | null;
  readonly reason: CapabilityBrokerReasonV1 | null;
  readonly decidedAt: string;
  readonly decisionHash: string;
}

// ---------------------------------------------------------------------------
// Closed key lists
// ---------------------------------------------------------------------------

export const CAPABILITY_GRANT_KEYS = [
  'grantId',
  'capabilityId',
  'operation',
  'scope',
  'issuedAt',
  'expiresAt',
  'grantHash',
] as const;

export const RESULT_ARTIFACT_REF_KEYS = [
  'artifactId',
  'sha256',
  'byteLength',
] as const;

export const JOB_EXECUTION_PAYLOAD_KEYS = [
  'workspaceRef',
  'inputArtifacts',
  'agentRole',
  'commandOrSpecHash',
  'outputSchemaRef',
  'payloadHash',
] as const;

export const JOB_SPEC_ENVIRONMENT_POLICY_KEYS = [
  'cleanPolicy',
  'maxDurationMs',
  'maxOutputBytes',
  'allowedCapabilityIds',
  'policyHash',
] as const;

export const WORKER_LEASE_POLICY_KEYS = [
  'heartbeatIntervalMs',
  'leaseDurationMs',
  'maxLeaseLifetimeMs',
  'leasePolicyHash',
] as const;

export const JOB_SPEC_KEYS = [
  'schema',
  'issuer',
  'jobId',
  'taskId',
  'taskContractHash',
  'iterationId',
  'candidateCommit',
  'stageType',
  'executionPayload',
  'capabilityGrants',
  'environmentPolicy',
  'leasePolicy',
  'authorityEpoch',
  'issuedAt',
  'expiresAt',
  'jobSpecHash',
] as const;

export const WORKER_LEASE_KEYS = [
  'schema',
  'leaseId',
  'jobId',
  'jobSpecHash',
  'workerId',
  'leaseEpoch',
  'leasedAt',
  'lastHeartbeatAt',
  'expiresAt',
  'leaseHash',
] as const;

export const RESULT_PACKAGE_KEYS = [
  'schema',
  'resultId',
  'jobId',
  'jobSpecHash',
  'leaseId',
  'leaseEpoch',
  'workerId',
  'completionStatus',
  'exitCode',
  'artifacts',
  'totalOutputBytes',
  'startedAt',
  'completedAt',
  'resultHash',
] as const;

/** Mechanical proof that ResultAdmissionV1 carries no decision/task-state field. */
export const RESULT_ADMISSION_KEYS = [
  'schema',
  'outcome',
  'jobId',
  'resultId',
  'resultHash',
  'leaseEpoch',
  'reason',
  'admittedAt',
  'admissionHash',
] as const;

export const LEASE_ADMISSION_KEYS = [
  'schema',
  'outcome',
  'jobId',
  'workerId',
  'lease',
  'reason',
  'decidedAt',
  'admissionHash',
] as const;

export const CAPABILITY_BROKER_DECISION_KEYS = [
  'schema',
  'outcome',
  'jobId',
  'operation',
  'grant',
  'reason',
  'decidedAt',
  'decisionHash',
] as const;

// ---------------------------------------------------------------------------
// Local helpers (M8/M9 house pattern)
// ---------------------------------------------------------------------------

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_ARRAY_ITEMS = 4_096;
/**
 * Upper bound (ms) on any lease/heartbeat interval — 100 years. Absurdly
 * generous for a single-machine work lease, yet finite: it keeps every derived
 * `now + duration` well inside the RFC-3339 year-9999 range for any realistic
 * clock, so a validator-blessed policy can never drive lease-expiry arithmetic
 * out of representable range. `admitLease` still guards the residual (a `now`
 * itself near the year-9999 ceiling) by refusing with `policy_denial`.
 */
export const MAX_LEASE_INTERVAL_MS = 100 * 365 * 24 * 60 * 60 * 1_000;

function fail(message: string): never {
  throw new WorkerBoundaryError('invalid_input_schema', message);
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

function isBoundedNfcString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    utf8Bytes(value) >= 1 &&
    utf8Bytes(value) <= MAX_IDENTIFIER_BYTES &&
    value.normalize('NFC') === value
  );
}

function isBoundedIdentifier(value: unknown): value is string {
  return isBoundedNfcString(value) && isValidIdentifier(value);
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_RE.test(value);
}

function assertSha256Digest(
  value: unknown,
  label: string,
): asserts value is string {
  if (!isHash(value)) {
    fail(`${label} must be a sha256:<64hex> digest`);
  }
}

function isGitSha(value: unknown): value is string {
  return typeof value === 'string' && GIT_SHA_RE.test(value);
}

/**
 * Strict RFC-3339 UTC-Z, fixed millisecond precision, 4-digit year
 * (0001-9999). The 4-digit-year anchor is load-bearing: `Date#toISOString`
 * emits extended-year forms (`+0YYYYY-…Z`) for instants past year 9999, which
 * still round-trip through `Date` but break the "string order equals instant
 * order" invariant every timestamp comparison here relies on. Requiring the
 * exact `\d{4}` shape rejects those, so lexical order == chronological order.
 */
const CANONICAL_TS_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_TS_RE.test(value)) {
    return false;
  }
  const time = new Date(value);
  return !Number.isNaN(time.valueOf()) && time.toISOString() === value;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSafeIntegerOrNull(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isSafeInteger(value))
  );
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

function assertSortedUniqueBoundedStrings(
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
    if (!(index in value) || !isBoundedNfcString(value[index])) {
      fail(`${label} must contain bounded non-empty NFC strings`);
    }
    const current = value[index];
    if (previous !== null && previous >= current) {
      fail(`${label} must contain sorted unique strings`);
    }
    previous = current;
  }
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

/**
 * Deep-freeze acyclic canonical records. Recurses into already-frozen parents
 * so nested children are still sealed (M8 independentEvaluator idiom).
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  if (!Object.isFrozen(value)) {
    Object.freeze(value);
  }
  return value;
}

function assertSortedUniqueArtifactRefs(
  value: unknown,
  label: string,
): asserts value is readonly ResultArtifactRefV1[] {
  assertDenseArray(value, label);
  let previousId: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (entry === undefined) {
      fail(`${label} must not be sparse`);
    }
    assertResultArtifactRefV1(entry);
    if (previousId !== null && previousId >= entry.artifactId) {
      fail(`${label} must contain sorted unique artifactIds`);
    }
    previousId = entry.artifactId;
  }
}

// ---------------------------------------------------------------------------
// Hashing (omit-own-hash rule)
// ---------------------------------------------------------------------------

export function computeGrantHash(
  grant: Omit<CapabilityGrantV1, 'grantHash'>,
): string {
  return hashCanonicalJson(canonicalClone(grant));
}

export function computePayloadHash(
  payload: Omit<JobExecutionPayloadV1, 'payloadHash'>,
): string {
  return hashCanonicalJson(canonicalClone(payload));
}

export function computeEnvironmentPolicyHash(
  policy: Omit<JobSpecEnvironmentPolicyV1, 'policyHash'>,
): string {
  return hashCanonicalJson(canonicalClone(policy));
}

export function computeLeasePolicyHash(
  policy: Omit<WorkerLeasePolicyV1, 'leasePolicyHash'>,
): string {
  return hashCanonicalJson(canonicalClone(policy));
}

export function computeJobSpecHash(
  spec: Omit<JobSpecV1, 'jobSpecHash'>,
): string {
  return hashCanonicalJson(canonicalClone(spec));
}

export function computeLeaseHash(
  lease: Omit<WorkerLeaseV1, 'leaseHash'>,
): string {
  return hashCanonicalJson(canonicalClone(lease));
}

export function computeResultHash(
  result: Omit<ResultPackageV1, 'resultHash'>,
): string {
  return hashCanonicalJson(canonicalClone(result));
}

export function computeResultAdmissionHash(
  admission: Omit<ResultAdmissionV1, 'admissionHash'>,
): string {
  return hashCanonicalJson(canonicalClone(admission));
}

export function computeLeaseAdmissionHash(
  admission: Omit<LeaseAdmissionV1, 'admissionHash'>,
): string {
  return hashCanonicalJson(canonicalClone(admission));
}

export function computeBrokerDecisionHash(
  decision: Omit<CapabilityBrokerDecisionV1, 'decisionHash'>,
): string {
  return hashCanonicalJson(canonicalClone(decision));
}

// ---------------------------------------------------------------------------
// Structural validators
// ---------------------------------------------------------------------------

export function assertResultArtifactRefV1(
  value: unknown,
): asserts value is ResultArtifactRefV1 {
  assertExactRecord(value, RESULT_ARTIFACT_REF_KEYS, 'result artifact ref');
  const record = value as unknown as ResultArtifactRefV1;
  if (!isBoundedIdentifier(record.artifactId)) {
    fail('result artifact ref artifactId must be a bounded identifier');
  }
  assertSha256Digest(record.sha256, 'result artifact ref sha256');
  if (!isNonNegativeSafeInteger(record.byteLength)) {
    fail('result artifact ref byteLength must be a non-negative safe integer');
  }
  deepFreeze(record);
}

export function assertCapabilityGrantV1(
  value: unknown,
): asserts value is CapabilityGrantV1 {
  assertExactRecord(value, CAPABILITY_GRANT_KEYS, 'capability grant');
  const grant = value as unknown as CapabilityGrantV1;
  if (
    !isBoundedIdentifier(grant.grantId) ||
    !isBoundedIdentifier(grant.capabilityId) ||
    !isBoundedNfcString(grant.operation) ||
    !isBoundedNfcString(grant.scope) ||
    !isCanonicalTimestamp(grant.issuedAt) ||
    !isCanonicalTimestamp(grant.expiresAt) ||
    !isHash(grant.grantHash)
  ) {
    fail(
      'capability grant identity, operation, scope, timestamps, and hash must be valid',
    );
  }
  if (grant.expiresAt <= grant.issuedAt) {
    fail('capability grant expiresAt must be strictly after issuedAt');
  }
  const expectedHash = hashCanonicalJson(omitHash(grant, 'grantHash'));
  if (grant.grantHash !== expectedHash) {
    fail('capability grant hash does not match the exact record');
  }
  deepFreeze(grant);
}

export function assertJobExecutionPayloadV1(
  value: unknown,
): asserts value is JobExecutionPayloadV1 {
  assertExactRecord(value, JOB_EXECUTION_PAYLOAD_KEYS, 'job execution payload');
  const payload = value as unknown as JobExecutionPayloadV1;
  if (
    !isHash(payload.workspaceRef) ||
    !isBoundedNfcString(payload.agentRole) ||
    !isHash(payload.commandOrSpecHash) ||
    !isHash(payload.outputSchemaRef) ||
    !isHash(payload.payloadHash)
  ) {
    fail(
      'job execution payload refs, role, and hash must be valid digests and NFC strings',
    );
  }
  assertSortedUniqueArtifactRefs(
    payload.inputArtifacts,
    'job execution payload inputArtifacts',
  );
  const expectedHash = hashCanonicalJson(omitHash(payload, 'payloadHash'));
  if (payload.payloadHash !== expectedHash) {
    fail('job execution payload hash does not match the exact record');
  }
  deepFreeze(payload);
}

export function assertJobSpecEnvironmentPolicyV1(
  value: unknown,
): asserts value is JobSpecEnvironmentPolicyV1 {
  assertExactRecord(
    value,
    JOB_SPEC_ENVIRONMENT_POLICY_KEYS,
    'job spec environment policy',
  );
  const policy = value as unknown as JobSpecEnvironmentPolicyV1;
  if (
    !(CLEAN_POLICIES as readonly unknown[]).includes(policy.cleanPolicy) ||
    !isNonNegativeSafeInteger(policy.maxDurationMs) ||
    !isNonNegativeSafeInteger(policy.maxOutputBytes) ||
    !isHash(policy.policyHash)
  ) {
    fail(
      'job spec environment policy cleanPolicy, bounds, and hash must be valid',
    );
  }
  assertSortedUniqueBoundedStrings(
    policy.allowedCapabilityIds,
    'job spec environment policy allowedCapabilityIds',
  );
  for (const capabilityId of policy.allowedCapabilityIds) {
    if (!isBoundedIdentifier(capabilityId)) {
      fail(
        'job spec environment policy allowedCapabilityIds must be bounded identifiers',
      );
    }
  }
  const expectedHash = hashCanonicalJson(omitHash(policy, 'policyHash'));
  if (policy.policyHash !== expectedHash) {
    fail('job spec environment policy hash does not match the exact record');
  }
  deepFreeze(policy);
}

export function assertWorkerLeasePolicyV1(
  value: unknown,
): asserts value is WorkerLeasePolicyV1 {
  assertExactRecord(value, WORKER_LEASE_POLICY_KEYS, 'worker lease policy');
  const policy = value as unknown as WorkerLeasePolicyV1;
  if (
    !isNonNegativeSafeInteger(policy.heartbeatIntervalMs) ||
    !isNonNegativeSafeInteger(policy.leaseDurationMs) ||
    !isNonNegativeSafeInteger(policy.maxLeaseLifetimeMs) ||
    !isHash(policy.leasePolicyHash)
  ) {
    fail('worker lease policy intervals and hash must be valid');
  }
  if (
    policy.heartbeatIntervalMs > MAX_LEASE_INTERVAL_MS ||
    policy.leaseDurationMs > MAX_LEASE_INTERVAL_MS ||
    policy.maxLeaseLifetimeMs > MAX_LEASE_INTERVAL_MS
  ) {
    fail(
      `worker lease policy intervals must not exceed ${MAX_LEASE_INTERVAL_MS} ms`,
    );
  }
  const expectedHash = hashCanonicalJson(omitHash(policy, 'leasePolicyHash'));
  if (policy.leasePolicyHash !== expectedHash) {
    fail('worker lease policy hash does not match the exact record');
  }
  deepFreeze(policy);
}

export function assertJobSpecV1(value: unknown): asserts value is JobSpecV1 {
  assertExactRecord(value, JOB_SPEC_KEYS, 'job spec');
  const spec = value as unknown as JobSpecV1;
  if (
    spec.schema !== 'hercules-job-spec/v1' ||
    spec.issuer !== 'hercules-program-control' ||
    !isBoundedIdentifier(spec.jobId) ||
    !isBoundedIdentifier(spec.taskId) ||
    !isHash(spec.taskContractHash) ||
    !isBoundedIdentifier(spec.iterationId) ||
    !isGitSha(spec.candidateCommit) ||
    !(STAGE_TYPES as readonly unknown[]).includes(spec.stageType) ||
    !isBoundedNfcString(spec.authorityEpoch) ||
    !isCanonicalTimestamp(spec.issuedAt) ||
    !isCanonicalTimestamp(spec.expiresAt) ||
    !isHash(spec.jobSpecHash)
  ) {
    fail(
      'job spec schema, identities, commit, stage, timestamps, and hash must be valid',
    );
  }
  if (spec.expiresAt <= spec.issuedAt) {
    fail('job spec expiresAt must be strictly after issuedAt');
  }
  assertJobExecutionPayloadV1(spec.executionPayload);
  assertJobSpecEnvironmentPolicyV1(spec.environmentPolicy);
  assertWorkerLeasePolicyV1(spec.leasePolicy);
  assertDenseArray(spec.capabilityGrants, 'job spec capabilityGrants');
  const grantIds = new Set<string>();
  const allowed = new Set(spec.environmentPolicy.allowedCapabilityIds);
  for (let index = 0; index < spec.capabilityGrants.length; index += 1) {
    const grant = spec.capabilityGrants[index];
    if (grant === undefined) {
      fail('job spec capabilityGrants must not be sparse');
    }
    assertCapabilityGrantV1(grant);
    if (grantIds.has(grant.grantId)) {
      fail('job spec capabilityGrants grantIds must be unique');
    }
    grantIds.add(grant.grantId);
    if (!allowed.has(grant.capabilityId)) {
      fail(
        'job spec capabilityGrants may reference only environmentPolicy.allowedCapabilityIds',
      );
    }
  }
  const expectedHash = hashCanonicalJson(omitHash(spec, 'jobSpecHash'));
  if (spec.jobSpecHash !== expectedHash) {
    fail('job spec hash does not match the exact record');
  }
  deepFreeze(spec);
}

export function assertWorkerLeaseV1(
  value: unknown,
): asserts value is WorkerLeaseV1 {
  assertExactRecord(value, WORKER_LEASE_KEYS, 'worker lease');
  const lease = value as unknown as WorkerLeaseV1;
  if (
    lease.schema !== 'hercules-worker-lease/v1' ||
    !isHash(lease.leaseId) ||
    !isBoundedIdentifier(lease.jobId) ||
    !isHash(lease.jobSpecHash) ||
    !isBoundedIdentifier(lease.workerId) ||
    !isNonNegativeSafeInteger(lease.leaseEpoch) ||
    !isCanonicalTimestamp(lease.leasedAt) ||
    !isCanonicalTimestamp(lease.lastHeartbeatAt) ||
    !isCanonicalTimestamp(lease.expiresAt) ||
    !isHash(lease.leaseHash)
  ) {
    fail(
      'worker lease schema, identities, epoch, timestamps, and hash must be valid',
    );
  }
  // Temporal cross-field invariant: leasedAt <= lastHeartbeatAt <= expiresAt,
  // with expiresAt strictly after leasedAt. Timestamps are strict canonical
  // UTC-Z, so lexical order is chronological. This rejects a
  // heartbeat-before-creation lease that would otherwise let renewal arithmetic
  // derive a degenerate expiresAt.
  if (
    lease.lastHeartbeatAt < lease.leasedAt ||
    lease.expiresAt < lease.lastHeartbeatAt ||
    lease.expiresAt <= lease.leasedAt
  ) {
    fail(
      'worker lease timestamps must satisfy leasedAt <= lastHeartbeatAt <= expiresAt and leasedAt < expiresAt',
    );
  }
  const expectedHash = hashCanonicalJson(omitHash(lease, 'leaseHash'));
  if (lease.leaseHash !== expectedHash) {
    fail('worker lease hash does not match the exact record');
  }
  deepFreeze(lease);
}

export function assertResultPackageV1(
  value: unknown,
): asserts value is ResultPackageV1 {
  assertExactRecord(value, RESULT_PACKAGE_KEYS, 'result package');
  const result = value as unknown as ResultPackageV1;
  if (
    result.schema !== 'hercules-result-package/v1' ||
    !isBoundedIdentifier(result.resultId) ||
    !isBoundedIdentifier(result.jobId) ||
    !isHash(result.jobSpecHash) ||
    !isHash(result.leaseId) ||
    !isNonNegativeSafeInteger(result.leaseEpoch) ||
    !isBoundedIdentifier(result.workerId) ||
    !(COMPLETION_STATUSES as readonly unknown[]).includes(
      result.completionStatus,
    ) ||
    !isSafeIntegerOrNull(result.exitCode) ||
    !isNonNegativeSafeInteger(result.totalOutputBytes) ||
    !isCanonicalTimestamp(result.startedAt) ||
    !isCanonicalTimestamp(result.completedAt) ||
    !isHash(result.resultHash)
  ) {
    fail(
      'result package schema, identities, status, bytes, timestamps, and hash must be valid',
    );
  }
  if (result.completedAt < result.startedAt) {
    fail('result package completedAt must be >= startedAt');
  }
  assertSortedUniqueArtifactRefs(result.artifacts, 'result package artifacts');
  let sum = 0;
  for (const artifact of result.artifacts) {
    sum += artifact.byteLength;
  }
  if (result.totalOutputBytes !== sum) {
    fail(
      'result package totalOutputBytes must equal the summed artifact byteLengths',
    );
  }
  const expectedHash = hashCanonicalJson(omitHash(result, 'resultHash'));
  if (result.resultHash !== expectedHash) {
    fail('result package hash does not match the exact record');
  }
  deepFreeze(result);
}

export function assertResultAdmissionV1(
  value: unknown,
): asserts value is ResultAdmissionV1 {
  assertExactRecord(value, RESULT_ADMISSION_KEYS, 'result admission');
  const admission = value as unknown as ResultAdmissionV1;
  if (
    admission.schema !== 'hercules-result-admission/v1' ||
    !(RESULT_ADMISSION_OUTCOMES as readonly unknown[]).includes(
      admission.outcome,
    ) ||
    !isBoundedIdentifier(admission.jobId) ||
    !isBoundedIdentifier(admission.resultId) ||
    !isHash(admission.resultHash) ||
    !isNonNegativeSafeInteger(admission.leaseEpoch) ||
    !isCanonicalTimestamp(admission.admittedAt) ||
    !isHash(admission.admissionHash)
  ) {
    fail(
      'result admission schema, outcome, identities, epoch, timestamp, and hash must be valid',
    );
  }
  const reasonPresent = admission.reason !== null;
  if (admission.outcome === 'rejected') {
    if (!reasonPresent) {
      fail('result admission reason must be non-null when outcome is rejected');
    }
    if (
      !(RESULT_ADMISSION_REASONS as readonly unknown[]).includes(admission.reason)
    ) {
      fail('result admission reason must be a closed ResultAdmissionReasonV1');
    }
  } else if (reasonPresent) {
    fail('result admission reason must be null when outcome is admitted');
  }
  const expectedHash = hashCanonicalJson(omitHash(admission, 'admissionHash'));
  if (admission.admissionHash !== expectedHash) {
    fail('result admission hash does not match the exact record');
  }
  deepFreeze(admission);
}

export function assertLeaseAdmissionV1(
  value: unknown,
): asserts value is LeaseAdmissionV1 {
  assertExactRecord(value, LEASE_ADMISSION_KEYS, 'lease admission');
  const admission = value as unknown as LeaseAdmissionV1;
  if (
    admission.schema !== 'hercules-lease-admission/v1' ||
    !(LEASE_ADMISSION_OUTCOMES as readonly unknown[]).includes(
      admission.outcome,
    ) ||
    !isBoundedIdentifier(admission.jobId) ||
    !isBoundedIdentifier(admission.workerId) ||
    !isCanonicalTimestamp(admission.decidedAt) ||
    !isHash(admission.admissionHash)
  ) {
    fail(
      'lease admission schema, outcome, identities, timestamp, and hash must be valid',
    );
  }
  const leasePresent = admission.lease !== null;
  const reasonPresent = admission.reason !== null;
  if (admission.outcome === 'admitted') {
    if (!leasePresent) {
      fail('lease admission lease must be non-null when outcome is admitted');
    }
    if (reasonPresent) {
      fail('lease admission reason must be null when outcome is admitted');
    }
    assertWorkerLeaseV1(admission.lease);
  } else {
    if (leasePresent) {
      fail('lease admission lease must be null when outcome is refused');
    }
    if (!reasonPresent) {
      fail('lease admission reason must be non-null when outcome is refused');
    }
    if (
      !(LEASE_ADMISSION_REASONS as readonly unknown[]).includes(admission.reason)
    ) {
      fail('lease admission reason must be a closed LeaseAdmissionReasonV1');
    }
  }
  const expectedHash = hashCanonicalJson(omitHash(admission, 'admissionHash'));
  if (admission.admissionHash !== expectedHash) {
    fail('lease admission hash does not match the exact record');
  }
  deepFreeze(admission);
}

export function assertCapabilityBrokerDecisionV1(
  value: unknown,
): asserts value is CapabilityBrokerDecisionV1 {
  assertExactRecord(
    value,
    CAPABILITY_BROKER_DECISION_KEYS,
    'capability broker decision',
  );
  const decision = value as unknown as CapabilityBrokerDecisionV1;
  if (
    decision.schema !== 'hercules-capability-broker-decision/v1' ||
    !(CAPABILITY_BROKER_OUTCOMES as readonly unknown[]).includes(
      decision.outcome,
    ) ||
    !isBoundedIdentifier(decision.jobId) ||
    !isBoundedNfcString(decision.operation) ||
    !isCanonicalTimestamp(decision.decidedAt) ||
    !isHash(decision.decisionHash)
  ) {
    fail(
      'capability broker decision schema, outcome, identities, timestamp, and hash must be valid',
    );
  }
  const grantPresent = decision.grant !== null;
  const reasonPresent = decision.reason !== null;
  if (decision.outcome === 'granted') {
    if (!grantPresent) {
      fail(
        'capability broker decision grant must be non-null when outcome is granted',
      );
    }
    if (reasonPresent) {
      fail(
        'capability broker decision reason must be null when outcome is granted',
      );
    }
    assertCapabilityGrantV1(decision.grant);
  } else {
    if (grantPresent) {
      fail(
        'capability broker decision grant must be null when outcome is denied',
      );
    }
    if (!reasonPresent) {
      fail(
        'capability broker decision reason must be non-null when outcome is denied',
      );
    }
    if (
      !(CAPABILITY_BROKER_REASONS as readonly unknown[]).includes(
        decision.reason,
      )
    ) {
      fail(
        'capability broker decision reason must be a closed CapabilityBrokerReasonV1',
      );
    }
  }
  const expectedHash = hashCanonicalJson(omitHash(decision, 'decisionHash'));
  if (decision.decisionHash !== expectedHash) {
    fail('capability broker decision hash does not match the exact record');
  }
  deepFreeze(decision);
}
