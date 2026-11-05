import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import {
  candidateRefsEqual,
  type CandidateRef,
} from '../../domain/artifact.js';
import { canonicalClone, canonicalSerialize, hashCanonicalJson } from '../../domain/canonicalJson.js';
import {
  assertControlApiV2ReceiptV1,
  computeReceiptHash,
  type AdmissionLedgerEntryV1,
  type AdmissionVerdictV1,
  type ControlApiV2ReceiptV1,
  type ControlApiV2RequestV1,
  type DecisionPayloadV1,
  type ReceiptRefusalReasonV1,
} from '../../domain/controlApiV2.js';
import {
  appendApprovedContractChange,
  ContractChangeError,
} from '../../domain/contractChange.js';
import { ContractHashError } from '../../domain/contractHash.js';
import {
  assertControlEvent,
  assertV2AggregateEventPayload,
  assertV2DecisionCommittedPayload,
  assertV2EvaluationBoundPayload,
  assertV2EvidenceBoundPayload,
  buildControlEvent,
  ControlEventError,
  V2_BIND_EVENT_TYPES,
  V2_CONTROL_EVENT_TYPES,
  V2_VERSIONED_EVENT_TYPES,
  type ControlEvent,
  type ControlEventAggregate,
  type ControlEventType,
  type V2AggregateEventPayload,
  type V2ControlEventType,
  type V2DecisionCommittedPayload,
  type V2EvaluationBoundPayload,
  type V2EvidenceBoundPayload,
  type V2ProjectionState,
  type V2UnprojectableReason,
} from '../../domain/controlEvent.js';
import { assertHumanDecisionBinding, type HumanDecision } from '../../domain/humanDecision.js';
import type { ReviewPackageV2 } from '../../domain/reviewPackageV2.js';
import { toV2TaskStatus, type V2TaskStatus } from '../../domain/v2TaskStatus.js';
import {
  appendIteration,
  transitionIteration,
  type Iteration,
} from '../../domain/iteration.js';
import {
  appendStageAttempt,
  transitionStageRun,
  type StageRun,
} from '../../domain/stageRun.js';
import { appendContractVersion, type ActorRef, type TaskContract } from '../../domain/taskContract.js';
import { isValidIdentifier, type Task } from '../../domain/task.js';
import { isRecord, V2InvariantError } from '../../domain/v2Invariant.js';
import {
  CURRENT_STATE_SCHEMA_VERSION,
  STATE_MIGRATIONS,
} from './migrations.js';
import {
  StateStoreError,
  V2_INITIAL_SWEEP_KEY,
  type ControlStateStore,
  type ExportReceipt,
  type ReviewPackageRefreshSeam,
  type ShadowCommitCommand,
  type ShadowCommitReceipt,
  type ShadowMutation,
  type ProjectionEnvelopeInput,
  type ProjectionEnvelopeKey,
  type ProjectionEnvelopeManifest,
  type ProjectionEnvelopeState,
  type ProjectionAuthorityWrite,
  type ProjectionManifestEntry,
  type ShadowTaskRetirement,
  type ShadowTaskState,
  type StartupIntegrityReport,
  type V2AggregateRow,
  type V2BoundEvaluationV1,
  type V2BoundEvidenceV1,
  type V2DecisionEventView,
  type V2PendingEffectRow,
  type V2SweepReport,
} from './stateStore.js';
import {
  assertBoundEvaluationVerdictAttribution,
  assertV2BoundEvaluationV1,
  assertV2BoundEvidenceV1,
  boundedText,
  commandDigest,
  computeV2BoundEvaluationHash,
  computeV2BoundEvidenceHash,
  exactGitRevision,
  justifiedGateFailureCriterionIds,
  SHA256_RE,
  validateShadowCommitCommand,
} from './stateStoreValidation.js';

export const STATE_STORE_FAILURE_POINTS = [
  'after_projection',
  'after_event',
  'after_receipt',
  'before_commit',
  'export_before_readonly_verify',
  'export_after_readonly_verify',
  'export_after_backup',
  'export_after_manifest',
  'export_after_file_fsync',
  'export_before_rename',
  'export_after_rename',
] as const;

export type StateStoreFailurePoint = (typeof STATE_STORE_FAILURE_POINTS)[number];

export interface SqliteStateStoreOptions {
  readonly trustedRoot: string;
  readonly databasePath: string;
  readonly busyTimeoutMs?: number;
  readonly failureInjector?: (point: StateStoreFailurePoint) => void;
  readonly refreshReviewPackage?: ReviewPackageRefreshSeam;
  readonly clock?: () => string;
  /** Test-only: invoked when a projection envelope row is parsed via envelopeRowToState for the read cache. */
  readonly onEnvelopeParse?: (deliveryId: string) => void;
}

interface EventParts {
  readonly eventType: ControlEventType;
  readonly aggregateKind: ControlEventAggregate;
  readonly aggregateId: string;
  readonly payload: unknown;
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

interface ContractPayloadRow extends PayloadRow {
  readonly task_id: string;
  readonly version: number;
  readonly contract_hash: string;
}

interface IterationPayloadRow extends PayloadRow {
  readonly iteration_id: string;
  readonly task_id: string;
  readonly contract_version: number;
  readonly ordinal: number;
}

interface StagePayloadRow extends PayloadRow {
  readonly stage_run_id: string;
  readonly iteration_id: string;
  readonly stage_type: string;
  readonly attempt: number;
}

interface EnvelopeRow {
  readonly delivery_id: string;
  readonly authority_revision: string;
  readonly authority_input_json: string;
  readonly manifest_json: string;
  readonly gap_codes_json: string;
  readonly manifest_digest: string;
  readonly command_count: number;
  readonly completed: number;
  readonly completion_manifest_digest: string | null;
  readonly completion_command_count: number | null;
  readonly acknowledged_commands: number;
}

/** Cheap columns used to detect envelope-row changes without parsing JSON blobs. */
interface EnvelopeStampRow {
  readonly rowid: number;
  readonly delivery_id: string;
  readonly authority_revision: string;
  readonly manifest_digest: string;
  readonly command_count: number;
  readonly completed: number;
  readonly completion_manifest_digest: string | null;
  readonly completion_command_count: number | null;
  readonly acknowledged_commands: number;
}

interface EnvelopeCacheEntry {
  readonly stamp: string;
  readonly state: ProjectionEnvelopeState;
}

interface BatchAckRow {
  readonly batch_ordinal: number;
  readonly start_index: number;
  readonly end_index: number;
  readonly receipt_digests_json: string;
}

interface V2AggregateStateRow {
  readonly aggregate_id: string;
  readonly state_version: number;
  readonly task_status: string;
  readonly review_package_json: string | null;
  readonly projection_hash: string | null;
  readonly projection_state: string;
  readonly unprojectable_reason: string | null;
  readonly updated_at_sequence: number;
}

const V2_PROJECTION_ACTOR: ActorRef = {
  kind: 'control_plane',
  id: 'v2-aggregate-projection',
};

const V2_CREATE_NAMESPACE_RE = /^task-[0-9a-f]{64}$/;

function stripProjectedAt(packageValue: ReviewPackageV2): unknown {
  // projectedAt is clock-injected; projectionHash covers the full package
  // including projectedAt, so both must be omitted for semantic equality.
  const {
    projectedAt: _projectedAt,
    projectionHash: _projectionHash,
    ...rest
  } = packageValue;
  return rest;
}

const RECEIPT_KEYS = [
  'idempotencyKey',
  'requestDigest',
  'eventId',
  'eventSequence',
  'eventHash',
  'mutationKind',
  'aggregateKind',
  'aggregateId',
  'committedAt',
] as const;

const ENVELOPE_SELECT = `SELECT e.delivery_id, e.authority_revision, e.authority_input_json,
  e.manifest_json,
  e.gap_codes_json, e.manifest_digest, e.command_count,
  CASE WHEN c.delivery_id IS NULL THEN 0 ELSE 1 END AS completed,
  c.manifest_digest AS completion_manifest_digest,
  c.command_count AS completion_command_count,
  COALESCE((SELECT MAX(a.end_index) FROM projection_batch_acknowledgements a
    WHERE a.delivery_id = e.delivery_id), 0) AS acknowledged_commands
  FROM projection_envelopes e
  LEFT JOIN projection_completion_receipts c ON c.delivery_id = e.delivery_id`;

/**
 * Light stamp columns for the per-instance envelope read cache. Stamp matches
 * imply the cached ProjectionEnvelopeState is still valid for this process;
 * a row mutated behind a running process with an unchanged stamp is not
 * re-verified until reopen (same trust boundary as the SQLite file itself).
 * Boot integrity (#verifyDatabase) always reads through envelopeRowToState
 * uncached so every process start re-checks every row.
 */
const ENVELOPE_STAMP_SELECT = `SELECT e.rowid AS rowid, e.delivery_id, e.authority_revision,
  e.manifest_digest, e.command_count,
  CASE WHEN c.delivery_id IS NULL THEN 0 ELSE 1 END AS completed,
  c.manifest_digest AS completion_manifest_digest,
  c.command_count AS completion_command_count,
  COALESCE((SELECT MAX(a.end_index) FROM projection_batch_acknowledgements a
    WHERE a.delivery_id = e.delivery_id), 0) AS acknowledged_commands
  FROM projection_envelopes e
  LEFT JOIN projection_completion_receipts c ON c.delivery_id = e.delivery_id`;

/** Bound-variable budget per cache-miss query (well under SQLite's 32,766 default). */
export const ENVELOPE_MISS_QUERY_CHUNK = 500;

/**
 * Per-instance parsed-envelope cache bound (LRU by last use). A reconciliation
 * envelope's authority input snapshots every task body (multi-MB); caching the
 * whole history unbounded took production past the V8 heap limit on
 * 2026-09-09. History-sized loops read identity keys instead
 * (`listProjectionEnvelopeKeys`) and materialize one envelope at a time, so
 * the cache only has to cover the live path (write → re-read of the newest
 * envelopes); a production reconciliation envelope parses to ~25 MB of heap,
 * which bounds this at a few hundred MB.
 */
export const ENVELOPE_CACHE_MAX = 8;

const ENVELOPE_MANIFEST_SELECT = `SELECT e.delivery_id, e.authority_revision, e.manifest_json,
  e.gap_codes_json, e.manifest_digest, e.command_count
  FROM projection_envelopes e`;

interface EnvelopeManifestRow {
  readonly delivery_id: string;
  readonly authority_revision: string;
  readonly manifest_json: string;
  readonly gap_codes_json: string;
  readonly manifest_digest: string;
  readonly command_count: number;
}

function envelopeStampKey(row: EnvelopeStampRow): string {
  return [
    String(row.rowid),
    row.manifest_digest,
    String(row.command_count),
    String(row.acknowledged_commands),
    String(row.completed),
    row.completion_manifest_digest ?? '',
    row.completion_command_count === null || row.completion_command_count === undefined
      ? ''
      : String(row.completion_command_count),
  ].join('\0');
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  if (!Object.isFrozen(value)) {
    Object.freeze(value);
  }
  return value;
}

function validateEnvelopeInput(value: ProjectionEnvelopeInput): ProjectionEnvelopeInput {
  if (!isRecord(value) || !exactKeys(value, [
    'deliveryId', 'authorityRevision', 'authorityInput', 'manifest', 'gapCodes',
  ])) fail('invalid_input', 'projection envelope must use the exact schema');
  boundedText(value.deliveryId, 'delivery id');
  exactGitRevision(value.authorityRevision, 'authority revision');
  if (!isRecord(value.authorityInput) ||
      !exactKeys(value.authorityInput, ['writes', 'retiredTaskIds']) ||
      !Array.isArray(value.authorityInput.writes) ||
      !Array.isArray(value.authorityInput.retiredTaskIds) ||
      !Array.isArray(value.manifest) || !Array.isArray(value.gapCodes)) {
    fail('invalid_input', 'projection envelope authority input, manifest, and gaps are invalid');
  }
  const writeIds: string[] = [];
  for (const task of value.authorityInput.writes) {
    if (!isRecord(task) || typeof task['id'] !== 'string' || !isValidIdentifier(task['id']) ||
        Buffer.byteLength(canonicalSerialize(task), 'utf8') > 1024 * 1024) {
      fail('invalid_input', 'projection authority task is invalid or too large');
    }
    writeIds.push(task['id']);
  }
  const retiredTaskIds = value.authorityInput.retiredTaskIds;
  if (retiredTaskIds.some((taskId) => typeof taskId !== 'string' || !isValidIdentifier(taskId)) ||
      new Set(writeIds).size !== writeIds.length ||
      new Set(retiredTaskIds).size !== retiredTaskIds.length ||
      retiredTaskIds.some((taskId) => writeIds.includes(taskId)) ||
      writeIds.some((taskId, index) => index > 0 && writeIds[index - 1]! >= taskId) ||
      retiredTaskIds.some((taskId, index) => index > 0 && retiredTaskIds[index - 1]! >= taskId)) {
    fail('invalid_input', 'projection authority input must have sorted disjoint task identities');
  }
  const keys = new Set<string>();
  for (const entry of value.manifest) {
    if (!isRecord(entry) || !exactKeys(entry, ['idempotencyKey', 'commandDigest'])) {
      fail('invalid_input', 'projection manifest entry must use the exact schema');
    }
    const key = entry['idempotencyKey'];
    const digest = entry['commandDigest'];
    boundedText(key, 'manifest idempotency key');
    if (typeof digest !== 'string' || !SHA256_RE.test(digest)) {
      fail('invalid_input', 'manifest digest is invalid');
    }
    if (keys.has(key)) fail('invalid_input', 'projection manifest keys must be unique');
    keys.add(key);
  }
  const gaps = [...value.gapCodes];
  for (const gap of gaps) boundedText(gap, 'projection gap code');
  if (new Set(gaps).size !== gaps.length || gaps.some((gap, index) => index > 0 && gaps[index - 1]! >= gap)) {
    fail('invalid_input', 'projection gap codes must be unique and sorted');
  }
  return canonicalClone(value);
}

function envelopeDigest(value: ProjectionEnvelopeInput): string {
  return hashCanonicalJson({ schema: 'shadow-envelope-v2', ...value });
}

function envelopeRowToState(row: EnvelopeRow): ProjectionEnvelopeState {
  const input = validateEnvelopeInput({
    deliveryId: row.delivery_id,
    authorityRevision: row.authority_revision,
    authorityInput: parseCanonical(
      row.authority_input_json, `projection envelope ${row.delivery_id} authority input`,
    ),
    manifest: parseCanonical(row.manifest_json, `projection envelope ${row.delivery_id} manifest`),
    gapCodes: parseCanonical(row.gap_codes_json, `projection envelope ${row.delivery_id} gaps`),
  } as ProjectionEnvelopeInput);
  if (row.command_count !== input.manifest.length || row.manifest_digest !== envelopeDigest(input) ||
      !Number.isSafeInteger(row.acknowledged_commands) || row.acknowledged_commands < 0 ||
      row.acknowledged_commands > row.command_count) {
    fail('integrity', 'projection envelope row is inconsistent');
  }
  if (row.completed === 1 && (row.completion_manifest_digest !== row.manifest_digest ||
      row.completion_command_count !== row.command_count)) {
    fail('integrity', 'projection completion receipt is inconsistent');
  }
  return {
    ...input,
    manifestDigest: row.manifest_digest,
    completed: row.completed === 1,
    acknowledgedCommands: row.acknowledged_commands,
  };
}

function fail(code: StateStoreError['code'], message: string, cause?: unknown): never {
  throw new StateStoreError(code, message, cause);
}

function exactKeys(value: Readonly<Record<PropertyKey, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalSerialize(left) === canonicalSerialize(right);
}

function buildV2RefusedReceipt(input: {
  readonly aggregateId: string;
  readonly keyHash: string;
  readonly requestHash: string;
  readonly reason: ReceiptRefusalReasonV1;
  readonly decidedAt: string;
}): ControlApiV2ReceiptV1 {
  const withoutHash: Omit<ControlApiV2ReceiptV1, 'receiptHash'> = {
    schema: 'hercules-control-api-receipt/v2',
    outcome: 'refused',
    resource: 'decision',
    aggregateId: input.aggregateId,
    keyHash: input.keyHash,
    requestHash: input.requestHash,
    stateVersion: null,
    eventSequence: null,
    reason: input.reason,
    decidedAt: input.decidedAt,
  };
  const receipt: ControlApiV2ReceiptV1 = {
    ...withoutHash,
    receiptHash: computeReceiptHash(withoutHash),
  };
  assertControlApiV2ReceiptV1(receipt);
  return receipt;
}

function buildV2CommittedReceipt(input: {
  readonly aggregateId: string;
  readonly keyHash: string;
  readonly requestHash: string;
  readonly stateVersion: number;
  readonly eventSequence: number;
  readonly decidedAt: string;
}): ControlApiV2ReceiptV1 {
  const withoutHash: Omit<ControlApiV2ReceiptV1, 'receiptHash'> = {
    schema: 'hercules-control-api-receipt/v2',
    outcome: 'committed',
    resource: 'decision',
    aggregateId: input.aggregateId,
    keyHash: input.keyHash,
    requestHash: input.requestHash,
    stateVersion: input.stateVersion,
    eventSequence: input.eventSequence,
    reason: null,
    decidedAt: input.decidedAt,
  };
  const receipt: ControlApiV2ReceiptV1 = {
    ...withoutHash,
    receiptHash: computeReceiptHash(withoutHash),
  };
  assertControlApiV2ReceiptV1(receipt);
  return receipt;
}

function parseCanonical<T>(text: string, label: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail('integrity', `${label} is not JSON`, error);
  }
  let canonical: string;
  try {
    canonical = canonicalSerialize(value);
  } catch (error) {
    fail('integrity', `${label} is outside canonical JSON`, error);
  }
  if (canonical !== text) fail('integrity', `${label} bytes are not canonical`);
  return value as T;
}

function sha256File(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function fsyncPath(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function ensurePrivateDirectory(path: string): string {
  if (!isAbsolute(path)) fail('unsafe_path', 'trusted root must be absolute');
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    fail('unsafe_path', 'trusted root must be a real directory');
  }
  if ((before.mode & 0o777) !== 0o700 ||
      (typeof process.getuid === 'function' && before.uid !== process.getuid())) {
    fail('unsafe_path', 'trusted root must already be private and owned by this process');
  }
  return realpathSync(path);
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function assertDirectFile(root: string, path: string): string {
  const resolved = resolve(path);
  if (dirname(resolved) !== root) fail('unsafe_path', 'database must be a direct trusted-root file');
  if (existsSync(resolved)) {
    const info = lstatSync(resolved);
    if (!info.isFile() || info.isSymbolicLink()) fail('unsafe_path', 'database path is unsafe');
  }
  return resolved;
}

function sqliteMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : 'unknown sqlite failure';
}

function mapSqliteError(error: unknown): never {
  if (error instanceof StateStoreError) throw error;
  const message = sqliteMessage(error);
  if (/busy|locked/i.test(message)) fail('busy', 'state database is busy', error);
  if (/constraint|unique|foreign key/i.test(message)) {
    fail('constraint', 'state mutation violates a database constraint', error);
  }
  fail('integrity', 'state database operation failed', error);
}

function rowToEvent(row: EventRow): ControlEvent {
  const event: ControlEvent = {
    sequence: Number(row.sequence),
    eventId: row.event_id,
    eventType: row.event_type as ControlEventType,
    aggregateKind: row.aggregate_kind as ControlEventAggregate,
    aggregateId: row.aggregate_id,
    actor: { kind: row.actor_kind as ControlEvent['actor']['kind'], id: row.actor_id },
    occurredAt: row.occurred_at,
    payload: parseCanonical(row.payload_json, `event ${row.event_id} payload`),
    previousEventHash: row.previous_event_hash,
    eventHash: row.event_hash,
  };
  assertControlEvent(event);
  return event;
}

function pendingEffectFromRow(row: {
  readonly key_hash: string;
  readonly aggregate_id: string;
  readonly action: string;
  readonly event_sequence: number;
  readonly effect_state: string;
  readonly applied_at_sequence: number | null;
}): V2PendingEffectRow {
  return {
    keyHash: row.key_hash,
    aggregateId: row.aggregate_id,
    action: row.action as V2PendingEffectRow['action'],
    eventSequence: Number(row.event_sequence),
    effectState: row.effect_state as V2PendingEffectRow['effectState'],
    appliedAtSequence: row.applied_at_sequence === null ? null : Number(row.applied_at_sequence),
  };
}

function assertReceipt(value: unknown): asserts value is ShadowCommitReceipt {
  if (!isRecord(value) || !exactKeys(value, RECEIPT_KEYS)) {
    fail('integrity', 'receipt result schema is invalid');
  }
  for (const [field, label] of [
    ['idempotencyKey', 'idempotency key'],
    ['eventId', 'event id'],
    ['aggregateId', 'aggregate id'],
    ['committedAt', 'commit time'],
  ] as const) {
    const text = value[field];
    if (typeof text !== 'string' || text.length === 0 || Buffer.byteLength(text, 'utf8') > 512) {
      fail('integrity', `receipt ${label} is invalid`);
    }
  }
  if (!SHA256_RE.test(String(value['requestDigest'])) || !SHA256_RE.test(String(value['eventHash']))) {
    fail('integrity', 'receipt digest is invalid');
  }
  if (!Number.isSafeInteger(value['eventSequence']) || Number(value['eventSequence']) < 1) {
    fail('integrity', 'receipt event sequence is invalid');
  }
  if (![
    'insert_contract_root',
    'append_contract_successor',
    'put_iteration',
    'put_stage_run',
    'retire_task',
  ].includes(String(value['mutationKind']))) {
    fail('integrity', 'receipt mutation kind is invalid');
  }
  if (!['task', 'iteration', 'stage_run'].includes(String(value['aggregateKind']))) {
    fail('integrity', 'receipt aggregate kind is invalid');
  }
}

function parseReceiptRow(row: ReceiptRow): ShadowCommitReceipt {
  const receipt = parseCanonical<unknown>(row.result_json, `receipt ${row.idempotency_key}`);
  assertReceipt(receipt);
  if (
    receipt.idempotencyKey !== row.idempotency_key ||
    receipt.requestDigest !== row.request_digest ||
    receipt.eventId !== row.event_id ||
    receipt.committedAt !== row.committed_at
  ) {
    fail('integrity', 'receipt columns do not match canonical result');
  }
  return receipt;
}

function loadContracts(db: Database.Database, taskId: string): TaskContract[] {
  const rows = db.prepare(
    'SELECT task_id, version, contract_hash, payload_json FROM shadow_task_contracts WHERE task_id = ? ORDER BY version',
  ).all(taskId) as ContractPayloadRow[];
  return rows.map(parseContractRow);
}

function loadIterationsForTask(db: Database.Database, taskId: string): Iteration[] {
  const rows = db.prepare(
    `SELECT iteration_id, task_id, contract_version, ordinal, payload_json
      FROM shadow_iterations WHERE task_id = ? ORDER BY ordinal`,
  ).all(taskId) as IterationPayloadRow[];
  return rows.map(parseIterationRow);
}

function loadStagesForIteration(db: Database.Database, iterationId: string): StageRun[] {
  const rows = db.prepare(
    'SELECT stage_run_id, iteration_id, stage_type, attempt, payload_json FROM shadow_stage_runs WHERE iteration_id = ? ORDER BY stage_type, attempt',
  ).all(iterationId) as StagePayloadRow[];
  return rows.map(parseStageRow);
}

function parseContractRow(row: ContractPayloadRow): TaskContract {
  const contract = parseCanonical<TaskContract>(
    row.payload_json,
    `contract ${row.task_id}/${row.version}`,
  );
  if (
    row.task_id !== contract.taskId ||
    row.version !== contract.version ||
    row.contract_hash !== contract.contractHash
  ) {
    fail('integrity', 'contract projection columns do not match its payload');
  }
  return contract;
}

function parseIterationRow(row: IterationPayloadRow): Iteration {
  const iteration = parseCanonical<Iteration>(row.payload_json, `iteration ${row.iteration_id}`);
  if (
    row.iteration_id !== iteration.id ||
    row.task_id !== iteration.taskId ||
    row.contract_version !== iteration.contractVersion ||
    row.ordinal !== iteration.ordinal
  ) {
    fail('integrity', 'iteration projection columns do not match its payload');
  }
  return iteration;
}

function parseStageRow(row: StagePayloadRow): StageRun {
  const stage = parseCanonical<StageRun>(row.payload_json, `stage ${row.stage_run_id}`);
  if (
    row.stage_run_id !== stage.id ||
    row.iteration_id !== stage.iterationId ||
    row.stage_type !== stage.type ||
    row.attempt !== stage.attempt
  ) {
    fail('integrity', 'stage projection columns do not match its payload');
  }
  return stage;
}

function applyIteration(existing: Iteration | null, history: readonly Iteration[], next: Iteration): void {
  if (existing === null) {
    appendIteration(history, next);
    return;
  }
  const derived = transitionIteration(existing, next.state, next.endedAt, {
    candidateRef: next.candidateRef,
    evidenceManifestId: next.evidenceManifestId,
    finalVerdictId: next.finalVerdictId,
  });
  if (!canonicalEqual(derived, next)) fail('constraint', 'iteration transition rewrites immutable facts');
}

function applyStage(existing: StageRun | null, history: readonly StageRun[], next: StageRun): void {
  if (existing === null) {
    appendStageAttempt(history, next);
    return;
  }
  const derived = transitionStageRun(
    existing,
    next.state,
    { startedAt: next.startedAt, endedAt: next.endedAt },
    next.failureClass,
    next.workerId,
    {
      agentRunIds: next.agentRunIds,
      outputArtifactRefs: next.outputArtifactRefs,
      structuredResult: next.structuredResult,
    },
  );
  if (!canonicalEqual(derived, next)) fail('constraint', 'stage transition rewrites immutable facts');
}

export class SqliteStateStore implements ControlStateStore {
  readonly #root: string;
  readonly #databasePath: string;
  readonly #busyTimeoutMs: number;
  readonly #failureInjector: ((point: StateStoreFailurePoint) => void) | undefined;
  readonly #refreshReviewPackage: ReviewPackageRefreshSeam | undefined;
  readonly #clock: () => string;
  readonly #onEnvelopeParse: ((deliveryId: string) => void) | undefined;
  readonly #envelopeCache = new Map<string, EnvelopeCacheEntry>();
  #startupReport: StartupIntegrityReport | null = null;
  #db: Database.Database | null = null;
  #initialized = false;
  #closed = false;

  constructor(options: SqliteStateStoreOptions) {
    if (!isRecord(options)) fail('invalid_input', 'state-store options are invalid');
    this.#root = ensurePrivateDirectory(options.trustedRoot);
    if (this.#root.split(sep).includes('worktrees')) {
      fail('unsafe_path', 'state database cannot live under a provider worktree');
    }
    this.#databasePath = assertDirectFile(this.#root, options.databasePath);
    const timeout = options.busyTimeoutMs ?? 2_000;
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 30_000) {
      fail('invalid_input', 'busy timeout is invalid');
    }
    this.#busyTimeoutMs = timeout;
    this.#failureInjector = options.failureInjector;
    this.#refreshReviewPackage = options.refreshReviewPackage;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#onEnvelopeParse = options.onEnvelopeParse;
  }

  initialize(): StartupIntegrityReport {
    if (this.#closed) fail('closed', 'state store is closed');
    this.#envelopeCache.clear();
    if (this.#initialized) return this.#verifyDatabase(this.#database());
    try {
      this.#db = new Database(this.#databasePath);
      this.#db.pragma('foreign_keys = ON');
      this.#db.pragma(`busy_timeout = ${this.#busyTimeoutMs}`);
      this.#db.pragma('synchronous = FULL');
      const journal = String(this.#db.pragma('journal_mode = WAL', { simple: true })).toLowerCase();
      if (journal !== 'wal') fail('integrity', 'SQLite WAL mode could not be enabled');
      this.#applyMigrations(this.#db);
      this.#tightenDatabasePermissions();
      // Boot integrity reads through envelopeRowToState uncached (never the
      // verified-once read cache) so every process start re-checks every row.
      const report = this.#verifyDatabase(this.#db);
      this.#initialized = true;
      this.#startupReport = report;
      return report;
    } catch (error) {
      this.#envelopeCache.clear();
      this.#db?.close();
      this.#db = null;
      mapSqliteError(error);
    }
  }

  /**
   * The report of the boot integrity pass that opened this instance. Callers
   * that only need the numbers must use this instead of calling
   * `initialize()` again — a repeat call re-verifies every envelope row.
   */
  startupReport(): StartupIntegrityReport {
    if (this.#startupReport === null) fail('closed', 'state store is not initialized');
    return this.#startupReport;
  }

  commit(input: ShadowCommitCommand): ShadowCommitReceipt {
    const db = this.#readyDatabase();
    const command = validateShadowCommitCommand(input);
    try {
      const transaction = db.transaction((): ShadowCommitReceipt => {
        const receipt = this.#commitOne(db, command);
        this.#inject('before_commit');
        return receipt;
      });
      const receipt = transaction.immediate();
      this.#tightenDatabasePermissions();
      return canonicalClone(receipt);
    } catch (error) {
      mapSqliteError(error);
    }
  }

  beginEnvelope(input: ProjectionEnvelopeInput): ProjectionEnvelopeState {
    const db = this.#readyDatabase();
    const envelope = validateEnvelopeInput(input);
    const digest = envelopeDigest(envelope);
    try {
      const transaction = db.transaction(() => {
        const existing = this.#readEnvelopeRow(db, envelope.deliveryId);
        if (existing !== null) {
          const state = envelopeRowToState(existing);
          if (state.manifestDigest !== digest || !canonicalEqual(envelope, {
            deliveryId: state.deliveryId,
            authorityRevision: state.authorityRevision,
            authorityInput: state.authorityInput,
            manifest: state.manifest,
            gapCodes: state.gapCodes,
          })) fail('idempotency_conflict', 'delivery id was already used for another envelope');
          return state;
        }
        db.prepare(`INSERT INTO projection_envelopes (
          delivery_id, authority_revision, authority_input_json, manifest_json, gap_codes_json,
          manifest_digest, command_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          envelope.deliveryId,
          envelope.authorityRevision,
          canonicalSerialize(envelope.authorityInput),
          canonicalSerialize(envelope.manifest),
          canonicalSerialize(envelope.gapCodes),
          digest,
          envelope.manifest.length,
        );
        return envelopeRowToState(this.#readEnvelopeRow(db, envelope.deliveryId)!);
      });
      const state = transaction.immediate();
      this.#invalidateEnvelopeCache(envelope.deliveryId);
      return canonicalClone(state);
    } catch (error) {
      mapSqliteError(error);
    }
  }

  commitBatch(
    deliveryId: string,
    batchOrdinal: number,
    inputs: readonly ShadowCommitCommand[],
  ): readonly ShadowCommitReceipt[] {
    const db = this.#readyDatabase();
    boundedText(deliveryId, 'delivery id');
    if (!Number.isSafeInteger(batchOrdinal) || batchOrdinal < 0) {
      fail('invalid_input', 'batch ordinal is invalid');
    }
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 256) {
      fail('invalid_input', 'projection batch must contain 1 through 256 commands');
    }
    const commands = inputs.map(validateShadowCommitCommand);
    if (new Set(commands.map((item) => item.idempotencyKey)).size !== commands.length ||
        new Set(commands.map((item) => item.event.eventId)).size !== commands.length) {
      fail('invalid_input', 'projection batch command and event identities must be unique');
    }
    try {
      const transaction = db.transaction((): readonly ShadowCommitReceipt[] => {
        const envelopeRow = this.#readEnvelopeRow(db, deliveryId);
        if (envelopeRow === null) fail('constraint', 'projection envelope is missing');
        const envelope = envelopeRowToState(envelopeRow);
        const prior = db.prepare(`SELECT batch_ordinal, start_index, end_index, receipt_digests_json
          FROM projection_batch_acknowledgements
          WHERE delivery_id = ? AND batch_ordinal = ?`).get(deliveryId, batchOrdinal) as BatchAckRow | undefined;
        if (envelope.completed && prior === undefined) {
          fail('constraint', 'completed projection envelope has no such batch');
        }
        const expectedStart = prior?.start_index ?? envelope.acknowledgedCommands;
        const manifestSlice = envelope.manifest.slice(expectedStart, expectedStart + commands.length);
        const supplied = commands.map((command) => ({
          idempotencyKey: command.idempotencyKey,
          commandDigest: commandDigest(command),
        }));
        if (manifestSlice.length !== commands.length || !canonicalEqual(manifestSlice, supplied)) {
          fail('idempotency_conflict', 'projection batch does not match envelope manifest');
        }
        if (prior === undefined) {
          const ordinalCount = Number(db.prepare(`SELECT COUNT(*) FROM projection_batch_acknowledgements
            WHERE delivery_id = ?`).pluck().get(deliveryId));
          if (batchOrdinal !== ordinalCount) fail('constraint', 'projection batches must be contiguous');
        }
        const receipts = commands.map((command) => this.#commitOne(db, command));
        const receiptDigests = receipts.map((receipt) => hashCanonicalJson(receipt));
        if (prior !== undefined) {
          const expectedDigests = parseCanonical<readonly string[]>(
            prior.receipt_digests_json,
            `projection batch ${batchOrdinal}`,
          );
          if (prior.end_index !== expectedStart + commands.length ||
              !canonicalEqual(expectedDigests, receiptDigests)) {
            fail('integrity', 'projection batch acknowledgement does not match receipts');
          }
          return receipts;
        }
        db.prepare(`INSERT INTO projection_batch_acknowledgements (
          delivery_id, batch_ordinal, start_index, end_index, receipt_digests_json
        ) VALUES (?, ?, ?, ?, ?)`).run(
          deliveryId,
          batchOrdinal,
          expectedStart,
          expectedStart + commands.length,
          canonicalSerialize(receiptDigests),
        );
        this.#inject('before_commit');
        return receipts;
      });
      const receipts = transaction.immediate();
      this.#invalidateEnvelopeCache(deliveryId);
      this.#tightenDatabasePermissions();
      return canonicalClone(receipts);
    } catch (error) {
      mapSqliteError(error);
    }
  }

  completeEnvelope(deliveryId: string): ProjectionEnvelopeState {
    const db = this.#readyDatabase();
    boundedText(deliveryId, 'delivery id');
    try {
      const transaction = db.transaction(() => {
        const row = this.#readEnvelopeRow(db, deliveryId);
        if (row === null) fail('constraint', 'projection envelope is missing');
        const state = envelopeRowToState(row);
        if (state.acknowledgedCommands !== state.manifest.length) {
          fail('constraint', 'projection envelope has an incomplete command manifest');
        }
        const occurredAt = this.#clock();
        for (const task of state.authorityInput.writes) {
          this.#materializeOrRefresh(
            task.id,
            toV2TaskStatus(task.state),
            occurredAt,
            V2_PROJECTION_ACTOR,
          );
        }
        // Sweep skips retired tasks (it only walks the live Task[] snapshot).
        // Envelope retirement therefore refreshes with the closed V2 status
        // 'deleted' so materialized aggregates do not keep a stale live status.
        for (const retiredTaskId of state.authorityInput.retiredTaskIds) {
          this.#materializeOrRefresh(
            retiredTaskId,
            'deleted',
            occurredAt,
            V2_PROJECTION_ACTOR,
          );
        }
        const existing = db.prepare(`SELECT manifest_digest, command_count
          FROM projection_completion_receipts WHERE delivery_id = ?`).get(deliveryId) as
          { readonly manifest_digest: string; readonly command_count: number } | undefined;
        if (existing === undefined) {
          db.prepare(`INSERT INTO projection_completion_receipts
            (delivery_id, manifest_digest, command_count) VALUES (?, ?, ?)`).run(
            deliveryId, state.manifestDigest, state.manifest.length,
          );
        } else if (existing.manifest_digest !== state.manifestDigest ||
                   existing.command_count !== state.manifest.length) {
          fail('integrity', 'projection completion receipt conflicts with its envelope');
        }
        return envelopeRowToState(this.#readEnvelopeRow(db, deliveryId)!);
      });
      const state = transaction.immediate();
      this.#invalidateEnvelopeCache(deliveryId);
      return canonicalClone(state);
    } catch (error) {
      mapSqliteError(error);
    }
  }

  readEnvelope(deliveryId: string): ProjectionEnvelopeState | null {
    boundedText(deliveryId, 'delivery id');
    const stamp = this.#readyDatabase().prepare(`${ENVELOPE_STAMP_SELECT}
      WHERE e.delivery_id = ?`).get(deliveryId) as EnvelopeStampRow | undefined;
    if (stamp === undefined) return null;
    return this.#resolveEnvelopeFromStamp(stamp);
  }

  listProjectionEnvelopes(): readonly ProjectionEnvelopeState[] {
    const stamps = this.#readyDatabase().prepare(`${ENVELOPE_STAMP_SELECT}
      ORDER BY e.rowid`).all() as EnvelopeStampRow[];
    return this.#resolveEnvelopesFromStamps(stamps);
  }

  listProjectionEnvelopeKeys(): readonly ProjectionEnvelopeKey[] {
    const stamps = this.#readyDatabase().prepare(`${ENVELOPE_STAMP_SELECT}
      ORDER BY e.rowid`).all() as EnvelopeStampRow[];
    return stamps.map((stamp) => {
      if (!Number.isSafeInteger(stamp.acknowledged_commands) || stamp.acknowledged_commands < 0 ||
          stamp.acknowledged_commands > stamp.command_count) {
        fail('integrity', 'projection envelope row is inconsistent');
      }
      return deepFreeze({
        deliveryId: stamp.delivery_id,
        authorityRevision: stamp.authority_revision,
        manifestDigest: stamp.manifest_digest,
        commandCount: stamp.command_count,
        completed: stamp.completed === 1,
        acknowledgedCommands: stamp.acknowledged_commands,
      });
    });
  }

  readEnvelopeManifest(deliveryId: string): ProjectionEnvelopeManifest | null {
    boundedText(deliveryId, 'delivery id');
    const cached = this.#envelopeCache.get(deliveryId);
    if (cached !== undefined) {
      // Same instance-local trust as readEnvelope: a warm entry is reused
      // without re-reading the row; only stamp changes re-parse there.
      const { state } = cached;
      return {
        deliveryId: state.deliveryId,
        authorityRevision: state.authorityRevision,
        manifest: state.manifest,
        gapCodes: state.gapCodes,
        manifestDigest: state.manifestDigest,
      };
    }
    const row = this.#readyDatabase().prepare(`${ENVELOPE_MANIFEST_SELECT}
      WHERE e.delivery_id = ?`).get(deliveryId) as EnvelopeManifestRow | undefined;
    if (row === undefined) return null;
    const manifest = parseCanonical<readonly ProjectionManifestEntry[]>(
      row.manifest_json, `projection envelope ${row.delivery_id} manifest`,
    );
    const gapCodes = parseCanonical<readonly string[]>(
      row.gap_codes_json, `projection envelope ${row.delivery_id} gaps`,
    );
    if (!Array.isArray(manifest) || !Array.isArray(gapCodes) ||
        row.command_count !== manifest.length ||
        !gapCodes.every((code) => typeof code === 'string')) {
      fail('integrity', 'projection envelope row is inconsistent');
    }
    return deepFreeze({
      deliveryId: row.delivery_id,
      authorityRevision: row.authority_revision,
      manifest,
      gapCodes,
      manifestDigest: row.manifest_digest,
    });
  }

  listIncompleteEnvelopes(): readonly ProjectionEnvelopeState[] {
    const stamps = this.#readyDatabase().prepare(`${ENVELOPE_STAMP_SELECT}
      WHERE c.delivery_id IS NULL ORDER BY e.rowid`).all() as EnvelopeStampRow[];
    return this.#resolveEnvelopesFromStamps(stamps);
  }

  observedAuthorityRevision(): string | null {
    const row = this.#readyDatabase().prepare(
      'SELECT authority_revision FROM projection_observed_revision WHERE singleton = 1',
    ).get() as { readonly authority_revision: string } | undefined;
    return row?.authority_revision ?? null;
  }

  recordObservedAuthorityRevision(revision: string): void {
    const db = this.#readyDatabase();
    boundedText(revision, 'authority revision');
    db.prepare(`INSERT INTO projection_observed_revision (singleton, authority_revision, observed_at)
      VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        authority_revision = excluded.authority_revision,
        observed_at = excluded.observed_at`).run(revision, this.#clock());
  }

  refreshMaterializedForDelivery(delivery: {
    readonly writes: readonly ProjectionAuthorityWrite[];
    readonly retiredTaskIds: readonly string[];
  }): void {
    const db = this.#readyDatabase();
    const transaction = db.transaction(() => {
      const occurredAt = this.#clock();
      for (const task of delivery.writes) {
        this.#materializeOrRefresh(task.id, toV2TaskStatus(task.state), occurredAt, V2_PROJECTION_ACTOR);
      }
      for (const retiredTaskId of delivery.retiredTaskIds) {
        this.#materializeOrRefresh(retiredTaskId, 'deleted', occurredAt, V2_PROJECTION_ACTOR);
      }
    });
    transaction.immediate();
  }

  latestProjectionEnvelopeRevision(): string | null {
    const row = this.#readyDatabase().prepare(
      'SELECT authority_revision FROM projection_envelopes ORDER BY rowid DESC LIMIT 1',
    ).get() as { readonly authority_revision: string } | undefined;
    return row?.authority_revision ?? null;
  }

  listTaskIds(): readonly string[] {
    const db = this.#readyDatabase();
    return db.prepare('SELECT DISTINCT task_id FROM shadow_task_contracts ORDER BY task_id')
      .pluck().all() as string[];
  }

  readTask(taskId: string): ShadowTaskState | null {
    const db = this.#readyDatabase();
    boundedText(taskId, 'task id');
    const contracts = loadContracts(db, taskId);
    if (contracts.length === 0) return null;
    const iterations = loadIterationsForTask(db, taskId);
    const stageRuns = iterations.flatMap((iteration) => loadStagesForIteration(db, iteration.id));
    const retirementRow = db.prepare(
      'SELECT payload_json FROM shadow_task_retirements WHERE task_id = ?',
    ).get(taskId) as PayloadRow | undefined;
    const retirement = retirementRow === undefined
      ? null
      : parseCanonical<ShadowTaskRetirement>(retirementRow.payload_json, `retirement ${taskId}`);
    return canonicalClone({ taskId, contracts, iterations, stageRuns, retirement });
  }

  readEvents(afterSequence: number, limit: number): readonly ControlEvent[] {
    const db = this.#readyDatabase();
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      fail('invalid_input', 'event cursor is invalid');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      fail('invalid_input', 'event limit is invalid');
    }
    const rows = db.prepare(`SELECT sequence, event_id, event_type, aggregate_kind,
      aggregate_id, actor_kind, actor_id, occurred_at, payload_json,
      previous_event_hash, event_hash FROM control_events
      WHERE sequence > ? ORDER BY sequence LIMIT ?`).all(afterSequence, limit) as EventRow[];
    return rows.map((row) => canonicalClone(rowToEvent(row)));
  }

  sweepV2Aggregates(tasks: readonly Task[]): V2SweepReport {
    if (!this.#seamWired()) {
      return { performed: false, reason: 'seam_not_wired', materializedCount: 0 };
    }
    if (!Array.isArray(tasks)) fail('invalid_input', 'V2 sweep tasks must be an array');
    const db = this.#readyDatabase();
    const existing = db.prepare(
      'SELECT sweep_key FROM v2_sweeps WHERE sweep_key = ?',
    ).get(V2_INITIAL_SWEEP_KEY) as { readonly sweep_key: string } | undefined;
    if (existing !== undefined) {
      return { performed: false, reason: 'already_swept', materializedCount: 0 };
    }
    try {
      const transaction = db.transaction((): V2SweepReport => {
        const ordered = [...tasks].sort((left, right) => (
          left.id < right.id ? -1 : left.id > right.id ? 1 : 0
        ));
        const occurredAt = this.#clock();
        let materializedCount = 0;
        for (const task of ordered) {
          if (this.#materializeOrRefresh(
            task.id,
            toV2TaskStatus(task.state),
            occurredAt,
            V2_PROJECTION_ACTOR,
          ) === 'materialized') {
            materializedCount += 1;
          }
        }
        const lastSequence = Number(db.prepare(
          'SELECT COALESCE(MAX(sequence), 0) FROM control_events',
        ).pluck().get());
        db.prepare(`INSERT INTO v2_sweeps (
          sweep_key, completed_at_sequence, materialized_count
        ) VALUES (?, ?, ?)`).run(V2_INITIAL_SWEEP_KEY, lastSequence, materializedCount);
        return { performed: true, reason: 'swept', materializedCount };
      });
      return canonicalClone(transaction.immediate());
    } catch (error) {
      mapSqliteError(error);
    }
  }

  readV2Aggregate(aggregateId: string): V2AggregateRow | null {
    const db = this.#readyDatabase();
    boundedText(aggregateId, 'aggregate id');
    const row = db.prepare(`SELECT aggregate_id, state_version, task_status, review_package_json,
      projection_hash, projection_state, unprojectable_reason, updated_at_sequence
      FROM v2_aggregate_state WHERE aggregate_id = ?`).get(aggregateId) as V2AggregateStateRow | undefined;
    if (row === undefined) return null;
    const reviewPackage = row.review_package_json === null
      ? null
      : parseCanonical<ReviewPackageV2>(row.review_package_json, `v2 aggregate ${aggregateId} package`);
    return canonicalClone({
      aggregateId: row.aggregate_id,
      stateVersion: Number(row.state_version),
      taskStatus: row.task_status as V2TaskStatus,
      projectionState: row.projection_state as V2ProjectionState,
      unprojectableReason: row.unprojectable_reason as V2UnprojectableReason | null,
      projectionHash: row.projection_hash,
      reviewPackage,
      updatedAtSequence: Number(row.updated_at_sequence),
    });
  }

  readV2HumanDecisions(aggregateId: string): readonly HumanDecision[] {
    const db = this.#readyDatabase();
    boundedText(aggregateId, 'aggregate id');
    const rows = db.prepare(`SELECT sequence, event_id, event_type, aggregate_kind,
      aggregate_id, actor_kind, actor_id, occurred_at, payload_json,
      previous_event_hash, event_hash FROM control_events
      WHERE aggregate_id = ? AND event_type = 'V2DecisionCommitted'
      ORDER BY sequence`).all(aggregateId) as EventRow[];
    const decisions: HumanDecision[] = [];
    for (const row of rows) {
      const event = rowToEvent(row);
      assertV2DecisionCommittedPayload(event.payload);
      const payload = event.payload;
      const decision: HumanDecision = {
        id: payload.decisionId,
        binding: payload.binding,
        decision: payload.action,
        comment: payload.reason,
        actor: payload.actor,
        createdAt: payload.decidedAt,
      };
      assertHumanDecisionBinding(decision, decision.binding);
      decisions.push(decision);
    }
    return canonicalClone(decisions);
  }

  readV2AdmissionLedgerEntry(keyHash: string): AdmissionLedgerEntryV1 | null {
    const db = this.#readyDatabase();
    if (typeof keyHash !== 'string' || !SHA256_RE.test(keyHash)) {
      fail('invalid_input', 'admission ledger key hash is invalid');
    }
    const row = db.prepare(
      'SELECT key_hash, aggregate_id, request_hash, receipt_json FROM v2_admission_ledger WHERE key_hash = ?',
    ).get(keyHash) as {
      readonly key_hash: string;
      readonly aggregate_id: string;
      readonly request_hash: string;
      readonly receipt_json: string;
    } | undefined;
    if (row === undefined) return null;
    const receipt = parseCanonical<ControlApiV2ReceiptV1>(
      row.receipt_json,
      `v2 admission ledger ${keyHash} receipt`,
    );
    assertControlApiV2ReceiptV1(receipt);
    return canonicalClone({
      keyHash: row.key_hash,
      requestHash: row.request_hash,
      receipt,
    });
  }

  commitV2(request: ControlApiV2RequestV1, verdict: AdmissionVerdictV1): ControlApiV2ReceiptV1 {
    if (
      request.resource !== 'decision' ||
      request.operation !== 'submit' ||
      !('kind' in request.payload) ||
      request.payload.kind !== 'decision'
    ) {
      fail('unsupported', 'commitV2 supports decision submits only');
    }
    if (request.idempotencyKey === null) {
      fail('invalid_input', 'commitV2 requires an idempotency key');
    }
    if (request.concurrencyToken === null) {
      fail('invalid_input', 'commitV2 requires a concurrency token');
    }
    if (verdict.keyHash !== request.idempotencyKey.keyHash) {
      fail('invalid_input', 'commitV2 verdict keyHash must match the request');
    }
    if (verdict.requestHash !== request.requestHash) {
      fail('invalid_input', 'commitV2 verdict requestHash must match the request');
    }
    if (verdict.aggregateId !== request.aggregateId) {
      fail('invalid_input', 'commitV2 verdict aggregateId must match the request');
    }
    if (!this.#seamWired()) {
      fail('invalid_input', 'commitV2 requires the refresh seam');
    }

    const db = this.#readyDatabase();
    const payload = request.payload as DecisionPayloadV1;
    const keyHash = request.idempotencyKey.keyHash;
    const actorId = request.idempotencyKey.actorId;
    const actorIssuer = request.idempotencyKey.actorIssuer;
    const concurrencyToken = request.concurrencyToken;

    try {
      const transaction = db.transaction((): ControlApiV2ReceiptV1 => {
        const ledgerRow = db.prepare(
          'SELECT request_hash, receipt_json FROM v2_admission_ledger WHERE key_hash = ?',
        ).get(keyHash) as { readonly request_hash: string; readonly receipt_json: string } | undefined;
        if (ledgerRow !== undefined) {
          if (ledgerRow.request_hash === request.requestHash) {
            return canonicalClone(
              parseCanonical<ControlApiV2ReceiptV1>(
                ledgerRow.receipt_json,
                `v2 admission ledger ${keyHash} receipt`,
              ),
            );
          }
          return buildV2RefusedReceipt({
            aggregateId: request.aggregateId,
            keyHash,
            requestHash: request.requestHash,
            reason: 'idempotency_conflict',
            decidedAt: verdict.decidedAt,
          });
        }

        const row = this.readV2Aggregate(request.aggregateId);
        if (row === null || row.projectionState !== 'projected' || row.reviewPackage === null) {
          fail('invalid_input', 'commitV2 aggregate is not projectable');
        }
        if (row.stateVersion !== concurrencyToken.stateVersion) {
          return buildV2RefusedReceipt({
            aggregateId: request.aggregateId,
            keyHash,
            requestHash: request.requestHash,
            reason: 'stale_version',
            decidedAt: verdict.decidedAt,
          });
        }

        const binding = row.reviewPackage.decisionBinding;
        if (binding === null) {
          fail('invalid_input', 'commitV2 requires a non-null decisionBinding');
        }

        const stateVersion = row.stateVersion + 1;
        const decisionPayload: V2DecisionCommittedPayload = {
          kind: 'v2-decision',
          stateVersion,
          decisionId: `decision-${keyHash.slice('sha256:'.length)}`,
          keyHash,
          requestHash: request.requestHash,
          action: payload.action,
          actor: { kind: 'human', id: actorId },
          actorIssuer,
          reason: payload.reason,
          decidedAt: verdict.decidedAt,
          binding,
          acknowledgedRiskCodes: payload.acknowledgedRiskCodes,
        };
        const decisionEvent = this.#appendV2Event(db, {
          eventType: 'V2DecisionCommitted',
          aggregateId: request.aggregateId,
          actor: { kind: 'human', id: actorId },
          occurredAt: verdict.decidedAt,
          // Hyphenated form: ControlEventView requires isValidIdentifier (no ':').
          eventId: `v2-${request.aggregateId}-${stateVersion}`,
          payload: decisionPayload,
        });

        db.prepare(`UPDATE v2_aggregate_state SET
          state_version = ?,
          updated_at_sequence = ?
          WHERE aggregate_id = ?`).run(
          stateVersion,
          decisionEvent.sequence,
          request.aggregateId,
        );

        const receipt = buildV2CommittedReceipt({
          aggregateId: request.aggregateId,
          keyHash,
          requestHash: request.requestHash,
          stateVersion,
          eventSequence: decisionEvent.sequence,
          decidedAt: verdict.decidedAt,
        });

        db.prepare(`INSERT INTO v2_admission_ledger (
          key_hash, aggregate_id, request_hash, event_sequence, receipt_json
        ) VALUES (?, ?, ?, ?, ?)`).run(
          keyHash,
          request.aggregateId,
          request.requestHash,
          decisionEvent.sequence,
          canonicalSerialize(receipt),
        );
        db.prepare(`INSERT INTO v2_pending_effects (
          key_hash, aggregate_id, action, event_sequence, effect_state, applied_at_sequence
        ) VALUES (?, ?, ?, ?, 'pending', NULL)`).run(
          keyHash,
          request.aggregateId,
          payload.action,
          decisionEvent.sequence,
        );

        const refreshResult = this.#materializeOrRefresh(
          request.aggregateId,
          row.taskStatus,
          verdict.decidedAt,
          V2_PROJECTION_ACTOR,
        );
        if (refreshResult === 'unchanged') {
          fail('integrity', 'post-decision refresh must change the package');
        }
        if (refreshResult === 'materialized') {
          fail('integrity', 'post-decision refresh must refresh an existing aggregate');
        }

        return canonicalClone(receipt);
      });
      return transaction.immediate();
    } catch (error) {
      mapSqliteError(error);
    }
  }

  readPendingEffect(keyHash: string): V2PendingEffectRow | null {
    const db = this.#readyDatabase();
    if (typeof keyHash !== 'string' || !SHA256_RE.test(keyHash)) {
      fail('invalid_input', 'pending effect key hash is invalid');
    }
    const row = db.prepare(`SELECT key_hash, aggregate_id, action, event_sequence,
      effect_state, applied_at_sequence FROM v2_pending_effects WHERE key_hash = ?`).get(keyHash) as {
      readonly key_hash: string;
      readonly aggregate_id: string;
      readonly action: string;
      readonly event_sequence: number;
      readonly effect_state: string;
      readonly applied_at_sequence: number | null;
    } | undefined;
    if (row === undefined) return null;
    return canonicalClone(pendingEffectFromRow(row));
  }

  listPendingEffects(): readonly V2PendingEffectRow[] {
    const db = this.#readyDatabase();
    const rows = db.prepare(`SELECT key_hash, aggregate_id, action, event_sequence,
      effect_state, applied_at_sequence FROM v2_pending_effects
      WHERE effect_state = 'pending' ORDER BY event_sequence`).all() as Array<{
      readonly key_hash: string;
      readonly aggregate_id: string;
      readonly action: string;
      readonly event_sequence: number;
      readonly effect_state: string;
      readonly applied_at_sequence: number | null;
    }>;
    return canonicalClone(rows.map(pendingEffectFromRow));
  }

  markEffectApplied(keyHash: string, appliedAtSequence: number): V2PendingEffectRow {
    if (typeof keyHash !== 'string' || !SHA256_RE.test(keyHash)) {
      fail('invalid_input', 'pending effect key hash is invalid');
    }
    if (!Number.isSafeInteger(appliedAtSequence) || appliedAtSequence < 1) {
      fail('invalid_input', 'appliedAtSequence must be a safe integer >= 1');
    }
    const db = this.#readyDatabase();
    try {
      const transaction = db.transaction((): V2PendingEffectRow => {
        const row = db.prepare(`SELECT key_hash, aggregate_id, action, event_sequence,
          effect_state, applied_at_sequence FROM v2_pending_effects WHERE key_hash = ?`).get(keyHash) as {
          readonly key_hash: string;
          readonly aggregate_id: string;
          readonly action: string;
          readonly event_sequence: number;
          readonly effect_state: string;
          readonly applied_at_sequence: number | null;
        } | undefined;
        if (row === undefined) {
          fail('invalid_input', `unknown pending effect keyHash ${keyHash}`);
        }
        if (row.effect_state === 'applied') {
          const existing = Number(row.applied_at_sequence);
          if (existing === appliedAtSequence) {
            return canonicalClone(pendingEffectFromRow(row));
          }
          fail(
            'integrity',
            `pending effect ${keyHash} already applied at sequence ${existing}, not ${appliedAtSequence}`,
          );
        }
        // Confirm the tip inside this txn (appliedAtSequence is the caller's mark-time tip).
        const latest = Number(db.prepare(
          'SELECT COALESCE(MAX(sequence), 0) AS latest FROM control_events',
        ).pluck().get());
        if (latest < 1) {
          fail('integrity', 'markEffectApplied requires at least one control event');
        }
        db.prepare(`UPDATE v2_pending_effects SET
          effect_state = 'applied', applied_at_sequence = ?
          WHERE key_hash = ?`).run(appliedAtSequence, keyHash);
        const updated = db.prepare(`SELECT key_hash, aggregate_id, action, event_sequence,
          effect_state, applied_at_sequence FROM v2_pending_effects WHERE key_hash = ?`).get(keyHash) as {
          readonly key_hash: string;
          readonly aggregate_id: string;
          readonly action: string;
          readonly event_sequence: number;
          readonly effect_state: string;
          readonly applied_at_sequence: number | null;
        };
        return canonicalClone(pendingEffectFromRow(updated));
      });
      return transaction.immediate();
    } catch (error) {
      mapSqliteError(error);
    }
  }

  readDecisionEvent(eventSequence: number): V2DecisionEventView | null {
    const db = this.#readyDatabase();
    if (!Number.isSafeInteger(eventSequence) || eventSequence < 1) {
      fail('invalid_input', 'decision event sequence is invalid');
    }
    const row = db.prepare(`SELECT sequence, event_id, event_type, aggregate_kind,
      aggregate_id, actor_kind, actor_id, occurred_at, payload_json,
      previous_event_hash, event_hash FROM control_events
      WHERE sequence = ?`).get(eventSequence) as EventRow | undefined;
    if (row === undefined) return null;
    if (row.event_type !== 'V2DecisionCommitted') return null;
    const event = rowToEvent(row);
    assertV2DecisionCommittedPayload(event.payload);
    const payload = event.payload;
    return canonicalClone({
      aggregateId: event.aggregateId,
      action: payload.action,
      reason: payload.reason,
      actorId: payload.actor.id,
      actorIssuer: payload.actorIssuer,
      decidedAt: payload.decidedAt,
      keyHash: payload.keyHash,
      acknowledgedRiskCodes: payload.acknowledgedRiskCodes,
    });
  }

  latestEventSequence(): number {
    const db = this.#readyDatabase();
    return Number(db.prepare(
      'SELECT COALESCE(MAX(sequence), 0) AS latest FROM control_events',
    ).pluck().get());
  }

  bindReviewEvidence(
    record: Omit<V2BoundEvidenceV1, 'evidenceHash'>,
    actor: ActorRef,
  ): {
    readonly evidenceHash: string;
    readonly eventSequence: number;
    readonly refresh: 'materialized' | 'refreshed' | 'unchanged';
  } {
    const db = this.#readyDatabase();
    try {
      const transaction = db.transaction(() => {
        const evidenceHash = computeV2BoundEvidenceHash(record);
        const full: V2BoundEvidenceV1 = { ...record, evidenceHash };
        try {
          assertV2BoundEvidenceV1(full);
        } catch (error) {
          if (error instanceof StateStoreError) throw error;
          fail(
            'invalid_input',
            error instanceof Error ? error.message : 'bound evidence is invalid',
            error,
          );
        }

        const shadow = this.readTask(full.aggregateId);
        if (shadow === null || shadow.iterations.length === 0) {
          fail('invalid_input', 'bound evidence requires a shadow task with iteration history');
        }
        const current = shadow.iterations[shadow.iterations.length - 1]!;
        if (full.iterationId !== current.id) {
          fail('invalid_input', 'bound evidence iterationId must be the current iteration');
        }
        if (full.aggregateId !== shadow.taskId) {
          fail('invalid_input', 'bound evidence aggregateId must equal the shadow task id');
        }
        if (
          current.candidateRef === null ||
          current.candidateRef.kind !== 'git' ||
          full.candidateRef.kind !== 'git' ||
          !candidateRefsEqual(current.candidateRef, full.candidateRef)
        ) {
          fail(
            'invalid_input',
            'bound evidence candidateRef must deep-equal the current git iteration candidate',
          );
        }
        const gitCandidate = full.candidateRef;
        const manifest = full.evidenceManifest;
        if (
          manifest.taskId !== shadow.taskId ||
          manifest.iterationId !== current.id ||
          manifest.contractVersion !== current.contractVersion ||
          !candidateRefsEqual(manifest.candidateRef, current.candidateRef)
        ) {
          fail(
            'invalid_input',
            'bound evidence manifest must match the current iteration identity and contract version',
          );
        }
        const shadowContract = shadow.contracts.find(
          (entry) => entry.version === current.contractVersion,
        );
        if (shadowContract === undefined) {
          fail(
            'invalid_input',
            'bound evidence requires the shadow contract matching the current iteration',
          );
        }
        for (const receipt of full.verificationReceipts) {
          if (receipt.contractHash !== shadowContract.contractHash) {
            fail(
              'invalid_input',
              'bound evidence receipt contractHash must equal the shadow contract hash',
            );
          }
        }

        const existing = db.prepare(
          'SELECT 1 AS present FROM v2_review_evidence WHERE aggregate_id = ? AND iteration_id = ?',
        ).get(full.aggregateId, full.iterationId) as { readonly present: number } | undefined;
        if (existing !== undefined) {
          fail('integrity', 'bound evidence is immutable for an aggregate iteration');
        }

        const payload: V2EvidenceBoundPayload = {
          kind: 'v2-evidence-bound',
          iterationId: full.iterationId,
          manifestId: manifest.id,
          manifestHash: manifest.manifestHash,
          evidenceHash,
        };
        const event = this.#appendV2Event(db, {
          eventType: 'V2EvidenceBound',
          aggregateId: full.aggregateId,
          actor,
          occurredAt: full.recordedAt,
          eventId: `v2-evidence-${full.aggregateId}-${full.iterationId}`,
          payload,
        });
        db.prepare(`INSERT INTO v2_review_evidence (
          aggregate_id, iteration_id, candidate_repository, candidate_revision,
          manifest_id, manifest_hash, evidence_hash, record_json, recorded_at, event_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          full.aggregateId,
          full.iterationId,
          gitCandidate.repository,
          gitCandidate.revision,
          manifest.id,
          manifest.manifestHash,
          evidenceHash,
          canonicalSerialize(full),
          full.recordedAt,
          event.sequence,
        );

        const aggregate = db.prepare(
          'SELECT task_status FROM v2_aggregate_state WHERE aggregate_id = ?',
        ).get(full.aggregateId) as { readonly task_status: string } | undefined;
        const taskStatus = aggregate !== undefined
          ? (aggregate.task_status as V2TaskStatus)
          : this.#legacyStatusForAggregate(full.aggregateId);
        const refresh = this.#materializeOrRefresh(
          full.aggregateId,
          taskStatus,
          full.recordedAt,
          actor,
        );
        return { evidenceHash, eventSequence: event.sequence, refresh };
      });
      return canonicalClone(transaction.immediate());
    } catch (error) {
      mapSqliteError(error);
    }
  }

  bindReviewEvaluation(
    record: Omit<V2BoundEvaluationV1, 'evaluationHash'>,
    actor: ActorRef,
  ): {
    readonly evaluationHash: string;
    readonly eventSequence: number;
    readonly refresh: 'materialized' | 'refreshed' | 'unchanged';
  } {
    const db = this.#readyDatabase();
    try {
      const transaction = db.transaction(() => {
        const evaluationHash = computeV2BoundEvaluationHash(record);
        const full: V2BoundEvaluationV1 = { ...record, evaluationHash };
        try {
          assertV2BoundEvaluationV1(full);
        } catch (error) {
          if (error instanceof StateStoreError) throw error;
          fail(
            'invalid_input',
            error instanceof Error ? error.message : 'bound evaluation is invalid',
            error,
          );
        }

        const shadow = this.readTask(full.aggregateId);
        if (shadow === null || shadow.iterations.length === 0) {
          fail('invalid_input', 'bound evaluation requires a shadow task with iteration history');
        }
        const current = shadow.iterations[shadow.iterations.length - 1]!;
        if (full.iterationId !== current.id) {
          fail('invalid_input', 'bound evaluation iterationId must be the current iteration');
        }
        if (full.aggregateId !== shadow.taskId) {
          fail('invalid_input', 'bound evaluation aggregateId must equal the shadow task id');
        }
        if (
          current.candidateRef === null ||
          current.candidateRef.kind !== 'git'
        ) {
          fail('invalid_input', 'bound evaluation requires a current git candidate iteration');
        }

        const evidenceRow = db.prepare(
          `SELECT evidence_hash, manifest_hash, record_json FROM v2_review_evidence
           WHERE aggregate_id = ? AND iteration_id = ?`,
        ).get(full.aggregateId, full.iterationId) as {
          readonly evidence_hash: string;
          readonly manifest_hash: string;
          readonly record_json: string;
        } | undefined;
        if (evidenceRow === undefined) {
          fail('invalid_input', 'bound evaluation requires existing bound evidence for the iteration');
        }
        if (evidenceRow.evidence_hash !== full.evidenceHash) {
          fail('invalid_input', 'bound evaluation evidenceHash must match the bound evidence row');
        }
        const boundEvidence = parseCanonical<V2BoundEvidenceV1>(
          evidenceRow.record_json,
          `v2 review evidence ${full.aggregateId}/${full.iterationId}`,
        );
        try {
          assertBoundEvaluationVerdictAttribution(
            full.evaluation.verdict,
            full.receipt.verdict,
            justifiedGateFailureCriterionIds(boundEvidence),
          );
        } catch (error) {
          if (error instanceof StateStoreError) throw error;
          fail(
            'invalid_input',
            error instanceof Error ? error.message : 'bound evaluation attribution is invalid',
            error,
          );
        }

        if (full.receipt.iterationId !== full.iterationId) {
          fail('invalid_input', 'bound evaluation receipt.iterationId must match iterationId');
        }
        if (full.receipt.verdict.binding.iterationId !== full.iterationId) {
          fail(
            'invalid_input',
            'bound evaluation receipt.verdict.binding.iterationId must match iterationId',
          );
        }
        if (full.receipt.verdict.binding.evidenceManifestHash !== evidenceRow.manifest_hash) {
          fail(
            'invalid_input',
            'bound evaluation receipt verdict must bind the evidence manifest hash',
          );
        }
        if (full.evaluator.runId !== full.receipt.evaluatorRunId) {
          fail(
            'invalid_input',
            'bound evaluation evaluator.runId must equal receipt.evaluatorRunId',
          );
        }
        // Real M8 coordinator receipts leave evaluatorAgentRunId null on
        // deterministic paths (no proposal / no infrastructure failure). When
        // present, the verdict-bound run id must still agree with the roster.
        if (
          full.receipt.verdict.evaluatorAgentRunId !== null &&
          full.evaluator.runId !== full.receipt.verdict.evaluatorAgentRunId
        ) {
          fail(
            'invalid_input',
            'bound evaluation evaluator.runId must equal verdict.evaluatorAgentRunId when set',
          );
        }

        const existing = db.prepare(
          'SELECT 1 AS present FROM v2_review_evaluation WHERE aggregate_id = ? AND iteration_id = ?',
        ).get(full.aggregateId, full.iterationId) as { readonly present: number } | undefined;
        if (existing !== undefined) {
          fail('integrity', 'bound evaluation is immutable for an aggregate iteration');
        }

        const payload: V2EvaluationBoundPayload = {
          kind: 'v2-evaluation-bound',
          iterationId: full.iterationId,
          receiptId: full.receipt.receiptId,
          evidenceHash: full.evidenceHash,
          evaluationHash,
        };
        const event = this.#appendV2Event(db, {
          eventType: 'V2EvaluationBound',
          aggregateId: full.aggregateId,
          actor,
          occurredAt: full.recordedAt,
          eventId: `v2-evaluation-${full.aggregateId}-${full.iterationId}`,
          payload,
        });
        db.prepare(`INSERT INTO v2_review_evaluation (
          aggregate_id, iteration_id, evidence_hash, receipt_id, evaluation_hash,
          record_json, recorded_at, event_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          full.aggregateId,
          full.iterationId,
          full.evidenceHash,
          full.receipt.receiptId,
          evaluationHash,
          canonicalSerialize(full),
          full.recordedAt,
          event.sequence,
        );

        const aggregate = db.prepare(
          'SELECT task_status FROM v2_aggregate_state WHERE aggregate_id = ?',
        ).get(full.aggregateId) as { readonly task_status: string } | undefined;
        const taskStatus = aggregate !== undefined
          ? (aggregate.task_status as V2TaskStatus)
          : this.#legacyStatusForAggregate(full.aggregateId);
        const refresh = this.#materializeOrRefresh(
          full.aggregateId,
          taskStatus,
          full.recordedAt,
          actor,
        );
        return { evaluationHash, eventSequence: event.sequence, refresh };
      });
      return canonicalClone(transaction.immediate());
    } catch (error) {
      mapSqliteError(error);
    }
  }

  readBoundEvidence(aggregateId: string, iterationId: string): V2BoundEvidenceV1 | null {
    const db = this.#readyDatabase();
    boundedText(aggregateId, 'aggregate id');
    boundedText(iterationId, 'iteration id');
    const row = db.prepare(
      `SELECT record_json FROM v2_review_evidence
       WHERE aggregate_id = ? AND iteration_id = ?`,
    ).get(aggregateId, iterationId) as { readonly record_json: string } | undefined;
    if (row === undefined) return null;
    const record = parseCanonical<V2BoundEvidenceV1>(
      row.record_json,
      `v2 review evidence ${aggregateId}/${iterationId}`,
    );
    assertV2BoundEvidenceV1(record);
    return canonicalClone(record);
  }

  readBoundEvaluation(aggregateId: string, iterationId: string): V2BoundEvaluationV1 | null {
    const db = this.#readyDatabase();
    boundedText(aggregateId, 'aggregate id');
    boundedText(iterationId, 'iteration id');
    const row = db.prepare(
      `SELECT record_json FROM v2_review_evaluation
       WHERE aggregate_id = ? AND iteration_id = ?`,
    ).get(aggregateId, iterationId) as { readonly record_json: string } | undefined;
    if (row === undefined) return null;
    const record = parseCanonical<V2BoundEvaluationV1>(
      row.record_json,
      `v2 review evaluation ${aggregateId}/${iterationId}`,
    );
    assertV2BoundEvaluationV1(record);
    return canonicalClone(record);
  }

  listAggregatesAwaitingEvidence(): readonly {
    readonly aggregateId: string;
    readonly iterationId: string;
    readonly candidateRef: CandidateRef;
  }[] {
    const db = this.#readyDatabase();
    const rows = db.prepare(
      `SELECT aggregate_id FROM v2_aggregate_state WHERE task_status = 'review' ORDER BY aggregate_id`,
    ).all() as Array<{ readonly aggregate_id: string }>;
    const waiting: Array<{
      readonly aggregateId: string;
      readonly iterationId: string;
      readonly candidateRef: CandidateRef;
    }> = [];
    for (const row of rows) {
      const shadow = this.readTask(row.aggregate_id);
      if (shadow === null || shadow.iterations.length === 0) continue;
      const current = shadow.iterations[shadow.iterations.length - 1]!;
      if (current.candidateRef === null || current.candidateRef.kind !== 'git') continue;
      const evidence = db.prepare(
        'SELECT 1 AS present FROM v2_review_evidence WHERE aggregate_id = ? AND iteration_id = ?',
      ).get(row.aggregate_id, current.id) as { readonly present: number } | undefined;
      if (evidence !== undefined) continue;
      waiting.push({
        aggregateId: row.aggregate_id,
        iterationId: current.id,
        candidateRef: current.candidateRef,
      });
    }
    return canonicalClone(waiting);
  }

  listAggregatesAwaitingEvaluation(): readonly {
    readonly aggregateId: string;
    readonly iterationId: string;
    readonly evidenceHash: string;
  }[] {
    const db = this.#readyDatabase();
    const rows = db.prepare(
      `SELECT aggregate_id FROM v2_aggregate_state WHERE task_status = 'review' ORDER BY aggregate_id`,
    ).all() as Array<{ readonly aggregate_id: string }>;
    const waiting: Array<{
      readonly aggregateId: string;
      readonly iterationId: string;
      readonly evidenceHash: string;
    }> = [];
    for (const row of rows) {
      const shadow = this.readTask(row.aggregate_id);
      if (shadow === null || shadow.iterations.length === 0) continue;
      const current = shadow.iterations[shadow.iterations.length - 1]!;
      const evidence = db.prepare(
        `SELECT evidence_hash FROM v2_review_evidence
         WHERE aggregate_id = ? AND iteration_id = ?`,
      ).get(row.aggregate_id, current.id) as { readonly evidence_hash: string } | undefined;
      if (evidence === undefined) continue;
      const evaluation = db.prepare(
        'SELECT 1 AS present FROM v2_review_evaluation WHERE aggregate_id = ? AND iteration_id = ?',
      ).get(row.aggregate_id, current.id) as { readonly present: number } | undefined;
      if (evaluation !== undefined) continue;
      waiting.push({
        aggregateId: row.aggregate_id,
        iterationId: current.id,
        evidenceHash: evidence.evidence_hash,
      });
    }
    return canonicalClone(waiting);
  }

  exportSnapshot(destinationRoot: string, bundleName: string): ExportReceipt {
    const db = this.#readyDatabase();
    boundedText(bundleName, 'export bundle name');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(bundleName)) {
      fail('unsafe_path', 'export bundle name is invalid');
    }
    const exportRoot = this.#prepareExportRoot(destinationRoot);
    const finalPath = join(exportRoot, bundleName);
    if (existsSync(finalPath)) fail('export', 'export destination already exists');
    this.#cleanExportResidues(exportRoot, bundleName);
    const stagingName = `.hercules-export-${bundleName}-${randomUUID()}.tmp`;
    const staging = join(exportRoot, stagingName);
    mkdirSync(staging, { mode: 0o700 });
    const markerPath = join(staging, '.owner.json');
    writeFileSync(markerPath, canonicalSerialize({ bundleName, uid: process.getuid?.() ?? -1, version: 1 }), {
      mode: 0o600,
      flag: 'wx',
    });
    const copyPath = join(staging, 'state.sqlite');
    const manifestPath = join(staging, 'manifest.json');
    let renamed = false;
    try {
      db.prepare('VACUUM INTO ?').run(copyPath);
      chmodSync(copyPath, 0o600);
      const preparedCopy = new Database(copyPath);
      try {
        preparedCopy.pragma('journal_mode = WAL');
        preparedCopy.pragma('wal_checkpoint(TRUNCATE)');
      } finally {
        preparedCopy.close();
      }
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(`${copyPath}${suffix}`)) {
          fail('export', 'prepared snapshot left a live SQLite sidecar');
        }
      }
      this.#inject('export_before_readonly_verify');
      const copy = new Database(copyPath, { readonly: true, fileMustExist: true });
      let copyReport: StartupIntegrityReport;
      try {
        copy.pragma('foreign_keys = ON');
        copy.pragma('synchronous = FULL');
        copy.pragma(`busy_timeout = ${this.#busyTimeoutMs}`);
        copyReport = this.#verifyDatabase(copy);
      } finally {
        copy.close();
      }
      const readOnlyWal = `${copyPath}-wal`;
      const readOnlyShm = `${copyPath}-shm`;
      if (existsSync(readOnlyWal) && statSync(readOnlyWal).size !== 0) {
        fail('export', 'read-only snapshot verification produced WAL content');
      }
      if (existsSync(readOnlyWal)) rmSync(readOnlyWal);
      if (existsSync(readOnlyShm)) rmSync(readOnlyShm);
      this.#inject('export_after_readonly_verify');
      this.#inject('export_after_backup');
      const databaseSha256 = sha256File(copyPath);
      const manifest = {
        artifactContentIncluded: false,
        databaseFile: 'state.sqlite',
        databaseSha256,
        eventCount: copyReport.eventCount,
        lastEventHash: copyReport.lastEventHash,
        schemaVersion: copyReport.schemaVersion,
        version: 1,
      };
      writeFileSync(manifestPath, canonicalSerialize(manifest), { mode: 0o600, flag: 'wx' });
      this.#inject('export_after_manifest');
      rmSync(markerPath);
      fsyncPath(copyPath);
      fsyncPath(manifestPath);
      this.#inject('export_after_file_fsync');
      fsyncPath(staging);
      this.#inject('export_before_rename');
      renameSync(staging, finalPath);
      renamed = true;
      fsyncPath(exportRoot);
      this.#inject('export_after_rename');
      return {
        bundlePath: finalPath,
        databaseSha256,
        manifestSha256: sha256File(join(finalPath, 'manifest.json')),
        eventCount: copyReport.eventCount,
        lastEventHash: copyReport.lastEventHash,
        artifactContentIncluded: false,
      };
    } catch (error) {
      if (!renamed && existsSync(staging)) rmSync(staging, { recursive: true, force: true });
      if (renamed) fail('export', 'export committed but final directory fsync failed', error);
      if (error instanceof StateStoreError) throw error;
      fail('export', 'snapshot export failed', error);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#envelopeCache.clear();
    this.#db?.close();
    this.#db = null;
    this.#initialized = false;
    this.#closed = true;
  }

  #seamWired(): boolean {
    return this.#refreshReviewPackage !== undefined;
  }

  #legacyStatusForAggregate(aggregateId: string): V2TaskStatus {
    // No aggregate row yet: fall back to the closed V2 mapping. Retired shadow
    // tasks have no live Task state here, so use 'deleted'. Otherwise default
    // to 'todo' until a delivery/sweep supplies the live status.
    const shadow = this.readTask(aggregateId);
    if (shadow?.retirement !== null && shadow?.retirement !== undefined) {
      return 'deleted';
    }
    return 'todo';
  }

  #appendV2Event(
    db: Database.Database,
    input: {
      readonly eventType: V2ControlEventType;
      readonly aggregateId: string;
      readonly actor: ActorRef;
      readonly occurredAt: string;
      readonly eventId: string;
      readonly payload:
        | V2AggregateEventPayload
        | V2DecisionCommittedPayload
        | V2EvidenceBoundPayload
        | V2EvaluationBoundPayload;
    },
  ): ControlEvent {
    const previous = db.prepare(
      'SELECT event_hash FROM control_events ORDER BY sequence DESC LIMIT 1',
    ).get() as { readonly event_hash: string } | undefined;
    const nextSequence = Number(db.prepare(
      'SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM control_events',
    ).pluck().get());
    const event = buildControlEvent({
      sequence: nextSequence,
      eventId: input.eventId,
      eventType: input.eventType,
      aggregateKind: 'task',
      aggregateId: input.aggregateId,
      actor: input.actor,
      occurredAt: input.occurredAt,
      payload: input.payload,
      previousEventHash: previous?.event_hash ?? null,
    });
    db.prepare(`INSERT INTO control_events (
      sequence, event_id, event_type, aggregate_kind, aggregate_id,
      actor_kind, actor_id, occurred_at, payload_json, previous_event_hash, event_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      event.sequence, event.eventId, event.eventType, event.aggregateKind, event.aggregateId,
      event.actor.kind, event.actor.id, event.occurredAt, canonicalSerialize(event.payload),
      event.previousEventHash, event.eventHash,
    );
    return event;
  }

  #materializeOrRefresh(
    aggregateId: string,
    taskStatus: V2TaskStatus,
    occurredAt: string,
    actor: ActorRef,
  ): 'materialized' | 'refreshed' | 'unchanged' {
    if (!this.#seamWired()) return 'unchanged';
    const refresh = this.#refreshReviewPackage;
    if (refresh === undefined) return 'unchanged';
    if (V2_CREATE_NAMESPACE_RE.test(aggregateId)) {
      fail('invalid_input', 'V2 create namespace collision');
    }
    const db = this.#database();
    const shadow = this.readTask(aggregateId) ?? {
      taskId: aggregateId,
      contracts: [],
      iterations: [],
      stageRuns: [],
      retirement: null,
    };
    const humanDecisions = this.readV2HumanDecisions(aggregateId);
    const currentIterationId = shadow.iterations.length === 0
      ? null
      : shadow.iterations[shadow.iterations.length - 1]!.id;
    const evidence = currentIterationId === null
      ? null
      : this.readBoundEvidence(aggregateId, currentIterationId);
    const evaluation = currentIterationId === null
      ? null
      : this.readBoundEvaluation(aggregateId, currentIterationId);
    const result = refresh({
      aggregateId,
      taskStatus,
      shadow,
      humanDecisions,
      evidence,
      evaluation,
    });
    let projectionState: V2ProjectionState;
    let unprojectableReason: V2UnprojectableReason | null;
    let projectionHash: string | null;
    let reviewPackageJson: string | null;
    let reviewPackage: ReviewPackageV2 | null;
    if (result.kind === 'unprojectable') {
      projectionState = 'unprojectable';
      unprojectableReason = result.reason;
      projectionHash = null;
      reviewPackageJson = null;
      reviewPackage = null;
    } else {
      projectionState = 'projected';
      unprojectableReason = null;
      reviewPackage = result.reviewPackage;
      projectionHash = result.reviewPackage.projectionHash;
      reviewPackageJson = canonicalSerialize(result.reviewPackage);
    }
    const existing = db.prepare(`SELECT aggregate_id, state_version, task_status, review_package_json,
      projection_hash, projection_state, unprojectable_reason, updated_at_sequence
      FROM v2_aggregate_state WHERE aggregate_id = ?`).get(aggregateId) as V2AggregateStateRow | undefined;
    if (existing === undefined) {
      const payload: V2AggregateEventPayload = {
        kind: 'v2-aggregate',
        stateVersion: 1,
        taskStatus,
        projectionState,
        projectionHash,
        unprojectableReason,
      };
      const event = this.#appendV2Event(db, {
        eventType: 'V2AggregateMaterialized',
        aggregateId,
        actor,
        occurredAt,
        eventId: `v2-${aggregateId}-1`,
        payload,
      });
      db.prepare(`INSERT INTO v2_aggregate_state (
        aggregate_id, state_version, task_status, review_package_json, projection_hash,
        projection_state, unprojectable_reason, updated_at_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        aggregateId,
        1,
        taskStatus,
        reviewPackageJson,
        projectionHash,
        projectionState,
        unprojectableReason,
        event.sequence,
      );
      return 'materialized';
    }

    const existingPackage = existing.review_package_json === null
      ? null
      : parseCanonical<ReviewPackageV2>(
        existing.review_package_json,
        `v2 aggregate ${aggregateId} package`,
      );
    const statusEqual = existing.task_status === taskStatus
      && existing.projection_state === projectionState
      && existing.unprojectable_reason === unprojectableReason;
    const packagesUnchanged = projectionState === 'unprojectable'
      ? existingPackage === null && reviewPackage === null
      : existingPackage !== null
        && reviewPackage !== null
        && canonicalEqual(stripProjectedAt(existingPackage), stripProjectedAt(reviewPackage));
    if (statusEqual && packagesUnchanged) {
      return 'unchanged';
    }

    const nextVersion = Number(existing.state_version) + 1;
    const payload: V2AggregateEventPayload = {
      kind: 'v2-aggregate',
      stateVersion: nextVersion,
      taskStatus,
      projectionState,
      projectionHash,
      unprojectableReason,
    };
    const event = this.#appendV2Event(db, {
      eventType: 'V2AggregateRefreshed',
      aggregateId,
      actor,
      occurredAt,
      eventId: `v2-${aggregateId}-${nextVersion}`,
      payload,
    });
    db.prepare(`UPDATE v2_aggregate_state SET
      state_version = ?,
      task_status = ?,
      review_package_json = ?,
      projection_hash = ?,
      projection_state = ?,
      unprojectable_reason = ?,
      updated_at_sequence = ?
      WHERE aggregate_id = ?`).run(
      nextVersion,
      taskStatus,
      reviewPackageJson,
      projectionHash,
      projectionState,
      unprojectableReason,
      event.sequence,
      aggregateId,
    );
    return 'refreshed';
  }

  #readEnvelopeRow(db: Database.Database, deliveryId: string): EnvelopeRow | null {
    return (db.prepare(`${ENVELOPE_SELECT} WHERE e.delivery_id = ?`).get(deliveryId) as
      EnvelopeRow | undefined) ?? null;
  }

  #invalidateEnvelopeCache(deliveryId: string): void {
    this.#envelopeCache.delete(deliveryId);
  }

  #resolveEnvelopeFromStamp(stamp: EnvelopeStampRow): ProjectionEnvelopeState {
    const key = envelopeStampKey(stamp);
    const cached = this.#envelopeCache.get(stamp.delivery_id);
    if (cached !== undefined && cached.stamp === key) {
      this.#touchEnvelopeCache(stamp.delivery_id, cached);
      return cached.state;
    }
    const row = this.#readEnvelopeRow(this.#readyDatabase(), stamp.delivery_id);
    if (row === null) fail('integrity', 'projection envelope stamp row disappeared');
    return this.#cacheEnvelopeState(stamp, row);
  }

  #resolveEnvelopesFromStamps(stamps: readonly EnvelopeStampRow[]): ProjectionEnvelopeState[] {
    const states: ProjectionEnvelopeState[] = new Array(stamps.length);
    const missIndexes: number[] = [];
    for (let index = 0; index < stamps.length; index += 1) {
      const stamp = stamps[index]!;
      const key = envelopeStampKey(stamp);
      const cached = this.#envelopeCache.get(stamp.delivery_id);
      if (cached !== undefined && cached.stamp === key) {
        this.#touchEnvelopeCache(stamp.delivery_id, cached);
        states[index] = cached.state;
      } else {
        missIndexes.push(index);
      }
    }
    if (missIndexes.length === 0) return states;
    const missIds = missIndexes.map((index) => stamps[index]!.delivery_id);
    // Chunk the miss query: SQLite caps bound variables (32,766 by default) and
    // immutable history only grows (Codex round-6 B1).
    const byId = new Map<string, EnvelopeRow>();
    const db = this.#readyDatabase();
    for (let start = 0; start < missIds.length; start += ENVELOPE_MISS_QUERY_CHUNK) {
      const chunk = missIds.slice(start, start + ENVELOPE_MISS_QUERY_CHUNK);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = db.prepare(
        `${ENVELOPE_SELECT} WHERE e.delivery_id IN (${placeholders})`,
      ).all(...chunk) as EnvelopeRow[];
      for (const row of rows) byId.set(row.delivery_id, row);
    }
    for (const index of missIndexes) {
      const stamp = stamps[index]!;
      const row = byId.get(stamp.delivery_id);
      if (row === undefined) fail('integrity', 'projection envelope stamp row disappeared');
      states[index] = this.#cacheEnvelopeState(stamp, row);
    }
    return states;
  }

  #cacheEnvelopeState(stamp: EnvelopeStampRow, row: EnvelopeRow): ProjectionEnvelopeState {
    const state = deepFreeze(envelopeRowToState(row));
    this.#onEnvelopeParse?.(stamp.delivery_id);
    this.#envelopeCache.delete(stamp.delivery_id);
    this.#envelopeCache.set(stamp.delivery_id, {
      stamp: envelopeStampKey(stamp),
      state,
    });
    // Map iteration order is insertion order; the first key is the least
    // recently cached/refreshed entry.
    while (this.#envelopeCache.size > ENVELOPE_CACHE_MAX) {
      const oldest = this.#envelopeCache.keys().next().value;
      if (oldest === undefined) break;
      this.#envelopeCache.delete(oldest);
    }
    return state;
  }

  /** Refresh LRU recency on a cache hit (delete + re-insert keeps order = last use). */
  #touchEnvelopeCache(deliveryId: string, entry: EnvelopeCacheEntry): void {
    this.#envelopeCache.delete(deliveryId);
    this.#envelopeCache.set(deliveryId, entry);
  }

  #commitOne(db: Database.Database, command: ShadowCommitCommand): ShadowCommitReceipt {
    const digest = commandDigest(command);
    const existingRow = db.prepare(
      'SELECT idempotency_key, request_digest, event_id, result_json, committed_at FROM command_receipts WHERE idempotency_key = ?',
    ).get(command.idempotencyKey) as ReceiptRow | undefined;
    if (existingRow !== undefined) {
      if (existingRow.request_digest !== digest) {
        fail('idempotency_conflict', 'idempotency key was already used for another request');
      }
      const receipt = parseReceiptRow(existingRow);
      const eventRow = db.prepare(`SELECT sequence, event_id, event_type, aggregate_kind,
        aggregate_id, actor_kind, actor_id, occurred_at, payload_json,
        previous_event_hash, event_hash FROM control_events WHERE event_id = ?`)
        .get(receipt.eventId) as EventRow | undefined;
      if (eventRow === undefined) fail('integrity', 'idempotency receipt event is missing');
      const event = rowToEvent(eventRow);
      const expected: ShadowCommitReceipt = {
        idempotencyKey: command.idempotencyKey,
        requestDigest: digest,
        eventId: event.eventId,
        eventSequence: event.sequence,
        eventHash: event.eventHash,
        mutationKind: command.mutation.kind,
        aggregateKind: event.aggregateKind,
        aggregateId: event.aggregateId,
        committedAt: event.occurredAt,
      };
      if (!canonicalEqual(receipt, expected)) {
        fail('integrity', 'idempotency receipt does not match its persisted event');
      }
      return canonicalClone(receipt);
    }

    let parts: EventParts;
    try {
      parts = this.#applyMutation(db, command.mutation);
    } catch (error) {
      if (
        error instanceof ContractChangeError ||
        error instanceof ContractHashError ||
        error instanceof V2InvariantError ||
        error instanceof ControlEventError
      ) fail('constraint', 'state mutation violates domain invariants', error);
      throw error;
    }
    this.#inject('after_projection');
    const previous = db.prepare(
      'SELECT event_hash FROM control_events ORDER BY sequence DESC LIMIT 1',
    ).get() as { readonly event_hash: string } | undefined;
    const nextSequence = Number(db.prepare(
      'SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM control_events',
    ).pluck().get());
    const event = buildControlEvent({
      sequence: nextSequence,
      eventId: command.event.eventId,
      eventType: parts.eventType,
      aggregateKind: parts.aggregateKind,
      aggregateId: parts.aggregateId,
      actor: command.event.actor,
      occurredAt: command.event.occurredAt,
      payload: parts.payload,
      previousEventHash: previous?.event_hash ?? null,
    });
    db.prepare(`INSERT INTO control_events (
      sequence, event_id, event_type, aggregate_kind, aggregate_id,
      actor_kind, actor_id, occurred_at, payload_json, previous_event_hash, event_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      event.sequence, event.eventId, event.eventType, event.aggregateKind, event.aggregateId,
      event.actor.kind, event.actor.id, event.occurredAt, canonicalSerialize(event.payload),
      event.previousEventHash, event.eventHash,
    );
    this.#inject('after_event');
    const receipt: ShadowCommitReceipt = {
      idempotencyKey: command.idempotencyKey,
      requestDigest: digest,
      eventId: event.eventId,
      eventSequence: event.sequence,
      eventHash: event.eventHash,
      mutationKind: command.mutation.kind,
      aggregateKind: event.aggregateKind,
      aggregateId: event.aggregateId,
      committedAt: event.occurredAt,
    };
    db.prepare(`INSERT INTO command_receipts (
      idempotency_key, request_digest, event_id, result_json, committed_at
    ) VALUES (?, ?, ?, ?, ?)`).run(
      receipt.idempotencyKey, receipt.requestDigest, receipt.eventId,
      canonicalSerialize(receipt), receipt.committedAt,
    );
    this.#inject('after_receipt');
    return receipt;
  }

  #database(): Database.Database {
    if (this.#db === null) fail('not_initialized', 'state store is not initialized');
    return this.#db;
  }

  #readyDatabase(): Database.Database {
    if (this.#closed) fail('closed', 'state store is closed');
    if (!this.#initialized) fail('not_initialized', 'state store is not initialized');
    return this.#database();
  }

  #inject(point: StateStoreFailurePoint): void {
    this.#failureInjector?.(point);
  }

  #applyMigrations(db: Database.Database): void {
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    ).get();
    if (table === undefined) {
      const other = db.prepare(
        "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1",
      ).get();
      if (other !== undefined) fail('migration', 'unversioned database is not empty');
      const migration = STATE_MIGRATIONS[0]!;
      const create = db.transaction(() => {
        db.exec(migration.sql);
        db.prepare(
          'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        ).run(migration.version, migration.name, migration.checksum, new Date().toISOString());
      });
      create.immediate();
    }
    let rows = db.prepare(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
    ).all() as Array<{ readonly version: number; readonly name: string; readonly checksum: string }>;
    if (rows.length > STATE_MIGRATIONS.length) {
      fail('migration', 'database schema version is newer than this binary');
    }
    for (let index = 0; index < rows.length; index += 1) {
      const expected = STATE_MIGRATIONS[index]!;
      const actual = rows[index];
      if (
        actual === undefined ||
        actual.version !== expected.version ||
        actual.name !== expected.name ||
        actual.checksum !== expected.checksum
      ) {
        fail('migration', `schema migration ${expected.version} does not match registry`);
      }
    }
    for (let index = rows.length; index < STATE_MIGRATIONS.length; index += 1) {
      const migration = STATE_MIGRATIONS[index]!;
      if (migration.version === 3) {
        const existingIterations = db.prepare(
          'SELECT payload_json FROM shadow_iterations ORDER BY iteration_id',
        ).all() as PayloadRow[];
        for (const row of existingIterations) {
          const iteration = parseCanonical<Iteration>(row.payload_json, 'pre-V3 iteration');
          if (iteration.candidateRef?.kind === 'artifact') {
            fail('migration', 'V3 cannot prove a pre-existing artifact iteration candidate');
          }
        }
      }
      const apply = db.transaction(() => {
        db.exec(migration.sql);
        db.prepare(
          'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        ).run(migration.version, migration.name, migration.checksum, new Date().toISOString());
      });
      apply.immediate();
    }
    rows = db.prepare(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
    ).all() as Array<{ readonly version: number; readonly name: string; readonly checksum: string }>;
    if (rows.length !== STATE_MIGRATIONS.length) {
      fail('migration', 'database did not reach the registered schema version');
    }
  }

  #applyMutation(db: Database.Database, mutation: ShadowMutation): EventParts {
    switch (mutation.kind) {
      case 'insert_contract_root': {
        if (loadContracts(db, mutation.contract.taskId).length !== 0) {
          fail('constraint', 'root contract requires an empty task history');
        }
        const root = appendContractVersion([], mutation.contract)[0]!;
        db.prepare(`INSERT INTO shadow_task_contracts
          (task_id, version, contract_hash, payload_json) VALUES (?, ?, ?, ?)`)
          .run(root.taskId, root.version, root.contractHash, canonicalSerialize(root));
        this.#insertContractCriteria(db, root);
        return {
          eventType: 'ShadowContractRootProjected',
          aggregateKind: 'task',
          aggregateId: root.taskId,
          payload: { mutationKind: mutation.kind, contract: root },
        };
      }
      case 'append_contract_successor': {
        if (db.prepare('SELECT 1 FROM shadow_task_retirements WHERE task_id = ?')
          .get(mutation.request.taskId) !== undefined) {
          fail('constraint', 'retired task cannot accept another projection');
        }
        const history = loadContracts(db, mutation.request.taskId);
        const nextHistory = appendApprovedContractChange(
          history,
          mutation.request,
          mutation.provenance,
          mutation.trustedAuthority,
        );
        const next = nextHistory[nextHistory.length - 1]!;
        db.prepare(`INSERT INTO shadow_task_contracts
          (task_id, version, contract_hash, payload_json) VALUES (?, ?, ?, ?)`)
          .run(next.taskId, next.version, next.contractHash, canonicalSerialize(next));
        this.#insertContractCriteria(db, next);
        return {
          eventType: 'ShadowContractSuccessorProjected',
          aggregateKind: 'task',
          aggregateId: next.taskId,
          payload: {
            mutationKind: mutation.kind,
            request: mutation.request,
            provenance: mutation.provenance,
            trustedAuthority: mutation.trustedAuthority,
            nextContract: next,
          },
        };
      }
      case 'put_iteration': {
        const next = mutation.iteration;
        if (next.candidateRef?.kind === 'artifact') {
          fail('constraint', 'artifact candidates require archive-coordinated iteration advancement');
        }
        if (db.prepare('SELECT 1 FROM shadow_task_retirements WHERE task_id = ?')
          .get(next.taskId) !== undefined) {
          fail('constraint', 'retired task cannot accept another projection');
        }
        const row = db.prepare(
          'SELECT payload_json FROM shadow_iterations WHERE iteration_id = ?',
        ).get(next.id) as PayloadRow | undefined;
        const existing = row === undefined ? null : parseCanonical<Iteration>(row.payload_json, `iteration ${next.id}`);
        const history = loadIterationsForTask(db, next.taskId);
        applyIteration(existing, history, next);
        if (existing === null) {
          db.prepare(`INSERT INTO shadow_iterations
            (iteration_id, task_id, contract_version, ordinal, payload_json)
            VALUES (?, ?, ?, ?, ?)`).run(
              next.id, next.taskId, next.contractVersion, next.ordinal, canonicalSerialize(next),
            );
        } else {
          db.prepare('UPDATE shadow_iterations SET payload_json = ? WHERE iteration_id = ?')
            .run(canonicalSerialize(next), next.id);
        }
        return {
          eventType: 'ShadowIterationProjectionCommitted',
          aggregateKind: 'iteration',
          aggregateId: next.id,
          payload: { mutationKind: mutation.kind, iteration: next },
        };
      }
      case 'put_stage_run': {
        const next = mutation.stageRun;
        if (db.prepare(`SELECT 1 FROM shadow_task_retirements r
          JOIN shadow_iterations i ON i.task_id = r.task_id
          WHERE i.iteration_id = ?`).get(next.iterationId) !== undefined) {
          fail('constraint', 'retired task cannot accept another projection');
        }
        const row = db.prepare(
          'SELECT payload_json FROM shadow_stage_runs WHERE stage_run_id = ?',
        ).get(next.id) as PayloadRow | undefined;
        const existing = row === undefined ? null : parseCanonical<StageRun>(row.payload_json, `stage ${next.id}`);
        const history = loadStagesForIteration(db, next.iterationId);
        applyStage(existing, history, next);
        if (existing === null) {
          db.prepare(`INSERT INTO shadow_stage_runs
            (stage_run_id, iteration_id, stage_type, attempt, payload_json)
            VALUES (?, ?, ?, ?, ?)`).run(
              next.id, next.iterationId, next.type, next.attempt, canonicalSerialize(next),
            );
        } else {
          db.prepare('UPDATE shadow_stage_runs SET payload_json = ? WHERE stage_run_id = ?')
            .run(canonicalSerialize(next), next.id);
        }
        return {
          eventType: 'ShadowStageRunProjectionCommitted',
          aggregateKind: 'stage_run',
          aggregateId: next.id,
          payload: { mutationKind: mutation.kind, stageRun: next },
        };
      }
      case 'retire_task': {
        const retirement: ShadowTaskRetirement = {
          taskId: mutation.taskId,
          revision: mutation.revision,
        };
        if (loadContracts(db, retirement.taskId).length === 0) {
          fail('constraint', 'retirement requires an existing projected task');
        }
        const existing = db.prepare(
          'SELECT payload_json FROM shadow_task_retirements WHERE task_id = ?',
        ).get(retirement.taskId) as PayloadRow | undefined;
        if (existing !== undefined) {
          const current = parseCanonical<ShadowTaskRetirement>(
            existing.payload_json,
            `retirement ${retirement.taskId}`,
          );
          if (!canonicalEqual(current, retirement)) {
            fail('constraint', 'task was already retired at another revision');
          }
        } else {
          db.prepare(`INSERT INTO shadow_task_retirements
            (task_id, revision, payload_json) VALUES (?, ?, ?)`).run(
            retirement.taskId, retirement.revision, canonicalSerialize(retirement),
          );
        }
        return {
          eventType: 'ShadowTaskRetired',
          aggregateKind: 'task',
          aggregateId: retirement.taskId,
          payload: { mutationKind: mutation.kind, retirement },
        };
      }
    }
  }

  #insertContractCriteria(db: Database.Database, contract: TaskContract): void {
    const insert = db.prepare(`INSERT INTO shadow_contract_criteria
      (task_id, contract_version, criterion_id) VALUES (?, ?, ?)`);
    for (const criterion of contract.acceptanceCriteria) {
      insert.run(contract.taskId, contract.version, criterion.id);
    }
  }

  #verifyDatabase(db: Database.Database): StartupIntegrityReport {
    this.#assertPragmas(db);
    this.#assertSchemaObjects(db);
    const quick = db.pragma('quick_check', { simple: true });
    if (quick !== 'ok') fail('integrity', 'SQLite quick_check failed');
    const foreign = db.pragma('foreign_key_check') as unknown[];
    if (foreign.length !== 0) fail('integrity', 'SQLite foreign_key_check failed');
    return this.#replayAndVerify(db);
  }

  #assertPragmas(db: Database.Database): void {
    if (Number(db.pragma('foreign_keys', { simple: true })) !== 1) {
      fail('integrity', 'SQLite foreign keys are disabled');
    }
    if (String(db.pragma('journal_mode', { simple: true })).toLowerCase() !== 'wal') {
      fail('integrity', 'SQLite journal mode is not WAL');
    }
    if (Number(db.pragma('synchronous', { simple: true })) !== 2) {
      fail('integrity', 'SQLite synchronous mode is not FULL');
    }
  }

  #assertSchemaObjects(db: Database.Database): void {
    const schemaQuery = `SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`;
    const actual = db.prepare(schemaQuery).all();
    const expectedDb = new Database(':memory:');
    let expected: unknown[];
    try {
      for (const migration of STATE_MIGRATIONS) expectedDb.exec(migration.sql);
      expected = expectedDb.prepare(schemaQuery).all();
    } finally {
      expectedDb.close();
    }
    if (!canonicalEqual(actual, expected)) {
      fail('integrity', 'database schema differs from the registered migration DDL');
    }
  }

  #replayAndVerify(db: Database.Database): StartupIntegrityReport {
    const eventRows = db.prepare(`SELECT sequence, event_id, event_type, aggregate_kind,
      aggregate_id, actor_kind, actor_id, occurred_at, payload_json,
      previous_event_hash, event_hash FROM control_events ORDER BY sequence`).all() as EventRow[];
    const events = eventRows.map(rowToEvent);
    const contracts = new Map<string, TaskContract[]>();
    const iterations = new Map<string, Iteration>();
    const stages = new Map<string, StageRun>();
    const retirements = new Map<string, ShadowTaskRetirement>();
    let previousHash: string | null = null;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index]!;
      if (event.sequence !== index + 1 || event.previousEventHash !== previousHash) {
        fail('integrity', 'event sequence or previous hash is discontinuous');
      }
      previousHash = event.eventHash;
      this.#replayEvent(event, contracts, iterations, stages, retirements);
    }
    this.#compareProjectionTables(db, contracts, iterations, stages, retirements);
    const receiptRows = db.prepare(
      'SELECT idempotency_key, request_digest, event_id, result_json, committed_at FROM command_receipts ORDER BY event_id',
    ).all() as ReceiptRow[];
    const archiveEventTypes = new Set<ControlEventType>([
      'ArtifactCaptureAuthorized',
      'ArtifactMetadataRecorded',
      'EvidenceManifestRecorded',
      'ArtifactMetadataRetired',
    ]);
    const v2EventTypes = new Set<string>(V2_CONTROL_EVENT_TYPES);
    const generalEvents = events.filter((event) => (
      !archiveEventTypes.has(event.eventType) && !v2EventTypes.has(event.eventType)
    ));
    if (receiptRows.length !== generalEvents.length) {
      fail('integrity', 'general event and receipt counts differ');
    }
    const eventById = new Map(events.map((event) => [event.eventId, event]));
    const seenEvents = new Set<string>();
    const receiptsByKey = new Map<string, ShadowCommitReceipt>();
    for (const row of receiptRows) {
      const receipt = parseReceiptRow(row);
      receiptsByKey.set(row.idempotency_key, receipt);
      const event = eventById.get(receipt.eventId);
      if (event === undefined || seenEvents.has(event.eventId)) {
        fail('integrity', 'receipt has an orphan or duplicate event binding');
      }
      seenEvents.add(event.eventId);
      const command = this.#commandFromEvent(row.idempotency_key, event);
      const expectedDigest = commandDigest(validateShadowCommitCommand(command));
      const expected: ShadowCommitReceipt = {
        idempotencyKey: row.idempotency_key,
        requestDigest: expectedDigest,
        eventId: event.eventId,
        eventSequence: event.sequence,
        eventHash: event.eventHash,
        mutationKind: command.mutation.kind,
        aggregateKind: event.aggregateKind,
        aggregateId: event.aggregateId,
        committedAt: event.occurredAt,
      };
      if (row.request_digest !== expectedDigest || !canonicalEqual(receipt, expected)) {
        fail('integrity', 'receipt does not match its event and command');
      }
    }
    const archiveReceiptEvents = db.prepare(
      'SELECT event_id FROM artifact_archive_receipts ORDER BY event_id',
    ).pluck().all() as string[];
    const expectedArchiveEvents = events
      .filter((event) => archiveEventTypes.has(event.eventType))
      .map((event) => event.eventId)
      .sort();
    if (!canonicalEqual(archiveReceiptEvents, expectedArchiveEvents)) {
      fail('integrity', 'archive event and receipt bindings differ');
    }
    // Stream rows: materializing every authority input at once (multi-MB
    // per reconciliation envelope) is what the heap bound forbids.
    const envelopeRows = db.prepare(`${ENVELOPE_SELECT} ORDER BY e.rowid`)
      .iterate() as IterableIterator<EnvelopeRow>;
    for (const row of envelopeRows) {
      const envelope = envelopeRowToState(row);
      const acks = db.prepare(`SELECT batch_ordinal, start_index, end_index, receipt_digests_json
        FROM projection_batch_acknowledgements WHERE delivery_id = ? ORDER BY batch_ordinal`)
        .all(envelope.deliveryId) as BatchAckRow[];
      let cursor = 0;
      for (const [expectedOrdinal, ack] of acks.entries()) {
        if (ack.batch_ordinal !== expectedOrdinal || ack.start_index !== cursor ||
            ack.end_index <= ack.start_index ||
            ack.end_index > envelope.manifest.length) {
          fail('integrity', 'projection batch acknowledgement order or ranges are discontinuous');
        }
        const digests = parseCanonical<readonly string[]>(
          ack.receipt_digests_json,
          `projection batch acknowledgement ${envelope.deliveryId}`,
        );
        if (digests.length !== ack.end_index - ack.start_index ||
            digests.some((digest) => !SHA256_RE.test(digest))) {
          fail('integrity', 'projection batch acknowledgement digests are invalid');
        }
        for (let index = ack.start_index; index < ack.end_index; index += 1) {
          const manifestEntry = envelope.manifest[index];
          const receipt = manifestEntry === undefined
            ? undefined
            : receiptsByKey.get(manifestEntry.idempotencyKey);
          const receiptDigest = digests[index - ack.start_index];
          if (receipt === undefined || receipt.requestDigest !== manifestEntry?.commandDigest ||
              receiptDigest !== hashCanonicalJson(receipt)) {
            fail('integrity', 'projection batch acknowledgement does not bind exact receipts');
          }
        }
        cursor = ack.end_index;
      }
      if (cursor !== envelope.acknowledgedCommands ||
          (envelope.completed && cursor !== envelope.manifest.length)) {
        fail('integrity', 'projection envelope completion does not match batches');
      }
    }
    this.#verifyV2Aggregates(db, events);
    return {
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      eventCount: events.length,
      receiptCount: receiptRows.length + archiveReceiptEvents.length,
      lastEventHash: previousHash,
      journalMode: 'wal',
      foreignKeys: true,
      synchronous: 'full',
    };
  }

  #verifyV2Aggregates(db: Database.Database, events: readonly ControlEvent[]): void {
    const versionedEventTypes = new Set<string>(V2_VERSIONED_EVENT_TYPES);
    const bindEventTypes = new Set<string>(V2_BIND_EVENT_TYPES);
    const v2EventTypes = new Set<string>(V2_CONTROL_EVENT_TYPES);
    const v2Events = events.filter((event) => v2EventTypes.has(event.eventType));
    const versionedEvents = v2Events.filter((event) => versionedEventTypes.has(event.eventType));
    const bindEvents = v2Events.filter((event) => bindEventTypes.has(event.eventType));
    const byAggregate = new Map<string, ControlEvent[]>();
    for (const event of versionedEvents) {
      const list = byAggregate.get(event.aggregateId) ?? [];
      list.push(event);
      byAggregate.set(event.aggregateId, list);
    }

    const aggregateRows = db.prepare(`SELECT aggregate_id, state_version, task_status, review_package_json,
      projection_hash, projection_state, unprojectable_reason, updated_at_sequence
      FROM v2_aggregate_state`).all() as V2AggregateStateRow[];
    const rowById = new Map(aggregateRows.map((row) => [row.aggregate_id, row]));

    for (const [aggregateId, aggregateEvents] of byAggregate) {
      const row = rowById.get(aggregateId);
      if (row === undefined) {
        fail('integrity', `V2 aggregate ${aggregateId} has events but no state row`);
      }
      const count = aggregateEvents.length;
      if (Number(row.state_version) !== count) {
        fail('integrity', `V2 aggregate ${aggregateId} state_version does not match event count`);
      }
      const first = aggregateEvents[0]!;
      if (first.eventType !== 'V2AggregateMaterialized') {
        fail('integrity', `V2 aggregate ${aggregateId} must begin with V2AggregateMaterialized`);
      }
      for (let index = 1; index < aggregateEvents.length; index += 1) {
        if (aggregateEvents[index]!.eventType === 'V2AggregateMaterialized') {
          fail('integrity', `V2 aggregate ${aggregateId} has a later V2AggregateMaterialized`);
        }
      }
      for (const [index, event] of aggregateEvents.entries()) {
        const expectedVersion = index + 1;
        if (event.eventType === 'V2DecisionCommitted') {
          assertV2DecisionCommittedPayload(event.payload);
          if (event.payload.stateVersion !== expectedVersion) {
            fail('integrity', `V2 aggregate ${aggregateId} decision stateVersion chain is invalid`);
          }
          // commitV2 appends the (always content-changing) post-decision refresh in
          // the same transaction, so a decision is never this aggregate's last V2
          // event and is always followed by V2AggregateRefreshed. A truncated tail
          // would otherwise restore the pre-decision package and re-admit a decision.
          if (aggregateEvents[index + 1]?.eventType !== 'V2AggregateRefreshed') {
            fail('integrity', `V2 aggregate ${aggregateId} decision at version ${expectedVersion} lacks its post-decision refresh`);
          }
        } else {
          assertV2AggregateEventPayload(event.payload);
          if (event.payload.stateVersion !== expectedVersion) {
            fail('integrity', `V2 aggregate ${aggregateId} stateVersion chain is invalid`);
          }
        }
      }
      const last = aggregateEvents[aggregateEvents.length - 1]!;
      if (Number(row.updated_at_sequence) !== last.sequence) {
        fail('integrity', `V2 aggregate ${aggregateId} updated_at_sequence does not match last event`);
      }
      if (last.eventType === 'V2DecisionCommitted') {
        assertV2DecisionCommittedPayload(last.payload);
        if (last.payload.stateVersion !== count) {
          fail('integrity', `V2 aggregate ${aggregateId} last decision stateVersion mismatch`);
        }
      } else {
        assertV2AggregateEventPayload(last.payload);
        if (
          last.payload.stateVersion !== count ||
          row.task_status !== last.payload.taskStatus ||
          row.projection_state !== last.payload.projectionState ||
          row.projection_hash !== last.payload.projectionHash ||
          row.unprojectable_reason !== last.payload.unprojectableReason
        ) {
          fail('integrity', `V2 aggregate ${aggregateId} row does not match last event payload`);
        }
      }
      if (row.projection_state === 'projected') {
        if (row.review_package_json === null || row.projection_hash === null) {
          fail('integrity', `V2 aggregate ${aggregateId} projected row is missing package bytes`);
        }
        const packageValue = parseCanonical<ReviewPackageV2>(
          row.review_package_json,
          `v2 aggregate ${aggregateId} package`,
        );
        // Re-derive the projection digest from the stored bytes (the domain
        // projector defines projectionHash = hashCanonicalJson(package minus
        // projectionHash)). Structural projection authority stays in the
        // domain; the store only proves the bytes it holds are the bytes the
        // seam produced.
        const { projectionHash: storedHash, ...withoutHash } = packageValue;
        if (storedHash !== row.projection_hash || hashCanonicalJson(withoutHash) !== storedHash) {
          fail('integrity', `V2 aggregate ${aggregateId} projection_hash does not match package bytes`);
        }
      }
    }

    for (const row of aggregateRows) {
      if (!byAggregate.has(row.aggregate_id)) {
        fail('integrity', `V2 aggregate ${row.aggregate_id} state row has no V2 events`);
      }
    }

    const decisionEvents = versionedEvents.filter((event) => event.eventType === 'V2DecisionCommitted');
    const ledgerRows = db.prepare(
      'SELECT key_hash, aggregate_id, request_hash, event_sequence, receipt_json FROM v2_admission_ledger',
    ).all() as Array<{
      readonly key_hash: string;
      readonly aggregate_id: string;
      readonly request_hash: string;
      readonly event_sequence: number;
      readonly receipt_json: string;
    }>;
    const ledgerByKey = new Map(ledgerRows.map((row) => [row.key_hash, row]));
    const ledgerBySequence = new Map(ledgerRows.map((row) => [Number(row.event_sequence), row]));

    for (const event of decisionEvents) {
      assertV2DecisionCommittedPayload(event.payload);
      const ledger = ledgerByKey.get(event.payload.keyHash);
      if (ledger === undefined) {
        fail('integrity', `V2DecisionCommitted ${event.eventId} has no admission ledger row`);
      }
      if (Number(ledger.event_sequence) !== event.sequence) {
        fail('integrity', `V2DecisionCommitted ${event.eventId} ledger event_sequence mismatch`);
      }
      // The ledger row and its receipt are bound field-by-field to the event they
      // pair with: a rewritten receipt (even one with a recomputed receiptHash)
      // must not survive boot while the event still records the original commit.
      const receipt = parseCanonical<ControlApiV2ReceiptV1>(
        ledger.receipt_json, `v2 admission ledger ${ledger.key_hash}`,
      );
      assertControlApiV2ReceiptV1(receipt);
      const { receiptHash, ...receiptWithoutHash } = receipt;
      if (
        computeReceiptHash(receiptWithoutHash) !== receiptHash ||
        receipt.outcome !== 'committed' ||
        receipt.resource !== 'decision' ||
        receipt.reason !== null ||
        receipt.aggregateId !== event.aggregateId ||
        receipt.keyHash !== event.payload.keyHash ||
        receipt.requestHash !== event.payload.requestHash ||
        receipt.decidedAt !== event.payload.decidedAt ||
        receipt.eventSequence !== event.sequence ||
        receipt.stateVersion !== event.payload.stateVersion ||
        ledger.aggregate_id !== event.aggregateId ||
        ledger.request_hash !== event.payload.requestHash
      ) {
        fail('integrity', `V2DecisionCommitted ${event.eventId} ledger receipt mismatch`);
      }
    }
    for (const ledger of ledgerRows) {
      const event = decisionEvents.find((item) => item.sequence === Number(ledger.event_sequence));
      if (event === undefined) {
        fail('integrity', `admission ledger ${ledger.key_hash} has no V2DecisionCommitted event`);
      }
      assertV2DecisionCommittedPayload(event.payload);
      if (event.payload.keyHash !== ledger.key_hash) {
        fail('integrity', `admission ledger ${ledger.key_hash} does not pair with its event`);
      }
      if (ledgerBySequence.get(Number(ledger.event_sequence)) !== ledger) {
        fail('integrity', `admission ledger event_sequence ${ledger.event_sequence} is duplicated`);
      }
    }

    // Every V2DecisionCommitted must pair with exactly one pending-effect marker
    // (pending or applied). A deleted marker fails boot integrity.
    const pendingEffectRows = db.prepare(
      `SELECT key_hash, aggregate_id, action, event_sequence, effect_state, applied_at_sequence
       FROM v2_pending_effects`,
    ).all() as Array<{
      readonly key_hash: string;
      readonly aggregate_id: string;
      readonly action: string;
      readonly event_sequence: number;
      readonly effect_state: string;
      readonly applied_at_sequence: number | null;
    }>;
    const pendingByKey = new Map(pendingEffectRows.map((row) => [row.key_hash, row]));
    const pendingBySequence = new Map(
      pendingEffectRows.map((row) => [Number(row.event_sequence), row]),
    );
    for (const event of decisionEvents) {
      assertV2DecisionCommittedPayload(event.payload);
      const marker = pendingByKey.get(event.payload.keyHash);
      if (marker === undefined) {
        fail('integrity', `V2DecisionCommitted ${event.eventId} has no pending-effect marker`);
      }
      if (Number(marker.event_sequence) !== event.sequence) {
        fail(
          'integrity',
          `V2DecisionCommitted ${event.eventId} pending-effect event_sequence mismatch`,
        );
      }
      if (marker.aggregate_id !== event.aggregateId || marker.action !== event.payload.action) {
        fail('integrity', `V2DecisionCommitted ${event.eventId} pending-effect fields mismatch`);
      }
    }
    for (const marker of pendingEffectRows) {
      const event = decisionEvents.find((item) => item.sequence === Number(marker.event_sequence));
      if (event === undefined) {
        fail('integrity', `pending-effect ${marker.key_hash} has no V2DecisionCommitted event`);
      }
      assertV2DecisionCommittedPayload(event.payload);
      if (event.payload.keyHash !== marker.key_hash) {
        fail('integrity', `pending-effect ${marker.key_hash} does not pair with its event`);
      }
      if (pendingBySequence.get(Number(marker.event_sequence)) !== marker) {
        fail('integrity', `pending-effect event_sequence ${marker.event_sequence} is duplicated`);
      }
    }

    this.#verifyV2ReviewTruth(db, bindEvents);
  }

  #verifyV2ReviewTruth(db: Database.Database, bindEvents: readonly ControlEvent[]): void {
    const evidenceEvents = bindEvents.filter((event) => event.eventType === 'V2EvidenceBound');
    const evaluationEvents = bindEvents.filter((event) => event.eventType === 'V2EvaluationBound');

    const evidenceRows = db.prepare(
      `SELECT aggregate_id, iteration_id, manifest_id, manifest_hash, evidence_hash,
              record_json, event_sequence FROM v2_review_evidence`,
    ).all() as Array<{
      readonly aggregate_id: string;
      readonly iteration_id: string;
      readonly manifest_id: string;
      readonly manifest_hash: string;
      readonly evidence_hash: string;
      readonly record_json: string;
      readonly event_sequence: number;
    }>;
    const evaluationRows = db.prepare(
      `SELECT aggregate_id, iteration_id, receipt_id, evidence_hash, evaluation_hash,
              record_json, event_sequence FROM v2_review_evaluation`,
    ).all() as Array<{
      readonly aggregate_id: string;
      readonly iteration_id: string;
      readonly receipt_id: string;
      readonly evidence_hash: string;
      readonly evaluation_hash: string;
      readonly record_json: string;
      readonly event_sequence: number;
    }>;

    const evidenceByKey = new Map(
      evidenceRows.map((row) => [`${row.aggregate_id}\0${row.iteration_id}`, row]),
    );
    const evaluationByKey = new Map(
      evaluationRows.map((row) => [`${row.aggregate_id}\0${row.iteration_id}`, row]),
    );

    for (const event of evidenceEvents) {
      assertV2EvidenceBoundPayload(event.payload);
      const key = `${event.aggregateId}\0${event.payload.iterationId}`;
      const row = evidenceByKey.get(key);
      if (row === undefined) {
        fail('integrity', `V2EvidenceBound ${event.eventId} has no review evidence row`);
      }
      if (
        Number(row.event_sequence) !== event.sequence ||
        row.manifest_id !== event.payload.manifestId ||
        row.manifest_hash !== event.payload.manifestHash ||
        row.evidence_hash !== event.payload.evidenceHash
      ) {
        fail('integrity', `V2EvidenceBound ${event.eventId} does not pair with its evidence row`);
      }
      const record = parseCanonical<V2BoundEvidenceV1>(
        row.record_json,
        `v2 review evidence ${row.aggregate_id}/${row.iteration_id}`,
      );
      assertV2BoundEvidenceV1(record);
      const { evidenceHash: _ignored, ...withoutHash } = record;
      if (
        computeV2BoundEvidenceHash(withoutHash) !== row.evidence_hash ||
        record.evidenceHash !== row.evidence_hash ||
        record.aggregateId !== event.aggregateId ||
        record.iterationId !== event.payload.iterationId ||
        record.evidenceManifest.id !== event.payload.manifestId ||
        record.evidenceManifest.manifestHash !== event.payload.manifestHash
      ) {
        fail('integrity', `V2EvidenceBound ${event.eventId} record_json hash mismatch`);
      }
    }
    for (const row of evidenceRows) {
      const event = evidenceEvents.find((item) => item.sequence === Number(row.event_sequence));
      if (event === undefined) {
        fail(
          'integrity',
          `v2_review_evidence ${row.aggregate_id}/${row.iteration_id} has no V2EvidenceBound event`,
        );
      }
      assertV2EvidenceBoundPayload(event.payload);
      if (
        event.aggregateId !== row.aggregate_id ||
        event.payload.iterationId !== row.iteration_id ||
        event.payload.evidenceHash !== row.evidence_hash
      ) {
        fail(
          'integrity',
          `v2_review_evidence ${row.aggregate_id}/${row.iteration_id} does not pair with its event`,
        );
      }
    }

    for (const event of evaluationEvents) {
      assertV2EvaluationBoundPayload(event.payload);
      const key = `${event.aggregateId}\0${event.payload.iterationId}`;
      const row = evaluationByKey.get(key);
      if (row === undefined) {
        fail('integrity', `V2EvaluationBound ${event.eventId} has no review evaluation row`);
      }
      if (
        Number(row.event_sequence) !== event.sequence ||
        row.receipt_id !== event.payload.receiptId ||
        row.evidence_hash !== event.payload.evidenceHash ||
        row.evaluation_hash !== event.payload.evaluationHash
      ) {
        fail('integrity', `V2EvaluationBound ${event.eventId} does not pair with its evaluation row`);
      }
      const record = parseCanonical<V2BoundEvaluationV1>(
        row.record_json,
        `v2 review evaluation ${row.aggregate_id}/${row.iteration_id}`,
      );
      assertV2BoundEvaluationV1(record);
      const { evaluationHash: _ignored, ...withoutHash } = record;
      if (
        computeV2BoundEvaluationHash(withoutHash) !== row.evaluation_hash ||
        record.evaluationHash !== row.evaluation_hash ||
        record.aggregateId !== event.aggregateId ||
        record.iterationId !== event.payload.iterationId ||
        record.receipt.receiptId !== event.payload.receiptId ||
        record.evidenceHash !== event.payload.evidenceHash
      ) {
        fail('integrity', `V2EvaluationBound ${event.eventId} record_json hash mismatch`);
      }
    }
    for (const row of evaluationRows) {
      const event = evaluationEvents.find((item) => item.sequence === Number(row.event_sequence));
      if (event === undefined) {
        fail(
          'integrity',
          `v2_review_evaluation ${row.aggregate_id}/${row.iteration_id} has no V2EvaluationBound event`,
        );
      }
      assertV2EvaluationBoundPayload(event.payload);
      if (
        event.aggregateId !== row.aggregate_id ||
        event.payload.iterationId !== row.iteration_id ||
        event.payload.evaluationHash !== row.evaluation_hash
      ) {
        fail(
          'integrity',
          `v2_review_evaluation ${row.aggregate_id}/${row.iteration_id} does not pair with its event`,
        );
      }
    }
  }

  #replayEvent(
    event: ControlEvent,
    contracts: Map<string, TaskContract[]>,
    iterations: Map<string, Iteration>,
    stages: Map<string, StageRun>,
    retirements: Map<string, ShadowTaskRetirement>,
  ): void {
    const v2EventTypes = new Set<string>(V2_CONTROL_EVENT_TYPES);
    if (v2EventTypes.has(event.eventType)) {
      if (event.aggregateKind !== 'task') {
        fail('integrity', 'V2 event aggregate kind must be task');
      }
      try {
        if (event.eventType === 'V2DecisionCommitted') {
          assertV2DecisionCommittedPayload(event.payload);
        } else if (event.eventType === 'V2EvidenceBound') {
          assertV2EvidenceBoundPayload(event.payload);
        } else if (event.eventType === 'V2EvaluationBound') {
          assertV2EvaluationBoundPayload(event.payload);
        } else {
          assertV2AggregateEventPayload(event.payload);
        }
      } catch (error) {
        fail(
          'integrity',
          error instanceof Error ? error.message : 'V2 event payload is invalid',
          error,
        );
      }
      return;
    }
    if (!isRecord(event.payload) || typeof event.payload['mutationKind'] !== 'string') {
      fail('integrity', 'event payload schema is invalid');
    }
    switch (event.eventType) {
      case 'ShadowContractRootProjected': {
        if (!exactKeys(event.payload, ['mutationKind', 'contract']) || event.payload['mutationKind'] !== 'insert_contract_root') {
          fail('integrity', 'root event payload is invalid');
        }
        const contract = event.payload['contract'] as TaskContract;
        if (event.aggregateKind !== 'task' || event.aggregateId !== contract.taskId) {
          fail('integrity', 'root event aggregate is invalid');
        }
        const history = contracts.get(contract.taskId) ?? [];
        const next = appendContractVersion(history, contract);
        contracts.set(contract.taskId, [...next]);
        return;
      }
      case 'ShadowContractSuccessorProjected': {
        if (retirements.has(event.aggregateId)) {
          fail('integrity', 'retired task received a later contract event');
        }
        if (!exactKeys(event.payload, ['mutationKind', 'request', 'provenance', 'trustedAuthority', 'nextContract']) || event.payload['mutationKind'] !== 'append_contract_successor') {
          fail('integrity', 'contract successor event payload is invalid');
        }
        const nextContract = event.payload['nextContract'] as TaskContract;
        if (event.aggregateKind !== 'task' || event.aggregateId !== nextContract.taskId) {
          fail('integrity', 'contract successor aggregate is invalid');
        }
        const history = contracts.get(nextContract.taskId) ?? [];
        const nextHistory = appendApprovedContractChange(
          history,
          event.payload['request'] as never,
          event.payload['provenance'] as never,
          event.payload['trustedAuthority'] as never,
        );
        if (!canonicalEqual(nextHistory[nextHistory.length - 1], nextContract)) {
          fail('integrity', 'contract successor replay did not reproduce persisted contract');
        }
        contracts.set(nextContract.taskId, [...nextHistory]);
        return;
      }
      case 'ShadowIterationProjectionCommitted': {
        if (!exactKeys(event.payload, ['mutationKind', 'iteration']) || event.payload['mutationKind'] !== 'put_iteration') {
          fail('integrity', 'iteration event payload is invalid');
        }
        const next = event.payload['iteration'] as Iteration;
        if (retirements.has(next.taskId)) {
          fail('integrity', 'retired task received a later iteration event');
        }
        if (event.aggregateKind !== 'iteration' || event.aggregateId !== next.id) {
          fail('integrity', 'iteration event aggregate is invalid');
        }
        const existing = iterations.get(next.id) ?? null;
        const history = [...iterations.values()]
          .filter((value) => value.taskId === next.taskId)
          .sort((a, b) => a.ordinal - b.ordinal);
        applyIteration(existing, history, next);
        iterations.set(next.id, canonicalClone(next));
        return;
      }
      case 'ShadowStageRunProjectionCommitted': {
        if (!exactKeys(event.payload, ['mutationKind', 'stageRun']) || event.payload['mutationKind'] !== 'put_stage_run') {
          fail('integrity', 'stage event payload is invalid');
        }
        const next = event.payload['stageRun'] as StageRun;
        const taskId = iterations.get(next.iterationId)?.taskId;
        if (taskId !== undefined && retirements.has(taskId)) {
          fail('integrity', 'retired task received a later stage event');
        }
        if (event.aggregateKind !== 'stage_run' || event.aggregateId !== next.id) {
          fail('integrity', 'stage event aggregate is invalid');
        }
        const existing = stages.get(next.id) ?? null;
        const history = [...stages.values()]
          .filter((value) => value.iterationId === next.iterationId && value.type === next.type)
          .sort((a, b) => a.attempt - b.attempt);
        applyStage(existing, history, next);
        stages.set(next.id, canonicalClone(next));
        return;
      }
      case 'ShadowTaskRetired': {
        if (!exactKeys(event.payload, ['mutationKind', 'retirement']) ||
            event.payload['mutationKind'] !== 'retire_task') {
          fail('integrity', 'retirement event payload is invalid');
        }
        const retirement = event.payload['retirement'] as ShadowTaskRetirement;
        if (event.aggregateKind !== 'task' || event.aggregateId !== retirement.taskId ||
            contracts.get(retirement.taskId) === undefined ||
            retirements.has(retirement.taskId)) {
          fail('integrity', 'retirement event aggregate is invalid');
        }
        retirements.set(retirement.taskId, canonicalClone(retirement));
        return;
      }
      case 'ArtifactCaptureAuthorized':
      case 'ArtifactMetadataRecorded':
      case 'EvidenceManifestRecorded':
      case 'ArtifactMetadataRetired': {
        if (!exactKeys(event.payload, ['mutationKind', 'record'])) {
          fail('integrity', 'archive event payload is invalid');
        }
        const expectedKind = event.eventType === 'ArtifactCaptureAuthorized'
          ? 'issue_capture_authorization'
          : event.eventType === 'ArtifactMetadataRecorded'
            ? 'record_artifact'
            : event.eventType === 'EvidenceManifestRecorded'
              ? 'record_manifest'
              : 'retire_artifact';
        if (event.payload['mutationKind'] !== expectedKind) {
          fail('integrity', 'archive event mutation kind is invalid');
        }
        const expectedAggregate = event.eventType === 'ArtifactCaptureAuthorized'
          ? 'artifact_authorization'
          : event.eventType === 'EvidenceManifestRecorded'
            ? 'evidence_manifest'
            : 'artifact_ref';
        if (event.aggregateKind !== expectedAggregate) {
          fail('integrity', 'archive event aggregate is invalid');
        }
        return;
      }
    }
  }

  #compareProjectionTables(
    db: Database.Database,
    contracts: Map<string, TaskContract[]>,
    iterations: Map<string, Iteration>,
    stages: Map<string, StageRun>,
    retirements: Map<string, ShadowTaskRetirement>,
  ): void {
    const expectedContracts = [...contracts.values()].flat();
    const contractRows = db.prepare(
      `SELECT task_id, version, contract_hash, payload_json
        FROM shadow_task_contracts ORDER BY task_id, version`,
    ).all() as ContractPayloadRow[];
    if (contractRows.length !== expectedContracts.length) fail('integrity', 'contract projection count differs from replay');
    for (const row of contractRows) {
      const decoded = parseContractRow(row);
      const expected = contracts.get(decoded.taskId)?.find((item) => item.version === decoded.version);
      if (expected === undefined || !canonicalEqual(decoded, expected)) {
        fail('integrity', 'contract projection differs from event replay');
      }
    }
    const criterionRows = db.prepare(`SELECT task_id, contract_version, criterion_id
      FROM shadow_contract_criteria ORDER BY task_id, contract_version, criterion_id`).all();
    // Sort with the SAME key and collation as the SQL above (task_id,
    // contract_version, criterion_id; SQLite BINARY = byte order). The prior
    // localeCompare-over-canonicalSerialize sort keyed on serialized-JSON
    // field order (contract_version first) under ICU collation, so a
    // mixed-case corpus — and, data-dependently, some lowercase ones —
    // bricked every store REOPEN with a false integrity failure
    // (canonicalEqual below is order-sensitive; C1 cutover soak finding).
    const expectedCriteria = expectedContracts.flatMap((contract) =>
      contract.acceptanceCriteria.map((criterion) => ({
        task_id: contract.taskId,
        contract_version: contract.version,
        criterion_id: criterion.id,
      })),
    ).sort((left, right) =>
      (left.task_id < right.task_id ? -1 : left.task_id > right.task_id ? 1 : 0) ||
      (left.contract_version - right.contract_version) ||
      (left.criterion_id < right.criterion_id ? -1 : left.criterion_id > right.criterion_id ? 1 : 0));
    if (!canonicalEqual(criterionRows, expectedCriteria)) {
      fail('integrity', 'contract criterion projection differs from event replay');
    }
    const iterationRows = db.prepare(
      `SELECT iteration_id, task_id, contract_version, ordinal, payload_json
        FROM shadow_iterations ORDER BY iteration_id`,
    ).all() as IterationPayloadRow[];
    if (iterationRows.length !== iterations.size) fail('integrity', 'iteration projection count differs from replay');
    for (const row of iterationRows) {
      const decoded = parseIterationRow(row);
      if (!canonicalEqual(decoded, iterations.get(decoded.id))) {
        fail('integrity', 'iteration projection differs from event replay');
      }
    }
    const stageRows = db.prepare(
      'SELECT stage_run_id, iteration_id, stage_type, attempt, payload_json FROM shadow_stage_runs ORDER BY stage_run_id',
    ).all() as StagePayloadRow[];
    if (stageRows.length !== stages.size) fail('integrity', 'stage projection count differs from replay');
    for (const row of stageRows) {
      const decoded = parseStageRow(row);
      if (!canonicalEqual(decoded, stages.get(decoded.id))) {
        fail('integrity', 'stage projection differs from event replay');
      }
    }
    const retirementRows = db.prepare(
      'SELECT task_id, revision, payload_json FROM shadow_task_retirements ORDER BY task_id',
    ).all() as Array<{
      readonly task_id: string;
      readonly revision: string;
      readonly payload_json: string;
    }>;
    if (retirementRows.length !== retirements.size) {
      fail('integrity', 'retirement projection count differs from replay');
    }
    for (const row of retirementRows) {
      const decoded = parseCanonical<ShadowTaskRetirement>(
        row.payload_json,
        `retirement ${row.task_id}`,
      );
      if (decoded.taskId !== row.task_id || decoded.revision !== row.revision ||
          !canonicalEqual(decoded, retirements.get(row.task_id))) {
        fail('integrity', 'retirement projection differs from event replay');
      }
    }
  }

  #commandFromEvent(idempotencyKey: string, event: ControlEvent): ShadowCommitCommand {
    if (!isRecord(event.payload)) fail('integrity', 'event payload is invalid');
    let mutation: ShadowMutation;
    switch (event.eventType) {
      case 'ShadowContractRootProjected':
        mutation = { kind: 'insert_contract_root', contract: event.payload['contract'] as TaskContract };
        break;
      case 'ShadowContractSuccessorProjected':
        mutation = {
          kind: 'append_contract_successor',
          request: event.payload['request'] as never,
          provenance: event.payload['provenance'] as never,
          trustedAuthority: event.payload['trustedAuthority'] as never,
        };
        break;
      case 'ShadowIterationProjectionCommitted':
        mutation = { kind: 'put_iteration', iteration: event.payload['iteration'] as Iteration };
        break;
      case 'ShadowStageRunProjectionCommitted':
        mutation = { kind: 'put_stage_run', stageRun: event.payload['stageRun'] as StageRun };
        break;
      case 'ShadowTaskRetired': {
        const retirement = event.payload['retirement'] as ShadowTaskRetirement;
        mutation = { kind: 'retire_task', taskId: retirement.taskId, revision: retirement.revision };
        break;
      }
      case 'ArtifactCaptureAuthorized':
      case 'ArtifactMetadataRecorded':
      case 'EvidenceManifestRecorded':
      case 'ArtifactMetadataRetired':
        fail('integrity', 'archive events cannot be reconstructed as general commands');
        break;
      case 'V2AggregateMaterialized':
      case 'V2AggregateRefreshed':
      case 'V2DecisionCommitted':
      case 'V2EvidenceBound':
      case 'V2EvaluationBound':
        fail('integrity', 'V2 events cannot be reconstructed as general commands');
        break;
    }
    return {
      idempotencyKey,
      event: { eventId: event.eventId, actor: event.actor, occurredAt: event.occurredAt },
      mutation,
    };
  }

  #tightenDatabasePermissions(): void {
    const root = lstatSync(this.#root);
    if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o777) !== 0o700 ||
        (typeof process.getuid === 'function' && root.uid !== process.getuid())) {
      fail('unsafe_path', 'trusted root permissions changed after construction');
    }
    for (const suffix of ['', '-wal', '-shm']) {
      const path = `${this.#databasePath}${suffix}`;
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }

  #prepareExportRoot(path: string): string {
    const resolved = resolve(path);
    if (!isInside(this.#root, resolved)) fail('unsafe_path', 'export root escapes trusted root');
    if (resolved !== this.#root && dirname(resolved) !== this.#root) {
      fail('unsafe_path', 'export root must be the trusted root or a direct child');
    }
    if (!existsSync(resolved)) mkdirSync(resolved, { mode: 0o700 });
    const info = lstatSync(resolved);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(resolved) !== resolved) {
      fail('unsafe_path', 'export root is unsafe');
    }
    if (resolved.split(sep).includes('worktrees')) fail('unsafe_path', 'exports cannot target worktrees');
    chmodSync(resolved, 0o700);
    return resolved;
  }

  #cleanExportResidues(root: string, bundleName: string): void {
    const prefix = `.hercules-export-${bundleName}-`;
    const uid = process.getuid?.() ?? -1;
    for (const name of readdirSync(root)) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
      const path = join(root, name);
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink() || statSync(path).uid !== uid) {
        fail('export', 'ambiguous export staging residue');
      }
      const marker = join(path, '.owner.json');
      if (!existsSync(marker)) fail('export', 'export staging residue has no ownership marker');
      const parsed = parseCanonical<unknown>(readFileSync(marker, 'utf8'), 'export ownership marker');
      if (
        !isRecord(parsed) ||
        !exactKeys(parsed, ['bundleName', 'uid', 'version']) ||
        parsed['bundleName'] !== bundleName ||
        parsed['uid'] !== uid ||
        parsed['version'] !== 1
      ) {
        fail('export', 'export staging residue ownership is invalid');
      }
      rmSync(path, { recursive: true });
    }
  }
}
