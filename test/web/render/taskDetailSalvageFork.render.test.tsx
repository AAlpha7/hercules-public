/**
 * Critical path: failed/cancelled TaskDetail → Clean salvage → API callback.
 */
import './setup.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeTask, taskDetailDefaults } from './fixtures.js';
import { TaskDetail } from '../../../src/web/TaskDetail.js';

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

describe('TaskDetail Clean salvage render path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows Clean salvage on failed tasks and confirms → onSalvageFork', async () => {
    const user = userEvent.setup();
    const onSalvageFork = vi.fn();
    const task = makeTask({
      id: 'fail-1',
      state: 'failed',
      attempts: 3,
      body: '## Goal\nShip\n\n## Salvage brief\nRetry first\n',
    });

    render(
      <TaskDetail {...taskDetailDefaults(task)} onSalvageFork={onSalvageFork} />,
    );

    const btn = screen.getByRole('button', { name: 'Clean salvage' });
    expect(btn).toHaveAttribute('data-evidence', 'salvage-fork');
    // Retry remains primary recovery.
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveAttribute(
      'data-evidence',
      'task-retry',
    );

    await user.click(btn);
    // ConfirmButton arm → confirm
    const confirm = screen.getByRole('button', { name: 'Fork new task from tip?' });
    await user.click(confirm);
    expect(onSalvageFork).toHaveBeenCalledTimes(1);
  });

  it('shows Clean salvage on cancelled tasks with attempts > 0 and confirms → onSalvageFork', async () => {
    const user = userEvent.setup();
    const onSalvageFork = vi.fn();
    const task = makeTask({
      id: 'canc-1',
      state: 'cancelled',
      attempts: 3,
      body: '## Goal\nShip\n',
    });

    render(
      <TaskDetail {...taskDetailDefaults(task)} onSalvageFork={onSalvageFork} />,
    );

    const btn = screen.getByRole('button', { name: 'Clean salvage' });
    expect(btn).toHaveAttribute('data-evidence', 'salvage-fork');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();

    await user.click(btn);
    const confirm = screen.getByRole('button', { name: 'Fork new task from tip?' });
    await user.click(confirm);
    expect(onSalvageFork).toHaveBeenCalledTimes(1);
  });

  it('hides Clean salvage on cancelled tasks with attempts 0', () => {
    const task = makeTask({
      id: 'canc-0',
      state: 'cancelled',
      attempts: 0,
    });
    render(
      <TaskDetail {...taskDetailDefaults(task)} onSalvageFork={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'Clean salvage' })).toBeNull();
  });

  it('hides Clean salvage when not failed', () => {
    const task = makeTask({ state: 'review' });
    render(
      <TaskDetail {...taskDetailDefaults(task)} onSalvageFork={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'Clean salvage' })).toBeNull();
  });

  it('failed banner states Retry reuses preserved branch', () => {
    const task = makeTask({
      id: 'fail-banner',
      state: 'failed',
      body: '## Review packet\n**Status:** fail\n',
    });
    render(<TaskDetail {...taskDetailDefaults(task)} onSalvageFork={vi.fn()} />);
    const banner = document.querySelector('[data-evidence="task-failed-banner"]');
    expect(banner?.textContent).toMatch(/Retry/i);
    expect(banner?.textContent).toMatch(/preserved branch|Clean salvage/i);
  });
});
