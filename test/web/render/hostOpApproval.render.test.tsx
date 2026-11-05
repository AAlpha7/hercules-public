/**
 * Phone path: host_operation task → enter named command scope → approve.
 */
import './setup.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeTask, taskDetailDefaults } from './fixtures.js';

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

describe('TaskDetail host-operation approval render path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows host-op panel for host_operation without approval and submits scope', async () => {
    const user = userEvent.setup();
    const onApproveHostOperation = vi.fn();
    const task = makeTask({
      state: 'todo',
      executionClass: 'host_operation',
      hostCommandScope: null,
      hostApprovedAt: null,
      body: '## Goal\nRestart the unit safely.\n',
    });

    render(
      <TaskDetail
        {...taskDetailDefaults(task)}
        onApproveHostOperation={onApproveHostOperation}
      />,
    );

    expect(document.querySelector('[data-evidence=host-op-approval]')).toBeTruthy();
    const input = document.querySelector(
      '[data-evidence=host-op-scope-input]',
    ) as HTMLTextAreaElement;
    expect(input).toBeTruthy();

    fireEvent.change(input, {
      target: {
        value: 'systemctl restart hercules\ncurl -sf http://localhost:8787/',
      },
    });

    const btn = document.querySelector(
      '[data-evidence=host-op-approve-btn]',
    ) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);
    await user.click(btn);

    expect(onApproveHostOperation).toHaveBeenCalledTimes(1);
    expect(onApproveHostOperation).toHaveBeenCalledWith([
      'systemctl restart hercules',
      'curl -sf http://localhost:8787/',
    ]);
  });

  it('hides host-op panel for ordinary implement tasks', () => {
    const task = makeTask({
      state: 'todo',
      executionClass: 'implement',
      body: '## Goal\nfix a bug.\n',
    });
    render(<TaskDetail {...taskDetailDefaults(task)} />);
    expect(document.querySelector('[data-evidence=host-op-approval]')).toBeNull();
  });

  it('shows approved chip and a prefilled revision path when scope is recorded', () => {
    const task = makeTask({
      state: 'todo',
      executionClass: 'deploy',
      hostCommandScope: ['./scripts/deploy-staging.sh'],
      hostApprovedAt: '2026-07-31T12:00:00.000Z',
      body: '## Goal\nDeploy staging.\n',
    });
    render(<TaskDetail {...taskDetailDefaults(task)} />);
    expect(document.querySelector('[data-evidence=host-op-approval]')).toBeTruthy();
    const approved = document.querySelector('[data-evidence=host-op-approved]');
    expect(approved).toBeTruthy();
    expect(approved?.textContent).toContain('./scripts/deploy-staging.sh');
    expect((screen.getByLabelText('Named command scope') as HTMLTextAreaElement).value).toBe(
      './scripts/deploy-staging.sh',
    );
    expect(screen.getByRole('button', { name: 'Update host approval' })).toBeTruthy();
  });

  it('clears an unsubmitted scope draft when switching tasks', async () => {
    const first = makeTask({
      id: 'HOST-A',
      state: 'todo',
      executionClass: 'host_operation',
      hostCommandScope: null,
      hostApprovedAt: null,
    });
    const second = makeTask({
      id: 'HOST-B',
      state: 'todo',
      executionClass: 'host_operation',
      hostCommandScope: null,
      hostApprovedAt: null,
    });
    const { rerender } = render(
      <TaskDetail {...taskDetailDefaults(first)} onApproveHostOperation={() => {}} />,
    );
    const input = screen.getByLabelText('Named command scope') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'systemctl restart hercules' } });
    expect(input.value).toContain('systemctl');

    rerender(<TaskDetail {...taskDetailDefaults(second)} onApproveHostOperation={() => {}} />);
    expect((screen.getByLabelText('Named command scope') as HTMLTextAreaElement).value).toBe('');
  });
});
