import { describe, expect, it } from 'vitest';
import {
  canonicalizeProtectedPathsSnapshot,
  decidePathLeaseAcquire,
  decidePathLeaseRelease,
  effectivePathWriterLimit,
  formatPathLeaseBlockMessage,
  isFirstTimeWorkflowBootstrap,
  normalizeAffectedPaths,
  normalizeConfiguredWorkflowPath,
  normalizePathDeclaration,
  outOfScopeDiffGate,
  pathInScope,
  pathLeasePolicyFor,
  reclaimStalePathLeases,
  scopesOverlap,
  validateDiffAgainstScopes,
  verifyWorkflowBootstrapCandidate,
  workflowBootstrapGate,
  type PathLeaseEntry,
  type PathScope,
  type WorkflowBootstrapEligibilityInput,
} from '../../src/domain/taskPathLease.js';

const BASE = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const TOKEN_A = 'run-token-a';
const TOKEN_B = 'run-token-b';

function entry(over: Partial<PathLeaseEntry> & Pick<PathLeaseEntry, 'taskId' | 'runToken'>): PathLeaseEntry {
  return {
    baseRevision: BASE,
    scopes: [{ kind: 'exact', path: 'src/a.ts' }],
    protectedPathsSnapshot: [],
    acquiredAtMs: 1,
    ...over,
  };
}

describe('normalizePathDeclaration', () => {
  it('classifies exact files and directory subtrees', () => {
    expect(normalizePathDeclaration('src/foo.ts')).toEqual({
      ok: true,
      scope: { kind: 'exact', path: 'src/foo.ts' },
    });
    expect(normalizePathDeclaration('src/domain/')).toEqual({
      ok: true,
      scope: { kind: 'subtree', path: 'src/domain' },
    });
    expect(normalizePathDeclaration('src/domain/**')).toEqual({
      ok: true,
      scope: { kind: 'subtree', path: 'src/domain' },
    });
    expect(normalizePathDeclaration('./src/foo.ts')).toEqual({
      ok: true,
      scope: { kind: 'exact', path: 'src/foo.ts' },
    });
  });

  it('rejects absolute, traversal, empty, and ambiguous whole-repo scopes', () => {
    for (const bad of [
      '',
      '   ',
      '/',
      '/abs',
      '../x',
      'a/../b',
      '**',
      '/**',
      'src/*/foo.ts',
      'src/**/x.ts',
      'C:/windows',
      'https://example.com/x',
    ]) {
      expect(normalizePathDeclaration(bad).ok).toBe(false);
    }
  });
});

describe('normalizeAffectedPaths', () => {
  it('rejects internal overlaps as ambiguous', () => {
    const r = normalizeAffectedPaths(['src/a.ts', 'src/']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/overlap/i);
  });

  it('accepts disjoint scopes in canonical order', () => {
    const r = normalizeAffectedPaths(['src/b.ts', 'src/a.ts']);
    expect(r).toEqual({
      ok: true,
      scopes: [
        { kind: 'exact', path: 'src/a.ts' },
        { kind: 'exact', path: 'src/b.ts' },
      ],
    });
  });
});

describe('scopesOverlap + pathInScope', () => {
  const exactA: PathScope = { kind: 'exact', path: 'src/a.ts' };
  const exactB: PathScope = { kind: 'exact', path: 'src/b.ts' };
  const subSrc: PathScope = { kind: 'subtree', path: 'src' };
  const subDom: PathScope = { kind: 'subtree', path: 'src/domain' };

  it('detects exact/subtree overlap semantics', () => {
    expect(scopesOverlap(exactA, exactA)).toBe(true);
    expect(scopesOverlap(exactA, exactB)).toBe(false);
    expect(scopesOverlap(exactA, subSrc)).toBe(true);
    expect(scopesOverlap(subDom, subSrc)).toBe(true);
    expect(scopesOverlap(subDom, { kind: 'subtree', path: 'test' })).toBe(false);
  });

  it('matches concrete files against scopes', () => {
    expect(pathInScope('src/a.ts', exactA)).toBe(true);
    expect(pathInScope('src/a.ts', exactB)).toBe(false);
    expect(pathInScope('src/domain/x.ts', subDom)).toBe(true);
    expect(pathInScope('src/domain', subDom)).toBe(true);
    expect(pathInScope('src/other.ts', subDom)).toBe(false);
  });
});

describe('decidePathLeaseAcquire', () => {
  const baseInput = {
    taskId: 'T1',
    runToken: TOKEN_A,
    declaredBaseRevision: BASE,
    declaredPaths: ['src/a.ts'] as readonly string[],
    declaredProtectedSnapshot: [] as readonly string[],
    trustedBaseRevision: BASE,
    currentProtectedPaths: [] as readonly string[],
    held: [] as readonly PathLeaseEntry[],
    maxWriters: 2,
    requireDeclarations: true,
    acquiredAtMs: 10,
  };

  it('acquires when base is current, scopes disjoint, under writer limit', () => {
    const v = decidePathLeaseAcquire(baseInput);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.entry.taskId).toBe('T1');
    expect(v.entry.scopes).toEqual([{ kind: 'exact', path: 'src/a.ts' }]);
    expect(v.nextHeld).toHaveLength(1);
  });

  it('blocks stale base before any agent run', () => {
    const v = decidePathLeaseAcquire({
      ...baseInput,
      trustedBaseRevision: OTHER,
    });
    expect(v).toMatchObject({ ok: false, reason: 'stale_base' });
  });

  it('names planned_base_revision when rejecting an invalid planned SHA', () => {
    const v = decidePathLeaseAcquire({
      ...baseInput,
      declaredBaseRevision: 'abc123',
    });
    expect(v).toMatchObject({
      ok: false,
      reason: 'invalid_base',
      detail: 'planned_base_revision must be a full 40-char commit SHA',
    });
  });

  it('blocks overlapping exact/subtree scopes', () => {
    const held = [
      entry({
        taskId: 'OTHER',
        runToken: TOKEN_B,
        scopes: [{ kind: 'subtree', path: 'src' }],
      }),
    ];
    const v = decidePathLeaseAcquire({ ...baseInput, held, maxWriters: 4 });
    expect(v).toMatchObject({ ok: false, reason: 'path_overlap' });
    if (v.ok) return;
    expect(v.conflictingTaskIds).toContain('OTHER');
  });

  it('allows disjoint scopes up to the configured writer limit', () => {
    const held = [
      entry({
        taskId: 'OTHER',
        runToken: TOKEN_B,
        scopes: [{ kind: 'exact', path: 'docs/x.md' }],
      }),
    ];
    const ok = decidePathLeaseAcquire({
      ...baseInput,
      held,
      maxWriters: 2,
      declaredPaths: ['src/a.ts'],
    });
    expect(ok.ok).toBe(true);

    const limited = decidePathLeaseAcquire({
      ...baseInput,
      held,
      maxWriters: 1,
      declaredPaths: ['src/a.ts'],
    });
    expect(limited).toMatchObject({ ok: false, reason: 'writer_limit' });
  });

  it('blocks ambiguous declaration scopes', () => {
    const v = decidePathLeaseAcquire({
      ...baseInput,
      declaredPaths: ['src/a.ts', 'src/'],
    });
    expect(v).toMatchObject({ ok: false, reason: 'ambiguous_scope' });
  });

  it('blocks protected-path drift against the declaration snapshot', () => {
    const v = decidePathLeaseAcquire({
      ...baseInput,
      declaredProtectedSnapshot: ['WORKFLOW.md'],
      currentProtectedPaths: ['WORKFLOW.md', 'secrets/**'],
    });
    expect(v).toMatchObject({ ok: false, reason: 'protected_path_drift' });
  });

  it('holds legacy tasks under Guardian requireDeclarations', () => {
    const v = decidePathLeaseAcquire({
      ...baseInput,
      declaredBaseRevision: undefined,
      declaredPaths: undefined,
      declaredProtectedSnapshot: undefined,
      requireDeclarations: true,
    });
    expect(v).toMatchObject({ ok: false, reason: 'missing_declaration' });
  });

  it('rejects a partial declaration even under compatible policy', () => {
    const v = decidePathLeaseAcquire({
      ...baseInput,
      declaredProtectedSnapshot: undefined,
      requireDeclarations: false,
    });
    expect(v).toMatchObject({ ok: false, reason: 'missing_declaration' });
  });

  it('allows legacy no-op under compatible policy without declarations', () => {
    const v = decidePathLeaseAcquire({
      ...baseInput,
      declaredBaseRevision: undefined,
      declaredPaths: undefined,
      declaredProtectedSnapshot: undefined,
      requireDeclarations: false,
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.nextHeld).toEqual([]);
  });

  it('distinguishes a prior same-task run from malformed token reuse', () => {
    const held = [entry({ taskId: 'T1', runToken: TOKEN_A })];
    expect(
      decidePathLeaseAcquire({
        ...baseInput,
        held,
        runToken: TOKEN_B,
        taskId: 'T1',
      }),
    ).toMatchObject({
      ok: false,
      reason: 'prior_run_held',
      conflictingTaskIds: ['T1'],
    });

    expect(
      decidePathLeaseAcquire({
        ...baseInput,
        held,
        taskId: 'T2',
        runToken: TOKEN_A,
        declaredPaths: ['docs/y.md'],
      }),
    ).toMatchObject({ ok: false, reason: 'token_conflict' });
  });
});

describe('decidePathLeaseRelease + reclaimStalePathLeases', () => {
  it('releases only for the owning run token', () => {
    const held = [entry({ taskId: 'T1', runToken: TOKEN_A })];
    const bad = decidePathLeaseRelease({ held, taskId: 'T1', runToken: TOKEN_B });
    expect(bad).toMatchObject({ ok: false, reason: 'token_mismatch' });

    const ok = decidePathLeaseRelease({ held, taskId: 'T1', runToken: TOKEN_A });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.nextHeld).toEqual([]);
  });

  it('reclaims only stale owners; never steals live tokens', () => {
    const held = [
      entry({ taskId: 'LIVE', runToken: TOKEN_A }),
      entry({
        taskId: 'DEAD',
        runToken: TOKEN_B,
        scopes: [{ kind: 'exact', path: 'docs/x.md' }],
      }),
    ];
    const r = reclaimStalePathLeases({
      held,
      liveRunTokens: new Set([TOKEN_A]),
      ownerProcessAlive: () => false,
    });
    expect(r.reclaimed.map((e) => e.taskId)).toEqual(['DEAD']);
    expect(r.nextHeld.map((e) => e.taskId)).toEqual(['LIVE']);
  });
});

describe('validateDiffAgainstScopes', () => {
  it('fails actual out-of-scope diffs before review/merge', () => {
    const scopes: PathScope[] = [{ kind: 'subtree', path: 'src/domain' }];
    expect(validateDiffAgainstScopes(['src/domain/x.ts'], scopes)).toEqual({ ok: true });
    const bad = validateDiffAgainstScopes(['src/domain/x.ts', 'README.md'], scopes);
    expect(bad).toEqual({ ok: false, outOfScope: ['README.md'] });
    const gate = outOfScopeDiffGate(['README.md']);
    expect(gate.passed).toBe(false);
    expect(gate.name).toBe('path-lease-scope');
  });

  it('fails closed for touched paths with leading, trailing, or newline whitespace', () => {
    const scopes: PathScope[] = [{ kind: 'exact', path: 'src/allowed.ts' }];
    expect(validateDiffAgainstScopes([' src/allowed.ts'], scopes)).toEqual({
      ok: false,
      outOfScope: [' src/allowed.ts'],
    });
    expect(validateDiffAgainstScopes(['src/allowed.ts '], scopes)).toEqual({
      ok: false,
      outOfScope: ['src/allowed.ts '],
    });
    expect(validateDiffAgainstScopes(['src/allowed.ts\n'], scopes)).toEqual({
      ok: false,
      outOfScope: ['src/allowed.ts\n'],
    });
  });

  it('JSON-quotes control characters in path evidence', () => {
    const gate = outOfScopeDiffGate(['evil\n## injected.md']);
    expect(gate.output).toContain('"evil\\n## injected.md"');
    expect(gate.output).not.toContain('\n');
  });
});

describe('pathLeasePolicyFor', () => {
  it('forces single-writer + required declarations for Guardian', () => {
    expect(pathLeasePolicyFor({ profile: 'guardian' })).toEqual({
      requireDeclarations: true,
      maxWritersCap: 1,
    });
    expect(effectivePathWriterLimit(4, pathLeasePolicyFor({ profile: 'guardian' }))).toBe(1);
    expect(effectivePathWriterLimit(4, pathLeasePolicyFor({ profile: 'compatible' }))).toBe(4);
  });
});

describe('helpers', () => {
  it('canonicalizes protected path snapshots and formats block messages', () => {
    expect(canonicalizeProtectedPathsSnapshot(['b', 'a', 'a'])).toEqual(['a', 'b']);
    expect(formatPathLeaseBlockMessage('stale_base', 'detail')).toMatch(/Stale base/);
  });
});

function bootstrapInput(
  over: Partial<WorkflowBootstrapEligibilityInput> = {},
): WorkflowBootstrapEligibilityInput {
  return {
    trustedRevision: BASE,
    workflowContent: null,
    repoReadiness: 'incomplete',
    labels: ['onboarding', 'readiness'],
    plannedBaseRevision: BASE,
    affectedPaths: ['WORKFLOW.md'],
    protectedPathsSnapshot: [],
    configuredWorkflowPath: 'WORKFLOW.md',
    ...over,
  };
}

describe('isFirstTimeWorkflowBootstrap', () => {
  it('accepts the bounded first-time one-file WORKFLOW contract', () => {
    expect(isFirstTimeWorkflowBootstrap(bootstrapInput())).toBe(true);
    expect(
      isFirstTimeWorkflowBootstrap(bootstrapInput({ labels: ['readiness'] })),
    ).toBe(true);
    expect(
      isFirstTimeWorkflowBootstrap(
        bootstrapInput({
          configuredWorkflowPath: './WORKFLOW.md',
          affectedPaths: ['WORKFLOW.md'],
        }),
      ),
    ).toBe(true);
  });

  it('rejects stale base, wrong or broader paths, and nonempty snapshots', () => {
    expect(
      isFirstTimeWorkflowBootstrap(bootstrapInput({ plannedBaseRevision: OTHER })),
    ).toBe(false);
    expect(
      isFirstTimeWorkflowBootstrap(
        bootstrapInput({ affectedPaths: ['docs/WORKFLOW.md'] }),
      ),
    ).toBe(false);
    expect(
      isFirstTimeWorkflowBootstrap(
        bootstrapInput({ affectedPaths: ['WORKFLOW.md', 'AGENTS.md'] }),
      ),
    ).toBe(false);
    expect(
      isFirstTimeWorkflowBootstrap(bootstrapInput({ affectedPaths: ['src/'] })),
    ).toBe(false);
    expect(
      isFirstTimeWorkflowBootstrap(
        bootstrapInput({ protectedPathsSnapshot: ['scripts/deploy-*.sh'] }),
      ),
    ).toBe(false);
  });

  it('rejects an existing workflow, wrong labels, and ready repos', () => {
    expect(
      isFirstTimeWorkflowBootstrap(
        bootstrapInput({ workflowContent: '---\ngates: {}\n---\nbody\n' }),
      ),
    ).toBe(false);
    expect(
      isFirstTimeWorkflowBootstrap(bootstrapInput({ workflowContent: '' })),
    ).toBe(false);
    expect(isFirstTimeWorkflowBootstrap(bootstrapInput({ labels: ['feature'] }))).toBe(
      false,
    );
    expect(isFirstTimeWorkflowBootstrap(bootstrapInput({ labels: [] }))).toBe(false);
    expect(
      isFirstTimeWorkflowBootstrap(bootstrapInput({ repoReadiness: 'ready' })),
    ).toBe(false);
  });

  it('rejects malformed or incomplete declarations and invalid tips', () => {
    expect(
      isFirstTimeWorkflowBootstrap(bootstrapInput({ trustedRevision: 'notasha' })),
    ).toBe(false);
    expect(
      isFirstTimeWorkflowBootstrap(
        bootstrapInput({ plannedBaseRevision: undefined }),
      ),
    ).toBe(false);
    expect(
      isFirstTimeWorkflowBootstrap(bootstrapInput({ affectedPaths: undefined })),
    ).toBe(false);
    expect(
      isFirstTimeWorkflowBootstrap(
        bootstrapInput({ protectedPathsSnapshot: undefined }),
      ),
    ).toBe(false);
    expect(
      isFirstTimeWorkflowBootstrap(
        bootstrapInput({ configuredWorkflowPath: '../evil.md' }),
      ),
    ).toBe(false);
  });
});

describe('normalizeConfiguredWorkflowPath', () => {
  it('normalizes exact workflow paths and rejects unsafe ones', () => {
    expect(normalizeConfiguredWorkflowPath('WORKFLOW.md')).toBe('WORKFLOW.md');
    expect(normalizeConfiguredWorkflowPath('./WORKFLOW.md')).toBe('WORKFLOW.md');
    expect(normalizeConfiguredWorkflowPath('/WORKFLOW.md')).toBe('WORKFLOW.md');
    expect(normalizeConfiguredWorkflowPath('../x')).toBeNull();
    expect(normalizeConfiguredWorkflowPath('')).toBeNull();
  });
});

describe('verifyWorkflowBootstrapCandidate', () => {
  const parseOk = (): string | null => null;
  const parseBad = (): string | null => 'missing front matter';

  it('proves an exact one-path candidate parses without executing commands', () => {
    const verdict = verifyWorkflowBootstrapCandidate({
      eligible: true,
      configuredWorkflowPath: 'WORKFLOW.md',
      filesTouched: ['WORKFLOW.md'],
      candidateContent: '---\ngates: {}\n---\n',
      parseCandidate: parseOk,
    });
    expect(verdict).toEqual({ ok: true, workflowPath: 'WORKFLOW.md' });
    expect(workflowBootstrapGate(verdict).passed).toBe(true);
    expect(workflowBootstrapGate(verdict).output).toMatch(/not executed/);
  });

  it('fails broader diffs, missing content, malformed candidates, and ineligibility', () => {
    expect(
      verifyWorkflowBootstrapCandidate({
        eligible: true,
        configuredWorkflowPath: 'WORKFLOW.md',
        filesTouched: ['WORKFLOW.md', 'src/a.ts'],
        candidateContent: '---\ngates: {}\n---\n',
        parseCandidate: parseOk,
      }).ok,
    ).toBe(false);
    expect(
      verifyWorkflowBootstrapCandidate({
        eligible: true,
        configuredWorkflowPath: 'WORKFLOW.md',
        filesTouched: ['WORKFLOW.md'],
        candidateContent: null,
        parseCandidate: parseOk,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_candidate' });
    expect(
      verifyWorkflowBootstrapCandidate({
        eligible: true,
        configuredWorkflowPath: 'WORKFLOW.md',
        filesTouched: ['WORKFLOW.md'],
        candidateContent: 'not yaml',
        parseCandidate: parseBad,
      }),
    ).toMatchObject({ ok: false, reason: 'malformed_candidate' });
    expect(
      verifyWorkflowBootstrapCandidate({
        eligible: false,
        configuredWorkflowPath: 'WORKFLOW.md',
        filesTouched: ['WORKFLOW.md'],
        candidateContent: '---\ngates: {}\n---\n',
        parseCandidate: parseOk,
      }),
    ).toMatchObject({ ok: false, reason: 'not_bootstrap' });
  });
});
