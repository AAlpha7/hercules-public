import { describe, it, expect } from 'vitest';
import { splitFinalReport } from '../../src/domain/verification.js';

describe('splitFinalReport (SPEC §9.4)', () => {
  it('splits the narrative report from the trailing self-assessment', () => {
    const msg = [
      '# Result',
      '',
      'I added the retry helper.',
      '',
      '## Self-assessment',
      '- [x] retried 3x — covered by test/foo.test.ts',
      'Result: PASS',
    ].join('\n');
    const { report, selfAssessment } = splitFinalReport(msg);
    expect(report).toBe('# Result\n\nI added the retry helper.');
    expect(selfAssessment).toContain('retried 3x');
    expect(selfAssessment).toContain('Result: PASS');
    // The assessment is NOT left duplicated inside the report.
    expect(report).not.toContain('Self-assessment');
  });

  it('splits at the LAST marker so a mention in the report prose does not hijack it', () => {
    const msg = [
      '# Result',
      'I documented the `## Self-assessment` section of the review packet.', // a mention, not the real one
      '',
      '## Self-assessment',
      '- [x] documented it',
      'Result: PASS',
    ].join('\n');
    const { report, selfAssessment } = splitFinalReport(msg);
    expect(selfAssessment).toContain('Result: PASS');
    expect(selfAssessment).not.toContain('I documented'); // the prose mention stayed in the report
    expect(report).toContain('I documented the');
  });

  it('treats the whole message as the report when there is no marker', () => {
    const { report, selfAssessment } = splitFinalReport('# Summary\n\nThe project does X.');
    expect(report).toBe('# Summary\n\nThe project does X.');
    expect(selfAssessment).toBe('');
  });

  it('returns empty parts for an empty message', () => {
    expect(splitFinalReport('')).toEqual({ report: '', selfAssessment: '' });
  });
});
