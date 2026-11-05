/**
 * Releases sheet: per-repo staging vs production drift, Release packet,
 * batch Merge, Deploy staging now, Promote / Rollback (confirm-guarded).
 * Promote briefing (release-8): trust chain, risk aggregates, enriched
 * per-task rows, evidence coverage, rollback preview, staging token copy.
 * Design §3/§6 — phone panel for the e2e release pipeline.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  ApiError,
  deployStagingNow,
  fetchReleases,
  mergeRepo,
  fetchMergeOperation,
  mintStagingHandoff,
  promoteRepo,
  rollbackRepo,
  type ReleasePanelEntryDto,
} from './api.js';
import { ConfirmButton } from './ConfirmButton.js';
import {
  isNetworkLayerFailure,
  waitForPromoteOutcome,
  waitForRollbackOutcome,
} from './promoteReconcile.js';
import { getCachedReleases, setCachedReleases } from './releasesCache.js';
import { trustChainZh } from './releasesText.js';
import { Markdown } from './Markdown.js';
import { t, type MessageKey } from './i18n.js';
import type { Lang } from './prefs.js';
import {
  formatStagingElapsedLabel,
  isStagingVerifyAbnormal,
  stagingElapsedMs,
} from '../domain/stagingVerify.js';
import { ShotLightbox, StagingShotThumb } from './EvidenceGallery.js';

const MERGE_OPS_STORAGE_KEY = 'hercules_merge_ops';
const MERGE_POLL_INTERVAL_MS = 1000;
const MERGE_POLL_MAX_ATTEMPTS = 7_200;

type StoredMergeOperation = {
  operationId: string | null;
  idempotencyKey: string;
  taskIds: string[];
  status: string;
  phase: string;
};

function loadStoredMergeOperations(): Record<string, StoredMergeOperation> {
  try {
    const raw = localStorage.getItem(MERGE_OPS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, StoredMergeOperation> = {};
    for (const [repoKey, value] of Object.entries(parsed)) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      const op = value as Record<string, unknown>;
      if (
        (op['operationId'] !== null && typeof op['operationId'] !== 'string') ||
        typeof op['idempotencyKey'] !== 'string' ||
        !Array.isArray(op['taskIds']) ||
        !op['taskIds'].every((id) => typeof id === 'string') ||
        typeof op['status'] !== 'string' ||
        typeof op['phase'] !== 'string'
      ) continue;
      result[repoKey] = {
        operationId: op['operationId'],
        idempotencyKey: op['idempotencyKey'],
        taskIds: op['taskIds'],
        status: op['status'],
        phase: op['phase'],
      };
    }
    return result;
  } catch {
    return {};
  }
}

function storeMergeOperations(operations: Record<string, StoredMergeOperation>): void {
  localStorage.setItem(MERGE_OPS_STORAGE_KEY, JSON.stringify(operations));
}

function sameTaskSelection(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function newMergeIdempotencyKey(): string {
  return `phone:${globalThis.crypto.randomUUID()}`;
}

function mergeOperationIsActive(status: string): boolean {
  return status === 'accepted' || status === 'running';
}

function isDefiniteMergeRejection(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status >= 400 && err.status < 500;
}

function shortSha(sha: string | null): string {
  if (!sha) return '—';
  return sha.length > 10 ? sha.slice(0, 8) : sha;
}

function statusPillClass(status: string | null, abnormal = false): string {
  if (abnormal) return 'pill pill-tone-danger';
  switch (status) {
    case 'ready':
      return 'pill pill-tone-success';
    case 'failed':
      return 'pill pill-tone-danger';
    case 'deploying':
    case 'verifying':
      return 'pill pill-tone-warn';
    default:
      return 'pill pill-tone-muted';
  }
}

function parseStartedMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function formatTs(iso: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function readAfterDeployChecked(storageKey: string | null): Set<string> {
  if (storageKey === null) return new Set();
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

/** Per-row optional after-deploy checklist; localStorage only, never blocks promote. */
function useAfterDeployChecks(
  repoKey: string,
  productionSha: string | null,
): { checked: ReadonlySet<string>; toggle: (key: string) => void } {
  const storageKey =
    productionSha !== null && productionSha !== ''
      ? `hercules.afterDeploy.${repoKey}.${productionSha}`
      : null;
  const [checked, setChecked] = useState<Set<string>>(() =>
    readAfterDeployChecked(storageKey),
  );
  useEffect(() => {
    setChecked(readAfterDeployChecked(storageKey));
  }, [storageKey]);
  const toggle = useCallback(
    (key: string) => {
      setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        if (storageKey !== null) {
          try {
            localStorage.setItem(storageKey, JSON.stringify([...next]));
          } catch {
            /* ignore quota / private mode */
          }
        }
        return next;
      });
    },
    [storageKey],
  );
  return { checked, toggle };
}

function AfterDeployChecksBlock(props: {
  repoKey: string;
  productionSha: string;
  checks: readonly { taskId: string; title: string; text: string }[];
  label: string;
}): JSX.Element {
  const { checked, toggle } = useAfterDeployChecks(props.repoKey, props.productionSha);
  return (
    <div className="releases-after-deploy" data-evidence="releases-after-deploy">
      <div className="body-label">{props.label}</div>
      <ul className="releases-after-deploy-list">
        {props.checks.map((c, i) => {
          const key = `${c.taskId}#${i}`;
          const done = checked.has(key);
          return (
            <li key={key} className={done ? 'is-done' : undefined}>
              <label>
                <input type="checkbox" checked={done} onChange={() => toggle(key)} />
                <span className="releases-after-deploy-text">{c.text}</span>
                <span className="muted"> · {c.title}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** i18n label for a digest area chip. */
function areaLabelKey(area: string | null): MessageKey {
  switch (area) {
    case 'src/web':
      return 'releasesAreaWeb';
    case 'src/orchestrator':
      return 'releasesAreaOrchestrator';
    case 'src/isolation':
      return 'releasesAreaIsolation';
    case 'scripts/':
      return 'releasesAreaScripts';
    case 'docs/':
      return 'releasesAreaDocs';
    case 'test/':
      return 'releasesAreaTests';
    default:
      return 'releasesAreaOther';
  }
}

export function ReleasesPanel({
  lang,
  onClose,
  onError,
  onChanged,
  onOpenTask,
  restoreScrollTop,
  scrollHost,
  nowMs,
}: {
  lang: Lang;
  /** Optional live clock (ms) so verifying elapsed ticks without full reload. */
  nowMs?: number;
  onClose: () => void;
  onError: (msg: string) => void;
  /** After a successful mutate so parent can refresh SSE/state. */
  onChanged?: () => void;
  /** Tap-through from an ahead-task row → open task detail. */
  onOpenTask?: (taskId: string) => void;
  /** One-shot scroll restore after returning from a task (nav stack). */
  restoreScrollTop?: { current: number | null };
  /** Scrollable sheet element hosting this panel. */
  scrollHost?: { current: HTMLDivElement | null };
}): JSX.Element {
  const tr = (key: MessageKey): string => t(lang, key);
  // Instant paint on reopen: seed from the module cache, refresh in the
  // background (the endpoint walks git mirrors and takes seconds).
  const [rows, setRows] = useState<ReleasePanelEntryDto[] | null>(() => getCachedReleases());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  /** Active merge operation progress by repo (server-authoritative). */
  const [mergeOps, setMergeOps] = useState<
    Record<string, StoredMergeOperation>
  >(loadStoredMergeOperations);
  const mergeOpsRef = useRef(mergeOps);
  const pendingPostKeysRef = useRef(new Set<string>());
  mergeOpsRef.current = mergeOps;
  useEffect(() => {
    try {
      storeMergeOperations(mergeOps);
    } catch (_err) {
      void _err;
    }
  }, [mergeOps]);
  const activeMergeKey = Object.entries(mergeOps)
    .filter(([, operation]) => mergeOperationIsActive(operation.status))
    .map(([repoKey, operation]) => `${repoKey}:${operation.operationId ?? 'pending'}`)
    .sort()
    .join('|');
  useEffect(() => {
    if (!activeMergeKey) return;
    let cancelled = false;
    let timer: number | null = null;
    let attempts = 0;
    const poll = async (): Promise<void> => {
      if (cancelled || attempts >= MERGE_POLL_MAX_ATTEMPTS) return;
      attempts += 1;
      const active = Object.entries(mergeOpsRef.current).filter(([, operation]) =>
        mergeOperationIsActive(operation.status),
      );
      await Promise.all(
        active.map(async ([repoKey, operation]) => {
          try {
            if (
              operation.operationId === null &&
              pendingPostKeysRef.current.has(operation.idempotencyKey)
            ) {
              return;
            }
            const receipt = operation.operationId
              ? await fetchMergeOperation(operation.operationId)
              : await mergeRepo(repoKey, operation.taskIds, operation.idempotencyKey);
            if (cancelled) return;
            if (!sameTaskSelection(receipt.taskIds, operation.taskIds)) {
              setMergeOps((previous) => {
                const next = { ...previous };
                delete next[repoKey];
                try {
                  storeMergeOperations(next);
                } catch (_err) {
                  void _err;
                }
                return next;
              });
              onError(t(lang, 'releasesMergeFailed'));
              return;
            }
            setMergeOps((previous) => ({
              ...previous,
              [repoKey]: {
                ...operation,
                operationId: receipt.operationId,
                taskIds: [...receipt.taskIds],
                status: receipt.status,
                phase: receipt.phase,
              },
            }));
            if (receipt.status === 'succeeded') {
              if (receipt.mergedSha) {
                setFlash(t(lang, 'releasesMergeOk'));
                onChanged?.();
              } else {
                onError(t(lang, 'releasesMergeFailed'));
              }
            } else if (receipt.status === 'failed' || receipt.status === 'interrupted') {
              const reasons = receipt.failures
                .map((failure) => `${failure.taskId}: ${failure.reason}`)
                .join('; ');
              onError(reasons || t(lang, 'releasesMergeFailed'));
            }
          } catch (err) {
            if (
              operation.operationId === null &&
              isDefiniteMergeRejection(err)
            ) {
              setMergeOps((previous) => {
                const current = previous[repoKey];
                if (current?.idempotencyKey !== operation.idempotencyKey) {
                  return previous;
                }
                const next = { ...previous };
                delete next[repoKey];
                mergeOpsRef.current = next;
                storeMergeOperations(next);
                return next;
              });
              onError(err.message);
              return;
            }
            // The operation is durable server state. Keep polling through a
            // phone disconnect or daemon restart with the same idempotency key.
          }
        }),
      );
      if (!cancelled && attempts < MERGE_POLL_MAX_ATTEMPTS) {
        timer = window.setTimeout(() => void poll(), MERGE_POLL_INTERVAL_MS);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [activeMergeKey, lang, onChanged, onError]);
  /** Selected mergeable task ids per repo. */
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  const [lightboxPath, setLightboxPath] = useState<string | null>(null);
  /** Local 1s clock for verifying/deploying elapsed labels. */
  const [tickMs, setTickMs] = useState(() => Date.now());
  /**
   * One-time staging auto-unlock code (#hsc fragment on the staging link).
   * Minted eagerly per refresh; null when this daemon has no mint file
   * (e.g. the staging instance itself) — the link then opens the plain URL.
   */
  const [handoffCode, setHandoffCode] = useState<string | null>(null);

  const clockMs = nowMs ?? tickMs;
  const hasLiveVerify = (rows ?? []).some(
    (r) => r.stagingStatus === 'verifying' || r.stagingStatus === 'deploying',
  );
  useEffect(() => {
    if (nowMs !== undefined) return; // parent owns the clock
    if (!hasLiveVerify) return;
    const id = window.setInterval(() => setTickMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasLiveVerify, nowMs]);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await fetchReleases();
      setRows(list);
      setCachedReleases(list);
      setLoadError(null);
      if (list.some((r) => r.stagingUrl)) {
        try {
          setHandoffCode((await mintStagingHandoff()).code);
        } catch {
          setHandoffCode(null);
        }
      }
      setSelected((prev) => {
        const next: Record<string, Set<string>> = {};
        for (const r of list) {
          const keep = prev[r.repoKey];
          if (!keep) continue;
          const mergeable = new Set(r.mergeableTasks.map((t) => t.id));
          const filtered = new Set([...keep].filter((id) => mergeable.has(id)));
          if (filtered.size > 0) next[r.repoKey] = filtered;
        }
        return next;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLoadError(msg);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Returning from a task: restore the reading position once the data has
  // rendered. Content keeps growing asynchronously (markdown, auth-loaded
  // thumbnails), so a single set gets clamped to the current shorter height —
  // hold the target in state and keep retrying (independent of later rows
  // updates) until the browser accepts it or the window closes.
  const [pendingScroll, setPendingScroll] = useState<number | null>(null);
  useEffect(() => {
    if (rows === null) return;
    const pending = restoreScrollTop?.current ?? null;
    if (pending === null) return;
    restoreScrollTop!.current = null;
    setPendingScroll(pending);
  }, [rows, restoreScrollTop]);
  useEffect(() => {
    if (pendingScroll === null) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      const host = scrollHost?.current;
      tries += 1;
      if (!host || tries > 80) {
        window.clearInterval(timer);
        setPendingScroll(null);
        return;
      }
      host.scrollTop = pendingScroll;
      if (Math.abs(host.scrollTop - pendingScroll) < 2) {
        window.clearInterval(timer);
        setPendingScroll(null);
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [pendingScroll, scrollHost]);

  const run = async (actionKey: string, fn: () => Promise<unknown>): Promise<void> => {
    if (busyKey) return;
    setBusyKey(actionKey);
    setFlash(null);
    try {
      await fn();
      await refresh();
      onChanged?.();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const toggleTask = (repoKey: string, taskId: string): void => {
    setSelected((prev) => {
      const cur = new Set(prev[repoKey] ?? []);
      if (cur.has(taskId)) cur.delete(taskId);
      else cur.add(taskId);
      return { ...prev, [repoKey]: cur };
    });
  };

  const selectAllMergeable = (row: ReleasePanelEntryDto): void => {
    setSelected((prev) => ({
      ...prev,
      [row.repoKey]: new Set(row.mergeableTasks.map((t) => t.id)),
    }));
  };

  const copyStagingToken = async (token: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(token);
      setFlash(tr('releasesTokenCopied'));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  /** When the sheet is open but no production-enabled row exists, keep
   *  disabled Promote/Rollback hooks for L2 (empty `repos: {}` boot). Only
   *  rendered while this panel is mounted — never on the task list. */
  const shellPromoteChrome =
    rows === null || rows.length === 0 || !rows.some((r) => r.hasProductionDeploy);

  return (
    <div className="releases-panel" data-evidence="releases-panel">
      <div className="sheet-head-row">
        <h2>{tr('releasesTitle')}</h2>
        <button type="button" className="link" onClick={onClose}>
          {tr('releasesClose')}
        </button>
      </div>

      <p className="muted releases-hint">{tr('releasesHint')}</p>

      {flash ? (
        <div className="repo-flash" data-evidence="releases-flash" role="status">
          {flash}
          <button type="button" className="link" onClick={() => setFlash(null)}>
            {tr('releasesDismiss')}
          </button>
        </div>
      ) : null}

      {loadError ? (
        <div className="banner banner-danger" data-evidence="releases-load-error">
          {loadError}
          <button type="button" className="link" onClick={() => void refresh()}>
            {tr('releasesRetry')}
          </button>
        </div>
      ) : null}

      {rows === null && !loadError ? (
        <p className="muted">{tr('releasesLoading')}</p>
      ) : null}

      {rows !== null && rows.length === 0 ? (
        <p className="muted" data-evidence="releases-empty">
          {tr('releasesEmpty')}
        </p>
      ) : null}

      {/* Shell Promote/Rollback for L2 evidence when L2 boots with empty
          repos.yaml (no per-repo rows). Real actions live on repo rows. */}
      {shellPromoteChrome ? (
        <div
          className="releases-actions releases-actions-main"
          data-evidence="releases-shell-actions"
        >
          <ConfirmButton
            className="primary releases-btn"
            disabled
            data-evidence="promote-btn"
            label={tr('releasesPromote')}
            confirmLabel={tr('releasesPromoteConfirm')}
            onConfirm={() => {
              /* shell chrome — no repo to promote */
            }}
          />
          <ConfirmButton
            className="danger releases-btn"
            disabled
            data-evidence="rollback-btn"
            label={tr('releasesRollback')}
            confirmLabel={tr('releasesRollbackConfirm')}
            onConfirm={() => {
              /* shell chrome — no repo to roll back */
            }}
          />
        </div>
      ) : null}

      <ul className="releases-list">
        {(rows ?? []).map((row) => {
          const sel = selected[row.repoKey] ?? new Set();
          const mergeBusy = busyKey === `merge:${row.repoKey}`;
          const mergeActive = mergeOperationIsActive(
            mergeOps[row.repoKey]?.status ?? '',
          );
          const deployBusy = busyKey === `deploy:${row.repoKey}`;
          const promoteBusy = busyKey === `promote:${row.repoKey}`;
          const rollbackBusy = busyKey === `rollback:${row.repoKey}`;
          const anyBusy = busyKey !== null;
          const risk = row.rangeRisk;

          return (
            <li
              key={row.repoKey}
              className="releases-item"
              data-evidence={`release-repo-${row.repoKey}`}
            >
              <div className="releases-item-head">
                <strong className="releases-repo-key">{row.repoKey}</strong>
                {(() => {
                  const startedMs = parseStartedMs(row.stagingStartedAt ?? null);
                  const elapsed = stagingElapsedMs({
                    stagingStartedAtMs: startedMs,
                    nowMs: clockMs,
                  });
                  const timeoutMs = row.stagingVerifyTimeoutMs ?? 15 * 60 * 1000;
                  const abnormal = isStagingVerifyAbnormal({
                    stagingStatus: row.stagingStatus,
                    elapsedMs: elapsed,
                    overallTimeoutMs: timeoutMs,
                  });
                  const live =
                    row.stagingStatus === 'verifying' || row.stagingStatus === 'deploying';
                  // Mirror saw a newer main but the reconciler's debounce has not
                  // started the verify yet: the recorded status belongs to the OLD
                  // staging sha, so a green `ready` here would be a lie.
                  const queued =
                    !live &&
                    row.promotingSha === null &&
                    row.mainSha !== null &&
                    row.mainSha !== row.stagingSha;
                  return (
                    <>
                      <span
                        className={
                          queued ? 'pill pill-tone-warn' : statusPillClass(row.stagingStatus, abnormal)
                        }
                        data-evidence="staging-status"
                        data-queued={queued ? 'true' : undefined}
                      >
                        {queued
                          ? tr('releasesStagingQueued')
                          : (row.stagingStatus ?? tr('releasesStatusUnknown'))}
                      </span>
                      {live && elapsed !== null ? (
                        <span
                          className={
                            abnormal ? 'pill pill-tone-danger' : 'pill pill-tone-muted'
                          }
                          data-evidence="staging-verify-elapsed"
                          title={
                            abnormal
                              ? tr('releasesVerifyAbnormal').replace(
                                  '{dur}',
                                  formatStagingElapsedLabel(elapsed),
                                )
                              : tr('releasesVerifyElapsed').replace(
                                  '{dur}',
                                  formatStagingElapsedLabel(elapsed),
                                )
                          }
                        >
                          {abnormal
                            ? tr('releasesVerifyAbnormal').replace(
                                '{dur}',
                                formatStagingElapsedLabel(elapsed),
                              )
                            : tr('releasesVerifyElapsed').replace(
                                '{dur}',
                                formatStagingElapsedLabel(elapsed),
                              )}
                        </span>
                      ) : null}
                    </>
                  );
                })()}
                {row.promotingSha ? (
                  <span className="pill pill-tone-warn" data-evidence="promoting-pill">
                    {tr('releasesPromoting')}
                  </span>
                ) : null}
              </div>

              <div className="releases-shas muted">
                <div>
                  {tr('releasesProduction')}: <code>{shortSha(row.productionSha)}</code>
                </div>
                <div>
                  {tr('releasesStaging')}: <code>{shortSha(row.stagingSha)}</code>
                  {row.mainSha ? (
                    <>
                      {' '}
                      · main <code>{shortSha(row.mainSha)}</code>
                    </>
                  ) : null}
                </div>
              </div>

              {row.afterDeployChecks &&
              row.afterDeployChecks.length > 0 &&
              row.productionSha ? (
                <AfterDeployChecksBlock
                  repoKey={row.repoKey}
                  productionSha={row.productionSha}
                  checks={row.afterDeployChecks}
                  label={tr('releasesAfterDeploy')}
                />
              ) : null}

              {/* Business-level digest: what ships, at a glance */}
              {row.digest && row.aheadCount > 0 ? (
                <div className="releases-digest" data-evidence="releases-digest">
                  <div className="body-label">{tr('releasesDigestTitle')}</div>
                  <div className="releases-chip-row">
                    <span className="pill pill-tone-accent">
                      {tr('releasesDigestChanges').replace('{n}', String(row.aheadCount))}
                    </span>
                    {row.digest.areaCounts.map((a) => (
                      <span key={a.area ?? 'other'} className="pill pill-tone-muted">
                        {tr(areaLabelKey(a.area))} ×{a.count}
                      </span>
                    ))}
                  </div>
                  <ul className="releases-digest-headlines">
                    {row.digest.headlines.map((h) => (
                      <li key={h}>{h}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {/* Trust-chain statement */}
              {row.aheadCount > 0 || row.trustChain ? (
                <div className="releases-trust" data-evidence="releases-trust-chain">
                  <div className="body-label">{tr('releasesTrustChain')}</div>
                  <p className="releases-trust-text">
                    {lang === 'zh' ? trustChainZh(row) : row.trustChain}
                  </p>
                </div>
              ) : null}

              {/* Risk aggregates (chips / lines — phone-first) */}
              {risk ? (
                <div className="releases-risk" data-evidence="releases-risk">
                  <div className="body-label">{tr('releasesRisk')}</div>
                  <div className="releases-chip-row">
                    <span className="pill pill-tone-muted" data-evidence="risk-files">
                      {tr('releasesFiles').replace('{n}', String(risk.filesChanged))}
                    </span>
                    <span className="pill pill-tone-muted" data-evidence="risk-lines">
                      {tr('releasesLines')
                        .replace('{ins}', String(risk.insertions))
                        .replace('{del}', String(risk.deletions))}
                    </span>
                    <span className="pill pill-tone-accent" data-evidence="risk-size">
                      {risk.size}
                    </span>
                    {risk.areas.map((a) => (
                      <span
                        key={a.area}
                        className="pill pill-tone-muted"
                        data-evidence={`risk-area-${a.area.replace(/[/\s]/g, '-')}`}
                      >
                        {a.area} ×{a.count}
                      </span>
                    ))}
                  </div>
                  {risk.sensitivePaths.length > 0 ? (
                    <div
                      className="banner banner-warn releases-sensitive"
                      data-evidence="releases-sensitive"
                    >
                      <strong>{tr('releasesSensitive')}:</strong>{' '}
                      {risk.sensitivePaths.map((p) => (
                        <code key={p}>{p}</code>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="releases-drift" data-evidence="releases-drift">
                {row.aheadCount > 0 ? (
                  <>
                    <div className="releases-drift-label">
                      {tr('releasesStagingAhead').replace('{n}', String(row.aheadCount))}
                    </div>
                    <ul className="releases-task-list">
                      {row.aheadTasks.map((task) => (
                        <li key={task.id}>
                          <button
                            type="button"
                            className="releases-task-row"
                            data-evidence={`ahead-task-${task.id}`}
                            onClick={() => onOpenTask?.(task.id)}
                          >
                            <span className="releases-task-main">
                              <code>{task.id}</code>: {task.title}
                            </span>
                            <span className="releases-chip-row releases-task-chips">
                              {task.area ? (
                                <span className="pill pill-tone-muted">{task.area}</span>
                              ) : null}
                              <span className="pill pill-tone-accent">{task.size}</span>
                              {task.mergedVia === 'operator' ? (
                                <span
                                  className="pill pill-tone-warn"
                                  data-evidence={`operator-merged-${task.id}`}
                                >
                                  {tr('releasesOperatorMerged')}
                                </span>
                              ) : null}
                              {task.verified === false ? (
                                <span
                                  className="pill pill-failed"
                                  data-evidence={`unverified-${task.id}`}
                                >
                                  {tr('releasesUnverified')}
                                </span>
                              ) : null}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : row.directCommits?.length ? null : (
                  <div className="muted">
                    {row.productionSha
                      ? tr('releasesNoDrift')
                      : tr('releasesNoProductionYet')}
                  </div>
                )}
                {row.directCommits && row.directCommits.length > 0 ? (
                  <div className="releases-direct" data-evidence="releases-direct-commits">
                    <div className="body-label">{tr('releasesDirectCommits')}</div>
                    <ul className="releases-direct-list">
                      {row.directCommits.map((c) => (
                        <li key={c.sha}>
                          <code>{c.sha.slice(0, 7)}</code> {c.subject}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {row.stagingDrift ? (
                  <div className="banner banner-warn releases-main-drift">
                    {tr('releasesMainDrift')}
                  </div>
                ) : null}
              </div>

              {/* Evidence coverage + soak */}
              {row.evidenceCoverage || row.stagingVerifiedAt ? (
                <div className="releases-evidence" data-evidence="releases-evidence">
                  {row.evidenceCoverage ? (
                    <span className="pill pill-tone-success" data-evidence="evidence-coverage">
                      {tr('releasesEvidence')}: {row.evidenceCoverage.label}
                    </span>
                  ) : null}
                  {row.stagingVerifiedAt ? (
                    <div className="muted releases-soak" data-evidence="releases-soak">
                      {tr('releasesSoakSince').replace(
                        '{ts}',
                        formatTs(row.stagingVerifiedAt),
                      )}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/* Staging screenshots (inline, tap to enlarge) */}
              {row.stagingScreenshots.length > 0 ? (
                <div className="releases-shots" data-evidence="releases-screenshots">
                  <div className="body-label">{tr('releasesScreenshots')}</div>
                  <div className="releases-shot-row">
                    {row.stagingScreenshots.map((name) => (
                      <StagingShotThumb
                        key={name}
                        repoKey={row.repoKey}
                        name={name}
                        onOpen={setLightboxPath}
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              {row.failureReason ? (
                <div className="banner banner-danger" data-evidence="releases-failure">
                  {row.failureReason}
                </div>
              ) : null}

              {row.stagingUrl ? (
                <p className="releases-staging-link">
                  <a
                    href={
                      handoffCode !== null
                        ? `${row.stagingUrl}#hsc=${handoffCode}`
                        : row.stagingUrl
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    data-evidence="staging-url"
                  >
                    {tr('releasesOpenStaging')}
                  </a>
                  {row.stagingUiToken ? (
                    <button
                      type="button"
                      className="link releases-copy-token"
                      data-evidence="copy-staging-token"
                      onClick={() => void copyStagingToken(row.stagingUiToken!)}
                    >
                      {tr('releasesCopyStagingToken')}
                    </button>
                  ) : null}
                </p>
              ) : null}

              {row.mergeableTasks.length > 0 ? (
                <section className="releases-section" data-evidence="releases-merge">
                  <div className="body-label">{tr('releasesMergeTitle')}</div>
                  <ul className="releases-merge-list">
                    {row.mergeableTasks.map((task) => (
                      <li key={task.id}>
                        <label className="releases-check">
                          <input
                            type="checkbox"
                            checked={sel.has(task.id)}
                            disabled={anyBusy}
                            onChange={() => toggleTask(row.repoKey, task.id)}
                            data-evidence={`merge-task-${task.id}`}
                          />
                          <span>
                            <code>{task.id}</code> {task.title}
                          </span>
                        </label>
                        {task.deliveryPipeline ? (
                          <div
                            className="releases-pipeline muted"
                            data-evidence="delivery-pipeline"
                          >
                            <span data-evidence="lane-verification">
                              verify:{task.deliveryPipeline.verification}
                            </span>
                            {' · '}
                            <span data-evidence="lane-merge-eligibility">
                              merge:{task.deliveryPipeline.mergeEligibility}
                            </span>
                            {' · '}
                            <span data-evidence="lane-project-state-closure">
                              closure:{task.deliveryPipeline.projectStateClosure}
                            </span>
                            {' · '}
                            <span data-evidence="lane-deployment">
                              deploy:{task.deliveryPipeline.deployment}
                            </span>
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  <div className="releases-actions">
                    <button
                      type="button"
                      className="link"
                      disabled={anyBusy}
                      onClick={() => selectAllMergeable(row)}
                    >
                      {tr('releasesSelectAll')}
                    </button>
                    <button
                      type="button"
                      className="primary releases-btn"
                      disabled={anyBusy || mergeActive || sel.size === 0}
                      data-evidence="merge-btn"
                      onClick={() =>
                        void run(`merge:${row.repoKey}`, async () => {
                          const taskIds = [...sel];
                          const idempotencyKey = newMergeIdempotencyKey();
                          const pending: StoredMergeOperation = {
                            operationId: null,
                            idempotencyKey,
                            taskIds,
                            status: 'accepted',
                            phase: 'accepted',
                          };
                          const next = {
                            ...mergeOpsRef.current,
                            [row.repoKey]: pending,
                          };
                          // The retry identity and exact ordered selection must
                          // survive a transport loss before the POST can begin.
                          storeMergeOperations(next);
                          mergeOpsRef.current = next;
                          pendingPostKeysRef.current.add(idempotencyKey);
                          setMergeOps((prev) => ({
                            ...prev,
                            [row.repoKey]: pending,
                          }));
                          let receipt: Awaited<ReturnType<typeof mergeRepo>>;
                          try {
                            receipt = await mergeRepo(
                              row.repoKey,
                              taskIds,
                              idempotencyKey,
                            );
                          } catch (err) {
                            if (isDefiniteMergeRejection(err)) {
                              const current = mergeOpsRef.current[row.repoKey];
                              if (current?.idempotencyKey === idempotencyKey) {
                                const cleared = { ...mergeOpsRef.current };
                                delete cleared[row.repoKey];
                                storeMergeOperations(cleared);
                                mergeOpsRef.current = cleared;
                                setMergeOps(cleared);
                              }
                              throw err;
                            }
                            // No HTTP response means the server may have
                            // durably accepted the operation. Preserve the
                            // pending key/selection and let the effect retry.
                            return;
                          } finally {
                            pendingPostKeysRef.current.delete(idempotencyKey);
                          }
                          if (!sameTaskSelection(receipt.taskIds, taskIds)) {
                            const cleared = { ...mergeOpsRef.current };
                            delete cleared[row.repoKey];
                            storeMergeOperations(cleared);
                            mergeOpsRef.current = cleared;
                            setMergeOps(cleared);
                            throw new Error('merge receipt selection mismatch');
                          }
                          setMergeOps((prev) => ({
                            ...prev,
                            [row.repoKey]: {
                              operationId: receipt.operationId,
                              idempotencyKey,
                              taskIds: [...receipt.taskIds],
                              status: receipt.status,
                              phase: receipt.phase,
                            },
                          }));
                        })
                      }
                    >
                      {mergeBusy || mergeActive ? (
                        <span className="spinner" />
                      ) : tr('releasesMerge')}
                    </button>
                    {mergeOps[row.repoKey] ? (
                      <span
                        className="muted"
                        data-evidence="merge-operation-status"
                        data-merge-status={mergeOps[row.repoKey]!.status}
                        data-merge-phase={mergeOps[row.repoKey]!.phase}
                      >
                        {mergeOps[row.repoKey]!.status}:{mergeOps[row.repoKey]!.phase}
                      </span>
                    ) : null}
                  </div>
                </section>
              ) : null}

              {/* Rollback preview next to Promote */}
              {row.hasProductionDeploy ? (
                <div
                  className={
                    row.rollbackPreview.hasTarget
                      ? 'releases-rollback-preview muted'
                      : 'banner banner-warn releases-rollback-preview'
                  }
                  data-evidence="releases-rollback-preview"
                >
                  {row.rollbackPreview.hasTarget
                    ? tr('releasesRollbackPreview')
                        .replace('{sha}', shortSha(row.rollbackPreview.targetSha))
                        .replace('{ts}', formatTs(row.rollbackPreview.deployedAt))
                    : tr('releasesRollbackNone')}
                </div>
              ) : null}

              <div className="releases-actions releases-actions-main">
                <button
                  type="button"
                  className="releases-btn"
                  disabled={anyBusy}
                  data-evidence="deploy-staging-btn"
                  onClick={() =>
                    void run(`deploy:${row.repoKey}`, async () => {
                      await deployStagingNow(row.repoKey);
                      setFlash(tr('releasesDeployQueued'));
                    })
                  }
                >
                  {deployBusy ? <span className="spinner" /> : tr('releasesDeployStaging')}
                </button>

                {row.hasProductionDeploy ? (
                  <ConfirmButton
                    className="primary releases-btn"
                    disabled={anyBusy || !row.canPromote}
                    loading={promoteBusy}
                    data-evidence="promote-btn"
                    label={tr('releasesPromote')}
                    confirmLabel={tr('releasesPromoteConfirm')}
                    onConfirm={() =>
                      void run(`promote:${row.repoKey}`, async () => {
                        const expected = row.stagingSha;
                        try {
                          const result = await promoteRepo(row.repoKey);
                          if (result.outcome === 'ok') {
                            setFlash(tr('releasesPromoteOk'));
                          } else {
                            onError(result.alert ?? tr('releasesPromoteRolledBack'));
                          }
                        } catch (err) {
                          // Self-promote restarts this daemon mid-response.
                          if (!isNetworkLayerFailure(err) || !expected) {
                            throw err;
                          }
                          setFlash(tr('releasesPromoteRestarting'));
                          const outcome = await waitForPromoteOutcome(row.repoKey, expected);
                          if (outcome.status === 'ok') {
                            setFlash(tr('releasesPromoteOk'));
                          } else if (outcome.status === 'rolled_back') {
                            setFlash(null);
                            const target = shortSha(outcome.targetSha);
                            onError(`${tr('releasesPromoteRolledBack')} ${target}`);
                          } else {
                            setFlash(tr('releasesPromoteUnknown'));
                          }
                        }
                      })
                    }
                  />
                ) : null}

                {row.hasProductionDeploy ? (
                  <ConfirmButton
                    className="danger releases-btn"
                    disabled={anyBusy || !row.canRollback}
                    loading={rollbackBusy}
                    data-evidence="rollback-btn"
                    label={tr('releasesRollback')}
                    confirmLabel={tr('releasesRollbackConfirm')}
                    onConfirm={() =>
                      void run(`rollback:${row.repoKey}`, async () => {
                        const expectedTarget = row.rollbackTargetSha;
                        try {
                          const result = await rollbackRepo(row.repoKey);
                          setFlash(
                            result.alert ??
                              `${tr('releasesRollbackOk')} ${shortSha(result.productionSha)}`,
                          );
                        } catch (err) {
                          // Self-rollback can restart the daemon mid-response.
                          if (!isNetworkLayerFailure(err) || !expectedTarget) {
                            throw err;
                          }
                          setFlash(tr('releasesPromoteRestarting'));
                          const outcome = await waitForRollbackOutcome(
                            row.repoKey,
                            expectedTarget,
                          );
                          if (outcome.status === 'ok') {
                            setFlash(
                              `${tr('releasesRollbackOk')} ${shortSha(expectedTarget)}`,
                            );
                          } else {
                            setFlash(tr('releasesPromoteUnknown'));
                          }
                        }
                      })
                    }
                  />
                ) : null}
              </div>

              {row.packetBody.trim() ? (
                <details className="releases-packet" data-evidence="release-packet">
                  <summary>{tr('releasesPacket')}</summary>
                  <div className="releases-packet-body">
                    <Markdown text={row.packetBody} />
                    {row.stagingScreenshots.length > 0 ? (
                      <div className="releases-shot-row releases-packet-shots">
                        {row.stagingScreenshots.map((name) => (
                          <StagingShotThumb
                            key={`pkt-${name}`}
                            repoKey={row.repoKey}
                            name={name}
                            onOpen={setLightboxPath}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                </details>
              ) : null}
            </li>
          );
        })}
      </ul>

      {lightboxPath ? (
        <ShotLightbox path={lightboxPath} onClose={() => setLightboxPath(null)} />
      ) : null}
    </div>
  );
}
