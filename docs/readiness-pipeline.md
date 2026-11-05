# Readiness pipeline — multi-stage SPEC §15 onboarding

Registering a repo is more than adding a URL. Before trusting it with autonomous
work, Hercules expects a **readiness pass** (SPEC §15). Heavy repos (Rust,
monorepos, broken baselines) should **not** be one giant onboarding task — free-tier
agents thrash when AGENTS + WORKFLOW + green gates + boot all sit in one DoD.

This document is the **operator playbook**. The domain helper
`draftReadinessPipeline(repoKey)` encodes the same stages for the UI and API.

## When to use what

| Path | Use when |
|------|----------|
| **4-stage readiness pipeline** (recommended) | Heavy stacks, incomplete baseline, long install/boot |
| **Single onboarding task** (`draftOnboardingPlan`) | Tiny docs-only or already-green Node repos |

Both paths label tasks `onboarding` + `readiness` so they **dispatch while
`readiness: incomplete`**. Normal feature work stays blocked until a human
marks the repo **ready** in Repos.

## The four stages (R1 → R4)

Linear `blocked_by` chain via `POST /api/pipelines`. Default id prefix:
`{repo}-ready` → tasks `{repo}-ready-1` … `{repo}-ready-4`.

| Stage | Title focus | Agent may | Agent must not |
|-------|-------------|-----------|----------------|
| **R1** | AGENTS.md map + thin CLAUDE.md | Write short map (≤~120 lines), CLAUDE pointer | Chase green CI or full WORKFLOW |
| **R2** | WORKFLOW install/boot/gates | Install WORKFLOW from template; declare gates/boot | Require all gates green if baseline is broken |
| **R3** | Prove L1 green + isolated boot | Fix what blocks gates/boot | Drive-by refactors; flip `readiness` |
| **R4** | Human checklist + mark ready | Soft checklist, docs polish, suggest first tasks | Auto-mark repo ready — **human only** |

Stage bodies live in code (`src/domain/onboarding.ts`) and as copy-paste
samples under [`examples/readiness-pipeline/`](../examples/readiness-pipeline/).

## Operator: create without tribal knowledge

### Phone UI (preferred)

1. **Repos** → select the incomplete repo.
2. Optionally **Check readiness** (soft SPEC §15 score; never flips ready).
3. **Start onboarding** → creates the **4-stage pipeline** (R1–R4) with
   `onboarding`/`readiness` labels on every stage.
4. Approve / let agents run stage 1; each later stage unblocks when the previous
   is terminal (`done` / `failed` / … — same rules as any pipeline).
5. When R4 is in review and you trust the harness: **Mark ready** on the repo.

If an onboarding task or pipeline stage is already open, the panel shows it and
blocks a second create (open the existing task instead).

### API

```bash
# Build stages from the same draft the UI uses (Node one-liner against a
# checkout), or paste from examples/readiness-pipeline/api-example.json.

curl -sS -X POST "$HERCULES_URL/api/pipelines" \
  -H "Authorization: Bearer $HERCULES_TOKEN" \
  -H "Content-Type: application/json" \
  -d @examples/readiness-pipeline/api-example.json
```

Minimal shape:

```json
{
  "repo": "orbit",
  "title": "orbit readiness",
  "idPrefix": "orbit-ready",
  "priority": 20,
  "stages": [
    {
      "title": "R1: AGENTS.md map + thin CLAUDE.md",
      "body": "…",
      "labels": ["onboarding", "readiness"]
    },
    { "title": "R2: …", "body": "…", "labels": ["onboarding", "readiness"] },
    { "title": "R3: …", "body": "…", "labels": ["onboarding", "readiness"] },
    { "title": "R4: …", "body": "…", "labels": ["onboarding", "readiness"] }
  ]
}
```

### New task sheet

- **Pipeline** mode → **Fill readiness pipeline** (incomplete repos) seeds the
  four stages.
- **Task** mode → **Fill onboarding checklist** still fills the single-task body
  for light onboardings.

### `dependencyMode` on create / `blocked_by`

Task create (`POST /api/tasks`) and pipeline stages accept optional
`dependencyMode` (`dependency_mode` in front matter):

| Value | Meaning |
|-------|---------|
| `gate_merge` | Dependent waits until the blocker is **merged** onto the trusted default (`merged_via=gate` + ancestry for local CLI; observed factory merge for Cursor Cloud). Approve / `done` alone is not enough. |
| `completion_only` | Dependent waits until the blocker reaches **`done`** (no merge/ancestry proof). |

**Defaults when unset:** inferred per edge — same-repo `implement` / `verify` /
`host_operation` / `deploy` → `gate_merge`; explore, cross-repo, and
`onboarding`/`readiness`/`pipeline` labelled work → `completion_only`. Explicit
`completion_only` cannot bypass gate_merge for same-repo code consumers
(except readiness/onboarding/pipeline labels).

`/api/state.holds` surfaces the wait as:

- `dependency_gate_merge` — waiting on Merge Selected / ancestry
- `dependency_completion` — waiting on done state

Readiness pipelines intentionally use completion-only semantics so R3 can
follow an operator-merged R2 without a manual `merged_via=gate` re-stamp.

## Incomplete → ready (G8)

| `repos.yaml` readiness | What may dispatch |
|------------------------|-------------------|
| `incomplete` (default for new repos) | Only tasks labeled `onboarding` or `readiness` |
| `ready` | Full autonomous queue |

Marking ready is always a **human** decision (Repos → Mark ready / edit form).
Soft SPEC checklist (`GET /api/repos/:key/readiness-check`) is advisory for
compatible repos. Repos with `execution_policy.profile: guardian` also get a
**hard B-022 readiness receipt** on that endpoint; mark-ready / ready config
edits fail closed server-side when any required control is red, and `forceReady`
cannot bypass it. The receipt is bound to the trusted default-branch revision,
WORKFLOW digest, effective-policy digest, a clean runtime build containing the
merged B-022 controls, and an actual isolated CLI-evidence run. A declaration
without a passing run is red. On restart/tick, a stale or unsafe persisted
`ready` Guardian repo is downgraded to `incomplete` before scheduling. A green
receipt is harness-readiness only (not merge, deploy, promotion, live data, or
Guardian registration).

When a trusted CLI plan exists, readiness first runs the trusted WORKFLOW
`build` gate in a fresh worktree pinned to the exact default revision. Only a
successful build may proceed to the isolated, network-off, argv-only CLI plan.
Both phases use the same enforced repository sandbox and are cancelled on
daemon shutdown; cancellation is not cached as a readiness verdict.
The revision and ordinary git cleanliness are checked before build, after
build, and after CLI execution. Ignored build artifacts are allowed; tracked or
untracked mutations fail closed. A missing/failed build or workspace drift is
reported without persisting command output or environment values.

The combined build + isolated CLI result uses a process-local 64-entry LRU keyed by repo,
trusted revision, WORKFLOW/plan digests, build-command digest, and effective-policy digest.
This prevents every scheduler tick from rebuilding the same evidence workload. Build
capability and daemon-lease controls are rebuilt for every receipt rather than
copied from the cache. Failures are cached too; a human-triggered
readiness check explicitly retries, while revision, WORKFLOW, or policy changes
select a new key. Restarting the daemon starts with an empty cache.

## CLI-only repositories

Not every repo has a browser UI. Soft SPEC checklist still requires some
behavioral declaration before mark-ready, but that may be either:

| Mechanism | WORKFLOW field | Soft checklist | Guardian B-022 hard gate |
|-----------|----------------|----------------|--------------------------|
| Browser L2 | `behavioral:` (`base_url` + evidence steps) | Declaration is enough | N/A for CLI-only |
| Trusted CLI | `cli_evidence:` (argv-only plan, version 1) | Valid plan declaration is enough | **Verified isolated run** on the trusted default revision |

Rules of thumb:

- A CLI-only repo with gates + valid `cli_evidence` (and no browser block) can
  pass the soft behavioral check without inventing a fake `base_url`.
- Invalid `cli_evidence`, task-body argv, or prose alone never counts.
- Guardian hard readiness stays red until the isolated CLI execution status is
  `verified`. Soft green does **not** bypass B-022.
- When the trusted default branch is reachable and WORKFLOW is missing/empty,
  CLI evidence is classified **`cli_evidence_absent`** (actionable WORKFLOW
  remediation) — not `cli_evidence_unknown` (reserved for true probe failures).
- After the canonical WORKFLOW update lands, use the explicit readiness
  re-probe (`retry_cli=1` in the API); do not substitute `forceReady` for the
  isolated execution receipt.

### `cli_evidence` step `artifacts_dir` (UI / media pickup)

A step may declare `artifacts_dir` — a **workspace-relative** subdirectory
(not `.`, not absolute, no `..`) where the step writes media after it runs.
Hercules collects regular files with extensions `png|jpg|jpeg|webp|webm|mp4`
(case-insensitive) after the step finishes (pass, fail, or timeout):

| Rule | Value |
|------|-------|
| Cap | ≤ 24 files and ≤ 25 MB total per step; each file ≤ 10 MB |
| Symlinks | Never followed; a symlinked `artifacts_dir` or entry is skipped |
| Served name | `cli-<stepId>-<sanitizedBasename>` under `<screenshotsRoot>/<taskId>/` |
| Receipt | `artifacts: { name, kind: image\|video, bytes, sha256 }[]`; optional `artifactsSkipped` note |
| Packet / sheet | One `- ✅/❌ cli <stepId>` line per artifact, then `![evidence](…)` or `[video: name](…)`; basenames also join `packet.screenshots` so C3 evidence intake stages them like L2 shots |
| Route | `GET /api/tasks/:id/screenshots/:name` serves those types with `Accept-Ranges: bytes` (Range → 206) so `<video>` can seek |

Missing `artifacts_dir` keeps today's stdout/stderr-only behaviour. Example:

```yaml
cli_evidence:
  version: 1
  steps:
    - id: web-console-flow
      argv: [cargo, test, --test, web_console_flow]
      artifacts_dir: target/hercules-ui-evidence
      expect: { exit_code: 0 }
```

## What a task body can and cannot ask the executor to do

The executor runs inside an isolated worktree of the task branch with **no
interactive shell of its own**: instructions such as `git fetch origin x`,
`cp ../other-repo/...` or "base this on branch X" cannot be executed by the
agent and produce an empty diff. Write the task so the change is expressible
from the checked-out tree alone:

| Need | Pattern that works |
|------|--------------------|
| Start from another branch | Create the task with `salvageSourceTask` / a fork from that task, or set the task branch's base explicitly at creation — never a `git` instruction in the body |
| Copy files from elsewhere | Put a read-only draft checkout on the host (e.g. `/home/ubuntu/hercules-drafts-<name>`), reference the paths, and instruct "copy the content of `<path>` into `<file>`" — the agent reads and writes files, it does not run shell. Say "copy the file contents — never symlink": a diff that adds or turns a file into a symlink whose target lies outside the worktree fails closed as `symlink-escape` (2026-09-09: an executor "copied" 13 files by absolute link and every test in them read as removed) |
| Run a command as proof | Declare it as a `cli_evidence` step (argv-only, sandboxed) — the step's stdout/artifacts land in the packet. `timeout_ms` per step ≤ 20 min and the sum over the plan ≤ 60 min (a larger value makes the whole WORKFLOW.md fail to parse). Verification always reads WORKFLOW.md from the repo's default branch, never from the task branch — a candidate cannot change its own gates |
| Verify an existing origin tip (a branch or commit that was finished elsewhere) | Create the task with `executionClass: "verify"` and `seedFromRef: "<origin branch>"` (or a full SHA that is the current tip of an origin branch — presence is proven by `ls-remote`, never by a cached object). The ref is resolved on origin at create time (unknown refs are refused), the task branch is seeded from that exact commit at first provision, the agent runs read-only, and L1/L2/L3/L5 judge the seeded diff against the default branch — no agent copies files. Not combinable with `blockedBy` (a gated task must start at the main tip). The task file carries `seed_from_sha`; approve/merge work as usual (C3.43) |

The dependency field `dependencyMode` has two values: `gate_merge` (the
dependent waits for the blocker to be **merged**) and `completion_only` (waits
for the blocker to reach `done`). Resolution rule (`src/domain/dependencyGate.ts`):
an explicit `gate_merge` always wins; a same-repo `implement` / `verify` /
host-mutating dependent is **forced** to `gate_merge` (fail closed — it cannot
opt out); readiness-pipeline stages, `explore` tasks and every cross-repo edge
default to `completion_only`. A blocked task shows the reason on
`/api/state.holds`.

## After ready

Prefer small first tasks: bug with repro, tight feature, test-guarded refactor.
Vague judgment-heavy work stays in interactive Remote Control sessions.

## `dependencyMode` on task / pipeline create

Stage chains and ordinary `blocked_by` edges honor an optional `dependencyMode`:

| Value | Meaning |
|-------|---------|
| `gate_merge` | Wait until upstream is `done` **and** Merge Selected (`merged_via=gate` + ancestry on trusted default) |
| `completion_only` | Wait until upstream reaches `done` only |

**Defaults when unset** (same inference as SPEC §5):

- Same-repo `implement` / `verify` / `host_operation` / `deploy` → `gate_merge`
- `explore`, cross-repo, or `onboarding` / `readiness` / pipeline-labeled work → `completion_only`

Readiness pipelines therefore unblock stage N+1 when stage N is `done` without requiring Hercules Merge Selected. Same-repo implement dependents still wait for gate merge.

Hold codes on `/api/state.holds` (and SSE) distinguish the two:

- `dependency_gate_merge` — at least one unsatisfied edge is gate-merge mode or `awaiting_merge`
- `dependency_completion` — otherwise (completion-only waits)

Both keep `waitingOn: string[]` of upstream task ids.

## Related

- SPEC §15 — checklist intent
- `WORKFLOW.template.md` — copy into target repos at R2
- `src/domain/onboarding.ts` — `draftReadinessPipeline` / `draftOnboardingPlan`
- `docs/deploy.md` — control repo + phone access
- Backlog: orbit re-onboard is a **consumer** of this pattern, not this doc
