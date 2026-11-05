import { describe, expect, it } from 'vitest';
import {
  assertTerminalInventoryVerdictV1,
  computeTerminalInventoryProjectionHash,
} from '../../src/domain/qualification.js';
import {
  projectTerminalInventory,
  runAdministrativeTerminalValidation,
  type CanonicalInventoryReceiptInputV1,
} from '../../src/qualification/terminalInventory.js';

const NOW = '2026-09-01T00:00:00.000Z';
const MAIN_SHA = 'dddddddddddddddddddddddddddddddddddddddd';
const OTHER_SHA = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const INVENTORY_HASH = `sha256:${'f'.repeat(64)}`;
const EXPIRES_LATER = '2026-09-01T01:00:00.000Z';

function zeroReceipt(
  over: Partial<CanonicalInventoryReceiptInputV1> = {},
): CanonicalInventoryReceiptInputV1 {
  return {
    inventoryHash: INVENTORY_HASH,
    repository: 'example-org/acme',
    queryScope: 'all-open-base-refs',
    baseRefFilter: null,
    defaultBranchHead: MAIN_SHA,
    expiresAt: EXPIRES_LATER,
    paginationComplete: true,
    nextCursor: null,
    serverTotalOpenCount: 0,
    finalServerTotalOpenCount: 0,
    totalOpenCount: 0,
    pullRequests: [],
    ...over,
  };
}

describe('projectTerminalInventory', () => {
  it('copies completeness carriers verbatim and records inventoryHash as sourceInventoryHash', () => {
    const receipt = zeroReceipt();
    const projection = projectTerminalInventory(receipt);

    expect(projection.schema).toBe('hercules-terminal-inventory-projection/v1');
    expect(projection.sourceInventoryHash).toBe(receipt.inventoryHash);
    expect(projection.repository).toBe(receipt.repository);
    expect(projection.queryScope).toBe(receipt.queryScope);
    expect(projection.baseRefFilter).toBe(receipt.baseRefFilter);
    expect(projection.defaultBranchHead).toBe(receipt.defaultBranchHead);
    expect(projection.expiresAt).toBe(receipt.expiresAt);
    expect(projection.paginationComplete).toBe(receipt.paginationComplete);
    expect(projection.nextCursor).toBe(receipt.nextCursor);
    expect(projection.serverTotalOpenCount).toBe(receipt.serverTotalOpenCount);
    expect(projection.finalServerTotalOpenCount).toBe(
      receipt.finalServerTotalOpenCount,
    );
    expect(projection.totalOpenCount).toBe(receipt.totalOpenCount);
    expect(projection.pullRequests).toEqual(receipt.pullRequests);
    expect(projection.pullRequests).not.toBe(receipt.pullRequests);
    expect(projection.projectionHash).toBe(
      computeTerminalInventoryProjectionHash({
        schema: projection.schema,
        sourceInventoryHash: projection.sourceInventoryHash,
        repository: projection.repository,
        queryScope: projection.queryScope,
        baseRefFilter: projection.baseRefFilter,
        defaultBranchHead: projection.defaultBranchHead,
        expiresAt: projection.expiresAt,
        paginationComplete: projection.paginationComplete,
        nextCursor: projection.nextCursor,
        serverTotalOpenCount: projection.serverTotalOpenCount,
        finalServerTotalOpenCount: projection.finalServerTotalOpenCount,
        totalOpenCount: projection.totalOpenCount,
        pullRequests: projection.pullRequests,
      }),
    );
  });

  it('copies a nonzero pull-request identity verbatim without re-deriving', () => {
    const identity = {
      number: 19,
      url: 'https://github.com/example-org/acme/pull/19',
      headSha: OTHER_SHA,
      baseRef: 'main',
      state: 'OPEN' as const,
    };
    const receipt = zeroReceipt({
      totalOpenCount: 1,
      serverTotalOpenCount: 1,
      finalServerTotalOpenCount: 1,
      pullRequests: [identity],
    });
    const projection = projectTerminalInventory(receipt);
    expect(projection.pullRequests).toEqual([identity]);
    expect(projection.pullRequests[0]).not.toBe(identity);
    expect(projection.sourceInventoryHash).toBe(INVENTORY_HASH);
  });
});

describe('runAdministrativeTerminalValidation', () => {
  it('returns pass for a zero receipt projection', () => {
    const projection = projectTerminalInventory(zeroReceipt());
    const verdict = runAdministrativeTerminalValidation(
      projection,
      MAIN_SHA,
      NOW,
    );
    expect(() => assertTerminalInventoryVerdictV1(verdict)).not.toThrow();
    expect(verdict.outcome).toBe('pass');
    expect(verdict.reason).toBeNull();
    expect(verdict.totalOpenCount).toBe(0);
    expect(verdict.resolvedMainSha).toBe(MAIN_SHA);
  });

  it('returns fail for a nonzero receipt', () => {
    const projection = projectTerminalInventory(
      zeroReceipt({
        totalOpenCount: 1,
        serverTotalOpenCount: 1,
        finalServerTotalOpenCount: 1,
        pullRequests: [
          {
            number: 19,
            url: 'https://github.com/example-org/acme/pull/19',
            headSha: OTHER_SHA,
            baseRef: 'main',
            state: 'OPEN',
          },
        ],
      }),
    );
    const verdict = runAdministrativeTerminalValidation(
      projection,
      MAIN_SHA,
      NOW,
    );
    expect(verdict.outcome).toBe('fail');
    expect(verdict.reason).toBe('totalOpenCount');
  });

  it('returns fail for a truncated (incomplete pagination) receipt', () => {
    const projection = projectTerminalInventory(
      zeroReceipt({
        paginationComplete: false,
        nextCursor: 'page-2',
      }),
    );
    const verdict = runAdministrativeTerminalValidation(
      projection,
      MAIN_SHA,
      NOW,
    );
    expect(verdict.outcome).toBe('fail');
    expect(verdict.reason).toBe('paginationComplete');
  });
});
