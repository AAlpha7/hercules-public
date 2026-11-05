/**
 * Detect removed/renamed named test cases in a unified diff (L5 test-integrity).
 * Pure. Structural and bounded — only it/test declarations, not prose.
 * Supports single-line and multiline it/test and it.each forms used in this repo.
 * Ignores // comments, block comments, and template/snapshot string bodies.
 * Parses each hunk into bounded old/new views (context to both; del to old; add to new),
 * resets lexical state per hunk, then compares file-global title occurrence counts.
 */
import type { CheatFinding } from '../domain/verification.js';

const TEST_FILE = /(^|\/)test\/|\.(test|spec)\.[cm]?[jt]sx?$|\.rs$/;
const PROSE_FILE = /\.(md|markdown|mdx|txt|rst|adoc)$/i;
const RUST_FILE = /\.rs$/i;

const EACH_OPEN_RE =
  /^(?:it|test)(?:\.(?:skip|only|todo|concurrent|failing))*\.each\s*\(/;
const PLAIN_OPEN_RE =
  /^(?:it|test)(?:\.(?:skip|only|todo|concurrent|failing))?\s*\(/;

const SQ = String.fromCharCode(39);
const DQ = String.fromCharCode(34);
const TQ = String.fromCharCode(96);

function quoteOf(c: string | undefined): string | null {
  if (c === SQ || c === DQ || c === TQ) return c;
  return null;
}

/** Titles removed but not re-added in the same test file → critical finding. */
export function findRemovedTestCases(diff: string): CheatFinding[] {
  const byFile = collectTestTitleChurn(diff);
  const findings: CheatFinding[] = [];
  for (const [file, churn] of byFile) {
    for (const title of churn.removed.keys()) {
      const oldCount = churn.removed.get(title) || 0;
      const newCount = churn.added.get(title) || 0;
      if (oldCount <= newCount) continue;
      findings.push({
        kind: 'test-integrity',
        file,
        detail: 'removed or renamed test case "' + title + '"',
      });
    }
  }
  return findings;
}

interface TitleChurn {
  readonly removed: Map<string, number>;
  readonly added: Map<string, number>;
}

function collectTestTitleChurn(diff: string): Map<string, TitleChurn> {
  const byFile = new Map<
    string,
    { removed: Map<string, number>; added: Map<string, number> }
  >();
  let oldFile = '';
  let newFile = '';
  let oldLines: string[] = [];
  let newLines: string[] = [];
  let inHunk = false;

  const resolveFile = (): string | null => {
    const candidate =
      oldFile && oldFile !== '/dev/null'
        ? oldFile
        : newFile && newFile !== '/dev/null'
          ? newFile
          : '';
    if (!candidate || candidate === '/dev/null') return null;
    if (!TEST_FILE.test(candidate) || PROSE_FILE.test(candidate)) return null;
    return candidate;
  };

  const ensure = (file: string) => {
    let row = byFile.get(file);
    if (!row) {
      row = { removed: new Map<string, number>(), added: new Map<string, number>() };
      byFile.set(file, row);
    }
    return row;
  };

  const flushHunk = () => {
    if (!inHunk) return;
    const file = resolveFile();
    if (file) {
      const row = ensure(file);
      if (RUST_FILE.test(file)) {
        mergeTitleCounts(
          row.removed,
          new Map(extractRustTestCaseTitles(oldLines.join('\n')).map((t) => [t, 1])),
        );
        mergeTitleCounts(
          row.added,
          new Map(extractRustTestCaseTitles(newLines.join('\n')).map((t) => [t, 1])),
        );
      } else {
        mergeTitleCounts(row.removed, extractTestTitles(oldLines));
        mergeTitleCounts(row.added, extractTestTitles(newLines));
      }
    }
    oldLines = [];
    newLines = [];
    inHunk = false;
  };

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff ') || raw.startsWith('index ')) {
      flushHunk();
      continue;
    }
    if (raw.startsWith('--- ')) {
      flushHunk();
      oldFile = raw.slice(4).replace(/^a\//, '').trim();
      continue;
    }
    if (raw.startsWith('+++ ')) {
      newFile = raw.slice(4).replace(/^b\//, '').trim();
      continue;
    }
    if (raw.startsWith('@@')) {
      flushHunk();
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    if (raw.startsWith('-') && !raw.startsWith('---')) {
      oldLines.push(raw.slice(1));
    } else if (raw.startsWith('+') && !raw.startsWith('+++')) {
      newLines.push(raw.slice(1));
    } else if (raw.startsWith('\\')) {
      continue;
    } else if (raw.startsWith(' ') || raw === '') {
      const text = raw.startsWith(' ') ? raw.slice(1) : raw;
      oldLines.push(text);
      newLines.push(text);
    }
  }
  flushHunk();

  const out = new Map<string, TitleChurn>();
  for (const [file, row] of byFile) {
    out.set(file, { removed: row.removed, added: row.added });
  }
  return out;
}

function mergeTitleCounts(
  into: Map<string, number>,
  from: Map<string, number>,
): void {
  for (const entry of from) {
    const title = entry[0];
    const count = entry[1];
    into.set(title, (into.get(title) || 0) + count);
  }
}

function normalizeTestTitle(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

function matchAtStatementStart(
  code: string,
  re: RegExp,
): { start: number; end: number } | null {
  const trimmedStart = code.search(/\S/);
  if (trimmedStart < 0) return null;
  const slice = code.slice(trimmedStart);
  const m = re.exec(slice);
  if (!m || m.index !== 0) return null;
  return { start: trimmedStart, end: trimmedStart + m[0].length };
}

function consumeParenDepth(code: string, depth: number): { depth: number; rest: string } {
  let d = depth;
  for (let i = 0; i < code.length; i += 1) {
    const c = code.charAt(i);
    if (c === '(') d += 1;
    else if (c === ')') {
      d -= 1;
      if (d === 0) return { depth: 0, rest: code.slice(i + 1) };
    }
  }
  return { depth: d, rest: '' };
}

type TitleAfter =
  | { kind: 'title'; title: string }
  | { kind: 'await' }
  | { kind: 'none' };

function tryTitleAfterEachClose(restCode: string, rawLine: string): TitleAfter {
  const m = /^\s*\(\s*/.exec(restCode);
  if (!m) return { kind: 'none' };
  if (restCode.slice(m[0].length).trim() === '') return { kind: 'await' };
  return tryTitleFromCloseParen(rawLine);
}

function tryTitleFromCloseParen(rawLine: string): TitleAfter {
  const quoteClass = '[' + SQ + DQ + TQ + ']';
  const re = new RegExp('\\)\\s*\\(\\s*(' + quoteClass + ')', 'g');
  let last: RegExpExecArray | null = null;
  let hit = re.exec(rawLine);
  while (hit) {
    last = hit;
    hit = re.exec(rawLine);
  }
  if (last) {
    const quote = quoteOf(last[1]);
    if (quote !== null) {
      const t = readStringLiteral(rawLine, last.index + last[0].length - 1, quote);
      if (t !== null) return { kind: 'title', title: t };
    }
  }
  return { kind: 'none' };
}

function titleAfterOpenParen(rawLine: string, openEnd: number): string | null {
  if (openEnd <= 0 || openEnd > rawLine.length) return null;
  let i = openEnd;
  while (i < rawLine.length && /\s/.test(rawLine.charAt(i))) i += 1;
  const q = quoteOf(rawLine.charAt(i));
  if (q === null) return null;
  return readStringLiteral(rawLine, i, q);
}

function matchLeadingStringLiteral(line: string): string | null {
  const m = /^\s*(['"`])/.exec(line);
  if (!m) return null;
  const quote = quoteOf(m[1]);
  if (quote === null) return null;
  return readStringLiteral(line, m.index + m[0].length - 1, quote);
}

function readStringLiteral(line: string, quoteIdx: number, quote: string): string | null {
  let i = quoteIdx + 1;
  let out = '';
  while (i < line.length) {
    const c = line.charAt(i);
    if (c === '\\' && quote !== TQ) {
      out += line.charAt(i + 1);
      i += 2;
      continue;
    }
    if (c === quote) return out;
    if (quote === TQ && c === '$' && line.charAt(i + 1) === '{') return null;
    out += c;
    i += 1;
  }
  return null;
}

function openerIsSkipOrTodo(opener: string): boolean {
  return /\.(?:skip|todo)\b/.test(opener);
}

function extractTestTitles(
  lines: readonly string[],
  opts?: { readonly excludeSkipTodo?: boolean },
): Map<string, number> {
  const excludeSkipTodo = opts?.excludeSkipTodo === true;
  const titles = new Map<string, number>();
  const bump = (title: string): void => {
    const key = normalizeTestTitle(title);
    titles.set(key, (titles.get(key) || 0) + 1);
  };
  let inBlockComment = false;
  let inTemplate = false;
  let eachDepth = 0;
  let awaitTitle = false;
  let awaitExcluded = false;
  for (const raw of lines) {
    const walked = walkLine(raw, inBlockComment, inTemplate);
    inBlockComment = walked.inBlockComment;
    inTemplate = walked.inTemplate;
    const code = walked.code;
    if (code.trim() === '') continue;
    if (eachDepth > 0) {
      const closed = consumeParenDepth(code, eachDepth);
      eachDepth = closed.depth;
      if (eachDepth > 0) continue;
      if (awaitExcluded) {
        awaitExcluded = false;
        awaitTitle = false;
        continue;
      }
      const titleFrom = tryTitleAfterEachClose(closed.rest, raw);
      if (titleFrom.kind === 'title') {
        bump(titleFrom.title);
        awaitTitle = false;
      } else if (titleFrom.kind === 'await') {
        awaitTitle = true;
      } else {
        awaitTitle = false;
      }
      continue;
    }
    if (awaitTitle) {
      const leading = matchLeadingStringLiteral(raw);
      if (leading !== null) {
        if (!awaitExcluded) bump(leading);
        awaitTitle = false;
        awaitExcluded = false;
        continue;
      }
      if (code.trim() !== '') {
        awaitTitle = false;
        awaitExcluded = false;
      }
    }
    const eachOpen = matchAtStatementStart(code, EACH_OPEN_RE);
    if (eachOpen) {
      const opener = code.slice(eachOpen.start, eachOpen.end);
      const excluded = excludeSkipTodo && openerIsSkipOrTodo(opener);
      const afterOpen = code.slice(eachOpen.end);
      const closed = consumeParenDepth(afterOpen, 1);
      if (closed.depth > 0) {
        eachDepth = closed.depth;
        awaitTitle = false;
        awaitExcluded = excluded;
        continue;
      }
      if (excluded) {
        awaitTitle = false;
        awaitExcluded = false;
        continue;
      }
      const titleFrom = tryTitleAfterEachClose(closed.rest, raw);
      if (titleFrom.kind === 'title') {
        bump(titleFrom.title);
        awaitTitle = false;
      } else if (titleFrom.kind === 'await') {
        awaitTitle = true;
      } else {
        awaitTitle = false;
      }
      continue;
    }
    const plainOpen = matchAtStatementStart(code, PLAIN_OPEN_RE);
    if (plainOpen) {
      const opener = code.slice(plainOpen.start, plainOpen.end);
      const excluded = excludeSkipTodo && openerIsSkipOrTodo(opener);
      if (excluded) {
        // Still consume multiline title await so a following string is not
        // attributed to a later declaration — but never bump the title.
        if (code.slice(plainOpen.end).trim() === '') {
          awaitTitle = true;
          awaitExcluded = true;
        } else {
          awaitTitle = false;
          awaitExcluded = false;
        }
        continue;
      }
      const title = titleAfterOpenParen(raw, plainOpen.end);
      if (title !== null) {
        bump(title);
        awaitTitle = false;
        awaitExcluded = false;
      } else if (code.slice(plainOpen.end).trim() === '') {
        awaitTitle = true;
        awaitExcluded = false;
      } else {
        awaitTitle = false;
        awaitExcluded = false;
      }
    }
  }
  return titles;
}

/**
 * Attribute that marks a Rust test fn: `#[test]`, `#[tokio::test]`, or any
 * `#[…::test]` / `#[…::test(…)]` form. Nested `#[cfg(test)] mod` is ignored —
 * only the attribute + `fn name` pairing matters.
 */
const RUST_TEST_ATTR_RE =
  /^\s*#\[\s*(?:[\w:]+::)*test(?:\s*\([^)]*\))?\s*\]\s*$/;
const RUST_FN_RE = /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)\s*(?:<[^>]*>)?\s*\(/;

/** Rust `#[test]` / `#[tokio::test]` fn names declared in a `.rs` source. */
export function extractRustTestCaseTitles(source: string): readonly string[] {
  const titles: string[] = [];
  const seen = new Set<string>();
  const lines = source.split('\n');
  let pendingTest = false;
  let inBlockComment = false;
  for (const raw of lines) {
    let line = raw;
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end < 0) continue;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    while (true) {
      const start = line.indexOf('/*');
      if (start < 0) break;
      const end = line.indexOf('*/', start + 2);
      if (end < 0) {
        line = line.slice(0, start);
        inBlockComment = true;
        break;
      }
      line = line.slice(0, start) + line.slice(end + 2);
    }
    const code = line.replace(/\/\/.*$/, '');
    if (code.trim() === '') continue;
    if (RUST_TEST_ATTR_RE.test(code)) {
      pendingTest = true;
      continue;
    }
    if (pendingTest) {
      // Skip other attributes between #[test] and fn.
      if (/^\s*#\[/.test(code)) continue;
      const m = RUST_FN_RE.exec(code);
      pendingTest = false;
      if (m) {
        const name = m[1]!;
        if (!seen.has(name)) {
          seen.add(name);
          titles.push(name);
        }
      }
    }
  }
  return titles;
}

/**
 * it()/test() (JS/TS) or #[test] fn (Rust) titles. `.skip` / `.todo` excluded for JS.
 * Pass `pathHint` (e.g. `foo.rs`) so Rust vs JS is chosen by extension; without
 * a hint, Rust is used only when the source has `#[…test]` attributes.
 */
export function extractTestCaseTitles(
  source: string,
  pathHint?: string,
): readonly string[] {
  const asRust =
    (pathHint !== undefined && RUST_FILE.test(pathHint)) ||
    (pathHint === undefined &&
      /#\[\s*(?:[\w:]+::)*test\b/.test(source) &&
      /\bfn\s+[A-Za-z_]/.test(source) &&
      !/\b(?:it|test)\s*\(/.test(source));
  if (asRust) return extractRustTestCaseTitles(source);
  return [...extractTestTitles(source.split('\n'), { excludeSkipTodo: true }).keys()];
}

/** Titles on ADDED lines of a unified diff, per test file (b/ prefix stripped). */
export function collectAddedTestTitles(
  diff: string,
): ReadonlyMap<string, readonly string[]> {
  const byFile = new Map<string, string[]>();
  let newFile = '';
  let inHunk = false;

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff ') || raw.startsWith('index ')) {
      inHunk = false;
      continue;
    }
    if (raw.startsWith('--- ')) {
      inHunk = false;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      newFile = raw.slice(4).replace(/^b\//, '').trim();
      continue;
    }
    if (raw.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
    if (!newFile || newFile === '/dev/null') continue;
    if (!TEST_FILE.test(newFile) || PROSE_FILE.test(newFile)) continue;
    let bucket = byFile.get(newFile);
    if (!bucket) {
      bucket = [];
      byFile.set(newFile, bucket);
    }
    bucket.push(raw.slice(1));
  }

  const out = new Map<string, readonly string[]>();
  for (const [file, lines] of byFile) {
    if (RUST_FILE.test(file)) {
      out.set(file, extractRustTestCaseTitles(lines.join('\n')));
    } else {
      out.set(file, [...extractTestTitles(lines, { excludeSkipTodo: true }).keys()]);
    }
  }
  return out;
}

/** Blank comments/strings/templates; keep length aligned with raw for indices. */
function walkLine(
  line: string,
  inBlockComment: boolean,
  inTemplate: boolean,
): { code: string; inBlockComment: boolean; inTemplate: boolean } {
  const chars: string[] = [];
  let i = 0;
  let block = inBlockComment;
  let tmpl = inTemplate;
  while (i < line.length) {
    const c = line.charAt(i);
    const next = line.charAt(i + 1);
    if (block) {
      if (c === '*' && next === '/') {
        block = false;
        chars.push(' ', ' ');
        i += 2;
        continue;
      }
      chars.push(' ');
      i += 1;
      continue;
    }
    if (tmpl) {
      if (c === '\\') {
        chars.push(' ', ' ');
        i += 2;
        continue;
      }
      if (c === TQ) {
        tmpl = false;
        chars.push(' ');
        i += 1;
        continue;
      }
      chars.push(' ');
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') break;
    if (c === '/' && next === '*') {
      block = true;
      chars.push(' ', ' ');
      i += 2;
      continue;
    }
    if (c === '/' && regexLiteralStartsHere(chars)) {
      // A regex literal: blank it whole so quotes / backticks inside it (e.g.
      // assert.match(src, /idempotencyKey(`vnext:${id}`)/)) never open a
      // string or template state that swallows the following it() titles
      // (a downstream project, 2026-09-12). Literals never span lines.
      chars.push(' ');
      i += 1;
      let inClass = false;
      while (i < line.length) {
        const rc = line.charAt(i);
        if (rc === '\\') {
          chars.push(' ', ' ');
          i += 2;
          continue;
        }
        if (inClass) {
          if (rc === ']') inClass = false;
        } else if (rc === '[') {
          inClass = true;
        } else if (rc === '/') {
          chars.push(' ');
          i += 1;
          break;
        }
        chars.push(' ');
        i += 1;
      }
      while (i < line.length && /[a-z]/i.test(line.charAt(i))) {
        chars.push(' ');
        i += 1;
      }
      continue;
    }
    if (c === TQ) {
      tmpl = true;
      chars.push(' ');
      i += 1;
      continue;
    }
    if (c === DQ || c === SQ) {
      const quote = c;
      chars.push(' ');
      i += 1;
      while (i < line.length) {
        const sc = line.charAt(i);
        if (sc === '\\') {
          chars.push(' ', ' ');
          i += 2;
          continue;
        }
        if (sc === quote) {
          chars.push(' ');
          i += 1;
          break;
        }
        chars.push(' ');
        i += 1;
      }
      continue;
    }
    chars.push(c);
    i += 1;
  }
  return { code: chars.join(''), inBlockComment: block, inTemplate: tmpl };
}

const REGEX_PREFIX_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'instanceof', 'new',
  'delete', 'void', 'throw', 'yield', 'await',
]);

/**
 * `/` starts a regex literal (not a division) when the preceding code token
 * is an operator / opener / keyword or there is none — the usual JS lexer
 * heuristic over the already-blanked prefix of the line.
 */
function regexLiteralStartsHere(prefix: readonly string[]): boolean {
  let end = prefix.length;
  while (end > 0 && /\s/.test(prefix[end - 1]!)) end -= 1;
  if (end === 0) return true;
  const last = prefix[end - 1]!;
  if ('(,=:[!&|?{};+-*%<>~^'.includes(last)) return true;
  if (!/[A-Za-z0-9_$]/.test(last)) return false;
  let start = end;
  while (start > 0 && /[A-Za-z0-9_$]/.test(prefix[start - 1]!)) start -= 1;
  return REGEX_PREFIX_KEYWORDS.has(prefix.slice(start, end).join(''));
}
