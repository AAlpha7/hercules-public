/**
 * M11 Control API V2 — pure idempotency decision over the admission ledger.
 *
 * Ledger is keyed by keyHash (not aggregateId). Never throws; never mutates.
 * Imports only `src/domain/*`.
 */

import type {
  AdmissionLedgerEntryV1,
  ControlApiV2ReceiptV1,
} from '../domain/controlApiV2.js';

/** Closed idempotency outcomes for a mutation keyHash/requestHash pair. */
export type IdempotencyDecisionV1 =
  | { readonly kind: 'replay'; readonly receipt: ControlApiV2ReceiptV1 }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'proceed' };

/**
 * Decide replay / conflict / proceed over the prior-admission ledger.
 *
 * - Exact `(keyHash, requestHash)` → byte-identical stored committed receipt.
 * - Same `keyHash`, different `requestHash` → conflict.
 * - Unseen `keyHash` → proceed.
 *
 * Evaluated before concurrency so a replay never depends on the current version.
 */
export function decideIdempotency(input: {
  readonly keyHash: string;
  readonly requestHash: string;
  readonly admissionLedger: readonly AdmissionLedgerEntryV1[];
}): IdempotencyDecisionV1 {
  const { keyHash, requestHash, admissionLedger } = input;
  let sawSameKey = false;
  for (const entry of admissionLedger) {
    if (entry.keyHash !== keyHash) {
      continue;
    }
    sawSameKey = true;
    if (entry.requestHash === requestHash) {
      return { kind: 'replay', receipt: entry.receipt };
    }
  }
  if (sawSameKey) {
    return { kind: 'conflict' };
  }
  return { kind: 'proceed' };
}
