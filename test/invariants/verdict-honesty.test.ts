/**
 * Held-out verdict-honesty invariants (acceptance-binding-grammar §3–§6).
 * Protected path — implementers must not edit this file.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateMechanicalCriterion,
  aggregateMechanicalStatus,
  parseMechProofBinding,
} from '../../src/domain/mechProof.js';
import {
  buildDodDimensions,
  parseDefinitionOfDone,
  isAutomatedGreen,
  shouldAutoRework,
  listHumanCriteriaTexts,
  type DimensionStatus,
  type DodDimensions,
} from '../../src/domain/acceptance.js';
import {
  countedGates,
  isCriticalCheatKind,
  type GateResult,
  type ReviewPacket,
  type ReviewerVerdict,
} from '../../src/domain/verification.js';
import {
  assembleReviewPacket,
  renderPacketMarkdown,
  packetStatusLine,
  type ReviewPacketParts,
} from '../../src/verification/packet.js';
import { scanGateToolchain } from '../../src/verification/gateToolchain.js';
import { computeL2Relevance } from '../../src/domain/l2Relevance.js';
import { buildVerifyTimeline } from '../../src/domain/runTimeline.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const AXIS = ['pass', 'pending', 'fail', 'skipped', 'n/a'] as const satisfies readonly DimensionStatus[];
const CRIT = ['pass', 'pending', 'fail', 'skipped', 'unverified'] as const satisfies readonly DimensionStatus[];
const PROBES = ['http', 'screenshot', 'mail', 'wordpress', 'xyzzy'] as const;
const UNBOUND = [
  'tests pass', 'typecheck green', '所有门禁通过', 'screenshot shows settings panel',
  'data-evidence=settings-panel visible', '行为证据步骤通过', 'pnpm check:full is green',
  'vitest and tsc pass', 'lint and build ok', '机检通过',
  'L2 behavioral evidence steps all green', 'hooks present: data-evidence=settings-panel',
  '截图显示 settings 页',
] as const;

const GATES_PASS: GateResult[] = [
  { name: 'typecheck', command: 'pnpm typecheck', passed: true, output: '' },
  { name: 'test', command: 'pnpm test', passed: true, output: '' },
];
const APPROVED: ReviewerVerdict = { approved: true, summary: 'ok', comments: [] };
const FAVORABLE = {
  gatesPassed: true,
  gateNames: ['typecheck', 'lint', 'test', 'build', 'check', 'check:full'],
  evidenceOk: true as boolean | null,
  evidenceStepDetails: [
    'click [data-evidence=settings-panel] ok',
    'assert sel=[data-evidence=settings-panel] visible',
    'screenshot settings panel', '行为证据步骤通过', 'tests pass typecheck green',
  ],
  filesTouched: ['src/web/Settings.tsx', 'test/web/settings.test.ts', 'package.json'],
};

function baseParts(o: Partial<ReviewPacketParts> = {}): ReviewPacketParts {
  return {
    taskId: 'T-honesty', branch: 'hercules/T-honesty', filesTouched: ['src/foo.ts'],
    diffSummary: '1 file changed',
    diff: 'diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n+x\n',
    gates: GATES_PASS, cheatFindings: [], reviewerVerdict: APPROVED, reviewerRan: true,
    selfAssessment: 'done', finalReport: 'done', ...o,
  };
}

function axes(mechanical: DimensionStatus, reviewer: DimensionStatus): DodDimensions {
  return { mechanical, reviewer, human: 'n/a', criteria: [], warnings: [] };
}

function statusLinePacket(m: DimensionStatus, r: DimensionStatus, green: boolean): ReviewPacket {
  return {
    taskId: 'T-sl', branch: 'hercules/T-sl', filesTouched: green ? ['src/a.ts'] : [],
    diffSummary: '', diff: '', gates: [], cheatFindings: [], screenshots: [],
    reviewerVerdict: null, selfAssessment: '', finalReport: '', green, noChanges: !green,
    dod: axes(m, r), autoRework: false, reworkPath: null, reworkPathReason: null,
    reportPolluted: false, activityLog: [], runKind: 'implementer', reviewerSkipReason: null,
    diffUrl: null, evidenceMatrix: [], verifiedSha: null,
  };
}

/**
 * Independent expected aggregate (fail > skipped > pending > n/a > pass).
 * `unverified` ranks with `pass` (does not demote the axis).
 */
function expectedAggregate(
  statuses: readonly DimensionStatus[],
  gatesPassed: boolean,
  behavioralMissing: boolean,
): DimensionStatus {
  if (statuses.some((s) => s === 'fail')) return 'fail';
  if (behavioralMissing) return 'skipped';
  if (!gatesPassed) return 'fail';
  if (statuses.some((s) => s === 'skipped')) return 'skipped';
  if (statuses.some((s) => s === 'pending')) return 'pending';
  if (
    statuses.some((s) => s === 'n/a') &&
    !statuses.some((s) => s === 'pass' || s === 'unverified')
  ) {
    return 'n/a';
  }
  return 'pass';
}

describe('verdict honesty (held-out)', () => {
  it('1. unbound never passes (heuristic texts stay pending)', () => {
    expect(UNBOUND.length).toBeGreaterThanOrEqual(12);
    for (const text of UNBOUND) {
      const r = evaluateMechanicalCriterion({
        criterionText: text, ...FAVORABLE,
        evidenceStepDetails: [...FAVORABLE.evidenceStepDetails, text],
        selfAssessment: `criterion satisfied: "${text}" — see tests and screenshots`,
      });
      expect(r.status, text).toBe('pending');
      expect(r.warning ?? '', text).toMatch(/^unbound mechanical criterion/);
    }
  });

  it('2. @test:path outside the diff never passes', () => {
    const path = 'test/web/settings.test.ts';
    expect(evaluateMechanicalCriterion({
      criterionText: `unit coverage @test:${path}`, gatesPassed: true, gateNames: ['test'],
      evidenceOk: true, evidenceStepDetails: [], filesTouched: ['src/web/Settings.tsx'],
      selfAssessment: `covered ${path}`, testGate: { passed: true, output: `✓ ${path} (4)\n` },
    }).status).toBe('pending');
  });

  it('3. @test:path#title — absent fail, no index pending, present pass', () => {
    const path = 'test/domain/x.test.ts';
    const title = 'rejects a forged pin';
    const base = {
      criterionText: `named case @test:${path}#${title}`, gatesPassed: true, gateNames: ['test'],
      evidenceOk: true as boolean | null, evidenceStepDetails: [] as string[], filesTouched: [path],
      selfAssessment: '', testGate: { passed: true, output: `✓ ${path}\n` },
    };
    expect(evaluateMechanicalCriterion({
      ...base, testCaseIndex: new Map([[path, ['other case']]]),
    }).status).toBe('fail');
    expect(evaluateMechanicalCriterion({ ...base }).status).toBe('pending');
    const present = evaluateMechanicalCriterion({
      ...base, testCaseIndex: new Map([[path, [title]]]),
    });
    expect(present.status).toBe('pass');
    expect(present.proof).toContain(title);
  });

  it('4. @probe:* never passes for any probe kind', () => {
    for (const kind of PROBES) {
      expect(evaluateMechanicalCriterion({
        criterionText: `world state @probe:${kind}:GET /health`, gatesPassed: true,
        gateNames: ['test'], evidenceOk: true, evidenceStepDetails: [],
        filesTouched: ['src/a.ts'], selfAssessment: 'probed',
      }).status, kind).toBe('pending');
    }
  });

  it('5. aggregate precedence over criterion statuses × gates × behavioralMissing', () => {
    for (const a of CRIT) {
      for (const b of CRIT) {
        for (const gatesPassed of [true, false]) {
          for (const behavioralMissing of [true, false]) {
            const statuses = [a, b];
            const got = aggregateMechanicalStatus({
              gatesPassed, deliveryFailed: false, noFileChanges: false,
              hasMechanicalCriteria: true, behavioralFailed: false, behavioralMissing,
              criterionStatuses: statuses,
            });
            expect(got, `${a}+${b} g=${gatesPassed} m=${behavioralMissing}`).toBe(
              expectedAggregate(statuses, gatesPassed, behavioralMissing),
            );
          }
        }
      }
    }
  });

  it('6. pending is not green and does not auto-rework', () => {
    const d = axes('pending', 'pass');
    expect(isAutomatedGreen(d)).toBe(false);
    expect(shouldAutoRework({ dimensions: d, noFileChanges: false })).toBe(false);
  });

  it('7. status line: automated proof complete only when both axes pass', () => {
    for (const mechanical of AXIS) {
      for (const reviewer of AXIS) {
        const green = isAutomatedGreen(axes(mechanical, reviewer));
        const line = packetStatusLine(statusLinePacket(mechanical, reviewer, green));
        expect(/automated proof complete/i.test(line), `${mechanical}/${reviewer}`).toBe(
          green && mechanical === 'pass' && reviewer === 'pass',
        );
      }
    }
  });

  it('8. forbidden phrases absent from packet source and green markdown', async () => {
    const src = await readFile(join(ROOT, 'src/verification/packet.ts'), 'utf8');
    expect(src.toLowerCase()).not.toMatch(/need not re-read/);
    expect(src).not.toContain('无需再看');
    const packet = assembleReviewPacket(baseParts());
    expect(packet.green).toBe(true);
    const md = renderPacketMarkdown(packet);
    expect(md.toLowerCase()).not.toMatch(/need not re-read/);
    expect(md).not.toContain('无需再看');
  });

  it('9. synthesized gate rows are not proof', () => {
    const skipped: GateResult[] = [
      { name: 'typecheck', command: 'pnpm typecheck', passed: true, output: 'skipped', outcome: 'skipped' },
      { name: 'test', command: 'pnpm test', passed: true, output: 'skipped', outcome: 'skipped' },
    ];
    expect(countedGates(skipped)).toEqual([]);
    const packet = assembleReviewPacket(baseParts({
      filesTouched: [], diff: '', diffSummary: '0 files', gates: skipped,
      reviewerVerdict: null, reviewerRan: false,
      reviewerSkipReason: 'no file changes (read-only / Q&A)',
      taskTitle: 'Q&A', taskBody: '<!-- hercules:no-diff-ok -->',
    }));
    expect(packet.dod.mechanical).toBe('n/a');
    expect(packetStatusLine(packet)).not.toMatch(/automated proof complete/i);
  });

  it('10. reviewer disabled with non-empty diff → skipped, never green', () => {
    const dod = parseDefinitionOfDone(`
## Acceptance criteria
- [ ] (mechanical) gates green @gate:all
- [ ] (human) ship
`);
    expect(buildDodDimensions({
      dod, gatesPassed: true, noFileChanges: false, reviewerVerdict: null,
      reviewerRan: false, reviewerSkipReason: 'L3 disabled',
      filesTouched: ['src/foo.ts'], gateNames: ['typecheck', 'test'],
    }).reviewer).toBe('skipped');
    const packet = assembleReviewPacket(baseParts({
      reviewerVerdict: null, reviewerRan: false, reviewerSkipReason: 'L3 disabled', dod,
    }));
    expect(packet.dod.reviewer).toBe('skipped');
    expect(packet.green).toBe(false);
  });

  it('11. L3 truncation is stated in markdown and dod.warnings', () => {
    const packet = assembleReviewPacket(baseParts({
      reviewerVerdict: { ...APPROVED, inputTruncation: { diffChars: 200_000, maxChars: 80_000 } },
    }));
    const warn = 'L3 read the first 80000 of 200000 diff chars';
    expect(packet.dod.warnings.some((w) => w.includes(warn))).toBe(true);
    expect(renderPacketMarkdown(packet)).toContain(warn);
  });

  it('12. gate toolchain edits are never green', () => {
    const trusted = JSON.stringify({ scripts: { typecheck: 'tsc -p .' } });
    const candidate = JSON.stringify({
      scripts: { typecheck: 'node scripts/x.mjs && tsc -p .' },
    });
    const pkgDiff = [
      'diff --git a/package.json b/package.json', '--- a/package.json', '+++ b/package.json',
      '@@ -1,3 +1,3 @@', '-    "typecheck": "tsc -p .",',
      '+    "typecheck": "node scripts/x.mjs && tsc -p .",',
    ].join('\n');
    const report = scanGateToolchain({
      diff: pkgDiff, gateCommands: ['pnpm typecheck'],
      trustedPackageJson: trusted, candidatePackageJson: candidate,
    });
    expect(report.findings.filter((f) => f.kind === 'gate-toolchain-edit').length)
      .toBeGreaterThanOrEqual(1);
    const vitestDiff = [
      'diff --git a/vitest.config.ts b/vitest.config.ts',
      '--- a/vitest.config.ts', '+++ b/vitest.config.ts',
      '@@ -1 +1,2 @@', ' export default {}', '+// tweak',
    ].join('\n');
    expect(scanGateToolchain({
      diff: vitestDiff, gateCommands: ['pnpm typecheck'],
      trustedPackageJson: trusted, candidatePackageJson: trusted,
    }).findings.some((f) => f.kind === 'gate-toolchain-edit')).toBe(true);
    expect(scanGateToolchain({
      diff: [
        'diff --git a/package.json b/package.json', '--- a/package.json', '+++ b/package.json',
        '@@ -1,3 +1,6 @@', ' {', '   "scripts": { "typecheck": "tsc -p ." },',
        '+  "dependencies": {', '+    "leftpad": "1.0.0"', '+  }', ' }',
      ].join('\n'),
      gateCommands: ['pnpm typecheck'], trustedPackageJson: trusted,
      candidatePackageJson: JSON.stringify({
        scripts: { typecheck: 'tsc -p .' }, dependencies: { leftpad: '1.0.0' },
      }),
    }).findings).toEqual([]);
    expect(isCriticalCheatKind('gate-toolchain-edit')).toBe(false);
    const packet = assembleReviewPacket(baseParts({
      filesTouched: ['package.json'], cheatFindings: report.findings,
      dod: parseDefinitionOfDone(`
## Acceptance criteria
- [ ] (mechanical) gates green @gate:all
- [ ] (reviewer) spirit
`),
    }));
    expect(packet.green).toBe(false);
    expect(packet.dod.mechanical).toBe('pending');
    expect(packet.autoRework).toBe(false);
  });

  it('13. timeline never defaults L2 to ok when evidence absent', () => {
    const events = buildVerifyTimeline({
      stamp: '2026-09-02T00:00:00Z',
      gates: [
        { name: 'typecheck', passed: true, output: '' },
        { name: 'test', passed: true, output: '' },
      ],
      green: true, autoRework: false,
    });
    expect(events.some((e) => e.kind === 'l2')).toBe(false);
  });

  it('14. L2 relevance is a label, not a verdict', () => {
    const diff = [
      'diff --git a/src/web/X.tsx b/src/web/X.tsx', '--- a/src/web/X.tsx', '+++ b/src/web/X.tsx',
      '@@ -1,2 +1,3 @@', '+  <button data-evidence=promote-btn />',
    ].join('\n');
    const steps = [
      { kind: 'click', ok: true, detail: 'ok', raw: 'click [data-evidence=nav-settings]' },
    ];
    expect(computeL2Relevance({
      diff, filesTouched: ['src/web/X.tsx'], steps, hasEvidenceBinding: false,
    }).label).toBe('regression-only');
    const withRel = assembleReviewPacket(baseParts({
      filesTouched: ['src/web/X.tsx'], diff,
      evidenceRun: { source: 'workflow', ok: true, steps },
    }));
    const without = assembleReviewPacket(baseParts({
      filesTouched: ['src/foo.ts'],
      evidenceRun: { source: 'workflow', ok: true, steps },
    }));
    expect(withRel.l2Relevance?.label).toBe('regression-only');
    expect(withRel.green).toBe(without.green);
  });

  it('15. grammar round-trip for §3 bindings + checkpoint human list', () => {
    const cases: ReadonlyArray<{ text: string; kind: string }> = [
      { text: 'named @test:test/a.test.ts#rejects forged', kind: 'test-case' },
      { text: 'file @test:test/a.test.ts', kind: 'test-path' },
      { text: 'scene @evidence:nav-settings', kind: 'evidence' },
      { text: 'regression @gate:test', kind: 'gate' },
      { text: 'probe @probe:http:GET /x', kind: 'probe' },
      { text: 'no binding here', kind: 'unbound' },
    ];
    for (const c of cases) {
      const b = parseMechProofBinding(c.text);
      expect(b.kind, c.text).toBe(c.kind);
      expect(b.cleanText.includes('@'), c.text).toBe(false);
    }
    expect(parseDefinitionOfDone(`
## Acceptance criteria
- [ ] (checkpoint) before deploy: confirm URL
`).criteria[0]?.kind).toBe('checkpoint');
    expect(parseDefinitionOfDone(`
## Acceptance criteria
- [ ] （检查点）before merge: 确认截图
`).criteria[0]?.kind).toBe('checkpoint');
    expect(listHumanCriteriaTexts(`
## Acceptance criteria
- [ ] (checkpoint) before deploy: confirm staging
- [ ] （检查点）before merge: 确认截图
- [ ] (mechanical) gates @gate:test
`)).toEqual(expect.arrayContaining([
      'before deploy: confirm staging', 'before merge: 确认截图',
    ]));
  });

  it('16. unverified never when test gate failed or path absent from diff', () => {
    const path = 'test/web/settings.test.ts';
    const selfAssessment = 'coverage claimed';
    // Red test gate → pending/fail path, never unverified
    expect(
      evaluateMechanicalCriterion({
        criterionText: `coverage @test:${path}`,
        ...FAVORABLE,
        selfAssessment,
        filesTouched: [path, 'src/web/Settings.tsx'],
        testGate: { passed: false, output: `✓ ${path}\n` },
      }).status,
    ).not.toBe('unverified');
    expect(
      evaluateMechanicalCriterion({
        criterionText: `coverage @test:${path}`,
        ...FAVORABLE,
        selfAssessment,
        gatesPassed: false,
        filesTouched: [path],
        testGate: { passed: false, output: 'FAIL\n' },
      }).status,
    ).toBe('fail');
    // Path not in diff → pending, never unverified (even with green silent runner)
    expect(
      evaluateMechanicalCriterion({
        criterionText: `coverage @test:${path}`,
        ...FAVORABLE,
        selfAssessment,
        filesTouched: ['src/web/Settings.tsx'],
        testGate: { passed: true, output: '3 passed\n' },
      }).status,
    ).toBe('pending');
    // Green gate + in diff + silent runner → unverified (positive control)
    expect(
      evaluateMechanicalCriterion({
        criterionText: `coverage @test:${path}`,
        ...FAVORABLE,
        selfAssessment,
        filesTouched: [path],
        testGate: { passed: true, output: '3 passed\n' },
      }).status,
    ).toBe('unverified');
  });
});
