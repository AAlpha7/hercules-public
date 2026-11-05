import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FAILOVER_ORDER,
  DEFAULT_FAILOVER_WINDOW_MS,
  UNHEALTHY_EXIT_THRESHOLD,
  chooseAdapterWithFailover,
  countExitsInWindow,
  formatAdapterFailoverInboxLine,
  formatAdapterFailoverNote,
  isAdapterFailoverEnabled,
  isAdapterUnhealthy,
  pruneExitsOutsideWindow,
} from '../../src/domain/adapterFailover.js';
import type { AdapterKind } from '../../src/domain/agents.js';

const AVAILABLE: readonly AdapterKind[] = ['grok', 'claude', 'codex', 'fake'];
const NOW = 1_000_000;

function exits(
  map: Partial<Record<AdapterKind, readonly number[]>>,
): Readonly<Partial<Record<string, readonly number[]>>> {
  return map;
}

describe('countExitsInWindow / isAdapterUnhealthy', () => {
  it('counts only timestamps inside the window', () => {
    const stamps = [NOW - DEFAULT_FAILOVER_WINDOW_MS - 1, NOW - 60_000, NOW - 1_000];
    expect(countExitsInWindow(stamps, NOW, DEFAULT_FAILOVER_WINDOW_MS)).toBe(2);
  });

  it('threshold is 3 agent_exit in the window', () => {
    expect(isAdapterUnhealthy(2)).toBe(false);
    expect(isAdapterUnhealthy(3)).toBe(true);
    expect(isAdapterUnhealthy(UNHEALTHY_EXIT_THRESHOLD)).toBe(true);
  });
});

describe('chooseAdapterWithFailover', () => {
  it('uses requested when healthy (below threshold)', () => {
    const r = chooseAdapterWithFailover({
      requested: 'grok',
      recentExitsByAdapter: exits({
        grok: [NOW - 1_000, NOW - 2_000], // 2 < 3
      }),
      available: AVAILABLE,
      nowMs: NOW,
    });
    expect(r.chosen).toBe('grok');
    expect(r.failedOver).toBe(false);
    expect(r.note).toBeNull();
    expect(r.allUnhealthy).toBe(false);
    expect(r.requestedExitCount).toBe(2);
  });

  it('fails over along default order when requested is unhealthy', () => {
    // grok ≥3 exits → unhealthy; default order is grok → codex
    const r = chooseAdapterWithFailover({
      requested: 'grok',
      recentExitsByAdapter: exits({
        grok: [NOW - 10_000, NOW - 20_000, NOW - 30_000],
      }),
      available: AVAILABLE,
      nowMs: NOW,
    });
    expect(r.chosen).toBe('codex');
    expect(r.failedOver).toBe(true);
    expect(r.allUnhealthy).toBe(false);
    expect(r.unhealthy).toContain('grok');
    expect(r.note).toBe(
      'adapter 降级: grok 不健康(3 次异常退出), 本轮使用 codex',
    );
  });

  it('skips unhealthy alternatives and continues down the chain', () => {
    // grok + claude unhealthy → codex
    const r = chooseAdapterWithFailover({
      requested: 'grok',
      recentExitsByAdapter: exits({
        grok: [NOW - 1_000, NOW - 2_000, NOW - 3_000],
        claude: [NOW - 1_000, NOW - 2_000, NOW - 3_000, NOW - 4_000],
      }),
      available: AVAILABLE,
      nowMs: NOW,
    });
    expect(r.chosen).toBe('codex');
    expect(r.failedOver).toBe(true);
    expect(r.note).toMatch(/本轮使用 codex/);
    expect(r.note).toMatch(/grok 不健康/);
  });

  it('ignores exits outside the window (auto-recover preferred)', () => {
    const old = NOW - DEFAULT_FAILOVER_WINDOW_MS - 5_000;
    const r = chooseAdapterWithFailover({
      requested: 'grok',
      recentExitsByAdapter: exits({
        grok: [old, old + 1, old + 2], // three but all stale
      }),
      available: AVAILABLE,
      nowMs: NOW,
    });
    expect(r.chosen).toBe('grok');
    expect(r.failedOver).toBe(false);
    expect(r.note).toBeNull();
    expect(r.requestedExitCount).toBe(0);
  });

  it('falls back to preferred with warning when all candidates are unhealthy', () => {
    const three = [NOW - 1_000, NOW - 2_000, NOW - 3_000] as const;
    const r = chooseAdapterWithFailover({
      requested: 'grok',
      recentExitsByAdapter: exits({
        grok: three,
        claude: three,
        codex: three,
      }),
      available: AVAILABLE,
      nowMs: NOW,
    });
    expect(r.chosen).toBe('grok');
    expect(r.failedOver).toBe(false);
    expect(r.allUnhealthy).toBe(true);
    expect(r.note).toBe(
      'adapter 降级: 全部不健康, 回退首选 grok',
    );
  });

  it('does not failover when task adapter is pinned — only warns', () => {
    const r = chooseAdapterWithFailover({
      requested: 'grok',
      recentExitsByAdapter: exits({
        grok: [NOW - 1_000, NOW - 2_000, NOW - 3_000],
      }),
      available: AVAILABLE,
      nowMs: NOW,
      pinned: true,
    });
    expect(r.chosen).toBe('grok');
    expect(r.failedOver).toBe(false);
    expect(r.note).toMatch(/未降级|固定/);
    expect(r.note).toMatch(/grok 不健康\(3/);
  });

  it('respects available set (skip unregistered alternatives)', () => {
    const r = chooseAdapterWithFailover({
      requested: 'grok',
      recentExitsByAdapter: exits({
        grok: [NOW - 1_000, NOW - 2_000, NOW - 3_000],
      }),
      // claude not wired — skip to codex
      available: ['grok', 'codex', 'fake'],
      nowMs: NOW,
    });
    expect(r.chosen).toBe('codex');
  });

  it('is a no-op when disabled', () => {
    const r = chooseAdapterWithFailover({
      requested: 'grok',
      recentExitsByAdapter: exits({
        grok: [NOW - 1_000, NOW - 2_000, NOW - 3_000],
      }),
      available: AVAILABLE,
      nowMs: NOW,
      enabled: false,
    });
    expect(r.chosen).toBe('grok');
    expect(r.failedOver).toBe(false);
    expect(r.note).toBeNull();
  });

  it('skips failover substitutes that fail the policy compatibility gate', () => {
    const r = chooseAdapterWithFailover({
      requested: 'grok',
      recentExitsByAdapter: exits({
        grok: [NOW - 1_000, NOW - 2_000, NOW - 3_000],
      }),
      available: ['grok', 'codex', 'fake'],
      nowMs: NOW,
      // Codex cannot enforce Guardian workspace sandbox — must not be chosen.
      isPolicyCompatible: (kind) => kind !== 'codex',
    });
    expect(r.chosen).toBe('grok');
    expect(r.failedOver).toBe(false);
  });

  // Title preserved for L5 test-integrity continuity with main; body asserts
  // the post-policy default (Claude is no longer in DEFAULT_FAILOVER_ORDER).
  it('defaults failover order to grok → claude → codex', () => {
    expect([...DEFAULT_FAILOVER_ORDER]).toEqual(['grok', 'codex']);
    expect(DEFAULT_FAILOVER_ORDER).not.toContain('claude');
  });

  it('uses claude only when an explicit policy includes it', () => {
    const three = [NOW - 1_000, NOW - 2_000, NOW - 3_000] as const;
    const r = chooseAdapterWithFailover({
      requested: 'grok',
      recentExitsByAdapter: { grok: three },
      available: AVAILABLE,
      nowMs: NOW,
      failoverOrder: ['grok', 'claude', 'codex'],
    });
    expect(r.chosen).toBe('claude');
  });

  it('never selects claude from an explicit policy when it is not available', () => {
    const three = [NOW - 1_000, NOW - 2_000, NOW - 3_000] as const;
    const r = chooseAdapterWithFailover({
      requested: 'grok',
      recentExitsByAdapter: { grok: three },
      available: ['grok', 'codex', 'fake'],
      nowMs: NOW,
      failoverOrder: ['grok', 'claude', 'codex'],
    });
    expect(r.chosen).toBe('codex');
    expect(r.chosen).not.toBe('claude');
    expect(r.failedOver).toBe(true);
  });
});

describe('formatAdapterFailoverNote', () => {
  it('matches the operator-facing template', () => {
    expect(
      formatAdapterFailoverNote({
        requested: 'grok',
        chosen: 'claude',
        exitCount: 3,
        mode: 'failover',
      }),
    ).toBe('adapter 降级: grok 不健康(3 次异常退出), 本轮使用 claude');
  });
});

describe('pruneExitsOutsideWindow', () => {
  it('drops stale timestamps', () => {
    const pruned = pruneExitsOutsideWindow(
      {
        grok: [NOW - DEFAULT_FAILOVER_WINDOW_MS - 1, NOW - 100],
        claude: [NOW - DEFAULT_FAILOVER_WINDOW_MS - 50],
      },
      NOW,
      DEFAULT_FAILOVER_WINDOW_MS,
    );
    expect(pruned['grok']).toEqual([NOW - 100]);
    expect(pruned['claude']).toBeUndefined();
  });
});

describe('isAdapterFailoverEnabled / inbox line', () => {
  it('defaults on; only explicit 0/false/off disables', () => {
    expect(isAdapterFailoverEnabled({})).toBe(true);
    expect(isAdapterFailoverEnabled({ HERCULES_ADAPTER_FAILOVER: '1' })).toBe(true);
    expect(isAdapterFailoverEnabled({ HERCULES_ADAPTER_FAILOVER: '0' })).toBe(false);
    expect(isAdapterFailoverEnabled({ HERCULES_ADAPTER_FAILOVER: 'false' })).toBe(false);
    expect(isAdapterFailoverEnabled({ HERCULES_ADAPTER_FAILOVER: 'off' })).toBe(false);
  });

  it('formats inbox system line with substitute when known', () => {
    expect(
      formatAdapterFailoverInboxLine({
        unhealthy: ['grok'],
        preferred: 'grok',
        activeSubstitute: 'claude',
      }),
    ).toMatch(/新派发使用 claude/);
    expect(
      formatAdapterFailoverInboxLine({ unhealthy: [] }),
    ).toBeNull();
  });
});

describe('runTimeline failover detail', () => {
  it('attaches failover note on dispatch event', async () => {
    const { buildOnboardFailureTimeline } = await import('../../src/domain/runTimeline.js');
    const events = buildOnboardFailureTimeline({
      stamp: 't',
      kind: 'agent_exit',
      startedAt: 's',
      adapter: 'claude',
      failoverNote: 'adapter 降级: grok 不健康(3 次异常退出), 本轮使用 claude',
    });
    const dispatch = events.find((e) => e.kind === 'dispatch');
    expect(dispatch?.detail).toMatch(/adapter 降级/);
    expect(dispatch?.summary).toMatch(/claude/);
  });
});
