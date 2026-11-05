/** Pure model and policy for non-destructive post-merge workspace succession. */
import { isValidIdentifier } from './task.js';
import { isFullCommitSha } from './taskBranchLease.js';

export const WORKSPACE_SUCCESSION_VERSION = 2 as const;
export const MAX_SUCCESSION_RECEIPTS = 32;

export type CheckoutClassification =
  | 'current'
  | 'clean-behind'
  | 'local-ahead'
  | 'diverged'
  | 'dirty'
  | 'unavailable'
  | 'unknown';

export type ManagedDisposition = 'live' | 'preserved' | 'removed' | 'absent' | 'unknown';

export interface OwnerCheckoutRegistration {
  readonly id: string;
  readonly path: string;
}

export interface SuccessionGuidance {
  readonly code:
    | 'no_action'
    | 'fast_forward_optional'
    | 'preserve_local_commits'
    | 'inspect_divergence'
    | 'stash_or_commit_dirty'
    | 'reregister_or_skip'
    | 'reobserve';
  readonly text: string;
  readonly destructive: false;
}

export interface SuccessionTaskLease {
  readonly branch: string;
  readonly expectedBaseRevision: string;
  readonly expectedRemoteTip: string;
}

export interface SuccessionCandidate {
  readonly taskId: string;
  readonly verifiedSha: string;
  readonly lease: SuccessionTaskLease;
}

export interface SuccessionExternalObservation {
  readonly registrationId: string;
  readonly classification: CheckoutClassification;
  readonly headSha: string | null;
  readonly dirty: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly concurrentChange: boolean;
  readonly guidance: readonly SuccessionGuidance[];
}

export interface WorkspaceSuccessionReceipt {
  readonly id: string;
  readonly repoKey: string;
  readonly createdAt: string;
  readonly priorDefaultRevision: string;
  readonly gateMergeSha: string;
  readonly canonicalDefaultRevision: string;
  readonly candidates: readonly SuccessionCandidate[];
  readonly managed: readonly { readonly taskId: string; readonly disposition: ManagedDisposition }[];
  readonly external: readonly SuccessionExternalObservation[];
  readonly supersedesReceiptId: string | null;
}

export interface WorkspaceSuccessionLedger {
  readonly version: typeof WORKSPACE_SUCCESSION_VERSION;
  readonly repoKey: string;
  readonly receipts: readonly WorkspaceSuccessionReceipt[];
}

export interface WorkspaceSuccessionPublicDto {
  readonly id: string;
  readonly repoKey: string;
  readonly createdAt: string;
  readonly priorDefaultRevision: string;
  readonly gateMergeSha: string;
  readonly canonicalDefaultRevision: string;
  readonly classifications: readonly {
    readonly registrationId: string;
    readonly classification: CheckoutClassification;
    readonly concurrentChange: boolean;
    readonly guidance: readonly SuccessionGuidance[];
  }[];
  readonly managed: WorkspaceSuccessionReceipt['managed'];
  readonly supersedesReceiptId: string | null;
  readonly receiptCount: number;
  readonly offersDestructiveAction: false;
}

export class WorkspaceSuccessionError extends Error {
  override readonly name = 'WorkspaceSuccessionError';
}

export function classifyCheckout(input: {
  readonly available: boolean;
  readonly dirty: boolean;
  readonly ahead: number;
  readonly behind: number;
}): CheckoutClassification {
  if (!input.available) return 'unavailable';
  if (input.dirty) return 'dirty';
  if (!Number.isSafeInteger(input.ahead) || !Number.isSafeInteger(input.behind)) return 'unknown';
  if (input.ahead < 0 || input.behind < 0) return 'unknown';
  if (input.ahead > 0 && input.behind > 0) return 'diverged';
  if (input.ahead > 0) return 'local-ahead';
  if (input.behind > 0) return 'clean-behind';
  return 'current';
}

export function guidanceForCheckout(
  classification: CheckoutClassification,
): readonly SuccessionGuidance[] {
  const step = (code: SuccessionGuidance['code'], text: string): SuccessionGuidance => ({
    code,
    text,
    destructive: false,
  });
  switch (classification) {
    case 'current': return [step('no_action', 'This checkout already matches the canonical base.')];
    case 'clean-behind': return [step('fast_forward_optional', 'Fast-forward manually if wanted; Hercules will not change this checkout.')];
    case 'local-ahead': return [step('preserve_local_commits', 'Preserve the local commits on a branch and choose manually how to carry them forward.')];
    case 'diverged': return [step('inspect_divergence', 'Inspect both unique histories and recover chosen commits manually.')];
    case 'dirty': return [step('stash_or_commit_dirty', 'Commit or stash local changes manually before changing the checkout base.')];
    case 'unavailable': return [step('reregister_or_skip', 'Re-register this checkout only after verifying its location, or skip it.')];
    case 'unknown': return [step('reobserve', 'Inspect the checkout manually and re-observe when Git state is available.')];
  }
}

export interface BuildSuccessionReceiptInput {
  readonly repoKey: string;
  readonly createdAt: string;
  readonly priorDefaultRevision: string;
  readonly gateMergeSha: string;
  readonly canonicalDefaultRevision: string;
  readonly candidates: readonly SuccessionCandidate[];
  readonly managed: WorkspaceSuccessionReceipt['managed'];
  readonly external: WorkspaceSuccessionReceipt['external'];
}

export function buildSuccessionReceipt(
  input: BuildSuccessionReceiptInput,
): WorkspaceSuccessionReceipt {
  if (!isValidIdentifier(input.repoKey)) throw new WorkspaceSuccessionError('unsafe repo key');
  for (const sha of [input.priorDefaultRevision, input.gateMergeSha, input.canonicalDefaultRevision]) {
    if (!isFullCommitSha(sha)) throw new WorkspaceSuccessionError('receipt requires full commit SHAs');
  }
  if (input.candidates.length === 0 || input.candidates.length > 32) {
    throw new WorkspaceSuccessionError('receipt requires 1..32 candidates');
  }
  const candidateIds = new Set<string>();
  for (const candidate of input.candidates) {
    if (!isValidIdentifier(candidate.taskId) || !isFullCommitSha(candidate.verifiedSha)) {
      throw new WorkspaceSuccessionError('invalid candidate identity');
    }
    if (candidate.lease.branch !== `hercules/${candidate.taskId}`) {
      throw new WorkspaceSuccessionError('candidate lease branch mismatch');
    }
    if (candidateIds.has(candidate.taskId)) {
      throw new WorkspaceSuccessionError('duplicate candidate task id');
    }
    candidateIds.add(candidate.taskId);
    for (const sha of [candidate.lease.expectedBaseRevision, candidate.lease.expectedRemoteTip]) {
      if (!isFullCommitSha(sha)) {
        throw new WorkspaceSuccessionError('candidate lease requires exact full commit SHAs');
      }
    }
  }
  const managedIds = input.managed.map((item) => item.taskId);
  if (new Set(managedIds).size !== managedIds.length || managedIds.length !== candidateIds.size ||
      managedIds.some((id) => !candidateIds.has(id))) {
    throw new WorkspaceSuccessionError('managed tasks must exactly match candidates');
  }
  const registrationIds = input.external.map((item) => item.registrationId);
  if (new Set(registrationIds).size !== registrationIds.length) {
    throw new WorkspaceSuccessionError('duplicate external registration id');
  }
  const gateMergeSha = input.gateMergeSha.toLowerCase();
  return {
    id: `succ-${input.repoKey}-${gateMergeSha}`,
    repoKey: input.repoKey,
    createdAt: input.createdAt,
    priorDefaultRevision: input.priorDefaultRevision.toLowerCase(),
    gateMergeSha,
    canonicalDefaultRevision: input.canonicalDefaultRevision.toLowerCase(),
    candidates: input.candidates.map((candidate) => ({
      ...candidate,
      verifiedSha: candidate.verifiedSha.toLowerCase(),
      lease: {
        ...candidate.lease,
        expectedBaseRevision: candidate.lease.expectedBaseRevision.toLowerCase(),
        expectedRemoteTip: candidate.lease.expectedRemoteTip.toLowerCase(),
      },
    })),
    managed: input.managed,
    external: input.external,
    supersedesReceiptId: null,
  };
}

export function appendSuccessionReceipt(
  ledger: WorkspaceSuccessionLedger,
  receipt: WorkspaceSuccessionReceipt,
): WorkspaceSuccessionLedger {
  if (ledger.repoKey !== receipt.repoKey) throw new WorkspaceSuccessionError('ledger repo mismatch');
  const duplicate = ledger.receipts.find((item) => item.id === receipt.id);
  if (duplicate) {
    if (JSON.stringify(receiptMergeCore(duplicate)) !== JSON.stringify(receiptMergeCore(receipt))) {
      throw new WorkspaceSuccessionError('duplicate receipt id has different immutable merge core');
    }
    return ledger;
  }
  const previous = ledger.receipts.at(-1) ?? null;
  const linked: WorkspaceSuccessionReceipt = {
    ...receipt,
    supersedesReceiptId: previous?.id ?? null,
  };
  return {
    version: WORKSPACE_SUCCESSION_VERSION,
    repoKey: ledger.repoKey,
    receipts: [...ledger.receipts, linked].slice(-MAX_SUCCESSION_RECEIPTS),
  };
}

function receiptMergeCore(receipt: WorkspaceSuccessionReceipt): object {
  return {
    repoKey: receipt.repoKey,
    priorDefaultRevision: receipt.priorDefaultRevision,
    gateMergeSha: receipt.gateMergeSha,
    canonicalDefaultRevision: receipt.canonicalDefaultRevision,
    candidates: receipt.candidates.map((candidate) => ({
      taskId: candidate.taskId,
      verifiedSha: candidate.verifiedSha,
      lease: candidate.lease,
    })),
  };
}

export function toWorkspaceSuccessionPublicDto(
  ledger: WorkspaceSuccessionLedger,
): WorkspaceSuccessionPublicDto | null {
  const active = ledger.receipts.at(-1);
  if (!active) return null;
  return {
    id: active.id,
    repoKey: active.repoKey,
    createdAt: active.createdAt,
    priorDefaultRevision: active.priorDefaultRevision,
    gateMergeSha: active.gateMergeSha,
    canonicalDefaultRevision: active.canonicalDefaultRevision,
    classifications: active.external.map((item) => ({
      registrationId: item.registrationId,
      classification: item.classification,
      concurrentChange: item.concurrentChange,
      guidance: item.guidance,
    })),
    managed: active.managed,
    supersedesReceiptId: active.supersedesReceiptId,
    receiptCount: ledger.receipts.length,
    offersDestructiveAction: false,
  };
}
