/**
 * SettingsPanel cost profiles: real jsdom render for subscription/metered
 * summaries in en + zh (localized meaning/labels; not English costMeaning dump).
 */
import './setup.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CostCapSummaryDto, ProviderPolicyDto } from '../../../src/web/api.js';
import { t } from '../../../src/web/i18n.js';

const fetchSelfUpdateStatus = vi.fn();
const startSelfUpdate = vi.fn();
const recoverReviewerProvider = vi.fn();

vi.mock('../../../src/web/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/web/api.js')>();
  return {
    ...actual,
    fetchSelfUpdateStatus: (...args: unknown[]) => fetchSelfUpdateStatus(...args),
    startSelfUpdate: (...args: unknown[]) => startSelfUpdate(...args),
    recoverReviewerProvider: (...args: unknown[]) => recoverReviewerProvider(...args),
  };
});

import { ApiError } from '../../../src/web/api.js';
import { SettingsPanel } from '../../../src/web/SettingsPanel.js';

function makeCostSummary(
  overrides: Partial<CostCapSummaryDto> = {},
): CostCapSummaryDto {
  const billingMode = overrides.billingMode ?? 'subscription';
  const perTask =
    billingMode === 'subscription'
      ? { softUsd: 40, hardUsd: 50, softTokens: null, hardTokens: null }
      : { softUsd: 20, hardUsd: 25, softTokens: null, hardTokens: null };
  const daily =
    billingMode === 'subscription'
      ? { softUsd: 80, hardUsd: 100, softTokens: null, hardTokens: null }
      : { softUsd: 40, hardUsd: 50, softTokens: null, hardTokens: null };
  return {
    enabled: true,
    level: 'ok',
    day: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    reasons: [],
    billingMode,
    billingModeNote: null,
    // English backend field must not be required for zh UI.
    costMeaning:
      'USD figures are an internal estimate under a flat subscription — not an invoice or charged spend.',
    ...overrides,
    policy: {
      perTask: { ...perTask, ...overrides.policy?.perTask },
      daily: { ...daily, ...overrides.policy?.daily },
    },
  };
}

function renderPanel(
  lang: 'en' | 'zh',
  costSummary: CostCapSummaryDto | null | undefined,
  providerPolicy?: ProviderPolicyDto,
  reviewerHealth?: import('../../../src/web/api.js').ReviewerProviderHealthDto[],
): void {
  render(
    <SettingsPanel
      lang={lang}
      preferredAgent=""
      daemonDefault="grok"
      availableAgents={['grok']}
      costSummary={costSummary}
      providerPolicy={providerPolicy}
      reviewerHealth={reviewerHealth}
      onLangChange={() => {}}
      onPreferredAgentChange={() => {}}
      onLogout={() => {}}
      onClose={() => {}}
    />,
  );
}

function evidence(sel: string): HTMLElement {
  const el = document.querySelector(`[data-evidence="${sel}"]`);
  if (!(el instanceof HTMLElement)) {
    throw new Error(`missing data-evidence=${sel}`);
  }
  return el;
}

describe('SettingsPanel cost profiles render', () => {
  beforeEach(() => {
    fetchSelfUpdateStatus.mockReset();
    startSelfUpdate.mockReset();
    recoverReviewerProvider.mockReset();
    fetchSelfUpdateStatus.mockRejectedValue(new ApiError(404, 'missing'));
  });

  it('renders subscription mode, thresholds, and internal-estimate meaning (en)', () => {
    renderPanel('en', makeCostSummary({ billingMode: 'subscription' }));

    expect(evidence('settings-cost-billing-mode').textContent).toMatch(/subscription/i);
    expect(evidence('settings-cost-meaning').textContent).toMatch(/internal estimate/i);
    expect(evidence('settings-cost-meaning').textContent).toMatch(/not an invoice/i);
    expect(evidence('settings-cost-thresholds').textContent).toMatch(
      /task\s*\$40\.00\/50\.00/,
    );
    expect(evidence('settings-cost-thresholds').textContent).toMatch(
      /day\s*\$80\.00\/100\.00/,
    );
    expect(evidence('settings-cost-meaning').textContent).toBe(
      t('en', 'settingsCostMeaningSubscription'),
    );
    expect(evidence('settings-cost-enforced').textContent).toMatch(
      /task USD hard \$50\.00.*day USD hard \$100\.00/i,
    );
    expect(evidence('settings-cost-advisory').textContent).toMatch(
      /task.*day.*token telemetry.*not a dispatch stop/i,
    );
  });

  it('shows an explicit token hard override and its exact blocking reason', () => {
    renderPanel(
      'en',
      makeCostSummary({
        level: 'hard',
        reasons: ['per-task hard stop: explicit token override 2.70M ≥ 2.50M'],
        policy: {
          perTask: { softUsd: 40, hardUsd: 50, softTokens: null, hardTokens: 2_500_000 },
          daily: { softUsd: 80, hardUsd: 100, softTokens: null, hardTokens: null },
        },
      }),
    );

    expect(evidence('settings-cost-enforced').textContent).toMatch(
      /task token hard override 2,500,000/i,
    );
    expect(evidence('settings-cost-advisory').textContent).toMatch(/day token telemetry/i);
    expect(evidence('settings-cost-reasons').textContent).toContain(
      'per-task hard stop: explicit token override 2.70M ≥ 2.50M',
    );
  });

  it('renders effective Codex policy and disabled Claude status', () => {
    renderPanel('en', null, {
      codex: { model: 'gpt-5.6-sol', reasoningEffort: 'medium' },
      claudeEnabled: false,
    });
    expect(evidence('settings-codex-policy').textContent).toMatch(/gpt-5\.6-sol.*medium/);
    expect(evidence('settings-claude-policy').textContent).toMatch(/disabled/i);
  });

  it('renders a bounded receipt and sends the provider health-check recovery request', async () => {
    recoverReviewerProvider.mockReturnValue(new Promise(() => {}));
    renderPanel('en', null, undefined, [{
      provider: 'grok', state: 'blocked', failureKind: 'authentication',
      observedAt: '2026-08-03T16:00:00.000Z', blockedCandidates: 1,
      detail: 'Not signed in',
      nextAction: 'Run reviewer health check or explicitly recover grok',
    }]);
    expect(evidence('reviewer-infra-receipt').textContent).toMatch(/grok.*blocked.*authentication/i);
    expect(evidence('reviewer-health-check')).toBeTruthy();
    expect(evidence('reviewer-explicit-recovery')).toBeTruthy();
    expect(document.body.textContent).not.toContain('/work/');
    await userEvent.click(evidence('reviewer-health-check'));
    expect(recoverReviewerProvider).toHaveBeenCalledWith('grok', 'health_check');
  });

  it('requires confirmation before sending explicit reviewer recovery', async () => {
    recoverReviewerProvider.mockReturnValue(new Promise(() => {}));
    renderPanel('en', null, undefined, [{
      provider: 'grok', state: 'blocked', failureKind: 'transient',
      observedAt: '2026-08-03T16:00:00.000Z', blockedCandidates: 1,
      detail: 'upstream 502', nextAction: 'Run health check or explicitly recover grok',
    }]);
    const button = evidence('reviewer-explicit-recovery');
    await userEvent.click(button);
    expect(recoverReviewerProvider).not.toHaveBeenCalled();
    await userEvent.click(button);
    expect(recoverReviewerProvider).toHaveBeenCalledWith('grok', 'operator');
  });

  it('older daemon without providerPolicy still renders settings without policy chrome', () => {
    renderPanel('en', makeCostSummary());
    expect(document.querySelector('[data-evidence="settings-panel"]')).toBeTruthy();
    expect(document.querySelector('[data-evidence="settings-provider-policy"]')).toBeNull();
    expect(document.querySelector('[data-evidence="settings-codex-policy"]')).toBeNull();
    expect(document.querySelector('[data-evidence="settings-claude-policy"]')).toBeNull();
  });

  it('renders metered mode and half thresholds (en)', () => {
    renderPanel(
      'en',
      makeCostSummary({
        billingMode: 'metered',
        costMeaning: 'USD figures estimate metered adapter spend against configured caps.',
      }),
    );

    expect(evidence('settings-cost-billing-mode').textContent).toMatch(/metered/i);
    expect(evidence('settings-cost-thresholds').textContent).toMatch(
      /task\s*\$20\.00\/25\.00/,
    );
    expect(evidence('settings-cost-thresholds').textContent).toMatch(
      /day\s*\$40\.00\/50\.00/,
    );
    expect(evidence('settings-cost-meaning').textContent).toBe(
      t('en', 'settingsCostMeaningMetered'),
    );
  });

  it('zh localizes meaning and task/day labels (not English costMeaning verbatim)', () => {
    const englishMeaning =
      'USD figures are an internal estimate under a flat subscription — not an invoice or charged spend.';
    renderPanel(
      'zh',
      makeCostSummary({
        billingMode: 'subscription',
        costMeaning: englishMeaning,
      }),
    );

    expect(evidence('settings-cost-billing-mode').textContent).toMatch(/订阅/);
    expect(evidence('settings-cost-meaning').textContent).toBe(
      t('zh', 'settingsCostMeaningSubscription'),
    );
    expect(evidence('settings-cost-meaning').textContent).not.toBe(englishMeaning);
    expect(evidence('settings-cost-meaning').textContent).toMatch(/内部估算/);
    expect(evidence('settings-cost-meaning').textContent).toMatch(/不是账单/);
    expect(evidence('settings-cost-thresholds').textContent).toMatch(
      /任务\s*\$40\.00\/50\.00/,
    );
    expect(evidence('settings-cost-thresholds').textContent).toMatch(
      /日\s*\$80\.00\/100\.00/,
    );
    expect(evidence('settings-cost-thresholds').textContent).not.toMatch(/\btask\b/);
    expect(evidence('settings-cost-thresholds').textContent).not.toMatch(/\bday\b/);
  });

  it('zh metered localizes mode, half thresholds, and meaning (no English labels)', () => {
    const englishMeaning =
      'USD figures estimate metered adapter spend against configured caps.';
    renderPanel(
      'zh',
      makeCostSummary({
        billingMode: 'metered',
        costMeaning: englishMeaning,
      }),
    );

    expect(evidence('settings-cost-billing-mode').textContent).toMatch(/按量/);
    expect(evidence('settings-cost-thresholds').textContent).toMatch(
      /任务\s*\$20\.00\/25\.00/,
    );
    expect(evidence('settings-cost-thresholds').textContent).toMatch(
      /日\s*\$40\.00\/50\.00/,
    );
    expect(evidence('settings-cost-meaning').textContent).toBe(
      t('zh', 'settingsCostMeaningMetered'),
    );
    expect(evidence('settings-cost-meaning').textContent).not.toBe(englishMeaning);
    expect(evidence('settings-cost-meaning').textContent).toMatch(/按量/);
    expect(evidence('settings-cost-meaning').textContent).not.toMatch(/metered/i);
    expect(evidence('settings-cost-thresholds').textContent).not.toMatch(/\btask\b/);
    expect(evidence('settings-cost-thresholds').textContent).not.toMatch(/\bday\b/);
  });

  it('shows localized fallback diagnostic when billingModeNote is set', () => {
    renderPanel(
      'zh',
      makeCostSummary({
        billingMode: 'metered',
        billingModeNote:
          'HERCULES_BILLING_MODE unset; using metered (conservative). Set HERCULES_BILLING_MODE=subscription or metered.',
      }),
    );

    expect(evidence('settings-cost-billing-note').textContent).toBe(
      t('zh', 'settingsCostBillingModeFallback'),
    );
    expect(evidence('settings-cost-billing-note').textContent).not.toMatch(
      /HERCULES_BILLING_MODE unset/,
    );
    expect(evidence('settings-cost-billing-note').textContent).toMatch(/计费模式/);
  });

  it('older daemon without billingMode still renders enabled caps', () => {
    renderPanel('en', {
      enabled: true,
      level: 'ok',
      day: { inputTokens: 10, outputTokens: 5, costUsd: 0.12 },
      reasons: [],
    });

    expect(document.querySelector('[data-evidence="settings-cost-on"]')).toBeTruthy();
    expect(document.querySelector('[data-evidence="settings-cost-billing-mode"]')).toBeNull();
    expect(document.querySelector('[data-evidence="settings-cost-meaning"]')).toBeNull();
    expect(document.querySelector('[data-evidence="settings-cost-thresholds"]')).toBeNull();
    expect(document.querySelector('[data-evidence="settings-cost-billing-note"]')).toBeNull();
    expect(evidence('settings-cost-level').textContent).toMatch(/ok/i);
  });
});
