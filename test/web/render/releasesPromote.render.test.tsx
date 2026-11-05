/**
 * Critical path: Releases Promote stays disabled when canPromote=false.
 * Restart reconcile: network-layer promote rejection polls the release record.
 */
import './setup.js';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeReleaseRow } from './fixtures.js';
import { ApiError } from '../../../src/web/api.js';
import { promoteReconcileConfig } from '../../../src/web/promoteReconcile.js';

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

const STAGING = 'stagesha1';
const PRIOR_PROD = 'prodsha01';
const DEFAULT_INTERVAL = promoteReconcileConfig.intervalMs;
const DEFAULT_ATTEMPTS = promoteReconcileConfig.maxAttempts;

function renderPanel(onError: (msg: string) => void = () => {}): void {
  render(createElement(ReleasesPanel, { lang: 'en', onClose: () => {}, onError }));
}

async function confirmPromote(): Promise<void> {
  const user = userEvent.setup();
  // Wait for the real repo row: while rows===null the panel renders a disabled
  // shell Promote for L2, and clicking it never arms Confirm.
  await screen.findByText('app');
  const promote = screen.getByRole('button', { name: 'Promote' });
  expect(promote).toBeEnabled();
  await user.click(promote);
  const confirm = await screen.findByRole('button', { name: 'Confirm promote?' });
  await user.click(confirm);
}

function baseRow() {
  return makeReleaseRow({
    canPromote: true,
    hasProductionDeploy: true,
    stagingSha: STAGING,
    productionSha: PRIOR_PROD,
  });
}

describe('Releases Promote render path', () => {
  beforeEach(() => {
    fetchReleases.mockReset();
    mintStagingHandoff.mockReset();
    promoteRepo.mockReset();
    mintStagingHandoff.mockResolvedValue({ code: 'handoff' });
    promoteReconcileConfig.intervalMs = 400;
    promoteReconcileConfig.maxAttempts = 5;
  });

  afterEach(() => {
    promoteReconcileConfig.intervalMs = DEFAULT_INTERVAL;
    promoteReconcileConfig.maxAttempts = DEFAULT_ATTEMPTS;
  });

  it('disables Promote when canPromote is false', async () => {
    fetchReleases.mockResolvedValue([
      makeReleaseRow({ canPromote: false, hasProductionDeploy: true }),
    ]);
    renderPanel();
    await screen.findByText('app');
    const promote = screen.getByRole('button', { name: 'Promote' });
    expect(promote).toHaveAttribute('data-evidence', 'promote-btn');
    expect(promote).toBeDisabled();
  });

  it('shows a queued pill instead of stale ready while main is ahead of staging', async () => {
    // Merge landed on main; reconciler is inside its debounce window, so the
    // record still carries the previous sha's `ready`.
    fetchReleases.mockResolvedValue([
      makeReleaseRow({ stagingStatus: 'ready', stagingSha: 'stagesha1', mainSha: 'newmain01' }),
    ]);
    renderPanel();
    await screen.findByText('app');
    const pill = document.querySelector('[data-evidence="staging-status"]');
    expect(pill).toHaveAttribute('data-queued', 'true');
    expect(pill).toHaveClass('pill-tone-warn');
    expect(pill).toHaveTextContent('main ahead · staging verify queued');
    expect(pill).not.toHaveTextContent('ready');
  });

  it('keeps the plain status pill when staging is at main (control)', async () => {
    fetchReleases.mockResolvedValue([
      makeReleaseRow({ stagingStatus: 'ready', stagingSha: 'stagesha1', mainSha: 'stagesha1' }),
    ]);
    renderPanel();
    await screen.findByText('app');
    const pill = document.querySelector('[data-evidence="staging-status"]');
    expect(pill).not.toHaveAttribute('data-queued');
    expect(pill).toHaveClass('pill-tone-success');
    expect(pill).toHaveTextContent('ready');
  });

  it('enables Promote when canPromote is true (control)', async () => {
    fetchReleases.mockResolvedValue([
      makeReleaseRow({ canPromote: true, hasProductionDeploy: true }),
    ]);
    renderPanel();
    await screen.findByText('app');
    expect(screen.getByRole('button', { name: 'Promote' })).toBeEnabled();
  });

  it('enters reconciling state on network reject, polls, and surfaces success', async () => {
    promoteRepo.mockRejectedValueOnce(new ApiError(0, 'Network error'));
    fetchReleases
      .mockResolvedValueOnce([baseRow()])
      .mockRejectedValueOnce(new ApiError(0, 'Network error'))
      .mockResolvedValueOnce([
        makeReleaseRow({
          canPromote: false,
          hasProductionDeploy: true,
          stagingSha: STAGING,
          productionSha: PRIOR_PROD,
          promotingSha: STAGING,
          history: [],
        }),
      ])
      .mockResolvedValue([
        makeReleaseRow({
          canPromote: false,
          hasProductionDeploy: true,
          stagingSha: STAGING,
          productionSha: STAGING,
          promotingSha: null,
          history: [{ sha: STAGING, at: '2026-09-01T07:02:00Z', outcome: 'ok' }],
        }),
      ]);

    const onError = vi.fn();
    renderPanel(onError);
    await confirmPromote();

    const flash = await screen.findByRole('status');
    expect(flash).toHaveAttribute('data-evidence', 'releases-flash');
    expect(flash).toHaveTextContent(/service restarting/i);
    await waitFor(
      () => {
        expect(screen.getByRole('status')).toHaveTextContent(/Promoted to production/);
      },
      { timeout: 4_000 },
    );
    expect(onError).not.toHaveBeenCalled();
    expect(fetchReleases.mock.calls.length).toBeGreaterThan(1);
  });

  it('resolves network reject to failure with rollback target', async () => {
    promoteRepo.mockRejectedValueOnce(new ApiError(0, 'Network error'));
    fetchReleases.mockResolvedValueOnce([baseRow()]);
    fetchReleases.mockResolvedValue([
      makeReleaseRow({
        canPromote: false,
        hasProductionDeploy: true,
        stagingSha: STAGING,
        productionSha: PRIOR_PROD,
        promotingSha: null,
        history: [
          {
            sha: PRIOR_PROD,
            at: '2026-09-01T07:03:00Z',
            outcome: 'rolled_back',
            rollbackOf: STAGING,
          },
        ],
      }),
    ]);

    const onError = vi.fn();
    renderPanel(onError);
    await confirmPromote();

    const flash = await screen.findByRole('status');
    expect(flash).toHaveAttribute('data-evidence', 'releases-flash');
    expect(flash).toHaveTextContent(/service restarting/i);
    await waitFor(() => expect(onError).toHaveBeenCalled(), { timeout: 3_000 });
    const msg = String(onError.mock.calls[0]?.[0] ?? '');
    expect(msg).toMatch(/rolled back|Promote failed/i);
    expect(msg).toMatch(new RegExp(PRIOR_PROD.slice(0, 8)));
  });

  it('surfaces HTTP promote errors immediately without polling', async () => {
    promoteRepo.mockRejectedValueOnce(new ApiError(409, 'promote blocked: staging drift'));
    const onError = vi.fn();
    fetchReleases.mockResolvedValue([baseRow()]);
    renderPanel(onError);
    await confirmPromote();

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith('promote blocked: staging drift');
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(fetchReleases).toHaveBeenCalledTimes(1);
  });

  it('surfaces honest unknown on bounded timeout', async () => {
    promoteRepo.mockRejectedValueOnce(new ApiError(0, 'Network error'));
    fetchReleases.mockResolvedValue([
      makeReleaseRow({
        canPromote: true,
        hasProductionDeploy: true,
        stagingSha: STAGING,
        productionSha: PRIOR_PROD,
        promotingSha: STAGING,
        history: [],
      }),
    ]);

    const onError = vi.fn();
    renderPanel(onError);
    await confirmPromote();

    const flash = await screen.findByRole('status');
    expect(flash).toHaveAttribute('data-evidence', 'releases-flash');
    expect(flash).toHaveTextContent(/service restarting/i);
    await waitFor(
      () => {
        expect(screen.getByRole('status')).toHaveTextContent(/Could not confirm promote/i);
      },
      { timeout: 4_000 },
    );
    expect(onError).not.toHaveBeenCalled();
  });
});
