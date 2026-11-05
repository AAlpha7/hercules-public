import { describe, it, expect } from 'vitest';
import { finalReportBackReferences } from '../../src/domain/finalReport.js';

describe('finalReportBackReferences', () => {
  it('finalReportBackReferences returns matched back-reference phrases', () => {
    const report = 'Fixed As Above. See Earlier. As Discussed. 如上 见上 上述';
    expect(finalReportBackReferences(report)).toEqual([
      'as above',
      'see earlier',
      'as discussed',
      '如上',
      '见上',
      '上述',
    ]);
  });

  it('finalReportBackReferences returns empty for a standalone report', () => {
    const report = 'Goal: stand alone. Changed: finalReport.ts. Proof: unit tests. Blocker: none';
    expect(finalReportBackReferences(report)).toEqual([]);
  });
});
