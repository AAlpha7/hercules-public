/**
 * Short task slugs: the human-readable half of a generated task id
 * (`<n>-<slug>`). Pure — shared by task creation, the analyst, and the SPA.
 */

/** Hard cap on a slug; long enough for ~5 English words. */
export const TASK_SLUG_MAX = 40;

/** Lowercase words joined by single hyphens, no leading/trailing hyphen. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidTaskSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= TASK_SLUG_MAX && SLUG_PATTERN.test(value);
}

/**
 * Derive a slug from free text. Non-ASCII (e.g. CJK) contributes nothing, so a
 * pure-CJK title yields `''` — callers then fall back to the bare number or ask
 * the analyst for an English slug. Cuts on a word boundary within TASK_SLUG_MAX.
 */
export function shortSlug(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 0);
  let out = '';
  for (const w of words) {
    const next = out.length === 0 ? w : `${out}-${w}`;
    if (next.length > TASK_SLUG_MAX) break;
    out = next;
  }
  if (out.length === 0 && words[0]) out = words[0].slice(0, TASK_SLUG_MAX);
  return out;
}

/** Numeric prefix of a generated id (`42-fix-login` → 42, `42` → 42), else null. */
export function taskNumberOf(id: string): number | null {
  const m = /^(\d{1,12})(?:-|$)/.exec(id);
  return m ? Number(m[1]) : null;
}

/** Next task number: one past the highest numeric prefix among existing ids (≥ 1). */
export function nextTaskNumber(existingIds: Iterable<string>): number {
  let max = 0;
  for (const id of existingIds) {
    const n = taskNumberOf(id);
    if (n !== null && n > max) max = n;
  }
  return max + 1;
}
