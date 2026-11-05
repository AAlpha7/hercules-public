/**
 * Habit-adaptive task-sheet section order + default-open.
 *
 * Persistence: localStorage key `hercules_sheet_habits_v1`. Every read/write
 * is try/catch; missing/throwing storage falls back to static behaviour.
 *
 * Score = Σ events × exponential decay (14-day half-life). Opens and clicks
 * count positive; closes count negative only for the default-open decision.
 * Order = descending score, ties keep static order. Default open = open-ratio
 * over ≥ 3 decayed interactions ≥ 0.5, else the static default.
 */

export const SHEET_HABITS_KEY = 'hercules_sheet_habits_v1';

/** Stable section ids that may be recorded / re-ordered. */
export const SHEET_SECTION_IDS = [
  'run-timeline',
  'live-activity',
  'machine-details',
  'packet-details',
  'agent-report',
  'task-body',
  'files',
  'dependencies',
  'agent-picker',
  'chat',
  'actions',
] as const;

export type SheetSectionId = (typeof SHEET_SECTION_IDS)[number];

export type SectionEventKind = 'open' | 'close' | 'click';

export interface SectionHabitEvent {
  readonly kind: SectionEventKind;
  readonly at: number;
}

export interface SectionHabit {
  readonly events: readonly SectionHabitEvent[];
}

export type SheetHabits = Readonly<Partial<Record<SheetSectionId, SectionHabit>>>;

const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_EVENTS_PER_SECTION = 64;
const KNOWN = new Set<string>(SHEET_SECTION_IDS);

function isSectionId(id: string): id is SheetSectionId {
  return KNOWN.has(id);
}

function decayWeight(at: number, now: number): number {
  const age = Math.max(0, now - at);
  return Math.pow(0.5, age / HALF_LIFE_MS);
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function storage(): StorageLike | null {
  try {
    const g = globalThis as { localStorage?: StorageLike };
    return g.localStorage ?? null;
  } catch {
    return null;
  }
}

function parseHabits(raw: string): SheetHabits {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Partial<Record<SheetSectionId, SectionHabit>> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isSectionId(id) || !value || typeof value !== 'object') continue;
    const eventsRaw = (value as { events?: unknown }).events;
    if (!Array.isArray(eventsRaw)) continue;
    const events: SectionHabitEvent[] = [];
    for (const e of eventsRaw) {
      if (!e || typeof e !== 'object') continue;
      const kind = (e as { kind?: unknown }).kind;
      const at = (e as { at?: unknown }).at;
      if (kind !== 'open' && kind !== 'close' && kind !== 'click') continue;
      if (typeof at !== 'number' || !Number.isFinite(at)) continue;
      events.push({ kind, at });
    }
    if (events.length > 0) {
      out[id] = { events: events.slice(-MAX_EVENTS_PER_SECTION) };
    }
  }
  return out;
}

/** Load habits; missing or throwing storage → {}. */
export function loadSheetHabits(): SheetHabits {
  const s = storage();
  if (!s) return {};
  try {
    const raw = s.getItem(SHEET_HABITS_KEY);
    if (!raw) return {};
    return parseHabits(raw);
  } catch {
    return {};
  }
}

/**
 * Persist habits (bounded to known ids).
 * @returns true when written; false when storage is missing or throws.
 */
export function saveSheetHabits(habits: SheetHabits): boolean {
  const s = storage();
  if (!s) return false;
  try {
    const bounded: Record<string, SectionHabit> = {};
    for (const id of SHEET_SECTION_IDS) {
      const h = habits[id];
      if (h && h.events.length > 0) {
        bounded[id] = { events: h.events.slice(-MAX_EVENTS_PER_SECTION) };
      }
    }
    s.setItem(SHEET_HABITS_KEY, JSON.stringify(bounded));
    return true;
  } catch {
    /* private mode / quota */
    return false;
  }
}

/** Clear all sheet habits (Settings reset). */
export function resetSheetHabits(): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(SHEET_HABITS_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Window after a summary pointer/click/keydown during which a native
 * `<details>` `toggle` may be attributed to that gesture. Programmatic
 * `open` changes also fire `toggle` and must be ignored outside this window.
 */
export const SUMMARY_GESTURE_WINDOW_MS = 500;

/**
 * True when `gestureAt` is a finite timestamp within the summary-gesture
 * window of `now`. Future / non-finite / missing timestamps fail closed.
 */
export function isRecentSummaryGesture(
  gestureAt: number | undefined,
  now: number = Date.now(),
  windowMs: number = SUMMARY_GESTURE_WINDOW_MS,
): boolean {
  if (gestureAt === undefined || !Number.isFinite(gestureAt) || gestureAt > now) {
    return false;
  }
  return now - gestureAt <= windowMs;
}

/**
 * Record a real user gesture. Programmatic state changes must not call this
 * (UI must gate `toggle` via {@link isRecentSummaryGesture}).
 * Returns the updated habits map when persistence succeeds; on storage
 * failure returns the previous map unchanged so layout stays static (N4).
 */
export function recordSectionEvent(
  id: string,
  kind: SectionEventKind,
  now: number,
  habits: SheetHabits = loadSheetHabits(),
): SheetHabits {
  if (!isSectionId(id)) return habits;
  const prev = habits[id]?.events ?? [];
  const next: SheetHabits = {
    ...habits,
    [id]: { events: [...prev, { kind, at: now }].slice(-MAX_EVENTS_PER_SECTION) },
  };
  if (!saveSheetHabits(next)) return habits;
  return next;
}

/** Decayed engagement score for ranking (opens + clicks; closes ignored). */
export function sectionScore(habit: SectionHabit | undefined, now: number): number {
  if (!habit) return 0;
  let score = 0;
  for (const e of habit.events) {
    if (e.kind === 'close') continue;
    score += decayWeight(e.at, now);
  }
  return score;
}

/**
 * Rank section ids by descending decayed score; ties keep `staticOrder`.
 * Unknown ids in `ids` are appended in their original relative order after ranked ones.
 */
export function rankSections(
  ids: readonly string[],
  habits: SheetHabits,
  now: number,
  staticOrder: readonly string[],
): string[] {
  const staticIndex = new Map(staticOrder.map((id, i) => [id, i]));
  const known = ids.filter((id) => staticIndex.has(id));
  const unknown = ids.filter((id) => !staticIndex.has(id));
  const sorted = [...known].sort((a, b) => {
    const sa = sectionScore(habits[a as SheetSectionId], now);
    const sb = sectionScore(habits[b as SheetSectionId], now);
    if (sb !== sa) return sb - sa;
    return (staticIndex.get(a) ?? 0) - (staticIndex.get(b) ?? 0);
  });
  return [...sorted, ...unknown];
}

/**
 * Default-open decision: when ≥ 3 decayed open/close interactions exist,
 * open if open-ratio ≥ 0.5 (closes count negative here). Otherwise staticDefault.
 * Clicks do not affect the open ratio.
 */
export function defaultOpen(
  id: string,
  habits: SheetHabits,
  staticDefault: boolean,
  now: number = Date.now(),
): boolean {
  if (!isSectionId(id)) return staticDefault;
  const habit = habits[id];
  if (!habit || habit.events.length === 0) return staticDefault;

  let openW = 0;
  let closeW = 0;
  let toggles = 0;
  for (const e of habit.events) {
    if (e.kind === 'click') continue;
    toggles += 1;
    const w = decayWeight(e.at, now);
    if (e.kind === 'open') openW += w;
    else closeW += w;
  }
  const total = openW + closeW;
  // Need ≥ 3 recorded open/close gestures (raw count — decay only shapes the
  // ratio, otherwise three fresh events fall below 3 a few ms later) and a
  // non-negligible decayed weight (very old history keeps the static default).
  if (toggles < 3 || total < 0.5) return staticDefault;
  return openW / total >= 0.5;
}
