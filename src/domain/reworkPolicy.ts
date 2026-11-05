/**
 * Domain layer — L3 auto-rework path selection.
 *
 * When verification fails hard enough to auto-requeue, choose a **cheap steer
 * resume** (session continue + short prompt) vs a **full implementer re-dispatch**
 * (full WORKFLOW + task body, no resume). Pure heuristics from packet signals.
 *
 * Goals: cut cost on multi-attempt onboard when L3 only wants nits; escalate to
 * full when mechanical fails, design is wrong, or a prior steer already failed.
 */
import type { DodDimensions } from './acceptance.js';
import type { ReviewerVerdict } from './verification.js';

/** Cheap session resume with L3 feedback as pendingSteer. */
export type ReworkPath = 'steer' | 'full';

export interface ReworkPathDecision {
  readonly path: ReworkPath;
  /** Short human-readable why — shown on the review packet. */
  readonly reason: string;
}

/** Files touched above this → treat as large (full re-dispatch). */
export const SMALL_DIFF_MAX_FILES = 5;
/** Insertions+deletions above this → treat as large. */
export const SMALL_DIFF_MAX_LINES = 80;

/**
 * Design / approach failures — session resume is unlikely to fix; need a full
 * re-plan with WORKFLOW + task body in context.
 */
const DESIGN_ISSUE_RE =
  /\b(redesign|re-?architect|architecture|wrong approach|start over|rewrite|overhaul|wrong abstraction|fundamental|scope creep|security (?:hole|issue|vuln)|needs? (?:a )?different|entirely wrong|from scratch|major redesign|wrong design)\b/i;

/**
 * Comment-only / polish signals — cheap resume is appropriate when the diff is
 * also small.
 */
const COMMENT_ONLY_RE =
  /\b(typo|comment|wording|naming|docs?|documentation|nits?|polish|self-assessment|clarify|spelling|grammar|rename|minor|cosmetic|style only|expand (?:the )?self-assessment|evidence citation)\b/i;

/** Parse insertions+deletions from `git diff --shortstat` text. */
export function parseDiffLineCount(diffSummary: string): number {
  let total = 0;
  const ins = /(\d+)\s+insertions?\(\+\)/.exec(diffSummary);
  const del = /(\d+)\s+deletions?\(-\)/.exec(diffSummary);
  if (ins) total += Number(ins[1]);
  if (del) total += Number(del[1]);
  return total;
}

function isSmallDiff(filesTouched: readonly string[], diffSummary: string): boolean {
  if (filesTouched.length > SMALL_DIFF_MAX_FILES) return false;
  const lines = parseDiffLineCount(diffSummary);
  // Unknown line count (summary without shortstat) still allows small-by-files.
  if (lines > SMALL_DIFF_MAX_LINES) return false;
  return true;
}

function l3FeedbackText(
  verdict: Pick<ReviewerVerdict, 'summary' | 'comments'> | null,
): string {
  if (!verdict) return '';
  return [verdict.summary, ...verdict.comments].join('\n');
}

export interface ChooseReworkPathInput {
  readonly autoRework: boolean;
  readonly dimensions: Pick<DodDimensions, 'mechanical' | 'reviewer'>;
  readonly filesTouched: readonly string[];
  readonly diffSummary: string;
  readonly reviewerVerdict: Pick<ReviewerVerdict, 'summary' | 'comments'> | null;
  /** Empty-diff delivery honesty failure. */
  readonly deliveryFailed?: boolean;
  /**
   * Prior verification run was already a steer resume. Escalate to full so we
   * do not cheap-steer forever on a stubborn L3 fail.
   */
  readonly priorRunWasSteer?: boolean;
  /**
   * Whether an adapter session id exists to resume. When explicitly false,
   * force full (orchestrator cannot steer without a session).
   */
  readonly hasSession?: boolean;
}

/**
 * Decide steer vs full when `autoRework` is true; otherwise null (no rework path).
 *
 * Order (first match wins):
 * 1. delivery fail → full
 * 2. mechanical (L1) fail → full
 * 3. prior run was steer → full (anti-loop)
 * 4. no session → full
 * 5. design-issue L3 language → full
 * 6. large diff → full
 * 7. comment-only / polish L3 on small diff → steer
 * 8. small diff + L3-only fail → steer
 * 9. default → full
 */
export function chooseReworkPath(input: ChooseReworkPathInput): ReworkPathDecision | null {
  if (!input.autoRework) return null;

  if (input.deliveryFailed === true) {
    return { path: 'full', reason: 'delivery check failed — needs real worktree changes' };
  }

  if (input.dimensions.mechanical === 'fail') {
    return {
      path: 'full',
      reason: 'L1/mechanical failed — full re-dispatch with gates context',
    };
  }

  if (input.priorRunWasSteer === true) {
    return {
      path: 'full',
      reason: 'prior steer still failed L3 — escalate to full (anti-loop)',
    };
  }

  if (input.hasSession === false) {
    return {
      path: 'full',
      reason: 'no agent session to resume — full implementer re-dispatch',
    };
  }

  const feedback = l3FeedbackText(input.reviewerVerdict);
  if (feedback.length > 0 && DESIGN_ISSUE_RE.test(feedback)) {
    return {
      path: 'full',
      reason: 'L3 reports design/architecture issues — full re-plan',
    };
  }

  const files = input.filesTouched.length;
  const lines = parseDiffLineCount(input.diffSummary);
  const small = isSmallDiff(input.filesTouched, input.diffSummary);

  if (!small) {
    const sizeBit =
      files > SMALL_DIFF_MAX_FILES
        ? `${files} files (>${SMALL_DIFF_MAX_FILES})`
        : `${lines} lines (>${SMALL_DIFF_MAX_LINES})`;
    return {
      path: 'full',
      reason: `large diff (${sizeBit}) — full re-dispatch`,
    };
  }

  const l3Only =
    input.dimensions.reviewer === 'fail' && input.dimensions.mechanical === 'pass';

  if (l3Only && feedback.length > 0 && COMMENT_ONLY_RE.test(feedback)) {
    return {
      path: 'steer',
      reason: `comment/polish L3 on small diff (${files} file(s), ${lines || '≤?'} lines)`,
    };
  }

  if (l3Only && small) {
    return {
      path: 'steer',
      reason: `small diff L3-only fail (${files} file(s), ${lines || '≤?'} lines) — cheap resume`,
    };
  }

  return {
    path: 'full',
    reason: 'default full re-dispatch (not a small L3-only nit)',
  };
}

/**
 * Text for `pending_steer` when the rework path is steer. Resume prompt is short;
 * the full packet remains on the task body for audit.
 */
export function buildL3SteerMessage(
  verdict: Pick<ReviewerVerdict, 'summary' | 'comments'>,
): string {
  const lines: string[] = [
    'L3 requested changes — fix these on a short session resume (do not re-plan the whole task):',
    '',
  ];
  const summary = verdict.summary.trim();
  if (summary.length > 0) {
    lines.push(`SUMMARY: ${summary}`);
    lines.push('');
  }
  if (verdict.comments.length > 0) {
    for (const c of verdict.comments) {
      const t = c.trim();
      if (t.length > 0) lines.push(`- ${t}`);
    }
    lines.push('');
  }
  lines.push(
    'Then finish with a clean narrative + one `## Self-assessment`. Full review packet is on the task body.',
  );
  return lines.join('\n');
}
