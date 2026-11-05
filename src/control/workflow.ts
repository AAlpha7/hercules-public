/**
 * Control layer — WORKFLOW.md parse (SPEC §12).
 *
 * A target repo's policy: front matter (gate commands the runner executes,
 * protected paths, held-out smoke) + a markdown body (the golden principles /
 * prompt prepended to every task). SECURITY (§10): this MUST be read from a
 * trusted ref (the repo's default branch via its mirror), never the agent's
 * worktree, because its gate commands are executed.
 */
import matter from 'gray-matter';
import { z } from 'zod';
import type { Gate } from '../verification/gates.js';
import type { AllocationContext } from '../domain/allocation.js';
import { parseEvidenceEntries, type EvidenceStep } from '../domain/evidence.js';
import {
  CliEvidenceParseError,
  parseCliEvidenceConfig,
  type CliEvidencePlan,
} from '../domain/cliEvidence.js';
import {
  ProjectStateClosureParseError,
  parseProjectStateClosureConfig,
  type ProjectStateClosureContract,
} from '../domain/projectStateClosure.js';

export class WorkflowError extends Error {
  override readonly name = 'WorkflowError';
}

/** Canonical gate order (cheapest first, SPEC §9.1). */
const GATE_ORDER = ['typecheck', 'lint', 'test', 'build'] as const;

const schema = z.object({
  setup: z
    .object({
      install: z.array(z.string()).default([]),
      boot: z.array(z.string()).default([]),
      health_check: z.string().optional(),
    })
    .default({ install: [], boot: [] }),
  behavioral: z
    .object({
      base_url: z.string(),
      driver: z.string().default('cdp'),
      capture: z.array(z.string()).default([]),
      smoke_flows: z.array(z.string()).default([]),
      /**
       * Declarative L2 evidence plan (elegant contract). Prefer this over
       * smoke_flows heuristics. Entries: unlock | click | assert | screenshot.
       * Task body `## Evidence` overrides when present.
       */
      evidence: z.array(z.unknown()).optional(),
      /**
       * SPA access token to inject into localStorage before screenshots
       * (must match HERCULES_TOKEN used in setup.boot). Without this, L2 only
       * captures the login gate — useless for post-auth UI evidence.
       */
      auth_token: z.string().optional(),
      /** localStorage key for the token (default hercules_token). */
      auth_storage_key: z.string().optional(),
    })
    .optional(),
  gates: z.record(z.string(), z.string()).default({}),
  held_out_smoke: z.string().optional(),
  protected_paths: z.array(z.string()).default([]),
  /** Trusted CLI behavioral evidence (argv dialect; never task body). */
  cli_evidence: z.unknown().optional(),
  /**
   * Release deploy policy (design §2). Absent → undefined (zero behavior
   * change for repos that do not declare deploy).
   */
  deploy: z
    .object({
      staging: z
        .object({
          command: z.string().min(1),
          health: z.string().min(1),
          url: z.string().optional(),
          /** Reuses the L2 evidence DSL via parseEvidenceEntries — no second dialect. */
          verify: z.array(z.unknown()).optional(),
          /**
           * Daemon env var holding the STAGING UI token for the `unlock`
           * evidence step (secrets never live in WORKFLOW; the persistent
           * staging instance has its own token unlike the L2 demo boot).
           */
          auth_token_env: z.string().optional(),
          auth_storage_key: z.string().optional(),
        })
        .optional(),
      production: z
        .object({
          command: z.string().min(1),
          health: z.string().min(1),
          smoke: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  /**
   * Opt-in project-state closure contract (trusted default branch only).
   * Absent → ordinary merges (no global status-file churn). Parsed by
   * {@link parseProjectStateClosureConfig}; never from task body.
   */
  project_state_closure: z.unknown().optional(),
});

export interface WorkflowSetup {
  readonly install: readonly string[];
  readonly boot: readonly string[];
}

export interface BehavioralConfig {
  readonly baseUrl: string;
  readonly driver: string;
  readonly capture: readonly string[];
  readonly smokeFlows: readonly string[];
  /** Declarative evidence steps from WORKFLOW (task ## Evidence overrides). */
  readonly evidence: readonly EvidenceStep[];
  /** Injected into SPA localStorage before L2 screenshots (post-auth UI). */
  readonly authToken: string | undefined;
  readonly authStorageKey: string;
}

/** Staging deploy policy from WORKFLOW `deploy.staging`. */
export interface DeployStagingConfig {
  readonly command: string;
  readonly health: string;
  readonly url: string | undefined;
  /** Release-level E2E steps; same EvidenceStep dialect as L2. */
  readonly verify: readonly EvidenceStep[];
  /** Daemon env var name whose value unlocks the staging UI (evidence `unlock`). */
  readonly authTokenEnv: string | undefined;
  /** localStorage key the SPA reads the token from (default hercules_token). */
  readonly authStorageKey: string;
}

/** Production deploy policy from WORKFLOW `deploy.production`. */
export interface DeployProductionConfig {
  readonly command: string;
  readonly health: string;
  readonly smoke: string | undefined;
}

/** Optional deploy section (absent → undefined on WorkflowConfig). */
export interface DeployConfig {
  readonly staging: DeployStagingConfig | undefined;
  readonly production: DeployProductionConfig | undefined;
}

export interface WorkflowConfig {
  readonly setup: WorkflowSetup;
  readonly healthCheck: string | undefined;
  readonly behavioral: BehavioralConfig | undefined;
  readonly gates: readonly Gate[];
  readonly protectedPaths: readonly string[];
  /**
   * Trusted CLI behavioral-evidence plan (absent when WORKFLOW omits it).
   */
  readonly cliEvidence: CliEvidencePlan | undefined;
  readonly heldOutSmoke: string | undefined;
  /**
   * Deploy policy (staging / production). Undefined when WORKFLOW has no
   * `deploy:` section — repos without deploy are unaffected.
   */
  readonly deploy: DeployConfig | undefined;
  /**
   * Opt-in project-state closure (undefined when WORKFLOW omits it).
   * Policy-only stubs still set this so merge can load the referenced file.
   */
  readonly projectStateClosure: ProjectStateClosureContract | undefined;
  /** The golden principles / prompt body. */
  readonly body: string;
}

/**
 * Substitute the allocation context (SPEC §8.3) into a WORKFLOW command:
 * {slug}, {port}, {scratch_dir}. Unknown placeholders are left as-is.
 */
export function substituteAllocation(command: string, alloc: AllocationContext): string {
  return command
    .replaceAll('{slug}', alloc.slug)
    .replaceAll('{port}', String(alloc.port))
    .replaceAll('{scratch_dir}', alloc.scratchDir);
}

export function parseWorkflow(content: string): WorkflowConfig {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch (err) {
    throw new WorkflowError(`could not parse WORKFLOW.md: ${(err as Error).message}`);
  }
  if (Object.keys(parsed.data).length === 0) {
    throw new WorkflowError('WORKFLOW.md is missing its YAML front matter');
  }

  const result = schema.safeParse(parsed.data);
  if (!result.success) {
    throw new WorkflowError(`invalid WORKFLOW.md: ${result.error.issues.map((i) => i.message).join('; ')}`);
  }

  const gateMap = result.data.gates;
  const gates: Gate[] = GATE_ORDER.filter((name) => name in gateMap).map((name) => ({
    name,
    command: gateMap[name]!,
  }));

  const b = result.data.behavioral;
  const d = result.data.deploy;
  let cliEvidence: CliEvidencePlan | undefined;
  try {
    const plan = parseCliEvidenceConfig(result.data.cli_evidence);
    cliEvidence = plan ?? undefined;
  } catch (err) {
    if (err instanceof CliEvidenceParseError) {
      throw new WorkflowError(err.message);
    }
    throw err;
  }
  let projectStateClosure: ProjectStateClosureContract | undefined;
  try {
    const closure = parseProjectStateClosureConfig(result.data.project_state_closure);
    projectStateClosure = closure ?? undefined;
  } catch (err) {
    if (err instanceof ProjectStateClosureParseError) {
      throw new WorkflowError(err.message);
    }
    throw err;
  }
  return {
    setup: { install: result.data.setup.install, boot: result.data.setup.boot },
    healthCheck: result.data.setup.health_check,
    behavioral: b
      ? {
          baseUrl: b.base_url,
          driver: b.driver,
          capture: b.capture,
          smokeFlows: b.smoke_flows,
          evidence: parseEvidenceEntries(b.evidence ?? []),
          authToken: b.auth_token,
          authStorageKey: b.auth_storage_key?.trim() || 'hercules_token',
        }
      : undefined,
    gates,
    protectedPaths: result.data.protected_paths,
    cliEvidence,
    heldOutSmoke: result.data.held_out_smoke,
    deploy: d
      ? {
          staging: d.staging
            ? {
                command: d.staging.command,
                health: d.staging.health,
                url: d.staging.url,
                verify: parseEvidenceEntries(d.staging.verify ?? []),
                authTokenEnv: d.staging.auth_token_env,
                authStorageKey: d.staging.auth_storage_key ?? 'hercules_token',
              }
            : undefined,
          production: d.production
            ? {
                command: d.production.command,
                health: d.production.health,
                smoke: d.production.smoke,
              }
            : undefined,
        }
      : undefined,
    projectStateClosure,
    body: parsed.content.trim(),
  };
}
