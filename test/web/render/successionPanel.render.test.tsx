import './setup.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { makeRepo } from './fixtures.js';

const { fetchWorkspaceSuccession } = vi.hoisted(() => ({
  fetchWorkspaceSuccession: vi.fn(),
}));
vi.mock('../../../src/web/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/web/api.js')>();
  return { ...actual, fetchWorkspaceSuccession };
});

import { SuccessionPanel } from '../../../src/web/SuccessionPanel.js';
import { ReposPanel } from '../../../src/web/ReposPanel.js';

function receipt(canonical: string, disposition: 'live' | 'preserved' = 'preserved') {
  return {
    id: `succ-app-${canonical}`,
    repoKey: 'app',
    createdAt: '2026-08-04T12:00:00.000Z',
    priorDefaultRevision: '1'.repeat(40),
    gateMergeSha: canonical,
    canonicalDefaultRevision: canonical,
    classifications: [{
      registrationId: 'owner-main',
      classification: 'diverged',
      concurrentChange: false,
      guidance: [{
        code: 'inspect_divergence',
        text: 'Inspect both unique histories and recover chosen commits manually.',
        destructive: false,
      }],
    }],
    managed: [{ taskId: 'task-1', disposition }],
    supersedesReceiptId: null,
    receiptCount: 1,
    offersDestructiveAction: false,
  };
}

describe('workspace succession phone panel', () => {
  beforeEach(() => fetchWorkspaceSuccession.mockReset());

  it('renders canonical base, classification and only safe manual choices', async () => {
    fetchWorkspaceSuccession.mockResolvedValue(receipt('3'.repeat(40)));
    const { container } = render(<SuccessionPanel repoKey="app" />);
    expect(await screen.findByText(/Canonical base/)).toHaveAttribute(
      'data-evidence', 'succession-canonical',
    );
    expect(screen.getByText(/owner-main: diverged/)).toBeInTheDocument();
    expect(screen.getByText(/task-1/).closest('li')).toHaveTextContent('preserved');
    expect(container.querySelector('[data-evidence=workspace-succession]')).not.toBeNull();
    expect(container.querySelector('[data-evidence=succession-choices]')).not.toBeNull();
    expect(container.textContent).not.toMatch(/reset --hard|force.push|delete checkout/i);
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders for a non-deploy repo and refreshes stale canonical data on runtime advance', async () => {
    fetchWorkspaceSuccession
      .mockResolvedValueOnce(receipt('3'.repeat(40)))
      .mockResolvedValueOnce(receipt('4'.repeat(40), 'live'));
    const props = {
      repos: [makeRepo()],
      defaultAgent: 'grok',
      availableAgents: ['grok'],
      onClose: () => {},
      onError: () => {},
    };
    const { container, rerender } = render(
      <ReposPanel {...props} successionRefreshKey={1} />,
    );
    await waitFor(() => expect(
      container.querySelector('[data-evidence=workspace-succession]'),
    ).not.toBeNull());
    const surface = container.querySelector('[data-evidence=workspace-succession]')!;
    expect(surface).toHaveTextContent('333333333333');
    expect(surface).toHaveTextContent('task-1: preserved');

    rerender(<ReposPanel {...props} successionRefreshKey={2} />);
    await waitFor(() => expect(surface).toHaveTextContent('444444444444'));
    expect(surface).toHaveTextContent('task-1: live');
    expect(surface).not.toHaveTextContent('/home/');
    expect(surface).not.toHaveTextContent(/reset --hard|delete checkout/i);
    expect(surface!.querySelector('button')).toBeNull();
  });
});
