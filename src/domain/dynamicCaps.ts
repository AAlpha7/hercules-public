/**
 * Domain layer — map free memory pressure to concurrency cap overrides.
 *
 * Pure. Given base global/heavy caps and MemAvailable (bytes), optionally lower
 * both so onboard cargo + browser does not OOM a constrained box (SPEC §11).
 * Policy is off by default; callers inject a mem reader at the orchestrator.
 */

/** Configured (or effective) concurrency pair. */
export interface CapPair {
  readonly globalCap: number;
  readonly heavyValidationPermits: number;
}

/**
 * A pressure band: when MemAvailable is at or below `maxMemAvailableBytes`,
 * apply these caps (clamped so they never exceed the daemon base).
 */
export interface DynamicCapsTier {
  readonly maxMemAvailableBytes: number;
  readonly globalCap: number;
  readonly heavyValidationPermits: number;
}

export interface DynamicCapsPolicy {
  /** When false, always return base caps (safe default). */
  readonly enabled: boolean;
  /** Tiers may be unordered; the most severe matching tier wins. */
  readonly tiers: readonly DynamicCapsTier[];
}

/**
 * Conservative tiers for a ~12 GB arm64 box (Oracle A1 free tier).
 * - ≤3 GiB free → single agent (global 1), heavy still allowed
 * - ≤1 GiB free → single agent, pause new heavy (browser) work
 */
export const CONSERVATIVE_DYNAMIC_CAPS_TIERS: readonly DynamicCapsTier[] = [
  { maxMemAvailableBytes: 1 * 1024 ** 3, globalCap: 1, heavyValidationPermits: 0 },
  { maxMemAvailableBytes: 3 * 1024 ** 3, globalCap: 1, heavyValidationPermits: 1 },
];

/** Off by default — opt in via HERCULES_DYNAMIC_CAPS=1 (or config override). */
export const DEFAULT_DYNAMIC_CAPS: DynamicCapsPolicy = {
  enabled: false,
  tiers: CONSERVATIVE_DYNAMIC_CAPS_TIERS,
};

function clampNonNegInt(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

/**
 * Resolve effective caps from free memory. Never raises above `base`.
 * `memAvailableBytes === null` means unknown (non-Linux / read failure) → base.
 */
export function resolveEffectiveCaps(
  base: CapPair,
  memAvailableBytes: number | null,
  policy: DynamicCapsPolicy,
): CapPair {
  if (!policy.enabled || memAvailableBytes === null || !Number.isFinite(memAvailableBytes)) {
    return base;
  }

  let matched: DynamicCapsTier | undefined;
  for (const tier of policy.tiers) {
    if (memAvailableBytes > tier.maxMemAvailableBytes) continue;
    if (!matched || tier.maxMemAvailableBytes < matched.maxMemAvailableBytes) {
      matched = tier;
    }
  }
  if (!matched) return base;

  return {
    globalCap: Math.min(clampNonNegInt(base.globalCap), clampNonNegInt(matched.globalCap)),
    heavyValidationPermits: Math.min(
      clampNonNegInt(base.heavyValidationPermits),
      clampNonNegInt(matched.heavyValidationPermits),
    ),
  };
}
