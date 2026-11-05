# SPEC.md — Cadence: a minimal multi-repo coding-agent orchestrator

> Codename "Cadence" is a placeholder; rename freely.
>
> This document is the single source of truth for implementation. It is written
> to be handed to an implementing agent (Claude Code). It specifies **what to
> build and why**, and deliberately leaves some library-level choices to the
> implementer. Where a decision is load-bearing, it is marked **MUST**; where it
> is a recommended default, it is marked **SHOULD**.

---

## 0. The one-sentence invariant

**For every open, unblocked task, guarantee that exactly one coding agent is
running in its own isolated workspace — and that the agent can verify its own
work before a human ever looks at it.**

Everything below is in service of that sentence. If an implementation detail
conflicts with it, the sentence wins.

---

## 1. Philosophy (read before designing anything)

This system fuses two ideas from OpenAI's public writing (see References):

1. **Harness engineering** — the environment around an agent matters more than
   the prompt. Anything an agent cannot reach in its context effectively does
   not exist, so all knowledge must live in version-controlled artifacts.
   Architecture is enforced *mechanically* (linters, structural tests), not by
   convention. The published `src/` layer map is that direction plus named
   exceptions in `AGENTS.md`. Today's listed exception is
   **`PATH_LEASE_PROCESS_PROBE`**: `src/isolation/taskPathLeaseStore` imports
   `src/adapters/processTree` for lease-owner OS liveness. Listing it is not
   an invert; do not move `processTree` or change eslint/layer policy here.

2. **Orchestration (the "Symphony" pattern)** — once single agents are good, the
   bottleneck becomes human attention. A person can supervise maybe 3–5
   concurrent agents before context-switching collapses. The fix is to turn the
   task store into a control plane: every open task gets an agent, the agent
   runs to a reviewable state, and the human *reviews* instead of *supervises*.

Three design tenets follow:

- **No database. The git history of a "control repo" is the source of truth and
  the audit log.** State is rebuilt from disk + git on every start. A crashed
  process loses nothing.
- **Policy lives in repos; coordination lives in the daemon.** The daemon never
  contains business logic. Per-repo flow lives in that repo's `WORKFLOW.md`.
- **Give agents objectives, not state transitions.** Models keep getting
  smarter; do not box them into rigid nodes. Hand them tools, context, and a
  clear definition of done, then let them work.

---

## 2. System shape

A **single monolithic Node/TypeScript daemon** containing three logical layers:

```
                          ┌─────────────────────────────────────────┐
   phone (remote)  ─────► │  Embedded HTTP server + SSE  (UI/API)     │  ← layer: presentation
                          ├─────────────────────────────────────────┤
                          │  Orchestrator: tick loop, scheduling,     │  ← layer: coordination
                          │  concurrency, reconciliation, retry       │
                          ├─────────────────────────────────────────┤
                          │  Agent adapters (Claude Code | Codex)     │  ← layer: execution
                          └─────────────────────────────────────────┘
                                   │ reads/writes
                          ┌────────┴───────────┐        ┌───────────────────┐
                          │  control repo (git) │        │ target repos (N)  │
                          │  tasks/*.md         │        │ each: WORKFLOW.md │
                          │  repos.yaml         │        │ + code + gates    │
                          └─────────────────────┘        └───────────────────┘
```

**MUST** be one process for v1 (orchestrator + HTTP server share the in-memory
runtime snapshot directly — the snapshot is exactly what the UI needs). No
microservices, no message broker.

---

## 3. Data model

### 3.1 Control repo

A dedicated git repository the daemon owns. It contains:

```
control-repo/
  repos.yaml          # registry of target repos the daemon manages
  tasks/
    ABC-12.md
    ABC-13.md
    ...
```

Tasks are markdown files. **The file is the task.** Git history of this repo is
the complete lifecycle audit. The UI reads and writes here; humans may also edit
by hand and commit.

### 3.2 Task file format

YAML front matter + markdown body:

```yaml
---
id: ABC-12               # MUST match filename stem; sanitized [A-Za-z0-9._-]
title: Fix flaky upload retry
repo: my-app             # MUST be a key in repos.yaml
state: todo              # see state machine §5
priority: 2              # lower = higher priority
blocked_by: [ABC-09]     # task ids; eligible only when every dependency is done (success)
labels: [backend]
# fields below are written by the daemon, not the human:
agent_session: null      # adapter's session/thread id, for resume
attempts: 0
last_event_at: null      # ISO timestamp; used for stall detection
---

## Task
<free-form description for the agent>

## Acceptance criteria
- [ ] checkable criterion 1
- [ ] checkable criterion 2
```

- **MUST** treat `state` in front matter as authoritative (not directory
  position). Keeping all task files in one `tasks/` dir is fine.
- The acceptance-criteria section is load-bearing for self-verification (§9). If
  absent and the task is non-trivial, the agent's first action is to propose
  criteria and move the task to `review` for human sign-off before implementing.

### 3.3 repos.yaml

```yaml
repos:
  my-app:
    url: git@github.com:me/my-app.git      # or local path
    default_branch: main
    workflow: WORKFLOW.md                  # path within the repo; optional override
    max_concurrent: 1                      # per-repo cap (§6)
    # Optional. Omit → documented compatible defaults (not OS-sandbox claims).
    # Guardian-grade posture must be explicit and fails closed when the
    # selected adapter cannot enforce a required control. See
    # docs/repo-execution-policy.md.
    # execution_policy:
    #   profile: guardian   # or field-level sandbox/network/env_allowlist/…
  other-service:
    url: git@github.com:me/other-service.git
    default_branch: main
    max_concurrent: 1
```

---

## 4. Target repo layout

Each managed repo carries its own policy. The daemon never hardcodes anything
repo-specific.

```
target-repo/
  WORKFLOW.md          # per-repo policy (§8)
  AGENTS.md            # canonical short agent map (≤~120 lines; CLAUDE.md may be a thin pointer)
  ...code...
```

---

## 5. Task state machine

```
todo ──► in_progress ──► review ──► done
  ▲           │            │
  │           ▼            ▼
  └──── retrying        cancelled
              │
              ▼
           failed
```

States:

- `todo` — eligible for dispatch once `blocked_by` edges are satisfied.
- `in_progress` — an agent is running (or assigned) in a workspace.
- `review` — agent finished and produced a **review packet** (§9.6). Terminal
  for the agent; awaits human approval. **This is the normal successful end
  state for a run** — `done` is set by the human (or an auto-merge rule) after
  approval.
- `done`, `cancelled` — terminal.
- `retrying` — transient failure; will be re-dispatched with backoff (§7).
- `failed` — exhausted retries; needs human attention.

`done`, `cancelled`, `failed` are **terminal** for scheduling purposes — but a
`blocked_by` dependency is satisfied **only by success**, and success is
**mode-aware**:

- **`gate_merge`** (default for same-repo implement / verify / host / deploy
  dependents): upstream must be `done` and merged onto the trusted default
  branch. Local CLI work requires `merged_via=gate`, a `merged_sha`, a
  `verified_sha`, and those SHAs as ancestors of the trusted tip. Cursor Cloud
  factory close-out is the other path: GitHub-observed merge
  (`merged_via=operator`, `pr_status=merged`, merge SHA from GitHub) unlocks
  dependents once that merge SHA is an ancestor of the trusted tip —
  `verified_sha` stays absent (factory never runs local verify). An open
  factory PR with a red GitHub check rollup is requeued onto the existing
  Cloud Agent head (CONFLICTING uses the same observe path). A MERGEABLE
  factory PR that GitHub reports as BEHIND is requeued onto that same head
  so parallel slices stay mergeable after a sibling lands; pending or red
  checks still win over BEHIND. A finished factory draft is marked ready
  for review (not Approve). A MERGEABLE factory PR that GitHub reports as
  CLEAN with a green check rollup is squash-merged via identity-bound `gh`
  (not Approve, not MergeService, no `verified_sha`) so ring 4 close-out
  can fire without a human click; pending, red, BEHIND, CONFLICTING, or
  draft still win.   Factory rework launches send v0 `source.prUrl` with
  `autoBranch: false` and no second `autoCreatePr` (those target flags
  only apply when the source is a PR URL) so CONFLICTING / red CI /
  BEHIND update the tracked PR instead of opening an orphan. A Cloud Agent that dies after opening a PR still persists
  that handle, so retry pins the same PR instead of `autoCreatePr` again.
  Retry of an open factory PR with no stored head observes the Cloud
  Agent branch from GitHub (same identity bind as CONFLICTING / CI /
  BEHIND) and launches on that ref — not the default branch.
  A live factory Cloud Agent id (and PR handle, once opened) is persisted
  while the run is in progress; a coordinator restart reattaches that
  same remote agent (GET only) instead of launching a second one.
  Dispatch-time proof
  **refreshes the trusted default from origin** before checking
  ancestry, so a factory-only plane (no local worktree / `ensureMirror`) still
  sees GitHub-observed merge SHAs. UI/API read paths stay offline. Approve
  alone, local-CLI operator/direct merge stamps, missing provenance, stale
  mirror, or ancestry mismatch **MUST NOT** unlock. The orchestrator rechecks
  this **atomically immediately before workspace provisioning** (server-side;
  UI labels cannot bypass).
- **`completion_only`** (explicit, or inferred for explore / cross-repo):
  upstream `done` is enough — analysis / no-diff / cross-repo orchestration
  where code ancestry is not the contract.

Scheduling holds on `/api/state.holds` surface the mode as
`dependency_gate_merge` vs `dependency_completion` (with `waitingOn`), so the
phone can tell Merge Selected waits apart from plain completion waits.

A failed / cancelled / missing dependency HOLDS the dependent task and
surfaces why, until a human retries the dependency or edits `blocked_by`.
("Terminal" once vacuously satisfied dependencies: R2 parked `failed` and
silently green-lit R3 — 2026-07-22. Approve-before-Merge later green-lit
downstream implement tasks from stale main — fixed by the gate-merge barrier.)
`/api/state.holds` codes: `dependency_gate_merge` (waiting on Merge Selected /
ancestry) vs `dependency_completion` (waiting on `done`).

---

## 6. Concurrency model — three caps

1. **Global cap** — max agents running across the whole daemon. **SHOULD**
   default to `2` on the target box (§11).
2. **Per-repo cap** — `repos.yaml: max_concurrent`. **SHOULD** default to `1`.
   Prevents one busy repo from starving others and avoids merge chaos within a
   repo.
3. **Heavy-validation semaphore** — capacity **MUST** default to `1` on the
   target box. A worker has two phases: a *coding/mechanical* phase (cheap) and
   a *boot + browser-driving* phase (heavy — see §9.2). Acquiring the
   heavy-validation permit is required only to enter the heavy phase. This lets
   coding phases overlap while serializing the RAM/CPU-hungry validation so two
   headless browsers never run at once.

Implement caps as plain semaphores over the in-memory runtime state. No external
queue.

---

## 7. The orchestration loop

A periodic tick (**SHOULD** ~every few seconds; configurable). Each tick:

1. **Sync** — `git pull` the control repo; for each target repo, fetch its
   mirror (§8).
2. **Rebuild snapshot** — read all task files; reconcile against the set of
   live worker processes the daemon is tracking. The snapshot is derived, never
   persisted.
3. **Reconcile running work** — for each worker:
   - if its task's state is now terminal → tear the worker down and release its
     workspace + permits;
   - if it has produced no event for longer than the stall timeout → treat as
     stalled, kill, and move task to `retrying`.
4. **Select** — eligible = tasks in `todo`/`retrying` whose `blocked_by` edges
   pass mode-aware satisfaction (metadata) and whose `repo` is below its
   per-repo cap, and global cap not hit. Sort by `priority` then age.
5. **Dispatch** — for each selected task within remaining capacity: **recheck
   dependency gate ancestry on the trusted mirror** (fail closed; no adapter
   start on hold), then create or reuse an isolated workspace (§8), set state
   `in_progress`, start an agent via the adapter (§8.4) with the task prompt
   assembled from the repo's `WORKFLOW.md` + the task body.
6. **Retry policy** — failures bump `attempts` and apply exponential backoff
   before becoming eligible again; past a configurable max, move to `failed`.

The loop is idempotent and stateless across restarts because everything it needs
is re-derivable from git + the filesystem.

---

## 8. Isolation model

### 8.1 Per-repo mirror

For each target repo, maintain one local **bare mirror** (`git clone --mirror`,
periodically `git remote update`). Worktrees are created from the mirror.

### 8.2 Per-task worktree

Each task runs in its own git worktree on its own branch:

```
<root>/<repo>/<task-id>/      # git worktree, branch e.g. hercules/ABC-12
```

This gives physical isolation: tasks of different repos cannot touch each other;
two tasks of the same repo share an object store but have independent working
trees and branches. **MUST** confirm the worktree path resolves inside `<root>`
before any agent runs in it (§10).

### 8.3 Allocation context (the isolation contract)

The orchestrator provides isolation primitives; the repo's boot hook consumes
them. On workspace creation the daemon hands the boot hook:

- `slug` — unique per worktree (e.g. derived from task id);
- `port` (or a small allocated port base) — so booted apps don't collide;
- `scratch_dir` — a per-worktree writable temp dir.

The repo's `WORKFLOW.md` boot hook uses these to stand up an **isolated**
instance: unique port, isolated ephemeral DB / schema, isolated seed data. The
daemon owns *allocation*; the repo owns *boot logic*.

### 8.4 Dependency install

**SHOULD** use `pnpm` with a shared content-addressed store so `node_modules` is
hard-linked across worktrees rather than duplicated N times. This is a major
disk and install-time saving on the constrained target box (§11).

---

## 9. Self-verification — the five-layer closed loop

The core principle: **the agent must close its own loop — produce work, check it
against machine-readable signals, fix, repeat — with no human in the inner
loop.** A run ends at `review` only when the agent's own verification is green.

Layers, cheapest first:

### 9.1 Layer 1 — Mechanical gates (deterministic, fast, free) — REQUIRED v1
`tsc` typecheck, lint (including any custom architectural lints — dependency
direction, file size, structured logging, etc.), build, and the test suite.
**Custom lint/error messages SHOULD embed remediation instructions** ("to fix
this, do X") so the failure text itself steers the agent's next turn. This is the
engine of self-correction.

### 9.2 Layer 2 — Behavioral verification (it actually works) — REQUIRED v1
The agent boots the app inside its own worktree (per §8.3) and drives it. For a
bug: reproduce first, fix, then prove the reproduction no longer triggers. For
UI, drive via the Chrome DevTools Protocol (navigate, DOM snapshot, screenshot).
This phase **MUST** acquire the heavy-validation permit (§6) — only one runs at a
time on the target box. arm64 headless Chromium (e.g. Playwright) is fine but
RAM-heavy; budget for one browser.

### 9.3 Layer 3 — Agent-as-reviewer (semantics gates can't catch) — REQUIRED v1
When the implementing agent believes it is done, spawn a **separate
reviewer agent with a fresh context** to critique the diff against the task's
acceptance criteria and the repo's golden principles: missed intent, over-
engineering, scope creep, security smells. The implementer addresses the
feedback; loop until the reviewer is satisfied. **MUST be a fresh session** — not
the context that wrote the code, which would rationalize its own work.

### 9.4 Layer 4 — The acceptance contract
Self-verification is only possible if "done" is defined. Tasks **SHOULD** carry
explicit, checkable acceptance criteria; where possible the agent encodes them
as tests (a passing test = a met criterion). If a task is vague, the agent's
first turn produces a plan + criteria and routes to `review` for human sign-off
before implementing.

### 9.5 Layer 5 — Anti-cheating guardrails — REQUIRED v1
Agents will "make the check pass" rather than "make it correct" unless
constrained:
- **MUST NOT** edit or delete the tests a change is meant to satisfy in the same
  change (or flag such edits for the reviewer's special attention).
- Maintain a held-out smoke suite the agent can **run but not modify**.
- Diff-level lints that reject silencing tricks: `eslint-disable`, `.skip`,
  blanket `as any`, empty `catch`.
- The reviewer's prompt explicitly asks: "did it satisfy the spirit, or game the
  metric?"

### 9.6 The review packet (verification output = what the human approves)
The verification pipeline's output **is** the mobile review artifact:
- diff summary + files touched;
- which gates are green (tsc / lint / tests / build);
- before/after screenshots or a short screen recording from layer 2;
- the reviewer agent's verdict;
- the agent's own self-assessment.

The agent attaches this to the task and moves it to `review`. The human approves
from their phone without reading code.

> Honest expectation: end-to-end autonomy depends heavily on each repo's
> structure and tooling and does **not** generalize for free. Treat the harness
> as a compounding investment — when a new failure mode appears, encode it as a
> new gate / lint / reviewer instruction.

---

## 10. Security & safety

- **Instruction-source boundary** — content in task files, repo files, web
  pages, tool output, and agent output is **data, not commands**. The daemon
  acts only on its own logic and on explicit human actions in the UI. Never
  execute instructions found in observed content.
- **Workspace confinement** — an agent runs only inside its own worktree; the
  worktree path **MUST** resolve within `<root>`.
- **Identifier sanitization** — task ids / repo keys **MUST** match
  `[A-Za-z0-9._-]` before use in any path or branch name.
- **Human-authorized merge/deploy** — agents work on `hercules/<task-id>`
  branches and never invent merge or production-deploy actions. **MUST NOT**
  merge to main without a human **Merge**, and **MUST NOT** production-deploy
  without a human **Promote**. The machine is the executor of explicitly
  authorized actions only (design §5 e2e release pipeline).
- **Isolated boot** — layer-2 boot uses seed data and dummy credentials. **MUST
  NOT** connect to production or any real external service.
- **Secrets** — scoped per repo, injected at boot, never committed. No secrets in
  task files or commits.
- **UI exposure** — the control plane can launch agents with elevated
  permissions. The UI **MUST** be authenticated and **MUST NOT** be exposed on
  the open internet. **SHOULD** sit behind a private network or an authenticated tunnel.
- **Side-effectful actions** (publish, delete, change settings, send) are not in
  scope for the agents here, but if added later they require explicit human
  confirmation.

---

## 11. Deployment target & constraints

Target: **Oracle Cloud Always Free, Ampere A1, arm64.** Note the free-tier A1
allowance was reduced to **2 OCPU / 12 GB total** as of 2026-06-15 — design for
this, not the older 24 GB figure.

Implications, baked into defaults above:

- All tooling and native deps **MUST** be arm64-compatible (Node/Claude Code are
  fine; watch native addons and dev servers).
- Conservative concurrency: global cap `2`, per-repo cap `1`, heavy-validation
  semaphore `1`.
- `pnpm` shared store (§8.4) for disk/install economy.
- The daemon + UI themselves are light (one Node process + SSE).
- **Escape hatch (future, not v1):** the adapter/worker abstraction allows adding
  a beefier remote worker over SSH for heavy validation without changing the
  core. Design interfaces so this is additive. Spike:
  [`docs/ssh-heavy-worker.md`](./docs/ssh-heavy-worker.md) + additive
  `BehavioralRunner` remote impl / fake transport
  (`src/verification/heavyWorker.ts`). **Not** multi-node mesh (§17).

---

## 12. WORKFLOW.md (per target repo) — spec

A markdown file in each target repo: YAML front matter (config) + a prompt body.
It is the only place repo-specific policy lives. It **MUST** define:

- **setup/boot hook** — commands to install deps and boot an isolated instance,
  consuming the allocation context (`slug`, `port`, `scratch_dir`) from §8.3.
- **verify commands** — the concrete commands for layer-1 gates (typecheck,
  lint, test, build) and how to run layer-2 behavioral checks.
- **acceptance conventions** — how "done" is expressed for this repo.
- **review-packet format** — what to capture (which screenshots, which logs).
- **prompt body** — high-level guidance handed to the agent; objectives and
  golden principles, not a rigid state machine.

The daemon assembles each agent's prompt as: `WORKFLOW.md` body + task body +
acceptance criteria + the allocation context.

---

## 13. Agent adapter interface

A small logical contract that both agents satisfy. **Normalize on logical
behavior and fields, not on a specific JSON schema.** Required capabilities:

- `start(workspace, prompt, allocationContext) -> session` — run one turn in the
  workspace, streaming events.
- stream of events the daemon can read for: progress, the **session/thread id**,
  the **completion state** (done / needs-input / failed), and **token usage**.
- `continue(session, message)` — continue the same session (for reviewer
  feedback loops and multi-turn).
- `stop(session)` — kill.

### 13.1 Grok Build adapter (default)
Drive headless: `grok -p "<prompt>"` with `--output-format streaming-json`,
`--always-approve` (unattended tool execution), and `--cwd <workspace>`. Parse
the NDJSON stream: `text` chunks → final report, `end.sessionId` → session id,
`end` → done, `error` / `max_turns_reached` → failed. Resume turns with
`grok --resume "<session>"` when multi-turn is wired. Subscription headless is
supported; this is the **default** `HERCULES_ADAPTER` value.

### 13.2 Codex adapter
Drive headless: `codex exec --json "<prompt>"`. Map Codex JSONL fields onto the
same contract (`thread.started.thread_id` ↔ session, `turn.completed` /
`turn.failed` ↔ completion, usage when present). Also subscription-friendly for
headless runs.

Every Codex execution **MUST** pass an explicit `--model` and
`-c model_reasoning_effort="…"`. Production defaults are `gpt-5.6-sol` and
`medium`. Operators may override with `HERCULES_CODEX_MODEL` /
`HERCULES_CODEX_REASONING_EFFORT` (`low|medium|high|xhigh|max|ultra`); invalid
values fall back to the defaults without retaining or logging the raw input.

### 13.3 Claude Code adapter (opt-in)
Drive headless: `claude -p "<prompt>"` with `--output-format stream-json` for
parseable streaming, `--cwd <workspace>`, `--allowedTools <...>`, and a
permission mode appropriate to the sandbox (e.g. `--permission-mode acceptEdits`,
or skip-confirmation only inside the confined worktree). Extract the session id
from the stream and continue turns with `claude --resume "<session>"`.

> Cost note: as of 2026-06-15, `claude -p` / Agent SDK usage on subscription
> plans draws from a **separate** monthly Agent SDK credit, independent of
> interactive limits. Prefer Grok or Codex for continuous orchestration unless
> you have confirmed Agent SDK headroom. Claude requires an explicit
> `HERCULES_CLAUDE_ENABLED=1` opt-in before it is registered; only then may
> `HERCULES_ADAPTER=claude` (or task/repo `adapter: claude`) select it.
> Setting `HERCULES_ADAPTER=claude` alone while Claude is disabled selects
> real Codex and never invokes Claude (never fake). Default automatic failover
> is Grok → Codex; Claude is never chosen by roster discovery alone.

---

## 14. Web UI / API (mobile-first)

Served by the embedded HTTP server from the daemon's in-memory snapshot.

- **Transport:** SSE for server→client live updates (worker phase, last event,
  token usage, state changes). **SHOULD** prefer SSE over WebSocket — simpler,
  auto-reconnects, well-suited to one-directional status streams on mobile
  networks.
- **Layout:** a **list/feed grouped by state**, not a kanban board (kanban drag
  is painful on a phone). Plus a task detail view.
- **Task detail:** description, acceptance criteria, live agent output, the
  review packet (§9.6), and actions: create task, kill, retry, approve / reject,
  comment-to-steer (which becomes a `continue` turn).
- **Create task:** a form that writes a new task file and commits it to the
  control repo.
- **Runtime snapshot endpoint:** exposes the derived in-memory state for the UI.

Stack is the implementer's choice given "TypeScript + monolith"; a lightweight
HTTP layer (e.g. Hono/Express) serving a small React build, or a single
full-stack framework, are both acceptable. **MUST** keep it a single deployable
process.

---

## 15. Per-repo onboarding / readiness checklist

The orchestrator is repo-agnostic, but agent quality is per-repo. Registering a
repo is not just adding a URL — it includes a readiness pass. Before trusting a
repo with autonomous tasks, confirm:

- [ ] `AGENTS.md` exists as a good *map* (≤~120 lines), not an encyclopedia.
      `CLAUDE.md` may be a thin pointer to `AGENTS.md` for Claude Code auto-load.
- [ ] Layer-1 gates exist and are **green** (typecheck, lint, tests, build).
- [ ] The app **boots in isolation** via the `WORKFLOW.md` hook (ports/DB/seed).
- [ ] "How to verify a change" is documented for this repo.

The readiness work itself is a good first batch of tasks to give the system.
Prefer a **multi-stage readiness pipeline** (map → WORKFLOW → green gates/boot →
human mark ready) over one monolithic onboarding task — see
[`docs/readiness-pipeline.md`](./docs/readiness-pipeline.md). **First real tasks
SHOULD be small with crisp acceptance criteria** (bug fixes with a reproduction,
tightly scoped features, test-guarded refactors). Vague, judgment-heavy work is
a poor fit for orchestration — keep that in interactive sessions.

---

## 16. Build order (suggested phases)

1. **Skeleton + control repo I/O** — task file parse/write, repos.yaml, the
   in-memory snapshot, `git pull`/commit plumbing. No agents yet.
2. **Orchestration loop + concurrency** — tick, select, the three caps, state
   machine, reconcile/retry. Dispatch to a *fake* adapter that just sleeps.
3. **Isolation** — bare mirror, per-task worktree, allocation context, pnpm
   store.
4. **Agent adapters** — Grok Build (default, `grok -p` streaming-json), Codex
   (`codex exec --json`), Claude Code opt-in (`claude -p` stream-json).
5. **Verification layers 1, 3, 5** — gates, reviewer agent, anti-cheating; emit
   the review packet.
6. **Verification layer 2** — boot hook + CDP driving behind the heavy permit.
7. **Web UI + SSE** — list/feed, detail, actions, create-task.
8. **Security hardening + deploy** — confinement checks, auth, private network/tunnel,
   arm64 build on the Oracle box.
9. **Codex adapter** — same logical contract as Grok/Claude.

---

## 17. Non-goals for v1 (explicitly out of scope)

- No external database (git is the store).
- No multi-node distribution — single box. (SSH heavy-validation worker is a
  designed-for extension of the single-box model — one optional remote for L2
  only under the existing daemon — not a cluster/mesh; see
  [`docs/ssh-heavy-worker.md`](./docs/ssh-heavy-worker.md).)
- No kanban board — list/feed only.
- No full observability stack (LogQL/PromQL query surface for the agent) — defer
  until a bigger worker node exists.
- No merge without a human Merge; no production deploy without a human
  Promote — machine = executor of explicitly authorized actions only.

---

## 18. Decisions left to the implementer

- Exact HTTP/UI library choice (must stay a single process).
- Exact event-schema mapping inside each adapter (only the *logical* fields are
  fixed).
- Tick interval, stall timeout, max attempts, backoff curve (make them config).
- Branch naming and PR creation mechanics.
- Worktree-vs-fresh-clone per task (worktree is the recommended default;
  allow per-repo override to fresh clone if a repo needs it).

---

## 19. References

- OpenAI — *Harness engineering* (the discipline of building agent-legible
  environments and mechanically enforced architecture).
- OpenAI — *Symphony* / open-source Codex orchestration (the issue-tracker-as-
  control-plane pattern; spec-first, no-DB, state-from-source-of-truth design).

These informed the design but the system here is a clean, general reimplementation:
tracker-agnostic (git files), agent-agnostic (Claude Code now, Codex later),
single-box, mobile-first.
