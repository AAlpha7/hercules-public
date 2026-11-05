/**
 * Phone task UI: verifying stage + cancel/force-abort while verifying.
 *
 * Assertions use scoped data-evidence roots so duplicate stage copy in the
 * activity log cannot trip Testing Library's getByText multi-match.
 */
import './setup.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeTask, taskDetailDefaults } from './fixtures.js';
import type { VerificationRunMeta } from '../../../src/web/api.js';

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

function verifyingMeta(over: Partial<VerificationRunMeta> = {}): VerificationRunMeta {
  return {
    taskId: 't-render-1',
    phase: 'l1',
    stage: 'test',
    startedAt: new Date().toISOString(),
    elapsedMs: 45_000,
    processAlive: true,
    cancelRequested: false,
    lastCompletedStage: 'lint',
    ...over,
  };
}

function liveActions(): HTMLElement {
  const root = document.querySelector('[data-evidence="live-quick-actions"]');
  if (!(root instanceof HTMLElement)) {
    throw new Error('expected [data-evidence=live-quick-actions]');
  }
  return root;
}

function stageMeta(): HTMLElement {
  const el = document.querySelector('[data-evidence="verification-stage"]');
  if (!(el instanceof HTMLElement)) {
    throw new Error('expected [data-evidence=verification-stage]');
  }
  return el;
}

function statusPill(): HTMLElement {
  const el = document.querySelector('[data-evidence="live-status-pill"]');
  if (!(el instanceof HTMLElement)) {
    throw new Error('expected [data-evidence=live-status-pill]');
  }
  return el;
}

describe('TaskDetail verifying cancel/force-abort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows verifying stage and Cancel while verification is active', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const task = makeTask({
      id: 't-render-1',
      state: 'in_progress',
      attempts: 1,
      body: '## Goal\nShip it\n',
    });

    render(
      <TaskDetail
        {...taskDetailDefaults(task)}
        verificationRun={verifyingMeta({ stage: 'held-out-smoke' })}
        onAction={onAction}
      />,
    );

    const stage = stageMeta();
    expect(stage.textContent).toMatch(/verifying:\s*held-out-smoke/i);
    expect(stage.textContent).toMatch(/last lint/i);
    expect(statusPill().textContent).toMatch(/VERIFYING/i);

    const actions = within(liveActions());
    const cancel =
      actions.queryByRole('button', { name: 'Cancel' }) ??
      (document.querySelector('[data-evidence="verify-cancel"]') as HTMLElement | null);
    expect(cancel).toBeTruthy();
    await user.click(cancel!);
    const confirm = await actions.findByRole('button', { name: /Confirm cancel/i });
    await user.click(confirm);
    expect(onAction).toHaveBeenCalledWith('cancel');
  });

  it('shows Force abort when verification cancel is already requested', async () => {
    const user = userEvent.setup();
    const onForceAbort = vi.fn();
    const task = makeTask({
      id: 't-render-1',
      state: 'in_progress',
      attempts: 1,
      body: '## Goal\nShip it\n',
    });

    render(
      <TaskDetail
        {...taskDetailDefaults(task)}
        verificationRun={verifyingMeta({
          stage: 'build',
          cancelRequested: true,
          processAlive: false,
        })}
        onForceAbort={onForceAbort}
      />,
    );

    expect(statusPill().textContent).toMatch(/STOPPING VERIFY/i);
    expect(stageMeta().textContent).toMatch(/cancel requested/i);

    const actions = within(liveActions());
    const forceBtn = document.querySelector('[data-evidence="verify-force-abort"]');
    expect(forceBtn).toBeTruthy();
    expect(forceBtn).toHaveTextContent('Force abort');
    await user.click(forceBtn!);
    const confirm = await actions.findByRole('button', { name: /Confirm force-abort/i });
    await user.click(confirm);
    expect(onForceAbort).toHaveBeenCalledTimes(1);
  });

  it('keeps Force abort when disk is cancelled but verification is still aborting', async () => {
    const onForceAbort = vi.fn();
    const task = makeTask({
      id: 't-render-1',
      state: 'cancelled',
      attempts: 1,
      body: '## Goal\nShip it\n',
    });

    render(
      <TaskDetail
        {...taskDetailDefaults(task)}
        verificationRun={verifyingMeta({
          stage: 'test',
          cancelRequested: true,
          processAlive: true,
        })}
        onForceAbort={onForceAbort}
      />,
    );

    expect(stageMeta().textContent).toMatch(/verifying:\s*test/i);
    const forceBtn = document.querySelector('[data-evidence="verify-force-abort"]');
    expect(forceBtn).toBeTruthy();
    expect(forceBtn).toHaveTextContent('Force abort');
    // Scoped to live panel — not a second control in the sheet footer.
    expect(liveActions().contains(forceBtn)).toBe(true);
    expect(document.querySelectorAll('[data-evidence="verify-force-abort"]')).toHaveLength(1);
  });
});
