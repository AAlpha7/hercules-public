/**
 * Create form AC lint list: body edit → debounced lint → findings + Create anyway label.
 */
import './setup.js';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeRepo } from './fixtures.js';

vi.mock('../../../src/web/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/web/api.js')>();
  return {
    ...actual,
    lintAcceptance: vi.fn(),
    draftFromIntent: vi.fn(),
  };
});

import { CreateForm } from '../../../src/web/CreateForm.js';
import { draftFromIntent, lintAcceptance } from '../../../src/web/api.js';

const unboundReport = {
  ok: false,
  findings: [
    {
      severity: 'error' as const,
      code: 'unbound-mechanical' as const,
      message:
        'mechanical criterion never passes without a binding — suggest @gate:test',
      line: 2,
      criterion: 'unbound claim',
    },
  ],
  counts: { error: 1, warn: 0, info: 0 },
};

describe('CreateForm AC lint list', () => {
  beforeEach(() => {
    vi.mocked(lintAcceptance).mockReset();
    vi.mocked(draftFromIntent).mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders findings under the body and relabels Create when errors exist', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(lintAcceptance).mockResolvedValue(unboundReport);

    render(
      <CreateForm
        repos={[makeRepo()]}
        availableAgents={['grok']}
        defaultAgent="grok"
        preferredAgent="grok"
        initial={{ title: '', repo: 'app', body: '' }}
        onClose={() => {}}
        onCreate={() => {}}
        onCreatePipeline={() => {}}
      />,
    );

    await user.type(screen.getByLabelText('Title'), 'AC lint path');
    const desc = screen.getByLabelText('Description');
    // fireEvent: userEvent.type treats `[` as a key descriptor.
    fireEvent.change(desc, {
      target: {
        value: [
          '## Acceptance criteria',
          '- [ ] (mechanical) unbound claim',
          '- [ ] (human) look',
        ].join('\n'),
      },
    });

    await vi.advanceTimersByTimeAsync(450);

    await waitFor(() => {
      expect(lintAcceptance).toHaveBeenCalled();
    });

    const list = await waitFor(() => {
      const el = document.querySelector('[data-evidence="create-ac-lint"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(list.textContent).toMatch(/mechanical criterion never passes/);
    expect(list.textContent).toMatch(/✖/);

    expect(
      screen.getByRole('button', { name: /Create anyway \(1 AC errors\)/ }),
    ).toBeTruthy();
    // Errors do not disable Create.
    expect(
      screen.getByRole('button', { name: /Create anyway \(1 AC errors\)/ }),
    ).not.toBeDisabled();
  });

  it('seeds the lint list from draftFromIntent.lint', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(draftFromIntent).mockResolvedValue({
      draft: {
        title: 'Drafted',
        body: '## Definition of Done\n- [ ] (mechanical) x @gate:test\n- [ ] (human) ok',
        priority: 50,
        labels: ['needs-plan'],
        vague: false,
        warnings: [],
        lint: unboundReport,
        source: 'heuristic',
        notes: [],
        repairRounds: 0,
      },
      jobId: null,
    });
    vi.mocked(lintAcceptance).mockResolvedValue({
      ok: true,
      findings: [],
      counts: { error: 0, warn: 0, info: 0 },
    });

    render(
      <CreateForm
        repos={[makeRepo()]}
        availableAgents={['grok']}
        defaultAgent="grok"
        preferredAgent="grok"
        initial={{ title: '', repo: 'app', body: '' }}
        onClose={() => {}}
        onCreate={() => {}}
        onCreatePipeline={() => {}}
      />,
    );

    await user.type(screen.getByLabelText(/Intent/), 'fix the upload bug');
    await user.click(screen.getByRole('button', { name: /Generate DoD from intent/ }));

    await waitFor(() => {
      expect(draftFromIntent).toHaveBeenCalled();
    });

    const list = await waitFor(() => {
      const el = document.querySelector('[data-evidence="create-ac-lint"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(list.textContent).toMatch(/suggest @gate:test/);
  });
});
