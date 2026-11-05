/**
 * App: background draft ready while CreateForm closed → toast + inbox row;
 * tapping the row opens CreateForm with the draft and acks the job.
 */
import './setup.js';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  DraftJobDto,
  DraftJobEvent,
  IntentDraftDto,
  StateDto,
  Task,
  TaskState,
} from '../../../src/web/api.js';
import { makeRepo } from './fixtures.js';

const {
  fetchState,
  fetchReleases,
  fetchVoiceStatus,
  fetchReviewExperienceCapabilities,
  subscribeState,
  ackDraftJob,
} = vi.hoisted(() => ({
  fetchState: vi.fn(),
  fetchReleases: vi.fn(),
  fetchVoiceStatus: vi.fn(),
  fetchReviewExperienceCapabilities: vi.fn(),
  subscribeState: vi.fn(),
  ackDraftJob: vi.fn(),
}));

let onDraftHandler: ((ev: DraftJobEvent) => void) | undefined;

vi.mock('../../../src/web/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/web/api.js')>();
  return {
    ...actual,
    getToken: () => 'test-token',
    fetchState: (...args: unknown[]) => fetchState(...args),
    fetchReleases: (...args: unknown[]) => fetchReleases(...args),
    fetchVoiceStatus: (...args: unknown[]) => fetchVoiceStatus(...args),
    fetchReviewExperienceCapabilities: (...args: unknown[]) =>
      fetchReviewExperienceCapabilities(...args),
    subscribeState: (
      onState: (s: StateDto) => void,
      _onUnauthorized?: () => void,
      onDraft?: (ev: DraftJobEvent) => void,
    ) => {
      onDraftHandler = onDraft;
      subscribeState(onState, _onUnauthorized, onDraft);
      return () => {
        onDraftHandler = undefined;
      };
    },
    ackDraftJob: (...args: unknown[]) => ackDraftJob(...args),
  };
});

vi.mock('../../../src/web/VoiceControl.js', () => ({
  VoiceControl: () => null,
}));

import { App } from '../../../src/web/App.js';

function emptyByState(): Record<TaskState, Task[]> {
  return {
    todo: [],
    in_progress: [],
    review: [],
    done: [],
    cancelled: [],
    retrying: [],
    failed: [],
    deleted: [],
  };
}

function readyState(): StateDto {
  return {
    ready: true,
    running: [],
    stopping: [],
    repos: [makeRepo()],
    problems: [],
    byState: emptyByState(),
    activity: {},
    lastReport: null,
    agents: { default: 'grok', available: ['grok'] },
  };
}

function analystDraft(): IntentDraftDto {
  return {
    title: 'Inbox draft title',
    body: '## Acceptance criteria\n- [ ] (human) from inbox',
    priority: 2,
    labels: ['needs-plan'],
    vague: false,
    warnings: [],
    lint: { ok: true, findings: [], counts: { error: 0, warn: 0, info: 0 } },
    source: 'analyst',
    notes: [],
    repairRounds: 0,
  };
}

function job(over: Partial<DraftJobDto> = {}): DraftJobDto {
  return {
    id: 'dj-inbox',
    repo: 'app',
    intent: 'open draft from decision inbox after analyst finishes',
    status: 'running',
    phase: 'draft',
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: null,
    activity: [],
    thinking: '',
    narration: '',
    draft: null,
    error: null,
    ...over,
  };
}

describe('App draft job toast + inbox', () => {
  beforeEach(() => {
    fetchState.mockReset();
    fetchReleases.mockReset();
    fetchVoiceStatus.mockReset();
    fetchReviewExperienceCapabilities.mockReset();
    subscribeState.mockReset();
    ackDraftJob.mockReset();
    onDraftHandler = undefined;

    fetchState.mockResolvedValue(readyState());
    fetchReleases.mockResolvedValue([]);
    fetchVoiceStatus.mockResolvedValue({ configured: false });
    fetchReviewExperienceCapabilities.mockRejectedValue(new Error('unavailable'));
    ackDraftJob.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    onDraftHandler = undefined;
  });

  it('running→ready while form closed shows toast + inbox-draft; tap opens form and acks', async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => {
      expect(fetchState).toHaveBeenCalled();
      expect(onDraftHandler).toBeTypeOf('function');
    });

    act(() => {
      onDraftHandler!({ job: job({ status: 'running' }) });
    });
    act(() => {
      onDraftHandler!({
        job: job({
          status: 'ready',
          phase: 'done',
          draft: analystDraft(),
          finishedAt: '2026-01-01T00:01:00Z',
        }),
      });
    });

    const notice = await waitFor(() => {
      const el = document.querySelector('[data-evidence="operator-notice"]');
      expect(el?.textContent).toMatch(/Draft ready/);
      return el!;
    });
    expect(notice.textContent).toMatch(/Draft ready/);

    const row = await waitFor(() => {
      const el = document.querySelector('.inbox-draft');
      expect(el).toBeTruthy();
      return el as HTMLButtonElement;
    });
    expect(row.textContent).toMatch(/Draft ready/);

    await user.click(row);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /New task/ })).toBeTruthy();
    });
    expect((screen.getByLabelText(/^Title/) as HTMLInputElement).value).toBe('Inbox draft title');
    expect(ackDraftJob).toHaveBeenCalledWith('dj-inbox');
  });
});
