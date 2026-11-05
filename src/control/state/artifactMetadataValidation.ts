import { canonicalClone, hashCanonicalJson } from '../../domain/canonicalJson.js';
import {
  ARTIFACT_REDACTION_STATES,
  ARTIFACT_TRUST_CLASSES,
  type CandidateRef,
} from '../../domain/artifact.js';
import { assertControlEventMetadata } from '../../domain/controlEvent.js';
import {
  StateStoreError,
} from './stateStore.js';
import type {
  ArchivedArtifactMetadata,
  ArchivedEvidenceMetadataManifest,
  ArtifactArchiveLineage,
  ArtifactCaptureAuthorizationRecord,
  ArtifactMetadataRetirement,
  IssueCaptureAuthorizationCommand,
  RecordArtifactMetadataCommand,
  RecordEvidenceManifestMetadataCommand,
  RetireArtifactMetadataCommand,
} from './artifactMetadataStore.js';

export const ARTIFACT_SHA256_RE = /^sha256:[0-9a-f]{64}$/;
export const ARTIFACT_GIT_REVISION_RE = /^[0-9a-f]{40}$/;
const MEDIA_ESSENCE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const MEDIA_PARAMETER_RE = /^ [a-z0-9][a-z0-9!#$&^_.+-]{0,63}=(?:[a-z0-9!#$&^_.+-]+|"[ -~]*")$/;
const STORAGE_KEY_RE = /^sha256\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64})$/;
const MAX_TEXT_BYTES = 512;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_ARRAY_ITEMS = 4_096;

function fail(message: string): never {
  throw new StateStoreError('invalid_input', message);
}

function readExactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be a plain object`);
  let prototype: object | null;
  let actual: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    actual = Reflect.ownKeys(value);
  } catch {
    fail(`${label} schema cannot be inspected`);
  }
  if ((prototype !== Object.prototype && prototype !== null) || actual.length !== keys.length ||
      actual.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    fail(`${label} must use the exact schema`);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(`${label}.${key} cannot be inspected`);
    }
    if (descriptor === undefined || !('value' in descriptor)) fail(`${label}.${key} must be an own data property`);
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function readDenseArray(value: unknown, label: string, maximum = MAX_ARRAY_ITEMS): readonly unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be a bounded dense array`);
  let keys: readonly PropertyKey[];
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    keys = Reflect.ownKeys(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  } catch {
    fail(`${label} cannot be inspected`);
  }
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) || Number(lengthDescriptor.value) < 0 ||
      Number(lengthDescriptor.value) > maximum) {
    fail(`${label} must be a bounded dense array`);
  }
  const length = Number(lengthDescriptor.value);
  if (keys.length !== length + 1 || !keys.includes('length') || keys.some((key) =>
    key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) {
    fail(`${label} must be an exact dense array`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      fail(`${label}[${index}] cannot be inspected`);
    }
    if (descriptor === undefined || !('value' in descriptor)) fail(`${label} must contain own data properties`);
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function snapshotOwnJson(value: unknown, label: string, depth = 0): unknown {
  if (depth > 32) fail(`${label} nesting is too deep`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))) return value;
  if (Array.isArray(value)) {
    const items = readDenseArray(value, label);
    return Object.freeze(items.map((item, index) => snapshotOwnJson(item, `${label}[${index}]`, depth + 1)));
  }
  if (value === null || typeof value !== 'object') fail(`${label} is not canonical JSON data`);
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail(`${label} cannot be inspected`);
  }
  if ((prototype !== Object.prototype && prototype !== null) || keys.length > MAX_ARRAY_ITEMS ||
      keys.some((key) => typeof key !== 'string')) fail(`${label} must be a bounded plain object`);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string') fail(`${label} contains a symbol property`);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(`${label}.${key} cannot be inspected`);
    }
    if (descriptor === undefined || !('value' in descriptor)) fail(`${label}.${key} must be an own data property`);
    result[key] = snapshotOwnJson(descriptor.value, `${label}.${key}`, depth + 1);
  }
  return Object.freeze(result);
}

export function artifactMetadataBoundedText(value: unknown, label: string): asserts value is string {
  const hasControlCharacter = typeof value === 'string' && [...value].some((character) => {
    const point = character.codePointAt(0)!;
    return point <= 0x1f || point === 0x7f;
  });
  if (typeof value !== 'string' || value.length === 0 ||
      Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES || hasControlCharacter) {
    fail(`${label} must be bounded, non-empty, and control-character-free`);
  }
}

export function canonicalArtifactTimestamp(value: unknown, label: string): asserts value is string {
  artifactMetadataBoundedText(value, label);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    fail(`${label} must be a canonical UTC timestamp`);
  }
}

export function validateArtifactCandidate(value: unknown, label = 'candidate'): CandidateRef {
  const kindRecord = readExactRecord(value, (() => {
    if (value === null || typeof value !== 'object') return [];
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, 'kind');
    } catch {
      fail(`${label}.kind cannot be inspected`);
    }
    switch (descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined) {
      case 'git': return ['kind', 'repository', 'revision'];
      case 'artifact': return ['kind', 'artifactId', 'sha256'];
      case 'external': return ['kind', 'system', 'version', 'digest'];
      default: return [];
    }
  })(), label);
  if (typeof kindRecord['kind'] !== 'string') fail(`${label} is invalid`);
  switch (kindRecord['kind']) {
    case 'git':
      artifactMetadataBoundedText(kindRecord['repository'], `${label} repository`);
      if (typeof kindRecord['revision'] !== 'string' || !ARTIFACT_GIT_REVISION_RE.test(kindRecord['revision'])) {
        fail(`${label} revision must be an exact Git SHA`);
      }
      break;
    case 'artifact':
      artifactMetadataBoundedText(kindRecord['artifactId'], `${label} artifact id`);
      if (typeof kindRecord['sha256'] !== 'string' || !ARTIFACT_SHA256_RE.test(kindRecord['sha256'])) {
        fail(`${label} digest is invalid`);
      }
      break;
    case 'external':
      artifactMetadataBoundedText(kindRecord['system'], `${label} system`);
      artifactMetadataBoundedText(kindRecord['version'], `${label} version`);
      if (typeof kindRecord['digest'] !== 'string' || !ARTIFACT_SHA256_RE.test(kindRecord['digest'])) {
        fail(`${label} digest is invalid`);
      }
      break;
    default:
      fail(`${label} kind is invalid`);
  }
  return canonicalClone(kindRecord as unknown as CandidateRef);
}

function validateMediaType(value: unknown): asserts value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 256) fail('media type is invalid');
  const segments = value.split(';');
  if (segments[0] === undefined || !MEDIA_ESSENCE_RE.test(segments[0])) fail('media type is invalid');
  const names = new Set<string>();
  for (const parameter of segments.slice(1)) {
    if (!MEDIA_PARAMETER_RE.test(parameter)) fail('media type parameter is invalid');
    const name = parameter.slice(1, parameter.indexOf('='));
    if (names.has(name)) fail('media type parameters must be unique');
    names.add(name);
  }
}

export function assertArtifactCaptureAuthorization(
  value: unknown,
): asserts value is ArtifactCaptureAuthorizationRecord {
  const record = readExactRecord(value, [
    'id', 'artifactRefId', 'taskId', 'contractVersion', 'iterationId', 'producerStageRunId',
    'candidateRef', 'mediaType', 'maximumByteLength', 'environmentRef', 'surface',
    'maximumTrustClass', 'accessClass', 'issuer', 'issuedAt', 'expiresAt',
  ], 'capture authorization');
  for (const [field, label] of [
    ['id', 'authorization id'], ['artifactRefId', 'artifact ref id'], ['taskId', 'task id'],
    ['iterationId', 'iteration id'], ['producerStageRunId', 'producer stage run id'],
    ['environmentRef', 'environment ref'], ['surface', 'surface'], ['issuer', 'issuer'],
  ] as const) artifactMetadataBoundedText(record[field], label);
  if (!Number.isSafeInteger(record['contractVersion']) || Number(record['contractVersion']) < 1) {
    fail('authorization contract version is invalid');
  }
  validateArtifactCandidate(record['candidateRef']);
  validateMediaType(record['mediaType']);
  if (!Number.isSafeInteger(record['maximumByteLength']) || Number(record['maximumByteLength']) < 0 ||
      Number(record['maximumByteLength']) > MAX_ARTIFACT_BYTES) fail('authorization byte limit is invalid');
  if (!(ARTIFACT_TRUST_CLASSES as readonly unknown[]).includes(record['maximumTrustClass'])) {
    fail('authorization trust ceiling is invalid');
  }
  if (!['operator', 'restricted'].includes(String(record['accessClass']))) {
    fail('authorization access class is invalid');
  }
  canonicalArtifactTimestamp(record['issuedAt'], 'authorization issued time');
  canonicalArtifactTimestamp(record['expiresAt'], 'authorization expiry');
  if (String(record['expiresAt']) <= String(record['issuedAt'])) fail('authorization expiry must follow issuance');
}

export function assertArchivedArtifactMetadata(value: unknown): asserts value is ArchivedArtifactMetadata {
  const record = readExactRecord(value, [
    'id', 'sha256', 'mediaType', 'byteLength', 'storageKey', 'captureAuthorizationId',
    'captureCandidateRef', 'producerStageRunId', 'createdAt', 'observedAt', 'environmentRef',
    'surface', 'trustClass', 'redactionState', 'accessClass',
  ], 'artifact metadata');
  for (const [field, label] of [
    ['id', 'artifact id'], ['captureAuthorizationId', 'capture authorization id'],
    ['producerStageRunId', 'producer stage run id'], ['environmentRef', 'environment ref'],
    ['surface', 'surface'],
  ] as const) artifactMetadataBoundedText(record[field], label);
  if (typeof record['sha256'] !== 'string' || !ARTIFACT_SHA256_RE.test(record['sha256'])) {
    fail('artifact digest is invalid');
  }
  validateMediaType(record['mediaType']);
  if (!Number.isSafeInteger(record['byteLength']) || Number(record['byteLength']) < 0 ||
      Number(record['byteLength']) > MAX_ARTIFACT_BYTES) fail('artifact byte length is invalid');
  if (typeof record['storageKey'] !== 'string') fail('artifact storage key is invalid');
  const match = STORAGE_KEY_RE.exec(record['storageKey']);
  const hex = String(record['sha256']).slice('sha256:'.length);
  if (match === null || match[1] !== hex.slice(0, 2) || match[2] !== hex.slice(2, 4) || match[3] !== hex) {
    fail('artifact storage key does not match its digest');
  }
  validateArtifactCandidate(record['captureCandidateRef'], 'capture candidate');
  canonicalArtifactTimestamp(record['createdAt'], 'artifact creation time');
  canonicalArtifactTimestamp(record['observedAt'], 'artifact observation time');
  if (!(ARTIFACT_TRUST_CLASSES as readonly unknown[]).includes(record['trustClass'])) {
    fail('artifact trust class is invalid');
  }
  if (!(ARTIFACT_REDACTION_STATES as readonly unknown[]).includes(record['redactionState'])) {
    fail('artifact redaction state is invalid');
  }
  if (!['operator', 'restricted'].includes(String(record['accessClass'])) ||
      (record['redactionState'] === 'restricted' && record['accessClass'] !== 'restricted')) {
    fail('artifact access class is invalid');
  }
}

export function evidenceManifestHashBody(manifest: ArchivedEvidenceMetadataManifest): unknown {
  return {
    schema: manifest.schema,
    id: manifest.id,
    taskId: manifest.taskId,
    contractVersion: manifest.contractVersion,
    iterationId: manifest.iterationId,
    candidateRef: manifest.candidateRef,
    entries: manifest.entries,
    createdAt: manifest.createdAt,
  };
}

export function assertArchivedEvidenceMetadataManifest(
  value: unknown,
): asserts value is ArchivedEvidenceMetadataManifest {
  const record = readExactRecord(value, [
    'schema', 'id', 'taskId', 'contractVersion', 'iterationId', 'candidateRef', 'entries',
    'manifestHash', 'createdAt',
  ], 'evidence manifest');
  if (record['schema'] !== 'hercules-evidence-manifest/v1') {
    fail('evidence manifest must use the exact schema');
  }
  for (const [field, label] of [
    ['id', 'manifest id'], ['taskId', 'manifest task id'], ['iterationId', 'manifest iteration id'],
  ] as const) artifactMetadataBoundedText(record[field], label);
  if (!Number.isSafeInteger(record['contractVersion']) || Number(record['contractVersion']) < 1) {
    fail('manifest contract version is invalid');
  }
  validateArtifactCandidate(record['candidateRef'], 'manifest candidate');
  canonicalArtifactTimestamp(record['createdAt'], 'manifest creation time');
  const entries = readDenseArray(record['entries'], 'manifest entries');
  if (entries.length === 0) {
    fail('manifest entries are invalid');
  }
  let priorArtifact = '';
  let totalCriteria = 0;
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = readExactRecord(entries[entryIndex], [
      'artifactRefId', 'criterionIds', 'candidateRef', 'observedAt', 'environmentRef', 'surface',
      'trustClass', 'redactionState', 'accessClass',
    ], `manifest entry ${entryIndex}`);
    artifactMetadataBoundedText(entry['artifactRefId'], 'entry artifact id');
    if (entry['artifactRefId'] <= priorArtifact) fail('manifest artifact refs must be unique and sorted');
    priorArtifact = entry['artifactRefId'];
    const criterionIds = readDenseArray(entry['criterionIds'], 'entry criteria');
    if (criterionIds.length === 0 || criterionIds.some((id) => typeof id !== 'string')) {
      fail('entry criteria are invalid');
    }
    totalCriteria += criterionIds.length;
    if (totalCriteria > MAX_ARRAY_ITEMS) fail('manifest total criteria exceed the bounded limit');
    let priorCriterion = '';
    for (let criterionIndex = 0; criterionIndex < criterionIds.length; criterionIndex += 1) {
      const id = criterionIds[criterionIndex] as string;
      artifactMetadataBoundedText(id, 'criterion id');
      if (id <= priorCriterion) fail('entry criteria must be unique and sorted');
      priorCriterion = id;
    }
    validateArtifactCandidate(entry['candidateRef'], 'entry candidate');
    canonicalArtifactTimestamp(entry['observedAt'], 'entry observation time');
    artifactMetadataBoundedText(entry['environmentRef'], 'entry environment ref');
    artifactMetadataBoundedText(entry['surface'], 'entry surface');
    if (!(ARTIFACT_TRUST_CLASSES as readonly unknown[]).includes(entry['trustClass']) ||
        !(ARTIFACT_REDACTION_STATES as readonly unknown[]).includes(entry['redactionState']) ||
        !['operator', 'restricted'].includes(String(entry['accessClass']))) {
      fail('entry trust, redaction, or access class is invalid');
    }
  }
  if (typeof record['manifestHash'] !== 'string' || !ARTIFACT_SHA256_RE.test(record['manifestHash']) ||
      record['manifestHash'] !== hashCanonicalJson(evidenceManifestHashBody(record as unknown as ArchivedEvidenceMetadataManifest))) {
    fail('manifest hash does not match the exact canonical body');
  }
}

export function assertArtifactMetadataRetirement(value: unknown): asserts value is ArtifactMetadataRetirement {
  const record = readExactRecord(value, [
    'id', 'artifactRefId', 'reason', 'policyCutoff', 'retiredAt',
  ], 'artifact retirement');
  artifactMetadataBoundedText(record['id'], 'retirement id');
  artifactMetadataBoundedText(record['artifactRefId'], 'retirement artifact id');
  artifactMetadataBoundedText(record['reason'], 'retirement reason');
  canonicalArtifactTimestamp(record['policyCutoff'], 'retirement policy cutoff');
  canonicalArtifactTimestamp(record['retiredAt'], 'retirement time');
  if (String(record['policyCutoff']) > String(record['retiredAt'])) fail('retirement cutoff cannot follow retirement');
}

function validateBase(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const record = readExactRecord(value, keys, 'artifact metadata command');
  artifactMetadataBoundedText(record['idempotencyKey'], 'idempotency key');
  const event = readExactRecord(record['event'], ['eventId', 'actor', 'occurredAt'], 'artifact command event');
  const actor = readExactRecord(event['actor'], ['kind', 'id'], 'artifact command actor');
  const eventSnapshot = canonicalClone({
    eventId: event['eventId'],
    actor: { kind: actor['kind'], id: actor['id'] },
    occurredAt: event['occurredAt'],
  });
  assertControlEventMetadata(eventSnapshot);
  const snapshot = Object.freeze({ ...record, event: eventSnapshot });
  return snapshot;
}

export function validateArtifactArchiveLineage(value: unknown): ArtifactArchiveLineage {
  const record = readExactRecord(value, [
    'databaseLineageId', 'artifactRoot', 'rootDevice', 'rootInode',
  ], 'archive lineage');
  artifactMetadataBoundedText(record['databaseLineageId'], 'database lineage id');
  artifactMetadataBoundedText(record['artifactRoot'], 'artifact root');
  for (const field of ['rootDevice', 'rootInode'] as const) {
    if (!Number.isSafeInteger(record[field]) || Number(record[field]) < 0) fail(`archive ${field} is invalid`);
  }
  return canonicalClone(record as unknown as ArtifactArchiveLineage);
}

export function validateIssueCaptureAuthorizationCommand(value: unknown): IssueCaptureAuthorizationCommand {
  const record = validateBase(value, ['idempotencyKey', 'event', 'authorization']);
  assertArtifactCaptureAuthorization(record['authorization']);
  return canonicalClone(snapshotOwnJson(record, 'capture authorization command') as IssueCaptureAuthorizationCommand);
}

export function validateRecordArtifactMetadataCommand(value: unknown): RecordArtifactMetadataCommand {
  const record = validateBase(value, ['idempotencyKey', 'event', 'artifact']);
  assertArchivedArtifactMetadata(record['artifact']);
  return canonicalClone(snapshotOwnJson(record, 'record artifact command') as RecordArtifactMetadataCommand);
}

export function validateRecordEvidenceManifestMetadataCommand(
  value: unknown,
): RecordEvidenceManifestMetadataCommand {
  const record = validateBase(value, ['idempotencyKey', 'event', 'manifest']);
  assertArchivedEvidenceMetadataManifest(record['manifest']);
  return canonicalClone(snapshotOwnJson(record, 'record manifest command') as RecordEvidenceManifestMetadataCommand);
}

export function validateRetireArtifactMetadataCommand(value: unknown): RetireArtifactMetadataCommand {
  const record = validateBase(value, ['idempotencyKey', 'event', 'retirement']);
  assertArtifactMetadataRetirement(record['retirement']);
  return canonicalClone(snapshotOwnJson(record, 'retire artifact command') as RetireArtifactMetadataCommand);
}

export function artifactMetadataCommandDigest(value: unknown): string {
  return hashCanonicalJson(value);
}

export function trustClassRank(value: string): number {
  return value === 'primary' ? 3 : value === 'derived' ? 2 : value === 'agent_claim' ? 1 : 0;
}
