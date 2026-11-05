# Hercules 2.0 V1 M3 - Shadow-only embedded state store

## Milestone

M3 - Embedded state store and transactional event log in shadow-only mode.

## Current main SHA

`a4f6ac9a54d020230201270063800407ec48f3e2`

## Goal

Add a trusted-host-only `ControlStateStore` port and a local SQLite implementation
that can persist validated V2 projection records and an append-only control event in
one transaction. The store is an additive shadow substrate. Current Markdown task
files and Git history remain the only authority, and no current mutation path calls
the store in M3.

## Dependencies

- M2 is complete in the program-state ledger (internal; not published).
- `AGENTS.md` blob: `929c500c87749ea8870da76e16b559d7bb2c4913`.
- `WORKFLOW.md` blob: `899677f792360975cf7c66668d97c453e1167807`.
- Implementation specification blob: `bd9cbdd280114c2b583d824a8dcd6797e82b8aec`.
- Autonomous program contract blob: `b3b09e57953ec9a883fb7f096a117dafdbdafa7c`.
- Continuity commit: `ffcd564a9bf0f645b95605cc533f7c6639d80602`.
- Continuity Hercules state blob: `0d57a9b4d38e83079a0413985acd681bfe7a1066`.

## M3 and M4 boundary

M3 implements and tests the storage capability using synthetic V2 commands. It may
read and write only its own temporary test databases or a host-selected shadow DB
path. It does not import the store into the composition root, control mutation
service, orchestrator, server, API, Web UI, adapters, or task-file writer.

M4 owns projection wiring from current authoritative mutations, parity reporting,
replay, and divergence detection. Therefore M3 proves that one supplied projection
mutation and its event commit atomically; it does not claim that every current
mutation is already projected.

## Driver and durability profile

- Use `better-sqlite3` behind the port because CI is pinned to Node 20 and
  `node:sqlite` is not available there.
- Production-shaped tests use a real file in a private temporary directory, not an
  in-memory database.
- Every writable connection enables and verifies `foreign_keys=ON`,
  `journal_mode=WAL`, `synchronous=FULL`, and a bounded `busy_timeout`.
- The database directory and database file are restricted to the current user.
  Symlinks, non-regular existing files, and paths outside the trusted caller's
  selected root fail closed.
- The port never exposes a driver handle, SQL statement, transaction callback, or
  arbitrary query method.

## Port contract

The public port accepts decoded input only through strict runtime validation. Its
minimum operations are:

```ts
interface ControlStateStore {
  initialize(): StartupIntegrityReport;
  commit(command: ShadowCommitCommand): ShadowCommitReceipt;
  readTask(taskId: string): ShadowTaskState | null;
  readEvents(afterSequence: number, limit: number): readonly ControlEvent[];
  exportSnapshot(destinationRoot: string, bundleName: string): ExportReceipt;
  close(): void;
}
```

`commit` supports these closed mutation kinds:

- insert an immutable, hash-verified root `TaskContract`, only as version 1 when
  that task has no persisted contract history;
- append a contract successor by supplying an approved `ContractChangeRequest`,
  `ContractChangeProvenance`, and separately trusted
  `TrustedContractChangeAuthority`, never a caller-built next contract;
- insert a new `Iteration` or advance its current projection using the M1
  transition invariants;
- insert a new `StageRun` or advance its current projection using the M1
  transition invariants.

Each command contains one stable idempotency key, one projection mutation, and only
event metadata (`eventId`, actor, and `occurredAt`). The caller cannot supply event
type, aggregate identity, or event payload. After validating the mutation, the
store derives those fields through this closed mapping:

| Mutation | Event type | Aggregate | Canonical event payload |
|---|---|---|---|
| insert root contract | `ShadowContractRootProjected` | `task` / contract `taskId` | exact validated root contract |
| append approved contract successor | `ShadowContractSuccessorProjected` | `task` / request `taskId` | request, provenance, trusted authority, and store-derived next contract |
| insert or advance iteration | `ShadowIterationProjectionCommitted` | `iteration` / iteration `id` | exact validated next iteration |
| insert or advance stage run | `ShadowStageRunProjectionCommitted` | `stage_run` / stage `id` | exact validated next stage run |

The derived payload also carries the mutation kind and required parent identities.
The store canonicalizes the complete derived request and computes its digest
internally. Caller-provided hashes never replace recomputation. Task, contract,
iteration, stage, event type, aggregate, or payload mismatches are therefore not
representable through the public port; decoded objects containing such extra event
claims fail strict validation.

For a root, the store calls the M2 root/history validator against an empty history
and rejects every non-v1 or superseding record. For a successor, it loads the exact
persisted history and calls `appendApprovedContractChange` with the request,
provenance, and trusted authority. The returned final element is the only next
contract the store may persist. Request self-claims cannot replace the separately
trusted decision binding; wrong task/base/request/decision identities, absent
approval, risk change without human approval, criterion removal/authority change,
required-to-optional downgrade, no semantic change, or a caller-supplied next
contract all fail before any write.

## Transaction and idempotency rules

1. Begin a write transaction before checking the idempotency receipt.
2. A new key applies exactly one validated projection mutation, appends exactly one
   event, and inserts exactly one receipt before commit.
3. Retrying the same key with the same internally computed request digest returns
   the original receipt and appends nothing.
4. Reusing a key with different semantic input fails closed and changes nothing.
5. Any validation, constraint, event, receipt, injected-failure, busy, or commit
   error rolls back projection, event, and receipt together.
6. Event sequence is database-assigned and monotonically increasing. Callers cannot
   choose or rewrite it.
7. Contract rows are insert-only. A successor is generated only by the M2 approved
   change workflow over the exact stored history. Iteration and stage rows are
   current projections; legal state advances replace the projection while the event
   log preserves the append-only history. Terminal or stale rewrites fail through
   M1 invariants.

## Event integrity

`ControlEvent` is a strict immutable envelope with a stable event ID, store-derived
event type, store-derived aggregate kind and ID, actor, occurrence time,
store-derived canonical JSON payload, previous event hash, and event hash. The
store recomputes the hash from the prior committed hash plus the canonical event
fields.

The schema denies event `UPDATE` and `DELETE` through triggers. Startup verifies the
event sequence and hash chain. This detects row rewriting, interior deletion, and
reordering through the supported database boundary. It does not claim protection
against an administrator replacing or truncating the entire database. M5 external
archive anchors are scoped only to detecting loss of successfully returned M5
archive mutations while those anchors remain; they do not prove survival of later
non-M5 events or resist coordinated replacement of both SQLite and anchors. Later
operational backup/signing policy owns stronger whole-database tamper evidence.

## Schema V1

Explicit ordered migrations create at least:

- `schema_migrations(version PRIMARY KEY, name UNIQUE, checksum, applied_at)`;
- `shadow_task_contracts` with primary key `(task_id, version)`, unique
  `(task_id, contract_hash)`, with root and successor authority enforced by the M2
  root/history and approved-change workflows inside the transaction;
- `shadow_iterations` with primary key `iteration_id`, foreign key
  `(task_id, contract_version)`, and unique `(task_id, ordinal)`;
- `shadow_stage_runs` with primary key `stage_run_id`, foreign key `iteration_id`,
  and unique `(iteration_id, stage_type, attempt)`;
- `control_events` with unique event ID, database sequence, hash-chain fields, and
  append-only triggers;
- `command_receipts` with primary-key idempotency key, request digest, serialized
  result, commit time, and `event_id NOT NULL UNIQUE REFERENCES
  control_events(event_id) ON DELETE RESTRICT`.

M3 requires a one-to-one event/receipt relationship in both directions: every
committed event has exactly one receipt and every receipt names exactly one event.
The receipt result is canonical JSON with a closed schema binding request digest,
event ID/sequence/hash, mutation kind, and aggregate kind/ID. Startup rejects an
orphan on either side, malformed digests/results, non-canonical result bytes, or a
receipt whose identities differ from its event and derived mutation.

All identifiers are static migration SQL. Runtime values use prepared statements.
Payload text is canonical JSON and bounded before entering SQLite. IDs, keys, event
types, actor fields, and timestamps are non-empty and bounded; a canonical command
or event payload larger than 1 MiB fails closed.

## Migration rules

- Migrations are an ordered immutable registry with contiguous integer versions,
  stable names, and SHA-256 checksums of exact SQL.
- Initialization applies each pending migration in its own immediate transaction
  and records its checksum in that transaction.
- A checksum mismatch, version gap, unknown newer schema, missing required table,
  missing append-only trigger, failed foreign-key check, or failed SQLite integrity
  check makes the store unavailable. Initialization never silently repairs,
  downgrades, or deletes data.
- Reopening an up-to-date database is idempotent and performs no schema write.
- Upgrading a non-empty database requires a verified pre-migration snapshot once a
  migration beyond V1 exists. V1 creation has no prior data to back up.

## Startup, export, and restart

`initialize` verifies the effective pragmas, migration registry, required schema
objects, `quick_check`, `foreign_key_check`, projection payload validation, the
event hash chain, and every idempotency receipt. It deterministically replays the
derived event payloads through the M1/M2 validators and transition invariants. A
successor replay reruns `appendApprovedContractChange` from the reconstructed prior
history using the persisted request, provenance, and trusted decision binding; it
must reproduce the persisted derived contract exactly. The replayed latest records
are then compared with every projection table. This catches authority bypass,
orphan events, orphan projections, receipt/event misbinding, and valid-SQLite but
semantically corrupt payload/result/digest data. Reads and writes remain unavailable
until all checks succeed.

`exportSnapshot` is a trusted-host operation and publishes one directory bundle. A
validated bundle name selects a nonexistent `<trusted-root>/<bundle-name>` final
directory. On the same filesystem, the store creates a private sibling staging
directory containing `state.sqlite` and `manifest.json`, uses SQLite's consistent
backup mechanism while WAL writes may exist, opens the copy read-only for all
startup checks, and records its SHA-256 in the canonical manifest. It fsyncs both
files and the staging directory, atomically renames the entire staging directory to
the final directory, then fsyncs the parent. Consumers never treat a loose DB or
manifest as an export.

Beginning with schema V3, that state-store manifest explicitly records
`artifactContentIncluded: false`. It remains a valid
diagnostic database snapshot but is not a recoverable evidence-archive export;
M5's globally locked archive export owns that complete bundle.

Handled failures remove the owned staging directory. A later export cleans only a
non-symlink staging directory with the exact private prefix, current UID, and valid
ownership marker; an ambiguous residue fails closed. Fault injection before each
fsync/rename proves no partial final bundle is observable. Traversal, symlinks,
existing final destinations, cross-filesystem staging, and provider-worktree
destinations fail closed. Restore and authority cutover are not M3 operations.

Restart tests close the first store, open a new instance over the same file, rerun
startup checks, and prove projection, event sequence/hash, and idempotency receipts
survive without duplication.

## Agent boundary

- Only trusted Hercules host code can construct the SQLite store.
- Provider adapters, agent child environments, MCP workspace tools, browser code,
  and task worktrees receive no database path, handle, file descriptor, SQL tool,
  or write capability.
- Tests include a structural invariant that adapter/provider modules do not import
  the SQLite implementation and that the implementation is absent from current
  composition-root/runtime imports in M3.
- The database must not be created under a provider worktree or current production
  control repo. M3 performs no production DB creation.

## Allowed scope and exact files

- `docs/autonomy/hercules-2-v1-m3-shadow-state-store.md`
- the program-state ledger (internal; not published)
- `package.json` and `pnpm-lock.yaml` for the SQLite driver and types only
- `src/domain/controlEvent.ts`
- `src/control/state/stateStore.ts`
- `src/control/state/stateStoreValidation.ts`
- `src/control/state/migrations.ts`
- `src/control/state/sqliteStateStore.ts`
- focused mirrors under `test/domain/`, `test/control/state/`, and
  `test/invariants/`

No other production file is in scope. If implementation needs another file, amend
and independently review this contract before editing that file.

## Explicit non-goals

- No import or construction of the store from current runtime paths.
- No task-file, Git audit, public API, review packet, scheduler, verification,
  approval, adapter, MCP, Web UI, or user-visible behavior change.
- No projection of live/current authoritative mutations; that is M4.
- No artifact content store or evidence manifest persistence; that is M5.
- No PostgreSQL, service extraction, production database, data migration, restore,
  deployment, compatibility removal, or database authority cutover.

## Checkable acceptance

1. The port leaks no SQLite type or arbitrary query capability.
2. Node 20 CI can install and use the selected driver.
3. WAL, full synchronous durability, foreign keys, busy timeout, and private file
   permissions are asserted on a real temporary database.
4. Migration creation and idempotent reopen pass; gaps, drift, newer schemas,
   missing triggers, corrupt DBs, and foreign-key violations fail closed.
5. Contract, iteration, and stage constraints plus M1/M2 validators reject malformed,
   forged, stale, duplicate, skipped, or illegal projection writes. Contract roots
   require an empty history and version 1. Successors require the exact approved
   request, provenance, and separately trusted decision binding, and the store alone
   derives the next contract.
6. Projection mutation, store-derived semantically matching event, and idempotency
   receipt commit atomically. Wrong task/parent/aggregate/type/payload binding and
   failure injection at every boundary prove no partial durable state.
7. Same-key/same-request retry returns the original receipt; same-key/different-
   request fails without mutation, including after restart.
8. Event update/delete are rejected, sequence/hash continuity survives restart, and
   supported-boundary tampering is detected at startup. Corrupt receipt result,
   digest, event binding, orphan receipt, and orphan event also fail startup.
   Contract replay also rejects no-request/self-approved/wrong-binding successors,
   authority or required downgrades, wrong bases, and caller-forged next contracts.
9. Bounded reads use deterministic ordering and reject invalid pagination.
10. A concurrent writer either commits one complete transaction or receives a typed
    busy/conflict result; it never creates duplicates or partial state.
11. A live-WAL export directory opens independently, passes integrity checks,
    matches its manifest hash, and contains the committed projection/event/receipt
    set. Export-stage failures and crash residue never expose a partial final bundle.
12. Traversal, symlink, unsafe-root, oversized-payload, accessor, class-instance,
    sparse-array, non-finite-number, and malformed decoded inputs fail closed.
13. Structural tests prove current runtime and providers do not import or expose the
    store, and legacy task files remain authoritative.
14. Focused tests, dependency lint, `pnpm check:full`, GitHub gates, and a fresh
    independent exact-head review pass before merge.

## Current-code conflict check

No state-store port or SQLite dependency exists today. Existing file-backed stores
remain unchanged and authoritative. `src/control/state/` follows the current inward
dependency direction (`control` may import `domain`), so no `AGENTS.md` or ESLint
architecture exception is required. The Node 20 CI pin rules out `node:sqlite` and
is the reason for the explicit driver choice.
