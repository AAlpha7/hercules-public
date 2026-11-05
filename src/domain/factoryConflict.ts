/**
 * Domain — Cursor Cloud factory CONFLICTING rework (pure).
 *
 * Local CLI conflict rework tells the agent to rebase `hercules/<id>`.
 * Cursor Cloud never created that branch. Factory rework must name the
 * existing Cloud Agent PR head and launch the next agent on that ref.
 */
import { isRemoteFactoryAdapter } from './agents.js';
import { hasOpenPr, type Task } from './task.js';
import { PR_CONFLICT_REQUEUE_CAP } from './thrash.js';

const FACTORY_HEAD_MARKER = /existing Cloud Agent branch `([^`]+)`/i;

/**
 * Git ref safety for a remote factory launch. Rejects traversal, option-like
 * refs, and empty segments. Task ids use {@link isValidIdentifier}; PR heads
 * may contain `/` (e.g. `cursor/cloud-T-factory-abc`).
 */
export function isSafeFactoryGitRef(ref: string): boolean {
  const value = ref.trim();
  if (value.length === 0 || value.length > 256) return false;
  if (value.startsWith('-') || value.endsWith('.lock')) return false;
  if (value.includes('..') || value.includes('//') || value.includes('\\')) {
    return false;
  }
  if (value.startsWith('/') || value.endsWith('/')) return false;
  if (value === '.' || value === '..') return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]$/.test(value) ||
    /^[A-Za-z0-9]$/.test(value);
}

/** Pull the factory PR head out of a system-steer / task body. */
export function extractFactoryPrHeadRef(text: string): string | null {
  const match = FACTORY_HEAD_MARKER.exec(text);
  const raw = match?.[1]?.trim() ?? '';
  if (!isSafeFactoryGitRef(raw)) return null;
  return raw;
}

/**
 * Launch ref for a factory dispatch. First runs stay on the default branch.
 * Open-PR rework uses a stored Cloud Agent head (conflict / CI / BEHIND
 * steer, or a dispatch-time GitHub observe after a failed agent).
 */
export function resolveFactoryLaunchRef(input: {
  readonly defaultBranch: string;
  readonly hasOpenPr: boolean;
  readonly pendingSteer?: string | null;
  readonly body?: string;
}): string {
  const fallback = input.defaultBranch.trim();
  if (!input.hasOpenPr) return fallback;
  const fromSteer = extractFactoryPrHeadRef(input.pendingSteer ?? '');
  if (fromSteer) return fromSteer;
  const fromBody = extractFactoryPrHeadRef(input.body ?? '');
  if (fromBody) return fromBody;
  return fallback;
}

/** True when an open factory PR has no stored Cloud Agent head to launch on. */
export function factoryLaunchNeedsObservedHead(input: {
  readonly hasOpenPr: boolean;
  readonly pendingSteer?: string | null;
  readonly body?: string;
}): boolean {
  if (!input.hasOpenPr) return false;
  return (
    extractFactoryPrHeadRef(input.pendingSteer ?? '') === null &&
    extractFactoryPrHeadRef(input.body ?? '') === null
  );
}

/**
 * Accept a GitHub-observed factory head. Rejects traversal and the repo
 * default — launching from default onto an open PR wastes the existing tip.
 */
export function acceptObservedFactoryHead(
  headRef: string,
  defaultBranch: string,
): string | null {
  const head = headRef.trim();
  if (!isSafeFactoryGitRef(head)) return null;
  if (head === defaultBranch.trim()) return null;
  return head;
}

/** Durable marker so later launches do not re-probe and the prompt names the head. */
export function buildFactoryObservedHeadSection(input: {
  readonly stamp: string;
  readonly prUrl: string;
  readonly headRef: string;
}): string {
  return [
    `## Factory PR head (${input.stamp})`,
    '',
    `Observed Cloud Agent head for the open PR (${input.prUrl}).`,
    `Work **only** on the existing Cloud Agent branch \`${input.headRef}\` (open PR tip).`,
    'Retry launches on that ref — do not start from the default branch and do not open a second PR.',
  ].join('\n');
}

export function buildFactoryConflictSteer(input: {
  readonly prUrl: string;
  readonly headRef: string;
  readonly defaultBranch: string;
  readonly taskId: string;
}): string {
  return (
    `Open PR is still CONFLICTING on GitHub (${input.prUrl}). ` +
    `Single source of truth: work **only** on the existing Cloud Agent branch \`${input.headRef}\` ` +
    `(the open PR tip). Do **not** create \`hercules/${input.taskId}\` and do **not** ` +
    `dual-write \`${input.defaultBranch}\` while the PR is open. ` +
    `In the Cloud Agent workspace: fetch origin, rebase or merge \`${input.defaultBranch}\` ` +
    `into \`${input.headRef}\`, resolve every conflict, commit, and push that same branch ` +
    `so the existing PR updates. Do not open a second PR. ` +
    `Do not claim success until mergeable is MERGEABLE.`
  );
}

export function buildFactoryConflictThrashSection(input: {
  readonly stamp: string;
  readonly prUrl: string;
  readonly headRef: string;
  readonly taskId: string;
}): string {
  return [
    `## Thrash brake (pr-mergeable) (${input.stamp})`,
    '',
    `Stopped auto re-queue after **${PR_CONFLICT_REQUEUE_CAP}** CONFLICTING system steers.`,
    `PR: ${input.prUrl}`,
    '',
    '### Single source of truth',
    `- Work **only** on the existing Cloud Agent branch \`${input.headRef}\` (open PR tip).`,
    `- Do **not** create \`hercules/${input.taskId}\` and do **not** dual-write main.`,
    '- Fetch, rebase/merge the default branch into that same branch, resolve, push it.',
    '',
    '### Next actions',
    '1. **Steer** with an explicit rebase instruction, or fix conflicts on the Cloud Agent branch',
    '2. Wait until the PR is MERGEABLE — do not open a second PR',
    '3. Close/reopen PR only if the branch tip is already correct',
    '',
  ].join('\n');
}

/** Factory tasks skip the local `hercules/<id>` conflict path. */
export function isFactoryConflictRework(task: Pick<Task, 'adapter' | 'agentSessionAdapter'>): boolean {
  return (
    isRemoteFactoryAdapter(task.adapter ?? '') ||
    isRemoteFactoryAdapter(task.agentSessionAdapter ?? '')
  );
}

export function factoryOpenPrDuties(task: Task): string | null {
  if (!hasOpenPr(task) || !isFactoryConflictRework(task)) return null;
  const head =
    extractFactoryPrHeadRef(task.pendingSteer ?? '') ??
    extractFactoryPrHeadRef(task.body);
  const headLine = head
    ? `Work **only** on the existing Cloud Agent branch \`${head}\` (open PR tip).`
    : 'Work **only** on the existing Cloud Agent PR branch (open PR tip).';
  return [
    '## Open factory PR on this task',
    `PR: ${task.prUrl}`,
    headLine,
    'If this run is about merge conflicts, CI, or PR feedback, you MUST:',
    '1. Fetch origin and rebase or merge the default branch into that same branch.',
    '2. Resolve every conflict; commit and push the same Cloud Agent branch.',
    '3. Update the existing PR — do not open a second PR, do not create `hercules/<id>`.',
    '4. Do not claim mergeable until the PR is actually conflict-free on GitHub.',
    '5. Mark the PR ready for review — do not leave it as a draft. Draft PRs cannot merge.',
  ].join('\n');
}
