/**
 * Helpers so Voice Control never confuses a truncated slice with the full record.
 * Every clipped payload is stamped so the model is instructed not to invent the rest.
 */

export const FRAGMENT_BANNER =
  '[FRAGMENT — incomplete excerpt; do NOT invent missing parts or treat as the full document]';

/**
 * Clip text and always declare incompleteness when truncated.
 * If `forceFragment` is true, stamp even when under max (e.g. "tail of N only").
 */
export function clipFragment(
  text: string,
  maxChars: number,
  opts?: { forceFragment?: boolean; note?: string },
): string {
  const raw = text ?? '';
  const note = opts?.note?.trim();
  if (raw.length <= maxChars && !opts?.forceFragment) {
    return raw;
  }
  if (raw.length <= maxChars && opts?.forceFragment) {
    const banner = note ? `${FRAGMENT_BANNER} ${note}` : FRAGMENT_BANNER;
    return `${banner}\n${raw}`;
  }
  const shown = raw.slice(0, Math.max(0, maxChars));
  const banner =
    `${FRAGMENT_BANNER} showing ${shown.length} of ${raw.length} chars` +
    (note ? ` — ${note}` : '');
  return `${banner}\n${shown}\n…`;
}

/** Join lines with a fragment stamp when the list was sliced. */
export function listFragment(
  lines: readonly string[],
  maxItems: number,
  itemLabel = 'items',
): { text: string; truncated: boolean } {
  if (lines.length <= maxItems) {
    return { text: lines.join('\n'), truncated: false };
  }
  const shown = lines.slice(0, maxItems);
  const banner = `${FRAGMENT_BANNER} showing ${shown.length} of ${lines.length} ${itemLabel}`;
  return {
    text: `${banner}\n${shown.join('\n')}\n…`,
    truncated: true,
  };
}
