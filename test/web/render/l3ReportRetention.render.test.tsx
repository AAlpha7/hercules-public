/**
 * Task detail: collapsible L3 report shows per-flag adjudication depth.
 */
import './setup.js';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  assembleReviewPacket,
  renderPacketMarkdown,
} from '../../../src/verification/packet.js';
import { TaskBodyView } from '../../../src/web/taskBody.js';
import type { GateResult, ReviewerVerdict } from '../../../src/domain/verification.js';

const gatesPass: GateResult[] = [
  { name: 'typecheck', command: 'tsc', passed: true, output: '' },
];

describe('L3 report retention — task detail render', () => {
  it('shows a collapsible L3 report with per-flag adjudication text visible when opened', async () => {
    const user = userEvent.setup();
    const report = [
      'Independent review of L5 test-edit flags.',
      '',
      '## Per-flag adjudications',
      '- test-edit in foo.test.ts — justified: adds coverage for retry backoff',
      '- test-edit in bar.test.ts — justified: updates assertion for renamed helper',
      '- test-edit in baz.test.ts — justified: mirrors production API change',
      '',
      'No gaming detected; spirit of the task is met.',
      '',
      'VERDICT: approved',
      'SUMMARY: three test-edits justified',
    ].join('\n');
    const verdict: ReviewerVerdict = {
      approved: true,
      summary: 'three test-edits justified',
      comments: [],
      report,
    };
    const md = renderPacketMarkdown(
      assembleReviewPacket({
        taskId: 'l3-report-full-retention',
        branch: 'hercules/l3-report-full-retention',
        filesTouched: ['src/verification/reviewer.ts'],
        diffSummary: '1 file changed',
        gates: gatesPass,
        cheatFindings: [],
        selfAssessment: 'retained full L3 stdout',
        reviewerVerdict: verdict,
      }),
    );
    const body = ['## Goal', 'Retain L3 depth.', '', '## Review packet', md].join('\n');

    render(<TaskBodyView body={body} />);

    const surface = document.querySelector('[data-evidence="l3-report"]');
    expect(surface).not.toBeNull();
    expect(screen.getByRole('button', { name: /L3 report/i })).toBeInTheDocument();

    // Collapsed by default — adjudication prose is not mounted until opened.
    expect(screen.queryByText(/test-edit in foo\.test\.ts/)).toBeNull();

    await user.click(screen.getByRole('button', { name: /L3 report/i }));
    expect(
      screen.getByText(/test-edit in foo\.test\.ts — justified: adds coverage/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/test-edit in bar\.test\.ts — justified: updates assertion/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/test-edit in baz\.test\.ts — justified: mirrors production/),
    ).toBeInTheDocument();
  });
});
