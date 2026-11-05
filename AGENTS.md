# Hercules — agent map

> **Canonical map** for all coding agents (Grok, Codex, Claude Code, …).
> Keep this file short. Details → `SPEC.md`. Executable policy → `WORKFLOW.md`.
> **Budget: ≤ 120 lines** (enforced by `test/invariants/agent-map.test.ts`).

**Invariant:** every open, unblocked task gets exactly one agent in an isolated
worktree; the agent verifies its work before a human reviews it.

## Read order

1. **This file** — map + constraints  
2. **`WORKFLOW.md`** — gates/boot Hercules *executes* and injects into prompts  
3. **`SPEC.md`** — design why (on demand, not every turn)

Deploy: **`docs/deploy.md`**. Incomplete-repo onboarding: **`docs/readiness-pipeline.md`**.
Per-repo sandbox/network/env policy: **`docs/repo-execution-policy.md`**.
Do not duplicate SPEC or README here. Link out.

## Layout (dependency direction is mechanical except named exceptions)

```
src/domain/         pure types + logic — NO io/git/fs/network; no outer imports
src/control/        control-repo I/O (tasks/*.md, repos.yaml, snapshot, git)
src/orchestrator/   tick loop, caps, actions, adapter contract, verifier wiring
src/isolation/      bare mirrors, per-task worktrees, ports
src/sessions/ + mcp/ Remote Control store + workspace mutation MCP
src/adapters/       grok (default) · codex · claude (opt-in) · cursor
src/verification/   L1 gates · L2 browser · L3 reviewer (opt-in) · L5 anti-cheat · packet
src/server/ + web/  Hono API + SSE + mobile SPA (web has its own tsconfig)
src/main.ts         composition root (HERCULES_ADAPTER selects backend)
```

- **`domain/` purity** — ESLint `no-restricted-imports` (not prose).
- **`PATH_LEASE_PROCESS_PROBE`** — named exception (`isolation/taskPathLeaseStore`
  → `adapters/processTree` for lease-owner OS liveness). Do not invert or move it.
- **Path/branch safety** — every id/key through `isValidIdentifier` (`domain/task.ts`). Share types via `domain/`, not outer layers.

## Conventions
- TypeScript ESM (`NodeNext`), `strict` + `noUncheckedIndexedAccess` +
  `exactOptionalPropertyTypes`. Local imports use the `.js` extension.
- Typed error subclasses at module boundaries — no bare `throw new Error`.
- No `any`, empty `catch`, `eslint-disable`, `.skip`, `@ts-ignore` (also scanned
  by `test/invariants/no-silencing.test.ts` + L5 anti-cheat).

## Quality (two speeds)

| When | Command |
|------|---------|
| Mid-loop | `pnpm check` or `pnpm test:unit` / `test:watch` |
| Before push / "done" | `pnpm check:full` (typecheck + lint + **all** tests + build) |

- CI runs full gates. Autonomous Hercules tasks run full `pnpm test` via WORKFLOW.
- **Regression rule:** a bug fix is incomplete without a test or invariant that
  would have failed before the fix (`test/invariants/`, adapter contracts).
- TDD: failing test first; `test/**` mirrors `src/**`. Real temp repos for git.
- **Web UI:** new interactive decision paths need true render tests under
  `test/web/render/` (jsdom + Testing Library; assert request payloads via
  mocked `api`). Source-text (`readFile` + `toMatch`) only for hook/constant
  existence — never as a substitute for click→request coverage. **Never** add
  placeholder/disabled UI only so L2 `assert` finds a selector — evidence must
  target real chrome (or real empty-state hooks); seed fixtures when needed.

## Runtime knobs (live)

| Knob | Meaning |
|------|---------|
| `HERCULES_ADAPTER` | **Daemon default** (`grok` / `codex` / `claude` / `cursor` / `fake`) — restart to change |
| `HERCULES_CODEX_MODEL` / `HERCULES_CODEX_REASONING_EFFORT` | Codex pin (default `gpt-5.6-sol` / `medium`) |
| `HERCULES_CLAUDE_ENABLED=1` | Register Claude compatibility adapter (default off) |
| `repos.yaml` → `adapter:` | **Per-repo** override (Repos UI; next dispatch) |
| task front matter `adapter:` | **Per-task** override (create form / task detail; next dispatch) |

Precedence: **task > repo > daemon**. Soft adapter change mid-run does **not** kill
the live process (next dispatch). **Switch now** stops the live agent, clears
session, re-queues as `retrying` on the same worktree. Multi-step pipelines =
`POST /api/pipelines` (blocked_by chain + per-stage adapter).

Also: `HERCULES_TOKEN`, `HERCULES_PORT`, `HERCULES_WORK_DIR`, `HERCULES_PUSH=1`,
`HERCULES_STALL_TIMEOUT_MS` (idle stream; default 10m), `HERCULES_MAX_RUN_MS` (hard
cap; default 2h; processAlive skips idle stall during long cargo/pnpm),
`HERCULES_ADAPTER_FAILOVER=0` (disable provider failover on agent_exit streak),
`HERCULES_FAKE_FAULT_INJECTION=1` (L2 isolation only; fake_behavior scripts).

Start: `pnpm build && pnpm start <control-repo-dir>`. Token on stderr (not URL).

## Control plane (facts)

- Task file = task (`tasks/<id>.md`); git history = audit log.
- Snapshot is **derived** each tick, never persisted.
- Mutation unit: validate state machine → write file → commit.
- WORKFLOW for gates/boot/protected-paths is read from the **trusted mirror
  default branch**, never the agent worktree. WORKFLOW.md/AGENTS.md are protected (human-only).

## L2 control fixture

L2 isolation boots a **seeded** scratch control plane via WORKFLOW
`setup.boot` → `node scripts/l2-seed-control-fixture.mjs {scratch_dir}/ctrl`
(before the fake-adapter instance starts). That plane has repos +
review/done/failed/todo tasks so Decide / Mark ready chrome is real.
Seed writes **only** under the scratch ctrl path — never production work
roots or live control repos. Isolation knobs: `HERCULES_ADAPTER=fake`,
`HERCULES_FAKE_FAULT_INJECTION=1`, scratch work dir, no self-update/push.

Fixture **data** never enters production binaries — only `scripts/` + WORKFLOW
boot. L1 gates still read WORKFLOW from the **trusted** default branch (a task
cannot rewrite its own gates; self-edited WORKFLOW L2 is unproven until merge).

**Never** add placeholder/`disabled` elements in `src/` just to pass
`assert sel=` / `data-evidence`. Need a new UI scene? Extend
`scripts/l2-seed-control-fixture.mjs` (tag titles `[L2 fixture]`). Real
interactive hooks on live chrome (e.g. `data-evidence=task-card` on a real
TaskCard) are fine; disabled fake hosts are not.

## Tooling

pnpm via corepack (`packageManager` in package.json). Prefer `~/.local/bin` on `PATH`.
## Sandbox
Host-boundary tests need real `/usr/bin/bwrap` and `skipIf` when it is missing.
