import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createDraftJobs,
  type DraftJobEvent,
  type DraftJobDto,
} from '../../src/server/draftJobs.js';
import type { AnalystDraft } from '../../src/orchestrator/analyst.js';
import type { AnalystActivityListener } from '../../src/domain/analystActivity.js';

const sampleDraft = (title = 'Done'): AnalystDraft => ({
  title,
  body: '## Acceptance criteria\n- [ ] (mechanical) x @gate:test\n- [ ] (human) ok',
  priority: 2,
  labels: ['needs-plan'],
  vague: false,
  warnings: [],
  questions: [],
  filled: ['已补验收标准：门禁绿 @gate:test'],
  source: 'analyst',
  lint: { ok: true, findings: [], counts: { error: 0, warn: 0, info: 0 } },
  notes: ['n'],
  repairRounds: 0,
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createDraftJobs', () => {
  let clock = 1_000_000;

  beforeEach(() => {
    clock = 1_000_000;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const now = (): number => clock;

  it('start returns running job with phase context; resolution flips to ready', async () => {
    const jobs = createDraftJobs({ now });
    const events: DraftJobEvent[] = [];
    jobs.subscribe((ev) => events.push(ev));
    const d = deferred<AnalystDraft>();
    const started = jobs.start({
      repo: 'app',
      intent: 'fix the drain',
      run: () => d.promise,
    });
    expect(started).not.toBeNull();
    expect(started!.status).toBe('running');
    expect(started!.phase).toBe('context');
    expect(started!.id).toMatch(/^dj-[0-9a-f]{12}$/);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'job', job: { status: 'running', phase: 'context' } });

    d.resolve(sampleDraft());
    await flushMicrotasks();
    const ready = jobs.get(started!.id)!;
    expect(ready.status).toBe('ready');
    expect(ready.phase).toBe('done');
    expect(ready.finishedAt).not.toBeNull();
    expect(ready.draft?.title).toBe('Done');
    expect(events.at(-1)).toMatchObject({
      kind: 'job',
      job: { status: 'ready', phase: 'done' },
    });
  });

  it('rejection → failed with message only; sync throw behaves the same', async () => {
    const jobs = createDraftJobs({ now });
    const d = deferred<AnalystDraft>();
    const a = jobs.start({
      repo: 'app',
      intent: 'x',
      run: () => d.promise,
    })!;
    d.reject(new Error('boom\n    at Object.<anonymous>'));
    await flushMicrotasks();
    const failed = jobs.get(a.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('boom\n    at Object.<anonymous>');
    expect(failed.error).not.toMatch(/stack/i);
    expect(failed.phase).toBe('done');
    expect(failed.finishedAt).not.toBeNull();

    const jobs2 = createDraftJobs({ now });
    const sync = jobs2.start({
      repo: 'app',
      intent: 'y',
      run: () => {
        throw new Error('sync fail');
      },
    })!;
    expect(sync.status).toBe('failed');
    expect(sync.error).toBe('sync fail');
    expect(sync.phase).toBe('done');
  });

  it('phase/tool update immediately; activity capped at 40', () => {
    const jobs = createDraftJobs({ now });
    const events: DraftJobEvent[] = [];
    jobs.subscribe((ev) => events.push(ev));
    let onActivity!: AnalystActivityListener;
    const d = deferred<AnalystDraft>();
    const job = jobs.start({
      repo: 'app',
      intent: 'x',
      run: (listener) => {
        onActivity = listener;
        return d.promise;
      },
    })!;
    events.length = 0;

    onActivity({ kind: 'phase', phase: 'draft' });
    expect(jobs.get(job.id)!.phase).toBe('draft');
    expect(jobs.get(job.id)!.activity).toEqual([
      expect.objectContaining({ kind: 'phase', text: 'draft' }),
    ]);
    expect(events).toHaveLength(1);

    for (let i = 0; i < 50; i++) {
      onActivity({ kind: 'tool', tool: 'read', target: `f${i}` });
    }
    const activity = jobs.get(job.id)!.activity;
    expect(activity).toHaveLength(40);
    expect(activity[0]!.text).toBe('read f10'); // first phase dropped; tools f0..f9 dropped
    expect(activity[39]!.text).toBe('read f49');
    // phase + 50 tools = 51 immediate emits
    expect(events.length).toBe(1 + 50);
  });

  it('text deltas within throttle window produce ≤2 job emissions; tails capped', () => {
    const jobs = createDraftJobs({ now, throttleMs: 250 });
    const events: DraftJobEvent[] = [];
    jobs.subscribe((ev) => events.push(ev));
    let onActivity!: AnalystActivityListener;
    const d = deferred<AnalystDraft>();
    jobs.start({
      repo: 'app',
      intent: 'x',
      run: (listener) => {
        onActivity = listener;
        return d.promise;
      },
    });
    expect(events).toHaveLength(1); // initial

    for (let i = 0; i < 10; i++) {
      onActivity({ kind: 'text', delta: `chunk${i}-` });
    }
    // No emit yet — trailing timer pending
    expect(events).toHaveLength(1);

    vi.advanceTimersByTime(250);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ kind: 'job' });

    const longText = 'N'.repeat(500);
    onActivity({ kind: 'text', delta: longText });
    const longThought = 'T'.repeat(300);
    onActivity({ kind: 'thought', delta: longThought });
    vi.advanceTimersByTime(250);
    const snap = (events.at(-1) as { kind: 'job'; job: DraftJobDto }).job;
    expect(snap.narration).toBe('N'.repeat(400));
    expect(snap.thinking).toBe('T'.repeat(240));
  });

  it('maxRunning:1 blocks second start until first resolves', async () => {
    const jobs = createDraftJobs({ now, maxRunning: 1 });
    const d1 = deferred<AnalystDraft>();
    const first = jobs.start({
      repo: 'app',
      intent: 'one',
      run: () => d1.promise,
    });
    expect(first).not.toBeNull();
    expect(
      jobs.start({
        repo: 'app',
        intent: 'two',
        run: async () => sampleDraft(),
      }),
    ).toBeNull();

    d1.resolve(sampleDraft());
    await flushMicrotasks();
    expect(jobs.get(first!.id)?.status).toBe('ready');
    const second = jobs.start({
      repo: 'app',
      intent: 'two',
      run: async () => sampleDraft('Two'),
    });
    expect(second).not.toBeNull();
    expect(second!.intent).toBe('two');
  });

  it('ttl sweep removes old finished job; maxJobs evicts oldest finished', async () => {
    const jobs = createDraftJobs({ now, ttlMs: 1_000, maxJobs: 2, maxRunning: 2 });
    const removed: string[] = [];
    jobs.subscribe((ev) => {
      if (ev.kind === 'removed') removed.push(ev.id);
    });

    const d1 = deferred<AnalystDraft>();
    const a = jobs.start({
      repo: 'app',
      intent: 'a',
      run: () => d1.promise,
    })!;
    d1.resolve(sampleDraft('A'));
    await flushMicrotasks();
    expect(jobs.get(a.id)?.status).toBe('ready');

    clock += 2_000; // past ttl
    const d2 = deferred<AnalystDraft>();
    const b = jobs.start({
      repo: 'app',
      intent: 'b',
      run: () => d2.promise,
    })!;
    expect(removed).toContain(a.id);
    expect(jobs.get(a.id)).toBeNull();
    expect(b.id).not.toBe(a.id);

    d2.resolve(sampleDraft('B'));
    await flushMicrotasks();
    expect(jobs.get(b.id)?.status).toBe('ready');

    // Fill with another finished, then start another to force maxJobs eviction
    const d3 = deferred<AnalystDraft>();
    const c = jobs.start({
      repo: 'app',
      intent: 'c',
      run: () => d3.promise,
    })!;
    d3.resolve(sampleDraft('C'));
    await flushMicrotasks();
    expect(jobs.get(c.id)?.status).toBe('ready');
    // maxJobs=2: b and c retained; starting d should drop oldest finished (b)
    removed.length = 0;
    const d4 = deferred<AnalystDraft>();
    const dJob = jobs.start({
      repo: 'app',
      intent: 'd',
      run: () => d4.promise,
    })!;
    expect(removed).toContain(b.id);
    expect(jobs.get(b.id)).toBeNull();
    expect(jobs.list().map((j) => j.id).sort()).toEqual([c.id, dJob.id].sort());
    d4.resolve(sampleDraft('D'));
  });

  it('ack removes and emits removed; unknown false; post-terminal events ignored', async () => {
    const jobs = createDraftJobs({ now });
    const events: DraftJobEvent[] = [];
    jobs.subscribe((ev) => events.push(ev));
    let onActivity!: AnalystActivityListener;
    const d = deferred<AnalystDraft>();
    const job = jobs.start({
      repo: 'app',
      intent: 'x',
      run: (listener) => {
        onActivity = listener;
        return d.promise;
      },
    })!;
    expect(jobs.ack('nope')).toBe(false);
    expect(jobs.ack(job.id)).toBe(true);
    expect(events.at(-1)).toEqual({ kind: 'removed', id: job.id });
    expect(jobs.get(job.id)).toBeNull();

    // Activity after ack is ignored (job gone)
    onActivity({ kind: 'phase', phase: 'draft' });
    expect(events.filter((e) => e.kind === 'job' && e.job.phase === 'draft')).toHaveLength(0);

    // Terminal then late activity ignored
    const d2 = deferred<AnalystDraft>();
    let on2!: AnalystActivityListener;
    const job2 = jobs.start({
      repo: 'app',
      intent: 'y',
      run: (listener) => {
        on2 = listener;
        return d2.promise;
      },
    })!;
    d2.resolve(sampleDraft());
    await flushMicrotasks();
    expect(jobs.get(job2.id)?.status).toBe('ready');
    const before = events.length;
    on2({ kind: 'tool', tool: 'read', target: 'late' });
    expect(events.length).toBe(before);
    expect(jobs.get(job2.id)!.activity).toHaveLength(0);
  });

  it('get returns a copy — mutating activity does not affect next get', () => {
    const jobs = createDraftJobs({ now });
    let onActivity!: AnalystActivityListener;
    const d = deferred<AnalystDraft>();
    const job = jobs.start({
      repo: 'app',
      intent: 'x',
      run: (listener) => {
        onActivity = listener;
        return d.promise;
      },
    })!;
    onActivity({ kind: 'phase', phase: 'draft' });
    const a = jobs.get(job.id)!;
    (a.activity as unknown as { pop(): unknown }).pop();
    const b = jobs.get(job.id)!;
    expect(b.activity).toHaveLength(1);
  });

  it('throwing subscriber does not break emission to others', () => {
    const jobs = createDraftJobs({ now });
    const good: DraftJobEvent[] = [];
    jobs.subscribe(() => {
      throw new Error('listener boom');
    });
    jobs.subscribe((ev) => good.push(ev));
    const d = deferred<AnalystDraft>();
    expect(() =>
      jobs.start({
        repo: 'app',
        intent: 'x',
        run: () => d.promise,
      }),
    ).not.toThrow();
    expect(good).toHaveLength(1);
    expect(good[0]!.kind).toBe('job');
  });
});
