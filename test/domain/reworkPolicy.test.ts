import { describe, it, expect } from 'vitest';
import {
  chooseReworkPath,
  parseDiffLineCount,
  buildL3SteerMessage,
  SMALL_DIFF_MAX_FILES,
  SMALL_DIFF_MAX_LINES,
} from '../../src/domain/reworkPolicy.js';

const passMechFailL3 = {
  mechanical: 'pass' as const,
  reviewer: 'fail' as const,
};

const failMech = {
  mechanical: 'fail' as const,
  reviewer: 'n/a' as const,
};

describe('parseDiffLineCount', () => {
  it('sums insertions and deletions from git shortstat', () => {
    expect(parseDiffLineCount(' 2 files changed, 40 insertions(+), 3 deletions(-)')).toBe(43);
    expect(parseDiffLineCount('1 file changed, 10 insertions(+)')).toBe(10);
    expect(parseDiffLineCount('1 file changed, 5 deletions(-)')).toBe(5);
  });

  it('returns 0 when the summary has no line counts', () => {
    expect(parseDiffLineCount('1 file')).toBe(0);
    expect(parseDiffLineCount('no changes')).toBe(0);
  });
});

describe('chooseReworkPath', () => {
  it('returns null when autoRework is false', () => {
    expect(
      chooseReworkPath({
        autoRework: false,
        dimensions: passMechFailL3,
        filesTouched: ['a.ts'],
        diffSummary: '1 file changed, 5 insertions(+)',
        reviewerVerdict: { summary: 'nits', comments: ['typo'] },
      }),
    ).toBeNull();
  });

  it('chooses full for delivery failures', () => {
    const d = chooseReworkPath({
      autoRework: true,
      dimensions: failMech,
      filesTouched: [],
      diffSummary: 'no changes',
      reviewerVerdict: null,
      deliveryFailed: true,
    });
    expect(d?.path).toBe('full');
    expect(d?.reason).toMatch(/delivery/i);
  });

  it('chooses full when L1/mechanical failed', () => {
    const d = chooseReworkPath({
      autoRework: true,
      dimensions: failMech,
      filesTouched: ['a.ts'],
      diffSummary: '1 file changed, 2 insertions(+)',
      reviewerVerdict: null,
    });
    expect(d?.path).toBe('full');
    expect(d?.reason).toMatch(/mechanical|L1/i);
  });

  it('chooses full for large design-issue L3 feedback even on a small diff', () => {
    const d = chooseReworkPath({
      autoRework: true,
      dimensions: passMechFailL3,
      filesTouched: ['src/a.ts'],
      diffSummary: '1 file changed, 10 insertions(+)',
      reviewerVerdict: {
        summary: 'Wrong architecture — needs redesign',
        comments: ['Start over with a different abstraction'],
      },
    });
    expect(d?.path).toBe('full');
    expect(d?.reason).toMatch(/design/i);
  });

  it('chooses full when the prior run was already a steer (anti-loop)', () => {
    const d = chooseReworkPath({
      autoRework: true,
      dimensions: passMechFailL3,
      filesTouched: ['a.ts'],
      diffSummary: '1 file changed, 5 insertions(+)',
      reviewerVerdict: {
        summary: 'still a typo',
        comments: ['fix typo in comment'],
      },
      priorRunWasSteer: true,
    });
    expect(d?.path).toBe('full');
    expect(d?.reason).toMatch(/prior steer|escalate|loop/i);
  });

  it('chooses full when there is no session to resume', () => {
    const d = chooseReworkPath({
      autoRework: true,
      dimensions: passMechFailL3,
      filesTouched: ['a.ts'],
      diffSummary: '1 file changed, 5 insertions(+)',
      reviewerVerdict: {
        summary: 'nits',
        comments: ['typo'],
      },
      hasSession: false,
    });
    expect(d?.path).toBe('full');
    expect(d?.reason).toMatch(/session/i);
  });

  it('chooses steer for comment-only / polish L3 feedback on a small diff', () => {
    const d = chooseReworkPath({
      autoRework: true,
      dimensions: passMechFailL3,
      filesTouched: ['src/web/i18n.ts', 'src/web/Settings.tsx'],
      diffSummary: '2 files changed, 12 insertions(+), 3 deletions(-)',
      reviewerVerdict: {
        summary: 'Polish nits',
        comments: ['Fix typo in comment', 'Rename label for clarity'],
      },
      hasSession: true,
    });
    expect(d?.path).toBe('steer');
    expect(d?.reason).toMatch(/comment|polish|small|nit/i);
  });

  it('chooses steer for small L3-only fails without design keywords', () => {
    const d = chooseReworkPath({
      autoRework: true,
      dimensions: passMechFailL3,
      filesTouched: ['src/x.ts'],
      diffSummary: '1 file changed, 20 insertions(+)',
      reviewerVerdict: {
        summary: 'Missing evidence citation',
        comments: ['Expand self-assessment with command output'],
      },
      hasSession: true,
    });
    expect(d?.path).toBe('steer');
    expect(d?.reason).toMatch(/small/i);
  });

  it('chooses full when the diff is large (files or lines)', () => {
    const manyFiles = Array.from(
      { length: SMALL_DIFF_MAX_FILES + 1 },
      (_, i) => `src/f${i}.ts`,
    );
    const byFiles = chooseReworkPath({
      autoRework: true,
      dimensions: passMechFailL3,
      filesTouched: manyFiles,
      diffSummary: `${manyFiles.length} files changed, 10 insertions(+)`,
      reviewerVerdict: {
        summary: 'needs more coverage',
        comments: ['add tests'],
      },
      hasSession: true,
    });
    expect(byFiles?.path).toBe('full');
    expect(byFiles?.reason).toMatch(/large|size|files/i);

    const byLines = chooseReworkPath({
      autoRework: true,
      dimensions: passMechFailL3,
      filesTouched: ['big.ts'],
      diffSummary: `1 file changed, ${SMALL_DIFF_MAX_LINES + 1} insertions(+)`,
      reviewerVerdict: {
        summary: 'incomplete',
        comments: ['finish the feature'],
      },
      hasSession: true,
    });
    expect(byLines?.path).toBe('full');
    expect(byLines?.reason).toMatch(/large|size|lines/i);
  });
});

describe('buildL3SteerMessage', () => {
  it('includes summary and comments for the resume prompt', () => {
    const msg = buildL3SteerMessage({
      summary: 'drafty packet',
      comments: ['expand ch6', 'fix typo'],
    });
    expect(msg).toMatch(/L3|changes|resume/i);
    expect(msg).toContain('drafty packet');
    expect(msg).toContain('expand ch6');
    expect(msg).toContain('fix typo');
  });
});
