/**
 * Critical path: Repos → edit auto-merge pilot policy.
 * Badge visibility + conditional PATCH payload.
 */
import './setup.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeRepo } from './fixtures.js';

const editRepo = vi.fn();
const checkRepoReadiness = vi.fn();

vi.mock('../../../src/web/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/web/api.js')>();
  return {
    ...actual,
    editRepo: (...args: unknown[]) => editRepo(...args),
    checkRepoReadiness: (...args: unknown[]) => checkRepoReadiness(...args),
  };
});

import { ReposPanel } from '../../../src/web/ReposPanel.js';

describe('Repos auto-merge render path', () => {
  beforeEach(() => {
    editRepo.mockReset();
    checkRepoReadiness.mockReset();
    editRepo.mockResolvedValue(makeRepo({ readiness: 'ready' }));
    checkRepoReadiness.mockResolvedValue({
      ok: true,
      summary: 'ok',
      score: { passed: 1, total: 1, requiredPassed: 1, requiredTotal: 1 },
      checks: [],
    });
  });

  it('shows the auto-merge badge only for repos with the pilot enabled', () => {
    render(
      <ReposPanel
        repos={[
          makeRepo({ key: 'off', readiness: 'ready' }),
          makeRepo({
            key: 'on',
            readiness: 'ready',
            autoMerge: { enabled: true, dwellMinutes: 15, maxSize: 'S' },
          }),
        ]}
        defaultAgent="grok"
        availableAgents={['grok']}
        onClose={() => {}}
        onError={() => {}}
      />,
    );

    const badges = document.querySelectorAll('[data-evidence=repo-auto-merge-badge]');
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent).toContain('≤S');
    expect(badges[0]?.textContent).toContain('15m');
  });

  it('saves the auto-merge policy when the operator enables it', async () => {
    const user = userEvent.setup();
    render(
      <ReposPanel
        repos={[makeRepo({ readiness: 'incomplete' })]}
        defaultAgent="grok"
        availableAgents={['grok']}
        onClose={() => {}}
        onError={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const enabled = document.querySelector(
      '[data-evidence=repo-auto-merge-enabled]',
    ) as HTMLInputElement;
    expect(enabled).toBeInstanceOf(HTMLInputElement);
    await user.click(enabled);

    const dwell = document.querySelector(
      '[data-evidence=repo-auto-merge-dwell]',
    ) as HTMLInputElement;
    await user.clear(dwell);
    await user.type(dwell, '45');

    const maxSize = document.querySelector(
      '[data-evidence=repo-auto-merge-max-size]',
    ) as HTMLSelectElement;
    await user.selectOptions(maxSize, 'L');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(editRepo).toHaveBeenCalledWith(
        'app',
        expect.objectContaining({
          autoMerge: { enabled: true, dwellMinutes: 45, maxSize: 'L' },
        }),
      ),
    );
  });

  it('does not send autoMerge when the policy is unchanged', async () => {
    const user = userEvent.setup();
    render(
      <ReposPanel
        repos={[makeRepo({ readiness: 'incomplete', maxConcurrent: 1 })]}
        defaultAgent="grok"
        availableAgents={['grok']}
        onClose={() => {}}
        onError={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const mc = screen.getByDisplayValue('1');
    await user.clear(mc);
    await user.type(mc, '2');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(editRepo).toHaveBeenCalled());
    const patch = editRepo.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(patch).toMatchObject({ maxConcurrent: 2 });
    expect(patch).not.toHaveProperty('autoMerge');
  });
});
