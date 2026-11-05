/**
 * Implementer prompt body: product brief + trusted verification digest.
 *
 * After a failed verify the task body holds the full human-facing review packet
 * (self-assessment, agent report, diff, cost, activity). On re-dispatch the
 * coding agent only needs the product brief, trusted verdict inputs (DoD, L3,
 * failing gates, L5, receipts), and the human/daemon trail — not the prior
 * agent's narrative. Same cut spirit as `productBriefForFailFast` /
 * `extractReviewPacketContent`.
 */

export interface ImplementerBrief {
  /** Product brief: task body before the first `## Review packet` heading (trimmed). */
  readonly brief: string;
  /** Trusted-verdict digest of the latest review packet, or null when the body has none. */
  readonly verificationDigest: string | null;
  /** Human / daemon trail after the packet (see TRAIL_HEADING), verbatim, or null. */
  readonly trail: string | null;
  /** Headings of the packet blocks that were dropped (for tests / logging). */
  readonly dropped: readonly string[];
}

/** Hard bound for the digest so a rework prompt stays proportional. */
export const IMPLEMENTER_DIGEST_MAX_CHARS = 12_000;

export const VERIFICATION_DIGEST_HEADING =
  '## Verification feedback (previous attempt — trusted verdict inputs only)';

const PACKET_MARKER = '## Review packet';

/**
 * First human/daemon trail heading after the review packet (multiline).
 * Broader than `withReviewPacket`'s trail (which only preserves steer/teardown
 * across packet replace) — Auto-rework / Attempts exhausted / etc. also trail.
 */
export const TRAIL_HEADING =
  /^## (?:Human steer|Steer result|Teardown|Auto-rework|Attempts exhausted|Pending human steer|Host operation replay blocked|Dependency preflight recovery hold)\b/m;

/** Exact prefixes emitted by `renderPacketMarkdown` that start a packet block. */
const KNOWN_HEADING_PREFIXES: readonly string[] = [
  '### ',
  '## 决策摘要',
  '**❌ Delivery check failed.**',
  '**Definition of Done**',
  '**L3 not run:**',
  '**Evidence matrix**',
  '**⚠ UI 人工项缺少证据步骤**',
  '**Self-assessment**',
  '## Host operation receipt',
  '## CLI behavioral evidence',
  '**Reviewer (L3):**',
  '**L3 report**',
  '**Gates**',
  '**⚠️ Report hygiene (soft):**',
  "**Agent's report**",
  '**Behavioral evidence**',
  '**Gate toolchain edited',
  '**Verifier source edited',
  '**Files touched**',
  '**Diff summary:**',
  '**Full diff on GitHub:**',
  '**Diff**',
  '**Agent activity**',
  '**Cost (',
  '**Anti-cheating (L5 → L3)**',
  '<!-- hercules:decision-card',
];

/** Longest-first so `**Diff summary:**` wins over `**Diff**`. */
const KNOWN_SORTED = [...KNOWN_HEADING_PREFIXES].sort((a, b) => b.length - a.length);

const DROP_HEADINGS = new Set<string>([
  '**Self-assessment**',
  "**Agent's report**",
  '**Files touched**',
  '**Diff summary:**',
  '**Full diff on GitHub:**',
  '**Diff**',
  '**Agent activity**',
  '**Cost (',
  '**Evidence matrix**',
  '<!-- hercules:decision-card',
]);

interface PacketBlock {
  readonly heading: string | null;
  readonly text: string;
}

function matchKnownHeading(line: string): string | null {
  for (const prefix of KNOWN_SORTED) {
    if (line.startsWith(prefix)) return prefix;
  }
  return null;
}

function isFenceToggle(line: string): boolean {
  return line.trimStart().startsWith('```');
}

/**
 * Split packet markdown into blocks keyed by known `renderPacketMarkdown` headings.
 * Text before the first known heading (CLI evidence authority preamble) is kept.
 * Lines inside fenced code blocks never start a block. Decision-card machine
 * blocks run through to the closing `-->` line.
 */
function splitPacketBlocks(packetContent: string): PacketBlock[] {
  const lines = packetContent.replace(/\r\n/g, '\n').split('\n');
  const blocks: PacketBlock[] = [];
  let heading: string | null = null;
  let buf: string[] = [];
  let inFence = false;
  let inDecisionCard = false;
  // `### ` is only the packet header (`### <taskId> — branch`); agent-written
  // `### …` headings inside a dropped block must not resurrect a kept block.
  let sawPacketHeader = false;

  const flush = (): void => {
    blocks.push({ heading, text: buf.join('\n') });
    buf = [];
  };

  for (const line of lines) {
    if (inDecisionCard) {
      buf.push(line);
      if (line.trim() === '-->') {
        inDecisionCard = false;
        flush();
        heading = null;
        buf = [];
      }
      continue;
    }

    if (isFenceToggle(line)) {
      inFence = !inFence;
      buf.push(line);
      continue;
    }

    if (!inFence) {
      let matched = matchKnownHeading(line);
      if (matched === '### ') {
        matched = sawPacketHeader ? null : '### ';
        sawPacketHeader = true;
      }
      if (matched !== null) {
        // Flush preamble / prior block; skip a truly empty leading flush.
        if (heading !== null || buf.length > 0) {
          flush();
        }
        heading = matched;
        buf = [line];
        if (matched === '<!-- hercules:decision-card') {
          inDecisionCard = true;
        }
        continue;
      }
    }

    buf.push(line);
  }

  if (buf.length > 0 || heading !== null) {
    flush();
  }

  return blocks;
}

function truncateDigest(digest: string, maxChars: number): string {
  if (digest.length <= maxChars) return digest;
  const marker = `\n… (digest truncated at ${maxChars} chars — read the packet on the task page)`;
  const cut = Math.max(0, maxChars);
  return `${digest.slice(0, cut)}${marker}`;
}

export function buildImplementerBrief(
  body: string,
  opts?: { readonly maxDigestChars?: number },
): ImplementerBrief {
  const maxDigestChars =
    typeof opts?.maxDigestChars === 'number' &&
    Number.isFinite(opts.maxDigestChars) &&
    opts.maxDigestChars > 0
      ? Math.floor(opts.maxDigestChars)
      : IMPLEMENTER_DIGEST_MAX_CHARS;

  const at = body.indexOf(PACKET_MARKER);
  if (at < 0) {
    return {
      brief: body.trim(),
      verificationDigest: null,
      trail: null,
      dropped: [],
    };
  }

  const brief = body.slice(0, at).trim();
  const after = body.slice(at + PACKET_MARKER.length);
  const trailAt = after.search(TRAIL_HEADING);
  const trail = trailAt >= 0 ? after.slice(trailAt) : null;
  const packetContent = trailAt >= 0 ? after.slice(0, trailAt) : after;

  const blocks = splitPacketBlocks(packetContent);
  const dropped: string[] = [];
  const kept: string[] = [];

  for (const block of blocks) {
    if (block.heading !== null && DROP_HEADINGS.has(block.heading)) {
      dropped.push(block.heading);
      continue;
    }
    kept.push(block.text);
  }

  const rawDigest = kept
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
    // Strip Hercules provenance fence lines — noise for the next implementer
    // and an imitation invitation (C3.27 N2).
    .split('\n')
    .filter((line) => !/^\s*<!--\s*hercules:/.test(line))
    .join('\n');
  const verificationDigest = truncateDigest(rawDigest, maxDigestChars);

  return {
    brief,
    verificationDigest,
    trail,
    dropped,
  };
}

/**
 * Body the implementer prompt should embed: brief, then (when present)
 * VERIFICATION_DIGEST_HEADING + digest, then the trail — joined by blank lines.
 * A body without a packet is returned trimmed and otherwise unchanged.
 */
export function renderImplementerTaskBody(body: string): string {
  const parts = buildImplementerBrief(body);
  if (parts.verificationDigest === null) {
    return body.trim();
  }

  const sections: string[] = [];
  if (parts.brief.length > 0) {
    sections.push(parts.brief);
  }
  sections.push(
    `${VERIFICATION_DIGEST_HEADING}\n\n${parts.verificationDigest}`,
  );
  if (parts.trail !== null && parts.trail.length > 0) {
    sections.push(parts.trail.replace(/\n+$/, ''));
  }
  return sections.join('\n\n');
}
