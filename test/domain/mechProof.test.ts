import { describe, it, expect } from 'vitest';
import {
  parseMechProofBinding,
  parseScenarioBinding,
  evaluateMechanicalCriterion,
  aggregateMechanicalStatus,
  extractEvidenceMatchKeywords,
  unverifiedTestPathWarning,
} from '../../src/domain/mechProof.js';
import { observedViaPackageJsonScript } from '../../src/domain/mechProof.js';

describe('parseMechProofBinding', () => {
  it('parses @gate / @evidence / @test suffixes', () => {
    expect(parseMechProofBinding('gates green @gate:test')).toEqual({
      kind: 'gate',
      ref: 'test',
      cleanText: 'gates green',
    });
    expect(parseMechProofBinding('nav hooks @evidence:nav-settings')).toMatchObject({
      kind: 'evidence',
      ref: 'nav-settings',
    });
    expect(parseMechProofBinding('unit test @test:test/web/x.test.ts')).toMatchObject({
      kind: 'test-path',
      ref: 'test/web/x.test.ts',
    });
  });

  it('parses @test:path#title with spaces in the title', () => {
    expect(
      parseMechProofBinding('named case @test:test/domain/x.test.ts#rejects a forged pin'),
    ).toEqual({
      kind: 'test-case',
      ref: 'test/domain/x.test.ts',
      title: 'rejects a forged pin',
      cleanText: 'named case',
    });
  });

  it('parses @probe:kind:ref with spaces in the ref', () => {
    expect(parseMechProofBinding('http probe @probe:http:GET /x')).toEqual({
      kind: 'probe',
      ref: 'GET /x',
      probeKind: 'http',
      cleanText: 'http probe',
    });
  });
});

describe('parseScenarioBinding', () => {
  it('parses and strips @scenario:<id>', () => {
    expect(
      parseScenarioBinding(
        'Owner watched the recorded scenario video @scenario:chat-sheet-scroll-lock',
      ),
    ).toEqual({
      id: 'chat-sheet-scroll-lock',
      cleanText: 'Owner watched the recorded scenario video',
    });
  });

  it('returns null id when absent', () => {
    expect(parseScenarioBinding('no binding here')).toEqual({
      id: null,
      cleanText: 'no binding here',
    });
  });
});

describe('extractEvidenceMatchKeywords', () => {
  it('extracts selector / screenshot / assert-text style tokens (EN)', () => {
    const r = extractEvidenceMatchKeywords(
      'L2 evidence: assert sel=[data-evidence=task-list] + screenshot tasks',
    );
    expect(r.usable).toBe(true);
    expect(r.keywords).toEqual(
      expect.arrayContaining(['task-list', 'tasks', 'task', 'list']),
    );
  });

  it('extracts Chinese domain keywords from mixed CN/EN criteria', () => {
    // Real case (l2-fault-injection 2026-07-30): 降级/死因 must be matchable.
    const r = extractEvidenceMatchKeywords(
      'L2 证据: 降级说明与死因文本被 assert 命中 + 截图',
    );
    expect(r.usable).toBe(true);
    expect(r.keywords.some((k) => k.includes('降级') || k === '降级')).toBe(true);
    expect(r.keywords.some((k) => k.includes('死因') || k === '死因')).toBe(true);
    // Generic step kinds alone are not enough to match.
    expect(r.keywords).not.toContain('assert');
    expect(r.keywords).not.toContain('screenshot');
    expect(r.keywords).not.toContain('截图');
  });

  it('marks over-generic evidence criteria as unusable (conservative fallback)', () => {
    const r = extractEvidenceMatchKeywords('行为证据步骤全过 (见 ## Evidence)');
    expect(r.usable).toBe(false);
    expect(r.keywords).toEqual([]);
  });
});

describe('evaluateMechanicalCriterion', () => {
  const base = {
    gatesPassed: true,
    gateNames: ['test', 'lint'],
    evidenceOk: true as boolean | null,
    evidenceStepDetails: ['click [data-evidence=nav-settings] ok'],
    filesTouched: ['src/a.ts', 'test/web/x.test.ts'],
    selfAssessment: '- nav hooks: data-evidence present in SettingsPanel',
    testGate: {
      passed: true,
      output: '✓ test/web/x.test.ts (3)\n',
    } as { passed: boolean; output: string } | null,
  };

  it('fails when L2 evidence binding misses', () => {
    const r = evaluateMechanicalCriterion({
      ...base,
      criterionText: 'hooks @evidence:missing-hook',
    });
    expect(r.status).toBe('fail');
    expect(r.proof).toMatch(/data-evidence=missing-hook/);
  });

  it('passes bound evidence when step matches', () => {
    const r = evaluateMechanicalCriterion({
      ...base,
      criterionText: 'hooks @evidence:nav-settings',
    });
    expect(r.status).toBe('pass');
    expect(r.proof).toBe('L2 step matched data-evidence=nav-settings');
  });

  it('gate binding passes with regression proof', () => {
    const r = evaluateMechanicalCriterion({
      ...base,
      evidenceOk: true,
      evidenceStepDetails: [],
      criterionText: 'gates green @gate:test',
    });
    expect(r.status).toBe('pass');
    expect(r.warning).toBeNull();
    expect(r.proof).toBe('regression: gate test green');
  });

  it('gate binding fails when named gate is missing', () => {
    const r = evaluateMechanicalCriterion({
      ...base,
      criterionText: 'build ok @gate:build',
    });
    expect(r.status).toBe('fail');
    expect(r.warning).toMatch(/@gate:build/);
  });

  it('explicit @evidence binding still fails on miss (not skipped)', () => {
    const r = evaluateMechanicalCriterion({
      ...base,
      evidenceOk: true,
      evidenceStepDetails: ['click [data-evidence=nav-settings] ok'],
      criterionText: 'hooks @evidence:failover-death',
    });
    expect(r.status).toBe('fail');
    expect(r.warning).toMatch(/@evidence:failover-death/);
  });

  it('unbound evidence-like never passes — pending with @evidence suggestion', () => {
    const r = evaluateMechanicalCriterion({
      ...base,
      evidenceOk: true,
      evidenceStepDetails: [
        'click click [data-evidence=nav-settings] ok',
        'assert assert sel=[data-evidence=settings-panel] text ok',
        'screenshot screenshot settings-sheet settings-sheet.png',
      ],
      criterionText: 'L2 证据: settings 页 data-evidence 钩子 + screenshot settings-sheet',
    });
    expect(r.status).toBe('pending');
    expect(r.proof).toBe('unbound');
    expect(r.warning).toMatch(/unbound mechanical criterion — suggest @evidence:/);
  });

  it('unbound evidence-like keyword miss → pending (never skipped/pass)', () => {
    const r = evaluateMechanicalCriterion({
      ...base,
      evidenceOk: true,
      evidenceStepDetails: [
        'click click [data-evidence=nav-settings] ok',
        'assert assert sel=[data-evidence=settings-panel] Language|语言 ok',
        'screenshot screenshot settings-sheet settings-sheet.png',
      ],
      criterionText: 'L2 证据: 降级说明与死因文本被 assert 命中 + 截图',
    });
    expect(r.status).toBe('pending');
    expect(r.proof).toBe('unbound');
    expect(r.warning).toMatch(/unbound mechanical criterion —/);
  });

  it('unbound GATE_LIKE never passes — suggest @gate:test', () => {
    const r = evaluateMechanicalCriterion({
      ...base,
      criterionText: 'pnpm check:full green',
    });
    expect(r.status).toBe('pending');
    expect(r.proof).toBe('unbound');
    expect(r.warning).toBe('unbound mechanical criterion — suggest @gate:test');
  });

  it('unbound UI-like with L2 failed → pending (not heuristic fail/pass)', () => {
    const r = evaluateMechanicalCriterion({
      ...base,
      evidenceOk: false,
      criterionText: '底栏 Settings 页 data-evidence 钩子齐全',
    });
    expect(r.status).toBe('pending');
    expect(r.proof).toBe('unbound');
  });

  it('unbound generic → pending with add-binding suggestion', () => {
    const r = evaluateMechanicalCriterion({
      ...base,
      criterionText: 'implementation is correct',
    });
    expect(r.status).toBe('pending');
    expect(r.warning).toMatch(
      /unbound mechanical criterion — add @test:path#title, @evidence:anchor or @gate:name/,
    );
  });

  it('test-path passes when in diff and observed in green test gate', () => {
    const r = evaluateMechanicalCriterion({
      ...base,
      criterionText: 'unit coverage @test:test/web/x.test.ts',
    });
    expect(r.status).toBe('pass');
    expect(r.proof).toMatch(/test\/web\/x\.test\.ts in diff/);
  });

  it('test-path pending when path not in diff', () => {
    const r = evaluateMechanicalCriterion({
      ...base,
      filesTouched: ['src/a.ts'],
      criterionText: 'unit coverage @test:test/web/x.test.ts',
    });
    expect(r.status).toBe('pending');
    expect(r.warning).toMatch(/not in diff — bind a title/);
  });

  it('test-path unverified when green gate output lacks the path (file in diff)', () => {
    const r = evaluateMechanicalCriterion({
      ...base,
      testGate: { passed: true, output: '✓ test/other.test.ts\n' },
      criterionText: 'unit coverage @test:test/web/x.test.ts',
    });
    expect(r.status).toBe('unverified');
    expect(r.warning).toBe(unverifiedTestPathWarning('test/web/x.test.ts'));
  });

  it('test-path pending when red test gate does not observe the path', () => {
    const r = evaluateMechanicalCriterion({
      ...base,
      testGate: { passed: false, output: 'FAIL suite\n' },
      criterionText: 'unit coverage @test:test/web/x.test.ts',
    });
    expect(r.status).toBe('pending');
    expect(r.warning).toMatch(/not observed in test gate output/);
  });

  it('test-case unverified when green gate output lacks the path (title present)', () => {
    const r = evaluateMechanicalCriterion({
      ...base,
      testCaseIndex: new Map([['test/web/x.test.ts', ['rejects a forged pin']]]),
      testGate: { passed: true, output: '3 passed\n' },
      criterionText: 'case @test:test/web/x.test.ts#rejects a forged pin',
    });
    expect(r.status).toBe('unverified');
    expect(r.warning).toBe(unverifiedTestPathWarning('test/web/x.test.ts'));
  });

  it('test-path pending when no test gate ran', () => {
    const r = evaluateMechanicalCriterion({
      ...base,
      testGate: null,
      criterionText: 'unit coverage @test:test/web/x.test.ts',
    });
    expect(r.status).toBe('pending');
    expect(r.warning).toBe('no test gate ran');
  });

  it('test-case fails when contracted title is absent from index', () => {
    const r = evaluateMechanicalCriterion({
      ...base,
      testCaseIndex: new Map([['test/web/x.test.ts', ['other case']]]),
      criterionText: 'case @test:test/web/x.test.ts#rejects a forged pin',
    });
    expect(r.status).toBe('fail');
    expect(r.warning).toMatch(/contracted test "rejects a forged pin" not found/);
  });

  it('test-case is pending (not failed) when the bound file could not be read at the verified revision', () => {
    const r = evaluateMechanicalCriterion({
      ...base,
      testCaseIndex: new Map([['test/web/other.test.ts', ['unrelated']]]),
      criterionText: 'case @test:test/web/x.test.ts#rejects a forged pin',
    });
    expect(r.status).toBe('pending');
    expect(r.warning).toMatch(/could not be read at the verified revision/);
  });

  it('test-case pending when index unavailable', () => {
    const r = evaluateMechanicalCriterion({
      ...base,
      criterionText: 'case @test:test/web/x.test.ts#rejects a forged pin',
    });
    expect(r.status).toBe('pending');
    expect(r.warning).toBe('test case index unavailable');
  });

  it('test-case passes when title present and test gate observed (new in diff)', () => {
    const r = evaluateMechanicalCriterion({
      ...base,
      testCaseIndex: new Map([['test/web/x.test.ts', ['rejects a forged pin']]]),
      addedTestTitles: new Map([['test/web/x.test.ts', ['rejects a forged pin']]]),
      criterionText: 'case @test:test/web/x.test.ts#rejects a forged pin',
    });
    expect(r.status).toBe('pass');
    expect(r.proof).toBe(
      'test gate green · it("rejects a forged pin") in test/web/x.test.ts (new in diff)',
    );
  });

  it('test-case proof marks pre-existing when title not in addedTestTitles', () => {
    const r = evaluateMechanicalCriterion({
      ...base,
      testCaseIndex: new Map([['test/web/x.test.ts', ['rejects a forged pin']]]),
      addedTestTitles: new Map([['test/web/x.test.ts', ['other']]]),
      criterionText: 'case @test:test/web/x.test.ts#rejects a forged pin',
    });
    expect(r.status).toBe('pass');
    expect(r.proof).toMatch(/\(pre-existing\)/);
  });

  it('test-case pending when test gate missing', () => {
    const r = evaluateMechanicalCriterion({
      ...base,
      testGate: null,
      testCaseIndex: new Map([['test/web/x.test.ts', ['rejects a forged pin']]]),
      criterionText: 'case @test:test/web/x.test.ts#rejects a forged pin',
    });
    expect(r.status).toBe('pending');
    expect(r.warning).toBe('no test gate ran');
  });

  it('test-path OBSERVED via package.json script that names the file (gate command)', () => {
    const r = evaluateMechanicalCriterion({
      ...base,
      testGate: {
        passed: true,
        output: 'ok\n',
        command: 'pnpm test:x',
      },
      packageJsonScripts: {
        'test:x': 'node --test webapp/tests/x.test.mjs',
      },
      criterionText: 'unit coverage @test:webapp/tests/x.test.mjs',
      filesTouched: ['webapp/tests/x.test.mjs'],
    });
    expect(r.status).toBe('pass');
  });

  it('test-path stays unverified when package.json script does not name the file', () => {
    const r = evaluateMechanicalCriterion({
      ...base,
      testGate: {
        passed: true,
        output: 'ok\n',
        command: 'pnpm test:x',
      },
      packageJsonScripts: {
        'test:x': 'node --test webapp/tests/other.test.mjs',
      },
      criterionText: 'unit coverage @test:webapp/tests/x.test.mjs',
      filesTouched: ['webapp/tests/x.test.mjs'],
    });
    expect(r.status).toBe('unverified');
    expect(r.warning).toBe(unverifiedTestPathWarning('webapp/tests/x.test.mjs'));
  });

  it('Rust test-case proof uses #[test] fn form', () => {
    const r = evaluateMechanicalCriterion({
      ...base,
      testCaseIndex: new Map([['core/tests/guards.rs', ['rejects_forged_pin']]]),
      addedTestTitles: new Map([['core/tests/guards.rs', ['rejects_forged_pin']]]),
      testGate: { passed: true, output: 'core/tests/guards.rs ... ok\n' },
      criterionText: 'guard @test:core/tests/guards.rs#rejects_forged_pin',
      filesTouched: ['core/tests/guards.rs'],
    });
    expect(r.status).toBe('pass');
    expect(r.proof).toBe(
      'test gate green · #[test] fn rejects_forged_pin() in core/tests/guards.rs (new in diff)',
    );
  });

  it('probe always pending with no-verifier warning', () => {
    const r = evaluateMechanicalCriterion({
      ...base,
      criterionText: 'reachable @probe:http:GET /x',
    });
    expect(r.status).toBe('pending');
    expect(r.warning).toBe('@probe:http has no verifier for this archetype');
    expect(r.proof).toBe('@probe:http');
  });

  it('gatesPassed false fails first for any binding', () => {
    const r = evaluateMechanicalCriterion({
      ...base,
      gatesPassed: false,
      criterionText: 'gates green @gate:test',
    });
    expect(r.status).toBe('fail');
  });

  it('mechanical unbound path does not emit human UI AC warning', async () => {
    const { findUnprovenUiCriteria, UNPROVEN_UI_AC_WARNING } = await import(
      '../../src/domain/uiAcEvidence.js'
    );
    const mech = evaluateMechanicalCriterion({
      ...base,
      evidenceOk: true,
      evidenceStepDetails: ['click [data-evidence=nav-settings] ok'],
      criterionText: 'L2 证据: 降级说明与死因文本被 assert 命中 + 截图',
    });
    expect(mech.status).toBe('pending');
    expect(mech.warning).toMatch(/unbound mechanical criterion/);
    expect(mech.warning).not.toBe(UNPROVEN_UI_AC_WARNING);

    const humanHits = findUnprovenUiCriteria({
      humanCriteria: ['手机上点黄色跨任务徽章, 一眼看懂为什么黄'],
      evidencePlanSteps: [
        { kind: 'unlock', raw: 'unlock' },
        {
          kind: 'click',
          selector: '[data-evidence=nav-settings]',
          raw: 'click [data-evidence=nav-settings]',
        },
      ],
    });
    expect(humanHits).toHaveLength(1);
    expect(humanHits[0]!.warning).toBe(UNPROVEN_UI_AC_WARNING);
  });
});

describe('aggregateMechanicalStatus', () => {
  it('fails on behavioral or critical path via criterion fail', () => {
    expect(
      aggregateMechanicalStatus({
        gatesPassed: true,
        deliveryFailed: false,
        noFileChanges: false,
        hasMechanicalCriteria: true,
        behavioralFailed: true,
        criterionStatuses: ['pass'],
      }),
    ).toBe('fail');
  });

  it('precedence: fail > skipped > pending > n/a > pass (unverified ranks with pass)', () => {
    expect(
      aggregateMechanicalStatus({
        gatesPassed: true,
        deliveryFailed: false,
        noFileChanges: false,
        hasMechanicalCriteria: true,
        behavioralFailed: false,
        criterionStatuses: ['pass', 'fail', 'pending'],
      }),
    ).toBe('fail');
    expect(
      aggregateMechanicalStatus({
        gatesPassed: true,
        deliveryFailed: false,
        noFileChanges: false,
        hasMechanicalCriteria: true,
        behavioralFailed: false,
        criterionStatuses: ['pass', 'skipped', 'pending'],
      }),
    ).toBe('skipped');
    expect(
      aggregateMechanicalStatus({
        gatesPassed: true,
        deliveryFailed: false,
        noFileChanges: false,
        hasMechanicalCriteria: true,
        behavioralFailed: false,
        criterionStatuses: ['pass', 'pending'],
      }),
    ).toBe('pending');
    expect(
      aggregateMechanicalStatus({
        gatesPassed: true,
        deliveryFailed: false,
        noFileChanges: false,
        hasMechanicalCriteria: true,
        behavioralFailed: false,
        criterionStatuses: ['pass'],
      }),
    ).toBe('pass');
    expect(
      aggregateMechanicalStatus({
        gatesPassed: true,
        deliveryFailed: false,
        noFileChanges: false,
        hasMechanicalCriteria: true,
        behavioralFailed: false,
        criterionStatuses: ['pass', 'unverified'],
      }),
    ).toBe('pass');
    expect(
      aggregateMechanicalStatus({
        gatesPassed: true,
        deliveryFailed: false,
        noFileChanges: false,
        hasMechanicalCriteria: true,
        behavioralFailed: false,
        criterionStatuses: ['unverified', 'pending'],
      }),
    ).toBe('pending');
  });
});

describe('behavioral expected-but-never-ran (2026-07-24 lying DoD table)', () => {
  it('aggregate: missing L2 evidence is not a pass — but not a fail either (no auto-rework)', () => {
    const status = aggregateMechanicalStatus({
      gatesPassed: true,
      deliveryFailed: false,
      noFileChanges: false,
      hasMechanicalCriteria: true,
      behavioralFailed: false,
      behavioralMissing: true,
      criterionStatuses: ['pass'],
    });
    expect(status).toBe('skipped');
  });

  it('aggregate: a real L2 failure still fails (auto-rework path intact)', () => {
    expect(
      aggregateMechanicalStatus({
        gatesPassed: true,
        deliveryFailed: false,
        noFileChanges: false,
        hasMechanicalCriteria: true,
        behavioralFailed: true,
        behavioralMissing: false,
        criterionStatuses: ['pass'],
      }),
    ).toBe('fail');
  });

  it('zh evidence criterion unbound never passes even with self-assessment', () => {
    const ev = evaluateMechanicalCriterion({
      criterionText: '行为证据步骤全过 (见 ## Evidence)',
      gatesPassed: true,
      gateNames: ['test'],
      evidenceOk: null,
      evidenceStepDetails: [],
      filesTouched: ['src/web/App.tsx'],
      selfAssessment: '- **行为证据步骤全过** — 我本地跑过, 都通过了',
      behavioralMissing: true,
    });
    expect(ev.status).not.toBe('pass');
    expect(ev.status).toBe('pending');
    expect(ev.proof).toBe('unbound');
  });
});

describe('observedViaPackageJsonScript — exact invocation only (Grok R19 B2)', () => {
  const scripts = {
    test: 'vitest run webapp/tests/x.test.mjs',
    'test:unit': 'vitest run webapp/tests/other.test.mjs',
    'test:x': 'node --test webapp/tests/x.test.mjs',
  };
  const ref = 'webapp/tests/x.test.mjs';
  it('does not count a substring command match or an echoed script name', () => {
    expect(observedViaPackageJsonScript({ ref, testGate: { output: 'ok', command: 'pnpm test:unit' }, packageJsonScripts: scripts })).toBe(false);
    expect(observedViaPackageJsonScript({ ref, testGate: { output: 'Running test:x suite\nok', command: 'pnpm test' }, packageJsonScripts: { test: 'vitest', 'test:x': scripts['test:x'] } })).toBe(false);
    expect(observedViaPackageJsonScript({ ref, testGate: { output: 'ok' }, packageJsonScripts: scripts })).toBe(false);
  });
  it('counts an exact script invocation whose body names the file', () => {
    expect(observedViaPackageJsonScript({ ref, testGate: { output: 'ok', command: 'pnpm test' }, packageJsonScripts: scripts })).toBe(true);
    expect(observedViaPackageJsonScript({ ref, testGate: { output: 'ok', command: 'pnpm run test:x' }, packageJsonScripts: scripts })).toBe(true);
    expect(observedViaPackageJsonScript({ ref, testGate: { output: 'ok', command: 'npm test' }, packageJsonScripts: scripts })).toBe(true);
    expect(observedViaPackageJsonScript({ ref, testGate: { output: 'ok', command: 'pnpm test --run' }, packageJsonScripts: scripts })).toBe(true);
  });
});
