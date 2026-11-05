/**
 * C3.31 — unverified criterion status renders ❔ + 无法自动核验 label;
 * green packet with unverified items still unlocks Approve (autoOk).
 */
import './setup.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  makeTask,
  taskDetailDefaults,
} from './fixtures.js';
import {
  renderDecisionCardBlock,
  type DecisionCard,
} from '../../../src/domain/decisionCard.js';
import { bodyHasSuccessfulPacket } from '../../../src/web/taskBodySplit.js';

vi.mock('../../../src/web/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/web/api.js')>();
  return {
    ...actual,
    fetchPrSummary: vi.fn().mockRejectedValue(new Error('no pr')),
    fetchTaskFiles: vi.fn().mockResolvedValue({ files: [] }),
    fetchTaskFile: vi.fn().mockResolvedValue({ content: '', truncated: false }),
    editRepo: vi.fn(),
  };
});

import { TaskDetail } from '../../../src/web/TaskDetail.js';

const NONCE = '0123456789abcdef0123456789abcdef';
const TASK_ID = 'unverified-review-1';

function card(): DecisionCard {
  return {
    v: 1,
    purpose: 'Silent runner still green',
    areas: [{ area: 'src/web', count: 1 }],
    filesTouched: 2,
    reviewOnlyFlags: [],
    criteria: [
      {
        text: 'unit coverage',
        kind: 'mechanical',
        status: 'unverified',
        why: '无法自动核验：测试门禁已通过，但其输出未包含 test/web/x.test.ts',
      },
      {
        text: 'Spot-check on device',
        kind: 'human',
        status: 'pending',
        why: 'pending human',
      },
    ],
    gates: [
      { name: 'typecheck', passed: true },
      { name: 'test', passed: true },
    ],
    evidence: { ran: false, ok: null, steps: 0 },
    boundaries: {
      branch: `hercules/${TASK_ID}`,
      protectedPathsTouched: false,
      testsEdited: false,
      crossTaskIds: [],
      crossTaskCommits: [],
    },
    reviewer: { ran: true, approved: true },
    unverifiedCriteria: [
      {
        text: 'unit coverage',
        warning:
          '无法自动核验：测试门禁已通过，但其输出未包含 test/web/x.test.ts（运行器未回显文件名）。请人工确认该文件被运行器包含；让运行器回显文件名/用例名即可自动核验。',
      },
    ],
  };
}

function unverifiedGreenBody(): string {
  return `## Goal
Silent runner.

## Definition of Done
- [ ] (human) Spot-check on device
- [ ] (mechanical) unit coverage @test:test/web/x.test.ts

## Review packet

### ${TASK_ID} — \`hercules/${TASK_ID}\`
<!-- hercules:packet v1 nonce=${NONCE} -->
**✅ automated proof complete** (1 项无法自动核验，需人工确认 · human Approve still required if human ACs exist)

## 决策摘要

- **改动**:${TASK_ID}(2 个文件改动)
- **可信度**:门禁 2/2 绿 · 独立审稿:通过 · 浏览器行为证据:未运行 · 无法自动核验 1 项
- **风险**:无标记风险

**Definition of Done**
| Axis | Status |
|---|---|
| mechanical (L1/L2/L5) | ✅ pass |
| reviewer (L3) | ✅ pass |
| human | ⏳ pending |

Criteria:
- ❔ \`(mechanical)\` unit coverage — proof: test gate green · test/web/x.test.ts in diff
  ⚠️ 无法自动核验：测试门禁已通过，但其输出未包含 test/web/x.test.ts（运行器未回显文件名）。请人工确认该文件被运行器包含；让运行器回显文件名/用例名即可自动核验。

**Evidence matrix** *(agent citations — not a verdict)*
| Criterion | Kind | Status | Evidence |
|---|---|---|---|
| unit coverage | \`mechanical\` | ❔ unverified | (no evidence cited) |
| Spot-check on device | \`human\` | ⏳ pending | (no evidence cited) |

<!-- hercules:packet-end nonce=${NONCE} -->
${renderDecisionCardBlock(card())}
`;
}

describe('TaskDetail unverified criterion render', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows ❔ unverified in needs-you with neutral style and unlocks approve path', () => {
    const body = unverifiedGreenBody();
    expect(bodyHasSuccessfulPacket(body, { nonce: NONCE })).toBe(true);

    const task = makeTask({
      id: TASK_ID,
      body,
      packetNonce: NONCE,
      state: 'review',
    });
    const { container } = render(<TaskDetail {...taskDetailDefaults(task)} />);

    const verdict = container.querySelector('[data-evidence="review-verdict"]');
    expect(verdict?.textContent).toMatch(/could not be auto-verified/);
    expect(screen.queryByText(/机器验证未全绿/)).toBeNull();

    const needs = container.querySelector('[data-evidence="review-needs-you"]');
    expect(needs).toBeTruthy();
    const unverified = needs!.querySelector('[data-needs-kind="unverified"]');
    expect(unverified).toBeTruthy();
    expect(unverified!.textContent).toMatch(/❔/);
    expect(unverified!.className).toMatch(/unverified/);
    expect(unverified!.textContent).toMatch(/Confirm, then approve/);
  });
});
