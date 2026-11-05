/**
 * Verification Layer 5 — anti-cheating diff scan (SPEC §9.5).
 *
 * Pure. Scans a unified diff for silencing tricks introduced in added lines
 * (eslint-disable, @ts-ignore, blanket `as any`, `.skip`/`.only`, empty catch)
 * and for edits to protected paths or test files (which the reviewer must scru-
 * tinize — an agent "making the check pass" by weakening the check). Also
 * flags removed/renamed named it/test cases as critical `test-integrity`
 * findings (L1 cannot prove a deleted test still constrains behavior).
 * Multiline it.each tables are handled by testIntegrity.
 *
 * Also detects newly-added JSX `data-evidence` placeholders that exist only so
 * L2 `assert sel=` can pass (disabled empty handlers, placeholder host text,
 * or comments that admit the hook is evidence-only). REVIEW_ONLY.
 */
import type { CheatFinding, CheatKind } from '../domain/verification.js';
import { matchesProtectedPath } from '../domain/protectedPaths.js';
import { findRemovedTestCases } from './testIntegrity.js';
import { findSymlinkEscapes } from './symlinkEscape.js';

interface LinePattern {
  readonly kind: CheatKind;
  readonly re: RegExp;
  readonly detail: string;
}

const LINE_PATTERNS: readonly LinePattern[] = [
  { kind: 'eslint-disable', re: /eslint-disable/, detail: 'disables a lint rule' },
  { kind: 'ts-ignore', re: /@ts-(ignore|nocheck)/, detail: 'suppresses a type error' },
  { kind: 'as-any', re: /\bas\s+any\b/, detail: 'blanket `as any` cast' },
  {
    kind: 'test-skip',
    re: /\b(?:(?:it|test)(?:\s*\.\s*concurrent)?|describe|suite|context|specify|bench|unittest|pytest(?:\s*\.\s*mark)?)\s*\.\s*skip(?:If|if)?\s*\(/,
    detail: 'skips a test',
  },
  {
    kind: 'test-skip',
    re: /(?:#\s*\[\s*ignore(?:\s*=\s*[^\]]+)?\s*\]|\b(?:xit|xtest|xdescribe)\s*\()/,
    detail: 'skips a test',
  },
  {
    kind: 'test-only',
    re: /\b(?:(?:it|test)(?:\s*\.\s*concurrent)?|describe|suite|context|specify|bench)\s*\.\s*only\s*\(/,
    detail: 'focuses a test (.only)',
  },
  {
    kind: 'test-only',
    re: /\b(?:fit|fdescribe)\s*\(/,
    detail: 'focuses a test (.only)',
  },
  { kind: 'empty-catch', re: /catch\s*(\([^)]*\))?\s*\{\s*\}/, detail: 'empty catch swallows errors' },
];

const TEST_FILE = /(^|\/)test\/|\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * Prose files where the line patterns are documentation, not code. A design
 * doc explaining "never use `catch {}`" is not an empty catch (live incident:
 * future-ssh-heavy-worker failed 3 attempts on its own design doc).
 */
const PROSE_FILE = /\.(md|markdown|mdx|txt|rst|adoc)$/i;

/** JSX/TSX (and .jsx-bearing paths) where data-evidence placeholders live. */
const JSX_FILE = /\.[cm]?[jt]sx$/i;

/**
 * Hercules' own verifier / acceptance source (SPEC §9). Not in WORKFLOW
 * `protected_paths` on purpose — tasks legitimately improve the verifier — but
 * an edit here changes how every later task is judged, so it is always
 * surfaced as a review-only `verifier-edit` finding for the human to read.
 * Harmless on other repos (paths simply never match).
 */
export const DEFAULT_VERIFIER_PATHS: readonly string[] = [
  'src/verification/**',
  'src/orchestrator/verifier.ts',
  'src/domain/verification.ts',
  'src/domain/evidence.ts',
  'src/domain/mechProof.ts',
  'src/domain/acceptance.ts',
  'src/domain/acceptanceLint.ts',
];

export interface AntiCheatOptions {
  /** Glob-ish paths the change must not touch (e.g. held-out smoke suite). */
  readonly protectedPaths?: readonly string[];
  /** Glob-ish verifier source paths flagged review-only. Default {@link DEFAULT_VERIFIER_PATHS}. */
  readonly verifierPaths?: readonly string[];
}

export function scanDiff(diff: string, opts: AntiCheatOptions = {}): CheatFinding[] {
  const findings: CheatFinding[] = [];
  const protectedList = opts.protectedPaths ?? [];
  const verifierList = opts.verifierPaths ?? DEFAULT_VERIFIER_PATHS;

  let file = '';
  let newLine = 0;
  const flaggedFiles = new Set<string>();

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.slice(4).replace(/^b\//, '').trim();
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = /\+(\d+)/.exec(raw);
      newLine = m ? Number(m[1]) : 0;
      continue;
    }
    if (raw.startsWith('---') || raw.startsWith('diff ') || raw.startsWith('index ')) {
      continue;
    }

    // File-level flags, once per changed file.
    if ((raw.startsWith('+') || raw.startsWith('-')) && file && file !== '/dev/null') {
      if (!flaggedFiles.has(file)) {
        // Same matcher as create/dispatch fail-fast (domain/protectedPaths).
        if (matchesProtectedPath(file, protectedList)) {
          findings.push({ kind: 'protected-path', file, detail: 'edits a protected path' });
          flaggedFiles.add(file);
        } else if (TEST_FILE.test(file)) {
          findings.push({ kind: 'test-edit', file, detail: 'edits a test file' });
          flaggedFiles.add(file);
        } else if (matchesProtectedPath(file, verifierList)) {
          findings.push({
            kind: 'verifier-edit',
            file,
            detail:
              'edits verifier/acceptance source — merging changes how every later task is judged; read the diff for weakened or special-cased checks',
          });
          flaggedFiles.add(file);
        }
      }
    }

    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      const content = raw.slice(1);
      if (!PROSE_FILE.test(file)) {
        for (const p of LINE_PATTERNS) {
          if (p.re.test(content)) {
            findings.push({ kind: p.kind, file, line: newLine, detail: p.detail });
          }
        }
      }
      newLine += 1;
    } else if (!raw.startsWith('-')) {
      // context line advances the new-file counter; removed lines do not
      newLine += 1;
    }
  }

  // Symlink escapes first: a file turned into an outside link shows every
  // test in it as "removed" — that is the symptom, the link is the cheat.
  const symlinkEscapes = findSymlinkEscapes(diff);
  const symlinked = new Set(symlinkEscapes.map((finding) => finding.file));
  findings.push(...symlinkEscapes);
  findings.push(...findRemovedTestCases(diff).filter((finding) => !symlinked.has(finding.file)));
  findings.push(...findPlaceholderEvidenceHooks(diff));
  return findings;
}

// ── Placeholder data-evidence hooks (L2 assert sel= gaming) ─────────────────

interface AddedLine {
  readonly line: number;
  readonly text: string;
}

/**
 * Placeholder-ish visible text constants agents use for fake hosts.
 * Bare product words like "shell" are intentionally excluded (FP: "App shell ready").
 * Prefer compound tokens: `*-host`, `unproven*`, explicit placeholder/fixture/dummy.
 */
const PLACEHOLDER_TEXT_RE =
  /(?:^|[\s"'`>])(?:[a-z0-9_-]*-host|placeholder|fixture|dummy|unproven[a-z0-9_-]*)(?:$|[\s"'`<])/i;

/**
 * Comments that admit the element exists only for L2 / assert.
 * Avoid bare `for L2` — product chrome often notes L2 exposure next to real handlers.
 */
const EVIDENCE_ONLY_COMMENT_RE =
  /evidence\s+hook\s+only|so\s+evidence\s+assert|让\s*assert|仅为.{0,24}assert|assert\s+sel=|so\s+assert|for\s+assert(?:\s+only)?|L2\s+assert|evidence\s+assert|仅为\s*L2|only\s+for\s+(?:L2|assert|evidence)|hook\s+only/i;

/** Empty / comment-only handler bodies: () => {}, () => { /* … *\/ }, onX={}. */
const EMPTY_HANDLER_RE =
  /\bon(?:Click|Confirm|Press|Change|Submit|Toggle)\s*=\s*\{\s*(?:\(\s*\)\s*=>\s*)?\{\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*)?\s*\}\s*\}/;

/** Real (non-empty) event handlers on a JSX opening tag. */
const REAL_HANDLER_RE =
  /\bon(?:Click|Confirm|Press|Change|Submit|Toggle)\s*=\s*\{(?!\s*(?:\(\s*\)\s*=>\s*)?\{\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*)?\s*\}\s*\})/;

/**
 * Scan a unified diff for newly-added JSX elements that carry `data-evidence`
 * but look non-functional (placeholder chrome for L2 selectors).
 *
 * Only **added** lines participate — context/removed code never triggers.
 * Pattern 1 (disabled + empty handler) is scoped to the **same** JSX opening
 * tag as `data-evidence` (not a ±N-line soup) to avoid false positives when a
 * real hooked panel sits next to an unrelated disabled WIP control.
 * Pure; REVIEW_ONLY findings (file + line + Chinese detail).
 */
export function findPlaceholderEvidenceHooks(diff: string): CheatFinding[] {
  const byFile = collectAddedJsxLines(diff);
  const findings: CheatFinding[] = [];

  for (const [file, lines] of byFile) {
    if (lines.length === 0) continue;
    // Dedup by line so multiple patterns on one element produce one finding.
    const seenLines = new Set<number>();

    for (let i = 0; i < lines.length; i += 1) {
      const row = lines[i]!;
      if (!/\bdata-evidence\s*=/.test(row.text)) continue;

      const openTag = extractJsxOpeningTag(lines, i);
      const openText = openTag?.text ?? row.text;
      // Comment context stays local (same element ± a few lines), not a wide soup.
      const nearComments = addedWindow(lines, i, 3)
        .map((l) => l.text)
        .join('\n');
      const anchorLine = row.line;

      let detail: string | null = null;

      // Pattern 1: SAME element has data-evidence + disabled + empty event body
      if (elementIsDisabledPlaceholder(openText)) {
        detail =
          '新增带 data-evidence 的禁用控件且事件处理为空,疑似仅为 L2 assert 占位';
      }

      // Pattern 2: visible text is a placeholder constant, no interactive child
      if (!detail && looksLikePlaceholderHost(openText, row.text, lines, i)) {
        detail =
          '新增 data-evidence 元素可见文本为占位常量,疑似无真实功能';
      }

      // Pattern 3: nearby admission comment + element lacks a real handler
      if (
        !detail &&
        EVIDENCE_ONLY_COMMENT_RE.test(nearComments) &&
        !hasRealHandler(openText)
      ) {
        detail =
          '新增 data-evidence 附近有「仅为 L2 证据」类注释,疑似占位钩子';
      }

      if (detail && !seenLines.has(anchorLine)) {
        seenLines.add(anchorLine);
        findings.push({
          kind: 'placeholder-evidence-hook',
          file,
          line: anchorLine,
          detail,
        });
      }
    }
  }

  return findings;
}

/**
 * True when the opening tag that carries data-evidence is itself disabled and
 * has an empty/no-op handler (or no handler at all while disabled).
 */
function elementIsDisabledPlaceholder(openTag: string): boolean {
  if (!/\bdata-evidence\s*=/.test(openTag)) return false;
  if (!/\bdisabled\b/.test(openTag)) return false;
  // Explicit empty handler, or disabled with no handler (dead control).
  if (EMPTY_HANDLER_RE.test(openTag) || hasEmptyHandlerInText(openTag)) {
    return true;
  }
  // disabled + no onX= at all → still non-functional chrome for assert sel=
  if (!/\bon(?:Click|Confirm|Press|Change|Submit|Toggle)\s*=/.test(openTag)) {
    return true;
  }
  return false;
}

function hasRealHandler(openTag: string): boolean {
  if (EMPTY_HANDLER_RE.test(openTag) || hasEmptyHandlerInText(openTag)) {
    return false;
  }
  return REAL_HANDLER_RE.test(openTag) || /\bon(?:Click|Confirm|Press|Change|Submit|Toggle)\s*=\s*\{[^}]+\w/.test(openTag);
}

/**
 * Reconstruct the multi-line JSX opening tag that contains `data-evidence` at
 * `dataIdx`. Stops at the `>` that closes the opening tag (brace/paren aware so
 * `onClick={() => {}}` does not end early).
 */
function extractJsxOpeningTag(
  lines: readonly AddedLine[],
  dataIdx: number,
): { readonly text: string; readonly startIdx: number; readonly endIdx: number } | null {
  // Walk backward for the nearest `<Tag` that could open this element.
  let startIdx = dataIdx;
  for (let i = dataIdx; i >= Math.max(0, dataIdx - 40); i -= 1) {
    const t = lines[i]!.text;
    if (/<[A-Za-z][\w.-]*/.test(t)) {
      startIdx = i;
      break;
    }
  }

  let brace = 0;
  let paren = 0;
  let bracket = 0;
  let inStr: '"' | "'" | '`' | null = null;
  let seenOpen = false;
  const parts: string[] = [];

  for (let i = startIdx; i < lines.length && i <= dataIdx + 40; i += 1) {
    const line = lines[i]!.text;
    parts.push(line);
    for (let j = 0; j < line.length; j += 1) {
      const c = line[j]!;
      const next = line[j + 1];

      if (inStr) {
        if (c === '\\' && inStr !== '`') {
          j += 1; // skip escaped char in ' / "
          continue;
        }
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        inStr = c;
        continue;
      }
      if (c === '{') {
        brace += 1;
        continue;
      }
      if (c === '}') {
        brace -= 1;
        continue;
      }
      if (c === '(') {
        paren += 1;
        continue;
      }
      if (c === ')') {
        paren -= 1;
        continue;
      }
      if (c === '[') {
        bracket += 1;
        continue;
      }
      if (c === ']') {
        bracket -= 1;
        continue;
      }
      if (c === '<' && next && /[A-Za-z]/.test(next)) {
        seenOpen = true;
        continue;
      }
      // End of opening tag (or self-close). Require depth 0 so `=>` is ignored
      // while still inside `{() => ...}`.
      if (c === '>' && seenOpen && brace === 0 && paren === 0 && bracket === 0) {
        const text = parts.join('\n');
        if (!/\bdata-evidence\s*=/.test(text)) return null;
        return { text, startIdx, endIdx: i };
      }
    }
  }

  const text = parts.join('\n');
  if (!/\bdata-evidence\s*=/.test(text)) return null;
  return { text, startIdx, endIdx: Math.min(lines.length - 1, dataIdx + 40) };
}

/** Multiline-tolerant empty handler inside a single opening-tag string. */
function hasEmptyHandlerInText(text: string): boolean {
  const compact = text.replace(/\s+/g, ' ');
  return /\bon(?:Click|Confirm|Press|Change|Submit|Toggle)\s*=\s*\{\s*(?:\(\s*(?:[a-zA-Z_$][\w$]*)?\s*\)\s*=>\s*)?\{\s*(?:\/\*[\s\S]*?\*\/|\/\/[^}]*)?\s*\}\s*\}/.test(
    compact,
  );
}

function collectAddedJsxLines(diff: string): Map<string, AddedLine[]> {
  const byFile = new Map<string, AddedLine[]>();
  let file = '';
  let newLine = 0;

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.slice(4).replace(/^b\//, '').trim();
      if (!byFile.has(file)) byFile.set(file, []);
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = /\+(\d+)/.exec(raw);
      newLine = m ? Number(m[1]) : 0;
      continue;
    }
    if (raw.startsWith('---') || raw.startsWith('diff ') || raw.startsWith('index ')) {
      continue;
    }

    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      if (file && file !== '/dev/null' && JSX_FILE.test(file) && !PROSE_FILE.test(file)) {
        byFile.get(file)!.push({ line: newLine, text: raw.slice(1) });
      }
      newLine += 1;
    } else if (!raw.startsWith('-')) {
      newLine += 1;
    }
  }

  // Drop empty non-JSX entries.
  for (const [f, lines] of [...byFile.entries()]) {
    if (lines.length === 0) byFile.delete(f);
  }
  return byFile;
}

function addedWindow(lines: readonly AddedLine[], center: number, radius: number): AddedLine[] {
  const start = Math.max(0, center - radius);
  const end = Math.min(lines.length, center + radius + 1);
  return lines.slice(start, end);
}

/**
 * True when the element around `data-evidence` looks like a bare host:
 * short placeholder text on/after the opening tag, no nested interactive tags
 * as immediate children in the nearby added lines.
 */
function looksLikePlaceholderHost(
  openTag: string,
  dataEvidenceLine: string,
  lines: readonly AddedLine[],
  dataIdx: number,
): boolean {
  // Prefer text on the same line: <div data-evidence="x">foo-host</div>
  const sameLine =
    /data-evidence\s*=\s*(["'])[^"']*\1[^>]*>\s*([^<{]+?)\s*<\//.exec(dataEvidenceLine) ??
    /data-evidence\s*=\s*(["'])[^"']*\1[^>]*>\s*([^<{]+?)\s*<\//.exec(openTag);
  // Multi-line: opening tag ends, next added line is bare text then close.
  let text: string | null = sameLine?.[2]?.trim() ?? null;
  if (!text) {
    // Look at a few lines after the opening tag for bare text content.
    const after = lines.slice(dataIdx, Math.min(lines.length, dataIdx + 4));
    const joined = after.map((l) => l.text).join('\n');
    const m =
      /data-evidence\s*=\s*(["'])[^"']*\1[\s\S]*?>\s*([^<{]+?)\s*<\//.exec(joined) ??
      />\s*\n?\s*([^<{]+?)\s*\n?\s*<\//.exec(joined);
    if (m) text = (m[2] ?? m[1])!.trim();
  }
  if (!text || text.length > 64) return false;
  if (!PLACEHOLDER_TEXT_RE.test(` ${text} `)) return false;
  // Interactive children nearby under this host → real UI, not a bare host.
  const local = addedWindow(lines, dataIdx, 4)
    .map((l) => l.text)
    .join('\n')
    .replace(dataEvidenceLine, '');
  if (/<(?:button|input|select|textarea|a)\b/i.test(local)) {
    return false;
  }
  return true;
}

// globToRegExp / matchesProtectedPath live in domain/protectedPaths (shared with
// create/dispatch fail-fast so L5 and pre-dispatch cannot diverge).
