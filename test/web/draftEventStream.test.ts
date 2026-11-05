/**
 * SSE draft frames: readEventStream / subscribeState dispatch job + removed,
 * ignore malformed draft payloads without breaking the stream.
 */
/** @vitest-environment jsdom */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import {
  readEventStream,
  subscribeState,
  type DraftJobDto,
  type DraftJobEvent,
  type StateDto,
} from '../../src/web/api.js';

function sseBytes(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i]!));
      i += 1;
    },
  });
}

function minimalState(): StateDto {
  return {
    ready: true,
    running: [],
    stopping: [],
    repos: [],
    problems: [],
    byState: {
      todo: [],
      in_progress: [],
      review: [],
      done: [],
      failed: [],
      cancelled: [],
      retrying: [],
      deleted: [],
    },
    activity: {},
    lastReport: null,
    agents: { default: 'grok', available: ['grok'] },
  };
}

function runningJob(id = 'dj-1'): DraftJobDto {
  return {
    id,
    repo: 'app',
    intent: 'fix logout',
    status: 'running',
    phase: 'draft',
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: null,
    activity: [],
    thinking: '',
    narration: '',
    draft: null,
    error: null,
  };
}

describe('readEventStream draft frames', () => {
  it('dispatches state once, onDraft twice, and ignores a malformed draft frame', async () => {
    const onState = vi.fn();
    const onDraft = vi.fn();
    const job = runningJob();
    const body = sseBytes([
      'event: state\ndata: ' + JSON.stringify(minimalState()) + '\n\n',
      'event: draft\ndata: ' + JSON.stringify({ job }) + '\n\n',
      'event: draft\ndata: {not-json\n\n',
      'event: draft\ndata: ' + JSON.stringify({ removed: 'dj-1' }) + '\n\n',
    ]);

    await expect(readEventStream(body, onState, onDraft)).resolves.toBeUndefined();
    expect(onState).toHaveBeenCalledTimes(1);
    expect(onDraft).toHaveBeenCalledTimes(2);
    expect(onDraft.mock.calls[0]![0]).toEqual({ job });
    expect(onDraft.mock.calls[1]![0]).toEqual({ removed: 'dj-1' });
  });
});

describe('subscribeState draft wiring', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('forwards draft events from a mocked fetch ReadableStream', async () => {
    const { setToken, clearToken } = await import('../../src/web/api.js');
    setToken('test-token');
    const onState = vi.fn();
    const onDraft = vi.fn<(ev: DraftJobEvent) => void>();
    const job = runningJob('dj-sub');
    const body = sseBytes([
      'event: state\ndata: ' + JSON.stringify(minimalState()) + '\n\n',
      'event: draft\ndata: ' + JSON.stringify({ job }) + '\n\n',
      'event: draft\ndata: ' + JSON.stringify({ removed: 'dj-sub' }) + '\n\n',
    ]);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body,
      }),
    );

    const stop = subscribeState(onState, undefined, onDraft);
    try {
      await vi.waitFor(() => {
        expect(onState).toHaveBeenCalledTimes(1);
        expect(onDraft).toHaveBeenCalledTimes(2);
      });
    } finally {
      stop();
      clearToken();
    }
  });
});
