/**
 * Domain — Cursor Cloud factory draft → ready (pure).
 *
 * Cursor Cloud Agents open PRs as drafts. A draft cannot merge, so ring 4
 * close-out never fires and dependents stay blocked. Marking ready is a
 * GitHub merge-gate bit — not Approve, not merge.
 */
import { hasOpenPr, type Task } from './task.js';
import { isFactoryConflictRework } from './factoryConflict.js';

const FACTORY_READY_AUDIT_RE = /##\s+Factory PR marked ready/i;

/** GitHub draft bit, or mergeStateStatus DRAFT when isDraft was omitted. */
export function isFactoryDraft(input: {
  readonly isDraft: boolean;
  readonly mergeStateStatus?: string | null;
}): boolean {
  if (input.isDraft) return true;
  return (input.mergeStateStatus ?? '').trim().toUpperCase() === 'DRAFT';
}

/**
 * Convert a finished factory draft so the human can merge (ring 4).
 * Skip when an audit already landed — do not hammer `gh pr ready`.
 */
export function shouldMarkFactoryPrReady(input: {
  readonly isDraft: boolean;
  readonly mergeStateStatus?: string | null;
  readonly body: string;
}): boolean {
  if (!isFactoryDraft(input)) return false;
  if (FACTORY_READY_AUDIT_RE.test(input.body)) return false;
  return true;
}

export function buildFactoryReadyAuditSection(input: {
  readonly stamp: string;
  readonly prUrl: string;
}): string {
  return [
    `## Factory PR marked ready (${input.stamp})`,
    '',
    `Converted the open factory PR from draft to ready for review (${input.prUrl}).`,
    'Not an Approve. Not a merge. Human merge still required.',
    '',
  ].join('\n');
}

/**
 * First factory launch: done artifact is a ready-for-review GitHub PR.
 * Open-PR rework uses {@link factoryOpenPrDuties} instead.
 */
export function factoryFirstLaunchDuties(
  task: Pick<Task, 'adapter' | 'agentSessionAdapter' | 'prUrl' | 'prStatus'>,
): string | null {
  if (hasOpenPr(task) || !isFactoryConflictRework(task)) return null;
  return [
    '## Factory PR (done artifact)',
    'This run is a Cursor Cloud factory task. Success is an open GitHub pull request.',
    'When you finish:',
    '1. Open exactly one PR against the repo default branch (autoCreatePr is on).',
    '2. Mark that PR **ready for review** — do not leave it as a draft. Draft PRs cannot merge.',
    '3. Do **not** create `hercules/<id>` and do **not** dual-write the default branch.',
    '4. Do not open a second PR.',
  ].join('\n');
}
