import type { Task } from '../../domain/task.js';
import type { ShadowDelivery, ShadowReconciliationReport } from './shadowReconciler.js';
import type { ShadowTaskState } from './stateStore.js';

/** Minimal store surface for memo eligibility (avoids concrete sqlite imports). */
export interface M4ObserverStoreView {
  listIncompleteEnvelopes(): readonly unknown[];
  /** Kept for compatibility; caught-up checks prefer `latestProjectionEnvelopeRevision`. */
  listProjectionEnvelopes(): readonly { readonly authorityRevision: string }[];
  latestProjectionEnvelopeRevision(): string | null;
  /** C3.58 durable observed-revision cursor (preferred when present). */
  observedAuthorityRevision?(): string | null;
}

/**
 * True only when the observer has processed the observed authority revision:
 * the durable cursor (C3.58) when the store has one, else the latest envelope.
 */
export function m4ObserverFullyCaughtUp(store: M4ObserverStoreView, revision: string): boolean {
  const cursor = store.observedAuthorityRevision?.() ?? null;
  return (cursor ?? store.latestProjectionEnvelopeRevision()) === revision;
}

/** Cached Git-authority delivery reconstruction (envelopes + trees are immutable). */
export interface M4HistoryCacheEntry {
  readonly authorityRevision: string;
  readonly manifestDigest: string;
  readonly delivery: ShadowDelivery;
}

/** Envelope identity used to key incremental replayExpectedState. */
export interface M4ReplayEnvelopeKey {
  readonly deliveryId: string;
  readonly authorityRevision: string;
  readonly manifestDigest: string;
}

/** Cached replayExpectedState result for an ordered envelope-key prefix. */
export interface M4ReplayCache {
  readonly keys: readonly M4ReplayEnvelopeKey[];
  readonly states: ReadonlyMap<string, ShadowTaskState>;
}

/**
 * In-process memo for observer-path reconciliation; never survives restart.
 *
 * `history` / `replay` cache immutable envelope reconstructions and expected
 * state. They survive `invalidateM4ObserverMemo` (a new live commit appends
 * envelopes but does not rewrite prior ones) and are cleared only by
 * `resetM4ObserverHistory` on store-instance reopen.
 */
export interface M4ObserverMemo {
  store: M4ObserverStoreView | null;
  revision: string | null;
  report: ShadowReconciliationReport | null;
  lastLoggedParity: boolean | null;
  lastLoggedDivergences: number | null;
  history: {
    deliveries: Map<string, M4HistoryCacheEntry>;
  };
  replay: M4ReplayCache | null;
  /**
   * Parsed task blobs keyed by exact git blob oid + task id (immutable, so
   * never invalidated; bounded by `TASK_BLOB_CACHE_MAX`). Interning here is
   * what keeps `history` memory proportional to distinct task versions.
   */
  taskBlobs: Map<string, Task>;
}

export function createM4ObserverMemo(): M4ObserverMemo {
  return {
    store: null,
    revision: null,
    report: null,
    lastLoggedParity: null,
    lastLoggedDivergences: null,
    history: { deliveries: new Map() },
    replay: null,
    taskBlobs: new Map(),
  };
}

/**
 * Drop a cached report (delivery, reopen, or any state that could have changed).
 * Does NOT clear `history` / `replay`: delivery reconstructions and replayed
 * expected-state prefixes remain valid because projection envelopes and their
 * Git trees are immutable — only newly appended envelopes need work.
 */
export function invalidateM4ObserverMemo(memo: M4ObserverMemo): void {
  memo.revision = null;
  memo.report = null;
}

/**
 * Drop history + replay caches. Call when `memo.store` identity changes
 * (SQLite reopen) — a new store handle must not reuse another instance's maps.
 */
export function resetM4ObserverHistory(memo: M4ObserverMemo): void {
  memo.history.deliveries.clear();
  memo.replay = null;
}

export interface M4ObserverHooks {
  readonly onHistoryBuild?: () => void;
  readonly onReconcile?: () => void;
  readonly log?: (line: string) => void;
}

/**
 * Fail-closed cache eligibility: same store instance, same authority revision,
 * no incomplete envelopes, no projection failures, and fully caught up at revision.
 */
export function m4ObserverCacheEligible(
  memo: M4ObserverMemo,
  store: M4ObserverStoreView,
  revision: string,
  projectionFailures: ReadonlyMap<string, string>,
): boolean {
  return (
    memo.report !== null &&
    memo.revision !== null &&
    memo.store === store &&
    memo.revision === revision &&
    projectionFailures.size === 0 &&
    store.listIncompleteEnvelopes().length === 0 &&
    m4ObserverFullyCaughtUp(store, revision)
  );
}

export function rememberM4ObserverReport(
  memo: M4ObserverMemo,
  store: M4ObserverStoreView,
  revision: string,
  report: ShadowReconciliationReport,
  projectionFailures: ReadonlyMap<string, string>,
): void {
  if (memo.store !== null && memo.store !== store) {
    resetM4ObserverHistory(memo);
  }
  memo.store = store;
  if (
    projectionFailures.size > 0 ||
    store.listIncompleteEnvelopes().length > 0 ||
    !m4ObserverFullyCaughtUp(store, revision)
  ) {
    invalidateM4ObserverMemo(memo);
    return;
  }
  memo.revision = revision;
  memo.report = report;
}

/** Log only parity / divergence-count transitions (not every observation). */
export function logM4ParityTransition(
  memo: M4ObserverMemo,
  report: ShadowReconciliationReport,
  log?: (line: string) => void,
): void {
  const write = log ?? ((line: string) => { console.error(line); });
  const divergences = report.entries.filter((entry) => entry.kind !== 'equal').length;
  if (
    memo.lastLoggedParity === report.parity &&
    memo.lastLoggedDivergences === divergences
  ) {
    return;
  }
  memo.lastLoggedParity = report.parity;
  memo.lastLoggedDivergences = divergences;
  write(
    '[hercules] M4 shadow parity=' +
      String(report.parity) +
      ' revision=' +
      report.authorityRevision +
      ' divergences=' +
      String(divergences) +
      ' cutover=false',
  );
}
