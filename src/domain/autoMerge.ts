/**
 * Domain — per-repo auto-merge pilot policy + pure eligibility evaluator.
 *
 * Pure: no IO. The daemon sweep (sibling job) calls {@link evaluateAutoMerge}
 * with facts gathered from the task body and trusted-mirror diff.
 */
import type { Task } from './task.js';
import {
  classifyDiffSize,
  isSensitivePath,
  type DiffSizeClass,
} from './release.js';
import { parseDecisionCard } from './decisionCard.js';
import { resolveRunTimeline } from './runTimeline.js';
import { listHumanCriteriaTexts } from './acceptance.js';

export type AutoMergeMaxSize = 'S' | 'M' | 'L';

/** Per-repo auto-merge pilot policy (repos.yaml `auto_merge`). */
export interface AutoMergePolicy {
  readonly enabled: boolean;
  /** Minutes a green task must sit in review before the daemon approves it. */
  readonly dwellMinutes: number;
  /** Largest diff size class (classifyDiffSize) the pilot may merge. */
  readonly maxSize: AutoMergeMaxSize;
}

export const AUTO_MERGE_DEFAULTS: Readonly<Pick<AutoMergePolicy, 'dwellMinutes' | 'maxSize'>> =
  { dwellMinutes: 30, maxSize: 'M' };
export const AUTO_MERGE_DWELL_MAX = 1440;
/** Label stamped on a task the pilot approved. */
export const AUTO_MERGE_LABEL = 'auto-merged';
/** Per-task opt-out label: never auto-merge this task. */
export const AUTO_MERGE_OPT_OUT_LABEL = 'no-auto-merge';

const SIZE_RANK: Record<DiffSizeClass, number> = { S: 0, M: 1, L: 2 };

export function isAutoMergeMaxSize(v: unknown): v is AutoMergeMaxSize {
  return v === 'S' || v === 'M' || v === 'L';
}

/**
 * Validate a partial policy (API patch / yaml) into a full one over
 * AUTO_MERGE_DEFAULTS. Throws Error with a precise message on bad input:
 * enabled not boolean; dwellMinutes not an integer in [0, AUTO_MERGE_DWELL_MAX];
 * maxSize not S|M|L; unknown keys.
 */
export function resolveAutoMergePolicy(raw: unknown): AutoMergePolicy {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('autoMerge must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const allowed = new Set(['enabled', 'dwellMinutes', 'maxSize']);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(`unknown autoMerge key '${key}'`);
    }
  }
  if (typeof obj['enabled'] !== 'boolean') {
    throw new Error('enabled must be a boolean');
  }
  let dwellMinutes = AUTO_MERGE_DEFAULTS.dwellMinutes;
  if (Object.prototype.hasOwnProperty.call(obj, 'dwellMinutes')) {
    const d = obj['dwellMinutes'];
    if (
      typeof d !== 'number' ||
      !Number.isInteger(d) ||
      d < 0 ||
      d > AUTO_MERGE_DWELL_MAX
    ) {
      throw new Error(
        `dwellMinutes must be an integer in [0, ${AUTO_MERGE_DWELL_MAX}]`,
      );
    }
    dwellMinutes = d;
  }
  let maxSize: AutoMergeMaxSize = AUTO_MERGE_DEFAULTS.maxSize;
  if (Object.prototype.hasOwnProperty.call(obj, 'maxSize')) {
    if (!isAutoMergeMaxSize(obj['maxSize'])) {
      throw new Error('maxSize must be S|M|L');
    }
    maxSize = obj['maxSize'];
  }
  return {
    enabled: obj['enabled'],
    dwellMinutes,
    maxSize,
  };
}

export interface AutoMergeDiff {
  readonly files: readonly string[];
  readonly insertions: number;
  readonly deletions: number;
}

export type AutoMergeVerdict =
  | {
      readonly eligible: true;
      readonly linesChanged: number;
      readonly size: DiffSizeClass;
      readonly dwellMinutes: number;
    }
  | { readonly eligible: false; readonly reason: string };

/**
 * Pure eligibility check for the auto-merge pilot. Fail-closed: any missing
 * fact is a reason, never a pass. `diff` is the task branch vs the default
 * branch merge-base (null = unavailable).
 */
export function evaluateAutoMerge(input: {
  readonly task: Task;
  readonly policy: AutoMergePolicy | null | undefined;
  readonly diff: AutoMergeDiff | null;
  readonly now: Date;
}): AutoMergeVerdict {
  const { task, policy, diff, now } = input;

  if (!policy || !policy.enabled) {
    return { eligible: false, reason: 'auto-merge disabled for repo' };
  }
  if (task.state !== 'review') {
    return { eligible: false, reason: 'not in review' };
  }
  if (task.labels.includes(AUTO_MERGE_OPT_OUT_LABEL)) {
    return { eligible: false, reason: 'opted out (no-auto-merge label)' };
  }
  if (hasAutoMergeNote(task.body)) {
    return { eligible: false, reason: 'auto-merge already attempted (needs a human)' };
  }
  if (!task.verifiedSha) {
    return { eligible: false, reason: 'no verified sha' };
  }
  if (task.pendingSteer !== null) {
    return { eligible: false, reason: 'pending steer' };
  }
  if (task.planPending === true) {
    return { eligible: false, reason: 'plan pending' };
  }

  const timeline = resolveRunTimeline(task.body);
  let lastFinalize: { readonly ok?: boolean } | undefined;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i]!;
    if (e.kind === 'packet_finalize') {
      lastFinalize = e;
      break;
    }
  }
  if (!lastFinalize) {
    return { eligible: false, reason: 'no finalized packet' };
  }
  if (lastFinalize.ok !== true) {
    return { eligible: false, reason: 'packet not green' };
  }

  const card = parseDecisionCard(task.body);
  if (!card) {
    return { eligible: false, reason: 'no decision card' };
  }
  if (card.boundaries.protectedPathsTouched) {
    return { eligible: false, reason: 'protected paths touched' };
  }
  if (!card.reviewer.ran) {
    return { eligible: false, reason: 'L3 reviewer did not run' };
  }
  if (card.reviewer.approved !== true) {
    return { eligible: false, reason: 'L3 not approved' };
  }
  for (const g of card.gates) {
    if (g.passed === false && g.outcome === undefined) {
      return { eligible: false, reason: `gate failed: ${g.name}` };
    }
  }

  const human = listHumanCriteriaTexts(task.body);
  if (human.length > 0) {
    return {
      eligible: false,
      reason: `human acceptance criteria present (${human.length})`,
    };
  }

  const anchorRaw = task.endedAt ?? task.lastEventAt;
  if (!anchorRaw) {
    return { eligible: false, reason: 'no review timestamp' };
  }
  const anchorMs = Date.parse(anchorRaw);
  if (!Number.isFinite(anchorMs)) {
    return { eligible: false, reason: 'no review timestamp' };
  }
  const elapsed = Math.floor((now.getTime() - anchorMs) / 60_000);
  if (elapsed < policy.dwellMinutes) {
    return {
      eligible: false,
      reason: `dwell ${elapsed}/${policy.dwellMinutes} min`,
    };
  }

  if (diff === null) {
    return { eligible: false, reason: 'diff unavailable' };
  }
  for (const file of diff.files) {
    if (isSensitivePath(file)) {
      return { eligible: false, reason: `sensitive path: ${file}` };
    }
  }
  const linesChanged = diff.insertions + diff.deletions;
  const size = classifyDiffSize(linesChanged);
  if (SIZE_RANK[size] > SIZE_RANK[policy.maxSize]) {
    return {
      eligible: false,
      reason: `diff ${size} exceeds ${policy.maxSize}`,
    };
  }

  return {
    eligible: true,
    linesChanged,
    size,
    dwellMinutes: elapsed,
  };
}

/** `## Auto-merge (<stamp>)` section appended when the pilot approves. */
export function appendAutoMergeNote(body: string, stamp: string, detail: string): string {
  return `${body.trimEnd()}\n\n## Auto-merge (${stamp})\n\n${detail}\n`;
}

/** True when the body already carries an `## Auto-merge (` heading (attempted before). */
export function hasAutoMergeNote(body: string): boolean {
  return /^## Auto-merge \(/m.test(body);
}
