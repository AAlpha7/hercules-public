/**
 * M10 lease admission — pure control-side decision.
 *
 * Total over well-formed control inputs. Malformed control-owned inputs
 * (jobSpec / current lease / workerId / now) throw WorkerBoundaryError
 * `invalid_input_schema` as a documented precondition. Imports only
 * `src/domain/*`. Time comes from the caller-supplied `now` (or an injected
 * {@link WorkerClock}); never from `Date.now()`.
 */

import { canonicalClone, hashCanonicalJson } from '../domain/canonicalJson.js';
import { isValidIdentifier } from '../domain/task.js';
import {
  WorkerBoundaryError,
  assertJobSpecV1,
  assertLeaseAdmissionV1,
  assertWorkerLeaseV1,
  computeLeaseAdmissionHash,
  computeLeaseHash,
  isCanonicalTimestamp,
  type JobSpecV1,
  type LeaseAdmissionReasonV1,
  type LeaseAdmissionV1,
  type WorkerLeaseV1,
} from '../domain/workerBoundary.js';

/** Injected clock seam; a fixed clock makes admissions byte-reproducible. */
export interface WorkerClock {
  nowUtc(): string;
}

/** Optional wall-clock concrete; callers select whether to use it. */
export const WALL_CLOCK: WorkerClock = {
  nowUtc: () => new Date().toISOString(),
};

const MAX_IDENTIFIER_CHARS = 256;

function failInvalidInput(message: string): never {
  throw new WorkerBoundaryError('invalid_input_schema', message);
}

function isBoundedIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_IDENTIFIER_CHARS &&
    value.normalize('NFC') === value &&
    isValidIdentifier(value)
  );
}

/**
 * Add a millisecond delta to a validated UTC-Z timestamp, returning `null` when
 * the result is not a representable strict canonical timestamp (year > 9999, or
 * beyond the Date range). Never throws: the caller turns `null` into a closed
 * `policy_denial`, so lease-expiry arithmetic can never emit a raw `RangeError`
 * or an extended-year timestamp that would break the string-order invariant.
 */
function addUtcMs(iso: string, ms: number): string | null {
  const sum = Date.parse(iso) + ms;
  if (!Number.isFinite(sum) || Math.abs(sum) > 8.64e15) {
    return null; // outside the representable Date range
  }
  const candidate = new Date(sum).toISOString();
  return isCanonicalTimestamp(candidate) ? candidate : null;
}

function minIso(left: string, right: string): string {
  return left <= right ? left : right;
}

function deriveLeaseId(
  jobId: string,
  leaseEpoch: number,
  leasedAt: string,
): string {
  return hashCanonicalJson(canonicalClone({ jobId, leaseEpoch, leasedAt }));
}

function buildLease(
  fields: Omit<WorkerLeaseV1, 'leaseHash'>,
): WorkerLeaseV1 {
  const lease: WorkerLeaseV1 = {
    ...fields,
    leaseHash: computeLeaseHash(fields),
  };
  assertWorkerLeaseV1(lease);
  return lease;
}

function buildAdmission(
  fields: Omit<LeaseAdmissionV1, 'admissionHash'>,
): LeaseAdmissionV1 {
  const admission: LeaseAdmissionV1 = {
    ...fields,
    admissionHash: computeLeaseAdmissionHash(fields),
  };
  assertLeaseAdmissionV1(admission);
  return admission;
}

function refuse(
  jobId: string,
  workerId: string,
  reason: LeaseAdmissionReasonV1,
  decidedAt: string,
): LeaseAdmissionV1 {
  return buildAdmission({
    schema: 'hercules-lease-admission/v1',
    outcome: 'refused',
    jobId,
    workerId,
    lease: null,
    reason,
    decidedAt,
  });
}

function admit(
  jobId: string,
  workerId: string,
  lease: WorkerLeaseV1,
  decidedAt: string,
): LeaseAdmissionV1 {
  return buildAdmission({
    schema: 'hercules-lease-admission/v1',
    outcome: 'admitted',
    jobId,
    workerId,
    lease,
    reason: null,
    decidedAt,
  });
}

/**
 * Pure lease admission / renewal decision.
 *
 * Preconditions (throw `invalid_input_schema`): well-formed `jobSpec`,
 * well-formed `current` when non-null, bounded `workerId`, canonical `now`,
 * and when `current` is non-null, `now >= current.lastHeartbeatAt`
 * (control supplies a non-decreasing clock; a now earlier than the current
 * lease's last activity is an inconsistent control input).
 * Otherwise exactly one mutually exclusive branch fires and a closed
 * `LeaseAdmissionV1` is returned.
 */
export function admitLease(
  current: WorkerLeaseV1 | null,
  jobSpec: JobSpecV1,
  workerId: string,
  now: string,
): LeaseAdmissionV1 {
  assertJobSpecV1(jobSpec);
  if (current !== null) {
    assertWorkerLeaseV1(current);
  }
  if (!isBoundedIdentifier(workerId)) {
    failInvalidInput('workerId must be a bounded identifier');
  }
  if (!isCanonicalTimestamp(now)) {
    failInvalidInput('now must be a canonical UTC-Z millisecond timestamp');
  }
  if (current !== null && now < current.lastHeartbeatAt) {
    failInvalidInput(
      'now must not precede the current lease lastHeartbeatAt (monotonic time)',
    );
  }

  const jobId = jobSpec.jobId;
  const jobSpecHash = jobSpec.jobSpecHash;
  const policy = jobSpec.leasePolicy;
  const { leaseDurationMs, maxLeaseLifetimeMs } = policy;

  // 0. Policy sanity
  if (
    leaseDurationMs <= 0 ||
    maxLeaseLifetimeMs <= 0 ||
    maxLeaseLifetimeMs < leaseDurationMs
  ) {
    return refuse(jobId, workerId, 'policy_denial', now);
  }

  // 1. No live lease (absent or expired) → fresh admission
  if (current === null || now >= current.expiresAt) {
    const leaseEpoch = current === null ? 0 : current.leaseEpoch + 1;
    const leasedAt = now;
    const lastHeartbeatAt = now;
    const leaseId = deriveLeaseId(jobId, leaseEpoch, leasedAt);
    const expiresAt = addUtcMs(
      now,
      Math.min(leaseDurationMs, maxLeaseLifetimeMs),
    );
    if (expiresAt === null) {
      // `now` is so near the RFC-3339 ceiling that no representable lease can be
      // issued — a closed refusal, never a raw overflow.
      return refuse(jobId, workerId, 'policy_denial', now);
    }
    const lease = buildLease({
      schema: 'hercules-worker-lease/v1',
      leaseId,
      jobId,
      jobSpecHash,
      workerId,
      leaseEpoch,
      leasedAt,
      lastHeartbeatAt,
      expiresAt,
    });
    return admit(jobId, workerId, lease, now);
  }

  // 2. Live lease, different worker
  if (current.workerId !== workerId) {
    return refuse(jobId, workerId, 'lease_held', now);
  }

  // 3. Live lease, same worker → renew in place
  const nowPlusDuration = addUtcMs(now, leaseDurationMs);
  const cap = addUtcMs(current.leasedAt, maxLeaseLifetimeMs);
  if (nowPlusDuration === null || cap === null) {
    return refuse(jobId, workerId, 'policy_denial', now);
  }
  const expiresAt = minIso(nowPlusDuration, cap);
  // For a well-formed `current` (expiresAt <= leasedAt + maxLife, which every
  // lease this module builds satisfies), we are in branch 3 because
  // now < current.expiresAt <= cap, so expiresAt > now. Guard the residual:
  // a caller-supplied `current` whose expiresAt exceeds its own cumulative cap
  // could drive expiresAt <= now; refuse it closed rather than build a
  // degenerate lease.
  if (expiresAt <= now) {
    return refuse(jobId, workerId, 'policy_denial', now);
  }
  const lease = buildLease({
    schema: 'hercules-worker-lease/v1',
    leaseId: current.leaseId,
    jobId: current.jobId,
    jobSpecHash: current.jobSpecHash,
    workerId: current.workerId,
    leaseEpoch: current.leaseEpoch,
    leasedAt: current.leasedAt,
    lastHeartbeatAt: now,
    expiresAt,
  });
  return admit(jobId, workerId, lease, now);
}
