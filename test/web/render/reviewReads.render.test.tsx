import './setup.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '../../../src/web/api.js';
import { reviewPackageFixture } from './reviewPackageFixture.js';

const { fetchReviewEvidence, fetchReviewEvidenceImage, fetchLearningProposals } = vi.hoisted(() => ({
  fetchReviewEvidence: vi.fn(),
  fetchReviewEvidenceImage: vi.fn(),
  fetchLearningProposals: vi.fn(),
}));

vi.mock('../../../src/web/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/web/api.js')>();
  return { ...actual, fetchReviewEvidence, fetchReviewEvidenceImage, fetchLearningProposals };
});

import { OutcomeReviewPanel } from '../../../src/web/review/OutcomeReviewPanel.js';

describe('M7 evidence and learning read surfaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchLearningProposals.mockResolvedValue([]);
  });

  it('opens the deterministic evidence in one action with the exact package binding', async () => {
    const user = userEvent.setup();
    const packageValue = reviewPackageFixture();
    fetchReviewEvidence.mockResolvedValue({
      schema: 'hercules-review-evidence-content/v1', kind: 'text',
      artifactRefId: 'artifact-1', sha256: packageValue.evidence[0]!.sha256,
      mediaType: 'text/plain', redactionState: 'none', text: 'verified output',
    });
    render(<OutcomeReviewPanel packageValue={packageValue} evidenceEnabled />);
    await user.click(screen.getByRole('button', { name: /open evidence: pnpm-test/i }));
    expect(await screen.findByText('verified output')).toBeInTheDocument();
    expect(fetchReviewEvidence).toHaveBeenCalledWith(
      packageValue.task.id,
      packageValue.projectionHash,
      packageValue.evidence[0],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByRole('dialog', { name: 'Evidence' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve|reject|request changes/i })).toBeNull();
  });

  it('shows explicit unavailable metadata without claiming content inspection', async () => {
    const user = userEvent.setup();
    const packageValue = reviewPackageFixture();
    fetchReviewEvidence.mockResolvedValue({
      schema: 'hercules-review-evidence-content/v1', kind: 'unavailable',
      artifactRefId: 'artifact-1', reason: 'restricted',
    });
    render(<OutcomeReviewPanel packageValue={packageValue} evidenceEnabled />);
    await user.click(screen.getByRole('button', { name: /open evidence/i }));
    expect(await screen.findByText('Content is restricted.')).toBeInTheDocument();
    expect(screen.getByText(packageValue.evidence[0]!.sha256)).toBeInTheDocument();
    expect(screen.queryByText(/inspected/i)).toBeNull();
  });

  it('renders video/* evidence as a video element (B4)', async () => {
    const user = userEvent.setup();
    const packageValue = reviewPackageFixture();
    fetchReviewEvidence.mockResolvedValue({
      schema: 'hercules-review-evidence-content/v1',
      kind: 'image',
      artifactRefId: 'artifact-1',
      sha256: packageValue.evidence[0]!.sha256,
      mediaType: 'video/webm',
      redactionState: 'none',
      authenticatedPath:
        `/api/v2/tasks/${encodeURIComponent(packageValue.task.id)}/review-evidence/artifact-1/content/${encodeURIComponent(packageValue.projectionHash)}`,
    });
    fetchReviewEvidenceImage.mockResolvedValue('blob:jsdom-video');
    render(<OutcomeReviewPanel packageValue={packageValue} evidenceEnabled />);
    await user.click(screen.getByRole('button', { name: /open evidence/i }));
    const video = await screen.findByLabelText(`Evidence artifact-1`);
    expect(video.tagName).toBe('VIDEO');
    expect(video).toHaveAttribute('controls');
    expect(video).toHaveAttribute('preload', 'metadata');
    expect(video).toHaveAttribute('src', 'blob:jsdom-video');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('renders a Chinese unsupported-media note for non-image non-video blobs (B4)', async () => {
    const user = userEvent.setup();
    const packageValue = reviewPackageFixture();
    fetchReviewEvidence.mockResolvedValue({
      schema: 'hercules-review-evidence-content/v1',
      kind: 'image',
      artifactRefId: 'artifact-1',
      sha256: packageValue.evidence[0]!.sha256,
      mediaType: 'application/octet-stream',
      redactionState: 'none',
      authenticatedPath:
        `/api/v2/tasks/${encodeURIComponent(packageValue.task.id)}/review-evidence/artifact-1/content/${encodeURIComponent(packageValue.projectionHash)}`,
    });
    render(<OutcomeReviewPanel packageValue={packageValue} evidenceEnabled />);
    await user.click(screen.getByRole('button', { name: /open evidence/i }));
    expect(await screen.findByText('不支持的媒体类型: application/octet-stream')).toBeInTheDocument();
    expect(fetchReviewEvidenceImage).not.toHaveBeenCalled();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByLabelText(`Evidence artifact-1`)).toBeNull();
  });

  it('remounts content immediately when a second artifact is selected', async () => {
    const user = userEvent.setup();
    const base = reviewPackageFixture();
    const secondEvidence = {
      ...base.evidence[0]!,
      artifactRefId: 'artifact-2',
      sha256: `sha256:${'d'.repeat(64)}`,
      criterionIds: ['criterion-2'],
      supportsAssertionIds: ['assertion-2'],
    };
    const packageValue = {
      ...base,
      assertions: [
        base.assertions[0]!,
        { ...base.assertions[0]!, id: 'assertion-2', usedByCriterionIds: ['criterion-2'], evidenceArtifactIds: ['artifact-2'] },
      ],
      criteria: [
        base.criteria[0]!,
        { ...base.criteria[0]!, criterionId: 'criterion-2', assertionIds: ['assertion-2'], evidenceArtifactIds: ['artifact-2'] },
      ],
      evidence: [...base.evidence, secondEvidence],
    };
    let resolveSecond!: (value: unknown) => void;
    fetchReviewEvidence.mockImplementation((_taskId: string, _hash: string, evidence: { artifactRefId: string }) =>
      evidence.artifactRefId === 'artifact-1'
        ? Promise.resolve({
            schema: 'hercules-review-evidence-content/v1', kind: 'text',
            artifactRefId: 'artifact-1', sha256: base.evidence[0]!.sha256,
            mediaType: 'text/plain', redactionState: 'none', text: 'first content',
          })
        : new Promise((resolve) => { resolveSecond = resolve; }),
    );
    render(<OutcomeReviewPanel packageValue={packageValue} evidenceEnabled />);
    const openButtons = screen.getAllByRole('button', { name: /open evidence/i });
    await user.click(openButtons[0]!);
    expect(await screen.findByText('first content')).toBeInTheDocument();
    await user.click(openButtons[1]!);
    expect(screen.queryByText('first content')).toBeNull();
    expect(screen.getByText('artifact-2')).toBeInTheDocument();
    expect(screen.getByText(/loading verified evidence/i)).toBeInTheDocument();
    resolveSecond({
      schema: 'hercules-review-evidence-content/v1', kind: 'text',
      artifactRefId: 'artifact-2', sha256: secondEvidence.sha256,
      mediaType: 'text/plain', redactionState: 'none', text: 'second content',
    });
    expect(await screen.findByText('second content')).toBeInTheDocument();
  });

  it('clears stale evidence and asks the authority owner to refetch', async () => {
    const user = userEvent.setup();
    const onStale = vi.fn();
    fetchReviewEvidence.mockRejectedValue(new ApiError(409, 'stale'));
    render(<OutcomeReviewPanel
      packageValue={reviewPackageFixture()} evidenceEnabled onStale={onStale}
    />);
    await user.click(screen.getByRole('button', { name: /open evidence/i }));
    expect(await screen.findByText(/evidence is stale/i)).toBeInTheDocument();
    expect(onStale).toHaveBeenCalledOnce();
  });

  it('renders real proposals as advisory with no learning or outcome action', async () => {
    const packageValue = reviewPackageFixture();
    fetchLearningProposals.mockResolvedValue([{
      schema: 'hercules-learning-proposal-view/v1',
      id: 'proposal-1', taskId: packageValue.task.id,
      projectionHash: packageValue.projectionHash,
      title: 'Retain the exact gate', advisorySummary: 'Reuse only after verification.',
      status: 'proposed', evidenceArtifactIds: ['artifact-1'],
    }]);
    render(<OutcomeReviewPanel packageValue={packageValue} learningEnabled />);
    expect(await screen.findByText('Retain the exact gate')).toBeInTheDocument();
    expect(screen.getAllByText(/advisory/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /accept|reject|approve/i })).toBeNull();
  });

  it('renders no placeholder and makes no request without a real learning capability', async () => {
    render(<OutcomeReviewPanel packageValue={reviewPackageFixture()} />);
    await waitFor(() => expect(fetchLearningProposals).not.toHaveBeenCalled());
    expect(screen.queryByText(/learning proposal/i)).toBeNull();
  });

  it('drops a late learning response after the task binding changes', async () => {
    let resolveFirst!: (value: readonly unknown[]) => void;
    const first = new Promise<readonly unknown[]>((resolve) => { resolveFirst = resolve; });
    fetchLearningProposals.mockImplementation((taskId: string) =>
      taskId === 'task-1' ? first : Promise.resolve([{
        schema: 'hercules-learning-proposal-view/v1',
        id: 'proposal-current', taskId: 'task-2',
        projectionHash: reviewPackageFixture({ taskId: 'task-2' }).projectionHash,
        title: 'Current proposal', advisorySummary: 'Current advisory.',
        status: 'proposed', evidenceArtifactIds: ['artifact-1'],
      }]),
    );
    const { rerender } = render(<OutcomeReviewPanel
      packageValue={reviewPackageFixture({ taskId: 'task-1' })} learningEnabled
    />);
    rerender(<OutcomeReviewPanel
      packageValue={reviewPackageFixture({ taskId: 'task-2' })} learningEnabled
    />);
    resolveFirst([{
      schema: 'hercules-learning-proposal-view/v1',
      id: 'proposal-late', taskId: 'task-1',
      projectionHash: reviewPackageFixture({ taskId: 'task-1' }).projectionHash,
      title: 'Late proposal', advisorySummary: 'Late advisory.',
      status: 'proposed', evidenceArtifactIds: ['artifact-1'],
    }]);
    expect(await screen.findByText('Current proposal')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Late proposal')).toBeNull());
  });
});
