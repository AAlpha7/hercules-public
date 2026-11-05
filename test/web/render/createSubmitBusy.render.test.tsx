/**
 * Phone path: Create must show busy feedback while the control commit is in flight
 * (operators previously saw 2–3s of no response and double-tapped).
 */
import './setup.js';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeRepo } from './fixtures.js';
import { CreateForm } from '../../../src/web/CreateForm.js';

describe('CreateForm submit busy', () => {
  it('shows Creating… spinner, disables double-tap, then re-enables on settle', async () => {
    const user = userEvent.setup();
    let resolveCreate!: () => void;
    const gate = new Promise<void>((r) => {
      resolveCreate = r;
    });
    const onCreate = vi.fn(() => gate);
    const onClose = vi.fn();

    render(
      <CreateForm
        repos={[makeRepo({ key: 'Demo' })]}
        availableAgents={['grok']}
        defaultAgent="grok"
        preferredAgent="grok"
        initial={{ title: '', repo: 'Demo', body: '' }}
        onClose={onClose}
        onCreate={onCreate}
        onCreatePipeline={() => {}}
      />,
    );

    await user.type(screen.getByLabelText('Title'), '考据默认关闭');
    const submit = screen.getByRole('button', { name: 'Create' });
    await user.click(submit);

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Creating/)).toBeTruthy();
    expect(document.querySelector('[data-evidence="create-submitting"]')).toBeTruthy();
    const busyBtn = screen.getByRole('button', { name: /Creating/ });
    expect(busyBtn).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    // Second click must not fire another create while in flight.
    await user.click(busyBtn);
    expect(onCreate).toHaveBeenCalledTimes(1);

    resolveCreate();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create' })).not.toBeDisabled();
    });
  });

  it('does not close the sheet via backdrop while submitting', async () => {
    const user = userEvent.setup();
    let resolveCreate!: () => void;
    const gate = new Promise<void>((r) => {
      resolveCreate = r;
    });
    const onClose = vi.fn();
    render(
      <CreateForm
        repos={[makeRepo()]}
        availableAgents={['grok']}
        defaultAgent="grok"
        preferredAgent="grok"
        initial={{ title: '', repo: 'app', body: '' }}
        onClose={onClose}
        onCreate={() => gate}
        onCreatePipeline={() => {}}
      />,
    );

    await user.type(screen.getByLabelText('Title'), 'Slow create');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    const backdrop = document.querySelector('.sheet-backdrop');
    expect(backdrop).toBeTruthy();
    backdrop!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();

    resolveCreate();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create' })).not.toBeDisabled();
    });
  });
});
