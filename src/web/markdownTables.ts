/**
 * Pure GFM pipe-table helpers for the phone Markdown renderer.
 * Kept free of React so unit tests can import without a DOM/JSX transform.
 */

/** True for a GFM table data/header row (`| a | b |`). */
export function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith('|') && t.includes('|', 1);
}

/** True for a GFM table separator (`|---|:---:|---:|`). */
export function isTableSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith('|')) return false;
  // Each cell is optional colon + dashes + optional colon.
  return /^\|(\s*:?-+:?\s*\|)+\s*$/.test(t);
}

/**
 * Split a pipe table row into trimmed cell strings (outer pipes stripped).
 * Honors `\|` escapes so evidence cells can contain literal pipes (packet uses
 * escapeTableCell → `\|`).
 */
export function splitTableRow(line: string): string[] {
  const t = line.trim();
  const inner = t.startsWith('|') ? t.slice(1) : t;
  const withoutTrailing = inner.endsWith('|') ? inner.slice(0, -1) : inner;
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < withoutTrailing.length; i += 1) {
    const c = withoutTrailing[i]!;
    if (c === '\\' && withoutTrailing[i + 1] === '|') {
      cur += '|';
      i += 1;
      continue;
    }
    if (c === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * Wide GFM tables (evidence matrix, etc.) are unreadable on phone when forced
 * into ~320px columns. Prefer stacked cards when:
 * - 3+ columns, or
 * - headers look like criterion/evidence review rows
 */
export function shouldRenderTableAsCards(headers: readonly string[]): boolean {
  if (headers.length >= 3) return true;
  const h = headers.map((x) => x.toLowerCase());
  if (h.some((x) => x.includes('criterion')) && h.some((x) => x.includes('evidence'))) {
    return true;
  }
  return false;
}

/** Pair header labels with cell values for one body row (card layout). */
export function zipTableRow(
  headers: readonly string[],
  cells: readonly string[],
): readonly { readonly label: string; readonly value: string }[] {
  const n = Math.max(headers.length, cells.length);
  const out: { label: string; value: string }[] = [];
  for (let i = 0; i < n; i += 1) {
    const label = headers[i]?.trim() || `Col ${i + 1}`;
    const value = cells[i]?.trim() ?? '';
    if (!label && !value) continue;
    out.push({ label, value });
  }
  return out;
}

/** Title field for a card: prefer Criterion, else first non-empty cell. */
export function cardTitleFromRow(
  pairs: readonly { readonly label: string; readonly value: string }[],
): { readonly title: string; readonly rest: readonly { readonly label: string; readonly value: string }[] } {
  const crit = pairs.findIndex((p) => /criterion/i.test(p.label));
  if (crit >= 0) {
    const title = pairs[crit]!.value || pairs[crit]!.label;
    return { title, rest: pairs.filter((_, i) => i !== crit) };
  }
  const first = pairs[0];
  if (!first) return { title: '', rest: [] };
  return { title: first.value || first.label, rest: pairs.slice(1) };
}
