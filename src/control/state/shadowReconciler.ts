import {
  BRIDGE_DECIDED_AT,
  BRIDGE_OWNER_ACTOR,
  bridgeContractSuccessorCommand,
  bridgeDeliveryId,
  contractNeedsBridge,
  isBridgeDeliveryId,
} from '../../domain/approvalPolicyBridge.js';
import { canonicalClone, hashCanonicalJson } from '../../domain/canonicalJson.js';
import { appendApprovedContractChange } from '../../domain/contractChange.js';
import {
  projectLegacyTask,
  retirementCommand,
  type LegacyProjectionCommand,
  type LegacyProjectionMutation,
  type ShadowGapCode,
} from '../../domain/shadowProjection.js';
import type { Task } from '../../domain/task.js';
import { isValidIdentifier } from '../../domain/task.js';
import { ControlGit } from '../git.js';
import { parseTaskFile } from '../taskFile.js';
import {
  isReconciliationAuthorityStub,
  type ControlStateStore,
  type ProjectionEnvelopeKey,
  type ProjectionEnvelopeState,
  type ReconciliationAuthorityStub,
  type ShadowCommitCommand,
  type ShadowTaskState,
} from './stateStore.js';
import { commandDigest } from './stateStoreValidation.js';
import type { M4ObserverMemo, M4ReplayEnvelopeKey } from './shadowObserverMemo.js';

export interface VersionedAuthoritySnapshot {
  readonly revision: string;
  readonly tasks: readonly Task[];
}

export interface ShadowDelivery {
  readonly deliveryId: string;
  readonly revision: string;
  readonly writes: readonly Task[];
  readonly retiredTaskIds: readonly string[];
}

export const RECONCILIATION_ENTRY_KINDS = [
  'equal',
  'missing_shadow',
  'unexpected_shadow',
  'contract_mismatch',
  'iteration_mismatch',
  'retirement_mismatch',
  'projection_failure',
  'projection_incomplete',
  'coverage_gap',
] as const;

export type ReconciliationEntryKind = (typeof RECONCILIATION_ENTRY_KINDS)[number];

export interface ShadowReconciliationEntry {
  readonly kind: ReconciliationEntryKind;
  readonly taskId: string;
  readonly authorityRevision: string;
  readonly reasonCode: string;
  readonly expectedDigest: string | null;
  readonly actualDigest: string | null;
}

export interface ShadowReconciliationReport {
  readonly authorityRevision: string;
  readonly shadowSchemaVersion: number;
  readonly comparedTaskCount: number;
  readonly entries: readonly ShadowReconciliationEntry[];
  readonly reportDigest: string;
  readonly parity: boolean;
  readonly cutoverEligible: false;
  readonly cutoverBlockers: readonly string[];
}

export class ShadowProjectionError extends Error {
  override readonly name = 'ShadowProjectionError';
}

/**
 * Byte (UTF-16 code-unit) order, NOT localeCompare: the store's
 * authority-input validation requires strict ascending JS-string order, and
 * locale collation disagrees with it on mixed-case ids (byte order puts
 * 'Demo-ready-1' BEFORE 'demo-idle-…' since 'M' < 'm'; locale collation puts
 * it after) and is ICU/environment-dependent — a determinism hazard for
 * every ordering that feeds a digest (envelope manifests,
 * reconciliationDeliveryId). Found by the C1 cutover staging soak: the first
 * real-corpus reconciliation delivery (202 tasks, two mixed-case ids) failed
 * the sorted-identities check on every boot. ALL id orderings in this module
 * use these comparators so canonicalized envelopes, replayed command
 * streams, and freshly read task trees agree positionally.
 */
function byteOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function byTaskIdByteOrder(
  left: { readonly id: string },
  right: { readonly id: string },
): number {
  return byteOrder(left.id, right.id);
}

/** Full, sorted authority input — what live (`git-`) and bridge envelopes persist. */
function fullAuthorityInput(
  delivery: ShadowDelivery,
): { readonly writes: readonly Task[]; readonly retiredTaskIds: readonly string[] } {
  return {
    writes: [...delivery.writes].sort(byTaskIdByteOrder),
    retiredTaskIds: [...delivery.retiredTaskIds].sort(),
  };
}

function reconciliationStub(task: Task): ReconciliationAuthorityStub {
  return { id: task.id, state: task.state, reconciliationStub: true };
}

/**
 * What the envelope persists. Reconciliation deliveries (C3.40) persist one
 * `{ id, state }` stub per task: the exact tree is already bound by the
 * reconciliation delivery id (a digest over every task, body included) and is
 * reconstructed from Git when history is built; persisting every body per
 * observe pass grew the store 2.7 GB/day.
 */
function canonicalAuthorityInput(delivery: ShadowDelivery): ProjectionEnvelopeState['authorityInput'] {
  const full = fullAuthorityInput(delivery);
  if (!delivery.deliveryId.startsWith('reconcile-')) return full;
  return {
    writes: full.writes.map(reconciliationStub),
    retiredTaskIds: full.retiredTaskIds,
  };
}

function manifest(commands: readonly LegacyProjectionCommand[]) {
  return commands.map((command) => ({
    idempotencyKey: command.idempotencyKey,
    commandDigest: commandDigest(command as ShadowCommitCommand),
  }));
}

function projectionStableId(
  kind: string,
  revision: string,
  taskId: string,
  value: unknown,
): string {
  return `${kind}-${hashCanonicalJson({ schema: 'm4-shadow-id-v1', revision, taskId, value })
    .slice('sha256:'.length)}`;
}

function bridgeSuccessorCommand(
  revision: string,
  taskId: string,
  mutation: Extract<LegacyProjectionMutation, { kind: 'append_contract_successor' }>,
): LegacyProjectionCommand {
  const identity = projectionStableId('projection', revision, taskId, {
    operation: 'contract-successor',
    mutation,
  });
  return {
    idempotencyKey: identity,
    event: {
      eventId: projectionStableId('event', revision, taskId, {
        operation: 'contract-successor',
        mutation,
      }),
      actor: BRIDGE_OWNER_ACTOR,
      occurredAt: BRIDGE_DECIDED_AT,
    },
    mutation,
  };
}

const EXACT_GIT_REVISION = /^[0-9a-f]{40}$/;

/**
 * Fail-closed gate for privileged bridge deliveries at LIVE delivery time.
 * Replay still re-checks via assertEnvelopeAuthorityInput; this prevents a
 * forged `bridge-…` id from appending successors before those checks run.
 */
function assertLiveBridgeDelivery(delivery: ShadowDelivery): void {
  if (!isBridgeDeliveryId(delivery.deliveryId)) return;
  if (!EXACT_GIT_REVISION.test(delivery.revision)) {
    throw new ShadowProjectionError(
      'bridge delivery authority revision must be an exact lowercase Git SHA',
    );
  }
  if (delivery.deliveryId !== bridgeDeliveryId(delivery.revision)) {
    throw new ShadowProjectionError(
      'bridge delivery id is not bound to bridgeDeliveryId(authorityRevision)',
    );
  }
  if (delivery.writes.length !== 0 || delivery.retiredTaskIds.length !== 0) {
    throw new ShadowProjectionError(
      'bridge delivery must carry an empty authority input (no writes, no retirements)',
    );
  }
}

function deliveryCommands(
  store: ControlStateStore,
  delivery: ShadowDelivery,
): { readonly commands: readonly LegacyProjectionCommand[]; readonly gaps: readonly ShadowGapCode[] } {
  if (isBridgeDeliveryId(delivery.deliveryId)) {
    const commands: LegacyProjectionCommand[] = [];
    for (const taskId of [...store.listTaskIds()].sort(byteOrder)) {
      const existing = store.readTask(taskId);
      if (existing === null || existing.retirement !== null) continue;
      if (!contractNeedsBridge(existing.contracts)) continue;
      commands.push(bridgeSuccessorCommand(
        delivery.revision,
        taskId,
        bridgeContractSuccessorCommand(delivery.deliveryId, existing.contracts),
      ));
    }
    return { commands, gaps: [] };
  }
  const bridgeActive = store.listProjectionEnvelopeKeys().some(
    (envelope) => isBridgeDeliveryId(envelope.deliveryId),
  );
  const commands: LegacyProjectionCommand[] = [];
  const gaps: ShadowGapCode[] = [];
  for (const task of [...delivery.writes].sort(byTaskIdByteOrder)) {
    const projection = projectLegacyTask(
      task, delivery.revision, store.readTask(task.id), { bridgeActive },
    );
    commands.push(...projection.commands);
    gaps.push(...projection.gapCodes);
  }
  for (const taskId of [...delivery.retiredTaskIds].sort()) {
    const existing = store.readTask(taskId);
    if (existing === null) {
      throw new ShadowProjectionError(`retirement target ${taskId} has no shadow history`);
    }
    if (existing.retirement === null) commands.push(retirementCommand(taskId, delivery.revision));
    else if (existing.retirement.revision !== delivery.revision) {
      throw new ShadowProjectionError(`retirement target ${taskId} conflicts with prior revision`);
    }
  }
  return { commands, gaps: [...new Set(gaps)].sort() as ShadowGapCode[] };
}

function assertResumeSuffix(
  envelope: ProjectionEnvelopeState,
  commands: readonly LegacyProjectionCommand[],
): void {
  const suffix = envelope.manifest.slice(envelope.acknowledgedCommands);
  if (hashCanonicalJson(suffix) !== hashCanonicalJson(manifest(commands))) {
    throw new ShadowProjectionError('projection retry does not reproduce the envelope suffix');
  }
}

/**
 * Live-delivery guard (C3 round-3 note): a live authority commit must not be
 * projected while another envelope is still incomplete — with the bridge
 * active, a git delivery would bridge a task the pending `bridge-` envelope
 * still names, and that envelope could never reproduce its suffix. The
 * observe pass resumes incomplete envelopes first; live delivery defers to it.
 * Retrying the incomplete envelope itself (same delivery id) is allowed.
 */
export function assertNoIncompleteEnvelopes(
  store: Pick<ControlStateStore, 'listIncompleteEnvelopes'>,
  deliveryId: string,
): void {
  const pending = store
    .listIncompleteEnvelopes()
    .filter((envelope) => envelope.deliveryId !== deliveryId)
    .map((envelope) => envelope.deliveryId);
  if (pending.length > 0) {
    throw new ShadowProjectionError(
      `live delivery ${deliveryId} deferred: incomplete projection envelope(s) ${pending.join(', ')} must resume first`,
    );
  }
}

export function deliverShadowProjection(
  store: ControlStateStore,
  delivery: ShadowDelivery,
): ProjectionEnvelopeState {
  assertLiveBridgeDelivery(delivery);
  const authorityInput = canonicalAuthorityInput(delivery);
  // Commands are always projected from the FULL sorted tasks; only what the
  // envelope persists is slimmed for reconciliation deliveries (C3.40).
  const normalized = { ...delivery, ...fullAuthorityInput(delivery) };
  const prior = store.readEnvelope(delivery.deliveryId);
  const projected = deliveryCommands(store, normalized);
  // C3.58: a delivery that projects no command appends no envelope. 87% of
  // production envelopes were such no-ops (lease advances, evidence commits,
  // note folds, and every reconcile pass after the live sync already caught
  // up); boot replay, history rebuild and integrity are O(envelopes). Gap
  // codes do not change this: they are recomputed live by every reconcile
  // report from the current snapshot, and a persisted envelope's gap list is
  // only ever compared with itself on retry — the standing legacy divergences
  // (iteration_state_mismatch, evidence_verdict_deferred,
  // pre_activation_history_missing) were re-recorded on ~1700 no-op envelopes
  // without anyone reading them back. The only side effect an empty envelope
  // had — refreshing the V2 materialized aggregates for its writes — is kept.
  // Re-delivering the same id is a no-op again while the projected state is
  // unchanged; if a later persisted envelope changed that state first, the
  // observer's ordered resume (cursor / latest-envelope "later of") never
  // re-delivers the skipped range (Codex C3.58 B1).
  if (prior === null && projected.commands.length === 0) {
    store.refreshMaterializedForDelivery?.(normalized);
    return {
      deliveryId: delivery.deliveryId,
      authorityRevision: delivery.revision,
      authorityInput,
      manifest: [],
      gapCodes: projected.gaps,
      manifestDigest: hashCanonicalJson({ schema: 'shadow-envelope-skipped-v1', manifest: [] }),
      completed: true,
      acknowledgedCommands: 0,
      skipped: true,
    };
  }
  let envelope: ProjectionEnvelopeState;
  if (prior === null) {
    envelope = store.beginEnvelope({
      deliveryId: delivery.deliveryId,
      authorityRevision: delivery.revision,
      authorityInput,
      manifest: manifest(projected.commands),
      gapCodes: projected.gaps,
    });
  } else {
    if (prior.authorityRevision !== delivery.revision) {
      throw new ShadowProjectionError('projection delivery revision conflicts with its envelope');
    }
    if (hashCanonicalJson(prior.gapCodes) !== hashCanonicalJson(projected.gaps)) {
      throw new ShadowProjectionError('projection retry does not reproduce envelope gaps');
    }
    // A reconciliation envelope begun before C3.40 persisted full tasks; its
    // resume must still reproduce that legacy shape exactly.
    const priorDigest = hashCanonicalJson(prior.authorityInput);
    if (priorDigest !== hashCanonicalJson(authorityInput) &&
        !(delivery.deliveryId.startsWith('reconcile-') &&
          priorDigest === hashCanonicalJson(fullAuthorityInput(delivery)))) {
      throw new ShadowProjectionError('projection retry does not reproduce authority input');
    }
    assertResumeSuffix(prior, projected.commands);
    envelope = prior;
  }
  if (envelope.completed) return envelope;
  let offset = 0;
  let batchOrdinal = Math.ceil(envelope.acknowledgedCommands / 256);
  while (offset < projected.commands.length) {
    const batch = projected.commands.slice(offset, offset + 256) as readonly ShadowCommitCommand[];
    store.commitBatch(delivery.deliveryId, batchOrdinal, batch);
    offset += batch.length;
    batchOrdinal += 1;
  }
  return store.completeEnvelope(delivery.deliveryId);
}

function stateDigest(state: ShadowTaskState | null): string | null {
  return state === null ? null : hashCanonicalJson({
    contracts: state.contracts,
    iterations: state.iterations,
    retirement: state.retirement,
  });
}

/**
 * C3.46: share state objects, copy only the Map. `applyCommands` never mutates
 * a stored state — every command replaces the entry with a fresh object — and
 * `reconcileShadowSnapshot` clones the one task it edits, so the memoized map
 * and the working map can point at the same immutable values. The previous
 * per-call deep clone of every task state (twice per replay) stalled the live
 * commit path for seconds on a 270-task store.
 */
function cloneStateMap(
  states: ReadonlyMap<string, ShadowTaskState>,
): Map<string, ShadowTaskState> {
  return new Map(states);
}

/** Apply projection commands onto a mutable state map (shared by delivery + reconcile). */
export function applyCommands(
  states: Map<string, ShadowTaskState>,
  commands: readonly LegacyProjectionCommand[],
): void {
  for (const command of commands) {
    const mutation = command.mutation;
    if (mutation.kind === 'insert_contract_root') {
      if (states.has(mutation.contract.taskId)) {
        throw new ShadowProjectionError('projection replay attempted a duplicate contract root');
      }
      states.set(mutation.contract.taskId, {
        taskId: mutation.contract.taskId,
        contracts: [mutation.contract],
        iterations: [],
        stageRuns: [],
        retirement: null,
      });
      continue;
    }
    if (mutation.kind === 'append_contract_successor') {
      const current = states.get(mutation.request.taskId);
      if (current === undefined) {
        throw new ShadowProjectionError('projection replay mutation has no contract root');
      }
      states.set(current.taskId, {
        ...current,
        contracts: appendApprovedContractChange(
          current.contracts,
          mutation.request,
          mutation.provenance,
          mutation.trustedAuthority,
        ),
      });
      continue;
    }
    const current = states.get(
      mutation.kind === 'put_iteration' ? mutation.iteration.taskId : mutation.taskId,
    );
    if (current === undefined) {
      throw new ShadowProjectionError('projection replay mutation has no contract root');
    }
    if (mutation.kind === 'put_iteration') {
      const iterations = new Map(current.iterations.map((iteration) => [iteration.id, iteration]));
      iterations.set(mutation.iteration.id, mutation.iteration);
      states.set(current.taskId, {
        ...current,
        iterations: [...iterations.values()].sort((left, right) => left.ordinal - right.ordinal),
      });
    } else {
      states.set(current.taskId, {
        ...current,
        retirement: { taskId: mutation.taskId, revision: mutation.revision },
      });
    }
  }
}

function deliveryCommandsFromState(
  states: ReadonlyMap<string, ShadowTaskState>,
  delivery: ShadowDelivery,
  bridgeActive: boolean,
): { readonly commands: readonly LegacyProjectionCommand[]; readonly gaps: readonly ShadowGapCode[] } {
  if (isBridgeDeliveryId(delivery.deliveryId)) {
    const commands: LegacyProjectionCommand[] = [];
    for (const taskId of [...states.keys()].sort(byteOrder)) {
      const existing = states.get(taskId)!;
      if (existing.retirement !== null) continue;
      if (!contractNeedsBridge(existing.contracts)) continue;
      commands.push(bridgeSuccessorCommand(
        delivery.revision,
        taskId,
        bridgeContractSuccessorCommand(delivery.deliveryId, existing.contracts),
      ));
    }
    return { commands, gaps: [] };
  }
  const commands: LegacyProjectionCommand[] = [];
  const gaps: ShadowGapCode[] = [];
  for (const task of [...delivery.writes].sort(byTaskIdByteOrder)) {
    const projected = projectLegacyTask(
      task, delivery.revision, states.get(task.id) ?? null, { bridgeActive },
    );
    commands.push(...projected.commands);
    gaps.push(...projected.gapCodes);
  }
  for (const taskId of [...delivery.retiredTaskIds].sort()) {
    const existing = states.get(taskId);
    if (existing === undefined) {
      throw new ShadowProjectionError(`retirement target ${taskId} has no replayed history`);
    }
    if (existing.retirement === null) commands.push(retirementCommand(taskId, delivery.revision));
    else if (existing.retirement.revision !== delivery.revision) {
      throw new ShadowProjectionError(`retirement target ${taskId} conflicts in replay`);
    }
  }
  return { commands, gaps: [...new Set(gaps)].sort() as ShadowGapCode[] };
}

function taskIdForPath(path: string): string | null {
  if (!path.startsWith('tasks/') || !path.endsWith('.md')) return null;
  const taskId = path.slice('tasks/'.length, -'.md'.length);
  return isValidIdentifier(taskId) && !taskId.includes('/') ? taskId : null;
}

/**
 * Bound of the per-process parsed-task-blob cache (`M4ObserverMemo.taskBlobs`,
 * keyed by exact git blob oid + task id). Consecutive reconciliation envelopes
 * share almost every task blob, so one parse serves the whole history and the
 * SAME Task object is referenced by every delivery that carries it — history
 * memory grows with distinct task versions, not with envelope count.
 */
export const TASK_BLOB_CACHE_MAX = 8192;

function rememberTaskBlob(cache: Map<string, Task>, key: string, task: Task): void {
  cache.set(key, task);
  while (cache.size > TASK_BLOB_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Parse the requested task paths at an exact revision with ONE `ls-tree` per
 * revision and one `cat-file` per blob not already in `cache`. A path that is
 * not a regular blob at the revision is absent (never read through a link).
 */
function freezeTask(task: Task): Task {
  for (const value of Object.values(task as unknown as Record<string, unknown>)) {
    if (Array.isArray(value)) Object.freeze(value);
    else if (value !== null && typeof value === 'object') Object.freeze(value);
  }
  return Object.freeze(task);
}

/**
 * Parse task paths at an exact revision with ONE `ls-tree` per revision and
 * one `cat-file` per blob not already in `cache`. `paths === null` means every
 * task blob in the tree. A path that is not a regular blob at the revision is
 * absent (never read through a link). Interned tasks are frozen so the
 * per-identity hash memo (`taskHash`) can never go stale.
 */
async function tasksAtRevision(
  git: ControlGit,
  revision: string,
  paths: readonly string[] | null,
  cache?: Map<string, Task>,
): Promise<readonly Task[]> {
  const blobs = await git.listBlobsAtRevision(revision, 'tasks');
  const oidByPath = new Map<string, string>();
  for (const blob of blobs) oidByPath.set(blob.path, blob.oid);
  const wanted = (paths ?? blobs.map((blob) => blob.path))
    .filter((path) => taskIdForPath(path) !== null);
  const tasks: Task[] = [];
  for (const path of wanted) {
    const taskId = taskIdForPath(path)!;
    const oid = oidByPath.get(path);
    if (oid === undefined) continue;
    const key = `${oid} ${taskId}`;
    let task = cache?.get(key);
    if (task === undefined) {
      task = freezeTask(parseTaskFile(await git.readBlob(oid), taskId));
      if (cache !== undefined) rememberTaskBlob(cache, key, task);
    }
    tasks.push(task);
  }
  return tasks.sort(byTaskIdByteOrder);
}

export async function shadowDeliveryForGitRevision(
  controlRepoDir: string,
  revision: string,
  deliveryId: string,
): Promise<ShadowDelivery | null> {
  const git = new ControlGit(controlRepoDir);
  const metadata = await git.commitMetadata(revision);
  const taskPaths = metadata.paths.filter((path) => taskIdForPath(path) !== null);
  if (taskPaths.length === 0) return null;
  const writes = await tasksAtRevision(git, revision, taskPaths);
  const retiredTaskIds: string[] = [];
  for (const path of taskPaths) {
    const taskId = taskIdForPath(path)!;
    if (writes.some((task) => task.id === taskId)) continue;
    if (metadata.parent === null || await git.readPathAtRevision(metadata.parent, path) === null) {
      throw new ShadowProjectionError('Git projection retirement lacks an exact parent task blob');
    }
    retiredTaskIds.push(taskId);
  }
  return { deliveryId, revision, writes, retiredTaskIds: retiredTaskIds.sort() };
}

/** Canonical hash per Task object identity — interned blobs hash once per process. */
const taskHashes = new WeakMap<Task, string>();

function taskHash(task: Task): string {
  let hash = taskHashes.get(task);
  if (hash === undefined) {
    hash = hashCanonicalJson(task);
    taskHashes.set(task, hash);
  }
  return hash;
}

function sameTask(left: Task, right: Task): boolean {
  return left === right || taskHash(left) === taskHash(right);
}

function sameTaskList(left: readonly Task[], right: readonly Task[]): boolean {
  return left.length === right.length && left.every((task, index) =>
    right[index] !== undefined && sameTask(task, right[index]!));
}

async function assertEnvelopeAuthorityInput(
  git: ControlGit,
  controlRepoDir: string,
  envelope: ProjectionEnvelopeState,
  taskBlobs?: Map<string, Task>,
): Promise<ShadowDelivery> {
  const storedWrites = envelope.authorityInput.writes;
  if (envelope.deliveryId.startsWith('reconcile-')) {
    const tasks = await tasksAtRevision(git, envelope.authorityRevision, null, taskBlobs);
    const snapshot = { revision: envelope.authorityRevision, tasks };
    // C3.40 stubs bind identity + state; legacy envelopes persisted whole
    // tasks. Either way the delivery id digest (bodies included) must match.
    const stubbed = storedWrites.length > 0 && storedWrites.every(isReconciliationAuthorityStub);
    const writesMatch = stubbed
      ? storedWrites.length === tasks.length &&
        storedWrites.every((write, index) =>
          write.id === tasks[index]!.id && write.state === tasks[index]!.state)
      : sameTaskList(storedWrites as readonly Task[], tasks);
    if (reconciliationDeliveryId(snapshot) !== envelope.deliveryId ||
        envelope.authorityInput.retiredTaskIds.length !== 0 || !writesMatch) {
      throw new ShadowProjectionError('reconciliation envelope is not bound to its exact task tree');
    }
    // Return the Git-derived (interned) tasks — the exact tree the delivery id
    // commits to — so the delivery never pins parsed authority input.
    return {
      deliveryId: envelope.deliveryId,
      revision: envelope.authorityRevision,
      writes: tasks,
      retiredTaskIds: envelope.authorityInput.retiredTaskIds,
    };
  }
  if (storedWrites.some(isReconciliationAuthorityStub)) {
    throw new ShadowProjectionError('only reconciliation envelopes may persist task stubs');
  }
  const stored: ShadowDelivery = {
    deliveryId: envelope.deliveryId,
    revision: envelope.authorityRevision,
    writes: storedWrites as readonly Task[],
    retiredTaskIds: envelope.authorityInput.retiredTaskIds,
  };
  if (isBridgeDeliveryId(envelope.deliveryId)) {
    if (envelope.deliveryId !== bridgeDeliveryId(envelope.authorityRevision) ||
        stored.writes.length !== 0 ||
        stored.retiredTaskIds.length !== 0) {
      throw new ShadowProjectionError(
        'bridge envelope is not bound to its exact owner-gated empty authority input',
      );
    }
    try {
      await git.commitMetadata(envelope.authorityRevision);
    } catch (error) {
      throw new ShadowProjectionError(
        `bridge envelope authority revision is not a real control commit: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return stored;
  }
  if (!envelope.deliveryId.startsWith('git-') && !envelope.deliveryId.startsWith('sync-')) {
    throw new ShadowProjectionError('projection envelope has an unknown authority provenance');
  }
  const changed = await shadowDeliveryForGitRevision(
    controlRepoDir, envelope.authorityRevision, envelope.deliveryId,
  );
  if (changed === null) {
    throw new ShadowProjectionError('Git projection envelope revision changed no task paths');
  }
  if (hashCanonicalJson(changed.retiredTaskIds) !== hashCanonicalJson(stored.retiredTaskIds)) {
    throw new ShadowProjectionError('Git projection retirements differ from the first-parent change');
  }
  const storedById = new Map(stored.writes.map((task) => [task.id, task]));
  for (const task of changed.writes) {
    const declared = storedById.get(task.id);
    if (declared === undefined || !sameTask(declared, task)) {
      throw new ShadowProjectionError('Git projection write differs from the changed authority blob');
    }
  }
  const changedIds = new Set(changed.writes.map((task) => task.id));
  const metadata = await git.commitMetadata(envelope.authorityRevision);
  for (const task of stored.writes) {
    const path = `tasks/${task.id}.md`;
    const content = await git.readPathAtRevision(envelope.authorityRevision, path);
    if (content === null || !sameTask(parseTaskFile(content, task.id), task)) {
      throw new ShadowProjectionError('Git projection write is not the exact authority task blob');
    }
    if (!changedIds.has(task.id)) {
      if (!envelope.deliveryId.startsWith('git-') || metadata.parent === null) {
        throw new ShadowProjectionError('non-authority task write appears in projection input');
      }
      const parentContent = await git.readPathAtRevision(metadata.parent, path);
      if (parentContent === null || !sameTask(parseTaskFile(parentContent, task.id), task)) {
        throw new ShadowProjectionError('declared no-op task is not unchanged from the first parent');
      }
    }
  }
  return stored;
}

export interface BuildShadowProjectionHistoryOptions {
  readonly memo?: M4ObserverMemo;
  /** Test/probe hook: fired when an envelope is reconstructed (cache miss). */
  readonly onReconstruct?: (deliveryId: string) => void;
}

function dropMemoHistoryCaches(memo: M4ObserverMemo): void {
  memo.history.deliveries.clear();
  memo.replay = null;
}

function bindMemoStoreOrReset(memo: M4ObserverMemo | undefined, store: ControlStateStore): void {
  if (memo === undefined) return;
  if (memo.store !== null && memo.store !== store) {
    dropMemoHistoryCaches(memo);
  }
  // Bind on every use so a later store-instance reopen is detected even when
  // no observer report was remembered in between (live-commit-only paths).
  memo.store = store;
}

/** Reconstruct immutable delivery inputs from exact Git trees, never worktree bytes. */
export async function buildShadowProjectionHistory(
  store: ControlStateStore,
  controlRepoDir: string,
  authorityRevision: string,
  options: BuildShadowProjectionHistoryOptions = {},
): Promise<readonly ShadowDelivery[]> {
  const memo = options.memo;
  bindMemoStoreOrReset(memo, store);
  const git = new ControlGit(controlRepoDir);
  const firstParent = await git.firstParentHistory(authorityRevision);
  const revisionOrder = new Map(firstParent.map((revision, index) => [revision, index]));
  const deliveries: ShadowDelivery[] = [];
  let lastOrder = -1;
  // Identity keys only: a full listing would materialize every envelope's
  // authority input (multi-MB each) for the whole history at once.
  for (const key of store.listProjectionEnvelopeKeys()) {
    const order = revisionOrder.get(key.authorityRevision);
    if (order === undefined || order < lastOrder) {
      throw new ShadowProjectionError('projection envelope revision is outside ordered authority history');
    }
    lastOrder = order;
    const cached = memo?.history.deliveries.get(key.deliveryId);
    if (
      cached !== undefined &&
      cached.authorityRevision === key.authorityRevision &&
      cached.manifestDigest === key.manifestDigest
    ) {
      deliveries.push(cached.delivery);
      continue;
    }
    options.onReconstruct?.(key.deliveryId);
    const envelope = store.readEnvelope(key.deliveryId);
    if (envelope === null || envelope.authorityRevision !== key.authorityRevision ||
        envelope.manifestDigest !== key.manifestDigest) {
      throw new ShadowProjectionError('projection envelope changed underneath the history build');
    }
    const delivery = await assertEnvelopeAuthorityInput(
      git, controlRepoDir, envelope, memo?.taskBlobs,
    );
    if (memo !== undefined) {
      memo.history.deliveries.set(key.deliveryId, {
        authorityRevision: key.authorityRevision,
        manifestDigest: key.manifestDigest,
        delivery,
      });
    }
    deliveries.push(delivery);
  }
  return deliveries;
}

function replayEnvelopeKeys(
  envelopes: readonly ProjectionEnvelopeKey[],
): readonly M4ReplayEnvelopeKey[] {
  return envelopes.map((envelope) => ({
    deliveryId: envelope.deliveryId,
    authorityRevision: envelope.authorityRevision,
    manifestDigest: envelope.manifestDigest,
  }));
}

function replayKeysEqual(
  left: readonly M4ReplayEnvelopeKey[],
  right: readonly M4ReplayEnvelopeKey[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (
      a.deliveryId !== b.deliveryId ||
      a.authorityRevision !== b.authorityRevision ||
      a.manifestDigest !== b.manifestDigest
    ) {
      return false;
    }
  }
  return true;
}

function replayPrefixLength(
  cached: readonly M4ReplayEnvelopeKey[],
  current: readonly M4ReplayEnvelopeKey[],
): number {
  const limit = Math.min(cached.length, current.length);
  let matched = 0;
  while (matched < limit) {
    const a = cached[matched]!;
    const b = current[matched]!;
    if (
      a.deliveryId !== b.deliveryId ||
      a.authorityRevision !== b.authorityRevision ||
      a.manifestDigest !== b.manifestDigest
    ) {
      break;
    }
    matched += 1;
  }
  // Only reuse when the entire cached prefix is a prefix of current (cached
  // holds state AFTER all its keys). A shorter current list forces a full replay.
  return matched === cached.length ? matched : 0;
}

/** Replay immutable envelopes into expected shadow state (memoized when options.memo set). */
export function replayExpectedState(
  store: ControlStateStore,
  history: readonly ShadowDelivery[],
  options: { readonly memo?: M4ObserverMemo } = {},
): Map<string, ShadowTaskState> {
  const memo = options.memo;
  bindMemoStoreOrReset(memo, store);
  const envelopes = store.listProjectionEnvelopeKeys();
  if (envelopes.length !== history.length) {
    throw new ShadowProjectionError('projection history does not cover every immutable envelope');
  }
  const keys = replayEnvelopeKeys(envelopes);
  let startIndex = 0;
  let states: Map<string, ShadowTaskState>;
  let bridgeActive = false;
  if (memo?.replay !== undefined && memo.replay !== null) {
    const prefix = replayPrefixLength(memo.replay.keys, keys);
    if (prefix > 0 && prefix === memo.replay.keys.length) {
      states = cloneStateMap(memo.replay.states);
      startIndex = prefix;
      bridgeActive = memo.replay.keys.some((key) => isBridgeDeliveryId(key.deliveryId));
    } else {
      states = new Map();
    }
  } else {
    states = new Map();
  }
  for (let index = 0; index < envelopes.length; index += 1) {
    const envelope = envelopes[index]!;
    const delivery = history[index]!;
    if (delivery.deliveryId !== envelope.deliveryId || delivery.revision !== envelope.authorityRevision) {
      throw new ShadowProjectionError('projection history order or authority binding differs from envelope');
    }
    // Binding checks stay fail-closed for every envelope; command replay is
    // skipped only for a memoized prefix whose manifests already matched.
    if (index < startIndex) continue;
    // Manifest + gaps only: the authority input is already bound by the
    // history (assertEnvelopeAuthorityInput) and must not be materialized
    // again for every envelope in the chain.
    const stored = store.readEnvelopeManifest(envelope.deliveryId);
    if (stored === null || stored.authorityRevision !== envelope.authorityRevision ||
        stored.manifestDigest !== envelope.manifestDigest) {
      throw new ShadowProjectionError('projection envelope changed underneath the replay');
    }
    const projected = deliveryCommandsFromState(states, delivery, bridgeActive);
    if (hashCanonicalJson(manifest(projected.commands)) !== hashCanonicalJson(stored.manifest)) {
      throw new ShadowProjectionError('projection envelope manifest does not replay from Git authority');
    }
    if (hashCanonicalJson(projected.gaps) !== hashCanonicalJson(stored.gapCodes)) {
      throw new ShadowProjectionError('projection envelope gaps do not replay from Git authority');
    }
    applyCommands(states, projected.commands);
    if (isBridgeDeliveryId(delivery.deliveryId)) bridgeActive = true;
  }
  if (memo !== undefined) {
    // Reuse the cached object when the key list is unchanged (warm reconcile).
    if (memo.replay !== null && replayKeysEqual(memo.replay.keys, keys)) {
      memo.replay = { keys: memo.replay.keys, states: cloneStateMap(states) };
    } else {
      memo.replay = { keys, states: cloneStateMap(states) };
    }
  }
  return states;
}

function gapKind(reason: ShadowGapCode): ReconciliationEntryKind {
  if (reason === 'contract_change_requires_trusted_authority') return 'contract_mismatch';
  if (reason === 'retired_task_resurrection') return 'retirement_mismatch';
  if (reason === 'candidate_mismatch' || reason === 'iteration_state_mismatch') {
    return 'iteration_mismatch';
  }
  return 'coverage_gap';
}

function entry(
  kind: ReconciliationEntryKind,
  taskId: string,
  revision: string,
  reasonCode: string,
  expectedDigest: string | null,
  actualDigest: string | null,
): ShadowReconciliationEntry {
  return { kind, taskId, authorityRevision: revision, reasonCode, expectedDigest, actualDigest };
}

export interface ReconcileShadowSnapshotOptions {
  readonly memo?: M4ObserverMemo;
}

/**
 * Task id targeted by a projection command. `projectLegacyTask` only emits
 * commands for `task.id`; the linear reconcile path relies on that invariant.
 */
export function projectionCommandTaskId(command: LegacyProjectionCommand): string {
  const mutation = command.mutation;
  if (mutation.kind === 'insert_contract_root') return mutation.contract.taskId;
  if (mutation.kind === 'append_contract_successor') return mutation.request.taskId;
  if (mutation.kind === 'put_iteration') return mutation.iteration.taskId;
  return mutation.taskId;
}

export function reconcileShadowSnapshot(
  store: ControlStateStore,
  snapshot: VersionedAuthoritySnapshot,
  projectionFailures: ReadonlyMap<string, string>,
  projectionHistory: readonly ShadowDelivery[],
  options: ReconcileShadowSnapshotOptions = {},
): ShadowReconciliationReport {
  const entries: ShadowReconciliationEntry[] = [];
  const replayed = replayExpectedState(store, projectionHistory, options);
  const bridgeActive = projectionHistory.some((delivery) => isBridgeDeliveryId(delivery.deliveryId));
  const authorityIds = new Set(snapshot.tasks.map((task) => task.id));
  for (const task of [...snapshot.tasks].sort(byTaskIdByteOrder)) {
    const actual = store.readTask(task.id);
    const existing = replayed.get(task.id) ?? null;
    // projectLegacyTask only produces commands for task.id — a one-task map is
    // sufficient (was: cloneStateMap(replayed) per task, quadratic in task count).
    const desired = new Map(existing === null ? [] : [[task.id, canonicalClone(existing)]]);
    const projected = projectLegacyTask(
      task, snapshot.revision, existing, { bridgeActive },
    );
    applyCommands(desired, projected.commands);
    const expectedState = desired.get(task.id) ?? null;
    const expectedDigest = stateDigest(expectedState);
    const actualDigest = stateDigest(actual);
    const failure = projectionFailures.get(task.id);
    if (failure !== undefined) {
      entries.push(entry('projection_failure', task.id, snapshot.revision, failure, expectedDigest, actualDigest));
      continue;
    }
    for (const reason of projected.gapCodes) {
      entries.push(entry(gapKind(reason), task.id, snapshot.revision, reason, expectedDigest, actualDigest));
    }
    if (actual === null) {
      entries.push(entry('missing_shadow', task.id, snapshot.revision, 'task_missing', expectedDigest, null));
      continue;
    }
    if (expectedState === null || hashCanonicalJson(actual.contracts) !==
        hashCanonicalJson(expectedState.contracts)) {
      const reason = actual.contracts.length > (expectedState?.contracts.length ?? 0)
        ? 'unexpected_contract_history' : 'contract_mismatch';
      entries.push(entry('contract_mismatch', task.id, snapshot.revision, reason, expectedDigest, actualDigest));
    }
    if (hashCanonicalJson(actual.retirement) !== hashCanonicalJson(expectedState?.retirement ?? null)) {
      entries.push(entry(
        'retirement_mismatch', task.id, snapshot.revision,
        'retirement_mismatch', expectedDigest, actualDigest,
      ));
    }
    if (hashCanonicalJson(actual.iterations) !== hashCanonicalJson(expectedState?.iterations ?? [])) {
      const reason = actual.iterations.length > (expectedState?.iterations.length ?? 0)
        ? 'unexpected_iteration_history' : 'iteration_stale';
      entries.push(entry(
        'iteration_mismatch', task.id, snapshot.revision,
        reason, expectedDigest, actualDigest,
      ));
    }
    if (entries.some((item) => item.taskId === task.id)) continue;
    if (expectedDigest !== actualDigest) {
      entries.push(entry(
        'iteration_mismatch', task.id, snapshot.revision,
        'projection_representation_mismatch', expectedDigest, actualDigest,
      ));
      continue;
    }
    entries.push(entry('equal', task.id, snapshot.revision, 'equal', expectedDigest, actualDigest));
  }
  const shadowOnlyIds = store.listTaskIds().filter((id) => !authorityIds.has(id)).sort();
  for (const taskId of shadowOnlyIds) {
    const actual = store.readTask(taskId);
    const expected = replayed.get(taskId) ?? null;
    const expectedDigest = stateDigest(expected);
    const actualDigest = stateDigest(actual);
    const failure = projectionFailures.get(taskId);
    entries.push(failure !== undefined
      ? entry('projection_failure', taskId, snapshot.revision, failure, expectedDigest, actualDigest)
      : expected?.retirement === null || expected === null
      ? entry('unexpected_shadow', taskId, snapshot.revision, 'authority_task_missing', expectedDigest, actualDigest)
      : expectedDigest !== actualDigest
      ? entry('retirement_mismatch', taskId, snapshot.revision, 'retirement_mismatch', expectedDigest, actualDigest)
      : entry('equal', taskId, snapshot.revision, 'retired', expectedDigest, actualDigest));
  }
  for (const [taskId, failure] of [...projectionFailures].sort(([left], [right]) => byteOrder(left, right))) {
    if (authorityIds.has(taskId) || shadowOnlyIds.includes(taskId)) continue;
    entries.push(entry(
      'projection_failure', taskId, snapshot.revision, failure, null, null,
    ));
  }
  for (const envelope of store.listIncompleteEnvelopes()) {
    entries.push(entry(
      'projection_incomplete',
      `delivery:${envelope.deliveryId}`,
      snapshot.revision,
      'projection_incomplete',
      envelope.manifestDigest,
      null,
    ));
  }
  entries.sort((a, b) => byteOrder(a.taskId, b.taskId) || byteOrder(a.kind, b.kind));
  const parity = entries.every((item) => item.kind === 'equal');
  const divergence = entries.filter((item) => item.kind !== 'equal').map((item) => item.reasonCode);
  const ownerGateActive = store.listTaskIds().some((taskId) => {
    const state = store.readTask(taskId);
    return state !== null &&
      state.retirement === null &&
      contractNeedsBridge(state.contracts);
  });
  const cutoverBlockers = [...new Set([
    'm4_shadow_only',
    ...(ownerGateActive ? ['owner_database_authority_gate'] as const : []),
    ...divergence,
  ])].sort();
  const body = {
    authorityRevision: snapshot.revision,
    shadowSchemaVersion: 2,
    comparedTaskCount: snapshot.tasks.length,
    entries,
    parity,
    cutoverEligible: false as const,
    cutoverBlockers,
  };
  return canonicalClone({ ...body, reportDigest: hashCanonicalJson(body) });
}

/** Owner-gated empty delivery that appends approve_outcome successors for locked tasks. */
export function buildBridgeDelivery(
  store: ControlStateStore,
  authorityRevision: string,
): ShadowDelivery | null {
  const needsBridge = store.listTaskIds().some((taskId) => {
    const state = store.readTask(taskId);
    return state !== null &&
      state.retirement === null &&
      contractNeedsBridge(state.contracts);
  });
  if (!needsBridge) return null;
  return {
    deliveryId: bridgeDeliveryId(authorityRevision),
    revision: authorityRevision,
    writes: [],
    retiredTaskIds: [],
  };
}

export function reconciliationDeliveryId(snapshot: VersionedAuthoritySnapshot): string {
  const expectedProjectionDigest = hashCanonicalJson(
    [...snapshot.tasks]
      .sort(byTaskIdByteOrder)
      .map((task) => ({
        taskId: task.id,
        title: task.title,
        body: task.body,
        repository: task.repo,
        state: task.state,
        attempts: task.attempts,
        verifiedSha: task.verifiedSha ?? null,
        createdAt: task.createdAt,
        startedAt: task.startedAt,
        endedAt: task.endedAt,
        lastEventAt: task.lastEventAt,
      })),
  );
  return `reconcile-${hashCanonicalJson({
    schema: 'm4-reconciliation-delivery-v1',
    revision: snapshot.revision,
    expectedProjectionDigest,
  }).slice('sha256:'.length)}`;
}
