import { describe, expect, it } from 'vitest';
import {
  decideTaskBranchCas,
  taskBranchLeaseArg,
} from '../../src/domain/taskBranchLease.js';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccccccccccccccccccccc';

describe('task branch exact lease', () => {
  it('permits only an absent creation target or the exact expected tip', () => {
    expect(
      decideTaskBranchCas({
        expectedRemoteTip: null,
        actualRemoteTip: null,
        localTip: A,
        localIsStrictAncestorOfRemote: false,
        allowOwnedReset: false,
      }),
    ).toEqual({ ok: true, mode: 'create' });

    expect(
      decideTaskBranchCas({
        expectedRemoteTip: B,
        actualRemoteTip: B,
        localTip: A,
        localIsStrictAncestorOfRemote: false,
        allowOwnedReset: false,
      }),
    ).toEqual({ ok: true, mode: 'update' });

    for (const [expectedRemoteTip, actualRemoteTip, reason] of [
      [null, B, 'remote_unexpected'],
      [B, null, 'remote_missing'],
      [B, C, 'remote_changed'],
    ] as const) {
      const verdict = decideTaskBranchCas({
        expectedRemoteTip,
        actualRemoteTip,
        localTip: A,
        localIsStrictAncestorOfRemote: false,
        allowOwnedReset: false,
      });
      expect(verdict).toMatchObject({ ok: false, reason });
    }
  });

  it('blocks rewinds except an explicitly owned fresh reset', () => {
    const input = {
      expectedRemoteTip: B,
      actualRemoteTip: B,
      localTip: A,
      localIsStrictAncestorOfRemote: true,
    } as const;
    expect(decideTaskBranchCas({ ...input, allowOwnedReset: false })).toMatchObject({
      ok: false,
      reason: 'remote_rewind',
    });
    expect(decideTaskBranchCas({ ...input, allowOwnedReset: true })).toEqual({
      ok: true,
      mode: 'update',
    });
  });

  it('never lets a matching local tip bypass a stale or creation lease', () => {
    expect(
      decideTaskBranchCas({
        expectedRemoteTip: B,
        actualRemoteTip: A,
        localTip: A,
        localIsStrictAncestorOfRemote: false,
        allowOwnedReset: false,
      }),
    ).toMatchObject({ ok: false, reason: 'remote_changed' });
    expect(
      decideTaskBranchCas({
        expectedRemoteTip: null,
        actualRemoteTip: A,
        localTip: A,
        localIsStrictAncestorOfRemote: false,
        allowOwnedReset: false,
      }),
    ).toMatchObject({ ok: false, reason: 'remote_unexpected' });
    expect(
      decideTaskBranchCas({
        expectedRemoteTip: A,
        actualRemoteTip: A,
        localTip: A,
        localIsStrictAncestorOfRemote: false,
        allowOwnedReset: false,
      }),
    ).toEqual({ ok: true, mode: 'noop' });
  });

  it('builds a ref-exact force-with-lease argument', () => {
    expect(taskBranchLeaseArg('hercules/T-1', B)).toBe(
      `--force-with-lease=refs/heads/hercules/T-1:${B}`,
    );
    expect(taskBranchLeaseArg('hercules/T-1', null)).toBe(
      '--force-with-lease=refs/heads/hercules/T-1:',
    );
  });
});
