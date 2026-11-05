/**
 * Domain layer — verification value types (SPEC §9). Pure data; the logic that
 * produces them lives in src/verification.
 */
import type { CriterionKind, DodDimensions } from './acceptance.js';
import type { BaseDriftReport } from './baseDrift.js';
import type { GateFailAttributionReport } from './gateFailAttribution.js';
import type { ReworkPath } from './reworkPolicy.js';

/** A self-verification gate result (Layer 1, SPEC §9.1). */
export interface GateResult {
  readonly name: string;
  readonly command: string;
  readonly passed: boolean;
  /** Trimmed combined output (fed back to the agent verbatim on failure). */
  readonly output: string;
  /** Process exit code when known (optional on legacy fixtures). */
  readonly exitCode?: number;
  /**
   * Synthesized rows: 'skipped' = the gate did not run (no-diff run); 'info' = soft, informational
   * (report hygiene). Neither is a real pass: renderers show ⏭ / ℹ️ and exclude them from n/m.
   */
  readonly outcome?: 'skipped' | 'info';
}

/** Real gate rows only (excludes synthesized skipped/info rows). */
export function countedGates(gates: readonly GateResult[]): readonly GateResult[] {
  return gates.filter((g) => g.outcome !== 'skipped' && g.outcome !== 'info');
}

/** A potential anti-cheating violation found in the diff (Layer 5, SPEC §9.5). */
export type CheatKind =
  | 'eslint-disable'
  | 'ts-ignore'
  | 'test-skip'
  | 'test-only'
  | 'as-any'
  | 'empty-catch'
  | 'protected-path'
  | 'test-edit'
  /**
   * An existing named it/test case was removed or renamed (title not preserved
   * in added lines). Critical: L1 cannot prove a deleted test still constrains.
   */
  | 'test-integrity'
  /** Agent claims shipped/live without a worktree diff. */
  | 'false-delivery'
  /** Branch carries commits attributed to OTHER task ids (lineage blur). */
  | 'cross-task-commits'
  /**
   * Newly added JSX with data-evidence that looks like a non-functional
   * placeholder only so L2 `assert sel=` can pass (REVIEW_ONLY).
   */
  | 'placeholder-evidence-hook'
  /**
   * Diff touches a file a trusted gate command resolves from the worktree
   * (package script in the gate closure, test/lint/type/build config, or a
   * script those invoke). Severity review; never green; mechanical axis pending.
   */
  | 'gate-toolchain-edit'
  /**
   * Diff touches Hercules' own verifier / acceptance source. This run's verdict
   * comes from the released daemon, so the edit cannot game its own task — but
   * it changes the verdict for every task after merge. Review-only: human must
   * read the verifier diff before merging (executor gaming pattern seen live
   * 2026-09-03: fixture special-case inside evidence.ts).
   */
  | 'verifier-edit'
  /**
   * ≥2 screenshots bound to distinct scenarios share the same sha256 (hollow
   * evidence). Critical: fails the behavioural axis — review-only is not enough.
   */
  | 'hollow-evidence'
  /**
   * The diff adds or turns a file into a symlink whose target resolves outside
   * the worktree (executor "copied" draft files by linking, 2026-09-09).
   * Critical: the linked content is not part of the delivery; copy, never link.
   */
  | 'symlink-escape';

export interface CheatFinding {
  readonly kind: CheatKind;
  readonly file: string;
  readonly line?: number;
  readonly detail: string;
}

/**
 * Severity for UI / packet markers.
 * - `critical` — silencing, skip/only, protected-path, false-delivery, test-integrity (red)
 * - `review` — test-file edits, placeholder evidence hooks, cross-task
 *   commits (amber; for human/L3 scrutiny, not auto-fail)
 */
export type CheatSeverity = 'critical' | 'review';

/** Kinds that only ask the reviewer to scrutinize (not hard cheating). */
const REVIEW_ONLY_CHEAT_KINDS: ReadonlySet<CheatKind> = new Set([
  'test-edit',
  // Provenance, not content: cross-task commits need scrutiny + human
  // awareness, but a re-dispatch cannot fix them (R3/R2, 2026-07-22).
  'cross-task-commits',
  // L2 selector placeholders: call out on packet/decision card; L3 judges
  // real functionality — do not auto-rework (2026-07-25 twin incidents).
  'placeholder-evidence-hook',
  // Gate toolchain edits (S2): mechanical pending + human/L3 scrutiny, not auto-rework.
  'gate-toolchain-edit',
  // Verifier source edits: post-merge blast radius, human reads the diff; not auto-rework.
  'verifier-edit',
]);
export function cheatSeverity(kind: CheatKind): CheatSeverity {
  return REVIEW_ONLY_CHEAT_KINDS.has(kind) ? 'review' : 'critical';
}

export function isCriticalCheatKind(kind: CheatKind): boolean {
  return cheatSeverity(kind) === 'critical';
}

/** The fresh-context reviewer's verdict (Layer 3, SPEC §9.3). */
export interface ReviewerVerdict {
  readonly approved: boolean;
  readonly summary: string;
  readonly comments: readonly string[];
  /** One-line Chinese executive summary of WHAT changed (business language). */
  readonly summaryZh?: string;
  /** Set when the diff handed to L3 was cut for ARG_MAX safety: L3 did not see the whole change. */
  readonly inputTruncation?: { readonly diffChars: number; readonly maxChars: number };
  /** Full bounded L3 stdout (reasoning + adjudications); advisory evidence only. */
  readonly report?: string;
}

/** Cap retained L3 stdout in the review packet (reasoning + adjudications). */
export const MAX_REVIEWER_REPORT_CHARS = 24_000;

/**
 * Bound L3 stdout for packet retention. Call AFTER verdict extraction so a
 * truncated store never corrupts the structured verdict fields.
 */
export function boundReviewerReport(
  text: string,
  max: number = MAX_REVIEWER_REPORT_CHARS,
): string {
  const t = text.trimEnd();
  if (t.length <= max) return t;
  // U+2026 ellipsis — same marker style as other bounded packet sections.
  return (
    t.slice(0, max) +
    String.fromCharCode(10) +
    String.fromCharCode(0x2026) +
    ' (L3 report truncated from ' +
    String(t.length) +
    ' to ' +
    String(max) +
    ' chars)'
  );
}

/** How this verification run was dispatched (affects cost labeling). */
export type PacketRunKind = 'implementer' | 'steer';

/** One row of the per-criterion evidence matrix (phone review). */
export interface EvidenceMatrixRow {
  readonly text: string;
  readonly kind: CriterionKind;
  readonly status: string;
  /** Paths, commands, or citations from the self-assessment (or a placeholder). */
  readonly evidence: string;
  /**
   * Soft warning when a human UI AC has no related L2 click/assert/screenshot
   * (operator cannot verify before deploy). Never blocks Approve.
   */
  readonly unprovenUiWarning?: string;
  /** What is missing (specific). Present with unprovenUiWarning. */
  readonly unprovenUiReason?: string;
}

/** The mobile review artifact (SPEC §9.6). */
export interface ReviewPacket {
  readonly taskId: string;
  readonly branch: string;
  readonly filesTouched: readonly string[];
  readonly diffSummary: string;
  /** The full unified diff of the change (for on-phone review). */
  readonly diff: string;
  readonly gates: readonly GateResult[];
  readonly cheatFindings: readonly CheatFinding[];
  /** Behavioral evidence screenshot paths (Layer 2, SPEC §9.2). */
  readonly screenshots: readonly string[];
  /**
   * Declarative L2 evidence run (step log). Absent on older packets / no L2.
   */
  readonly evidenceRun?: {
    readonly source: string;
    readonly ok: boolean;
    readonly steps: readonly {
      readonly kind: string;
      readonly ok: boolean;
      readonly detail: string;
      readonly optional?: boolean;
      readonly screenshot?: string;
      /** Lowercase hex sha256 of the screenshot bytes when known. */
      readonly screenshotSha256?: string;
      readonly raw?: string;
    }[];
  };
  readonly reviewerVerdict: ReviewerVerdict | null;
  readonly selfAssessment: string;
  /** The agent's final message — its closing report / the deliverable for a
   *  text task (summary, analysis). Empty when the agent emitted no text.
   *  Without this the packet discards the result of any non-code task. */
  readonly finalReport: string;
  /**
   * True when automated proof is complete (mechanical + reviewer axes).
   * Never includes the human axis — phone Approve is separate.
   */
  readonly green: boolean;
  /** The agent finished but modified nothing — almost always a non-result. */
  readonly noChanges: boolean;
  /** Three-axis Definition of Done status (mechanical / reviewer / human). */
  readonly dod: DodDimensions;
  /**
   * When true, the orchestrator should re-queue for implementer rework instead
   * of parking in human review (L3 changes_requested or L1 fail on a real diff).
   */
  readonly autoRework: boolean;
  /**
   * When autoRework: which path the orchestrator should take.
   * `steer` = cheap session resume; `full` = fresh implementer re-dispatch.
   * null when not auto-reworking.
   */
  readonly reworkPath: ReworkPath | null;
  /** Why reworkPath was chosen (packet + Auto-rework note). */
  readonly reworkPathReason: string | null;
  /**
   * Implementer final message looked like interleaved multi-reviewer dumps.
   * Packet shows a cleaned report; mechanical gate `report-hygiene` may fail.
   */
  readonly reportPolluted: boolean;
  /** A readable tail of what the agent actually did (text + tool/file use), so a
   *  human can judge real completion — not just the resulting diff (SPEC §9.6). */
  readonly activityLog: readonly string[];
  /** Token usage + cost for the run, when the adapter reported it. */
  readonly usage?: PacketUsage;
  /** implementer = full dispatch; steer = session-resume follow-up. */
  readonly runKind: PacketRunKind;
  /**
   * Why L3 did not run (null when it ran or was not applicable for other
   * reasons already covered by DoD). Shown under the reviewer axis.
   */
  readonly reviewerSkipReason: string | null;
  /** GitHub compare URL for the full branch diff (when remote is GitHub). */
  readonly diffUrl: string | null;
  /** Per-criterion evidence matrix (DoD rows + self-assessment citations). */
  readonly evidenceMatrix: readonly EvidenceMatrixRow[];
  /** Structured CEO decision card (embedded into the rendered packet). */
  readonly decisionCard?: import('./decisionCard.js').DecisionCard;
  /**
   * Worktree HEAD at verification time. Approve must refuse when the preserved
   * branch tip no longer contains this commit — the packet's evidence would
   * describe work that is not what ships (2026-07-15 fake-green incident).
   * Null when HEAD was unresolvable (fake mode / non-git worktree).
   */
  readonly verifiedSha: string | null;
  /**
   * Pre-review lag vs the repo default branch (merge-base ancestry + conflict
   * risk). Absent on older packets. See domain/baseDrift.
   */
  readonly baseDrift?: BaseDriftReport;
  /**
   * C3.56: uncommitted paths a verify-only (read-only) agent still left in the
   * worktree; discarded before L1, never committed. Absent on older packets.
   */
  readonly verifyOnlyDiscardedPaths?: readonly string[];
  /**
   * C3.57: every WORKFLOW L1 gate (synthetic hercules:* rows excluded) passed
   * on `verifiedSha`. Stamped on the task as `verified_gates_green` so a merge
   * whose tree is byte-identical to the verified tree can inherit L1 instead of
   * re-running it. Absent on older packets.
   */
  readonly workflowGatesPassed?: boolean;
  /**
   * When an L1 test/held-out gate failed, whether the same failure reproduces
   * on pure merge-base (trunk). Absent when not probed. See domain/gateFailAttribution.
   */
  readonly gateFailAttribution?: GateFailAttributionReport;
  /**
   * Host-operation receipt (command scope, outcome, post-check evidence).
   * Required surface for host_operation / deploy completion packets.
   */
  readonly hostOperationReceipt?: import('./executionClass.js').HostOperationReceipt;
  /**
   * Independent CLI behavioral-evidence receipt (trusted WORKFLOW argv dialect).
   * Distinct from browser CDP L2 evidenceRun.
   */
  readonly cliEvidence?: import('./cliEvidence.js').CliEvidenceReceipt;
  /**
   * Whether the L2 evidence run exercised the UI anchors this diff changed
   * (acceptance-binding grammar §6). Informational only — never flips green.
   * Absent when there are no file changes.
   */
  readonly l2Relevance?: import('./l2Relevance.js').L2RelevanceRecord;
}

/** Token usage + cost for a run (structurally the adapter's TokenUsage). */
export interface PacketUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

/** Marker the agent is told to end its final message with (see assemblePrompt). */
const SELF_ASSESSMENT_MARKER = '## Self-assessment';

/**
 * Split the agent's final message into its narrative report and the
 * `## Self-assessment` section it was asked to end with (SPEC §9.4). The report
 * becomes the packet's "Agent's report"; the self-assessment fills its dedicated
 * slot. When the marker is absent the whole message is the report and the
 * self-assessment is empty (the caller renders "(agent provided none)").
 */
export function splitFinalReport(finalReport: string): {
  readonly report: string;
  readonly selfAssessment: string;
} {
  // The agent is told to END with this section, so the LAST occurrence is the
  // real one — an earlier mention in the report's prose (e.g. a task documenting
  // Hercules) must not hijack the split.
  const idx = finalReport.lastIndexOf(SELF_ASSESSMENT_MARKER);
  if (idx < 0) return { report: finalReport.trim(), selfAssessment: '' };
  return {
    report: finalReport.slice(0, idx).trim(),
    selfAssessment: finalReport.slice(idx + SELF_ASSESSMENT_MARKER.length).trim(),
  };
}
