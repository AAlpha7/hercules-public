/**
 * M13 administrative terminal-inventory validator harness.
 *
 * Observational only: projects completeness carriers verbatim from a
 * canonical-shaped open-PR inventory receipt, then wraps the pure
 * `validateTerminalInventory`. No state change, no completion, no merge.
 */

import {
  assertTerminalInventoryVerdictV1,
  computeTerminalInventoryProjectionHash,
  validateTerminalInventory,
  type TerminalInventoryProjectionV1,
  type TerminalInventoryVerdictV1,
  type TerminalOpenPrIdentityV1,
} from '../domain/qualification.js';
import { isCanonicalTimestamp } from '../domain/workerBoundary.js';
import { QualificationHarnessError } from './heldOutCorpus.js';

/**
 * Minimal canonical-receipt input: completeness carriers + inventoryHash.
 * The full OpenPullRequestInventoryReceiptV1 is not yet in src/; this is the
 * typed field-copy surface the administrative harness consumes.
 *
 * `paginationComplete` / `nextCursor` are copied verbatim so a truncated
 * receipt can be projected and then fail observationally at validation.
 */
export interface CanonicalInventoryReceiptInputV1 {
  readonly inventoryHash: string;
  readonly repository: 'example-org/acme';
  readonly queryScope: 'all-open-base-refs';
  readonly baseRefFilter: null;
  readonly defaultBranchHead: string;
  readonly expiresAt: string;
  readonly paginationComplete: boolean;
  readonly nextCursor: string | null;
  readonly serverTotalOpenCount: number;
  readonly finalServerTotalOpenCount: number;
  readonly totalOpenCount: number;
  readonly pullRequests: readonly TerminalOpenPrIdentityV1[];
}

function assertInjectedNow(now: string): void {
  if (!isCanonicalTimestamp(now)) {
    throw new QualificationHarnessError(
      'injected now must be a canonical UTC-Z timestamp',
    );
  }
}

function copyPullRequest(
  identity: TerminalOpenPrIdentityV1,
): TerminalOpenPrIdentityV1 {
  return {
    number: identity.number,
    url: identity.url,
    headSha: identity.headSha,
    baseRef: identity.baseRef,
    state: identity.state,
  };
}

/**
 * Typed field copy of completeness carriers from a canonical-shaped receipt.
 * Records `inventoryHash` as `sourceInventoryHash`. NEVER re-derives or
 * re-hashes the sealed receipt — continuity binds sourceInventoryHash.
 *
 * Does not schema-reject truncated carriers: a truncated or nonzero receipt
 * is projected faithfully and fails later in `validateTerminalInventory`.
 */
export function projectTerminalInventory(
  receipt: CanonicalInventoryReceiptInputV1,
): TerminalInventoryProjectionV1 {
  const withoutHash = {
    schema: 'hercules-terminal-inventory-projection/v1' as const,
    sourceInventoryHash: receipt.inventoryHash,
    repository: receipt.repository,
    queryScope: receipt.queryScope,
    baseRefFilter: receipt.baseRefFilter,
    defaultBranchHead: receipt.defaultBranchHead,
    expiresAt: receipt.expiresAt,
    paginationComplete: receipt.paginationComplete,
    nextCursor: receipt.nextCursor,
    serverTotalOpenCount: receipt.serverTotalOpenCount,
    finalServerTotalOpenCount: receipt.finalServerTotalOpenCount,
    totalOpenCount: receipt.totalOpenCount,
    pullRequests: receipt.pullRequests.map(copyPullRequest),
  };
  // Cast: projection type pins paginationComplete:true for the happy path;
  // truncated copies retain the receipt's boolean for observational fail.
  const projection = {
    ...withoutHash,
    projectionHash: computeTerminalInventoryProjectionHash(
      withoutHash as Omit<TerminalInventoryProjectionV1, 'projectionHash'>,
    ),
  } as TerminalInventoryProjectionV1;
  return projection;
}

/**
 * Observational administrative terminal-inventory validation. Wraps the pure
 * `validateTerminalInventory`; returns pass/fail only. Does not complete the
 * program or mutate any store.
 */
export function runAdministrativeTerminalValidation(
  projection: TerminalInventoryProjectionV1,
  expectedMainSha: string,
  now: string,
): TerminalInventoryVerdictV1 {
  assertInjectedNow(now);
  const verdict = validateTerminalInventory(
    projection,
    expectedMainSha,
    now,
  );
  assertTerminalInventoryVerdictV1(verdict);
  return verdict;
}
