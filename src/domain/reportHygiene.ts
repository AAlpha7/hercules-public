/**
 * Domain layer — final-message hygiene (packet readability).
 *
 * Implementers (especially multi-agent / sub-reviewer workflows) sometimes dump
 * interleaved review transcripts into the streamed final text. That is not a
 * deliverable: the human packet becomes unreadable even when the branch is fine.
 *
 * Pure detection + cleaning so the verifier can:
 *   1) surface a mechanical gate failure (auto-rework with remediation text)
 *   2) still show a cleaned report + intact self-assessment
 */

export interface ReportHygieneResult {
  /** True when the narrative looks like concatenated multi-reviewer dumps. */
  readonly polluted: boolean;
  /** Human-readable reasons (for packet + gate output). */
  readonly reasons: readonly string[];
  /** Narrative with obvious multi-review noise removed (best-effort). */
  readonly cleanedReport: string;
  /** Unchanged self-assessment section body (already split). */
  readonly selfAssessment: string;
}

/** Signals of multi-agent / multi-pass review dumps in one stream. */
const POLLUTION_PATTERNS: readonly { re: RegExp; label: string }[] = [
  { re: /^##\s*Verdict\s*$/gim, label: 'multiple ## Verdict headings' },
  { re: /^##\s*Confidence\s*$/gim, label: 'multiple ## Confidence headings' },
  { re: /^##\s*Findings\s*$/gim, label: 'multiple ## Findings headings' },
  { re: /\*\*严重程度[：:]\s*(MAJOR|MINOR|BLOCK)/g, label: 'interleaved Chinese severity findings' },
  { re: /严重程度：\s*(MAJOR|MINOR|BLOCK)/g, label: 'interleaved severity findings' },
];

const MAX_CLEAN_REPORT_CHARS = 12_000;

/**
 * Score pollution and produce a cleaned narrative for the phone packet.
 * `report` and `selfAssessment` should already be split by {@link splitFinalReport}.
 */
export function assessReportHygiene(
  report: string,
  selfAssessment: string,
): ReportHygieneResult {
  const reasons: string[] = [];
  const text = report;

  for (const { re, label } of POLLUTION_PATTERNS) {
    const matches = text.match(re);
    if (matches && matches.length >= 2) {
      reasons.push(`${label} (×${matches.length})`);
    }
  }

  // Character-level garble: CJK immediately stuck to Latin mid-token is rare in
  // clean prose but common when two streams interleave without newlines.
  const glue = text.match(/[\u4e00-\u9fff][A-Za-z]{3,}|[A-Za-z]{3,}[\u4e00-\u9fff]/g);
  if (glue && glue.length >= 8) {
    reasons.push(`interleaved CJK/Latin fragments (×${glue.length})`);
  }

  // Tables broken mid-row by foreign prose.
  const brokenTables = text.match(/\|[^|\n]{0,40}\|[^|\n]{0,80}[\u4e00-\u9fff]{2,}[^|\n]{0,40}\|/g);
  if (brokenTables && brokenTables.length >= 3) {
    reasons.push('broken markdown tables (likely stream collision)');
  }

  const polluted = reasons.length > 0;
  const cleanedReport = polluted ? cleanPollutedReport(text) : text.trim();

  return {
    polluted,
    reasons,
    cleanedReport:
      cleanedReport.length > MAX_CLEAN_REPORT_CHARS
        ? `${cleanedReport.slice(0, MAX_CLEAN_REPORT_CHARS)}\n… (truncated for packet)`
        : cleanedReport,
    selfAssessment,
  };
}

/**
 * Keep the leading coherent narrative until the first multi-review dump marker,
 * then drop the rest (self-assessment is already separate).
 */
export function cleanPollutedReport(report: string): string {
  const cutMarkers = [
    /^##\s*Verdict\b/im,
    /^##\s*Confidence\b/im,
    /^##\s*Findings\b/im,
    /^\*\*严重程度/m,
    /^-\s*\*\*严重程度/m,
    /^严重程度：/m,
    /^### 未触发/m,
  ];

  let cutAt = report.length;
  for (const re of cutMarkers) {
    const m = re.exec(report);
    // Keep any preamble before the first review-dump marker (even if short).
    if (m && m.index !== undefined && m.index > 0 && m.index < cutAt) {
      cutAt = m.index;
    }
  }

  let head = report.slice(0, cutAt).trim();

  // Drop lines that look like stream collisions (CJK glued to long Latin).
  head = head
    .split('\n')
    .filter((line) => {
      const glue = (line.match(/[\u4e00-\u9fff][A-Za-z]{4,}|[A-Za-z]{4,}[\u4e00-\u9fff]/g) ?? [])
        .length;
      return glue < 2;
    })
    .join('\n')
    .trim();

  if (head.length < 8) {
    return (
      '_(Implementer final message was polluted by interleaved multi-reviewer ' +
      'transcripts; see self-assessment and L3 verdict. Files on the branch are ' +
      'the source of truth.)_'
    );
  }
  return head;
}

/** Soft-gate note when hygiene is polluted (does not fail the run). */
export function reportHygieneGateOutput(reasons: readonly string[]): string {
  return [
    'Final message looked like a multi-stream dump; packet shows a cleaned excerpt.',
    `Signals: ${reasons.join('; ')}.`,
    'Branch files remain source of truth. Prefer clean final messages next run:',
    'short narrative + ## Self-assessment only — no sub-agent ## Verdict dumps.',
  ].join(' ');
}
