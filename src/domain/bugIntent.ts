/**
 * Lexical bug/fix intent — English fix/fixed/fixing as words only
 * (not fixture / prefix / suffix substrings).
 */
export function hasBugIntent(text: string): boolean {
  if (/\bfix(?:ed|ing)?\b/i.test(text)) return true;
  if (/\bbug\b/i.test(text)) return true;
  if (/flaky/i.test(text)) return true;
  if (/\bfailing\b/i.test(text)) return true;
  if (/\berror\b/i.test(text)) return true;
  if (/regression/i.test(text)) return true;
  if (text.includes('\u5d29\u6e83')) return true;
  if (text.includes('\u62a5\u9519')) return true;
  if (text.includes('\u56de\u5f52')) return true;
  return false;
}
