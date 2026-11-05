import { describe, expect, it } from 'vitest';
import {
  appendSuccessionReceipt,
  buildSuccessionReceipt,
  classifyCheckout,
  guidanceForCheckout,
  type WorkspaceSuccessionLedger,
} from '../../src/domain/workspaceSuccession.js';

const OLD = '1'.repeat(40);
const VERIFIED = '2'.repeat(40);
const MERGED = '3'.repeat(40);

function receipt(canonical = MERGED) {
  return buildSuccessionReceipt({
    repoKey: 'demo',
    createdAt: '2026-08-04T12:00:00.000Z',
    priorDefaultRevision: OLD,
    gateMergeSha: MERGED,
    canonicalDefaultRevision: canonical,
    candidates: [{
      taskId: 'task-1',
      verifiedSha: VERIFIED,
      lease: {
        branch: 'hercules/task-1',
        expectedBaseRevision: OLD,
        expectedRemoteTip: VERIFIED,
      },
    }],
    managed: [{ taskId: 'task-1', disposition: 'preserved' }],
    external: [],
  });
}

describe('workspace succession domain', () => {
  it.each([
    [{ available: true, dirty: false, ahead: 0, behind: 0 }, 'current'],
    [{ available: true, dirty: false, ahead: 0, behind: 2 }, 'clean-behind'],
    [{ available: true, dirty: false, ahead: 2, behind: 0 }, 'local-ahead'],
    [{ available: true, dirty: false, ahead: 1, behind: 1 }, 'diverged'],
    [{ available: true, dirty: true, ahead: 0, behind: 0 }, 'dirty'],
    [{ available: false, dirty: false, ahead: 0, behind: 0 }, 'unavailable'],
  ] as const)('classifies %o as %s', (input, expected) => {
    expect(classifyCheckout(input)).toBe(expected);
  });

  it('offers only bounded manual non-destructive guidance', () => {
    const choices = guidanceForCheckout('diverged');
    expect(choices.length).toBeLessThanOrEqual(3);
    expect(choices.every((choice) => choice.destructive === false)).toBe(true);
    expect(JSON.stringify(choices)).not.toMatch(/reset --hard|force.push|delete/i);
  });

  it('binds exact verified candidate, lease, gate and canonical revisions', () => {
    expect(receipt()).toMatchObject({
      repoKey: 'demo',
      priorDefaultRevision: OLD,
      gateMergeSha: MERGED,
      canonicalDefaultRevision: MERGED,
      candidates: [{
        taskId: 'task-1',
        verifiedSha: VERIFIED,
        lease: { expectedBaseRevision: OLD, expectedRemoteTip: VERIFIED },
      }],
    });
  });

  it('fails closed on missing exact lease metadata', () => {
    const base = receipt();
    for (const lease of [
      { ...base.candidates[0]!.lease, expectedBaseRevision: '' },
      { ...base.candidates[0]!.lease, expectedRemoteTip: '' },
    ]) {
      expect(() => buildSuccessionReceipt({
        ...base,
        candidates: [{ ...base.candidates[0]!, lease }],
      })).toThrow(/exact full commit/);
    }
  });

  it('binds a full exact leased tip independently from the verified SHA', () => {
    const base = receipt();
    const expectedRemoteTip = '4'.repeat(40);
    expect(buildSuccessionReceipt({
      ...base,
      candidates: [{
        ...base.candidates[0]!,
        lease: { ...base.candidates[0]!.lease, expectedRemoteTip },
      }],
    }).candidates[0]).toMatchObject({
      verifiedSha: VERIFIED,
      lease: { expectedRemoteTip },
    });
  });

  it('replays duplicate gate receipts idempotently and bounds a linked superseding chain', () => {
    let ledger: WorkspaceSuccessionLedger = { version: 2, repoKey: 'demo', receipts: [] };
    ledger = appendSuccessionReceipt(ledger, receipt());
    ledger = appendSuccessionReceipt(ledger, receipt());
    expect(ledger.receipts).toHaveLength(1);

    for (let i = 4; i < 45; i += 1) {
      const sha = i.toString(16).padStart(40, '0');
      ledger = appendSuccessionReceipt(ledger, buildSuccessionReceipt({
        ...receipt(),
        createdAt: `2026-08-04T12:${String(i).padStart(2, '0')}:00.000Z`,
        priorDefaultRevision: ledger.receipts.at(-1)!.canonicalDefaultRevision,
        gateMergeSha: sha,
        canonicalDefaultRevision: sha,
      }));
    }
    expect(ledger.receipts).toHaveLength(32);
    expect(ledger.receipts.at(-1)!.supersedesReceiptId).toBe(
      ledger.receipts.at(-2)!.id,
    );
  });

  it('preserves the first authoritative receipt when mutable retry observations change', () => {
    const first = receipt();
    const ledger = appendSuccessionReceipt({ version: 2, repoKey: 'demo', receipts: [] }, first);
    const replay = {
      ...first,
      createdAt: '2026-08-04T13:00:00.000Z',
      managed: [{ taskId: 'task-1', disposition: 'removed' as const }],
      external: [{
        registrationId: 'owner-main',
        classification: 'dirty' as const,
        headSha: OLD,
        dirty: true,
        ahead: 0,
        behind: 1,
        concurrentChange: true,
        guidance: guidanceForCheckout('dirty'),
      }],
    };
    expect(appendSuccessionReceipt(ledger, replay)).toBe(ledger);
    expect(appendSuccessionReceipt(ledger, replay).receipts[0]).toEqual(first);
  });

  it.each(['prior', 'candidate', 'lease'] as const)(
    'fails closed when a duplicate id changes immutable merge-core %s facts',
    (kind) => {
      const first = receipt();
      const ledger = appendSuccessionReceipt({ version: 2, repoKey: 'demo', receipts: [] }, first);
      const changed = kind === 'prior'
        ? { ...first, priorDefaultRevision: '7'.repeat(40) }
        : {
            ...first,
            candidates: [{
              ...first.candidates[0]!,
              ...(kind === 'candidate' ? { taskId: 'task-2' } : {}),
              lease: {
                ...first.candidates[0]!.lease,
                ...(kind === 'candidate' ? { branch: 'hercules/task-2' } : {}),
                ...(kind === 'lease' ? { expectedBaseRevision: '7'.repeat(40) } : {}),
              },
            }],
          };
      expect(() => appendSuccessionReceipt(ledger, changed)).toThrow(/immutable merge core/i);
    },
  );
});
