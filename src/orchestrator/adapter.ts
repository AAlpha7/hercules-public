/**
 * Execution layer — the agent adapter contract (SPEC §13).
 *
 * Real agents (Grok Build default, Codex, Claude Code opt-in) satisfy this. We
 * normalize on logical behavior, not a JSON schema. The orchestrator drives a
 * run by polling it each tick — the adapter reports a status and the time of
 * its last event so the loop can detect completion and stalls without holding
 * callbacks.
 */
import type { AllocationContext } from '../domain/allocation.js';
import type { FactoryPrArtifact } from '../domain/cursorCloud.js';
import type { FakeBehaviorScript } from '../domain/fakeBehavior.js';
import type { ExecutionClass } from '../domain/executionClass.js';
import type { EffectiveRepoExecutionPolicy } from '../domain/repoExecutionPolicy.js';

/**
 * Logical completion state of a run. `needs-input` (SPEC §13) is deferred; for
 * now a run is running, finished successfully (→ task moves to `review`), or
 * failed (→ retry/backoff).
 */
export type RunStatus = 'running' | 'done' | 'failed';

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

export interface RunSnapshot {
  readonly sessionId: string;
  readonly status: RunStatus;
  /** ms since epoch of the last observed agent event; used for stall detection. */
  readonly lastEventAt: number;
  /** Cumulative token usage, when the adapter reports it (SPEC §13). */
  readonly usage?: TokenUsage;
  /** Recent human-readable activity lines (live log), when the adapter has any. */
  readonly recentActivity?: readonly string[];
  /**
   * Process exit code when the run is terminal and the adapter knows it.
   * `null` = unknown (signal, stream error, non-process fake). Omitted while running.
   */
  readonly exitCode?: number | null;
  /**
   * OS signal that killed the child when known (`SIGTERM`, `SIGKILL`, …).
   * Omitted while running; `null` when exit was by code only.
   */
  readonly exitSignal?: string | null;
  /**
   * Bounded stderr tail (~2KB) for death diagnosis. Present when the adapter
   * captured process stderr; used to replace bare `exit unknown`.
   */
  readonly stderrTail?: string;
  /**
   * When true, the child process is still alive. Orchestrator **must not**
   * idle-stall (stream silence is normal during long tool runs — cargo, pnpm
   * test, browser). Fake `hang` leaves this unset so stall tests still work.
   * Hard wall-clock limit is {@link OrchestratorConfig.maxRunMs}.
   */
  readonly processAlive?: boolean;
  /**
   * OS pid of the agent child when known. Orchestrator samples the process
   * tree for a live "alive hint" (cargo / rustc / pnpm) so the phone does not
   * look stuck during stream silence.
   */
  readonly processPid?: number;
  /**
   * Optional precomputed worker hint from the adapter. When unset, the
   * orchestrator may derive one from {@link processPid}.
   */
  readonly aliveHint?: string | null;
  /**
   * Remote PR opened by the adapter (Cursor Cloud factory). Present when the
   * injected client returned a GitHub pull request as the done artifact.
   */
  readonly prUrl?: string;
  readonly prNumber?: number;
}

export interface AgentRun {
  readonly sessionId: string;
  /** Cheap; called every tick. `now` lets time-based adapters report progress. */
  poll(now: number): RunSnapshot;
  /** The FULL retained activity transcript (up to ACTIVITY_CAP lines), for the
   *  review packet — distinct from poll()'s small live tail. Called at done. */
  activityLog(): readonly string[];
  /** The agent's final text message — its closing report, and the whole
   *  deliverable for a text task (summarize/analyze). Empty if it emitted no
   *  text. Distinct from activityLog(), which keeps only first-lines. Called at
   *  done. Adapters with no text channel (codex stub) return ''. */
  finalMessage(): string;
  /** Begin stopping the run. Graceful (default) = SIGTERM; `force` = SIGKILL.
   *  Idempotent. After a graceful stop the run keeps reporting `running` until
   *  the process actually exits; a forced stop exits it immediately. */
  stop(opts?: { force?: boolean }): void;
}

export interface AgentStartInput {
  readonly taskId: string;
  /** Absolute path to the isolated worktree (a plain dir for the fake adapter). */
  readonly workspace: string;
  /** Assembled prompt: WORKFLOW.md body + task body + acceptance criteria. */
  readonly prompt: string;
  /** Isolation primitives the boot hook consumes (slug, port, scratch dir). */
  readonly allocation: AllocationContext;
  /**
   * When set, resume this prior adapter session (comment-to-steer / multi-turn).
   * Adapters that cannot resume ignore it and start a fresh session.
   */
  readonly resumeSessionId?: string;
  /**
   * Isolation-only fault script from task front matter. **Only FakeAdapter
   * honors this** (and only when `HERCULES_FAKE_FAULT_INJECTION=1`). Real
   * adapters (grok/codex/claude/cursor) ignore the field — zero behavioral change.
   */
  readonly fakeBehavior?: FakeBehaviorScript | null;
  /**
   * Execution class for host-op permission policy (Grok argv).
   * Absent → implement (legacy coding).
   */
  readonly executionClass?: ExecutionClass | null;
  /**
   * Human-approved named host commands (host_operation / deploy only).
   * Used to build exact Bash allow rules under fail-closed `dontAsk`.
   */
  readonly hostCommandScope?: readonly string[] | null;
  /**
   * Effective per-repo execution policy (sandbox/network/env). Resolved by the
   * orchestrator before start; adapters filter child env against it.
   * Absent → compatible defaults inside the adapter env boundary.
   */
  readonly executionPolicy?: EffectiveRepoExecutionPolicy | null;
  /**
   * Target git remote for remote executors (Cursor Cloud). Local CLI adapters
   * ignore this — they mutate {@link workspace}.
   */
  readonly repository?: string;
  /**
   * Starting ref for remote executors. First factory launches use the repo
   * default branch; open-PR rework (conflict / CI / BEHIND / fail-retry)
   * uses the existing Cloud Agent PR head.
   */
  readonly ref?: string;
  /**
   * Factory rework of an already-open PR. Remote executor sends v0
   * `source.prUrl` with `autoBranch: false` and must not open a second PR.
   * Done uses this handle when the snapshot omits a new prUrl.
   */
  readonly existingFactoryPr?: FactoryPrArtifact;
  /**
   * Restart reattach: poll this existing Cloud Agent instead of launching.
   * Not followup. Rework / fail-retry omit this and launch as before.
   */
  readonly attachFactoryAgentId?: string;
}

export interface AgentAdapter {
  readonly name: string;
  start(input: AgentStartInput, now: number): AgentRun;
}
