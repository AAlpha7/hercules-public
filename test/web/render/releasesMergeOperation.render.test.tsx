/** Merge Selected resumes from durable server receipts after panel remount. */
import './setup.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { makeReleaseRow } from './fixtures.js';

const fetchReleases = vi.fn();
const fetchMergeOperation = vi.fn();
const mergeRepo = vi.fn();

vi.mock('../../../src/web/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/web/api.js')>();
  return {
    ...actual,
    fetchReleases: (...args: unknown[]) => fetchReleases(...args),
    fetchMergeOperation: (...args: unknown[]) => fetchMergeOperation(...args),
    mergeRepo: (...args: unknown[]) => mergeRepo(...args),
    mintStagingHandoff: () => Promise.reject(new Error('not configured')),
    getToken: () => 'test-token',
  };
});

vi.mock('../../../src/web/releasesCache.js', () => ({
  getCachedReleases: () => null,
  setCachedReleases: () => {},
}));

import { ReleasesPanel } from '../../../src/web/ReleasesPanel.js';
import { ApiError } from '../../../src/web/api.js';

describe('Releases merge operation render path', () => {
  beforeEach(() => {
    localStorage.clear();
    fetchReleases.mockReset();
    fetchMergeOperation.mockReset();
    mergeRepo.mockReset();
    fetchReleases.mockResolvedValue([
      makeReleaseRow({
        mergeableTasks: [
          { id: 'T-1', title: 'Merge me', verifiedSha: 'b'.repeat(40) },
        ],
      }),
    ]);
  });

  it('polls a persisted operation on remount and trusts stamped server success', async () => {
    localStorage.setItem(
      'hercules_merge_ops',
      JSON.stringify({
        app: {
          operationId: 'mop-persisted-1',
          idempotencyKey: 'phone-key-1',
          taskIds: ['T-1'],
          status: 'running',
          phase: 'gating',
        },
      }),
    );
    fetchMergeOperation.mockResolvedValue({
      operationId: 'mop-persisted-1',
      taskIds: ['T-1'],
      status: 'succeeded',
      phase: 'stamped',
      mergedSha: 'a'.repeat(40),
      failures: [],
      failureKind: null,
    });

    render(<ReleasesPanel lang="en" onClose={() => {}} onError={() => {}} />);

    expect(await screen.findByText('succeeded:stamped')).toHaveAttribute(
      'data-evidence',
      'merge-operation-status',
    );
    expect(fetchMergeOperation).toHaveBeenCalledWith('mop-persisted-1');
    expect(await screen.findByText('Merge complete')).toBeInTheDocument();
  });

  it('durably records the exact selection and key before POST, then remount retries them', async () => {
    let persistedBeforePost: unknown = null;
    const lostResponse = new Promise<never>(() => {});
    mergeRepo.mockImplementationOnce((...args: unknown[]) => {
      persistedBeforePost = JSON.parse(localStorage.getItem('hercules_merge_ops') ?? 'null');
      expect(args[0]).toBe('app');
      expect(args[1]).toEqual(['T-1']);
      return lostResponse;
    });
    const first = render(
      <ReleasesPanel lang="en" onClose={() => {}} onError={() => {}} />,
    );
    const checkbox = await screen.findByRole('checkbox');
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: 'Merge selected' }));
    await waitFor(() => expect(mergeRepo).toHaveBeenCalledTimes(1));

    const pending = persistedBeforePost as {
      app: { operationId: null; idempotencyKey: string; taskIds: string[] };
    };
    expect(pending.app).toMatchObject({ operationId: null, taskIds: ['T-1'] });
    expect(pending.app.idempotencyKey).toMatch(/^phone:/);
    first.unmount();

    mergeRepo.mockResolvedValueOnce({
      operationId: 'mop-after-remount-1',
      taskIds: ['T-1'],
      status: 'running',
      phase: 'gating',
      mergedSha: null,
      failures: [],
      failureKind: null,
    });
    render(<ReleasesPanel lang="en" onClose={() => {}} onError={() => {}} />);
    await waitFor(() => expect(mergeRepo).toHaveBeenCalledTimes(2));
    expect(mergeRepo.mock.calls[1]).toEqual([
      'app',
      ['T-1'],
      pending.app.idempotencyKey,
    ]);
    expect(await screen.findByText('running:gating')).toBeInTheDocument();
  });

  it('keeps a lost POST response resumable without reporting merge failure', async () => {
    let persistedBeforePost: unknown = null;
    mergeRepo.mockImplementationOnce(() => {
      persistedBeforePost = JSON.parse(
        localStorage.getItem('hercules_merge_ops') ?? 'null',
      );
      return Promise.reject(new ApiError(0, 'Network error'));
    });
    mergeRepo.mockResolvedValueOnce({
      operationId: 'mop-lost-response-1',
      taskIds: ['T-1'],
      status: 'succeeded',
      phase: 'stamped',
      mergedSha: 'a'.repeat(40),
      failures: [],
      failureKind: null,
    });
    const onError = vi.fn();
    render(<ReleasesPanel lang="en" onClose={() => {}} onError={onError} />);

    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Merge selected' }));

    await waitFor(() => expect(mergeRepo).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });
    const pending = persistedBeforePost as {
      app: { idempotencyKey: string; taskIds: string[] };
    };
    expect(mergeRepo.mock.calls[0]).toEqual([
      'app',
      ['T-1'],
      pending.app.idempotencyKey,
    ]);
    expect(mergeRepo.mock.calls[1]).toEqual(mergeRepo.mock.calls[0]);
    expect(onError).not.toHaveBeenCalled();
    expect(await screen.findByText('succeeded:stamped')).toBeInTheDocument();
  });

  it('keeps a 503 response pending and recovers with the same key', async () => {
    let persistedBeforePost: unknown = null;
    mergeRepo.mockImplementationOnce(() => {
      persistedBeforePost = JSON.parse(
        localStorage.getItem('hercules_merge_ops') ?? 'null',
      );
      return Promise.reject(new ApiError(503, 'temporarily unavailable'));
    });
    mergeRepo.mockResolvedValueOnce({
      operationId: 'mop-503-recovery-1',
      taskIds: ['T-1'],
      status: 'succeeded',
      phase: 'stamped',
      mergedSha: 'a'.repeat(40),
      failures: [],
      failureKind: null,
    });
    const onError = vi.fn();
    render(<ReleasesPanel lang="en" onClose={() => {}} onError={onError} />);

    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Merge selected' }));

    await waitFor(() => expect(mergeRepo).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });
    const pending = persistedBeforePost as {
      app: { operationId: null; idempotencyKey: string; taskIds: string[] };
    };
    expect(pending.app).toMatchObject({ operationId: null, taskIds: ['T-1'] });
    expect(mergeRepo.mock.calls[1]).toEqual(mergeRepo.mock.calls[0]);
    expect(onError).not.toHaveBeenCalled();
    expect(await screen.findByText('succeeded:stamped')).toBeInTheDocument();
  });

  it('clears a definite 4xx rejection and stops retrying it', async () => {
    mergeRepo.mockRejectedValueOnce(new ApiError(409, 'merge rejected'));
    const onError = vi.fn();
    render(<ReleasesPanel lang="en" onClose={() => {}} onError={onError} />);

    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Merge selected' }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith('merge rejected'));
    expect(JSON.parse(localStorage.getItem('hercules_merge_ops') ?? '{}')).toEqual({});
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(mergeRepo).toHaveBeenCalledTimes(1);
  });

  it('clears a pending retry when the server returns a different ordered selection', async () => {
    localStorage.setItem('hercules_merge_ops', JSON.stringify({
      app: {
        operationId: null,
        idempotencyKey: 'phone:mismatch',
        taskIds: ['T-1'],
        status: 'accepted',
        phase: 'accepted',
      },
    }));
    mergeRepo.mockResolvedValue({
      operationId: 'mop-mismatch-1',
      taskIds: ['T-OTHER'],
      status: 'running',
      phase: 'gating',
      mergedSha: null,
      failures: [],
      failureKind: null,
    });
    const onError = vi.fn();
    render(<ReleasesPanel lang="en" onClose={() => {}} onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(JSON.parse(localStorage.getItem('hercules_merge_ops') ?? '{}')).toEqual({});
  });
});
