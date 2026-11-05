import './setup.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../../src/web/api.js';
import {
  ReviewDtoDecodeError,
  type ReviewPackageV2Dto,
} from '../../../src/web/review/reviewTypes.js';
import { makeTask, taskDetailDefaults } from './fixtures.js';
import { reviewPackageFixture } from './reviewPackageFixture.js';

const {
  fetchReviewPackageV2,
  fetchReviewEvidence,
  fetchControlApiV2Review,
} = vi.hoisted(() => ({
  fetchReviewPackageV2: vi.fn(),
  fetchReviewEvidence: vi.fn(),
  fetchControlApiV2Review: vi.fn(),
}));

vi.mock('../../../src/web/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/web/api.js')>();
  return {
    ...actual,
    fetchReviewPackageV2,
    fetchReviewEvidence,
    fetchControlApiV2Review,
    fetchPrSummary: vi.fn().mockRejectedValue(new Error('no pr')),
    fetchTaskFiles: vi.fn().mockResolvedValue({ files: [] }),
    fetchTaskFile: vi.fn().mockResolvedValue({ content: '', truncated: false }),
    editRepo: vi.fn(),
  };
});

import { TaskDetail } from '../../../src/web/TaskDetail.js';
import {
  ReviewPresentationBoundary,
  reviewPresentationOwner,
  type ReviewPresentationConfig,
} from '../../../src/web/review/ReviewPresentationBoundary.js';

const capabilities = {
  schema: 'hercules-review-experience-capabilities/v1' as const,
  outcomeReviewRead: true,
  boundDecisions: false,
  evidenceContent: false,
  learningProposals: false,
  controlApiV2: false,
};

function config(overrides: Partial<ReviewPresentationConfig> = {}): ReviewPresentationConfig {
  return {
    preference: 'outcome_v2',
    capabilities,
    onPreferenceChange: vi.fn(),
    onUnauthorized: vi.fn(),
    ...overrides,
  };
}

describe('reviewPresentationOwner', () => {
  const baseCaps = {
    schema: 'hercules-review-experience-capabilities/v1' as const,
    boundDecisions: false,
    evidenceContent: false,
    learningProposals: false,
  };

  it.each([
    // preference | O | C | S | owner
    ['legacy', true, true, true, 'legacy'],
    ['legacy', false, false, false, 'legacy'],
    ['outcome_v2', true, false, false, 'outcome_v2'],
    ['outcome_v2', false, false, false, 'legacy'],
    ['control_v2', true, true, true, 'control_v2'],
    ['control_v2', true, true, false, 'outcome_v2'],
    ['control_v2', true, false, true, 'outcome_v2'],
    ['control_v2', true, false, false, 'outcome_v2'],
    ['control_v2', false, true, true, 'control_v2'],
    ['control_v2', false, true, false, 'legacy'],
    ['control_v2', false, false, true, 'legacy'],
    ['control_v2', false, false, false, 'legacy'],
  ] as const)(
    'preference=%s O=%s C=%s S=%s → %s',
    (preference, outcomeReviewRead, controlApiV2, controlApiV2Supported, owner) => {
      expect(
        reviewPresentationOwner(
          config({
            preference,
            capabilities: { ...baseCaps, outcomeReviewRead, controlApiV2 },
            controlApiV2Supported,
          }),
        ),
      ).toBe(owner);
    },
  );
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('review presentation boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves legacy by default and does not fetch V2', () => {
    const task = makeTask({ id: 'review-1', state: 'review' });
    render(<TaskDetail {...taskDetailDefaults(task)} />);

    expect(document.querySelector('[data-evidence="review-primary-action"]')).not.toBeNull();
    expect(document.querySelector('[data-evidence=legacy-task-actions]')).not.toBeNull();
    expect(fetchReviewPackageV2).not.toHaveBeenCalled();
  });

  it('keeps legacy active with a neutral notice when capability is absent', () => {
    const task = makeTask({ id: 'review-1', state: 'review' });
    render(
      <TaskDetail
        {...taskDetailDefaults(task)}
        reviewExperience={config({
          capabilities: { ...capabilities, outcomeReviewRead: false },
        })}
      />,
    );

    expect(screen.getByText(/legacy review remains active/i)).toBeInTheDocument();
    expect(document.querySelector('[data-evidence="review-primary-action"]')).not.toBeNull();
    expect(fetchReviewPackageV2).not.toHaveBeenCalled();
  });

  it('hides every legacy decision while V2 owns the task, including loading', async () => {
    fetchReviewPackageV2.mockResolvedValue(reviewPackageFixture());
    const task = makeTask({ id: 'review-1', state: 'review' });
    render(
      <TaskDetail {...taskDetailDefaults(task)} reviewExperience={config()} />,
    );

    expect(document.querySelector('[data-evidence="review-primary-action"]')).toBeNull();
    expect(document.querySelector('[data-evidence="review-verdict"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open PR only' })).toBeNull();
    expect(document.querySelector('[data-evidence=legacy-task-actions]')).toBeNull();
    expect(await screen.findByText('Outcome review task')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /request changes/i })).toBeNull();
  });

  it('drops a late package after switching tasks', async () => {
    const first = deferred<ReviewPackageV2Dto>();
    const second = deferred<ReviewPackageV2Dto>();
    fetchReviewPackageV2.mockImplementation((taskId: string) =>
      taskId === 'task-a' ? first.promise : second.promise,
    );
    const cfg = config();
    const { rerender } = render(
      <ReviewPresentationBoundary taskId="task-a" config={cfg} />,
    );
    rerender(<ReviewPresentationBoundary taskId="task-b" config={cfg} />);

    first.resolve(reviewPackageFixture({ taskId: 'task-a', title: 'Late A' }));
    second.resolve(reviewPackageFixture({ taskId: 'task-b', title: 'Current B' }));
    expect(await screen.findByText('Current B')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Late A')).toBeNull());
  });

  it.each([
    [new ApiError(404, 'not found'), /no outcome review package/i],
    [new ApiError(503, 'unavailable'), /temporarily unavailable/i],
    [new ReviewDtoDecodeError('malformed package'), /malformed package/i],
  ])('fails closed on read/decode errors without exposing either decision bar', async (error, message) => {
    fetchReviewPackageV2.mockRejectedValueOnce(error);
    render(<ReviewPresentationBoundary taskId="review-1" config={config()} />);

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use legacy review' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve|reject|request changes/i })).toBeNull();
    expect(document.querySelector('.outcome-review-tone-green')).toBeNull();
  });

  it('aborts on preference rollback and routes 401 to the auth boundary', async () => {
    const unauthorized = vi.fn();
    let signal: AbortSignal | undefined;
    fetchReviewPackageV2.mockImplementationOnce(
      (_taskId: string, options: { signal?: AbortSignal }) => {
        signal = options.signal;
        return new Promise(() => undefined);
      },
    );
    const cfg = config({ onUnauthorized: unauthorized });
    const { rerender } = render(
      <ReviewPresentationBoundary taskId="review-1" config={cfg} />,
    );
    rerender(
      <ReviewPresentationBoundary
        taskId="review-1"
        config={{ ...cfg, preference: 'legacy' }}
      />,
    );
    expect(signal?.aborted).toBe(true);

    fetchReviewPackageV2.mockRejectedValueOnce(new ApiError(401, 'unauthorized'));
    rerender(<ReviewPresentationBoundary taskId="review-2" config={cfg} />);
    await waitFor(() => expect(unauthorized).toHaveBeenCalledOnce());
  });

  it('clears a stale evidence view and refetches the authoritative package', async () => {
    const user = userEvent.setup();
    fetchReviewPackageV2.mockResolvedValue(reviewPackageFixture());
    fetchReviewEvidence.mockRejectedValue(new ApiError(409, 'stale'));
    render(<ReviewPresentationBoundary
      taskId="review-1"
      config={config({ capabilities: { ...capabilities, evidenceContent: true } })}
    />);
    await user.click(await screen.findByRole('button', { name: /open evidence/i }));
    await waitFor(() => expect(fetchReviewPackageV2).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/evidence is stale/i)).toBeNull());
  });

  it('marks control_v2 ownership and presses the Control mode button when capability and probe allow', async () => {
    const pkg = reviewPackageFixture();
    fetchControlApiV2Review.mockResolvedValue({
      aggregateId: 'review-1',
      stateVersion: 2,
      package: pkg,
    });
    render(
      <ReviewPresentationBoundary
        taskId="review-1"
        config={config({
          preference: 'control_v2',
          capabilities: { ...capabilities, controlApiV2: true },
          controlApiV2Supported: true,
        })}
      />,
    );

    expect(document.querySelector('[data-owner="control_v2"]')).not.toBeNull();
    const controlBtn = document.querySelector('[data-evidence="review-mode-control"]');
    expect(controlBtn).not.toBeNull();
    expect(controlBtn?.getAttribute('aria-pressed')).toBe('true');
    expect(await screen.findByText('Outcome review task')).toBeInTheDocument();
    expect(document.querySelector('[data-source="control_v2"]')).not.toBeNull();
    expect(fetchControlApiV2Review).toHaveBeenCalled();
    expect(fetchReviewPackageV2).not.toHaveBeenCalled();
  });

  it('falls back to the legacy package with a notice when Control API returns unknown_aggregate', async () => {
    fetchControlApiV2Review.mockRejectedValueOnce(new ApiError(404, 'unknown_aggregate'));
    fetchReviewPackageV2.mockResolvedValueOnce(reviewPackageFixture());
    render(
      <ReviewPresentationBoundary
        taskId="review-1"
        config={config({
          preference: 'control_v2',
          capabilities: { ...capabilities, controlApiV2: true },
          controlApiV2Supported: true,
        })}
      />,
    );

    expect(await screen.findByText('Outcome review task')).toBeInTheDocument();
    expect(document.querySelector('[data-source="control_v2_fallback"]')).not.toBeNull();
    const notice = document.querySelector('[data-evidence="review-control-fallback"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toMatch(/Control API has no record for this task yet/i);
    expect(fetchReviewPackageV2).toHaveBeenCalledOnce();
  });

  it('shows Control API unavailable text when the review read returns 503', async () => {
    fetchControlApiV2Review.mockRejectedValueOnce(new ApiError(503, 'provider_unavailable'));
    render(
      <ReviewPresentationBoundary
        taskId="review-1"
        config={config({
          preference: 'control_v2',
          capabilities: { ...capabilities, controlApiV2: true },
          controlApiV2Supported: true,
        })}
      />,
    );

    expect(
      await screen.findByText(/Control API review is temporarily unavailable/i),
    ).toBeInTheDocument();
    expect(fetchReviewPackageV2).not.toHaveBeenCalled();
  });

  it('degrades control_v2 to outcome_v2 with an unavailable notice when the probe fails', async () => {
    fetchReviewPackageV2.mockResolvedValue(reviewPackageFixture());
    render(
      <ReviewPresentationBoundary
        taskId="review-1"
        config={config({
          preference: 'control_v2',
          capabilities: { ...capabilities, controlApiV2: true },
          controlApiV2Supported: false,
        })}
      />,
    );

    expect(document.querySelector('[data-owner="outcome_v2"]')).not.toBeNull();
    const notice = document.querySelector('[data-evidence="review-control-unavailable"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toMatch(/Control API review is unavailable on this origin/);
    expect(notice?.textContent).toMatch(/The outcome review remains active/);
    expect(await screen.findByText('Outcome review task')).toBeInTheDocument();
  });

  it('owns control_v2 on the C2 staging composition (controlApiV2 true, outcomeReviewRead false)', async () => {
    fetchControlApiV2Review.mockResolvedValue({
      aggregateId: 'review-1',
      stateVersion: 2,
      package: reviewPackageFixture(),
    });
    render(
      <ReviewPresentationBoundary
        taskId="review-1"
        config={config({
          preference: 'control_v2',
          capabilities: { ...capabilities, outcomeReviewRead: false, controlApiV2: true },
          controlApiV2Supported: true,
        })}
      />,
    );

    expect(document.querySelector('[data-owner="control_v2"]')).not.toBeNull();
    expect(document.querySelector('[data-evidence="review-mode-control"]')).not.toBeNull();
    expect(document.querySelector('[data-evidence="review-mode-outcome"]')).toBeNull();
    expect(document.querySelector('[data-evidence="review-mode-legacy"]')).not.toBeNull();
    expect(document.querySelector('[data-evidence="review-control-unavailable"]')).toBeNull();
    expect(await screen.findByText('Outcome review task')).toBeInTheDocument();
    expect(document.querySelector('[data-source="control_v2"]')).not.toBeNull();
    expect(fetchControlApiV2Review).toHaveBeenCalled();
    expect(fetchReviewPackageV2).not.toHaveBeenCalled();
  });

  it('hides the Control mode button when controlApiV2 capability is off', () => {
    render(
      <ReviewPresentationBoundary
        taskId="review-1"
        config={config({
          preference: 'outcome_v2',
          capabilities: { ...capabilities, controlApiV2: false },
        })}
      />,
    );

    expect(document.querySelector('[data-evidence="review-mode-control"]')).toBeNull();
    expect(document.querySelector('[data-evidence="review-mode-legacy"]')).not.toBeNull();
    expect(document.querySelector('[data-evidence="review-mode-outcome"]')).not.toBeNull();
  });
});
