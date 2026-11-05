import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamActivity } from '../../src/adapters/streamActivity.js';

describe('StreamActivity', () => {
  let lines: string[];
  let drafts: (string | null)[];
  let stream: StreamActivity;
  let now: number;
  let timers: { id: number; fn: () => void; at: number }[];
  let nextId: number;

  beforeEach(() => {
    lines = [];
    drafts = [];
    now = 0;
    nextId = 1;
    timers = [];
    stream = new StreamActivity({
      lineMax: 40,
      idleMs: 100,
      onLine: (l) => lines.push(l),
      onDraft: (d) => drafts.push(d),
      clock: () => now,
      schedule: (fn, ms) => {
        const id = nextId++;
        timers.push({ id, fn, at: now + ms });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearSchedule: (id) => {
        timers = timers.filter((t) => t.id !== (id as unknown as number));
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function fireIdle(): void {
    now += 100;
    const due = timers.filter((t) => t.at <= now);
    timers = timers.filter((t) => t.at > now);
    for (const t of due) t.fn();
  }

  it('does not emit a line per character', () => {
    for (const ch of 'The user wants silver light') {
      stream.appendThought(ch);
    }
    expect(lines.length).toBe(0);
    fireIdle();
    expect(lines).toEqual(['think · The user wants silver light']);
  });

  it('flushes on sentence boundary when long enough', () => {
    stream.appendThought('This is a complete sentence that should flush. And more');
    expect(lines.some((l) => l.startsWith('think ·') && l.includes('sentence'))).toBe(true);
  });

  it('dedupes tool completed for the same call id', () => {
    stream.toolStart('read README', 'call-3c2');
    stream.toolStatusUpdate('completed', 'call-3c2');
    stream.toolStatusUpdate('completed', 'call-3c2');
    stream.toolStatusUpdate('completed', 'call-3c2');
    expect(lines.filter((l) => l.startsWith('✓'))).toHaveLength(1);
    expect(lines.some((l) => l.startsWith('→ read README'))).toBe(true);
    expect(lines.some((l) => l.startsWith('✓ read README'))).toBe(true);
  });

  it('ignores in_progress tool spam', () => {
    stream.toolStart('bash', 'c1');
    stream.toolStatusUpdate('in_progress', 'c1');
    stream.toolStatusUpdate('in_progress', 'c1');
    expect(lines.filter((l) => l.includes('in_progress'))).toHaveLength(0);
  });

  it('exposes a live draft while streaming', () => {
    stream.appendAgent('Hi');
    expect(stream.draftLine()).toMatch(/^agent · Hi/);
    fireIdle();
    expect(stream.draftLine()).toBeNull();
    expect(lines).toEqual(['agent · Hi']);
  });
});
