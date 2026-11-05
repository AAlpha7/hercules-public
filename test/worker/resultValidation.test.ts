import { describe, expect, it } from 'vitest';
import {
  RESULT_ADMISSION_REASONS,
  WorkerBoundaryError,
  assertResultAdmissionV1,
  computeEnvironmentPolicyHash,
  computeGrantHash,
  computeJobSpecHash,
  computeLeaseHash,
  computeLeasePolicyHash,
  computePayloadHash,
  computeResultAdmissionHash,
  computeResultHash,
  type CapabilityGrantV1,
  type JobExecutionPayloadV1,
  type JobSpecEnvironmentPolicyV1,
  type JobSpecV1,
  type ResultAdmissionReasonV1,
  type ResultAdmissionV1,
  type ResultArtifactRefV1,
  type ResultPackageV1,
  type WorkerLeasePolicyV1,
  type WorkerLeaseV1,
} from '../../src/domain/workerBoundary.js';
import {
  type DedupLedgerEntryV1,
  validateResult,
} from '../../src/worker/resultValidation.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const HASH_A =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B =
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C =
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const HASH_D =
  'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';

const T0 = '2026-08-29T00:00:00.000Z';
const T_PLUS_1S = '2026-08-29T00:00:01.000Z';
const T_PLUS_5S = '2026-08-29T00:00:05.000Z';
const T_PLUS_6S = '2026-08-29T00:00:06.000Z';
const T_PLUS_10S = '2026-08-29T00:00:10.000Z';
const T_PLUS_30S = '2026-08-29T00:00:30.000Z';

function expectSchemaError(run: () => void): void {
  expect(run).toThrow(WorkerBoundaryError);
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkerBoundaryError);
    expect((error as WorkerBoundaryError).code).toBe('invalid_input_schema');
  }
}

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

function workerLease(
  spec: JobSpecV1,
  overrides: Partial<WorkerLeaseV1> = {},
): WorkerLeaseV1 {
  const { leaseHash: overrideHash, ...fields } = overrides;
  const withoutHash: Omit<WorkerLeaseV1, 'leaseHash'> = {
    schema: 'hercules-worker-lease/v1',
    leaseId: HASH_B,
    jobId: spec.jobId,
    jobSpecHash: spec.jobSpecHash,
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

function resultPackage(
  spec: JobSpecV1,
  lease: WorkerLeaseV1,
  overrides: Partial<ResultPackageV1> = {},
): ResultPackageV1 {
  const { resultHash: overrideHash, ...fields } = overrides;
  const artifacts = fields.artifacts ?? [artifactRef()];
  const {
    artifacts: _artifacts,
    totalOutputBytes: totalOverride,
    ...restFields
  } = fields;
  const withoutHash: Omit<ResultPackageV1, 'resultHash'> = {
    schema: 'hercules-result-package/v1',
    resultId: 'result-1',
    jobId: spec.jobId,
    jobSpecHash: spec.jobSpecHash,
    leaseId: lease.leaseId,
    leaseEpoch: lease.leaseEpoch,
    workerId: lease.workerId,
    completionStatus: 'completed',
    exitCode: 0,
    startedAt: T_PLUS_1S,
    completedAt: T_PLUS_5S,
    ...restFields,
    artifacts,
    totalOutputBytes:
      totalOverride ??
      artifacts.reduce((sum, artifact) => sum + artifact.byteLength, 0),
  };
  return {
    ...withoutHash,
    resultHash: overrideHash ?? computeResultHash(withoutHash),
  };
}

function ledgerEntry(admission: ResultAdmissionV1): DedupLedgerEntryV1 {
  expect(admission.outcome).toBe('admitted');
  return {
    resultId: admission.resultId,
    resultHash: admission.resultHash,
    admission,
  };
}

function expectAdmitted(admission: ResultAdmissionV1): void {
  expect(admission.outcome).toBe('admitted');
  expect(admission.reason).toBeNull();
  assertResultAdmissionV1(admission);
}

function expectRejected(
  admission: ResultAdmissionV1,
  reason: ResultAdmissionReasonV1,
): void {
  expect(admission.outcome).toBe('rejected');
  expect(admission.reason).toBe(reason);
  assertResultAdmissionV1(admission);
}

describe('validateResult', () => {
  it('admits a well-bound live result (happy path)', () => {
    const spec = jobSpec();
    const lease = workerLease(spec);
    const result = resultPackage(spec, lease);
    const admission = validateResult(result, spec, lease, [], T_PLUS_6S);

    expectAdmitted(admission);
    expect(admission.jobId).toBe(result.jobId);
    expect(admission.resultId).toBe(result.resultId);
    expect(admission.resultHash).toBe(result.resultHash);
    expect(admission.leaseEpoch).toBe(result.leaseEpoch);
    expect(admission.admittedAt).toBe(T_PLUS_6S);
    expect(admission.admissionHash).toBe(
      computeResultAdmissionHash({
        schema: 'hercules-result-admission/v1',
        outcome: 'admitted',
        jobId: result.jobId,
        resultId: result.resultId,
        resultHash: result.resultHash,
        leaseEpoch: result.leaseEpoch,
        reason: null,
        admittedAt: T_PLUS_6S,
      }),
    );
  });

  it('replay returns byte-identical stored admission (including after epoch advance)', () => {
    const spec = jobSpec();
    const lease = workerLease(spec);
    const result = resultPackage(spec, lease);
    const original = validateResult(result, spec, lease, [], T_PLUS_6S);
    expectAdmitted(original);

    const ledger = [ledgerEntry(original)];

    // Same lease epoch — replay
    const replay = validateResult(result, spec, lease, ledger, T_PLUS_10S);
    expect(replay).toBe(original);
    expect(replay).toEqual(original);

    // Simulated epoch advance: newer admitting lease, original still in ledger
    const newerLease = workerLease(spec, {
      leaseEpoch: 1,
      leaseId: HASH_D,
      leasedAt: T_PLUS_10S,
      lastHeartbeatAt: T_PLUS_10S,
      expiresAt: '2026-08-29T00:00:40.000Z',
    });
    const replayAfterEpoch = validateResult(
      result,
      spec,
      newerLease,
      ledger,
      T_PLUS_10S,
    );
    expect(replayAfterEpoch).toBe(original);
    expect(replayAfterEpoch).toEqual(original);
    expect(replayAfterEpoch.leaseEpoch).toBe(0);
  });

  it('rejects idempotency_conflict for same resultId with different resultHash', () => {
    const spec = jobSpec();
    const lease = workerLease(spec);
    const result = resultPackage(spec, lease);
    const original = validateResult(result, spec, lease, [], T_PLUS_6S);
    const ledger = [ledgerEntry(original)];

    const conflicting = resultPackage(spec, lease, {
      exitCode: 1,
      completionStatus: 'failed',
    });
    expect(conflicting.resultId).toBe(result.resultId);
    expect(conflicting.resultHash).not.toBe(result.resultHash);

    const admission = validateResult(
      conflicting,
      spec,
      lease,
      ledger,
      T_PLUS_10S,
    );
    expectRejected(admission, 'idempotency_conflict');
  });

  it('rejects duplicate_result when a different resultId is already admitted', () => {
    const spec = jobSpec();
    const lease = workerLease(spec);
    const first = resultPackage(spec, lease, { resultId: 'result-1' });
    const original = validateResult(first, spec, lease, [], T_PLUS_6S);
    const ledger = [ledgerEntry(original)];

    const second = resultPackage(spec, lease, { resultId: 'result-2' });
    const admission = validateResult(second, spec, lease, ledger, T_PLUS_10S);
    expectRejected(admission, 'duplicate_result');
  });

  it('rejects binding_mismatch on jobId mismatch', () => {
    const spec = jobSpec();
    const lease = workerLease(spec);
    const result = resultPackage(spec, lease, { jobId: 'job-other' });
    const admission = validateResult(result, spec, lease, [], T_PLUS_6S);
    expectRejected(admission, 'binding_mismatch');
  });

  it('rejects binding_mismatch on jobSpecHash mismatch', () => {
    const spec = jobSpec();
    const lease = workerLease(spec);
    const result = resultPackage(spec, lease, { jobSpecHash: HASH_D });
    const admission = validateResult(result, spec, lease, [], T_PLUS_6S);
    expectRejected(admission, 'binding_mismatch');
  });

  it('rejects binding_mismatch on workerId mismatch', () => {
    const spec = jobSpec();
    const lease = workerLease(spec);
    const result = resultPackage(spec, lease, { workerId: 'worker-other' });
    const admission = validateResult(result, spec, lease, [], T_PLUS_6S);
    expectRejected(admission, 'binding_mismatch');
  });

  it('rejects stale_lease for earlier epoch of the same worker', () => {
    const spec = jobSpec();
    const current = workerLease(spec, { leaseEpoch: 2, leaseId: HASH_D });
    const result = resultPackage(spec, current, {
      leaseEpoch: 1,
      leaseId: HASH_B,
    });
    const admission = validateResult(result, spec, current, [], T_PLUS_6S);
    expectRejected(admission, 'stale_lease');
  });

  it('rejects binding_mismatch for same-epoch leaseId mismatch', () => {
    const spec = jobSpec();
    const lease = workerLease(spec, { leaseId: HASH_B });
    const result = resultPackage(spec, lease, { leaseId: HASH_D });
    const admission = validateResult(result, spec, lease, [], T_PLUS_6S);
    expectRejected(admission, 'binding_mismatch');
  });

  it('rejects binding_mismatch for future lease epoch', () => {
    const spec = jobSpec();
    const lease = workerLease(spec, { leaseEpoch: 0 });
    const result = resultPackage(spec, lease, {
      leaseEpoch: 1,
      leaseId: HASH_D,
    });
    const admission = validateResult(result, spec, lease, [], T_PLUS_6S);
    expectRejected(admission, 'binding_mismatch');
  });

  it('rejects lease_expired when now == expiresAt and when now > expiresAt', () => {
    const spec = jobSpec();
    const lease = workerLease(spec, { expiresAt: T_PLUS_30S });
    const result = resultPackage(spec, lease);

    const atExpiry = validateResult(result, spec, lease, [], T_PLUS_30S);
    expectRejected(atExpiry, 'lease_expired');

    const afterExpiry = validateResult(
      result,
      spec,
      lease,
      [],
      '2026-08-29T00:00:31.000Z',
    );
    expectRejected(afterExpiry, 'lease_expired');
  });

  it('rejects output_exceeded when totalOutputBytes > maxOutputBytes', () => {
    const spec = jobSpec({
      environmentPolicy: environmentPolicy({ maxOutputBytes: 2 }),
    });
    const lease = workerLease(spec);
    const result = resultPackage(spec, lease, {
      artifacts: [artifactRef({ byteLength: 4 })],
    });
    expect(result.totalOutputBytes).toBe(4);
    const admission = validateResult(result, spec, lease, [], T_PLUS_6S);
    expectRejected(admission, 'output_exceeded');
  });

  it('rejects duration_exceeded when elapsed > maxDurationMs', () => {
    const spec = jobSpec({
      environmentPolicy: environmentPolicy({ maxDurationMs: 3_000 }),
    });
    const lease = workerLease(spec);
    const result = resultPackage(spec, lease, {
      startedAt: T_PLUS_1S,
      completedAt: T_PLUS_5S,
    });
    const admission = validateResult(result, spec, lease, [], T_PLUS_6S);
    expectRejected(admission, 'duration_exceeded');
  });

  it('prefers output_exceeded over duration_exceeded when both violate', () => {
    const spec = jobSpec({
      environmentPolicy: environmentPolicy({
        maxOutputBytes: 2,
        maxDurationMs: 3_000,
      }),
    });
    const lease = workerLease(spec);
    const result = resultPackage(spec, lease, {
      artifacts: [artifactRef({ byteLength: 4 })],
      startedAt: T_PLUS_1S,
      completedAt: T_PLUS_5S,
    });
    const admission = validateResult(result, spec, lease, [], T_PLUS_6S);
    expectRejected(admission, 'output_exceeded');
  });

  it('throws invalid_input_schema on malformed inputs and lease/job consistency', () => {
    const spec = jobSpec();
    const lease = workerLease(spec);
    const result = resultPackage(spec, lease);

    expectSchemaError(() =>
      validateResult(
        { ...result, resultId: '' } as ResultPackageV1,
        spec,
        lease,
        [],
        T_PLUS_6S,
      ),
    );
    expectSchemaError(() =>
      validateResult(result, { ...spec, jobId: '' } as JobSpecV1, lease, [], T_PLUS_6S),
    );
    expectSchemaError(() =>
      validateResult(
        result,
        spec,
        { ...lease, workerId: '' } as WorkerLeaseV1,
        [],
        T_PLUS_6S,
      ),
    );
    expectSchemaError(() =>
      validateResult(result, spec, lease, [], '2026-08-29T00:00:06Z'),
    );
    expectSchemaError(() =>
      validateResult(result, spec, lease, [{ not: 'valid' } as unknown as DedupLedgerEntryV1], T_PLUS_6S),
    );

    const mismatchedJob = workerLease(spec, { jobId: 'job-other' });
    expectSchemaError(() =>
      validateResult(result, spec, mismatchedJob, [], T_PLUS_6S),
    );

    const mismatchedHash = workerLease(spec, { jobSpecHash: HASH_D });
    expectSchemaError(() =>
      validateResult(result, spec, mismatchedHash, [], T_PLUS_6S),
    );
  });

  it('produced rejection reasons are a subset of RESULT_ADMISSION_REASONS', () => {
    const produced = new Set<ResultAdmissionReasonV1>();
    const spec = jobSpec();
    const lease = workerLease(spec);

    const collect = (admission: ResultAdmissionV1): void => {
      if (admission.reason !== null) {
        produced.add(admission.reason);
      }
    };

    collect(
      validateResult(
        resultPackage(spec, lease, { jobId: 'job-x' }),
        spec,
        lease,
        [],
        T_PLUS_6S,
      ),
    );
    collect(
      validateResult(
        resultPackage(spec, lease, { leaseEpoch: 0, leaseId: HASH_D }),
        spec,
        lease,
        [],
        T_PLUS_6S,
      ),
    );
    collect(
      validateResult(
        resultPackage(spec, workerLease(spec, { leaseEpoch: 2 }), {
          leaseEpoch: 1,
          leaseId: HASH_B,
        }),
        spec,
        workerLease(spec, { leaseEpoch: 2, leaseId: HASH_D }),
        [],
        T_PLUS_6S,
      ),
    );
    collect(
      validateResult(
        resultPackage(spec, lease),
        spec,
        lease,
        [],
        T_PLUS_30S,
      ),
    );

    const tight = jobSpec({
      environmentPolicy: environmentPolicy({
        maxOutputBytes: 2,
        maxDurationMs: 3_000,
      }),
    });
    const tightLease = workerLease(tight);
    collect(
      validateResult(
        resultPackage(tight, tightLease, {
          artifacts: [artifactRef({ byteLength: 4 })],
        }),
        tight,
        tightLease,
        [],
        T_PLUS_6S,
      ),
    );
    collect(
      validateResult(
        resultPackage(tight, tightLease, {
          artifacts: [artifactRef({ byteLength: 1 })],
          startedAt: T_PLUS_1S,
          completedAt: T_PLUS_5S,
        }),
        tight,
        tightLease,
        [],
        T_PLUS_6S,
      ),
    );

    const first = resultPackage(spec, lease, { resultId: 'result-1' });
    const admitted = validateResult(first, spec, lease, [], T_PLUS_6S);
    const ledger = [ledgerEntry(admitted)];
    collect(
      validateResult(
        resultPackage(spec, lease, {
          resultId: 'result-1',
          exitCode: 2,
        }),
        spec,
        lease,
        ledger,
        T_PLUS_10S,
      ),
    );
    collect(
      validateResult(
        resultPackage(spec, lease, { resultId: 'result-2' }),
        spec,
        lease,
        ledger,
        T_PLUS_10S,
      ),
    );

    for (const reason of produced) {
      expect(RESULT_ADMISSION_REASONS).toContain(reason);
    }
    expect(produced.has('idempotency_conflict')).toBe(true);
    expect(produced.has('duplicate_result')).toBe(true);
    expect(produced.has('binding_mismatch')).toBe(true);
    expect(produced.has('stale_lease')).toBe(true);
    expect(produced.has('lease_expired')).toBe(true);
    expect(produced.has('output_exceeded')).toBe(true);
    expect(produced.has('duration_exceeded')).toBe(true);
  });

  it('restart determinism: same inputs yield byte-identical admission', () => {
    const spec = jobSpec();
    const lease = workerLease(spec);
    const result = resultPackage(spec, lease);
    const a = validateResult(result, spec, lease, [], T_PLUS_6S);
    const b = validateResult(result, spec, lease, [], T_PLUS_6S);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('does not mutate the ledger on admit', () => {
    const spec = jobSpec();
    const lease = workerLease(spec);
    const result = resultPackage(spec, lease);
    const ledger: DedupLedgerEntryV1[] = [];
    const admission = validateResult(result, spec, lease, ledger, T_PLUS_6S);
    expectAdmitted(admission);
    expect(ledger).toEqual([]);
  });
});
