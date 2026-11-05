import { describe, expect, it } from 'vitest';
import { hashCanonicalJson } from '../../src/domain/canonicalJson.js';
import {
  WorkerBoundaryError,
  assertLeaseAdmissionV1,
  assertWorkerLeaseV1,
  computeEnvironmentPolicyHash,
  computeGrantHash,
  computeJobSpecHash,
  computeLeaseHash,
  computeLeasePolicyHash,
  computePayloadHash,
  type CapabilityGrantV1,
  type JobExecutionPayloadV1,
  type JobSpecEnvironmentPolicyV1,
  type JobSpecV1,
  type LeaseAdmissionV1,
  type ResultArtifactRefV1,
  type WorkerLeasePolicyV1,
  type WorkerLeaseV1,
} from '../../src/domain/workerBoundary.js';
import { admitLease } from '../../src/worker/leasePolicy.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const HASH_A =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B =
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C =
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

const T0 = '2026-08-29T00:00:00.000Z';
const T_PLUS_10S = '2026-08-29T00:00:10.000Z';
const T_PLUS_30S = '2026-08-29T00:00:30.000Z';
const T_PLUS_40S = '2026-08-29T00:00:40.000Z';
const T_PLUS_60S = '2026-08-29T00:01:00.000Z';
const T_PLUS_5M = '2026-08-29T00:05:00.000Z';

function artifactRef(
  overrides: Partial<ResultArtifactRefV1> = {},
): ResultArtifactRefV1 {
  return {
    artifactId: 'artifact-1',
    sha256: HASH_A,
    byteLength: 4,
    ...overrides,
  };
}

function capabilityGrant(
  overrides: Partial<CapabilityGrantV1> = {},
): CapabilityGrantV1 {
  const { grantHash: overrideHash, ...fields } = overrides;
  const withoutHash: Omit<CapabilityGrantV1, 'grantHash'> = {
    grantId: 'grant-1',
    capabilityId: 'cap-net',
    operation: 'fetch',
    scope: 'repo:example',
    issuedAt: T0,
    expiresAt: '2026-08-29T01:00:00.000Z',
    ...fields,
  };
  return {
    ...withoutHash,
    grantHash: overrideHash ?? computeGrantHash(withoutHash),
  };
}

function executionPayload(
  overrides: Partial<JobExecutionPayloadV1> = {},
): JobExecutionPayloadV1 {
  const { payloadHash: overrideHash, ...fields } = overrides;
  const withoutHash: Omit<JobExecutionPayloadV1, 'payloadHash'> = {
    workspaceRef: HASH_A,
    inputArtifacts: [artifactRef()],
    agentRole: 'implementer',
    commandOrSpecHash: HASH_B,
    outputSchemaRef: HASH_C,
    ...fields,
  };
  return {
    ...withoutHash,
    payloadHash: overrideHash ?? computePayloadHash(withoutHash),
  };
}

function environmentPolicy(
  overrides: Partial<JobSpecEnvironmentPolicyV1> = {},
): JobSpecEnvironmentPolicyV1 {
  const { policyHash: overrideHash, ...fields } = overrides;
  const withoutHash: Omit<JobSpecEnvironmentPolicyV1, 'policyHash'> = {
    cleanPolicy: 'clean',
    maxDurationMs: 60_000,
    maxOutputBytes: 1_048_576,
    allowedCapabilityIds: ['cap-net'],
    ...fields,
  };
  return {
    ...withoutHash,
    policyHash: overrideHash ?? computeEnvironmentPolicyHash(withoutHash),
  };
}

function leasePolicy(
  overrides: Partial<WorkerLeasePolicyV1> = {},
): WorkerLeasePolicyV1 {
  const { leasePolicyHash: overrideHash, ...fields } = overrides;
  const withoutHash: Omit<WorkerLeasePolicyV1, 'leasePolicyHash'> = {
    heartbeatIntervalMs: 5_000,
    leaseDurationMs: 30_000,
    maxLeaseLifetimeMs: 300_000,
    ...fields,
  };
  return {
    ...withoutHash,
    leasePolicyHash: overrideHash ?? computeLeasePolicyHash(withoutHash),
  };
}

function jobSpec(overrides: Partial<JobSpecV1> = {}): JobSpecV1 {
  const { jobSpecHash: overrideHash, ...fields } = overrides;
  const withoutHash: Omit<JobSpecV1, 'jobSpecHash'> = {
    schema: 'hercules-job-spec/v1',
    issuer: 'hercules-program-control',
    jobId: 'job-1',
    taskId: 'task-1',
    taskContractHash: HASH_A,
    iterationId: 'iteration-1',
    candidateCommit: COMMIT,
    stageType: 'implement',
    executionPayload: executionPayload(),
    capabilityGrants: [capabilityGrant()],
    environmentPolicy: environmentPolicy(),
    leasePolicy: leasePolicy(),
    authorityEpoch: 'epoch-1',
    issuedAt: T0,
    expiresAt: '2026-08-29T02:00:00.000Z',
    ...fields,
  };
  return {
    ...withoutHash,
    jobSpecHash: overrideHash ?? computeJobSpecHash(withoutHash),
  };
}

function workerLease(overrides: Partial<WorkerLeaseV1> = {}): WorkerLeaseV1 {
  const { leaseHash: overrideHash, ...fields } = overrides;
  const withoutHash: Omit<WorkerLeaseV1, 'leaseHash'> = {
    schema: 'hercules-worker-lease/v1',
    leaseId: HASH_B,
    jobId: 'job-1',
    jobSpecHash: HASH_A,
    workerId: 'worker-1',
    leaseEpoch: 0,
    leasedAt: T0,
    lastHeartbeatAt: T0,
    expiresAt: T_PLUS_30S,
    ...fields,
  };
  return {
    ...withoutHash,
    leaseHash: overrideHash ?? computeLeaseHash(withoutHash),
  };
}

function expectAdmitted(admission: LeaseAdmissionV1): WorkerLeaseV1 {
  expect(admission.outcome).toBe('admitted');
  expect(admission.reason).toBeNull();
  expect(admission.lease).not.toBeNull();
  assertLeaseAdmissionV1(admission);
  assertWorkerLeaseV1(admission.lease!);
  return admission.lease!;
}

function expectRefused(
  admission: LeaseAdmissionV1,
  reason: 'policy_denial' | 'lease_held',
): void {
  expect(admission.outcome).toBe('refused');
  expect(admission.lease).toBeNull();
  expect(admission.reason).toBe(reason);
  assertLeaseAdmissionV1(admission);
}

describe('admitLease', () => {
  it('admits the first lease at epoch 0 with deterministic leaseId', () => {
    const spec = jobSpec();
    const admission = admitLease(null, spec, 'worker-1', T0);
    const lease = expectAdmitted(admission);

    expect(lease.leaseEpoch).toBe(0);
    expect(lease.workerId).toBe('worker-1');
    expect(lease.jobId).toBe(spec.jobId);
    expect(lease.jobSpecHash).toBe(spec.jobSpecHash);
    expect(lease.leasedAt).toBe(T0);
    expect(lease.lastHeartbeatAt).toBe(T0);
    expect(lease.expiresAt).toBe(T_PLUS_30S);
    expect(lease.leaseId).toBe(
      hashCanonicalJson({
        jobId: spec.jobId,
        leaseEpoch: 0,
        leasedAt: T0,
      }),
    );
    expect(admission.decidedAt).toBe(T0);
    expect(admission.workerId).toBe('worker-1');
    expect(admission.jobId).toBe(spec.jobId);
  });

  it('treats now == expiresAt as expired and re-admits at epoch+1', () => {
    const spec = jobSpec();
    const current = workerLease({
      jobSpecHash: spec.jobSpecHash,
      leaseEpoch: 2,
      leasedAt: T0,
      lastHeartbeatAt: T_PLUS_10S,
      expiresAt: T_PLUS_30S,
      leaseId: hashCanonicalJson({
        jobId: 'job-1',
        leaseEpoch: 2,
        leasedAt: T0,
      }),
    });
    const admission = admitLease(current, spec, 'worker-2', T_PLUS_30S);
    const lease = expectAdmitted(admission);

    expect(lease.leaseEpoch).toBe(3);
    expect(lease.workerId).toBe('worker-2');
    expect(lease.leasedAt).toBe(T_PLUS_30S);
    expect(lease.lastHeartbeatAt).toBe(T_PLUS_30S);
    expect(lease.expiresAt).toBe(T_PLUS_60S);
    expect(lease.leaseId).toBe(
      hashCanonicalJson({
        jobId: spec.jobId,
        leaseEpoch: 3,
        leasedAt: T_PLUS_30S,
      }),
    );
    expect(lease.leaseId).not.toBe(current.leaseId);
  });

  it('refuses a different worker while the lease is live (lease_held)', () => {
    const spec = jobSpec();
    const current = workerLease({ jobSpecHash: spec.jobSpecHash });
    const admission = admitLease(current, spec, 'worker-2', T_PLUS_10S);
    expectRefused(admission, 'lease_held');
    expect(admission.workerId).toBe('worker-2');
    expect(admission.decidedAt).toBe(T_PLUS_10S);
  });

  it('renews for the same worker while live (epoch preserved, expiresAt advanced)', () => {
    const spec = jobSpec();
    const current = workerLease({
      jobSpecHash: spec.jobSpecHash,
      leaseId: hashCanonicalJson({
        jobId: 'job-1',
        leaseEpoch: 0,
        leasedAt: T0,
      }),
    });
    const admission = admitLease(current, spec, 'worker-1', T_PLUS_10S);
    const lease = expectAdmitted(admission);

    expect(lease.leaseEpoch).toBe(current.leaseEpoch);
    expect(lease.leaseId).toBe(current.leaseId);
    expect(lease.leasedAt).toBe(current.leasedAt);
    expect(lease.lastHeartbeatAt).toBe(T_PLUS_10S);
    expect(lease.expiresAt).toBe(T_PLUS_40S);
    expect(lease.expiresAt > T_PLUS_10S).toBe(true);
    expect(lease.workerId).toBe('worker-1');
  });

  it('caps renewal expiresAt at leasedAt + maxLeaseLifetimeMs and stays > now', () => {
    // leaseDurationMs=60s, maxLeaseLifetimeMs=70s; renew at leasedAt+50s
    // → min(now+60s, leasedAt+70s) = leasedAt+70s
    const spec = jobSpec({
      leasePolicy: leasePolicy({
        leaseDurationMs: 60_000,
        maxLeaseLifetimeMs: 70_000,
      }),
    });
    const leasedAt = T0;
    const now = '2026-08-29T00:00:50.000Z';
    const cap = '2026-08-29T00:01:10.000Z';
    const current = workerLease({
      jobSpecHash: spec.jobSpecHash,
      leasedAt,
      lastHeartbeatAt: leasedAt,
      expiresAt: '2026-08-29T00:01:00.000Z',
      leaseId: hashCanonicalJson({
        jobId: 'job-1',
        leaseEpoch: 0,
        leasedAt,
      }),
    });
    const admission = admitLease(current, spec, 'worker-1', now);
    const lease = expectAdmitted(admission);

    expect(lease.leaseEpoch).toBe(0);
    expect(lease.leaseId).toBe(current.leaseId);
    expect(lease.expiresAt).toBe(cap);
    expect(lease.expiresAt > now).toBe(true);
    expect(lease.expiresAt <= cap).toBe(true);
  });

  it('treats now == leasedAt + maxLeaseLifetimeMs as expired (branch 1 re-admit)', () => {
    const spec = jobSpec({
      leasePolicy: leasePolicy({
        leaseDurationMs: 30_000,
        maxLeaseLifetimeMs: 300_000,
      }),
    });
    const current = workerLease({
      jobSpecHash: spec.jobSpecHash,
      leasedAt: T0,
      lastHeartbeatAt: T_PLUS_5M,
      expiresAt: T_PLUS_5M, // capped at leasedAt + maxLeaseLifetimeMs
      leaseId: hashCanonicalJson({
        jobId: 'job-1',
        leaseEpoch: 4,
        leasedAt: T0,
      }),
      leaseEpoch: 4,
    });
    const admission = admitLease(current, spec, 'worker-1', T_PLUS_5M);
    const lease = expectAdmitted(admission);

    expect(lease.leaseEpoch).toBe(5);
    expect(lease.leasedAt).toBe(T_PLUS_5M);
    expect(lease.leaseId).toBe(
      hashCanonicalJson({
        jobId: spec.jobId,
        leaseEpoch: 5,
        leasedAt: T_PLUS_5M,
      }),
    );
    expect(lease.leaseId).not.toBe(current.leaseId);
  });

  it('refuses invalid policy (policy_denial)', () => {
    const zeroDuration = jobSpec({
      leasePolicy: leasePolicy({
        leaseDurationMs: 0,
        maxLeaseLifetimeMs: 300_000,
      }),
    });
    expectRefused(
      admitLease(null, zeroDuration, 'worker-1', T0),
      'policy_denial',
    );

    const zeroMax = jobSpec({
      leasePolicy: leasePolicy({
        leaseDurationMs: 30_000,
        maxLeaseLifetimeMs: 0,
      }),
    });
    expectRefused(admitLease(null, zeroMax, 'worker-1', T0), 'policy_denial');

    const maxBelowDuration = jobSpec({
      leasePolicy: leasePolicy({
        leaseDurationMs: 60_000,
        maxLeaseLifetimeMs: 30_000,
      }),
    });
    expectRefused(
      admitLease(null, maxBelowDuration, 'worker-1', T0),
      'policy_denial',
    );
  });

  it('is restart-deterministic: same inputs yield byte-identical LeaseAdmissionV1', () => {
    const spec = jobSpec();
    const current = workerLease({
      jobSpecHash: spec.jobSpecHash,
      leaseId: hashCanonicalJson({
        jobId: 'job-1',
        leaseEpoch: 0,
        leasedAt: T0,
      }),
    });

    const a = admitLease(current, spec, 'worker-1', T_PLUS_10S);
    const b = admitLease(current, spec, 'worker-1', T_PLUS_10S);
    expect(a).toEqual(b);
    expect(a.admissionHash).toBe(b.admissionHash);
    expect(a.lease?.leaseId).toBe(b.lease?.leaseId);

    const first = admitLease(null, spec, 'worker-1', T0);
    const second = admitLease(null, spec, 'worker-1', T0);
    expect(first).toEqual(second);
    expect(first.admissionHash).toBe(second.admissionHash);
    expect(first.lease?.leaseId).toBe(second.lease?.leaseId);
  });

  it('derives distinct leaseIds across epochs matching digest{jobId,leaseEpoch,leasedAt}', () => {
    const spec = jobSpec();
    const epoch0 = expectAdmitted(admitLease(null, spec, 'worker-1', T0));
    const epoch1 = expectAdmitted(
      admitLease(epoch0, spec, 'worker-1', epoch0.expiresAt),
    );

    expect(epoch0.leaseEpoch).toBe(0);
    expect(epoch1.leaseEpoch).toBe(1);
    expect(epoch0.leaseId).not.toBe(epoch1.leaseId);
    expect(epoch0.leaseId).toBe(
      hashCanonicalJson({
        jobId: 'job-1',
        leaseEpoch: 0,
        leasedAt: T0,
      }),
    );
    expect(epoch1.leaseId).toBe(
      hashCanonicalJson({
        jobId: 'job-1',
        leaseEpoch: 1,
        leasedAt: epoch0.expiresAt,
      }),
    );
  });

  it('throws invalid_input_schema on malformed control inputs', () => {
    const spec = jobSpec();

    expect(() => admitLease(null, spec, '', T0)).toThrow(WorkerBoundaryError);
    expect(() => admitLease(null, spec, 'bad/id', T0)).toThrow(
      WorkerBoundaryError,
    );
    expect(() => admitLease(null, spec, 'worker-1', 'not-a-timestamp')).toThrow(
      WorkerBoundaryError,
    );
    expect(() =>
      admitLease(null, { ...spec, jobId: '' } as JobSpecV1, 'worker-1', T0),
    ).toThrow(WorkerBoundaryError);

    try {
      admitLease(null, spec, '', T0);
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerBoundaryError);
      expect((error as WorkerBoundaryError).code).toBe('invalid_input_schema');
    }
  });

  it('throws invalid_input_schema when now precedes current lastHeartbeatAt', () => {
    const spec = jobSpec();
    const current = workerLease({
      jobSpecHash: spec.jobSpecHash,
      workerId: 'worker-1',
      leasedAt: T0,
      lastHeartbeatAt: T_PLUS_10S,
      expiresAt: T_PLUS_30S,
      leaseId: hashCanonicalJson({
        jobId: 'job-1',
        leaseEpoch: 0,
        leasedAt: T0,
      }),
    });
    // Live same-worker renewal with a time-reversed clock.
    expect(() => admitLease(current, spec, 'worker-1', T0)).toThrow(
      WorkerBoundaryError,
    );
    try {
      admitLease(current, spec, 'worker-1', T0);
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerBoundaryError);
      expect((error as WorkerBoundaryError).code).toBe('invalid_input_schema');
    }
  });

  it('re-admits an expired lease held by the prior worker at a new epoch', () => {
    const spec = jobSpec();
    const current = workerLease({
      jobSpecHash: spec.jobSpecHash,
      workerId: 'worker-1',
      leaseEpoch: 7,
      expiresAt: T_PLUS_30S,
      leaseId: hashCanonicalJson({
        jobId: 'job-1',
        leaseEpoch: 7,
        leasedAt: T0,
      }),
    });
    const admission = admitLease(current, spec, 'worker-1', T_PLUS_60S);
    const lease = expectAdmitted(admission);
    expect(lease.leaseEpoch).toBe(8);
    expect(lease.workerId).toBe('worker-1');
    expect(lease.leasedAt).toBe(T_PLUS_60S);
  });

  it('refuses (policy_denial) instead of overflowing on an absurd but non-negative duration', () => {
    // A lease policy whose durations exceed the domain cap must never reach the
    // overflow-prone arithmetic; assertWorkerLeasePolicyV1 rejects the JobSpec
    // at the precondition, so admitLease throws invalid_input_schema — never a
    // raw RangeError.
    const overflowSpec = () =>
      jobSpec({
        leasePolicy: leasePolicy({
          leaseDurationMs: Number.MAX_SAFE_INTEGER,
          maxLeaseLifetimeMs: Number.MAX_SAFE_INTEGER,
        }),
      });
    expect(() => admitLease(null, overflowSpec(), 'worker-1', T0)).toThrow(
      WorkerBoundaryError,
    );
    try {
      admitLease(null, overflowSpec(), 'worker-1', T0);
    } catch (error) {
      expect((error as WorkerBoundaryError).code).toBe('invalid_input_schema');
    }
  });

  it('refuses (policy_denial) rather than throwing RangeError when now sits at the RFC-3339 ceiling', () => {
    // A well-formed policy (within the cap) but a `now` so near year 9999 that
    // now + duration is unrepresentable → a closed policy_denial, never a raw
    // overflow.
    const spec = jobSpec();
    const nearCeiling = '9999-12-31T23:59:59.999Z';
    const admission = admitLease(null, spec, 'worker-1', nearCeiling);
    expectRefused(admission, 'policy_denial');
  });

  it('rejects a current lease whose lastHeartbeatAt precedes leasedAt (malformed)', () => {
    const spec = jobSpec();
    // lastHeartbeatAt < leasedAt is structurally impossible; the domain
    // validator rejects it, so admitLease throws invalid_input_schema at the
    // precondition rather than deriving a degenerate renewal expiresAt.
    const malformed = () =>
      workerLease({
        jobSpecHash: spec.jobSpecHash,
        leasedAt: T_PLUS_30S,
        lastHeartbeatAt: T0, // before creation — invalid
        expiresAt: T_PLUS_60S,
      });
    expect(() => admitLease(malformed(), spec, 'worker-1', T_PLUS_40S)).toThrow(
      WorkerBoundaryError,
    );
    try {
      admitLease(malformed(), spec, 'worker-1', T_PLUS_40S);
    } catch (error) {
      expect((error as WorkerBoundaryError).code).toBe('invalid_input_schema');
    }
  });
});
