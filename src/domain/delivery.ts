/**
 * Domain layer — delivery honesty (system-level non-result detection).
 *
 * Problem this solves: implementer finishes with **zero worktree diff** but
 * claims the feature is "live/shipped", then parks in human review. Humans see
 * a soft "no file changes — maybe Q&A" banner and a confident agent narrative.
 *
 * Policy (defaults):
 * - **Task intent wins over run kind.** If the task title/body is an
 *   implementation ask (UI/fix/设置页/…), empty worktree vs base is a fail
 *   even on **steer** follow-ups ("ready了吗", "请自审"). Steer is only
 *   no-diff-ok when the *task itself* is analysis/Q&A or opts out.
 * - Once the branch has real commits, `filesTouched` is non-empty and steers
 *   can chat without rework noise.
 * - Empty diff + false delivery claim → hard fail + auto-rework always.
 *
 * Case study (`logout`): Settings was implemented then steers parked in review
 * as "allowed no-diff" while the branch was discarded — human saw green gates
 * and a review queue item that was not shippable.
 */
import type { PacketRunKind } from './verification.js';

/** Whether this completion is allowed to leave the worktree unchanged. */
export type DeliveryExpectation = 'file-changes' | 'no-diff-ok';

export interface DeliveryAssessment {
  readonly expectation: DeliveryExpectation;
  /** True when zero-diff is not acceptable for this run. */
  readonly deliveryFailed: boolean;
  /** Human/agent-readable reason (null when ok). */
  readonly reason: string | null;
  /** Re-queue implementer instead of human review. */
  readonly autoRework: boolean;
  /** Details for cheatFindings / packet warnings. */
  readonly claimHits: readonly string[];
}

/** Explicit opt-out: task allows a no-diff completion. */
const NO_DIFF_OK_MARKERS = [
  /<!--\s*hercules:no-diff-ok\s*-->/i,
  /\bhercules:no-diff-ok\b/i,
  /\b\(no-diff-ok\)\b/i,
];

const READONLY_LABELS = new Set([
  'readonly',
  'read-only',
  'read_only',
  'analysis',
  'research',
  'investigate',
  'docs-only',
  'docs_only',
  'qa-only',
  'qa_only',
  'q&a',
  'qa',
]);

/** Title signals that this is pure analysis / Q&A (no code expected). */
const ANALYSIS_ONLY_RE =
  /^(?:分析|调研|调查|总结|评估|对照|review\s+only\b|investigate\b|analyze\b|summarize\b|research\b)/i;

/** Strong implement signals (Chinese + English). */
const IMPLEMENT_RE =
  /实现|改成|修改|修复|增加|添加|重构|页面|功能|组件|接入|对接|fix\b|feat\b|implement|add\b|change\b|update\b|refactor|ui\b|settings?|登录|登出|logout|设置页/i;

/**
 * Agent claims of product delivery without a diff (speech is not proof).
 * Keep high-precision; false positives auto-rework an honest Q&A.
 */
const FALSE_DELIVERY_CLAIM_RE =
  /已上线|已经上线|已经完成|已完成实现|功能已就绪|功能已落地|设置页已|Settings\s*(page\s*)?(is\s*)?(live|ready|shipped)|shipped\s+to\s+(main|prod)|now\s+live\s+on\s+(main|prod)|bottom\s+nav\s+is\s+Settings|底部\s*\*?\*?设置|请你在手机上点开试一下/i;

/** Strip prior review packets so re-runs judge the original task intent. */
export function stripReviewAndSteerSections(body: string): string {
  let out = body;
  // Drop from first ## Review packet / ### taskId packet heading onward if present
  // but keep human steer sections before that when possible.
  const packet = /^##\s+Review packet\b/im.exec(out);
  if (packet && packet.index !== undefined) {
    out = out.slice(0, packet.index);
  }
  return out.trim();
}

export function hasNoDiffOkMarker(body: string, labels: readonly string[] = []): boolean {
  if (labels.some((l) => READONLY_LABELS.has(l.trim().toLowerCase()))) return true;
  const text = stripReviewAndSteerSections(body);
  return NO_DIFF_OK_MARKERS.some((re) => re.test(text));
}

/**
 * Decide whether this completion must leave a non-empty worktree diff.
 */
export function deliveryExpectation(input: {
  readonly title: string;
  readonly body: string;
  readonly labels?: readonly string[];
  readonly runKind: PacketRunKind;
}): DeliveryExpectation {
  const labels = input.labels ?? [];
  const body = stripReviewAndSteerSections(input.body);
  const title = input.title.trim();

  if (hasNoDiffOkMarker(body, labels)) return 'no-diff-ok';

  const intentBlob = `${title}\n${body.slice(0, 800)}`;
  const looksLikeImplement = IMPLEMENT_RE.test(intentBlob);
  const looksLikeAnalysisOnly =
    ANALYSIS_ONLY_RE.test(title) && !looksLikeImplement;

  // Explicit analysis-only phrasing in title (and no implement signals).
  if (looksLikeAnalysisOnly) return 'no-diff-ok';

  // Implementation task intent always requires a non-empty worktree vs base —
  // including on steer resumes. Otherwise "ready了吗" parks incomplete work
  // in human review with vacuous green gates.
  if (looksLikeImplement) return 'file-changes';

  // Steer on a non-implement task (pure follow-up / ops Q&A) may be no-diff.
  if (input.runKind === 'steer') return 'no-diff-ok';

  // Default implementer: expect files. Pure empty "hello" tasks are rare;
  // operators can mark no-diff-ok.
  return 'file-changes';
}

/** Extract high-precision false-delivery claim snippets from agent text. */
export function findFalseDeliveryClaims(...texts: readonly string[]): string[] {
  const hits: string[] = [];
  for (const raw of texts) {
    if (!raw || raw.trim().length === 0) continue;
    const m = FALSE_DELIVERY_CLAIM_RE.exec(raw);
    if (m) hits.push(m[0]!.slice(0, 80));
  }
  return hits;
}

/**
 * Core honesty check used by the review packet assembler.
 */
export function assessDeliveryHonesty(input: {
  readonly title: string;
  readonly body: string;
  readonly labels?: readonly string[];
  readonly runKind: PacketRunKind;
  readonly noFileChanges: boolean;
  readonly finalReport?: string;
  readonly selfAssessment?: string;
}): DeliveryAssessment {
  const expectation = deliveryExpectation({
    title: input.title,
    body: input.body,
    labels: input.labels ?? [],
    runKind: input.runKind,
  });
  const claimHits = input.noFileChanges
    ? findFalseDeliveryClaims(input.finalReport ?? '', input.selfAssessment ?? '')
    : [];

  if (!input.noFileChanges) {
    return {
      expectation,
      deliveryFailed: false,
      reason: null,
      autoRework: false,
      claimHits: [],
    };
  }

  // Zero-diff path.
  if (claimHits.length > 0) {
    return {
      expectation,
      deliveryFailed: true,
      reason:
        'Agent report claims delivery/shipped ("' +
        claimHits[0] +
        '") but the worktree has no file changes vs base. Speech is not proof.',
      autoRework: true,
      claimHits,
    };
  }

  if (expectation === 'file-changes') {
    return {
      expectation,
      deliveryFailed: true,
      reason:
        'This task expects file changes (implementation), but the worktree diff is empty. ' +
        'Mark `hercules:no-diff-ok` / label `analysis` only for true Q&A.',
      autoRework: true,
      claimHits: [],
    };
  }

  return {
    expectation,
    deliveryFailed: false,
    reason: null,
    autoRework: false,
    claimHits: [],
  };
}
