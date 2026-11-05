/**
 * Critical path: TaskDetail operator override-approve (short reason disables button).
 */
import './setup.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  blockedReviewBody,
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
const REASON = 'L2 flake confirmed green on re-run offline';

describe('TaskDetail override-approve render path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps override button disabled until reason is ≥10 chars, then sends overrideNote', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const task = makeTask({ body: blockedReviewBody(HUMAN) });

    render(<TaskDetail {...taskDetailDefaults(task)} onAction={onAction} />);

    // Override section only appears after human ACs are checked (and machine not green).
    expect(screen.queryByRole('button', { name: /覆盖批准/ })).toBeNull();

    await user.click(screen.getByRole('checkbox', { name: HUMAN }));

    expect(document.querySelector('[data-evidence="override-approve"]')).not.toBeNull();

    const overrideBtn = screen.getByRole('button', { name: /覆盖批准/ });
    expect(overrideBtn).toBeDisabled();

    const note = screen.getByPlaceholderText(/为什么在验证未全绿/);
    // fireEvent.change for length gates (faster than per-key userEvent.type).
    fireEvent.change(note, { target: { value: 'short' } });
    expect(overrideBtn).toBeDisabled();

    fireEvent.change(note, { target: { value: REASON } });
    expect(overrideBtn).toBeEnabled();

    await user.click(overrideBtn);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith('approve', {
      humanAcknowledged: [HUMAN],
      overrideNote: REASON,
    });
  });
});
