/**
 * Gate-fail attribution (pure domain): trunk-inherited vs branch-introduced.
 * Case study 2026-07-30 — held-out red on main must not burn task attempts.
 */
import { describe, it, expect } from 'vitest';
import {
  isAttributableGate,
  extractFailedTestIds,
  attributionCacheKey,
  buildMinimalRerunCommand,
  relatedPathHints,
  filesTouchingRelated,
  classifyGateFailAttribution,
  formatGateFailAttributionMarkdown,
  isTrunkInherited,
  bodyHasTrunkInheritedGateFail,
  TRUNK_INHERITED_MARKER,
  type BaseTestResult,
} from '../../src/domain/gateFailAttribution.js';
import {
  buildDodDimensions,
  parseDefinitionOfDone,
  shouldAutoRework,
  isAutomatedGreen,
} from '../../src/domain/acceptance.js';
import { aggregateMechanicalStatus } from '../../src/domain/mechProof.js';

const CARGO_HELD_OUT = `
running 12 tests
test structural_guards::expected_mcp_pseudo_tool_count ... FAILED

failures:

---- structural_guards::expected_mcp_pseudo_tool_count stdout ----
assertion failed: EXPECTED_MCP_PSEUDO_TOOL_COUNT

failures:
    structural_guards::expected_mcp_pseudo_tool_count

test result: FAILED. 11 passed; 1 failed
`;

const VITEST_FAIL = `
 ❯ test/invariants/report-hygiene.test.ts (3)
   × rejects polluted final messages 12ms
   ✓ ok

 FAIL  test/invariants/report-hygiene.test.ts > rejects polluted final messages
AssertionError: expected 1 to be 0
`;

describe('isAttributableGate', () => {
  it('only test + held-out-smoke (not setup/build/typecheck/lint)', () => {
    expect(isAttributableGate('test')).toBe(true);
    expect(isAttributableGate('held-out-smoke')).toBe(true);
    expect(isAttributableGate('setup')).toBe(false);
    expect(isAttributableGate('build')).toBe(false);
    expect(isAttributableGate('typecheck')).toBe(false);
    expect(isAttributableGate('lint')).toBe(false);
    expect(isAttributableGate('behavioral')).toBe(false);
  });
});

describe('extractFailedTestIds', () => {
  it('extracts cargo failures: summary names', () => {
    expect(extractFailedTestIds(CARGO_HELD_OUT)).toEqual([
      'structural_guards::expected_mcp_pseudo_tool_count',
    ]);
  });

  it('extracts vitest FAIL lines', () => {
    const ids = extractFailedTestIds(VITEST_FAIL);
    expect(ids.some((id) => id.includes('report-hygiene') || id.includes('polluted'))).toBe(
      true,
    );
  });

  it('extracts jest ● lines', () => {
    const out = `
FAIL src/foo.test.js
  ● Foo suite › does the thing

    expect(true).toBe(false)
`;
    expect(extractFailedTestIds(out)).toContain('Foo suite › does the thing');
  });
});

describe('attributionCacheKey', () => {
  it('is stable per (repo, merge-base, test)', () => {
    const a = attributionCacheKey('orbit', 'abc123def456', 'mod::t');
    const b = attributionCacheKey('Orbit', 'ABC123def456', 'mod::t');
    expect(a).toBe(b);
    expect(attributionCacheKey('orbit', 'abc123def456', 'other')).not.toBe(a);
  });
});

describe('buildMinimalRerunCommand', () => {
  it('adds vitest -t filter (not full suite)', () => {
    const cmd = buildMinimalRerunCommand(
      'pnpm exec vitest run test/invariants --config vitest.unit.config.ts',
      ['rejects polluted final messages'],
    );
    expect(cmd).toMatch(/vitest/);
    expect(cmd).toMatch(/-t/);
    expect(cmd).toMatch(/polluted/);
    expect(cmd).not.toMatch(/pnpm test$/);
  });

  it('builds cargo exact filter for a single failure', () => {
    const cmd = buildMinimalRerunCommand('cargo test --workspace', [
      'structural_guards::expected_mcp_pseudo_tool_count',
    ]);
    expect(cmd).toMatch(/cargo test/);
    expect(cmd).toContain('structural_guards::expected_mcp_pseudo_tool_count');
    expect(cmd).toMatch(/--exact/);
  });

  it('returns null when no failed tests (never full-suite fallback)', () => {
    expect(buildMinimalRerunCommand('pnpm test', [])).toBeNull();
  });
});

describe('related path evidence', () => {
  it('hints modules from cargo test path; detects untouched branch', () => {
    const hints = relatedPathHints(['structural_guards::expected_mcp_pseudo_tool_count']);
    expect(hints).toContain('structural_guards');
    const touched = filesTouchingRelated(
      ['src/web/App.tsx', 'src/web/foo.ts'],
      hints,
    );
    expect(touched).toEqual([]);
  });

  it('detects when branch did touch related paths', () => {
    const hints = relatedPathHints(['memory::tests::circuit_breaker']);
    const touched = filesTouchingRelated(
      ['src/memory/mod.rs', 'src/web/App.tsx'],
      hints,
    );
    expect(touched).toContain('src/memory/mod.rs');
  });
});

function baseResults(
  rows: readonly { id: string; failed: boolean; cache?: boolean }[],
): BaseTestResult[] {
  return rows.map((r) => ({
    testId: r.id,
    failedOnBase: r.failed,
    fromCache: r.cache === true,
  }));
}

describe('classifyGateFailAttribution', () => {
  const testId = 'structural_guards::expected_mcp_pseudo_tool_count';

  it('reproduced on merge-base → trunk_inherited + note; cache hits recorded', () => {
    const report = classifyGateFailAttribution({
      gateName: 'held-out-smoke',
      originalCommand: 'cargo test -p guards',
      mergeBase: '7dbb9a39aabbccdd',
      failedTests: [testId],
      baseResults: baseResults([{ id: testId, failed: true, cache: true }]),
      filesTouched: ['src/web/App.tsx', 'src/web/Evidence.tsx'],
      rerunCommand: 'cargo test structural_guards::expected_mcp_pseudo_tool_count -- --exact',
    });
    expect(report.outcome).toBe('trunk_inherited');
    expect(isTrunkInherited(report)).toBe(true);
    expect(report.cacheHits).toEqual([testId]);
    expect(report.relatedTouched).toEqual([]);
    expect(report.note).toContain(TRUNK_INHERITED_MARKER);
    expect(report.note).toMatch(/merge-base 7dbb9a39aabb/);
    expect(report.note).toMatch(/未触碰相关路径|filesTouched/);
  });

  it('not reproduced → branch_introduced (behavior unchanged path)', () => {
    const report = classifyGateFailAttribution({
      gateName: 'test',
      originalCommand: 'pnpm test',
      mergeBase: 'aaaaaaaaaaaa',
      failedTests: ['suite > my break'],
      baseResults: baseResults([{ id: 'suite > my break', failed: false }]),
      filesTouched: ['src/foo.ts'],
      rerunCommand: "pnpm exec vitest run -t 'suite > my break'",
    });
    expect(report.outcome).toBe('branch_introduced');
    expect(isTrunkInherited(report)).toBe(false);
    expect(report.novelTests).toEqual(['suite > my break']);
  });

  it('any novel failure among many → branch_introduced (no free ride)', () => {
    const report = classifyGateFailAttribution({
      gateName: 'test',
      originalCommand: 'cargo test',
      mergeBase: 'bbbbbbbbbbbb',
      failedTests: ['a::one', 'b::two'],
      baseResults: baseResults([
        { id: 'a::one', failed: true },
        { id: 'b::two', failed: false },
      ]),
      filesTouched: ['src/x.rs'],
      rerunCommand: 'cargo test a::one|b::two',
    });
    expect(report.outcome).toBe('branch_introduced');
    expect(report.reproducedTests).toEqual(['a::one']);
    expect(report.novelTests).toEqual(['b::two']);
  });

  it('probe failed / no names → inconclusive (never pretend trunk)', () => {
    const report = classifyGateFailAttribution({
      gateName: 'test',
      originalCommand: 'pnpm test',
      mergeBase: 'cccccccccccc',
      failedTests: [],
      baseResults: [],
      filesTouched: [],
      rerunCommand: null,
      probeFailed: true,
      probeError: 'checkout failed',
    });
    expect(report.outcome).toBe('inconclusive');
    expect(isTrunkInherited(report)).toBe(false);
  });
});

describe('formatGateFailAttributionMarkdown', () => {
  it('renders the required trunk warning for packet / human scan', () => {
    const report = classifyGateFailAttribution({
      gateName: 'held-out-smoke',
      originalCommand: 'cargo test',
      mergeBase: '7dbb9a39deadbeef',
      failedTests: ['structural_guards::count'],
      baseResults: baseResults([{ id: 'structural_guards::count', failed: true }]),
      filesTouched: ['web/a.tsx'],
      rerunCommand: 'cargo test structural_guards::count -- --exact',
    });
    const md = formatGateFailAttributionMarkdown(report).join('\n');
    expect(md).toContain('⚠');
    expect(md).toContain(TRUNK_INHERITED_MARKER);
    expect(md).toMatch(/merge-base `7dbb9a39dead`/);
    expect(md).toMatch(/skipped|不 auto-rework|修主干/);
  });
});

describe('DoD + auto-rework when trunk-inherited', () => {
  it('reproduced → mechanical skipped + no auto-rework; not automated-green', () => {
    // Mirrors packet assembly: trunk inheritance marks mechanical skipped.
    const dims = {
      mechanical: 'skipped' as const,
      reviewer: 'n/a' as const,
      human: 'pending' as const,
      criteria: [
        {
          text: 'pnpm check:full green',
          kind: 'mechanical' as const,
          status: 'skipped' as const,
          proof: 'trunk-inherited skip',
        },
      ],
      warnings: [TRUNK_INHERITED_MARKER],
    };
    expect(shouldAutoRework({ dimensions: dims, noFileChanges: false })).toBe(false);
    expect(isAutomatedGreen(dims)).toBe(false);
  });

  it('aggregateMechanicalStatus: trunkInheritedGateFail → skipped', () => {
    expect(
      aggregateMechanicalStatus({
        gatesPassed: false,
        deliveryFailed: false,
        noFileChanges: false,
        hasMechanicalCriteria: true,
        behavioralFailed: false,
        trunkInheritedGateFail: true,
        criterionStatuses: ['skipped'],
      }),
    ).toBe('skipped');
  });

  it('buildDodDimensions with trunkInheritedGateFail skips mechanical criteria', () => {
    const dod = parseDefinitionOfDone(`
## Acceptance criteria
- [ ] (mechanical) pnpm check:full green
- [ ] (human) look at packet
`);
    const dims = buildDodDimensions({
      dod,
      gatesPassed: false,
      noFileChanges: false,
      reviewerVerdict: null,
      reviewerRan: false,
      reviewerSkipReason: 'L1 gates failed — L3 not run',
      trunkInheritedGateFail: true,
    });
    expect(dims.mechanical).toBe('skipped');
    expect(dims.criteria.find((c) => c.kind === 'mechanical')?.status).toBe('skipped');
    expect(shouldAutoRework({ dimensions: dims, noFileChanges: false })).toBe(false);
  });

  it('not reproduced path: mechanical still fails + auto-rework', () => {
    const dod = parseDefinitionOfDone(`
## Acceptance criteria
- [ ] (mechanical) tests pass
`);
    const dims = buildDodDimensions({
      dod,
      gatesPassed: false,
      noFileChanges: false,
      reviewerVerdict: null,
      reviewerRan: false,
      reviewerSkipReason: 'L1 gates failed — L3 not run',
      // no trunkInheritedGateFail
    });
    expect(dims.mechanical).toBe('fail');
    expect(shouldAutoRework({ dimensions: dims, noFileChanges: false })).toBe(true);
  });
});

describe('bodyHasTrunkInheritedGateFail', () => {
  it('detects packet marker for decision inbox', () => {
    expect(bodyHasTrunkInheritedGateFail(`x\n${TRUNK_INHERITED_MARKER}\ny`)).toBe(true);
    expect(bodyHasTrunkInheritedGateFail('normal fail')).toBe(false);
  });
});
