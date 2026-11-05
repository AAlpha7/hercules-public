/**
 * New task / pipeline: Repo select comes before Intent/Title; blank open does
 * not preselect repos[0]; Generate DoD stays disabled until a repo is chosen.
 */
import './setup.js';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
import { draftFromIntent, lintAcceptance, type AcLintReport } from '../../../src/web/api.js';

const emptyLint: AcLintReport = {
  ok: true,
  findings: [],
  counts: { error: 0, warn: 0, info: 0 },
};

const repos = [
  makeRepo({ key: 'alpha', effectiveAdapter: 'grok' }),
  makeRepo({ key: 'beta', effectiveAdapter: 'codex', readiness: 'ready' }),
];

function renderBlank(
  over: {
    initial?: { title: string; repo: string; body: string };
    onCreate?: ReturnType<typeof vi.fn>;
    onCreatePipeline?: ReturnType<typeof vi.fn>;
  } = {},
): ReturnType<typeof render> {
  return render(
    <CreateForm
      repos={repos}
      availableAgents={['grok', 'codex']}
      defaultAgent="grok"
      preferredAgent="grok"
      {...(over.initial ? { initial: over.initial } : {})}
      onClose={() => {}}
      onCreate={over.onCreate ?? (() => {})}
      onCreatePipeline={over.onCreatePipeline ?? (() => {})}
    />,
  );
}

function repoSelect(): HTMLSelectElement {
  const el = document.querySelector('[data-evidence="create-repo"]');
  expect(el).toBeTruthy();
  return el as HTMLSelectElement;
}

function fieldOrderIndex(node: Element): number {
  const sheet = document.querySelector('.sheet');
  expect(sheet).toBeTruthy();
  const kids = Array.from(sheet!.children);
  const host = node.closest('label') ?? node;
  return kids.indexOf(host as Element);
}

describe('createRepoFirst', () => {
  it('CreateForm places Repo select before Intent and Title', async () => {
    const user = userEvent.setup();
    renderBlank();
    const repo = repoSelect();
    const intent = screen.getByLabelText(/Intent/);
    const title = screen.getByLabelText('Title');
    expect(fieldOrderIndex(repo)).toBeLessThan(fieldOrderIndex(intent));
    expect(fieldOrderIndex(repo)).toBeLessThan(fieldOrderIndex(title));

    await user.click(screen.getByRole('radio', { name: /Pipeline/ }));
    const name = screen.getByLabelText('Pipeline name');
    expect(fieldOrderIndex(repo)).toBeLessThan(fieldOrderIndex(name));
  });

  it('blank CreateForm starts with empty repo until the user picks one', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const onCreatePipeline = vi.fn();
    const first = renderBlank({ onCreate });

    const sel = repoSelect();
    expect(sel.value).toBe('');
    expect(sel.value).not.toBe('alpha');

    await user.type(screen.getByLabelText('Title'), 'Ship it');
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    expect(onCreate).not.toHaveBeenCalled();

    await user.selectOptions(sel, 'beta');
    expect(sel.value).toBe('beta');
    expect(screen.getByRole('button', { name: 'Create' })).not.toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({ title: 'Ship it', repo: 'beta' });

    first.unmount();
    renderBlank({ onCreatePipeline });
    await user.click(screen.getByRole('radio', { name: /Pipeline/ }));
    await user.type(screen.getByLabelText('Pipeline name'), 'act1');
    expect(screen.getByRole('button', { name: /Create 2 tasks/ })).toBeDisabled();
    await user.selectOptions(repoSelect(), 'beta');
    expect(screen.getByRole('button', { name: /Create 2 tasks/ })).not.toBeDisabled();
  });

  it('Generate DoD from intent uses the selected repo and stays disabled until one is chosen', async () => {
    vi.mocked(lintAcceptance).mockReset();
    vi.mocked(draftFromIntent).mockReset();
    vi.mocked(lintAcceptance).mockResolvedValue(emptyLint);
    vi.mocked(draftFromIntent).mockResolvedValue({
      draft: {
        title: 'Drafted',
        body: ['## Acceptance criteria', '- [ ] (human) ok'].join(String.fromCharCode(10)),
        priority: 3,
        labels: ['needs-plan'],
        vague: false,
        warnings: [],
        lint: emptyLint,
        source: 'heuristic',
        notes: [],
        repairRounds: 0,
      },
      jobId: null,
    });

    const user = userEvent.setup();
    renderBlank();

    await user.type(screen.getByLabelText(/Intent/), 'fix the upload bug');
    const generate = screen.getByRole('button', { name: /Generate DoD from intent/ });
    expect(generate).toBeDisabled();
    expect(draftFromIntent).not.toHaveBeenCalled();

    await user.selectOptions(repoSelect(), 'beta');
    expect(generate).not.toBeDisabled();
    await user.click(generate);

    await waitFor(() => {
      expect(draftFromIntent).toHaveBeenCalledWith('fix the upload bug', 'beta');
    });
    expect(draftFromIntent).not.toHaveBeenCalledWith(expect.anything(), 'hercules');
    expect(draftFromIntent).not.toHaveBeenCalledWith(expect.anything(), 'alpha');
  });

  it('CreateForm keeps initial.repo from prefill', () => {
    renderBlank({
      initial: { title: 'From clone', repo: 'beta', body: 'body' },
    });
    expect(repoSelect().value).toBe('beta');
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('From clone');
  });
});
