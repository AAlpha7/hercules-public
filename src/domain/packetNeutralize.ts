/**
 * Shared neutralization for untrusted text that may sit next to a review
 * packet. Rewrites HTML-comment openers and breaks lines that look like a
 * packet start so agent-/tool-/caller-controlled prose cannot spoof fences
 * or `## Review packet` / `### <taskId>` headings.
 *
 * Pure: no IO. Used by the packet renderer and every post-packet body writer.
 */

/** Zero-width space inserted after the first `#` of an agent-controlled heading. */
export const PACKET_HEADING_NEUTRALIZER = '\u200B';

const REVIEW_PACKET_HEADING_LINE_RE = /^##\s+Review packet\b/i;
/**
 * Hercules-owned trail headings that carry semantics for accounting or
 * parsing (`## Human steer` resets thrash / global-ceiling accounting,
 * `## Steer result` / `## Run failure` bound trails). Untrusted text must not
 * be able to forge them (Grok R19 B1).
 */
const TRAIL_HEADING_LINE_RE =
  /^##\s+(?:Human steer|Steer result|Run failure|Teardown|Attempts exhausted|Auto-rework)(?:\s*\(|\s*$)/i;

/** Whole-line Hercules fence look-alike (packet / prose / packet-end). */
const HERCULES_FENCE_LINE_RE =
  /^\s*<!--\s*hercules:(?:packet(?:-end)?|prose-begin|prose-end)\b/;

export type NeutralizePacketTextOpts = {
  /**
   * When set, only `### <taskId>` (exact, case-sensitive) headings are broken.
   * Ordinary `### Summary` / other task ids render unchanged. Omit when the
   * writer has no task id — then only `<!--` and `## Review packet` are hit.
   */
  readonly taskId?: string | null;
};

/** Neutralize HTML-comment openers inside untrusted prose so they cannot spoof fences. */
export function neutralizeProseHtmlComments(text: string): string {
  return text.replaceAll('<!--', '<!- -');
}

function isPacketTaskHeadingLine(trimmed: string, taskId: string): boolean {
  // Exact id after ### (optional trailing prose like " — `branch`").
  const re = new RegExp(
    `^###\\s+${taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`,
  );
  return re.test(trimmed);
}

/**
 * Render-time neutralization for every agent-/tool-/caller-controlled string
 * embedded in or appended after a review packet. Rewrites `<!--` and breaks
 * lines that look like a packet start (`## Review packet` / `### <taskId>…`
 * when `opts.taskId` is set). Ordinary `### Summary` headings are left alone.
 * Hercules-emitted fence lines are never passed through this helper.
 */
export function neutralizeUntrustedPacketText(
  text: string,
  opts?: NeutralizePacketTextOpts,
): string {
  const withComments = neutralizeProseHtmlComments(text);
  if (withComments.length === 0) return withComments;
  const taskId =
    typeof opts?.taskId === 'string' && opts.taskId.length > 0 ? opts.taskId : null;
  return withComments
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      const hitReview =
        REVIEW_PACKET_HEADING_LINE_RE.test(trimmed) || TRAIL_HEADING_LINE_RE.test(trimmed);
      const hitTask =
        taskId !== null && isPacketTaskHeadingLine(trimmed, taskId);
      if (!hitReview && !hitTask) {
        return line;
      }
      // Break the `#` run: insert U+200B after the first `#`.
      return line.replace(/^(\s*)#/, `$1#${PACKET_HEADING_NEUTRALIZER}`);
    })
    .join('\n');
}

/**
 * Rewrite whole-line Hercules fence look-alikes (`<!-- hercules:packet…`,
 * prose-begin/end, packet-end) to the neutralized `<!- -` form. Used by
 * `withReviewPacket` on base/trail so a stale forged fence cannot outlive a
 * packet rewrite.
 */
export function neutralizeHerculesFenceLines(text: string): string {
  if (text.length === 0) return text;
  return text
    .split('\n')
    .map((line) => {
      if (!HERCULES_FENCE_LINE_RE.test(line)) return line;
      return neutralizeProseHtmlComments(line);
    })
    .join('\n');
}
