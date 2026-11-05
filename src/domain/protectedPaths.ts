/**
 * Protected-path policy helpers (L5 + fail-fast create/dispatch).
 *
 * Pure. Path matching shares the same glob semantics as Layer 5 anti-cheat
 * (`**` / `*` full-string match). Mentions are extracted only from explicit
 * path-like tokens in the **product brief** — never from machine-appended
 * `## Review packet` history (same cut spirit as `originalDescription`).
 *
 * Fail-fast vs L5 (two independent layers):
 * - **Fail-fast** parks create/dispatch when the product brief contains an
 *   explicit protected-path token that is *not* under a clear prohibit cue.
 *   That is the historic contract: naming a protected file is treated as an
 *   edit intent unless the local window proves otherwise.
 * - **Prohibitive mentions** (path named only to forbid editing it) are
 *   ignored when the local sentence/line (clipped at real sentence ends —
 *   not at `.` inside filenames) matches a fixed negation pattern list. We
 *   do **not** invent soft/fuzzy negation: if the prohibit cue is unclear
 *   or missing, the mention still counts for fail-fast.
 * - **L5 anti-cheat** is the independent backstop for *actual* protected-path
 *   diffs in the worktree, regardless of body wording (paths never named,
 *   named only to forbid, or slipped past fail-fast). Never weaken L5 to
 *   compensate for fail-fast policy.
 *
 * Prefer zero false-block from *prose noise* (packet logs, red-line forbids,
 * multi-path prohibit sentences that share one cue). Prefer not inventing
 * negation. Unclear prohibit → do not suppress → fail-fast still parks;
 * operator `force` or a body edit is the escape hatch.
 */

/** Label stamped when an operator forces create past the protected-path gate. */
export const FORCE_PROTECTED_PATH_LABEL = 'force-protected-path';

/** Body heading for the operator force audit record. */
export const FORCE_PROTECTED_PATH_HEADING = '## Operator force (protected-path)';

/**
 * Minimal glob → RegExp supporting `**`, `*` and literal segments.
 * Shared with L5 anti-cheat so create/dispatch and verify cannot diverge.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if ('.+^${}()|[]\\'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

/** True when `filePath` matches any entry in `protectedPaths` (L5 semantics). */
export function matchesProtectedPath(
  filePath: string,
  protectedPaths: readonly string[],
): boolean {
  if (protectedPaths.length === 0 || filePath.length === 0) return false;
  return protectedPaths.some((g) => globToRegExp(g).test(filePath));
}

/**
 * Extract explicit path-like mentions from a task body and return those that
 * match `protectedPaths`. Only backticks and clear relative path tokens —
 * does not guess "might touch".
 *
 * Scope (Req 0): only the product brief — cut at the first `## Review packet`
 * (same spirit as `originalDescription`). Packet / failure-log path literals
 * never count.
 *
 * Each occurrence is judged by nearest context: a path named only under a
 * negation/prohibit window is skipped; a later non-prohibitive occurrence of
 * the same path still counts as a hit.
 */
export function findProtectedPathMentions(
  taskBody: string,
  protectedPaths: readonly string[],
): readonly string[] {
  if (protectedPaths.length === 0 || taskBody.length === 0) return [];
  // Offsets must stay relative to the scanned slice (brief), not the full body.
  const brief = productBriefForFailFast(taskBody);
  if (brief.length === 0) return [];
  const occurrences = extractExplicitPathOccurrences(brief);
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const { token, start, end } of occurrences) {
    if (seen.has(token)) continue;
    if (!matchesProtectedPath(token, protectedPaths)) continue;
    if (isProhibitiveContext(brief, start, end)) continue;
    seen.add(token);
    hits.push(token);
  }
  return hits;
}

/**
 * Product brief only: text before the first `## Review packet` heading.
 * Machine-appended history (diff lists, park notes, agent reports) must not
 * re-trigger fail-fast — second production false positive, 2026-07-31.
 */
function productBriefForFailFast(body: string): string {
  const m = /^##\s+Review packet\b/im.exec(body);
  if (m && m.index !== undefined) {
    return body.slice(0, m.index);
  }
  return body;
}

/** Operator-facing block message (create reject + dispatch park). */
export function formatProtectedPathBlockMessage(paths: readonly string[]): string {
  const listed = paths.map((p) => `\`${p}\``).join(', ');
  return `该任务要求修改保护路径 ${listed} — 此类改动只能由人类完成`;
}

/** True when the task was explicitly forced past the protected-path create gate. */
export function hasForceProtectedPath(task: {
  readonly labels: readonly string[];
  readonly body: string;
}): boolean {
  if (task.labels.some((l) => l.toLowerCase() === FORCE_PROTECTED_PATH_LABEL)) {
    return true;
  }
  return task.body.includes(FORCE_PROTECTED_PATH_HEADING);
}

/** Append an audit section when create is forced despite protected mentions. */
export function stampForceProtectedPath(
  body: string,
  paths: readonly string[],
  at: string,
): string {
  const listed = paths.map((p) => `\`${p}\``).join(', ');
  const note =
    `\n\n${FORCE_PROTECTED_PATH_HEADING}\n\n` +
    `${at}: operator forced create despite protected path mention(s): ${listed}.\n`;
  return `${body.trimEnd()}${note}`;
}

// ── extraction (explicit only) ──────────────────────────────────────────────

/**
 * Path-like free token with a file extension and at least one `/`.
 * Higher bar than backticks to keep free-text false positives near zero.
 */
const FREE_PATH_TOKEN =
  /(?<![\w./-])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]+)(?![\w./-])/g;

/**
 * Negation / prohibit cues in the local window around a path mention.
 * English multi-word forms use word boundaries; Chinese is character-level.
 * Prefer zero false-block: only clear prohibit signals suppress a hit.
 */
const PROHIBIT_CONTEXT =
  /不得|不许|禁止|不是改|不要动|勿|绝不|不动|\bdo not\b|\bmust not\b|\bnever\b|\bforbidden\b/iu;

/**
 * Safety cap when a "sentence" has no terminator (huge unpunctuated body).
 * Large enough for multi-path forbid lists; not a hard semantic radius.
 */
const MAX_SENTENCE_CHARS = 200;

/**
 * Hard stops so adjacent sentences/lines do not bleed into each other.
 * Deliberately omits bare `.` — path tokens like `deploy-staging.sh` would
 * otherwise clip the window mid-sentence and strip a shared 不得修改 cue from
 * a later sibling path (multi-path forbid false positive).
 */
const SENTENCE_BOUNDARY = /[。！？!?\n\r]/u;

interface PathOccurrence {
  readonly token: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Local window = the sentence/line containing the path (Req 1: 路径所在句).
 * Sibling paths in one multi-path forbid share the same prohibit cue.
 * Adjacent sentences stay isolated so "不得改 A" does not suppress a later
 * "更新 B" on the next line.
 */
function localContextWindow(
  body: string,
  matchStart: number,
  matchEnd: number,
): string {
  let windowStart = 0;
  for (let i = matchStart - 1; i >= 0; i -= 1) {
    if (SENTENCE_BOUNDARY.test(body[i]!)) {
      windowStart = i + 1;
      break;
    }
    if (matchStart - i >= MAX_SENTENCE_CHARS) {
      windowStart = i;
      break;
    }
  }
  let windowEnd = body.length;
  for (let i = matchEnd; i < body.length; i += 1) {
    if (SENTENCE_BOUNDARY.test(body[i]!)) {
      windowEnd = i;
      break;
    }
    if (i - matchEnd >= MAX_SENTENCE_CHARS) {
      windowEnd = i;
      break;
    }
  }
  return body.slice(windowStart, windowEnd);
}

/**
 * True when the path occurrence sits in a prohibitive window (task forbids
 * touching the path rather than requesting an edit).
 *
 * Unclear / no pattern match → false (do not guess). A false here means
 * the mention still counts for fail-fast; L5 still catches real protected
 * edits even when fail-fast did not fire.
 */
function isProhibitiveContext(
  body: string,
  matchStart: number,
  matchEnd: number,
): boolean {
  if (matchStart < 0 || matchEnd > body.length || matchStart >= matchEnd) {
    return false;
  }
  return PROHIBIT_CONTEXT.test(localContextWindow(body, matchStart, matchEnd));
}

/**
 * All explicit path occurrences with body offsets (backticks first, then free
 * tokens). Repeated paths are kept so each can be judged by local context.
 */
function extractExplicitPathOccurrences(body: string): readonly PathOccurrence[] {
  const found: PathOccurrence[] = [];
  const covered = new Set<string>();

  // 1) Backtick-enclosed spans (preferred signal in DoD / Task prose).
  for (const m of body.matchAll(/`([^`\n]+)`/g)) {
    const raw = m[1]!;
    const normalized = normalizePathToken(raw);
    if (!normalized || !looksLikeExplicitPath(normalized)) continue;
    const full = m[0]!;
    const start = m.index ?? 0;
    const end = start + full.length;
    const key = `${start}:${end}`;
    if (covered.has(key)) continue;
    covered.add(key);
    found.push({ token: normalized, start, end });
  }

  // 2) Bare path-like tokens with extension (e.g. core/tests/foo.rs).
  for (const m of body.matchAll(FREE_PATH_TOKEN)) {
    const raw = m[1]!;
    const normalized = normalizePathToken(raw);
    if (!normalized || !looksLikeExplicitPath(normalized)) continue;
    const start = m.index ?? 0;
    const end = start + raw.length;
    // Skip if this free token already sits inside a backtick span we recorded.
    if (found.some((o) => start >= o.start && end <= o.end)) continue;
    found.push({ token: normalized, start, end });
  }

  // Stable document order (backticks may interleave with free tokens).
  found.sort((a, b) => a.start - b.start || a.end - b.end);
  return found;
}

function normalizePathToken(raw: string): string | null {
  let t = raw.trim();
  // Drop surrounding quotes and common trailing prose punctuation.
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    t = t.slice(1, -1).trim();
  }
  t = t.replace(/[.,;:!?)]+$/u, '');
  t = t.replace(/^\.\//, '');
  if (t.length === 0) return null;
  if (t.includes('://')) return null;
  if (t.startsWith('/') || t.startsWith('~')) return null;
  if (/^[A-Za-z]:[\\/]/.test(t)) return null;
  // Collapse accidental whitespace (should not appear in real paths).
  if (/\s/.test(t)) return null;
  return t;
}

/**
 * Relative repo path with at least one directory segment.
 * Bare filenames (`package.json`) are too ambiguous → skip (zero-FP bias).
 */
function looksLikeExplicitPath(t: string): boolean {
  if (!t.includes('/')) return false;
  if (t.includes('**') || t.includes('*')) return false;
  if (t.startsWith('@')) return false;
  // Allow only safe path charset.
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(t)) return false;
  return true;
}
