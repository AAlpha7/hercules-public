import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { canonicalClone, canonicalSerialize, hashCanonicalJson } from '../../domain/canonicalJson.js';
import {
  buildControlEvent,
  type ControlEvent,
  type ControlEventAggregate,
  type ControlEventType,
} from '../../domain/controlEvent.js';
import type { CandidateRef } from '../../domain/artifact.js';
import { isRecord } from '../../domain/v2Invariant.js';
import {
  assertArtifactArchiveAdmissionGate,
  type ArtifactArchiveAdmissionGate,
  type ArtifactArchiveAdmissionToken,
} from '../artifacts/archiveTypes.js';
import type { ArtifactArchiveAnchor } from '../artifacts/archiveAnchor.js';
import type {
  ArchivedArtifactMetadata,
  ArchivedEvidenceMetadataManifest,
  ArtifactArchiveLineage,
  ArtifactCaptureAuthorizationRecord,
  ArtifactMetadataCommitReceipt,
  ArtifactMetadataIntegrityReport,
  ArtifactMetadataMutationKind,
  ArtifactMetadataRetirement,
  ArtifactMetadataStore,
  ArtifactCandidateBindingRecord,
  ArtifactContentPolicyRecord,
  ArtifactDigestInventoryRecord,
  ArtifactManifestCriterionRecord,
  ArtifactMetadataPage,
  ArtifactMetadataRefState,
  ArtifactMetadataSqliteSnapshot,
  ArtifactSealedMutationRecord,
  ArtifactSealedMutationSnapshot,
  IssueCaptureAuthorizationCommand,
  RecordArtifactMetadataCommand,
  RecordEvidenceManifestMetadataCommand,
  RetireArtifactMetadataCommand,
} from './artifactMetadataStore.js';
import { CURRENT_STATE_SCHEMA_VERSION } from './migrations.js';
import {
  artifactMetadataBoundedText,
  artifactMetadataCommandDigest,
  ARTIFACT_SHA256_RE,
  assertArchivedArtifactMetadata,
  assertArchivedEvidenceMetadataManifest,
  assertArtifactCaptureAuthorization,
  assertArtifactMetadataRetirement,
  canonicalArtifactTimestamp,
  trustClassRank,
  validateArtifactArchiveLineage,
  validateIssueCaptureAuthorizationCommand,
  validateRecordArtifactMetadataCommand,
  validateRecordEvidenceManifestMetadataCommand,
  validateRetireArtifactMetadataCommand,
} from './artifactMetadataValidation.js';
import { SqliteStateStore, type SqliteStateStoreOptions } from './sqliteStateStore.js';
import { StateStoreError } from './stateStore.js';

const ARTIFACT_PROTECTION_MS = 7 * 24 * 60 * 60 * 1_000;
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'ascii');
const SQLITE_READ_VERSION_OFFSET = 18;
const SQLITE_WRITE_VERSION_OFFSET = 19;

export const ARTIFACT_METADATA_FAILURE_POINTS = [
  'after_event',
  'after_projection',
  'after_inventory',
  'before_commit',
  'after_commit',
] as const;

export type ArtifactMetadataFailurePoint = (typeof ARTIFACT_METADATA_FAILURE_POINTS)[number];

export interface SqliteArtifactMetadataStoreOptions extends Omit<SqliteStateStoreOptions, 'failureInjector'> {
  readonly failureInjector?: (point: ArtifactMetadataFailurePoint) => void;
}

interface EventRow {
  readonly sequence: number;
  readonly event_id: string;
  readonly event_type: string;
  readonly aggregate_kind: string;
  readonly aggregate_id: string;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly occurred_at: string;
  readonly payload_json: string;
  readonly previous_event_hash: string | null;
  readonly event_hash: string;
}

interface ReceiptRow {
  readonly idempotency_key: string;
  readonly request_digest: string;
  readonly event_id: string;
  readonly result_json: string;
  readonly committed_at: string;
}

interface PayloadRow {
  readonly payload_json: string;
}

const SEALED_MUTATION_SELECT = `SELECT m.mutation_kind, m.aggregate_id, m.request_digest,
  m.sealed_through_sequence, m.sealed_through_event_hash, m.v3_inventory_digest,
  r.idempotency_key, r.event_id, r.result_json, r.committed_at
  FROM artifact_archive_mutations m JOIN artifact_archive_receipts r ON r.event_id = m.event_id`;

type SealedMutationRow = Record<string, unknown> & ReceiptRow;

interface ArchiveEventParts {
  readonly eventType: ControlEventType;
  readonly aggregateKind: ControlEventAggregate;
  readonly aggregateId: string;
  readonly mutationKind: ArtifactMetadataMutationKind;
  readonly record: unknown;
}

const RECEIPT_KEYS = [
  'idempotencyKey', 'requestDigest', 'eventId', 'eventSequence', 'eventHash',
  'mutationKind', 'aggregateId', 'committedAt', 'sealedThroughSequence',
  'sealedThroughEventHash', 'v3InventoryDigest',
] as const;

function fail(code: StateStoreError['code'], message: string, cause?: unknown): never {
  throw new StateStoreError(code, message, cause);
}

function exactKeys(value: Readonly<Record<PropertyKey, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function readExactOwnRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
  optionalKeys: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_input', `${label} must be a plain object`);
  }
  let prototype: object | null;
  let actual: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    actual = Reflect.ownKeys(value);
  } catch {
    fail('invalid_input', `${label} cannot be inspected`);
  }
  const allowed = [...keys, ...optionalKeys];
  if ((prototype !== Object.prototype && prototype !== null) ||
      keys.some((key) => !actual.includes(key)) ||
      actual.some((key) => typeof key !== 'string' || !allowed.includes(key))) {
    fail('invalid_input', `${label} must use the exact schema`);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of actual) {
    if (typeof key !== 'string') fail('invalid_input', `${label} contains a symbol property`);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail('invalid_input', `${label}.${key} cannot be inspected`);
    }
    if (descriptor === undefined || !('value' in descriptor)) {
      fail('invalid_input', `${label}.${key} must be an own data property`);
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalSerialize(left) === canonicalSerialize(right);
}

function parseCanonical<T>(text: string, label: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail('integrity', `${label} is not JSON`, error);
  }
  if (canonicalSerialize(value) !== text) fail('integrity', `${label} is not canonical JSON`);
  return value as T;
}

function mapSqliteError(error: unknown): never {
  if (error instanceof StateStoreError) throw error;
  const message = error instanceof Error ? error.message.slice(0, 240) : 'unknown sqlite failure';
  if (/busy|locked/i.test(message)) fail('busy', 'artifact metadata database is busy', error);
  if (/constraint|unique|foreign key/i.test(message)) {
    fail('constraint', 'artifact metadata violates a database constraint', error);
  }
  fail('integrity', 'artifact metadata database operation failed', error);
}

function candidateParts(candidate: CandidateRef): {
  readonly kind: CandidateRef['kind'];
  readonly json: string;
  readonly artifactRefId: string | null;
  readonly artifactSha256: string | null;
} {
  return {
    kind: candidate.kind,
    json: canonicalSerialize(candidate),
    artifactRefId: candidate.kind === 'artifact' ? candidate.artifactId : null,
    artifactSha256: candidate.kind === 'artifact' ? candidate.sha256 : null,
  };
}

function offlineSnapshotBytes(value: Uint8Array): Uint8Array {
  const bytes = Uint8Array.from(value);
  if (
    bytes.byteLength < 100 ||
    !Buffer.from(bytes.subarray(0, SQLITE_HEADER.byteLength)).equals(SQLITE_HEADER)
  ) {
    fail('integrity', 'serialized artifact database has an invalid SQLite header');
  }
  const readVersion = bytes[SQLITE_READ_VERSION_OFFSET];
  const writeVersion = bytes[SQLITE_WRITE_VERSION_OFFSET];
  if (!((readVersion === 1 || readVersion === 2) && (writeVersion === 1 || writeVersion === 2))) {
    fail('integrity', 'serialized artifact database has invalid journal versions');
  }
  // serialize() contains all committed pages; a pathless verifier cannot open a
  // WAL-mode header because it has nowhere to place sidecars.
  bytes[SQLITE_READ_VERSION_OFFSET] = 1;
  bytes[SQLITE_WRITE_VERSION_OFFSET] = 1;
  return bytes;
}

function rowToEvent(row: EventRow): ControlEvent {
  return {
    sequence: row.sequence,
    eventId: row.event_id,
    eventType: row.event_type as ControlEventType,
    aggregateKind: row.aggregate_kind as ControlEventAggregate,
    aggregateId: row.aggregate_id,
    actor: { kind: row.actor_kind as ControlEvent['actor']['kind'], id: row.actor_id },
    occurredAt: row.occurred_at,
    payload: parseCanonical(row.payload_json, `event ${row.event_id}`),
    previousEventHash: row.previous_event_hash,
    eventHash: row.event_hash,
  };
}

function assertReceipt(value: unknown): asserts value is ArtifactMetadataCommitReceipt {
  if (!isRecord(value) || !exactKeys(value, RECEIPT_KEYS)) fail('integrity', 'archive receipt schema is invalid');
  for (const field of ['idempotencyKey', 'eventId', 'aggregateId', 'committedAt'] as const) {
    artifactMetadataBoundedText(value[field], `archive receipt ${field}`);
  }
  for (const field of ['requestDigest', 'eventHash', 'sealedThroughEventHash', 'v3InventoryDigest'] as const) {
    if (typeof value[field] !== 'string' || !ARTIFACT_SHA256_RE.test(value[field])) {
      fail('integrity', `archive receipt ${field} is invalid`);
    }
  }
  if (!Number.isSafeInteger(value['eventSequence']) || !Number.isSafeInteger(value['sealedThroughSequence']) ||
      value['eventSequence'] !== value['sealedThroughSequence']) fail('integrity', 'archive receipt sequence is invalid');
  if (!['issue_capture_authorization', 'record_artifact', 'record_manifest', 'retire_artifact']
    .includes(String(value['mutationKind']))) fail('integrity', 'archive receipt mutation is invalid');
}

function digestInventoryRows(
  rows: Iterable<unknown>,
): { readonly count: number; readonly digest: string } {
  let count = 0;
  let digest = hashCanonicalJson({ schema: 'hercules-artifact-metadata-row-chain/v1' });
  for (const row of rows) {
    count += 1;
    digest = hashCanonicalJson({ previousDigest: digest, row });
  }
  return { count, digest };
}

export function artifactMetadataInventoryDigest(
  db: Database.Database,
  throughSequence?: number,
): string {
  const sequence = throughSequence ?? Number.MAX_SAFE_INTEGER;
  const byEvent = (table: string, order: string): Iterable<unknown> => db.prepare(
    `SELECT row_value.* FROM ${table} row_value
     JOIN control_events event ON event.event_id = row_value.event_id
     WHERE event.sequence <= ? ORDER BY ${order}`,
  ).iterate(sequence);
  const inventory = {
    schema: 'hercules-artifact-metadata-inventory/v1',
    artifact_archive_lineage: digestInventoryRows(db.prepare(
      'SELECT * FROM artifact_archive_lineage ORDER BY singleton',
    ).iterate()),
    artifact_capture_authorizations: digestInventoryRows(byEvent(
      'artifact_capture_authorizations',
      'row_value.authorization_id',
    )),
    artifact_content_policies: digestInventoryRows(db.prepare(`SELECT refs.sha256,
      CASE WHEN MAX(CASE refs.access_class WHEN 'restricted' THEN 1 ELSE 0 END) = 1
        THEN 'restricted' ELSE 'operator' END AS access_class
      FROM artifact_refs refs JOIN control_events event ON event.event_id = refs.event_id
      WHERE event.sequence <= ? GROUP BY refs.sha256 ORDER BY refs.sha256`).iterate(sequence)),
    artifact_refs: digestInventoryRows(byEvent('artifact_refs', 'row_value.artifact_ref_id')),
    artifact_candidate_bindings: digestInventoryRows(db.prepare(`SELECT binding.*
      FROM artifact_candidate_bindings binding
      WHERE
        (binding.owner_kind = 'capture_authorization' AND EXISTS (
          SELECT 1 FROM artifact_capture_authorizations owner
          JOIN control_events event ON event.event_id = owner.event_id
          WHERE owner.authorization_id = binding.owner_id AND event.sequence <= ?
        )) OR
        (binding.owner_kind = 'artifact_ref' AND EXISTS (
          SELECT 1 FROM artifact_refs owner JOIN control_events event ON event.event_id = owner.event_id
          WHERE owner.artifact_ref_id = binding.owner_id AND event.sequence <= ?
        )) OR
        (binding.owner_kind = 'manifest' AND EXISTS (
          SELECT 1 FROM evidence_manifests owner JOIN control_events event ON event.event_id = owner.event_id
          WHERE owner.manifest_id = binding.owner_id AND event.sequence <= ?
        ))
      ORDER BY binding.owner_kind, binding.owner_id`).iterate(sequence, sequence, sequence)),
    artifact_retirements: digestInventoryRows(byEvent(
      'artifact_retirements',
      'row_value.artifact_ref_id',
    )),
    evidence_manifests: digestInventoryRows(byEvent(
      'evidence_manifests',
      'row_value.manifest_id',
    )),
    evidence_manifest_entries: digestInventoryRows(db.prepare(`SELECT entry.*
      FROM evidence_manifest_entries entry
      JOIN evidence_manifests manifest ON manifest.manifest_id = entry.manifest_id
      JOIN control_events event ON event.event_id = manifest.event_id
      WHERE event.sequence <= ? ORDER BY entry.manifest_id, entry.ordinal`).iterate(sequence)),
    evidence_manifest_criteria: digestInventoryRows(db.prepare(`SELECT criterion.*
      FROM evidence_manifest_criteria criterion
      JOIN evidence_manifests manifest ON manifest.manifest_id = criterion.manifest_id
      JOIN control_events event ON event.event_id = manifest.event_id
      WHERE event.sequence <= ?
      ORDER BY criterion.manifest_id, criterion.artifact_ref_id, criterion.ordinal`).iterate(sequence)),
  };
  return hashCanonicalJson(inventory);
}

export class SqliteArtifactMetadataStore implements ArtifactMetadataStore {
  readonly #gate: ArtifactArchiveAdmissionGate;
  readonly #options: SqliteArtifactMetadataStoreOptions;
  readonly #failureInjector: ((point: ArtifactMetadataFailurePoint) => void) | undefined;
  #db: Database.Database | null = null;
  #lineage: ArtifactArchiveLineage | null = null;
  #initialized = false;
  #closed = false;
  /**
   * Highest sealed sequence whose mutation ↔ event ↔ receipt ↔ inventory chain
   * this instance has already verified (C3.48). Every commit re-runs
   * verifyIntegrity; re-deriving the inventory digest for every historical
   * mutation made each screenshot capture O(mutations × inventory) and
   * starved the event loop during a downstream project evidence intake (2026-09-12).
   * Rows below this mark are immutable facts verified once per process — the
   * same trust boundary as the store's read caches; a fresh instance (boot)
   * always re-verifies everything.
   */
  #verifiedThroughSequence = 0;
  /**
   * C3.54: V3 rows (authorizations, artifact refs, manifests, retirements) are
   * immutable (BEFORE UPDATE/DELETE → RAISE), so a row whose columns matched
   * its canonical payload once in this process never needs re-parsing. Every
   * `recordArtifact → verifyIntegrity` used to re-walk all rows (C3.48 had
   * memoized only the mutation chain) and starved the event loop while a
   * task archived dozens of screenshots. Cleared with the verified prefix; a
   * fresh instance (boot) re-verifies everything.
   */
  readonly #verifiedRowIds = {
    authorizations: new Set<string>(),
    artifactRefs: new Set<string>(),
    manifests: new Set<string>(),
    retirements: new Set<string>(),
  };
  #rowsScannedLastVerify = 0;

  /** Test/diagnostic observability for C3.54: rows parsed by the last verifyIntegrity. */
  verifyStats(): { readonly rowsScannedLastVerify: number; readonly verifiedThroughSequence: number } {
    return {
      rowsScannedLastVerify: this.#rowsScannedLastVerify,
      verifiedThroughSequence: this.#verifiedThroughSequence,
    };
  }

  #resetVerifiedRows(): void {
    this.#verifiedRowIds.authorizations.clear();
    this.#verifiedRowIds.artifactRefs.clear();
    this.#verifiedRowIds.manifests.clear();
    this.#verifiedRowIds.retirements.clear();
  }

  constructor(
    gate: ArtifactArchiveAdmissionGate,
    options: SqliteArtifactMetadataStoreOptions,
  ) {
    assertArtifactArchiveAdmissionGate(gate);
    this.#gate = gate;
    const optionSnapshot = readExactOwnRecord(
      options,
      ['trustedRoot', 'databasePath'],
      'artifact metadata options',
      ['busyTimeoutMs', 'failureInjector'],
    );
    if (typeof optionSnapshot['trustedRoot'] !== 'string' || typeof optionSnapshot['databasePath'] !== 'string') {
      fail('invalid_input', 'artifact metadata paths are invalid');
    }
    if (optionSnapshot['busyTimeoutMs'] !== undefined &&
        (!Number.isSafeInteger(optionSnapshot['busyTimeoutMs']) || Number(optionSnapshot['busyTimeoutMs']) < 1 ||
          Number(optionSnapshot['busyTimeoutMs']) > 60_000)) {
      fail('invalid_input', 'artifact metadata busy timeout is invalid');
    }
    if (optionSnapshot['failureInjector'] !== undefined && typeof optionSnapshot['failureInjector'] !== 'function') {
      fail('invalid_input', 'artifact metadata failure injector is invalid');
    }
    this.#options = {
      trustedRoot: optionSnapshot['trustedRoot'],
      databasePath: optionSnapshot['databasePath'],
      ...(optionSnapshot['busyTimeoutMs'] === undefined ? {} : { busyTimeoutMs: Number(optionSnapshot['busyTimeoutMs']) }),
      ...(optionSnapshot['failureInjector'] === undefined ? {} : {
        failureInjector: optionSnapshot['failureInjector'] as (point: ArtifactMetadataFailurePoint) => void,
      }),
    };
    this.#failureInjector = optionSnapshot['failureInjector'] as ((point: ArtifactMetadataFailurePoint) => void) | undefined;
  }

  initialize(token: ArtifactArchiveAdmissionToken, input: ArtifactArchiveLineage): ArtifactMetadataIntegrityReport {
    this.#authorize(token);
    if (this.#closed) fail('closed', 'artifact metadata store is closed');
    const lineage = validateArtifactArchiveLineage(input);
    if (!isAbsolute(lineage.artifactRoot) || resolve(lineage.artifactRoot) !== lineage.artifactRoot) {
      fail('invalid_input', 'artifact root lineage must be an absolute normalized path');
    }
    if (this.#initialized) {
      if (!canonicalEqual(this.#lineage, lineage)) fail('integrity', 'artifact archive lineage changed');
      return this.verifyIntegrity(token);
    }
    const bootstrap = new SqliteStateStore({
      trustedRoot: this.#options.trustedRoot,
      databasePath: this.#options.databasePath,
      ...(this.#options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: this.#options.busyTimeoutMs }),
    });
    try {
      bootstrap.initialize();
    } finally {
      bootstrap.close();
    }
    try {
      const db = new Database(this.#options.databasePath);
      this.#db = db;
      db.pragma('foreign_keys = ON');
      db.pragma(`busy_timeout = ${this.#options.busyTimeoutMs ?? 2_000}`);
      db.pragma('synchronous = FULL');
      if (String(db.pragma('journal_mode = WAL', { simple: true })).toLowerCase() !== 'wal') {
        fail('integrity', 'artifact metadata requires WAL mode');
      }
      const existing = db.prepare('SELECT payload_json FROM artifact_archive_lineage WHERE singleton = 1')
        .get() as PayloadRow | undefined;
      if (existing === undefined) {
        db.prepare(`INSERT INTO artifact_archive_lineage (
          singleton, database_lineage_id, artifact_root, root_device, root_inode, payload_json
        ) VALUES (1, ?, ?, ?, ?, ?)`).run(
          lineage.databaseLineageId, lineage.artifactRoot, lineage.rootDevice, lineage.rootInode,
          canonicalSerialize(lineage),
        );
      } else {
        const persisted = parseCanonical<ArtifactArchiveLineage>(existing.payload_json, 'archive lineage');
        if (!canonicalEqual(persisted, lineage)) fail('integrity', 'artifact archive lineage changed');
      }
      this.#lineage = lineage;
      this.#initialized = true;
      return this.verifyIntegrity(token);
    } catch (error) {
      this.#db?.close();
      this.#db = null;
      this.#lineage = null;
      this.#initialized = false;
      mapSqliteError(error);
    }
  }

  readLineage(token: ArtifactArchiveAdmissionToken): ArtifactArchiveLineage {
    this.#authorize(token);
    this.#ready();
    if (this.#lineage === null) fail('not_initialized', 'artifact archive lineage is unavailable');
    return canonicalClone(this.#lineage);
  }

  issueCaptureAuthorization(token: ArtifactArchiveAdmissionToken, input: IssueCaptureAuthorizationCommand): ArtifactMetadataCommitReceipt {
    this.#authorize(token);
    const command = validateIssueCaptureAuthorizationCommand(input);
    return this.#commit(token, command, {
      eventType: 'ArtifactCaptureAuthorized',
      aggregateKind: 'artifact_authorization',
      aggregateId: command.authorization.id,
      mutationKind: 'issue_capture_authorization',
      record: command.authorization,
    }, (db, event) => this.#insertAuthorization(db, command.authorization, event));
  }

  recordArtifact(token: ArtifactArchiveAdmissionToken, input: RecordArtifactMetadataCommand): ArtifactMetadataCommitReceipt {
    this.#authorize(token);
    const command = validateRecordArtifactMetadataCommand(input);
    return this.#commit(token, command, {
      eventType: 'ArtifactMetadataRecorded',
      aggregateKind: 'artifact_ref',
      aggregateId: command.artifact.id,
      mutationKind: 'record_artifact',
      record: command.artifact,
    }, (db, event) => this.#insertArtifact(db, command, event));
  }

  recordManifest(token: ArtifactArchiveAdmissionToken, input: RecordEvidenceManifestMetadataCommand): ArtifactMetadataCommitReceipt {
    this.#authorize(token);
    const command = validateRecordEvidenceManifestMetadataCommand(input);
    return this.#commit(token, command, {
      eventType: 'EvidenceManifestRecorded',
      aggregateKind: 'evidence_manifest',
      aggregateId: command.manifest.id,
      mutationKind: 'record_manifest',
      record: command.manifest,
    }, (db, event) => this.#insertManifest(db, command.manifest, event));
  }

  retireArtifact(token: ArtifactArchiveAdmissionToken, input: RetireArtifactMetadataCommand): ArtifactMetadataCommitReceipt {
    this.#authorize(token);
    const command = validateRetireArtifactMetadataCommand(input);
    return this.#commit(token, command, {
      eventType: 'ArtifactMetadataRetired',
      aggregateKind: 'artifact_ref',
      aggregateId: command.retirement.artifactRefId,
      mutationKind: 'retire_artifact',
      record: command.retirement,
    }, (db, event) => this.#insertRetirement(db, command.retirement, event));
  }

  readAuthorization(token: ArtifactArchiveAdmissionToken, id: string): ArtifactCaptureAuthorizationRecord | null {
    this.#authorize(token);
    artifactMetadataBoundedText(id, 'authorization id');
    const row = this.#ready().prepare(
      'SELECT payload_json FROM artifact_capture_authorizations WHERE authorization_id = ?',
    ).get(id) as PayloadRow | undefined;
    if (row === undefined) return null;
    return canonicalClone(this.#parseAuthorization(row.payload_json));
  }

  readArtifact(token: ArtifactArchiveAdmissionToken, id: string): ArchivedArtifactMetadata | null {
    this.#authorize(token);
    artifactMetadataBoundedText(id, 'artifact id');
    const row = this.#ready().prepare('SELECT payload_json FROM artifact_refs WHERE artifact_ref_id = ?')
      .get(id) as PayloadRow | undefined;
    if (row === undefined) return null;
    return canonicalClone(this.#parseArtifact(row.payload_json));
  }

  readManifest(token: ArtifactArchiveAdmissionToken, id: string): ArchivedEvidenceMetadataManifest | null {
    this.#authorize(token);
    artifactMetadataBoundedText(id, 'manifest id');
    const row = this.#ready().prepare('SELECT payload_json FROM evidence_manifests WHERE manifest_id = ?')
      .get(id) as PayloadRow | undefined;
    if (row === undefined) return null;
    return canonicalClone(this.#parseManifest(row.payload_json));
  }

  listAuthorizations(
    token: ArtifactArchiveAdmissionToken,
    afterId: string | null,
    limit: number,
  ): ArtifactMetadataPage<ArtifactCaptureAuthorizationRecord> {
    this.#authorize(token);
    const page = this.#pageBounds(afterId, limit, 'authorization cursor');
    const rows = this.#ready().prepare(`SELECT authorization_id, payload_json
      FROM artifact_capture_authorizations WHERE authorization_id > ?
      ORDER BY authorization_id LIMIT ?`).all(page.cursor, page.fetch) as Array<{
        readonly authorization_id: string;
        readonly payload_json: string;
      }>;
    return this.#finishPage(rows, limit, (row) => this.#parseAuthorization(row.payload_json),
      (row) => row.authorization_id);
  }

  listContentPolicies(
    token: ArtifactArchiveAdmissionToken,
    afterDigest: string | null,
    limit: number,
  ): ArtifactMetadataPage<ArtifactContentPolicyRecord> {
    this.#authorize(token);
    const page = this.#pageBounds(afterDigest, limit, 'content policy cursor');
    const rows = this.#ready().prepare(`SELECT sha256, access_class FROM artifact_content_policies
      WHERE sha256 > ? ORDER BY sha256 LIMIT ?`).all(page.cursor, page.fetch) as Array<{
        readonly sha256: string;
        readonly access_class: ArtifactContentPolicyRecord['accessClass'];
      }>;
    return this.#finishPage(rows, limit, (row) => ({
      sha256: row.sha256,
      accessClass: row.access_class,
    }), (row) => row.sha256);
  }

  listCandidateBindings(
    token: ArtifactArchiveAdmissionToken,
    afterKey: string | null,
    limit: number,
  ): ArtifactMetadataPage<ArtifactCandidateBindingRecord> {
    this.#authorize(token);
    const [ownerKind, ownerId] = this.#parseCompositeCursor(afterKey, 2, 'candidate binding cursor');
    const fetch = this.#pageLimit(limit) + 1;
    const rows = this.#ready().prepare(`SELECT owner_kind, owner_id, candidate_json,
      protected_artifact_ref_id, candidate_artifact_ref_id, candidate_artifact_sha256,
      protection_expires_at FROM artifact_candidate_bindings
      WHERE owner_kind > ? OR (owner_kind = ? AND owner_id > ?)
      ORDER BY owner_kind, owner_id LIMIT ?`).all(ownerKind, ownerKind, ownerId, fetch) as Array<{
        readonly owner_kind: ArtifactCandidateBindingRecord['ownerKind'];
        readonly owner_id: string;
        readonly candidate_json: string;
        readonly protected_artifact_ref_id: string | null;
        readonly candidate_artifact_ref_id: string | null;
        readonly candidate_artifact_sha256: string | null;
        readonly protection_expires_at: string | null;
      }>;
    return this.#finishPage(rows, limit, (row) => ({
      ownerKind: row.owner_kind,
      ownerId: row.owner_id,
      candidateRef: parseCanonical<CandidateRef>(row.candidate_json, 'candidate binding'),
      protectedArtifactRefId: row.protected_artifact_ref_id,
      candidateArtifactRefId: row.candidate_artifact_ref_id,
      candidateArtifactSha256: row.candidate_artifact_sha256,
      protectionExpiresAt: row.protection_expires_at,
    }), (row) => canonicalSerialize([row.owner_kind, row.owner_id]));
  }

  listArtifactRefs(
    token: ArtifactArchiveAdmissionToken,
    afterId: string | null,
    limit: number,
  ): ArtifactMetadataPage<ArtifactMetadataRefState> {
    this.#authorize(token);
    const page = this.#pageBounds(afterId, limit, 'artifact ref cursor');
    const rows = this.#ready().prepare(`SELECT a.artifact_ref_id, a.payload_json,
      r.payload_json AS retirement_json FROM artifact_refs a
      LEFT JOIN artifact_retirements r ON r.artifact_ref_id = a.artifact_ref_id
      WHERE a.artifact_ref_id > ? ORDER BY a.artifact_ref_id LIMIT ?`)
      .all(page.cursor, page.fetch) as Array<{
        readonly artifact_ref_id: string;
        readonly payload_json: string;
        readonly retirement_json: string | null;
      }>;
    return this.#finishPage(rows, limit, (row) => ({
      artifact: this.#parseArtifact(row.payload_json),
      retirement: row.retirement_json === null
        ? null
        : this.#parseRetirement(row.retirement_json),
    }), (row) => row.artifact_ref_id);
  }

  listRetentionCandidates(
    token: ArtifactArchiveAdmissionToken,
    cutoff: string,
    at: string,
    afterId: string | null,
    limit: number,
  ): ArtifactMetadataPage<ArchivedArtifactMetadata> {
    this.#authorize(token);
    canonicalArtifactTimestamp(cutoff, 'retention cutoff');
    canonicalArtifactTimestamp(at, 'retention time');
    const page = this.#pageBounds(afterId, limit, 'retention cursor');
    const rows = this.#ready().prepare(`SELECT a.artifact_ref_id, a.payload_json
      FROM artifact_refs a
      WHERE a.artifact_ref_id > ? AND a.created_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM artifact_retirements r WHERE r.artifact_ref_id = a.artifact_ref_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM evidence_manifest_entries e WHERE e.artifact_ref_id = a.artifact_ref_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM artifact_candidate_bindings b
          WHERE (b.protected_artifact_ref_id = a.artifact_ref_id
              OR b.candidate_artifact_ref_id = a.artifact_ref_id)
            AND (b.protection_expires_at IS NULL OR b.protection_expires_at >= ?)
        )
      ORDER BY a.artifact_ref_id LIMIT ?`).all(
        page.cursor,
        cutoff,
        at,
        page.fetch,
      ) as Array<{ readonly artifact_ref_id: string; readonly payload_json: string }>;
    return this.#finishPage(
      rows,
      limit,
      (row) => this.#parseArtifact(row.payload_json),
      (row) => row.artifact_ref_id,
    );
  }

  listManifests(
    token: ArtifactArchiveAdmissionToken,
    afterId: string | null,
    limit: number,
  ): ArtifactMetadataPage<ArchivedEvidenceMetadataManifest> {
    this.#authorize(token);
    const page = this.#pageBounds(afterId, limit, 'manifest cursor');
    const rows = this.#ready().prepare(`SELECT manifest_id, payload_json FROM evidence_manifests
      WHERE manifest_id > ? ORDER BY manifest_id LIMIT ?`).all(page.cursor, page.fetch) as Array<{
        readonly manifest_id: string;
        readonly payload_json: string;
      }>;
    return this.#finishPage(rows, limit, (row) => this.#parseManifest(row.payload_json),
      (row) => row.manifest_id);
  }

  listManifestCriteria(
    token: ArtifactArchiveAdmissionToken,
    afterKey: string | null,
    limit: number,
  ): ArtifactMetadataPage<ArtifactManifestCriterionRecord> {
    this.#authorize(token);
    const [manifestId, artifactRefId, ordinalText] = this.#parseCompositeCursor(
      afterKey,
      3,
      'manifest criterion cursor',
    );
    const ordinal = ordinalText === '' ? -1 : Number(ordinalText);
    if (!Number.isSafeInteger(ordinal) || ordinal < -1) fail('invalid_input', 'criterion cursor is invalid');
    const fetch = this.#pageLimit(limit) + 1;
    const rows = this.#ready().prepare(`SELECT manifest_id, artifact_ref_id, task_id,
      contract_version, criterion_id, ordinal FROM evidence_manifest_criteria
      WHERE manifest_id > ?
        OR (manifest_id = ? AND artifact_ref_id > ?)
        OR (manifest_id = ? AND artifact_ref_id = ? AND ordinal > ?)
      ORDER BY manifest_id, artifact_ref_id, ordinal LIMIT ?`).all(
        manifestId, manifestId, artifactRefId, manifestId, artifactRefId, ordinal, fetch,
      ) as Array<{
        readonly manifest_id: string;
        readonly artifact_ref_id: string;
        readonly task_id: string;
        readonly contract_version: number;
        readonly criterion_id: string;
        readonly ordinal: number;
      }>;
    const normalized = rows.map((row) => ({
      manifestId: row.manifest_id,
      artifactRefId: row.artifact_ref_id,
      taskId: row.task_id,
      contractVersion: row.contract_version,
      criterionId: row.criterion_id,
      ordinal: row.ordinal,
    }));
    return this.#finishPage(normalized, limit, (row) => row, (row) => canonicalSerialize([
      row.manifestId,
      row.artifactRefId,
      String(row.ordinal),
    ]));
  }

  readSealedMutation(token: ArtifactArchiveAdmissionToken, sequence: number): ArtifactSealedMutationSnapshot | null {
    this.#authorize(token);
    if (!Number.isSafeInteger(sequence) || sequence < 1) fail('invalid_input', 'sealed sequence is invalid');
    const db = this.#ready();
    try {
      return db.transaction(() => {
        this.verifyIntegrity(token);
        const row = db.prepare(`${SEALED_MUTATION_SELECT}
          WHERE m.sealed_through_sequence = ?`).get(sequence) as SealedMutationRow | undefined;
        if (row === undefined) return null;
        return this.#sealedMutationSnapshot(row);
      }).immediate();
    } catch (error) {
      mapSqliteError(error);
    }
  }

  /**
   * Every sealed mutation, ascending by sealed sequence, behind ONE integrity
   * pass. `readSealedMutation` verifies the whole store on every call, so a
   * loop over anchors or sequences is O(anchors × mutations × inventory) —
   * ~30 min of boot on production with 260 anchors (2026-09-09).
   */
  readSealedMutations(token: ArtifactArchiveAdmissionToken): readonly ArtifactSealedMutationSnapshot[] {
    this.#authorize(token);
    const db = this.#ready();
    try {
      return db.transaction(() => {
        this.verifyIntegrity(token);
        const rows = db.prepare(`${SEALED_MUTATION_SELECT}
          ORDER BY m.sealed_through_sequence`).all() as SealedMutationRow[];
        return rows.map((row) => this.#sealedMutationSnapshot(row));
      }).immediate();
    } catch (error) {
      mapSqliteError(error);
    }
  }

  #sealedMutationSnapshot(row: SealedMutationRow): ArtifactSealedMutationSnapshot {
    const mutation: ArtifactSealedMutationRecord = {
      mutationKind: row['mutation_kind'] as ArtifactSealedMutationRecord['mutationKind'],
      aggregateId: String(row['aggregate_id']),
      requestDigest: String(row['request_digest']),
      sealedThroughSequence: Number(row['sealed_through_sequence']),
      sealedThroughEventHash: String(row['sealed_through_event_hash']),
      v3InventoryDigest: String(row['v3_inventory_digest']),
    };
    const receipt = this.#parseReceipt({
      idempotency_key: String(row['idempotency_key']),
      request_digest: mutation.requestDigest,
      event_id: String(row['event_id']),
      result_json: String(row['result_json']),
      committed_at: String(row['committed_at']),
    });
    return canonicalClone({ mutation, receipt });
  }

  readDigestInventory(
    token: ArtifactArchiveAdmissionToken,
    at: string,
    afterDigest: string | null,
    limit: number,
  ): ArtifactMetadataPage<ArtifactDigestInventoryRecord> {
    this.#authorize(token);
    canonicalArtifactTimestamp(at, 'digest inventory time');
    const page = this.#pageBounds(afterDigest, limit, 'digest inventory cursor');
    const db = this.#ready();
    const rows = db.prepare(`SELECT sha256, access_class FROM artifact_content_policies
      WHERE sha256 > ? ORDER BY sha256 LIMIT ?`).all(page.cursor, page.fetch) as Array<{
        readonly sha256: string;
        readonly access_class: ArtifactDigestInventoryRecord['accessClass'];
      }>;
    const values = rows.map((row) => ({
      sha256: row.sha256,
      activeArtifactRefIds: this.#boundedPluck(db, `SELECT artifact_ref_id FROM artifact_refs a
        WHERE sha256 = ? AND NOT EXISTS (
          SELECT 1 FROM artifact_retirements r WHERE r.artifact_ref_id = a.artifact_ref_id
        ) ORDER BY artifact_ref_id LIMIT 4097`, [row.sha256], 'active artifact aliases'),
      manifestArtifactRefIds: this.#boundedPluck(db, `SELECT DISTINCT e.artifact_ref_id
        FROM evidence_manifest_entries e JOIN artifact_refs a ON a.artifact_ref_id = e.artifact_ref_id
        WHERE a.sha256 = ? ORDER BY e.artifact_ref_id LIMIT 4097`, [row.sha256], 'manifest artifact aliases'),
      liveCandidateOwnerIds: this.#boundedPluck(db, `SELECT b.owner_kind || ':' || b.owner_id
        FROM artifact_candidate_bindings b LEFT JOIN artifact_refs a
          ON a.artifact_ref_id = b.protected_artifact_ref_id
          OR a.artifact_ref_id = b.candidate_artifact_ref_id
        WHERE a.sha256 = ? AND (b.protection_expires_at IS NULL OR b.protection_expires_at >= ?)
        ORDER BY b.owner_kind, b.owner_id LIMIT 4097`, [row.sha256, at], 'live candidate owners'),
      accessClass: row.access_class,
    }));
    return this.#finishPage(values, limit, (value) => value, (value) => value.sha256);
  }

  createConsistentSnapshot(token: ArtifactArchiveAdmissionToken): ArtifactMetadataSqliteSnapshot {
    this.#authorize(token);
    const db = this.#ready();
    try {
      const transaction = db.transaction(() => {
        this.verifyIntegrity(token);
        const bytes = offlineSnapshotBytes(Uint8Array.from(db.serialize()));
        const last = db.prepare('SELECT sequence, event_hash FROM control_events ORDER BY sequence DESC LIMIT 1')
          .get() as { readonly sequence: number; readonly event_hash: string } | undefined;
        return {
          bytes,
          databaseSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          eventCount: Number(db.prepare('SELECT COUNT(*) FROM control_events').pluck().get()),
          lastEventHash: last?.event_hash ?? null,
          v3InventoryDigest: artifactMetadataInventoryDigest(db),
        };
      });
      return transaction.immediate();
    } catch (error) {
      mapSqliteError(error);
    }
  }

  verifyIntegrity(token: ArtifactArchiveAdmissionToken): ArtifactMetadataIntegrityReport {
    this.#authorize(token);
    const db = this.#ready();
    try {
      if (db.pragma('quick_check', { simple: true }) !== 'ok' ||
          (db.pragma('foreign_key_check') as unknown[]).length !== 0) {
        fail('integrity', 'artifact metadata SQLite integrity check failed');
      }
      // Any failure in this pass invalidates both memos so the next call
      // re-checks everything (the throw still propagates); they are re-added
      // only when the whole pass succeeds (Codex C3.54 note).
      const verifiedThrough = this.#verifiedThroughSequence;
      this.#verifiedThroughSequence = 0;
      const verifiedRows = {
        authorizations: new Set(this.#verifiedRowIds.authorizations),
        artifactRefs: new Set(this.#verifiedRowIds.artifactRefs),
        manifests: new Set(this.#verifiedRowIds.manifests),
        retirements: new Set(this.#verifiedRowIds.retirements),
      };
      this.#resetVerifiedRows();
      this.#verifyLineage(db);
      this.#verifyRows(db, token, verifiedRows);
      const mutations = db.prepare(`SELECT event_id, mutation_kind, aggregate_id, request_digest,
        sealed_through_sequence, sealed_through_event_hash, v3_inventory_digest, payload_json
        FROM artifact_archive_mutations ORDER BY sealed_through_sequence`).iterate() as Iterable<Record<string, unknown>>;
      const mutationCount = this.#count(db, 'artifact_archive_mutations');
      if (mutationCount !== this.#count(db, 'artifact_archive_receipts')) {
        fail('integrity', 'archive mutation/receipt count differs');
      }
      const expectedMutationCount = this.#count(db, 'artifact_capture_authorizations') +
        this.#count(db, 'artifact_refs') + this.#count(db, 'evidence_manifests') +
        this.#count(db, 'artifact_retirements');
      if (mutationCount !== expectedMutationCount) {
        fail('integrity', 'archive mutations do not close every and only V3 aggregate');
      }
      let previousSequence = 0;
      let latest: Record<string, unknown> | undefined;
      for (const mutation of mutations) {
        const sealedThrough = Number(mutation['sealed_through_sequence']);
        if (sealedThrough <= verifiedThrough) {
          if (!Number.isSafeInteger(sealedThrough) || sealedThrough <= previousSequence) {
            fail('integrity', 'archive mutation order regressed inside the verified prefix');
          }
          previousSequence = sealedThrough;
          latest = mutation;
          continue;
        }
        const eventId = String(mutation['event_id']);
        const event = this.#readEvent(db, eventId);
        const row = db.prepare(`SELECT idempotency_key, request_digest, event_id, result_json,
          committed_at FROM artifact_archive_receipts WHERE event_id = ?`).get(eventId) as ReceiptRow | undefined;
        if (row === undefined) fail('integrity', 'archive mutation receipt is missing');
        const receipt = this.#parseReceipt(row);
        const reproducedDigest = this.#reproduceRequestDigest(receipt, event);
        const expectedReceipt: ArtifactMetadataCommitReceipt = {
          idempotencyKey: row.idempotency_key,
          requestDigest: reproducedDigest,
          eventId: event.eventId,
          eventSequence: event.sequence,
          eventHash: event.eventHash,
          mutationKind: String(mutation['mutation_kind']) as ArtifactMetadataMutationKind,
          aggregateId: String(mutation['aggregate_id']),
          committedAt: event.occurredAt,
          sealedThroughSequence: event.sequence,
          sealedThroughEventHash: event.eventHash,
          v3InventoryDigest: String(mutation['v3_inventory_digest']),
        };
        if (event.sequence !== Number(mutation['sealed_through_sequence']) ||
            event.eventHash !== mutation['sealed_through_event_hash'] ||
            event.sequence <= previousSequence || receipt.eventSequence !== event.sequence ||
            receipt.eventHash !== event.eventHash || receipt.v3InventoryDigest !== mutation['v3_inventory_digest'] ||
            receipt.requestDigest !== mutation['request_digest'] || receipt.aggregateId !== mutation['aggregate_id'] ||
            receipt.mutationKind !== mutation['mutation_kind'] ||
            receipt.committedAt !== event.occurredAt ||
            !canonicalEqual(receipt, expectedReceipt) ||
            mutation['v3_inventory_digest'] !== artifactMetadataInventoryDigest(db, event.sequence)) {
          fail('integrity', 'archive mutation, event, and receipt are inconsistent');
        }
        const payload = parseCanonical<Record<string, unknown>>(String(mutation['payload_json']), `archive mutation ${eventId}`);
        if (!canonicalEqual(payload, {
          aggregateId: receipt.aggregateId,
          mutationKind: receipt.mutationKind,
          requestDigest: receipt.requestDigest,
          sealedThroughEventHash: receipt.sealedThroughEventHash,
          sealedThroughSequence: receipt.sealedThroughSequence,
          v3InventoryDigest: receipt.v3InventoryDigest,
        })) fail('integrity', 'archive mutation payload differs from receipt');
        previousSequence = event.sequence;
        latest = mutation;
      }
      const currentInventoryDigest = artifactMetadataInventoryDigest(db);
      // C3.54 (Codex blocker): every V3 write seals the inventory digest in
      // its mutation, so the live inventory must equal the latest seal. Any
      // out-of-band row (e.g. a manifest entry inserted without a mutation —
      // the insert triggers alone permit it) changes the digest and fails the
      // pass, which is what makes skipping already-verified rows sound.
      if (latest !== undefined && currentInventoryDigest !== String(latest['v3_inventory_digest'])) {
        fail('integrity', 'V3 inventory differs from the latest sealed mutation');
      }
      this.#verifiedThroughSequence = previousSequence;
      for (const key of ['authorizations', 'artifactRefs', 'manifests', 'retirements'] as const) {
        for (const id of verifiedRows[key]) this.#verifiedRowIds[key].add(id);
      }
      return {
        schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
        databaseLineageId: this.#lineage!.databaseLineageId,
        authorizationCount: this.#count(db, 'artifact_capture_authorizations'),
        artifactRefCount: this.#count(db, 'artifact_refs'),
        manifestCount: this.#count(db, 'evidence_manifests'),
        retirementCount: this.#count(db, 'artifact_retirements'),
        archiveMutationCount: mutationCount,
        lastSealedSequence: latest === undefined ? null : Number(latest['sealed_through_sequence']),
        lastSealedEventHash: latest === undefined ? null : String(latest['sealed_through_event_hash']),
        v3InventoryDigest: currentInventoryDigest,
      };
    } catch (error) {
      mapSqliteError(error);
    }
  }

  close(token: ArtifactArchiveAdmissionToken): void {
    this.#authorize(token);
    if (this.#closed) return;
    this.#db?.close();
    this.#db = null;
    this.#initialized = false;
    this.#closed = true;
  }

  #commit<T extends { readonly idempotencyKey: string; readonly event: ControlEvent['actor'] extends never ? never : unknown }>(
    token: ArtifactArchiveAdmissionToken,
    command: T & { readonly event: { readonly eventId: string; readonly actor: ControlEvent['actor']; readonly occurredAt: string } },
    parts: ArchiveEventParts,
    project: (db: Database.Database, event: ControlEvent) => void,
  ): ArtifactMetadataCommitReceipt {
    const db = this.#ready();
    const digest = artifactMetadataCommandDigest(command);
    try {
      this.verifyIntegrity(token);
      const transaction = db.transaction(() => {
        const existing = db.prepare(`SELECT idempotency_key, request_digest, event_id, result_json,
          committed_at FROM artifact_archive_receipts WHERE idempotency_key = ?`)
          .get(command.idempotencyKey) as ReceiptRow | undefined;
        if (existing !== undefined) {
          if (existing.request_digest !== digest) {
            fail('idempotency_conflict', 'archive idempotency key was reused for another command');
          }
          return this.#parseReceipt(existing);
        }
        const previous = db.prepare('SELECT event_hash FROM control_events ORDER BY sequence DESC LIMIT 1')
          .get() as { readonly event_hash: string } | undefined;
        const sequence = Number(db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 FROM control_events').pluck().get());
        const event = buildControlEvent({
          sequence,
          eventId: command.event.eventId,
          eventType: parts.eventType,
          aggregateKind: parts.aggregateKind,
          aggregateId: parts.aggregateId,
          actor: command.event.actor,
          occurredAt: command.event.occurredAt,
          payload: { mutationKind: parts.mutationKind, record: parts.record },
          previousEventHash: previous?.event_hash ?? null,
        });
        db.prepare(`INSERT INTO control_events (
          sequence, event_id, event_type, aggregate_kind, aggregate_id, actor_kind, actor_id,
          occurred_at, payload_json, previous_event_hash, event_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          event.sequence, event.eventId, event.eventType, event.aggregateKind, event.aggregateId,
          event.actor.kind, event.actor.id, event.occurredAt, canonicalSerialize(event.payload),
          event.previousEventHash, event.eventHash,
        );
        this.#inject('after_event');
        project(db, event);
        this.#inject('after_projection');
        const inventoryDigest = artifactMetadataInventoryDigest(db, event.sequence);
        this.#inject('after_inventory');
        const mutationPayload = {
          aggregateId: parts.aggregateId,
          mutationKind: parts.mutationKind,
          requestDigest: digest,
          sealedThroughEventHash: event.eventHash,
          sealedThroughSequence: event.sequence,
          v3InventoryDigest: inventoryDigest,
        };
        db.prepare(`INSERT INTO artifact_archive_mutations (
          event_id, mutation_kind, aggregate_id, request_digest, sealed_through_sequence,
          sealed_through_event_hash, v3_inventory_digest, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          event.eventId, parts.mutationKind, parts.aggregateId, digest, event.sequence,
          event.eventHash, inventoryDigest, canonicalSerialize(mutationPayload),
        );
        const receipt: ArtifactMetadataCommitReceipt = {
          idempotencyKey: command.idempotencyKey,
          requestDigest: digest,
          eventId: event.eventId,
          eventSequence: event.sequence,
          eventHash: event.eventHash,
          mutationKind: parts.mutationKind,
          aggregateId: parts.aggregateId,
          committedAt: event.occurredAt,
          sealedThroughSequence: event.sequence,
          sealedThroughEventHash: event.eventHash,
          v3InventoryDigest: inventoryDigest,
        };
        db.prepare(`INSERT INTO artifact_archive_receipts (
          idempotency_key, request_digest, event_id, result_json, committed_at
        ) VALUES (?, ?, ?, ?, ?)`).run(
          receipt.idempotencyKey, receipt.requestDigest, receipt.eventId,
          canonicalSerialize(receipt), receipt.committedAt,
        );
        this.#inject('before_commit');
        return receipt;
      });
      const receipt = canonicalClone(transaction.immediate());
      this.#inject('after_commit');
      this.verifyIntegrity(token);
      return receipt;
    } catch (error) {
      mapSqliteError(error);
    }
  }

  #insertAuthorization(
    db: Database.Database,
    authorization: ArtifactCaptureAuthorizationRecord,
    event: ControlEvent,
  ): void {
    const stage = db.prepare(`SELECT iteration_id, stage_type, payload_json
      FROM shadow_stage_runs WHERE stage_run_id = ?`).get(authorization.producerStageRunId) as
      { readonly iteration_id: string; readonly stage_type: string; readonly payload_json: string } | undefined;
    if (stage === undefined || stage.iteration_id !== authorization.iterationId) {
      fail('constraint', 'capture authorization producer stage does not match its iteration');
    }
    const iteration = db.prepare('SELECT payload_json FROM shadow_iterations WHERE iteration_id = ?')
      .get(authorization.iterationId) as PayloadRow | undefined;
    if (iteration === undefined) fail('constraint', 'capture authorization iteration is missing');
    const iterationPayload = parseCanonical<{
      readonly taskId: string;
      readonly contractVersion: number;
      readonly candidateRef: CandidateRef | null;
    }>(
      iteration.payload_json,
      `iteration ${authorization.iterationId}`,
    );
    if (iterationPayload.taskId !== authorization.taskId ||
        iterationPayload.contractVersion !== authorization.contractVersion ||
        iterationPayload.candidateRef === null ||
        !canonicalEqual(iterationPayload.candidateRef, authorization.candidateRef)) {
      fail('constraint', 'capture authorization candidate differs from the iteration candidate');
    }
    if (authorization.maximumTrustClass === 'primary' && stage.stage_type !== 'verify') {
      fail('constraint', 'only a verify stage can receive primary trust authority');
    }
    this.#assertCandidateArtifactActive(db, authorization.candidateRef);
    const candidate = candidateParts(authorization.candidateRef);
    db.prepare(`INSERT INTO artifact_capture_authorizations (
      authorization_id, artifact_ref_id, task_id, contract_version, iteration_id,
      producer_stage_run_id, candidate_kind,
      candidate_json, media_type, max_byte_length, environment_ref, surface, max_trust_class,
      access_class, issuer, issued_at, expires_at, event_id, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      authorization.id, authorization.artifactRefId, authorization.taskId,
      authorization.contractVersion, authorization.iterationId,
      authorization.producerStageRunId, candidate.kind, candidate.json, authorization.mediaType,
      authorization.maximumByteLength, authorization.environmentRef, authorization.surface,
      authorization.maximumTrustClass, authorization.accessClass, authorization.issuer,
      authorization.issuedAt, authorization.expiresAt, event.eventId,
      canonicalSerialize(authorization),
    );
    db.prepare(`INSERT INTO artifact_candidate_bindings (
      owner_kind, owner_id, candidate_kind, candidate_json, protected_artifact_ref_id,
      candidate_artifact_ref_id, candidate_artifact_sha256, protection_expires_at
    ) VALUES ('capture_authorization', ?, ?, ?, NULL, ?, ?, ?)`).run(
      authorization.id, candidate.kind, candidate.json, candidate.artifactRefId,
      candidate.artifactSha256, authorization.expiresAt,
    );
  }

  #insertArtifact(db: Database.Database, command: RecordArtifactMetadataCommand, event: ControlEvent): void {
    const artifact = command.artifact;
    const authRow = db.prepare('SELECT payload_json FROM artifact_capture_authorizations WHERE authorization_id = ?')
      .get(artifact.captureAuthorizationId) as PayloadRow | undefined;
    if (authRow === undefined) fail('constraint', 'artifact capture authorization is missing');
    const authorization = this.#parseAuthorization(authRow.payload_json);
    if (db.prepare('SELECT 1 FROM artifact_refs WHERE capture_authorization_id = ?')
      .get(authorization.id) !== undefined) fail('constraint', 'capture authorization was already consumed');
    if (artifact.id !== authorization.artifactRefId ||
        artifact.producerStageRunId !== authorization.producerStageRunId ||
        artifact.mediaType !== authorization.mediaType || artifact.byteLength > authorization.maximumByteLength ||
        artifact.environmentRef !== authorization.environmentRef || artifact.surface !== authorization.surface ||
        !canonicalEqual(artifact.captureCandidateRef, authorization.candidateRef) ||
        trustClassRank(artifact.trustClass) > trustClassRank(authorization.maximumTrustClass) ||
        (authorization.accessClass === 'restricted' && artifact.accessClass !== 'restricted') ||
        artifact.observedAt < authorization.issuedAt || artifact.observedAt > artifact.createdAt ||
        artifact.createdAt > authorization.expiresAt) {
      fail('constraint', 'artifact metadata exceeds or differs from capture authorization');
    }
    this.#assertCandidateArtifactActive(db, artifact.captureCandidateRef);
    const policy = db.prepare('SELECT access_class FROM artifact_content_policies WHERE sha256 = ?')
      .get(artifact.sha256) as { readonly access_class: string } | undefined;
    if (policy === undefined) {
      db.prepare('INSERT INTO artifact_content_policies (sha256, access_class) VALUES (?, ?)')
        .run(artifact.sha256, artifact.accessClass);
    } else if (policy.access_class === 'operator' && artifact.accessClass === 'restricted') {
      const weakerManifest = db.prepare(`SELECT 1 FROM evidence_manifest_entries entry
        JOIN artifact_refs ref ON ref.artifact_ref_id = entry.artifact_ref_id
        WHERE ref.sha256 = ? AND entry.access_class = 'operator' LIMIT 1`).get(artifact.sha256);
      if (weakerManifest !== undefined) {
        fail('constraint', 'restricted digest upgrade conflicts with an immutable operator manifest');
      }
      db.prepare('UPDATE artifact_content_policies SET access_class = ? WHERE sha256 = ?')
        .run('restricted', artifact.sha256);
    }
    const candidate = candidateParts(artifact.captureCandidateRef);
    db.prepare(`INSERT INTO artifact_refs (
      artifact_ref_id, sha256, media_type, byte_length, storage_key, capture_authorization_id,
      candidate_kind, candidate_json, producer_stage_run_id, created_at, observed_at,
      environment_ref, surface, trust_class, redaction_state, access_class, event_id, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      artifact.id, artifact.sha256, artifact.mediaType, artifact.byteLength, artifact.storageKey,
      artifact.captureAuthorizationId, candidate.kind, candidate.json, artifact.producerStageRunId,
      artifact.createdAt, artifact.observedAt, artifact.environmentRef, artifact.surface,
      artifact.trustClass, artifact.redactionState, artifact.accessClass, event.eventId,
      canonicalSerialize(artifact),
    );
    db.prepare(`INSERT INTO artifact_candidate_bindings (
      owner_kind, owner_id, candidate_kind, candidate_json, protected_artifact_ref_id,
      candidate_artifact_ref_id, candidate_artifact_sha256, protection_expires_at
    ) VALUES ('artifact_ref', ?, ?, ?, ?, ?, ?, ?)`).run(
      artifact.id, candidate.kind, candidate.json, artifact.id, candidate.artifactRefId,
      candidate.artifactSha256, this.#artifactProtectionExpiry(artifact.createdAt),
    );
  }

  #insertManifest(db: Database.Database, manifest: ArchivedEvidenceMetadataManifest, event: ControlEvent): void {
    if (manifest.candidateRef.kind === 'artifact') {
      fail('constraint', 'artifact-kind manifest candidates require a future archive-coordinated advance');
    }
    const iterationRow = db.prepare('SELECT payload_json FROM shadow_iterations WHERE iteration_id = ?')
      .get(manifest.iterationId) as PayloadRow | undefined;
    if (iterationRow === undefined) fail('constraint', 'manifest iteration is missing');
    const iteration = parseCanonical<{
      readonly taskId: string;
      readonly contractVersion: number;
      readonly candidateRef: CandidateRef | null;
    }>(iterationRow.payload_json, `manifest iteration ${manifest.iterationId}`);
    if (iteration.taskId !== manifest.taskId || iteration.contractVersion !== manifest.contractVersion ||
        !canonicalEqual(iteration.candidateRef, manifest.candidateRef)) {
      fail('constraint', 'manifest task, contract, or candidate differs from its iteration');
    }
    const contractRow = db.prepare(`SELECT payload_json FROM shadow_task_contracts
      WHERE task_id = ? AND version = ?`).get(manifest.taskId, manifest.contractVersion) as PayloadRow | undefined;
    if (contractRow === undefined) fail('constraint', 'manifest contract is missing');
    const contract = parseCanonical<{ readonly acceptanceCriteria: readonly { readonly id: string }[] }>(
      contractRow.payload_json,
      `manifest contract ${manifest.taskId}/${manifest.contractVersion}`,
    );
    const criteria = new Set(contract.acceptanceCriteria.map((criterion) => criterion.id));
    const candidate = candidateParts(manifest.candidateRef);
    db.prepare(`INSERT INTO evidence_manifests (
      manifest_id, task_id, contract_version, iteration_id, candidate_kind, candidate_json,
      manifest_hash, created_at, event_id, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      manifest.id, manifest.taskId, manifest.contractVersion, manifest.iterationId,
      candidate.kind, candidate.json, manifest.manifestHash, manifest.createdAt, event.eventId,
      canonicalSerialize(manifest),
    );
    for (const [ordinal, entry] of manifest.entries.entries()) {
      const artifactRow = db.prepare(`SELECT payload_json FROM artifact_refs a
        WHERE artifact_ref_id = ? AND NOT EXISTS (
          SELECT 1 FROM artifact_retirements r WHERE r.artifact_ref_id = a.artifact_ref_id
        )`).get(entry.artifactRefId) as PayloadRow | undefined;
      if (artifactRow === undefined) fail('constraint', 'manifest artifact is missing or retired');
      const artifact = this.#parseArtifact(artifactRow.payload_json);
      const policy = String(db.prepare('SELECT access_class FROM artifact_content_policies WHERE sha256 = ?')
        .pluck().get(artifact.sha256));
      const stageRow = db.prepare('SELECT payload_json FROM shadow_stage_runs WHERE stage_run_id = ?')
        .get(artifact.producerStageRunId) as PayloadRow | undefined;
      const stage = stageRow === undefined ? null : parseCanonical<{
        readonly state: string;
        readonly outputArtifactRefs: readonly string[];
      }>(stageRow.payload_json, `producer stage ${artifact.producerStageRunId}`);
      if (!canonicalEqual(entry.candidateRef, manifest.candidateRef) ||
          !canonicalEqual(entry.candidateRef, artifact.captureCandidateRef) ||
          entry.observedAt !== artifact.observedAt || entry.environmentRef !== artifact.environmentRef ||
          entry.surface !== artifact.surface || entry.trustClass !== artifact.trustClass ||
          entry.redactionState !== artifact.redactionState || entry.accessClass !== policy ||
          stage?.state !== 'succeeded' || !stage.outputArtifactRefs.includes(artifact.id)) {
        fail('constraint', 'manifest entry differs from trusted artifact or producer facts');
      }
      for (const criterionId of entry.criterionIds) {
        if (!criteria.has(criterionId)) fail('constraint', 'manifest criterion does not exist in its contract');
      }
      db.prepare(`INSERT INTO evidence_manifest_entries (
        manifest_id, artifact_ref_id, ordinal, candidate_kind, candidate_json, observed_at,
        environment_ref, surface, trust_class, redaction_state, access_class, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        manifest.id, entry.artifactRefId, ordinal, candidate.kind, candidate.json,
        entry.observedAt, entry.environmentRef, entry.surface, entry.trustClass,
        entry.redactionState, entry.accessClass, canonicalSerialize(entry),
      );
      for (const [criterionOrdinal, criterionId] of entry.criterionIds.entries()) {
        db.prepare(`INSERT INTO evidence_manifest_criteria (
          manifest_id, artifact_ref_id, task_id, contract_version, criterion_id, ordinal
        ) VALUES (?, ?, ?, ?, ?, ?)`).run(
          manifest.id, entry.artifactRefId, manifest.taskId, manifest.contractVersion,
          criterionId, criterionOrdinal,
        );
      }
    }
    db.prepare(`INSERT INTO artifact_candidate_bindings (
      owner_kind, owner_id, candidate_kind, candidate_json, protected_artifact_ref_id,
      candidate_artifact_ref_id, candidate_artifact_sha256, protection_expires_at
    ) VALUES ('manifest', ?, ?, ?, NULL, NULL, NULL, NULL)`).run(
      manifest.id, candidate.kind, candidate.json,
    );
  }

  #insertRetirement(db: Database.Database, retirement: ArtifactMetadataRetirement, event: ControlEvent): void {
    const artifactRow = db.prepare('SELECT payload_json FROM artifact_refs WHERE artifact_ref_id = ?')
      .get(retirement.artifactRefId) as PayloadRow | undefined;
    if (artifactRow === undefined) fail('constraint', 'retirement artifact is missing');
    const artifact = this.#parseArtifact(artifactRow.payload_json);
    if (retirement.retiredAt < artifact.createdAt) fail('constraint', 'retirement predates artifact creation');
    if (db.prepare('SELECT 1 FROM artifact_retirements WHERE artifact_ref_id = ?')
      .get(retirement.artifactRefId) !== undefined) fail('constraint', 'artifact is already retired');
    if (db.prepare('SELECT 1 FROM evidence_manifest_entries WHERE artifact_ref_id = ?')
      .get(retirement.artifactRefId) !== undefined) fail('constraint', 'manifest evidence cannot be retired');
    if (db.prepare(`SELECT 1 FROM artifact_candidate_bindings
      WHERE (protected_artifact_ref_id = ? OR candidate_artifact_ref_id = ?)
        AND (protection_expires_at IS NULL OR protection_expires_at >= ?)`)
      .get(retirement.artifactRefId, retirement.artifactRefId, retirement.retiredAt) !== undefined) {
      fail('constraint', 'live candidate binding prevents artifact retirement');
    }
    db.prepare(`INSERT INTO artifact_retirements (
      retirement_id, artifact_ref_id, reason, policy_cutoff, retired_at, event_id, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      retirement.id, retirement.artifactRefId, retirement.reason, retirement.policyCutoff,
      retirement.retiredAt,
      event.eventId, canonicalSerialize(retirement),
    );
  }

  #assertCandidateArtifactActive(db: Database.Database, candidate: CandidateRef): void {
    if (candidate.kind !== 'artifact') return;
    const row = db.prepare(`SELECT sha256 FROM artifact_refs a WHERE artifact_ref_id = ?
      AND NOT EXISTS (SELECT 1 FROM artifact_retirements r WHERE r.artifact_ref_id = a.artifact_ref_id)`)
      .get(candidate.artifactId) as { readonly sha256: string } | undefined;
    if (row?.sha256 !== candidate.sha256) fail('constraint', 'artifact candidate is missing, retired, or mismatched');
  }

  #verifyLineage(db: Database.Database): void {
    const row = db.prepare(`SELECT database_lineage_id, artifact_root, root_device, root_inode,
      payload_json FROM artifact_archive_lineage WHERE singleton = 1`).get() as
      (ArtifactArchiveLineage & {
        readonly database_lineage_id: string;
        readonly artifact_root: string;
        readonly root_device: number;
        readonly root_inode: number;
        readonly payload_json: string;
      }) | undefined;
    if (row === undefined) fail('integrity', 'archive lineage is missing');
    const lineage = parseCanonical<ArtifactArchiveLineage>(row.payload_json, 'archive lineage');
    validateArtifactArchiveLineage(lineage);
    if (row.database_lineage_id !== lineage.databaseLineageId || row.artifact_root !== lineage.artifactRoot ||
        row.root_device !== lineage.rootDevice || row.root_inode !== lineage.rootInode ||
        !canonicalEqual(lineage, this.#lineage)) fail('integrity', 'archive lineage columns differ from payload');
  }

  #verifyRows(
    db: Database.Database,
    token: ArtifactArchiveAdmissionToken,
    seen: {
      readonly authorizations: Set<string>;
      readonly artifactRefs: Set<string>;
      readonly manifests: Set<string>;
      readonly retirements: Set<string>;
    },
  ): void {
    // C3.54: rows verified earlier in this process are skipped (immutable
    // tables; the inventory-digest seal check below catches out-of-band rows).
    // `seen` is the caller's snapshot: it is extended here and written back to
    // the memo only when the whole pass succeeds.
    this.#rowsScannedLastVerify = 0;
    const authorizationRows = db.prepare('SELECT * FROM artifact_capture_authorizations ORDER BY authorization_id')
      .iterate() as Iterable<Record<string, unknown>>;
    for (const row of authorizationRows) {
      const rowId = String(row['authorization_id']);
      if (seen.authorizations.has(rowId)) continue;
      this.#rowsScannedLastVerify += 1;
      const value = this.#parseAuthorization(String(row['payload_json']));
      const candidate = candidateParts(value.candidateRef);
      if (row['authorization_id'] !== value.id || row['artifact_ref_id'] !== value.artifactRefId ||
          row['iteration_id'] !== value.iterationId || row['producer_stage_run_id'] !== value.producerStageRunId ||
          row['candidate_kind'] !== candidate.kind || row['candidate_json'] !== candidate.json ||
          row['task_id'] !== value.taskId || row['contract_version'] !== value.contractVersion ||
          row['media_type'] !== value.mediaType || row['max_byte_length'] !== value.maximumByteLength ||
          row['environment_ref'] !== value.environmentRef || row['surface'] !== value.surface ||
          row['max_trust_class'] !== value.maximumTrustClass || row['access_class'] !== value.accessClass ||
          row['issuer'] !== value.issuer ||
          row['issued_at'] !== value.issuedAt || row['expires_at'] !== value.expiresAt) {
        fail('integrity', 'authorization columns differ from canonical payload');
      }
      seen.authorizations.add(rowId);
    }
    const artifactRows = db.prepare('SELECT * FROM artifact_refs ORDER BY artifact_ref_id')
      .iterate() as Iterable<Record<string, unknown>>;
    for (const row of artifactRows) {
      const rowId = String(row['artifact_ref_id']);
      if (seen.artifactRefs.has(rowId)) continue;
      this.#rowsScannedLastVerify += 1;
      const value = this.#parseArtifact(String(row['payload_json']));
      const candidate = candidateParts(value.captureCandidateRef);
      if (row['artifact_ref_id'] !== value.id || row['sha256'] !== value.sha256 ||
          row['media_type'] !== value.mediaType || row['byte_length'] !== value.byteLength ||
          row['storage_key'] !== value.storageKey || row['capture_authorization_id'] !== value.captureAuthorizationId ||
          row['candidate_kind'] !== candidate.kind || row['candidate_json'] !== candidate.json ||
          row['producer_stage_run_id'] !== value.producerStageRunId || row['created_at'] !== value.createdAt ||
          row['observed_at'] !== value.observedAt || row['environment_ref'] !== value.environmentRef ||
          row['surface'] !== value.surface || row['trust_class'] !== value.trustClass ||
          row['redaction_state'] !== value.redactionState || row['access_class'] !== value.accessClass) {
        fail('integrity', 'artifact columns differ from canonical payload');
      }
      seen.artifactRefs.add(rowId);
    }
    const manifestRows = db.prepare('SELECT * FROM evidence_manifests ORDER BY manifest_id')
      .iterate() as Iterable<Record<string, unknown>>;
    for (const row of manifestRows) {
      const rowId = String(row['manifest_id']);
      if (seen.manifests.has(rowId)) continue;
      this.#rowsScannedLastVerify += 1;
      const value = this.#parseManifest(String(row['payload_json']));
      const candidate = candidateParts(value.candidateRef);
      if (row['manifest_id'] !== value.id || row['task_id'] !== value.taskId ||
          row['contract_version'] !== value.contractVersion || row['iteration_id'] !== value.iterationId ||
          row['candidate_kind'] !== candidate.kind || row['candidate_json'] !== candidate.json ||
          row['manifest_hash'] !== value.manifestHash || row['created_at'] !== value.createdAt) {
        fail('integrity', 'manifest columns differ from canonical payload');
      }
      const entryRows = db.prepare(`SELECT artifact_ref_id, ordinal, candidate_kind, candidate_json,
        observed_at, environment_ref, surface, trust_class, redaction_state, access_class, payload_json
        FROM evidence_manifest_entries WHERE manifest_id = ? ORDER BY ordinal LIMIT 4097`).all(value.id) as Array<Record<string, unknown>>;
      if (entryRows.length !== value.entries.length) fail('integrity', 'manifest entry count differs from payload');
      for (const [ordinal, entry] of value.entries.entries()) {
        const rowEntry = entryRows[ordinal];
        if (rowEntry === undefined || rowEntry['artifact_ref_id'] !== entry.artifactRefId ||
            rowEntry['ordinal'] !== ordinal || rowEntry['candidate_kind'] !== entry.candidateRef.kind ||
            rowEntry['candidate_json'] !== canonicalSerialize(entry.candidateRef) ||
            rowEntry['observed_at'] !== entry.observedAt || rowEntry['environment_ref'] !== entry.environmentRef ||
            rowEntry['surface'] !== entry.surface || rowEntry['trust_class'] !== entry.trustClass ||
            rowEntry['redaction_state'] !== entry.redactionState || rowEntry['access_class'] !== entry.accessClass ||
            rowEntry['payload_json'] !== canonicalSerialize(entry)) fail('integrity', 'manifest entry differs from payload');
        const criterionRows = db.prepare(`SELECT task_id, contract_version, criterion_id, ordinal
          FROM evidence_manifest_criteria
          WHERE manifest_id = ? AND artifact_ref_id = ? ORDER BY ordinal LIMIT 4097`)
          .all(value.id, entry.artifactRefId) as Array<{
            readonly task_id: string;
            readonly contract_version: number;
            readonly criterion_id: string;
            readonly ordinal: number;
          }>;
        if (!canonicalEqual(criterionRows, entry.criterionIds.map((criterionId, index) => ({
          task_id: value.taskId,
          contract_version: value.contractVersion,
          criterion_id: criterionId,
          ordinal: index,
        })))) fail('integrity', 'manifest criteria differ from payload');
      }
      seen.manifests.add(rowId);
    }
    const retirementRows = db.prepare('SELECT * FROM artifact_retirements ORDER BY artifact_ref_id')
      .iterate() as Iterable<Record<string, unknown>>;
    for (const row of retirementRows) {
      const rowId = String(row['retirement_id']);
      if (seen.retirements.has(rowId)) continue;
      this.#rowsScannedLastVerify += 1;
      const value = parseCanonical<ArtifactMetadataRetirement>(String(row['payload_json']), 'artifact retirement');
      assertArtifactMetadataRetirement(value);
      if (row['retirement_id'] !== value.id || row['artifact_ref_id'] !== value.artifactRefId ||
          row['reason'] !== value.reason || row['policy_cutoff'] !== value.policyCutoff ||
          row['retired_at'] !== value.retiredAt) fail('integrity', 'retirement columns differ from payload');
      seen.retirements.add(rowId);
    }
    const policies = db.prepare('SELECT sha256, access_class FROM artifact_content_policies ORDER BY sha256')
      .iterate() as Iterable<{ readonly sha256: string; readonly access_class: string }>;
    for (const policy of policies) {
      if (!ARTIFACT_SHA256_RE.test(policy.sha256) || !['operator', 'restricted'].includes(policy.access_class)) {
        fail('integrity', 'artifact content policy is invalid');
      }
      const aliases = db.prepare(`SELECT COUNT(*) AS count,
        MAX(CASE access_class WHEN 'restricted' THEN 1 ELSE 0 END) AS restricted
        FROM artifact_refs WHERE sha256 = ?`).get(policy.sha256) as {
          readonly count: number;
          readonly restricted: number | null;
        };
      const expected = aliases.restricted === 1 ? 'restricted' : 'operator';
      if (aliases.count === 0 || policy.access_class !== expected) {
        fail('integrity', 'artifact content policy does not equal maximum alias restriction');
      }
    }
    this.#verifySemanticRelations(db, token);
  }

  #verifySemanticRelations(db: Database.Database, token: ArtifactArchiveAdmissionToken): void {
    this.#forEachPage((cursor) => this.listAuthorizations(token, cursor, 256), (authorization) => {
      const iterationRow = db.prepare('SELECT payload_json FROM shadow_iterations WHERE iteration_id = ?')
        .get(authorization.iterationId) as PayloadRow | undefined;
      const stageRow = db.prepare('SELECT iteration_id, stage_type FROM shadow_stage_runs WHERE stage_run_id = ?')
        .get(authorization.producerStageRunId) as {
          readonly iteration_id: string;
          readonly stage_type: string;
        } | undefined;
      if (iterationRow === undefined || stageRow === undefined ||
          stageRow.iteration_id !== authorization.iterationId ||
          (authorization.maximumTrustClass === 'primary' && stageRow.stage_type !== 'verify')) {
        fail('integrity', 'capture authorization stage relationship is invalid');
      }
      const iteration = parseCanonical<{
        readonly taskId: string;
        readonly contractVersion: number;
        readonly candidateRef: CandidateRef | null;
      }>(iterationRow.payload_json, `authorization iteration ${authorization.iterationId}`);
      if (iteration.taskId !== authorization.taskId ||
          iteration.contractVersion !== authorization.contractVersion ||
          !canonicalEqual(iteration.candidateRef, authorization.candidateRef)) {
        fail('integrity', 'capture authorization iteration facts are invalid');
      }
      const eventId = String(db.prepare(`SELECT event_id FROM artifact_capture_authorizations
        WHERE authorization_id = ?`).pluck().get(authorization.id));
      this.#verifyEntityEvent(
        db,
        eventId,
        'ArtifactCaptureAuthorized',
        'artifact_authorization',
        authorization.id,
        'issue_capture_authorization',
        authorization,
      );
    });

    this.#forEachPage((cursor) => this.listArtifactRefs(token, cursor, 256), (state) => {
      const artifact = state.artifact;
      const authorization = this.readAuthorization(token, artifact.captureAuthorizationId);
      if (authorization === null || authorization.artifactRefId !== artifact.id ||
          authorization.producerStageRunId !== artifact.producerStageRunId ||
          authorization.mediaType !== artifact.mediaType || artifact.byteLength > authorization.maximumByteLength ||
          !canonicalEqual(authorization.candidateRef, artifact.captureCandidateRef) ||
          authorization.environmentRef !== artifact.environmentRef || authorization.surface !== artifact.surface ||
          artifact.observedAt < authorization.issuedAt || artifact.observedAt > artifact.createdAt ||
          artifact.createdAt > authorization.expiresAt ||
          trustClassRank(artifact.trustClass) > trustClassRank(authorization.maximumTrustClass) ||
          (authorization.accessClass === 'restricted' && artifact.accessClass !== 'restricted')) {
        fail('integrity', 'artifact ref does not reproduce its consumed authorization');
      }
      const eventId = String(db.prepare('SELECT event_id FROM artifact_refs WHERE artifact_ref_id = ?')
        .pluck().get(artifact.id));
      this.#verifyEntityEvent(
        db,
        eventId,
        'ArtifactMetadataRecorded',
        'artifact_ref',
        artifact.id,
        'record_artifact',
        artifact,
      );
      if (state.retirement !== null) {
        const retirementEvent = String(db.prepare(`SELECT event_id FROM artifact_retirements
          WHERE artifact_ref_id = ?`).pluck().get(artifact.id));
        this.#verifyEntityEvent(
          db,
          retirementEvent,
          'ArtifactMetadataRetired',
          'artifact_ref',
          artifact.id,
          'retire_artifact',
          state.retirement,
        );
        if (db.prepare('SELECT 1 FROM evidence_manifest_entries WHERE artifact_ref_id = ?')
          .get(artifact.id) !== undefined) fail('integrity', 'retired artifact remains manifest-referenced');
        if (db.prepare(`SELECT 1 FROM artifact_candidate_bindings
          WHERE (protected_artifact_ref_id = ? OR candidate_artifact_ref_id = ?)
            AND (protection_expires_at IS NULL OR protection_expires_at >= ?)`)
          .get(artifact.id, artifact.id, state.retirement.retiredAt) !== undefined) {
          fail('integrity', 'retired artifact had a live candidate pin');
        }
      }
    });

    this.#forEachPage((cursor) => this.listManifests(token, cursor, 256), (manifest) => {
      const iterationRow = db.prepare('SELECT payload_json FROM shadow_iterations WHERE iteration_id = ?')
        .get(manifest.iterationId) as PayloadRow | undefined;
      if (iterationRow === undefined) fail('integrity', 'manifest iteration is missing');
      const iteration = parseCanonical<{
        readonly taskId: string;
        readonly contractVersion: number;
        readonly candidateRef: CandidateRef | null;
      }>(iterationRow.payload_json, `manifest iteration ${manifest.iterationId}`);
      if (iteration.taskId !== manifest.taskId || iteration.contractVersion !== manifest.contractVersion ||
          !canonicalEqual(iteration.candidateRef, manifest.candidateRef)) {
        fail('integrity', 'manifest iteration binding is invalid');
      }
      for (const entry of manifest.entries) {
        const stateRow = db.prepare(`SELECT a.payload_json,
          r.payload_json AS retirement_json FROM artifact_refs a
          LEFT JOIN artifact_retirements r ON r.artifact_ref_id = a.artifact_ref_id
          WHERE a.artifact_ref_id = ?`).get(entry.artifactRefId) as {
            readonly payload_json: string;
            readonly retirement_json: string | null;
          } | undefined;
        if (stateRow === undefined || stateRow.retirement_json !== null) {
          fail('integrity', 'manifest artifact is not active');
        }
        const state: ArtifactMetadataRefState = {
          artifact: this.#parseArtifact(stateRow.payload_json),
          retirement: null,
        };
        const artifact = state.artifact;
        const stageRow = db.prepare('SELECT payload_json FROM shadow_stage_runs WHERE stage_run_id = ?')
          .get(artifact.producerStageRunId) as PayloadRow | undefined;
        const stage = stageRow === undefined ? null : parseCanonical<{
          readonly state: string;
          readonly outputArtifactRefs: readonly string[];
        }>(stageRow.payload_json, `manifest producer ${artifact.producerStageRunId}`);
        const policy = db.prepare('SELECT access_class FROM artifact_content_policies WHERE sha256 = ?')
          .pluck().get(artifact.sha256);
        if (!canonicalEqual(entry.candidateRef, artifact.captureCandidateRef) ||
            entry.observedAt !== artifact.observedAt || entry.environmentRef !== artifact.environmentRef ||
            entry.surface !== artifact.surface || entry.trustClass !== artifact.trustClass ||
            entry.redactionState !== artifact.redactionState || entry.accessClass !== policy ||
            stage?.state !== 'succeeded' || !stage.outputArtifactRefs.includes(artifact.id)) {
          fail('integrity', 'manifest entry provenance is invalid');
        }
      }
      const eventId = String(db.prepare('SELECT event_id FROM evidence_manifests WHERE manifest_id = ?')
        .pluck().get(manifest.id));
      this.#verifyEntityEvent(
        db,
        eventId,
        'EvidenceManifestRecorded',
        'evidence_manifest',
        manifest.id,
        'record_manifest',
        manifest,
      );
    });

    const expectedBindingCount = this.#count(db, 'artifact_capture_authorizations') +
      this.#count(db, 'artifact_refs') + this.#count(db, 'evidence_manifests');
    if (this.#count(db, 'artifact_candidate_bindings') !== expectedBindingCount) {
      fail('integrity', 'candidate binding ownership is incomplete');
    }
    this.#forEachPage((cursor) => this.listCandidateBindings(token, cursor, 256), (binding) => {
      let expectedCandidate: CandidateRef;
      let expectedProtected: string | null = null;
      let expectedExpiry: string | null = null;
      if (binding.ownerKind === 'capture_authorization') {
        const authorization = this.readAuthorization(token, binding.ownerId);
        if (authorization === null) fail('integrity', 'candidate binding authorization owner is missing');
        expectedCandidate = authorization.candidateRef;
        expectedExpiry = authorization.expiresAt;
      } else if (binding.ownerKind === 'artifact_ref') {
        const artifact = this.readArtifact(token, binding.ownerId);
        if (artifact === null) fail('integrity', 'candidate binding artifact owner is missing');
        expectedCandidate = artifact.captureCandidateRef;
        expectedProtected = artifact.id;
        expectedExpiry = this.#artifactProtectionExpiry(artifact.createdAt);
      } else if (binding.ownerKind === 'manifest') {
        const manifest = this.readManifest(token, binding.ownerId);
        if (manifest === null) fail('integrity', 'candidate binding manifest owner is missing');
        expectedCandidate = manifest.candidateRef;
      } else {
        fail('integrity', 'iteration-owned candidate binding is not available in M5');
      }
      const candidate = candidateParts(expectedCandidate);
      if (!canonicalEqual(binding.candidateRef, expectedCandidate) ||
          binding.protectedArtifactRefId !== expectedProtected ||
          binding.candidateArtifactRefId !== candidate.artifactRefId ||
          binding.candidateArtifactSha256 !== candidate.artifactSha256 ||
          binding.protectionExpiresAt !== expectedExpiry) {
        fail('integrity', 'candidate binding differs from its immutable owner');
      }
    });
    this.#verifyContractCriteria(db);
  }

  #verifyEntityEvent(
    db: Database.Database,
    eventId: string,
    eventType: ControlEventType,
    aggregateKind: ControlEventAggregate,
    aggregateId: string,
    mutationKind: ArtifactMetadataMutationKind,
    record: unknown,
  ): void {
    const event = this.#readEvent(db, eventId);
    if (event.eventType !== eventType || event.aggregateKind !== aggregateKind ||
        event.aggregateId !== aggregateId || !canonicalEqual(event.payload, { mutationKind, record })) {
      fail('integrity', 'V3 entity event binding is invalid');
    }
    const mutation = db.prepare(`SELECT mutation_kind, aggregate_id FROM artifact_archive_mutations
      WHERE event_id = ?`).get(eventId) as {
        readonly mutation_kind: string;
        readonly aggregate_id: string;
      } | undefined;
    const receipt = db.prepare('SELECT event_id FROM artifact_archive_receipts WHERE event_id = ?')
      .get(eventId);
    if (mutation?.mutation_kind !== mutationKind || mutation.aggregate_id !== aggregateId || receipt === undefined) {
      fail('integrity', 'V3 entity has no exact mutation and receipt closure');
    }
  }

  #parseAuthorization(payload: string): ArtifactCaptureAuthorizationRecord {
    const value = parseCanonical<ArtifactCaptureAuthorizationRecord>(payload, 'capture authorization');
    assertArtifactCaptureAuthorization(value);
    return value;
  }

  #parseArtifact(payload: string): ArchivedArtifactMetadata {
    const value = parseCanonical<ArchivedArtifactMetadata>(payload, 'artifact metadata');
    assertArchivedArtifactMetadata(value);
    return value;
  }

  #parseManifest(payload: string): ArchivedEvidenceMetadataManifest {
    const value = parseCanonical<ArchivedEvidenceMetadataManifest>(payload, 'evidence manifest');
    assertArchivedEvidenceMetadataManifest(value);
    return value;
  }

  #parseRetirement(payload: string): ArtifactMetadataRetirement {
    const value = parseCanonical<ArtifactMetadataRetirement>(payload, 'artifact retirement');
    assertArtifactMetadataRetirement(value);
    return value;
  }

  #parseReceipt(row: ReceiptRow): ArtifactMetadataCommitReceipt {
    const receipt = parseCanonical<unknown>(row.result_json, `archive receipt ${row.idempotency_key}`);
    assertReceipt(receipt);
    if (receipt.idempotencyKey !== row.idempotency_key || receipt.requestDigest !== row.request_digest ||
        receipt.eventId !== row.event_id || receipt.committedAt !== row.committed_at) {
      fail('integrity', 'archive receipt columns differ from canonical result');
    }
    return receipt;
  }

  #readEvent(db: Database.Database, eventId: string): ControlEvent {
    const row = db.prepare(`SELECT sequence, event_id, event_type, aggregate_kind, aggregate_id,
      actor_kind, actor_id, occurred_at, payload_json, previous_event_hash, event_hash
      FROM control_events WHERE event_id = ?`).get(eventId) as EventRow | undefined;
    if (row === undefined) fail('integrity', 'archive event is missing');
    const event = rowToEvent(row);
    const reproduced = buildControlEvent({
      sequence: event.sequence,
      eventId: event.eventId,
      eventType: event.eventType,
      aggregateKind: event.aggregateKind,
      aggregateId: event.aggregateId,
      actor: event.actor,
      occurredAt: event.occurredAt,
      payload: event.payload,
      previousEventHash: event.previousEventHash,
    });
    if (reproduced.eventHash !== event.eventHash) fail('integrity', 'archive event hash is invalid');
    return event;
  }

  #reproduceRequestDigest(
    receipt: ArtifactMetadataCommitReceipt,
    event: ControlEvent,
  ): string {
    if (!isRecord(event.payload) || !exactKeys(event.payload, ['mutationKind', 'record']) ||
        event.payload['mutationKind'] !== receipt.mutationKind) {
      fail('integrity', 'archive event payload cannot reproduce its command');
    }
    const base = {
      idempotencyKey: receipt.idempotencyKey,
      event: {
        eventId: event.eventId,
        actor: event.actor,
        occurredAt: event.occurredAt,
      },
    };
    switch (receipt.mutationKind) {
      case 'issue_capture_authorization':
        return artifactMetadataCommandDigest(validateIssueCaptureAuthorizationCommand({
          ...base,
          authorization: event.payload['record'],
        }));
      case 'record_artifact':
        return artifactMetadataCommandDigest(validateRecordArtifactMetadataCommand({
          ...base,
          artifact: event.payload['record'],
        }));
      case 'record_manifest':
        return artifactMetadataCommandDigest(validateRecordEvidenceManifestMetadataCommand({
          ...base,
          manifest: event.payload['record'],
        }));
      case 'retire_artifact':
        return artifactMetadataCommandDigest(validateRetireArtifactMetadataCommand({
          ...base,
          retirement: event.payload['record'],
        }));
    }
  }

  #count(db: Database.Database, table: string): number {
    return Number(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get());
  }

  #boundedPluck(
    db: Database.Database,
    sql: string,
    parameters: readonly (string | number)[],
    label: string,
  ): readonly string[] {
    const values = db.prepare(sql).pluck().all(...parameters) as string[];
    if (values.length > 4_096) fail('integrity', `${label} exceed the bounded inventory limit`);
    return values;
  }

  #pageLimit(limit: number): number {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4_096) {
      fail('invalid_input', 'metadata page limit must be from 1 through 4096');
    }
    return limit;
  }

  #pageBounds(
    cursor: string | null,
    limit: number,
    label: string,
  ): { readonly cursor: string; readonly fetch: number } {
    if (cursor !== null) artifactMetadataBoundedText(cursor, label);
    return { cursor: cursor ?? '', fetch: this.#pageLimit(limit) + 1 };
  }

  #parseCompositeCursor(cursor: string | null, length: number, label: string): string[] {
    if (cursor === null) return Array.from({ length }, () => '');
    artifactMetadataBoundedText(cursor, label);
    const parsed = parseCanonical<unknown>(cursor, label);
    if (!Array.isArray(parsed) || parsed.length !== length ||
        parsed.some((part) => typeof part !== 'string')) fail('invalid_input', `${label} is invalid`);
    return parsed as string[];
  }

  #finishPage<Row, Item>(
    rows: readonly Row[],
    limit: number,
    map: (row: Row) => Item,
    cursor: (row: Row) => string,
  ): ArtifactMetadataPage<Item> {
    const visible = rows.slice(0, limit);
    return canonicalClone({
      items: visible.map(map),
      nextCursor: rows.length > limit && visible.length > 0 ? cursor(visible[visible.length - 1]!) : null,
    });
  }

  #forEachPage<Item>(
    load: (cursor: string | null) => ArtifactMetadataPage<Item>,
    visit: (item: Item) => void,
  ): void {
    let cursor: string | null = null;
    do {
      const page = load(cursor);
      for (const item of page.items) visit(item);
      if (page.nextCursor !== null && (cursor === null ? page.nextCursor.length === 0 : page.nextCursor <= cursor)) {
        fail('integrity', 'metadata page cursor did not advance');
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
  }

  #verifyContractCriteria(db: Database.Database): void {
    const contracts = db.prepare(`SELECT task_id, version, payload_json
      FROM shadow_task_contracts ORDER BY task_id, version`).iterate() as Iterable<{
        readonly task_id: string;
        readonly version: number;
        readonly payload_json: string;
      }>;
    let expectedTotal = 0;
    for (const contract of contracts) {
      const payload = parseCanonical<{ readonly acceptanceCriteria?: readonly unknown[] }>(
        contract.payload_json,
        `contract ${contract.task_id}/${contract.version}`,
      );
      if (!Array.isArray(payload.acceptanceCriteria) || payload.acceptanceCriteria.length > 4_096) {
        fail('integrity', 'contract acceptance criteria are not bounded');
      }
      const expected: string[] = [];
      for (let index = 0; index < payload.acceptanceCriteria.length; index += 1) {
        const criterion = payload.acceptanceCriteria[index];
        if (!isRecord(criterion) || typeof criterion['id'] !== 'string') {
          fail('integrity', 'contract acceptance criterion is invalid');
        }
        expected.push(criterion['id']);
      }
      expected.sort();
      const actual = db.prepare(`SELECT criterion_id FROM shadow_contract_criteria
        WHERE task_id = ? AND contract_version = ? ORDER BY criterion_id LIMIT 4097`)
        .pluck().all(contract.task_id, contract.version) as string[];
      if (actual.length > 4_096 || !canonicalEqual(actual, expected)) {
        fail('integrity', 'normalized contract criteria differ from the canonical contract');
      }
      expectedTotal += expected.length;
    }
    if (expectedTotal !== this.#count(db, 'shadow_contract_criteria')) {
      fail('integrity', 'normalized contract criteria contain rows without canonical owners');
    }
  }

  #authorize(token: ArtifactArchiveAdmissionToken): void {
    this.#gate.assertOwns(token);
  }

  #ready(): Database.Database {
    if (this.#closed) fail('closed', 'artifact metadata store is closed');
    if (!this.#initialized || this.#db === null) fail('not_initialized', 'artifact metadata store is not initialized');
    return this.#db;
  }

  #inject(point: ArtifactMetadataFailurePoint): void {
    this.#failureInjector?.(point);
  }

  #artifactProtectionExpiry(createdAt: string): string {
    return new Date(Date.parse(createdAt) + ARTIFACT_PROTECTION_MS).toISOString();
  }
}

export interface ArtifactMetadataSnapshotExpectation {
  readonly lineage: ArtifactArchiveLineage;
  readonly eventCount: number;
  readonly lastEventHash: string | null;
  readonly v3InventoryDigest: string;
  readonly anchors: readonly ArtifactArchiveAnchor[];
  readonly retainedAt: string;
  readonly retainedBlobs: readonly {
    readonly sha256: string;
    readonly byteLength: number;
  }[];
}

export function verifyArtifactMetadataSnapshotBytes(
  bytes: Uint8Array,
  expected: ArtifactMetadataSnapshotExpectation,
): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) {
    fail('invalid_input', 'artifact snapshot bytes are invalid');
  }
  const lineage = validateArtifactArchiveLineage(expected.lineage);
  if (!Number.isSafeInteger(expected.eventCount) || expected.eventCount < 0) {
    fail('invalid_input', 'artifact snapshot event count is invalid');
  }
  if (expected.lastEventHash !== null && !ARTIFACT_SHA256_RE.test(expected.lastEventHash)) {
    fail('invalid_input', 'artifact snapshot last event hash is invalid');
  }
  if (!ARTIFACT_SHA256_RE.test(expected.v3InventoryDigest)) {
    fail('invalid_input', 'artifact snapshot inventory digest is invalid');
  }
  const retainedAt = canonicalArtifactTimestamp(expected.retainedAt, 'artifact snapshot retention time');
  let previousRetainedDigest = '';
  for (const blob of expected.retainedBlobs) {
    if (
      !ARTIFACT_SHA256_RE.test(blob.sha256) ||
      !Number.isSafeInteger(blob.byteLength) ||
      blob.byteLength < 0 ||
      blob.sha256 <= previousRetainedDigest
    ) {
      fail('invalid_input', 'artifact snapshot retained blob inventory is invalid');
    }
    previousRetainedDigest = blob.sha256;
  }
  let db: Database.Database;
  try {
    db = new Database(Buffer.from(bytes), { readonly: true });
  } catch (error) {
    fail('integrity', 'artifact snapshot database cannot be opened in memory', error);
  }
  try {
    db.pragma('query_only = ON');
    if (db.pragma('quick_check', { simple: true }) !== 'ok' ||
        (db.pragma('foreign_key_check') as unknown[]).length !== 0) {
      fail('integrity', 'artifact snapshot SQLite integrity check failed');
    }
    const lineageRow = db.prepare(
      'SELECT payload_json FROM artifact_archive_lineage WHERE singleton = 1',
    ).get() as PayloadRow | undefined;
    if (
      lineageRow === undefined ||
      !canonicalEqual(parseCanonical<ArtifactArchiveLineage>(
        lineageRow.payload_json,
        'artifact snapshot lineage',
      ), lineage)
    ) {
      fail('integrity', 'artifact snapshot lineage differs from export inventory');
    }
    const rows = db.prepare(`SELECT sequence, event_id, event_type, aggregate_kind, aggregate_id,
      actor_kind, actor_id, occurred_at, payload_json, previous_event_hash, event_hash
      FROM control_events ORDER BY sequence`).iterate() as Iterable<EventRow>;
    let eventCount = 0;
    let previousEventHash: string | null = null;
    let lastEventHash: string | null = null;
    for (const row of rows) {
      const event = rowToEvent(row);
      const reproduced = buildControlEvent({
        sequence: event.sequence,
        eventId: event.eventId,
        eventType: event.eventType,
        aggregateKind: event.aggregateKind,
        aggregateId: event.aggregateId,
        actor: event.actor,
        occurredAt: event.occurredAt,
        payload: event.payload,
        previousEventHash: event.previousEventHash,
      });
      if (
        event.sequence !== eventCount + 1 ||
        event.previousEventHash !== previousEventHash ||
        event.eventHash !== reproduced.eventHash
      ) {
        fail('integrity', 'artifact snapshot event chain is invalid');
      }
      eventCount += 1;
      previousEventHash = event.eventHash;
      lastEventHash = event.eventHash;
    }
    if (eventCount !== expected.eventCount || lastEventHash !== expected.lastEventHash) {
      fail('integrity', 'artifact snapshot event boundary differs from export inventory');
    }

    const mutationCount = Number(db.prepare(
      'SELECT COUNT(*) FROM artifact_archive_mutations',
    ).pluck().get());
    if (mutationCount !== expected.anchors.length) {
      fail('integrity', 'artifact snapshot mutation count differs from exported anchors');
    }
    for (const anchor of expected.anchors) {
      const row = db.prepare(`SELECT m.event_id, m.mutation_kind, m.aggregate_id,
        m.request_digest, m.sealed_through_sequence, m.sealed_through_event_hash,
        m.v3_inventory_digest, r.result_json
        FROM artifact_archive_mutations m
        JOIN artifact_archive_receipts r ON r.event_id = m.event_id
        WHERE m.sealed_through_sequence = ?`).get(anchor.sealedThroughSequence) as
        | (Record<string, unknown> & { readonly result_json: string })
        | undefined;
      if (row === undefined) fail('integrity', 'exported anchor has no SQLite mutation');
      const receipt = parseCanonical<ArtifactMetadataCommitReceipt>(
        row.result_json,
        `artifact snapshot receipt ${anchor.eventId}`,
      );
      assertReceipt(receipt);
      const event = db.prepare(`SELECT sequence, event_hash, occurred_at FROM control_events
        WHERE event_id = ?`).get(anchor.eventId) as
        | { readonly sequence: number; readonly event_hash: string; readonly occurred_at: string }
        | undefined;
      if (
        event === undefined ||
        row['event_id'] !== anchor.eventId ||
        row['mutation_kind'] !== anchor.mutationKind ||
        row['aggregate_id'] !== anchor.aggregateId ||
        row['request_digest'] !== anchor.requestDigest ||
        row['sealed_through_sequence'] !== anchor.sealedThroughSequence ||
        row['sealed_through_event_hash'] !== anchor.sealedThroughEventHash ||
        row['v3_inventory_digest'] !== anchor.inventoryDigest ||
        receipt.eventId !== anchor.eventId ||
        receipt.eventSequence !== anchor.sealedThroughSequence ||
        receipt.eventHash !== anchor.sealedThroughEventHash ||
        receipt.mutationKind !== anchor.mutationKind ||
        receipt.aggregateId !== anchor.aggregateId ||
        receipt.requestDigest !== anchor.requestDigest ||
        receipt.sealedThroughSequence !== anchor.sealedThroughSequence ||
        receipt.sealedThroughEventHash !== anchor.sealedThroughEventHash ||
        receipt.v3InventoryDigest !== anchor.inventoryDigest ||
        receipt.committedAt !== anchor.committedAt ||
        event.sequence !== anchor.sealedThroughSequence ||
        event.event_hash !== anchor.sealedThroughEventHash ||
        event.occurred_at !== anchor.committedAt ||
        artifactMetadataInventoryDigest(db, anchor.sealedThroughSequence) !== anchor.inventoryDigest ||
        hashCanonicalJson(receipt) !== anchor.receiptDigest
      ) {
        fail('integrity', 'exported anchor differs from SQLite mutation or receipt');
      }
    }
    const latestInventory = db.prepare(`SELECT v3_inventory_digest
      FROM artifact_archive_mutations ORDER BY sealed_through_sequence DESC LIMIT 1`).pluck()
      .get() as string | undefined;
    if (latestInventory !== undefined && latestInventory !== expected.v3InventoryDigest) {
      fail('integrity', 'artifact snapshot inventory boundary differs from its latest mutation');
    }
    if (artifactMetadataInventoryDigest(db) !== expected.v3InventoryDigest) {
      fail('integrity', 'artifact snapshot rows differ from the exported inventory boundary');
    }
    const retainedRows = db.prepare(`SELECT policy.sha256,
      MIN(ref.byte_length) AS minimum_byte_length,
      MAX(ref.byte_length) AS maximum_byte_length
      FROM artifact_content_policies policy
      JOIN artifact_refs ref ON ref.sha256 = policy.sha256
      WHERE EXISTS (
        SELECT 1 FROM artifact_refs active
        WHERE active.sha256 = policy.sha256 AND NOT EXISTS (
          SELECT 1 FROM artifact_retirements retirement
          WHERE retirement.artifact_ref_id = active.artifact_ref_id
        )
      ) OR EXISTS (
        SELECT 1 FROM evidence_manifest_entries entry
        JOIN artifact_refs manifested ON manifested.artifact_ref_id = entry.artifact_ref_id
        WHERE manifested.sha256 = policy.sha256
      ) OR EXISTS (
        SELECT 1 FROM artifact_candidate_bindings binding
        LEFT JOIN artifact_refs bound ON
          bound.artifact_ref_id = binding.protected_artifact_ref_id OR
          bound.artifact_ref_id = binding.candidate_artifact_ref_id
        WHERE bound.sha256 = policy.sha256 AND
          (binding.protection_expires_at IS NULL OR binding.protection_expires_at >= ?)
      )
      GROUP BY policy.sha256 ORDER BY policy.sha256`).all(retainedAt) as Array<{
        readonly sha256: string;
        readonly minimum_byte_length: number;
        readonly maximum_byte_length: number;
      }>;
    if (retainedRows.some((row) => row.minimum_byte_length !== row.maximum_byte_length)) {
      fail('integrity', 'artifact snapshot aliases disagree on retained blob length');
    }
    const retainedBlobs = retainedRows.map((row) => ({
      sha256: row.sha256,
      byteLength: row.minimum_byte_length,
    }));
    if (!canonicalEqual(retainedBlobs, expected.retainedBlobs)) {
      fail('integrity', 'artifact snapshot retained blobs differ from export inventory');
    }
    if (latestInventory === undefined) {
      for (const table of [
        'artifact_capture_authorizations', 'artifact_refs', 'artifact_candidate_bindings',
        'artifact_retirements', 'evidence_manifests', 'evidence_manifest_entries',
        'evidence_manifest_criteria',
      ]) {
        if (Number(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()) !== 0) {
          fail('integrity', 'artifact snapshot has unanchored V3 rows');
        }
      }
    }
  } catch (error) {
    mapSqliteError(error);
  } finally {
    db.close();
  }
}
