/**
 * Pure splitters for task body → collapsible phone sections (no React).
 *
 * Design: product brief vs harness trail; when a later Review packet exists,
 * earlier crashes / auto-rework / thrash are **prior audit** (collapsed, muted)
 * so the human judges the current verdict only.
 */
import {
  HARNESS_HEADING_LINE,
  isHarnessSectionTitle,
} from '../domain/taskBrief.js';
import { listHumanCriteriaTexts } from '../domain/acceptance.js';

export interface BodySection {
  readonly key: string;
  readonly title: string;
  readonly text: string;
  readonly kind: 'brief' | 'evidence' | 'meta' | 'harness';
}

/**
 * Critical L5 kinds that deserve red UI (silencing, skip/only, protected path,
 * false-delivery). Soft / L3-owned findings must not paint the section red.
 * Markers match packet.md (`🚨` critical / L3-cleared summaries).
 */
// Kind names joined at runtime so branch diffs do not self-flag L5 on kind tokens.
const CRITICAL_CHEAT_KINDS = [
  'eslint' + '-disable',
  'ts-ignore',
  'test-skip',
  'test-only',
  'as-any',
  'empty-catch',
  'protected-path',
  'false-delivery',
  'test-integrity',
].join('|');
const CRITICAL_CHEAT_KIND_RE = new RegExp('\\b(' + CRITICAL_CHEAT_KINDS + ')\\b', 'i');

/** True when packet says independent L3 already owns/cleared L5. */
export function antiCheatL3Cleared(text: string): boolean {
  // G4: unresolved critical kinds are never "cleared" by L3 approval alone.
  if (CRITICAL_CHEAT_KIND_RE.test(text) || /still fails mechanically/i.test(text)) {
    return false;
  }
  return (
    /Independent L3 scrutinized/i.test(text) ||
    /L3 scrutinized[\s\S]*approved/i.test(text) ||
    (/L3 owns this/i.test(text) && /approved/i.test(text))
  );
}

/** Tone for anti-cheat — red only for unresolved critical (not L3-cleared). */
export type SectionToneHint = 'danger' | 'warn' | 'muted' | 'default';

export function antiCheatSectionTone(text: string): SectionToneHint {
  if (antiCheatL3Cleared(text)) return 'muted';
  if (/auto-rework/i.test(text) && /L3 requested changes/i.test(text)) return 'warn';
  if (text.includes('🚨') || (CRITICAL_CHEAT_KIND_RE.test(text) && !/cleared by L3/i.test(text))) {
    return 'danger';
  }
  return 'muted';
}

/** Badge for anti-cheat disclosure. */
export function antiCheatBadge(text: string): string | undefined {
  if (antiCheatL3Cleared(text)) {
    const m = /(\d+)\s+critical\s*\+\s*(\d+)\s+review-only/i.exec(text);
    if (m) return `L3 ok · ${m[1]}c+${m[2]}r`;
    return 'L3 cleared';
  }
  if (/L3 requested changes/i.test(text)) return 'L3 rework';
  const lines = text.split('\n').filter((l) => /^\s*[-*]\s+/.test(l));
  if (lines.length === 0) {
    if (/test-edit\s*×\s*(\d+)/i.test(text)) {
      const n = /test-edit\s*×\s*(\d+)/i.exec(text)?.[1];
      return n ? `${n} → L3` : '→ L3';
    }
    return undefined;
  }
  let critical = 0;
  let review = 0;
  for (const l of lines) {
    if (/scrutinized|approved|see L3 summary|human need not/i.test(l)) continue;
    const grouped = /test-edit\s*×\s*(\d+)/i.exec(l);
    if (grouped) {
      review += Number(grouped[1]);
      continue;
    }
    if (l.includes('🚨') || CRITICAL_CHEAT_KIND_RE.test(l)) {
      critical += 1;
    } else if (/\btest-edit\b/i.test(l) || l.includes('ℹ️')) {
      review += 1;
    }
  }
  if (critical > 0 && review > 0) return `${critical} crit → L3`;
  if (critical > 0) return `${critical} crit → L3`;
  if (review > 0) return `${review} → L3`;
  return '→ L3';
}

/** Sections that are evidence dumps — collapsed by default unless "critical". */
export const EVIDENCE_TITLES = new Set([
  "agent's report",
  'agent report',
  'agent activity',
  'diff',
  'files touched',
  'behavioral evidence',
  'cli behavioral evidence',
  'anti-cheating flags',
  'cost',
  'cost (steer resume)',
  'cost (full implementer)',
  'evidence matrix',
  'l3 report',
]);

export const OPEN_TITLES = new Set([
  'definition of done',
  'evidence matrix',
  'reviewer',
  'reviewer (l3)',
  'gates',
  'behavioral evidence',
  'cli behavioral evidence',
  'cost (steer resume)',
  'cost (full implementer)',
]);

/** Max file lines to auto-expand "Files touched". */
export const SMALL_FILES_OPEN_MAX = 12;

/**
 * Audit-trail titles: prior attempts that must not compete with the live packet.
 * (Crashes, salvage, thrash, exhausted, recovery, old auto-rework, teardown.)
 */
export function isPriorAuditTitle(title: string): boolean {
  const t = title.toLowerCase().trim();
  return (
    t.startsWith('run failure') ||
    t.startsWith('run timeline') ||
    t.startsWith('salvage brief') ||
    t.startsWith('thrash brake') ||
    t.startsWith('attempts exhausted') ||
    t.startsWith('system recovery') ||
    t.startsWith('auto-rework') ||
    t.startsWith('teardown') ||
    t.startsWith('switch stop') ||
    t.startsWith('agent switch') ||
    t.startsWith('re-verify')
  );
}

/**
 * Split a task body into the human brief (before harness) and collapsible
 * packet/teardown sections for clearer mobile hierarchy.
 */
export function splitTaskBody(body: string): {
  readonly brief: string;
  readonly sections: readonly BodySection[];
} {
  const raw = body.trim();
  if (!raw) return { brief: '', sections: [] };

  const harnessAt = raw.search(HARNESS_HEADING_LINE);

  let brief = raw;
  let rest = '';
  if (harnessAt >= 0) {
    brief = raw.slice(0, harnessAt).trim();
    rest = raw.slice(harnessAt);
  }

  const sections = rest ? sectionize(rest) : [];
  return { brief, sections };
}

function sectionize(text: string): BodySection[] {
  const lines = text.split('\n');
  const sections: BodySection[] = [];
  let curTitle = 'Overview';
  let cur: string[] = [];
  let key = 0;

  const flush = (): void => {
    const t = cur.join('\n').trim();
    if (!t) return;
    const title = curTitle;
    const kind = classify(title);
    sections.push({ key: `s${key++}`, title, text: t, kind });
    cur = [];
  };

  for (const line of lines) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      flush();
      curTitle = h2[1]!.trim();
      continue;
    }
    const bold = /^\*\*([^*]+)\*\*(?:\s*\*[^*]*\*)?\s*$/.exec(line);
    if (bold) {
      const title = bold[1]!.replace(/:\s*$/, '').trim();
      const statusLead =
        title.startsWith('✅') ||
        title.startsWith('⚠️') ||
        title.startsWith('🔄') ||
        title.startsWith('ℹ️') ||
        title.startsWith('💵') ||
        title.startsWith('💰') ||
        title.startsWith('L3 not run');
      if (!statusLead && title.length < 80) {
        flush();
        curTitle = title;
        continue;
      }
    }
    const h3 = /^###\s+(.+?)\s*$/.exec(line);
    if (h3 && sections.length === 0 && curTitle === 'Overview') {
      cur.push(line);
      continue;
    }
    cur.push(line);
  }
  flush();
  return sections;
}

export function classify(title: string): BodySection['kind'] {
  if (isHarnessSectionTitle(title)) return 'harness';
  const t = title.toLowerCase();
  if (isPriorAuditTitle(title)) return 'harness';
  if (
    t.startsWith('reviewer') ||
    t.includes('definition of done') ||
    t === 'gates' ||
    t.includes('evidence matrix')
  ) {
    return 'brief';
  }
  if (
    EVIDENCE_TITLES.has(t) ||
    t.includes('diff') ||
    t.includes('activity') ||
    t.includes('files') ||
    t.startsWith('cost')
  ) {
    return 'evidence';
  }
  if (t.includes('steer') || t.includes('teardown') || t.includes('auto-rework') || t.includes('cost')) {
    return 'meta';
  }
  return 'brief';
}

/** True when this section is a human follow-up or the agent's reply to one. */
export function isSteerTrail(title: string): boolean {
  const t = title.toLowerCase();
  return t.startsWith('human steer') || t.startsWith('steer result');
}

/** True when body already has a review packet (later success after prior crashes). */
export function bodyHasReviewPacket(body: string): boolean {
  return /##\s+Review packet\b/i.test(body);
}

/** Prose kind emitted by `renderPacketMarkdown` provenance fences. */
export type PacketProseKind = 'report' | 'self-assessment' | 'reviewer';

export interface PacketProseSpan {
  readonly kind: PacketProseKind;
  /** Unfenced prose text (HTML comment openers already neutralized at render). */
  readonly text: string;
}

/**
 * Structural provenance for the latest review packet.
 *
 * **Authoritative** (a whole-line `<!-- hercules:packet v1 nonce=<hex> -->`
 * exists anywhere in the body): that LAST header fence is the sole authority.
 * Render-time neutralization guarantees agent text cannot emit a real header
 * fence, so the fence — not the agent-influenceable `## Review packet` heading
 * — locates the packet. `region` ends at the matching `packet-end` (or the next
 * whole-line header fence, or EOF). `scan` is the region with matching-nonce
 * prose spans removed (unclosed spans stay prose — fail closed).
 *
 * **Legacy** (no header fence anywhere): unchanged hardened heuristics on the
 * last `## Review packet` heading via {@link latestReviewPacketRegion}.
 */
export interface PacketProvenance {
  readonly legacy: boolean;
  readonly nonce: string | null;
  readonly region: string;
  readonly scan: string;
  readonly prose: readonly PacketProseSpan[];
  /** True when a matching-nonce prose span had no end fence (tampered/truncated body). */
  readonly truncatedProse?: boolean;
  /**
   * When the DTO supplied a 32-hex nonce that is absent from the body
   * (`nonce_missing`), or the DTO explicitly recorded no current packet
   * (`nonce_absent` — `opts.nonce === null`) while the body still contains a
   * whole-line header fence, parsers return a legacy-shaped result with this
   * reason. Verdict readers treat both as NOT green / NOT crashed (chip null,
   * media [], report null) — never `tampered` / 包结构异常.
   */
  readonly reason?: 'nonce_missing' | 'nonce_absent';
  /**
   * True when packet structure is ambiguous (multiple whole-line header fences
   * without a DTO nonce, or the DTO nonce fence appears more than once).
   * Verdict readers treat as NOT green / NOT crashed; owned status is empty.
   */
  readonly tampered?: boolean;
}

/**
 * Optional packet locator from Hercules-owned task metadata.
 *
 * - `nonce` omitted / `undefined` — caller has no metadata (body-only tools);
 *   a single whole-line header fence is authoritative (legacy multi-fence →
 *   tampered).
 * - `nonce: null` — the task DTO says Hercules recorded no current packet;
 *   any whole-line header fence is non-authoritative (`reason: 'nonce_absent'`).
 * - `nonce: <32-hex>` — locate that exact fence; missing → `nonce_missing`.
 */
export interface PacketNonceOpts {
  readonly nonce?: string | null;
}

/** True when provenance failed closed on DTO nonce mismatch / explicit absence. */
function isNonceReasonFailClosed(
  prov: PacketProvenance | null | undefined,
): boolean {
  return prov?.reason === 'nonce_missing' || prov?.reason === 'nonce_absent';
}

const PACKET_NONCE_HEX_RE = /^[0-9a-fA-F]{32}$/;

function isPacketNonce(value: string | null | undefined): value is string {
  return typeof value === 'string' && PACKET_NONCE_HEX_RE.test(value);
}

// Whole-line only: a status line polluted with a header-looking comment must
// not flip a legacy body into authoritative mode (Grok R13 N5).
const PACKET_V1_HEADER_RE =
  /^\s*<!--\s*hercules:packet\s+v1\s+nonce=([0-9a-fA-F]+)\s*-->\s*$/;
const PROSE_BEGIN_LINE_RE =
  /^(\s*<!--\s*hercules:prose-begin\s+kind=(report|self-assessment|reviewer)\s+nonce=([0-9a-fA-F]+)\s*-->\s*)$/;
const PROSE_END_LINE_RE =
  /^(\s*<!--\s*hercules:prose-end\s+nonce=([0-9a-fA-F]+)\s*-->\s*)$/;
const REVIEW_PACKET_HEADING_LINE_RE = /^##\s+Review packet\b/i;
const PACKET_TASK_LINE_RE = /^###\s+\S/;

/**
 * Hercules-owned status line text for an authoritative packet: lines between
 * the header fence and the first `## 决策摘要` inside {@link PacketProvenance.scan}.
 */
export function packetOwnedStatusText(prov: PacketProvenance): string {
  if (prov.legacy) return prov.scan;
  // Ambiguous / multi-fence structure — never expose a spoofable status line.
  if (prov.tampered) return '';
  const lines = prov.scan.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (PACKET_V1_HEADER_RE.test(lines[i]!)) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return '';
  const out: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    // No \b — JS word boundaries do not treat CJK as word chars.
    if (/^##\s+决策摘要/.test(lines[i]!)) break;
    out.push(lines[i]!);
  }
  return out.join('\n');
}

function stripMatchingNonceProse(
  region: string,
  headerNonce: string,
): {
  readonly scan: string;
  readonly prose: PacketProseSpan[];
  readonly truncatedProse: boolean;
} {
  const prose: PacketProseSpan[] = [];
  const scanLines: string[] = [];
  let truncatedProse = false;
  const regionLines = region.split('\n');
  let i = 0;
  while (i < regionLines.length) {
    const line = regionLines[i]!;
    const begin = PROSE_BEGIN_LINE_RE.exec(line);
    if (begin && begin[3] === headerNonce) {
      const kind = begin[2] as PacketProseKind;
      const content: string[] = [];
      i += 1;
      let closed = false;
      while (i < regionLines.length) {
        const end = PROSE_END_LINE_RE.exec(regionLines[i]!);
        if (end && end[2] === headerNonce) {
          closed = true;
          i += 1;
          break;
        }
        content.push(regionLines[i]!);
        i += 1;
      }
      // Closed or not, everything after a matching-nonce prose-begin is prose:
      // an unclosed span (post-render truncation / tamper) must fail CLOSED —
      // never let its content back into the Hercules-owned scan (Grok R13 N1).
      prose.push({ kind, text: content.join('\n') });
      if (!closed) truncatedProse = true;
      continue;
    }
    scanLines.push(line);
    i += 1;
  }
  return { scan: scanLines.join('\n'), prose, truncatedProse };
}

function buildAuthoritativeProvenance(
  allLines: readonly string[],
  headerLineIdx: number,
  headerNonce: string,
  extra?: { readonly tampered?: boolean },
): PacketProvenance {
  // Find the fenced ### task line immediately preceding the header (skip blanks).
  let hashTaskIdx = -1;
  for (let i = headerLineIdx - 1; i >= 0; i -= 1) {
    const line = allLines[i]!;
    if (line.trim() === '') continue;
    if (PACKET_TASK_LINE_RE.test(line)) {
      hashTaskIdx = i;
    }
    break;
  }

  // Region START: nearest ## Review packet within two lines before ###, else ###
  // (else the header fence itself when ### is missing).
  let startLineIdx = hashTaskIdx >= 0 ? hashTaskIdx : headerLineIdx;
  if (hashTaskIdx >= 0) {
    const lookFrom = Math.max(0, hashTaskIdx - 2);
    for (let i = hashTaskIdx - 1; i >= lookFrom; i -= 1) {
      if (REVIEW_PACKET_HEADING_LINE_RE.test(allLines[i]!)) {
        startLineIdx = i;
        break;
      }
    }
  }

  // Region END: matching packet-end, else next whole-line header fence, else
  // next POST_PACKET_H2 trail heading (truncated body without packet-end must
  // not let trail media leak into the scan), else EOF.
  let endLineIdxExclusive = allLines.length;
  let foundPacketEnd = false;
  const endFenceRe = new RegExp(
    `^\\s*<!--\\s*hercules:packet-end\\s+nonce=${headerNonce}\\s*-->\\s*$`,
  );
  for (let i = headerLineIdx + 1; i < allLines.length; i += 1) {
    if (endFenceRe.test(allLines[i]!)) {
      endLineIdxExclusive = i + 1;
      foundPacketEnd = true;
      break;
    }
    if (PACKET_V1_HEADER_RE.test(allLines[i]!)) {
      endLineIdxExclusive = i;
      break;
    }
  }
  if (!foundPacketEnd && endLineIdxExclusive === allLines.length) {
    for (let i = headerLineIdx + 1; i < allLines.length; i += 1) {
      const h2 = /^##\s+(.+?)\s*$/.exec(allLines[i]!);
      if (!h2) continue;
      const title = h2[1] ?? '';
      if (isPostPacketH2(title)) {
        endLineIdxExclusive = i;
        break;
      }
    }
  }

  const region = allLines.slice(startLineIdx, endLineIdxExclusive).join('\n');
  const stripped = stripMatchingNonceProse(region, headerNonce);
  return {
    legacy: false,
    nonce: headerNonce,
    region,
    scan: stripped.scan,
    prose: stripped.prose,
    truncatedProse: stripped.truncatedProse,
    ...(extra?.tampered ? { tampered: true } : {}),
  };
}

function buildTamperedEmptyProvenance(): PacketProvenance {
  return {
    legacy: false,
    tampered: true,
    nonce: null,
    region: '',
    scan: '',
    prose: [],
  };
}

function buildLegacyProvenance(
  body: string,
  extra?: {
    readonly reason?: 'nonce_missing' | 'nonce_absent';
    readonly nonce?: string | null;
  },
): PacketProvenance | null {
  const region = latestReviewPacketRegion(body);
  if (!region) {
    if (extra?.reason === 'nonce_missing' || extra?.reason === 'nonce_absent') {
      // DTO nonce absent / explicitly null and no legacy heading — empty fail-closed.
      return {
        legacy: true,
        nonce: extra.nonce ?? null,
        region: '',
        scan: '',
        prose: [],
        reason: extra.reason,
      };
    }
    return null;
  }
  return {
    legacy: true,
    nonce: extra?.nonce ?? null,
    region,
    scan: region,
    prose: [],
    ...(extra?.reason !== undefined ? { reason: extra.reason } : {}),
  };
}

/**
 * Locate the latest review packet's provenance.
 *
 * When `opts.nonce` is a 32-hex string, the packet is located by the whole-line
 * header fence carrying EXACTLY that nonce (other fences ignored). If that
 * fence is missing → `reason: 'nonce_missing'`. If it appears more than once →
 * `tampered: true` with empty owned status.
 *
 * When `opts.nonce` is explicitly `null` (DTO: Hercules recorded no current
 * packet): ANY whole-line header fence is non-authoritative → legacy-shaped
 * `reason: 'nonce_absent'` (readers treat like `nonce_missing`). No fence →
 * legacy `## Review packet` heuristics (pre-fence corpus).
 *
 * When `opts.nonce` is absent/`undefined` (body-only tools): a single
 * whole-line header fence is authoritative; MORE THAN ONE → fail closed
 * (`tampered: true`). Else legacy `## Review packet`.
 *
 * Returns null when the body has neither a whole-line header fence nor a
 * `## Review packet` heading (and no nonce_missing / nonce_absent empty result).
 */
export function packetProvenance(
  body: string,
  opts?: PacketNonceOpts,
): PacketProvenance | null {
  const allLines = body.split('\n');

  // Explicit null: Hercules recorded no current packet — fences are not authority.
  // Metadata callers: a nonce that is not 32-hex (empty / corrupt frontmatter)
  // must behave like "no current packet" — never fall through to the
  // body-only single-fence rule (Grok R16 N1).
  const explicitNull =
    opts?.nonce !== undefined && !isPacketNonce(opts.nonce);
  if (explicitNull) {
    let hasFence = false;
    for (let i = 0; i < allLines.length; i += 1) {
      if (PACKET_V1_HEADER_RE.test(allLines[i]!)) {
        hasFence = true;
        break;
      }
    }
    if (hasFence) {
      return buildLegacyProvenance(body, {
        reason: 'nonce_absent',
        nonce: null,
      });
    }
    // Pre-fence / heading-only corpus — unchanged legacy heuristics.
    return buildLegacyProvenance(body);
  }

  const metaNonce = isPacketNonce(opts?.nonce) ? opts.nonce : null;

  if (metaNonce !== null) {
    // Metadata nonce: only fences carrying EXACTLY that nonce count.
    const matchIdxs: number[] = [];
    for (let i = 0; i < allLines.length; i += 1) {
      const hm = PACKET_V1_HEADER_RE.exec(allLines[i]!);
      if (hm && hm[1] === metaNonce) matchIdxs.push(i);
    }
    if (matchIdxs.length === 0) {
      return buildLegacyProvenance(body, {
        reason: 'nonce_missing',
        nonce: metaNonce,
      });
    }
    if (matchIdxs.length > 1) {
      // Same nonce twice → ambiguous; fail closed.
      return buildTamperedEmptyProvenance();
    }
    return buildAuthoritativeProvenance(allLines, matchIdxs[0]!, metaNonce);
  }

  // No metadata nonce (undefined): collect every whole-line header fence.
  const headers: { idx: number; nonce: string }[] = [];
  for (let i = 0; i < allLines.length; i += 1) {
    const hm = PACKET_V1_HEADER_RE.exec(allLines[i]!);
    if (hm && hm[1]) headers.push({ idx: i, nonce: hm[1] });
  }

  if (headers.length > 1) {
    // Ambiguous without DTO nonce — fail closed (not green / not crashed).
    return buildTamperedEmptyProvenance();
  }

  if (headers.length === 1) {
    return buildAuthoritativeProvenance(allLines, headers[0]!.idx, headers[0]!.nonce);
  }

  // Legacy: no header fence anywhere — harden on the last ## Review packet.
  return buildLegacyProvenance(body);
}

/** Scan text of the latest packet (prose stripped when authoritative). */
export function packetScanText(
  body: string,
  opts?: PacketNonceOpts,
): string | null {
  const prov = packetProvenance(body, opts);
  if (!prov || isNonceReasonFailClosed(prov) || prov.tampered) return null;
  return prov.scan;
}

/** True when latest packet is a successful automated proof (not auto-rework). */
export function bodyHasSuccessfulPacket(
  body: string,
  opts?: PacketNonceOpts,
): boolean {
  // Authoritative: Hercules-owned status line only (between header fence and
  // ## 决策摘要). Legacy: header slice only — agent prose in the wider region
  // can spoof. nonce_missing / nonce_absent / tampered → never green.
  const prov = packetProvenance(body, opts);
  if (!prov || isNonceReasonFailClosed(prov) || prov.tampered) return false;
  const scope = prov.legacy
    ? (latestReviewPacketSlice(body) ?? prov.scan)
    : packetOwnedStatusText(prov);
  return (
    /automated proof complete/i.test(scope) ||
    /\*\*✅ all checks green\*\*/i.test(scope)
  );
}

/**
 * True when body has prior-attempt audit (crashes, salvage, thrash, old rework…).
 */
export function bodyHasPriorRunFailures(
  body: string,
  opts?: PacketNonceOpts,
): boolean {
  // Whole-line headings only — mid-line mentions must not count as audit.
  return (
    /^##\s+Run failure\b/im.test(body) ||
    /^##\s+Salvage brief\b/im.test(body) ||
    /^##\s+Thrash brake\b/im.test(body) ||
    /^##\s+Attempts exhausted\b/im.test(body) ||
    /^##\s+System recovery\b/im.test(body) ||
    // Auto-rework after a later green packet is historical noise.
    (/^##\s+Auto-rework\b/im.test(body) && bodyHasSuccessfulPacket(body, opts))
  );
}

/** Slice of the **last** ## Review packet … next ## (or EOF) for verdict chips. */
export function latestReviewPacketSlice(body: string): string | null {
  // Whole-line only — mid-line "see ## Review packet" must not re-anchor.
  const re = /^##\s+Review packet\b/gim;
  let last = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) last = m.index;
  if (last < 0) return null;
  const from = body.slice(last);
  const nl = from.indexOf('\n');
  const rest = nl >= 0 ? from.slice(nl + 1) : '';
  const nextH = /^##\s+/m.exec(rest);
  if (nextH && nextH.index !== undefined) {
    return from.slice(0, (nl >= 0 ? nl + 1 : 0) + nextH.index);
  }
  return from;
}

/**
 * `## ` stems Hercules itself appends to a task body *after* a review packet
 * (trail / audit / ops). Headings inside embedded agent prose (final report,
 * self-assessment, fenced code) are NOT in this list and never end the region.
 *
 * **Legacy best-effort only.** Authoritative packets carry
 * `<!-- hercules:packet v1 nonce=… -->` / `hercules:packet-end` fences; parsers
 * use those bounds and ignore this list. Keep this list for bodies rendered
 * before provenance fences existed.
 *
 * Emitter citations (stem → source that writes `## <stem>…` into a task body):
 * - Teardown → `src/verification/teardownReport.ts`
 * - Human steer → `src/domain/chatDelivery.ts`, `src/orchestrator/orchestrator.ts`
 * - Steer result → `src/orchestrator/orchestrator.ts` (`appendSteerResult`)
 * - Run failure → `src/domain/runFailure.ts`
 * - Salvage brief → `src/domain/salvage.ts`, `src/domain/runFailure.ts`
 * - Thrash brake → `src/domain/thrash.ts`, `factoryConflict` / `factoryBehind` / `factoryCi`
 * - Auto-rework / Attempts exhausted → `src/orchestrator/orchestrator.ts`
 * - System recovery → historical harness (`taskBrief` HARNESS / prior bodies; no live emitter)
 * - Cost cap → `src/domain/costCaps.ts`
 * - Clean salvage provenance → `src/domain/salvage.ts`
 * - Switch stop / Pending human steer / Host operation replay blocked /
 *   Dependency preflight recovery hold / Adapter failover / Adapter start blocked
 *   → `src/orchestrator/orchestrator.ts`
 * - Agent switch / Re-verify / Operator override / System steer / Pipeline
 *   → `src/orchestrator/actions.ts`
 * - Auto-merge → `src/domain/autoMerge.ts`
 * - Merge failure → `src/orchestrator/mergeService.ts`
 * - Merge failure diagnostic → `src/domain/mergeFailureReceipt.ts`
 * - ALERT → `src/orchestrator/promoteService.ts`
 * - Session abandoned → `src/domain/agentDeath.ts`
 * - From Remote Control → `src/sessions/store.ts`
 * - Factory PR → `src/domain/factoryDraft|Merge|Behind|Conflict.ts`
 * - Self-heal → `src/domain/runFinalize.ts`
 * - Run timeline → `src/domain/runTimeline.ts`
 * - Provision blocked → `src/domain/provisionNote.ts`
 * - Mirror branch → `src/domain/mirrorFetch.ts`
 * - Proposed graph → `src/domain/proposedGraphPacket.ts`
 * - Provider session recovery → `src/orchestrator/orchestrator.ts`
 * - Reviewer infrastructure recovery → `src/domain/reviewerInfrastructure.ts`
 * - Path-lease scope blocked → `src/orchestrator/orchestrator.ts`
 * - Protected path (pre-dispatch) → `src/orchestrator/orchestrator.ts`
 * - Execution policy blocked (pre-dispatch) → `src/orchestrator/orchestrator.ts`
 * - Adapter capability receipt → `src/domain/repoExecutionPolicy.ts`
 * - Path lease owner bind blocked → `src/orchestrator/orchestrator.ts`
 * - Finalize skipped state write → `src/orchestrator/orchestrator.ts`
 * - Path lease blocked (pre-dispatch) → `src/orchestrator/pathLeasePark.ts`
 * - Cancellation audit → `src/domain/cancellationAudit.ts`
 * - Task-ref ownership → `src/domain/taskRefPublication.ts`
 * - Host operation approval → `src/domain/executionClass.ts`
 * - Host execution started → `src/domain/hostExecutor.ts`
 * - Project-state closure → `src/domain/projectStateClosure.ts`
 * - Platform remediation → `src/domain/platformRemediation.ts`
 * - Bootstrap escalation (platform-external rescue) → `src/domain/platformRemediation.ts`
 *
 * Packet-internal h2s (`决策摘要`, Host operation receipt, CLI behavioral
 * evidence) are deliberately absent — they belong inside the region.
 */
export const POST_PACKET_H2_HEADINGS = [
  'Teardown',
  'Human steer',
  'Steer result',
  'Run failure',
  'Salvage brief',
  'Thrash brake',
  'Auto-rework',
  'Attempts exhausted',
  'System recovery',
  'Cost cap',
  'Clean salvage provenance',
  'Switch stop',
  'Agent switch',
  'Re-verify',
  'Pending human steer',
  'Host operation replay blocked',
  'Dependency preflight recovery hold',
  'Adapter failover',
  'Adapter start blocked',
  'Operator override',
  'Auto-merge',
  'Merge failure',
  'ALERT',
  'Session abandoned',
  'From Remote Control',
  'Factory PR',
  'System steer',
  'Self-heal',
  'Run timeline',
  'Provision blocked',
  'Mirror branch',
  'Pipeline',
  'Proposed graph',
  'Provider session recovery',
  'Reviewer infrastructure recovery',
  'Path-lease scope blocked',
  'Protected path (pre-dispatch)',
  'Execution policy blocked (pre-dispatch)',
  'Adapter capability receipt',
  'Path lease owner bind blocked',
  'Finalize skipped state write',
  'Path lease blocked (pre-dispatch)',
  'Cancellation audit',
  'Task-ref ownership',
  'Host operation approval',
  'Host execution started',
  'Project-state closure',
  'Platform remediation',
  'Bootstrap escalation (platform-external rescue)',
] as const;

/**
 * True when an h2 title is a known post-packet / trail heading.
 * Exact stem, stem + ` (advisory)` (e.g. `Proposed graph (advisory)`), or
 * stem + ` (` … with an ISO date `\d{4}-\d{2}-\d{2}` (stamped forms). Never
 * bare words (`Pipeline implementation`) or other non-date parens
 * (`Cost cap (design)`, `Pipeline(foo)`).
 */
export function isPostPacketH2(title: string): boolean {
  const t = title.trim();
  if (t.length === 0) return false;
  const lower = t.toLowerCase();
  return POST_PACKET_H2_HEADINGS.some((h) => {
    const hl = h.toLowerCase();
    if (lower === hl) return true;
    if (!lower.startsWith(hl)) return false;
    const rest = lower.slice(hl.length);
    // Require " (" (space + paren) — rejects `Pipeline(foo)`.
    if (!rest.startsWith(' (')) return false;
    // Fixed advisory suffix used by proposed-graph packets.
    if (rest === ' (advisory)') return true;
    // Stamped forms must carry an ISO date somewhere in the paren trail.
    return /\(\d{4}-\d{2}-\d{2}/.test(rest);
  });
}

/**
 * From the LAST `## Review packet` to the earliest of: the next
 * `## Review packet`, the next {@link POST_PACKET_H2_HEADINGS} trail heading,
 * or EOF. Embedded `## ` inside agent prose never ends the region.
 */
export function latestReviewPacketRegion(body: string): string | null {
  // Whole-line only — mid-line "see ## Review packet" must not re-anchor.
  const re = /^##\s+Review packet\b/gim;
  let last = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) last = m.index;
  if (last < 0) return null;
  const from = body.slice(last);
  const nl = from.indexOf('\n');
  const rest = nl >= 0 ? from.slice(nl + 1) : '';
  const h2Re = /^##\s+(.+?)\s*$/gm;
  let hm: RegExpExecArray | null;
  while ((hm = h2Re.exec(rest)) !== null) {
    const title = hm[1] ?? '';
    if (/^Review packet\b/i.test(title.trim()) || isPostPacketH2(title)) {
      return from.slice(0, (nl >= 0 ? nl + 1 : 0) + hm.index);
    }
  }
  return from;
}

/**
 * Partition sections: live verdict first, prior audit trail last.
 * When a Review packet exists, crash/salvage/thrash/recovery/old rework go to prior.
 */
export function partitionSectionsForDisplay(
  sections: readonly BodySection[],
  ctx: { readonly hasReviewPacket: boolean; readonly hasSuccessfulPacket: boolean },
): {
  readonly live: readonly BodySection[];
  readonly prior: readonly BodySection[];
} {
  if (!ctx.hasReviewPacket) {
    // Failed sheet — everything is "live".
    return { live: sections, prior: [] };
  }
  const live: BodySection[] = [];
  const prior: BodySection[] = [];
  for (const s of sections) {
    const t = s.title.toLowerCase();
    if (t.startsWith('auto-rework')) {
      (ctx.hasSuccessfulPacket ? prior : live).push(s);
      continue;
    }
    if (isPriorAuditTitle(s.title)) {
      prior.push(s);
      continue;
    }
    live.push(s);
  }
  return { live, prior };
}

export interface SectionOpenContext {
  readonly hasReviewPacket?: boolean;
  readonly hasSuccessfulPacket?: boolean;
  /** Index of this section among steer-trail sections (0 = oldest). */
  readonly steerIndex?: number;
  readonly steerCount?: number;
}

/**
 * Whether a packet section should start open on phone.
 */
export function sectionDefaultOpen(
  section: BodySection,
  ctx?: SectionOpenContext,
): boolean {
  const t = section.title.toLowerCase();
  const hasPacket = ctx?.hasReviewPacket === true;
  const success = ctx?.hasSuccessfulPacket === true;

  // Prior audit under a packet: always collapsed.
  if (hasPacket && isPriorAuditTitle(section.title)) {
    if (t.startsWith('auto-rework') && !success) {
      // Current rework note after a failing packet — keep open.
      return true;
    }
    return false;
  }

  // Failed sheet: open crash/salvage so the sheet is not blank.
  if (
    t.startsWith('run failure') ||
    t.startsWith('salvage brief') ||
    t.startsWith('clean salvage provenance') ||
    t.startsWith('thrash brake')
  ) {
    return true;
  }

  // Auto-rework after fail packet: open; otherwise closed.
  if (t.startsWith('auto-rework')) return !success;

  // Only the **latest** steer pair opens (older RC turns are audit).
  if (t.startsWith('steer result') || t.startsWith('human steer')) {
    const n = ctx?.steerCount ?? 1;
    const i = ctx?.steerIndex ?? Math.max(0, n - 1);
    // Last two trail items ≈ one Human steer + Steer result pair.
    return n <= 2 ? true : i >= n - 2;
  }

  if (section.kind === 'harness' || t.includes('system recovery')) return false;
  if (OPEN_TITLES.has(t) || t.startsWith('reviewer')) return true;
  if (t === 'review packet' || t === 'overview') return true;
  if (t.startsWith('cost')) return true;
  if (t.includes('behavioral evidence')) return true;
  if (t.includes('evidence matrix')) return true;
  if (t.includes('anti-cheat')) return false;
  if (t.includes('self-assessment')) return false;
  if (t.includes('files touched') || t === 'files touched') {
    const n = section.text.split('\n').filter((l) => /^\s*-\s+/.test(l)).length;
    return n > 0 && n <= SMALL_FILES_OPEN_MAX;
  }
  if (t.includes('full diff on github') || t.includes('diff summary')) return true;
  if (section.kind === 'evidence') return false;
  if (t.includes('steer') || t.includes('teardown')) return false;
  return section.kind === 'brief';
}

/**
 * PR thrash banner: only when thrash is still the newest system note
 * (not superseded by a later green automated proof).
 */
export function thrashBrakeStillActive(
  body: string,
  opts?: PacketNonceOpts,
): boolean {
  // No \b after `)` — JS word-boundary does not match after a paren.
  // Whole-line only — mid-line thrash mentions must not activate the banner.
  const thrash = body.search(/^##\s+Thrash brake \(pr-mergeable\)/im);
  if (thrash < 0) return false;
  const after = body.slice(thrash);
  // A re-verify after thrash rewrites ## Review packet earlier in the file,
  // but also may append; if automated proof appears after thrash, thrash is stale.
  if (/automated proof complete/i.test(after) || /\*\*✅ all checks green\*\*/i.test(after)) {
    return false;
  }
  // Latest packet slice is green and thrash is only historical text before it.
  if (bodyHasSuccessfulPacket(body, opts)) {
    const packetRe = /^##\s+Review packet\b/gim;
    let sliceStart = -1;
    let m: RegExpExecArray | null;
    while ((m = packetRe.exec(body)) !== null) sliceStart = m.index;
    if (sliceStart > thrash) return false;
  }
  return true;
}

/** Parse a compact status chip from the **latest** review packet only. */
export function packetStatusChip(
  body: string,
  opts?: PacketNonceOpts,
): { label: string; tone: string } | null {
  const prov = packetProvenance(body, opts);

  // No packet: crash trail is the verdict.
  if (!prov) {
    if (/##\s+Run failure\b/i.test(body)) {
      if (/\*\*Thrash:\*\*/i.test(body)) return { label: 'Thrash · parked', tone: 'danger' };
      if (/Kind:\s*`stall`/i.test(body)) return { label: 'Stalled · no packet', tone: 'danger' };
      if (/Kind:\s*`provision`/i.test(body)) return { label: 'Provision fail', tone: 'danger' };
      return { label: 'Agent crashed · no packet', tone: 'danger' };
    }
    if (/##\s+Thrash brake \(pr-mergeable\)/i.test(body) && thrashBrakeStillActive(body)) {
      return { label: 'PR thrash · human', tone: 'warn' };
    }
    if (/##\s+Salvage brief\b/i.test(body)) {
      return { label: 'Failed · see salvage', tone: 'danger' };
    }
    return null;
  }

  // DTO nonce absent / explicitly null with residual fences → not green, not
  // crashed; mechanical/empty only (never 包结构异常).
  if (isNonceReasonFailClosed(prov)) {
    return null;
  }

  // Multiple header fences without a resolving DTO nonce (or duplicate DTO fence).
  if (prov.tampered) {
    return { label: '包结构异常', tone: 'danger' };
  }

  // Verdict / crash / success: authoritative → status line only; legacy → header slice.
  const verdictScope = prov.legacy
    ? (latestReviewPacketSlice(body) ?? prov.scan)
    : packetOwnedStatusText(prov);
  // Region fallback (No file changes banner lives after ## 决策摘要).
  const regionScope = prov.scan;

  if (isVerificationInfraFailure(body, opts)) {
    if (/Verification failed:|Verification infrastructure failed/i.test(verdictScope)) {
      return { label: 'Verify crashed', tone: 'danger' };
    }
  }

  // Packet exists — judge Hercules-owned verdict text only.
  if (/Verification failed:|Verification infrastructure failed/i.test(verdictScope)) {
    return { label: 'Verify crashed', tone: 'danger' };
  }
  if (/automated proof complete/i.test(verdictScope)) {
    return { label: 'Auto OK · human pending', tone: 'success' };
  }
  if (/\*\*✅ all checks green\*\*/i.test(verdictScope)) {
    return { label: 'All green', tone: 'success' };
  }
  if (/auto-rework \(steer\)/i.test(verdictScope)) {
    return { label: 'Auto-rework · steer', tone: 'warn' };
  }
  if (/auto-rework \(full\)/i.test(verdictScope)) {
    return { label: 'Auto-rework · full', tone: 'danger' };
  }
  if (/auto-rework/i.test(verdictScope) || /🔄 auto-rework/i.test(verdictScope)) {
    return { label: 'Auto-rework', tone: 'danger' };
  }
  if (/No file changes/i.test(regionScope)) {
    return { label: 'No file changes', tone: 'muted' };
  }
  if (thrashBrakeStillActive(body)) {
    return { label: 'PR thrash · human', tone: 'warn' };
  }
  return { label: 'Needs review', tone: 'warn' };
}

/**
 * Cost + run-kind chip for the sheet hero — uses **latest** packet cost block.
 */
export function packetCostChip(
  body: string,
  opts?: PacketNonceOpts,
): {
  label: string;
  tone: 'steer' | 'full' | 'muted';
  kind: 'steer' | 'implementer' | 'unknown';
  amount: string | null;
} | null {
  // No usable packet scan (absent / nonce_missing / nonce_absent / tampered) →
  // never fall back to the whole body (forged Cost lines in stderr / receipts).
  const scope = packetScanText(body, opts);
  if (scope === null) return null;
  if (!/^##\s+Review packet\b/im.test(body) && !/\*\*Cost/i.test(scope)) return null;

  const steerCost = /\*\*Cost \(steer resume\)\*\*/i.test(scope);
  const fullCost = /\*\*Cost \(full implementer\)\*\*/i.test(scope);
  const dollar =
    /(?:💵\s*\*\*Steer turn\*\*|💰\s*\*\*Full run\*\*|Cost:)\s*\$([0-9]+(?:\.[0-9]+)?)/i.exec(
      scope,
    ) ?? /\$([0-9]+(?:\.[0-9]+)?)\s*·/.exec(scope);

  if (steerCost) {
    const amt = dollar?.[1] ?? null;
    return {
      label: amt ? `Steer $${amt}` : 'Steer turn',
      tone: 'steer',
      kind: 'steer',
      amount: amt,
    };
  }
  if (fullCost) {
    const amt = dollar?.[1] ?? null;
    return {
      label: amt ? `Full run $${amt}` : 'Full run',
      tone: 'full',
      kind: 'implementer',
      amount: amt,
    };
  }
  const legacy = /\*\*Cost:\*\*\s*\$([0-9]+(?:\.[0-9]+)?)/i.exec(scope);
  if (legacy) {
    return {
      label: `Run $${legacy[1]}`,
      tone: 'muted',
      kind: 'unknown',
      amount: legacy[1]!,
    };
  }
  if (/steer resume/i.test(scope)) {
    return { label: 'Steer turn', tone: 'steer', kind: 'steer', amount: null };
  }
  return null;
}

/** Human-kind acceptance criteria that must be checked before Approve. */
export interface HumanCriterion {
  readonly id: string;
  readonly text: string;
}

export function parseHumanCriteria(body: string): readonly HumanCriterion[] {
  return listHumanCriteriaTexts(body).map((text, i) => ({ id: `h${i}`, text }));
}

/**
 * UI gate: every human-axis AC must be checked before Approve enables.
 * True when there are no human ACs, or all checklist boxes are ticked.
 */
export function areHumanCriteriaChecked(
  body: string,
  humanChecked: Readonly<Record<string, boolean>>,
): boolean {
  const acs = parseHumanCriteria(body);
  return acs.length === 0 || acs.every((c) => humanChecked[c.id] === true);
}

/** True when the last verification run crashed before a real packet. */
export function isVerificationInfraFailure(
  body: string,
  opts?: PacketNonceOpts,
): boolean {
  // Authoritative: status line only. Legacy: header slice only (agent prose in
  // the wider region can spoof "Verification failed: …").
  // nonce_missing / nonce_absent / tampered → never crashed.
  const prov = packetProvenance(body, opts);
  if (!prov || isNonceReasonFailClosed(prov) || prov.tampered) return false;
  const scope = prov.legacy
    ? (latestReviewPacketSlice(body) ?? prov.scan)
    : packetOwnedStatusText(prov);
  return /Verification failed:|Verification infrastructure failed/i.test(scope);
}

/** One behavioral screenshot / video referenced in the review packet body. */
export interface EvidenceMedia {
  readonly kind: 'image' | 'video';
  readonly name: string;
  readonly url: string;
  readonly label: string;
  readonly ok: boolean | null;
}

const IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i;
const VIDEO_EXT_RE = /\.(webm|mp4)$/i;
/** L2 step lines in the packet: `- ✅ unlock …` / `- ❌ assert …`. */
const STEP_LINE_RE = /^\s*[-*]\s*(✅|❌|⚠️)\s*(.+?)\s*$/;

function mediaKindForName(name: string): 'image' | 'video' | null {
  if (IMAGE_EXT_RE.test(name)) return 'image';
  if (VIDEO_EXT_RE.test(name)) return 'video';
  return null;
}

function stemOf(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface StepHit {
  readonly label: string;
  readonly ok: boolean | null;
}

/**
 * Pair a step to media only via unique exact stem/filename match.
 * If the step names a screenshot (`screenshot <name>`), compare that name's
 * stem exactly (case-insensitive) — substring is not enough (`checkout` ≠
 * `checkout-after`). Otherwise require the filename or stem as a whole token
 * in the step text. Never guess from proximity. CLI markers are handled
 * separately by {@link resolveMediaBinding}.
 */
const CLI_STEP_LABEL_RE = /^cli\s+([A-Za-z0-9._-]+)$/i;

function cliStepId(stepLabel: string): string | null {
  const m = CLI_STEP_LABEL_RE.exec(stepLabel.trim());
  return m?.[1] ?? null;
}

function stepMatchesMedia(stepLabel: string, name: string, stem: string): boolean {
  if (cliStepId(stepLabel) !== null) return false;
  const named: string[] = [];
  const screenshotNameRe = /screenshot\s+([A-Za-z0-9._-]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = screenshotNameRe.exec(stepLabel)) !== null) {
    named.push(m[1]!);
  }
  const stemL = stem.toLowerCase();
  const nameL = name.toLowerCase();
  if (named.length > 0) {
    return named.some((n) => {
      const nLower = n.toLowerCase();
      const nStem = stemOf(n).toLowerCase();
      return nLower === nameL || nStem === stemL || nLower === stemL;
    });
  }
  const tokenRe = (t: string) =>
    new RegExp(`(?:^|[^A-Za-z0-9._-])${escapeRegExp(t)}(?:[^A-Za-z0-9._-]|$)`, 'i');
  return tokenRe(name).test(stepLabel) || tokenRe(stem).test(stepLabel);
}

/**
 * Exact, fail-closed binding for one media name against all region markers.
 * Ambiguous → `{ label: stem, ok: null }`; never guess.
 */
function resolveMediaBinding(
  steps: readonly StepHit[],
  name: string,
  stem: string,
): { readonly label: string; readonly ok: boolean | null } {
  // CLI artifact names `cli-<stepId>-<rest>`: prefix match is case-sensitive.
  const cliHits = steps.filter((s) => {
    const id = cliStepId(s.label);
    return id !== null && name.startsWith(`cli-${id}-`);
  });
  if (cliHits.length > 0) {
    const ids = new Set(
      cliHits.map((s) => cliStepId(s.label)!),
    );
    if (ids.size !== 1) return { label: stem, ok: null };
    const first = cliHits[0]!;
    // Identical-marker collapse applies to CLI only: same id + same verdict.
    if (!cliHits.every((s) => s.ok === first.ok)) {
      return { label: stem, ok: null };
    }
    return { label: first.label, ok: first.ok };
  }

  const matches = steps.filter((s) => stepMatchesMedia(s.label, name, stem));
  if (matches.length === 0) return { label: stem, ok: null };
  if (matches.length === 1) {
    return { label: matches[0]!.label, ok: matches[0]!.ok };
  }
  // Non-CLI: even identical repeated markers are ambiguous (N5).
  return { label: stem, ok: null };
}

/**
 * Scan the latest review-packet scan text (or whole body when none) for
 * `/api/tasks/<taskId>/screenshots/<name>` references. Two-pass: collect all
 * step markers and media refs, then pair fail-closed. Captions
 * `_Screenshot: name_` never bind. Task id in the URL is case-sensitive.
 * Ambiguous → label = stem, ok = null. Never guess.
 * Authoritative packets: prose spans are stripped so agent-report markers
 * cannot label tiles.
 */
export function extractEvidenceMedia(
  body: string,
  taskId: string,
  opts?: PacketNonceOpts,
): readonly EvidenceMedia[] {
  if (!body || !taskId) return [];
  const prov = packetProvenance(body, opts);
  // Fail-closed / tampered → never scan the whole body for forged tiles.
  // No packet: callers with task metadata (opts given) get nothing — a crashed
  // first attempt must not render forged tiles from stderr; body-only callers
  // keep the whole-body scan (fixtures / tools without a packet heading).
  if (prov?.tampered || isNonceReasonFailClosed(prov)) return [];
  if (!prov && opts !== undefined) return [];
  const region = prov ? (packetScanText(body, opts) ?? body) : body;
  const escapedId = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Task id matched case-sensitively; extension case handled by mediaKindForName.
  const urlRe = new RegExp(
    `/api/tasks/${escapedId}/screenshots/([A-Za-z0-9._-]+)`,
  );

  // Pass 1 — collect every step marker and media reference in order.
  const steps: StepHit[] = [];
  const mediaRefs: { kind: 'image' | 'video'; name: string; url: string }[] = [];
  const occurrenceCount = new Map<string, number>();

  for (const rawLine of region.split('\n')) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    const step = STEP_LINE_RE.exec(trimmed);
    if (step) {
      const mark = step[1]!;
      const rest = step[2]!.replace(/^`+|`+$/g, '').trim();
      steps.push({
        label: rest.length > 0 ? rest : mark,
        ok: mark === '✅' ? true : mark === '❌' ? false : null,
      });
      continue;
    }

    // Captions are ignored for labelling — they never produce a binding.
    const urlMatch = urlRe.exec(line);
    if (!urlMatch) continue;
    const name = urlMatch[1]!;
    const kind = mediaKindForName(name);
    if (!kind) continue;
    occurrenceCount.set(name, (occurrenceCount.get(name) ?? 0) + 1);
    if (occurrenceCount.get(name) === 1) {
      mediaRefs.push({
        kind,
        name,
        url: `/api/tasks/${taskId}/screenshots/${name}`,
      });
    }
  }

  // Pass 2 — pair each distinct name against the full marker set (fail-closed).
  const out: EvidenceMedia[] = [];
  for (const ref of mediaRefs) {
    const stem = stemOf(ref.name);
    const bound = resolveMediaBinding(steps, ref.name, stem);
    // Same name more than once: re-resolve independently; must agree (they
    // will with a deterministic full-set bind — keep the check anyway).
    const times = occurrenceCount.get(ref.name) ?? 1;
    let agreed = true;
    for (let i = 0; i < times; i += 1) {
      const again = resolveMediaBinding(steps, ref.name, stem);
      if (again.label !== bound.label || again.ok !== bound.ok) {
        agreed = false;
        break;
      }
    }
    out.push(
      agreed
        ? { ...ref, label: bound.label, ok: bound.ok }
        : { ...ref, label: stem, ok: null },
    );
  }
  return out;
}

/** Read-only credibility chip (never a verdict). */
export interface CredibilityChip {
  readonly kind: string;
  readonly label: string;
}

/**
 * Build credibility chips from a DecisionCard, falling back to the packet
 * 「可信度」 / 「改动」 summary lines when the card is missing fields.
 */
export function buildCredibilityChips(
  body: string,
  card: {
    readonly gates: readonly {
      readonly passed: boolean;
      readonly outcome?: 'skipped' | 'info';
    }[];
    readonly evidence: {
      readonly ran: boolean;
      readonly ok: boolean | null;
      readonly steps: number;
      readonly skipReason?: string;
    };
    readonly reviewer: {
      readonly ran: boolean;
      readonly approved: boolean | null;
    };
    readonly filesTouched: number;
  } | null,
  opts?: PacketNonceOpts,
): readonly CredibilityChip[] {
  // Prefer the FIRST ## 决策摘要 inside the scan text (renderer emits exactly
  // one; authoritative mode strips prose so a forged card in the report cannot
  // win). Legacy fallback: first card in the hardened region (= scan).
  // No packet / nonce_missing / nonce_absent / tampered → mechanical chips from
  // card only (never whole-body forged **可信度** lines).
  const prov = packetProvenance(body, opts);
  // No packet: metadata callers (opts given) get card-only chips; body-only
  // callers keep the whole-body fallback (fixtures / tools without a packet).
  const region =
    prov?.tampered || isNonceReasonFailClosed(prov)
      ? ''
      : !prov
        ? (opts === undefined ? body : '')
        : (packetScanText(body, opts) ?? '');
  let decisionSummary = region;
  {
    const re = /##\s*决策摘要\s*\n([\s\S]*?)(?=\n##\s+|\n\*\*[^*]|$)/g;
    const first = re.exec(region);
    if (first?.[1] !== undefined) decisionSummary = first[1];
  }
  const chips: CredibilityChip[] = [];

  // 门禁 n/m
  let gatesLabel: string | null = null;
  if (card) {
    const counted = card.gates.filter((g) => g.outcome !== 'skipped' && g.outcome !== 'info');
    if (counted.length > 0) {
      const green = counted.filter((g) => g.passed).length;
      gatesLabel = `门禁 ${green}/${counted.length}`;
    }
  }
  if (!gatesLabel) {
    const m = /门禁\s*(\d+)\s*\/\s*(\d+)/.exec(decisionSummary);
    if (m) gatesLabel = `门禁 ${m[1]}/${m[2]}`;
  }
  if (gatesLabel) chips.push({ kind: 'gates', label: gatesLabel });

  // 审稿
  let reviewerLabel: string | null = null;
  if (card?.reviewer.ran) {
    reviewerLabel =
      card.reviewer.approved === true
        ? '审稿 通过'
        : card.reviewer.approved === false
          ? '审稿 要求修改'
          : '审稿 未运行';
  } else if (card && !card.reviewer.ran) {
    reviewerLabel = '审稿 未运行';
  } else {
    if (/独立审稿:通过|审稿:通过/.test(decisionSummary)) reviewerLabel = '审稿 通过';
    else if (/独立审稿:要求修改|审稿:要求修改/.test(decisionSummary)) {
      reviewerLabel = '审稿 要求修改';
    } else if (/独立审稿:未运行|审稿:未运行/.test(decisionSummary)) {
      reviewerLabel = '审稿 未运行';
    }
  }
  if (reviewerLabel) chips.push({ kind: 'reviewer', label: reviewerLabel });

  // 行为证据
  let evidenceLabel: string | null = null;
  if (card) {
    if (!card.evidence.ran) evidenceLabel = '行为证据 未运行';
    else if (card.evidence.ok === true) evidenceLabel = `行为证据 ${card.evidence.steps} 步 ✓`;
    else if (card.evidence.ok === false) evidenceLabel = `行为证据 ${card.evidence.steps} 步 ✗`;
    else evidenceLabel = `行为证据 ${card.evidence.steps} 步`;
  } else {
    const pass = /(?:浏览器)?行为证据\s*(\d+)\s*步通过/.exec(decisionSummary);
    const fail = /(?:浏览器)?行为证据未通过/.test(decisionSummary);
    const skip = /(?:浏览器)?行为证据未运行|浏览器证据不适用/.test(decisionSummary);
    if (pass) evidenceLabel = `行为证据 ${pass[1]} 步 ✓`;
    else if (fail) evidenceLabel = '行为证据 ✗';
    else if (skip) evidenceLabel = '行为证据 未运行';
  }
  if (evidenceLabel) chips.push({ kind: 'behavioral', label: evidenceLabel });

  // CLI证据
  let cliLabel: string | null = null;
  if (
    /CLI行为证据\s*\d+\s*步通过/.test(decisionSummary) ||
    /CLI证据\s*✓/.test(decisionSummary) ||
    /CLI证据\s*✔/.test(decisionSummary)
  ) {
    cliLabel = 'CLI证据 ✓';
  } else if (
    /CLI行为证据未通过/.test(decisionSummary) ||
    /CLI证据\s*✗/.test(decisionSummary) ||
    /CLI证据\s*✖/.test(decisionSummary)
  ) {
    cliLabel = 'CLI证据 ✗';
  } else if (/CLI行为证据未运行|CLI证据\s*未运行/.test(decisionSummary)) {
    cliLabel = 'CLI证据 未运行';
  } else if (card) {
    // Card has no CLI field — default to 未运行 when we have a card at all.
    cliLabel = 'CLI证据 未运行';
  }
  if (cliLabel) chips.push({ kind: 'cli', label: cliLabel });

  // 改动 N 文件
  let filesLabel: string | null = null;
  if (card && card.filesTouched >= 0) {
    filesLabel = `改动 ${card.filesTouched} 文件`;
  } else {
    const m =
      /(\d+)\s*个文件改动/.exec(decisionSummary) ??
      /(\d+)\s*个文件改动/.exec(region) ??
      /Files touched[^0-9]*(\d+)/i.exec(region);
    if (m) filesLabel = `改动 ${m[1]} 文件`;
  }
  if (filesLabel) chips.push({ kind: 'files', label: filesLabel });

  return chips;
}

/** One-line muted note when the gallery has no media. */
export function evidenceEmptyNote(
  body: string,
  card: {
    readonly evidence: { readonly skipReason?: string; readonly ran: boolean };
  } | null,
  opts?: PacketNonceOpts,
): string {
  const provForNote = packetProvenance(body, opts);
  const packet =
    !provForNote || provForNote.tampered || isNonceReasonFailClosed(provForNote)
      ? ''
      : (packetScanText(body, opts) ?? '');
  const reason =
    card?.evidence.skipReason?.trim() ||
    (/浏览器证据不适用/.exec(packet)?.[0] ?? null) ||
    (/行为证据未运行/.exec(packet)?.[0] ?? null) ||
    (/Behavioral evidence[^\n]*—\s*(.+)/i.exec(packet)?.[1]?.trim() ?? null);
  if (reason) return `无截图证据 · ${reason}`;
  return '无截图证据';
}

/** Extract **Agent's report** prose from the latest packet (if present). */
export function extractAgentReport(
  body: string,
  opts?: PacketNonceOpts,
): string | null {
  const prov = packetProvenance(body, opts);
  if (!prov || isNonceReasonFailClosed(prov) || prov.tampered) return null;
  if (!prov.legacy) {
    // Authoritative: kind=report span verbatim (fences already stripped).
    const span = [...prov.prose].reverse().find((s) => s.kind === 'report');
    const text = span?.text.trim() ?? '';
    return text.length > 0 ? text : null;
  }
  // Legacy: stop at the next Hercules `**Section**` marker only — embedded
  // `## ` headings inside the agent's final report are part of the report text.
  const m =
    /\*\*Agent's report\*\*[^\n]*\n([\s\S]*?)(?=\n\*\*[^*]+\*\*|$)/i.exec(prov.region);
  const text = m?.[1]?.trim() ?? '';
  return text.length > 0 ? text : null;
}
