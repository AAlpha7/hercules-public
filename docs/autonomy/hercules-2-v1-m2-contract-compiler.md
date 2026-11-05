# Hercules 2.0 V1 M2 - Contract compiler and semantic hashing

## Milestone

M2 - Current DoD mapping, canonical serialization, and contract hashing.

## Current main SHA

`89fea8631d14c30db27f1bd853c19c047ce4539e`

## Goal

Compile the current Markdown Definition of Done into an additive V2 `TaskContract`
without changing current runtime behavior. The compiler must preserve or strengthen
criterion authority, separate semantic content from provenance and outcome facts,
and bind each immutable contract version to a deterministic SHA-256 hash.

## Dependencies

- M1 is complete in the program-state ledger (internal; not published).
- `AGENTS.md` blob: `929c500c87749ea8870da76e16b559d7bb2c4913`.
- `WORKFLOW.md` blob: `899677f792360975cf7c66668d97c453e1167807`.
- Implementation specification blob: `bd9cbdd280114c2b583d824a8dcd6797e82b8aec`.
- Autonomous program contract blob: `b3b09e57953ec9a883fb7f096a117dafdbdafa7c`.
- Continuity commit: `efca3bda306fcddc17c80187190b969573be6a4e`.
- Continuity Hercules state blob: `3d93420f15a57aec953c3f4fdd33c6d682933f9b`.

## Authority mapping

| Current criterion | V2 authority | Rule |
|---|---|---|
| `mechanical` / `机检` / `l1` | `mechanical` | Preserve explicit proof binding when present. |
| `reviewer` / `审稿` / `l3` | `evaluator` | The current fresh L3 judgment must not become implementer or verifier authority. |
| `human` / `人工` | `human` | Automation cannot satisfy or approve it. |
| Untyped checklist item | `human` | Preserve the current fail-closed default and emit a diagnostic. |
| Missing or empty DoD | required `human` fallback | Do not invent an automated completion condition. |

All mapped legacy criteria are required. Current checkbox state is an outcome fact,
not contract meaning, and must not change criterion identity or the semantic hash.

## Canonical semantic contract

The semantic projection includes objective, context, acceptance criteria,
constraints, forbidden actions, and capability, verification, approval, and budget
policies. It excludes `contractHash`, task identity, version/supersession metadata,
creator, creation time, parser warnings, checkbox state, and other derived facts.
Decision records continue to bind task/version/hash separately.
Nested semantic records are rebuilt from an explicit field allowlist, so unknown
decoded fields such as checkbox or runtime status cannot enter the hash.

Canonical JSON V1:

- supports only JSON null, booleans, finite numbers, strings, arrays, and plain records;
- sorts record keys lexicographically at every depth and emits no insignificant whitespace;
- preserves array order because criteria, constraints, and policy lists are semantic sequences;
- rejects undefined values, sparse arrays, non-finite numbers, accessors, symbols,
  class instances, and cycles instead of silently normalizing them;
- uses ECMAScript JSON string/finite-number encoding and lowercase SHA-256;
- formats contract hashes as `sha256:<64 lowercase hexadecimal characters>`.

Two semantic projections with different canonical bytes must never compare equal as
contracts even if an externally supplied hash string is forged. Hash verification
recomputes from the semantic projection.

## Version and change-request rules

- Version 1 may be compiled directly from the declared legacy semantic input.
- A later version requires an approved, valid `ContractChangeRequest` bound to the
  same task and exact current base version. Request-declared approval fields must
  exactly match authority facts supplied separately by the trusted control plane.
- The new version must be exactly current version + 1 and supersede that version.
- An approved semantic change must produce a different verified semantic hash.
- Metadata-only edits cannot create a new version.
- Existing criteria cannot be removed, made optional, or assigned a different
  authority; criterion-authority changes remain outside this program's authority.
- The legacy structural history helper can create only a verified root. Every later
  append uses the approved contract-change workflow and revalidates all hashes.
- Change requests and contracts are returned as new records; existing versions are
  never mutated or replaced.

## Allowed scope and exact files

- `docs/autonomy/hercules-2-v1-m2-contract-compiler.md`
- the program-state ledger (internal; not published)
- `src/domain/canonicalJson.ts`
- `src/domain/contractHash.ts`
- `src/domain/contractCompiler.ts`
- `src/domain/contractChange.ts`
- `src/domain/taskContract.ts`
- `src/domain/taskContractValidation.ts`
- focused mirrors under `test/domain/` and golden fixtures under
  `test/fixtures/hercules-2-v1/`

## Explicit non-goals

- No database, state-store port, migration, event log, artifact store, service,
  worker, API, UI, or orchestrator wiring.
- No current task-file parser/writer, public API, review packet, scheduling,
  verification, approval, or authority behavior change.
- No replacement of current Markdown authority and no persistence of compiled V2 data.
- No deployment, production control-repo mutation, compatibility removal, or
  database authority cutover.

## Checkable acceptance

1. Current typed and aliased DoD criteria map according to the authority table.
2. Untyped and missing criteria remain human-required and cannot become green by automation.
3. Stable criterion IDs ignore checkbox state but distinguish duplicate occurrences.
4. Explicit mechanical proof bindings become structured V2 proof bindings.
5. Canonical bytes and hashes are stable across record key insertion order.
6. Semantic arrays preserve order; ambiguous concatenations and different JSON types
   produce different canonical bytes and hashes.
7. Provenance, version, task identity, checkbox state, and diagnostics do not alter
   the semantic hash; every included semantic field does.
8. Malformed/non-JSON/cyclic input and forged hashes fail closed with typed errors.
9. A semantic successor requires an approved exact-base change request, advances one
   version, changes the verified hash, matches separately trusted decision authority,
   preserves existing criterion authority, and preserves the prior record.
10. Golden fixtures, focused tests, domain dependency lint, `pnpm check:full`, and a
    fresh independent exact-head review pass before merge.

## Current-code conflict check

No conflict was found. `src/domain/acceptance.ts` remains the authoritative current
DoD parser and already defaults untyped items to human. M2 consumes that pure output
without importing the new compiler into current runtime paths.
