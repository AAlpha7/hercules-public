/**
 * TaskDetail renders the structured DecisionCard when present (new packets):
 * 目的 / 触及层面 / 边界与保证 / 逐条验收条件(状态+为什么)。Old packets
 * fall back to the extraction-based blocks. The machine block never shows as
 * raw text in the body view.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('DecisionCard view wiring', () => {
  it('TaskDetail parses and renders the card sections', async () => {
    const src = await readFile(join(ROOT, 'src/web/TaskDetail.tsx'), 'utf8');
    expect(src).toMatch(/parseDecisionCard\(/);
    expect(src).toMatch(/data-evidence="decision-card"/);
    expect(src).toMatch(/层面/);
    expect(src).toMatch(/边界/);
    expect(src).toMatch(/验收条件/);
  });

  it('human AC shows how/refs/action hooks without inventing default copy away', async () => {
    const src = await readFile(join(ROOT, 'src/web/TaskDetail.tsx'), 'utf8');
    expect(src).toMatch(/data-evidence="human-ac-ref"/);
    expect(src).toMatch(/data-evidence="human-ac-action"/);
    expect(src).toMatch(/resolveHumanAcGuidance/);
    expect(src).toMatch(/matchHumanAcAction/);
    // Operator-first needs-you: why/recommendation replace the old default hint.
    expect(src).toMatch(/data-evidence="review-needs-you"/);
    expect(src).toMatch(/这项只有人能判断|recommendation/);
    expect(src).toMatch(/fetchTaskFile/);
    expect(src).toMatch(/editRepo/);
  });

  it('body view strips the machine block before rendering', async () => {
    const tb = await readFile(join(ROOT, 'src/web/taskBody.tsx'), 'utf8');
    expect(tb).toMatch(/stripDecisionCardBlocks\(/);
  });

  it('zh labels exist for common areas', async () => {
    const src = await readFile(join(ROOT, 'src/web/TaskDetail.tsx'), 'utf8');
    expect(src).toMatch(/手机界面/);
    expect(src).toMatch(/编排调度/);
  });

  it('boundary badges are tappable with stable evidence hooks + expand copy', async () => {
    const src = await readFile(join(ROOT, 'src/web/TaskDetail.tsx'), 'utf8');
    expect(src).toMatch(/explainBoundaryBadges/);
    // Contracted L2 hooks (exact strings — rename cannot re-break L2 silently)
    expect(src).toMatch(/data-evidence=\{`boundary-badge-\$\{b\.key\}`\}/);
    expect(src).toMatch(/data-evidence="boundary-badge-detail"/);
    // Must NOT use the old per-key detail id or crossTask key in evidence path
    expect(src).not.toMatch(/boundary-detail-\$/);
    expect(src).toMatch(/判什么/);
    expect(src).toMatch(/本任务/);
    expect(src).toMatch(/review-only-flags/);
    expect(src).toMatch(/ds-badge-btn/);
  });

  it('domain badge keys are the four contracted evidence suffixes', async () => {
    const src = await readFile(join(ROOT, 'src/domain/decisionCard.ts'), 'utf8');
    // BoundaryBadgeKey union must be exactly these four (evidence contract)
    expect(src).toMatch(
      /export type BoundaryBadgeKey = 'branch' \| 'protected' \| 'tests' \| 'cross'/,
    );
    expect(src).not.toMatch(/BoundaryBadgeKey = .*crossTask/);
    // Runtime explain copy must not point off-card (comment docs may mention the old bug)
    expect(src).not.toMatch(/见分支历史/);
    expect(src).not.toMatch(/（本包未嵌入逐条 sha，见/);
  });
});
