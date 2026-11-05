import { describe, it, expect, beforeEach } from 'vitest';
import {
  defaultOpen,
  isRecentSummaryGesture,
  loadSheetHabits,
  rankSections,
  recordSectionEvent,
  resetSheetHabits,
  saveSheetHabits,
  sectionScore,
  SUMMARY_GESTURE_WINDOW_MS,
  type SheetHabits,
} from '../../src/web/sheetHabits.js';

const DAY = 24 * 60 * 60 * 1000;
const STATIC = ['run-timeline', 'packet-details', 'task-body', 'files', 'dependencies'] as const;

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

describe('sheetHabits', () => {
  beforeEach(() => {
    installMemoryStorage();
  });

  it('ranks by decayed score and keeps static order on ties', () => {
    const now = 1_700_000_000_000;
    let habits: SheetHabits = {};
    habits = recordSectionEvent('files', 'open', now - DAY, habits);
    habits = recordSectionEvent('files', 'click', now - DAY, habits);
    habits = recordSectionEvent('task-body', 'open', now, habits);
    habits = recordSectionEvent('task-body', 'open', now, habits);
    habits = recordSectionEvent('task-body', 'click', now, habits);

    const ranked = rankSections([...STATIC], habits, now, STATIC);
    expect(ranked.indexOf('task-body')).toBeLessThan(ranked.indexOf('files'));
    expect(ranked.indexOf('files')).toBeLessThan(ranked.indexOf('packet-details'));
    // Untouched ids keep static relative order among themselves.
    expect(ranked.indexOf('run-timeline')).toBeLessThan(ranked.indexOf('packet-details'));
    expect(ranked.indexOf('packet-details')).toBeLessThan(ranked.indexOf('dependencies'));
  });

  it('applies a 14-day half-life to scores', () => {
    const now = 1_700_000_000_000;
    const fresh: SheetHabits = {
      'task-body': { events: [{ kind: 'open', at: now }] },
    };
    const aged: SheetHabits = {
      'task-body': { events: [{ kind: 'open', at: now - 14 * DAY }] },
    };
    expect(sectionScore(fresh['task-body'], now)).toBeCloseTo(1, 5);
    expect(sectionScore(aged['task-body'], now)).toBeCloseTo(0.5, 5);
  });

  it('defaultOpen uses open-ratio over ≥3 decayed interactions; else static', () => {
    const now = 1_700_000_000_000;
    // Only 2 interactions → static default wins.
    let habits: SheetHabits = {
      'packet-details': {
        events: [
          { kind: 'open', at: now },
          { kind: 'open', at: now },
        ],
      },
    };
    expect(defaultOpen('packet-details', habits, false, now)).toBe(false);

    habits = {
      'packet-details': {
        events: [
          { kind: 'open', at: now },
          { kind: 'open', at: now },
          { kind: 'open', at: now },
        ],
      },
    };
    expect(defaultOpen('packet-details', habits, false, now)).toBe(true);

    // Two closes + one open → ratio 1/3 < 0.5 → closed.
    habits = {
      'packet-details': {
        events: [
          { kind: 'close', at: now },
          { kind: 'close', at: now },
          { kind: 'open', at: now },
        ],
      },
    };
    expect(defaultOpen('packet-details', habits, true, now)).toBe(false);
  });

  it('persists to localStorage and reset clears', () => {
    const now = Date.now();
    recordSectionEvent('chat', 'click', now);
    expect(loadSheetHabits().chat?.events.length).toBe(1);
    resetSheetHabits();
    expect(loadSheetHabits()).toEqual({});
  });

  it('storage-throwing environment falls back to static behaviour', () => {
    const original = globalThis.localStorage;
    const broken = {
      getItem(): string {
        throw new Error('denied');
      },
      setItem(): void {
        throw new Error('denied');
      },
      removeItem(): void {
        throw new Error('denied');
      },
      clear(): void {},
      key(): null {
        return null;
      },
      length: 0,
    };
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: broken,
    });
    try {
      expect(loadSheetHabits()).toEqual({});
      expect(() => saveSheetHabits({ files: { events: [{ kind: 'open', at: 1 }] } })).not.toThrow();
      expect(() => resetSheetHabits()).not.toThrow();
      const ranked = rankSections([...STATIC], {}, 0, STATIC);
      expect(ranked).toEqual([...STATIC]);
      expect(defaultOpen('files', {}, true, 0)).toBe(true);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: original,
      });
    }
  });

  it('ignores unknown section ids', () => {
    const habits = recordSectionEvent('not-a-section', 'open', 1, {});
    expect(habits).toEqual({});
  });

  it('isRecentSummaryGesture accepts only gestures inside the window', () => {
    const now = 1_700_000_000_000;
    expect(isRecentSummaryGesture(undefined, now)).toBe(false);
    expect(isRecentSummaryGesture(now, now)).toBe(true);
    expect(isRecentSummaryGesture(now - SUMMARY_GESTURE_WINDOW_MS, now)).toBe(true);
    expect(isRecentSummaryGesture(now - SUMMARY_GESTURE_WINDOW_MS - 1, now)).toBe(false);
    expect(isRecentSummaryGesture(Infinity, now)).toBe(false);
    expect(isRecentSummaryGesture(now + 1, now)).toBe(false);
    expect(isRecentSummaryGesture(Number.NaN, now)).toBe(false);
  });

  it('N4: recordSectionEvent returns previous habits when setItem throws', () => {
    const original = globalThis.localStorage;
    const broken = {
      getItem(): string | null {
        return null;
      },
      setItem(): void {
        throw new Error('quota');
      },
      removeItem(): void {},
      clear(): void {},
      key(): null {
        return null;
      },
      length: 0,
    };
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: broken,
    });
    try {
      const prev: SheetHabits = {
        files: { events: [{ kind: 'open', at: 1 }] },
      };
      const next = recordSectionEvent('task-body', 'open', 2, prev);
      expect(next).toBe(prev);
      expect(next).toEqual({
        files: { events: [{ kind: 'open', at: 1 }] },
      });
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: original,
      });
    }
  });
});
