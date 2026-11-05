/**
 * Structured DecisionCard: the verifier holds every fact the CEO asks for
 * (purpose, touched areas, boundaries, per-criterion status + WHY) but used
 * to flatten them into prose that the UI re-parsed. The card is embedded as
 * a machine block in the task body at verify time — single file, git-audited,
 * zero re-parsing (2026-07-24).
 *
 * Boundary badges must self-explain (green + yellow); cross-task lists
 * sha/subject/taskId evidence (boundary-badge-why, 2026-07-24).
 */
import { describe, it, expect } from 'vitest';
import {
  buildDecisionCard,
  renderDecisionCardBlock,
  parseDecisionCard,
  stripDecisionCardBlocks,
  classifyAreas,
  unprovenUiFromTaskBody,
  explainBoundaryBadges,
  parseForeignTaskCommits,
  collectReviewOnlyFlags,
  reviewOnlyFlagMeaningZh,
} from '../../src/domain/decisionCard.js';

const input = {
  taskBody: '## Goal\nSolid WORKFLOW for orbit.\n\n## Task\n1. do it\n',
  branch: 'hercules/R2',
  filesTouched: ['core/src/learning.rs', 'core/src/main.rs', 'WORKFLOW.md', 'scripts/x.sh'],
  cheatFindings: [{ kind: 'test-edit' as const, file: 't.rs', detail: 'poll' }],
  evidenceMatrix: [
    { text: 'All WORKFLOW L1 gates green', kind: 'mechanical' as const, status: 'pass', evidence: 'typecheck OK; 5973 tests passed' },
    { text: 'Packet evidence trustworthy', kind: 'human' as const, status: 'pending', evidence: '(human判断)' },
  ],
  gates: [
    { name: 'test', command: 't', passed: true, output: 'ok' },
    { name: 'behavioral', command: 'hercules:l2-evidence', passed: false, output: 'L2 declared… 具体原因:缺 auth_token。' },
  ],
  evidenceRan: false,
  evidenceOk: null,
  evidenceSteps: 0,
  evidenceSkipReason: '缺 auth_token',
  reviewerRan: true,
  reviewerApproved: true,
  reviewerSummaryZh: '把检查命令写清楚了',
};

describe('classifyAreas (generic, works for any repo)', () => {
  it('groups by top segment, two segments under src/', () => {
    expect(classifyAreas(['src/web/App.tsx', 'src/web/x.ts', 'core/src/a.rs', 'WORKFLOW.md'])).toEqual([
      { area: 'src/web', count: 2 },
      { area: 'core', count: 1 },
      { area: '(root)', count: 1 },
    ]);
  });
});

describe('buildDecisionCard + embed roundtrip', () => {
  it('flags placeholder-evidence-hook on the decision-card review-only pills', () => {
    const card = buildDecisionCard({
      ...input,
      // Override default input cheatFindings so only the placeholder is present.
      cheatFindings: [
        {
          kind: 'placeholder-evidence-hook',
          detail: '新增 data-evidence 元素可见文本为占位常量,疑似无真实功能',
        },
      ],
    });
    expect(card.reviewOnlyFlags.map((f) => f.kind)).toContain('placeholder-evidence-hook');
    expect(
      card.reviewOnlyFlags.find((f) => f.kind === 'placeholder-evidence-hook')?.meaningZh,
    ).toMatch(/占位|data-evidence|无真实功能/);
    expect(card.boundaries.testsEdited).toBe(false);
  });

  it('captures purpose, areas, boundaries, per-criterion why', () => {
    const card = buildDecisionCard(input);
    expect(card.purpose).toBe('Solid WORKFLOW for orbit.');
    expect(card.areas.map((a) => a.area)).toContain('core');
    expect(card.boundaries.branch).toBe('hercules/R2');
    expect(card.boundaries.testsEdited).toBe(true);
    expect(card.boundaries.protectedPathsTouched).toBe(false);
    expect(card.criteria[0]).toMatchObject({ kind: 'mechanical', status: 'pass' });
    expect(card.criteria[0]!.why).toMatch(/5973/);
    expect(card.evidence).toMatchObject({ ran: false, skipReason: '缺 auth_token' });
    expect(card.reviewer).toMatchObject({ ran: true, approved: true });
  });

  it('propagates unproven UI AC warning from the evidence matrix', () => {
    const card = buildDecisionCard({
      ...input,
      evidenceMatrix: [
        {
          text: '手机上点黄色跨任务徽章, 一眼看懂为什么黄',
          kind: 'human' as const,
          status: 'pending',
          evidence: '(no evidence cited)',
          unprovenUiWarning: '⚠ 该人工项无对应证据步骤——你无法在部署前核验',
          unprovenUiReason: '缺 click/assert/screenshot 覆盖徽章',
        },
      ],
    });
    const human = card.criteria[0]!;
    expect(human.unprovenUiWarning).toMatch(/无对应证据/);
    expect(human.unprovenUiReason).toMatch(/徽章|screenshot|click/);

    const body = `## Task\n\n${renderDecisionCardBlock(card)}\n`;
    expect(parseDecisionCard(body)).not.toBeNull();
    const u = unprovenUiFromTaskBody(body);
    expect(u?.warning).toMatch(/无对应证据/);
    expect(u?.reason).toMatch(/徽章|screenshot|click/);
    expect(unprovenUiFromTaskBody('## no card')).toBeNull();
  });

  it('human criteria get how/refs from real sources only (no inventing)', () => {
    const withChecklist = buildDecisionCard({
      ...input,
      taskBody: [
        '## Goal',
        'Close human loop',
        '',
        '## Operator checklist',
        'Open docs/agent/hercules-readiness-operator-checklist.md and run the 2-3 min path',
        '',
        '## Definition of Done',
        '- [ ] (human) Spot-check passed',
      ].join('\n'),
      filesTouched: [
        ...input.filesTouched,
        'docs/agent/hercules-readiness-operator-checklist.md',
      ],
      evidenceMatrix: [
        {
          text: 'Spot-check passed',
          kind: 'human' as const,
          status: 'pending',
          evidence: '(no evidence cited)',
        },
      ],
    });
    const human = withChecklist.criteria[0]!;
    expect(human.how).toMatch(/2-3 min path/);
    expect(human.refs).toContain('docs/agent/hercules-readiness-operator-checklist.md');

    const bare = buildDecisionCard(input);
    const bareHuman = bare.criteria.find((c) => c.kind === 'human')!;
    expect(bareHuman.how).toBeUndefined();
    expect(bareHuman.refs).toBeUndefined();
  });

  it('roundtrips through the embedded block; strip removes it from display text', () => {
    const card = buildDecisionCard(input);
    const body = `## Task\nx\n${renderDecisionCardBlock(card)}`;
    const parsed = parseDecisionCard(body);
    expect(parsed).toEqual(card);
    expect(stripDecisionCardBlocks(body)).not.toMatch(/hercules:decision-card/);
    // Latest block wins when re-verification appends a second card.
    const twice = `${body}\n${renderDecisionCardBlock({ ...card, purpose: 'newer' })}`;
    expect(parseDecisionCard(twice)!.purpose).toBe('newer');
  });

  it('parse returns null for bodies without a card (old packets)', () => {
    expect(parseDecisionCard('## Task\nplain')).toBeNull();
  });

  it('failed gate reason names the cargo failure, not a progress line', () => {
    const cargoTail = `
   Compiling orbit-core v0.4.2
    Finished \`test\` profile [unoptimized + debuginfo] target(s) in 42.11s
     Running unittests src/lib.rs

running 5986 tests
test memory::tests::snapshot_roundtrip ... ok

failures:

---- memory::tests::circuit_breaker_event_emitted_on_trip stdout ----
assertion \`left == right\` failed
  left: 0
 right: 1

failures:
    memory::tests::circuit_breaker_event_emitted_on_trip

test result: FAILED. 5972 passed; 1 failed; 13 ignored; 0 measured; 0 filtered out; finished in 38.20s
`;
    const card = buildDecisionCard({
      ...input,
      gates: [
        { name: 'lint', command: 'lint', passed: true, output: 'ok' },
        { name: 'test', command: 'test', passed: false, output: cargoTail },
      ],
    });
    const failing = card.gates.find((g) => g.name === 'test');
    expect(failing).toMatchObject({ passed: false });
    expect(failing!.reason).toContain('circuit_breaker_event_emitted_on_trip');
    expect(failing!.reason).not.toContain('running 5986 tests');
    const passing = card.gates.find((g) => g.name === 'lint');
    expect(passing).toEqual({ name: 'lint', passed: true });
    expect(passing).not.toHaveProperty('reason');
  });

  it('embeds crossTaskCommits (sha+subject+taskId); empty when none', () => {
    const clean = buildDecisionCard({ ...input, cheatFindings: [] });
    expect(clean.boundaries.crossTaskCommits).toEqual([]);
    expect(clean.boundaries.crossTaskIds).toEqual([]);
    expect(clean.reviewOnlyFlags).toEqual([]);

    const commits = [
      {
        sha: 'eb2182c0abcdef0123456789abcdef0123456789',
        subject: 'hercules: ORBIT-READINESS-R2-WORKFLOW — verified state',
        taskId: 'ORBIT-READINESS-R2-WORKFLOW',
      },
      {
        sha: 'a33ce578abcdef0123456789abcdef0123456789',
        subject: 'hercules: ORBIT-READINESS-R2-WORKFLOW — verified state',
        taskId: 'ORBIT-READINESS-R2-WORKFLOW',
      },
    ];
    const dirty = buildDecisionCard({
      ...input,
      cheatFindings: [
        {
          kind: 'cross-task-commits',
          detail:
            'commits attributed to other tasks aboard: ORBIT-READINESS-R2-WORKFLOW — lineage crosses',
        },
      ],
      crossTaskCommits: commits,
    });
    expect(dirty.boundaries.crossTaskCommits).toEqual(commits);
    expect(dirty.boundaries.crossTaskIds).toEqual(['ORBIT-READINESS-R2-WORKFLOW']);
    expect(dirty.reviewOnlyFlags).toEqual([
      {
        kind: 'cross-task-commits',
        meaningZh: reviewOnlyFlagMeaningZh('cross-task-commits'),
      },
    ]);
  });

  it('parses foreign commits from git-log lines (own id excluded)', () => {
    const lines = [
      'eb2182c0abcdef0123456789abcdef0123456789\thercules: ORBIT-READINESS-R2-WORKFLOW — verified state',
      'a33ce578abcdef0123456789abcdef0123456789\thercules: ORBIT-READINESS-R2-WORKFLOW — verified state',
      '1111111111111111111111111111111111111111\thercules: R4 — own work',
      '2222222222222222222222222222222222222222\tplain commit no hercules prefix',
      'not-a-sha\thercules: X — bad',
    ];
    const parsed = parseForeignTaskCommits(lines, 'R4');
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      sha: 'eb2182c0abcdef0123456789abcdef0123456789',
      subject: 'hercules: ORBIT-READINESS-R2-WORKFLOW — verified state',
      taskId: 'ORBIT-READINESS-R2-WORKFLOW',
    });
    expect(parsed[1]!.taskId).toBe('ORBIT-READINESS-R2-WORKFLOW');
    expect(parseForeignTaskCommits([], 'R4')).toEqual([]);
  });
});

describe('explainBoundaryBadges (green + yellow copy)', () => {
  const base = {
    branch: 'hercules/R4',
    protectedPathsTouched: false,
    testsEdited: false,
    crossTaskIds: [] as string[],
    crossTaskCommits: [] as {
      sha: string;
      subject: string;
      taskId: string;
    }[],
  };

  it('all-green: four badges explain what was checked + clean actual', () => {
    const badges = explainBoundaryBadges(base);
    expect(badges).toHaveLength(4);
    expect(badges.every((b) => !b.warn)).toBe(true);
    // Keys match L2 data-evidence: boundary-badge-{key}
    expect(badges.map((b) => b.key)).toEqual([
      'branch',
      'protected',
      'tests',
      'cross',
    ]);
    const pick = (k: string) => badges.find((b) => b.key === k)!;
    expect(pick('branch').label).toMatch(/仅任务分支/);
    expect(pick('branch').what).toMatch(/主干/);
    expect(pick('branch').actual).toContain('hercules/R4');
    expect(pick('protected').label).toMatch(/✓ 保护路径/);
    expect(pick('protected').actual).toMatch(/未触及/);
    expect(pick('tests').label).toMatch(/✓ 测试未动/);
    expect(pick('tests').actual).toMatch(/未改动测试/);
    expect(pick('cross').label).toMatch(/✓ 无跨任务/);
    expect(pick('cross').actual).toMatch(/均归属本任务/);
  });

  it('yellow states: protected / tests / cross-task with commit evidence', () => {
    const badges = explainBoundaryBadges({
      ...base,
      protectedPathsTouched: true,
      testsEdited: true,
      crossTaskIds: ['ORBIT-READINESS-R2-WORKFLOW'],
      crossTaskCommits: [
        {
          sha: 'eb2182c0abcdef0123456789abcdef0123456789',
          subject: 'hercules: ORBIT-READINESS-R2-WORKFLOW — verified state',
          taskId: 'ORBIT-READINESS-R2-WORKFLOW',
        },
      ],
    });
    const pick = (k: string) => badges.find((b) => b.key === k)!;
    expect(pick('protected').warn).toBe(true);
    expect(pick('protected').label).toMatch(/⚠ 保护路径/);
    expect(pick('protected').actual).toMatch(/保护路径/);
    expect(pick('tests').warn).toBe(true);
    expect(pick('tests').label).toMatch(/⚠ 测试有改动/);
    expect(pick('cross').warn).toBe(true);
    expect(pick('cross').label).toContain('ORBIT-READINESS-R2-WORKFLOW');
    expect(pick('cross').actual).toContain('eb2182c0');
    expect(pick('cross').actual).toContain('verified state');
    expect(pick('cross').actual).toContain('ORBIT-READINESS-R2-WORKFLOW');
    // Never point at a non-existent "发现" / off-card section.
    expect(pick('cross').actual).not.toMatch(/见发现|见分支历史|出处见/);
  });

  it('cross-task ids without commits: self-contained, no off-card pointer', () => {
    const badges = explainBoundaryBadges({
      ...base,
      crossTaskIds: ['R2', 'R1'],
      crossTaskCommits: [],
    });
    const cross = badges.find((b) => b.key === 'cross')!;
    expect(cross.warn).toBe(true);
    expect(cross.actual).toContain('R2');
    expect(cross.actual).toContain('R1');
    expect(cross.actual).not.toMatch(/见分支历史|见发现|出处见|见\s*\w/);
  });
});

describe('collectReviewOnlyFlags', () => {
  it('names kind + zh meaning once per kind (not bare count)', () => {
    const flags = collectReviewOnlyFlags([
      { kind: 'test-edit' },
      { kind: 'test-edit' },
      { kind: 'cross-task-commits' },
      { kind: 'as-any' }, // critical — excluded from review-only list
    ]);
    expect(flags).toEqual([
      { kind: 'test-edit', meaningZh: reviewOnlyFlagMeaningZh('test-edit') },
      {
        kind: 'cross-task-commits',
        meaningZh: reviewOnlyFlagMeaningZh('cross-task-commits'),
      },
    ]);
    expect(flags.every((f) => f.meaningZh.length > 4)).toBe(true);
  });
});
