/**
 * M11 Control API V2 — pure optimistic concurrency decision (submit only).
 *
 * Fixed sub-order: version mismatch wins over projection mismatch so the
 * refusal reason is single-valued. Imports only `src/domain/*`.
 */

import type { ConcurrencyTokenV2 } from '../domain/controlApiV2.js';

/** Closed concurrency outcomes for a submit concurrency token. */
export type ConcurrencyDecisionV1 =
  | { readonly kind: 'stale_version' }
  | { readonly kind: 'stale_projection' }
  | { readonly kind: 'ok' };

/**
 * Compare the client concurrency token to the trusted read.
 *
 * 4a. `stateVersion != currentStateVersion` → `stale_version`
 * 4b. else `projectionHash != freshProjectionHash` → `stale_projection`
 * Both mismatching yields `stale_version` (version checked first).
 */
export function decideOptimisticConcurrency(input: {
  readonly concurrencyToken: ConcurrencyTokenV2;
  readonly currentStateVersion: number | null;
  readonly freshProjectionHash: string | null;
}): ConcurrencyDecisionV1 {
  const { concurrencyToken, currentStateVersion, freshProjectionHash } = input;
  if (concurrencyToken.stateVersion !== currentStateVersion) {
    return { kind: 'stale_version' };
  }
  if (concurrencyToken.projectionHash !== freshProjectionHash) {
    return { kind: 'stale_projection' };
  }
  return { kind: 'ok' };
}
