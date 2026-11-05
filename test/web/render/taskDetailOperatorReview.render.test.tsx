/**
 * C3.32 — operator-first review: verdict headline, one primary action,
 * needs-you only, machine details collapsed.
 */
import './setup.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  greenReviewBody,
  blockedReviewBody,
  makeTask,
  taskDetailDefaults,
} from './fixtures.js';
import {
  renderDecisionCardBlock,
  type DecisionCard,
} from '../../../src/domain/decisionCard.js';

vi.mock('../../../src/web/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/web/api.js')>();
  return {
    ...actual,
    fetchPrSummary: vi.fn().mockRejectedValue(new Error('no pr')),
    fetchTaskFiles: vi.fn().mockResolvedValue({ files: [] }),
    fetchTaskFile: vi.fn().mockResolvedValue({ content: '', truncated: false }),
    fetchBlobUrl: vi.fn().mockResolvedValue('blob:mock-evidence'),
    editRepo: vi.fn(),
  };
});

import { TaskDetail } from '../../../src/web/TaskDetail.js';

const TASK_ID = 'operator-review-1';
const NONCE = '0123456789abcdef0123456789abcdef';

function card(overrides: Partial<DecisionCard> = {}): DecisionCard {
  return {
    v: 1,
    purpose: 'Operator-first sheet',
    areas: [{ area: 'src/web', count: 1 }],
    filesTouched: 2,
    reviewOnlyFlags: [
      { kind: 'test-edit', meaningZh: '改动了测试文件，需确认测试仍在真正约束行为' },
    ],
    criteria: [
      {
        text: '看录像确认滚动',
        kind: 'human',
        status: 'pending',
        why: 'CLI 步骤 scroll ✓ · 0 张截图 · 1 段录像',
      },
      {
        text: 'unit coverage',
        kind: 'mechanical',
        status: 'unverified',
        why: '无法自动核验',
      },
    ],
    gates: [
      { name: 'typecheck', passed: true },
      { name: 'test', passed: true },
    ],
    evidence: { ran: true, ok: true, steps: 1 },
    boundaries: {
      branch: `hercules/${TASK_ID}`,
      protectedPathsTouched: false,
      testsEdited: true,
      crossTaskIds: ['other-task'],
      crossTaskCommits: [],
    },
    reviewer: { ran: true, approved: true },
    unverifiedCriteria: [
      {
        text: 'unit coverage',
        warning: '无法自动核验：输出未含文件名',
      },
    ],
    ...overrides,
  };
}

function operatorBody(): string {
  return `## Goal
Operator first.

## Definition of Done
- [ ] (human) 看录像确认滚动
- [ ] (mechanical) unit coverage

## Review packet

### ${TASK_ID} — \`hercules/${TASK_ID}\`
<!-- hercules:packet v1 nonce=${NONCE} -->
**✅ automated proof complete** (1 项无法自动核验，需人工确认 · human Approve still required if human ACs exist)

## 决策摘要

- **改动**:${TASK_ID}(2 个文件改动)
- **可信度**:门禁 2/2 绿 · 独立审稿:通过 · 浏览器行为证据 1 步通过
- **风险**:测试有改动

**Behavioral evidence**

- ✅ \`scroll\` — recorded
[video: demo.webm](/api/tasks/${TASK_ID}/screenshots/demo.webm)

<!-- hercules:packet-end nonce=${NONCE} -->
${renderDecisionCardBlock(card())}
`;
}

describe('TaskDetail operator-first review', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders headline + primary action above needs-you; machine details collapsed', () => {
    const task = makeTask({
      id: TASK_ID,
      body: operatorBody(),
      packetNonce: NONCE,
      state: 'review',
    });
    const { container } = render(<TaskDetail {...taskDetailDefaults(task)} />);

    const verdict = container.querySelector('[data-evidence="review-verdict"]');
    const primary = container.querySelector('[data-evidence="review-primary-action"]');
    const needs = container.querySelector('[data-evidence="review-needs-you"]');
    const machine = container.querySelector('[data-evidence="machine-details"]');

    expect(verdict?.textContent).toMatch(/All machine checks passed/);
    expect(verdict?.textContent).toMatch(/Watch the recording|could not be auto-verified/);
    expect(primary).toBeTruthy();
    expect(primary!.getAttribute('data-action-kind')).toBe('watch_then_approve');
    expect(needs).toBeTruthy();

    const kinds = [...needs!.querySelectorAll('[data-needs-kind]')].map((el) =>
      el.getAttribute('data-needs-kind'),
    );
    expect(kinds).toEqual(['human', 'unverified']);

    expect(machine).toBeTruthy();
    expect((machine as HTMLDetailsElement).open).toBe(false);
    expect(machine!.textContent).toMatch(/Machine check details/);

    // Boundary / anti-cheat facts live in collapsed machine details as neutral pills.
    expect(machine!.querySelector('[data-evidence="review-only-flags"]')).toBeTruthy();
    expect(machine!.textContent).toMatch(/Tests edited/);
    expect(machine!.textContent).toMatch(/Has other-task commits|No protected paths/);

    // Old lock copy gone.
    expect(screen.queryByText(/机器验证未全绿/)).toBeNull();

    // Decision card not above the fold outside machine-details.
    const cardEl = container.querySelector('[data-evidence="decision-card"]');
    expect(cardEl).toBeTruthy();
    expect(machine!.contains(cardEl!)).toBe(true);
  });

  it('green with no human items → approve headline', () => {
    const body = `## Goal
Done.

## Definition of Done
- [x] (mechanical) tests pass

## Review packet
**✅ automated proof complete**
`;
    const task = makeTask({ body, state: 'review' });
    const { container } = render(<TaskDetail {...taskDetailDefaults(task)} />);
    expect(
      container.querySelector('.review-verdict-headline')?.textContent,
    ).toBe('All machine checks passed — ready to approve.');
    expect(
      container
        .querySelector('[data-evidence="review-primary-action"]')
        ?.getAttribute('data-action-kind'),
    ).toBe('approve');
    expect(container.querySelector('[data-evidence="review-needs-you"]')).toBeNull();
  });

  it('not green → reject_or_override headline without 机器验证未全绿 lock copy', () => {
    const task = makeTask({ body: blockedReviewBody(), state: 'review' });
    const { container } = render(<TaskDetail {...taskDetailDefaults(task)} />);
    const headline = container.querySelector('[data-evidence="review-verdict"]')?.textContent;
    expect(headline).toMatch(/^机器检查未通过：/);
    expect(headline).toMatch(/建议打回或 Re-verify/);
    expect(
      container
        .querySelector('[data-evidence="review-primary-action"]')
        ?.getAttribute('data-action-kind'),
    ).toBe('reject_or_override');
    expect(screen.queryByText(/机器验证未全绿/)).toBeNull();
  });

  it('needs-you evidence link opens the gallery lightbox', async () => {
    const user = userEvent.setup();
    const task = makeTask({
      id: TASK_ID,
      body: operatorBody(),
      packetNonce: NONCE,
      state: 'review',
    });
    render(<TaskDetail {...taskDetailDefaults(task)} />);

    const link = document.querySelector(
      '[data-evidence="review-needs-you-evidence"]',
    ) as HTMLButtonElement | null;
    expect(link).toBeTruthy();
    await user.click(link!);
    expect(document.querySelector('[data-evidence="evidence-lightbox"]')).toBeTruthy();
  });

  it('simple green human body still uses confirm_items primary', () => {
    const task = makeTask({ body: greenReviewBody('Spot-check on device') });
    const { container } = render(<TaskDetail {...taskDetailDefaults(task)} />);
    expect(
      container.querySelector('[data-evidence="review-verdict"]')?.textContent,
    ).toMatch(/Confirm 1 item\(s\), then approve/);
    expect(
      container
        .querySelector('[data-evidence="review-primary-action"]')
        ?.getAttribute('data-action-kind'),
    ).toBe('confirm_items');
  });
});
