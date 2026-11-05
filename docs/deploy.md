# Deploy runbook — single box (live shape)

How Hercules is meant to run on one machine. Matches the current production-ish
layout on this host; copy the pattern, not necessarily the paths.

## Layout

| Path | Role |
|------|------|
| `/home/ubuntu/projects/Hercules` | Code checkout (`WorkingDirectory`, `dist/`) |
| `/home/ubuntu/hercules-live` | **Control repo** (tasks + repos.yaml; git audit log) |
| `/home/ubuntu/hercules-work-live2` | Worktrees, mirrors, screenshots (`HERCULES_WORK_DIR`) |
| `/home/ubuntu/.hercules/hercules.env` | Secrets + knobs (`EnvironmentFile`, mode `600`) |
| `/home/ubuntu/.hercules/daemon.log` | stdout/stderr from systemd |
| `/etc/systemd/system/hercules.service` | Unit |

## Environment (`hercules.env`)

```bash
HERCULES_TOKEN=<long random hex>   # UI auth; never in URL
HERCULES_PORT=8787
HERCULES_ADAPTER=grok              # daemon default: grok | codex | claude | fake
# Codex fallback defaults (both are passed explicitly to `codex exec`):
HERCULES_CODEX_MODEL=gpt-5.6-sol
HERCULES_CODEX_REASONING_EFFORT=medium
# Claude remains unregistered unless this paid compatibility path is intentional:
# HERCULES_CLAUDE_ENABLED=1
HERCULES_PUSH=1                    # push hercules/<task-id> after preserve
HERCULES_REVIEWER=1                # L3 independent review (default on; set 0 to disable)
HERCULES_WORK_DIR=/home/ubuntu/hercules-work-live2
# Optional: lower global/heavy caps when MemAvailable is low (12GB arm64 OOM guard).
# Off by default. When on: ≤3 GiB free → global 1; ≤1 GiB free → global 1 + pause new L2 browser.
# HERCULES_DYNAMIC_CAPS=1
# Optional: per-task + UTC-day token/cost soft warn + hard stop (spend guard).
# Off by default so normal single tasks never block. When on, USD defaults follow
# HERCULES_BILLING_MODE (subscription | metered; missing/invalid → metered):
#   subscription: task soft/hard $40/$50, day $80/$100  (adapter USD = estimate, not invoice)
#   metered:      task soft/hard $20/$25, day $40/$50   (half of subscription)
# Token totals remain telemetry/advisory by default. An explicit *_TOKENS_HARD
# override adds an independent hard stop. Per-field USD and token overrides remain
# authoritative; off/none/unlimited disables that axis.
# HERCULES_COST_CAPS=1
# HERCULES_BILLING_MODE=subscription
# Stall-safe long gates (cargo / pnpm silence is normal while processAlive):
# HERCULES_STALL_TIMEOUT_MS=600000   # idle stream → stall only if process NOT alive (default 10m)
# HERCULES_MAX_RUN_MS=7200000        # hard wall-clock kill even when processAlive (default 2h)
# Optional: when a task branch lags default, locally rebase hercules/<id> onto default
# and re-run L1 before the packet. Off by default (safety). Never force-pushes; never merges to main.
# HERCULES_AUTO_REBASE=1
XAI_API_KEY=xai-...                # optional: phone voice → Grok STT (console.x.ai)
PATH=/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin
```

- **Daemon default adapter is `grok`** (subscription headless). Changing it needs a restart.
- **Provider fallback:** automatic failover is `grok` → `codex`; it never selects
  Claude. An explicitly supplied failover policy may include Claude only when
  `HERCULES_CLAUDE_ENABLED=1` has registered it.
- **Codex execution:** defaults to `gpt-5.6-sol` with `medium` reasoning. Override
  with `HERCULES_CODEX_MODEL` and `HERCULES_CODEX_REASONING_EFFORT`
  (`low|medium|high|xhigh|max|ultra`). Invalid values conservatively use the defaults
  and logs do not echo the rejected values.
- **Cost caps / billing mode:** off by default (`HERCULES_COST_CAPS=1` to enable).
  `HERCULES_BILLING_MODE=subscription` uses higher USD soft/hard defaults for flat-plan
  hosts (task 40/50, day 80/100); `metered` is half (20/25, 40/50). Missing or invalid
  mode falls back to **metered** with an actionable log line (never echoes the raw env
  value). Adapter USD under subscription is an **internal estimate**, not an invoice.
  Token totals remain telemetry/advisory by default in both profiles. An explicit
  `HERCULES_TASK_TOKENS_HARD` or `HERCULES_DAY_TOKENS_HARD` adds an independent,
  fail-closed owner override; optional token soft thresholds remain warnings.
  Explicit USD/token values win per field, and `off`/`none`/`unlimited` disables
  that axis. Wall-time, attempt, thrash, disk, auth, and provider-health brakes are
  independent of this spend policy.
- **Stall / long gates:** idle stream timeout (`HERCULES_STALL_TIMEOUT_MS`, default 10m)
  only kills when the agent process is **not** reporting alive. Silent `cargo` /
  `pnpm test` under a live child is **not** a stall. Hard wall-clock
  (`HERCULES_MAX_RUN_MS`, default 2h) still kills deadlocks — stall is never fully
  off on the free-tier box.
- **Phone voice:**
  - **Voice Control orb** — avatar face; Grok Realtime when credentials exist
    (`XAI_API_KEY` / `GROK_API_KEY`, else same Grok CLI login as coding agents).
    Opt out of CLI fallback: `HERCULES_XAI_USE_CLI_TOKEN=0`.
  - **Composer mic** — prefers free browser Web Speech; server STT if configured.
  - **Avatar** — weekly Grok Imagine when credentials exist, else SVG fallback.
  - Optional: `HERCULES_VOICE_MODEL`, `HERCULES_VOICE_MAX_SECONDS`,
    `HERCULES_VOICE_AVATAR_MODEL`. Defaults in `src/server/xaiApi.ts`.
- **Coding agents** use **Grok Build CLI** (`HERCULES_ADAPTER=grok`) via subscription.
- **Grok code model** — headless tasks, ACP sessions, and L3 pin `grok -m` to
  `HERCULES_GROK_MODEL` (default `grok-4.5`). Set `auto` to use the CLI config default.
- **L3 reviewer** (default on): fresh Grok session when DoD has `(reviewer)` criteria or a
  non-trivial diff without a typed DoD. Failures auto-rework the implementer. Set
  `HERCULES_REVIEWER=0` to disable (cost).
- **Delivery honesty** (system): if the **task intent** is implementation (title/body UI/fix/设置…),
  an **empty worktree vs base** auto-reworks — including **steer** follow-ups (“ready了吗”, “请自审”).
  Opt out only with `hercules:no-diff-ok` / label `analysis` / `readonly`. False 已上线/shipped
  claims with no files always rework. Pure Q&A task titles may stay no-diff on steer.
- **Branch preserve**: review and rework always keep `hercules/<taskId>` (never delete the branch
  on empty-diff review). Only hard fail / cancel / Delete purge the branch.
- **Orphan recovery**: if `hercules/<id>` is missing but mirror still has commits
  (`hercules: <id>` message / reflog), the next worktree create reattaches the branch.
- **Empty-diff screenshots**: not shown as behavioral evidence; prior SPA captures are stale.
- **Delete task → sessions**: always closes task-live + linked free Remote Control sessions
  (even when cleanup is off), so Chat does not keep a zombie open.
- **Deleted trash**: Delete / Clear moves tasks to state `deleted` (list section **Deleted**),
  not immediate file removal. Each item ages from its soft-delete `endedAt`; after
  `HERCULES_AUTO_DELETE_DAYS` (default 30) the daemon **hard-purges** that task only.
  Clear on the Deleted section hard-purges immediately. Set days=`0` to disable auto-purge.
- **Worktree / screenshot GC** (disk hygiene): residual worktrees for **terminal**
  tasks (`done` / `cancelled` / `failed` / `deleted`) older than
  `HERCULES_WORKTREE_GC_DAYS` (default **7**) are removed on a 60s sweep and via
  `POST /api/system/worktree-gc`. Local `hercules/<id>` salvage branches and
  **remote** branches are **never** deleted; control-repo history is untouched.
  Optional: `HERCULES_WORKTREE_GC_SCREENSHOTS=1` also purges `screenshots/<id>`.
  Safe dry-run: `HERCULES_WORKTREE_GC_DRY_RUN=1` (or `{ "dryRun": true }` on the
  admin endpoint) — always logs one digest line per sweep.
- **L2 evidence (declarative)**: WORKFLOW `behavioral.evidence` or task `## Evidence` steps
  (`unlock` / `click [data-evidence=…]` / `assert text=` / `screenshot name`). SPA exposes
  stable `data-evidence` hooks. Packet logs each step ✅/❌ — no label guessing.
- **Preserve resilience**: missing worktree still recovers `hercules/<id>` from dangling commits
  and best-effort pushes the branch so review/GitHub compare does not lose work.
- **DoD parsing**: `## Definition of Done` counts as acceptance criteria (same as Acceptance criteria).
- **Per-repo override** (no restart): `repos.yaml` field `adapter: grok|codex|claude|fake`,
  also editable from the phone **Repos** panel. Claude is unavailable unless
  `HERCULES_CLAUDE_ENABLED=1`; the phone only offers registered adapters.
- Use `fake` only for UI dry-runs (or a per-repo override for testing).
- Token: `openssl rand -hex 16`. Rotate by editing env + `systemctl restart hercules`.

## systemd unit

```ini
[Unit]
Description=Hercules multi-repo coding-agent orchestrator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/home/ubuntu/projects/Hercules
EnvironmentFile=/home/ubuntu/.hercules/hercules.env
ExecStart=/usr/bin/node dist/src/main.js /home/ubuntu/hercules-live
Restart=always
RestartSec=3
StandardOutput=append:/home/ubuntu/.hercules/daemon.log
StandardError=append:/home/ubuntu/.hercules/daemon.log

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hercules
sudo systemctl restart hercules
sudo systemctl status hercules
tail -f /home/ubuntu/.hercules/daemon.log
```

After code pull (SSH):

```bash
cd /home/ubuntu/projects/Hercules
git pull
pnpm install --frozen-lockfile
pnpm build          # required — service runs dist/
sudo systemctl restart hercules
# log should say: [hercules] adapter: grok
```

**Phone UI (no SSH):** Settings → **Pull, build & restart** (two-tap confirm).
Runs the same sequence via `POST /api/system/update` `{ confirm: true }`.
Disable with `HERCULES_SELF_UPDATE=0`. Optional unit name: `HERCULES_SERVICE`
(default `hercules`).

## Control repo

- Git repo owned by the daemon; every state change is a commit.
- `repos.yaml` registers targets. Prefer `default_branch: main` (or the real
  protected default), **not** a stale feature branch — WORKFLOW/gates are read
  from that branch on the trusted mirror.
- Create tasks from the phone UI or by adding `tasks/<id>.md` + commit.
- **New / incomplete repos:** only `onboarding`/`readiness` labeled tasks
  dispatch. Prefer the multi-stage readiness pipeline (R1 map → R2 WORKFLOW →
  R3 gates/boot → R4 human mark ready) instead of one monolithic onboarding
  task — see [`readiness-pipeline.md`](./readiness-pipeline.md) and
  `examples/readiness-pipeline/`. Repos → **Start onboarding** creates it.

## Phone access

**Primary: Cloudflare Tunnel**
(standard pattern):

| Unit | Role |
|------|------|
| `cloudflared-hercules.service` | `cloudflared` → `http://127.0.0.1:8787` |
| Optional `TUNNEL_TOKEN_FILE` in `/etc/cloudflared/hercules.env` | Named tunnel (fixed hostname); token value stays out of argv/environment |

Quick tunnel URL is in the unit journal / `~/.hercules/tunnel_url` (rotates on
restart). Paste `HERCULES_TOKEN` into the UI gate — never in the URL.

A private network remains secondary; iOS + `:8787` plain HTTP is flaky.

## Health checks

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/     # 200
# API without token → 401
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/state
# With token (Authorization: Bearer …) → 200 + JSON snapshot
```

## Rollback

1. `git -C /home/ubuntu/projects/Hercules checkout <known-good>`
2. `pnpm build && sudo systemctl restart hercules`
3. Or set `HERCULES_ADAPTER=fake` in env and restart to stop burning agent credits
   while keeping the UI up.

### Automated promote rollback

When a **Promote** fails post-deploy health/smoke, the daemon automatically rolls
back to the previous recorded `production_sha` via
`./scripts/deploy-production.sh <known-good>` (design §3). Manual button:
Releases panel → **Roll back to previous**. Operator emergency:

```bash
./scripts/deploy-production.sh <known-good-sha>
# if the script prints NEEDS-OPERATOR:
sudo systemctl restart hercules
```

---

## Staging instance (`hercules-staging`)

Persistent second daemon for release verification (design §4). **Never** shares
production control-repo, work dir, token, or adapter. Staging may mirror
realistic *data* (a refreshed **copy** of the live control repo) but all
mutations stay in the copy.

### Layout (defaults; override via env knobs on the deploy scripts)

| Path | Role |
|------|------|
| `/home/ubuntu/projects/Hercules-staging` | Staging code tree (`STAGING_CODE`) |
| `/home/ubuntu/hercules-live-staging` | Staging **control-repo copy** (`STAGING_CONTROL`) |
| `/home/ubuntu/hercules-v2-shadow-staging` | Staging M4 shadow store (`HERCULES_V2_SHADOW_*` in env file); the deploy script **resets it** on every control-copy refresh because projection envelopes bind to the copied git history |
| `/home/ubuntu/hercules-work-staging` | Staging worktrees (`HERCULES_WORK_DIR` in env file) |
| `/home/ubuntu/.hercules/hercules-staging.env` | Staging secrets + knobs (mode `600`) |
| `/home/ubuntu/.hercules/staging-daemon.log` | Staging stdout/stderr |
| `/etc/systemd/system/hercules-staging.service` | System unit (or `~/.config/systemd/user/…`) |

### Environment (`hercules-staging.env`) — isolation constraints

These must match design §4 exactly:

```bash
HERCULES_TOKEN=<different long random hex from production>   # openssl rand -hex 16
HERCULES_PORT=8788
HERCULES_ADAPTER=fake              # never spawn real agents from staging
HERCULES_DISPATCH_ENABLED=0        # read-only observer; never claim shared tasks
HERCULES_PUSH=                     # empty — never push task branches
HERCULES_SELF_UPDATE=0             # never restart production via Settings
HERCULES_WORK_DIR=/home/ubuntu/hercules-work-staging
PATH=/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin
```

Do **not** point `HERCULES_WORK_DIR` at the production work root (2026-07-17
env-inheritance incident). The deploy script refreshes the control-repo **copy**
from `/home/ubuntu/hercules-live` on each staging deploy; the unit's
`ExecStart` argument must be the **copy** path.

### systemd unit file content

```ini
[Unit]
Description=Hercules staging (release verify — read-only, isolated control plane)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/home/ubuntu/projects/Hercules-staging
EnvironmentFile=/home/ubuntu/.hercules/hercules-staging.env
ExecStart=/usr/bin/node dist/src/main.js /home/ubuntu/hercules-live-staging
Restart=always
RestartSec=3
StandardOutput=append:/home/ubuntu/.hercules/staging-daemon.log
StandardError=append:/home/ubuntu/.hercules/staging-daemon.log

[Install]
WantedBy=multi-user.target
```

### Install steps (operator — not done by agents)

```bash
# 1. Env file (mode 600)
mkdir -p /home/ubuntu/.hercules /home/ubuntu/hercules-work-staging
openssl rand -hex 16   # → HERCULES_TOKEN in hercules-staging.env
# write hercules-staging.env with the isolation knobs above
chmod 600 /home/ubuntu/.hercules/hercules-staging.env

# 2. Unit
sudo cp /path/to/hercules-staging.service /etc/systemd/system/
# or: user unit under ~/.config/systemd/user/ (sudo-less restart)
sudo systemctl daemon-reload
sudo systemctl enable --now hercules-staging

# 3. First staging deploy (from a Hercules checkout that has the scripts)
cd /home/ubuntu/projects/Hercules
./scripts/deploy-staging.sh
# If the script prints NEEDS-OPERATOR: <cmd> — run that cmd as operator.

# 4. Health
curl -sf http://localhost:8788/   # 200
```

**Restart expectation:** scripts prefer `systemctl --user` when a user unit
exists; otherwise `sudo -n systemctl restart` (NOPASSWD, same as production
self-update). If restart needs interactive sudo, the script prints
`NEEDS-OPERATOR: sudo systemctl restart hercules-staging.service` and exits 0
so the shepherd can run it.

### Staging deploy flow (automated)

After merges advance mirror main, the release reconciler runs
`./scripts/deploy-staging.sh` (WORKFLOW `deploy.staging`), then health on
`:8788`, then the small verify evidence list (unlock → settings panel). Phone
Releases panel opens `deploy.staging.url`.

### Pre-promote parser hash check (mandatory since 2026-09-06)

The shadow reconciler binds every historical projection envelope to the
canonical hash of the parsed task (`hashCanonicalJson(parseTaskFile(...))`).
A parser change that alters the hash of an EXISTING task — for example a new
optional field parsed as `null` — makes production boot fail closed
(`reconciliation envelope is not bound to its exact task tree`) and the
promote crash-loops. Staging cannot catch this class because its shadow store
is reset on every deploy. Before promoting, run:

```bash
node scripts/check-task-hash-stability.mjs \
  /home/ubuntu/hercules-release/dist   `# the running release's build` \
  <candidate-checkout>/dist            `# the candidate's build` \
  /home/ubuntu/hercules-live/tasks     `# the production control tasks`
```

Exit 0 (all hashes identical) is required. A difference is acceptable only
for a task whose FILE already carries a field the old parser drops — and then
a rollback below the candidate is no longer boot-safe, which must be recorded
in the ledger.

### Production deploy flow (human Promote)

`./scripts/deploy-production.sh <sha>` — fetch, checkout sha, frozen install,
build, restart `hercules`. Aligns with Settings self-update
(`src/server/selfUpdate.ts`) but pins a verified sha instead of
`git pull --ff-only`. WORKFLOW `deploy.production` health + smoke both hit
`:8787/`.

### Staging rollback / rebuild

- Re-run `./scripts/deploy-staging.sh` to rebuild from current main.
- Or stop the unit: `sudo systemctl stop hercules-staging` (safe; production unaffected).
- Staging control-repo copy is disposable; next deploy re-rsyncs from live.

## Security checklist

- [ ] Not listening on a public WAN port-forward  
- [ ] Private network (or an authenticated tunnel) only  
- [ ] `hercules.env` mode `600`, not in git  
- [ ] Token not embedded in URLs or chat logs long-term  
