import './setup.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../../src/web/api.js';
import type { ReviewDecisionResponseDto } from '../../../src/web/review/reviewDecisionTypes.js';
import {
  ReviewDtoDecodeError,
  type ReviewPackageV2Dto,
} from '../../../src/web/review/reviewTypes.js';
import { reviewPackageFixture } from './reviewPackageFixture.js';

const {
  fetchReviewPackageV2,
  submitReviewDecision,
  newReviewDecisionRequestId,
} = vi.hoisted(() => ({
  fetchReviewPackageV2: vi.fn(),
  submitReviewDecision: vi.fn(),
  newReviewDecisionRequestId: vi.fn(() => 'review-request-1'),
}));

vi.mock('../../../src/web/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/web/api.js')>();
  return {
    ...actual,
    fetchReviewPackageV2,
    submitReviewDecision,
    newReviewDecisionRequestId,
  };
});

import {
  ReviewPresentationBoundary,
  type ReviewPresentationConfig,
} from '../../../src/web/review/ReviewPresentationBoundary.js';

const capabilities = {
  schema: 'hercules-review-experience-capabilities/v1' as const,
  outcomeReviewRead: true,
  boundDecisions: true,
  evidenceContent: false,
  learningProposals: false,
  controlApiV2: false,
};

function config(): ReviewPresentationConfig {
  return {
    preference: 'outcome_v2',
    capabilities,
    onPreferenceChange: vi.fn(),
    onUnauthorized: vi.fn(),
  };
}

function packageWithRisk(): ReviewPackageV2Dto {
  const value = reviewPackageFixture({ outcome: 'needs_human' });
  return {
    ...value,
    remainingRisks: [{
      code: 'risk-a',
      criterionIds: ['criterion-1'],
      assertionIds: ['assertion-1'],
      classification: 'verified',
      reasonCodes: [],
      advisorySummary: 'A remaining verified risk.',
    }],
  };
}

function acceptedResponse(action: 'approve_outcome' | 'reject_outcome' | 'request_changes'): ReviewDecisionResponseDto {
  return {
    schema: 'hercules-review-decision-response/v1',
    duplicate: false,
    receipt: {
      schema: 'hercules-review-decision-receipt/v1',
      clientRequestId: 'review-request-1',
      requestHash: `sha256:${'a'.repeat(64)}`,
      taskId: 'review-1',
      actor: { kind: 'human', id: 'operator-1', issuer: 'fixture-issuer' },
      acceptedProjectionHash: `sha256:${'a'.repeat(64)}`,
      acceptedDecisionBindingHash: `sha256:${'a'.repeat(64)}`,
      action,
      humanDecisionId: 'decision-1',
      eventId: 'event-1',
      priorIterationId: 'iteration-1',
      resultingIterationId: action === 'request_changes' ? 'iteration-2' : 'iteration-1',
      recordedAt: '2026-08-29T10:00:00.000Z',
      receiptHash: `sha256:${'b'.repeat(64)}`,
    },
  };
}

describe('M7 bound decision render path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    newReviewDecisionRequestId.mockReturnValue('review-request-1');
    submitReviewDecision.mockImplementation(async (request) => acceptedResponse(request.action));
    fetchReviewPackageV2.mockResolvedValue(packageWithRisk());
  });

  it.each([
    ['Approve outcome', 'approve_outcome'],
    ['Reject outcome', 'reject_outcome'],
  ] as const)('requires full %s confirmation and exact risk acknowledgement', async (label, action) => {
    const user = userEvent.setup();
    render(<ReviewPresentationBoundary taskId="review-1" config={config()} />);

    await user.click(await screen.findByRole('button', { name: label }));
    const confirmation = screen.getByRole('group', { name: `${label} confirmation` });
    expect(within(confirmation).getByText('review-1')).toBeInTheDocument();
    expect(within(confirmation).getByText('0123456789ab')).toBeInTheDocument();
    expect(within(confirmation).getByText('Approval is not merge or deployment.')).toBeInTheDocument();
    const finalButton = within(confirmation).getByRole('button', { name: label });
    expect(finalButton).toBeDisabled();
    await user.click(within(confirmation).getByRole('checkbox', { name: 'Acknowledge risk-a' }));
    expect(finalButton).toBeEnabled();
    await user.click(finalButton);
    await user.click(within(confirmation).getByRole('button', {
      name: `Confirm ${label.toLowerCase()}`,
    }));

    await waitFor(() => expect(submitReviewDecision).toHaveBeenCalledOnce());
    expect(submitReviewDecision).toHaveBeenCalledWith({
      schema: 'hercules-review-decision-request/v1',
      clientRequestId: 'review-request-1',
      taskId: 'review-1',
      projectionHash: `sha256:${'a'.repeat(64)}`,
      decisionBinding: packageWithRisk().decisionBinding,
      action,
      reason: null,
      acknowledgedRiskCodes: ['risk-a'],
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('submits request changes once with a required reason and no risk acknowledgement', async () => {
    const user = userEvent.setup();
    render(<ReviewPresentationBoundary taskId="review-1" config={config()} />);
    const button = await screen.findByRole('button', { name: 'Request changes' });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText('Reason for changes'), 'Repair the exact regression.');
    expect(button).toBeEnabled();
    await user.click(button);
    await waitFor(() => expect(submitReviewDecision).toHaveBeenCalledOnce());
    expect(submitReviewDecision.mock.calls[0]![0]).toMatchObject({
      clientRequestId: 'review-request-1',
      action: 'request_changes',
      reason: 'Repair the exact regression.',
      acknowledgedRiskCodes: [],
    });
    expect(await screen.findByText(/Decision recorded as decision-1/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request changes' })).toBeNull();
  });

  it('renders actions solely from the exact package decision set', async () => {
    fetchReviewPackageV2.mockResolvedValueOnce(reviewPackageFixture({ outcome: 'fail' }));
    const { rerender } = render(
      <ReviewPresentationBoundary taskId="review-1" config={config()} />,
    );
    expect(await screen.findByRole('button', { name: 'Request changes' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve outcome' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject outcome' })).toBeNull();

    fetchReviewPackageV2.mockResolvedValueOnce(reviewPackageFixture({
      taskId: 'review-2', outcome: 'need_more_evidence',
    }));
    rerender(<ReviewPresentationBoundary taskId="review-2" config={config()} />);
    expect(await screen.findByText('More evidence required')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve outcome|reject outcome|request changes/i })).toBeNull();
  });

  it.each([409, 422] as const)('clears actions and refetches after closed status %s', async (status) => {
    const user = userEvent.setup();
    fetchReviewPackageV2
      .mockResolvedValueOnce(packageWithRisk())
      .mockResolvedValueOnce({
        ...reviewPackageFixture({ outcome: 'need_more_evidence' }),
        projectionHash: `sha256:${'c'.repeat(64)}`,
      });
    submitReviewDecision.mockRejectedValueOnce(new ApiError(status, 'closed'));
    render(<ReviewPresentationBoundary taskId="review-1" config={config()} />);
    await user.type(await screen.findByLabelText('Reason for changes'), 'Repair it.');
    await user.click(screen.getByRole('button', { name: 'Request changes' }));
    expect(await screen.findByText('More evidence required')).toBeInTheDocument();
    expect(fetchReviewPackageV2).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: /approve outcome|reject outcome|request changes/i })).toBeNull();
  });

  it('keeps the stale explanation visible while the authoritative refetch is pending', async () => {
    const user = userEvent.setup();
    let releaseRefetch!: (value: ReviewPackageV2Dto) => void;
    fetchReviewPackageV2
      .mockResolvedValueOnce(packageWithRisk())
      .mockImplementationOnce(() => new Promise<ReviewPackageV2Dto>((resolve) => {
        releaseRefetch = resolve;
      }));
    submitReviewDecision.mockRejectedValueOnce(new ApiError(409, 'stale'));
    render(<ReviewPresentationBoundary taskId="review-1" config={config()} />);
    await user.type(await screen.findByLabelText('Reason for changes'), 'Repair it.');
    await user.click(screen.getByRole('button', { name: 'Request changes' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      'The review changed before this decision was accepted. Refreshing authoritative review',
    ));
    expect(screen.queryByRole('button', { name: /approve outcome|reject outcome|request changes/i })).toBeNull();

    releaseRefetch({
      ...reviewPackageFixture({ outcome: 'need_more_evidence' }),
      projectionHash: `sha256:${'c'.repeat(64)}`,
    });
    expect(await screen.findByText('More evidence required')).toBeInTheDocument();
  });

  it.each([409, 422] as const)('keeps the same rejected projection locked after %s', async (status) => {
    const user = userEvent.setup();
    fetchReviewPackageV2.mockResolvedValue(packageWithRisk());
    submitReviewDecision.mockRejectedValueOnce(new ApiError(status, 'closed'));
    render(<ReviewPresentationBoundary taskId="review-1" config={config()} />);
    await user.type(await screen.findByLabelText('Reason for changes'), 'Repair it.');
    const button = screen.getByRole('button', { name: 'Request changes' });
    await user.dblClick(button);
    await waitFor(() => expect(fetchReviewPackageV2).toHaveBeenCalledTimes(2));
    expect(submitReviewDecision).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: /approve outcome|reject outcome|request changes/i })).toBeNull();
  });

  it.each([
    new ApiError(503, 'outcome unknown'),
    new ReviewDtoDecodeError('receipt validation failed after POST'),
  ])('retries an unknown outcome with the same immutable request ID', async (firstError) => {
    const user = userEvent.setup();
    submitReviewDecision
      .mockRejectedValueOnce(firstError)
      .mockResolvedValueOnce(acceptedResponse('request_changes'));
    render(<ReviewPresentationBoundary taskId="review-1" config={config()} />);
    await user.type(await screen.findByLabelText('Reason for changes'), 'Repair it.');
    await user.click(screen.getByRole('button', { name: 'Request changes' }));
    const retry = await screen.findByRole('button', { name: 'Retry same request' });
    expect(screen.queryByRole('button', { name: 'Approve outcome' })).toBeNull();
    await user.click(retry);
    await waitFor(() => expect(submitReviewDecision).toHaveBeenCalledTimes(2));
    expect(submitReviewDecision.mock.calls[1]![0]).toEqual(
      submitReviewDecision.mock.calls[0]![0],
    );
  });

  it('retains the original retry binding when authoritative refetch is no longer actionable', async () => {
    const user = userEvent.setup();
    fetchReviewPackageV2
      .mockResolvedValueOnce(packageWithRisk())
      .mockResolvedValue({
        ...reviewPackageFixture({ outcome: 'need_more_evidence' }),
        projectionHash: `sha256:${'c'.repeat(64)}`,
      });
    submitReviewDecision
      .mockRejectedValueOnce(new ApiError(503, 'outcome unknown'))
      .mockResolvedValueOnce(acceptedResponse('request_changes'));
    render(<ReviewPresentationBoundary taskId="review-1" config={config()} />);
    await user.type(await screen.findByLabelText('Reason for changes'), 'Repair it.');
    await user.click(screen.getByRole('button', { name: 'Request changes' }));

    await screen.findByRole('button', { name: 'Retry same request' });
    expect(fetchReviewPackageV2).toHaveBeenCalledTimes(2);
    const submitted = screen.getByRole('heading', { name: 'Submitted decision' }).closest('section')!;
    expect(within(submitted).getByText('0123456789ab')).toBeInTheDocument();
    expect(within(submitted).getByText('Request changes')).toBeInTheDocument();
    expect(screen.queryByText('More evidence required')).toBeNull();
    expect(screen.queryByRole('button', { name: /approve outcome|reject outcome|request changes/i })).toBeNull();

    // The authoritative refetch may replace the rendered package between the
    // first error and retry. Exercise the currently attached control while the
    // hook retains the immutable original request binding.
    await user.click(screen.getByRole('button', { name: 'Retry same request' }));
    await waitFor(() => expect(submitReviewDecision).toHaveBeenCalledTimes(2));
    expect(submitReviewDecision.mock.calls[1]![0]).toEqual(
      submitReviewDecision.mock.calls[0]![0],
    );
  });
});
