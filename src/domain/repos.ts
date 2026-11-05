/**
 * Domain layer — target-repo registry types (SPEC §3.3).
 *
 * Pure types only. Parsing/validation of repos.yaml lives in the control layer.
 */
import type { AdapterKind } from './agents.js';
import type { AutoMergePolicy } from './autoMerge.js';
import type { RepoExecutionPolicyInput } from './repoExecutionPolicy.js';
import type { OwnerCheckoutRegistration } from './workspaceSuccession.js';

/** Repo readiness for autonomous work (SPEC §15 / G8). */
export type RepoReadiness = 'ready' | 'incomplete';

export function isRepoReadiness(v: unknown): v is RepoReadiness {
  return v === 'ready' || v === 'incomplete';
}

export interface RepoConfig {
  /** The registry key (also the on-disk repo identifier); safe per isValidIdentifier. */
  readonly key: string;
  /** Git URL or local path. */
  readonly url: string;
  readonly defaultBranch: string;
  /** Path to the per-repo policy file, within the repo (SPEC §12). */
  readonly workflow: string;
  /** Per-repo concurrency cap (SPEC §6). */
  readonly maxConcurrent: number;
  /**
   * Optional agent override for this repo (`grok` | `codex` | `claude` | `cursor` | `fake`).
   * `null` = use the daemon default (`HERCULES_ADAPTER` / registry default).
   */
  readonly adapter: AdapterKind | null;
  /**
   * `incomplete` → only tasks labeled `onboarding` / `readiness` may dispatch
   * (forces onboarding before trusting the harness for real work).
   */
  readonly readiness: RepoReadiness;
  /**
   * Optional absolute cargo target / shared-target dir for post-verify prune.
   * `null` / omit → use daemon env `HERCULES_CARGO_TARGET_DIR` only.
   * Never invent host-specific defaults (e.g. acme paths).
   */
  readonly cargoTargetDir?: string | null;
  /**
   * Optional per-repo agent execution policy (sandbox / network / env allowlist).
   * Omit → documented compatible defaults via {@link effectiveRepoExecutionPolicy}.
   * Guardian-grade posture must be explicit (`profile: guardian` or strict fields).
   */
  readonly executionPolicy?: RepoExecutionPolicyInput | null;
  /** Optional auto-merge pilot policy (repos.yaml `auto_merge`). Omit/null = off. */
  readonly autoMerge?: AutoMergePolicy | null;
  /** Explicit opt-in source-owner checkouts. Observation is always read-only. */
  readonly ownerCheckouts?: readonly OwnerCheckoutRegistration[];
}

export interface ReposConfig {
  readonly repos: Readonly<Record<string, RepoConfig>>;
}
