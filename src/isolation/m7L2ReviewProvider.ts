import { constants, readFileSync } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  ArchiveLockBusyError,
  type ArchiveLockManager,
  openArchiveLockManager,
} from '../control/artifacts/archiveLock.js';
import { canonicalClone, canonicalSerialize, hashCanonicalJson } from '../domain/canonicalJson.js';
import { computeEvidenceIntegrityAttestationHash } from '../domain/claimAuthorityV2.js';
import type { HumanDecision } from '../domain/humanDecision.js';
import type { Iteration } from '../domain/iteration.js';
import {
  snapshotLearningProposalViewsV1,
  type LearningProposalViewV1,
} from '../domain/learningProposalView.js';
import {
  assertReviewDecisionReceiptMatches,
  parseReviewDecisionRequestV1,
  reviewDecisionBindingHash,
  reviewDecisionReceiptHash,
  reviewDecisionRequestHash,
  snapshotReviewDecisionReceiptV1,
  type ReviewDecisionApplyResultV1,
  type ReviewDecisionCommandV1,
  type ReviewDecisionIdempotencyKeyV1,
  type ReviewDecisionPortV1,
  type ReviewDecisionReceiptV1,
  type ReviewDecisionRequestV1,
} from '../domain/reviewDecision.js';
import {
  snapshotReviewActorV1,
  type ReviewActorV1,
  type ReviewEvidencePortRequestV1,
  type ReviewEvidencePortResultV1,
} from '../domain/reviewEvidence.js';
import type {
  ReviewPackageV2Source,
  SourceProjectedReviewPackageV2,
} from '../domain/reviewPackageV2.js';

export const M7_L2_REVIEW_FIXTURE_ENVELOPE_SCHEMA =
  'hercules-m7-l2-review-fixture-envelope/v1' as const;
export const M7_L2_REVIEW_FIXTURE_SCHEMA = 'hercules-m7-l2-review-fixture/v1' as const;
const STATE_ENVELOPE_SCHEMA = 'hercules-m7-l2-review-state-envelope/v1' as const;
const STATE_SCHEMA = 'hercules-m7-l2-review-state/v1' as const;
const ANCHOR_ENVELOPE_SCHEMA = 'hercules-m7-l2-review-anchor-envelope/v1' as const;
const ANCHOR_SCHEMA = 'hercules-m7-l2-review-anchor/v1' as const;
const PENDING_ENVELOPE_SCHEMA = 'hercules-m7-l2-review-pending-envelope/v1' as const;
const PENDING_SCHEMA = 'hercules-m7-l2-review-pending/v1' as const;
const INITIALIZED_SCHEMA = 'hercules-m7-l2-review-initialized/v1' as const;
const MAX_FIXTURE_BYTES = 8 * 1024 * 1024;
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const MAX_TASKS = 128;
const LOCK_WAIT_MS = 5_000;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const activeTransactions = new Set<string>();

export interface M7L2ReviewLearningSeed {
  readonly id: string;
  readonly title: string;
  readonly advisorySummary: string;
  readonly status: 'proposed' | 'accepted' | 'rejected';
  readonly evidenceArtifactIds: readonly string[];
}

export interface M7L2ReviewEvidenceSeed {
  readonly artifactRefId: string;
  readonly sha256: string;
  readonly mediaType: string;
  readonly redactionState: 'none' | 'redacted' | 'restricted';
  readonly contentBase64: string;
}

export interface M7L2ReviewFixtureTask {
  readonly source: ReviewPackageV2Source;
  readonly evidence: readonly M7L2ReviewEvidenceSeed[];
  readonly learningProposals: readonly M7L2ReviewLearningSeed[];
}

export interface M7L2ReviewFixturePayload {
  readonly schema: typeof M7_L2_REVIEW_FIXTURE_SCHEMA;
  readonly actor: ReviewActorV1;
  readonly tasks: readonly M7L2ReviewFixtureTask[];
}

export interface M7L2ReviewFixtureEnvelope {
  readonly schema: typeof M7_L2_REVIEW_FIXTURE_ENVELOPE_SCHEMA;
  readonly payload: M7L2ReviewFixturePayload;
  readonly fixtureHash: string;
}

export type M7L2ReviewFaultPoint =
  | 'after_temp_write'
  | 'after_file_sync'
  | 'before_rename'
  | 'after_rename'
  | 'after_directory_sync';

export interface OpenM7L2ReviewProviderOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly workRoot: string;
  readonly fixturePath: string;
  readonly inspectSource: (source: ReviewPackageV2Source) => SourceProjectedReviewPackageV2;
  readonly now?: () => string;
  /** Constructor-only deterministic test hook. Never connect this to an HTTP request. */
  readonly fault?: (point: M7L2ReviewFaultPoint) => void | Promise<void>;
}

interface OwnedEvidence {
  readonly artifactRefId: string;
  readonly sha256: string;
  readonly mediaType: string;
  readonly redactionState: 'none' | 'redacted' | 'restricted';
  readonly bytes: Uint8Array;
}

interface OwnedFixtureTask {
  readonly source: ReviewPackageV2Source;
  readonly evidence: readonly OwnedEvidence[];
  readonly proposals: readonly LearningProposalViewV1[];
}

interface DecisionEvent {
  readonly schema: 'hercules-m7-l2-review-decision-event/v1';
  readonly id: string;
  readonly humanDecisionId: string;
  readonly requestHash: string;
  readonly request: ReviewDecisionRequestV1;
  readonly priorSource: ReviewPackageV2Source;
  readonly receipt: ReviewDecisionReceiptV1;
}

interface StateTask {
  readonly taskId: string;
  readonly source: ReviewPackageV2Source;
  readonly events: readonly DecisionEvent[];
}

interface StatePayload {
  readonly schema: typeof STATE_SCHEMA;
  readonly fixtureHash: string;
  readonly sequence: number;
  readonly tasks: readonly StateTask[];
}

interface StateEnvelope {
  readonly schema: typeof STATE_ENVELOPE_SCHEMA;
  readonly payload: StatePayload;
  readonly stateHash: string;
}

interface StateSnapshot {
  readonly payload: StatePayload;
  readonly stateHash: string;
}

interface StateAnchorPayload {
  readonly schema: typeof ANCHOR_SCHEMA;
  readonly fixtureHash: string;
  readonly sequence: number;
  readonly stateHash: string;
}

interface StatePendingPayload {
  readonly schema: typeof PENDING_SCHEMA;
  readonly fixtureHash: string;
  readonly priorSequence: number;
  readonly priorStateHash: string;
  readonly nextSequence: number;
  readonly nextStateHash: string;
  readonly ownerPid: number;
  readonly ownerStartTimeTicks: string;
  readonly ownerBootId: string;
  readonly transactionId: string;
}

interface ProcessIdentity {
  readonly pid: number;
  readonly startTimeTicks: string;
  readonly bootId: string;
}

interface ProviderStateFiles {
  readonly state: string;
  readonly anchor: string;
  readonly pending: string;
}

type SourceReadResult =
  | { readonly status: 'available'; readonly source: ReviewPackageV2Source }
  | { readonly status: 'not_found' }
  | { readonly status: 'unavailable'; readonly reason: 'source_unavailable' | 'integrity_unavailable' };

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an exact object`);
  }
  const record = value as Readonly<Record<string, unknown>>;
  const ownKeys = Object.keys(record);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => !keys.includes(key))) {
    throw new TypeError(`${label} has an invalid schema`);
  }
  return record;
}

function denseBoundedArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > MAX_TASKS || Object.keys(value).length !== value.length) {
    throw new TypeError(`${label} must be a dense bounded array`);
  }
  return value;
}

function text(value: unknown, label: string, maximum = 8 * 1024): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function clone<T>(value: T): T {
  return canonicalClone(value) as T;
}

function bytesDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function parseEvidenceSeed(value: unknown, source: ReviewPackageV2Source): OwnedEvidence {
  const record = exactRecord(value, [
    'artifactRefId', 'sha256', 'mediaType', 'redactionState', 'contentBase64',
  ], 'fixture evidence');
  const artifactRefId = text(record['artifactRefId'], 'artifact ref id', 256);
  const sha256 = digest(record['sha256'], 'evidence digest');
  const mediaType = text(record['mediaType'], 'evidence media type', 256);
  if (
    record['redactionState'] !== 'none' &&
    record['redactionState'] !== 'redacted' &&
    record['redactionState'] !== 'restricted'
  ) throw new TypeError('fixture evidence redaction state is invalid');
  const contentBase64 = text(record['contentBase64'], 'evidence content', MAX_FIXTURE_BYTES * 2);
  const bytes = Uint8Array.from(Buffer.from(contentBase64, 'base64'));
  if (Buffer.from(bytes).toString('base64') !== contentBase64 || bytes.byteLength > MAX_FIXTURE_BYTES) {
    throw new TypeError('fixture evidence content is not canonical bounded base64');
  }
  const artifact = source.artifacts.find((item) => item.id === artifactRefId);
  if (
    artifact === undefined ||
    artifact.sha256 !== sha256 ||
    artifact.mediaType !== mediaType ||
    artifact.redactionState !== record['redactionState'] ||
    artifact.byteLength !== bytes.byteLength ||
    bytesDigest(bytes) !== sha256 ||
    source.evidenceManifest?.entries.some((entry) => entry.artifactRefId === artifactRefId) !== true
  ) throw new TypeError('fixture evidence is not bound to the source manifest and bytes');
  return Object.freeze({
    artifactRefId,
    sha256,
    mediaType,
    redactionState: record['redactionState'],
    bytes: Uint8Array.from(bytes),
  });
}

function parseLearningSeeds(
  value: unknown,
  source: ReviewPackageV2Source,
  projectionHash: string,
): readonly LearningProposalViewV1[] {
  const seeds = denseBoundedArray(value, 'fixture learning proposals').map((seed, index) => {
    const record = exactRecord(seed, [
      'id', 'title', 'advisorySummary', 'status', 'evidenceArtifactIds',
    ], `fixture learning proposal ${index}`);
    return {
      schema: 'hercules-learning-proposal-view/v1' as const,
      id: record['id'],
      taskId: source.task.id,
      projectionHash,
      title: record['title'],
      advisorySummary: record['advisorySummary'],
      status: record['status'],
      evidenceArtifactIds: record['evidenceArtifactIds'],
    };
  });
  const proposals = snapshotLearningProposalViewsV1(seeds);
  const members = new Set(source.artifacts.map((artifact) => artifact.id));
  if (proposals.some((proposal) => proposal.evidenceArtifactIds.some((id) => !members.has(id)))) {
    throw new TypeError('fixture learning proposal references non-member evidence');
  }
  return proposals;
}

function parseFixture(
  bytes: Uint8Array,
  inspectSource: OpenM7L2ReviewProviderOptions['inspectSource'],
): Readonly<{
  fixtureHash: string;
  actor: ReviewActorV1;
  tasks: readonly OwnedFixtureTask[];
}> {
  const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  const envelope = exactRecord(decoded, ['schema', 'payload', 'fixtureHash'], 'fixture envelope');
  if (envelope['schema'] !== M7_L2_REVIEW_FIXTURE_ENVELOPE_SCHEMA) {
    throw new TypeError('fixture envelope schema is invalid');
  }
  const payload = exactRecord(envelope['payload'], ['schema', 'actor', 'tasks'], 'fixture payload');
  if (payload['schema'] !== M7_L2_REVIEW_FIXTURE_SCHEMA) {
    throw new TypeError('fixture payload schema is invalid');
  }
  const fixtureHash = digest(envelope['fixtureHash'], 'fixture hash');
  if (hashCanonicalJson(payload) !== fixtureHash) throw new TypeError('fixture hash mismatch');
  const actor = snapshotReviewActorV1(payload['actor']);
  const ids = new Set<string>();
  const tasks = denseBoundedArray(payload['tasks'], 'fixture tasks').map((taskValue, index) => {
    const task = exactRecord(taskValue, ['source', 'evidence', 'learningProposals'], `fixture task ${index}`);
    const source = clone(task['source']) as ReviewPackageV2Source;
    const projected = inspectSource(source);
    if (ids.has(source.task.id)) throw new TypeError('fixture task ids must be unique');
    ids.add(source.task.id);
    const evidence = denseBoundedArray(task['evidence'], 'fixture evidence').map((item) =>
      parseEvidenceSeed(item, source));
    if (new Set(evidence.map((item) => item.artifactRefId)).size !== evidence.length) {
      throw new TypeError('fixture evidence ids must be unique');
    }
    return Object.freeze({
      source: clone(source),
      evidence: Object.freeze(evidence),
      proposals: parseLearningSeeds(task['learningProposals'], source, projected.projectionHash),
    });
  });
  if (tasks.length === 0) throw new TypeError('fixture must contain a task');
  return Object.freeze({ fixtureHash, actor, tasks: Object.freeze(tasks) });
}

function initialState(
  fixtureHash: string,
  tasks: readonly OwnedFixtureTask[],
): StatePayload {
  return {
    schema: STATE_SCHEMA,
    fixtureHash,
    sequence: 0,
    tasks: tasks.map((task) => ({
      taskId: task.source.task.id,
      source: clone(task.source),
      events: [],
    })),
  };
}

function assertRequestEligible(
  request: ReviewDecisionRequestV1,
  source: ReviewPackageV2Source,
  inspectSource: OpenM7L2ReviewProviderOptions['inspectSource'],
): void {
  const projected = inspectSource(source);
  if (
    projected.projectionHash !== request.projectionHash ||
    canonicalSerialize(source.currentBinding) !== canonicalSerialize(request.decisionBinding) ||
    !projected.validDecisions.includes(request.action)
  ) throw new TypeError('decision request is stale or ineligible');
  const expectedRisks = [
    ...projected.blockingFindings.map((risk) => risk.code),
    ...projected.remainingRisks.map((risk) => risk.code),
  ].sort();
  const acknowledgementsMatch = request.action === 'request_changes'
    ? request.acknowledgedRiskCodes.length === 0
    : canonicalSerialize(expectedRisks) === canonicalSerialize(request.acknowledgedRiskCodes);
  const reasonIsValid = request.action === 'request_changes'
    ? request.reason !== null && request.reason.trim().length > 0
    : request.reason === null;
  if (!acknowledgementsMatch || !reasonIsValid) {
    throw new TypeError('decision request risk acknowledgement or reason is invalid');
  }
}

function validateEvent(
  value: unknown,
  taskId: string,
  trustedActor: ReviewActorV1,
  inspectSource: OpenM7L2ReviewProviderOptions['inspectSource'],
): DecisionEvent {
  const event = exactRecord(value, [
    'schema', 'id', 'humanDecisionId', 'requestHash', 'request', 'priorSource', 'receipt',
  ], 'decision event');
  if (event['schema'] !== 'hercules-m7-l2-review-decision-event/v1') {
    throw new TypeError('decision event schema is invalid');
  }
  const priorSource = clone(event['priorSource']) as ReviewPackageV2Source;
  inspectSource(priorSource);
  const receipt = snapshotReviewDecisionReceiptV1(event['receipt']);
  const id = text(event['id'], 'event id', 256);
  const humanDecisionId = text(event['humanDecisionId'], 'human decision id', 256);
  const requestHash = digest(event['requestHash'], 'event request hash');
  const request = parseReviewDecisionRequestV1(event['request']);
  if (
    priorSource.task.id !== taskId || receipt.taskId !== taskId || receipt.eventId !== id ||
    receipt.humanDecisionId !== humanDecisionId || receipt.requestHash !== requestHash ||
    reviewDecisionRequestHash(request) !== requestHash || request.taskId !== taskId ||
    receipt.clientRequestId !== request.clientRequestId || receipt.action !== request.action ||
    receipt.acceptedProjectionHash !== request.projectionHash ||
    receipt.acceptedDecisionBindingHash !== reviewDecisionBindingHash(request.decisionBinding) ||
    receipt.priorIterationId !== priorSource.currentIteration.id
  ) throw new TypeError('decision event identity is inconsistent');
  if (canonicalSerialize(receipt.actor) !== canonicalSerialize(trustedActor)) {
    throw new TypeError('decision event actor differs from the immutable fixture actor');
  }
  assertReviewDecisionReceiptMatches({ request, requestHash, actor: trustedActor, receipt });
  assertRequestEligible(request, priorSource, inspectSource);
  return { schema: event['schema'], id, humanDecisionId, requestHash, request, priorSource, receipt };
}

function validateEventTransition(
  event: DecisionEvent,
  resultingSource: ReviewPackageV2Source,
  inspectSource: OpenM7L2ReviewProviderOptions['inspectSource'],
): void {
  const priorProjection = inspectSource(event.priorSource);
  const decision = resultingSource.humanDecisions.find((item) => item.id === event.humanDecisionId);
  if (
    decision === undefined ||
    priorProjection.projectionHash !== event.receipt.acceptedProjectionHash ||
    reviewDecisionBindingHash(event.priorSource.currentBinding) !==
      event.receipt.acceptedDecisionBindingHash ||
    canonicalSerialize(decision.binding) !== canonicalSerialize(event.priorSource.currentBinding) ||
    canonicalSerialize(decision.binding) !== canonicalSerialize(event.request.decisionBinding) ||
    decision.decision !== event.receipt.action ||
    decision.decision !== event.request.action ||
    decision.comment !== event.request.reason ||
    decision.actor.kind !== event.receipt.actor.kind ||
    decision.actor.id !== event.receipt.actor.id ||
    decision.createdAt !== event.receipt.recordedAt ||
    resultingSource.projectedAt !== event.receipt.recordedAt ||
    resultingSource.currentIteration.id !== event.receipt.resultingIterationId ||
    resultingSource.humanDecisions.length !== event.priorSource.humanDecisions.length + 1 ||
    canonicalSerialize(resultingSource.humanDecisions.slice(0, -1)) !==
      canonicalSerialize(event.priorSource.humanDecisions) ||
    resultingSource.humanDecisions[resultingSource.humanDecisions.length - 1]?.id !== decision.id ||
    (event.receipt.action === 'request_changes' ? decision.comment === null : decision.comment !== null)
  ) throw new TypeError('decision event receipt is not semantically bound to its transition');
  if (event.receipt.action === 'request_changes') {
    const closed: Iteration = {
      ...event.priorSource.currentIteration,
      state: 'failed',
      endedAt: event.receipt.recordedAt,
    };
    const successor: Iteration = {
      id: event.receipt.resultingIterationId,
      taskId: event.priorSource.task.id,
      contractVersion: event.priorSource.contract.version,
      ordinal: event.priorSource.currentIteration.ordinal + 1,
      state: 'planned',
      candidateRef: null,
      evidenceManifestId: null,
      finalVerdictId: null,
      createdAt: event.receipt.recordedAt,
      endedAt: null,
      supersedesIterationId: event.priorSource.currentIteration.id,
    };
    const attestationWithoutHash = {
      schema: 'hercules-evidence-integrity-attestation/v1' as const,
      result: 'unavailable' as const,
      evidenceManifestId: null,
      evidenceManifestHash: null,
      candidateRef: null,
      checkedArtifacts: [],
      verifierImplementation: 'm7-l2-review-provider/v1',
      checkedAt: event.receipt.recordedAt,
    };
    const expected = clone({
      ...event.priorSource,
      currentBinding: {
        ...event.priorSource.currentBinding,
        iterationId: successor.id,
        candidateRef: null,
        evidenceManifestHash: null,
      },
      currentIteration: successor,
      iterationHistory: [
        ...event.priorSource.iterationHistory.slice(0, -1),
        closed,
        successor,
      ],
      evidenceManifest: null,
      artifacts: [],
      evidenceIntegrity: {
        ...attestationWithoutHash,
        attestationHash: computeEvidenceIntegrityAttestationHash(attestationWithoutHash),
      },
      assertions: [],
      verificationReceipts: [],
      evaluation: null,
      humanDecisions: resultingSource.humanDecisions,
      usage: null,
      projectedAt: event.receipt.recordedAt,
    });
    if (canonicalSerialize(expected) !== canonicalSerialize(resultingSource)) {
      throw new TypeError('request changes transition mutated unrelated source state');
    }
  } else {
    const expected = clone({
      ...event.priorSource,
      humanDecisions: resultingSource.humanDecisions,
      projectedAt: event.receipt.recordedAt,
    });
    if (canonicalSerialize(expected) !== canonicalSerialize(resultingSource)) {
      throw new TypeError('approval or rejection mutated unrelated source state');
    }
  }
}

function parseState(
  raw: string,
  seedTasks: readonly OwnedFixtureTask[],
  fixtureHash: string,
  trustedActor: ReviewActorV1,
  inspectSource: OpenM7L2ReviewProviderOptions['inspectSource'],
): StateSnapshot {
  const decoded = JSON.parse(raw) as unknown;
  if (canonicalSerialize(decoded) !== raw) throw new TypeError('durable state is not canonical');
  const envelope = exactRecord(decoded, ['schema', 'payload', 'stateHash'], 'state envelope');
  if (envelope['schema'] !== STATE_ENVELOPE_SCHEMA) throw new TypeError('state envelope schema is invalid');
  const stateHash = digest(envelope['stateHash'], 'state hash');
  const payload = exactRecord(envelope['payload'], [
    'schema', 'fixtureHash', 'sequence', 'tasks',
  ], 'state payload');
  if (
    payload['schema'] !== STATE_SCHEMA || payload['fixtureHash'] !== fixtureHash ||
    !Number.isSafeInteger(payload['sequence']) || Number(payload['sequence']) < 0 ||
    hashCanonicalJson(payload) !== stateHash
  ) throw new TypeError('state payload is invalid');
  const ids = new Set<string>();
  const tasks = denseBoundedArray(payload['tasks'], 'state tasks').map((value) => {
    const task = exactRecord(value, ['taskId', 'source', 'events'], 'state task');
    const taskId = text(task['taskId'], 'state task id', 256);
    const source = clone(task['source']) as ReviewPackageV2Source;
    inspectSource(source);
    if (source.task.id !== taskId || ids.has(taskId)) throw new TypeError('state task identity is invalid');
    ids.add(taskId);
    const events = denseBoundedArray(task['events'], 'decision events').map((event) =>
      validateEvent(event, taskId, trustedActor, inspectSource));
    if (new Set(events.map((event) => event.id)).size !== events.length) {
      throw new TypeError('decision event ids must be unique');
    }
    const seed = seedTasks.find((item) => item.source.task.id === taskId);
    if (seed === undefined) throw new TypeError('state contains a task outside the fixture');
    if (events.length === 0) {
      if (canonicalSerialize(source) !== canonicalSerialize(seed.source)) {
        throw new TypeError('uncommitted state differs from its immutable seed');
      }
    } else {
      if (canonicalSerialize(events[0]!.priorSource) !== canonicalSerialize(seed.source)) {
        throw new TypeError('decision history does not begin at its immutable seed');
      }
      events.forEach((event, index) => {
        const result = events[index + 1]?.priorSource ?? source;
        validateEventTransition(event, result, inspectSource);
      });
    }
    return { taskId, source, events };
  });
  if (
    tasks.length !== seedTasks.length ||
    seedTasks.some((seed) => !ids.has(seed.source.task.id))
  ) throw new TypeError('state task set differs from its immutable seed');
  const sequence = payload['sequence'] as number;
  const allEvents = tasks.flatMap((task) => task.events);
  const expectedEventIds = new Set(
    Array.from({ length: sequence }, (_, index) => `m7-event-${index + 1}`),
  );
  if (
    allEvents.length !== sequence ||
    allEvents.some((event) => !expectedEventIds.delete(event.id)) ||
    expectedEventIds.size !== 0 ||
    new Set(allEvents.map((event) => event.humanDecisionId)).size !== allEvents.length
  ) throw new TypeError('state sequence does not exactly bind its decision events');
  return {
    payload: {
      schema: STATE_SCHEMA,
      fixtureHash,
      sequence,
      tasks,
    },
    stateHash,
  };
}

function stateBytes(payload: StatePayload): string {
  const envelope: StateEnvelope = {
    schema: STATE_ENVELOPE_SCHEMA,
    payload,
    stateHash: hashCanonicalJson(payload),
  };
  return canonicalSerialize(envelope);
}

function errorCode(error: unknown): string | null {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as Readonly<{ code?: unknown }>).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

async function removeTemp(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

async function readNoFollow(
  path: string,
  maximumBytes: number,
  label: string,
  ownerOnly = true,
): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    const currentUid = process.getuid?.();
    if (
      !before.isFile() || before.size > maximumBytes || before.size < 0 ||
      before.nlink !== 1 ||
      (ownerOnly && (
        (before.mode & 0o777) !== 0o600 ||
        (currentUid !== undefined && before.uid !== currentUid)
      ))
    ) {
      throw new TypeError(`${label} must be a bounded regular file`);
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) throw new TypeError(`${label} changed while being read`);
      offset += bytesRead;
    }
    const overflow = Buffer.alloc(1);
    const { bytesRead: overflowBytes } = await handle.read(overflow, 0, 1, offset);
    const after = await handle.stat();
    if (
      overflowBytes !== 0 || after.size !== before.size || after.dev !== before.dev ||
      after.ino !== before.ino || after.nlink !== before.nlink || after.mode !== before.mode ||
      after.uid !== before.uid || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
    ) {
      throw new TypeError(`${label} changed while being read`);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    await handle.close();
  }
}

function anchorBytes(payload: StateAnchorPayload): string {
  return canonicalSerialize({
    schema: ANCHOR_ENVELOPE_SCHEMA,
    payload,
    anchorHash: hashCanonicalJson(payload),
  });
}

function parseAnchor(raw: string, fixtureHash: string): StateAnchorPayload {
  const decoded = JSON.parse(raw) as unknown;
  if (canonicalSerialize(decoded) !== raw) throw new TypeError('state anchor is not canonical');
  const envelope = exactRecord(decoded, ['schema', 'payload', 'anchorHash'], 'state anchor envelope');
  if (envelope['schema'] !== ANCHOR_ENVELOPE_SCHEMA) throw new TypeError('state anchor schema is invalid');
  const payload = exactRecord(
    envelope['payload'],
    ['schema', 'fixtureHash', 'sequence', 'stateHash'],
    'state anchor payload',
  );
  if (
    payload['schema'] !== ANCHOR_SCHEMA || payload['fixtureHash'] !== fixtureHash ||
    !Number.isSafeInteger(payload['sequence']) || Number(payload['sequence']) < 0 ||
    digest(payload['stateHash'], 'anchored state hash') !== payload['stateHash'] ||
    digest(envelope['anchorHash'], 'state anchor hash') !== hashCanonicalJson(payload)
  ) throw new TypeError('state anchor payload is invalid');
  return {
    schema: ANCHOR_SCHEMA,
    fixtureHash,
    sequence: payload['sequence'] as number,
    stateHash: payload['stateHash'] as string,
  };
}

function pendingBytes(payload: StatePendingPayload): string {
  return canonicalSerialize({
    schema: PENDING_ENVELOPE_SCHEMA,
    payload,
    pendingHash: hashCanonicalJson(payload),
  });
}

function parsePending(raw: string, fixtureHash: string): StatePendingPayload {
  const decoded = JSON.parse(raw) as unknown;
  if (canonicalSerialize(decoded) !== raw) throw new TypeError('state intent is not canonical');
  const envelope = exactRecord(decoded, ['schema', 'payload', 'pendingHash'], 'state intent envelope');
  if (envelope['schema'] !== PENDING_ENVELOPE_SCHEMA) throw new TypeError('state intent schema is invalid');
  const payload = exactRecord(envelope['payload'], [
    'schema', 'fixtureHash', 'priorSequence', 'priorStateHash', 'nextSequence', 'nextStateHash',
    'ownerPid', 'ownerStartTimeTicks', 'ownerBootId', 'transactionId',
  ], 'state intent payload');
  if (
    payload['schema'] !== PENDING_SCHEMA || payload['fixtureHash'] !== fixtureHash ||
    !Number.isSafeInteger(payload['priorSequence']) || Number(payload['priorSequence']) < 0 ||
    !Number.isSafeInteger(payload['nextSequence']) ||
    Number(payload['nextSequence']) !== Number(payload['priorSequence']) + 1 ||
    !Number.isSafeInteger(payload['ownerPid']) || Number(payload['ownerPid']) <= 0 ||
    typeof payload['ownerStartTimeTicks'] !== 'string' ||
    !/^\d+$/.test(payload['ownerStartTimeTicks']) || payload['ownerStartTimeTicks'].length > 32 ||
    typeof payload['ownerBootId'] !== 'string' ||
    !/^[0-9a-f-]{1,64}$/.test(payload['ownerBootId']) ||
    typeof payload['transactionId'] !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(payload['transactionId']) ||
    digest(payload['priorStateHash'], 'prior state hash') !== payload['priorStateHash'] ||
    digest(payload['nextStateHash'], 'next state hash') !== payload['nextStateHash'] ||
    digest(envelope['pendingHash'], 'state intent hash') !== hashCanonicalJson(payload)
  ) throw new TypeError('state intent payload is invalid');
  return {
    schema: PENDING_SCHEMA,
    fixtureHash,
    priorSequence: payload['priorSequence'] as number,
    priorStateHash: payload['priorStateHash'] as string,
    nextSequence: payload['nextSequence'] as number,
    nextStateHash: payload['nextStateHash'] as string,
    ownerPid: payload['ownerPid'] as number,
    ownerStartTimeTicks: payload['ownerStartTimeTicks'],
    ownerBootId: payload['ownerBootId'],
    transactionId: payload['transactionId'],
  };
}

function readBootId(): string | null {
  try {
    const value = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return /^[0-9a-f-]{1,64}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function readProcessIdentity(pid: number): ProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const statLine = readFileSync(`/proc/${pid}/stat`, 'utf8').trim();
    const commEnd = statLine.lastIndexOf(')');
    if (commEnd < 0) return null;
    const startTimeTicks = statLine.slice(commEnd + 1).trim().split(/\s+/)[19];
    const bootId = readBootId();
    if (startTimeTicks === undefined || !/^\d+$/.test(startTimeTicks) || bootId === null) return null;
    return { pid, startTimeTicks, bootId };
  } catch {
    return null;
  }
}

function pendingOwnerAlive(pending: StatePendingPayload): boolean | null {
  const current = readProcessIdentity(process.pid);
  if (
    current !== null && current.pid === pending.ownerPid &&
    current.startTimeTicks === pending.ownerStartTimeTicks && current.bootId === pending.ownerBootId
  ) return activeTransactions.has(pending.transactionId);
  const bootId = readBootId();
  if (bootId === null) return null;
  if (bootId !== pending.ownerBootId) return false;
  try {
    const statLine = readFileSync(`/proc/${pending.ownerPid}/stat`, 'utf8').trim();
    const commEnd = statLine.lastIndexOf(')');
    if (commEnd < 0) return null;
    const startTimeTicks = statLine.slice(commEnd + 1).trim().split(/\s+/)[19];
    return startTimeTicks === undefined ? null : startTimeTicks === pending.ownerStartTimeTicks;
  } catch (error) {
    const code = errorCode(error);
    return code === 'ENOENT' || code === 'ESRCH' ? false : null;
  }
}

async function writeExclusive(path: string, bytes: string, directory: FileHandle): Promise<void> {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await directory.sync();
}

async function replaceFile(path: string, bytes: string, directory: FileHandle): Promise<void> {
  const tempPath = join(dirname(path), `.replace-${randomUUID()}.tmp`);
  try {
    await writeExclusive(tempPath, bytes, directory);
    await rename(tempPath, path);
    await directory.sync();
  } finally {
    await removeTemp(tempPath);
  }
}

async function acquireLock(manager: ArchiveLockManager) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      return await manager.acquire();
    } catch (error) {
      if (!(error instanceof ArchiveLockBusyError) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

async function loadConsistentState(input: Readonly<{
  files: ProviderStateFiles;
  directory: FileHandle;
  seedTasks: readonly OwnedFixtureTask[];
  fixtureHash: string;
  trustedActor: ReviewActorV1;
  inspectSource: OpenM7L2ReviewProviderOptions['inspectSource'];
  recoverPending?: boolean;
}>): Promise<StateSnapshot> {
  const anchor = parseAnchor(
    await readNoFollow(input.files.anchor, 64 * 1024, 'state anchor'),
    input.fixtureHash,
  );
  const state = parseState(
    await readNoFollow(input.files.state, MAX_STATE_BYTES, 'durable state'),
    input.seedTasks,
    input.fixtureHash,
    input.trustedActor,
    input.inspectSource,
  );
  if (await pathExists(input.files.pending)) {
    if (input.recoverPending === false) {
      throw new TypeError('state recovery is pending outside the read-only transaction');
    }
    const pending = parsePending(
      await readNoFollow(input.files.pending, 64 * 1024, 'state intent'),
      input.fixtureHash,
    );
    if (pendingOwnerAlive(pending) !== false) {
      throw new TypeError('state transaction owner is active or cannot be disproved');
    }
    const anchorIsPrior =
      pending.priorSequence === anchor.sequence && pending.priorStateHash === anchor.stateHash;
    const anchorIsNext =
      pending.nextSequence === anchor.sequence && pending.nextStateHash === anchor.stateHash;
    if (
      anchorIsPrior && state.payload.sequence === anchor.sequence && state.stateHash === anchor.stateHash
    ) {
      await unlink(input.files.pending);
      await input.directory.sync();
    } else if (
      anchorIsPrior && state.payload.sequence === pending.nextSequence &&
      state.stateHash === pending.nextStateHash
    ) {
      await replaceFile(input.files.anchor, anchorBytes({
        schema: ANCHOR_SCHEMA,
        fixtureHash: input.fixtureHash,
        sequence: state.payload.sequence,
        stateHash: state.stateHash,
      }), input.directory);
      await unlink(input.files.pending);
      await input.directory.sync();
    } else if (
      anchorIsNext && state.payload.sequence === anchor.sequence && state.stateHash === anchor.stateHash
    ) {
      await unlink(input.files.pending);
      await input.directory.sync();
    } else {
      throw new TypeError('state differs from both sides of its durable intent');
    }
  } else if (
    state.payload.sequence !== anchor.sequence || state.stateHash !== anchor.stateHash
  ) {
    throw new TypeError('durable state does not match its monotonic anchor');
  }
  return state;
}

export class M7L2ReviewProvider implements ReviewDecisionPortV1 {
  readonly actor: Readonly<{
    isReady: () => boolean;
    resolveActor: () => Promise<ReviewActorV1 | null>;
  }>;
  readonly evidence: Readonly<{
    isReady: () => boolean;
    resolveActor: () => Promise<ReviewActorV1 | null>;
    read: (request: ReviewEvidencePortRequestV1) => Promise<ReviewEvidencePortResultV1>;
  }>;
  readonly learning: Readonly<{
    isReady: () => boolean;
    read: (request: Readonly<{ taskId: string; projectionHash: string }>) => Promise<
      | { readonly status: 'available'; readonly proposals: readonly LearningProposalViewV1[] }
      | { readonly status: 'not_found' }
      | { readonly status: 'unavailable'; readonly reason: 'source_unavailable' | 'integrity_unavailable' }
    >;
  }>;

  readonly #fixtureHash: string;
  readonly #seedTasks: readonly OwnedFixtureTask[];
  readonly #trustedActor: ReviewActorV1;
  readonly #inspectSource: OpenM7L2ReviewProviderOptions['inspectSource'];
  readonly #files: ProviderStateFiles;
  readonly #stateDirectory: FileHandle;
  readonly #publishedStateDirectory: string;
  readonly #stateDirectoryIdentity: Readonly<{ dev: number; ino: number; uid: number }>;
  readonly #lock: ArchiveLockManager;
  readonly #now: () => string;
  readonly #fault: ((point: M7L2ReviewFaultPoint) => void | Promise<void>) | undefined;
  #ready = true;
  #tail: Promise<void> = Promise.resolve();

  constructor(input: Readonly<{
    fixtureHash: string;
    tasks: readonly OwnedFixtureTask[];
    actor: ReviewActorV1;
    inspectSource: OpenM7L2ReviewProviderOptions['inspectSource'];
    files: ProviderStateFiles;
    stateDirectory: FileHandle;
    publishedStateDirectory: string;
    stateDirectoryIdentity: Readonly<{ dev: number; ino: number; uid: number }>;
    lock: ArchiveLockManager;
    now: () => string;
    fault?: (point: M7L2ReviewFaultPoint) => void | Promise<void>;
  }>) {
    this.#fixtureHash = input.fixtureHash;
    this.#seedTasks = input.tasks;
    this.#trustedActor = input.actor;
    this.#inspectSource = input.inspectSource;
    this.#files = input.files;
    this.#stateDirectory = input.stateDirectory;
    this.#publishedStateDirectory = input.publishedStateDirectory;
    this.#stateDirectoryIdentity = input.stateDirectoryIdentity;
    this.#lock = input.lock;
    this.#now = input.now;
    this.#fault = input.fault;
    this.actor = Object.freeze({
      isReady: () => this.isReady(),
      resolveActor: async () => this.isReady() ? clone(this.#trustedActor) : null,
    });
    this.evidence = Object.freeze({
      isReady: () => this.isReady(),
      resolveActor: async () => this.isReady() ? clone(this.#trustedActor) : null,
      read: async (request: ReviewEvidencePortRequestV1) => this.#readEvidence(request),
    });
    this.learning = Object.freeze({
      isReady: () => this.isReady(),
      read: async (request: Readonly<{ taskId: string; projectionHash: string }>) =>
        this.#readLearning(request),
    });
  }

  isReady(): boolean {
    return this.#ready;
  }

  async #assertPublishedStateDirectory(): Promise<void> {
    const info = await lstat(this.#publishedStateDirectory);
    if (
      !info.isDirectory() || info.isSymbolicLink() ||
      info.dev !== this.#stateDirectoryIdentity.dev ||
      info.ino !== this.#stateDirectoryIdentity.ino ||
      info.uid !== this.#stateDirectoryIdentity.uid ||
      (info.mode & 0o777) !== 0o700
    ) throw new TypeError('published provider state directory identity changed');
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const guarded = async (): Promise<T> => {
      const lease = await acquireLock(this.#lock);
      try {
        await this.#assertPublishedStateDirectory();
        const result = await operation();
        await this.#assertPublishedStateDirectory();
        await this.#lock.assertOwns(lease);
        return result;
      } catch (error) {
        this.#ready = false;
        throw error;
      } finally {
        await lease.release();
      }
    };
    const result = this.#tail.then(guarded, guarded);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #load(recoverPending = true): Promise<StateSnapshot> {
    return loadConsistentState({
      files: this.#files,
      directory: this.#stateDirectory,
      seedTasks: this.#seedTasks,
      fixtureHash: this.#fixtureHash,
      trustedActor: this.#trustedActor,
      inspectSource: this.#inspectSource,
      recoverPending,
    });
  }

  async #write(prior: StateSnapshot, payload: StatePayload): Promise<void> {
    const nextStateHash = hashCanonicalJson(payload);
    const owner = readProcessIdentity(process.pid);
    if (owner === null) throw new TypeError('writer process identity is unavailable');
    const transactionId = randomUUID();
    const intent: StatePendingPayload = {
      schema: PENDING_SCHEMA,
      fixtureHash: this.#fixtureHash,
      priorSequence: prior.payload.sequence,
      priorStateHash: prior.stateHash,
      nextSequence: payload.sequence,
      nextStateHash,
      ownerPid: owner.pid,
      ownerStartTimeTicks: owner.startTimeTicks,
      ownerBootId: owner.bootId,
      transactionId,
    };
    const tempPath = join(dirname(this.#files.state), `.state-${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    activeTransactions.add(transactionId);
    try {
      await writeExclusive(this.#files.pending, pendingBytes(intent), this.#stateDirectory);
      const currentAnchor = parseAnchor(
        await readNoFollow(this.#files.anchor, 64 * 1024, 'state anchor'),
        this.#fixtureHash,
      );
      const currentState = parseState(
        await readNoFollow(this.#files.state, MAX_STATE_BYTES, 'durable state'),
        this.#seedTasks,
        this.#fixtureHash,
        this.#trustedActor,
        this.#inspectSource,
      );
      if (
        currentAnchor.sequence !== prior.payload.sequence ||
        currentAnchor.stateHash !== prior.stateHash ||
        currentState.payload.sequence !== prior.payload.sequence ||
        currentState.stateHash !== prior.stateHash
      ) {
        await unlink(this.#files.pending);
        await this.#stateDirectory.sync();
        throw new TypeError('durable compare-and-swap base changed before publication');
      }
      handle = await open(
        tempPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(stateBytes(payload), 'utf8');
      await this.#fault?.('after_temp_write');
      await handle.sync();
      await this.#fault?.('after_file_sync');
      await handle.close();
      handle = null;
      await this.#fault?.('before_rename');
      await rename(tempPath, this.#files.state);
      await this.#fault?.('after_rename');
      await this.#stateDirectory.sync();
      await this.#fault?.('after_directory_sync');
      await replaceFile(this.#files.anchor, anchorBytes({
        schema: ANCHOR_SCHEMA,
        fixtureHash: this.#fixtureHash,
        sequence: payload.sequence,
        stateHash: nextStateHash,
      }), this.#stateDirectory);
      await unlink(this.#files.pending);
      await this.#stateDirectory.sync();
    } finally {
      activeTransactions.delete(transactionId);
      if (handle !== null) await handle.close();
      await removeTemp(tempPath);
    }
  }

  async read(taskId: string): Promise<SourceReadResult> {
    return this.#exclusive(async () => {
      try {
        const state = (await this.#load()).payload;
        const task = state.tasks.find((item) => item.taskId === taskId);
        return task === undefined
          ? { status: 'not_found' as const }
          : { status: 'available' as const, source: clone(task.source) };
      } catch {
        this.#ready = false;
        return { status: 'unavailable', reason: 'integrity_unavailable' };
      }
    });
  }

  async #readEvidence(request: ReviewEvidencePortRequestV1): Promise<ReviewEvidencePortResultV1> {
    return this.#exclusive(async () => {
      try {
        if (
          request.schema !== 'hercules-review-evidence-read/v1' || request.purpose !== 'operator_review' ||
          canonicalSerialize(request.actor) !== canonicalSerialize(this.#trustedActor)
        ) return { status: 'unavailable', reason: 'access_denied' };
        const state = (await this.#load()).payload;
        const stateTask = state.tasks.find((item) => item.taskId === request.taskId);
        const seedTask = this.#seedTasks.find((item) => item.source.task.id === request.taskId);
        if (stateTask === undefined || seedTask === undefined) {
          return { status: 'unavailable', reason: 'content_unavailable' };
        }
        const projected = this.#inspectSource(stateTask.source);
        const artifact = stateTask.source.artifacts.find((item) => item.id === request.artifactRefId);
        const evidence = seedTask.evidence.find((item) => item.artifactRefId === request.artifactRefId);
        if (
          projected.projectionHash !== request.projectionHash || artifact === undefined || evidence === undefined ||
          artifact.sha256 !== request.sha256 || artifact.redactionState !== request.redactionState ||
          evidence.sha256 !== request.sha256 || evidence.redactionState !== request.redactionState
        ) return { status: 'unavailable', reason: 'content_unavailable' };
        if (evidence.redactionState === 'restricted') return { status: 'unavailable', reason: 'restricted' };
        return {
          status: 'available', sha256: evidence.sha256, mediaType: evidence.mediaType,
          redactionState: evidence.redactionState, bytes: Uint8Array.from(evidence.bytes),
        };
      } catch {
        this.#ready = false;
        return { status: 'unavailable', reason: 'content_unavailable' };
      }
    });
  }

  async #readLearning(request: Readonly<{ taskId: string; projectionHash: string }>) {
    return this.#exclusive(async () => {
      try {
        const state = (await this.#load()).payload;
        const stateTask = state.tasks.find((item) => item.taskId === request.taskId);
        const seedTask = this.#seedTasks.find((item) => item.source.task.id === request.taskId);
        if (stateTask === undefined || seedTask === undefined) return { status: 'not_found' as const };
        const projectionHash = this.#inspectSource(stateTask.source).projectionHash;
        if (projectionHash !== request.projectionHash) {
          return { status: 'unavailable' as const, reason: 'source_unavailable' as const };
        }
        const proposals = seedTask.proposals.filter((proposal) => proposal.projectionHash === projectionHash);
        return { status: 'available' as const, proposals: clone(proposals) };
      } catch {
        this.#ready = false;
        return { status: 'unavailable' as const, reason: 'integrity_unavailable' as const };
      }
    });
  }

  async lookup(key: ReviewDecisionIdempotencyKeyV1): Promise<ReviewDecisionReceiptV1 | null> {
    return this.#exclusive(async () => {
      try {
        const state = (await this.#load()).payload;
        return clone(this.#findReceipt(state, key)?.receipt ?? null);
      } catch {
        this.#ready = false;
        return null;
      }
    });
  }

  #findReceipt(state: StatePayload, key: ReviewDecisionIdempotencyKeyV1): DecisionEvent | undefined {
    const task = state.tasks.find((item) => item.taskId === key.taskId);
    return task?.events.find((event) =>
      event.receipt.actor.issuer === key.actorIssuer && event.receipt.actor.id === key.actorId &&
      event.receipt.clientRequestId === key.clientRequestId);
  }

  async apply(command: ReviewDecisionCommandV1): Promise<ReviewDecisionApplyResultV1> {
    return this.#exclusive(async () => {
      try {
        const request = parseReviewDecisionRequestV1(command.request);
        const actor = snapshotReviewActorV1(command.actor);
        if (
          canonicalSerialize(actor) !== canonicalSerialize(this.#trustedActor) ||
          reviewDecisionRequestHash(request) !== command.requestHash ||
          command.expectedProjectionHash !== request.projectionHash ||
          command.expectedDecisionBindingHash !== reviewDecisionBindingHash(request.decisionBinding)
        ) return { kind: 'unavailable', reason: 'provider_contract_violation' };
        const stateSnapshot = await this.#load();
        const state = stateSnapshot.payload;
        const key = {
          actorIssuer: actor.issuer, actorId: actor.id, taskId: request.taskId,
          clientRequestId: request.clientRequestId,
        };
        const prior = this.#findReceipt(state, key);
        if (prior !== undefined) {
          return prior.requestHash === command.requestHash
            ? { kind: 'duplicate', receipt: clone(prior.receipt) }
            : { kind: 'idempotency_conflict' };
        }
        const taskIndex = state.tasks.findIndex((item) => item.taskId === request.taskId);
        if (taskIndex < 0) return { kind: 'unavailable', reason: 'source_unavailable' };
        const task = state.tasks[taskIndex]!;
        try {
          assertRequestEligible(request, task.source, this.#inspectSource);
        } catch {
          return { kind: 'stale' };
        }
        const sequence = state.sequence + 1;
        const next = this.#transition(task.source, request.action, request.reason, actor, sequence);
        const recordedAt = next.recordedAt;
        const receiptWithoutHash = {
          schema: 'hercules-review-decision-receipt/v1' as const,
          clientRequestId: request.clientRequestId,
          requestHash: command.requestHash,
          taskId: request.taskId,
          actor,
          acceptedProjectionHash: request.projectionHash,
          acceptedDecisionBindingHash: reviewDecisionBindingHash(request.decisionBinding),
          action: request.action,
          humanDecisionId: next.humanDecision.id,
          eventId: `m7-event-${sequence}`,
          priorIterationId: task.source.currentIteration.id,
          resultingIterationId: next.source.currentIteration.id,
          recordedAt,
        };
        const receipt = snapshotReviewDecisionReceiptV1({
          ...receiptWithoutHash,
          receiptHash: reviewDecisionReceiptHash(receiptWithoutHash),
        });
        assertReviewDecisionReceiptMatches({ request, requestHash: command.requestHash, actor, receipt });
        const event: DecisionEvent = {
          schema: 'hercules-m7-l2-review-decision-event/v1',
          id: receipt.eventId,
          humanDecisionId: receipt.humanDecisionId,
          requestHash: command.requestHash,
          request: clone(request),
          priorSource: clone(task.source),
          receipt,
        };
        const tasks = state.tasks.map((item, index) => index === taskIndex
          ? { taskId: item.taskId, source: next.source, events: [...item.events, event] }
          : item);
        const nextState: StatePayload = {
          schema: STATE_SCHEMA, fixtureHash: state.fixtureHash, sequence, tasks,
        };
        parseState(
          stateBytes(nextState),
          this.#seedTasks,
          this.#fixtureHash,
          this.#trustedActor,
          this.#inspectSource,
        );
        await this.#write(stateSnapshot, nextState);
        return { kind: 'committed', receipt: clone(receipt) };
      } catch {
        return { kind: 'unavailable', reason: 'transaction_unavailable' };
      }
    });
  }

  #transition(
    source: ReviewPackageV2Source,
    action: 'approve_outcome' | 'reject_outcome' | 'request_changes',
    reason: string | null,
    actor: ReviewActorV1,
    sequence: number,
  ): Readonly<{ source: ReviewPackageV2Source; humanDecision: HumanDecision; recordedAt: string }> {
    const recordedAt = this.#now();
    if (new Date(recordedAt).toISOString() !== recordedAt) throw new TypeError('clock is invalid');
    const humanDecision: HumanDecision = {
      id: `m7-human-decision-${sequence}`,
      binding: clone(source.currentBinding),
      decision: action,
      comment: reason,
      actor: { kind: 'human', id: actor.id },
      createdAt: recordedAt,
    };
    if (action !== 'request_changes') {
      const updated = clone({
        ...source,
        humanDecisions: [...source.humanDecisions, humanDecision],
        projectedAt: recordedAt,
      });
      this.#inspectSource(updated);
      return { source: updated, humanDecision, recordedAt };
    }
    const prior: Iteration = {
      ...source.currentIteration,
      state: 'failed',
      endedAt: recordedAt,
    };
    const successor: Iteration = {
      id: `m7-iteration-${sequence}`,
      taskId: source.task.id,
      contractVersion: source.contract.version,
      ordinal: source.currentIteration.ordinal + 1,
      state: 'planned',
      candidateRef: null,
      evidenceManifestId: null,
      finalVerdictId: null,
      createdAt: recordedAt,
      endedAt: null,
      supersedesIterationId: source.currentIteration.id,
    };
    const attestationWithoutHash = {
      schema: 'hercules-evidence-integrity-attestation/v1' as const,
      result: 'unavailable' as const,
      evidenceManifestId: null,
      evidenceManifestHash: null,
      candidateRef: null,
      checkedArtifacts: [],
      verifierImplementation: 'm7-l2-review-provider/v1',
      checkedAt: recordedAt,
    };
    const updated: ReviewPackageV2Source = clone({
      ...source,
      currentBinding: {
        ...source.currentBinding,
        iterationId: successor.id,
        candidateRef: null,
        evidenceManifestHash: null,
      },
      currentIteration: successor,
      iterationHistory: [...source.iterationHistory.slice(0, -1), prior, successor],
      evidenceManifest: null,
      artifacts: [],
      evidenceIntegrity: {
        ...attestationWithoutHash,
        attestationHash: computeEvidenceIntegrityAttestationHash(attestationWithoutHash),
      },
      assertions: [],
      verificationReceipts: [],
      evaluation: null,
      humanDecisions: [...source.humanDecisions, humanDecision],
      usage: null,
      projectedAt: recordedAt,
    });
    this.#inspectSource(updated);
    return { source: updated, humanDecision, recordedAt };
  }

  async validateCommittedReceipt(input: Readonly<{
    key: ReviewDecisionIdempotencyKeyV1;
    requestHash: string;
    receipt: ReviewDecisionReceiptV1;
  }>): Promise<{ readonly kind: 'valid' } | { readonly kind: 'invalid' } | { readonly kind: 'unavailable' }> {
    return this.#exclusive(async () => {
      try {
        const supplied = snapshotReviewDecisionReceiptV1(input.receipt);
        const state = (await this.#load(false)).payload;
        const event = this.#findReceipt(state, input.key);
        if (
          event === undefined || event.requestHash !== input.requestHash ||
          canonicalSerialize(event.receipt) !== canonicalSerialize(supplied)
        ) return { kind: 'invalid' };
        return { kind: 'valid' };
      } catch {
        this.#ready = false;
        return { kind: 'unavailable' };
      }
    });
  }
}

async function guardedFixtureBytes(workRoot: string, fixturePath: string): Promise<Readonly<{
  root: string;
  bytes: Uint8Array;
}>> {
  if (!isAbsolute(fixturePath)) throw new TypeError('fixture path must be absolute');
  if (!isAbsolute(workRoot)) throw new TypeError('work root must be absolute');
  const root = await realpath(workRoot);
  const resolvedFixture = resolve(fixturePath);
  const rel = relative(root, resolvedFixture);
  if (
    rel === '' || rel.startsWith('..') || isAbsolute(rel) || dirname(resolvedFixture) !== root
  ) {
    throw new TypeError('fixture path must be confined as a direct file under the work root');
  }
  const rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const rootInfo = await rootHandle.stat();
    const publishedRoot = await lstat(root);
    if (
      !rootInfo.isDirectory() || publishedRoot.isSymbolicLink() ||
      rootInfo.dev !== publishedRoot.dev || rootInfo.ino !== publishedRoot.ino
    ) {
      throw new TypeError('work root descriptor identity is invalid');
    }
    const descriptorPath = `/proc/self/fd/${rootHandle.fd}/${rel}`;
    if (await realpath(descriptorPath) !== resolvedFixture) {
      throw new TypeError('fixture path must not traverse symlinks');
    }
    const raw = await readNoFollow(descriptorPath, MAX_FIXTURE_BYTES, 'fixture', false);
    const after = await lstat(root);
    if (
      after.isSymbolicLink() || after.dev !== rootInfo.dev || after.ino !== rootInfo.ino ||
      await realpath(root) !== root
    ) throw new TypeError('work root changed while fixture was read');
    return { root, bytes: Uint8Array.from(Buffer.from(raw, 'utf8')) };
  } finally {
    await rootHandle.close();
  }
}

async function ensureOwnerOnlyDirectory(directory: string, expectedRealPath: string): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
  const info = await lstat(directory);
  const currentUid = process.getuid?.();
  if (
    !info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 ||
    (currentUid !== undefined && info.uid !== currentUid) ||
    await realpath(directory) !== expectedRealPath
  ) throw new TypeError('provider state directory must be owner-only and stable');
}

function initializedBytes(fixtureHash: string, initialStateHash: string): string {
  const payload = {
    schema: INITIALIZED_SCHEMA,
    fixtureHash,
    initialStateHash,
  };
  return canonicalSerialize({ payload, markerHash: hashCanonicalJson(payload) });
}

function parseInitialized(raw: string, fixtureHash: string, initialStateHash: string): void {
  const decoded = JSON.parse(raw) as unknown;
  if (canonicalSerialize(decoded) !== raw) throw new TypeError('initialization marker is not canonical');
  const envelope = exactRecord(decoded, ['payload', 'markerHash'], 'initialization marker');
  const payload = exactRecord(
    envelope['payload'],
    ['schema', 'fixtureHash', 'initialStateHash'],
    'initialization marker payload',
  );
  if (
    payload['schema'] !== INITIALIZED_SCHEMA || payload['fixtureHash'] !== fixtureHash ||
    payload['initialStateHash'] !== initialStateHash ||
    digest(envelope['markerHash'], 'initialization marker hash') !== hashCanonicalJson(payload)
  ) throw new TypeError('initialization marker is invalid');
}

function providerFiles(directory: FileHandle): ProviderStateFiles {
  const base = `/proc/self/fd/${directory.fd}`;
  return {
    state: join(base, 'state.json'),
    anchor: join(base, 'anchor.json'),
    pending: join(base, 'pending.json'),
  };
}

async function initializeOrValidateState(input: Readonly<{
  files: ProviderStateFiles;
  directory: FileHandle;
  fixtureHash: string;
  tasks: readonly OwnedFixtureTask[];
  actor: ReviewActorV1;
  inspectSource: OpenM7L2ReviewProviderOptions['inspectSource'];
  markerExists: boolean;
}>): Promise<StateSnapshot> {
  const initial = initialState(input.fixtureHash, input.tasks);
  const initialHash = hashCanonicalJson(initial);
  const stateExists = await pathExists(input.files.state);
  const anchorExists = await pathExists(input.files.anchor);
  if (!stateExists && !anchorExists) {
    if (input.markerExists) throw new TypeError('initialized provider state was deleted');
    await writeExclusive(input.files.anchor, anchorBytes({
      schema: ANCHOR_SCHEMA,
      fixtureHash: input.fixtureHash,
      sequence: 0,
      stateHash: initialHash,
    }), input.directory);
    await writeExclusive(input.files.state, stateBytes(initial), input.directory);
  } else if (!stateExists && anchorExists) {
    const anchor = parseAnchor(
      await readNoFollow(input.files.anchor, 64 * 1024, 'state anchor'),
      input.fixtureHash,
    );
    if (
      input.markerExists || anchor.sequence !== 0 || anchor.stateHash !== initialHash ||
      await pathExists(input.files.pending)
    ) throw new TypeError('durable provider state is missing');
    await writeExclusive(input.files.state, stateBytes(initial), input.directory);
  } else if (stateExists && !anchorExists) {
    throw new TypeError('durable state anchor is missing');
  }
  return loadConsistentState({
    files: input.files,
    directory: input.directory,
    seedTasks: input.tasks,
    fixtureHash: input.fixtureHash,
    trustedActor: input.actor,
    inspectSource: input.inspectSource,
  });
}

export async function openM7L2ReviewProvider(
  options: OpenM7L2ReviewProviderOptions,
): Promise<M7L2ReviewProvider | null> {
  if (
    options.env['HERCULES_ADAPTER'] !== 'fake' ||
    options.env['HERCULES_FAKE_FAULT_INJECTION'] !== '1' ||
    options.env['HERCULES_L2_ISOLATED'] !== '1'
  ) return null;
  const guarded = await guardedFixtureBytes(options.workRoot, options.fixturePath);
  const fixture = parseFixture(guarded.bytes, options.inspectSource);
  const stateRoot = join(guarded.root, '.hercules-m7-review-state');
  const workRootHandle = await open(
    guarded.root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const stateRootViaWork = `/proc/self/fd/${workRootHandle.fd}/.hercules-m7-review-state`;
  let stateRootHandle: FileHandle;
  try {
    await ensureOwnerOnlyDirectory(stateRootViaWork, stateRoot);
    stateRootHandle = await open(
      stateRootViaWork,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    await workRootHandle.close();
    throw error;
  }
  let stateDirectory: FileHandle | null = null;
  try {
    const workRootInfo = await workRootHandle.stat();
    const publishedWorkRoot = await lstat(guarded.root);
    const stateRootInfo = await stateRootHandle.stat();
    const publishedStateRoot = await lstat(stateRoot);
    if (
      workRootInfo.dev !== publishedWorkRoot.dev || workRootInfo.ino !== publishedWorkRoot.ino ||
      stateRootInfo.dev !== publishedStateRoot.dev || stateRootInfo.ino !== publishedStateRoot.ino ||
      publishedWorkRoot.isSymbolicLink() || publishedStateRoot.isSymbolicLink() ||
      await realpath(`/proc/self/fd/${stateRootHandle.fd}`) !== stateRoot
    ) throw new TypeError('provider state root descriptor is invalid');
    const hashName = fixture.fixtureHash.slice('sha256:'.length);
    const stateRootDescriptor = `/proc/self/fd/${stateRootHandle.fd}`;
    const markerPath = join(stateRootDescriptor, `${hashName}.initialized.json`);
    const stateDirectoryPath = join(stateRoot, hashName);
    const stateDirectoryDescriptor = join(stateRootDescriptor, hashName);
    const lock = await openArchiveLockManager(join(stateRoot, `.${hashName}.lock`));
    const lease = await acquireLock(lock);
    try {
      const markerExists = await pathExists(markerPath);
      const directoryExists = await pathExists(stateDirectoryDescriptor);
      if (markerExists && !directoryExists) {
        throw new TypeError('initialized provider state directory was deleted');
      }
      if (!directoryExists) await mkdir(stateDirectoryDescriptor, { mode: 0o700 });
      stateDirectory = await open(
        stateDirectoryDescriptor,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const directoryInfo = await stateDirectory.stat();
      const publishedInfo = await lstat(stateDirectoryPath);
      const currentUid = process.getuid?.();
      if (
        !directoryInfo.isDirectory() || publishedInfo.isSymbolicLink() ||
        directoryInfo.dev !== publishedInfo.dev || directoryInfo.ino !== publishedInfo.ino ||
        (directoryInfo.mode & 0o777) !== 0o700 ||
        (currentUid !== undefined && directoryInfo.uid !== currentUid) ||
        await realpath(`/proc/self/fd/${stateDirectory.fd}`) !== stateDirectoryPath
      ) throw new TypeError('provider state directory descriptor is invalid');
      const files = providerFiles(stateDirectory);
      const initialHash = hashCanonicalJson(initialState(fixture.fixtureHash, fixture.tasks));
      if (markerExists) {
        parseInitialized(
          await readNoFollow(markerPath, 64 * 1024, 'initialization marker'),
          fixture.fixtureHash,
          initialHash,
        );
      }
      await initializeOrValidateState({
        files,
        directory: stateDirectory,
        fixtureHash: fixture.fixtureHash,
        tasks: fixture.tasks,
        actor: fixture.actor,
        inspectSource: options.inspectSource,
        markerExists,
      });
      if (!markerExists) {
        await writeExclusive(
          markerPath,
          initializedBytes(fixture.fixtureHash, initialHash),
          stateRootHandle,
        );
      }
      await lock.assertOwns(lease);
      const provider = new M7L2ReviewProvider({
        fixtureHash: fixture.fixtureHash,
        tasks: fixture.tasks,
        actor: fixture.actor,
        inspectSource: options.inspectSource,
        files,
        stateDirectory,
        publishedStateDirectory: stateDirectoryPath,
        stateDirectoryIdentity: {
          dev: directoryInfo.dev,
          ino: directoryInfo.ino,
          uid: directoryInfo.uid,
        },
        lock,
        now: options.now ?? (() => new Date().toISOString()),
        ...(options.fault === undefined ? {} : { fault: options.fault }),
      });
      stateDirectory = null;
      return provider;
    } finally {
      await lease.release();
    }
  } finally {
    if (stateDirectory !== null) await stateDirectory.close();
    await stateRootHandle.close();
    await workRootHandle.close();
  }
}
