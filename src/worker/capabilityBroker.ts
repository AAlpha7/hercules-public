/**
 * M10 capability broker — pure control-side decision.
 *
 * Total over well-formed control inputs. Malformed control-owned inputs
 * throw WorkerBoundaryError `invalid_input_schema` as a documented
 * precondition. Imports only `src/domain/*`. Time comes from the caller-
 * supplied `now` string; never from `Date.now()`.
 *
 * NEVER returns, logs, or hashes a secret (grants carry none). When multiple
 * grants match the requested operation, the first in `capabilityGrants`
 * array order is selected (deterministic).
 */

import {
  WorkerBoundaryError,
  assertCapabilityBrokerDecisionV1,
  assertJobSpecV1,
  computeBrokerDecisionHash,
  isCanonicalTimestamp,
  type CapabilityBrokerDecisionV1,
  type CapabilityGrantV1,
  type JobSpecV1,
} from '../domain/workerBoundary.js';

const MAX_IDENTIFIER_BYTES = 256;

function failInvalidInput(message: string): never {
  throw new WorkerBoundaryError('invalid_input_schema', message);
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

function buildDecision(
  fields: Omit<CapabilityBrokerDecisionV1, 'decisionHash'>,
): CapabilityBrokerDecisionV1 {
  const decision: CapabilityBrokerDecisionV1 = {
    ...fields,
    decisionHash: computeBrokerDecisionHash(fields),
  };
  assertCapabilityBrokerDecisionV1(decision);
  return decision;
}

function grantDecision(
  jobId: string,
  operation: string,
  grant: CapabilityGrantV1,
  decidedAt: string,
): CapabilityBrokerDecisionV1 {
  return buildDecision({
    schema: 'hercules-capability-broker-decision/v1',
    outcome: 'granted',
    jobId,
    operation,
    grant,
    reason: null,
    decidedAt,
  });
}

function denyDecision(
  jobId: string,
  operation: string,
  decidedAt: string,
): CapabilityBrokerDecisionV1 {
  return buildDecision({
    schema: 'hercules-capability-broker-decision/v1',
    outcome: 'denied',
    jobId,
    operation,
    grant: null,
    reason: 'capability_denied',
    decidedAt,
  });
}

/**
 * Pure capability-broker decision.
 *
 * Preconditions (throw `invalid_input_schema`): well-formed `jobSpec`,
 * bounded NFC `operation`, canonical UTC-Z `now`.
 *
 * Finds the first grant in `jobSpec.capabilityGrants` (array order) whose
 * `operation` matches, that is unexpired (`now < grant.expiresAt`), and whose
 * `capabilityId` is in `jobSpec.environmentPolicy.allowedCapabilityIds`.
 * If exactly such a grant exists → `granted` with that grant; otherwise
 * → `denied` with `capability_denied`.
 */
export function brokerCapability(
  jobSpec: JobSpecV1,
  operation: string,
  now: string,
): CapabilityBrokerDecisionV1 {
  assertJobSpecV1(jobSpec);
  if (!isBoundedNfcString(operation)) {
    failInvalidInput('operation must be a bounded non-empty NFC string');
  }
  if (!isCanonicalTimestamp(now)) {
    failInvalidInput('now must be a canonical UTC-Z millisecond timestamp');
  }

  const allowed = new Set(jobSpec.environmentPolicy.allowedCapabilityIds);
  // First matching grant in array order wins (deterministic).
  const match = jobSpec.capabilityGrants.find(
    (grant) =>
      grant.operation === operation &&
      now < grant.expiresAt &&
      allowed.has(grant.capabilityId),
  );

  if (match !== undefined) {
    return grantDecision(jobSpec.jobId, operation, match, now);
  }
  return denyDecision(jobSpec.jobId, operation, now);
}
