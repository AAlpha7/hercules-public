import { describe, it, expect } from 'vitest';
import {
  hasCheckableCriteria,
  parseDefinitionOfDone,
  shouldRunReviewer,
  buildDodDimensions,
  shouldAutoRework,
  isAutomatedGreen,
  listHumanCriteriaTexts,
  missingHumanAcknowledgements,
  planPendingReasonFor,
  PLAN_PENDING_REASON,
} from '../../src/domain/acceptance.js';

describe('parseDefinitionOfDone', () => {
  it('parses typed criteria and defaults untyped to human', () => {
    const body = `
## Task
Do the thing

## Acceptance criteria
- [ ] (mechanical) file exists
- [ ] (reviewer) no scope creep
- [ ] (human) ship when ready
- [ ] legacy untyped line

## Other
ignore
`;
    const dod = parseDefinitionOfDone(body);
    expect(dod.hasSection).toBe(true);
    expect(dod.criteria).toHaveLength(4);
    expect(dod.criteria.map((c) => c.kind)).toEqual([
      'mechanical',
      'reviewer',
      'human',
      'human',
    ]);
    expect(dod.needsReviewer).toBe(true);
    expect(dod.needsHuman).toBe(true);
    expect(dod.warnings.some((w) => w.includes('untyped'))).toBe(true);
  });

  it('accepts Chinese kind aliases', () => {
    const dod = parseDefinitionOfDone(`
## Acceptance criteria
- [ ] （机检）字数足够
- [ ] (审稿) 有戏
`);
    expect(dod.criteria.map((c) => c.kind)).toEqual(['mechanical', 'reviewer']);
  });

  it('parses checkpoint kind (EN + 中文) and sets needsHuman', () => {
    const en = parseDefinitionOfDone(`
## Acceptance criteria
- [ ] (checkpoint) before deploy: confirm staging URL
- [ ] (mechanical) gates green @gate:test
`);
    expect(en.criteria.map((c) => c.kind)).toEqual(['checkpoint', 'mechanical']);
    expect(en.needsHuman).toBe(true);

    const zh = parseDefinitionOfDone(`
## Acceptance criteria
- [ ] （检查点）before merge: 确认截图
`);
    expect(zh.criteria.map((c) => c.kind)).toEqual(['checkpoint']);
    expect(zh.needsHuman).toBe(true);

    const colon = parseDefinitionOfDone(`
## Acceptance criteria
- [ ] checkpoint: before step: look at phone
`);
    expect(colon.criteria[0]?.kind).toBe('checkpoint');
  });

  it('parses ## Definition of Done (logout-style body)', () => {
    const dod = parseDefinitionOfDone(`
把底栏 Logout 改成 Settings

## Definition of Done
- [ ] (mechanical) 底栏为 Settings
- [ ] (mechanical) 语言 en/zh
- [ ] (human) 真机验收

## Review packet
### x
ignore
`);
    expect(dod.hasSection).toBe(true);
    expect(dod.hasMechanical).toBe(true);
    expect(dod.criteria).toHaveLength(3);
    expect(dod.criteria.map((c) => c.kind)).toEqual(['mechanical', 'mechanical', 'human']);
    expect(dod.criteria[0]?.text).toMatch(/Settings/);
  });
});

describe('shouldRunReviewer', () => {
  const base = {
    gatesPassed: true,
    reviewerAvailable: true,
    noFileChanges: false,
  };

  it('runs when DoD has reviewer criteria', () => {
    const dod = parseDefinitionOfDone(`
## Acceptance criteria
- [ ] (reviewer) quality ok
`);
    expect(shouldRunReviewer({ ...base, dod })).toBe(true);
  });

  it('runs for non-trivial diffs without a DoD section', () => {
    const dod = parseDefinitionOfDone('no section');
    expect(shouldRunReviewer({ ...base, dod })).toBe(true);
  });

  it('runs for any changeful green run (including mechanical/human only)', () => {
    const dod = parseDefinitionOfDone(`
## Acceptance criteria
- [ ] (mechanical) tests pass
- [ ] (human) look good
`);
    expect(shouldRunReviewer({ ...base, dod })).toBe(true);
  });

  it('skips on no file changes or disabled', () => {
    const dod = parseDefinitionOfDone(`
## Acceptance criteria
- [ ] (reviewer) x
`);
    expect(shouldRunReviewer({ ...base, dod, noFileChanges: true })).toBe(false);
    expect(shouldRunReviewer({ ...base, dod, reviewerDisabled: true })).toBe(false);
  });
});

describe('buildDodDimensions + auto-rework', () => {
  it('marks human pending and auto-reworks on L3 fail', () => {
    const dod = parseDefinitionOfDone(`
## Acceptance criteria
- [ ] (mechanical) gates green @gate:test
- [ ] (reviewer) spirit
- [ ] (human) ship
`);
    const dims = buildDodDimensions({
      dod,
      gatesPassed: true,
      noFileChanges: false,
      reviewerVerdict: { approved: false },
      reviewerRan: true,
      gateNames: ['test'],
    });
    expect(dims.mechanical).toBe('pass');
    expect(dims.reviewer).toBe('fail');
    expect(dims.human).toBe('pending');
    expect(dims.criteria.find((c) => c.kind === 'mechanical')?.proof).toMatch(/regression: gate/);
    expect(shouldAutoRework({ dimensions: dims, noFileChanges: false })).toBe(true);
    expect(isAutomatedGreen(dims)).toBe(false);
  });

  it('checkpoint criteria stay pending with human-confirm proof; human axis pending', () => {
    const dod = parseDefinitionOfDone(`
## Acceptance criteria
- [ ] (checkpoint) before deploy: confirm URL
- [ ] (reviewer) ok
`);
    const dims = buildDodDimensions({
      dod,
      gatesPassed: true,
      noFileChanges: false,
      reviewerVerdict: { approved: true },
      reviewerRan: true,
    });
    const cp = dims.criteria.find((c) => c.kind === 'checkpoint');
    expect(cp?.status).toBe('pending');
    expect(cp?.proof).toBe('human confirm before step');
    expect(dims.human).toBe('pending');
  });

  it('is automated-green when L3 approves and gates pass', () => {
    const dod = parseDefinitionOfDone(`
## Acceptance criteria
- [ ] (reviewer) ok
`);
    const dims = buildDodDimensions({
      dod,
      gatesPassed: true,
      noFileChanges: false,
      reviewerVerdict: { approved: true },
      reviewerRan: true,
    });
    expect(isAutomatedGreen(dims)).toBe(true);
    expect(shouldAutoRework({ dimensions: dims, noFileChanges: false })).toBe(false);
  });

  it('mechanical pending is not automated-green and does not auto-rework', () => {
    const dod = parseDefinitionOfDone(`
## Acceptance criteria
- [ ] (mechanical) pnpm check:full green
- [ ] (reviewer) ok
`);
    const dims = buildDodDimensions({
      dod,
      gatesPassed: true,
      noFileChanges: false,
      reviewerVerdict: { approved: true },
      reviewerRan: true,
      gateNames: ['test'],
    });
    expect(dims.mechanical).toBe('pending');
    expect(isAutomatedGreen(dims)).toBe(false);
    expect(shouldAutoRework({ dimensions: dims, noFileChanges: false })).toBe(false);
  });

  it('fails mechanical + auto-reworks on L2 behavioral fail (G1)', () => {
    const dod = parseDefinitionOfDone(`
## Acceptance criteria
- [ ] (mechanical) ui hooks @evidence:nav-settings
- [ ] (reviewer) ok
`);
    const dims = buildDodDimensions({
      dod,
      gatesPassed: true,
      noFileChanges: false,
      reviewerVerdict: { approved: true },
      reviewerRan: true,
      behavioralFailed: true,
      evidenceOk: false,
      evidenceStepDetails: [],
    });
    expect(dims.mechanical).toBe('fail');
    expect(shouldAutoRework({ dimensions: dims, noFileChanges: false, behavioralFailed: true })).toBe(
      true,
    );
    expect(isAutomatedGreen(dims)).toBe(false);
  });

  it('fails mechanical + auto-reworks on critical L5 (G4)', () => {
    const dod = parseDefinitionOfDone(`
## Acceptance criteria
- [ ] (reviewer) ok
`);
    const dims = buildDodDimensions({
      dod,
      gatesPassed: true,
      noFileChanges: false,
      reviewerVerdict: { approved: true },
      reviewerRan: true,
      hasCriticalCheats: true,
    });
    expect(dims.mechanical).toBe('fail');
    expect(
      shouldAutoRework({ dimensions: dims, noFileChanges: false, hasCriticalCheats: true }),
    ).toBe(true);
  });

  it('auto-reworks on prConflicting even for empty-diff steers', () => {
    const dod = parseDefinitionOfDone(`
## Acceptance criteria
- [ ] (human) ship
`);
    const dims = buildDodDimensions({
      dod,
      gatesPassed: false,
      noFileChanges: true,
      reviewerVerdict: null,
      reviewerRan: false,
      reviewerSkipReason: 'no file changes (read-only / Q&A)',
    });
    // Soft no-diff alone must not loop forever…
    expect(shouldAutoRework({ dimensions: dims, noFileChanges: true })).toBe(false);
    // …but an open PR still CONFLICTING must re-queue (settings-build false claim).
    expect(
      shouldAutoRework({ dimensions: dims, noFileChanges: true, prConflicting: true }),
    ).toBe(true);
    // …and base-drift hard conflict must re-queue too (never merge to main).
    expect(
      shouldAutoRework({ dimensions: dims, noFileChanges: true, baseDriftConflict: true }),
    ).toBe(true);
  });

  it('reviewer disabled / no runner with a real diff → skipped (never n/a)', () => {
    const dod = parseDefinitionOfDone(`
## Acceptance criteria
- [ ] (mechanical) gates green @gate:test
- [ ] (human) ship
`);
    const disabled = buildDodDimensions({
      dod,
      gatesPassed: true,
      noFileChanges: false,
      reviewerVerdict: null,
      reviewerRan: false,
      reviewerSkipReason: 'L3 disabled (HERCULES_REVIEWER=0)',
      gateNames: ['test'],
    });
    expect(disabled.reviewer).toBe('skipped');
    expect(isAutomatedGreen(disabled)).toBe(false);

    const noRunner = buildDodDimensions({
      dod,
      gatesPassed: true,
      noFileChanges: false,
      reviewerVerdict: null,
      reviewerRan: false,
      reviewerSkipReason: 'no L3 runner configured',
      gateNames: ['test'],
    });
    expect(noRunner.reviewer).toBe('skipped');
    expect(isAutomatedGreen(noRunner)).toBe(false);
  });

  it('no file changes still yields reviewer n/a', () => {
    const dod = parseDefinitionOfDone(`
## Acceptance criteria
- [ ] (human) ship
`);
    const dims = buildDodDimensions({
      dod,
      gatesPassed: true,
      noFileChanges: true,
      reviewerVerdict: null,
      reviewerRan: false,
      reviewerSkipReason: 'no file changes (read-only / Q&A)',
    });
    expect(dims.reviewer).toBe('n/a');
  });
});

describe('human AC acknowledge gate (approve chokepoint)', () => {
  const bodyWithHuman = `
## Task
Ship readiness

## Definition of Done
- [ ] (mechanical) gates green
- [ ] (human) Spot-check README; set repo readiness to **ready**
- [ ] (human) Phone UX ok on device
`;

  it('lists only human-axis criterion texts', () => {
    expect(listHumanCriteriaTexts(bodyWithHuman)).toEqual([
      'Spot-check README; set repo readiness to **ready**',
      'Phone UX ok on device',
    ]);
  });

  it('includes checkpoint texts in the acknowledge list', () => {
    const body = `
## Definition of Done
- [ ] (checkpoint) before deploy: confirm staging
- [ ] (human) Phone UX ok
- [ ] (mechanical) gates @gate:test
`;
    expect(listHumanCriteriaTexts(body)).toEqual([
      'before deploy: confirm staging',
      'Phone UX ok',
    ]);
    expect(missingHumanAcknowledgements(body, [])).toEqual([
      'before deploy: confirm staging',
      'Phone UX ok',
    ]);
    expect(
      missingHumanAcknowledgements(body, ['before deploy: confirm staging', 'Phone UX ok']),
    ).toEqual([]);
  });

  it('returns empty list when no human criteria (approve may proceed)', () => {
    const body = `
## Definition of Done
- [ ] (mechanical) tests pass
`;
    expect(listHumanCriteriaTexts(body)).toEqual([]);
    expect(missingHumanAcknowledgements(body, [])).toEqual([]);
  });

  it('reports missing acknowledgements until every human AC is checked', () => {
    expect(missingHumanAcknowledgements(bodyWithHuman, [])).toHaveLength(2);
    expect(
      missingHumanAcknowledgements(bodyWithHuman, [
        'Spot-check README; set repo readiness to **ready**',
      ]),
    ).toEqual(['Phone UX ok on device']);
    expect(
      missingHumanAcknowledgements(bodyWithHuman, [
        'Spot-check README; set repo readiness to **ready**',
        'Phone UX ok on device',
      ]),
    ).toEqual([]);
  });

  it('treats untyped DoD bullets as human (must acknowledge)', () => {
    const body = `
## Acceptance criteria
- [ ] looks good on phone
`;
    expect(listHumanCriteriaTexts(body)).toEqual(['looks good on phone']);
    expect(missingHumanAcknowledgements(body, [])).toEqual(['looks good on phone']);
  });
});

describe('hasCheckableCriteria (SPEC §9.4 plan-first gate)', () => {
  it('true when a recognized section carries at least one criterion', () => {
    expect(
      hasCheckableCriteria('## Task\nfix it\n\n## Acceptance criteria\n- [ ] (mechanical) `pnpm test` green\n'),
    ).toBe(true);
    expect(
      hasCheckableCriteria('## Definition of Done\n- (reviewer) no scope creep\n'),
    ).toBe(true);
  });

  it('false for an empty body, no section, or a section with no items', () => {
    expect(hasCheckableCriteria('')).toBe(false);
    expect(hasCheckableCriteria('## Task\njust do the thing quickly\n')).toBe(false);
    expect(hasCheckableCriteria('## Acceptance criteria\n\n(some prose, no bullets)\n')).toBe(false);
  });
});

describe('DoD table must not contradict the behavioral gate row', () => {
  it('mechanical axis is skipped (not pass) when L2 was expected but never ran', () => {
    // Unbound mechanical rows are pending (never pass); behavioralMissing
    // still outranks them to skipped so missing L2 does not auto-rework.
    const body = `## Definition of Done
- [ ] (mechanical) pnpm check:full green
- [ ] (mechanical) 行为证据步骤全过 (见 ## Evidence)
- [ ] (human) 手机上看着对
`;
    const dod = buildDodDimensions({
      dod: parseDefinitionOfDone(body),
      gatesPassed: true,
      noFileChanges: false,
      reviewerRan: true,
      reviewerVerdict: { approved: true },
      deliveryFailed: false,
      behavioralFailed: false,
      behavioralMissing: true,
      hasCriticalCheats: false,
      gateNames: ['setup', 'typecheck', 'lint', 'test', 'build'],
      evidenceOk: null,
      evidenceStepDetails: [],
      filesTouched: ['src/web/App.tsx'],
      selfAssessment: '- **行为证据步骤全过** — 本地跑过',
    });
    expect(dod.criteria.filter((c) => c.kind === 'mechanical').every((c) => c.status === 'pending')).toBe(
      true,
    );
    expect(dod.mechanical).not.toBe('pass');
    expect(dod.mechanical).toBe('skipped');
    expect(isAutomatedGreen(dod)).toBe(false);
    // Environmental absence of proof must not burn an attempt.
    expect(
      shouldAutoRework({ dimensions: dod, noFileChanges: false, behavioralFailed: false }),
    ).toBe(false);
  });
});

describe('evidence-criterion-precision (unbound evidence AC never self-greens)', () => {
  it('marks unbound evidence-like mechanical AC as pending with suggestion', () => {
    // L2 green on default settings plan must not prove a 降级/死因 criterion.
    const body = `## Definition of Done
- [ ] (mechanical) pnpm check:full green
- [ ] (mechanical) L2 证据: 降级说明与死因文本被 assert 命中 + 截图
- [ ] (human) 手机上点徽章一眼看懂
`;
    const dod = buildDodDimensions({
      dod: parseDefinitionOfDone(body),
      gatesPassed: true,
      noFileChanges: false,
      reviewerRan: true,
      reviewerVerdict: { approved: true },
      deliveryFailed: false,
      behavioralFailed: false,
      behavioralMissing: false,
      hasCriticalCheats: false,
      gateNames: ['test'],
      evidenceOk: true,
      evidenceStepDetails: [
        'click click [data-evidence=nav-settings] ok',
        'assert assert sel=[data-evidence=settings-panel] Language|语言 ok',
        'screenshot screenshot settings-sheet settings-sheet.png',
      ],
      filesTouched: ['src/domain/mechProof.ts'],
      selfAssessment: '- **L2 证据** — steps green',
    });
    const evidenceCrit = dod.criteria.find((c) => c.text.includes('降级'));
    expect(evidenceCrit?.kind).toBe('mechanical');
    expect(evidenceCrit?.status).toBe('pending');
    expect(evidenceCrit?.proof).toBe('unbound');
    expect(dod.warnings.some((w) => /unbound mechanical criterion/.test(w))).toBe(true);
    // Gate-like unbound also pending (honest: no @gate: binding).
    expect(dod.criteria.find((c) => /pnpm check/.test(c.text))?.status).toBe('pending');
    expect(dod.mechanical).toBe('pending');
    expect(
      shouldAutoRework({ dimensions: dod, noFileChanges: false, behavioralFailed: false }),
    ).toBe(false);
  });
});

describe('listHumanCriteriaTexts strips @scenario bindings (Grok R17 N3)', () => {
  it('returns the same text the decision card shows', () => {
    const body = [
      '## Definition of Done',
      '- [ ] (human) Owner watched the recorded scenario video @scenario:chat-sheet-scroll-lock',
      '- [ ] (mechanical) Tests pass @gate:test',
      '',
    ].join('\n');
    expect(listHumanCriteriaTexts(body)).toEqual(['Owner watched the recorded scenario video']);
  });
});

describe('planPendingReasonFor', () => {
  it('returns bilingual PLAN_PENDING_REASON when planPending', () => {
    expect(planPendingReasonFor({ planPending: true })).toEqual(PLAN_PENDING_REASON);
    expect(PLAN_PENDING_REASON.en.length).toBeGreaterThan(20);
    expect(PLAN_PENDING_REASON.zh.length).toBeGreaterThan(10);
  });

  it('returns null when not planPending', () => {
    expect(planPendingReasonFor({ planPending: false })).toBeNull();
  });
});
