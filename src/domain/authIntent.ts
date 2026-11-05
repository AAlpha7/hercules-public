/**
 * Domain — lexical auth UI intent predicate.
 * Shared by feature classification and L2 evidence repair.
 *
 * True: login/sign-in, credential/password input, token input,
 * permission-management UI, session auth/expiry/timeout, and generic
 * authentication/authorization words **with** interactive account-entry chrome
 * context on the same line (screen/page/form/dialog/…).
 * False: assigning, authoritative, token budgets, permission profiles,
 * agentSession plumbing, logout alone, stored credential/password-hash ops,
 * clause-negated login/auth UI claims (no login UI, without authentication),
 * and provider/model credential, environment-boundary, or policy prose
 * ("provider authentication", "model-auth plumbing") with no such chrome —
 * guardian-repo-execution-policy 2026-08-01 was forced onto the account-entry
 * template by exactly that prose.
 * A separate positive auth clause in the same body still wins.
 */

import { extractProductBrief } from './taskBrief.js';
import { isPrecedingClauseNegated } from './evidenceClaim.js';

/**
 * Interactive account-entry / session re-entry chrome context. Generic auth
 * words (below) are browser intent only next to chrome like this — bare
 * "provider authentication" / "model-auth" in credential, environment-boundary,
 * or policy prose is infrastructure, not a login feature.
 */
const CHROME_CONTEXT_RE = new RegExp(
  '\\b(?:ui|screen|page|form|dialog|modal|prompt|button|sheet|panel|chrome|input|field)s?\\b|' +
    '\\u754c\\u9762|\\u5c4f\\u5e55|\\u9875\\u9762|\\u8868\\u5355|\\u5f39\\u7a97|\\u6309\\u94ae|\\u5165\\u53e3',
  'i',
);

/**
 * Auth UI cues. Positive only when the preceding clause is not negated.
 * `needsChrome` marks generic auth vocabulary that also requires
 * {@link CHROME_CONTEXT_RE} on the same line.
 */
const AUTH_SOURCES: readonly {
  source: string;
  flags: string;
  needsChrome?: boolean;
}[] = [
  { source: '\\b(?:log[\\s-]?in|login)\\b', flags: 'gi' },
  { source: '\\bsign[\\s-]?in\\b', flags: 'gi' },
  { source: '\\u767b\\u5f55', flags: 'g' },
  { source: '\\bauthenticat(?:e|ion|or|ing)\\b', flags: 'gi', needsChrome: true },
  { source: '\\bauthoriz(?:e|ation|ed|ing)\\b', flags: 'gi', needsChrome: true },
  { source: '\\bauth\\b', flags: 'gi', needsChrome: true },
  { source: '\\u8ba4\\u8bc1', flags: 'g', needsChrome: true },
  { source: '\\u6388\\u6743', flags: 'g', needsChrome: true },
  {
    source:
      '\\b(?:credential|password)s?\\s+(?:input|form|field|ui|page|dialog|modal|prompt|entry)\\b',
    flags: 'gi',
  },
  {
    source:
      '\\b(?:input|form|field|ui|page|dialog|modal|prompt)\\s+(?:for\\s+)?(?:a\\s+|the\\s+)?(?:credential|password)s?\\b',
    flags: 'gi',
  },
  {
    source: '(?:\\u5bc6\\u7801)\\s*(?:\\u8f93\\u5165|\\u8868\\u5355|\\u6846|\\u5b57\\u6bb5)',
    flags: 'g',
  },
  {
    source: '(?:\\u8f93\\u5165|\\u8868\\u5355).{0,6}(?:\\u5bc6\\u7801)',
    flags: 'g',
  },
  { source: '\\btokens?\\s+(?:input|form|field|entry|prompt|box)\\b', flags: 'gi' },
  {
    source:
      '\\b(?:input|form|field|entry|prompt|box)\\s+(?:for\\s+)?(?:a\\s+|the\\s+)?tokens?\\b',
    flags: 'gi',
  },
  {
    source: '\\bpermissions?\\s*[- ]?(?:management|manager|admin|ui|panel|screen)\\b',
    flags: 'gi',
  },
  { source: '\\bmanage\\s+permissions?\\b', flags: 'gi' },
  { source: '\\u6743\\u9650\\s*\\u7ba1\\u7406', flags: 'g' },
  {
    source: '\\bsessions?\\s+(?:auth|expir\\w*|timeout|login|cookie|re-?auth)',
    flags: 'gi',
  },
  {
    source: '\\b(?:auth|expir\\w*|timeout|login|re-?auth)\\w*\\s+sessions?\\b',
    flags: 'gi',
  },
  {
    source:
      '(?:\\u4f1a\\u8bdd)\\s*(?:\\u8fc7\\u671f|\\u8d85\\u65f6|\\u8ba4\\u8bc1|\\u767b\\u5f55)',
    flags: 'g',
  },
  {
    source: '(?:\\u8fc7\\u671f|\\u8d85\\u65f6).{0,8}(?:\\u4f1a\\u8bdd)',
    flags: 'g',
  },
];

export function hasAuthUiIntent(text: string): boolean {
  // Shared task-brief boundary: harness tails cannot manufacture auth intent.
  // Strip data-evidence hooks so negated selector prose cannot force auth.
  const brief = extractProductBrief(text);
  const hookRe = new RegExp(
    'data-evidence\\s*=\\s*\\W?[a-z][a-z0-9_-]*',
    'gi',
  );
  const t = brief.replace(hookRe, ' ');
  if (!t.trim()) return false;

  // Line-scoped: a negator on one line must not suppress a later positive clause.
  for (const line of t.split(String.fromCharCode(10))) {
    if (lineHasPositiveAuthIntent(line)) return true;
  }
  return false;
}

function lineHasPositiveAuthIntent(line: string): boolean {
  for (const { source, flags, needsChrome } of AUTH_SOURCES) {
    if (needsChrome === true && !CHROME_CONTEXT_RE.test(line)) continue;
    const re = new RegExp(source, flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (!isPrecedingClauseNegated(line, m.index)) return true;
      if (m[0].length === 0) re.lastIndex += 1;
    }
  }
  return false;
}
