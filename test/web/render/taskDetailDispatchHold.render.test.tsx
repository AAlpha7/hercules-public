/**
 * Critical path: todo TaskDetail shows dispatch-hold banner from scheduling reason.
 */
import './setup.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

describe('TaskDetail dispatch-hold render path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders G8 readiness hold banner with data-evidence=dispatch-hold', () => {
    const task = makeTask({
      id: 'acme-docs-cleanup',
      state: 'todo',
      repo: 'orbit',
      labels: ['source=acme', 'docs'],
    });
    render(
      <TaskDetail
        {...taskDetailDefaults(task)}
        dispatchHoldReason={{ code: 'repo_readiness_incomplete', repo: 'orbit' }}
      />,
    );
    const banner = screen.getByText(/仓库 orbit 未标记就绪/);
    expect(banner).toHaveAttribute('data-evidence', 'dispatch-hold');
    expect(banner.textContent).toMatch(/onboarding\/readiness/);
  });

  it('hides dispatch-hold banner when reason is null', () => {
    const task = makeTask({ state: 'todo' });
    render(<TaskDetail {...taskDetailDefaults(task)} dispatchHoldReason={null} />);
    expect(document.querySelector('[data-evidence="dispatch-hold"]')).toBeNull();
  });
});
