/**
 * After-deploy human ACs: muted list (no checkbox), Approve not blocked;
 * plain (human) still gates Approve. No nag hints when auto-green.
 */
import './setup.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeTask, taskDetailDefaults } from './fixtures.js';

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

function greenBodyWithAfterDeploy(): string {
  return `## Goal
Ship the change.

## Definition of Done
- [ ] (mechanical) tests pass @gate:test
- [ ] (human, after deploy) Confirm live badge on production

## Review packet
**✅ automated proof complete** (human Approve still required if human ACs exist)

**Definition of Done**
| Axis | Status |
|---|---|
| mechanical (L1) | ✅ pass |
`;
}

function greenBodyWithPlainHuman(humanText = 'Spot-check on device'): string {
  return `## Goal
Ship the change.

## Definition of Done
- [ ] (mechanical) tests pass @gate:test
- [ ] (human) ${humanText}

## Review packet
**✅ automated proof complete** (human Approve still required if human ACs exist)

**Definition of Done**
| Axis | Status |
|---|---|
| mechanical (L1) | ✅ pass |
`;
}

describe('TaskDetail after-deploy human ACs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders after-deploy list without checkbox; Approve enabled; no nag hints', () => {
    const task = makeTask({ body: greenBodyWithAfterDeploy() });
    render(<TaskDetail {...taskDetailDefaults(task)} />);

    const el = document.querySelector('[data-evidence="human-ac-after-deploy"]');
    expect(el).not.toBeNull();
    expect(el!.textContent).toMatch(/Confirm live badge on production/);
    expect(el!.querySelector('input[type="checkbox"]')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();

    const approve = document.querySelector(
      '[data-evidence="review-primary-action"]',
    ) as HTMLButtonElement;
    expect(approve).toBeTruthy();
    expect(approve).toBeEnabled();
    expect(approve.textContent).toMatch(/批准/);

    expect(screen.queryByText(/System proof green/i)).toBeNull();
    expect(screen.queryByText(/typed DoD recommended/i)).toBeNull();
  });

  it('plain (human) still shows checkbox and blocks Approve until ticked', async () => {
    const user = userEvent.setup();
    const human = 'Spot-check on device';
    const task = makeTask({ body: greenBodyWithPlainHuman(human) });
    render(<TaskDetail {...taskDetailDefaults(task)} />);

    expect(document.querySelector('[data-evidence="human-ac-after-deploy"]')).toBeNull();
    const approve = document.querySelector(
      '[data-evidence="review-primary-action"]',
    ) as HTMLButtonElement;
    expect(approve).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: human }));
    expect(approve).toBeEnabled();
  });
});
