import { describe, expect, it } from 'vitest';
import { decideOptimisticConcurrency } from '../../src/controlapi/concurrency.js';
import {
  assertConcurrencyTokenV2,
  computeConcurrencyTokenHash,
  type ConcurrencyTokenV2,
} from '../../src/domain/controlApiV2.js';

const HASH_A =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B =
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function concurrencyToken(
  overrides: Partial<ConcurrencyTokenV2> = {},
): ConcurrencyTokenV2 {
  const { tokenHash: overrideHash, ...fields } = overrides;
  const withoutHash: Omit<ConcurrencyTokenV2, 'tokenHash'> = {
    aggregateId: 'task-1',
    stateVersion: 3,
    projectionHash: HASH_A,
    ...fields,
  };
  const token: ConcurrencyTokenV2 = {
    ...withoutHash,
    tokenHash: overrideHash ?? computeConcurrencyTokenHash(withoutHash),
  };
  assertConcurrencyTokenV2(token);
  return token;
}

describe('decideOptimisticConcurrency', () => {
  it('returns ok when version and projection both match', () => {
    const token = concurrencyToken({
      stateVersion: 3,
      projectionHash: HASH_A,
    });
    expect(
      decideOptimisticConcurrency({
        concurrencyToken: token,
        currentStateVersion: 3,
        freshProjectionHash: HASH_A,
      }),
    ).toEqual({ kind: 'ok' });
  });

  it('returns stale_version when stateVersion mismatches (before projection)', () => {
    const token = concurrencyToken({
      stateVersion: 2,
      projectionHash: HASH_A,
    });
    expect(
      decideOptimisticConcurrency({
        concurrencyToken: token,
        currentStateVersion: 3,
        freshProjectionHash: HASH_A,
      }),
    ).toEqual({ kind: 'stale_version' });
  });

  it('returns stale_projection when version matches but projectionHash mismatches', () => {
    const token = concurrencyToken({
      stateVersion: 3,
      projectionHash: HASH_A,
    });
    expect(
      decideOptimisticConcurrency({
        concurrencyToken: token,
        currentStateVersion: 3,
        freshProjectionHash: HASH_B,
      }),
    ).toEqual({ kind: 'stale_projection' });
  });

  it('prefers stale_version when both version and projection mismatch', () => {
    const token = concurrencyToken({
      stateVersion: 1,
      projectionHash: HASH_A,
    });
    expect(
      decideOptimisticConcurrency({
        concurrencyToken: token,
        currentStateVersion: 9,
        freshProjectionHash: HASH_B,
      }),
    ).toEqual({ kind: 'stale_version' });
  });

  it('treats a null currentStateVersion as stale_version', () => {
    const token = concurrencyToken({ stateVersion: 0 });
    expect(
      decideOptimisticConcurrency({
        concurrencyToken: token,
        currentStateVersion: null,
        freshProjectionHash: HASH_A,
      }),
    ).toEqual({ kind: 'stale_version' });
  });

  it('treats a null freshProjectionHash as stale_projection when version matches', () => {
    const token = concurrencyToken({
      stateVersion: 3,
      projectionHash: HASH_A,
    });
    expect(
      decideOptimisticConcurrency({
        concurrencyToken: token,
        currentStateVersion: 3,
        freshProjectionHash: null,
      }),
    ).toEqual({ kind: 'stale_projection' });
  });
});
