/**
 * Phone path: New task -> choose host/deploy execution class -> create.
 */
import './setup.js';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeRepo } from './fixtures.js';
import { CreateForm } from '../../../src/web/CreateForm.js';

describe('CreateForm execution class', () => {
  it('submits the selected host execution class', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(
      <CreateForm
        repos={[makeRepo()]}
        availableAgents={['grok', 'claude']}
        defaultAgent="grok"
        preferredAgent="claude"
        initial={{ title: '', repo: 'app', body: '' }}
        onClose={() => {}}
        onCreate={onCreate}
        onCreatePipeline={() => {}}
      />,
    );

    await user.type(screen.getByLabelText('Title'), 'Deploy Hercules');
    await user.selectOptions(screen.getByLabelText('Execution'), 'deploy');
    const agent = screen.getByLabelText('Agent') as HTMLSelectElement;
    expect(agent.value).toBe('grok');
    expect(agent.disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      title: 'Deploy Hercules',
      adapter: 'grok',
      executionClass: 'deploy',
    });
  });
});
