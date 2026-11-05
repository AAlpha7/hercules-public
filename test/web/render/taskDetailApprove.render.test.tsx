/**
 * Critical path: TaskDetail human AC checkbox → Approve payload.
 */
import './setup.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  greenReviewBody,
  makeTask,
  taskDetailDefaults,
} from './fixtures.js';

vi.mock('../../../src/web/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/web/api.js')>();
  return {
    ...actual,
    fetchPrSummary: vi.fn().mockRejectedValue(new Error('no pr')),
    fetchTaskFiles: vi.fn().mockResolvedValue({ files: [] }),
    fetchTaskFile: vi.fn().mockResolvedValue({ content: '', truncated: false }),
    editRepo: vi.fn(),
  };
});

import { TaskDetail } from '../../../src/web/TaskDetail.js';

const HUMAN = 'Spot-check on device';

describe('TaskDetail Approve render path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables Approve until human criteria are checked', async () => {
    const task = makeTask({ body: greenReviewBody(HUMAN) });
    const { container } = render(<TaskDetail {...taskDetailDefaults(task)} />);

    const approve = container.querySelector(
      '[data-evidence="review-primary-action"]',
    ) as HTMLButtonElement;
    expect(approve).toBeTruthy();
    expect(approve).toBeDisabled();
    expect(approve.textContent).toMatch(/先勾选人工项/);
  });

  it('checking human items then Approve sends humanAcknowledged texts', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const task = makeTask({ body: greenReviewBody(HUMAN) });

    const { container } = render(
      <TaskDetail {...taskDetailDefaults(task)} onAction={onAction} />,
    );

    const approve = container.querySelector(
      '[data-evidence="review-primary-action"]',
    ) as HTMLButtonElement;
    expect(approve).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: HUMAN }));
    expect(approve).toBeEnabled();
    expect(approve.textContent).toMatch(/确认后批准|批准/);

    await user.click(approve);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith('approve', {
      humanAcknowledged: [HUMAN],
    });
  });

  it('preserves the exact legacy acknowledgement payload when V2 read capability exists', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const task = makeTask({ body: greenReviewBody(HUMAN) });

    const { container } = render(
      <TaskDetail
        {...taskDetailDefaults(task)}
        onAction={onAction}
        reviewExperience={{
          preference: 'legacy',
          capabilities: {
            schema: 'hercules-review-experience-capabilities/v1',
            outcomeReviewRead: true,
            boundDecisions: false,
            evidenceContent: false,
            learningProposals: false,
            controlApiV2: false,
          },
          onPreferenceChange: vi.fn(),
          onUnauthorized: vi.fn(),
        }}
      />,
    );

    await user.click(screen.getByRole('checkbox', { name: HUMAN }));
    const approve = container.querySelector(
      '[data-evidence="review-primary-action"]',
    ) as HTMLButtonElement;
    await user.click(approve);
    expect(onAction).toHaveBeenCalledWith('approve', {
      humanAcknowledged: [HUMAN],
    });
  });
});
