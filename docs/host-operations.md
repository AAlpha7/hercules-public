# Host-operation execution policy

Per-repository agent sandbox/network policy and coding/verification child-env
policy: see [`docs/repo-execution-policy.md`](./repo-execution-policy.md). A
worktree is **not** an OS sandbox; Guardian-grade `execution_policy` fails
closed when the selected coding adapter cannot enforce the required controls.

Hercules separates ordinary worktree work from commands that mutate a host or
deploy a service. The task front matter records one of:

- `explore`, `implement`, `verify`
- `host_operation`, `deploy`

Legacy tasks default to `implement`.

## Permission boundary

Unattended Grok runs use `--permission-mode dontAsk`, so unlisted tools are
denied without an interactive prompt.

- Implement (default): Grok built-ins `read_file`, `grep`, `list_dir`,
  `search_replace` plus H MCP tools `hercules_workspace__apply_patch` and
  `hercules_workspace__delete_file` (stdio MCP server under an isolated
  `GROK_HOME`, outside the agent worktree). `--sandbox workspace`, `dontAsk`,
  `--disallowed-tools run_terminal_command,write`, `--deny Bash`, web tools
  off. Runtime fail-closed if the stream advertises `run_terminal_command`.
  Prefer MCP mutation over tests that rewrite source only to shape the
  post-test Git diff. Path confinement is H MCP work (absolute/traversal/
  symlink-ancestor denials).
- Explore / verify: same sandbox/dontAsk/shell strip; built-ins only (no
  mutation MCP registration; no patch/delete/shell).
- Host/deploy classes: **deterministic Hercules executor** (not Grok/Codex/Claude).
  Only `validateHostCommandScope`-approved literal commands run, sequentially,
  at most once per approval, each in its own process group with an explicit
  timeout (default **30 minutes**, override `HERCULES_HOST_COMMAND_TIMEOUT_MS`).
  No shell metacharacters, no automatic retry, no LLM tool mediation.
  Child env is a **strict fixed-name allowlist** (`hostChildEnv`) — separate
  from L2 `bootAppEnv` prefixes — so `NODE_OPTIONS`, tokens, `DATABASE_URL`,
  loader vars, and credential-bearing proxies never inherit from the daemon.
  Defense-in-depth Grok argv (if ever used) names the real shell tool
  `run_terminal_command` — production dispatch never launches a coding adapter.
- L3 reviewer: read/search/list tools in the read-only sandbox, with web access
  disabled.
- Analyst (`hercules-analyst`): `extends = "strict"`, `deny = []`, private
  `GROK_HOME` (auth.json + agent_id only) — no continuity/rules deny mounts
  (grok CLI ≥ 1.0.13 refuses those).

Host/deploy tasks keep adapter metadata pinned at creation for UI consistency,
but dispatch never launches a coding adapter for them. Human approval + exact
command validation remain the security chokepoint.

Before the first host command can spawn, Hercules commits a durable
`host_execution_started_at` marker (and a body audit section). If the daemon
crashes mid-execution, orphan recovery **fails** every untracked in_progress
host_operation/deploy task (including legacy tasks without the marker) with
`## Host operation replay blocked` — it never recovers to `retrying` to run
the scope again. Host children inherit a minimal allowlist env only (no
`XAI_API_KEY` / `DATABASE_URL` / `GITHUB_TOKEN` leakage).

Hercules runs trusted L1/L2 gates after coding runs; the coding agent does not
need shell access to execute its own tests.

## Human approval

Create a task from the phone and choose **Host operation** or **Deploy**. The
task remains undispatchable until the detail view records a human-approved,
one-command-per-line scope. Existing approvals can be revised while the task is
`todo`, `retrying`, or `failed`; each changed approval is audit-stamped.

Scopes are literal commands. Wildcards, shell metacharacters, `Bash(...)`
permission rules, shell wrappers, duplicate entries, and non-ASCII command
syntax are rejected.

Equivalent front matter:

```yaml
execution_class: host_operation
host_command_scope:
  - systemctl restart hercules
  - systemctl is-active hercules
host_approved_at: 2026-07-31T12:00:00.000Z
```

## Completion receipt

The deterministic executor emits the canonical `## Host operation receipt`
mechanically (bounded/redacted stdout/stderr tails, exit/signal/duration).
Outcome is authoritative: any timeout, non-zero exit, cancel, signal, or
ambiguous launch result yields a non-success receipt and later commands do not
run. Human cancel (graceful, deadline force, or force-abort) awaits process-group
settlement boundedly, then appends the complete canonical receipt exactly once
before workspace teardown.

A host/deploy run cannot produce a green review packet unless its current final
report contains exactly one `## Host operation receipt` with:

- the exact approved commands, in order
- outcome `success`
- nonblank post-check evidence

Receipts in the initial task body or an older review packet are not accepted as
current-run evidence. Missing, duplicate, mismatched, partial, failed, skipped,
or evidence-free receipts add a red `host-operation-receipt` gate without
automatically re-running the host mutation.

Agent exits, stalls, verification crashes, failed proof, queued chat, and other
post-dispatch failures also never auto-replay a host/deploy run. The task parks
for a human, and retry/reject/steer clear the old approval; even an unchanged
command scope needs a fresh approval timestamp before another dispatch.

## Live observability

While a host execution runs, `liveRuns` exposes `hostCommandIndex`,
`hostCommandTotal`, `hostCommandName`, `hostCommandTimeoutMs`, `processAlive`,
and elapsed time. Full command environment and secret-bearing output are never
sent to the phone API.
