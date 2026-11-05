import { describe, it, expect } from 'vitest';
import { Reviewer } from '../../src/verification/reviewer.js';
import { assembleReviewPacket, renderPacketMarkdown } from '../../src/verification/packet.js';
import {
  boundReviewerReport,
  MAX_REVIEWER_REPORT_CHARS,
} from '../../src/domain/verification.js';
import type { Task } from '../../src/domain/task.js';

const task: Task = {
  id: 'T-1',
  title: 'Fix upload retry',
  repo: 'app',
  state: 'in_progress',
  priority: 1,
  blockedBy: [],
  labels: [],
  adapter: null,
  agentSession: null,
  pendingSteer: null,
  attempts: 0,
  lastEventAt: null,
  createdAt: null,
  startedAt: null,
  endedAt: null,
  prUrl: null,
  prStatus: null,
  planPending: false,
  body: '## Task\nFix it',
};

function lines(parts: string[]): string {
  return parts.join('\n');
}

describe('L3 full report retention (bounded; verdict extracted separately)', () => {
  const multiParagraph = lines([
    'I scrutinized the three L5 test-edit flags in depth.',
    '',
    '## Per-flag adjudications',
    '- test-edit in foo.test.ts - justified: adds coverage for retry backoff',
    '- test-edit in bar.test.ts - justified: updates assertion for renamed helper',
    '- test-edit in baz.test.ts - justified: mirrors production API change',
    '',
    'No gaming of gates detected. Spirit of the task is met.',
    '',
    'VERDICT: approved',
    'SUMMARY: deep review ok; three test-edits justified',
    'SUMMARY_ZH: three test edits justified',
  ]);

  it('Reviewer stores the full bounded report separately from the extracted verdict', async () => {
    const reviewer = new Reviewer(async () => multiParagraph);
    const verdict = await reviewer.review({
      task,
      diff: '+x',
      cheatFindings: [],
      principles: '',
    });

    expect(verdict.approved).toBe(true);
    expect(verdict.summary).toBe('deep review ok; three test-edits justified');
    expect(verdict.report).toBeDefined();
    expect(verdict.report).toContain('Per-flag adjudications');
    expect(verdict.report).toContain('test-edit in foo.test.ts');
    expect(verdict.report).toContain('test-edit in bar.test.ts');
    expect(verdict.report).toContain('test-edit in baz.test.ts');
    expect(verdict.report).toContain('VERDICT: approved');

    const packet = assembleReviewPacket({
      taskId: task.id,
      branch: 'hercules/T-1',
      filesTouched: ['src/foo.ts'],
      diffSummary: '1 file changed',
      gates: [{ name: 'typecheck', command: 'tsc', passed: true, output: '' }],
      cheatFindings: [],
      selfAssessment: 'ok',
      reviewerVerdict: verdict,
    });
    expect(packet.reviewerVerdict?.report).toContain('Per-flag adjudications');
    expect(packet.reviewerVerdict?.summary).toBe(verdict.summary);
    expect(packet.reviewerVerdict?.approved).toBe(true);

    const md = renderPacketMarkdown(packet);
    expect(md).toContain('**L3 report**');
    expect(md).toContain('**Reviewer (L3):**');
    expect(md).toContain('approved');
    // Fenced for provenance + blockquoted so embedded ## cannot split phone sections.
    expect(md).toContain('<!-- hercules:prose-begin kind=reviewer');
    expect(md).toContain('> - test-edit in foo.test.ts');
    expect(md).toContain('> ## Per-flag adjudications');
  });

  it('truncation at the cap inserts an explicit marker and never corrupts verdict extraction', async () => {
    const padding = 'x'.repeat(MAX_REVIEWER_REPORT_CHARS + 800);
    const oversized = lines([
      'Long reasoning preamble.',
      padding,
      '',
      'VERDICT: approved',
      'SUMMARY: still extractable after bound',
    ]);

    const bounded = boundReviewerReport(oversized);
    expect(bounded.length).toBeLessThan(oversized.length);
    expect(bounded).toContain('L3 report truncated from');
    expect(bounded.startsWith('Long reasoning preamble.')).toBe(true);

    const reviewer = new Reviewer(async () => oversized);
    const verdict = await reviewer.review({
      task,
      diff: '+x',
      cheatFindings: [],
      principles: '',
    });
    expect(verdict.approved).toBe(true);
    expect(verdict.summary).toBe('still extractable after bound');
    expect(verdict.report).toBeDefined();
    const report = verdict.report ?? '';
    expect(report).toContain('L3 report truncated from');
    expect(report.length).toBeLessThan(oversized.length);
  });
});
