import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CONFIG,
  makeConfig,
  stallOverridesFromEnv,
  stagingDebounceFromEnv,
  cargoCachePruneFromEnv,
  dispatchEnabledFromEnv,
  hostCommandTimeoutFromEnv,
  DEFAULT_STAGING_DEPLOY_DEBOUNCE_MS,
} from '../src/config.js';
import { DEFAULT_DYNAMIC_CAPS } from '../src/domain/dynamicCaps.js';
import { DEFAULT_COST_CAPS } from '../src/domain/costCaps.js';
import { DEFAULT_MAX_RUN_MS, DEFAULT_STALL_TIMEOUT_MS } from '../src/domain/stall.js';
import { DEFAULT_HOST_COMMAND_TIMEOUT_MS } from '../src/domain/hostExecutor.js';

describe('config defaults (SPEC §6, §7, §11)', () => {
  it('uses the conservative target-box caps', () => {
    expect(DEFAULT_CONFIG.globalCap).toBe(2);
    expect(DEFAULT_CONFIG.heavyValidationPermits).toBe(1);
  });

  it('keeps production dispatch enabled by default', () => {
    expect(DEFAULT_CONFIG.dispatchEnabled).toBe(true);
    expect(makeConfig('/ctrl').dispatchEnabled).toBe(true);
  });

  it('dynamic caps are off by default (safe)', () => {
    expect(DEFAULT_CONFIG.dynamicCaps.enabled).toBe(false);
    expect(DEFAULT_CONFIG.dynamicCaps).toEqual(DEFAULT_DYNAMIC_CAPS);
    expect(makeConfig('/ctrl').dynamicCaps.enabled).toBe(false);
  });

  it('cost caps are off by default (safe — normal single tasks never blocked)', () => {
    expect(DEFAULT_CONFIG.costCaps.enabled).toBe(false);
    expect(DEFAULT_CONFIG.costCaps).toEqual(DEFAULT_COST_CAPS);
    expect(DEFAULT_CONFIG.costCaps.billingMode).toBe('metered');
    expect(makeConfig('/ctrl').costCaps.enabled).toBe(false);
  });

  it('makeConfig sets the control dir and applies defaults', () => {
    const cfg = makeConfig('/ctrl');
    expect(cfg.controlRepoDir).toBe('/ctrl');
    expect(cfg.globalCap).toBe(2);
    expect(cfg.maxAttempts).toBe(3);
  });

  it('makeConfig honors overrides', () => {
    const cfg = makeConfig('/ctrl', { globalCap: 4, stallTimeoutMs: 1000 });
    expect(cfg.globalCap).toBe(4);
    expect(cfg.stallTimeoutMs).toBe(1000);
    expect(cfg.maxAttempts).toBe(3); // untouched
  });

  it('makeConfig can enable dynamic caps', () => {
    const cfg = makeConfig('/ctrl', {
      dynamicCaps: { ...DEFAULT_DYNAMIC_CAPS, enabled: true },
    });
    expect(cfg.dynamicCaps.enabled).toBe(true);
    expect(cfg.dynamicCaps.tiers.length).toBeGreaterThan(0);
  });

  it('defaults gracePeriodMs to 30s', () => {
    expect(makeConfig('/ctrl').gracePeriodMs).toBe(30_000);
  });

  it('allows overriding gracePeriodMs', () => {
    expect(makeConfig('/ctrl', { gracePeriodMs: 5_000 }).gracePeriodMs).toBe(5_000);
  });

  it('defaults maxRunMs to 2h (long tool runs; processAlive skips idle stall)', () => {
    expect(makeConfig('/ctrl').maxRunMs).toBe(DEFAULT_MAX_RUN_MS);
    expect(makeConfig('/ctrl').stallTimeoutMs).toBe(DEFAULT_STALL_TIMEOUT_MS);
  });

  it('defaults stagingDeployDebounceMs to 5 min (release reconciler quiet period)', () => {
    expect(makeConfig('/ctrl').stagingDeployDebounceMs).toBe(DEFAULT_STAGING_DEPLOY_DEBOUNCE_MS);
    expect(DEFAULT_STAGING_DEPLOY_DEBOUNCE_MS).toBe(5 * 60 * 1000);
  });
});

describe('hostCommandTimeoutFromEnv (outer-layer env parse)', () => {
  it('defaults and clamps via pure resolveHostCommandTimeoutMs', () => {
    expect(hostCommandTimeoutFromEnv({})).toBe(DEFAULT_HOST_COMMAND_TIMEOUT_MS);
    expect(
      hostCommandTimeoutFromEnv({ HERCULES_HOST_COMMAND_TIMEOUT_MS: String(45 * 60_000) }),
    ).toBe(45 * 60_000);
    expect(
      hostCommandTimeoutFromEnv({ HERCULES_HOST_COMMAND_TIMEOUT_MS: 'not-a-number' }),
    ).toBe(DEFAULT_HOST_COMMAND_TIMEOUT_MS);
  });
});

describe('dispatchEnabledFromEnv', () => {
  it('defaults enabled and accepts the staging kill-switch forms', () => {
    expect(dispatchEnabledFromEnv({})).toEqual({ dispatchEnabled: true });
    for (const value of ['0', 'false', 'OFF', 'no']) {
      expect(dispatchEnabledFromEnv({ HERCULES_DISPATCH_ENABLED: value })).toEqual({
        dispatchEnabled: false,
      });
    }
  });
});

describe('stagingDebounceFromEnv', () => {
  it('defaults when env unset', () => {
    expect(stagingDebounceFromEnv({})).toEqual({
      stagingDeployDebounceMs: DEFAULT_STAGING_DEPLOY_DEBOUNCE_MS,
    });
  });

  it('honors positive HERCULES_STAGING_DEBOUNCE_MS', () => {
    expect(stagingDebounceFromEnv({ HERCULES_STAGING_DEBOUNCE_MS: '60000' })).toEqual({
      stagingDeployDebounceMs: 60_000,
    });
  });
});

describe('stallOverridesFromEnv', () => {
  it('defaults when env unset', () => {
    expect(stallOverridesFromEnv({})).toEqual({
      stallTimeoutMs: DEFAULT_STALL_TIMEOUT_MS,
      maxRunMs: DEFAULT_MAX_RUN_MS,
    });
  });

  it('honors positive HERCULES_STALL_TIMEOUT_MS / HERCULES_MAX_RUN_MS', () => {
    expect(
      stallOverridesFromEnv({
        HERCULES_STALL_TIMEOUT_MS: '120000',
        HERCULES_MAX_RUN_MS: '3600000',
      }),
    ).toEqual({ stallTimeoutMs: 120_000, maxRunMs: 3_600_000 });
  });

  it('rejects zero/negative so hard max is never disabled', () => {
    expect(
      stallOverridesFromEnv({
        HERCULES_STALL_TIMEOUT_MS: '0',
        HERCULES_MAX_RUN_MS: '-1',
      }),
    ).toEqual({
      stallTimeoutMs: DEFAULT_STALL_TIMEOUT_MS,
      maxRunMs: DEFAULT_MAX_RUN_MS,
    });
  });
});

describe('stagingVerifyTimeoutFromEnv', () => {
  it('defaults to 15 minutes', async () => {
    const { stagingVerifyTimeoutFromEnv, DEFAULT_STAGING_VERIFY_TIMEOUT_MS } =
      await import('../src/config.js');
    expect(stagingVerifyTimeoutFromEnv({})).toEqual({
      stagingVerifyTimeoutMs: DEFAULT_STAGING_VERIFY_TIMEOUT_MS,
    });
    expect(DEFAULT_STAGING_VERIFY_TIMEOUT_MS).toBe(15 * 60 * 1000);
  });

  it('honors HERCULES_STAGING_VERIFY_TIMEOUT_MS', async () => {
    const { stagingVerifyTimeoutFromEnv } = await import('../src/config.js');
    expect(
      stagingVerifyTimeoutFromEnv({ HERCULES_STAGING_VERIFY_TIMEOUT_MS: '900000' }),
    ).toEqual({ stagingVerifyTimeoutMs: 900_000 });
  });

  it('rejects invalid values', async () => {
    const { stagingVerifyTimeoutFromEnv, DEFAULT_STAGING_VERIFY_TIMEOUT_MS } =
      await import('../src/config.js');
    expect(
      stagingVerifyTimeoutFromEnv({ HERCULES_STAGING_VERIFY_TIMEOUT_MS: '0' }),
    ).toEqual({ stagingVerifyTimeoutMs: DEFAULT_STAGING_VERIFY_TIMEOUT_MS });
  });
});

describe('cargoCachePruneFromEnv', () => {
  it('defaults to no env targets and 2-day retain', () => {
    expect(cargoCachePruneFromEnv({})).toEqual({
      cargoTargetEnv: null,
      cargoCacheRetainDays: 2,
    });
  });

  it('reads HERCULES_CARGO_TARGET_DIR and retain days', () => {
    expect(
      cargoCachePruneFromEnv({
        HERCULES_CARGO_TARGET_DIR: '/home/u/proj/.shared-target',
        HERCULES_CARGO_CACHE_RETAIN_DAYS: '3',
      }),
    ).toEqual({
      cargoTargetEnv: '/home/u/proj/.shared-target',
      cargoCacheRetainDays: 3,
    });
  });

  it('rejects non-positive retain days', () => {
    expect(
      cargoCachePruneFromEnv({ HERCULES_CARGO_CACHE_RETAIN_DAYS: '0' }).cargoCacheRetainDays,
    ).toBe(2);
  });
});
