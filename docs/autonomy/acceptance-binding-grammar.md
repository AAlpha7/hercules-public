# Acceptance-criterion binding grammar (verdict honesty contract)

| Field | Value |
|-------|-------|
| Date | 2026-09-02 |
| Status | landed — S1–S4 + AC lint + analyst stage merged to main 2026-09-02 (b017cf8); `(human, after deploy)` modifier + release-side checklist 2026-09-03 (61be2b2, 72a73bc) |
| Owner decision | 2026-09-02: analyst output is always approved by a human on the phone; no auto-dispatch of analyst-written plans |
| Supersedes | heuristic pass paths in `src/domain/mechProof.ts` (GATE_LIKE / EVIDENCE_LIKE / citation) |

## 1. Principle

A verdict may only be computed from **trusted inputs**, and must state its **scope**.
Anything outside scope is `n/a` — never `pass`.

- Trusted inputs: the gate process outputs (commands from the trusted-mirror
  WORKFLOW), the L2 evidence run, the fresh L3 session, the diff itself, files
  read from the verified worktree sha by the verifier.
- Untrusted inputs: the implementer's self-assessment / final report, anything
  the task branch can rewrite that a gate then executes (see S2), screenshots the
  actor took of itself.
- `actor ≠ attester`: the session that made the change never supplies the proof
  that the change is correct. This holds for code (gates/L2/L3 are separate
  processes) and must hold for browser / bounded-non-code archetypes (an
  independent verifier session runs the probes after the actor finishes).
- Every fail-closed rule is stated to the executor at prompt time. A gate the
  implementer cannot see is not a contract, it is a trap: it burns attempts on
  honest work and invites gaming the verifier instead of the task (live:
  `report-hygiene`, `test-integrity`, `evidence-hook-in-prose` each cost a task
  its attempts before their rule reached `src/orchestrator/prompt.ts` / the
  analyst cheat-sheet). Adding a critical L5 kind or an L1/L2 hard assert means
  adding its one-line rule to the prompt in the same change.

A human-in-the-loop method keeps a person reading the evidence pack. Hercules automates the
mechanical + reviewer axes, so it must earn what that method leaves to a person.
This grammar is that obligation written down.

## 2. Criterion line

```
- [ ] (<kind>) <claim> @<binding>
```

| kind | judged by | notes |
|------|-----------|-------|
| `mechanical` / `机检` / `l1` | binding evaluator (`src/domain/mechProof.ts`) | **must** carry a binding to reach `pass` |
| `reviewer` / `审稿` / `l3` | fresh L3 session | — |
| `human` / `人工` | phone Approve only | — |
| `checkpoint` / `检查点` | phone confirm **before** the named step | new. Text form: `before <step>: <what the human confirms>`. Counts as a human criterion for Approve; the runtime pause-before-step lands with the browser contract |

Untyped items stay `human` (cannot self-green).

## 3. Bindings

Exactly one binding per mechanical criterion, at the end of the line.
Write one criterion per proof; do not stack bindings.

| binding | proves | `pass` requires (all) | otherwise |
|---------|--------|-----------------------|-----------|
| `@test:<path>#<title>` | a **named test case** exists and ran green | test gate passed · `<path>` observed in the test gate's output (or a `package.json` script whose body names `<path>` was the gate command / echoed in gate output) · a case titled `<title>` exists in `<path>` at the verified sha | title absent → `fail` (the implementer did not deliver the contracted test); path not observed → `unverified` when the gate is green, else `pending` |
| `@test:<path>` | a test **file** was changed by this diff and ran green | test gate passed · `<path>` in the diff · `<path>` observed in the test gate's output (or via a naming `package.json` script as above) | not in diff → `pending` (bind a title, or use `@gate:` for regression) |
| `@evidence:<anchor>` | an L2 scene exercised `data-evidence=<anchor>` this run | L2 ran · L2 ok · a step of the executed plan references `<anchor>` | L2 not run → `fail` when declared / `skipped` when stale-WORKFLOW; no step matched → `fail` |
| `@gate:<name>` | **regression only**: the named gate stayed green | gate `<name>` (or `all`) ran and passed | gate missing → `fail` |
| `@probe:<kind>:<ref>` | archetype-specific world-state probe (http / screenshot / mail / …) run by an **independent verifier** | verifier for `<kind>` exists for the task archetype and reports ok | no verifier → `pending` (never pass) |
| *(none)* | nothing | — | `pending` + a suggested binding in the warning |

Packet rendering states the proof source per criterion, e.g.
`✅ test gate green · it("rejects a forged pin") in test/domain/x.test.ts (new in diff)` or
`⏳ unbound — suggest @gate:test`.

### Supported languages for `@test:<path>#<title>` indexing

| Language | Indexed form | Notes |
|----------|--------------|-------|
| JavaScript / TypeScript | `it('title')` / `test('title')` (and `.only` / `.concurrent`; `.skip` / `.todo` excluded) | Also `it.each(...)('title')` multiline forms |
| Rust | `#[test] fn name()` and `#[tokio::test]` / any `#[…::test]` attribute followed by `fn name` | Nested `#[cfg(test)] mod` is ignored — the attribute + `fn` pairing is enough; title is the **function name** |

A green test gate whose output omits the file name is `unverified` (human confirm),
not a hard fail — unless a `package.json` script body names the bound file and
the gate command / output references that script (then the path is OBSERVED).

`@gate:` is honest but weak: it says the existing suite still passes, not that the
claim in the text is true. The analyst / AC lint warn when every mechanical
criterion in a task is `@gate:`-bound (a feature with no feature proof).

## 4. Axis aggregation

Precedence per axis: `fail` > `skipped` > `pending` > `n/a` > `pass`.

- mechanical: any bound criterion `fail` → `fail` (auto-rework); any `pending`
  → `pending` (human decides, no attempts burned); L1 red → `fail`.
- reviewer: `HERCULES_REVIEWER=0` or no runner with a non-empty diff → `skipped`
  (visible, not green), never `n/a`. `n/a` is reserved for "nothing to review"
  (no file changes).
- human: `pending` when any `human` or `checkpoint` criterion exists.

"**automated proof complete**" may only be printed when mechanical = `pass` and
reviewer = `pass`. When an axis is `n/a` the status line names the gap
("mechanical n/a — no bound criteria"). The packet never claims the human
"need not re-read" anything.

Gate rows carry `outcome: 'skipped' | 'info'` when synthesized (no-diff runs,
soft hygiene); they render ⏭ / ℹ️ and are excluded from the n/m badge. L3 input
truncation is shown ("L3 read 80k of N diff chars"). The run timeline never
defaults an absent L2 result to ok.

## 5. Gate toolchain trust (S2)

Gate *commands* come from the trusted mirror, but they execute in the task
worktree via `sh -c`. Everything they resolve — `package.json` scripts named by
the gate commands (transitively via `pnpm <x>` / `npm run <x>` chains), vitest /
eslint / tsconfig / vite configs, and `scripts/*` files a gate script invokes —
is untrusted and was unscanned. A task rewrote `typecheck` to run a
pin-synchronizer before `tsc` (2026-09-01) and L5 saw nothing.

L5 finding `gate-toolchain-edit` (severity `review`, but **never green**): the
diff touches a gate-resolved file. Mechanical axis → `pending`, packet lists the
hunks, L3 prompt names them for scrutiny. Not auto-rework (the edit may be the
task), not silently green (the verdict cannot be trusted mechanically).

`WORKFLOW.md` and `AGENTS.md` move to `protected_paths` (executable policy and
the agent map are human-only, like release scripts and the program ledgers).

## 6. L2 relevance (S3)

Changed `data-evidence` anchors in the diff ∩ anchors referenced by executed
steps ⇒ per-anchor `covered` / `uncovered`. Uncovered changed anchors are
listed; screenshots are labelled with the anchors their scene exercised. A
`src/web` diff with no changed anchors and no `@evidence:` binding gets
"UI change without evidence binding". Green is unaffected — the label is the
point: "L2: regression only, changed UI not exercised" is a fact the human sees.

## 7. Archetypes

`code` today. `browser` and `bounded_non_code` exist as M12 vocabulary
(`src/domain/capabilityProof.ts`) with seeded harnesses only. This grammar is
archetype-neutral: `@test` / `@evidence` / `@gate` are the code archetype's
probe kinds; `@probe:` is the extension point. A real browser runtime (domain
allowlist, forbidden actions, spend caps, credential vault, checkpoint pause,
independent verifier session) is its own contract and is **not** authorized by
this document.

## 8. Slices

| slice | scope | files |
|-------|-------|-------|
| S1a | grammar + honest mechanical evaluation + `checkpoint` kind | `src/domain/acceptance.ts`, `src/domain/mechProof.ts`, tests |
| S1b | verifier supplies trusted probe inputs; gate `outcome`; packet/timeline/status honesty; L3 truncation marker | `src/orchestrator/verifier.ts`, `src/verification/packet.ts`, `src/domain/runTimeline.ts`, `src/domain/verification.ts`, `src/verification/reviewer.ts`, web renderers |
| S2 | `gate-toolchain-edit` L5 finding; reviewer-disabled → skipped; protected WORKFLOW/AGENTS | `src/verification/antiCheat.ts`, `src/verification/packet.ts`, `WORKFLOW.md` |
| S3 | L2 relevance labels | `src/verification/packet.ts` (+ small domain helper) |
| S4 | held-out honesty invariants | `test/invariants/verdict-honesty.test.ts` |
| P10 | AC lint at creation + analyst stage (LLM, read-only checkout, human approves on phone) | `src/domain/acceptanceLint.ts`, `src/orchestrator/analyst.ts`, `src/server/api.ts`, SPA draft flow |
