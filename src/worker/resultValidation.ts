/**
 * M10 result validation — pure control-side decision.
 *
 * Total over well-formed control inputs. Malformed control-owned inputs
 * throw WorkerBoundaryError `invalid_input_schema` as a documented
 * precondition. Imports only `src/domain/*`. Time comes from the caller-
 * supplied `now` string; never from `Date.now()`.
 *
 * This function does NOT mutate the dedup ledger. On admit it returns the
 * admission; the CALLER appends `(resultId, resultHash, admission)` to the
 * ledger.
 */

import {
  WorkerBoundaryError,
  assertJobSpecV1,
  assertResultAdmissionV1,
  assertResultPackageV1,
  assertWorkerLeaseV1,
  computeResultAdmissionHash,
  isCanonicalTimestamp,
  type JobSpecV1,
  type ResultAdmissionReasonV1,
  type ResultAdmissionV1,
  type ResultPackageV1,
  type WorkerLeaseV1,
} from '../domain/workerBoundary.js';

/**
 * One previously-ADMITTED result for a job. The ledger holds 0 or 1 entries
 * in practice (a job admits at most one result). Validate entries are
 * well-formed at the boundary before calling {@link validateResult}.
 */
export interface DedupLedgerEntryV1 {
  readonly resultId: string;
  readonly resultHash: string;
  readonly admission: ResultAdmissionV1;
}

function failInvalidInput(message: string): never {
  throw new WorkerBoundaryError('invalid_input_schema', message);
}

function assertDedupLedgerEntry(entry: unknown, index: number): asserts entry is DedupLedgerEntryV1 {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    failInvalidInput(`dedup ledger entry[${index}] must be an object`);
  }
  const record = entry as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ['admission', 'resultHash', 'resultId'].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, i) => key !== expected[i])
  ) {
    failInvalidInput(`dedup ledger entry[${index}] must use the exact closed schema`);
  }
  if (typeof record['resultId'] !== 'string' || record['resultId'].length === 0) {
    failInvalidInput(`dedup ledger entry[${index}].resultId must be a non-empty string`);
  }
  if (typeof record['resultHash'] !== 'string' || record['resultHash'].length === 0) {
    failInvalidInput(`dedup ledger entry[${index}].resultHash must be a non-empty string`);
  }
  assertResultAdmissionV1(record['admission']);
  const admission = record['admission'] as ResultAdmissionV1;
  if (admission.outcome !== 'admitted') {
    failInvalidInput(
      `dedup ledger entry[${index}] must carry an admitted ResultAdmissionV1`,
    );
  }
  if (admission.resultId !== record['resultId']) {
    failInvalidInput(
      `dedup ledger entry[${index}].resultId must match admission.resultId`,
    );
  }
  if (admission.resultHash !== record['resultHash']) {
    failInvalidInput(
      `dedup ledger entry[${index}].resultHash must match admission.resultHash`,
    );
  }
}

function buildAdmission(
  fields: Omit<ResultAdmissionV1, 'admissionHash'>,
): ResultAdmissionV1 {
  const admission: ResultAdmissionV1 = {
    ...fields,
    admissionHash: computeResultAdmissionHash(fields),
  };
  assertResultAdmissionV1(admission);
  return admission;
}

function reject(
  result: ResultPackageV1,
  reason: ResultAdmissionReasonV1,
  admittedAt: string,
): ResultAdmissionV1 {
  return buildAdmission({
    schema: 'hercules-result-admission/v1',
    outcome: 'rejected',
    jobId: result.jobId,
    resultId: result.resultId,
    resultHash: result.resultHash,
    leaseEpoch: result.leaseEpoch,
    reason,
    admittedAt,
  });
}

function admit(result: ResultPackageV1, admittedAt: string): ResultAdmissionV1 {
  return buildAdmission({
    schema: 'hercules-result-admission/v1',
    outcome: 'admitted',
    jobId: result.jobId,
    resultId: result.resultId,
    resultHash: result.resultHash,
    leaseEpoch: result.leaseEpoch,
    reason: null,
    admittedAt,
  });
}

/**
 * Pure result validation / idempotent admission decision.
 *
 * Preconditions (throw `invalid_input_schema`): well-formed `result`,
 * `jobSpec`, `admittingLease`, each ledger entry, canonical `now`, and
 * control-caller consistency `admittingLease.jobId === jobSpec.jobId` and
 * `admittingLease.jobSpecHash === jobSpec.jobSpecHash` (the caller must pass
 * the job's own current lease; JobSpec↔lease consistency is a trusted-caller
 * precondition, not a worker-forgery path).
 *
 * Otherwise exactly one mutually exclusive branch of the pinned total order
 * fires and a closed `ResultAdmissionV1` is returned. Never throws for a
 * rejection — only for a precondition violation.
 *
 * Does NOT mutate `ledger`; the caller appends on admit.
 */
export function validateResult(
  result: ResultPackageV1,
  jobSpec: JobSpecV1,
  admittingLease: WorkerLeaseV1,
  ledger: readonly DedupLedgerEntryV1[],
  now: string,
): ResultAdmissionV1 {
  assertResultPackageV1(result);
  assertJobSpecV1(jobSpec);
  assertWorkerLeaseV1(admittingLease);
  if (!Array.isArray(ledger)) {
    failInvalidInput('ledger must be an array');
  }
  for (let index = 0; index < ledger.length; index += 1) {
    assertDedupLedgerEntry(ledger[index], index);
  }
  if (!isCanonicalTimestamp(now)) {
    failInvalidInput('now must be a canonical UTC-Z millisecond timestamp');
  }
  if (admittingLease.jobId !== jobSpec.jobId) {
    failInvalidInput(
      'admittingLease.jobId must equal jobSpec.jobId (trusted-caller consistency)',
    );
  }
  if (admittingLease.jobSpecHash !== jobSpec.jobSpecHash) {
    failInvalidInput(
      'admittingLease.jobSpecHash must equal jobSpec.jobSpecHash (trusted-caller consistency)',
    );
  }

  // 2. Replay / conflict (before ANY lease check) — epoch-independent
  const priorSameId = ledger.find((entry) => entry.resultId === result.resultId);
  if (priorSameId !== undefined) {
    if (priorSameId.resultHash === result.resultHash) {
      // Byte-identical stored admission; do not rebuild.
      return priorSameId.admission;
    }
    return reject(result, 'idempotency_conflict', now);
  }

  // 3. Duplicate — a job admits at most one result
  if (ledger.length > 0) {
    return reject(result, 'duplicate_result', now);
  }

  // 4. Binding — total over (jobId, jobSpecHash, workerId, leaseEpoch, leaseId)
  if (
    result.jobId !== jobSpec.jobId ||
    result.jobSpecHash !== jobSpec.jobSpecHash ||
    result.workerId !== admittingLease.workerId
  ) {
    return reject(result, 'binding_mismatch', now);
  }
  if (result.leaseEpoch < admittingLease.leaseEpoch) {
    // Earlier-epoch result whose job/worker fields match the current lease —
    // i.e. the SAME worker's superseded lease; a different-worker superseded
    // lease already fell out as binding_mismatch on the workerId check above.
    return reject(result, 'stale_lease', now);
  }
  if (
    (result.leaseEpoch === admittingLease.leaseEpoch &&
      result.leaseId !== admittingLease.leaseId) ||
    result.leaseEpoch > admittingLease.leaseEpoch
  ) {
    // Fabricated / future lease
    return reject(result, 'binding_mismatch', now);
  }

  // 5. Lease liveness
  if (now >= admittingLease.expiresAt) {
    return reject(result, 'lease_expired', now);
  }

  // 6. Policy bounds (fixed sub-order: output then duration)
  if (result.totalOutputBytes > jobSpec.environmentPolicy.maxOutputBytes) {
    return reject(result, 'output_exceeded', now);
  }
  const elapsedMs =
    Date.parse(result.completedAt) - Date.parse(result.startedAt);
  if (elapsedMs > jobSpec.environmentPolicy.maxDurationMs) {
    return reject(result, 'duration_exceeded', now);
  }

  // 7. Admit
  return admit(result, now);
}
