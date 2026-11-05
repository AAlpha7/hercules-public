#!/usr/bin/env node
/**
 * drop-noop-envelopes.mjs <dist-dir> <state.sqlite3> [--apply]
 *
 * One-time compaction companion to C3.58: delete COMPLETED projection
 * envelopes that projected zero commands (gap codes are recomputed live by
 * every reconciliation report and are never read back from envelopes). Since
 * C3.58 such deliveries are never persisted; this removes the ones written
 * before it (87% of the production log on 2026-09-13) so boot replay, the
 * per-sync history rebuild and startup integrity — all O(envelopes) — shrink
 * accordingly. Replay state is unchanged: an empty manifest contributes no
 * command, and reconcileShadowSnapshot derives history from the remaining
 * envelopes only.
 *
 * Preconditions (the script refuses otherwise):
 * - schema version >= 7 (the projection_observed_revision cursor exists);
 * - the daemon is STOPPED (an immediate transaction must succeed);
 * - the operator made a backup copy of state.sqlite3 (+ -wal/-shm).
 *
 * The observed-revision cursor is set to the latest envelope revision BEFORE
 * deleting, so the sync loop never walks Git history back past a deleted
 * no-op envelope. Envelopes with commands, incomplete envelopes and the
 * bridge envelope are never touched. Immutability triggers (BEFORE DELETE → RAISE) are dropped and
 * recreated with their exact original SQL inside the same transaction, so
 * boot integrity's sqlite_master comparison sees byte-identical schema text.
 * Dry run by default; `--apply` deletes and VACUUMs.
 */
import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const [distDir, databasePath, ...flags] = process.argv.slice(2);
if (!distDir || !databasePath) {
  console.error('usage: drop-noop-envelopes.mjs <dist-dir> <state.sqlite3> [--apply]');
  process.exit(2);
}
const apply = flags.includes('--apply');
const { hashCanonicalJson } = await import(resolve(distDir, 'src/domain/canonicalJson.js'));
function envelopeDigest(input) {
  return hashCanonicalJson({ schema: 'shadow-envelope-v2', ...input });
}

const db = new Database(databasePath, { readonly: !apply });
db.pragma('foreign_keys = ON');
const schemaVersion = Number(db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get());
if (!(schemaVersion >= 7)) {
  throw new Error(`schema version ${schemaVersion} < 7 — boot the C3.58 build once before compacting`);
}
const latest = db.prepare(
  'SELECT authority_revision FROM projection_envelopes ORDER BY rowid DESC LIMIT 1',
).pluck().get();
const cursor = db.prepare(
  'SELECT authority_revision FROM projection_observed_revision WHERE singleton = 1',
).pluck().get() ?? null;

const rows = db.prepare(`SELECT e.delivery_id, e.authority_revision, e.authority_input_json, e.manifest_json,
    e.gap_codes_json, e.manifest_digest, e.command_count, length(e.authority_input_json) AS bytes,
    c.delivery_id AS completed_id, c.manifest_digest AS receipt_digest,
    (SELECT COUNT(*) FROM projection_batch_acknowledgements a WHERE a.delivery_id = e.delivery_id) AS acks
  FROM projection_envelopes e
  LEFT JOIN projection_completion_receipts c ON c.delivery_id = e.delivery_id
  ORDER BY e.rowid`).iterate();
let scanned = 0;
let bytes = 0;
const drops = [];
const kinds = { live: 0, reconcile: 0, bridge: 0 };
for (const row of rows) {
  scanned += 1;
  const manifest = JSON.parse(row.manifest_json);
  const gaps = JSON.parse(row.gap_codes_json);
  if (row.command_count !== 0 || manifest.length !== 0) continue;
  void gaps;
  if (row.completed_id === null) continue; // incomplete → the observer must resume it, never drop
  if (row.acks !== 0) throw new Error(`${row.delivery_id}: zero-command envelope with batch acks — refusing`);
  const before = {
    deliveryId: row.delivery_id,
    authorityRevision: row.authority_revision,
    authorityInput: JSON.parse(row.authority_input_json),
    manifest,
    gapCodes: gaps,
  };
  if (envelopeDigest(before) !== row.manifest_digest || row.receipt_digest !== row.manifest_digest) {
    throw new Error(`${row.delivery_id}: stored digests do not match the row — refusing`);
  }
  const kind = row.delivery_id.startsWith('reconcile-') ? 'reconcile'
    : row.delivery_id.startsWith('bridge-') ? 'bridge' : 'live';
  if (kind === 'bridge') continue; // bridge envelopes are structural; never drop
  kinds[kind] += 1;
  bytes += row.bytes;
  drops.push({ id: row.delivery_id, digest: row.manifest_digest });
}
console.log(JSON.stringify({ schemaVersion, scanned, drop: drops.length, kinds, bytes, latestEnvelopeRevision: latest, cursorBefore: cursor, apply }));
if (!apply || drops.length === 0) {
  db.close();
  process.exit(0);
}
const GUARDS = ['projection_envelopes_no_delete', 'projection_completions_no_delete'];
const tx = db.transaction(() => {
  if (latest) {
    db.prepare(`INSERT INTO projection_observed_revision (singleton, authority_revision, observed_at)
      VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET authority_revision = excluded.authority_revision,
        observed_at = excluded.observed_at`).run(cursor ?? latest, new Date().toISOString());
  }
  const guardSql = GUARDS.map((name) => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name);
    if (!row || typeof row.sql !== 'string') throw new Error(`trigger ${name} is missing — schema drift, refusing`);
    return row.sql;
  });
  for (const name of GUARDS) db.exec(`DROP TRIGGER ${name}`);
  const delRcpt = db.prepare('DELETE FROM projection_completion_receipts WHERE delivery_id = ? AND manifest_digest = ?');
  const delEnv = db.prepare('DELETE FROM projection_envelopes WHERE delivery_id = ? AND manifest_digest = ? AND command_count = 0');
  for (const d of drops) {
    const r = delRcpt.run(d.id, d.digest);
    if (r.changes !== 1) throw new Error(`${d.id}: completion receipt changed underneath`);
    const e = delEnv.run(d.id, d.digest);
    if (e.changes !== 1) throw new Error(`${d.id}: envelope row changed underneath`);
  }
  for (const sql of guardSql) db.exec(sql);
  for (const name of GUARDS) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name);
    if (!row) throw new Error(`trigger ${name} was not restored`);
  }
});
tx.immediate();
db.exec('VACUUM');
console.log(JSON.stringify({ dropped: drops.length }));
db.close();
