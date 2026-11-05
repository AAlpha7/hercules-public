/**
 * C3.32 — pure operator-first review verdict rules.
 */
import { describe, it, expect } from 'vitest';
import {
  renderDecisionCardBlock,
  type DecisionCard,
} from '../../src/domain/decisionCard.js';
import {
  buildReviewVerdict,
  reviewPrimaryDisabledReason,
} from '../../src/web/reviewVerdict.js';
import type { EvidenceMedia } from '../../src/web/taskBodySplit.js';

const BRANCH = 'hercules/verdict-1';

function baseCard(overrides: Partial<DecisionCard> = {}): DecisionCard {
  return {
    v: 1,
    purpose: 'Operator-first review',
    areas: [{ area: 'src/web', count: 1 }],
    filesTouched: 2,
    reviewOnlyFlags: [],
    criteria: [],
    gates: [
      { name: 'typecheck', passed: true },
      { name: 'test', passed: true },
    ],
    evidence: { ran: true, ok: true, steps: 2 },
    boundaries: {
      branch: BRANCH,
      protectedPathsTouched: false,
      testsEdited: false,
      crossTaskIds: [],
      crossTaskCommits: [],
    },
    reviewer: { ran: true, approved: true },
    ...overrides,
  };
}

function greenBody(extra = ''): string {
  return `## Goal
Ship.

## Definition of Done
- [ ] (mechanical) tests pass

## Review packet
**✅ automated proof complete**

**Gates**
- ✅ typecheck
- ✅ test
${extra}
${renderDecisionCardBlock(baseCard())}
`;
}

describe('buildReviewVerdict', () => {
  it('green + no human + no unverified → approve', () => {
    const v = buildReviewVerdict({
      task: { body: greenBody() },
      decisionCard: baseCard(),
      autoOk: true,
      verifyCrashed: false,
      humanACs: [],
      media: [],
    });
    expect(v.headline).toBe('机器检查全部通过，可以批准。');
    expect(v.action).toEqual({ kind: 'approve', label: '批准' });
    expect(v.needsYou).toEqual([]);
  });

  it('green + human without video → confirm_items', () => {
    const card = baseCard({
      criteria: [
        {
          text: 'Spot-check on device',
          kind: 'human',
          status: 'pending',
          why: 'pending human',
        },
      ],
    });
    const v = buildReviewVerdict({
      task: { body: greenBody() },
      decisionCard: card,
      autoOk: true,
      verifyCrashed: false,
      humanACs: [{ id: 'h0', text: 'Spot-check on device' }],
      media: [],
    });
    expect(v.headline).toBe('机器检查全部通过。请确认 1 项后批准。');
    expect(v.action.kind).toBe('confirm_items');
    expect(v.needsYou).toHaveLength(1);
    expect(v.needsYou[0]!.kind).toBe('human');
    expect(v.needsYou[0]!.why).toMatch(/^这项只有人能判断：/);
    expect(v.needsYou[0]!.recommendation).toMatch(/勾选/);
  });

  it('green + human linked to video → watch_then_approve', () => {
    const media: EvidenceMedia[] = [
      {
        kind: 'video',
        name: 'cli-scroll-demo.webm',
        url: '/api/tasks/t/screenshots/cli-scroll-demo.webm',
        label: 'scroll demo',
        ok: true,
      },
    ];
    const card = baseCard({
      criteria: [
        {
          text: 'Watch the scroll recording',
          kind: 'human',
          status: 'pending',
          why: 'CLI 步骤 scroll ✓ · 0 张截图 · 1 段录像',
        },
      ],
    });
    const v = buildReviewVerdict({
      task: { body: greenBody() },
      decisionCard: card,
      autoOk: true,
      verifyCrashed: false,
      humanACs: [{ id: 'h0', text: 'Watch the scroll recording' }],
      media,
    });
    expect(v.action.kind).toBe('watch_then_approve');
    expect(v.headline).toMatch(/请看录像后批准/);
    expect(v.needsYou[0]!.evidence?.kind).toBe('video');
    expect(v.needsYou[0]!.evidence?.mediaIndex).toBe(0);
    expect(v.needsYou[0]!.recommendation).toBe('看完录像后勾选并批准');
  });

  it('green + unverified → list as unverified with confirm recommendation', () => {
    const card = baseCard({
      unverifiedCriteria: [
        {
          text: 'unit coverage',
          warning: '无法自动核验：测试门禁已通过，但其输出未包含 x.test.ts',
        },
      ],
      criteria: [
        {
          text: 'unit coverage',
          kind: 'mechanical',
          status: 'unverified',
          why: '无法自动核验',
        },
      ],
    });
    const v = buildReviewVerdict({
      task: { body: greenBody() },
      decisionCard: card,
      autoOk: true,
      verifyCrashed: false,
      humanACs: [],
      media: [],
    });
    expect(v.headline).toMatch(/其中 1 项无法自动核验，请你确认/);
    expect(v.needsYou).toHaveLength(1);
    expect(v.needsYou[0]!.kind).toBe('unverified');
    expect(v.needsYou[0]!.why).toMatch(/无法自动核验/);
    expect(v.needsYou[0]!.recommendation).toBe('确认后可直接批准');
  });

  it('green + human video + unverified → both in needsYou', () => {
    const media: EvidenceMedia[] = [
      {
        kind: 'video',
        name: 'demo.webm',
        url: '/x/demo.webm',
        label: 'demo',
        ok: true,
      },
    ];
    const card = baseCard({
      criteria: [
        {
          text: '看录像确认滚动',
          kind: 'human',
          status: 'pending',
          why: 'CLI 步骤 scroll ✓ · 1 张截图 · 1 段录像',
        },
        {
          text: 'unit coverage',
          kind: 'mechanical',
          status: 'unverified',
          why: '无法自动核验',
        },
      ],
      unverifiedCriteria: [
        {
          text: 'unit coverage',
          warning: '无法自动核验：输出未含文件名',
        },
      ],
    });
    const v = buildReviewVerdict({
      task: { body: greenBody() },
      decisionCard: card,
      autoOk: true,
      verifyCrashed: false,
      humanACs: [{ id: 'h0', text: '看录像确认滚动' }],
      media,
    });
    expect(v.needsYou).toHaveLength(2);
    expect(v.needsYou.map((n) => n.kind)).toEqual(['human', 'unverified']);
    expect(v.action.kind).toBe('watch_then_approve');
    expect(v.headline).toMatch(/请看录像后批准/);
    expect(v.headline).toMatch(/其中 1 项无法自动核验/);
  });

  it('not green → reject_or_override with plain reason', () => {
    const body = [
      '## Review packet',
      '**Status:** needs review',
      '',
      '**Gates**',
      '- ❌ behavioral',
      '  ```',
      '  L2 declared in WORKFLOW but produced no evidence — app was not machine-verified.',
      '  ```',
    ].join('\n');
    const v = buildReviewVerdict({
      task: { body },
      decisionCard: baseCard({
        gates: [{ name: 'behavioral', passed: false, reason: 'no evidence' }],
        evidence: { ran: true, ok: false, steps: 0 },
      }),
      autoOk: false,
      verifyCrashed: false,
      humanACs: [],
      media: [],
    });
    expect(v.action.kind).toBe('reject_or_override');
    expect(v.headline).toMatch(/^机器检查未通过：/);
    expect(v.headline).toMatch(/建议打回或 Re-verify/);
    expect(v.needsYou.length).toBeGreaterThan(0);
    expect(v.needsYou[0]!.kind).toBe('override');
  });

  it('crashed → reverify', () => {
    const v = buildReviewVerdict({
      task: { body: '## Review packet\nVerification failed: no worktree\n' },
      decisionCard: null,
      autoOk: false,
      verifyCrashed: true,
      humanACs: [],
      media: [],
    });
    expect(v.headline).toBe('验证未能运行（环境问题），请 Re-verify。');
    expect(v.action).toEqual({ kind: 'reverify', label: 'Re-verify' });
    expect(v.needsYou[0]!.kind).toBe('override');
  });

  it('unproven UI human → deploy-later recommendation', () => {
    const card = baseCard({
      criteria: [
        {
          text: '点开黄徽章',
          kind: 'human',
          status: 'pending',
          why: 'pending',
          unprovenUiWarning: '⚠ 该人工项无对应证据步骤——你无法在部署前核验',
        },
      ],
    });
    const v = buildReviewVerdict({
      task: { body: greenBody() },
      decisionCard: card,
      autoOk: true,
      verifyCrashed: false,
      humanACs: [{ id: 'h0', text: '点开黄徽章' }],
      media: [],
    });
    expect(v.needsYou[0]!.recommendation).toBe('无法在部署前核验，部署后再看');
  });

  it('screenshot human → open-screenshot recommendation', () => {
    const media: EvidenceMedia[] = [
      {
        kind: 'image',
        name: 'scene-a.png',
        url: '/x/scene-a.png',
        label: 'scene-a',
        ok: true,
      },
    ];
    const card = baseCard({
      criteria: [
        {
          text: '打开截图确认列表',
          kind: 'human',
          status: 'pending',
          why: 'pending',
        },
      ],
    });
    const v = buildReviewVerdict({
      task: { body: greenBody() },
      decisionCard: card,
      autoOk: true,
      verifyCrashed: false,
      humanACs: [{ id: 'h0', text: '打开截图确认列表' }],
      media,
    });
    expect(v.needsYou[0]!.recommendation).toBe('打开截图确认后勾选');
    expect(v.needsYou[0]!.evidence?.kind).toBe('image');
  });
});

describe('reviewPrimaryDisabledReason', () => {
  it('asks to check human items in ≤6 words', () => {
    expect(
      reviewPrimaryDisabledReason({
        actionKind: 'confirm_items',
        humanAllChecked: false,
        approveBlocked: true,
        verifyCrashed: false,
        autoOk: true,
      }),
    ).toBe('先勾选人工项');
  });

  it('null when not blocked', () => {
    expect(
      reviewPrimaryDisabledReason({
        actionKind: 'approve',
        humanAllChecked: true,
        approveBlocked: false,
        verifyCrashed: false,
        autoOk: true,
      }),
    ).toBeNull();
  });
});
