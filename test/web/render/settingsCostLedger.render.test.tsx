import './setup.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { CostCapSummaryDto } from '../../../src/web/api.js';

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

function summary(overrides: Partial<CostCapSummaryDto> = {}): CostCapSummaryDto {
  return {
    enabled: true,
    level: 'ok',
    day: { inputTokens: 10, outputTokens: 5, costUsd: 1.25 },
    reasons: [],
    billingMode: 'subscription',
    billingModeNote: null,
    costMeaning: 'internal estimate, not an invoice',
    policy: {
      perTask: { softUsd: 40, hardUsd: 50, softTokens: null, hardTokens: null },
      daily: { softUsd: 80, hardUsd: 100, softTokens: null, hardTokens: null },
    },
    ledger: {
      status: 'ok',
      receiptCount: 3,
      retainedDays: 14,
      lastPersistedAtMs: Date.UTC(2026, 7, 4, 11, 59),
      recoveredAtMs: Date.UTC(2026, 7, 4, 12),
      note: null,
      failClosed: false,
    },
    ...overrides,
  };
}

function renderPanel(costSummary: CostCapSummaryDto): void {
  render(
    <SettingsPanel
      lang="en"
      preferredAgent=""
      daemonDefault="grok"
      availableAgents={['grok']}
      costSummary={costSummary}
      onLangChange={() => {}}
      onPreferredAgentChange={() => {}}
      onLogout={() => {}}
      onClose={() => {}}
    />,
  );
}

function evidence(name: string): HTMLElement {
  const element = document.querySelector(`[data-evidence="${name}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`missing data-evidence=${name}`);
  return element;
}

describe('SettingsPanel durable ledger diagnostics', () => {
  beforeEach(() => {
    fetchSelfUpdateStatus.mockReset();
    startSelfUpdate.mockReset();
    recoverReviewerProvider.mockReset();
    fetchSelfUpdateStatus.mockRejectedValue(new ApiError(404, 'missing'));
  });

  it('shows bounded receipt, retention, and freshness diagnostics', () => {
    renderPanel(summary());
    expect(evidence('settings-cost-ledger-status').textContent).toMatch(
      /durable.*recovered.*receipts 3.*retention 14 days/i,
    );
    expect(evidence('settings-cost-ledger-freshness').textContent).toMatch(
      /persisted.*2026-08-04T11:59:00\.000Z.*recovered.*2026-08-04T12:00:00\.000Z/i,
    );
    expect(evidence('settings-cost-meaning').textContent).toMatch(/internal estimate/i);
    expect(evidence('settings-cost-thresholds').textContent).toMatch(/40\.00\/50\.00.*80\.00\/100\.00/);
  });

  it('shows fail-closed corruption without sensitive fields', () => {
    renderPanel(
      summary({
        level: 'hard',
        reasons: ['Cost ledger JSON is corrupt; caps fail closed.'],
        ledger: {
          status: 'corrupt',
          receiptCount: 0,
          retainedDays: 14,
          lastPersistedAtMs: null,
          recoveredAtMs: Date.UTC(2026, 7, 4, 12),
          note: 'Cost ledger JSON is corrupt; caps fail closed.',
          failClosed: true,
        },
      }),
    );
    expect(evidence('settings-cost-ledger-status').textContent).toMatch(/corrupt.*fail closed/i);
    expect(evidence('settings-cost-ledger-note').textContent).toMatch(/fail closed/i);
    expect(evidence('settings-cost-ledger').textContent).not.toMatch(
      /prompt|credential|password|api[_-]?key|provider.*payload|session.?id/i,
    );
  });
});
