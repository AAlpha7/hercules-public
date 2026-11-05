/**
 * Critical path: todo TaskDetail -> To front -> onQueueFront.
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

describe('TaskDetail queue-front render path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows To front on todo and clicks -> onQueueFront', async () => {
    const user = userEvent.setup();
    const onQueueFront = vi.fn();
    const task = makeTask({ id: 'q-1', state: 'todo', priority: 50 });
    render(<TaskDetail {...taskDetailDefaults(task)} onQueueFront={onQueueFront} />);
    const btn = screen.getByRole('button', { name: 'To front' });
    expect(btn).toHaveAttribute('data-evidence', 'queue-front');
    await user.click(btn);
    expect(onQueueFront).toHaveBeenCalledTimes(1);
  });

  it('shows To front on retrying', () => {
    const task = makeTask({ state: 'retrying' });
    render(<TaskDetail {...taskDetailDefaults(task)} onQueueFront={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'To front' })).toBeInTheDocument();
  });

  it('hides To front when not queued', () => {
    const task = makeTask({ state: 'review' });
    render(<TaskDetail {...taskDetailDefaults(task)} onQueueFront={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'To front' })).toBeNull();
  });
});
