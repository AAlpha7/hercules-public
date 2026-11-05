import { describe, expect, it } from 'vitest';
import { decideIdempotency } from '../../src/controlapi/idempotency.js';
import {
  assertAdmissionLedgerEntryV1,
  assertControlApiV2ReceiptV1,
  computeReceiptHash,
  type AdmissionLedgerEntryV1,
  type ControlApiV2ReceiptV1,
} from '../../src/domain/controlApiV2.js';

const HASH_A =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B =
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C =
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const HASH_D =
  'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const TS = '2026-08-31T12:00:00.000Z';

function committedReceipt(
  overrides: Partial<ControlApiV2ReceiptV1> = {},
): ControlApiV2ReceiptV1 {
  const { receiptHash: overrideHash, ...fields } = overrides;
  const withoutHash: Omit<ControlApiV2ReceiptV1, 'receiptHash'> = {
    schema: 'hercules-control-api-receipt/v2',
    outcome: 'committed',
    resource: 'task',
    aggregateId: 'task-1',
    keyHash: HASH_A,
    requestHash: HASH_B,
    stateVersion: 1,
    eventSequence: 1,
    reason: null,
    decidedAt: TS,
    ...fields,
  };
  const receipt: ControlApiV2ReceiptV1 = {
    ...withoutHash,
    receiptHash: overrideHash ?? computeReceiptHash(withoutHash),
  };
  assertControlApiV2ReceiptV1(receipt);
  return receipt;
}

function ledgerEntry(
  overrides: Partial<AdmissionLedgerEntryV1> = {},
): AdmissionLedgerEntryV1 {
  const receipt = overrides.receipt ?? committedReceipt();
  const entry: AdmissionLedgerEntryV1 = {
    keyHash: overrides.keyHash ?? receipt.keyHash,
    requestHash: overrides.requestHash ?? receipt.requestHash,
    receipt,
  };
  assertAdmissionLedgerEntryV1(entry);
  return entry;
}

describe('decideIdempotency', () => {
  it('replays the byte-identical stored committed receipt on exact key+request match', () => {
    const receipt = committedReceipt({ keyHash: HASH_A, requestHash: HASH_B });
    const entry = ledgerEntry({ receipt });
    const decision = decideIdempotency({
      keyHash: HASH_A,
      requestHash: HASH_B,
      admissionLedger: [entry],
    });
    expect(decision).toEqual({ kind: 'replay', receipt });
    if (decision.kind === 'replay') {
      expect(decision.receipt).toBe(receipt);
      expect(decision.receipt.receiptHash).toBe(receipt.receiptHash);
    }
  });

  it('conflicts when the same keyHash appears with a different requestHash', () => {
    const entry = ledgerEntry({
      receipt: committedReceipt({ keyHash: HASH_A, requestHash: HASH_B }),
    });
    expect(
      decideIdempotency({
        keyHash: HASH_A,
        requestHash: HASH_C,
        admissionLedger: [entry],
      }),
    ).toEqual({ kind: 'conflict' });
  });

  it('proceeds when the keyHash is unseen', () => {
    const entry = ledgerEntry({
      receipt: committedReceipt({ keyHash: HASH_D, requestHash: HASH_B }),
    });
    expect(
      decideIdempotency({
        keyHash: HASH_A,
        requestHash: HASH_B,
        admissionLedger: [entry],
      }),
    ).toEqual({ kind: 'proceed' });
    expect(
      decideIdempotency({
        keyHash: HASH_A,
        requestHash: HASH_B,
        admissionLedger: [],
      }),
    ).toEqual({ kind: 'proceed' });
  });

  it('prefers exact replay over a same-key different-hash sibling in the ledger', () => {
    const match = committedReceipt({
      keyHash: HASH_A,
      requestHash: HASH_B,
      stateVersion: 1,
      eventSequence: 1,
    });
    const sibling = committedReceipt({
      keyHash: HASH_A,
      requestHash: HASH_C,
      aggregateId: 'task-2',
      stateVersion: 2,
      eventSequence: 2,
    });
    const decision = decideIdempotency({
      keyHash: HASH_A,
      requestHash: HASH_B,
      admissionLedger: [
        ledgerEntry({ receipt: sibling }),
        ledgerEntry({ receipt: match }),
      ],
    });
    expect(decision).toEqual({ kind: 'replay', receipt: match });
  });

  it('ignores ledger rows for other keyHashes when deciding conflict', () => {
    const other = ledgerEntry({
      receipt: committedReceipt({ keyHash: HASH_D, requestHash: HASH_B }),
    });
    const sameKey = ledgerEntry({
      receipt: committedReceipt({ keyHash: HASH_A, requestHash: HASH_C }),
    });
    expect(
      decideIdempotency({
        keyHash: HASH_A,
        requestHash: HASH_B,
        admissionLedger: [other, sameKey],
      }),
    ).toEqual({ kind: 'conflict' });
  });
});
