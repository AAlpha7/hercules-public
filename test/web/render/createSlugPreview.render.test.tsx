/**
 * Create form slug preview: seed draft shows id preview and submit forwards slug.
 */
import './setup.js';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeRepo } from './fixtures.js';
import type { AcLintReport, IntentDraftDto } from '../../../src/web/api.js';
import { CreateForm } from '../../../src/web/CreateForm.js';

const emptyLint: AcLintReport = {
  ok: true,
  findings: [],
  counts: { error: 0, warn: 0, info: 0 },
};

function seedDraft(over: Partial<IntentDraftDto> = {}): IntentDraftDto {
  return {
    title: 'Sort tasks by last active',
    slug: 'sort-tasks',
    body: '## Acceptance criteria\n- [ ] (human) ok',
    priority: 2,
    labels: ['needs-plan'],
    vague: false,
    warnings: [],
    lint: emptyLint,
    source: 'analyst',
    notes: [],
    repairRounds: 0,
    ...over,
  };
}

describe('CreateForm slug preview', () => {
  it('renders create-slug-preview from seed draft and submits slug', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();

    render(
      <CreateForm
        repos={[makeRepo()]}
        availableAgents={['grok']}
        defaultAgent="grok"
        preferredAgent="grok"
        initial={{
          title: '',
          repo: 'app',
          body: '',
          draft: seedDraft({ slug: 'sort-tasks' }),
        }}
        onClose={() => {}}
        onCreate={onCreate}
        onCreatePipeline={() => {}}
      />,
    );

    const preview = document.querySelector('[data-evidence="create-slug-preview"]');
    expect(preview).toBeTruthy();
    expect(preview!.textContent).toContain('sort-tasks');
    expect(preview!.textContent).toMatch(/id:\s*<n>-sort-tasks/);

    await user.click(screen.getByRole('button', { name: /Create plan/ }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0]![0]).toMatchObject({ slug: 'sort-tasks' });
  });
});
