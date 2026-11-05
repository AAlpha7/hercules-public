/**
 * Critical path: Repos → async readiness check + Mark ready fail-closed.
 */
import './setup.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeRepo } from './fixtures.js';

const editRepo = vi.fn();
const startRepoReadinessCheck = vi.fn();
const fetchRepoReadinessCheck = vi.fn();
const checkRepoReadiness = vi.fn();

vi.mock('../../../src/web/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/web/api.js')>();
  return {
    ...actual,
    editRepo: (...args: unknown[]) => editRepo(...args),
    startRepoReadinessCheck: (...args: unknown[]) => startRepoReadinessCheck(...args),
    fetchRepoReadinessCheck: (...args: unknown[]) => fetchRepoReadinessCheck(...args),
    checkRepoReadiness: (...args: unknown[]) => checkRepoReadiness(...args),
  };
});

import {
  ReposPanel,
  readinessCheckConfig,
} from '../../../src/web/ReposPanel.js';

readinessCheckConfig.pollMs = 50;
readinessCheckConfig.waitCapMs = 5_000;

const failedCheck = {
  ok: false,
  summary: '1 required gap',
  score: { passed: 0, total: 1, requiredPassed: 0, requiredTotal: 1 },
  checks: [
    {
      id: 'workflow',
      ok: false,
      label: 'WORKFLOW.md',
      detail: 'missing gates section',
      required: true,
    },
  ],
};

const okCheck = {
  ok: true,
  summary: 'all required ok',
  score: { passed: 1, total: 1, requiredPassed: 1, requiredTotal: 1 },
  checks: [
    {
      id: 'workflow',
      ok: true,
      label: 'WORKFLOW.md',
      detail: 'ok',
      required: true,
    },
  ],
};

const guardianFailedCheck = {
  ...failedCheck,
  guardian: {
    version: 1,
    applicable: true,
    ok: false,
    profile: 'guardian',
    summary: 'CLI evidence is stale',
    failedCodes: ['cli_evidence_stale'],
    grantsOnly: 'harness_readiness' as const,
    provenance: {
      defaultRevision: 'a'.repeat(40),
      workflowSha256: 'b'.repeat(64),
      policySha256: 'c'.repeat(64),
    },
    controls: [{
      id: 'cli_behavioral_evidence', ok: false, code: 'cli_evidence_stale',
      label: 'Trusted CLI behavioral evidence', detail: 'stale',
      remediation: 'Rerun readiness verification against the current trusted revision',
    }],
  },
};

describe('Repos Mark ready render path', () => {
  beforeEach(() => {
    editRepo.mockReset();
    startRepoReadinessCheck.mockReset();
    fetchRepoReadinessCheck.mockReset();
    checkRepoReadiness.mockReset();
    editRepo.mockResolvedValue(makeRepo({ readiness: 'ready' }));
    startRepoReadinessCheck.mockResolvedValue({
      key: 'app',
      status: 'running',
      startedAt: new Date().toISOString(),
    });
    fetchRepoReadinessCheck.mockResolvedValue({
      key: 'app',
      status: 'done',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      result: failedCheck,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Check readiness shows running status then result without disabling other repos', async () => {
    const user = userEvent.setup();
    let polls = 0;
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    startRepoReadinessCheck.mockResolvedValue({
      key: 'app',
      status: 'running',
      startedAt,
    });
    fetchRepoReadinessCheck.mockImplementation(async () => {
      polls += 1;
      if (polls < 2) {
        return { key: 'app', status: 'running', startedAt };
      }
      return {
        key: 'app',
        status: 'done',
        startedAt,
        finishedAt: new Date().toISOString(),
        result: okCheck,
      };
    });

    render(
      <ReposPanel
        repos={[
          makeRepo({ key: 'app', readiness: 'incomplete' }),
          makeRepo({ key: 'other', readiness: 'incomplete' }),
        ]}
        defaultAgent="grok"
        availableAgents={['grok']}
        onClose={() => {}}
        onError={() => {}}
      />,
    );

    const appCard = document.querySelector('[data-evidence=repo-app]') as HTMLElement;
    const otherCard = document.querySelector('[data-evidence=repo-other]') as HTMLElement;
    expect(appCard).not.toBeNull();
    expect(otherCard).not.toBeNull();

    await user.click(
      appCard.querySelector('[data-evidence=repo-check-readiness]') as HTMLButtonElement,
    );

    await waitFor(() => {
      expect(startRepoReadinessCheck).toHaveBeenCalledWith('app', { retryCliEvidence: true });
    });
    expect(await screen.findByText(/检查中/)).toBeInTheDocument();
    expect(appCard.querySelector('[data-evidence=repo-readiness-status]')).not.toBeNull();

    const otherMark = otherCard.querySelector('[data-evidence=repo-mark-ready]');
    expect(otherMark).toBeInstanceOf(HTMLButtonElement);
    expect(otherMark).not.toBeDisabled();
    const otherCheck = otherCard.querySelector('[data-evidence=repo-check-readiness]');
    expect(otherCheck).toBeInstanceOf(HTMLButtonElement);
    expect(otherCheck).not.toBeDisabled();

    await waitFor(() => {
      expect(screen.getByText(/检查完成 1\/1/)).toBeInTheDocument();
    }, { timeout: 8_000 });
    expect(await screen.findByText(/checklist 1\/1/)).toBeInTheDocument();
  });

  it('Mark ready with a fresh ok result patches directly', async () => {
    const user = userEvent.setup();
    const finishedAt = new Date().toISOString();
    // Seed via Check readiness first so jobByRepo has a fresh done/ok.
    startRepoReadinessCheck.mockResolvedValue({
      key: 'app',
      status: 'running',
      startedAt: finishedAt,
    });
    fetchRepoReadinessCheck.mockResolvedValue({
      key: 'app',
      status: 'done',
      startedAt: finishedAt,
      finishedAt,
      result: okCheck,
    });

    render(
      <ReposPanel
        repos={[makeRepo({ readiness: 'incomplete' })]}
        defaultAgent="grok"
        availableAgents={['grok']}
        onClose={() => {}}
        onError={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Check readiness' }));
    await waitFor(() => {
      expect(screen.getByText(/检查完成/)).toBeInTheDocument();
    });

    startRepoReadinessCheck.mockClear();
    fetchRepoReadinessCheck.mockClear();

    await user.click(screen.getByRole('button', { name: 'Mark ready' }));
    await user.click(screen.getByRole('button', { name: 'Check WORKFLOW/AGENTS?' }));

    await waitFor(() => {
      expect(editRepo).toHaveBeenCalledWith('app', { readiness: 'ready' });
    });
    expect(startRepoReadinessCheck).not.toHaveBeenCalled();
    expect(editRepo.mock.calls.some((c) => c[1]?.forceReady === true)).toBe(false);
  });

  it('after soft-check fails, confirm sends forceReady: true', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <ReposPanel
        repos={[makeRepo({ readiness: 'incomplete' })]}
        defaultAgent="grok"
        availableAgents={['grok']}
        onClose={() => {}}
        onError={() => {}}
      />,
    );

    const markReady = screen.getByRole('button', { name: 'Mark ready' });
    expect(markReady).toHaveAttribute('data-evidence', 'repo-mark-ready');

    await user.click(markReady);
    await user.click(screen.getByRole('button', { name: 'Check WORKFLOW/AGENTS?' }));

    await waitFor(() => {
      expect(startRepoReadinessCheck).toHaveBeenCalledWith('app', { retryCliEvidence: true });
    });
    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(editRepo).toHaveBeenCalledWith('app', {
        readiness: 'ready',
        forceReady: true,
      });
    });

    confirmSpy.mockRestore();
  });

  it('after soft-check fails, cancel does not call editRepo', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(
      <ReposPanel
        repos={[makeRepo({ readiness: 'incomplete' })]}
        defaultAgent="grok"
        availableAgents={['grok']}
        onClose={() => {}}
        onError={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Mark ready' }));
    await user.click(screen.getByRole('button', { name: 'Check WORKFLOW/AGENTS?' }));

    await waitFor(() => {
      expect(startRepoReadinessCheck).toHaveBeenCalledWith('app', { retryCliEvidence: true });
    });
    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalled();
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(editRepo).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it('Mark ready with error shows force button and does NOT patch', async () => {
    const user = userEvent.setup();
    startRepoReadinessCheck.mockResolvedValue({
      key: 'app',
      status: 'running',
      startedAt: new Date().toISOString(),
    });
    fetchRepoReadinessCheck.mockResolvedValue({
      key: 'app',
      status: 'error',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      error: 'proxy timeout',
    });

    render(
      <ReposPanel
        repos={[makeRepo({ readiness: 'incomplete' })]}
        defaultAgent="grok"
        availableAgents={['grok']}
        onClose={() => {}}
        onError={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Mark ready' }));
    await user.click(screen.getByRole('button', { name: 'Check WORKFLOW/AGENTS?' }));

    expect(
      await screen.findByRole('button', { name: '强制标记就绪（跳过检查）' }),
    ).toBeInTheDocument();
    expect(document.querySelector('[data-evidence=repo-mark-ready-force]')).not.toBeNull();
    expect(screen.getByText(/检查失败: proxy timeout/)).toBeInTheDocument();
    expect(editRepo).not.toHaveBeenCalled();
  });

  it('force button patches with forceReady: true', async () => {
    const user = userEvent.setup();
    startRepoReadinessCheck.mockResolvedValue({
      key: 'app',
      status: 'running',
      startedAt: new Date().toISOString(),
    });
    fetchRepoReadinessCheck.mockResolvedValue({
      key: 'app',
      status: 'error',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      error: 'proxy timeout',
    });

    render(
      <ReposPanel
        repos={[makeRepo({ readiness: 'incomplete' })]}
        defaultAgent="grok"
        availableAgents={['grok']}
        onClose={() => {}}
        onError={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Mark ready' }));
    await user.click(screen.getByRole('button', { name: 'Check WORKFLOW/AGENTS?' }));

    const force = await screen.findByRole('button', { name: '强制标记就绪（跳过检查）' });
    await user.click(force);
    await user.click(screen.getByRole('button', { name: 'Confirm force ready?' }));

    await waitFor(() => {
      expect(editRepo).toHaveBeenCalledWith('app', {
        readiness: 'ready',
        forceReady: true,
      });
    });
  });

  it('renders bounded Guardian remediation from the server receipt', async () => {
    const user = userEvent.setup();
    fetchRepoReadinessCheck.mockResolvedValue({
      key: 'app',
      status: 'done',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      result: guardianFailedCheck,
    });
    render(
      <ReposPanel
        repos={[makeRepo({ readiness: 'ready', executionPolicy: {
          explicit: true, profile: 'guardian', sandbox: 'workspace', network: 'off',
          envAllowlist: [], forbidProductionSecrets: true,
          forbidConnectorCredentials: true, forbidLivePersonalData: true,
          workspaceWrite: true,
        } })]}
        defaultAgent="grok" availableAgents={['grok']}
        onClose={() => {}} onError={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Check readiness' }));
    expect(await screen.findByText(/Rerun readiness verification/)).toBeInTheDocument();
    expect(document.querySelector('[data-evidence=repo-guardian-remediation]')).not.toBeNull();
  });

  it('edit policy selection sends the projected executionPolicy to the server', async () => {
    const user = userEvent.setup();
    render(
      <ReposPanel
        repos={[makeRepo({ readiness: 'incomplete' })]}
        defaultAgent="grok" availableAgents={['grok']}
        onClose={() => {}} onError={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const policy = document.querySelector('[data-evidence=repo-execution-policy-select]');
    expect(policy).toBeInstanceOf(HTMLSelectElement);
    await user.selectOptions(policy as HTMLSelectElement, 'guardian');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(editRepo).toHaveBeenCalledWith('app', expect.objectContaining({
      readiness: 'incomplete',
      executionPolicy: { profile: 'guardian' },
    })));
  });

  it('B1: unmount while Mark ready is running does not PATCH or install orphan polls', async () => {
    const user = userEvent.setup();
    const prevPoll = readinessCheckConfig.pollMs;
    const prevCap = readinessCheckConfig.waitCapMs;
    readinessCheckConfig.pollMs = 50;
    readinessCheckConfig.waitCapMs = 5_000;

    let resolveGet!: (job: unknown) => void;
    const startedAt = new Date().toISOString();
    startRepoReadinessCheck.mockResolvedValue({
      key: 'app',
      status: 'running',
      startedAt,
    });
    fetchRepoReadinessCheck.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGet = resolve;
        }),
    );

    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const { unmount } = render(
      <ReposPanel
        repos={[makeRepo({ readiness: 'incomplete' })]}
        defaultAgent="grok"
        availableAgents={['grok']}
        onClose={() => {}}
        onError={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Mark ready' }));
    await user.click(screen.getByRole('button', { name: 'Check WORKFLOW/AGENTS?' }));

    await waitFor(() => {
      expect(startRepoReadinessCheck).toHaveBeenCalled();
    });

    unmount();
    setIntervalSpy.mockClear();

    resolveGet({
      key: 'app',
      status: 'done',
      startedAt,
      finishedAt: new Date().toISOString(),
      result: okCheck,
    });

    await new Promise((r) => setTimeout(r, 80));
    expect(editRepo).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();

    setIntervalSpy.mockRestore();
    readinessCheckConfig.pollMs = prevPoll;
    readinessCheckConfig.waitCapMs = prevCap;
  });

  it('B2 (discriminating): Mark ready decides from the waiter snapshot — no follow-up GET after the cap', async () => {
    const user = userEvent.setup();
    const prevPoll = readinessCheckConfig.pollMs;
    const prevCap = readinessCheckConfig.waitCapMs;
    readinessCheckConfig.pollMs = 50;
    readinessCheckConfig.waitCapMs = 150;
    const startedAt = new Date().toISOString();
    startRepoReadinessCheck.mockResolvedValue({ key: 'app', status: 'running', startedAt });
    let gets = 0;
    fetchRepoReadinessCheck.mockImplementation(() => {
      gets += 1;
      const job = { key: 'app', status: 'done', startedAt, finishedAt: new Date().toISOString(), result: okCheck };
      // The poll tick and the waiter each answer at once; any later GET (an
      // old-style post-deadline refresh) is slow.
      return gets <= 2
        ? Promise.resolve(job)
        : new Promise((resolve) => setTimeout(() => resolve(job), 400));
    });
    render(
      <ReposPanel
        repos={[makeRepo({ readiness: 'incomplete' })]}
        defaultAgent="grok"
        availableAgents={['grok']}
        onClose={() => {}}
        onError={() => {}}
      />,
    );
    // Discriminating signal, independent of wall-clock load: the PATCH must be
    // issued while only the two instant GETs (poll tick + waiter snapshot) have
    // answered — a decision that waited for the slow post-deadline refresh
    // would see gets >= 3 resolved. (A wall-clock bound flaked under host load.)
    let getsAtPatch = -1;
    editRepo.mockImplementationOnce(() => {
      getsAtPatch = gets;
    });
    await user.click(screen.getByRole('button', { name: 'Mark ready' }));
    await user.click(screen.getByRole('button', { name: 'Check WORKFLOW/AGENTS?' }));
    await waitFor(() => expect(editRepo).toHaveBeenCalledTimes(1), { timeout: 4_000 });
    expect(getsAtPatch).toBeGreaterThanOrEqual(1);
    expect(getsAtPatch).toBeLessThanOrEqual(2);
    expect(editRepo).toHaveBeenCalledWith('app', { readiness: 'ready' });
    await new Promise((r) => setTimeout(r, 500));
    expect(editRepo).toHaveBeenCalledTimes(1);
    readinessCheckConfig.pollMs = prevPoll;
    readinessCheckConfig.waitCapMs = prevCap;
  });

  it('R8c: a superseded POST failure never lets Mark ready consume an older cached ok result', async () => {
    const user = userEvent.setup();
    const prevPoll = readinessCheckConfig.pollMs;
    const prevCap = readinessCheckConfig.waitCapMs;
    readinessCheckConfig.pollMs = 50;
    readinessCheckConfig.waitCapMs = 5_000;

    const oldStartedAt = new Date(Date.now() - 60_000).toISOString();
    const posts: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
    startRepoReadinessCheck.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          posts.push({ resolve, reject });
        }),
    );
    // Server still holds an OLDER completed ok run for this repo.
    fetchRepoReadinessCheck.mockResolvedValue({
      key: 'app',
      status: 'done',
      startedAt: oldStartedAt,
      finishedAt: oldStartedAt,
      result: okCheck,
    });
    const onError = vi.fn();
    render(
      <ReposPanel
        repos={[makeRepo({ readiness: 'incomplete' })]}
        defaultAgent="grok"
        availableAgents={['grok']}
        onClose={() => {}}
        onError={onError}
      />,
    );

    // Mark ready → POST 1 pending.
    await user.click(screen.getByRole('button', { name: 'Mark ready' }));
    await user.click(screen.getByRole('button', { name: 'Check WORKFLOW/AGENTS?' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    // Check readiness → POST 2 pending (newer generation).
    await user.click(screen.getByRole('button', { name: 'Check readiness' }));
    await waitFor(() => expect(posts).toHaveLength(2));

    // The superseded POST fails while the newer one is still pending.
    posts[0]!.reject(new Error('post 1 failed'));
    await new Promise((r) => setTimeout(r, 200));
    expect(editRepo).not.toHaveBeenCalled();

    // Even when the newer POST also fails, nothing is patched and no error leaks from the stale one.
    posts[1]!.reject(new Error('post 2 failed'));
    await new Promise((r) => setTimeout(r, 200));
    expect(editRepo).not.toHaveBeenCalled();
    expect(onError.mock.calls.map((c) => String(c[0]))).not.toContain('post 1 failed');

    readinessCheckConfig.pollMs = prevPoll;
    readinessCheckConfig.waitCapMs = prevCap;
  });

  it('B2: wait cap wins over a stalled GET — force offer, no PATCH on late done/ok', async () => {
    const user = userEvent.setup();
    const prevPoll = readinessCheckConfig.pollMs;
    const prevCap = readinessCheckConfig.waitCapMs;
    readinessCheckConfig.pollMs = 50;
    readinessCheckConfig.waitCapMs = 100;

    const startedAt = new Date().toISOString();
    startRepoReadinessCheck.mockResolvedValue({
      key: 'app',
      status: 'running',
      startedAt,
    });
    fetchRepoReadinessCheck.mockImplementation(
      (_key: string, opts?: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(() => {
            resolve({
              key: 'app',
              status: 'done',
              startedAt,
              finishedAt: new Date().toISOString(),
              result: okCheck,
            });
          }, 250);
          opts?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
        }),
    );

    render(
      <ReposPanel
        repos={[makeRepo({ readiness: 'incomplete' })]}
        defaultAgent="grok"
        availableAgents={['grok']}
        onClose={() => {}}
        onError={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Mark ready' }));
    await user.click(screen.getByRole('button', { name: 'Check WORKFLOW/AGENTS?' }));

    expect(
      await screen.findByRole('button', { name: '强制标记就绪（跳过检查）' }, { timeout: 3_000 }),
    ).toBeInTheDocument();

    await new Promise((r) => setTimeout(r, 300));
    expect(editRepo).not.toHaveBeenCalled();

    readinessCheckConfig.pollMs = prevPoll;
    readinessCheckConfig.waitCapMs = prevCap;
  });

  it('N2: Mark ready attaches to a running Check readiness (one POST, then PATCH)', async () => {
    const user = userEvent.setup();
    const prevPoll = readinessCheckConfig.pollMs;
    const prevCap = readinessCheckConfig.waitCapMs;
    readinessCheckConfig.pollMs = 40;
    readinessCheckConfig.waitCapMs = 5_000;

    const startedAt = new Date().toISOString();
    let polls = 0;
    startRepoReadinessCheck.mockResolvedValue({
      key: 'app',
      status: 'running',
      startedAt,
    });
    fetchRepoReadinessCheck.mockImplementation(async () => {
      polls += 1;
      if (polls < 3) {
        return { key: 'app', status: 'running', startedAt };
      }
      return {
        key: 'app',
        status: 'done',
        startedAt,
        finishedAt: new Date().toISOString(),
        result: okCheck,
      };
    });

    render(
      <ReposPanel
        repos={[makeRepo({ readiness: 'incomplete' })]}
        defaultAgent="grok"
        availableAgents={['grok']}
        onClose={() => {}}
        onError={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Check readiness' }));
    await waitFor(() => {
      expect(startRepoReadinessCheck).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText(/检查中/)).toBeInTheDocument();

    const markReady = screen.getByRole('button', { name: 'Mark ready' });
    expect(markReady).not.toBeDisabled();

    await user.click(markReady);
    await user.click(screen.getByRole('button', { name: 'Check WORKFLOW/AGENTS?' }));

    await waitFor(() => {
      expect(editRepo).toHaveBeenCalledWith('app', { readiness: 'ready' });
    }, { timeout: 5_000 });
    expect(startRepoReadinessCheck).toHaveBeenCalledTimes(1);

    readinessCheckConfig.pollMs = prevPoll;
    readinessCheckConfig.waitCapMs = prevCap;
  });

  it('B2: Mark ready PATCHes from waiter snapshot — no follow-up GET after deadline cleared', async () => {
    const user = userEvent.setup();
    const prevPoll = readinessCheckConfig.pollMs;
    const prevCap = readinessCheckConfig.waitCapMs;
    readinessCheckConfig.pollMs = 50;
    readinessCheckConfig.waitCapMs = 100;

    const startedAt = new Date().toISOString();
    let getCount = 0;
    startRepoReadinessCheck.mockResolvedValue({
      key: 'app',
      status: 'running',
      startedAt,
    });
    // Immediate done/ok for the waiter's in-deadline GET. A post-deadline
    // follow-up refresh would take 250 ms and miss the 100 ms cap.
    fetchRepoReadinessCheck.mockImplementation(
      (_key: string, opts?: { signal?: AbortSignal }) => {
        getCount += 1;
        if (opts?.signal?.aborted) {
          return Promise.reject(new DOMException('Aborted', 'AbortError'));
        }
        return Promise.resolve({
          key: 'app',
          status: 'done',
          startedAt,
          finishedAt: new Date().toISOString(),
          result: okCheck,
        });
      },
    );

    render(
      <ReposPanel
        repos={[makeRepo({ readiness: 'incomplete' })]}
        defaultAgent="grok"
        availableAgents={['grok']}
        onClose={() => {}}
        onError={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Mark ready' }));
    await user.click(screen.getByRole('button', { name: 'Check WORKFLOW/AGENTS?' }));

    await waitFor(() => {
      expect(editRepo).toHaveBeenCalledWith('app', { readiness: 'ready' });
    }, { timeout: 2_000 });

    const getsAtPatch = getCount;
    expect(getsAtPatch).toBeGreaterThanOrEqual(1);

    // Wait longer than the old follow-up-refresh window; no further GETs.
    await new Promise((r) => setTimeout(r, 250));
    expect(getCount).toBe(getsAtPatch);
    expect(editRepo.mock.calls.some((c) => c[1]?.forceReady === true)).toBe(false);

    readinessCheckConfig.pollMs = prevPoll;
    readinessCheckConfig.waitCapMs = prevCap;
  });

  it('B4: Re-probe replaces the old poll interval so the new generation GETs', async () => {
    const user = userEvent.setup();
    const prevPoll = readinessCheckConfig.pollMs;
    const prevCap = readinessCheckConfig.waitCapMs;
    readinessCheckConfig.pollMs = 250;
    readinessCheckConfig.waitCapMs = 5_000;

    let postCount = 0;
    let generation = 0;
    const startedAtByGen: Record<number, string> = {};
    const pollGetsByGen: number[] = [];

    startRepoReadinessCheck.mockImplementation(async () => {
      postCount += 1;
      generation = postCount;
      const startedAt = `start-gen-${generation}`;
      startedAtByGen[generation] = startedAt;
      return { key: 'app', status: 'running' as const, startedAt };
    });

    let gen2Polls = 0;
    fetchRepoReadinessCheck.mockImplementation(
      async (_key: string, opts?: { signal?: AbortSignal }) => {
        const gen = generation;
        const startedAt = startedAtByGen[gen] ?? `start-gen-${gen}`;
        // Waiter GETs pass an AbortSignal; background poll ticks do not.
        const isWaiter = opts?.signal !== undefined;
        if (gen <= 1) {
          if (isWaiter) {
            return {
              key: 'app',
              status: 'done',
              startedAt,
              finishedAt: new Date().toISOString(),
              result: okCheck,
            };
          }
          // Hang the gen1 poll tick so its interval stays registered while
          // Mark ready finishes and Re-probe advances the generation.
          await new Promise((r) => setTimeout(r, 400));
          pollGetsByGen.push(1);
          return {
            key: 'app',
            status: 'done',
            startedAt,
            finishedAt: new Date().toISOString(),
            result: okCheck,
          };
        }
        pollGetsByGen.push(gen);
        gen2Polls += 1;
        if (gen2Polls < 2) {
          return { key: 'app', status: 'running', startedAt };
        }
        return {
          key: 'app',
          status: 'done',
          startedAt,
          finishedAt: new Date().toISOString(),
          result: okCheck,
        };
      },
    );

    const setIntervalSpy = vi.spyOn(window, 'setInterval');

    render(
      <ReposPanel
        repos={[makeRepo({ readiness: 'incomplete' })]}
        defaultAgent="grok"
        availableAgents={['grok']}
        onClose={() => {}}
        onError={() => {}}
      />,
    );

    // Mark ready installs a gen1 background interval; waiter sees done via
    // signaled GET and PATCHes while the poll tick is still in flight.
    await user.click(screen.getByRole('button', { name: 'Mark ready' }));
    await user.click(screen.getByRole('button', { name: 'Check WORKFLOW/AGENTS?' }));

    await waitFor(() => {
      expect(editRepo).toHaveBeenCalledWith('app', { readiness: 'ready' });
    }, { timeout: 2_000 });
    expect(postCount).toBe(1);

    // Hold POST 2 so startReadinessPoll(gen2) runs while gen1's interval remains.
    let resolvePost2!: (v: { key: string; status: 'running'; startedAt: string }) => void;
    startRepoReadinessCheck.mockImplementation(
      () =>
        new Promise((resolve) => {
          postCount += 1;
          generation = postCount;
          resolvePost2 = resolve;
        }),
    );

    await user.click(screen.getByRole('button', { name: 'Re-probe' }));
    await waitFor(() => {
      expect(postCount).toBe(2);
    });

    const startedAt2 = 'start-gen-2';
    startedAtByGen[2] = startedAt2;
    resolvePost2({ key: 'app', status: 'running', startedAt: startedAt2 });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Probing…' })).toBeDisabled();
    });

    // New-generation poll GETs must be issued (old code: zero gen2 GETs, stuck Probing).
    await waitFor(() => {
      expect(pollGetsByGen.some((g) => g === 2)).toBe(true);
    }, { timeout: 2_000 });

    await waitFor(() => {
      expect(screen.getByText(/检查完成/)).toBeInTheDocument();
    }, { timeout: 3_000 });
    expect(screen.queryByRole('button', { name: 'Probing…' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Re-probe' })).not.toBeDisabled();

    // No leaked readiness interval after completion (1s nowMs clock may remain).
    await new Promise((r) => setTimeout(r, 50));
    const readinessIntervalCalls = setIntervalSpy.mock.calls.filter(
      (c) => c[1] === readinessCheckConfig.pollMs,
    );
    expect(readinessIntervalCalls.length).toBeGreaterThanOrEqual(2);

    setIntervalSpy.mockRestore();
    readinessCheckConfig.pollMs = prevPoll;
    readinessCheckConfig.waitCapMs = prevCap;
  });

  it('N3: unmount while Check readiness POST is pending does not onError', async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    let rejectPost!: (err: Error) => void;
    startRepoReadinessCheck.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectPost = reject;
        }),
    );

    const { unmount } = render(
      <ReposPanel
        repos={[makeRepo({ readiness: 'incomplete' })]}
        defaultAgent="grok"
        availableAgents={['grok']}
        onClose={() => {}}
        onError={onError}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Check readiness' }));
    await waitFor(() => {
      expect(startRepoReadinessCheck).toHaveBeenCalled();
    });

    unmount();
    rejectPost(new Error('POST failed after unmount'));

    await new Promise((r) => setTimeout(r, 50));
    expect(onError).not.toHaveBeenCalled();
  });
});
