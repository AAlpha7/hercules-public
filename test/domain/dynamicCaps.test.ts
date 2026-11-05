import { describe, it, expect } from 'vitest';
import {
  CONSERVATIVE_DYNAMIC_CAPS_TIERS,
  DEFAULT_DYNAMIC_CAPS,
  resolveEffectiveCaps,
  type CapPair,
  type DynamicCapsPolicy,
} from '../../src/domain/dynamicCaps.js';

const GiB = 1024 ** 3;
const base: CapPair = { globalCap: 2, heavyValidationPermits: 1 };

const enabled: DynamicCapsPolicy = {
  enabled: true,
  tiers: CONSERVATIVE_DYNAMIC_CAPS_TIERS,
};

describe('resolveEffectiveCaps', () => {
  it('returns base caps when policy is disabled (safe default)', () => {
    expect(resolveEffectiveCaps(base, 100, DEFAULT_DYNAMIC_CAPS)).toEqual(base);
    expect(DEFAULT_DYNAMIC_CAPS.enabled).toBe(false);
  });

  it('returns base caps when MemAvailable is unknown (null)', () => {
    expect(resolveEffectiveCaps(base, null, enabled)).toEqual(base);
  });

  it('returns base caps when free memory is above all tiers', () => {
    expect(resolveEffectiveCaps(base, 8 * GiB, enabled)).toEqual(base);
  });

  it('lowers globalCap under low memory pressure (≤3 GiB free)', () => {
    const caps = resolveEffectiveCaps(base, 2.5 * GiB, enabled);
    expect(caps.globalCap).toBe(1);
    expect(caps.heavyValidationPermits).toBe(1);
  });

  it('lowers global and heavy under critical pressure (≤1 GiB free)', () => {
    const caps = resolveEffectiveCaps(base, 512 * 1024 ** 2, enabled);
    expect(caps.globalCap).toBe(1);
    expect(caps.heavyValidationPermits).toBe(0);
  });

  it('never raises caps above the configured base', () => {
    const lowBase: CapPair = { globalCap: 1, heavyValidationPermits: 0 };
    // Even with plenty of free mem, stay at base when disabled path… when enabled
    // and mem is high, still base. When mem is low, tier wants global 1 — still 1.
    expect(resolveEffectiveCaps(lowBase, 8 * GiB, enabled)).toEqual(lowBase);
    expect(resolveEffectiveCaps(lowBase, 100, enabled)).toEqual({
      globalCap: 1,
      heavyValidationPermits: 0,
    });
  });

  it('picks the most severe matching tier when several apply', () => {
    const policy: DynamicCapsPolicy = {
      enabled: true,
      tiers: [
        { maxMemAvailableBytes: 4 * GiB, globalCap: 2, heavyValidationPermits: 1 },
        { maxMemAvailableBytes: 1 * GiB, globalCap: 1, heavyValidationPermits: 0 },
        { maxMemAvailableBytes: 2 * GiB, globalCap: 1, heavyValidationPermits: 1 },
      ],
    };
    // 0.5 GiB matches all three → most severe is ≤1 GiB tier
    expect(resolveEffectiveCaps(base, 0.5 * GiB, policy)).toEqual({
      globalCap: 1,
      heavyValidationPermits: 0,
    });
  });

  it('clamps negative or zero tier values to non-negative integers', () => {
    const policy: DynamicCapsPolicy = {
      enabled: true,
      tiers: [{ maxMemAvailableBytes: 1 * GiB, globalCap: -3, heavyValidationPermits: -1 }],
    };
    expect(resolveEffectiveCaps(base, 100, policy)).toEqual({
      globalCap: 0,
      heavyValidationPermits: 0,
    });
  });
});
