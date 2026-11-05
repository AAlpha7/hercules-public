/**
 * Domain — run-finalize vs human-steer concurrency (midrun-steer-race).
 *
 * Pure helpers for:
 *   1. Optimistic completion: if a human moved the task while the old run was
 *      still finalizing (todo / cancel / delete), do not clobber state.
 *   2. pendingSteer honor: never leave a task in `review` while a steer is queued.
 *   3. Self-heal: `review` + non-empty pendingSteer past a threshold → todo.
 *
 * No I/O. Orchestrator applies the decisions when writing task files.
 */
import type { Task, TaskState } from './task.js';
import { canTransition } from './stateMachine.js';
import { neutralizeUntrustedPacketText } from './packetNeutralize.js';

/** How long review+pendingSteer may linger before the scheduler heals to todo. */
export const STUCK_REVIEW_PENDING_STEER_MS = 5 * 60 * 1000;

/**
 * True when a finishing run must NOT overwrite disk state: the operator already
 * took the task (steer/reject → todo, cancel, delete, or done).
 *
 * Applies to run-finalize targets (review / retrying / failed) when the caller
 * still thinks the run owns the task (in_progress / retrying), or when the
 * caller snapshot is already human-owned/terminal (reconcile saw todo while a
 * done run was still tracked). Dispatch and other transitions use the normal
 * path.
 */
export function shouldPreserveHumanRunState(input: {
  readonly currentState: TaskState;
  readonly expectedFrom: TaskState;
  readonly intendedTo: TaskState;
  readonly preserveRetrying?: boolean;
}): boolean {
  const fromRun =
    input.expectedFrom === 'in_progress' || input.expectedFrom === 'retrying';
  const finalizeTo =
    input.intendedTo === 'review' ||
    input.intendedTo === 'retrying' ||
    input.intendedTo === 'failed';
  // Stale complete()/fail() snapshot: disk already human-owned while a done
  // run was still tracked (Demo-ready-4). Refuse illegal finalize edges.
  const fromAlreadyHumanOwned =
    input.expectedFrom === 'todo' ||
    input.expectedFrom === 'cancelled' ||
    input.expectedFrom === 'deleted' ||
    input.expectedFrom === 'done' ||
    input.expectedFrom === 'failed' ||
    input.expectedFrom === 'review';
  if ((!fromRun && !fromAlreadyHumanOwned) || !finalizeTo) return false;

  // Human steer / reject / chat-pending re-queue.
  if (fromRun && input.currentState === 'todo') return true;
  if (!fromRun && input.currentState === 'todo' && !canTransition(input.currentState, input.intendedTo)) return true;
  if (input.currentState === 'retrying' && input.preserveRetrying === true) {
    return true;
  }
  // Human cancel or soft-delete while verify was still running.
  if (input.currentState === 'cancelled' || input.currentState === 'deleted') {
    return true;
  }
  // Approve path already closed the loop.
  if (input.currentState === 'done' && (fromRun || !canTransition('done', input.intendedTo))) return true;
  if (input.currentState === 'failed') return true;
  if (input.currentState === 'review' && input.intendedTo !== 'review') return true;
  return false;
}

/** Detect a switch-now append that landed after this run's task snapshot. */
export function isConcurrentAgentSwitch(
  priorBody: string,
  current: Pick<Task, 'state' | 'body' | 'agentSession'>,
): boolean {
  if (current.state !== 'retrying' || current.agentSession !== null) return false;
  const prior = priorBody.trim();
  if (!current.body.startsWith(prior)) return false;
  return /^\s*## Agent switch \(/.test(current.body.slice(prior.length));
}

/**
 * When finalizing to review, a non-empty pendingSteer means the human already
 * queued follow-up work — park as todo so the next tick can dispatch (never
 * review + pendingSteer dead state).
 */
export function honorPendingSteerOnReview(input: {
  readonly intendedTo: TaskState;
  readonly pendingSteer: string | null | undefined;
}): TaskState {
  if (input.intendedTo !== 'review') return input.intendedTo;
  const steer = input.pendingSteer?.trim() ?? '';
  if (steer.length === 0) return input.intendedTo;
  return 'todo';
}

/**
 * Dead state from the 2026-07-31 failfast-negation-context incident:
 * review + pendingSteer + expired next-eligible (no dispatcher owns review).
 */
export function isStuckReviewWithPendingSteer(
  task: Pick<Task, 'state' | 'pendingSteer' | 'endedAt' | 'lastEventAt' | 'createdAt'>,
  nowMs: number,
  thresholdMs: number = STUCK_REVIEW_PENDING_STEER_MS,
): boolean {
  if (task.state !== 'review') return false;
  if ((task.pendingSteer?.trim() ?? '').length === 0) return false;
  if (thresholdMs <= 0) return true;
  const anchor = task.endedAt ?? task.lastEventAt ?? task.createdAt;
  if (!anchor) return true;
  const ms = Date.parse(anchor);
  if (!Number.isFinite(ms)) return true;
  return nowMs - ms >= thresholdMs;
}

/** Timeline section for self-heal (phone packet + audit). */
export function buildStuckReviewSteerHealSection(input: {
  readonly stamp: string;
  readonly pendingSteerPreview: string;
  readonly stuckForMs: number;
}): string {
  const preview = input.pendingSteerPreview.trim().slice(0, 200);
  const mins = Math.max(1, Math.round(input.stuckForMs / 60_000));
  return [
    `## Self-heal (stuck review+steer) (${input.stamp})`,
    '',
    `Found **review** with non-empty \`pending_steer\` for ~${mins}m — ` +
      'no dispatcher owns review, so the task was moved to **todo** to honor the steer.',
    '',
    preview.length > 0
      ? `Pending steer (preview): ${neutralizeUntrustedPacketText(preview)}`
      : 'Pending steer was set.',
    '',
  ].join('\n');
}

const PACKET_V1_HEADER_LINE_RE =
  /^\s*<!--\s*hercules:packet\s+v1\s+nonce=([0-9a-fA-F]+)\s*-->\s*$/;
const PACKET_TRAIL_HEADING_RE = /^## (?:Human steer|Steer result|Teardown)\b/m;

/**
 * Cut review-packet interior text at the matching `packet-end` fence when a
 * whole-line header fence is present; otherwise at the first trail heading
 * (`Human steer` / `Steer result` / `Teardown`). Agent prose that embeds a
 * trail-looking `## Human steer (…)` before `packet-end` must not truncate the
 * packet (decision-card / fences stay intact for `writeFinalizePacketOnly`).
 */
export function cutReviewPacketInterior(interior: string): string {
  if (interior.length === 0) return interior;
  const lines = interior.split('\n');
  let headerNonce: string | null = null;
  let headerLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (PACKET_TRAIL_HEADING_RE.test(line) || /^##\s+Review packet\b/i.test(line)) {
      break;
    }
    const hm = PACKET_V1_HEADER_LINE_RE.exec(line);
    if (hm && hm[1]) {
      headerNonce = hm[1];
      headerLine = i;
      break;
    }
  }
  if (headerNonce !== null) {
    const endFenceRe = new RegExp(
      `^\\s*<!--\\s*hercules:packet-end\\s+nonce=${headerNonce}\\s*-->\\s*$`,
    );
    for (let i = headerLine + 1; i < lines.length; i += 1) {
      if (endFenceRe.test(lines[i]!)) {
        return lines.slice(0, i + 1).join('\n');
      }
    }
  }
  const trailAt = interior.search(PACKET_TRAIL_HEADING_RE);
  return trailAt >= 0 ? interior.slice(0, trailAt) : interior;
}

/**
 * Extract the review-packet payload (content under `## Review packet`, before
 * any human trail) from a full task body. Used when folding a finalize body
 * into a human-owned task without clobbering `## Human steer` trails.
 *
 * When the packet carries a whole-line header fence, the payload ends at the
 * matching `packet-end` line (trail headings inside agent prose are ignored
 * until after that fence).
 */
export function extractReviewPacketContent(body: string): string | null {
  // Whole-line heading only — mid-line "see ## Review packet" is not a packet.
  const headingRe = /^##\s+Review packet\b/im;
  const hm = headingRe.exec(body);
  if (!hm || hm.index === undefined) return null;
  const after = body.slice(hm.index + hm[0].length);
  const content = cutReviewPacketInterior(after).trim();
  return content.length > 0 ? content : null;
}

/**
 * Cap for a combined Remote Control pending_steer (matches ActionService.steer
 * / SESSION_MESSAGE_MAX_CHARS). complete() drains the whole mid-run chat queue
 * into one steer so N messages do not force N requeue + verify cycles.
 */
export const MAX_COMBINED_PENDING_STEER_CHARS = 8000;

export interface CombinedPendingChat {
  /** Order-preserving combined text (empty when nothing usable). */
  readonly text: string;
  /** Non-blank messages that contributed (pre-truncation). */
  readonly count: number;
}

/**
 * Combine drained Remote Control chat lines into one pending_steer payload.
 * Preserves queue order; blanks dropped; total length hard-bounded.
 */
export function combinePendingChatMessages(
  messages: readonly string[],
  maxChars: number = MAX_COMBINED_PENDING_STEER_CHARS,
): CombinedPendingChat {
  const parts = messages
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  if (parts.length === 0) return { text: '', count: 0 };

  const cap =
    typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars > 0
      ? Math.floor(maxChars)
      : MAX_COMBINED_PENDING_STEER_CHARS;

  let text =
    parts.length === 1
      ? parts[0]!
      : parts.map((p, i) => `[${i + 1}/${parts.length}] ${p}`).join('\n\n');

  if (text.length > cap) {
    text = cap <= 1 ? '…' : `${text.slice(0, cap - 1)}…`;
  }
  return { text, count: parts.length };
}
