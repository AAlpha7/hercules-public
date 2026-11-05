<!--
  WORKFLOW.md — per-repo policy template (companion to SPEC.md §12)

  Copy this file into the ROOT of each target repo as `WORKFLOW.md` and fill in
  every <ANGLE-BRACKET> placeholder. Example commands use pnpm/Node — adjust to
  your stack.

  Onboarding: install this file at readiness stage R2 (after AGENTS.md map at R1).
  Full multi-stage pattern: docs/readiness-pipeline.md (Hercules repo).

  How the daemon uses this file:
    • FRONT MATTER (YAML)  = machine-read config (commands + hooks the runner executes).
    • BODY (markdown)      = the prompt prepended to every task in this repo.
    • The daemon assembles each agent prompt as:
          this body  +  the task description  +  the task's acceptance criteria
    • All commands run with the task's git worktree as the working directory.
    • These template variables are substituted before any command runs
      (the allocation context, SPEC.md §8.3):
          {slug}         unique id for this worktree
          {port}         allocated port (base) — use it so booted apps don't collide
          {scratch_dir}  per-worktree writable temp dir (put the ephemeral .env / DB here)
-->
---
# ─────────────────────────────────────────────────────────────────────────────
# Setup & isolated boot   (SPEC.md §8.3, §9.2)
# Runs inside this task's own worktree. MUST stand up an ISOLATED instance —
# unique port, ephemeral DB/schema, seed/dummy data only. MUST NOT touch
# production or any shared/real external service.
# ─────────────────────────────────────────────────────────────────────────────
setup:
  install:
    - <e.g. pnpm install --frozen-lockfile>
  boot:
    - <e.g. cp .env.example {scratch_dir}/.env>
    - <e.g. echo "PORT={port}" >> {scratch_dir}/.env>
    - <e.g. echo "DATABASE_URL=sqlite:{scratch_dir}/dev-{slug}.db" >> {scratch_dir}/.env>
    - <e.g. pnpm db:migrate>          # against the ephemeral DB
    - <e.g. pnpm db:seed>             # dummy/seed data ONLY
    - <e.g. pnpm dev --port {port} &> # boot in background
  # A command that succeeds only once the app is ready (the runner polls it):
  health_check: <e.g. curl -sf http://localhost:{port}/health>
  teardown:
    - <e.g. kill the dev server, drop the ephemeral db, clean {scratch_dir}>

# ─────────────────────────────────────────────────────────────────────────────
# Layer 1 — mechanical gates   (SPEC.md §9.1)
# Run in order; ALL must pass. Failure output is fed back to the agent verbatim,
# so prefer tools whose error messages explain how to fix the problem.
# ─────────────────────────────────────────────────────────────────────────────
gates:
  typecheck: <e.g. pnpm tsc --noEmit>
  lint:      <e.g. pnpm lint>
  test:      <e.g. pnpm test>
  build:     <e.g. pnpm build>

# ─────────────────────────────────────────────────────────────────────────────
# Layer 2 — behavioral verification   (SPEC.md §9.2)
# Drive the booted app. Runs behind the heavy-validation permit (one at a time).
# ─────────────────────────────────────────────────────────────────────────────
behavioral:
  base_url: <e.g. http://localhost:{port}>
  driver: cdp                 # Chrome DevTools Protocol (e.g. Playwright, arm64)
  # auth_token: demo          # if SPA needs login; must match boot HERCULES_TOKEN
  # auth_storage_key: hercules_token
  capture:                    # evidence to put in the review packet
    - screenshot
    # - video
  smoke_flows:                # free-form hints for what the agent should exercise
    - <e.g. "load /, sign in as the seed user, run the core flow under test">

# ─────────────────────────────────────────────────────────────────────────────
# Layer 5 — anti-cheating   (SPEC.md §9.5)
# A smoke suite the agent may RUN but MUST NOT modify, plus paths it must not
# edit in a change meant to satisfy them (the reviewer flags any such edits).
# ─────────────────────────────────────────────────────────────────────────────
held_out_smoke: <e.g. pnpm test:smoke>
protected_paths:
  - <e.g. test/smoke/**>

# ─────────────────────────────────────────────────────────────────────────────
# Review packet   (SPEC.md §9.6) — what to assemble for mobile review.
# ─────────────────────────────────────────────────────────────────────────────
review_packet:
  include:
    - diff_summary
    - files_touched
    - gate_results
    - screenshots
    - reviewer_verdict
    - self_assessment

# ─────────────────────────────────────────────────────────────────────────────
# Deploy — release pipeline policy (optional)
#
# Absent entirely → the daemon does nothing (repos without deploy are
# unaffected). When present, parsed ONLY from the trusted mirror default
# branch (same chokepoint as gates) — never from an agent worktree.
#
# Deploy children run with scrubbed env (scrubHerculesEnv). The 2026-07-17
# env-inheritance incident is a design constraint: a child must NOT inherit
# production HERCULES_* / tokens / work dirs by accident.
#
# Staging isolation requirements (MUST):
#   • own work dir / control-repo copy (never the production control plane)
#   • own port + token
#   • HERCULES_ADAPTER=fake (never spawn real agents from staging)
#   • HERCULES_PUSH empty; HERCULES_SELF_UPDATE=0 when applicable
#   • scrubbed env at spawn (no production env bleed-through)
#
# `staging.verify` reuses the L2 evidence DSL (unlock | click | assert |
# screenshot) — same parser as behavioral.evidence / task ## Evidence.
# Put deploy scripts on protected_paths so agents cannot quietly edit them.
# ─────────────────────────────────────────────────────────────────────────────
# deploy:
#   staging:
#     command: <e.g. ./scripts/deploy-staging.sh>
#     health:  <e.g. curl -sf http://localhost:8788/>
#     url:     <e.g. http://<host>:8788/>   # opened from the phone Releases panel
#     verify:                               # release-level E2E (optional)
#       - unlock
#       - screenshot: shell
#       - click: "[data-evidence=nav-settings]"
#       - assert: { selector: "[data-evidence=settings-panel]" }
#   production:
#     command: <e.g. ./scripts/deploy-production.sh <sha>>
#     health:  <e.g. curl -sf http://localhost:8787/>
#     smoke:   <e.g. read-only post-deploy smoke command>
---

# Working in <REPO NAME> — agent guidance

> Policy for autonomous work in this repository. Prepended to every task prompt.
> Keep it high-level — objectives and principles, not a rigid script. You are
> trusted to solve the problem; use the tools and context provided.

## What this repo is
<1–3 sentences: what the app does, the stack, where the main entry points are.
Point to AGENTS.md for the map (CLAUDE.md may be a thin pointer) — do NOT
duplicate it here.>

## Golden principles (non-negotiable)
- <e.g. dependency direction: domain layer must not import from web/infra>
- <e.g. all new code is tested; public functions are typed; no `any`>
- <e.g. structured logging only; no stray console.log in committed code>
- <e.g. keep files under N lines; prefer composition over inheritance>
- <add the rules that, if violated, make you reject a change>

## How "done" is defined here
<How acceptance criteria are expressed for this repo. e.g. "Each task's
acceptance criteria must be encoded as a passing test before it goes to review.">

## How to verify your work (commands live in the front matter above)
1. Make the change on your worktree branch only (`hercules/<task-id>`).
2. Run all gates; fix until green. Read the error text — it tells you how to fix.
3. Boot the app and exercise the smoke flows; capture before/after evidence for
   anything user-visible.
4. When you believe it is correct, a fresh reviewer agent will critique your
   diff. Address its feedback and loop until it is satisfied.
5. Assemble the review packet and move the task to `review`. Do NOT merge.

## Boundaries
- Work only inside your own worktree, on branch `hercules/<task-id>`.
- Never push to the default/protected branch; never merge. Output is a branch/PR.
- Never connect to production or real external services — boot is isolated with
  seed/dummy data only.
- Do not weaken or delete tests to make checks pass. Do not add `eslint-disable`,
  `.skip`, blanket `as any`, or empty `catch` to silence a gate.
- If the task is ambiguous or needs product judgment, do not guess: propose a
  plan + acceptance criteria and move the task to `review` for human sign-off
  before implementing.
