/**
 * Create form local draft autosave: restore chip, discard, clear on create,
 * untouched skip, per-repo isolation.
 */
import './setup.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeRepo } from './fixtures.js';
import { CreateForm } from '../../../src/web/CreateForm.js';
import {
  TASK_DRAFT_KEY,
  listTaskDrafts,
  loadTaskDraft,
  saveTaskDraft,
} from '../../../src/web/taskDraftStore.js';

vi.mock('../../../src/web/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/web/api.js')>();
  return {
    ...actual,
    lintAcceptance: vi.fn().mockResolvedValue({
      ok: true,
      findings: [],
      counts: { error: 0, warn: 0, info: 0 },
    }),
    draftFromIntent: vi.fn(),
  };
});

const repos = [
  makeRepo({ key: 'alpha', effectiveAdapter: 'grok' }),
  makeRepo({ key: 'beta', effectiveAdapter: 'codex', readiness: 'ready' }),
];

function installMemoryStorage(): Storage {
  const map = new Map<string, string>();
  const mem: Storage = {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: mem,
  });
  return mem;
}

function renderForm(
  over: {
    initial?: { title: string; repo: string; body: string };
    onCreate?: ReturnType<typeof vi.fn>;
    onCreatePipeline?: ReturnType<typeof vi.fn>;
    onClose?: ReturnType<typeof vi.fn>;
  } = {},
): ReturnType<typeof render> {
  return render(
    <CreateForm
      repos={repos}
      availableAgents={['grok', 'codex']}
      defaultAgent="grok"
      preferredAgent="grok"
      {...(over.initial ? { initial: over.initial } : {})}
      onClose={over.onClose ?? (() => {})}
      onCreate={over.onCreate ?? (() => {})}
      onCreatePipeline={over.onCreatePipeline ?? (() => {})}
    />,
  );
}

async function waitForDraft(repoKey: string): Promise<void> {
  await waitFor(
    () => {
      expect(loadTaskDraft(repoKey)).toBeTruthy();
    },
    { timeout: 3_000 },
  );
}

describe('createTaskDraftAutosave', () => {
  beforeEach(() => {
    installMemoryStorage();
    vi.useRealTimers();
  });

  afterEach(() => {
    cleanupSafe();
  });

  function cleanupSafe(): void {
    // setup.ts already cleans React trees; ensure storage key is not leaked across files.
    try {
      globalThis.localStorage?.removeItem(TASK_DRAFT_KEY);
    } catch {
      /* ignore */
    }
  }

  it('types intent + title, unmounts, remounts → fields restored + chip shown', async () => {
    const user = userEvent.setup();
    const first = renderForm();
    await user.selectOptions(
      document.querySelector('[data-evidence="create-repo"]') as HTMLSelectElement,
      'alpha',
    );
    await user.type(screen.getByLabelText(/Intent/), '把底栏 Logout 改成 Settings');
    await user.type(screen.getByLabelText('Title'), 'Logout to Settings');
    await waitForDraft('alpha');
    first.unmount();

    renderForm();
    await waitFor(() => {
      expect(document.querySelector('[data-evidence="task-draft-restored"]')).toBeTruthy();
    });
    expect(screen.getByText(/已恢复未提交草稿/)).toBeTruthy();
    expect(
      (document.querySelector('[data-evidence="create-repo"]') as HTMLSelectElement).value,
    ).toBe('alpha');
    expect((screen.getByLabelText(/Intent/) as HTMLTextAreaElement).value).toContain(
      'Logout 改成 Settings',
    );
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Logout to Settings');
  });

  it('discard clears the store and resets the form', async () => {
    const user = userEvent.setup();
    saveTaskDraft(
      'alpha',
      {
        intent: 'saved intent',
        title: 'Saved title',
        slug: undefined,
        body: '',
        adapter: 'grok',
        executionClass: 'implement',
        asPlan: false,
        createMode: 'task',
        stages: [
          { title: 'Implement', body: '', adapter: 'grok' },
          { title: 'Review / polish', body: '', adapter: 'grok' },
        ],
        draftNotes: [],
        draftSource: null,
        jobId: null,
      },
      new Date('2026-09-07T10:00:00.000Z'),
    );

    renderForm();
    await waitFor(() => {
      expect(document.querySelector('[data-evidence="task-draft-restored"]')).toBeTruthy();
    });
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Saved title');

    await user.click(screen.getByRole('button', { name: '丢弃' }));
    expect(document.querySelector('[data-evidence="task-draft-restored"]')).toBeNull();
    expect(loadTaskDraft('alpha')).toBeNull();
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('');
    expect(
      (document.querySelector('[data-evidence="create-repo"]') as HTMLSelectElement).value,
    ).toBe('');
  });

  it('successful create clears the stored draft', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(() => Promise.resolve());
    renderForm({ onCreate });
    await user.selectOptions(
      document.querySelector('[data-evidence="create-repo"]') as HTMLSelectElement,
      'beta',
    );
    await user.type(screen.getByLabelText('Title'), 'Ship draft clear');
    await waitForDraft('beta');
    expect(loadTaskDraft('beta')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(loadTaskDraft('beta')).toBeNull();
    });
  });

  it('untouched form stores nothing', async () => {
    renderForm();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700));
    });
    expect(globalThis.localStorage.getItem(TASK_DRAFT_KEY)).toBeNull();
    expect(listTaskDrafts()).toEqual([]);
  });

  it('switching repo keeps both drafts', async () => {
    const user = userEvent.setup();
    renderForm();
    const sel = document.querySelector('[data-evidence="create-repo"]') as HTMLSelectElement;

    await user.selectOptions(sel, 'alpha');
    await user.type(screen.getByLabelText('Title'), 'Alpha draft title');
    await waitForDraft('alpha');

    await user.selectOptions(sel, 'beta');
    // Clean form for beta (no prior draft).
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('');
    await user.type(screen.getByLabelText('Title'), 'Beta draft title');
    await waitForDraft('beta');

    expect(loadTaskDraft('alpha')?.title).toBe('Alpha draft title');
    expect(loadTaskDraft('beta')?.title).toBe('Beta draft title');

    await user.selectOptions(sel, 'alpha');
    await waitFor(() => {
      expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Alpha draft title');
    });
    expect(document.querySelector('[data-evidence="task-draft-restored"]')).toBeTruthy();
  });
});
