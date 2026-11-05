import './setup.js';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskDetail } from '../../../src/web/TaskDetail.js';
import { makeTask, taskDetailDefaults } from './fixtures.js';

describe('TaskDetail dependency rewire', () => {
  it('submits an exact old-set lease and explicit dependency mode', async () => {
    const user = userEvent.setup();
    const onRewireDependencies = vi.fn();
    const task = makeTask({
      state: 'todo', blockedBy: ['old-a', 'old-b'], dependencyMode: 'gate_merge',
    });
    render(<TaskDetail
      {...taskDetailDefaults(task)}
      onRewireDependencies={onRewireDependencies}
    />);

    await user.clear(screen.getByLabelText('Dependency task IDs'));
    await user.type(screen.getByLabelText('Dependency task IDs'), 'new-a, new-b');
    await user.selectOptions(screen.getByLabelText('Dependency mode'), 'completion_only');
    await user.click(screen.getByRole('button', { name: 'Replace dependencies' }));

    expect(onRewireDependencies).toHaveBeenCalledWith({
      id: task.id,
      expectedBlockedBy: ['old-a', 'old-b'],
      blockedBy: ['new-a', 'new-b'],
      dependencyMode: 'completion_only',
    });
  });

  it('does not expose the control for a running task', () => {
    render(<TaskDetail {...taskDetailDefaults(makeTask({ state: 'in_progress' }))} />);
    expect(screen.queryByTestId('dependency-rewire')).not.toBeInTheDocument();
  });
});
