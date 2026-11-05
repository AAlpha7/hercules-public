/**
 * Project-state closure contract — pure domain tests (opt-in, fail-closed).
 */
import { describe, it, expect } from 'vitest';
import {
  parseProjectStateClosureConfig,
  resolveProjectStateClosureContract,
  evaluateProjectStateClosure,
  deriveDeliveryPipelineStages,
  formatProjectStateClosureBlockReason,
  formatProjectStateClosureReceipt,
  encodeProjectStateClosureReceiptBlock,
  parseProjectStateClosureReceiptFromBody,
  upsertProjectStateClosureReceiptBody,
  projectStateClosureCanonical,
  normalizeProjectStatePath,
  ProjectStateClosureParseError,
  type ProjectStateClosureContract,
  type ProjectStateClosureProvenance,
} from '../../src/domain/projectStateClosure.js';

const PROV: ProjectStateClosureProvenance = {
  baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  candidateSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  mergeTreeSha: 'cccccccccccccccccccccccccccccccccccccccc',
  policyDigest: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
};

function sampleContract(over: Partial<ProjectStateClosureContract> = {}): ProjectStateClosureContract {
  const base = parseProjectStateClosureConfig({
    surfaces: {
      status: 'PROJECT_STATUS.md',
      backlog: 'docs/roadmap.md',
      exec_plan: 'docs/ExecPlan.md',
      changelog: 'CHANGELOG.md',
    },
    rules: [
      {
        id: 'close-onboarding',
        when: { labels_any: ['onboarding'] },
        surfaces: ['status', 'backlog'],
        forbid_patterns: ['onboarding incomplete'],
        require_patterns: ['onboarding complete'],
        required_update: 'Mark Status and Backlog as onboarding complete',
      },
    ],
  });
  if (!base) throw new Error('expected contract');
  return { ...base, ...over };
}

describe('projectStateClosure path safety', () => {
  it('accepts declared relative surfaces and rejects traversal / absolute', () => {
    expect(normalizeProjectStatePath('PROJECT_STATUS.md')).toBe('PROJECT_STATUS.md');
    expect(normalizeProjectStatePath('docs/roadmap.md')).toBe('docs/roadmap.md');
    expect(() => normalizeProjectStatePath('../etc/passwd')).toThrow(ProjectStateClosureParseError);
    expect(() => normalizeProjectStatePath('/etc/passwd')).toThrow(ProjectStateClosureParseError);
    expect(() => normalizeProjectStatePath('C:\\Windows')).toThrow(ProjectStateClosureParseError);
  });

  it('rejects unknown surface kinds (no free path injection)', () => {
    expect(() =>
      parseProjectStateClosureConfig({
        surfaces: { secret: 'evil.md', status: 'PROJECT_STATUS.md' },
        rules: [
          {
            id: 'r1',
            surfaces: ['status'],
            forbid_patterns: ['x'],
            required_update: 'fix status',
          },
        ],
      }),
    ).toThrow(/unknown surface kind/);
  });
});

describe('projectStateClosure parse', () => {
  it('names Status, Backlog, ExecPlan and Changelog surfaces', () => {
    const c = sampleContract();
    expect(c.surfaces.map((s) => s.kind).sort()).toEqual([
      'backlog',
      'changelog',
      'exec_plan',
      'status',
    ]);
    expect(c.surfaces.find((s) => s.kind === 'status')?.path).toBe('PROJECT_STATUS.md');
    expect(c.surfaces.find((s) => s.kind === 'exec_plan')?.path).toBe('docs/ExecPlan.md');
  });

  it('returns null when absent (opt-out)', () => {
    expect(parseProjectStateClosureConfig(undefined)).toBeNull();
    expect(parseProjectStateClosureConfig(null)).toBeNull();
    expect(parseProjectStateClosureConfig({})).toBeNull();
  });

  it('accepts policy-only stub for external trusted policy file', () => {
    const stub = parseProjectStateClosureConfig({
      policy: 'docs/project-state-closure.yaml',
    });
    expect(stub?.policyPath).toBe('docs/project-state-closure.yaml');
    expect(stub?.surfaces).toEqual([]);
    const file = sampleContract({ policyPath: null });
    const resolved = resolveProjectStateClosureContract({
      workflowContract: stub,
      policyFileContract: file,
    });
    expect(resolved?.surfaces.length).toBe(4);
    expect(resolved?.policyPath).toBe('docs/project-state-closure.yaml');
  });

  it('rejects rule referencing undeclared surface', () => {
    expect(() =>
      parseProjectStateClosureConfig({
        surfaces: { status: 'PROJECT_STATUS.md' },
        rules: [
          {
            id: 'r1',
            surfaces: ['backlog'],
            forbid_patterns: ['x'],
            required_update: 'fix backlog',
          },
        ],
      }),
    ).toThrow(/undeclared surface/);
  });
});

describe('projectStateClosure evaluate', () => {
  it('blocks stale declared state with bounded actionable receipt', () => {
    const contract = sampleContract();
    const receipt = evaluateProjectStateClosure({
      contract,
      task: { id: 'T1', labels: ['onboarding'] },
      surfaceContents: new Map([
        ['status', '# Status\nonboarding incomplete\n'],
        ['backlog', '# Backlog\nonboarding incomplete\n'],
        ['exec_plan', null],
        ['changelog', null],
      ]),
      provenance: PROV,
    });
    expect(receipt.ok).toBe(false);
    expect(receipt.status).toBe('failed');
    expect(receipt.findings.some((f) => f.code === 'stale_assertion')).toBe(true);
    const reason = formatProjectStateClosureBlockReason(receipt);
    expect(reason).toMatch(/project-state closure blocked before push/);
    expect(reason).toMatch(/status/);
    expect(reason).toMatch(/PROJECT_STATUS\.md/);
    expect(reason).toMatch(/Mark Status and Backlog/);
    expect(reason).toMatch(/base=aaaaaaaaaaaa/);
    expect(reason).toMatch(/policy=dddddddddddd/);
    // No host paths in receipt.
    expect(reason).not.toMatch(/\/home\//);
    expect(formatProjectStateClosureReceipt(receipt)).toMatch(/distinct from code verification/);
  });

  it('passes when declared state is updated', () => {
    const contract = sampleContract();
    const receipt = evaluateProjectStateClosure({
      contract,
      task: { id: 'T1', labels: ['onboarding'] },
      surfaceContents: new Map([
        ['status', '# Status\nonboarding complete\n'],
        ['backlog', '# Backlog\nonboarding complete\n'],
      ]),
      provenance: PROV,
    });
    expect(receipt.ok).toBe(true);
    expect(receipt.status).toBe('passed');
    expect(receipt.findings).toEqual([]);
  });

  it('is not applicable for tasks outside rule labels (preserves ordinary merges)', () => {
    const contract = sampleContract();
    const receipt = evaluateProjectStateClosure({
      contract,
      task: { id: 'T2', labels: ['docs'] },
      surfaceContents: new Map([['status', 'onboarding incomplete']]),
      provenance: PROV,
    });
    expect(receipt.ok).toBe(true);
    expect(receipt.status).toBe('not_applicable');
    expect(receipt.applicable).toBe(false);
  });

  it('fails when declared surface is missing', () => {
    const contract = sampleContract();
    const receipt = evaluateProjectStateClosure({
      contract,
      task: { id: 'T1', labels: ['onboarding'] },
      surfaceContents: new Map([
        ['status', null],
        ['backlog', 'onboarding complete'],
      ]),
      provenance: PROV,
    });
    expect(receipt.ok).toBe(false);
    expect(receipt.findings[0]?.code).toBe('surface_missing');
  });
});

describe('projectStateClosure receipt durability', () => {
  it('round-trips embedded receipt (restart/reconnect survival)', () => {
    const contract = sampleContract();
    const receipt = evaluateProjectStateClosure({
      contract,
      task: { id: 'T1', labels: ['onboarding'] },
      surfaceContents: new Map([
        ['status', 'onboarding incomplete'],
        ['backlog', 'onboarding incomplete'],
      ]),
      provenance: PROV,
    });
    const body = upsertProjectStateClosureReceiptBody('## Task\n\nwork\n', receipt);
    const parsed = parseProjectStateClosureReceiptFromBody(body);
    expect(parsed).not.toBeNull();
    expect(parsed!.status).toBe('failed');
    expect(parsed!.provenance).toEqual(PROV);
    expect(parsed!.findings.length).toBeGreaterThan(0);
    // Re-upsert replaces rather than duplicates.
    const again = upsertProjectStateClosureReceiptBody(body, {
      ...receipt,
      status: 'passed',
      ok: true,
      findings: [],
      summary: 'now ok',
    });
    expect(again.match(/## Project-state closure/g)?.length).toBe(1);
    expect(again).toContain('hercules-project-state-closure-begin:v1');
    expect(again).toContain('hercules-project-state-closure-end:v1');
    expect((again.match(/hercules-project-state-closure-begin:v1/g) ?? []).length).toBe(1);
    expect((again.match(/hercules-project-state-closure-end:v1/g) ?? []).length).toBe(1);
    expect(parseProjectStateClosureReceiptFromBody(again)?.status).toBe('passed');
    expect(encodeProjectStateClosureReceiptBlock(receipt)).toContain(
      'hercules-project-state-closure:v1',
    );
  });

  it('preserves user same-named section', () => {
    const receipt = evaluateProjectStateClosure({
      contract: sampleContract(),
      task: { id: 'T1', labels: ['onboarding'] },
      surfaceContents: new Map([
        ['status', 'onboarding incomplete'],
        ['backlog', 'onboarding incomplete'],
      ]),
      provenance: PROV,
    });
    const nl = String.fromCharCode(10);
    const userBody =
      '## Project-state closure' + nl + nl +
      'Operator notes: keep this.' + nl + nl +
      '## Acceptance criteria' + nl + nl +
      'Do not drop this section.' + nl;
    const withReceipt = upsertProjectStateClosureReceiptBody(userBody, receipt);
    expect(withReceipt).toContain('Operator notes: keep this.');
    expect(withReceipt).toContain('## Acceptance criteria');
    expect(withReceipt).toContain('Do not drop this section.');
    expect((withReceipt.match(/## Project-state closure/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(parseProjectStateClosureReceiptFromBody(withReceipt)?.status).toBe('failed');
    const again = upsertProjectStateClosureReceiptBody(withReceipt, {
      ...receipt,
      status: 'passed',
      ok: true,
      findings: [],
      summary: 'now ok',
    });
    expect(again).toContain('Operator notes: keep this.');
    expect(again).toContain('## Acceptance criteria');
    expect(again).toContain('Do not drop this section.');
    expect(parseProjectStateClosureReceiptFromBody(again)?.status).toBe('passed');
    expect((again.match(/<!-- hercules-project-state-closure:v1/g) ?? []).length).toBe(1);
  });

  it('preserves trailing user same-named section on re-upsert', () => {
    const receipt = evaluateProjectStateClosure({
      contract: sampleContract(),
      task: { id: 'T1', labels: ['onboarding'] },
      surfaceContents: new Map([
        ['status', 'onboarding complete'],
        ['backlog', 'onboarding complete'],
      ]),
      provenance: PROV,
    });
    const nl = String.fromCharCode(10);
    const seed = upsertProjectStateClosureReceiptBody(
      '## Task' + nl + nl + 'Implement closure.' + nl,
      receipt,
    );
    const bodyWithTrailing =
      seed.trimEnd() + nl + nl +
      '## Project-state closure' + nl + nl +
      'Human follow-up: keep this paragraph for audit.' + nl + nl +
      '## Next steps' + nl + nl +
      'Ship it.' + nl;
    const updated = upsertProjectStateClosureReceiptBody(bodyWithTrailing, {
      ...receipt,
      status: 'failed',
      ok: false,
      summary: 're-evaluated fail',
      findings: [],
    });
    expect(updated).toContain('Human follow-up: keep this paragraph for audit.');
    expect(updated).toContain('## Next steps');
    expect(updated).toContain('Ship it.');
    expect(updated).toContain('Implement closure.');
    expect(parseProjectStateClosureReceiptFromBody(updated)?.status).toBe('failed');
    expect((updated.match(/<!-- hercules-project-state-closure:v1/g) ?? []).length).toBe(1);
  });

  it('parses only the Hercules-owned structured receipt block', () => {
    const receipt = evaluateProjectStateClosure({
      contract: sampleContract(),
      task: { id: 'T1', labels: ['onboarding'] },
      surfaceContents: new Map([
        ['status', 'onboarding complete'],
        ['backlog', 'onboarding complete'],
      ]),
      provenance: PROV,
    });
    const nl = String.fromCharCode(10);
    const decoy =
      '## Project-state closure' + nl + nl +
      'User prose that is not a receipt.' + nl + nl +
      '<!-- not-a-hercules-receipt -->' + nl;
    const body = upsertProjectStateClosureReceiptBody(decoy, receipt);
    const parsed = parseProjectStateClosureReceiptFromBody(body);
    expect(parsed).not.toBeNull();
    expect(parsed!.status).toBe('passed');
    expect(parsed!.ok).toBe(true);
    expect(parsed!.provenance.mergeTreeSha).toBe(PROV.mergeTreeSha);
    expect(body).toContain('User prose that is not a receipt.');
  });

  it('migrates legacy heading-plus-block receipts without wiping following text', () => {
    const receipt = evaluateProjectStateClosure({
      contract: sampleContract(),
      task: { id: 'T1', labels: ['onboarding'] },
      surfaceContents: new Map([
        ['status', 'onboarding complete'],
        ['backlog', 'onboarding complete'],
      ]),
      provenance: PROV,
    });
    const nl = String.fromCharCode(10);
    const legacy =
      '## Intro' + nl + nl +
      'Keep intro.' + nl + nl +
      formatProjectStateClosureReceipt(receipt).trimEnd() + nl + nl +
      encodeProjectStateClosureReceiptBlock(receipt) + nl + nl +
      '## After receipt' + nl + nl +
      'Keep after.' + nl;
    const updated = upsertProjectStateClosureReceiptBody(legacy, {
      ...receipt,
      summary: 're-stamped',
    });
    expect(updated).toContain('Keep intro.');
    expect(updated).toContain('Keep after.');
    expect(updated).toContain('hercules-project-state-closure-begin:v1');
    expect((updated.match(/<!-- hercules-project-state-closure:v1/g) ?? []).length).toBe(1);
    expect(parseProjectStateClosureReceiptFromBody(updated)?.summary).toBe('re-stamped');
  });

  it('canonical form is stable for policy digest (digest key order)', () => {
    const a = projectStateClosureCanonical(sampleContract());
    const b = projectStateClosureCanonical(sampleContract());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('deriveDeliveryPipelineStages', () => {
  it('keeps verification, merge eligibility, closure, and deployment separate', () => {
    // Verified + done + unmerged + contract present + no deploy.
    const stages = deriveDeliveryPipelineStages({
      verifiedSha: 'abc',
      state: 'done',
      mergedSha: null,
      projectStateClosureStatus: null,
      hasClosureContract: true,
      hasDeployPolicy: false,
    });
    expect(stages.verification).toBe('passed');
    expect(stages.mergeEligibility).toBe('eligible');
    expect(stages.projectStateClosure).toBe('pending');
    expect(stages.deployment).toBe('not_applicable');

    // Merge alone must not claim closure complete.
    const mergedOnly = deriveDeliveryPipelineStages({
      verifiedSha: 'abc',
      state: 'done',
      mergedSha: 'def',
      projectStateClosureStatus: null,
      hasClosureContract: true,
      hasDeployPolicy: true,
      stagingStatus: 'ready',
      productionSha: null,
    });
    expect(mergedOnly.mergeEligibility).toBe('merged');
    expect(mergedOnly.projectStateClosure).toBe('pending');
    expect(mergedOnly.deployment).toBe('ready');

    // No contract → closure not required.
    const noContract = deriveDeliveryPipelineStages({
      verifiedSha: 'abc',
      state: 'done',
      hasClosureContract: false,
      hasDeployPolicy: false,
    });
    expect(noContract.projectStateClosure).toBe('not_applicable');
  });
});
