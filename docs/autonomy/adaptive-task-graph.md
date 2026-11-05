# Adaptive task decomposition and execution graph

## Why a graph

Large requests are less reliable than small, independently verifiable work
slices. Parallelism reduces elapsed time only when work is truly independent.
The execution model is therefore a dynamic directed acyclic graph (DAG), not a
flat queue or a fixed tree. Edges represent semantic outputs, interface
contracts, resource locks, or integration prerequisites.

## Leaf readiness

A node is executable only when it has one behavior goal; explicit inputs and
outputs; known scope; deterministic or reviewable acceptance evidence; no
unresolved architecture/product judgement; local retry/rollback behavior; and
a predictable conflict/resource profile in an isolated worktree.

Line count, file count, and token estimate are weak signals, never stop rules.
If any leaf condition is absent, split by a real semantic boundary or first
create an investigation/design node that removes the unknown. Do not split
until tiny: excess slicing loses context and raises coordination/merge cost.

The decisive question is: *before dispatch, can the system state the observable
change and independently prove it without guessing or waiting on undiscovered
work?* If not, it is not a leaf.

## Roles

- **Planner:** proposes a graph, its rationale, contracts, and estimated risk.
- **Decomposition reviewer:** challenges leaf readiness using codebase evidence,
  historical analogues, dependency checks, and resource conflicts.
- **Scheduler:** dispatches only dependency-ready, resource-safe nodes.
- **Reconciler/integrator:** consumes real evidence to accept, retry, replan,
  or escalate a genuine operator decision; it re-verifies the top-level goal.

Every node records a contract: required inputs, output artifact/behavior,
acceptance checks, owner/worktree, allowed concurrent nodes, and retry policy.
Failure, a discovered coupling, or changed evidence may replan only the affected
subgraph. Cycles create an investigation node; they must never be scheduled.

## Safety and evaluation

Use separate worktrees, file/branch conflict analysis, environment and deploy
locks, build-cache pressure, and concurrency budgets. A green child set is not
success: integration checks prove the original objective. Start with code-only
tasks, run proposed DAGs in advisory/shadow mode, then compare completion,
rework, conflicts, and evidence quality with the existing workflow.

## Backlog-sized implementation path

1. Typed graph/node/edge/contract domain model plus validation and cycle tests.
2. Planner output format and human-readable proposed graph; no dispatch change. (domain: `taskGraph` + `proposedGraphPacket` — advisory packet only)
3. Leaf-readiness critic using declared evidence, code-map scope, and conflicts. (domain: `leafReadinessCritic` — advisory; no graph mutation or dispatch)
4. Ready-node/resource scheduler in shadow mode. (domain: `readyNodeShadowScheduler` — shadow only; linear dispatch unchanged)
5. Reconciler for local replan and top-level integration packet. (domain: `graphReconciler` — advisory; no auto-dispatch of replan, no merge/deploy/permission auto-apply)
6. Limited technical-task pilot, measured against the current linear pipeline.
