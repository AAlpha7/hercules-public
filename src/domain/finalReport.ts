/**
 * Domain layer — standalone final-report hygiene (P6).
 *
 * Operators often see dangling back-references ("as above", "见上", …) that
 * assume they read the whole session. Pure substring detection so the prompt
 * contract and packet soft-note can share one list — not a gate, not NLP.
 */

/** Fixed forbidden back-reference phrases (Latin match is case-insensitive). */
const BACK_REFERENCE_PHRASES = [
  'as above',
  'see earlier',
  'as discussed',
  '如上',
  '见上',
  '上述',
] as const;

/**
 * Return the matched forbidden back-reference substrings from {@link report}.
 * Empty when the report is already standalone.
 */
export function finalReportBackReferences(report: string): string[] {
  const lower = report.toLowerCase();
  const found: string[] = [];
  for (const phrase of BACK_REFERENCE_PHRASES) {
    const haystack = /[A-Za-z]/.test(phrase) ? lower : report;
    if (haystack.includes(phrase)) found.push(phrase);
  }
  return found;
}
