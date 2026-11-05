# Hercules autonomy architecture

This document set captures the operating vision for Hercules: safely advance
multiple projects in parallel while asking the operator only for decisions that
cannot be proven mechanically. It is deliberately a design and backlog, not an
authorization to change production policy or to let agents self-modify.

The current system already has task plans, worktrees, gates, retries, review
packets, manual dependencies and linear pipelines. It does **not** yet have a
complete automatic decomposition, DAG execution, learning, and aggregation
layer.

Read in this order:

1. [Vision and governance](vision-and-governance.md)
2. [Adaptive task graph](adaptive-task-graph.md)
3. [Evidence memory and context compiler](evidence-memory.md)
4. [Autonomy quality observability](autonomy-observability.md)
5. [Task-origin provenance](task-origin-provenance.md)
6. [Acceptance-criterion binding grammar](acceptance-binding-grammar.md) — verdict honesty contract (P8/P9/P10)

The first implementation is restricted to technical code tasks and must be
evaluated using real current task artifacts before it can affect production,
deletions, privilege, spending, or security policy.
