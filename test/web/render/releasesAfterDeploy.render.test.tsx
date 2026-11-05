/**
 * After-deploy optional checklist on Releases: ticks are local-only and
 * never gate Promote.
 */
import './setup.js';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeReleaseRow } from './fixtures.js';

const fetchReleases = vi.fn();
const mintStagingHandoff = vi.fn();
const promoteRepo = vi.fn();

vi.mock('../../../src/web/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/web/api.js')>();
  return {
    ...actual,
    fetchReleases: (...args: unknown[]) => fetchReleases(...args),
    mintStagingHandoff: (...args: unknown[]) => mintStagingHandoff(...args),
    promoteRepo: (...args: unknown[]) => promoteRepo(...args),
    getToken: () => 'test-token',
  };
});

vi.mock('../../../src/web/releasesCache.js', () => ({
  getCachedReleases: () => null,
  setCachedReleases: () => {},
}));

import { ReleasesPanel } from '../../../src/web/ReleasesPanel.js';

const PROD = 'prodsha01';

function renderPanel(): void {
  render(createElement(ReleasesPanel, { lang: 'en', onClose: () => {}, onError: () => {} }));
}

describe('Releases after-deploy checklist', () => {
  beforeEach(() => {
    fetchReleases.mockReset();
    mintStagingHandoff.mockReset();
    promoteRepo.mockReset();
    mintStagingHandoff.mockResolvedValue({ code: 'handoff' });
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('renders checks with unchecked boxes and persists a tick to localStorage', async () => {
    fetchReleases.mockResolvedValue([
      makeReleaseRow({
        canPromote: true,
        productionSha: PROD,
        afterDeployChecks: [
          { taskId: 't1', title: 'Ship /x', text: 'Open /x on the phone' },
          { taskId: 't2', title: 'Badge', text: 'Confirm live badge' },
        ],
      }),
    ]);
    renderPanel();
    await screen.findByText('app');

    const block = document.querySelector('[data-evidence="releases-after-deploy"]');
    expect(block).not.toBeNull();
    expect(block).toHaveTextContent('Open /x on the phone');
    expect(block).toHaveTextContent('Confirm live badge');

    const boxes = block!.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).not.toBeChecked();
    expect(boxes[1]).not.toBeChecked();

    const user = userEvent.setup();
    await user.click(boxes[0]!);

    const firstLi = block!.querySelector('li');
    expect(firstLi).toHaveClass('is-done');
    const stored = localStorage.getItem(`hercules.afterDeploy.app.${PROD}`);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!)).toContain('t1#0');

    const promote = screen.getByRole('button', { name: 'Promote' });
    expect(promote).toBeEnabled();
  });

  it('does not render the block when afterDeployChecks is empty', async () => {
    fetchReleases.mockResolvedValue([
      makeReleaseRow({ canPromote: true, afterDeployChecks: [] }),
    ]);
    renderPanel();
    await screen.findByText('app');
    expect(document.querySelector('[data-evidence="releases-after-deploy"]')).toBeNull();
  });
});
