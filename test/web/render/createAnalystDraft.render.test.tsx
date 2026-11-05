/**
 * Create form analyst draft: heuristic-first generate, live activity panel,
 * auto-apply / dirty apply / fail / job-lost.
 */
import './setup.js';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeRepo } from './fixtures.js';
import type { AcLintReport, DraftJobDto, IntentDraftDto } from '../../../src/web/api.js';

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

const emptyLint: AcLintReport = {
  ok: true,
  findings: [],
  counts: { error: 0, warn: 0, info: 0 },
};
function heuristicDraft(over: Partial<IntentDraftDto> = {}): IntentDraftDto {
  return {
    title: 'Heuristic title',
    body: '## Acceptance criteria\n- [ ] (human) heuristic',
    priority: 3,
    labels: ['needs-plan'],
    vague: false,
    warnings: [],
    lint: emptyLint,
    source: 'heuristic',
    notes: [],
    repairRounds: 0,
    ...over,
  };
}

function analystDraft(over: Partial<IntentDraftDto> = {}): IntentDraftDto {
  return {
    title: 'Analyst drafted',
    body: [
      '## Intent',
      'Show badge',
      '',
      '## Acceptance criteria',
      '- [ ] (mechanical) badge visible @evidence:create-draft-source',
      '- [ ] (human) Phone owner checks the badge',
    ].join('\n'),
    priority: 2,
    labels: ['needs-plan'],
    vague: false,
    warnings: [],
    lint: emptyLint,
    source: 'analyst',
    notes: ['Assumes create form exists', 'question: confirm phone copy?'],
    repairRounds: 0,
    ...over,
  };
}

function draftJob(over: Partial<DraftJobDto> = {}): DraftJobDto {
  return {
    id: 'dj-1',
    repo: 'app',
    intent: 'Show analyst source badge after draft',
    status: 'running',
    phase: 'draft',
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: null,
    activity: [
      {
        at: '2026-01-01T00:00:01Z',
        kind: 'tool',
        text: 'read_file src/x.ts',
      },
    ],
    thinking: 'abc',
    narration: '',
    draft: null,
    error: null,
    ...over,
  };
}

function renderForm(props: {
  drafts?: ReadonlyMap<string, DraftJobDto>;
  onAckDraft?: (id: string) => void;
  onClose?: () => void;
}): ReturnType<typeof render> {
  return render(
    <CreateForm
      repos={[makeRepo()]}
      availableAgents={['grok']}
      defaultAgent="grok"
      preferredAgent="grok"
      initial={{ title: '', repo: 'app', body: '' }}
      drafts={props.drafts ?? new Map()}
      onAckDraft={props.onAckDraft ?? (() => {})}
      onClose={props.onClose ?? (() => {})}
      onCreate={() => {}}
      onCreatePipeline={() => {}}
    />,
  );
}

describe('CreateForm analyst draft badge + notes', () => {
  beforeEach(() => {
    vi.mocked(lintAcceptance).mockReset();
    vi.mocked(draftFromIntent).mockReset();
    vi.mocked(lintAcceptance).mockResolvedValue(emptyLint);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders source badge and notes after a draft', async () => {
    const user = userEvent.setup();
    vi.mocked(draftFromIntent).mockResolvedValue({
      draft: analystDraft(),
      jobId: null,
    });

    renderForm({});

    await user.type(screen.getByLabelText(/Intent/), 'Show analyst source badge after draft');
    await user.click(screen.getByRole('button', { name: /Generate DoD from intent/ }));

    await waitFor(() => {
      expect(draftFromIntent).toHaveBeenCalled();
    });

    const badge = await waitFor(() => {
      const el = document.querySelector('[data-evidence="create-draft-source"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(badge.textContent).toMatch(/analyst/);

    const notes = document.querySelector('[data-evidence="create-analyst-notes"]');
    expect(notes).toBeTruthy();
    expect(notes!.textContent).toMatch(/Assumes create form exists/);
    expect(notes!.textContent).toMatch(/question: confirm phone copy/);

    const plan = screen.getByLabelText(/Save as plan/);
    expect((plan as HTMLInputElement).checked).toBe(true);
  });

  it('shows Generating… while the draft request is in flight and fills from res.draft', async () => {
    const user = userEvent.setup();
    let resolveDraft!: (v: Awaited<ReturnType<typeof draftFromIntent>>) => void;
    vi.mocked(draftFromIntent).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDraft = resolve;
        }),
    );

    renderForm({});

    await user.type(screen.getByLabelText(/Intent/), 'Busy label while analyzing intent');
    await user.click(screen.getByRole('button', { name: /Generate DoD from intent/ }));
    expect(screen.getByRole('button', { name: /Generating/ })).toBeTruthy();

    resolveDraft({
      draft: heuristicDraft({ title: 'Done', body: '## Acceptance criteria\n- [ ] (human) ok' }),
      jobId: 'dj-1',
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Generate DoD from intent/ })).toBeTruthy();
    });
    expect((screen.getByLabelText(/^Title/) as HTMLInputElement).value).toBe('Done');
    expect((screen.getByLabelText(/Description/) as HTMLTextAreaElement).value).toMatch(
      /\(human\) ok/,
    );
    expect(document.querySelector('[data-evidence="create-draft-source"]')!.textContent).toMatch(
      /heuristic/,
    );
  });

  it('shows live activity panel for a running job and auto-applies on ready', async () => {
    const user = userEvent.setup();
    const onAckDraft = vi.fn();
    vi.mocked(draftFromIntent).mockResolvedValue({
      draft: heuristicDraft(),
      jobId: 'dj-1',
    });

    const running = draftJob({ status: 'running', phase: 'draft' });
    const { rerender } = render(
      <CreateForm
        repos={[makeRepo()]}
        availableAgents={['grok']}
        defaultAgent="grok"
        preferredAgent="grok"
        initial={{ title: '', repo: 'app', body: '' }}
        drafts={new Map([['dj-1', running]])}
        onAckDraft={onAckDraft}
        onClose={() => {}}
        onCreate={() => {}}
        onCreatePipeline={() => {}}
      />,
    );

    await user.type(screen.getByLabelText(/Intent/), 'live panel');
    await user.click(screen.getByRole('button', { name: /Generate DoD from intent/ }));

    const panel = await waitFor(() => {
      const el = document.querySelector('[data-evidence="create-analyst-activity"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(panel.getAttribute('data-status')).toBe('running');
    expect(panel.textContent).toMatch(/起草 DoD/);
    expect(panel.textContent).toMatch(/read_file src\/x\.ts/);
    expect(panel.textContent).toMatch(/abc/);

    const readyDraft = analystDraft({
      title: 'Analyst final',
      body: '## Acceptance criteria\n- [ ] (human) analyst final',
      notes: ['from analyst'],
    });
    const ready = draftJob({
      status: 'ready',
      phase: 'done',
      draft: readyDraft,
      thinking: '',
      finishedAt: '2026-01-01T00:01:00Z',
    });

    rerender(
      <CreateForm
        repos={[makeRepo()]}
        availableAgents={['grok']}
        defaultAgent="grok"
        preferredAgent="grok"
        initial={{ title: '', repo: 'app', body: '' }}
        drafts={new Map([['dj-1', ready]])}
        onAckDraft={onAckDraft}
        onClose={() => {}}
        onCreate={() => {}}
        onCreatePipeline={() => {}}
      />,
    );

    await waitFor(() => {
      expect((screen.getByLabelText(/^Title/) as HTMLInputElement).value).toBe('Analyst final');
    });
    expect((screen.getByLabelText(/Description/) as HTMLTextAreaElement).value).toMatch(
      /analyst final/,
    );
    expect(document.querySelector('[data-evidence="create-draft-source"]')!.textContent).toMatch(
      /analyst/,
    );
    expect(onAckDraft).toHaveBeenCalledTimes(1);
    expect(onAckDraft).toHaveBeenCalledWith('dj-1');
    await waitFor(() => {
      expect(document.querySelector('[data-evidence="create-analyst-activity"]')).toBeNull();
    });
  });

  it('activity panel starts collapsed; Expand reveals full tails and more tool rows', async () => {
    const user = userEvent.setup();
    vi.mocked(draftFromIntent).mockResolvedValue({ draft: heuristicDraft(), jobId: 'dj-1' });
    const activity = Array.from({ length: 8 }, (_, i) => ({
      at: `2026-01-01T00:00:0${i}Z`,
      kind: 'tool' as const,
      text: `grep needle-${i}`,
    }));
    const running = draftJob({ activity, thinking: 'long thought tail', narration: 'narrated' });
    renderForm({ drafts: new Map([['dj-1', running]]) });

    await user.type(screen.getByLabelText(/Intent/), 'expand panel');
    await user.click(screen.getByRole('button', { name: /Generate DoD from intent/ }));

    const panel = await waitFor(() => {
      const el = document.querySelector('[data-evidence="create-analyst-activity"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(panel.getAttribute('data-expanded')).toBe('false');
    expect(panel.textContent).toMatch(/needle-7/);
    expect(panel.textContent).not.toMatch(/needle-3/);

    const toggle = screen.getByRole('button', { name: 'Expand' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await user.click(toggle);
    expect(panel.getAttribute('data-expanded')).toBe('true');
    expect(panel.textContent).toMatch(/needle-0/);
    expect(panel.textContent).toMatch(/long thought tail/);
    expect(panel.textContent).toMatch(/narrated/);
    const collapse = screen.getByRole('button', { name: 'Collapse' });
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    await user.click(collapse);
    expect(panel.getAttribute('data-expanded')).toBe('false');
    expect(panel.textContent).not.toMatch(/needle-3/);
  });

  it('keeps dirty title on ready and applies only after Apply click', async () => {
    const user = userEvent.setup();
    const onAckDraft = vi.fn();
    vi.mocked(draftFromIntent).mockResolvedValue({
      draft: heuristicDraft({ title: 'Heuristic title' }),
      jobId: 'dj-1',
    });

    const { rerender } = render(
      <CreateForm
        repos={[makeRepo()]}
        availableAgents={['grok']}
        defaultAgent="grok"
        preferredAgent="grok"
        initial={{ title: '', repo: 'app', body: '' }}
        drafts={new Map([['dj-1', draftJob()]])}
        onAckDraft={onAckDraft}
        onClose={() => {}}
        onCreate={() => {}}
        onCreatePipeline={() => {}}
      />,
    );

    await user.type(screen.getByLabelText(/Intent/), 'dirty path');
    await user.click(screen.getByRole('button', { name: /Generate DoD from intent/ }));
    await waitFor(() => {
      expect((screen.getByLabelText(/^Title/) as HTMLInputElement).value).toBe('Heuristic title');
    });

    const titleInput = screen.getByLabelText(/^Title/) as HTMLInputElement;
    await user.clear(titleInput);
    await user.type(titleInput, 'My edit');

    const ready = draftJob({
      status: 'ready',
      phase: 'done',
      draft: analystDraft({ title: 'Analyst should not overwrite', body: 'analyst body' }),
      finishedAt: '2026-01-01T00:01:00Z',
    });
    rerender(
      <CreateForm
        repos={[makeRepo()]}
        availableAgents={['grok']}
        defaultAgent="grok"
        preferredAgent="grok"
        initial={{ title: '', repo: 'app', body: '' }}
        drafts={new Map([['dj-1', ready]])}
        onAckDraft={onAckDraft}
        onClose={() => {}}
        onCreate={() => {}}
        onCreatePipeline={() => {}}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('[data-evidence="create-draft-apply"]')).toBeTruthy();
    });
    expect((screen.getByLabelText(/^Title/) as HTMLInputElement).value).toBe('My edit');
    expect(onAckDraft).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Apply analyst draft/ }));
    expect((screen.getByLabelText(/^Title/) as HTMLInputElement).value).toBe(
      'Analyst should not overwrite',
    );
    expect(onAckDraft).toHaveBeenCalledWith('dj-1');
  });

  it('on failed status warns and acks', async () => {
    const user = userEvent.setup();
    const onAckDraft = vi.fn();
    vi.mocked(draftFromIntent).mockResolvedValue({
      draft: heuristicDraft(),
      jobId: 'dj-1',
    });

    const { rerender } = render(
      <CreateForm
        repos={[makeRepo()]}
        availableAgents={['grok']}
        defaultAgent="grok"
        preferredAgent="grok"
        initial={{ title: '', repo: 'app', body: '' }}
        drafts={new Map([['dj-1', draftJob()]])}
        onAckDraft={onAckDraft}
        onClose={() => {}}
        onCreate={() => {}}
        onCreatePipeline={() => {}}
      />,
    );

    await user.type(screen.getByLabelText(/Intent/), 'fail path');
    await user.click(screen.getByRole('button', { name: /Generate DoD from intent/ }));
    await waitFor(() => {
      expect(document.querySelector('[data-evidence="create-analyst-activity"]')).toBeTruthy();
    });

    rerender(
      <CreateForm
        repos={[makeRepo()]}
        availableAgents={['grok']}
        defaultAgent="grok"
        preferredAgent="grok"
        initial={{ title: '', repo: 'app', body: '' }}
        drafts={new Map([['dj-1', draftJob({ status: 'failed', error: 'boom', phase: 'draft' })]])}
        onAckDraft={onAckDraft}
        onClose={() => {}}
        onCreate={() => {}}
        onCreatePipeline={() => {}}
      />,
    );

    const warn = await waitFor(() => {
      const el = document.querySelector('[data-evidence="create-intent-warn"]');
      expect(el?.textContent).toMatch(/analyst failed/);
      return el!;
    });
    expect(warn.textContent).toMatch(/boom/);
    expect(onAckDraft).toHaveBeenCalledWith('dj-1');
  });

  it('warns when job never appears after 10s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(draftFromIntent).mockResolvedValue({
      draft: heuristicDraft(),
      jobId: 'dj-missing',
    });

    renderForm({ drafts: new Map() });

    await user.type(screen.getByLabelText(/Intent/), 'lost job');
    await user.click(screen.getByRole('button', { name: /Generate DoD from intent/ }));
    await waitFor(() => {
      expect(document.querySelector('[data-evidence="create-analyst-activity"]')).toBeTruthy();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    const warn = await waitFor(() => {
      const el = document.querySelector('[data-evidence="create-intent-warn"]');
      expect(el?.textContent).toMatch(/analyst job lost/);
      return el!;
    });
    expect(warn.textContent).toMatch(/regenerate/);
    expect(document.querySelector('[data-evidence="create-analyst-activity"]')).toBeNull();
  });
});
