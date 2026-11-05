# Example: 4-stage readiness pipeline

Operator samples for onboarding an incomplete repo without tribal knowledge.
Canonical generator: `draftReadinessPipeline(repoKey)` in
`src/domain/onboarding.ts`. Full playbook: [`docs/readiness-pipeline.md`](../../docs/readiness-pipeline.md).

## Layout

| Path | Purpose |
|------|---------|
| `api-example.json` | Body for `POST /api/pipelines` (repo key `orbit` — edit before send) |
| `stages/R1.md` … `R4.md` | Human-readable stage bodies (same content as the draft) |

## Quick start

1. Edit `api-example.json`: set `repo`, `title`, `idPrefix` to your repo key
   (e.g. `bookshelf` → `bookshelf-ready`).
2. `POST /api/pipelines` with that JSON (Bearer token).
3. Or use phone **Repos → Start onboarding** (preferred; uses the same draft).

Every stage carries labels `onboarding` + `readiness` so the incomplete-repo
gate (G8) still admits them.

## Stage summary

1. **R1** — AGENTS.md map + thin CLAUDE.md  
2. **R2** — WORKFLOW install/boot/gates (gates need not be green yet)  
3. **R3** — Prove L1 green + isolated boot  
4. **R4** — Soft checklist + human **Mark ready**
