import './setup.js';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OutcomeReviewPanel } from '../../../src/web/review/OutcomeReviewPanel.js';
import { reviewPackageFixture } from './reviewPackageFixture.js';

describe('read-only outcome review panel', () => {
  it.each([
    ['pass', 'Pass'],
    ['needs_human', 'Needs human'],
    ['fail', 'Failed'],
    ['need_more_evidence', 'Needs evidence'],
  ] as const)('renders %s with text status and no decision controls', (status, label) => {
    render(<OutcomeReviewPanel packageValue={reviewPackageFixture({ outcome: status })} />);

    expect(screen.getAllByLabelText(label).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /approve|reject|request changes/i })).toBeNull();
  });

  it('never gives pending, inference, or opinion a green class', () => {
    const packageValue = reviewPackageFixture({ outcome: 'need_more_evidence' });
    render(<OutcomeReviewPanel packageValue={packageValue} />);

    for (const token of screen.getAllByLabelText('Needs evidence')) {
      expect(token).not.toHaveClass('outcome-review-tone-green');
    }
  });

  it('shows more rows without changing outcome eligibility', async () => {
    const user = userEvent.setup();
    const base = reviewPackageFixture();
    const criteria = Array.from({ length: 21 }, (_, index) => ({
      ...base.criteria[0]!,
      criterionId: `criterion-${String(index).padStart(2, '0')}`,
    }));
    render(<OutcomeReviewPanel packageValue={{ ...base, criteria }} />);

    expect(screen.getByRole('button', { name: 'Show more (1)' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show more (1)' }));
    expect(screen.queryByRole('button', { name: /show more/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /approve|reject|request changes/i })).toBeNull();
  });

  it('keeps the first required problem and remaining risk in the compact summary', () => {
    const value = reviewPackageFixture();
    const criteria = Array.from({ length: 25 }, (_, index) => ({
      ...value.criteria[0]!,
      criterionId: `criterion-${String(index + 1).padStart(2, '0')}`,
      status: index === 24 ? ('need_more_evidence' as const) : ('pass' as const),
      reasonCodes: index === 24 ? (['evidence_missing'] as const) : [],
    }));
    const packageValue = {
      ...value,
      criteria,
      remainingRisks: [{
        code: 'risk-first',
        criterionIds: [],
        assertionIds: [],
        classification: 'unverified_pending' as const,
        reasonCodes: ['evidence_missing'] as const,
        advisorySummary: 'Needs primary evidence.',
      }],
    };

    render(<OutcomeReviewPanel packageValue={packageValue} />);
    const summary = screen.getByRole('region', { name: 'Outcome review summary' });
    expect(within(summary).getByText('criterion-25')).toBeInTheDocument();
    expect(within(summary).getByText('risk-first')).toBeInTheDocument();
    expect(within(summary).getAllByText('Needs evidence')).toHaveLength(2);
  });

  it('keeps long outcome assertions below the first-viewport decision summary', () => {
    const value = reviewPackageFixture();
    const assertions = Array.from({ length: 25 }, (_, index) => ({
      ...value.assertions[0]!,
      id: `assertion-${String(index + 1).padStart(2, '0')}`,
      advisoryText: index === 24 ? 'Gap assertion 25' : `Verified assertion ${index + 1}`,
      classification: index === 24 ? ('unverified_pending' as const) : ('verified' as const),
    }));
    const packageValue = {
      ...value,
      assertions,
      trustAxes: {
        ...value.trustAxes,
        independentEvaluation: {
          ...value.trustAxes.independentEvaluation,
          assertionIds: assertions.map((assertion) => assertion.id),
        },
      },
    };

    render(<OutcomeReviewPanel packageValue={packageValue} />);
    const preview = screen.getByLabelText('Outcome assertion preview');
    const summary = screen.getByRole('region', { name: 'Outcome review summary' });
    const allAssertions = screen.getByRole('region', { name: 'All outcome assertions' });
    expect(within(preview).getByText('Gap assertion 25')).toBeInTheDocument();
    expect(preview.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(summary.compareDocumentPosition(allAssertions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show more assertions (5)' })).toBeInTheDocument();
  });

  it('bounds a long preview and preserves its full accessible value', () => {
    const value = reviewPackageFixture();
    const advisoryText = 'A'.repeat(4_000);
    const packageValue = {
      ...value,
      assertions: [{ ...value.assertions[0]!, advisoryText }],
    };

    render(<OutcomeReviewPanel packageValue={packageValue} />);
    const previewText = within(screen.getByLabelText('Outcome assertion preview'))
      .getByTitle(advisoryText);
    expect(previewText).toHaveClass('outcome-review-assertion-preview-text');
  });

  it('shows subject and payload hash when preview prose is absent', () => {
    const value = reviewPackageFixture();
    const assertion = { ...value.assertions[0]!, advisoryText: null };
    render(<OutcomeReviewPanel packageValue={{ ...value, assertions: [assertion] }} />);

    const preview = screen.getByLabelText('Outcome assertion preview');
    expect(within(preview).getByText(`${assertion.subjectKey} · ${assertion.payloadHash}`))
      .toBeInTheDocument();
  });
});
