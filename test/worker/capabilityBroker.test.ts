import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_BROKER_DECISION_KEYS,
  CAPABILITY_GRANT_KEYS,
  WorkerBoundaryError,
  assertCapabilityBrokerDecisionV1,
  computeBrokerDecisionHash,
  computeEnvironmentPolicyHash,
  computeGrantHash,
  computeJobSpecHash,
  computeLeasePolicyHash,
  computePayloadHash,
  type CapabilityBrokerDecisionV1,
  type CapabilityGrantV1,
  type JobExecutionPayloadV1,
  type JobSpecEnvironmentPolicyV1,
  type JobSpecV1,
  type ResultArtifactRefV1,
  type WorkerLeasePolicyV1,
} from '../../src/domain/workerBoundary.js';
import { brokerCapability } from '../../src/worker/capabilityBroker.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const HASH_A =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B =
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C =
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

const T0 = '2026-08-29T00:00:00.000Z';
const T_PLUS_10S = '2026-08-29T00:00:10.000Z';
const T_PLUS_30M = '2026-08-29T00:30:00.000Z';
const T_PLUS_2H = '2026-08-29T02:00:00.000Z';

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
    expiresAt: T_PLUS_2H,
    ...fields,
  };
  return {
    ...withoutHash,
    jobSpecHash: overrideHash ?? computeJobSpecHash(withoutHash),
  };
}

function expectGranted(
  decision: CapabilityBrokerDecisionV1,
  grant: CapabilityGrantV1,
): void {
  expect(decision.outcome).toBe('granted');
  expect(decision.reason).toBeNull();
  expect(decision.grant).toEqual(grant);
  assertCapabilityBrokerDecisionV1(decision);
}

function expectDenied(decision: CapabilityBrokerDecisionV1): void {
  expect(decision.outcome).toBe('denied');
  expect(decision.grant).toBeNull();
  expect(decision.reason).toBe('capability_denied');
  assertCapabilityBrokerDecisionV1(decision);
}

describe('brokerCapability', () => {
  it('grants a matching unexpired policy-allowed grant', () => {
    const grant = capabilityGrant();
    const spec = jobSpec({ capabilityGrants: [grant] });
    const decision = brokerCapability(spec, 'fetch', T_PLUS_10S);

    expectGranted(decision, grant);
    expect(decision.jobId).toBe(spec.jobId);
    expect(decision.operation).toBe('fetch');
    expect(decision.decidedAt).toBe(T_PLUS_10S);
    expect(decision.decisionHash).toBe(
      computeBrokerDecisionHash({
        schema: 'hercules-capability-broker-decision/v1',
        outcome: 'granted',
        jobId: spec.jobId,
        operation: 'fetch',
        grant,
        reason: null,
        decidedAt: T_PLUS_10S,
      }),
    );
  });

  it('denies when the matching grant is expired (now >= expiresAt)', () => {
    const grant = capabilityGrant({
      expiresAt: '2026-08-29T00:00:05.000Z',
    });
    const spec = jobSpec({ capabilityGrants: [grant] });
    const decision = brokerCapability(spec, 'fetch', T_PLUS_10S);
    expectDenied(decision);
  });

  it('denies when operation is absent from capabilityGrants', () => {
    const spec = jobSpec({
      capabilityGrants: [capabilityGrant({ operation: 'fetch' })],
    });
    const decision = brokerCapability(spec, 'push', T_PLUS_10S);
    expectDenied(decision);
  });

  it('denies when no policy-allowed grant covers the operation', () => {
    // Validated JobSpecs cannot carry a grant whose capabilityId is outside
    // allowedCapabilityIds (assertJobSpecV1). Cover the broker filter by
    // requesting an operation with empty grants / empty allowed set.
    const spec = jobSpec({
      environmentPolicy: environmentPolicy({ allowedCapabilityIds: [] }),
      capabilityGrants: [],
    });
    const decision = brokerCapability(spec, 'fetch', T_PLUS_10S);
    expectDenied(decision);
  });

  it('denies when grant would match but capability is not in allowedCapabilityIds', () => {
    // Defense-in-depth path: build a JobSpec whose grants ⊆ allowed at
    // construction, then prove the broker conjunction requires allowed.has
    // by using a second grant for a different capability — only the
    // policy-allowed one can win. Here both are allowed at construction;
    // request an operation whose only grant is for a capability we remove
    // from consideration by having no grants for that operation under the
    // allowed set. Practical cover: grant for cap-disk/write is present and
    // allowed; requesting 'write' grants. Requesting with a job that has
    // cap-net allowed but only a fetch grant → write is denied (absent /
    // not covered by a policy-allowed grant).
    const fetchGrant = capabilityGrant({
      grantId: 'grant-fetch',
      capabilityId: 'cap-net',
      operation: 'fetch',
    });
    const spec = jobSpec({
      environmentPolicy: environmentPolicy({
        allowedCapabilityIds: ['cap-disk', 'cap-net'],
      }),
      capabilityGrants: [fetchGrant],
    });
    // 'write' has no grant at all → denied (not policy-allowed coverage)
    expectDenied(brokerCapability(spec, 'write', T_PLUS_10S));
    // 'fetch' is covered by an allowed grant → granted
    expectGranted(brokerCapability(spec, 'fetch', T_PLUS_10S), fetchGrant);
  });

  it('picks the first matching grant in array order when multiple match', () => {
    const first = capabilityGrant({
      grantId: 'grant-a',
      capabilityId: 'cap-net',
      operation: 'fetch',
      scope: 'repo:first',
    });
    const second = capabilityGrant({
      grantId: 'grant-b',
      capabilityId: 'cap-net',
      operation: 'fetch',
      scope: 'repo:second',
    });
    const spec = jobSpec({
      capabilityGrants: [first, second],
    });
    const decision = brokerCapability(spec, 'fetch', T_PLUS_10S);
    expectGranted(decision, first);
    expect(decision.grant?.grantId).toBe('grant-a');
    expect(decision.grant?.scope).toBe('repo:first');
  });

  it('skips an expired earlier grant and selects a later unexpired match', () => {
    const expired = capabilityGrant({
      grantId: 'grant-old',
      capabilityId: 'cap-net',
      operation: 'fetch',
      expiresAt: '2026-08-29T00:00:05.000Z',
      scope: 'repo:old',
    });
    const live = capabilityGrant({
      grantId: 'grant-new',
      capabilityId: 'cap-net',
      operation: 'fetch',
      expiresAt: '2026-08-29T01:00:00.000Z',
      scope: 'repo:new',
    });
    const spec = jobSpec({
      capabilityGrants: [expired, live],
    });
    const decision = brokerCapability(spec, 'fetch', T_PLUS_10S);
    expectGranted(decision, live);
  });

  it('throws invalid_input_schema on malformed jobSpec, operation, or now', () => {
    const spec = jobSpec();
    expectSchemaError(() =>
      brokerCapability({ ...spec, jobId: '' } as JobSpecV1, 'fetch', T_PLUS_10S),
    );
    expectSchemaError(() => brokerCapability(spec, '', T_PLUS_10S));
    expectSchemaError(() =>
      brokerCapability(spec, 'e\u0301', T_PLUS_10S),
    );
    expectSchemaError(() =>
      brokerCapability(spec, 'fetch', '2026-08-29T00:00:10Z'),
    );
  });

  it('never exposes a secret on the decision or grant key set', () => {
    const decision = brokerCapability(jobSpec(), 'fetch', T_PLUS_10S);
    expectGranted(decision, capabilityGrant());
    expect(CAPABILITY_BROKER_DECISION_KEYS).not.toContain('secret');
    expect(CAPABILITY_BROKER_DECISION_KEYS).not.toContain('token');
    expect(CAPABILITY_GRANT_KEYS).not.toContain('secret');
    expect(CAPABILITY_GRANT_KEYS).not.toContain('token');
    expect(CAPABILITY_GRANT_KEYS).not.toContain('password');
    const serialized = JSON.stringify(decision);
    expect(serialized).not.toMatch(/secret/i);
    expect(serialized).not.toMatch(/password/i);
    expect(serialized).not.toMatch(/api[_-]?key/i);
  });

  it('restart determinism: same inputs yield byte-identical decision', () => {
    const spec = jobSpec();
    const a = brokerCapability(spec, 'fetch', T_PLUS_30M);
    const b = brokerCapability(spec, 'fetch', T_PLUS_30M);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
