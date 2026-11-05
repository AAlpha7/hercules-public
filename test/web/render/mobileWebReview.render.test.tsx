/**
 * M13 mobile-Web outcome-review scenario — jsdom render at MOBILE viewport.
 *
 * Proves the full six-property set over the existing OutcomeReviewPanel /
 * SafeDecisionBar / AcceptanceMatrix / IterationHistory / DecisionBanner
 * surface. No live browser; judgeable in 10–30 seconds.
 */
import './setup.js';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../../src/web/api.js';
import type { ReviewDecisionResponseDto } from '../../../src/web/review/reviewDecisionTypes.js';
import type { ReviewPackageV2Dto } from '../../../src/web/review/reviewTypes.js';
import {
  MOBILE_WEB_PROVED_PROPERTIES,
  assertMobileWebReviewResultV1,
} from '../../../src/domain/qualification.js';
import { buildBrowserCapabilityProof } from '../../../src/proofs/archetypes/browser.js';
import { buildMobileWebReviewResult } from '../../../src/qualification/mobileWebReview.js';
import { reviewPackageFixture } from './reviewPackageFixture.js';

const MOBILE_WIDTH = 390;
const MOBILE_HEIGHT = 844;
const NOW = '2026-09-01T00:00:00.000Z';

const {
  fetchReviewPackageV2,
  submitReviewDecision,
  newReviewDecisionRequestId,
} = vi.hoisted(() => ({
  fetchReviewPackageV2: vi.fn(),
  submitReviewDecision: vi.fn(),
  newReviewDecisionRequestId: vi.fn(() => 'review-request-mobile-1'),
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

function mobilePackage(): ReviewPackageV2Dto {
  const base = reviewPackageFixture({ outcome: 'needs_human' });
  const priorCandidate = {
    kind: 'git' as const,
    repository: 'example-org/acme',
    revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  };
  return {
    ...base,
    remainingRisks: [
      {
        code: 'risk-mobile',
        criterionIds: ['criterion-1'],
        assertionIds: ['assertion-1'],
        classification: 'verified',
        reasonCodes: [],
        advisorySummary: 'A remaining verified risk for mobile review.',
      },
    ],
    iterations: [
      {
        id: 'iteration-0',
        ordinal: 1,
        state: 'failed',
        candidateRef: priorCandidate,
        evidenceManifestId: 'manifest-0',
        finalVerdictId: 'verdict-0',
        createdAt: '2026-08-29T00:00:01.000Z',
        endedAt: '2026-08-29T00:00:03.000Z',
      },
      {
        id: 'iteration-1',
        ordinal: 2,
        state: 'evaluating',
        candidateRef: base.iterations[0]!.candidateRef,
        evidenceManifestId: 'manifest-1',
        finalVerdictId: null,
        createdAt: '2026-08-29T00:00:04.000Z',
        endedAt: null,
      },
    ],
  };
}

function acceptedResponse(
  action: 'approve_outcome' | 'reject_outcome' | 'request_changes',
): ReviewDecisionResponseDto {
  return {
    schema: 'hercules-review-decision-response/v1',
    duplicate: false,
    receipt: {
      schema: 'hercules-review-decision-receipt/v1',
      clientRequestId: 'review-request-mobile-1',
      requestHash: `sha256:${'a'.repeat(64)}`,
      taskId: 'review-1',
      actor: { kind: 'human', id: 'operator-1', issuer: 'fixture-issuer' },
      acceptedProjectionHash: `sha256:${'a'.repeat(64)}`,
      acceptedDecisionBindingHash: `sha256:${'a'.repeat(64)}`,
      action,
      humanDecisionId: 'decision-mobile-1',
      eventId: 'event-mobile-1',
      priorIterationId: 'iteration-1',
      resultingIterationId:
        action === 'request_changes' ? 'iteration-2' : 'iteration-1',
      recordedAt: '2026-08-29T10:00:00.000Z',
      receiptHash: `sha256:${'b'.repeat(64)}`,
    },
  };
}

function setMobileViewport(): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: MOBILE_WIDTH,
  });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    writable: true,
    value: MOBILE_HEIGHT,
  });
  window.dispatchEvent(new Event('resize'));
}

describe('M13 mobile-Web outcome-review scenario (mobile viewport)', () => {
  let previousWidth: number;
  let previousHeight: number;

  beforeEach(() => {
    previousWidth = window.innerWidth;
    previousHeight = window.innerHeight;
    setMobileViewport();
    vi.clearAllMocks();
    newReviewDecisionRequestId.mockReturnValue('review-request-mobile-1');
    submitReviewDecision.mockImplementation(async (request) =>
      acceptedResponse(request.action),
    );
    fetchReviewPackageV2.mockResolvedValue(mobilePackage());
  });

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: previousWidth,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: previousHeight,
    });
  });

  it('proves the full six-property set in the rendered mobile panel', async () => {
    expect(window.innerWidth).toBe(MOBILE_WIDTH);
    expect(window.innerHeight).toBe(MOBILE_HEIGHT);

    // Closed record binds the re-consumed M12 browser proof + full property set.
    const browserProof = buildBrowserCapabilityProof(NOW);
    const closed = buildMobileWebReviewResult(browserProof.proofHash, NOW);
    expect(() => assertMobileWebReviewResultV1(closed)).not.toThrow();
    expect(closed.provedProperties).toEqual([...MOBILE_WEB_PROVED_PROPERTIES]);

    const user = userEvent.setup();
    render(
      <div
        data-evidence="mobile-web-review-viewport"
        style={{ width: MOBILE_WIDTH, maxWidth: MOBILE_WIDTH }}
      >
        <ReviewPresentationBoundary taskId="review-1" config={config()} />
      </div>,
    );

    // 1. outcome_review — outcome status is visible in the panel.
    expect(
      (await screen.findAllByLabelText('Needs human')).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole('region', { name: 'Decision status' }),
    ).toHaveTextContent(/bound human outcome decision is required/i);
    expect(screen.getByText('Outcome review task')).toBeInTheDocument();
    expect(screen.getByText('Outcome review')).toBeInTheDocument();

    // 2. criterion_evidence — AcceptanceMatrix shows criterion + evidence metadata.
    const acceptance = screen.getByRole('region', { name: /acceptance/i });
    expect(within(acceptance).getByText('criterion-1')).toBeInTheDocument();
    expect(within(acceptance).getByText('Unit tests passed.')).toBeInTheDocument();
    expect(
      within(acceptance).getByText(/Evidence metadata: pnpm-test/),
    ).toBeInTheDocument();

    // 6. immutable_prior_iteration — prior iteration is visible and unchanged.
    const history = screen.getByRole('region', { name: /iterations/i });
    const prior = within(history)
      .getByText('#1')
      .closest<HTMLElement>('[data-iteration-id]')!;
    expect(prior).toHaveAttribute('data-iteration-id', 'iteration-0');
    expect(within(prior).getByText('failed')).toBeInTheDocument();
    expect(within(prior).getByText('aaaaaaaaaaaa')).toBeInTheDocument();
    const priorSnapshot = prior.textContent;

    // 5. request_changes — SafeDecisionBar submits request_changes.
    const requestButton = screen.getByRole('button', { name: 'Request changes' });
    expect(requestButton).toBeDisabled();
    await user.type(
      screen.getByLabelText('Reason for changes'),
      'Repair the mobile regression.',
    );
    expect(requestButton).toBeEnabled();
    await user.click(requestButton);
    await waitFor(() => expect(submitReviewDecision).toHaveBeenCalledOnce());
    expect(submitReviewDecision.mock.calls[0]![0]).toMatchObject({
      action: 'request_changes',
      reason: 'Repair the mobile regression.',
    });
    expect(
      await screen.findByText(/Decision recorded as decision-mobile-1/),
    ).toBeInTheDocument();

    // Prior iteration remains byte-identical after the decision (immutable).
    const historyAfter = screen.getByRole('region', { name: /iterations/i });
    const priorAfter = within(historyAfter)
      .getByText('#1')
      .closest('[data-iteration-id]')!;
    expect(priorAfter).toHaveAttribute('data-iteration-id', 'iteration-0');
    expect(priorAfter.textContent).toBe(priorSnapshot);
  });

  it('rejects a stale decision and refreshes the authoritative package', async () => {
    expect(window.innerWidth).toBe(MOBILE_WIDTH);
    const user = userEvent.setup();

    // 3. stale_rejection + 4. refresh — 409 clears actions and refetches.
    fetchReviewPackageV2
      .mockResolvedValueOnce(mobilePackage())
      .mockResolvedValueOnce({
        ...reviewPackageFixture({ outcome: 'need_more_evidence' }),
        projectionHash: `sha256:${'c'.repeat(64)}`,
      });
    submitReviewDecision.mockRejectedValueOnce(new ApiError(409, 'stale'));

    render(
      <div
        data-evidence="mobile-web-review-viewport"
        style={{ width: MOBILE_WIDTH, maxWidth: MOBILE_WIDTH }}
      >
        <ReviewPresentationBoundary taskId="review-1" config={config()} />
      </div>,
    );

    await user.type(
      await screen.findByLabelText('Reason for changes'),
      'This stale tab must be rejected.',
    );
    await user.click(screen.getByRole('button', { name: 'Request changes' }));

    expect(
      await screen.findByText('More evidence required'),
    ).toBeInTheDocument();
    expect(fetchReviewPackageV2).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByRole('button', {
        name: /approve outcome|reject outcome|request changes/i,
      }),
    ).toBeNull();
  });
});
