#!/usr/bin/env node
/**
 * compact-reconcile-envelopes.mjs <dist-dir> <state.sqlite3> [--apply]
 *
 * C3.40 one-time compaction of the M4 shadow store: rewrite every legacy
 * `reconcile-` projection envelope whose authority input still carries whole
 * tasks (bodies included) into the stub shape `{ id, state,
 * reconciliationStub: true }`, recomputing the envelope's manifest digest and
 * its completion receipt so boot integrity (#verifyDatabase) and the history
 * binding (assertEnvelopeAuthorityInput, which reconstructs the tree from Git
 * through the reconciliation delivery id) both hold.
 *
 * Nothing about the projection changes: the manifest (commands) and gap codes
 * are untouched, so replay produces the same shadow state; only the persisted
 * authority input shrinks (8 MB → ~15 KB per envelope on production).
 *
 * Safety: dry run by default (prints what would change). `--apply` requires
 * the daemon to be STOPPED (the script refuses if the WAL has an active
 * reader/writer via an immediate transaction failing) and a backup copy of
 * the database made by the operator beforehand. Runs in ONE transaction and
 * VACUUMs afterwards.
 */
import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const [distDir, databasePath, ...flags] = process.argv.slice(2);
if (!distDir || !databasePath) {
  console.error('usage: compact-reconcile-envelopes.mjs <dist-dir> <state.sqlite3> [--apply]');
  process.exit(2);
}
const apply = flags.includes('--apply');
const { canonicalSerialize, hashCanonicalJson } = await import(
  resolve(distDir, 'src/domain/canonicalJson.js')
);

function envelopeDigest(input) {
  return hashCanonicalJson({ schema: 'shadow-envelope-v2', ...input });
}

const db = new Database(databasePath, { readonly: !apply });
db.pragma('foreign_keys = ON');
const rows = db.prepare(`SELECT delivery_id, authority_revision, authority_input_json, manifest_json,
  gap_codes_json, manifest_digest, command_count, length(authority_input_json) AS bytes
  FROM projection_envelopes WHERE delivery_id LIKE 'reconcile-%' ORDER BY rowid`).iterate();

let scanned = 0;
let legacy = 0;
let bytesBefore = 0;
let bytesAfter = 0;
const updates = [];
for (const row of rows) {
  scanned += 1;
  const input = JSON.parse(row.authority_input_json);
  const writes = input.writes ?? [];
  if (writes.length === 0 || writes.every((w) => w && w.reconciliationStub === true)) continue;
  if (input.retiredTaskIds.length !== 0) {
    throw new Error(`${row.delivery_id}: reconciliation envelope with retirements — refusing`);
  }
  const before = {
    deliveryId: row.delivery_id,
    authorityRevision: row.authority_revision,
    authorityInput: input,
    manifest: JSON.parse(row.manifest_json),
    gapCodes: JSON.parse(row.gap_codes_json),
  };
  if (envelopeDigest(before) !== row.manifest_digest) {
    throw new Error(`${row.delivery_id}: stored manifest_digest does not match its row — refusing`);
  }
  const stubs = writes.map((task) => ({ id: task.id, state: task.state, reconciliationStub: true }));
  const nextInput = { retiredTaskIds: [], writes: stubs };
  const nextInputJson = canonicalSerialize(nextInput);
  const nextDigest = envelopeDigest({ ...before, authorityInput: nextInput });
  legacy += 1;
  bytesBefore += row.bytes;
  bytesAfter += Buffer.byteLength(nextInputJson);
  updates.push({ id: row.delivery_id, oldDigest: row.manifest_digest, json: nextInputJson, digest: nextDigest, count: row.command_count });
}
console.log(JSON.stringify({ scanned, legacy, bytesBefore, bytesAfter, apply }));
if (!apply || legacy === 0) {
  db.close();
  process.exit(0);
}

// The projection tables are guarded by immutability triggers (BEFORE UPDATE /
// DELETE → RAISE(ABORT)). Boot integrity compares sqlite_master against the
// migration schema, so the UPDATE triggers are dropped and recreated with
// their exact original SQL inside the same transaction — the schema text is
// byte-identical afterwards and the DELETE triggers are never touched.
const GUARDS = ['projection_envelopes_no_update', 'projection_completions_no_update'];
const tx = db.transaction(() => {
  const guardSql = GUARDS.map((name) => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name);
    if (!row || typeof row.sql !== 'string') throw new Error(`trigger ${name} is missing — schema drift, refusing`);
    return row.sql;
  });
  for (const name of GUARDS) db.exec(`DROP TRIGGER ${name}`);
  const upEnv = db.prepare('UPDATE projection_envelopes SET authority_input_json = ?, manifest_digest = ? WHERE delivery_id = ? AND manifest_digest = ?');
  const upRcpt = db.prepare('UPDATE projection_completion_receipts SET manifest_digest = ? WHERE delivery_id = ? AND manifest_digest = ?');
  for (const u of updates) {
    const a = upEnv.run(u.json, u.digest, u.id, u.oldDigest);
    if (a.changes !== 1) throw new Error(`${u.id}: envelope row changed underneath`);
    const b = upRcpt.run(u.digest, u.id, u.oldDigest);
    if (b.changes > 1) throw new Error(`${u.id}: multiple completion receipts`);
  }
  for (const sql of guardSql) db.exec(sql);
  for (const name of GUARDS) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name);
    if (!row) throw new Error(`trigger ${name} was not restored`);
  }
});
tx.immediate();
db.exec('VACUUM');
console.log(JSON.stringify({ applied: updates.length }));
db.close();
