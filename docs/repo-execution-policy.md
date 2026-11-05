# Per-repository agent execution policy

Hercules resolves one **effective** typed execution policy per managed repo
from optional `repos.yaml` `execution_policy`. Diagnostics and receipts expose
**names and reasons only** — never secret values.

A **worktree is git isolation, not an OS sandbox**. Compatible defaults use
`sandbox: none` so Hercules does not claim OS isolation when none was
configured. Grok coding still passes `--sandbox workspace` as defense-in-depth
when policy is `none`; that is an adapter safety default, not a policy claim.

## Defaults (compatible)

When `execution_policy` is omitted:

| Field | Value | Meaning |
|-------|-------|---------|
| profile | `compatible` | Existing repos keep working |
| sandbox | `none` | Do **not** claim an OS sandbox |
| network | `unspecified` | Do not claim network-off |
| env allowlist | default infra/toolchain names | Plus DEFAULT prefixes for compatible mode only |
| forbid_* | `true` | Production secrets, connector credentials, live PII names are always dropped |
| workspace_write | `false` | Do not require FS sandbox enforcement |

## Guardian-grade (explicit)

```yaml
repos:
  sensitive-app:
    url: git@github.com:org/sensitive-app.git
    default_branch: main
    execution_policy:
      profile: guardian
```

Unknown keys are rejected (typos fail parsing, never silently strip).
`profile: guardian` pins the **full posture** — `sandbox: workspace`,
`network: off`, `workspace_write: true`, and all `forbid_*` flags true. Any
relaxing override (e.g. `sandbox: off`, `network: unrestricted`,
`workspace_write: false`, or `forbid_*: false`) is rejected at config parsing,
and a programmatically relaxed guardian policy fails closed pre-dispatch with
the typed reason `guardian_relaxed`. Narrowing overrides (a smaller
`env_allowlist`) are allowed.

`workspace_write: true` requires `sandbox: workspace` — `read-only` (or
`off`/`none`) is contradictory and rejected at parsing / blocked pre-spawn with
`workspace_write_inconsistent`.

**Explicit allowlist is authoritative:** when policy is explicit, DEFAULT env
prefixes (`NODE_*`, `NPM_*`, …) are not applied on any child path (coding,
verification gates, L2 boot/health, Chromium, review).

**Fail closed:** before dispatch, adapter capabilities are checked; unsupported
combinations start no agent — the task is parked for human review with the
typed reason recorded in its body (same pre-dispatch pattern as the
protected-path fail-fast).

| Adapter | Enforceable sandbox | Enforceable network | workspace_write |
|---------|---------------------|---------------------|-----------------|
| grok | workspace, read-only, off, none | off, limited, unrestricted, unspecified | yes |
| fake | all | all | yes |
| codex / claude | none, off | unspecified, unrestricted | no |
| review-grok | read-only, none | off, limited, unspecified | no |

Grok coding argv derives `--sandbox` from policy (workspace when `none`) and
`--disable-web-search` unless `network: unrestricted`. A `read-only` sandbox is
**truly read-only**: the built-in tool list shrinks to
`read_file,grep,list_dir`, `search_replace`/`edit`/`write` are explicitly
disallowed, `--allow Edit` is not passed, and the `hercules_workspace`
mutation MCP server is **not registered** in the isolated GROK_HOME.

## Child-process boundary

Every value below flows only into the child env map; receipts, logs, packets
and DTOs carry **names and reasons only**. Model-auth names are intersected
with the canonical `MODEL_AUTH_ENV_NAMES` set — a caller can never smuggle an
arbitrary variable through the model-auth plumbing. Runtime extras
(`HERCULES_SLUG`, `PORT`) are merged **through** the same filter, so extras
cannot re-add a prohibited name.

- **Coding Grok** — isolated `GROK_HOME` (auth.json symlink); no provider API
  keys in env (`modelAuthNames: []`).
- **Coding Codex** — `OPENAI_API_KEY` only. **Coding Claude** —
  `ANTHROPIC_API_KEY` only.
- **Grok ACP (remote control)** — `authProvider: 'xai'` at the composition
  boundary. Optional `opts.env` is only a **source** for `codingChildEnv`
  (selected xAI names + allowlist); it is never treated as a final child env.
  Operator OAuth continues via `HOME` (`~/.grok/auth.json`). The low-level
  spawn helper does not re-merge unfiltered `process.env`.
- **L1 gates / gate-fail attribution probe / post-merge L1** — the target
  repo's effective policy is passed into `verificationChildEnv`; no model
  auth at all.
- **L2 boot/health (local)** — `bootChildEnv` with the repo policy: compatible
  mode keeps the documented toolchain-prefix inheritance (minus always-blocked
  loader/proxy/credential names); an explicit `env_allowlist` is authoritative.
  The remote heavy L2 path runs on a separate host and inherits nothing from
  the daemon process env by construction.
- **L2 Chromium** — every CDP, screenshot, and DOM-dump process uses
  `verificationChildEnv`; the repository policy is forwarded through both the
  declarative evidence path and the fallback browser path.
- **L3 Grok review** — `reviewChildEnv` with the repo policy; xAI auth names
  only.
- **Host / deploy children** — the fixed `hostChildEnv` allowlist
  (docs/host-operations.md), which is strictly narrower than any policy path
  (no prefixes, no model auth).
