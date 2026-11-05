import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_BROKER_DECISION_KEYS,
  CAPABILITY_BROKER_OUTCOMES,
  CAPABILITY_BROKER_REASONS,
  CAPABILITY_GRANT_KEYS,
  LEASE_ADMISSION_REASONS,
  RESULT_ADMISSION_KEYS,
  RESULT_ADMISSION_REASONS,
  WorkerBoundaryError,
  assertCapabilityBrokerDecisionV1,
  assertCapabilityGrantV1,
  assertJobExecutionPayloadV1,
  assertJobSpecEnvironmentPolicyV1,
  assertJobSpecV1,
  assertLeaseAdmissionV1,
  assertResultAdmissionV1,
  assertResultArtifactRefV1,
  assertResultPackageV1,
  assertWorkerLeasePolicyV1,
  assertWorkerLeaseV1,
  computeBrokerDecisionHash,
  computeEnvironmentPolicyHash,
  computeGrantHash,
  computeJobSpecHash,
  computeLeaseAdmissionHash,
  computeLeaseHash,
  computeLeasePolicyHash,
  computePayloadHash,
  computeResultAdmissionHash,
  computeResultHash,
  type CapabilityBrokerDecisionV1,
  type CapabilityGrantV1,
  type JobExecutionPayloadV1,
  type JobSpecEnvironmentPolicyV1,
  type JobSpecV1,
  type LeaseAdmissionV1,
  type ResultAdmissionV1,
  type ResultArtifactRefV1,
  type ResultPackageV1,
  type WorkerLeasePolicyV1,
  type WorkerLeaseV1,
} from '../../src/domain/workerBoundary.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const HASH_A =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B =
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C =
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const HASH_ZERO =
  'sha256:0000000000000000000000000000000000000000000000000000000000000000';
const LEASE_ID = HASH_B;

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
    issuedAt: '2026-08-29T00:00:00.000Z',
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
    issuedAt: '2026-08-29T00:00:00.000Z',
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
    leaseId: LEASE_ID,
    jobId: 'job-1',
    jobSpecHash: HASH_A,
    workerId: 'worker-1',
    leaseEpoch: 0,
    leasedAt: '2026-08-29T00:00:00.000Z',
    lastHeartbeatAt: '2026-08-29T00:00:00.000Z',
    expiresAt: '2026-08-29T00:00:30.000Z',
    ...fields,
  };
  return {
    ...withoutHash,
    leaseHash: overrideHash ?? computeLeaseHash(withoutHash),
  };
}

function resultPackage(
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
    jobId: 'job-1',
    jobSpecHash: HASH_A,
    leaseId: LEASE_ID,
    leaseEpoch: 0,
    workerId: 'worker-1',
    completionStatus: 'completed',
    exitCode: 0,
    startedAt: '2026-08-29T00:00:01.000Z',
    completedAt: '2026-08-29T00:00:05.000Z',
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

function resultAdmission(
  overrides: Partial<ResultAdmissionV1> = {},
): ResultAdmissionV1 {
  const { admissionHash: overrideHash, ...fields } = overrides;
  const outcome = fields.outcome ?? 'admitted';
  const {
    outcome: _outcome,
    reason: reasonOverride,
    ...restFields
  } = fields;
  const withoutHash: Omit<ResultAdmissionV1, 'admissionHash'> = {
    schema: 'hercules-result-admission/v1',
    jobId: 'job-1',
    resultId: 'result-1',
    resultHash: HASH_A,
    leaseEpoch: 0,
    admittedAt: '2026-08-29T00:00:06.000Z',
    ...restFields,
    outcome,
    reason:
      reasonOverride === undefined
        ? outcome === 'rejected'
          ? 'duplicate_result'
          : null
        : reasonOverride,
  };
  return {
    ...withoutHash,
    admissionHash: overrideHash ?? computeResultAdmissionHash(withoutHash),
  };
}

function leaseAdmission(
  overrides: Partial<LeaseAdmissionV1> = {},
): LeaseAdmissionV1 {
  const { admissionHash: overrideHash, ...fields } = overrides;
  const outcome = fields.outcome ?? 'admitted';
  const {
    outcome: _outcome,
    lease: leaseOverride,
    reason: reasonOverride,
    ...restFields
  } = fields;
  const withoutHash: Omit<LeaseAdmissionV1, 'admissionHash'> = {
    schema: 'hercules-lease-admission/v1',
    jobId: 'job-1',
    workerId: 'worker-1',
    decidedAt: '2026-08-29T00:00:00.000Z',
    ...restFields,
    outcome,
    lease:
      leaseOverride === undefined
        ? outcome === 'admitted'
          ? workerLease()
          : null
        : leaseOverride,
    reason:
      reasonOverride === undefined
        ? outcome === 'refused'
          ? 'lease_held'
          : null
        : reasonOverride,
  };
  return {
    ...withoutHash,
    admissionHash: overrideHash ?? computeLeaseAdmissionHash(withoutHash),
  };
}

function brokerDecision(
  overrides: Partial<CapabilityBrokerDecisionV1> = {},
): CapabilityBrokerDecisionV1 {
  const { decisionHash: overrideHash, ...fields } = overrides;
  const outcome = fields.outcome ?? 'granted';
  const {
    outcome: _outcome,
    grant: grantOverride,
    reason: reasonOverride,
    ...restFields
  } = fields;
  const withoutHash: Omit<CapabilityBrokerDecisionV1, 'decisionHash'> = {
    schema: 'hercules-capability-broker-decision/v1',
    jobId: 'job-1',
    operation: 'fetch',
    decidedAt: '2026-08-29T00:00:00.000Z',
    ...restFields,
    outcome,
    grant:
      grantOverride === undefined
        ? outcome === 'granted'
          ? capabilityGrant()
          : null
        : grantOverride,
    reason:
      reasonOverride === undefined
        ? outcome === 'denied'
          ? 'capability_denied'
          : null
        : reasonOverride,
  };
  return {
    ...withoutHash,
    decisionHash: overrideHash ?? computeBrokerDecisionHash(withoutHash),
  };
}

describe('M10 worker-boundary domain records', () => {
  it('accepts happy-path fixtures for every record with matching hashes', () => {
    const grant = capabilityGrant();
    const payload = executionPayload();
    const env = environmentPolicy();
    const leasePol = leasePolicy();
    const spec = jobSpec();
    const lease = workerLease();
    const pkg = resultPackage();
    const resultAdmitted = resultAdmission();
    const resultRejected = resultAdmission({
      outcome: 'rejected',
      reason: 'lease_expired',
    });
    const leaseAdmitted = leaseAdmission();
    const leaseRefused = leaseAdmission({
      outcome: 'refused',
      lease: null,
      reason: 'policy_denial',
    });
    const brokerGranted = brokerDecision();
    const brokerDenied = brokerDecision({
      outcome: 'denied',
      grant: null,
      reason: 'capability_denied',
    });
    const ref = artifactRef();

    expect(() => assertResultArtifactRefV1(ref)).not.toThrow();
    expect(() => assertCapabilityGrantV1(grant)).not.toThrow();
    expect(() => assertJobExecutionPayloadV1(payload)).not.toThrow();
    expect(() => assertJobSpecEnvironmentPolicyV1(env)).not.toThrow();
    expect(() => assertWorkerLeasePolicyV1(leasePol)).not.toThrow();
    expect(() => assertJobSpecV1(spec)).not.toThrow();
    expect(() => assertWorkerLeaseV1(lease)).not.toThrow();
    expect(() => assertResultPackageV1(pkg)).not.toThrow();
    expect(() => assertResultAdmissionV1(resultAdmitted)).not.toThrow();
    expect(() => assertResultAdmissionV1(resultRejected)).not.toThrow();
    expect(() => assertLeaseAdmissionV1(leaseAdmitted)).not.toThrow();
    expect(() => assertLeaseAdmissionV1(leaseRefused)).not.toThrow();
    expect(() => assertCapabilityBrokerDecisionV1(brokerGranted)).not.toThrow();
    expect(() => assertCapabilityBrokerDecisionV1(brokerDenied)).not.toThrow();
  });

  it('omit-own-hash helpers are deterministic and sensitive to field mutation', () => {
    const grantA = capabilityGrant();
    const grantB = capabilityGrant();
    expect(grantA.grantHash).toBe(grantB.grantHash);
    const { grantHash: _g, ...grantBody } = grantA;
    expect(computeGrantHash(grantBody)).toBe(grantA.grantHash);
    expect(
      computeGrantHash({ ...grantBody, operation: 'other' }),
    ).not.toBe(grantA.grantHash);

    const payloadA = executionPayload();
    const { payloadHash: _p, ...payloadBody } = payloadA;
    expect(computePayloadHash(payloadBody)).toBe(payloadA.payloadHash);

    const envA = environmentPolicy();
    const { policyHash: _e, ...envBody } = envA;
    expect(computeEnvironmentPolicyHash(envBody)).toBe(envA.policyHash);

    const leasePolA = leasePolicy();
    const { leasePolicyHash: _lp, ...leasePolBody } = leasePolA;
    expect(computeLeasePolicyHash(leasePolBody)).toBe(leasePolA.leasePolicyHash);

    const specA = jobSpec();
    const specB = jobSpec();
    expect(specA.jobSpecHash).toBe(specB.jobSpecHash);
    const { jobSpecHash: _j, ...specBody } = specA;
    expect(computeJobSpecHash(specBody)).toBe(specA.jobSpecHash);
    expect(
      computeJobSpecHash({ ...specBody, taskId: 'task-2' }),
    ).not.toBe(specA.jobSpecHash);

    const leaseA = workerLease();
    const { leaseHash: _l, ...leaseBody } = leaseA;
    expect(computeLeaseHash(leaseBody)).toBe(leaseA.leaseHash);

    const pkgA = resultPackage();
    const { resultHash: _r, ...pkgBody } = pkgA;
    expect(computeResultHash(pkgBody)).toBe(pkgA.resultHash);
    expect(
      computeResultHash({ ...pkgBody, workerId: 'worker-2' }),
    ).not.toBe(pkgA.resultHash);

    const admissionA = resultAdmission();
    const { admissionHash: _ra, ...admissionBody } = admissionA;
    expect(computeResultAdmissionHash(admissionBody)).toBe(
      admissionA.admissionHash,
    );

    const leaseAdmissionA = leaseAdmission();
    const { admissionHash: _la, ...leaseAdmissionBody } = leaseAdmissionA;
    expect(computeLeaseAdmissionHash(leaseAdmissionBody)).toBe(
      leaseAdmissionA.admissionHash,
    );

    const brokerA = brokerDecision();
    const { decisionHash: _bd, ...brokerBody } = brokerA;
    expect(computeBrokerDecisionHash(brokerBody)).toBe(brokerA.decisionHash);
    expect(
      computeBrokerDecisionHash({ ...brokerBody, operation: 'other' }),
    ).not.toBe(brokerA.decisionHash);
  });

  it('CapabilityGrantV1 key set has no secret-bearing field and rejects extras', () => {
    expect([...CAPABILITY_GRANT_KEYS].sort()).toEqual(
      [
        'capabilityId',
        'expiresAt',
        'grantHash',
        'grantId',
        'issuedAt',
        'operation',
        'scope',
      ].sort(),
    );
    expect(CAPABILITY_GRANT_KEYS).not.toContain('secret');
    expect(CAPABILITY_GRANT_KEYS).not.toContain('token');
    expect(CAPABILITY_GRANT_KEYS).not.toContain('password');
    expectSchemaError(() =>
      assertCapabilityGrantV1({
        ...capabilityGrant(),
        secret: 'smuggled',
      } as unknown as CapabilityGrantV1),
    );
  });

  it('ResultAdmissionV1 key-set equality proves no decision field can be present', () => {
    expect([...RESULT_ADMISSION_KEYS].sort()).toEqual(
      [
        'admissionHash',
        'admittedAt',
        'jobId',
        'leaseEpoch',
        'outcome',
        'reason',
        'resultHash',
        'resultId',
        'schema',
      ].sort(),
    );
    for (const forbidden of [
      'taskState',
      'verdict',
      'eligibility',
      'recommendedNextStage',
      'route',
      'approval',
      'merge',
    ]) {
      expect(RESULT_ADMISSION_KEYS).not.toContain(forbidden);
      expectSchemaError(() =>
        assertResultAdmissionV1({
          ...resultAdmission(),
          [forbidden]: 'x',
        } as unknown as ResultAdmissionV1),
      );
    }
  });

  it('frozen reason unions are the single source of truth for later slices', () => {
    expect([...RESULT_ADMISSION_REASONS]).toEqual([
      'invalid_input_schema',
      'idempotency_conflict',
      'duplicate_result',
      'binding_mismatch',
      'stale_lease',
      'lease_expired',
      'output_exceeded',
      'duration_exceeded',
    ]);
    expect(RESULT_ADMISSION_REASONS).not.toContain('policy_denial');
    expect([...LEASE_ADMISSION_REASONS]).toEqual([
      'policy_denial',
      'lease_held',
    ]);
    expect(LEASE_ADMISSION_REASONS).not.toContain('lease_expired');
    expect([...CAPABILITY_BROKER_REASONS]).toEqual(['capability_denied']);
    expect([...CAPABILITY_BROKER_OUTCOMES]).toEqual(['granted', 'denied']);
  });

  it('rejects a worker lease policy interval above the domain cap', () => {
    expectSchemaError(() =>
      assertWorkerLeasePolicyV1(
        leasePolicy({ leaseDurationMs: Number.MAX_SAFE_INTEGER }),
      ),
    );
    expectSchemaError(() =>
      assertWorkerLeasePolicyV1(
        leasePolicy({ maxLeaseLifetimeMs: Number.MAX_SAFE_INTEGER }),
      ),
    );
  });

  it('rejects a worker lease violating leasedAt <= lastHeartbeatAt <= expiresAt', () => {
    // heartbeat before creation
    expectSchemaError(() =>
      assertWorkerLeaseV1(
        workerLease({
          leasedAt: '2026-08-29T00:00:10.000Z',
          lastHeartbeatAt: '2026-08-29T00:00:00.000Z',
          expiresAt: '2026-08-29T00:00:30.000Z',
        }),
      ),
    );
    // expiry before last heartbeat
    expectSchemaError(() =>
      assertWorkerLeaseV1(
        workerLease({
          leasedAt: '2026-08-29T00:00:00.000Z',
          lastHeartbeatAt: '2026-08-29T00:00:30.000Z',
          expiresAt: '2026-08-29T00:00:10.000Z',
        }),
      ),
    );
  });

  it('rejects an extended-year timestamp that would break the string-order invariant', () => {
    // Date#toISOString emits +0YYYYY for year > 9999; the strict validator
    // rejects it so lexical order stays chronological.
    expectSchemaError(() =>
      assertWorkerLeaseV1(
        workerLease({ leasedAt: '+010000-01-01T00:00:00.000Z' }),
      ),
    );
  });

  it('CapabilityBrokerDecisionV1 happy-path granted and denied, closed keys, cross-field', () => {
    expect([...CAPABILITY_BROKER_DECISION_KEYS].sort()).toEqual(
      [
        'decidedAt',
        'decisionHash',
        'grant',
        'jobId',
        'operation',
        'outcome',
        'reason',
        'schema',
      ].sort(),
    );

    const granted = brokerDecision({ outcome: 'granted' });
    expect(() => assertCapabilityBrokerDecisionV1(granted)).not.toThrow();
    expect(granted.grant).not.toBeNull();
    expect(granted.reason).toBeNull();
    expect(Object.isFrozen(granted)).toBe(true);
    expect(Object.isFrozen(granted.grant)).toBe(true);

    const denied = brokerDecision({
      outcome: 'denied',
      grant: null,
      reason: 'capability_denied',
    });
    expect(() => assertCapabilityBrokerDecisionV1(denied)).not.toThrow();
    expect(denied.grant).toBeNull();
    expect(denied.reason).toBe('capability_denied');

    expectSchemaError(() =>
      assertCapabilityBrokerDecisionV1(
        brokerDecision({
          outcome: 'granted',
          grant: null,
          reason: null,
        }),
      ),
    );
    expectSchemaError(() =>
      assertCapabilityBrokerDecisionV1(
        brokerDecision({
          outcome: 'granted',
          reason: 'capability_denied',
        }),
      ),
    );
    expectSchemaError(() =>
      assertCapabilityBrokerDecisionV1(
        brokerDecision({
          outcome: 'denied',
          grant: capabilityGrant(),
          reason: 'capability_denied',
        }),
      ),
    );
    expectSchemaError(() =>
      assertCapabilityBrokerDecisionV1(
        brokerDecision({
          outcome: 'denied',
          grant: null,
          reason: null,
        }),
      ),
    );
  });

  it('CapabilityBrokerDecisionV1 rejects unknown/missing key and hash mismatch', () => {
    expectSchemaError(() =>
      assertCapabilityBrokerDecisionV1({
        ...brokerDecision(),
        extra: true,
      } as unknown as CapabilityBrokerDecisionV1),
    );
    expectSchemaError(() => {
      const { operation: _drop, ...rest } = brokerDecision();
      assertCapabilityBrokerDecisionV1(
        rest as unknown as CapabilityBrokerDecisionV1,
      );
    });
    expectSchemaError(() =>
      assertCapabilityBrokerDecisionV1(
        brokerDecision({ decisionHash: HASH_ZERO }),
      ),
    );
  });

  it('JobSpecV1 rejects capability id outside allowedCapabilityIds', () => {
    expectSchemaError(() =>
      assertJobSpecV1(
        jobSpec({
          capabilityGrants: [
            capabilityGrant({ capabilityId: 'cap-secret' }),
          ],
          environmentPolicy: environmentPolicy({
            allowedCapabilityIds: ['cap-net'],
          }),
        }),
      ),
    );
  });

  it('JobSpecV1 and CapabilityGrantV1 reject expiresAt not strictly after issuedAt', () => {
    expectSchemaError(() =>
      assertCapabilityGrantV1(
        capabilityGrant({
          issuedAt: '2026-08-29T01:00:00.000Z',
          expiresAt: '2026-08-29T01:00:00.000Z',
        }),
      ),
    );
    expectSchemaError(() =>
      assertJobSpecV1(
        jobSpec({
          issuedAt: '2026-08-29T02:00:00.000Z',
          expiresAt: '2026-08-29T01:00:00.000Z',
        }),
      ),
    );
  });

  it('ResultPackageV1 rejects byte-sum mismatch and completedAt < startedAt', () => {
    expectSchemaError(() =>
      assertResultPackageV1(
        resultPackage({
          artifacts: [artifactRef({ byteLength: 4 })],
          totalOutputBytes: 99,
        }),
      ),
    );
    expectSchemaError(() =>
      assertResultPackageV1(
        resultPackage({
          startedAt: '2026-08-29T00:00:05.000Z',
          completedAt: '2026-08-29T00:00:01.000Z',
        }),
      ),
    );
  });

  it('deep-freeze prevents mutation after successful validation', () => {
    const grant = capabilityGrant();
    assertCapabilityGrantV1(grant);
    expect(Object.isFrozen(grant)).toBe(true);
    expect(() => {
      (grant as { operation: string }).operation = 'mutated';
    }).toThrow();

    const pkg = resultPackage();
    assertResultPackageV1(pkg);
    expect(Object.isFrozen(pkg)).toBe(true);
    expect(Object.isFrozen(pkg.artifacts)).toBe(true);
    expect(Object.isFrozen(pkg.artifacts[0])).toBe(true);
    expect(() => {
      (pkg.artifacts as ResultArtifactRefV1[]).push(
        artifactRef({ artifactId: 'artifact-2' }),
      );
    }).toThrow();

    const spec = jobSpec();
    assertJobSpecV1(spec);
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.capabilityGrants)).toBe(true);
    expect(Object.isFrozen(spec.environmentPolicy)).toBe(true);
  });

  it('ResultAdmissionV1 and LeaseAdmissionV1 enforce cross-field reason/lease implications', () => {
    expectSchemaError(() =>
      assertResultAdmissionV1(
        resultAdmission({
          outcome: 'admitted',
          reason: 'duplicate_result',
        }),
      ),
    );
    expectSchemaError(() =>
      assertResultAdmissionV1(
        resultAdmission({
          outcome: 'rejected',
          reason: null,
        }),
      ),
    );
    expectSchemaError(() =>
      assertLeaseAdmissionV1(
        leaseAdmission({
          outcome: 'admitted',
          lease: null,
          reason: null,
        }),
      ),
    );
    expectSchemaError(() =>
      assertLeaseAdmissionV1(
        leaseAdmission({
          outcome: 'refused',
          lease: workerLease(),
          reason: 'lease_held',
        }),
      ),
    );
    expectSchemaError(() =>
      assertLeaseAdmissionV1(
        leaseAdmission({
          outcome: 'refused',
          lease: null,
          reason: null,
        }),
      ),
    );
  });

  it.each([
    {
      name: 'capability grant unknown field',
      run: () =>
        assertCapabilityGrantV1({
          ...capabilityGrant(),
          extra: true,
        } as unknown as CapabilityGrantV1),
    },
    {
      name: 'capability grant missing field',
      run: () => {
        const { grantId: _drop, ...rest } = capabilityGrant();
        assertCapabilityGrantV1(rest as unknown as CapabilityGrantV1);
      },
    },
    {
      name: 'capability grant empty string',
      run: () =>
        assertCapabilityGrantV1(capabilityGrant({ operation: '' })),
    },
    {
      name: 'capability grant non-NFC string',
      run: () =>
        assertCapabilityGrantV1(
          capabilityGrant({ operation: 'e\u0301' }),
        ),
    },
    {
      name: 'capability grant bad timestamp precision',
      run: () =>
        assertCapabilityGrantV1(
          capabilityGrant({ issuedAt: '2026-08-29T00:00:00Z' }),
        ),
    },
    {
      name: 'capability grant wrong grantHash',
      run: () =>
        assertCapabilityGrantV1(capabilityGrant({ grantHash: HASH_ZERO })),
    },
    {
      name: 'artifact ref unknown field',
      run: () =>
        assertResultArtifactRefV1({
          ...artifactRef(),
          extra: true,
        } as unknown as ResultArtifactRefV1),
    },
    {
      name: 'artifact ref missing field',
      run: () => {
        const { artifactId: _drop, ...rest } = artifactRef();
        assertResultArtifactRefV1(rest as unknown as ResultArtifactRefV1);
      },
    },
    {
      name: 'artifact ref unsafe byteLength',
      run: () =>
        assertResultArtifactRefV1(
          artifactRef({ byteLength: Number.NaN }),
        ),
    },
    {
      name: 'artifact ref bad digest',
      run: () =>
        assertResultArtifactRefV1(artifactRef({ sha256: 'not-a-digest' })),
    },
    {
      name: 'execution payload sparse inputArtifacts',
      run: () => {
        const sparse: ResultArtifactRefV1[] = [];
        sparse.length = 1;
        assertJobExecutionPayloadV1(
          executionPayload({
            inputArtifacts: sparse,
            payloadHash: HASH_ZERO,
          }),
        );
      },
    },
    {
      name: 'environment policy unsorted allowedCapabilityIds',
      run: () =>
        assertJobSpecEnvironmentPolicyV1(
          environmentPolicy({
            allowedCapabilityIds: ['cap-z', 'cap-a'],
          }),
        ),
    },
    {
      name: 'environment policy unsafe maxOutputBytes',
      run: () =>
        assertJobSpecEnvironmentPolicyV1(
          environmentPolicy({
            maxOutputBytes: Number.POSITIVE_INFINITY,
            policyHash: HASH_ZERO,
          }),
        ),
    },
    {
      name: 'lease policy missing field',
      run: () => {
        const { heartbeatIntervalMs: _drop, ...rest } = leasePolicy();
        assertWorkerLeasePolicyV1(rest as unknown as WorkerLeasePolicyV1);
      },
    },
    {
      name: 'job spec unknown field',
      run: () =>
        assertJobSpecV1({
          ...jobSpec(),
          extra: true,
        } as unknown as JobSpecV1),
    },
    {
      name: 'job spec missing field',
      run: () => {
        const { taskId: _drop, ...rest } = jobSpec();
        assertJobSpecV1(rest as unknown as JobSpecV1);
      },
    },
    {
      name: 'job spec bad git sha short',
      run: () => assertJobSpecV1(jobSpec({ candidateCommit: 'abc123' })),
    },
    {
      name: 'job spec uppercase git sha',
      run: () =>
        assertJobSpecV1(
          jobSpec({
            candidateCommit: '0123456789ABCDEF0123456789ABCDEF01234567',
          }),
        ),
    },
    {
      name: 'job spec non-canonical timestamp zone',
      run: () =>
        assertJobSpecV1(
          jobSpec({ issuedAt: '2026-08-29T00:00:00.000+00:00' }),
        ),
    },
    {
      name: 'job spec empty authorityEpoch',
      run: () => assertJobSpecV1(jobSpec({ authorityEpoch: '' })),
    },
    {
      name: 'worker lease unknown field',
      run: () =>
        assertWorkerLeaseV1({
          ...workerLease(),
          extra: true,
        } as unknown as WorkerLeaseV1),
    },
    {
      name: 'worker lease missing field',
      run: () => {
        const { workerId: _drop, ...rest } = workerLease();
        assertWorkerLeaseV1(rest as unknown as WorkerLeaseV1);
      },
    },
    {
      name: 'worker lease unsafe leaseEpoch',
      run: () =>
        assertWorkerLeaseV1(workerLease({ leaseEpoch: 1.5 })),
    },
    {
      name: 'worker lease expiresAt not after leasedAt',
      run: () =>
        assertWorkerLeaseV1(
          workerLease({
            leasedAt: '2026-08-29T00:00:30.000Z',
            expiresAt: '2026-08-29T00:00:30.000Z',
          }),
        ),
    },
    {
      name: 'result package unknown field',
      run: () =>
        assertResultPackageV1({
          ...resultPackage(),
          extra: true,
        } as unknown as ResultPackageV1),
    },
    {
      name: 'result package missing field',
      run: () => {
        const { resultId: _drop, ...rest } = resultPackage();
        assertResultPackageV1(rest as unknown as ResultPackageV1);
      },
    },
    {
      name: 'result package sparse artifacts',
      run: () => {
        const sparse: ResultArtifactRefV1[] = [];
        sparse.length = 1;
        assertResultPackageV1(
          resultPackage({
            artifacts: sparse,
            totalOutputBytes: 0,
            resultHash: HASH_ZERO,
          }),
        );
      },
    },
    {
      name: 'result package non-NFC workerId',
      run: () =>
        assertResultPackageV1(
          resultPackage({ workerId: 'w\u0301orker' }),
        ),
    },
    {
      name: 'result admission unknown field',
      run: () =>
        assertResultAdmissionV1({
          ...resultAdmission(),
          extra: true,
        } as unknown as ResultAdmissionV1),
    },
    {
      name: 'result admission missing field',
      run: () => {
        const { resultId: _drop, ...rest } = resultAdmission();
        assertResultAdmissionV1(rest as unknown as ResultAdmissionV1);
      },
    },
    {
      name: 'lease admission unknown field',
      run: () =>
        assertLeaseAdmissionV1({
          ...leaseAdmission(),
          extra: true,
        } as unknown as LeaseAdmissionV1),
    },
    {
      name: 'lease admission missing field',
      run: () => {
        const { workerId: _drop, ...rest } = leaseAdmission();
        assertLeaseAdmissionV1(rest as unknown as LeaseAdmissionV1);
      },
    },
    {
      name: 'capability broker decision unknown field',
      run: () =>
        assertCapabilityBrokerDecisionV1({
          ...brokerDecision(),
          extra: true,
        } as unknown as CapabilityBrokerDecisionV1),
    },
    {
      name: 'capability broker decision missing field',
      run: () => {
        const { jobId: _drop, ...rest } = brokerDecision();
        assertCapabilityBrokerDecisionV1(
          rest as unknown as CapabilityBrokerDecisionV1,
        );
      },
    },
    {
      name: 'capability broker decision wrong decisionHash',
      run: () =>
        assertCapabilityBrokerDecisionV1(
          brokerDecision({ decisionHash: HASH_ZERO }),
        ),
    },
  ])('rejects $name', ({ run }) => {
    expectSchemaError(run);
  });
});
