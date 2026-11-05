/**
 * Promote/rollback client reconciliation across daemon self-restart.
 * Network-layer fetch rejection is not a promote failure — poll the release
 * record until it is terminal (ok / rolled_back) or the bound expires.
 */
import { ApiError, fetchReleases, type ReleasePanelEntryDto } from './api.js';

/** Mutable so render tests can shrink the poll window without fake timers. */
export const promoteReconcileConfig = {
  intervalMs: 3000,
  maxAttempts: 30,
};

export type PromoteTerminal =
  | { readonly status: 'pending' }
  | { readonly status: 'ok' }
  | { readonly status: 'rolled_back'; readonly targetSha: string | null };

export type PromoteReconcileOutcome =
  | { readonly status: 'ok' }
  | { readonly status: 'rolled_back'; readonly targetSha: string | null }
  | { readonly status: 'unknown' };

/** True only for fetch rejection / connection reset (ApiError status 0). */
export function isNetworkLayerFailure(err: unknown): boolean {
  return err instanceof ApiError && err.status === 0;
}

type ReleasePollFacts = Pick<
  ReleasePanelEntryDto,
  'productionSha' | 'promotingSha' | 'history'
>;

/**
 * Interpret one GET /api/releases row for a promote that targeted `expectedSha`.
 * Success requires production tip + latest history outcome ok for that sha.
 */
export function readPromoteTerminal(
  row: ReleasePollFacts | undefined,
  expectedSha: string,
): PromoteTerminal {
  if (row === undefined) return { status: 'pending' };
  if (row.promotingSha !== null && row.promotingSha !== '') {
    return { status: 'pending' };
  }
  const latest = row.history.length > 0 ? row.history[row.history.length - 1] : undefined;
  if (
    latest !== undefined &&
    latest.outcome === 'ok' &&
    latest.sha === expectedSha &&
    row.productionSha === expectedSha
  ) {
    return { status: 'ok' };
  }
  if (
    latest !== undefined &&
    latest.outcome === 'rolled_back' &&
    latest.rollbackOf === expectedSha
  ) {
    return {
      status: 'rolled_back',
      targetSha: row.productionSha ?? latest.sha,
    };
  }
  return { status: 'pending' };
}

async function pollReleaseRow(
  repoKey: string,
): Promise<ReleasePanelEntryDto | undefined> {
  const rows = await fetchReleases();
  return rows.find((entry) => entry.repoKey === repoKey);
}

/**
 * Poll until the release record is terminal for `expectedSha`, or the bound
 * expires as honest unknown (never a fabricated network failure).
 */
export async function waitForPromoteOutcome(
  repoKey: string,
  expectedSha: string,
): Promise<PromoteReconcileOutcome> {
  for (let i = 0; i < promoteReconcileConfig.maxAttempts; i++) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, promoteReconcileConfig.intervalMs);
    });
    try {
      const terminal = readPromoteTerminal(await pollReleaseRow(repoKey), expectedSha);
      if (terminal.status === 'ok') return { status: 'ok' };
      if (terminal.status === 'rolled_back') {
        return { status: 'rolled_back', targetSha: terminal.targetSha };
      }
    } catch (err) {
      // Daemon still restarting / boot finalizing — keep polling.
      void err;
    }
  }
  return { status: 'unknown' };
}

/**
 * Manual rollback confirmation after a network-layer mid-restart failure:
 * success when production tip matches the intended rollback target.
 */
export async function waitForRollbackOutcome(
  repoKey: string,
  expectedTargetSha: string,
): Promise<{ readonly status: 'ok' } | { readonly status: 'unknown' }> {
  for (let i = 0; i < promoteReconcileConfig.maxAttempts; i++) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, promoteReconcileConfig.intervalMs);
    });
    try {
      const row = await pollReleaseRow(repoKey);
      if (
        row !== undefined &&
        (row.promotingSha === null || row.promotingSha === '') &&
        row.productionSha === expectedTargetSha
      ) {
        return { status: 'ok' };
      }
    } catch (err) {
      void err;
    }
  }
  return { status: 'unknown' };
}
