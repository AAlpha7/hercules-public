# Symphony implementation reference

This note records a code-level comparison with OpenAI's open-source Symphony
reference implementation. It is an architectural input for Hercules, not a
proposal to replace its control plane or weaken its approval boundaries.

## What the reference implementation actually provides

- It continuously polls an external issue tracker and dispatches only while
  configured concurrency slots are available.
- Each issue receives its own workspace, a Codex app-server session, and bounded
  continuation turns while the issue remains active.
- Its scheduler is supervised, reconciles running and stalled work, and can
  reload workflow configuration while running.
- It exposes lightweight runtime status, but is explicitly an engineering
  preview intended for trusted environments.

## What Hercules should adopt

1. **Advisory task graph and conflict-aware concurrency.** Build a durable,
   reviewable dependency/conflict model before raising the current one-task
   concurrency limit. Use existing worktree, branch, and path leases as the
   enforcement layer.
2. **Durable session health and recovery.** Record session identity, liveness,
   last meaningful progress, continuation reason, retry decision, and a
   bounded redacted failure receipt. Recovery must survive daemon restart.
3. **Portfolio scheduler observability.** Show runnable work, blocking
   dependency, occupied slot, stall reason, and resumption outcome. Include the
   causal link between a Hercules remediation and the originally blocked task.

## What Hercules should not copy

- Do not treat in-memory runtime state as sufficient for blocked or recovery
  state. Git-backed, restart-safe records remain authoritative.
- Do not turn tracker state into permission to merge, deploy, promote, change
  privileges, or make external writes. Existing human boundaries remain.
- Do not enable unconstrained fan-out. Parallelism must be introduced only for
  tasks whose resource leases and dependency graph prove non-conflict.

## Suggested implementation order

1. Finish durable merge-failure diagnostic receipts and platform-remediation
   causal telemetry.
2. Add advisory dependency/conflict classification and scheduler explanations.
3. Add restart-safe session health/recovery records.
4. Enable a small, measured concurrency increase for proven-independent work,
   with rollback to single-task operation.

## Sources

- OpenAI, ["An open-source spec for Codex orchestration: Symphony"](https://openai.com/index/open-source-codex-orchestration-symphony/).
- OpenAI, [Symphony reference implementation](https://github.com/openai/symphony), especially the orchestrator, agent runner, and workspace modules.
