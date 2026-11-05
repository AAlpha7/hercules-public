import { describe, expect, it } from 'vitest';
import {
  compileLegacyTaskContract,
  LEGACY_MISSING_DOD_TEXT,
  type LegacyTaskContractInput,
} from '../../src/domain/contractCompiler.js';
import {
  ContractHashError,
  assertTaskContractHash,
  computeTaskContractHash,
} from '../../src/domain/contractHash.js';
import type { TaskContract } from '../../src/domain/taskContract.js';
import { resolveHumanCriterionLabels } from '../../src/web/review/humanCriterionLabels.js';

function input(body: string, overrides: Partial<LegacyTaskContractInput> = {}): LegacyTaskContractInput {
  return {
    taskId: 'legacy-task',
    objective: 'Produce a verified outcome',
    body,
    context: [{ kind: 'repo', uri: 'repo://hercules', digest: 'abc123' }],
    constraints: ['stay offline'],
    forbiddenActions: ['deploy'],
    capabilityPolicy: { version: '1', grants: ['read_source'] },
    verificationPolicy: {
      version: '1',
      requiredEvidence: ['test'],
      independentEvaluatorRequired: true,
    },
    approvalPolicy: { version: '1', requiredDecisions: ['human_for_deploy'] },
    budgetPolicy: {
      version: '1',
      maxCostUsd: 50,
      maxTokens: null,
      maxDurationMs: 3_600_000,
    },
    createdBy: { kind: 'control_plane', id: 'legacy-compiler' },
    createdAt: '2026-08-28T09:40:00Z',
    ...overrides,
  };
}

const typedBody = `
## Definition of Done
- [ ] (mechanical) Unit suite passes @gate:test
- [ ] (reviewer) No scope creep
- [ ] (human) Accept the outcome
- [ ] Legacy untyped acceptance
`;

describe('legacy DoD to V2 contract compiler', () => {
  it('preserves authority without granting reviewer or untyped criteria weaker authority', () => {
    const result = compileLegacyTaskContract(input(typedBody));

    expect(result.contract.version).toBe(1);
    expect(result.contract.supersedesVersion).toBeNull();
    expect(result.contract.acceptanceCriteria.map((criterion) => criterion.authority)).toEqual([
      'mechanical',
      'evaluator',
      'human',
      'human',
    ]);
    expect(result.contract.acceptanceCriteria.every((criterion) => criterion.required)).toBe(true);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'untyped_criterion_as_human',
    );
    assertTaskContractHash(result.contract);
  });

  it('maps mechanical proof bindings into structured semantic bindings', () => {
    const result = compileLegacyTaskContract(input(typedBody));
    expect(result.contract.acceptanceCriteria[0]).toMatchObject({
      text: 'Unit suite passes',
      authority: 'mechanical',
      proofBinding: { proofType: 'gate', requirement: 'test' },
    });
  });

  it('maps test-case, probe, and checkpoint kinds', () => {
    const result = compileLegacyTaskContract(
      input(`
## Definition of Done
- [ ] (mechanical) named case @test:test/domain/x.test.ts#rejects a forged pin
- [ ] (mechanical) reachable @probe:http:GET /health
- [ ] (checkpoint) before deploy: confirm staging
`),
    );
    expect(result.contract.acceptanceCriteria.map((c) => c.authority)).toEqual([
      'mechanical',
      'mechanical',
      'human',
    ]);
    expect(result.contract.acceptanceCriteria[0]?.proofBinding).toEqual({
      proofType: 'test_case',
      requirement: 'test/domain/x.test.ts#rejects a forged pin',
    });
    expect(result.contract.acceptanceCriteria[1]?.proofBinding).toEqual({
      proofType: 'probe',
      requirement: 'http:GET /health',
    });
    expect(result.contract.acceptanceCriteria[2]?.proofBinding).toBeNull();
  });

  it('maps Chinese aliases conservatively', () => {
    const result = compileLegacyTaskContract(
      input(`
## 验收标准
- [ ] （机检）构建通过 @gate:build
- [ ] (审稿) 范围正确
- [ ] 人工: 手机确认
`),
    );
    expect(result.contract.acceptanceCriteria.map((criterion) => criterion.authority)).toEqual([
      'mechanical',
      'evaluator',
      'human',
    ]);
  });

  it('uses a required human fallback for missing or empty DoD', () => {
    for (const body of ['No acceptance section', '## Acceptance criteria\n\nprose only']) {
      const result = compileLegacyTaskContract(input(body));
      expect(result.contract.acceptanceCriteria).toHaveLength(1);
      expect(result.contract.acceptanceCriteria[0]).toMatchObject({
        text: LEGACY_MISSING_DOD_TEXT,
        authority: 'human',
        required: true,
        proofBinding: null,
      });
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        'missing_definition_of_done',
      );
    }
  });

  it('keeps criterion IDs and semantic hashes stable across checkbox outcome changes', () => {
    const pending = compileLegacyTaskContract(input(typedBody)).contract;
    const checked = compileLegacyTaskContract(input(typedBody.replaceAll('[ ]', '[x]'), {
      createdAt: '2026-08-29T10:00:00Z',
      createdBy: { kind: 'human', id: 'different-author' },
      taskId: 'different-task',
    })).contract;

    expect(checked.acceptanceCriteria.map((criterion) => criterion.id)).toEqual(
      pending.acceptanceCriteria.map((criterion) => criterion.id),
    );
    expect(checked.contractHash).toBe(pending.contractHash);
  });

  it('distinguishes duplicate occurrences while remaining deterministic', () => {
    const body = `
## DoD
- [ ] (human) Confirm result
- [ ] (human) Confirm result
`;
    const first = compileLegacyTaskContract(input(body)).contract.acceptanceCriteria;
    const second = compileLegacyTaskContract(input(body)).contract.acceptanceCriteria;

    expect(first[0]!.id).not.toBe(first[1]!.id);
    expect(second.map((criterion) => criterion.id)).toEqual(first.map((criterion) => criterion.id));
  });

  it('excludes provenance/version binding facts but includes every semantic field in the hash', () => {
    const base = compileLegacyTaskContract(input(typedBody)).contract;
    const derivedOnly: TaskContract = {
      ...base,
      taskId: 'other-task',
      version: 9,
      supersedesVersion: 8,
      createdAt: '2030-01-01T00:00:00Z',
      createdBy: { kind: 'human', id: 'owner' },
      contractHash: 'forged-value-is-excluded',
    };
    expect(computeTaskContractHash(derivedOnly)).toBe(base.contractHash);

    const semanticVariants: readonly TaskContract[] = [
      { ...base, objective: `${base.objective}!` },
      { ...base, context: [...base.context, { kind: 'doc', uri: 'doc://x', digest: null }] },
      { ...base, acceptanceCriteria: base.acceptanceCriteria.map((criterion, index) =>
        index === 0 ? { ...criterion, required: false } : criterion) },
      { ...base, constraints: [...base.constraints, 'new constraint'] },
      { ...base, forbiddenActions: [...base.forbiddenActions, 'publish'] },
      { ...base, capabilityPolicy: { ...base.capabilityPolicy, grants: ['write_source'] } },
      { ...base, verificationPolicy: { ...base.verificationPolicy, requiredEvidence: ['build'] } },
      { ...base, approvalPolicy: { ...base.approvalPolicy, requiredDecisions: ['owner'] } },
      { ...base, budgetPolicy: { ...base.budgetPolicy, maxCostUsd: 49 } },
    ];
    for (const variant of semanticVariants) {
      expect(computeTaskContractHash(variant)).not.toBe(base.contractHash);
    }
  });

  it('whitelists nested semantic fields so decoded derived facts cannot affect the hash', () => {
    const base = compileLegacyTaskContract(input(typedBody)).contract;
    const withDerivedFacts: TaskContract = {
      ...base,
      context: base.context.map((context) => ({
        ...context,
        fetchedAt: '2030-01-01T00:00:00Z',
      })) as unknown as TaskContract['context'],
      acceptanceCriteria: base.acceptanceCriteria.map((criterion) => ({
        ...criterion,
        checked: true,
        runtimeStatus: 'pass',
        proofBinding: criterion.proofBinding === null
          ? null
          : { ...criterion.proofBinding, observedAt: '2030-01-01T00:00:00Z' },
      })) as unknown as TaskContract['acceptanceCriteria'],
      capabilityPolicy: {
        ...base.capabilityPolicy,
        derivedGrantCount: 99,
      } as unknown as TaskContract['capabilityPolicy'],
    };

    expect(computeTaskContractHash(withDerivedFacts)).toBe(base.contractHash);
    expect(() => assertTaskContractHash(withDerivedFacts)).not.toThrow();
    const toggled = {
      ...withDerivedFacts,
      acceptanceCriteria: withDerivedFacts.acceptanceCriteria.map((criterion) => ({
        ...criterion,
        checked: false,
      })) as unknown as TaskContract['acceptanceCriteria'],
    };
    expect(computeTaskContractHash(toggled)).toBe(base.contractHash);
  });

  it('rejects accessor and class-instance contract fields before projection', () => {
    const base = compileLegacyTaskContract(input(typedBody)).contract;
    let reads = 0;
    const accessorPolicy = Object.defineProperty({}, 'version', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 'v1';
      },
    });
    Object.defineProperty(accessorPolicy, 'grants', {
      enumerable: true,
      value: [],
    });
    class ContextRecord {
      readonly kind = 'repo';
      readonly uri = 'repo://unsafe';
      readonly digest = null;
    }

    expect(() => assertTaskContractHash({
      ...base,
      capabilityPolicy: accessorPolicy as TaskContract['capabilityPolicy'],
    })).toThrow(ContractHashError);
    expect(reads).toBe(0);
    expect(() => assertTaskContractHash({
      ...base,
      context: [new ContextRecord()],
    })).toThrow(ContractHashError);
  });

  it('fails closed with a typed hash error for malformed decoded inputs', () => {
    for (const malformed of [
      null,
      {},
      { contractHash: `sha256:${'0'.repeat(64)}`, context: null },
      { contractHash: `sha256:${'0'.repeat(64)}`, context: { map: () => [] } },
    ]) {
      expect(() => assertTaskContractHash(malformed as unknown as TaskContract)).toThrow(
        ContractHashError,
      );
    }
  });

  it('rejects projection-shaped contracts with valid hashes but invalid structure', () => {
    const base = compileLegacyTaskContract(input(typedBody)).contract;
    const malformed = [
      { ...base, taskId: 42 as unknown as string },
      { ...base, version: 0 },
      { ...base, acceptanceCriteria: [] },
      { ...base, createdBy: { kind: 'intruder', id: '' } as unknown as TaskContract['createdBy'] },
    ];

    for (const invalid of malformed) {
      const correctlyHashed = {
        ...invalid,
        contractHash: computeTaskContractHash(invalid),
      };
      expect(() => assertTaskContractHash(correctlyHashed)).toThrow(ContractHashError);
    }
  });

  it('detects a forged hash and does not retain mutable input aliases', () => {
    const constraints = ['stay offline'];
    const compiled = compileLegacyTaskContract(input(typedBody, { constraints })).contract;
    constraints.push('mutated after compile');
    expect(compiled.constraints).toEqual(['stay offline']);
    expect(() => assertTaskContractHash({ ...compiled, contractHash: 'sha256:' + '0'.repeat(64) }))
      .toThrow('does not match');
  });

  it('compiles (human, after deploy) as required:false while plain (human) stays required', () => {
    const body = `
## Definition of Done
- [ ] (human) Owner accepts the change
- [ ] (human, after deploy) Latency dashboard stays green
`;
    const compiled = compileLegacyTaskContract(input(body)).contract.acceptanceCriteria;
    const requiredHuman = compiled.find((c) => c.text === 'Owner accepts the change');
    const afterDeploy = compiled.find((c) => c.text === 'Latency dashboard stays green');
    expect(requiredHuman).toMatchObject({
      authority: 'human',
      required: true,
      proofBinding: null,
    });
    expect(afterDeploy).toMatchObject({
      authority: 'human',
      required: false,
      proofBinding: null,
    });

    const asRequired = compileLegacyTaskContract(
      input(`
## Definition of Done
- [ ] (human) Latency dashboard stays green
`),
    ).contract.acceptanceCriteria[0]!;
    expect(asRequired.required).toBe(true);
    expect(afterDeploy!.id).not.toBe(asRequired.id);
  });

  it('browser resolver ids equal compiler human ids for the same body', async () => {
    const body = `
## Definition of Done
- [ ] (mechanical) Unit suite passes @gate:test
- [ ] (human) Owner accepts the change
- [ ] (human, after deploy) Latency dashboard stays green
- [ ] (checkpoint) before merge: look at staging
`;
    const compiled = compileLegacyTaskContract(input(body)).contract;
    const humanIds = compiled.acceptanceCriteria
      .filter((c) => c.authority === 'human')
      .map((c) => c.id);
    expect(humanIds.length).toBe(3);

    const labels = await resolveHumanCriterionLabels(body, humanIds);
    expect([...labels.keys()].sort()).toEqual(
      humanIds.map((id) => `human:${id}`).sort(),
    );
    expect(labels.get(`human:${humanIds[0]!}`)).toBeDefined();
    for (const id of humanIds) {
      const criterion = compiled.acceptanceCriteria.find((c) => c.id === id)!;
      expect(labels.get(`human:${id}`)).toBe(criterion.text);
    }
  });
});
