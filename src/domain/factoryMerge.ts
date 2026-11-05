/**
 * Domain — Cursor Cloud factory CLEAN squash-merge (pure).
 *
 * Rings 1–11 get a factory PR to ready + MERGEABLE + green. Left in `review`
 * it waits for a human merge click; same-repo implement dependents stay
 * blocked. Identity-bound `gh pr merge --squash` is the remaining conveyor
 * bit — not Approve, not MergeService, no `verifiedSha`.
 */
import { isFactoryDraft } from './factoryDraft.js';
import { neutralizeUntrustedPacketText } from './packetNeutralize.js';

const FACTORY_MERGE_AUDIT_RE =
  /##\s+Factory PR (merged via GitHub|merge withheld)/i;

/** GitHub CLEAN — mergeable and passing. Missing status is treated as CLEAN. */
export function isFactoryMergeClean(mergeStateStatus: string | null | undefined): boolean {
  const state = (mergeStateStatus ?? '').trim().toUpperCase();
  return state === '' || state === 'CLEAN';
}

/**
 * Squash-merge only a finished, ready, MERGEABLE, green, CLEAN factory PR.
 * Draft / CONFLICTING / red CI / BEHIND / pending stay on earlier observe paths.
 */
export function shouldMergeFactoryPr(input: {
  readonly isDraft: boolean;
  readonly mergeable: string | null;
  readonly mergeStateStatus?: string | null;
  readonly ciStatus: string;
  readonly body: string;
}): boolean {
  if (FACTORY_MERGE_AUDIT_RE.test(input.body)) return false;
  if (isFactoryDraft(input)) return false;
  if ((input.mergeable ?? '').trim().toUpperCase() !== 'MERGEABLE') return false;
  if (!isFactoryMergeClean(input.mergeStateStatus)) return false;
  return input.ciStatus.trim().toLowerCase() === 'success';
}

export function buildFactoryMergedAuditSection(input: {
  readonly stamp: string;
  readonly prUrl: string;
}): string {
  return [
    `## Factory PR merged via GitHub (${input.stamp})`,
    '',
    `Squash-merged the open factory PR on GitHub (${input.prUrl}).`,
    'Not an Approve. Not MergeService. No verified_sha.',
    '',
  ].join('\n');
}

export function buildFactoryMergeWithheldAuditSection(input: {
  readonly stamp: string;
  readonly prUrl: string;
  readonly detail: string;
}): string {
  const detail = input.detail.trim() || 'gh pr merge --squash failed';
  return [
    `## Factory PR merge withheld (${input.stamp})`,
    '',
    `Did not squash-merge the open factory PR (${input.prUrl}).`,
    'Not an Approve. Left in review for the human.',
    `Detail: ${neutralizeUntrustedPacketText(detail)}`,
    '',
  ].join('\n');
}
