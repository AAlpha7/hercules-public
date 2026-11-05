import { describe, it, expect } from 'vitest';
import {
  cardTitleFromRow,
  isTableRow,
  isTableSeparator,
  shouldRenderTableAsCards,
  splitTableRow,
  zipTableRow,
} from '../../src/web/markdownTables.js';

describe('GFM table helpers (phone review packet)', () => {
  it('detects table rows and separators', () => {
    expect(isTableRow('| 验收标准 | 是否满足 |')).toBe(true);
    expect(isTableRow('not a table')).toBe(false);
    expect(isTableSeparator('|---|---|')).toBe(true);
    expect(isTableSeparator('| :--- | ---: |')).toBe(true);
    expect(isTableSeparator('| a | b |')).toBe(false);
  });

  it('splits cells and trims', () => {
    expect(splitTableRow('| 总结 | 是 | 读索引 |')).toEqual(['总结', '是', '读索引']);
    expect(splitTableRow('|a|b|')).toEqual(['a', 'b']);
  });

  it('keeps escaped pipes inside a cell (evidence matrix)', () => {
    expect(
      splitTableRow('| crit | mechanical | ✅ pass | foo \\| `src/a.ts` |'),
    ).toEqual(['crit', 'mechanical', '✅ pass', 'foo | `src/a.ts`']);
  });

  it('uses cards for evidence matrix (wide / criterion tables)', () => {
    expect(shouldRenderTableAsCards(['Criterion', 'Kind', 'Status', 'Evidence'])).toBe(true);
    expect(shouldRenderTableAsCards(['Criterion', 'Evidence'])).toBe(true);
    expect(shouldRenderTableAsCards(['Axis', 'Status'])).toBe(false);
  });

  it('zips rows and promotes Criterion to card title', () => {
    const pairs = zipTableRow(
      ['Criterion', 'Kind', 'Status', 'Evidence'],
      ['语言切换', 'mechanical', '✅ pass', 'prefs.ts'],
    );
    const { title, rest } = cardTitleFromRow(pairs);
    expect(title).toBe('语言切换');
    expect(rest.map((r) => r.label)).toEqual(['Kind', 'Status', 'Evidence']);
    expect(rest.map((r) => r.value)).toEqual(['mechanical', '✅ pass', 'prefs.ts']);
  });
});
