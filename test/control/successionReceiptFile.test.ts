import { describe, expect, it } from 'vitest';
import {
  parseSuccessionLedger,
  serializeSuccessionLedger,
  SuccessionFileError,
} from '../../src/control/successionReceiptFile.js';
import { appendSuccessionReceipt, buildSuccessionReceipt } from '../../src/domain/workspaceSuccession.js';

const OLD = '1'.repeat(40);
const VERIFIED = '2'.repeat(40);
const MERGED = '3'.repeat(40);

function ledger() {
  return appendSuccessionReceipt({ version: 2, repoKey: 'demo', receipts: [] }, buildSuccessionReceipt({
    repoKey: 'demo',
    createdAt: '2026-08-04T12:00:00.000Z',
    priorDefaultRevision: OLD,
    gateMergeSha: MERGED,
    canonicalDefaultRevision: MERGED,
    candidates: [{ taskId: 'task-1', verifiedSha: VERIFIED, lease: {
      branch: 'hercules/task-1', expectedBaseRevision: OLD, expectedRemoteTip: VERIFIED,
    } }],
    managed: [{ taskId: 'task-1', disposition: 'preserved' }],
    external: [{ registrationId: 'owner-main', classification: 'clean-behind',
      headSha: OLD, dirty: false, ahead: 0, behind: 1, concurrentChange: false,
      guidance: [{ code: 'fast_forward_optional', text: 'Fast-forward manually if wanted.', destructive: false }],
    }],
  }));
}

describe('succession receipt file', () => {
  it('round-trips every lease and observation fact with an integrity seal', () => {
    const text = serializeSuccessionLedger(ledger());
    expect(text).toMatch(/"integrity":"sha256:[0-9a-f]{64}"/);
    expect(parseSuccessionLedger(text, 'demo')).toEqual(ledger());
    expect(text).not.toContain('/home/');
  });

  it('accepts separate full verified and exact leased descendant SHAs', () => {
    const value = ledger();
    const distinct = {
      ...value,
      receipts: value.receipts.map((item) => ({
        ...item,
        candidates: item.candidates.map((candidate) => ({
          ...candidate,
          lease: { ...candidate.lease, expectedRemoteTip: '4'.repeat(40) },
        })),
      })),
    };
    expect(parseSuccessionLedger(serializeSuccessionLedger(distinct), 'demo'))
      .toEqual(distinct);
  });

  it('fails closed on corruption and torn JSON', () => {
    const text = serializeSuccessionLedger(ledger());
    expect(() => parseSuccessionLedger(text.replace(MERGED, '4'.repeat(40)), 'demo'))
      .toThrow(SuccessionFileError);
    expect(() => parseSuccessionLedger(text.slice(0, -8), 'demo'))
      .toThrow(SuccessionFileError);
  });

  it('allows the first retained receipt to name an evicted predecessor', () => {
    const current = ledger();
    const first = current.receipts[0]!;
    const retained = {
      ...current,
      receipts: [{ ...first, supersedesReceiptId: `succ-demo-${'0'.repeat(40)}` }],
    };
    expect(parseSuccessionLedger(serializeSuccessionLedger(retained), 'demo')).toEqual(retained);
  });

  it('accepts a resealed linked receipt after an intervening canonical main advance', () => {
    const first = ledger().receipts[0]!;
    const nextSha = '4'.repeat(40);
    const interveningMain = '6'.repeat(40);
    const second = {
      ...first,
      id: `succ-demo-${nextSha}`,
      priorDefaultRevision: interveningMain,
      gateMergeSha: nextSha,
      canonicalDefaultRevision: nextSha,
      supersedesReceiptId: first.id,
    };
    const resealed = serializeSuccessionLedger({
      version: 2,
      repoKey: 'demo',
      receipts: [first, second],
    });
    expect(parseSuccessionLedger(resealed, 'demo').receipts[1]).toMatchObject({
      priorDefaultRevision: interveningMain,
      supersedesReceiptId: first.id,
    });
  });

  it.each([
    'duplicate-receipt',
    'broken-link',
    'duplicate-candidate',
    'duplicate-managed',
    'duplicate-registration',
    'managed-mismatch',
  ] as const)('rejects resealed malformed chain semantics: %s', (kind) => {
    const first = ledger().receipts[0]!;
    const nextSha = '4'.repeat(40);
    const second = {
      ...first,
      id: `succ-demo-${nextSha}`,
      priorDefaultRevision: first.canonicalDefaultRevision,
      gateMergeSha: nextSha,
      canonicalDefaultRevision: nextSha,
      supersedesReceiptId: first.id,
    };
    let receipts = [first, second];
    if (kind === 'duplicate-receipt') receipts = [first, { ...second, id: first.id }];
    if (kind === 'broken-link') receipts = [first, { ...second, supersedesReceiptId: null }];
    if (kind === 'duplicate-candidate') receipts = [first, {
      ...second, candidates: [second.candidates[0]!, second.candidates[0]!],
      managed: [second.managed[0]!, { ...second.managed[0]!, disposition: 'live' }],
    }];
    if (kind === 'duplicate-managed') receipts = [first, {
      ...second, managed: [second.managed[0]!, second.managed[0]!],
    }];
    if (kind === 'duplicate-registration') receipts = [first, {
      ...second, external: [first.external[0]!, first.external[0]!],
    }];
    if (kind === 'managed-mismatch') receipts = [first, {
      ...second, managed: [{ taskId: 'task-2', disposition: 'preserved' as const }],
    }];
    expect(() => parseSuccessionLedger(serializeSuccessionLedger({
      version: 2, repoKey: 'demo', receipts,
    }), 'demo')).toThrow(SuccessionFileError);
  });
});
