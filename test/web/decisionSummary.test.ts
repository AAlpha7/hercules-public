/**
 * The 决策摘要 was buried inside the collapsed Proof packet — opening a
 * review task read as machine noise at first glance (user, 2026-07-23).
 * Extract it from the body and pin it at the top of the Decide panel.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDecisionSummary } from '../../src/web/decisionSummary.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('extractDecisionSummary', () => {
  it('pulls the three zh bullets from the LATEST packet', () => {
    const body = [
      '## 决策摘要\n- **改动**:旧的\n- **可信度**:旧\n- **风险**:旧\n',
      '## Review packet\nstuff\n',
      '## 决策摘要\n\n- **改动**:把检查命令写清楚了\n- **可信度**:门禁 6/7 绿 · 独立审稿:通过 · 行为证据未运行\n- **风险**:分支落后主干 8 个提交\n\n_Verified tip: `abc`_\n',
    ].join('\n');
    const s = extractDecisionSummary(body)!;
    expect(s.change).toBe('把检查命令写清楚了');
    expect(s.trust).toMatch(/门禁 6\/7 绿/);
    expect(s.risk).toMatch(/落后主干 8/);
  });

  it('null when no summary exists (old packets)', () => {
    expect(extractDecisionSummary('## Task\nx')).toBeNull();
  });

  it('TaskDetail pins it at the top of the Decide panel', async () => {
    const src = await readFile(join(ROOT, 'src/web/TaskDetail.tsx'), 'utf8');
    expect(src).toMatch(/extractDecisionSummary\(/);
    expect(src).toMatch(/data-evidence="decision-summary"/);
  });
});
