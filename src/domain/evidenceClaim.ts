/**
 * Clause-scoped negation for product claims.
 * Shared by data-evidence hook extraction and auth UI intent.
 * Boundaries: punctuation and adversative conjunctions
 * (but/however/yet; Chinese dan/danshi/er). Not and/or/yu/he.
 */

const EN_NEG = new RegExp(
  [
    '\\b(?:no|not|never|without|avoid|forbid(?:den)?|don\'t|do\\s+not|',
    'does\\s+not|must\\s+not|should\\s+not|cannot|can\'t)\\b',
  ].join(''),
  'i',
);

const CJK_NEG = new RegExp(
  [
    '\\u4e0d\\u8981|\\u65e0\\u9700|\\u7981\\u6b62|\\u4e0d\\u53ef|',
    '\\u4e0d\\u5e94|\\u4e0d\\u80fd|\\u4e0d\\u7528|\\u5e76\\u975e|',
    '\\u4e0d\\u662f|\\u6ca1\\u6709',
  ].join(''),
);

/**
 * Adversative / contrast conjunctions that open a new claim clause.
 * Narrow set only - coordinating and/or (yu/he) keep one negator scope.
 * Longer CJK form danshi listed before dan so it wins at the same offset.
 */
const ADVERSATIVE_BOUNDARY = new RegExp(
  ['\\b(?:but|however|yet)\\b', '|', '\\u4f46\\u662f|\\u4f46|\\u800c'].join(''),
  'gi',
);

/** True when the clause immediately before index contains an explicit negator. */
export function isPrecedingClauseNegated(text: string, index: number): boolean {
  const start = Math.max(0, index - 56);
  const before = text.slice(start, index);
  const clause = lastClause(before);
  if (EN_NEG.test(clause)) return true;
  if (CJK_NEG.test(clause)) return true;
  return false;
}

/** Selector-scoped alias used by evidence claim extraction. */
export function isEvidenceHookNegated(line: string, index: number): boolean {
  return isPrecedingClauseNegated(line, index);
}

function lastClause(before: string): string {
  let cut = 0;
  for (let i = 0; i < before.length; i += 1) {
    const c = before.charCodeAt(i);
    if (
      c === 59 ||
      c === 0xff1b ||
      c === 44 ||
      c === 0xff0c ||
      c === 46 ||
      c === 0x3002 ||
      c === 124
    ) {
      cut = i + 1;
    }
  }
  // Within the punct-bounded region, also cut after the last adversative.
  const region = before.slice(cut);
  ADVERSATIVE_BOUNDARY.lastIndex = 0;
  let m: RegExpExecArray | null;
  let advCut = 0;
  while ((m = ADVERSATIVE_BOUNDARY.exec(region)) !== null) {
    advCut = m.index + m[0].length;
    if (m[0].length === 0) {
      ADVERSATIVE_BOUNDARY.lastIndex += 1;
    }
  }
  return region.slice(advCut);
}
