/**
 * Domain — thrash detection so identical failures do not burn remaining attempts.
 *
 * Case studies:
 * - agent_exit ×3 with no packet (orbit onboarding) — park after N consecutive
 * - PR CONFLICTING system-steer requeue loop — cap auto requeues
 *
 * Pure parse of task body trail; no I/O.
 */
import {
  bodyForFailureAccounting,
  DEFAULT_KIND_POLICY,
  isRunFailureKind,
  type RunFailureKind,
} from './retryPolicy.js';
import { neutralizeUntrustedPacketText } from './packetNeutralize.js';

/** Park early after this many consecutive same-kind Run failures (inclusive). */
export const THRASH_CONSECUTIVE_LIMIT = DEFAULT_KIND_POLICY.agent_exit.thrashLimit;

/** Max automatic pr-mergeable system steers before leaving it to the human. */
export const PR_CONFLICT_REQUEUE_CAP = 2;

// Note: no trailing \b after `)` — JS word-boundary does not match after `)`.
const RUN_FAILURE_KIND_RE = /##\s+Run failure\b[\s\S]*?\*\*Kind:\*\*\s*`([^`]+)`/gi;
const PR_MERGEABLE_STEER_RE = /##\s+System steer \(pr-mergeable\)/gi;
const PR_CONFLICT_CAP_RE = /##\s+Thrash brake \(pr-mergeable\)/i;

export interface TrailingFailureStreak {
  readonly kind: RunFailureKind;
  readonly count: number;
}

function asRunFailureKind(raw: string): RunFailureKind | null {
  const k = raw.trim();
  return isRunFailureKind(k) ? k : null;
}

/**
 * Count trailing consecutive Run failure sections that share the same kind
 * (from the end of the body).
 */
export function trailingRunFailureStreak(body: string): TrailingFailureStreak | null {
  const scoped = bodyForFailureAccounting(body);
  const kinds: RunFailureKind[] = [];
  const re = new RegExp(RUN_FAILURE_KIND_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(scoped)) !== null) {
    const k = asRunFailureKind(m[1] ?? '');
    if (k) kinds.push(k);
  }
  if (kinds.length === 0) return null;
  const last = kinds[kinds.length - 1]!;
  let count = 0;
  for (let i = kinds.length - 1; i >= 0; i -= 1) {
    if (kinds[i] === last) count += 1;
    else break;
  }
  return { kind: last, count };
}

/**
 * After writing one more failure of `nextKind`, should we park as failed even
 * if attempts < maxAttempts?
 */
export function shouldParkForThrash(input: {
  readonly body: string;
  readonly nextKind: RunFailureKind;
  readonly attemptsAfter: number;
  readonly maxAttempts: number;
  readonly limit?: number;
}): boolean {
  if (input.attemptsAfter >= input.maxAttempts) return false; // normal exhaust path
  const limit = input.limit ?? THRASH_CONSECUTIVE_LIMIT;
  const streak = trailingRunFailureStreak(input.body);
  const prior = streak && streak.kind === input.nextKind ? streak.count : 0;
  return prior + 1 >= limit;
}

/** How many pr-mergeable system steers already appear in the body. */
export function countPrMergeableSteers(body: string): number {
  const re = new RegExp(PR_MERGEABLE_STEER_RE.source, 'gi');
  let n = 0;
  while (re.exec(body) !== null) n += 1;
  return n;
}

export function shouldCapPrConflictRequeue(body: string): boolean {
  if (PR_CONFLICT_CAP_RE.test(body)) return true; // already capped once
  return countPrMergeableSteers(body) >= PR_CONFLICT_REQUEUE_CAP;
}

export function buildPrConflictThrashSection(input: {
  readonly stamp: string;
  readonly prUrl: string;
  readonly taskId: string;
}): string {
  return [
    `## Thrash brake (pr-mergeable) (${input.stamp})`,
    '',
    `Stopped auto re-queue after **${PR_CONFLICT_REQUEUE_CAP}** CONFLICTING system steers.`,
    `PR: ${neutralizeUntrustedPacketText(input.prUrl)}`,
    '',
    '### Single source of truth',
    `- Work **only** on branch \`hercules/${input.taskId}\` (open PR tip).`,
    '- Do **not** dual-write main while the PR is open — that re-creates CONFLICTING.',
    '- Fetch, rebase/merge default branch into the task branch, resolve, push the same branch.',
    '',
    '### Next actions',
    '1. **Steer** with an explicit rebase instruction, or fix conflicts offline',
    '2. **Re-verify** after the PR is MERGEABLE',
    '3. Close/reopen PR only if the branch tip is already correct',
    '',
  ].join('\n');
}

export function thrashNoteForRunFailure(kind: RunFailureKind, consecutive: number): string {
  return (
    `**Thrash:** parked early after **${consecutive}×** consecutive \`${kind}\` ` +
    `(limit ${THRASH_CONSECUTIVE_LIMIT}) — remaining attempts not burned on the same death.`
  );
}
