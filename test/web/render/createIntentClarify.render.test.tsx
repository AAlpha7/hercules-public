/**
 * C3.35 — vague intent becomes a clarification step (option chips / skip),
 * not the old "Intent looks vague" warning label.
 */
import './setup.js';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeRepo } from './fixtures.js';
import type { AcLintReport, IntentDraftDto } from '../../../src/web/api.js';

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

function draft(over: Partial<IntentDraftDto> = {}): IntentDraftDto {
  return {
    title: 'Heuristic title',
    body: '## Definition of Done\n- [ ] (mechanical) ok @gate:test',
    priority: 3,
    labels: ['needs-plan'],
    vague: false,
    warnings: [],
    questions: [],
    filled: ['已补验收标准：门禁绿 @gate:test'],
    lint: emptyLint,
    source: 'heuristic',
    notes: [],
    repairRounds: 0,
    ...over,
  };
}

function renderForm(): ReturnType<typeof render> {
  return render(
    <CreateForm
      repos={[makeRepo({ key: 'hercules' })]}
      availableAgents={['grok']}
      defaultAgent="grok"
      preferredAgent="grok"
      initial={{ title: '', repo: 'hercules', body: '' }}
      drafts={new Map()}
      onAckDraft={() => {}}
      onClose={() => {}}
      onCreate={() => {}}
      onCreatePipeline={() => {}}
    />,
  );
}

describe('CreateForm intent clarify (C3.35)', () => {
  beforeEach(() => {
    vi.mocked(lintAcceptance).mockReset();
    vi.mocked(draftFromIntent).mockReset();
    vi.mocked(lintAcceptance).mockResolvedValue(emptyLint);
  });

  it('vague intent shows one question with option chips; old vague label never renders', async () => {
    const user = userEvent.setup();
    vi.mocked(draftFromIntent).mockResolvedValue({
      draft: draft({
        vague: true,
        questions: [
          {
            slot: 'where',
            text: '改的是哪个页面／入口？',
            options: ['Tasks', 'Chat', 'Repos', 'Releases', 'Settings'],
          },
        ],
        filled: ['已补验收标准：门禁绿 @gate:test'],
        warnings: ['Intent looks vague — tighten acceptance criteria before dispatch'],
      }),
      jobId: null,
    });

    renderForm();
    await user.type(screen.getByLabelText(/Intent/), '做一下');
    await user.click(screen.getByRole('button', { name: /Generate DoD from intent/ }));

    const clarify = await waitFor(() => {
      const el = document.querySelector('[data-evidence="intent-clarify"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(clarify.textContent).toMatch(/改的是哪个页面/);
    const options = document.querySelectorAll('[data-evidence="intent-clarify-option"]');
    expect(options.length).toBeGreaterThanOrEqual(3);
    expect(options[0]?.textContent).toMatch(/Tasks/);

    const filled = document.querySelector('[data-evidence="intent-filled"]');
    expect(filled?.textContent).toMatch(/已补 1 条验收标准/);

    const badge = document.querySelector('[data-evidence="create-draft-source"]');
    expect(badge?.textContent).toMatch(/已补 1 条 · 1 个问题待答/);

    expect(document.body.textContent).not.toMatch(/Intent looks vague/);
    expect(document.querySelector('[data-evidence="create-intent-warn"]')?.textContent ?? '').not.toMatch(
      /Intent looks vague|vague/,
    );
  });

  it('tapping an option re-drafts with the answer appended to intent', async () => {
    const user = userEvent.setup();
    vi.mocked(draftFromIntent)
      .mockResolvedValueOnce({
        draft: draft({
          vague: true,
          questions: [
            {
              slot: 'where',
              text: '改的是哪个页面／入口？',
              options: ['Tasks', 'Settings'],
            },
          ],
        }),
        jobId: null,
      })
      .mockResolvedValueOnce({
        draft: draft({
          title: 'After answer',
          vague: false,
          questions: [],
          filled: ['已识别位置：Tasks', '已补验收标准：门禁绿 @gate:test'],
        }),
        jobId: null,
      });

    renderForm();
    await user.type(screen.getByLabelText(/Intent/), '做一下');
    await user.click(screen.getByRole('button', { name: /Generate DoD from intent/ }));
    await waitFor(() => {
      expect(document.querySelector('[data-evidence="intent-clarify"]')).toBeTruthy();
    });

    await user.click(screen.getByRole('button', { name: /^Tasks$/ }));

    await waitFor(() => {
      expect(draftFromIntent).toHaveBeenCalledTimes(2);
    });
    const secondCall = vi.mocked(draftFromIntent).mock.calls[1];
    expect(secondCall?.[0]).toMatch(/「where: Tasks」/);
    expect(secondCall?.[1]).toBe('hercules');

    await waitFor(() => {
      expect(document.querySelector('[data-evidence="intent-clarify"]')).toBeNull();
    });
    expect((screen.getByLabelText(/Intent/) as HTMLTextAreaElement).value).toMatch(
      /「where: Tasks」/,
    );
  });

  it('就这样 dismisses questions and records ## Open questions in the body', async () => {
    const user = userEvent.setup();
    vi.mocked(draftFromIntent).mockResolvedValue({
      draft: draft({
        body: '## Definition of Done\n- [ ] (mechanical) ok @gate:test\n',
        vague: true,
        questions: [
          { slot: 'what', text: '具体要改成什么样？' },
          { slot: 'done_when', text: '怎样算做完？' },
        ],
      }),
      jobId: null,
    });

    renderForm();
    await user.type(screen.getByLabelText(/Intent/), '改 Settings');
    await user.click(screen.getByRole('button', { name: /Generate DoD from intent/ }));
    await waitFor(() => {
      expect(document.querySelector('[data-evidence="intent-clarify"]')).toBeTruthy();
    });

    await user.click(screen.getByRole('button', { name: /就这样，直接派发/ }));

    expect(document.querySelector('[data-evidence="intent-clarify"]')).toBeNull();
    const body = (screen.getByLabelText(/Description/) as HTMLTextAreaElement).value;
    expect(body).toMatch(/## Open questions/);
    expect(body).toMatch(/\(what\) 具体要改成什么样？/);
    expect(body).toMatch(/\(done_when\) 怎样算做完？/);
    expect(document.querySelector('[data-evidence="intent-clarify-skip"]')).toBeNull();
  });

  it('complete intent shows no clarify block', async () => {
    const user = userEvent.setup();
    vi.mocked(draftFromIntent).mockResolvedValue({
      draft: draft({
        vague: false,
        questions: [],
        filled: ['已识别位置：Settings', '已补验收标准：门禁绿 @gate:test'],
      }),
      jobId: null,
    });

    renderForm();
    await user.type(
      screen.getByLabelText(/Intent/),
      'Settings 页把语言改成中文，测试通过',
    );
    await user.click(screen.getByRole('button', { name: /Generate DoD from intent/ }));

    await waitFor(() => {
      expect(document.querySelector('[data-evidence="create-draft-source"]')).toBeTruthy();
    });
    expect(document.querySelector('[data-evidence="intent-clarify"]')).toBeNull();
    expect(document.querySelector('[data-evidence="intent-filled"]')?.textContent).toMatch(
      /已补 2 条验收标准/,
    );
    expect(document.querySelector('[data-evidence="create-draft-source"]')?.textContent).toMatch(
      /已补 2 条$/,
    );
    expect(document.body.textContent).not.toMatch(/Intent looks vague/);
  });
});
