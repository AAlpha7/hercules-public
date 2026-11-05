/**
 * Domain — human-facing task brief extraction for the phone (Running / Review).
 *
 * Separates product intent (DoD, task text) from harness noise (System recovery,
 * Review packet, Teardown) so the UI can show the original job without scroll.
 */

export interface DodCounts {
  readonly mechanical: number;
  readonly reviewer: number;
  readonly human: number;
  readonly untypedAsHuman: number;
  readonly total: number;
}

/**
 * Harness / ops headings — not product intent (phone brief cuts here).
 * Keep in sync with `taskBodySplit` harness split (export used there).
 */
export const HARNESS_SECTION_NAMES =
  'Review packet|Proposed graph|System recovery|Auto-rework|Attempts exhausted|Salvage brief|Clean salvage provenance|Run failure|Run timeline|Thrash brake|Teardown|Switch stop|Agent switch|Re-verify|Human steer|Steer result';

const HARNESS_SECTION = new RegExp(`^(?:${HARNESS_SECTION_NAMES})\\b`, 'i');

/** ## heading line that starts a harness block (for body split). */
export const HARNESS_HEADING_LINE = new RegExp(
  `^##\\s+(?:${HARNESS_SECTION_NAMES})\\b`,
  'im',
);

const DOD_SECTION =
  /^##\s+(?:Acceptance criteria|Definition of Done|验收标准|完成定义|DoD)\s*$/im;

/**
 * True when a ## heading is harness/ops noise, not product intent.
 */
export function isHarnessSectionTitle(title: string): boolean {
  return HARNESS_SECTION.test(title.trim());
}

/**
 * Body before the first harness section (Review packet / System recovery / …).
 */
export function extractProductBrief(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const h = /^##\s+(.+)$/.exec(line);
    if (h && isHarnessSectionTitle(h[1] ?? '')) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

/**
 * Short plain-text summary for the Running sheet (first non-empty lines, max ~4).
 */
export function extractTaskSummary(body: string, maxLines = 4, maxChars = 360): string {
  const brief = extractProductBrief(body);
  const lines = brief
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^#/.test(l) && !/^---+$/.test(l));
  const picked = lines.slice(0, maxLines).join('\n');
  if (picked.length <= maxChars) return picked;
  return `${picked.slice(0, maxChars - 1)}…`;
}

/**
 * Count typed DoD criteria in the product brief (not inside Review packet).
 */
export function countDodCriteria(body: string): DodCounts {
  const brief = extractProductBrief(body);
  const sec = DOD_SECTION.exec(brief);
  if (!sec || sec.index === undefined) {
    return { mechanical: 0, reviewer: 0, human: 0, untypedAsHuman: 0, total: 0 };
  }
  const after = brief.slice(sec.index + sec[0].length);
  const next = /^##\s+/m.exec(after);
  const block = (next ? after.slice(0, next.index) : after).trim();
  let mechanical = 0;
  let reviewer = 0;
  let human = 0;
  let untypedAsHuman = 0;
  for (const line of block.split('\n')) {
    const item = /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(line);
    if (!item) continue;
    const rest = item[1]!.trim();
    if (!rest) continue;
    const kindM =
      /^(?:`+)?(?:[[(【（]\s*(mechanical|reviewer|human|机检|审稿|人工|l1|l3)\s*[)\]】）]|((?:mechanical|reviewer|human|机检|审稿|人工))\s*[:：])(?:`+)?\s*/i.exec(
        rest,
      );
    if (!kindM) {
      untypedAsHuman += 1;
      human += 1;
      continue;
    }
    const raw = (kindM[1] ?? kindM[2] ?? '').toLowerCase();
    if (raw === 'mechanical' || raw === '机检' || raw === 'l1') mechanical += 1;
    else if (raw === 'reviewer' || raw === '审稿' || raw === 'l3') reviewer += 1;
    else human += 1;
  }
  return {
    mechanical,
    reviewer,
    human,
    untypedAsHuman,
    total: mechanical + reviewer + human,
  };
}

/** One-line DoD chip text for the phone. */
export function formatDodChip(counts: DodCounts): string {
  if (counts.total === 0) return 'No typed DoD';
  const parts: string[] = [];
  if (counts.mechanical) parts.push(`${counts.mechanical} mechanical`);
  if (counts.reviewer) parts.push(`${counts.reviewer} reviewer`);
  if (counts.human) parts.push(`${counts.human} human`);
  return `DoD: ${parts.join(' · ')}`;
}
