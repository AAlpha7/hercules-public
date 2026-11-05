import { describe, it, expect } from 'vitest';
import {
  assessReportHygiene,
  cleanPollutedReport,
} from '../../src/domain/reportHygiene.js';

const CLEAN = `
先检查仓库状态。

单循环 11 章已齐；第 6–10 章仍偏薄，已扩写。

建议 human 裁定是否上线。
`;

const POLLUTED = `
先摸清进度。第58次有目录。

## Verdict
**WARN**

## Confidence
0.82

## Findings

- 严重程度：MAJOR
  位置：第09章

## Verdict
WARN

## Confidence
0.86

## Findings

- 严重程度：MAJOR  
  - 位置：第11章终| 09 | 中局「I「第58次，人类没有失去真相
| 10 | **很高问题：听证**
`;

describe('assessReportHygiene', () => {
  it('accepts a clean short narrative', () => {
    const h = assessReportHygiene(CLEAN, 'pending human');
    expect(h.polluted).toBe(false);
    expect(h.cleanedReport).toContain('单循环');
  });

  it('flags multi-verdict multi-findings dumps', () => {
    const h = assessReportHygiene(POLLUTED, 'pending human');
    expect(h.polluted).toBe(true);
    expect(h.reasons.length).toBeGreaterThan(0);
    // Cleaned version should not keep the second Verdict dump.
    expect(h.cleanedReport).not.toMatch(/## Confidence/);
    expect(h.cleanedReport.toLowerCase()).not.toContain('很高问题');
  });
});

describe('cleanPollutedReport', () => {
  it('keeps the leading narrative before the first review dump', () => {
    const cleaned = cleanPollutedReport(POLLUTED);
    expect(cleaned).toContain('先摸清进度');
    expect(cleaned).not.toContain('## Confidence');
  });
});
