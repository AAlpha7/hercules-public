---
# Per-repo policy for autonomous work in Hercules (SPEC §12).
# Read by the daemon from the trusted default branch — its gate commands are
# executed, so this file is policy, not a suggestion.
# Interactive agents: read AGENTS.md (map). This file is what Hercules injects.

setup:
  install:
    - pnpm install --frozen-lockfile
  # Layer 2 boot (SPEC §9.2): stand up an ISOLATED Hercules instance in fake-
  # adapter mode (so it never spawns real agents) on the allocated port, pointed
  # at a throwaway control repo in the scratch dir. One sh chain so prep
  # finishes before the server starts. `dist/` is already built by the gates.
  #
  # Control plane is seeded by scripts/l2-seed-control-fixture.mjs (NOT an empty
  # repos: {} plane). Empty ctrl forced agents to invent disabled placeholder
  # data-evidence hooks in src/ so assert sel= could pass — fixture eliminates
  # that pressure. Seed writes only under {scratch_dir}/ctrl; never production.
  #
  # HERCULES_WORK_DIR MUST be overridden to a scratch path: the boot subprocess
  # inherits the live daemon's env, and without the override the booted
  # instance's first tick ran reclaimOrphans against the PRODUCTION work root
  # and deleted every live worktree (2026-07-15/17 incident — the root cause of
  # "preserve: worktree missing" and the branch-contamination cascade).
  # HERCULES_SELF_UPDATE=0 and empty HERCULES_PUSH for the same reason: the
  # instance under test must not restart the real service or push branches.
  #
  # Docs browser L2 evidence needs a registered repo with a real bare mirror.
  # scripts/l2-seed-control-fixture.mjs seeds the control plane AND (when this
  # branch's script is present) a docs-capable demo repo + work/.mirrors entry.
  # Never in the production daemon startup path.
  boot:
    - >-
      node scripts/l2-seed-control-fixture.mjs {scratch_dir}/ctrl
      && env -u XAI_API_KEY -u GROK_API_KEY
      HERCULES_ADAPTER=fake HERCULES_FAKE_FAULT_INJECTION=1 HERCULES_L2_ISOLATED=1
      HERCULES_XAI_USE_CLI_TOKEN=0 HERCULES_TOKEN=demo
      HERCULES_PORT={port} HERCULES_WORK_DIR={scratch_dir}/work
      HERCULES_M7_L2_FIXTURE_PATH={scratch_dir}/work/m7-review-fixture.json
      HERCULES_SELF_UPDATE=0 HERCULES_PUSH=
      HERCULES_AUTO_DELETE_DAYS=0 HERCULES_WORKTREE_GC_DAYS=0
      node dist/src/main.js {scratch_dir}/ctrl
  health_check: curl -sf http://localhost:{port}/

# Layer 1 — mechanical gates (SPEC §9.1). Run in order, all must pass.
# Full suite only — autonomous work must not skip worktree/browser/probe.
# Humans mid-loop may use `pnpm check` (see AGENTS.md); claim-done = check:full.
#
# typecheck = real test-project tsc (root + src/web + test/web) plus structured
# esbuild transform diagnostics on test sources (duplicate keys, syntax recovery).
# Soft Vite/esbuild warnings must not leave L1 green. Same command for full
# verify, reverify, auto-rework, and Merge Selected.
gates:
  typecheck: pnpm typecheck
  lint: pnpm lint
  test: pnpm test
  build: pnpm build

# Layer 2 — behavioral verification (SPEC §9.2). Drive the booted web UI with a
# real browser and capture a screenshot for the review packet.
# auth_token MUST match HERCULES_TOKEN in setup.boot so L2 unlocks the SPA and
# captures post-auth chrome (bottom nav etc.) — not only the TokenGate shell.
# The generic evidence DSL is intentionally selector-only and cannot type a
# reason, create a concurrent stale projection, restart the provider, or compare
# geometry across viewports. `pnpm check:full` therefore also runs the durable
# `test/web/m7OutcomeReviewSmoke.test.ts` CDP proof through `test:spa-smoke`.
# `pnpm test:m7-browser-proof` is the focused repeatable entry point; set
# HERCULES_M7_L2_SCREENSHOTS_DIR to retain PNGs plus their hashed manifest.
behavioral:
  base_url: http://localhost:{port}/
  driver: cdp
  auth_token: demo
  auth_storage_key: hercules_token
  # Declarative L2 evidence (no label guessing). SPA must expose data-evidence=*.
  # Task body may override with a `## Evidence` section.
  # Hercules first-party Settings chrome is always present — critical path is
  # required (not optional). Other product repos may mark exploratory steps
  # optional: true; claimed data-evidence hooks in the task body still harden
  # to required via resolveEvidencePlan.
  evidence:
    - unlock
    - screenshot: shell
    - click: "[data-evidence=nav-settings]"
    - assert:
        selector: "[data-evidence=settings-panel]"
    - assert:
        text: "Settings|设置|Language|语言|Logout|退出"
    - screenshot: settings
    - click: "[data-evidence=nav-releases]"
    - assert:
        selector: "[data-evidence=releases-panel]"
    - assert:
        selector: "[data-evidence=promote-btn]"
    - screenshot: releases
    # Resilience fault-injection scene (seeded by l2-seed-control-fixture):
    # 3 die deaths + 4th task with adapter 降级 timeline + Death cause mini-packet.
    # Retroactive L2 proof for adapter-failover + agent-death-resilience.
    - click: "[data-evidence=nav-tasks]"
    - click: "[data-task-id=l2-fixture-00-resilience-failover]"
    - assert:
        selector: "[data-evidence=run-timeline]"
    - click: "[data-evidence=run-timeline-summary]"
    - assert:
        selector: "[data-evidence=adapter-failover-timeline]"
    - assert:
        text: "降级"
    - screenshot: adapter-failover-timeline
    # Death-cause mini-packet text + stable hook on the exit summary row
    # (human AC: timeline 降级说明 + 死因 mini-packet 清晰可读).
    - assert:
        selector: "[data-evidence=agent-death-cause]"
    - assert:
        text: "Death cause|xAI 502|mid-stream"
    - screenshot: agent-death-cause
    # M7 outcome review uses real scratch provider data and real controls.
    - click: "[data-evidence=task-detail-close]"
    - click: "[data-task-id=l2-m7-pass]"
    - click: "[data-evidence=review-mode-outcome]"
    - assert:
        selector: "[data-evidence=outcome-review]"
    - click: "[data-evidence=open-review-evidence]"
    - assert:
        selector: "[data-evidence=review-evidence-drawer]"
    - assert:
        selector: "[data-evidence=learning-proposal]"
    - screenshot: m7-pass-evidence-learning
    - click: "[data-evidence=task-detail-close]"
    - click: "[data-task-id=l2-m7-fail]"
    - click: "[data-evidence=review-mode-outcome]"
    - assert:
        selector: "[data-evidence=review-request-changes]"
    - screenshot: m7-verified-fail
    - click: "[data-evidence=task-detail-close]"
    - click: "[data-task-id=l2-m7-missing]"
    - click: "[data-evidence=review-mode-outcome]"
    - assert:
        selector: "[data-evidence=review-more-evidence]"
    - screenshot: m7-missing-evidence
    - click: "[data-evidence=task-detail-close]"
    - click: "[data-task-id=l2-m7-human]"
    - click: "[data-evidence=review-mode-outcome]"
    - click: "[data-evidence=review-open-approve]"
    - assert:
        selector: "[data-evidence=review-risk-acknowledgement]"
    - assert:
        text: "Approval is not merge or deployment"
    - screenshot: m7-human-confirmation
  capture:
    - screenshot
  smoke_flows:
    - unlock with demo token; open [data-evidence=nav-settings]; assert settings-panel
    - open [data-evidence=nav-releases]; assert releases-panel and promote-btn
    - open resilience failover fixture; assert 降级 timeline + Death cause mini-packet
    - open M7 scratch fixtures; prove pass/evidence/learning, verified fail, missing evidence, and human confirmation
    - run the M7 browser proof for mobile/desktop parity, safe-area geometry, stale 409, request-changes history, and durable restart

# Layer 5 — held-out suite the agent may RUN but MUST NOT modify (§9.5 / G2).
# Invariants are structural policy: anti-cheat scan flags protected_path edits.
held_out_smoke: pnpm exec vitest run test/invariants --config vitest.unit.config.ts
protected_paths:
  - test/invariants/**
  # Deploy scripts are release policy — agents must not quietly edit them (design §5).
  - scripts/deploy-staging.sh
  - scripts/deploy-production.sh
  # Executable policy (gates/boot/protected paths) and the agent map are human-only
  # (acceptance-binding-grammar §5): an agent editing the gate it is judged by is
  # self-referential verification.
  - WORKFLOW.md
  - AGENTS.md

# Release deploy (design §2 / §4). First concrete landing for Hercules self-hosting.
# Staging = persistent hercules-staging unit (port 8788, fake adapter, own work dir).
# Production = pin checkout to verified sha then restart (generalized self-update).
deploy:
  staging:
    command: ./scripts/deploy-staging.sh
    health: curl -sf http://localhost:8788/
    url: http://localhost:8788/
    # Daemon env var holding the staging UI token (secrets never live here).
    auth_token_env: STAGING_UI_TOKEN
    auth_storage_key: hercules_token
    verify:
      - unlock
      - assert: { selector: "[data-evidence=bottom-nav]" }
      - screenshot: shell
      - click: "[data-evidence=nav-tasks]"
      - assert: { selector: "[data-evidence=task-list]" }
      - screenshot: tasks
      - click: "[data-evidence=nav-chat]"
      - assert: { selector: "[data-evidence=sessions-list]" }
      - screenshot: sessions
      - click: "[data-evidence=nav-releases]"
      # Loaded = rows/digest, a real empty state, or a surfaced load error.
      - assert: { selector: "[data-evidence=releases-digest],[data-evidence=releases-empty],[data-evidence=releases-load-error],[data-evidence=release-packet],[data-evidence=releases-drift]" }
      - screenshot: releases
      - click: "[data-evidence=nav-settings]"
      - assert: { selector: "[data-evidence=settings-panel]" }
      - screenshot: settings
  production:
    command: ./scripts/deploy-production.sh <sha>
    health: curl -sf http://localhost:8787/
    smoke: curl -sf http://localhost:8787/
---

# Working in Hercules — agent guidance

Map (conventions, layout, quality speeds): **`AGENTS.md`**. Design why: **`SPEC.md`**.
Keep changes small and well-scoped. This file is the **executable** policy Hercules
runs and injects — do not treat gate commands as optional.

## Golden principles (non-negotiable)
- **Layering:** `src/domain/` is pure — no IO, git, fs, or network, and it must
  not import from outer layers (ESLint enforces this). Share types via `domain/`.
- **Safety chokepoint:** any id/key that becomes a path or branch goes through
  `isValidIdentifier` (SPEC §10).
- **No silencing:** no `any`, no empty `catch`, no `eslint-disable`, `.skip`,
  `@ts-ignore`, or `as any` to make a gate pass. Errors are typed subclasses.
- **TDD:** write the failing test first (`test/**` mirrors `src/**`), watch it
  fail, then implement. Git tests use real temp repos, not mocks.
- **Regression:** a bug fix needs a test or invariant that would have failed
  before the fix (`test/invariants/`, adapter contracts).

## How "done" is defined
Acceptance criteria hold, and the four gates above are green (`pnpm check:full`).
Encode new behavior as a passing test.

## Boundaries
- Work only inside your worktree, on branch `hercules/<task-id>`. Never merge.
- Do not weaken or delete tests to make checks pass.
- If the task is ambiguous, propose a plan + acceptance criteria rather than guess.
- Implement-class Grok mutates via H MCP tools `hercules_workspace__apply_patch`
  and `hercules_workspace__delete_file` (workspace-confined; not Grok built-ins).
  Coding runs fail closed if `run_terminal_command` (shell) is advertised — no
  general shell. Do not use tests to mutate repository source merely so the
  post-test Git diff looks like a successful deletion.

## L2 evidence contract (declarative)
UI chrome that L2 must prove must expose **stable** `data-evidence="…"` attributes
(not Chinese/English button labels). Declare steps in task body when the default
WORKFLOW plan is not enough:

```markdown
## Evidence
- unlock
- screenshot shell
- click [data-evidence=nav-settings]
- assert sel=[data-evidence=settings-panel]
- assert text=Language|语言
- screenshot settings-sheet
```

**Critical vs optional:** if the task body (DoD / feature list) *claims*
`data-evidence=…` hooks, matching click/assert steps are **required** even when
marked `optional: true`. Use optional only for exploratory chrome the task never
promised. Prefer selectors over button labels.
