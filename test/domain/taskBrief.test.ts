import { describe, it, expect } from 'vitest';
import {
  countDodCriteria,
  extractProductBrief,
  extractTaskSummary,
  formatDodChip,
  isHarnessSectionTitle,
} from '../../src/domain/taskBrief.js';

const LOGOUT_BODY = `
把底栏 Logout 改成 Settings 页（sheet）。

## 功能
1. 语言
2. 默认 agent

## Definition of Done
- [ ] (mechanical) gates
- [ ] (mechanical) hooks
- [ ] (human) 真机验收

## Evidence
- unlock

## 参考
tip ≈ c1f39d2

## System recovery (2026-07-14)
Harness fixed tip recovery.

## Review packet
**auto-rework**
`;

describe('taskBrief', () => {
  it('cuts product brief before harness sections', () => {
    const brief = extractProductBrief(LOGOUT_BODY);
    expect(brief).toMatch(/Definition of Done/);
    expect(brief).toMatch(/Evidence/);
    expect(brief).not.toMatch(/System recovery/);
    expect(brief).not.toMatch(/Review packet/);
  });

  it('counts DoD axes', () => {
    const c = countDodCriteria(LOGOUT_BODY);
    expect(c.mechanical).toBe(2);
    expect(c.human).toBe(1);
    expect(c.reviewer).toBe(0);
    expect(formatDodChip(c)).toMatch(/2 mechanical/);
    expect(formatDodChip(c)).toMatch(/1 human/);
  });

  it('summarizes first non-heading lines', () => {
    const s = extractTaskSummary(LOGOUT_BODY, 3);
    expect(s).toMatch(/Settings/);
    expect(s).not.toMatch(/System recovery/);
  });

  it('classifies harness titles', () => {
    expect(isHarnessSectionTitle('System recovery (2026)')).toBe(true);
    expect(isHarnessSectionTitle('Review packet')).toBe(true);
    expect(isHarnessSectionTitle('Proposed graph (advisory)')).toBe(true);
    expect(isHarnessSectionTitle('Definition of Done')).toBe(false);
  });
});
