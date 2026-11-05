# Design spike: SSH heavy-validation worker

Date: 2026-07-15  
Status: **spike — awaiting human accept** before a large implementation  
SPEC refs: §6.3 (heavy permit), §9.2 (L2), §11 (escape hatch), §17 (non-goals)

## Problem

The control plane targets **Oracle Always Free** (2 OCPU / 12 GB). Coding + L1
gates fit; **L2** (boot app + headless browser) is the RAM/CPU spike and is
serialized behind a capacity-1 heavy-validation permit so the box does not OOM.

Operators may later attach a **single larger machine** for L2 only, while the
daemon, agents, control-repo IO, and phone UI stay on free-tier.

## Goal

An **additive** path: optionally run Layer-2 behavioral verification on one
remote host over SSH, without changing the orchestration core or introducing a
distributed system.

## Non-goals (vs multi-node)

| In scope (this spike / future follow-on) | Out of scope (multi-node mesh) |
|------------------------------------------|--------------------------------|
| One optional remote **heavy** host | Multi-node agent mesh / work queues |
| L2 only (boot + browser + evidence) | Remote coding agents or L1 gates |
| Control plane remains single process | HA failover, leader election |
| Additive `BehavioralRunner` impl | Changing tick loop or caps model |
| Fake transport + interface tests now | Real SSH/rsync production hardener |
| Operator-configured single endpoint | Auto-discovery, k8s, fleet scheduling |

**Invariant from SPEC §17:** no multi-node distribution. The SSH worker is a
**designed-for extension** of the single-box model — a second machine that
executes heavy jobs under control of the existing daemon — **not a cluster**.

This spike deliberately does **not** introduce:

- Shared work queues or multi-master orchestration
- Remote agent processes (Grok/Codex/Claude stay on free-tier)
- Fleet scheduling, service discovery, or mesh networking
- Changes to global/per-repo agent caps or the tick loop

## Placement in the existing architecture

L2 is already injected:

```
WorktreeVerifier
  └─ optional BehavioralRunner.run({ taskId, baseUrl, boot…, cwd, … })
       ├─ LiveBehavioralRunner   (local; acquires local heavy permit)
       └─ RemoteHeavyRunner      (new; optional; no local heavy permit)
```

Coding agents, L1 gates, L3/L5, packet assembly, and SSE stay on the control
box. Only the body of `BehavioralRunner` may move.

```
┌──────────────── free-tier control ─────────────────┐
│  orchestrator · adapters · L1/L3/L5 · UI/SSE       │
│  WorktreeVerifier → BehavioralRunner               │
│       local default │ remote opt-in                │
└─────────────────────┼──────────────────────────────┘
                      │  sync workspace + job request
                      │  exec remote L2
                      │  pull screenshots
                      ▼
┌──────────────── optional heavy host ───────────────┐
│  boot WORKFLOW app · browser · capture evidence    │
│  capacity: 1 concurrent heavy job (remote side)    │
└────────────────────────────────────────────────────┘
```

## Interface sketch (implemented as types + fake)

### Domain (pure) — `src/domain/heavyWorker.ts`

- `HeavyWorkerMode`: `'local' | 'remote'`
- `HeavyRemoteEndpoint`: host, user, sshPort, optional identityFile, remoteRoot
- `HeavyJobRequest` / `HeavyJobResult` (mirror `BehavioralRunner` I/O + `where`)
- `remoteJobDir(remoteRoot, taskId)` — path chokepoint via `isValidIdentifier`

### Transport (IO) — `src/verification/heavyWorker.ts`

```ts
interface HeavyWorkerTransport {
  syncUp(localWorkspace: string, remoteJobDir: string): Promise<void>;
  execJob(remoteJobDir: string, request: HeavyJobRequest): Promise<HeavyJobExecResult>;
  syncDown(remoteJobDir: string, localScreenshotDir: string): Promise<readonly string[]>;
  cleanup(remoteJobDir: string): Promise<void>;
}
```

- **Fake transport** (this spike): records calls, returns canned results — no SSH.
- **Real SSH transport** (future, human-accepted): `rsync`/`scp` + `ssh` remote
  script; typed errors; never shell-interpolates `taskId` without validation.

### Runner

`RemoteHeavyRunner implements BehavioralRunner`:

1. Build remote job dir from endpoint + task id (`remoteJobDir` / SPEC §10).
2. `syncUp` worktree.
3. `execJob` (remote boot + browser; **does not** take the local heavy semaphore —
   that is the free-tier win).
4. `syncDown` screenshot basenames into the daemon’s screenshots root.
5. Always `cleanup` in `finally` — best-effort with **logged** failures (no empty
   `catch {}`).

Composition root (future, **not** wired this spike):

```ts
behavioral =
  mode === 'remote'
    ? new RemoteHeavyRunner({ endpoint, transport, screenshotsRoot })
    : new LiveBehavioralRunner({ permit, browser, screenshotsRoot, … });
```

Config shape (future env / config — not wired this spike):

| Knob | Meaning |
|------|---------|
| `HERCULES_HEAVY_MODE=local\|remote` | Default local |
| `HERCULES_HEAVY_SSH_HOST` | Remote host |
| `HERCULES_HEAVY_SSH_USER` | SSH user |
| `HERCULES_HEAVY_SSH_PORT` | Default 22 |
| `HERCULES_HEAVY_SSH_IDENTITY` | Optional key path |
| `HERCULES_HEAVY_REMOTE_ROOT` | Base dir for job trees on remote |

## Concurrency & failure

- **Local mode:** unchanged — `Semaphore` capacity 1.
- **Remote mode:** control plane does **not** hold the local heavy permit for L2.
  Remote side **MUST** serialize to one concurrent L2 job (script-level lock or
  single worker process). Global/per-repo agent caps are unchanged.
- **Transport failure:** map to `healthy: false` + **error string** (surfaced on
  the runner result). No silent swallow.
- **Unsafe task id:** throw `IdentifierError` (not a soft L2 failure).
- **Partial syncDown:** return whatever basenames arrived; still cleanup.
- **Cleanup failure:** log via `logError` / `console.error`; do not hide a prior
  healthy job result.

## Security (future real transport)

- Task id → path only through `isValidIdentifier` / `remoteJobDir`.
- Trusted WORKFLOW boot/health only (same as local `CommandBootController`).
- SSH host key / identity managed by the operator; no secrets in task files.
- Remote job dirs under a dedicated root; cleanup after each job.
- Do not mount the control-repo or agent credentials on the heavy host unless
  the operator explicitly chooses that threat model.

## Implementation plan (after human accept)

1. `SshHeavyTransport` (`rsync` + `ssh` + remote lock script).
2. Config knobs in `src/config.ts` + `docs/deploy.md`.
3. Composition root in `src/main.ts`: choose local vs remote runner.
4. Integration smoke: one real SSH target (manual / optional CI).
5. Packet / activity line noting `where: remote` when L2 ran off-box.

## Spike deliverables (this PR)

| Artifact | Role |
|----------|------|
| This doc | Design + non-goals vs multi-node |
| `src/domain/heavyWorker.ts` | Pure types + path chokepoint |
| `src/verification/heavyWorker.ts` | Transport interface, fake, `RemoteHeavyRunner` |
| `test/domain/heavyWorker.test.ts` | Identifier / path tests |
| `test/verification/heavyWorker.test.ts` | Protocol, failures, no local permit |
| SPEC §11 + backlog P4 | Cross-links |

**Not in this spike:** real SSH, `main.ts` wiring, tick/caps changes, Settings UI.
