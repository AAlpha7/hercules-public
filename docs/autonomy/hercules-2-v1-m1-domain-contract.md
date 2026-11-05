# Hercules 2.0 V1 M1 - Pure domain vocabulary

## Milestone

M1 - Pure V2 domain vocabulary.

## Current main SHA

`dbca8103c2f06fc386f930964e388a2ec68deedb`

## Goal

Add the first approved V2 records and pure transition invariants without connecting them to the current Hercules runtime. Contract versions, iterations, and stage attempts must be append-only by identity and ordinal. Verdicts and human decisions must bind the exact contract, candidate, and evidence identities they judge.

## Dependencies

- M0 is complete in the program-state ledger (internal; not published).
- `AGENTS.md` blob: `929c500c87749ea8870da76e16b559d7bb2c4913`.
- `WORKFLOW.md` blob: `899677f792360975cf7c66668d97c453e1167807`.
- Implementation specification blob: `bd9cbdd280114c2b583d824a8dcd6797e82b8aec`.
- Autonomous program contract blob: `b3b09e57953ec9a883fb7f096a117dafdbdafa7c`.
- Continuity commit: `a0912ad51bb532688e3390a319ddbc7093a75135`.

## Existing overlap

- `src/domain/task.ts` and `src/domain/stateMachine.ts` remain the legacy runtime task model and state machine.
- `src/domain/acceptance.ts` currently models `mechanical`, `reviewer`, and `human` Definition-of-Done authority. M2 will map it to V2 without downgrading untyped or human criteria.
- `src/domain/evidence.ts`, `src/domain/evidenceMatrix.ts`, and `src/domain/verification.ts` remain current review-packet inputs. M1 does not reinterpret or replace them.
- No current module imports the new V2 contracts in M1, so task Markdown, API payloads, scheduling, verification, and Web behavior remain unchanged.

## Allowed scope and exact files

- `docs/autonomy/hercules-2-v1-m1-domain-contract.md`
- the program-state ledger (internal; not published)
- `src/domain/v2Invariant.ts`
- `src/domain/taskContract.ts`
- `src/domain/iteration.ts`
- `src/domain/stageRun.ts`
- `src/domain/artifact.ts`
- `src/domain/evaluationVerdict.ts`
- `src/domain/humanDecision.ts`
- focused mirrors under `test/domain/` for contract history, iteration history, stage attempts, artifacts, and decision bindings

## Explicit non-goals

- No database, state-store port, migration, event log, service, worker, API, or UI.
- No import from the new V2 modules into the current runtime.
- No legacy task-file, public API, review-packet, scheduling, verification, or authority change.
- No contract hashing or current DoD mapping; those are M2.
- No deployment, production control-repo mutation, compatibility removal, or database authority cutover.

## Checkable acceptance

1. V2 records are readonly and use explicit stable/version identities.
2. Contract history rejects duplicate IDs/versions, gaps, and invalid supersession while preserving the input history.
3. Iteration history rejects duplicate IDs/ordinals, invalid supersession, and retry from a non-failed attempt.
4. Stage history rejects duplicate IDs/attempts and attempts that skip or overwrite an earlier attempt.
5. Iteration and stage state transitions reject illegal jumps and do not mutate their inputs.
   Persisted terminal records must also be reachable from those transitions: abandoned
   iterations cannot carry evaluator verdicts, and cancelled stage provenance must correlate
   worker assignment, execution start, agent runs, and terminal result facts.
6. Evaluation and human-decision bindings compare task, contract version/hash, iteration, candidate, and evidence-manifest identity.
7. Artifact/evidence contracts distinguish primary, derived, and agent-claim trust and carry candidate/criterion bindings.
8. Domain dependency lint, targeted tests, `pnpm check:full`, and a fresh independent review pass on the final PR head.

For M1 verdict validation, `verificationPolicy.requiredEvidence` values are exact
`EvidenceEntry.surface` identities and must be backed by referenced primary
artifacts. An evaluator run identity must match trusted caller context rather
than only the verdict's claim, and an independent evaluator cannot reuse a
trusted implementer run identity. `ProofBinding` remains opaque until M2
mapping and hashing; M1 therefore fails closed instead of granting pass
authority to a proof-bound criterion.

Absent an explicit blocking finding, only required criteria may drive a global
`fail` or `need_more_evidence` outcome. A required human-authority criterion
that is pending routes to `escalate_human`; it cannot create an evaluator pass
or be treated as a verification rerun.

## Current-code conflict check

No conflict was found. The specification adds a four-authority V2 criterion model while the current DoD has three authorities; M1 keeps both models separate, and M2 owns the conservative mapping.
