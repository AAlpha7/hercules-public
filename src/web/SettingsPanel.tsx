/**
 * Settings sheet: language (en/zh), preferred default agent, cost caps, self-update, logout.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  ApiError,
  fetchSelfUpdateStatus,
  startSelfUpdate,
  recoverReviewerProvider,
  type CostCapSummaryDto,
  type ProviderPolicyDto,
  type ReviewerProviderHealthDto,
  type SelfUpdateStatus,
} from './api.js';
import { ConfirmButton } from './ConfirmButton.js';
import { SegmentedControl } from './SegmentedControl.js';
import { t, type MessageKey } from './i18n.js';
import type { Lang } from './prefs.js';
import { resetSheetHabits } from './sheetHabits.js';

/** Soft/hard cap display; null → ∞. */
function fmtCap(n: number | null | undefined): string {
  if (n === null || n === undefined) return '∞';
  return n.toFixed(2);
}

function fmtTokens(n: number): string {
  return n.toLocaleString('en-US');
}

function costMeaningKey(mode: 'subscription' | 'metered'): MessageKey {
  if (mode === 'subscription') return 'settingsCostMeaningSubscription';
  return 'settingsCostMeaningMetered';
}

function ledgerStatusKey(status: NonNullable<CostCapSummaryDto['ledger']>['status']): MessageKey {
  if (status === 'ok') return 'settingsCostLedgerOk';
  if (status === 'migrated') return 'settingsCostLedgerMigrated';
  if (status === 'partial') return 'settingsCostLedgerPartial';
  if (status === 'corrupt') return 'settingsCostLedgerCorrupt';
  if (status === 'unavailable') return 'settingsCostLedgerUnavailable';
  return 'settingsCostLedgerMemory';
}

function fmtLedgerTime(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString();
}

export function SettingsPanel({
  lang,
  preferredAgent,
  daemonDefault,
  availableAgents,
  providerPolicy,
  costSummary,
  reviewerHealth,
  onLangChange,
  onPreferredAgentChange,
  onLogout,
  onClose,
}: {
  lang: Lang;
  /** Empty string = inherit repo → daemon. */
  preferredAgent: string;
  daemonDefault: string;
  availableAgents: readonly string[];
  /** Effective public provider policy from the daemon; contains no credentials. */
  providerPolicy?: ProviderPolicyDto | null;
  /** Optional cost-cap summary from /api/state (older daemons omit). */
  costSummary?: CostCapSummaryDto | null;
  reviewerHealth?: readonly ReviewerProviderHealthDto[];
  onLangChange: (lang: Lang) => void;
  onPreferredAgentChange: (agent: string) => void;
  onLogout: () => void;
  onClose: () => void;
}): JSX.Element {
  const tr = (key: MessageKey): string => t(lang, key);
  const [update, setUpdate] = useState<SelfUpdateStatus | null>(null);
  /** false = endpoint missing (older daemon); null = still loading. */
  const [updateAvailable, setUpdateAvailable] = useState<boolean | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [reviewerRecoveryBusy, setReviewerRecoveryBusy] = useState<string | null>(null);
  const [reviewerRecoveryError, setReviewerRecoveryError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = useCallback((): void => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const refreshUpdate = useCallback(async (): Promise<SelfUpdateStatus | null> => {
    try {
      const st = await fetchSelfUpdateStatus();
      setUpdate(st);
      setUpdateAvailable(true);
      setUpdateError(null);
      return st;
    } catch (err) {
      // 404 = older daemon without self-update wiring — hide the section.
      if (err instanceof ApiError && err.status === 404) {
        setUpdate(null);
        setUpdateAvailable(false);
        return null;
      }
      setUpdateAvailable(true);
      const msg = err instanceof Error ? err.message : String(err);
      setUpdateError(msg);
      return null;
    }
  }, []);

  useEffect(() => {
    void refreshUpdate();
    return stopPoll;
  }, [refreshUpdate, stopPoll]);

  useEffect(() => {
    if (update?.phase !== 'running') {
      stopPoll();
      return;
    }
    if (pollRef.current) return;
    pollRef.current = setInterval(() => {
      void refreshUpdate().then((st) => {
        if (st && st.phase !== 'running') stopPoll();
      });
    }, 1500);
    return stopPoll;
  }, [update?.phase, refreshUpdate, stopPoll]);

  const onUpdateConfirm = (): void => {
    setUpdateError(null);
    void startSelfUpdate()
      .then((st) => {
        setUpdate(st);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setUpdateError(msg);
        void refreshUpdate();
      });
  };

  const updating = update?.phase === 'running';
  const updateDisabled = update?.enabled === false;

  const recoverReviewer = (provider: string, mode: 'health_check' | 'operator'): void => {
    setReviewerRecoveryBusy(provider);
    setReviewerRecoveryError(null);
    void recoverReviewerProvider(provider, mode)
      .then(() => window.location.reload())
      .catch((err: unknown) => {
        setReviewerRecoveryError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setReviewerRecoveryBusy(null));
  };

  return (
    <div className="settings-panel" data-evidence="settings-panel">
      <div className="sheet-head-row">
        <h2>{tr('settingsTitle')}</h2>
        <button type="button" className="link" onClick={onClose}>
          {tr('settingsClose')}
        </button>
      </div>

      <section className="settings-section" data-evidence="settings-language">
        <div className="body-label">{tr('settingsLanguage')}</div>
        <SegmentedControl
          ariaLabel={tr('settingsLanguage')}
          value={lang}
          onChange={onLangChange}
          options={[
            { value: 'en', label: tr('settingsLangEn') },
            { value: 'zh', label: tr('settingsLangZh') },
          ]}
        />
      </section>

      <section className="settings-section" data-evidence="settings-agent">
        <label className="settings-field">
          {tr('settingsDefaultAgent')}
          <select
            value={preferredAgent}
            onChange={(e) => onPreferredAgentChange(e.target.value)}
          >
            <option value="">
              {tr('settingsInheritDaemon')} → {daemonDefault}
            </option>
            {availableAgents.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <p className="muted settings-hint">{tr('settingsDefaultAgentHint')}</p>
        <p className="muted settings-hint">
          {tr('settingsDaemonDefault')}: <strong>{daemonDefault}</strong>
        </p>
        {providerPolicy && (
          <div data-evidence="settings-provider-policy">
            <p className="muted settings-hint" data-evidence="settings-codex-policy">
              {tr('settingsCodexPolicy')}:{' '}
              <strong>{providerPolicy.codex.model}</strong> · {providerPolicy.codex.reasoningEffort}
            </p>
            <p className="muted settings-hint" data-evidence="settings-claude-policy">
              {tr('settingsClaudePolicy')}:{' '}
              <strong>
                {providerPolicy.claudeEnabled
                  ? tr('settingsProviderEnabled')
                  : tr('settingsProviderDisabled')}
              </strong>
            </p>
          </div>
        )}
      </section>

      {reviewerHealth && reviewerHealth.length > 0 && (
        <section className="settings-section" data-evidence="settings-reviewer-health">
          <div className="body-label">{tr('settingsReviewerHealthTitle')}</div>
          {reviewerHealth.map((health) => (
            <div key={health.provider} className="settings-provider-health" data-evidence="reviewer-infra-receipt">
              <p className="settings-update-status is-fail">
                <strong>{health.provider}</strong> · {health.state} · {health.failureKind}
              </p>
              <p className="muted settings-hint">{health.detail}</p>
              <p className="muted settings-hint">{health.nextAction}</p>
              <div className="button-row">
                <button
                  type="button"
                  disabled={reviewerRecoveryBusy !== null}
                  onClick={() => recoverReviewer(health.provider, 'health_check')}
                  data-evidence="reviewer-health-check"
                >
                  {tr('settingsReviewerHealthCheck')}
                </button>
                <ConfirmButton
                  label={tr('settingsReviewerRecover')}
                  confirmLabel={tr('settingsReviewerRecoverConfirm')}
                  onConfirm={() => recoverReviewer(health.provider, 'operator')}
                  disabled={reviewerRecoveryBusy !== null}
                  data-evidence="reviewer-explicit-recovery"
                />
              </div>
            </div>
          ))}
          {reviewerRecoveryError && (
            <p className="settings-update-status is-fail" data-evidence="reviewer-recovery-error">
              {reviewerRecoveryError}
            </p>
          )}
        </section>
      )}

      <section className="settings-section" data-evidence="settings-cost-caps">
        <div className="body-label">{tr('settingsCostTitle')}</div>
        {!costSummary || !costSummary.enabled ? (
          <p className="muted settings-hint" data-evidence="settings-cost-off">
            {tr('settingsCostOff')}
          </p>
        ) : (
          <div data-evidence="settings-cost-on">
            {costSummary.billingMode && (
              <p className="muted settings-hint" data-evidence="settings-cost-billing-mode">
                {tr('settingsCostBillingMode')}:{' '}
                <strong>
                  {costSummary.billingMode === 'subscription'
                    ? tr('settingsCostModeSubscription')
                    : tr('settingsCostModeMetered')}
                </strong>
              </p>
            )}
            {costSummary.billingMode && (
              <p className="muted settings-hint" data-evidence="settings-cost-meaning">
                {tr(costMeaningKey(costSummary.billingMode))}
              </p>
            )}
            {costSummary.policy && (
              <>
                <p className="muted settings-hint" data-evidence="settings-cost-thresholds">
                  {tr('settingsCostThresholds')}:{' '}
                  {tr('settingsCostTaskLabel')}{' '}
                  ${fmtCap(costSummary.policy.perTask.softUsd)}/
                  {fmtCap(costSummary.policy.perTask.hardUsd)}
                  {' · '}
                  {tr('settingsCostDayLabel')}{' '}
                  ${fmtCap(costSummary.policy.daily.softUsd)}/
                  {fmtCap(costSummary.policy.daily.hardUsd)}
                </p>
                <p className="muted settings-hint" data-evidence="settings-cost-enforced">
                  {tr('settingsCostEnforced')}:{' '}
                  {tr('settingsCostTaskLabel')} USD {tr('settingsCostHardLabel')}{' '}
                  ${fmtCap(costSummary.policy.perTask.hardUsd)}
                  {' · '}
                  {tr('settingsCostDayLabel')} USD {tr('settingsCostHardLabel')}{' '}
                  ${fmtCap(costSummary.policy.daily.hardUsd)}
                  {costSummary.policy.perTask.hardTokens !== null && (
                    <>
                      {' · '}{tr('settingsCostTaskLabel')} {tr('settingsCostTokenOverride')}{' '}
                      {fmtTokens(costSummary.policy.perTask.hardTokens)}
                    </>
                  )}
                  {costSummary.policy.daily.hardTokens !== null && (
                    <>
                      {' · '}{tr('settingsCostDayLabel')} {tr('settingsCostTokenOverride')}{' '}
                      {fmtTokens(costSummary.policy.daily.hardTokens)}
                    </>
                  )}
                </p>
                {(costSummary.policy.perTask.hardTokens === null ||
                  costSummary.policy.daily.hardTokens === null) && (
                  <p className="muted settings-hint" data-evidence="settings-cost-advisory">
                    {tr('settingsCostAdvisory')}:{' '}
                    {costSummary.policy.perTask.hardTokens === null &&
                      tr('settingsCostTaskLabel')}
                    {costSummary.policy.perTask.hardTokens === null &&
                      costSummary.policy.daily.hardTokens === null && ' · '}
                    {costSummary.policy.daily.hardTokens === null &&
                      tr('settingsCostDayLabel')}{' '}
                    {tr('settingsCostTokenTelemetry')}
                  </p>
                )}
              </>
            )}
            {costSummary.billingModeNote && (
              <p className="muted settings-hint" data-evidence="settings-cost-billing-note">
                {tr('settingsCostBillingModeFallback')}
              </p>
            )}
            <p className="muted settings-hint">
              {tr('settingsCostDay')}:{' '}
              <strong>${costSummary.day.costUsd.toFixed(2)}</strong>
              {' · '}
              {(
                costSummary.day.inputTokens + costSummary.day.outputTokens
              ).toLocaleString()}{' '}
              tokens
            </p>
            <p className="muted settings-hint">
              {tr('settingsCostLevel')}:{' '}
              <strong data-evidence="settings-cost-level">
                {costSummary.level === 'hard'
                  ? tr('settingsCostHard')
                  : costSummary.level === 'soft'
                    ? tr('settingsCostSoft')
                    : tr('settingsCostOk')}
              </strong>
            </p>
            {costSummary.reasons.length > 0 && (
              <ul className="settings-cost-reasons" data-evidence="settings-cost-reasons">
                {costSummary.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
            {costSummary.ledger && (
              <div data-evidence="settings-cost-ledger">
                <p className="muted settings-hint" data-evidence="settings-cost-ledger-status">
                  {tr('settingsCostLedgerTitle')}:{' '}
                  <strong>{tr(ledgerStatusKey(costSummary.ledger.status))}</strong>
                  {' · '}
                  {tr('settingsCostLedgerReceipts')} {costSummary.ledger.receiptCount}
                  {' · '}
                  {tr('settingsCostLedgerRetain')} {costSummary.ledger.retainedDays}{' '}
                  {tr('settingsCostLedgerDays')}
                </p>
                <p className="muted settings-hint" data-evidence="settings-cost-ledger-freshness">
                  {tr('settingsCostLedgerPersisted')}:{' '}
                  {fmtLedgerTime(costSummary.ledger.lastPersistedAtMs)}
                  {' · '}
                  {tr('settingsCostLedgerRecovered')}:{' '}
                  {fmtLedgerTime(costSummary.ledger.recoveredAtMs)}
                </p>
                {costSummary.ledger.note && (
                  <p className="muted settings-hint" data-evidence="settings-cost-ledger-note">
                    {costSummary.ledger.note}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      {updateAvailable !== false && (
        <section className="settings-section" data-evidence="settings-update">
          <div className="body-label">{tr('settingsUpdateTitle')}</div>
          <p className="muted settings-hint">{tr('settingsUpdateHint')}</p>
          {updateDisabled ? (
            <p className="muted settings-hint" data-evidence="settings-update-disabled">
              {tr('settingsUpdateDisabled')}
            </p>
          ) : (
            <ConfirmButton
              className="settings-update-btn"
              label={updating ? tr('settingsUpdateRunning') : tr('settingsUpdate')}
              confirmLabel={tr('settingsUpdateConfirm')}
              onConfirm={onUpdateConfirm}
              disabled={updating || update === null}
              loading={updating}
              data-evidence="settings-update-btn"
            />
          )}
          {update?.phase === 'ok' && (
            <p className="settings-update-status is-ok" data-evidence="settings-update-ok">
              {update.message ?? tr('settingsUpdateOk')}
            </p>
          )}
          {update?.phase === 'failed' && (
            <p className="settings-update-status is-fail" data-evidence="settings-update-fail">
              {tr('settingsUpdateFailed')}: {update.message}
            </p>
          )}
          {updating && update.message && (
            <p className="settings-update-status is-run" data-evidence="settings-update-step">
              {update.step ? `${update.step}: ` : ''}
              {update.message}
            </p>
          )}
          {updateError && (
            <p className="settings-update-status is-fail">{updateError}</p>
          )}
          {update && update.log.length > 0 && (
            <pre
              className="settings-update-log"
              data-evidence="settings-update-log"
              aria-label={tr('settingsUpdateLog')}
            >
              {update.log.slice(-20).join('\n')}
            </pre>
          )}
        </section>
      )}

      <section className="settings-section" data-evidence="settings-ceo">
        <div className="body-label">{tr('settingsCeoTitle')}</div>
        <p className="muted settings-hint">{tr('settingsCeoHint')}</p>
        <p className="settings-section">
          <a href="/ceo/" className="settings-update-btn" data-evidence="settings-ceo-open">
            {tr('settingsCeoOpen')} →
          </a>
        </p>
      </section>

      <section className="settings-section" data-evidence="settings-sheet-habits">
        <div className="body-label">{tr('settingsSheetHabitsTitle')}</div>
        <p className="muted settings-hint">{tr('settingsSheetHabitsHint')}</p>
        <ConfirmButton
          className="settings-update-btn"
          label={tr('settingsSheetHabitsReset')}
          confirmLabel={tr('settingsSheetHabitsResetConfirm')}
          onConfirm={() => {
            resetSheetHabits();
          }}
          data-evidence="sheet-habits-reset"
        />
      </section>

      <section className="settings-section settings-logout">
        <ConfirmButton
          className="settings-logout-btn danger"
          label={tr('settingsLogout')}
          confirmLabel={tr('settingsLogoutConfirm')}
          onConfirm={onLogout}
          data-evidence="settings-logout"
        />
      </section>
    </div>
  );
}
