/**
 * Daemon configuration (SPEC §6, §7, §11, §18).
 *
 * Defaults are tuned for the constrained Oracle A1 target box (2 OCPU / 12 GB).
 * Every knob the SPEC leaves to the implementer lives here.
 */
import {
  DEFAULT_DYNAMIC_CAPS,
  type DynamicCapsPolicy,
} from './domain/dynamicCaps.js';
import {
  DEFAULT_COST_CAPS,
  type CostCapsPolicy,
} from './domain/costCaps.js';
import {
  DEFAULT_MAX_RUN_MS,
  DEFAULT_STALL_TIMEOUT_MS,
  parsePositiveMsEnv,
} from './domain/stall.js';
import { DEFAULT_STAGING_DEPLOY_DEBOUNCE_MS } from './domain/release.js';
import { DEFAULT_STAGING_VERIFY_TIMEOUT_MS } from './domain/stagingVerify.js';
import { resolveHostCommandTimeoutMs } from './domain/hostExecutor.js';

export type { DynamicCapsPolicy, CostCapsPolicy };
export {
  DEFAULT_MAX_RUN_MS,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_STAGING_DEPLOY_DEBOUNCE_MS,
  DEFAULT_STAGING_VERIFY_TIMEOUT_MS,
};

export interface OrchestratorConfig {
  /** Path to the control repo working tree. */
  readonly controlRepoDir: string;
  /**
   * Whether this daemon may mutate orchestration state or start work.
   * Staging/observer instances must set `HERCULES_DISPATCH_ENABLED=0`.
   */
  readonly dispatchEnabled: boolean;
  /** Max agents running across the whole daemon (SPEC §6.1). */
  readonly globalCap: number;
  /** Heavy-validation semaphore capacity — one browser at a time (SPEC §6.3). */
  readonly heavyValidationPermits: number;
  /**
   * Optional MemAvailable → cap overrides (off by default). When enabled and a
   * mem reader is wired, free memory pressure can lower global/heavy caps.
   */
  readonly dynamicCaps: DynamicCapsPolicy;
  /**
   * Optional per-task + rolling daily token/cost caps (off by default).
   * Soft warn + hard stop when adapter usage exceeds thresholds.
   */
  readonly costCaps: CostCapsPolicy;
  /** Tick period in ms (SPEC §7). */
  readonly tickIntervalMs: number;
  /**
   * No agent stream event for longer than this ⇒ idle-stall **only when**
   * process is not known-alive (SPEC §7.3). Override: `HERCULES_STALL_TIMEOUT_MS`.
   */
  readonly stallTimeoutMs: number;
  /**
   * Hard wall-clock cap for one agent run (ms). Applies even when
   * `processAlive` skips idle-stall during long tool execution.
   * Override: `HERCULES_MAX_RUN_MS`.
   */
  readonly maxRunMs: number;
  /** Attempts before a task is parked in `failed` (SPEC §7.6). */
  readonly maxAttempts: number;
  /** Base for exponential retry backoff in ms (SPEC §7.6). */
  readonly backoffBaseMs: number;
  /** SIGTERM→SIGKILL backstop for a cancelled agent that won't exit (SPEC §9.2 teardown). */
  readonly gracePeriodMs: number;
  /**
   * Quiet period after mirror main advances before auto staging deploy
   * (design §3). Default 5 min. Override: `HERCULES_STAGING_DEBOUNCE_MS`.
   */
  readonly stagingDeployDebounceMs: number;
  /**
   * Hard wall-clock budget for one staging deploy+health+evidence cycle.
   * Default 15 min. Override: `HERCULES_STAGING_VERIFY_TIMEOUT_MS`.
   */
  readonly stagingVerifyTimeoutMs: number;
}

/** SPEC-mandated defaults for everything except the control repo location. */
export const DEFAULT_CONFIG: Omit<OrchestratorConfig, 'controlRepoDir'> = {
  dispatchEnabled: true,
  globalCap: 2,
  heavyValidationPermits: 1,
  dynamicCaps: DEFAULT_DYNAMIC_CAPS,
  costCaps: DEFAULT_COST_CAPS,
  tickIntervalMs: 3_000,
  stallTimeoutMs: DEFAULT_STALL_TIMEOUT_MS,
  // Long cargo/pnpm gates on A1 can exceed 10m with zero stream events.
  maxRunMs: DEFAULT_MAX_RUN_MS,
  maxAttempts: 3,
  backoffBaseMs: 30_000,
  gracePeriodMs: 30_000,
  stagingDeployDebounceMs: DEFAULT_STAGING_DEPLOY_DEBOUNCE_MS,
  stagingVerifyTimeoutMs: DEFAULT_STAGING_VERIFY_TIMEOUT_MS,
};

export function makeConfig(
  controlRepoDir: string,
  overrides: Partial<Omit<OrchestratorConfig, 'controlRepoDir'>> = {},
): OrchestratorConfig {
  return { controlRepoDir, ...DEFAULT_CONFIG, ...overrides };
}

/**
 * Global orchestration kill switch.
 *
 * Production remains enabled by default for backwards compatibility. Staging
 * and observer daemons must explicitly set `HERCULES_DISPATCH_ENABLED=0`; that
 * makes their tick read-only after syncing the control snapshot.
 */
export function dispatchEnabledFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Pick<OrchestratorConfig, 'dispatchEnabled'> {
  const raw = (env['HERCULES_DISPATCH_ENABLED'] ?? '1').trim().toLowerCase();
  return {
    dispatchEnabled: !['0', 'false', 'off', 'no'].includes(raw),
  };
}

/**
 * Stall / hard-kill overrides from env (free-tier operators).
 *
 * - `HERCULES_STALL_TIMEOUT_MS` — idle stream timeout (default 10m)
 * - `HERCULES_MAX_RUN_MS` — hard wall-clock even when processAlive (default 2h)
 *
 * Invalid values fall back to defaults. Stall is never fully disabled: a
 * non-positive max-run is rejected so the hard backstop remains.
 */
export function stallOverridesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Pick<OrchestratorConfig, 'stallTimeoutMs' | 'maxRunMs'> {
  return {
    stallTimeoutMs: parsePositiveMsEnv(env['HERCULES_STALL_TIMEOUT_MS'], DEFAULT_STALL_TIMEOUT_MS),
    maxRunMs: parsePositiveMsEnv(env['HERCULES_MAX_RUN_MS'], DEFAULT_MAX_RUN_MS),
  };
}

/**
 * Per-command timeout for deterministic host_operation / deploy execution.
 * `HERCULES_HOST_COMMAND_TIMEOUT_MS` — default 30m; pure clamp lives in domain.
 * Env parsing stays here (outer layer) so domain remains free of process.env.
 */
export function hostCommandTimeoutFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return resolveHostCommandTimeoutMs(env['HERCULES_HOST_COMMAND_TIMEOUT_MS']);
}

/**
 * Staging deploy debounce from env (release reconciler quiet period).
 * `HERCULES_STAGING_DEBOUNCE_MS` — default 5 min. Invalid → default.
 */
export function stagingDebounceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Pick<OrchestratorConfig, 'stagingDeployDebounceMs'> {
  return {
    stagingDeployDebounceMs: parsePositiveMsEnv(
      env['HERCULES_STAGING_DEBOUNCE_MS'],
      DEFAULT_STAGING_DEPLOY_DEBOUNCE_MS,
    ),
  };
}

/**
 * Staging verify overall timeout from env.
 * `HERCULES_STAGING_VERIFY_TIMEOUT_MS` — default 15 min. Invalid → default.
 */
export function stagingVerifyTimeoutFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Pick<OrchestratorConfig, 'stagingVerifyTimeoutMs'> {
  return {
    stagingVerifyTimeoutMs: parsePositiveMsEnv(
      env['HERCULES_STAGING_VERIFY_TIMEOUT_MS'],
      DEFAULT_STAGING_VERIFY_TIMEOUT_MS,
    ),
  };
}

/**
 * Cargo shared-target auto-prune knobs (verify teardown + disk-warn).
 *
 * - `HERCULES_CARGO_TARGET_DIR` — absolute path(s), comma or colon separated
 * - `HERCULES_CARGO_CACHE_RETAIN_DAYS` — keep large debug/deps newer than N days
 *   (default 2). Invalid / missing → 2.
 */
export function cargoCachePruneFromEnv(env: NodeJS.ProcessEnv = process.env): {
  readonly cargoTargetEnv: string | null;
  readonly cargoCacheRetainDays: number;
} {
  const rawDir = (env['HERCULES_CARGO_TARGET_DIR'] ?? '').trim();
  const rawDays = (env['HERCULES_CARGO_CACHE_RETAIN_DAYS'] ?? '').trim();
  let cargoCacheRetainDays = 2;
  if (rawDays.length > 0) {
    const n = Number(rawDays);
    if (Number.isFinite(n) && n > 0) cargoCacheRetainDays = Math.floor(n);
  }
  return {
    cargoTargetEnv: rawDir.length > 0 ? rawDir : null,
    cargoCacheRetainDays,
  };
}
